# Official Arazzo examples

`*.arazzo.yaml`, `bnpl-*.yaml`, `FAPI-PAR.openapi.yaml`, `oauth.openapi.yaml` and
`pet-coupons.openapi.yaml` are copied unmodified from
[OAI/Arazzo-Specification](https://github.com/OAI/Arazzo-Specification) `examples/1.0.0/`
(branch `main` @ 12aa8bc), licensed under the Apache License 2.0.

`petstore.openapi.yaml` is copied unmodified from
[swagger-api/swagger-petstore](https://github.com/swagger-api/swagger-petstore)
`src/main/resources/openapi.yaml` (@ d57941e), licensed under the Apache License 2.0.
`LoginAndRetrievePets.arazzo.yaml` references it by URL; the tests point that source
at this local copy (via `arazzoSources`) so they run offline.

`test/arazzo-official-examples.test.ts` runs every example through the CLI against
mocks that implement the referenced OpenAPI operations. Some examples contain bugs
(a case-mismatched operationId, parameter names that don't match the OpenAPI
operation, JSONPath conditions that can never match under RFC 9535, an undeclared
step output, a missing `animals.yaml`). The tests assert what Spectest does with the
documents as published, and `../official-corrected/` holds minimally fixed copies
(each change marked `# FIX`) that exercise the full flows.
