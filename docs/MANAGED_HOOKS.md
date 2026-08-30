# System-managed Worker enforcement / 系统级 Worker 强制执行

## Purpose / 目的

The normal plugin hook is part of the project payload. This document describes the stronger, system-managed deployment profile: Codex reads a root-owned `requirements.toml`, and every `PreToolUse` event is routed through a fail-closed bridge before the project policy is allowed to decide.

普通插件 Hook 属于项目 payload。本文件描述更强的系统级部署配置：Codex 读取 root-owned 的 `requirements.toml`，所有 `PreToolUse` 事件先经过 fail-closed bridge，再交给项目 policy 决策。

This layer is intentionally a deployment artifact, not an implicit behavior of every source checkout. It is explicit because it writes `/etc/codex` (or another managed directory) and changes the host-wide Codex hook boundary.

这层是明确的部署配置，不是每个源码 checkout 的隐式行为。因为它会写入 `/etc/codex`（或指定的 managed directory），并改变整台机器的 Codex Hook 边界，所以必须由管理员显式安装。

## What it enforces / 它强制什么

- `allow_managed_hooks_only = true` makes the managed requirements file the only accepted hook source.
- The wrapper pins the control-plane URL to loopback, requires `CWD_HOOK_REQUIRE_CONTROL_PLANE=1`, and uses Node 20+.
- Missing policy files, missing data directory, unavailable Node, a failed bridge, or failed project policy produce a deny decision instead of silently allowing the tool call.
- `OFFICIAL` remains native/dormant inside the project policy. The managed layer does not replace official model, tool, or multi-agent behavior; it only makes the project policy entry point authoritative when the project-controlled mode is active.
- `AUTO`, `DELEGATE` / `WORKER`, and `MAIN` continue through the same server-side mode, OAuth, provider, capability, sandbox, and Worker-role checks.

## Install / 安装

First install or upgrade the project release. Then run the managed-hook installer from the active release tree:

先安装或升级项目 release，再从 active release tree 执行 managed-hook 安装器：

```bash
cd /absolute/path/to/deployment-root/current
sudo env \
  CWD_INSTALL_ROOT=/absolute/path/to/deployment-root \
  CWD_DATA_DIR=/absolute/path/to/worker-data \
  npm run install:managed-hooks
sudo env \
  CWD_INSTALL_ROOT=/absolute/path/to/deployment-root \
  CWD_DATA_DIR=/absolute/path/to/worker-data \
  npm run validate:managed-hooks
```

`CWD_INSTALL_ROOT` must point to the release parent containing `current/`; `CWD_DATA_DIR` must be the data directory used by the running control plane. The installer refuses to overwrite unmarked files. To migrate an existing manually-created `/etc/codex` overlay, set `CWD_MANAGED_HOOKS_ADOPT=1`; the installer backs up the three known files before replacing them.

`CWD_INSTALL_ROOT` 必须指向包含 `current/` 的 release parent；`CWD_DATA_DIR` 必须是正在运行的控制面的数据目录。安装器不会覆盖没有项目 ownership marker 的文件。迁移已有手工创建的 `/etc/codex` overlay 时，设置 `CWD_MANAGED_HOOKS_ADOPT=1`；安装器会先备份已知的三个文件再替换。

The installer is idempotent and records only non-secret paths in `.codex-worker-delegation-managed`. It never copies API keys, Web passwords, OAuth state, `auth.json`, or Worker task state into Git or the managed hook directory.

安装器可重复执行，并在 `.codex-worker-delegation-managed` 中只记录不含 secret 的路径。它不会把 API key、Web 密码、OAuth 状态、`auth.json` 或 Worker task state 复制到 Git 或 managed hook directory。

## Validate / 验证

```bash
sudo env CWD_INSTALL_ROOT=/absolute/path/to/deployment-root \
  CWD_DATA_DIR=/absolute/path/to/worker-data \
  npm run validate:managed-hooks
```

The validator checks ownership, generated paths, file modes, managed-hook requirements, control-plane pinning, Node version, shell syntax, and JavaScript syntax. It does not create a task or call a model; real Worker/App Server E2E remains part of the normal production acceptance flow.

验证器会检查 ownership、生成路径、文件权限、managed-hook requirements、控制面 pinning、Node 版本、Shell 语法和 JavaScript 语法。它不会创建任务或调用模型；真实 Worker/App Server E2E 仍属于正常生产验收流程。

## Remove / 卸载

```bash
sudo env CWD_MANAGED_HOOKS_DIR=/etc/codex npm run uninstall:managed-hooks
```

Uninstall removes only files carrying this project marker. If adoption created backups, the original files are restored. An unmarked or modified target stops the operation rather than being deleted.

卸载只会删除带有本项目 marker 的文件。如果迁移时创建了备份，会恢复原文件；目标文件未标记或已被外部修改时，卸载会停止而不会删除它。

## Release and host boundary / Release 与主机边界

The source repository contains templates and installers, not the host's rendered `/etc/codex` files. A release update must be followed by `npm run validate:managed-hooks`; if the release path changes, rerun the installer so the wrapper points at the new `current` tree. The active local machine may keep a separate system overlay, but that overlay is now reproducible from these versioned assets.

源码仓库保存的是模板和安装器，不保存主机上已经渲染的 `/etc/codex` 文件。升级 release 后应重新执行 `npm run validate:managed-hooks`；如果 release path 变化，应重新安装，使 wrapper 指向新的 `current` tree。当前本机可以继续保留独立的 system overlay，但这层现在可以由版本化资产重复生成。
