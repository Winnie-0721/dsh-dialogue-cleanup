/**
 * 删除事务边界测试（TASK-POST-1.1.2 任务二）
 *
 * 目的不是「再加一批 happy path」，而是把**事务与并发的交界处**钉住：
 *   1. 标题读取还在等待时删除同一条会话 —— /list 必须有明确结论（不挂起、不抛错、
 *      不留幽灵行），且事务开始前已发出的请求按它自己的快照作答；
 *   2. 批量删除中一条失败 —— 其余条目结论、总数、重试清单必须可信；
 *   3. 删除已落地、审计写入还在途 / 审计失败 —— 会话不得「复活」成幽灵行；
 *   4. 投影缓存删除成功或失败 —— 都不影响主结论。
 *
 * 全部用隔离 DSH_HOME + fake 宿主服务，不依赖真实机器状态，不做真实删除。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createService, __resetInFlight } from "../lib/service.js";
import { resolveConfig } from "../lib/config.js";
import { projectionCacheRoot } from "../lib/artifacts.js";

let counter = 0;

const auditOff = { record: async () => ({ ok: true, path: null }), enabled: false, path: null };

/** 造一个隔离的 DSH_HOME + service。 */
async function makeEnv({ services = {}, config = {}, audit = auditOff, emit = () => {} } = {}) {
  __resetInFlight();
  const base = await mkdtemp(join(tmpdir(), `dscc-tx-${(counter += 1)}-`));
  const root = join(base, "sessions");
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = base;
  const live = new Map();
  const full = {
    sessions: { list: () => [...live.keys()].map((id) => ({ id })), store: live },
    sessionController: { list: async () => ({ items: [] }) },
    workspaceRegistry: { list: () => [], detachSession: () => {} },
    agents: { get: () => undefined },
    ...services,
  };
  const ctx = { logger: { warn() {}, debug() {} }, get: (k) => full[k], emit };
  const service = createService(ctx, resolveConfig({ audit: false, ...config }), audit);
  return {
    service,
    root,
    base,
    live,
    ctx,
    restore: async () => {
      if (prevHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = prevHome;
      await rm(base, { recursive: true, force: true }).catch(() => {});
    },
  };
}

async function seedSession(root, sessionId, proj = "projA") {
  await mkdir(join(root, proj, sessionId), { recursive: true });
  await writeFile(join(root, proj, sessionId, "session.v4.jsonl.zstd"), "x");
}

async function seedProjectionCache(sessionId) {
  const dir = projectionCacheRoot();
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${sessionId}.json`);
  await writeFile(file, JSON.stringify({ version: 7, record: { identity: {}, rows: {} } }));
  return file;
}

function titleReply(ids, title = "T") {
  return ids.map((id) => ({ sessionId: id, status: "fulfilled", value: { title: { title } } }));
}

// ─────────────────────────────────────────────────────────────
// 1. 标题读取仍在等待时删除 → /list 有明确结论
// ─────────────────────────────────────────────────────────────
test("事务边界：标题读取在途时删除同一条会话 —— 列表不挂起、不抛错，且后续请求无幽灵行", async () => {
  const corpus = [
    { header: { id: "s1", cwd: "E:\\p" }, live: true, persisted: true },
    { header: { id: "s2", cwd: "E:\\p" }, live: true, persisted: true },
  ];
  let releaseTitles;
  let titleCallStarted = false;
  const titlesGate = new Promise((resolve) => {
    releaseTitles = resolve;
  });
  const sessionsQuery = {
    listSessions: async () => corpus.map((r) => ({ ...r })),
    readTitleSnapshots: async (ids) => {
      titleCallStarted = true;
      await titlesGate; // 卡住，模拟真实宿主解压日志的耗时
      return titleReply(ids);
    },
  };
  const env = await makeEnv({ services: { sessionQuery: sessionsQuery } });
  try {
    env.live.set("s1", { detach: () => env.live.delete("s1") });
    env.live.set("s2", { detach: () => env.live.delete("s2") });
    await seedSession(env.root, "s1");
    await seedSession(env.root, "s2");

    // 事务开始前发出 /list，让它卡在标题读取上
    const inFlightList = env.service.listSessions({ pageSize: 10 });
    for (let i = 0; i < 500 && !titleCallStarted; i += 1) await new Promise((r) => setTimeout(r, 2));
    assert.equal(titleCallStarted, true, "前提：/list 必须已经进入标题读取阶段");

    // 此时删除 s1
    const del = await env.service.deleteSession("s1");
    assert.equal(del.ok, true);
    assert.equal(del.value.files, 1, "前提：s1 的磁盘工件确实被删掉了");

    // 宿主语料也同步丢掉它（真实环境里磁盘没了，listSessions 就不再返回）
    const idx = corpus.findIndex((r) => r.header.id === "s1");
    corpus.splice(idx, 1);

    // 迟到的标题结果现在才回来
    releaseTitles();

    // ① 在途请求必须**有结论**（不能挂起、不能抛错、不能变成 5xx）
    const r1 = await inFlightList;
    assert.equal(r1.ok, true, "在途 /list 必须正常返回");
    assert.equal(r1.value.source?.corpus ?? "sessionQuery.listSessions", "sessionQuery.listSessions");
    // 它是「事务开始前的快照」：s1 仍在，且行上有标题 —— 这是诚实的历史视图，不是幽灵。
    const r1Ids = r1.value.items.map((i) => i.sessionId).sort();
    assert.deepEqual(r1Ids, ["s1", "s2"], "在途请求按自己的快照作答，两条都在");
    assert.equal(
      r1.value.items.find((i) => i.sessionId === "s1").title,
      "T",
      "在途请求拿到的标题照常填上（不因为该行已被删就把它当失败）",
    );

    // ② 之后的新请求不得再有幽灵行
    const r2 = await env.service.listSessions({ pageSize: 10 });
    assert.deepEqual(r2.value.items.map((i) => i.sessionId), ["s2"], "删除后新请求不得再列出 s1");

    // ③ 再刷两次也不会「复活」（迟到标题不得把 id 写回任何可观测状态）
    const r3 = await env.service.listSessions({ pageSize: 10 });
    const r4 = await env.service.listSessions({ pageSize: 10 });
    assert.equal(r3.value.total, 1);
    assert.equal(r4.value.total, 1);
    assert.equal(
      r2.value.titles?.fetched ?? 0,
      0,
      "删除后新请求不需要为已删会话付标题读取成本（缓存已被清）",
    );
  } finally {
    await env.restore();
  }
});

// ─────────────────────────────────────────────────────────────
// 2. 批量删除中一条失败 → 其余结论、总数、重试清单可信
// ─────────────────────────────────────────────────────────────
test("事务边界：批量里一条被拒 + 一条非法 id —— 其余照删，总数与重试清单可信", async () => {
  const env = await makeEnv({
    services: {
      sessionController: {
        list: async () => ({
          items: [
            { sessionId: "b1", running: false, blank: false, updatedAt: 1 },
            { sessionId: "b2", running: true, blank: false, updatedAt: 1 },
            { sessionId: "b3", running: false, blank: false, updatedAt: 1 },
          ],
        }),
      },
    },
  });
  try {
    for (const id of ["b1", "b2", "b3"]) {
      env.live.set(id, { detach: () => env.live.delete(id) });
      await seedSession(env.root, id);
    }

    const results = new Map();
    const batch = ["b1", "b2", "b3", "bad id!", "b1"]; // 含重复项
    // 逐条走 service（与 HTTP 批量路径同一实现），批量聚合逻辑见下
    const outcomes = [];
    const seen = new Set();
    const unique = [];
    for (const id of batch) {
      if (typeof id !== "string") { unique.push(id); continue; }
      if (seen.has(id)) continue;
      seen.add(id);
      unique.push(id);
    }
    const batchSnapshot = await env.service.freshRunningSnapshotForBatch();
    for (const id of unique) {
      const r = await env.service.deleteSession(id, { kind: "test" }, { runningSnapshot: batchSnapshot });
      outcomes.push({ id, r });
      results.set(id, r);
    }

    assert.equal(batch.length, 5);
    assert.equal(unique.length, 4, "重复 id 必须去重（5 -> 4）");
    assert.equal(batch.length - unique.length, 1, "重复数必须如实报出");

    assert.equal(results.get("b1").ok, true, "b1 正常删除");
    assert.equal(results.get("b3").ok, true, "b3 正常删除");
    assert.equal(results.get("b2").ok, false, "b2 运行中必须被拒");
    assert.equal(results.get("b2").error.code, "refused");
    assert.equal(results.get("bad id!").ok, false, "非法 id 必须 400 类错误");
    assert.equal(results.get("bad id!").error.code, "bad-request");

    // 其余条目不受影响：真的删掉了，而不是被整批回滚
    assert.equal(results.get("b1").value.files, 1);
    assert.equal(results.get("b3").value.files, 1);
    assert.deepEqual([...env.live.keys()].sort(), ["b2"], "只有被拒的那条还留在内存里");

    // 重试清单口径：失败条目里 bad-request 不该重试（重试也不会成功），refused 可以
    const retryable = outcomes
      .filter((o) => o.r.ok !== true)
      .filter((o) => o.r.error.code !== "bad-request")
      .map((o) => o.id);
    assert.deepEqual(retryable, ["b2"], "重试清单只应包含可重试的失败条目");

    // 「其余结论」的第二次验证：单独重试 b2 仍然 refused，且不产生副作用
    const again = await env.service.deleteSession("b2", { kind: "test" });
    assert.equal(again.ok, false);
    assert.equal(again.error.code, "refused");
    assert.deepEqual([...env.live.keys()].sort(), ["b2"], "重试被拒条目不得摘掉它的归属/内存");
  } finally {
    await env.restore();
  }
});

test("事务边界：批量中一条成功但有降级 —— 不得报 complete/allComplete，且必须可重试", async () => {
  // 让侧栏通知整条失败（emit 抛错）=> 每条都留下一条 announce 降级
  const env = await makeEnv({
    emit: () => {
      throw new Error("emit down");
    },
    services: {
      sessionController: {
        list: async () => ({
          items: [
            { sessionId: "d1", running: false, blank: false, updatedAt: 1 },
            { sessionId: "d2", running: false, blank: false, updatedAt: 1 },
          ],
        }),
      },
    },
  });
  try {
    for (const id of ["d1", "d2"]) {
      env.live.set(id, { detach: () => env.live.delete(id) });
      await seedSession(env.root, id);
    }
    const snapshot = await env.service.freshRunningSnapshotForBatch();
    const rows = [];
    for (const id of ["d1", "d2"]) {
      rows.push(await env.service.deleteSession(id, { kind: "test" }, { runningSnapshot: snapshot }));
    }
    for (const r of rows) {
      assert.equal(r.ok, true, "删除本身仍成功");
      assert.equal(r.value.complete, false, "有降级就不能报完整成功");
      assert.equal(r.value.partial, true);
      assert.ok(
        r.value.degradations.some((d) => d.step === "announce"),
        "降级原因必须写明是 announce",
      );
      assert.ok(r.value.files >= 1, "降级不影响磁盘删除这一步本身");
    }
  } finally {
    await env.restore();
  }
});

// ─────────────────────────────────────────────────────────────
// 3. 删除已落地、审计在途 / 审计失败 → 不得复活
// ─────────────────────────────────────────────────────────────
test("事务边界：审计写入还在途时读取列表 —— 会话已经算删掉了，不得复活", async () => {
  let releaseAudit;
  const auditGate = new Promise((resolve) => {
    releaseAudit = resolve;
  });
  let auditStarted = false;
  const audit = {
    enabled: true,
    path: null,
    record: async () => {
      auditStarted = true;
      await auditGate;
      return { ok: true, path: "/tmp/audit.jsonl" };
    },
  };
  const corpus = [{ header: { id: "a1", cwd: "E:\\p" }, live: true, persisted: true }];
  const env = await makeEnv({
    audit,
    services: {
      sessionQuery: {
        listSessions: async () => corpus.map((r) => ({ ...r })),
        readTitleSnapshots: async (ids) => titleReply(ids),
      },
    },
  });
  try {
    env.live.set("a1", { detach: () => env.live.delete("a1") });
    await seedSession(env.root, "a1");

    const pendingDelete = env.service.deleteSession("a1");
    for (let i = 0; i < 500 && !auditStarted; i += 1) await new Promise((r) => setTimeout(r, 2));
    assert.equal(auditStarted, true, "前提：事务已走到审计写入这一步");

    // 审计还没写完，但破坏性步骤已经全部完成 —— 列表必须已经看不到它
    assert.equal(env.live.has("a1"), false, "内存条目已摘");
    corpus.splice(0, 1);
    const during = await env.service.listSessions({ pageSize: 10 });
    assert.equal(during.value.total, 0, "审计在途期间，列表不得再列出该会话（不复活）");

    releaseAudit();
    const done = await pendingDelete;
    assert.equal(done.ok, true);
    assert.equal(done.value.complete, true, "审计成功则整笔完整成功");
    assert.equal(done.value.audit.ok, true);
  } finally {
    await env.restore();
  }
});

test("事务边界：审计写入失败 —— 删除仍然成立，但必须如实降级且不得复活", async () => {
  const audit = {
    enabled: true,
    path: null,
    record: async () => ({ ok: false, path: null, error: "disk full" }),
  };
  const corpus = [{ header: { id: "a2", cwd: "E:\\p" }, live: true, persisted: true }];
  const env = await makeEnv({
    audit,
    services: {
      sessionQuery: {
        listSessions: async () => corpus.map((r) => ({ ...r })),
        readTitleSnapshots: async (ids) => titleReply(ids),
      },
    },
  });
  try {
    env.live.set("a2", { detach: () => env.live.delete("a2") });
    await seedSession(env.root, "a2");
    const r = await env.service.deleteSession("a2");
    assert.equal(r.ok, true, "审计失败不影响删除本身（幂等语义）");
    assert.equal(r.value.files, 1, "磁盘确实删了");
    assert.equal(r.value.complete, false, "但绝不报完整成功");
    assert.equal(r.value.partial, true);
    assert.ok(r.value.degradations.some((d) => d.step === "audit"), "降级必须写明是 audit");
    assert.equal(r.value.audit.ok, false, "审计结果必须如实带出");

    corpus.splice(0, 1);
    const list = await env.service.listSessions({ pageSize: 10 });
    assert.equal(list.value.total, 0, "审计失败不得让会话复活");
  } finally {
    await env.restore();
  }
});

// ─────────────────────────────────────────────────────────────
// 4. 投影缓存删除成功 / 失败都不影响主结论
// ─────────────────────────────────────────────────────────────
test("事务边界：投影缓存删除成功 —— 计入 cacheFiles，主结论仍为完整成功", async () => {
  const corpus = [{ header: { id: "c1", cwd: "E:\\p" }, live: true, persisted: true }];
  const env = await makeEnv({
    config: { removeProjectionCache: true },
    services: {
      sessionQuery: {
        listSessions: async () => corpus.map((r) => ({ ...r })),
        readTitleSnapshots: async (ids) => titleReply(ids),
      },
    },
  });
  try {
    env.live.set("c1", { detach: () => env.live.delete("c1") });
    await seedSession(env.root, "c1");
    const cacheFile = await seedProjectionCache("c1");

    const r = await env.service.deleteSession("c1");
    assert.equal(r.ok, true);
    assert.equal(r.value.files, 1);
    assert.equal(r.value.cacheFiles, 1, "投影缓存文件必须被计入并删掉");
    assert.equal(r.value.complete, true, "缓存删除成功不引入降级");
    await assert.rejects(() => readFile(cacheFile), "缓存文件必须真的不在了");
  } finally {
    await env.restore();
  }
});

test("事务边界：投影缓存条目是符号链接 —— fail-closed 不删、记入 skipped、主结论不变", async () => {
  const corpus = [{ header: { id: "c2", cwd: "E:\\p" }, live: true, persisted: true }];
  const env = await makeEnv({
    config: { removeProjectionCache: true },
    services: {
      sessionQuery: {
        listSessions: async () => corpus.map((r) => ({ ...r })),
        readTitleSnapshots: async (ids) => titleReply(ids),
      },
    },
  });
  try {
    env.live.set("c2", { detach: () => env.live.delete("c2") });
    await seedSession(env.root, "c2");

    // 缓存条目被换成指向外部的符号链接：**必须拒绝跟随**（否则就是一条越界删除通道）。
    const dir = projectionCacheRoot();
    const outside = join(env.base, "outside-target.json");
    await writeFile(outside, JSON.stringify({ version: 7, record: {} }));
    await mkdir(dir, { recursive: true });
    await symlink(outside, join(dir, "c2.json"), "file");

    const r = await env.service.deleteSession("c2");
    assert.equal(r.ok, true, "缓存的安全阀拒绝不能让删除请求整体失败");
    assert.equal(r.value.files, 1, "磁盘工件照删（主结论不变）");
    assert.equal(r.value.cacheFiles, 0, "符号链接不得被当作缓存文件删除");
    assert.ok(
      (r.value.skippedDetails ?? []).some(
        (d) => String(d.path).endsWith("c2.json") && d.reason === "candidate-is-link-or-not-file",
      ),
      "被安全阀跳过的条目必须记入 skippedDetails 且原因明确（可诊断，不是静默吞掉）",
    );
    // 目标文件必须原样保留 —— 这就是 fail-closed 的意义。
    assert.equal(JSON.parse(await readFile(outside, "utf8")).version, 7, "链接目标不得被删");

    corpus.splice(0, 1);
    const list = await env.service.listSessions({ pageSize: 10 });
    assert.equal(list.value.total, 0, "缓存残留不得让会话仍出现在列表里");
  } finally {
    await env.restore();
  }
});

test("事务边界：投影缓存根路径异常 —— 视为「没有缓存」，不得抛错也不得伪造降级", async () => {
  const corpus = [{ header: { id: "c3", cwd: "E:\\p" }, live: true, persisted: true }];
  const env = await makeEnv({
    config: { removeProjectionCache: true },
    services: {
      sessionQuery: {
        listSessions: async () => corpus.map((r) => ({ ...r })),
        readTitleSnapshots: async (ids) => titleReply(ids),
      },
    },
  });
  try {
    env.live.set("c3", { detach: () => env.live.delete("c3") });
    await seedSession(env.root, "c3");
    // 根目录位置上放一个**普通文件**：查不到 c3.json（ENOENT/ENOTDIR 都归档为「没有这个条目」）。
    const dir = projectionCacheRoot();
    await mkdir(join(dir, ".."), { recursive: true });
    await writeFile(dir, "not a directory");

    const r = await env.service.deleteSession("c3");
    assert.equal(r.ok, true, "缓存根不可用绝不能把删除请求打成失败");
    assert.equal(r.value.files, 1, "磁盘工件照删");
    assert.equal(r.value.cacheFiles, 0, "没有可删的缓存条目");
    assert.equal(
      r.value.complete,
      true,
      "「本来就没有缓存条目」不是降级（与 ENOENT 的语义一致，不能把 absent 报成 failed）",
    );

    corpus.splice(0, 1);
    const list = await env.service.listSessions({ pageSize: 10 });
    assert.equal(list.value.total, 0, "主结论不受缓存路径异常影响");
  } finally {
    await env.restore();
  }
});
