# 变更记录

## 1.0.0

首次发布（未对外发布前的迭代都并入本条目）。

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
