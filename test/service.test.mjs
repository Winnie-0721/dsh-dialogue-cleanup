import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detachLiveStore,
  detachWorkspaces,
  clearRegistryRecords,
  stopIdleAgent,
  inspectRunning,
  fetchRunningSnapshot,
  judgeRunning,
  getService,
  createService,
} from "../lib/service.js";
import { resolveConfig } from "../lib/config.js";

/**
 * 造一个**会抛错的** ctx：模拟真实 Cordis —— 只有 inject 里声明的服务可直接访问，
 * 未注入的服务做属性访问会抛错。
 *
 * 【这个替身是为了防一类真实 bug】实测 `/status` 返回「空 body 的 400」，
 * 根因就是 handler 里写了 `ctx?.sessions?.store` —— 真实宿主上抛错、还没走到 sendJson。
 * 用普通对象 ctx 的单测观察不到这个差异，所以这里显式模拟抛错行为。
 */
function makeStrictCtx(services = {}) {
  const injected = new Set(["webServer"]);
  const ctx = {
    logger: { warn() {}, debug() {}, info() {} },
    get(name) {
      return services[name];
    },
    webServer: { register: () => () => {} },
  };
  for (const name of [
    "sessions",
    "agents",
    "sessionController",
    "sessionQuery",
    "workspaceRegistry",
    "layout",
  ]) {
    Object.defineProperty(ctx, name, {
      get() {
        if (!injected.has(name)) {
          throw new Error(`cannot get property "${name}" without injection`);
        }
        return services[name];
      },
      configurable: true,
    });
  }
  return ctx;
}

test("getService：未注入的服务返回 undefined，而不是抛错", () => {
  const ctx = makeStrictCtx({});
  assert.throws(() => ctx.sessions, /without injection/, "替身必须像真实 Cordis 一样严格");
  assert.equal(getService(ctx, "sessions"), undefined);
  assert.equal(getService(ctx, "agents"), undefined);
  assert.equal(getService(ctx, "workspaceRegistry"), undefined);
  assert.equal(getService(undefined, "sessions"), undefined);
  assert.equal(getService(null, "sessions"), undefined);
});

test("getService：已注入的服务正常返回；get 抛错时降级为 undefined", () => {
  const marker = { hello: true };
  assert.equal(getService(makeStrictCtx({ sessions: marker }), "sessions"), marker);

  const throwing = {
    get() {
      throw new Error("get exploded");
    },
  };
  assert.equal(getService(throwing, "sessions"), undefined);
});

test("capabilities：在严格 ctx 上不抛错（回归：曾导致 /status 空 400）", () => {
  const ctx = makeStrictCtx({});
  const audit = { record: async () => ({ ok: true, path: null }), enabled: false, path: null };
  const service = createService(ctx, resolveConfig({ audit: false }), audit);

  assert.doesNotThrow(() => service.capabilities());
  const caps = service.capabilities();
  assert.equal(caps.detachLive, false, "读不到 sessions 时如实为 false");
  assert.equal(caps.listSessions, false);
  assert.equal(caps.removeArtifacts, true);
  assert.equal(caps.publicStopIdleAgent, false);
});

test("listSessions：在严格 ctx 上不抛错，返回 cleanup-unavailable", async () => {
  const ctx = makeStrictCtx({});
  const audit = { record: async () => ({ ok: true, path: null }), enabled: false, path: null };
  const service = createService(ctx, resolveConfig({ audit: false }), audit);

  const result = await service.listSessions();
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "cleanup-unavailable");
});

test("deleteSession：在严格 ctx 上走完事务（不因未注入服务抛错）", async () => {
  const recorded = [];
  const ctx = makeStrictCtx({});
  const audit = {
    record: async (e) => {
      recorded.push(e);
      return { ok: true, path: null };
    },
    enabled: false,
    path: null,
  };
  const service = createService(ctx, resolveConfig({ audit: false }), audit);

  const result = await service.deleteSession("s1", { kind: "test" });
  assert.equal(result.ok, true, "缺少可选服务时应降级成功，而不是抛错");
  assert.equal(result.value.detached, false, "拿不到 sessions 时如实报 false");
  assert.equal(result.value.workspaces, 0);
  assert.ok(Array.isArray(result.value.removedPaths));
  assert.equal(recorded.length, 1);
});

test("detachLiveStore：优先用公开服务方法", () => {
  let viaService = 0;
  const sessions = { detach: () => { viaService += 1; } };
  assert.equal(detachLiveStore(sessions, "s1"), true);
  assert.equal(viaService, 1);
});

test("detachLiveStore：退而用内部 store Map 上的 entry.detach", () => {
  let called = 0;
  const store = new Map([["s1", { detach: () => { called += 1; } }]]);
  assert.equal(detachLiveStore({ store }, "s1"), true);
  assert.equal(called, 1);
});

test("detachLiveStore：拿不到任何入口时如实返回 false（不抛错，优雅降级）", () => {
  assert.equal(detachLiveStore({ store: new Map() }, "s1"), false);
  assert.equal(detachLiveStore({}, "s1"), false);
  assert.equal(detachLiveStore(undefined, "s1"), false);
  assert.equal(detachLiveStore(null, "s1"), false);
});

test("detachLiveStore：内部入口抛错时降级为 false，不把异常抛给调用方", () => {
  const store = new Map([["s1", { detach: () => { throw new Error("boom"); } }]]);
  assert.equal(detachLiveStore({ store }, "s1"), false);
});

test("detachWorkspaces：**不得**在 detachSession 缺失时虚增计数（修正上游 D7）", async () => {
  const registry = { list: () => [{ sessionIds: ["s1"] }] }; // 没有 detachSession
  assert.equal(await detachWorkspaces(registry, "s1"), 0);
});

test("detachWorkspaces：真正调用成功才计数", async () => {
  let called = 0;
  const registry = {
    list: () => [{ sessionIds: ["s1"], detachSession: async () => { called += 1; } }],
  };
  assert.equal(await detachWorkspaces(registry, "s1"), 1);
  assert.equal(called, 1);
});

test("detachWorkspaces：detachSession 抛错时不计入、不对外抛错", async () => {
  const registry = {
    list: () => [{
      sessionIds: ["s1"],
      detachSession: async () => { throw new Error("workspace detach failed"); },
    }],
  };
  assert.equal(await detachWorkspaces(registry, "s1"), 0);
});

test("detachWorkspaces：sessionIds 是只读数组（getter）时也能识别", async () => {
  let called = 0;
  const registry = {
    list: () => [{
      // 冻结数组：Array.isArray 仍为 true，但模拟上游对只读数组的误判路径
      get sessionIds() { return Object.freeze(["s1"]); },
      detachSession: async () => { called += 1; },
    }],
  };
  assert.equal(await detachWorkspaces(registry, "s1"), 1);
  assert.equal(called, 1);
});

test("detachWorkspaces：不属于该会话的工作区不动", async () => {
  let called = 0;
  const registry = {
    list: () => [
      { sessionIds: ["other"], detachSession: async () => { called += 1; } },
      { sessionIds: [], detachSession: async () => { called += 1; } },
    ],
  };
  assert.equal(await detachWorkspaces(registry, "s1"), 0);
  assert.equal(called, 0);
});

test("detachWorkspaces：缺少 registry / list 时返回 0", async () => {
  assert.equal(await detachWorkspaces(undefined, "s1"), 0);
  assert.equal(await detachWorkspaces({}, "s1"), 0);
});

test("clearRegistryRecords：调用公开幂等 API（unpin / unarchive），但不谎报改动数", async () => {
  const calls = [];
  const registry = {
    unpinSession: async (id) => { calls.push(`unpin:${id}`); },
    unarchiveSession: async (id) => { calls.push(`unarchive:${id}`); },
  };
  // 【回归】旧实现返回 2，对**不存在的会话**也报「清了 2 条」—— 那是编造的数字。
  // 契约明说这两者对未记录的 id 是幂等 no-op（"resolves without writing"），
  // 公开 API 不报告是否真的写入，所以 changed 只能是 null（未知）。
  const outcome = await clearRegistryRecords(registry, "s1");
  assert.equal(outcome.attempted, 2);
  assert.equal(outcome.resolved, 2, "两个公开方法都正常返回");
  assert.equal(outcome.changed, null, "不得把「调用成功」当成「改动了一条」");
  assert.deepEqual(outcome.skipped, []);
  assert.deepEqual(calls, ["unpin:s1", "unarchive:s1"]);
});

test("clearRegistryRecords：方法缺失或抛错不影响整体", async () => {
  const none = await clearRegistryRecords({}, "s1");
  assert.equal(none.attempted, 0);
  assert.deepEqual(none.skipped, ["unpinSession", "unarchiveSession"]);

  const missing = await clearRegistryRecords(undefined, "s1");
  assert.equal(missing.attempted, 0);
  assert.deepEqual(missing.skipped, []);

  const registry = {
    unpinSession: async () => { throw new Error("nope"); },
    unarchiveSession: async () => {},
  };
  const partial = await clearRegistryRecords(registry, "s1");
  assert.equal(partial.attempted, 2, "两个都尝试了");
  assert.equal(partial.resolved, 1, "只有一个正常返回");
  assert.equal(partial.changed, null);
});

test("stopIdleAgent：没有公开停止法时如实返回 false，不碰内部 _unload", async () => {
  assert.equal(await stopIdleAgent({}, {}), false);
  assert.equal(await stopIdleAgent(null, {}), false);
  // 只有内部 _unload（Cordis private）绝不能被调用
  let unloadCalled = 0;
  const agent = { ctx: { fiber: { _unload() { unloadCalled += 1; } } } };
  assert.equal(await stopIdleAgent(agent, {}), false);
  assert.equal(unloadCalled, 0, "不得触碰 fiber._unload()");
});

test("stopIdleAgent：探测到公开 stop 时调用并返回 true", async () => {
  let called = 0;
  assert.equal(await stopIdleAgent({ stop: async () => { called += 1; } }, {}), true);
  assert.equal(called, 1);
});

test("inspectRunning：用 sessionController.list 的 running 字段（权威信号）", async () => {
  const sessionController = {
    list: async () => ({ items: [{ sessionId: "s1", running: true }, { sessionId: "s2", running: false }] }),
  };
  const a1 = await inspectRunning(sessionController, {}, "s1");
  assert.equal(a1.available, true);
  assert.equal(a1.running, true);
  assert.equal(a1.source, "sessionController.list");

  const a2 = await inspectRunning(sessionController, {}, "s2");
  assert.equal(a2.running, false);
});

test("inspectRunning：列表中没有该会话时，有活动 agent 则保守视为占用", async () => {
  const sessionController = { list: async () => ({ items: [] }) };
  const agents = { get: (id) => (id === "s1" ? { id: "s1" } : undefined) };
  const probe = await inspectRunning(sessionController, agents, "s1");
  assert.equal(probe.available, true);
  assert.equal(probe.hasAgent, true);
  assert.equal(probe.running, true, "有活动 agent 时必须保守拒绝");

  const clean = await inspectRunning(sessionController, agents, "s2");
  assert.equal(clean.running, false);
});

test("inspectRunning：sessionController 不可用时降级到 agents.get 并标记不可靠", async () => {
  const probe = await inspectRunning(undefined, { get: () => ({ id: "s1" }) }, "s1");
  assert.equal(probe.available, false);
  assert.equal(probe.running, true);
  assert.match(probe.source, /fallback/);
});

test("inspectRunning：list 抛错时降级，不把异常抛给删除事务", async () => {
  const sessionController = { list: async () => { throw new Error("list failed"); } };
  const probe = await inspectRunning(sessionController, {}, "s1");
  assert.equal(probe.available, false);
  assert.equal(probe.running, false);
});

test("fetchRunningSnapshot / judgeRunning：拆开后与 inspectRunning 语义等价", async () => {
  const sessionController = {
    list: async () => ({ items: [{ sessionId: "s1", running: true, blank: true, updatedAt: 42 }] }),
  };
  const snapshot = await fetchRunningSnapshot(sessionController);
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.byId.size, 1);

  const a = judgeRunning(snapshot, {}, "s1");
  const b = await inspectRunning(sessionController, {}, "s1");
  assert.deepEqual(a, b, "拆分不得改变判定结果");

  // 快照里没有、但有活动 agent → 保守视为占用
  const withAgent = judgeRunning(snapshot, { get: () => ({ id: "sX" }) }, "sX");
  assert.equal(withAgent.running, true);
});

test("fetchRunningSnapshot：不可用/抛错时如实标记，不抛给调用方", async () => {
  assert.equal((await fetchRunningSnapshot(undefined)).available, false);
  assert.equal((await fetchRunningSnapshot({})).available, false);
  const boom = { list: async () => { throw new Error("nope"); } };
  const s = await fetchRunningSnapshot(boom);
  assert.equal(s.available, false);
  assert.equal(s.byId.size, 0);
});

/**
 * 【性能回归】批量删除不得产生 O(N) 次全量列表调用。
 *
 * 旧实现逐条独立探测：200 条 = 200 次 `sessionController.list()` + 200 次
 * `sessions.list()`（实测纯探测 187 ms；live 上 `list()` 有约 100 ms 底噪，
 * 折算约 20 s）。TTL 快照把它压成 O(1)。
 */
test("批量删除：探测次数从 O(N) 降为 O(1)（runningProbeTtlMs 回归）", async () => {
  const { __resetInFlight } = await import("../lib/service.js");

  async function runBatch(n, ttl) {
    __resetInFlight();
    let controllerListCalls = 0;
    let sessionsListCalls = 0;
    const items = Array.from({ length: n }, (_, i) => ({
      sessionId: `s-${i}`, running: false, blank: false, updatedAt: i,
    }));
    const services = {
      sessionController: { list: async () => { controllerListCalls += 1; return { items }; } },
      sessions: { list: () => { sessionsListCalls += 1; return []; } },
      agents: { get: () => undefined },
      workspaceRegistry: { list: () => [] },
    };
    const ctx = { logger: { warn() {}, debug() {} }, get: (k) => services[k] };
    const audit = { record: async () => ({ ok: true, path: null }), enabled: false, path: null };
    const config = resolveConfig({ audit: false, matchAlternateIdSpelling: false, runningProbeTtlMs: ttl });
    const service = createService(ctx, config, audit);
    for (let i = 0; i < n; i += 1) await service.deleteSession(`s-${i}`, { kind: "test" });
    return { controllerListCalls, sessionsListCalls };
  }

  // 默认 TTL：无论删多少条，全量列表只问一次
  const cached = await runBatch(50, 1000);
  assert.equal(cached.controllerListCalls, 1, "50 条批量只探测一次");

  // live id 集合**故意不缓存**：它喂给破坏性的 alternate-spelling 守卫，
  // 用过期数据会让守卫更可能放行删除 —— 违背「宁可不删，不可误删」。
  assert.equal(cached.sessionsListCalls, 50, "live id 集合不缓存，每条都取最新（安全优先）");

  // ttl=0：退回严格语义（每条都重新探测）—— 保留给需要最强一致性的用户
  const strict = await runBatch(10, 0);
  assert.equal(strict.controllerListCalls, 10, "ttl=0 时必须每条都重新探测");
});
