/**
 * 审计留痕 —— 删除是**不可逆**操作，删了必须留一条可查记录。
 *
 * 设计要点：
 *   1. 审计失败**绝不**让删除事务失败（写日志失败不是「没删掉」）；
 *      但成功与否都要在返回值里体现（`audit.ok`），不假装写成功了；
 *   2. 一条记录一行 JSONL，**只留诊断必需的字段**（见下）；
 *   3. 关闭审计（config.audit=false）时返回 skipped，仍然如实上报；
 *   4. 按**文件大小**轮转（config.auditMaxBytes / auditRotateKeep）。轮转失败返回
 *      可诊断的降级结果（`rotated` / `rotateError`），**不**让删除事务失败；
 *   5. 审计路径**规范化并校验**：必须落在 <DSH_HOME> 之内。越界配置不静默改路径，
 *      而是拒绝写入并如实上报 —— 否则会出现「以为审计开着，其实写去了别处」。
 *
 * ── 字段最小化（任务书 B.3）──
 * 现网实测：38 行 33.8 KB ≈ 910 B/行。原因是旧实现把整份 result.runtime、完整标题、
 * 全部 removedPaths 都塞进了一行 —— 那不是留痕，是备份删除结果。
 * 现在只写这些**诊断必需**字段：
 *   · time                   何时发生
 *   · action / actor / phase 操作类型 / 谁触发（短标识）/ 停在哪一步
 *   · sessionId              唯一必要的对象标识（删的是哪条）
 *   · result.ok / result.code          结果状态与可检索的错误码
 *   · result.files / cacheFiles        **只留计数**，用于事后对账；不留 200 条路径
 *   · result.degradations             只留 {step, reason}；failures 明细丢弃
 *   · result.tookMs                   耗时（性能回归用）
 *   · result.error                    截断后的错误文案（定长上限）
 * 明确**不写**：result.runtime（整份环境快照）、标题、removedPaths/cachePaths 全量数组。
 * 需要明细时按 sessionId 去宿主日志里查。
 */

import { appendJsonLine, dshHome, isInside } from "./artifacts.js";
import { isAbsolute, join, normalize, resolve } from "node:path";
import { rename, rm, stat } from "node:fs/promises";

/**
 * result.error 与降级 reason 的截断长度。
 *
 * 【为什么 240 —— 这是「字段最小化」的兜底】
 * 每个字符串字段都过 clamp：即便上游把一整份异常栈或 10 KB 的路径塞进 message，
 * 一行也不会被撑爆。正常行实测约 300 B。
 */
const MAX_TEXT_CHARS = 240;
/** 轮转后保留的**历史**份数（不含当前文件）。 */
export const DEFAULT_ROTATE_KEEP = 3;
/** 默认轮转阈值 4 MiB：按 300 B/行算约 1.4 万条，够查一个季度的删除记录。 */
export const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
/**
 * 两次 stat 之间的最小写入量。绝大多数写入因此**完全不碰文件系统元数据**
 * （热路径只做一次 appendFile）；代价是文件可能超阈值最多 64 KiB，可接受。
 */
const CHECK_EVERY_BYTES = 64 * 1024;

/** 默认审计文件路径。 */
export function defaultAuditPath(env = process.env) {
  return join(dshHome(env), "logs", "dialogue-cleanup.jsonl");
}

/** 把任意值收敛成定长字符串（对象序列化失败也要给出可诊断的东西）。 */
function clamp(value, max = MAX_TEXT_CHARS) {
  let text;
  if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  if (text === undefined) text = String(value);
  return text.length <= max ? text : `${text.slice(0, max)}…(truncated ${text.length - max})`;
}

/** result 里**允许**落盘的键（其余一律丢弃）。 */
const RESULT_KEYS = new Set(["ok", "code", "files", "cacheFiles", "tookMs", "error", "degradations"]);
/** 降级清单落盘条数上限（异常情况下防撑爆单行）。 */
const MAX_DEGRADATIONS = 32;

/** 只保留诊断必需字段的 result 投影。 */
function projectResult(result) {
  if (result === null || typeof result !== "object") return null;
  const out = {};
  for (const key of RESULT_KEYS) {
    const value = result[key];
    if (value === undefined) continue;
    if (key === "error") out.error = clamp(value);
    else if (key === "degradations") {
      if (!Array.isArray(value)) continue;
      out.degradations = value.slice(0, MAX_DEGRADATIONS).map((d) => ({
        step: clamp(d?.step, 64),
        ...(d?.reason === undefined ? {} : { reason: clamp(d.reason) }),
      }));
    } else out[key] = value;
  }
  return out;
}

/**
 * 规范化审计路径并做归属校验。纯函数，可直接测。
 *
 * @returns {{ok: true, path: string} | {ok: false, path: string|null, error: string}}
 */
export function resolveAuditPath(rawPath, env = process.env) {
  const home = dshHome(env);
  if (rawPath !== undefined && rawPath !== null && typeof rawPath !== "string") {
    return { ok: false, path: null, error: "auditPath must be a string" };
  }
  const configured = typeof rawPath === "string" && rawPath !== "" ? rawPath : defaultAuditPath(env);
  // 先 normalize 收拢 `.` / `..` / 多余分隔符，再 resolve 成绝对路径：
  // 相对路径以 DSH_HOME 为基准，这样写入点始终可预测。
  const normalized = normalize(configured);
  const path = resolve(isAbsolute(normalized) ? normalized : resolve(home, normalized));
  if (path.includes("\0")) return { ok: false, path: null, error: "auditPath contains NUL" };
  if (!isInside(home, path)) {
    return { ok: false, path, error: `auditPath escapes DSH_HOME (${home}): ${path}` };
  }
  return { ok: true, path };
}

/** 轮转：current → .1，.1 → .2 …；超出 keep 的最旧一份删除。 */
async function rotate(filePath, keep) {
  // 从最旧往新推，避免互相覆盖。
  try {
    await rm(`${filePath}.${keep}`, { force: true });
  } catch (error) {
    // ENOENT = 该份不存在，正常。EISDIR / EPERM 等必须抛给调用方（如实上报轮转失败）。
    if (error?.code !== "ENOENT") throw error;
  }
  for (let i = keep - 1; i >= 1; i -= 1) {
    try {
      await rename(`${filePath}.${i}`, `${filePath}.${i + 1}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  try {
    await rename(filePath, `${filePath}.1`);
    return true; // 真的挪走了一份
  } catch (error) {
    if (error?.code === "ENOENT") return false; // 当前文件还没建：无事发生
    throw error;
  }
}

/**
 * 创建审计器。
 *
 * 返回值里的 `audit.ok === false` 与调用方自己的「删除结果」是**两件不同的事实**：
 * 前者只表示留痕失败，调用方应把它计入降级清单，但不得因此把删除报成回滚/失败。
 *
 * @param {object} config resolveConfig() 的产物（或等价对象）
 * @param {object} [logger]
 */
export function createAudit(config, logger) {
  const enabled = config?.audit !== false;
  const maxBytes =
    Number.isInteger(config?.auditMaxBytes) && config.auditMaxBytes >= 0 ? config.auditMaxBytes : DEFAULT_MAX_BYTES;
  const keep =
    Number.isInteger(config?.auditRotateKeep) && config.auditRotateKeep >= 1 ? config.auditRotateKeep : DEFAULT_ROTATE_KEEP;

  const resolved = enabled ? resolveAuditPath(config?.auditPath) : { ok: false, path: null, error: null };
  const filePath = resolved.ok ? resolved.path : null;
  // 被拒绝的路径只在 pathError 里出现，**不**作为 audit.path 对外暴露：
  // 否则 /status 或界面会把一个「其实没在写」的路径显示成正在生效的审计文件。
  const rejectedPath = resolved.ok ? null : resolved.path;
  const pathError = resolved.ok ? null : resolved.error;
  const mode = !enabled ? "disabled" : resolved.ok ? "append" : "invalid-path";
  if (pathError) logger?.warn?.(`dialogue-cleanup: audit disabled for this run: ${pathError}`);

  // 只用于判断「该不该 stat」。null = 还没探过；<0 = 该路径上不是普通文件。
  let knownBytes = null;
  let sinceLastStat = 0;

  /** 写一行。永不抛 —— 审计的任何失败都只是返回值里的一项。 */
  async function record(entry) {
    if (!enabled) return { ok: true, path: null, skipped: true, mode: "disabled", rotated: false };
    if (!resolved.ok) {
      return { ok: false, path: null, mode: "invalid-path", rotated: false, error: pathError, rejectedPath };
    }

    const source = entry !== null && typeof entry === "object" ? entry : {};
    const line = {
      time: new Date().toISOString(),
      plugin: "dialogue-cleanup",
      ...(source.action === undefined ? {} : { action: clamp(source.action, 64) }),
      ...(source.actor === undefined ? {} : { actor: clamp(source.actor, 128) }),
      ...(source.phase === undefined ? {} : { phase: clamp(source.phase, 64) }),
      ...(source.reason === undefined ? {} : { reason: clamp(source.reason) }),
      ...(source.sessionId === undefined ? {} : { sessionId: clamp(source.sessionId, 128) }),
      ...(source.result === undefined ? {} : { result: projectResult(source.result) }),
    };
    // 落盘用**同一个字符串**做字节计数，避免「算一份、写一份」漂移。
    const text = `${JSON.stringify(line)}\n`;
    const bytes = Buffer.byteLength(text, "utf8");

    let rotated = false;
    let rotateError = null;
    try {
      if (maxBytes > 0) {
        if (knownBytes === null || sinceLastStat >= CHECK_EVERY_BYTES) {
          try {
            const info = await stat(filePath);
            knownBytes = info.isFile() ? info.size : -1;
          } catch (error) {
            if (error?.code === "ENOENT") knownBytes = 0;
            else if (knownBytes === null) knownBytes = 0; // 探不到就按 0 走，append 自己会报错
          }
          sinceLastStat = 0;
        }
        // knownBytes < 0：该路径上不是普通文件（目录等）。不轮转、不删除，
        // 让 append 失败并如实上报 —— 误删一个目录比少写一行审计严重得多。
        if (knownBytes >= 0 && knownBytes + bytes > maxBytes) {
          try {
            rotated = await rotate(filePath, keep);
            knownBytes = 0;
          } catch (error) {
            // 轮转失败不清零计数（否则每行都重试），也**不**阻断写入：
            // 日志继续长总比丢审计好，降级原因如实返回。
            rotateError = clamp(error?.message ?? error);
            logger?.warn?.(`dialogue-cleanup: audit rotation failed: ${rotateError}`);
          }
        }
      }

      await appendJsonLine(filePath, line);
      if (knownBytes !== null && knownBytes >= 0) knownBytes += bytes;
      sinceLastStat += bytes;
      return {
        ok: true,
        path: filePath,
        mode: "append",
        rotated,
        ...(rotateError ? { rotateError } : {}),
      };
    } catch (error) {
      const message = clamp(error?.message ?? error);
      logger?.warn?.(`dialogue-cleanup: audit write failed: ${message}`);
      return {
        ok: false,
        path: filePath,
        mode: "append",
        rotated,
        ...(rotateError ? { rotateError } : {}),
        error: message,
      };
    }
  }

  return { record, path: enabled ? filePath : null, enabled, mode, pathError, rotation: { maxBytes, keep } };
}
