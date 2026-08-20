# Security model

- The control plane binds to `127.0.0.1` by default. A non-loopback deployment should set `CWD_WEB_TOKEN` and place a TLS reverse proxy in front.
- Upstream API keys are AES-256-GCM encrypted at rest with a 32-byte local key stored mode `0600`.
- The local Codex gateway uses a separate random bearer token stored mode `0600`. Codex obtains it through command-backed provider auth (`cat <token-file>`), so no third-party key is written to `config.toml`.
- Provider URLs reject embedded credentials. Custom `Authorization` headers are rejected by the Web API.
- `auth.json`, keyring data, built-in provider definitions, `chatgpt_base_url`, and OpenAI login state are not written by this project.
- Codex `PreToolUse` hooks are a guardrail, not an OS sandbox. Use Codex sandbox/approval policy for process and filesystem isolation.
- A hook definition must be reviewed/trusted by the user in Codex before control effects apply. This project does not bypass Codex hook trust.
