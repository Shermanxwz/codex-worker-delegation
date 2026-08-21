# Codex Worker Delegation

A Codex-native local control plane for the official **ChatGPT Linux desktop / Codex runtime**. It keeps Codex-owned ChatGPT authentication intact while adding a separate New API / OpenAI-compatible provider, explicit per-role model routing, current App Server integration, and a Responses compatibility gateway.

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

The project **never needs to replace the top-level `model_provider`, rewrite `auth.json`, or log ChatGPT out**. Provider and model are chosen when a new Codex thread is created. The Web panel can prove coexistence on the actual machine by running:

```text
account/read (ChatGPT)
  -> thread/start(modelProvider="codex_worker_gateway")
  -> a real third-party model turn
  -> account/read (ChatGPT)
  -> verify top-level model_provider/model stayed unchanged
```

## Worker policy aligned with current Codex

Current Codex releases enable subagent workflows and support custom agent models. However, 2026 custom-provider Multi-Agent V2 builds have reproducible failures where native `spawn_agent` payloads reach non-OpenAI providers as provider-specific `agent_message` / `encrypted_content` and can arrive empty.

v3 therefore fails safe:

| Main route | Worker/Verifier route | Execution |
|---|---|---|
| Official ChatGPT | Official ChatGPT | **Native Subagent** (`cwd-worker` / `cwd-verifier`) |
| Official ChatGPT | New API | **Cross-provider App Server Thread** |
| New API | Official ChatGPT | **Cross-provider App Server Thread** |
| New API | New API | **Provider-isolated App Server Thread** |

Third-party → third-party intentionally uses an independent App Server thread instead of native spawn until upstream custom-provider subagent transport is reliable. This is visible in Web/MCP results; the project does not fake native-subagent provenance.

## Web control plane

The Web UI owns all normal operations:

- `AUTO`, `WORKER` (`DELEGATE` internally), `MAIN` modes.
- Compact routing selection: AUTO exposes one Main model, WORKER exposes Main + Worker, and MAIN exposes one Main model.
- Verifier is an internal read-only role that inherits Worker and never gets a separate model selector.
- Official model discovery from the running Codex `model/list` API.
- Third-party model discovery from New API `/v1/models`, with manual model ID fallback.
- New API Base URL + key + protocol configuration.
- Per-model protocol probe/cache.
- Install/refresh of the namespaced Codex provider and agent roles.
- Per-route reasoning effort selection with `auto` plus the effort levels advertised by the selected official model; explicit values are sent as native App Server `turn/start.effort`.
- Independent jump pages for access protection, New API configuration, model routing, model connectivity, and Codex integration.
- **真实共存验收** runtime proof.
- Real route execution for Worker / Verifier.

## New API endpoint normalization and protocol detection

The Base URL may be entered as a service root, `/v1`, `/v1/responses`, `/v1/chat/completions`, or `/v1/models`. The control plane derives the related endpoints.

Codex custom providers currently use the Responses wire API, so Codex always talks to this project's local `/v1/responses` gateway. With `protocol=auto`, the gateway decides **per model**:

1. Try upstream `/v1/responses`.
2. Cache `responses` on success.
3. Fall back to `/v1/chat/completions` only when the Responses route is genuinely unsupported.
4. Never reinterpret authentication, quota, validation, or missing-model failures as “chat-only”.
5. Translate streaming text, tools, tool outputs, and usage back to Responses semantics.

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

It installs the namespaced provider if needed, checks the packaged Codex runtime, runs the complete third-party model connectivity matrix, verifies the official account before and after a real third-party thread, checks the configured worker route, and exits non-zero unless the requested core proofs pass. It never prints or rewrites API keys or `auth.json`.

Open the loopback Web URL, set and confirm the strong control-plane password, configure New API, select routing and reasoning effort, and press **安装 / 刷新**. The UI is split into independent pages for access protection, provider configuration, routing, model connectivity, and Codex integration. The routing surface intentionally exposes one model for AUTO, Main + Worker for WORKER, and Main only for MAIN. Verifier is an internal read-only check that inherits Worker. New API models are available through the namespaced provider and its native catalog format, but they do not merge into the signed-in official ChatGPT `openai` picker; the two providers can still run in the same local session through role routing. A concrete effort selected for a third-party model is forwarded through the gateway; `auto` leaves the upstream default in control.

The plugin-manager installer remains available:

```bash
./scripts/install.sh
```

After installing or refreshing the plugin, start a **new Codex chat/task**. Codex loads bundled MCP servers and lifecycle hooks when a new session starts; an already-open session does not retroactively gain `delegation_status`, `delegate_worker`, or the `PreToolUse` policy. Review and trust the bundled hook when Codex asks. The active approval policy must also permit the `delegate_worker` MCP call; if the policy is `never`, use the normal approval/automatic-review mode that allows this explicit delegation action.

`WORKER` is not a label-only switch. In a loaded and trusted session, it is `DELEGATE` internally: the root is coordination-only, direct Bash/file-edit/local-function calls are denied by `PreToolUse`, and third-party work must return a real `delegate_worker` result with `execution`, `provider`, `model`, `threadId`, and `status`. A Web-panel state or a marker-only route check is not sufficient proof of Worker execution.

The gateway preserves assistant turns that contain multiple parallel function calls as one Chat Completions `tool_calls` message. A failed provider turn is recorded as `worker.failed` and returned as an error; it is never reported as a completed Worker task.

## Security boundary

- New API keys are encrypted with AES-256-GCM in the project data directory.
- The gateway binds to loopback by default and requires a random local bearer token.
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
