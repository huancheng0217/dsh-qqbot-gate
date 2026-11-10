/**
 * 运行时状态落盘 —— 让"门槛到底活没活、吞了多少条、为什么吞"变成能直接打开看的东西。
 *
 * 为什么不只靠日志：桌面版宿主的 console 输出不一定落到能翻的文件里，
 * 而排障最需要的恰恰是"插件在那儿吗"。写一份 JSON 到 dsh-qqbot 自己的数据目录，
 * 顺带也是主人能自己看的运维面板。
 *
 * 全部失败静默：状态写不出去，绝不能影响消息收发。
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const STATUS_DIR = join(homedir(), '.dsh-qqbot')
export const STATUS_FILE = join(STATUS_DIR, 'gate-status.json')

/**
 * @param {{ intervalMs?: number, maxRecent?: number, now?: () => number }} [opts]
 */
export function createStatusWriter(opts = {}) {
  const intervalMs = opts.intervalMs ?? 2000
  const maxRecent = opts.maxRecent ?? 40
  const now = opts.now ?? (() => Date.now())

  let snapshot = () => ({})
  let recent = []
  let timer = null
  let lastError = null
  let writes = 0

  const flush = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    try {
      mkdirSync(STATUS_DIR, { recursive: true })
      const payload = {
        ...snapshot(),
        updatedAt: new Date(now()).toISOString(),
        writes: writes + 1,
        lastError,
        recent: recent.slice(-maxRecent),
      }
      const tmp = `${STATUS_FILE}.tmp`
      writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
      renameSync(tmp, STATUS_FILE) // 原子替换，读的人不会看到写了一半的文件
      writes += 1
    } catch (err) {
      lastError = String(err?.message ?? err)
    }
  }

  const schedule = () => {
    if (timer !== null) return
    timer = setTimeout(() => {
      timer = null
      flush()
    }, intervalMs)
    if (typeof timer?.unref === 'function') timer.unref()
  }

  return {
    STATUS_FILE,
    setSnapshot(fn) {
      if (typeof fn === 'function') snapshot = fn
    },
    /** 给设置页读的即时快照（不落盘，不节流） */
    snapshot() {
      return { recent: recent.slice(-maxRecent), lastError }
    },
    /** 记一条最近的判定记录（最新的一定写进去） */
    record(entry) {
      recent.push({ at: new Date(now()).toISOString(), ...entry })
      if (recent.length > maxRecent * 2) recent = recent.slice(-maxRecent)
      schedule()
    },
    flush,
    dispose() {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      flush()
    },
  }
}
