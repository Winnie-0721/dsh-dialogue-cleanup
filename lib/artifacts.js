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

import { appendFile, lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
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

/** 第二道防线：resolve 之后 target 确实在 root 子树内（或就是 root 本身）。
 *
 * 【注意 · 这一条**只是字符串层面**的防线】它不解析符号链接/junction。
 * 破坏性删除前必须再做一次**真实路径**校验，见 assertRealPathInside()。 */
export function isInside(root, target) {
  const r = resolve(root);
  const t = resolve(target);
  const rf = foldCase(r);
  const tf = foldCase(t);
  return tf === rf || tf.startsWith(rf.endsWith(sep) ? rf : rf + sep);
}

/**
 * 第三道防线（**破坏性删除专用**）：把 target 解析成真实路径后，再确认它仍在
 * root 的真实路径子树内。
 *
 * 【为什么必须有 · 2026-10-18 实测复现的越界删除】
 * `isInside()` 是纯字符串前缀比较。若 root 下的某个**父组件**（项目目录）是指向
 * root 之外的 junction / 符号链接，那么：
 *   · `join(root, proj, id)` 的字符串仍以 root 开头 → isInside **通过**；
 *   · `lstat(root/proj/id)` 会跟随父组件链接，报告「普通目录、不是符号链接」
 *     → 符号链接守卫**也通过**；
 *   · `rm(recursive)` 于是删掉了 root 之外的**真实目录**。
 * 实测（竞态版）：把受害项目目录换成 junction 后，removeArtifacts 返回 `count:201`、
 * `error:null`，而 root 外的 valuable.txt 被删掉。
 *
 * 修法：`realpath()` 解析整条路径（Windows 上会解开 junction），
 * 再拿**解析后的 root** 做包含校验。任何一步解析不了（ENOENT/权限）都返回 false
 * —— 宁可不删，不可误删。
 *
 * @returns {Promise<boolean>}
 */
export async function isRealPathInside(root, target) {
  let realRoot;
  let realTarget;
  try {
    realRoot = await realpath(root);
  } catch {
    return false; // root 解析不了 → 不做任何破坏性操作
  }
  try {
    realTarget = await realpath(target);
  } catch {
    return false;
  }
  return isInside(realRoot, realTarget);
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
 * @returns {Promise<{count: number, paths: string[], skipped: string[], error: string|null, rootPresent: boolean}>}
 *        `error` 非 null 表示「**没能完成删除**」（不是「没有可删」）—— 调用方必须把它当作失败上报，
 *        详见下面 root 读取分支的说明。
 */
export async function removeArtifacts(sessionId, options = {}) {
  return removeArtifactsWithFs(sessionId, options, { readdir, lstat, rm });
}

/**
 * `removeArtifacts` 的**可注入 fs** 版本。
 *
 * 【为什么要有这个入口】错误分支（rm 抛 EPERM、lstat 抛 EACCES）在真实文件系统上
 * 很难**确定性**触发，尤其 Windows：实测打开文件句柄也拦不住 rm。
 * 代价是这些分支长期没有测试覆盖 —— 变异测试当场抓到：把「rm 失败要记进 failures」
 * 那一行删掉（N3）、把「lstat 非 ENOENT 要记 failure」删掉（N4），全套测试**全绿**。
 * 也就是说那两行当时**没有测试保护**。
 * 现在把它们变成可注入、可确定性验证的分支；生产路径仍走上面的真实 fs。
 *
 * @param {string} sessionId
 * @param {object} options 同 removeArtifacts
 * @param {{readdir?: Function, lstat?: Function, rm?: Function}} fs 注入点（缺省用真实 node:fs/promises）
 */
export async function removeArtifactsWithFs(sessionId, options = {}, fs = {}) {
  if (!isValidSessionId(sessionId)) throw new Error("invalid sessionId");
  const doReaddir = fs.readdir ?? readdir;
  const doLstat = fs.lstat ?? lstat;
  const doRm = fs.rm ?? rm;

  const root = options.root ?? sessionsRoot();
  const matchAlternate = options.matchAlternateIdSpelling === true;
  const isKnownSession = typeof options.isKnownSession === "function" ? options.isKnownSession : null;
  const names = candidateNames(sessionId, matchAlternate);

  // 【P0 修复 · 2026-10-18 实测复现】原来这里 `catch { return {count:0} }` 把**所有**
  // readdir 失败都当成「根不存在，没什么可删」。但 readdir 抛错的原因远不止「不存在」：
  //   · ENOTDIR —— sessions 是文件（实测：删完仍报 ok:true、partial:false）
  //   · EACCES  —— 权限不足
  //   · EPERM / EBUSY / EMFILE —— Windows 句柄占用、句柄耗尽
  //   · EIO     —— 磁盘错误
  // 这些一律是「**没能删掉**」，却与「这个会话没有磁盘工件」返回了**完全相同**的结构，
  // 于是上层（`deleteSession` → HTTP → UI）把它当完整成功展示 ——
  // 一次完全没碰磁盘的删除，用户看到的是「成功」。
  // 现在三态分明：
  //   · ENOENT      → rootPresent:false, error:null  （根不存在 = 真的没有可删，正常）
  //   · 其它错误     → error 如实带上，count 保持 0（调用方据此判定失败）
  const removed = [];
  const skipped = [];
  const failures = [];
  // 【P1 补强 · 2026-10-18】`skipped` 原来是纯路径数组，「为什么跳过」不可诊断。
  // 现在并行维护结构化明细（`{path, reason}`），`skipped` 保留字符串形态以兼容既有契约与界面。
  const skippedDetails = [];
  const skip = (path, reason) => {
    skipped.push(path);
    skippedDetails.push({ path, reason });
  };
  // 【P1 补强 · 删除前二次确认】见 docs/删除安全残留分析.md §4.1。
  // 宿主**没有**把写锁暴露给插件（SessionWriteLease 是内部模块，唯一外部表现是
  // resume 时的 session/writer-held 错误），因此无法原子互斥。能实现的最保守策略是：
  // 在**每个**实际 rm 之前再问一次运行态，把「检查—删除」窗口从整个事务压到单次探测。
  const beforeDelete = typeof options.beforeDelete === "function" ? options.beforeDelete : null;
  let projects;
  let error = null;
  let rootPresent = true;
  try {
    projects = await doReaddir(root, { withFileTypes: true });
  } catch (cause) {
    const code = cause?.code;
    if (code === "ENOENT") {
      rootPresent = false; // 根不存在：没有可删的东西，这是正常收尾
    } else {
      error = `${code ?? "unknown"}: ${String(cause?.message ?? cause)}`;
    }
    return { count: 0, paths: [], skipped: [], failures, error, rootPresent };
  }

  for (const proj of projects) {
    // 【P1 补强 · 链接项目目录不再静默】Windows 上 readdir 对任何重解析点
    // （mklink /J、/D、文件符号链接）都报 isDirectory:false / isSymbolicLink:true（实测）。
    // 跳过它**方向是对的**（不跟进链接 → 不会越界删除），但原来是**静默**的：
    // 若某会话的数据只在链接指向处，删除会报 complete:true 而数据没删 ——
    // 这正是任务书 §4.3 说的「把跳过了潜在数据报告为完整成功」。
    if (!proj.isDirectory() || proj.isSymbolicLink?.() === true) {
      const linkPath = join(root, proj.name);
      if (proj.isSymbolicLink?.() === true) {
        // 只有真链接才值得报；普通文件（如 .DS_Store）跳过即可，不制造噪音。
        skip(linkPath, "project-dir-is-link");
      }
      continue;
    }
    for (const candidate of names) {
      // 非精确拼写必须有守卫结论，否则不碰（防止删掉同名的另一个会话）。
      if (candidate !== sessionId && isKnownSession === null) {
        // 守卫不可用 —— 保守跳过对偶拼写，并说明原因（原来是静默 continue）。
        if (candidate !== sessionId) skip(join(root, proj.name, candidate), "alternate-spelling-guard-unavailable");
        continue;
      }
      if (candidate !== sessionId && isKnownSession(candidate)) {
        skip(join(root, proj.name, candidate), "is-another-known-session");
        continue;
      }

      const dir = join(root, proj.name, candidate);
      if (!isInside(root, dir)) continue; // 双保险

      let info;
      try {
        info = await doLstat(dir);
      } catch (cause) {
        // 【P1 修复 · 2026-10-18】原来这里一律 `catch { continue }`，把**所有** lstat
        // 失败都当成「这个会话没有这个目录」。但 lstat 失败远不止 ENOENT：
        //   EACCES/EPERM —— 权限不足（实测：deny 在某目录上时 rm 会 EPERM，
        //                   而 lstat 失败被吞成「不存在」→ 调用方看到成功）
        //   ELOOP        —— 链接层数异常
        //   EBUSY / EIO  —— 占用 / IO 错误
        // 这些是「**没能确认也没有删**」，必须如实上报，否则又是一次「静默成功」。
        if (cause?.code !== "ENOENT") {
          failures.push(`${dir} :: lstat ${cause?.code ?? "unknown"}: ${String(cause?.message ?? cause)}`);
        }
        continue; // ENOENT 确实等于「不存在」——正常跳过
      }
      // 符号链接一律跳过：rm 递归跟随链接会把删除动作带到 root 之外。
      if (info.isSymbolicLink() || !info.isDirectory()) {
        skip(dir, "candidate-is-link-or-not-dir");
        continue;
      }

      // 【P0 修复 · 越界删除】字符串校验（上面那个 isInside）挡不住**父组件**是
      // junction/符号链接的情况。破坏性删除前必须按**真实路径**再确认一次：
      // realpath 会解开路径里的链接，解析结果若落在 root 之外就绝不删。
      // 实测（竞态版）：不查这一步时 count:201、error:null，root 外的文件被删。
      if (!(await isRealPathInside(root, dir))) {
        skip(dir, "realpath-escapes-root");
        failures.push(`${dir} :: 真实路径落在会话根之外（疑似符号链接/junction 逃逸），已拒绝删除`);
        continue;
      }

      // 【P1 补强 · 删除前二次确认】紧贴 rm 再问一次运行态（见文件顶部 beforeDelete 说明）。
      // 回调判定为「不安全 / 状态不可知」时**拒绝删除并如实上报**，绝不静默按 idle 处理。
      if (beforeDelete !== null) {
        let verdict;
        try {
          verdict = await beforeDelete(dir);
        } catch (cause) {
          // 二次确认自身失败 = 状态不可知 = **不敢删**（fail-closed）。
          verdict = { ok: false, reason: `recheck-failed: ${String(cause?.message ?? cause)}` };
        }
        if (verdict !== null && verdict !== undefined && verdict.ok !== true) {
          skip(dir, verdict.reason ?? "pre-delete-recheck-refused");
          failures.push(`${dir} :: 删除前二次确认未通过（${verdict.reason ?? "unknown"}），已拒绝删除`);
          continue;
        }
      }

      // 【P0 修复】`rm` 本身失败（EACCES/EPERM/EBUSY/占用）原来是**异常直抛**，
      // 整条事务会落到 deleteSession 的 catch → 报 internal 失败。
      // 那条路径其实是**诚实**的（确实失败了），但会丢掉「其它目录已经删掉」的事实，
      // 让人误以为整条没动。现在逐目录捕获：失败如实记进 failures，其余继续删完。
      try {
        await doRm(dir, { recursive: true, force: true });
        removed.push(dir);
      } catch (cause) {
        failures.push(`${dir} :: ${cause?.code ?? "unknown"}: ${String(cause?.message ?? cause)}`);
      }
    }
  }

  return {
    count: removed.length,
    paths: removed,
    skipped,
    skippedDetails,
    failures,
    error: failures.length > 0 ? failures.join("; ") : null,
    rootPresent,
  };
}

/**
 * 删除派生的投影缓存条目。
 * 为什么算在交付范围内：projcache 是「会话的派生产物」，删掉会话却留着它，
 * 下次打开同名 id 会读到过期折叠状态。它是精确文件名，风险远低于目录递归删除。
 *
 * @returns {Promise<{count: number, paths: string[], skipped: string[], failures: string[], error: string|null, rootPresent: boolean}>}
 *        `error` 的语义与 removeArtifacts 一致：非 null = **没能完成删除**，不是「没有可删」。
 */
export async function removeProjectionCache(sessionId, options = {}) {
  if (!isValidSessionId(sessionId)) throw new Error("invalid sessionId");

  const root = options.root ?? projectionCacheRoot();
  const matchAlternate = options.matchAlternateIdSpelling === true;
  const isKnownSession = typeof options.isKnownSession === "function" ? options.isKnownSession : null;
  const names = candidateNames(sessionId, matchAlternate);

  const removed = [];
  const skipped = [];
  const failures = [];
  const skippedDetails = [];
  const skip = (path, reason) => {
    skipped.push(path);
    skippedDetails.push({ path, reason });
  };

  for (const candidate of names) {
    if (candidate !== sessionId && isKnownSession === null) {
      skip(join(root, `${candidate}.json`), "alternate-spelling-guard-unavailable");
      continue;
    }
    if (candidate !== sessionId && isKnownSession(candidate)) {
      skip(join(root, `${candidate}.json`), "is-another-known-session");
      continue;
    }

    const file = join(root, `${candidate}.json`);
    if (!isInside(root, file)) continue;

    let info;
    try {
      info = await lstat(file);
    } catch (cause) {
      // 与 removeArtifacts 同理：只有「这个条目确实不存在」才等于「没有缓存文件」。
      // ENOENT = 根不存在 / 条目不存在；ENOTDIR = **投影缓存根的位置上是普通文件**
      // （实测：Windows 的 lstat 报 ENOENT，Linux 报 ENOTDIR）—— 这个名称根本不可能
      // 存在，两者都是「没有可删」，不是「没删掉」。其余（EACCES / EPERM / EIO …）
      // 才是没能完成，必须如实记 failure，绝不能吞成「不存在」。
      const lstatCode = cause?.code;
      if (lstatCode !== "ENOENT" && lstatCode !== "ENOTDIR") {
        failures.push(`${file} :: lstat ${lstatCode ?? "unknown"}: ${String(cause?.message ?? cause)}`);
      }
      continue;
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      skip(file, "candidate-is-link-or-not-file");
      continue;
    }

    // 与 removeArtifacts 同理：真实路径必须仍在 root 内（挡父组件链接逃逸）。
    if (!(await isRealPathInside(root, file))) {
      skip(file, "realpath-escapes-root");
      failures.push(`${file} :: 真实路径落在投影缓存根之外，已拒绝删除`);
      continue;
    }

    // 与 removeArtifacts 同理：单个文件删不掉不能静默通过。
    try {
      await rm(file, { force: true });
      removed.push(file);
    } catch (cause) {
      failures.push(`${file} :: ${cause?.code ?? "unknown"}: ${String(cause?.message ?? cause)}`);
    }
  }

  return {
    count: removed.length,
    paths: removed,
    skipped,
    skippedDetails,
    failures,
    error: failures.length > 0 ? failures.join("; ") : null,
    rootPresent: true, // 本函数按精确文件名删除，不依赖 root 是否可列举
  };
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
