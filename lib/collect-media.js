/**
 * 拾荒采集 —— 把群里带图的消息存到本地，等主人在私聊窗口里挑着看。
 *
 * 只做「把料留下来」这一件事，不判断好不好玩（那是我在 agent 里干的事）。
 *
 * 四条硬约束：
 *   1. **永不阻塞消息链**：下载是 fire-and-forget，调用方 `.catch()` 掉就行。
 *   2. **只存图**：语音/视频/文件一律跳过（体积大、用处小、风险高）。
 *   3. **去重**：同一张图被转发 N 次只落一份（sha256 前 8 位当指纹）。
 *   4. **有账可查**：每存一张往 index.jsonl 追一行，主人可以直接打开看。
 *
 * 目录（默认）：
 *   _qqbot捡到的/index.jsonl   每行一条记录
 *   _qqbot捡到的/images/       20261104-013000-1a2b3c4d.png
 */

import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

/** 单次下载超时 */
const DOWNLOAD_TIMEOUT_MS = 15_000
/** 每分钟最多下载几张（防止某个群刷屏图把带宽打死） */
const MAX_PER_MINUTE = 10

/** 按魔数识别图片真实格式（QQ 给的 content_type 不可信） */
export function imageExtension(buf) {
  if (!buf || buf.length < 12) return null
  if (buf.subarray(0, 6).toString('latin1') === 'GIF87a' || buf.subarray(0, 6).toString('latin1') === 'GIF89a') return '.gif'
  if (buf.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return '.png'
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg'
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return '.webp'
  if (buf[0] === 0x42 && buf[1] === 0x4d) return '.bmp'
  return null
}

/** 这条消息里值得存的图（只认 image，且要有 url） */
export function pickImages(msg) {
  const list = Array.isArray(msg?.attachments) ? msg.attachments : []
  return list.filter((a) => {
    if (!a?.url) return false
    const ct = String(a.content_type ?? '')
    return ct === 'image' || ct.startsWith('image/')
  })
}

function pad(n) {
  return String(n).padStart(2, '0')
}

/** 20261104-013000 */
function stampOf(t) {
  const d = new Date(t)
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

function dayKeyOf(t) {
  return stampOf(t).slice(0, 8)
}

/**
 * @param {{ cfg: object, root: string, now?: () => number, log?: Function }} opts
 */
export function createMediaCollector(opts = {}) {
  const cfg = opts.cfg ?? {}
  const root = opts.root
  const now = opts.now ?? (() => Date.now())
  const log = opts.log ?? (() => {})

  const imagesDir = join(root, 'images')
  const indexFile = join(root, 'index.jsonl')

  /** sha8 集合：跨进程重启靠 index 重建，进程内靠这个 Set */
  const seen = new Set()
  const counters = { saved: 0, skipped: 0, failed: 0, bytes: 0 }

  let loaded = false
  let dayKey = ''
  let dayCount = 0
  let minuteKey = -1
  let minuteCount = 0
  let lastCleanupDay = ''

  function ensureDirs() {
    mkdirSync(imagesDir, { recursive: true })
  }

  /** 第一次用时读一遍 index：重建去重集合、今日计数，并顺手清理过期 */
  function loadOnce() {
    if (loaded) return
    loaded = true
    ensureDirs()
    const t = now()
    dayKey = dayKeyOf(t)
    if (!existsSync(indexFile)) return
    let text = ''
    try {
      text = readFileSync(indexFile, 'utf8')
    } catch (err) {
      log('warn', `读不到 index.jsonl: ${err?.message ?? err}`)
      return
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const row = JSON.parse(line)
        if (row.sha8) seen.add(row.sha8)
        if (String(row.ts).startsWith(`${dayKey.slice(0, 4)}-${dayKey.slice(4, 6)}-${dayKey.slice(6, 8)}`)) dayCount += 1
      } catch {
        /* 坏行跳过 */
      }
    }
  }

  /** 清理超过保留期的图 + 重写 index（一天最多跑一次） */
  function cleanupIfDue() {
    const t = now()
    const today = dayKeyOf(t)
    if (lastCleanupDay === today) return
    lastCleanupDay = today
    const keepDays = Math.max(1, Math.round(Number(cfg.collectKeepDays) || 7))
    const cutoff = t - keepDays * 86_400_000
    if (!existsSync(indexFile)) return

    const keptLines = []
    const keptSha = new Set()
    let removed = 0
    try {
      for (const line of readFileSync(indexFile, 'utf8').split('\n')) {
        if (!line.trim()) continue
        let row
        try {
          row = JSON.parse(line)
        } catch {
          continue
        }
        const ts = Date.parse(row.ts ?? '')
        if (Number.isFinite(ts) && ts < cutoff) {
          const path = row.file ? join(root, row.file) : ''
          if (path && existsSync(path)) {
            try {
              unlinkSync(path)
            } catch {
              /* 删不掉就留着，下次再说 */
            }
          }
          removed += 1
          continue
        }
        keptLines.push(line)
        if (row.sha8) keptSha.add(row.sha8)
      }
      if (removed > 0) {
        writeFileSync(indexFile, keptLines.length ? `${keptLines.join('\n')}\n` : '', 'utf8')
        seen.clear()
        for (const s of keptSha) seen.add(s)
        log('info', `拾荒清理：删掉 ${removed} 条超过 ${keepDays} 天的记录`)
      }
    } catch (err) {
      log('warn', `拾荒清理失败: ${err?.message ?? err}`)
    }
  }

  /** 限流：每分钟 + 每天 */
  function overQuota(t) {
    const maxPerDay = Math.max(1, Math.round(Number(cfg.collectMaxPerDay) || 60))
    const dk = dayKeyOf(t)
    if (dk !== dayKey) {
      dayKey = dk
      dayCount = 0
    }
    if (dayCount >= maxPerDay) return 'daily_limit'

    const mk = Math.floor(t / 60_000)
    if (mk !== minuteKey) {
      minuteKey = mk
      minuteCount = 0
    }
    if (minuteCount >= MAX_PER_MINUTE) return 'minute_limit'
    return null
  }

  async function download(url, maxBytes) {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') throw new Error(`只接受 https: ${parsed.protocol}`)
    const resp = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const buf = Buffer.from(await resp.arrayBuffer())
    if (buf.length > maxBytes) throw new Error(`超过 ${Math.round(maxBytes / 1048576)}MB`)
    return buf
  }

  /**
   * 采集一条消息里的图（异步、fire-and-forget）。
   * @param {object} msg 入站消息
   * @returns {Promise<{ saved: number, skipped: number, failed: number }>}
   */
  async function collect(msg) {
    const result = { saved: 0, skipped: 0, failed: 0 }
    if (!cfg.collectEnabled) return result
    const groups = Array.isArray(cfg.collectGroups) ? cfg.collectGroups : []
    const groupId = String(msg.groupOpenid ?? msg.groupId ?? '')
    if (groups.length > 0 && !groups.includes(groupId)) return result

    // 维护（读 index / 清理过期）放在最前面：哪怕这条消息没有图，
    // 它也是「拾荒被唤起」的一次机会，顺手把该清的清掉。
    loadOnce()
    cleanupIfDue()

    const images = pickImages(msg)
    if (images.length === 0) return result

    const maxMB = Math.max(0.1, Number(cfg.collectMaxMB) || 5)
    const maxBytes = maxMB * 1024 * 1024

    for (const att of images) {
      const t = now()
      const quota = overQuota(t)
      if (quota) {
        counters.skipped += 1
        result.skipped += 1
        if (quota === 'daily_limit') break
        continue
      }

      let buf
      try {
        buf = await download(att.url, maxBytes)
      } catch (err) {
        counters.failed += 1
        result.failed += 1
        log('debug', `拾荒下载失败: ${err?.message ?? err}`)
        continue
      }

      const ext = imageExtension(buf)
      if (!ext) {
        counters.failed += 1
        result.failed += 1
        continue
      }

      const sha8 = createHash('sha256').update(buf).digest('hex').slice(0, 8)
      if (seen.has(sha8)) {
        counters.skipped += 1
        result.skipped += 1
        continue
      }

      const name = `${stampOf(t)}-${sha8}${ext}`
      const rel = `images/${name}`
      const abs = join(root, rel)
      try {
        ensureDirs()
        writeFileSync(abs, buf)
        const row = {
          ts: new Date(t).toISOString(),
          group: String(msg.groupOpenid ?? msg.groupId ?? ''),
          sender: String(msg.senderName ?? msg.senderId ?? ''),
          text: String(msg.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
          file: rel,
          bytes: buf.length,
          sha8,
          kind: 'image',
        }
        appendFileSync(indexFile, `${JSON.stringify(row)}\n`, 'utf8')
        seen.add(sha8)
        counters.saved += 1
        counters.bytes += buf.length
        result.saved += 1
        dayCount += 1
        minuteCount += 1
      } catch (err) {
        counters.failed += 1
        result.failed += 1
        log('warn', `拾荒落盘失败: ${err?.message ?? err}`)
      }
    }

    if (result.saved > 0 || result.failed > 0) {
      log('info', `拾荒 存=${result.saved} 重=${result.skipped} 败=${result.failed} 群=${msg.groupOpenid ?? ''}`)
    }
    return result
  }

  function stats() {
    return { ...counters, seen: seen.size, dayCount }
  }

  return { collect, stats, indexFile, imagesDir, _pickImages: pickImages }
}
