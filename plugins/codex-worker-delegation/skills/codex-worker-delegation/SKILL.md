---
name: codex-worker-delegation
description: Use Web-controlled Codex native subagents and provider-isolated worker threads while preserving the user's official ChatGPT authentication.
---

# Codex Worker Delegation

Treat the Web control plane as the source of truth for AUTO / DELEGATE / MAIN and for every Main / Worker / Verifier provider+model selection. Before substantial work, call `delegation_status` when the bundled MCP server is available.

The mode is a policy and routing choice, not an automatic task launcher. A Worker runs only after a real `delegate_worker` call or a Web route-test request. The Web UI shows `DELEGATE` as `WORKER`. The active Web mode is authoritative; never pass a stale mode to bypass `MAIN`.

## Execution rules

- `MAIN`: do not spawn or delegate. The root thread performs the work.
- `AUTO`: keep trivial work on Main. Delegate separable/substantial body work and meaningful verification.
- `DELEGATE`: the root thread is coordination-only. Body work must be delegated.

Routing selectors follow the same boundary: `AUTO` exposes Main only and Worker/Verifier inherit it; `DELEGATE` exposes Main + Worker and Verifier inherits Worker; `MAIN` exposes Main only. Verifier is an internal read-only role, not a third model selector or a separate mode.

For delegated roles:

1. **Main=Official ChatGPT and role=Official ChatGPT** → use current Codex native `spawn_agent`. Use `cwd-worker` or `cwd-verifier`, with the Web-selected model when an explicit model override is available.
2. **Any route involving `third_party`** → call bundled MCP tool `delegate_worker`. The control plane creates a tracked task and a new official Codex App Server thread with an explicit `thread/start.modelProvider` and model. If the tool returns a non-terminal task snapshot, the root Main must monitor it with `worker_status` and inspect its heartbeat, progress, event details, scope, and result; do not start a duplicate task. Heartbeat proves liveness only. When `reviewDue=true`, the root Main must decide from substantive evidence: if the task is on scope, safe, and making real progress, call `worker_extend` with that task ID; if it is stalled, unsafe, or doing work outside the assignment, call `worker_cancel`. Do not ask the user to stop or renew a Worker from the Web page. This includes third-party→third-party routes as well as cross-provider routes.

For the official → official case, the control plane can return the native-subagent instruction and provenance, but the root Codex thread remains responsible for performing `spawn_agent`. For any route involving `third_party`, do not substitute a native child for the provider-isolated App Server thread.

Do not force a third-party provider through native subagent transport. Current custom-provider Codex routes have reproduced failures where delegated payloads can be represented as provider-specific `agent_message`/`encrypted_content` and arrive empty at non-OpenAI providers. The isolated-thread path uses ordinary user-turn input instead.

Never describe a provider-isolated thread as a native subagent. Preserve execution provenance from the tool result (`native_subagent_required`, `provider_isolated_thread`, or `cross_provider_thread`).

## Authentication boundary

Never edit, replace, delete, copy, or re-login `auth.json` for third-party routing. The built-in `openai` provider and ChatGPT OAuth remain Codex-owned. Third-party credentials stay in the local encrypted vault; Codex receives only a local command-backed gateway token through the namespaced `codex_worker_gateway` provider.

Do not change the top-level `model_provider` or `model` to switch providers. Provider choice is per newly created thread.

## Verification

Verifier is the Worker route's read-only validation role. Use `cwd-verifier` or `delegate_worker(role="verifier")` when the task flow needs an independent read-only pass; in `DELEGATE`, it inherits the Web-selected Worker provider, model, and effort (for example, `MiniMax-M3`) and has no separate selector. Verifier App Server threads use the official `read-only` wire value; configuring the inherited role alone does not invoke a turn. The Web panel's **真实共存验收** is the authoritative runtime proof when the user wants to verify simultaneous ChatGPT login and New API operation on the actual Linux installation; this proof is independent of the stricter production-seal result.
