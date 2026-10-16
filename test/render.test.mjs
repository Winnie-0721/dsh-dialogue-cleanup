/**
 * 客户端组件的**渲染**测试（此前完全空白）。
 *
 * 为什么需要：`client.test.mjs` 只验证「注册面」——slot 注册了、cleanup 存在、
 * 文案 key 对齐。它**从不渲染任何组件**，所以组件体里的任何错误
 * （未定义变量、hooks 用错、访问 undefined 的属性、条件调用 hook）都不会被发现，
 * 只有用户打开设置页时才会炸。这里用一个**极小的 React 替身**真正把组件跑一遍。
 *
 * 替身只实现 client.js 实际用到的 4 个 API（现场 grep 确认）：
 *   createElement / Fragment / useState / useEffect
 * 因此它不是「假装渲染」——组件体、JSX 组装、子组件调用与 hooks 顺序都会被真实执行。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const CLIENT_PATH = join(here, "..", "client.js");

/**
 * 极小的 React 替身 + 递归渲染器。
 *
 * 关键点：函数组件必须被**递归调用**（`DialogueCleanupSection` 自己不含 hooks，
 * 真正的 hooks 在它渲染的 `DialogueCleanupPanel` 里）。只调用最外层组件等于什么都没验。
 * hook 状态按「实例路径」存放，因此：
 *   - 单次渲染内组件体被真实执行 → 未定义变量、访问 undefined、条件 hook 都会暴露；
 *   - 同一路径跨两次渲染的 hook 数量可比对 → 能抓到「条件调用 hook」。
 */
function makeReact() {
  const FRAGMENT = Symbol("Fragment");
  const hookStore = new Map();
  const effects = []; // 每次 beginRender 重置：本轮的 effect 队列
  const depStore = new Map(); // 实例路径+hook 序号 → 上次的 deps（浅比较用）
  const effectCleanups = []; // 各轮 effect 返回的清理函数
  let currentPath = "";

  function beginRender() {
    // 【关键】只重置「本次渲染用了几格」，**保留** hooks 的值 ——
    // 这正是 React 的语义：state 跨渲染存活。早期版本把整个 store 清空，
    // 导致「异步取数后重渲染就能看到列表」这类行为无法测试。
    for (const record of hookStore.values()) record.used = 0;
    effects.length = 0;
    currentPath = "";
  }

  function useHook(init) {
    const path = currentPath;
    let record = hookStore.get(path);
    if (record === undefined) {
      record = { hooks: [], used: 0 };
      hookStore.set(path, record);
    }
    const index = record.used;
    record.used += 1;
    if (!(index in record.hooks)) {
      record.hooks[index] = typeof init === "function" ? init() : init;
    }
    return { record, index };
  }

  const React = {
    Fragment: FRAGMENT,
    createElement(type, props, ...children) {
      const flat = [];
      const push = (child) => {
        if (Array.isArray(child)) child.forEach(push);
        else if (child !== null && child !== undefined && child !== false && child !== true) flat.push(child);
      };
      children.forEach(push);
      return { type, props: props ?? {}, children: flat };
    },
    useState(initial) {
      const { record, index } = useHook(initial);
      const set = (next) => {
        record.hooks[index] = typeof next === "function" ? next(record.hooks[index]) : next;
      };
      return [record.hooks[index], set];
    },
    useEffect(fn, deps) {
      const { record, index } = useHook(undefined);
      effects.push({ fn, deps, path: currentPath, index });
      void record;
    },
  };

  /**
   * 执行本轮收集到的 effect —— **React 在提交阶段做的事**。
   *
   * 为什么必须有：不跑 effect，`fetchList` 永远不会被调用，
   * 面板就永远停在 loading 态，任何「列表渲染成什么样」的断言都无从谈起。
   * deps 按「实例路径 + hook 序号」记录，浅比较相同就跳过（对齐 React 语义）。
   */
  function flushEffects() {
    const ran = [];
    for (const effect of effects) {
      const key = `${effect.path}#${effect.index}`;
      const prev = depStore.get(key);
      const same =
        prev !== undefined &&
        Array.isArray(effect.deps) &&
        Array.isArray(prev) &&
        effect.deps.length === prev.length &&
        effect.deps.every((d, i) => Object.is(d, prev[i]));
      if (same) continue;
      depStore.set(key, Array.isArray(effect.deps) ? effect.deps.slice() : undefined);
      const cleanup = effect.fn();
      if (typeof cleanup === "function") effectCleanups.push(cleanup);
      ran.push(effect);
    }
    return ran;
  }

  /**
   * 递归展开函数组件，返回纯宿主元素树（type 为字符串）。
   * @param {any} node
   * @param {string} path 实例路径（决定 hook 归属）
   */
  function render(node, path = "root") {
    if (node === null || node === undefined || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map((child, i) => render(child, `${path}.${i}`));

    const { type, props, children } = node;

    // Fragment：直接展开子节点
    if (type === FRAGMENT) return children.map((child, i) => render(child, `${path}.f${i}`));

    // 函数组件：真实调用它
    if (typeof type === "function") {
      const name = type.name || "anon";
      const childPath = `${path}/${name}`;
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

    // 宿主元素
    return {
      type,
      props,
      children: children.map((child, i) => render(child, `${path}.${i}`)),
    };
  }

  return { React, beginRender, effects, hookStore, render, flushEffects, effectCleanups };
}

/** 载入 client.js 并取出 factory 产物（与注册面测试同样的加载方式）。 */
function loadModule(reactStub, { navigatorLanguage = "zh-CN", fetchImpl } = {}) {
  const source = readFileSync(CLIENT_PATH, "utf8");
  let definition = null;
  const run = new Function("window", "require", "URLSearchParams", "fetch", "navigator", source);
  run(
    { __ModuleLoader__: { load: (def) => { definition = def; } } },
    (id) => {
      if (id === "react") return reactStub;
      throw new Error(`unexpected require(${id})`);
    },
    URLSearchParams,
    fetchImpl ?? (async () => { throw new Error("fetch must not be called"); }),
    { language: navigatorLanguage },
  );
  assert.ok(definition !== null, "client.js 必须自注册");
  return definition.factory((id) => {
    if (id === "react") return reactStub;
    throw new Error(`unexpected require(${id})`);
  });
}

/** 假 slots：记录注册项，便于按 name 取出组件。 */
function makeSlots() {
  const registered = [];
  const slots = {
    inject(_key, callback) { return callback(); },
    register(options, component) {
      registered.push({ options, component });
      return () => {};
    },
  };
  return { slots, registered };
}

/**
 * 把 apply 跑起来，返回按 slot 名索引的组件与已注册的 locale 翻译函数。
 */
function boot({ navigatorLanguage = "zh-CN", fetchImpl, hostActive = "zh", withBind = false } = {}) {
  const react = makeReact();
  const { React, beginRender, render, flushEffects, effectCleanups } = react;
  const module = loadModule(React, { navigatorLanguage, fetchImpl });
  const { slots, registered } = makeSlots();

  const state = { active: hostActive };
  const subscribers = [];
  const locale = {
    register: () => () => {},
    getLocale: () => ({ active: state.active, locales: [], revision: 1 }),
    subscribe(fn) {
      subscribers.push(fn);
      return () => {
        const at = subscribers.indexOf(fn);
        if (at >= 0) subscribers.splice(at, 1);
      };
    },
  };
  if (withBind) locale.bind = () => (key) => `bound:${key}`;

  const cleanups = [];
  const ctx = {
    logger: { warn() {}, debug() {}, info() {} },
    slots,
    locale,
    get: () => undefined,
    effect(callback) {
      const cleanup = callback();
      cleanups.push(cleanup);
      return cleanup;
    },
  };
  module.apply(ctx);

  const byName = new Map();
  for (const entry of registered) byName.set(entry.options.name, entry);

  return {
    React,
    beginRender,
    render,
    flushEffects,
    effectCleanups,
    hookStore: react.hookStore,
    byName,
    applyCleanups() {
      for (const fn of cleanups.slice()) if (typeof fn === "function") fn();
    },
    /** 模拟宿主 setLocale：改活动语言并通知订阅者（真实契约会 bump revision）。 */
    setActive(next) {
      state.active = next;
      for (const fn of subscribers.slice()) fn();
    },
  };
}

/** 深度遍历渲染树，收集所有 type 为字符串的标签名。 */
function collectTags(node, out = []) {
  if (node === null || node === undefined || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) collectTags(child, out);
    return out;
  }
  if (typeof node.type === "string") out.push(node.type);
  for (const child of node.children ?? []) collectTags(child, out);
  // props.children 也可能是元素
  const pc = node.props?.children;
  if (pc !== undefined) collectTags(pc, out);
  return out;
}

/** 收集所有字符串文本，便于断言文案渲染结果。 */
function collectText(node, out = []) {
  if (node === null || node === undefined) return out;
  if (typeof node === "string" || typeof node === "number") { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const c of node) collectText(c, out); return out; }
  if (typeof node !== "object") return out;
  for (const child of node.children ?? []) collectText(child, out);
  return out;
}

/**
 * 计算某元素上某个属性的**级联胜出值** —— 而不是「规则里有没有写这个声明」。
 *
 * 【为什么需要它】审计指出：原来的 CSS 断言只检查「规则文本里存在 width:auto」，
 * 于是两条**实际从未生效**的规则（.dscc-filters-search 的 width:auto、
 * .dscc-panel-section 的 padding/height）都能让测试变绿。
 * 这不是测试写漏了，是**断言的层次错了**。
 *
 * 这里按 CSS 级联规范取值：
 *   ① 只保留「选择器命中该元素」的规则；
 *   ② 比优先级 (a,b,c) —— id 数 / 类+属性+伪类数 / 元素数；
 *   ③ 优先级相同则比**源码顺序**，后者胜。
 *
 * 只支持本文件用到的简单选择器（类、元素、与它们的组合），够用且不引入依赖。
 *
 * @param {string} sheet  CSS 文本
 * @param {string} classList 元素上实际带的类（空格分隔）
 * @param {string} prop  属性名
 * @returns {string|null} 胜出的声明值（已去空白），无候选则 null
 */
function cascadeWinner(sheet, classList, prop) {
  const classes = classList.split(/\s+/).filter(Boolean);
  const declRe = /(^|\n)\s*([^{}\n]+?)\s*\{([^}]*)\}/g;
  const hits = [];
  let m;
  while ((m = declRe.exec(sheet)) !== null) {
    const decls = m[3];
    const pm = new RegExp("(?:^|;)\\s*" + prop + "\\s*:\\s*([^;]+)").exec(decls);
    if (pm === null) continue;
    for (const rawSel of m[2].split(",")) {
      const sel = rawSel.trim();
      if (sel === "" || /[>+~:[\]@]/.test(sel)) continue; // 只处理简单选择器
      const parts = sel.split(/\s+/).filter(Boolean);
      // 类必须都在元素上；不含类的组合（如 `div`）按元素名匹配，本用例中一律视为命中
      const needClasses = parts.flatMap((p) => (p.match(/\.[\w-]+/g) ?? []).map((x) => x.slice(1)));
      if (!needClasses.every((c) => classes.includes(c))) continue;
      const a = (sel.match(/#[\w-]+/g) ?? []).length;
      const b = (sel.match(/\.[\w-]+/g) ?? []).length;
      const c = parts.filter((p) => /^[a-zA-Z]/.test(p)).length;
      hits.push({ sel, spec: a * 1e6 + b * 1e3 + c, order: m.index, val: pm[1].trim() });
    }
  }
  if (hits.length === 0) return null;
  hits.sort((x, y) => x.spec - y.spec || x.order - y.order);
  return hits[hits.length - 1].val;
}

const MENU_SLOT = "sidebar.workspaces.session.menu.item";
const OVERLAY_SLOT = "shell.overlay";
const SECTION_SLOT = "settings.section";

test("渲染：会话行菜单项能渲染出 role=menuitem 的按钮（不抛错）", () => {
  const app = boot();
  const entry = app.byName.get(MENU_SLOT);
  assert.ok(entry, "菜单项必须已注册");

  app.beginRender();
  const tree = app.render(
    app.React.createElement(entry.component, {
      sessionId: "session-abc",
      displayTitle: "某个会话",
      useMenuOpenState: () => [false, () => {}],
      t: (key) => key,
    }),
  );
  assert.ok(tree, "必须渲染出树");

  const tags = collectTags(tree);
  assert.ok(tags.includes("button"), "必须渲染出一个 button");
  // Fragment 已被渲染器展开，因此顶层就是 [分隔线, button]
  const button = tree.find((node) => node.type === "button");
  assert.ok(button, "必须找到 button 元素");
  assert.equal(button.props.role, "menuitem", "button 必须带 role=menuitem");

  // 【实测修复 · H1 回归】菜单项必须**自带样式表**。
  //
  // 会话行右侧「⋮」菜单在 sidebar 的 slot 里渲染，与设置面板**不共享 React 树**；
  // 原实现只在 DeleteDialog / 面板里渲染 <Styles>，于是菜单项完全没有样式
  // （`.dscc-menu-row` / `.dscc-sep` 全部不生效），直到打开弹窗或设置页才短暂生效。
  // 已用真实渲染取证过：修复前标签序列不含 style。
  assert.ok(
    tags.includes("style"),
    `菜单项必须自带 <style>，否则 .dscc-menu-row 等规则不生效（实际标签：${tags.join(",")}）`,
  );
  const styleNode = tree.find((node) => node.type === "style");
  assert.ok(styleNode, "必须能取到 style 元素");
  assert.equal(styleNode.props["data-dscc"], "styles", "style 必须带 data-dscc 标记（便于识别与去重）");
  assert.ok(
    String(styleNode.children[0]).includes(".dscc-menu-row"),
    "样式表内容必须包含菜单项用到的 .dscc-menu-row",
  );
});

test("渲染：useMenuOpenState 缺席时菜单项仍能渲染（优雅降级）", () => {
  const app = boot();
  const entry = app.byName.get(MENU_SLOT);
  app.beginRender();
  // 官方契约承诺注入 useMenuOpenState，但要防它缺失时整行崩掉
  const tree = app.render(
    app.React.createElement(entry.component, { sessionId: "s1", displayTitle: "t" }),
  );
  assert.ok(tree);
  assert.ok(collectTags(tree).includes("button"));
});

test("渲染：确认弹窗在无状态时返回 null，有状态时渲染 dialog", () => {
  const app = boot();
  const entry = app.byName.get(OVERLAY_SLOT);
  assert.ok(entry, "overlay 必须已注册");

  // 1) 无对话框状态 → 不渲染任何东西
  app.beginRender();
  assert.equal(
    app.render(app.React.createElement(entry.component, {})),
    null,
    "没有待确认操作时必须渲染 null",
  );

  // 2) 打开确认框：通过菜单项的点击处理器触发模块级 dialog 状态
  const menu = app.byName.get(MENU_SLOT);
  app.beginRender();
  const menuTree = app.render(
    app.React.createElement(menu.component, {
      sessionId: "session-abc",
      displayTitle: "某个会话",
      useMenuOpenState: () => [false, () => {}],
      t: (key) => key,
    }),
  );
  const button = menuTree.find((node) => node.type === "button");
  button.props.onClick(); // 触发 setDialog

  app.beginRender();
  const dialogTree = app.render(app.React.createElement(entry.component, {}));
  assert.ok(dialogTree !== null, "点击后必须渲染确认框");

  // 【修复后契约】外层是 div（官方 Modal 同样不是原生 dialog），
  // 层级由 .dscc-modal 的 position:fixed + z-index:1000 负责，
  // 语义（role/aria-modal/aria-label）挂在外层；内层卡片不得再声明 role。
  assert.equal(dialogTree.type, "div", "外层必须是 div（官方 Modal 形态：fixed + z-index）");
  assert.equal(dialogTree.props.className, "dscc-modal", "外层必须挂 .dscc-modal（z-index:1000 置顶）");
  assert.equal(dialogTree.props.role, "dialog", "外层必须带 role=dialog");
  assert.equal(dialogTree.props["aria-modal"], "true", "必须声明 aria-modal");
  assert.ok(
    typeof dialogTree.props["aria-label"] === "string" && dialogTree.props["aria-label"].length > 0,
    "外层必须带 aria-label（无标题对话框的可访问名）",
  );

  // 必须挂 ref：焦点陷阱与 Esc 由 useModalLayer 经这个 ref 拿到卡片元素。
  const ref = dialogTree.props.ref;
  assert.ok(ref && typeof ref === "object", "必须挂 ref 以便 useModalLayer 读取卡片元素");

  // 确认框必须显示要删的会话标题，用户才能复核
  assert.match(collectText(dialogTree).join(" "), /某个会话/);

  // 内层卡片不得重复声明 role（嵌套 dialog 是可访问性缺陷）
  const innerRoles = [];
  (function walk(node) {
    if (node === null || node === undefined || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.props?.className === "dscc-card" && node.props?.role) innerRoles.push(node.props.role);
    for (const c of node.children ?? []) walk(c);
  })(dialogTree);
  assert.deepEqual(innerRoles, [], "内层卡片不得再声明 role（外层已声明模态语义）");
});

test("渲染：设置页面板首屏渲染出标题、工具条与加载态（不抛错）", () => {
  const app = boot();
  const entry = app.byName.get(SECTION_SLOT);
  assert.ok(entry, "设置页 section 必须已注册");

  app.beginRender();
  // 经真实渲染器展开：Section → Panel（hooks 都在 Panel 里）
  const tree = app.render(app.React.createElement(entry.component, { close: () => {} }));
  assert.ok(tree, "必须渲染出树");

  const text = collectText(tree).join(" ");
  assert.ok(text.length > 0, "必须渲染出文案");
  assert.match(text, /对话清理/, "首屏必须显示面板标题");
  const tags = collectTags(tree);
  assert.ok(tags.includes("div"), "必须渲染容器");
  assert.ok(tags.includes("style"), "样式必须以 React 元素形式随组件渲染（R-29）");
});

test("渲染：面板首屏请求失败时渲染错误态而不是崩溃", async () => {
  const app = boot({
    fetchImpl: async () => { throw new Error("network down"); },
  });
  const entry = app.byName.get(SECTION_SLOT);
  app.beginRender();
  const tree = app.render(app.React.createElement(entry.component, { variant: "section" }));
  assert.ok(tree, "网络不可用时首屏仍必须渲染");
  assert.match(collectText(tree).join(" "), /对话清理/);
});

test("渲染：hooks 数量在两次渲染间保持一致（不得条件调用 hook）", () => {
  const app = boot();
  const entry = app.byName.get(SECTION_SLOT);

  const renderOnce = () => {
    app.beginRender();
    app.render(app.React.createElement(entry.component, {}));
    // 每次渲染后，看每个组件实例消费了多少 hook
    const counts = {};
    for (const [path, record] of app.hookStore) counts[path] = record.used;
    return counts;
  };

  const first = renderOnce();
  const second = renderOnce();

  const paths = Object.keys(first);
  assert.ok(paths.length > 0, "必须真实执行到含 hooks 的组件");
  assert.ok(
    Object.values(first).some((n) => n > 0),
    "至少要有一个组件使用了 hooks",
  );
  assert.deepEqual(second, first, "hooks 数量/路径在两次渲染间必须完全一致");
});

test("渲染：切换宿主语言后设置页标签跟着变（端到端渲染验证）", () => {
  const app = boot({ hostActive: "zh", navigatorLanguage: "en-US" });
  const entry = app.byName.get(SECTION_SLOT);
  assert.match(entry.options.label(), /对话清理/);

  app.setActive("en");
  assert.match(entry.options.label(), /Dialogue Cleanup/, "label 必须按调用时读取活动语言");
});

/**
 * 【语言权威路径回归】必须优先使用框架注入的 `t` 席位。
 *
 * 官方 `@deepseek-ai/dsh-client-locale` README 的实现小节明确：
 *  「`LocaleRuntime` 自身就是 slot 系统的 `LocaleFace`，`getSnapshot`/`subscribe`
 *    支撑**框架注入的 `t` 席位**」，且「产品编写的 Client UI 文本必须来自这些带类型的
 *    字典，或来自已经本地化的 primitive prop」。
 *
 * 因此 `props.t` 是第一优先级；它缺席时才退到 `ctx.locale.bind(ns)`，最后才内置表。
 * 这里用一个可识别的假席位验证真的走了它。
 */
test("渲染：面板优先用注入的 t 席位（官方权威路径）", () => {
  const app = boot({ hostActive: "zh" });
  const entry = app.byName.get(SECTION_SLOT);

  app.beginRender();
  const tree = app.render(
    app.React.createElement(entry.component, {
      close: () => {},
      // 假席位：给每个 key 打上可识别前缀，证明文案确实来自它
      t: (key) => `seat:${key}`,
    }),
  );
  const text = collectText(tree).join(" ");
  assert.match(text, /seat:panel\.title/, "必须有文案来自注入的 t 席位");
});

test("渲染：t 席位缺席时自动退到 bind / 内置表（不得渲染成原始 key）", () => {
  const app = boot({ hostActive: "zh", withBind: true });
  const entry = app.byName.get(SECTION_SLOT);
  app.beginRender();
  const tree = app.render(app.React.createElement(entry.component, { close: () => {} }));
  const text = collectText(tree).join(" ");
  // bind 可用时应优先于内置表
  assert.match(text, /bound:panel\.title/, "t 缺席时必须退到 locale.bind(ns)");
});

/**
 * 归档三选一必须在界面上可用（取值照官方 `archivedFilter: default|show|only`）。
 * 文案：隐藏已归档 / 全部对话（显示已归档）/ 仅显示已归档。
 *
 * 【默认值是 show 而非官方的 default】本插件是清理工具，归档 ≠ 删除（仍占磁盘），
 * 默认隐藏已归档会让用户看不到本该能清理的会话。用户明确要求默认显示已归档。
 */
/**
 * 取出某个筛选字段的「选择器药丸」，并展开它的下拉。
 *
 * 【为什么不是找 select】原生 select 的下拉面板由操作系统绘制 —— 直角、
 * 不跟随主题，正是用户报「不统一」的主要来源。官方在同一个设置页里
 * （dsh-client-locale 的语言行）用的是 button 药丸 + primitives 的 Menu，
 * 本插件照抄，所以这里必须按新形态取：
 *   .dscc-field（display:contents）
 *     ├ .dscc-field-label   可见标签
 *     └ .dscc-select-root   SelectMenu 的根
 *         ├ button.dscc-selector   药丸（aria-haspopup=menu）
 *         └ div.dscc-menu（仅 open 时）> button.dscc-menu-item
 *
 * 展开方式：调药丸的 onClick 把 open 翻成 true，再渲染一次。
 * 这个替身的 useState 跨渲染保留值（见 makeReact 的注释），所以可行。
 */
function filterFields(app, tree) {
  const fields = [];
  (function walk(node) {
    if (node === null || node === undefined || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const cls = typeof node.props?.className === "string" ? node.props.className.split(/\s+/) : [];
    if (cls.includes("dscc-field")) {
      const kids = node.children ?? [];
      const span = kids.find(
        (c) => typeof c?.props?.className === "string" && c.props.className.includes("dscc-field-label"),
      );
      const root = kids.find(
        (c) => typeof c?.props?.className === "string" && c.props.className.includes("dscc-select-root"),
      );
      if (span !== undefined && root !== undefined) {
        fields.push({ label: collectText(span).join(""), root });
      }
    }
    for (const c of node.children ?? []) walk(c);
  })(tree);
  return fields;
}

/** 药丸按钮（含当前值文字与 aria 属性）。 */
function selectorOf(field) {
  const button = (field.root.children ?? []).find(
    (c) => c?.type === "button" && typeof c.props?.className === "string" && c.props.className.includes("dscc-selector"),
  );
  return button ?? null;
}

/** 展开该字段并返回下拉项（value 从 aria/文字取不到，故返回文字 + 节点）。 */
function openDropdown(app, field) {
  const trigger = selectorOf(field);
  assert.ok(trigger, `字段「${field.label}」必须渲染出选择器药丸`);
  trigger.props.onClick();
  app.beginRender();
  const entry = app.byName.get(SECTION_SLOT);
  const again = app.render(app.React.createElement(entry.component, { close: () => {} }));
  const refound = filterFields(app, again).find((f) => f.label === field.label);
  const menu = (refound?.root.children ?? []).find(
    (c) => typeof c?.props?.className === "string" && c.props.className.split(/\s+/).includes("dscc-menu"),
  );
  return { menu, trigger: selectorOf(refound) ?? trigger };
}

test("渲染：面板提供归档三选一（默认显示已归档）", () => {
  const app = boot({ hostActive: "zh" });
  const entry = app.byName.get(SECTION_SLOT);
  app.beginRender();
  const tree = app.render(app.React.createElement(entry.component, { close: () => {} }));

  const fields = filterFields(app, tree);
  assert.ok(fields.length >= 5, `必须有 5 个带可见标签的筛选控件，实际 ${fields.length}`);

  // 每个控件都必须有可见标签 + 药丸 + aria-haspopup（官方语言行同款）。
  for (const field of fields) {
    const trigger = selectorOf(field);
    assert.ok(trigger, `字段「${field.label}」必须有选择器药丸（不得回到原生 select）`);
    assert.equal(trigger.props["aria-haspopup"], "menu", "药丸必须声明 aria-haspopup=menu（官方同款）");
    assert.equal(trigger.props["aria-expanded"], false, "未展开时 aria-expanded 必须是 false");
  }
  // 结构不变量：源码里不得再出现原生 select 元素。
  const source = readFileSync(CLIENT_PATH, "utf8");
  assert.equal(
    /h\(\s*"select"/.test(source),
    false,
    "不得再渲染原生 select —— 它的下拉面板由操作系统绘制，与官方主题割裂",
  );

  const archived = fields.find((f) => f.label === "归档");
  assert.ok(archived, "必须渲染出「归档」筛选字段（且带可见标签）");
  // 默认值直接看药丸上显示的文字：默认 show ⇒「全部对话（显示已归档）」。
  const archivedText = collectText(selectorOf(archived)).join("");
  assert.match(archivedText, /全部对话/, `归档默认必须是 show（显示已归档），药丸实际显示：${archivedText}`);

  const opened = openDropdown(app, archived);
  assert.ok(opened.menu, "点击药丸必须展开下拉");
  assert.equal(opened.trigger.props["aria-expanded"], true, "展开后 aria-expanded 必须是 true");
  assert.equal(opened.menu.props.role, "menu", "下拉必须是 role=menu（官方同款）");
  const items = (opened.menu.children ?? []).filter(
    (c) => typeof c?.props?.className === "string" && c.props.className.includes("dscc-menu-item"),
  );
  assert.equal(items.length, 3, "归档必须三选一");
  const texts = items.map((c) => collectText(c).join(""));
  assert.match(texts.join(" "), /隐藏已归档/);
  assert.match(texts.join(" "), /全部对话/);
  assert.match(texts.join(" "), /仅显示已归档/);
  // 官方 Menu 的选中语义：aria-checked 落在当前值那一行。
  const checked = items.filter((c) => c.props["aria-checked"] === true);
  assert.equal(checked.length, 1, "必须恰好一行标为选中（aria-checked）");
  assert.match(collectText(checked[0]).join(""), /全部对话/, "选中行必须是当前值 show");

  // 会话类型三选一（照官方默认隐藏子代理）。
  const kind = fields.find((f) => f.label === "会话类型");
  assert.ok(kind, "必须渲染出「会话类型」筛选字段");
  assert.match(collectText(selectorOf(kind)).join(""), /主会话/, "会话类型默认必须是 main");
});

/**
 * 【布局回归】筛选区必须是「定宽网格」而不是会参差的 flex-wrap 行。
 *
 * 真实截图暴露的问题（第二次）：flex-wrap 排「标签+下拉」时，每个下拉按内容自适应宽度，
 * 每一行的标签起点、下拉宽度都不一样，看着就是「乱」。改用 CSS Grid 定列后才有对齐保证。
 * 列表则从表格改成卡片行（照原项目 sessdel-row），避免表格 6 列互相牵制。
 */
test("渲染：筛选区用定宽网格 + 列表用卡片行（布局回归）", async () => {
  // 要让列表真的渲染出行，得给 fetch 一个合法响应（默认 boot 的 fetch 是抛错的）。
  const listBody = {
    ok: true,
    value: {
      total: 1,
      page: { page: 1, pageSize: 50, pages: 1 },
      items: [
        {
          sessionId: "s-1",
          title: "示例会话",
          project: "E:\\proj",
          workspaceTitle: "proj",
          running: false,
          blank: false,
          live: true,
          persisted: true,
          archived: false,
          subagent: false,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
          deletable: true,
          blockedReason: null,
        },
      ],
      projects: ["E:\\proj"],
      archived: { filter: "default", total: 0, known: true, subagentTotal: 0 },
      kind: { filter: "main", subagentTotal: 0, mainTotal: 1 },
      titles: { requested: 1, cached: 0, fetched: 1, failed: 0, truncated: 0, skipped: false },
      tookMs: 1,
    },
  };
  const app = boot({
    hostActive: "zh",
    fetchImpl: async () => ({ status: 200, json: async () => listBody }),
  });
  const entry = app.byName.get(SECTION_SLOT);

  // 模拟 React 的挂载两阶段：render → 提交(跑 effect) → 状态更新(async) → 重渲染。
  const paint = () => {
    app.beginRender();
    return app.render(app.React.createElement(entry.component, { close: () => {} }));
  };
  const first = paint();
  app.flushEffects(); // 触发 fetchList
  await new Promise((r) => setTimeout(r, 0)); // 等 promise 落地
  const second = paint(); // 重渲染：此时应看到列表行
  app.flushEffects();

  const pick = (root) => {
    let filtersCard = null, grid = null, legacyToolbar = null, legacyTable = null, firstRow = null;
    let searchWrap = null, searchInput = null;
    (function walk(node) {
      if (node === null || node === undefined || typeof node !== "object") return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      const cls = typeof node.props?.className === "string" ? node.props.className.split(/\s+/) : [];
      if (cls.includes("dscc-filters")) filtersCard = node;
      if (cls.includes("dscc-filters-grid")) grid = node;
      if (cls.includes("dscc-panel-toolbar")) legacyToolbar = node;
      if (cls.includes("dscc-panel-table")) legacyTable = node;
      if (cls.includes("dscc-search")) searchWrap = node;
      if (cls.includes("dscc-input") && node.type === "input") searchInput = node;
      if (cls.includes("dscc-row") && firstRow === null) firstRow = node;
      for (const c of node.children ?? []) walk(c);
    })(root);
    return { filtersCard, grid, legacyToolbar, legacyTable, firstRow, searchWrap, searchInput };
  };

  const firstPicked = pick(first);
  assert.ok(firstPicked.filtersCard, "必须渲染出 .dscc-filters 筛选卡");
  assert.equal(firstPicked.legacyToolbar, null, "不得残留 flex-wrap 的旧工具条");
  assert.ok(firstPicked.grid, "筛选字段必须放在 .dscc-filters-grid 定宽网格里");
  assert.equal(firstPicked.legacyTable, null, "列表不得再用表格（改用卡片行）");

  // 【死规则防线】CSS 里的 .dscc-search.dscc-filters-search 必须真的匹配到元素。
  // 级联断言只看 CSS 文本，看不出「规则匹配不到任何东西」—— 上一版结构从
  // 「input 直接挂两个类」换成官方 Input 的 wrap 两层后，旧选择器就成了
  // 纯装饰，而它的断言照样绿。这条 DOM 断言把类名与规则钉在一起。
  assert.ok(firstPicked.searchWrap, "必须渲染出搜索框外层 .dscc-search（官方 Input 是 wrap 包 input 两层）");
  const wrapCls = String(firstPicked.searchWrap.props.className).split(/\s+/);
  assert.ok(
    wrapCls.includes("dscc-search") && wrapCls.includes("dscc-filters-search"),
    `占格子的外层必须同时挂 dscc-search 与 dscc-filters-search，实际：${wrapCls.join(" ")}`,
  );
  assert.ok(firstPicked.searchInput, "必须渲染出 .dscc-input 输入元素");

  // 卡片行：每行 = 勾选框 + 主内容 + 右侧（徽标/操作）
  const secondPicked = pick(second);
  const row = secondPicked.firstRow ?? firstPicked.firstRow;
  assert.ok(row, "必须渲染出 .dscc-row 卡片行");
  const rowCls = row.children.map((c) => c?.props?.className ?? "");
  assert.ok(rowCls.some((c) => c.includes("dscc-row-main")), "卡片行必须有主内容列");
  assert.ok(rowCls.some((c) => c.includes("dscc-row-side")), "卡片行必须有右侧固定区");
  assert.equal(row.children[0]?.type, "input", "勾选框必须在最左");
});

/**
 * 【核心功能回归】选一项下拉，必须真的改变查询并重发请求。
 *
 * 为什么单独一条：把原生 select 换成「药丸 + 内联 Menu」之后，
 * 值的传递从浏览器的 onChange(event.target.value) 变成我们自己接的
 * onSelect → props.onChange(value)。中间任何一环写错（比如忘了调 onChange、
 * 或把 label 当 value 传出去），**界面看着完全正常**——药丸上会显示新文字
 * （因为 activeLabel 是从 options 找出来的），但请求参数没变，
 * 用户以为筛了、实际没筛。上一轮的级联断言就是这类"看着绿其实没接上"的教训。
 *
 * 所以这里不看样式，只看**发出去的那个 URL**。
 */
test("渲染：从下拉选一项必须改变请求参数并重发", async () => {
  const urls = [];
  const listBody = {
    ok: true,
    value: {
      total: 0,
      page: { page: 1, pageSize: 50, pages: 1 },
      items: [],
      projects: ["E:\\proj-a", "E:\\proj-b"],
      archived: { filter: "show", total: 0, known: true, subagentTotal: 0 },
      kind: { filter: "main", subagentTotal: 0, mainTotal: 0 },
      titles: { requested: 0, cached: 0, fetched: 0, failed: 0, truncated: 0, skipped: false },
      tookMs: 1,
    },
  };
  const app = boot({
    hostActive: "zh",
    fetchImpl: async (url) => {
      urls.push(String(url));
      return { status: 200, json: async () => listBody };
    },
  });
  const entry = app.byName.get(SECTION_SLOT);
  const paint = () => {
    app.beginRender();
    return app.render(app.React.createElement(entry.component, { close: () => {} }));
  };

  paint();
  app.flushEffects();
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(urls.length >= 1, "首屏必须发出一次列表请求");
  // 默认 kind=main ⇒ URL 里带 kind=main。
  assert.match(urls[urls.length - 1], /kind=main/, "默认请求必须带 kind=main");

  // 展开「会话类型」并选「全部（含子代理）」。
  const tree = paint();
  const kind = filterFields(app, tree).find((f) => f.label === "会话类型");
  assert.ok(kind, "必须渲染出「会话类型」字段");
  const opened = openDropdown(app, kind);
  const items = (opened.menu.children ?? []).filter(
    (c) => typeof c?.props?.className === "string" && c.props.className.includes("dscc-menu-item"),
  );
  const allItem = items.find((c) => collectText(c).join("").includes("全部"));
  assert.ok(allItem, "下拉里必须有「全部（含子代理）」这一项");

  allItem.props.onClick(); // 选中
  // 【顺序很重要】这个替身里 effect 是在 render 阶段**收集**、由 flushEffects 执行。
  // 所以必须先重渲染一次（让组件体带着新 params 跑一遍、把新 effect 登记上），
  // 再 flush。反过来（先 flush 再渲染）跑的是上一轮的 effect，
  // 参数永远是旧值 —— 我第一次写就踩了这个。
  paint();
  app.flushEffects();
  await new Promise((r) => setTimeout(r, 0));

  const last = urls[urls.length - 1];
  assert.match(last, /kind=all/, `选中后必须重发 kind=all 的请求，实际 URL：${last}`);
  assert.doesNotMatch(last, /kind=main/, "不得仍然带着旧值 main");

  // 药丸上显示的文字必须跟着变（用户复核自己筛的是什么）。
  const after = paint();
  const kindAfter = filterFields(app, after).find((f) => f.label === "会话类型");
  assert.match(
    collectText(selectorOf(kindAfter)).join(""),
    /全部/,
    "选择后药丸必须显示新值（用户要能复核当前筛选）",
  );
});

/**
 * 【会话 id 的显示策略】有标题的行不显示 id，无标题的行必须显示。
 *
 * 用户反馈：那串 36 字符的 UUID「在哪都能看到、貌似没有显示的必要」。
 * 确实——它读不了、没法用，还把标题挤掉半行。所以从常规行里去掉，
 * 保留在悬停提示（title）里，需要核对身份时鼠标停上去就有。
 *
 * 但有一个例外必须守住：**没有标题的会话，id 就是它唯一的身份**。
 * 本面板是**不可逆的删除**界面，同一个项目里几条空标题会话如果
 * 视觉上完全一样，用户就没法复核自己勾的是哪一条 —— 认错行代价很大。
 * 所以无标题行仍显示 id。这条测试同时钉住「去掉」和「例外」两半，
 * 防止以后有人把条件简化成「一律不显示」。
 */
test("渲染：有标题的行不显示会话 id，无标题的行必须显示", async () => {
  const rowOf = (over) => ({
    sessionId: "session-5a449d65-f46a-4451-bf6d-e40f4a266ecd",
    title: "论文",
    project: "E:\\AI\\DeepSeek Ha",
    workspaceTitle: "DeepSeek",
    running: false,
    blank: false,
    live: true,
    persisted: true,
    archived: false,
    subagent: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    deletable: true,
    blockedReason: null,
    ...over,
  });
  const listBody = {
    ok: true,
    value: {
      total: 2,
      page: { page: 1, pageSize: 50, pages: 1 },
      items: [rowOf({}), rowOf({ sessionId: "session-00000000-1111-2222-3333-444444444444", title: "" })],
      projects: ["E:\\AI\\DeepSeek Ha"],
      archived: { filter: "show", total: 0, known: true, subagentTotal: 0 },
      kind: { filter: "main", subagentTotal: 0, mainTotal: 2 },
      titles: { requested: 2, cached: 0, fetched: 2, failed: 0, truncated: 0, skipped: false },
      tookMs: 1,
    },
  };
  const app = boot({ hostActive: "zh", fetchImpl: async () => ({ status: 200, json: async () => listBody }) });
  const entry = app.byName.get(SECTION_SLOT);
  const paint = () => {
    app.beginRender();
    return app.render(app.React.createElement(entry.component, { close: () => {} }));
  };
  paint();
  app.flushEffects();
  await new Promise((r) => setTimeout(r, 0));
  const tree = paint();

  const rows = [];
  (function walk(node) {
    if (node === null || node === undefined || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const cls = typeof node.props?.className === "string" ? node.props.className.split(/\s+/) : [];
    if (cls.includes("dscc-row")) rows.push(node);
    for (const c of node.children ?? []) walk(c);
  })(tree);
  assert.equal(rows.length, 2, "必须渲染出两行");

  const texts = rows.map((r) => collectText(r).join(" "));
  // 有标题的行：正文里不得出现那串 id。
  assert.ok(!texts[0].includes("5a449d65"), `有标题的行不该显示会话 id，实际：${texts[0]}`);
  assert.match(texts[0], /论文/, "有标题的行必须显示标题");
  // 无标题的行：必须显示 id（否则与同项目其它空标题行无法区分）。
  assert.ok(texts[1].includes("00000000"), `无标题的行必须显示会话 id，实际：${texts[1]}`);
  assert.match(texts[1], /无标题/, "无标题的行要有占位标题文案");

  // 但 id 并没有丢：两行的悬停提示里都还在。
  const metas = rows.map((r) => {
    let meta = null;
    (function walk(node) {
      if (node === null || node === undefined || typeof node !== "object") return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      const cls = typeof node.props?.className === "string" ? node.props.className.split(/\s+/) : [];
      if (cls.includes("dscc-row-meta")) meta = node;
      for (const c of node.children ?? []) walk(c);
    })(r);
    return meta;
  });
  assert.match(String(metas[0].props.title), /5a449d65/, "有标题的行必须能在悬停提示里看到 id");
});

/** 上面用到 await0 只是为了保持同步；这里做 CSS 层的断言（读源码文本）。 */
test("布局 CSS：筛选网格标签列与控件列都定宽，行内容可省略", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(CLIENT_PATH, "utf8");
  const raw = source.match(/const CSS = `([\s\S]*?)`;/)[1];
  // 【必须先剥注释再断言】CSS 注释里会出现选择器的**示例写法**
  // （例如解释排版时写「.dscc-filters-grid { grid-column: 1 }」）。
  // 不剥注释的话，正则可能先匹配到注释里那份，于是
  //   · 断言读到的是示例而不是真规则；
  //   · 变异测试会「改真规则却不红」—— 假通过。
  // 下面对所有 CSS 断言统一用这份注释已剥离的文本。
  const sheet = raw.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.notEqual(sheet, raw, "CSS 里应当有注释（这份剥离是必要的）");

  // 【对齐输入框 · 布局不变量】
  //
  // 用户反馈「对齐输入框」。用真实组件树在真浏览器里量出的原始几何是：
  //   搜索框   left=15  right=752.42   （右侧被「刷新」按钮占走）
  //   筛选网格 left=15  right=840      ← 右边界差 87.58px
  // 左边界本来就是齐的；不齐的是**右边界**：筛选网格铺满卡片，搜索框只到按钮左边。
  //
  // 修法不是去调 padding 凑数（按钮文字一长一短就又不齐），而是让两者**同列**：
  //   .dscc-filters        → grid，两列 = [minmax(0,1fr)] [auto]
  //   .dscc-filters-row    → display:contents（行容器不占格子）
  //   .dscc-filters-grid   → grid-column:1（与搜索框同列）
  // 于是左右边界由布局保证一致。用声明式断言钉住这条结构。
  const filtersRule = /\.dscc-filters\s*\{([^}]*)\}/.exec(sheet);
  assert.ok(filtersRule, "必须有 .dscc-filters 规则");
  assert.match(
    filtersRule[1],
    /display:\s*grid/,
    "筛选卡必须是网格（这样搜索框与筛选网格才能同列，右边界一致）",
  );
  assert.match(
    filtersRule[1],
    /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/,
    "两列应为 [可收缩的主列] + [按内容宽的按钮列]",
  );
  assert.match(
    sheet,
    /\.dscc-filters-row\s*\{[^}]*display:\s*contents/,
    "行容器必须 display:contents，否则它自成一格，搜索框与按钮无法与外层对齐",
  );
  // 【M1 变异发现的漏洞】原来这里写的是 /grid-column:\s*1/ —— 它**同时匹配**
  // `grid-column: 1 / -1`（跨两列）。而跨列正是要防的回归：
  // 网格一旦跨列，宽度就又和搜索框不一致了。所以值必须**锚定到分隔符**，
  // 要求恰好是 1（后随 ; 或 }），并显式排除跨列写法。
  const gridBlock = /\.dscc-filters-grid\s*\{([^}]*)\}/.exec(sheet);
  assert.ok(gridBlock, "必须有 .dscc-filters-grid 规则");
  assert.match(
    gridBlock[1],
    /grid-column:\s*1\s*(?:;|$)/m,
    "筛选网格必须**只占第 1 列**（grid-column: 1）",
  );
  assert.equal(
    /grid-column:\s*1\s*\/\s*-?\s*1/.test(gridBlock[1]),
    false,
    "不得跨列（grid-column: 1 / -1）—— 跨列会让宽度又与搜索框不一致",
  );

  // 网格：标签列定宽（用 auto 会让左右两组的标签各自成宽，下拉起点错开）；
  // 控件列用 1fr 均分，长文案（「全部对话（显示已归档）」）不再被截断。
  const gridRule = /\.dscc-filters-grid\s*\{([^}]*)\}/.exec(sheet);
  assert.ok(gridRule, "必须有 .dscc-filters-grid 规则");
  assert.match(
    gridRule[1],
    /grid-template-columns:\s*48px\s+minmax\(0,\s*1fr\)\s+48px\s+minmax\(0,\s*1fr\)/,
    "必须是 4 列：两组「定宽标签列 + 可伸缩控件列」",
  );

  // 【中文字宽统一：分散对齐】
  // 标签字数不一（4 字「会话类型」vs 2 字「项目」），要在**同一列宽内两端顶格**。
  // 只用 text-align: justify 无效 —— 标签是单行，而 justify 默认不作用于最后一行，
  // 必须同时给 text-align-last: justify，否则 2 字标签右侧会空一大块。
  const labelRule = /\.dscc-field-label\s*\{([^}]*)\}/.exec(sheet);
  assert.ok(labelRule, "必须有 .dscc-field-label 规则");
  assert.match(labelRule[1], /text-align:\s*justify/, "标签必须两端对齐");
  assert.match(labelRule[1], /text-align-last:\s*justify/, "必须补 text-align-last（单行文本 justify 不生效）");
  assert.match(labelRule[1], /width:\s*100%/, "标签须占满定宽列，否则撑不开");
  assert.match(labelRule[1], /white-space:\s*nowrap/, "标签不得折行");

  // 【按钮不许竖排】中文可在任意字符断行，被压到 min-content 就会竖排。
  // 现在按钮在网格的 [auto] 列里，宽度由内容决定，天然不会被压扁；
  // 但 `white-space: nowrap` 这条防线要一直留着（它是那个 bug 的直接修复）。
  const btnRule = /\.dscc-btn\s*\{([^}]*)\}/.exec(sheet);
  assert.ok(btnRule, "必须有 .dscc-btn 规则");
  assert.match(btnRule[1], /white-space:\s*nowrap/, "按钮文字必须 nowrap（否则「刷新」会竖排）");
  // 搜索框占满主列；宽度交给网格轨道，不要再回到 width:auto/flex-basis 那套。
  // 【为什么类组合是 search 而不是 input】官方 Input 是 wrap 包 input 两层，
  // 占格子的是外层 wrap。级联断言只看 CSS 文本，看不出「这条规则匹配不到任何元素」，
  // 所以下面渲染测试里另有一条 DOM 断言核对真实类名（见「筛选区用定宽网格」）。
  assert.equal(
    cascadeWinner(sheet, "dscc-search dscc-filters-search", "width"),
    "100%",
    "搜索框外层必须占满所在列（右边界才能与筛选网格一致）",
  );
  // 死规则防线：CSS 里不得再出现只挂在内层 input 上的那份旧规则
  // （结构换成 wrap 之后它匹配不到任何元素，是纯装饰）。
  assert.equal(
    /\.dscc-input\.dscc-filters-search\s*\{/.test(sheet),
    false,
    "不得残留 .dscc-input.dscc-filters-search（wrap 结构下它是匹配不到元素的死规则）",
  );

  // 【M1 回归】面板高度/内边距的覆盖同理必须真的生效。
  // 原来 `.dscc-panel-section`（0,1,0）排在其后于 `.dscc-panel` 之前 ⇒ 被完全覆盖，
  // 设置页内容列的自适应高度从未生效。
  assert.equal(
    cascadeWinner(sheet, "dscc-panel dscc-panel-section", "padding"),
    "0",
    "设置页里面板的 padding:0 必须真的胜出",
  );
  assert.equal(
    cascadeWinner(sheet, "dscc-panel dscc-panel-section", "height"),
    "auto",
    "设置页里面板必须自适应高度（height:auto 真的胜出）",
  );

  // 卡片行：主内容列必须 min-width:0，否则省略号不生效
  const mainRule = /\.dscc-row-main\s*\{([^}]*)\}/.exec(sheet);
  assert.ok(mainRule, "必须有 .dscc-row-main 规则");
  assert.match(mainRule[1], /min-width:\s*0/, "主内容列必须 min-width:0（省略号生效的前提）");

  // 标题/元信息必须单行省略
  for (const sel of ["dscc-row-title", "dscc-row-meta"]) {
    const r = new RegExp(`\\.${sel}\\s*\\{([^}]*)\\}`).exec(sheet);
    assert.ok(r, `必须有 .${sel} 规则`);
    assert.match(r[1], /text-overflow:\s*ellipsis/, `.${sel} 必须用省略号`);
  }

  // 已彻底移除表格布局
  assert.equal(/dscc-panel-table\s*\{/.test(sheet), false, "表格规则必须已删除");
  // 不得再出现会把文字逐字符折断的 break-all（卡片行内部）
  const rowRules = [...sheet.matchAll(/\.dscc-row[\w-]*\s*\{([^}]*)\}/g)].map((m) => m[1]);
  assert.equal(rowRules.some((b) => /break-all/.test(b)), false, "卡片行不得使用 break-all");
});
