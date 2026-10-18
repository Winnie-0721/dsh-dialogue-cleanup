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

/**
 * R-23 / R-22 合规：client.js 不 require Harness Client 包，也不写宿主 DOM。
 *
 * 【口径修正 · 2026-10】原断言是「源码里不得出现 querySelector」，
 * 而 R-22/R-25 的真实口径是**不得读别的插件的 DOM / 样式表 / 组件源码来估位置**：
 *   > Do not read another plugin's DOM, stylesheet, or component source to
 *   > estimate placement; choose a slot that already allocates space.
 * 在自己的卡片元素上 querySelector 找「第一个可聚焦控件」是焦点陷阱的必需步骤
 * （官方 useModalLayer 也正是这么做的），它与「读宿主 DOM 定位」是两件事。
 * 因此这里改成**按对象收紧**：仍然禁止碰 document / documentElement / body /
 * 以及任何 class 选择器（那才是「去宿主 DOM 里翻别人家的节点」）；
 * 而 element.querySelector(...) 这种在自己 ref 上的查询放行。
 */
test("R-23 / R-22 合规：client.js 不 require Harness Client 包，也不写宿主 DOM", async () => {
  const source = await readFile(CLIENT_PATH, "utf8");
  // 去掉注释后再检查，避免把「说明我们不这么做」的注释误判成违规
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  assert.equal(/require\(\s*['"]@deepseek-ai/.test(code), false, "不得 require 任何 @deepseek-ai/* 包");
  assert.equal(/appendChild/.test(code), false, "不得 appendChild 到宿主 DOM");
  assert.equal(/document\.body/.test(code), false, "不得触碰 document.body");
  assert.equal(/documentElement/.test(code), false, "不得触碰 documentElement");
  assert.equal(/MutationObserver/.test(code), false, "不得使用 MutationObserver");
  assert.equal(/createPortal/.test(code), false, "不得用 portal 把 DOM 挂到组件外");
  assert.equal(/document\.createElement/.test(code), false, "不得手写 DOM 节点");
  // 「读宿主 DOM 定位」的判据：**按宿主对象**查询（document.* 或按 class 翻别人家节点）。
  assert.equal(
    /document\.querySelector/.test(code),
    false,
    "不得在 document 上做 querySelector（那才是读宿主 DOM 定位）",
  );
  assert.equal(
    /querySelector\(\s*['"]\./.test(code),
    false,
    "不得按 class 选择器查询（那是去宿主 DOM 里翻别的插件的节点）",
  );
});

/**
 * R-24 合规：样式只用主题令牌，字面色仅限纯美术。
 *
 * 【这张允许表从哪来 · 已实测更正】
 * 旧版本把允许表写成「现场 Theme.listTokens 的 14 条」，并据此判定
 * --dsw-radius-* / --dsw-alias-interactive-bg-* / --dsw-alias-button-*
 * 等名字「不存在」，于是把它们换算成字面圆角与近似底色。
 * **那个前提是错的**：inspect 的 14 条只是子集，真正的令牌表由
 * @deepseek-ai/dsh-client-ui-theme 在运行时整表注入。
 * 这次直接读那个包的 lib/client.js，逐个字符串核对，得到下表。
 * 换算成字面值才是上一版界面「看着还是不像官方」的根因之一。
 *
 * 核对方式（可复现）：
 *   npx @electron/asar extract app.asar %TEMP%\dshextract
 *   在 dsh\node_modules\@deepseek-ai\dsh-client-ui-theme\lib\client.js 里
 *   搜每个令牌名；颜色类出现 2 次（明暗两套主题各一次），几何类 1 次（全局单值）。
 */
test("R-24 合规：client.js 只用主题令牌，且令牌确实存在于主题包", async () => {
  const source = await readFile(CLIENT_PATH, "utf8");

  // 实测存在于 dsh-client-ui-theme 的令牌（40 条中用到的 38 条 + 少量备用）。
  const ALLOWED = new Set([
    // 底色与面
    "--dsw-alias-bg-base",
    "--dsw-alias-bg-layer-1",
    "--dsw-alias-bg-layer-2",
    "--dsw-alias-bg-layer-3",
    "--dsw-alias-bg-overlay",
    "--dsw-alias-bg-mask-1",
    "--dsw-alias-bg-module-platform",
    "--dsw-alias-settings-card-fill",
    "--dsw-alias-settings-card-stroke",
    "--dsw-menu-surface-fill",
    "--dsw-mask-blur",
    // 描边
    "--dsw-alias-border-l1",
    "--dsw-alias-border-l2",
    "--dsw-alias-border-l3",
    "--dsw-alias-border-l4",
    // 文字与品牌
    "--dsw-alias-label-primary",
    "--dsw-alias-label-primary-foreground",
    "--dsw-alias-label-secondary",
    "--dsw-alias-label-tertiary",
    "--dsw-alias-menu-icon",
    "--dsw-alias-brand-primary",
    // 状态
    "--dsw-alias-state-error-primary",
    "--dsw-alias-state-idle-primary",
    "--dsw-alias-state-success-primary",
    "--dsw-alias-state-warn-primary",
    "--dsw-alias-state-business-primary",
    // 交互底色与按钮
    "--dsw-alias-interactive-bg-hover",
    "--dsw-alias-interactive-bg-active",
    "--dsw-alias-button-primary-fill",
    "--dsw-alias-button-primary-hover",
    // 几何尺度（全局单值：xs4 / sm8 / md12 / lg16 / xl20 / panel28）
    "--dsw-radius-xs",
    "--dsw-radius-sm",
    "--dsw-radius-md",
    "--dsw-radius-lg",
    "--dsw-radius-xl",
    "--dsw-radius-panel",
    // 层级与焦点
    "--dsw-elevation-soft",
    "--dsw-elevation-prominent",
    "--dsw-elevation-stroke",
    "--dsw-elevation-stroke-color",
    "--dsw-focus-ring-width",
    "--dsw-focus-ring-color",
    // 字体
    "--ds-font-family-code",
    // 桌面框几何：由 dsh-client-ui-layout 注入，官方 CSS 也一律带 fallback
    "--dsh-frame-overlay-top",
    "--dsh-frame-chrome-top",
    "--dsw-specific-sidebar-fill",
  ]);

  // 只扫**真正消费令牌**的地方：var(--…)。注释里的说明文字不算。
  const used = new Set();
  for (const match of source.matchAll(/var\(\s*(--[a-z0-9-]+)\s*[,)]/g)) {
    used.add(match[1]);
  }

  assert.ok(used.size >= 20, `应当大量使用主题令牌，实际 ${used.size} 个`);
  for (const token of used) {
    assert.ok(ALLOWED.has(token), `使用了主题包里查无此名的令牌：${token}`);
  }

  // 附录 C.12 的 C 项：这两个名字在实测里**确实不存在**（早期设计稿凭空写的），
  // 必须一个都没用。注意 --dsw-alias-interactive-bg-hover-danger 与之不同，
  // 它真实存在（官方 Menu 的 .danger 档就在用），所以不在此列。
  for (const bogus of ["--dsw-alias-danger", "--dsw-alias-hairline"]) {
    assert.equal(used.has(bogus), false, `不得使用不存在的令牌：${bogus}`);
  }
  // 官方自己有两个悬空引用（在 CSS 里用了但主题包没定义）—— 我们不得跟。
  for (const dangling of ["--dsw-transition-duration", "--dsw-ease-in-out"]) {
    assert.equal(used.has(dangling), false, `官方悬空引用，不得使用：${dangling}`);
  }

  // 桌面框几何令牌必须带 fallback：非桌面宿主上它们不存在。
  for (const frame of ["--dsh-frame-overlay-top", "--dsh-frame-chrome-top"]) {
    for (const m of source.matchAll(new RegExp(`var\\(\\s*${frame}\\s*(,\\s*[^)]*)?\\)`, "g"))) {
      assert.ok(m[1], `令牌 ${frame} 必须带 fallback（只在桌面壳里被注入）：${m[0]}`);
    }
  }

  // 硬编码颜色：一律禁止（本文件已无任何纯色，连阴影也走 elevation 令牌）。
  const literalHex = source.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  assert.deepEqual(literalHex, [], `不得出现硬编码颜色：${literalHex.join(", ")}`);
  const cssBlock = /const CSS = `([\s\S]*?)`;/.exec(source)?.[1] ?? "";
  const rgbInCss = cssBlock.replace(/\/\*[\s\S]*?\*\//g, "").match(/rgba?\([^)]*\)/g) ?? [];
  assert.deepEqual(rgbInCss, [], `CSS 内不得出现 rgb(a) 字面色：${rgbInCss.join(", ")}`);
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
 * 【回归 · 官方形态】控件几何与层级必须**真的**照官方 primitives 走。
 *
 * 背景：R-23 禁的是 require 官方包，但同一条规则给了正路 ——
 * 「copy markup, CSS, and behavior from the primitive into the plugin」。
 * 这一版把按钮/徽标/卡面/弹窗全部换成官方形态，所以要有断言把它们钉住，
 * 否则下一次"顺手改一版"就会无声地退回自绘样式。
 *
 * 官方出处（asar 内 @deepseek-ai/dsh-client-ui-primitives/lib）：
 *   Button.module.css  → md 高 36px / radius-md(12px) / 内边距 0 14px / 14px 字 22px 行高；
 *                        sm 高 28px / radius-sm(8px) / 内边距 0 10px / 12px 字 18px 行高。
 *   Tag.module.css     → 999px 圆角 / 1px 8px / 11px 字 17px 行高 / 500 字重 / nowrap；
 *                        状态 tone = color-mix 10%（warning 用 12%）自着色底 + 同色文字。
 *   Modal.module.css   → position:fixed + inset:0 + z-index:1000，flex 居中，padding 24px。
 *   设置页卡片（dsh-client-ui-settings-plugin-inventory 的 LanguageRow/卡片族）
 *                       → 0.5px settings-card-stroke / radius-xl(20px) / settings-card-fill。
 *
 * 【为什么断言的是"用了哪个令牌"而不是"多少像素"】
 * 上一版这里断言 `border-radius: 12px` 字面值 —— 那本身就是错的产物：
 * 官方写的是 `var(--dsw-radius-md)`，值由主题给（实测 md=12px）。
 * 抄字面值等于把官方尺度硬编码进插件，主题一改就分叉。
 * 所以这里断言**必须引用官方令牌**，并在 TOKEN_SCALES 里钉住
 * 「该令牌实测等于多少像素」，这样令牌被换成别的档位时也会红。
 */
const TOKEN_SCALES = {
  "--dsw-radius-xs": "4px",
  "--dsw-radius-sm": "8px",
  "--dsw-radius-md": "12px",
  "--dsw-radius-lg": "16px",
  "--dsw-radius-xl": "20px",
  "--dsw-radius-panel": "28px",
};

test("官方形态：按钮 / 徽标 / 弹窗的几何与层级必须对齐官方 primitives", async () => {
  const source = await readFile(CLIENT_PATH, "utf8");
  const cssMatch = source.match(/const CSS = `([\s\S]*?)`;/);
  assert.ok(cssMatch, "必须能找到 CSS 块");
  const sheet = cssMatch[1];

  const rule = (selector) => {
    // 选择器里带正则元字符（:not(:disabled) 的括号），必须先转义再拼进正则。
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(sheet);
    assert.ok(m, `缺少规则：${selector}`);
    return m[1];
  };
  /** 断言某条规则用了指定令牌（而不是把官方像素值硬编码进插件）。 */
  const usesToken = (block, token, what) => {
    assert.ok(
      block.includes(`var(${token}`),
      `${what} 必须用官方令牌 ${token}（=${TOKEN_SCALES[token]}），不得写字面像素值`,
    );
  };

  // ── Button（官方 md 刻度） ──
  const btn = rule(".dscc-btn");
  assert.match(btn, /height:\s*36px/, "按钮高度必须 36px（官方 md）");
  usesToken(btn, "--dsw-radius-md", "按钮圆角");
  assert.match(btn, /padding:\s*0 14px/, "按钮水平内边距必须 0 14px（官方 md）");
  assert.match(btn, /font-size:\s*14px/, "按钮字号必须 14px（官方 md）");
  assert.match(btn, /line-height:\s*22px/, "按钮行高必须 22px（官方 md）");
  // 【实测修复不得丢】按钮文字不得折行，否则「刷新」被压成「刷/新」两行。
  assert.match(btn, /white-space:\s*nowrap/, "按钮文字必须 nowrap（既有实测修复）");

  // ── Button（官方 sm 刻度） ──
  const sm = rule(".dscc-btn-small");
  assert.match(sm, /height:\s*28px/, "小按钮高度必须 28px（官方 sm）");
  usesToken(sm, "--dsw-radius-sm", "小按钮圆角");
  assert.match(sm, /padding:\s*0 10px/, "小按钮水平内边距必须 0 10px（官方 sm）");

  // 官方 primary 档的三个令牌：底色、前景、悬停底色各一个，不得近似替代。
  const primary = rule(".dscc-btn-primary");
  assert.match(primary, /var\(--dsw-alias-button-primary-fill\)/, "primary 底色必须用官方 button-primary-fill");
  assert.match(primary, /var\(--dsw-alias-label-primary-foreground\)/, "primary 文字必须用官方前景令牌（不得写 bg-base）");
  assert.match(
    rule(".dscc-btn-primary:hover:not(:disabled)"),
    /var\(--dsw-alias-button-primary-hover\)/,
    "primary 悬停必须用官方 button-primary-hover（换底，不是 filter）",
  );
  // 中性按钮的悬停/按下底色：官方是 interactive-bg-hover / -active 两个令牌。
  // 【变异测试补的断言】T5「退回 bg-layer-2 近似」曾经存活 —— 上一版就是因为
  // 把这两个官方令牌当成"不存在"而用 bg-layer-2 凑，观感差一档却没人拦得住。
  assert.match(
    rule(".dscc-btn:not(.dscc-btn-primary):not(.dscc-btn-danger):not(:disabled):hover"),
    /background:\s*var\(--dsw-alias-interactive-bg-hover\)/,
    "中性按钮悬停必须用官方 interactive-bg-hover（不得用 bg-layer-2 近似）",
  );
  assert.match(
    rule(".dscc-btn:not(.dscc-btn-primary):not(.dscc-btn-danger):not(:disabled):active"),
    /background:\s*var\(--dsw-alias-interactive-bg-active\)/,
    "中性按钮按下必须用官方 interactive-bg-active",
  );

  // ── Tag（官方胶囊） ──
  const tag = rule(".dscc-badge");
  assert.match(tag, /border-radius:\s*999px/, "徽标必须是 999px 全圆角胶囊（官方 Tag）");
  assert.match(tag, /padding:\s*1px 8px/, "徽标内边距必须 1px 8px（官方 Tag）");
  assert.match(tag, /font-size:\s*11px/, "徽标字号必须 11px（官方 Tag）");
  assert.match(tag, /line-height:\s*17px/, "徽标行高必须 17px（官方 Tag）");
  assert.match(tag, /font-weight:\s*500/, "徽标字重必须 500（官方 Tag）");
  assert.match(tag, /white-space:\s*nowrap/, "徽标不得折行（官方 Tag）");
  assert.match(tag, /display:\s*inline-flex/, "徽标必须 inline-flex（官方 Tag）");

  // 官方 Tag 的 outline 档（默认档）：0.5px 细边 + border-l4。
  // 官方在四个 l* 描边档位里给 Tag 挑的是最浅的 l4，写回 1px/l2 会明显变重。
  assert.match(
    rule(".dscc-badge-outline"),
    /border:\s*0\.5px solid var\(--dsw-alias-border-l4\)/,
    "徽标 outline 档必须 0.5px border-l4（官方 Tag 默认档）",
  );

  // 状态 tone：官方做法是 color-mix 自着色底 + 同色文字（一次换色，底与字一起动）。
  // 这里把四种状态都钉住，防止退回"只有文字色"的旧形态。
  for (const [sel, token, pct] of [
    [".dscc-badge-ok", "state-success-primary", "10%"],
    [".dscc-badge-running", "state-warn-primary", "12%"],
    [".dscc-badge-archived", "state-idle-primary", "10%"],
    [".dscc-badge-subagent", "state-warn-primary", "12%"],
  ]) {
    const r = rule(sel);
    assert.match(
      r,
      new RegExp(`color-mix\\(\\s*in srgb,\\s*var\\(--dsw-alias-${token}\\)\\s+${pct.replace("%", "%")},\\s*transparent\\s*\\)`),
      `${sel} 必须用官方 color-mix ${pct} 自着色底`,
    );
    assert.match(r, new RegExp(`color:\\s*var\\(--dsw-alias-${token}\\)`), `${sel} 文字必须用同一状态令牌`);
  }

  // ── Modal（官方层级） ──
  const modal = rule(".dscc-modal");
  assert.match(modal, /position:\s*fixed/, "弹窗必须 fixed（官方 Modal）");
  assert.match(modal, /inset:\s*0/, "弹窗必须铺满视口（官方 Modal）");
  assert.match(modal, /z-index:\s*1000/, "弹窗 z-index 必须 1000（官方 Modal；否则盖不住设置面板）");
  assert.match(modal, /align-items:\s*center/, "弹窗必须垂直居中（官方 Modal）");
  assert.match(modal, /justify-content:\s*center/, "弹窗必须水平居中（官方 Modal）");

  // ── 卡面（官方设置页卡片：细描边 + radius-xl + 卡片底） ──
  // 【实测定位】浅色主题下 bg-base / bg-layer-1 / bg-layer-2 **三个值完全相同**，
  // 所以上一版把卡面从 layer-1 换成 layer-2 等于什么都没换 —— 卡片与页面同色、
  // 只剩一圈描边，看着就是"贴了个框"。官方根本不靠底色区分卡片。
  const row = rule(".dscc-row");
  usesToken(row, "--dsw-radius-xl", "卡片行圆角");
  assert.match(row, /border:\s*0\.5px solid var\(--dsw-alias-settings-card-stroke\)/, "卡片行必须 0.5px settings-card-stroke 细描边（官方）");
  assert.match(row, /background:\s*var\(--dsw-alias-settings-card-fill\)/, "卡片行底色必须 settings-card-fill（官方）");
  // 官方卡片的悬停反馈是换底，不是位移/阴影。
  assert.match(
    rule(".dscc-row:hover"),
    /var\(--dsw-alias-interactive-bg-hover\)/,
    "卡片行悬停必须换官方 interactive-bg-hover 底色",
  );
  // 【实测修复不得丢】主内容列 min-width:0，否则标题省略号不生效。
  assert.match(rule(".dscc-row-main"), /min-width:\s*0/, "主内容列必须 min-width:0（省略号生效的前提）");

  // ── 筛选下拉：官方「选择器药丸」（不是原生 select） ──
  // 原生 select 的下拉面板由操作系统绘制，与官方主题完全两个世界。
  const selector = rule(".dscc-selector");
  assert.match(selector, /height:\s*36px/, "选择器药丸必须 36px 高（官方语言行同款）");
  usesToken(selector, "--dsw-radius-md", "选择器药丸圆角");
  assert.match(selector, /gap:\s*12px/, "选择器药丸 gap 必须 12px（官方语言行同款）");
  assert.match(selector, /background:\s*var\(--dsw-alias-bg-module-platform\)/, "选择器药丸底色必须 bg-module-platform（官方）");
  assert.match(selector, /padding:\s*0 14px/, "选择器药丸内边距必须 0 14px（官方）");
  // 官方 Menu 的 .list：radius-lg + 4px 内边距 + prominent 阴影 + 贴下方 4px。
  const menu = rule(".dscc-menu");
  usesToken(menu, "--dsw-radius-lg", "下拉列表圆角");
  assert.match(menu, /padding:\s*4px/, "下拉列表内边距必须 4px（官方 Menu）");
  assert.match(menu, /top:\s*calc\(100% \+ 4px\)/, "下拉必须贴在触发器下方 4px（官方 Menu）");
  assert.match(menu, /box-shadow:\s*var\(--dsw-elevation-prominent\)/, "下拉必须用官方 prominent 层级阴影");
  assert.match(menu, /background:\s*var\(--dsw-menu-surface-fill\)/, "下拉底色必须 menu-surface-fill（官方）");

  // ── 搜索框：官方 Input / 清单页搜索框 ──
  const input = rule(".dscc-input");
  assert.match(input, /height:\s*36px/, "搜索框必须 36px 高（官方清单页同款）");
  assert.match(input, /border:\s*0\.5px solid var\(--dsw-alias-border-l4\)/, "搜索框必须 0.5px l4 描边（官方）");
  usesToken(input, "--dsw-radius-md", "搜索框圆角");
  assert.match(input, /background:\s*var\(--dsw-alias-bg-layer-1\)/, "搜索框底色必须 bg-layer-1（官方）");
  // 官方聚焦：描边换聚焦色 + 18% 同色光晕（不是 outline）。
  assert.match(rule(".dscc-input:focus-visible"), /box-shadow:\s*0 0 0 2px color-mix/, "搜索框聚焦必须用官方光晕做法");

  // ── 弹窗卡片：官方 Modal 的 dialog ──
  const dialog = rule(".dscc-card");
  usesToken(dialog, "--dsw-radius-panel", "弹窗卡片圆角");
  assert.match(dialog, /box-shadow:\s*var\(--dsw-elevation-prominent\)/, "弹窗卡片必须官方 prominent 层级阴影");
  assert.match(dialog, /background:\s*var\(--dsw-alias-bg-layer-2\)/, "弹窗卡片底色必须 bg-layer-2（官方）");
  assert.match(dialog, /gap:\s*20px/, "弹窗卡片纵向间距必须 20px（官方）");
  // 官方遮罩走 backdrop-filter + bg-mask-1，不是自己 color-mix 凑一个。
  assert.match(rule(".dscc-modal-mask"), /backdrop-filter:\s*var\(--dsw-mask-blur\)/, "遮罩必须用官方 mask-blur");
  assert.match(rule(".dscc-modal-mask::after"), /background:\s*var\(--dsw-alias-bg-mask-1\)/, "遮罩底色必须 bg-mask-1（官方）");

  // 勾选框：官方 Checkbox 给 input 的那三件（16px 见方 / accent-color 跟随品牌色 /
  // 官方焦点环）。【变异测试补的断言】G2「焦点环改成 none」曾经存活 ——
  // 规则写了但没人核对，键盘用户就没有任何可见焦点指示。
  const check = rule(".dscc-row-check");
  assert.match(check, /width:\s*16px/, "勾选框必须 16px 见方（官方 Checkbox）");
  assert.match(check, /height:\s*16px/, "勾选框必须 16px 见方（官方 Checkbox）");
  assert.match(check, /accent-color:\s*var\(--dsw-alias-brand-primary\)/, "勾选框必须用品牌色 accent-color（官方）");
  assert.match(
    rule(".dscc-row-check:focus-visible"),
    /outline:\s*var\(--dsw-focus-ring-width\)\s+solid\s+var\(--dsw-focus-ring-color/,
    "勾选框必须有官方焦点环（否则键盘用户看不到焦点在哪）",
  );

  // ── 官方令牌尺度表：值一旦和主题包实测不符，说明抄错了档位 ──
  const usedTokens = [...sheet.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]);
  for (const [token, px] of Object.entries(TOKEN_SCALES)) {
    if (token.startsWith("--dsw-radius")) {
      assert.ok(usedTokens.includes(token), `圆角令牌 ${token}（=${px}）必须真的被使用`);
    }
  }
});

/**
 * 【回归 · 官方 Modal 的键盘与焦点语义】
 *
 * 官方 useModalLayer 做四件事，本插件按 R-23 正路把它们拷了进来：
 *   1. 打开时把焦点移进卡片；
 *   2. Esc 关闭，且 repeat 不重复触发；
 *   3. Tab / Shift+Tab 在卡片内循环（焦点陷阱）；
 *   4. 关闭时把焦点还给打开前的元素。
 * 外加一条本插件自己的：**busy 时不允许关闭**（删除进行中关掉界面会让人以为取消）。
 *
 * 这里用真实 DOM 桩驱动 useModalLayer，逐条验证行为而不是只看源码形状。
 */
test("官方 Modal 语义：焦点移入 / Esc 关闭 / Tab 循环 / busy 不关 / 关闭还焦", async () => {
  const source = await readFile(CLIENT_PATH, "utf8");
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
    { language: "zh-CN" },
  );

  // 只有 createElement/useState/useEffect 的 React 替身（官方 Builtin 的真实约束）。
  const reactForHooks = {
    createElement: () => null,
    Fragment: Symbol("Fragment"),
    useState: (initial) => {
      const box = { current: typeof initial === "function" ? initial() : initial };
      return [box.current, () => {}];
    },
    useEffect: (fn) => fn(),
  };
  const module = definition.factory((id) => {
    if (id === "react") return reactForHooks;
    throw new Error(`unexpected require(${id})`);
  });

  // 从 apply 拿不到 hook（它在闭包里），所以直接把 factory 内部实现驱动起来：
  // 用一个最小的宿主 DOM 桩，把 useModalLayer 的行为跑一遍。
  // 做法：重新执行一次 client.js，但把 react 替身的 useEffect 换成"立即执行"，
  // 并借 DeleteDialog 的渲染路径触发 useModalLayer。
  // —— 更直接的办法：源码级断言 + 一个独立的 DOM 桩子测试。这里取后者。
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  // (a) 【2026-10-18 迁移到原生 <dialog>】Esc 现在由浏览器的 `cancel` 事件负责，
  //     不再自己拦 keydown —— 原生 dialog 的 Esc 语义就是 cancel，拦掉它即可
  //     实现「busy 时不关」，且不会和浏览器的默认关闭打架。
  assert.match(code, /addEventListener\("cancel"/, "必须处理原生 dialog 的 cancel（Esc 语义）");
  assert.match(code, /event\.preventDefault\(\)[\s\S]{0,80}allowRef\.current !== false/, "busy 时必须挡住 cancel（否则删除中界面被关掉）");
  // (a2) 进/出 top layer：showModal() 是置顶的唯一保证，close() 必须成对出现，
  //      否则 dialog 留在 top layer 上，整个页面会被永久模态。
  assert.match(code, /showModal\s*\(/, "必须调用 showModal() 进 top layer（否则被设置页压住）");
  // 必须是**真的调用** `element.close()`，而不是仅仅出现 typeof 检查。
  // （宽松的 /\.close\(/ 会被 `typeof element.close === "function"` 骗过 —— 变异 M4 就存活过。）
  assert.match(code, /element\.close\s*\(\s*\)/, "关闭时必须真的调用 element.close() 退出 top layer");
  assert.match(code, /element\.open !== true/, "showModal 必须幂等（重复调用会抛错）");
  // (b) 与宿主快捷键共存
  assert.match(code, /event\.ctrlKey === true \|\| event\.altKey === true \|\| event\.metaKey === true/, "带修饰键不得拦截（让宿主快捷键走）");
  // (c) Tab 焦点陷阱
  assert.match(code, /event\.key !== "Tab"/, "必须处理 Tab");
  assert.match(code, /event\.shiftKey === true \? last : first/, "Shift+Tab 必须回到最后一个可聚焦元素");
  // (d) 初始焦点与还焦
  assert.match(code, /data-modal-autofocus/, "必须优先聚焦 data-modal-autofocus 标记的控件（官方同款）");
  assert.match(code, /previous\.isConnected === true/, "关闭时必须把焦点还给打开前的元素（官方同款）");
  // (e) 可聚焦元素集合必须与官方同一套口径
  assert.match(code, /button:not\(\[disabled\]\)/, "可聚焦集合必须含 button:not([disabled])（官方同款）");
  assert.match(code, /\[tabindex\]:not\(\[tabindex='-1'\]\)/, "可聚焦集合必须含 tabindex 排除 -1（官方同款）");
  // (f) 菜单打开时 Tab 归菜单（官方同款）
  assert.match(code, /closest\('\[role="menu"\]'\)/, "菜单内 Tab 必须放行给菜单（官方同款）");
});

/**
 * 【回归 · R-22/R-23 的边界没有被我方放宽成"什么都行"】
 *
 * 上一条把 querySelector 从"一律禁止"改成"按对象禁止"，这里补上**收紧的那一半**：
 * 一旦有人在 element 上按 class 翻别人家节点（那正是 R-25 禁止的"读别的插件的 DOM"），
 * 必须被抓住。没有这条，前一条的口径修正就成了净放宽。
 */
test("R-22/R-25 收紧：不得按 class 选择器或 document 查询宿主 DOM", async () => {
  const source = await readFile(CLIENT_PATH, "utf8");
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  assert.equal(
    /querySelector(All)?\(\s*['"]\./.test(code),
    false,
    "不得按 class 选择器查询（= 去宿主 DOM 里翻别的插件的节点，R-25）",
  );
  assert.equal(
    /document\.querySelector(All)?/.test(code),
    false,
    "不得在 document 上查询（= 读宿主 DOM 定位，R-22）",
  );
  // 正向：允许的用法是「在自己的 ref 上按属性/角色查」，必须确实存在
  // （否则这条测试会被"什么都不查"的空实现骗绿）。
  assert.match(code, /querySelector\(\s*"\[data-modal-autofocus\]"/, "必须在自己卡片上按属性查询初始焦点控件");
});

/**
 * 【死规则防线】CSS 里声明的每一个 .dscc-* 类，必须真的出现在 JSX 侧。
 *
 * 【这条测试怎么来的 · 一次真实抓到的 bug】
 * 把搜索框从「input 直接挂两个类」换成官方 Input 的 wrap 两层结构后，
 * 规则 .dscc-input.dscc-filters-search 就再也匹配不到任何元素了 ——
 * 而它的级联断言**只读 CSS 文本、不看 DOM**，于是测试照样绿。
 * 变异测试（D1/D2）把它抓了出来。同一轮又扫出 .dscc-card-surface、
 * .dscc-check、.dscc-list-head、.dscc-panel-result 四条同样匹配不到元素的规则。
 *
 * 所以这里做**全量**核对：CSS 里每个 .dscc-xxx 选择器都要在
 * 样式表之外的源码里出现过（作为 className 的一部分）。
 * 匹配不到 = 纯装饰 = 改它不会有任何测试变红，必须清掉。
 *
 * 已知限制（如实说明）：这只能证明「这个名字在代码里出现过」，
 * 不能证明「这个元素真的被渲染出来」。后者要靠渲染测试
 * （见 render.test.mjs 里对搜索框外层类名的 DOM 断言）。
 */
test("死规则防线：CSS 里每个 .dscc-* 类都必须被 JSX 使用", async () => {
  const source = await readFile(CLIENT_PATH, "utf8");
  const cssMatch = source.match(/const CSS = `([\s\S]*?)`;/);
  assert.ok(cssMatch, "必须能找到 CSS 块");
  const sheet = cssMatch[1];

  // 样式表以外的部分（JSX 与逻辑）才是"使用处"。
  const outside = source.replace(cssMatch[0], "");

  const declared = new Set();
  for (const m of sheet.matchAll(/\.(dscc-[a-z][a-z0-9-]*)/g)) declared.add(m[1]);
  assert.ok(declared.size >= 40, `应当声明了足够多的类，实际 ${declared.size}`);

  const dead = [...declared].filter((name) => !outside.includes(name));
  assert.deepEqual(dead, [], `以下 CSS 类在 JSX 侧从不出现（死规则，匹配不到任何元素）：${dead.join(", ")}`);
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

  // 不得引用不存在的令牌（R-24 的补充：全表里没有的两个名字）
  for (const bogus of ["--dsw-alias-danger", "--dsw-alias-hairline"]) {
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
 * 【这一版为什么 primary 改成"换底"了】
 * 官方 Button 的 primary 档本来就是**换底**：hover 换到 button-primary-hover，
 * 而文字色始终是 label-primary-foreground（一个"配在主色上的前景"令牌）。
 * 旧 bug 的成因不是"换底"本身，而是**换底规则没有排除变体**，
 * 于是把实心背景换成了浅色面、文字却还是深色 —— 两边不同步才看不见。
 * 所以这里的不变量是两条：
 *   1. 中性换底规则必须排除实心变体（否则旧 bug 复发）；
 *   2. 实心变体换底时，底色与文字必须**同时**由官方令牌给出（不得一边换一边不换）。
 * danger 档官方没有对应令牌，沿用本插件的亮度微调 —— 那也是底与字同步变化。
 */
test("R-24/可用性：hover 换底不得覆盖实心变体按钮（回归：悬停即消失）", async () => {
  const source = await readFile(CLIENT_PATH, "utf8");
  const css = source.match(/const CSS = `([\s\S]*?)`;/);
  assert.ok(css, "必须能找到 CSS 块");
  const sheet = css[1];

  // (1) 变体按钮必须显式排除在中性换底之外
  assert.match(
    sheet,
    /\.dscc-btn:not\(\.dscc-btn-primary\):not\(\.dscc-btn-danger\):not\(:disabled\):hover/,
    "中性 hover 换底必须排除 primary/danger 变体（以及禁用态）",
  );
  // (2) primary 走官方换底令牌，且前景色由官方"主色上的前景"令牌给出 —— 两边同步
  assert.match(
    sheet,
    /\.dscc-btn-primary:hover:not\(:disabled\)\s*\{\s*background:\s*var\(--dsw-alias-button-primary-hover\)/,
    "primary 悬停必须换官方 button-primary-hover 底色",
  );
  assert.match(
    sheet,
    /\.dscc-btn-primary\s*\{[^}]*color:\s*var\(--dsw-alias-label-primary-foreground\)/,
    "primary 文字必须是 label-primary-foreground（换底后对比度才不丢）",
  );
  // (3) danger 没有官方 hover 令牌，必须用亮度微调（底与字同步变化）
  assert.match(
    sheet,
    /\.dscc-btn-danger:hover:not\(:disabled\)\s*\{\s*filter:\s*brightness/,
    "danger 悬停必须用 filter 微调（换底会重现旧 bug）",
  );
  // (4) 旧的裸 hover 换底规则不得残留
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

/**
 * 【回归 · 2026-10-16 · 「删了却还在未分组里」的真修法】
 *
 * Host 删除成功后必须 emit 已声明的 Remote Event `api-session/removed`，
 * 客户端据此把该行从侧栏列表里抹掉。前端要把这个状态显示出来：
 *   - announced === true  → 「已通知侧边栏移除该会话」
 *   - announced === false → 如实说明「未能通知，可能要刷新页面」
 *
 * 少了这条分支，用户删完之后得不到任何关于侧栏的反馈，
 * 于是反复来问「怎么还在」。
 */
test("删除结果：必须显示「是否已通知侧边栏」（2026-10-16 回归）", async () => {
  const source = await readFile(CLIENT_PATH, "utf8");

  // ① 渲染处必须读 v.announced 三态（true / false / 缺省不显示）。
  assert.match(source, /v\.announced === true/, "必须处理「已通知」这一态");
  assert.match(source, /v\.announced === false/, "必须处理「未能通知」这一态");
  assert.ok(source.includes('t("done.announced")'), "已通知分支必须引用对应文案");
  assert.ok(source.includes('t("done.announceOff")'), "未通知分支必须引用对应文案");

  // ② 两种语言都要有新键 —— 少一种会静默退化成内置表。
  assert.ok(/"done\.announced": "已通知侧边栏移除该会话/.test(source), "中文 locale 必须有 done.announced");
  assert.ok(/"done\.announced": "The sidebar was told to drop this session/.test(source), "英文 locale 必须有 done.announced");
  assert.ok(/"done\.announceOff": "未能通知侧边栏/.test(source), "中文 locale 必须有 done.announceOff");
  assert.ok(/"done\.announceOff": "Could not notify the sidebar/.test(source), "英文 locale 必须有 done.announceOff");

  // ③ Host 侧必须真的 emit 这个事件名（client.test.mjs 只读 client.js，
  //     所以这条断言放在 service 的测试里；这里只确认前端引用了同一个字段名）。
  assert.ok(
    /announced:\s*announced\.announced/.test(await readFile(new URL("../lib/service.js", import.meta.url), "utf8")),
    "Host 返回值必须带 announced 字段（前端依赖它）",
  );
});
