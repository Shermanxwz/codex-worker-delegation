# Architecture

## Principle

Codex Worker Delegation composes with Codex rather than replacing its orchestration. Codex owns threads, native subagents, tool execution and plugin runtime. This project owns only user-visible delegation policy, explicit model topology, third-party protocol adaptation and local configuration.

## Control surfaces

1. **Web control plane** stores an independent Main/Worker/Verifier topology for `AUTO`, `DELEGATE` and `MAIN`.
2. **Codex App Server client** uses the current rich-client JSON-RPC surface. `model/list` is the source of truth for the currently available Codex catalog; marketplace/plugin endpoints install the bundled plugin.
3. **Codex config integration** adds a single namespaced Responses provider and two custom agent-role files. Each role file selects either the built-in `openai` provider or the namespaced gateway provider.
4. **Responses compatibility gateway** accepts Codex Responses requests and either forwards `/v1/responses` or translates to `/v1/chat/completions`.
5. **Universal plugin** contributes the delegation Skill, a redacted status MCP tool and the `PreToolUse` policy hook.

## Mode-specific topology

Profiles are not global. Example:

```text
AUTO
  Main=official/A
  Worker=third_party/B
  Verifier=official/A

DELEGATE
  Main=official/C
  Worker=third_party/D
  Verifier=third_party/E

MAIN
  Main=third_party/F
```

Switching mode applies the saved profile atomically. In `MAIN`, only Main is active; if inactive Worker/Verifier placeholders have never been configured they inherit Main solely to keep generated role files valid. This does not mutate the independent `AUTO` or `DELEGATE` profiles.

## Official model catalog

The Web server starts a short-lived `codex app-server --stdio` client, performs the documented initialize/initialized handshake, and pages `model/list`. When the user's Codex session has ChatGPT authentication, Codex itself controls its online model catalog; the project does not scrape the UI or maintain a hard-coded model list.

## Provider coexistence

Official selections always reference the built-in `openai` provider. Third-party selections reference `codex_worker_gateway`. The project never redefines `openai`, writes ChatGPT credentials, or sends the New API key to Codex.

## Protocol detection

For `auto`, the first real request for a model goes to upstream `/v1/responses`. Only endpoint-incompatibility signals allow fallback. The result is cached per model. 401/authentication, quota, model and ordinary validation errors remain Responses errors and do not probe Chat Completions.
