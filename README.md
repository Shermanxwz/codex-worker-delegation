# Codex Worker Delegation

## Language / 语言

[中文](#中文介绍) · [English](#english)

---

<a id="中文介绍"></a>

# 中文介绍

Codex Worker Delegation 是一个面向 ChatGPT Linux 桌面应用与官方 Codex runtime 的本地控制平面。它保留 Codex 所有的官方 ChatGPT 登录状态，同时增加独立的 New API / OpenAI-compatible provider、按角色路由、真实共存验收、Responses 兼容网关，以及可观测的 Worker / Verifier 生命周期管理。

它不是 ChatGPT 的替代客户端，也不是把第三方模型伪装成官方模型的注入器。项目的目标是：

> 官方 ChatGPT 继续由官方 Codex 管理；第三方模型通过 namespaced provider 和 provider-isolated App Server thread 接入；两条链路可以在同一台设备上同时工作，且不会互相覆盖登录、auth.json 或官方顶层 selector。

## 核心架构

~~~text
ChatGPT Linux / Codex
  │
  ├─ 官方 openai provider
  │    └─ ChatGPT OAuth / auth.json（由 Codex 负责）
  │
  └─ codex_worker_gateway provider
       └─ 本地 bearer token
            └─ 加密保存的 New API credential
                 ├─ /v1/responses
                 └─ /v1/chat/completions fallback
~~~

项目只安装 codex_worker_gateway 这一命名空间 provider，并保留官方顶层 model_provider、model 和 auth.json。每个新建的 Codex thread 明确携带 provider 与 model，因而可以在同一个 Codex 安装中保留官方账号，同时执行第三方线程。

## Worker、Verifier 与模式

Web 控制平面是路由和权限的唯一事实来源。Web 中显示 WORKER，内部对应 DELEGATE。

| 模式 | Web 可见模型选择 | 实际行为 |
|---|---|---|
| AUTO | Main + Worker + Verifier | Main 处理简单工作；需要时由主控自动决定是否委派，Worker / Verifier 使用独立配置的路由 |
| WORKER（内部 DELEGATE） | Main + Worker + Verifier | Main 负责协调，Worker 负责执行；Worker / Verifier 使用用户明确指定的路由 |
| MAIN | 只有 Main | 只运行主线程，禁止 Worker delegation 和 native subagent |

Verifier 不是第三种模式，而是只读复核角色；它拥有独立的 provider、model 和 reasoning effort 配置，默认可以跟随 Worker。只有实际任务流程请求复核时才会启动。AUTO 不再让 Worker / Verifier 继承 Main，因此可以把复杂执行和复核路由到低成本模型。

### 真实执行方式

- 官方 → 官方：使用 Codex 原生 cwd-worker / cwd-verifier subagent。
- 任何涉及第三方 provider 的路由：使用独立的 Codex App Server thread，并在 thread/start 中显式发送 modelProvider 和 model。
- 第三方 → 第三方：使用 cross_provider_thread / provider-isolated thread，不伪装成 native subagent。
- 选择模式本身不会启动任务；任务必须来自真实的 delegate_worker 或 Web 路由测试。

当前第三方 Codex native subagent transport 存在过 agent_message / encrypted_content 到达为空的问题，因此项目对第三方路由采用普通 user-turn + provider-isolated App Server thread。这是为了保持真实执行结果和 provenance。

## 可观测的长任务监督

每个 provider-isolated Worker / Verifier 都会先生成持久化 wrk_... task ID，再启动 App Server thread。控制平面记录：

- provider、model、role、execution provenance；
- App Server thread ID、turn ID；
- phase、progress、heartbeat、最近进度事件；
- lease deadline、review point、续期次数；
- 自动观察决定、终态、结构化错误和脱敏 audit。

标准任务默认最多 15 分钟，quick 任务从 2 分钟开始且硬上限为 10 分钟；标准任务总上限为 60 分钟。临近 deadline 时，控制平面依据真实的 meaningful progress 和 heartbeat 自动观察：

- 进度真实且 heartbeat 健康：在硬上限内续期同一个 App Server turn；
- 已经进入真实执行但短暂只有 heartbeat：给予一次有界 grace review；
- heartbeat-only、停滞、不可用或超过总上限：只取消对应 Worker App Server，并写入审计。

监督器不额外调用 Main 模型，不消耗 Main token。Web 页面显示任务证据，但停止和续期属于主控的内部控制能力；worker_extend / worker_cancel 仅作为主控 fallback。

## New API 与协议兼容

Base URL 可以填写服务根、/v1、/v1/responses、/v1/chat/completions、/v1/models 或 /v1/embeddings，控制平面会自动归一化相关 endpoint。

protocol=auto 时，每个模型独立判断：

1. 优先尝试上游 /v1/responses；
2. 成功后缓存 responses；
3. 只有明确表示 Responses 不支持时才 fallback 到 /v1/chat/completions；
4. 不把认证错误、配额错误、模型不存在或参数错误误判为 chat-only；
5. 将 Chat Completions 的文本、工具调用、tool output、usage 转换为 Codex 可消费的 Responses 语义。

embedding / vector 模型会通过 /v1/embeddings 测试，并只显示在连通性页面，不会被放入文本生成 Worker / Main 路由。

## 官方模型下拉框的边界

New API 模型会出现在：

- 本地 Web 模型路由页面；
- 本地 New API 模型连通性页面；
- namespaced codex_worker_gateway provider；
- 本项目返回的 Codex native catalog envelope。

但当前官方登录态下的 Codex model/list 仍只返回官方 openai provider 的模型。官方模型条目没有足够的 provider binding，不能仅靠把第三方 ID 塞入 catalog 就保证它真的走第三方 provider。因此项目不会修改官方顶层 provider、伪造官方下拉框，也不会把“看得到 ID”当成合法共存证明。

真正的共存证明是：

~~~text
account/read（官方 ChatGPT）
  → thread/start(modelProvider="codex_worker_gateway")
  → 真实第三方 model turn
  → account/read（官方 ChatGPT）
  → 校验官方顶层 selector 未改变
~~~

## Web 控制平面

默认地址：

~~~text
http://127.0.0.1:8788/
~~~

页面按职责拆分：

- 访问保护：强密码、登录、退出登录、密码轮换；
- New API 配置：Base URL、API key、协议和 reasoning effort；
- 模型路由：AUTO / WORKER / MAIN 的可见 selector；
- 模型连通性：单个或全部模型测试，显示协议、延迟和错误；
- Codex 原生集成：安装 / 刷新 namespaced provider、查看官方账号和真实共存证明。

退出 Web 控制平面只清除控制平面 session，不会退出 ChatGPT，也不会更改 Codex OAuth。

## 安装与运行

要求：Node.js 20+，以及官方 ChatGPT Linux bundled Codex 或当前 Codex binary。

~~~bash
npm run check
npm test
npm start
~~~

要安装为终端关闭后仍运行的本地服务：

~~~bash
npm run install:linux
npm run validate:deployment
~~~

配置真实 New API 和路由后，可运行：

~~~bash
npm run seal:production
~~~

seal:production 是严格生产验收，不是普通健康检查。它会检查官方 runtime、插件、部署、账号、provider、第三方模型矩阵、真实共存、auth preservation、selector preservation 和 Worker 路由，并在真实条件不满足时返回非零。

## 当前真实验收边界

2026-08-22 的目标 Linux 设备实测结果：

- 静态检查通过；
- 完整测试套件 132/132 通过；
- 官方 Codex App Server 真实共存证明通过；
- New API 目录读取 13 个模型；
- 真实网关 /v1/responses 调用通过；
- DELEGATE 下 Worker 和 Verifier 均通过真实第三方 App Server thread；
- 官方下拉框中的 New API-only 模型为 0/10；
- New API 模型连通性为 12/13，其中一个上游模型返回 HTTP 502。

因此严格报告仍可能是 NOT_SEALED。这不表示核心路由或共存链路没有运行，而是明确暴露了两个外部事实：官方 Desktop model surface 尚未提供第三方 provider binding，以及上游模型目录中存在当前不可用的模型。修改模型目录或官方 runtime 后必须重新验收。

## 文档

- [文档中心 / Documentation](docs/README.md)
- [架构 / Architecture](docs/ARCHITECTURE.md)
- [安全模型 / Security](docs/SECURITY.md)
- [生产封存与验收 / Production Seal](docs/PRODUCTION_SEAL.md)
- [Codex plugin skill](plugins/codex-worker-delegation/skills/codex-worker-delegation/SKILL.md)

## 仓库政策

main 是本仓库唯一维护分支。项目保留官方 ChatGPT 登录与 provider 隔离边界；不会为了制造绿色报告而篡改 auth.json、官方顶层 selector 或第三方连通性结果。

## License

MIT

---

<a id="english"></a>

# English

Codex Worker Delegation is a local control plane for the ChatGPT Linux desktop and the official Codex runtime. It preserves Codex-owned ChatGPT authentication while adding a separate New API / OpenAI-compatible provider, role-based routing, real coexistence verification, a Responses compatibility gateway, and observable Worker / Verifier lifecycle supervision.

It is not a replacement ChatGPT client and it does not pretend that third-party models are official models. Its purpose is:

> Keep the official ChatGPT account under the official Codex provider, connect third-party models through a namespaced provider and provider-isolated App Server threads, and let both paths run on the same installation without overwriting OAuth, auth.json, or official top-level selectors.

## Architecture

~~~text
ChatGPT Linux / Codex
  |
  +-- built-in openai provider ---------------- ChatGPT OAuth / auth.json
  |
  +-- codex_worker_gateway provider ------------ local bearer token
          |
          +-- encrypted New API credential
                 |-- upstream /v1/responses
                 +-- /v1/chat/completions fallback
~~~

Installation adds only the namespaced codex_worker_gateway provider. The official top-level model_provider, model, and auth.json remain Codex-owned. Each new Codex thread receives an explicit provider and model, so the official account and third-party threads can coexist in one local Codex installation.

## Worker, Verifier, and modes

The Web control plane is the source of truth. The Web label WORKER maps to the internal mode DELEGATE.

| Mode | Visible model selectors | Runtime behavior |
|---|---|---|
| AUTO | Main + Worker + Verifier | Main handles simple work; the root automatically decides whether to delegate, while Worker / Verifier use independent configured routes |
| WORKER (DELEGATE) | Main + Worker + Verifier | Main coordinates, Worker executes, and Worker / Verifier use the explicitly selected routes |
| MAIN | Main only | The root thread runs the work; Worker delegation and native subagents are disabled |

Verifier is not a third mode; it is a read-only verification role with its own provider, model, and reasoning-effort configuration, defaulting to the Worker route when no override is supplied. It starts only when the task flow requests verification. AUTO no longer inherits Main for Worker / Verifier, which allows substantial work and verification to use lower-cost models.

### Actual execution provenance

- Official → Official: Codex native cwd-worker / cwd-verifier subagents.
- Any route involving a third-party provider: an independent Codex App Server thread with explicit modelProvider and model in thread/start.
- Third-party → Third-party: a cross_provider_thread / provider-isolated thread, never mislabeled as a native subagent.
- Selecting a mode does not launch a task; a real delegate_worker call or Web route test is required.

Custom-provider native subagent transport has reproduced cases where agent_message / encrypted_content arrives empty. Third-party routes therefore use ordinary user-turn input on a provider-isolated App Server thread, preserving real execution provenance.

## Observable long-running supervision

Every provider-isolated Worker / Verifier receives a persistent wrk_... task ID before its App Server thread starts. The control plane records provider, model, role, execution provenance, thread and turn IDs, phase, progress, heartbeats, recent events, lease deadlines, review points, automatic decisions, terminal state, and redacted errors.

The standard lease starts at 15 minutes. quick starts at 2 minutes and is hard-capped at 10 minutes; standard total runtime is hard-capped at 60 minutes. Near a deadline, the supervisor evaluates real meaningful progress and heartbeat evidence:

- healthy progress renews the same App Server turn within the hard cap;
- real execution with a temporary heartbeat-only interval receives one bounded grace review;
- heartbeat-only, stalled, unavailable, or exhausted work is cancelled at the task boundary and audited.

Supervision does not make an extra Main model call. The Web page displays evidence, while stop and renewal remain root-control capabilities; worker_extend and worker_cancel are root fallbacks.

## New API and protocol compatibility

The Base URL may be a service root, /v1, /v1/responses, /v1/chat/completions, /v1/models, or /v1/embeddings; the control plane derives the related endpoints.

With protocol=auto, each model is detected independently:

1. Try upstream /v1/responses.
2. Cache responses after success.
3. Fall back to /v1/chat/completions only when Responses is genuinely unsupported.
4. Never reinterpret authentication, quota, missing-model, or validation failures as chat-only.
5. Translate text, tools, tool outputs, and usage into Responses semantics for Codex.

Embedding/vector models are tested through /v1/embeddings and remain connectivity-only; they are not offered as text-generation Worker/Main routes.

## Boundary of the official model picker

New API models are available in the local Web routing page, the connectivity page, the namespaced provider, and the gateway's native catalog envelope.

The signed-in official Codex model/list currently still returns only models from the official openai provider. Its entries do not expose enough provider binding to guarantee that a third-party ID would route through codex_worker_gateway. The project therefore does not rewrite the official top-level provider, fake the official picker, or treat catalog visibility alone as coexistence.

The authoritative coexistence proof is:

~~~text
account/read (official ChatGPT)
  -> thread/start(modelProvider="codex_worker_gateway")
  -> real third-party model turn
  -> account/read (official ChatGPT)
  -> verify the official top-level selector is unchanged
~~~

## Web control plane

Default address:

~~~text
http://127.0.0.1:8788/
~~~

The UI is split by responsibility:

- Access protection: strong password, login, logout, and password rotation;
- New API configuration: Base URL, API key, protocol, and reasoning effort;
- Model routing: visible selectors for AUTO / WORKER / MAIN;
- Model connectivity: test one model or the complete catalog with protocol, latency, and errors;
- Codex native integration: install/refresh the namespaced provider, inspect the official account, and run the real coexistence proof.

Logging out of the Web control plane clears only its session. It does not log ChatGPT out or change Codex OAuth.

## Install and run

Requirements: Node.js 20+ and the official ChatGPT Linux bundled Codex or a current Codex binary.

~~~bash
npm run check
npm test
npm start
~~~

For a local service that survives terminal closure:

~~~bash
npm run install:linux
npm run validate:deployment
~~~

After configuring a real New API provider and route:

~~~bash
npm run seal:production
~~~

seal:production is a strict production gate rather than a basic health check. It checks the official runtime, plugin, deployment, account, provider, third-party model matrix, real coexistence, authentication preservation, selector preservation, and the configured Worker route. It exits non-zero when the observed runtime does not satisfy the strict gate.

## Current observed acceptance boundary

The target Linux installation was exercised on 2026-08-22 with these results:

- static checks passed;
- the complete test suite passed: 132/132;
- the real official Codex App Server coexistence proof passed;
- the New API catalog returned 13 models;
- a real gateway /v1/responses request passed;
- both a DELEGATE Worker and Verifier completed through real third-party App Server threads;
- New API-only IDs in the official picker: 0/10;
- New API connectivity: 12/13, with one upstream HTTP 502.

The strict report may therefore remain NOT_SEALED. This does not mean the core routing or coexistence path failed. It records two external facts: the current official Desktop model surface does not provide third-party provider binding, and one advertised upstream model is unavailable. Re-run acceptance after changing the upstream catalog or official runtime.

## Documentation

- [Documentation center / 文档中心](docs/README.md)
- [Architecture / 架构](docs/ARCHITECTURE.md)
- [Security model / 安全模型](docs/SECURITY.md)
- [Production seal / 生产封存与验收](docs/PRODUCTION_SEAL.md)
- [Codex plugin skill](plugins/codex-worker-delegation/skills/codex-worker-delegation/SKILL.md)

## Repository policy

main is the only maintained branch. The project preserves the official ChatGPT login and provider isolation boundaries; it never changes auth.json, official top-level selectors, or third-party connectivity results merely to produce a green report.

## License

MIT
