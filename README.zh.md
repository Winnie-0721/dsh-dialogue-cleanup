<h1 align="center">dsh-dialogue-cleanup</h1>

<p align="center"><a href="./README.md">English</a> · <strong>简体中文</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-dialogue-cleanup"><img alt="npm version" src="https://img.shields.io/npm/v/dsh-dialogue-cleanup?label=npm" /></a>
  <a href="https://www.npmjs.com/package/dsh-dialogue-cleanup"><img alt="npm downloads" src="https://img.shields.io/npm/dt/dsh-dialogue-cleanup?label=downloads%20total" /></a>
  <a href="https://github.com/Winnie-0721/dsh-dialogue-cleanup/releases/latest"><img alt="GitHub release" src="https://img.shields.io/github/v/release/Winnie-0721/dsh-dialogue-cleanup" /></a>
  <a href="https://github.com/Winnie-0721/dsh-dialogue-cleanup/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/Winnie-0721/dsh-dialogue-cleanup" /></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg" /></a>
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img alt="DeepSeek Harness 0.2.0-rc.2" src="https://img.shields.io/badge/DeepSeek%20Harness-0.2.0--rc.2-blue" /></a>
</p>

<p align="center"><strong>在运行中的 DeepSeek Harness Web 界面里删掉会话 —— 不用重启，也不用离开当前窗口。</strong></p>
<p align="center">会话行 <code>...</code> 菜单里一项做单条删除，另有一页批量管理面板挂在设置页里。</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/Winnie-0721/dsh-dialogue-cleanup/main/docs/assets/panel.png" alt="设置页里的批量管理面板：搜索、筛选、逐行状态徽标与 16 行会话" width="760" />
</p>

<p align="center">
  <a href="#快速开始"><strong>安装</strong></a> ·
  <a href="#界面速览">界面</a> ·
  <a href="#它怎么实现的">实现</a> ·
  <a href="docs/RELEASING.md">发布流程</a> ·
  <a href="https://github.com/Winnie-0721/dsh-dialogue-cleanup/releases/latest">Releases</a>
</p>

## 为什么会有它

**一句话定位：删会话就该真的删掉。** DeepSeek Harness 把一条会话同时放在四个地方 ——
内存 live 条目、工作区记录、注册表残留（pin / archive）、以及磁盘上的目录。只清掉其中一处，
留下的就是一行幽灵会话、一条过期的工作区记录，或者一个还在悄悄占磁盘的目录。
下面每一条，都是这个定位的具体落实：

- **一个不可逆操作，只实现一次。** 删除逻辑在宿主（`lib/service.js` 的 `deleteSession`），
  由两个薄适配层通向它 —— HTTP 契约与 slot UI —— 因此单条删除与批量删除**不可能各自漂移**。
- **运行中的会话是「拒绝」，不是「猜」。** `deletable` 由宿主判定，UI 不去猜；宿主会拒的，界面根本不给选。
- **已归档默认仍然显示。** 归档**不等于**删除：归档会话照样占磁盘，默认藏起来恰好会藏掉你想清理的那些。
  （官方侧栏默认隐藏；这里是三选一 —— `隐藏已归档` / `全部对话` / `仅显示已归档`，且**默认显示已归档**。）
- **子代理行明确标注。** 官方侧栏把 `origin: 'subagent'` 的行整个藏起来，所以一旦这些行出现
  （kind = 子代理 / 全部），每一行都会显式打上徽标 —— 子代理会话绝不能看起来像普通对话。
- **它如实汇报做了什么。** 结果行给出 成功 / 失败 / 降级 / 删掉的目录数，每条失败原因**原样保留**。
  摘不掉 live store 条目时，插件报 `detached: false`，而不是假装成功。
- **错误码是语义正确的。** 与上游包（永远回 `200`）不同，这里用真实状态码：
  400 / 403 / 404 / 405 / 409 / 429 / 500。

## 界面速览

**确认框：不可逆，并且明说。** 只有两条关闭路径 —— 显式「取消」按钮，或 `Esc`。
点击遮罩**故意不关闭**：一次误点不该让你损失一次确认机会。

<p align="center">
  <img src="https://raw.githubusercontent.com/Winnie-0721/dsh-dialogue-cleanup/main/docs/assets/confirm.png" alt="删除确认框：永久删除警告、会话 id，以及「取消」/「永久删除」按钮" width="440" />
</p>

这个浮层是**原生 `<dialog>` + `showModal()`** 驱动的，因此进入浏览器的 **top layer**，
能盖在打开它的设置面板之上（普通定位元素做不到）。同时白送真正的焦点陷阱与正确的 `Esc` 语义，
而且**不需要**把 DOM 挂到组件树之外。

**批量面板（挂在设置页）** —— 搜索、项目 / 状态 / 会话类型 / 归档四组筛选、排序、分页，
以及逐行状态徽标。上面截图里的徽标（`空闲` / `运行中` / `子代理` / `已归档`）来自真实渲染输出：
`运行中` 的行不可勾选。

> 两张截图都由 `scripts/render-shot.mjs` 从**真实组件树 + 真实 CSS** 生成，
> 再用无头 Edge 栅格化 —— 不是手画的示意图；但也**不是**在运行中的 GUI 里拍的照片，
> 详见下面的[已知限制](#已知限制)。

## 快速开始

```sh
dsh plugin --profile web add dsh-dialogue-cleanup
```

1. **单条删除** —— 鼠标移到侧栏的会话行，打开 `...` 菜单选 **删除会话**
   （注册在 `order: 500`，紧跟官方 archive 项 = 400 之后）。确认框弹出后确认，
   即清掉 live 条目、工作区记录、注册表残留与磁盘工件。
2. **批量删除** —— 打开 **设置 → 对话清理**。勾选若干行（或「全选本页可删除项」），一次请求删完。
3. 宿主半改动需要**重启** DSH 进程；客户端半不需要（见 [docs/RELEASING.md](docs/RELEASING.md) 的表）。

> 兼容 DSH **0.2.0-rc.2**。npm 包与 GitHub Release 一起发布；
> 版本号规则与发布链路见 [docs/RELEASING.md](docs/RELEASING.md)。

## 它怎么实现的

一个 npm 包同时装两半，按官方插件规范装进宿主：

- **宿主半（仓库进程）** —— `lib/index.js` 是 Cordis 函数插件，只具名导出
  `name` / `inject` / `apply`；它注册一条 `ctx.webServer` 前缀路由，删除实现全部留在
  `lib/service.js`。磁盘删除与路径约束在 `lib/artifacts.js`，审计在 `lib/audit.js`。
- **客户端半（浏览器）** —— `client.js`，单文件 bundle，经
  `window.__ModuleLoader__.load({ id, factory })` 注册，**除 `require("react")` 外零依赖**。
- **两个入口都是官方 slot，都不碰 DOM：**
  - `sidebar.workspaces.session.menu.item`，`order: 500` → 单条删除那一项。
  - `settings.section`（`id: dialogue-cleanup`，`order: 25`，排在官方
    `account(-10) / general(0) / models(10) / plugins(15) / agent-presets(20)` 之后）
    → 入口**和**面板。一个注册项 = 设置里的一页，内容渲染在设置面板的**内容列**里。
- **面板因此不需要 `layout` 服务**，也不往 `main` / `sidebar` 抢位置 ——
  少一个可选依赖、少一处降级分支。
- **样式表跟着组件走。** 菜单项把 `<style>` 渲染在**自己的树里**
  （这就是本项目自查发现的 H1：那一行原本完全没样式，因为样式表只在设置页路径上注入过）。

### 删除的六个步骤

1. **拒绝运行中的会话** —— 409 `refused`。
2. **摘掉 live store 条目** —— 否则删掉的会话会以幽灵行留在界面上。
3. **清理工作区记录** —— 只统计真正摘掉的那些工作区。
4. **清注册表残留** —— pin / archive 记录，走公开的幂等 API。
5. **删除磁盘工件** —— `<DSH_HOME>/sessions/<project>/<sessionId>`，外加派生的投影缓存。
   **每个目录真正 `rm` 之前还会再判一次运行态**（见下）。
6. **写一行审计** —— `<DSH_HOME>/logs/dialogue-cleanup.jsonl`。

#### 为什么第 5 步要「再判一次」

第 1 步判定到第 5 步真正删除之间存在时间窗。窗口内会话可能**开始运行**，
那就删掉了一个正在用的会话 —— 不可逆。

DSH 本身有内核级会话写锁（`SessionWriteLease`，Windows 命名信号量 / POSIX fd 锁），
但它**没有暴露给插件**（唯一外部表现是 resume 时的 `session/writer-held` 错误码）。
所以本插件拿不到原子互斥，只能采用**公开 API 下最保守的策略**：
在**每个 `rm` 之前**紧贴地再判一次运行态，把窗口从「整个事务」压到「单次探测 → rm」。
二次确认判定 running 或状态不可知时**拒绝删除该目录**，并如实进 `degradations`
（`step: "preDeleteRecheck"`），绝不静默当成 idle 删掉。

> **残余风险如实说明**：窗口被压到单条语句级，但**不为零**。彻底消除需要宿主把
> 写锁挂到公开服务上。详见 [docs/删除安全残留分析.md](docs/删除安全残留分析.md)。

#### 删除是不可逆的

没有回收站、没有撤销。确认框里明说这一点，并且只有两条关闭路径（显式「取消」或 `Esc`）。
`运行中` 的行不可勾选 —— 宿主会拒的，界面根本不给选。

### 批量删除部分失败时怎么重试

批量结果是逐条的，不会因为一条失败就整批回滚。返回里有：

| 字段 | 含义 |
|---|---|
| `requested` / `duplicates` / `total` | 你提交了几条 / 其中重复几条 / 实际处理几条（重复 id 已去重） |
| `ok` / `fail` | 成功 / 失败条数 |
| `complete` / `degraded` / `noop` | 完整成功 / 成功但有降级 / 什么都没删到 |
| `allComplete` | 整批全绿才为 `true`；任一子项有降级即 `false` |
| `outcomes[]` | 逐条：`outcome`（`deleted`/`noop`/`refused`/`blocked`/`failed`）+ `retryable` |
| `retry[]` | **只含需要重试的 id**（失败或降级的），已完整成功的不在内 |
| `degradations[]` | 逐条降级明细（`sessionId` + `step` + `reason`） |

**重试方法**：把 `retry` 数组原样作为下一次 `sessionIds` 提交即可 ——
不要重跑整批，那样会把已完整成功的条目再做一次无意义的操作。
`refused` 的条目要先在界面上关掉那个会话（或等它跑完）再重试；
`noop` 的条目**不需要**重试（它本来就不存在）。

## HTTP 契约

| 方法 | 路径 | 用途 |
|---|---|---|
| `POST` | `/api-ext/dialogue-cleanup/delete` | `{ "sessionId": "..." }` 删一条；`{ "sessionIds": [...] }` 批量删（宿主逐条走同一个 `deleteSession`，返回逐条结果） |
| `POST`/`GET` | `/api-ext/dialogue-cleanup/list` | 会话行，带 `deletable` / `blockedReason` |
| `GET` | `/api-ext/dialogue-cleanup/status` | 能力、配置、运行时路径 |

信封：`{ ok: true, value }` / `{ ok: false, error: { code, message, hint? } }`。

## 配置

所有可调项都在插件 `Config`（`lib/config.js`）里，因此用户的 patch 层能跨升级保留。
注意：匹配到的 override 会**整体替换 `config`** —— 你在意的字段要全写上。

| 键 | 默认 | 含义 |
|---|---|---|
| `maxBodyBytes` | `65536` | 请求体上限（上游：1 MiB） |
| `readTimeoutMs` | `10000` | 读体超时（上游：无） |
| `audit` / `auditPath` | `true` / `null` | 审计日志；`null` → `<DSH_HOME>/logs/...` |
| `rateLimitPerMinute` | `60` | 每分钟删除**请求**配额（一次批量算一次）；`0` 关闭 |
| `requireIdleSession` | `true` | 运行中会话拒绝逻辑的安全阀 |
| `stopIdleAgent` | `false` | 见下方「已知限制」 |
| `matchAlternateIdSpelling` | `true` | 带守卫地探测另一种 `session-` 拼写 |
| `removeProjectionCache` | `true` | 同时删掉派生的投影缓存 |
| `clearRegistryRecords` | `true` | 解除 pin / archive 残留 |
| `confirmInUi` | `true` | UI 确认（宿主不信任它） |
| `titleCacheTtlMs` | `300000` | 标题折叠缓存 TTL；`0` 关闭 |
| `titleFetchConcurrency` | `8` | 折叠标题时的分片并发 |
| `titleLimit` | `100` | 每页最多为多少行折叠标题；`0` 完全跳过标题读取 |
| `titleSearchLimit` | `40` | 搜索时**单独**的标题预算（与 `titleLimit` 独立）；预算外如实计入 `titles.truncated` |
| `runningProbeTtlMs` | `1000` | 运行态快照复用的时长。把批量删除从「O(N) 次全量清单调用」变成 O(1)；`0` 则逐条重探。**注意：删除前的最后一道判定不吃这个缓存**（见「删除的六个步骤」） |
| `auditMaxBytes` | `4194304` | 审计文件轮转阈值（4 MiB）。超过就把当前文件改名为 `.1`，旧的依次后推；`0` = 不轮转 |
| `auditRotateKeep` | `3` | 轮转保留的历史份数（不含当前文件）。超出该份数的最旧一份会被删除 |

### 审计日志在哪、留多久

默认写到 `<DSH_HOME>/logs/dialogue-cleanup.jsonl`（`DSH_HOME` 通常是 `~/.dsh`），
一行一条 JSONL。可用 `auditPath` 改位置，但路径会被规范化并**校验必须落在
`<DSH_HOME>` 之内** —— 越界配置会被**拒绝写入并如实上报**（`audit.ok=false`），
不会静默写去别处。

**保留策略**：当前文件超过 `auditMaxBytes`（默认 4 MiB）就整份改名为 `.1`，
`.1→.2`、`.2→.3`，超出 `auditRotateKeep`（默认 3 份）的最旧一份删除。
所以默认最多占用约 4 份 × 4 MiB。轮转用 rename 搬走整份，**不会截断正在写入的日志**；
轮转失败时**不阻断写入**（日志继续长总比丢审计好），只把 `rotateError` 作为降级返回。

**字段最小化**：一行只写诊断必需字段（时间 / 操作 / actor / phase / sessionId /
结果码 / 文件与缓存计数 / 耗时 / 降级步骤）。整份 `runtime`、会话标题、全量路径数组
**都不写** —— 旧实现把那些都塞进一行，实测 910 B/行；现在实测 **196 B/行**。
需要明细时按 `sessionId` 去宿主日志里查。

> 审计失败与删除结果是**两件不同的事实**：`audit.ok=false` 只表示留痕失败，
> 会进结果的 `degradations`（`step: "audit"`），但**不会**把已经执行的删除伪报成回滚。

## 已知限制

以下都是**对着真实运行时测出来的**，与上游包的假设不同。如实写出，而不是粉饰：

- **没有公开的「停掉空闲 agent」接口。** 公开的 `Agent` 类型是 `{ readonly id: SessionId }` ——
  没有 `status`、没有 `ctx`。因此上游的 `agent.status === "running"` 与
  `agent.ctx.fiber._unload()` 都不可依赖（`_unload` 是 Cordis 的**私有**方法，这里刻意永不调用）。
  「是否在跑」来自公开的 `sessionController.list()` → `SessionSummary.running`。
  仍挂着 agent、又无法安全停掉的会话会被**拒绝**，且界面会说明原因。
- **摘 live 条目是尽力而为。** 公开的 `sessions` 服务提供
  create/prepare/enter/announce/flush/get/list/fork —— **没有**公开的 `detach`。
  插件先试公开方法，再试内部 `store` 条目；两者都拿不到时如实报 `detached: false`，
  而不是宣称成功。
- **磁盘上并存两种 id 拼写。** 在同一个 `<DSH_HOME>` 里观察到：
  `...\<uuid>\session.v4.jsonl.zstd` 与 `...\session-<uuid>\session.v4.jsonl.zstd`。
  按精确 id 拼接永远删不掉带前缀的那一半。本插件**只在**能确认候选不是另一个真实会话时才探测
  另一种拼写；没有这种证据就什么都不删，宁可漏删也不误删邻居。
- **截图是真实渲染输出，不是在跑着的 GUI 里拍的照片。** 它们来自真实组件树 + 真实 CSS，
  无头栅格化；主题令牌固定为浅色，行数据是演示用的假会话。
  面板在真实主题下的样子，本仓库没有拍过。

## 开发与验收

```sh
# 全套门禁：node --check + 契约/渲染/发布等回归套件
node scripts/run-tests.mjs

# 只跑发布门禁（不改版本、不打包、不发布）
pwsh -File scripts/release.ps1 -LocalOnly

# 用真实组件树重新生成两张文档截图
node scripts/render-shot.mjs
```

> 不要写成 `node --test "test/**/*.test.mjs"`：**glob 展开是 Node 22+ 才有的**，
> 而 `engines.node` 声明 `>=20`。在 Node 20 上这句会直接报
> `Could not find '.../test/**/*.test.mjs'`。`scripts/run-tests.mjs` 由 Node 自己枚举
> `test/*.test.mjs` 再交给 `node --test`，三个版本、两个平台行为一致（CI 已覆盖）。

当前共 **278 条测试 / 17 个文件**（其中 3 条是平台相关用例，每个平台实际跑 275 条）：

| 套件 | 覆盖 |
|---|---|
| `contract.test.mjs` | 宿主 ↔ 客户端契约与 slot 声明（最大的一套） |
| `service.test.mjs` | `deleteSession` 端到端行为与否决路径 |
| `fault-injection.test.mjs` | **逐步骤故障注入**：磁盘/内存/工作区/审计/通知分别失败时不得冒充完整成功；含 §4.1 删除前二次确认竞态、§4.2 身份查询失败可观测、§4.3 链接跳过可观测、对偶拼写红线、junction 越界（静态 + 竞态） |
| `isolated-integration.test.mjs` | **隔离环境破坏性集成**：完整副作用清理、running 零改动、真实子进程 SIGKILL 中断后重启重跑、批量部分成功后重试 |
| `batch-semantics.test.mjs` | 批量语义：去重、`deleted`/`noop`/`refused`/`blocked` 可区分、精确 `retry` 清单、`allComplete` |
| `audit.test.mjs` | 审计：字段最小化、截断、轮转（含不截断正在写的日志）、并发、路径不可写/越界、禁用、配置边界 |
| `perf-regression.test.mjs` | 查询性能不退化的语义护栏：冷/热结果逐字段一致、单请求不重复读标题、N 并发只读一次、失败可恢复、指标不泄露标题与 `cwd` |
| `client.test.mjs` | 注册面、id、不跨包 require |
| `render.test.mjs` | 组件**真的被渲染**（React 替身） |
| `artifacts.test.mjs` | 路径约束、符号链接拒绝、另一种拼写的守卫、`isRealPathInside` 正反断言 |
| `session-id.test.mjs` | id 校验（不含分隔符与点号） |
| `eol.test.mjs` | 行尾，以及每个被跟踪文件都被 git 声明为 `eol=lf` |
| `release-workflow.test.mjs` | OIDC 发布结构（**反向断言**：`pack-release.yml` 不得自带发布步骤） |
| `ps-script.test.mjs` | Windows PowerShell 5.1 的 BOM / 编码坑 |
| `project-identity.test.mjs` | 一行的项目身份是**同一个字段**：显示、筛选、下拉选项全部由它派生（有 cwd 用 cwd，否则退回 workspace 路径）；大小写/分隔符变体合并成一个选项 |
| `transaction-boundary.test.mjs` | 删除与并发的交界：标题读取在途、批量里一条被拒 + 一条非法 id、审计在途/失败、投影缓存三态（正常 / 符号链接 fail-closed / 根路径异常） |
| `title-async-prototype.test.mjs` | **原型，不是生产路径**：`docs/TITLE-ASYNC-DESIGN.md` 的参考合并状态机，对「可控闸门」的假宿主验证（首屏不阻塞、不卡 pending、旧 token 被拒、已删行不复活、`empty` ≠ `unreadable`） |

另有 `test/integration-real.mjs`（**只读**真实 DSH 检查，需要活着的宿主，故不并入
`*.test.mjs` 套件）与 `test/mutate-tokens-official.mjs`（变异测试，要求 survived=0）。

其中两条是**因为对应的 bug 真的发出去过、之后才被发现**才补上的：

- **`eol.test.mjs`** —— 第一次发版时，CI（`pnpm pack`）与本地（`npm pack`）打出的字节**不一样**：
  CI 里的 `icon.svg` 与 `LICENSE` 是 CRLF，因为 `.gitattributes` 只写了 `* text=auto`，
  而 GitHub 的 Windows runner 默认 `core.autocrlf=true`。
  这条测试的**第一版漏掉了它**（它扫描的是硬编码扩展名清单，于是 `*.svg` 与没有扩展名的
  `LICENSE` 完全不在视野里）；现在改为扫**所有被 git 跟踪的文件**，并用 `git check-attr`
  读**实际生效**的属性。修的过程中还顺带抓出了 `.gitignore`。
- **`release-workflow.test.mjs`** —— OIDC 信任绑定在**工作流文件名**上，
  而「把发布步骤再写一遍」正是让另一个仓库连续两次发版失败的那个 bug。
  见 [docs/RELEASING.md](docs/RELEASING.md)。

## 仓库结构

| 路径 | 内容 |
|---|---|
| `lib/index.js` | `apply(ctx, config)` —— 组装并注册宿主路由 |
| `lib/service.js` | `deleteSession` —— 唯一的删除实现 |
| `lib/artifacts.js` | 磁盘删除 + 路径约束 |
| `lib/http.js` | 同源检查、请求体上限、状态码 |
| `lib/config.js` | `Config` schema 与默认值 |
| `lib/audit.js` | JSONL 审计 |
| `client.js` | Web 客户端半：slot 注册（菜单项 + 确认框 + 设置页 section） |
| `cordis.patch.yml` | 插入宿主半，`inject: [webServer]` |
| `.github/workflows/` | `pack-release.yml`（标签 → 门禁 → 打包 → GitHub Release）与 `publish-npm.yml`（**唯一**的 npm 发布实现，由同一次标签推送并列触发，不经 `workflow_call` 复用） |
| `docs/RELEASING.md` | 版本号规则与发布链路 |
| `scripts/release.ps1` | 版本递增 + 门禁（+ CI 打包发布） |
| `scripts/render-shot.mjs` | 重新生成文档截图 |
| `test/` | 161 条回归测试 |
| `VERIFICATION.md` | 完整验收报告 |

## 关于上游

这是对 npm 包 `dsh-session-cleaner@1.0.2` **能力边界**的合规重写，**不是**照抄它的实现。
上文「已知限制」里的每一条，都是与它的假设不同的地方。

## 许可

MIT
