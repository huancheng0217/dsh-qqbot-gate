/**
 * outguard.js —— 出站过滤：把「内部维护任务的输出」挡在群里之外。
 *
 * 背景（2026-11-04 事故）：
 *   记忆插件的 dream 用 steer 往当前会话注入指令，agent 的回复就是用户可见输出。
 *   QQ 群会话空闲 3 小时也会跑 dream，于是「记完了。这一轮落下的东西…」直接发进群，
 *   连工具报错 `FsError: FS_EDIT_NOT_FOUND` 都一起出去了。
 *
 * 这一层是**兜底**：真出问题（上下文被压缩、提示词被冲掉）时，靠代码拦住。
 * 治本的那层是给 QQ 会话打 dream_skip（见 _qqbot_dream_skip.py）。
 *
 * 设计取舍：
 *   - 只挡**几乎不可能出现在正常聊天里**的特征，宁可漏也不误杀。
 *   - 不挡普通词（比如「记忆」），那会误伤群友的正常发言。
 *   - 命中时**丢弃并记日志**，不抛错、不回复用户，静默得像没发生。
 */

/** 命中任一即丢弃。保持短、专、几乎不可能误伤。 */
export const DEFAULT_PATTERNS = [
  // 记忆插件自己的标记
  /\[meow-memory-reflect\]/i,
  /\[meow-memory-dream\]/i,
  // dream / reflect 任务的标准收尾话术
  /这一轮落下的东西/,
  /本组整理完成/,
  /记忆已写入（/,
  /^\s*记完了[。.]/,
  /^\s*已记下[：:]/,
  // 工具报错与文件系统错误
  /FsError/,
  /FS_EDIT_NOT_FOUND/,
  /工具\s*\w+\s*执行失败/,
  /unhandled (?:rejection|exception)/i,
  // Windows 绝对路径（群聊里不该出现；群里只说「我的房间」，不说目录名）
  // 前面的边界把 URL 里的 `p://` 排除掉了
  /(?:^|[\s（(：:，,])[A-Za-z]:[\\/]/,
]

/**
 * 判断一段出站文本是否该被拦下。
 * @param {string} text
 * @param {{patterns?: RegExp[], extra?: string[]}} [opts]
 * @returns {{blocked: boolean, reason?: string}}
 */
export function shouldBlock(text, opts = {}) {
  const s = String(text ?? '')
  if (!s.trim()) return { blocked: false }
  const patterns = Array.isArray(opts.patterns) && opts.patterns.length > 0 ? opts.patterns : DEFAULT_PATTERNS
  for (const re of patterns) {
    try {
      if (re.test(s)) return { blocked: true, reason: String(re) }
    } catch {
      /* 配置里写错的正则跳过，不影响其他规则 */
    }
  }
  // 额外的字面量模式（配置里填的字符串）
  for (const raw of opts.extra ?? []) {
    const needle = String(raw ?? '').trim()
    if (needle && s.includes(needle)) return { blocked: true, reason: `literal:${needle}` }
  }
  return { blocked: false }
}

/**
 * 把配置里的字符串编译成正则，编译不了的当字面量。
 * @param {string[]} list
 */
export function compilePatterns(list) {
  const out = []
  const literals = []
  for (const raw of Array.isArray(list) ? list : []) {
    const s = String(raw ?? '').trim()
    if (!s) continue
    // 以 / 开头结尾的当正则，其余当字面量
    if (s.startsWith('/') && s.lastIndexOf('/') > 0) {
      const body = s.slice(1, s.lastIndexOf('/'))
      const flags = s.slice(s.lastIndexOf('/') + 1) || ''
      try {
        out.push(new RegExp(body, flags))
      } catch {
        literals.push(s)
      }
    } else {
      literals.push(s)
    }
  }
  return { patterns: out, literals }
}
