# Arazzo schema test suite

Copied from [OAI/Arazzo-Specification](https://github.com/OAI/Arazzo-Specification)
`tests/schema/{pass,fail}` on branches `v1.0-dev` (@ 4a9a7f9) and `v1.1-dev`
(@ 43c4343), licensed under the Apache License 2.0. `test/arazzo-document.test.ts`
checks that every `pass` document validates and every `fail` document is rejected
by the vendored schemas in `src/arazzo/schemas.ts`.
