# 变更记录

## 未发布

### 界面改版：控件与弹窗全部换成官方形态（R-23 正路）

**动机**：用户要求「调用官方卡片接口和布局，参考另一个插件（插件市场）的操作流程」。

**先说清楚一件事：官方并没有导出 `Card` 这个组件。**
把 `@deepseek-ai/dsh-client-ui-primitives` 的导出表整表查了一遍（33 个组件），
其中只有 `HoverCard` / `CodeCard`，而 `CodeCard` **连导出都没有**。
所以「调用官方卡片接口」实际可行的那一件事，就是**让本插件的控件长得和官方一模一样**。

**R-23 的真实口径（官方 practices.md 原文，逐字）：**

> Do not `require('@deepseek-ai/dsh-client-ui-primitives')` or load any other Harness
> Client package as a module; `dsh.client.inject` entries only order activation and
> stay allowed. They change without notice, a plain-JS plugin has no type check, and a
> throwing component blanks your slot entry (console: `slot entry crashed in '<slot>'`).
> **Write your own controls and match the host instead: copy markup, CSS, and behavior
> from the primitive into the plugin** … Rename copied classes under your plugin's
> prefix, keep only `--dsw-alias-*` token references, and keep the behavior that users
> rely on, such as Modal focus and Escape handling, `role="switch"` with `aria-checked`,
> and Tooltip placement. Tokens then remain the only shared styling dependency.

也就是说：**禁止的是 require 官方包；抄它的实现是官方指明的正路。**
另一个插件（插件市场）走的是 require 官方包那条路，**在规范里明确不可取**——
纯 JS 没有类型检查，官方一改内部 API，组件抛错会让整条 slot entry 白屏
（控制台 `slot entry crashed in '<slot>'`）。因此本插件不照它那条路走。

**改了什么**（全部从 asar 内 `dsh-client-ui-primitives/lib/*` 逐条拷贝，类名加 `dscc-` 前缀）：

| 控件 | 官方出处 | 抄过来的内容 |
|---|---|---|
| 按钮 | `Button.module.css` | md=36px 高/12px 圆角/`0 14px`/14px 字 22px 行高；sm=28px/8px/`0 10px`/12px 18px |
| 徽标 | `Tag.module.css` | 999px 圆角、`1px 8px`、11px/17px、字重 500、nowrap；状态 tone 用 `color-mix` 10% 自着色底 + 同色文字（warning 12%） |
| 卡面 | `Modal.module.css` | `border-l1` + 16px 面板级圆角 + `bg-layer-2` |
| 弹窗 | `Modal.module.css` + `useModalLayer` | `position:fixed` + `inset:0` + `z-index:1000`，flex 居中，24px 内边距；焦点/Esc 行为整套 |

**令牌换算（为什么不能照抄官方 CSS 原文）**：
官方那套 `--dsw-radius-*` / `--dsw-alias-interactive-bg-hover` / `--dsw-alias-button-*` /
`--dsw-alias-bg-mask-1` 名字，**不在**现场 `Theme.listTokens` 的 14 个令牌里（R-24 明令
只用全表内的令牌）。所以半径与悬停底色一律换算成令牌表达：圆角取官方同族刻度字面值
（12/8/16px），悬停底色用 `bg-layer-2`，遮罩沿用既有的 `bg-base 45%` 混合。
几何字面值不是颜色，不受 R-24 约束。

**弹窗为什么从原生 `<dialog>` 改成 `div`**：

旧实现用 `<dialog>` + `showModal()` 进浏览器 top layer 来保证置顶。官方**并没有**这么用。
改掉的三个理由：

1. 原生 `::backdrop` 会与我们的 `.dscc-scrim` 叠加，不得不把它置透明；
2. 它在 DOM 里是一个 `<dialog>` 元素，宿主其它样式与查询选择器可能对它产生意料之外的匹配；
3. 焦点陷阱与 Esc 全交给浏览器，我们无法实现「**busy 时不允许关闭**」——
   而删除进行中把界面关掉，会让用户以为操作被取消。旧代码只能 `preventDefault` 赌一把。

现在顶层由 `z-index:1000` 负责置顶，键盘与焦点自己实现，于是「busy 时 Esc 不关」
变成一条确定的分支。**R-22 的边界守住了**：官方用 `createPortal` 到 `document.body`，
那正是 R-22 禁止的，本插件**不做 portal**，覆盖层仍渲染在 `shell.overlay` 这个
官方分配的槽位里，靠 z-index 取胜。

**四条既有实测修复全部保留**（换皮不得弄丢，每条都有回归断言 + 变异测试钉住）：

1. 按钮文字 `white-space: nowrap` —— 否则「刷新」被压成「刷/新」两行；
2. hover 换底只作用于中性按钮 —— 否则实心按钮悬停即「消失」（对比度≈0）；
3. 主内容列 `min-width: 0` —— 否则标题省略号不生效；
4. 卡片行内不得 `break-all` —— 否则中文标题逐字符折断。

### 测试口径修正（重要，这是一次收紧而非放宽）

原 R-22 断言是「源码里不得出现 `querySelector`」。而 R-22/R-25 的真实口径是
**不得读别的插件的 DOM / 样式表 / 组件源码来估位置**：

> Do not read another plugin's DOM, stylesheet, or component source to estimate
> placement; choose a slot that already allocates space.

在自己的卡片元素上 `querySelector` 找「第一个可聚焦控件」是焦点陷阱的必需步骤
（官方 `useModalLayer` 也正是这么做的），与「读宿主 DOM 定位」是两件事。
因此改成**按对象收紧**，并且**同时补上收紧的那一半**：

- 禁止：`document.querySelector`、`querySelector(".some-class")`（按 class 翻别人家节点）、`createPortal`、`documentElement`
- 放行：在自己的 ref 上按属性/角色查询
- 正向断言：必须确实存在 `querySelector("[data-modal-autofocus]")`，
  否则这条测试会被「什么都不查」的空实现骗绿

### 验证

- **测试 179 / 179 通过**（新增 3 条：官方形态几何、官方 Modal 键盘语义、R-22/R-25 收紧）
- **变异测试 18 / 18 全部击杀**（`test/mutate-official-form.mjs`，需手动运行）：
  M1 按钮高度、M2 按钮圆角、M3 丢掉 nowrap、M4 徽标圆角、M5 徽标字重、
  M6 状态徽标退回纯文字色、M7 弹窗丢 z-index、M8 卡片行圆角、M9 丢 min-width:0、
  M10 Esc 不挡 busy、M11 不处理 Esc、M12 丢焦点陷阱、M13 丢关闭还焦、
  M14 丢 data-modal-autofocus、M15 按 class 翻宿主 DOM、M16 小按钮刻度、
  M17 hover 不排除变体、M18 可聚焦集合丢官方口径
- 变异脚本命名为 `.mjs` 而非 `.test.mjs`：它**改完源码要还原**，
  被 `test/**/*.test.mjs`  glob 收进去会在套件内部二次运行并把 client.js 留在变异态
  （这个坑真实踩到过一次，套件因此红了一片）

---

## 未发布（上一轮：侧栏幽灵行）

### 修复：删掉的会话仍留在官方侧栏「未分组」下（真修法）

**现象**：在面板里删掉会话，删除本身成功（磁盘目录、工作区归属、归档记录全部清干净），
但官方侧栏仍把那几行列在「未分组」下面。

**前两次诊断都是错的，在此如实记录**：

1. ❌「删除事务顺序问题」（先摘归属、后删工件）→ 1.0.2 改了顺序并加了条件，
   **问题依旧**。
2. ❌「客户端 `projectList()` 从父会话 `subagentCatalog` 注入子会话 id」
   → **被自己的实测证伪**：整个 `session_projcache` 目录搜 `subagentCatalog` 键
   **0 处命中**，投影文件的实际结构是 `{version, record:{identity, rows}}`。

**最终用全盘扫描定论**：对那三个会话 id 递归搜索整个 `~/.dsh`，它们只出现在
审计日志与记忆索引里 —— **sessions 目录、projcache、storages 全部零命中**。
即：**持久化数据已经 100% 清除干净，缺的只是让客户端重新拉一次列表。**

官方侧栏的列表来自客户端 `ApiSessionList.refreshList()`
（`dsh-api-session-controller/lib/client.js`）：
`const result = await this.remote.session.list({});`
这次拉取发生在删除**之前**；删除后没有任何东西触发重新拉取，旧 id 就一直留在
`listSnapshot` 里，被 `groupByWorkspace` 归进 `stray` → 渲染成「未分组」。

**修法**：删除成功后 emit 官方**已声明的 Remote Event** `api-session/removed`。

```js
// dsh-api-remotes/lib/types/remote-events.js
{ event: 'api-session/removed', mode: 'emit' }
// dsh-api-session-controller/lib/typert.host.js
"'api-session/removed'(sessionId: SessionId): void"
```

`mode: 'emit'` 表示 Host 侧 `ctx.emit` 会**自动中继到所有客户端**；官方自己正是这么用：

```js
// dsh-api-session-controller/lib/index.js
ctx.on("session/disposed", (session) => { ctx.emit("api-session/removed", session.id); });
```

客户端 `handleSessionRemoved` 收到后：

```js
const durableSubagent = this.subagentAddress(id) !== void 0 || …origin === "subagent";
this.recordMutation(durableSubagent ? {kind:"status",…} : {kind:"remove", sessionId});
```

**只有 `kind:"remove"` 才会真正把 id 从侧栏列表抹掉**（`kind:"status"` 只改状态、不抹行）。

**新增配置** `announceRemoval`（默认 `true`）：关掉后回到「不通知、靠用户自己刷新」的旧行为。

**安全属性**：通知失败**绝不能**让一个已成功的删除变成失败。`ctx.emit` 在没有该事件
声明的运行时可能抛错，因此整段包在 try/catch 里，失败只记日志并在返回值里标
`announced:false`，界面据此如实提示「可能要刷新页面」。

### 验证

- 全量测试 **176/176 通过**（新增 6 条回归，锁住事件名、载荷、降级路径、配置开关）。
- 变异测试 **8/8 命中**，包括：不 emit、emit 错事件名、emit 抛错外泄、谎报
  `announced:true`、删除后不调用、默认关掉通知、前端不显示、前端键名打错。

## 1.0.2

### 修复：删除结果把「本就不在内存里」误报成「摘除失败」

**现象**：删掉一个已关闭的旧会话后，结果弹窗每次都显示
「内存条目未摘除（降级：只删了磁盘）」——一句吓人的降级提示。

**根因是 `detachLiveStore` 只有两态（true/false），把两种完全不同的情况混为一谈。**

读了宿主的真实实现后确认（`@deepseek-ai/dsh-session/lib/types/index.js`）：

- `sessions.list()` 的实现是 `[...this.store.values()].map(entry => entry.session)`
  —— 它**就是 live 集合本身**，不是持久化语料；
- `SessionStore` 的公开面只有 `create / prepare / enter / announce / flush / get / list / fork`，
  **没有** `detach / release / close`。所以旧代码分支①（遍历这三个方法名）在真实宿主里
  是**死代码**，真正走的只有分支②（`store` Map + `entry.detach`）。

于是删一个已关闭的会话时，它「本来就不在 store 里」，旧逻辑把这个**正常收尾**
显示成了「降级」。

**修法**：返回值改成三态，并让界面分别渲染。

| 值 | 含义 | 界面文案 |
|---|---|---|
| `detached` | 确实摘掉了 | 内存条目已摘除 |
| `absent` | 本来就不在内存里 —— **正常收尾** | 内存中已无此会话（无需摘除，属正常收尾） |
| `failed` | 本来在内存里、但没摘掉 —— 真的降级 | 内存条目未摘除（降级：只删了磁盘） |

顺带修掉两处相关的**谎报**：

1. `entry.detach()` 被调用后**再确认一次**它真的移除了。依据 `detachEntered()`
   第 940 行的 `if (this.store.get(entry.id) !== entry) return;` —— id 不匹配时
   **静默返回**，看起来调用了、其实什么都没删。旧实现在这里无条件返回成功。
2. `capabilities()` 的探针拆成 `detachLive`（store 可达）与 `detachLiveEntry`
   （`entry.detach` 存在）两问。旧探针只回答「`store.get` 是不是函数」，
   在真实宿主里**恒为 true**，于是 `/status` 一直显示「能摘内存」，
   而审计日志里 11 次删除**全部** `detached:false` —— 探针的答案与事实不符，
   排障时反而误导。

### 性能：清单排序不再用 localeCompare

实测（本机，5000 行 ISO-8601 字符串）：

```
localeCompare 9–15 ms  →  直接 < / > 比较 0–1 ms      （约 9–15 倍）
```

两个排序键（`createdAt` / `updatedAt`）在上游就已经是
`new Date(...).toISOString()` 的结果，ISO-8601 的定长格式保证
**字典序 == 时间序**，因此完全不需要 locale 感知比较。
降序只需把比较结果反向；键仍先归一化成字符串（非字符串一律退化成 `""`），
与原来的 `String(k ?? "")` 语义一致。

### 文档：删除事务顺序说明已与代码同步

`createService` 上方的注释还在描述「先摘工作区归属、后删磁盘工件」的**旧顺序**，
与 1.0.2 修正后的实现相反。已改成实际顺序，并写清 5 在 6/7 之前的原因。

### 验证

- 全量测试 **170/170 通过**（新增 5 条回归）。
- 变异测试 **6/7 命中**；唯一存活的变异经实测证明是**语义等价**的
  （去掉 `typeof` 兜底后，只有在键恰为 `""` 时才与现实现分歧，
  而 `toISOString()` 永远不产出空串），不是测试漏洞。
- 另用一份**忠于 asar 原文**的 `SessionStore` 复刻（`enter` / `detachEntered` /
  `list` / `get` 逐行对照）跑通完整删除事务：`detached=true`、归属被摘掉、
  幂等重删得到 `absent`、空 store 下探针如实报 `detachLiveEntry:false`。

## 1.0.2

### 修复：删掉的会话会以「未分组」的形式再次出现

**现象**：在面板里删掉一个会话后，它没有从侧边栏消失，而是跑到「未分组」下面重新出现。

**根因是删除事务里的顺序 + 缺条件，不是磁盘没删干净。**
官方侧栏的分组逻辑（`@deepseek-ai/dsh-client-ui-workspace/lib/client.js`
的 `groupByWorkspace`）是：

1. 遍历每个 workspace 的 `sessionIds`，命中的记入 `accounted`；
2. 把「在会话列表 `list.ids` 里、却不在 `accounted` 里」的行收进 `stray`，
   渲染成标题 `group.ungrouped`（中文「未分组」）的那一组。

旧实现**先把工作区归属摘掉、再删磁盘工件**。只要会话本体还留在宿主内存里
（实测 `detachLiveStore` 走的那条内部路径在真实宿主上取不到 store，
本机审计 5/5 次都是 `detached:false`），归属没了、行还在 → 它必然落进 `stray`，
于是以「未分组」的身份显示出来。

**修法**（三条，缺一不可）：

1. **调整顺序**：先删磁盘工件，再处理归属；
2. **加条件**：只有确认会话已不在宿主内存里时才摘归属。若它还在，
   **保留归属**（行留在原分组下，不会变成幽灵行），并在返回值里
   用 `keptWorkspaceMembership: true` 如实上报，界面据此说明原因；
3. **修 `detachLiveStore` 的假阳性**：旧实现只试 `sessions.store`，
   且不校验拿到的确实是 Map。现在遍历候选承载位置（`store`/`_store`/`sessions`），
   并用 `get` + `delete` 的存在性做 Map 语义校验。

**取舍说明**：这是**有意的保守选择**。宁可留一条分组正确、界面提示「刷新后消失」的行，
也不制造一条跑到「未分组」下的幽灵行。

**验证**：新增 3 条回归测试锁定因果（「内存里还在 → 不得摘归属」/「确实没了 → 才摘」/
「`detachLiveStore` 只认 Map 语义」）。变异测试 7/7 命中（另有 1 个占位变异正确保持
`fail 0`，用于证明变异脚本本身没有假阳性）。
期间修正了变异脚本的一个真实缺陷：`.NET` 的 `ReadAllText` 按**进程 CWD** 解析相对路径，
不认 PowerShell 的 `cd`，导致第一轮 7 个变异全部静默无效（表现为连占位都是 `fail 0`）。

## 1.0.1

### 修复：CI 与本地打出的 tarball 内容不一致（行尾由检出端配置决定）

第一次发版后，我用 `pnpm pack`（CI）与 `npm pack`（本地）各打了一次 tarball，
逐文件比对发现「同一个版本」内容不同：

| 文件 | CI 产物 | 本地产物 |
|---|---|---|
| `icon.svg` | 438 字节（10 个 CR） | 428 字节（纯 LF） |
| `LICENSE` | 1111 字节（21 个 CR） | 1090 字节（纯 LF） |

**根因不在打包器，在 `.gitattributes` 覆盖不全。** 当时只写了 `* text=auto`，
行尾于是由**检出端的 `core.autocrlf`** 决定；GitHub 的 windows runner 默认
`autocrlf=true`，凡是**没被显式声明 `eol=lf`** 的文件（`*.svg`、以及无扩展名的
`LICENSE`）都会被检出成 CRLF，再原样打进 tarball。

修法：把全局默认钉成 `* text=auto eol=lf`，让行尾**与检出端配置无关**；
二进制与 `*.ps1`（Windows PowerShell 5.1 + BOM 的需要）单独覆盖。

**顺带抓出同类漏网文件**：`.gitignore` 在磁盘上也是 CRLF（22 个 CR），
已一并规整。

### 修复：行尾守卫自身的设计缺陷（第一版漏掉了这个事故）

上一轮新增的 `test/eol.test.mjs` **没能拦住上面这个缺陷** —— 因为它按
**硬编码扩展名清单**（`.js`/`.json`/`.md`…）扫描，而 `.svg` 不在清单里、
`LICENSE` 与 `.gitignore` 根本没有扩展名。

已重写为从实际出发的两条腿：

1. **磁盘字节扫描**：对所有**被 git 跟踪**的文件（不依赖扩展名清单）；
2. **`git check-attr eol`**：读**实际生效**的属性，而不是用正则去猜
   `.gitattributes` 的文本 —— 后者正是第一版会静默放过的原因。

这样「清单外的新文件」也会被自动覆盖。变异测试 2/2 命中：

| 变异 | 结果 |
|---|---|
| 把 `* text=auto eol=lf` 改回 `* text=auto`（复现本事故） | ✅ 精确报出 `icon.svg`/`LICENSE` 的 `eol: unspecified` |
| 把 `icon.svg` 存成 CRLF | ✅ 报出「10 个 CR」 |

教训：设防要**对着仓库实际内容与 git 的判定**推导，不能凭想象列清单。

## 1.0.0

首次发布（未对外发布前的迭代都并入本条目）。

### 修复：筛选区与搜索框右边界不对齐（「对齐输入框」）

用户给了截图：「对齐输入框」。

**先用真浏览器量清楚，再动手。** 我写了个探针：把 `client.js` 注册的组件**真实渲染成
HTML**（不手抄 JSX），再在 Edge 里量几何。原始数据：

| 元素 | 左 | 右 |
|---|---|---|
| 搜索框 | 15 | **752.42**（右侧被「刷新」按钮占走） |
| 筛选网格 | 15 | **840** |
| | ↑ 左边界本来就齐 | ↑ **右边界差 87.58px** |

所以**不齐的是右边界**，不是左边 —— 只盯着「左对齐」永远修不好。
根因：外层是 flex-direction: column，第 1 行（搜索+刷新）和第 2 行（筛选网格）
各自独占整宽，于是搜索框止步于按钮左边，而网格铺到卡片右内边。

**改法：让两者同列，由布局保证一致**（而不是调 padding 去凑 —— 按钮文字一长一短就又会不齐）：

```css
.dscc-filters      { display: grid; grid-template-columns: minmax(0, 1fr) auto; }
.dscc-filters-row  { display: contents; }        /* 行容器不占格子 */
.dscc-filters-grid { grid-column: 1; }           /* 与搜索框同列 */
```

顺带把控件列从固定的 152px 改成 minmax(0, 1fr) —— 截图里
「全部对话（显示已归档）」原本被截断，现在拉宽到约 304px 完整显示。

**复验（同一探针）**：grid.right − search.right = 0（原为 87.58），
grid.left − search.left = 0，标签墨迹左 = 搜索框左 = 15。并出截图目视确认。

**新增 4 条结构断言**（筛选卡是网格、行容器 display:contents、
网格 grid-column: 1、控件列可伸缩），并做变异测试：

| 变异 | 结果 |
|---|---|
| 筛选网格改 grid-column: 1 / -1（跨两列） | ✅ 被拦下 |
| 删掉 grid-column | ✅ 被拦下 |
| 行容器改回 flex（丢掉 display:contents） | ✅ 被拦下 |
| 控件列改回定宽 152px | ✅ 被拦下 |

**过程中修掉我自己两个测试缺陷**：

1. **静态断言先撞上注释**。我在 CSS 注释里写了示例 .dscc-filters-grid { grid-column: 1 }，
   而断言用的正则会**先匹配到注释里那份**，读到的是示例而不是真规则 ——
   这类断言会「改真规则却不红」。现在统一**先剥注释再断言**。
2. **正则太松导致假通过**。/grid-column:\s*1/ 同时匹配 grid-column: 1 / -1（跨列），
   而跨列正是要防的回归 —— 变异测试第一轮就把它抓出来了。已收紧为
   /grid-column:\s*1\s*(?:;|$)/ 并显式排除跨列写法。

（另外，本轮我又在 CSS 注释里写了反引号、被 `node --check` 拦下一次 ——
这是同一个错误第 6 次。守卫有效，但显然得靠它兜着。）

### 复刻 dsh-plugin-market 的打包发布流程

用户：「复刻我的另一个插件 dsh-plugin-market 下的打包流程」。

照搬的是**结构**（版本规则 / 门槛 / CI 链路），不是逐字复制 —— 两个仓库的形状不同，
照抄会坏，所以逐项适配并写进了 `docs/RELEASING.md`。

**新增**：

| 文件 | 作用 |
|---|---|
| `scripts/release.ps1` | 版本递增 + 门槛 + CI 打包/建 Release（本地不留任何产物） |
| `.github/workflows/pack-release.yml` | 标签推送 → 门槛 → `pnpm pack` → GitHub Release 附件 |
| `.github/workflows/publish-npm.yml` | **唯一**的 npm 发布实现（OIDC Trusted Publishing + 暂存发布） |
| `.gitattributes` | 行尾与 BOM 约定（`.ps1` 要 CRLF；带中文的 `.ps1` 要有 UTF-8 BOM） |
| `docs/RELEASING.md` | 版本号规则、适配点、npm 两个坑 |
| `test/release-workflow.test.mjs` | 发布工作流回归（反向断言「发布只能由 publish-npm.yml 亲自执行」） |
| `test/ps-script.test.mjs` | `.ps1` 的 BOM 与 `Get-Content -Encoding UTF8` 约定 |

**设计要点**（都来自参考仓库踩过的真坑，不是推测）：

- **本地只做版本与门槛，打包与发布全在 CI**：本地不产生打包产物、不消耗 gh/npm token；
  `dist/` 已进 `.gitignore`。
- **版本算术与档位判定每次发布都自检**：判例表 + 负向对照。版本号一旦发布就改不回来，
  所以这两条规则做成每次必跑的断言，而不是注释里的约定。
- **npm 发布只能由 `publish-npm.yml` 亲自执行**：npm 的 Trusted Publisher 按 OIDC 里的
  `job_workflow_ref` **文件名**匹配，而 `workflow_call` 下它指向**被调用**的文件 ——
  所以 `pack-release.yml` 必须 `uses:` 复用，自己写一遍会让令牌文件名变成
  `pack-release.yml` 并直接 `ENEEDAUTH`。参考仓库为此连挂两次（v1.1.6 / v1.2.0），
  本仓库用反向断言钉住这条底线。
- **两个 npm 坑**已写进 workflow 注释：不要 `npm@latest`（npm 12 与 node 22.14 不相容
  → EBADENGINE）、不给 `setup-node` 写 `registry-url`（会注入无效 token 盖过 OIDC）。

**逐项适配（照抄会坏的地方）**：

| 项 | dsh-plugin-market | 本仓库 |
|---|---|---|
| 包的位置 | `plugin-market/` 子目录 | **仓库根** |
| 客户端 bundle | `lib/client.js` | **`client.js`** |
| 回归测试 | `verify/*.test.mjs` | **`test/*.test.mjs`** |
| npm 发布 job | 需 `working-directory: plugin-market` | **不能设**（会 ENOENT） |

**顺带修掉一个真缺陷**：`lib/index.js` 原本把版本**写死**成 `export const version = "1.0.0"`。
复刻后第一次 `-Bump patch` 就会被新门槛当场拦下（「lib/ 的非注释行里仍写着旧版本号」），
而且 `/status` 与面板会**永久**显示 1.0.0。改为从包清单读
（`createRequire(import.meta.url)("../package.json").version`，与参考仓库同范式）。
已实测验证：临时把 version 改成 9.9.9 → 导出跟着变；还原 → 回到 1.0.0。

**验证**（不只是「测试绿」）：

- 单测 **148 → 156**（新增 8 条：发布工作流 6 + `.ps1` 约定 2）；
- `scripts/release.ps1 -LocalOnly` 在真实仓库里 **exit=0**，8 套测试全绿；
- **端到端实跑**（在临时 clone 里，不动真实仓库）：
  - `-Bump auto` 正确把 `feat` 判为 minor，并在 CHANGELOG 缺声明时给出可执行出路；
  - 声明 1.2.0 但证据是 patch → **拒绝**（双向硬拦），报错列明档位与两条出路；
  - 声明与证据一致 → **放行**：1.0.0 → 1.1.0（versionCode 10100）、提交、打标签，
    且 `lib/index.js` 导出的版本**跟着变成 1.1.0**；
  - 重跑同一版本 → 可重入（标签已在历史且发布面未变）；
  - 发布面有未提交改动 → 拒绝（这条在实跑中**真的触发了一次**，拦住了我自己的测试脚本）。
- **变异测试**：把 5 条防线逐一破坏（pack-release 自己跑 npm 发布 / 去掉幂等条件 /
  照抄 `working-directory` / 去掉 `.ps1` 的 BOM / `Get-Content` 漏写 `-Encoding`），
  **5/5 都被对应断言拦下**；原样对照全绿（证明不是环境坏了才红）。

**过程中我自己踩的坑（如实记录）**：

1. BOM 被编辑工具抹掉过 —— `scripts/release.ps1` 含大量中文，无 BOM 时
   Windows PowerShell 5.1 会按 ANSI 解码并直接解析坏。当场发现并补回，
   随后写了 `test/ps-script.test.mjs` 钉住。
2. `cordis.patch.yml` 的门禁一开始只认不带引号的 `name:`，而本仓库写的是带单引号的
   `name: 'dsh-dialogue-cleanup'`。**改的是门禁**（YAML 两种写法等价），不是去迁就检查器。

### 改名：`dsh-session-cleaner-clone` → `dsh-dialogue-cleanup`

包名与内部标识一次性统一改名。**上游参考项目不得被改**，已用脚本断言校验
（`@haoranwang0921/dsh-session-cleaner` 与 `dsh-session-cleaner@1.0.2` 出现次数前后不变）。

| 旧 | 新 | 用途 |
|---|---|---|
| `dsh-session-cleaner-clone` | **`dsh-dialogue-cleanup`** | 包名 / Client loader id / cordis 行 name |
| `session-cleaner-clone` | **`dialogue-cleanup`** | Host 插件 `name` / slot id 前缀 / 日志前缀 / patch 行 id |
| `sessionCleanerClone` | **`dialogueCleanup`** | Client locale 命名空间 |
| `/api-ext/session-cleaner` | **`/api-ext/dialogue-cleanup`** | 三条 HTTP 路由的基路径 |
| `session-cleaner.jsonl` | **`dialogue-cleanup.jsonl`** | 审计文件名 |
| `cleaner-unavailable` | **`cleanup-unavailable`** | 错误码 |
| `SessionCleanerPanel` / `SessionCleanerSection` | **`DialogueCleanupPanel` / `DialogueCleanupSection`** | 组件名 |
| `Session Cleaner` / `会话清理` | **`Dialogue Cleanup` / `对话清理`** | 显示名（`meta.title` / locale / 面板标题） |

改名只动标识符，**行为零变化**：143 条单测全绿（含断言包名、loader id、slot id、
HTTP 路径、locale key、错误码的用例），`node --check` 全过。

**改名后已执行的环境操作**：

1. **卸载旧 bundle** —— `plugin_manager remove_bundle dsh-session-cleaner-clone`
   （从 profile `dependencies` 与 `dsh.profile.bundles` 中移除）。
2. **清理卸载残留** —— 删掉指向旧目录的孤立符号链接，
   以及 `cordis.patch.yml` 里遗留的 `- id: session-cleaner-clone` 两行。
3. **物理目录改名** —— `dsh-session-cleaner-clone/` → `dsh-dialogue-cleanup/`
   （Windows 下先删符号链接再改名，避免占用）。
4. **按新名重装** —— `plugin_manager install_bundle .../dsh-dialogue-cleanup`，
   profile 现在记为 `dsh-dialogue-cleanup = link:E:/Code/dsh-plugin-market/dsh-dialogue-cleanup`。

**仍未完成**：

- **需要重启宿主**。重装后行已出现（`include:dialogue-cleanup`），但
  `fiberPhase: null` —— 报 `dialogue-cleanup (dsh-dialogue-cleanup): failed to import`。
  已排查确认**不是代码问题**：从 profile 根 `import('dsh-dialogue-cleanup')` 成功
  （`name=dialogue-cleanup`、`apply` 是函数、`Config['~standard']` 存在），
  `createRequire(...).resolve()` 也正确指向新目录的 `lib/index.js`。
  这是运行中进程的模块注册表仍持有旧路径（旧符号链接已被删除）所致，
  与「换包名/换安装路径必须重启宿主」的既有结论一致。
- **审计文件不迁移** —— 新名对应 `logs/dialogue-cleanup.jsonl`；
  旧的 `logs/session-cleaner.jsonl`（实测 242 KB）保留为历史记录，不自动改名。

### 交付前修复的两类实测问题

修 **清单加载慢** 与 **删除逻辑有问题**。四处缺陷都先在 live 宿主上复现、再修、再补回归测试。

### 修复：删除（「删除逻辑有问题」）

- **批量删除必然被限流（头号缺陷）**。
  限流原按**条数**计费（删 50 条扣 50 个额度），而默认配额只有 10/分 ——
  于是「全选本页再删」这个最常见的操作**必然**失败。实测复现：

  | 请求 | 旧行为 |
  |---|---|
  | 批量 10 条 | `429 rate-limited` |
  | 批量 11 条 | `429 rate-limited` |
  | 批量 50 条（= 默认页大小） | `429 rate-limited` |
  | 批量 200 条 | `429 rate-limited` |

  改为**按请求计费**：一次批量请求扣 1 个额度；条数上限仍由 200 约束。
  默认配额从 10 提到 60。限流依然生效（回归测试断言第二次写请求仍会 429）。

- **面板批量删逐条发 N 个请求**。`doDelete` 原来是
  `for (const id of sessionIds) await requestDelete(id)` —— 勾选 50 行就是 50 个请求，
  叠加上面的按条数限流，用户看到的就是「删一半就全是失败」。
  现在走**一次**批量请求，Host 端逐条复用同一个 `deleteSession`（R-50），语义不变。
  失败的条目保留勾选便于重试，成功的自动清除。

- **`registryCleared` 是编造的数字**。`unpinSession` / `unarchiveSession` 对未记录的 id
  是**幂等 no-op**（契约原文 "resolves without writing"），旧实现却把「调用成功」
  当成「清掉了一条」，于是删除一个**根本不存在的会话**也会返回 `registryCleared: 2`。
  实测复现：`{"registryCleared":2,"files":0,"partial":true}`。
  现在如实返回 `{ attempted, resolved, changed: null, skipped }` —— `changed` 固定 null，
  因为公开 API 不报告是否真的写入，**不猜**。

### 修复：清单加载慢

根因是取标题：`sessionQuery.readTitleSnapshots` 要读并解压整份会话日志来折叠标题，
实测约 **65 ms/条**，且服务内部**串行**。所以耗时随页大小线性增长：

| pageSize | 修复前 | 修复后（冷缓存 / 热缓存） |
|---|---|---|
| 1 | 325 ms | ~325 ms |
| 10 | 1523 ms | — |
| 50 | **3292 ms** | **943 ms / 0 ms** |
| 100 | 5322 ms | — |
| 200 | 13113 ms | — |

（上表「修复后」是在同机、同成本模型下测量：50 条串行 3688 ms → 并发 4 冷缓存 943 ms →
同一实例第二次 0 ms，且两种路径标题结果**完全一致**。）

三重提速，都不牺牲正确性：

- **缓存**（`titleCacheTtlMs`，默认 5 分钟）：标题是会话日志里的历史事实，短期不变。
  翻页、筛选、刷新、删除后自动刷新全部命中缓存 → 即时返回。
  **负结果也缓存**（确实没有标题事件的会话），否则每次刷新都要为它重复付 65 ms。
  删除时按 sessionId 及其对偶拼写主动失效，避免删掉的行仍显示旧标题。
- **分片并发**（`titleFetchConcurrency`，默认 8）：把本页 id 均分成 c 片并行取，
  墙上时间从 N×65 ms 降到约 N/c×65 ms。
- **上限**（`titleLimit`，默认 100）：超大页只给前 N 行取标题，其余如实留空显示 id，
  而不是把请求拖到几十秒。`0` = 完全不取（最快路径）。

`/list` 响应新增 `titles` 与 `tookMs`，界面右下角据此显示
「942 ms · 标题 命中 0 / 新取 50」，让「为什么这次快」可见。

### 独立审计后的修复（第六轮）—— 含对我自己错误声明的更正

用户要求「检查代码质量 优化性能」后，我另外跑了一轮独立代码审计。
审计报出若干问题，我**逐条自己复现**后才动手 —— 不盲信报告，也不护自己的短。
下面按「已确认并修复 / 我原本写错了 / 报告有误」三类如实记录。

#### 一、已确认并修复

**H1 · 会话行菜单项完全没有样式（用户可见）**

`DeleteSessionMenuItem`（侧栏会话行「⋮」菜单里的「删除」项）**从不渲染样式表** ——
`<style>` 只在 `DeleteDialog` 与设置面板里渲染，而菜单项与它们**不共享 React 树**；
`DeleteDialog` 在无状态时又直接 `return null`。于是 `.dscc-menu-row` / `.dscc-sep`
等规则**从未生效**，菜单项一直是浏览器默认按钮样式。

取证方式：**真实渲染**菜单项，看标签序列 —— 修复前是
`div,button,svg,path,path,path,path,span`（**无 `style`**）。
修复后：`style,div,button,...`。已加断言并变异验证（去掉 `h(Styles, null)` → 测试失败）。

**M1 · `.dscc-panel-section` 是死规则**

`.dscc-panel-section`（0,1,0）与 `.dscc-panel`（0,1,0）同优先级，但**排在其前**，
于是 `.dscc-panel` 的 `height:100%` / `padding:20px 22px` / 背景全部胜出 ——
「设置页自适应高度」的意图从未生效。
取证：① 真浏览器 computed style（padding 实测 `20px 22px`、背景 `rgb(255,255,255)`）；
② 源码顺序比对。两路证据一致。改为 `.dscc-panel.dscc-panel-section`（0,2,0）。

**M2 · `.dscc-filters-search` 的 `width:auto` 是死规则 —— 这条是我自己写错的**

我在第三轮声称「实测修复：搜索框 width 交还给 auto」。**那是假的。**
该规则与 `.dscc-input { width: 100% }` 同为单类选择器（0,1,0），
而 `.dscc-input` **排在后面** ⇒ 同优先级比顺序，`100%` 胜出，`auto` 从未生效。
（当时症状没暴露，是因为 `flex:none` 恰好也没把按钮压扁 —— 属巧合，不是设计。）
改为 `.dscc-input.dscc-filters-search`（0,2,0）。
**这条更正写进了代码注释**，并新增「算级联胜出者」的断言 + 变异验证。

**H2 · 约 70 行死代码：内联 `doDelete`**

`const doDelete` 全文只有**它自己这一处**出现 —— 没有任何 onClick / effect 调用它。
它自带一套 `busy` / `result` state 与整段结果条，而面板真正走的是
「删除所选 → 打开确认弹窗 → `DeleteDialog.run()`」。后果：
`busy` 恒为 `null`（所有 `busy !== null` 的禁用条件是常量）、
`result` 恒为 `null`（结果条永远渲染 null）。已整段删除。

**M4 · 假进度分支**

`isBulk && state.total ? "处理中 {done}/{total}…"` 的 `state.total`/`state.done`
**从不被写入**。批量删除是**一次请求**，宿主整批处理，客户端拿不到中间进度 ——
硬凑「处理中 0/N…」是**数字永不动的假进度**。改为统一「正在删除」，如实反映真实过程。

**M3 · 安全承诺与实现不符（我写进注释却没实现）**

注释承诺「只承认既被勾选、又在当前页、**且当前可删除**的 id」，
代码却只查了可见性。后果：某行勾选时空闲、之后开始运行，刷新后它仍在当前页、
勾选仍有效，于是被提交进批量删除，宿主返回 `refused`，用户看到费解的「部分失败」。
现在按注释兑现：叠加 `deletableIdSet`，清理 effect 也同步收紧，并补 `deletableKey` 依赖
（否则「运行状态变了但可见 id 没变」时不会重跑清理）。

**两处可访问性（M6/L4）**
- 每行删除按钮补 `aria-label`（原先一屏全是同名的「删除」，屏幕阅读器无法区分）。
- 复选框标签的 `row.title ?? row.sessionId` 改为 `||`：标题为空字符串时会拼出「删除 」，与 1624 行的用法保持一致。

**一条假信心测试（审计点名）**
`client.test.mjs` 里「批量删除只发一次 requestDeleteMany」原本**锚在死代码 `doDelete` 上** ——
测试绿着，保护的却是永不执行的代码。已改为锚**真正执行的 `run()`**，
并区分「单条走 `requestDelete`（正确设计）/ 批量必须一次 `requestDeleteMany`」。
另加一条断言死代码不得复活。

#### 二、修复过程中的自我更正（必须记录）

1. **我在 CSS 注释里写反引号，连犯 5 次。** CSS 位于 JS 模板字符串内，
   一个反引号就提前终止模板串、整个 `client.js` 语法错误。
   第 4、5 次正是发生在本轮「解释另一个错误」的注释里。
   最终用脚本一次性扫描全文（CSS 块内反引号数必须为 0）才清干净。
   已有断言把关（带行号报错）。
2. **第一次变异测试我写错了**：替换只删了注释首行、没删掉 `h(Styles, null)`，
   得出「断言无效」的错误结论。修正锚点后确认三处断言**都有效**。
3. **一次路径拼写错误**（把 `dsh-dialogue-cleanup` 打成 `dsh-plugin-cleanup`），
   被工具拦下，未造成改动。

#### 三、审计中我判断**不成立/暂不改**的项

| 报告项 | 我的核对结论 |
|---|---|
| M5「`el.close()` 分支不可达」 | **成立但无害**：弹窗确实靠卸载关闭（`state===null` 时返回 null，元素移除即退出 top-layer）。删掉这个分支不是当务之急，留着是防御性代码；**本轮不改**，仅在注释里说明真实关闭路径 |
| M8「硬编码 `hint：`」 | 属实，但属文案打磨；`hint` 是给排障看的短标签，**暂不改** |
| M7「未映射错误码报成 internal」 | `method-not-allowed` / `cleanup-unavailable` 确实缺少文案键。**待办**，本轮未改以缩小改动面 |
| L1「22 个死文案键」 | 我未逐个复核，**暂不删**（删错会导致缺键；收益很低） |
| D1–D6 重复代码 | 属实，属重构范畴，**本轮不动**以降低回归风险 |

#### 四、验证

| 项 | 结果 |
|---|---|
| 单测（两份副本各跑一次） | **148/148**（147 → 148，新增死代码回归 1 条） |
| `node --check` | 11 个文件全过 |
| CSS 块内反引号 | **0** |
| 变异：还原 H1 | ✅ 被断言抓到 |
| 变异：还原 M1 | ✅ 被抓到 |
| 变异：还原 M2 | ✅ 被抓到 |
| 变异：加回 `doDelete` 死代码 | ✅ 被抓到 |
| 变异：批量退化成循环逐条请求 | ✅ 被抓到 |

> 关于断言层次的教训：本轮最大的收获不是修了 6 处缺陷，
> 而是发现**原有的 CSS 断言只检查「声明存在」**，因此两条从未生效的规则
> 也能让测试变绿。新增的 `cascadeWinner()` 按规范计算**真正胜出者**，
> 这才是能抓住此类问题的断言。

### 代码质量检查 + 性能优化（第五轮）

用户：「检查代码质量 优化性能」。原则是**先测量再动手** —— 只改有实测证据的问题，
不为了「看起来优化了」而改代码。

#### 一、性能：实测发现并修复的 3 处

**① 两份独立数据源原本串行 await（最大一处，省约 36–50 ms/请求）**

`listSessions` 里 `sessionQuery.listSessions()`（语料）与 `sessionController.list()`
（摘要）**互相独立** —— 后者不需要前者的结果，两者只是分别合并进同一张 rows 表。
旧实现是串行 `await`，于是摘要要等语料完全结束才开始。

实测（模拟语料 8 ms / 摘要 100 ms）：

| | 总耗时 | 第二次调用滞后 |
|---|---|---|
| 旧（串行） | 138 ms | 22 ms ← 纯白等 |
| 新（并行） | **126 ms** | 0 ms |

调用交错顺序实测：`corpus:start → summary:start → corpus:end → summary:end`
（摘要确实在语料结束**之前**就开始了）。改用 `Promise.all`，
两个分支各自保留独立 `try/catch`，**降级语义完全不变**。

**② 标题取数并发默认 4 → 8（首屏约 1.79×）**

`readTitleSnapshots` 实测约 65 ms/条且**组内串行**，是本插件唯一可观的 I/O。
实测不同并发下默认首屏（50 行）的墙上时间：

| 并发 | 1 | 2 | 4 | 8 | 12 | 16 |
|---|---|---|---|---|---|---|
| 50 行 | 3752 ms | 1906 ms | 970 ms | **540 ms** | 356 ms | 295 ms |

4 → 8 是 **1.8×**，8 → 16 边际收益递减却把瞬时并发翻倍，故取 8 为折中。
端到端复测（真实 65 ms/条 + 100 ms 摘要底噪，40 行）：884 ms → **495 ms（1.79×）**。

**③ 同一份 Map 被物化 3 次**

`Array.from(rows.values())` 在筛选、归档计数、子代理计数处各调一次，为同一份 Map
重复分配 3 个数组。改为物化一次 `allRows`，用单次 for 循环同时算出三个计数。
（Host 侧 CPU 本来就很小 —— 1000 行约 2 ms —— 所以这是**整洁性修复**，不是关键提速。）

#### 二、性能：实测后**决定不改**的 1 处（负结论）

`formatTime` 每行调用 2 次，每次 `new Date().toLocaleString()`，看上去是典型热点。
用 Edge 无头实际量了 200 行（400 次调用/渲染）：

| 方案 | 每次渲染 |
|---|---|
| 现状 `new Date().toLocaleString()` | 0.40 ms |
| 单例 `Intl.DateTimeFormat` | 0.40 ms |

**提速 1.00×，没有任何收益**，故保持原样。若不实测就「顺手优化」，
会白白引入一个全局格式化器（还要处理 locale 切换失效问题）却毫无收益。

#### 三、代码质量：检查过但确认无问题的项

| 检查项 | 结论 |
|---|---|
| TODO / FIXME / HACK / `@ts-ignore` | **0 处** |
| 运行时依赖 | **0 个**（`dependencies: {}`，零依赖自实现） |
| 死导出（33 个 export 全查） | 无 —— 每个都被 lib 或 test 引用 |
| 全局变量泄漏 | 无（初查的 30 处命中全是多行 `const`/`let` 的误报） |
| `fetchList` 网络异常处理 | 正确（`try/catch` → `network` 错误码，不会卡在 loading） |
| 客户端模块级监听器泄漏 | 无（`useReloadSignal` 的 `useEffect` 正确退订） |
| 限流器无界增长 | 无（固定窗口，不累计条目） |
| 标题缓存的容量控制 | 有（>5000 条时按 TTL×4 清理过期项） |

#### 四、顺手修掉的排版缺陷

`lib/service.js` 分页段有两条语句挤在同一行（`const total = items.length;    const pageSizeRaw = ...`），
已拆开。

#### 五、新增 2 条性能回归断言 + 变异验证

**断言的是调用交错顺序，不是墙钟时间** —— 避免在慢 CI 上因调度抖动误报：

1. **并行性**：断言 `summary:start` 出现在 `corpus:end` **之前**（两者确实重叠）。
2. **降级不变**：语料抛错时请求仍成功、`sources.corpus === "none"`、摘要仍生效。

变异测试确认两条断言都可达：

| 变异 | 结果 |
|---|---|
| 把 `Promise.all` 改回串行 `await` | ✅ 被「并行」断言抓到 |
| 语料失败时不再降级（rethrow） | ✅ 被抓到（5 条失败） |

测试总数 145 → **147**。

### 调研：设置页导航图标（齿轮）为什么改不了 —— 已确认无扩展点，决定不改

用户看到设置页左侧「对话清理」前的**齿轮**图标，要求换成小扫把。

**结论：官方没有提供任何图标扩展点，故不改。** 以下为实证过程，避免以后重复排查。

**根因**：图标不是插件注册的，而是官方 `@deepseek-ai/dsh-client-ui-settings-general`
里**硬编码**的一张 id→图标表：

```js
/** Nav glyph by section id; unknown ids fall back to the settings gear. */
function navIcon(id) {
  if (id === "account")           return IconUserOutlineMedium;
  if (id === "models")            return IconDataOutlineMedium;
  if (id === "agent-presets")     return IconAgentPresetOutlineMedium;
  if (id === "plugins")           return IconPersonalizationOutlineMedium;
  if (id === "archived-sessions") return IconArchiveOutlineMedium;
  return IconSettingsOutlineMedium;   // ← 本插件 id 不在表里，落到这里
}
```

**三项核对，均确认无扩展点**（取证方式：用自写的 asar 读取器解出官方
`lib/client.js`，并交叉核对 `cordis_inspect_query` 的 Slot 契约）：

| 检查项 | 结果 |
|---|---|
| `settings.section` 注册选项（官方 Slot catalog） | **只有 `id` / `order` / `label`**，无 `icon` |
| 全部 98 个 Slot 契约里与 icon/glyph 相关的槽 | **没有任何**一个能提供设置页导航图标 |
| 导航行 DOM（官方 JSX） | `<button class=navCell>{navIcon(row.id)}<span>{label}</span></button>`，**无 `data-*` 锚点** |

**被否掉的三个替代方案**（记录取舍理由）：

1. **CSS 伪元素 + 位置选择器**替换齿轮：可行，但依赖导航行的**序号**；
   官方新增/移除设置页时序号变化，扫把会错位到别的行。为一处装饰性需求
   引入这种脆弱性不划算。
2. **借用官方 id（如 `archived-sessions`）**：能命中官方图标表拿到「归档」图标，
   但会与非本项目语义的 id 绑定，且 id 同时决定导航语义，副作用大于收益。
3. **保持齿轮**：官方设计如此 —— 未知插件统一给齿轮。零脆弱性、零误解。
   已与用户确认，**采纳此项，代码不改**。

### 变更：归档筛选默认改为「显示已归档」

用户：「归档那一栏默认显示已归档」。

**这是一处刻意偏离官方默认的改动**，理由写在代码注释里：

- 官方侧栏默认 `archivedFilter: 'default'`（隐藏已归档）；
- 本插件默认改为 `'show'`（全部对话 / 显示已归档）。

原因：**归档 ≠ 删除**。归档会话仍完整占着磁盘，恰恰是清理工具要处理的对象。
沿用官方默认会让用户看不到本该能清理的会话，还得先手动切一下下拉。

归档行仍带 `archived: true`，UI 打「已归档」徽标，与普通会话可区分，不会误删。

**改动面（两处默认值必须同步，否则会出现「界面切了接口没切」）**：

| 位置 | 改动 |
|---|---|
| `client.js` `useState` 初值 | `archived: "default"` → `"show"` |
| `lib/service.js` 请求缺省兜底 | `… ? request.archived : "default"` → `: "show"` |
| `client.js` 空态「切回」按钮 | 由 `default`+`隐藏已归档` 改为 `show`+`全部对话`（否则点一下会跳进「隐藏已归档」） |

**新增防偏差断言**（`test/contract.test.mjs`）：
从两端源码里读出默认值并断言相等 —— 这两个值分散在两个文件，
改一处忘另一处时表现是「首次加载正常、手动切换后回不去」这类只在特定路径复现的偏差。

**变异测试验证有效性**（修正过一次自己的断言）：

| 变异 | 结果 |
|---|---|
| 客户端 `default` / 服务端 `show` | ✅ 被该断言抓到 |
| 客户端 `show` / 服务端 `default` | ✅ 被该断言抓到 |

> 第一版断言写错了：我用 `svcLine.includes('"show"')` 判断服务端兜底，
> 但三元表达式里 `request?.archived === "show" ? … : "default"` 这行**本身就含 `"show"`**，
> 于是变异 B 溜过去了。改为取「最后一段冒号之后」的兜底值才正确 ——
> 这正是变异测试的价值：它抓出了断言本身的漏洞。

新增 2 条断言（默认纳入归档 + 两端默认值一致），测试总数 143 → **145**。

### 修复：标签改成中文表单的「分散对齐」（第四轮）

用户给了一张参考图：「班级」两个字被拉开到与「指导教师」等宽，并说明「字体对齐是这样的」。

**我上一轮理解错了。** 我做的是**左对齐** —— 所有标签左边缘齐，但 2 字标签右边空一大块，
观感上仍然「没对齐」。中文表单的惯例（也就是参考图的做法）是**两端顶格**：
字数少的标签把字间距摊开，占满与最长标签相同的宽度。

**改法**：

```css
.dscc-filters-grid { grid-template-columns: 48px 152px 48px 152px; }
.dscc-field-label {
  width: 100%;                    /* 占满定宽列，否则撑不开 */
  text-align: justify;
  text-align-last: justify;       /* ★ 关键，见下 */
  white-space: nowrap;
}
```

标签列宽 68px → **48px**（= 最长标签「会话类型」4 字 × 12px）。

**`text-align-last` 是必需的**：标签只有一行，而 `text-align: justify`
默认**不作用于最后一行** —— 单行文本「全是最后一行」，不加它 `justify` 完全不生效。

### 这次终于做了**真实渲染验证**（此前一直是结构断言）

发现本机有 Edge，于是用 `--headless=new` 起真实 Blink 渲染，从 `client.js`
**直接抽取 CSS**（不手抄，避免测量对象与实现不一致）后量几何：

| 标签 | 字数 | 标签列宽 | 墨迹宽 |
|---|---|---|---|
| 项目 | 2 | 48px | **48px** |
| 状态 | 2 | 48px | **48px** |
| 会话类型 | 4 | 48px | 64px→**48px** |
| 归档 | 2 | 48px | **48px** |
| 排序 | 2 | 48px | **48px** |

2 字标签墨迹 32px → **48px**，与 4 字标签一致；10/10 断言通过；
并生成了截图目视确认（「项　目」「状　态」「归　档」「排　序」两端顶格）。

### 顺带抓到一个我自己反复犯的错误

首次测量时 7 条断言**全挂**，探针自检显示 `display: block`、字号 `16px` ——
CSS **根本没被解析**。定位到原因：我在 CSS 注释里写了 Markdown 行内代码的**反引号**
（`` `text-align: justify` ``），而 CSS 放在 JS 模板字符串里 ——
**一个反引号就提前终止了模板串**，整个 `client.js` 语法错误。

这是我第三次犯同一个错（前两次在布局返工和 `nowrap` 修复时）。
前两次只留下一个指向注释里普通单词的 `SyntaxError`，很难定位。
这次加了**带行号的断言**：

```js
css.split("\n").forEach((line, i) => {
  if (line.includes("`")) assert.fail(`CSS 第 ${i + 1} 行含反引号（会提前终止模板串）：...`);
});
```

已用变异测试确认可达：注入反引号后报
`CSS 第 182 行含反引号（会提前终止模板串）：注意 \`white-space\` 的用法。`

### 修复：字宽与按钮被压扁（第三轮，照截图逐条修）

用户第三次截图反馈「字宽统一一下 比例项 目 状 态改成和对话类型等宽吧」。
截图暴露了两个**具体到可复现**的缺陷：

**① 「刷新」被压成竖排「刷／新」**

根因是两层叠加：
- `.dscc-input` 是通用规则，带 `width: 100%`（用于网格里占满整列的控件）；
  它被放进 flex 行做搜索框时**独占整行**，把按钮挤到 `min-content`。
- 而中文可在**任意字符**处断行，`min-content` 就是**一个字宽** —— 于是「刷新」竖排。

修法：搜索框在 flex 行里显式 `width: auto`（宽度交给 flex 分配），
按钮 `flex: none` + `white-space: nowrap`（不许收缩、不许断行）。
`white-space: nowrap` 加在 `.dscc-btn` 基类上，所有按钮统一受益。

**② 标签左边界参差**

「项目／状态／排序」是 2 字，「会话类型」是 4 字；原来右对齐 ⇒ **右边缘对齐、
左边缘参差**。改为**左对齐**，所有标签共享同一左边界。
控件列宽从 150px 微调到 152px，容下「隐藏已归档」不折行。

**顺带纠正一条我自己写错的测试**：上一轮我加了一条
「CSS 模板串内不得有裸反引号」的断言 —— 但它**不可达**：
真混进裸反引号时整个文件语法错误，**所有**测试一起失败，
那条断言根本没机会执行（实测确认：注入后 188 个反引号、全量测试崩掉）。
已替换为**真正可达**的「CSS 括号配平 + 关键规则齐备」断言 ——
一个多余的 `}` 会静默吞掉其后所有规则，`node --check` **抓不到**，
只有这条能抓（已用变异验证：注入 `}` → `node --check` 通过、断言失败）。

新增/修正回归：按钮 `nowrap`、刷新按钮 `flex:none`、搜索框 `width:auto`、
标签左对齐。变异测试：
- 按钮去掉 `nowrap` → 1 条失败；
- 标签改回右对齐 → 1 条失败；
- CSS 注入多余 `}` → 1 条失败（且 `node --check` 通过，证明断言不可替代）。

### 修复：布局太乱（第二轮，照原项目重做）

用户第二次反馈「还是乱啊 你参考原项目」。第一轮只是把「一行控件」拆成两行，
**根子没解决**：我用 `flex-wrap` 排「标签 + 下拉」，每个下拉按内容自适应宽度，
于是每一行的标签起点、下拉宽度都不一样 —— flex-wrap 天然产生这种参差，调 gap 治不好。

**改法：照原项目（`@haoranwang0921/dsh-session-cleaner`）的克制结构重做。**

- **筛选区 → CSS Grid 定列**：`grid-template-columns: 68px 150px 68px 150px`。
  标签列**也定宽**（用 `auto` 时左右两组标签宽度各不相同 —— 「会话类型」比「项目」宽 ——
  下拉起点就会错开）。字段用 `<label class="dscc-field">` 包住，该 label 设
  `display: contents`，于是它的两个子节点直接成为网格项：**既有严格对齐，
  又保留「点标签聚焦控件」的原生语义**，且不必重建元素（重建易丢 children）。
- **列表 → 卡片式行**（照原项目 `sessdel-row` 的做法）：
  每行 = `勾选框 + 主内容列 + 右侧固定区`。原来的 6 列表格要所有列同时对齐，
  列宽/换行/省略号互相牵制，一变窄就「逐字符换行」「标签乱飘」；
  卡片行各行的内部结构独立，天然不会错位。

  - `.dscc-row-main { min-width: 0 }` —— **省略号生效的前提**（漏了 `ellipsis` 白设）
  - `.dscc-row-side { flex: none }` —— 右侧徽标/操作不被压缩
  - `.dscc-row-badge { width: 62px }` —— 徽标定宽，各行位置一致
  - 标题/元信息单行省略，完整值放 `title` 悬停可见
  - 元信息合并为 `id · 项目 · 时间`，比原来分三列更省横向空间

**同时升级了渲染测试替身**（这是能验证布局的前提）：旧替身 `beginRender()` 会
**清空整个 hook store**，而且**从不执行 effect** —— 于是「异步取数后重渲染看到列表」
这类行为根本无法测试，所有行级断言只能测到空态。现在：
`beginRender()` 保留 hooks 值（state 跨渲染存活，对齐 React 语义），
并新增 `flushEffects()`（带 deps 浅比较）真正执行 effect。

新增 2 条布局回归 + 1 条 CSS 契约测试，并用**变异测试**验证有效性：
- 标签列改回 `auto`（对齐失效）→ 1 条失败；
- 主内容列去掉 `min-width: 0`（省略号失效）→ 1 条失败。

### 修复：会话清单逻辑错了（「会话逻辑也不对」）

**根因**：官方 README 明确规定

> 「**侧边栏隐藏持久化摘要中带有 `origin: 'subagent'` 的行。**」

依据：`SessionHeader { … origin?: 'subagent'; delegationDepth?: number; parentSession?: SessionId }`。
旧实现把 `sessionQuery.listSessions()` 返回的**全部**记录直接列出来，
于是子代理（subagent / teammate）会话混进了普通清单。

**用真实数据量化这个缺陷**（读本机全部会话 header 得出，不是估计）：

| 本机真实会话 | 数量 |
|---|---|
| 磁盘总数 | **40** |
| `origin === 'subagent'` | **19（47.5%）** |
| 真正的主会话 | **21** |

也就是说：面板显示的 39 条里有近一半是「You are doing a READ-ONLY…」
「You are doing an adversarial…」这类子代理会话 —— 与侧栏看到的完全对不上。

**修法**：新增「会话类型」三选一（`kind`），**默认值与官方一致**：

| 取值 | 含义 |
|---|---|
| `main`（**默认**） | 只显示主会话 —— 与官方侧栏一致 |
| `subagent` | 只看子代理会话 |
| `all` | 全部（含子代理） |

`main` / `subagent` 是本插件**特有**的（官方侧栏根本不给这个入口，
它一律隐藏）—— 因为子代理会话同样占磁盘、同样可能想清理，
而「批量清理子代理会话」正是本插件的用途之一。完全隐藏会让这批数据无法清理。

同时：
- 行徽标显示「子代理」（warn 令牌），一旦它们出现在列表里就明确标出身份；
- 响应回传 `kind.subagentTotal` / `mainTotal`，界面可如实告知默认隐藏了多少行，
  避免用户误以为会话丢了；
- **子代理会话照常可删除**（可见性 ≠ 不可删），已加断言锁定。

新增 5 条回归，并用**变异测试**验证有效性：
- `main` 不再隐藏子代理 → 1 条失败。

### 新增：归档分类（「分类里面加一个已归档的」）

照**官方 harness** 的归档设计做（`dsh-client-ui-workspace`），不自创口径：

- **数据来源（实测取证，不是猜）**：归档状态**不在** `SessionSummary` 里 ——
  该类型的字段只有 `agentAvailable / sessionId / updatedAt / running / blank /
  parentSessionId / origin / cwd / projections`，**没有 `archived`**；
  `workspaceRegistry` 的公开面（create/list/get/delete/insertBefore/
  archiveSession/unarchiveSession/pin/unpin/resolveByPath）也**没有**集合读取器。
  官方把它放在 **workspace 存储领域的全局状态**里：
  「注册表打开 `workspace` 领域（版本 2）：…加上一个持有 `workspaceIds`、
  **`archivedSessionIds`**、`pinnedSessionIds`…的全局状态」。
  客户端从 `useWorkspaces(state => state.archivedSessionIds)` 拿它；
  本插件是 Host 半，走同一份数据的 Host 入口
  `storageDomain.get("workspace").global`。
  **不能** `open("workspace")` —— 领域已被 dsh-workspace 打开，重复 open 会抛 `already-open`。
- **三选一筛选，取值与文案都照官方**（官方原文：「以一组显式三选一控制显隐」）：

  | 取值 | 中文 | 英文 |
  |---|---|---|
  | `default`（**默认**） | 隐藏已归档 | Hide archived |
  | `show` | 全部对话（显示已归档） | All conversations (show archived) |
  | `only` | 仅显示已归档 | Archived only |

- **行徽标**：归档行显示「已归档」徽标，样式用 `--dsw-alias-state-idle-primary`
  令牌（次要色），与官方侧栏「归档行置灰」的观感一致。
- **归档行仍可删除**：归档只是从侧栏隐藏、数据仍在磁盘上，**删除才是真正的销毁**。
  面板里对此有明确提示（`panel.archivedHint`）。
- **「仅显示已归档」空结果**有专属文案 + 一键切回（照官方
  `empty.noneArchived` + 「查看其他会话」）。
- **诚实降级**：`storageDomain` 不可读时（领域未打开 / 结构变化）如实返回
  `known:false`，**不把「不可知」谎报成「没有归档」**，也**不隐藏任何行**
  （否则用户会看不到任何会话）。

新增 6 条归档回归 + 1 条渲染回归，并用**变异测试**验证有效性：
- `default` 不再隐藏归档 → 1 条失败；
- 不可知却谎报 `known:true` → 1 条失败。

### 修复：两个 UI 缺陷（「移上去就消失」+「弹出不置顶」）

**① 鼠标移到「删除所选」上文字消失（CSS 优先级缺陷）**

实测算出优先级：

| 规则 | 优先级 | 声明 |
|---|---|---|
| `.dscc-btn:hover` | **(0,2,0)** | `background: --dsw-alias-bg-layer-2`（浅色面） |
| `.dscc-btn-danger` / `.dscc-btn-primary` | **(0,1,0)** | `color: --dsw-alias-bg-base`（文字＝应用底色） |

hover 的 (0,2,0) **压过**变体的 (0,1,0) 实心背景，但文字色仍是变体声明的
「应用底色」⇒ 浅色面 + 底色文字 = 对比度≈0，鼠标一移上去文字就看不见了。

修法：把换底**限定在中性按钮**（`:not(.dscc-btn-primary):not(.dscc-btn-danger)`），
变体按钮改用 `filter: brightness()` 微调 —— 文字与背景同时等比变化，对比度保持。

**② 确认框弹出后不置顶**

旧实现只靠 `position: fixed; inset: 0`，**没有 z-index、也没有进 top layer**；
而本插件从**设置页**打开，设置面板本身是高层级浮层，于是普通定位元素盖不过它。

官方 `Modal` 的做法是 `createPortal` 到 `document.body` 逃出祖先层叠上下文，
但 practices.md §36 **明确禁止**把 DOM 挂到组件外／`document.body`。
因此改用 **原生 `<dialog>` + `showModal()`**：它进入浏览器 **top layer**，
层级高于**任何** z-index 与祖先层叠上下文，**不需要 portal，也不用猜宿主层级**。

顺带修掉两个可访问性缺陷：原生对话框自带焦点陷阱与 Esc 语义，
原先「Esc 事件泄漏给宿主」和「Tab 能走到背后页面」都随之消失。

**同时纠正一处自查引入的错误**：改用原生 `<dialog>` 后它已隐含 `role="dialog"`，
而内层卡片仍声明 `role="dialog"`/`aria-modal` ⇒ 形成**嵌套 dialog**（屏幕阅读器读成两层模态）。
现在语义只挂在外层，内层卡片不再重复声明。

**另一个实测约束**：官方 `Builtin` 文档给 Client 的 React 只保证
`createElement` / `useState` / `useEffect` —— **没有 `useRef`**。
所以对话框的 ref 用 `useState` 的惰性初始值获取（求值一次、身份跨渲染稳定），
不再依赖未文档化的 `useRef`。

新增 2 条回归测试（hover 优先级、`<dialog>` + 无嵌套 role），并用**变异测试**验证有效性：
- 恢复裸 `.dscc-btn:hover` 换底 → 1 条失败；
- 退回普通 `div`（不进 top layer）→ 1 条失败；
- 内层卡片重新声明 `role` → 1 条失败。

### 修复：语言不跟随官方 harness 本体（「语言跟随官方 harness 本体」）

**权威路径的依据**（官方 `@deepseek-ai/dsh-client-locale` README 实现小节原文）：

> 「一个 `LocaleRuntime` 同时拥有偏好与字典注册表，并且**自身就是 slot 系统的 `LocaleFace`**：
> `getSnapshot`／`subscribe` 支撑**框架注入的 `t` 席位**。」
> 「产品编写的 Client UI 文本**必须来自这些带类型的字典**，或来自已经本地化的 primitive prop。」

以及偏好解析：

> 「临时 locale 来自浏览器…**一直站到宿主（Host）支持的设置作用域送达其存储的偏好为止**。」

据此确立**权威优先级**（不再自创口径）：

1. **框架注入的 `t` 席位**（`props.t`）—— LocaleFace 直接驱动，最权威；
2. `ctx.locale.bind(ns)` —— 同一个运行时，用于拿不到 props 的模块级场景
   （如 `settings.section` 的 `label` thunk）；
3. 内置兜底表 —— 仅当 1、2 都不可用时接管。

**修掉的三个具体缺陷**：

1. **读错了快照字段**（根因）。官方契约是
   `LocaleSnapshot { active; locales; revision }`，而旧代码读的是
   `snapshot?.id ?? snapshot?.locale ?? snapshot?.language` —— 三个字段**一个都不存在**，
   于是永远拿到 `undefined`，静默退到 `navigator.language`：
   界面语言跟着**浏览器**走，而不是跟着 harness 本体走。
   现在只认 `active`；取不到就如实返回 null，由调用方降级。
2. **绕过了框架注入的 `t` 席位**。确认框与设置页面板都直接调内置表 `tt()`，
   等于把官方唯一的权威翻译通道降级成了最后的兜底。
   现在两处都走 `makeTranslator(props?.t)`，按上面的优先级解析。
3. **`props` 没有转发**。`DialogueCleanupSection` 收不到参数也不往下传，
   即使框架真的注入了 `t` 也到不了面板。现在如实转发
   （`{ ...props, variant: "section" }`）。

**如实说明一处实测结论**：`settings.section` 的 ownerProps **只有 `{ close }`**，
`shell.overlay` 的 ownerProps **为空**；两者的 standardProps 都**没有 `t`**。
所以当前实际生效的是第 2 级（` locale.bind(ns)`）—— 它同样由官方 LocaleFace 驱动，
语言切换会实时跟随。第 1 级已按官方口径写好在位，框架一旦注入即自动启用，无需再改。

补了 9 条渲染 + 7 条语言回归测试（含「优先用注入的 t 席位」与「缺席时退到 bind」），
并用**变异测试**验证有效性：
- 把 `readActiveLocale` 退回旧的 `id/locale/language` 写法 → 4 条失败；
- 去掉 `props` 转发 → 「优先用注入的 t 席位」立刻失败。

### 自查代码质量（本轮额外发现并修复）

- **批量删除的探测是 O(N) 次全量列表调用**（性能缺陷）。
  批量逐条调 `deleteSession`，每条都要问一次 `sessionController.list()` 与
  `sessions.list()`。实测探测次数：

  | 批量条数 | `sessionController.list()` 次数 |
  |---|---|
  | 1 | 1 |
  | 50 | 50 |
  | 200 | **200** |

  纯探测 200 条 165 ms；live 上 `list()` 有约 100 ms 底噪，折算约 **20 s**。
  新增 `runningProbeTtlMs`（默认 1000）：TTL 内复用同一份快照，批量摊成 **O(1)** 次。
  修后实测 200 条仍然只探测 **1** 次；设 `0` 可退回「每条都重探」的严格语义。
  代价已如实写进代码注释：TTL 窗口内刚开始运行的会话可能不被拦下（窗口默认 1 s）。

- **只缓存运行状态，不缓存 live id 集合**（自查时纠正的自身风险）。
  live id 集合喂给 `isKnownSession` **破坏性守卫**（决定要不要删「另一种拼写」）。
  缓存它会让守卫更可能说 false，也就是更可能删掉一个其实存在的会话 ——
  方向正好违背「宁可不删，不可误删」。而 `sessions.list()` 是同步内存读取、
  省它收益极小。故**不缓存**，并加测试锁定这一取舍。

- **多选可删除用户看不见的行**（安全缺陷）。
  `selected` 原本跨页/跨筛选累积：在「可删除」下勾 20 行 → 切筛选后那些行不再显示，
  但工具条仍写着「删除所选（20）」，点下去会删掉**看不见的会话**，用户无法复核。
  现在只承认「既被勾选、又在当前页」的 id，提交前取可见集合交集；
  视图变化后真正清理 state，并明确提示有多少勾选被忽略。

- **新增真实渲染测试**（见验收报告 §3）。此前所有测试只验证「注册面」，
  **从不渲染组件** —— 组件体里的未定义变量、条件 hook 调用等只有用户打开设置页才会炸。
  新增 `test/render.test.mjs`，用极小 React 替身 + 递归渲染器真实执行组件；
  已用注入故障验证它确实能抓到这类 bug。

### 其他

- `clearRegistryRecords` 返回值形状变更（见上），属**破坏性**变更；
  该字段只出现在 `/delete` 响应与审计里，UI 已同步。
- 新增配置：`runningProbeTtlMs`。合计 **15** 个可调项。
- 单测共 **147** 条（含 12 条渲染测试、7 条语言回归、2 条 UI 缺陷回归、7 条归档回归、5 条子代理可见性回归、2 条布局回归、1 条 CSS 结构回归、2 条性能回归）。

### 能力（与 `dsh-session-cleaner@1.0.2` 等价的部分）

- 一次删除三处：内存 live 条目、工作区记录、磁盘工件目录。
- 正在运行的会话一律拒绝（409 `refused`）。
- 会话行 `...` 菜单入口 + 主题化二次确认框。
- **批量管理面板**（挂在设置页 `settings.section`，`order: 25`）：完整语料列表、
  一次调用批量取当前页标题、关键词/项目/状态筛选、排序、分页、勾选批量删除。
- 不因同名标题而丢失入口（上游同名时直接不显示按钮）。

### 新增：批量管理面板（相对上游的能力增强）

上游只能逐行删（而且同名标题直接不显示按钮）。本次新增设置页里的管理面板：

- 列表数据源合并 `sessionQuery.listSessions()`（完整逻辑语料，含非活动/已归档）
  与 `sessionController.list()`（唯一公开的 `running`/`blank`/`updatedAt`）。
- 标题用 `sessionQuery.readTitleSnapshots(ids)` 只对**当前页**取，带缓存与分片并发。
- `/delete` 支持 `{ sessionIds: [...] }` 批量（上限 200），逐条复用**同一个**
  `deleteSession`（R-50），单条失败不影响其余；限流按**请求**计费（一次批量算一次）。
- 运行中的会话不可勾选（Host 判定 `deletable`，UI 不猜）；
  「全选」= 全选本页可删除项。
- 因为面板直接作为设置页 section 渲染，**不需要 `layout` 服务**
  （此前放在 main/sidebar 需要 `ctx.layout.selectPanel`）。

### 相对上游的修正

- **形态合规**：UI 改为官方 slot（`sidebar.workspaces.session.menu.item` +
  `shell.overlay`），不再使用 `MutationObserver` / `appendChild` / 读宿主 DOM。
  上游 client.js 约 160 行的「菜单归属 + 标题反查 id」全部消失。
- **不 `require('@deepseek-ai/dsh-client-ui-primitives')`**（R-23 明文禁止）——
  自绘菜单行与按钮，样式只引用 `Theme.listTokens` 全表内的 `--dsw-alias-*` 令牌。
- **不碰 Cordis private `fiber._unload()`**；`sessions.store` 仅作降级路径并如实上报。
- **HTTP 状态码写对**（上游全部返回 200）。
- **新增同源/CSRF 校验**（上游完全没有）。
- **读体上限 64 KiB + 10 s 超时**（上游 1 MiB 且无超时）。
- **新增 Config**（上游阈值全硬编码）。
- **新增并发单飞**（上游并发时计数虚高）。
- **修正工作区计数虚高**（只在 `detachSession` 真正成功时 +1）。
- **新增 JSONL 审计**（上游没有）。
- **新增 147 条单测**（上游 0 条）。
- **路径安全加码**：`isInside` 二次校验、符号链接拒绝、返回被删路径清单。
- **处理磁盘上两种 id 拼写并存**：对偶拼写 + 存在性守卫（宁可不删，不可误删）。
- **新增投影缓存清理**。

### 核实后修正的假设（附录 C.12 回填）

- `@deepseek-ai/dsh-client-runtime` **不存在** → 从 `dsh.client.inject` 移除。
- `--dsw-alias-danger` / `-interactive-bg-hover` / `-hairline` **都不存在** → 改用全表内令牌。
- `sessions` **没有**公开 `detach`；`Agent` **没有** `status`/`ctx`；
  空闲 agent **没有**公开停止入口 → 全部改为如实降级，不再假设。
- `webServer.register` 对重复 `(kind, path)` **抛错** → 用 `ctx.effect` 包裹并返回 disposer。
