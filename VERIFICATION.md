# 验收报告 —— dsh-dialogue-cleanup v1.0.0

> 体例行主手册 §8.6。**如实记录已做与未做**：没有做的验证明确写「未做」，不写成「已验证」。

| 项 | 值 |
|---|---|
| 交付物 | `E:\Code\dsh-plugin-market\dsh-dialogue-cleanup\` |
| 复刻对象 | `dsh-session-cleaner@1.0.2`（能力边界，非实现） |
| 规范依据 | 主手册第 2 章 R 编号 + 附录 C |
| 验证环境 | 本机 `node v24.13.1`，`<DSH_HOME>=C:\Users\28062\.dsh`，profile `desktop` |
| 执行时间 | 本次会话 |

---

## 1. 一句话结论

Host 半、客户端半、单测、清单均已交付，**运行时已实测通过**（见 §5.4）。

| 层 | 内容 | 结果 |
|---|---|---|
| L1 语法 | 7 个 JS 文件 + 3 个 JSON | ✅ `node --check` / `JSON.parse` 全过 |
| L2 清单 | 包 / patch / dsh 段 / exports / files | ✅ 符合 R 组要求 |
| L3 单测 | 147 条单测 + 契约 + 渲染测试 | ✅ **147/147 通过** |
| L4 运行时 | 装载行、三条路由、契约状态码、Client slot | ✅ **已实测**（§5.4）｜⚠️ 交付前修复需重启后生效（§5.6） |
| L5 视觉 | 明暗主题 / 实际外观 / 交互手感 | ❌ **未验证**（无浏览器控制，按 R-42 声明） |

> **视觉呈现仍然未验证**：本环境没有浏览器控制，无法截图或比对渲染结果。
> 已核的是「它按契约注册、按契约应答」，**不等于**「它看起来对」。



---

## 2. 验证矩阵（四层）

| 层 | 内容 | 手段 | 结果 |
|---|---|---|---|
| L1 语法 | 7 个 JS 文件 + 3 个 JSON | `node --check`；`JSON.parse` | ✅ 全部通过 |
| L2 清单 | `package.json` / `cordis.patch.yml` 结构、`dsh` 段、`exports`、`files` | 人工比对 R-01/R-03/R-06/R-07 + 官方模板 | ✅ 符合 |
| L3 单测 | 路径安全、契约、事务、幂等、Config | `node --test "test/**/*.test.mjs"` | ✅ **147/147 通过** |
| L4 运行时 | 装载行、路由注册、slot 注册、端点行为 | `plugin_manager install_bundle` 读 `application`/`warnings`；`cordis_inspect_query` | 见 §5（安装后回填） |

---

## 3. 单测覆盖（147 条）

`node --test "test/**/*.test.mjs"` → `tests 147 / pass 147 / fail 0`。

> **自查后新增 `test/render.test.mjs`**：此前所有测试只验证「注册面」（slot 注册了、
> cleanup 存在、文案 key 对齐），**从不渲染任何组件** —— 组件体里的错误（未定义变量、
> 条件调用 hook、访问 undefined 属性）只有用户打开设置页才会炸。
> 现用一个极小 React 替身（只实现 client.js 实际用到的 createElement/Fragment/useState/useEffect）
> + 递归渲染器**真实执行**组件。已用注入故障验证有效性：在面板里塞一个未定义变量，
> 该文件立刻 3 条失败。

| 文件 | 条数 | 覆盖 |
|---|---|---|
| `test/session-id.test.mjs` | 6 | id 正则（穿越 / 越界 / 空 / 超长 / 非字符串）、`isInside` 兄弟前缀不误判、对偶拼写不产出非法 id |
| `test/artifacts.test.mjs` | 9 | 只删目标、非法 id 抛错、**无守卫时不碰另一种拼写**、有守卫且确认非他者才删、他者时跳过、**符号链接拒绝**、投影缓存、同名文件不删 |
| `test/service.test.mjs` | 26 | `detachLiveStore` 三级降级、`detachWorkspaces` 计数修正（含只读数组 getter）、注册表残留清理（**不谎报 changed**）、**`stopIdleAgent` 绝不触碰 `fiber._unload()`**、`inspectRunning` 权威信号与降级与**拆分等价性**、**批量探测 O(N)→O(1)**、**严格 ctx 回归（未注入服务属性访问抛错）** |
| `test/contract.test.mjs` | 76 | 同源五步、语义化状态码（**显式非 200**）、信封、64 KiB/超时、限流（**按请求计费回归**）、Config/Standard Schema、`ctx.effect` 装配与清理、跨站 403、非 POST 405、非 JSON 400、**running 被拒且盘上文件不动**、幂等单飞、**面板数据源（语料合并/标题缓存/分片并发/`titleLimit=0`/分页/筛选/降级）**、**批量删除端点** |
| `test/client.test.mjs` | 18 | loader id = 包名、factory 无副作用、**注册面**（菜单项 + 确认框 + 设置页 section，全部经 `ctx.effect`）、**不依赖 layout**、R-22/R-23 零 DOM/零 Harness 包、R-24 只用真实令牌、zh/en 字典 key 一致、**批量删只发一次请求**、**多选收敛到当前可见页**、**语言跟随宿主（active 字段 / 回退 / 切语言 / bind 优先 / 退订）** |
| `test/render.test.mjs` | 12 | **真实渲染**：菜单项输出 `role=menuitem`、hookContext 缺席时降级、确认框无状态返回 null / 有状态渲染 `role=dialog`+`aria-modal` 且显示会话标题、设置页面板首屏渲染标题+样式、网络失败仍渲染、**hooks 数量跨渲染一致（条件 hook 回归）**、切语言后 label 跟随 |

关键回归项（对应主手册「五条最容易翻车的地方」）：

1. ✔ **幽灵行**：`detected:false` 时如实上报，不假装删干净。
2. ✔ **不写 DOM**：`client.js` 中 `document.*` 零出现（仅 `window.addEventListener` 用于 Esc）。
3. ✔ **不碰 `_unload()`**：`stopIdleAgent` 测试用探针断言 `unloadCalled === 0`。
4. ✔ **状态码不写死**：`sendJson(res, 409, ...)` 测试断言 `status === 409`。
5. ✔ **不谎报**：本文件与 README 均标注视觉未验证。

---

## 4. 附录 C.12 的 A–I 九项 —— 现场核实结论（**已回填**）

核实手段：`cordis_inspect_query`（host/client `Service`、client `Slots`、client `Theme`、client `Builtin`）、
`_research/asar-filelist.txt`、本机 `<DSH_HOME>` 磁盘实证。

| # | 事项 | 结论 | 证据 | 对代码的影响 |
|---|---|---|---|---|
| **A** | `@deepseek-ai/dsh-client-runtime` 是否真包 | ❌ **不存在** | asar 12967 条清单 **0 命中**；实测包为 `dsh-client-locale` / `dsh-client-ui-workspace` / `dsh-client-ui-primitives` 等 | 已从 `dsh.client.inject` **移除**，改为 `["@deepseek-ai/dsh-client-ui-workspace", "@deepseek-ai/dsh-client-locale"]` |
| **B** | `dsh.client.inject` 写不存在的包是否硬失败 | ⚠️ 未实测硬失败（R-04 明说 inject 只排序激活）；**按「不写不存在的包」处理** | 官方原文 "entries only order activation and stay allowed" | 遵循 A 的修正，规避风险 |
| **C** | `--dsw-alias-danger` / `-interactive-bg-hover` / `-hairline` 是否真实令牌 | ❌ **三个都不存在** | `Theme.listTokens` **全表 14 个**令牌，无这三个 | `client.js` 只用全表内令牌：`bg-base`/`bg-layer-2`/`bg-overlay`/`border-l1`/`border-l2`/`label-primary`/`label-secondary`/`brand-primary`/`state-error-primary` |
| **D** | `sessions` 是否有公开 detach | ❌ **没有** | host `Service.listService('sessions')` 公开面 = create/prepare/enter/announce/flush/get/list/fork；**无 detach** | `detachLiveStore` 三级降级；拿不到就报 `detached:false` |
| **E** | `Workspace.detachSession()` 稳定性 | ✅ **公开**（类型层 + `workspaceRegistry` service） | host `Service('workspaceRegistry')` → `Workspace` 接口明列 `detachSession(sessionId): Promise<void>` | 直接用；并**只在调用成功时计数**（修 D7） |
| **F** | 官方停空闲 agent 的公开入口 | ❌ **不存在** | 公开 `Agent` 类型 = `{ readonly id: SessionId }`（**无 `status`/`ctx`/`fiber`**）；`agentLoop.createAgent/resume` 的 `AgentHandle.dispose()` 只对所有者有效 | **不碰** `fiber._unload()`；`stopIdleAgent` 探测不到就返回 false → `refused`；`status.publicStopIdleAgent` 恒为 `false` |
| **G** | `sidebar.workspaces.session.menu.item` 完整 props | ✅ **已确认** | `Slots.listSubTree` 返回：`kind:"list"`, `scope:"root"`, `hookContext:"MenuOpenState"`, ownerProps = `sessionId` + `displayTitle`；同席 `pin(100)/rename(200)/fork(300)/archive(400)`；`slotInject.hooks.menuOpenState` | `client.js` 只用这三样；`order: 500` 排在 archive 之后 |
| **H** | 主题化确认 Modal 的注册方式 | ✅ **`shell.overlay`（list, root）** | `Slots.listSubTree('shell.overlay')`：`replaceRisk:"none"`，同席已有 `workspace.session-archive` / `workspace.session-rename` 等官方对话框 | 确认/结果框注册到 `shell.overlay`，`id: "dialogue-cleanup.confirm"` |
| **I** | `webServer.register` 选项与返回 disposer | ✅ **已确认** | host `Service('webServer')`：`register(route: WebRoute): () => void`；`WebRoute = { kind: 'exact'\|'prefix', path, handler }`；**重复 (kind,path) 抛错** | 已用返回 disposer + `ctx.effect` 包裹（上游没包，热重载会重复注册→抛错） |

### 4.1 ⭐ 新增发现 J：`Config` 必须是 Standard Schema，**不是** JSON Schema（附录此处有误）

| # | 事项 | 结论 | 证据 | 对代码的影响 |
|---|---|---|---|---|
| **J** | `Config` 的形态 | ❌ 附录 C.4 的裸 JSON Schema **不正确**；必须是 Standard Schema v1：`Config['~standard'].validate(value) -> {value} \| {issues}` | 安装实测报错 + 读 asar 内 cordis `lib/index.js:956-962` 原文逐行确认 | `lib/config.js` 改为零依赖自实现 `~standard`（同时保留可调用形态与 JSON Schema 投影） |

**cordis 原文**（`@deepseek-ai/cordis/lib/index.js:956-962`，从 app.asar 抽取后逐行读取）：

```js
function resolveConfig(runtime, config) {
  if (!runtime.Config) return config;
  const result = runtime.Config["~standard"].validate(config);
  if ("then" in result) throw new TypeError("Async config validation is not supported");
  if (result.issues) throw new ValidationError(result.issues);
  else return result.value;
}
```

### 4.2 额外发现（附录未登记，但影响正确性）

| 发现 | 证据 | 处理 |
|---|---|---|
| **语言权威路径是「注入的 `t` 席位」+ `locale.bind(ns)`** | 官方 `@deepseek-ai/dsh-client-locale/README.md` 实现小节：「`LocaleRuntime` 自身就是 slot 系统的 `LocaleFace`：`getSnapshot`/`subscribe` 支撑**框架注入的 `t` 席位**」；「产品编写的 Client UI 文本**必须来自这些带类型的字典**，或来自已经本地化的 primitive prop」 | 确立三级优先级：① `props.t` ② `ctx.locale.bind(ns)` ③ 内置兜底表。三处 UI（菜单项／确认框／面板）统一走 `makeTranslator` |
| **`LocaleSnapshot` 的字段是 `active`，不是 `id`/`locale`/`language`** | client `Service('locale')` 契约：`LocaleSnapshot { active: LocaleId; locales: readonly LocaleDefinition[]; revision: number }` | 旧代码读三个**不存在**的字段 ⇒ 永远 fallback 到 `navigator.language`（跟随浏览器而非 harness）。改为只认 `active`，取不到如实返回 null |
| **宿主偏好来自 Host settings（`locale.preference`）** | 官方 README：「临时 locale 来自浏览器…一直站到**宿主支持的设置作用域**送达其存储的偏好为止」；本机 profile 内**尚无**该偏好 ⇒ 目前处于 provisional（浏览器派生）状态 | 不依赖「偏好一定存在」；`subscribe()` 在偏好到达时会触发，届时自动跟随 |
| **`settings.section` / `shell.overlay` 都不注入 `t`** | `Slots.listSubTree`：`settings.section` ownerProps 只有 `{ close }`，`shell.overlay` ownerProps 为空；两者 standardProps 均无 `t` | 如实转发 `props`（`{...props}`）并让 `t`缺席时降级到 `bind`；框架将来注入即自动生效 |
| **磁盘目录名两种拼写并存** | 同一 `<DSH_HOME>/sessions` 下：`...\<uuid>\session.v4.jsonl.zstd` 与 `...\session-<uuid>\session.v4.jsonl.zstd`（实测 62 / 29） | 上游 `join(root, proj, sessionId)` 永远删不掉带前缀的一半。本实现探测对偶拼写，**但只在能确认它不是另一个活动会话时才删**（`isKnownSession` 守卫）；无结论则不删 |
| **`sessionController.list()` 才是公开的 running 信号** | `SessionSummary = { running, blank, updatedAt, agentAvailable, ... }` | `inspectRunning` 优先用它；不可用时降级到 `agents.get` 并标记 `available:false` |
| **上游 `!Array.isArray(ids)` 会误判只读数组** | `Workspace.sessionIds` 是 `readonly SessionId[]` getter | 用 `Array.from()` 归一化，兼容冻结/只读数组 |
| **派生投影缓存** | `<DSH_HOME>/storages/session_projcache/sessions/<id>.json`（实测存在） | 默认一并删除（`removeProjectionCache`），避免同名 id 复用时读到过期折叠态 |
| **注册表 pin/archive 残留** | `workspace.json` 含 `archivedSessionIds` 列表 | 用公开幂等 API `unpinSession`/`unarchiveSession` 清理 |
| **`install_bundle` 用软链接安装** | `Get-Item ...\node_modules\dsh-dialogue-cleanup` → `LinkType: SymbolicLink` | 软链接 realpath 在 profile 之外 → **插件内不得 import profile 里的裸包名**；这是 §4.1 J 最终改用零依赖自实现的直接原因 |
| **`@deepseek-ai/dsh-client-runtime` 不存在** | asar 12967 条清单 0 命中；profile bundle 列表里真实的是 `dsh-client-locale` / `dsh-client-ui-workspace` | 已从 `dsh.client.inject` 移除（A 项的修正） |
| **`webServer.register` 重复注册抛错** | host `Service('webServer')` 的 `register` 描述："Duplicate (kind, path) throws" | 路由注册全部包在 `ctx.effect` 内并返回 disposer（上游没包） |

---

## 5. 安装与运行时验证

### 5.1 清单校验（静态）

- `dsh.bundle.patch` → `./cordis.patch.yml` ✔
- `dsh.client.platform = "web"`，`exports["./client"]` → `./client.js` ✔
- `exports["./package.json"]` 与 `exports["./locale/*.json"]` 已放开 ✔
- 行 id `dialogue-cleanup` 唯一，行 name = 包名 ✔
- `peerDependencies` 无（本包不依赖 `@deepseek-ai/cordis` —— 它是 Host 侧自动注入的服务集合，官方模板也未声明）✔
- `icon: "./icon.svg"` 相对路径、SVG、< 256 KiB ✔
- `files` 白名单完整（`lib` / `client.js` / `cordis.patch.yml` / `locale` / `icon.svg` / 文档）✔

### 5.2 运行时（实测记录）

| 检查 | 手段 | 结果 |
|---|---|---|
| 包是否装进 profile | `plugin_manager install_bundle` 的 `packageResult` | ✅ `exitCode: 0`，`dsh-dialogue-cleanup link:E:/...` 写入 profile `dependencies`，并加入 `dsh.profile.bundles` |
| 装载行是否存在 | `plugin_manager list_plugins` | ✅ `include:dialogue-cleanup`（`moduleName: dsh-dialogue-cleanup`, `patchId: dialogue-cleanup`） |
| 装载行是否 live | 同上的 `fiberPhase`（R-40 口径） | ❌ **`failed`** —— 见下方根因 |
| 三条路由是否注册 | `GET http://127.0.0.1:19387/api-ext/dialogue-cleanup/status` | ❌ **404**（与行 `failed` 一致） |
| Client slot 是否被占用 | `cordis_inspect_query` `Slots.listSubTree('sidebar.workspaces.session.menu.item')` | ⏸ **未生效**（Client 半未装载，因为 Host 行 failed） |

### 5.3 首次安装失败 → 根因 → 修复（**如实记录**）

安装后行状态为 `failed`，`warnings` 给出：

```text
dialogue-cleanup (dsh-dialogue-cleanup):
TypeError: Cannot read properties of undefined (reading 'validate')
    at resolveConfig (.../@deepseek-ai/cordis/lib/index.js:958:45)
```

**根因**（读 asar 内 cordis 源码 `lib/index.js:956-962` 逐行确认）：

```js
function resolveConfig(runtime, config) {
  if (!runtime.Config) return config;
  const result = runtime.Config["~standard"].validate(config);   // <-- 第 958 行
  if ("then" in result) throw new TypeError("Async config validation is not supported");
  if (result.issues) throw new ValidationError(result.issues);
  else return result.value;
}
```

即 `Config` 必须是 **Standard Schema v1**（`Config["~standard"].validate`），
**不是**裸 JSON Schema。附录 C.4 给的是裸 JSON Schema 字面量 —— 这与运行时不符，**该假设已被证伪**。

第一次修复尝试 `import z from '@deepseek-ai/schemastery'`（照抄官方插件写法）也失败，原因是
`install_bundle` 把插件目录**软链接**进 profile，软链接的 realpath 在 profile 之外，
裸包名 `@deepseek-ai/schemastery` 解析不到（实测 `ERR_MODULE_NOT_FOUND`）；
写进 `peerDependencies` 也救不了，因为解析按 realpath 走。

**最终修复**：`lib/config.js` **零依赖**自实现 Standard Schema v1 契约
（同时提供可调用形态、`.validate`、`~standard` 与 JSON Schema 投影），彻底消除包解析问题。

**在干净进程中按 cordis 原文逻辑逐行复演，修复已确认有效**：

```text
has ~standard: true
validate is fn: function
resolved(undefined): {"maxBodyBytes":65536,"readTimeoutMs":10000,"audit":true,...}
resolved({audit:false}): {...,"audit":false,...}
FRESH-PROCESS CONTRACT: OK
```

### 5.4 运行时实测结果（✅ 全部通过）

修复后重载该行，`application: applied`、`warnings: []`。随后逐项实测：

**① 装载行 live**（R-40 口径：看 `application`/`warnings`，不看日志）

```text
plugin_manager set_plugin include:dialogue-cleanup enabled:true
-> { "application": "applied", "warnings": [], "changed": true }
```

**② 三条路由按契约应答**（真实 HTTP，非单测替身）

| 请求 | 期望 | 实测 |
|---|---|---|
| `GET /status` | 200 + 能力表 | ✅ 200 |
| `GET /list?pageSize=2` | 200 + `{total,page,items,projects,sources}` | ✅ 200 |
| `GET /delete`（非 POST） | 405 | ✅ 405 |
| `POST /delete` 非法 id | 400 `bad-request` | ✅ 400 |
| `POST /delete` 空 `sessionIds` | 400 `bad-request` | ✅ 400 |
| `POST /delete` running 会话 | **409 `refused`** | ✅ 409 + 中文 message + hint |

实测的 409 响应（**目标是本会话自己**，被正确保护）：

```json
{"ok":false,"error":{"code":"refused",
 "message":"会话正在运行，请先停止再删除",
 "hint":"在会话里停止当前回复，或先关闭该会话，然后重试删除。"}}
```

`/status` 实测返回的能力表：

```json
{ "detachLive": true, "detachWorkspaces": true, "clearRegistryRecords": true,
  "removeArtifacts": true, "removeProjectionCache": true,
  "listSessions": true, "listCorpus": true, "titles": true,
  "runningProbe": "sessionController.list", "publicStopIdleAgent": false }
```

**③ 清单端点真实数据**：`total=91`、`pages=2`、`projects=5`，
标题/项目/`deletable`/`blockedReason` 均已解析（**不是**裸 UUID）。
`sources: { corpus: "sessionQuery.listSessions", summary: "sessionController.list" }`
—— 证明两路数据源都被真正用上。

**④ Client slot 注册 live**（`cordis_inspect_query` `Slots.listSubTree`）

- `settings.section` 的 occupants 中出现
  `{ registrant: "dialogue-cleanup", id: "dialogue-cleanup", order: 25, active: true }`，
  位置在官方 `agent-presets(20)` 之后、`our-free-model(35)` 之前 ✅
- 同一 slot 的 `sidebar.workspaces.session.menu.item` 亦已注册（行菜单项）✅

### 5.5 过程中修掉的两个真实缺陷（都在运行时才暴露）

单测用普通对象 ctx 无法发现这两个问题，都被真实宿主抓出来了 —— 如实记录：

**缺陷一：`Config` 契约（已在上文 §5.3 详述）**
裸 JSON Schema 不是 Standard Schema；且照抄 `@deepseek-ai/schemastery` 的 import
在软链接安装下解析不到。改为**零依赖**自实现 `~standard`。

**缺陷二：未注入服务的属性访问会抛错 → `/status` 空 body 400**

```js
// 错的（旧代码）：sessions 不在 inject 里，真实 Cordis 上这一步会抛错
detachLive: typeof ctx?.sessions?.store?.get === "function"
```

webserver 的实现会把 handler 的异常吞成**没有 body、没有 content-type 的 400**
（`dsh-host-webserver/lib/index.js:246-256`），所以现场只看到一个空 400、看不到原因。
普通对象 ctx 上读不存在的属性只得到 `undefined`，因此单测一直是绿的。

修法两条：

1. 新增 `getService(ctx, name)`：一律走 `ctx.get()` 并判空，兜底属性访问也包 `try`
   （`lib/service.js`）；把 service.js / client.js 里**所有**直接服务访问都换掉。
2. 给每个路由 handler 套 `guard()`：异常转成规范的 `500 internal` + 异常原文，
   已发头则销毁连接 —— 不再产生无法诊断的空 400（`lib/index.js`）。
3. `/status` 自身每个探测项单独 `try/catch` —— 排障端点不该自己成为故障点。

并补了 5 条**严格 ctx 回归测试**（`makeStrictCtx` 模拟「未注入服务属性访问抛错」），
确保这类 bug 不会再悄悄溜回来。

### 5.6 交付前三处删除缺陷 + 一处性能缺陷的修复（**都在 live 宿主上先复现**）

用户反馈「正在读取会话清单…太慢 还有删除逻辑有问题」。两条都先取证再改。

#### 复现（改前，live 宿主 `http://127.0.0.1:19387`）

| 探测 | 结果 |
|---|---|
| `GET /status` | 1–163 ms（基础开销极小） |
| `GET /list?pageSize=1` | 115–140 ms |
| `GET /list?pageSize=10` | 1523 ms |
| `GET /list?pageSize=50` | **3292 ms** |
| `GET /list?pageSize=100` | 5322 ms |
| `GET /list?pageSize=200` | 13113 ms |
| `POST /delete {sessionIds:[10 个]}` | **429 rate-limited** |
| `POST /delete {sessionIds:[11 个]}` | **429 rate-limited** |
| `POST /delete {sessionIds:[50 个]}` | **429 rate-limited** |
| `POST /delete {sessionIds:[200 个]}` | **429 rate-limited** |
| `POST /delete {sessionId:"不存在的id"}` | 200 `ok:true`，且 `registryCleared: 2` ← **编造** |

耗时随 `pageSize` **线性增长** ⇒ 瓶颈是逐条取标题；`readTitleSnapshots` 实测约 **65 ms/条**
（要读并解压整份会话日志），且服务内部串行。
审计日志 `dialogue-cleanup.jsonl` 当时只有 2 行、且都是 `refused` ——
**没有任何一次 UI 删除真正落过盘**，与「批量必被 429」互为印证。

#### 三处删除缺陷

1. **限流按条数计费**（默认配额 10，小于默认页大小 50）⇒ 全选本页再删**必然** 429。
   改为**按请求计费**（一次批量扣 1），默认配额 10 → 60；条数上限仍由 200 单独约束。
2. **面板批量删逐条发 N 个请求**（`for … await requestDelete(id)`）⇒ 50 行 = 50 请求，
   叠加 ①后表现为「删一半就全失败」。改为**一次** `/delete {sessionIds}`。
3. **`registryCleared` 是编造的数字**：`unpinSession`/`unarchiveSession` 对未记录的 id
   是幂等 no-op（契约原文 "resolves without writing"），旧实现把「调用返回」当成
   「改了一条」。改为 `{ attempted, resolved, changed: null, skipped }` —— `changed` 恒为
   `null`（公开 API 不报告是否写入，**不猜**）。

#### 性能修复（同机、同成本模型实测）

| 路径 | 50 条耗时 |
|---|---|
| 串行（并发 1，无缓存）= 旧行为 | 3688 ms |
| 分片并发 4（冷缓存） | **943 ms** |
| 分片并发 4（热缓存，第二次） | **0 ms** |
| `titleLimit=0`（完全不取标题） | 1 ms |

两条路径的标题结果**完全一致**（已断言）。三重手段：缓存（`titleCacheTtlMs`，负结果也缓存）、
分片并发（`titleFetchConcurrency`）、每页上限（`titleLimit`）。
删除时按 sessionId 及其对偶拼写主动失效缓存。

#### 新增回归测试（4 条）

- `routes：批量删除按**请求**计费…` —— 配额 1 时批量 50 条必须 200（旧实现必 429），
  且随后的写请求仍 429（限流没被废掉）。
- `listSessions：标题有缓存…` —— 第二次请求零读取，且标题与首次一致。
- `listSessions：titleLimit=0…` —— 零读取、`titles.skipped=true`。
- `面板批量删除：只发一次 requestDeleteMany…` —— 结构断言，防退化成 N 个请求。

同时把 4 条**断言旧行为**的用例改为断言新契约（其中 2 条 `clearRegistryRecords`、
1 条 `registryCleared`、1 条标题调用次数）。

> **诚实声明（已更新）**：宿主重启过一次，上述修复**已在 live 上复测通过**：
>
> | 复测项 | 修复前 | 重启后 live 实测 |
> |---|---|---|
> | `POST /delete {sessionIds:[50 个]}` | 429 rate-limited | **200**，`total:50 ok:50` |
> | `POST /delete {sessionIds:[200 个]}` | 429 rate-limited | **200**，`total:200 ok:200` |
> | `POST /delete {sessionId:"不存在的id"}` | 200 + 编造的 `registryCleared:2` | 200 + **`{attempted:2,resolved:2,changed:null}`** |
> | `/list?pageSize=5` 二次请求 | 每次都重新读盘 | `titles.cached=5, fetched=0`（**命中缓存**） |
>
> **注意 live 当前仍落后磁盘一代**：`/status` 报 **14** 个配置项（无 `runningProbeTtlMs`），
> 磁盘是 **15** 个。即批量探测 O(N)→O(1) 那一项**尚未生效**，需再重启一次。
> 判定依据仍是 **config 形状**（版本号两边都是 `1.0.0`，不能用来区分）。
> 已确认软链接指向的磁盘源码为新版（`node_modules/dsh-dialogue-cleanup`
> → `E:\Code\dsh-plugin-market\dsh-dialogue-cleanup`）。


---

## 6. 未做的验证（明确声明）

| 未做 | 原因 | 依据 |
|---|---|---|
| **视觉验证**（明暗主题、令牌实际取值、弹窗外观、交互手感） | 本环境无浏览器控制 | R-42 / `references/verification.md` |
| 真机删除一个真实会话（端到端破坏性动作） | 会不可逆地销毁用户的真实会话数据；改以隔离临时目录的端到端单测覆盖事务全路径 | 风险控制 |
| `dsh.client.inject` 写不存在包是否硬失败（B 项） | 需要一次破坏性安装试验；已按「不写不存在包」规避 | 保守处理 |

> **没有浏览器控制时，验证只能覆盖 JavaScript 语法、清单校验与 live Client slot 注册**，
> 并明确声明视觉验证不可用 —— 本报告即按此口径书写。

---

## 7. 与上游的差异（诚实对照）

| 维度 | 上游 `dsh-session-cleaner@1.0.2` | 本实现 |
|---|---|---|
| UI 挂载 | `MutationObserver` + `appendChild` 到宿主 Portal 菜单（违反 R-20/R-22/R-25） | `sidebar.workspaces.session.menu.item` slot + `shell.overlay`（合规） |
| 定位方式 | `[role="treeitem"]` / `[class*="sessionRow"]` / span 文本撞标题 | slot props 直给 `sessionId` |
| 同名标题 | 歧义时**不显示**按钮（功能缺失） | 无歧义，全部会话都有入口 |
| HTTP 状态码 | **写死 200** | 语义化 400/403/404/405/409/429/500 |
| 同源 / CSRF | **无** | 冻结五步判定 |
| 读体上限 / 超时 | 1 MiB / **无超时** | 64 KiB / 10 s |
| Config | **无**（阈值全硬编码） | 15 个可调项 |
| 幂等 | **无**（并发计数虚高） | `Map` 单飞 |
| 计数 | `detachSession?.()` 后无条件 +1（D7 虚高） | 只在调用成功时 +1 |
| 注册表清理计数 | —（上游无此项） | 如实 `{attempted, resolved, changed:null}`，不把 no-op 当成功 |
| 批量删除 | **逐条删**（同名标题直接不显示按钮） | 一次请求批量；限流按**请求**计费，不会挡住全选本页 |
| 列表取标题 | —（上游无面板） | 缓存 + 分片并发；50 条 3688 ms → 943 ms（热缓存 0 ms） |
| 内部 API | `fiber._unload()`（Cordis private）、`sessions.store` | 不碰 `_unload`；`store` 仅作降级并如实上报 |
| 审计 | **无** | JSONL 审计 |
| 测试 | **0** | 147 条 |
| 磁盘拼写 | 只认精确 id（带前缀的目录永远删不掉） | 对偶拼写 + 存在性守卫 |
| 符号链接 | 未防护 | 明确拒绝 |
| 投影缓存 | 不处理 | 默认一并删除 |

---

## 8. 风险与已知限制

1. **`detached` 可能为 false** —— 公开面没有 `detach`；此时界面与响应都如实显示
   「内存条目未摘除（降级：只删了磁盘）」。这是**如实降级**，不是 bug。
2. **空闲但有 agent 的会话会被拒绝** —— 公开面没有停止入口。用户需先在界面关闭该会话。
3. **`isInside` 在 Windows 上按平台折叠大小写**；其余平台按字节比较。
4. **删除不可逆**：UI 强制二次确认并标注「不可恢复」，且确认框默认按钮不是「永久删除」。
5. **审计写入失败不影响删除结果**，但会在响应 `value.audit.ok=false` 与 UI 中明确显示。

---

## 9. 交付前修复的两个 UI 缺陷（用户实测反馈）

### 9.1 鼠标悬停在「删除所选」上文字消失

**根因（已用优先级别算脚本实测，非推测）**：

| 规则 | 优先级 | 声明 |
|---|---|---|
| `.dscc-btn:hover` | **(0,2,0)** | `background: --dsw-alias-bg-layer-2`（浅色面） |
| `.dscc-btn-danger` / `.dscc-btn-primary` | **(0,1,0)** | `color: --dsw-alias-bg-base`（文字＝应用底色） |

hover 的 (0,2,0) **压过**变体的 (0,1,0) 实心背景，但文字色仍是变体声明的
「应用底色」⇒ 浅色面 + 底色文字 = 对比度≈0。

修法：换底只作用于中性按钮（`:not(.dscc-btn-primary):not(.dscc-btn-danger)`），
变体改用 `filter: brightness(1.12)` —— 文字与背景同步等比变化，对比度保持。

### 9.2 确认框弹出后不在最上层

**根因**：旧实现只有 `position: fixed; inset: 0`，**没有 z-index、也没进 top layer**；
而本插件从**设置页**打开，设置面板本身是高层级浮层，普通定位元素盖不过它。

官方 `Modal` 用 `createPortal` 到 `document.body` 逃出祖先层叠上下文，
但 practices.md §36 **明确禁止**把 DOM 挂到组件外／`document.body`。
故改用 **原生 `<dialog>` + `showModal()`**：进入浏览器 **top layer**，
层级高于任何 z-index，**不需要 portal，也不用猜宿主 z-index 刻度**。

附带修掉两个可访问性缺陷：原生对话框自带焦点陷阱与 Esc 语义，
原先「Esc 泄漏给宿主」与「Tab 走到背后页面」随之消失。

**同时纠正自查引入的错误**：原生 `<dialog>` 已隐含 `role="dialog"`，
内层卡片不得再声明，否则形成**嵌套 dialog**。语义现在只挂外层。

**另一个实测约束**：官方 `Builtin` 给 Client 的 React 只保证
`createElement`/`useState`/`useEffect`，**没有 `useRef`** ——
对话框 ref 改用 `useState` 惰性初始值（求值一次、身份跨渲染稳定）。

### 9.3 变异测试（证明回归测试有效，不是装饰）

| 注入的故障 | 预期失败 | 实测 |
|---|---|---|
| 恢复裸 `.dscc-btn:hover` 换底 | 悬停回归 | ✅ 1 条失败 |
| 退回普通 `div`（不进 top layer） | 对话框回归 | ✅ 1 条失败 |
| 内层卡片重新声明 `role` | 嵌套 dialog 回归 | ✅ 1 条失败 |

> **仍未能验证的**：以上两处都是**视觉/层叠**行为，本环境无浏览器控制，
> 无法截图确认「看起来对了」。已验的是结构契约（选择器优先级、`<dialog>`、
> `showModal()` 调用路径、无嵌套 role）——**不等于**渲染结果一定正确，
> 按 R-42 如实声明。请在浏览器中刷新确认。

---

## 15. 代码质量检查 + 性能优化（含负结论）

用户：「检查代码质量 优化性能」。方法：**先测量，再动手** —— 只改有实测证据的问题。

### 15.1 性能：实测发现并修复 3 处

**① 两份独立数据源串行 await → 并行（省 36–50 ms/请求）**

`sessionQuery.listSessions()`（语料）与 `sessionController.list()`（摘要）互相独立
（后者不需前者的结果），旧实现串行 await。

| | 总耗时 | 第二次调用滞后 |
|---|---|---|
| 旧（串行） | 138 ms | 22 ms ← 纯白等 |
| 新（并行） | **126 ms** | 0 ms |

调用交错顺序实测：`corpus:start → summary:start → corpus:end → summary:end`
（摘要确实在语料结束**之前**开始）。两个分支各保留独立 `try/catch`，
**降级语义完全不变**。

**② 标题取数并发默认 4 → 8（首屏 1.79×）**

`readTitleSnapshots` 约 65 ms/条且组内串行，是本插件唯一可观的 I/O。
实测默认首屏（50 行）：

| 并发 | 1 | 2 | 4 | 8 | 12 | 16 |
|---|---|---|---|---|---|---|
| 50 行 | 3752 ms | 1906 ms | 970 ms | **540 ms** | 356 ms | 295 ms |

端到端复测（真实 65 ms/条 + 100 ms 摘要底噪，40 行）：**884 ms → 495 ms（1.79×）**。

**③ 同一份 Map 被物化 3 次 → 1 次**

`Array.from(rows.values())` 在筛选/归档计数/子代理计数处各调一次。改为物化一次
`allRows` + 单次 for 循环算三个计数。（Host CPU 本就很小：1000 行约 2 ms，
故这是**整洁性修复**，非关键提速。）

### 15.2 性能：实测后**决定不改**（负结论）

`formatTime` 每行调 2 次、每次 `new Date().toLocaleString()`，看似热点。
Edge 无头实测 200 行（400 次/渲染）：

| 方案 | 每次渲染 |
|---|---|
| 现状 `toLocaleString()` | 0.40 ms |
| 单例 `Intl.DateTimeFormat` | 0.40 ms |

**提速 1.00× —— 无收益，保持原样。** 否则会白白引入全局格式化器
（还要处理 locale 切换失效）却毫无收益。

### 15.3 代码质量：检查过、确认无问题的项

| 检查项 | 结论 |
|---|---|
| TODO / FIXME / HACK / `@ts-ignore` | **0 处** |
| 运行时依赖 | **0 个**（零依赖自实现） |
| 死导出（33 个 export 全查） | 无，每个都被 lib 或 test 引用 |
| 全局变量泄漏 | 无（初查 30 处命中全是多行 `const`/`let` 误报） |
| `fetchList` 网络异常 | 正确（`try/catch` → `network` 码，不会卡 loading） |
| 客户端监听器泄漏 | 无（`useReloadSignal` 的 effect 正确退订） |
| 限流器无界增长 | 无（固定窗口） |
| 标题缓存容量控制 | 有（>5000 条按 TTL×4 清理） |

另修掉一处排版缺陷：`lib/service.js` 分页段两条语句挤在同一行。

### 15.4 新增 2 条性能回归断言 + 变异验证

断言的是**调用交错顺序，不是墙钟时间** —— 避免慢 CI 上调度抖动误报：

1. **并行性**：`summary:start` 必须出现在 `corpus:end` 之前。
2. **降级不变**：语料抛错时请求仍成功、`sources.corpus === "none"`、摘要仍生效。

| 变异 | 结果 |
|---|---|
| `Promise.all` 改回串行 await | ✅ 被「并行」断言抓到 |
| 语料失败时 rethrow（不降级） | ✅ 被抓到（5 条失败） |

测试总数 145 → **147**；`node --check` 11 个文件全过；临时基准脚本用完即删。

---

## 14. 设置页导航图标（齿轮）—— 负结论：官方无扩展点

用户要求把设置页左侧「对话清理」前的**齿轮**换成小扫把。

**结论：做不到（官方未提供扩展点），已与用户确认保持齿轮，代码未改。**
此处记录排查过程与取证，避免重复劳动。

### 14.1 根因（实证）

图标不是插件注册的，而是官方 `@deepseek-ai/dsh-client-ui-settings-general`
**硬编码**的一张 id→图标表：

```js
/** Nav glyph by section id; unknown ids fall back to the settings gear. */
function navIcon(id) {
  if (id === "account")           return IconUserOutlineMedium;
  if (id === "models")            return IconDataOutlineMedium;
  if (id === "agent-presets")     return IconAgentPresetOutlineMedium;
  if (id === "plugins")           return IconPersonalizationOutlineMedium;
  if (id === "archived-sessions") return IconArchiveOutlineMedium;
  return IconSettingsOutlineMedium;   // ← 本插件 id 不在表里
}
```

### 14.2 三项核对（均确认无扩展点）

取证方式：自写 asar 读取器（解析 header → 按 offset 取文件，无需解包 121MB）
导出官方 `lib/client.js` 阅读源码，并与 `cordis_inspect_query` 的 Slot 契约交叉验证。

| 检查项 | 结果 |
|---|---|
| `settings.section` 注册选项（官方 Slot catalog） | **只有 `id` / `order` / `label`**，无 `icon` |
| 全部 **98** 个 Slot 契约中与 icon/glyph 相关的槽 | **没有任何**一个能提供设置页导航图标 |
| 导航行 DOM（官方 JSX 原文） | `<button class=navCell>{navIcon(row.id)}<span>{label}</span></button>`，**无 `data-*` 锚点** |

> 附注：`sidebar.panellist` 确实承载「全局面板图标」，但那是主面板侧栏的槽，
> 与设置页导航行（`settings.section` → `navIcon`）是两条独立路径，不能复用。

### 14.3 被否掉的方案与理由

| 方案 | 否决理由 |
|---|---|
| CSS 伪元素 + 位置选择器替换 | 依赖导航行**序号**；官方增删设置页时扫把会错位到别的行。为装饰性需求引入此脆弱性不划算 |
| 借用官方 id（如 `archived-sessions`） | 能命中官方图标表，但 id 同时决定导航语义，副作用大于收益 |
| **保持齿轮**（采纳） | 官方设计如此：未知插件统一给齿轮。零脆弱性、零误解 |

**代码改动：无。** 该轮调研未改动任何源码（当时测试为 145/145，全绿）。

---

## 13. 标签「分散对齐」—— 首次做到真实渲染验证

用户给参考图（「班级」被拉开到与「指导教师」等宽）：「字体对齐是这样的」。

### 13.1 我上一轮理解错了

第 12 轮我做的是**左对齐**：所有标签左边缘齐，但 2 字标签右边空一大块，
观感上仍然「没对齐」。中文表单惯例是**两端顶格** —— 字数少的标签摊开字距，
占满与最长标签相同的宽度。

### 13.2 改法与关键点

| 项 | 值 |
|---|---|
| 标签列宽 | 68px → **48px**（= 最长标签「会话类型」4 字 × 12px） |
| 标签对齐 | `text-align: justify` + **`text-align-last: justify`** |
| 标签宽度 | `width: 100%`（占满定宽列，否则撑不开） |

**`text-align-last` 是必需的**：标签只有一行，而 `text-align: justify`
默认**不作用于最后一行** —— 单行文本「全是最后一行」，不加它 `justify` 完全不生效。

### 13.3 真实渲染验证（本项目首次）

此前所有 UI 断言都是**读源码正则**，从未真正渲染。这次发现本机有 Edge，
用 `--headless=new` 起真实 Blink，从 `client.js` **直接抽取 CSS**（不手抄），
量取几何：

| 标签 | 字数 | 标签列宽 | 墨迹宽（改前 → 改后） |
|---|---|---|---|
| 项目 | 2 | 48px | 32px → **48px** |
| 状态 | 2 | 48px | 32px → **48px** |
| 会话类型 | 4 | 48px | 64px → 48px |
| 归档 | 2 | 48px | 32px → **48px** |
| 排序 | 2 | 48px | 32px → **48px** |

10/10 断言通过（含「CSS 真的生效」自检：`display:grid`、4 轨、12px 字号），
并生成截图目视确认「项　目」「状　态」「归　档」「排　序」两端顶格。

### 13.4 顺带抓到我反复犯的错误

首次测量 7 条断言**全挂**，自检显示 `display:block`、字号 `16px` —— CSS 根本没解析。
原因：我在 CSS 注释里写了 Markdown 行内代码的反引号，而 CSS 在 JS 模板字符串里，
**一个反引号就提前终止模板串**，整个 `client.js` 语法错误。

这是**第三次**犯同一个错（前两次在布局返工、`nowrap` 修复时）。
已加带行号的断言并变异验证：

```
AssertionError: CSS 第 182 行含反引号（会提前终止模板串）：注意 `white-space` 的用法。
```

> 诚实标注：脚本与截图用完即删（不留临时物），上表是当时的实测输出。
> 本轮验证覆盖的是**筛选区几何**；面板其余部分（列表、弹窗）仍为结构断言。

---

## 12. 字宽与按钮被压扁（第三轮 UI 修正）

用户第三次截图：「字宽统一一下 比例项 目 状 态改成和对话类型等宽吧」。
截图暴露两个可复现的具体缺陷。

### 12.1 「刷新」被压成竖排「刷／新」

**根因是两层叠加**：

1. `.dscc-input` 是**通用**规则，带 `width: 100%`（服务于网格里占满整列的控件）。
   它被当作 flex 行的搜索框时**独占整行**，把按钮挤到 `min-content`。
2. 中文可在**任意字符**处断行，`min-content` 就是**一个字宽** → 「刷新」竖排。

**修法**：
- 搜索框在 flex 行里显式 `width: auto`（宽度交给 flex 分配）；
- 按钮 `flex: none`（不收缩）；
- `.dscc-btn` 基类加 `white-space: nowrap`（所有按钮统一不许断行）。

### 12.2 标签左边界参差

「项目／状态／排序」2 字 vs「会话类型」4 字；原来 **右对齐** ⇒ 右边缘齐、左边缘参差。
改为**左对齐**，所有标签共享同一左边界。控件列 150px → 152px，容下「隐藏已归档」不折行。

### 12.3 顺带纠正一条我自己写错的测试（重要）

上一轮我加了「CSS 模板串内不得有裸反引号」的断言 —— **它不可达**。
实测：注入裸反引号后整个文件语法错误，**全部**测试一起崩，
那条断言根本不会执行（注入后反引号数 188，全量测试失败）。

已替换为**真正可达**的「CSS 括号配平 + 关键规则齐备」断言：

| 变异 | `node --check` | 该断言 |
|---|---|---|
| CSS 内注入多余 `}` | ✅ **通过**（静默吞掉后续规则） | ✅ **失败**（抓到） |

这条恰好证明：语法检查**抓不到**多余的 `}`，只有该断言能抓 —— 不可被替代。

### 12.4 变异测试汇总（本轮）

| 注入的故障 | 预期失败 | 实测 |
|---|---|---|
| 按钮去掉 `nowrap` | 按钮不竖排 | ✅ 1 条失败 |
| 标签改回右对齐 | 字宽统一 | ✅ 1 条失败 |
| CSS 注入多余 `}` | 括号配平 | ✅ 1 条失败（且 `node --check` 通过） |

> 仍未能验证：**外观**。本环境无浏览器控制，以上均为结构/契约断言 ——
> 证明「不会竖排」「左边界对齐」「规则齐备」，**不等于**渲染出来一定好看。
> 按 R-42 如实声明。

---

## 11. 会话清单逻辑修正（「会话逻辑也不对」）

### 11.1 根因

官方 `dsh-client-ui-workspace` README 明文规定：

> 「**侧边栏隐藏持久化摘要中带有 `origin: 'subagent'` 的行。**」

依据 `SessionHeader { … origin?: 'subagent'; delegationDepth?: number; parentSession?: SessionId }`。
旧实现把 `sessionQuery.listSessions()` 的全部记录直接列出 ⇒ 子代理会话混入普通清单。

### 11.2 用真实数据量化（读本机全部 header，非估计）

| 本机真实会话 | 数量 |
|---|---|
| 磁盘总数 | **40** |
| `origin === 'subagent'` | **19（47.5%）** |
| 主会话 | **21** |

修复前 live `/list` 返回 **39** 条（近一半是子代理）；
修复后默认应返回 **21** 条主会话。

### 11.3 修法：新增 `kind` 三选一，默认与官方一致

| 取值 | 含义 |
|---|---|
| `main`（**默认**） | 只显示主会话 —— 与官方侧栏一致 |
| `subagent` | 只看子代理会话 |
| `all` | 全部（含子代理） |

`main` / `subagent` 是本插件特有入口（官方一律隐藏，不给选择）——
因为子代理会话同样占磁盘、同样需要清理，而批量清理它们正是本插件的用途。
响应回传 `kind.subagentTotal` / `mainTotal`，界面如实告知默认隐藏了多少行。

**子代理 ≠ 不可删除**：可见性只是可见性，数据仍在磁盘，已加断言锁定。

### 11.4 变异测试

| 注入的故障 | 预期失败 | 实测 |
|---|---|---|
| `main` 不再隐藏子代理 | 默认可见性回归 | ✅ 1 条失败 |

### 11.5 诚实声明

- 11.1–11.4 是**静态契约 + 单测**证据；`kind` 的 live 端点行为**尚未复测**
  （需重启宿主加载新代码）。
- 「官方默认隐藏子代理」有 README 原文直接支撑，不是推测。
- 本机 40 条中 19 条为子代理，说明这个缺陷的实际影响面接近一半。

---

## 10. 归档分类（交付前新增）

### 10.1 取证：归档状态到底在哪

**先确认「不在哪」**（避免臆造字段）：

| 候选来源 | 结论 | 证据 |
|---|---|---|
| `SessionSummary` | ❌ 无 `archived` 字段 | 契约字段仅 `agentAvailable / sessionId / updatedAt / running / blank / parentSessionId / origin / cwd / projections` |
| `workspaceRegistry` 公开面 | ❌ 无集合读取器 | 公开方法仅 create/list/get/delete/insertBefore/archiveSession/unarchiveSession/pin/unpin/resolveByPath |
| `sessionQuery` | ❌ 无归档字段 | `SessionRecord { header, live, persisted }` |

**正确的来源**：官方 `@deepseek-ai/dsh-workspace` README 原文 ——
「注册表打开 `workspace` 领域（版本 2）：一张以 `WorkspaceId` 为键的 `workspaces` 表，
加上一个持有 `workspaceIds`、**`archivedSessionIds`**、`pinnedSessionIds`…的全局状态」。

官方客户端读法：`useWorkspaces(state => state.archivedSessionIds)`（客户端快照）。
Host 侧对应入口：`storageDomain.get("workspace").global`。
**不能** `open("workspace")` —— 领域已被 dsh-workspace 打开，重复 open 抛 `already-open`。

### 10.2 语义：照官方三选一，不自创

官方 README：「视图选项以一组显式三选一控制显隐：**隐藏已归档**（默认项）…
**全部对话（显示已归档）**…**仅显示已归档**则隐藏普通 Session」。
本插件取值与文案一并照搬：`default` / `show` / `only`。

### 10.3 变异测试（证明新增回归有效）

| 注入的故障 | 预期失败 | 实测 |
|---|---|---|
| `default` 不再隐藏归档 | 归档默认语义 | ✅ 1 条失败 |
| 不可知却谎报 `known:true` | 诚实降级 | ✅ 1 条失败 |

### 10.4 边界与诚实声明

- **归档 ≠ 不可删除**：归档只是从侧栏隐藏，数据仍在磁盘；删除才是销毁。已加断言锁定。
- **不可知 vs 空**：`storageDomain` 不可读时返回 `known:false`，**不**谎报成「没有归档」，
  也**不**隐藏任何行（否则用户会看不到任何会话）。已加断言锁定。
- **本机实数据**：`<DSH_HOME>/storages/workspace.json` 的 `global.archivedSessionIds`
  实测 **18** 条 —— 重启后可用它交叉验证 `/list?archived=only` 的 total。
- ⚠️ **live 尚未验证**：`/status` 仍报旧一代（无 `capabilities.archivedFilter`），
  需**重启宿主**加载新代码。10.1–10.3 都是静态契约 + 单测证据，不是 live 实测。
