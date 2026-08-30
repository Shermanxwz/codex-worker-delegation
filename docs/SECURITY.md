# Security model / 安全模型

## 中文概览

Codex Worker Delegation 3.2 把五个边界分开：

1. 官方 ChatGPT OAuth；
2. 第三方 New API credential；
3. Web 控制面密码；
4. Model Capability Registry；
5. Worker / Verifier 执行权限。

项目不修改或复制 `auth.json`；New API key 只进入本地 AES-256-GCM vault；Codex 只拿到独立 gateway token；Web 默认 loopback 且生产启动默认要求认证。

## Credential separation

- Built-in `openai` provider 和 ChatGPT OAuth 归官方 Codex 所有。
- 项目不写 `auth.json`、不改 built-in provider、不开启伪造的 ChatGPT base URL。
- New API key 使用独立随机 32-byte key 的 AES-256-GCM 加密，相关 key material mode `0600`。
- `codex_worker_gateway` 使用独立本地 bearer token；Codex 无需读取第三方 API key。
- Web password 只保护本地控制平面；logout 不会退出 ChatGPT OAuth。
- 密码轮换会撤销既有 Web session。
- “本机免密码”只在显式 `CWD_REQUIRE_AUTH=0`、服务绑定回环地址且控制面处于本机访问时有效；它不删除已配置的密码。

## OAuth -> Main authorization boundary

Main provider 不是前端偏好，而是认证派生的安全边界。

后端通过官方 App Server `account/read` 判断当前是否存在 ChatGPT OAuth：

- `account.type == "chatgpt"`：Main provider 锁定为 `official`；路由保存和执行 API 都拒绝第三方 Main。
- 无 OAuth：才允许 standalone Third Party Main。

第三方 Main 永远使用显式 `thread/start(modelProvider="codex_worker_gateway")`，不会修改官方顶层 selector，也不会声称已经切换官方 ChatGPT root provider。

## Model capability boundary

模型 ID 和 reasoning effort 都必须来自当前 Model Capability Registry。

Registry 的来源是：

- `account/read`；
- 官方 `model/list`；
- 可选 `modelProvider/capabilities/read`；
- 第三方 `/v1/models`。

安全规则：

- 目录不存在的模型不能靠手写 ID 绕过；
- explicit reasoning 只允许模型明确声明的值；
- 未声明 reasoning metadata 时只能 `Auto`；
- 模型变化后旧 effort 不合法会回 Auto；
- 后端在执行前再次验证，不信任浏览器状态。

因此项目不会通过模型名 heuristic、固定全局列表或“可能支持”来扩大上游能力。

## Mode / Hook boundary

### OFFICIAL

`OFFICIAL` 是插件 policy 休眠态。已经确认 state.mode 为 OFFICIAL 后：

- 不施加项目自己的 tool deny；
- 不要求 `:8788` 控制平面健康；
- 不启动项目管理的 Worker；
- 切入 OFFICIAL 时取消现有项目 Worker。

这保证本地控制平面故障不能把 native Codex 一起锁死。

### AUTO / DELEGATE / MAIN

这些是项目控制态：

- Hook 读取有效 state；
- 通过 HMAC challenge-response 验证 loopback control-plane health；
- state 缺失、格式错误、未知模式、健康证明失败或 Hook 异常时 fail closed；
- `DELEGATE` root 只允许协调/delegation surface，body work 交给 Worker；
- `MAIN` 禁止新 Worker / native subagent execution；
- HTTP/MCP 再次验证 active mode，旧请求参数不能绕过新模式。

`CWD_HOOK_REQUIRE_CONTROL_PLANE=0` 只用于测试，不应进入生产环境。

### System-managed hook profile

如果需要“所有工具调用都先进入项目 policy”的主机级边界，应安装版本化的 `deploy/managed-hooks` profile，而不是只依赖插件 payload。它通过 root-owned `requirements.toml` 的 `allow_managed_hooks_only = true` 指定唯一 managed hook source，再由 wrapper 固定 loopback health endpoint、`CWD_HOOK_REQUIRE_CONTROL_PLANE=1`、Node 20+ 和项目 policy runner。

这层仍尊重 `OFFICIAL` 的故障隔离语义：进入 OFFICIAL 后，项目 policy 不添加 deny，native Codex 不应因为控制面故障被锁死；AUTO / DELEGATE / WORKER / MAIN 则继续在同一个 bridge 中执行认证 health、mode、OAuth、provider、capability、sandbox 和 role 检查。bridge 找不到 runner、policy、data directory、Node 或收到异常时才 fail closed。

安装器只在显式 `CWD_MANAGED_HOOKS_ADOPT=1` 时备份并替换未标记的既有文件；卸载器只删除带有项目 marker 的生成文件。模板不包含 `/root`、token、密码、OAuth 状态、`auth.json` 或 task snapshot。

详见 [System-managed Worker enforcement](MANAGED_HOOKS.md)。

## Worker execution boundary

- Official -> Official 可以使用 native `cwd-worker` / `cwd-verifier`。
- 任何涉及 third-party provider 的执行都使用显式 App Server thread。
- Third-party Verifier 强制 `read-only` sandbox；native verifier Hook 也阻止常见 mutation/execution tools。
- 自动 Worker 默认拒绝 `danger-full-access`；只有 operator 明确设置 `CWD_ALLOW_DANGER_FULL_ACCESS=1` 才开放。
- `cwd` 必须真实存在且是目录；非法路径在 server trust boundary 拒绝。
- Worker cancellation / extension 只针对 matching task ID，不停止主 Codex process。
- Web UI 对任务控制保持只读；内部 MCP/root-control 才能 cancel/extend。

## Worker lifecycle and isolation

每个 provider-isolated Worker 有 `wrk_...` task ID、heartbeat、meaningful progress、event history、lease、review point 和 terminal state。

App Server pool 只复用 idle client；并行 Worker 不共享同一个 active App Server process。一个任务的 cancel / timeout / lease extension 不能附着到另一个任务。

标准任务总上限 60 分钟，quick 总上限 10 分钟。自动 supervisor：

- 有近期实质进展 + healthy heartbeat：有限续期；
- 已进入真实执行但短暂只有 heartbeat：最多一次 bounded grace；
- heartbeat-only / stalled / unavailable / hard-cap reached：fail-closed cancel。

所有自动决定都写入 task evidence 和脱敏 audit。

## Network boundary

- 默认绑定 `127.0.0.1`。
- systemd user/root unit、`npm start`、`npm run start:local` 默认 `CWD_REQUIRE_AUTH=1`。
- 本机开发若明确使用 `CWD_REQUIRE_AUTH=0`，Web 可选择 `local_passwordless`；非回环绑定和 production/systemd 配置会忽略该模式并继续要求认证。
- JSON 管理请求要求 `application/json` 或 `application/*+json`，避免浏览器 cross-site `text/plain` simple request 被当成 localhost 管理请求。
- 非 loopback 部署必须使用 TLS reverse proxy、host firewall、rate limiting，并设置合适的 secure cookie 行为。
- 不要把 raw Node listener 直接暴露公网。
- Provider URL 只接受无内嵌 credential 的 HTTP(S)。
- 用户自带 `Authorization` header 不能覆盖项目 credential boundary。

## Durable config and audit

- `config.toml` mutation 使用 owner-record lock；更新前重新读取，发现并发修改时以 `CODEX_CONFIG_CONCURRENT_MODIFICATION` fail closed，而不是覆盖新配置。
- state、vault、gateway token、Web credential、Worker snapshot 使用原子发布和私有权限。
- audit append/rotation 跨 StateStore instance/process 串行化，并对 active file / directory fsync。

## Official picker boundary

同一 Codex 安装可以同时保留官方 ChatGPT provider 和 namespaced third-party provider，但这不表示第三方 ID 已合法进入官方 signed-in picker。

当前官方 model surface 若没有 provider-correct binding，项目不会用 catalog-only 注入或修改官方 selector 来制造“原生第三方模型”的假象。

---

## English summary

Version 3.2 separates official ChatGPT OAuth, encrypted third-party credentials, Web authentication, model capability authority, and Worker execution authority.

ChatGPT OAuth is read from official `account/read` and server-side locks Main to Official while active. Without OAuth, a third-party Main is allowed only as an explicit standalone App Server thread. Model IDs and explicit reasoning efforts must exist in the current capability registry; no heuristic reasoning list is trusted.

`OFFICIAL` is deliberately dormant and independent of control-plane health so a dead delegation service cannot brick native Codex. AUTO / DELEGATE / MAIN remain authenticated, fail-closed project-controlled modes. Third-party execution is provider-isolated, Verifier is read-only, danger-full-access is opt-in, and task cancellation/extension is scoped to a single persistent Worker task.
