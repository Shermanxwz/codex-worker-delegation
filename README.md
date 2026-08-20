# Codex Worker Delegation

**Linux ChatGPT / Codex native subagent control plane + third-party model coexistence gateway.**

This repository is a Codex-native redesign of `openclaw-worker-delegation`. It deliberately does **not** recreate a parallel “worker framework”. Current Codex already has native Subagents / Multi-Agent V2, custom agent roles, plugin skills, MCP servers, hooks, and a plugin marketplace. This project composes with those primitives instead.

## What it gives you

- **Official ChatGPT login stays intact.** The built-in `openai` provider, `auth.json`, OS keyring, ChatGPT backend URL, and official credentials are outside this project's write set.
- **Official and third-party models coexist.** Keep the root Codex thread on official ChatGPT while `cwd-worker` / `cwd-verifier` use your New API, or switch the root to the third-party gateway from the Web UI and restore the original official selection with one click.
- **Automatic protocol routing.** Codex itself speaks the current supported Responses wire API. The local gateway accepts `/v1/responses`, forwards native Responses providers directly, or automatically converts to `/v1/chat/completions` when the upstream model only exposes Chat Completions.
- **Per-model detection cache.** `auto` detection is model-scoped. Endpoint-not-supported errors trigger chat fallback; authentication, quota, model, and validation errors are not silently misclassified.
- **Native Codex workers.** The plugin uses current native `spawn_agent` / subagent orchestration, custom `cwd-worker` and `cwd-verifier` roles, and a skill that tells Codex when to use them.
- **Native policy hook.** `PreToolUse` receives Codex's actual `agent_id` / `agent_type`, so the root and subagents can be governed differently.
- **Simple local Web UI.** Mode selection, New API URL/key/model settings, live protocol probe, integration install/refresh, third-party Main activation, and official-Main restore are all in one page.
- **No third-party runtime dependencies.** Node.js only.

## Delegation modes

| Mode | Root agent | Native subagents |
|---|---|---|
| `AUTO` | Normal Codex behavior | Codex/skill may spawn workers when useful |
| `DELEGATE` | Coordination tools only | Body-work is allowed; use `cwd-worker`, `explorer`, `cwd-verifier` |
| `MAIN` | Performs work directly; new spawn is blocked | Existing subagent tool execution is frozen |

The Web panel is authoritative. The skill explicitly tells the model not to change mode just to bypass a denied tool.

## Architecture

```text
Linux ChatGPT / Codex
        |
        | universal plugin
        |-- Skill: native delegation guidance
        |-- MCP: read-only delegation_status
        `-- PreToolUse hook: root/subagent policy
        |
        | Codex Responses wire API
        v
127.0.0.1:8788
Codex Worker Delegation
        |-- Web control plane
        |-- encrypted local state
        |-- namespaced Codex config integration
        `-- /v1/responses compatibility gateway
                  |
                  | protocol=auto
                  |-- native /v1/responses  -> pass-through
                  `-- /v1/chat/completions -> Responses translation
                                      |
                                      v
                                  Your New API
```

## Install

Requirements: Linux, Node.js 20+ (Node 22+ recommended), and a current Codex build with the plugin commands.

```bash
git clone https://github.com/Shermanxwz/codex-worker-delegation.git
cd codex-worker-delegation
npm run check
npm test
./scripts/install.sh
npm start
```

Then open `http://127.0.0.1:8788`:

1. Enter your New API base URL. Root URLs, `/v1`, `/v1/responses`, and `/v1/chat/completions` forms are normalized.
2. Enter the API key once, choose `Auto`, and set Main / Worker / Verifier model names.
3. Save, then click **真实探测 Worker 模型** if you want an explicit live capability probe.
4. Click **安装/刷新原生集成**. This adds only `model_providers.codex_worker_gateway` and the `cwd-worker` / `cwd-verifier` roles.
5. Keep Main on official ChatGPT (recommended) or click **Main 使用第三方**. **Main 恢复官方 ChatGPT** restores the original top-level provider/model values captured at install time.
6. When Codex asks you to review the bundled hook, review and trust it if you want `DELEGATE` / `MAIN` tool enforcement. The project never bypasses Codex hook trust.

### New API examples

All of these are accepted as the base URL:

```text
https://new-api.example.com
https://new-api.example.com/v1
https://new-api.example.com/v1/responses
https://new-api.example.com/v1/chat/completions
```

`protocol = auto` first uses the *real Codex request* against Responses. Only an endpoint-level unsupported signal falls back to Chat Completions, then the choice is cached for that model.

## Official login isolation

The generated Codex integration looks conceptually like this:

```toml
[model_providers.codex_worker_gateway]
base_url = "http://127.0.0.1:8788/v1"
wire_api = "responses"

[model_providers.codex_worker_gateway.auth]
command = "cat"
args = ["~/.local/share/codex-worker-delegation/gateway.token"]
```

The local bearer token is **not** your New API key. Your upstream key is AES-256-GCM encrypted in the project's private data directory. The third-party key is never written to Codex config.

Custom agent role files select the gateway independently, which is what makes this possible:

```text
Official ChatGPT root thread
        +
third-party cwd-worker subagent
        +
third-party cwd-verifier subagent
```

No logout/login switch is required.

## Tests and verification

Local test suite currently exercises:

- URL/endpoint normalization;
- native Responses detection;
- chat-only fallback without masking auth/model errors;
- Responses -> Chat request translation;
- Chat SSE -> Codex Responses SSE text and function-call output;
- encrypted Web provider storage;
- Codex config preservation and exact official provider/model restoration;
- real standalone hook process behavior for root vs subagent;
- bundled MCP initialize/list/call flow;
- full localhost HTTP E2E for native Responses and chat-only upstreams;
- gateway bearer authentication.

GitHub Actions additionally installs the **current official `@openai/codex` package**, installs this repository through the **official Codex marketplace/plugin manager**, and runs a real:

```text
codex exec
  -> codex_worker_gateway /v1/responses
  -> automatic 404 capability fallback
  -> fake chat-only /v1/chat/completions upstream
  -> translated Responses SSE
  -> Codex final output
```

This is intentionally separate from the unit suite so the repository validates both its own logic and the current Codex integration contract.

## Security boundary

Read [`docs/SECURITY.md`](docs/SECURITY.md). Important limitations:

- `PreToolUse` is a Codex hook guardrail, not an OS sandbox.
- Hosted/specialized tools that do not participate in `PreToolUse` cannot be blocked by this hook.
- A compromised local user/process with access to the project's `0600` files is outside this control plane's threat model.
- Non-loopback Web exposure requires `CWD_WEB_TOKEN` and should be behind TLS.

## Repository map

```text
src/                    # control plane, vault, gateway, config integration
public/                 # small responsive Web UI
plugins/
  codex-worker-delegation/
    .codex-plugin/      # universal plugin manifest
    skills/             # native delegation skill
    hooks/              # PreToolUse policy hook
    mcp/                # read-only status MCP server
.agents/plugins/        # repo-local Codex marketplace
scripts/                # install, checks, real-Codex E2E
test/                   # unit + process + HTTP integration tests
docs/                   # architecture and security boundary
```

## Why this is different from the OpenClaw version

The old project needed an external controller to create and police a worker abstraction. Current Codex already owns agent spawning, context forking, role selection, model overrides, follow-up messaging, waiting, interruption, and agent lifecycle. Reusing those mechanisms is more native, more visible inside the ChatGPT/Codex UI, and less likely to drift as Codex evolves.

This project therefore owns only the pieces Codex does not natively solve for this use case: **user-controlled delegation policy, provider coexistence, third-party protocol adaptation, secure local configuration, and a simple Web control plane.**

## License

MIT.
