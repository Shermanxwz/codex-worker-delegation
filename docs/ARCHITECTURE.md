# Architecture

## Principle

Codex Worker Delegation does not replace Codex orchestration. It composes with current Codex native Subagents/Multi-Agent V2 and the universal plugin system.

1. **Native plugin**: skill instructions, a read-only MCP status tool, and a `PreToolUse` hook.
2. **Local control plane**: loopback Web UI and state store.
3. **Responses compatibility gateway**: Codex always speaks Responses to `codex_worker_gateway`; the gateway either forwards native `/v1/responses` or translates to `/v1/chat/completions`.
4. **Codex config integration**: adds only a namespaced provider and custom subagent roles. Official authentication is outside this project's write set.

## Official + third-party coexistence

The built-in `openai` provider and ChatGPT login are never redefined. Worker and verifier role files can point to `codex_worker_gateway` even while the root thread continues to use official ChatGPT. The Web UI can optionally select the gateway for the root model and later restore the exact original top-level `model` / `model_provider` values captured at installation.

## Protocol auto-detection

For `protocol=auto`, the gateway first sends the real Codex request to the upstream Responses endpoint. Only endpoint-level unsupported signals (404/405/410/501 or explicit unsupported-route messages) trigger Chat Completions translation. Authentication, model, quota, and validation errors are not silently rerouted. A successful decision is cached per model and can be explicitly re-probed from the Web UI.

## Delegation policy

`PreToolUse` currently includes native Codex `agent_id` and `agent_type`, so policy can distinguish the root from a spawned subagent.

- AUTO: permit native behavior.
- DELEGATE: root only gets coordination tools; subagents may execute.
- MAIN: root may execute but cannot spawn new agents; existing subagent tool calls are denied.

Hosted tools that do not participate in `PreToolUse` remain outside this hook's enforcement boundary; this is a Codex hook-system limitation, not hidden by the project.
