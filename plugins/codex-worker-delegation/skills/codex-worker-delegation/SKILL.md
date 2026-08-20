---
name: codex-worker-delegation
description: Use Web-controlled Codex native subagents and cross-provider workers while preserving the user's official ChatGPT authentication.
---

# Codex Worker Delegation

Treat the Web control plane as the source of truth for AUTO / DELEGATE / MAIN and for the Main / Worker / Verifier provider+model selection.

Before substantial work, call `delegation_status` when the bundled MCP server is available.

## Execution rules

- `MAIN`: do not spawn or delegate. The root thread performs the work.
- `AUTO`: keep trivial work on Main. Delegate separable or substantial body work and meaningful verification.
- `DELEGATE`: the root thread is coordination-only. Body work must be delegated.

For each delegated role, compare the selected provider with Main:

1. **Same provider** → use Codex's native `spawn_agent` path. Use `cwd-worker` for implementation and `cwd-verifier` for independent verification, and pass the Web-selected model when Codex exposes a model override.
2. **Different provider** → call bundled MCP tool `delegate_worker`. It creates a provider-specific thread through the official `codex app-server` protocol and returns the worker result to the root thread.

Never pretend a cross-provider thread is a native subagent. Report it as `Cross-provider Thread` when execution provenance matters.

## Authentication boundary

Do not edit, replace, delete, or re-login `auth.json` to route third-party work. The built-in `openai` provider and ChatGPT OAuth remain intact. Third-party credentials belong to the local Codex Worker Delegation vault; Codex receives only the local gateway bearer token through the namespaced `codex_worker_gateway` provider.

## Verification

Use `cwd-verifier` or `delegate_worker(role="verifier")` for independent validation after meaningful implementation. Verifier execution is read-only by policy.
