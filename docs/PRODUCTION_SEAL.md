# Production seal and archival acceptance / 生产封存与归档验收

## 中文概览

生产封存不是一句“能启动”或“测试通过”，而是对一台真实登录的 ChatGPT Linux / Codex 设备执行的分层验收。它分别检查项目控制的核心运行链路、官方 Desktop provider binding，以及最终是否满足归档条件。

真实共存证明、真实第三方 Worker、完整网关链路可以通过，而严格封存仍可能失败。当前官方 model/list 没有足够的第三方 provider binding，或者 New API 目录中有模型返回上游错误时，报告必须保留 NOT_SEALED / NOT_ARCHIVE_READY，而不能隐藏失败或修改官方 selector。

## English overview

Production sealing is not a claim that the service merely starts or that unit tests pass. It is a layered acceptance run on a real signed-in ChatGPT Linux / Codex installation. The layers distinguish the project-controlled runtime, provider-correct official Desktop binding, and final archival readiness.

Real coexistence, a real third-party Worker, and the complete gateway path may pass while the strict seal remains negative. When the current official model/list surface lacks sufficient third-party provider binding, or a model in the New API catalog returns an upstream error, the report must remain NOT_SEALED / NOT_ARCHIVE_READY. Failures are never hidden and official selectors are never rewritten to manufacture a pass.

This document defines the release boundary for `codex-worker-delegation` on the official ChatGPT Linux / bundled Codex runtime. The project does not use “perfect” to mean “no future upstream change can ever happen”. A sealed release means that every project-controlled boundary is reproducible, reversible, fail-closed, and proven against a recorded official Linux package; repository archival additionally requires the current official Desktop model surface to expose provider-correct third-party models rather than a catalog-only fake merge.

## Seal levels

### `CORE_SEALED`

The project-controlled runtime is accepted only when the target signed-in Linux installation proves all of the following in one production-seal run:

- the official ChatGPT Linux bundled Codex/current Codex runtime executes;
- repository static contracts and the complete test suite pass;
- installation goes through the official Codex plugin manager and the plugin is reported installed;
- a New API credential is configured in the encrypted local vault;
- the loopback control plane is healthy;
- the namespaced `codex_worker_gateway` provider is installed without changing the official top-level model/provider selectors;
- `account/read` proves the official account remains a ChatGPT account;
- third-party model discovery works;
- at least the selected real Worker route is usable and the real third-party Worker finishes through the official Codex App Server;
- the real official/New API coexistence proof succeeds before and after the third-party turn;
- `auth.json` remains byte-for-byte unchanged;
- the official top-level model selectors remain unchanged.

Complete connectivity of every model returned by a third-party `/v1/models` catalog is reported separately as `FULL_CATALOG_SEALED` because providers can legitimately advertise models that are unavailable to a particular key, region, quota, or endpoint. A failed catalog member is never hidden; it is an explicit `CATALOG_ADVISORY`.

### `DESKTOP_NATIVE_SEALED`

This is stricter than core routing. It additionally requires the official Codex `model/list` / Desktop model surface to expose the discovered New API-only models with a provider-correct route. The project does not count a third-party model ID that is merely visible but still resolves through the built-in `openai` provider as successful integration.

As long as the official model entries do not provide enough provider binding to guarantee the selected third-party ID routes through `codex_worker_gateway`, this status remains `DESKTOP_NATIVE_NOT_SEALED` even though explicit App Server `thread/start(modelProvider=...)` routing works.

### `ARCHIVE_READY`

`npm run seal:archive` is the final fail-closed gate. It requires, on the same target installation:

1. `npm run validate:deployment` passes;
2. `CORE_SEALED` passes;
3. `DESKTOP_NATIVE_SEALED` passes;
4. the release report has `archiveReady: true`.

If any of these conditions is missing, the command exits non-zero and reports `NOT_ARCHIVE_READY`. Do not archive the repository merely because hosted CI is green or because `CORE_SEALED` is green.

## Reproducible official Linux baseline

`deploy/chatgpt-linux-baseline.json` is the immutable release evidence. It records:

- exact ChatGPT Linux package version;
- exact package SHA-256 and size;
- immutable versioned package URL;
- bundled Codex executable path and version;
- the acceptance claims already demonstrated by CI.

CI has two separate jobs:

- **ChatGPT Linux baseline** downloads the versioned package, verifies the SHA-256 and package version, executes the bundled Codex, generates the live App Server schema, installs this plugin through the bundled official plugin manager, and completes a real explicit-provider cross-provider E2E.
- **ChatGPT Linux latest** downloads the mutable `latest` package and repeats the real E2E as a forward-compatibility canary.

Never replace the baseline merely because `latest` moved. Promote a new baseline only after the new package independently passes the full baseline job; preserve the old baseline evidence in git history.

## Production installation

Run installation as the same non-root desktop user that owns the ChatGPT/Codex login:

```bash
npm run install:linux
```

The installer:

1. validates Node.js 20+ and discovers the official Linux bundled Codex/current Codex;
2. runs `npm run check` and the complete test suite before touching the installed release;
3. installs a versioned release under the user data directory;
4. keeps stable `current` and `previous` trees for deterministic plugin-manager source paths and rollback;
5. renders a systemd **user** service for the actual installation root;
6. pins the service to the validated Node executable through `runtime/node`;
7. starts the loopback control plane;
8. installs the plugin through the official Codex plugin manager;
9. installs only the namespaced provider and worker/verifier role files;
10. compares the SHA-256 of `auth.json` before and after installation;
11. records the active release, Codex version, Node version, and auth snapshot in `install-record.json` mode `0600`.

An install failure restores the previous release instead of leaving a half-upgraded `current` tree.

## Systemd boundary

The production service is a user unit rather than a root service because the control plane must deliberately share the same Unix identity and `~/.codex` account state as the signed-in ChatGPT desktop user.

It binds only to loopback by default and includes `NoNewPrivileges`, `PrivateTmp`, kernel/control-group hardening, capability removal, and address-family restrictions. `ProtectSystem=full` is deliberate: `ProtectSystem=strict` would also make ordinary user workspace paths read-only to the service and therefore break legitimate Codex `workspace-write` Worker execution. OS-level Codex sandbox and workspace permissions remain the execution boundary for delegated code.

## Fail-closed policy

The plugin `PreToolUse` hook denies tool execution when:

- the delegation state file is missing;
- the state is malformed;
- the mode is unknown;
- the loopback control plane health check fails or times out;
- the policy hook itself throws;
- the shell launcher cannot find a Node.js 20+ runtime.

A test-only `CWD_HOOK_REQUIRE_CONTROL_PLANE=0` escape hatch exists so unit tests can isolate policy semantics. It must not be configured in production.

Terminal Worker state is not exposed to callers until its matching task snapshot has completed the queued atomic disk write. Therefore a caller cannot receive `completed` while crash-recovery storage still contains `running`.

## Upgrade and rollback

Upgrade by running the same installer from the new source tree:

```bash
npm run install:linux
npm run validate:deployment
```

Rollback swaps the complete `current` and `previous` trees, re-renders the systemd unit, refreshes the Codex plugin from the restored stable source tree, verifies `auth.json`, updates the install record, and leaves the former release available for a reverse rollback:

```bash
npm run rollback:linux
npm run validate:deployment
```

## Uninstall

```bash
npm run uninstall:linux
```

Uninstall removes only the managed Codex provider/roles, plugin registration, service, and installed code. It verifies that `auth.json` is unchanged. Encrypted provider/audit data is retained by default for recovery; set `CWD_PURGE_DATA=1` only when intentional data destruction is desired.

## Target-machine acceptance sequence

After the Web UI has a real New API provider and Worker route configured on the signed-in Linux account, run:

```bash
npm run validate:deployment
npm run seal:production
npm run seal:release
npm run seal:archive
```

Interpret the result literally:

- `CORE_NOT_SEALED`: a project-controlled requirement is still failing; fix it before release.
- `CORE_SEALED` + `DESKTOP_NATIVE_NOT_SEALED`: runtime integration is production-grade, but the official Desktop picker is not yet provider-correct; do not archive.
- `CORE_SEALED` + `DESKTOP_NATIVE_SEALED` + `ARCHIVE_READY`: the repository has reached the defined archival gate for that exact signed-in Linux environment and recorded baseline.

## What hosted CI cannot impersonate

Hosted CI can prove the official `.deb`, bundled Codex executable, official plugin manager, App Server schema, gateway translation, worker lifecycle, installation/upgrade/rollback/uninstall, permissions, and an isolated real Codex E2E. It intentionally cannot copy a user's private ChatGPT OAuth state or production New API secret. `account/read` on the real signed-in desktop account and the real provider credential are therefore target-machine acceptance evidence and are never replaced with CI secrets or fabricated fixtures.
