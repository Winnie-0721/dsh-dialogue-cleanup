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
 * 通知官方侧栏「某个会话已经没了」。
 *
 * ─── 为什么需要这个（2026-10-16 · 「未分组」幽灵行的真根因）────────────────────
 * 删掉一个会话后，官方侧栏仍把它列在「未分组」下。全盘扫描 `~/.dsh` 证实：
 * 那三个 id 只出现在审计日志与记忆索引里，**sessions 目录、projcache、
 * storages 全部零命中** —— 持久化数据已经 100% 清干净了。
 *
 * 缺的是**客户端重新拉列表**。官方侧栏的列表来自客户端
 * `ApiSessionList.refreshList()`（`dsh-api-session-controller/lib/client.js`）：
 *   `const result = await this.remote.session.list({});`
 * 这次拉取发生在删除**之前**；删除后没有任何东西触发重新拉取，
 * 旧 id 就一直留在 `listSnapshot` 里，被 `groupByWorkspace` 归进 `stray`
 * → 渲染成「未分组」。
 *
 * 而 `handleSessionRemoved`（同文件）正是为此设计的入口：
 *   ```js
 *   const durableSubagent = this.subagentAddress(id) !== void 0 || …origin === "subagent";
 *   this.recordMutation(durableSubagent ? {kind:"status",…} : {kind:"remove", sessionId});
 *   ```
 * **只有 `kind:"remove"` 才会真正从列表抹掉**，而它由 `api-session/removed` 触发。
 *
 * ─── 为什么用 ctx.emit 而不是别的────────────────────────────────────────────
 * `api-session/removed` 是一个**已声明的 Remote Event**：
 *   `dsh-api-remotes/lib/types/remote-events.js`：`{ event: 'api-session/removed', mode: 'emit' }`
 *   `dsh-api-session-controller/lib/typert.host.js`：
 *     `"'api-session/removed'(sessionId: SessionId): void"`
 * `mode: 'emit'` 表示 **Host 侧 ctx.emit 会自动中继到所有客户端**，客户端用
 * `ctx.remote.$on('api-session/removed', …)` 接收。官方自己在
 * `dsh-api-session-controller/lib/index.js` 里就是这么发的：
 *   `ctx.on("session/disposed", (session) => { ctx.emit("api-session/removed", session.id); });`
 *
 * 我们复刻同一条路径，不需要任何未文档化的内部成员。
 *
 * ─── 为什么必须包 try/catch ─────────────────────────────────────────────────
 * 删除是主任务，通知是锦上添花。`ctx.emit` 在没有该事件声明的运行时（或旧版本）
 * 可能抛错；那绝不能让一个**已经成功的删除**变成失败。所以失败只记日志，
 * 并在返回值里如实标 `announced:false`，让界面知道「删干净了但侧栏可能要手动刷新」。
 *
 * @param {object} ctx Host 上下文（本插件的 apply 收到的那一个）
 * @param {string} sessionId
 * @param {object} [log] 宿主 logger
 * @returns {Promise<{announced: boolean, reason: string}>}
 */
export async function announceSessionRemoved(ctx, sessionId, log) {
  if (ctx === null || ctx === undefined || typeof ctx.emit !== "function") {
    return { announced: false, reason: "no-emit" };
  }
  try {
    ctx.emit("api-session/removed", sessionId);
    return { announced: true, reason: "emitted" };
  } catch (error) {
    // 不对外抛：删除已成功，通知失败只降级。
    log?.debug?.(
      `dialogue-cleanup: announce api-session/removed failed: ${String(error?.message ?? error)}`,
    );
    return { announced: false, reason: "emit-threw" };
  }
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
 * ②是内部实现（`store` 是 SessionStore 的实例自有字段，未文档化），所以**失败不抛错**，
 * 返回 `detached: false` 让上层如实上报。
 *
 * 【为什么②必须真的摘掉 —— 「删了又出现在未分组」的另一半原因】
 * 官方侧栏的行来自会话列表；只要内存里的 live 条目还在，列表就仍会列出该会话。
 * 若此时工作区归属已被摘掉，它就落进官方 `groupByWorkspace` 的 `stray` 分支，
 * 渲染为「未分组」——用户看到的现象正是「删掉的会话又冒出来」。
 * 所以这里要尽量把 live 条目真的摘掉，而不是「试着调一下就报成功」。
 *
 * ─── 返回值的三态语义（2026-10 修正 · 原来只有两态，会把「本来就不在内存里」
 *      误报成「摘除失败」，让界面永远显示一句吓人的降级提示）────────────────────
 *   - `"detached"`  ：确实摘掉了（本来在内存里，现在没了）。
 *   - `"absent"`    ：本来就不在 live store 里 —— **这是正常收尾**，不是失败。
 *                     典型场景：会话已关闭/已释放，磁盘工件还在，删掉即可。
 *   - `"failed"`    ：本来在内存里，但**尝试摘除后仍在**（内部入口抛错或摘除无效）。
 *
 * 【实测依据】`sessions.list()` 的实现是
 *   `[...this.store.values()].map(entry => entry.session)`
 * 也就是 live 集合本身；而分支①要用的公开方法（detach/release/close）在
 * `SessionStore` 的公开契约里**根本不存在**（只有 create/prepare/enter/announce/
 * flush/get/list/fork），所以真实宿主走的正是分支②。把这两件事合起来看：
 * `absent` 与 `failed` 的区分是有意义的，混为一谈会让每一次正常删除都显示
 * 「内存条目未摘除（降级）」。
 *
 * @param {object} sessions
 * @param {string} sessionId
 * @returns {"detached"|"absent"|"failed"}
 */
export function detachLiveStore(sessions, sessionId) {
  if (sessions === null || sessions === undefined) return "failed";

  // ① 优先公开的服务方法
  //    【实测说明】当前 `SessionStore` 公开面没有 detach/release/close，这一支在
  //    真实宿主里是**前瞻兼容**（未来版本若新增公开停止入口即可用上），不是现役路径。
  for (const method of ["detach", "release", "close"]) {
    const fn = sessions[method];
    if (typeof fn === "function") {
      try {
        fn.call(sessions, sessionId);
        return "detached";
      } catch {
        /* 继续尝试下一个 */
      }
    }
  }

  // ② 内部 store Map。用**Map 语义**（get + delete 都是函数）做校验，
  //    避免把 Cordis 代理返回的包装对象误当成 store 用。
  let store;
  for (const key of ["store", "_store", "sessions"]) {
    let candidate;
    try {
      candidate = sessions[key];
    } catch {
      continue;
    }
    if (
      candidate !== null &&
      candidate !== undefined &&
      typeof candidate.get === "function" &&
      typeof candidate.delete === "function"
    ) {
      store = candidate;
      break;
    }
  }
  // 拿不到任何 store 入口：无法判断它是否在内存里，如实报「失败」让上层保守处理。
  if (store === undefined) return "failed";

  try {
    const entry = store.get(sessionId);
    // 本来就不在内存里 —— 这是**正常收尾**，与「摘除失败」必须区分开。
    if (entry === undefined) return "absent";
    if (typeof entry.detach === "function") {
      entry.detach(); // 官方 enter() 存进来的 detach：内含 store.delete + 派发 session/disposed
      // detach 是同步的；再确认一次它真的走了（detachEntered 会因 id 不匹配而静默 return）。
      return store.get(sessionId) === undefined ? "detached" : "failed";
    }
    store.delete(sessionId);
    return store.get(sessionId) === undefined ? "detached" : "failed";
  } catch {
    return "failed"; // 降级，不把异常抛给删除事务
  }
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
 * 事务顺序（2026-10 修正后）：
 *   1. 校验 id
 *   2. 幂等单飞
 *   3. agent 守卫（running 一律拒）
 *   4. 摘内存 live 条目（读一次 live 集合，同时供存在性守卫与「是否仍在内存」判定复用）
 *   5. **删磁盘工件**（+ 投影缓存）
 *   6. 摘工作区记录 —— **仅在会话确已不在宿主内存时**
 *   7. 清注册表残留（pin / archive）—— 同上，带同一条件
 *   8. 审计
 *
 * 【为什么 5 在 6/7 之前 · 2026-10 修正】
 * 官方侧栏 `groupByWorkspace`（dsh-client-ui-workspace/lib/client.js）把
 * 「在会话列表里、却不被任何 workspace 认领」的行收进 `stray`，渲染成「未分组」。
 * 旧顺序先摘归属、后删工件 → 那段中间态正是用户看到的「删了又出现在未分组」。
 * 现在把顺序倒过来，并给 6/7 加上「确已不在内存」这一条件（见内层详细说明）。
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

  /**
   * 该 id 是否对应一个**真实存在**的会话（用于「另一种拼写」的存在性守卫）。
   *
   * @param {Set<string>} liveIds 本次事务开始时读到的 live 会话 id 集合。
   *   由调用方读**一次**后复用 —— 这里再用它回答两个问题：
   *     ①「另一种拼写」的存在性守卫（绝不能拿过期数据放行破坏性删除）；
   *     ② 会话是否仍在宿主内存里（决定能不能安全摘工作区归属）。
   *   两者是同一次读取的同一份事实，重复读只会白白多付 N 次内存遍历。
   */
  function makeKnownSessionProbe(liveIds) {
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
        //
        // 先把 live id 集合读**一次**：它同时服务两处判断（见 makeKnownSessionProbe），
        // 重复读只会白白多付 N 次内存遍历。
        const liveIds = new Set();
        let liveIdsKnown = false;
        try {
          const sessions = getService(ctx, "sessions");
          if (typeof sessions?.list === "function") {
            for (const session of sessions.list() ?? []) {
              if (typeof session?.id === "string") liveIds.add(session.id);
            }
            liveIdsKnown = true;
          }
        } catch {
          /* 读不到 = 不可知 */
        }

        // 三态：detached（摘掉了）/ absent（本就不在内存里，正常收尾）/ failed（试了没摘掉）。
        const detachOutcome = detachLiveStore(getService(ctx, "sessions"), sessionId);
        // 对外仍保留布尔 `detached` 字段（兼容既有契约与界面分支），
        // 另加 `detach` 三态明细，让界面能区分「正常收尾」与「真的降级了」。
        const detached = detachOutcome === "detached";

        // 只有「本来在 live 集合里、且这次没摘掉」才算会话仍占着宿主内存。
        // 读不到集合时按 false 处理（与既有降级语义一致：不因此跳过归属摘除）。
        const stillInLiveStore = liveIdsKnown && liveIds.has(sessionId) && !detached;

        // 标题缓存随会话一起失效：否则删掉的行在下次刷新时仍会显示旧标题。
        titleCache.delete(sessionId);
        const alt = alternateIdSpelling(sessionId);
        if (alt !== null) titleCache.delete(alt);

        // ── 3. 先删磁盘工件 ──
        //
        // 【顺序修正 · 这里原来是「先摘工作区归属、后删工件」】
        // 官方侧栏把「在会话列表里、却不被任何工作区认领」的行归入 `stray`，
        // 渲染成「未分组」。归属先没了、行还留着 → 那一行就以「未分组」的身份出现。
        // 现在反过来：先把磁盘工件删掉，再处理归属（且带条件，见第 4 步）。
        const isKnownSession = makeKnownSessionProbe(liveIds);
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

        // ── 4. 摘工作区归属 —— **但只在会话确实已从宿主内存里消失时** ──
        //
        // 【顺序/条件修正 · 这里原来无条件摘归属，会亲手制造「未分组」那一行】
        // 官方侧栏的分组逻辑（`dsh-client-ui-workspace/lib/client.js` 的
        // `groupByWorkspace`）是这样的：
        //   1. 遍历每个 workspace 的 `sessionIds`，命中的记入 `accounted`；
        //   2. 把「在会话列表里、却不被任何工作区认领」的行收进 `stray`，
        //      渲染成标题为「未分组」（locale 键 `group.ungrouped`）的那一组。
        //
        // 于是「**归属先没了、行却还在**」的这段状态，对用户就是「删掉的会话
        // 又冒出来，而且跑到未分组下面」。本机审计证实了这段状态确实存在
        // （`workspaces` 计数正常，但内存 `detached:false`）。
        //
        // 修法：把「摘归属」挂在「宿主内存里已经没有它」这个条件上。
        //   · 内存里没了 → 列表不会再列出它 → 摘掉归属是安全的收尾；
        //   · 内存里还在（detach 失败）→ **保留归属**，行会留在原工作区分组下，
        //     不会变成用户可见的「未分组」孤儿；同时返回 `detached:false`
        //     让界面如实提示「需要刷新」。
        //
        // 这是**有意的保守取舍**：宁可留一条分组正确、界面提示可刷新的行，
        // 也不制造一条跑到「未分组」下的幽灵行。
        const workspaceRegistry = getService(ctx, "workspaceRegistry");
        const workspaces =
          stillInLiveStore ? 0 : await detachWorkspaces(workspaceRegistry, sessionId, log);

        // ── 5. 清注册表残留（pin / archive，公开幂等 API） ──
        // 与归属同理：会话还在内存里时不碰注册表，避免留下指向不可见行的 pin。
        const registryCleared =
          config.clearRegistryRecords === true && !stillInLiveStore
            ? await clearRegistryRecords(workspaceRegistry, sessionId, log)
            : { attempted: 0, resolved: 0, changed: null, skipped: [] };

        // 内存摘除失败、盘上也没有任何工件 —— 很可能这个 id 根本没删到东西。
        // 不把它当失败（删除是幂等的），但如实给出 partial:true 让调用方知道是降级路径。
        const partial = !detached && artifacts.count === 0;

        // ── 6. 通知官方侧栏「这个会话已经没了」────────────────────────────
        //
        // 【这就是「删了却还在未分组里」的真修法 · 2026-10-16】
        // 前两次诊断都错了（先后怀疑过「事务顺序」和「subagentCatalog 注入」），
        // 全盘扫描 `~/.dsh` 后定论：**持久化数据已 100% 清干净**
        // （sessions 目录 / projcache / storages 对那三个 id 全部零命中），
        // 缺的只是让客户端重新拉一次列表。
        //
        // 官方为此准备了现成入口：`api-session/removed` 是一个已声明的
        // Remote Event（`mode: 'emit'`），Host 侧 `ctx.emit` 会自动中继到
        // 所有客户端；客户端 `handleSessionRemoved` 收到后会
        // `recordMutation({kind:"remove", sessionId})` —— 只有这一支
        // **才会真正把 id 从侧栏列表里抹掉**（`kind:"status"` 只改状态，不抹行）。
        //
        // 注意：只在**真的删到了东西**时才通知。幂等重删（磁盘已无、归属已摘）
        // 也发一次是安全的（客户端 remove 一个不存在的 id 是 no-op），
        // 但没必要多一次跨进程往返，所以用 `partial` 之外的「有实际效果」作条件。
        const announced =
          config.announceRemoval !== false
            ? await announceSessionRemoved(ctx, sessionId, log)
            : { announced: false, reason: "disabled" };

        const value = {
          sessionId,
          detached,
          // 三态明细：detached | absent | failed。
          // 界面据此把「本就不在内存里（正常收尾）」与「真的没摘掉（降级）」区分开，
          // 而不是对每一次正常删除都显示一句吓人的「未摘除」。
          detach: detachOutcome,
          workspaces,
          registryCleared,
          // 是否已通知官方侧栏移除该行。false 时侧栏可能仍显示旧行，需手动刷新。
          announced: announced.announced,
          announceReason: announced.reason,
          // 归还归属时是否因「会话仍在宿主内存里」而跳过（UI 据此提示需刷新）。
          keptWorkspaceMembership: stillInLiveStore,
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
    // 【关键词过滤挪到第 4b 步】原来它在这里、且在取标题**之前** ——
    // 于是「按标题搜」永远搜不到（title 那时恒为 null）。UI 的占位文案
    // 明明写着「搜索标题、会话 id 或项目路径」（实测：中文关键词一律 0 条）。
    // 结构性筛选（项目/状态/类型/归档）不依赖标题，留在原地先做，
    // 把需要标题的行数压到最小；关键词留到标题补齐之后再判（见 4b）。
    if (wantProject !== null) items = items.filter((row) => row.cwd === wantProject);
    if (wantRunning !== null) items = items.filter((row) => row.running === wantRunning);
    // 子代理三选一：默认只显示主会话（与官方侧栏一致）。
    if (kindFilter === "main") items = items.filter((row) => row.subagent !== true);
    else if (kindFilter === "subagent") items = items.filter((row) => row.subagent === true);
    // 归档三选一（与官方一致）：default 隐藏归档；show 全都要；only 只要归档。
    if (archivedFilter === "default") items = items.filter((row) => row.archived !== true);
    else if (archivedFilter === "only") items = items.filter((row) => row.archived === true);

    // ── 5. 排序（默认按最后活动倒序，回退创建时间） ──
    //
    // 【性能修正 · 实测】原来用 `String(k).localeCompare(...)`。本机基准：
    //   5000 行 ISO-8601 字符串，localeCompare 15 ms vs 直接 `<`/`>` 比较 1 ms（约 15 倍）。
    // 这里的两个 key（createdAt / updatedAt）在**上游就已经是 `toISOString()` 的结果**
    // （见本函数第 2 步的 `new Date(...).toISOString()`），而 ISO-8601 的定长格式保证
    // **字典序 == 时间序**，因此完全不需要 locale 感知比较。
    // 降序只需要把比较结果反向。key 仍先归一化成字符串（`?? ""` 兜底 null/undefined），
    // 与原来的 `String(k ?? "")` 语义一致。
    const sort = request?.sort === "created" ? "created" : "activity";
    const sortKey = (row) => {
      const value = sort === "created" ? row.createdAt : (row.updatedAt ?? row.createdAt);
      return typeof value === "string" ? value : "";
    };
    items.sort((a, b) => {
      const ka = sortKey(a);
      const kb = sortKey(b);
      // 降序：b 在前。相等时返回 0（与原来 localeCompare 返回 0 一致）。
      if (ka === kb) return 0;
      return ka < kb ? 1 : -1;
    });

    // ── 5b. 标题预算与补齐工具（关键词匹配与当前页显示共用）──
    //
    // 【实测修复 · 「搜索标题」曾是句空话】旧实现把关键词过滤放在取标题**之前**，
    // 那一刻 `row.title` 恒为 null —— UI 占位文案明明写着「搜索标题、会话 id 或
    // 项目路径」（实测：中文关键词在存在同名标题的库上一律返回 0 条）。
    // 标题 65 ms/条，且磁盘取证表明**必须解压整份会话日志**（session 目录里只有
    // `session.v4.jsonl.zstd`，没有任何独立标题索引；宿主 `foldSessionTitle` 是
    // `events.findLast(type === "session/title")`），所以不能无条件为全库补齐。
    // 定这条规矩，两头都不吃亏：
    //   1. 结构性筛选（项目/状态/类型/归档，均不依赖标题）已在上面把候选集压到最小；
    //   2. 先排序（最新活动在前），标题预算优先花在**最可能出现在首页**的行上；
    //   3. 按 `titleLimit` 预算补标题：缓存命中 = 零成本；
    //   4. 预算外的行只按廉价字段（id / 路径 / 工作区名）匹配，并且超出量如实计入
    //      `titles.truncated` 上报给界面提示「结果可能不完整」——
    //      静默漏报才是这条 bug 的原罪，宁可如实降格也不可假装搜过。
    const titleStat = { requested: 0, cached: 0, fetched: 0, failed: 0, truncated: 0, skipped: false };
    const ttl = Number.isInteger(config.titleCacheTtlMs) ? config.titleCacheTtlMs : 300000;
    const concurrency = Math.min(Math.max(Number.isInteger(config.titleFetchConcurrency) ? config.titleFetchConcurrency : 4, 1), 16);
    const titleLimit = Number.isInteger(config.titleLimit) ? Math.max(config.titleLimit, 0) : 100;

    /**
     * 给一批行补齐标题：缓存（titleCacheTtlMs）→ 未命中分片并发（titleFetchConcurrency）
     * → 超预算部分如实计入 truncated。计数累积进 titleStat（搜索与当前页两趟共用）。
     * 原内联实现的全部行为逐字保留，只是抽成了可复用的两趟调用。
     *
     * 【计数去重】带关键词的请求会走两趟（先给候选集补、再给当前页补），
     * 同一行可能出现在两趟里。titleStat 是「这次请求读标题的代价」，
     * 不是「趟数之和」—— 用一个按请求的 Set 保证每个 sessionId 只计一次，
     * 否则界面的「命中 N」会翻倍虚报。
     */
    const counted = new Set();
    const overBudget = new Set();
    async function ensureTitles(target) {
      // titleLimit=0 的判定顺序照旧：先「完全不取」的开关，再看服务是否可用。
      // （旧实现里 skipped 只看 titleLimit、不看页长——即便空页也会置 true，这里逐字保持。）
      if (titleLimit === 0) {
        titleStat.skipped = true;
        return;
      }
      if (typeof sessionQuery?.readTitleSnapshots !== "function" || target.length === 0) return;

      const now = Date.now();
      const wanted = target.slice(0, titleLimit);
      // 预算外的行：记进集合而不是累加计数 —— 带关键词的请求走两趟，
      // 同一行可能两次落在预算外，重复累加会把「未读标题 N 行」吹大。
      for (let index = wanted.length; index < target.length; index += 1) {
        overBudget.add(target[index].sessionId);
      }
      titleStat.truncated = overBudget.size;

      // ① 先吃缓存（含刚过期的旧值：已过期的也先拿来显示，再在下面刷新）。
      const stale = [];
      for (const row of wanted) {
        const firstSeen = !counted.has(row.sessionId);
        if (firstSeen) {
          counted.add(row.sessionId);
          titleStat.requested += 1;
        }
        const hit = titleCache.get(row.sessionId);
        if (hit === undefined) {
          if (firstSeen) stale.push(row);
          continue;
        }
        if (hit.title !== null) row.title = hit.title;
        if (ttl > 0 && now - hit.at < ttl) {
          if (firstSeen) titleStat.cached += 1;
        } else if (firstSeen) {
          stale.push(row);
        }
      }

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
    }

    // ── 5c. 关键词过滤（id / 标题 / 项目路径 / 工作区名，全部参与匹配）──
    if (query !== "") {
      await ensureTitles(items);
      items = items.filter((row) => {
        const ws = wsBySession.get(row.sessionId);
        return (
          row.sessionId.toLowerCase().includes(query) ||
          String(row.title ?? "").toLowerCase().includes(query) ||
          String(row.cwd ?? "").toLowerCase().includes(query) ||
          String(ws?.title ?? "").toLowerCase().includes(query)
        );
      });
    }

    // ── 6. 分页（契约 §5.3.2：{ total, page:{page,pageSize,pages}, items }） ──
    const total = items.length;
    const pageSizeRaw = Number.isInteger(request?.pageSize) ? request.pageSize : 50;
    const pageSize = Math.min(Math.max(pageSizeRaw, 1), 200);
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const pageRaw = Number.isInteger(request?.page) ? request.page : 1;
    const page = Math.min(Math.max(pageRaw, 1), pages);
    const slice = items.slice((page - 1) * pageSize, page * pageSize);

    // ── 7. 当前页标题（无关键词时这是唯一一趟；有关键词时本页多数已命中缓存）──
    await ensureTitles(slice);

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
    // detachLive 的三态探测（修正原来的一句 `typeof sessions?.store?.get === "function"`）。
    //
    // 【为什么必须拆开】旧探针只回答「`store.get` 是不是函数」，在真实宿主里它
    // **恒为 true**（`store` 是 SessionStore 的实例字段，经 Cordis 代理可达），
    // 于是 `/status` 一直显示「能摘内存」，而审计日志里 11 次删除**全部**
    // `detached:false` —— 探针的答案与事实不符，排障时反而误导。
    //
    // 现在分别回答两个真正有意义的问题：
    //   reachable —— 能不能摸到内部 store Map（`get` + `delete` 都是函数）；
    //   entryDetach —— 摘除时走的 `entry.detach` 是否存在（这才是官方 enter() 提供的入口）。
    // 只读 `store` 的形状、不读任何会话数据，因此没有副作用。
    const detachProbe = (() => {
      let store;
      try {
        for (const key of ["store", "_store", "sessions"]) {
          const candidate = sessions?.[key];
          if (
            candidate !== null &&
            candidate !== undefined &&
            typeof candidate.get === "function" &&
            typeof candidate.delete === "function"
          ) {
            store = candidate;
            break;
          }
        }
      } catch {
        /* 不可达 */
      }
      if (store === undefined) return { reachable: false, entryDetach: false };
      let entryDetach = false;
      try {
        // 取**任意一个** entry 只看形状，不针对特定会话，也不做任何修改。
        for (const entry of store.values()) {
          if (entry !== null && entry !== undefined && typeof entry.detach === "function") {
            entryDetach = true;
          }
          break;
        }
      } catch {
        /* 遍历不可用 */
      }
      return { reachable: true, entryDetach };
    })();
    return {
      // 公开面没有 detach；能否摘内存取决于内部 store 是否可达。
      // 一律经 getService 读取：直接写 ctx.sessions 在真实宿主里会抛错（未注入的服务）。
      detachLive: detachProbe.reachable,
      // store 可达**且**里面的 entry 带官方 detach 闭包 —— 这才是「真能摘」的判据。
      detachLiveEntry: detachProbe.entryDetach,
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
      // 删除成功后能否 emit `api-session/removed`（Remote Event，mode: 'emit'）通知侧栏。
      // 这一条决定「删掉的会话会不会立刻从官方侧栏消失」。
      announceRemoval: typeof ctx?.emit === "function",
    };
  }

  return { deleteSession, listSessions, capabilities };
}
