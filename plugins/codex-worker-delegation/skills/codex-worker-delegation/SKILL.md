---
name: codex-worker-delegation
description: Use Codex native subagents with the user's Web-controlled AUTO, DELEGATE, or MAIN delegation policy. Apply for coding work that can benefit from parallel exploration, implementation, or independent verification.
---

# Codex Worker Delegation

Use Codex's native multi-agent/subagent tools. Do not simulate workers with shell processes or external chat loops.

Before substantial work, read `delegation_status` from the bundled MCP server when available.

- `AUTO`: keep simple work on the root agent. For separable or substantial work, use native subagents proactively: `explorer` for repository exploration, `cwd-worker` for body implementation, and `cwd-verifier` for independent verification. Parallelize independent tasks, then integrate results in the root thread.
- `DELEGATE`: the root agent is a coordinator. Delegate tool-heavy body work to `cwd-worker` (and read-only discovery to `explorer`); use `cwd-verifier` for meaningful verification. The root may plan, spawn, message, wait, and integrate results, but should not attempt body-work tools.
- `MAIN`: do not spawn new subagents. The root agent performs the task directly.

The Web panel is authoritative. Never change the delegation mode merely to bypass a denied tool. If a native hook denies an action, follow its reason and choose the allowed execution path.

For third-party models, do not rewrite or remove official ChatGPT authentication. The local `codex_worker_gateway` provider is intentionally separate from the built-in `openai` provider.
