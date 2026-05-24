# Type Issue Cleanup Plan

## Summary

Fix the current TypeScript failures and remove `any` from `src` where a meaningful native or existing project type is available. Keep the change focused on type safety and compiler health; do not enable `strict`, do not add broad new type layers, and do not refactor runtime behavior beyond small validation and narrowing needed for types.

## Key Changes

- Consolidate CLI/runtime config typing around the existing `SpectestConfig` shape without duplicating the full config interface:
  - Export and use `RunningServerMode = 'reuse' | 'fail' | 'kill'`.
  - Replace the duplicate `CliConfig` interface with `type CliConfig = SpectestConfig`.
  - Add a small `ResolvedCliConfig` using `Required<Pick<SpectestConfig, ...>>` only for fields guaranteed after `loadConfig`; do not create a second full config shape.
  - Import `RunningServerMode` where currently referenced but missing.
  - Parse and validate `--running-server` into `RunningServerMode`.
  - Remove `cfg: any` from CLI, server setup, core filter, and console reporter.

- Replace broad request/response/test callback `any` types using native types first:
  - Use `RequestInit`, `HeadersInit`, `Headers`, `Response`, `BodyInit`, `unknown`, and `Record<string, unknown>` before introducing project-specific aliases.
  - For `HttpClient.request`, define the request parameter as `RequestInit & { url: string; data?: unknown; timeout?: number }` or an inline equivalent near the client if reuse is low.
  - Return `{ status: number; data: unknown; headers: Headers }` from `HttpClient.request`; avoid a named response alias unless it is used in multiple files.
  - Type user-authored body/json/schema values as `unknown` or `Record<string, unknown>` where assertions require key lookup.
  - Type `TestResult` with native pieces: `request: RequestInit | Record<string, never>`, `response.headers: Headers | Record<string, never>`, and `response.data: unknown`.

- Fix current compiler errors directly:
  - In `PluginHost`, replace the `Noop | callback` union with a nullable callback field so `loadSuites()` can narrow before reading `.suites`; use an inline callback type unless reuse makes a named alias clearer.
  - In `RateLimiter`, change the interval field to `ReturnType<typeof setInterval>` so `clearInterval` accepts it.
  - In config/server, ensure `RunningServerMode` is both exported and imported wherever referenced.

- Remove remaining source-level `any` with the smallest useful type:
  - In `cli.ts`, introduce a local runtime test-case intersection type only for dependency bookkeeping fields; do not export it unless another module actually consumes it.
  - In `HttpClient`, type request options and response data, use `unknown` in catch blocks, and narrow abort errors.
  - In `server.ts` and `recording-preload.ts`, model recording IPC messages with the smallest local discriminated union needed to access `requestId`, `request`, `response`, and `action`.
  - In `core-loader`, parse JSON/YAML/module exports as `unknown`, then use `Array.isArray`, `typeof`, and a tiny `isRecord` helper before assigning suite fields.
  - In `generate-openapi`, prefer `Record<string, unknown>`/nested `Record` shapes for generated objects; avoid full OpenAPI interfaces unless they are imported or reused elsewhere.

## Test Plan

- Run `npx tsc --noEmit`; it must pass with zero diagnostics.
- Run `npm run build`; it must pass.
- Run `rg "\\bany\\b" src -n`; it should return no matches unless a deliberate exception is documented next to the code.
- Run a quick review pass for unnecessary aliases; replace one-off named types with native or inline types where readability is not harmed.
- Confirm existing staged/non-source changes remain untouched:
  - `package.json`
  - `design-docs/ctrl-c-cancellation-summary.md`
  - `design-docs/expanded-recording-transport-coverage.md`

## Assumptions

- Do not enable `strict` in `tsconfig.json` as part of this cleanup.
- Prefer native TypeScript/DOM/Node types and `unknown` plus narrowing over invented deep schemas for flexible user-authored test data.
- Add new named project types only when they are reused across files or represent stable domain concepts such as config modes or recording IPC messages.
- Keep public behavior compatible; type changes should describe existing runtime behavior, not change it.
- Do not edit unrelated staged docs or package metadata unless a type/build fix explicitly requires it.
