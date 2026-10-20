# 发布与版本号规则

本仓库的发布流程**复刻自 [dsh-plugin-market](https://github.com/Winnie-0721/dsh-plugin-market)**，
并按本仓库的结构逐项适配。共用同一套版本号规则与同一条 CI 链路。

## 1. 版本号规则

| 名称 | 形式 | 在哪里用 |
|---|---|---|
| `versionName` | `MAJOR.MINOR.PATCH`（严格 SemVer，不带 `v` 前缀） | `package.json` 的 `version`、Git 标签 `v<versionName>`、GitHub Release 标题 |
| `versionCode` | `MAJOR*10000 + MINOR*100 + PATCH`（单调递增整数） | `dist/version.json`、需要纯数字版本的宿主/渠道 |
| 构建标识 | `+<提交数>.<短哈希>` | 只写进发布说明与 `dist/version.json`，**不进入** `versionName` |

**递增规则**（从用户视角判定，而不是从代码量）：

- `MAJOR`：破坏兼容——改了对外契约（端点、字段、错误码）；
- `MINOR`：向后兼容的新功能；
- `PATCH`：向后兼容的修复，包括安全修复与性能修复；
- **高位递增时低位归零**：`-Bump minor` 把 `MINOR` 加一并把 `PATCH` 归零；
  `-Bump major` 把 `MAJOR` 加一并把 `MINOR`、`PATCH` 都归零。
  这条**会静默错**，所以门禁每次都跑一张判例表（含 `1.0.2 +minor → 1.1.0`、
  `1.9.9 +minor → 1.10.0`）加一条负向对照（把归零去掉必须被判失败）。
- `versionCode` 隐含边界：公式要求 `MINOR` 与 `PATCH` **都小于 100**，
  否则 `1.0.100` 与 `1.1.0` 会撞成同一个 `10100`。脚本越界时直接拒绝。
- 已经发布过的版本号**永不重用、永不覆盖**（npm 也不允许覆盖），出错就往上加 PATCH。

**升哪一位可以自动识别**（`release.ps1 -Bump auto`）：
**证据** = 自上个 `v<版本>` 标签以来触及发布面的提交类型前缀（`feat`→MINOR、
`fix`/`修复`/`perf`→PATCH、`feat!`/`BREAKING`/「不兼容」→MAJOR、`chore`/`docs`/`ci`/`test`→不升档）；
**声明** = CHANGELOG 顶部还没打标签的 `## x.y.z` 节（或 `-Version x.y.z`）。
两边**双向都硬拦**；显式 `-Bump patch|minor|major` 是人工覆盖路径（只警告、不拦）。

## 2. 一次发布做什么

**本地只做版本与门禁，打包与发布全在 GitHub Actions。**
本地不产生任何打包产物（`dist/` 始终空着），也不消耗 gh / npm token。

本地段（`scripts/release.ps1`）：

1. **读**：解析 `package.json` 的 `version` 并校验 SemVer 形状；
2. **门禁**（全绿才继续）：
   - 版本算术自检（判例表 + 撞号负向对照）；
   - 档位判定自检（提交主题判档表 + 「认不出的类型不虚报」）；
   - `node --check` 过 `lib/*.js` 与根上的 `client.js`；
   - `dsh.bundle.patch` / `dsh.client.platform` / `exports["./client"]` 齐全；
   - `cordis.patch.yml` 存在且行 `name` 与包名一致（**加不加引号都认**）；
   - 客户端 bundle 含 `__ModuleLoader__.load` 且 `id` 等于包名，且不含 `eval` / `new Function`；
   - `lib/` 与 `client.js` 的非注释行里**不存在写死的旧版本号**；
   - `test/*.test.mjs` **全部**通过（自动发现，不是写死清单）；
   - **发布面干净**（`docs/`、`.github/`、`dist/` 之外的改动都会阻塞）。
3. **递增**：写入新的 `version`；
4. **提交**：`git commit`（内容只有 `package.json`）+ `git tag -a v<version>`；
5. **推送**：`git push --follow-tags`。标签推上去，Actions「Pack and Release」接手。

CI 段（`.github/workflows/pack-release.yml`，`push: tags: ['v*']` 触发）：

1. 检出标签，跑 `release.ps1 -CiPack`：**再过一遍同样的门禁**，打包内容以标签为准；
2. `pnpm pack` → `dist/dsh-dialogue-cleanup-<version>.tgz` + `dist/version.json`；
3. `gh release create v<version> dist/*.tgz dist/version.json`：**Release 附件是回退与旧版安装的
   唯一下载源**；Release 已存在时改走 `gh release upload --clobber`（重跑幂等）；
   Release 正文取 CHANGELOG 的同名节，读文件一律显式 `-Encoding UTF8`；
4. **npm 发布由 `publish-npm.yml` 自己并列触发**（同样监听 `push: tags: ['v*']`），
   本文件**不调用**它。原因见 §5.1 —— 用 `workflow_call` 复用会让 npm 校验到调用方文件名。

## 3. 用法

```powershell
# 门禁 → 递增 → 提交 → 打标签 → 推送（推送后由 Actions 打包、建 Release、发 npm）
pwsh -File scripts\release.ps1 -Bump patch      # 修复
pwsh -File scripts\release.ps1 -Bump minor      # 新功能
pwsh -File scripts\release.ps1 -Bump auto       # 自动识别升档（推荐）

# 只跑门禁：不改版本、不打包、不提交、不发布（本地验证的唯一正确姿势）
pwsh -File scripts\release.ps1 -LocalOnly

# 递增 + 提交 + 打标签，但不推送（想先看一眼再推）
pwsh -File scripts\release.ps1 -Bump patch -SkipPush
```

> `-CiPack` 只在 GitHub Actions 里跑（脚本会检查 `GITHUB_ACTIONS`），本地用 `-LocalOnly`。

## 4. 与参考仓库 dsh-plugin-market 的**适配点**

复刻不是照抄。以下每一条都是两仓库真实的结构差异，改错会在 CI 里才暴露：

| 项 | dsh-plugin-market | 本仓库 |
|---|---|---|
| 包的位置 | `plugin-market/` 子目录 | **仓库根** |
| 客户端 bundle | `lib/client.js` | **`client.js`**（根） |
| `exports["./client"]` | `./lib/client.js` | `./client.js` |
| 回归测试 | `verify/*.test.mjs` | **`test/*.test.mjs`** |
| 发布面判定 | `plugin-market/`、`docs/`、`scripts/` | 除 `docs/`、`.github/`、`dist/` 外都算 |
| npm 发布 job | 需 `working-directory: plugin-market` | **不能设**（会 ENOENT） |
| 版本号读取 | `PLUGIN_VERSION` 常量 | `lib/index.js` 的 `version`（同样从清单读） |

**版本必须从包清单读，不能写死。** 复刻时 `lib/index.js` 里原本写着
`export const version = "1.0.0"` —— 那会在第一次 `-Bump patch` 时被门禁当场拦下
（「lib/ 的非注释行里仍写着旧版本号」），而且会让 `/status` 与面板**永久**显示 1.0.0。
现在改成 `createRequire(import.meta.url)("../package.json").version`。

## 5. 发布到 npm（Trusted Publishing / OIDC）

⚠️ **首次发布前必须先在 npmjs.com 配置 Trusted Publisher**，否则 CI 的发布步骤会失败。
新包在**首次发布前**还没有包设置页，需要用 npm 的 **pending publisher** 先登记：

- repository：`Winnie-0721/dsh-dialogue-cleanup`
- workflow filename：**`publish-npm.yml`**（含 `.yml`，必须精确）

配置位置：npmjs.com → 包的 Settings → Trusted Publisher（新包走 "pending publisher"）。

### 5.1 为什么发布逻辑**只能由 publish-npm.yml 自己标签触发**

npm 的 Trusted Publisher 把信任绑定到**具体 workflow 文件名**，而 npm 服务端校验的是
**调用方**的文件名。npm 官方文档《Trusted publishing》原文：

> Some GitHub Actions workflows use workflow_call to invoke other workflows that run
> npm publish ... When this happens, validation checks **the calling workflow's name**
> instead of the workflow that actually contains the publish command, which can cause
> configuration mismatches.

⚠️ **本仓库 1.1.2 及之前的文档曾写错**：那时写的是「`workflow_call` 时 `job_workflow_ref`
= 被调用文件，所以复用可行」。OIDC 令牌里的字段确实是这样，**但 npm 不看它**。所以
`pack-release.yml` 用 `uses:` 调过去时，npm 看到的是 `pack-release.yml` → 与登记的
`publish-npm.yml` 不符 → 令牌交换被拒 → 一律：

```
npm error code ENEEDAUTH
npm error need auth This command requires you to be logged in to https://registry.npmjs.org/
```

历史对照（很能说明问题）：

| 版本 | 触发方式 | npm 结果 |
|---|---|---|
| 1.1.0 | 手动 `workflow_dispatch` 直接跑 `publish-npm.yml` | ✅ 成功 |
| 1.1.1 | 标签 → `pack-release.yml` → `workflow_call` | ❌ ENEEDAUTH |
| 1.1.2 | 同上 | ❌ ENEEDAUTH |

**正确结构**：`publish-npm.yml` 自己监听 `push: tags: ['v*']`，与 `pack-release.yml`
**并列触发、互不调用**。一个发 GitHub Release，一个发 npm。`pack-release.yml` 里
**不得**再有 `publish-npm` job，也**不得**出现 `uses: ./.github/workflows/publish-npm.yml`。

发布逻辑仍然只有一份（就在 `publish-npm.yml`），只是从「被复用」改成「并列触发」。
`test/release-workflow.test.mjs` 用反向断言钉住这条底线：退回 `workflow_call` 立刻红。

### 5.2 发布是「暂存 + 人工批准」两步

若本包的 Trusted Publisher 只授予 `npm stage publish` 与 `npm dist-tag`（**没有** `npm publish`），
普通 `npm publish` 会被拒（`403 OIDC permission denied`），必须走暂存发布：

1. CI 自动完成**暂存**：`npm stage publish` 成功后会打出 stage id，并附 Sigstore 签名溯源；
2. **人工批准**（需 2FA，只能由账号持有者做）：

```powershell
npm stage list                    # 看 stage id
npm stage approve <stage-id>      # 输入 2FA 一次性验证码
```

**没批准之前版本不会公开**，`npm view dsh-dialogue-cleanup version` 仍是上一个版本
（或对全新包返回 404）。**Release 附件不受影响** —— 所以「从 Release 附件安装」这条主路径
不会因为 npm 那一步慢而受影响。

### 5.3 两个已踩过的坑（都写在 workflow 注释里）

1. **不要写 `npm@latest`**：npm 12 起要求 `node ^22.22.2 || ^24.15.0 || >=26`，
   而 workflow 钉的是 node 22.14.0 → `EBADENGINE` 失败，publish 根本没跑到。
   用 `npm install -g "npm@^11.5.1"`（既有 `stage` 子命令，又与 node 22.14 相容）。
2. **不要给 `setup-node` 写 `registry-url`**：它会注入
   `NODE_AUTH_TOKEN=github.token`（对 npm 无效），可能盖过 OIDC。

`publish-npm.yml` 里那一步**自检 OIDC 身份**会把「文件名不对」从一句要翻日志才看得懂的
`need auth`，变成**发布之前**就红在自检上；`test/release-workflow.test.mjs` 保证它排在
`Stage publish` 之前。

## 6. 手动补发 / 重试

```powershell
# 走同一条 OIDC 通道（与 CI 完全一致），读 package.json 的当前版本去暂存发布
gh workflow run publish-npm.yml --repo Winnie-0721/dsh-dialogue-cleanup --ref main

# 补跑打包与建 Release：按 package.json 的版本找对应标签重打（Release 已存在则幂等补传附件）
gh workflow run pack-release.yml --repo Winnie-0721/dsh-dialogue-cleanup --ref main
```

幂等闸门（`该版本已在 npm 则跳过`）保证重跑不会因「版本已存在」而失败。
**注意**：闸门命中时 `Stage publish` 那一步会被 **skipped** —— 此时 job 绿**不等于**发布成功
（参考仓库有过这种错觉）。发新版本时要盯的是 `Stage publish to npm` 这一步本身。

## 7. 发版前跑一遍

```powershell
pwsh -File scripts\release.ps1 -LocalOnly      # 全套门禁（含 238 条测试）
node test/release-workflow.test.mjs            # 只跑发布工作流回归
node test/mutate-tokens-official.mjs           # 变异测试：必须 survived 0
```

> 常规 CI（`.github/workflows/ci.yml`）会在 **push 到 main 与 PR** 时自动跑
> 语法检查 + 全套测试 + 行尾守卫，并**断言测试条数 ≥ 200**（防止 glob 静默漏跑）。
> 变异测试在 CI 里是独立 job，要求 `survived === 0` —— 脚本在原文未命中时会打
> `SKIP` 并把它计入 survived，只看退出码会漏掉「断言退化成装饰品」。

## 8. 发布之后：改动什么时候生效

| 改动位置 | 生效方式 |
|---|---|
| **客户端半**（`client.js`） | 宿主按文件元数据算出新的产物 rev 推给页面，**无需重启**、通常也无需刷新 |
| **宿主半**（`lib/*.js`） | 需要**重启 DSH 进程**（Loader 缓存的是已导入的模块） |

⚠️ patch 层的 disable/enable 热重载**只重建 fiber，不重新导入 Node 模块** ——
它能证明「这一行被卸载/重新加回」，但拿到的是 Loader 缓存里的旧代码。
**不要用它验证宿主半改动**（这正是本项目改包名后一直 `fiberPhase: null`、
必须重启才能生效的原因）。
