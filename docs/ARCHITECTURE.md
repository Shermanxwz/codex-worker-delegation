# Architecture

## Principle

Codex Worker Delegation augments the official ChatGPT Linux / Codex runtime rather than replacing it. Codex remains the execution runtime and owner of ChatGPT authentication. The local Web control plane owns explicit routing policy.

v3 has four layers:

1. **Codex plugin** — routing skill, hooks, `delegation_status`, and `delegate_worker`.
2. **Local control plane** — loopback Web UI, compact per-mode routing, encrypted provider state, coexistence proof, audit log.
3. **Responses compatibility gateway** — a stable Codex-facing Responses provider that either forwards upstream `/v1/responses` or bridges `/v1/chat/completions`.
4. **Codex App Server integration** — reads `account/read` + `model/list` and creates provider-specific worker threads with explicit `thread/start.modelProvider`.

## Worker execution policy

Native subagents are used only for built-in OpenAI → built-in OpenAI delegated routes. Any route involving `third_party` uses an independent App Server thread.

This is intentionally more conservative than “same provider means native”. Current 2026 Codex custom-provider Multi-Agent V2 builds have documented cases where `spawn_agent` / follow-up payloads are transported as OpenAI-specific `agent_message` / `encrypted_content` and a non-OpenAI provider receives an empty task. App Server threads begin with normal turn input and avoid that inter-agent transport boundary.

Execution provenance is explicit:

- `native_subagent_required`: Official → Official.
- `provider_isolated_thread`: Third-party → Third-party.
- `cross_provider_thread`: providers differ.

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

## Model discovery

- Official catalog: Codex App Server `model/list`, paginated, and used only by the built-in `openai` provider.
- Third-party catalog: upstream `/v1/models`, shown in the local routing and connectivity pages.
- The local gateway additionally translates the third-party catalog to Codex's native `/models?client_version=...` envelope for the namespaced provider. This is a provider-specific catalog, not a merge into the signed-in official `openai` picker.
- Third-party IDs are not relabeled as official models; provider isolation is preserved while both providers remain installed and routable in the same session.
- Manual model ID fallback remains available.

## Reasoning effort

Each visible route stores `effort`: `auto` or an explicit supported level. The Web panel derives the official options from the live `model/list` catalog and offers a conservative common set for New API models that do not advertise reasoning metadata. `auto` omits `turn/start.effort`; Codex then applies its effective configuration and the selected model's advertised default. An explicit value is sent as the native App Server `turn/start.effort`, so the Codex runtime and its upstream request receive the same selection. When the active Main route is official, an explicit Web value also updates top-level `model_reasoning_effort`; `model_provider`, `model`, and ChatGPT authentication remain untouched. `auto` leaves the existing Codex global setting unchanged.

For New API traffic, the gateway still does not forward inherited Codex reasoning by default. It strips an inherited `reasoning.effort`, but preserves an effort that matches an explicit Web route selection for that third-party model. This prevents the local global setting from leaking into an unconfigured route while allowing a deliberate Web setting to reach Responses or the Chat fallback bridge. If the upstream model does not support the selected value, the upstream may reject it; the UI therefore exposes `auto` and does not claim unsupported third-party capabilities.

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
  |      `-> native spawn_agent -> cwd-worker / cwd-verifier
  |
  `─ any route involving third_party
         `-> plugin MCP delegate_worker
                -> local control plane
                -> codex app-server thread/start(modelProvider, model)
                      ├─ openai
                      `─ codex_worker_gateway
                             -> upstream Responses or Chat bridge
```

## Sandbox values

App Server's wire protocol uses hyphenated values (`workspace-write`, `read-only`, `danger-full-access`). The control plane also accepts legacy camelCase aliases from its own callers and normalizes them before `thread/start`.
