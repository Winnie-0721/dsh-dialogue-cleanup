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
        "panel.costTruncated": " · 另有 {n} 行标题未读（搜索与显示可能不完整）",
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
        "panel.costTruncated": " · {n} rows without titles (search and display may be incomplete)",
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
/* ═══════════════════════════════════════════════════════════════════════
   官方形态样式表 —— 每一条几何/颜色都注有官方出处。

   【为什么是"抄"而不是"调包"】R-23 禁止把官方包当模块 require，
   同一条规则紧接着给的正路是：copy markup, CSS, and behavior from the
   primitive into the plugin … rename copied classes under your plugin's
   prefix, keep only --dsw-alias-* token references, and keep the behavior
   users rely on. 类名一律加 dscc- 前缀。

   【令牌表 · 已实测更正】上一轮我以为 --dsw-radius-* /
   --dsw-alias-interactive-bg-* / --dsw-alias-button-* 这些名字"不在
   Theme.listTokens 的 14 条里所以不能用"，于是把圆角和悬停底色换算成了
   字面值 —— **那个判断是错的，也正是这一版界面看起来仍不统一的根因**。
   实测：这些令牌全部真实存在，由 @deepseek-ai/dsh-client-ui-theme 在
   运行时注入（inspect 的 14 条只是子集）。逐个核对结果：
     · 颜色类令牌 defs=2 ⇒ 明暗两套主题各定义一次，可安全使用；
     · 几何类令牌 defs=1 ⇒ 全局单值（--dsw-radius-xs=4px / sm=8px /
       md=12px / lg=16px / xl=20px / panel=28px），两主题共用。
   确认真不存在的只有 --dsw-transition-duration / --dsw-ease-in-out
   （官方 CSS 里引用了它们，但主题包没定义 —— 那是官方的悬空引用，
   所以这里的动画时长一律写字面值 .2s / cubic-bezier(.4,0,.2,1)）。

   【本插件的四条实测修复，换皮不得弄丢】
     1. 按钮文字 nowrap —— 否则「刷新」被压成「刷/新」两行；
     2. 悬停换底只作用于中性按钮 —— 否则实心按钮悬停即"文字消失"（对比度≈0）；
     3. 主内容列 min-width:0 —— 否则标题省略号不生效；
     4. 卡片行内不得 break-all —— 否则中文标题逐字符折断。

   ⚠ 本注释及下面所有注释内都不得出现反引号 —— CSS 在 JS 模板串里，
     一个反引号就提前终止模板串（已因此踩坑多次）。
   ═══════════════════════════════════════════════════════════════════════ */

/* ───────────── 会话行 ⋮ 菜单项 ─────────────
   官方出处：primitives Menu.module.css 的 .item（菜单里的标准一行）。
   min-height 34px / padding 6px 8px / radius md / 13px-20px。
   官方把「悬停换底」与「键盘聚焦换底」做成同一底色且聚焦时去掉默认描边
   （fill 本身就是聚焦指示），这里照抄。 */
.dscc-menu-row {
  display: flex; align-items: center; gap: 6px;
  width: 100%; box-sizing: border-box;
  min-height: 34px; padding: 6px 8px; margin: 0; border: 0;
  border-radius: var(--dsw-radius-md); background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 13px; line-height: 20px;
  text-align: left; cursor: pointer;
}
.dscc-menu-row:hover:not(:disabled),
.dscc-menu-row:focus-visible:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dscc-menu-row:focus-visible { outline: none; }
.dscc-menu-row:disabled { opacity: 0.4; cursor: not-allowed; }
/* 官方 .itemIcon：14px，颜色走 menu-icon 令牌。 */
.dscc-menu-row-icon {
  display: inline-flex; flex: none;
  width: 14px; height: 14px; align-items: center; justify-content: center;
  color: var(--dsw-alias-menu-icon);
}
/* 官方 .separator：0.5px 高、上下 3px、用 l2（l1 在这张面上几乎看不见）。 */
.dscc-sep { height: 0.5px; margin: 3px 2px; background: var(--dsw-alias-border-l2); border: 0; }

/* ───────────── 按钮：官方 Button.module.css ─────────────
   md = 36px 高 / radius-md / padding 0 14px / 14px-22px；
   sm = 28px 高 / radius-sm / padding 0 10px / 12px-18px。
   primary 底色 button-primary-fill、文字 label-primary-foreground、
   悬停 button-primary-hover —— 全部是官方原值。 */
.dscc-btn {
  box-sizing: border-box;
  display: inline-flex; align-items: center; justify-content: center; gap: 4px;
  height: 36px; padding: 0 14px;
  border: none; border-radius: var(--dsw-radius-md);
  cursor: pointer;
  font: inherit; font-size: 14px; line-height: 22px;
  color: var(--dsw-alias-label-primary);
  background: transparent;
  /* 【实测修复 1】中文可在任意字符处断行，按钮被 flex 压到 min-content
     （= 一个字宽）时文字会竖排。官方没写这条是因为它不放中文，我们必须留。 */
  white-space: nowrap;
}
.dscc-btn:disabled { cursor: not-allowed; opacity: 0.4; }
/* 【实测修复 2】换底只作用于中性按钮。旧版裸 :hover 换底（优先级 0,2,0）
   压过实心变体的背景（0,1,0），文字色却仍是变体的前景色 ⇒ 对比度≈0，
   鼠标一移上去文字就"消失"。实心变体改用官方 primary 的做法：换底色。 */
.dscc-btn:not(.dscc-btn-primary):not(.dscc-btn-danger):not(:disabled):hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dscc-btn:not(.dscc-btn-primary):not(.dscc-btn-danger):not(:disabled):active {
  background: var(--dsw-alias-interactive-bg-active);
}
.dscc-btn:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 1px;
}
.dscc-btn-primary {
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground);
}
.dscc-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
/* 破坏性主操作：官方 Button 没有 danger 实心档，沿用本插件既有的 error 实心底，
   前景色与 primary 同一令牌（官方"状态色配同一前景"的做法）。
   悬停仍走亮度微调 —— 这里没有官方 hover 令牌可抄，换底会重现修复 2 那个 bug。 */
.dscc-btn-danger {
  background: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-label-primary-foreground);
}
.dscc-btn-danger:hover:not(:disabled) { filter: brightness(1.12); }
/* 官方 sm 刻度：行内操作（每行的「删除」）用它，避免 36px 按钮挤满列表。 */
.dscc-btn-small { height: 28px; font-size: 12px; line-height: 18px; padding: 0 10px; border-radius: var(--dsw-radius-sm); }


/* ───────────── 徽标：官方 Tag.module.css ─────────────
   999px 全圆角 / 1px 8px / 11px-17px / 字重 500 / nowrap。
   状态 tone 的官方做法：用**同一个状态令牌**做 10% 自着色底 + 同色文字
   （warning 是 12%，官方注释说明那是照插件清单页既有值统一来的），
   一次换色底与字一起动，不需要第二个令牌。 */
.dscc-badge {
  display: inline-flex; align-items: center;
  border-radius: 999px; corner-shape: round;
  padding: 1px 8px;
  font-size: 11px; line-height: 17px; font-weight: 500;
  white-space: nowrap;
  color: var(--dsw-alias-label-tertiary);
}
/* outline = 官方默认档：0.5px 细边 + 三级文字色。 */
.dscc-badge-outline { border: 0.5px solid var(--dsw-alias-border-l4); }
.dscc-badge-ok {
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent);
  color: var(--dsw-alias-state-success-primary);
}
.dscc-badge-running {
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent);
  color: var(--dsw-alias-state-warn-primary);
}
.dscc-badge-archived {
  background: color-mix(in srgb, var(--dsw-alias-state-idle-primary) 10%, transparent);
  color: var(--dsw-alias-state-idle-primary);
}
.dscc-badge-subagent {
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent);
  color: var(--dsw-alias-state-warn-primary);
}

/* ───────────── 筛选条：官方「选择器药丸 + 内联 Menu」 ─────────────
   【这一组是本次统一的关键】上一版留了五个原生 select —— 原生下拉是
   操作系统绘制的直角控件，与官方主题完全两个世界，这正是"不统一"的来源。

   官方在**同一个设置页**里怎么做一个下拉？看 dsh-client-locale 的语言行
   （LanguageRow.module.css）：不是 select，而是一个 button 药丸
   （radius-md / bg-module-platform / 36px 高 / gap 12px / 14px-22px）
   挂 aria-haspopup=menu，点开 primitives 的 Menu。这里整套照抄。
   Menu 用官方默认的非 portal 形态（position:absolute 贴在触发器下方），
   因此不需要往 document.body 挂东西 —— R-22 也守住了。 */
.dscc-select-root { position: relative; display: inline-flex; min-width: 0; }
.dscc-selector {
  box-sizing: border-box;
  display: inline-flex; align-items: center; gap: 12px;
  width: 100%; height: 36px; padding: 0 14px;
  border: none; border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 14px; line-height: 22px; cursor: pointer;
}
.dscc-selector:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dscc-selector:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: -2px;
}
/* 当前值：可收缩 + 省略号（项目路径可能很长）。 */
.dscc-selector-label {
  flex: 1 1 auto; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left;
}
.dscc-selector-chevron { display: inline-flex; flex: none; width: 14px; height: 14px; }

/* 官方 Menu.module.css 的 .list：radius-lg、4px 内边距、prominent 描边阴影，
   贴在触发器下方 4px。底色用 menu-surface-fill（官方半透明面）。 */
.dscc-menu {
  box-sizing: border-box;
  position: absolute; top: calc(100% + 4px); left: 0; z-index: 100;
  display: flex; flex-direction: column; gap: 0;
  width: max-content; min-width: 144px; max-width: 360px;
  padding: 4px; border: 0;
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-menu-surface-fill);
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
  box-shadow: var(--dsw-elevation-prominent);
  /* 项目可能很多：官方 .scrollable 用视口高度封顶 + 内部滚动。 */
  max-height: calc(100vh - 12px - max(12px, var(--dsh-frame-overlay-top, 12px)));
  overflow-y: auto;
  overscroll-behavior: contain;
}
/* 官方 .item：min-height 34px / padding 6px 8px / radius-md / 13px-20px；
   悬停与键盘聚焦共用同一底色且去掉默认描边（底色就是聚焦指示）。 */
.dscc-menu-item {
  display: flex; align-items: center; gap: 6px;
  width: 100%; box-sizing: border-box;
  min-height: 34px; padding: 6px 8px;
  border: none; border-radius: var(--dsw-radius-md);
  background: transparent; cursor: pointer;
  font: inherit; font-size: 13px; line-height: 20px;
  color: var(--dsw-alias-label-primary); text-align: left;
}
.dscc-menu-item:hover:not(:disabled),
.dscc-menu-item:focus-visible:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dscc-menu-item:focus-visible { outline: none; }
/* 官方 .itemLabel：占满、单行省略。 */
.dscc-menu-item-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 官方 .check：14px，选中行尾部一枚勾；未选中行留同宽空位保证文字对齐。 */
.dscc-menu-item-check {
  display: inline-flex; flex: none; width: 14px; height: 14px;
  align-items: center; justify-content: center;
  color: var(--dsw-alias-label-primary);
}
.dscc-menu-item-check[data-hidden="true"] { visibility: hidden; }

/* ───────────── 搜索框：官方 Input.module.css ─────────────
   官方是 wrap（32px 高 / 0.5px l4 描边 / radius-md / bg-layer-1 / 前置图标）
   包一个无边框透明 input。插件清单页的搜索框同族，只是 36px 高、
   图标绝对定位在左 12px —— 这里取清单页那版（与本面板同为设置页）。 */
.dscc-search { position: relative; display: flex; width: 100%; min-width: 0; align-items: center; color: var(--dsw-alias-label-tertiary); }
.dscc-search-icon { pointer-events: none; position: absolute; left: 12px; display: inline-flex; width: 16px; height: 16px; align-items: center; justify-content: center; }
.dscc-input {
  box-sizing: border-box; width: 100%; min-width: 0; height: 36px;
  padding: 0 34px 0 36px;
  border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; line-height: 22px;
  outline: none;
}
.dscc-input::placeholder { color: var(--dsw-alias-label-tertiary); }
/* 官方聚焦做法：描边换成聚焦色 + 一圈 18% 透明度的同色光晕（不是 outline）。 */
.dscc-input:focus-visible {
  border-color: var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)) 18%, transparent);
}
/* type=search 的原生清除按钮在 Chromium 里是系统绘制的灰色圆叉，
   与主题无关 —— 官方也没用它，这里关掉，清空走键盘/全选。 */
.dscc-input::-webkit-search-cancel-button { appearance: none; }

/* ───────────── 卡片：官方「设置页卡片」做法 ─────────────
   【上一版为什么看着不统一 · 已实测定位】浅色主题下
   --dsw-alias-bg-base / bg-layer-1 / bg-layer-2 **三个值完全相同**
   （都是 neutral-bluish-00）。我上一版把卡面从 layer-1 换成 layer-2，
   在浅色主题里**等于什么都没换** —— 卡片与页面一个颜色，只剩一圈描边，
   所以看着就是"贴了个框"。官方的卡片根本不靠底色区分，靠的是
   0.5px 细描边 + 20px 大圆角 + 悬停换底。插件清单页（与本面板同在
   设置页里）的原文：
     border .5px settings-card-stroke / radius-xl / bg settings-card-fill
     hover → interactive-bg-hover
   这里整套照抄，不再自创。 */
.dscc-filters {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 10px;
  padding: 14px 16px; border-radius: var(--dsw-radius-xl);
  border: 0.5px solid var(--dsw-alias-settings-card-stroke);
  background: var(--dsw-alias-settings-card-fill);
}
/* 行容器不生成盒子 —— 它只为容纳「搜索框 + 按钮」而存在，本身不该占格子。 */
.dscc-filters-row { display: contents; }
/* 搜索框占满所在列（第 1 列），宽度交给网格轨道决定。
   【类名落在哪一层】官方 Input 是 wrap 包 input 的两层结构，所以真正占格子的是
   **外层 .dscc-search**，不是里面的 input。上一版把 dscc-filters-search 挂在
   input 上、规则写成 .dscc-input.dscc-filters-search —— 换成 wrap 结构后
   那条规则再也匹配不到任何元素（死规则），而它的级联断言只读 CSS 文本、
   不看 DOM，于是测试照样绿。这里把类与规则对齐到真正占格子的那一层。 */
.dscc-search.dscc-filters-search { width: 100%; min-width: 0; }

/* 筛选网格：与搜索框**同列**，所以左右边界由布局保证一致。
   【为什么是网格不是 flex-wrap】flex-wrap 下每个控件按内容自适应宽度，
   每行标签起点与控件宽度都不一样，看着就是「乱」；定列天然整齐。 */
.dscc-filters-grid {
  grid-column: 1;
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr) 48px minmax(0, 1fr);
  align-items: center;
  gap: 10px;
}
/* 字段：<label> 自身不生成盒子（display:contents），于是它的两个子节点
   （标签 span + 控件）**直接成为网格项** —— 既保证两列严格对齐，
   又保留「点标签聚焦控件」的原生语义。 */
.dscc-field { display: contents; }
/* 标签分散对齐：字数不一（4 字「会话类型」vs 2 字「项目」）要在同一列宽内
   两端顶格。只写 text-align: justify 无效 —— 单行文本 justify 不作用于
   最后一行，必须同时给 text-align-last: justify。 */
.dscc-field-label {
  width: 100%;
  font-size: 12px; line-height: 18px; white-space: nowrap;
  color: var(--dsw-alias-label-tertiary);
  text-align: justify;
  text-align-last: justify;
}

.dscc-panel-bulk {
  display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
  padding: 10px 14px; border-radius: var(--dsw-radius-xl);
  border: 0.5px solid var(--dsw-alias-settings-card-stroke);
  background: var(--dsw-alias-settings-card-fill);
}
.dscc-panel-count { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.dscc-panel-fail { color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 18px; }
/* 空态/加载态：官方清单页的状态文字是 13px-20px + label-tertiary。 */
.dscc-panel-state {
  padding: 28px 16px; border-radius: var(--dsw-radius-xl); text-align: center;
  border: 0.5px solid var(--dsw-alias-settings-card-stroke);
  background: var(--dsw-alias-settings-card-fill);
  color: var(--dsw-alias-label-tertiary); font-size: 13px; line-height: 20px;
}
.dscc-panel-state p { margin: 0 0 6px; }

/* ───────────── 会话列表行：官方卡片 ─────────────
   【为什么不用表格】表格要 6 列都对齐，列宽/换行/省略号互相牵制，
   一变窄就出现「逐字符换行」「标签乱飘」。官方清单页也是
   「卡片 + 左内容右操作」，各行内部独立，天然不错位。 */
.dscc-listwrap { flex: 1 1 auto; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 8px; padding-right: 2px; }
.dscc-row {
  display: flex; align-items: center; gap: 12px;
  box-sizing: border-box; min-height: 52px; padding: 12px 14px;
  border: 0.5px solid var(--dsw-alias-settings-card-stroke); border-radius: var(--dsw-radius-xl);
  background: var(--dsw-alias-settings-card-fill);
}
/* 官方卡片的悬停反馈就是这一条换底。 */
.dscc-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dscc-row-blocked { opacity: 0.62; }
/* 勾选框：官方 Checkbox.module.css 给 input 的那套（16px 见方 + accent-color
   跟随品牌色 + 官方焦点环）。官方那版外面套一层 label 并带**可见文字标签**，
   而本插件行旁就是标题、批量条是按钮，再插一个可见标签会重复，
   所以只取 input 部分；可访问名由 JSX 的 aria-label 给。 */
.dscc-row-check {
  flex: none; box-sizing: border-box;
  width: 16px; height: 16px; margin: 0;
  accent-color: var(--dsw-alias-brand-primary); cursor: pointer;
}
.dscc-row-check:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
.dscc-row-check:disabled { cursor: default; }

/* 主内容列：【实测修复 3】min-width:0 是关键，否则里面的省略号不生效 */
.dscc-row-main { min-width: 0; flex: 1 1 auto; display: flex; flex-direction: column; gap: 2px; }
/* 官方卡片标题：14px / 字重 500 / 20px 行高 / 单行省略。 */
.dscc-row-title {
  font-size: 14px; line-height: 20px; font-weight: 500;
  color: var(--dsw-alias-label-primary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* 官方卡片描述：12px-18px + label-tertiary。 */
.dscc-row-meta {
  min-width: 0;
  font-size: 12px; line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* 【实测修复 4】这里不得出现 break-all —— 标题是中文时逐字符折断。 */
/* 无标题行的会话 id：官方给「身份串」的做法是一枚 code 底片
   （font-family-code / 12px-18px / radius-xs / bg-module-platform / label-secondary）。
   只在行**没有标题**时才渲染（见 JSX 的注释）——有标题时 id 挪进悬停提示。 */
.dscc-row-id {
  box-sizing: border-box; display: inline-block;
  max-width: 100%; padding: 1px 6px; border-radius: var(--dsw-radius-xs);
  background: var(--dsw-alias-bg-module-platform);
  font-family: var(--ds-font-family-code); font-size: 12px; line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom;
}
.dscc-row-sep { margin: 0 6px; opacity: 0.6; }

/* 右侧固定区：状态徽标 + 操作按钮。官方 .cardTrailing：flex:none + gap 8px。 */
.dscc-row-side { flex: none; display: flex; align-items: center; gap: 8px; }
.dscc-row-badge { flex: none; width: 62px; text-align: right; }
.dscc-row-actions { flex: none; }

.dscc-panel-pager { display: flex; gap: 10px; align-items: center; justify-content: flex-end; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.dscc-panel-cost { font-variant-numeric: tabular-nums; opacity: 0.85; }
.dscc-panel-hidden { color: var(--dsw-alias-state-warn-primary); }

/* ───────────── 弹窗：官方 Modal.module.css ─────────────
   【层级方案 · showModal() 进 top layer（2026-10-18 用户实测修复）】
   旧方案是 div + position:fixed + z-index:1000，与官方 Modal 的写法一致。
   **但它有个致命前提我们并不满足**：z-index 只在**同一个层叠上下文**内比较。
   本插件渲染在宿主 shell.overlay 槽位里，该槽位的容器 .overlayLayer 是
   position:absolute; z-index:20 —— 它自己就是一个层叠上下文。于是我们的
   「z-index:1000「 只在这个容器内部有效，而容器整体只有 **20**，被设置页
   （在另一个列容器里、层级更高）压住：用户实测「删除结果框要关掉设置界面才看得见」。
   官方插件没暴露这个问题，是因为它们的 overlay 内容都是小提示，本来就不需要
   越过设置页整页；而删除结果框必须盖在一切之上。

   改用原生 <dialog> + showModal()：它把元素提升到**浏览器 top layer**，
   这是规范的顶层，**与任何祖先的 layer/上下文无关**，因此必然盖住设置页。
   额外好处：焦点陷阱、Esc 语义、背景 inert 都由浏览器免费提供。

   原生 dialog 的三个旧问题，逐个解决（不再靠猜，写清做法）：
     1. ::backdrop 与我们自己的遮罩叠加 → ::backdrop 显式置透明，
        遮罩仍由 「.dscc-modal-mask「（官方 bg-mask-1 + mask-blur）负责；
     2. 元素被宿主选择器意外匹配 → 我们用 data-dscc 命名空间，
        且 dialog 只带我们的类名，不注册任何角色去撞官方选择器；
     3. 「busy 时 Esc 不关」→ 浏览器默认的 cancel 事件**可以** preventDefault，
        见 useModalLayer 里对 cancel 的拦截。 */

/* 原生 dialog 的 UA 默认样式（margin:auto / border / padding / 背景）全部清掉，
   只保留我们自己的一套；尺寸与居中照旧由 flex 决定。 */
.dscc-modal {
  pointer-events: auto;
  position: fixed; inset: 0; z-index: 1000;
  display: flex; align-items: center; justify-content: center;
  padding: max(24px, var(--dsh-frame-overlay-top, 24px)) 24px;
  /* dialog UA 重置：见上 */
  margin: 0; width: 100%; height: 100%; max-width: none; max-height: none;
  border: 0; background: transparent; color: inherit; font: inherit;
  overflow: visible;
}
/* 关闭态不得占位：showModal() 之外的原生 dialog 是 display:none，
   但我们的 [open] 由 effect 控制，这里显式声明「没有 open 就不渲染」，
   避免极短的一帧里以静态块出现。 */
.dscc-modal:not([open]) { display: none; }
/* 背景遮罩：官方 bg-mask-1 由 CSS 变量给，::backdrop 不重复上色。 */
.dscc-modal::backdrop { background: transparent; }
/* 官方遮罩：absolute + backdrop-filter 模糊 + 一层 bg-mask-1 底色，
   入场淡入。上一版我用 color-mix(bg-base 45%) 自己凑 —— 现在有真令牌了。 */
.dscc-modal-mask {
  position: absolute; inset: var(--dsh-frame-chrome-top, 0px) 0 0;
  backdrop-filter: var(--dsw-mask-blur);
}
.dscc-modal-mask::after {
  content: ""; position: absolute; inset: 0;
  background: var(--dsw-alias-bg-mask-1);
  animation: dscc-modal-enter .2s cubic-bezier(.4, 0, .2, 1);
}
/* 官方卡片：radius-panel(28px) / bg-layer-2 / prominent 描边阴影 /
   列方向 gap 20px / 底部 24px 内边距 / 宽 min(380px,100%)。
   本面板内容较长（删除结果有多行），宽度放宽到 460px —— 官方自己的
   RiskConfirmation 也是同一形态、宽度取 min(440px,100%)，同族做法。 */
.dscc-card {
  box-sizing: border-box; position: relative; z-index: 1;
  display: flex; flex-direction: column; gap: 20px;
  width: min(460px, 100%); max-height: 100%;
  padding: 0 0 24px; overflow: hidden;
  border: 0; border-radius: var(--dsw-radius-panel);
  background: var(--dsw-alias-bg-layer-2);
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
  box-shadow: var(--dsw-elevation-prominent);
  color: var(--dsw-alias-label-primary); font: inherit;
  animation: dscc-modal-enter .2s cubic-bezier(.4, 0, .2, 1);
}
@keyframes dscc-modal-enter { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  .dscc-card, .dscc-modal-mask::after { animation: none; }
}
.dscc-card:focus { outline: none; }
/* 官方 .content / .header / .title / .close / .description / .body / .footer
   一套：头部 pad 22/14/12/24 且两端对齐（标题左、关闭按钮右），
   正文与描述共用 24px 侧内边。 */
.dscc-card-content { display: flex; flex-direction: column; width: 100%; min-height: 0; overflow-y: auto; }
.dscc-card-head {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 22px 14px 12px 24px;
}
.dscc-card h2 {
  margin: 0; font-size: 16px; line-height: 24px; font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
/* 官方 .close：28px 见方、radius-sm、透明底、次要文字色、悬停换底。 */
.dscc-card-close {
  flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; border: none; border-radius: var(--dsw-radius-sm);
  background: transparent; cursor: pointer; color: var(--dsw-alias-label-secondary);
}
.dscc-card-close:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dscc-card-close:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 1px;
}
.dscc-card-body { display: flex; flex-direction: column; min-width: 0; margin-top: 20px; padding: 0 24px; }
.dscc-card p { margin: 0 0 10px; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-primary); }
.dscc-card p:last-child { margin-bottom: 0; }
.dscc-card .dscc-subject { color: var(--dsw-alias-label-primary); font-weight: 500; word-break: break-word; }
.dscc-card .dscc-id {
  font-family: var(--ds-font-family-code); font-size: 12px; line-height: 18px;
  color: var(--dsw-alias-label-secondary); word-break: break-all;
}
/* 官方 .footer：两端对齐靠右、gap 8px、24px 侧内边。 */
.dscc-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 0 24px; }
/* 官方 RiskConfirmation 的警示块：图标 14px 顶对齐 + 次要文字 14px-22px。 */
.dscc-warn {
  display: flex; gap: 10px; align-items: flex-start;
  margin: 0 0 4px; padding: 10px 12px;
  border: 0.5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-md);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 6%, transparent);
  font-size: 13px; line-height: 20px;
  color: var(--dsw-alias-label-secondary);
}
.dscc-warn-dot {
  flex: none; width: 8px; height: 8px; margin-top: 6px; border-radius: 50%;
  background: var(--dsw-alias-state-error-primary);
}
.dscc-kv { margin: 2px 0 0; padding: 0; list-style: none; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
.dscc-kv li { margin-bottom: 2px; }
.dscc-error-code {
  display: inline-block; margin-bottom: 6px; padding: 1px 6px; border-radius: var(--dsw-radius-xs);
  background: var(--dsw-alias-bg-module-platform);
  font-family: var(--ds-font-family-code); font-size: 12px; line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}

/* ───────────── 批量管理面板外壳 ─────────────
   官方清单页的 section：max-width 760px、列方向、gap 14px。
   设置页内容列自己滚动，所以这里用自适应高度而不是 100vh。
   【实测修复 · 级联】必须写成 .dscc-panel.dscc-panel-section（优先级 0,2,0）：
   原来只写 .dscc-panel-section（0,1,0）与 .dscc-panel 同优先级且排在其前，
   于是 .dscc-panel 的 height/padding/background 全部胜出，这条从未生效。 */
.dscc-section { display: block; }
.dscc-panel.dscc-panel-section { height: auto; padding: 0; background: transparent; }
.dscc-panel {
  display: flex; flex-direction: column; gap: 14px;
  width: 100%; max-width: 760px;
  height: 100%; box-sizing: border-box; padding: 20px 22px;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary); font: inherit;
}
/* 官方设置页标题：14px-22px 常规字重（section 标题不抢视觉）。 */
.dscc-panel-head h1 { margin: 0 0 2px; font-size: 16px; line-height: 24px; font-weight: 500; }
.dscc-panel-head p { margin: 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-tertiary); }
`;
    function Styles() {
      return h("style", { "data-dscc": "styles" }, CSS);
    }

    /**
     * 官方图标（primitives 的 IconXxxOutline 系列）。
     *
     * 官方图标全部是 **16 viewBox、stroke=currentColor、fill=none**，
     * 分 Regular（1px 描边）与 Medium（1.3px）两档。这里按 R-23 正路把
     * 路径数据抄过来（路径数据是美术，不是内部 API），只留本插件用到的四枚。
     * 一律 aria-hidden —— 可访问名由渲染处的文字/aria-label 负责（官方同款）。
     */
    const ICON_NS = "http://www.w3.org/2000/svg";
    function makeIcon(paths, sizeDefault) {
      return function Icon(props) {
        const size = typeof props?.size === "number" ? props.size : sizeDefault;
        return h(
          "svg",
          {
            width: size,
            height: size,
            className: props?.className,
            viewBox: "0 0 16 16",
            fill: "none",
            xmlns: ICON_NS,
            "aria-hidden": "true",
            strokeWidth: props?.medium === true ? "1.3" : "1",
          },
          ...paths.map((d, i) => h("path", { key: i, d, stroke: "currentColor" })),
        );
      };
    }
    // IconChevronDownOutline：官方下拉触发器右侧那枚箭头。
    const IconChevronDown = makeIcon(
      ["M4 6L7.29289 9.29289C7.68342 9.68342 8.31658 9.68342 8.70711 9.29289L12 6"],
      14,
    );
    // IconCloseOutline：官方 Modal 右上角的关闭按钮。
    const IconClose = makeIcon(["M2.5 2.5L13.5 13.5", "M13.5 2.5L2.5 13.5"], 14);
    // IconCheckOutline：官方 Menu 选中行尾部那枚勾。
    const IconCheck = makeIcon(
      ["M2.25 8.5L5.49732 11.7473C5.90519 12.1552 6.57263 12.1344 6.95426 11.7018L13.75 4"],
      14,
    );
    // IconSearchOutline：官方搜索框前置图标。
    const IconSearch = makeIcon(
      [
        "M6.58727 11.8586C9.55061 11.8586 11.9529 9.45637 11.9529 6.49304C11.9529 3.5297 9.55061 1.12744 6.58727 1.12744C3.62394 1.12744 1.22168 3.5297 1.22168 6.49304C1.22168 9.45637 3.62394 11.8586 6.58727 11.8586Z",
        "M10.2991 10.3933L14.7783 14.8725",
      ],
      16,
    );

    /**
     * 官方「选择器药丸 + 内联 Menu」下拉。
     *
     * 【为什么必须换掉原生 select】原生 select 的下拉面板由**操作系统**绘制 ——
     * 直角、系统描边、不跟随主题，与官方主题完全两个世界。这正是用户看到
     * 「不统一」的主要来源。官方在同一个设置页里（dsh-client-locale 的语言行）
     * 的做法是：button 药丸（挂 aria-haspopup=menu / aria-expanded）
     * + primitives 的 Menu。这里整套照抄。
     *
     * 【R-22 边界】官方 Menu 有两种形态：portal（createPortal 到 document.body）
     * 与**默认的非 portal**（position:absolute 贴在触发器下方）。语言行用了 portal，
     * 但 R-22 禁止往 document.body 挂东西，所以这里用官方自己的另一种形态 ——
     * 非 portal、留在组件树内。这不需要猜宿主层级：菜单在卡片内，
     * 只需盖过同层内容（官方 .list 的 z-index:100 就是这一档）。
     *
     * 【官方键盘语义，逐条对齐 Menu 的行为】
     *   · 打开时聚焦**选中行**（官方 autoFocus=false 时的做法）；
     *   · ↑/↓（含 Home/End）在行间游走；Tab 落在当前行并关闭；
     *   · Esc / Shift+Tab 关闭并把键盘还给触发器；
     *   · 选中一行的焦点回到触发器，除非拥有者自己移动了它。
     * 这些是「用户依赖的行为」（R-23 明令保留），不是可选装饰。
     */
    function SelectMenu(props) {
      const options = Array.isArray(props.options) ? props.options : [];
      const [open, setOpen] = React.useState(false);
      // 触发器盒子与列表盒子：官方 Builtin 只保证 useState，没有 useRef，
      // 所以用惰性初始值拿跨渲染稳定的 ref 盒子。
      const boxes = React.useState(() => ({ root: { current: null }, list: { current: null } }));
      const refs = boxes[0];

      const activeIndex = options.findIndex((o) => o.value === props.value);
      const activeLabel =
        activeIndex >= 0 ? options[activeIndex].label : (props.placeholder ?? "");

      /** 打开时把焦点放到选中行（没有选中行则第一行）—— 官方同款。 */
      React.useEffect(() => {
        if (!open) return undefined;
        const list = refs.list.current;
        if (list === null || list === undefined) return undefined;
        if (typeof list.focus === "function") {
          try {
            list.focus();
          } catch {
            /* 环境不支持 focus 就留在触发器上 */
          }
        }
        return undefined;
      }, [open, refs]);

      /** 点外面关闭：官方用 useDismissOnOutsidePointer，这里同一思路。 */
      React.useEffect(() => {
        if (!open) return undefined;
        const onPointerDown = (event) => {
          const root = refs.root.current;
          const target = event?.target;
          if (root === null || root === undefined) return;
          if (typeof root.contains === "function" && typeof target === "object" && target !== null) {
            if (root.contains(target)) return;
          }
          setOpen(false);
        };
        // capture 阶段：官方同款，保证先于宿主自己的处理器看到这次点击。
        if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
          document.addEventListener("pointerdown", onPointerDown, true);
          return () => document.removeEventListener("pointerdown", onPointerDown, true);
        }
        return undefined;
      }, [open, refs]);

      const pick = (option) => {
        setOpen(false);
        if (option.value !== props.value && typeof props.onChange === "function") {
          props.onChange(option.value);
        }
      };

      /** 游走指针：官方用一个 ref 记住「键盘最后落在哪一行」，
       *  焦点离开列表再回来时从那里续上，而不是跳回选中行。 */
      const idxBox = React.useState(() => ({ current: Math.max(0, activeIndex) }));
      const focusIndexRef = idxBox[0];
      // 每次打开都从选中行开始（官方 autoFocus=false 的初始焦点）。
      React.useEffect(() => {
        if (open) focusIndexRef.current = Math.max(0, activeIndex);
      }, [open, activeIndex, focusIndexRef]);

      const rowsOf = () => {
        const list = refs.list.current;
        if (list === null || list === undefined || typeof list.querySelectorAll !== "function") return [];
        return [...list.querySelectorAll("[data-dscc-row]")];
      };
      const focusRow = (index) => {
        const row = rowsOf()[index];
        if (row && typeof row.focus === "function") row.focus();
      };
      const focusTrigger = () => {
        const root = refs.root.current;
        if (root === null || root === undefined) return;
        if (typeof root.querySelector !== "function") return;
        const button = root.querySelector("button:not(:disabled)");
        if (button && typeof button.focus === "function") button.focus();
      };

      /** ↑/↓/Home/End 游走 + Tab/Esc —— 官方 Menu 的键盘口径。 */
      const onKeyDown = (event) => {
        const key = event.key;
        if (key === "Escape") {
          event.preventDefault();
          setOpen(false);
          focusTrigger();
          return;
        }
        if (key === "Shift" || key === "Control" || key === "Alt" || key === "Meta") return;
        if (key === "Tab") {
          // 官方：Tab settles the focused row（落在当前行并关闭，键盘交还触发器）。
          const focused = options[focusIndexRef.current];
          setOpen(false);
          if (focused !== undefined && focused.value !== props.value && typeof props.onChange === "function") {
            props.onChange(focused.value);
          }
          focusTrigger();
          return;
        }
        let next = focusIndexRef.current;
        if (key === "ArrowDown") next = Math.min(options.length - 1, next + 1);
        else if (key === "ArrowUp") next = Math.max(0, next - 1);
        else if (key === "Home") next = 0;
        else if (key === "End") next = options.length - 1;
        else if (key === "Enter" || key === " ") {
          const chosen = options[focusIndexRef.current];
          if (chosen !== undefined) {
            event.preventDefault();
            pick(chosen);
          }
          return;
        } else return;
        event.preventDefault();
        focusIndexRef.current = next;
        focusRow(next);
      };

      return h(
        "div",
        { className: "dscc-select-root", ref: refs.root },
        h(
          "button",
          {
            type: "button",
            className: "dscc-selector",
            "aria-haspopup": "menu",
            "aria-expanded": open,
            "aria-label": props.label,
            title: props.title,
            disabled: props.disabled === true,
            onClick: () => setOpen((v) => !v),
          },
          h("span", { className: "dscc-selector-label" }, activeLabel),
          h(IconChevronDown, { className: "dscc-selector-chevron" }),
        ),
        open
          ? h(
              "div",
              {
                ref: refs.list,
                className: "dscc-menu",
                role: "menu",
                "aria-label": props.label,
                tabIndex: -1,
                onKeyDown,
              },
              ...options.map((option, index) =>
                h(
                  "button",
                  {
                    key: String(option.value),
                    type: "button",
                    role: "menuitemradio",
                    "aria-checked": option.value === props.value,
                    "data-dscc-row": "true",
                    className: "dscc-menu-item",
                    title: option.title,
                    // 官方：只有键盘走到该行才聚焦；指针点击不抢焦点，
                    // 避免鼠标用户看到一圈多余的聚焦环。
                    tabIndex: -1,
                    onFocus: () => {
                      focusIndexRef.current = index;
                    },
                    onClick: () => pick(option),
                  },
                  h("span", { className: "dscc-menu-item-label" }, option.label),
                  option.value === props.value
                    ? h(IconCheck, { className: "dscc-menu-item-check" })
                    // 未选中行留同宽空位，保证各行文字左对齐（官方 .check 占位）
                    : h("span", { className: "dscc-menu-item-check", "data-hidden": "true" }, null),
                ),
              ),
            )
          : null,
      );
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

        // 【置顶的关键】showModal() 把 <dialog> 提升到浏览器 top layer。
        // 这是唯一能保证「盖住设置页」的机制：top layer 不受任何祖先层叠上下文影响，
        // 也不参与 z-index 比较。idempotent 保护：已在 top layer 时不重复调用（会抛错）。
        if (typeof element.showModal === "function" && element.open !== true) {
          try {
            element.showModal();
          } catch {
            /* 已被别的路径打开 / 已脱离文档：退化为普通显示，不阻断删除流程 */
          }
        }

        // 原生 dialog 的 Esc 走 `cancel` 事件（不是 keydown）：在这里拦 busy。
        // 拦掉后浏览器不会自己关闭，我们也就不关 —— 语义与旧实现逐字一致。
        const onCancel = (event) => {
          event.preventDefault();
          if (allowRef.current !== false) closeRef.current();
        };
        element.addEventListener("cancel", onCancel);

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
          // Esc 交给原生 dialog 的 cancel 事件（见上面的 onCancel），
          // 这里只保留 Tab 的焦点循环：top layer 已经把背景惰化，
          // 但循环仍在卡片内，避免焦点跑进 dialog 之外的宿主元素。
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
          element.removeEventListener("cancel", onCancel);
          // 必须 close()：否则 dialog 留在 top layer 上，页面会一直「被模态」。
          if (typeof element.close === "function" && element.open === true) {
            try {
              element.close();
            } catch {
              /* 已关闭 / 已脱离文档 */
            }
          }
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

      /**
       * 官方 Modal 的卡片骨架（primitives Modal.module.css 的 anatomy）：
       *   root（fixed + inset:0 + z-index:1000，flex 居中）
       *     ├ mask（absolute + backdrop-filter + bg-mask-1 底色）
       *     └ dialog（role=dialog + aria-modal + aria-label，radius-panel，
       *          bg-layer-2，prominent 描边阴影）
       *          ├ content ─ header（h2 标题 + 右上关闭按钮）
       *          │            description
       *          │            body
       *          └ footer（动作行，靠右，gap 8px）
       *
       * 【语义只声明一次】role/aria-modal/aria-label 挂在 dialog 上；
       * 内层卡片不再重复声明，否则屏幕阅读器读成两层模态。
       *
       * 【遮罩点击故意不关闭】这是不可逆的删除确认，误点一次就丢一次确认机会。
       * 官方 Modal 的 onClose 会接遮罩点击，这里刻意不接 —— 关闭路径只有
       * 显式的「取消」按钮、右上角关闭钮，或 Esc（且 busy 时被 allowClose 挡住）。
       */
      const card = ({ title, body, footer }) =>
        h(
          "div",
          { className: "dscc-card" },
          h(
            "div",
            { className: "dscc-card-content" },
            h(
              "div",
              { className: "dscc-card-head" },
              h("h2", null, title),
              h(
                "button",
                {
                  type: "button",
                  className: "dscc-card-close",
                  "aria-label": t("done.close"),
                  disabled: state.busy === true,
                  onClick: () => setDialog(null),
                },
                h(IconClose, null),
              ),
            ),
            h("div", { className: "dscc-card-body" }, body),
          ),
          footer === null || footer === undefined ? null : h("div", { className: "dscc-actions" }, footer),
        );

      let content;
      if (state.result !== null && state.result.bulk === true) {
        // 批量结果：聚合计数 + 逐条失败原因
        const v = state.result;
        content = card({
          title: t("panel.resultTitle"),
          body: [
            h(
              "ul",
              { className: "dscc-kv", key: "kv" },
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
          ],
          footer: h(
            "button",
            { type: "button", className: "dscc-btn dscc-btn-primary", onClick: () => setDialog(null) },
            t("panel.resultClose"),
          ),
        });
      } else if (state.result !== null) {
        const v = state.result;
        const rows = [];
        // 内存条目三态：detached（摘掉了）/ absent（本就不在内存里，正常收尾）/ failed（真降级了）。
        //
        // 【修正 · 原来只有两态】真实宿主里 `sessions.list()` 就是 live 集合本身，
        // 删一个已关闭的会话时它「本来就不在内存里」，旧逻辑会把这句正常收尾
        // 显示成「内存条目未摘除（降级：只删了磁盘）」—— 用户每次删旧会话都看到
        // 一句吓人的降级提示，反而盖住真正该关注的情况。
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

        content = card({
          title: t("done.title"),
          body: [
            h("ul", { className: "dscc-kv", key: "kv" }, rows),
            v.partial === true ? h("p", { className: "dscc-warn", key: "warn" }, t("done.partial")) : null,
            h("p", { key: "hint" }, t("done.reloadHint")),
          ],
          footer: h(
            "button",
            { type: "button", className: "dscc-btn dscc-btn-primary", onClick: () => setDialog(null) },
            t("done.close"),
          ),
        });
      } else if (state.error !== null) {
        const info = explain(state.error, t);
        content = card({
          title: t("error.title"),
          body: [
            h("span", { className: "dscc-error-code", key: "code" }, info.code),
            h("p", { key: "what" }, h("strong", null, `${t("error.label.what")}：`), info.what),
            info.why ? h("p", { key: "why" }, h("strong", null, `${t("error.label.why")}：`), info.why) : null,
            info.hint ? h("p", { key: "hint" }, h("strong", null, "hint："), info.hint) : null,
            h("p", { key: "next" }, h("strong", null, `${t("error.label.next")}：`), info.next),
          ],
          footer: [
            h(
              "button",
              { key: "cancel", type: "button", className: "dscc-btn", onClick: () => setDialog(null) },
              t("confirm.cancel"),
            ),
            h(
              "button",
              {
                key: "retry",
                type: "button",
                className: "dscc-btn dscc-btn-primary",
                onClick: () => setDialog({ ...state, error: null }),
              },
              t("confirm.ok"),
            ),
          ],
        });
      } else {
        // 【H2/M4】这里原来有个「处理中 0/N…」分支，但 `state.total`/`state.done`
        // **从来不会被写入** —— 批量删除是**一次请求**（见 postDelete /
        // requestDeleteMany），宿主端整批处理，客户端拿不到中间进度。
        // 硬凑一个进度数字反而是**假进度**（数字永远不动）。现在统一「正在删除」。
        const isBulk = Array.isArray(state.bulkIds) && state.bulkIds.length > 1;
        content = card({
          title: t("confirm.title"),
          body: [
            h(
              "p",
              { key: "subject" },
              h("span", null, `${t("confirm.body", { title: "" })}`),
              h("span", { className: "dscc-subject" }, state.displayTitle || state.sessionId),
            ),
            // 批量删除是**一次请求**，没有「已完成几条」的中间状态。
            isBulk
              ? null
              : h(
                  "p",
                  { key: "id" },
                  h("strong", null, `${t("confirm.idLabel")}：`),
                  h("span", { className: "dscc-id" }, state.sessionId),
                ),
            h(
              "div",
              { className: "dscc-warn", key: "warn" },
              h("span", { className: "dscc-warn-dot" }),
              h("span", null, t("confirm.warning")),
            ),
          ],
          footer: [
            h(
              "button",
              { key: "cancel", type: "button", className: "dscc-btn", disabled: state.busy === true, onClick: () => setDialog(null) },
              t("confirm.cancel"),
            ),
            h(
              "button",
              { key: "ok", type: "button", className: "dscc-btn dscc-btn-danger", disabled: state.busy === true, onClick: run },
              state.busy === true ? t("action.deleting") : t("confirm.ok"),
            ),
          ],
        });
      }

      // 官方 Modal 的 root 结构：遮罩与卡片是兄弟，卡片压在遮罩之上。
      // 语义（role/aria-modal/aria-label）只挂在这一层。
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
        "dialog",
        {
          ref: dialogRef,
          className: "dscc-modal",
          "data-dscc": "scrim",
          role,
          "aria-modal": "true",
          "aria-label": label,
        },
        h(Styles, null),
        // 遮罩：aria-hidden（纯装饰），指针事件由 root 承担 —— 点遮罩不关闭（见上）。
        h("div", { className: "dscc-modal-mask", "aria-hidden": "true" }),
        content,
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
      return h("span", { className: "dscc-badge dscc-badge-outline" }, t("panel.blocked"));
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
      // 用 CSS Grid 定列（标签列定宽 + 控件列定宽），所有行标签右对齐、控件等宽 —— 天然整齐。
      // 标签与控件是**两个网格项**（不能塞进同一个普通 <label>，那样整个 label 只占一格，
      // 网格就退化成一格一个控件，对齐失效）。
      // 解法：<label> 用 display:contents —— 它自身不生成盒子，
      // 其子节点（标签 span + 控件）**直接成为网格项**，于是既有对齐、又保留
      // 「点标签聚焦控件」的原生语义（button 是 labelable 元素，点击会转发给它）。
      const field = (labelKey, control) =>
        h("label", { className: "dscc-field" }, h("span", { className: "dscc-field-label" }, t(labelKey)), control);

      /** 官方形态的下拉：选择器药丸 + 内联 Menu（替代原生 select）。 */
      const select = (labelKey, current, options, onPick, hintKey) =>
        field(
          labelKey,
          h(SelectMenu, {
            label: t(labelKey),
            title: hintKey ? t(hintKey) : undefined,
            value: current,
            options,
            onChange: (next) => onPick(next),
          }),
        );

      const toolbar = h(
        "div",
        { className: "dscc-filters" },
        // 第 1 行：搜索 + 刷新
        h(
          "div",
          { className: "dscc-filters-row" },
          // 官方搜索框：前置图标绝对定位在左 12px，输入框左内边距让位。
          h(
            "div",
            { className: "dscc-search dscc-filters-search" },
            h(IconSearch, { className: "dscc-search-icon" }),
            h("input", {
              className: "dscc-input",
              type: "search",
              value: queryInput,
              placeholder: t("panel.search"),
              "aria-label": t("panel.searchLabel"),
              onChange: (event) => setQueryInput(event.target.value),
            }),
          ),
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
          select(
            "panel.project",
            params.project,
            [
              { value: "", label: t("panel.projectAll") },
              ...(Array.isArray(value?.projects) ? value.projects : []).map((project) => ({
                value: project,
                label: project,
              })),
            ],
            (next) => setParams((prev) => ({ ...prev, project: next, page: 1 })),
          ),
          select(
            "panel.state",
            params.running,
            [
              { value: "", label: t("panel.stateAll") },
              { value: "idle", label: t("panel.stateIdle") },
              { value: "running", label: t("panel.stateRunning") },
            ],
            (next) => setParams((prev) => ({ ...prev, running: next, page: 1 })),
          ),
          // 会话类型：官方侧栏默认隐藏子代理行；这里给显式三选一，
          // 让用户既能看主会话（默认，与侧栏一致），也能专门清理子代理会话。
          select(
            "panel.kind",
            params.kind,
            [
              { value: "main", label: t("panel.kindMain") },
              { value: "subagent", label: t("panel.kindSubagent") },
              { value: "all", label: t("panel.kindAll") },
            ],
            (next) => setParams((prev) => ({ ...prev, kind: next, page: 1 })),
            "panel.kindHint",
          ),
          // 归档三选一，文案照官方侧栏视图选项。
          select(
            "panel.archived",
            params.archived,
            [
              { value: "default", label: t("panel.archivedHide") },
              { value: "show", label: t("panel.archivedShow") },
              { value: "only", label: t("panel.archivedOnly") },
            ],
            (next) => setParams((prev) => ({ ...prev, archived: next, page: 1 })),
            "panel.archivedHint",
          ),
          select(
            "panel.sort",
            params.sort,
            [
              { value: "activity", label: t("panel.sortActivity") },
              { value: "created", label: t("panel.sortCreated") },
            ],
            (next) => setParams((prev) => ({ ...prev, sort: next, page: 1 })),
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
                    // 会话 id 不在行内显示（36 字符的 UUID 读不了也没法用，
                    // 还把标题挤掉半行），但**保留在悬停提示里**：
                    // 需要精确核对身份或从日志反查时，鼠标停上去就能看到。
                    title: `${row.sessionId} · ${row.project ?? "—"} · ${formatTime(row.updatedAt ?? row.createdAt)}`,
                  },
                  // 【例外】没有标题的行，id 就是它唯一的身份 —— 这时必须显示，
                  // 否则同一个项目里几条空标题会话在视觉上完全无法区分
                  // （而这是一个**不可逆的删除**界面，认错了行代价很大）。
                  row.title ? null : h("code", { className: "dscc-row-id" }, row.sessionId),
                  row.title ? null : h("span", { className: "dscc-row-sep" }, "·"),
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
                }) +
                // 【兑现 service.js 步骤 5b 的承诺】标题预算（titleLimit）之外的行
                // 只按廉价字段匹配，必须如实告诉用户「按标题搜可能不完整」——
                // 静默漏报是这条 bug 的原罪，界面不许假装搜过。
                ((titleStat.truncated ?? 0) > 0
                  ? t("panel.costTruncated", { n: titleStat.truncated })
                  : "")
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
