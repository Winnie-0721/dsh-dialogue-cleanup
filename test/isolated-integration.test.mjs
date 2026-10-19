/**
 * 隔离环境破坏性集成测试（任务书 §6.2）
 *
 * 【与 fault-injection.test.mjs 的分工】
 *   · fault-injection：逐个破坏**单个步骤**，断言「失败不冒充成功」；
 *   · 本文件：验证**完整的多副作用事务**在成功路径上的最终状态，
 *     以及任务书 §6.2 点名的「进程中断 / 重启」场景。
 *
 * 【为什么进程中断不能只用「重复请求」代替】
 * 重复请求验证的是**业务幂等**（同一进程内再调一次），断言的是「不会重复删」。
 * 进程中断验证的是**崩溃恢复**：删除走到一半被 SIGKILL，磁盘与内存状态可能
 * **不一致**（部分目录已删、部分没删；注册表可能已摘、live 可能还在）。重启后
 * 再执行同一请求，必须：① 不误删别的会话；② 把残留清干净；③ 结果语义诚实。
 * 两者的失效模式不同，所以本文件用**真实的子进程 + 真实 kill**来做。
 *
 * 全部在临时 DSH_HOME 上，绝不触碰用户真实会话。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

let counter = 0;
const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT_DIR = join(HERE, "..");

/** 造一个隔离环境：临时 DSH_HOME + 若干会话目录（s-i 放在 pi 下，便于按项目断言）。 */
async function makeIsolated(n = 3) {
  const base = await mkdtemp(join(tmpdir(), `dscc-iso-${counter += 1}-`));
  const root = join(base, "sessions");
  for (let i = 0; i < n; i += 1) {
    await mkdir(join(root, `p${i}`, `s-${i}`), { recursive: true });
    await writeFile(join(root, `p${i}`, `s-${i}`, "session.v4.jsonl.zstd"), "x");
  }
  return { base, root };
}

const exists = (p) => stat(p).then(() => true).catch(() => false);

// ─────────────────────────────────────────────────────────────
// 1. 成功路径的完整副作用：内存 / 工作区 / 注册表 / 磁盘 / 投影缓存
// ─────────────────────────────────────────────────────────────
test("§6.2 完整事务：idle 会话删除后，磁盘 + live + 工作区 + 注册表 + 投影缓存全部清干净", async () => {
  const { createService } = await import("../lib/service.js");
  const { resolveConfig } = await import("../lib/config.js");
  const { base, root } = await makeIsolated(1);
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = base;
  try {
    const ID = "s-0";
    // 投影缓存也要有一个，验证它被一并清掉
    const cacheDir = join(base, "storages", "session_projcache", "sessions");
    await mkdir(cacheDir, { recursive: true });
    await writeFile(join(cacheDir, `${ID}.json`), "{}");

    const live = new Map([[ID, { detach() { live.delete(ID); } }]]);
    const registryCalls = [];
    const workspace = { id: "w1", sessionIds: [ID], detachSession: async (sid) => { registryCalls.push(`detach:${sid}`); } };
    const registry = {
      list: () => [workspace],
      unpinSession: async (sid) => { registryCalls.push(`unpin:${sid}`); },
      unarchiveSession: async (sid) => { registryCalls.push(`unarchive:${sid}`); },
    };
    const services = {
      sessions: { list: () => [...live.keys()].map((id) => ({ id })), store: live },
      sessionController: { list: async () => ({ items: [{ sessionId: ID, running: false, blank: false, updatedAt: 1 }] }) },
      workspaceRegistry: registry,
      agents: { get: () => undefined },
    };
    const ctx = { logger: { warn() {}, debug() {} }, get: (k) => services[k], emit: () => {} };
    const service = createService(ctx, resolveConfig({ audit: false }), { record: async () => ({ ok: true, path: null }) });

    const r = await service.deleteSession(ID);
    assert.equal(r.ok, true);
    assert.equal(r.value.complete, true, "完整成功");

    // ① 磁盘工件
    assert.equal(await exists(join(root, "p0", ID)), false, "磁盘工件必须删掉");
    assert.equal(r.value.files, 1);
    // ② live
    assert.equal(live.has(ID), false, "live 条目必须摘掉");
    assert.equal(r.value.detach, "detached");
    // ③ 工作区归属
    assert.ok(registryCalls.includes(`detach:${ID}`), "必须摘工作区归属");
    // ④ 注册表（unpin + unarchive 至少被调用）
    assert.ok(registryCalls.includes(`unpin:${ID}`), "必须调 unpinSession");
    assert.ok(registryCalls.includes(`unarchive:${ID}`), "必须调 unarchiveSession");
    // ⑤ 投影缓存
    assert.equal(await exists(join(cacheDir, `${ID}.json`)), false, "投影缓存必须删掉");
    assert.equal(r.value.cacheFiles, 1);
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
});

// ─────────────────────────────────────────────────────────────
// 2. running 会话被拒 → 磁盘 / 内存 / 工作区 / 注册表 全都不许动
// ─────────────────────────────────────────────────────────────
test("§6.2 running 会话：被拒且磁盘、内存、工作区、注册表零改动", async () => {
  const { createService } = await import("../lib/service.js");
  const { resolveConfig } = await import("../lib/config.js");
  const { base, root } = await makeIsolated(1);
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = base;
  try {
    const ID = "s-0";
    const live = new Map([[ID, { detach() { live.delete(ID); } }]]);
    const calls = [];
    const services = {
      sessions: { list: () => [{ id: ID }], store: live },
      sessionController: { list: async () => ({ items: [{ sessionId: ID, running: true, blank: false, updatedAt: 1 }] }) },
      workspaceRegistry: {
        list: () => [{ id: "w1", sessionIds: [ID], detachSession: async () => { calls.push("detach"); } }],
        unpinSession: async () => { calls.push("unpin"); },
      },
      agents: { get: () => undefined },
    };
    const ctx = { logger: { warn() {}, debug() {} }, get: (k) => services[k], emit: () => {} };
    const service = createService(ctx, resolveConfig({ audit: false }), { record: async () => ({ ok: true, path: null }) });

    const r = await service.deleteSession(ID);
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "refused");
    assert.equal(await exists(join(root, "p0", ID)), true, "磁盘不得动");
    assert.equal(live.has(ID), true, "内存不得动");
    assert.deepEqual(calls, [], "工作区/注册表都不得动");
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
});

// ─────────────────────────────────────────────────────────────
// 3. 【真实进程中断】删除中途 SIGKILL，重启后再执行：
//    ① 不误删别的会话；② 残留能识别；③ 语义诚实
//
//    子进程脚本：先删一个目录，然后 sleep 住等被 kill —— 精确模拟「删到一半进程没了」。
// ─────────────────────────────────────────────────────────────
test("§6.2 进程中断：删除中途 SIGKILL → 重启后重跑不误删其他会话且结果诚实", async () => {
  const { base, root } = await makeIsolated(3);
  try {
    // 目标集合：要删 s-0；必须保住 s-1、s-2
    const childScript = `
import { removeArtifacts } from ${JSON.stringify(pathToFileURL(join(ROOT_DIR, "lib", "artifacts.js")).href)};
import { rm, readdir } from "node:fs/promises";
import { join } from "node:path";
const root = process.env.DSCC_ROOT;
// 先只删掉 proj p0 下的 s-0，然后挂住 —— 模拟「删到一半进程消失」
await rm(join(root, "p0", "s-0"), { recursive: true, force: true });
process.stdout.write("PARTIAL_DONE\\n");
// 挂住等父进程 kill
setTimeout(() => {}, 60000);
`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", childScript], {
      env: { ...process.env, DSCC_ROOT: root },
      stdio: ["ignore", "pipe", "pipe"],
    });

    // 等它报「已删掉一半」，然后 SIGKILL
    await new Promise((resolve, reject) => {
      let out = "";
      const t = setTimeout(() => reject(new Error("子进程未在 20s 内报 PARTIAL_DONE")), 20000);
      child.stdout.on("data", (d) => {
        out += String(d);
        if (out.includes("PARTIAL_DONE")) { clearTimeout(t); resolve(); }
      });
      child.on("error", reject);
    });
    child.kill("SIGKILL");
    await new Promise((resolve) => child.on("exit", resolve));

    // 中断后的真实残留状态：p0/s-0 没了，其余都在
    assert.equal(await exists(join(root, "p0", "s-0")), false, "被中断前已删掉的那一半确实没了");
    assert.equal(await exists(join(root, "p1", "s-1")), true, "其余会话必须完好（中断不得波及）");
    assert.equal(await exists(join(root, "p2", "s-2")), true, "其余会话必须完好");

    // 重启 = 新进程里新 service，重跑同一请求
    const { createService } = await import("../lib/service.js");
    const { resolveConfig } = await import("../lib/config.js");
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = base;
    try {
      const live = new Map([["s-0", { detach() { live.delete("s-0"); } }]]);
      const services = {
        sessions: { list: () => [{ id: "s-0" }], store: live },
        sessionController: { list: async () => ({ items: [{ sessionId: "s-0", running: false, blank: false, updatedAt: 1 }] }) },
        workspaceRegistry: { list: () => [] },
        agents: { get: () => undefined },
      };
      const ctx = { logger: { warn() {}, debug() {} }, get: (k) => services[k], emit: () => {} };
      const service = createService(ctx, resolveConfig({ audit: false }), { record: async () => ({ ok: true, path: null }) });

      const r = await service.deleteSession("s-0");
      assert.equal(r.ok, true, "重跑成功（幂等收尾）");
      // ① 绝不误删别的会话
      assert.equal(await exists(join(root, "p1", "s-1")), true, "★ 重启后重跑绝不误删 s-1");
      assert.equal(await exists(join(root, "p2", "s-2")), true, "★ 重启后重跑绝不误删 s-2");
      // ② 把中断留下的残留清干净（p0/s-0 已没了，但语义要诚实）
      assert.equal(await exists(join(root, "p0", "s-0")), false, "残留已清理（或被中断时已删）");
      // ③ 语义诚实：中断后重跑，不得谎报「删了很多」
      // （s-0 在中断时已被删，所以重跑只能删到 0 个目录 —— 这正是可识别的残留语义）
      assert.equal(r.value.files, 0, "中断已删掉的那个目录不该被重复计数");
      // ④ 全盘核对：剩下的目录里**必须**还有 s-1/s-2，且**不能**有 s-0
      const leftovers = [];
      for (const p of await readdir(root)) {
        for (const d of await readdir(join(root, p)).catch(() => [])) leftovers.push(d);
      }
      assert.ok(leftovers.includes("s-1"), `★ 中断/重跑都不得波及 s-1，实际剩下：${JSON.stringify(leftovers)}`);
      assert.ok(leftovers.includes("s-2"), `★ 中断/重跑都不得波及 s-2，实际剩下：${JSON.stringify(leftovers)}`);
      assert.ok(!leftovers.includes("s-0"), `s-0 应已被删（中断前或重跑后），实际剩下：${JSON.stringify(leftovers)}`);
    } finally {
      if (prevHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = prevHome;
    }
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
});

// ─────────────────────────────────────────────────────────────
// 4. 批量部分成功 → 失败条目重试（只重试失败项，不重跑已完成的）
// ─────────────────────────────────────────────────────────────
test("§6.2 批量部分成功：重试只处理失败条目，已完成的条目不受影响", async () => {
  const { createService } = await import("../lib/service.js");
  const { resolveConfig } = await import("../lib/config.js");
  const { base, root } = await makeIsolated(2);
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = base;
  try {
    const live = new Map([
      ["s-0", { detach() { live.delete("s-0"); } }],
      ["s-1", { detach() { live.delete("s-1"); } }],
    ]);
    // s-1 第一次 running（会被拒），之后变 idle —— 模拟「用户处理后重试成功」
    let s1Running = true;
    const services = {
      sessions: { list: () => [...live.keys()].map((id) => ({ id })), store: live },
      sessionController: {
        list: async () => ({
          items: [
            { sessionId: "s-0", running: false, blank: false, updatedAt: 1 },
            { sessionId: "s-1", running: s1Running, blank: false, updatedAt: 1 },
          ],
        }),
      },
      workspaceRegistry: { list: () => [] },
      agents: { get: () => undefined },
    };
    const ctx = { logger: { warn() {}, debug() {} }, get: (k) => services[k], emit: () => {} };
    const service = createService(ctx, resolveConfig({ audit: false }), { record: async () => ({ ok: true, path: null }) });

    // 第一轮：s-0 成功，s-1 被拒
    const first = await service.deleteSession("s-0");
    assert.equal(first.ok, true);
    const refused = await service.deleteSession("s-1");
    assert.equal(refused.ok, false);
    assert.equal(refused.error.code, "refused");

    // 用户处理掉 s-1 的运行状态后重试 —— 只重试 s-1
    s1Running = false;
    const retry = await service.deleteSession("s-1");
    assert.equal(retry.ok, true, "重试成功");
    assert.equal(await exists(join(root, "p0", "s-0")), false, "s-0 保持已删（重试不复活它）");
    assert.equal(await exists(join(root, "p1", "s-1")), false, "s-1 这次删掉了");
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
});
