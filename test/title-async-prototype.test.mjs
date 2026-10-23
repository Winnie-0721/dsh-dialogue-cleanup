/**
 * 标题异步化 —— **模拟宿主下的最小竞态原型**
 *
 * ⚠️ 这是原型，不是生产实现，也**不是真实 DSH 验证**。
 *
 * 本文件把 docs/TITLE-ASYNC-DESIGN.md 里的返回契约与合并状态机实现成一个
 * 独立的小状态机（只活在本测试文件内，不 import lib/ 的任何代码，也不修改生产代码），
 * 然后用一个「可控闸门」的假宿主逐条验证设计文档 §4 的不变式（A1/A3/A4/A5/A6/A7）。
 *
 * 验证的是「设计是否自洽」，不是「插件已经实现」。
 */

import test from "node:test";
import assert from "node:assert/strict";

// ─────────────────────────────────────────────────────────────
// 原型：标题异步合并状态机（docs/TITLE-ASYNC-DESIGN.md §2/§3）
// ─────────────────────────────────────────────────────────────

/**
 * @param {{fetchTitles: (ids: string[]) => Promise<Array<{sessionId: string, title: string|null}>>}} deps
 */
function createAsyncTitleBroker({ fetchTitles }) {
  let latestToken = 0;
  const epochs = new Map(); // sessionId -> number，删除时递增
  const cells = new Map(); // sessionId -> {state, title, token, epoch}
  const failures = new Map(); // sessionId -> {count, until}
  const inflight = new Set();

  const epochOf = (id) => epochs.get(id) ?? 0;

  function cellOf(id) {
    let cell = cells.get(id);
    if (cell === undefined) {
      cell = { state: "pending", title: null, token: 0, epoch: epochOf(id) };
      cells.set(id, cell);
    }
    return cell;
  }

  /** 首次渲染：同步返回，不等标题。 */
  function startList(ids) {
    const token = ++latestToken;
    const rows = ids.map((id) => {
      const cell = cellOf(id);
      // 上一次请求已经拿到终态的，直接复用（不重复读）
      if (cell.state === "ready" || cell.state === "empty") {
        return { sessionId: id, title: cell.title, titleState: cell.state, token };
      }
      const cool = failures.get(id);
      if (cool !== undefined && cool.until > 0) {
        return { sessionId: id, title: null, titleState: "unreadable", token };
      }
      cell.state = "pending";
      cell.token = token;
      return { sessionId: id, title: null, titleState: "pending", token };
    });

    const need = rows.filter((r) => r.titleState === "pending").map((r) => r.sessionId);
    if (need.length > 0) {
      const task = fill(token, need).finally(() => inflight.delete(task));
      inflight.add(task);
    }
    return { token, rows };
  }

  async function fill(token, ids) {
    const started = Date.now();
    let results;
    try {
      results = await fetchTitles(ids);
    } catch {
      // 整批失败：不得停在 pending
      for (const id of ids) {
        const cell = cellOf(id);
        if (token !== cell.token || epochOf(id) !== cell.epoch) continue;
        cell.state = "unreadable";
        cell.title = null;
      }
      settleToken(token, started, "failed");
      return;
    }
    for (const id of ids) {
      // 已删除的会话：cell 没了就绝不重建（否则迟到结果会复活幽灵行）
      const cell = cells.get(id);
      if (cell === undefined) continue;
      // 双重栅栏：整批过期 或 该行被删/被改
      if (token !== cell.token) continue;
      if (epochOf(id) !== cell.epoch) continue;
      const found = results.find((r) => r.sessionId === id);
      if (found === undefined || found.error === true) {
        cell.state = "unreadable"; // 读失败
      } else if (found.title === null) {
        cell.state = "empty"; // 宿主确认无标题 ≠ 读取失败
      } else {
        cell.state = "ready";
        cell.title = found.title;
      }
    }
    settleToken(token, started, "complete");
  }

  const stage = new Map(); // token -> {done: Set, failed: boolean}
  function settleToken(token, started, kind) {
    const entry = stage.get(token) ?? { done: false, failed: false };
    entry.done = true;
    entry.failed = entry.failed || kind === "failed";
    entry.ms = Date.now() - started;
    stage.set(token, entry);
  }

  /** 删除会话：递增 epoch，迟到结果不得复活。 */
  function deleteSession(id) {
    epochs.set(id, epochOf(id) + 1);
    cells.delete(id);
    failures.delete(id);
  }

  function describe(ids) {
    const rows = ids.map((id) => {
      const cell = cells.get(id);
      const state = cell === undefined ? "gone" : cell.state;
      return { sessionId: id, title: cell?.title ?? null, titleState: state };
    });
    const count = (s) => rows.filter((r) => r.titleState === s).length;
    const pending = count("pending");
    const ready = count("ready");
    const empty = count("empty");
    const unreadable = count("unreadable");
    const failed = [...stage.values()].some((v) => v.failed === true);
    const state = pending > 0 ? "pending" : failed ? "failed" : ready + empty + unreadable > 0 ? "complete" : "pending";
    return {
      token: latestToken,
      titles: { token: latestToken, state, pending, ready, empty, unreadable },
      rows,
    };
  }

  async function whenIdle() {
    while (inflight.size > 0) await Promise.allSettled([...inflight]);
  }

  return { startList, describe, deleteSession, whenIdle, _cells: cells, _epochs: epochs };
}

// ─────────────────────────────────────────────────────────────
// 假宿主：可控闸门
// ─────────────────────────────────────────────────────────────

function makeGate() {
  let open;
  const promise = new Promise((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** 让已放行的批次把微任务跑完（不等待其它仍在途的批次） */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

function makeFakeHost({ titleOf } = {}) {
  const gates = [];
  const calls = [];
  const fetchTitles = async (ids) => {
    calls.push([...ids]);
    const gate = makeGate();
    gates.push(gate);
    await gate.promise; // 由测试决定何时放行
    return ids.map((id) => {
      // 单条读取失败：真实宿主的批量 API 会给逐条 status，不是整批 reject
      try {
        return { sessionId: id, title: titleOf === undefined ? `t-${id}` : titleOf(id) };
      } catch {
        return { sessionId: id, title: null, error: true };
      }
    });
  };
  return {
    fetchTitles,
    calls,
    /** 只放行最早的一个批次（模拟乱序：旧请求可以比新请求更晚回来） */
    releaseNext() {
      const gate = gates.shift();
      if (gate === undefined) return false;
      gate.open();
      return true;
    },
    releaseAll() {
      const pending = gates.splice(0, gates.length);
      for (const g of pending) g.open();
      return pending.length;
    },
  };
}

// ─────────────────────────────────────────────────────────────
// 不变式验证
// ─────────────────────────────────────────────────────────────

test("原型 A1：标题被阻塞 800ms 时，首屏必须立即返回且行齐全", async () => {
  const host = makeFakeHost();
  const broker = createAsyncTitleBroker({ fetchTitles: host.fetchTitles });
  const ids = ["a", "b", "c"];

  const t0 = Date.now();
  const first = broker.startList(ids);
  const firstPaintMs = Date.now() - t0;

  assert.equal(first.rows.length, 3, "首屏必须一次性给出全部行（行先齐、标题后到）");
  assert.ok(first.rows.every((r) => r.titleState === "pending" && r.title === null));
  assert.ok(firstPaintMs < 100, `首屏必须在 100ms 内返回，实际 ${firstPaintMs}ms`);

  await new Promise((r) => setTimeout(r, 50));
  const mid = broker.describe(ids);
  assert.equal(mid.titles.state, "pending", "标题未就绪时不得谎报 complete");
  assert.equal(mid.titles.pending, 3);

  host.releaseAll();
  await broker.whenIdle();
  const done = broker.describe(ids);
  assert.equal(done.titles.state, "complete");
  assert.deepEqual(
    done.rows.map((r) => r.titleState),
    ["ready", "ready", "ready"],
  );
});

test("原型 A3：每条最终必有终态，禁止永久 pending", async () => {
  const host = makeFakeHost();
  const broker = createAsyncTitleBroker({ fetchTitles: host.fetchTitles });
  const ids = ["a", "b"];
  broker.startList(ids);
  host.releaseAll();
  await broker.whenIdle();

  const out = broker.describe(ids);
  for (const row of out.rows) {
    assert.ok(
      ["ready", "empty", "unreadable"].includes(row.titleState),
      `行 ${row.sessionId} 停在 ${row.titleState}，违反「必有终态」`,
    );
  }
});

test("原型 A4：旧 token 的迟到结果不得覆盖新 token", async () => {
  const host = makeFakeHost();
  const broker = createAsyncTitleBroker({ fetchTitles: host.fetchTitles });
  const ids = ["a"];

  broker.startList(ids); // token=1，先不放行
  const second = broker.startList(ids); // token=2，同一 id
  assert.equal(second.token, 2);

  // 先放行 token=1 的那批（模拟乱序：旧请求后来才回来）
  assert.equal(host.releaseNext(), true, "应当有两个在途批次");
  await settle();

  const out = broker.describe(ids);
  // 旧 token 的结果被丢弃，该行仍在等待 token=2
  assert.equal(out.rows[0].titleState, "pending", "旧 token 的结果不得写入当前行");
  assert.equal(out.titles.state, "pending");

  // token=2 回来后才可写入
  assert.equal(host.releaseNext(), true);
  await settle();
  assert.equal(broker.describe(ids).rows[0].titleState, "ready");
});

test("原型 A5：删除期间到达的标题结果不得复活该会话", async () => {
  const host = makeFakeHost();
  const broker = createAsyncTitleBroker({ fetchTitles: host.fetchTitles });
  const ids = ["a", "b"];

  broker.startList(ids);
  broker.deleteSession("a"); // 删除发生在标题回来之前
  host.releaseAll();
  await broker.whenIdle();

  const out = broker.describe(ids);
  assert.equal(out.rows[0].titleState, "gone", "已删除的会话不得重新出现");
  assert.equal(out.rows[0].title, null);
  assert.equal(broker._cells.has("a"), false, "迟到结果不得写回缓存");
  // 未删除的那条正常拿到标题
  assert.equal(out.rows[1].titleState, "ready");
});

test("原型 A6：整批读取失败必须报 failed，不得停在 pending", async () => {
  let reject;
  const broker = createAsyncTitleBroker({
    fetchTitles: () =>
      new Promise((_resolve, rj) => {
        reject = rj;
      }),
  });
  const ids = ["a", "b"];
  broker.startList(ids);
  reject(new Error("boom"));
  await broker.whenIdle();

  const out = broker.describe(ids);
  assert.equal(out.titles.state, "failed", "失败必须可见，否则前端会无限退避");
  assert.equal(out.titles.unreadable, 2);
  assert.equal(out.titles.pending, 0);
});

test("原型 A7：empty（宿主确认无标题）与 unreadable（读失败）必须可区分", async () => {
  const host = makeFakeHost({
    titleOf: (id) => {
      if (id === "none") return null; // 宿主确认无标题
      throw new Error(`read failed: ${id}`); // 读取失败
    },
  });
  const broker = createAsyncTitleBroker({ fetchTitles: host.fetchTitles });
  const ids = ["none", "broken"];

  broker.startList(ids);
  host.releaseAll();
  await broker.whenIdle();

  const out = broker.describe(ids);
  assert.equal(out.titles.empty, 1, "无标题的会话应计为 empty");
  assert.equal(out.titles.unreadable, 1, "读取失败的会话应计为 unreadable");
  assert.equal(out.rows[0].titleState, "empty");
  assert.equal(out.rows[1].titleState, "unreadable");
});

test("原型：已拿到终态的会话不重复读（避免每轮重付成本）", async () => {
  const host = makeFakeHost();
  const broker = createAsyncTitleBroker({ fetchTitles: host.fetchTitles });
  broker.startList(["a"]);
  host.releaseAll();
  await broker.whenIdle();
  assert.equal(host.calls.length, 1);

  broker.startList(["a"]); // 第二次请求
  await broker.whenIdle();
  assert.equal(host.calls.length, 1, "已有终态的会话不得再次发起读取");
  assert.equal(broker.describe(["a"]).rows[0].titleState, "ready");
});
