import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeConfig } from '../lib/config.js'
import { createGateState, decide, isPeakQuietTime, recordAnswer, scoreQuestion, wasMentioned } from '../lib/gate.js'

const APP = '1234567890'
// 用假的 openid：真实值不该跟着代码进公开仓库
const OWNER = 'OWNER_USER_OPENID_0001'
const GROUP = 'GROUP_OPENID_0001'

function cfgOf(over = {}) {
  return normalizeConfig({
    mode: 'gate',
    ownerOpenids: [OWNER],
    botNames: ['鲸鱼', '女仆', 'D酱'],
    // 测试默认把随机冒泡关掉：大多数用例要验证的是确定路径，
    // 随机冒泡另有专测（见文件末尾的 ambient 系列）
    ambientProbability: 0,
    ...over,
  })
}

function groupMsg(over = {}) {
  return {
    kind: 'group',
    // 真实 InboundMessage 的群标识字段是 groupOpenid —— 曾经误写成 groupId，
    // 结果群标识一路回退到 senderId（群白名单永远匹配不上、冷却按人算）
    groupOpenid: GROUP,
    senderId: 'SOMEONE',
    senderName: '群友',
    content: '今天天气不错',
    rawEventType: 'GROUP_MESSAGE_CREATE',
    mentions: [],
    attachments: [],
    ...over,
  }
}

const env = (now = 1000, random = () => 0.99) => ({ appId: APP, now, random })

test('私聊永远回（门槛只管群）', () => {
  const r = decide({ kind: 'c2c', senderId: 'X', content: '嗯' }, cfgOf(), createGateState(), env())
  assert.equal(r.answer, true)
  assert.equal(r.reason, 'c2c')
})

test('@ 是强唤醒，且不受冷却影响', () => {
  const cfg = cfgOf({ cooldownSeconds: 90 })
  const state = createGateState()
  recordAnswer(state, groupMsg(), 1000)
  const r = decide(groupMsg({ senderId: 'OTHER', content: '你好' , rawEventType: 'GROUP_AT_MESSAGE_CREATE' }), cfg, state, env(2000))
  assert.equal(r.answer, true)
  assert.equal(r.reason, 'direct_mention')
  assert.equal(r.strong, true)
})

test('content 里的 <@!appId> 也算 @', () => {
  const msg = groupMsg({ content: `<@!${APP}> 在吗` })
  assert.equal(wasMentioned(msg, APP), true)
  const r = decide(msg, cfgOf(), createGateState(), env())
  assert.equal(r.reason, 'direct_mention')
})

test('别人的 @ 不算 @ 本 bot', () => {
  const msg = groupMsg({ content: '<@!99999> 你看这个' })
  assert.equal(wasMentioned(msg, APP), false)
})

test('主人在群里说话必回', () => {
  const r = decide(groupMsg({ senderId: OWNER, content: '嗯' }), cfgOf(), createGateState(), env())
  assert.equal(r.answer, true)
  assert.equal(r.reason, 'owner')
})

test('点名叫到 bot 就必回', () => {
  const r = decide(groupMsg({ content: '鲸鱼你觉得呢' }), cfgOf(), createGateState(), env())
  assert.equal(r.answer, true)
  assert.equal(r.reason, 'name_call')
  assert.equal(r.detail, '鲸鱼')
})

test('普通闲聊不说话', () => {
  const r = decide(groupMsg({ content: '今天好热啊' }), cfgOf(), createGateState(), env())
  assert.equal(r.answer, false)
  assert.equal(r.reason, 'no_trigger')
})

test('提问打分：有问号 + 问词 + 长度 → 过线', () => {
  const { score } = scoreQuestion('有没有人知道这个报错怎么修？')
  assert.ok(score >= 65, `score=${score}`)
  const r = decide(groupMsg({ content: '有没有人知道这个报错怎么修？' }), cfgOf(), createGateState(), env())
  assert.equal(r.answer, true)
  assert.equal(r.reason, 'question')
})

test('光有问号不够（不抢占注意力）', () => {
  const { score } = scoreQuestion('？')
  assert.ok(score < 65)
  const r = decide(groupMsg({ content: '？' }), cfgOf(), createGateState(), env())
  assert.equal(r.answer, false)
})

test('纯表情扣分且不触发', () => {
  const { score } = scoreQuestion('【表情: 笑】')
  assert.ok(score < 0)
})

test('兴趣词命中 + 概率中 → 回', () => {
  const cfg = cfgOf({ interestKeywords: ['显卡'], interestProbability: 50 })
  const r = decide(groupMsg({ content: '新显卡到了' }), cfg, createGateState(), env(1000, () => 0.1))
  assert.equal(r.answer, true)
  assert.equal(r.reason, 'interest')
  assert.equal(r.detail, '显卡')
})

test('兴趣词命中但概率没中 → 只记录', () => {
  const cfg = cfgOf({ interestKeywords: ['显卡'], interestProbability: 9 })
  const r = decide(groupMsg({ content: '新显卡到了' }), cfg, createGateState(), env(1000, () => 0.9))
  assert.equal(r.answer, false)
  assert.equal(r.reason, 'probability_miss')
})

test('冷却压制弱唤醒', () => {
  const cfg = cfgOf({ cooldownSeconds: 90, interestKeywords: ['显卡'], interestProbability: 100 })
  const state = createGateState()
  recordAnswer(state, groupMsg(), 1000)
  const r = decide(groupMsg({ content: '显卡又来了' }), cfg, state, env(2000, () => 0))
  assert.equal(r.answer, false)
  assert.equal(r.reason, 'cooldown')
})

test('冷却过期后放行', () => {
  const cfg = cfgOf({ cooldownSeconds: 90, interestKeywords: ['显卡'], interestProbability: 100 })
  const state = createGateState()
  recordAnswer(state, groupMsg(), 1000)
  const r = decide(groupMsg({ content: '显卡又来了' }), cfg, state, env(1000 + 91_000, () => 0))
  assert.equal(r.answer, true)
  assert.equal(r.reason, 'interest')
})

test('普通消息也有基础冒泡率（ambient）', () => {
  const cfg = cfgOf({ ambientProbability: 50 })
  const r = decide(groupMsg({ content: '今天好热啊' }), cfg, createGateState(), env(1000, () => 0.3))
  assert.equal(r.answer, true)
  assert.equal(r.reason, 'ambient')
})

test('普通消息没抽中 → ambient_miss', () => {
  const cfg = cfgOf({ ambientProbability: 9 })
  const r = decide(groupMsg({ content: '今天好热啊' }), cfg, createGateState(), env(1000, () => 0.5))
  assert.equal(r.answer, false)
  assert.equal(r.reason, 'ambient_miss')
})

test('命中兴趣词走更高的概率，不是基础冒泡率', () => {
  // 同一个随机数：按 ambient(0) 不会中，按 interest(50) 会中
  const cfg = cfgOf({ ambientProbability: 0, interestProbability: 50, interestKeywords: ['显卡'] })
  const r = decide(groupMsg({ content: '新显卡到了' }), cfg, createGateState(), env(1000, () => 0.3))
  assert.equal(r.answer, true)
  assert.equal(r.reason, 'interest')
})

test('随机冒泡同样受冷却/疲劳压制', () => {
  const cfg = cfgOf({ ambientProbability: 100, cooldownSeconds: 90 })
  const state = createGateState()
  recordAnswer(state, groupMsg(), 1000)
  const r = decide(groupMsg({ content: '今天好热啊' }), cfg, state, env(2000, () => 0))
  assert.equal(r.answer, false)
  assert.equal(r.reason, 'cooldown')
})

test('纯表情/纯标点不进随机池', () => {
  const cfg = cfgOf({ ambientProbability: 100 })
  const r = decide(groupMsg({ content: '？？？' }), cfg, createGateState(), env(1000, () => 0))
  assert.equal(r.answer, false)
  assert.equal(r.reason, 'no_trigger')
})

test('两份概率都为 0 时完全不主动开口', () => {
  const cfg = cfgOf({ ambientProbability: 0, interestProbability: 0, interestKeywords: ['显卡'] })
  const r = decide(groupMsg({ content: '新显卡到了' }), cfg, createGateState(), env(1000, () => 0))
  assert.equal(r.answer, false)
  assert.equal(r.reason, 'no_trigger')
})

test('疲劳压制弱唤醒，但压制不了强唤醒', () => {
  const cfg = cfgOf({ fatigueLimit: 2, cooldownSeconds: 0, fatigueWindowSeconds: 300, interestKeywords: ['显卡'], interestProbability: 100 })
  const state = createGateState()
  recordAnswer(state, groupMsg(), 1000)
  recordAnswer(state, groupMsg(), 2000)
  const weak = decide(groupMsg({ content: '显卡又来了' }), cfg, state, env(3000, () => 0))
  assert.equal(weak.answer, false)
  assert.equal(weak.reason, 'fatigue')
  const strong = decide(groupMsg({ content: '鲸鱼在吗' }), cfg, state, env(3000, () => 0))
  assert.equal(strong.answer, true)
  assert.equal(strong.reason, 'name_call')
})

test('白名单模式：不在名单的群不过门槛，照旧每条都回', () => {
  const cfg = cfgOf({ groupMode: 'allowlist', groupAllow: ['OTHER_GROUP'] })
  const r = decide(groupMsg({ rawEventType: 'GROUP_MESSAGE_CREATE', content: '随便聊一句' }), cfg, createGateState(), env())
  assert.equal(r.answer, true, '白名单是「在哪启用门槛」，不是「只让这些群说话」')
  assert.equal(r.reason, 'group_not_gated')
})

test('白名单模式：名单里的群才真的按门槛判', () => {
  const cfg = cfgOf({ groupMode: 'allowlist', groupAllow: [GROUP] })
  const r = decide(groupMsg({ content: '随便聊一句' }), cfg, createGateState(), env())
  assert.equal(r.answer, false)
  assert.equal(r.reason, 'no_trigger')
})

test('黑名单群连 @ 都不回', () => {
  const cfg = cfgOf({ groupDeny: [GROUP] })
  const r = decide(groupMsg({ rawEventType: 'GROUP_AT_MESSAGE_CREATE' }), cfg, createGateState(), env())
  assert.equal(r.answer, false)
  assert.equal(r.reason, 'group_denied')
})

test('冷场关掉时不起作用（默认）', () => {
  const r = decide(groupMsg({ content: '有人吗' }), cfgOf(), createGateState(), env())
  assert.equal(r.answer, false)
  assert.equal(r.reason, 'no_trigger')
})

test('冷场打开后，静默够久有人开口 → 回', () => {
  const cfg = cfgOf({ coldGroupIdleMinutes: 25 })
  const state = createGateState()
  state.lastActivityAt.set(GROUP, 0)
  const r = decide(groupMsg({ content: '有人在吗' }), cfg, state, env(30 * 60_000))
  assert.equal(r.answer, true)
  assert.equal(r.reason, 'cold_group')
})

// ── 峰时省话（DeepSeek 峰谷计价）──────────────────────────────
/** 本地时间构造，避免测试依赖进程时区 */
const at = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()

test('isPeakQuietTime：工作日峰时 / 午休 / 夜间 / 周末', () => {
  const cfg = cfgOf({})
  assert.equal(isPeakQuietTime(at(2026, 11, 10, 10, 30), cfg), true, '周二 10:30 是峰时')
  assert.equal(isPeakQuietTime(at(2026, 11, 10, 9, 0), cfg), true, '09:00 整点是峰时起点')
  assert.equal(isPeakQuietTime(at(2026, 11, 10, 11, 59), cfg), true, '11:59 还在峰时')
  assert.equal(isPeakQuietTime(at(2026, 11, 10, 12, 0), cfg), false, '12:00 进午休谷时')
  assert.equal(isPeakQuietTime(at(2026, 11, 10, 13, 30), cfg), false, '13:30 谷时')
  assert.equal(isPeakQuietTime(at(2026, 11, 10, 14, 30), cfg), true, '14:30 又进峰时')
  assert.equal(isPeakQuietTime(at(2026, 11, 10, 18, 0), cfg), false, '18:00 收工')
  assert.equal(isPeakQuietTime(at(2026, 11, 10, 22, 0), cfg), false, '深夜谷时')
  assert.equal(isPeakQuietTime(at(2026, 11, 14, 10, 30), cfg), false, '周六全天谷时')
})

test('isPeakQuietTime：关掉「只工作日」后周末也算峰时', () => {
  const cfg = cfgOf({ peakQuietWeekdaysOnly: false })
  assert.equal(isPeakQuietTime(at(2026, 11, 14, 10, 30), cfg), true)
})

test('isPeakQuietTime：自定义时段与跨零点段', () => {
  const cfg = cfgOf({ peakQuietWindows: '22:00-02:00' })
  assert.equal(isPeakQuietTime(at(2026, 11, 10, 23, 0), cfg), true, '23:00 在跨零点段里')
  assert.equal(isPeakQuietTime(at(2026, 11, 10, 1, 0), cfg), true, '01:00 也在')
  assert.equal(isPeakQuietTime(at(2026, 11, 10, 3, 0), cfg), false, '03:00 不在')
})

test('峰时：普通闲聊不接话，理由记 peak_quiet', () => {
  const cfg = cfgOf({})
  const r = decide(groupMsg({ content: '今天好热啊' }), cfg, createGateState(), {
    appId: APP, now: at(2026, 11, 10, 10, 30), random: () => 0,
  })
  assert.equal(r.answer, false)
  assert.equal(r.reason, 'peak_quiet')
})

test('峰时：提问打分再高也不接（省话优先于抓问题）', () => {
  const cfg = cfgOf({})
  const r = decide(groupMsg({ content: '有没有人知道这个报错怎么修？' }), cfg, createGateState(), {
    appId: APP, now: at(2026, 11, 10, 10, 30), random: () => 0,
  })
  assert.equal(r.answer, false)
  assert.equal(r.reason, 'peak_quiet')
})

test('峰时：@ / 点名 / 主人 照旧一票通过', () => {
  const cfg = cfgOf({})
  const now = at(2026, 11, 10, 10, 30)
  const mention = decide(groupMsg({ rawEventType: 'GROUP_AT_MESSAGE_CREATE', content: '在吗' }), cfg, createGateState(), { appId: APP, now })
  assert.equal(mention.reason, 'direct_mention')
  const named = decide(groupMsg({ content: '鲸鱼你觉得呢' }), cfg, createGateState(), { appId: APP, now })
  assert.equal(named.reason, 'name_call')
})

test('峰时：命中兴趣词仍然放行（走后面的概率）', () => {
  const cfg = cfgOf({ interestKeywords: ['显卡'], interestProbability: 100 })
  const r = decide(groupMsg({ content: '新显卡到了' }), cfg, createGateState(), {
    appId: APP, now: at(2026, 11, 10, 10, 30), random: () => 0,
  })
  assert.equal(r.answer, true)
  assert.equal(r.reason, 'interest')
})

test('峰时：关掉 peakQuietAllowInterest 后连兴趣词也不接', () => {
  const cfg = cfgOf({ interestKeywords: ['显卡'], interestProbability: 100, peakQuietAllowInterest: false })
  const r = decide(groupMsg({ content: '新显卡到了' }), cfg, createGateState(), {
    appId: APP, now: at(2026, 11, 10, 10, 30), random: () => 0,
  })
  assert.equal(r.answer, false)
  assert.equal(r.reason, 'peak_quiet')
})

test('谷时：峰时开关不影响正常接话', () => {
  const cfg = cfgOf({ interestKeywords: ['显卡'], interestProbability: 100 })
  const r = decide(groupMsg({ content: '新显卡到了' }), cfg, createGateState(), {
    appId: APP, now: at(2026, 11, 10, 20, 0), random: () => 0,
  })
  assert.equal(r.answer, true)
  assert.equal(r.reason, 'interest')
})

test('关掉峰时省话后，峰时照常按原规则走', () => {
  const cfg = cfgOf({ peakQuietEnabled: false, interestKeywords: ['显卡'], interestProbability: 100 })
  const r = decide(groupMsg({ content: '新显卡到了' }), cfg, createGateState(), {
    appId: APP, now: at(2026, 11, 10, 10, 30), random: () => 0,
  })
  assert.equal(r.answer, true)
})
