/**
 * 配置归一化 —— 插件唯一的配置事实源。
 *
 * 不做 schema 校验（不引入 schemastery 依赖），只做「缺省填充 + 类型纠正 + 范围夹紧」，
 * 保证任何错配的 config 都退化成一个能跑的安全值，而不是让中间件在热路径上抛错。
 */

/** 名字/关键词一类的字符串数组：去空、去重、trim */
function strList(value) {
  if (!Array.isArray(value)) return []
  const out = []
  const seen = new Set()
  for (const raw of value) {
    if (typeof raw !== 'string') continue
    const s = raw.trim()
    if (!s) continue
    const k = s.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(s)
  }
  return out
}

/** 数字夹紧：非数字 → 默认值；低于 min → min；高于 max → max */
function num(value, fallback, min, max) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  if (n < min) return min
  if (n > max) return max
  return n
}

function bool(value, fallback) {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

export const DEFAULTS = {
  enabled: true,
  mode: 'debounce', // off | debounce | gate

  // ── 防抖 ──
  debounceSeconds: 3,
  maxWaitSeconds: 12,
  maxMergeMessages: 8,
  imageDebounceSeconds: 8,
  dedupeWindowSeconds: 30,

  // ── 群聊门槛 ──
  groupMode: 'open', // open | allowlist
  groupAllow: [],
  groupDeny: [],
  ownerOpenids: [],
  botNames: [],
  takeOverMentionGate: true,
  interestKeywords: [],
  interestProbability: 50, // 命中兴趣词时的接话概率
  ambientProbability: 9, // 没命中任何东西时的随机冒泡率
  questionThreshold: 65,
  cooldownSeconds: 90,
  fatigueLimit: 5,
  fatigueWindowSeconds: 300,
  coldGroupIdleMinutes: 0,
  groupMergeAcrossSenders: false,

  // ── 门三：旁听注入（把「没叫我那段时间」的群聊当背景补进 agent）──
  injectEnabled: true,
  injectWindowMinutes: 15, // 往回看多久
  injectMaxMessages: 30, // 最多几条
  injectMaxChars: 80, // 单条截断字数

  // ── 门三：拾荒采集（把群里带图的消息存下来）──
  collectEnabled: true,
  collectGroups: [], // 空 = 全部群
  collectMaxPerDay: 60, // 每天最多存几张
  collectMaxMB: 5, // 单图大小上限
  collectKeepDays: 7, // 保留天数
  collectDir: '', // 空 = <工作目录>/_qqbot捡到的
  forgeRemindDays: 7, // 两个笔记（_说话.md / _人际日记.md）超过几天没炼就标出来

  // ── 门四：出站过滤（挡内部维护输出、工具报错、Windows 路径）──
  outguardEnabled: true,

  // ── 门五：分段发送（按标点把一轮回复切成几条发）──
  // 用扁平字段和别的参数保持一致，normalizeConfig 末尾再组装成 splitter 对象给 hook 用
  splitEnabled: false, // 默认关，主人亲手打开
  splitMode: 'group', // off | group | all
  splitPattern: '.*?[。？！~…\\n]+|.+$', // 末尾的 \n 是必须的：不加会丢没有标点的整行（见 splitter.js 注释）
  splitMaxSegments: 3, // 上限 4 = ReplyLimiter limit，默认 3 留一次余量
  splitMinSegmentLength: 6,
  splitDelayMs: 300,
  splitSkipIfShorterThan: 20,
  splitSkipCodeAndTables: true,

  debug: false,
}

const MODES = new Set(['off', 'debounce', 'gate'])
const GROUP_MODES = new Set(['open', 'allowlist'])

export function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}

  const mode = MODES.has(src.mode) ? src.mode : DEFAULTS.mode
  const groupMode = GROUP_MODES.has(src.groupMode) ? src.groupMode : DEFAULTS.groupMode

  const cfg = {
    enabled: bool(src.enabled, DEFAULTS.enabled),
    mode,

    debounceSeconds: num(src.debounceSeconds, DEFAULTS.debounceSeconds, 0.5, 60),
    maxWaitSeconds: num(src.maxWaitSeconds, DEFAULTS.maxWaitSeconds, 1, 300),
    maxMergeMessages: Math.round(num(src.maxMergeMessages, DEFAULTS.maxMergeMessages, 1, 50)),
    imageDebounceSeconds: num(src.imageDebounceSeconds, DEFAULTS.imageDebounceSeconds, 0.5, 120),
    dedupeWindowSeconds: num(src.dedupeWindowSeconds, DEFAULTS.dedupeWindowSeconds, 0, 600),

    groupMode,
    groupAllow: strList(src.groupAllow),
    groupDeny: strList(src.groupDeny),
    ownerOpenids: strList(src.ownerOpenids),
    botNames: strList(src.botNames),
    takeOverMentionGate: bool(src.takeOverMentionGate, DEFAULTS.takeOverMentionGate),
    interestKeywords: strList(src.interestKeywords),
    interestProbability: num(src.interestProbability, DEFAULTS.interestProbability, 0, 100),
    ambientProbability: num(src.ambientProbability, DEFAULTS.ambientProbability, 0, 100),
    questionThreshold: num(src.questionThreshold, DEFAULTS.questionThreshold, 0, 200),
    cooldownSeconds: num(src.cooldownSeconds, DEFAULTS.cooldownSeconds, 0, 3600),
    fatigueLimit: Math.round(num(src.fatigueLimit, DEFAULTS.fatigueLimit, 0, 100)),
    fatigueWindowSeconds: num(src.fatigueWindowSeconds, DEFAULTS.fatigueWindowSeconds, 30, 3600),
    coldGroupIdleMinutes: num(src.coldGroupIdleMinutes, DEFAULTS.coldGroupIdleMinutes, 0, 1440),
    groupMergeAcrossSenders: bool(src.groupMergeAcrossSenders, DEFAULTS.groupMergeAcrossSenders),

    injectEnabled: bool(src.injectEnabled, DEFAULTS.injectEnabled),
    injectWindowMinutes: num(src.injectWindowMinutes, DEFAULTS.injectWindowMinutes, 1, 240),
    injectMaxMessages: Math.round(num(src.injectMaxMessages, DEFAULTS.injectMaxMessages, 1, 200)),
    injectMaxChars: Math.round(num(src.injectMaxChars, DEFAULTS.injectMaxChars, 20, 500)),

    collectEnabled: bool(src.collectEnabled, DEFAULTS.collectEnabled),
    collectGroups: strList(src.collectGroups),
    collectMaxPerDay: Math.round(num(src.collectMaxPerDay, DEFAULTS.collectMaxPerDay, 1, 1000)),
    collectMaxMB: num(src.collectMaxMB, DEFAULTS.collectMaxMB, 0.1, 50),
    collectKeepDays: Math.round(num(src.collectKeepDays, DEFAULTS.collectKeepDays, 1, 365)),
    collectDir: typeof src.collectDir === 'string' ? src.collectDir.trim() : DEFAULTS.collectDir,
    forgeRemindDays: Math.round(num(src.forgeRemindDays, DEFAULTS.forgeRemindDays, 1, 365)),

    debug: bool(src.debug, DEFAULTS.debug),

    // ── 门四：出站过滤 ──
    outguardEnabled: bool(src.outguardEnabled, DEFAULTS.outguardEnabled),

    // ── 门五：分段发送（扁平字段，和别的参数保持一致，GUI 才能存）──
    splitEnabled: bool(src.splitEnabled, DEFAULTS.splitEnabled),
    splitMode: ['off', 'group', 'all'].includes(src.splitMode) ? src.splitMode : DEFAULTS.splitMode,
    splitPattern: typeof src.splitPattern === 'string' && src.splitPattern
      ? src.splitPattern
      : DEFAULTS.splitPattern,
    splitMaxSegments: Math.round(num(src.splitMaxSegments, DEFAULTS.splitMaxSegments, 1, 4)),
    splitMinSegmentLength: Math.round(num(src.splitMinSegmentLength, DEFAULTS.splitMinSegmentLength, 1, 50)),
    splitDelayMs: Math.round(num(src.splitDelayMs, DEFAULTS.splitDelayMs, 0, 3000)),
    splitSkipIfShorterThan: Math.round(num(src.splitSkipIfShorterThan, DEFAULTS.splitSkipIfShorterThan, 1, 500)),
    splitSkipCodeAndTables: bool(src.splitSkipCodeAndTables, DEFAULTS.splitSkipCodeAndTables),
  }

  // 硬约束 1：硬上限不能比静默窗口还短，否则「一直说话的用户永远得不到回复」
  if (cfg.maxWaitSeconds < cfg.debounceSeconds) {
    cfg.maxWaitSeconds = cfg.debounceSeconds
  }
  // 硬约束 2：图片等待用来「等后续补充」，只需 >= 文本等待
  if (cfg.imageDebounceSeconds < cfg.debounceSeconds) {
    cfg.imageDebounceSeconds = cfg.debounceSeconds
  }

  // 运行时形态：hook 那边要的是对象，GUI 存的是上面的扁平字段。
  // 这两个不放进 DEFAULTS，所以不会被 EDITABLE_KEYS 当成可写项写回配置文件。
  cfg.outguard = { enabled: cfg.outguardEnabled, patterns: [] }
  cfg.splitter = {
    enabled: cfg.splitEnabled,
    mode: cfg.splitMode,
    pattern: cfg.splitPattern,
    maxSegments: cfg.splitMaxSegments,
    minSegmentLength: cfg.splitMinSegmentLength,
    delayMs: cfg.splitDelayMs,
    skipIfShorterThan: cfg.splitSkipIfShorterThan,
    skipCodeAndTables: cfg.splitSkipCodeAndTables,
  }

  return cfg
}

/** 三档模式的中文解释，日志与 README 共用 */
export function describeMode(mode) {
  if (mode === 'off') return '关（完全不管，等于没装）'
  if (mode === 'debounce') return '只防抖（把连发攒成一次，不筛内容）'
  return '防抖 + 群聊门槛（攒着说，且不是每句都说）'
}
