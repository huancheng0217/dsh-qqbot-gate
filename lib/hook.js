/**
 * 钩住 QQBot 实例 —— 本插件唯一贴 SDK 内部的一步。
 *
 * 背景：dsh-qqbot 的 bootstrapGateway() 把 bot 当局部变量，没有暴露成 Cordis 服务，
 *       外部插件拿不到实例。能用的入口只有 SDK 类原型上的两个方法：
 *         - use(...)                  dsh-qqbot 创建 bot 后立刻连调十几次
 *         - handleInboundMessage(raw) 每条入站消息都会走
 *       两个都钩，谁先到都能抓住实例；抓到的瞬间把我们的中间件 unshift 到链头。
 *
 * 为什么钩子安全：
 *       QQBot.handleInboundMessage 每次都现拼中间件数组（dist/QQBot.js 里
 *       `const chain = [...this.middlewares, downstream]`），所以任何时刻插入下一条消息
 *       立即生效，不需要重建 bot、不需要重启。而且注册发生在原方法体执行之前，
 *       所以连「第一条消息」也不会漏。
 *
 * 失败策略：任何一步失败都不抛，只降级（机器人照常工作，门槛不生效），并把原因交给调用方落日志。
 *       全局 Symbol 保证热重载/多实例只钩一次，不会重复插中间件。
 */

import { loadQQBot } from './sdk.js'
import { shouldBlock, compilePatterns, DEFAULT_PATTERNS } from './outguard.js'
import { installSplitter } from './splitter.js'
import { installOutLog } from './outlog.js'

const STATE_KEY = Symbol.for('dsh.qqbotGate.runtime')

/**
 * 跨热重载共享的运行时状态。
 * - factory: 当前生效的中间件实现（插件重载时被替换成新的，链上那个 wrapper 不用动）
 * - wrapper: 真正插进 bot.middlewares 的那层薄壳
 * - inserted: 已经插过的 bot（WeakSet，不阻止回收）
 */
export function gateRuntime() {
  let state = globalThis[STATE_KEY]
  if (!state) {
    state = {
      factory: null,
      wrapper: null,
      inserted: new WeakSet(),
      hooked: false,
      hookVia: null,
      hookError: null,
      instances: 0,
    }
    globalThis[STATE_KEY] = state
  }
  return state
}

function ensureWrapper(state) {
  if (typeof state.wrapper === 'function') return state.wrapper
  state.wrapper = (ctx, next) => {
    const impl = state.factory
    if (typeof impl !== 'function') return next()
    return impl(ctx, next)
  }
  return state.wrapper
}

/**
 * 把 wrapper 插到这个 bot 的链头。可重复调用（幂等）。
 * @returns {boolean} 本次是否真的插进去了
 */
export function registerBot(bot, state = gateRuntime()) {
  if (!bot || !Array.isArray(bot.middlewares)) return false
  const wrapper = ensureWrapper(state)
  if (state.inserted.has(bot)) return false
  if (bot.middlewares.includes(wrapper)) {
    state.inserted.add(bot)
    return false
  }
  bot.middlewares.unshift(wrapper)
  state.inserted.add(bot)
  state.instances += 1
  return true
}

/**
 * 一次性安装原型钩子。
 *
 * @param {{ log?: (msg: string) => void }} [opts]
 * @returns {Promise<{ok: boolean, via?: string, error?: string, already?: boolean}>}
 */
export async function installHook(opts = {}) {
  const log = opts.log ?? (() => {})
  const state = gateRuntime()

  if (state.hooked) {
    state.hookError = null // 上次可能失败过；此刻钩子是有效的，别让旧错误留在状态里
    return { ok: true, already: true, via: state.hookVia }
  }

  const loaded = await loadQQBot({ log })
  if (!loaded) {
    state.hookError = 'sdk-not-found'
    return { ok: false, error: state.hookError }
  }

  const proto = loaded.QQBot?.prototype
  if (!proto) {
    state.hookError = 'no-prototype'
    return { ok: false, error: state.hookError }
  }

  // 钩 1：bot.use(...) —— dsh-qqbot 建好 bot 后马上就会走到这里
  const origUse = proto.use
  if (typeof origUse === 'function' && !origUse.__qgate) {
    const patched = function use(...args) {
      try {
        registerBot(this, state)
      } catch (err) {
        log(`[hook] registerBot(use) 失败: ${String(err?.message ?? err)}`)
      }
      return origUse.apply(this, args)
    }
    patched.__qgate = true
    proto.use = patched
  }

  // 钩 2：handleInboundMessage —— 我们加载晚了的兜底（见文件头注释）
  const origHandle = proto.handleInboundMessage
  if (typeof origHandle === 'function' && !origHandle.__qgate) {
    const patched = function handleInboundMessage(...args) {
      try {
        registerBot(this, state)
      } catch (err) {
        log(`[hook] registerBot(handle) 失败: ${String(err?.message ?? err)}`)
      }
      return origHandle.apply(this, args)
    }
    patched.__qgate = true
    proto.handleInboundMessage = patched
  }

  if (typeof origUse !== "function" && typeof origHandle !== "function") {
    state.hookError = 'no-hook-target'
    return { ok: false, error: state.hookError }
  }

  // 钩 3：出站过滤（2026-11-04 事故后加）—— 见 outguard.js 的文件头
  try {
    installOutGuard(proto, opts.outguard ?? {}, log, state)
  } catch (err) {
    log(`[hook] 出站过滤装失败（不影响入站门槛）: ${String(err?.message ?? err)}`)
  }

  // 钩 4：分段发送。**必须排在 outguard 之后** —— patch 是叠加的，后装的包在外层，
  // 我们要的是 splitter(外，切段) → outguard(内，挡内部输出) → 原方法(发)。
  // 顺序反了的话，过滤会先看到整段长文，命中就整条吞掉，分段没机会（见 splitter.js 头注释）。
  try {
    // 传 getter：每次发送时读 state.splitCfg，设置页里开关立刻生效，不用重载
    const r = installSplitter(proto, () => state.splitCfg ?? {}, log, state)
    if (r?.ok && !r.already) log('[hook] 分段发送已装上（在出站过滤外层）')
  } catch (err) {
    log(`[hook] 分段发送装失败（不影响其他功能）: ${String(err?.message ?? err)}`)
  }

  // 钩 5：出站留档。装在**最外层**，记下的就是最终交给发送方法的那段文本 ——
  // 用来验证中间层（或平台）有没有改写我们的输出。只记录，不改内容。
  try {
    const r = installOutLog(proto, () => state.outLogCfg ?? {}, log, state)
    if (r?.ok && !r.already) log('[hook] 出站留档已装上（最外层，只记录不修改）')
  } catch (err) {
    log(`[hook] 出站留档装失败（不影响发送）: ${String(err?.message ?? err)}`)
  }

  state.hooked = true
  state.hookVia = loaded.via
  state.hookError = null // 清掉上一次失败留下的残留，否则状态文件里会自相矛盾
  return { ok: true, via: loaded.via }
}

/**
 * 给出站方法套一层过滤。只管**文本**类发送：sendText / sendMarkdown。
 * 拿不到返回类型就不猜，命中时返回一个空对象（调用方只会以为发成功了）。
 *
 * @param {object} proto QQBot.prototype
 * @param {{enabled?:boolean, patterns?:string[], blockLog?:string}} cfg
 * @param {(msg:string)=>void} log
 * @param {object} state
 */
export function installOutGuard(proto, cfg, log, state) {
  if (!proto) return { ok: false, error: 'no-proto' }
  if (cfg?.enabled === false) return { ok: false, already: true, reason: 'disabled' }

  const { patterns, literals } = compilePatterns(cfg?.patterns ?? [])
  const check = (text) => shouldBlock(text, { patterns: patterns.length > 0 ? [...patterns, ...DEFAULT_PATTERNS] : undefined, extra: literals })

  const hit = (method, content) => {
    const r = check(content)
    if (!r.blocked) return false
    state.blocked = (state.blocked ?? 0) + 1
    state.lastBlockedAt = Date.now()
    state.lastBlockedReason = r.reason
    try {
      log(`[outguard] 拦下 ${method}（${r.reason}）: ${String(content).slice(0, 80).replace(/\n/g, ' ')}`)
    } catch {
      /* ignore */
    }
    return true
  }

  for (const method of ['sendText', 'sendMarkdown']) {
    const orig = proto[method]
    if (typeof orig !== 'function' || orig.__qgateOut) continue
    const patched = function patchedSend(target, content, ...rest) {
      try {
        if (hit(method, content)) return Promise.resolve({ blocked: true })
      } catch {
        /* 过滤自己出错就放行，别把正常消息卡住 */
      }
      return orig.call(this, target, content, ...rest)
    }
    patched.__qgateOut = true
    proto[method] = patched
  }
  state.outGuardInstalled = true
  return { ok: true }
}

/**
 * 自检：钩子装好之后，确认「真的抓到了 bot，而且真的插进了链里」。
 * 这是把"patch 无效但静默工作"变成"看得见的告警"的那一步。
 */
export function selfCheck(state = gateRuntime()) {
  return {
    hooked: state.hooked,
    via: state.hookVia,
    error: state.hookError,
    instances: state.instances,
    ok: state.hooked && state.instances > 0,
  }
}
