# Security model

## Credential separation

- The built-in Codex `openai` provider remains owned by Codex and may continue using the user's ChatGPT OAuth/account state.
- This project does not write `auth.json`, keyring records, `chatgpt_base_url`, or built-in provider definitions.
- The New API key is encrypted at rest with AES-256-GCM using a separate random 32-byte local key stored mode `0600`.
- Codex never needs the New API key. The namespaced `codex_worker_gateway` provider authenticates to the local gateway with a distinct random bearer token stored mode `0600` and resolved through command-backed provider auth.
- Provider selection is per Codex execution thread. Switching a Worker from official to third-party does not require changing the ChatGPT login.

## Network boundary

- The control plane binds to `127.0.0.1` by default.
- The Web control plane stores only a salted scrypt password hash in the project data directory, uses short-lived HttpOnly SameSite sessions, throttles repeated login failures, and supports password rotation.
- The plugin's cross-provider MCP tool calls a token-authenticated internal loopback endpoint.
- A non-loopback Web deployment must set `CWD_REQUIRE_AUTH=1`, provide a bootstrap `CWD_WEB_TOKEN` for first-time password setup/automation, and use a TLS reverse proxy plus host firewall restrictions. Set `CWD_COOKIE_SECURE=1` when TLS terminates in front of the service.
- Do not expose the raw Node HTTP listener directly to the Internet; password protection is an application boundary, not a replacement for HTTPS, firewalling, rate limiting, or a reverse proxy.
- Provider URLs reject embedded credentials and non-HTTP(S) schemes.
- User-supplied `Authorization` headers are rejected; authorization is generated from the encrypted credential instead.

## Execution boundary

- Codex `PreToolUse` hooks are a policy guardrail, not an OS sandbox.
- `DELEGATE` denies root body-work tools while permitting coordination/delegation surfaces.
- `MAIN` denies new native or cross-provider workers and freezes native subagent tool execution.
- Cross-provider verifier threads are created with the Codex `read-only` sandbox. The hook also denies common execution/mutation tools for native `cwd-verifier` agents.
- Use Codex permissions/sandboxing and operating-system isolation for untrusted commands, secrets, and filesystem boundaries.

## Plugin trust

Codex must trust/install the plugin through its normal plugin/hook mechanisms before hook policy applies. This project does not bypass Codex's plugin trust model or approval surfaces.

## What coexistence does and does not mean

Coexistence means the same Codex installation can keep the official ChatGPT account/provider configured while separately routing selected threads through `codex_worker_gateway`. It does not mean a single native `spawn_agent` child can currently change model provider: upstream Codex inherits the parent's provider for native children, so cross-provider work intentionally uses a provider-specific App Server thread and is reported as such.
