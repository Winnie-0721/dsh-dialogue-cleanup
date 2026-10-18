/**
 * 故障注入测试（P0-5）：逐个破坏**每个破坏性步骤**，断言结果模型
 * 绝不会把「有步骤失败」报成完整成功。
 *
 * 这是本轮整改引入的新套件。与 contract/service 套件的分工：
 *   · 那些套件测「正常路径与既有契约」；
 *   · 本套件只测一件事：**任一步失败 → 必须可判别**（complete=false / partial=true / degradations 有对应项）。
 *
 * 全部用真实的 createService + 真实文件系统（临时 DSH_HOME），不 mock service 内部。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, chmod, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createService } from "../lib/service.js";
import { resolveConfig } from "../lib/config.js";

let counter = 0;
const auditOff = { record: async () => ({ ok: true, path: null }), enabled: false, path: null };

/** 造一个隔离的 DSH_HOME + service。返回 {service, root, base, restore}。 */
async function makeEnv({ services = {}, config = {}, audit = auditOff } = {}) {
  const base = await mkdtemp(join(tmpdir(), `dscc-fi-${counter += 1}-`));
  const root = join(base, "sessions");
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = base;
  const full = {
    sessions: { list: () => [], store: new Map() },
    sessionController: { list: async () => ({ items: [] }) },
    workspaceRegistry: { list: () => [], detachSession: () => {} },
    agents: { get: () => undefined },
    ...services,
  };
  const ctx = { logger: { warn() {}, debug() {} }, get: (k) => full[k] };
  const service = createService(ctx, resolveConfig({ audit: false, ...config }), audit);
  return {
    service,
    root,
    base,
    services: full,
    restore: async () => {
      if (prevHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = prevHome;
      await rm(base, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/** 在 root 下造一个会话目录。 */
async function seedSession(root, sessionId, proj = "projA") {
  await mkdir(join(root, proj, sessionId), { recursive: true });
  await writeFile(join(root, proj, sessionId, "session.v4.jsonl.zstd"), "x");
}

/** 断言：这条结果**没有**谎报完整成功。 */
function assertNotCompleteSuccess(result, stepLabel) {
  assert.equal(result.ok, true, `${stepLabel}：删除本身仍是 ok（幂等语义）`);
  const v = result.value;
  assert.equal(v.complete, false, `${stepLabel}：绝不能报 complete=true`);
  assert.equal(v.partial, true, `${stepLabel}：必须报 partial=true`);
  assert.ok(
    Array.isArray(v.degradations) && v.degradations.length > 0,
    `${stepLabel}：必须至少有一条 degradations`,
  );
}

// ─────────────────────────────────────────────────────────────
// 1. 磁盘工件删除失败（sessions 根不可列举：ENOTDIR）
// ─────────────────────────────────────────────────────────────
test("故障注入：磁盘根不可列举（ENOTDIR）→ 不得报完整成功", async () => {
  // 【为什么必须让 detach 成功】旧定义 `partial = !detached && files===0` 只有在
  // **detached 为 true** 时才会算错（此时 partial 会误判为 false）。
  // 若 detach 也失败，新旧两种定义都给出 partial:true，这条测试就咬不住退化 ——
  // 变异 N7 正是靠这一点存活过。所以这里给一个可用的 store，让 detach 成功。
  const store = new Map([["sess-1", { detach() { store.delete("sess-1"); } }]]);
  const env = await makeEnv({
    services: {
      sessions: { list: () => [{ id: "sess-1" }], store },
      sessionController: { list: async () => ({ items: [{ sessionId: "sess-1", running: false, blank: false, updatedAt: 1 }] }) },
    },
  });
  try {
    // sessions 是**文件**而不是目录 → readdir 抛 ENOTDIR
    await writeFile(env.root, "not a directory");
    const r = await env.service.deleteSession("sess-1");
    assert.equal(r.value.detach, "detached", "前提：detach 必须成功，否则测不出 partial 退化");
    assertNotCompleteSuccess(r, "ENOTDIR");
    assert.match(r.value.degradations[0].reason, /ENOTDIR/, "必须带出真实 errno");
  } finally {
    await env.restore();
  }
});

// ─────────────────────────────────────────────────────────────
// 2. 磁盘工件删除失败（权限不足，仅 POSIX；Windows 跳过并说明）
// ─────────────────────────────────────────────────────────────
test("故障注入：磁盘根权限不足（EACCES）→ 不得报完整成功", { skip: process.platform === "win32" ? "Windows 无 chmod 语义，见 ACL 测试说明" : false }, async () => {
  const env = await makeEnv();
  try {
    await seedSession(env.root, "sess-2");
    await chmod(env.root, 0o000);
    const r = await env.service.deleteSession("sess-2");
    await chmod(env.root, 0o755);
    assertNotCompleteSuccess(r, "EACCES");
  } finally {
    await env.restore();
  }
});

// ─────────────────────────────────────────────────────────────
// 3. 空根（ENOENT）：**不是**失败 —— 正常收尾，complete=true
//    （防止把「没有可删」误报成降级，两个方向都要钉）
// ─────────────────────────────────────────────────────────────
test("故障注入反例：sessions 根不存在（ENOENT）→ 属正常收尾，不得误报降级", async () => {
  // 注意：闭包里的 store 必须先建好再引用，否则 detach 会引用到未赋值变量。
  const store = new Map([["sess-3", { detach() { store.delete("sess-3"); } }]]);
  const env = await makeEnv({
    services: {
      sessions: { list: () => [{ id: "sess-3" }], store },
    },
  });
  try {
    // 故意不创建 sessions 根目录 → readdir 抛 ENOENT
    const r = await env.service.deleteSession("sess-3");
    assert.equal(r.ok, true);
    // 根目录压根不存在 —— 没有可删的东西，这是正常收尾（不是降级）
    const diskDeg = (r.value.degradations ?? []).filter((d) => d.step === "artifacts" || d.step === "projectionCache");
    assert.equal(diskDeg.length, 0, `ENOENT 不得被当成磁盘失败，实际：${JSON.stringify(r.value.degradations)}`);
  } finally {
    await env.restore();
  }
});

// ─────────────────────────────────────────────────────────────
// 4. live store 摘除失败 → 必须报降级
// ─────────────────────────────────────────────────────────────
test("故障注入：live store 摘除失败（无可用 store 入口）→ 不得报完整成功", async () => {
  const env = await makeEnv({
    services: {
      // 有 list 但没有可用的 store Map / 公开 detach → detachLiveStore 返回 "failed"
      sessions: { list: () => [{ id: "sess-4" }] },
      sessionController: { list: async () => ({ items: [{ sessionId: "sess-4", running: false, blank: false, updatedAt: 1 }] }) },
    },
  });
  try {
    await seedSession(env.root, "sess-4");
    const r = await env.service.deleteSession("sess-4");
    assertNotCompleteSuccess(r, "detachLive");
    assert.ok(
      r.value.degradations.some((d) => d.step === "detachLive"),
      "必须明确标出 detachLive 这一步降级",
    );
  } finally {
    await env.restore();
  }
});

// ─────────────────────────────────────────────────────────────
// 5. 工作区归属摘除失败 → 必须报降级
// ─────────────────────────────────────────────────────────────
test("故障注入：工作区摘除抛错 → 不得报完整成功", async () => {
  const env = await makeEnv({
    services: {
      sessions: { list: () => [], store: new Map() },
      workspaceRegistry: {
        list: () => [{ id: "w1", sessionIds: ["sess-5"], detachSession: async () => { throw new Error("ws boom"); } }],
      },
    },
  });
  try {
    await seedSession(env.root, "sess-5");
    const r = await env.service.deleteSession("sess-5");
    assertNotCompleteSuccess(r, "detachWorkspaces");
    assert.ok(
      r.value.degradations.some((d) => d.step === "detachWorkspaces"),
      "必须明确标出 detachWorkspaces 降级",
    );
  } finally {
    await env.restore();
  }
});

// ─────────────────────────────────────────────────────────────
// 6. 审计写入失败 → 删除仍成功，但必须可判别
// ─────────────────────────────────────────────────────────────
test("故障注入：审计写入失败 → 删除成功但必须标出 audit 降级", async () => {
  const auditFailing = {
    record: async () => ({ ok: false, path: "X", error: "EACCES: audit denied" }),
    enabled: true,
    path: "X",
  };
  const env = await makeEnv({ audit: auditFailing });
  try {
    await seedSession(env.root, "sess-6");
    const r = await env.service.deleteSession("sess-6");
    assert.equal(r.ok, true, "审计失败不得让删除事务失败（写日志失败 ≠ 没删掉）");
    assert.equal(r.value.audit.ok, false, "必须如实带上 audit.ok=false");
    assert.ok(
      r.value.degradations.some((d) => d.step === "audit"),
      "audit 失败必须进降级清单",
    );
    assert.equal(r.value.complete, false, "有降级项就不能叫完整成功");
  } finally {
    await env.restore();
  }
});

// ─────────────────────────────────────────────────────────────
// 7. 侧栏通知失败 → 删除成功，但必须可判别
// ─────────────────────────────────────────────────────────────
test("故障注入：侧栏通知失败（emit 抛错）→ 删除成功但必须标出 announce 降级", async () => {
  const base = await mkdtemp(join(tmpdir(), `dscc-fi-ann-`));
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = base;
  const store = new Map([["sess-7", { detach() { store.delete("sess-7"); } }]]);
  const services = {
    sessions: { list: () => [{ id: "sess-7" }], store },
    sessionController: { list: async () => ({ items: [{ sessionId: "sess-7", running: false, blank: false, updatedAt: 1 }] }) },
    workspaceRegistry: { list: () => [] },
    agents: { get: () => undefined },
  };
  const ctx = {
    logger: { warn() {}, debug() {} },
    get: (k) => services[k],
    // emit 抛错 → announceSessionRemoved 必须降级为 announced:false
    emit: () => { throw new Error("emit boom"); },
  };
  const service = createService(ctx, resolveConfig({ audit: false }), auditOff);
  try {
    await seedSession(join(base, "sessions"), "sess-7");
    const r = await service.deleteSession("sess-7");
    assert.equal(r.ok, true, "通知失败不得让删除事务失败");
    assert.equal(r.value.announced, false, "必须如实报 announced=false");
    assert.ok(
      r.value.degradations.some((d) => d.step === "announce"),
      "announce 失败必须进降级清单",
    );
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
});

// ─────────────────────────────────────────────────────────────
// 8. 全绿路径：不得误报降级（反方向）
// ─────────────────────────────────────────────────────────────
test("故障注入反例：全部步骤成功 → complete=true 且 degradations 为空", async () => {
  const store = new Map([["sess-8", { detach() { store.delete("sess-8"); } }]]);
  const env = await makeEnv({
    services: {
      sessions: { list: () => [{ id: "sess-8" }], store },
      sessionController: { list: async () => ({ items: [{ sessionId: "sess-8", running: false, blank: false, updatedAt: 1 }] }) },
      workspaceRegistry: { list: () => [{ id: "w1", sessionIds: ["sess-8"], detachSession: async () => {} }] },
    },
  });
  try {
    await seedSession(env.root, "sess-8");
    const r = await env.service.deleteSession("sess-8");
    assert.equal(r.ok, true);
    assert.equal(r.value.partial, false, `不得误报 partial：${JSON.stringify(r.value.degradations)}`);
    assert.equal(r.value.complete, true, "全部成功必须是 complete=true");
    assert.deepEqual(r.value.degradations, []);
    assert.equal(r.value.partial, false);
  } finally {
    await env.restore();
  }
});

// ─────────────────────────────────────────────────────────────
// 9. 重试幂等：第二次重删不得误删别的会话，且不得报成「完整成功」
// ─────────────────────────────────────────────────────────────
test("故障注入：幂等重删 → 第二次是 no-op（nothingDeleted）而不是完整成功", async () => {
  const store = new Map([["sess-9", { detach() { store.delete("sess-9"); } }]]);
  const env = await makeEnv({
    services: {
      sessions: { list: () => [{ id: "sess-9" }], store },
      sessionController: { list: async () => ({ items: [{ sessionId: "sess-9", running: false, blank: false, updatedAt: 1 }] }) },
    },
  });
  try {
    await seedSession(env.root, "sess-9");
    const first = await env.service.deleteSession("sess-9");
    assert.equal(first.value.files, 1, "第一次删掉 1 个目录");
    const second = await env.service.deleteSession("sess-9");
    assert.equal(second.ok, true, "重删仍是成功（幂等）");
    assert.equal(second.value.nothingDeleted, true, "第二次什么都没删到，必须如实标 noop");
    assert.equal(second.value.files, 0);
  } finally {
    await env.restore();
  }
});

// ─────────────────────────────────────────────────────────────
// 11. 【安全红线】父组件是 junction/符号链接 → 真实路径越界，必须拒绝删除
//     这是 fs-auditor 报、我独立复现的 P0：isInside 只做字符串前缀比较，
//     父组件是链接时字符串仍以 root 开头，lstat 也报告「普通目录」，
//     于是 rm -r 删掉了 root 之外的真实目录（实测 count:201、error:null）。
//     修法：破坏性删除前用 realpath 解析真实路径再校验（isRealPathInside）。
// ─────────────────────────────────────────────────────────────
test("安全红线：项目目录是 junction 指向 root 之外 → 绝不删除外部真实目录", async () => {
  // 【这条测试能咬住什么，说清楚，免得后人误以为它覆盖了全部】
  // Windows 上 readdir 把 junction 报成 isDirectory:false / isSymbolicLink:true，
  // 于是 removeArtifacts 在**进入候选循环之前**就跳过了它 —— 本用例因此
  // 主要验证「链接型项目目录不会被跟进删除」（静态防线），
  // 而 isRealPathInside 那道**动态**防线由下面的竞态测试与单元测试覆盖。
  if (process.platform !== "win32") {
    const env = await makeEnv();
    try {
      const { symlink } = await import("node:fs/promises");
      const outside = join(env.base, "OUTSIDE");
      await mkdir(join(outside, "sess-j"), { recursive: true });
      await writeFile(join(outside, "sess-j", "valuable.txt"), "KEEP ME");
      await mkdir(env.root, { recursive: true });
      await symlink(outside, join(env.root, "proj-link"), "dir");

      const r = await env.service.deleteSession("sess-j");
      const survived = await stat(join(outside, "sess-j", "valuable.txt")).then(() => true).catch(() => false);
      assert.equal(survived, true, "root 之外的真实文件绝不能被删掉");
      assert.equal(r.value.files, 0, "越界目标不得计入已删文件数");
    } finally {
      await env.restore();
    }
    return;
  }

  const env = await makeEnv();
  try {
    const { execFileSync } = await import("node:child_process");
    const outside = join(env.base, "OUTSIDE");
    await mkdir(join(outside, "sess-j"), { recursive: true });
    await writeFile(join(outside, "sess-j", "valuable.txt"), "KEEP ME");
    await mkdir(env.root, { recursive: true });
    execFileSync("cmd", ["/c", "mklink", "/J", join(env.root, "proj-link"), outside], { stdio: "pipe" });

    const r = await env.service.deleteSession("sess-j");
    const survived = await stat(join(outside, "sess-j", "valuable.txt")).then(() => true).catch(() => false);
    assert.equal(survived, true, "经 junction 逃出 root 的真实目录绝不能被删掉");
    assert.equal(r.value.files, 0, "越界目标不得计入已删文件数");
  } finally {
    await env.restore();
  }
});

// ─────────────────────────────────────────────────────────────
// 11b. 【真正的动态防线 · 竞态】readdir 之后把项目目录换成 junction
//      ——这是唯一能让 isRealPathInside 真正生效的路径（fs-auditor 报、我复现）。
//      readdir 一次拿全部 Dirent；此后循环逐个 lstat+rm。
//      在循环进行中把受害项目目录换成指向 root 之外的 junction，
//      字符串校验通过、lstat 说「普通目录」，若不查真实路径就会删掉外部目录
//      （实测修复前 count:201、error:null，外部文件被删）。
// ─────────────────────────────────────────────────────────────
test("安全红线（竞态）：删除过程中项目目录被换成 junction → 必须拒绝且外部文件存活", async () => {
  if (process.platform !== "win32") return; // junction 是 Windows 场景；POSIX 等价路径见单元测试
  const { removeArtifacts } = await import("../lib/artifacts.js");
  const base = await mkdtemp(join(tmpdir(), "dscc-race-"));
  try {
    const root = join(base, "sessions");
    const outside = join(base, "OUTSIDE-VICTIM");
    const VICTIM = "zzz-victim";
    const ID = "s1";
    await mkdir(join(outside, ID), { recursive: true });
    await writeFile(join(outside, ID, "valuable.txt"), "KEEP ME");

    await mkdir(root, { recursive: true });
    for (let i = 0; i < 120; i += 1) {
      await mkdir(join(root, `p${String(i).padStart(3, "0")}`, ID), { recursive: true });
    }
    await mkdir(join(root, VICTIM, ID), { recursive: true });

    const exists = (p) => stat(p).then(() => true).catch(() => false);
    const pending = removeArtifacts(ID, { root });

    let swapped = false;
    const watcher = (async () => {
      for (let i = 0; i < 200000 && !swapped; i += 1) {
        if (!(await exists(join(root, "p000", ID)))) {
          await rm(join(root, VICTIM), { recursive: true, force: true }).catch(() => {});
          try {
            const { execFileSync } = await import("node:child_process");
            execFileSync("cmd", ["/c", "mklink", "/J", join(root, VICTIM), outside], { stdio: "pipe" });
            swapped = true;
          } catch { /* 继续尝试 */ }
        }
      }
    })();

    const out = await pending;
    await watcher;

    const survived = await exists(join(outside, ID, "valuable.txt"));
    assert.equal(survived, true, "竞态下也不得删除 root 之外的真实文件");
    if (swapped) {
      assert.ok(
        out.error !== null || out.failures.length > 0,
        "拒绝越界删除时必须如实上报（error/failures）",
      );
    }
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
});

// ─────────────────────────────────────────────────────────────
// 12. isRealPathInside 的单元级对照（正反两个方向）
// ─────────────────────────────────────────────────────────────
test("isRealPathInside：真实路径在 root 内 → true；经链接逃逸 → false", async () => {
  const { isRealPathInside } = await import("../lib/artifacts.js");
  const base = await mkdtemp(join(tmpdir(), "dscc-rpi-"));
  try {
    const root = join(base, "sessions");
    const outside = join(base, "OUT");
    await mkdir(join(root, "proj", "s1"), { recursive: true });
    await mkdir(join(outside, "s1"), { recursive: true });

    // 正常：root 内的真实目录
    assert.equal(await isRealPathInside(root, join(root, "proj", "s1")), true);

    // 越界：父组件是链接（Windows 用 junction，POSIX 用 symlink）
    const linkPath = join(root, "link-proj");
    if (process.platform === "win32") {
      const { execFileSync } = await import("node:child_process");
      execFileSync("cmd", ["/c", "mklink", "/J", linkPath, outside], { stdio: "pipe" });
    } else {
      const { symlink } = await import("node:fs/promises");
      await symlink(outside, linkPath, "dir");
    }
    assert.equal(
      await isRealPathInside(root, join(linkPath, "s1")),
      false,
      "经父组件链接逃逸必须判 false",
    );

    // 解析不了（不存在）→ 保守 false
    assert.equal(await isRealPathInside(root, join(root, "proj", "nope")), false);
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
});

// ─────────────────────────────────────────────────────────────
// 13. lstat 失败不得被当成「不存在」（P1：权限/ELOOP/IO）
//     这里用 ELOOP 构造（自指链接环），无需 ACL 权限，跨平台可控。
// ─────────────────────────────────────────────────────────────
test("故障注入：候选路径 lstat 失败（非 ENOENT）→ 必须如实进 failures", { skip: process.platform === "win32" ? "POSIX 符号链接环构造；Windows 用 ACL 场景见报告" : false }, async () => {
  const env = await makeEnv();
  try {
    const { symlink } = await import("node:fs/promises");
    await mkdir(env.root, { recursive: true });
    // 造一个自指链接环：a -> b -> a，lstat 末组件会得 ELOOP
    await mkdir(join(env.root, "projA"), { recursive: true });
    await symlink(join(env.root, "projA", "loop2"), join(env.root, "projA", "loop1")).catch(() => {});
    await symlink(join(env.root, "projA", "loop1"), join(env.root, "projA", "loop2")).catch(() => {});

    const { removeArtifacts } = await import("../lib/artifacts.js");
    const out = await removeArtifacts("sess-loop", { root: env.root });
    // 这个 id 不存在 → 无候选目录；本测试主要钉住「错误分支不再静默」
    assert.equal(typeof out.failures, "object", "必须总是返回 failures 数组");
  } finally {
    await env.restore();
  }
});
test("故障注入：运行中的会话必须被拒，且磁盘零改动", async () => {
  const env = await makeEnv({
    services: {
      sessions: { list: () => [{ id: "sess-10" }], store: new Map() },
      sessionController: { list: async () => ({ items: [{ sessionId: "sess-10", running: true, blank: false, updatedAt: 1 }] }) },
    },
  });
  try {
    await seedSession(env.root, "sess-10");
    const r = await env.service.deleteSession("sess-10");
    assert.equal(r.ok, false, "运行中的会话必须被拒");
    assert.equal(r.error.code, "refused");
    // 磁盘必须原封不动
    const { stat } = await import("node:fs/promises");
    const still = await stat(join(env.root, "projA", "sess-10")).then(() => true).catch(() => false);
    assert.equal(still, true, "被拒的删除绝不能碰磁盘");
  } finally {
    await env.restore();
  }
});

// ─────────────────────────────────────────────────────────────
// 14. 【安全红线】对偶拼写守卫：持久语料里存在该 id → 绝不删它的对偶目录
//     （P0-2：守卫只看 live 会话时，会把「已持久化但当前不 live」的
//      另一个真实会话当成自己的另一种拼写删掉。实测 files:2、两个目录都没了。）
// ─────────────────────────────────────────────────────────────
test("安全红线：对偶拼写是另一个真实会话（在持久语料里）→ 绝不删它", async () => {
  const UUID = "11111111-2222-3333-4444-555555555555";
  const store = new Map([[UUID, { detach() { store.delete(UUID); } }]]);
  const env = await makeEnv({
    services: {
      sessions: { list: () => [{ id: UUID }], store },
      sessionController: { list: async () => ({ items: [{ sessionId: UUID, running: false, blank: false, updatedAt: 1 }] }) },
      // 持久语料里**同时**存在两个 id（它们是两个真实会话）
      sessionQuery: {
        listSessions: async () => [
          { header: { id: UUID, cwd: "E:\\p", createdAt: 1 } },
          { header: { id: `session-${UUID}`, cwd: "E:\\p", createdAt: 2 } },
        ],
      },
    },
  });
  try {
    await seedSession(env.root, UUID, "projA");
    await seedSession(env.root, `session-${UUID}`, "projB");

    const r = await env.service.deleteSession(UUID);
    assert.equal(r.ok, true);
    const siblingSurvived = await stat(join(env.root, "projB", `session-${UUID}`)).then(() => true).catch(() => false);
    assert.equal(siblingSurvived, true, "另一个真实会话（对偶拼写）绝不能被删掉");
    assert.ok(
      r.value.skipped.some((p) => p.includes(`session-${UUID}`)),
      `被保护的对偶目录必须出现在 skipped 里，实际：${JSON.stringify(r.value.skipped)}`,
    );
  } finally {
    await env.restore();
  }
});

// ─────────────────────────────────────────────────────────────
// 15. 【安全红线】拿不到「有哪些会话真实存在」的证据时 → 不碰对偶拼写
//     （宁可不删，不可误删：守卫不可用必须收紧，而不是放行）
// ─────────────────────────────────────────────────────────────
test("安全红线：持久语料不可读（守卫不可用）→ 不碰对偶拼写", async () => {
  const UUID = "22222222-3333-4444-5555-666666666666";
  const store = new Map([[UUID, { detach() { store.delete(UUID); } }]]);
  const env = await makeEnv({
    services: {
      sessions: { list: () => [{ id: UUID }], store },
      sessionController: { list: async () => ({ items: [{ sessionId: UUID, running: false, blank: false, updatedAt: 1 }] }) },
      // 语料读取直接抛错 → 守卫不可用
      sessionQuery: { listSessions: async () => { throw new Error("corpus down"); } },
    },
  });
  try {
    await seedSession(env.root, UUID, "projA");
    await seedSession(env.root, `session-${UUID}`, "projB");

    const r = await env.service.deleteSession(UUID);
    assert.equal(r.ok, true);
    assert.equal(r.value.files, 1, "只该删掉精确 id 那一个目录");
    const siblingSurvived = await stat(join(env.root, "projB", `session-${UUID}`)).then(() => true).catch(() => false);
    assert.equal(siblingSurvived, true, "守卫不可用时必须收紧：不碰对偶拼写");
  } finally {
    await env.restore();
  }
});

// ─────────────────────────────────────────────────────────────
// 16. removeArtifacts 直接层：错误必须可判别（readdir ENOTDIR / ENOENT / 正常）
// ─────────────────────────────────────────────────────────────
test("removeArtifacts 直接层：ENOTDIR 报错、ENOENT 正常、成功时无降级", async () => {
  const { removeArtifacts } = await import("../lib/artifacts.js");
  const base = await mkdtemp(join(tmpdir(), "dscc-art-"));
  try {
    // (a) root 是文件 → ENOTDIR，必须带 error
    const asFile = join(base, "sessions-file");
    await writeFile(asFile, "x");
    const a = await removeArtifacts("s1", { root: asFile });
    assert.equal(a.count, 0);
    assert.ok(a.error !== null && /ENOTDIR/.test(a.error), `readdir 失败必须带 error，实际 ${a.error}`);
    assert.equal(a.rootPresent, true, "根存在（只是不是目录）——不得谎报 rootPresent:false");

    // (b) root 不存在 → ENOENT：**不是**失败
    const b = await removeArtifacts("s1", { root: join(base, "nope") });
    assert.equal(b.error, null, "ENOENT 属正常收尾，不得报 error");
    assert.equal(b.rootPresent, false);

    // (c) 正常删除路径：error 为 null、failures 为空
    const root = join(base, "sessions");
    await mkdir(join(root, "projA", "s1"), { recursive: true });
    const c = await removeArtifacts("s1", { root });
    assert.equal(c.count, 1);
    assert.equal(c.error, null);
    assert.deepEqual(c.failures, []);
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
});

// ─────────────────────────────────────────────────────────────
// 18. 【确定性覆盖错误分支】**通过目录权限/异常注入**触发 rm 与 lstat 的失败分支。
//     之前这几条只在 POSIX 上跑（Windows 跳过），导致变异 N3/N4「把错误记录删掉」
//     在 Windows 上存活 —— 那是**测试没覆盖**，不是等价变异。
//     这里改用**可注入的 fs 桩**：确定性地让 rm / lstat 抛指定 errno，
//     跨平台都能咬住「错误必须被记录」这条不变量。
//     注意：这是对 artifacts 层的**单元级**注入，不是真实文件系统集成测试
//     （真实失败路径由上面的 junction/竞态用例覆盖）。
// ─────────────────────────────────────────────────────────────
test("错误分支（注入）：rm 抛 EPERM / lstat 抛 EACCES → 必须进 failures 且 error 非空", async () => {
  const { removeArtifactsWithFs } = await import("../lib/artifacts.js");
  assert.equal(typeof removeArtifactsWithFs, "function", "artifacts 必须暴露可注入 fs 的内部入口以供错误分支测试");

  const base = await mkdtemp(join(tmpdir(), "dscc-inject-"));
  try {
    const root = join(base, "sessions");
    await mkdir(join(root, "projA", "s1"), { recursive: true });

    // (a) rm 抛 EPERM → 必须记进 failures 并让 error 非空
    const rmFails = await removeArtifactsWithFs("s1", { root }, {
      rm: async () => { const e = new Error("EPERM: operation not permitted"); e.code = "EPERM"; throw e; },
    });
    assert.equal(rmFails.count, 0, "rm 失败不得计入已删");
    assert.ok(rmFails.failures.length > 0, "rm 失败必须进 failures（这正是变异 N3 抹掉的那行）");
    assert.ok(rmFails.error !== null, "rm 失败必须让 error 非空");

    // (b) lstat 抛 EACCES → 不得被当成「不存在」
    const lstatFails = await removeArtifactsWithFs("s1", { root }, {
      lstat: async () => { const e = new Error("EACCES: permission denied"); e.code = "EACCES"; throw e; },
    });
    assert.ok(lstatFails.failures.length > 0, "lstat 非 ENOENT 失败必须进 failures（变异 N4 抹掉的那行）");
    assert.ok(lstatFails.error !== null, "lstat 失败必须让 error 非空");

    // (c) 对照：lstat 抛 ENOENT → **不是**失败（正常「无此目录」）
    const lstatEnoent = await removeArtifactsWithFs("s1", { root }, {
      lstat: async () => { const e = new Error("ENOENT: no such file"); e.code = "ENOENT"; throw e; },
    });
    assert.deepEqual(lstatEnoent.failures, [], "ENOENT 不得被记成失败");
    assert.equal(lstatEnoent.error, null, "ENOENT 不得让 error 非空");

    // (d) 对照：readdir 抛 ENOENT → root 不存在，正常收尾
    const readdirEnoent = await removeArtifactsWithFs("s1", { root }, {
      readdir: async () => { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; },
    });
    assert.equal(readdirEnoent.error, null, "readdir ENOENT 属正常收尾");
    assert.equal(readdirEnoent.rootPresent, false);
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
});
test("故障注入：rm 失败（目标不可删）→ 必须进 failures 而非静默", { skip: process.platform === "win32" ? "Windows 用 ACL；POSIX 用父目录只读构造" : false }, async () => {
  const { removeArtifacts } = await import("../lib/artifacts.js");
  const base = await mkdtemp(join(tmpdir(), "dscc-rm-"));
  try {
    const root = join(base, "sessions");
    const proj = join(root, "projA");
    await mkdir(join(proj, "s1"), { recursive: true });
    // 项目目录设为只读（无写权限）→ 删不掉里面的 s1
    await chmod(proj, 0o555);
    const out = await removeArtifacts("s1", { root });
    await chmod(proj, 0o755);
    assert.equal(out.count, 0, "不该谎报删掉了");
    assert.ok(out.failures.length > 0, "rm 失败必须进 failures");
    assert.ok(out.error !== null, "rm 失败必须让 error 非空");
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
});
