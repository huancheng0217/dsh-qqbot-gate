import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeConfig } from '../lib/config.js'
import { Debouncer } from '../lib/debounce.js'
import { createClock } from './helpers/clock.mjs'

function setup(over = {}) {
  const clock = createClock()
  const cfg = normalizeConfig({ debounceSeconds: 3, maxWaitSeconds: 12, maxMergeMessages: 8, ...over })
  const flushes = []
  const d = new Debouncer({
    cfg,
    appId: '123',
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
    onFlush: (why, batch) => flushes.push({ why, count: batch.count, key: batch.key }),
  })
  return { clock, cfg, flushes, d }
}

test('规则 1：单条消息静默满窗口就收口', async () => {
  const { clock, d, flushes } = setup()
  const p = d.push('k', { text: '你好', senderId: 'A' })
  assert.equal(flushes.length, 0, '还没到点，不能收口')
  clock.advance(3000)
  const r = await p
  assert.equal(r.survivor, true)
  assert.equal(r.merged, '你好')
  assert.equal(flushes.length, 1)
  assert.equal(flushes[0].why, 'quiet')
})

test('规则 1：连发把窗口往后推，中间不收口', async () => {
  const { clock, d, flushes } = setup()
  const p1 = d.push('k', { text: '第一句', senderId: 'A' })
  clock.advance(2000)
  const p2 = d.push('k', { text: '第二句', senderId: 'A' })
  clock.advance(2000)
  assert.equal(flushes.length, 0, '第二次 push 后窗口应重置到 5000')
  clock.advance(1000)
  const r1 = await p1
  const r2 = await p2
  assert.equal(r1.survivor, false, '前一条被吸收')
  assert.equal(r2.survivor, true, '最后一条当幸存者')
  assert.equal(r2.merged, '第一句\n第二句')
  assert.equal(flushes[0].count, 2)
})

test('规则 2：发个不停也会被硬上限强制收口', async () => {
  const { clock, d, flushes } = setup({ debounceSeconds: 1, maxWaitSeconds: 3 })
  const ps = [d.push('k', { text: 'm0', senderId: 'A' })]
  for (let i = 1; i <= 5; i += 1) {
    clock.advance(600)
    ps.push(d.push('k', { text: `m${i}`, senderId: 'A' }))
  }
  const first = flushes[0]
  assert.ok(first, '硬上限到点必须收口')
  assert.equal(first.why, 'max_wait')
  assert.equal(first.count, 5, '到点时手里有 m0..m4 五条')
  const results = await Promise.all(ps.slice(0, 5))
  assert.equal(results.filter((r) => r.survivor).length, 1, '一批只放一条进链')
})

test('规则 3：条数到上限立刻收口（不等计时器）', async () => {
  const { d, flushes } = setup({ maxMergeMessages: 3 })
  const p1 = d.push('k', { text: 'a', senderId: 'A' })
  const p2 = d.push('k', { text: 'b', senderId: 'A' })
  const p3 = d.push('k', { text: 'c', senderId: 'A' })
  assert.equal(flushes.length, 1, '第三条一到就该收口')
  assert.equal(flushes[0].why, 'max_merge')
  const [r1, r2, r3] = await Promise.all([p1, p2, p3])
  assert.deepEqual([r1.survivor, r2.survivor, r3.survivor], [false, false, true])
  assert.equal(r3.merged, 'a\nb\nc')
})

test('规则 4：同人同文本在窗口内只算一条', async () => {
  const { clock, d, flushes } = setup({ dedupeWindowSeconds: 30 })
  const p1 = d.push('k', { text: '复读', senderId: 'A' })
  const p2 = d.push('k', { text: '复读', senderId: 'A' })
  const r2 = await p2
  assert.equal(r2.absorbed, true)
  clock.advance(3000)
  const r1 = await p1
  assert.equal(r1.merged, '复读')
  assert.equal(flushes[0].count, 1)
})

test('不同的人各自成批，互不影响', async () => {
  const { clock, d, flushes } = setup()
  const pa = d.push('group:G:A', { text: '甲说的', senderId: 'A' })
  const pb = d.push('group:G:B', { text: '乙说的', senderId: 'B' })
  clock.advance(3000)
  const ra = await pa
  const rb = await pb
  assert.equal(ra.merged, '甲说的')
  assert.equal(rb.merged, '乙说的')
  assert.equal(flushes.length, 2)
})

test('带图片的消息用更长的等待窗口', async () => {
  const { clock, d, flushes } = setup({ debounceSeconds: 3, imageDebounceSeconds: 8 })
  d.push('k', { text: '看图', senderId: 'A', hasAttachments: true })
  clock.advance(5000)
  assert.equal(flushes.length, 0, '图片窗口还没满')
  clock.advance(3000)
  assert.equal(flushes.length, 1, '满 8 秒才收口')
})

test('卸载时把排队中的消息放出去，不吞用户的话', async () => {
  const { d } = setup()
  const p = d.push('k', { text: '最后一句话', senderId: 'A' })
  d.dispose()
  const r = await p
  assert.equal(r.survivor, true)
  assert.equal(r.merged, '最后一句话')
})

test('sweep 清掉长期挂着的僵尸批', async () => {
  const { clock, d, flushes } = setup()
  d.push('k', { text: 'x', senderId: 'A' })
  clock.advance(30_000)
  // 计时器已经把它收口了；再 sweep 不应该重复收口
  d.sweep()
  assert.equal(flushes.length, 1)
})
