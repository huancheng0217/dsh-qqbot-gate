import assert from 'node:assert/strict'
import test from 'node:test'

import { registerBot } from '../lib/hook.js'

/** 造一份干净的运行时状态，避免测试之间互相污染 */
function freshState() {
  return {
    factory: null,
    wrapper: null,
    inserted: new WeakSet(),
    hooked: false,
    hookVia: null,
    hookError: null,
    instances: 0,
  }
}

test('registerBot 把我们的层插到链头（比官方第一层还外）', async () => {
  const state = freshState()
  const order = []
  state.factory = async (ctx, next) => {
    order.push('qgate')
    await next()
  }
  const bot = {
    middlewares: [
      async (ctx, next) => {
        order.push('errorHandler')
        await next()
      },
    ],
  }

  assert.equal(registerBot(bot, state), true)
  assert.equal(bot.middlewares.length, 2)
  assert.equal(state.instances, 1)

  // 按洋葱模型跑一次：我们的层在最外面
  await bot.middlewares[0]({}, async () => {
    await bot.middlewares[1]({}, async () => {
      order.push('agent')
    })
  })
  assert.deepEqual(order, ['qgate', 'errorHandler', 'agent'])
})

test('同一个 bot 只插一次（幂等）', () => {
  const state = freshState()
  state.factory = async (ctx, next) => next()
  const bot = { middlewares: [] }
  assert.equal(registerBot(bot, state), true)
  assert.equal(registerBot(bot, state), false)
  assert.equal(registerBot(bot, state), false)
  assert.equal(bot.middlewares.length, 1)
})

test('热重载：链上的壳不动，换成新实现立即生效', async () => {
  const state = freshState()
  const calls = []
  state.factory = async (ctx, next) => {
    calls.push('v1')
    await next()
  }
  const bot = { middlewares: [] }
  registerBot(bot, state)

  await bot.middlewares[0]({}, async () => {})
  state.factory = async (ctx, next) => {
    calls.push('v2')
    await next()
  }
  await bot.middlewares[0]({}, async () => {})

  assert.deepEqual(calls, ['v1', 'v2'])
  assert.equal(bot.middlewares.length, 1, '重载不该重复插层')
})

test('factory 为空时壳退化成直通（插件卸载后不留副作用）', async () => {
  const state = freshState()
  const bot = { middlewares: [] }
  registerBot(bot, state)
  state.factory = null
  let reached = false
  await bot.middlewares[0]({}, async () => {
    reached = true
  })
  assert.equal(reached, true)
})

test('拿不到 middlewares 的 bot 不会崩，只是没插上', () => {
  const state = freshState()
  state.factory = async (ctx, next) => next()
  assert.equal(registerBot({}, state), false)
  assert.equal(registerBot(null, state), false)
  assert.equal(registerBot({ middlewares: 'not-an-array' }, state), false)
})
