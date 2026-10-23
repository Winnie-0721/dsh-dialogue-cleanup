# PERF-05 阶段 A：DSH 投影缓存标题快速路径可行性验证

> 依据任务书 `TASK-PERF-05`（基线版本 `1.1.2`）。前置报告 `docs/PERF-04-REPORT.md`（尤其 E-05）。
>
> **本文档严格区分三类数据**，每个数字后的标记含义如下：
>
> - **【契约】**：来自宿主发布包内的 README / 类型定义 / api-catalog，是对外承诺，可作正确性依据。
> - **【真机】**：在运行中的真实 DSH 宿主（端口 14276）上用只读接口采集。
> - **【本机】**：本机对真实投影缓存文件与真实会话日志做等价解码所得的观测，**不是**宿主内部耗时，也不构成契约。
>
> 本阶段**未修改任何生产代码**，未改默认值，未改版本号，未发布。工作树只有未跟踪的 `_tmp-*` 探针。

---

## 0. 结论摘要

| 问题 | 结论 | 证据类型 |
|---|---|---|
| `sessionProjectionCache` 是否可获取 | **可获取**。服务名为 `sessionProjectionCache`（`super(ctx, "sessionProjectionCache")`），插件经 `ctx.get("sessionProjectionCache")` 取得；宿主自己在 `api-session-controller` 里就是这么取的 | 【契约】 |
| 是否属于公开/稳定接口 | **是**。`cachedSnapshot(meta, keys?)` 在 `dsh-session-projection-cache/README.zh.md` 有完整语义说明，并被 `dsh-api-session-controller` 作为列表投影列的唯一冷行来源使用 | 【契约】 |
| `cachedSnapshot` 的参数与返回 | `cachedSnapshot(meta: SessionHeader, keys?: readonly string[])` → `{ asOfSeq, values } \| undefined`。`values` 只含「row 版本匹配当前 schema」的 key | 【契约】 |
| 标题字段名与空标题语义 | 投影 key 为 `title`；`values.title` 为 `string`。**无标题时不出现该 key**（`viewCheckpoint` 对 `row === undefined` 直接 `continue`），而非返回空串 | 【契约】+【本机】 |
| 会话 ID 映射是否无歧义 | **是**。缓存记录键与 `listSessions()` 的 `header.id` **逐字符相同，53/53 = 100%** | 【本机】 |
| 生命周期身份校验能否通过 | **能**。`lifecycleIdentityOf(header)` 取 `header.version`，而 `listSessions()` 的 header 由 `rowHeader()` 生成、**带 `version` 字段** | 【契约】 |
| 是否存在可用的新鲜度判据 | **没有**。`asOfSeq` 是折叠水位，README 明确写「header 作证不了 inherited cut，也作证不了行序号与消费者稍后打开的日志可比」 | 【契约】 |
| 宿主是否承认缓存可能陈旧 | **承认**。「崩溃可能让缓存落后于日志」「失败会记录警告并让缓存保持陈旧」 | 【契约】 |
| 实测标题是否与日志一致 | **47/47 一致（100%）**；8 个多次改名会话**全部**与日志末标题一致；陈旧 **0** 条 | 【本机】 |
| 上述一致性能否当新鲜度证明 | **不能**。它是一次观测，不是契约；宿主文档明确保留陈旧可能 | 判定 |
| **阶段 A 结论** | **NO-GO**：不实现快速路径，保持现有 `readTitleSnapshots()`，向上游提出稳定 API 需求 | 见 §5 |

---

## 1. A1 宿主契约核查

### 1.1 服务如何获取、是否公开

`dsh-session-projection-cache/lib/index.js`：

```js
var SessionProjectionCache = class extends Service {
	static inject = ["storageDomain", "sessionProjections", "sessions"];
	constructor(ctx, config) { super(ctx, "sessionProjectionCache"); }
	async [Service.init]() {
		const domain = await this.ctx.storageDomain.open(projectionCacheDomainSpec);
		...
	}
```

`dsh-api-session-controller/lib/types/list.js` 的 `projectionsFor(header, session)` 是宿主自己的消费方式：

```js
if (session !== undefined) return hintsOf('sequenced', this.ctx.sessionProjections.cachedSnapshot(session));
// A cold row reads the persisted cache by header alone; ...
const cache = this.ctx.get('sessionProjectionCache');
return hintsOf('cached', cache?.cachedSnapshot(header) ?? cache?.cachedPredecessorTitle(header));
```

⇒ **服务名与获取方式都有宿主自身代码作为先例，不是猜测的内部行为。** 整体包在 `try/catch` 里，失败只 `logger.warn` 并「serving the row without it」——即宿主自己也把它当**可失败的可选增强**。

`README.zh.md`「读取缓存值」一节给出了该接口的完整对外语义，属于发布包文档，可作【契约】引用。

### 1.2 参数、返回结构与失败方式

```js
cachedSnapshot(meta, keys) {
	const expected = lifecycleIdentityOf(meta);
	const record = this.requireTable().get(meta.id);
	if (record === void 0 || !currentLifecycleMatches(record.identity, expected)) return void 0;
	return this.viewRecord(record, keys);
}
```

| 项 | 值 |
|---|---|
| `meta` | 会话的 **authoritative header**（`listSessions()` 返回的 `record.header`），不是插件自己加工的 row |
| `keys` | 可选；插件应传 `["title"]` 把返回面收窄 |
| 成功返回 | `{ asOfSeq: number, values: { title?: string } }` |
| 无记录 / 身份不匹配 | `undefined`（**不抛错**） |
| 记录存在但 title 行版本不匹配 | 返回 `{ asOfSeq, values: {} }`（`viewCheckpoint` 跳过该 key） |
| 表未初始化 | `requireTable()` 抛错；调用方需自行 try/catch |

身份校验的两个函数：

```js
function lifecycleIdentityOf(header) {
	return {
		formatVersion: header.version,
		createdAt: header.createdAt,
		...header.cwd === void 0 ? {} : { cwd: header.cwd },
		isSeeded: header.isSeeded
	};
}
function currentLifecycleMatches(stored, expected) {
	return stored.formatVersion === expected.formatVersion && lifecycleIdentityMatches(stored, expected);
}
```

`lifecycleIdentityMatches` 比较 `createdAt`、`cwd`、`isSeeded`。

### 1.3 `meta` 的来源与 ID 关联

`dsh-session-query-sqlite/lib/index.js` 的 `rowHeader(row)`：

```js
function rowHeader(row) {
	return {
		version: SESSION_FORMAT_VERSION,
		id: row.session_id,
		createdAt: row.created_at,
		...row.cwd === null ? {} : { cwd: row.cwd },
		...row.parent_session === null ? {} : { parentSession: row.parent_session },
		isSeeded: row.seed_length !== null,
		...row.delegation_depth === null ? {} : { delegationDepth: row.delegation_depth },
		...row.agent_preset === null ? {} : { agentPreset: row.agent_preset }
	};
}
```

⇒ `listSessions()` 返回的 `header` **恰好具备 `lifecycleIdentityOf` 需要的全部四个字段**（`version` / `createdAt` / `cwd?` / `isSeeded`）。**身份匹配在字段层面是通的**，不是卡点。

**一个必须注意的集成细节**：插件当前在 `listSessions()` 里把 `createdAt` 转成了 ISO 字符串（`new Date(record.header.createdAt).toISOString()`）。若把插件自己的 row 传给 `cachedSnapshot`，`stored.createdAt === expected.createdAt` 会因**类型不同**（number vs string）而失败。必须传**原始 `record.header`**。

### 1.4 投影数据如何更新、失效、重建

宿主文档（【契约】原文）：

> 三个必写点总是写入：会话创建保存由种子派生的切面，`turn/end` 保存列表读取所需的轮次终值，会话释放保存活会话的最终切面。其间，配置的条数与间隔节流随事件累积写入。每次写入通过领域写入链以原子方式替换该会话的完整记录；**失败会记录警告并让缓存保持陈旧**，后续写入会自行修复。

> **日志领先，缓存跟随**：活会话检查点先把会话的缓冲事件持久化，然后才保存缓存记录。因此**崩溃可能让缓存落后于日志，但绝不会让缓存领先**。

配置为两个必填字段：`writeEveryEvents`（每会话已提交事件数触发）、`writeIntervalMs`（脏检查点最长未写入时间）。

### 1.5 是否存在 `asOfSeq` / watermark / revision

有 `asOfSeq`，但**它不是新鲜度证明**。【契约】原文：

> 其 `asOfSeq` 是所服务各行中最低的水位。**这个水位是存储记录自己的：header 作证不了 inherited cut，也作证不了行序号与消费者稍后打开的日志可比**，因此 Session list 把该 block 标为 `cached`，客户端让建连后的 Session 产出的任何值覆盖它。

实测印证：53 条记录的 31 个投影 key **全部共享同一个 `seq`**（`distinct === 1`，53/53），说明该数字是**折叠水位**，不是逐 key 的新鲜度戳：

```
{ "records": 53, "allKeysIdenticalSeq": 53, "withDistinctSeqs": 0,
  "titleSeqIsMax": 53, "titleSeqBelowMax": 0 }
```

`revision` **不在公开返回面**。`persisted_sessions` 表确有 `revision TEXT NOT NULL` 与 `generation INTEGER NOT NULL`，`materializePersistenceSnapshots` 也要求 `typeof snapshot.revision === "string"`，但 `rowHeader()` 不透出它们，`listSessions()` 只返回 `{ header, live, persisted, formatStatus? }`。

`eventCount` 也**不在公开返回面**。`dsh-session-persistence/README.zh.md` 的示例注释写着 `stat(id) // header + revision (+ eventCount / sizeBytes)`，但实测代码 `dsh-session-persistence-jsonl` 的 `async stat(id, options)` 返回 `{ ...metadata, revision, sizeBytes }`，其中 `metadata` 来自 `readGenerationHeader()` → `{ header, formatStatus }`。⇒ **实际返回 `{ header, formatStatus, revision, sizeBytes }`，没有 `eventCount`**。asar 全文检索 `eventCount` 只命中内部扫描器状态与 format 迁移器，不在公开返回面。

### 1.6 服务不可用 / 未初始化 / 重启后的行为

- **未注册**：`ctx.get("sessionProjectionCache")` 返回 `undefined`。插件现有 `getService()` 已统一判空（`lib/service.js:123`）。
- **已注册但未 init**：`requireTable()` 抛 `"not initialized"`。
- **重启后**：`Service.init` 重新 `open` 领域；json 后端从 `<root>/session_projcache/sessions/<id>.json` 逐条读回。
- 三者都必须由调用方 `try/catch` 兜住并回退——宿主自己也是这么做的（`list.js` 的 try/catch）。

### 1.7 是否可能返回旧快照

**会**。【契约】明确保留两种陈旧来源：崩溃导致的落后，以及写入失败导致的「保持陈旧」。宿主因此把该 block 标为 `cached` 并让 connected Session 覆盖它。

---

## 2. A2 只读探针与结果

探针均只读：只读 `~/.dsh/storages/session_projcache/sessions/*.json`、`~/.dsh/sessions/**/session.v4.jsonl.zstd`，以及只读 `GET /status`、`GET /list`。**不调用任何删除/归档/修改接口，不写任何会话文件**。

### 2.1 候选规模与命中

| 指标 | 值 |
|---|---|
| 候选主会话数（`/list?pageSize=500&kind=all`） | **53** |
| 投影记录数 | **53** |
| 记录键形态 | 40 个裸 uuid + 13 个 `session-<uuid>` 前缀 |
| `/list` 的 `sessionId` 形态 | 40 裸 uuid + 13 `session-` 前缀 |
| **`header.id === 缓存键` 精确命中** | **53 / 53 = 100%** |
| 缺失 | 0 |
| 结构无效（JSON 解析失败） | 0 |
| 无 `title` 行 | 0 |
| `title` 值为空/缺失 | **6**（这 6 条日志里也确实没有 `session/title` 事件） |

**关于两种 id 拼写**：缓存目录里同时存在 `<uuid>.json` 与 `session-<uuid>.json`。这不是不一致——`/list` 返回的 id 同样是这两种形态，两侧逐字符相同。历史遗留，不构成映射歧义。

### 2.2 标题一致性（与现有权威路径对比）

对比方式：缓存 `record.rows.title.val` vs 日志中最后一个 `session/title` 事件的 `data.title`。日志为多帧 zstd（见 §2.5），按 magic `0x28 0xB5 0x2F 0xFD` 切帧后逐帧解压，得到完整事件流。

| 指标 | 值 |
|---|---|
| 可比对条数 | **47** |
| **标题完全一致** | **47（100.0%）** |
| 不一致 | **0** |
| 日志中无标题事件（与缓存空标题吻合） | 6 |

同时与 `/list` 返回的权威 `title` 交叉验证：**47/47 一致，0 不一致**。

### 2.3 陈旧性专项检验（本任务最关键的一步）

判据：若某会话存在**多个** `session/title` 事件，而缓存标题不等于**最后一个**，则缓存陈旧。

| 指标 | 值 |
|---|---|
| 多次改名会话数 | **8** |
| 其中缓存已追平末标题 | **8** |
| **其中缓存陈旧** | **0** |
| 单标题会话数 | 39 |
| 其中缓存陈旧 | **0** |

按 `live` / `persisted` 分层：

| 分层 | 条数 | 折叠水位与日志末 `seq` 相等 | 标题与日志一致 |
|---|---|---|---|
| 冷会话（`live=false`） | 47 | 45 | **41/41 = 100%** |
| 活会话（`live=true`） | 6 | 6 | **6/6 = 100%** |

冷会话那 2 条「水位不等于日志末 `seq`」的差异经查是**事件偏移 vs 事件 seq 的口径差**（`session` 头事件不带 `seq`），不是陈旧：其中一条 `cacheSeq=17798`、日志末 `seq=17797`、日志事件数 17799，`titleMatches: true`；另一条 `cacheSeq=664`、日志末 `seq=662`、事件数 664，同样 `titleMatches: true`。

**结论**：在当前这台机器、这一刻，投影标题与日志标题**零反例**。但这**不能**升级为新鲜度证明——原因见 §3。

### 2.4 读取成本

| 动作 | 耗时 | 备注 |
|---|---|---|
| 读全部 53 个投影 JSON（14.58 MB，纯 `readFileSync` + `JSON.parse`） | **89.1–92.8 ms** | 【本机】这是**绕过宿主内存表直接读盘**的成本 |
| `cachedSnapshot` 真实成本 | **≈ 0** | 【契约】「以零 I/O 从存储域的内存表同步提供」——走服务时是内存读，不读盘 |
| 全量解压 + 解析 53 个会话日志（取末标题） | p50 **15.1 ms** / p95 **135.3 ms** / max **196.3 ms** | 【本机】作为回退路径成本参照 |
| `fs.statSync` 53 个日志 | **2.14 ms**（0.039 ms/条） | 【本机】替代方案的成本下界 |

### 2.5 一个必须记录的实现坑（供后续复用）

会话日志 `session.v4.jsonl.zstd` 是**多帧 zstd 追加文件**。`zlib.zstdDecompressSync(raw)` **只解第一帧**——实测一个 2 094 366 B 的日志只解出 282 B（1 行，仅 `session` 头）。必须按 magic 切帧后逐帧解压，才得到完整 152 帧 / 8 929 311 B / 271 行。

`zlib.createZstdDecompress()` 流式解同样只出第一帧。**唯一可行的本机解码方式是按 magic 切帧**。这不影响宿主（宿主用自己的持久化层），但影响任何本机探针的正确性——本报告 §2.2/§2.3 的数字都是在切帧修正后取得的，此前的「0 条可比对」是探针缺陷，已作废。

---

## 3. 新鲜度判断方案评估

### 3.1 逐条排除的候选判据

| 候选判据 | 能否证明新鲜 | 依据 |
|---|---|---|
| `asOfSeq` 与日志末水位比对 | **不能** | 【契约】「header 作证不了 inherited cut，也作证不了行序号与消费者稍后打开的日志可比」。实测也证明它是折叠水位（31 key 共享同一 `seq`） |
| 缓存文件 mtime ≤ 日志 mtime | **不能** | 依赖文件系统时间戳，非契约；且宿主文档已声明崩溃可致落后。PERF-04 已证 `updatedAt`/mtime 与日志时间差可达数小时 |
| `stat()` 取 `eventCount` 比对 | **不能** | 【契约】`stat()` **不返回** `eventCount`（README 注释与实现不符，以实现为准） |
| `listSessions()` 取 `revision` 比对 | **不能** | 【契约】`rowHeader()` 不透出 `revision`/`generation` |
| 记录 `identity.inheritedEventCount` | **不能** | 缓存记录里有该字段，但 `cachedSnapshot` 只用 header-only 的 `lifecycleIdentityOf`；调用方无法从 header 提供期望的 cut |
| `title` 行 `ver` | **不能** | `ver` 是 **schema 版本**（`row.ver !== def.stateVersion` 即跳过），与数据新旧无关 |
| 用 TTL 兜底 | **不允许** | 任务书 §7：「不用 TTL 掩盖冷查询问题；TTL 可能让标题长期过期」 |

### 3.2 为什么「实测零反例」不能当证明

三条理由，任何一条单独成立即足以否定：

1. **宿主文档明确保留陈旧可能**，且给出机制（崩溃、写入失败）。零反例的样本来自一台正常收尾的机器——冷会话在 `session disposal` 时有强制检查点，这解释了为什么当前样本全新鲜。**崩溃场景没有被这个样本覆盖**，而它恰恰是文档点名会陈旧的场景。
2. **活会话的标题可能在最后一次检查点之后变化**。活会话的检查点触发是 `turn/end` + 节流；若标题事件落在两次检查点之间，缓存就是旧的。本机 6 个活会话恰好都追平了，这是运气而非保证。
3. **观测不能替代契约**。任务书 §3.1 明确：「不得仅因投影文件存在、mtime 较新或字段非空，就认定其一定是最新标题」。§3.2 要求「必须有明确的新鲜度证据……若无法证明投影快照与目标会话一致，则该条目视为『不确定』」。

### 3.3 「不确定就回退」设计能否救回收益

任务书 A3 允许「明确设计为『不确定就回退』」，B1 也定义了 `unknown` 状态。**但两者结合后收益为零**：

由于 §3.1 排除了全部判据，**每一条**记录都会落入 `unknown` → 全部回退 → 快速路径一次也不会生效。此时唯一结果是**多出一层永不命中的代码、多一条失败路径、多一份维护成本**，而冷查询耗时**一点也不会改善**。

这正是任务书 §4 预设的收尾方式：

> 若无法建立可靠的新鲜度判断，阶段 A 的正确结论应是 **不实现快速路径**，转为向 DSH 上游寻求稳定 API，而不是放宽正确性标准。

---

## 4. A3 验收门槛逐条判定

| 门槛 | 判定 | 说明 |
|---|---|---|
| 已确认会话 ID 与投影记录的映射无歧义 | **通过** | 53/53 逐字符相同；两种拼写两侧一致 |
| 已找到可说明并测试的新鲜度依据，**或**明确设计为「不确定就回退」 | **未通过（实质）** | 无任何判据可证明新鲜；「不确定就回退」虽可设计，但会 100% 回退、零收益 |
| 对不可用/缺失/陈旧/异常有可验证处理方案 | **通过** | `undefined` / `values{}` / 抛错三条路径均可区分并可回退 |
| 探针只读且有运行记录 | **通过** | §2 全部只读；脚本清单见 §8 |
| 未发现依赖明显不稳定内部细节才能保证正确性的阻断问题 | **通过** | 接口是公开文档化的；问题不在稳定性，在**新鲜度不可证** |

**结论：门槛第 2 条实质未通过 → 不进阶段 B。**

---

## 5. 决定：NO-GO

**不实现投影缓存标题快速路径。** 保持现有 `readTitleSnapshots()` 路径不变，向上游提出稳定 API 需求。

理由按优先级：

1. **无法证明新鲜度**（阻断性）。`asOfSeq` 是折叠水位且文档明确其不可与调用方日志对齐；`revision` 与 `eventCount` 均不在公开返回面；`ver` 是 schema 版本。任务书 §3.2 要求必须有明确的新鲜度证据。
2. **宿主自己也不把它当权威**。它标 `cached`，并让 connected Session 覆盖它「whatever this number says」。插件若把它当权威标题源，语义上与宿主设计相悖。
3. **即使实现也无收益**。全部条目落 `unknown` → 100% 回退 → 冷查询耗时不变，只增加复杂度与失败面。这属于任务书 §6-C3 所说的「不得为了保留改动而降低正确性标准」的反面：这里连改动本身都不该保留。
4. **不做「先显示后校正」变体**。该变体会在同一次请求内用缓存值先占位、再用权威路径覆盖，看似能省首屏等待。但：①任务书 B1 明确「只有 `hit` 可直接使用投影标题」，此变体不属于 `hit`；②它改变的是「首屏占位」语义，属于任务书 §7 划给 TASK-PERF-06（异步标题加载）的范围，必须单独评估首屏占位、搜索语义、分页稳定性与请求竞态。**不在本任务内自行放宽。**

### 5.1 顺带确认的「不是问题」项

为避免后续重复排查，以下曾在 PERF-04 中被怀疑的点，本阶段已确认**不构成阻断**：

- 会话 ID 与投影记录的映射：100% 精确匹配。
- 生命周期身份字段名：`lifecycleIdentityOf` 取 `header.version`，`rowHeader()` 恰好提供 `version`，字段名对得上。
- 接口可用性：公开文档化，且宿主自身有使用先例。
- 缓存读取成本：走服务时确实近似零 I/O。

---

## 6. 向上游的 API 需求

请求 DSH 在 `sessionQuery.listSessions()` 返回的 `header` 上**透出 `revision`**（`persisted_sessions.revision` 已存在且非空，`materializePersistenceSnapshots` 已在使用，只是 `rowHeader()` 没有带出来）。

若该字段可得，插件侧即可建立**可证明的**新鲜度判断，且成本极低：

1. 首次读到某会话标题时，持久化 `id → { revision, title }`（插件自有小状态，不是 SQLite 标题索引）。
2. 每次 `/list` 用 `fs.statSync(log, { bigint: true })` 算当前 revision（**实测 2.14 ms / 53 条，0.039 ms/条**）。
3. revision 未变 → 标题可信，直接复用；变了 → 回退 `readTitleSnapshots()` 并更新记录。

这满足任务书 §3.2「必须有明确的新鲜度证据」，且不依赖 `asOfSeq` 这类不可对齐的水位。**但它依赖上游先透出 `revision`，属于任务书 §7「先评估 DSH 是否能提供稳定、公开的标题/投影 API」的范围，故本阶段只提出需求，不自行实现插件侧索引。**

（附注：`dsh-session-persistence/README.zh.md` 的示例注释称 `stat()` 返回 `eventCount`，与实现不符。若上游本意是要暴露它，修正该实现同样能满足本需求，且更贴合「日志末水位」的语义。建议一并反馈。）

---

## 7. 风险与回退说明

- **本阶段零生产代码改动**，因此无回退动作。
- 探针脚本（见 §8 一览表）在采集完成后**已全部删除**，未留在工作树中。它们均为只读分析工具，不含对真实会话的写操作。§8 保留清单仅为记录本次取证用过哪些手段，便于复现时重写。
- 工作树最终只剩本文档一个未跟踪文件。
- **未改** `titleFetchConcurrency`（保持 8）、**未改** `titleLimit`、**未改** `titleCacheTtlMs`。
- **未触碰**删除流程、删除安全检查、会话文件。
- 真实宿主验收（阶段 C）**未执行**——因为阶段 A 判定 NO-GO，按任务书 §10 工作顺序，阶段 B/C 不进入。

---

## 8. 环境与运行记录

| 项 | 值 |
|---|---|
| 插件版本 | `1.1.2` |
| 仓库 HEAD | `e3090e938ca6550bdebe39994ced8df4e030b0ca`（`main`） |
| 宿主 | 真实运行中的 DSH，`http://127.0.0.1:14276` |
| 宿主包 | `D:\Software\DeepSeek Harness\resources\app.asar`（182 794 869 B） |
| Node | `v24.21.0`（原生 `zlib.zstdDecompressSync`） |
| 投影缓存根 | `~/.dsh/storages/session_projcache/sessions/`（53 个 JSON，记录 `version: 7`，`identity.formatVersion: 4`） |
| 会话日志根 | `~/.dsh/sessions/**/session.v4.jsonl.zstd` |
| `/list` 热态耗时 | `tookMs: 47`；`titles: { requested: 53, cached: 53, fetched: 0, failed: 0, truncated: 0 }` |
| 采集时点 | 2026-10-20 15:2x–15:3x（Asia/Shanghai） |

### 探针一览（采集后已删除；清单仅供复现时参考）

| 脚本 | 作用 |
|---|---|
| `_tmp-perf05-summary.mjs` | 汇总：规模、id 匹配、标题一致性、身份匹配、`seq` 分布 |
| `_tmp-title-correctness.mjs` | 缓存标题 vs 日志末 `session/title` 的 `data.title` |
| `_tmp-cold-vs-live.mjs` | 按 `live`/`persisted` 分层的水位与标题一致性 |
| `_tmp-stale-proof.mjs` | 多次改名会话的陈旧性专项检验 |
| `_tmp-freshness-decisive.mjs` | 折叠水位 vs 日志末 `seq`（用于揭示口径差） |
| `_tmp-anomaly-and-alt.mjs` | 「水位 > 日志末 seq」异常逐条归因 |
| `_tmp-id-match.mjs` | `header.id === 缓存键` 精确匹配率 |
| `_tmp-event-shape.mjs` | 日志事件类型分布与键形状（发现 `data.title` 路径） |
| `_tmp-zstd-frames.mjs` | 多帧 zstd 解压方式对比（发现一次性解压只出首帧） |
| `_tmp-service-reg.mjs` | 服务注册名、`cachedSnapshot` 契约、README 原文 |
| `_tmp-checkpoint-points.mjs` | 检查点写入点与 `writeEveryEvents`/`writeIntervalMs` 配置 |
| `_tmp-header-fields.mjs` | `rowHeader()` 字段面 |
| `_tmp-scan-asar.mjs` / `_tmp-extract.mjs` | asar 全文检索与按路径导出 |

---

## 9. 交付物对照（任务书 §9）

| 交付物 | 状态 |
|---|---|
| 1. 本文档（契约与证据 / 新鲜度方案 / 探针方法与结果 / 是否进 B 的决定及理由） | **已交付** |
| 2. 阶段 B 快速路径实现及测试 | **不交付**（阶段 A 判定 NO-GO） |
| 3. 真实宿主性能对比表 | **不适用**（未实现，无「新实现」列可填） |
| 4. 风险与回退说明 | **已交付**（§7） |
| 5. 明确结论 | **NO-GO**（§5），并提出上游 API 需求（§6） |
