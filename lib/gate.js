/**
 * 群聊唤醒判定 —— 纯函数，输入一条消息 + 配置 + 运行态，输出「说 / 不说」。
 *
 * 设计原则（对齐 AstrBot private_companion 的判定管线，砍掉我们不需要的部分）：
 *   1. 强唤醒（@ / 主人 / 点名）一票通过，不看概率、不看冷却。
 *   2. 其余走打分/概率，任何一关不过就只记录、不说话。
 *   3. 抑制器（冷却 / 疲劳）是最后一关，只压制弱唤醒，绝不压制强唤醒。
 *
 * 每个返回值都带 reason，落日志后能回答「它刚才为什么不说话」。
 */

import { groupIdOf, isContentFree, mentionPattern } from './merge.js'

/** 强唤醒原因 —— 冷却/疲劳对它们一律无效 */
export const STRONG_REASONS = new Set(['direct_mention', 'owner', 'name_call'])

const QUESTION_WORDS = [
  '吗', '呢', '怎么', '为什么', '为啥', '如何', '谁', '哪', '能不能', '可不可以',
  '求', '帮', '请问', '有没有', '是不是', '要不要', '多少', '几个', '什么',
]

const YOU_WORDS = ['你', '你们', '你觉得', '你看', '你帮']

/** 运行态：由调用方（index.js）持有，纯数据，便于测试与重置 */
export function createGateState() {
  return {
    /** 群 key → 上次「放行给 agent」的时间戳 */
    lastAnswerAt: new Map(),
    /** 群 key → 最近放行时间戳数组（疲劳窗口用） */
    answerTimes: new Map(),
    /** 群 key → 最后一条消息时间戳（冷场判定用） */
    lastActivityAt: new Map(),
    /** 群 key → 上次「被吞掉」的时间戳，仅用于日志节流 */
    lastSkipAt: new Map(),
    /** 按 reason 计数，便于调参 */
    counts: new Map(),
  }
}

export function bumpCount(state, reason) {
  const n = state.counts.get(reason) ?? 0
  state.counts.set(reason, n + 1)
  return n + 1
}

/** 该用户是不是主人（群里的 senderId 与私聊 openid 是同一套 user openid） */
function isOwner(senderId, cfg) {
  const id = String(senderId ?? '').trim()
  if (!id) return false
  return cfg.ownerOpenids.some((o) => o.toLowerCase() === id.toLowerCase())
}

/** 文本里点名了 bot 吗（不区分大小写，允许出现在任意位置） */
export function namedCall(text, cfg) {
  const s = String(text ?? '')
  if (!s) return null
  const lower = s.toLowerCase()
  for (const name of cfg.botNames) {
    if (!name) continue
    if (lower.includes(name.toLowerCase())) return name
  }
  return null
}

/** 是否 @ 了本 bot（三条来源与官方 mentionGate 一致） */
export function wasMentioned(msg, appId) {
  if (msg?.rawEventType === 'GROUP_AT_MESSAGE_CREATE') return true
  if (Array.isArray(msg?.mentions) && msg.mentions.some((m) => m?.is_you === true)) return true
  const re = mentionPattern(appId)
  if (!re) return false
  re.lastIndex = 0
  return re.test(String(msg?.content ?? ''))
}

/**
 * 提问打分。阈值默认 65。
 * 刻意不做"有问号就必回"—— 群里刷屏的问句太多，问号只值 40 分。
 */
export function scoreQuestion(text) {
  const s = String(text ?? '').trim()
  if (!s) return { score: 0, hits: [] }
  const hits = []
  let score = 0

  if (/[?？]/.test(s)) {
    score += 40
    hits.push('?')
  }
  for (const w of QUESTION_WORDS) {
    if (s.includes(w)) {
      score += 25
      hits.push(`问词:${w}`)
      break
    }
  }
  for (const w of YOU_WORDS) {
    if (s.includes(w)) {
      score += 15
      hits.push(`称呼:${w}`)
      break
    }
  }
  if (s.length >= 4) {
    score += 10
    hits.push('长度')
  }
  // 纯表情 / 单字复读 / 只有标点：不该占用群里的注意力
  if (isContentFree(s)) {
    score -= 30
    hits.push('空内容')
  } else if (/^(.)\1{2,}$/.test(s)) {
    score -= 30
    hits.push('复读')
  }

  return { score, hits }
}

function interestHit(text, cfg) {
  const s = String(text ?? '').toLowerCase()
  if (!s) return null
  for (const kw of cfg.interestKeywords) {
    if (kw && s.includes(kw.toLowerCase())) return kw
  }
  return null
}

function pruneTimes(times, now, windowMs) {
  const cut = now - windowMs
  let i = 0
  while (i < times.length && times[i] < cut) i += 1
  if (i > 0) times.splice(0, i)
  return times
}

/**
 * 现在是不是「峰时」——DeepSeek 计价贵的那些时段。
 *
 * 现行规则（2026-08-17 起）：**高峰 = 工作日 09:00-12:00 + 14:00-18:00（北京时间）**，
 * 其余全部算谷时（含周末、节假日全天），谷价正好是峰价的一半。
 * 旧的「每日 00:30-08:30 错峰优惠」2025-09 已取消，别按那个写。
 *
 * **不识别中国法定节假日与调休**：长假期间会被当成工作日算成峰时。
 * 真碰上长假想全天按谷价走，把 `peakQuietEnabled` 临时关掉即可。
 *
 * @param {number} now 时间戳
 * @param {{peakQuietWindows?: string, peakQuietWeekdaysOnly?: boolean}} cfg
 * @returns {boolean}
 */
export function isPeakQuietTime(now, cfg) {
  const d = new Date(now)
  if (cfg?.peakQuietWeekdaysOnly !== false) {
    const day = d.getDay() // 0=周日, 6=周六
    if (day === 0 || day === 6) return false
  }
  const minutes = d.getHours() * 60 + d.getMinutes()
  for (const raw of String(cfg?.peakQuietWindows ?? '').split(',')) {
    const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(raw.trim())
    if (!m) continue
    const start = Number(m[1]) * 60 + Number(m[2])
    const end = Number(m[3]) * 60 + Number(m[4])
    if (end <= start) {
      // 跨零点的段（如 22:00-02:00）
      if (minutes >= start || minutes < end) return true
    } else if (minutes >= start && minutes < end) {
      return true
    }
  }
  return false
}

/**
 * 主判定。
 *
 * @param {object} msg  {kind, content, senderId, senderName, groupId, rawEventType, mentions, attachments}
 * @param {object} cfg  normalizeConfig() 的产物
 * @param {object} state createGateState() 的产物
 * @param {{ appId?: string, now?: number, random?: () => number }} env
 * @returns {{answer: boolean, reason: string, score?: number, strong?: boolean, detail?: string}}
 */
export function decide(msg, cfg, state, env = {}) {
  const now = env.now ?? Date.now()
  const rand = env.random ?? Math.random
  const appId = env.appId

  const kind = msg?.kind === 'group' ? 'group' : 'c2c'

  // 私聊：只有主人一个人，永远回。防抖仍然生效（那是另一个中间件的事）。
  if (kind !== 'group') {
    return { answer: true, reason: 'c2c', strong: true }
  }

  const groupId = groupIdOf(msg)
  const groupKey = groupId
  const rawText = String(msg?.content ?? '')

  // 记活动时间（冷场判定用），在返回前统一更新
  const touch = () => state.lastActivityAt.set(groupKey, now)

  // ── 1. 群范围过滤 ──
  //
  // 语义区分（重要，二者相反）：
  //   groupDeny  = 这些群**完全闭嘴**（连 @ 都不回）
  //   groupMode: allowlist + groupAllow = **只在这些群参与门槛判定**；
  //     不在名单的群不判、不过门槛，照旧每条都回（等于门槛只管白名单）
  // 一开始我把 allowlist 写成"不在名单就不回"，等于顺手把其他群全静音了 ——
  // 那不是「加一个白名单」想表达的意思，改成现在这样。
  if (cfg.groupDeny.length > 0 && cfg.groupDeny.includes(groupId)) {
    touch()
    return { answer: false, reason: 'group_denied' }
  }
  if (cfg.groupMode === 'allowlist' && !cfg.groupAllow.includes(groupId)) {
    touch()
    return { answer: true, reason: 'group_not_gated' }
  }

  // ── 2. 强唤醒 ──
  if (wasMentioned(msg, appId)) {
    touch()
    return { answer: true, reason: 'direct_mention', strong: true }
  }
  if (isOwner(msg?.senderId, cfg)) {
    touch()
    return { answer: true, reason: 'owner', strong: true }
  }
  const named = namedCall(rawText, cfg)
  if (named) {
    touch()
    return { answer: true, reason: 'name_call', strong: true, detail: named }
  }

  // ── 2.5 峰时省话 ──
  // 贵的时段（默认工作日 09:00-12:00 / 14:00-18:00）只放行强唤醒和兴趣词，
  // 提问打分、基础冒泡、冷场全部不接——省下来的是「上午两小时群里冷场」换一半单价。
  // 注意这里排在抑制器**之前**：峰时根本不该进概率抽签，冷却/疲劳都不用算。
  if (cfg.peakQuietEnabled && isPeakQuietTime(now, cfg)) {
    const peakKw = interestHit(rawText, cfg)
    if (!peakKw || cfg.peakQuietAllowInterest === false) {
      touch()
      return { answer: false, reason: 'peak_quiet', strong: false, detail: peakKw ?? undefined }
    }
    // 命中兴趣词 → 继续走下面的概率与抑制器
  }

  // 到此为止都是弱唤醒，先算抑制器所需的时间窗
  const lastAnswer = state.lastAnswerAt.get(groupKey)
  const cooling = cfg.cooldownSeconds > 0 && lastAnswer !== undefined && now - lastAnswer < cfg.cooldownSeconds * 1000
  const times = pruneTimes(state.answerTimes.get(groupKey) ?? [], now, cfg.fatigueWindowSeconds * 1000)
  state.answerTimes.set(groupKey, times)
  const fatigued = cfg.fatigueLimit > 0 && times.length >= cfg.fatigueLimit

  // ── 3. 提问打分 ──
  const { score, hits } = scoreQuestion(rawText)
  if (score >= cfg.questionThreshold) {
    touch()
    if (cooling) return { answer: false, reason: 'cooldown', score, strong: false, detail: `question(${score})` }
    if (fatigued) return { answer: false, reason: 'fatigue', score, strong: false, detail: `question(${score})` }
    return { answer: true, reason: 'question', score, strong: false, detail: hits.join(',') }
  }

  // ── 4. 接话概率：基础冒泡 vs 兴趣词加成 ──
  //
  // 旧版是「命中兴趣词才抽签」——没命中就永远不主动开口，等于把兴趣词当成了
  // 抽签的开关。现在改成两条并存：
  //   · 普通内容走 ambientProbability（默认 9%）：群里总有我想插一句的时候
  //   · 命中兴趣词换成 interestProbability（默认 50%）：说到我在意的，更可能开口
  // 纯表情/复读/纯标点不进随机池——对一堆表情符「随机接话」只会显得傻。
  const kw = interestHit(rawText, cfg)
  const chance = Math.max(0, Math.min(100, Number(kw ? cfg.interestProbability : cfg.ambientProbability) || 0))
  if (chance > 0 && !isContentFree(rawText)) {
    touch()
    const label = kw ? `interest(${kw})` : 'ambient'
    if (rand() * 100 >= chance) {
      return { answer: false, reason: kw ? 'probability_miss' : 'ambient_miss', strong: false, detail: kw ?? undefined }
    }
    if (cooling) return { answer: false, reason: 'cooldown', strong: false, detail: label }
    if (fatigued) return { answer: false, reason: 'fatigue', strong: false, detail: label }
    return { answer: true, reason: kw ? 'interest' : 'ambient', strong: false, detail: kw ?? undefined }
  }

  // ── 5. 冷场：静默够久后有人重新开口 ──
  if (cfg.coldGroupIdleMinutes > 0) {
    const last = state.lastActivityAt.get(groupKey)
    const idleMs = last === undefined ? Infinity : now - last
    touch()
    if (idleMs >= cfg.coldGroupIdleMinutes * 60_000) {
      if (isContentFree(rawText)) return { answer: false, reason: 'cold_group_empty' }
      if (cooling) return { answer: false, reason: 'cooldown', strong: false, detail: 'cold_group' }
      if (fatigued) return { answer: false, reason: 'fatigue', strong: false, detail: 'cold_group' }
      return { answer: true, reason: 'cold_group', strong: false }
    }
  } else {
    touch()
  }

  return { answer: false, reason: 'no_trigger', score, strong: false }
}

/** 放行之后记账：冷却/疲劳/活动时间都从这里更新，避免两处各写一遍 */
export function recordAnswer(state, msg, now = Date.now()) {
  if (msg?.kind !== 'group') return
  const groupId = groupIdOf(msg)
  state.lastAnswerAt.set(groupId, now)
  const times = state.answerTimes.get(groupId) ?? []
  times.push(now)
  state.answerTimes.set(groupId, times)
  state.lastActivityAt.set(groupId, now)
}
