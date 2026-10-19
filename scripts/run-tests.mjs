#!/usr/bin/env node
// 跨版本、跨平台的测试运行器。
//
// 【为什么需要它 —— 远端 CI 实测抓到的两个真问题】
//
// 1. Node 20 的 `node --test` 不支持 glob。
//    package.json 原本写 `node --test "test/**/*.test.mjs"`。引号只让 shell 把
//    这串原样传给 node，但 node 自己也不展开它 —— 在 Node 20 上直接报：
//      Could not find '/home/runner/work/.../test/**/*.test.mjs'
//    glob 支持是 Node 22+ 才加的。而 engines.node 声明的是 >=20.0.0，
//    所以「声明的运行方式」在最低支持版本上根本跑不起来。
//    远端 CI 当场抓到：node 22 绿、node 20 两个平台都红。
//
// 2. shell 展开不可靠（Windows cmd 不展开、bash 会展开但受 noglob 等影响）。
//
// 结论：由 Node 自己枚举文件再交给 `node --test`，三个版本、两个平台行为一致。
// 这也让「断言测试条数」有意义 —— 枚举为空时立即失败，而不是「跑了 0 条还退出 0」。
//
// 用法：
//   node scripts/run-tests.mjs                    # 跑全部 test/*.test.mjs
//   node scripts/run-tests.mjs --test-reporter=tap  # 透传 reporter（CI 用）
//   node scripts/run-tests.mjs --list             # 只列出将要运行的文件
//
// 注意旗标名是 `--test-reporter`（node 的），不是 `--reporter`（那是 npm 的）。
import { readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const testDir = join(root, "test");

const args = process.argv.slice(2);
const listOnly = args.includes("--list");
const passthrough = args.filter((a) => a !== "--list");

/** 枚举测试文件（排序，保证跨平台顺序一致）。 */
function discover() {
  return readdirSync(testDir)
    .filter((name) => name.endsWith(".test.mjs"))
    .sort()
    .map((name) => join("test", name));
}

const files = discover();
if (files.length === 0) {
  console.error("test/ 下没有任何 *.test.mjs —— 拒绝「跑了 0 条还成功」");
  process.exit(1);
}

if (listOnly) {
  console.log(`发现 ${files.length} 个测试文件：`);
  for (const f of files) console.log(`  ${f}`);
  process.exit(0);
}

// 把 reporter 等旗标放在 --test **之前**：
// 实测 `node --test <files> --test-reporter=tap` 会让旗标被静默忽略
// （它落在文件实参之后），输出仍是 spec 格式，CI 的 `grep '^# tests'` 就匹配不到。
const child = spawn(process.execPath, ["--test", ...passthrough, ...files], {
  stdio: "inherit",
  cwd: root,
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`测试进程被信号终止: ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
child.on("error", (error) => {
  console.error(`无法启动测试进程: ${String(error?.message ?? error)}`);
  process.exit(1);
});
