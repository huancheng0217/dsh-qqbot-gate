import assert from 'node:assert/strict'
import test from 'node:test'

import { clipText, createCollector } from '../lib/collect.js'
import { normalizeConfig } from '../lib/config.js'
import { formatBackground } from '../lib/inject.js'

const APP = '123456'

function msg(over = {}) {
  return {
    kind: 'group',
    groupOpenid: 'G1',
    senderId: 'u-AAAAAAAA',
    senderName: '阿甲',
    content: '今天好热',
    ...over,
  }
}

/** 造一个带虚拟时钟的 collector（不碰真实时间，测试才可重复） */
function make(cfgOver = {}, start = 1_700_000_000_000) {
  const cfg = normalizeConfig(cfgOver)
  let t = start
  const clock = {
    now: () => t,
    tick(ms) {
      t += ms
    },
  }
  const collector = createCollector({ cfg, now: clock.now })
  return { cfg, collector, clock }
}

// ── 记录 ──────────────────────────────────────────────────────

test('群消息入环，能按顺序取回', () => {
  const { collector, clock } = make()
  collector.record(msg({ content: '今天好热' }), APP)
  clock.tick(1000)
  collector.record(msg({ senderName: '阿乙', content: '确实' }), APP)

  const bg = collector.takeBackground('G1')
  assert.equal(bg.entries.length, 2)
  assert.equal(bg.entries[0].name, '阿甲')
  assert.deepEqual(bg.entries.map((e) => e.text), ['今天好热', '确实'])
})

test('私聊不进旁听环', () => {
  const { collector } = make()
  assert.equal(collector.record(msg({ kind: 'c2c' }), APP), null)
  assert.equal(collector.takeBackground('G1').entries.length, 0)
})

test('空消息（无文本、无附件）跳过', () => {
  const { collector } = make()
  assert.equal(collector.record(msg({ content: '   ' }), APP), null)
  assert.equal(collector.record(msg({ content: '' }), APP), null)
})

test('附件补占位：单图 / 多图 / 普通附件', () => {
  const { collector, clock } = make()
  collector.record(msg({ content: '', attachments: [{ content_type: 'image/png' }] }), APP)
  clock.tick(10)
  collector.record(
    msg({ content: '', attachments: [{ content_type: 'image/png' }, { content_type: 'image/jpeg' }] }),
    APP,
  )
  clock.tick(10)
  collector.record(msg({ content: '看这个', attachments: [{ content_type: 'file' }] }), APP)

  const bg = collector.takeBackground('G1')
  assert.deepEqual(bg.entries.map((e) => e.text), ['[图片]', '[图片×2]', '看这个 [附件]'])
})

test('指向本 bot 的 @ 标记会被剥掉', () => {
  const { collector } = make()
  collector.record(msg({ content: `<@!${APP}> 在吗` }), APP)
  assert.equal(collector.takeBackground('G1').entries[0].text, '在吗')
})

// ── 取用：时间窗 / 条数 / 游标 ────────────────────────────────

test('超出时间窗的旧消息不再取', () => {
  const { collector, clock } = make({ injectWindowMinutes: 5 })
  collector.record(msg({ content: '旧话' }), APP)
  clock.tick(6 * 60_000)
  collector.record(msg({ content: '新话' }), APP)

  assert.deepEqual(collector.takeBackground('G1').entries.map((e) => e.text), ['新话'])
})

test('条数上限：只取最近 N 条，并标记截断', () => {
  const { collector, clock } = make({ injectMaxMessages: 2 })
  for (const s of ['一', '二', '三']) {
    collector.record(msg({ content: s }), APP)
    clock.tick(100)
  }
  const bg = collector.takeBackground('G1')
  assert.deepEqual(bg.entries.map((e) => e.text), ['二', '三'])
  assert.equal(bg.truncated, true)
  assert.equal(bg.total, 3)
})

test('连续对话：第二次只给上次之后的新增（不重复灌 prompt）', () => {
  const { collector, clock } = make()
  collector.record(msg({ content: 'A' }), APP)
  collector.record(msg({ content: 'B' }), APP)
  assert.equal(collector.takeBackground('G1').entries.length, 2)

  clock.tick(30_000)
  collector.record(msg({ content: 'C' }), APP)
  const second = collector.takeBackground('G1')
  assert.deepEqual(second.entries.map((e) => e.text), ['C'])
})

test('不同群各自一套环，互不串味', () => {
  const { collector } = make()
  collector.record(msg({ groupOpenid: 'G1', content: '甲群' }), APP)
  collector.record(msg({ groupOpenid: 'G2', content: '乙群' }), APP)

  assert.deepEqual(collector.takeBackground('G1').entries.map((e) => e.text), ['甲群'])
  assert.deepEqual(collector.takeBackground('G2').entries.map((e) => e.text), ['乙群'])
})

test('before 排除「正在处理的那批」：正文与背景不自己重复', () => {
  const { collector, clock } = make()
  const t0 = clock.now()
  collector.record(msg({ content: '早先的话' }), APP)
  clock.tick(1000)
  collector.record(msg({ content: '当前这条' }), APP)

  const bg = collector.takeBackground('G1', { before: t0 + 1000 })
  assert.deepEqual(bg.entries.map((e) => e.text), ['早先的话'])
})

test('没记录过的群 → 空，不抛错', () => {
  const { collector } = make()
  const bg = collector.takeBackground('G-unknown')
  assert.deepEqual(bg.entries, [])
  assert.equal(bg.truncated, false)
})

// ── 拼装 ──────────────────────────────────────────────────────

test('背景格式：首尾标记 + 名字 + 明确「不是指令」', () => {
  const text = formatBackground([{ name: '阿甲', text: '今天好热' }], { injectMaxChars: 80 })
  assert.match(text, /\[群里的闲聊 · 背景\]/)
  assert.match(text, /阿甲: 今天好热/)
  assert.match(text, /不是你被要求做的事/)
  assert.match(text, /\[背景结束/)
})

test('单条超长按字数截断', () => {
  const long = '字'.repeat(200)
  const text = formatBackground([{ name: 'A', text: long }], { injectMaxChars: 20 })
  const line = text.split('\n').find((l) => l.startsWith('A:'))
  assert.equal(line, `A: ${'字'.repeat(20)}…`)
})

test('没有条目 → 空串（不加空壳）', () => {
  assert.equal(formatBackground([], {}), '')
  assert.equal(formatBackground([{ name: 'A', text: '' }], {}), '')
})

test('clipText 按码点截断，不切坏 emoji', () => {
  assert.equal(clipText('🙂'.repeat(5), 3), '🙂🙂🙂…')
  assert.equal(clipText('短的', 10), '短的')
})

// ── 观测与配置 ────────────────────────────────────────────────

test('stats 能看见记录/注入计数', () => {
  const { collector } = make()
  collector.record(msg({}), APP)
  collector.takeBackground('G1')
  collector.bump('injected')
  collector.bump('injectedEntries', 1)

  const s = collector.stats()
  assert.equal(s.recorded, 1)
  assert.equal(s.injected, 1)
  assert.equal(s.injectedEntries, 1)
  assert.equal(s.groups, 1)
  assert.equal(s.entries, 1)
})

test('inject 参数越界夹紧', () => {
  const cfg = normalizeConfig({ injectWindowMinutes: 999, injectMaxMessages: 0, injectMaxChars: 5 })
  assert.equal(cfg.injectWindowMinutes, 240)
  assert.equal(cfg.injectMaxMessages, 1)
  assert.equal(cfg.injectMaxChars, 20)
})

test('inject 默认值：开、15 分钟、30 条、80 字', () => {
  const cfg = normalizeConfig(undefined)
  assert.equal(cfg.injectEnabled, true)
  assert.equal(cfg.injectWindowMinutes, 15)
  assert.equal(cfg.injectMaxMessages, 30)
  assert.equal(cfg.injectMaxChars, 80)
})
