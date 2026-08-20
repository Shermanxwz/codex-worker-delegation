# Codex Worker Delegation

A Codex-native Linux control plane for **explicit per-role model selection**, native subagent delegation, and third-party OpenAI-compatible model coexistence without replacing the user's official ChatGPT login.

## Design target

This project integrates with the same Codex primitives used by rich Codex clients rather than building a second worker runtime:

- `codex app-server` JSON-RPC for `model/list`, marketplace and plugin installation;
- the Codex universal plugin format (Skill + MCP + Hook);
- native subagents / custom agent roles;
- a local Responses provider that Codex can use beside the built-in `openai` provider;
- a compatibility gateway that detects native `/v1/responses` support and falls back to `/v1/chat/completions` only for endpoint-incompatibility signals.

The built-in `openai` provider, ChatGPT login, `auth.json`, keyring and ChatGPT tokens are outside the project's write set.

## Web control plane

Start the project:

```bash
npm run check
npm test
npm start
```

Open `http://127.0.0.1:8788`.

Everything intended for normal use is available from the Web UI:

1. Configure a New API base URL/key and `Auto`, `Responses`, or `Chat` mode.
2. Refresh model catalogs. Official models come from **`codex app-server model/list`**. Third-party models come from **New API `/v1/models`**.
3. Configure a separate model topology for each delegation mode:
   - `AUTO`: Main + Worker + Verifier;
   - `WORKER / DELEGATE`: Main + Worker + Verifier;
   - `MAIN`: only Main is active and needs user selection; inactive role placeholders never affect the other modes.
4. Every visible role independently chooses either **ChatGPT / Codex official** or **New API third-party**, plus an explicit model id. The UI also shows Codex metadata such as default model, reasoning efforts and Multi-Agent version when available.
5. Click **安装 / 刷新原生集成**. The Web server uses the native App Server marketplace/plugin APIs and then atomically applies the active mode's provider/model topology.
6. Switching mode applies that mode's saved topology. Nothing is hidden behind an implicit worker-model choice.

If a non-standard New API does not implement `/v1/models`, the model input still accepts a manual model id; auto-discovery remains the normal path.

## Model coexistence

Example topology:

```text
WORKER / DELEGATE

Main      -> ChatGPT / Codex -> gpt-5.6-sol
Worker    -> New API         -> third-party-coder
Verifier  -> ChatGPT / Codex -> gpt-5.6-sol
```

Another mode can have a completely different topology:

```text
MAIN

Main      -> New API         -> third-party-reasoner
```

Official selections use the built-in `openai` provider. Third-party selections use only the namespaced `codex_worker_gateway` provider. No logout/login switch is required.

## Protocol routing

Codex currently speaks the Responses wire protocol for custom providers. The gateway therefore always presents a standard `/v1/responses` surface to Codex and adapts the upstream internally:

```text
Codex
  -> http://127.0.0.1:8788/v1/responses
       -> upstream /v1/responses         (native when supported)
       -> upstream /v1/chat/completions  (translated fallback)
```

`protocol=auto` uses the real request. Only endpoint-level incompatibility (for example 404/405/410/501 or an explicit unsupported-route response) triggers Chat Completions fallback. Authentication, quota, model and ordinary validation errors are not silently rerouted. Decisions are cached per model.

Accepted New API URL forms include roots, `/v1`, `/v1/responses`, and `/v1/chat/completions`.

## Native plugin

The repository marketplace lives at `.agents/plugins/marketplace.json` and installs `plugins/codex-worker-delegation`.

The plugin contributes:

- a Skill describing the Web-authoritative delegation behavior;
- a read-only MCP `delegation_status` tool;
- a `PreToolUse` hook that uses Codex's agent identity fields to distinguish root and subagents.

Delegation policy:

| Mode | Root | Subagents |
|---|---|---|
| `AUTO` | normal Codex behavior | native subagents may be used when useful |
| `DELEGATE` | coordination-only tools | body work allowed |
| `MAIN` | performs work directly; spawning blocked | existing subagent tool execution is frozen |

Hook trust remains controlled by Codex/user policy. This project does not bypass it.

## Security boundary

- Web binds to `127.0.0.1` by default. Non-loopback exposure requires `CWD_WEB_TOKEN` and should use TLS in front.
- The upstream API key is encrypted at rest with AES-256-GCM under a local `0600` master key.
- Codex receives a separate random local gateway bearer token, not the New API key.
- `auth.json`, keyring data and the built-in `openai` provider are never written by this project.
- Provider URLs containing embedded credentials are rejected; user-supplied `Authorization` headers are rejected.
- `PreToolUse` is a Codex policy guardrail, not an OS sandbox.

See [`docs/SECURITY.md`](docs/SECURITY.md).

## Verification contract

`npm test` covers protocol normalization/detection, translation, encrypted state, per-mode topology migration, official/third-party role mixing, configuration restoration, real Hook and MCP subprocesses, model catalogs, Web APIs and localhost gateway flows.

GitHub Actions additionally installs **`@openai/codex@latest`** on Ubuntu 24.04 and runs the actual binary through:

```text
codex app-server initialize
  -> model/list
  -> marketplace/add
  -> plugin/install
  -> plugin/installed

codex exec
  -> local Responses gateway
  -> chat-only upstream (404 /responses -> chat fallback)
  -> native Responses upstream (no chat fallback)
  -> 401 upstream (must NOT fall back)
```

The E2E also verifies exact Main selector restoration and byte-for-byte preservation of a valid sentinel `auth.json`.

## Repository map

```text
src/
  codex-app-server.mjs   # native App Server JSON-RPC client
  codex-config.mjs       # isolated provider/role topology integration
  gateway.mjs            # Codex-facing Responses gateway
  provider.mjs           # New API URL, model catalog and protocol detection
  server.mjs             # Web/API control plane
  store.mjs              # v2 mode-specific topology state
public/                   # responsive local Web UI
plugins/                  # universal Codex plugin
scripts/                  # checks, install wrapper, real-Codex E2E

test/                     # unit/process/HTTP integration tests
```

## Requirements

- Linux
- Node.js 20+ (22+ recommended)
- a current Codex build exposing `codex app-server` and the plugin APIs

`CODEX_BIN=/absolute/path/to/codex` can be set when the Linux ChatGPT/Codex installation does not expose `codex` on `PATH`.

## License

MIT.
