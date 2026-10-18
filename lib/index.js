/**
 * 插件入口（R-10：只导出一种形态 —— apply + inject + Config，不混用 service class）。
 *
 * 路由：
 *   POST /api-ext/dialogue-cleanup/delete   { sessionId }
 *   POST /api-ext/dialogue-cleanup/list     { }  （也接受 GET，便于浏览器直接打开排查）
 *   GET  /api-ext/dialogue-cleanup/status
 *
 * 全部注册都在 `ctx.effect` 内，并返回清理函数（R-11）。上游的 webServer.register
 * **没有** effect 包裹，靠「插件卸载即整行消失」这个粗粒度语义 —— 热重载时会重复注册，
 * 而 `webServer.register` 对重复的 (kind,path) 是**抛错**的。
 */

import { createRequire } from "node:module";
import { Config, resolveConfig } from "./config.js";
import { createAudit } from "./audit.js";
import { createService } from "./service.js";
import {
  createRateLimiter,
  fail,
  hasJsonContentType,
  headerOf,
  checkOrigin,
  ok,
  readJsonBody,
} from "./http.js";
import {
  dshHome,
  isInside,
  isValidSessionId,
  projectionCacheRoot,
  removeArtifacts,
  removeProjectionCache,
  sessionsRoot,
} from "./artifacts.js";

export const name = "dialogue-cleanup";

/**
 * 版本从**包清单**读，不写死。
 *
 * 原来这里是 `export const version = "1.0.0"` —— 写死会在每次发布后与 package.json 漂移，
 * 于是 `/status` 与面板显示的版本永远停在 1.0.0。本仓库的发布门禁**专门拦这一条**
 * （`release.ps1` 里「lib/ 的非注释行里不得写死旧版本号」），所以写死的话
 * 第一次 `-Bump patch` 就会被自己拦下。同一范式见 dsh-plugin-market 的 PLUGIN_VERSION。
 */
export const version = createRequire(import.meta.url)("../package.json").version ?? "0.0.0";
export { Config };

/**
 * 可选服务放 inject，让插件在缺少它们的组合里保持不激活而不是抛错（R-12）。
 * `webServer` 是硬依赖（没有它整个插件没有入口）；其余都在 apply 内用 ctx.get 判空。
 */
export const inject = ["webServer"];

const BASE = "/api-ext/dialogue-cleanup";

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);
  const audit = createAudit(config, ctx?.logger);
  const service = createService(ctx, config, audit);
  const limiter = createRateLimiter(config.rateLimitPerMinute);

  /** 共享的前置检查：同源 → 方法 → Content-Type → 读体。 */
  async function readRequest(req, res, { method, requireBody }) {
    const origin = checkOrigin(req);
    if (!origin.ok) {
      fail(
        res,
        "cross-origin",
        "请求来源不可信",
        `origin=${origin.origin ?? "-"} sec-fetch-site=${origin.site ?? "-"} remote=${origin.remote ?? req.socket?.remoteAddress ?? "-"}`,
      );
      return null;
    }

    if (req.method === "OPTIONS") {
      // 预检：同源已经过了，直接回 204。
      res.writeHead?.(204, { allow: "GET, POST, OPTIONS", "cache-control": "no-store" });
      res.end();
      return null;
    }

    if (req.method !== method) {
      fail(res, "method-not-allowed", `该端点只接受 ${method}`);
      return null;
    }

    if (requireBody) {
      if (!hasJsonContentType(req)) {
        fail(res, "bad-request", "请求体必须是 application/json", `收到的 content-type=${headerOf(req, "content-type") ?? "-"}`);
        return null;
      }
      try {
        return await readJsonBody(req, { limit: config.maxBodyBytes, timeoutMs: config.readTimeoutMs });
      } catch (error) {
        fail(res, "bad-request", String(error?.message ?? error));
        return null;
      }
    }

    // GET：没有请求体，但也要消费掉，避免 socket 悬挂。
    req.resume?.();
    return {};
  }

  /** 解析 GET 的查询串（便于浏览器/curl 直接排查）。 */
  function parseListQuery(req) {
    const raw = String(req?.url ?? "");
    const at = raw.indexOf("?");
    if (at < 0) return {};
    const params = new URLSearchParams(raw.slice(at + 1));
    const out = {};
    for (const key of ["query", "project", "sort"]) {
      const value = params.get(key);
      if (typeof value === "string" && value !== "") out[key] = value;
    }
    const running = params.get("running");
    if (running === "true") out.running = true;
    else if (running === "false") out.running = false;
    // 归档三选一（照官方语义）：default | show | only
    const archived = params.get("archived");
    if (archived === "default" || archived === "show" || archived === "only") out.archived = archived;
    // 会话类型三选一：main（默认，照官方隐藏子代理）| subagent | all
    const kind = params.get("kind");
    if (kind === "main" || kind === "subagent" || kind === "all") out.kind = kind;
    for (const key of ["page", "pageSize"]) {
      const value = params.get(key);
      if (value !== null && /^\d+$/.test(value)) out[key] = Number(value);
    }
    return out;
  }

  /**
   * 给每个 handler 套一层「绝不把异常漏出去」的保护。
   *
   * 为什么必须做：webserver 的实现是
   *   `handle(req,res).catch(err => { logger.warn(err); if (headersSent) destroy(); else { writeHead(400); end(); } })`
   * —— 任何从 handler 抛出的异常都会变成**没有 body、没有 content-type 的 400**，
   * 调用方拿着它无法判断到底哪里错了（实测踩到过：`/status` 空 body 400）。
   * 契约 §5.2 要求未预期异常返回 `internal` + 异常原文，所以这里统一收口：
   * 已发头就销毁连接，否则回一条规范的 500。
   */
  function guard(handler) {
    return async (req, res) => {
      try {
        return await handler(req, res);
      } catch (error) {
        const message = String(error?.message ?? error);
        ctx.logger?.warn?.(`dialogue-cleanup: handler failed: ${message}`);
        if (res.headersSent === true) {
          res.destroy?.();
          return undefined;
        }
        return fail(res, "internal", message, "查看宿主日志里 dialogue-cleanup 的记录，然后重试。");
      }
    };
  }

  const handlers = {
    async delete(req, res) {
      const payload = await readRequest(req, res, { method: "POST", requireBody: true });
      if (payload === null) return;

      // 先做**请求形状**校验（400），再扣配额。反过来的话，一个超限的批量请求
      // 会先被限流拦成 429，把「你一次要删 201 个」这个真正的错误信息盖掉。
      const batch = Array.isArray(payload?.sessionIds) ? payload.sessionIds : null;
      if (batch !== null) {
        if (batch.length === 0) return fail(res, "bad-request", "sessionIds 不能为空");
        if (batch.length > 200) {
          return fail(res, "bad-request", "一次最多删除 200 个会话", `收到 ${batch.length} 个。`);
        }
      }

      // 限流只作用于**写操作**（删除）。上游没有限流；这里也不该拖累只读的 list/status。
      //
      // 【实测修正】这里原来按**条数**计费（删 50 个扣 50 个额度），而默认配额是 10/分 ——
      // 于是「全选本页再删除」这个最常见的操作**必然**撞 429：
      //   批量 10/11/50/200 → 全部 429 rate-limited（已实测复现）。
      // 现在改为**按请求计费**：一次批量请求扣 1 个额度。
      // 防滥用靠的是「每分钟最多多少次请求」，而不是「一次能删多少条」；
      // 单次批量的条数上限由上面的 200 约束，两者职责分开。
      if (!limiter.take(1)) {
        return fail(
          res,
          "rate-limited",
          "删除请求过于频繁",
          `每分钟最多 ${config.rateLimitPerMinute} 次（可在插件配置里调整）。`,
        );
      }

      const actor = {
        kind: "http",
        origin: headerOf(req, "origin") ?? null,
        userAgent: headerOf(req, "user-agent") ?? null,
      };

      // 批量：逐条走**同一个** service.deleteSession（R-50：一个操作只实现一次），
      // 且单条失败不影响其余（与 UI 的批量语义一致）。
      //
      // 【P1 修复 · 删除前重新验证状态，但仍是 O(1) 次探测】
      // 整批开始前取**一份新鲜快照**，批内每条复用。这既满足「删除前必须重新验证」
      // （不再吃可能来自上次请求的 TTL 缓存），又不退化成 N 次全量列表调用。
      if (batch !== null) {
        const batchSnapshot = await service.freshRunningSnapshotForBatch();
        const outcomes = [];
        for (const sessionId of batch) {
          const result = await service.deleteSession(sessionId, actor, { runningSnapshot: batchSnapshot });
          outcomes.push(
            result.ok === true
              ? { sessionId, ok: true, value: result.value }
              : { sessionId, ok: false, error: result.error },
          );
        }
        const succeeded = outcomes.filter((o) => o.ok === true);
        // 【P0 修复 · 统一结果模型】原来只数 `partial`（且 partial 定义很窄）。
        // 现在明确区分五种情况，避免「部分失败」被报成完整成功：
        //   ok        —— 逐条成功数
        //   fail      —— 逐条失败数
        //   complete  —— **完整成功**（成功且无任何降级项）
        //   degraded  —— 成功但至少一个破坏性步骤没完成（磁盘/内存/审计/通知）
        //   noop      —— 成功但什么都没删到（该 id 可能本来就不存在）
        const degraded = succeeded.filter((o) => o.value?.partial === true);
        const noop = succeeded.filter((o) => o.value?.nothingDeleted === true);
        const complete = succeeded.filter((o) => o.value?.complete === true);
        return ok(res, {
          total: outcomes.length,
          ok: succeeded.length,
          fail: outcomes.length - succeeded.length,
          // 兼容既有字段名：partial 仍是「成功但有降级」的条数。
          partial: degraded.length,
          // 新增：可判别「整批是否完整成功」。
          complete: complete.length,
          degraded: degraded.length,
          noop: noop.length,
          // 逐条降级明细（哪一步、什么原因），便于对账。
          degradations: succeeded.flatMap((o) =>
            (o.value?.degradations ?? []).map((d) => ({ sessionId: o.sessionId, ...d })),
          ),
          files: succeeded.reduce((sum, o) => sum + (o.value?.files ?? 0), 0),
          outcomes,
        });
      }

      const result = await service.deleteSession(payload?.sessionId, actor);
      if (!result.ok) return fail(res, result.error.code, result.error.message, result.error.hint);
      return ok(res, result.value, 200);
    },

    async list(req, res) {
      // GET 支持查询串（便于浏览器/curl 直接排查），POST 支持 JSON 体。
      let payload;
      if (req.method === "POST") {
        const body = await readRequest(req, res, { method: "POST", requireBody: false });
        if (body === null) return;
        payload = body ?? {};
      } else {
        const body = await readRequest(req, res, { method: "GET", requireBody: false });
        if (body === null) return;
        payload = parseListQuery(req);
      }
      const result = await service.listSessions({
        query: payload?.query,
        project: payload?.project,
        running: typeof payload?.running === "boolean" ? payload.running : undefined,
        archived:
          payload?.archived === "show" || payload?.archived === "only" || payload?.archived === "default"
            ? payload.archived
            : undefined,
        kind:
          payload?.kind === "main" || payload?.kind === "subagent" || payload?.kind === "all"
            ? payload.kind
            : undefined,
        page: Number.isInteger(payload?.page) ? payload.page : undefined,
        pageSize: Number.isInteger(payload?.pageSize) ? payload.pageSize : undefined,
        sort: payload?.sort,
      });
      if (!result.ok) return fail(res, result.error.code, result.error.message, result.error.hint);
      return ok(res, result.value);
    },

    status(req, res) {
      const origin = checkOrigin(req);
      if (!origin.ok) {
        return fail(res, "cross-origin", "请求来源不可信", `origin=${origin.origin ?? "-"}`);
      }
      if (req.method !== "GET") return fail(res, "method-not-allowed", "该端点只接受 GET");
      req.resume?.();

      // status 是排障端点：它**自己绝不能成为故障点**。
      // 每个探测项都单独 try/catch，任何一项拿不到就如实标 false / null，而不是让整个端点 500。
      const probe = (fn, fallback) => {
        try {
          return fn();
        } catch (error) {
          return fallback;
        }
      };

      return ok(res, {
        plugin: { name, version },
        routes: { base: BASE, delete: `${BASE}/delete`, list: `${BASE}/list`, status: `${BASE}/status` },
        capabilities: probe(() => service.capabilities(), null),
        runtime: probe(
          () => ({ home: dshHome(), sessionsRoot: sessionsRoot() }),
          null,
        ),
        config: probe(() => config, null),
        audit: probe(() => ({ enabled: audit.enabled, path: audit.path }), null),
      });
    },
  };

  const dispose = ctx.effect(() => {
    const disposers = [];
    for (const [segment, handler] of Object.entries(handlers)) {
      const path = `${BASE}/${segment}`;
      const d = ctx.webServer.register({ kind: "exact", path, handler: guard(handler) });
      if (typeof d === "function") disposers.push(d);
    }
    return () => {
      for (const d of disposers) {
        try {
          d();
        } catch (error) {
          ctx.logger?.warn?.(`dialogue-cleanup: route dispose failed: ${String(error?.message ?? error)}`);
        }
      }
    };
  }, "dialogue-cleanup: routes");

  ctx.logger?.debug?.(`dialogue-cleanup: applied (${Object.keys(handlers).length} routes on ${BASE})`);
  return dispose;
}

// 内部实现导出给单测（与上游同样的做法）
export {
  removeArtifacts,
  removeProjectionCache,
  isValidSessionId,
  isInside,
  sessionsRoot,
  projectionCacheRoot,
  dshHome,
};
