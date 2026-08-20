# Security model

- The control plane binds to loopback by default. A non-loopback deployment should set `CWD_WEB_TOKEN` and use a TLS reverse proxy.
- Upstream API keys are AES-256-GCM encrypted at rest. The encryption key and generated gateway token are stored with mode `0600` in the project data directory.
- The local Codex provider authenticates to the gateway with the separate gateway token. The New API key is never written to Codex configuration.
- Provider URLs with embedded username/password credentials are rejected. Web API custom headers cannot override `Authorization`.
- `auth.json`, OS keyring state, built-in provider definitions and ChatGPT tokens are outside the project's write set. Tests include byte-for-byte `auth.json` preservation and exact restoration of the pre-install top-level Main selector.
- App Server operations are short-lived subprocesses and have explicit request timeouts. Codex-facing provider retries are disabled because gateway/upstream behavior should be diagnosed in one layer rather than multiplied by Codex retries.
- `PreToolUse` hooks are guardrails, not an OS security boundary. Codex sandbox/approval policy remains the process/filesystem boundary.
- Hook trust is intentionally left to Codex. The project does not auto-trust itself or bypass hook review.
