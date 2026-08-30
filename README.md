# Codex Worker Delegation

## Language / 语言

[中文](#中文介绍) · [English](#english)

---

<a id="中文介绍"></a>

# 中文介绍

Codex Worker Delegation 是面向官方 ChatGPT Linux / Codex runtime 的本地控制平面。它不替代 ChatGPT，也不伪造官方模型；它把官方 ChatGPT OAuth、第三方 New API、按角色路由、Worker / Verifier 生命周期、Responses 兼容和本地 Web 管理放在同一套可验证边界里。

当前 3.2 设计的核心原则是：

> **官方能力交给官方维护，第三方能力显式隔离；认证决定 Main 的合法边界，模型能力决定 Reasoning 的合法边界。**

## 最重要的运行规则

### 1. OFFICIAL：真正的“官方默认”模式

`OFFICIAL` 不是本项目复制一套官方策略，而是让 delegation 插件休眠，把行为交还给当前 Codex runtime：

~~~text
OFFICIAL
  -> native Codex defaults
  -> official model / reasoning defaults
  -> official tool + multi-agent policy
~~~

因此官方后续更新默认模型、reasoning 或 multi-agent 行为时，本项目不需要追着复制。

OFFICIAL 还有一个故障隔离要求：**即使本地 `:8788` 控制平面不可用，也不能因为本插件的 Hook 而阻断官方 Codex。** AUTO / WORKER / MAIN 仍保留 fail-closed 的项目控制边界。

### 2. ChatGPT OAuth 活跃时，Main 永远是 Official

Main 是否允许第三方不是由 UI 猜测，也不是看 `auth.json` 文件是否存在，而是实时读取官方 App Server `account/read`：

~~~text
account/read -> account.type == "chatgpt"
                   |
                   v
         Main Provider = Official (locked)
~~~

锁定由后端再次强制。即使绕过浏览器直接调用管理 API，也不能把 Main 改成第三方。

Worker / Verifier 仍可按合法路由使用第三方 provider，因此“Main 锁官方”不会等于“禁用第三方 Worker”。

### 3. 没有官方 OAuth 时，才开放第三方 Main

未观察到 ChatGPT OAuth 时，Main provider 可以选择 Official 或 Third Party。第三方 Main 不是伪装成官方根线程，而是明确运行成：

~~~text
standalone Main
  -> codex app-server
  -> thread/start(modelProvider="codex_worker_gateway", model=...)
~~~

UI 和审计都保留这个 provenance，不制造“已经切换官方 ChatGPT 根 provider”的错觉。

## 模式

Web 中 `WORKER` 对应内部 `DELEGATE`。

| 模式 | 路由选择 | 实际行为 |
|---|---|---|
| `OFFICIAL` | 不提供项目自定义路由 | 插件休眠，完全跟随当前官方 Codex 默认行为 |
| `AUTO` | Main + Worker + Verifier | Main 正常工作；需要委派时使用各角色独立路由 |
| `WORKER` / `DELEGATE` | Main + Worker + Verifier | Main 协调，Worker 执行；显式启用项目协作策略 |
| `MAIN` | Main | 禁止新的 Worker delegation / native subagent 执行 |

切换到 OFFICIAL 或 MAIN 会取消项目管理中的活动 Worker，避免旧任务继续跨越新的模式边界。

## Model Capability Registry

3.2 不再维护一个全局“模型能力猜测表”。控制平面每次基于真实上游信息建立统一 Registry：

~~~text
Official Codex
  account/read
  model/list
  modelProvider/capabilities/read (可选，旧 Codex 自动兼容)
        \
         -> Model Capability Registry
        /
Third-party New API
  /v1/models
~~~

Registry 以 `(provider, model)` 为粒度保存：

- 模型是否真实存在；
- 默认模型；
- upstream 明确声明的 reasoning options / default；
- 官方 OAuth 状态与 Main provider lock；
- 官方 provider capability（若当前 Codex 支持该接口）。

运行 Worker、保存路由、启动 standalone Main 前都会重新验证 Registry。旧 state 里不存在的模型 ID 不能继续偷偷运行。

## Reasoning：只相信模型声明，不猜

项目已删除固定的全局 reasoning effort 枚举。

如果模型明确声明：

~~~text
low -> medium -> high -> xhigh
~~~

Web 就按这个模型自己的顺序生成滑块。

如果另一模型声明：

~~~text
eco -> balanced -> extreme-plus
~~~

Web 就显示这一套，不要求项目代码认识这些名字。

如果上游没有声明 reasoning capability：

~~~text
Reasoning: Auto
~~~

只有 `Auto`，不会出现“根据模型名猜出来”的档位。

模型切换后会立即重新计算：旧 effort 对新模型不合法时自动回到 `Auto`；后端执行前还会再次验证，防止绕过 UI 注入不支持的 effort。

## 真实执行 provenance

- **Official -> Official**：可以使用 Codex 原生 `cwd-worker` / `cwd-verifier` subagent。
- **任何涉及 third_party**：使用独立 App Server thread，并显式发送 `modelProvider` + `model`。
- **Third-party Main（仅无 OAuth 时）**：使用 standalone provider-isolated App Server thread。
- **Verifier**：第三方 App Server route 强制 `read-only` sandbox；native verifier 还有 Hook 只读约束。

项目不会把第三方线程冒充 native subagent。当前自定义 provider 的 native subagent transport 曾出现任务 payload / encrypted content 不可靠的上游边界，因此显式 App Server thread 是故意的安全设计。

## Worker 生命周期

每个 provider-isolated Worker / Verifier 都有持久化 `wrk_...` task ID，并记录：

- provider / model / role / execution provenance；
- App Server thread / turn ID；
- progress、heartbeat、事件；
- lease / review point / extension；
- 自动监督决策、终态、结构化脱敏错误。

标准任务总运行硬上限 60 分钟；quick 总上限 10 分钟。控制平面根据 meaningful progress + heartbeat 自动续期、给予有限 grace 或 fail-closed 取消。Web 只观察；取消/续期属于 root-control fallback。

## New API 与协议兼容

第三方 credential 使用本地 AES-256-GCM vault 保存。Codex 只拿到独立 gateway bearer token，不读取第三方 API key。

`protocol=auto` 按模型独立判断：

1. 优先 `/v1/responses`；
2. 成功后缓存；
3. 只有明确不支持 Responses 才 fallback `/v1/chat/completions`；
4. auth / quota / missing model / validation 错误不会被误判成 chat-only；
5. Chat Completions 会转换成 Codex 可消费的 Responses 语义。

Embedding / vector 模型只进入连通性测试，不会进入文本生成 Main / Worker 路由。

## 官方模型 Picker 的边界

New API 模型会出现在本地 Web、第三方连通性目录和 namespaced `codex_worker_gateway` provider。

当前官方登录态下的 `model/list` 并不保证第三方 ID 具有 provider-correct binding。项目不会为了“看起来在一个下拉框里”而修改官方顶层 provider 或把第三方 ID 冒充成 `openai` 模型。

真实共存证明是：

~~~text
account/read (ChatGPT)
  -> thread/start(modelProvider="codex_worker_gateway")
  -> real third-party turn
  -> account/read (ChatGPT)
  -> official top-level selectors unchanged
~~~

## Web 控制面

默认地址：

~~~text
http://127.0.0.1:8788/
~~~

主导航只保留高频入口：

- 概览：当前模式、是否生效、Main 是否被 OAuth 锁定；
- New API；
- 模型路由；
- 模型连通性；
- 访问保护。

低频的 Codex 原生集成放在右上角设置抽屉中。

访问保护页面只显示当前状态需要的一套表单：首次设置时显示新密码 + 确认；登录后修改时显示当前密码 + 新密码 + 确认；登录页只有登录密码。Web logout 不会退出 ChatGPT OAuth。

本机开发还可以显式选择“本机免密码”：先确认只绑定 `127.0.0.1` / `::1`，再以 `CWD_HOST=127.0.0.1 CWD_PORT=8789 CWD_REQUIRE_AUTH=0 npm run start:local` 启动，访问保护页会出现本机访问模式选择。该模式只对回环监听生效；公网绑定、systemd 服务和默认 `npm start` 仍强制密码认证。切回密码保护前需要先设置控制面密码。

## 安装与验证

要求：Node.js 20+，以及官方 ChatGPT Linux bundled Codex 或当前 Codex binary。

~~~bash
npm run check
npm test
npm start
~~~

安装本地服务：

~~~bash
npm run install:linux
npm run validate:deployment
~~~

如需把本机“系统级强制 Worker 调度”也纳入可重复部署，请在 active release tree 上显式安装 managed-hook profile：

~~~bash
cd /absolute/path/to/deployment-root/current
sudo env CWD_INSTALL_ROOT=/absolute/path/to/deployment-root \
  CWD_DATA_DIR=/absolute/path/to/worker-data \
  npm run install:managed-hooks
sudo env CWD_INSTALL_ROOT=/absolute/path/to/deployment-root \
  CWD_DATA_DIR=/absolute/path/to/worker-data \
  npm run validate:managed-hooks
~~~

这一步会安装 root-owned `requirements.toml` 和 fail-closed bridge，拒绝未标记文件的静默覆盖；已有手工 `/etc/codex` overlay 需要迁移时，显式设置 `CWD_MANAGED_HOOKS_ADOPT=1`。它不把 token、密码、OAuth 状态、`auth.json` 或 Worker 状态写进仓库。完整说明见 [系统级 Worker 强制执行](docs/MANAGED_HOOKS.md)。`OFFICIAL` 仍然交还官方 Codex；`AUTO` / `WORKER` / `MAIN` 才经过项目控制策略。

真实 signed-in Linux 设备上的严格验收：

~~~bash
npm run seal:production
npm run seal:release
npm run seal:archive
~~~

Hosted CI 可以验证代码、Node 20/22/24、并发压力、当前 Codex、固定 ChatGPT Linux baseline、最新 ChatGPT Linux 包、官方 plugin manager、App Server E2E、user/root 安装升级回滚卸载等项目可控边界。

**`ARCHIVE_READY` 仍然必须在同一台真实 signed-in Linux 安装上通过。** Hosted CI 不会伪造私人 ChatGPT OAuth、真实 New API credential 或官方 Desktop provider binding。

## 文档

- [文档中心 / Documentation](docs/README.md)
- [架构 / Architecture](docs/ARCHITECTURE.md)
- [安全模型 / Security](docs/SECURITY.md)
- [系统级 Worker 强制执行 / Managed Hooks](docs/MANAGED_HOOKS.md)
- [生产封存 / Production Seal](docs/PRODUCTION_SEAL.md)
- [Codex plugin skill](plugins/codex-worker-delegation/skills/codex-worker-delegation/SKILL.md)

## Repository policy

`main` 是唯一维护分支。项目不会通过修改 `auth.json`、伪造官方 selector、猜测模型 capability 或隐藏第三方错误来制造绿色报告。

## License

MIT

---

<a id="english"></a>

# English

Codex Worker Delegation is a local control plane for the official ChatGPT Linux / Codex runtime. It preserves Codex-owned ChatGPT authentication while adding an isolated New API provider, explicit per-role routing, observable Worker / Verifier lifecycles, a Responses compatibility gateway, and a hardened Web control plane.

The 3.2 rule is:

> **Let official Codex own official behavior, isolate third-party execution explicitly, let authentication define the legal Main boundary, and let live model capabilities define the legal Reasoning boundary.**

## Modes

| Mode | Custom routing | Runtime behavior |
|---|---|---|
| `OFFICIAL` | none | Delegation policy becomes dormant and native Codex defaults own model/reasoning/tool/multi-agent behavior |
| `AUTO` | Main + Worker + Verifier | Main works normally and may delegate through independent role routes |
| `WORKER` / `DELEGATE` | Main + Worker + Verifier | Root coordinates; Worker executes under explicit project policy |
| `MAIN` | Main | Project-managed Worker delegation and native subagent execution are disabled |

OFFICIAL is deliberately independent of the `:8788` control-plane health check so a dead delegation service cannot brick native Codex. AUTO / WORKER / MAIN remain fail-closed project-controlled modes.

## OAuth-aware Main policy

The project reads official App Server `account/read` rather than inferring login from files.

When `account.type == "chatgpt"`, Main is server-side locked to the official provider. Direct API calls cannot bypass the lock. Worker / Verifier may still use legal third-party routes.

When no ChatGPT OAuth session is observed, Main may use Official or Third Party. A third-party Main is explicitly a standalone App Server thread with `modelProvider=codex_worker_gateway`; it is never represented as a switched official ChatGPT root.

## Model Capability Registry and Reasoning

The registry combines official `model/list`, optional `modelProvider/capabilities/read`, `account/read`, and third-party `/v1/models`.

The project no longer owns a global reasoning-effort enum. Each model exposes only values explicitly advertised by that model/provider. If no reasoning metadata is advertised, the only UI/runtime-safe value is `Auto`.

Changing the model immediately reconciles effort; an effort not supported by the new model becomes Auto. The server validates the same rule again before routing or execution.

## Execution provenance

- Official -> Official may use native `cwd-worker` / `cwd-verifier` subagents.
- Any route involving `third_party` uses a provider-isolated App Server thread with explicit `modelProvider` and `model`.
- Third-party Main is available only when official OAuth is absent and runs as a standalone App Server thread.
- Third-party Verifier execution uses the `read-only` sandbox.

## Web control plane

The high-frequency navigation is Overview, New API, Model Routing, Connectivity, and Access Protection. Low-frequency native Codex integration lives in the top-right settings drawer.

The Overview reports the active mode, whether it is effectively applied, and whether Main is locked by ChatGPT OAuth. Reasoning is rendered as a model-specific slider from live registry metadata. Access Protection renders only the password form relevant to the current auth state. An explicitly launched loopback instance (`CWD_REQUIRE_AUTH=0`) may select local passwordless access; public bindings, systemd units, and the default launcher remain password-protected.

## Validation and archive boundary

~~~bash
npm run check
npm test
npm run install:linux
npm run validate:deployment
npm run seal:production
npm run seal:release
npm run seal:archive
~~~

Hosted CI proves project-controlled source/runtime/deployment compatibility, including Node 20/22/24, parallel stress, current Codex, immutable and latest ChatGPT Linux bundles, official plugin-manager/App-Server E2E, and user/root installation lifecycle contracts.

`ARCHIVE_READY` is intentionally stricter: it must pass on the same real signed-in Linux installation. CI does not fabricate private ChatGPT OAuth, production New API credentials, or provider-correct official Desktop bindings.

## Documentation

- [Documentation center / 文档中心](docs/README.md)
- [Architecture / 架构](docs/ARCHITECTURE.md)
- [Security / 安全模型](docs/SECURITY.md)
- [System-managed Worker enforcement / 系统级 Worker 强制执行](docs/MANAGED_HOOKS.md)
- [Production seal / 生产封存](docs/PRODUCTION_SEAL.md)

## License

MIT
