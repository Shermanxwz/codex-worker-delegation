# Architecture

## Principle

Codex Worker Delegation augments the official ChatGPT Linux / Codex runtime rather than replacing it. Codex remains the execution runtime and owner of ChatGPT authentication. The local Web control plane owns explicit routing policy.

v3 has four layers:

1. **Codex plugin** — routing skill, hooks, `delegation_status`, `delegate_worker`, `worker_status`, `worker_extend`, and `worker_cancel`.
2. **Local control plane** — loopback Web UI, compact per-mode routing, encrypted provider state, coexistence proof, audit log.
3. **Responses compatibility gateway** — a stable Codex-facing Responses provider that either forwards upstream `/v1/responses` or bridges `/v1/chat/completions`.
4. **Codex App Server integration** — reads `account/read` + `model/list` and creates provider-specific worker threads with explicit `thread/start.modelProvider`.

## Worker execution policy

Native subagents are used only for built-in OpenAI → built-in OpenAI delegated routes. Any route involving `third_party` uses an independent App Server thread.

This is intentionally more conservative than “same provider means native”. Current custom-provider Codex routes have reproduced cases where `spawn_agent` / follow-up payloads are transported as OpenAI-specific `agent_message` / `encrypted_content` and a non-OpenAI provider receives an empty task. App Server threads begin with normal turn input and avoid that inter-agent transport boundary.

Execution provenance is explicit:

- `native_subagent_required`: Official → Official.
- `provider_isolated_thread`: Third-party → Third-party.
- `cross_provider_thread`: providers differ.

Choosing `DELEGATE` (shown as `WORKER` in the Web UI) changes the policy and route selection; it does not launch a Worker automatically. A real task must enter through `delegate_worker` or the Web route test. `AUTO` keeps trivial work on Main and may delegate substantial separable work. `MAIN` disables delegation and native subagent execution, and the HTTP/MCP layer rejects any request that tries to override the active mode.

## Mode and selector semantics

The Web control plane deliberately exposes only selectors that affect execution:

| Mode | Visible selectors | Runtime meaning |
|---|---|---|
| `AUTO` | Main only | Worker and Verifier inherit Main; the system may delegate substantial work. |
| `DELEGATE` / `WORKER` | Main + Worker | Main coordinates; Worker executes. Verifier inherits Worker and is read-only. |
| `MAIN` | Main only | The root thread performs the work; Worker delegation is disabled. |

Verifier is an internal read-only role, not a third execution mode and not an independent model slot. Its provider, model, and effort always inherit the Worker route in `DELEGATE` and the Main route in `AUTO`/`MAIN`. When the task flow requests verification, it runs on that inherited route; configuring the role alone does not launch a second turn. Provider-isolated tasks expose progress, heartbeats, task IDs, and an idempotent cancellation path that terminates only the task's App Server.

## Official + third-party coexistence

Installation never changes top-level `model_provider` or `model` and never modifies `auth.json`. It adds only:

```toml
[model_providers.codex_worker_gateway]
name = "Codex Worker Delegation Gateway"
base_url = "http://127.0.0.1:8788/v1"
wire_api = "responses"

[model_providers.codex_worker_gateway.auth]
command = "cat"
args = ["<project gateway.token>"]
```

The command-backed `auth` table is not combined with `requires_openai_auth`. Built-in `openai` continues using Codex-owned ChatGPT authentication, while the New API key remains encrypted in the project's vault.

### Runtime coexistence proof

The Web endpoint `/api/verify/coexistence` performs an actual provider-level check on the installed machine:

1. snapshot parsed top-level `model_provider` / `model`;
2. `account/read(refreshToken=false)` and require ChatGPT account type;
3. start a read-only third-party thread with `modelProvider=codex_worker_gateway`;
4. complete one third-party turn;
5. call `account/read` again;
6. re-read the top-level selector and require it to be unchanged.

The proof result is shown in the Web panel and recorded as a redacted audit event.

This proof answers one question: whether the official account remains usable while one explicit third-party thread completes. It is separate from the strict production seal. The proof can pass while the seal remains `NOT_SEALED` because the seal also requires complete model connectivity and official-picker inclusion.

## Model discovery

- Official catalog: Codex App Server `model/list`, paginated, and used only by the built-in `openai` provider.
- Third-party catalog: upstream `/v1/models`, shown in the local routing and connectivity pages.
- The local gateway additionally translates the third-party catalog to Codex's native `/models?client_version=...` envelope for the namespaced provider. This is a provider-specific catalog, not a merge into the signed-in official `openai` picker.
- The official App Server `model/list` entries currently do not expose a provider binding. Injecting a third-party ID into a visible catalog without that binding can make it appear selectable while a new thread still routes through `openai`; the project therefore does not call catalog-only visibility a successful integration.
- Third-party IDs are not relabeled as official models; provider isolation is preserved while both providers remain installed and routable in the same session.
- Manual model ID fallback remains available.

## Reasoning effort

Each visible route stores `effort`: `auto` or an explicit supported level. The Web panel derives official options from live `model/list` metadata and offers a conservative common set for New API models that do not advertise reasoning metadata. `auto` omits `turn/start.effort`; Codex then applies its effective configuration. An explicit value is sent on a provider-isolated App Server turn. When the active Main route is official, an explicit Web value also updates top-level `model_reasoning_effort`; `model_provider`, `model`, and ChatGPT authentication remain untouched. `auto` leaves the existing Codex global setting unchanged.

For New API traffic, the gateway does not forward inherited Codex reasoning by default. It strips an inherited `reasoning.effort`, but preserves an effort that matches an explicit Web route selection for that third-party model. This prevents the local global setting from leaking into an unconfigured route while allowing a deliberate Web setting to reach Responses or the Chat fallback bridge. If the upstream model does not support the selected value, the upstream may reject it; the UI therefore exposes `auto` and does not claim unsupported third-party capabilities.

AUTO stores one Main route and makes Worker / Verifier inherit it. DELEGATE (shown as WORKER) stores Main + Worker routes and makes Verifier inherit Worker. MAIN stores one Main route and disables delegation.

## Protocol detection

Codex-facing custom provider traffic is Responses. For `protocol=auto`, the gateway probes/routes per model: Responses first, Chat Completions fallback only for genuine unsupported-endpoint signals, never for auth/quota/model/validation errors.

The configured Base URL may itself point to the service root, `/v1`, `/v1/responses`, `/v1/chat/completions`, or `/v1/models`; related endpoints are normalized automatically.

## Runtime flow

```text
Web panel
  ├─ account/read + model/list (official Codex)
  ├─ New API /v1/models
  ├─ per-role routing state
  └─ coexistence proof
          |
          v
Root Codex thread
  ├─ Official -> Official delegated role
  |      `-> delegate_worker returns native instruction
  |             `-> root Codex performs spawn_agent -> cwd-worker / cwd-verifier
  |
  `─ any route involving third_party
         `-> plugin MCP delegate_worker
                -> local control plane
                -> wrk_<taskId> persistent task
                -> codex app-server thread/start(modelProvider, model)
                      ├─ openai
                      `─ codex_worker_gateway
                             -> upstream Responses or Chat bridge
```

## Worker task lifecycle

Provider-isolated execution is asynchronous at the control-plane boundary. `POST /api/worker/start` and the token-authenticated `POST /internal/worker/start` return a task ID immediately. `GET /api/worker/status/:taskId` and `GET /internal/worker/status/:taskId` expose the same redacted snapshot: `queued` → `running` → `completed`, `failed`, or `timed_out`. The snapshot contains phase, progress estimate, `lastHeartbeatAt`, event history, thread/turn IDs, result, structured error, and the current lease (`deadlineAt`, `reviewAt`, `reviewDue`, `extensionCount`). A background heartbeat continues even when the App Server emits no progress notification.

The legacy `/api/worker/run` and `/internal/worker/run` endpoints now start an observable task by default. Synchronous waiting is retained only when the caller explicitly supplies `waitForCompletion: true`. This prevents an unbounded HTTP request from hiding a stalled App Server turn.

The initial lease defaults to 15 minutes. Ninety seconds before its deadline, the task emits `worker.review_due` and sets `reviewDue=true`. Only the root Main control plane may then call the token-authenticated `POST /internal/worker/extend/:taskId`; the extension updates the same App Server notification deadline and is capped at 15 minutes per renewal and 60 minutes total. The Web UI displays the lease and review state but has no cancel or extend action. If the review finds a stalled, unsafe, or out-of-scope task, the root calls `worker_cancel` instead.

## Sandbox values

App Server's wire protocol uses hyphenated values (`workspace-write`, `read-only`, `danger-full-access`). The control plane also accepts legacy camelCase aliases from its own callers and normalizes them before `thread/start`.
