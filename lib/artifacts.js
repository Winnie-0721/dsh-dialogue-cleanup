/**
 * 磁盘工件删除 —— 删除类插件的第一道红线是**路径安全**。
 *
 * 两道防线：
 *   1. SESSION_ID_RE：只允许 [A-Za-z0-9-]，首个字符必须是字母或数字 —— 连 `..`、`/`、`\` 都进不来；
 *   2. isInside()：resolve 之后确实落在 sessions 根子树内 —— 即使正则被放宽也越不出去。
 *
 * 另外三条硬化（上游都没有）：
 *   - lstat 后跳过符号链接（`rm -r` 一个指向别处的链接是真实越权路径）；
 *   - 探测另一种 id 拼写时，先确认它不是**另一个已知会话**，避免误删同名邻居；
 *   - 返回被删路径清单（上游只返回计数），审计与 UI 都能对账。
 */

import { appendFile, lstat, mkdir, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

/** 会话 id 正则：同时承担路径穿越的第一道防线。 */
export const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;

export function isValidSessionId(id) {
  return typeof id === "string" && SESSION_ID_RE.test(id);
}

/** Windows 上路径大小写不敏感；其余平台按字节比较。 */
function foldCase(value) {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

/** 第二道防线：resolve 之后 target 确实在 root 子树内（或就是 root 本身）。 */
export function isInside(root, target) {
  const r = resolve(root);
  const t = resolve(target);
  const rf = foldCase(r);
  const tf = foldCase(t);
  return tf === rf || tf.startsWith(rf.endsWith(sep) ? rf : rf + sep);
}

/** <DSH_HOME>，与上游口径一致。 */
export function dshHome(env = process.env) {
  const home = typeof env?.DSH_HOME === "string" && env.DSH_HOME !== "" ? env.DSH_HOME : join(homedir(), ".dsh");
  return home;
}

/** 会话工件根目录：<DSH_HOME>/sessions。 */
export function sessionsRoot(env = process.env) {
  return join(dshHome(env), "sessions");
}

/** 派生投影缓存根目录：<DSH_HOME>/storages/session_projcache/sessions。 */
export function projectionCacheRoot(env = process.env) {
  return join(dshHome(env), "storages", "session_projcache", "sessions");
}

/**
 * 另一种 id 拼写。
 *
 * 【实证·本机发现】同一 <DSH_HOME>/sessions 下两种命名并存：
 *   ...\--E-Code-dsh-plugin-market--\1e9c8c76-c378-412b-9186-287498db6098\session.v4.jsonl.zstd
 *   ...\--E-AI-DeepSeek~0020Harness-~5B66~4E60--\session-9dae5c2b-f945-43a6-b962-ba8eb2fc1f81\session.v4.jsonl.zstd
 * 上游 `join(root, proj.name, sessionId)` 只用精确 id，于是带前缀的那一半永远删不掉。
 * 这里给出对偶拼写，但**不**无条件使用（见 removeArtifacts 的 isKnownSession 守卫）。
 */
export function alternateIdSpelling(sessionId) {
  if (typeof sessionId !== "string" || sessionId === "") return null;
  if (sessionId.startsWith("session-")) {
    const stripped = sessionId.slice("session-".length);
    return isValidSessionId(stripped) ? stripped : null;
  }
  const prefixed = `session-${sessionId}`;
  return isValidSessionId(prefixed) ? prefixed : null;
}

/** 候选目录名：精确 id 在前，另一种拼写在后（去重）。 */
function candidateNames(sessionId, matchAlternate) {
  const names = [sessionId];
  if (matchAlternate) {
    const alt = alternateIdSpelling(sessionId);
    if (alt !== null && !names.includes(alt)) names.push(alt);
  }
  return names;
}

/**
 * 删除该会话在**所有项目目录**下的工件目录。
 *
 * @param {string} sessionId
 * @param {object} [options]
 * @param {string} [options.root]     会话根目录，默认 sessionsRoot()
 * @param {boolean} [options.matchAlternateIdSpelling]
 * @param {(id: string) => boolean} [options.isKnownSession]
 *        对「非精确拼写」的候选做存在性守卫；返回 true 表示它是另一个真实会话，必须跳过。
 *        缺省时（无法判定）**只删精确 id** —— 宁可不删，不可误删。
 * @returns {Promise<{count: number, paths: string[], skipped: string[]}>}
 */
export async function removeArtifacts(sessionId, options = {}) {
  if (!isValidSessionId(sessionId)) throw new Error("invalid sessionId");

  const root = options.root ?? sessionsRoot();
  const matchAlternate = options.matchAlternateIdSpelling === true;
  const isKnownSession = typeof options.isKnownSession === "function" ? options.isKnownSession : null;
  const names = candidateNames(sessionId, matchAlternate);

  let projects;
  try {
    projects = await readdir(root, { withFileTypes: true });
  } catch {
    return { count: 0, paths: [], skipped: [] }; // 根不存在 —— 没什么可删
  }

  const removed = [];
  const skipped = [];

  for (const proj of projects) {
    if (!proj.isDirectory()) continue;
    for (const candidate of names) {
      // 非精确拼写必须有守卫结论，否则不碰（防止删掉同名的另一个会话）。
      if (candidate !== sessionId && isKnownSession === null) continue;
      if (candidate !== sessionId && isKnownSession(candidate)) {
        skipped.push(join(root, proj.name, candidate));
        continue;
      }

      const dir = join(root, proj.name, candidate);
      if (!isInside(root, dir)) continue; // 双保险

      let info;
      try {
        info = await lstat(dir);
      } catch {
        continue; // 不存在 —— 不是这个会话的目录
      }
      // 符号链接一律跳过：rm 递归跟随链接会把删除动作带到 root 之外。
      if (info.isSymbolicLink() || !info.isDirectory()) {
        skipped.push(dir);
        continue;
      }

      await rm(dir, { recursive: true, force: true });
      removed.push(dir);
    }
  }

  return { count: removed.length, paths: removed, skipped };
}

/**
 * 删除派生的投影缓存条目。
 *
 * 为什么算在交付范围内：projcache 是「会话的派生产物」，删掉会话却留着它，
 * 下次打开同名 id 会读到过期折叠状态。它是精确文件名，风险远低于目录递归删除。
 *
 * @returns {Promise<{count: number, paths: string[], skipped: string[]}>}
 */
export async function removeProjectionCache(sessionId, options = {}) {
  if (!isValidSessionId(sessionId)) throw new Error("invalid sessionId");

  const root = options.root ?? projectionCacheRoot();
  const matchAlternate = options.matchAlternateIdSpelling === true;
  const isKnownSession = typeof options.isKnownSession === "function" ? options.isKnownSession : null;
  const names = candidateNames(sessionId, matchAlternate);

  const removed = [];
  const skipped = [];

  for (const candidate of names) {
    if (candidate !== sessionId && isKnownSession === null) continue;
    if (candidate !== sessionId && isKnownSession(candidate)) {
      skipped.push(join(root, `${candidate}.json`));
      continue;
    }

    const file = join(root, `${candidate}.json`);
    if (!isInside(root, file)) continue;

    let info;
    try {
      info = await lstat(file);
    } catch {
      continue;
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      skipped.push(file);
      continue;
    }

    await rm(file, { force: true });
    removed.push(file);
  }

  return { count: removed.length, paths: removed, skipped };
}

/** 确保审计文件所在目录存在（不吞错：调用方决定是否降级）。 */
export async function ensureParentDir(filePath) {
  await mkdir(dirname(filePath), { recursive: true });
}

/** 追加一行 JSONL。审计失败绝不能让删除事务失败，故调用方负责 catch。 */
export async function appendJsonLine(filePath, value) {
  await ensureParentDir(filePath);
  await appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}
