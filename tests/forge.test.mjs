import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { readForge } from '../lib/app.js'

function makeRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'qgate-forge-'))
  mkdirSync(join(dir, '鲸鱼女仆画廊'), { recursive: true })
  return dir
}

function daysAgo(n) {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

test('读两个笔记的「上次炼化」，算出最久没动的那本', () => {
  const root = makeRoot()
  try {
    writeFileSync(join(root, '_说话.md'), `# 说话\n> 上次炼化：**${daysAgo(2)}**\n`, 'utf8')
    writeFileSync(join(root, '鲸鱼女仆画廊', '_人际日记.md'), `# 人际日记\n> 上次炼化：**${daysAgo(9)}**\n`, 'utf8')

    const r = readForge(root, 7)
    assert.equal(r.items.length, 2)
    assert.equal(r.days, 9, '取最久的那本')
    assert.equal(r.overdue, true, '超过 7 天要标出来')
    assert.equal(r.limit, 7)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('没写「上次炼化」或文件不存在 → 算没记过，算超期', () => {
  const root = makeRoot()
  try {
    writeFileSync(join(root, '_说话.md'), '# 说话\n还没炼过\n', 'utf8')
    const r = readForge(root, 7)
    assert.equal(r.items[0].lastAt, null)
    assert.equal(r.days, null)
    assert.equal(r.overdue, true, '没记过也算超期')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('刚炼过 → 不超期', () => {
  const root = makeRoot()
  try {
    writeFileSync(join(root, '_说话.md'), `# 说话\n> 上次炼化：**${daysAgo(0)}**\n`, 'utf8')
    writeFileSync(join(root, '鲸鱼女仆画廊', '_人际日记.md'), `# 人际日记\n> 上次炼化：**${daysAgo(1)}**\n`, 'utf8')
    const r = readForge(root, 7)
    assert.equal(r.days, 1)
    assert.equal(r.overdue, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
