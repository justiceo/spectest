# OpenAPI Loader: Automated Negative & Fuzzy Testing

## Summary

`openapi-loader-v2-first-class-support.md` (implemented, see `src/plugins/openapi-loader.ts`) closed the gap for negative testing that is *hand-authored in the spec*: an operation with a `register` request body documenting 20 `examples` (one per invalid field, each paired with a `400` response example) now generates 20 distinct tests with zero extra Spectest code. That is still fundamentally an **example-based** mechanism — a human has to think of each invalid case and write it into the OpenAPI document.

This doc analyzes what it would take to go one level further: **derive** negative and fuzzy test cases directly from JSON Schema constraints (`required`, `type`, `minLength`, `enum`, `format`, ...) with no per-case authoring, and optionally exercise the API with randomized/boundary data beyond the single hand-picked example. This is explicitly the thing v1 and v2 both declared out of scope ("no synthetic data without an explicit example" / "full schema-driven synthetic payload generation ... conflicts with v1's no synthetic data principle"). This doc treats that as a deliberate, opt-in exception that needs its own default-off gate and its own safety rails — not a reversal of the existing default.

No code changes are proposed or made by this doc. It is an analysis + effort estimate to decide whether/how to proceed.

## Current State (as implemented today)

- **v1** (`openapi-to-spectest-loader-plan.md`): one test per operation, from a single `example`/`default`. No synthetic data, ever.
- **v2** (`openapi-loader-v2-first-class-support.md`, fully implemented):
  - `collectExampleKeys` (`openapi-loader.ts:175`) and `exampleValueForKey` (`:159`) expand every entry in a request/parameter/response `examples` map into its own generated test.
  - `chooseResponse` (`:392`) resolves the expected status per example: `x-spectest.status` → same-keyed non-2xx response example → lowest documented `2xx`.
  - `x-spectest` (`collectXSpectestForKey`, `:207`; `normalizeXSpectest`, `:187`) adds tags/skip/phase/dependsOn/hooks/security/generate, merged operation-level then example-level.
  - `{{uuid}}`/`{{timestamp}}`/`{{shortId}}` generators (`GENERATORS`, `:230`) and `x-spectest.generate` produce **fresh valid values** for collision-avoidance (e.g. a unique domain name per run) — they do not produce invalid values and are not a fuzzing mechanism.
  - `openapiAuth` variants and `links` (`buildTestForExample`, `:737`) cover auth-negative cases and simple chaining, but again only for cases the spec author wrote down.

**The gap**: nothing today inspects a JSON Schema's constraints and asks "what values would violate this?" or "what's the space of valid values I haven't tried?". Every negative case that exists today exists because someone wrote it in the spec's `examples` map.

## Definitions (these get conflated in casual usage — worth being precise since they have different designs and different risk profiles)

1. **Automated negative testing**: start from a known-valid request (an existing example, or a synthesized valid one), mutate **one field at a time** to violate a single schema constraint (drop a required field, send the wrong type, violate `minLength`/`maximum`/`enum`/`pattern`/`format`, add a property when `additionalProperties: false`), and assert the API returns a *documented* error status. This is the direct schema-driven extension of what `x-spectest.status` + non-2xx response examples already do in v2.
2. **Fuzzy / property testing**: generate many **valid-shaped** inputs across the schema's value space (random strings within length bounds, random numbers within min/max, boundary values like `minimum`, `minimum+1`, `maximum-1`, `maximum`, edge-case unicode/empty strings where allowed) to catch bugs the single hand-picked example doesn't exercise. Expected result is still a documented **success** status — this is closer to property-based testing than to "attacking" the API.
3. **Adversarial / robustness fuzzing**: intentionally malformed or oversized payloads (injection-shaped strings, extreme lengths, null bytes, encoding edge cases) to check the server degrades gracefully (never `5xx`) rather than to assert a specific contract. Different goal (robustness, not contract conformance), different risk profile (this project already drives suites with real side effects — Paystack/Stripe calls, log-scraped tokens, per the `ngdomain-server` use case), and arguably better served by point tools (e.g. Schemathesis) than reinvented here.

This doc's recommendation only covers #1 and #2 as first-class Spectest features; #3 is discussed but not recommended as part of this initiative (see Risks).

## Proposed Architecture

The key insight that keeps this from being a rewrite: v2 already generates one `TestCase` per entry of a request/parameter `examples` map, resolves the response per-key, and merges `x-spectest` per-key. If schema-derived negative/fuzz cases are synthesized as **synthetic entries in that same `examples` map, before `buildOperationEntries` runs**, then naming (`operationId+key`), `x-spectest` merge, hook/security resolution, and coverage reporting all fall out for free — no changes needed to `buildTestForExample`, `chooseResponse`, or `collectXSpectestForKey`.

Two new pure modules, no changes to existing exported behavior when disabled:

- `src/plugins/openapi-schema-mutator.ts` — walks a resolved JSON Schema (object properties one level deep by default; deeper opt-in via a path allowlist to bound combinatorics) and, given a valid seed value, yields `{ key, value, violatedConstraint }` tuples: one per constraint violation (missing required, wrong type, `minLength - 1`, `maxLength + 1`, out-of-range number, invalid `enum` member, pattern violation, unknown `format`, extra property when `additionalProperties: false`, array `minItems`/`maxItems` violation). Reused by negative testing (Phase 1–2) directly, and by boundary fuzzing (Phase 4) for the "just inside/outside the boundary" cases.
- `src/plugins/openapi-schema-synth.ts` — given a resolved JSON Schema with no usable example, synthesizes one valid value (respecting `type`/`format`/`minimum`/`maximum`/`minLength`/`maxLength`/`enum`/`pattern` where the pattern is simple enough to invert; falls back to skipping the field/operation when it can't produce a value that would honestly validate, same "skip with a reason" contract the loader already uses for everything else). Needed so operations *without* a hand-written example can still get negative/fuzz coverage, and as the base generator for randomized property fuzzing.

Both modules produce plain data (no network, no OpenAPI-loader coupling), so they're unit-testable in isolation the same way `test/openapi-loader.test.ts` already tests the pure `resolveGeneratorPlaceholders`-style helpers.

Wiring point: a new step between `buildOperationEntries` and the existing per-key generation loop in `loadOpenApiSuite` (`:903`) that, when negative/fuzz testing is enabled for an operation, injects synthetic keys (e.g. `__negative:email:missing`, `__negative:age:below-minimum`, `__fuzz:name:boundary-max`) into the same `bodyJsonContent.examples`/parameter `examples` maps that `collectExampleKeys` already reads. Everything downstream is unchanged.

Expected-status resolution for a synthetic negative case, in order: `x-spectest.status` (if the author pins one) → lowest documented `4xx` response → skip with reason `"no documented error status to assert"`. This mirrors, but slightly reorders, v2's existing 3-step resolution (which prefers a same-keyed non-2xx example — synthetic keys won't have a hand-written response example to match, so that middle step is naturally skipped).

## Configuration Surface (proposed, default OFF)

```yaml
# per-operation / per-example, mirrors x-spectest.generate's shape
x-spectest:
  negative:
    enabled: true
    fields: [email, age]      # optional allowlist; default is all top-level required+constrained properties
    status: 400               # optional pin, else lowest documented 4xx
  fuzz:
    enabled: true
    strategy: boundary        # boundary | random
    count: 5                  # random cases per field, ignored for boundary
    seed: 12345                # reproducibility; auto-generated + logged if omitted
```

```js
// spectest.config.js — global default, overridable per-operation via x-spectest above
export default {
  openapiNegativeTests: { enabled: false, defaultStatus: undefined, maxCasesPerOperation: 20 },
  openapiFuzzTests: { enabled: false, strategy: 'boundary', count: 5, seed: undefined },
};
```

CLI: `--negative-tests` and `--fuzz-tests[=boundary|random]` as quick global opt-ins (consistent with `--happy`/`--randomize`'s boolean-flag style), primarily for local exploration; the config block is the durable/CI-facing switch. Generated tests get an extra tag (`negative` / `fuzz`) alongside `openapi`, so existing `--tags`/`--filter` machinery can include or exclude them without new filtering code.

Both stay **default-disabled**, preserving the existing "no synthetic data unless you opt in" posture — this doc does not propose changing that default, only adding an explicit escape hatch.

## Effort Estimate

Sized as engineer-days assuming familiarity with this codebase (i.e., the estimate assumes whoever builds it already has the context this session does).

| Phase | Scope | Size | Est. |
| --- | --- | --- | --- |
| 1 | Schema mutator for request **body** only, seeded from an *existing* example (no synth needed yet). Wire into example-key pipeline. `x-spectest.negative` + global config gate, default off. `negative` tag. | S | 1–2d |
| 2 | Extend mutator to path/query/header/cookie parameters. Expected-status resolution chain + skip-with-reason when no documented error status exists. Coverage-report awareness (surface negative-generated rows distinctly). | M | 2–3d |
| 3 | Valid-data synthesizer (`openapi-schema-synth.ts`) so operations with **no** hand-written example still get negative coverage, and to serve as the base generator for fuzzing. Handles primitive types/formats/bounds; explicitly skips (with reason) schemas it can't honestly synthesize (complex `oneOf`/`anyOf`/`allOf`, circular refs, unbounded/ambiguous patterns). | M/L | 3–4d |
| 4 | Boundary + randomized property fuzzing using the Phase 3 synthesizer. Seeded PRNG (no new dependency — a small mulberry32-style generator is ~10 lines), `--fuzz-tests` flag, reproducible seed logging. | M | 2–3d |
| 5 (optional, not recommended to start) | Adversarial/robustness fuzzing (injection-shaped payloads, oversized strings, encoding edge cases), explicit separate opt-in + safety gating. | L | 3–5d, open-ended |

**Recommended scope: Phases 1–4, ~9–12 engineer-days.** Phase 5 is called out but not recommended — see Risks.

Sequencing rationale: Phase 1 alone (mutate-from-existing-example, body only) delivers the highest value-to-effort ratio and needs no new "synthesize a valid value from nothing" logic, which is the riskiest/most speculative part of this whole proposal. Phases 2–4 build outward from there. Building the synthesizer (Phase 3) before attempting it standalone is deliberately deferred until the mutator (the simpler, higher-confidence piece) is proven.

## Risks / Open Questions

- **Reopens a stated non-goal.** Both v1 and v2 explicitly ruled out schema-driven synthetic payloads. This doc treats that as revisitable *only* behind an explicit, default-off opt-in — worth a deliberate go/no-go rather than assuming the earlier decision was wrong.
- **Combinatorial growth.** One test per constraint per field per operation multiplies test count quickly on wide schemas; `maxCasesPerOperation`/field allowlists are load-bearing, not cosmetic, and CI time budget should be checked against a real spec (e.g. `ngdomain-server`'s) before enabling broadly.
- **False positives from permissive servers.** A server that ignores unknown properties, coerces types, or documents `400` loosely will make schema-derived negative tests flaky or simply wrong (asserting an error the server was never contracted to return). Needs a per-field/per-operation override (`x-spectest.negative.enabled: false` or a `fields` denylist) as a first-class, expected-to-be-used escape hatch, not an edge case.
- **Ambiguous schema composition.** `oneOf`/`anyOf`/`allOf` make "what's a single-field violation" and "what's a valid seed" genuinely ambiguous; Phase 3's honest answer for these is "skip with a reason," same as the loader already does for unsupported constructs elsewhere — resist the urge to guess.
- **Real side effects.** This is the sharpest risk given the actual `ngdomain-server` use case in this initiative: some operations trigger real Paystack/Stripe charges or other non-idempotent side effects. Auto-generating negative/fuzz variants for those operations by default would be actively dangerous. Recommendation: negative/fuzz generation should refuse to run (skip, loudly) on any operation tagged in a way that indicates real side effects (reuse the existing `real-backend` tag convention from `x-spectest.tags` in the v2 doc's own example) unless explicitly opted in per-operation, never via the global flag alone.
- **Stateful chains.** Mutating a request that's a `dependsOn` link source or target risks breaking a chain that other tests rely on for state (`state.completedCases`). Default to only generating for operations with no `dependsOn` and no incoming `links`, unless explicitly overridden.
- **Build vs. adopt.** Existing OpenAPI-aware fuzzers (Schemathesis, Dredd + custom hooks) already do parts of Phases 3–5. This doc recommends building the small, purpose-fit version in-repo (consistent with how `{{uuid}}`/`{{shortId}}` were hand-rolled instead of pulling in `faker`) for Phases 1–4, but Phase 5 in particular may be better served by pointing users at a dedicated tool than reinventing it — revisit after Phase 4 ships if there's still real demand.

## Test Plan (for whichever phases are greenlit)

- Unit: mutator produces exactly one violation per constraint kind for a schema exercising `required`, `type`, `minLength`/`maxLength`, `minimum`/`maximum`, `enum`, `pattern`, `format`, `additionalProperties: false`, array `minItems`/`maxItems`.
- Unit: negative case expected-status resolves `x-spectest.status` override → lowest documented `4xx` → skip-with-reason, in that order.
- Unit: synthesizer produces schema-valid values for primitive types/formats/bounds and explicitly skips (not guesses) unsupported compositions.
- Unit: fuzz generation is deterministic given a seed (same seed ⇒ same generated values across two loads) and the seed is surfaced in output/logs for reproduction.
- Unit: an operation tagged as having real side effects is never auto-included in negative/fuzz generation without an explicit per-operation opt-in.
- Unit: `maxCasesPerOperation`/field allowlist caps are enforced.
- Regression: with both features disabled (the default), loader output is byte-identical to today's v2 behavior.
- Integration: `--negative-tests`/`--fuzz-tests` against a real fixture spec produce the expected count of additional tagged tests, filterable via `--tags`.

## Recommendation

Build Phases 1–2 first (negative testing anchored on existing hand-written examples plus parameter coverage) as a self-contained increment — it's the highest-value, lowest-risk slice and needs no synthesizer. Treat Phase 3 (the synthesizer) as the real go/no-go decision point, since it's where effort and "confidently correct" risk both jump; revisit Phases 4–5 based on how Phase 3 lands. Do not start Phase 5 without a separate, explicit decision given the real-side-effect risk called out above.
