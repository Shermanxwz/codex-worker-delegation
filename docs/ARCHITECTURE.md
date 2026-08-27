# Architecture / 架构

## 中文概览

Codex Worker Delegation 3.2 是官方 ChatGPT Linux / Codex runtime 的本地控制平面，不是替代客户端。官方 ChatGPT provider、OAuth、官方默认模型和官方 multi-agent 行为仍由 Codex 自己维护；项目只在用户明确选择项目控制模式时施加路由和 Worker policy。

## 四层结构

1. **Official Codex runtime**：`account/read`、`model/list`、可选 `modelProvider/capabilities/read`、native subagent、App Server thread。
2. **Local control plane**：loopback Web、OAuth-aware Main policy、Model Capability Registry、模式、路由、审计、Worker lifecycle。
3. **Namespaced third-party provider**：`codex_worker_gateway`，使用本地 bearer token，不替换官方 `openai` provider。
4. **Responses compatibility gateway**：上游 `/v1/responses` 优先，必要时桥接 `/v1/chat/completions`。

~~~text
Official Codex
  account/read
  model/list
  modelProvider/capabilities/read (optional)
        \
         -> Model Capability Registry <- Third-party /v1/models
                         |
          +--------------+--------------+
          |              |              |
        Main          Worker         Verifier
          |
   OAuth policy lock
~~~

## 模式语义

Web 中 `WORKER` 对应内部 `DELEGATE`。

| 模式 | 项目路由 | 行为 |
|---|---|---|
| `OFFICIAL` | 无 | 插件 policy 休眠，当前官方 Codex 自己决定模型、reasoning、工具和 multi-agent 行为 |
| `AUTO` | Main + Worker + Verifier | Main 正常执行；需要时按独立角色路由委派 |
| `DELEGATE` / `WORKER` | Main + Worker + Verifier | Root 只协调，Worker 执行；显式使用项目协作策略 |
| `MAIN` | Main | 禁止项目管理的 Worker delegation 和 native subagent 执行 |

切到 `OFFICIAL` 或 `MAIN` 会取消项目当前管理的活动 Worker，防止旧 Worker 跨越新的模式边界。

### OFFICIAL 的特殊故障隔离

`OFFICIAL` 的意义不是“另一套项目策略”，而是**没有项目策略**。因此 PreToolUse Hook 在已确认 state.mode 为 OFFICIAL 时不会要求 `:8788` 控制平面健康，也不会给 native Codex 添加 deny 决策。

这保证：

~~~text
OFFICIAL + control-plane down
            -> native Codex remains usable
~~~

AUTO / DELEGATE / MAIN 仍要求经过认证的控制平面健康证明并 fail closed。

## OAuth-aware Main

Main provider 合法性来自官方 App Server `account/read`：

- `account.type == "chatgpt"`：Registry 将 Main provider 锁为 `official`；后端保存路由、执行 Worker 和 standalone Main 前都会强制这一规则。
- 未观察到 ChatGPT OAuth：Main provider 可选 `official` 或 `third_party`。

第三方 Main 不是修改官方根 provider，而是明确创建 standalone App Server thread：

```text
thread/start(
  modelProvider="codex_worker_gateway",
  model="<selected third-party model>"
)
```

因此 execution provenance 永远可区分“官方 ChatGPT root”和“无 OAuth 时的 standalone third-party Main”。

## Model Capability Registry

Registry 是模型能力的唯一事实层。它由以下来源构建：

- 官方账号：`account/read`；
- 官方模型：`model/list`；
- 官方 provider 能力：`modelProvider/capabilities/read`（若当前 Codex 支持；不支持时兼容降级）；
- 第三方模型：上游 `/v1/models`。

Registry 对每个 `(provider, model)` 保存模型存在性、默认模型、reasoning metadata 和原始能力证据。

路由 API 和执行 API 都不接受“目录里不存在但用户手写”的模型继续运行。模型消失或 provider catalog 改变后，旧 route 会被重新校验。

## Reasoning effort

3.2 删除全局固定 reasoning enum。模型的 reasoning slider 完全来自当前模型明确声明的 options。

规则：

- `Auto` 永远可用，表示不覆盖模型/provider 默认；
- 只有 capability metadata 明确声明的值才可显式选择；
- 上游未声明 reasoning metadata 时，只有 Auto；
- 切换模型时，旧 effort 若不被新模型支持立即回 Auto；
- 后端保存路由和执行前重复验证，不能绕过 UI 注入不支持的 effort。

官方显式 Main effort 仍可同步项目拥有的 top-level `model_reasoning_effort`；`model_provider`、`model` 和 ChatGPT OAuth 不因此被改写。第三方 effort 只在该第三方模型明确声明并被 Web 选择时转发。

## Worker execution provenance

Native subagent 仅用于 Built-in OpenAI -> Built-in OpenAI 的合法 delegated route。

任何涉及 `third_party` 的 route 使用独立 App Server thread：

- Official -> Third Party：`cross_provider_thread`；
- Third Party -> Third Party：`provider_isolated_thread`；
- Third Party -> Official：`cross_provider_thread`；
- Official -> Official：`native_subagent_required`。

这是故意的保守边界。自定义 provider 的 native subagent transport 曾出现 task payload / encrypted content 不可靠的问题，因此项目不把第三方 thread 冒充成 native child。

## Worker lifecycle

Provider-isolated Worker / Verifier 通过 `wrk_...` task ID 持久化。状态包括：

```text
queued -> running -> completed | failed | timed_out | cancelled
```

每个任务记录：provider/model/role、thread/turn ID、heartbeat、meaningful progress、event history、lease、review point、extension、自动监督决定和结构化脱敏错误。

标准任务总上限 60 分钟，quick 总上限 10 分钟。自动 supervisor 根据最近 meaningful progress + heartbeat：

- 继续有实质进展：有限续期同一个 turn；
- 已进入真实执行但短暂只有 heartbeat：最多给一次 bounded grace；
- heartbeat-only、停滞、失联或达到 hard cap：task-scoped cancel。

Web 只显示证据；`worker_extend` / `worker_cancel` 是 root-control fallback。

## Official + third-party coexistence

安装只增加 namespaced provider，不替换官方 selector：

```toml
[model_providers.codex_worker_gateway]
name = "Codex Worker Delegation Gateway"
base_url = "http://127.0.0.1:8788/v1"
wire_api = "responses"
```

第三方 API key 留在项目 AES-256-GCM vault；Codex 只获得本地 gateway token。

真实共存证明：

```text
snapshot official selectors
  -> account/read (ChatGPT)
  -> thread/start(modelProvider=codex_worker_gateway)
  -> real third-party turn
  -> account/read (ChatGPT)
  -> official selectors unchanged
```

这个证明不等于 Desktop-native provider binding。当前官方 picker 若不能提供 provider-correct third-party binding，项目不会用 catalog-only 注入制造“已原生集成”的假象。

## Runtime flow

```text
Web / MCP
   |
   +-- OFFICIAL ----------------------> native Codex defaults
   |
   +-- AUTO / WORKER / MAIN
          |
          +-- Model Capability Registry validation
          |
          +-- Official -> Official ----> native cwd-worker / cwd-verifier
          |
          `-- any third_party route ---> wrk_<id>
                                         -> App Server thread/start
                                         -> codex_worker_gateway
                                         -> Responses / Chat bridge
```

## Sandbox

App Server 使用当前 hyphenated wire values：`workspace-write`、`read-only`、`danger-full-access`。自动 Worker 默认不允许 `danger-full-access`，除非 operator 明确设置 `CWD_ALLOW_DANGER_FULL_ACCESS=1`；Verifier 强制 `read-only`。

---

## English summary

Version 3.2 keeps official behavior official and project behavior explicit. `OFFICIAL` is a dormant-plugin mode; AUTO / WORKER / MAIN are project-controlled modes. ChatGPT OAuth is read from official `account/read` and locks Main to Official while active. Without OAuth, a third-party Main is allowed only as a clearly identified standalone App Server thread.

A unified Model Capability Registry combines `account/read`, official `model/list`, optional `modelProvider/capabilities/read`, and third-party `/v1/models`. Model existence and explicit reasoning options are validated at save and execution time. No global reasoning-effort guess list remains.

Official -> Official may use native Codex subagents. Every route involving a third-party provider uses an explicit provider-isolated App Server thread with preserved provenance and observable task lifecycle.
