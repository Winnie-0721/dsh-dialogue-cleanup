/**
 * 发布工作流的凭据结构回归。
 *
 * 【为什么需要这个套件】复刻自 dsh-plugin-market。那个仓库里同一个缺陷**连续两次**让版本
 * 发布变红（v1.1.6 的 run #3、v1.2.0 的 run #4），每次都要人工手动补发一次 npm。
 * 它不是风格问题，是**凭据结构**问题，而且**静默**：pack 那半成功、Release 附件也都就绪，
 * 只有 publish job 报 `npm error code ENEEDAUTH`，看起来像「npm 抽风」。
 *
 * 根因（v1.1.1 / v1.1.2 两次 npm 发布失败的真因，2026-10-20 查清）：npm 的 Trusted
 * Publisher 把信任绑定到**具体 workflow 文件名**，而 npm 服务端校验的是**调用方**：
 *
 *   npm 官方文档《Trusted publishing》：
 *     "Some GitHub Actions workflows use workflow_call to invoke other workflows that run
 *      npm publish ... When this happens, validation checks **the calling workflow's name**
 *      instead of the workflow that actually contains the publish command."
 *
 * 所以早先那版「用 workflow_call 复用 → job_workflow_ref 仍是登记的文件 → 可行」的推导
 * 是**错的**：OIDC 令牌字段确实没错，但 npm 不看它。由 pack-release.yml 调过去时 npm 看到
 * 的是 pack-release.yml → 与登记的 publish-npm.yml 不符 → 令牌交换被拒 → ENEEDAUTH。
 *
 * 正确结构：**publish-npm.yml 自己监听 `push: tags: ['v*']`**，与 pack-release.yml
 * 并列触发、互不调用。本套件把这个结构钉死，防止有人（包括将来的我）为了「少一个文件」
 * 又改回复用。同时钉住必须保留的幂等闸门。
 *
 * 用法：node test/release-workflow.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = fileURLToPath(new URL('..', import.meta.url))
const wfDir = join(root, '.github', 'workflows')
const read = (name) => readFileSync(join(wfDir, name), 'utf8')

/**
 * 取出某个 step 的文本（从 `- name: <名字>` 起，到下一个同级 step 或文件末）。
 * 为什么需要它而不是全文正则：同一条 `if:` 条件在多个 step 上都会出现，
 * 全文匹配会把「条件在别处也成立」当成「目标步骤有该条件」——变异测试漏检的经典原因。
 */
function stepBlock(text, stepName) {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => new RegExp(`^\\s*- name:\\s*${stepName}\\s*$`).test(l))
  assert.ok(start !== -1, `找不到 step: ${stepName}`)
  const indent = lines[start].match(/^\s*/)[0].length
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (new RegExp(`^\\s{${indent}}-\\s`).test(lines[i])) { end = i; break }
  }
  return lines.slice(start, end).join('\n')
}

/** 去掉整行注释（`#` 开头，允许前导空白），只留真正生效的 YAML。 */
function liveLines(text) {
  return text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
}

test('发布工作流：npm 发布只能由 publish-npm.yml 自己标签触发（防 ENEEDAUTH 复发）', () => {
  const publishRaw = read('publish-npm.yml')
  const publish = liveLines(publishRaw)
  const pack = liveLines(read('pack-release.yml'))

  // ① 主路径：本文件自己监听标签推送。这是「npm 看到的调用方 = 本文件」的唯一保证。
  assert.match(
    publish,
    /^ {2}push:\s*$(?:.*\n)*?^ {4}tags:\s*\[?'?v\*'?\]?\s*$/m,
    'publish-npm.yml 必须在 on: 下自己声明 push: tags: [v*] —— 由 pack-release 调用会 ENEEDAUTH',
  )
  assert.match(publish, /^ {2}workflow_dispatch:\s*$/m, '人工补发通道不能被删')

  // ② 反向断言：绝不能退回 workflow_call 复用路径（v1.1.1 / v1.1.2 就是死在这条路上）。
  assert.equal(
    /^ {2}workflow_call:\s*$/m.test(publish),
    false,
    'publish-npm.yml 不得声明 workflow_call：npm 校验的是调用方文件名，复用必然 ENEEDAUTH',
  )

  // ③ pack-release.yml 里不许再有发布 job，也不许用 uses: 调过去。
  assert.equal(
    /^ {2}publish-npm:\s*$/m.test(pack),
    false,
    'pack-release.yml 里不得有 publish-npm job —— 调用方是 pack-release.yml，npm 不认',
  )
  assert.equal(
    /uses:\s*\.\/\.github\/workflows\/publish-npm\.yml/.test(pack),
    false,
    'pack-release.yml 不得 uses: publish-npm.yml（workflow_call 路径已被证伪）',
  )

  // ④ 关键反向断言：pack-release.yml 里不许出现 npm 发布命令（第二份实现）。
  assert.equal(
    /npm\s+stage\s+publish/.test(pack),
    false,
    'pack-release.yml 里不得出现 npm stage publish',
  )

  // ⑤ 本文件自己的顶层 permissions 必须有 id-token: write（OIDC 必需）。
  const pLines = publish.split('\n')
  const at = pLines.findIndex((l) => /^permissions:\s*$/.test(l))
  assert.ok(at !== -1, 'publish-npm.yml 必须有顶层 permissions:')
  const pBlock = []
  for (let i = at + 1; i < pLines.length; i += 1) {
    if (/^\S/.test(pLines[i])) break
    pBlock.push(pLines[i])
  }
  assert.ok(
    pBlock.some((l) => /id-token:\s*write/.test(l)),
    'publish-npm.yml 顶层 permissions 里必须有 id-token: write',
  )
})

test('发布工作流：幂等闸门（版本已在 npm 则跳过）', () => {
  const publish = read('publish-npm.yml')

  assert.match(publish, /npm view\s+"\$SPEC"\s+version/, '要有 npm view 查询该版本是否已存在')
  assert.match(publish, /skip=true/, '要设置 skip 输出')

  // 必须钉在「Stage publish」那一步上，不能全文找 `if: steps.guard...`：
  // 后面「提示下一步」那步用的是同一个条件，全文正则会命中它 → 把发布步骤的 if 删掉也算通过。
  const stage = stepBlock(publish, 'Stage publish to npm')
  assert.match(
    stage,
    /if:\s*steps\.guard\.outputs\.skip\s*==\s*'false'/,
    'Stage publish 步骤自身必须以 skip 为条件（否则补跑时版本已存在会失败）',
  )

  // 跳过判定用 name@version，而不是 dist-tags.latest：暂存发布在人工批准前**不会**更新 latest。
  assert.match(
    publish,
    /node -p "const p=require\('\.\/package\.json'\); p\.name \+ '@' \+ p\.version"/,
    '要拼出 name@version 来查',
  )
  const guard = publish.slice(publish.indexOf('该版本已在 npm 则跳过'))
  assert.equal(/dist-tags/.test(guard), false, '闸门不得依赖 dist-tags.latest（暂存批准前不更新 latest）')
})

test('发布工作流：两个历史坑的防回归', () => {
  const publish = read('publish-npm.yml')

  // 没写 npm@latest（npm 12 与 node 22.14 不兼容 → EBADENGINE）
  const installs = [...publish.matchAll(/npm install -g\s+"?([^"\s]+)"?/g)].map((m) => m[1])
  assert.ok(installs.length > 0, '要能找到一个 npm install -g')
  for (const spec of installs) {
    assert.notEqual(spec, 'npm@latest', `npm@latest 会在 node 22.14 上 EBADENGINE：${spec}`)
  }
  assert.ok(installs.some((s) => /npm@\^11\./.test(s)), `应钉到 11.x，实际 ${JSON.stringify(installs)}`)

  // 没给 setup-node 写 registry-url（会注入无效 token 盖过 OIDC）。
  // **只看非注释行**：`registry-url` 这个词在注释里出现过（正是解释「为什么故意不写它」）。
  const live = publish.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
  assert.equal(
    /registry-url\s*:/.test(live),
    false,
    'registry-url 会让 setup-node 注入 NODE_AUTH_TOKEN=github.token（对 npm 无效），可能盖过 OIDC',
  )

  assert.match(publish, /npm stage publish --access public/, '必须用暂存发布（本包 Trusted Publisher 只授予 stage+dist-tag）')
})

test('发布工作流：OIDC 身份自检排在发布之前', () => {
  const publish = read('publish-npm.yml')
  const step = stepBlock(publish, '自检 OIDC 身份（文件必须是 publish-npm.yml）')
  assert.match(step, /ACTIONS_ID_TOKEN_REQUEST_URL/, '要真的去请求 OIDC 令牌')
  assert.match(step, /job_workflow_ref/, '要比对的字段就是它（npm 按这个匹配）')
  assert.match(step, /publish-npm\.yml@/, '必须断言里面是 publish-npm.yml')
  assert.match(step, /sys\.exit/, '文件名不对要**失败**，不能只打印')

  const selfCheck = publish.indexOf('自检 OIDC 身份')
  const guard = publish.indexOf('该版本已在 npm 则跳过')
  const stage = publish.indexOf('Stage publish to npm')
  assert.ok(selfCheck !== -1 && guard !== -1 && stage !== -1, '三个步骤都要存在')
  assert.ok(selfCheck < stage, '自检必须在 Stage publish 之前')
  assert.ok(selfCheck < guard, '自检应在幂等闸门之前——这样即使会跳过，也能早早证明身份正确')
})

test('发布工作流：令牌交换自检必须存在，且排在发布之前', () => {
  // 【为什么值得一条测试】npm 在令牌交换失败时**静默降级**：
  // lib/utils/oidc.js 的 catch 分支只写 verbose 日志就 return undefined，
  // 于是 publish 退化成未认证请求，最终只甩一句 ENEEDAUTH / need auth。
  // 真实原因（信任配置与仓库/文件名不匹配）被完全吞掉 —— 本项目就这么被坑过一次。
  // 所以加了一步「主动交换并把 registry 响应原样打印」的自检。
  const publish = read('publish-npm.yml')
  const step = stepBlock(publish, '自检 OIDC 令牌交换（把静默的 ENEEDAUTH 变成具体原因）')

  assert.match(step, /token\/exchange\/package\//, '要真的调用令牌交换端点')
  assert.match(step, /ACTIONS_ID_TOKEN_REQUEST_URL/, '要请求 OIDC 令牌')
  assert.match(step, /HTTPError/, '要捕获失败响应并打印 body —— 否则又变成静默')
  assert.match(step, /registry 响应/, '要把 registry 的响应体打出来')

  // 只读：不得在这一步里发布任何东西。
  assert.equal(
    /npm\s+(stage\s+)?publish/.test(step),
    false,
    '令牌交换自检必须是只读的，不得顺带发布',
  )

  const exchangeCheck = publish.indexOf('自检 OIDC 令牌交换')
  const guard = publish.indexOf('该版本已在 npm 则跳过')
  const stage = publish.indexOf('Stage publish to npm')
  assert.ok(exchangeCheck !== -1 && guard !== -1 && stage !== -1, '三个步骤都要存在')
  assert.ok(exchangeCheck < stage, '令牌交换自检必须在 Stage publish 之前')
  assert.ok(guard < exchangeCheck, '幂等闸门应排在前面：跳过时不必再做交换自检')
})

test('发布工作流：不许有第二份发布实现，也不许留探针', () => {
  const offenders = []
  for (const f of readdirSync(wfDir)) {
    if (!/\.ya?ml$/.test(f)) continue
    if (f === 'publish-npm.yml') continue
    if (/npm\s+stage\s+publish/.test(read(f))) offenders.push(f)
  }
  assert.deepEqual(offenders, [], `以下文件里也出现了 npm stage publish（会重演 ENEEDAUTH）：${offenders.join('、')}`)

  const probes = readdirSync(wfDir).filter((f) => /probe/i.test(f))
  assert.deepEqual(probes, [], `残留探针 workflow：${probes.join('、')}`)
})

test('发布工作流：包在仓库根 —— 不得给 npm 发布设 working-directory', () => {
  // 【适配点】参考仓库的 package.json 在 plugin-market/ 子目录，所以那边必须设
  // working-directory。本仓库的 package.json 在**根**；照抄那行会直接 ENOENT，
  // 而且这个错误只在 CI 里才暴露 —— 用一条断言把它钉在这里。
  const publish = read('publish-npm.yml')
  const live = publish.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
  assert.equal(
    /working-directory\s*:/.test(live),
    false,
    '本仓库的 package.json 在根目录，设 working-directory: plugin-market 会 ENOENT',
  )
  // 反过来确认包确实在根：package.json 存在且 name 与 workflow 里查的一致。
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(manifest.name, 'dsh-dialogue-cleanup', '包名应与 workflow 中引用的一致')
  assert.equal(manifest.private, undefined, 'private: true 会阻止发布')
})
