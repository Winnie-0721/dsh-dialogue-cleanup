/**
 * 断言：仓库里带非 ASCII 字符的 PowerShell 脚本必须带 UTF-8 BOM。
 *
 * 【为什么值得一条测试】复刻自 dsh-plugin-market 的真实事故：
 * Windows PowerShell 5.1 对**无 BOM** 的 UTF-8 脚本按 ANSI 解码，
 * 中文注释会被解成乱码并直接把脚本解析坏 —— 那边 release.ps1 因此在发布时以
 * 「意外的标记」失败，版本没发出去。
 *
 * 本仓库尤其容易踩：`scripts/release.ps1` 里有大量中文注释，而且**编辑工具
 * （包括本仓库用的 edit 工具）重写文件时会把 BOM 去掉** —— 我在复刻过程中
 * 就被去掉过一次，是这条检查的思路让我当场发现并补回的。
 *
 * 用法：node test/ps-script.test.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'

const root = fileURLToPath(new URL('..', import.meta.url))
const BOM = Buffer.from([0xef, 0xbb, 0xbf])

function psFiles(dir) {
  const out = []
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) { walk(p); continue }
      if (name.endsWith('.ps1')) out.push(p)
    }
  }
  if (statSync(dir, { throwIfNoEntry: false })?.isDirectory()) walk(dir)
  return out
}

test('PowerShell 脚本：含非 ASCII 必须带 UTF-8 BOM（PS 5.1 否则按 ANSI 解析）', () => {
  const files = psFiles(join(root, 'scripts'))
  assert.ok(files.length > 0, 'scripts/ 下应当有 .ps1')

  const problems = []
  for (const p of files) {
    const bytes = readFileSync(p)
    const hasBom = bytes.subarray(0, 3).equals(BOM)
    const hasNonAscii = bytes.some((b) => b > 0x7f)
    if (hasNonAscii && !hasBom) problems.push(p.replace(root, ''))
  }
  assert.deepEqual(problems, [], `以下脚本含非 ASCII 但没有 UTF-8 BOM：${problems.join('、')}`)
})

test('PowerShell 脚本：Get-Content 必须显式 -Encoding UTF8', () => {
  // PS 5.1 的 Get-Content 默认按系统 ANSI（GBK）解码无 BOM 的 UTF-8 文件，
  // 中文会被读成乱码并原样写出去（那边 Release 正文整页乱码就是这么来的）。
  //
  // 负向对照与真实检查共用同一把尺子 —— 否则「全部通过」可能只是尺子失效。
  const isViolation = (line) => {
    const code = line.trim()
    if (!code.includes('Get-Content')) return false
    if (code.startsWith('#')) return false
    return !/-Encoding\s+UTF8/i.test(line)
  }

  const controls = [
    [true, '$x = Get-Content CHANGELOG.md -Raw'],
    [true, '$notes = Get-Content (Join-Path $root $f) -Raw'],
    [false, '$x = Get-Content CHANGELOG.md -Raw -Encoding UTF8'],
    [false, '$x = Get-Content -LiteralPath $p -Raw -Encoding utf8'],
    [false, '# Get-Content 读文件不带 -Encoding 是历史事故'],
  ]
  for (const [expected, line] of controls) {
    assert.equal(isViolation(line), expected, `负向对照失败（${expected ? '该抓' : '该放'}）：${line}`)
  }

  const files = psFiles(join(root, 'scripts'))
  const problems = []
  let calls = 0
  for (const p of files) {
    const lines = readFileSync(p, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)
    lines.forEach((line, i) => {
      if (!line.includes('Get-Content') || line.trim().startsWith('#')) return
      calls += 1
      if (isViolation(line)) problems.push(`${p.replace(root, '')}:${i + 1}`)
    })
  }
  assert.ok(calls > 0, 'scripts/ 下没有找到任何 Get-Content 调用——检查本身可能失效了')
  assert.deepEqual(problems, [], `以下 Get-Content 未显式 -Encoding UTF8：${problems.join('、')}`)
})
