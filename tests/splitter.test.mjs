import { test } from 'node:test'
import assert from 'node:assert'
import { splitText, DEFAULT_PATTERN, DEFAULTS, installSplitter } from '../lib/splitter.js'

// 默认配置会把短句合并（minSegmentLength=6），多数用例要关掉它才好验证切分本身
const base = { ...DEFAULTS, skipIfShorterThan: 1, minSegmentLength: 1 }

test('按标点切成三段', () => {
  const segs = splitText('今天群里好热闹。有人发了个新作。我看了一下。', base)
  assert.deepEqual(segs, ['今天群里好热闹。', '有人发了个新作。', '我看了一下。'])
})

test('短于 skipIfShorterThan 不切', () => {
  assert.equal(splitText('好的。', { ...base, skipIfShorterThan: 20 }), null)
})

test('没有标点不切', () => {
  assert.equal(splitText('这一句话没有任何结尾标点', base), null)
})

test('超过上限时尾巴并进最后一条且不丢字', () => {
  const src = '一。二。三。四。五。六。'
  const segs = splitText(src, { ...base, maxSegments: 3 })
  assert.equal(segs.length, 3)
  assert.equal(segs.join(''), src)
  assert.equal(segs[0], '一。')
  assert.equal(segs[1], '二。')
  assert.equal(segs[2], '三。四。五。六。')
})

test('上限压到 4 也不超过 ReplyLimiter', () => {
  const src = '一。二。三。四。五。六。七。'
  const segs = splitText(src, { ...base, maxSegments: 4 })
  assert.ok(segs.length <= 4)
  assert.equal(segs.join(''), src)
})

test('短段并进前一段（防「嗯。」单独一条）', () => {
  const segs = splitText('今天天气不错。嗯。我们出去走走吧。', { ...base, minSegmentLength: 6 })
  assert.ok(segs.length <= 2, `期望合并后不超过 2 段，实际 ${JSON.stringify(segs)}`)
  assert.equal(segs.join(''), '今天天气不错。嗯。我们出去走走吧。')
})

test('第一段太短则并进后一段', () => {
  const segs = splitText('嗯。我们出去走走吧。', { ...base, minSegmentLength: 6 })
  // 只有两段且第一段短 → 合并成一段 → 返回 null（不切）
  assert.equal(segs, null)
})

test('含代码块不切', () => {
  const src = '看这个：\n```js\nconsole.log(1)\n```\n就这样。'
  assert.equal(splitText(src, base), null)
})

test('含表格不切', () => {
  const src = '结果如下：\n| a | b |\n| --- | --- |\n完了。'
  assert.equal(splitText(src, base), null)
})

test('关掉代码表格保护后照切', () => {
  const src = '看这个。\n```js\nx\n```\n就这样。'
  assert.notEqual(splitText(src, { ...base, skipCodeAndTables: false }), null)
})

test('坏正则会退回不切而不是抛错', () => {
  assert.equal(splitText('一二三。四五六。', { ...base, pattern: '(' }), null)
})

test('问号叹号省略号波浪号都算标点', () => {
  // 四句 → 默认上限 3 会把尾巴合并，所以这里放到 4 来验证四种标点都被识别
  const segs = splitText('真的吗？太好了！等等……好吧~', { ...base, maxSegments: 4 })
  assert.ok(segs)
  assert.equal(segs.length, 4)
  assert.deepEqual(segs, ['真的吗？', '太好了！', '等等……', '好吧~'])
})

test('默认正则是风言枫语那条 + 换行符（换行不是装饰，见下一条）', () => {
  assert.equal(DEFAULT_PATTERN, String.raw`.*?[。？！~…\n]+|.+$`)
})

test('回归：切分正则不能丢内容（没有标点的整行曾经会被整行吞掉）', () => {
  // `String.match(re, 'g')` 只返回匹配到的片段，没匹配上的直接被丢掉。
  // 旧正则 `.` 不匹配换行 → 一行没标点就匹配不上 → 整行消失。
  const samples = [
    '第一段没有标点\n第二段有句号。第三段也没标点',
    '重新排版：\n题｜同一句玩笑\n句式是变体\n① 晚安，祝能梦到电子饭',
    '第一句是祝。他知道我做不到，还是祝了。\n第二句是在追。',
    '末尾有换行\n',
  ]
  for (const text of samples) {
    const parts = text.match(new RegExp(DEFAULT_PATTERN, 'g')) ?? []
    assert.equal(parts.join(''), text, `内容被丢掉了: ${JSON.stringify(text)}`)
  }
})

test('默认关：装上但纯透传（开关能热生效的前提）', async () => {
  const calls = []
  const proto = {
    sendMarkdown: async (target, content) => {
      calls.push(content)
      return { ok: true }
    },
  }
  const r = installSplitter(proto, { enabled: false })
  assert.equal(r.ok, true) // 装上了，只是不开
  assert.equal(proto.sendMarkdown.__qgateSplit, true)
  await proto.sendMarkdown({ scope: 'group' }, '第一句。第二句。第三句。')
  assert.equal(calls.length, 1)
  assert.equal(calls[0], '第一句。第二句。第三句。')
})

test('enabled 走 getter：运行中打开就立刻生效', async () => {
  const calls = []
  const proto = {
    sendMarkdown: async (target, content) => {
      calls.push(content)
      return { ok: true }
    },
  }
  let live = { enabled: false, mode: 'group', delayMs: 0, skipIfShorterThan: 1, minSegmentLength: 1 }
  installSplitter(proto, () => live)

  await proto.sendMarkdown({ scope: 'group' }, '第一句。第二句。第三句。')
  assert.equal(calls.length, 1, '关着时应整段发')

  live = { ...live, enabled: true } // 模拟设置页打开开关
  await proto.sendMarkdown({ scope: 'group' }, '第一句。第二句。第三句。')
  assert.equal(calls.length, 4, '打开后应切成 3 条')
})

test('装好后按段调用原方法', async () => {
  const calls = []
  const proto = {
    sendMarkdown: async (target, content) => {
      calls.push(content)
      return { ok: true, content }
    },
  }
  installSplitter(proto, { ...base, enabled: true, mode: 'group', delayMs: 0 }, () => {}, {})
  await proto.sendMarkdown({ scope: 'group' }, '第一句。第二句。第三句。')
  assert.deepEqual(calls, ['第一句。', '第二句。', '第三句。'])
})

test('mode=group 时私聊不切', async () => {
  const calls = []
  const proto = {
    sendMarkdown: async (target, content) => {
      calls.push(content)
      return {}
    },
  }
  installSplitter(proto, { ...base, enabled: true, mode: 'group', delayMs: 0 }, () => {}, {})
  await proto.sendMarkdown({ scope: 'c2c' }, '第一句。第二句。第三句。')
  assert.equal(calls.length, 1)
  assert.equal(calls[0], '第一句。第二句。第三句。')
})

test('mode=all 时私聊也切', async () => {
  const calls = []
  const proto = {
    sendMarkdown: async (target, content) => {
      calls.push(content)
      return {}
    },
  }
  installSplitter(proto, { ...base, enabled: true, mode: 'all', delayMs: 0 }, () => {}, {})
  await proto.sendMarkdown({ scope: 'c2c' }, '第一句。第二句。第三句。')
  assert.equal(calls.length, 3)
})

test('原方法抛错时退回整段重发', async () => {
  let attempt = 0
  const calls = []
  const proto = {
    sendMarkdown: async (target, content) => {
      attempt += 1
      calls.push(content)
      if (attempt === 2) throw new Error('boom')
      return {}
    },
  }
  installSplitter(proto, { ...base, enabled: true, mode: 'group', delayMs: 0 }, () => {}, {})
  await proto.sendMarkdown({ scope: 'group' }, '第一句。第二句。第三句。')
  // 第一条成功、第二条失败 → catch 里退回整段
  assert.equal(calls[calls.length - 1], '第一句。第二句。第三句。')
})
