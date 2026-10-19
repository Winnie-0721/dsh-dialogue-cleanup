/**
 * 批量删除语义测试（任务书 §4.4）
 *
 * 只测批量路径的**结果语义**：
 *   · complete / partial / no-op / refused / failed 必须两两可区分
 *   · 重复 id 必须去重（不能靠「删两次」污染统计）
 *   · 必须给出**精确的重试清单**（只重试失败或降级的条目）
 *   · 任一子项有降级 ⇒ 整批不得报 allComplete
 *
 * 用真实 HTTP 路由 + 真实临时 DSH_HOME，不 mock service。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

let counter = 0;

function makeReq({ method = "POST", headers = {}, body = null } = {}) {
  const stream = body === null ? Readable.from([]) : Readable.from([Buffer.from(body)]);
  stream.method = method;
  stream.headers = headers;
  stream.socket = { remoteAddress: "127.0.0.1" };
  return stream;
}

function makeRes() {
  const captured = { status: null, headers: null, body: "" };
  return {
    captured,
    writeHead(status, headers) { captured.status = status; captured.headers = headers; },
    end(text) { if (typeof text === "string") captured.body += text; },
  };
}

/** 起一个真实的插件路由 + 隔离 DSH_HOME。 */
async function makeApp({ sessionControllerItems = [], sessions = null } = {}) {
  const { apply } = await import("../lib/index.js");
  const base = await mkdtemp(join(tmpdir(), `dscc-batch-${counter += 1}-`));
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = base;
  const root = join(base, "sessions");

  const defaultSessions = () => {
    const live = new Map();
    for (const it of sessionControllerItems) {
      if (it.running !== true) live.set(it.sessionId, { detach() { live.delete(it.sessionId); } });
    }
    return { list: () => [...live.keys()].map((id) => ({ id })), store: live };
  };

  const services = {
    sessions: sessions ?? defaultSessions(),
    sessionController: { list: async () => ({ items: sessionControllerItems }) },
    workspaceRegistry: { list: () => [], detachSession: () => {} },
    agents: { get: () => undefined },
  };
  const routes = new Map();
  const ctx = {
    logger: { warn() {}, debug() {} },
    get: (k) => services[k],
    webServer: { register(route) { routes.set(route.path, route.handler); return () => {}; } },
    effect: (cb) => cb(),
    emit: () => {},
  };
  apply(ctx, { audit: false, matchAlternateIdSpelling: false });

  const call = async (payload) => {
    const res = makeRes();
    await routes.get("/api-ext/dialogue-cleanup/delete")(
      makeReq({
        method: "POST",
        headers: { "sec-fetch-site": "same-origin", "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
      res,
    );
    return { status: res.captured.status, body: JSON.parse(res.captured.body) };
  };

  return {
    call,
    root,
    base,
    seed: async (id, proj = "p") => {
      await mkdir(join(root, proj, id), { recursive: true });
      await writeFile(join(root, proj, id, "session.v4.jsonl.zstd"), "x");
    },
    restore: async () => {
      if (prevHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = prevHome;
      await rm(base, { recursive: true, force: true }).catch(() => {});
    },
  };
}

// ─────────────────────────────────────────────────────────────
// 1. 全部成功 → allComplete:true，complete 与 total 相等
// ─────────────────────────────────────────────────────────────
test("§4.4 批量：全部成功 → allComplete=true，且逐条 outcome=deleted", async () => {
  const app = await makeApp({
    sessionControllerItems: [
      { sessionId: "b1", running: false, blank: false, updatedAt: 1 },
      { sessionId: "b2", running: false, blank: false, updatedAt: 1 },
    ],
  });
  try {
    await app.seed("b1");
    await app.seed("b2");
    const { status, body } = await app.call({ sessionIds: ["b1", "b2"] });
    assert.equal(status, 200);
    const v = body.value;
    assert.equal(v.total, 2);
    assert.equal(v.ok, 2);
    assert.equal(v.fail, 0);
    assert.equal(v.complete, 2, "两条都完整成功");
    assert.equal(v.degraded, 0);
    assert.equal(v.noop, 0);
    assert.equal(v.allComplete, true, "整批完整成功");
    assert.deepEqual(v.retry, [], "没有需要重试的条目");
    assert.ok(v.outcomes.every((o) => o.outcome === "deleted"), "逐条 outcome 必须是 deleted");
  } finally {
    await app.restore();
  }
});

// ─────────────────────────────────────────────────────────────
// 2. 重复 id 必须去重（不能报 total:2/ok:2 而实际只删一次）
// ─────────────────────────────────────────────────────────────
test("§4.4 批量：重复 id 去重 → duplicates 如实报出，不重复删", async () => {
  const app = await makeApp({ sessionControllerItems: [{ sessionId: "d1", running: false, blank: false, updatedAt: 1 }] });
  try {
    await app.seed("d1");
    const { body } = await app.call({ sessionIds: ["d1", "d1", "d1"] });
    const v = body.value;
    assert.equal(v.requested, 3, "用户提交了 3 条");
    assert.equal(v.duplicates, 2, "其中 2 条是重复");
    assert.equal(v.total, 1, "实际只处理 1 条");
    assert.equal(v.files, 1, "只删了 1 个目录（不是 3 次）");
  } finally {
    await app.restore();
  }
});

// ─────────────────────────────────────────────────────────────
// 3. 混合：成功 + 运行中拒绝 + 不存在（noop）→ 三者必须可区分
// ─────────────────────────────────────────────────────────────
test("§4.4 批量：成功 / refused / noop 三种 outcome 可区分，且 retry 只含前两类", async () => {
  const app = await makeApp({
    sessionControllerItems: [
      { sessionId: "ok-1", running: false, blank: false, updatedAt: 1 },
      { sessionId: "run-1", running: true, blank: false, updatedAt: 1 },
    ],
  });
  try {
    await app.seed("ok-1");
    await app.seed("run-1"); // 运行中有磁盘目录，但必须被拒绝且不动它

    const { body } = await app.call({ sessionIds: ["ok-1", "run-1", "ghost-1"] });
    const v = body.value;

    const byId = Object.fromEntries(v.outcomes.map((o) => [o.sessionId, o]));
    assert.equal(byId["ok-1"].outcome, "deleted", "正常删除 → deleted");
    assert.equal(byId["run-1"].outcome, "refused", "运行中 → refused");
    assert.equal(byId["ghost-1"].outcome, "noop", "不存在 → noop");

    assert.equal(v.ok, 2, "ok-1 与 ghost-1 都算 ok（幂等语义）");
    assert.equal(v.fail, 1, "run-1 失败");
    assert.equal(v.noop, 1, "ghost-1 是 noop");
    assert.equal(v.allComplete, false, "有 refused/noop → 不得报整批完整成功");

    // refused 必须进重试清单（用户处理完会话状态后可以重试）
    assert.ok(v.retry.includes("run-1"), `retry 应含 run-1，实际 ${JSON.stringify(v.retry)}`);
    // noop 不该重试（本来就不存在，重试没有意义）
    assert.ok(!v.retry.includes("ghost-1"), "noop 不该进重试清单");
    // 已完整成功的不该重试
    assert.ok(!v.retry.includes("ok-1"), "完整成功的条目不该进重试清单");

    // 被拒的运行中会话，磁盘必须原封不动
    const still = await stat(join(app.root, "p", "run-1")).then(() => true).catch(() => false);
    assert.equal(still, true, "被拒绝的会话目录不得被删");
  } finally {
    await app.restore();
  }
});

// ─────────────────────────────────────────────────────────────
// 4. 部分成功（有降级）⇒ 不得 allComplete，且该条进重试清单
// ─────────────────────────────────────────────────────────────
test("§4.4 批量：某条有降级 → allComplete=false 且该条 retryable", async () => {
  // 让 sessions.list 抛错 → 每条都产生 readLiveIds 降级
  const app = await makeApp({
    sessionControllerItems: [{ sessionId: "dg-1", running: false, blank: false, updatedAt: 1 }],
    sessions: { list: () => { throw new Error("list boom"); }, store: new Map() },
  });
  try {
    await app.seed("dg-1");
    const { body } = await app.call({ sessionIds: ["dg-1"] });
    const v = body.value;
    assert.equal(v.allComplete, false, "有降级就不得报整批完整成功");
    assert.equal(v.degraded, 1, "应记 1 条降级");
    assert.equal(v.outcomes[0].retryable, true, "有降级的条目必须标记为可重试");
    assert.ok(v.retry.includes("dg-1"), "降级条目必须进重试清单");
    assert.equal(v.outcomes[0].complete, false, "该条 complete 必须为 false");
    // 降级明细必须能定位到步骤
    assert.ok(v.degradations.some((d) => d.step === "readLiveIds"), "降级明细必须带步骤名");
  } finally {
    await app.restore();
  }
});

// ─────────────────────────────────────────────────────────────
// 5. 非法 id 不影响其余条目（既有契约），且 outcome=blocked 不重试
// ─────────────────────────────────────────────────────────────
test("§4.4 批量：非法 id → outcome=blocked，不重试，且不影响其余条目", async () => {
  const app = await makeApp({ sessionControllerItems: [{ sessionId: "good-1", running: false, blank: false, updatedAt: 1 }] });
  try {
    await app.seed("good-1");
    const { status, body } = await app.call({ sessionIds: ["good-1", "../evil"] });
    assert.equal(status, 200, "整体仍成功");
    const v = body.value;
    const bad = v.outcomes.find((o) => o.sessionId === "../evil");
    assert.equal(bad.outcome, "blocked", "非法 id → blocked");
    assert.equal(bad.retryable, false, "非法 id 重试也没用");
    assert.ok(!v.retry.includes("../evil"), "blocked 不该进重试清单");
    assert.ok(v.retry.length === 0, "其余都成功 → 重试清单应为空");
  } finally {
    await app.restore();
  }
});
