---
name: codex-worker-delegation
description: Use Web-controlled Codex native subagents and provider-isolated worker threads while preserving the user's official ChatGPT authentication.
---

# Codex Worker Delegation

Treat the Web control plane as the source of truth for AUTO / DELEGATE / MAIN and for every Main / Worker / Verifier provider+model selection. Before substantial work, call `delegation_status` when the bundled MCP server is available.

## Execution rules

- `MAIN`: do not spawn or delegate. The root thread performs the work.
- `AUTO`: keep trivial work on Main. Delegate separable/substantial body work and meaningful verification.
- `DELEGATE`: the root thread is coordination-only. Body work must be delegated.

For delegated roles:

1. **Main=Official ChatGPT and role=Official ChatGPT** → use current Codex native `spawn_agent`. Use `cwd-worker` or `cwd-verifier`, with the Web-selected model when an explicit model override is available.
2. **Any route involving `third_party`** → call bundled MCP tool `delegate_worker`. The control plane creates a new official Codex App Server thread with an explicit `thread/start.modelProvider` and model. This includes third-party→third-party routes as well as cross-provider routes.

Do not force a third-party provider through native subagent transport. Current 2026 Codex releases have documented custom-provider Multi-Agent V2 failures where delegated payloads can be represented as provider-specific `agent_message`/`encrypted_content` and arrive empty at non-OpenAI providers. The isolated-thread path uses ordinary user-turn input instead.

Never describe a provider-isolated thread as a native subagent. Preserve execution provenance from the tool result (`native_subagent_required`, `provider_isolated_thread`, or `cross_provider_thread`).

## Authentication boundary

Never edit, replace, delete, copy, or re-login `auth.json` for third-party routing. The built-in `openai` provider and ChatGPT OAuth remain Codex-owned. Third-party credentials stay in the local encrypted vault; Codex receives only a local command-backed gateway token through the namespaced `codex_worker_gateway` provider.

Do not change the top-level `model_provider` or `model` to switch providers. Provider choice is per newly created thread.

## Verification

Use `cwd-verifier` or `delegate_worker(role="verifier")` after meaningful implementation. Verifier App Server threads use the official `read-only` wire value. The Web panel's **真实共存验收** is the authoritative runtime proof when the user wants to verify simultaneous ChatGPT login and New API operation on the actual Linux installation.
