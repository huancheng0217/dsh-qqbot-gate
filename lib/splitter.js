/**
 * splitter.js —— 把一轮回复切成几条发，像人在 QQ 上随手打字。
 *
 * 落点：patch `QQBot.prototype.sendMarkdown`。**装载顺序很重要**：必须装 `installOutGuard()` 之后。
 * patch 是叠加的、后装的包在外面：
 *   splitter（外，切段） → outguard（内，挡内部维护输出） → 原方法（发）
 *
 * **硬约束**：`ReplyLimiter({ limit: 4 })` —— 同一条用户消息最多被动回复 4 次。
 * 一轮切成 N 条 = record N 次，所以默认切 3 条，留一次余量。
 *
 * ── 切分规则（2026-11-11 重写，修「二次切割」）────────────────────
 *
 * 旧实现用一条正则全局匹配，问题是**它会在我已经分好的段落里再切一刀**：
 * 我按段写了「他说『十块。』」，正则在句号处又切一次，引号被劈成两半。
 *
 * 现在的五条规则：
 *   ① **空行是硬边界**：原文用空行分好的段，一段一条，绝不跨段落再切
 *   ② **切点优先级**：句末（。！？…~?!）> 分号 > 逗号，其他位置一律不切；
 *      只在「有句末标点」时按句末切，没有才降级用分号、逗号
 *   ③ **配对保护**：扫描时维护引号/括号深度，没配对的内部不是切点
 *   ④ **最短段**：不足 `minSegmentLength` 字的并进相邻段（免得「（顿了顿）」单独成条）
 *   ⑤ **条数上限**：超了就前 N-1 条各一，剩下全并进最后一条，一个字都不丢
 */

export const DEFAULTS = {
  enabled: false, // 先关着，主人亲手打开
  mode: 'group', // off | group | all
  maxSegments: 3,
  minSegmentLength: 12,
  delayMs: 300,
  skipIfShorterThan: 20,
  skipCodeAndTables: true,
}

/** 左字符 → 右边该出现的配对字符 */
const OPEN_TO_CLOSE = { '「': '」', '『': '』', '“': '”', '‘': '’', '（': '）', '(': ')', '【': '】', '[': ']' }
const CLOSERS = new Set(Object.values(OPEN_TO_CLOSE))

const TIER1 = new Set([...'。！？…~?!']) // 句末
const TIER2 = new Set([...'；;']) // 分号
const TIER3 = new Set([...'，,、']) // 逗号

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 找出所有「可以切」的位置（返回切点在标点**之后**的索引），并标它属于哪一级。
 *
 * 配对保护：扫描时维护一个「期待闭字符」的栈，栈非空说明当前在引号/括号内部，
 * 那里一律不算切点。所以「他说『十块。』」里的句号不会被当成切点。
 *
 * @param {string} text
 * @returns {Array<{at: number, tier: number}>}
 */
export function findCutPoints(text) {
  const stack = []
  const out = []
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]

    const closer = OPEN_TO_CLOSE[ch]
    if (closer) {
      stack.push(closer)
      continue
    }
    if (CLOSERS.has(ch) && stack.length > 0 && stack[stack.length - 1] === ch) {
      stack.pop()
      continue
    }
    if (stack.length > 0) continue // 在配对内部 → 不是切点

    let tier = 0
    if (TIER1.has(ch)) tier = 1
    else if (TIER2.has(ch)) tier = 2
    else if (TIER3.has(ch)) tier = 3
    if (!tier) continue

    // 连续标点（「？！」「……」）并成一处，切在最后一个标点后面
    const at = i + 1
    const last = out[out.length - 1]
    if (last && last.at === i) out[out.length - 1] = { at, tier }
    else out.push({ at, tier })
  }
  return out
}

/** 按切点把文本切开，保证拼回去与原文完全一致 */
function sliceByPoints(text, points) {
  const out = []
  let prev = 0
  for (const p of points) {
    if (p.at <= prev) continue
    out.push(text.slice(prev, p.at))
    prev = p.at
  }
  if (prev < text.length) out.push(text.slice(prev))
  return out.filter((s) => s.length > 0)
}

/**
 * 按标点优先级切：有句末标点就只按句末切，没有才降级用分号、再降级用逗号。
 * 一级都找不到就整段不切。
 */
export function splitByPunctuation(text) {
  const points = findCutPoints(text)
  if (points.length === 0) return [text]
  for (const tier of [1, 2, 3]) {
    const tierPoints = points.filter((p) => p.tier === tier)
    if (tierPoints.length > 0) return sliceByPoints(text, tierPoints)
  }
  return [text]
}

/** 过短的段并进相邻段：优先并进前一段，第一段太短就并进后一段 */
function mergeShort(parts, minLen) {
  const out = []
  for (let i = 0; i < parts.length; i += 1) {
    const p = parts[i]
    if (p.length < minLen) {
      if (out.length > 0) {
        out[out.length - 1] += p
        continue
      }
      if (i + 1 < parts.length) {
        parts[i + 1] = p + parts[i + 1]
        continue
      }
    }
    out.push(p)
  }
  return out
}

/**
 * 纯函数：把一段文本切成若干段。**不切时返回 null**（调用方据此退回整段发送）。
 *
 * @param {string} text
 * @param {object} [opts]
 * @returns {string[]|null}
 */
export function splitText(text, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts }
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return null
  if (trimmed.length < cfg.skipIfShorterThan) return null

  if (cfg.skipCodeAndTables) {
    if (trimmed.includes('```')) return null // 代码块切开会散架
    if (/^\s*\|.*\|\s*$/m.test(trimmed)) return null // 表格同理
  }

  const cap = Math.max(1, Math.min(4, Math.round(Number(cfg.maxSegments) || 3)))

  // ① 空行是硬边界：原文分好的段，一段一条
  const blocks = trimmed.split(/\n[ \t]*\n/).map((b) => b.trim()).filter(Boolean)
  const byBlankLine = blocks.length > 1
  let parts = byBlankLine ? blocks : splitByPunctuation(trimmed)

  if (parts.length <= 1) return null

  // ④ 过短的段并进相邻段。
  // **只对「按标点切出来的段」生效**：空行分段是作者自己的意图，短也是有意为之，
  // 再按字数合并就又把他的排版抹平了（2026-11-11 实测：两段各 8 字会被并成一段，整条不切）。
  if (!byBlankLine) parts = mergeShort(parts, cfg.minSegmentLength)

  // ⑤ 超上限：前 N-1 条各一，剩下全并进最后一条
  if (parts.length > cap) {
    // 按空行分的用 \n\n 合，保持段落感；按标点分的本来就连续，直接拼
    const joiner = byBlankLine ? '\n\n' : ''
    const head = parts.slice(0, cap - 1)
    const tail = parts.slice(cap - 1).join(joiner)
    parts = [...head, tail]
  }

  return parts.length > 1 ? parts : null
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
