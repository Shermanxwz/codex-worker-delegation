# Architecture

## Principle

Codex Worker Delegation augments the official ChatGPT Linux / Codex runtime instead of replacing it. The Web control plane owns routing policy; Codex remains the execution runtime.

The v2 design has four layers:

1. **Codex plugin** — skill instructions, `PreToolUse` enforcement, `delegation_status`, and `delegate_worker`.
2. **Local control plane** — loopback Web UI, routing matrix, encrypted provider state, audit log.
3. **Responses compatibility gateway** — Codex always speaks Responses to the namespaced `codex_worker_gateway`; the gateway forwards native `/v1/responses` or bridges a chat-only upstream.
4. **Codex App Server integration** — reads the current model catalog and creates provider-specific cross-provider threads using official JSON-RPC methods.

## Why there are two worker paths

Current Codex native `spawn_agent` supports child model/reasoning overrides, but the child inherits the parent model provider. A role file can change bounded role configuration, but it is not a supported provider-switch boundary.

Therefore routing is explicit:

- **Same provider as Main**: native Codex subagent. `cwd-worker` and `cwd-verifier` are normal auto-discovered roles in `~/.codex/agents/*.toml`.
- **Different provider from Main**: provider-specific Codex App Server thread created with `thread/start.modelProvider`.

The second path remains a real Codex thread but is not represented as a native spawn edge. The Web UI and MCP result identify it as a `Cross-provider Thread`; the project never fabricates native-subagent provenance.

## Official + third-party coexistence

Installation does not change the existing top-level `model_provider` or `model` selection and does not touch `auth.json`. It adds only:

```toml
[model_providers.codex_worker_gateway]
name = "Codex Worker Delegation Gateway"
base_url = "http://127.0.0.1:8788/v1"
wire_api = "responses"
requires_openai_auth = false

[model_providers.codex_worker_gateway.auth]
command = "cat"
args = ["<project gateway.token>"]
```

The built-in `openai` provider continues using Codex-owned ChatGPT authentication. The New API credential never enters Codex config; it stays encrypted in this project's vault. Selection happens per execution thread, not by replacing the account login.

## Model discovery

- Official/current Codex catalog: `codex app-server` → `model/list` with pagination.
- Third-party catalog: configured upstream → `/v1/models`.
- Manual model IDs remain available because some OpenAI-compatible providers do not expose a useful models endpoint.

The state store persists provider + model independently for Main, Worker, and Verifier in `AUTO`, `DELEGATE`, and `MAIN`.

## Protocol auto-detection

Codex custom providers use Responses wire format. The local gateway therefore has one stable Codex-facing API regardless of upstream implementation.

For `protocol=auto`:

1. send to upstream `/v1/responses`;
2. cache Responses support when successful;
3. fall back to `/v1/chat/completions` only on endpoint-level unsupported signals (404/405/410/501 or explicit unsupported-route text);
4. never hide authentication, quota, model, or validation errors by retrying them as another protocol;
5. translate text, tool calls, tool outputs, streaming events, and usage back into Responses semantics.

The decision cache is per model and can be re-probed from the Web UI.

## Delegation policy

`PreToolUse` receives root/subagent identity information from current Codex for thread-spawned agents.

- `AUTO`: normal Codex execution; routing instructions encourage delegation where useful.
- `DELEGATE`: root is coordination-only. Native agent-management tools and the cross-provider delegation MCP tool remain allowed; body-work tools are denied on root.
- `MAIN`: root executes directly. Native spawning and cross-provider delegation are denied; existing native subagent tool calls are frozen.
- `cwd-verifier`: execution/mutation tool patterns are denied in addition to the read-only App Server sandbox used for cross-provider verifier threads.

Hosted capabilities that do not pass through `PreToolUse` remain outside the hook boundary. The project does not claim an OS-level sandbox; Codex sandbox/permissions remain the security authority.

## Runtime flow

```text
Web panel
  ├─ model/list via Codex app-server
  ├─ New API /v1/models
  └─ routing state
          |
          v
Root Codex thread
  ├─ same-provider task -> native spawn_agent -> cwd-worker / cwd-verifier
  └─ cross-provider task -> plugin MCP delegate_worker
                               |
                               v
                         local control plane
                               |
                               v
                    codex app-server thread/start
                      modelProvider=<selected>
                               |
                               v
                    official or gateway provider
```
