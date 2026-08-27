---
name: codex-worker-delegation
description: Use OAuth-safe Codex native subagents and provider-isolated Worker/Verifier threads with live model capability routing.
---

# Codex Worker Delegation

Treat the Web control plane as the source of truth for `OFFICIAL / AUTO / DELEGATE / MAIN`, current authentication state, and configured routes. Before substantial work, call `delegation_status` when the bundled MCP server is available.

## Mode contract

- `OFFICIAL`: the plugin is dormant. Do not force `delegate_worker`, do not reinterpret the installed Codex runtime's native model/reasoning/multi-agent defaults, and do not require the control plane to stay healthy for ordinary Codex tools.
- `AUTO`: keep trivial work on Main; delegate separable/substantial body work and meaningful verification according to the configured Worker/Verifier routes.
- `DELEGATE` (Web label `WORKER`): the root Main is coordination-only. Body work must be delegated.
- `MAIN`: the root Main performs the work; Worker delegation and native subagents are disabled.

Verifier is an internal read-only validation role, not a separate mode.

## Main authentication boundary

The active ChatGPT account is authoritative, not the presence of an `auth.json` file.

- When `account/read` reports `account.type="chatgpt"`, Main is the official Codex root. Main provider is locked to `official` in every custom mode. Never represent a third-party route as the ChatGPT root Main.
- When no active ChatGPT OAuth account is observed, the control plane may select a third-party Main. That Main is a **standalone provider-isolated App Server thread**, not a provider switch inside the ChatGPT UI.
- Never edit, replace, delete, copy, or re-login `auth.json` for third-party routing. The built-in `openai` provider and ChatGPT OAuth remain Codex-owned.
- Do not change top-level `model_provider` or `model` to switch providers. Provider choice is per newly created thread.

## Model capability contract

Model capability metadata is authoritative per `(provider, model)`.

- Official model choices and reasoning levels come from Codex `model/list`.
- Official provider-wide capabilities may come from `modelProvider/capabilities/read` when the installed Codex supports it; lack of this optional method must not break compatibility.
- Third-party reasoning levels are accepted only when the upstream model catalog explicitly advertises them.
- If a model does not advertise reasoning levels, use `auto` only. Never guess effort values from a model name, family, vendor, or another model.
- If the selected model changes and a previously selected effort is no longer advertised, reset to `auto` before execution.

## Delegated execution rules

1. **Main=Official ChatGPT and role=Official ChatGPT** → use current Codex native `spawn_agent` with `cwd-worker` / `cwd-verifier` when the active mode permits it.
2. **Any configured Worker/Verifier route involving `third_party`** → call bundled MCP tool `delegate_worker`. The control plane creates a tracked task and a new official Codex App Server thread with explicit `thread/start.modelProvider` and model.
3. **Third-party Main without OAuth** → use the control plane's standalone Main execution path. Its tools still obey the selected AUTO/DELEGATE/MAIN policy.
4. Never force a third-party provider through native subagent transport. Current custom-provider Codex routes have reproduced payload-loss failures; explicit provider-isolated threads preserve execution provenance.

Every provider-isolated Worker/Verifier has a durable `wrk_...` task ID, heartbeat/progress evidence, bounded lease, automatic review, and an audited terminal state. If a task is still running, inspect it with `worker_status`; do not start a duplicate. `worker_extend` and `worker_cancel` remain root-control fallbacks.

## Verification

Verifier is read-only. Use `cwd-verifier` or `delegate_worker(role="verifier")` when the task flow needs an independent pass. Never grant verifier mutation/execution authority.

The Web panel's **真实共存验收** proves that an official ChatGPT account remains active before and after a real third-party App Server turn while official top-level selectors stay unchanged. This proof is separate from a full production/release seal.
