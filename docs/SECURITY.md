# Security model / 安全模型

## 中文概览

项目把官方 ChatGPT 登录、New API 密钥、Web 密码和 Worker 执行权限分成不同边界：不修改或复制 auth.json；New API key 只进入本地 AES-256-GCM vault；Codex 只拿到本地 gateway token；Web 默认只监听 loopback；Worker / Verifier 通过真实 task ID 和 provider-isolated App Server thread 执行。

Web 密码只保护本地控制平面，退出 Web session 不会退出 ChatGPT。MAIN 是服务端强制锁；Worker 任务的取消和续期属于主控 fallback，Web 页面只能查看状态。准备接入公网时仍必须使用 HTTPS reverse proxy、host firewall、限流和独立部署隔离。

## English overview

The project separates official ChatGPT authentication, the New API key, the Web password, and Worker execution authority. It never edits or copies auth.json; the New API key stays in an AES-256-GCM vault; Codex receives only a local gateway token; the Web service binds to loopback by default; and Worker / Verifier execution is tracked through real task IDs and provider-isolated App Server threads.

The Web password protects only the local control plane, so logging out of the Web session does not log ChatGPT out. MAIN is enforced at the server boundary. Worker cancellation and renewal are root-control fallbacks, while the Web page remains observational. A public deployment still requires an HTTPS reverse proxy, host firewall, rate limiting, and independent service isolation.

## Credential separation

- The built-in Codex `openai` provider remains owned by Codex and may continue using the user's ChatGPT OAuth/account state.
- This project does not write `auth.json`, keyring records, `chatgpt_base_url`, or built-in provider definitions.
- The New API key is encrypted at rest with AES-256-GCM using a separate random 32-byte local key stored mode `0600`.
- Codex never needs the New API key. The namespaced `codex_worker_gateway` provider authenticates to the local gateway with a distinct random bearer token stored mode `0600` and resolved through command-backed provider auth.
- Provider selection is per Codex execution thread. Switching a Worker from official to third-party does not require changing the ChatGPT login.

## Network boundary

- The control plane binds to `127.0.0.1` by default.
- The Web control plane stores only a salted scrypt password hash in the project data directory, uses short-lived HttpOnly SameSite sessions, throttles repeated login failures, and supports password rotation.
- The Web password protects the local control plane only. `POST /api/auth/logout` clears the control-plane session cookie; it does not log out ChatGPT, touch OAuth state, or change Codex's official provider.
- The plugin's cross-provider MCP tool calls a token-authenticated internal loopback endpoint.
- A non-loopback Web deployment must set `CWD_REQUIRE_AUTH=1`, provide a bootstrap `CWD_WEB_TOKEN` for first-time password setup/automation, and use a TLS reverse proxy plus host firewall restrictions. Set `CWD_COOKIE_SECURE=1` when TLS terminates in front of the service.
- Do not expose the raw Node HTTP listener directly to the Internet; password protection is an application boundary, not a replacement for HTTPS, firewalling, rate limiting, or a reverse proxy.
- Provider URLs reject embedded credentials and non-HTTP(S) schemes.
- User-supplied `Authorization` headers are rejected; authorization is generated from the encrypted credential instead.

## Execution boundary

- Codex `PreToolUse` hooks are a policy guardrail, not an OS sandbox.
- `DELEGATE` denies root body-work tools while permitting coordination/delegation surfaces.
- `MAIN` denies new native or cross-provider workers and freezes native subagent tool execution.
- The active Web mode is enforced again at the HTTP/MCP boundary; a request cannot pass a stale `DELEGATE` value to bypass `MAIN`.
- Cross-provider verifier threads are created with the Codex `read-only` sandbox. The hook also denies common execution/mutation tools for native `cwd-verifier` agents.
- Worker task snapshots are stored under the private data directory with mode `0600`; they contain status, model/provider, progress, IDs, events, and redacted structured errors, not the original task prompt.
- Worker and Verifier cancellation is scoped to the matching task ID: only the token-authenticated internal MCP route used by the root control plane marks the task `cancelled` and terminates that task's App Server. The Web UI is read-only for task control. Cancellation is idempotent and cannot be used to stop the main Codex process.
- Worker lease renewal is supervisor-controlled by default: at `reviewDue`, the control plane renews when the task has recent meaningful lifecycle progress and a healthy heartbeat, and may grant one bounded grace review to work that has entered real execution but temporarily emits only heartbeats. It never exceeds the profile's per-renewal or hard total runtime cap; repeated heartbeat-only, stalled, unavailable, or exhausted work is cancelled fail-closed. Each decision is persisted with evidence and reason. Root-control `worker_extend` remains a token-authenticated fallback; the Web UI cannot extend or cancel a task.
- Use Codex permissions/sandboxing and operating-system isolation for untrusted commands, secrets, and filesystem boundaries.

## Plugin trust

Codex must trust/install the plugin through its normal plugin/hook mechanisms before hook policy applies. This project does not bypass Codex's plugin trust model or approval surfaces.

## What coexistence does and does not mean

Coexistence means the same Codex installation can keep the official ChatGPT account/provider configured while separately routing selected threads through `codex_worker_gateway`. It does not mean a single native `spawn_agent` child can currently change model provider: upstream Codex inherits the parent's provider for native children, so cross-provider work intentionally uses a provider-specific App Server thread and is reported as such.

It also does not mean that New API IDs appear in the official signed-in `openai` picker. The local UI and the namespaced provider have their own third-party catalog. The current official `model/list` entries do not carry the provider binding required to make a visible third-party ID route safely, so a catalog-only injection is not treated as coexistence success.
