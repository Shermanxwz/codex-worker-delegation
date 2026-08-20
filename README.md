# Codex Worker Delegation

Native delegation control plane for the official **ChatGPT Linux / Codex desktop runtime**, with official ChatGPT authentication and third-party OpenAI-compatible models coexisting at the same time.

## v2 architecture

The project no longer treats provider switching as login switching.

```text
ChatGPT Linux Desktop / Codex
        |
        | official Codex app-server + plugin surfaces
        v
Codex Worker Delegation
        |
        +-- Official ChatGPT provider (`openai`)
        |     `-- existing ChatGPT OAuth / auth.json stays owned by Codex
        |
        `-- Third-party provider (`codex_worker_gateway`)
              `-- local Responses gateway
                    |-- native /v1/responses when supported
                    `-- /v1/chat/completions compatibility bridge when needed
```

**The third-party provider does not replace the built-in `openai` provider and does not require logging out of ChatGPT.** Its API key is encrypted in this project's local vault. Codex receives only a generated local bearer token through `[model_providers.codex_worker_gateway.auth]`.

## Worker execution model

Current Codex supports model overrides for native `spawn_agent`, but a spawned child inherits the parent's model provider. Therefore v2 uses two explicit execution paths instead of pretending cross-provider workers are native children:

| Main provider vs worker provider | Execution path |
|---|---|
| Same provider | Codex Native Subagent (`spawn_agent`, `cwd-worker`, `cwd-verifier`) |
| Different provider | Codex App Server provider-specific Worker Thread (`thread/start.modelProvider`) |

The Web UI labels this provenance as **Native Subagent** or **Cross-provider Thread**.

## Web control plane

The Web panel controls all three modes independently:

- `AUTO`
- `DELEGATE`
- `MAIN`

For every mode, select provider + model separately for:

- Main
- Worker
- Verifier

Official models are loaded from the running Codex `model/list` API. Third-party models are loaded from the configured New API `/v1/models` endpoint. Manual model IDs remain available for providers that do not expose a model catalog.

## Protocol auto-detection

Codex itself now expects Responses wire format for custom providers. The local gateway therefore always exposes `/v1/responses` to Codex and adapts the upstream provider per model:

1. Try upstream `/v1/responses`.
2. Cache native Responses support when successful.
3. Fall back to `/v1/chat/completions` only when the Responses endpoint is actually unsupported.
4. Do **not** misclassify authentication, quota, validation, or missing-model errors as a chat-only provider.
5. Translate streaming text, function calls, tool outputs, and usage back to Codex-consumable Responses events.

## Install

Requirements:

- Official ChatGPT/Codex Linux runtime or current Codex binary
- Node.js 20+
- A New API / OpenAI-compatible endpoint if third-party routing is desired

```bash
npm run check
npm test
npm start
```

Open the printed loopback Web URL, configure New API if needed, choose the routing matrix, and press **Install / Refresh**.

The install action:

- adds only `model_providers.codex_worker_gateway` to `~/.codex/config.toml`;
- writes current auto-discovered roles to `~/.codex/agents/cwd-worker.toml` and `~/.codex/agents/cwd-verifier.toml`;
- generates a local gateway bearer token;
- does not write the upstream API key into Codex config;
- does not modify `auth.json`;
- does not replace the top-level `model_provider` or `model` selector.

The repository also remains installable through the Codex plugin manager:

```bash
./scripts/install.sh
```

## Modes

### AUTO

Codex can keep light work on Main and delegate substantial/separable work. The selected Main/Worker/Verifier routing remains visible in the Web panel.

### DELEGATE

Main is coordination-only. The PreToolUse hook blocks body-work tools on the root thread while allowing native agent coordination and the bundled cross-provider `delegate_worker` MCP tool.

### MAIN

Main performs the work directly. New native subagents and cross-provider worker delegation are blocked.

## Security boundary

- New API keys are encrypted with AES-256-GCM in the project data directory.
- The gateway binds to loopback by default.
- Codex authenticates to the gateway with a random local token.
- The Web API is loopback-only unless `CWD_WEB_TOKEN` is configured.
- Provider URLs reject embedded credentials and non-HTTP(S) schemes.
- Custom Authorization headers supplied through provider metadata are rejected.
- Verifier mutation/execution tools are blocked by policy.
- The project never needs to copy ChatGPT OAuth tokens into a third-party provider.

See `docs/SECURITY.md` for threat boundaries.

## Validation

`npm test` covers the gateway, Responses↔Chat translation, hook enforcement, MCP server, configuration migration, v2 routing, Web API, and an app-server protocol harness.

CI additionally installs the current official `@openai/codex` and runs `scripts/real-codex-e2e.mjs`, which proves the real flow:

```text
real codex app-server
  -> thread/start(modelProvider="codex_worker_gateway")
  -> local /v1/responses gateway
  -> fake chat-only New API
  -> /v1/responses rejected as unsupported
  -> automatic /v1/chat/completions bridge
  -> Responses stream returned to Codex
```

The E2E also asserts that the pre-existing official top-level selector is preserved and no `auth.json` is created or rewritten by this project.

## Repository layout

```text
src/
  app-server.mjs      Codex app-server JSON-RPC client and Linux binary discovery
  codex-config.mjs    isolated provider + current ~/.codex/agents role installation
  gateway.mjs         local Responses gateway
  provider.mjs        New API endpoints, model catalog, protocol probing
  server.mjs          Web/control/internal worker API
  store.mjs           v2 mode/role/provider/model state

plugins/codex-worker-delegation/
  hooks/              DELEGATE / MAIN enforcement
  mcp/                status + cross-provider delegate_worker
  skills/             routing instructions for Codex

public/                Web routing control plane
test/                  unit/integration tests
scripts/real-codex-e2e.mjs
```

## License

MIT
