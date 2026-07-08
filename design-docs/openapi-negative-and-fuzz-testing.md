# OpenAPI Loader: Automated Negative & Fuzzy Testing

> **Status (2026-07-08): Phases 1–2 greenlit** (negative testing seeded from existing examples, body + parameters), including two additions surfaced by code review: the resolve-once refactor and the synthetic-key exclusion from link resolution (both folded into Phase 1 below). Phase 3 (the synthesizer) remains the go/no-go decision point; Phases 4–5 are not approved yet.

## Summary

`openapi-loader-v2-first-class-support.md` (implemented, see `src/plugins/openapi-loader.ts`) closed the gap for negative testing that is *hand-authored in the spec*: an operation with a `register` request body documenting 20 `examples` (one per invalid field, each paired with a `400` response example) now generates 20 distinct tests with zero extra Spectest code. That is still fundamentally an **example-based** mechanism — a human has to think of each invalid case and write it into the OpenAPI document.

This doc analyzes what it would take to go one level further: **derive** negative and fuzzy test cases directly from JSON Schema constraints (`required`, `type`, `minLength`, `enum`, `format`, ...) with no per-case authoring, and optionally exercise the API with randomized/boundary data beyond the single hand-picked example. This is explicitly the thing v1 and v2 both declared out of scope ("no synthetic data without an explicit example" / "full schema-driven synthetic payload generation ... conflicts with v1's no synthetic data principle"). This doc treats that as a deliberate, opt-in exception that needs its own default-off gate and its own safety rails — not a reversal of the existing default.

This doc started as an analysis + effort estimate; after review against the current loader implementation (see the Architecture section's resolve-once and link-resolution findings), Phases 1–2 have been approved for implementation — see Decision at the end.

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

The key insight that keeps this from being a rewrite: v2 already generates one `TestCase` per entry of a request/parameter `examples` map, resolves the response per-key, and merges `x-spectest` per-key. If schema-derived negative/fuzz cases are synthesized as **synthetic entries in that same `examples` map**, then naming (`operationId+key`), `x-spectest` merge, hook/security resolution, and coverage reporting all fall out for free — `chooseResponse` and `collectXSpectestForKey` need no changes.

### Prerequisite refactor: resolve refs once per operation

The naive version of this ("inject into the examples map before `buildOperationEntries` runs, downstream untouched") does not survive `resolveRefs`'s copy semantics: `resolveRefs` (`openapi-loader.ts:107`) deep-copies, and it runs *independently* in both `buildOperationEntries` (`:883`) and `buildTestForExample` (`:752`). There is no shared `examples` object to inject into — mutate the resolved copy in one place and the other never sees it; mutate the raw doc instead and synthetic keys leak into every operation that shares a `$ref`'d `components.requestBodies`/`parameters` entry.

So Phase 1 starts with a small refactor: resolve refs **once per operation** in `buildOperationEntries`, store the resolved operation/parameters/body content on `OperationEntry`, and have `buildTestForExample` consume the entry's resolved objects instead of re-resolving. The injection step then targets the per-entry resolved copies, which are private to that operation by construction. This also deletes duplicated resolution work. Consequence: `buildTestForExample` *is* touched (its resolution preamble moves out), so the regression bar is "byte-identical loader output with the features disabled," not "file untouched."

### Injection step

A new step between `buildOperationEntries` and the per-key generation loop in `loadOpenApiSuite` (`:903`) that, when negative/fuzz testing is enabled for an operation, injects synthetic keys (e.g. `__negative-email-missing`, `__negative-age-below-minimum`, `__fuzz-name-boundary-max`) into the entry's resolved `bodyJsonContent.examples`/parameter `examples` maps that `collectExampleKeys` already reads. (Separator is `-`, not `:` — keys become part of the generated `operationId`, so the charset must stay friendly to `--filter`/`--tags`/reporting; verify before locking the prefix format.)

Mutation seeding is pinned: when an operation has multiple hand-written example keys, the mutator seeds from the **first** key (spec order), overridable via `x-spectest.negative.seedExample`. One mutation set per operation, not per existing example — per-example multiplication adds count without coverage. Fields whose seed value contains a `{{uuid}}`/`{{timestamp}}`/`{{shortId}}` placeholder are skipped by the mutator (length/pattern-mutating an unresolved placeholder string is meaningless).

**Self-check with Ajv (load-bearing, not optional):** Ajv is already a dependency (response validation in `cli.ts`). At generation time, every mutated payload is asserted to actually *fail* the request schema and every synthesized payload (Phase 3) to *pass* it; anything that doesn't is discarded as a skip-with-reason. This kills the "mutator thought this violates, but the effective schema after `allOf` merge is looser" false-positive class, and in Phase 3 it enables generate-and-validate instead of trying to invert regex patterns.

### Link resolution must exclude synthetic keys

`resolveLinkCandidatesForParams` (`:693`) only wires a `links`-derived dependency when the source operation resolves to exactly one generated test (`generatedIds.length !== 1` → silently no link). An operation that today generates one test and serves as a link source would become multi-test the moment synthetic keys are injected, and every dependent would quietly lose its auto-derived `dependsOn`/`beforeSend` — typically degrading to `missing required request body example` skips. Therefore: synthetic keys are **excluded** from `generatedIdsForEntry`/`operationIdToGeneratedIds`, so link targets always resolve to the non-synthetic test. This is the reverse direction of the "Stateful chains" risk below (which is about not mutating chain participants) and it fails silently if missed — it gets its own regression test.

Two new pure modules, no changes to existing exported behavior when disabled:

- `src/plugins/openapi-schema-mutator.ts` — walks a resolved JSON Schema (object properties one level deep by default; deeper opt-in via a path allowlist to bound combinatorics) and, given a valid seed value, yields `{ key, value, violatedConstraint }` tuples: one per constraint violation (missing required, wrong type, `minLength - 1`, `maxLength + 1`, out-of-range number, invalid `enum` member, pattern violation, unknown `format`, extra property when `additionalProperties: false`, array `minItems`/`maxItems` violation). Reused by negative testing (Phase 1–2) directly, and by boundary fuzzing (Phase 4) for the "just inside/outside the boundary" cases.
- `src/plugins/openapi-schema-synth.ts` — given a resolved JSON Schema with no usable example, synthesizes one valid value (respecting `type`/`format`/`minimum`/`maximum`/`minLength`/`maxLength`/`enum`/`pattern` where the pattern is simple enough to invert; falls back to skipping the field/operation when it can't produce a value that would honestly validate, same "skip with a reason" contract the loader already uses for everything else). Needed so operations *without* a hand-written example can still get negative/fuzz coverage, and as the base generator for randomized property fuzzing.

Both modules produce plain data (no network, no OpenAPI-loader coupling), so they're unit-testable in isolation the same way `test/openapi-loader.test.ts` already tests the pure `resolveGeneratorPlaceholders`-style helpers.

### Expected-status resolution — entirely in-band

Resolution order for a synthetic negative case: `x-spectest.negative.status` (if the author pins one) → lowest documented `4xx` response → skip with reason. The mechanism needs **zero downstream changes**: the injector computes the target status and stamps it on the synthetic example entry as `x-spectest: { status: <4xx>, tags: ['negative'] }`. `collectXSpectestForKey` (`:216`) already merges per-key entry `x-spectest`, and `chooseResponse` (`:400`) already throws `OpenApiSkip` when a forced status has no matching response definition — which yields the "skip when no documented error status exists" behavior for free.

Side effect worth knowing: the negative test's response body gets validated against the documented `4xx` response *schema* (when one exists). That's a feature — it verifies the error contract, not just the status — but it makes documented-error-schema quality load-bearing; specs with sloppy error schemas will need the per-operation escape hatch.

## Configuration Surface (proposed, default OFF)

```yaml
# per-operation / per-example, mirrors x-spectest.generate's shape
x-spectest:
  negative:
    enabled: true
    fields: [email, age]      # optional allowlist; default is all top-level required+constrained properties
    status: 400               # optional pin, else lowest documented 4xx
    seedExample: default      # optional; which existing example key seeds the mutator (default: first key in spec order)
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
| 1 | **Resolve-once refactor** (refs resolved once per operation in `buildOperationEntries`, resolved objects carried on `OperationEntry`). **Synthetic-key exclusion from link resolution** (`generatedIdsForEntry`/`operationIdToGeneratedIds`), with regression test. Schema mutator for request **body** only, seeded from an *existing* example (first key / `seedExample`; no synth needed yet), Ajv self-check on every mutated payload. Wire into example-key pipeline. `x-spectest.negative` + global config gate, default off. `negative` tag. | M | 2–3d |
| 2 | Extend mutator to **query parameters and cookies**. Path/header parameter mutations are deferred or loosened (see Risks: transport-level rejection and route-matching ambiguity make their expected status unreliable). Expected-status stamping via in-band `x-spectest` + skip-with-reason when no documented error status exists. Coverage-report awareness (surface negative-generated rows distinctly). | M | 2–3d |
| 3 | Valid-data synthesizer (`openapi-schema-synth.ts`) so operations with **no** hand-written example still get negative coverage, and to serve as the base generator for fuzzing. Handles primitive types/formats/bounds; explicitly skips (with reason) schemas it can't honestly synthesize (complex `oneOf`/`anyOf`/`allOf`, circular refs, unbounded/ambiguous patterns). | M/L | 3–4d |
| 4 | Boundary + randomized property fuzzing using the Phase 3 synthesizer. Seeded PRNG (no new dependency — a small mulberry32-style generator is ~10 lines), `--fuzz-tests` flag, reproducible seed logging. | M | 2–3d |
| 5 (optional, not recommended to start) | Adversarial/robustness fuzzing (injection-shaped payloads, oversized strings, encoding edge cases), explicit separate opt-in + safety gating. | L | 3–5d, open-ended |

**Approved scope: Phases 1–2, ~4–6 engineer-days.** Phases 3–4 (~5–7d more) await the Phase 3 go/no-go; Phase 5 is called out but not recommended — see Risks.

Sequencing rationale: Phase 1 alone (mutate-from-existing-example, body only) delivers the highest value-to-effort ratio and needs no new "synthesize a valid value from nothing" logic, which is the riskiest/most speculative part of this whole proposal. Phases 2–4 build outward from there. Building the synthesizer (Phase 3) before attempting it standalone is deliberately deferred until the mutator (the simpler, higher-confidence piece) is proven. The resolve-once refactor and link-resolution exclusion live in Phase 1 deliberately: both are small, but discovering them mid-implementation would be disruptive, and the link one fails silently.

## Risks / Open Questions

- **Reopens a stated non-goal.** Both v1 and v2 explicitly ruled out schema-driven synthetic payloads. This doc treats that as revisitable *only* behind an explicit, default-off opt-in — worth a deliberate go/no-go rather than assuming the earlier decision was wrong.
- **Combinatorial growth.** One test per constraint per field per operation multiplies test count quickly on wide schemas; `maxCasesPerOperation`/field allowlists are load-bearing, not cosmetic, and CI time budget should be checked against a real spec (e.g. `ngdomain-server`'s) before enabling broadly.
- **False positives from permissive servers.** A server that ignores unknown properties, coerces types, or documents `400` loosely will make schema-derived negative tests flaky or simply wrong (asserting an error the server was never contracted to return). Needs a per-field/per-operation override (`x-spectest.negative.enabled: false` or a `fields` denylist) as a first-class, expected-to-be-used escape hatch, not an edge case.
- **Ambiguous schema composition.** `oneOf`/`anyOf`/`allOf` make "what's a single-field violation" and "what's a valid seed" genuinely ambiguous; Phase 3's honest answer for these is "skip with a reason," same as the loader already does for unsupported constructs elsewhere — resist the urge to guess.
- **Real side effects.** This is the sharpest risk given the actual `ngdomain-server` use case in this initiative: some operations trigger real Paystack/Stripe charges or other non-idempotent side effects. Auto-generating negative/fuzz variants for those operations by default would be actively dangerous. Recommendation: negative/fuzz generation should refuse to run (skip, loudly) on any operation tagged in a way that indicates real side effects (reuse the existing `real-backend` tag convention from `x-spectest.tags` in the v2 doc's own example) unless explicitly opted in per-operation, never via the global flag alone.
- **Stateful chains.** Mutating a request that's a `dependsOn` link source or target risks breaking a chain that other tests rely on for state (`state.completedCases`). Default to only generating for operations with no `dependsOn` and no incoming `links`, unless explicitly overridden. The *reverse* direction — injected synthetic keys making a link-source operation multi-test and silently disabling link auto-derivation for its dependents — is handled structurally by excluding synthetic keys from link resolution (see Architecture), not by this heuristic.
- **Path/header parameter mutations are transport-ambiguous.** Invalid header characters are rejected by the HTTP client (undici) before the request ever reaches the server, surfacing as test *errors* rather than asserted `4xx`s; a violated path parameter usually changes which route matches, making 404-vs-400 genuinely ambiguous. Phase 2 therefore covers query + cookie parameters; path/header mutations are deferred until there's a design for constraining them to transport-legal values (or asserting "any documented 4xx").
- **Build vs. adopt.** Existing OpenAPI-aware fuzzers (Schemathesis, Dredd + custom hooks) already do parts of Phases 3–5. This doc recommends building the small, purpose-fit version in-repo (consistent with how `{{uuid}}`/`{{shortId}}` were hand-rolled instead of pulling in `faker`) for Phases 1–4, but Phase 5 in particular may be better served by pointing users at a dedicated tool than reinventing it — revisit after Phase 4 ships if there's still real demand.

## Test Plan (for whichever phases are greenlit)

- Unit: mutator produces exactly one violation per constraint kind for a schema exercising `required`, `type`, `minLength`/`maxLength`, `minimum`/`maximum`, `enum`, `pattern`, `format`, `additionalProperties: false`, array `minItems`/`maxItems`.
- Unit: every mutated payload fails Ajv validation against the request schema; a mutation that still validates (e.g. constraint loosened by an `allOf` merge) is discarded as skip-with-reason, not emitted.
- Unit: mutation seeding uses the first example key by default and honors `x-spectest.negative.seedExample`; fields with `{{...}}` generator placeholders in the seed are not mutated.
- Unit: negative case expected-status resolves `x-spectest.negative.status` override → lowest documented `4xx` → skip-with-reason, in that order.
- Regression: an operation that is a `links` source keeps resolving to exactly one generated id after synthetic keys are injected (synthetic keys excluded from `generatedIdsForEntry`), so dependents' auto-derived `dependsOn`/`beforeSend` are unchanged.
- Regression (refactor): resolve-once refactor alone (features disabled) produces loader output byte-identical to pre-refactor v2 behavior.
- Unit: synthesizer produces schema-valid values for primitive types/formats/bounds and explicitly skips (not guesses) unsupported compositions.
- Unit: fuzz generation is deterministic given a seed (same seed ⇒ same generated values across two loads) and the seed is surfaced in output/logs for reproduction.
- Unit: an operation tagged as having real side effects is never auto-included in negative/fuzz generation without an explicit per-operation opt-in.
- Unit: `maxCasesPerOperation`/field allowlist caps are enforced.
- Regression: with both features disabled (the default), loader output is byte-identical to today's v2 behavior.
- Integration: `--negative-tests`/`--fuzz-tests` against a real fixture spec produce the expected count of additional tagged tests, filterable via `--tags`.

## Decision

**Phases 1–2 are greenlit (2026-07-08)** as a self-contained increment — negative testing anchored on existing hand-written examples, body plus query/cookie parameters. It's the highest-value, lowest-risk slice and needs no synthesizer. Phase 1 explicitly includes the resolve-once refactor and the synthetic-key exclusion from link resolution as its first deliverables, gated by the byte-identical-when-disabled regression test.

Phase 3 (the synthesizer) remains the real go/no-go decision point, since it's where effort and "confidently correct" risk both jump; revisit Phases 4–5 based on how Phase 3 lands. Do not start Phase 5 without a separate, explicit decision given the real-side-effect risk called out above.
