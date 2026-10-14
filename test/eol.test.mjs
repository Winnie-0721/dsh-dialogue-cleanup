/**
 * 行尾守卫：磁盘文本必须是 LF，且每个被跟踪文本文件都必须被 git 判定为 eol=lf。
 *
 * 【为什么值得这条测试 —— v1.0.0 的真实事故，两次】
 *
 * 事故一（本地→远端）：改用 GitHub Git Data API 推送时读的是**磁盘原始字节**，
 *   绕过了 git 的 clean filter，于是 lib/config.js 以 CRLF 进了远端 blob。
 *   代码语义没变、`git diff` 是空的、测试全绿，但远端 blob SHA 与本地不一致。
 *
 * 事故二（CI→npm，本条测试第一版没拦住的那个）：
 *   第一次发版后，我用 `pnpm pack`（CI）与 `npm pack`（本地）各打一次 tarball，
 *   发现「同一个版本」内容不一致：
 *     icon.svg   CI 438 字节（10 个 CR） vs 本地 428 字节（纯 LF）
 *     LICENSE    CI 1111 字节（21 个 CR）vs 本地 1090 字节（纯 LF）
 *   根因不在打包器，而在 .gitattributes 当时只写了 `* text=auto` ——
 *   行尾于是由**检出端的 core.autocrlf** 决定。GitHub 的 windows runner 默认
 *   autocrlf=true，凡是**没被显式声明 eol=lf** 的文件（*.svg、无扩展名的 LICENSE）
 *   都会被检出成 CRLF，再原样打进 tarball。同一个 tag 发出去的字节跟着环境变。
 *
 * 【第一版为什么没拦住事故二 —— 这是本文件最重要的教训】
 *   第一版按**硬编码扩展名清单**（.js/.json/.md…）扫描，而 .svg 不在清单里、
 *   LICENSE 根本没有扩展名 —— 于是它绿着放过了真实缺陷。
 *   所以现在不再列清单，改为两条腿：
 *     1. 磁盘字节扫描：对所有**被 git 跟踪**的文件（不依赖扩展名清单）
 *     2. `git check-attr eol`：读**实际生效**的属性，而不是用正则猜 .gitattributes 文本
 *   这样「清单外的新文件」也会被自动覆盖到。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import assert from 'node:assert/strict'

const root = fileURLToPath(new URL('..', import.meta.url))

const git = (args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })

/** 仓库里被 git 跟踪的文件（目录列表，不依赖扩展名清单） */
const trackedFiles = () => git(['ls-files', '-z']).split('\0').filter(Boolean)

/** 该 buffer 里 CR 的个数 */
const countCr = (buf) => buf.reduce((n, b) => (b === 13 ? n + 1 : n), 0)

// 二进制扩展名（这些不受行尾约束）。注意：不在这里列「文本」清单 ——
// 那正是第一版的缺陷。这里只排除明确的二进制。
const BINARY_EXT = /\.(png|jpe?g|gif|ico|woff2?|ttf|otf|eot|zip|gz|tgz|pdf|so|dll|exe|node)$/i
// .ps1 有意保持 CRLF（Windows PowerShell 5.1 + UTF-8 BOM 的需要）
const CRLF_ALLOWED = /\.ps1$/i

test('负向对照：CR 计数尺子本身有效', () => {
  // 与真实检查共用同一把尺子 —— 否则「全部通过」可能只是尺子坏了。
  assert.equal(countCr(Buffer.from('a\r\nb\r\n')), 2, '应数出 2 个 CR')
  assert.equal(countCr(Buffer.from('a\nb\n')), 0, 'LF 文本不应数出 CR')
  assert.equal(countCr(Buffer.from([0x61, 0x0d, 0x62])), 1, '孤立 CR 也要数出')
})

test('磁盘上的文本文件必须是纯 LF（npm/pnpm pack 都直接读磁盘）', () => {
  const files = trackedFiles()
  assert.ok(files.length > 20, `被跟踪文件太少（${files.length}）——检查本身可能失效了`)

  const offenders = []
  let checked = 0
  for (const rel of files) {
    if (BINARY_EXT.test(rel) || CRLF_ALLOWED.test(rel)) continue
    let buf
    try {
      buf = readFileSync(join(root, rel))
    } catch {
      continue // 符号链接等
    }
    if (buf.includes(0)) continue // 含 NUL 视为二进制
    checked += 1
    const cr = countCr(buf)
    if (cr > 0) offenders.push(`${rel} (${cr} 个 CR)`)
  }

  assert.ok(checked > 20, `实际检查的文本文件太少（${checked}）——检查本身可能失效了`)
  assert.deepEqual(
    offenders,
    [],
    '以下文件在磁盘上是 CRLF。GitHub 的 windows runner 会把 CRLF 原样打进 tarball，' +
      `使 CI 产物与本地产物不一致；npm pack 也直接读磁盘。请转为 LF：\n  ${offenders.join('\n  ')}`,
  )
})

test('每个被跟踪的文本文件都必须被 git 判定为 eol=lf（不能依赖检出端 autocrlf）', () => {
  // 这条才是真正防住事故二的断言：只要某个文本文件没有生效的 eol=lf，
  // 它在 core.autocrlf=true 的检出端（GitHub windows runner）上就会变 CRLF。
  // 用 git check-attr 读实际生效值 —— 而不是正则猜 .gitattributes 的文本。
  const targets = trackedFiles().filter((f) => !BINARY_EXT.test(f) && !CRLF_ALLOWED.test(f))
  assert.ok(targets.length > 20, `待检查文件太少（${targets.length}）`)

  const out = git(['check-attr', 'eol', '--', ...targets])
  const bad = []
  for (const line of out.split('\n')) {
    if (!line.trim()) continue
    const m = line.match(/^(.*?): eol: (.*)$/)
    if (!m) continue
    if (m[2] !== 'lf') bad.push(`${m[1]} -> eol: ${m[2]}`)
  }

  assert.deepEqual(
    bad,
    [],
    '以下文件未被 git 判定为 eol=lf —— 在 core.autocrlf=true 的检出端它们会变成 CRLF，' +
      '使 CI 打出的 tarball 与本地不一致。请在 .gitattributes 加 `* text=auto eol=lf` ' +
      `全局默认，或逐个补声明：\n  ${bad.join('\n  ')}`,
  )
})

test('.gitattributes 的全局默认必须是 text=auto eol=lf（否则行尾又由环境决定）', () => {
  const attrs = readFileSync(join(root, '.gitattributes'), 'utf8')
  const live = attrs.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n') // 只看生效行
  assert.match(
    live,
    /\*\s+text=auto\s+eol=lf/,
    '缺少 `* text=auto eol=lf` 全局默认 —— 未显式声明的文件（如 *.svg、LICENSE）' +
      '会在 windows 检出端变 CRLF，正是 v1.0.0 那个 CI/本地产物不一致的根因',
  )
})

test('负向对照：check-attr 判定确实能区分 lf 与 crlf', () => {
  // 拿已知 eol=crlf 的文件验证判定逻辑。若这里也成了 lf，说明上面那条检查失效了。
  const out = git(['check-attr', 'eol', '--', 'scripts/release.ps1'])
  const m = out.match(/eol: (.*)$/m)
  assert.ok(m, 'check-attr 应给出 eol 值')
  assert.equal(m[1].trim(), 'crlf', 'release.ps1 应仍是 crlf（它被 CRLF_ALLOWED 排除，但判定必须能报出 crlf）')
})
