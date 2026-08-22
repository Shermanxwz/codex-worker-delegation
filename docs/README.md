# Documentation / 文档中心

## Language / 语言

[中文概览](#中文概览) · [English overview](#english-overview)

---

<a id="中文概览"></a>

## 中文概览

本目录记录 Codex Worker Delegation 的架构、安全边界、生产验收和回滚规则。项目的核心原则是：官方 ChatGPT OAuth 继续由官方 Codex 管理；New API 使用独立的 namespaced provider 和 provider-isolated App Server thread；真实共存以 App Server 线程和前后 account/read 证明，而不是以“模型 ID 出现在列表里”证明。

### 文档索引

| 文档 | 内容 |
|---|---|
| [架构 / Architecture](ARCHITECTURE.md) | 四层架构、AUTO / WORKER / MAIN、Worker / Verifier 路由和进度监督 |
| [安全模型 / Security](SECURITY.md) | OAuth、New API key、Web 密码、loopback、MCP、hook 和 Worker 权限边界 |
| [生产封存 / Production Seal](PRODUCTION_SEAL.md) | CORE、Desktop-native、Archive 的验收条件、安装、回滚和失败解释 |
| [项目主页 / Project README](../README.md) | 面向使用者的中英双语项目介绍、安装和当前能力边界 |

### 重要事实

- MAIN 是锁定模式，不允许通过旧参数或 MCP 请求绕过。
- WORKER 是 Web 对 DELEGATE 的显示名称；只有真实 delegation 或路由测试才会启动 Worker。
- AUTO 和 MAIN 只显示 Main selector；WORKER 显示 Main + Worker，Verifier 继承 Worker。
- 官方 → 官方可以使用 native subagent；任何涉及第三方 provider 的路由都使用显式 provider-isolated App Server thread。
- 官方 Codex model/list 当前不提供足够的第三方 provider binding；项目不会伪造官方下拉框。
- NOT_SEALED 是严格门槛结果，不等同于健康检查失败；每个失败项都必须保留真实证据。

---

<a id="english-overview"></a>

## English overview

This directory documents the architecture, security boundaries, production acceptance, and rollback rules of Codex Worker Delegation. The central rule is simple: official ChatGPT OAuth remains owned by official Codex; New API uses a separate namespaced provider and provider-isolated App Server threads; coexistence is proven by a real App Server turn bracketed by account/read checks, not by a model ID merely appearing in a catalog.

### Documentation index

| Document | Scope |
|---|---|
| [Architecture / 架构](ARCHITECTURE.md) | Four-layer architecture, AUTO / WORKER / MAIN, Worker / Verifier routing, and progress supervision |
| [Security model / 安全模型](SECURITY.md) | OAuth, New API keys, Web password, loopback, MCP, hooks, and Worker permission boundaries |
| [Production seal / 生产封存](PRODUCTION_SEAL.md) | CORE, Desktop-native, and Archive gates, installation, rollback, and failure interpretation |
| [Project README / 项目主页](../README.md) | The user-facing bilingual introduction, installation guide, and current capability boundary |

### Facts that the documents preserve

- MAIN is a hard lock; stale parameters and MCP requests cannot bypass it.
- WORKER is the Web label for DELEGATE; a Worker starts only through real delegation or a route test.
- AUTO and MAIN expose only the Main selector; WORKER exposes Main + Worker, while Verifier inherits Worker.
- Official → Official routes may use native subagents; every route involving a third-party provider uses an explicit provider-isolated App Server thread.
- The current official Codex model/list surface does not provide enough third-party provider binding; the project does not fake the official picker.
- NOT_SEALED is a strict gate result, not the same as a failed health check; every failed item must retain real evidence.
