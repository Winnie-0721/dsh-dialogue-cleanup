# dsh-dialogue-cleanup

在**运行中**的 DeepSeek Harness Web 界面里删除会话 —— 会话行 `...` 菜单里的一项，
一次搞定内存 live 条目、工作区记录与磁盘工件三处。

这是对 npm 包 `dsh-session-cleaner@1.0.2` **能力边界**的合规重写，**不是**照抄它的实现。
英文版见 [README.md](README.md)，完整验收报告见 [VERIFICATION.md](VERIFICATION.md)。

## 两种入口（都走官方 slot，都不碰 DOM）

**方案 A —— 会话行 ⋮ 菜单（单条删除）**

`sidebar.workspaces.session.menu.item`，`order: 500`（排在官方 archive=400 之后）。
点开是主题化确认框（`shell.overlay`），文案标明「不可恢复」。

**方案 B —— 批量管理面板（挂在设置页）**

- 入口 + 面板：`settings.section`（`id: dialogue-cleanup`，`order: 25`，
  排在官方 `account(-10)/general(0)/models(10)/plugins(15)/agent-presets(20)` 之后）。
  一个注册项 = 设置导航里的一页，内容直接渲染在设置面板的**内容列**里。
- 因此**不需要 `layout` 服务**，也不需要往 `main` / `sidebar` 抢位置 ——
  少一个可选依赖、少一处降级分支。

面板能力：

| 能力 | 说明 |
|---|---|
| 列表 | 用 `sessionQuery.listSessions()` 拿**完整逻辑语料**（含非活动/已归档），并合并 `sessionController.list()` 的 `running`/`blank`/`updatedAt` |
| 标题 | 用 `sessionQuery.readTitleSnapshots(ids)` 只对**当前页**取，带缓存 + 分片并发（实测 65 ms/条，见下） |
| 筛选 | 关键词（标题/id/项目路径）、项目下拉、状态（全部/可删除/运行中）、**会话类型三选一**（主会话 / 子代理 / 全部，默认只显示主会话——与官方侧栏一致）、**归档三选一**（隐藏已归档 / 全部对话 / 仅显示已归档，**默认显示已归档**——归档不等于删除，仍占磁盘，故与官方侧栏默认不同）、排序、分页（每页最多 200） |
| 批量删除 | 勾选多行 → **一次请求** `/delete { sessionIds }`；Host 端逐条复用同一个 `deleteSession` |
| 安全 | 运行中的会话不可勾选（Host 判定 `deletable`，UI 不猜）；全选是「全选本页可删除项」 |
| 反馈 | 聚合结果（成功/失败/降级/删掉的目录数）+ 逐条失败原因；删完自动刷新清单 |
| 成本可见 | 右下角显示 `tookMs` 与标题命中/新取数，能看出这次为什么快 |

> 「一次请求」的语义：`/delete` 接受 `{ sessionIds: [...] }`（上限 200），逐条走**同一个**
> service 实现（R-50），单条失败不影响其余；限流按**请求**计费 —— 一次批量只扣 1 个额度，
> 条数上限由 200 单独约束。两者职责分开，所以「全选本页再删」不会再被限流挡住。

## 它做什么

一个不可逆操作，**只实现一次**（Host service `lib/service.js` → `deleteSession`），
由两个薄适配层（HTTP 契约与 slot UI）共用，因此两条路径不会分叉：

1. **拒绝正在运行的会话** —— 409 `refused`。
2. **摘除内存 live 条目** —— 否则删掉文件后那一行会以「幽灵行」形式留在界面上。
3. **摘除工作区记录** —— 只在**真的** detach 成功时计数。
4. **清注册表残留** —— 用公开幂等 API 清 pin / archive。
5. **删磁盘工件** —— `<DSH_HOME>/sessions/<项目>/<会话id>`，以及派生投影缓存。
6. **写审计** —— `<DSH_HOME>/logs/dialogue-cleanup.jsonl`。

## HTTP 契约

| 方法 | 路径 | 用途 |
|---|---|---|
| `POST` | `/api-ext/dialogue-cleanup/delete` | `{ "sessionId": "..." }` → 删除 |
| `POST`/`GET` | `/api-ext/dialogue-cleanup/list` | 会话清单（带 `deletable` / `blockedReason`） |
| `GET` | `/api-ext/dialogue-cleanup/status` | 能力、配置、运行时路径 |

信封：`{ ok: true, value }` / `{ ok: false, error: { code, message, hint? } }`，
并**写对 HTTP 状态码**（400/403/404/405/409/429/500）—— 上游一律返回 200，这是硬伤。

## 配置

所有可调项都在插件 `Config`（见 `lib/config.js`），用户的 patch 层在升级后存活。
注意：匹配到的 override 会**替换整个 config**，要覆盖就得写全。

| 键 | 默认 | 含义 |
|---|---|---|
| `maxBodyBytes` | `65536` | 请求体上限（上游 1 MiB） |
| `readTimeoutMs` | `10000` | 读体超时（上游没有） |
| `audit` / `auditPath` | `true` / `null` | 审计；`null` → `<DSH_HOME>/logs/...` |
| `rateLimitPerMinute` | `60` | 每分钟删除**请求**配额（批量算一次）；`0` = 不限 |
| `requireIdleSession` | `true` | 运行中会话拒绝的安全阀 |
| `stopIdleAgent` | `false` | 见下方「诚实限制」 |
| `matchAlternateIdSpelling` | `true` | 探测另一种 `session-` 拼写（有守卫） |
| `removeProjectionCache` | `true` | 一并删派生投影缓存 |
| `clearRegistryRecords` | `true` | 清 pin / archive 残留 |
| `confirmInUi` | `true` | UI 二次确认（Host 不信任它） |
| `titleCacheTtlMs` | `300000` | 标题折叠结果缓存时长；`0` = 不缓存 |
| `titleFetchConcurrency` | `8` | 取标题的分片并发数（实测 4→8 约 1.8×） |
| `titleLimit` | `100` | 每页最多为多少行取标题；`0` = 不取（最快） |
| `runningProbeTtlMs` | `1000` | 「谁在跑」探测快照复用时长。批量删除据此从 O(N) 次全量列表降为 O(1)；`0` = 每条重探（最严格） |

## 诚实限制（都是**实测**结论，与上游假设不同）

- **没有公开的空闲 agent 停止入口。** 公开 `Agent` 类型只有 `{ readonly id: SessionId }`
  —— 没有 `status`、没有 `ctx`。所以上游的 `agent.status === "running"` 与
  `agent.ctx.fiber._unload()` 都不能依赖（`_unload` 是 Cordis 的 **private** 方法，
  本实现**刻意永不调用**）。「是否在跑」取自公开的 `sessionController.list()` →
  `SessionSummary.running`。仍有附加 agent 且无法安全停止的会话会被**拒绝**并说明原因。
- **摘内存条目是尽力而为。** 公开 `sessions` 服务只有
  create/prepare/enter/announce/flush/get/list/fork —— **没有**公开 `detach`。
  本实现先试公开方法，再试内部 `store` 条目；都拿不到就报 `detached: false`，不假装成功。
- **磁盘上有两种 id 拼写并存。** 实测同一 `<DSH_HOME>` 下同时存在
  `...\<uuid>\session.v4.jsonl.zstd` 与 `...\session-<uuid>\session.v4.jsonl.zstd`。
  上游的精确 id 拼接永远删不掉带前缀的那一半。本实现会探测对偶拼写，
  **但只在能确认它不是另一个活动会话时才删**；没有结论就什么都不删，不冒险误删邻居。

## 验收状态

`node --test "test/**/*.test.mjs"` → **147/147 通过**：覆盖路径穿越、`isInside` 边界、
符号链接拒绝、带守卫的对偶拼写规则、同源判定、读体上限与超时、状态码、幂等单飞，
以及「被拒时盘上文件不动」。

每个 JS 文件都通过 `node --check`。

**视觉未验证** —— 本环境无浏览器控制。按官方口径，验证只覆盖 JavaScript 语法、
清单校验与 live Client slot 注册；UI **长什么样**没有验证。

## 安装

```powershell
dsh plugin add E:\Code\dsh-plugin-market\dsh-dialogue-cleanup
```

或经 Plugin Manager（`install_bundle`，target 指向本目录）。

## 目录

```text
dsh-dialogue-cleanup/
├── package.json          dsh.bundle.patch + dsh.client + meta/icon
├── cordis.patch.yml      插入行，inject: [webServer]
├── icon.svg
├── locale/{en,zh}.json   展示元数据
├── client.js             slot 注册（行菜单 + 确认覆盖层）
├── lib/
│   ├── index.js          apply(ctx, config) —— 装配与路由注册
│   ├── config.js         Config schema + 默认值
│   ├── service.js        deleteSession —— 唯一实现
│   ├── artifacts.js      磁盘删除 + 路径包含校验
│   ├── http.js           同源、读体上限、状态码
│   └── audit.js          JSONL 审计
├── test/                 147 条单测/契约/渲染测试
└── VERIFICATION.md       验收报告（含 A–I 九项回填）
```

## 许可

MIT
