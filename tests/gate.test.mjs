import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeConfig } from '../lib/config.js'
import { createGateState, decide, recordAnswer, scoreQuestion, wasMentioned } from '../lib/gate.js'

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
