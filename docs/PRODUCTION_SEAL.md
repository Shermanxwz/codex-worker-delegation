# Production seal and archival acceptance / 生产封存与归档验收

## 中文概览

Codex Worker Delegation 3.2 的“封存”分成两个不同层次：

1. **项目可控边界封存**：源码、静态契约、Node 20/22/24、并行压力、当前 Codex、固定与最新 ChatGPT Linux 包、官方 plugin manager / App Server E2E、user/root 安装升级回滚卸载等，可以由 Hosted CI 重复证明。
2. **真实账号归档封存**：`CORE_SEALED`、`DESKTOP_NATIVE_SEALED` 与最终 `ARCHIVE_READY` 必须在同一台真实 signed-in Linux 安装上运行，不能由 CI 伪造私人 ChatGPT OAuth、生产 New API credential 或官方 Desktop provider binding。

因此 Hosted CI 全绿是必要条件，但不是 `ARCHIVE_READY` 的替代品。

## 3.2 必须保持的运行不变量

### OFFICIAL 是原生 Codex 边界

`OFFICIAL` 模式下本插件 policy 休眠：

- 不覆盖官方模型、reasoning、工具或 multi-agent 默认行为；
- 不启动项目管理的 Worker；
- 切换进入 OFFICIAL 会取消项目当前管理的 Worker；
- **本地 `:8788` 控制平面不可用时，也不能因为本插件 Hook 而阻断 native Codex。**

AUTO / DELEGATE / MAIN 才是项目控制态，它们继续要求经过认证的 loopback control-plane health proof，并在 state / Hook / control-plane 异常时 fail closed。

### OAuth 决定 Main provider 边界

Main provider 的合法性由官方 App Server `account/read` 派生：

- `account.type == "chatgpt"`：Main 必须为 Official，且后端拒绝第三方 Main；
- 未观察到 ChatGPT OAuth：才允许 standalone Third Party Main；
- standalone Third Party Main 必须通过显式 `thread/start(modelProvider="codex_worker_gateway")` 运行，不能修改或伪装官方 ChatGPT root provider。

### Model Capability Registry 决定模型与 Reasoning 边界

Registry 由以下真实来源构建：

- `account/read`；
- 官方 `model/list`；
- 可选 `modelProvider/capabilities/read`；
- 第三方 `/v1/models`。

封存规则：

- 当前 Registry 不存在的模型 ID 不得执行；
- explicit reasoning 只允许该模型明确声明的值；
- 未声明 reasoning metadata 时只能使用 `Auto`；
- 模型切换后旧 effort 不合法必须回到 Auto；
- 服务端在保存路由和执行前重复验证，不能只信任 UI。

项目不得通过固定全局 reasoning 列表、模型名 heuristic 或隐藏上游 catalog 错误来制造通过结果。

## Seal levels

### `CORE_SEALED`

目标 signed-in Linux 安装必须在同一次生产验收中证明项目控制的核心链路：

- 当前目标 Codex runtime 可执行；
- repository static contracts 与完整测试通过；
- 官方 Codex plugin manager 安装成功，插件 payload 与受信 source 一致；
- loopback service、Web auth、HMAC hook health（项目控制模式）正常；
- New API credential 已进入本地加密 vault；
- `codex_worker_gateway` namespaced provider 已安装；
- `auth.json` 与官方顶层 selector 不被项目覆盖；
- `account/read` 返回真实官方账号状态；
- 当前 Model Capability Registry 可构建；
- OAuth 活跃时 Main provider lock 生效；无 OAuth 时 third-party Main 只能以 standalone provenance 执行；
- 所选真实 Worker / Verifier route 满足 Registry 与 sandbox policy；
- 至少要求的真实第三方 Worker 路径通过官方 Codex App Server 完成；
- 官方账号前后 `account/read` 与第三方 thread 的真实 coexistence proof 通过；
- Worker lifecycle / cancellation / timeout / lease 行为满足 fail-closed 边界；
- 安装记录、active release tree、plugin cache 与部署权限完整可验证。

第三方 `/v1/models` 返回的所有模型是否都对当前 key/region/quota 可用，单独报告为 catalog 状态。某个 catalog member 不可用不能被隐藏，但也不能和项目控制链路故障混为一谈。

### `DESKTOP_NATIVE_SEALED`

这是比显式 App Server routing 更严格的官方 Desktop 能力门槛。

它要求官方 Codex / Desktop model surface 对第三方模型提供 **provider-correct binding**。仅仅把第三方 ID 显示在某个 catalog 中、但新 thread 仍然解析到 built-in `openai` provider，不算通过。

如果当前官方 surface 不提供足够的 provider binding，本项目仍可做到生产级 explicit-provider routing，但状态必须保持：

```text
CORE_SEALED
DESKTOP_NATIVE_NOT_SEALED
archiveReady = false
```

项目不会为了拿到绿色归档报告而修改官方顶层 provider 或伪造官方 picker。

### `ARCHIVE_READY`

`npm run seal:archive` 是最终归档门槛。它要求在同一台目标 signed-in Linux 安装上同时满足：

1. `npm run validate:deployment` 通过；
2. `CORE_SEALED`；
3. `DESKTOP_NATIVE_SEALED`；
4. release report 的 `archiveReady: true`。

任一条件缺失都必须返回 `NOT_ARCHIVE_READY` 且非零退出。

**Hosted CI 全绿本身永远不能直接产生 `ARCHIVE_READY`。**

## Hosted CI seal

PR / main CI 必须至少覆盖以下项目可控边界：

- `npm run check`；
- Node 20 / 22 / 24 deterministic test suite；
- parallel process-isolation stress suite；
- 当前官方 `@openai/codex` smoke、App Server schema、官方 plugin manager + explicit-provider cross-provider E2E；
- immutable ChatGPT Linux baseline `.deb`、其 bundled Codex 与真实 App Server E2E；
- current latest ChatGPT Linux `.deb` forward-compatibility canary；
- user-scope install -> upgrade -> service -> rollback -> validate -> uninstall；
- root/system-scope lifecycle contract；
- `auth.json` preservation、plugin payload integrity、systemd hardening 与可逆卸载。

CI 不得通过降低 OAuth Main lock、跳过 Registry 校验、放宽 unsupported reasoning、禁用 Hook security 或修改真实 connectivity 结果来换取绿色。

## Reproducible official Linux baseline

`deploy/chatgpt-linux-baseline.json` 记录不可变证据：

- exact ChatGPT Linux package version；
- package SHA-256 / size；
- immutable versioned URL；
- bundled Codex executable path / version；
- 已验证的 App Server / plugin-manager acceptance claims。

Baseline job 必须重新下载并校验 immutable package，然后执行 bundled Codex、生成 App Server schema、通过官方 plugin manager 安装插件并完成 explicit-provider E2E。

Latest job 使用 mutable latest package 作为 forward-compatibility canary。latest 变化不能自动覆盖 baseline；只有独立验收通过后才可更新 recorded baseline。

## Production installation

普通桌面部署应由拥有 ChatGPT / Codex 登录状态的同一 Unix identity 执行：

```bash
npm run install:linux
npm run validate:deployment
```

安装器必须：

1. 验证 Node 20+ 与目标 Codex binary；
2. 在写入安装树前运行静态检查与完整测试；
3. 安装 versioned release，并维护 `current` / `previous`；
4. 渲染对应 user/system systemd unit；
5. pin 经验证的 Node runtime；
6. 默认 loopback + Web auth；
7. 通过官方 Codex plugin manager 安装插件；
8. 只添加 namespaced provider / managed role；
9. 比较安装前后 `auth.json` SHA-256；
10. 记录 release / Codex / Node / auth evidence；
11. 安装失败时恢复前一个完整 release，而不是保留半升级状态。

System scope 若由 root 安装到非 root desktop identity，所有 Codex config / plugin writes 必须以目标 service identity 执行。直接 root 写入普通用户 `CODEX_HOME` 应被拒绝。

## Fail-closed policy

### 项目控制模式：AUTO / DELEGATE / MAIN

Hook 在以下情况 fail closed：

- delegation state 缺失；
- state malformed / unknown mode；
- authenticated control-plane health challenge 失败或超时；
- Hook 本身异常；
- launcher 找不到满足要求的 Node runtime。

### OFFICIAL

OFFICIAL 的目标相反：项目 policy 必须退出路径，不再要求控制面 liveness。只要 state 能被可靠识别为 `OFFICIAL`，本插件不能因为 `:8788` 不可用而 deny native Codex tool use。

这不是放宽 AUTO / WORKER / MAIN，而是确保“官方默认”真正由官方 runtime 负责。

## Upgrade / rollback / uninstall

升级：

```bash
npm run install:linux
npm run validate:deployment
```

回滚：

```bash
npm run rollback:linux
npm run validate:deployment
```

回滚必须恢复完整 previous tree、重新渲染 service unit、刷新官方 plugin-manager source、验证 auth preservation，并保留 former release 用于反向 rollback。

卸载：

```bash
npm run uninstall:linux
```

卸载只移除项目管理的 provider / role / plugin registration / service / installed code。默认保留加密 provider data 与 audit 以便恢复；仅在明确设置 `CWD_PURGE_DATA=1` 时销毁项目数据。

## Target-machine final acceptance

在真实 signed-in Linux 设备配置实际 New API credential 与目标路由后执行：

```bash
npm run validate:deployment
npm run seal:production
npm run seal:release
npm run seal:archive
```

结果必须按字面解释：

- `CORE_NOT_SEALED`：项目控制边界仍有失败，不能发布；
- `CORE_SEALED + DESKTOP_NATIVE_NOT_SEALED`：explicit-provider runtime 可生产使用，但官方 Desktop picker 还没有 provider-correct third-party binding，不能归档；
- `CORE_SEALED + DESKTOP_NATIVE_SEALED + ARCHIVE_READY`：该 exact signed-in host / runtime / provider environment 达到定义的最终归档门槛。

## English summary

Version 3.2 separates hosted source/runtime sealing from real-account archival acceptance. Hosted CI must prove every project-controlled boundary, including Node 20/22/24, parallel stress, current Codex, immutable/latest ChatGPT Linux bundles, plugin-manager/App-Server E2E, and user/root deployment lifecycle contracts.

`OFFICIAL` is a dormant-plugin mode and must remain usable even if the delegation control plane is down. AUTO / DELEGATE / MAIN remain fail-closed project-controlled modes. ChatGPT OAuth server-side locks Main to Official while active. Model and Reasoning validity comes from the live Model Capability Registry and must never be guessed.

Final `ARCHIVE_READY` remains a target-machine gate: it requires deployment validation, `CORE_SEALED`, `DESKTOP_NATIVE_SEALED`, and `archiveReady=true` on the same real signed-in Linux installation. Hosted CI cannot fabricate private OAuth, production provider credentials, or official Desktop provider binding.
