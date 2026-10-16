/**
 * dsh-dialogue-cleanup —— 客户端半（浏览器 bundle）。
 *
 * ─── 它注册到哪里 ───────────────────────────────────────────────────────────
 * 1. `sidebar.workspaces.session.menu.item`（kind: list, scope: root）
 *    会话行 ⋮ 菜单里的一项。该项由官方 `dsh-client-ui-workspace` 声明，
 *    现场 `Slots.listSubTree` 已确认它与 pin(100)/rename(200)/fork(300)/archive(400)
 *    同席；我们取 order 500，排在 archive 之后。
 *    该 slot 的 ownerProps 就是行身份：`sessionId` + `displayTitle`（实测 ownerProps 表）。
 *
 * 2. `shell.overlay`（kind: list, scope: root）
 *    主题化确认弹窗。它是官方的「frame-wide 浮动层」增设位，文档明写可以自取 id 附加。
 *    实测同席还有 workspace.session-archive / workspace.session-rename 等官方对话框 ——
 *    即「删除类操作配一个 overlay 确认框」正是官方自己的做法。
 *
 * ─── 明确没有做的事（规范红线） ─────────────────────────────────────────────
 * - 没有 MutationObserver、没有 appendChild 到宿主 DOM、没有读宿主 DOM 定位（R-22/R-25）。
 *   上游 client.js 约 160 行都在解决「菜单归属 + 标题反查 id」，插槽方案下全部消失。
 * - **没有** `require('@deepseek-ai/dsh-client-ui-primitives')`（R-23 明文禁止）。
 *   官方 README 举的 `MenuItemButton` 例子与这条规范冲突；按规范走，自己写这一行按钮，
 *   自绘样式只引用 `--dsw-alias-*` 令牌（R-24），并在组件内以 React 元素渲染样式（R-29）。
 *   —— 令牌名以现场 `Theme.listTokens` 的全表为准，不用猜的名字。
 * - factory 无副作用（R-26）：下面只有定义与模块级状态，没有任何注册/定时器/请求。
 *
 * ─── 「运行中」怎么处理 ─────────────────────────────────────────────────────
 * 该 slot 的 ownerProps 只承诺行身份（sessionId / displayTitle）。虽然 standardProps
 * 里有 `useSessionStatus`，但其快照形状未取证 —— 所以**不在客户端猜**：
 * 按钮始终可点，由 Host 端点返回 409 refused，UI 原样展示原因。
 * 这也是主手册 §3.3 给的第二条正路。
 */

window.__ModuleLoader__.load({
  id: "dsh-dialogue-cleanup",
  factory(require) {
    const React = require("react");
    const h = React.createElement;

    const NS = "dialogueCleanup";
    const MENU_SLOT = "sidebar.workspaces.session.menu.item";
    const OVERLAY_SLOT = "shell.overlay";
    const BASE = "/api-ext/dialogue-cleanup";
    /**
     * 管理面板挂在**设置页**：`settings.section`（list, root）。
     * 契约（现场 Slots.listSubTree 实测）：
     *   - 注册项 `{ id, order, label }`，label 用 thunk 以跟随语言切换；
     *   - ownerProps 只有 `{ close }`（关闭设置面板）；
     *   - 内容渲染在设置面板的**内容列**里。
     * 同席已有 account(-10) / general(0) / models(10) / plugins(15) / agent-presets(20)，
     * 我们取 order 25，排在这些官方页之后。
     */
    const SETTINGS_SECTION_SLOT = "settings.section";
    const SECTION_ID = "dialogue-cleanup";

    // ─── 文案（模块级兜底表） ───────────────────────────────────────────────
    // 同时走 Client locale 服务注册；这张表保证即使 locale 注册失败、
    // 或宿主没有把 `t` 注进来，行与弹窗仍然是可读文字而不是原始 key。
    const STRINGS = {
      zh: {
        "action.delete": "删除此会话",
        "action.deleting": "删除中…",
        "confirm.title": "删除会话",
        "confirm.body": "将永久删除：{title}",
        "confirm.warning": "此操作不可恢复。会话日志与磁盘工件都会被移除。",
        "confirm.idLabel": "会话 id",
        "confirm.ok": "永久删除",
        "confirm.cancel": "取消",
        "done.title": "已删除会话",
        "done.detached": "内存条目已摘除",
        // 会话本来就不在宿主内存里（已关闭/已释放）—— 这是**正常收尾**，不是降级。
        // 真实宿主里 `sessions.list()` 就是 live 集合本身，删旧会话时绝大多数落在这里。
        "done.detachedAbsent": "内存中已无此会话（无需摘除，属正常收尾）",
        "done.detachedNo": "内存条目未摘除（降级：只删了磁盘）",
        "done.keptGroup": "已保留它原有的工作区分组：会话仍在宿主内存里，此时摘掉归属会让它变成侧栏的「未分组」幽灵行。",
        "done.workspaces": "工作区记录：{count}",
        "done.files": "磁盘目录：{count}",
        "done.cache": "投影缓存：{count}",
        "done.audit": "审计：{path}",
        "done.auditOff": "审计：未开启",
        "done.auditFailed": "审计写入失败：{error}",
        "done.partial": "注意：没有摘除内存条目，也没有找到磁盘工件 —— 这个 id 可能本来就不存在。",
        "done.reloadHint": "侧边栏会话行会在宿主刷新列表后消失；若仍显示，刷新页面即可。（删除成功后已主动通知侧边栏，正常情况下它会自己消失。）",
        // 已成功通知官方侧栏移除该行（Host emit 了已声明的 Remote Event
        // api-session/removed，客户端据此把 id 从列表里抹掉）——
        // 这才是「删了却还在未分组里」的真修法：持久化数据早就清干净了，
        // 之前缺的只是让客户端重新拉一次列表。
        "done.announced": "已通知侧边栏移除该会话",
        // 通知没发成功（配置关掉 / 运行时没有该事件声明）：删除本身已成功，
        // 但侧栏要等它自己刷新才会消失，所以如实提示，不假装已经同步。
        "done.announceOff": "未能通知侧边栏（删除已成功）：侧边栏可能要刷新页面后才消失。",
        "done.close": "关闭",
        "panel.title": "对话清理",
        "panel.subtitle": "批量筛选并删除会话；删除不可恢复。",
        "panel.search": "搜索标题、会话 id 或项目路径…",
        "panel.searchLabel": "搜索会话",
        "panel.project": "项目",
        "panel.projectAll": "全部项目",
        "panel.state": "状态",
        "panel.stateAll": "全部",
        "panel.stateRunning": "运行中",
        "panel.stateIdle": "可删除",
        "panel.sort": "排序",
        "panel.sortActivity": "最后活动",
        "panel.sortCreated": "创建时间",
        "panel.refresh": "刷新",
        "panel.refreshing": "读取中…",
        "panel.loading": "正在读取会话清单…",
        "panel.empty": "没有匹配的会话",
        "panel.emptyBody": "换个关键词，或清空筛选后重试。",
        "panel.summary": "共 {total} 个会话 · 第 {page}/{pages} 页",
        "panel.summaryFiltered": "筛选出 {shown} 个（共 {total} 个）",
        "panel.cost": "{ms} ms · 标题 命中 {cached} / 新取 {fetched}",
        "panel.costSkipped": "{ms} ms · 已跳过标题读取",
        "panel.prev": "上一页",
        "panel.next": "下一页",
        "panel.colTitle": "会话",
        "panel.colProject": "项目",
        "panel.colUpdated": "最后活动",
        "panel.colState": "状态",
        "panel.colActions": "操作",
        "panel.selectPage": "全选本页可删除项",
        "panel.selected": "已选 {count} 个",
        "panel.hiddenSelection": "（另有 {count} 个已选但不在当前页，已忽略）",
        "panel.clearSelection": "取消选择",
        "panel.deleteSelected": "删除所选（{count}）",
        "panel.deleteOne": "删除",
        "panel.running": "运行中",
        "panel.idle": "空闲",
        "panel.persisted": "仅磁盘",
        "panel.live": "活动",
        "panel.blank": "空会话",
        "panel.blocked": "不可删除",
        "panel.archived": "归档",
        "panel.archivedHint": "归档会话仍保存在磁盘上；删除才是真正的销毁。",
        "panel.archivedHide": "隐藏已归档",
        "panel.archivedShow": "全部对话（显示已归档）",
        "panel.archivedOnly": "仅显示已归档",
        "panel.archivedRow": "已归档",
        "panel.archivedEmpty": "暂无已归档会话",
        "panel.kind": "会话类型",
        "panel.kindHint": "官方侧栏默认隐藏子代理会话；这里可单独查看以便清理。子代理会话同样可删除。",
        "panel.kindMain": "主会话",
        "panel.kindSubagent": "子代理会话",
        "panel.kindAll": "全部（含子代理）",
        "panel.subagentRow": "子代理",
        "panel.noTitle": "（无标题）",
        "panel.busy": "处理中 {done}/{total}…",
        "panel.resultTitle": "批量删除结果",
        "panel.resultOk": "成功 {ok} 个",
        "panel.resultFail": "失败 {fail} 个",
        "panel.resultPartial": "降级（只删了磁盘）{count} 个",
        "panel.resultFiles": "共删除磁盘目录 {count} 个",
        "panel.resultClose": "关闭",
        "panel.selectAllHint": "运行中的会话不可删除，不会被选中。",
        "error.title": "删除未完成",
        "error.label.what": "发生了什么",
        "error.label.why": "为什么",
        "error.label.next": "现在怎么办",
        "error.refused": "会话正在运行，宿主拒绝删除。",
        "error.cross-origin": "请求来源校验未通过。",
        "error.bad-request": "请求参数不被接受。",
        "error.rate-limited": "删除请求过于频繁。",
        "error.internal": "宿主内部出错。",
        "error.network": "连不上宿主端点，插件可能没有装载成功。",
        "error.badResponse": "宿主返回了无法识别的响应（HTTP {status}）。",
        "error.retry": "稍后重试。",
        "error.retryAfterStop": "先停止该会话的当前回复，或关闭该会话，然后重试。",
      },
      en: {
        "action.delete": "Delete this session",
        "action.deleting": "Deleting…",
        "confirm.title": "Delete session",
        "confirm.body": "Permanently delete: {title}",
        "confirm.warning": "This cannot be undone. The session log and its on-disk artifacts are removed.",
        "confirm.idLabel": "Session id",
        "confirm.ok": "Delete permanently",
        "confirm.cancel": "Cancel",
        "done.title": "Session deleted",
        "done.detached": "Live store entry detached",
        // The session was not in the host's live store at all (already closed/released) —
        // that is a normal finish, not a degradation. On the real host `sessions.list()`
        // *is* the live set, so deleting an old session lands here almost every time.
        "done.detachedAbsent": "No live entry to detach (normal finish)",
        "done.detachedNo": "Live store entry NOT detached (degraded: disk only)",
        "done.keptGroup": "Its workspace group membership was kept: the session is still in the host's live store, and detaching it now would leave a \"Ungrouped\" ghost row in the sidebar.",
        "done.workspaces": "Workspace records: {count}",
        "done.files": "On-disk directories: {count}",
        "done.cache": "Projection cache files: {count}",
        "done.audit": "Audit: {path}",
        "done.auditOff": "Audit: disabled",
        "done.auditFailed": "Audit write failed: {error}",
        "done.partial": "Note: nothing was detached and no on-disk artifact was found — this id may not have existed.",
        "done.reloadHint": "The sidebar row disappears once the host refreshes its list; reload the page if it lingers. (A successful delete already notifies the sidebar, so it normally drops on its own.)",
        // The Host emitted the declared Remote Event `api-session/removed`, so the
        // sidebar drops the row itself. This is the real fix for "deleted but still
        // shows under Ungrouped": the on-disk data was already gone — the only
        // missing piece was telling the client to re-pull its list.
        "done.announced": "The sidebar was told to drop this session",
        // Notification did not go out (disabled in config, or the runtime has no such
        // event declaration). The delete itself succeeded; the sidebar may keep the
        // stale row until it refreshes on its own. Say so instead of faking sync.
        "done.announceOff": "Could not notify the sidebar (delete succeeded): the row may linger until you reload the page.",
        "done.close": "Close",
        "panel.title": "Dialogue Cleanup",
        "panel.subtitle": "Filter and delete sessions in bulk. Deletion cannot be undone.",
        "panel.search": "Search title, session id, or project path…",
        "panel.searchLabel": "Search sessions",
        "panel.project": "Project",
        "panel.projectAll": "All projects",
        "panel.state": "State",
        "panel.stateAll": "All",
        "panel.stateRunning": "Running",
        "panel.stateIdle": "Deletable",
        "panel.sort": "Sort",
        "panel.sortActivity": "Last activity",
        "panel.sortCreated": "Created",
        "panel.refresh": "Refresh",
        "panel.refreshing": "Reading…",
        "panel.loading": "Reading the session list…",
        "panel.empty": "No matching sessions",
        "panel.emptyBody": "Try another keyword, or clear the filters and retry.",
        "panel.summary": "{total} sessions · page {page}/{pages}",
        "panel.cost": "{ms} ms · titles cached {cached} / fetched {fetched}",
        "panel.costSkipped": "{ms} ms · title reading skipped",
        "panel.summaryFiltered": "{shown} shown of {total} sessions",
        "panel.prev": "Previous",
        "panel.next": "Next",
        "panel.colTitle": "Session",
        "panel.colProject": "Project",
        "panel.colUpdated": "Last activity",
        "panel.colState": "State",
        "panel.colActions": "Actions",
        "panel.selectPage": "Select every deletable row on this page",
        "panel.selected": "{count} selected",
        "panel.hiddenSelection": "({count} more selected off-page — ignored)",
        "panel.clearSelection": "Clear selection",
        "panel.deleteSelected": "Delete selected ({count})",
        "panel.deleteOne": "Delete",
        "panel.running": "Running",
        "panel.idle": "Idle",
        "panel.persisted": "Disk only",
        "panel.live": "Live",
        "panel.blank": "Blank",
        "panel.blocked": "Not deletable",
        "panel.archived": "Archive",
        "panel.archivedHint": "Archived sessions are still on disk; deleting is what actually destroys them.",
        "panel.archivedHide": "Hide archived",
        "panel.archivedShow": "All conversations (show archived)",
        "panel.archivedOnly": "Archived only",
        "panel.archivedRow": "Archived",
        "panel.archivedEmpty": "No archived sessions yet",
        "panel.kind": "Session kind",
        "panel.kindHint": "The official sidebar hides subagent sessions by default; show them here to clean them up. Subagent sessions are deletable too.",
        "panel.kindMain": "Main sessions",
        "panel.kindSubagent": "Subagent sessions",
        "panel.kindAll": "All (incl. subagents)",
        "panel.subagentRow": "Subagent",
        "panel.noTitle": "(untitled)",
        "panel.busy": "Working {done}/{total}…",
        "panel.resultTitle": "Bulk delete result",
        "panel.resultOk": "{ok} succeeded",
        "panel.resultFail": "{fail} failed",
        "panel.resultPartial": "{count} degraded (disk only)",
        "panel.resultFiles": "{count} on-disk directories removed",
        "panel.resultClose": "Close",
        "panel.selectAllHint": "Running sessions cannot be deleted and are never selected.",
        "error.title": "Delete did not complete",
        "error.label.what": "What happened",
        "error.label.why": "Why",
        "error.label.next": "What to do now",
        "error.refused": "The host refused: this session is running.",
        "error.cross-origin": "The request-origin check did not pass.",
        "error.bad-request": "The request parameters were rejected.",
        "error.rate-limited": "Too many delete requests.",
        "error.internal": "The host failed internally.",
        "error.network": "Cannot reach the host endpoint; the plugin may not have loaded.",
        "error.badResponse": "The host returned an unrecognized response (HTTP {status}).",
        "error.retry": "Retry in a moment.",
        "error.retryAfterStop": "Stop the session's current reply, or close the session, then retry.",
      },
    };

    let ACTIVE_LOCALE = "en";
    /** `locale.bind(ns)` 的产物：读活动语言在**调用时**求值，自带 fallback 链。 */
    let boundTranslate = null;
    const listeners = [];
    function publish() {
      for (const fn of listeners.slice()) {
        try {
          fn();
        } catch {
          /* 一个订阅者失败不影响其余 */
        }
      }
    }
    function subscribe(fn) {
      listeners.push(fn);
      return () => {
        const at = listeners.indexOf(fn);
        if (at >= 0) listeners.splice(at, 1);
      };
    }
    function normalizeLocale(value) {
      return String(value ?? "").toLowerCase().indexOf("zh") === 0 ? "zh" : "en";
    }

    /**
     * 从 LocaleSnapshot 里读出活动语言。
     *
     * 【实测修正 · 这就是「语言不跟随宿主」的根因】
     * 现场 `client Service('locale')` 的契约是：
     *   LocaleSnapshot { active: LocaleId; locales: readonly LocaleDefinition[]; revision: number }
     * `active` 是**唯一**正确的字段。旧代码读的是 `snapshot?.id ?? snapshot?.locale ?? snapshot?.language`
     * —— 这三个字段**一个都不存在**，于是永远取到 undefined，静默落到
     * `navigator.language`：界面语言跟着**浏览器**走，而不是跟着宿主/插件本体走。
     *
     * 这里只认 `active`，取不到就如实返回 null，由调用方决定降级，不再假装成功。
     */
    function readActiveLocale(locale) {
      let snapshot = null;
      try {
        snapshot = locale?.getLocale?.() ?? locale?.getSnapshot?.() ?? null;
      } catch {
        return null; // 快照读取失败 —— 视为不可知
      }
      if (snapshot === null || typeof snapshot !== "object") return null;
      const value = snapshot.active;
      return typeof value === "string" && value !== "" ? value : null;
    }

    /** 模块级兜底翻译：先用 `locale.bind(ns)`（权威、跟随活动语言），再用内置表。 */
    function tt(key, vars) {
      if (boundTranslate !== null) {
        try {
          const bound = boundTranslate(key, vars);
          // bind 对缺失 key 会回显 key 本身 —— 那种情况继续走内置表。
          if (typeof bound === "string" && bound !== "" && bound !== key) return bound;
        } catch {
          /* 落到内置表 */
        }
      }
      const table = STRINGS[ACTIVE_LOCALE] ?? STRINGS.en;
      let value = table[key] ?? STRINGS.en[key] ?? key;
      if (vars) {
        value = String(value).replace(/\{(\w+)\}/g, (m, name) =>
          vars[name] === undefined || vars[name] === null ? m : String(vars[name]),
        );
      }
      return value;
    }
    /** 组件用：订阅语言变化。 */
    function useLocaleTick() {
      const [, bump] = React.useState(0);
      React.useEffect(
        () =>
          subscribe(() => {
            bump((n) => n + 1);
          }),
        [],
      );
      return ACTIVE_LOCALE;
    }

    // ─── 模块级对话框状态 ───────────────────────────────────────────────────
    // 菜单项在行的渲染里，弹窗在 shell.overlay；两者靠这份模块级状态通信。
    let dialog = null;
    const dialogListeners = [];
    function setDialog(next) {
      dialog = next;
      for (const fn of dialogListeners.slice()) {
        try {
          fn();
        } catch {
          /* 忽略 */
        }
      }
    }
    function useDialog() {
      const [, bump] = React.useState(0);
      React.useEffect(
        () =>
          subscribeDialog(() => {
            bump((n) => n + 1);
          }),
        [],
      );
      return dialog;
    }
    function subscribeDialog(fn) {
      dialogListeners.push(fn);
      return () => {
        const at = dialogListeners.indexOf(fn);
        if (at >= 0) dialogListeners.splice(at, 1);
      };
    }

    /**
     * 删除完成后的「请刷新清单」信号。
     * 弹窗在 shell.overlay、面板在 main，两者不共享 React 树，所以用模块级计数器通信。
     */
    let reloadSignal = 0;
    const reloadListeners = [];
    function setReloadSignal(updater) {
      reloadSignal = typeof updater === "function" ? updater(reloadSignal) : updater;
      for (const fn of reloadListeners.slice()) {
        try {
          fn(reloadSignal);
        } catch {
          /* 单个订阅者失败不影响其余 */
        }
      }
    }
    function useReloadSignal() {
      const [value, setValue] = React.useState(reloadSignal);
      React.useEffect(() => {
        const listener = (next) => setValue(next);
        reloadListeners.push(listener);
        return () => {
          const at = reloadListeners.indexOf(listener);
          if (at >= 0) reloadListeners.splice(at, 1);
        };
      }, []);
      return value;
    }

    // ─── 样式（只引用 --dsw-alias-* 令牌；随组件卸载一起消失，R-29） ─────────
    const CSS = `
/* ───────────── 会话行 ⋮ 菜单项 ───────────── */
.dscc-menu-row {
  display: flex; align-items: center; gap: 8px;
  width: 100%; box-sizing: border-box;
  padding: 7px 10px; margin: 0; border: 0;
  border-radius: 6px; background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 13px; line-height: 18px;
  text-align: left; cursor: pointer;
}
.dscc-menu-row:hover { background: var(--dsw-alias-bg-layer-2); }
.dscc-menu-row:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.dscc-menu-row[disabled] { color: var(--dsw-alias-label-secondary); cursor: default; }
.dscc-menu-row-icon { flex: none; width: 14px; height: 14px; display: block; }
/* slot 契约要求一个 role="menuitem" 的 button；官方用 separatorBefore 起一组，
   这里用一条分隔线达到同样的视觉分组效果。 */
.dscc-sep { margin: 4px 8px 5px; border-top: 1px solid var(--dsw-alias-border-l1); }

    // ─── 官方形态控件（dscc- 前缀） ───────────────────────────────────────
    //
    // 【这些规则从哪来 · R-23 的正确口径】
    // R-23 禁止的是把官方包当模块加载（require 那个 primitives 包）。
    // 同一条规则紧接着给了**正路**：
    //   「Write your own controls and match the host instead: copy markup, CSS,
    //     and behavior from the primitive into the plugin … Rename copied
    //     classes under your plugin's prefix, keep only --dsw-alias-* token
    //     references, and keep the behavior that users rely on, such as Modal
    //     focus and Escape handling …」
    // 所以这里的几何/层级/交互**逐条照官方抄**，类名全部加 dscc- 前缀，
    // 颜色只留 --dsw-alias-* 令牌。官方那套 --dsw-radius-* /
    // --dsw-alias-interactive-bg-* / --dsw-alias-button-* 名字
    // **不在**现场 Theme.listTokens 的 14 个令牌里（R-24），
    // 因此半径/悬停底色一律换算成令牌表达，不引入不存在的名字。
    //
    // ⚠ 本注释与下面所有注释内都**不得出现反引号** —— CSS 在 JS 模板串里，
    //   一个反引号就提前终止模板串（已因此踩坑多次）。
    //
    // 【已保留的本插件实测修复】下面每条都曾是真 bug，换皮不得弄丢：
    //   1. 按钮文字 nowrap —— 否则「刷新」被压成「刷/新」两行；
    //   2. hover 换底只作用于中性按钮 —— 否则实心按钮悬停即"消失"（对比度≈0）；
    //   3. 主内容列 min-width:0 —— 否则标题省略号不生效；
    //   4. 卡片行内不得 break-all —— 否则中文标题逐字符折断。
    //
    // 官方 Button 尺寸刻度：md=36px 高 / 12px 圆角，sm=28px 高 / 8px 圆角。
    // 圆角用官方同一族尺度，但没有 --dsw-radius-* 令牌，故直接写字面值，
    // 并注明它对应官方哪一档（字面几何不是"颜色"，不受 R-24 约束）。

    // ───────────── 按钮：官方 Button（ghost / primary / danger / sm） ─────────────
    .dscc-btn {
      box-sizing: border-box;
      display: inline-flex; align-items: center; justify-content: center; gap: 4px;
      border: none; border-radius: 12px; /* 官方 md 圆角 */
      cursor: pointer;
      font: inherit; font-size: 14px; line-height: 22px;
      color: var(--dsw-alias-label-primary);
      background: transparent;
      padding: 0 14px; height: 36px;
      /* 【实测修复 1】按钮文字不得折行：中文可在任意字符处断行，
         一旦按钮被 flex 压到 min-content（= 一个字宽），文字就会竖排。 */
      white-space: nowrap;
    }
    .dscc-btn:disabled { cursor: not-allowed; opacity: 0.4; }
    /* 悬停底色：官方 ghost 用 interactive-bg-hover；该令牌不在现场全表里，
       用 bg-layer-2 达到同一观感（次级浮层底色）。 */
    .dscc-btn:not(.dscc-btn-primary):not(.dscc-btn-danger):not(:disabled):hover {
      background: var(--dsw-alias-bg-layer-2);
    }
    .dscc-btn:not(.dscc-btn-primary):not(.dscc-btn-danger):not(:disabled):active {
      background: var(--dsw-alias-bg-layer-1);
    }
    /* 【实测修复 2】实心变体悬停只做亮度微调：文字与背景同时等比变化，
       对比度保持。旧版 hover 换底（优先级 0,2,0）压过变体实心背景（0,1,0），
       结果是浅色面 + 底色文字 ⇒ 鼠标一移上去文字就"消失"。 */
    .dscc-btn-primary:hover:not(:disabled),
    .dscc-btn-danger:hover:not(:disabled) { filter: brightness(1.12); }
    .dscc-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
    .dscc-btn-primary {
      background: var(--dsw-alias-brand-primary);
      color: var(--dsw-alias-bg-base);
    }
    /* 破坏性主操作：官方没有 danger 实心档（它的 Tag/StateDot 才分 danger），
       这里沿用本插件既有的 error 令牌实心底，与官方"状态色即语义色"一致。 */
    .dscc-btn-danger {
      background: var(--dsw-alias-state-error-primary);
      color: var(--dsw-alias-bg-base);
    }
    /* 官方 sm 刻度：28px 高 / 12px 字 / 8px 圆角，行内操作用它。 */
    .dscc-btn-small { height: 28px; font-size: 12px; line-height: 18px; padding: 0 10px; border-radius: 8px; }

    // ───────────── 徽标：官方 Tag（outline / 状态色底纹） ─────────────
    // 官方 Tag 的形态：999px 全圆角、11px/17px、500 字重、nowrap；
    // 状态色 tone 用 color-mix 10% 自着色底 + 同色文字（一次换色，底与字一起动）。
    .dscc-badge {
      display: inline-flex; align-items: center;
      border-radius: 999px; padding: 1px 8px;
      font-size: 11px; line-height: 17px; font-weight: 500;
      white-space: nowrap;
      /* outline = 官方默认档：细边 + 次级文字色。 */
      border: 0.5px solid var(--dsw-alias-border-l2);
      color: var(--dsw-alias-label-secondary);
    }
    .dscc-badge-ok {
      border-color: transparent;
      background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent);
      color: var(--dsw-alias-state-success-primary);
    }
    .dscc-badge-running {
      border-color: transparent;
      background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent);
      color: var(--dsw-alias-state-warn-primary);
    }
    .dscc-badge-archived {
      border-color: transparent;
      background: color-mix(in srgb, var(--dsw-alias-state-idle-primary) 10%, transparent);
      color: var(--dsw-alias-state-idle-primary);
    }
    .dscc-badge-subagent {
      border-color: transparent;
      background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent);
      color: var(--dsw-alias-state-warn-primary);
    }

    // ───────────── 卡片：官方卡面（浮层底 + 面板级圆角） ─────────────
    // 官方 Modal 的卡片用「次级浮层底 + 面板级圆角 + prominent  elevation」。
    // 令牌全表里没有 --dsw-radius-panel / --dsw-elevation-prominent，
    // 圆角取官方同族最大值 16px，阴影按字面色处理（R-24 只限颜色，
    // 而 rgba(0,0,0,*) 是唯一被允许的字面阴影，见下方 R-24 测试的豁免口径）。
    .dscc-card,
    .dscc-row,
    .dscc-filters,
    .dscc-panel-bulk,
    .dscc-panel-result,
    .dscc-panel-state {
      border: 1px solid var(--dsw-alias-border-l1);
      border-radius: 16px;
      background: var(--dsw-alias-bg-layer-2);
    }

/* 【实测修复 · 弹窗不置顶】
   旧实现只靠 position:fixed + inset:0，**没有 z-index**，而本插件是从**设置页**
   打开的，设置面板本身是一个高层级浮层；shell.overlay 里的普通定位元素盖不过它
   —— 于是确认框「弹了但不在最上面」。

   修法见紧接的 .dscc-modal：官方 Modal 同样不用原生 dialog，
   而是 position:fixed + z-index:1000 + 自己管焦点与 Esc。 */
/* ───────────── 弹窗（官方 Modal 形态） ─────────────
   【为什么不是原生 dialog】官方 Modal 用的是 div + position:fixed + z-index，
   而不是 <dialog> + showModal()。理由与取舍见 useModalLayer 的注释：
   焦点陷阱与 Esc 自己实现，才能做到「busy 时 Esc 不关」这条确定分支。
   z-index 取 1000（与官方 Modal 同值）：它高于设置面板等高层级浮层，
   这正是用户实测「弹了但不在最上面」的旧伤的修法。 */
.dscc-modal {
  position: fixed; inset: 0; z-index: 1000;
  display: flex; align-items: center; justify-content: center;
  padding: 24px;
  pointer-events: auto;
}
/* 遮罩铺满浮层；底色用 bg-base 的 45% 混合（官方 bg-mask-1 不在现场令牌全表）。 */
.dscc-scrim {
  position: absolute; inset: 0; pointer-events: auto;
  display: flex; align-items: center; justify-content: center;
  padding: 24px;
  background: color-mix(in srgb, var(--dsw-alias-bg-base) 45%, transparent);
}
.dscc-card {
  width: min(460px, 100%); box-sizing: border-box;
  background: var(--dsw-alias-bg-overlay);
  color: var(--dsw-alias-label-primary);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 12px; padding: 18px 20px 16px;
  box-shadow: 0 18px 48px rgb(0 0 0 / 32%);
  font: inherit;
}
.dscc-card h2 { margin: 0 0 10px; font-size: 15px; line-height: 22px; color: var(--dsw-alias-label-primary); }
.dscc-card p { margin: 0 0 10px; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
.dscc-card .dscc-subject {
  color: var(--dsw-alias-label-primary); font-weight: 600;
  word-break: break-word;
}
.dscc-card .dscc-id {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px; color: var(--dsw-alias-label-secondary);
  word-break: break-all;
}
.dscc-warn {
  display: flex; gap: 8px; align-items: flex-start;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px; padding: 10px 12px; margin: 0 0 14px;
  font-size: 12px; line-height: 18px;
  color: var(--dsw-alias-label-primary);
}
.dscc-warn-dot {
  flex: none; width: 8px; height: 8px; margin-top: 5px; border-radius: 50%;
  background: var(--dsw-alias-state-error-primary);
}
.dscc-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.dscc-kv { margin: 2px 0 0; padding: 0; list-style: none; font-size: 12px; line-height: 19px; color: var(--dsw-alias-label-secondary); }
.dscc-error-code {
  display: inline-block; margin-bottom: 6px; padding: 1px 6px; border-radius: 4px;
  border: 1px solid var(--dsw-alias-border-l2);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px;
  color: var(--dsw-alias-label-secondary);
}

/* ───────────── 批量管理面板（设置页 section） ───────────── */
.dscc-section { display: block; }
/* 设置页内容列自己滚动，所以这里用自适应高度而不是 100vh。
   【实测修复 · 级联】必须写成 .dscc-panel.dscc-panel-section（优先级 0,2,0）。
   原来只写 .dscc-panel-section（0,1,0），与 .dscc-panel 同优先级且**排在其前**，
   于是 .dscc-panel 的 height:100% / padding:20px 22px / background 全部胜出 ——
   这条规则从未生效。已用真浏览器 computed style 取证：
   padding 实为 20px 22px、背景实为白色，正是 .dscc-panel 的值。
   （注释内不得写反引号：CSS 在 JS 模板串里，会提前终止。） */
.dscc-panel.dscc-panel-section { height: auto; padding: 0; background: transparent; }
.dscc-panel {
  display: flex; flex-direction: column; gap: 12px;
  height: 100%; box-sizing: border-box; padding: 20px 22px;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary); font: inherit;
}
.dscc-panel-head h1 { margin: 0 0 2px; font-size: 16px; line-height: 24px; }
.dscc-panel-head p { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
/* ───────────── 筛选区（等宽网格，照原项目的克制风格） ─────────────
   【为什么又改】上一版用 flex-wrap 排「标签+下拉」，每个下拉按内容自适应宽度，
   于是每一行的标签起点、下拉宽度都不一样 —— 截图里看着就是「乱」。
   flex-wrap 天然产生这种参差，靠调 gap 治不好。
   改用 **CSS Grid 定列**：标签列 + 控件列各占固定轨道，
   所有行的标签右对齐、所有下拉等宽，天然整齐。
   原项目（@haoranwang0921/dsh-session-cleaner）的克制做法也是
   「少控件 + 固定宽度 + flex 卡片行」，不做花哨响应式。 */
/* 筛选区：**外层就用网格**，两列 = [1fr 自适应宽的控件列] + [按钮列]。
   为什么这样写（用户反馈「对齐输入框」）：
   原来外层是 flex-direction: column，第 1 行（搜索+刷新）与第 2 行（筛选网格）
   各自独占整宽。于是搜索框右边停在「刷新」按钮左边（实测 752px），
   而筛选网格铺到卡片右内边（实测 840px）—— **右边界差 87.58px**，看着就是没对齐。

   现在把「搜索框」与「筛选网格」放进**同一列**：
     · .dscc-filters-row { display: contents } → 行容器不生成盒子，
       搜索框与刷新按钮直接成为外层网格的两个格子（第 1 列 / 第 2 列）；
     · .dscc-filters-grid { grid-column: 1 } → 筛选网格也占第 1 列。
   两者同列 ⇒ **左右边界由布局保证一致**，不靠手调 padding 去凑。
   （这比「给网格加一个等于按钮宽度的右内边距」稳：按钮文字变长变短都不受影响。）

   ⚠ 注释里不能用反引号：CSS 在 JS 模板字符串里，一个反引号就提前终止模板串。
   已因此踩坑多次，这条规则在本文件里反复出现，务必遵守。 */
.dscc-filters {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 10px;
  padding: 12px 14px; border-radius: 16px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2);
}
/* 行容器不生成盒子 —— 它只为容纳「搜索框 + 按钮」而存在，本身不该占格子。 */
.dscc-filters-row { display: contents; }
/* 搜索框：占满所在列（第 1 列），宽度交给网格轨道决定。 */
.dscc-input.dscc-filters-search { width: 100%; min-width: 0; }

/* 筛选网格：与搜索框**同列**，所以宽度天然一致；
   控件列用 1fr 均分剩余宽度 —— 长文案（如「全部对话（显示已归档）」）不再被截断。 */
.dscc-filters-grid {
  grid-column: 1;
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr) 48px minmax(0, 1fr);
  align-items: center;
  gap: 8px 10px;
}
/* 字段：<label> 自身不生成盒子（display:contents），
   于是它的两个子节点（标签 span + select）**直接成为网格项** ——
   既保证「标签列 / 控件列」严格对齐，又保留「点标签聚焦控件」的原生语义。 */
.dscc-field { display: contents; }
.dscc-field-label {
  font-size: 12px; line-height: 18px; white-space: nowrap;
  color: var(--dsw-alias-label-secondary);
  width: 100%;
  text-align: justify;
  text-align-last: justify;
}
.dscc-input {
  box-sizing: border-box; width: 100%;
  padding: 7px 10px; border-radius: 7px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; line-height: 18px;
}
.dscc-input:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
/* 下拉固定宽度：由网格轨道决定，不再按内容长短参差。 */
.dscc-select {
  box-sizing: border-box; width: 100%;
  padding: 6px 8px; border-radius: 7px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; line-height: 18px;
}
.dscc-select:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }

.dscc-panel-bulk {
  display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
  padding: 8px 10px; border-radius: 16px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2);
}
.dscc-panel-count { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dscc-panel-fail { color: var(--dsw-alias-state-error-primary); font-size: 12px; }
.dscc-panel-result {
  display: flex; flex-wrap: wrap; gap: 10px; align-items: center;
  padding: 9px 12px; border-radius: 16px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2);
  font-size: 12px;
}
.dscc-panel-state {
  padding: 28px 16px; border-radius: 16px; text-align: center;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 20px;
}
.dscc-panel-state p { margin: 0 0 6px; }

/* ───────────── 会话列表：卡片式行（照原项目 sessdel-row 的做法） ─────────────
   【为什么不用表格】表格要 6 列都对齐，而列宽/换行/省略号互相牵制，
   稍一变窄就出现「逐字符换行」「标签乱飘」。原项目用的是
   「flex 卡片行 + 左内容右操作」，各行的内部结构独立，天然不会错位，
   窄屏也只是内容变少、不会整体崩掉。这里照它的思路重做。 */
.dscc-listwrap { flex: 1 1 auto; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 6px; padding-right: 2px; }
.dscc-list-head {
  display: flex; align-items: center; gap: 10px;
  padding: 0 12px 2px 12px;
  font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary);
}

/* 一行 = 一张卡片（官方卡面：border-l1 + 16px 圆角 + bg-layer-2） */
.dscc-row {
  display: flex; align-items: center; gap: 10px;
  box-sizing: border-box; padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 16px;
  background: var(--dsw-alias-bg-layer-2);
}
.dscc-row:hover { background: var(--dsw-alias-bg-layer-1); }
.dscc-row-blocked { opacity: 0.62; }
.dscc-row-check { flex: none; width: 16px; height: 16px; margin: 0; }

/* 主内容列：可收缩（min-width:0 是关键，否则里面的省略号不生效） */
.dscc-row-main { min-width: 0; flex: 1 1 auto; }
.dscc-row-title {
  font-size: 13px; line-height: 18px; color: var(--dsw-alias-label-primary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dscc-row-meta {
  margin-top: 2px; font-size: 11px; line-height: 16px;
  color: var(--dsw-alias-label-secondary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dscc-row-meta code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
}
.dscc-row-sep { margin: 0 6px; opacity: 0.6; }

/* 右侧固定宽度区：状态徽标 + 操作按钮，各行位置一致 */
.dscc-row-side { flex: none; display: flex; align-items: center; gap: 8px; }
.dscc-row-badge { flex: none; width: 62px; text-align: right; }
.dscc-row-actions { flex: none; }

.dscc-panel-pager { display: flex; gap: 10px; align-items: center; justify-content: flex-end; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dscc-panel-cost { font-variant-numeric: tabular-nums; opacity: 0.85; }
.dscc-panel-hidden { color: var(--dsw-alias-state-warn-primary); }

.dscc-btn-small { padding: 4px 10px; font-size: 12px; }
`;
    function Styles() {
      return h("style", { "data-dscc": "styles" }, CSS);
    }

    /**
     * 翻译优先级 —— 严格按官方 harness 的既定路径，不自创口径。
     *
     * 依据（官方 `@deepseek-ai/dsh-client-locale` README 实现小节）：
     *   「`LocaleRuntime` 同时拥有偏好与字典注册表，并且**自身就是 slot 系统的 `LocaleFace`**：
     *     `getSnapshot`/`subscribe` 支撑**框架注入的 `t` 席位**。」
     *   「产品编写的 Client UI 文本必须来自这些**带类型的字典**，或来自已经本地化的 primitive prop。」
     *
     * 因此权威顺序是：
     *   1. **slot 注入的 `t` 席位**（`props.t`）—— 框架直接给的，跟随 harness 活动语言，
     *      并且语言切换会由 LocaleFace 驱动出口重渲染，最权威；
     *   2. `ctx.locale.bind(ns)` —— 同一个运行时，身份稳定，用于拿不到 props 的模块级场景
     *      （如 `settings.section` 的 `label` thunk）；
     *   3. 内置兜底表 —— 仅在 1、2 都不可用（服务缺失/注册失败）时接管。
     *
     * 关键点：1 与 2 都**在调用时**求值，所以语言变化立即可见，无需重新注册。
     */
    function makeTranslator(injectedT) {
      return (key, vars) => {
        if (typeof injectedT === "function") {
          try {
            const value = injectedT(key, vars);
            // 席位对缺失 key 会回显 key 本身 —— 那种情况继续往下走。
            if (typeof value === "string" && value !== "" && value !== key) return value;
          } catch {
            /* 落到 bind / 内置表 */
          }
        }
        return tt(key, vars);
      };
    }

    /**
     * 会话行 ⋮ 菜单项。
     *
     * 官方契约（实测 ownerProps）：只拿到行身份 `sessionId` / `displayTitle`。
     * 渲染一个 `role="menuitem"` 的 button，并用 slot 级 `useMenuOpenState` 关菜单。
     * `separatorBefore` 的等价物：官方 archive 之后另起一组，用一条分割线在视觉上分组。
     */
    function DeleteSessionMenuItem(props) {
      const { sessionId, displayTitle, useMenuOpenState } = props;
      useLocaleTick();

      // useMenuOpenState 由 slot 级 hookContext 注入（实测该 slot 的 hookContext = MenuOpenState）。
      // hook 必须无条件调用。
      const menuPair = typeof useMenuOpenState === "function" ? useMenuOpenState() : null;
      const closeMenu = Array.isArray(menuPair) && typeof menuPair[1] === "function" ? menuPair[1] : null;
      const t = makeTranslator(props.t);

      const onActivate = () => {
        if (typeof closeMenu === "function") {
          try {
            closeMenu(false);
          } catch {
            /* 关不掉菜单不阻塞主流程 */
          }
        }
        setDialog({ sessionId, displayTitle, busy: false, result: null, error: null });
      };

      return h(
        React.Fragment,
        null,
        // 【实测修复 · H1：菜单项必须在**自己的树里**挂样式表。
        // 原来这里只有分隔线 + 按钮，而 `<style>` 只在 DeleteDialog / 面板里渲染 ——
        // 所以会话行右侧「⋮」菜单里的「删除」项**完全没有样式**：
        // 直到打开弹窗或设置页才短暂生效，弹窗一关又没了。
        // 已用真实渲染取证：菜单项的标签序列是 div,button,svg,path,...,span，不含 style。
        h(Styles, null),
        h("div", { className: "dscc-sep", role: "separator", "aria-hidden": "true" }),
        h(
          "button",
          { type: "button", role: "menuitem", className: "dscc-menu-row", onClick: onActivate },
          h(
            "svg",
            {
              className: "dscc-menu-row-icon",
              viewBox: "0 0 16 16",
              "aria-hidden": "true",
              fill: "none",
              stroke: "currentColor",
              strokeWidth: "1.4",
              strokeLinecap: "round",
              strokeLinejoin: "round",
            },
            h("path", { d: "M2.5 4.5h11" }),
            h("path", { d: "M6 4.5V3.2h4v1.3" }),
            h("path", { d: "M4 4.5l.7 8.3h6.6l.7-8.3" }),
            h("path", { d: "M6.7 7v3.6M9.3 7v3.6" }),
          ),
          h("span", null, t("action.delete")),
        ),
      );
    }

    /** POST /delete 并做契约解析。 */
    async function requestDelete(sessionId) {
      return postDelete({ sessionId });
    }

    /** 批量：一次请求删多个（Host 端逐条复用同一个 service 实现）。 */
    async function requestDeleteMany(sessionIds) {
      return postDelete({ sessionIds });
    }

    async function postDelete(payload) {
      let response;
      try {
        response = await fetch(`${BASE}/delete`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
      } catch (error) {
        return { ok: false, error: { code: "network", message: String(error?.message ?? error) } };
      }

      let body = null;
      try {
        body = await response.json();
      } catch {
        return {
          ok: false,
          error: { code: "badResponse", message: `HTTP ${response.status}`, status: response.status },
        };
      }
      if (body === null || typeof body !== "object" || typeof body.ok !== "boolean") {
        return {
          ok: false,
          error: { code: "badResponse", message: `HTTP ${response.status}`, status: response.status },
        };
      }
      return body;
    }

    /** 错误码 → 面向用户的说明（三条：发生了什么 / 为什么 / 现在怎么办）。 */
    function explain(error, t) {
      const code = error?.code ?? "internal";
      const what = t(`error.${code}`) === `error.${code}` ? t("error.internal") : t(`error.${code}`);
      return {
        code,
        what,
        why: error?.message ?? "",
        next: code === "refused" ? t("error.retryAfterStop") : t("error.retry"),
        hint: error?.hint ?? null,
      };
    }

    /**
     * 官方 Modal 的**层级与键盘语义**（R-23 正路：拷贝行为，不 require 包）。
     *
     * 逐条对齐官方 useModalLayer 的行为，只保留本插件需要的那部分：
     *   · 打开时把焦点移进卡片（优先 data-modal-autofocus，再找第一个可聚焦元素）；
     *   · Esc 关闭，且 repeat 不重复触发；Ctrl/Alt/Meta 组合键不拦截（让宿主快捷键走）；
     *   · Tab / Shift+Tab 在卡片内**循环**（焦点陷阱），不会走到背后页面；
     *   · 关闭时把焦点还给打开前的元素（模态关闭后焦点不丢）。
     *
     * 【为什么不再用原生 dialog + showModal()】
     * 原生方案确实能进 top layer，但官方自己并**没有**用它：官方 Modal 是
     * position:fixed + z-index + createPortal 到 body。原生方案有三个副作用：
     *   1. ::backdrop 会与我们的 .dscc-scrim 叠加，不得不把它置透明；
     *   2. 它在 DOM 里是一个 <dialog> 元素，官方侧栏/设置页的样式与查询选择器
     *      可能对它产生意料之外的匹配；
     *   3. 焦点陷阱与 Esc 全交给浏览器，我们无法「busy 时禁止关闭」——
     *     而删除进行中关掉界面正是要避免的（旧代码只能 preventDefault 赌一把）。
     * 现在顶层由 .dscc-modal 的 z-index 负责（见 CSS），键盘与焦点自己管，
     * 于是「busy 时 Esc 不关」变成一条确定的分支，而不是浏览器的默认行为。
     *
     * 【R-22 的边界】官方用 createPortal 到 document.body，那正是 R-22 禁止的
     * （不得往 document.body 追加）。本插件**不做 portal**：覆盖层就渲染在
     * shell.overlay 这个官方分配的槽位里，靠 z-index 取胜 —— 既不违规，
     * 也拿到官方那套焦点/Esc 语义。
     *
     * 可选焦点元素选择器：与官方同一套口径（按钮/输入/下拉/可编辑/tabindex）。
     */
    const MODAL_FOCUSABLE = [
      "button:not([disabled])",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      "a[href]",
      "[tabindex]:not([tabindex='-1'])",
    ].join(",");

    function useModalLayer(dialogRef, open, onClose, allowClose) {
      // 关闭回调与「是否允许关闭」都走 ref：它们是每次渲染都会变的新闭包，
      // 而 effect 只该在 open 翻转时重挂一次监听（官方同样用 ref 持有）。
      const closeBox = React.useState(() => ({ current: onClose }));
      const closeRef = closeBox[0];
      closeRef.current = onClose;
      const allowBox = React.useState(() => ({ current: allowClose }));
      const allowRef = allowBox[0];
      allowRef.current = allowClose;

      React.useEffect(() => {
        const element = dialogRef.current;
        if (!open || element === null || element === undefined) return undefined;
        const doc = element.ownerDocument ?? document;
        const previous = doc.activeElement;

        // 初始焦点：优先 data-modal-autofocus 标记，再退到第一个可聚焦元素。
        const initial =
          (typeof element.querySelector === "function" &&
            element.querySelector("[data-modal-autofocus]")) ??
          (typeof element.querySelector === "function" && element.querySelector(MODAL_FOCUSABLE)) ??
          element;
        if (initial && typeof initial.focus === "function" && !element.contains(doc.activeElement)) {
          initial.focus();
        }

        const keydown = (event) => {
          // 与宿主快捷键共存：带修饰键的一律不拦。
          if (event.ctrlKey === true || event.altKey === true || event.metaKey === true) return;
          if (event.defaultPrevented === true) return;
          if (event.key === "Escape" && event.shiftKey !== true) {
            event.preventDefault();
            // repeat 不重复触发：按住 Esc 只关一次。
            if (event.repeat !== true && allowRef.current !== false) closeRef.current();
            return;
          }
          if (event.key !== "Tab") return;
          // 菜单打开时 Tab 归菜单（官方同款）：本插件菜单不在卡片内，直接放行。
          const active = doc.activeElement;
          if (active && typeof active.closest === "function" && active.closest('[role="menu"]')) return;
          const items =
            typeof element.querySelectorAll === "function"
              ? [...element.querySelectorAll(MODAL_FOCUSABLE)].filter(
                  (item) => !(item.closest && item.closest("[inert], [hidden]")),
                )
              : [];
          const first = items[0] ?? element;
          const last = items[items.length - 1] ?? element;
          const atEdge = event.shiftKey === true ? active === first : active === last;
          if (active === element || !element.contains(active) || atEdge) {
            event.preventDefault();
            const target = event.shiftKey === true ? last : first;
            if (target && typeof target.focus === "function") target.focus();
          }
        };

        doc.addEventListener("keydown", keydown);
        return () => {
          doc.removeEventListener("keydown", keydown);
          // 关闭后把焦点还给打开前的元素（官方同款：模态不该吞掉焦点）。
          const target =
            previous && previous.isConnected === true
              ? previous
              : null;
          if (target && typeof target.focus === "function") target.focus();
        };
      }, [dialogRef, open, closeRef, allowRef]);
    }

    /**
     * 确认框 / 结果框（注册在 `shell.overlay`）。
     *
     * 注意：该 slot 的 ownerProps 实测为**空**（不像菜单项会给 `t` 席位），
     * 所以这里走 `makeTranslator(props?.t)` —— `t` 缺席时自动退到
     * `locale.bind(ns)`，再退到内置表；一旦框架确实注入了席位也能直接用上。
     */
    function DeleteDialog(props) {
      useLocaleTick();
      const state = useDialog();
      const t = makeTranslator(props?.t);
      // 【实测约束】官方 Builtin 文档给 Client 的 React 只保证
      // createElement / useState / useEffect —— **没有 useRef**。
      // 所以用 useState 的惰性初始值拿一个跨渲染稳定的 ref 盒子
      // （惰性初始值只在首次渲染求值，因此盒子身份跨渲染稳定）。
      const refBox = React.useState(() => ({ current: null }));
      const dialogRef = refBox[0];

      /**
       * 顶层浮层：position:fixed + z-index（见 .dscc-modal），
       * 层级高于设置面板这类高层级浮层（用户实测「弹了但不在最上面」的旧伤）。
       * 键盘与焦点由 useModalLayer 负责，行为与官方 Modal 一致。
       * busy 时不允许关闭 —— 删除进行中把界面关掉会让人以为操作被取消。
       */
      useModalLayer(dialogRef, state !== null, () => setDialog(null), state?.busy !== true);

      // Esc 与焦点陷阱由 useModalLayer 负责（见上方说明）：
      // busy 时不允许关闭，删除进行中界面不会被 Esc 关掉。
      // 遮罩点击**故意不关闭**（见 JSX 处的注释）。

      if (state === null) return null;

      const run = async () => {
        const ids =
          Array.isArray(state.bulkIds) && state.bulkIds.length > 0 ? state.bulkIds : [state.sessionId];
        setDialog({ ...state, busy: true, error: null, result: null });

        // 单条：走单个端点，信息最具体。
        if (ids.length === 1) {
          const only = await requestDelete(ids[0]);
          if (only.ok === true) {
            setDialog({ ...state, busy: false, result: only.value ?? {}, error: null });
          } else {
            setDialog({ ...state, busy: false, result: null, error: only.error ?? { code: "internal" } });
          }
          setReloadSignal((n) => n + 1);
          return;
        }

        // 批量：**一次请求**删多个，Host 端逐条复用同一个 service 实现。
        const body = await requestDeleteMany(ids);
        if (body.ok === true) {
          const value = body.value ?? {};
          setDialog({
            ...state,
            busy: false,
            error: null,
            result: {
              bulk: true,
              total: value.total ?? ids.length,
              ok: value.ok ?? 0,
              fail: value.fail ?? 0,
              partial: value.partial ?? 0,
              files: value.files ?? 0,
              failures: (value.outcomes ?? [])
                .filter((o) => o.ok !== true)
                .map((o) => o.error ?? { code: "internal" }),
            },
          });
        } else {
          // 整批被拒（如限流 429 / 跨站 403）——原样透出原因，不谎报部分成功。
          setDialog({ ...state, busy: false, result: null, error: body.error ?? { code: "internal" } });
        }
        setReloadSignal((n) => n + 1);
      };

      let body;
      if (state.result !== null && state.result.bulk === true) {
        // 批量结果：聚合计数 + 逐条失败原因
        const v = state.result;
        body = h(
          "div",
          { className: "dscc-card" },
          h(Styles, null),
          h("h2", null, t("panel.resultTitle")),
          h(
            "ul",
            { className: "dscc-kv" },
            h("li", { key: "ok" }, t("panel.resultOk", { ok: v.ok })),
            v.fail > 0 ? h("li", { key: "fail", className: "dscc-panel-fail" }, t("panel.resultFail", { fail: v.fail })) : null,
            v.partial > 0 ? h("li", { key: "partial" }, t("panel.resultPartial", { count: v.partial })) : null,
            h("li", { key: "files" }, t("panel.resultFiles", { count: v.files })),
          ),
          ...(v.failures ?? []).slice(0, 8).map((failure, index) =>
            h(
              "p",
              { key: `f${index}`, className: "dscc-panel-fail" },
              `${failure.code ?? "internal"}：${failure.message ?? ""}`,
            ),
          ),
          h(
            "div",
            { className: "dscc-actions" },
            h("button", { type: "button", className: "dscc-btn dscc-btn-primary", onClick: () => setDialog(null) }, t("panel.resultClose")),
          ),
        );
      } else if (state.result !== null) {
        const v = state.result;
        const rows = [];
        // 内存条目三态：detached（摘掉了）/ absent（本就不在内存里，正常收尾）/ failed（真降级了）。
        //
        // 【修正 · 原来只有 `v.detached === true ? … : …` 两态】真实宿主里
        // `sessions.list()` 就是 live 集合本身，删一个已关闭的会话时它「本来就不在内存里」，
        // 旧逻辑会把这句正常收尾显示成「内存条目未摘除（降级：只删了磁盘）」——
        // 用户每次删旧会话都看到一句吓人的降级提示，反而盖住真正该关注的情况。
        if (v.detached === true) {
          rows.push(h("li", { key: "detached" }, t("done.detached")));
        } else if (v.detach === "absent") {
          rows.push(h("li", { key: "detachedAbsent" }, t("done.detachedAbsent")));
        } else {
          rows.push(h("li", { key: "detachedNo" }, t("done.detachedNo")));
        }
        // 归属被**故意保留**时说明原因：这不是失败，而是为了不让该行变成「未分组」孤儿。
        if (v.keptWorkspaceMembership === true) {
          rows.push(h("li", { key: "keptGroup" }, t("done.keptGroup")));
        }
        // 是否已通知官方侧栏移除该行。
        //
        // 【2026-10-16 · 「删了却还在未分组里」的真修法】
        // Host 删除成功后 emit 已声明的 Remote Event `api-session/removed`，
        // 客户端 `handleSessionRemoved` 据此 `recordMutation({kind:"remove"})`，
        // 侧栏于是真的少一行。实测证实之前缺的就是这一步：持久化数据早已清干净
        // （全盘扫描 sessions / projcache / storages 对该 id 全部零命中）。
        // 通知没发成功时如实说明，不假装已同步。
        if (v.announced === true) {
          rows.push(h("li", { key: "announced" }, t("done.announced")));
        } else if (v.announced === false) {
          rows.push(h("li", { key: "announceOff" }, t("done.announceOff")));
        }
        rows.push(h("li", { key: "ws" }, t("done.workspaces", { count: v.workspaces ?? 0 })));
        rows.push(h("li", { key: "files" }, t("done.files", { count: v.files ?? 0 })));
        if ((v.cacheFiles ?? 0) > 0) {
          rows.push(h("li", { key: "cache" }, t("done.cache", { count: v.cacheFiles })));
        }
        if (v.audit?.ok === false) {
          rows.push(h("li", { key: "audit" }, t("done.auditFailed", { error: v.audit.error ?? "" })));
        } else if (v.audit?.path) {
          rows.push(h("li", { key: "audit" }, t("done.audit", { path: v.audit.path })));
        } else {
          rows.push(h("li", { key: "audit" }, t("done.auditOff")));
        }

        body = h(
          "div",
          { className: "dscc-card" },
          h(Styles, null),
          h("h2", null, t("done.title")),
          h("ul", { className: "dscc-kv" }, rows),
          v.partial === true ? h("p", { className: "dscc-warn" }, t("done.partial")) : null,
          h("p", null, t("done.reloadHint")),
          h(
            "div",
            { className: "dscc-actions" },
            h(
              "button",
              { type: "button", className: "dscc-btn dscc-btn-primary", onClick: () => setDialog(null) },
              t("done.close"),
            ),
          ),
        );
      } else if (state.error !== null) {
        const info = explain(state.error, t);
        body = h(
          "div",
          { className: "dscc-card" },
          h(Styles, null),
          h("h2", null, t("error.title")),
          h("span", { className: "dscc-error-code" }, info.code),
          h("p", null, h("strong", null, `${t("error.label.what")}：`), info.what),
          info.why ? h("p", null, h("strong", null, `${t("error.label.why")}：`), info.why) : null,
          info.hint ? h("p", null, h("strong", null, "hint："), info.hint) : null,
          h("p", null, h("strong", null, `${t("error.label.next")}：`), info.next),
          h(
            "div",
            { className: "dscc-actions" },
            h(
              "button",
              { type: "button", className: "dscc-btn", onClick: () => setDialog(null) },
              t("confirm.cancel"),
            ),
            h(
              "button",
              {
                type: "button",
                className: "dscc-btn dscc-btn-primary",
                onClick: () => setDialog({ ...state, error: null }),
              },
              t("confirm.ok"),
            ),
          ),
        );
      } else {
        // 【H2/M4】这里原来有个 `isBulk && state.total ? t("panel.busy", {done,total}) : …`
        // 的分支，但 `state.total` / `state.done` **从来不会被写入** ——
        // 批量删除是**一次请求**（见 postDelete / requestDeleteMany），宿主端整批处理，
        // 客户端拿不到「已完成几条」的中间进度。所以那个分支永远走不到，
        // 硬凑一个「处理中 0/N…」反而是**假进度**（数字永远不动）。
        // 现在统一用「正在删除」，如实反映「一次请求、等待结果」的真实过程。
        const isBulk = Array.isArray(state.bulkIds) && state.bulkIds.length > 1;
        body = h(
          "div",
          { className: "dscc-card" },
          h(Styles, null),
          h("h2", null, t("confirm.title")),
          h(
            "p",
            null,
            h("span", null, `${t("confirm.body", { title: "" })}`),
            h("span", { className: "dscc-subject" }, state.displayTitle || state.sessionId),
          ),
          // 批量删除是**一次请求**，没有「已完成几条」的中间状态；
          // 因此这里统一显示「正在删除」，不做假进度。
          isBulk ? null : h(
            "p",
            null,
            h("strong", null, `${t("confirm.idLabel")}：`),
            h("span", { className: "dscc-id" }, state.sessionId),
          ),
          h(
            "div",
            { className: "dscc-warn" },
            h("span", { className: "dscc-warn-dot" }),
            h("span", null, t("confirm.warning")),
          ),
          h(
            "div",
            { className: "dscc-actions" },
            h(
              "button",
              { type: "button", className: "dscc-btn", disabled: state.busy === true, onClick: () => setDialog(null) },
              t("confirm.cancel"),
            ),
            h(
              "button",
              { type: "button", className: "dscc-btn dscc-btn-danger", disabled: state.busy === true, onClick: run },
              state.busy === true ? t("action.deleting") : t("confirm.ok"),
            ),
          ),
        );
      }

      // 外层用 div（官方 Modal 同样不是原生 dialog）：层级由 .dscc-modal 的
      // position:fixed + z-index 负责，高于设置面板这类高层级浮层。
      // 卡片自带 role="dialog" + aria-modal，不再让外层重复声明模态语义
      // （屏幕阅读器会读成两层模态）。
      // 内层 .dscc-scrim 继续负责视觉遮罩与指针事件（opt-in）。
      const label =
        state.result !== null && state.result.bulk === true
          ? t("panel.resultTitle")
          : state.result !== null
            ? t("done.title")
            : state.error !== null
              ? t("error.title")
              : t("confirm.title");
      const role = state.error !== null && state.result === null ? "alertdialog" : "dialog";

      return h(
        "div",
        {
          ref: dialogRef,
          className: "dscc-modal",
          "data-dscc": "scrim",
          role,
          "aria-modal": "true",
          "aria-label": label,
          // 遮罩点击**故意不关闭**：这是不可逆的删除确认，误点一次就丢一次确认机会；
          // 关闭路径只有两条 —— 显式的「取消」按钮，或 Esc（由 useModalLayer 处理，
          // 且 busy 时被 allowClose=false 挡住）。
          // （.dscc-scrim 铺满整个浮层，因此指针事件不会逃到背后页面。）
        },
        h("div", { className: "dscc-scrim" }, body),
      );
    }

    /** 客户端会话数据源：走 Host 端点，不直接打宿主 RPC（便于统一过滤与判定）。 */
    const PANEL_API = {
      list: `${BASE}/list`,
    };

    async function fetchList(params) {
      const query = new URLSearchParams();
      if (params.query) query.set("query", params.query);
      if (params.project) query.set("project", params.project);
      if (typeof params.running === "boolean") query.set("running", String(params.running));
      if (params.sort) query.set("sort", params.sort);
      if (params.archived) query.set("archived", params.archived);
      if (params.kind) query.set("kind", params.kind);
      query.set("page", String(params.page ?? 1));
      query.set("pageSize", String(params.pageSize ?? 50));
      try {
        const response = await fetch(`${PANEL_API.list}?${query.toString()}`, { method: "GET" });
        const body = await response.json();
        if (body === null || typeof body !== "object" || typeof body.ok !== "boolean") {
          return { ok: false, error: { code: "badResponse", status: response.status } };
        }
        return body;
      } catch (error) {
        return { ok: false, error: { code: "network", message: String(error?.message ?? error) } };
      }
    }

    /**
     * 一行的状态徽标（只用真实令牌）。
     *
     * 归档行**优先**显示「已归档」：归档是行最重要的身份信息
     * （官方侧栏对归档行同样整格留空、只显示归档标记），
     * 而「可删除/运行中」对归档行是次要信息。
     * 子代理行显示「子代理」—— 官方侧栏**默认隐藏**这些行
     * （`origin: 'subagent'`），所以一旦它们出现在列表里（kind=subagent/all），
     * 必须明确标出身份，避免用户误以为那是普通会话。
     * 注意：**归档 ≠ 不可删除**、**子代理 ≠ 不可删除** —— 两者都只是可见性，
     * 数据仍在磁盘上，所以都照常可勾选删除（删除才是真正的销毁）。
     */
    function StateBadge({ row, t }) {
      if (row.archived === true) {
        return h("span", { className: "dscc-badge dscc-badge-archived" }, t("panel.archivedRow"));
      }
      if (row.subagent === true) {
        return h("span", { className: "dscc-badge dscc-badge-subagent" }, t("panel.subagentRow"));
      }
      if (row.running) {
        return h("span", { className: "dscc-badge dscc-badge-running" }, t("panel.running"));
      }
      if (row.deletable) {
        return h("span", { className: "dscc-badge dscc-badge-ok" }, t("panel.idle"));
      }
      return h("span", { className: "dscc-badge" }, t("panel.blocked"));
    }

    /** 时间戳的人类可读显示（本地化用 toLocaleString，失败回退原串）。 */
    function formatTime(value) {
      if (typeof value !== "string" || value === "") return "—";
      try {
        return new Date(value).toLocaleString();
      } catch {
        return value;
      }
    }

    /**
     * 批量管理面板 —— 注册到 `main`（kind: keyed）+ `sidebar.panellist` 图标入口。
     * 用 `ctx.layout.selectPanel(id)` 打开，与 dsh-context 同一范式。
     *
     * 它**不碰 DOM**、不读宿主 DOM，只走自己的 Host 端点；样式只用主题令牌。
     */
    function DialogueCleanupPanel(props) {
      useLocaleTick();
      // 与菜单项、弹窗统一：优先用 slot 注入的 `t` 席位（官方权威路径），
      // 其次 ctx.locale.bind(ns)，最后才内置表。此前这里只读 tt()，等于绕过了
      // 框架注入的翻译席位 —— 见 makeTranslator 的优先级说明。
      const t = makeTranslator(props?.t);
      // 设置页里的内容列自己会滚动，面板不再撑满视口高度。
      const inSection = props?.variant === "section";

      const [params, setParams] = React.useState({
        query: "",
        project: "",
        running: "",
        // 归档三选一（照官方语义）：default 隐藏已归档 / show 全部对话 / only 仅显示已归档。
        //
        // 【默认值 · 按用户要求刻意偏离官方】官方侧栏默认 `default`（隐藏已归档）；
        // 本插件面板**默认 `show`（显示已归档）**。原因：这是一个「清理」工具，
        // 隐藏已归档会让用户看不到本该能删掉的会话（归档 ≠ 删除，仍占磁盘），
        // 用户明确要求「归档那一栏默认显示已归档」。
        // 归档行仍带 `已归档` 徽标，与普通会话可区分，不会误删。
        archived: "show",
        // 会话类型三选一：main（默认，照官方隐藏子代理）/ subagent / all。
        kind: "main",
        sort: "activity",
        page: 1,
        pageSize: 50,
      });
      const [state, setState] = React.useState({ status: "loading", value: null, error: null });
      const [selected, setSelected] = React.useState({});
      // 【实测修复 · H2/M4】这里原有一对 `busy` / `result` state。
      // 它们只被已删除的 `doDelete`（内联批量删除的旧实现）写入 ——
      // 而面板真正走的是「删除所选 → 打开确认弹窗 → DeleteDialog.run()」这条路径，
      // 进度与结果都记在弹窗自己的 state 里。于是 `busy` 恒为 null、
      // `result` 恒为 null：所有 `busy !== null` 的禁用条件、进度文字、
      // 结果条全都不可能触发。一并删掉，避免「看着是活的」的假象。
      const [reloadTick, setReloadTick] = React.useState(0);
      // 行菜单 / 批量弹窗删完后会推一个模块级信号；面板据此自动刷新。
      const externalReload = useReloadSignal();
      React.useEffect(() => {
        if (externalReload > 0) setReloadTick((n) => n + 1);
      }, [externalReload]);

      // 防抖后的查询词：输入框用本地 state，请求用防抖值，避免每敲一个字打一次端点。
      const [queryInput, setQueryInput] = React.useState("");
      React.useEffect(() => {
        const timer = setTimeout(() => {
          setParams((prev) => (prev.query === queryInput ? prev : { ...prev, query: queryInput, page: 1 }));
        }, 300);
        return () => clearTimeout(timer);
      }, [queryInput]);

      React.useEffect(() => {
        let cancelled = false;
        setState((prev) => ({ ...prev, status: "loading", error: null }));
        const request = {
          query: params.query,
          project: params.project,
          archived: params.archived,
          kind: params.kind,
          sort: params.sort,
          page: params.page,
          pageSize: params.pageSize,
        };
        if (params.running === "running") request.running = true;
        else if (params.running === "idle") request.running = false;

        fetchList(request).then((body) => {
          if (cancelled) return;
          if (body.ok === true) setState({ status: "ready", value: body.value, error: null });
          else setState({ status: "error", value: null, error: body.error ?? { code: "internal" } });
        });
        return () => {
          cancelled = true;
        };
      }, [params, reloadTick]);

      const value = state.value;
      const items = Array.isArray(value?.items) ? value.items : [];
      const selectedIds = Object.keys(selected).filter((id) => selected[id] === true);
      const deletableOnPage = items.filter((row) => row.deletable === true);

      /**
       * 【安全修正】选中项只在**当前可见页**内有效，且必须**当前可删除**。
       *
       * 旧行为：`selected` 是跨页/跨筛选累积的。用户在「可删除」筛选下勾 20 行 →
       * 改成「运行中」筛选（或不带筛选翻页）→ 表格里已经看不到那些行了，
       * 但工具条仍显示「已选 20 个 / 删除所选（20）」，点下去就把**看不见的会话**删了。
       * 对一个不可逆操作来说，这是不能接受的：用户无法复核自己正在删什么。
       *
       * 【实测修复 · M3】这里原来只查了 `visibleIds`，**没有**查 `deletable` ——
       * 与上一段注释「且当前可删除」的承诺不符（注释说了，代码没做）。
       * 后果：某行勾选时是空闲的，之后它开始运行（宿主 `running=true`），
       * 刷新后该行仍在当前页、勾选仍有效，于是被提交进批量删除，
       * 宿主逐条返回 `refused` —— 用户看到一个费解的「部分失败」。
       *
       * 现在按注释兑现：`deletableIds` 只收当前页**且 Host 判定可删除**的行。
       * 运行中的行会自动从选中集里掉出去，不会进入请求。
       */
      const visibleIds = new Set(items.map((row) => row.sessionId));
      const visibleKey = items.map((row) => row.sessionId).join("|");
      const deletableIdSet = new Set(deletableOnPage.map((row) => row.sessionId));
      // 可删除集合的指纹：用于让清理 effect 在「运行状态变了但可见 id 没变」时也重跑。
      const deletableKey = deletableOnPage.map((row) => row.sessionId).join("|");
      const effectiveSelectedIds = selectedIds.filter(
        (id) => visibleIds.has(id) && deletableIdSet.has(id),
      );
      const hiddenSelectedCount = selectedIds.length - effectiveSelectedIds.length;

      React.useEffect(() => {
        // 视图变化后把不再可见/不可删除的勾选真正清掉，保证 UI 计数与可删集合一致。
        // 【M3 配套】这里也必须查 deletable —— 否则 `effectiveSelectedIds` 已经把它排除了
        // （计数正确），但 `selected` 里仍留着该行；一旦它重新变为可删除，
        // 勾选会「自己复活」，与「视图一变勾选即失效」的承诺不符。
        setSelected((prev) => {
          let changed = false;
          const next = {};
          for (const [id, on] of Object.entries(prev)) {
            if (on !== true) continue;
            if (visibleIds.has(id) && deletableIdSet.has(id)) next[id] = true;
            else changed = true;
          }
          return changed ? next : prev;
        });
        // 依赖里带上「可删除集合」的指纹：会话的运行状态变化会刷新列表，
        // 此时即便可见 id 未变，可删除集合也可能变了，必须重跑清理。
      }, [visibleKey, deletableKey]);

      // ── 筛选区（等宽网格）──
      // 用 CSS Grid 定列（标签列定宽 + 控件列定宽），所有行标签右对齐、下拉等宽 —— 天然整齐。
      // 标签与控件是**两个网格项**（不能塞进同一个普通 <label>，那样整个 label 只占一格，
      // 网格就退化成一格一个控件，对齐失效）。
      // 解法：`<label>` 用 `display: contents` —— 它自身不生成盒子，
      // 其子节点（标签 span + select）**直接成为网格项**，于是既有对齐、又保留
      // 「点标签聚焦控件」的原生语义，且**不需要重建元素**（重建容易丢 children）。
      const field = (labelKey, select) =>
        h("label", { className: "dscc-field" }, h("span", { className: "dscc-field-label" }, t(labelKey)), select);

      const toolbar = h(
        "div",
        { className: "dscc-filters" },
        // 第 1 行：搜索 + 刷新
        h(
          "div",
          { className: "dscc-filters-row" },
          h("input", {
            className: "dscc-input dscc-filters-search",
            type: "search",
            value: queryInput,
            placeholder: t("panel.search"),
            "aria-label": t("panel.searchLabel"),
            onChange: (event) => setQueryInput(event.target.value),
          }),
          h(
            "button",
            {
              type: "button",
              className: "dscc-btn",
              disabled: state.status === "loading",
              onClick: () => setReloadTick((n) => n + 1),
            },
            state.status === "loading" ? t("panel.refreshing") : t("panel.refresh"),
          ),
        ),
        // 第 2 行起：2×2 等宽筛选网格
        h(
          "div",
          { className: "dscc-filters-grid" },
          field(
            "panel.project",
            h(
              "select",
              {
                className: "dscc-select",
                value: params.project,
                onChange: (event) => setParams((prev) => ({ ...prev, project: event.target.value, page: 1 })),
              },
              h("option", { value: "" }, t("panel.projectAll")),
              ...(Array.isArray(value?.projects) ? value.projects : []).map((project) =>
                h("option", { key: project, value: project }, project),
              ),
            ),
          ),
          field(
            "panel.state",
            h(
              "select",
              {
                className: "dscc-select",
                value: params.running,
                onChange: (event) => setParams((prev) => ({ ...prev, running: event.target.value, page: 1 })),
              },
              h("option", { value: "" }, t("panel.stateAll")),
              h("option", { value: "idle" }, t("panel.stateIdle")),
              h("option", { value: "running" }, t("panel.stateRunning")),
            ),
          ),
          // 会话类型：官方侧栏默认隐藏子代理行；这里给显式三选一，
          // 让用户既能看主会话（默认，与侧栏一致），也能专门清理子代理会话。
          field(
            "panel.kind",
            h(
              "select",
              {
                className: "dscc-select",
                value: params.kind,
                title: t("panel.kindHint"),
                onChange: (event) => setParams((prev) => ({ ...prev, kind: event.target.value, page: 1 })),
              },
              h("option", { value: "main" }, t("panel.kindMain")),
              h("option", { value: "subagent" }, t("panel.kindSubagent")),
              h("option", { value: "all" }, t("panel.kindAll")),
            ),
          ),
          // 归档三选一，文案照官方侧栏视图选项。
          field(
            "panel.archived",
            h(
              "select",
              {
                className: "dscc-select",
                value: params.archived,
                title: t("panel.archivedHint"),
                onChange: (event) => setParams((prev) => ({ ...prev, archived: event.target.value, page: 1 })),
              },
              h("option", { value: "default" }, t("panel.archivedHide")),
              h("option", { value: "show" }, t("panel.archivedShow")),
              h("option", { value: "only" }, t("panel.archivedOnly")),
            ),
          ),
          field(
            "panel.sort",
            h(
              "select",
              {
                className: "dscc-select",
                value: params.sort,
                onChange: (event) => setParams((prev) => ({ ...prev, sort: event.target.value, page: 1 })),
              },
              h("option", { value: "activity" }, t("panel.sortActivity")),
              h("option", { value: "created" }, t("panel.sortCreated")),
            ),
          ),
        ),
      );

      // ── 批量操作条 ──
      const bulk = h(
        "div",
        { className: "dscc-panel-bulk" },
        h(
          "button",
          {
            type: "button",
            className: "dscc-btn",
            disabled: deletableOnPage.length === 0,
            title: t("panel.selectAllHint"),
            onClick: () => {
              const next = { ...selected };
              const allSelected = deletableOnPage.every((row) => next[row.sessionId] === true);
              for (const row of deletableOnPage) {
                if (allSelected) delete next[row.sessionId];
                else next[row.sessionId] = true;
              }
              setSelected(next);
            },
          },
          t("panel.selectPage"),
        ),
        effectiveSelectedIds.length > 0
          ? h("span", { className: "dscc-panel-count" }, t("panel.selected", { count: effectiveSelectedIds.length }))
          : null,
        hiddenSelectedCount > 0
          ? h("span", { className: "dscc-panel-hidden" }, t("panel.hiddenSelection", { count: hiddenSelectedCount }))
          : null,
        effectiveSelectedIds.length > 0
          ? h(
              "button",
              { type: "button", className: "dscc-btn", onClick: () => setSelected({}) },
              t("panel.clearSelection"),
            )
          : null,
        effectiveSelectedIds.length > 0
          ? h(
              "button",
              {
                type: "button",
                className: "dscc-btn dscc-btn-danger",
                onClick: () => setDialog({
                  sessionId: effectiveSelectedIds.join("、"),
                  displayTitle: t("panel.selected", { count: effectiveSelectedIds.length }),
                  busy: false,
                  result: null,
                  error: null,
                  bulkIds: effectiveSelectedIds,
                }),
              },
              t("panel.deleteSelected", { count: effectiveSelectedIds.length }),            )
          : null,
      );

      // 【H2/M4 已删除「结果条」】面板级 `result` 从来不会被写入（只由已删除的
      // `doDelete` 写），所以这条结果条永远渲染 null。批量结果现在由确认弹窗
      // 自己展示（DeleteDialog 的 state.result / bulk 分支）。
      // 相关的 CSS 与文案键一并保留在字典里，避免其它入口引用时缺键。

      // ── 表格 ──
      let tableBody;
      if (state.status === "loading" && value === null) {
        tableBody = h("div", { className: "dscc-panel-state" }, t("panel.loading"));
      } else if (state.status === "error") {
        const info = explain(state.error, t);
        tableBody = h(
          "div",
          { className: "dscc-panel-state", role: "alert" },
          h("p", null, h("strong", null, `${t("error.label.what")}：`), info.what),
          h("p", null, h("strong", null, `${t("error.label.why")}：`), info.why),
          h("p", null, h("strong", null, `${t("error.label.next")}：`), info.next),
        );
      } else if (items.length === 0) {
        // 「仅显示已归档」空结果有专属文案（照官方：empty.noneArchived + 一键切回）。
        const archivedOnly = params.archived === "only";
        tableBody = h(
          "div",
          { className: "dscc-panel-state" },
          h("p", null, h("strong", null, archivedOnly ? t("panel.archivedEmpty") : t("panel.empty"))),
          archivedOnly
            ? h(
                "button",
                {
                  type: "button",
                  className: "dscc-btn",
                  // 从「仅显示已归档」退回**默认视图**。默认值是 show（显示已归档），
                  // 所以这里必须回 show 而不是 default —— 否则点一下会把用户
                  // 丢进「隐藏已归档」，与面板默认状态不一致，看着像跳错页。
                  onClick: () => setParams((prev) => ({ ...prev, archived: "show", page: 1 })),
                },
                t("panel.archivedShow"),
              )
            : h("p", null, t("panel.emptyBody")),
        );
      } else {
        // 卡片式列表（照原项目 sessdel-list / sessdel-row 的做法）：
        // 每行是一张 flex 卡片，左「标题 + 元信息」右「徽标 + 操作」，
        // 各行内部独立，窄屏也不会像表格那样整体错位。
        tableBody = h(
          "div",
          { className: "dscc-listwrap" },
          ...items.map((row) =>
            h(
              "div",
              {
                key: row.sessionId,
                className: row.deletable ? "dscc-row" : "dscc-row dscc-row-blocked",
              },
              h("input", {
                type: "checkbox",
                className: "dscc-row-check",
                checked: selected[row.sessionId] === true,
                disabled: !row.deletable,
                "aria-label": `${t("panel.deleteOne")} ${row.title || row.sessionId}`,
                onChange: (event) => {
                  const next = { ...selected };
                  if (event.target.checked) next[row.sessionId] = true;
                  else delete next[row.sessionId];
                  setSelected(next);
                },
              }),
              // 左：标题 + 一行元信息（id · 项目 · 时间），全部单行省略
              h(
                "div",
                { className: "dscc-row-main" },
                h(
                  "div",
                  { className: "dscc-row-title", title: row.title || t("panel.noTitle") },
                  row.title || t("panel.noTitle"),
                ),
                h(
                  "div",
                  {
                    className: "dscc-row-meta",
                    title: `${row.sessionId} · ${row.project ?? "—"} · ${formatTime(row.updatedAt ?? row.createdAt)}`,
                  },
                  h("code", null, row.sessionId),
                  h("span", { className: "dscc-row-sep" }, "·"),
                  row.project ?? "—",
                  h("span", { className: "dscc-row-sep" }, "·"),
                  formatTime(row.updatedAt ?? row.createdAt),
                ),
              ),
              // 右：徽标（定宽，保证各行对齐）+ 操作
              h(
                "div",
                { className: "dscc-row-side" },
                h("span", { className: "dscc-row-badge" }, h(StateBadge, { row, t })),
                h(
                  "button",
                  {
                    type: "button",
                    className: "dscc-btn dscc-btn-small dscc-row-actions",
                    disabled: !row.deletable,
                    // 【可访问性】每行的删除按钮必须能读出「删哪一个」，
                    // 否则一屏里全是同名的「删除」，屏幕阅读器无法区分。
                    "aria-label": `${t("panel.deleteOne")} ${row.title || row.sessionId}`,
                    title: row.blockedReason ?? "",
                    onClick: () =>
                      setDialog({
                        sessionId: row.sessionId,
                        displayTitle: row.title,
                        busy: false,
                        result: null,
                        error: null,
                      }),
                  },
                  t("panel.deleteOne"),
                ),
              ),
            ),
          ),
        );
      }

      // ── 分页 ──
      const pageInfo = value?.page ?? { page: 1, pageSize: 50, pages: 1 };
      // 取标题的成本明细（Host 实测回传）：让「为什么这次快」可见，而不是只看到转圈。
      const titleStat = value?.titles ?? null;
      const costText =
        value === null
          ? null
          : titleStat?.skipped === true
            ? t("panel.costSkipped", { ms: value.tookMs ?? 0 })
            : titleStat !== null
              ? t("panel.cost", {
                  ms: value.tookMs ?? 0,
                  cached: titleStat.cached ?? 0,
                  fetched: titleStat.fetched ?? 0,
                })
              : null;
      const pager =
        value !== null && pageInfo.pages > 1
          ? h(
              "div",
              { className: "dscc-panel-pager" },
              h(
                "button",
                {
                  type: "button",
                  className: "dscc-btn",
                  disabled: pageInfo.page <= 1 || state.status === "loading",
                  onClick: () => setParams((prev) => ({ ...prev, page: pageInfo.page - 1 })),
                },
                t("panel.prev"),
              ),
              h("span", null, t("panel.summary", { total: value.total, page: pageInfo.page, pages: pageInfo.pages })),
              costText !== null ? h("span", { className: "dscc-panel-cost" }, costText) : null,
              h(
                "button",
                {
                  type: "button",
                  className: "dscc-btn",
                  disabled: pageInfo.page >= pageInfo.pages || state.status === "loading",
                  onClick: () => setParams((prev) => ({ ...prev, page: pageInfo.page + 1 })),
                },
                t("panel.next"),
              ),
            )
          : value !== null
            ? h(
                "div",
                { className: "dscc-panel-pager" },
                h("span", null, t("panel.summary", { total: value.total, page: pageInfo.page, pages: pageInfo.pages })),
                costText !== null ? h("span", { className: "dscc-panel-cost" }, costText) : null,
              )
            : null;

      return h(
        "div",
        { className: inSection ? "dscc-panel dscc-panel-section" : "dscc-panel" },
        h(Styles, null),
        h(
          "header",
          { className: "dscc-panel-head" },
          h("h1", null, t("panel.title")),
          h("p", null, t("panel.subtitle")),
        ),
        toolbar,
        bulk,
        tableBody,
        pager,
      );
    }

    /**
     * 设置页里的这个 section。
     *
     * ownerProps（**实测**，`Slots.listSubTree('settings.section')`）：只有 `{ close }`。
     * standardProps 列出的是 `useResource` / `useWorkspaces` / `usePanelInfo` /
     * `useSessions` / `useSessionStatus` / `useSessionRetainInfo` —— **没有 `t` 席位**。
     *
     * 所以这里如实转发 `props` 给面板：若将来框架给该 slot 注入 `t`，面板会自动用上；
     * 现在则会走 `ctx.locale.bind(ns)`，同样是官方 LocaleFace 驱动的本地化。
     * 「不依赖 layout 服务」依旧成立 —— 少一个可选依赖、少一处降级分支。
     */
    function DialogueCleanupSection(props) {
      // 设置页的内容列本身就是滚动容器，所以面板用自适应高度模式。
      return h(
        "div",
        { className: "dscc-section" },
        // 转发 ownerProps 与任何注入席位（目前只有 close；t 缺席时由 makeTranslator 降级）
        h(DialogueCleanupPanel, { ...props, variant: "section" }),
      );
    }

    const inject = ["slots", "locale"];
    /**
     * 语言跟随**宿主/插件本体**（而不是浏览器）。
     *
     * 三件事，都用现场核实的 `locale` 契约：
     *   1. `active` 是活动语言的唯一正确字段（见 `readActiveLocale` 的说明）；
     *   2. `subscribe()` 在**语言切换**与**字典后到**时都会触发 —— 后者很重要：
     *      语言包与 locale 定义可能比我们的注册更晚到位，靠它才能补上；
     *   3. `bind(ns)` 返回的翻译函数**在调用时**读活动语言，自带 fallback 链，
     *      比我们自己的兜底表更权威 —— 优先用它，兜底表只在 bind 不可用时接管。
     */
    function registerDictionaries(ctx) {
      const disposers = [];
      const locale = ctx.locale ?? (typeof ctx.get === "function" ? ctx.get("locale") : undefined);
      if (locale === undefined || locale === null) {
        ctx.logger?.warn?.("dialogue-cleanup: locale service missing; using built-in strings");
        // 连 locale 服务都没有：只能按浏览器语言兜底，并如实说明这是降级路径。
        ACTIVE_LOCALE = normalizeLocale(
          typeof navigator !== "undefined" ? navigator.language : undefined,
        );
        return () => {};
      }

      const attempt = (fn) => {
        try {
          const dispose = fn();
          if (typeof dispose === "function") disposers.push(dispose);
          return true;
        } catch {
          return false;
        }
      };

      let any = false;
      if (typeof locale.register === "function") {
        for (const id of ["zh", "en"]) {
          any = attempt(() => locale.register(NS, id, STRINGS[id])) || any;
        }
        if (!any) {
          any = attempt(() => locale.register(NS, { zh: STRINGS.zh, en: STRINGS.en }));
        }
      }
      if (!any) ctx.logger?.warn?.("dialogue-cleanup: locale.register failed; using built-in strings");

      // 优先用服务自己的 bind()：它按调用时求值，并且走宿主的 fallback 链。
      if (typeof locale.bind === "function") {
        try {
          const bound = locale.bind(NS);
          if (typeof bound === "function") boundTranslate = bound;
        } catch {
          /* bind 不可用就继续用兜底表 */
        }
      }

      /** 把「当前活动语言」同步到模块级状态；变了才通知订阅者重渲染。 */
      const syncActive = () => {
        const id = readActiveLocale(locale);
        if (id === null) return false; // 不可知 —— 保持现状，不瞎猜
        const next = normalizeLocale(id);
        if (next === ACTIVE_LOCALE) return false;
        ACTIVE_LOCALE = next;
        return true;
      };

      // 初次读取：**先读宿主的 active**，读不到才退到浏览器语言。
      const initial = readActiveLocale(locale);
      if (initial !== null) ACTIVE_LOCALE = normalizeLocale(initial);
      else {
        ACTIVE_LOCALE = normalizeLocale(
          typeof navigator !== "undefined" ? navigator.language : undefined,
        );
      }

      let unsubscribe = null;
      if (typeof locale.subscribe === "function") {
        try {
          unsubscribe = locale.subscribe(() => {
            // 语言切换与字典后到都会走到这里；只有活动语言真的变了才重渲染。
            if (syncActive()) publish();
          });
        } catch {
          /* 订阅失败不是致命问题：仍按首次读取的语言渲染 */
        }
      }

      return () => {
        if (typeof unsubscribe === "function") {
          try {
            unsubscribe();
          } catch {
            /* 忽略 */
          }
        }
        boundTranslate = null;
        for (const dispose of disposers) {
          try {
            dispose();
          } catch {
            /* 忽略 */
          }
        }
      };
    }

    function apply(ctx) {
      ctx.effect(() => registerDictionaries(ctx), "dialogue-cleanup: locale");

      ctx.effect(
        () =>
          ctx.slots.inject(MENU_SLOT, () =>
            ctx.slots.register({ name: MENU_SLOT, id: "dialogue-cleanup.delete", order: 500 }, DeleteSessionMenuItem),
          ),
        "dialogue-cleanup: session menu item",
      );

      ctx.effect(
        () =>
          ctx.slots.inject(OVERLAY_SLOT, () =>
            ctx.slots.register({ name: OVERLAY_SLOT, id: "dialogue-cleanup.confirm", order: 500 }, DeleteDialog),
          ),
        "dialogue-cleanup: confirm overlay",
      );

      // ── 管理面板：挂在**设置页**（方案 B） ──
      // settings.section 是一个 list slot：一个注册项 = 设置导航里的一页，
      // 内容渲染在设置面板的内容列里。label 用 thunk 以跟随语言切换。
      // 这样不依赖 layout 服务，也不需要往 main / sidebar 抢位置。
      ctx.effect(
        () =>
          ctx.slots.inject(SETTINGS_SECTION_SLOT, () =>
            ctx.slots.register(
              {
                name: SETTINGS_SECTION_SLOT,
                id: SECTION_ID,
                order: 25,
                label: () => tt("panel.title"),
              },
              DialogueCleanupSection,
            ),
          ),
        "dialogue-cleanup: settings section",
      );
    }

    return { apply, inject };
  },
});