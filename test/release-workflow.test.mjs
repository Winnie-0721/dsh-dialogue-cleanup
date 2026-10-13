/**
 * 发布工作流的凭据结构回归。
 *
 * 【为什么需要这个套件】复刻自 dsh-plugin-market。那个仓库里同一个缺陷**连续两次**让版本
 * 发布变红（v1.1.6 的 run #3、v1.2.0 的 run #4），每次都要人工手动补发一次 npm。
 * 它不是风格问题，是**凭据结构**问题，而且**静默**：pack 那半成功、Release 附件也都就绪，
 * 只有 publish job 报 `npm error code ENEEDAUTH`，看起来像「npm 抽风」。
 *
 * 根因：npm 的 Trusted Publisher 把信任绑定到**具体 workflow 文件名**；OIDC 令牌里
 * npm 实际校验的是 `job_workflow_ref`，而**实测**：
 *   - 普通 job：        job_workflow_ref = 所在文件
 *   - workflow_call：   job_workflow_ref = **被调用**的文件（workflow_ref 才是调用方）
 * 所以「pack-release.yml 里自己写一遍发布步骤」→ 令牌里是 pack-release.yml
 * → 与登记的 publish-npm.yml 不符 → ENEEDAUTH。
 *
 * 本套件把「发布只能由 publish-npm.yml 亲自执行」钉死，防止有人（包括将来的我）
 * 为了「少一个文件」再把步骤复制回 pack-release.yml。同时钉住必须保留的幂等闸门。
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

/** 取出某个 workflow 里某个顶层 job 的文本（到下一个同级 job 或文件末）。 */
function jobBlock(text, jobName) {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => new RegExp(`^  ${jobName}:\\s*$`).test(l))
  assert.ok(start !== -1, `找不到 job: ${jobName}`)
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}\S/.test(lines[i])) { end = i; break }
  }
  return lines.slice(start, end).join('\n')
}

test('发布工作流：npm 发布只能由 publish-npm.yml 亲自执行（防 ENEEDAUTH 复发）', () => {
  const publish = read('publish-npm.yml')
  const pack = read('pack-release.yml')

  // publish-npm.yml 可被复用（少了它，pack-release 的 uses: 会直接报 workflow 不可用）。
  assert.match(
    publish,
    /^on:\s*$(?:.*\n)*?^ {2}workflow_call:\s*$/m,
    'publish-npm.yml 必须在 on: 下声明 workflow_call，才能被 pack-release 复用',
  )
  assert.match(publish, /^ {2}workflow_dispatch:\s*$/m, '人工补发通道不能被删')

  // pack-release.yml 必须复用，而不是自己跑发布命令。
  const block = jobBlock(pack, 'publish-npm')
  assert.match(
    block,
    /uses:\s*\.\/\.github\/workflows\/publish-npm\.yml/,
    'publish-npm job 必须 `uses: ./.github/workflows/publish-npm.yml`（这样 job_workflow_ref 才是登记的文件名）',
  )
  // 关键反向断言：不许出现 npm 发布命令。这就是那个复发两次的 bug。
  assert.equal(
    /npm\s+stage\s+publish/.test(block),
    false,
    'pack-release.yml 里不得出现 npm stage publish——自己执行会让 OIDC 的文件名变成 pack-release.yml，npm 直接回 ENEEDAUTH',
  )
  assert.equal(/runs-on:/.test(block), false, '复用型 job 不能带 runs-on（那是被调用文件的事）')

  // 调用方必须为可复用 workflow 授予 id-token: write（OIDC 必需），且必须是**顶层** permissions。
  const lines = block.split('\n')
  const permAt = lines.findIndex((l) => /^ {4}permissions:\s*$/.test(l))
  assert.ok(permAt !== -1, 'publish-npm job 必须显式声明 permissions（与 uses: 同级，缩进 4 空格）')
  const permLines = []
  for (let i = permAt + 1; i < lines.length; i += 1) {
    if (/^ {4}\S/.test(lines[i])) break
    permLines.push(lines[i])
  }
  assert.ok(
    permLines.some((l) => /id-token:\s*write/.test(l)),
    'publish-npm job 的 permissions 里必须有 id-token: write',
  )

  // 被调用文件自己也声明 id-token: write。
  const at = publish.split('\n').findIndex((l) => /^permissions:\s*$/.test(l))
  assert.ok(at !== -1, 'publish-npm.yml 必须有顶层 permissions:')
  const pLines = publish.split('\n')
  const pBlock = []
  for (let i = at + 1; i < pLines.length; i += 1) {
    if (/^\S/.test(pLines[i])) break
    pBlock.push(pLines[i])
  }
  assert.ok(pBlock.some((l) => /id-token:\s*write/.test(l)), 'publish-npm.yml 顶层 permissions 里必须有 id-token: write')
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
