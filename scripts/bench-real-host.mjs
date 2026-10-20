#!/usr/bin/env node
/**
 * 真实 DSH 宿主只读基准（TASK-PERF-04 阶段 B / C / D 的测量工具）
 *
 * 安全边界（对应任务书 §2 与 §8-9）：
 *   · 只发 GET /status 与 GET /list —— 不调 /delete、不调 /archive，不修改任何真实会话；
 *   · 不输出标题文本、会话正文、cwd 路径；结果一致性只比较 sessionId 集合的 sha256 指纹；
 *   · 不为制造「冷缓存」而重启宿主或改动真实数据（冷态靠 titleCacheTtlMs 自然过期建立）。
 *
 * 端口必须自动发现：DSH 每次启动用的回环端口是动态的（实测 4294 → 46664 → 43547），
 * 写死端口会让脚本在某天直接跑空，而且跑空时很容易被误读成「性能变好了」。
 *
 * 用法：
 *   node scripts/bench-real-host.mjs status
 *   node scripts/bench-real-host.mjs series     --n 10 --pageSize 50
 *   node scripts/bench-real-host.mjs sizes      --pageSizes 1,5,10,25,50,100,200
 *   node scripts/bench-real-host.mjs concurrent --levels 1,2,4,8 --rounds 3 --pageSize 50
 *   node scripts/bench-real-host.mjs burst      --n 8 --pageSize 50
 *
 * 选项：
 *   --sleep <ms>  开始测量前先等待（用于等 titleCache 自然过期，取冷态样本）
 *   --base <url>  覆盖基址；也可用环境变量 DC_BASE
 *
 * 冷态的取得方式（重要）：
 *   lib/service.js 里 TTL 判定是 `now - hit.at < ttl`，命中**不刷新** hit.at，
 *   所以冷态只能等 titleCacheTtlMs（默认 300 s）自然过期。一次冷样本至少 5 分钟。
 *   不要用重启宿主来制造冷态——重启会把首查变成最坏情况（实测 3.8-5.3 s），污染对比。
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const STATUS_PATH = "/api-ext/dialogue-cleanup/status";
const KNOWN_PORTS = [43547, 46664, 4294, 19387, 22352];

/** 列出本机 LISTENING 状态的回环端口。 */
async function listeningPorts() {
  const ports = new Set();
  try {
    const { stdout } = await execFileAsync("netstat", ["-ano", "-p", "TCP"], {
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    for (const line of String(stdout).split(/\r?\n/)) {
      const m = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+/i.exec(line);
      if (!m) continue;
      const host = m[1];
      if (host !== "127.0.0.1" && host !== "0.0.0.0" && host !== "[::]" && host !== "::") continue;
      const port = Number(m[2]);
      if (Number.isInteger(port) && port > 0) ports.add(port);
    }
  } catch {
    /* netstat 不可用（非 Windows / 被裁剪的系统）时退回已知端口 + 环境变量 */
  }
  return [...ports].sort((a, b) => a - b);
}

async function probePort(port, timeoutMs = 1000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}${STATUS_PATH}`, { signal: ctrl.signal });
    if (res.status !== 200) return null;
    const body = await res.json();
    if (body?.ok !== true || !body?.value) return null;
    return { port, base: `http://127.0.0.1:${port}/api-ext/dialogue-cleanup` };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 发现扩展端点。顺序：--base / DC_BASE → 已知端口 → 全量回环端口扫描。
 * 找不到就抛错；发现多个也抛错——绝不猜一个地址继续跑，
 * 因为「猜错端口」会得到一份看起来很正常的空数据。
 */
async function discoverBase() {
  const explicit = opt.base || process.env.DC_BASE;
  if (explicit) {
    const m = /:(\d+)\//.exec(`${explicit}/`);
    if (m) {
      const found = await probePort(Number(m[1]));
      if (found) return found.base;
    }
    throw new Error(`DC_BASE=${explicit} 不可达（只发 GET /status）`);
  }

  for (const port of KNOWN_PORTS) {
    const found = await probePort(port);
    if (found) return found.base;
  }

  const all = await listeningPorts();
  const hits = [];
  const batch = 24;
  for (let i = 0; i < all.length; i += batch) {
    const results = await Promise.all(
      all.slice(i, i + batch).map((p) => probePort(p, 700)),
    );
    for (const r of results) if (r) hits.push(r);
    if (hits.length > 0) break;
  }
  if (hits.length === 0) {
    throw new Error(
      "未找到 dialogue-cleanup 扩展端点：确认 DSH 正在运行且插件已启用，" +
        "或设置 DC_BASE=http://127.0.0.1:<port>/api-ext/dialogue-cleanup",
    );
  }
  if (hits.length > 1) {
    throw new Error(
      `发现多个端点（${hits.map((h) => h.port).join(", ")}），请用 DC_BASE 明确指定`,
    );
  }
  return hits[0].base;
}

function parseArgv(argv) {
  const mode = argv[0] && !argv[0].startsWith("--") ? argv[0] : "series";
  const rest = mode === argv[0] ? argv.slice(1) : argv;
  const out = {};
  for (let i = 0; i < rest.length; i += 1) {
    const key = rest[i];
    if (!key.startsWith("--")) continue;
    const val = rest[i + 1];
    out[key.slice(2)] = val === undefined || val.startsWith("--") ? "true" : val;
    if (val !== undefined && !val.startsWith("--")) i += 1;
  }
  return { mode, opt: out };
}

const { mode, opt } = parseArgv(process.argv.slice(2));
const PAGE_SIZE = Number(opt.pageSize ?? 50);
const SLEEP = Number(opt.sleep ?? 0);

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const fmt = (v, d = 1) => (v === null || v === undefined ? "n/a" : v.toFixed(d));

let BASE = null;

/** 一次只读 /list；返回可对比的观测值，不含任何敏感文本。 */
async function hit(pageSize = PAGE_SIZE) {
  const url = `${BASE}/list?pageSize=${pageSize}`;
  const t0 = performance.now();
  let status = -1;
  let body = null;
  let error = null;
  try {
    const res = await fetch(url);
    status = res.status;
    body = JSON.parse(await res.text());
  } catch (e) {
    error = String(e?.message ?? e);
  }
  const clientMs = performance.now() - t0;
  if (error !== null) return { clientMs, status, error };

  const v = body?.value ?? null;
  const items = Array.isArray(v?.items) ? v.items : [];
  const ids = items.map((it) => String(it?.sessionId ?? ""));
  return {
    clientMs,
    status,
    ok: body?.ok === true,
    errorText: body?.error ? String(body.error.message ?? body.error) : null,
    tookMs: num(v?.tookMs),
    total: num(v?.total),
    pages: num(v?.page?.pages),
    echoedPageSize: num(v?.page?.pageSize),
    items: items.length,
    titles: v?.titles ?? null,
    running: items.filter((it) => it?.running === true).length,
    deletable: items.filter((it) => it?.deletable === true).length,
    // 只比 sessionId 集合的哈希，不暴露任何标题/路径
    fp: createHash("sha256").update(ids.slice().sort().join(",")).digest("hex").slice(0, 12),
  };
}

function stats(values) {
  const v = values.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const at = (q) => (v.length === 1 ? v[0] : v[Math.min(v.length - 1, Math.floor((v.length - 1) * q))]);
  return {
    n: v.length,
    min: v[0],
    p50: at(0.5),
    p95: at(0.95),
    max: v[v.length - 1],
    mean: Number((v.reduce((a, b) => a + b, 0) / v.length).toFixed(1)),
    raw: v,
  };
}

const line = (r, tag = "") =>
  `${tag}status=${r.status} clientMs=${fmt(r.clientMs)} tookMs=${fmt(r.tookMs)} ` +
  `items=${r.items}/${r.total} titles[req=${r.titles?.requested} cache=${r.titles?.cached} ` +
  `fetched=${r.titles?.fetched} failed=${r.titles?.failed} trunc=${r.titles?.truncated} ` +
  `skip=${r.titles?.skipped}] running=${r.running} fp=${r.fp}` +
  `${r.error ? ` ERROR=${r.error}` : ""}${r.errorText ? ` ERR=${r.errorText}` : ""}`;

async function main() {
  BASE = await discoverBase();
  process.stderr.write(`[bench] 端点 ${BASE}\n`);

  if (mode === "status") {
    const t0 = performance.now();
    const res = await fetch(`${BASE}/status`);
    const body = await res.json();
    console.log(
      JSON.stringify(
        {
          status: res.status,
          clientMs: Number((performance.now() - t0).toFixed(1)),
          version: body?.value?.plugin?.version ?? null,
          titleFetchConcurrency: body?.value?.config?.titleFetchConcurrency ?? null,
          titleCacheTtlMs: body?.value?.config?.titleCacheTtlMs ?? null,
          titleLimit: body?.value?.config?.titleLimit ?? null,
          titleSearchLimit: body?.value?.config?.titleSearchLimit ?? null,
          capabilities: body?.value?.capabilities ?? null,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (SLEEP > 0) {
    process.stderr.write(`[bench] 等待 ${SLEEP} ms 以便 titleCache 自然过期（不重启宿主）…\n`);
    await new Promise((r) => setTimeout(r, SLEEP));
  }

  if (mode === "series") {
    const n = Number(opt.n ?? 10);
    const rows = [];
    for (let i = 1; i <= n; i += 1) {
      const r = await hit();
      rows.push(r);
      console.log(line(r, `run${i} `));
    }
    const fetched = rows.map((r) => r.titles?.fetched ?? 0);
    const fps = new Set(rows.map((r) => r.fp));
    console.log(
      "\n" +
        JSON.stringify(
          {
            mode: "series",
            n,
            pageSize: PAGE_SIZE,
            clientMs: stats(rows.map((r) => r.clientMs)),
            tookMs: stats(rows.map((r) => r.tookMs)),
            fetchedPerRequest: fetched,
            totalFetchedAllRequests: fetched.reduce((a, b) => a + b, 0),
            distinctResultFingerprints: fps.size,
            errors: rows.filter((r) => r.error || r.status !== 200).length,
          },
          null,
          2,
        ),
    );
    return;
  }

  if (mode === "sizes") {
    const sizes = String(opt.pageSizes ?? "1,5,10,25,50,100,200").split(",").map(Number);
    const rounds = Number(opt.rounds ?? 3);
    const out = [];
    for (const ps of sizes) {
      const rows = [];
      for (let i = 0; i < rounds; i += 1) rows.push(await hit(ps));
      out.push({
        pageSize: ps,
        echoedPageSize: rows[0]?.echoedPageSize ?? null,
        items: rows.map((r) => r.items),
        clientMs: stats(rows.map((r) => r.clientMs)),
        tookMs: stats(rows.map((r) => r.tookMs)),
        titlesRequested: rows.map((r) => r.titles?.requested ?? null),
        titlesFetched: rows.map((r) => r.titles?.fetched ?? null),
        titlesCached: rows.map((r) => r.titles?.cached ?? null),
      });
      console.log(line(rows[0], `pageSize=${ps} `));
    }
    console.log("\n" + JSON.stringify({ mode: "sizes", rounds, out }, null, 2));
    return;
  }

  if (mode === "concurrent") {
    const levels = String(opt.levels ?? "1,2,4,8").split(",").map(Number);
    const rounds = Number(opt.rounds ?? 3);
    const out = [];
    for (const level of levels) {
      const perRound = [];
      for (let round = 1; round <= rounds; round += 1) {
        const t0 = performance.now();
        const rows = await Promise.all(Array.from({ length: level }, () => hit()));
        const wallMs = performance.now() - t0;
        const fps = new Set(rows.map((r) => r.fp));
        const fetchedAll = rows.reduce((a, r) => a + (r.titles?.fetched ?? 0), 0);
        const requestedAll = rows.reduce((a, r) => a + (r.titles?.requested ?? 0), 0);
        const failed = rows.filter((r) => r.error || r.status !== 200).length;
        perRound.push({
          round,
          wallMs: Number(wallMs.toFixed(1)),
          okCount: level - failed,
          failCount: failed,
          distinctFingerprints: fps.size,
          titlesRequestedAll: requestedAll,
          titlesFetchedAll: fetchedAll,
          clientMs: rows.map((r) => Number(r.clientMs.toFixed(1))),
          tookMs: rows.map((r) => r.tookMs),
        });
        console.log(
          `level=${level} round=${round} wall=${wallMs.toFixed(1)}ms ` +
            `ok=${level - failed}/${level} fps=${fps.size} ` +
            `titles[req=${requestedAll} fetched=${fetchedAll}] ` +
            `tookMs=[${rows.map((r) => r.tookMs ?? "n/a").join(",")}]`,
        );
      }
      out.push({
        level,
        wallMs: stats(perRound.map((r) => r.wallMs)),
        distinctFingerprints: perRound.map((r) => r.distinctFingerprints),
        titlesFetchedAll: perRound.map((r) => r.titlesFetchedAll),
        titlesRequestedAll: perRound.map((r) => r.titlesRequestedAll),
        failCount: perRound.reduce((a, r) => a + r.failCount, 0),
        rounds: perRound,
      });
    }
    console.log("\n" + JSON.stringify({ mode: "concurrent", rounds, out }, null, 2));
    return;
  }

  if (mode === "burst") {
    // 单次并发突发：在冷缓存窗口里观测「N 个相同请求共享一次标题读取」。
    // 判读要点：各请求 tookMs 完全一致 = 复用同一在途 Promise（single-flight 生效）；
    // 但 fetched 每个请求都会计满，因为它数的是「最终拿到标题的条数」，
    // 包含复用别人 Promise 的部分 —— 不能用 fetched 判去重。
    const n = Number(opt.n ?? 8);
    const t0 = performance.now();
    const rows = await Promise.all(Array.from({ length: n }, () => hit()));
    const wallMs = performance.now() - t0;
    for (const [i, r] of rows.entries()) console.log(line(r, `burst${i + 1} `));
    const fps = new Set(rows.map((r) => r.fp));
    console.log(
      "\n" +
        JSON.stringify(
          {
            mode: "burst",
            concurrency: n,
            pageSize: PAGE_SIZE,
            wallMs: Number(wallMs.toFixed(1)),
            okCount: rows.filter((r) => r.status === 200 && r.ok).length,
            failCount: rows.filter((r) => r.error || r.status !== 200).length,
            distinctFingerprints: fps.size,
            titlesRequestedPerRequest: rows.map((r) => r.titles?.requested ?? null),
            titlesFetchedPerRequest: rows.map((r) => r.titles?.fetched ?? null),
            titlesFetchedAll: rows.reduce((a, r) => a + (r.titles?.fetched ?? 0), 0),
            titlesRequestedAll: rows.reduce((a, r) => a + (r.titles?.requested ?? 0), 0),
            clientMs: stats(rows.map((r) => r.clientMs)),
            tookMs: stats(rows.map((r) => r.tookMs)),
            runningPerRequest: rows.map((r) => r.running),
            deletablePerRequest: rows.map((r) => r.deletable),
          },
          null,
          2,
        ),
    );
    return;
  }

  throw new Error(`未知模式: ${mode}`);
}

main().catch((e) => {
  process.stderr.write(`[bench] 失败: ${String(e?.message ?? e)}\n`);
  process.exitCode = 1;
});
