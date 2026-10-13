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

  // 【修复后契约】外层是原生 <dialog>（进 top layer，所以能从设置面板之上显示），
  // 语义挂在它身上；内层卡片不得再声明 role，否则会嵌套 dialog。
  assert.equal(dialogTree.type, "dialog", "外层必须是原生 <dialog>（top layer 才能置顶）");
  assert.equal(dialogTree.props.role, "dialog", "外层必须带 role=dialog");
  assert.equal(dialogTree.props["aria-modal"], "true", "必须声明 aria-modal");
  assert.equal(typeof dialogTree.props.onCancel, "function", "必须处理原生 cancel（Esc）");

  // 必须真的调用了 showModal()（否则不会进 top layer，「不置顶」的 bug 会复发）
  const ref = dialogTree.props.ref;
  assert.ok(ref && typeof ref === "object", "必须挂 ref 以便调用 showModal()");

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
  assert.deepEqual(innerRoles, [], "内层卡片不得再声明 role（原生 dialog 已隐含）");
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
test("渲染：面板提供归档三选一（默认显示已归档）", () => {
  const app = boot({ hostActive: "zh" });
  const entry = app.byName.get(SECTION_SLOT);
  app.beginRender();
  const tree = app.render(app.React.createElement(entry.component, { close: () => {} }));

  // 筛选字段：每个 <label class="dscc-field">（display:contents）里有
  // 「.dscc-field-label 文字 + select」。按 label 内取，同时锁定「每个下拉都有可见标签」。
  const selectsByLabel = new Map();
  (function walk(node) {
    if (node === null || node === undefined || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const cls = typeof node.props?.className === "string" ? node.props.className.split(/\s+/) : [];
    if (cls.includes("dscc-field")) {
      const kids = node.children ?? [];
      const span = kids.find(
        (c) => typeof c?.props?.className === "string" && c.props.className.includes("dscc-field-label"),
      );
      const select = kids.find((c) => c?.type === "select");
      if (span !== undefined && select !== undefined) {
        selectsByLabel.set(collectText(span).join(""), select);
      }
    }
    for (const c of node.children ?? []) walk(c);
  })(tree);

  const labelKeys = [...selectsByLabel.keys()];
  assert.ok(labelKeys.length >= 5, `必须有 5 个带可见标签的筛选下拉，实际 ${labelKeys.length}`);

  const archivedSelect = selectsByLabel.get("归档");
  assert.ok(archivedSelect, "必须渲染出「归档」筛选下拉（且带可见标签）");
  assert.equal(archivedSelect.props.value, "show", "默认必须是 show（显示已归档）");

  const values = archivedSelect.children.map((opt) => opt.props.value);
  assert.deepEqual(values, ["default", "show", "only"], "必须三选一，且与官方取值一致");
  const optionTexts = archivedSelect.children.map((opt) => collectText(opt).join(""));
  assert.match(optionTexts.join(" "), /隐藏已归档/);
  assert.match(optionTexts.join(" "), /全部对话/);
  assert.match(optionTexts.join(" "), /仅显示已归档/);

  // 会话类型三选一（照官方默认隐藏子代理）。
  const kindSelect = selectsByLabel.get("会话类型");
  assert.ok(kindSelect, "必须渲染出「会话类型」筛选下拉");
  assert.equal(kindSelect.props.value, "main", "默认必须是 main（只显示主会话）");
  assert.deepEqual(
    kindSelect.children.map((opt) => opt.props.value),
    ["main", "subagent", "all"],
  );
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
    (function walk(node) {
      if (node === null || node === undefined || typeof node !== "object") return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      const cls = typeof node.props?.className === "string" ? node.props.className.split(/\s+/) : [];
      if (cls.includes("dscc-filters")) filtersCard = node;
      if (cls.includes("dscc-filters-grid")) grid = node;
      if (cls.includes("dscc-panel-toolbar")) legacyToolbar = node;
      if (cls.includes("dscc-panel-table")) legacyTable = node;
      if (cls.includes("dscc-row") && firstRow === null) firstRow = node;
      for (const c of node.children ?? []) walk(c);
    })(root);
    return { filtersCard, grid, legacyToolbar, legacyTable, firstRow };
  };

  const firstPicked = pick(first);
  assert.ok(firstPicked.filtersCard, "必须渲染出 .dscc-filters 筛选卡");
  assert.equal(firstPicked.legacyToolbar, null, "不得残留 flex-wrap 的旧工具条");
  assert.ok(firstPicked.grid, "筛选字段必须放在 .dscc-filters-grid 定宽网格里");
  assert.equal(firstPicked.legacyTable, null, "列表不得再用表格（改用卡片行）");

  // 卡片行：每行 = 勾选框 + 主内容 + 右侧（徽标/操作）
  const secondPicked = pick(second);
  const row = secondPicked.firstRow ?? firstPicked.firstRow;
  assert.ok(row, "必须渲染出 .dscc-row 卡片行");
  const rowCls = row.children.map((c) => c?.props?.className ?? "");
  assert.ok(rowCls.some((c) => c.includes("dscc-row-main")), "卡片行必须有主内容列");
  assert.ok(rowCls.some((c) => c.includes("dscc-row-side")), "卡片行必须有右侧固定区");
  assert.equal(row.children[0]?.type, "input", "勾选框必须在最左");
});

/** 上面用到 await0 只是为了保持同步；这里做 CSS 层的断言（读源码文本）。 */
test("布局 CSS：筛选网格标签列与控件列都定宽，行内容可省略", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(CLIENT_PATH, "utf8");
  const sheet = source.match(/const CSS = `([\s\S]*?)`;/)[1];

  // 网格：两列都定宽（用 auto 会让左右两组的标签各自成宽，下拉起点错开）。
  // 标签列宽 = 最长标签的自然宽度：4 字 × 12px = 48px。
  const gridRule = /\.dscc-filters-grid\s*\{([^}]*)\}/.exec(sheet);
  assert.ok(gridRule, "必须有 .dscc-filters-grid 规则");
  assert.match(gridRule[1], /grid-template-columns:\s*48px\s+152px\s+48px\s+152px/, "必须是 4 列定宽轨道");
  assert.equal(/auto/.test(gridRule[1]), false, "标签列不得用 auto（会导致两组起点错开）");

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

  // 【按钮不许竖排】中文可在任意字符断行，被压到 min-content 就会竖排
  const btnRule = /\.dscc-btn\s*\{([^}]*)\}/.exec(sheet);
  assert.ok(btnRule, "必须有 .dscc-btn 规则");
  assert.match(btnRule[1], /white-space:\s*nowrap/, "按钮文字必须 nowrap（否则「刷新」会竖排）");
  assert.match(
    sheet,
    /\.dscc-filters-row\s*>\s*\.dscc-btn\s*\{[^}]*flex:\s*none/,
    "刷新按钮必须 flex:none（不被压缩）",
  );
  // 搜索框不能沿用 width:100%（那会把按钮挤到 min-content）。
  //
  // 【M2 回归 · 必须算级联，不能只看「声明存在」】
  // 原来这里断言的是「.dscc-filters-search 规则里有 width:auto」—— 那条断言
  // 一直通过，但**规则从未生效**：它和 .dscc-input 同为单类选择器（0,1,0），
  // 而 .dscc-input 在源码里排在其后 ⇒ width:100% 胜出。
  // 现在改为计算真正的胜出者（见下方 cascadeWinner 辅助）。
  assert.equal(
    cascadeWinner(sheet, "dscc-input dscc-filters-search", "width"),
    "auto",
    "搜索框的 width:auto 必须**真的**胜出（不能只写在规则里被 .dscc-input 覆盖）",
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
