/**
 * 集成测试：把我们的中间件塞进**真的** SDK 中间件链里跑。
 *
 * 这里要证明的核心假设只有一个：
 *   我们在链头写进 `ctx.state.policy.group.requireMention`，
 *   官方 mentionGate 真的会采纳它（而不是继续用插件配置里的那个布尔）。
 *
 * 这条假设如果不成立，整个「不说话」的实现就得改成自己 stop —— 结论完全不同，
 * 所以必须有测试盯着，不能靠"看起来应该行"。
 *
 * 需要宿主 profile 里有 @tencent-connect/qqbot-nodejs；没有就跳过（不失败）。
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { normalizeConfig } from '../lib/config.js'
import { createMiddleware } from '../lib/app.js'

const profileDir = process.env.DSH_PROFILE_DIR ?? ''
const sdkEntry = profileDir
  ? join(profileDir, 'node_modules/@tencent-connect/qqbot-nodejs/dist/index.js')
  : ''
const sdkMiddlewareEntry = profileDir
  ? join(profileDir, 'node_modules/@tencent-connect/qqbot-nodejs/dist/middleware/index.js')
  : ''
const hasSdk = Boolean(sdkEntry) && existsSync(sdkEntry) && existsSync(sdkMiddlewareEntry)

const skip = hasSdk ? false : '宿主 profile 里没有 @tencent-connect/qqbot-nodejs，跳过集成测试'

// 包入口只导出 QQBot / 中间件工厂；runMiddlewareChain 与 createMiddlewareContext
// 在 middleware/index.js 里（dsh-qqbot 用的也是这些），直接按文件路径取。
const sdk = hasSdk ? await import(pathToFileURL(sdkMiddlewareEntry).href) : {}

const APP = '1234567890'
const GROUP = 'G1'

function makeBot() {
  return { appId: APP, middlewares: [] }
}

function makeCtx(bot, content, over = {}) {
  const msg = {
    kind: 'group',
    groupId: GROUP,
    senderId: 'SENDER_A',
    senderName: '甲',
    content,
    messageId: `m-${Math.random().toString(36).slice(2, 8)}`,
    rawEventType: 'GROUP_MESSAGE_CREATE',
    mentions: [],
    attachments: [],
    ...over,
  }
  msg.replyTarget = { scope: 'group', targetId: GROUP, msgId: msg.messageId }
  return sdk.createMiddlewareContext({
    bot,
    message: msg,
    log: { debug() {}, info() {}, warn() {}, error() {} },
  })
}

const settle = (ms) => new Promise((r) => setTimeout(r, ms))

test('前提：policy 注入真的能覆盖官方 mentionGate 的配置', { skip }, async () => {
  const bot = makeBot()
  const gate = sdk.mentionGate({ requireMentionInGroup: true }) // 配置说"必须 @"
  const downstream = []

  // 注入 policy=false（我们判定"这条值得回"）
  const injector = async (ctx, next) => {
    ctx.state.policy = { group: { requireMention: false } }
    await next()
  }
  const tail = async (ctx) => {
    downstream.push(ctx.message.content)
  }

  await sdk.runMiddlewareChain([injector, gate, tail], makeCtx(bot, '没有 @ 的一句话'))
  assert.deepEqual(downstream, ['没有 @ 的一句话'], 'policy=false 必须让不 @ 的消息放行')
})

test('前提：policy=true 时官方 mentionGate 会拦下（且给出 no_mention 原因）', { skip }, async () => {
  const bot = makeBot()
  const gate = sdk.mentionGate({ requireMentionInGroup: false }) // 配置说"不用 @"
  const downstream = []

  const injector = async (ctx, next) => {
    ctx.state.policy = { group: { requireMention: true } }
    await next()
  }
  const tail = async () => {
    downstream.push('reached')
  }

  const ctx = makeCtx(bot, '随便说一句')
  await sdk.runMiddlewareChain([injector, gate, tail], ctx)
  assert.deepEqual(downstream, [], 'policy=true 必须挡住')
  assert.equal(ctx.stopped, true, '官方 mentionGate 是通过 ctx.stop() 挡的')
  assert.match(String(ctx.stopReason), /no_mention|mention/)
})

test('整链：连发三条 → 下游只被调用一次，内容是合并后的', { skip }, async () => {
  const cfg = normalizeConfig({ mode: 'debounce', debounceSeconds: 0.5, maxWaitSeconds: 5 })
  const core = createMiddleware({ cfg })
  const bot = makeBot()
  const gate = sdk.mentionGate({ requireMentionInGroup: false })

  const reached = []
  const tail = async (ctx) => {
    reached.push(ctx.message.content)
  }
  const chain = [core.middleware, gate, tail]

  const contexts = [
    makeCtx(bot, '第一句'),
    makeCtx(bot, '第二句'),
    makeCtx(bot, '第三句'),
  ]

  // 注意：这里不能 await（会一直等到收口）。中间件在窗口内是挂起的，
  // 我们要的正是"挂起期间下游一条都没被调用"这个事实。
  for (const ctx of contexts) void sdk.runMiddlewareChain(chain, ctx)
  await settle(50)
  assert.equal(reached.length, 0, '窗口内的消息都还在攒，不该有任何一条进链')
  await settle(650)
  assert.equal(reached.length, 1, '三条只该产生一次下游调用')
  assert.equal(reached[0], '第一句\n第二句\n第三句')
})

test('整链：不同发言人的消息各自成批', { skip }, async () => {
  const cfg = normalizeConfig({ mode: 'debounce', debounceSeconds: 0.3, maxWaitSeconds: 5 })
  const core = createMiddleware({ cfg })
  const bot = makeBot()
  const reached = []
  const chain = [
    core.middleware,
    async (ctx) => {
      reached.push(`${ctx.message.senderName}:${ctx.message.content}`)
    },
  ]

  const a = makeCtx(bot, '甲说的', { senderId: 'A', senderName: '甲' })
  const b = makeCtx(bot, '乙说的', { senderId: 'B', senderName: '乙' })
  await Promise.all([sdk.runMiddlewareChain(chain, a), sdk.runMiddlewareChain(chain, b)])
  await settle(500)
  assert.deepEqual(reached.sort(), ['乙:乙说的', '甲:甲说的'])
})

test('整链：gate 模式判定不回 → 走官方门控挡下，不进下游', { skip }, async () => {
  const cfg = normalizeConfig({
    mode: 'gate',
    debounceSeconds: 0.3,
    botNames: ['鲸鱼'],
    ownerOpenids: ['OWNER'],
  })
  const core = createMiddleware({ cfg })
  const bot = makeBot()
  const gate = sdk.mentionGate({ requireMentionInGroup: false })
  const reached = []
  const tail = async (ctx) => {
    reached.push(ctx.message.content)
  }
  const chain = [core.middleware, gate, tail]

  // 闲聊：不该回
  const chat = makeCtx(bot, '今天好热啊')
  await sdk.runMiddlewareChain(chain, chat)
  await settle(400)
  assert.deepEqual(reached, [], '闲聊不该进 agent')
  assert.equal(chat.stopped, true, '由官方 mentionGate 停下来的')

  // 点名：该回 —— 而且刚才被挡下的那句闲聊应该作为「旁听背景」补进来
  const call = makeCtx(bot, '鲸鱼你在吗')
  await sdk.runMiddlewareChain(chain, call)
  await settle(400)
  assert.equal(reached.length, 1, '点名必须放行')
  assert.match(reached[0], /鲸鱼你在吗/)
  assert.match(reached[0], /群里的闲聊/, 'gate 模式下应该注入旁听背景')
  assert.match(reached[0], /今天好热啊/, '被挡下的闲聊要被当背景补上')
})

test('整链：@ 的时候不加背景（官方自己会带群历史，别重复）', { skip }, async () => {
  const cfg = normalizeConfig({ mode: 'gate', debounceSeconds: 0.3 })
  const core = createMiddleware({ cfg })
  const bot = makeBot()
  const reached = []
  const chain = [
    core.middleware,
    sdk.mentionGate({ requireMentionInGroup: false }),
    async (ctx) => {
      reached.push(ctx.message.content)
    },
  ]

  await sdk.runMiddlewareChain(chain, makeCtx(bot, '今天好热啊'))
  await settle(50)
  await sdk.runMiddlewareChain(chain, makeCtx(bot, '帮我看下', { rawEventType: 'GROUP_AT_MESSAGE_CREATE' }))
  await settle(400)

  assert.deepEqual(reached, ['帮我看下'], '@ 的消息不该带背景')
})

test('整链：debounce 模式不注入旁听（每条都会进 agent，带背景只是多烧 token）', { skip }, async () => {
  const core = createMiddleware({ cfg: normalizeConfig({ mode: 'debounce', debounceSeconds: 0.3 }) })
  const reached = []
  const chain = [
    core.middleware,
    async (ctx) => {
      reached.push(ctx.message.content)
    },
  ]
  const bot = makeBot()
  await sdk.runMiddlewareChain(chain, makeCtx(bot, '今天好热啊'))
  await settle(400)
  await sdk.runMiddlewareChain(chain, makeCtx(bot, '我这边下雨了'))
  await settle(400)

  assert.deepEqual(reached, ['今天好热啊', '我这边下雨了'])
})

test('整链：斜杠命令不缓冲，立刻直通', { skip }, async () => {
  const cfg = normalizeConfig({ mode: 'debounce', debounceSeconds: 5, maxWaitSeconds: 12 })
  const core = createMiddleware({ cfg })
  const bot = makeBot()
  const reached = []
  const chain = [
    core.middleware,
    async (ctx) => {
      reached.push(ctx.message.content)
    },
  ]
  await sdk.runMiddlewareChain(chain, makeCtx(bot, '/bot-status'))
  assert.deepEqual(reached, ['/bot-status'], '命令必须立刻到下游，不能等 5 秒')
})

test('整链：只 @ 不说话的消息合并后不留 @ 标记', { skip }, async () => {
  const cfg = normalizeConfig({ mode: 'debounce', debounceSeconds: 0.3, maxWaitSeconds: 5 })
  const core = createMiddleware({ cfg })
  const bot = makeBot()
  const reached = []
  const chain = [
    core.middleware,
    async (ctx) => {
      reached.push(ctx.message.content)
    },
  ]
  const ctx = makeCtx(bot, `<@!${APP}> 帮我看看`, { rawEventType: 'GROUP_AT_MESSAGE_CREATE' })
  await sdk.runMiddlewareChain(chain, ctx)
  await settle(400)
  assert.deepEqual(reached, ['帮我看看'], '@ 标记要在合并时剥掉')
})
