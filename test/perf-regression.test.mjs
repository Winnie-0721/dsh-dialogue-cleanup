/**
 * PERF-03 阶段 C：性能改动的回归与安全约束测试。
 *
 * 只测「优化后行为必须与优化前一致」以及「并发/失败路径的新语义」。
 * 全部用 fake I/O（可控、可重复、不对真实会话做任何操作）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createService } from "../lib/service.js";
import { resolveConfig } from "../lib/config.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 造一个可控的 fake 宿主。 */
function makeEnv({ n = 20, titleDelayMs = 0, overrides = {} } = {}) {
  const records = Array.from({ length: n }, (_, i) => ({
    header: {
      id: `s-${String(i).padStart(3, "0")}`,
      cwd: `E:\\p${i % 3}`,
      createdAt: 1700000000000 + i * 1000,
      origin: i % 5 === 0 ? "subagent" : undefined,
    },
    live: true,
    persisted: true,
  }));

  const counters = { corpus: 0, summary: 0, titleCalls: 0, titleIds: 0 };

  const services = {
    sessionQuery: {
      listSessions: async () => {
        counters.corpus += 1;
        return records;
      },
      readTitleSnapshots: async (ids) => {
        counters.titleCalls += 1;
        counters.titleIds += ids.length;
        if (titleDelayMs > 0) await sleep(ids.length * titleDelayMs);
        return ids.map((id) => ({ sessionId: id, status: "fulfilled", value: { title: { title: `T:${id}` } } }));
      },
    },
    sessionController: {
      list: async () => {
        counters.summary += 1;
        return { items: records.map((r) => ({ sessionId: r.header.id, running: false, blank: false, updatedAt: 1700000000000 })) };
      },
    },
    workspaceRegistry: { list: () => [] },
    agents: { get: () => undefined },
    sessions: { list: () => [] },
    ...overrides,
  };

  const logs = [];
  const ctx = {
    logger: { warn() {}, debug: (m) => logs.push(String(m)) },
    get: (k) => services[k],
  };

  const make = (cfg = {}) =>
    createService(ctx, resolveConfig({ audit: false, ...cfg }), {
      record: async () => ({ ok: true, path: null }),
      enabled: false,
      path: null,
    });

  return { make, counters, records, logs, services };
}

// ─────────────────────────────────────────────────────────────
// 1. 结果一致性：冷 / 热 / 优化后必须完全相同
// ─────────────────────────────────────────────────────────────
test("PERF-03 C-1：冷缓存与热缓存返回完全一致（数量/顺序/字段）", async () => {
  const env = makeEnv({ n: 20 });
  const svc = env.make();

  const cold = await svc.listSessions({ pageSize: 10 });
  const hot = await svc.listSessions({ pageSize: 10 });

  assert.equal(cold.ok, true);
  assert.equal(hot.ok, true);
  assert.deepEqual(hot.value.items, cold.value.items, "热查的 items 必须与冷查逐字段相同");
  assert.equal(hot.value.total, cold.value.total);
  assert.deepEqual(hot.value.page, cold.value.page);
  // 冷查确实读了标题，热查应全部命中缓存
  assert.ok(cold.value.titles.fetched > 0, "冷查应实际读取标题");
  assert.equal(hot.value.titles.cached, cold.value.titles.requested, "热查应全部命中缓存");
  assert.equal(hot.value.titles.fetched, 0, "热查不应再发起标题读取");
});

// ─────────────────────────────────────────────────────────────
// 2. 过滤 / 排序 / 分页语义不变
// ─────────────────────────────────────────────────────────────
test("PERF-03 C-2：过滤、排序、分页语义不变", async () => {
  const env = makeEnv({ n: 30 });
  const svc = env.make();

  // 分页：第 1 页与第 2 页不重叠，且总页数正确
  const p1 = await svc.listSessions({ pageSize: 10, page: 1 });
  const p2 = await svc.listSessions({ pageSize: 10, page: 2 });
  assert.equal(p1.value.total, p2.value.total, "两页的 total 必须相同（全库计数）");
  const ids1 = p1.value.items.map((i) => i.sessionId);
  const ids2 = p2.value.items.map((i) => i.sessionId);
  assert.equal(ids1.filter((id) => ids2.includes(id)).length, 0, "两页不得重叠");

  // 排序：默认按 activity 倒序（updatedAt 相同则回退 createdAt），必须单调不增
  const all = await svc.listSessions({ pageSize: 200 });
  const keys = all.value.items.map((i) => i.updatedAt ?? i.createdAt ?? "");
  for (let i = 1; i < keys.length; i += 1) {
    assert.ok(keys[i - 1] >= keys[i], `排序必须单调不增：${keys[i - 1]} vs ${keys[i]}`);
  }

  // 过滤：kind=subagent 只返回 subagent 行
  const sub = await svc.listSessions({ kind: "subagent", pageSize: 200 });
  assert.ok(sub.value.items.every((i) => i.subagent === true), "kind=subagent 必须只含子代理行");
  const main = await svc.listSessions({ kind: "main", pageSize: 200 });
  assert.ok(main.value.items.every((i) => i.subagent !== true), "kind=main 必须只含主会话");
  // 【TASK-CLASSIFICATION-01】三分类而不只是两类：身份未知的行既不是子代理
  // 也不是主会话，必须单独成一档。所以这里的恒等式是三档之和 = all，
  // 而且 main 视图不得包含任何 unknown 行（否则就是「未分类会话混进主会话」）。
  const unknown = await svc.listSessions({ kind: "unknown", pageSize: 200 });
  assert.ok(
    unknown.value.items.every((i) => i.classification === "unknown"),
    "kind=unknown 必须只含身份未知行",
  );
  assert.equal(
    sub.value.total + main.value.total + unknown.value.total,
    await svc.listSessions({ kind: "all", pageSize: 200 }).then((r) => r.value.total),
    "subagent + main + unknown 必须等于 all（三分类互斥且完备）",
  );
});

// ─────────────────────────────────────────────────────────────
// 3. 同一请求内不重复读同一标题
// ─────────────────────────────────────────────────────────────
test("PERF-03 C-3：单请求内每个标题只读一次", async () => {
  const env = makeEnv({ n: 20 });
  const svc = env.make();
  env.counters.titleIds = 0;
  env.counters.titleCalls = 0;

  const r = await svc.listSessions({ pageSize: 10 });
  // 10 行、并发 8 → 最多 8 个 RPC，且读取的 id 总数应恰好等于需要的标题数
  assert.equal(
    env.counters.titleIds,
    r.value.titles.requested,
    `读取的标题数(${env.counters.titleIds})必须等于需要的(${r.value.titles.requested})，不得重复`,
  );
  assert.ok(env.counters.titleCalls <= 8, `RPC 次数不得超过并发上限 8，实际 ${env.counters.titleCalls}`);
});

// ─────────────────────────────────────────────────────────────
// 4. 【核心优化】并发请求复用同一批标题读取（single-flight）
// ─────────────────────────────────────────────────────────────
test("PERF-03 C-4：N 个并发请求只读一次同一批标题（single-flight）", async () => {
  const env = makeEnv({ n: 50, titleDelayMs: 2 });
  const svc = env.make();
  env.counters.titleIds = 0;

  // 8 个并发请求，全部要同一批标题
  const results = await Promise.all(
    Array.from({ length: 8 }, () => svc.listSessions({ pageSize: 50 })),
  );

  // 结果必须完全一致（不得串线）
  for (const r of results) {
    assert.equal(r.ok, true);
    assert.deepEqual(r.value.items, results[0].value.items, "并发请求的结果必须一致，不得串线");
  }

  // 【注意】默认 kind=main 会过滤掉 subagent 行（本数据集 20% 是 subagent），
  // 所以实际需要的标题数是 requested，不是 50。用 requested 作为期望值才对。
  const need = results[0].value.titles.requested;
  assert.ok(need > 0, "应当有需要读取的标题");
  assert.equal(
    env.counters.titleIds,
    need,
    `8 并发应只读 ${need} 条标题（复用），实际读了 ${env.counters.titleIds} 条 —— ` +
      `若为 ${need * 8} 则 single-flight 未生效`,
  );
});

// ─────────────────────────────────────────────────────────────
// 5. 初始化失败后可恢复（不得永久缓存失败）
// ─────────────────────────────────────────────────────────────
test("PERF-03 C-5：标题读取失败后能重试恢复，不会永久卡在失败", async () => {
  // 【注意】让**所有**分片都失败，才能测「全部 10 条都被记为失败」。
  // 只失败一次的话，8 个分片里只有 1 片失败（实测 failed=2，那是对的），
  // 不能拿它当「计数错误」的证据。
  let failAll = true;
  const env = makeEnv({ n: 10 });
  const real = env.services.sessionQuery.readTitleSnapshots;
  env.services.sessionQuery.readTitleSnapshots = async (ids) => {
    if (failAll) throw new Error("transient title failure");
    return real(ids);
  };
  const svc = env.make();

  const first = await svc.listSessions({ kind: "all", pageSize: 10 });
  assert.equal(first.ok, true, "标题失败不得让整个请求失败");
  assert.equal(first.value.titles.failed, 10, "所有分片都失败时，10 条必须都如实计入 failed");
  assert.equal(first.value.titles.fetched, 0);
  // 【关键】失败不得被缓存成「没有标题」
  assert.ok(
    first.value.items.every((i) => i.title === null),
    "失败时 title 应为 null（不静默变成空字符串）",
  );

  // 第二次应重新尝试并成功（说明失败没有被永久缓存）
  failAll = false;
  const second = await svc.listSessions({ kind: "all", pageSize: 10 });
  assert.equal(second.value.titles.failed, 0, "第二次应成功（失败没有被永久缓存）");
  assert.ok(second.value.titles.fetched > 0, "第二次应实际读取");
  assert.ok(
    second.value.items.every((i) => typeof i.title === "string" && i.title.startsWith("T:")),
    "恢复后标题必须真的取到",
  );
});

// ─────────────────────────────────────────────────────────────
// 6. 并发中的失败不影响其他请求
// ─────────────────────────────────────────────────────────────
test("PERF-03 C-6：并发时一个请求失败不污染其他请求", async () => {
  const env = makeEnv({ n: 20 });
  let call = 0;
  const real = env.services.sessionQuery.readTitleSnapshots;
  env.services.sessionQuery.readTitleSnapshots = async (ids) => {
    call += 1;
    if (call === 1) throw new Error("first batch fails");
    return real(ids);
  };
  const svc = env.make();

  const results = await Promise.all(
    Array.from({ length: 4 }, () => svc.listSessions({ pageSize: 20 })),
  );
  for (const r of results) {
    assert.equal(r.ok, true, "任何并发分支都不得让整个请求抛错");
  }
  // 所有请求的行数一致（失败不得导致少行）
  const totals = new Set(results.map((r) => r.value.total));
  assert.equal(totals.size, 1, `并发结果行数必须一致，实际 ${[...totals]}`);
});

// ─────────────────────────────────────────────────────────────
// 7. 语料/摘要读取失败不静默（安全约束）
// ─────────────────────────────────────────────────────────────
test("PERF-03 C-7：语料/摘要读取失败不得静默当成「没有会话」", async () => {
  // 语料失败 → 仍应通过摘要列出会话（默认 kind=main，故扣掉 subagent 行）
  {
    const env = makeEnv({ n: 5 });
    env.services.sessionQuery.listSessions = async () => {
      throw new Error("corpus down");
    };
    const svc = env.make();
    const r = await svc.listSessions({ kind: "all", pageSize: 10 });
    assert.equal(r.ok, true);
    assert.equal(r.value.sources.corpus, "none", "语料失败必须如实标记为 none");
    assert.equal(r.value.total, 5, "不得因语料失败而返回 0 行（那是静默丢数据）");
  }
  // 摘要失败 → 语料仍在
  {
    const env = makeEnv({ n: 5 });
    env.services.sessionController.list = async () => {
      throw new Error("summary down");
    };
    const svc = env.make();
    const r = await svc.listSessions({ kind: "all", pageSize: 10 });
    assert.equal(r.ok, true);
    assert.equal(r.value.sources.summary, "none");
    assert.equal(r.value.total, 5, "摘要失败不得导致 0 行");
  }
});

// ─────────────────────────────────────────────────────────────
// 8. 指标不改变返回值、不泄露标题
// ─────────────────────────────────────────────────────────────
test("PERF-03 C-8：阶段指标不改返回值，且日志不含标题正文", async () => {
  const SECRET = "机密标题-不应出现在日志里";
  const env = makeEnv({ n: 5 });
  env.services.sessionQuery.readTitleSnapshots = async (ids) =>
    ids.map((id) => ({ sessionId: id, status: "fulfilled", value: { title: { title: SECRET } } }));
  const svc = env.make();

  const r = await svc.listSessions({ pageSize: 5 });
  // 结果里当然要有标题（那是功能）
  assert.equal(r.value.items[0].title, SECRET);

  // 但日志里绝不能有
  const joined = env.logs.join("\n");
  assert.ok(joined.includes("total="), "应输出结构化摘要（用于诊断）");
  assert.ok(joined.includes("titles="), "摘要应含 titles 阶段");
  assert.ok(!joined.includes(SECRET), "日志绝不得包含标题正文");
  // 也不得含 cwd 路径
  assert.ok(!joined.includes("E:\\p0"), "日志绝不得包含会话路径");
});

// ─────────────────────────────────────────────────────────────
// 9. 安全边界：查询优化不得放宽删除保护
// ─────────────────────────────────────────────────────────────
test("PERF-03 C-9：查询优化不影响 deletable 判定（运行中仍被拦）", async () => {
  const env = makeEnv({ n: 3 });
  env.services.sessionController.list = async () => ({
    items: [
      { sessionId: "s-001", running: true, blank: false, updatedAt: 1700000000000 },
      { sessionId: "s-002", running: false, blank: false, updatedAt: 1700000000000 },
    ],
  });
  // 【注意】用 kind=all：makeEnv 里 i%5===0 的行是 subagent，默认 kind=main 会把它过滤掉，
  // 那样 find 就取不到行（不是 deletable 判定的问题）。
  const svc = env.make({ requireIdleSession: true });
  const r = await svc.listSessions({ kind: "all", pageSize: 10 });

  const running = r.value.items.find((i) => i.sessionId === "s-001");
  assert.ok(running, "s-001 必须出现在结果里");
  assert.equal(running.running, true);
  assert.equal(running.deletable, false, "运行中的会话必须不可删");
  assert.ok(running.blockedReason, "必须给出阻止原因");

  const idle = r.value.items.find((i) => i.sessionId === "s-002");
  assert.ok(idle, "s-002 必须出现在结果里");
  assert.equal(idle.deletable, true, "空闲会话可删");
});
