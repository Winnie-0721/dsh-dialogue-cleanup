/**
 * 插件配置（R-13：用户可调的值必须做成 Config，用户的 patch 层在升级后存活）。
 *
 * ─── 为什么这里自己实现 `~standard`，而不 `import z from '@deepseek-ai/schemastery'` ──
 * 首次安装实测报错：
 *   TypeError: Cannot read properties of undefined (reading 'validate')
 *     at resolveConfig (.../@deepseek-ai/cordis/lib/index.js:958:45)
 * 即：Cordis 把 `Config` 当作 **Standard Schema** 用 —— 读 `Config['~standard'].validate`，
 * 而不是把它当裸 JSON Schema。官方自带插件（dsh-context、dsh-memory）用
 * `z.object({...})`（`@deepseek-ai/schemastery`）正是因为它实现了该接口。
 *
 * 但本插件**不能**照抄那个 import：`plugin_manager install_bundle` 是把插件目录
 * **软链接**进 profile 的 `node_modules`，而软链接的 realpath 在 profile 之外，
 * 于是 `@deepseek-ai/schemastery` 这种裸包名解析不到（实测 ERR_MODULE_NOT_FOUND）。
 * 即使写进 peerDependencies 也救不了它 —— 解析是按 realpath 走的。
 *
 * 结论：本文件**零依赖**地实现 Standard Schema v1 的最小契约
 *   { '~standard': { version: 1, vendor, validate(value) -> {value} | {issues} } }
 * 同时保留 JSON Schema 形状（`type`/`properties`/`toJSON`），
 * 供管理界面投影出配置表单。两者一致，不会漂移。
 */

/** 默认值。schema 与这里必须一致（resolveConfig 不依赖 Loader 是否物化默认值）。 */
export const DEFAULTS = {
  maxBodyBytes: 65536,
  readTimeoutMs: 10000,
  audit: true,
  auditPath: "",
  // 【实测修正】按「请求」计费（不再是按条数）。批量 50 条 = 1 次请求。
  rateLimitPerMinute: 60,
  requireIdleSession: true,
  stopIdleAgent: false,
  matchAlternateIdSpelling: true,
  removeProjectionCache: true,
  clearRegistryRecords: true,
  confirmInUi: true,
  // 标题折叠实测约 65 ms/条（要读并解压整份会话日志），因此：
  //   - titleCacheTtlMs：同一会话在 TTL 内复用已折叠的标题，翻页/筛选/刷新即时返回；
  //   - titleFetchConcurrency：分片并发，把串行的 N×65 ms 压成 N/concurrency×65 ms；
  //   - titleLimit：每页最多为多少行取标题（0 = 完全不取，最快，界面显示 id）。
  //
  // 【性能自查】并发默认值 4 → 8。依据是**实测**（模拟 65 ms/条的组内串行，
  // 见 _bench 的取值过程）：默认首屏 50 行时
  //     c=1 → 3752 ms   c=2 → 1906 ms   c=4 → 970 ms
  //     c=8 → 540 ms    c=12 → 356 ms   c=16 → 295 ms
  // 4 → 8 是 **1.8×**（970 → 540 ms），而 8 → 16 只有 1.83×的边际收益却把
  // 瞬时并发观察数翻倍。8 是「明显更快 + 压力可控」的折中点。
  // 这是本插件**唯一**会造成可观 I/O 并发的参数，宿主吃紧时调回 4 甚至 1 即可。
  titleCacheTtlMs: 300000,
  titleFetchConcurrency: 8,
  titleLimit: 100,
  // 运行状态探测快照的 TTL。批量删除逐条调 deleteSession，每条原本都要问一次全量
  // 会话列表（实测 200 条 = 200 次 sessionController.list）。TTL 内复用同一份快照，
  // 把批量摊成 O(1) 次。0 = 每条都重新探测（最严格，但 200 条批量约慢 20 s）。
  runningProbeTtlMs: 1000,
  // 删除成功后是否 emit `api-session/removed`，让官方侧栏立刻移除那一行。
  //
  // 【这是「删了却还在未分组里」的真修法 · 2026-10-16】
  // 实测（全盘扫描 ~/.dsh）：删除后 sessions 目录 / projcache / storages 对
  // 该 id **全部零命中** —— 持久化数据已经清干净，缺的只是让客户端重新拉列表。
  // `api-session/removed` 是官方已声明的 Remote Event（`mode: 'emit'`），
  // Host 侧 `ctx.emit` 会自动中继到所有客户端；客户端 `handleSessionRemoved`
  // 收到后 `recordMutation({kind:"remove"})` —— 只有这一支才真正把行抹掉。
  // 想回到「不通知、靠用户自己刷新侧栏」的旧行为，把这里设成 false。
  announceRemoval: true,
};

/** 每个字段的类型/边界/默认/说明 —— 单一真源，schema 与 JSON Schema 都从它派生。 */
const FIELDS = {
  maxBodyBytes: {
    type: "integer",
    min: 1024,
    max: 4194304,
    default: DEFAULTS.maxBodyBytes,
    description: "请求体上限（字节）。上游写死 1 MiB；删除端点 64 KiB 足够。",
  },
  readTimeoutMs: {
    type: "integer",
    min: 1000,
    max: 120000,
    default: DEFAULTS.readTimeoutMs,
    description: "读取请求体的超时（毫秒）。上游没有超时，慢连接会把 handler 永久挂住。",
  },
  audit: { type: "boolean", default: DEFAULTS.audit, description: "是否记录审计（删除类操作应当留痕）。" },
  auditPath: {
    type: "string",
    default: DEFAULTS.auditPath,
    description: "审计文件路径；留空表示 <DSH_HOME>/logs/dialogue-cleanup.jsonl。",
  },
  rateLimitPerMinute: {
    type: "integer",
    min: 0,
    max: 600,
    default: DEFAULTS.rateLimitPerMinute,
    description: "每分钟最多接受多少次删除请求（按请求计费，批量算一次）。0 = 不限。",
  },
  requireIdleSession: {
    type: "boolean",
    default: DEFAULTS.requireIdleSession,
    description: "只允许删除「没有活动 agent」的会话（安全阀）。",
  },
  stopIdleAgent: {
    type: "boolean",
    default: DEFAULTS.stopIdleAgent,
    description: "尝试停止空闲 agent。当前运行时没有公开停止入口，故默认 false（如实拒绝）。",
  },
  matchAlternateIdSpelling: {
    type: "boolean",
    default: DEFAULTS.matchAlternateIdSpelling,
    description: "探测磁盘上另一种 id 拼写（仅当能确认不是别的会话时才删）。",
  },
  removeProjectionCache: {
    type: "boolean",
    default: DEFAULTS.removeProjectionCache,
    description: "一并删除派生的投影缓存。",
  },
  clearRegistryRecords: {
    type: "boolean",
    default: DEFAULTS.clearRegistryRecords,
    description: "清除工作区注册表里残留的 pin / archive 记录（幂等 no-op 不计入返回的 cleared 计数）。",
  },
  confirmInUi: {
    type: "boolean",
    default: DEFAULTS.confirmInUi,
    description: "UI 是否要求二次确认（Host 不信任它，仅作提示）。",
  },
  titleCacheTtlMs: {
    type: "integer",
    min: 0,
    max: 3600000,
    default: DEFAULTS.titleCacheTtlMs,
    description: "标题折叠结果的缓存时长（毫秒）；0 = 不缓存。折叠一条约 65 ms，缓存后翻页/筛选即时。",
  },
  titleFetchConcurrency: {
    type: "integer",
    min: 1,
    max: 16,
    default: DEFAULTS.titleFetchConcurrency,
    description: "取标题的分片并发数。分片越大，对宿主的瞬时压力越大。",
  },
  titleLimit: {
    type: "integer",
    min: 0,
    max: 200,
    default: DEFAULTS.titleLimit,
    description: "每页最多为多少行取标题；0 = 完全不取（列表最快，界面显示会话 id）。",
  },
  runningProbeTtlMs: {
    type: "integer",
    min: 0,
    max: 60000,
    default: DEFAULTS.runningProbeTtlMs,
    description:
      "「谁在跑」探测快照的复用时长（毫秒）。批量删除据此从 O(N) 次全量列表降为 O(1)；0 = 每条都重新探测（最严格，但 200 条批量约慢 20 s）。",
  },
  announceRemoval: {
    type: "boolean",
    default: DEFAULTS.announceRemoval,
    description:
      "删除成功后通知官方侧栏移除该行（emit 已声明的 Remote Event api-session/removed）。关掉后侧栏要等它自己刷新才消失。",
  },
};

/** 把原始输入收敛成合法配置。返回 { value, issues }。 */
function coerce(input) {
  const issues = [];
  const raw = input !== null && typeof input === "object" ? input : {};
  const value = {};

  if (input !== undefined && input !== null && typeof input !== "object") {
    issues.push({ message: "配置必须是一个对象", path: [] });
    return { value: { ...DEFAULTS }, issues };
  }

  for (const [key, spec] of Object.entries(FIELDS)) {
    const given = Object.prototype.hasOwnProperty.call(raw, key) ? raw[key] : undefined;

    if (given === undefined) {
      value[key] = spec.default;
      continue;
    }

    if (spec.type === "boolean") {
      // 严格化：只有真正的布尔被接受。字符串 "yes"/数字 1 是常见误配，明确报错而不是猜。
      if (typeof given !== "boolean") {
        issues.push({ message: `${key} 必须是布尔值`, path: [key] });
        value[key] = spec.default;
        continue;
      }
      value[key] = given;
      continue;
    }

    if (spec.type === "integer") {
      if (!Number.isInteger(given)) {
        issues.push({ message: `${key} 必须是整数`, path: [key] });
        value[key] = spec.default;
        continue;
      }
      if (spec.min !== undefined && given < spec.min) {
        issues.push({ message: `${key} 不能小于 ${spec.min}`, path: [key] });
        value[key] = spec.default;
        continue;
      }
      if (spec.max !== undefined && given > spec.max) {
        issues.push({ message: `${key} 不能大于 ${spec.max}`, path: [key] });
        value[key] = spec.default;
        continue;
      }
      value[key] = given;
      continue;
    }

    // string（auditPath）
    if (typeof given !== "string") {
      issues.push({ message: `${key} 必须是字符串`, path: [key] });
      value[key] = spec.default;
      continue;
    }
    value[key] = given;
  }

  // 未知字段：拒绝（additionalProperties: false 的语义），但也如实列出。
  for (const key of Object.keys(raw)) {
    if (!Object.prototype.hasOwnProperty.call(FIELDS, key)) {
      issues.push({ message: `未知配置项：${key}`, path: [key] });
    }
  }

  return { value, issues };
}

/** Standard Schema v1 的最小实现（Cordis 读的就是这个）。 */
function standardValidate(value) {
  const { value: coerced, issues } = coerce(value);
  if (issues.length > 0) return { issues };
  return { value: coerced };
}

const standard = {
  version: 1,
  vendor: "dsh-dialogue-cleanup",
  validate: standardValidate,
};

/** 派生 JSON Schema（管理界面用它渲染配置表单）。 */
export function toJsonSchema() {
  const properties = {};
  for (const [key, spec] of Object.entries(FIELDS)) {
    const prop = { description: spec.description };
    if (spec.type === "boolean") prop.type = "boolean";
    else if (spec.type === "string") prop.type = "string";
    else {
      prop.type = "integer";
      if (spec.min !== undefined) prop.minimum = spec.min;
      if (spec.max !== undefined) prop.maximum = spec.max;
    }
    prop.default = spec.default;
    properties[key] = prop;
  }
  return { type: "object", additionalProperties: false, properties };
}

/**
 * Config：按 schemastery 的**同一种形状**构造，避免宿主到底按哪种约定取用都不确定：
 *   1. 可调用            —— `Config(value)` 返回校验后的值（schemastery 的 Schema 就是函数）；
 *   2. `Config.validate` —— 直接可用的校验方法；
 *   3. `Config['~standard']` —— Standard Schema v1 接口（Cordis 实际读的那个）；
 *   4. JSON Schema 属性  —— `type`/`properties`/`toJSON()`，供界面投影配置表单。
 * 四者由同一份 FIELDS 派生，不会漂移。
 */
function makeConfig() {
  const callable = (value) => {
    const { value: coerced, issues } = coerce(value);
    if (issues.length > 0) {
      throw new Error(issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "));
    }
    return coerced;
  };
  Object.assign(callable, toJsonSchema());
  // schemastery schema contract: @deepseek-ai/dsh-settings reads
  // `schema.meta.volatile` unconditionally once a Config exposes `toJSON`.
  // Omitting `meta` made settings.describe() throw, which failed the
  // desktop welcome RPC and blocked the whole application from starting.
  // An empty bag means "no volatile fields", so the settings form skips
  // this plugin instead of crashing the host.
  callable.meta = {};
  callable.validate = standardValidate;
  callable["~standard"] = standard;
  callable.toJSON = toJsonSchema;
  callable.toJsonSchema = toJsonSchema;
  return callable;
}

export const Config = makeConfig();

/**
 * 把 Loader 传来的 config 收敛成内部配置。
 * 即使 Cordis 已经把 validate 的产物传进来，这里再跑一次也是幂等的（纯函数）。
 */
export function resolveConfig(config) {
  const { value } = coerce(config);
  // 空字符串在 schema 里表示「用默认路径」；统一收敛成 null 供下游判断。
  if (value.auditPath === "") value.auditPath = null;
  return value;
}

