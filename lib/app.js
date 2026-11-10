/**
 * dsh-qqbot-gate —— 给 QQ 机器人加两道门
 *
 *   门一「攒着说」：连发的几条消息合并成一次请求（防抖收口）
 *   门二「该不该说」：群聊里按 @/点名/主人/提问打分/兴趣概率/冷却/疲劳决定要不要接话
 *
 * 落点：把**一个**中间件插到 QQBot 中间件链的最外层（index 0）。
 *   - 在 index 0 而不是"mentionGate 之前第 N 个"，是为了不依赖官方中间件的排列顺序，
 *     官方插件升级加减中间件时我们不受影响。
 *   - 「不说话」不靠我们自己 stop：把决定写进 `ctx.state.policy.group.requireMention`，
 *     由官方 mentionGate 执行。这是 SDK 文档化的策略注入点（middleware/types.d.ts 里
 *     明确写着 "set by an upstream policy injector middleware"），比我们自己拦截更稳。
 *   - 「说话」时我们在链头直接 next()，后面的 historyBuffer / contentSanitizer /
 *     slashCommand / concurrencyGuard 全部照常工作。
 *
 * 门二只在 `mode: gate` 时生效；默认 `mode: debounce` —— 先把「攒着说」跑稳，再开筛选。
 */

import { DEFAULTS, describeMode, normalizeConfig } from './config.js'
import { createCollector } from './collect.js'
import { createMediaCollector } from './collect-media.js'
import { Debouncer } from './debounce.js'
import { bumpCount, createGateState, decide, recordAnswer, wasMentioned } from './gate.js'
import { gateRuntime, installHook, selfCheck } from './hook.js'
import { formatBackground } from './inject.js'
import { groupIdOf, stripMention } from './merge.js'
import { createStatusWriter } from './status.js'
import { CONFIG_FILE, readOverrides, writeOverrides } from './store.js'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

/**
 * 工作区根目录：从本文件位置往上退两级（`<工作区>/_plugins/<插件>/lib/app.js`）。
 * 推导不出来时返回 null，调用方自己兜底。
 */
function workspaceRoot() {
  try {
    const here = fileURLToPath(import.meta.url)
    const pluginDir = dirname(dirname(here))
    const parent = dirname(pluginDir)
    return dirname(parent).length > 3 ? dirname(parent) : null
  } catch {
    return null
  }
}

/**
 * 拾荒目录的默认值：**工作区下的 `_qqbot捡到的`**。
 *
 * 为什么不用 `process.cwd()`：宿主是 Electron 应用，它的 cwd 通常在安装目录，
 * 那里既不该写、也不在 `qqbot_send_file` 的路径白名单里（白名单 = media 目录 + agent cwd）。
 * 装到哪个工作区，图就存在哪个工作区；推导不出来时回退 cwd。
 */
function defaultCollectRoot() {
  const root = workspaceRoot()
  return root ? join(root, '_qqbot捡到的') : join(process.cwd(), '_qqbot捡到的')
}

export const name = 'dsh-qqbot-gate'
export const inject = []

const LOG_PREFIX = '[qgate]'

/** 全角斜杠也当命令放行 */
function isCommandText(text) {
  const t = String(text ?? '').trim()
  return t.startsWith('/') || t.startsWith('／')
}

/** 缓冲键：群聊默认按发言人分开，避免把两个人的话拼成一条 */
export function bufferKey(msg, isGroup, cfg) {
  if (!isGroup) return `c2c:${msg.senderId ?? 'unknown'}`
  const groupId = groupIdOf(msg) || 'unknown'
  const who = cfg.groupMergeAcrossSenders ? '*' : (msg.senderId ?? 'unknown')
  return `group:${groupId}:${who}`
}

function hasAttachments(msg) {
  return Array.isArray(msg?.attachments) && msg.attachments.length > 0
}

function shortText(text, max = 40) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/** 两个「炼化」笔记：读文件头部的 `上次炼化：YYYY-MM-DD`，算多久没动了 */
const FORGE_FILES = [
  { name: '说话', rel: '_说话.md' },
  { name: '人际日记', rel: join('鲸鱼女仆画廊', '_人际日记.md') },
]

/**
 * @param {string|null} root 工作区根
 * @returns {{ items: Array<{name: string, lastAt: string|null, daysAgo: number|null}>, days: number|null, overdue: boolean, limit: number }}
 */
export function readForge(root, limit) {
  const items = []
  let worst = null
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  for (const f of FORGE_FILES) {
    let lastAt = null
    let daysAgo = null
    try {
      const head = root ? readFileSync(join(root, f.rel), 'utf8').slice(0, 800) : ''
      const m = /上次炼化[：:]\s*\**\s*(\d{4}-\d{2}-\d{2})/.exec(head)
      if (m) {
        lastAt = m[1]
        const d = new Date(`${lastAt}T00:00:00`)
        if (Number.isFinite(d.getTime())) daysAgo = Math.round((today - d) / 86_400_000)
      }
    } catch {
      /* 读不到就当没记过 */
    }
    items.push({ name: f.name, lastAt, daysAgo })
    if (daysAgo === null) worst = Number.POSITIVE_INFINITY
    else if (worst !== Number.POSITIVE_INFINITY) worst = worst === null ? daysAgo : Math.max(worst, daysAgo)
  }
  return {
    items,
    days: Number.isFinite(worst) ? worst : null,
    overdue: worst === Number.POSITIVE_INFINITY || (Number.isFinite(worst) && worst > limit),
    limit,
  }
}

/**
 * 造出真正干活的那一层中间件（不含钩子、不含生命周期）。
 * 单独导出是为了能在测试里直接塞进一条真/假中间件链跑，不用装进宿主机。
 *
 * @param {{ cfg: object, log?: (level: string, message: string) => void, now?: () => number, status?: object }} options
 */
export function createMiddleware(options) {
  const cfg = options.cfg
  const log = options.log ?? (() => {})
  const now = options.now ?? (() => Date.now())
  const status = options.status ?? null

  const gateState = createGateState()
  const collector = createCollector({ cfg, now })
  const mediaCollector = createMediaCollector({
    cfg,
    root: cfg.collectDir || defaultCollectRoot(),
    now,
    log,
  })
  let appId = ''
  let lastFlush = null

  // 「上次炼化」状态：读文件是 I/O，60 秒缓存一次（设置页会频繁拉 state）
  const forgeRoot = workspaceRoot()
  let forgeCache = { at: 0, value: null }
  const forgeStatus = () => {
    const t = now()
    if (forgeCache.value && t - forgeCache.at < 60_000) return forgeCache.value
    const value = readForge(forgeRoot, Math.max(1, Math.round(Number(cfg.forgeRemindDays) || 7)))
    forgeCache = { at: t, value }
    return value
  }

  const debouncer = new Debouncer({
    cfg,
    now,
    onFlush: (why, batch) => {
      lastFlush = { why, at: now(), count: batch.count }
      if (cfg.debug || batch.count > 1) {
        log('info', `收口(${why}) key=${batch.key} 条数=${batch.count} 用时=${batch.lastTs - batch.firstTs}ms`)
      }
      status?.record({ kind: 'flush', why, count: batch.count, key: batch.key })
    },
  })

  /** 把「要不要回」写进官方 mentionGate 会读的 policy 槽 */
  const setPolicy = (mctx, requireMention) => {
    if (!cfg.takeOverMentionGate) return
    try {
      mctx.state.policy ??= {}
      mctx.state.policy.group ??= {}
      mctx.state.policy.group.requireMention = requireMention
    } catch {
      /* state 不可写就退化成"不接管"，不影响消息本身 */
    }
  }

  const middleware = async (mctx, next) => {
    if (cfg.mode === 'off') return next()

    const msg = mctx?.message
    if (!msg) return next()

    try {
      appId = mctx?.bot?.appId ?? appId
      debouncer.appId = appId

      const ts = now()
      const isGroup = msg.kind === 'group'

      // ── 直通：斜杠命令不缓冲，否则 /stop 也要等三秒 ──
      if (isCommandText(stripMention(msg.content, appId))) {
        if (cfg.debug) log('debug', `直通命令: ${shortText(msg.content)}`)
        return next()
      }

      // ── 门三（旁听）：群消息先记一份 ──
      // 必须放在门二之前：被门槛挡下的那些消息才是最需要旁听的
      // （挡下 = 不进 agent = 那一轮我什么都看不到）。
      if (isGroup) {
        try {
          collector.record(msg, appId)
        } catch (err) {
          log('warn', `旁听记录失败: ${err instanceof Error ? err.message : String(err)}`)
        }
        // 拾荒：带图的消息顺手存一份（fire-and-forget，绝不阻塞这条消息）
        if (cfg.collectEnabled && hasAttachments(msg)) {
          mediaCollector
            .collect(msg)
            .then((res) => {
              if (res.saved > 0) status?.record({ kind: 'collect', group: groupIdOf(msg), count: res.saved })
            })
            .catch((err) => log('warn', `拾荒异常: ${err instanceof Error ? err.message : String(err)}`))
        }
      }

      // ── 门二：该不该说（只在 gate 模式、只在群里）──
      if (cfg.mode === 'gate' && isGroup) {
        const verdict = decide(msg, cfg, gateState, { appId, now: ts })

        if (!verdict.answer) {
          bumpCount(gateState, verdict.reason)
          setPolicy(mctx, true) // ← 交给官方 mentionGate 挡下（historyBuffer 照常记账）
          log('info', `不回(${verdict.reason}) 群=${groupIdOf(msg)} 人=${msg.senderName ?? msg.senderId} 文本="${shortText(msg.content)}"`)
          status?.record({
            kind: 'skip',
            reason: verdict.reason,
            score: verdict.score,
            group: groupIdOf(msg),
            sender: msg.senderName ?? msg.senderId,
            text: shortText(msg.content, 60),
          })
          return next()
        }

        recordAnswer(gateState, msg, ts)
        setPolicy(mctx, false)
        status?.record({
          kind: 'answer',
          reason: verdict.reason,
          score: verdict.score,
          group: groupIdOf(msg),
          sender: msg.senderName ?? msg.senderId,
          text: shortText(msg.content, 60),
        })
        if (cfg.debug) {
          log('debug', `回(${verdict.reason}${verdict.score !== undefined ? ` score=${verdict.score}` : ''}) ${shortText(msg.content)}`)
        }
      }

      // ── 门一：攒着说 ──
      const key = bufferKey(msg, isGroup, cfg)
      const result = await debouncer.push(key, {
        text: msg.content,
        senderName: msg.senderName,
        senderId: msg.senderId,
        msgId: msg.messageId,
        hasAttachments: hasAttachments(msg),
      })

      if (!result?.survivor) {
        // 被吸收进同一批：不往下走，链到此为止（不会产生第二次 agent 请求）
        return
      }

      // 幸存者统一改写 content：
      //   - 多条 → 合并文本
      //   - 单条 → 仍然是清洗后的文本（剥掉指向本 bot 的 @ 标记）
      // 下游的 contentSanitizer 还会再洗一遍（表情标签等），这里不代替它，
      // 只是保证「即使下游少了那一层，@ 标记也不会漏进 agent」。
      if (typeof result.merged === 'string') {
        if (msg.content !== result.merged) msg.content = result.merged
        if (cfg.debug && result.batch && result.batch.count > 1) {
          log('debug', `合并 ${result.batch.count} 条 → "${shortText(result.merged, 80)}"`)
        }
      }

      // ── 门三（旁听）：真的要被 agent 看到了，把刚才那段闲聊当背景补上 ──
      // 只在 gate 模式做，两个理由：
      //   1. debounce 模式下每条群消息都会进 agent，每条都带背景等于白白多烧 token；
      //   2. 而且「游标 + before」会让它压根没有可注入的 —— 上一个回合已经把内容给过了。
      // @ 的时候也不注入 —— 官方 buildAgentBody 自己会带群历史，再来一份就重复了。
      if (isGroup && cfg.injectEnabled && cfg.mode === 'gate') {
        try {
          if (!wasMentioned(msg, appId)) {
            // before = 这一批的起点：把「正在处理的这几条」排掉，
            // 否则它们会在背景里出现一遍、正文里又出现一遍
            const bg = collector.takeBackground(groupIdOf(msg), {
              now: ts,
              before: result.batch?.firstTs ?? ts,
            })
            const text = formatBackground(bg.entries, cfg)
            if (text) {
              msg.content = `${text}${String(msg.content ?? '')}`
              collector.bump('injected')
              collector.bump('injectedEntries', bg.entries.length)
              if (bg.truncated) collector.bump('truncated')
              status?.record({
                kind: 'inject',
                group: groupIdOf(msg),
                count: bg.entries.length,
                chars: text.length,
                truncated: bg.truncated || undefined,
              })
              log('info', `注入旁听 key=${groupIdOf(msg)} 条数=${bg.entries.length} 字数=${text.length}${bg.truncated ? ' (超上限已截断)' : ''}`)
            }
          }
        } catch (err) {
          log('warn', `旁听注入失败: ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      return next()
    } catch (err) {
      // 兜底：任何意外都放行，宁可多回一句也不能把消息吞掉
      log('warn', `处理异常，放行本条: ${err instanceof Error ? err.message : String(err)}`)
      try {
        return await next()
      } catch (nextErr) {
        log('error', `下游异常: ${nextErr instanceof Error ? nextErr.message : String(nextErr)}`)
      }
    }
  }

  middleware.__qgateMiddleware = true

  return {
    middleware,
    debouncer,
    gateState,
    /** 当前生效配置的快照（给 GUI 读） */
    config: () => ({ ...cfg }),
    /**
     * 热应用新配置：**原地**改 cfg 的字段，而不是换个新对象 ——
     * debouncer / 中间件闭包 / describe 里抓的都是这个引用，原地改才能一处生效全局可见。
     */
    updateConfig: (mergedRaw) => {
      const next = normalizeConfig(mergedRaw)
      Object.assign(cfg, next)
      return cfg
    },
    describe: () => ({
      mode: cfg.mode,
      // 关键参数进状态文件：以后确认"配置到底生效没"不用再翻 patch
      debounceSeconds: cfg.debounceSeconds,
      maxWaitSeconds: cfg.maxWaitSeconds,
      maxMergeMessages: cfg.maxMergeMessages,
      imageDebounceSeconds: cfg.imageDebounceSeconds,
      pendingBatches: debouncer.size,
      lastFlush,
      counts: Object.fromEntries(gateState.counts),
      // 旁听：注入到底生效没有，看这几个数就行
      inject: {
        enabled: cfg.injectEnabled,
        windowMinutes: cfg.injectWindowMinutes,
        maxMessages: cfg.injectMaxMessages,
        ...collector.stats(),
      },
      // 拾荒：存了几张、跳过几张、当前目录
      collect: {
        enabled: cfg.collectEnabled,
        dir: mediaCollector.imagesDir,
        ...mediaCollector.stats(),
      },
      // 两个笔记多久没炼了（对应教训「记下来 ≠ 处理掉」）
      forge: forgeStatus(),
    }),
  }
}

export function apply(ctx, rawConfig) {
  const patchConfig = rawConfig && typeof rawConfig === 'object' ? rawConfig : {}
  // GUI 保存的那份（~/.dsh-qqbot/gate-config.json）优先于 patch：
  // 调一个秒数不该为了改配置去触发 Loader 热更新、把 QQ 网关重连一次
  const initialOverrides = readOverrides()
  const cfg = normalizeConfig({ ...patchConfig, ...initialOverrides.data })
  const baseLogger = ctx?.logger ?? console
  const log = (level, message) => {
    try {
      const fn = typeof baseLogger?.[level] === 'function' ? baseLogger[level].bind(baseLogger) : console.log
      fn(`${LOG_PREFIX} ${message}`)
    } catch {
      /* 日志失败绝不影响收发 */
    }
  }

  const runtime = gateRuntime()
  // 分段发送的配置放这里：hook 侧每次发送时读它，所以设置页开关热生效、不用重载
  runtime.splitCfg = cfg.splitter
  let core = null
  const status = createStatusWriter()
  status.setSnapshot(() => ({
    plugin: name,
    enabled: cfg.enabled,
    ...(core?.describe() ?? {}),
    hook: selfCheck(),
    // 出站留档：最近发出的文本指纹（只记 hash/首尾，不存全文），
    // 用来验证中间层有没有改写我们的输出
    outCount: runtime.outCount ?? 0,
    outLog: runtime.outLog ?? [],
    statusFile: status.STATUS_FILE,
  }))

  // 出站每记一条就让状态文件尽快落盘（500ms 内最多一次，别每句都写盘）
  let lastOutFlush = 0
  runtime.onOutLog = () => {
    const now = Date.now()
    if (now - lastOutFlush < 500) return
    lastOutFlush = now
    status.flush()
  }

  core = createMiddleware({ cfg, log, status })

  // 热重载时链上那个 wrapper 不动，只把它调用的实现换掉。
  // enabled=false 时 router 也要照样注册 —— 否则用户从 GUI 关掉之后就没入口再打开了。
  if (cfg.enabled) {
    runtime.factory = core.middleware
  } else {
    runtime.factory = null
    log('info', 'enabled=false —— 不挂中间件（「设置 → 回话门槛」里可以重新打开）')
  }
  runtime.describe = () => ({ ...core.describe(), hook: selfCheck() })

  // GUI 的读写口（内部用 ctx.inject 等 webServer 就绪，拿不到就静默跳过，其余功能照常）
  registerApiRoutes(ctx, { core, patchConfig, status, log })

  ctx.effect(() => () => {
    if (runtime.factory === core.middleware) runtime.factory = null
    core.debouncer.dispose()
    status.dispose()
  })

  log('info', `模式=${cfg.mode}（${describeMode(cfg.mode)}） 防抖=${cfg.debounceSeconds}s 硬上限=${cfg.maxWaitSeconds}s 合并上限=${cfg.maxMergeMessages}`)

  // 钩子异步装（要动态 import SDK），不阻塞插件激活
  void installHook({ log: (m) => log('info', m), outguard: cfg.outguard, splitter: cfg.splitter })
    .then((result) => {
      if (!result.ok) {
        log('warn', `钩子未装上（${result.error}）—— 门槛不会生效，机器人本身不受影响。`
          + '常见原因：本插件与 dsh-qqbot 加载的不是同一份 SDK 模块。')
        return
      }
      if (!result.already) log('info', `钩子已装上 via=${result.via}`)
      // 钩子装好时 dsh-qqbot 可能已经建好 bot 并跑完注册；那种情况要等第一条
      // 消息到达时由 handleInboundMessage 钩子抓住 —— 抓到的瞬间就插到链头，
      // 而链是在原方法体里现拼的，所以连那第一条消息也会经过我们。
      const check = selfCheck()
      log('info', check.ok
        ? `已接管 ${check.instances} 个 bot 实例`
        : '钩子就绪，等第一个 bot 实例（下一条 QQ 消息到达时会自动注册）')
      status.flush() // 没消息也要留一份可读的状态，排障时先看这个文件
    })
    .catch((err) => log('warn', `钩子安装异常: ${err instanceof Error ? err.message : String(err)}`))

  // 兜底清理：正常情况下 hardTimer 会在 12 秒内收口，这里只防极端情况（计时器被饿死）
  const sweepTimer = setInterval(() => {
    try {
      core.debouncer.sweep()
    } catch {
      /* 忽略 */
    }
  }, 60_000)
  if (typeof sweepTimer?.unref === 'function') sweepTimer.unref()
  ctx.effect(() => () => clearInterval(sweepTimer))
}

// ─────────────────────────────────────────────────────────────
// GUI 的 HTTP 读写口
//
// 为什么 GUI 不直接改 profile 的 cordis.patch.yml：改那个文件会触发 Loader 热更新，
// 整个 QQ 插件被重建、网关重连一次 —— 调一个秒数付这个代价太贵。
// 所以参数存在 ~/.dsh-qqbot/gate-config.json，保存后由插件内部 updateConfig 热应用。
// ─────────────────────────────────────────────────────────────

const API_PREFIX = '/qqbot-gate/api/'

/** 可写键白名单：只收 DEFAULTS 里有的键，防止 POST 里混进垃圾字段污染配置 */
const EDITABLE_KEYS = new Set(Object.keys(DEFAULTS))

function sendJson(res, code, payload) {
  try {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(payload))
  } catch {
    try {
      res.destroy()
    } catch {
      /* 连接已经断了 */
    }
  }
}

function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        try {
          req.destroy()
        } catch {
          /* ignore */
        }
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8').trim()
        resolve(text ? JSON.parse(text) : {})
      } catch (err) {
        reject(new Error(`JSON 解析失败: ${err?.message ?? err}`))
      }
    })
    req.on('error', reject)
  })
}

function isLoopbackReq(req) {
  const host = String(req?.headers?.host ?? '').toLowerCase()
  const bare = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
  return bare === '127.0.0.1' || bare === 'localhost' || bare === '[::1]' || bare === '::1'
}

/**
 * 信任栅栏：DSH 的 Web 端口是回环地址，但浏览器里任何网页都能向回环发请求，
 * 所以写配置这条口必须校验来源 + 登录态，栅栏不可用时 fail-closed。
 */
function makeGuard(ctx) {
  // 2026-11-04 修：原来这里在**注册路由时**抓一次 `connection` 快照。
  // 但插件加载顺序一变（比如新装了一个插件），connection 可能比 webServer 晚就绪，
  // 快照就永远是 null → 设置页永久 503「信任栅栏不可用」。
  // 改成每次请求时再取：服务一旦注册就会一直在，晚一点也能自己好。
  const connectionOf = () => {
    try {
      return ctx.get('connection')
    } catch {
      return null
    }
  }

  const trusted = (req) => {
    if (isLoopbackReq(req)) return true
    try {
      const connection = connectionOf()
      if (connection && typeof connection.isTrusted === 'function') return connection.isTrusted(req) === true
    } catch {
      /* fallthrough */
    }
    return false
  }

  return function rejected(req, res) {
    if (!trusted(req)) {
      sendJson(res, 403, { ok: false, error: '不受信任的访问来源' })
      return true
    }
    try {
      const connection = connectionOf()
      if (!connection || typeof connection.requestRejection !== 'function') {
        sendJson(res, 503, { ok: false, error: '信任栅栏不可用，拒绝访问（fail-closed）' })
        return true
      }
      const code = connection.requestRejection(req)
      if (code === undefined || code === null || code === false) return false
      res.statusCode = typeof code === 'number' ? code : 403
      res.end()
      return true
    } catch {
      sendJson(res, 503, { ok: false, error: '信任栅栏异常，拒绝访问（fail-closed）' })
      return true
    }
  }
}

/**
 * @returns {Array<() => void>} 路由的 disposer 列表
 */
function registerApiRoutes(ctx, { core, patchConfig, status, log }) {
  // 不用顶层 inject：那会让 QQ 中间件也陪等 webServer，纯 headless 环境下门槛就彻底不生效。
  // 踩过的坑：DSH 重启后本插件先于 webserver 加载，ctx.get('webServer') 拿不到 →
  // 路由静默没注册 → 设置页报 HTTP 404。
  const attach = (scoped) => {
  const webServer = scoped?.webServer
  if (!webServer || typeof webServer.register !== 'function') {
    log('warn', 'webServer 不可用 —— 设置页的读写接口没注册（插件其余功能照常）')
    return
  }

  const rejected = makeGuard(scoped)
  const runtime = gateRuntime()

  const buildState = () => {
    const overrides = readOverrides()
    return {
      ok: true,
      config: core.config(),
      defaults: { ...DEFAULTS },
      patchConfig,
      overrides: overrides.data,
      overridesFile: CONFIG_FILE,
      overridesError: overrides.ok ? undefined : overrides.error,
      runtime: { ...core.describe(), hook: selfCheck() },
      recent: status.snapshot().recent,
      statusFile: status.STATUS_FILE,
    }
  }

  const handleState = async (req, res) => {
    sendJson(res, 200, buildState())
  }

  const handleSave = async (req, res) => {
    let body
    try {
      body = await readJsonBody(req)
    } catch (err) {
      sendJson(res, 400, { ok: false, error: String(err?.message ?? err) })
      return
    }

    const incoming = body && typeof body === 'object' && body.config && typeof body.config === 'object' ? body.config : body
    const saved = {}
    for (const [key, value] of Object.entries(incoming ?? {})) {
      if (EDITABLE_KEYS.has(key)) saved[key] = value
    }
    if (Object.keys(saved).length === 0) {
      sendJson(res, 400, { ok: false, error: '没有可保存的字段' })
      return
    }

    // 先规范化再落盘：GUI 传来的可能是字符串/越界值，写进文件的东西必须是干净的
    const normalized = normalizeConfig({ ...patchConfig, ...saved })
    const payload = {}
    for (const key of EDITABLE_KEYS) payload[key] = normalized[key]

    const written = writeOverrides(payload)
    if (!written.ok) {
      sendJson(res, 500, { ok: false, error: `写入配置失败: ${written.error}` })
      return
    }

    // 热应用：原地改 cfg，下一条消息就按新参数处理
    core.updateConfig({ ...patchConfig, ...payload })

    // 分段发送的配置同步给 hook 侧（它每次发送时读 runtime.splitCfg，所以这个一改也立刻生效）
    try {
      const latest = typeof core.config === 'function' ? core.config().splitter : null
      if (latest) runtime.splitCfg = latest
    } catch {
      /* 取不到就保持原样，不影响保存本身 */
    }

    // enabled 开关要同步到链上：关掉时把实现摘掉（wrapper 退化成直通），打开时装回
    const wasMounted = typeof runtime.factory === 'function'
    if (payload.enabled && !wasMounted) runtime.factory = core.middleware
    if (!payload.enabled && wasMounted) runtime.factory = null

    status.flush()
    log('info', `配置已从设置页更新：mode=${payload.mode} 防抖=${payload.debounceSeconds}s 上限=${payload.maxWaitSeconds}s`)
    sendJson(res, 200, { ok: true, ...buildState() })
  }

  const handleReset = async (req, res) => {
    // 恢复默认 = 删掉用户配置，回到 patch 里的出厂值
    const written = writeOverrides({})
    if (!written.ok) {
      sendJson(res, 500, { ok: false, error: `重置失败: ${written.error}` })
      return
    }
    core.updateConfig({ ...patchConfig })
    const mounted = runtime.factory === null && normalizeConfig({ ...patchConfig }).enabled
    if (mounted) runtime.factory = core.middleware
    status.flush()
    log('info', '设置页把配置恢复成 patch 默认值')
    sendJson(res, 200, { ok: true, ...buildState() })
  }

  const routes = [
    ['state', handleState],
    ['config', handleSave],
    ['reset', handleReset],
  ]

  const disposers = []
  for (const [name, handler] of routes) {
    try {
      disposers.push(webServer.register({
        kind: 'exact',
        path: `${API_PREFIX}${name}`,
        handler: async (req, res) => {
          if (rejected(req, res)) return
          try {
            await handler(req, res)
          } catch (err) {
            log('warn', `接口 ${name} 出错: ${err instanceof Error ? err.message : String(err)}`)
            sendJson(res, 500, { ok: false, error: String(err?.message ?? err) })
          }
        },
      }))
    } catch (err) {
      log('warn', `注册接口 ${name} 失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  scoped.effect(() => () => {
    for (const dispose of disposers) {
      try {
        dispose?.()
      } catch {
        /* 单个路由注销失败不影响其他清理 */
      }
    }
  })

  log('info', `设置页接口已注册：${API_PREFIX}state · config · reset`)
  }

  try {
    if (typeof ctx.inject === 'function') ctx.inject(['webServer'], attach)
    else attach(ctx)
  } catch (err) {
    log('warn', `注册设置页接口时出错: ${err instanceof Error ? err.message : String(err)}`)
  }
}
