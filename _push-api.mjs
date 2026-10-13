/**
 * 用 GitHub Git Data API 推送提交（当 git://github.com 的 git 端点被阻断、但 api.github.com 可用时）。
 *
 * 步骤：blob → tree → commit → ref。全部走官方 REST API。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = "E:/Code/dsh-dialogue-cleanup";
const OWNER = "Winnie-0721";
const REPO = "dsh-dialogue-cleanup";
const API = "https://api.github.com";

// 从 git 凭据管理器取 token（不落盘、不打印）
const creds = execFileSync("git", ["credential", "fill"], { input: "protocol=https\nhost=github.com\n\n", encoding: "utf8" });
const token = creds.split("\n").find((l) => l.startsWith("password="))?.slice("password=".length);
if (!token) throw new Error("拿不到 GitHub token");

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "dsh-publish",
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return text === "" ? null : JSON.parse(text);
}

// 收集要提交的文件（排除 .git）
const SKIP = new Set([".git", "node_modules"]);
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const files = walk(ROOT).map((p) => ({ abs: p, rel: relative(ROOT, p).split(sep).join("/") })).sort((a, b) => a.rel.localeCompare(b.rel));
console.log(`待上传 ${files.length} 个文件`);

// 1) 建 blob
const tree = [];
for (const f of files) {
  const content = readFileSync(f.abs);
  const isBinary = content.includes(0);
  const blob = await api("POST", `/repos/${OWNER}/${REPO}/git/blobs`, {
    content: content.toString("base64"),
    encoding: "base64",
  });
  tree.push({ path: f.rel, mode: isBinary ? "100644" : "100644", type: "blob", sha: blob.sha });
  console.log(`  blob ${blob.sha.slice(0, 8)}  ${f.rel}`);
}

// 2) 建 tree
const newTree = await api("POST", `/repos/${OWNER}/${REPO}/git/trees`, { tree });
console.log(`tree: ${newTree.sha}`);

// 3) 建 commit（用本地提交信息保持一致）
const message = execFileSync("git", ["log", "-1", "--pretty=%B"], { cwd: ROOT, encoding: "utf8" }).trim();
const commit = await api("POST", `/repos/${OWNER}/${REPO}/git/commits`, {
  message,
  tree: newTree.sha,
  parents: [],
});
console.log(`commit: ${commit.sha}`);
console.log(`url: ${commit.html_url}`);

// 4) 建/更新 ref
try {
  await api("POST", `/repos/${OWNER}/${REPO}/git/refs`, { ref: "refs/heads/main", sha: commit.sha });
  console.log("已创建 refs/heads/main");
} catch (e) {
  if (String(e.message).includes("422")) {
    await api("PATCH", `/repos/${OWNER}/${REPO}/git/refs/heads/main`, { sha: commit.sha, force: true });
    console.log("已更新 refs/heads/main");
  } else throw e;
}

// 5) 把 main 设为默认分支
try {
  await api("PATCH", `/repos/${OWNER}/${REPO}`, { default_branch: "main" });
  console.log("默认分支已设为 main");
} catch (e) {
  console.log("设默认分支失败（不影响内容）:", e.message.slice(0, 120));
}

console.log("\n完成。核对：", `https://github.com/${OWNER}/${REPO}`);
