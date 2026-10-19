import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidSessionId, isInside, alternateIdSpelling, SESSION_ID_RE } from "../lib/artifacts.js";

test("合法 sessionId", () => {
  for (const id of [
    "session-1bb8d361-ea6b-4b92-bab2-c858c92e8822",
    "1bb8d361-ea6b-4b92-bab2-c858c92e8822",
    "abc",
    "0",
    "a".repeat(128),
  ]) {
    assert.equal(isValidSessionId(id), true, id);
  }
});

test("非法 sessionId（路径穿越 / 越界 / 空 / 超长 / 非字符串）", () => {
  for (const id of [
    "",
    "-a",
    "../etc/passwd",
    "..",
    "a/b",
    "a.b",
    "a\\b",
    "a".repeat(129),
    null,
    undefined,
    1,
    {},
    [],
  ]) {
    assert.equal(isValidSessionId(id), false, String(id));
  }
});

test("SESSION_ID_RE 不接受任何路径分隔符或点号", () => {
  assert.equal(SESSION_ID_RE.test("/etc"), false);
  assert.equal(SESSION_ID_RE.test("a/../b"), false);
  assert.equal(SESSION_ID_RE.test("..\\.."), false);
});

test("isInside 挡住越界（含大小写与归一化）", () => {
  // 【跨平台】原来这里硬编码 `C:\tmp\sessions`，在 Linux 上会失败 ——
  // `path.resolve()` 在 POSIX 上把反斜杠当**普通文件名字符**，
  // 于是 `C:\tmp\sessions` 变成一个没有分隔符的单段路径，
  // `startsWith(root + sep)` 自然不成立。这不是 isInside 的 bug，是测试的平台假设错误。
  // 远端 CI（ubuntu-latest）当场抓出：`not ok 236 - isInside 挡住越界`。
  // 现在按当前平台选路径形状，两边都真的在测「同一套语义」。
  const isWin = process.platform === "win32";
  const root = isWin ? "C:\\tmp\\sessions" : "/tmp/sessions";
  const inside = isWin ? "C:\\tmp\\sessions\\p\\s1" : "/tmp/sessions/p/s1";
  const sibling = isWin ? "C:\\tmp\\sessionsX\\p" : "/tmp/sessionsX/p";
  const other = isWin ? "C:\\tmp\\other" : "/tmp/other";
  const traversal = isWin ? "C:\\tmp\\sessions\\..\\evil" : "/tmp/sessions/../evil";

  assert.equal(isInside(root, inside), true, "子目录必须在内部");
  assert.equal(isInside(root, sibling), false, "兄弟前缀（sessionsX）不得误判为内部");
  assert.equal(isInside(root, other), false, "完全不同的路径不得判为内部");
  assert.equal(isInside(root, traversal), false, "`..` 穿越必须在归一化后被挡住");
  // 根自身算在内部（删除动作以子目录为目标，这里只锁语义）
  assert.equal(isInside(root, root), true, "根自身算内部");
});

test("isInside 的兄弟目录前缀不误判（sessions 与 sessions2）", () => {
  assert.equal(isInside("/home/u/.dsh/sessions", "/home/u/.dsh/sessions2/x"), false);
  assert.equal(isInside("/home/u/.dsh/sessions", "/home/u/.dsh/sessions/x"), true);
});

test("alternateIdSpelling 生成对偶拼写，且不会产出非法 id", () => {
  assert.equal(alternateIdSpelling("session-abc"), "abc");
  assert.equal(alternateIdSpelling("abc"), "session-abc");
  assert.equal(alternateIdSpelling(""), null);
  assert.equal(alternateIdSpelling(null), null);
  // 前缀剥掉后若变非法（例如 "session-" + "-x"），必须返回 null 而不是非法 id
  assert.equal(alternateIdSpelling("session--x"), null);
});
