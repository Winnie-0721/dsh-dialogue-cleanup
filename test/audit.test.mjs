/**
 * 审计留痕（lib/audit.js + lib/config.js 的审计容量键）测试。
 *
 * 【这个套件要钉住的三件事】
 *   1. **字段最小化**：不写整份 runtime / 标题 / 全量 removedPaths。现网实测
 *      38 行 33.8 KB ≈ 910 B/行就是被这些字段撑出来的 —— 那是备份删除结果，不是留痕。
 *   2. **轮转与降级**：按文件大小轮转、旧内容一字不丢；轮转**失败**要返回可诊断结果
 *      （rotated/rotateError），仍然把这一行写进去，且绝不让删除事务失败。
 *   3. **路径校验**：越出 DSH_HOME 的配置被**拒绝**，而不是静默写到别处。
 *
 * 每条失败注入都配一条反向断言：正常成功路径不得误报降级（否则「降级」标志会变成狼来了）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAudit, defaultAuditPath, resolveAuditPath, DEFAULT_MAX_BYTES, DEFAULT_ROTATE_KEEP } from "../lib/audit.js";
import { DEFAULTS, Config, resolveConfig } from "../lib/config.js";

/** 造一个隔离的 DSH_HOME。返回 {home, base, restore}。 */
async function withHome(fn) {
  const base = await mkdtemp(join(tmpdir(), "dscc-audit-"));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = base;
  try {
    return await fn({ home: base, base });
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
}

const readLines = async (path) =>
  (await readFile(path, "utf8"))
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l));

/** 一条「肥」的记录，形状对齐 service.js 实际会传的东西。 */
function fatEntry(overrides = {}) {
  return {
    actor: { kind: "user", id: "u-1", request: { headers: { cookie: "x".repeat(80) } } },
    sessionId: "s1",
    result: {
      ok: true,
      files: 3,
      cacheFiles: 1,
      removedPaths: Array.from({ length: 200 }, (_, i) => `E:/very/long/path/for/audit/${i}/session.v4.jsonl.zstd`),
      cachePaths: Array.from({ length: 50 }, (_, i) => `E:/cache/path/${i}.json`),
      runtime: { home: "E:/home", sessionsRoot: "E:/home/sessions", isInsideGuard: true },
      title: "很长的会话标题".repeat(20),
      tookMs: 42,
      degradations: [{ step: "announce", reason: "emit-threw", failures: ["a", "b", "c"] }],
    },
    ...overrides,
  };
}

// ───────────────────────── 正常写入 ─────────────────────────

test("正常写入：一行 JSON、可解析、含时间与结果状态", async () => {
  await withHome(async () => {
    const audit = createAudit(resolveConfig({ audit: true, auditMaxBytes: 0 }), { warn() {} });
    assert.equal(audit.enabled, true);
    assert.equal(audit.mode, "append");
    assert.equal(audit.path, defaultAuditPath());

    const r = await audit.record({ action: "delete", sessionId: "s1", result: { ok: true, files: 2, tookMs: 7 } });
    assert.equal(r.ok, true, "正常路径必须成功");
    assert.equal(r.error, undefined, "正常路径不得带 error");
    assert.equal(r.rotateError, undefined, "【反向断言】正常路径不得误报轮转降级");
    assert.equal(r.rotated, false, "【反向断言】没超阈值就不该轮转");
    assert.equal(r.path, defaultAuditPath());

    const lines = await readLines(audit.path);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].plugin, "dialogue-cleanup");
    assert.match(lines[0].time, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(lines[0].action, "delete");
    assert.equal(lines[0].sessionId, "s1");
    assert.equal(lines[0].result.ok, true);
    assert.equal(lines[0].result.files, 2);
    assert.equal(lines[0].result.tookMs, 7);
  });
});

test("字段最小化：整份 runtime / 标题 / 全量路径数组都不落盘，行宽回到几百字节", async () => {
  await withHome(async () => {
    const audit = createAudit(resolveConfig({ audit: true, auditMaxBytes: 0 }), { warn() {} });
    await audit.record(fatEntry());

    const raw = await readFile(audit.path, "utf8");
    const line = raw.trimEnd();
    const body = JSON.parse(line);

    // 明确不写的三样（这正是 910 B/行的来源）
    assert.equal(body.result.removedPaths, undefined, "不得把 200 条 removedPaths 每次都写进去");
    assert.equal(body.result.cachePaths, undefined, "不得写全量 cachePaths");
    assert.equal(body.result.runtime, undefined, "不得写整份 runtime 快照");
    assert.equal(body.result.title, undefined, "不得写会话标题");
    assert.equal(typeof body.result.files, "number", "只留计数，用于事后对账");
    assert.equal(body.result.cacheFiles, 1);
    // 降级清单只留「哪一步 + 一句原因」，failures 明细丢弃
    assert.deepEqual(body.result.degradations, [{ step: "announce", reason: "emit-threw" }]);
    // actor 是整份对象 → 截断成字符串，而不是原样展开
    assert.equal(typeof body.actor, "string");

    // 【量化】现网旧实现是 910 B/行；这条肥记录必须远低于它（实测约 300 B）。
    assert.ok(
      Buffer.byteLength(line, "utf8") < 700,
      `单行 ${Buffer.byteLength(line, "utf8")} B 仍然太肥（旧实现 910 B/行）`,
    );
    assert.ok(line.length < 4096, "单行不得接近任何 FS/日志系统的行宽上限");
  });
});

test("超长错误文案被截断，单行不会因异常文本撑爆", async () => {
  await withHome(async () => {
    const audit = createAudit(resolveConfig({ audit: true, auditMaxBytes: 0 }), { warn() {} });
    await audit.record({ action: "delete", result: { ok: false, code: "internal", error: "E".repeat(100000) } });
    const [line] = await readLines(audit.path);
    assert.ok(line.result.error.length < 400, `error 未截断：${line.result.error.length}`);
    assert.match(line.result.error, /truncated/);
  });
});

test("连续多条：追加而不是覆盖", async () => {
  await withHome(async () => {
    const audit = createAudit(resolveConfig({ audit: true, auditMaxBytes: 0 }), { warn() {} });
    for (let i = 0; i < 5; i += 1) {
      const r = await audit.record({ action: "delete", sessionId: `s${i}`, result: { ok: true, files: i } });
      assert.equal(r.ok, true);
    }
    const lines = await readLines(audit.path);
    assert.equal(lines.length, 5, "5 条记录一行一条，不能互相覆盖");
    assert.deepEqual(lines.map((l) => l.sessionId), ["s0", "s1", "s2", "s3", "s4"]);
  });
});

// ───────────────────────── 轮转 ─────────────────────────

test("超阈值轮转：旧内容整份搬进 .1，当前文件只留新行，超出保留份数的被删", async () => {
  await withHome(async () => {
    const config = resolveConfig({ audit: true, auditMaxBytes: 300, auditRotateKeep: 2 });
    const audit = createAudit(config, { warn() {} });
    assert.deepEqual(audit.rotation, { maxBytes: 300, keep: 2 });

    // 用 sessionId 记住写入顺序；reason 走白名单字段，用长度精确控制每行大小（约 130 B）。
    const payload = (i) => ({
      action: "delete",
      sessionId: `s${i}`,
      reason: `${i}:`.padEnd(120, "x"),
      result: { ok: true },
    });
    const seen = [];
    let rotations = 0;
    for (let i = 0; i < 8; i += 1) {
      const r = await audit.record(payload(i));
      assert.equal(r.ok, true);
      seen.push(i);
      if (r.rotated) rotations += 1;
      // 【反向断言】轮转本身绝不能变成降级
      assert.equal(r.rotateError, undefined, "正常轮转不得报 rotateError");
    }
    assert.ok(rotations >= 2, `300 B 阈值下 8 条记录应触发多次轮转，实际 ${rotations}`);

    const files = await readdir(join(process.env.DSH_HOME, "logs"));
    assert.ok(files.includes("dialogue-cleanup.jsonl"), "当前文件必须仍在");
    assert.ok(files.includes("dialogue-cleanup.jsonl.1"), "应保留第 1 份历史");
    assert.ok(files.includes("dialogue-cleanup.jsonl.2"), "keep=2 时应保留第 2 份历史");
    assert.ok(!files.includes("dialogue-cleanup.jsonl.3"), "keep=2 时不得留下第 3 份");

    // 轮转 = 改名，不是覆盖/截断：保留下来的记录必须是**写入序列的一个后缀**
    // （只有超出 keep 的最旧记录会被删，中间不会丢、不会乱序、不会重复）。
    const kept = [];
    for (const f of ["dialogue-cleanup.jsonl.2", "dialogue-cleanup.jsonl.1", "dialogue-cleanup.jsonl"]) {
      for (const line of await readLines(join(process.env.DSH_HOME, "logs", f))) kept.push(line.sessionId);
    }
    assert.ok(kept.length >= 1, "至少当前文件里得有内容");
    assert.deepEqual(
      kept,
      seen.slice(seen.length - kept.length).map((i) => `s${i}`),
      `保留的应是最后 ${kept.length} 条（实际 ${kept.join(",")}）`,
    );
  });
});

test("轮转不截断正在写入的日志：搬走的 .1 与轮转前的内容逐字节相同", async () => {
  await withHome(async () => {
    const config = resolveConfig({ audit: true, auditMaxBytes: 200, auditRotateKeep: 1 });
    const audit = createAudit(config, { warn() {} });
    await audit.record({ action: "delete", sessionId: "first", reason: "y".repeat(120), result: { ok: true } });
    const before = await readFile(audit.path, "utf8");
    assert.ok(before.length > 0);

    const r = await audit.record({ action: "delete", sessionId: "second", reason: "z".repeat(120), result: { ok: true } });
    assert.equal(r.rotated, true, "第二条应超过 200 B 阈值并触发轮转");

    const archived = await readFile(`${audit.path}.1`, "utf8");
    assert.equal(archived, before, "搬走的必须是完整原文，不能是截断副本");
    const now = await readLines(audit.path);
    assert.equal(now.length, 1, "当前文件里只剩新写的这一条");
    assert.equal(now[0].sessionId, "second");
  });
});

test("轮转失败：返回可诊断降级结果（rotated=false + rotateError），但这一行仍然写进去", async () => {
  await withHome(async ({ home }) => {
    const config = resolveConfig({ audit: true, auditMaxBytes: 1, auditRotateKeep: 1 });
    const audit = createAudit(config, { warn() {} });
    // 注入：保留位 .1 被一个**目录**占着 → rm(.1) 报 EISDIR → rotate() 抛错。
    await mkdir(`${audit.path}.1`, { recursive: true });
    await writeFile(join(`${audit.path}.1`, "inner.txt"), "keep me");

    const r = await audit.record({ action: "delete", sessionId: "s1", result: { ok: true } });
    assert.equal(r.ok, true, "轮转失败不得让这次写入失败 —— 日志继续长总比丢审计好");
    assert.equal(r.rotated, false);
    assert.ok(r.rotateError, "必须给出可诊断的轮转失败原因");
    assert.match(r.rotateError, /EISDIR|directory|is a directory/i);

    const lines = await readLines(audit.path);
    assert.equal(lines.length, 1, "轮转失败也要把这一行落下");
    // 轮转失败不得顺手删掉别的东西
    assert.equal((await readdir(`${audit.path}.1`)).includes("inner.txt"), true, "失败时不得删除已有内容");
  });
});

test("审计路径本身不是普通文件（是目录）：如实报错，且不去删那个目录", async () => {
  await withHome(async ({ home }) => {
    const audit = createAudit(resolveConfig({ audit: true, auditPath: join(home, "logs", "x.jsonl"), auditMaxBytes: 1 }), {
      warn() {},
    });
    await mkdir(audit.path, { recursive: true });
    await writeFile(join(audit.path, "precious.txt"), "do not delete");

    const r = await audit.record({ action: "delete", sessionId: "s1", result: { ok: true } });
    assert.equal(r.ok, false, "写不成必须如实报失败，不能假装写成功");
    assert.ok(r.error, "要带可诊断原因");
    assert.equal(r.rotated, false, "路径不是文件时绝不轮转（轮转会先删最旧一份）");
    assert.equal((await readdir(audit.path)).includes("precious.txt"), true, "不得误删该目录里的内容");
  });
});

test("并发追加安全：50 条并发写入互不交错，行行可解析", async () => {
  await withHome(async () => {
    const audit = createAudit(resolveConfig({ audit: true, auditMaxBytes: 0 }), { warn() {} });
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        audit.record({ action: "delete", sessionId: `s${i}`, result: { ok: true, files: i } }),
      ),
    );
    assert.equal(results.every((r) => r.ok === true), true, "并发写入不应有失败");
    assert.equal(results.every((r) => r.error === undefined), true, "【反向断言】并发成功不得误报 error");

    const raw = await readFile(audit.path, "utf8");
    assert.equal(raw.endsWith("\n"), true, "最后一行必须以换行收尾（否则最后一条会与下一条粘在一起）");
    const lines = raw.split("\n").filter(Boolean);
    assert.equal(lines.length, 50, `并发 50 条应落 50 行，实际 ${lines.length}`);
    const ids = new Set();
    for (const line of lines) {
      const parsed = JSON.parse(line); // 任何交错都会在这里炸
      assert.ok(parsed.sessionId && parsed.time);
      ids.add(parsed.sessionId);
    }
    assert.equal(ids.size, 50, "50 条 id 不得重复或丢失");
  });
});

// ───────────────────────── 路径不可写 / 越界 / 禁用 ─────────────────────────

test("审计路径不可写（父级是文件）→ 如实报错，不抛给调用方", async () => {
  await withHome(async ({ home }) => {
    await writeFile(join(home, "blocker"), "i am a file");
    const config = resolveConfig({ audit: true, auditPath: join(home, "blocker", "logs", "a.jsonl") });
    const audit = createAudit(config, { warn() {} });

    const r = await audit.record({ action: "delete", sessionId: "s1", result: { ok: true } });
    assert.equal(r.ok, false, "不可写必须报 ok:false（删除事务仍由 service 决定）");
    assert.match(r.error, /ENOTDIR|EEXIST|ENOENT|not a directory/i);
    assert.equal(r.skipped, undefined, "不可写不是 skipped —— 两者是不同的降级原因");
  });
});

test("路径越界：拒绝写入并如实上报，绝不写到 DSH_HOME 之外", async () => {
  await withHome(async ({ home, base }) => {
    const outside = join(base, "..", `dscc-outside-${Date.now()}`, "evil.jsonl");
    const config = resolveConfig({ audit: true, auditPath: outside });
    const audit = createAudit(config, { warn() {} });

    assert.equal(audit.mode, "invalid-path", "越界配置必须被标记为 invalid-path");
    assert.ok(audit.pathError && /escapes DSH_HOME/.test(audit.pathError));
    assert.equal(audit.path, null, "越界时对外不得给出一个「看起来能用」的路径");

    const r = await audit.record({ action: "delete", sessionId: "s1", result: { ok: true } });
    assert.equal(r.ok, false);
    assert.equal(r.mode, "invalid-path");
    assert.equal(r.skipped, undefined, "越界不是「审计关闭」，不能混为一谈");
    await assert.rejects(() => stat(outside), /ENOENT/, "DSH_HOME 之外不得出现任何文件");
    // 反向：合法路径（DSH_HOME 之内）仍然正常通过校验。
    assert.equal(resolveAuditPath(join(home, "logs", "ok.jsonl")).ok, true);
  });
});

test("禁用审计：返回 skipped，且不创建任何文件", async () => {
  await withHome(async ({ home }) => {
    const audit = createAudit(resolveConfig({ audit: false }), { warn() {} });
    assert.equal(audit.enabled, false);
    assert.equal(audit.path, null);

    const r = await audit.record({ action: "delete", sessionId: "s1", result: { ok: true } });
    assert.deepEqual(r, { ok: true, path: null, skipped: true, mode: "disabled", rotated: false });
    await assert.rejects(() => readdir(join(home, "logs")), /ENOENT/, "关闭审计时不得写任何东西");
  });
});

// ───────────────────────── 配置键（容量 + 校验） ─────────────────────────

test("配置：容量键有默认值与边界，非法值退回默认并如实报 issue", () => {
  assert.equal(DEFAULTS.auditMaxBytes, DEFAULT_MAX_BYTES);
  assert.equal(DEFAULTS.auditRotateKeep, DEFAULT_ROTATE_KEEP);

  const ok = resolveConfig({ auditMaxBytes: 1024, auditRotateKeep: 5 });
  assert.equal(ok.auditMaxBytes, 1024);
  assert.equal(ok.auditRotateKeep, 5);
  assert.equal(resolveConfig({ auditMaxBytes: 0 }).auditMaxBytes, 0, "0 = 不轮转，是合法值");

  // 非法值：退回默认，且**必须**有 issue（不能静默改数值）
  const issues = Config["~standard"].validate({ auditMaxBytes: -1, auditRotateKeep: 0 }).issues;
  assert.ok(Array.isArray(issues) && issues.length === 2);
  assert.ok(issues.some((i) => i.path[0] === "auditMaxBytes"));
  assert.ok(issues.some((i) => i.path[0] === "auditRotateKeep"));

  const cfg = resolveConfig({ auditMaxBytes: -1, auditRotateKeep: 9999 });
  assert.equal(cfg.auditMaxBytes, DEFAULTS.auditMaxBytes, "越界退回默认");
  assert.equal(cfg.auditRotateKeep, DEFAULTS.auditRotateKeep, "越界退回默认");
  assert.equal(resolveConfig({ auditMaxBytes: "big" }).auditMaxBytes, DEFAULTS.auditMaxBytes, "类型错也退回默认");

  // 两个新键都必须能被界面渲染（有默认值 + 说明）
  const json = Config.toJsonSchema().properties;
  for (const key of ["auditMaxBytes", "auditRotateKeep"]) {
    assert.notEqual(json[key], undefined, key);
    assert.notEqual(json[key].default, undefined, key);
    assert.notEqual(json[key].description, undefined, key);
  }
});

test("配置：容量键非法时 createAudit 退回默认并且不让删除事务失败", async () => {
  await withHome(async () => {
    // 绕过 schema 直接给脏值：createAudit 必须自己兜底，而不是把 NaN 带进 fs 调用。
    const audit = createAudit({ audit: true, auditMaxBytes: NaN, auditRotateKeep: -3 }, { warn() {} });
    assert.deepEqual(audit.rotation, { maxBytes: DEFAULT_MAX_BYTES, keep: DEFAULT_ROTATE_KEEP });
    const r = await audit.record({ action: "delete", sessionId: "s1", result: { ok: true } });
    assert.equal(r.ok, true);
    assert.equal(r.rotateError, undefined, "【反向断言】脏配置不得伪装成轮转降级");
  });
});
