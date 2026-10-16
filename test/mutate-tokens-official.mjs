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
const original = await readFile(CLIENT, "utf8");

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
  ["F6 Esc 不再挡 busy", ["if (event.repeat !== true && allowRef.current !== false) closeRef.current();", "if (event.repeat !== true) closeRef.current();"]],
  ["F7 卡片行描边退回 1px", ["  border: 0.5px solid var(--dsw-alias-settings-card-stroke); border-radius: var(--dsw-radius-xl);\n  background: var(--dsw-alias-settings-card-fill);\n}\n/* 官方卡片的悬停反馈就是这一条换底。 */", "  border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-xl);\n  background: var(--dsw-alias-settings-card-fill);\n}\n/* 官方卡片的悬停反馈就是这一条换底。 */"]],
  ["F8 徽标圆角退回 4px", ["  border-radius: 999px; corner-shape: round;", "  border-radius: 4px;"]],
  ["F9 徽标字重退回 400", ["  font-size: 11px; line-height: 17px; font-weight: 500;", "  font-size: 11px; line-height: 17px; font-weight: 400;"]],
  ["F10 小按钮圆角退回字面 8px", ["padding: 0 10px; border-radius: var(--dsw-radius-sm); }", "padding: 0 10px; border-radius: 6px; }"]],
  ["F11 徽标 outline 档描边退回 1px l2", [".dscc-badge-outline { border: 0.5px solid var(--dsw-alias-border-l4); }", ".dscc-badge-outline { border: 1px solid var(--dsw-alias-border-l2); }"]],

  // ── 官方 Modal 的键盘与焦点语义（第一轮建立，本轮换皮后必须仍然成立） ──
  ["K1 不处理 Esc", ["if (event.key === \"Escape\" && event.shiftKey !== true) {", "if (false) {"]],
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
];

let killed = 0;
let survived = 0;
const lines = [];

try {
  for (const [name, [find, replace]] of MUTANTS) {
    if (find === replace) {
      lines.push(`SKIP ${name} —— 查找与替换相同（变异写法无效）`);
      survived++;
      continue;
    }
    if (!original.includes(find)) {
      lines.push(`SKIP ${name} —— 原文未命中（变异写法与源码不一致，不是存活）`);
      survived++;
      continue;
    }
    await writeFile(CLIENT, original.replace(find, replace), "utf8");
    let green = true;
    try {
      await run("node", ["--test", "test/client.test.mjs", "test/render.test.mjs"], { cwd: root });
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
    await writeFile(CLIENT, original, "utf8");
  }
} finally {
  const now = await readFile(CLIENT, "utf8");
  if (now !== original) {
    lines.push("!! client.js 未还原，强制写回");
    await writeFile(CLIENT, original, "utf8");
  }
}

lines.push("", `killed ${killed} / survived ${survived}`);
console.log(lines.join("\n"));
