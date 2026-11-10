/**
 * outlog.js —— 出站留档：记下「我到底发了什么」，用来验证中间层有没有改写。
 *
 * 起因：2026-11-10 有人转了个视频，说 QQ 会把机器人的输出「清洗/转述」一遍再发。
 * 光靠嘴说没用，得能比对。这一层只记录、不修改任何内容，挂在出站 patch 链的**最外层**
 * （splitter → outguard → 原方法，outlog 再包住 splitter），
 * 所以它记下的就是**最终交给发送方法的那一段文本**。
 *
 * 存什么：不存全文（怕状态文件太大），存
 *   - sha：原样 sha256 前 16 位
 *   - shaNorm：去掉所有空白后的 sha256 前 16 位（应对客户端/换行差异）
 *   - head / tail：首尾各 24 字（人眼一看就能认出是哪条）
 *   - len：字符数
 * 主人把手机上收到的内容贴回来，算同样两个 hash 一比就知道动没动过。
 */

import { createHash } from 'node:crypto'

const MAX_ENTRIES = 40

function digest(text, normalize) {
  const s = normalize ? String(text).replace(/\s+/g, '') : String(text)
  return createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16)
}

/**
 * @param {object} proto QQBot.prototype
 * @param {object|(() => object)} cfgOrGetter 预留（现在恒开，保留形状方便以后加开关）
 * @param {(msg: string) => void} log
 * @param {object} state 共享运行时状态（跨热重载）
 */
export function installOutLog(proto, cfgOrGetter, log = () => {}, state = {}) {
  if (!proto) return { ok: false, error: 'no-proto' }
  const getCfg = typeof cfgOrGetter === 'function' ? cfgOrGetter : () => cfgOrGetter ?? {}

  const orig = proto.sendMarkdown
  if (typeof orig !== 'function') return { ok: false, error: 'no-sendMarkdown' }
  if (orig.__qgateOutLog) return { ok: true, already: true }

  const patched = async function sendMarkdownLogged(target, content, ...rest) {
    try {
      let cfg = {}
      try {
        cfg = { ...(getCfg() ?? {}) }
      } catch {
        cfg = {}
      }
      if (cfg.enabled !== false) {
        const text = String(content ?? '')
        if (text) {
          const entry = {
            at: new Date().toISOString(),
            scope: target && typeof target === 'object' ? String(target.scope ?? '') : '',
            len: text.length,
            sha: digest(text, false),
            shaNorm: digest(text, true),
            head: text.slice(0, 24),
            tail: text.length > 24 ? text.slice(-24) : '',
          }
          const list = state.outLog ?? (state.outLog = [])
          list.push(entry)
          if (list.length > MAX_ENTRIES) list.splice(0, list.length - MAX_ENTRIES)
          state.outCount = (state.outCount ?? 0) + 1
          // 让状态文件尽快落盘（调用方自己会节流，这里不重复管）
          try {
            state.onOutLog?.(entry)
          } catch {
            /* 通知失败不影响发送 */
          }
        }
      }
    } catch (err) {
      // 记录失败绝不影响发送本身
      try {
        log(`[outlog] 记录失败（不影响发送）: ${err && err.message ? err.message : String(err)}`)
      } catch {
        /* ignore */
      }
    }

    return orig.call(this, target, content, ...rest)
  }

  patched.__qgateOutLog = true
  proto.sendMarkdown = patched

  return { ok: true }
}
