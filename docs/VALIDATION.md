# Validation contract

The repository is not considered release-ready only because its unit tests pass. CI also installs the current official `@openai/codex` package on Linux, adds this repository through the official Codex marketplace/plugin manager, and runs a real `codex exec` request through the local Responses gateway against a deterministic chat-only upstream.

The remote E2E must prove all of the following in one flow:

1. current Codex accepts the repository marketplace and plugin manifest;
2. the native plugin is installable through `codex plugin`;
3. the generated custom provider configuration is accepted by current Codex;
4. Codex sends a Responses request to the local gateway;
5. a real 404 from upstream `/v1/responses` is classified as endpoint incompatibility rather than an authentication/model failure;
6. the gateway translates the request to `/v1/chat/completions`;
7. the returned Chat SSE is translated back into Codex-consumable Responses SSE;
8. `codex exec` completes with the deterministic sentinel;
9. per-model protocol detection is cached as `chat`.

This validation intentionally uses no external model key and therefore tests the integration contract deterministically.
