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

