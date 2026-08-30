# Documentation / 文档中心

## 中文概览

本目录记录 Codex Worker Delegation 3.2 的架构、安全边界、生产验收和归档规则。

核心事实：

- `OFFICIAL` 是插件休眠态，行为交还当前官方 Codex；
- `AUTO` / `WORKER` / `MAIN` 是项目控制态，继续执行项目自己的 fail-closed policy；
- ChatGPT OAuth 由官方 `account/read` 判定；OAuth 活跃时 Main 在服务端锁定为 Official；
- 无 OAuth 时才允许 Third Party standalone Main；
- 模型和 Reasoning 由统一 Model Capability Registry 校验，项目不再维护固定 reasoning 猜测列表；
- Official -> Official 可走 native subagent；任何涉及第三方 provider 的执行走显式 provider-isolated App Server thread；
- Hosted CI 证明项目可控边界；`ARCHIVE_READY` 必须在真实 signed-in Linux 安装上完成。

## 文档索引

| 文档 | 内容 |
|---|---|
| [架构 / Architecture](ARCHITECTURE.md) | OFFICIAL / AUTO / WORKER / MAIN、OAuth-aware Main、Model Capability Registry、Worker provenance |
| [安全模型 / Security](SECURITY.md) | OAuth、New API key、Web 密码、Hook/MCP、provider/sandbox/Worker 权限边界 |
| [系统级 Worker 强制执行 / Managed Hooks](MANAGED_HOOKS.md) | root-owned requirements、fail-closed bridge、安装/验证/卸载和主机边界 |
| [生产封存 / Production Seal](PRODUCTION_SEAL.md) | Hosted CI、CORE、Desktop-native、Archive 的验收和真实设备边界 |
| [项目主页 / Project README](../README.md) | 面向使用者的中英双语项目说明和安装入口 |

## English overview

This directory documents the 3.2 architecture, security boundaries, production acceptance, and archive rules.

Facts preserved by the documentation:

- `OFFICIAL` is a dormant-plugin mode that defers behavior to the current native Codex runtime.
- `AUTO` / `WORKER` / `MAIN` remain project-controlled fail-closed modes.
- ChatGPT OAuth is detected through official `account/read`; while OAuth is active, Main is server-side locked to Official.
- A third-party standalone Main is allowed only when official OAuth is absent.
- Model and Reasoning validity comes from a unified Model Capability Registry; the project does not guess reasoning levels.
- Official -> Official may use native subagents; every route involving a third-party provider uses explicit provider-isolated App Server execution.
- The optional system-managed hook profile makes the strict Worker policy reproducible without committing host paths or secrets.
- Hosted CI proves project-controlled boundaries; `ARCHIVE_READY` still requires a real signed-in Linux installation.
