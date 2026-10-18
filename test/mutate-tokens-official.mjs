/**
 * 变异测试（第二轮：官方令牌 + 选择器药丸 + 死规则防线）。
 * 运行：node test/mutate-tokens-official.mjs
 * 通过标准：每个变异都至少让一条测试变红。存活 = 那条断言是装饰品。
 *
 * 【为什么文件名不带 .test.】它会改 client.js 再还原。若被
 * test 目录下的 test glob（test 下所有 .test.mjs 都会被收进套件）
 * 收进套件，会在套件内部二次运行，并把 client.js 留在变异态 ——
 * 这个坑真实踩到过一次（套件红一片）。
 */
import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLIENT = join(root, "client.js");
const SERVICE = join(root, "lib/service.js");
const original = await readFile(CLIENT, "utf8");
const originalService = await readFile(SERVICE, "utf8");
const ARTIFACTS = join(root, "lib/artifacts.js");
const originalArtifacts = await readFile(ARTIFACTS, "utf8");

const MUTANTS = [
  // ── 官方令牌被换回字面值（上一版"看着不像官方"的根因） ──
  ["T1 按钮圆角退回字面 12px", ["border: none; border-radius: var(--dsw-radius-md);", "border: none; border-radius: 12px;"]],
  ["T2 卡片行圆角退回字面 20px", ["border: 0.5px solid var(--dsw-alias-settings-card-stroke); border-radius: var(--dsw-radius-xl);", "border: 0.5px solid var(--dsw-alias-settings-card-stroke); border-radius: 20px;"]],
  ["T3 primary 底色退回 brand-primary", ["  background: var(--dsw-alias-button-primary-fill);", "  background: var(--dsw-alias-brand-primary);"]],
  ["T4 primary 前景退回 bg-base（旧 bug 源）", ["  color: var(--dsw-alias-label-primary-foreground);\n}\n.dscc-btn-primary:hover", "  color: var(--dsw-alias-bg-base);\n}\n.dscc-btn-primary:hover"]],
  ["T5 悬停底色退回 bg-layer-2 近似", [".dscc-btn:not(.dscc-btn-primary):not(.dscc-btn-danger):not(:disabled):hover {\n  background: var(--dsw-alias-interactive-bg-hover);", ".dscc-btn:not(.dscc-btn-primary):not(.dscc-btn-danger):not(:disabled):hover {\n  background: var(--dsw-alias-bg-layer-2);"]],
  ["T6 遮罩退回自凑 color-mix", ["  background: var(--dsw-alias-bg-mask-1);", "  background: color-mix(in srgb, var(--dsw-alias-bg-base) 45%, transparent);"]],
  ["T7 弹窗卡片圆角退回 12px", ["  border: 0; border-radius: var(--dsw-radius-panel);", "  border: 0; border-radius: 12px;"]],
  ["T8 搜索框描边退回 1px l1", ["  border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md);", "  border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md);"]],
  ["T9 用了官方悬空引用令牌", ["  animation: dscc-modal-enter .2s cubic-bezier(.4, 0, .2, 1);", "  animation: dscc-modal-enter var(--dsw-transition-duration) var(--dsw-ease-in-out);"]],
  ["T10 桌面框令牌丢掉 fallback", ["padding: max(24px, var(--dsh-frame-overlay-top, 24px)) 24px;", "padding: max(24px, var(--dsh-frame-overlay-top)) 24px;"]],

  // ── 选择器药丸 / 内联 Menu ──
  ["S1 药丸高度退回 32px", ["  width: 100%; height: 36px; padding: 0 14px;", "  width: 100%; height: 32px; padding: 0 14px;"]],
  ["S2 药丸丢掉 aria-haspopup", ['            "aria-haspopup": "menu",\n', ""]],
  ["S3 aria-expanded 恒为 false", ['aria-expanded": open,', 'aria-expanded": false,']],
  ["S4 下拉不贴触发器下方", ["  position: absolute; top: calc(100% + 4px); left: 0; z-index: 100;", "  position: absolute; top: 100%; left: 0; z-index: 100;"]],
  ["S5 下拉丢掉层级阴影", ["  box-shadow: var(--dsw-elevation-prominent);\n  /* 项目可能很多", "  /* 项目可能很多"]],
  ["S6 选中行不再标 aria-checked", ['"aria-checked": option.value === props.value,', '"aria-checked": false,']],
  ["S7 药丸底色退回近似令牌", ["  background: var(--dsw-alias-bg-module-platform);\n  color: var(--dsw-alias-label-primary);\n  font: inherit; font-size: 14px; line-height: 22px; cursor: pointer;", "  background: var(--dsw-alias-bg-layer-2);\n  color: var(--dsw-alias-label-primary);\n  font: inherit; font-size: 14px; line-height: 22px; cursor: pointer;"]],
  ["S8 点药丸不展开", ["onClick: () => setOpen((v) => !v),", "onClick: () => {},"]],

  // ── 死规则防线（本轮真实抓到的 bug） ──
  ["D1 搜索框外层丢掉 dscc-filters-search", ['{ className: "dscc-search dscc-filters-search" }', '{ className: "dscc-search" }']],
  ["D2 死规则写回 input 层（匹配不到元素）", [".dscc-search.dscc-filters-search { width: 100%; min-width: 0; }", ".dscc-input.dscc-filters-search { width: 100%; min-width: 0; }"]],

  // ── 既有实测修复不得丢 ──
  ["F1 按钮丢掉 nowrap", ["我们必须留。 */\n  white-space: nowrap;", "我们必须留。 */\n  white-space: normal;"]],
  ["F2 中性换底不再排除变体", [".dscc-btn:not(.dscc-btn-primary):not(.dscc-btn-danger):not(:disabled):hover {", ".dscc-btn:not(:disabled):hover {"]],
  ["F3 主内容列丢掉 min-width:0", [".dscc-row-main { min-width: 0; flex: 1 1 auto;", ".dscc-row-main { flex: 1 1 auto;"]],
  ["F4 徽标丢掉自着色底", ["  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent);\n  color: var(--dsw-alias-state-success-primary);", "  color: var(--dsw-alias-state-success-primary);"]],
  ["F5 弹窗丢掉 z-index", ["  position: fixed; inset: 0; z-index: 1000;", "  position: fixed; inset: 0;"]],
  // 【2026-10-18 迁移到原生 dialog】Esc 从 keydown 迁到 cancel 事件：
  // 保留「busy 不关」这条不变量的变异，但对准新的实现位置。
  ["F6 Esc 不再挡 busy（cancel 里丢掉 allowRef 判断）", ["          if (allowRef.current !== false) closeRef.current();", "          closeRef.current();"]],
  ["F7 卡片行描边退回 1px", ["  border: 0.5px solid var(--dsw-alias-settings-card-stroke); border-radius: var(--dsw-radius-xl);\n  background: var(--dsw-alias-settings-card-fill);\n}\n/* 官方卡片的悬停反馈就是这一条换底。 */", "  border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-xl);\n  background: var(--dsw-alias-settings-card-fill);\n}\n/* 官方卡片的悬停反馈就是这一条换底。 */"]],
  ["F8 徽标圆角退回 4px", ["  border-radius: 999px; corner-shape: round;", "  border-radius: 4px;"]],
  ["F9 徽标字重退回 400", ["  font-size: 11px; line-height: 17px; font-weight: 500;", "  font-size: 11px; line-height: 17px; font-weight: 400;"]],
  ["F10 小按钮圆角退回字面 8px", ["padding: 0 10px; border-radius: var(--dsw-radius-sm); }", "padding: 0 10px; border-radius: 6px; }"]],
  ["F11 徽标 outline 档描边退回 1px l2", [".dscc-badge-outline { border: 0.5px solid var(--dsw-alias-border-l4); }", ".dscc-badge-outline { border: 1px solid var(--dsw-alias-border-l2); }"]],

  // ── 官方 Modal 的键盘与焦点语义（第一轮建立，本轮换皮后必须仍然成立） ──
  // 【2026-10-18 迁移到原生 dialog】Esc 交给浏览器的 cancel 事件：
  // 「不处理 Esc」等价于不注册 cancel 监听。
  ["K1 不处理 Esc（不注册 cancel 监听）", ["        element.addEventListener(\"cancel\", onCancel);\n", ""]],
  ["K2 丢掉焦点陷阱（Tab 可走出卡片）", ["if (event.key !== \"Tab\") return;", "if (true) return;"]],
  ["K3 丢掉关闭还焦", ["          const target =\n            previous && previous.isConnected === true\n              ? previous\n              : null;", "          const target = null;"]],
  ["K4 丢掉 data-modal-autofocus 初始焦点", ["            element.querySelector(\"[data-modal-autofocus]\")) ??", "            null) ??"]],
  ["K5 按 class 翻宿主 DOM（R-25 违规）", ["          ? [...element.querySelectorAll(MODAL_FOCUSABLE)].filter(", "          ? [...element.querySelectorAll(\".some-host-class\")].filter("]],
  ["K6 可聚焦集合丢掉官方口径", ["      \"button:not([disabled])\",", "      \"button\","]],
  ["K7 菜单内 Tab 不再放行给菜单", ["if (active && typeof active.closest === \"function\" && active.closest('[role=\"menu\"]')) return;", "if (false) return;"]],

  // ── 死规则防线本身（它必须真的能咬） ──
  ["G1 引入一条 JSX 用不到的死规则", [".dscc-row-check:disabled { cursor: default; }", ".dscc-row-check:disabled { cursor: default; }\n.dscc-never-used { color: var(--dsw-alias-brand-primary); }"]],
  ["G2 勾选框丢掉官方焦点环", [".dscc-row-check:focus-visible {\n  outline: var(--dsw-focus-ring-width)", ".dscc-row-check:focus-visible {\n  outline: none"]],
  ["G3 按钮高度退回 32px", ["  height: 36px; padding: 0 14px;\n  border: none; border-radius: var(--dsw-radius-md);", "  height: 32px; padding: 0 14px;\n  border: none; border-radius: var(--dsw-radius-md);"]],
  ["G4 小按钮高度退回 24px", [".dscc-btn-small { height: 28px;", ".dscc-btn-small { height: 24px;"]],
  ["G5 徽标内边距退回 1px 7px", ["  border-radius: 999px; corner-shape: round;\n  padding: 1px 8px;", "  border-radius: 999px; corner-shape: round;\n  padding: 1px 7px;"]],
  // 选中一项却不把值传出去：药丸仍会显示新文字（activeLabel 从 options 找），
  // 所以**只看样式的测试全都会绿** —— 这条专门验证新加的功能测试真的能咬。
  ["G6 选中一项但不改变筛选", ["        if (option.value !== props.value && typeof props.onChange === \"function\") {\n          props.onChange(option.value);\n        }", "        if (false) {\n          props.onChange(option.value);\n        }"]],
  ["G7 把 label 当 value 传出去", ["          props.onChange(option.value);", "          props.onChange(option.label);"]],
  // 会话 id 的显示策略：有标题不显示、无标题必须显示。两个方向都要能咬。
  ["G8 一律显示 id（回到旧行为）", ["                  row.title ? null : h(\"code\", { className: \"dscc-row-id\" }, row.sessionId),", "                  h(\"code\", { className: \"dscc-row-id\" }, row.sessionId),"]],
  ["G9 一律不显示 id（丢掉无标题的例外）", ["                  row.title ? null : h(\"code\", { className: \"dscc-row-id\" }, row.sessionId),\n                  row.title ? null : h(\"span\", { className: \"dscc-row-sep\" }, \"·\"),", "                  null,\n                  null,"]],
  ["G10 悬停提示里也丢掉 id", ["                    title: `${row.sessionId} · ${row.project ?? \"—\"} · ${formatTime(row.updatedAt ?? row.createdAt)}`,\n                  },\n                  // 【例外】", "                    title: `${row.project ?? \"—\"} · ${formatTime(row.updatedAt ?? row.createdAt)}`,\n                  },\n                  // 【例外】"]],

  // ── 第三轮：搜索必须真的匹配标题 + 预算外如实上报（service.js + client.js） ──
  // 这一组针对本轮真实修复；每条都必须让至少一条测试变红。
  ["H1 搜索退回旧行为（不匹配 title）", ["          String(row.title ?? \"\").toLowerCase().includes(query) ||\n", ""], "service"],
  ["H2 关键词过滤不做标题补齐（回到 title 恒 null）", ["      await ensureTitles(items, titleSearchLimit);\n", ""], "service"],
  ["H3 预算外行数不报（假装全搜过）", ["      titleStat.truncated = overBudget.size;", "      titleStat.truncated = 0;"], "service"],
  ["H4 界面丢掉「结果可能不完整」提示", ["                ((titleStat.truncated ?? 0) > 0\n                  ? t(\"panel.costTruncated\", { n: titleStat.truncated })\n                  : \"\")", "                (\"\")"]],
  ["H5 计数不去重（两趟重复累加）", ["        const firstSeen = !counted.has(row.sessionId);\n        if (firstSeen) {\n          counted.add(row.sessionId);\n          titleStat.requested += 1;\n        }", "        const firstSeen = true;\n        if (firstSeen) {\n          titleStat.requested += 1;\n        }"], "service"],
  ["H6 当前页不再补标题（首屏标题全空）", ["    await ensureTitles(slice);", ""], "service"],
  ["H7 titleLimit=0 也去搜标题（最快路径失效）", ["      if (titleLimit === 0) {\n        titleStat.skipped = true;\n        return;\n      }", "      if (false) {\n        titleStat.skipped = true;\n        return;\n      }"], "service"],
  // 【性能回归 · 2026-10-17 实测】搜索的标题预算必须独立于 titleLimit：
  // 否则搜索会给整个候选集折叠标题（真机 pageSize=5 的搜索仍 requested=25、冷缓存 1059 ms）。
  ["H8 搜索误用 titleLimit（预算随候选集膨胀）", ["      await ensureTitles(items, titleSearchLimit);", "      await ensureTitles(items);"], "service"],
  ["H9 搜索预算被设成无穷（整候选集都读标题）", ["    const titleSearchLimit = Number.isInteger(config.titleSearchLimit)\n      ? Math.max(config.titleSearchLimit, 0)\n      : 40;", "    const titleSearchLimit = Number.POSITIVE_INFINITY;"], "service"],

  // ── 第四轮：弹窗必须进 top layer（用户实测「被设置页压住，要关设置才看得见」） ──
  // 这一组的每条都必须让测试变红，否则「弹窗置顶」就只是口号。
  ["M1 退回 div（脱离 showModal 后又被设置页压住）", ["        \"dialog\",\n        {", "        \"div\",\n        {"]],
  ["M2 不调用 showModal（留在普通层叠上下文里）", ["        if (typeof element.showModal === \"function\" && element.open !== true) {", "        if (false) {"]],
  ["M3 不幂等调用 showModal（重复打开抛 InvalidStateError）", ["        if (typeof element.showModal === \"function\" && element.open !== true) {", "        if (typeof element.showModal === \"function\") {"]],
  ["M4 关闭时不 close（dialog 永久留在 top layer）", ["          if (typeof element.close === \"function\" && element.open === true) {", "          if (false) {"]],
  ["M5 丢掉原生 cancel 拦截（busy 时 Esc 会关掉界面）", ["          event.preventDefault();\n          if (allowRef.current !== false) closeRef.current();", "          if (allowRef.current !== false) closeRef.current();"]],

  // ── 第五轮：整改修复的回归钉（越界删除 / 静默失败 / 对偶拼写误删） ──
  // 每条都必须让测试变红，否则「修好了」只是口号。
  ["N1 去掉真实路径校验（父组件 junction 可越界删除）", ["      if (!(await isRealPathInside(root, dir))) {", "      if (false) {"], "artifacts"],
  ["N2 readdir 错误重新被吞（磁盘失败又报成功）", ["    if (code === \"ENOENT\") {\n      rootPresent = false; // 根不存在：没有可删的东西，这是正常收尾\n    } else {\n      error = `${code ?? \"unknown\"}: ${String(cause?.message ?? cause)}`;\n    }", "    rootPresent = false;"], "artifacts"],
  ["N3 rm 失败不再记录（静默跳过）", ["        failures.push(`${dir} :: ${cause?.code ?? \"unknown\"}: ${String(cause?.message ?? cause)}`);\n      }\n    }\n  }\n\n  return { count: removed.length, paths: removed, skipped, failures", "        void cause;\n      }\n    }\n  }\n\n  return { count: removed.length, paths: removed, skipped, failures"], "artifacts"],
  ["N4 lstat 非 ENOENT 错误重新被吞", ["        if (cause?.code !== \"ENOENT\") {\n          failures.push(`${dir} :: lstat ${cause?.code ?? \"unknown\"}: ${String(cause?.message ?? cause)}`);\n        }\n        continue; // ENOENT 确实等于「不存在」——正常跳过", "        continue;"], "artifacts"],
  ["N5 对偶拼写守卫不查持久语料（误删另一个会话）", ["      if (persistedIds !== null && persistedIds !== undefined && persistedIds.has(id)) return true;\n", ""], "service"],
  ["N6 守卫不可用时仍然放行删除（宁可误删）", ["        const guardUsable = config.matchAlternateIdSpelling === true && persistedIds !== null;\n        const isKnownSession = guardUsable ? makeKnownSessionProbe(liveIds, persistedIds) : null;", "        const isKnownSession = makeKnownSessionProbe(liveIds, persistedIds);"], "service"],
  ["N7 partial 退回窄定义（磁盘失败被报成完整成功）", ["          partial: degradations.length > 0,", "          partial: !detached && artifacts.count === 0,"], "service"],
  ["N8 complete 不再反映降级清单", ["        value.complete = value.degradations.length === 0;", "        value.complete = true;"], "service"],
  ["N9 删除不再取新鲜快照（吃过期 TTL 缓存）", ["          : await freshRunningSnapshot();", "          : await runningSnapshot();"], "service"],
];

let killed = 0;
let survived = 0;
const lines = [];

try {
  for (const [name, [find, replace], target] of MUTANTS) {
    const file = target === "service" ? SERVICE : target === "artifacts" ? ARTIFACTS : CLIENT;
    const source = target === "service" ? originalService : target === "artifacts" ? originalArtifacts : original;
    if (find === replace) {
      lines.push(`SKIP ${name} —— 查找与替换相同（变异写法无效）`);
      survived++;
      continue;
    }
    if (!source.includes(find)) {
      lines.push(`SKIP ${name} —— 原文未命中（变异写法与源码不一致，不是存活）`);
      survived++;
      continue;
    }
    await writeFile(file, source.replace(find, replace), "utf8");
    let green = true;
    try {
      // 【关键】fault-injection 必须同时在 service 与 artifacts 两组里跑：
      // 它是本轮整改的核心断言。漏掉它会让 N5–N8 这类「把修复改回旧行为」的变异
      // 全部存活（实测踩到过：7 条存活其实是我的测试没跑）。
      const suite = target === "service"
        ? ["--test", "test/contract.test.mjs", "test/service.test.mjs", "test/fault-injection.test.mjs"]
        : target === "artifacts"
          ? ["--test", "test/artifacts.test.mjs", "test/fault-injection.test.mjs"]
          : ["--test", "test/client.test.mjs", "test/render.test.mjs"];
      await run("node", suite, { cwd: root });
    } catch {
      green = false;
    }
    if (green) {
      lines.push(`SURVIVED ${name} —— 没有任何测试变红！`);
      survived++;
    } else {
      lines.push(`killed ${name}`);
      killed++;
    }
    await writeFile(file, source, "utf8");
  }
} finally {
  // 三个被变异的目标文件都必须回到原文（脚本改完要还原，否则套件会跑在变异态上）。
  for (const [file, source] of [[CLIENT, original], [SERVICE, originalService], [ARTIFACTS, originalArtifacts]]) {
    const now = await readFile(file, "utf8");
    if (now !== source) {
      lines.push(`!! ${file} 未还原，强制写回`);
      await writeFile(file, source, "utf8");
    }
  }
}

lines.push("", `killed ${killed} / survived ${survived}`);
console.log(lines.join("\n"));
