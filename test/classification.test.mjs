/**
 * 会话分类（main / subagent / unknown）—— TASK-CLASSIFICATION-01
 *
 * 【缺陷】修复前「会话类型」只有两种身份：`row.subagent === true` 就是子代理，
 * 其余**一律当主会话**。而摘要兜底分支（`sessionController.list()` 里出现、但
 * 权威语料 `sessionQuery.listSessions()` 里没有的会话）根本没有写 `subagent` 字段：
 *
 *     // 修复前 lib/service.js 的兜底分支
 *     rows.set(id, { sessionId: id, title: null, cwd: …, live: true,
 *                    persisted: false, running, blank, createdAt: null, updatedAt });
 *
 * 于是 `row.subagent !== true` 恒成立 —— 这些**身份未知**的会话被静默归入主会话，
 * 出现在默认视图里。这正是「未分类会话混入主会话列表」。
 *
 * 【修复后的判定表】（依据 DSH 契约，`delegationDepth` 是 header 必需字段，
 * `origin` 仅在子代理会话上取 `'subagent'`，见 `@deepseek-ai/dsh-session-format-v4`
 * 与 `@deepseek-ai/dsh-api-session-controller/lib/types/list.js` 的 `listFields()`）
 *
 *   | 语料 | 摘要 | 子代理证据 | 结论 | classificationSource |
 *   |------|------|-----------|------|---------------------|
 *   | 有   | —    | 有        | subagent | corpus / corpus+summary |
 *   | 有   | —    | 无        | main     | corpus |
 *   | 无   | 有   | 有        | subagent | summary |
 *   | 无   | 有   | 无        | **unknown** | summary |
 *   | 有   | 有   | 两来源矛盾 | **unknown** | conflict |
 *
 * 【本组用例断言的是「修复后应有的行为」】，未修复时应当看到失败 —— 先复现，再修。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createService } from "../lib/service.js";
import { resolveConfig } from "../lib/config.js";

/**
 * 造一个只含 `/list` 所需服务的宿主替身。
 *
 * `records` 形状照真实 `sessionQuery.listSessions()`：`{ header, live, persisted }`。
 * `summaries` 形状照真实 `sessionController.list()`：
 *   `{ sessionId, updatedAt, running, blank, parentSessionId?, origin?, cwd? }`
 *   —— 注意 `listFields()` 只透出 parentSessionId / origin / cwd，
 *   **不透出 delegationDepth**，这正是「摘要单独不足以判 main」的原因之一。
 * `corpusDown: true` 让语料读取抛错，用来构造「只有摘要」的兜底路径。
 */
function makeHost({ records = [], summaries = [], corpusDown = false, summaryDown = false } = {}) {
  const services = {
    sessionQuery: {
      listSessions: async () => {
        if (corpusDown) throw new Error("corpus down");
        return records;
      },
      // 真实形状：SessionTitleObservation { sessionId, status, value: { title } }
      readTitleSnapshots: async (ids) =>
        ids.map((id) => ({ sessionId: id, status: "fulfilled", value: { title: undefined } })),
    },
    sessionController: {
      list: async () => {
        if (summaryDown) throw new Error("summary down");
        return { items: summaries };
      },
    },
  };
  const ctx = { logger: { warn() {}, debug() {}, info() {} }, get: (k) => services[k] };
  const audit = { record: async () => ({ ok: true, path: null }), enabled: false, path: null };
  return createService(ctx, resolveConfig({ audit: false }), audit);
}

/** 一条权威语料记录（`sessionQuery.listSessions()` 的元素）。 */
function record(id, header = {}) {
  return {
    header: { id, createdAt: 1000, ...(header.cwd === undefined ? { cwd: "E:\\proj" } : { cwd: header.cwd }), ...header },
    live: false,
    persisted: true,
  };
}

/** 一条摘要（`sessionController.list()` 的元素）。 */
function summary(id, extra = {}) {
  return { sessionId: id, updatedAt: 1000, running: false, blank: false, cwd: "E:\\proj", ...extra };
}

const idsOf = (result) => result.value.items.map((r) => r.sessionId);
const byId = (result) => Object.fromEntries(result.value.items.map((r) => [r.sessionId, r]));

// ───────────── ① 核心缺陷：摘要兜底行不得混进主会话 ─────────────

test("分类：语料缺失时，摘要行身份未知 —— 不得当成主会话，默认视图必须为空", async () => {
  const service = makeHost({
    corpusDown: true,
    summaries: [summary("u1"), summary("u2"), summary("u3")],
  });

  const result = await service.listSessions();
  assert.equal(result.ok, true);
  assert.equal(result.value.sources.corpus, "none", "语料失败必须如实标记");
  assert.equal(result.value.total, 0, "身份未知的行不得出现在默认（主会话）视图里");
  assert.deepEqual(idsOf(result), [], "默认视图一行都不该有");

  const all = await service.listSessions({ kind: "all" });
  assert.equal(all.value.total, 3, "但不得丢行 —— kind=all 必须仍能看到它们");
  for (const row of all.value.items) {
    assert.equal(row.classification, "unknown", "摘要单源且无证据 ⇒ unknown");
    assert.equal(row.classificationSource, "summary", "必须说明结论来自摘要");
    assert.equal(row.subagent, false, "unknown 不是子代理：subagent 布尔必须为 false");
  }
});

test("分类：kind=unknown 只返回未分类行，kind=main 不含它们", async () => {
  const service = makeHost({
    corpusDown: true,
    summaries: [summary("u1"), summary("u2")],
  });

  const unknown = await service.listSessions({ kind: "unknown" });
  assert.deepEqual(idsOf(unknown).sort(), ["u1", "u2"]);
  assert.equal(unknown.value.kind.filter, "unknown");
  assert.equal(unknown.value.kind.unknownTotal, 2);

  const main = await service.listSessions({ kind: "main" });
  assert.deepEqual(idsOf(main), [], "未分类行不得出现在主会话视图里");
  assert.equal(main.value.kind.mainTotal, 0, "主会话计数也不得把它们算进去");
});

test("分类：摘要行带 origin='subagent' 时，证据优先判为子代理（不是 unknown）", async () => {
  const service = makeHost({
    corpusDown: true,
    summaries: [summary("a1", { origin: "subagent" }), summary("u1")],
  });

  const sub = await service.listSessions({ kind: "subagent" });
  assert.deepEqual(idsOf(sub), ["a1"], "摘要里的子代理证据必须被采信");

  const unknown = await service.listSessions({ kind: "unknown" });
  assert.deepEqual(idsOf(unknown), ["u1"], "没有证据的那条才是未知");
});

test("分类：摘要行只带 parentSessionId 也足以判为子代理", async () => {
  const service = makeHost({
    corpusDown: true,
    summaries: [summary("c1", { parentSessionId: "p1" })],
  });

  const sub = await service.listSessions({ kind: "subagent" });
  assert.deepEqual(idsOf(sub), ["c1"], "有父会话即子代理（契约：子会话必须有直接父级）");
  assert.equal(sub.value.items[0].parentSessionId, "p1");
});

// ───────────── ② 权威语料侧：无证据 ⇒ main（契约明确） ─────────────

test("分类：语料行没有任何子代理证据时判 main，来源记为 corpus", async () => {
  const service = makeHost({ records: [record("m1"), record("m2", { delegationDepth: 0 })] });

  const result = await service.listSessions();
  assert.deepEqual(idsOf(result).sort(), ["m1", "m2"]);
  for (const row of result.value.items) {
    assert.equal(row.classification, "main");
    assert.equal(row.classificationSource, "corpus");
    assert.equal(row.subagent, false);
    assert.equal(row.deletable, true, "分类不得影响可删除性");
  }
  assert.equal(result.value.kind.mainTotal, 2);
  assert.equal(result.value.kind.subagentTotal, 0);
  assert.equal(result.value.kind.unknownTotal, 0);
});

test("分类：语料行的三项证据各自都能判出子代理", async () => {
  const service = makeHost({
    records: [
      record("e-origin", { origin: "subagent" }),
      record("e-parent", { parentSession: "p0" }),
      record("e-depth", { delegationDepth: 2 }),
      record("e-none"),
    ],
  });

  const result = await service.listSessions({ kind: "all" });
  const rows = byId(result);
  for (const id of ["e-origin", "e-parent", "e-depth"]) {
    assert.equal(rows[id].classification, "subagent", `${id} 应判为子代理`);
    assert.equal(rows[id].subagent, true);
    assert.equal(rows[id].classificationSource, "corpus");
  }
  assert.equal(rows["e-none"].classification, "main");
  assert.equal(result.value.kind.subagentTotal, 3);
  assert.equal(result.value.kind.mainTotal, 1);
  assert.equal(result.value.kind.unknownTotal, 0);
});

test("分类：语料里没有 origin 的旧会话仍按主会话处理（不得误伤）", async () => {
  const service = makeHost({ records: [record("legacy")] });
  const result = await service.listSessions();
  assert.deepEqual(idsOf(result), ["legacy"]);
  assert.equal(result.value.kind.subagentTotal, 0);
});

// ───────────── ③ 两个来源并存 ─────────────

test("分类：语料与摘要同时存在且一致时，来源记为 corpus+summary", async () => {
  const service = makeHost({
    records: [record("x1", { origin: "subagent" })],
    summaries: [summary("x1", { origin: "subagent" })],
  });

  const result = await service.listSessions({ kind: "subagent" });
  assert.deepEqual(idsOf(result), ["x1"]);
  assert.equal(result.value.items[0].classificationSource, "corpus+summary");
});

/**
 * 【设计修正 · 「矛盾 ⇒ unknown」被证伪】
 * 最初想把「语料说不是子代理、摘要说是子代理」判成 unknown + `conflict`。
 * 但 `listFields()` 是**条件展开**（`...(header.origin === undefined ? {} : {origin})`），
 * 摘要里没有某个字段只表示「没被带出来」，**不是反证**。
 * 于是「摘要只带正向证据、从不带反向证据」—— 证据只能累加，不能相减。
 * 这一条因此改成：摘要带来的正向证据**必须采信**（宁可归类为子代理而隐藏行，
 * 也不能把它当主会话推到默认视图里 —— 错判方向决定后果）。
 * 缺失≠反证这条推论也在这里被钉住，防止以后有人再把它加回来。
 */
test("分类：证据只累加不相减 —— 摘要带来的正向证据必须采信，缺失不算反证", async () => {
  const service = makeHost({
    records: [record("y1")], // 语料：三项证据都不成立
    summaries: [summary("y1", { origin: "subagent" })], // 摘要：正向声称是子代理
  });

  const result = await service.listSessions({ kind: "all" });
  const row = byId(result)["y1"];
  assert.equal(
    row.classification,
    "subagent",
    "摘要的正向证据必须采信：判成主会话会把它推进默认视图（错判代价最大）",
  );
  assert.equal(row.classificationSource, "summary", "来源如实记为 summary");
  assert.equal(row.subagent, true);
  assert.equal(result.value.kind.unknownTotal, 0);

  // 反向：摘要只是**没带** origin（缺失），不得因此否定语料的子代理证据。
  const reverse = makeHost({
    records: [record("y2", { origin: "subagent" })],
    summaries: [summary("y2")], // 摘要没带 origin —— 缺失，不是反证
  });
  const reverseResult = await reverse.listSessions({ kind: "all" });
  const reverseRow = byId(reverseResult)["y2"];
  assert.equal(reverseRow.classification, "subagent", "缺失不是反证，不得把子代理降级");
  assert.equal(reverseRow.classificationSource, "corpus");
  assert.equal(reverseResult.value.kind.unknownTotal, 0);
});

test("分类：摘要多出一条语料里没有的会话时，该行判 unknown，其余照常", async () => {
  const service = makeHost({
    records: [record("m1"), record("s1", { origin: "subagent" })],
    summaries: [summary("m1"), summary("s1", { origin: "subagent" }), summary("ghost")],
  });

  const all = await service.listSessions({ kind: "all" });
  const rows = byId(all);
  assert.equal(rows["m1"].classification, "main");
  assert.equal(rows["s1"].classification, "subagent");
  assert.equal(rows["ghost"].classification, "unknown");
  assert.equal(rows["ghost"].classificationSource, "summary");

  const main = await service.listSessions({ kind: "main" });
  assert.deepEqual(idsOf(main), ["m1"], "ghost 不得混进主会话视图");
});

// ───────────── ④ 计数自洽与向后兼容 ─────────────

test("分类：三类计数之和等于全库行数，且 kind.filter 如实回显", async () => {
  const service = makeHost({
    records: [
      record("m1"),
      record("m2"),
      record("s1", { origin: "subagent" }),
      record("s2", { parentSession: "m1" }),
    ],
    summaries: [summary("m1"), summary("s1", { origin: "subagent" }), summary("ghost")],
  });

  const all = await service.listSessions({ kind: "all", pageSize: 200 });
  const { mainTotal, subagentTotal, unknownTotal, filter } = all.value.kind;
  assert.equal(filter, "all");
  assert.equal(mainTotal, 2);
  assert.equal(subagentTotal, 2);
  assert.equal(unknownTotal, 1);
  assert.equal(mainTotal + subagentTotal + unknownTotal, all.value.total, "三类必须互斥且穷尽");
});

test("分类：kind 取值非法时退回 main（既有的保守默认不变）", async () => {
  const service = makeHost({ records: [record("m1"), record("s1", { origin: "subagent" })] });
  for (const bogus of ["", "MAIN", "everything", "unknown ", null, 42]) {
    const result = await service.listSessions({ kind: bogus });
    assert.equal(result.value.kind.filter, "main", `kind=${JSON.stringify(bogus)} 应退回 main`);
    assert.deepEqual(idsOf(result), ["m1"]);
  }
});

test("分类：子代理筛选既有语义不变 —— kind=subagent 只含 subagent===true 的行", async () => {
  const service = makeHost({
    records: [record("m1"), record("s1", { origin: "subagent" })],
    summaries: [summary("ghost")],
  });
  const sub = await service.listSessions({ kind: "subagent", pageSize: 200 });
  assert.ok(sub.value.items.every((i) => i.subagent === true));
  const main = await service.listSessions({ kind: "main", pageSize: 200 });
  assert.ok(main.value.items.every((i) => i.subagent !== true));
});

test("分类：分类字段不因标题/项目/归档筛选而丢失", async () => {
  const service = makeHost({
    records: [record("m1"), record("s1", { origin: "subagent" })],
    summaries: [summary("ghost")],
  });
  const result = await service.listSessions({ kind: "all", project: "E:\\proj", archived: "show" });
  for (const row of result.value.items) {
    assert.ok(["main", "subagent", "unknown"].includes(row.classification));
    assert.ok(["corpus", "summary", "corpus+summary", "conflict"].includes(row.classificationSource));
  }
});
