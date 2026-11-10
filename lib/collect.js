/**
 * 旁听环 —— 记住「没叫我的那段时间」群里在聊什么。
 *
 * 为什么需要：dsh-qqbot 只在 `wasMentioned` 时把群历史注入 agent
 * （`inbound.js:209` → `if (!isGroup || !wasMentioned || !history) return base`）。
 * 群门槛把消息挡下之后，agent 那头是一片空白 —— 接话就只能靠猜，
 * 而且看起来像「突然插嘴」。
 *
 * 本模块在链头（index 0）把每条群消息记一份（包括后面会被门槛挡下的那些），
 * 等真的被叫醒时再拼成背景交给 inject.js。
 *
 * 三条设计约束：
 *   1. **纯内存、纯数据、零 I/O**：不落盘（落盘属于采集那块），不 await 任何东西，
 *      不能让它拖慢消息链路。
 *   2. **不判断内容好坏**：机器判不了「哪句有意思」，这里只负责记住，
 *      判断权留给模型。
 *   3. **状态属于中间件闭包**：热重载会丢，可接受（重载不频繁，丢的只是十几分钟的闲聊）。
 */

import { groupIdOf, stripMention } from './merge.js'

/** 每群条数硬上限：超出按最旧的丢，防止内存无界 */
const HARD_CAP_PER_GROUP = 200

/** 单条入库时的截断上限（注入时还会按 injectMaxChars 再截一次） */
const ENTRY_CLIP = 200

/**
 * 按码点截断，避免把 emoji / 代理对切成乱码。
 * @param {string} text
 * @param {number} max
 */
export function clipText(text, max) {
  const s = String(text ?? '')
  const n = Math.max(1, Math.floor(Number(max) || 1))
  if (s.length <= n) return s
  const chars = Array.from(s)
  if (chars.length <= n) return s
  return `${chars.slice(0, n).join('')}…`
}

/** 附件占位：让模型知道这条带了图，而不是「什么都没说」 */
function mediaTag(msg) {
  const list = Array.isArray(msg?.attachments) ? msg.attachments : []
  if (list.length === 0) return null
  const images = list.filter((a) => String(a?.content_type ?? '').includes('image')).length
  if (images === 0) return '[附件]'
  if (images === list.length) return images === 1 ? '[图片]' : `[图片×${images}]`
  return '[图片+附件]'
}

/** 发送者显示名：有昵称用昵称，没有就用 openid 前 8 位 */
function senderLabel(msg) {
  const name = String(msg?.senderName ?? '').trim()
  if (name) return name
  const id = String(msg?.senderId ?? '').trim()
  return id ? id.slice(0, 8) : '某人'
}

/** 一条入站消息 → 一行可读文本（去 @、压空白、补媒体占位） */
function entryText(msg, appId) {
  const text = stripMention(msg?.content ?? '', appId)
  const media = mediaTag(msg)
  if (!text) return media ?? ''
  return media ? `${text} ${media}` : text
}

/**
 * @param {{ cfg?: object, now?: () => number }} [options]
 *   cfg 是**引用**，热更新后新参数立刻生效（与 createMiddleware 里其他部分一致）。
 */
export function createCollector(options = {}) {
  const cfg = options.cfg ?? {}
  const now = options.now ?? (() => Date.now())

  /** groupKey → { seq, entries: Entry[], lastInjectAt: number, lastInjectSeq: number } */
  const rings = new Map()

  /** 累计观测（给日志/状态文件用，不参与判定） */
  const counters = { recorded: 0, injected: 0, injectedEntries: 0, truncated: 0 }

  function ringOf(key) {
    let ring = rings.get(key)
    if (!ring) {
      ring = { seq: 0, entries: [], lastInjectAt: Number.NEGATIVE_INFINITY, lastInjectSeq: 0 }
      rings.set(key, ring)
    }
    return ring
  }

  /** 按时间窗 + 条数硬上限裁掉旧条目（就地修改） */
  function trim(ring, t) {
    const minutes = Math.max(1, Number(cfg.injectWindowMinutes) || 15)
    const horizon = t - minutes * 60_000
    let cut = 0
    while (cut < ring.entries.length && ring.entries[cut].ts < horizon) cut += 1
    if (cut > 0) ring.entries.splice(0, cut)
    const over = ring.entries.length - HARD_CAP_PER_GROUP
    if (over > 0) ring.entries.splice(0, over)
  }

  /**
   * 记一条群消息。非群消息、空消息直接忽略。
   * @returns {object|null} 入库的条目（测试用；生产路径不关心返回值）
   */
  function record(msg, appId) {
    if (msg?.kind !== 'group') return null
    const key = groupIdOf(msg)
    if (!key) return null
    const text = entryText(msg, appId)
    if (!text) return null

    const t = now()
    const ring = ringOf(key)
    ring.seq += 1
    const entry = { seq: ring.seq, ts: t, name: senderLabel(msg), text: clipText(text, ENTRY_CLIP) }
    ring.entries.push(entry)
    trim(ring, t)
    counters.recorded += 1
    return entry
  }

  /**
   * 取「这次该当背景讲给模型听」的条目。
   *
   * 三条规则叠加：
   *   - 时间窗 / 条数上限：只看最近 injectWindowMinutes 内的，最多 injectMaxMessages 条
   *   - **before**：只取早于这个时间戳的条目 —— 用来把「正在处理的这一批」排掉，
   *     否则背景里会出现一遍、正文里又出现一遍（自己重复自己）
   *   - 游标：如果上次注入还在同一个时间窗里（说明是连续对话），只给之后的新增，
   *     避免每轮都把同一段闲聊重复塞进 prompt
   *
   * 副作用：推进该群的游标。**调用即视为「窗口内的内容模型已经见过了」**——
   * 这一批在正文里，更早的在背景里（或被条数上限丢掉，不该反复灌）。
   *
   * @param {string} key 群标识
   * @param {{ now?: number, before?: number }} [opts]
   * @returns {{ entries: object[], total: number, truncated: boolean }}
   */
  function takeBackground(key, opts = {}) {
    const empty = { entries: [], total: 0, truncated: false }
    const ring = rings.get(key)
    if (!ring || ring.entries.length === 0) return empty

    const t = opts.now ?? now()
    const before = Number.isFinite(opts.before) ? opts.before : Number.POSITIVE_INFINITY
    const minutes = Math.max(1, Number(cfg.injectWindowMinutes) || 15)
    const horizon = t - minutes * 60_000

    const inWindow = ring.entries.filter((e) => e.ts >= horizon)
    if (inWindow.length === 0) return empty

    // 上次注入还在窗口内 = 还是同一段对话，只补新增（这把 before 与游标叠加使用）
    const continuing = ring.lastInjectAt > horizon
    let pool = inWindow.filter((e) => e.ts < before)
    if (continuing) pool = pool.filter((e) => e.seq > ring.lastInjectSeq)

    const max = Math.max(1, Math.round(Number(cfg.injectMaxMessages) || 30))
    const picked = pool.length > max ? pool.slice(pool.length - max) : pool

    ring.lastInjectAt = t
    ring.lastInjectSeq = ring.entries[ring.entries.length - 1].seq

    return { entries: picked, total: pool.length, truncated: pool.length > picked.length }
  }

  /** 观测快照（写进 status，方便回答「注入到底生效没」） */
  function stats() {
    let entries = 0
    for (const ring of rings.values()) entries += ring.entries.length
    return { groups: rings.size, entries, ...counters }
  }

  function bump(field, by = 1) {
    if (typeof counters[field] === 'number') counters[field] += by
  }

  function clear() {
    rings.clear()
    for (const k of Object.keys(counters)) counters[k] = 0
  }

  return { record, takeBackground, stats, bump, clear }
}
