/**
 * splitter.js —— 按标点把一轮回复切成几条发，像人在 QQ 上随手打字。
 *
 * 落点：patch `QQBot.prototype.sendMarkdown`。官方 outbound 把整轮回复拼成一段再发，
 * 这里在它下面再切一刀。
 *
 * **装载顺序很重要**：必须装 `installOutGuard()` **之后**。
 * patch 是叠加的、后装的包在外面，所以顺序应当是
 *   splitter（外，按标点切） → outguard（内，挡内部维护输出） → 原方法（发）
 * 反过来先 splitter 后 outguard，过滤会先看到整段长文，命中就整条吞掉，分段没机会。
 *
 * **硬约束**：`ReplyLimiter({ limit: 4 })` —— 同一条用户消息最多被动回复 4 次。
 * 一轮切成 N 条 = record N 次，所以默认切 3 条，留一次余量。
 */

/**
 * 默认切分正则：风言枫语给的那条 + 换行符。
 *
 * **`\n` 不是装饰，是修 bug**：`String.match(re, 'g')` 只返回匹配到的片段，
 * 没被匹配的内容会被直接丢掉。原来的 `.*?[。？！~…]+|.+$` 里 `.` 不匹配换行，
 * 所以「一行没有标点」的行匹配不上 → 整行消失，只剩后面有标点的部分。
 * 实测 5 个样本 4 个丢内容，最长的一次把开头整段吞掉。
 * 把 `\n` 放进字符类后，每一行都有一个终止符，拼回来与原文完全一致。
 */
export const DEFAULT_PATTERN = String.raw`.*?[。？！~…\n]+|.+$`

export const DEFAULTS = {
  enabled: false, // 先关着，主人亲手打开
  mode: 'group', // off | group | all
  pattern: DEFAULT_PATTERN,
  maxSegments: 3,
  minSegmentLength: 6,
  delayMs: 300,
  skipIfShorterThan: 20,
  skipCodeAndTables: true,
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 纯函数：把一段文本切成若干段。**不切时返回 null**（调用方据此退回整段发送）。
 *
 * @param {string} text
 * @param {object} [opts]
 * @returns {string[]|null}
 */
export function splitText(text, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts }
  const s = String(text ?? '')
  const trimmed = s.trim()
  if (!trimmed) return null
  if (trimmed.length < cfg.skipIfShorterThan) return null

  if (cfg.skipCodeAndTables) {
    if (trimmed.includes('```')) return null // 代码块切开会散架
    if (/^\s*\|.*\|\s*$/m.test(trimmed)) return null // 表格同理
  }

  let parts
  try {
    const re = new RegExp(cfg.pattern, 'g')
    parts = trimmed.match(re) ?? [trimmed]
  } catch {
    return null // 配置里的正则写坏了，退回整段
  }

  parts = parts.map((p) => p.trim()).filter(Boolean)
  if (parts.length <= 1) return null

  // 合并过短的段：能并进前一段就并，第一段太短就并进后一段，实在没得并就留着
  const merged = []
  for (let i = 0; i < parts.length; i += 1) {
    const p = parts[i]
    if (p.length < cfg.minSegmentLength) {
      if (merged.length > 0) {
        merged[merged.length - 1] += p
        continue
      }
      if (i + 1 < parts.length) {
        parts[i + 1] = p + parts[i + 1]
        continue
      }
    }
    merged.push(p)
  }

  if (merged.length <= 1) return null

  // 超过上限：尾巴全部并进最后一条，一个字都不能丢
  const cap = Math.max(1, Math.min(4, Math.round(Number(cfg.maxSegments) || 3)))
  if (merged.length > cap) {
    const head = merged.slice(0, cap - 1)
    const tail = merged.slice(cap - 1).join('')
    return [...head, tail]
  }
  return merged
}

/**
 * 装到原型上。
 *
 * **不在安装时检查 enabled**：装上之后每次调用都重新读配置，
 * 这样在设置页开关「分段发送」立刻生效，不用重载插件（关着就是纯透传）。
 *
 * @param {object} proto QQBot.prototype
 * @param {object|(() => object)} cfgOrGetter 配置对象，或每次返回最新配置的函数
 * @param {(msg:string)=>void} [log]
 * @param {object} [state] 共享状态，用来计数
 */
export function installSplitter(proto, cfgOrGetter, log = () => {}, state = {}) {
  if (!proto) return { ok: false, error: 'no-proto' }

  const getCfg = typeof cfgOrGetter === 'function' ? cfgOrGetter : () => cfgOrGetter ?? {}

  const orig = proto.sendMarkdown
  if (typeof orig !== 'function') return { ok: false, error: 'no-sendMarkdown' }
  if (orig.__qgateSplit) return { ok: true, already: true }

  const patched = async function sendMarkdownSplit(target, content, ...rest) {
    let cfg
    try {
      cfg = { ...DEFAULTS, ...(getCfg() ?? {}) }
    } catch {
      cfg = { ...DEFAULTS }
    }

    // 关着 / 不切 → 纯透传，行为跟没装一样
    if (cfg.enabled !== true || cfg.mode === 'off') return orig.call(this, target, content, ...rest)

    const opts = {
      pattern: typeof cfg.pattern === 'string' && cfg.pattern ? cfg.pattern : DEFAULTS.pattern,
      maxSegments: cfg.maxSegments ?? DEFAULTS.maxSegments,
      minSegmentLength: cfg.minSegmentLength ?? DEFAULTS.minSegmentLength,
      delayMs: cfg.delayMs ?? DEFAULTS.delayMs,
      skipIfShorterThan: cfg.skipIfShorterThan ?? DEFAULTS.skipIfShorterThan,
      skipCodeAndTables: cfg.skipCodeAndTables ?? DEFAULTS.skipCodeAndTables,
    }

    try {
      const scope = target && typeof target === 'object' ? target.scope : ''
      if (cfg.mode === 'group' && scope !== 'group') return orig.call(this, target, content, ...rest)

      const segs = splitText(content, opts)
      if (!segs || segs.length <= 1) return orig.call(this, target, content, ...rest)

      let last
      let sent = 0
      for (let i = 0; i < segs.length; i += 1) {
        if (i > 0 && opts.delayMs > 0) await sleep(opts.delayMs)
        last = await orig.call(this, target, segs[i], ...rest)
        sent += 1
      }
      state.splitRounds = (state.splitRounds ?? 0) + 1
      state.splitSegments = (state.splitSegments ?? 0) + sent
      state.lastSplitAt = Date.now()
      state.lastSplitCount = segs.length
      log(`[splitter] 切成 ${segs.length} 条发出`)
      return last
    } catch (err) {
      // 切分或中途失败：退回整段，宁可难看也别丢话
      try {
        log(`[splitter] 出错了，退回整段: ${err && err.message ? err.message : String(err)}`)
      } catch {
        /* ignore */
      }
      state.splitErrors = (state.splitErrors ?? 0) + 1
      return orig.call(this, target, content, ...rest)
    }
  }
  patched.__qgateSplit = true
  proto.sendMarkdown = patched

  return { ok: true }
}
