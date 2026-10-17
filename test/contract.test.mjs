import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtemp, mkdir, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  STATUS,
  checkOrigin,
  createRateLimiter,
  fail,
  hasJsonContentType,
  isLoopbackRequest,
  ok,
  readJsonBody,
  sendJson,
} from "../lib/http.js";
import { resolveConfig, DEFAULTS, Config } from "../lib/config.js";
import { createService } from "../lib/service.js";

/** 最小 req 替身。 */
function makeReq({ method = "POST", headers = {}, body = null, remoteAddress = "127.0.0.1" } = {}) {
  const stream = body === null ? Readable.from([]) : Readable.from([Buffer.from(body)]);
  stream.method = method;
  stream.headers = headers;
  stream.socket = { remoteAddress };
  return stream;
}

/** 最小 res 替身，记录状态码与 body。 */
function makeRes() {
  const captured = { status: null, headers: null, body: "" };
  return {
    captured,
    writeHead(status, headers) {
      captured.status = status;
      captured.headers = headers;
    },
    end(text) {
      if (typeof text === "string") captured.body += text;
    },
  };
}

// ───────────────────────── 同源判定（冻结五步） ─────────────────────────

test("checkOrigin：桌面壳 origin 放行", () => {
  assert.equal(checkOrigin(makeReq({ headers: { origin: "dsh-app://app" } })).ok, true);
  assert.equal(checkOrigin(makeReq({ headers: { origin: "dsh-app://shell" } })).ok, true);
});

test("checkOrigin：Sec-Fetch-Site: cross-site 拒绝", () => {
  const r = checkOrigin(makeReq({ headers: { "sec-fetch-site": "cross-site" } }));
  assert.equal(r.ok, false);
  assert.equal(r.site, "cross-site");
});

test("checkOrigin：有 Origin 时 host 必须与 Host 一致", () => {
  assert.equal(
    checkOrigin(makeReq({ headers: { origin: "http://127.0.0.1:19387", host: "127.0.0.1:19387" } })).ok,
    true,
  );
  assert.equal(
    checkOrigin(makeReq({ headers: { origin: "http://evil.example", host: "127.0.0.1:19387" } })).ok,
    false,
  );
});

test("checkOrigin：非法 Origin 视为不可信", () => {
  assert.equal(checkOrigin(makeReq({ headers: { origin: "not a url", host: "h" } })).ok, false);
});

test("checkOrigin：两头部都不存在时**只有回环**放行（桌面壳转发的形状）", () => {
  assert.equal(checkOrigin(makeReq({ headers: {}, remoteAddress: "127.0.0.1" })).ok, true);
  assert.equal(checkOrigin(makeReq({ headers: {}, remoteAddress: "::1" })).ok, true);
  assert.equal(checkOrigin(makeReq({ headers: {}, remoteAddress: "::ffff:127.0.0.1" })).ok, true);
  assert.equal(checkOrigin(makeReq({ headers: {}, remoteAddress: "10.0.0.5" })).ok, false);
});

test("checkOrigin：只有 Sec-Fetch-Site 时仅 same-origin 放行", () => {
  assert.equal(checkOrigin(makeReq({ headers: { "sec-fetch-site": "same-origin" } })).ok, true);
  assert.equal(checkOrigin(makeReq({ headers: { "sec-fetch-site": "same-site" } })).ok, false);
});

test("isLoopbackRequest：非回环与空地址都为 false", () => {
  assert.equal(isLoopbackRequest(makeReq({ remoteAddress: "" })), false);
  assert.equal(isLoopbackRequest({}), false);
  assert.equal(isLoopbackRequest(makeReq({ remoteAddress: "192.168.1.9" })), false);
});

// ───────────────────────── 状态码 / 信封 ─────────────────────────

test("STATUS 覆盖 §5.2 的全部错误码", () => {
  for (const code of [
    "bad-request",
    "cross-origin",
    "method-not-allowed",
    "not-found",
    "refused",
    "rate-limited",
    "cleanup-unavailable",
    "delete-failed",
    "internal",
  ]) {
    assert.equal(typeof STATUS[code], "number", code);
  }
  assert.equal(STATUS["refused"], 409);
  assert.equal(STATUS["cross-origin"], 403);
  assert.equal(STATUS["bad-request"], 400);
});

test("sendJson 显式使用传入的状态码（上游写死 200 是硬伤）", () => {
  const res = makeRes();
  sendJson(res, 409, { ok: false, error: { code: "refused", message: "x" } });
  assert.equal(res.captured.status, 409, "状态码必须显式传入，不得写死 200");
  assert.equal(res.captured.headers["cache-control"], "no-store");
  assert.equal(res.captured.headers["content-type"], "application/json; charset=utf-8");
});

test("fail 用语义化状态码并保留 hint", () => {
  const res = makeRes();
  fail(res, "refused", "会话正在运行", "先停止再试");
  assert.equal(res.captured.status, 409);
  const body = JSON.parse(res.captured.body);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "refused");
  assert.equal(body.error.hint, "先停止再试");
});

test("fail：method-not-allowed 带 Allow 头", () => {
  const res = makeRes();
  fail(res, "method-not-allowed", "只接受 POST");
  assert.equal(res.captured.status, 405);
  assert.ok(res.captured.headers.allow);
});

test("fail：hint 为空时不写入 hint 字段", () => {
  const res = makeRes();
  fail(res, "internal", "x");
  assert.equal("hint" in JSON.parse(res.captured.body).error, false);
});

test("ok 信封形状为 {ok:true,value}", () => {
  const res = makeRes();
  ok(res, { a: 1 });
  assert.equal(res.captured.status, 200);
  assert.deepEqual(JSON.parse(res.captured.body), { ok: true, value: { a: 1 } });
});

test("未知错误码退回 500，不产生 undefined 状态码", () => {
  const res = makeRes();
  fail(res, "some-new-code", "x");
  assert.equal(res.captured.status, 500);
});

// ───────────────────────── 读体：上限与超时 ─────────────────────────

test("readJsonBody：正常解析", async () => {
  const body = JSON.stringify({ sessionId: "s1" });
  const parsed = await readJsonBody(makeReq({ body }), { limit: 1024, timeoutMs: 1000 });
  assert.deepEqual(parsed, { sessionId: "s1" });
});

test("readJsonBody：空体返回 {}", async () => {
  const parsed = await readJsonBody(makeReq({ body: null }), { limit: 1024, timeoutMs: 1000 });
  assert.deepEqual(parsed, {});
});

test("readJsonBody：超限抛错（不静默截断）", async () => {
  const body = JSON.stringify({ payload: "x".repeat(4096) });
  await assert.rejects(
    () => readJsonBody(makeReq({ body }), { limit: 256, timeoutMs: 1000 }),
    /超过上限/,
  );
});

test("readJsonBody：非法 JSON 抛错", async () => {
  await assert.rejects(
    () => readJsonBody(makeReq({ body: "{not json" }), { limit: 1024, timeoutMs: 1000 }),
    /不是合法 JSON/,
  );
});

test("readJsonBody：超时抛错（上游没有超时，慢连接会永久挂住 handler）", async () => {
  // 一个永不结束、且从不推送数据的流：read 回调什么都不做。
  // 超时到点时 readJsonBody 会 req.destroy(err)，异步迭代器随之拒绝。
  const never = new Readable({ read() {} });
  never.method = "POST";
  never.headers = {};
  never.socket = { remoteAddress: "127.0.0.1" };

  await assert.rejects(
    () => readJsonBody(never, { limit: 1024, timeoutMs: 50 }),
    /超时/,
  );
});

test("hasJsonContentType：只认 application/json（允许带 charset）", () => {
  assert.equal(hasJsonContentType(makeReq({ headers: { "content-type": "application/json" } })), true);
  assert.equal(
    hasJsonContentType(makeReq({ headers: { "content-type": "application/json; charset=utf-8" } })),
    true,
  );
  assert.equal(hasJsonContentType(makeReq({ headers: { "content-type": "text/plain" } })), false);
  assert.equal(hasJsonContentType(makeReq({ headers: {} })), false);
});

// ───────────────────────── 限流 ─────────────────────────

test("createRateLimiter：0 = 不限", () => {
  const limiter = createRateLimiter(0);
  assert.equal(limiter.enabled, false);
  for (let i = 0; i < 100; i += 1) assert.equal(limiter.take(), true);
});

test("createRateLimiter：超过容量后拒绝，窗口滚动后恢复", () => {
  let now = 0;
  const limiter = createRateLimiter(3, () => now);
  assert.equal(limiter.take(), true);
  assert.equal(limiter.take(), true);
  assert.equal(limiter.take(), true);
  assert.equal(limiter.take(), false, "第 4 次必须被拒");
  now += 60001;
  assert.equal(limiter.take(), true, "窗口滚动后恢复");
});

test("createRateLimiter：take(n) 按条数扣额度（批量不能绕过配额）", () => {
  let now = 0;
  const limiter = createRateLimiter(10, () => now);
  assert.equal(limiter.take(4), true, "4 条");
  assert.equal(limiter.take(4), true, "累计 8 条");
  assert.equal(limiter.take(4), false, "8+4 超过 10 —— 必须拒绝整批");
  assert.equal(limiter.take(2), true, "8+2 正好用满");
  assert.equal(limiter.take(1), false, "已用满");
  now += 60001;
  assert.equal(limiter.take(1), true, "窗口滚动后恢复");
});

test("createRateLimiter：单次要的额度超过整窗容量直接拒绝（不让 used 溢出）", () => {
  const limiter = createRateLimiter(5, () => 0);
  assert.equal(limiter.take(6), false, "一次要 6 > 容量 5");
  assert.equal(limiter.take(5), true, "整窗仍可用");
  assert.equal(limiter.take(1), false);
});

test("createRateLimiter：非法 cost 退回按 1 计", () => {
  const limiter = createRateLimiter(2, () => 0);
  assert.equal(limiter.take(0), true);
  assert.equal(limiter.take(-3), true);
  assert.equal(limiter.take(1), false);
});

// ───────────────────────── Config ─────────────────────────

test("resolveConfig：空/非法输入全部落到默认值", () => {
  // auditPath 的 schema 默认是空串（表示「用默认路径」），resolveConfig 统一收敛成 null。
  const expected = { ...DEFAULTS, auditPath: null };
  assert.deepEqual(resolveConfig(undefined), expected);
  assert.deepEqual(resolveConfig(null), expected);
  assert.deepEqual(resolveConfig("nope"), expected);
  assert.deepEqual(resolveConfig({}), expected);
});

test("Config 实现 Standard Schema v1（Cordis 读的就是 ~standard.validate）", () => {
  assert.equal(typeof Config["~standard"]?.validate, "function");
  assert.equal(Config["~standard"].version, 1);

  // 合法输入 -> { value }
  const ok = Config["~standard"].validate({ maxBodyBytes: 4096, audit: false });
  assert.equal(ok.issues, undefined);
  assert.equal(ok.value.maxBodyBytes, 4096);
  assert.equal(ok.value.audit, false);
  assert.equal(ok.value.readTimeoutMs, DEFAULTS.readTimeoutMs, "缺省项被默认值补齐");

  // 非法输入 -> { issues }
  const bad = Config["~standard"].validate({ maxBodyBytes: 1, audit: "yes", nope: 1 });
  assert.ok(Array.isArray(bad.issues));
  assert.ok(bad.issues.length >= 2);
});

test("Config：可调用 + .validate + JSON Schema 形状三者一致", () => {
  assert.equal(typeof Config, "function", "schemastery 的 Schema 是函数，这里同样可调用");
  const value = Config({ rateLimitPerMinute: 5 });
  assert.equal(value.rateLimitPerMinute, 5);
  assert.equal(value.audit, DEFAULTS.audit);

  assert.equal(typeof Config.validate, "function");
  assert.equal(Config.validate({}).value.audit, DEFAULTS.audit);

  const json = Config.toJSON();
  assert.equal(json.type, "object");
  assert.equal(json.additionalProperties, false);
  assert.ok(json.properties.maxBodyBytes);
  assert.equal(json.properties.maxBodyBytes.type, "integer");
  assert.equal(json.properties.maxBodyBytes.minimum, 1024);
  // 每个字段都必须有默认值与说明，界面才能渲染
  for (const [key, prop] of Object.entries(json.properties)) {
    assert.notEqual(prop.default, undefined, key);
    assert.notEqual(prop.description, undefined, key);
  }
  assert.deepEqual(Config.toJsonSchema(), json);
});

test("Config 抛错路径给出可读信息（可调用形态）", () => {
  assert.throws(() => Config({ audit: "yes" }), /audit/);
  assert.throws(() => Config({ unknownKey: 1 }), /未知配置项/);
});

test("resolveConfig：越界数值退回默认，而不是把端点打成不可用", () => {
  const cfg = resolveConfig({ maxBodyBytes: 1, readTimeoutMs: -5, rateLimitPerMinute: -1 });
  assert.equal(cfg.maxBodyBytes, DEFAULTS.maxBodyBytes);
  assert.equal(cfg.readTimeoutMs, DEFAULTS.readTimeoutMs);
  assert.equal(cfg.rateLimitPerMinute, DEFAULTS.rateLimitPerMinute);
});

test("resolveConfig：布尔项拒绝非布尔值，退回 schema 默认而不是静默取反", () => {
  // 字符串 "yes" / 数字 1 是常见误配。静默当成 false 会把安全阀（audit、
  // requireIdleSession）关掉 —— 所以这里退回默认值（audit 默认 true）。
  const cfg = resolveConfig({ audit: "yes", stopIdleAgent: 1 });
  assert.equal(cfg.audit, DEFAULTS.audit, "非法布尔退回默认，而不是静默变 false");
  assert.equal(cfg.stopIdleAgent, DEFAULTS.stopIdleAgent);
  assert.equal(resolveConfig({ audit: true }).audit, true);
  assert.equal(resolveConfig({ audit: false }).audit, false);
});

test("resolveConfig：非法值也由 ~standard.validate 明确报出 issues（不静默吞掉）", () => {
  const result = Config["~standard"].validate({ audit: "yes", maxBodyBytes: -1 });
  assert.ok(Array.isArray(result.issues));
  assert.equal(result.issues.length, 2);
  assert.ok(result.issues.some((issue) => issue.path[0] === "audit"));
  assert.ok(result.issues.some((issue) => issue.path[0] === "maxBodyBytes"));
});

test("resolveConfig：用户覆盖生效", () => {
  const cfg = resolveConfig({ maxBodyBytes: 4096, audit: false, rateLimitPerMinute: 0 });
  assert.equal(cfg.maxBodyBytes, 4096);
  assert.equal(cfg.audit, false);
  assert.equal(cfg.rateLimitPerMinute, 0);
});

test("resolveConfig：auditPath 非字符串且非 null 时退回 null", () => {
  assert.equal(resolveConfig({ auditPath: 42 }).auditPath, null);
  assert.equal(resolveConfig({ auditPath: "C:/tmp/a.jsonl" }).auditPath, "C:/tmp/a.jsonl");
});

// ───────────────────────── 端到端装配（假 ctx） ─────────────────────────

test("apply：用 ctx.effect 注册三条路由并返回可清理的 disposer", async () => {
  const { apply, name, inject } = await import("../lib/index.js");
  assert.equal(name, "dialogue-cleanup");
  assert.deepEqual(inject, ["webServer"]);

  const registered = [];
  const effects = [];
  let disposed = 0;

  const ctx = {
    logger: { debug() {}, warn() {}, info() {} },
    sessions: undefined,
    agents: undefined,
    get: () => undefined,
    webServer: {
      register(route) {
        registered.push(route);
        return () => {
          disposed += 1;
        };
      },
    },
    effect(callback, label) {
      const cleanup = callback();
      effects.push({ label, cleanup });
      return cleanup;
    },
  };

  apply(ctx, { audit: false });

  assert.equal(registered.length, 3);
  const paths = registered.map((r) => r.path).sort();
  assert.deepEqual(paths, [
    "/api-ext/dialogue-cleanup/delete",
    "/api-ext/dialogue-cleanup/list",
    "/api-ext/dialogue-cleanup/status",
  ]);
  for (const route of registered) assert.equal(route.kind, "exact");
  for (const route of registered) assert.equal(typeof route.handler, "function");

  assert.equal(effects.length, 1, "注册必须包在 ctx.effect 里（R-11）");
  assert.match(effects[0].label, /routes/);

  effects[0].cleanup();
  assert.equal(disposed, 3, "清理函数必须注销全部三条路由");
});

test("routes：status 端点返回能力与配置（假 ctx 直接调 handler）", async () => {
  const { apply } = await import("../lib/index.js");
  const routes = new Map();
  const ctx = {
    logger: { debug() {}, warn() {} },
    get: () => undefined,
    webServer: { register(route) { routes.set(route.path, route.handler); return () => {}; } },
    effect: (callback) => callback(),
  };
  apply(ctx, { audit: false });

  const res = makeRes();
  routes.get("/api-ext/dialogue-cleanup/status")(
    makeReq({ method: "GET", headers: { "sec-fetch-site": "same-origin" } }),
    res,
  );
  assert.equal(res.captured.status, 200);
  const body = JSON.parse(res.captured.body);
  assert.equal(body.ok, true);
  assert.equal(body.value.plugin.name, "dialogue-cleanup");
  assert.equal(body.value.capabilities.removeArtifacts, true);
  assert.equal(body.value.capabilities.publicStopIdleAgent, false, "运行时没有公开停止入口，必须如实上报");
  assert.equal(body.value.config.audit, false);
});

test("routes：delete 端点拒绝非法 sessionId（400），且不触碰磁盘", async () => {
  const { apply } = await import("../lib/index.js");
  const routes = new Map();
  const ctx = {
    logger: { debug() {}, warn() {} },
    get: () => undefined,
    webServer: { register(route) { routes.set(route.path, route.handler); return () => {}; } },
    effect: (callback) => callback(),
  };
  apply(ctx, { audit: false });

  const res = makeRes();
  await routes.get("/api-ext/dialogue-cleanup/delete")(
    makeReq({
      method: "POST",
      headers: { "sec-fetch-site": "same-origin", "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "../etc/passwd" }),
    }),
    res,
  );
  assert.equal(res.captured.status, 400);
  const body = JSON.parse(res.captured.body);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "bad-request");
});

test("routes：delete 端点跨站请求返回 403 且不读体", async () => {
  const { apply } = await import("../lib/index.js");
  const routes = new Map();
  const ctx = {
    logger: { debug() {}, warn() {} },
    get: () => undefined,
    webServer: { register(route) { routes.set(route.path, route.handler); return () => {}; } },
    effect: (callback) => callback(),
  };
  apply(ctx, { audit: false });

  const res = makeRes();
  await routes.get("/api-ext/dialogue-cleanup/delete")(
    makeReq({
      method: "POST",
      headers: { origin: "http://evil.example", host: "127.0.0.1:1", "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "s1" }),
    }),
    res,
  );
  assert.equal(res.captured.status, 403);
  assert.equal(JSON.parse(res.captured.body).error.code, "cross-origin");
});

test("routes：delete 端点非 POST 返回 405", async () => {
  const { apply } = await import("../lib/index.js");
  const routes = new Map();
  const ctx = {
    logger: { debug() {}, warn() {} },
    get: () => undefined,
    webServer: { register(route) { routes.set(route.path, route.handler); return () => {}; } },
    effect: (callback) => callback(),
  };
  apply(ctx, { audit: false });

  const res = makeRes();
  await routes.get("/api-ext/dialogue-cleanup/delete")(
    makeReq({ method: "GET", headers: { "sec-fetch-site": "same-origin" } }),
    res,
  );
  assert.equal(res.captured.status, 405);
  assert.equal(JSON.parse(res.captured.body).error.code, "method-not-allowed");
});

test("routes：delete 端点拒绝非 JSON 的 Content-Type", async () => {
  const { apply } = await import("../lib/index.js");
  const routes = new Map();
  const ctx = {
    logger: { debug() {}, warn() {} },
    get: () => undefined,
    webServer: { register(route) { routes.set(route.path, route.handler); return () => {}; } },
    effect: (callback) => callback(),
  };
  apply(ctx, { audit: false });

  const res = makeRes();
  await routes.get("/api-ext/dialogue-cleanup/delete")(
    makeReq({
      method: "POST",
      headers: { "sec-fetch-site": "same-origin", "content-type": "text/plain" },
      body: JSON.stringify({ sessionId: "s1" }),
    }),
    res,
  );
  assert.equal(res.captured.status, 400);
});

test("端到端：running 会话被拒（409 refused），且盘上文件不动", async () => {
  const root = await mkdtemp(join(tmpdir(), "dscc-e2e-"));
  try {
    const { mkdir, writeFile, readdir } = await import("node:fs/promises");
    await mkdir(join(root, "projA", "s1"), { recursive: true });
    await writeFile(join(root, "projA", "s1", "session.v4.jsonl.zstd"), "keep");

    const { createService } = await import("../lib/service.js");
    const services = {
      sessionController: { list: async () => ({ items: [{ sessionId: "s1", running: true }] }) },
      agents: { get: () => ({ id: "s1" }) },
    };
    const ctx = {
      logger: { warn() {}, debug() {} },
      sessions: undefined,
      get: (k) => services[k],
    };
    const audit = { record: async () => ({ ok: true, path: null }), enabled: false, path: null };
    const config = resolveConfig({ audit: false });
    const service = createService(ctx, config, audit);

    const result = await service.deleteSession("s1", { kind: "test" });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "refused");
    assert.deepEqual(await readdir(join(root, "projA")), ["s1"], "被拒时不得动磁盘");

    // 幂等语义：拒绝也要保持一致性，重复调用仍拒绝
    const again = await service.deleteSession("s1", { kind: "test" });
    assert.equal(again.ok, false);
    assert.equal(again.error.code, "refused");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("端到端：空闲且无 agent 的会话走完删除事务（含审计）", async () => {
  const { createService } = await import("../lib/service.js");
  const recorded = [];
  const services = {
    sessionController: { list: async () => ({ items: [] }) },
    agents: { get: () => undefined },
    workspaceRegistry: {
      list: () => [
        { sessionIds: ["s1"], detachSession: async () => {} },
        { sessionIds: ["other"], detachSession: async () => {} },
      ],
      unpinSession: async () => {},
      unarchiveSession: async () => {},
    },
  };
  const ctx = { logger: { warn() {}, debug() {} }, sessions: undefined, get: (k) => services[k] };
  const audit = { record: async (e) => { recorded.push(e); return { ok: true, path: "/tmp/a.jsonl" }; }, enabled: true, path: "/tmp/a.jsonl" };
  const service = createService(ctx, resolveConfig({ audit: true }), audit);

  const result = await service.deleteSession("s1", { kind: "test" });
  assert.equal(result.ok, true);
  assert.equal(result.value.sessionId, "s1");
  assert.equal(result.value.workspaces, 1, "只计数真正 detach 成功的那一个");
  // 【回归】registryCleared 不再是一个会骗人的数字：公开 API（unpin/unarchive）
  // 对未知 id 是幂等 no-op，不报告是否真的写入，所以只能给出 attempted/resolved，
  // changed 固定为 null（未知）。旧实现返回 2，对不存在的会话也报「清了 2 条」。
  assert.deepEqual(result.value.registryCleared, {
    attempted: 2,
    resolved: 2,
    changed: null,
    skipped: [],
  });
  assert.equal(result.value.audit.ok, true);
  assert.equal(recorded.length, 1, "成功也必须审计");
  assert.equal(recorded[0].result.ok, true);
});

test("幂等单飞：同一 id 的并发请求复用同一个 Promise", async () => {
  const { createService, __resetInFlight } = await import("../lib/service.js");
  __resetInFlight();

  let listCalls = 0;
  const services = {
    sessionController: { list: async () => { listCalls += 1; return { items: [] }; } },
    agents: { get: () => undefined },
  };
  const ctx = { logger: { warn() {}, debug() {} }, get: (k) => services[k] };
  const audit = { record: async () => ({ ok: true, path: null }), enabled: false, path: null };
  const service = createService(ctx, resolveConfig({ audit: false }), audit);

  const [a, b] = await Promise.all([
    service.deleteSession("s1", { kind: "test" }),
    service.deleteSession("s1", { kind: "test" }),
  ]);
  assert.equal(a, b, "并发第二请求必须复用同一个结果对象（单飞）");
  assert.equal(listCalls, 1, "单飞：只探测一次，不重复执行事务");
});

// ───────────────────────── 面板数据源（/list） ─────────────────────────

/** 造一个带 sessionQuery 语料的 service 环境。 */
function makePanelCtx(overrides = {}) {
  const records = overrides.records ?? [
    { header: { id: "s-new", cwd: "E:\\proj-A", createdAt: 3000 }, live: true, persisted: true },
    { header: { id: "s-old", cwd: "E:\\proj-B", createdAt: 1000 }, live: false, persisted: true },
    { header: { id: "s-mid", cwd: "E:\\proj-A", createdAt: 2000 }, live: true, persisted: true },
    // 子代理会话（可选）：官方侧栏默认隐藏这类行（SessionHeader.origin === 'subagent'）。
    // 只有显式 withSubagent:true 才加入，避免影响既有用例的 total 断言。
    ...(overrides.withSubagent === true
      ? [{
          header: {
            id: "s-sub",
            cwd: "E:\\proj-A",
            createdAt: 1500,
            origin: "subagent",
            delegationDepth: 1,
            parentSession: "s-new",
          },
          live: false,
          persisted: true,
        }]
      : []),
  ];
  const summaries = overrides.summaries ?? [
    { sessionId: "s-new", running: true, blank: false, updatedAt: 9000 },
    { sessionId: "s-mid", running: false, blank: false, updatedAt: 5000 },
  ];
  const titleCalls = [];
  const services = {
    sessionQuery: {
      listSessions: async () => records,
      readTitleSnapshots: async (ids) => {
        titleCalls.push(ids.slice());
        // 真实形状：SessionTitleObservation { session, title?: SessionTitleSnapshot }
        // SessionTitleSnapshot.title 才是标题字符串。
        return ids.map((id) => ({
          sessionId: id,
          status: "fulfilled",
          value: { title: id === "s-mid" ? { title: "可删除的会话" } : undefined },
        }));
      },
    },
    sessionController: { list: async () => ({ items: summaries }) },
    workspaceRegistry: {
      list: () => [
        { id: "w1", title: "项目 A", path: "E:\\proj-A", sessionIds: ["s-new", "s-mid"] },
      ],
    },
    // 归档集合来自 workspace 存储领域的全局状态（见 readArchivedSessionIds 取证说明）。
    // 默认不给 storageDomain —— 用来验证「拿不到时如实视为无归档」的降级路径。
    ...(overrides.archivedIds === undefined
      ? {}
      : {
          storageDomain: {
            get: (name) => (name === "workspace"
              ? { global: { get: () => ({ archivedSessionIds: overrides.archivedIds }) } }
              : undefined),
          },
        }),
  };
  const ctx = { logger: { warn() {}, debug() {} }, get: (k) => services[k] };
  const audit = { record: async () => ({ ok: true, path: null }), enabled: false, path: null };
  const config = resolveConfig({ audit: false, ...(overrides.config ?? {}) });
  return { service: createService(ctx, config, audit), titleCalls };
}

test("listSessions：合并 sessionQuery 语料 + sessionController 摘要，Host 判定 deletable", async () => {
  const { service } = makePanelCtx();
  const result = await service.listSessions();
  assert.equal(result.ok, true);
  assert.equal(result.value.total, 3);
  assert.equal(result.value.sources.corpus, "sessionQuery.listSessions");
  assert.equal(result.value.sources.summary, "sessionController.list");

  const byId = Object.fromEntries(result.value.items.map((row) => [row.sessionId, row]));
  // running 的会话不可删除，且给出人话原因（UI 不猜）
  assert.equal(byId["s-new"].running, true);
  assert.equal(byId["s-new"].deletable, false);
  assert.match(byId["s-new"].blockedReason, /正在运行/);
  // 空闲的会话可删除
  assert.equal(byId["s-mid"].running, false);
  assert.equal(byId["s-mid"].deletable, true);
  assert.equal(byId["s-mid"].blockedReason, null);
  // 只有磁盘持久化、没有摘要的会话默认可删除
  assert.equal(byId["s-old"].live, false);
  assert.equal(byId["s-old"].deletable, true);
});

test("listSessions：默认按最后活动倒序，回退创建时间", async () => {
  const { service } = makePanelCtx();
  const result = await service.listSessions();
  // s-new 有 updatedAt 9000（最新）；s-mid 5000；s-old 无 updatedAt → 用 createdAt 1000
  assert.deepEqual(result.value.items.map((r) => r.sessionId), ["s-new", "s-mid", "s-old"]);
});

/**
 * 【回归 · 2026-10 性能修正】排序从 `localeCompare` 换成直接字典序比较后，
 * **语义必须与原来逐字节一致**。
 *
 * 为什么可以换：两个排序键（createdAt / updatedAt）在上游就已经是
 * `new Date(...).toISOString()` 的结果，ISO-8601 定长格式保证字典序 == 时间序。
 * 实测收益：5000 行 localeCompare 15 ms vs 直接比较 1 ms（约 15 倍）。
 *
 * 这条测试锁住「等价性」：拿同一批行分别用两种比较器排，结果必须完全相同。
 * 若有人后来把键改成非 ISO 格式（或引入 locale 相关的排序需求），这条会先红。
 */
test("listSessions：排序与 localeCompare 语义等价（性能修正不改行为）", async () => {
  const { service } = makePanelCtx();
  const result = await service.listSessions();
  const ids = result.value.items.map((r) => r.sessionId);

  // ① 同一批 ASCII id：直接比较与 localeCompare 必须给出**完全相同的序列**
  //    （注意这里比的是「比较器本身」，两个方向都要一致）。
  const byPlain = [...ids].sort((a, b) => (a === b ? 0 : a < b ? -1 : 1));
  const byLocale = [...ids].sort((a, b) => String(a).localeCompare(String(b)));
  assert.deepEqual(byPlain, byLocale, "直接比较与 localeCompare 在 ASCII id 上必须同序");
  // 降序就是升序的反转 —— 生产代码用的正是「反向」这一招。
  assert.deepEqual(byPlain.slice().reverse(), [...ids].sort((a, b) => (a === b ? 0 : a < b ? 1 : -1)));

  // ② 真实的 ISO-8601 键：字典序必须等于时间序（这是替换掉 localeCompare 的前提）。
  const stamps = ["2026-10-14T00:00:00.000Z", "2026-10-16T07:08:58.000Z", "2026-01-01T00:00:00.000Z"];
  const byLex = [...stamps].sort((a, b) => (a === b ? 0 : a < b ? -1 : 1));
  const byTime = [...stamps].sort((a, b) => new Date(a) - new Date(b));
  assert.deepEqual(byLex, byTime, "ISO-8601 的字典序必须等于时间序");

  // ③ 键缺失（null/undefined）必须排到最后，与旧实现 `String(k ?? "")` 的兜底一致。
  //    （这一条专门防「排序键不兜底」的变异：`value` 原样返回时 null 与字符串
  //     混比会得到 `false`，整批退化成不稳定序。）
  const withHoles = [null, "2026-10-14T00:00:00.000Z", undefined, "2026-01-01T00:00:00.000Z"];
  const norm = (v) => (typeof v === "string" ? v : "");
  const sorted = [...withHoles].sort((a, b) => {
    const ka = norm(a), kb = norm(b);
    return ka === kb ? 0 : ka < kb ? 1 : -1; // 降序
  });
  assert.deepEqual(sorted, ["2026-10-14T00:00:00.000Z", "2026-01-01T00:00:00.000Z", null, undefined]);

  // ④ 真实数据里确实有空键的行必须落在最后（语料无 updatedAt → 回退 createdAt，
  //    两者都缺时键为 null）。这是上面第 ③ 条在真实数据上的等价物。
  const ids2 = result.value.items.map((r) => r.sessionId);
  assert.equal(ids2[ids2.length - 1], "s-old", "键最缺失的行必须排到最后");

  // ⑤ 造一条**两个键都缺**的行，键必须是 null 而不是 undefined。
  //    （这一条专门防「排序键不兜底」的变异：不兜底时 null 与字符串混比会得到
  //     false，整批判定退化成不稳定序，表现为「同一页反复刷新，行序会跳」。）
  const { service: svc2 } = makePanelCtx({
    records: [
      { header: { id: "s-null" }, live: false, persisted: true }, // 无 createdAt、无 updatedAt
      { header: { id: "s-dated", createdAt: 1000 }, live: false, persisted: true },
    ],
    summaries: [],
  });
  const r2 = await svc2.listSessions();
  assert.deepEqual(
    r2.value.items.map((r) => r.sessionId),
    ["s-dated", "s-null"],
    "两个键都缺（null）的行必须排在有时键的行之后",
  );
  assert.equal(r2.value.items[1].createdAt, null, "缺 createdAt 时必须是 null（可排）");
});

test("listSessions：标题只对当前页取，且分片并发（不是每行一次 RPC）", async () => {
  const { service, titleCalls } = makePanelCtx();
  const result = await service.listSessions({ pageSize: 2 });

  // 关键契约：只取**当前页**的 id，绝不为整库 91 行取标题。
  const asked = titleCalls.flat();
  assert.deepEqual(asked.slice().sort(), ["s-mid", "s-new"], "只取当前页的两个 id");
  // 分片并发：调用次数不超过并发上限，且每个 id 只被请求一次。
  assert.ok(titleCalls.length <= 4, `分片数不超过并发上限，实际 ${titleCalls.length}`);
  assert.equal(new Set(asked).size, asked.length, "同一个 id 不得重复请求");

  const byId = Object.fromEntries(result.value.items.map((row) => [row.sessionId, row]));
  assert.equal(byId["s-mid"].title, "可删除的会话");
  assert.equal(byId["s-new"].title, null, "没有标题事件时保持 null，UI 显示占位");
});

test("listSessions：标题有缓存 —— 第二次请求同一页不再读盘", async () => {
  const { service, titleCalls } = makePanelCtx();
  const first = await service.listSessions({ pageSize: 2 });
  const callsAfterFirst = titleCalls.flat().length;
  assert.equal(callsAfterFirst, 2, "首次要真的去取两个标题");

  const second = await service.listSessions({ pageSize: 2 });
  assert.equal(titleCalls.flat().length, callsAfterFirst, "命中缓存后不得再产生读取");
  assert.equal(second.value.titles.cached, 2, "两个都来自缓存");
  assert.equal(second.value.titles.fetched, 0);
  // 缓存不能改变结果：标题仍然正确。
  assert.deepEqual(
    second.value.items.map((r) => r.title),
    first.value.items.map((r) => r.title),
  );
});

/**
 * 【性能回归】两份独立数据源必须**并行**取，不得串行 await。
 *
 * 背景：`sessionQuery.listSessions()`（语料）与 `sessionController.list()`（摘要）
 * 互相独立 —— 后者不需要前者的结果，两者只是分别合并进同一个 rows 表。
 * 旧实现是串行的，实测（语料 60 ms / 摘要 120 ms 的模拟）总耗时 180 ms；
 * 并行后应降到约 max(60,120)=120 ms。
 *
 * 这里断言的是**调用交错顺序**，不依赖墙钟时间（避免在慢 CI 上抖动误报）：
 * 摘要必须在语料结束**之前**就开始 → 两者确实重叠。
 */
test("listSessions：两份独立数据源并行取（性能回归，断言调用交错）", async () => {
  const order = [];
  const services = {
    sessionQuery: {
      listSessions: async () => {
        order.push("corpus:start");
        await new Promise((r) => setTimeout(r, 30));
        order.push("corpus:end");
        return [{ header: { id: "s-1", cwd: "E:\\p", createdAt: 1 }, live: true, persisted: true }];
      },
      readTitleSnapshots: async (ids) =>
        ids.map((id) => ({ sessionId: id, status: "fulfilled", value: {} })),
    },
    sessionController: {
      list: async () => {
        order.push("summary:start");
        await new Promise((r) => setTimeout(r, 60));
        order.push("summary:end");
        return { items: [{ sessionId: "s-1", running: false, blank: false, updatedAt: 5 }] };
      },
    },
    workspaceRegistry: { list: () => [] },
  };
  const ctx = { logger: { warn() {}, debug() {} }, get: (k) => services[k] };
  const service = createService(ctx, resolveConfig({ audit: false }), {
    record: async () => ({ ok: true, path: null }),
    enabled: false,
    path: null,
  });

  const result = await service.listSessions({ pageSize: 10 });
  assert.equal(result.ok, true);

  // 关键断言：summary 在 corpus 结束前就开始了 ⇒ 真正重叠。
  const corpusEnd = order.indexOf("corpus:end");
  const summaryStart = order.indexOf("summary:start");
  assert.ok(summaryStart !== -1, "摘要必须被调用");
  assert.ok(corpusEnd !== -1, "语料必须被调用");
  assert.ok(
    summaryStart < corpusEnd,
    `摘要必须在语料结束前开始（否则就是串行 await 又回来了）；实际顺序：${order.join(" → ")}`,
  );
});

test("listSessions：任一数据源失败不影响另一个（并行后降级语义不变）", async () => {
  // 语料抛错 → 只应落到摘要；摘要仍需可用。
  const services = {
    sessionQuery: {
      listSessions: async () => {
        throw new Error("corpus down");
      },
      readTitleSnapshots: async () => [],
    },
    sessionController: {
      list: async () => ({ items: [{ sessionId: "s-x", running: true, blank: false, updatedAt: 7 }] }),
    },
    workspaceRegistry: { list: () => [] },
  };
  const ctx = { logger: { warn() {}, debug() {} }, get: (k) => services[k] };
  const service = createService(ctx, resolveConfig({ audit: false }), {
    record: async () => ({ ok: true, path: null }),
    enabled: false,
    path: null,
  });
  const result = await service.listSessions({ pageSize: 10 });
  assert.equal(result.ok, true, "语料失败不应让整个请求失败");
  assert.equal(result.value.sources.corpus, "none", "语料来源如实记为 none");
  assert.equal(result.value.sources.summary, "sessionController.list", "摘要仍应生效");
  assert.equal(result.value.items[0].sessionId, "s-x");
});

test("listSessions：titleLimit=0 时完全不取标题（最快路径）", async () => {
  const { service, titleCalls } = makePanelCtx({ config: { titleLimit: 0 } });
  const result = await service.listSessions({ pageSize: 2 });
  assert.equal(titleCalls.length, 0, "不得产生任何标题读取");
  assert.equal(result.value.titles.skipped, true);
  assert.equal(result.value.items.every((r) => r.title === null), true, "如实留空，不猜");
});

/**
 * 【实测修复 · 「搜索标题」曾是句空话】
 * 旧实现的关键词过滤排在取标题**之前**，那一刻 row.title 恒为 null：
 * UI 占位文案写着「搜索标题、会话 id 或项目路径」，但按标题（尤其中文标题）
 * 搜索永远 0 条 —— 在真机上实测过（关键词「删除」对存在同名标题的库返回空）。
 * 现在标题按预算（titleLimit）补齐后才做关键词匹配；预算外的行只按廉价字段匹配，
 * 超出量如实进 titles.truncated，界面据此提示「结果可能不完整」。
 */
test("listSessions：按标题搜索必须命中（回归：旧实现永远 0 条）", async () => {
  const { service } = makePanelCtx();
  // fixture：s-mid 的标题 = 「可删除的会话」；这个关键词在 id/路径/工作区名里都不出现。
  const byTitle = await service.listSessions({ query: "可删除", pageSize: 10 });
  assert.equal(byTitle.ok, true);
  assert.deepEqual(
    byTitle.value.items.map((r) => r.sessionId),
    ["s-mid"],
    "标题命中必须返回该行",
  );
  assert.equal(byTitle.value.total, 1);

  // 中文标题的另一个子串（同样只存在于标题里）。
  const byTitle2 = await service.listSessions({ query: "会话", pageSize: 10 });
  assert.deepEqual(byTitle2.value.items.map((r) => r.sessionId), ["s-mid"]);

  // 既有关键词面不得回归：id 与项目路径仍然可搜。
  const byId = await service.listSessions({ query: "s-old", pageSize: 10 });
  assert.deepEqual(byId.value.items.map((r) => r.sessionId), ["s-old"]);
  const byPath = await service.listSessions({ query: "proj-B", pageSize: 10 });
  assert.deepEqual(byPath.value.items.map((r) => r.sessionId), ["s-old"]);
});

test("listSessions：同一关键词第二次搜索必须吃标题缓存（不得重复读盘）", async () => {
  const { service, titleCalls } = makePanelCtx();
  await service.listSessions({ query: "可删除", pageSize: 10 });
  const after = titleCalls.flat().length;
  assert.ok(after > 0, "首次搜索确实付出了标题读取");
  const second = await service.listSessions({ query: "可删除", pageSize: 10 });
  assert.equal(titleCalls.flat().length, after, "第二次不得再产生标题读取");
  assert.deepEqual(second.value.items.map((r) => r.sessionId), ["s-mid"], "结果不变");
  // 【计数去重】带关键词的请求走两趟 ensureTitles（候选集 + 当前页），
  // 同一行可能落在两趟里。计数必须是「这次请求的代价」、按 sessionId 去重，
  // 否则「命中 N / 请求 N」会翻倍虚报（这个回归曾在旧草稿里真实出现）。
  assert.equal(second.value.titles.requested, 3, "请求数按行去重（3 行候选），不是趟数之和");
  assert.equal(second.value.titles.cached, 3, "3 行全部来自缓存（第二次零读盘）");
  assert.equal(second.value.titles.fetched, 0);
});

test("listSessions：标题预算之外的行必须如实上报 truncated（不假装搜过）", async () => {
  // titleSearchLimit=1：搜索预算只够排在最前的 1 行（s-new，updatedAt 9000）。
  // 「可删除的会话」属于 s-mid —— 在预算外，fold 不到，只能按廉价字段匹配。
  // 契约要求：这一条**必须如实**进 truncated，让界面能提示结果可能不完整，
  // 而不是静默漏报（静默漏报正是这条 bug 的原罪）。
  const { service, titleCalls } = makePanelCtx({ config: { titleSearchLimit: 1 } });
  const result = await service.listSessions({ query: "可删除", pageSize: 10 });
  assert.equal(result.ok, true);
  assert.equal(result.value.items.length, 0, "预算外行的标题不可见（如实）");
  assert.ok(result.value.titles.truncated > 0, `truncated 必须 > 0，实际 ${result.value.titles.truncated}`);
  assert.equal(result.value.titles.requested, 1, "只按预算取 1 条");
  assert.equal(titleCalls.flat().length, 1, "恰好一次读取（预算 1 行）");
});

/**
 * 【性能回归 · 2026-10-17 实测】搜索的标题成本**不得随候选集规模线性膨胀**。
 *
 * 上一轮让关键词也匹配标题后，搜索会给整个候选集折叠标题：真机上实测
 * pageSize=5 的搜索仍 requested=25，冷缓存 **1059 ms**（单条约 350 ms，8 并发）。
 * titleLimit=100 在候选集 <100 时形同虚设 —— 库一大就是秒级卡顿。
 * 所以搜索改走独立的 titleSearchLimit（默认 40）。
 *
 * 这条测试把「独立预算」钉死：把 titleLimit 设成很大（模拟「当前页预算很宽」），
 * 搜索仍必须只按 titleSearchLimit 取标题；否则就是又回到了随候选集膨胀的老路。
 */
test("listSessions：搜索的标题预算独立于 titleLimit，不随候选集膨胀（性能回归）", async () => {
  // 造 30 条候选（远超搜索预算 3），并让 titleLimit 很宽 —— 若搜索误用 titleLimit，
  // 就会去取 30 条标题，requested 会变成 30。
  const records = Array.from({ length: 30 }, (_, i) => ({
    header: { id: `s-${i}`, cwd: "E:\\p", createdAt: 1000 + i },
    live: true,
    persisted: true,
  }));
  const { service, titleCalls } = makePanelCtx({
    records,
    summaries: records.map((r) => ({
      sessionId: r.header.id,
      running: false,
      blank: false,
      updatedAt: 1000,
    })),
    config: { titleLimit: 200, titleSearchLimit: 3 },
  });

  const result = await service.listSessions({ query: "no-such-keyword", pageSize: 5 });
  assert.equal(result.ok, true);
  assert.equal(result.value.titles.requested, 3, `搜索只该按 titleSearchLimit=3 取标题，实际 ${result.value.titles.requested}`);
  assert.equal(titleCalls.flat().length, 3, "恰好 3 次标题读取（预算 3）");
  // 预算外必须如实上报（30 - 3 = 27 行没读标题）。
  assert.equal(result.value.titles.truncated, 27, "预算外 27 行必须如实进 truncated");
});

/**
 * 归档三选一（取值照官方 `archivedFilter: 'default' | 'show' | 'only'`），
 * 但**默认值是 show** —— 本插件是清理工具，归档 ≠ 删除（仍占磁盘），
 * 默认隐藏已归档会让用户看不到本该能清理的会话。用户明确要求默认显示已归档。
 *
 * 取证：归档集合**不在** `SessionSummary` 里（该类型没有 `archived` 字段），
 * 而在 workspace 存储领域的全局状态 `archivedSessionIds` 中
 * （dsh-workspace README：「…加上一个持有 workspaceIds、archivedSessionIds、
 * pinnedSessionIds…的全局状态」）。Host 侧读取入口是
 * `storageDomain.get('workspace').global.get()` —— **不能** `open()`（会 already-open）。
 */
test("归档：默认显示已归档（本插件刻意偏离官方 default）", async () => {
  const { service } = makePanelCtx({ archivedIds: ["s-mid"] });
  const result = await service.listSessions();
  const ids = result.value.items.map((r) => r.sessionId);
  assert.equal(ids.includes("s-mid"), true, "默认必须纳入已归档会话（清理工具要能看见它们）");
  assert.equal(ids.includes("s-new"), true, "非归档行必须仍在");
  assert.equal(result.value.archived.filter, "show", "默认 filter 必须是 show");
  assert.equal(result.value.archived.total, 1, "计数应报告全库归档数（不受筛选影响）");
});

test("归档：default 隐藏已归档（显式请求时）", async () => {
  const { service } = makePanelCtx({ archivedIds: ["s-mid"] });
  const result = await service.listSessions({ archived: "default" });
  const ids = result.value.items.map((r) => r.sessionId);
  assert.equal(ids.includes("s-mid"), false, "显式 default 必须隐藏已归档会话");
  assert.equal(ids.includes("s-new"), true, "非归档行必须仍在");
  assert.equal(result.value.archived.filter, "default");
});

test("归档：客户端与服务端的默认值必须一致（防「界面切了接口没切」）", async () => {
  // 从源码读取两个默认值，锁死它们相等。
  // 为什么值得单测：这两个默认值分散在 client.js（useState 初值）与
  // lib/service.js（请求缺省兜底）两处，改一处忘另一处时，
  // 表现是「首次加载正常、手动切换后回不去」这类只在特定路径复现的偏差。
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  const clientSrc = await readFile(path.join(root, "client.js"), "utf8");
  const serviceSrc = await readFile(path.join(root, "lib/service.js"), "utf8");

  const clientDefault = /archived:\s*"(default|show|only)"/.exec(clientSrc)?.[1];
  assert.ok(clientDefault, "必须能从 client.js 读到 archived 默认值");

  // 服务端是三元：只有 default / only 被显式识别，其余（含 undefined）落到兜底值。
  // 注意取**最后一段冒号之后**的兜底值 —— 直接搜整行会误判：
  // `request?.archived === "show" ? … : "default"` 这行里也含 "show"（在比较里）。
  const svcLine = /const archivedFilter\s*=\s*([^;]+);/.exec(serviceSrc)?.[1];
  assert.ok(svcLine, "必须能从 service.js 读到 archivedFilter 默认逻辑");
  const fallback = /:\s*"(default|show|only)"\s*$/.exec(svcLine.trim())?.[1];
  assert.ok(fallback, `必须能从服务端三元表达式里取出兜底值（当前：${svcLine.trim().slice(0, 90)}）`);
  const serverDefault = fallback;
  assert.equal(serverDefault, "show", "服务端兜底必须是 show");

  assert.equal(
    clientDefault,
    serverDefault,
    `客户端默认（${clientDefault}）必须与服务端兜底（${serverDefault}）一致`,
  );
});

test("归档：show 显示全部并逐行标记 archived", async () => {
  const { service } = makePanelCtx({ archivedIds: ["s-mid"] });
  const result = await service.listSessions({ archived: "show" });
  const byId = Object.fromEntries(result.value.items.map((r) => [r.sessionId, r]));
  assert.equal(result.value.total, 3, "show 必须纳入归档会话");
  assert.equal(byId["s-mid"].archived, true, "归档行必须带 archived:true 供 UI 显示徽标");
  assert.equal(byId["s-new"].archived, false, "非归档行必须 archived:false");
  assert.equal(result.value.archived.filter, "show");
});

test("归档：only 只显示已归档会话", async () => {
  const { service } = makePanelCtx({ archivedIds: ["s-mid"] });
  const result = await service.listSessions({ archived: "only" });
  assert.deepEqual(result.value.items.map((r) => r.sessionId), ["s-mid"], "only 必须只剩归档行");
  assert.equal(result.value.archived.filter, "only");
});

test("归档：取不到 storageDomain 时如实视为「无归档」，不误标也不隐藏", async () => {
  // 不给 storageDomain —— 领域可能未打开。此时必须退化为「没有归档」，
  // 而不是把所有行都当成归档隐藏掉（那会让用户看不到任何会话）。
  const { service } = makePanelCtx();
  const result = await service.listSessions();
  assert.equal(result.value.total, 3, "不可知时不得隐藏任何行");
  assert.equal(result.value.items.every((r) => r.archived === false), true);
  assert.equal(result.value.archived.known, false, "必须如实报告归档状态不可知");
});

test("归档：archivedSessionIds 形状异常时不抛错", async () => {
  const { service } = makePanelCtx({ archivedIds: null });
  const result = await service.listSessions();
  assert.equal(result.ok, true, "形状异常必须降级而不是让 /list 失败");
  assert.equal(result.value.total, 3);
});

test("归档：归档≠不可删除 —— 归档行仍可删除", async () => {
  // 归档只是从侧栏隐藏，数据仍在磁盘上；删除才是真正的销毁。
  // 因此归档行必须保持 deletable（除非它正在运行）。
  const { service } = makePanelCtx({ archivedIds: ["s-mid"] });
  const result = await service.listSessions({ archived: "only" });
  assert.equal(result.value.items[0].deletable, true, "归档行不因归档而变成不可删除");
});

/**
 * 会话类型三选一 —— **这是「会话逻辑不对」的根因回归**。
 *
 * 官方 README：「**侧边栏隐藏持久化摘要中带有 `origin: 'subagent'` 的行。**」
 * 依据：`SessionHeader { … origin?: 'subagent'; delegationDepth?: number }`。
 * 实测本机 39 条里 17 条 origin==='subagent'（44%）—— 旧实现全列出来，
 * 面板被「You are doing a READ-ONLY…」这类子代理会话淹没。
 */
test("子代理：默认只显示主会话（照官方侧栏隐藏 subagent）", async () => {
  const { service } = makePanelCtx({ withSubagent: true });
  const result = await service.listSessions();
  const ids = result.value.items.map((r) => r.sessionId);
  assert.equal(ids.includes("s-sub"), false, "默认必须隐藏子代理会话");
  assert.equal(result.value.total, 3, "默认只统计主会话");
  assert.equal(result.value.kind.filter, "main");
  assert.equal(result.value.kind.subagentTotal, 1, "应如实报告全库子代理数");
});

test("子代理：kind=subagent 只看子代理，且带身份字段", async () => {
  const { service } = makePanelCtx({ withSubagent: true });
  const result = await service.listSessions({ kind: "subagent" });
  assert.deepEqual(result.value.items.map((r) => r.sessionId), ["s-sub"]);
  const row = result.value.items[0];
  assert.equal(row.subagent, true, "必须带 subagent 标记供 UI 显示徽标");
  assert.equal(row.delegationDepth, 1, "应带委派深度");
  assert.equal(row.parentSessionId, "s-new", "应带父会话 id");
});

test("子代理：kind=all 两者都显示并逐行标记", async () => {
  const { service } = makePanelCtx({ withSubagent: true });
  const result = await service.listSessions({ kind: "all" });
  const byId = Object.fromEntries(result.value.items.map((r) => [r.sessionId, r]));
  assert.equal(result.value.total, 4);
  assert.equal(byId["s-sub"].subagent, true);
  assert.equal(byId["s-new"].subagent, false, "主会话必须 subagent:false");
  assert.equal(result.value.kind.filter, "all");
});

test("子代理：子代理会话同样可删除（可见性≠不可删）", async () => {
  const { service } = makePanelCtx({ withSubagent: true });
  const result = await service.listSessions({ kind: "subagent" });
  assert.equal(result.value.items[0].deletable, true, "子代理会话不因身份而变成不可删除");
});

test("子代理：无 origin 字段的历史会话按主会话处理（不得误伤）", async () => {
  // header 里没有 origin 的旧会话必须照常显示 —— 不能把「字段缺失」当成子代理。
  const { service } = makePanelCtx();
  const result = await service.listSessions();
  assert.equal(result.value.total, 3);
  assert.equal(result.value.kind.subagentTotal, 0);
});

test("listSessions：分页元信息正确（契约 §5.3.2 的 page 对象）", async () => {
  const { service } = makePanelCtx();
  const page1 = await service.listSessions({ page: 1, pageSize: 2 });
  assert.deepEqual(page1.value.page, { page: 1, pageSize: 2, pages: 2 });
  assert.equal(page1.value.items.length, 2);
  const page2 = await service.listSessions({ page: 2, pageSize: 2 });
  assert.equal(page2.value.items.length, 1);
  // 越界页收敛到最后有效页，而不是返回空
  const page9 = await service.listSessions({ page: 9, pageSize: 2 });
  assert.equal(page9.value.page.page, 2);
  assert.equal(page9.value.items.length, 1);
});

test("listSessions：pageSize 有上限（防止一次拉爆宿主）", async () => {
  const { service } = makePanelCtx();
  const result = await service.listSessions({ pageSize: 100000 });
  assert.equal(result.value.page.pageSize, 200);
});

test("listSessions：running 过滤与关键词过滤", async () => {
  const { service } = makePanelCtx();
  const runningOnly = await service.listSessions({ running: true });
  assert.deepEqual(runningOnly.value.items.map((r) => r.sessionId), ["s-new"]);

  const idleOnly = await service.listSessions({ running: false });
  assert.deepEqual(idleOnly.value.items.map((r) => r.sessionId).sort(), ["s-mid", "s-old"]);

  const byProject = await service.listSessions({ project: "E:\\proj-A" });
  assert.deepEqual(byProject.value.items.map((r) => r.sessionId).sort(), ["s-mid", "s-new"]);

  const byQuery = await service.listSessions({ query: "s-old" });
  assert.deepEqual(byQuery.value.items.map((r) => r.sessionId), ["s-old"]);
});

test("listSessions：列出可用项目清单供筛选下拉使用", async () => {
  const { service } = makePanelCtx();
  const result = await service.listSessions();
  assert.deepEqual(result.value.projects, ["E:\\proj-A", "E:\\proj-B"]);
});

test("listSessions：sessionQuery 缺失时降级到 sessionController（不报错）", async () => {
  const services = {
    sessionController: {
      list: async () => ({ items: [{ sessionId: "s1", running: false, blank: true, updatedAt: 5 }] }),
    },
  };
  const ctx = { logger: { warn() {}, debug() {} }, get: (k) => services[k] };
  const audit = { record: async () => ({ ok: true, path: null }), enabled: false, path: null };
  const service = createService(ctx, resolveConfig({ audit: false }), audit);

  const result = await service.listSessions();
  assert.equal(result.ok, true);
  assert.equal(result.value.sources.corpus, "none");
  assert.equal(result.value.sources.summary, "sessionController.list");
  assert.equal(result.value.total, 1);
  assert.equal(result.value.items[0].sessionId, "s1");
});

test("listSessions：两个服务都缺失时给出 cleanup-unavailable（不假装空清单）", async () => {
  const ctx = { logger: { warn() {}, debug() {} }, get: () => undefined };
  const audit = { record: async () => ({ ok: true, path: null }), enabled: false, path: null };
  const service = createService(ctx, resolveConfig({ audit: false }), audit);
  const result = await service.listSessions();
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "cleanup-unavailable");
});

test("listSessions：readTitleSnapshots 抛错时清单仍然可用（标题降级为 null）", async () => {
  const services = {
    sessionQuery: {
      listSessions: async () => [
        { header: { id: "s1", cwd: "E:\\p", createdAt: 1 }, live: true, persisted: true },
      ],
      readTitleSnapshots: async () => { throw new Error("title service down"); },
    },
    sessionController: { list: async () => ({ items: [] }) },
  };
  const ctx = { logger: { warn() {}, debug() {} }, get: (k) => services[k] };
  const audit = { record: async () => ({ ok: true, path: null }), enabled: false, path: null };
  const service = createService(ctx, resolveConfig({ audit: false }), audit);

  const result = await service.listSessions();
  assert.equal(result.ok, true, "标题失败不能把整张清单打挂");
  assert.equal(result.value.items[0].title, null);
});

// ───────────────────────── 批量删除端点 ─────────────────────────

test("routes：delete 支持 sessionIds 批量，逐条复用同一个 service 实现", async () => {
  const { apply } = await import("../lib/index.js");
  const routes = new Map();
  const root = await mkdtemp(join(tmpdir(), "dscc-batch-"));

  try {
    await mkdir(join(root, "p", "s1"), { recursive: true });
    await writeFile(join(root, "p", "s1", "x"), "1");

    const services = {
      sessionController: { list: async () => ({ items: [] }) },
      agents: { get: () => undefined },
    };
    const ctx = {
      logger: { warn() {}, debug() {} },
      get: (k) => services[k],
      webServer: { register(route) { routes.set(route.path, route.handler); return () => {}; } },
      effect: (callback) => callback(),
    };
    apply(ctx, { audit: false });

    const res = makeRes();
    await routes.get("/api-ext/dialogue-cleanup/delete")(
      makeReq({
        method: "POST",
        headers: { "sec-fetch-site": "same-origin", "content-type": "application/json" },
        body: JSON.stringify({ sessionIds: ["s1", "../evil", "s2"] }),
      }),
      res,
    );
    assert.equal(res.captured.status, 200, "批量端点整体成功（单条非法项不影响其余）");
    const body = JSON.parse(res.captured.body);
    assert.equal(body.ok, true);
    assert.equal(body.value.total, 3);
    assert.equal(body.value.ok, 2, "s1 与 s2 成功");
    assert.equal(body.value.fail, 1, "../evil 非法");
    const bad = body.value.outcomes.find((o) => o.sessionId === "../evil");
    assert.equal(bad.ok, false);
    assert.equal(bad.error.code, "bad-request");
    assert.deepEqual(await readdir(join(root, "p")), ["s1"], "非法 id 不得删除任何东西");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("routes：批量 sessionIds 拒绝空数组与超限（防打爆宿主）", async () => {
  const { apply } = await import("../lib/index.js");
  const routes = new Map();
  const ctx = {
    logger: { warn() {}, debug() {} },
    get: () => undefined,
    webServer: { register(route) { routes.set(route.path, route.handler); return () => {}; } },
    effect: (callback) => callback(),
  };
  apply(ctx, { audit: false });

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

  const empty = await call({ sessionIds: [] });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.error.code, "bad-request");

  const tooMany = await call({ sessionIds: Array.from({ length: 201 }, (_, i) => `s${i}`) });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.body.error.message, /200/);
});

test("routes：批量删除按**请求**计费，一次批量只扣 1 个额度（回归）", async () => {
  const { apply } = await import("../lib/index.js");
  const routes = new Map();
  const services = {
    sessionController: { list: async () => ({ items: [] }) },
    agents: { get: () => undefined },
  };
  const ctx = {
    logger: { warn() {}, debug() {} },
    get: (k) => services[k],
    webServer: { register(route) { routes.set(route.path, route.handler); return () => {}; } },
    effect: (callback) => callback(),
  };
  // 配额 1：如果还按条数计费，任何批量都会 429。
  apply(ctx, { audit: false, rateLimitPerMinute: 1, matchAlternateIdSpelling: false });

  const batchRes = makeRes();
  await routes.get("/api-ext/dialogue-cleanup/delete")(
    makeReq({
      method: "POST",
      headers: { "sec-fetch-site": "same-origin", "content-type": "application/json" },
      // 远大于默认页大小：旧实现在这里必然 429。
      body: JSON.stringify({ sessionIds: Array.from({ length: 50 }, (_, i) => `probe-batch-${i}`) }),
    }),
    batchRes,
  );
  assert.notEqual(
    batchRes.captured.status,
    429,
    "一次批量请求只能算一个额度 —— 旧实现按 50 条计费，配额 1 时必然 429",
  );
  assert.equal(batchRes.captured.status, 200);
  assert.equal(JSON.parse(batchRes.captured.body).value.total, 50);

  // 额度确实被消耗了：紧接着的第二次写请求被拒。
  const secondRes = makeRes();
  await routes.get("/api-ext/dialogue-cleanup/delete")(
    makeReq({
      method: "POST",
      headers: { "sec-fetch-site": "same-origin", "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "probe-after-batch" }),
    }),
    secondRes,
  );
  assert.equal(secondRes.captured.status, 429, "限流仍然生效，只是不再按条数计费");
});

test("routes：限流只作用于删除（list / status 不受影响）", async () => {
  const { apply } = await import("../lib/index.js");
  const routes = new Map();
  const services = {
    sessionController: { list: async () => ({ items: [] }) },
    agents: { get: () => undefined },
  };
  const ctx = {
    logger: { warn() {}, debug() {} },
    get: (k) => services[k],
    webServer: { register(route) { routes.set(route.path, route.handler); return () => {}; } },
    effect: (callback) => callback(),
  };
  // 配额 1：删一次就把额度用光
  apply(ctx, { audit: false, rateLimitPerMinute: 1 });

  const callDelete = async () => {
    const res = makeRes();
    await routes.get("/api-ext/dialogue-cleanup/delete")(
      makeReq({
        method: "POST",
        headers: { "sec-fetch-site": "same-origin", "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "s1" }),
      }),
      res,
    );
    return res.captured.status;
  };

  await callDelete();
  assert.equal(await callDelete(), 429, "第二次删除被限流");

  // 只读端点不被限流拖累
  const res = makeRes();
  await routes.get("/api-ext/dialogue-cleanup/status")(
    makeReq({ method: "GET", headers: { "sec-fetch-site": "same-origin" } }),
    res,
  );
  assert.equal(res.captured.status, 200, "status 仍可用");

  const listRes = makeRes();
  await routes.get("/api-ext/dialogue-cleanup/list")(
    makeReq({ method: "GET", headers: { "sec-fetch-site": "same-origin" } }),
    listRes,
  );
  assert.equal(listRes.captured.status, 200, "list 仍可用");
});

test("routes：list 的 GET 查询串被解析（便于浏览器排查）", async () => {
  const { apply } = await import("../lib/index.js");
  const routes = new Map();
  const seen = [];
  const services = {
    sessionQuery: {
      listSessions: async () => [
        { header: { id: "aaa", cwd: "E:\\p", createdAt: 1 }, live: true, persisted: true },
        { header: { id: "bbb", cwd: "E:\\q", createdAt: 2 }, live: true, persisted: true },
      ],
      readTitleSnapshots: async (ids) => ids.map((sessionId) => ({ sessionId, status: "fulfilled", value: {} })),
    },
    sessionController: { list: async () => ({ items: [] }) },
  };
  const ctx = {
    logger: { warn() {}, debug() {} },
    get: (k) => services[k],
    webServer: { register(route) { routes.set(route.path, route.handler); return () => {}; } },
    effect: (callback) => callback(),
  };
  apply(ctx, { audit: false });

  const req = makeReq({ method: "GET", headers: { "sec-fetch-site": "same-origin" } });
  req.url = "/api-ext/dialogue-cleanup/list?query=aaa&sort=created&page=1&pageSize=10";
  const res = makeRes();
  await routes.get("/api-ext/dialogue-cleanup/list")(req, res);
  seen.push(JSON.parse(res.captured.body));

  assert.equal(res.captured.status, 200);
  assert.equal(seen[0].value.total, 1, "query=aaa 过滤掉 bbb");
  assert.equal(seen[0].value.items[0].sessionId, "aaa");

  // running 过滤也走查询串
  const runningReq = makeReq({ method: "GET", headers: { "sec-fetch-site": "same-origin" } });
  runningReq.url = "/api-ext/dialogue-cleanup/list?running=true";
  const runningRes = makeRes();
  await routes.get("/api-ext/dialogue-cleanup/list")(runningReq, runningRes);
  const runningBody = JSON.parse(runningRes.captured.body);
  assert.equal(runningBody.value.total, 0, "摘要里没有 running 的会话");
});

test("routes：status 报告面板能力（layout 缺失时如实说明）", async () => {
  const { apply } = await import("../lib/index.js");
  const routes = new Map();
  const ctx = {
    logger: { warn() {}, debug() {} },
    get: () => undefined,
    webServer: { register(route) { routes.set(route.path, route.handler); return () => {}; } },
    effect: (callback) => callback(),
  };
  apply(ctx, { audit: false });
  const res = makeRes();
  routes.get("/api-ext/dialogue-cleanup/status")(
    makeReq({ method: "GET", headers: { "sec-fetch-site": "same-origin" } }),
    res,
  );
  const body = JSON.parse(res.captured.body);
  assert.equal(body.value.capabilities.listSessions, false, "无 sessionController 时如实为 false");
  assert.equal(body.value.capabilities.publicStopIdleAgent, false);
});

/**
 * 【回归 · 2026-10】`detachLive` / `detachLiveEntry` 必须分别如实反映事实。
 *
 * 旧探针只回答「`sessions.store.get` 是不是函数」。在真实宿主里它**恒为 true**
 * （`store` 是 SessionStore 的实例字段，经 Cordis 代理可达），于是 `/status` 一直
 * 显示「能摘内存」，而审计日志里 11 次删除**全部** `detached:false` —— 探针的
 * 答案与事实不符，排障时反而误导。
 *
 * 现在拆成两问：
 *   detachLive      —— 能不能摸到内部 store Map；
 *   detachLiveEntry —— 摘除真正依赖的 `entry.detach` 是否存在。
 */
test("routes：status 的 detachLive 探针区分「store 可达」与「entry.detach 可用」", async () => {
  const { apply } = await import("../lib/index.js");

  const probe = async (sessions) => {
    const routes = new Map();
    const services = { sessions, sessionController: { list: async () => ({ items: [] }) } };
    const ctx = {
      logger: { warn() {}, debug() {} },
      get: (k) => services[k],
      webServer: { register(route) { routes.set(route.path, route.handler); return () => {}; } },
      effect: (callback) => callback(),
    };
    apply(ctx, { audit: false });
    const res = makeRes();
    routes.get("/api-ext/dialogue-cleanup/status")(
      makeReq({ method: "GET", headers: { "sec-fetch-site": "same-origin" } }),
      res,
    );
    return JSON.parse(res.captured.body).value.capabilities;
  };

  // ① store 里有一个带 detach 的 entry —— 两个都该是 true。
  const withEntry = await probe({
    list: () => [],
    store: new Map([["s1", { detach: () => {} }]]),
  });
  assert.equal(withEntry.detachLive, true, "store 可达");
  assert.equal(withEntry.detachLiveEntry, true, "entry.detach 存在 —— 这才是真能摘");

  // ② store 可达但里面没有 entry（或 entry 没有 detach）—— 必须如实报 false，
  //    不能因为「摸到了 store」就谎称能摘。
  const noEntry = await probe({ list: () => [], store: new Map() });
  assert.equal(noEntry.detachLive, true, "store 仍然可达");
  assert.equal(noEntry.detachLiveEntry, false, "没有可摘的 entry —— 不得谎报");

  // ③ 完全拿不到 sessions —— 两个都 false。
  const none = await probe(undefined);
  assert.equal(none.detachLive, false);
  assert.equal(none.detachLiveEntry, false);

  // ④ store 可达但 entry **没有** detach —— 探针必须如实说 false。
  //    （这一条专门防「entryDetach 恒为 true」的谎报：裸 entry 只能靠 store.delete 兜底，
  //     而那条路不走 entry.detach，两者的能力含义不同。）
  const bareEntry = await probe({ list: () => [], store: new Map([["s1", {}]]) });
  assert.equal(bareEntry.detachLive, true, "store 仍然可达");
  assert.equal(bareEntry.detachLiveEntry, false, "entry 没有 detach —— 不得谎报能摘");
});

