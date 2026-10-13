/**
 * 契约层：同源判定 + 读请求体 + 写响应。
 *
 * 与上游的三处关键差别（都是硬伤级）：
 *   1. 上游 `sendJson` **写死 200** —— 网关/日志/监控看不到失败。这里状态码显式传入。
 *   2. 上游没有同源/CSRF 校验 —— 删除类端点的硬伤。这里按本仓库冻结契约五步判定。
 *   3. 上游没有读超时 —— 客户端声明 Content-Length 后不发完，handler 会永久挂住。
 *      这里 64 KiB 上限 + 10 s 读超时。
 *
 * 同源判定顺序沿用 `docs/API-CONTRACT.md`（已在真实桌面端纠正过）：
 * 官方桌面壳转发前会删掉 Host / Origin / Cookie / Sec-Fetch-Site，
 * 因此「两个头都不存在」是桌面端的正常形状，不能当跨站。
 */

export const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

/** 官方桌面壳（Electron）的页面 origin。 */
export const DESKTOP_SHELL_ORIGINS = new Set(["dsh-app://app", "dsh-app://shell"]);

/** §5.2 错误码 → HTTP 状态码。 */
export const STATUS = {
  "bad-request": 400,
  "cross-origin": 403,
  "not-found": 404,
  "method-not-allowed": 405,
  refused: 409,
  "rate-limited": 429,
  "cleanup-unavailable": 500,
  "delete-failed": 500,
  internal: 500,
};

export function sendJson(res, status, body, extraHeaders = {}) {
  const text = JSON.stringify(body);
  const headers = {
    "content-type": JSON_CONTENT_TYPE,
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(text),
    ...extraHeaders,
  };
  if (typeof res.writeHead === "function") res.writeHead(status, headers);
  res.end(text);
}

export function ok(res, value, status = 200) {
  return sendJson(res, status, { ok: true, value });
}

export function fail(res, code, message, hint) {
  const error = { code, message };
  if (hint !== undefined && hint !== null && hint !== "") error.hint = hint;
  const headers = code === "method-not-allowed" ? { allow: "GET, POST, OPTIONS" } : {};
  return sendJson(res, STATUS[code] ?? 500, { ok: false, error }, headers);
}

/** 取请求头；Node 把名字转小写，数组值取第一个。 */
export function headerOf(req, name) {
  const value = req?.headers?.[name];
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" ? value : undefined;
}

/** 请求是否来自回环地址（桌面壳转发、本地脚本、curl 都满足）。 */
export function isLoopbackRequest(req) {
  const address = req?.socket?.remoteAddress;
  if (typeof address !== "string" || address === "") return false;
  const normalized = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  return normalized === "::1" || normalized.startsWith("127.");
}

/**
 * 同源判定（冻结顺序五步）。
 * @returns {{ok: true} | {ok: false, origin?: string, site?: string, remote?: string}}
 */
export function checkOrigin(req) {
  const origin = headerOf(req, "origin");
  const site = headerOf(req, "sec-fetch-site");

  // 1. 桌面壳页面 origin —— 页面脚本无法伪造。
  if (origin !== undefined && DESKTOP_SHELL_ORIGINS.has(origin)) return { ok: true };
  // 2. 明确的跨站标记。
  if (site === "cross-site") return { ok: false, origin, site };
  // 3. 有 Origin：host 必须与 Host 一致。
  if (origin !== undefined) {
    const host = headerOf(req, "host");
    try {
      if (new URL(origin).host === host) return { ok: true };
    } catch {
      /* 非法 origin 视为不可信 */
    }
    return { ok: false, origin, site };
  }
  // 4. 两个头都不存在 —— 只有回环才放行（桌面壳转发就是这个形状）。
  const remote = req?.socket?.remoteAddress ?? "";
  if (site === undefined) {
    return isLoopbackRequest(req) ? { ok: true } : { ok: false, origin, site, remote };
  }
  // 5. 只有 Sec-Fetch-Site：必须 same-origin。
  return site === "same-origin" ? { ok: true } : { ok: false, origin, site };
}

/** 校验 Content-Type 是 JSON（允许空体端点不带）。 */
export function hasJsonContentType(req) {
  const raw = headerOf(req, "content-type");
  if (raw === undefined) return false;
  return String(raw).toLowerCase().split(";")[0].trim() === "application/json";
}

/**
 * 流式读 JSON 体：有上限、有超时（上游两者都没有）。
 * 超时/超限都抛出明确错误，由调用方映射成 bad-request。
 */
export async function readJsonBody(req, { limit, timeoutMs }) {
  let size = 0;
  const chunks = [];
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    req.destroy?.(new Error("dialogue-cleanup: read timeout"));
  }, timeoutMs);

  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) {
        req.destroy?.();
        throw new Error(`请求体超过上限（${limit} 字节）`);
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (timedOut) throw new Error(`读取请求体超时（${timeoutMs} ms）`);
    throw error;
  } finally {
    clearTimeout(timer);
  }

  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("请求体不是合法 JSON");
  }
}

/** 令牌桶限流（每分钟容量 refillPerMinute；0 = 不限）。take(n) 支持一次扣 n 个额度。 */
export function createRateLimiter(refillPerMinute, now = () => Date.now()) {
  if (!Number.isInteger(refillPerMinute) || refillPerMinute <= 0) {
    return { take: () => true, enabled: false, limit: 0 };
  }
  const windowMs = 60000;
  let windowStart = now();
  let used = 0;
  return {
    enabled: true,
    limit: refillPerMinute,
    take(cost = 1) {
      const t = now();
      if (t - windowStart >= windowMs) {
        windowStart = t;
        used = 0;
      }
      const want = Number.isInteger(cost) && cost > 0 ? cost : 1;
      // 一次要的额度超过整窗容量：直接拒绝，而不是让 used 溢出配额。
      if (want > refillPerMinute) return false;
      if (used + want > refillPerMinute) return false;
      used += want;
      return true;
    },
  };
}
