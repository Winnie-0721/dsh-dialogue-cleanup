/**
 * 真实 DSH 集成检查（**只读**）—— 不属于 `*.test.mjs` 套件，因为它需要一个**活的**宿主。
 *
 * 【为什么只读】这台机器上的 DSH 存的是用户**真实会话**。删除不可逆，
 * 拿真实数据做破坏性集成测试等于拿用户数据当耗材 —— 所以本脚本只调用
 * 只读端点（`/status`、`/list`），验证「插件在真实宿主里能跑通、契约字段齐备」。
 *
 * 破坏性路径（删除、部分成功、并发、越界）由 `test/fault-injection.test.mjs`
 * 在**隔离的临时 DSH_HOME** 上覆盖 —— 那是**模拟测试**，不是真实 DSH 集成测试。
 * 两者结果在整改报告中分别陈述，不混为一谈。
 *
 * 用法：
 *   node test/integration-real.mjs                       # 默认 http://127.0.0.1:4294
 *   node test/integration-real.mjs http://127.0.0.1:19387
 *
 * 退出码：0 = 全部通过（或有说明的 INFO）；1 = 有 FAIL。
 */
const baseUrl = process.argv[2] ?? "http://127.0.0.1:4294";
const API = `${baseUrl}/api-ext/dialogue-cleanup`;

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " :: " + detail : ""}`);
}

async function get(path) {
  const r = await fetch(`${API}${path}`);
  return { status: r.status, body: await r.json().catch(() => null) };
}

// 1. /status 可达且信封形状正确
{
  const { status, body } = await get("/status");
  const v = body?.value;
  record(
    "/status 可达且信封正确",
    status === 200 && body?.ok === true && typeof v?.plugin?.version === "string",
    `status=${status} version=${v?.plugin?.version}`,
  );
  record(
    "/status 暴露 capabilities（能力检测入口）",
    typeof v?.capabilities === "object" && typeof v.capabilities.listSessions === "boolean",
    `runningProbe=${v?.capabilities?.runningProbe} publicStopIdleAgent=${v?.capabilities?.publicStopIdleAgent}`,
  );
  record(
    "capabilities 如实报告「没有公开的停止入口」",
    v?.capabilities?.publicStopIdleAgent === false,
    "publicStopIdleAgent=false（不吹牛，与 stopIdleAgent 的保守降级一致）",
  );
}

// 2. /list 契约字段
{
  const { status, body } = await get("/list?pageSize=3");
  const v = body?.value;
  record("/list 可达", status === 200 && body?.ok === true, `status=${status}`);
  record(
    "/list 返回契约字段（total/page/items/projects/sources/archived/kind/titles）",
    typeof v?.total === "number" &&
      typeof v?.page?.page === "number" &&
      Array.isArray(v?.items) &&
      Array.isArray(v?.projects) &&
      typeof v?.sources === "object" &&
      typeof v?.archived === "object" &&
      typeof v?.kind === "object" &&
      typeof v?.titles === "object",
    `total=${v?.total} items=${v?.items?.length}`,
  );
  const row = v?.items?.[0];
  record(
    "行内字段齐备（deletable/blockedReason 由 Host 判定，UI 不猜）",
    row === undefined ||
      (typeof row.deletable === "boolean" && "blockedReason" in row && typeof row.sessionId === "string"),
    row ? `deletable=${row.deletable} running=${row.running}` : "（无会话可检）",
  );
  record(
    "titles 成本明细如实回传",
    typeof v?.titles?.requested === "number" && typeof v?.titles?.cached === "number",
    `requested=${v?.titles?.requested} cached=${v?.titles?.cached} fetched=${v?.titles?.fetched}`,
  );
}

// 3. 本轮新增字段（宿主未重载时应当缺失 —— 如实记录，不假装通过）
{
  const { body } = await get("/status");
  const cfg = body?.value?.config ?? {};
  console.log(
    `INFO  运行中的版本是否已含本轮新增配置 titleSearchLimit: ${
      "titleSearchLimit" in cfg ? "是" : "否（宿主仍加载旧代码，需重启 DSH 才生效）"
    }`,
  );
}

console.log("\n=== 真实 DSH 集成检查汇总（只读）===");
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} 通过`);
for (const f of failed) console.log(`  FAIL ${f.name} :: ${f.detail}`);
console.log("\n注意：本检查**只读**，未对真实会话执行任何删除。");
console.log("破坏性路径的集成覆盖见 test/fault-injection.test.mjs（隔离临时 DSH_HOME，属模拟测试）。");

process.exit(failed.length === 0 ? 0 : 1);
