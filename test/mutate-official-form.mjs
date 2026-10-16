/**
 * 变异测试：对「官方形态」这一轮的改动逐一破坏，确认新增断言**真的会红**。
 * 通过标准：每个变异都必须至少让一条测试失败；全部存活 = 断言是装饰品。
 */
import { readFile, writeFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const CLIENT = new URL("../client.js", import.meta.url).pathname.replace(/^\//, "");
const original = await readFile(CLIENT, "utf8");

/** 每条变异：名字 + [查找, 替换]。替换必须真的改掉被断言钉住的那个行为。 */
const MUTANTS = [
  ["M1 按钮高度退回 32px", ["height: 36px;", "height: 32px;"]],
  ["M2 按钮圆角退回 7px", ["border-radius: 12px; /* 官方 md 圆角 */", "border-radius: 7px;"]],
  ["M3 按钮丢掉 nowrap", ["      white-space: nowrap;\n    }\n    .dscc-btn:disabled", "      }\n    .dscc-btn:disabled"]],
  ["M4 徽标圆角退回 4px", ["border-radius: 999px; padding: 1px 8px;", "border-radius: 4px; padding: 1px 7px;"]],
  ["M5 徽标字重退回 400", ["font-size: 11px; line-height: 17px; font-weight: 500;", "font-size: 11px; line-height: 17px; font-weight: 400;"]],
  ["M6 状态徽标退回纯文字色（无自着色底）", ["      background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent);\n      color: var(--dsw-alias-state-success-primary);", "      color: var(--dsw-alias-state-success-primary);"]],
  ["M7 弹窗丢掉 z-index（置顶 bug 复发）", ["position: fixed; inset: 0; z-index: 1000;", "position: fixed; inset: 0;"]],
  ["M8 卡片行圆角退回 8px", ["border: 1px solid var(--dsw-alias-border-l1); border-radius: 16px;\n  background: var(--dsw-alias-bg-layer-2);", "border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px;\n  background: var(--dsw-alias-bg-layer-2);"]],
  ["M9 主内容列丢掉 min-width:0（省略号失效）", [".dscc-row-main { min-width: 0; flex: 1 1 auto; }", ".dscc-row-main { flex: 1 1 auto; }"]],
  ["M10 Esc 不再挡 busy（删除中可被关掉）", ["if (event.repeat !== true && allowRef.current !== false) closeRef.current();", "if (event.repeat !== true) closeRef.current();"]],
  ["M11 不处理 Esc", ["if (event.key === \"Escape\" && event.shiftKey !== true) {", "if (false) {"]],
  ["M12 丢掉焦点陷阱（Tab 可走出卡片）", ["if (event.key !== \"Tab\") return;", "if (true) return;"]],
  ["M13 丢掉关闭还焦", ["          const target =\n            previous && previous.isConnected === true\n              ? previous\n              : null;", "          const target = null;"]],
  ["M14 丢掉 data-modal-autofocus 初始焦点", ["            element.querySelector(\"[data-modal-autofocus]\")) ??", "            null) ??"]],
  ["M15 按 class 翻宿主 DOM（R-25 违规）", ["          ? [...element.querySelectorAll(MODAL_FOCUSABLE)].filter(", "          ? [...element.querySelectorAll(\".some-host-class\")].filter("]],
  ["M16 小按钮刻度退回非官方值", [".dscc-btn-small { height: 28px; font-size: 12px; line-height: 18px; padding: 0 10px; border-radius: 8px; }", ".dscc-btn-small { height: 24px; font-size: 12px; line-height: 18px; padding: 0 8px; border-radius: 6px; }"]],
  ["M17 hover 换底不再排除变体（悬停即消失复发）", [".dscc-btn:not(.dscc-btn-primary):not(.dscc-btn-danger):not(:disabled):hover {", ".dscc-btn:not(:disabled):hover {"]],
  ["M18 可聚焦集合丢掉官方口径", ["      \"button:not([disabled])\",", "      \"button\","]],
];
let killed = 0;
let survived = 0;
const lines = [];

for (const [name, [find, replace]] of MUTANTS) {
  if (!original.includes(find)) {
    lines.push(`SKIP ${name} —— 原文未命中（变异写法与源码不一致，不是存活）`);
    survived++;
    continue;
  }
  const mutated = original.replace(find, replace);
  if (mutated === original) {
    lines.push(`SKIP ${name} —— 替换后无变化`);
    survived++;
    continue;
  }
  try {
    await writeFile(CLIENT, mutated, "utf8");
    let ok = true;
    try {
      await run("node", ["--test", "test/client.test.mjs", "test/render.test.mjs"], {
        cwd: new URL("..", import.meta.url).pathname.replace(/^\//, ""),
      });
    } catch (error) {
      ok = false;
      lines.push(`killed ${name}`);
    }
    if (ok) {
      lines.push(`SURVIVED ${name} —— 没有任何测试变红！`);
      survived++;
    } else {
      killed++;
    }
  } finally {
    await writeFile(CLIENT, original, "utf8");
  }
}

// 收尾：确认已还原
const restored = await readFile(CLIENT, "utf8");
if (restored !== original) {
  lines.push("!! 严重：client.js 未被还原，正在强制写回");
  await writeFile(CLIENT, original, "utf8");
}

lines.push("");
lines.push(`killed ${killed} / survived ${survived}`);
console.log(lines.join("\n"));
await rm(new URL("../node_modules/.tmp-mut", import.meta.url), { recursive: true, force: true });
