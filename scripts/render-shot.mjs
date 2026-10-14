/**
 * 生成 README 里的两张截图。
 *
 * 【为什么不用手画的示意图】README 要展示的是**真实组件长什么样**。手画「效果图」
 * 很容易在改版后与代码脱节，而且读者无法验证。所以这里走的是：
 *
 *   client.js 真实组件树 →（与 test/render.test.mjs 同源的 React 替身）真实渲染
 *                       →  HTML 字符串（内联 client.js 里那份真 CSS）
 *                       →  无头 Edge 栅格化 → PNG
 *
 * 也就是说：布局、文案、配色、状态徽标全部出自真实代码。
 * 唯一「非真实」的是行数据（演示用假会话）与主题令牌取值
 * （真实环境由宿主注入 `--dsw-*`，这里固定成浅色主题）。README 对此有明确说明。
 *
 * 用法：node scripts/render-shot.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, "..");
const OUT = join(PLUGIN, "docs", "assets");
const WORK = join(tmpdir(), `dscc-shot-${Date.now()}`);

mkdirSync(OUT, { recursive: true });
mkdirSync(WORK, { recursive: true });

// ── 1. 取出 client.js 里的 CSS（const CSS = `...`）──
const clientSrc = readFileSync(join(PLUGIN, "client.js"), "utf8");
const cssMatch = clientSrc.match(/const CSS = `([\s\S]*?)`;/);
if (!cssMatch) throw new Error("client.js 里找不到 const CSS = `...`");
const css = cssMatch[1];

// ── 2. 极小 React 替身（与 test/render.test.mjs 同源；只保留渲染所需）──
function makeReact() {
  const FRAGMENT = Symbol("Fragment");
  const hookStore = new Map();
  const depStore = new Map();
  let effects = [];
  let currentPath = "";

  const beginRender = () => {
    for (const r of hookStore.values()) r.used = 0;
    effects = [];
    currentPath = "";
  };
  const useHook = (init) => {
    const path = currentPath;
    let rec = hookStore.get(path);
    if (!rec) {
      rec = { hooks: [], used: 0 };
      hookStore.set(path, rec);
    }
    const index = rec.used++;
    if (!(index in rec.hooks)) rec.hooks[index] = typeof init === "function" ? init() : init;
    return { rec, index };
  };

  const React = {
    Fragment: FRAGMENT,
    createElement(type, props, ...children) {
      const flat = [];
      const push = (c) => {
        if (Array.isArray(c)) c.forEach(push);
        else if (c !== null && c !== undefined && c !== false && c !== true) flat.push(c);
      };
      children.forEach(push);
      return { type, props: props ?? {}, children: flat };
    },
    useState(initial) {
      const { rec, index } = useHook(initial);
      return [
        rec.hooks[index],
        (n) => {
          rec.hooks[index] = typeof n === "function" ? n(rec.hooks[index]) : n;
        },
      ];
    },
    useEffect(fn, deps) {
      const { rec, index } = useHook(undefined);
      effects.push({ fn, deps, path: currentPath, index });
      void rec;
    },
  };

  const flushEffects = () => {
    for (const e of effects) {
      const key = `${e.path}#${e.index}`;
      const prev = depStore.get(key);
      const same =
        prev !== undefined &&
        Array.isArray(e.deps) &&
        prev.length === e.deps.length &&
        e.deps.every((d, i) => Object.is(d, prev[i]));
      if (same) continue;
      depStore.set(key, Array.isArray(e.deps) ? e.deps.slice() : undefined);
      e.fn();
    }
  };

  const render = (node, path = "root") => {
    if (node === null || node === undefined || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map((c, i) => render(c, `${path}.${i}`));
    const { type, props, children } = node;
    if (type === FRAGMENT) return children.map((c, i) => render(c, `${path}.f${i}`));
    if (typeof type === "function") {
      const childPath = `${path}/${type.name || "anon"}`;
      const prev = currentPath;
      currentPath = childPath;
      let out;
      try {
        out = type({ ...props, children });
      } finally {
        currentPath = prev;
      }
      return render(out, childPath);
    }
    return { type, props, children: children.map((c, i) => render(c, `${path}.${i}`)) };
  };

  return { React, beginRender, render, flushEffects };
}

// ── 3. 加载 client.js、跑 apply、取回各 slot 的组件 ──
function boot(fetchImpl) {
  const react = makeReact();
  let definition = null;
  const run = new Function("window", "require", "URLSearchParams", "fetch", "navigator", clientSrc);
  run(
    { __ModuleLoader__: { load: (d) => { definition = d; } } },
    (id) => {
      if (id === "react") return react.React;
      throw new Error(`unexpected require(${id})`);
    },
    URLSearchParams,
    fetchImpl,
    { language: "zh-CN" } // 故意与宿主语言不一致：证明文案跟随宿主而非浏览器
  );
  if (definition === null) throw new Error("client.js 没有自注册");

  const registered = [];
  definition
    .factory((id) => {
      if (id === "react") return react.React;
      throw new Error(`unexpected require(${id})`);
    })
    .apply({
      logger: { warn() {}, debug() {}, info() {} },
      slots: {
        inject: (_k, cb) => cb(),
        register: (o, c) => {
          registered.push({ options: o, component: c });
          return () => {};
        },
      },
      locale: {
        register: () => () => {},
        getLocale: () => ({ active: "zh", locales: [], revision: 1 }),
        subscribe: () => () => {},
      },
      get: () => undefined,
      effect: (cb) => cb(),
    });

  return { ...react, registered };
}

// ── 4. 组件树 → HTML 字符串 ──
const ATTR_ALIAS = { className: "class", htmlFor: "for", tabIndex: "tabindex", readOnly: "readonly", autoFocus: "autofocus" };
const SKIP_PROPS = new Set(["children", "key", "dangerouslySetInnerHTML", "ref"]);
const VOID_TAGS = new Set(["input", "br", "img", "hr", "meta", "link"]);
const escapeHtml = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const escapeAttr = (s) => s.replace(/[&"<>]/g, (c) => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" })[c]);

function toHtml(node) {
  // 文本节点必须先判断：组件的文案常以 h('div', null, t('...')) 形式混在 children 里。
  if (node === null || node === undefined || node === false || node === true) return "";
  if (typeof node === "string" || typeof node === "number") return escapeHtml(String(node));
  if (Array.isArray(node)) return node.map(toHtml).join("");
  if (typeof node !== "object") return "";

  const { type, props, children } = node;
  const attrs = [];
  for (const [k, v] of Object.entries(props || {})) {
    if (SKIP_PROPS.has(k)) continue;
    if (v === null || v === undefined || v === false) continue;
    if (k === "style" && typeof v === "object") {
      const s = Object.entries(v)
        .map(([a, b]) => `${a.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase())}:${b}`)
        .join(";");
      attrs.push(`style="${escapeAttr(s)}"`);
      continue;
    }
    if (typeof v === "function") continue;
    const name = ATTR_ALIAS[k] ?? k;
    if (k === "value") {
      attrs.push(`value="${escapeAttr(String(v))}"`);
      continue;
    }
    if (v === true) {
      attrs.push(name);
      continue;
    }
    attrs.push(`${name}="${escapeAttr(String(v))}"`);
  }

  const extra = props?.children;
  const inner =
    children.map(toHtml).join("") +
    (Array.isArray(extra)
      ? extra.map(toHtml).join("")
      : typeof extra === "string" || typeof extra === "number"
        ? escapeHtml(String(extra))
        : "");

  const open = `<${type}${attrs.length ? " " + attrs.join(" ") : ""}>`;
  return VOID_TAGS.has(type) ? open : `${open}${inner}</${type}>`;
}

// ── 5. 演示数据（内容虚构，渲染路径 100% 真实）──
const projects = ["E:\\Code\\dsh-plugin-market", "E:\\Code\\dsh-dialogue-cleanup", "E:\\Code\\Personal-Web"];
const titles = [
  "对齐输入框：筛选区与搜索框右边界", "检查自身代码质量并优化性能",
  "复刻 dsh-plugin-market 的打包发布流程", "分类里加一个已归档的",
  "会话逻辑也不对，参考原项目", "字宽统一一下，改成和对话类型等宽",
  "设置页导航图标做成小扫把的样子", "检查 npm 有没有与本插件名重复的项目",
  "插件名称改为 dsh-dialogue-cleanup", "项目代码放入 E:\\Code 并发布到 github 和 npm",
  "删除所选按钮鼠标移上去会消失", "面板入口放置在设置页面",
  "正在读取会话清单太慢 还有删除逻辑有问题", "可视化面板：批量管理",
  "把 client.js 拆成独立文件", "语言跟随官方 harness 本体",
];
const items = titles.map((title, i) => ({
  sessionId: `0f${String(i).padStart(2, "0")}c4a1e-9b2d-4c7e-8a31-${String(100000 + i * 137).padStart(6, "0")}`,
  title,
  project: projects[i % projects.length],
  workspaceTitle: projects[i % projects.length].split("\\").pop(),
  running: i === 3 || i === 11,
  blank: false,
  live: i % 7 !== 5,
  persisted: true,
  archived: i % 5 === 4,
  subagent: i % 6 === 1,
  createdAt: new Date(Date.UTC(2026, 9, 14 - i, 9, 12)).toISOString(),
  updatedAt: new Date(Date.UTC(2026, 9, 14, 15, 30 - i)).toISOString(),
  deletable: !(i === 3 || i === 11),
  blockedReason: i === 3 || i === 11 ? "会话正在运行" : null,
}));

const listBody = {
  ok: true,
  value: {
    total: items.length,
    page: { page: 1, pageSize: 50, pages: 1 },
    items,
    projects,
    archived: { filter: "show", total: 4, known: true, subagentTotal: 3 },
    kind: { filter: "main", subagentTotal: 3, mainTotal: 13 },
    titles: { requested: items.length, cached: 11, fetched: 5, failed: 0, truncated: 0, skipped: false },
    tookMs: 42,
  },
};

const app = boot(async () => ({ status: 200, json: async () => listBody }));
const slotOf = (re) => app.registered.find((r) => re.test(r.options.name));
const paint = (entry, props = {}) => {
  app.beginRender();
  return app.render(app.React.createElement(entry.component, props));
};

// ── 截图 1：设置页里的批量管理面板 ──
const sectionEntry = slotOf(/section/i);
if (!sectionEntry) throw new Error("找不到 settings.section 注册项");
paint(sectionEntry, { close: () => {} });
app.flushEffects();
await new Promise((r) => setTimeout(r, 0));
paint(sectionEntry, { close: () => {} });
app.flushEffects();
await new Promise((r) => setTimeout(r, 0));
const panelTree = paint(sectionEntry, { close: () => {} });
app.flushEffects();

// ── 截图 2：确认框 ──
// 走真实路径：在面板里找到某一行「删除」按钮的 onClick 并调用它 —— 它会 setDialog(...)，
// 于是 overlay 组件下一次渲染就有内容（而不是手工拼一个确认框）。
const rows = [];
(function collect(node) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { node.forEach(collect); return; }
  const cls = typeof node.props?.className === "string" ? node.props.className : "";
  if (cls.includes("dscc-row")) rows.push(node);
  collect(node.children);
})(panelTree);

let targetBtn = null;
for (const row of rows) {
  let btn = null;
  (function walk(n) {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    const cls = typeof n.props?.className === "string" ? n.props.className : "";
    if (cls.includes("dscc-row-actions") && n.props?.disabled !== true) btn = n;
    walk(n.children);
  })(row);
  if (btn?.props?.onClick) { targetBtn = btn; break; }
}

const overlayEntry = slotOf(/overlay|scrim|confirm/i);
let dialogTree = null;
if (targetBtn && overlayEntry) {
  targetBtn.props.onClick({ preventDefault() {}, stopPropagation() {} });
  dialogTree = paint(overlayEntry, {});
} else {
  throw new Error(`未能走到确认框路径（targetBtn=${!!targetBtn} overlayEntry=${!!overlayEntry}）`);
}

// 原生 <dialog> 未经 showModal() 时默认 display:none。替身没有真实 DOM，
// showModal() 调不到，所以这里补上 open 属性 —— 等价于「showModal 已执行」，
// 不是伪造内容：真实环境由组件自己的 useEffect + showModal() 完成。
const asOpenDialog = (node) => {
  if (!node || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(asOpenDialog);
  const next = { ...node, props: { ...node.props }, children: node.children.map(asOpenDialog) };
  if (next.type === "dialog") next.props.open = true;
  return next;
};

// DSH 主题令牌取值（真实值由宿主注入 --dsw-*；此处固定浅色主题用于文档截图）
const themeVars = `
:root {
  --dsw-alias-bg-base: #ffffff;
  --dsw-alias-bg-elevated: #ffffff;
  --dsw-alias-bg-sunken: #f5f6f7;
  --dsw-alias-label-primary: #1a1a1a;
  --dsw-alias-label-secondary: #6b7280;
  --dsw-alias-label-tertiary: #9ca3af;
  --dsw-alias-border-l2: #e5e7eb;
  --dsw-alias-border-l3: #d1d5db;
  --dsw-alias-brand-primary: #4d6bfe;
  --dsw-alias-brand-primary-hover: #3f5ae0;
  --dsw-alias-state-error-primary: #dc2626;
  --dsw-alias-state-warn-primary: #d97706;
  --dsw-alias-state-success-primary: #16a34a;
  --dsw-alias-interactive-bg-hover: #f3f4f6;
}
body { margin: 0; padding: 24px; background: #f5f6f7; font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
.dscc-shot { width: 880px; margin: 0 auto; background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 20px 22px; }
/* 截图环境把 dialog 摆成居中卡片（真实环境由 showModal() 的 top layer 负责） */
dialog.dscc-modal[open] { position: static; display: block; border: 0; padding: 0; margin: 0; background: transparent; width: auto; height: auto; }
dialog.dscc-modal[open] .dscc-scrim { position: static; inset: auto; }
`;

const page = (inner) =>
  `<!doctype html><html lang="zh"><head><meta charset="utf-8"><style>${themeVars}\n${css}</style></head><body>${inner}</body></html>`;

writeFileSync(join(WORK, "panel.html"), page(`<div class="dscc-shot">${toHtml(panelTree)}</div>`), "utf8");
writeFileSync(
  join(WORK, "confirm.html"),
  page(`<div class="dscc-shot" style="width:420px">${toHtml(asOpenDialog(dialogTree))}</div>`),
  "utf8"
);

// ── 6. 无头 Edge 栅格化 ──
const EDGE_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/microsoft-edge",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];
const edge = EDGE_CANDIDATES.find((p) => existsSync(p));
if (!edge) {
  console.error(`找不到 Edge —— HTML 已生成在：${WORK}`);
  console.error("请安装 Microsoft Edge 后重跑，或自行对该 HTML 截图。");
  process.exit(2);
}

const shoot = (htmlName, pngName, w, h) => {
  const url = "file:///" + join(WORK, htmlName).replace(/\\/g, "/");
  const png = join(OUT, pngName);
  // --window-size 必须整体成串；拆成两个参数时 Edge 会把尺寸截断成首个数字。
  execFileSync(
    edge,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-device-scale-factor=2",
      `--user-data-dir=${join(WORK, "profile-" + pngName)}`,
      `--window-size=${w},${h}`,
      `--screenshot=${png}`,
      url,
    ],
    { stdio: "ignore" }
  );
  if (!existsSync(png)) throw new Error(`截图未生成：${png}`);
  return png;
};

shoot("panel.html", "panel.png", 940, 1180);
shoot("confirm.html", "confirm.png", 500, 400);

rmSync(WORK, { recursive: true, force: true });
console.log("已重新生成：docs/assets/panel.png、docs/assets/confirm.png");
