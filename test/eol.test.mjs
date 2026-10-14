/**
 * 断言：仓库里的文本源文件在磁盘上必须是纯 LF，且 .gitattributes 覆盖到位。
 *
 * 【为什么值得一条测试】这是一次真实事故的复盘，而不是假想的洁癖：
 *
 *   本机全局 core.autocrlf=true。正常情况下 .gitattributes 的 `eol=lf` 会覆盖它，
 *   所以 checkout 到磁盘的文件应该是 LF。但上一轮我改用 GitHub Git Data API 推送
 *   （git 直连端点被连接重置，只能走 API），API 推送读的是**磁盘原始字节**，
 *   完全绕过了 git 的 clean filter —— 于是 lib/config.js 以 CRLF 形态进了远端 blob。
 *
 *   后果很隐蔽：代码语义毫无变化，`git diff` 是空的，测试全绿，
 *   但远端 blob SHA 与本地 HEAD 不一致（f08c0d93 vs e76dfaf1）。
 *   而且 npm 打包同样是**直接读磁盘**的，所以 CRLF 会被原样发到 npm。
 *
 * 教训：凡是「绕过 git 过滤器」的路径（API 推送、手动打包）都必须单独设防。
 * 这条测试盯的就是磁盘字节本身，不依赖任何 git 过滤器是否生效。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'

const root = fileURLToPath(new URL('..', import.meta.url))

/** .gitattributes 声明为 lf 的文本类型 */
const TEXT_EXT = new Set(['.js', '.mjs', '.json', '.yml', '.yaml', '.md', '.txt', '.html', '.css'])
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage'])

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) { walk(p, out); continue }
    if (TEXT_EXT.has(extname(name))) out.push(p)
  }
  return out
}

test('磁盘上的文本源文件必须是纯 LF（npm 打包与 API 推送都会绕过 git 过滤器）', () => {
  const files = walk(root)
  assert.ok(files.length > 20, `扫到的文本文件太少（${files.length}）——检查本身可能失效了`)

  const offenders = []
  for (const p of files) {
    const buf = readFileSync(p)
    const cr = buf.reduce((n, b) => (b === 13 ? n + 1 : n), 0)
    if (cr > 0) offenders.push(`${p.slice(root.length).replace(/\\/g, '/')} (${cr} 个 CR)`)
  }

  assert.deepEqual(
    offenders,
    [],
    `以下文件在磁盘上是 CRLF；npm 打包与 GitHub API 推送都会绕过 .gitattributes，` +
      `会把 CRLF 原样发出去。请转为 LF：\n  ${offenders.join('\n  ')}`,
  )
})

test('负向对照：CRLF 检测尺子本身有效', () => {
  // 共用同一把尺子 —— 否则「全部通过」可能只是尺子失效（本项目已有前车之鉴）。
  const countCr = (buf) => buf.reduce((n, b) => (b === 13 ? n + 1 : n), 0)
  assert.ok(countCr(Buffer.from('a\r\nb\r\n')) === 2, '应当数出 2 个 CR')
  assert.ok(countCr(Buffer.from('a\nb\n')) === 0, 'LF 文本不应数出 CR')
})

test('.gitattributes 覆盖了仓库里实际存在的文本类型，且声明为 lf', () => {
  const attrs = readFileSync(join(root, '.gitattributes'), 'utf8')

  // 负向对照：确认解析逻辑真的在判断 eol，而不是碰巧命中
  const declaresLf = (text, ext) => {
    // 允许成组写法，例如 `*.js text eol=lf` 或 `*.{js,mjs} text eol=lf`
    return new RegExp(`\\*\\.[a-z{},]*${ext.slice(1)}[a-z{},]*\\s+text\\s+eol=lf`, 'i').test(text)
  }
  assert.equal(declaresLf('*.js text eol=lf', '.js'), true)
  assert.equal(declaresLf('*.{js,mjs} text eol=lf', '.mjs'), true)
  assert.equal(declaresLf('*.js text eol=crlf', '.js'), false, 'eol=crlf 不该被判为 lf')
  assert.equal(declaresLf('*.js text', '.js'), false, '未声明 eol 不该被判为 lf')

  // 【为什么按实际存在的扩展名推导，而不是硬编码一份清单】
  // 我第一版凭想象写了 .html/.css，而仓库里根本没有这两种文件，
  // 于是测试因为「清单里的类型未被声明」而误红 —— 那是测试错，不是仓库错。
  // 设防要对着**实际存在的字节**，不能对着想象。
  const present = new Set()
  for (const p of walk(root)) {
    const ext = extname(p).toLowerCase()
    if (TEXT_EXT.has(ext)) present.add(ext)
  }
  assert.ok(present.size >= 3, `实际存在的文本类型太少（${[...present].join('、')}）——检查可能失效了`)

  const missing = [...present].filter((ext) => !declaresLf(attrs, ext)).sort()
  assert.deepEqual(missing, [], `.gitattributes 未把实际存在的这些类型声明为 eol=lf：${missing.join('、')}`)
})
