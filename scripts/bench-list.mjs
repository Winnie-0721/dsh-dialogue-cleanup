#!/usr/bin/env node
/**
 * PERF-03 A-03：可复现的冷/热查询基准。
 *
 * 【为什么用 fake I/O 而不是真实 DSH】
 *   · 任务书 §9 禁止对真实用户会话做破坏性操作（删除），而查询路径与删除共用
 *     service，直接用真实宿主有误删风险；
 *   · 真实宿主的标题折叠是 65 ms/条（小日志）到 350 ms/条（54 MB 日志），
 *     耗时随机器与数据集剧烈波动，**无法作为可复现基准**；
 *   · 基准要能对比「优化前 / 优化后」，就必须让 I/O 成本**可控且固定**。
 * 因此这里注入固定延迟，模拟宿主的耗时特征；**结论只对「服务端逻辑开销」有效**，
 * 真实宿主上的绝对耗时另见 docs/PERF-03-REPORT.md 的实测说明。
 *
 * 用法：node scripts/bench-list.mjs [--sessions=50] [--title-ms=65] [--rounds=10]
 */
import { createService } from "../lib/service.js";
import { resolveConfig } from "../lib/config.js";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v === undefined ? true : v];
  }),
);

const N = Number(args.sessions ?? 50);
const TITLE_MS = Number(args["title-ms"] ?? 65);
const ROUNDS = Number(args.rounds ?? 10);
const CONCURRENCY = Number(args.concurrency ?? 8);
const PAGE_SIZE = Number(args["page-size"] ?? 50);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 造一个假的宿主：固定延迟模拟真实 I/O 成本。 */
function makeEnv() {
  const records = Array.from({ length: N }, (_, i) => ({
    header: {
      id: `s-${String(i).padStart(4, "0")}`,
      cwd: `E:\\proj-${i % 5}`,
      createdAt: 1700000000000 + i * 60000,
      origin: i % 7 === 0 ? "subagent" : undefined,
    },
    live: true,
    persisted: true,
  }));

  const counters = { corpus: 0, summary: 0, titleCalls: 0, titleIds: 0 };

  const sessionQuery = {
    async listSessions() {
      counters.corpus += 1;
      await sleep(8); // 读盘
      return records;
    },
    // 关键：模拟「每条标题要解压整份日志」= TITLE_MS。宿主内部是**串行**的，
    // 所以一片内的 N 条就是 N × TITLE_MS；本插件靠分片并发摊薄。
    async readTitleSnapshots(ids) {
      counters.titleCalls += 1;
      counters.titleIds += ids.length;
      await sleep(ids.length * TITLE_MS);
      return ids.map((id) => ({ sessionId: id, status: "fulfilled", value: { title: { title: `标题 ${id}` } } }));
    },
  };

  const sessionController = {
    async list() {
      counters.summary += 1;
      await sleep(100); // 宿主 RPC 底噪（历史实测约 100 ms）
      return { items: records.map((r) => ({ sessionId: r.header.id, running: false, blank: false, updatedAt: 1700000000000 })) };
    },
  };

  const services = {
    sessionQuery,
    sessionController,
    workspaceRegistry: { list: () => [] },
    agents: { get: () => undefined },
    sessions: { list: () => [] },
  };

  const perfLog = [];
  const ctx = {
    logger: {
      warn() {},
      // 【关键】捕获 PERF-03 的结构化摘要，用它把端到端耗时拆成阶段。
      // 只存解析结果，不打印原文（原文含 reqId 等噪声）。
      debug(msg) {
        const m = String(msg).match(/list (\S+) total=([\d.]+)ms sessions=([\d.]+)ms runningState=([\d.]+)ms titles=([\d.]+)ms filterSortPage=([\d.]+)ms serialize=([\d.]+)ms/);
        if (m) {
          perfLog.push({
            reqId: m[1],
            totalMs: Number(m[2]),
            sessionsMs: Number(m[3]),
            runningStateMs: Number(m[4]),
            titlesMs: Number(m[5]),
            filterSortPageMs: Number(m[6]),
            serializeMs: Number(m[7]),
          });
        }
      },
    },
    get: (k) => services[k],
  };

  // 每个场景一个**全新的** service —— 标题缓存是实例级的，新实例=冷缓存。
  const makeService = () =>
    createService(
      ctx,
      resolveConfig({
        audit: false,
        titleFetchConcurrency: CONCURRENCY,
        titleLimit: 100,
        titleSearchLimit: 40,
        titleCacheTtlMs: 300000,
      }),
      { record: async () => ({ ok: true, path: null }), enabled: false, path: null },
    );

  return { makeService, counters, records, perfLog };
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
  return {
    n: sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    max: sorted[sorted.length - 1],
    min: sorted[0],
  };
}

const fmt = (ms) => `${ms.toFixed(0)}ms`.padStart(7);

async function run() {
  console.log(`\n=== PERF-03 基准（fake I/O）===`);
  console.log(`候选会话 ${N} 条 · 标题 ${TITLE_MS} ms/条 · 并发 ${CONCURRENCY} · 每页 ${PAGE_SIZE} · 轮次 ${ROUNDS}`);
  console.log(`（I/O 延迟是注入的固定值，用于对比服务端逻辑开销；真实宿主绝对耗时见报告）\n`);

  const { makeService, counters, perfLog } = makeEnv();

  // ── 场景 0：把端到端耗时拆成阶段（A-03 的核心证据）──
  {
    const svc = makeService();
    perfLog.length = 0;
    const t0 = performance.now();
    await svc.listSessions({ pageSize: PAGE_SIZE });
    const wall = performance.now() - t0;
    const rec = perfLog.at(-1);
    console.log(`【场景 0】阶段拆解（冷缓存，首查）`);
    if (!rec) {
      console.log(`  !! 没捕获到结构化摘要（logger.debug 未接到）`);
    } else {
      const pct = (v) => `${((v / rec.totalMs) * 100).toFixed(0)}%`.padStart(5);
      console.log(`  total        ${fmt(rec.totalMs)}   (墙钟 ${wall.toFixed(0)}ms)`);
      console.log(`  ├ sessions    ${fmt(rec.sessionsMs)}  ${pct(rec.sessionsMs)}`);
      console.log(`  ├ runningState ${fmt(rec.runningStateMs)}  ${pct(rec.runningStateMs)}`);
      console.log(`  ├ titles      ${fmt(rec.titlesMs)}  ${pct(rec.titlesMs)}   ← 占比最大即为瓶颈`);
      console.log(`  ├ filterSort  ${fmt(rec.filterSortPageMs)}  ${pct(rec.filterSortPageMs)}`);
      console.log(`  └ serialize   ${fmt(rec.serializeMs)}  ${pct(rec.serializeMs)}`);
      const sum = rec.sessionsMs + rec.runningStateMs + rec.titlesMs + rec.filterSortPageMs + rec.serializeMs;
      console.log(`  分段合计 ${fmt(sum)} vs total ${fmt(rec.totalMs)}（差值=未计部分，如 archived 读取）`);
    }
  }

  // ── 场景 1：冷缓存 ──
  {
    const svc = makeService();
    const t0 = performance.now();
    const r = await svc.listSessions({ pageSize: PAGE_SIZE });
    const first = performance.now() - t0;
    // 第二次（热缓存）
    const t1 = performance.now();
    await svc.listSessions({ pageSize: PAGE_SIZE });
    const second = performance.now() - t1;
    // 连续 N 次
    const samples = [];
    for (let i = 0; i < ROUNDS; i += 1) {
      const t = performance.now();
      await svc.listSessions({ pageSize: PAGE_SIZE });
      samples.push(performance.now() - t);
    }
    const s = stats(samples);
    console.log(`【场景 1】同一实例：首查 → 热查`);
    console.log(`  首查      ${fmt(first)}`);
    console.log(`  第二查    ${fmt(second)}`);
    console.log(`  热 P50 ${fmt(s.p50)} · P95 ${fmt(s.p95)} · max ${fmt(s.max)}`);
    console.log(`  结果数 ${r.value.total} · titles=${JSON.stringify(r.value.titles)}`);
  }

  // ── 场景 2：每次都是全新实例（「首次打开插件」）──
  {
    const samples = [];
    for (let i = 0; i < ROUNDS; i += 1) {
      const svc = makeService();
      const t = performance.now();
      await svc.listSessions({ pageSize: PAGE_SIZE });
      samples.push(performance.now() - t);
    }
    const s = stats(samples);
    console.log(`\n【场景 2】每次全新实例（冷启动首查）× ${ROUNDS}`);
    console.log(`  P50 ${fmt(s.p50)} · P95 ${fmt(s.p95)} · max ${fmt(s.max)} · min ${fmt(s.min)}`);
  }

  // ── 场景 3：搜索（走 titleSearchLimit 预算）──
  {
    const svc = makeService();
    const t0 = performance.now();
    const r = await svc.listSessions({ query: "标题", pageSize: PAGE_SIZE });
    const cold = performance.now() - t0;
    const t1 = performance.now();
    await svc.listSessions({ query: "标题", pageSize: PAGE_SIZE });
    const hot = performance.now() - t1;
    console.log(`\n【场景 3】搜索（titleSearchLimit=40）`);
    console.log(`  冷查 ${fmt(cold)} · 热查 ${fmt(hot)}`);
    console.log(`  结果数 ${r.value.total} · titles=${JSON.stringify(r.value.titles)}`);
  }

  // ── 场景 4：并发 8 个查询（同一实例，冷缓存）──
  {
    const svc = makeService();
    const before = { ...counters };
    const t0 = performance.now();
    const rs = await Promise.all(Array.from({ length: 8 }, () => svc.listSessions({ pageSize: PAGE_SIZE })));
    const elapsed = performance.now() - t0;
    const after = counters;
    console.log(`\n【场景 4】8 并发查询（冷缓存）`);
    console.log(`  总耗时 ${fmt(elapsed)} · 全部结果一致: ${rs.every((r) => r.value.total === rs[0].value.total)}`);
    console.log(
      `  I/O 增量：corpus +${after.corpus - before.corpus} · summary +${after.summary - before.summary} · ` +
        `titleCalls +${after.titleCalls - before.titleCalls}（读 ${after.titleIds - before.titleIds} 条标题）`,
    );
  }

  // ── 场景 5：异常降级（每种失败都必须可判别，不得静默当成「没有会话」）──
  {
    const records = Array.from({ length: 10 }, (_, i) => ({
      header: { id: `x-${i}`, cwd: "E:\\p", createdAt: 1 },
    }));
    const cases = [
      ["语料抛错", { corpusThrows: true }],
      ["摘要抛错", { summaryThrows: true }],
      ["标题抛错", { titleThrows: true }],
    ];
    console.log(`\n【场景 5】异常降级`);
    for (const [label, flags] of cases) {
      const services = {
        sessionQuery: {
          listSessions: async () => {
            if (flags.corpusThrows) throw new Error("corpus down");
            return records;
          },
          readTitleSnapshots: async (ids) => {
            if (flags.titleThrows) throw new Error("title down");
            return ids.map((id) => ({ sessionId: id, status: "fulfilled", value: { title: { title: `t-${id}` } } }));
          },
        },
        sessionController: {
          list: async () => {
            if (flags.summaryThrows) throw new Error("summary down");
            return { items: records.map((r) => ({ sessionId: r.header.id, running: false })) };
          },
        },
        workspaceRegistry: { list: () => [] },
        agents: { get: () => undefined },
        sessions: { list: () => [] },
      };
      const ctx2 = { logger: { warn() {}, debug() {} }, get: (k) => services[k] };
      const svc2 = createService(ctx2, resolveConfig({ audit: false }), {
        record: async () => ({ ok: true, path: null }),
        enabled: false,
        path: null,
      });
      try {
        const r = await svc2.listSessions({ pageSize: 10 });
        if (r.ok !== true) {
          console.log(`  ${label.padEnd(10)} 返回错误 ${r.error.code}`);
          continue;
        }
        const v = r.value;
        const t = v.titles;
        // 语料失败 → 落到 sessionController 摘要，仍有行（sources.corpus 应为 none）
        // 摘要失败 → 语料仍在，running 不可知（sources.summary 应为 none）
        // 标题失败 → 行仍在，titles.failed > 0（不得静默变成「没标题」）
        console.log(
          `  ${label.padEnd(10)} rows=${String(v.total).padEnd(3)} ` +
            `sources=${v.sources.corpus}/${v.sources.summary} ` +
            `titleFailed=${t.failed} titleFetched=${t.fetched}`,
        );
      } catch (e) {
        console.log(`  ${label.padEnd(10)} !! 抛错: ${String(e?.message).slice(0, 60)}`);
      }
    }
  }

  console.log("");
}

await run();
