# 变更记录

## Unreleased

### 修复：投影缓存根位置是普通文件时，把「本来就没有缓存」报成了降级

`removeProjectionCache` 删单个缓存条目前要 `lstat` 一次，用来区分「条目不存在」与
「没删掉」。原来只认 `ENOENT` 算「不存在」，**但同一个场景在两个平台上报的错不一样**：

| 平台 | 投影缓存根是一张普通文件时 `lstat(<根>/<id>.json)` 的错误码 |
|---|---|
| Windows | `ENOENT` |
| Linux | `ENOTDIR` |

于是 Linux 上删除会话时会多出一条 `projectionCache` 降级，`complete` 变 `false`、
`partial` 变 `true`，界面显示「部分完成」—— 可实际上**根本就没有缓存可删**，主结论
（会话确实被删掉）一点没受影响。这属于把 `absent` 报成 `failed`。

**修法**：`ENOENT` 与 `ENOTDIR` 都归为「这个条目不存在」，其余错误码
（`EACCES` / `EPERM` / `EIO` …）照旧如实记入 `failures` 并触发降级。
回归测试 `test/transaction-boundary.test.mjs`「事务边界：投影缓存根路径异常 —— 视为
『没有缓存』，不得抛错也不得伪造降级」现在在两个平台上语义一致（此前只在 Windows 绿）。

### 修复：测试与变异脚本在 Linux 上假红 / 变异退化成装饰品

- `test/project-identity.test.mjs` 里两条断言 Windows 路径归一规则的用例**没有显式传
  `platform`**，于是在 Linux CI 上按 POSIX 规则跑、必然红（`'E:\\Code\\Proj'` 与
  `'e:/code/proj'` 在 POSIX 上确实是两个项目）。改成显式钉死 `win32`，与旁边
  「非 Windows 下大小写敏感」那条用例的做法一致。
- `test/mutate-tokens-official.mjs` 的 G8 / G9 两条变异还锚定着旧的两态写法
  `row.title ? null : h(...)`；会话 id 改成 `showRowId` 三态后**原文未命中**，直接
  `SKIP` 并被计入 `survived`，CI 的「survived 必须为 0」闸门因此一直红。重新锚定到
  `showRowId(row, t) ? h(...) : null`，两个方向（一律显示 id / 一律不显示 id）都重新
  能咬住。变异测试现为 `killed 71 / survived 0`。

## 1.2.0

这一版把「列表里几处说不清的空状态」一次说清楚，并新增 5 个查询能力。全部改动向后兼容：
没有删除任何既有字段、参数或端点，旧客户端照常工作。

### 新功能：标题四态 / 会话分类三态 / 空会话筛选

| 新增 | 说明 |
|---|---|
| `items[].titleState` | 每行标题的四态：`ready`（有标题）/ `blank`（空会话，从未有消息）/ `empty`（宿主确认没有标题记录）/ `unread`（非空但本次没读到）。四态两两可区分，**「本来没有标题」不再和「本次没读到」长得一样**。 |
| `items[].classification` | 会话身份三态 `main` / `subagent` / `unknown`，另带 `classificationSource`（`corpus` / `summary` / `corpus+summary`）。身份未知的会话**不再被默认当成主会话**。 |
| `kind=unknown` | `/list` 的 `kind` 过滤放行第四个取值（GET 与 POST 共用同一份白名单）；面板新增「会话类型」四选一与「未知」徽标。 |
| `blank` 三选一 | `/list?blank=hide\|show\|only`，默认 `hide` —— 空会话默认不再占满首屏。 |
| `blank.hiddenInView` | 本次视图**实际**藏掉的空会话条数（已扣除 project / kind / archived / running 等其它筛选），区别于全库口径的 `blank.total`。 |

另外：项目身份字段统一为「`cwd` 权威、workspace.path 只作兜底」，`item.project`、项目下拉选项、
项目筛选三处同源；workspace 多方认领时改为「首个声明者胜」。

### 修复：空会话提示条与下拉框重复 —— 同一件事在一屏里说了两遍

默认视图的列表上方曾有一条常驻横条「已隐藏 N 条空会话（从未有消息的会话）。」配一个
「仅显示空会话」按钮。但**筛选行里的空会话下拉本身就在说「隐藏空会话」**，横条只是把
同一个状态再说一遍；横条里的按钮又与下拉的第三项「仅显示空会话」完全等价。同一屏里
两处出口、两条相同的话，还额外占掉一行高度（用户 2026-10-25 指出「不是重复显示了？」）。

**修法**：删掉整条横条，把条数并进下拉框**自己的选中文字**：

- 选中 `hide` 档且本视图确实藏了会话时，药丸显示「隐藏空会话（N 条）」；
- 藏了 0 条时退回「隐藏空会话」，不显示一个「（0 条）」的空括号；
- 另两档不带条数（条数只属于 `hide` 档）。

信息一点没少（仍然是 `hiddenInView` 那个「本视图藏了多少」的数字，不是全库口径），
但只剩一处出口。顺带删掉三条因此变成死键的 i18n 条目：`panel.blank`、`panel.blankRow`、
`panel.blankHiddenNotice`。

**新增回归测试**：`test/render.test.mjs` 的
「空会话条数并进下拉选中文字，不得再另起一条重复的提示横条」——只认渲染出的文字：
必须出现 `7 条`（`hiddenInView`）、**不得出现 `13 条`**（全库 `total`）、条数必须落在
空会话下拉字段内、整屏**不得再出现「已隐藏」**这个横条措辞。已验证该用例在修复前的
代码上失败、修复后通过。

### 修复：「已隐藏 N 条空会话」在带筛选的视图里多报

`blank.total` 是**全库**口径（与 `archived.total` 同构），回答的是「库里一共有多少条
空会话」。但界面那句提示说的是「**你这个视图**里刚才消失了多少条」。两者在
`kind=all` 下恰好相等，一加 `kind` / `project` 筛选就分叉：

- 真机实测 `kind=main&blank=hide` → 返回 `total=8`、`blank.total=13`，而同一视图
  在 `blank=show` 下只有 **12** 条空会话行 —— **提示条多报 1 条**（第 13 条是子代理
  空会话，本来就被 `kind=main` 滤掉了，从来没出现在这个视图里）；
- `project=E:\AI\DeepSeek Harness\tmp` 时同样：`blank.total` 仍是全库 13，实际本视图
  只藏了 7 条。

数字偏大看着不严重，但它是在**告诉用户「刚才消失了什么」**——报多了等于谎报，而这一整
轮修复的起点正是「界面说的话和事实对不上」。

**修法**：在空会话筛选处（其它筛选全部生效之后、空会话筛选之前）统计本视图实际藏掉的
条数，返回体扩展为 `blank: { filter, total, hiddenInView }`：

- `total` —— 全库口径，语义不变，仍供「库里一共多少条」这类判断；
- `hiddenInView` —— 本次这个视图实际藏掉的条数（已扣除 kind / project / archived /
  running 等筛选）。仅 `filter === 'hide'` 时非零；`show` / `only` 恒为 `0`。

客户端取 `hiddenInView` 显示（写在空会话下拉的选中文字里）；旧宿主没有该字段时回退
`total`（行为与修复前一致，不至于不提示）。

**新增回归测试**：`test/contract.test.mjs` 的
「空会话：`hiddenInView` 必须只数本视图真正藏掉的，不得拿全库 `total` 冒充」——
构造「空的主会话 + 空的子代理会话」，断言默认 `kind=main&hide` 下 `total=2` 而
`hiddenInView=1`；`kind=all&hide` 下两者都 2；`show` / `only` 档 `hiddenInView=0`。
（最后一组同时防止「把 `hiddenInView` 写死成 `total`」蒙混过关。）

**真机只读观察（宿主仍在跑修复前的代码，故 `hiddenInView` 尚不可见）**：
`kind=main&blank=hide` → `total=8`、`blank={"filter":"hide","total":13}`；
同一视图 `kind=main&blank=show` → `total=20`、其中空会话行 **12** 条；
`kind=all&blank=show` → `total=57`、`kind=all&blank=hide` → `total=44`
（57 − 44 = 13，与全库 `blank.total` 相符）。
由 13 − 12 = 1 可推出这 1 条是子代理空会话，因此 `kind=main` 视图的
`hiddenInView` 应为 **12**。该字段需宿主重启加载新代码后才会出现在返回体里，
**本轮尚未做该确认**。

### 修复：空会话三选一根本没接进请求 —— 下拉框「只看不生效」

上一节加了 `blank` 三选一，但**客户端两处链路都漏了这个参数**，于是界面上：

- 药丸/下拉框能切换，`params.blank` 也确实变成了 `show` / `only`；
- 发出去的 URL 里却从来没有 `blank=`，服务端只能回落到自己的默认值 `hide`；
- 结果：切「全部」列表毫无变化，切「仅显示空会话」回来还是一屏真会话。

两处断点分别是：

1. `fetchList()` 里少了 `if (params.blank) query.set("blank", params.blank)`；
2. `useEffect` 组装的 `request` 对象里也少了 `blank: params.blank`。

**为什么之前的测试没抓到**：`blank` 的默认值、下拉框、药丸文字、提示条都只看本地
state，而这类断言在参数没进请求时**全是绿的** —— 服务端默认值恰好也是 `hide`，
于是「默认视图正常」这个现象掩盖了整条链路是断的。真机验收也只验了服务端
（`curl ...?blank=only` 直接带参数），绕过了客户端。

**新增回归测试**：`test/render.test.mjs` 的
「渲染：空会话三选一必须真的改变请求参数（不得只在本地 state 里改）」——
只认发出去的 URL：默认必须是 `blank=hide`（**显式发出，不靠服务端隐式回落**），
切到「仅显示空会话」后必须变成 `blank=only` 且不再带 `hide`。

这与 `archived` / `kind` 已有的两条「从下拉选一项必须改变请求参数」测试同构：
凡是有默认值的筛选维度，都必须钉住「参数真的进了 URL」。

### 修复：空会话默认隐藏 —— 「一屏（无标题）」的真正根因

四态文案（上一节）解决的是「同一种空白长得一样」，但**首屏仍然是一屏占位**。
真正的根因不是标题读不到，而是**空会话把列表刷满了**：

- 空会话 = 从未收到过任何用户消息的会话。日志只有 5 行初始化事件
  （`session` / `permission/preset` / `sandbox/mode` / `approval/policy` /
  `subagent/model-selection-policy`，约 **588 字节**），既没有 `user/message`
  也没有 `session/title` —— 它们本来就不该有标题；
- 数量悬殊：实测某宿主 254 条会话里 **199 条**是空会话，一行一条就把面板首屏
  刷成一片「（无标题）」，真会话被挤到后面；
- 与用户在自己侧栏看到的东西完全对不上，所以反复反馈「还没解决」。

**契约依据（不是猜测）**：`@deepseek-ai/dsh-client-ui-workspace/lib/client.js` 的
`sessionVisible()` 里有一行 `if (session.blank && session.id !== current) return false;`，
注释原文「Ordinary sessions are visible; among blank sessions, only the current one
is visible.」—— **官方侧栏默认隐藏所有空会话**，只留当前那一条（就是「新会话」占位行）。

`/list` 新增 `blank: 'hide' | 'show' | 'only'` 三选一（与既有 `archived` 三选一同构），
**默认 `hide`，与官方侧栏一致**。不照抄「只留当前那一条」的原因：官方只留一条是因为
侧栏里空会话只是占位符、没有清理价值；而本插件是**清理磁盘**的工具，空会话虽然小
同样是可删对象，用户要能批量清掉它们。所以默认对齐官方体验，另给两个显式出口：

- `hide`（默认）—— 隐藏空会话，首屏全是真会话；
- `show` —— 与普通会话一起列，排查/彻底清理用；
- `only` —— 只看空会话，专门批量删。

返回体新增 `blank: { filter, total, hiddenInView }`，`total` 是**全库**口径（不随筛选变化），
`hiddenInView` 是**本视图**在其它筛选生效后实际藏掉的条数。
客户端把条数写在**空会话下拉框自己的选中文字**里（`隐藏空会话（N 条）`），同一件事只在一处
出现。早期版本的「已隐藏 N 条空会话」常驻横条与其「仅显示空会话」按钮已移除 —— 横条重复了
下拉已经说明的状态，按钮也与下拉第三项完全等价（用户 2026-10-25 指出「不是重复显示了？」）。

服务端 `blankFilter` 与客户端 `params.blank` 的默认值由测试钉住必须一致
（与 `archived` 默认值同一套防偏差逻辑）。

**真机只读验收**（宿主加载本改动后）：`kind=all` 三种档位
`show=57 / hide=44 / only=13`，`44 + 13 = 57` 恒等；`hide` 视图 `blank=true` 行数 **0**，
`only` 视图非空会话行数 **0**；默认 `kind=main` 视图 **8 行全部 `titleState=ready`、
无标题行 0**。

### 修复：标题占位四态化 —— 「本来没有标题」不得再和「本次没读到」长得一样

面板里曾出现一屏「（无标题）」，用户无法判断是自己漏了、还是列表坏了。实测取证后
发现 `title: null` 有**四种**互不相同的成因，而界面此前一律渲染成同一句话：

- `ready` —— 有标题（正常）；
- `blank` —— 宿主 `blank: true`，这条会话**从未收到过任何用户消息**。日志只有
  `session` / `permission/preset` / `sandbox/mode` / `approval/policy` /
  `session/end-seed` 等初始化事件，没有 `user/message`、也没有 `session/title`。
  实测 254 条里 **199 条**属此类，它们本来就不该有标题；
- `empty` —— 有内容，但宿主**明确答复过没有标题**。例：`d33c9459-…` 是子代理会话，
  日志 10 行只有 `turn/start` → `turn/end`，`titleInput.count === 0`，
  翻完日志也没有 `session/title`。**重试一百次也是 null**；
- `unread` —— 有内容，本次**没读到**（落在标题预算 `titleLimit` 之外，或这一批
  `readTitleSnapshots` 失败）。**下一次刷新可能就有了**。

`blank` 与 `unread` 混成一个状态，会让用户对着永远不会有标题的空壳反复刷新；
`empty` 与 `unread` 混成一个状态，则把真实的读取失败伪装成「这条会话本来就没标题」——
两种都是撒谎，而且是在一个不可逆删除的界面上撒谎。

`/list` 的每行新增 `titleState`（`ready|blank|empty|unread`）。`empty` 的判据是
`titleConfirmed` 集合：只收**宿主明确答复过**的 id（本次 RPC 成功但无标题，或
`titleCache` 里已有的负结果 —— 负结果只在成功答复时才写入），预算外与读取失败都
不进这个集合。

客户端把占位文案拆成三种（`（空会话，无消息）` / `（无标题）` / `（未取到标题）`），
各自带解释性悬停提示；id 显示策略也跟着分档：空会话不印 id（199/254 会把真会话淹掉），
`empty` 与 `unread` 都印（两者都是真会话，删错代价一样大）。

测试 `test/render.test.mjs` 的旧用例（三态）改写为四态，并新增
`渲染：标题占位四态两两可区分` 断言**任意两种占位文案不得相同**，同时钉住
`empty` 不得复用 `unread` 的句子。

### 修复：会话分类三态化 —— 身份未知不得再被默认当成主会话

主会话筛选下曾出现「无法判断身份」的会话行，根因是两条独立路径都把**缺失证据**读成了
**不是子代理**：

- **service 层**：摘要循环的兜底分支（摘要里有、语料里没有的行）建行时没有写任何身份
  证据字段，而主视图判据是 `row.subagent !== true` —— `undefined !== true` 恒真，未知行
  就这样进了主视图。
- **HTTP 边界层**：`lib/index.js` 的 `kind` 取值白名单只认 `main|subagent|all`，新增的
  `unknown` 在读查询串阶段被静默丢弃，service 收到 `undefined` 后按 `main` 兜底 —— 界面上
  点了「身份未知」，返回的是一整页主会话（真实宿主验收发现的，单测全绿却在真机上失效）。

改动：语料侧与摘要侧**只记原始证据**（`origin` / `parentSession[Id]` / `delegationDepth`），
判定集中在 `hasSubagentEvidence`（三项证据**任一**成立即子代理），然后三态落定 ——
`subagent`（任一侧有证据）、`main`（无证据且在语料里）、`unknown`（无证据且只在摘要里）。
**证据只累加不相减**：摘要行缺 `delegationDepth` 是因为宿主契约（`listFields()` 条件展开）
根本不透出该字段，缺失不构成反证，因此不存在「冲突」状态（曾实现的 `source='conflict'`
分支被 `test/project-identity.test.mjs:311` 的组合用例证伪后删除）。

`/list` 新增 `classification`（`main|subagent|unknown`）与 `classificationSource`
（`corpus|summary|corpus+summary`）；`kind` 支持 `unknown` 并保留 `main|subagent|all`；
计数改为 `mainTotal` / `subagentTotal` / `unknownTotal` 三档（不再用「总数 − 子代理数」
算主会话，那种减法会把未知吞进主会话）。兼容字段 `subagent` 改为
`classification === 'subagent'` —— 未知既不是子代理也不是主会话。

`lib/index.js` 把 GET 查询串与 POST 请求体两处白名单合并为同一份 `KIND_VALUES`，
避免「新增取值只改一处」的复发。

界面：会话类型四选一（主会话 / 子代理 / **身份未知** / 全部），未知行有独立徽标与说明
（「宿主没有给出足够的身份证据」），并明确「未知 ≠ 不可删除」。前端**不做任何二次猜测**，
只渲染后端给出的分类。

测试：新增 `test/classification.test.mjs`（15 例，修复前 12 例失败作为证据），其中一条是
**handler 级**用例 —— 直接 `apply()` 注册路由并断言 `GET /list?kind=unknown` 回显
`filter=unknown`，专门钉住上面第二条路径。

### 修复：项目身份字段统一 —— 显示、筛选、下拉选项同源

`/list` 以前用两个不同的字段算同一件事：显示用 `workspace.path`，筛选用 `row.cwd`。
两者不一致时出现三类可复现的错误（均已补测试复现后再修）：

- **显示与筛选打架**：行上显示 `E:\Code\renamed-workspace`（工作区后来被改名），
  但选这个项目筛选时一条都筛不出来，因为筛选比的是 `cwd`。
- **选项与行不匹配**：会话只有 `cwd`、没有工作区归属时，行显示了项目路径，
  下拉框里却没有这个选项（选项集合当时是另一个循环按 `cwd` 单独建的）。
- **Windows 上重复选项**：`E:\Proj\A` 与 `E:\proj\a`、`E:\a` 与 `E:\a\` 会各出一个选项，
  看着一样、点哪条都只筛出一半。

改动（`lib/service.js`）：新增导出 `projectKey(value, platform)` 做规范键（win32 下反斜杠
转正斜杠并小写、去尾部重复分隔符；POSIX 保持大小写敏感、不把 `\` 当分隔符）；
每个会话行只在「3b. 项目身份」一处算出 `projectKey` / `project`，**显示、筛选、选项三者
都从它派生**；身份取值顺序是 `cwd（非空）→ workspace.path（非空）→ null`；同一规范键的
多种写法合并为一个显示值（首个出现者胜）并只出一个选项；`wsBySession` 由「最后赋值胜」
改为「首个声明者胜」（一个会话可被多个工作区列出，取哪个都不该影响项目身份）；
关键词过滤改为匹配 `row.project`，用户把界面上看到的路径粘进搜索框必须能搜到。

`projects`（下拉选项）仍然来自**全库**而非当前筛选结果，作用域与修复前一致，
避免切换筛选时选项抖动。

测试：新增 `test/project-identity.test.mjs`（15 例），修复前跑出 8 条失败作为证据。

### 测试：删除事务边界审计（8 例，未改生产代码）

补 `test/transaction-boundary.test.mjs`：标题读取在途时删除、批量里一条被拒 + 一条非法 id、
审计写入在途 / 审计失败、投影缓存三态（正常删除 / 条目是符号链接 / 根路径异常）。

结论是**没有确认缺陷**，因此不改代码。原先的假设「投影缓存删不掉就应当报降级」被实测否证：
`removeProjectionCache`（`lib/artifacts.js`）只在 `failures` 非空时给 `error`，而
Windows 下路径异常会被 `lstat` 映射成 `ENOENT`（按「没有缓存」处理）、符号链接条目走
fail-closed 跳过、`fs.rm(..., {force:true})` 对只读属性照样成功 —— 这三条都构不成降级。
`complete:true` 是**有意设计**（absent ≠ failed，且不跟随链接），测试改为钉住这个语义。

### 文档：标题异步化设计稿 + 模拟宿主原型

新增 `docs/TITLE-ASYNC-DESIGN.md`：为什么不能靠 `setTimeout` 糊（要改的是返回契约，
不是等待位置）、`pending/ready/empty/unreadable` 四态、token + epoch 双重栅栏、
删除期间迟到结果的处理、失败不得停在 pending、可测的验收标准（含冷热对比口径）。
配套 `test/title-async-prototype.test.mjs`（7 例）用「可控闸门」的假宿主验证这些不变式。
**这是原型，不是生产实现**，也未在真实宿主上验证；真实宿主验收需要实现后再做一次。

### 修复：npm 发布永远 ENEEDAUTH —— 改为 publish-npm.yml 自己被标签触发

**不影响已发布的包内容，只修发布链路。** 1.1.0 之后的所有版本（1.1.1、1.1.2）
GitHub Release 都正常产出，但 npm 上一直没有它们 —— 每次都红在 `Stage publish to npm`。

根因（npm 官方文档《Trusted publishing》原文）：

> Some GitHub Actions workflows use workflow_call to invoke other workflows that run
> npm publish ... When this happens, validation checks **the calling workflow's name**
> instead of the workflow that actually contains the publish command.

即：OIDC 令牌里的 `job_workflow_ref` 确实指向被调用的 `publish-npm.yml`（所以文件内的
身份自检一路绿灯），但 **npm 服务端校验的是调用方文件名**。由 `pack-release.yml` 用
`uses:` 调过去时，npm 看到的是 `pack-release.yml`，与登记的 `publish-npm.yml` 不符
→ 令牌交换被拒 → `npm error code ENEEDAUTH`。

历史对照：1.1.0 是手动 `workflow_dispatch` 直接跑 `publish-npm.yml`（调用方=自己）→ 成功；
1.1.1 / 1.1.2 是标签触发 `pack-release.yml` → `workflow_call` → 失败。

改动：

- `publish-npm.yml` 自己声明 `on: push: tags: ['v*']`，与 `pack-release.yml`
  **并列触发、互不调用**；删除 `workflow_call`。
- `pack-release.yml` 里整个 `publish-npm` job 删除（它不可能通过校验）。
- `test/release-workflow.test.mjs` 的断言方向反转：从「必须有 `workflow_call` +
  `uses:`」改为「**不得**有 `workflow_call` / `uses:` / 第二个发布 job」。
- 同步更正 `docs/RELEASING.md` §5.1、README 两份、`scripts/release.ps1` 头部注释里
  原先那条**错误**的推导（旧文写的是「`job_workflow_ref` = 被调用文件，所以复用可行」）。

## 1.1.2

### 性能：查询延迟归因与标题读取去重（PERF-03 / PERF-04）

**没有改变任何默认配置，没有改变查询结果语义。**

#### 1. 新增阶段耗时指标（`3642075`，纯观测）

`/list` 每请求采集 `sessionsMs` / `runningStateMs` / `titlesMs` / `filterSortPageMs` /
`serializeMs`，配 `perfSeq` 与 `reqId`，每请求输出一条 `debug` 摘要。只记计数与耗时，
**不记标题文本、正文或 `cwd`**。默认日志级别下不可见，需要显式打开 `debug`。

#### 2. 标题读取跨请求去重（`e6853ef`，唯一有行为变化的改动）

新增 `titleInFlight` 单飞表：同一 `sessionId` 正在读取时，后续请求复用那个 Promise，
读完 `finally` 立刻清表（**失败也清，绝不把一次读失败永久缓存成「没有标题」**）。

实测（8 并发、400 条标题需求）：标题读取 RPC **400 → 50 条（−87.5%）**。
**单次冷查询没有提速**（503 → 516 ms）—— 单飞只合并并发重复，不能并行化单条日志的解码。
结果、排序、分页逐字段不变（`test/perf-regression.test.mjs` 9 条护栏）。

真实宿主侧也验证了去重（【真机】，零请求静默冷态，**两轮独立复现**）。**判据是「2 并发
`wallMs` 是否远低于 2× 单请求」**：轮 A `1519 ms` vs 2×`1632`=3264；轮 B `618.5 ms` vs
2×`535`=1070，两轮都只有无去重期望值的 46%–58%。若无去重，两个请求会各自完整同步解码一遍，
wall 必然接近单请求的 2 倍。

注：**不能用「wall 是否低于单请求」作判据** —— 轮 A 的 1519 低于 1632 只是时序巧合（第二个
请求几乎完全搭上第一个的车），轮 B 的 618.5 **高于**单请求 535（+15%）同样成立。写成「低于」
会让结论依赖巧合。
判据**不能用 `fetched`**：它统计的是「本请求最终拿到标题的条数」，包含复用别人 Promise
的结果，多并发时每请求仍报满额是正常的。

#### 3. 真实宿主归因结论（`docs/PERF-04-REPORT.md`）

在运行中的真实 DSH 宿主上测得（只读 `GET /status` 与 `/list`）：

- **「约 2000 ms」复现，但取值取决于 live 组成**：零请求静默后**同一份 16 条语料**
  （指纹恒为 `c33620121c60`）的冷读在 **535 / 1180 / 1632 / 1647 ms** 之间变化；
  早期 23 条 / 108.4 MB 语料（含 58.33 MB 巨日志）为 **2149 ms**；重启后首查最坏
  **3761–5298 ms**；热态 49–140 ms。
- **决定性发现：成本由「非 live 的持久化日志字节」决定，不是候选总字节**。
  两份**总字节几乎相同**的语料（52.38 vs 52.56 MB）因 live 组成不同，非 live 字节
  8.48 vs 25.37 MB（**2.99×**），冷读 **535 vs 1647 ms**（**3.08×**），折算
  **63.1 vs 64.9 ms/MB 非 live，只差 3%**。
- **机制**：宿主 `SessionCorpus.projectMany` 先 `this._ctx.sessions.get(id)`，
  **命中 live 就直接用内存 events 投影**，只有未命中的才 `readColdSessionLog` 读整份日志。
  实测 27 MB 的 live 会话单条冷读仅 **145 ms**（热 113 ms），而本机解码同一条需 900 ms 以上
  —— 它根本没读盘。**⇒ 真实使用场景下（当前对话的会话必然是 live）侧栏冷查询比
  「全语料都冷」便宜约 3 倍；但重启后或访问大量历史会话时仍要承担完整解压成本。**
- **单条成本未测出，且曾误判**：原记录「单条 58.33 MB ≈ 1.9 s（1893 ms）」**已作废** ——
  那次实测走 `query=`，该路径折叠**整个候选集**的标题（同一次响应自报 `fetched:23`），
  1893 ms 是全量成本而非单条成本。**`query=` 不缩小标题读取范围。**
- **交叉验证撤回**：曾写「本机等价解码稳定偏慢 1.64–1.68 倍」，该比值建立在
  「本机解全部 16 条 vs 宿主只解非 live 那部分」的口径不一致之上，**已作废**。
  本机解码表只保留用作**相对排序**（最大的 `d7d90226` 一条占本机成本 53%）。
- 口径陷阱：磁盘 56 个日志 / 102.1 MB，但 `/list` 默认 `kind=main` 排除 subagent 与部分
  归档会话，**实际候选只有 16 条 / 51.7 MB**；拿磁盘总量比宿主成本会得出约 3 倍的假差异。
- 根因：宿主标题目录**不存在**（`session-query-sqlite` 的 `persistent_sessions` 表没有
  `title` 字段），`readTitleSnapshots` 必须解压**整份日志**再 `foldSessionTitle`；
  解压与 JSON 解析都是**同线程同步 CPU**（`ZSTD_DECODE_YIELD_INTERVAL_MS = 500`），
  所以加 worker 或加并发都不会加速单条日志。
- **`titleFetchConcurrency` 保持 8**：两轮零请求静默实测并发 1→2→4→8 分别为
  **1632 / 1519 / 1997 / 2215 ms**（另一轮 535 / 618.5 / 734.5 / 1178.8 ms），
  并发 4 与 8 反而比单请求慢 **22% / 36%**（另一轮 37% / 120%）。
  提高它只会增加对宿主主线程的 CPU 争用。

报告附带**原始样本附录**（§12）：恢复检查 4 次、热态 10 样本的逐条原始值、五个冷窗口的
`waitedMs`/`anchorMs`/`perRequestTookMs` 全量数组、16 条候选的本机成本逐条表、语义不变性
指纹与字段集合，并单列「未纳入的作废样本」及其原因。原始脚本与 `out/*.json` 在仓库外的
临时目录，附录内联后可脱离该目录独立复核。

回归门禁（本次实跑）：`node --check` 7 文件通过；`node scripts/run-tests.mjs` →
**248 tests / 245 pass / 0 fail / 3 skip**；`node test/mutate-tokens-official.mjs` →
**killed 71 / survived 0**。远端 CI（PR #3）四个矩阵 job 全部 success；变异 job 在 PR 上
按设计 skip，**因此变异门禁的 71/71 是本地实测，未经远端独立复验**。

#### 4. 顺带修掉的文档缺陷

README（中英双份）的测试与命令已经过时：

- `node --test "test/**/*.test.mjs"` 在 **Node 20 上直接失败**
  （`Could not find '.../test/**/*.test.mjs'`，glob 展开是 Node 22+ 才有），
  而 `engines.node` 声明 `>=20`。已改为 `node scripts/run-tests.mjs`。
- 测试数量从「238 条 / 13 个文件」更正为「**248 条 / 14 个文件**」，
  并补上遗漏的 `fault-injection` / `isolated-integration` / `batch-semantics` /
  `audit` / `perf-regression` 五个套件说明。

#### 5. 新增只读基准工具

`scripts/bench-real-host.mjs`：`status` / `series` / `sizes` / `concurrent` / `burst`
五个模式。**宿主端口必须自动发现**——DSH 每次启动的端口是动态的（实测 4294 → 46664 →
43547 → 29049，同一台机器在一次任务期间变了四次），写死端口会让脚本跑空，
而「跑空」很容易被误读成「性能变好了」。
安全边界：只发 GET，不调 `/delete`、`/archive`，不输出标题/正文/`cwd`，
一致性只比 sessionId 集合的 sha256 指纹。

#### 6. 冷态测量方法（教训，供后来者）

`titleCacheTtlMs` 命中**不刷新** `hit.at`，所以冷态只能等 TTL 自然过期。但"探测冷态"
这件事本身是错的，两层原因都实测到了：

- **`query=<id>` 探针**会走搜索分支，对**整个候选集**折叠标题，一次探测就把全部标题烘热。
- **`page=N` 探针**只证明"那一页那一条"过期了；不同条目的 `hit.at` 不同，探针条目往往
  比待测条目更早过期，于是"探针冷了"不等于"待测的冷了"，还会因轮询不断重置时钟。
  实测反例：`titles{cached:22, fetched:1}`、`tookMs=131` 这种"声称已冷、实则几乎全热"的样本。

正确做法是**零请求静默**：锚定最后一次请求的时刻，之后一个请求都不发（连轻量探测也不发），
静默 `titleCacheTtlMs + 60s` 后做唯一一次测量，并用**该次测量自身**的
`titles.cached==0 && titles.fetched>0` 判定有效性，否则记 `cold=false` 并排除。
代价是一次冷样本至少 360 s —— 这是 TTL 语义决定的，绕不过去。

## 1.1.1

### 收尾整改：CI 补齐、审计治理、删除竞态与「未知状态」处理

上一版（1.1.0，2026-10-16）**不含** 10-18 的删除安全修复；本版把它们与后续
收尾整改一起发出。完整证据见 [docs/整改报告-稳定性与安全性.md](docs/整改报告-稳定性与安全性.md)
与 [docs/删除安全残留分析.md](docs/删除安全残留分析.md)。

#### P0 · 新增常规 CI（.github/workflows/ci.yml）

此前仓库只有标签/Release 触发的发布工作流，**push 到 main 与 PR 都不会跑测试**。
新增独立 `ci.yml`：push→main、PR→main、workflow_dispatch 三触发；矩阵 node 20/22 ×
ubuntu/windows；权限只有 `contents: read`，**不接触任何发布凭据**。

关键一步是**断言测试条数**：`node --test-reporter=tap --test "test/**/*.test.mjs"`
解析 `# tests N` 并要求 N ≥ 200。理由是那层 glob 由 node 自己展开，一旦某层吃掉引号
就会「跑了 0 条还退出 0」——绿着的假象。变异测试独立成 job，并要求
`survived === 0`（脚本在原文未命中时会打 SKIP 并计入 survived，只看退出码会漏掉
「断言退化成装饰品」）。

> 实测踩坑并已修正：写成 `npm test -- --test-reporter=tap` 时，参数落在文件实参之后
> 会被 node **静默忽略**（输出仍是 `ℹ tests N`，没有 `# tests N`），CI 会永远匹配不到
> 而**每次假红**。必须把 reporter 旗标放在 `--test` 之前。

**首次远端运行还抓到两个更严重的问题（本地 Windows/Node 24 都测不出来）：**

1. **Node 20 的 `node --test` 不支持 glob**：`Could not find '.../test/**/*.test.mjs'`。
   glob 展开是 Node 22+ 才有的，而 `engines.node` 声明 `>=20.0.0` —— 也就是
   「文档里写的跑法」在最低支持版本上**根本跑不起来**。`package.json`、`release.ps1`、
   `ci.yml` 三处都用了它，现已统一到新增的 `scripts/run-tests.mjs`
   （由 Node 自己枚举文件再传给 `node --test`），三个版本、两个平台行为一致。
2. **`isInside` 测试硬编码 Windows 路径**：`not ok 236`。POSIX 上 `path.resolve()`
   把反斜杠当普通文件名字符，`C:\tmp\sessions` 变成无分隔符的单段路径，断言必失败。
   这不是 `isInside` 的 bug，是测试的平台假设错误；已改为按 `process.platform` 取路径。

修复后 CI **四个组合（node 20/22 × ubuntu/windows）全绿**，
日志确证每个组合都跑了 13 个文件 / 238 条测试并通过 `≥200` 断言（不是空转）。

#### P0 · 运行态检查与磁盘删除之间的竞态（公开 API 下的最保守策略）

**调查结论（实测，非推测）**：DSH 确实有内核级会话写锁 ——
`SessionWriteLease.acquire`，Windows 用命名信号量
`Local\dsh-session-lock-<sha256(realpath)>`，POSIX 用 fd 锁，占用时抛
`SessionAlreadyOwnedError`。但它**不对插件暴露**：`SessionWriteLease` 是内部模块
（无 export 块、无 `ctx.*` 挂载），唯一对外表现是 resume 被占用时返回
`session/writer-held` 错误 —— 那是错误码，不是可调用的锁。

因此**不声称竞态已消除**。采取能实现的最保守策略：在**每个 `rm` 之前**紧贴地再判一次
运行态（`beforeDelete` 回调），把「检查→删除」窗口从整个事务压到「单次探测→rm」；
二次确认失败或判为 running 时**拒绝删除**并如实进降级清单
（`step: "preDeleteRecheck"`）。批量仍复用一次快照做**早期拒绝**，但删除前的最后一道
判定**故意每次都取新鲜快照**，不用过期快照做破坏性决策。

残余风险如实记录：窗口被压到单条语句级，但**不为零**；彻底消除需要宿主把
`SessionWriteLease.acquire` 挂到公开服务上（已作为上游建议写入残留分析文档）。

#### P1 · 会话身份查询失败不再静默

`sessions.list()` 抛错 / 返回非数组 / 服务缺失，原来被同一个 `catch` 压成
`liveIdsKnown=false`，用户看到的是 `complete:true`。现在区分三类：
**服务缺失 = 能力缺失（不算失败，不制造噪音）**；**抛错/非法类型 = 真失败**
（进 `degradations`，step `readLiveIds`）；**空数组 = 正常结果**，与读取失败严格分开。

`sessionQuery.listSessions()` 失败原本已 fail-closed（不碰对偶拼写，方向正确），
但静默；现在同样进降级（step `readPersistedIds`）并说明「守卫已收紧」。

#### P1 · 项目目录链接不再静默跳过

Windows 上 `readdir` 对任何重解析点（`mklink /J`、`/D`、文件符号链接）都报
`isDirectory:false`。跳过它**方向是对的**（不跟进链接 → 不越界删除），但原来既不进
`skipped` 也不进 `failures` —— 若会话数据只在链接指向处，删除会报 `complete:true`
而数据没删。现在记入结构化 `skippedDetails`（`reason: "project-dir-is-link"`）
并进降级清单。`skipped` 仍保留字符串数组以兼容既有契约。

#### P1 · 批量删除语义可判别 + 精确重试清单

- **重复 id 去重**：原来 `["a","a"]` 会报 `total:2/ok:2`（第二次其实是 no-op），
  污染统计。现在 `requested` / `duplicates` / `total` 三者分开。
- **逐条 `outcome`**：`deleted` / `noop` / `refused` / `blocked` / `failed`，
  并带 `retryable`，调用方能判「这一条该不该重试」。
- **`retry` 清单**：只含失败或降级的条目，不重跑已完整成功的条目。
- **`allComplete`**：整批全绿才为 true；任一子项有降级即 false。

#### P1 · 审计日志治理（字段最小化 + 轮转）

现网实测旧实现 **38 行 33.8 KB ≈ 910 B/行**：把整份 `result.runtime`、完整标题、
全部 `removedPaths` 都塞进了一行 —— 那不是留痕，是备份删除结果。
现在只写诊断必需字段（时间/操作/actor/phase/sessionId/结果码/计数/耗时/降级步骤），
**实测降到 196 B/行（约 4.6× 缩小）**，并对每个文本字段做定长截断（240 字符）兜底。

新增按文件大小轮转：`auditMaxBytes`（默认 4 MiB，0 = 不轮转）与
`auditRotateKeep`（默认 3 份）。轮转不覆盖/不截断正在写入的日志（rename 搬走整份），
并发追加安全；轮转失败返回可诊断降级（`rotated` / `rotateError`）且**不阻断写入**、
**不让删除事务失败**。审计路径经 `normalize` + 越界校验，必须落在 `<DSH_HOME>` 内；
越界配置**拒绝写入并如实上报**，不静默改写到别处。

审计失败与删除结果是**两件不同的事实**：`audit.ok=false` 只进降级清单，
绝不把已执行的删除伪报成回滚。

#### 测试

新增三个套件：
- `test/audit.test.mjs`（14 条）：正常写入、字段最小化、截断、连续追加、超阈值轮转、
  轮转不截断正在写的日志、轮转失败、路径是目录、50 条并发、路径不可写、路径越界、
  禁用、配置边界与非法值回退。
- `test/batch-semantics.test.mjs`（5 条）：全成功 / 去重 / deleted-refused-noop 三态 /
  降级条目可重试 / 非法 id 不重试。
- `test/isolated-integration.test.mjs`（4 条）：完整副作用清理、running 零改动、
  **真实子进程 SIGKILL 中途中断后重启重跑**（不误删其他会话）、批量部分成功后重试。

`fault-injection.test.mjs` 扩充到 27 条，新增 §4.1 竞态（检查后变 running 必须拒绝）、
§4.2 查询失败可观测（含反向断言：服务缺失/空数组不得误报）、§4.3 链接跳过可观测。

变异测试 **71/71 killed、survived 0**（**main push 远端已验证**，run 39206316730）。
全套 **239 条测试**（Windows：236 pass / 0 fail / 3 平台跳过；Linux：239 pass / 0 skip）。

> 变异 job 在合并后**先红过一次**：`a9698d8` 报 `SURVIVED N1`（`killed 70 / survived 1`）。
> 根因是 N1 的两个杀手测试都是 Windows-only，Linux 上无人咬。已补跨平台用例修复
> （PR #2 / `8cd9618`），复跑为 71/71。

#### 如实记录的未完成项

- 真实宿主上的**破坏性**集成测试未做（会删用户真实会话）——破坏性路径只在隔离临时
  `DSH_HOME` 上验证；真实 DSH 只有**只读**检查（`test/integration-real.mjs`）。
- **Linux 实机未验证**：CI 矩阵已配置 ubuntu + windows，但首次远端运行结果需看
  Actions（本地只能验证 Windows）。
- 状态检查与 `rm` 之间的微窗口仍存在（见上）。
- `removeProjectionCache` 的 `rootPresent` 恒为 `true`（按精确文件名删除，不列举 root）。

---

### 稳定性与安全性整改：删除事务的状态一致性、路径越界与静默失败

本轮以「先复现、后修改」推进，**复现并修复 5 个真实缺陷**（2 个 P0 数据/安全级、
3 个 P1 状态一致性级），并补强了 3 处「测试自身太弱」（变异测试抓出）。
完整报告见 [docs/整改报告-稳定性与安全性.md](docs/整改报告-稳定性与安全性.md)。

#### P0-1 磁盘删除整步失败被吞，事务仍报完整成功

`removeArtifacts` 原来 `catch { return {count:0} }`，把**所有** `readdir` 失败都当成
「根不存在，没什么可删」。实测把 `<DSH_HOME>/sessions` 做成一个**文件**（`readdir` 抛
`ENOTDIR`）后，删除仍返回 `ok:true / detach:"detached" / files:0 / partial:false` ——
与一次完全干净的删除**逐字节相同**，而磁盘一个字节没动。`EACCES`/`EPERM`/`EBUSY`/`EIO`
同理，它们都意味着「**没能删**」，却与「这个会话没有磁盘工件」不可区分。

现在三态分明：`ENOENT` → `rootPresent:false, error:null`（正常收尾）；
其它错误 → `error` 如实带上 + 逐路径 `failures`；`rm` 失败逐目录记录后继续，不再直抛。

#### P0-2 对偶 id 拼写守卫只看 live 会话 → 删掉另一个真实会话

`isKnownSession` 只查 live 集合与 `agents.get()`，于是**已持久化但当前不 live** 的会话
（用户关掉的、宿主重启后的）被判为「不存在」，被当成「我这个 id 的另一种拼写」而 `rm -rf`。
实测（`p/<uuid>` 与 `q/session-<uuid>` 并存、live 为空）：`{ok:true, files:2}`，**两个目录都没了**。
更说明问题的是重试路径：第一次因兄弟是 live 而正确跳过，用户关掉它后**重试同一请求**
→ 兄弟目录消失 —— 守卫生效与否竟取决于「兄弟恰好是不是 live」。

现在把**持久语料**（`sessionQuery.listSessions()`）纳入判据，并确立原则：
**无法证明它不是另一个会话，就不能删它**（守卫不可用时传 `null`，随即跳过对偶拼写）。

#### P0-3 `isInside` 纯字符串校验 → 父组件是 junction 时可越界删除

`isInside` 不解析链接。root 下某个**项目目录**若是指向 root 之外的 junction：
字符串仍以 root 开头 → `isInside` 通过；`lstat` 跟随父组件链接报告「普通目录、非符号链接」
→ 符号链接守卫**也通过**；`rm(recursive)` 于是删掉 root 之外的**真实目录**。
竞态实测：`count:201`、`error:null`、root 外的 `valuable.txt` 被删。

新增 `isRealPathInside()`：`realpath()` 解析真实路径后再与解析后的 root 比较，
**每个 `rm` 之前强制校验**；任何解析失败即拒绝（宁可不删）。复跑后同一场景变为
拒绝删除并如实上报 `error`，外部文件存活。

#### P1 删除吃实例级 TTL 快照

`deleteSession` 原来直接吃 `runningSnapshot()` 的 TTL 缓存 —— 那是**实例级**的，
可能来自上一次删除请求，于是「刚在 1 s 窗口内开始运行」的会话可能拿过期快照被判为 idle。
现在删除默认走 `freshRunningSnapshot()`；批量由 HTTP 层在整批开始前取**一份新鲜快照**
批内复用 —— 既满足「删除前重新验证」，又保住 O(1) 次探测（实测批量 50 条仍只探测 1 次）。

#### P1 `lstat`/`rm`/工作区摘除失败被静默吞掉

- `lstat` 的 `catch { continue }` 把所有错误当成「不存在」→ 权限/ELOOP/IO 失败不进 `failures`；
- `detachWorkspaces` 返回数字 `0`，与「本来就没有工作区」无从区分；
- `rm` 失败直抛会让事务丢掉「其它目录已删掉」的事实。
现在分别返回 `failures` / `{removed, failures, error}`，并汇总进统一的 `degradations`。

#### 统一结果模型（单条与批量共用）

```js
value.complete        // 完整成功：所有破坏性步骤都完成
value.partial         // 至少一个破坏性步骤没完成
value.degradations[]  // [{step, reason, failures?}] 逐项降级明细
value.nothingDeleted  // 什么都没删到（幂等重删 / id 不存在）
value.failures[]      // 磁盘层逐路径失败清单
```

批量信封新增 `complete / degraded / noop / degradations`，使「部分成功」不可能被报成完整成功。
另外把「**能力缺失**」与「**真的失败**」分开：`announce` 的 `no-emit`/`disabled`
是能力/配置选择（由 `capabilities()` 上报），不计入降级；`emit-threw` 才计入。

#### 测试与变异

- 新增 `test/fault-injection.test.mjs`（18 条）：逐个破坏每个破坏性步骤，
  并含**反方向**断言（全绿时不得误报降级）。含 junction 静态 + 竞态用例。
- 为**确定性**覆盖错误分支，`artifacts.js` 新增可注入 fs 的 `removeArtifactsWithFs()`
  —— 真实文件系统上很难确定性触发 `rm EPERM`（实测 Windows 打开文件句柄也拦不住 rm），
  于是那两行长期**无测试保护**：变异 N3/N4 把错误记录删掉时全套测试**全绿**过。
- 变异目标扩展到 `lib/artifacts.js`，新增 N1–N9，全套 **71/71 killed、0 survived**。
- 测试总数 **207**（204 pass / 0 fail / 3 平台跳过）。

#### 如实记录的未解决风险

状态检查与磁盘删除之间的理论竞态仍在（宿主未提供会话锁的公开能力）·
`detachLiveStore` 分支①在出现公开 detach 后需补「调用后校验 + await」（当前运行时无该入口）·
`sessions.list()` 读失败仍为静默 · 目录符号链接作为项目目录时不记 `skipped` ·
审计日志约 910 B/行且无轮转。详见报告 §6。

> 真实 DSH 集成检查（只读，7/7 通过）与模拟集成测试分别陈述 —— **未做**真实宿主上的
> 破坏性集成测试（会删用户真实会话），不以模拟结果冒充。

---

### 修复：删除结果框被设置页压住（要关掉设置界面才看得见）——改用 <dialog> 进 top layer

**用户实测**：「批量删除结果」这个框没有置顶在窗口之上，必须关掉设置界面才看得到。

**根因（这次是查清了的，不是猜的）**：z-index 只在**同一个层叠上下文**内比较。
本插件渲染在宿主 `shell.overlay` 槽位里，而该槽位的容器 `.BynINW_overlayLayer`
是 `position:absolute; inset:0; z-index:20` —— 它**自己就是一个层叠上下文**。
于是 `.dscc-modal` 的 `z-index:1000` 只在这个容器内部有效，容器整体只有 **20**，
被设置页（在另一列容器里，层级更高）压住。

> 也核对过官方为什么没暴露：官方在同一个槽位里的 overlay 内容（如
> `settings-general` 的 `.wCInkW_overlay`，同样是 `z-index:1000`）都是小提示，
> 本来就不需要越过设置页整页；而删除结果框必须盖在一切之上，所以轮到我们暴露了。

**修法**：把弹窗从 `div` 换成原生 `<dialog>`，打开时 `showModal()`。
`showModal()` 把元素提升到**浏览器 top layer** —— 这是规范里的顶层，
**与任何祖先的层叠上下文无关**，因此必然盖住设置页。附带白送：
背景 inert、真正的焦点陷阱、正确的 Esc 语义。

原生 dialog 曾经劝退我们的三个问题，这次逐个有解，写进代码注释：

1. `::backdrop` 与自带遮罩叠加 → `::backdrop` 显式置透明，遮罩仍由
   `.dscc-modal-mask`（官方 `bg-mask-1` + `mask-blur`）负责；
2. 元素可能被宿主选择器意外匹配 → 只带 `dscc-` 前缀类名 + `data-dscc` 命名空间；
3. 「busy 时 Esc 不关」→ 浏览器默认的 `cancel` 事件**可以** `preventDefault`，
   拦掉它就等于禁止关闭，语义与旧实现逐字一致。

**必须成对**：关闭时一定要 `element.close()`，否则 dialog 留在 top layer 上，
整个页面会被永久模态（这条有行为测试钉住）。

**验证**：测试 **188/188**。新增
「弹窗置顶：打开时必须 showModal()、关闭时必须 close()（**行为断言**）」——
用带 `showModal`/`close` 计数的元素桩真实跑一遍打开→清理，而不是文本匹配。

> 顺带修掉一个测试自身的漏洞：原先只断言源码里出现 `.close(`，
> 但 `typeof element.close === "function"` 这行也含该子串 —— 变异 M4
> （把 close 调用改成 `if (false)`）因此**存活**过。改为行为断言后 M4 被击杀。

变异新增 M1–M5（退回 div / 不 showModal / showModal 不幂等 / 关闭不 close /
丢掉 cancel 拦截）**全部击杀**，全套 **62/62 killed、0 survived**。

---

### 性能修复：搜索的标题预算独立于 titleLimit（实测 1059 ms → 有界）

**实测发现的真 bug**（上一轮让关键词也匹配标题之后引入）：

- 真机上 `pageSize=5` 的搜索仍 `titles.requested=25` —— 搜索给**整个候选集**折叠标题。
  冷缓存下 25 条 **1059 ms**（单条约 350 ms，8 并发）。
- 根因：搜索复用 `titleLimit`（默认 100），而候选集通常 < 100 —— **预算等于没设**。
  库一旦变大（几百条），搜索就是秒级卡顿，且随候选集线性膨胀。

**修法**：给搜索一条**独立的、更小的**预算 `titleSearchLimit`（默认 40，可配 0–200）。

- 搜索是「为匹配而付的额外成本」，不该随候选集规模线性膨胀；
- 先按排序（最新活动在前）覆盖最可能被搜到的行，预算外仍按 id/路径/工作区名匹配；
- 预算外**如实**计入 `titles.truncated`（界面已有「另有 N 行标题未读」提示），不静默漏报；
- `titleSearchLimit=0` = 搜索完全不看标题（只匹配 id/路径/工作区名，最快）。

**顺带核实（不是 bug，记录以免后人重复怀疑）**：

- 真机上 25 条里有 3 条标题为 null —— 是**宿主确实没有标题事件**
  （`foldSessionTitle` 返回 `undefined`），不是缓存或预算把标题吃掉了；
- 无关键词时 `pageSize=200` 超过 `titleLimit=100` 的部分也**如实上报** `truncated=50`（实测确认）。

**验证**：测试 **187/187**（新增「搜索预算独立于 titleLimit、不随候选集膨胀」一条：
30 条候选 + `titleLimit=200` + `titleSearchLimit=3`，断言 `requested=3`、`truncated=27`）；
变异新增 H8（搜索误用 titleLimit）/ H9（预算设为无穷）全部击杀，全套 **57/57 killed、0 survived**。

---

### 性能优化（实测驱动）：热路径已到宿主底噪，冷路径瓶颈如实圈定；搜索不再漏标题

**测量先行**（宿主上实测，用服务端自报的 `tookMs` 隔离 HTTP / PowerShell 自身开销）：

- 热路径稳态 **40–48 ms**，且 `titles.cached` 全命中时 `fetched=0` —— 这 40 ms 全部花在
  两个宿主调用本身上（`sessionQuery.listSessions()` + `sessionController.list()`）。
  **插件自身没有可再省的固定开销**：一次性物化全库行、字符串比较代替 localeCompare 排序、
  O(1) running 探测、两数据源并行取 —— 这些早已就位并被测试钉住。
- 冷路径瓶颈**圈死在宿主侧**：`readTitleSnapshots` ≈ 65 ms/条。取证三条：
  ① 磁盘上每个会话目录**只有** `session.v4.jsonl.zstd`（实测一条 54 MB），没有独立标题索引；
  ② 宿主 `foldSessionTitle` = `events.findLast(type === "session/title")`，折叠标题必须解压整份日志；
  ③ 宿主 `projectMany` 的 live 分支是同步逐 id 串行 fold。
  **插件侧无法用「读索引」绕过它**；已有的三重缓解（缓存 / 分片并发 / `titleLimit` 上限）就是正解。
- 客户端的 stale-while-revalidate 核实**已在**：只有 `status==="loading" && value===null`
  才显示加载态，翻页 / 刷新保留旧行、不闪屏。这条不需要改。

**顺带实测出一个真实缺陷（本次一并修掉）：搜索根本不匹配标题。**
UI 占位文案写着「搜索标题、会话 id 或项目路径」，但旧实现的关键词过滤排在取标题**之前**，
那一刻 `row.title` 恒为 null —— 实测中文关键词（如「删除」）在存在同名标题的库上一律返回 0 条。

- **修法**：结构性筛选（项目 / 状态 / 类型 / 归档，均不依赖标题）先行压缩候选集 → 排序 →
  按 `titleLimit` **预算**给候选行补标题（缓存命中 = 零成本）→ 关键词匹配 id / 标题 / 路径 / 工作区名。
  排序先于预算，是为了把 65 ms/条 花在**最可能出现在首页**的行上。
- **预算外不静默漏报**：超出量如实计入 `titles.truncated`，界面成本行追加
  「另有 N 行标题未读（搜索与显示可能不完整）」。措辞对两种截断都成立
  （按标题搜索没覆盖到、以及超大页时该行本来就没读标题），静默漏报才是这条 bug 的原罪。
- **计数按请求去重**：带关键词的请求会走两趟补标题（候选集一趟 + 当前页一趟），
  `requested / cached / truncated` 统计的是「这次请求读标题的代价」，不是趟数之和。
- 既有契约逐字保持：无关键词时仍只给当前页取标题；`titleLimit=0` 仍完全跳过（最快路径）。

**验证**：测试 **186/186**（新增 4 条：标题搜索必须命中 / 二次搜索吃缓存且计数去重 /
预算外如实上报 truncated / 界面提示的两个方向都钉住）。
变异脚本升级为**双目标**（`client.js` + `lib/service.js`，各自跑对应套件），
新增 H1–H7 七条全部击杀，全套 **55/55 killed、0 survived**。

---

## 1.1.0

### 列表行不再显示会话 id（用户反馈：没必要）

用户看着截图问：`session-5a449d65-f46a-…` 这串「在哪都能看到，貌似没有显示的必要」。
说得对 —— 36 字符的 UUID 读不了、没法用，还把标题挤掉半行。

**改法**：常规行去掉 id，改为**悬停提示里保留**（`title` 属性），
需要精确核对身份或从日志反查时鼠标停上去就有。搜索不受影响 ——
Host 侧的 `query` 一直在匹配 `sessionId`（`lib/service.js` 的
`row.sessionId.toLowerCase().includes(query)`），隐藏显示不等于搜不到。

**一个必须守住的例外**：**没有标题的会话，id 就是它唯一的身份。**
本面板是**不可逆的删除**界面，同一个项目里几条空标题会话如果视觉上完全一样，
用户没法复核自己勾的是哪一条 —— 认错行代价很大。所以无标题行仍显示 id
（`.dscc-row-id` 那枚 code 底片，只在 `row.title` 为空时渲染）。

顺手清掉一条因此变成死规则的样式：`.dscc-row-meta code`（行内不再有 code 元素）。
**元素选择器不在「死规则防线」按 `.dscc-*` 类名核对的覆盖范围内**，
所以这条靠人工发现 —— 已把 id 的样式改挂到 `.dscc-row-id` 类上，重新纳入防线覆盖。

验证：测试 182/182；变异新增 G8（一律显示 id）/ G9（一律不显示，丢掉无标题例外）/
G10（悬停里也丢掉 id），三条全部击杀 —— 「去掉」与「例外」两个方向都钉住了。
全套变异 48/48 击杀、0 存活。

---

### 界面统一（第二轮）：用真正的官方令牌，并干掉原生 select

用户反馈第一轮换皮后「UI 还是不统一」。这一轮实测定位到**三个真实原因**并全部修掉，
其中第一个是我上一轮自己造成的。

#### 原因一（根因）：我误判一批令牌"不存在"，把它们换算成了字面值

上一轮我以 `Theme.listTokens` 的 14 条为准，判定 `--dsw-radius-*` /
`--dsw-alias-interactive-bg-*` / `--dsw-alias-button-*` 等名字"不在表里所以不能用"，
于是把圆角写成 `12px`、悬停底色写成 `bg-layer-2`。**那个前提是错的。**

实测（`npx @electron/asar extract` 后逐个字符串核对
`@deepseek-ai/dsh-client-ui-theme/lib/client.js`）：

- inspect 的 14 条只是**子集**；真正的令牌表由 ui-theme 在运行时整表注入；
- 颜色类令牌 `defs=2`（明暗两套主题各定义一次），几何类 `defs=1`（全局单值：
  radius xs=4 / sm=8 / md=12 / lg=16 / xl=20 / panel=28）；
- 本文件用到的 **40 个令牌里 38 个真实存在**；另外两个
  （`--dsh-frame-overlay-top` / `--dsh-frame-chrome-top`）由 `dsh-client-ui-layout`
  在桌面壳里注入 —— 官方 CSS 用它们时也一律带 fallback，本文件写法与官方逐字一致。

抄字面值 = 把官方尺度硬编码进插件，主题一改就分叉，观感自然差一档。
这一轮全部改回官方令牌，并把「哪个令牌实测等于多少像素」写进测试（`TOKEN_SCALES`），
令牌被换成别的档位时会红。

顺带实测确认：**官方自己有两个悬空引用** —— `--dsw-transition-duration` /
`--dsw-ease-in-out` 在 primitives 的 CSS 里被引用，但主题包**没有定义**。
所以本文件的动画时长写字面值 `.2s` / `cubic-bezier(.4,0,.2,1)`，
并加断言禁止跟随这两个悬空引用。

#### 原因二：卡片不靠底色区分，靠描边 + 圆角 + 层级

上一版把卡面从 `bg-layer-1` 换成 `bg-layer-2` —— 而实测**浅色主题下
`bg-base` / `bg-layer-1` / `bg-layer-2` 三个值完全相同**（都是 `neutral-bluish-00`）。
等于什么都没换：卡片与页面同色、只剩一圈描边，看着就是"贴了个框"。

官方设置页里的同类列表（`dsh-client-ui-settings-plugin-inventory`，与本面板同在
设置页）的做法是 `0.5px settings-card-stroke` + `radius-xl` + `settings-card-fill` +
悬停换 `interactive-bg-hover`。整套照抄。

#### 原因三：五个原生 select 还留着（最显眼的那个）

原生 select 的下拉面板由**操作系统**绘制 —— 直角、系统描边、不跟随主题。

官方在同一个设置页里怎么做一个下拉？`dsh-client-locale` 的语言行
（`LanguageRow.module.css`）：不是 select，而是一个 **button 药丸**
（`radius-md` / `bg-module-platform` / 36px 高 / `gap 12px` / 14px-22px）
挂 `aria-haspopup=menu`，点开 primitives 的 **Menu**。五个筛选下拉全部换成这个形态。

**R-22 边界**：官方语言行用 `portal: true`（createPortal 到 document.body），
那是 R-22 禁止的。官方 Menu 本身支持**非 portal** 形态（`position:absolute`
贴在触发器下方）—— 用它，既拿到官方观感与键盘语义，又不往 body 挂东西。

官方 Menu 的键盘语义一并拷齐：打开聚焦选中行、↑/↓/Home/End 游走、Tab 落在当前行
并关闭、Esc 关闭并把键盘还给触发器、选中行尾部一枚勾（`aria-checked`）。

其余对齐：搜索框换成官方 Input 的 wrap 两层结构（前置图标 + `0.5px l4` 描边 +
聚焦光晕走 `color-mix 18%` 而不是 outline）；遮罩换成官方
`backdrop-filter: mask-blur` + `bg-mask-1`（上一版是自己 `color-mix(bg-base 45%)` 凑的）；
弹窗卡片 `radius-panel` + `elevation-prominent`；菜单项、分隔线，以及
chevron / close / check / search 四枚图标的路径数据全部对齐官方原值。

### 测试口径更正：R-24 的允许表从 14 条改为实测表

旧断言「只用 Theme.listTokens 的 14 条」正是原因一的**帮凶** ——
它把真实存在的官方令牌判成违规，逼着实现去写字面值。现在允许表按实测重写，
并新增三条反向断言：禁止跟随官方那两个悬空引用；桌面框令牌**必须带 fallback**；
CSS 里 hex 与 `rgb(a)` 字面色清零（连阴影也走 elevation 令牌）。

### 本轮变异测试真实抓到的两个 bug

**① 一条死规则**：搜索框换成 wrap 两层后，`.dscc-input.dscc-filters-search`
再也匹配不到任何元素，而它的级联断言**只读 CSS 文本、不看 DOM**，于是测试照样绿。
修法：规则与类名一起挪到真正占格子的外层 `.dscc-search`，并加一条 **DOM 断言**
（核对渲染出的元素确实同时挂这两个类）。

**② 又四条死规则**：①暴露这类问题后做了全量核对，又扫出
`.dscc-card-surface`、`.dscc-check`、`.dscc-list-head`、`.dscc-panel-result`
（后两条早于本次改动就存在）。全部清掉；`.dscc-check` 是本轮新写的官方 Checkbox
那层 label —— 本插件行旁就是标题，再插一个可见标签会重复，所以只取官方给 input
的样式落到 `.dscc-row-check`。**防线**：新增「死规则防线」测试，全量核对 CSS 里
每个 `.dscc-*` 类都必须出现在 JSX 侧，并用变异 G1 验证它真的会咬。

### 验证

- **测试 181 / 181 通过**
- **变异测试 45 / 45 全部击杀，0 存活**（`test/mutate-tokens-official.mjs`，手动运行）：
  T1–T10 令牌退回字面值/近似/悬空引用/丢 fallback；S1–S8 选择器药丸与内联 Menu；
  D1–D2 死规则（本轮真实 bug）；F1–F11 既有实测修复与官方几何；
  K1–K7 官方 Modal 键盘与焦点语义；G1–G7 防线自身、基础几何与筛选接线。
  其中 **G2「勾选框焦点环」先存活、补断言后才击杀** —— 这正是变异测试的价值。
- **换掉 select 带来的新风险，专门加了一条功能测试**：
  「从下拉选一项必须改变请求参数并重发」。因为值的传递从浏览器的
  `onChange(event.target.value)` 变成我们自己接的 `onSelect → props.onChange(value)`，
  中间任何一环写错，**界面看着完全正常**（药丸仍会显示新文字，因为 activeLabel
  是从 options 找出来的），但请求参数没变 —— 用户以为筛了、实际没筛。
  所以这条测试不看样式，只看**发出去的 URL**。
  变异 G6（选中但不改筛选）与 G7（把 label 当 value 传）都被它击杀，
  证明这条测试真的能咬，不是装饰。
- 第一轮的变异脚本 `mutate-official-form.mjs` 已删除：它的查找串针对的是
  "字面值那一版"的 CSS，本轮改完后 7/18 变成 SKIP，留着只会报出误导性的
  "survived 7"。其覆盖的键盘/焦点语义已全部并入新脚本（K1–K7）。
- 四条既有实测修复逐条保留，每条都有断言 + 变异钉住。

---

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
