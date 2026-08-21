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

- `AUTO`, `DELEGATE`, `MAIN` modes.
- Independent **provider + model** selection for Main / Worker / Verifier in every mode.
- Official model discovery from the running Codex `model/list` API.
- Third-party model discovery from New API `/v1/models`, with manual model ID fallback.
- New API Base URL + key + protocol configuration.
- Per-model protocol probe/cache.
- Install/refresh of the namespaced Codex provider and agent roles.
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

App Server threads use the current wire values `sandbox: "workspace-write"`, `"read-only"`, or `"danger-full-access"`; the control plane accepts legacy camelCase aliases at its own API boundary and emits the official hyphenated values. Threads carry an explicit `modelProvider` and `serviceName`. Official model pickers are populated by paginated `model/list` rather than a hard-coded model list.

## Install

Requirements: official ChatGPT/Codex Linux runtime (or a current Codex binary) and Node.js 20+.

```bash
npm run check
npm test
npm start
```

After configuring a real New API provider on the target Linux machine, run the account-level seal:

```bash
npm run seal:production
```

It installs the namespaced provider if needed, checks the packaged Codex runtime, runs the complete third-party model connectivity matrix, verifies the official account before and after a real third-party thread, checks the configured worker route, and exits non-zero unless the requested core proofs pass. It never prints or rewrites API keys or `auth.json`.

Open the loopback Web URL, set the strong control-plane password, configure New API, select routing, and press **安装 / 刷新**. The routing surface intentionally exposes one model for AUTO, Main + Worker for WORKER, and Main only for MAIN. Verifier is an internal read-only check that inherits Worker. The model section supports one-by-one or batch connectivity tests. Use **真实共存验收** on the real Linux install when you want direct proof that a third-party turn and ChatGPT login coexist in one `CODEX_HOME`.

The plugin-manager installer remains available:

```bash
./scripts/install.sh
```

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
