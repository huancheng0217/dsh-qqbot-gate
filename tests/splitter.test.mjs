import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULTS, findCutPoints, installSplitter, splitByPunctuation, splitText } from '../lib/splitter.js'

/** 测试里放宽门槛，单独验证切分逻辑本身 */
const loose = { skipIfShorterThan: 1, minSegmentLength: 4, maxSegments: 4, skipCodeAndTables: true }

const norm = (s) => String(s ?? '').replace(/\s+/g, '')

// ── 规则 ①：空行是硬边界 ─────────────────────────────────
test('空行是硬边界：段落内部不再切', () => {
  const t = '第一段有句子。还有一句。\n\n第二段也有一句。'
  const segs = splitText(t, loose)
  assert.deepEqual(segs, ['第一段有句子。还有一句。', '第二段也有一句。'])
})

test('空行分段数量不超过上限时，一段一条', () => {
  const t = '甲段内容够长了。\n\n乙段内容也够长了。\n\n丙段同理。'
  const segs = splitText(t, { ...loose, maxSegments: 3 })
  assert.deepEqual(segs, ['甲段内容够长了。', '乙段内容也够长了。', '丙段同理。'])
})

test('空行段数超过上限：前 N-1 各一条，剩余并进最后一条', () => {
  const t = '一号够长了。\n\n二号够长了。\n\n三号够长了。\n\n四号够长了。'
  const segs = splitText(t, { ...loose, maxSegments: 3 })
  assert.equal(segs.length, 3)
  assert.equal(segs[0], '一号够长了。')
  assert.match(segs[2], /三号够长了。[\s\S]*四号够长了。/)
})

// ── 规则 ②：切点优先级 ───────────────────────────────────
test('有句末标点时只按句末切，不碰逗号', () => {
  const t = '第一句很短，但有逗号。第二句也是，同样有逗号。'
  const segs = splitText(t, loose)
  assert.deepEqual(segs, ['第一句很短，但有逗号。', '第二句也是，同样有逗号。'])
})

test('没有句末标点才降级用分号', () => {
  const t = '前半句甲；后半句乙；再来一段丙'
  const segs = splitText(t, loose)
  assert.deepEqual(segs, ['前半句甲；', '后半句乙；', '再来一段丙'])
})

test('连分号都没有才用逗号', () => {
  const t = '甲甲甲，乙乙乙，丙丙丙'
  const segs = splitText(t, { ...loose, minSegmentLength: 1 })
  assert.deepEqual(segs, ['甲甲甲，', '乙乙乙，', '丙丙丙'])
})

test('一个标点都没有就不切', () => {
  assert.equal(splitText('一二三四五六七八九十十一十二', loose), null)
})

test('连续标点算一处切点（「？！」不切两刀）', () => {
  const t = '真的吗？！我想想。再说吧。'
  const segs = splitText(t, loose)
  assert.deepEqual(segs, ['真的吗？！', '我想想。', '再说吧。'])
})

// ── 规则 ③：配对保护 ─────────────────────────────────────
test('引号里的句号不是切点（「十块。」不会被劈开）', () => {
  const t = '他说「十块。」我点头。然后我们都笑了。'
  const segs = splitText(t, loose)
  assert.deepEqual(segs, ['他说「十块。」我点头。', '然后我们都笑了。'])
})

test('括号里的标点也不切', () => {
  const t = '他停顿了一下（其实就是顿了顿。）然后继续。后面还有一句。'
  const segs = splitText(t, loose)
  assert.deepEqual(segs, ['他停顿了一下（其实就是顿了顿。）然后继续。', '后面还有一句。'])
})

test('findCutPoints 在配对内部不返回切点', () => {
  // 引号里的两个句号跳过，只有最后一个句号是切点（at 指向标点之后）
  assert.deepEqual(findCutPoints('「甲。乙。」丙。').map((p) => p.at), [8])
  // 引号压根没配对时整段都不切——保守：不确定就不动刀
  assert.deepEqual(findCutPoints('「甲。乙。'), [])
})

// ── 规则 ④：最短段合并 ───────────────────────────────────
test('空行分段的短段不会被字数合并（作者排版优先）', () => {
  // 2026-11-11 修：这两段各 8 字，minSegmentLength=20 时旧实现会把它们并成一段，整条不切
  const t = '第一段我说完了。\n\n第二段也写完了。'
  const segs = splitText(t, { ...loose, minSegmentLength: 20 })
  assert.deepEqual(segs, ['第一段我说完了。', '第二段也写完了。'])
})

test('过短的段并进相邻段，不单独成条', () => {
  // 「好。」只有 2 字，会被并走；并完只剩一段 → 不切
  assert.equal(splitText('好。这是一段足够长的话。', { ...loose, minSegmentLength: 12 }), null)
})

test('中间的短段并进前一段', () => {
  const t = '这是一段很长很长的开头。嗯。这是结尾的另一段话而且它也足够长。'
  const segs = splitText(t, { ...loose, minSegmentLength: 12 })
  assert.deepEqual(segs, ['这是一段很长很长的开头。嗯。', '这是结尾的另一段话而且它也足够长。'])
})

// ── 规则 ⑤：条数上限 ─────────────────────────────────────
test('超过上限的部分并进最后一条', () => {
  const t = '第一句在这里。第二句在这里。第三句在这里。第四句在这里。'
  const segs = splitText(t, { ...loose, maxSegments: 3 })
  assert.equal(segs.length, 3)
  assert.equal(segs[2], '第三句在这里。第四句在这里。')
})

test('上限被夹在 1..4', () => {
  const t = '甲。乙。丙。丁。戊。己。'
  const segs = splitText(t, { ...loose, minSegmentLength: 1, maxSegments: 99 })
  assert.equal(segs.length, 4)
})

// ── 不丢字 ──────────────────────────────────────────────
test('切分不丢字：去掉空白后与原文一致', () => {
  const samples = [
    '第一段没标点\n第二段有句号。第三段也没标点',
    '他说「十块。」我点头。然后我们都笑了。',
    '甲段内容。\n\n乙段内容。\n\n丙段内容。\n\n丁段内容。',
    '一整段完全没有句号只有逗号，这样，那样，最后结束',
  ]
  for (const t of samples) {
    const segs = splitText(t, { ...loose, minSegmentLength: 1 })
    const joined = (segs ?? [t]).join('')
    assert.equal(norm(joined), norm(t), `丢了内容: ${JSON.stringify(t)}`)
  }
})

// ── 不该切的情况 ─────────────────────────────────────────
test('太短不切', () => {
  assert.equal(splitText('短。', { ...loose, skipIfShorterThan: 20 }), null)
})

test('含代码块不切', () => {
  assert.equal(splitText('看这个。\n```js\nconst a = 1。\n```\n完了。', loose), null)
})

test('含表格不切', () => {
  assert.equal(splitText('表格如下。\n| a | b |\n|---|---|\n| 1 | 2 |\n结束。', loose), null)
})

test('关掉代码表格保护后照切', () => {
  const segs = splitText('看这个。\n```js\nconst a = 1。\n```\n完了。', { ...loose, skipCodeAndTables: false })
  assert.ok(segs && segs.length > 1)
})

test('空文本返回 null', () => {
  assert.equal(splitText('', loose), null)
  assert.equal(splitText('   ', loose), null)
})

// ── 默认值 ──────────────────────────────────────────────
test('默认最短段是 12 字、条数上限 3', () => {
  assert.equal(DEFAULTS.minSegmentLength, 12)
  assert.equal(DEFAULTS.maxSegments, 3)
})

// ── installSplitter ─────────────────────────────────────
function fakeProto(record) {
  return {
    sendMarkdown: async (target, content) => {
      record.push(content)
      return { ok: true }
    },
  }
}

test('默认关：装上但纯透传', async () => {
  const calls = []
  const proto = fakeProto(calls)
  const r = installSplitter(proto, { enabled: false })
  assert.equal(r.ok, true)
  assert.equal(proto.sendMarkdown.__qgateSplit, true)
  await proto.sendMarkdown({ scope: 'group' }, '第一句。第二句。')
  assert.equal(calls.length, 1)
})

test('enabled 走 getter：运行中打开就立刻生效', async () => {
  const calls = []
  const proto = fakeProto(calls)
  let cfg = { enabled: false, mode: 'all', minSegmentLength: 1, maxSegments: 4, skipIfShorterThan: 1 }
  installSplitter(proto, () => cfg)
  await proto.sendMarkdown({ scope: 'group' }, '第一句。第二句。')
  assert.equal(calls.length, 1)
  cfg = { ...cfg, enabled: true }
  await proto.sendMarkdown({ scope: 'group' }, '第一句。第二句。')
  assert.equal(calls.length, 3)
})

test('装好后按段调用原方法', async () => {
  const calls = []
  const proto = fakeProto(calls)
  installSplitter(proto, { enabled: true, mode: 'all', minSegmentLength: 1, maxSegments: 4, skipIfShorterThan: 1, delayMs: 0 })
  await proto.sendMarkdown({ scope: 'group' }, '甲句。乙句。')
  assert.deepEqual(calls, ['甲句。', '乙句。'])
})

test('mode=group 时私聊不切', async () => {
  const calls = []
  const proto = fakeProto(calls)
  installSplitter(proto, { enabled: true, mode: 'group', minSegmentLength: 1, maxSegments: 4, skipIfShorterThan: 1, delayMs: 0 })
  await proto.sendMarkdown({ scope: 'c2c' }, '甲句。乙句。')
  assert.equal(calls.length, 1)
})

test('mode=all 时私聊也切', async () => {
  const calls = []
  const proto = fakeProto(calls)
  installSplitter(proto, { enabled: true, mode: 'all', minSegmentLength: 1, maxSegments: 4, skipIfShorterThan: 1, delayMs: 0 })
  await proto.sendMarkdown({ scope: 'c2c' }, '甲句。乙句。')
  assert.equal(calls.length, 2)
})

test('原方法抛错时退回整段重发', async () => {
  const calls = []
  let first = true
  const proto = {
    sendMarkdown: async (_t, content) => {
      calls.push(content)
      if (first) {
        first = false
        throw new Error('boom')
      }
      return { ok: true }
    },
  }
  installSplitter(proto, { enabled: true, mode: 'all', minSegmentLength: 1, maxSegments: 4, skipIfShorterThan: 1, delayMs: 0 })
  await proto.sendMarkdown({ scope: 'group' }, '甲句。乙句。')
  assert.equal(calls[calls.length - 1], '甲句。乙句。')
})

// ── splitByPunctuation 单独测 ───────────────────────────
test('splitByPunctuation 优先句末、其次分号、最后逗号', () => {
  assert.deepEqual(splitByPunctuation('甲。乙'), ['甲。', '乙'])
  assert.deepEqual(splitByPunctuation('甲；乙'), ['甲；', '乙'])
  assert.deepEqual(splitByPunctuation('甲，乙'), ['甲，', '乙'])
  assert.deepEqual(splitByPunctuation('甲乙丙'), ['甲乙丙'])
})
