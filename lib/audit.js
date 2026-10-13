/**
 * 审计留痕 —— 删除是**不可逆**操作，删了必须留一条可查记录。
 *
 * 设计要点：
 *   1. 审计失败**绝不**让删除事务失败（写日志失败不是「没删掉」）；
 *      但成功与否都要在返回值里体现（`audit.ok`），不假装写成功了；
 *   2. 一条记录一行 JSONL，含 actor / 请求来源 / 结果 / 耗时 —— 便于事后归因；
 *   3. 关闭审计（config.audit=false）时返回 skipped，仍然如实上报。
 */

import { appendJsonLine } from "./artifacts.js";
import { dshHome } from "./artifacts.js";
import { join } from "node:path";

export function defaultAuditPath(env = process.env) {
  return join(dshHome(env), "logs", "dialogue-cleanup.jsonl");
}

export function createAudit(config, logger) {
  const filePath = config?.auditPath ?? defaultAuditPath();
  const enabled = config?.audit !== false;

  /**
   * @param {object} entry
   * @returns {Promise<{ok: boolean, path: string|null, skipped?: boolean, error?: string}>}
   */
  async function record(entry) {
    if (!enabled) return { ok: true, path: null, skipped: true };
    const line = {
      time: new Date().toISOString(),
      plugin: "dialogue-cleanup",
      ...entry,
    };
    try {
      await appendJsonLine(filePath, line);
      return { ok: true, path: filePath };
    } catch (error) {
      const message = String(error?.message ?? error);
      logger?.warn?.(`dialogue-cleanup: audit write failed: ${message}`);
      return { ok: false, path: filePath, error: message };
    }
  }

  return { record, path: enabled ? filePath : null, enabled };
}
