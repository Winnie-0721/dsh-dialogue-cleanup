# CLASSIFICATION-01 报告：未分类会话不得再被默认当成主会话

- 任务：`TASK-CLASSIFICATION-01-未分类会话误归主会话.md`（P0）
- 仓库：`Winnie-0721/dsh-dialogue-cleanup`
- 基线：`1cee96a`（package.json `1.1.2`）
- 验证环境：Windows，本机 DSH 宿主（插件以 `link:E:/Code/dsh-dialogue-cleanup` 挂载）
- 边界：**未发布 npm、未打标签、未改版本号**；真实宿主验收**只读**，未调用删除端点

---

## 1. 结论

1. 缺陷**确认存在**，且有**两条**独立路径，都表现为「身份未知的会话被静默归进主会话」：
   - **service 层**：兜底分支（摘要里有、语料里没有的行）建行时**没有写任何身份证据字段**，下游判据是 `row.subagent !== true`，于是「没有证据」被当成「不是子代理」= 主会话。
   - **HTTP 边界层**：`lib/index.js` 的 `kind` 取值白名单只认 `main|subagent|all`，新增的 `unknown` 会在读查询串阶段被**静默丢弃**，service 收到 `undefined` 后按 `main` 兜底 —— 界面上点了「身份未知」，返回的却是一整页主会话。
2. 两条都已修复。判定不再依赖任何旁证（行数、标题、更新时间、文件存在性），只用**契约明确给出**的身份字段。
3. 未知分类**可见且可筛**；它既不进主视图，也不被当成子代理，界面上有独立徽标与独立筛选项。
4. 全量测试 **294 条 / 291 通过 / 0 失败 / 3 跳过**（基线 278 条，本轮新增 16 条，无回归）。

> 第 2 条路径是**真实宿主验收**发现的：单元测试全绿（service 层 14 例），但真机上 `GET /list?kind=unknown` 返回 `filter=main`、179 条主会话。这正是「只测 service 不测 handler」的盲区，现已补一条 handler 级回归把它钉死。

---

## 2. 契约取证：哪些字段是身份证据，哪些不是

判定依据必须来自宿主契约，不能来自现象。逐字核对 `app.asar` 内的 `@deepseek-ai/dsh-api-session-controller/lib/types/list.js`：

```js
// listFields(header) —— 摘要行只透出这三个字段，且都是「有才展开」
...(header.parentSession === undefined ? {} : { parentSessionId: header.parentSession }),
...(header.origin        === undefined ? {} : { origin: header.origin }),
...(header.cwd           === undefined ? {} : { cwd: header.cwd }),
```

因此：

| 字段 | 语料行（`sessionQuery.listSessions`） | 摘要行（`sessionController.list`） | 能否作证据 |
| --- | --- | --- | --- |
| `origin` | 有（`header.origin`） | 有（条件展开） | **能**，`'subagent'` 即子代理 |
| `parentSession` | 有 | 有（`parentSessionId`，条件展开） | **能**，非空即子代理 |
| `delegationDepth` | 有（`header.delegationDepth`） | **不透出** | 只在语料侧作证据 |
| `version` / `isSeeded` | 有 | **不透出** | 不作分类依据 |
| `updatedAt` | 有 | 有 | 不作分类依据（旁证） |

关键推论：**摘要里没有某字段，只表示「没被带出来」，不表示「它是空/假」**。所以「摘要行看不到 `delegationDepth`」绝不能被读成「它不是子代理」。

`@deepseek-ai/dsh-session-format-v4` 的 README 进一步固定了逻辑 header 的必需项（`version`/`id`/`createdAt`/`isSeeded`/`delegationDepth`）与可选项（`cwd`/`parentSession`/`origin`/`agentPreset`），并规定 `origin` 存在时必为 `'subagent'`。

---

## 3. 缺陷机制（修复前）

### 3.1 service 层：兜底行没有身份字段

语料循环与摘要循环合并进 `rows`，摘要行若在语料里没有对应记录，走兜底分支建行。修复前该分支写入的字段里**没有身份证据**，而下游筛选是：

```js
kindFilter === "main" ? items.filter((row) => row.subagent !== true) : ...
```

`undefined !== true` 恒真 ⇒ 未知行进入主视图。**这就是用户看到的「主会话筛选下出现无法判断身份的会话行」。**

### 3.2 HTTP 边界：白名单吞掉 `unknown`

```js
// 修复前
if (kind === "main" || kind === "subagent" || kind === "all") out.kind = kind;
```

`unknown` 不匹配 ⇒ 不写入 ⇒ service 收到 `undefined` ⇒ 按 `main` 兜底。

---

## 4. 修复

### 4.1 `lib/service.js`：三态分类，证据只累加不相减

1. **只记原始证据，不下结论**。语料侧记 `origin` / `parentSessionId` / `delegationDepth` / `inCorpus`；摘要侧记 `summaryOrigin` / `summaryParent` / `inSummary`；兜底分支显式写 `inCorpus:false`、`inSummary:true` 与两处摘要证据（修复前这里什么都不写）。
2. **统一判据**（第 3a 步）：

```js
const hasSubagentEvidence = (origin, parentSessionId, delegationDepth) =>
  origin === "subagent" ||
  (typeof parentSessionId === "string" && parentSessionId !== "") ||
  (typeof delegationDepth === "number" && delegationDepth > 0);
```

   每行分别对语料证据与摘要证据求值，然后：

   | 情况 | `classification` | `classificationSource` |
   | --- | --- | --- |
   | 任一侧有子代理证据 | `subagent` | `corpus` / `summary` / `corpus+summary` |
   | 无子代理证据，且在语料里 | `main` | `corpus` |
   | 无子代理证据，且只在摘要里 | `unknown` | `summary` |

3. **没有「冲突」分支**。曾实现「两来源矛盾 ⇒ `unknown` + `source='conflict'`」，被 `test/project-identity.test.mjs:311` 的组合用例证伪：语料明确是子代理、摘要只是没带 `origin`，被判成冲突。**缺失不是反证**，所以「矛盾」这个状态在本契约下不存在，已删除并在代码注释里留下证伪记录。
4. `kind` 解析、筛选、行输出、计数、回包全部改三态：`main|subagent|unknown|all`，计数加 `unknownTotal`，`mainTotal` 不再用「总数 − 子代理数」这种减法（减法会把未知吞进主会话）。
5. 兼容字段 `subagent` 保留，值改为 `classification === 'subagent'` —— 未知**既不是**子代理**也不是**主会话。

### 4.2 `lib/index.js`：GET 与 POST 共用一份白名单

```js
const KIND_VALUES = ["main", "subagent", "unknown", "all"];
const isKind = (value) => typeof value === "string" && KIND_VALUES.includes(value);
```

两处（GET 查询串、POST 请求体）都改用它，并在注释里写明「新增取值必须同时改这里，否则会在 HTTP 边界被静默丢掉」——这一层白名单是有意的（非法值不往下传），代价就是两处必须同步。

### 4.3 `client.js`：四选一 + 未知徽标

- 类型选择器四选一：`main | subagent | unknown | all`，中文「身份未知」、英文 "Unknown"。
- 行徽标顺序：归档 → **未知**（`dscc-badge-unknown`，`title` 说明「宿主没有给出足够的身份证据」）→ 子代理 → 运行中 → 空闲 → 阻塞。
- 文案明确「未知 ≠ 不可删除」，避免把分类标记读成安全判定。
- **不做任何前端二次猜测**：前端只显示后端给的 `classification`，不在 UI 里用行数/标题/时间补判。

---

## 5. 测试

### 5.1 先失败后修（`test/classification.test.mjs`，15 例）

修复前在未改代码上跑：**pass=3 fail=12**（其中 1 例是后补的 HTTP 边界例，修复前同样失败）。覆盖：

- 兜底行（只在摘要里）必须是 `unknown`，且**不得**进 `kind=main`；
- `kind=unknown` 能筛出且只筛出未知行；
- 摘要侧的 `origin` / `parentSessionId` 证据必须被采信；
- 语料行必须带 `classification` + `classificationSource`；
- 证据只累加不相减（正向：摘要给证据、语料无 → `subagent`；反向：语料给证据、摘要没带 → 仍 `subagent`）；
- 摘要多出来的 ghost 行不得混进主视图；
- 三类计数与 `kind.filter` 回显正确；
- 分类字段不因标题/项目/归档筛选而丢失；
- 非法 `kind` 仍退回 `main`（既有保守默认不变）；
- `kind=subagent` 既有语义不变（只含 `subagent === true`）；
- **HTTP 边界**：`GET /list?kind=main|subagent|unknown|all` 各自回显自己的 `filter`，`kind=bogus` 仍退回 `main`。

### 5.2 既有断言的同步

`test/contract.test.mjs`（两处降级用例）、`test/perf-regression.test.mjs`（子代理/主会话不变式，改为 `subagent + main + unknown === all`）、`test/render.test.mjs`（fixture 缺 `unknownTotal` 不得抛错）按新语义更新，**没有放宽任何一条**。

### 5.3 结果

```
node --test test/classification.test.mjs  → 15 / 15 pass
node scripts/run-tests.mjs               → 294 tests / 291 pass / 0 fail / 3 skipped
```

---

## 6. 真实宿主只读验收

端口由 `scripts/bench-real-host.mjs` 自动发现（本次 `3070`）。**只发 GET，不调用删除端点。**

`GET /status`：`version 1.1.2`、`titleFetchConcurrency 8`、`titleCacheTtlMs 300000`。

`GET /list?kind=…&pageSize=1`：

| kind | 回显 filter | total | mainTotal | subagentTotal | unknownTotal |
| --- | --- | --- | --- | --- | --- |
| `main` | `main` | 179 | 179 | 45 | 0 |
| `subagent` | `subagent` | 45 | 179 | 45 | 0 |
| `all` | `all` | 224 | 179 | 45 | 0 |

`GET /list?kind=all&pageSize=400`（服务端上限 200 条）：

- `sources` 两个来源都可用：`{"corpus":"sessionQuery.listSessions","summary":"sessionController.list"}`
- `classificationSource` 分布：`corpus = 178`、`corpus+summary = 22`（首 200 条）
- `classification` 分布：`main = 178`、`subagent = 22`

### 6.1 两个必须如实说明的观察

1. **本机当前 `unknownTotal = 0`，这是合理结果，不是「没测到」。** 未知行的定义是「只在摘要里、语料里没有」，而当前宿主两个来源的 id 集合一致（224 条全部有语料记录），所以不存在未知行。缺陷的触发条件是**语料缺失/降级**（例如 `sessionQuery` 不可用、或某个会话只有摘要），这条路径由 `test/contract.test.mjs` 的降级用例与 `test/classification.test.mjs` 的兜底用例覆盖，**不能靠当前这台机器上偶发的数据状态来证明**。
2. **`GET /list?kind=unknown` 在当次验收里仍回显 `filter=main`** —— 因为宿主进程（PID 2096，启动于 09:29:30）加载的是**修复前**的 `lib/index.js`（该文件 11:00:06 才被我修改，`apply()` 已注册的路由不会热替换）。**这属于代码未重载，不是修复无效**：同一次进程里 `lib/service.js`（09:55:25 修改）的分类字段已经生效（`classification`、`classificationSource`、`unknownTotal` 都出现在回包里），说明 service 侧新代码确实在跑、而 `apply()` 边界那一层没有。

   ⇒ **待办（需用户侧操作）**：重载/重启宿主后复核 `GET /list?kind=unknown` 应回显 `filter=unknown`。在完成这一步之前，本报告对该路径的结论只由 §5.1 的 handler 级测试支撑，**不算真实宿主已验证**。

---

## 7. 未做与不做（明确边界）

- **不改删除语义**：`classification=unknown` 的行仍然可删（`deletable` 判据未变），分类只影响可见性与筛选，不影响安全性；本轮未调用任何删除端点。
- **不在 UI 侧硬过滤/二次猜测**：前端只渲染后端给出的分类。
- **不用旁证分类**：行数、标题、更新时间、文件存在性、`archived` 都没有参与判定。
- **不动项目身份逻辑**（`TASK-POST-1.1.2` 已独立提交的 `projectKey`）与删除事务（`TASK-POST-1.1.2` 的 8 例边界测试）。
- **未发布**：不 `npm publish`、不 `npm stage approve`、不打标签、不改 `package.json` 版本号。

---

## 8. 遗留风险

1. **宿主边界层仍需一次重载验证**（§6.1 第 2 点）。这是唯一未闭环项。
2. **`unknown` 的触发面可能被低估**：本机两来源 id 集合完全一致，说明 DSH 在正常状态下不会产生孤儿摘要行。真正会产生未知行的是**降级路径**（`sessionQuery` 缺失、语料读取失败、会话刚建还没落语料）。这些路径有测试，但没有真实故障注入的端到端验证。
3. **分类只区分「是不是子代理」**，不区分会话的其他来源（例如跨工作区、被其他插件注入的会话）。若将来宿主引入新来源，`hasSubagentEvidence` 需要重新审定 —— 判据集中在单一函数内，便于改。
4. **`classificationSource` 是证据来源而非置信度**：`corpus+summary` 只表示两侧都有记录，不表示「两侧一致」。若将来需要冲突检测，前提是宿主开始在摘要里透出 `delegationDepth` 或等价字段。

---

## 9. 提交记录

| 提交 | 内容 |
| --- | --- |
| `e91c4f0` | `fix(list)`：会话分类三态化 —— 身份未知不得再被默认当成主会话（`lib/service.js` + 既有断言同步） |
| `51ca4e0` | `feat(ui)`：会话类型四选一 + 「未知」身份徽标（`client.js`） |
| `18a6f4c` | `test(classification)`：未知分类 14 例 + 未知徽标渲染 1 例 |
| 本次 | `fix(list)`：HTTP 边界放行 `kind=unknown`（`lib/index.js`） |
| 本次 | `test(classification)`：HTTP 边界回归 1 例（共 15 例） |
| 本次 | `docs`：本报告 |
