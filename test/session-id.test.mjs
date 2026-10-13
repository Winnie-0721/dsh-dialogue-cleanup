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
  const root = "C:\\tmp\\sessions";
  assert.equal(isInside(root, "C:\\tmp\\sessions\\p\\s1"), true);
  assert.equal(isInside(root, "C:\\tmp\\sessionsX\\p"), false);
  assert.equal(isInside(root, "C:\\tmp\\other"), false);
  assert.equal(isInside(root, "C:\\tmp\\sessions\\..\\evil"), false);
  // 根自身算在内部（删除动作以子目录为目标，这里只锁语义）
  assert.equal(isInside(root, root), true);
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
