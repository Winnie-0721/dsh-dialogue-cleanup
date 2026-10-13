import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readdir, rm, symlink, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeArtifacts, removeProjectionCache } from "../lib/artifacts.js";

/** 造一个临时 sessions 根，测试结束务必清理。 */
async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), "dscc-artifacts-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("只删目标会话目录，别的不动；根缺失返回 0", async () => {
  await withRoot(async (root) => {
    await mkdir(join(root, "projA", "s1"), { recursive: true });
    await mkdir(join(root, "projA", "s2"), { recursive: true });
    await mkdir(join(root, "projB", "s1"), { recursive: true });
    await writeFile(join(root, "projA", "s1", "session.v4.jsonl.zstd"), "x");

    const r = await removeArtifacts("s1", { root });
    assert.equal(r.count, 2);
    assert.equal(r.paths.length, 2);
    assert.deepEqual((await readdir(join(root, "projA"))).sort(), ["s2"]);
    assert.deepEqual(await readdir(join(root, "projB")), []);

    const missing = await removeArtifacts("s1", { root: join(root, "nope") });
    assert.equal(missing.count, 0);
    assert.deepEqual(missing.paths, []);
  });
});

test("非法 id 直接抛错，不碰文件系统", async () => {
  await withRoot(async (root) => {
    await mkdir(join(root, "projA", "s1"), { recursive: true });
    await assert.rejects(() => removeArtifacts("../evil", { root }), /invalid sessionId/);
    await assert.rejects(() => removeArtifacts("", { root }), /invalid sessionId/);
    assert.deepEqual(await readdir(join(root, "projA")), ["s1"]);
  });
});

test("不带守卫时**不**碰另一种拼写（宁可不删，不可误删）", async () => {
  await withRoot(async (root) => {
    await mkdir(join(root, "projA", "session-abc"), { recursive: true });
    // 请求删 "abc"，磁盘上是 "session-abc"；没有 isKnownSession 守卫 → 不删
    const r = await removeArtifacts("abc", { root, matchAlternateIdSpelling: true });
    assert.equal(r.count, 0);
    assert.deepEqual(await readdir(join(root, "projA")), ["session-abc"]);
  });
});

test("带守卫且确认为『不是别的会话』时才删另一种拼写", async () => {
  await withRoot(async (root) => {
    await mkdir(join(root, "projA", "session-abc"), { recursive: true });
    // 守卫回答「session-abc 不是另一个已知会话」→ 允许删
    const r = await removeArtifacts("abc", {
      root,
      matchAlternateIdSpelling: true,
      isKnownSession: () => false,
    });
    assert.equal(r.count, 1);
    assert.deepEqual(await readdir(join(root, "projA")), []);
  });
});

test("守卫说『那是另一个真实会话』时跳过，绝不误删", async () => {
  await withRoot(async (root) => {
    await mkdir(join(root, "projA", "session-abc"), { recursive: true });
    const r = await removeArtifacts("abc", {
      root,
      matchAlternateIdSpelling: true,
      isKnownSession: (id) => id === "session-abc",
    });
    assert.equal(r.count, 0);
    assert.equal(r.skipped.length, 1);
    assert.deepEqual(await readdir(join(root, "projA")), ["session-abc"]);
  });
});

test("符号链接目录一律跳过（rm 递归跟随链接会越出 root）", async (t) => {
  await withRoot(async (root) => {
    const outside = await mkdtemp(join(tmpdir(), "dscc-outside-"));
    try {
      await mkdir(join(outside, "s1"), { recursive: true });
      await writeFile(join(outside, "s1", "valuable.txt"), "keep me");
      await mkdir(join(root, "projA"), { recursive: true });

      try {
        await symlink(join(outside, "s1"), join(root, "projA", "s1"), "junction");
      } catch {
        t.skip("本环境无法创建符号链接/junction");
        return;
      }

      const r = await removeArtifacts("s1", { root });
      assert.equal(r.count, 0, "链接不能被当作目录删除");
      assert.equal(r.skipped.length, 1);
      // 目标目录必须完好
      assert.deepEqual(await readdir(join(outside, "s1")), ["valuable.txt"]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("投影缓存：精确文件名删除，且同样不碰另一种拼写（无守卫）", async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, "s1.json"), "{}");
    await writeFile(join(root, "session-s1.json"), "{}");

    const r = await removeProjectionCache("s1", { root, matchAlternateIdSpelling: true });
    assert.equal(r.count, 1);
    assert.deepEqual(await readdir(root), ["session-s1.json"]);

    const r2 = await removeProjectionCache("s1", {
      root,
      matchAlternateIdSpelling: true,
      isKnownSession: () => false,
    });
    assert.equal(r2.count, 1);
    assert.deepEqual(await readdir(root), []);
  });
});

test("投影缓存：非法 id 抛错", async () => {
  await assert.rejects(() => removeProjectionCache("a/b"), /invalid sessionId/);
});

test("不删除同名文件（只删目录）", async () => {
  await withRoot(async (root) => {
    await mkdir(join(root, "projA"), { recursive: true });
    await writeFile(join(root, "projA", "s1"), "not a directory");
    const r = await removeArtifacts("s1", { root });
    assert.equal(r.count, 0);
    assert.equal((await lstat(join(root, "projA", "s1"))).isFile(), true);
  });
});
