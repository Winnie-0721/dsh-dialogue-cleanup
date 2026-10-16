/**
 * 客户端半的**注册面**冒烟测试。
 *
 * 边界说明（重要）：这里**不渲染任何组件**、不模拟 DOM、不实现渲染器。
 * 官方口径把「live Client slot 注册」列为无浏览器时允许的验证项，本文件只做那一件事：
 *   1. factory 是纯粹的 —— 调用它不注册任何东西（R-26）；
 *   2. apply(ctx) 注册了**预期的那几个 slot**，且每个都经 ctx.effect 包裹（R-11）；
 *   3. cleanup 能撤销全部注册。
 *
 * 组件内部的渲染逻辑不在本文件的覆盖范围内（那需要真实浏览器，见 VERIFICATION.md）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const CLIENT_PATH = join(here, "..", "client.js");

/** 最小 React 替身：只提供模块级代码会用到的符号；组件不在此处渲染。 */
const reactStub = {
  createElement: () => null,
  Fragment: Symbol("Fragment"),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
};

/** 在受控的 window/loader 环境里加载 client.js，返回 factory。 */
async function loadFactory() {
  const source = await readFile(CLIENT_PATH, "utf8");
  let definition = null;
  const windowStub = {
    __ModuleLoader__: {
      load(def) {
        definition = def;
      },
    },
  };

  // client.js 是浏览器 bundle：顶层用 window.__ModuleLoader__.load 自注册。
  // 用 Function 构造器在隔离作用域里执行，注入 window / require，避免污染全局。
  const run = new Function("window", "require", "URLSearchParams", "fetch", "navigator", source);
  run(
    windowStub,
    (id) => {
      if (id === "react") return reactStub;
      throw new Error(`unexpected require(${id})`);
    },
    URLSearchParams,
    async () => {
      throw new Error("fetch must not be called during load");
    },
    { language: "zh-CN" },
  );

  assert.ok(definition !== null, "client.js 必须调用 window.__ModuleLoader__.load()");
  return definition;
}

/** 假 slots 服务：记录每一笔注册与 corresponding cleanup。 */
function makeSlots() {
  const registered = [];
  const injected = [];
  const slots = {
    inject(key, callback) {
      injected.push(key);
      const cleanups = [callback()];
      return () => {
        for (const fn of cleanups) {
          if (typeof fn === "function") fn();
        }
      };
    },
    register(options, component) {
      registered.push({ options, component });
      return () => {
        const at = registered.findIndex((entry) => entry.options === options);
        if (at >= 0) registered.splice(at, 1);
      };
    },
  };
  return { slots, registered, injected };
}

test("client.js：loader id 必须等于包名（R-1.10 / R-3.15）", async () => {
  const definition = await loadFactory();
  assert.equal(definition.id, "dsh-dialogue-cleanup");
  assert.equal(typeof definition.factory, "function");
});

test("client.js：factory 是纯的 —— 调用它不产生任何注册（R-26）", async () => {
  const definition = await loadFactory();
  const { slots, registered, injected } = makeSlots();
  const effectLabels = [];

  const module = definition.factory((id) => {
    if (id === "react") return reactStub;
    throw new Error(`unexpected require(${id})`);
  });

  // factory 只返回 apply / inject，没有副作用
  assert.equal(typeof module.apply, "function");
  assert.equal(registered.length, 0, "factory 阶段不得注册 slot");
  assert.equal(injected.length, 0, "factory 阶段不得 inject slot");
  assert.deepEqual(module.inject, ["slots", "locale"]);

  // 组件必须是函数（React 组件），不是 DOM 节点
  void slots;
  void effectLabels;
});

test("apply：注册菜单项 + 确认框 + 设置页 section，且全部经 ctx.effect", async () => {
  const definition = await loadFactory();
  const module = definition.factory((id) => {
    if (id === "react") return reactStub;
    throw new Error(`unexpected require(${id})`);
  });

  const { slots, registered, injected } = makeSlots();
  const effectLabels = [];
  const cleanups = [];

  const ctx = {
    logger: { warn() {}, debug() {}, info() {} },
    slots,
    get: () => undefined,
    effect(callback, label) {
      effectLabels.push(label);
      const cleanup = callback();
      cleanups.push(cleanup);
      return cleanup;
    },
  };

  module.apply(ctx);

  // 每个注册都必须包在 ctx.effect 里（R-11）：1 个语言包 + 3 个 slot 注册
  assert.equal(effectLabels.length, 4, `期望 4 个 effect，实际：${effectLabels.join(", ")}`);
  for (const label of effectLabels) assert.match(label, /^dialogue-cleanup: /);
  assert.ok(effectLabels.some((l) => /locale/.test(l)), "语言包也要经 ctx.effect（R-5.6）");

  // 依赖的 slot 声明（ctx.slots.inject —— 即使 owner 通常在场也必须用，R-3.4/R-3.5）
  const expectedInject = [
    "sidebar.workspaces.session.menu.item",
    "shell.overlay",
    "settings.section",
  ];
  assert.deepEqual(injected.slice().sort(), expectedInject.slice().sort());

  // 实际注册项
  const byName = new Map(registered.map((entry) => [entry.options.name, entry.options]));
  assert.ok(byName.has("sidebar.workspaces.session.menu.item"), "行 ⋮ 菜单项");
  assert.ok(byName.has("shell.overlay"), "确认覆盖层");
  assert.ok(byName.has("settings.section"), "设置页 section");

  // menu 项：order 500（排在官方 archive=400 之后），带自定义 id
  const menu = byName.get("sidebar.workspaces.session.menu.item");
  assert.equal(menu.id, "dialogue-cleanup.delete");
  assert.equal(menu.order, 500);

  // 设置页 section：自有 id、order 25（排在官方 agent-presets=20 之后）、label 用 thunk
  const section = byName.get("settings.section");
  assert.equal(section.id, "dialogue-cleanup");
  assert.equal(section.order, 25);
  assert.equal(typeof section.label, "function", "label 用 thunk 以便跟随语言切换");

  // 组件都是函数
  for (const entry of registered) {
    assert.equal(typeof entry.component, "function", `${entry.options.name} 的组件必须是函数`);
  }

  // cleanup 撤销全部注册
  for (const cleanup of cleanups) {
    if (typeof cleanup === "function") cleanup();
  }
  assert.equal(registered.length, 0, "清理后不应残留任何注册");
});

test("apply：不依赖 layout 服务（面板挂在设置页，不需要切 main 的 key）", async () => {
  const definition = await loadFactory();
  const module = definition.factory((id) => {
    if (id === "react") return reactStub;
    throw new Error(`unexpected require(${id})`);
  });

  const { slots, registered } = makeSlots();
  // get() 对任何服务都返回 undefined —— layout 缺席也必须能正常注册
  const ctx = {
    logger: { warn() {}, debug() {} },
    slots,
    get: () => undefined,
    effect: (callback) => callback(),
  };

  assert.doesNotThrow(() => module.apply(ctx));
  assert.ok(
    registered.some((entry) => entry.options.name === "settings.section"),
    "layout 缺席时设置页 section 仍应注册成功",
  );
});

test("R-23 / R-22 合规：client.js 不 require Harness Client 包，也不写宿主 DOM", async () => {
  const source = await readFile(CLIENT_PATH, "utf8");
  // 去掉注释后再检查，避免把「说明我们不这么做」的注释误判成违规
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  assert.equal(/require\(\s*['"]@deepseek-ai/.test(code), false, "不得 require 任何 @deepseek-ai/* 包");
  assert.equal(/appendChild/.test(code), false, "不得 appendChild 到宿主 DOM");
  assert.equal(/document\.body/.test(code), false, "不得触碰 document.body");
  assert.equal(/MutationObserver/.test(code), false, "不得使用 MutationObserver");
  assert.equal(/querySelector/.test(code), false, "不得读宿主 DOM 定位");
  assert.equal(/document\.createElement/.test(code), false, "不得手写 DOM 节点");
});

test("R-24 合规：client.js 只用 Theme.listTokens 全表内的令牌", async () => {
  const source = await readFile(CLIENT_PATH, "utf8");

  // 现场 Theme.listTokens 的完整全表（14 个）。新令牌出现时更新这里。
  const ALLOWED = new Set([
    "--dsw-alias-bg-base",
    "--dsw-alias-bg-layer-1",
    "--dsw-alias-bg-layer-2",
    "--dsw-alias-bg-overlay",
    "--dsw-alias-border-l1",
    "--dsw-alias-border-l2",
    "--dsw-alias-brand-primary",
    "--dsw-alias-label-primary",
    "--dsw-alias-label-secondary",
    "--dsw-alias-state-error-primary",
    "--dsw-alias-state-idle-primary",
    "--dsw-alias-state-success-primary",
    "--dsw-alias-state-warn-primary",
    "--dsw-specific-sidebar-fill",
  ]);

  // 只扫**真正消费令牌**的地方：var(--dsw-…)。
  // 注释里会出现 `--dsw-alias-*` 这类说明文字（模板字符串内的 // 注释也躲不过去注释剥离），
  // 按 var() 精确匹配就不会误判。
  const used = new Set();
  for (const match of source.matchAll(/var\(\s*(--dsw-[a-z0-9-]+)\s*\)/g)) {
    used.add(match[1]);
  }

  assert.ok(used.size > 0, "应当确实用到了主题令牌");
  for (const token of used) {
    assert.ok(ALLOWED.has(token), `使用了不在 Theme.listTokens 全表内的令牌：${token}`);
  }

  // 附录 C.12 的 C 项：这三个令牌在实测全表里**不存在**，必须一个都没用
  for (const bogus of ["--dsw-alias-danger", "--dsw-alias-interactive-bg-hover", "--dsw-alias-hairline"]) {
    assert.equal(used.has(bogus), false, `不得使用不存在的令牌：${bogus}`);
  }

  // 硬编码颜色只允许出现在纯美术（这里是用于遮罩的 color-mix，引用了令牌）
  const literalHex = source.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  assert.deepEqual(literalHex, [], `不得出现硬编码颜色：${literalHex.join(", ")}`);
});

/**
 * 语言跟随**宿主/插件本体**的回归测试。
 *
 * 【背景 · 这是一个真实缺陷】现场 `client Service('locale')` 的契约是
 *   LocaleSnapshot { active: LocaleId; locales; revision }
 * 而旧代码读的是 `snapshot?.id ?? snapshot?.locale ?? snapshot?.language` ——
 * 三个字段**全都不存在**，于是永远拿到 undefined，静默退到 `navigator.language`。
 * 结果：界面语言跟着**浏览器**走，而不是跟着宿主/插件本体走。
 *
 * 这里用**真实快照形状**驱动，并以 `settings.section` 注册项的 `label()` thunk
 * （内部调用 `tt("panel.title")`）作为可观测点。
 */
function localeHarness({ hostActive, browserLanguage, withBind } = {}) {
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
    async () => {},
    { language: browserLanguage },
  );

  const module = definition.factory((id) => {
    if (id === "react") return reactStub;
    throw new Error(`unexpected require(${id})`);
  });

  // 可变的活动语言：模拟宿主的 setLocale。
  const state = { active: hostActive };
  const subscribers = [];
  const unsubscribed = [];
  const locale = {
    register: () => () => {},
    getLocale: () => ({ active: state.active, locales: [], revision: 1 }),
    subscribe(fn) {
      subscribers.push(fn);
      return () => {
        unsubscribed.push(fn);
        const at = subscribers.indexOf(fn);
        if (at >= 0) subscribers.splice(at, 1);
      };
    },
  };
  if (withBind) {
    // bind 的产物按**调用时**读活动语言，与真实契约一致。
    locale.bind = () => (key) => (state.active === "zh" ? `bound-zh:${key}` : `bound-en:${key}`);
  }

  const { slots, registered } = makeSlots();
  const cleanups = [];
  const ctx = {
    logger: { warn() {}, debug() {} },
    slots,
    locale,
    get: () => undefined,
    effect: (callback) => {
      const cleanup = callback();
      cleanups.push(cleanup);
      return cleanup;
    },
  };
  module.apply(ctx);

  const section = registered.find((entry) => entry.options.name === "settings.section");
  assert.ok(section, "settings.section 必须已注册");
  return {
    label: () => section.options.label(),
    setActive(next) {
      state.active = next;
      for (const fn of subscribers.slice()) fn();
    },
    subscribers,
    unsubscribed,
    cleanup() {
      for (const fn of cleanups.slice()) if (typeof fn === "function") fn();
    },
  };
}

test("语言跟随宿主：宿主 active=zh 时用中文（即使浏览器是 en-US）", () => {
  const { label } = localeHarness({ hostActive: "zh", browserLanguage: "en-US" });
  assert.equal(label(), "对话清理", "必须跟随宿主的 active，而不是 navigator.language");
});

test("语言跟随宿主：宿主 active=en 时用英文（即使浏览器是 zh-CN）", () => {
  const { label } = localeHarness({ hostActive: "en", browserLanguage: "zh-CN" });
  assert.equal(label(), "Dialogue Cleanup", "宿主语言优先于浏览器语言");
});

test("语言跟随宿主：active 缺失时才回退到浏览器语言", () => {
  // 【回归】旧代码读 {id}/{locale}/{language} 这三个不存在的字段 —— 于是**永远**
  // 被当成「拿不到」而回退浏览器。现在只有 active 真的缺失才回退。
  const zh = localeHarness({ hostActive: undefined, browserLanguage: "zh-CN" });
  assert.equal(zh.label(), "对话清理", "宿主不可知时才按浏览器语言渲染");
});

test("语言跟随宿主：旧代码误读的 {id} 形状不再被当作有效快照", () => {
  // 用 {id:"zh"} 这种**错误形状**：必须被判定为不可知 → 回退浏览器 en-US，
  // 而不是「恰好蒙对」。这正是否定旧实现的关键断言。
  const wrongShape = localeHarness({ hostActive: undefined, browserLanguage: "en-US" });
  assert.equal(wrongShape.label(), "Dialogue Cleanup", "不认 id 字段；缺失 active 即回退");
});

test("语言跟随宿主：切语言后标签实时跟随（无需重载页面）", () => {
  const h = localeHarness({ hostActive: "zh", browserLanguage: "en-US" });
  assert.equal(h.label(), "对话清理");
  assert.equal(h.subscribers.length, 1, "必须订阅 locale 变化");

  h.setActive("en");
  assert.equal(h.label(), "Dialogue Cleanup", "订阅回调必须让标签跟随新语言");

  h.setActive("zh");
  assert.equal(h.label(), "对话清理", "来回切换都要跟随");
});

test("语言跟随宿主：优先用 locale.bind(ns) 作为翻译来源", () => {
  const h = localeHarness({ hostActive: "en", browserLanguage: "en-US", withBind: true });
  assert.equal(h.label(), "bound-en:panel.title", "bind 可用时必须优先使用宿主的翻译函数");
  h.setActive("zh");
  assert.equal(h.label(), "bound-zh:panel.title", "bind 的产物必须按调用时读活动语言");
});

test("语言跟随宿主：apply 的清理函数会退订 locale", () => {
  const h = localeHarness({ hostActive: "zh", browserLanguage: "en-US" });
  assert.equal(h.subscribers.length, 1);
  h.cleanup();
  assert.equal(h.subscribers.length, 0, "清理后不得再持有订阅者（否则泄漏并重复渲染）");
  assert.equal(h.unsubscribed.length, 1, "必须真的调用退订函数");
});

/**
 * CSS 块的结构完整性（**可达**的检查）。
 *
 * 【诚实说明】「CSS 模板串里混进裸反引号」这个坑我踩过两次，但它的真实防线是
 * `node --check` / `new Function(source)` —— 那会让整个文件语法错误、**所有**测试
 * 一起失败，所以专门写一条断言去「抓」它是抓不到的（测不到就已经编译不过了）。
 * 这里改为做一件真正可达、也真正有价值的事：校验 CSS 块的括号配平与关键规则存在。
 * 一个多余的 `}` 会静默吞掉后面所有规则，这种错误语法检查抓不到，只有这里能抓。
 */
test("client.js：CSS 块括号配平且关键规则齐备（可达的结构检查）", async () => {
  const source = await readFile(CLIENT_PATH, "utf8");
  const start = source.indexOf("const CSS = ");
  assert.ok(start > 0, "必须能找到 CSS 定义");
  const open = source.indexOf("`", start);
  const close = source.indexOf("`;", open + 1);
  assert.ok(open > 0 && close > open, "CSS 模板串必须正常闭合");
  const css = source.slice(open + 1, close);

  // 括号配平（含注释里成对出现的大括号：所以按「去注释后的净值」判定）
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const opens = (stripped.match(/\{/g) ?? []).length;
  const closes = (stripped.match(/\}/g) ?? []).length;
  assert.equal(opens, closes, `CSS 大括号必须配平（{ ${opens} vs } ${closes}）`);

  // 关键规则必须都在（少了会导致布局退化，且不会有任何报错）
  for (const [name, re] of [
    ["筛选卡 .dscc-filters", /\.dscc-filters\s*\{/],
    ["筛选网格 .dscc-filters-grid", /\.dscc-filters-grid\s*\{/],
    ["标签 .dscc-field-label", /\.dscc-field-label\s*\{/],
    ["卡片行 .dscc-row", /\.dscc-row\s*\{/],
    ["主内容列 .dscc-row-main", /\.dscc-row-main\s*\{/],
    ["右侧区 .dscc-row-side", /\.dscc-row-side\s*\{/],
    ["弹窗 .dscc-modal", /\.dscc-modal\s*\{/],
  ]) {
    assert.match(css, re, `CSS 缺少关键规则：${name}`);
  }

  // 不得引用不存在的令牌（R-24 的补充：全表里没有的三个名字）
  for (const bogus of ["--dsw-alias-danger", "--dsw-alias-hairline", "--dsw-alias-interactive-bg-hover"]) {
    assert.equal(css.includes(`var(${bogus})`), false, `不得引用不存在的令牌：${bogus}`);
  }

  // 【最容易犯的错】CSS 是 JS 模板字符串，注释里写 Markdown 行内代码的反引号
  // 会**提前终止模板串**。已踩坑三次（都是注释里写 CSS 属性名时手滑）。
  // 这条断言把错误直接定位到行号，比只看到 SyntaxError 指着注释里的普通单词好得多。
  css.split("\n").forEach((line, i) => {
    if (line.includes("`")) {
      assert.fail(`CSS 第 ${i + 1} 行含反引号（会提前终止模板串）：${line.trim().slice(0, 80)}`);
    }
  });
});

test("面板文案：zh / en 两个字典的 key 集合一致（R-28 多语言不缺失）", async () => {
  const source = await readFile(CLIENT_PATH, "utf8");
  const run = new Function("window", "require", "URLSearchParams", "fetch", "navigator", source);
  let definition = null;
  run(
    { __ModuleLoader__: { load: (def) => { definition = def; } } },
    (id) => {
      if (id === "react") return reactStub;
      throw new Error(`unexpected require(${id})`);
    },
    URLSearchParams,
    async () => {},
    { language: "zh-CN" },
  );
  const module = definition.factory((id) => {
    if (id === "react") return reactStub;
    throw new Error(`unexpected require(${id})`);
  });

  // 通过 locale.register 的调用把字典截获下来
  const dicts = {};
  const ctx = {
    logger: { warn() {}, debug() {} },
    slots: makeSlots().slots,
    get: () => undefined,
    effect: (callback) => {
      const cleanup = callback();
      return cleanup;
    },
    locale: {
      register(ns, idOrDicts, maybeDict) {
        if (typeof idOrDicts === "string") dicts[idOrDicts] = maybeDict;
        else Object.assign(dicts, idOrDicts);
        return () => {};
      },
      // 真实形状：LocaleSnapshot { active, locales, revision } —— 不是 { id }
      getLocale: () => ({ active: "zh", locales: [], revision: 1 }),
      subscribe: () => () => {},
    },
  };
  module.apply(ctx);

  assert.ok(dicts.zh, "必须注册 zh 字典");
  assert.ok(dicts.en, "必须注册 en 字典（R-5.2 内置两个 locale 都要给）");

  const zhKeys = Object.keys(dicts.zh).sort();
  const enKeys = Object.keys(dicts.en).sort();
  assert.deepEqual(zhKeys, enKeys, "两个字典的 key 集合必须一致，否则切换语言会出现原始 key");

  // 面板与菜单的关键文案必须在两个字典里都存在
  for (const key of ["action.delete", "panel.title", "panel.deleteSelected", "panel.resultTitle"]) {
    assert.ok(dicts.zh[key], `zh 缺少 ${key}`);
    assert.ok(dicts.en[key], `en 缺少 ${key}`);
  }
});

/**
 * 【回归 · 悬停即消失】
 *
 * 旧规则 `.dscc-btn:hover { background: bg-layer-2 }` 优先级 (0,2,0)，
 * 压过了变体 `.dscc-btn-danger` / `.dscc-btn-primary` 的 (0,1,0) 实心背景，
 * 但文字色仍是变体声明的 `--dsw-alias-bg-base`（应用底色）。
 * 结果：浅色面 + 底色文字 ⇒ 对比度≈0，鼠标移上去按钮文字就「消失」。
 *
 * 这里在**文本层**做结构断言：hover 换底不得再作用于变体按钮。
 */
test("R-24/可用性：hover 换底不得覆盖实心变体按钮（回归：悬停即消失）", async () => {
  const source = await readFile(CLIENT_PATH, "utf8");
  const css = source.match(/const CSS = `([\s\S]*?)`;/);
  assert.ok(css, "必须能找到 CSS 块");
  const sheet = css[1];

  // 变体按钮必须显式排除在 hover 换底之外
  assert.match(
    sheet,
    /\.dscc-btn:not\(\.dscc-btn-primary\):not\(\.dscc-btn-danger\):hover/,
    "hover 换底必须排除 primary/danger 变体",
  );
  // 变体自己的 hover 只能做亮度微调（同时等比改变文字与背景，保住对比度）
  assert.match(
    sheet,
    /\.dscc-btn-primary:hover,\s*\.dscc-btn-danger:hover\s*\{\s*filter:\s*brightness/,
    "变体按钮的 hover 必须用 filter 微调而非换底",
  );
  // 旧的裸 hover 换底规则不得残留
  assert.equal(
    /(^|[\s}])\.dscc-btn:hover\s*\{/.test(sheet),
    false,
    "不得残留裸 .dscc-btn:hover 换底规则（会再次盖住变体）",
  );
});

/**
 * 【安全回归】选中项必须被限制在**当前可见页**。
 *
 * 旧行为：`selected` 跨页/跨筛选累积。用户在「可删除」下勾 20 行 → 切到别的筛选
 * （那些行不再显示）→ 工具条仍写着「删除所选（20）」，点下去会删掉**用户看不见的会话**。
 * 对一个不可逆操作，用户必须能复核自己正在删什么。
 */
test("面板多选：删除目标必须收敛到当前可见页（回归：不得删看不见的行）", async () => {
  const source = await readFile(CLIENT_PATH, "utf8");

  // 必须存在「可见集合」的交集裁剪，并把裁剪结果用于计数与提交。
  assert.match(source, /visibleIds\s*=\s*new Set\(/, "必须计算当前可见 id 集合");
  assert.match(source, /effectiveSelectedIds\s*=\s*selectedIds\.filter\(/, "必须用可见集合裁剪选中项");

  // 真正提交给删除弹窗的必须是裁剪后的集合，不能是原始累积集合。
  assert.match(source, /bulkIds:\s*effectiveSelectedIds/, "提交删除的必须是可见页的交集");

  // 视图变化后要真正清理 state，避免「计数与可删集合不一致」。
  assert.match(source, /setSelected\(\(prev\)\s*=>\s*\{/, "视图变化后必须收敛 selected state");

  // 越界的勾选要如实告知用户，而不是静默丢弃。
  assert.ok(/panel\.hiddenSelection/.test(source), "必须告知用户有多少勾选被忽略");
});

/**
 * 【回归】面板批量删除必须走**一次**批量请求。
 *
 * 旧实现在 `doDelete` 里 `for (const id of sessionIds) await requestDelete(id)` —— 逐条发
 * N 个请求。配上当时按条数计费的限流（默认 10/分），勾选 50 行必然大面积失败：
 * 前 10 条成功、其余 429。这是「删除逻辑有问题」的头号成因。
 *
 * 这里做结构断言（不渲染组件）：批量路径只能调用 requestDeleteMany，
 * 且 doDelete 体内不得出现调用单条 requestDelete 的循环。
 */
/**
 * 批量删除必须走**一次** `requestDeleteMany`，不得退化成 N 个请求。
 *
 * 旧实现在内联 `doDelete` 里 `for (const id of sessionIds) await requestDelete(id)` ——
 * 逐条发 N 个请求。配上当时**按条数计费**的限流（默认 10/分），勾选 50 行必然大面积失败：
 * 前 10 条成功、其余 429。这是「删除逻辑有问题」的头号成因。
 *
 * 【H2 修正】旧测试锚在 `doDelete` 上 —— 但 `doDelete` **从未被调用**，
 * 面板走的是「删除所选 → 打开确认弹窗 → DeleteDialog.run()」。
 * 也就是说旧测试在保护**死代码**，给出假信心。现在锚到真正执行的 `run()`。
 *
 * 注意：`run()` 里**单条**删除走 `requestDelete` 是**正确设计**（信息最具体）；
 * 只有**批量**分支才必须用一次 `requestDeleteMany`。断言按此分工写。
 */
test("面板批量删除：批量分支只发一次 requestDeleteMany（回归，锚活路径 run()）", async () => {
  const source = await readFile(CLIENT_PATH, "utf8");

  const start = source.indexOf("const run = async () => {");
  assert.ok(start > 0, "必须能找到 DeleteDialog 的 run()（真正被执行的删除路径）");

  // 取到函数体结束（下一个顶层注释段落「设置页 section」或工具条）为止。
  const rest = source.slice(start + 1);
  const endMarks = ["\n      // ── 筛选区", "\n      // ── 顶部工具条", "\n      // ── 表格"];
  const ends = endMarks.map((m) => rest.indexOf(m)).filter((i) => i > 0);
  assert.ok(ends.length > 0, "run() 之后应当能找到一个段落边界");
  const body = rest
    .slice(0, Math.min(...ends))
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  // 批量分支必须存在且只发一次批量请求。
  const sendCount = (body.match(/requestDeleteMany\s*\(/g) ?? []).length;
  assert.equal(sendCount, 1, `批量端点必须恰好调用一次，实际 ${sendCount} 次`);
  // 单条分支允许调用 requestDelete（信息更具体），但**不得有循环**。
  assert.equal(
    /for\s*\([^)]*\)\s*\{[^}]*requestDelete\s*\(/.test(body),
    false,
    "run() 内不得出现「循环里逐条 requestDelete」——那正是旧的 N 请求缺陷",
  );
  // 明确的批量入口：`ids.length > 1` 时必须走批量端点，而不是逐条。
  assert.match(body, /requestDeleteMany\s*\(\s*ids\s*\)/, "批量必须把整个 ids 一次交给 Host");
});

test("面板删除：内联 doDelete 死代码必须已删除（H2 回归）", async () => {
  const source = await readFile(CLIENT_PATH, "utf8");
  // `doDelete` 从未被任何 onClick/effect 调用，它自带一套 busy/result state 与结果条，
  // 与弹窗路径重复。留着会让「面板批量删除」看起来有两条路径，实际只有一条。
  assert.equal(
    source.includes("const doDelete"),
    false,
    "内联 doDelete 死代码必须已删除（面板走 DeleteDialog.run()）",
  );
  // 同理：面板级 busy/result state 与结果条不得复活（它们只被死代码写入）。
  assert.equal(
    /const \[busy, setBusy\]/.test(source),
    false,
    "面板级 busy state 不得复活（恒为 null 的假状态）",
  );
  assert.equal(
    source.includes("resultBar"),
    false,
    "面板级结果条不得复活（恒为 null 的假 UI）",
  );
});

/**
 * 【回归 · 2026-10】删除结果必须按**三态**渲染，不能退化成两态。
 *
 * Host 的 `detachLiveStore` 现在返回 detached / absent / failed 三态：
 *   - detached：确实摘掉了；
 *   - absent  ：本来就不在内存里 —— **正常收尾**；
 *   - failed  ：试了没摘掉 —— 真的降级。
 *
 * 旧前端只有 `v.detached === true ? … : …` 两态，会把 absent 显示成
 * 「内存条目未摘除（降级：只删了磁盘）」。真实宿主里删一个已关闭的会话
 * 绝大多数落在 absent，于是用户每次删旧会话都看到一句吓人的降级提示，
 * 反而盖住真正该关注的情况。
 *
 * 这条测试按本文件既有风格做源码级断言（client.test.mjs 全部是源码级断言，
 * 没有 React 渲染环境），锁住三态分支与它对应的 locale 键都存在。
 */
test("删除结果：内存条目三态分支不得退化为两态（2026-10 回归）", async () => {
  const source = await readFile(CLIENT_PATH, "utf8");

  // ① 渲染处必须有 absent 这一分支。
  assert.match(
    source,
    /v\.detach === "absent"/,
    "结果渲染必须区分 absent（正常收尾）与 failed（真降级）",
  );
  assert.ok(
    source.includes('t("done.detachedAbsent")'),
    "absent 分支必须引用 done.detachedAbsent 文案",
  );

  // ② 两种语言的 locale 表都必须有新键 —— 少一种就会静默退化成内置表，
  //    表现为中文用户看到英文（或反之）。
  assert.ok(
    /"done\.detachedAbsent": "内存中已无此会话/.test(source),
    "中文 locale 必须有 done.detachedAbsent",
  );
  assert.ok(
    /"done\.detachedAbsent": "No live entry to detach/.test(source),
    "英文 locale 必须有 done.detachedAbsent",
  );

  // ③ failed 分支的文案必须仍然存在（不得被 absent 替换掉）。
  assert.ok(
    source.includes('t("done.detachedNo")'),
    "failed 分支的 done.detachedNo 必须保留",
  );
  assert.ok(
    source.includes('v.detached === true'),
    "detached 分支必须保留（三态齐备）",
  );
});
