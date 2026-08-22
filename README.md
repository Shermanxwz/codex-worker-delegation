# Codex Worker Delegation

A local control plane for the official **ChatGPT Linux desktop / Codex runtime**. It keeps Codex-owned ChatGPT authentication intact while adding a separate New API / OpenAI-compatible provider, explicit per-thread role routing, current App Server integration, and a Responses compatibility gateway. It is an integration and routing layer; it is not a replacement for the signed-in official Codex model registry or picker.

## v3: coexistence is thread routing, not login switching

```text
ChatGPT Linux / Codex
  |
  +-- built-in `openai` provider ---------------- ChatGPT OAuth / auth.json (Codex-owned)
  |
  `-- `codex_worker_gateway` provider ------------ local command-backed token
          |
          `-- encrypted New API credential
                 |-- upstream /v1/responses
                 `-- upstream /v1/chat/completions bridge
```

The project **never needs to replace the top-level `model_provider`, rewrite `auth.json`, or log ChatGPT out**. Provider and model are chosen when a new Codex thread is created. New API models are available to the local routing UI and the namespaced provider, but are not provider-correctly merged into the signed-in official `openai` picker because the current App Server model entries do not carry a provider binding. The Web panel can prove coexistence on the actual machine by running:

```text
account/read (ChatGPT)
  -> thread/start(modelProvider="codex_worker_gateway")
  -> a real third-party model turn
  -> account/read (ChatGPT)
  -> verify top-level model_provider/model stayed unchanged
```

## Worker policy aligned with current Codex

The project keeps native subagent transport only for built-in OpenAI → built-in OpenAI routes. In tested custom-provider routes, native `spawn_agent` payloads can reach non-OpenAI providers as provider-specific `agent_message` / `encrypted_content` and arrive empty, so third-party work uses an ordinary App Server turn instead.

v3 therefore fails safe:

| Main route | Worker/Verifier route | Execution |
|---|---|---|
| Official ChatGPT | Official ChatGPT | **Native Subagent** (`cwd-worker` / `cwd-verifier`) |
| Official ChatGPT | New API | **Cross-provider App Server Thread** |
| New API | Official ChatGPT | **Cross-provider App Server Thread** |
| New API | New API | **Provider-isolated App Server Thread** |

Third-party → third-party intentionally uses an independent App Server thread instead of native spawn until upstream custom-provider subagent transport is reliable. This is visible in Web/MCP results; the project does not fake native-subagent provenance.

Selecting a mode does not start a task by itself. A Worker runs only after a real `delegate_worker` call or a Web **运行当前模式路由** request. For an official → official route, the control plane returns a native-subagent instruction and the root Codex thread must perform `spawn_agent`; for any route involving New API, the control plane creates a tracked provider-isolated App Server task.

### Observable Worker tasks

Every provider-isolated Worker or Verifier task receives a persistent `wrk_...` task ID before the App Server thread starts. The local control plane records its phase, percentage estimate, model/provider, thread and turn IDs, recent progress events, last progress timestamp, last heartbeat, lease deadline, scheduled observation point, extension counts, automatic review decisions, terminal status, result, and structured error. The Web route test is a read-only view that starts immediately and polls `/api/worker/status/:taskId`; the root Main can use MCP `worker_status` to inspect a live task. Near each lease deadline, the control plane automatically evaluates concrete progress evidence: recent meaningful progress plus a healthy heartbeat renews the same lease within the hard cap; a task that has entered real execution but temporarily emits only heartbeats receives one bounded grace review; repeated heartbeat-only, stalled, unavailable, or exhausted work is actively cancelled. The decision and evidence are persisted in the task event stream and redacted audit log.

`completed`, `failed`, `timed_out`, and `cancelled` are distinct terminal states. A timed-out task is never presented as completed, is written to the redacted audit log as `worker.failed` with `status: "timed_out"`; an operator-cancelled task is written as `worker.cancelled` with `WORKER_CANCELLED` and retains its task ID for diagnosis. Task snapshots are stored with local mode `0600`; the original prompt is not persisted in the task file.

The standard Worker lease is at most 15 minutes initially and the default is 15 minutes; `quick` starts at 2 minutes and is hard-capped at 10 minutes. The observation point is no later than 90 seconds before the current deadline. Automatic renewal adds at most 15 minutes for standard work or 2 minutes for quick work, always respecting the task's hard total cap (60 minutes standard, 10 minutes quick), so a task cannot renew indefinitely. The supervisor does not make an extra model call: it uses the recorded heartbeat and meaningful lifecycle events, which keeps supervision bounded and does not consume Main tokens. Manual `worker_extend` / `worker_cancel` remain root-control fallback tools, not Web-user controls.

The active Web mode is authoritative. A caller cannot override `MAIN` by passing `mode: "DELEGATE"`; both the MCP layer and the HTTP control plane reject that request before creating an App Server thread. Verifier is the Worker route's read-only verification role: in `DELEGATE` it inherits the Web-selected Worker provider, model, and effort (for example, `MiniMax-M3`) and has no separate selector. A verification call starts when the task flow requests it; merely configuring the inherited role does not launch a second turn.

## Web control plane

The Web UI owns all normal operations:

- `AUTO`, `WORKER` (`DELEGATE` internally), `MAIN` modes. `AUTO` and `MAIN` expose one Main selector; `WORKER` exposes Main + Worker selectors.
- Compact routing selection: AUTO exposes one Main model, WORKER exposes Main + Worker, and MAIN exposes one Main model.
- Verifier is an internal read-only role that inherits Worker and never gets a separate model selector.
- Official model discovery from the running Codex `model/list` API.
- Third-party model discovery from New API `/v1/models`, with manual model ID fallback.
- New API Base URL + key + protocol configuration.
- Per-model protocol probe/cache.
- Install/refresh of the namespaced Codex provider and agent roles.
- Per-route reasoning effort selection. `auto` omits `turn/start.effort`; an explicit value is sent on provider-isolated App Server turns, and an explicit official Main value also synchronizes Codex's `model_reasoning_effort` without changing `model_provider` or `model`.
- Independent jump pages for access protection, New API configuration, model routing, model connectivity, and Codex integration.
- **真实共存验收** runtime proof.
- Real provider-isolated route execution for Worker / Verifier with observable task IDs, progress, heartbeats, cancellable task App Servers, and terminal audit states; official → official routes return the native `spawn_agent` instruction for the root Codex thread.

## New API endpoint normalization and protocol detection

The Base URL may be entered as a service root, `/v1`, `/v1/responses`, `/v1/chat/completions`, `/v1/embeddings`, or `/v1/models`. The control plane derives the related endpoints.

Codex custom providers currently use the Responses wire API, so Codex always talks to this project's local `/v1/responses` gateway. With `protocol=auto`, the gateway decides **per model**:

1. Try upstream `/v1/responses`.
2. Cache `responses` on success.
3. Fall back to `/v1/chat/completions` only when the Responses route is genuinely unsupported.
4. Never reinterpret authentication, quota, validation, or missing-model failures as “chat-only”.
5. Translate streaming text, tools, tool outputs, and usage back to Responses semantics.

Models identified by the upstream catalog as embeddings/vector models are tested with `/v1/embeddings` and remain in the connectivity page only; they are not offered as chat Worker/Main route choices. This prevents a valid embedding model from being falsely tested through a chat endpoint or selected for a text-generation thread.

## Correct Codex provider auth

Installation adds only a namespaced custom provider:

```toml
[model_providers.codex_worker_gateway]
name = "Codex Worker Delegation Gateway"
base_url = "http://127.0.0.1:8788/v1"
wire_api = "responses"

[model_providers.codex_worker_gateway.auth]
command = "cat"
args = ["<local gateway.token>"]
```

Command-backed `auth` is intentionally **not combined with `requires_openai_auth`**. The gateway token is separate from both ChatGPT OAuth and the upstream New API key.

## Linux / App Server integration

Codex discovery includes the ChatGPT Linux packaged path `/usr/lib/chatgpt/resources/codex`, desktop-managed user paths, explicit `CODEX_CLI_PATH` / `CODEX_BIN`, and `PATH` fallback.

App Server threads use the current wire values `sandbox: "workspace-write"`, `"read-only"`, or `"danger-full-access"`; the control plane accepts legacy camelCase aliases at its own API boundary and emits the official hyphenated values. Threads carry an explicit `modelProvider` and `serviceName`. Official model pickers are populated by paginated `model/list` rather than a hard-coded model list. The local gateway also answers Codex's native custom-provider catalog request (`/v1/models?client_version=...`) with the internal `models` envelope, while keeping ordinary OpenAI-compatible `/v1/models` responses unchanged.

## Install

Requirements: official ChatGPT/Codex Linux runtime (or a current Codex binary) and Node.js 20+.

```bash
npm run check
npm test
npm start
```

For a local deployment that survives terminal closure, install the system service from `deploy/codex-worker-delegation.service`, then use `systemctl enable --now codex-worker-delegation`. The service is loopback-only on `127.0.0.1:8788`; `npm run start:local` remains available for environments without systemd.

After configuring a real New API provider on the target Linux machine, run the account-level seal:

```bash
npm run seal:production
```

For CI or long-running terminal sessions, `CWD_SEAL_COMPACT=1` keeps the final report to a pass/fail summary while the stage names remain visible on stderr; `CWD_SEAL_HTTP_TIMEOUT_MS` and `CWD_SEAL_APP_SERVER_TIMEOUT_MS` can bound the corresponding seal layers.

It installs the namespaced provider if needed, checks the packaged Codex runtime, runs the complete third-party model connectivity matrix, verifies the official account before and after a real third-party thread, checks the configured worker route, verifies whether the official Codex `model/list` actually contains the discovered New API IDs, and exits non-zero if any discovered model fails or the official picker integration is absent. It never prints or rewrites API keys or `auth.json`.

Open the loopback Web URL, set and confirm the strong control-plane password, configure New API, select routing and reasoning effort, and press **安装 / 刷新**. The UI is split into independent pages for access protection, provider configuration, routing, model connectivity, and Codex integration. The routing surface intentionally exposes one model for AUTO, Main + Worker for WORKER, and Main only for MAIN. Verifier is an internal read-only check that inherits Worker. Chat-capable New API models are available through the namespaced provider and its native catalog format; embedding/vector models are connectivity-only. New API models do not merge into the signed-in official ChatGPT `openai` picker; the two providers can still run in the same local session through role routing. A concrete effort selected for a third-party model is forwarded through the gateway; `auto` leaves the upstream default in control.

### What `NOT_SEALED` means

`npm run seal:production` is a strict release gate, not a basic health check. It reports `SEALED` only when every discovered New API model passes the connectivity matrix **and** every New API-only ID is present in the real official Codex `model/list` picker, in addition to the account, integration, coexistence, Worker, authentication-preservation, and selector-preservation checks. A real coexistence proof or a real Worker result can pass while the strict seal remains `NOT_SEALED`.

In the latest full run against the configured machine on **2026-08-22**, the strict gate recorded **0/10** New API-only IDs in the official picker and **12/13** model connectivity passes. The official/New API coexistence proof, auth preservation, and selector preservation passed; the real Worker check was intentionally skipped because the active Web mode was `MAIN`. The one failed catalog member was `Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive-IQ4_NL.gguf`, whose upstream returned HTTP 502. These counts are observed machine evidence and must be re-run after changing the upstream model list or active mode.

The plugin-manager installer remains available:

```bash
./scripts/install.sh
```

After installing or refreshing the plugin, start a **new Codex chat/task**. Codex loads bundled MCP servers and lifecycle hooks when a new session starts; an already-open session does not retroactively gain `delegation_status`, `delegate_worker`, or the `PreToolUse` policy. Review and trust the bundled hook when Codex asks. The active approval policy must also permit the `delegate_worker` MCP call; if the policy is `never`, use the normal approval/automatic-review mode that allows this explicit delegation action.

`WORKER` is not a label-only switch. In a loaded and trusted session, it is `DELEGATE` internally: the root is coordination-only, direct Bash/file-edit/local-function calls are denied by `PreToolUse`, and third-party work must return a real `delegate_worker` result with `execution`, `provider`, `model`, `threadId`, `status`, and `taskId`. A Web-panel state or a marker-only route check is not sufficient proof of Worker execution. The control plane automatically reviews `reviewDue=true` from concrete task evidence, renews within the profile cap when safe progress is present, and cancels stalled or exhausted work; the root Main can inspect the evidence or use `worker_extend` / `worker_cancel` as a fallback, never handing this control back to the Web user.

The gateway preserves assistant turns that contain multiple parallel function calls as one Chat Completions `tool_calls` message. A failed provider turn is recorded as `worker.failed` and returned as an error; it is never reported as a completed Worker task.

## Security boundary

- New API keys are encrypted with AES-256-GCM in the project data directory.
- The gateway binds to loopback by default and requires a random local bearer token.
- The Web password protects only this control plane. Logout clears the control-plane session and returns to the dedicated **登录控制面** page; it does not log out ChatGPT or change Codex OAuth.
- The Web API is loopback-only by default. The Web control plane supports a salted scrypt password, HttpOnly SameSite sessions, login throttling, and password rotation. For public binding, set `CWD_REQUIRE_AUTH=1`, provide a bootstrap `CWD_WEB_TOKEN`, and put the service behind HTTPS.
- Provider URLs reject embedded credentials and non-HTTP(S) schemes.
- User-supplied custom `Authorization` headers are rejected.
- `auth.json` stays Codex-owned and is never copied to the third-party provider.
- Verifier App Server threads use the official `read-only` wire value; hook policy also blocks mutation/execution patterns for native verifier roles.

See `docs/SECURITY.md` for details.

## Validation

The repository test suite covers provider URL normalization, model listing, protocol probing, Responses↔Chat translation, gateway behavior, config preservation, App Server protocol, routing/policy, hooks, MCP, state and Web API.

CI additionally:

- tests Node 20/22/24;
- installs the current official `@openai/codex`;
- generates the current App Server JSON schema;
- installs this repository through the official Codex plugin manager;
- runs the real Codex App Server → local Responses gateway → fake chat-only New API E2E;
- downloads and extracts the official ChatGPT Linux `.deb` to validate packaged runtime discovery.

The real-Codex E2E proves that explicit `thread/start(modelProvider="codex_worker_gateway")` can traverse the gateway, auto-detect a chat-only upstream, translate the stream back to Responses, and leave the pre-existing official top-level selector unchanged.

## Repository policy

`main` is the single active branch for this repository. The older `openclaw-worker-delegation` repository is retained only as archived history/reference; this repository is the maintained implementation.

## License

MIT
