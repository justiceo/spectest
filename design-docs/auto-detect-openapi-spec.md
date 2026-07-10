# Auto-Detecting the OpenAPI Spec (Removing `--openapi`)

## Summary

Spectest's OpenAPI support currently requires the user to pass `--openapi <path>` (or set
`openapi` in `spectest.config.js`) every time they want spec-driven tests loaded, generated, or
covered. In the spirit of making OpenAPI first-class rather than opt-in, this doc proposes
dropping the *CLI flag* and having Spectest find the spec itself. Spec filenames are not
constrained by any convention (`openapi.yaml`, `api-v2-final.json`, `contract.yml` are all
equally valid), so detection can't rely on filename matching — it has to look at content.

The OpenAPI 3.0/3.1 format makes this cheap: every valid document has a required top-level
`openapi: "3.x.y"` field (Swagger 2.0 has the equivalent `swagger: "2.0"`), so a document can be
identified with a lightweight text match *before* paying for a full YAML/JSON parse. Only files
that pass this cheap sniff get fully parsed and validated — reusing the exact check
`plugins/openapi-loader.ts` already performs when a spec path is known (`assertOpenApiDocument`,
`:91-104`), so "is this really a supported spec" is defined in exactly one place.

`openapi` stays as a `spectest.config.js` field — an explicit override that always wins over
detection and skips it entirely — because CI reproducibility and multi-spec repos need an escape
hatch from any heuristic.

## Background: what currently requires the flag

- `cli.ts:106-109` — OpenAPI loading is gated entirely behind `if (cfg.openapi)`; suite loading
  (`cli.ts:90-98`) is unconditional and already scans `testDir` for filenames matching
  `cfg.filePattern` (default `\.(suite|spectest)\.`).
- `cli.ts:393-398` — `--coverage-report` hard-requires `cfg.openapi` and exits with an error if
  unset. Unaffected by this change as long as detection still populates `cfg.openapi` when it
  finds something.
- `config.ts:43-49,166-167,294-298,378-379` — `openapi`/`openapi-server` CLI flags, `CliConfig`
  fields, and `path.resolve(projectRoot, cfg.openapi)` normalization.
- `plugins/openapi-loader.ts:84-104` — `parseDocument` (JSON vs. YAML by extension) and
  `assertOpenApiDocument` (throws unless `doc.openapi` matches `/^3\.(0|1)\.\d+/`, throws a
  specific "Swagger/OpenAPI 2.0 is not supported" error for `doc.swagger`/`openapi: 2.x`, and
  requires a `doc.paths` object) are exactly the parse+validate steps detection should reuse
  unmodified once a candidate file passes the cheap sniff.
- `generate-command.ts:81,103-139` — the `generate openapi-tests --openapi <path> --output <dir>`
  subcommand keeps its own explicit `--openapi` flag; out of scope here, since scaffolding is a
  one-off command where the user is choosing what to generate *from*, not what to auto-run.
- A concrete collision exists in-tree today: `test/fixtures/openapi/*.yaml` (six files, e.g.
  `negative-testing.yaml`, `unresolved-ref.yaml`) are real-enough-to-parse OpenAPI documents used
  directly by `openapi-loader.test.ts`, sitting two directories below `testDir`
  (`test/fixtures/openapi/`). Any detection scope that recurses into `testDir` would pick several
  of these up as candidates and break `npm test`'s own dogfood run via the multi-candidate
  ambiguity case below. Scoping detection to non-recursive top-level directories (next section)
  avoids this without any repo-specific exclusion list.

## Design

### 1. Where to look

Non-recursively list two directories: `cfg.projectRoot` and `testDir` (`cfg.testDir`, default
`./test`), deduplicated if they're the same path. No recursion — this is what keeps
`test/fixtures/openapi/**` (and any other nested fixtures/example directory) out of scope for
free, without needing to special-case it. It also bounds the cost to "however many top-level
files exist in two directories," not a full tree walk.

### 2. Cheap sniff before parsing

For every `.yaml`/`.yml`/`.json` file in those two directories, read its raw text and test it
against a single regex before attempting any real parse:

```
/\b(openapi|swagger)\s*:\s*["']?[23]\./
```

This matches YAML (`openapi: 3.0.3`, `openapi: "3.1.0"`) and pretty-printed JSON
(`"openapi": "3.0.3"`) alike, and deliberately also matches `swagger: 2.x` so an unsupported v2
doc is *found* (and reported with the loader's existing clear error) rather than silently
skipped. Files that don't match (e.g. `package.json`, `tsconfig.json`, a `*.spectest.yaml` suite
file, an unrelated YAML config) are rejected with zero parsing cost — this is the "strict format"
shortcut: real spec documents declare their type in a required, narrowly-shaped field, so most
non-spec files can be ruled out with a substring check instead of a full parse.

### 3. Full parse + validate only for sniff hits

Only files that pass the regex get `parseDocument` + `assertOpenApiDocument` run against them
(both already exist, unmodified, in `plugins/openapi-loader.ts`). A sniff hit that fails full
validation (e.g. it matched `swagger: 2.x`, or `openapi: 3.x` but has no `paths`) is a real error,
not a silent skip — the sniff already gives high confidence the file was *meant* to be a spec, so
surfacing `assertOpenApiDocument`'s message is more useful than pretending the file doesn't exist.

### 4. Zero, one, or many validated candidates

- **Zero**: proceed exactly as today when `--openapi` is omitted — no OpenAPI-derived tests, no
  error, no `--coverage-report` support.
- **One**: use it, exactly as if `--openapi <path>` had been passed.
- **More than one**: fail closed. Print all candidate paths and tell the user to set `openapi` in
  `spectest.config.js` to disambiguate, rather than guessing (e.g. by directory priority). Silently
  picking one of two real specs is a worse failure mode than one extra config line.

### 5. Explicit config always wins

If `cfg.openapi` is already set (from `spectest.config.js`), detection doesn't run at all — same
short-circuit as today's `if (cfg.openapi)`.

## Implementation changes

- New function in `cli.ts` (or a small `openapi-detect.ts` if it's easier to unit test in
  isolation), called where `cli.ts:106`'s `if (cfg.openapi)` check currently sits, when
  `cfg.openapi` is falsy:
  - `readdir(dir, { withFileTypes: true })` (non-recursive) on `projectRoot` and `testDir`.
  - Filter to `.yaml`/`.yml`/`.json`, apply the sniff regex to raw file contents.
  - For sniff hits, `readFile` + `parseDocument` + `assertOpenApiDocument`; collect paths that
    pass.
  - Apply the zero/one/many policy above; on a single match, assign it to `cfg.openapi` (resolved
    to an absolute path, matching what `config.ts:378-379` does today for the explicit case) and
    proceed exactly as `cli.ts:106-109` already does.
- `config.ts`: remove the `--openapi <path>` CLI-flag branch (`:294-296`) and its `HELP_OPTIONS`
  row (`:166`). Keep the `openapi?: string` field on `CliConfig` and the
  `path.resolve(projectRoot, cfg.openapi)` normalization (`:378-379`) untouched — that's what lets
  `spectest.config.js` still set it explicitly. `--openapi-server` is unaffected.
- `plugins/openapi-loader.ts`: no changes needed — `parseDocument`/`assertOpenApiDocument` are
  reused as-is, not refactored, since they're only ever called on the (few) sniff-passed
  candidates rather than on every file in the project.
- `cli.ts:393-398` (`--coverage-report` gate): unchanged; it only checks whether `cfg.openapi`
  ended up populated, regardless of how.
- README/help text: rewrite the `--openapi` row/examples to describe content-based auto-detection
  plus the `spectest.config.js` override, matching the existing "When both `--openapi` and
  `testDir` are configured..." paragraph (README:121).

## Tests

- Sniff regex, as a pure unit: matches `openapi: 3.0.3`, `openapi: "3.1.0"`, pretty-printed JSON
  `"openapi": "3.0.3"`, and `swagger: "2.0"`; does not match `package.json`/`tsconfig.json`-shaped
  content or a `*.spectest.yaml` suite file's `tests:`/`name:` shape.
- Zero candidates in `projectRoot`/`testDir` — run proceeds with hand-written suites only, no
  error, `--coverage-report` still errors as it does today.
- Exactly one candidate, arbitrary filename (e.g. `contract.yml`) at `projectRoot` top level, no
  `--openapi`/config — detected and loaded; same for a candidate at `testDir` top level.
- Explicit `openapi` in config alongside an unrelated sniff-matching file present — config value
  wins, detection doesn't run (assert via a spy/no fs calls, or simply that the config path is
  used even when a decoy candidate exists).
- Two valid candidates present — run exits with an error naming both paths, no tests execute.
- A sniff hit that fails full validation (`swagger: "2.0"`, or `openapi: 3.x` with no `paths`) —
  surfaces `assertOpenApiDocument`'s existing error rather than being silently skipped.
- Regression: `test/fixtures/openapi/**` must NOT be picked up when running the real CLI with
  `testDir` at its default (`./test`) — this is the concrete case that would otherwise break
  `npm test`; assert the non-recursive scope holds.

## Open Questions

- **Swagger 2.0 handling**: confirmed in-scope above (sniff regex matches it, `assertOpenApiDocument`
  already produces a clear "not supported" error) — flagging so it's a deliberate choice, not an
  oversight, since v2 detection adds a small amount of "found but rejected" UX to get right (should
  it block the run, or just log and proceed without OpenAPI features?). Recommend: log the error
  and proceed without OpenAPI features, rather than exiting non-zero — a v2-only repo shouldn't be
  unable to run its hand-written suites just because auto-detection tripped over an unsupported doc.
- **Detection scope beyond two directories**: this doc only checks `projectRoot` and `testDir` top
  levels. A spec under `./api/openapi.yaml` or `./docs/contract.json` wouldn't be found and would
  need the explicit config fallback. Could add more conventional directories later if this proves
  to be a common papercut; not included in v1 to keep the scope bounded and easy to state in one
  sentence.
- **Should a "no spec found" run log anything?** Recommend a one-line log at the same verbosity as
  the existing "Found N matching test files" (`cli.ts:99`), e.g.
  `[spectest] no OpenAPI document detected in <projectRoot> or <testDir>` — otherwise a user who
  expected auto-detection to work has no signal about why it didn't.

## Assumptions

- `openapi` remains a valid `spectest.config.js` field; only the CLI flag `--openapi` (and its
  parsing/help text) is removed from the main run path.
- `generate openapi-tests --openapi <path>` is unaffected — that subcommand's flag is out of scope.
- Detection runs once per invocation, at the same point suite files are currently scanned
  (`cli.ts:90-109`), with no caching needed across runs.
- No change to how a spec is *loaded* once found (`openApiLoaderPlugin`/`loadOpenApiSuite`) — this
  doc is scoped entirely to *finding the path*, not to loader behavior.
- Real-world OpenAPI documents declare `openapi:`/`swagger:` somewhere in the raw text regardless
  of key ordering (the regex has no line-start anchor), and minified single-line JSON specs are
  rare enough in practice not to need special-casing beyond what the unanchored regex already
  handles.
