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
  announceSessionRemoved,
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
  assert.equal(result.value.detached, false, "拿不到 sessions 时如实报 detached:false");
  assert.equal(result.value.detach, "failed", "拿不到任何入口 → failed（不可降级成 absent）");
  assert.equal(result.value.workspaces, 0);
  assert.ok(Array.isArray(result.value.removedPaths));
  assert.equal(recorded.length, 1);
});

test("detachLiveStore：优先用公开服务方法", () => {
  let viaService = 0;
  const sessions = { detach: () => { viaService += 1; } };
  assert.equal(detachLiveStore(sessions, "s1"), "detached");
  assert.equal(viaService, 1);
});

test("detachLiveStore：退而用内部 store Map 上的 entry.detach", () => {
  let called = 0;
  const store = new Map([["s1", { detach: () => { called += 1; store.delete("s1"); } }]]);
  assert.equal(detachLiveStore({ store }, "s1"), "detached");
  assert.equal(called, 1);
});

/**
 * 【回归 · 2026-10】三态语义必须区分开。
 *
 * 原来只有两态（true/false），把「本来就不在内存里」和「试了没摘掉」混为一谈。
 * 真实宿主里 `sessions.list()` 就是 live 集合本身，删一个已关闭的会话时它
 * **本来就不在 store 里**，旧逻辑把这句正常收尾显示成「内存条目未摘除（降级）」，
 * 用户每次删旧会话都看到一句吓人的提示，反而盖住真正该关注的情况。
 */
test("detachLiveStore：本就不在 store 里时返回 absent（正常收尾，不是失败）", () => {
  assert.equal(detachLiveStore({ store: new Map() }, "s1"), "absent");
});

test("detachLiveStore：拿不到任何入口时返回 failed（不可降级为 absent）", () => {
  assert.equal(detachLiveStore({}, "s1"), "failed");
  assert.equal(detachLiveStore(undefined, "s1"), "failed");
  assert.equal(detachLiveStore(null, "s1"), "failed");
});

test("detachLiveStore：内部入口抛错时降级为 failed，不把异常抛给调用方", () => {
  const store = new Map([["s1", { detach: () => { throw new Error("boom"); } }]]);
  assert.equal(detachLiveStore({ store }, "s1"), "failed");
});

/**
 * 【回归 · 2026-10】`entry.detach()` 被调用但**没有真正移除**时必须报 failed。
 *
 * 依据 `detachEntered`（dsh-session/lib/types/index.js 第 935 行）：
 *   `if (this.store.get(entry.id) !== entry) return;` —— id 不匹配时**静默返回**，
 *   看起来调用了、其实什么都没删。旧实现在这里无条件 return true，属于谎报成功。
 */
test("detachLiveStore：entry.detach 调用后仍未移除 → failed（不谎报成功）", () => {
  const store = new Map([["s1", { detach: () => {} }]]); // 什么都不做
  assert.equal(detachLiveStore({ store }, "s1"), "failed");
  assert.equal(store.has("s1"), true, "仍然在 store 里 —— 确实没摘掉");
});

test("detachWorkspaces：**不得**在 detachSession 缺失时虚增计数（修正上游 D7）", async () => {
  const registry = { list: () => [{ sessionIds: ["s1"] }] }; // 没有 detachSession
  const out = await detachWorkspaces(registry, "s1");
  assert.equal(out.removed, 0);
  // 【P0 修复 · 2026-10-18】认领了会话却没有摘除入口 = **降级**，必须如实带出来，
  // 不能再像原来那样只返回 0（与「本来就没有工作区」无法区分）。
  assert.ok(out.error !== null, "没有 detachSession 必须如实报降级");
  assert.equal(out.failures.length, 1);
});

test("detachWorkspaces：真正调用成功才计数", async () => {
  let called = 0;
  const registry = {
    list: () => [{ sessionIds: ["s1"], detachSession: async () => { called += 1; } }],
  };
  const out = await detachWorkspaces(registry, "s1");
  assert.equal(out.removed, 1);
  assert.equal(out.error, null, "全部成功时不得报降级");
  assert.equal(called, 1);
});

test("detachWorkspaces：detachSession 抛错时不计入、不对外抛错，但如实报降级", async () => {
  const registry = {
    list: () => [{
      sessionIds: ["s1"],
      detachSession: async () => { throw new Error("workspace detach failed"); },
    }],
  };
  const out = await detachWorkspaces(registry, "s1");
  assert.equal(out.removed, 0);
  assert.match(out.error, /workspace detach failed/, "必须把失败原因如实带出来");
  assert.equal(out.failures.length, 1);
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
  const out = await detachWorkspaces(registry, "s1");
  assert.equal(out.removed, 1);
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
  const out = await detachWorkspaces(registry, "s1");
  assert.equal(out.removed, 0);
  assert.equal(out.error, null, "没有工作区认领它 —— 不是降级");
  assert.equal(called, 0);
});

test("detachWorkspaces：缺少 registry / list 时 removed=0 且如实报不可用", async () => {
  const a = await detachWorkspaces(undefined, "s1");
  assert.equal(a.removed, 0);
  assert.ok(a.error !== null, "registry 不可用必须如实报");
  const b = await detachWorkspaces({}, "s1");
  assert.equal(b.removed, 0);
  assert.ok(b.error !== null);
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
 * 折算约 20 s）。
 *
 * 【2026-10-18 契约更新】O(1) 的位置从「TTL 缓存」换成了「批内复用一份新鲜快照」：
 * 单条删除现在**每次都取新鲜快照**（P1 要求：删除前重新验证状态，不吃可能来自
 * 上次请求的 TTL 缓存），而批量路径由调用方先取一份新鲜快照、批内复用 ——
 * 既新鲜，又仍是 O(1)。这条测试按新契约断言：批内复用 → 1 次；逐条独立 → N 次。
 */
test("批量删除：探测次数从 O(N) 降为 O(1)（批内复用新鲜快照）", async () => {
  const { __resetInFlight } = await import("../lib/service.js");

  /** 模拟 index.js 的批量实现：先取一份新鲜快照，批内复用。 */
  async function runBatch(n) {
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
    const config = resolveConfig({ audit: false, matchAlternateIdSpelling: false });
    const service = createService(ctx, config, audit);
    const batchSnapshot = await service.freshRunningSnapshotForBatch();
    for (let i = 0; i < n; i += 1) {
      await service.deleteSession(`s-${i}`, { kind: "test" }, { runningSnapshot: batchSnapshot });
    }
    return { controllerListCalls, sessionsListCalls };
  }

  // 批内复用：无论删多少条，全量列表只问一次
  const cached = await runBatch(50);
  assert.equal(cached.controllerListCalls, 1, "50 条批量只探测一次");
  assert.equal(cached.sessionsListCalls, 50, "live id 集合不缓存，每条都取最新（安全优先）");

  // 对照：逐条独立调用（不传快照）→ 每条都新鲜探测，安全优先
  const fresh = await runBatchFresh(5);
  assert.equal(fresh.controllerListCalls, 5, "单条删除每次都重新验证状态（P1 要求）");
});

/** 逐条独立删除（不传共享快照）——用于对照「新鲜探测」语义。 */
async function runBatchFresh(n) {
  const { __resetInFlight } = await import("../lib/service.js");
  __resetInFlight();
  let controllerListCalls = 0;
  const services = {
    sessionController: {
      list: async () => {
        controllerListCalls += 1;
        return { items: [] };
      },
    },
    sessions: { list: () => [], store: new Map() },
    agents: { get: () => undefined },
    workspaceRegistry: { list: () => [] },
  };
  const ctx = { logger: { warn() {}, debug() {} }, get: (k) => services[k] };
  const audit = { record: async () => ({ ok: true, path: null }), enabled: false, path: null };
  const service = createService(ctx, resolveConfig({ audit: false }), audit);
  for (let i = 0; i < n; i += 1) await service.deleteSession(`fresh-${i}`, { kind: "test" });
  return { controllerListCalls };
}

/**
 * 「删掉后又出现在未分组」的回归。
 *
 * ─── 官方侧栏为什么会显示「未分组」─────────────────────────────────────────
 * `@deepseek-ai/dsh-client-ui-workspace/lib/client.js` 的 `groupByWorkspace`：
 *   1. 遍历每个 workspace 的 `sessionIds`，命中的记入 `accounted`；
 *   2. 「在会话列表 `list.ids` 里、却不在 `accounted` 里」的行收进 `stray`，
 *      渲染为标题 `group.ungrouped`（中文「未分组」）的那一组。
 *
 * 所以「先摘工作区归属、但会话仍留在宿主内存/列表里」= 亲手制造一条
 * 跑到「未分组」下的幽灵行。下面的断言把这条因果锁死：
 *   · 内存里还留着它 → **不得**摘归属（否则就会落进 stray）；
 *   · 内存里确实没了 → 才允许摘归属（正常收尾）。
 *
 * 反向验证（变异测试）：把 `stillInLiveStore` 判断去掉、无条件摘归属，
 * 「内存里还在时不得摘归属」这条必然失败。
 */
test("回归：会话仍在宿主内存里时**不得**摘工作区归属（否则会出现在「未分组」）", async () => {
  const { __resetInFlight } = await import("../lib/service.js");
  __resetInFlight();

  const sessionId = "session-keep-group";
  let detachedCalls = 0;
  let unarchiveCalls = 0;

  const services = {
    sessionController: { list: async () => ({ items: [{ sessionId, running: false, blank: false }] }) },
    agents: { get: () => undefined },
    // 内存里**仍然**有它：store 可达、entry 在，但 entry.detach 抛错 → 摘不掉。
    // （真实宿主里 `store` 是 SessionStore 的实例字段，必须显式建模；
    //   若写成 `{ list: ... }` 而不给 store，测的其实是「store 不可达」那条路。）
    sessions: {
      list: () => [{ id: sessionId }],
      store: new Map([[sessionId, { detach: () => { throw new Error("cannot detach"); } }]]),
    },
    workspaceRegistry: {
      list: () => [{ sessionIds: [sessionId], detachSession: async () => { detachedCalls += 1; } }],
      unpinSession: async () => { unarchiveCalls += 1; },
      unarchiveSession: async () => { unarchiveCalls += 1; },
    },
  };
  const ctx = { logger: { warn() {}, debug() {} }, get: (k) => services[k] };
  const audit = { record: async () => ({ ok: true, path: null }), enabled: false, path: null };
  const service = createService(
    ctx,
    resolveConfig({ audit: false, matchAlternateIdSpelling: false }),
    audit,
  );

  const result = await service.deleteSession(sessionId, { kind: "test" });
  assert.equal(result.ok, true);
  assert.equal(result.value.detached, false, "内存条目摘不掉时如实上报 detached:false");
  assert.equal(result.value.detach, "failed", "且三态明细必须是 failed（不是 absent）");
  assert.equal(result.value.keptWorkspaceMembership, true, "必须标记归属被保留");
  assert.equal(detachedCalls, 0, "会话还在内存里 → **不得**摘归属（否则会落到「未分组」）");
  assert.equal(unarchiveCalls, 0, "同理不动注册表，避免留下指向内存行的 pin/archive");
  assert.equal(result.value.workspaces, 0);
});

test("回归：会话确实已从宿主内存消失时才摘归属（正常收尾）", async () => {
  const { __resetInFlight } = await import("../lib/service.js");
  __resetInFlight();

  const sessionId = "session-gone";
  let detachedCalls = 0;

  const services = {
    // 语料里已经没有它
    sessionController: { list: async () => ({ items: [] }) },
    agents: { get: () => undefined },
    // 内存里也没有它：store 可达但里面没有这个 id → detachLiveStore 报 absent。
    sessions: { list: () => [], store: new Map() },
    workspaceRegistry: {
      list: () => [{ sessionIds: [sessionId], detachSession: async () => { detachedCalls += 1; } }],
      unpinSession: async () => {},
      unarchiveSession: async () => {},
    },
  };
  const ctx = { logger: { warn() {}, debug() {} }, get: (k) => services[k] };
  const audit = { record: async () => ({ ok: true, path: null }), enabled: false, path: null };
  const service = createService(
    ctx,
    resolveConfig({ audit: false, matchAlternateIdSpelling: false }),
    audit,
  );

  const result = await service.deleteSession(sessionId, { kind: "test" });
  assert.equal(result.ok, true);
  assert.equal(result.value.detached, false);
  assert.equal(result.value.detach, "absent", "本就不在内存里 → absent（正常收尾，不是失败）");
  assert.equal(result.value.keptWorkspaceMembership, false, "内存里没有它 → 不必保留归属");
  assert.equal(detachedCalls, 1, "确实不在内存里 → 正常摘归属收尾");
  assert.equal(result.value.workspaces, 1);
});

test("detachLiveStore：遍历候选 store 承载位置，且只认 Map 语义", () => {
  // _store 兜底位置
  let called = 0;
  const alt = new Map([["s1", { detach: () => { called += 1; alt.delete("s1"); } }]]);
  assert.equal(detachLiveStore({ _store: alt }, "s1"), "detached");
  assert.equal(called, 1);

  // 非 Map 的假 store（只有 get）不得被当成 store 用
  assert.equal(detachLiveStore({ store: { get: () => ({ detach() {} }) } }, "s1"), "failed");

  // store 存在但没有这个 id → absent（本就不在内存里，正常收尾）
  assert.equal(detachLiveStore({ store: new Map() }, "s1"), "absent");

  // 没有 detach 的裸 entry → 直接 store.delete 兜底
  const bare = new Map([["s1", {}]]);
  assert.equal(detachLiveStore({ store: bare }, "s1"), "detached");
  assert.equal(bare.has("s1"), false, "裸 entry 也必须真的从 store 里删掉");
});

/**
 * 【回归 · 2026-10-16 · 「删了却还在未分组里」的真修法】
 *
 * 前两次诊断都错了：
 *   1. 先后怀疑过「事务顺序」（1.0.2 改了顺序+条件，问题依旧）；
 *   2. 再怀疑过客户端 `projectList()` 从 `subagentCatalog` 注入（实测证伪 ——
 *      整个 projcache 目录搜 `subagentCatalog` 键 0 处命中，投影文件实际结构是
 *      `{version, record:{identity, rows}}`）。
 *
 * 最终用全盘扫描定论：三个幽灵 id 在 `~/.dsh` 里只出现在审计日志与记忆索引，
 * **sessions 目录 / projcache / storages 全部零命中** —— 持久化数据已 100% 清干净，
 * 缺的只是让客户端重新拉一次列表。
 *
 * 官方入口是已声明的 Remote Event `api-session/removed`（`mode: 'emit'`）：
 * Host 侧 `ctx.emit` 自动中继到客户端，客户端 `handleSessionRemoved` 收到后
 * `recordMutation({kind:"remove"})` —— 只有这一支才真正把行从侧栏抹掉。
 */
test("announceSessionRemoved：emit 已声明的 Remote Event api-session/removed", async () => {
  const emitted = [];
  const ctx = { emit: (name, payload) => emitted.push([name, payload]) };
  const out = await announceSessionRemoved(ctx, "s1", { debug() {} });
  assert.equal(out.announced, true, "emit 成功应如实上报");
  assert.deepEqual(emitted, [["api-session/removed", "s1"]], "事件名与载荷必须与官方声明一致");
});

test("announceSessionRemoved：拿不到 ctx / 没有 emit 时如实报 false，不抛错", async () => {
  assert.deepEqual(await announceSessionRemoved(undefined, "s1"), { announced: false, reason: "no-emit" });
  assert.deepEqual(await announceSessionRemoved(null, "s1"), { announced: false, reason: "no-emit" });
  assert.deepEqual(await announceSessionRemoved({}, "s1"), { announced: false, reason: "no-emit" });
});

/**
 * 【关键安全属性】通知失败**绝不能**让一个已经成功的删除变成失败。
 * `ctx.emit` 在没有该事件声明的运行时（或旧版本）可能抛错。
 */
test("announceSessionRemoved：emit 抛错时降级为 announced:false，不把异常抛给删除事务", async () => {
  const ctx = { emit: () => { throw new Error("event not declared"); } };
  const out = await announceSessionRemoved(ctx, "s1", { debug() {} });
  assert.equal(out.announced, false);
  assert.equal(out.reason, "emit-threw");
});

/** 删除成功后必须真的发出通知（这是用户能看到「侧栏立刻少一行」的原因）。 */
test("删除成功后必须 emit api-session/removed（否则侧栏留着旧行）", async () => {
  const { __resetInFlight } = await import("../lib/service.js");
  __resetInFlight();

  const sessionId = "session-announce";
  const emitted = [];
  const services = {
    sessionController: { list: async () => ({ items: [] }) },
    agents: { get: () => undefined },
    sessions: { list: () => [], store: new Map() },
    workspaceRegistry: {
      list: () => [{ sessionIds: [sessionId], detachSession: async () => {} }],
      unpinSession: async () => {},
      unarchiveSession: async () => {},
    },
  };
  const ctx = {
    logger: { warn() {}, debug() {} },
    get: (k) => services[k],
    emit: (name, payload) => emitted.push([name, payload]),
  };
  const audit = { record: async () => ({ ok: true, path: null }), enabled: false, path: null };
  const service = createService(
    ctx,
    resolveConfig({ audit: false, matchAlternateIdSpelling: false, removeProjectionCache: false }),
    audit,
  );

  const result = await service.deleteSession(sessionId, { kind: "test" });
  assert.equal(result.ok, true);
  assert.equal(result.value.announced, true, "删除成功后必须发出通知");
  assert.equal(result.value.announceReason, "emitted");
  assert.deepEqual(emitted, [["api-session/removed", sessionId]]);
});

/** `announceRemoval: false` 时不得发通知，且如实标出原因（便于排障）。 */
test("announceRemoval:false 时不发通知，且如实标 reason=disabled", async () => {
  const { __resetInFlight } = await import("../lib/service.js");
  __resetInFlight();

  const emitted = [];
  const services = {
    sessionController: { list: async () => ({ items: [] }) },
    agents: { get: () => undefined },
    sessions: { list: () => [], store: new Map() },
  };
  const ctx = {
    logger: { warn() {}, debug() {} },
    get: (k) => services[k],
    emit: (name, payload) => emitted.push([name, payload]),
  };
  const audit = { record: async () => ({ ok: true, path: null }), enabled: false, path: null };
  const service = createService(
    ctx,
    resolveConfig({ audit: false, matchAlternateIdSpelling: false, removeProjectionCache: false, announceRemoval: false }),
    audit,
  );

  const result = await service.deleteSession("s-off", { kind: "test" });
  assert.equal(result.ok, true);
  assert.equal(result.value.announced, false);
  assert.equal(result.value.announceReason, "disabled");
  assert.equal(emitted.length, 0, "关掉后一次都不许发");
});
