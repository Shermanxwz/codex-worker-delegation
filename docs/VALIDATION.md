# Validation contract

The repository is not considered release-ready because unit tests pass. The current `@openai/codex@latest` package must also pass a real Linux integration run.

The remote E2E proves:

1. `codex app-server` accepts the initialize/initialized handshake;
2. `model/list` returns a non-empty current Codex catalog;
3. the repository marketplace is accepted through `marketplace/add`;
4. the plugin installs through `plugin/install` and is reported installed/enabled by `plugin/installed`;
5. current Codex accepts the generated custom Responses provider configuration;
6. a real `codex exec` request reaches the local gateway;
7. an upstream `/v1/responses` 404 is classified as endpoint incompatibility and falls back exactly once to `/v1/chat/completions`;
8. Chat SSE is translated back into Codex-consumable Responses SSE and `codex exec` completes with the deterministic sentinel;
9. a second real `codex exec` uses native Responses without touching Chat Completions;
10. an upstream 401 remains a Responses/authentication failure and never falls back to Chat;
11. protocol decisions are cached per model;
12. the exact pre-install Main selector can be restored;
13. a syntactically valid sentinel `auth.json` remains byte-for-byte unchanged.

CI runs the Node/process/HTTP suite on Node 20, 22 and 24, then runs this E2E on Ubuntu 24.04 with the current official Codex package.
