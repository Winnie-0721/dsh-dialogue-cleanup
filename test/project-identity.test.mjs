/**
 * 项目身份字段统一（TASK-POST-1.1.2 · 任务一）
 *
 * 【这一组用例锁的是什么】
 * `/list` 响应里有三处涉及「项目」：
 *   1. `value.projects` —— 界面筛选下拉框的选项集合；
 *   2. `value.items[].project` —— 每一行显示的项目路径；
 *   3. 请求参数 `request.project` —— 下拉框回传的值。
 * 三者必须是**同一个字段的同一个值**，否则会出现「下拉框里没有这个路径，但列表里
 * 每一行都显示着它」「选中某个项目反而 0 条」这类只能靠用户肉眼发现的不一致。
 *
 * 修复前的实现（缺陷）：
 *   · 筛选 `items.filter((row) => row.cwd === wantProject)`（用 `row.cwd`）
 *   · 选项 `projectSet.add(row.cwd)`（用 `row.cwd`）
 *   · 显示 `project: ws?.path ?? row.cwd ?? null`（**优先用 workspace 的路径**）
 * 于是只要 `session.cwd !== workspace.path`（用户在别的目录里打开过这个工作区、
 * 工作区被移动/改名过），显示值与选项值就不是同一个字符串。
 *
 * 【本组用例断言的是「修复后应有的行为」】，因此未修复时应看到失败 —— 先复现，再修。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createService } from "../lib/service.js";
import { resolveConfig } from "../lib/config.js";

/**
 * 造一个只含 `/list` 所需服务的宿主替身。
 *
 * `records` 形状照真实 `sessionQuery.listSessions()`：`{ header, live, persisted }`。
 * `workspaces` 形状照真实 `workspaceRegistry.list()`：`{ id, title, path, sessionIds }`。
 * 其余服务故意不给 —— 用来验证「可选信息缺失时不得丢行」。
 */
function makeHost({ records = [], workspaces = [], summaries = [], withRegistry = true } = {}) {
  const services = {
    sessionQuery: {
      listSessions: async () => records,
      // 真实形状：SessionTitleObservation { sessionId, status, value: { title } }
      readTitleSnapshots: async (ids) =>
        ids.map((id) => ({ sessionId: id, status: "fulfilled", value: { title: undefined } })),
    },
    sessionController: { list: async () => ({ items: summaries }) },
  };
  if (withRegistry) {
    services.workspaceRegistry = { list: () => workspaces };
  }
  const ctx = { logger: { warn() {}, debug() {}, info() {} }, get: (k) => services[k] };
  const audit = { record: async () => ({ ok: true, path: null }), enabled: false, path: null };
  return createService(ctx, resolveConfig({ audit: false }), audit);
}

/** 一行会话（只写本组用例关心的字段）。 */
function row(id, cwd, createdAt, extra = {}) {
  return {
    header: {
      id,
      createdAt,
      ...(cwd === undefined ? {} : { cwd }),
      ...extra,
    },
    live: false,
    persisted: true,
  };
}

// ───────────────────────── ① 一致情况（回归保护） ─────────────────────────

test("项目身份：cwd 与 workspace.path 一致时，选项 / 筛选值 / item.project 完全相同", async () => {
  const service = makeHost({
    records: [row("s1", "E:\\proj-A", 1000)],
    workspaces: [{ id: "w1", title: "项目 A", path: "E:\\proj-A", sessionIds: ["s1"] }],
  });

  const unfiltered = await service.listSessions();
  assert.deepEqual(unfiltered.value.projects, ["E:\\proj-A"]);
  assert.equal(unfiltered.value.items[0].project, "E:\\proj-A");
  assert.equal(unfiltered.value.items[0].workspaceTitle, "项目 A");

  const filtered = await service.listSessions({ project: "E:\\proj-A" });
  assert.equal(filtered.value.total, 1);
  assert.equal(filtered.value.items[0].sessionId, "s1");
});

// ───────────────────────── ② 缺陷复现：cwd ≠ workspace.path ─────────────────────────

test("项目身份：cwd 与 workspace.path 不一致时，item.project 必须是下拉框里能选到的那个值", async () => {
  // 真实成因：会话是在另一个目录里创建的（或工作区被移动/改名），
  // 于是 header.cwd 与 workspaceRegistry 记录的工作区路径不同。
  const service = makeHost({
    records: [row("s1", "E:\\code\\actual-cwd", 1000)],
    workspaces: [
      { id: "w1", title: "项目 A", path: "E:\\Code\\renamed-workspace", sessionIds: ["s1"] },
    ],
  });

  const result = await service.listSessions();
  const item = result.value.items[0];

  // 下拉框的选项来自 cwd（既有语义），所以它是 actual-cwd。
  assert.deepEqual(result.value.projects, ["E:\\code\\actual-cwd"]);
  // 那么这一行显示的项目路径也必须是 actual-cwd —— 否则界面上显示的路径
  // 在下拉框里根本不存在，用户永远选不中它。
  assert.equal(
    item.project,
    "E:\\code\\actual-cwd",
    "item.project 必须与 value.projects 里的值同源（否则界面显示与筛选选项不一致）",
  );
  // 反向检查：按界面上显示的值去筛，必须能筛出这一行。
  const byDisplayed = await service.listSessions({ project: item.project });
  assert.equal(byDisplayed.value.total, 1);
  assert.equal(byDisplayed.value.items[0].sessionId, "s1");
  // 而按 workspace 路径去筛是 0 条（它不是项目身份字段，只是工作区属性）。
  const byWorkspacePath = await service.listSessions({ project: "E:\\Code\\renamed-workspace" });
  assert.equal(byWorkspacePath.value.total, 0);
});

test("项目身份：每一行的 item.project（非 null 时）都必须出现在 value.projects 里", async () => {
  const service = makeHost({
    records: [
      row("s1", "E:\\a", 1000),
      row("s2", "E:\\b", 2000),
      row("s3", undefined, 3000), // cwd 缺失
    ],
    workspaces: [
      { id: "w1", title: "A", path: "E:\\ws-a-different", sessionIds: ["s1"] },
      { id: "w2", title: "B", path: "E:\\b", sessionIds: ["s2"] },
      { id: "w3", title: "只有工作区路径", path: "E:\\only-ws", sessionIds: ["s3"] },
    ],
  });

  const result = await service.listSessions();
  const options = new Set(result.value.projects);
  for (const item of result.value.items) {
    if (item.project === null) continue;
    assert.ok(
      options.has(item.project),
      `会话 ${item.sessionId} 显示的项目路径 "${item.project}" 不在下拉框选项里（选项：${JSON.stringify(result.value.projects)}）`,
    );
  }
  // 反过来：下拉框里的每个选项，按它筛选都必须至少能筛出一行。
  for (const project of result.value.projects) {
    const byProject = await service.listSessions({ project });
    assert.ok(
      byProject.value.total >= 1,
      `下拉框选项 "${project}" 筛出 0 条 —— 选项与结果不一致`,
    );
  }
});

// ───────────────────────── ③ 缺失与空值 ─────────────────────────

test("项目身份：cwd 缺失时用 workspace.path 兜底，并且该值必须能被选到", async () => {
  const service = makeHost({
    records: [row("s1", undefined, 1000)],
    workspaces: [{ id: "w1", title: "项目", path: "E:\\ws-only", sessionIds: ["s1"] }],
  });

  const result = await service.listSessions();
  assert.equal(result.value.items[0].project, "E:\\ws-only");
  assert.deepEqual(result.value.projects, ["E:\\ws-only"]);
  const byProject = await service.listSessions({ project: "E:\\ws-only" });
  assert.equal(byProject.value.total, 1);
});

test("项目身份：cwd 与 workspace 都缺失时 project 为 null，且行不得被静默丢弃", async () => {
  const service = makeHost({ records: [row("s1", undefined, 1000)], workspaces: [] });

  const result = await service.listSessions();
  assert.equal(result.value.total, 1, "缺少项目信息不等于该行不该出现");
  assert.equal(result.value.items[0].sessionId, "s1");
  assert.equal(result.value.items[0].project, null);
  assert.deepEqual(result.value.projects, []);
  // 空值永远是 null，不能变成字符串 "null"/"undefined" 之类伪造的项目名。
  assert.equal(result.value.items[0].workspaceTitle, null);
});

test("项目身份：cwd 是空字符串时按「缺失」处理，不得当成一个项目", async () => {
  const service = makeHost({
    records: [row("s1", "", 1000)],
    workspaces: [{ id: "w1", title: "项目", path: "E:\\ws2", sessionIds: ["s1"] }],
  });

  const result = await service.listSessions();
  assert.equal(result.value.items[0].project, "E:\\ws2", "空字符串要回退到 workspace.path");
  assert.deepEqual(result.value.projects, ["E:\\ws2"]);
  // `request.project: ""` 既有语义是「不筛选」，必须保持不变。
  const all = await service.listSessions({ project: "" });
  assert.equal(all.value.total, 1);
  // 空白字符串同样不得成为项目身份。
  const blank = await makeHost({
    records: [row("s2", "   ", 1000)],
    workspaces: [],
  }).listSessions();
  assert.equal(blank.value.items[0].project, null);
  assert.deepEqual(blank.value.projects, []);
});

test("项目身份：完全没有 workspaceRegistry 时，行不丢、project 退回 cwd", async () => {
  const service = makeHost({
    records: [row("s1", "E:\\solo", 1000)],
    withRegistry: false,
  });

  const result = await service.listSessions();
  assert.equal(result.value.total, 1);
  assert.equal(result.value.items[0].project, "E:\\solo");
  assert.equal(result.value.items[0].workspaceTitle, null);
  assert.deepEqual(result.value.projects, ["E:\\solo"]);
  const byProject = await service.listSessions({ project: "E:\\solo" });
  assert.equal(byProject.value.total, 1);
});

// ───────────────────────── ④ 一个会话属于多个 workspace ─────────────────────────

test("项目身份：同一会话出现在多个 workspace 时，项目身份不受影响且 workspaceTitle 取值确定", async () => {
  const workspaces = [
    { id: "w1", title: "工作区一", path: "E:\\w1", sessionIds: ["s1"] },
    { id: "w2", title: "工作区二", path: "E:\\w2", sessionIds: ["s1"] },
  ];
  const service = makeHost({ records: [row("s1", "E:\\the-cwd", 1000)], workspaces });

  const first = await service.listSessions();
  const item = first.value.items[0];

  // 项目身份只看会话自身的 cwd —— workspace 归属有几个都不影响。
  assert.equal(item.project, "E:\\the-cwd");
  assert.deepEqual(first.value.projects, ["E:\\the-cwd"]);
  // workspaceTitle 只用于显示，多归属时必须有确定规则（首个声明者胜），
  // 不能随 registry 返回顺序漂移成另一种结果。
  assert.equal(item.workspaceTitle, "工作区一");

  const second = await service.listSessions();
  assert.equal(second.value.items[0].workspaceTitle, "工作区一", "重复调用结果必须一致");
});

test("项目身份：registry 顺序变化不得改变项目的可筛选性", async () => {
  const records = [row("s1", "E:\\the-cwd", 1000)];
  const a = makeHost({
    records,
    workspaces: [
      { id: "w1", title: "一", path: "E:\\w1", sessionIds: ["s1"] },
      { id: "w2", title: "二", path: "E:\\w2", sessionIds: ["s1"] },
    ],
  });
  const b = makeHost({
    records,
    workspaces: [
      { id: "w2", title: "二", path: "E:\\w2", sessionIds: ["s1"] },
      { id: "w1", title: "一", path: "E:\\w1", sessionIds: ["s1"] },
    ],
  });

  const ra = await a.listSessions();
  const rb = await b.listSessions();
  assert.equal(ra.value.items[0].project, rb.value.items[0].project);
  assert.deepEqual(ra.value.projects, rb.value.projects);
});

// ───────────────────────── ⑤ Windows 大小写与分隔符 ─────────────────────────

test("projectKey：Windows 下大小写与正/反斜杠都归一到同一个键", async () => {
  const { projectKey } = await import("../lib/service.js");
  assert.equal(typeof projectKey, "function", "lib/service.js 必须导出 projectKey");

  // 显式钉死 win32：这组断言说的是 Windows 的规则，不能让用例在 Linux CI 上
  // 按 POSIX 规则跑 —— 那正是「Windows 绿、Linux 红」的来源。
  const win32 = (value) => projectKey(value, "win32");
  assert.equal(win32("E:\\Code\\Proj"), win32("e:/code/proj"));
  assert.equal(win32("E:\\Code\\Proj\\"), win32("E:\\Code\\Proj"));
  // 尾部反斜杠 + 大小写 + 分隔符混合
  assert.equal(win32("E:\\Code\\Proj\\"), win32("e:/CODE/proj"));
  assert.notEqual(win32("E:\\Code\\Proj"), win32("E:\\Code\\Other"));
});

test("projectKey：非 Windows 下大小写敏感（不同目录就是不同项目）", async () => {
  const { projectKey } = await import("../lib/service.js");
  // 显式传平台，避免用例在不同开发机上表现不同。
  assert.notEqual(projectKey("/home/u/Proj", "linux"), projectKey("/home/u/proj", "linux"));
  // 但尾部斜杠在任何平台都不是身份的一部分
  assert.equal(projectKey("/home/u/Proj/", "linux"), projectKey("/home/u/Proj", "linux"));
  // 反斜杠在 POSIX 上是合法文件名字符，不得被当分隔符折叠
  assert.notEqual(projectKey("/home/u/a\\b", "linux"), projectKey("/home/u/a/b", "linux"));
  assert.equal(projectKey("/home/u/a\\b", "win32"), projectKey("/home/u/a/b", "win32"));
});

test("projectKey：空值与非字符串一律 null（不能造出伪项目）", async () => {
  const { projectKey } = await import("../lib/service.js");
  for (const value of [null, undefined, "", "   ", 0, 123, {}, [], true]) {
    assert.equal(projectKey(value), null, `projectKey(${JSON.stringify(value)}) 必须为 null`);
  }
  assert.equal(projectKey("/"), "/");
  // Windows 盘符根：`C:\` 与 `c:/` 在 Windows 上是同一个位置，必须归一到同一个键。
  // 同样显式钉死 win32，避免用例在 Linux CI 上按 POSIX 规则跑。
  assert.equal(projectKey("C:\\", "win32"), projectKey("c:/", "win32"));
});

test("项目身份：Windows 下大小写/分隔符不同也能筛出同一批会话；POSIX 下严格区分", async () => {
  const records = [row("s1", "E:\\Proj\\A", 1000), row("s2", "E:\\proj\\a", 2000)];
  const service = makeHost({ records, workspaces: [] });

  const options = await service.listSessions();
  // 两个写法在 Windows 上是同一个项目 → 选项必须合并成一个，避免下拉框出现
  // 两个看起来一样、点哪条都只筛出一半的选项。
  if (process.platform === "win32") {
    assert.equal(options.value.projects.length, 1, `Windows 下不得出现重复项目选项：${JSON.stringify(options.value.projects)}`);
    const filtered = await service.listSessions({ project: options.value.projects[0] });
    assert.equal(filtered.value.total, 2, "大小写/分隔符不同不得漏行");
    assert.equal(new Set(filtered.value.items.map((r) => r.project)).size, 1);
  } else {
    assert.equal(options.value.projects.length, 2, "POSIX 下大小写不同是不同项目");
  }
});

// ───────────────────────── ⑥ 与其它筛选、分页的组合 ─────────────────────────

test("项目身份：与关键词 / running / kind / archived / 排序 / 分页组合后仍然自洽", async () => {
  const records = [
    row("s1", "E:\\a", 1000),
    row("s2", "E:\\a", 2000, { origin: "subagent", delegationDepth: 1, parentSession: "s1" }),
    row("s3", "E:\\b", 3000),
  ];
  const summaries = [
    { sessionId: "s1", running: true, blank: false, updatedAt: 9000 },
    { sessionId: "s2", running: false, blank: false, updatedAt: 8000 },
    { sessionId: "s3", running: false, blank: false, updatedAt: 7000 },
  ];
  const service = makeHost({ records, workspaces: [], summaries });

  // 默认 kind=main → 子代理行不出现，但项目选项仍然来自全库（既有语义不变）
  const def = await service.listSessions();
  assert.deepEqual(def.value.items.map((r) => r.sessionId).sort(), ["s1", "s3"]);
  assert.deepEqual(def.value.projects, ["E:\\a", "E:\\b"]);

  // kind=all 后项目选项不变（选项集合不受其它筛选影响 —— 避免下拉框抖动）
  const all = await service.listSessions({ kind: "all" });
  assert.deepEqual(all.value.projects, def.value.projects);

  // 项目 + running 组合
  const projectRunning = await service.listSessions({ project: "E:\\a", running: true });
  assert.deepEqual(projectRunning.value.items.map((r) => r.sessionId), ["s1"]);
  assert.deepEqual(projectRunning.value.projects, def.value.projects);

  // 项目 + kind 组合
  const projectSubagent = await service.listSessions({ project: "E:\\a", kind: "subagent" });
  assert.deepEqual(projectSubagent.value.items.map((r) => r.sessionId), ["s2"]);

  // 项目 + 分页：页内每行的 project 都必须等于筛选值
  const paged = await service.listSessions({ project: "E:\\a", kind: "all", pageSize: 1 });
  assert.equal(paged.value.total, 2);
  assert.equal(paged.value.page.pages, 2);
  for (const pageIndex of [1, 2]) {
    const pageResult = await service.listSessions({
      project: "E:\\a",
      kind: "all",
      page: pageIndex,
      pageSize: 1,
    });
    for (const item of pageResult.value.items) {
      assert.equal(item.project, "E:\\a");
    }
  }

  // 项目 + 关键词（关键词命中的行也必须带同一项目身份）
  const byQuery = await service.listSessions({ project: "E:\\a", query: "s2", kind: "all" });
  assert.deepEqual(byQuery.value.items.map((r) => r.sessionId), ["s2"]);
  assert.equal(byQuery.value.items[0].project, "E:\\a");
});

test("项目身份：筛项目不影响全库计数与可删除判定", async () => {
  const records = [row("s1", "E:\\a", 1000), row("s2", "E:\\b", 2000)];
  const summaries = [
    { sessionId: "s1", running: true, blank: false, updatedAt: 9000 },
    { sessionId: "s2", running: false, blank: false, updatedAt: 8000 },
  ];
  const service = makeHost({ records, workspaces: [], summaries });

  const filtered = await service.listSessions({ project: "E:\\a" });
  // 计数仍是全库口径（既有契约：archived/kind 计数不受筛选影响）
  assert.equal(filtered.value.kind.mainTotal, 2);
  assert.equal(filtered.value.archived.total, 0);
  const item = filtered.value.items[0];
  assert.equal(item.running, true);
  assert.equal(item.deletable, false);
  assert.match(item.blockedReason, /正在运行/);
});
