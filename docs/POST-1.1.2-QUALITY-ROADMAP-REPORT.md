# POST-1.1.2 整改报告（查询正确性 / 首屏体验 / 发布一致性）

- **仓库**：`Winnie-0721/dsh-dialogue-cleanup`
- **基线**：`e3090e9`（`package.json` = `1.1.2`，tag `v1.1.2` 已发布）
- **执行日期**：2026-10-20
- **原则**：先修正确性，再谈体验；不降低删除安全性；**不发布 npm、不批准 stage、不推标签、不改版本号**；
  真实宿主验收一律**只读**（本轮没有对真实宿主执行任何删除、改名、归档操作）。

---

## 0. 结论速览

| # | 任务 | 结论 | 生产代码是否改动 | 提交 |
|---|---|---|---|---|
| 1 | P0 项目筛选身份字段统一 | **确认缺陷 → 已修** | 是（`lib/service.js`） | `76d01f1` |
| 2 | P1 删除事务边界审计 | **未发现确认缺陷**（原假设被否证） | 否（只加测试钉住语义） | `1f07460` |
| 3 | P1 标题异步化设计稿 | 设计 + 原型完成，**未实现** | 否（原型只活在测试内） | `2f766ea` |
| 4 | P2 文档与仓库事实一致性 | 已对齐（含 1 处**从未记录**的配置项） | 否（仅文档） | `c1aba44` |

测试总量：**248 → 278**（17 个文件，其中 3 条平台相关，每平台实跑 275）。
全量 `node scripts/run-tests.mjs`：**278 / pass 275 / fail 0 / skipped 3 / 649.6 ms**。

---

## 1. 任务一（P0）：项目筛选身份字段统一

### 1.1 缺陷（先复现，再修）

`/list` 以前用**两个不同的字段**算同一件事（旧代码 `lib/service.js`）：

- 显示：`project: ws?.path ?? row.cwd ?? null` —— 优先用**工作区路径**
- 筛选：`items.filter((row) => row.cwd === wantProject)` —— 只比 **cwd**
- 下拉选项：另起一个循环 `for (const row of rows.values()) projectSet.add(row.cwd)`

三者不同源，于是有三类可复现的错误（先写成 15 条测试，在未修复代码上跑出 **8 条失败**作为证据）：

1. **显示与筛选打架**：工作区被改名后，行上显示 `E:\Code\renamed-workspace`，但选中这个项目筛出来是 0 条。
2. **选项与行不匹配**：会话只有 `cwd`、没有工作区归属时，行显示了项目路径，下拉框里却没有这个选项。
3. **Windows 重复选项**：`E:\Proj\A` 与 `E:\proj\a`、`E:\a` 与 `E:\a\` 各出一个选项，看着一样，点哪条都只筛出一半。

### 1.2 修复

`lib/service.js` 七处改动：

1. 新增导出 `projectKey(value, platform)` —— 规范键：非字符串 / 空白 → `null`；win32 下反斜杠转正斜杠并小写；
   POSIX 保持大小写敏感且不把 `\` 当分隔符；`length > 1` 时去掉尾部重复分隔符（根 `C:\` 不误伤）。
2. `wsBySession` 由「最后赋值胜」改为**首个声明者胜**（一个会话可被多个工作区列出，取哪个都不该影响项目身份）。
3. 新增「3b. 项目身份」段落：每行只在**这一处**算 `projectKey` / `project`。取值顺序
   **`cwd`（非空） → `workspace.path`（非空） → `null`**；同一规范键的多种写法合并成一个显示值（首个出现者胜）。
4. 筛选改为 `items.filter((row) => row.projectKey === projectKey(wantProject))`。
5. 输出 `project: row.project`（保留了 `ws` 变量供 `workspaceTitle` 用）。
6. 关键词过滤由匹配 `row.cwd` 改为匹配 `row.project` —— 用户把界面上看到的路径粘进搜索框必须能搜到。
7. `projects`（下拉选项）改为从 `projectDisplayByKey` 取，**作用域仍是全库**（不随当前筛选抖动），
   与修复前一致，避免切换筛选时选项跳动。

**为什么用 `cwd` 优先而不是工作区路径**：`cwd` 是这一行的固有事实、唯一无歧义；
工作区归属是多对多关系，没有「唯一路径」可言；缺 workspace 元数据时也不该把行丢掉。
选项集合本来就由 `cwd` 生成，沿用同一口径可避免语义突变。

### 1.3 验证

- 单测：`test/project-identity.test.mjs` 15 例全绿（修复前 8 例失败）。
- **真实宿主只读验收**（`http://127.0.0.1:30602`，插件版本 `1.1.2`，`kind=all` 共 115 行）：

| 选项 | 筛出行数 | 行内 `project` 与选项不一致 |
|---|---|---|
| `E:\AI\DeepSeek Harness\Dsh` | 49 | 0 |
| `E:\AI\DeepSeek Harness\tmp` | 31 | 0 |
| `E:\AI\DeepSeek Harness\学习` | 23 | 0 |
| `E:\Code\dsh-plugin-market` | 12 | 0 |

  - `item.project` 不在下拉选项里的行：**0**；`project` 为 `null` 的行：**0**。
  - 大小写 / 分隔符变体查询 `e:\AI\deepseek harness\dsh` → 同样返回 **49** 条（规范化在真实数据上生效）。

---

## 2. 任务二（P1）：删除事务边界审计

### 2.1 方法

先读透删除链路的四个阶段（recheck → 各步破坏 → 审计 → 广播），**先写测试**，
`test/transaction-boundary.test.mjs` 8 例，全部用隔离 `DSH_HOME` + fake 宿主服务，不碰真实机器。

覆盖：标题读取在途时删除、批量里一条被拒 + 一条非法 id、批量中一条有降级、审计写入在途、
审计失败、投影缓存正常删除、投影缓存条目是符号链接、投影缓存根路径异常。

### 2.2 结论：**没有确认缺陷，不改生产代码**

原先的假设是「投影缓存删不掉就应当报降级（`complete:false`）」。实测**否证**了它，
三条构造路径各自失败的方式都说明 `complete:true` 是**有意设计**：

1. 把 `<sessions>` 目录换成普通文件 → Windows 把路径异常映射成 `ENOENT`，
   `lib/artifacts.js` 按「没有缓存」处理（absent ≠ failed），`failures` 为空。
2. 把投影缓存根做成符号链接指向外部 → `isRealPathInside` 会同时 realpath 根，
   文件仍在根内，删除正常成功。
3. `chmod 0o444` 让 `rm` 失败 → Windows 下 `fs.rm(..., {force:true})` 照样成功（实测 `rm OK`）。

于是测试改为**钉住现有语义**：fail-closed（不跟随符号链接、`ENOENT` 不算失败）、
审计失败必须降级且不得复活、批量被拒项必须出现在 `retry` 清单里。

### 2.3 仍然存在的风险（如实记录，未修）

「删除前判活」与「真正删除」之间仍有**非零窗口**。`/status` 的 capabilities 里
`publicSessionLock: false` —— 宿主的会话写锁（`SessionWriteLease`）**不对插件暴露**，
插件只能做到「每次 `rm` 前紧贴再判一次运行态」（`preDeleteRecheck: true`）。
这条属宿主侧限制，本轮以测试覆盖其后果（拒绝后不得摘内存条目、重试仍拒绝）而不是假装消除。

---

## 3. 任务三（P1）：标题异步化设计稿

`docs/TITLE-ASYNC-DESIGN.md` + `test/title-async-prototype.test.mjs`（7 例）。

### 3.1 为什么不能靠 `setTimeout` 糊

标题成本在**宿主侧解压整份会话日志**（`lib/service.js:1387` 的注释：目录里只有
`session.v4.jsonl.zstd`，没有独立标题索引）。把 `await` 包进 `setTimeout` 只是换个地方等，
总时长不变 —— **必须改返回契约**，而不是改等待位置。

固定延时三种硬伤：无法区分「还没来」与「永远不会来」；不可取消 → 已删的行会被迟到结果复活；
无界陈旧（冷态实测 763 ms，任何固定延时都会被击穿）。

### 3.2 设计要点

- `/list` 增加 `titles: { token, state: pending|partial|complete|failed, pending, ready, empty, unreadable, ms }`，
  每行增加 `titleState`。**`empty`（宿主确认无标题）与 `unreadable`（读失败/超时）必须分开** ——
  混成 `null` 是当前最大的可观测性缺口。
- 乱序用 `(sessionId, token)` + epoch 双重栅栏；迟到结果**逐条合并**，绝不整批覆盖。
- 删除时 `epoch += 1`，迟到结果不得写回缓存（现状 1.1.2 仍会写回，实测只多一条无用缓存、不产生幽灵行）。
- 单条失败 → `unreadable` 保留行；整批失败 → `state=failed`，**不得停在 pending**；重试上限 3 次后冷却 60 s。
- 验收标准 A1–A8 已写成可测口径（A1：假宿主阻塞 800 ms 时 `/list` < 100 ms 且行齐全；
  A2：首屏 P95 ≤ 热态 1.2×；A3：每条必有终态；A4/A5：迟到结果不得覆盖/复活；A8：既有语义零回归）。

### 3.3 原型验证到哪一步

`test/title-async-prototype.test.mjs` 里有一个**只在这个测试文件内**的参考实现
（`createAsyncTitleBroker`）和「可控闸门」的假宿主（`releaseNext()` 逐批放行以模拟乱序）。
已验证：首屏不阻塞（< 100 ms）、必有终态、旧 token 迟到被丢弃、删除后不复活、
整批失败报 `failed`、`empty` 与 `unreadable` 可区分、已拿终态的会话不重复读。

**没有做**：A2（首屏 P95）需要真实宿主计时，属实现后的事；**原型不是生产实现**，
不 import `lib/`、不改生产代码，真实宿主上的行为**未验证**。

---

## 4. 任务四（P2）：文档与仓库事实一致性

### 4.1 查实并修掉的不一致

| 位置 | 问题 | 处理 |
|---|---|---|
| `README.md` / `README.zh.md` 测试段 | 写「248 tests / 14 files（每平台 245）」 | 改为 **278 / 17 / 275** |
| `README.md` 配置表 | 缺 `titleSearchLimit`、`auditMaxBytes`、`auditRotateKeep` 三行（中文版有） | 补齐 |
| `README.md` / `README.zh.md` 配置表 | **两份都缺 `announceRemoval`** —— 配置项存在但从未被文档记录 | 补齐并说明语义 |
| 两份 README 测试套件表 | 缺三套新文件 | 补 `project-identity` / `transaction-boundary` / `title-async-prototype`（后者明写「原型，不是生产路径」） |
| `docs/RELEASING.md:192` | 「含 238 条测试」 | 改为 278 |
| `CHANGELOG.md` | 本轮改动无记录 | 在 `## Unreleased` 下补四节（修复 / 测试 / 文档 / 保留既有 CI 修复节） |

### 4.2 查实后**决定不改**的

- **历史报告**（`PERF-03`、`PERF-04`、`收尾整改报告-发布闭环` 等）里的 248 / 238 / 207 条测试、
  `1.1.0` / `1.1.1` 版本号，都是**当时的快照**，每份开头都写了基线 SHA 与日期。
  改历史报告等于篡改记录 —— 一律不改。
  但 `docs/收尾整改报告-发布闭环.md` 的 §6「未完成事项」有 4 项在本轮之后已经落地，
  所以在该文件顶部加了一节 **「0. 后续状态」** 逐条对照（原结论原样保留）。
- `docs/RELEASING.md` §5.1 / §6 关于发布工作流的描述与当前 `.github/workflows/` **一致**，
  不需要改（已在上一轮 `e3090e9` 一并更正）。

### 4.3 核对通过、无问题的项

- 三个端点路径 `/api-ext/dialogue-cleanup/{status,list,delete}` 在 README×2 与 `lib/index.js` 中一致。
- 19 个配置默认值与 `lib/config.js:25-86` 逐项一致（本轮补上第 19 个 `announceRemoval` 后全部覆盖）。
- 测试命令 `node scripts/run-tests.mjs`、`test/integration-real.mjs` 的「只读、不并入默认套件」说明一致。

---

## 5. 残留问题与建议（本轮**不做**，另开任务）

1. **下拉选项可能含「筛不出行」的项目**（真实宿主实测：`kind=main` 时 4 个选项里
   `E:\Code\dsh-plugin-market` 返回 0 条 —— 该项目的 12 条会话全是 `origin: 'subagent'`，
   被 `kind=main` 过滤掉了）。原因：`projects` 由**过滤前的全量行**生成。
   这是**修复前就有的作用域行为**，本轮刻意保持不变（避免语义突变）。
   建议：或从过滤后的集合生成选项，或给选项加计数（如 `Dsh (49)`）。
2. **删除竞态窗口未消除**（见 §2.3），取决于宿主是否暴露会话写锁。
3. **标题冷启动成本未降低**：`docs/PERF-05-PROJECTION-CACHE-REPORT.md` 结论为 **NO-GO** ——
   宿主的 `cachedSnapshot` 缺少可与日志末 seq 双向比对的水位，按「标题正确性优先」不得启用。
   真要优化只能走 §3 的异步化。
4. **标题新鲜度**仍是未解问题：插件无法证明宿主返回的标题落后于日志，`docs/TITLE-ASYNC-DESIGN.md` §3.3 已把范围收敛为「只依赖 token」。

---

## 6. 复核命令

```powershell
cd E:\Code\dsh-dialogue-cleanup
node --check lib\service.js
node --test test\project-identity.test.mjs test\transaction-boundary.test.mjs test\title-async-prototype.test.mjs
node scripts\run-tests.mjs                     # 278 tests / 275 pass / 0 fail / 3 skipped
git log --oneline -4                           # c1aba44 2f766ea 1f07460 a6dc0d0
```

真实宿主（只读）：

```powershell
$b = 'http://127.0.0.1:30602/api-ext/dialogue-cleanup/list?pageSize=300&kind=all'
(Invoke-WebRequest -UseBasicParsing $b).Content | ConvertFrom-Json | % value | % projects
```

---

## 7. 本轮明确**没有**做的事

- 没有发布 npm、没有 `npm stage approve`、没有推标签、没有改 `package.json` 版本号。
- 没有对真实宿主执行任何破坏性操作（删除 / 归档 / 改名 / 修改配置）。
- 没有实现标题异步化（只到设计稿 + 测试内原型）。
- 没有修 §5 列出的四项残留（均需单独立项，其中 1、2 涉及语义变更或宿主能力）。
