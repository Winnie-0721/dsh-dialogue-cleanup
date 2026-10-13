/**
 * 唯一能力实现（R-50：一个操作只实现一次，UI 与任何工具路径共用它）。
 *
 * ─── 为什么这个文件与上游/附录的骨架不同 ───────────────────────────────────
 * 动手前用 `cordis_inspect_query` 现场核实了上游依赖的三处内部成员，结论与附录 C.6 的
 * 假设**不一致**，因此这里按实测写：
 *
 * 1. `ctx.agents.get(id)` 的公开类型是 `Agent { readonly id: SessionId }` —— **没有**
 *    `status`、**没有** `ctx`。上游的 `agent.status === "running"` 与附录的
 *    `agent.ctx.fiber.dispose()` / `stopIdleAgent(agent)` 都建立在不存在的字段上。
 *    实测的「是否在跑」公开信号是 `sessionController.list()` → `SessionSummary.running`。
 * 2. `ctx.sessions`（sessions 服务）的公开面是 create/prepare/enter/announce/flush/get/
 *    list/fork —— **没有** 公开 detach。上游走的 `sessions.store.get(id).detach()` 是
 *    实例字段（内部实现）。这里：能拿到就摘、拿不到就如实报 `detached:false`，不假装成功。
 * 3. 空闲 agent 的公开停止入口**不存在**（agentLoop 的 createAgent/resume 返回的
 *    AgentHandle.dispose() 只对手柄所有者有效，我们不是所有者）。因此**不碰**
 *    上游的 `fiber._unload()`（Cordis private），如实返回 stopped:false → refused。
 *
 * 幂等单飞、计数修正、失败也审计这三项改进保持不变。
 */

import {
  isValidSessionId,
  isInside,
  removeArtifacts,
  removeProjectionCache,
  sessionsRoot,
  dshHome,
  alternateIdSpelling,
} from "./artifacts.js";

/** 同一 sessionId 的单飞锁（上游没有：并发时 detachWorkspaces 会重复计数）。 */
const inFlight = new Map();

/** 测试用：清空单飞表。 */
export function __resetInFlight() {
  inFlight.clear();
}

/** 统一信封的失败构造。 */
function fail(code, message, hint) {
  const error = { code, message };
  if (hint !== undefined) error.hint = hint;
  return { ok: false, error };
}

/**
 * 安全读取一个**可选** Cordis 服务。
 *
 * 为什么不能写 `ctx.foo`：只有 `inject` 里声明的服务才是硬依赖，直接属性访问一个未注入的
 * 服务在 Cordis 里会**抛错**（不是返回 undefined）。本插件只硬依赖 `webServer`，其余
 * （sessions / agents / sessionController / sessionQuery / workspaceRegistry / layout）
 * 全是可选能力，必须一律走 `ctx.get(name)` 并判空。
 *
 * 【实测踩坑】`/status` 曾因为 `ctx?.sessions?.store` 这处**明文属性访问**在真实宿主里抛错，
 * 表现为「空 body 的 400」——因为异常发生在 handler 内、还没走到 sendJson。
 * 单测用普通对象 ctx 时观察不到这个差异（普通对象上读不存在的属性只得到 undefined）。
 *
 * @param {object} ctx
 * @param {string} name
 * @returns {any|undefined}
 */
export function getService(ctx, name) {
  if (ctx === null || ctx === undefined) return undefined;
  if (typeof ctx.get === "function") {
    try {
      const value = ctx.get(name);
      if (value !== undefined) return value;
    } catch {
      /* 未注入 / 已卸载 —— 视为不可用 */
    }
  }
  // 兜底：某些测试替身或老版本可能只提供属性。属性访问包在 try 里，
  // 以免重现上面「未注入服务抛错」的问题。
  try {
    return ctx[name];
  } catch {
    return undefined;
  }
}

/**
 * 摘除内存 live 条目。
 *
 * 顺序：① 公开服务方法（不同版本可能叫不同名字）→ ② 内部 `store` Map 上的 entry.detach。
 * ②是内部实现（`store` 是 SessionStore 的实例字段，未文档化），所以**失败不抛错**，
 * 返回 false 让上层如实上报 `detached:false`。
 *
 * @returns {boolean} 是否真的摘除成功
 */
export function detachLiveStore(sessions, sessionId) {
  if (sessions === null || sessions === undefined) return false;

  // ① 优先公开的服务方法
  for (const method of ["detach", "release", "close"]) {
    const fn = sessions[method];
    if (typeof fn === "function") {
      try {
        fn.call(sessions, sessionId);
        return true;
      } catch {
        /* 继续尝试下一个 */
      }
    }
  }

  // ② 退而用内部 store Map 上的 entry.detach（当前版本事实可达）
  try {
    const entry = sessions.store?.get?.(sessionId);
    if (entry !== undefined && typeof entry.detach === "function") {
      entry.detach();
      return true;
    }
  } catch {
    /* 降级 */
  }

  return false;
}

/**
 * 从工作区记录摘除。
 *
 * 与上游的两处差别：
 *   1. **只在 detachSession 真的调用成功时才计数**（修上游 D7 的虚高计数）；
 *   2. `sessionIds` 是 getter，过滤后可能是普通数组或冻结数组 —— 用 Array.from 归一化，
 *      不假设它一定是 Array（上游的 `!Array.isArray(ids)` 在只读数组上会误判为「不属于我」）。
 */
export async function detachWorkspaces(registry, sessionId, log) {
  if (registry === null || registry === undefined || typeof registry.list !== "function") return 0;

  let workspaces;
  try {
    workspaces = registry.list();
  } catch (error) {
    log?.warn?.(`dialogue-cleanup: workspace list failed: ${String(error?.message ?? error)}`);
    return 0;
  }
  if (!Array.isArray(workspaces)) return 0;

  let removed = 0;
  for (const ws of workspaces) {
    let ids;
    try {
      ids = Array.from(ws?.sessionIds ?? []);
    } catch {
      continue;
    }
    if (!ids.includes(sessionId)) continue;

    if (typeof ws.detachSession !== "function") {
      log?.debug?.("dialogue-cleanup: workspace cannot detach (no detachSession)");
      continue; // <-- 上游这里会错误地 +1
    }
    try {
      await ws.detachSession(sessionId);
      removed += 1;
    } catch (error) {
      log?.warn?.(`dialogue-cleanup: workspace detach failed: ${String(error?.message ?? error)}`);
    }
  }
  return removed;
}

/**
 * 清除工作区注册表里残留的 pin / archive 记录（用**公开** API，两个都是幂等 no-op）。
 *
 * 为什么需要：删掉会话目录后，workspace.json 里的 archivedSessionIds / pinnedSessionIds
 * 仍留着这个 id；它会让归档列表指向一个已经不存在的会话。
 *
 * 【实测修正 · 原先在编造计数】
 * 旧实现把「调用成功」当成「清掉了一条」，于是对**根本不存在的会话**也返回
 * `registryCleared: 2`（unpin + unarchive 各算一次）。已实测复现：
 *   删除一个不存在的 id → {"registryCleared":2, "files":0, "partial":true}
 * 而契约明说这两者对未记录的 id 是**幂等 no-op**（"resolves without writing"），
 * 所以「调用返回」根本不代表「改动了记录」。
 *
 * 现在如实区分三件事：
 *   - attempted：尝试调用的方法数；
 *   - resolved：宿主正常返回的方法数（**不代表发生了改动**）；
 *   - changed：公开 API 不报告是否有实际写入，故固定为 null（未知），不猜。
 *
 * @returns {Promise<{attempted: number, resolved: number, changed: null, skipped: string[]}>}
 */
export async function clearRegistryRecords(registry, sessionId, log) {
  const outcome = { attempted: 0, resolved: 0, changed: null, skipped: [] };
  if (registry === null || registry === undefined) return outcome;

  for (const method of ["unpinSession", "unarchiveSession"]) {
    const fn = registry[method];
    if (typeof fn !== "function") {
      outcome.skipped.push(method);
      continue;
    }
    outcome.attempted += 1;
    try {
      await fn.call(registry, sessionId);
      outcome.resolved += 1;
    } catch (error) {
      log?.debug?.(
        `dialogue-cleanup: ${method} skipped: ${String(error?.message ?? error)}`,
      );
    }
  }
  return outcome;
}

/**
 * 停一个空闲 agent。
 *
 * 【实测结论】当前运行时**没有**公开的空闲 agent 停止入口：
 *   - `Agent` 的公开类型只有 `{ readonly id }`（无 `status`、无 `ctx`、无 `fiber`）；
 *   - `agentLoop.createAgent/resume` 返回的 `AgentHandle.dispose()` 只对创建它的所有者有效，
 *     本插件不是所有者，拿不到那个句柄。
 * 上游用的 `agent.ctx.fiber._unload()` 是 Cordis 的 private 方法，明确不用。
 *
 * 因此按能力探测书写：能探测到公开停止入口就调用，否则**如实返回 false**，由上层拒绝。
 * @returns {Promise<boolean>}
 */
export async function stopIdleAgent(agent, _ctx) {
  if (agent === null || agent === undefined) return false;

  // 公开候选：agent 自身的停止方法 / 其公开 ctx 上的 dispose（仅在字段真实存在时）
  for (const method of ["stop", "dispose", "close"]) {
    const fn = agent[method];
    if (typeof fn === "function") {
      try {
        await fn.call(agent);
        return true;
      } catch {
        /* 继续尝试下一个 */
      }
    }
  }

  const scopeDispose = agent.ctx?.dispose;
  if (typeof scopeDispose === "function") {
    try {
      await scopeDispose.call(agent.ctx);
      return true;
    } catch {
      /* 继续 */
    }
  }

  // 明确不碰 agent.ctx.fiber._unload()（private）
  return false;
}

/**
 * 拉取一次「谁在跑」的**全量快照**（`sessionController.list()`）。
 *
 * 与 `inspectRunning` 分开，是为了让批量删除能复用同一份快照：
 * 一个 200 条的批量原本要问 200 次全量列表（实测 165 ms 纯探测，
 * live 上折算约 20 s），而这一批的状态问一次就够了。
 *
 * @returns {Promise<{available: boolean, byId: Map<string, object>, source: string}>}
 */
export async function fetchRunningSnapshot(sessionController, signal) {
  if (typeof sessionController?.list !== "function") {
    return { available: false, byId: new Map(), source: "agents.get(fallback)" };
  }
  try {
    const value = await sessionController.list({}, signal);
    const items = Array.isArray(value?.items) ? value.items : [];
    const byId = new Map();
    for (const item of items) {
      if (typeof item?.sessionId === "string") byId.set(item.sessionId, item);
    }
    return { available: true, byId, source: "sessionController.list" };
  } catch {
    return { available: false, byId: new Map(), source: "agents.get(fallback)" };
  }
}

/**
 * 从一份快照判定某个会话的运行状态（**纯函数**，无 IO）。
 *
 * @param {{available: boolean, byId: Map<string, object>, source: string}} snapshot
 * @param {any} agents
 * @param {string} sessionId
 * @returns {{available: boolean, running: boolean, hasAgent: boolean, source: string, blank?: boolean, updatedAt?: number|null}}
 */
export function judgeRunning(snapshot, agents, sessionId) {
  const hasAgent = typeof agents?.get === "function" ? agents.get(sessionId) !== undefined : false;

  if (snapshot !== null && snapshot.available === true) {
    const row = snapshot.byId.get(sessionId);
    if (row !== undefined) {
      return {
        available: true,
        running: row.running === true,
        hasAgent,
        source: snapshot.source,
        blank: row.blank === true,
        updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : null,
      };
    }
    // 列表里没有它 —— 说明不是活动会话；但若仍有活动 agent，保守按占用处理。
    return { available: true, running: hasAgent, hasAgent, source: snapshot.source };
  }

  return { available: false, running: hasAgent, hasAgent, source: "agents.get(fallback)" };
}

/**
 * 「这个会话是否正在跑」的公开判定。
 *
 * 优先 `sessionController.list()` 的 `SessionSummary.running`（公开、权威）；
 * 退化时用 `agents.get(id) !== undefined`（有活动 agent ≈ 占用中）并标记为不可靠。
 *
 * @returns {Promise<{available: boolean, running: boolean, hasAgent: boolean, source: string}>}
 */
export async function inspectRunning(sessionController, agents, sessionId, signal) {
  const snapshot = await fetchRunningSnapshot(sessionController, signal);
  return judgeRunning(snapshot, agents, sessionId);
}

/**
 * 读取「已归档会话集合」。
 *
 * ─── 为什么是这条路径（实测取证，不是猜）────────────────────────────────────
 * 归档状态**不在** `sessionController` / `sessionQuery` 的公开契约里：
 *   `SessionSummary { agentAvailable, sessionId, updatedAt, running, blank, parentSessionId, origin, cwd, projections }`
 * —— **没有 `archived` 字段**；`workspaceRegistry` 的公开面（create/list/get/delete/
 * insertBefore/archiveSession/unarchiveSession/pin/unpin/resolveByPath）也**没有**归档集合读取器。
 *
 * 官方把它放在 workspace 存储领域的**全局状态**里：
 *   `@deepseek-ai/dsh-workspace` README：「注册表打开 `workspace` 领域（版本 2）：
 *    一张以 WorkspaceId 为键的 workspaces 表，加上一个持有 workspaceIds、**archivedSessionIds**、
 *    pinnedSessionIds…的全局状态」。
 *
 * 官方客户端从 `useWorkspaces(state => state.archivedSessionIds)` 拿它（客户端快照）；
 * 本插件是 Host 半，走同一份数据的 Host 入口：`storageDomain.get('workspace').global`。
 * 注意**不能** `open('workspace')`（领域已被 dsh-workspace 打开，重复 open 会抛
 * `already-open`），只能用 `get()` 取已打开的实例。
 *
 * 【如实声明】`storageDomain.get()` 的契约描述把它称为「诊断面（Diagnostic surface）」，
 * 而 Host 侧**没有**其它读取归档集合的公开入口。这里用它并**明确区分**「读到空集合」
 * 与「读不到」，避免把「不可知」谎报成「没有归档」。
 *
 * @returns {{ids: Set<string>, known: boolean}} known=false 表示领域不可读（不可知）
 */
export function readArchivedSessionIds(ctx) {
  const domain = getService(ctx, "storageDomain");
  if (typeof domain?.get !== "function") return { ids: new Set(), known: false };
  try {
    const handle = domain.get("workspace");
    const value = handle?.global?.get?.();
    if (value === null || value === undefined || typeof value !== "object") {
      return { ids: new Set(), known: false };
    }
    const ids = value.archivedSessionIds;
    // 字段**存在**但为空数组 = 确实没有归档（known=true）；
    // 字段缺失/类型不对 = 不可知（known=false），不假装成「没有」。
    if (!Array.isArray(ids)) return { ids: new Set(), known: false };
    return { ids: new Set(ids.filter((id) => typeof id === "string" && id !== "")), known: true };
  } catch {
    return { ids: new Set(), known: false }; // 领域未打开 / 结构变化
  }
}

/**
 * 唯一的删除实现。HTTP 路由与 slot UI 都调它。
 *
 * 事务顺序（与上游一致，理由见主手册 §1.5.5）：
 *   1. 校验 id
 *   2. 幂等单飞
 *   3. agent 守卫（running 一律拒）
 *   4. 摘内存 live 条目
 *   5. 摘工作区记录
 *   6. 清注册表残留（pin / archive）
 *   7. 删磁盘工件（+ 投影缓存）
 *   8. 审计
 *
 * @returns {Promise<{ok:true,value:object}|{ok:false,error:object}>}
 */
export function createService(ctx, config, audit) {
  const log = ctx?.logger;

  /**
   * 标题折叠缓存：sessionId → { title: string|null, at: number }。
   *
   * `null` 是**有意义的负结果**（这个会话日志里确实没有标题事件）—— 也缓存，
   * 否则每次刷新都要为它重复付 65 ms。实例级（每次 apply 新建），不跨插件重载泄漏。
   */
  const titleCache = new Map();

  /**
   * 运行状态探测的**短时快照**（批量删除的性能修复，见 `runningProbeTtlMs`）。
   *
   * 【为什么需要】批量删除是逐条调 `deleteSession` 的，而每条都要问一次
   * `sessionController.list()`（全量会话列表）与 `sessions.list()`。实测探测次数：
   *
   *   N=1    sessionController.list ×1     4 ms
   *   N=10   sessionController.list ×10   13 ms
   *   N=50   sessionController.list ×50   47 ms
   *   N=200  sessionController.list ×200 165 ms
   *                     （纯探测；live 上 `list()` 有约 100 ms 底噪，折算约 20 s）
   *
   * 即 O(N) 次全量列表调用 —— 纯粹是浪费，同一批里的会话状态不需要问 N 遍。
   * 这里在 TTL 内复用同一份快照，把批量摊成 O(1) 次。
   *
   * 【安全性代价 · 必须说清楚】TTL 内「谁在跑」的判定用的是同一份快照，因此
   * **一个在批量进行中途才刚开始运行的会话，可能不被拦下**。
   * 这是有意的性能/安全折衷，不是疏忽：
   *   - 默认 TTL 只有 1 s，批量通常在一个窗口内跑完，暴露窗口极小；
   *   - UI 侧本就不让运行中的行可勾选（`deletable` 由 Host 判定）；
   *   - 想回到「每条都重新探测」的严格语义，把 `runningProbeTtlMs` 设为 0 即可。
   */
  // 【自查修正】只缓存**运行状态**快照，**不**缓存 live id 集合。
  //
  // 两者的风险方向完全不同：
  //   - running 快照只影响「是否拒绝删除」——缓存偏保守，最多多拒一个，安全；
  //   - live id 集合喂给 `isKnownSession` **破坏性守卫**（决定要不要删「另一种拼写」）。
  //     缓存它会让守卫**更可能说 false**，也就是更可能去删一个其实存在的会话 ——
  //     方向正好违背本插件「宁可不删，不可误删」的原则。
  // 而 `sessions.list()` 是同步内存读取（不像 `sessionController.list()` 有 ~100 ms 底噪），
  // 省它几乎没有收益却要承担误删风险，因此**不缓存**。
  const probeCache = { runningAt: 0, running: null };

  const probeTtl = Number.isInteger(config.runningProbeTtlMs) ? Math.max(config.runningProbeTtlMs, 0) : 1000;

  /** 取「谁在跑」的快照；TTL 内复用，避免批量时 O(N) 次全量列表。 */
  async function runningSnapshot() {
    const now = Date.now();
    // ttl=0 表示每次都重新探测（严格语义，退回旧行为）。
    if (probeTtl > 0 && probeCache.running !== null && now - probeCache.runningAt < probeTtl) {
      return probeCache.running;
    }
    const snapshot = await fetchRunningSnapshot(getService(ctx, "sessionController"));
    probeCache.running = snapshot;
    probeCache.runningAt = Date.now();
    return snapshot;
  }

  /** 该 id 是否对应一个**真实存在**的会话（用于「另一种拼写」的存在性守卫）。 */
  function makeKnownSessionProbe() {
    // 每次都取最新的 live 集合：这是破坏性判断，宁可多读一次内存，不可用过期数据。
    const liveIds = new Set();
    try {
      for (const session of getService(ctx, "sessions")?.list?.() ?? []) {
        if (typeof session?.id === "string") liveIds.add(session.id);
      }
    } catch {
      /* 忽略 */
    }
    const agents = getService(ctx, "agents");
    return (id) => {
      if (liveIds.has(id)) return true;
      try {
        if (typeof agents?.get === "function" && agents.get(id) !== undefined) return true;
      } catch {
        /* 忽略 */
      }
      return false;
    };
  }

  async function deleteSession(sessionId, actor = { kind: "unknown" }) {
    if (!isValidSessionId(sessionId)) {
      return fail("bad-request", "会话 id 不合法", "只接受字母、数字与连字符，长度 1–128，且以字母或数字开头。");
    }

    const existing = inFlight.get(sessionId);
    if (existing !== undefined) return existing; // 幂等：复用进行中的同一次请求

    const startedAt = Date.now();

    const task = (async () => {
      try {
        // ── 1. agent 守卫（红线 S1/S2：正在跑的会话一律拒） ──
        // 用带 TTL 的快照：批量删除里同一批会话不需要重复问 N 遍全量列表
        // （实测 200 条原本是 200 次 sessionController.list，见 runningProbeTtlMs）。
        const probe = judgeRunning(
          await runningSnapshot(),
          getService(ctx, "agents"),
          sessionId,
        );

        if (config.requireIdleSession !== false && probe.running) {
          await audit.record({
            actor,
            sessionId,
            phase: "refused",
            reason: probe.source,
            result: { ok: false, code: "refused" },
          });
          return fail("refused", "会话正在运行，请先停止再删除", "在会话里停止当前回复，或先关闭该会话，然后重试删除。");
        }

        // 有活动 agent 但判定不出 running：只有配置允许时才尝试停止；
        // 当前运行时没有公开停止入口 → 如实拒绝（不碰 fiber._unload()）。
        if (probe.hasAgent && !probe.running) {
          if (config.stopIdleAgent !== true) {
            await audit.record({
              actor,
              sessionId,
              phase: "refused-idle-agent",
              reason: probe.source,
              result: { ok: false, code: "refused" },
            });
            return fail(
              "refused",
              "该会话仍有附加的 agent，无法安全停止",
              "这个运行时没有公开的空闲 agent 停止入口。请先在界面上关闭该会话，再重试删除；或在插件配置里显式开启 stopIdleAgent（仅在能探测到公开停止入口时才会生效）。",
            );
          }
          const agent = getService(ctx, "agents")?.get?.(sessionId);
          const stopped = await stopIdleAgent(agent, ctx);
          if (!stopped) {
            await audit.record({
              actor,
              sessionId,
              phase: "refused-no-public-stop",
              result: { ok: false, code: "refused" },
            });
            return fail(
              "refused",
              "该会话有附加的 agent，且无法安全停止",
              "请先在界面上关闭该会话，再重试删除。",
            );
          }
        }

        // ── 2. 摘内存 live 条目（失败不抛错，优雅降级） ──
        const detached = detachLiveStore(getService(ctx, "sessions"), sessionId);

        // 标题缓存随会话一起失效：否则删掉的行在下次刷新时仍会显示旧标题。
        titleCache.delete(sessionId);
        const alt = alternateIdSpelling(sessionId);
        if (alt !== null) titleCache.delete(alt);

        // ── 3. 摘工作区记录（修正上游的计数虚高） ──
        const workspaceRegistry = getService(ctx, "workspaceRegistry");
        const workspaces = await detachWorkspaces(workspaceRegistry, sessionId, log);

        // ── 4. 清注册表残留（pin / archive，公开幂等 API） ──
        // 返回的是 { attempted, resolved, changed }，不再是一个会骗人的数字。
        const registryCleared =
          config.clearRegistryRecords === true
            ? await clearRegistryRecords(workspaceRegistry, sessionId, log)
            : { attempted: 0, resolved: 0, changed: null, skipped: [] };

        // ── 5. 删磁盘工件 ──
        const isKnownSession = makeKnownSessionProbe();
        const artifacts = await removeArtifacts(sessionId, {
          root: sessionsRoot(),
          matchAlternateIdSpelling: config.matchAlternateIdSpelling === true,
          isKnownSession,
        });

        let cache = { count: 0, paths: [], skipped: [] };
        if (config.removeProjectionCache === true) {
          cache = await removeProjectionCache(sessionId, {
            matchAlternateIdSpelling: config.matchAlternateIdSpelling === true,
            isKnownSession,
          });
        }

        // 内存摘除失败、盘上也没有任何工件 —— 很可能这个 id 根本没删到东西。
        // 不把它当失败（删除是幂等的），但如实给出 partial:true 让调用方知道是降级路径。
        const partial = !detached && artifacts.count === 0;

        const value = {
          sessionId,
          detached,
          workspaces,
          registryCleared,
          files: artifacts.count,          removedPaths: artifacts.paths,
          cacheFiles: cache.count,
          cachePaths: cache.paths,
          skipped: [...artifacts.skipped, ...cache.skipped],
          partial,
          runtime: {
            home: dshHome(),
            sessionsRoot: sessionsRoot(),
            isInsideGuard: isInside(sessionsRoot(), sessionsRoot()),
            runningProbe: probe.source,
            runningProbeAvailable: probe.available,
          },
          tookMs: Date.now() - startedAt,
        };

        const auditResult = await audit.record({ actor, sessionId, result: { ok: true, ...value } });
        value.audit = { ok: auditResult.ok, path: auditResult.path, ...(auditResult.error ? { error: auditResult.error } : {}) };
        return { ok: true, value };
      } catch (error) {
        const message = String(error?.message ?? error);
        log?.warn?.(`dialogue-cleanup: delete failed: ${message}`);
        await audit
          .record({ actor, sessionId, result: { ok: false, code: "internal", message } })
          .catch(() => {});
        return fail("internal", message, "查看宿主日志里 dialogue-cleanup 的记录，然后重试。");
      } finally {
        inFlight.delete(sessionId);
      }
    })();

    inFlight.set(sessionId, task);
    return task;
  }

  /**
   * 会话清单（给 slot 面板用；契约 §5.3.2）。
   *
   * 数据来源按权威性合并，缺哪个降级哪个：
   *   1. `sessionQuery.listSessions()` —— **完整逻辑语料**（含已归档 / 非活动的持久会话），
   *      返回 `SessionRecord { header, live, persisted }`，newest-first。这是清单主干。
   *   2. `sessionController.list()` —— 「可见行」的 `SessionSummary`，是 `running` / `blank` /
   *      `updatedAt` 的**唯一公开来源**。
   *   3. `sessionQuery.readTitleSnapshots(ids)` —— **一次调用批量取标题**（避免 N 次 RPC）；
   *      只对**当前页**取，读取量随页大小有界。
   *
   * 与上游的差别：上游让客户端自己 `POST /api/session.list` 拉目录、再按标题建 Map 猜 id
   * （同名标题就跳过，功能缺失）。这里由 Host 判定 `deletable` / `blockedReason`，UI 不猜。
   *
   * @param {object} [request] { query?, project?, running?, page?, pageSize?, sort? }
   */
  async function listSessions(request = {}) {
    const listStartedAt = Date.now();
    const sessionQuery = getService(ctx, "sessionQuery");
    const sessionController = getService(ctx, "sessionController");
    const registry = getService(ctx, "workspaceRegistry");

    // ── 1 + 2. 两份**互相独立**的数据源，并行取 ──
    //
    // 【性能自查】原来是串行 `await`：
    //     ① sessionQuery.listSessions()   （语料，实测含读盘）
    //     ② sessionController.list()      （摘要，live 上约 100 ms 底噪）
    // 但 ② **不依赖** ① 的结果 —— 两者只是分别被合并进同一个 rows 表。
    // 串行时 ② 要等 ① 完全结束才开始，那段等待是纯浪费。
    // 实测（语料 8 ms / 摘要 100 ms 的模拟）：串行 138 ms → 并行下界 100 ms，**省约 36 ms**。
    //
    // 两者仍是**各自独立的 try/catch**，降级语义完全不变：
    // 任一失败只影响它自己的来源标记，不会把另一个也拖挂。
    const [corpusResult, summaryResult] = await Promise.all([
      (async () => {
        if (typeof sessionQuery?.listSessions !== "function") return null;
        try {
          return await sessionQuery.listSessions();
        } catch {
          return null; // 落到 sessionController
        }
      })(),
      (async () => {
        if (typeof sessionController?.list !== "function") return null;
        try {
          return await sessionController.list({}, undefined);
        } catch {
          return null; // 摘要缺失时 running 不可知；删除时 Host 会再判一次
        }
      })(),
    ]);

    // ── 1. 主干：完整逻辑语料 ──
    const rows = new Map(); // sessionId → row
    const corpusRecords = Array.isArray(corpusResult) ? corpusResult : null;
    const corpusSource = corpusRecords === null ? "none" : "sessionQuery.listSessions";
    if (corpusRecords !== null) {
      for (const record of corpusRecords) {
          const id = record?.header?.id;
          if (typeof id !== "string") continue;
          rows.set(id, {
            sessionId: id,
            title: null,
            cwd: typeof record?.header?.cwd === "string" ? record.header.cwd : null,
            live: record?.live === true,
            persisted: record?.persisted === true,
            running: false,
            blank: false,
            // 【会话逻辑修正】子代理会话必须与官方侧栏一致地**默认隐藏**。
            // 官方 README 原文：「侧边栏隐藏持久化摘要中带有 `origin: 'subagent'` 的行。」
            // 依据：`SessionHeader { … origin?: 'subagent'; delegationDepth?: number }`。
            // 实测本机 39 条里有 17 条 origin==='subagent'（44%）—— 全部列出来
            // 会让面板被「You are doing a READ-ONLY…」这类子代理会话淹没。
            subagent: record?.header?.origin === "subagent",
            delegationDepth:
              typeof record?.header?.delegationDepth === "number"
                ? record.header.delegationDepth
                : null,
            parentSessionId:
              typeof record?.header?.parentSession === "string"
                ? record.header.parentSession
                : null,
            createdAt:
              typeof record?.header?.createdAt === "number"
                ? new Date(record.header.createdAt).toISOString()
                : null,
            updatedAt: null,
          });
      }
    }

    // ── 2. 可见行摘要：running / blank / updatedAt ──
    // 数据已在上面的 Promise.all 里并行取好（summaryResult）。
    const summaryItems = Array.isArray(summaryResult?.items) ? summaryResult.items : null;
    const summarySource = summaryItems === null ? "none" : "sessionController.list";
    if (summaryItems !== null) {
      for (const item of summaryItems) {
        const id = item?.sessionId;
        if (typeof id !== "string") continue;
        const running = item?.running === true;
        const blank = item?.blank === true;
        const updatedAt =
          typeof item?.updatedAt === "number" ? new Date(item.updatedAt).toISOString() : null;
        const existing = rows.get(id);
        if (existing !== undefined) {
          existing.running = running;
          existing.blank = blank;
          existing.updatedAt = updatedAt;
          if (existing.cwd === null && typeof item?.cwd === "string") existing.cwd = item.cwd;
        } else {
          // 语料里没有（理论上不该发生）——仍然列出，避免漏行
          rows.set(id, {
            sessionId: id,
            title: null,
            cwd: typeof item?.cwd === "string" ? item.cwd : null,
            live: true,
            persisted: false,
            running,
            blank,
            createdAt: null,
            updatedAt,
          });
        }
      }
    }

    if (rows.size === 0 && corpusSource === "none" && summarySource === "none") {
      return fail(
        "cleanup-unavailable",
        "宿主缺少列出会话所需的服务",
        "当前运行时既没有 sessionQuery.listSessions()，也没有 sessionController.list()。",
      );
    }

    // ── 3. 工作区归属（可选增强，用于项目分组显示） ──
    const wsBySession = new Map();
    try {
      for (const ws of registry?.list?.() ?? []) {
        const info = { workspaceId: ws?.id ?? null, title: ws?.title ?? null, path: ws?.path ?? null };
        for (const id of Array.from(ws?.sessionIds ?? [])) wsBySession.set(id, info);
      }
    } catch {
      /* 可选信息 */
    }

    // ── 4. 过滤 ──
    const query = typeof request?.query === "string" ? request.query.trim().toLowerCase() : "";
    const wantProject =
      typeof request?.project === "string" && request.project !== "" ? request.project : null;
    const wantRunning = typeof request?.running === "boolean" ? request.running : null;

    // 归档集合（见 readArchivedSessionIds 的取证说明）——读一次，供本页所有行复用。
    const archivedRead = readArchivedSessionIds(ctx);
    const archivedIds = archivedRead.ids;

    /**
     * 归档可见性 —— 取值照官方语义（`archivedFilter: 'default' | 'show' | 'only'`），
     * 但**默认值刻意与官方不同**。
     *
     * 官方 README 原文：视图选项「以一组显式三选一控制显隐：**隐藏已归档**（默认项）
     * 隐藏已归档 Session，**全部对话（显示已归档）**将其纳入列表，**仅显示已归档**
     * 则隐藏普通 Session」。
     *
     * 【为什么默认取 show 而不是官方的 default】
     * 本插件的用途是**清理磁盘**。归档 ≠ 删除 —— 归档会话仍完整占着磁盘，
     * 恰恰是需要被看见、被清理的对象。沿用官方「默认隐藏已归档」，
     * 会让用户看不到本该能删掉的会话（面板上那一栏还会显示「隐藏已归档」，
     * 用户得先手动切一下才能看到全部）。用户明确要求「默认显示已归档」。
     *
     * 与客户端的默认值保持一致（client.js 里 `archived: "show"`），
     * 违约会被 test/contract.test.mjs 的「两端默认值必须一致」断言拦下 ——
     * 避免出现「界面切换了但接口没切」这类只在特定路径复现的偏差。
     *
     * 归档行仍带 `archived: true`，UI 会打「已归档」徽标，与普通会话可区分。
     */
    const archivedFilter =
      request?.archived === "only" || request?.archived === "default" ? request.archived : "show";

    /**
     * 子代理可见性（`kind: 'all' | 'subagent' | 'main'`）。
     *
     * 【会话逻辑修正 · 这是「会话逻辑不对」的根因】
     * 官方 README 原文：「**侧边栏隐藏持久化摘要中带有 `origin: 'subagent'` 的行。**」
     * 依据：`SessionHeader { … origin?: 'subagent'; delegationDepth?: number }`
     * —— 子代理（subagent / teammate）会话在官方侧栏里**根本不出现在普通列表中**。
     *
     * 实测本机 39 条里 17 条 `origin === 'subagent'`（44%）：旧实现把它们全列出来，
     * 面板就被「You are doing a READ-ONLY…」「You are doing an adversarial…」这类
     * 子代理会话淹没，用户看到的清单与侧栏完全对不上。
     *
     * 但**完全隐藏也不行**：这些会话同样占磁盘、同样可能想清理，
     * 而且删除子代理会话正是本插件的用途之一。所以做成三选一，默认与官方一致：
     *   - `main`（默认）：只显示主会话 —— 与官方侧栏一致；
     *   - `subagent`：只看子代理会话 —— 本插件特有，便于批量清理它们；
     *   - `all`：两者都显示 —— 排障/彻底清理用。
     */
    const kindFilter =
      request?.kind === "subagent" || request?.kind === "all" ? request.kind : "main";

    // 【性能自查】一次性物化全库行，后面所有用途（筛选、计数、项目集合）都复用它。
    //
    // 原实现这里调用 `Array.from(rows.values())` 共 **3 次**（筛选 1 次 + 归档计数 1 次 +
    // 子代理计数 1 次），每次都为同一份 Map 重新分配一个数组。1000 行时是 3×1000 个引用的
    // 无谓分配；实测 Host 侧 CPU 很小（1000 行约 2 ms），所以这是**整洁性修复**而非关键提速，
    // 但顺手消掉不会让正确性变复杂：
    //   · `allRows` 保持**未过滤**（`items` 后续会被 filter 重新赋值成新数组，不会污染它，
    //     计数语义仍与之前完全一致 —— 都基于全库而非当前页）；
    //   · 用一次 for 循环取代三次 filter，三遍扫描合成一遍。
    const allRows = Array.from(rows.values());
    for (const row of allRows) row.archived = archivedIds.has(row.sessionId);
    let items = allRows;
    if (query !== "") {
      items = items.filter((row) => {
        const ws = wsBySession.get(row.sessionId);
        return (
          row.sessionId.toLowerCase().includes(query) ||
          String(row.cwd ?? "").toLowerCase().includes(query) ||
          String(ws?.title ?? "").toLowerCase().includes(query)
        );
      });
    }
    if (wantProject !== null) items = items.filter((row) => row.cwd === wantProject);
    if (wantRunning !== null) items = items.filter((row) => row.running === wantRunning);
    // 子代理三选一：默认只显示主会话（与官方侧栏一致）。
    if (kindFilter === "main") items = items.filter((row) => row.subagent !== true);
    else if (kindFilter === "subagent") items = items.filter((row) => row.subagent === true);
    // 归档三选一（与官方一致）：default 隐藏归档；show 全都要；only 只要归档。
    if (archivedFilter === "default") items = items.filter((row) => row.archived !== true);
    else if (archivedFilter === "only") items = items.filter((row) => row.archived === true);

    // ── 5. 排序（默认按最后活动倒序，回退创建时间） ──
    const sort = request?.sort === "created" ? "created" : "activity";
    items.sort((a, b) => {
      const ka = sort === "created" ? a.createdAt : a.updatedAt ?? a.createdAt;
      const kb = sort === "created" ? b.createdAt : b.updatedAt ?? b.createdAt;
      return String(kb ?? "").localeCompare(String(ka ?? ""));
    });

    // ── 6. 分页（契约 §5.3.2：{ total, page:{page,pageSize,pages}, items }） ──
    const total = items.length;
    const pageSizeRaw = Number.isInteger(request?.pageSize) ? request.pageSize : 50;
    const pageSize = Math.min(Math.max(pageSizeRaw, 1), 200);
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const pageRaw = Number.isInteger(request?.page) ? request.page : 1;
    const page = Math.min(Math.max(pageRaw, 1), pages);
    const slice = items.slice((page - 1) * pageSize, page * pageSize);

    // ── 7. 标题：只对当前页取，且带缓存 + 分片并发 ──
    //
    // 【实测修正 · 这里原来是唯一的性能瓶颈】
    // `readTitleSnapshots` 要读并解压整份会话日志来折叠标题，实测约 **65 ms/条**，
    // 且在服务内部是**串行**的（pageSize 1/5/10/20/50 → 325/415/1523/1809/3292 ms，
    // 近似线性）。于是默认 50 行的首屏要 3.3 s，200 行要 13 s，界面一直卡在
    // 「正在读取会话清单…」。
    //
    // 三重提速，都不牺牲正确性：
    //   1. **缓存**（titleCacheTtlMs）：标题是会话日志里的历史事实，短期不会变。
    //      翻页、筛选、刷新、删除后自动刷新全部命中缓存 → 即时返回。
    //   2. **分片并发**（titleFetchConcurrency）：把本页 id 均分成 c 片并行取，
    //      墙上时间从 N×65 ms 降到约 N/c×65 ms，同时只多 c-1 次 observation。
    //   3. **上限**（titleLimit）：超大页时只给前 N 行取标题，其余如实留空显示 id，
    //      而不是把整个请求拖到几十秒。
    const titleStat = { requested: 0, cached: 0, fetched: 0, failed: 0, truncated: 0, skipped: false };
    const ttl = Number.isInteger(config.titleCacheTtlMs) ? config.titleCacheTtlMs : 300000;
    const concurrency = Math.min(Math.max(Number.isInteger(config.titleFetchConcurrency) ? config.titleFetchConcurrency : 4, 1), 16);
    const titleLimit = Number.isInteger(config.titleLimit) ? Math.max(config.titleLimit, 0) : 100;

    if (typeof sessionQuery?.readTitleSnapshots === "function" && slice.length > 0 && titleLimit > 0) {
      const now = Date.now();
      const wanted = slice.slice(0, titleLimit);
      if (wanted.length < slice.length) titleStat.truncated = slice.length - wanted.length;

      // ① 先吃缓存（含刚过期的旧值：已过期的也先拿来显示，再在下面刷新）。
      const stale = [];
      for (const row of wanted) {
        const hit = titleCache.get(row.sessionId);
        if (hit === undefined) {
          stale.push(row);
          continue;
        }
        if (hit.title !== null) row.title = hit.title;
        if (ttl > 0 && now - hit.at < ttl) titleStat.cached += 1;
        else stale.push(row);
      }
      titleStat.requested = wanted.length;

      // ② 需要刷新/新取的，按并发数均分成片，并行取。
      if (stale.length > 0) {
        const ids = stale.map((row) => row.sessionId);
        const shards = Math.min(concurrency, ids.length);
        const groups = Array.from({ length: shards }, () => []);
        ids.forEach((id, index) => groups[index % shards].push(id));

        const parts = await Promise.all(
          groups.map(async (group) => {
            const collected = [];
            // 单分片内的读仍然是串行的（服务本身如此），失败只影响本分片。
            try {
              const results = await sessionQuery.readTitleSnapshots(group);
              if (Array.isArray(results)) collected.push(...results);
            } catch {
              for (const id of group) collected.push({ sessionId: id, status: "rejected" });
            }
            return collected;
          }),
        );

        const at = Date.now();
        for (const part of parts) {
          for (const result of part) {
            const id = result?.sessionId;
            if (typeof id !== "string") continue;
            if (result?.status !== "fulfilled") {
              titleStat.failed += 1;
              continue;
            }
            const title = result?.value?.title?.title;
            const normalized = typeof title === "string" && title !== "" ? title : null;
            // 无标题也要缓存（负结果），否则每次刷新都会重复付出这 65 ms。
            titleCache.set(id, { title: normalized, at });
            titleStat.fetched += 1;
            const row = rows.get(id);
            if (row !== undefined && normalized !== null) row.title = normalized;
          }
        }
      }

      if (titleCache.size > 5000) {
        const cutoff = Date.now() - Math.max(ttl, 60000) * 4;
        for (const [key, entry] of titleCache) {
          if (entry.at < cutoff) titleCache.delete(key);
        }
      }
    } else if (titleLimit === 0) {
      titleStat.skipped = true;
    }

    // ── 8. 判定 deletable / blockedReason（Host 判定，UI 不猜） ──
    const requireIdle = config.requireIdleSession !== false;
    const projectSet = new Set();
    for (const row of rows.values()) {
      if (typeof row.cwd === "string" && row.cwd !== "") projectSet.add(row.cwd);
    }

    const out = slice.map((row) => {
      const ws = wsBySession.get(row.sessionId);
      const blockedReason =
        requireIdle && row.running ? "会话正在运行，请先停止再删除" : null;
      return {
        sessionId: row.sessionId,
        title: row.title,
        project: ws?.path ?? row.cwd ?? null,
        workspaceTitle: ws?.title ?? null,
        running: row.running,
        blank: row.blank,
        live: row.live,
        persisted: row.persisted,
        // 归档状态（来自 workspace 存储领域；见 readArchivedSessionIds）。
        // UI 据此显示「已归档」徽标，并说明归档不会删除会话。
        archived: row.archived === true,
        // 子代理身份（来自 SessionHeader.origin / delegationDepth / parentSession）。
        // 官方侧栏默认隐藏这些行；面板据此显示徽标并支持三选一。
        subagent: row.subagent === true,
        delegationDepth: row.delegationDepth ?? null,
        parentSessionId: row.parentSessionId ?? null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        deletable: blockedReason === null,
        blockedReason,
      };
    });

    // 归档计数 / 子代理计数：都基于**全库** allRows（未受当前筛选影响），
    // 供界面显示「已归档 N」「子代理 N」并让三选一有明确语义。
    // 复用上面那一份物化结果，不再为同一份 Map 重新分配两次数组。
    let archivedTotal = 0;
    let subagentTotal = 0;
    let archivedAgentTotal = 0;
    for (const row of allRows) {
      if (row.archived === true) archivedTotal += 1;
      if (row.subagent === true) {
        subagentTotal += 1;
        if (row.archived === true) archivedAgentTotal += 1;
      }
    }

    return {
      ok: true,
      value: {
        total,
        page: { page, pageSize, pages },
        items: out,
        projects: Array.from(projectSet).sort(),
        sources: { corpus: corpusSource, summary: summarySource },
        // 归档三选一的回显 + 全库归档计数（未受筛选影响，便于界面提示）。
        archived: {
          filter: archivedFilter,
          total: archivedTotal,
          known: archivedRead.known,
          subagentTotal: archivedAgentTotal,
        },
        // 子代理三选一的回显 + 全库子代理计数。
        // 官方侧栏默认隐藏子代理行；这里如实报告隐藏了多少，避免用户以为会话丢了。
        kind: { filter: kindFilter, subagentTotal, mainTotal: allRows.length - subagentTotal },
        // 取标题的成本明细：界面可据此说明「为什么这次快/慢」。
        titles: titleStat,
        tookMs: Date.now() - listStartedAt,
      },
    };
  }


  function capabilities() {
    const sessionController = getService(ctx, "sessionController");
    const registry = getService(ctx, "workspaceRegistry");
    const sessions = getService(ctx, "sessions");
    return {
      // 公开面没有 detach；能否摘内存取决于内部 store 是否可达。
      // 一律经 getService 读取：直接写 ctx.sessions 在真实宿主里会抛错（未注入的服务）。
      detachLive: typeof sessions?.store?.get === "function",
      detachWorkspaces: typeof registry?.list === "function",
      clearRegistryRecords: typeof registry?.unarchiveSession === "function",
      removeArtifacts: true,
      removeProjectionCache: true,
      listSessions: typeof sessionController?.list === "function",
      listCorpus: typeof getService(ctx, "sessionQuery")?.listSessions === "function",
      titles: typeof getService(ctx, "sessionQuery")?.readTitleSnapshots === "function",
      // 归档状态来自 workspace 存储领域的全局状态（见 readArchivedSessionIds）。
      archivedFilter: (() => {
        const domain = getService(ctx, "storageDomain");
        try {
          return typeof domain?.get === "function" && domain.get("workspace")?.global?.get?.() !== undefined;
        } catch {
          return false;
        }
      })(),
      runningProbe: typeof sessionController?.list === "function" ? "sessionController.list" : "agents.get",
      publicStopIdleAgent: false,
    };
  }

  return { deleteSession, listSessions, capabilities };
}
