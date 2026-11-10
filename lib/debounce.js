/**
 * 防抖缓冲器（「攒着说」）。
 *
 * 六条硬规则来自 AstrBot private_companion 的实测规格：
 *   1. 滑动窗口：每来一条新消息 → deadline = now + wait
 *   2. 硬上限  ：maxDeadline = firstTs + maxWait，到点强制收口
 *   3. 条数上限：len >= maxMergeMessages → 立刻收口
 *   4. 去重    ：同人同文本在窗口内不重复入队
 *   5. 过期清理：now - updatedTs > max(20, wait + 8) 的 buffer 丢弃
 *   6. 收口动作：合并成一次请求；被吸收的消息不再各自进链
 *
 * 计时器与时钟都是注入的，所以这套逻辑可以脱离 DSH / 脱离真实时间跑单元测试。
 */

import { mergeMessages } from './merge.js'

/** 一个 key 的缓冲槽 */
function createSlot(key, now) {
  return {
    key,
    firstTs: now,
    updatedTs: now,
    deadlineTs: now,
    maxDeadlineTs: now,
    softTimer: null,
    hardTimer: null,
    entries: [],
    /** 去重表：`senderId\u0000text` → ts */
    seen: new Map(),
    flushed: false,
  }
}

export class Debouncer {
  /**
   * @param {object} opts
   * @param {object} opts.cfg          normalizeConfig() 的产物
   * @param {(reason: string, batch: object) => void} [opts.onFlush]
   * @param {string} [opts.appId]    用于剥 @ 标记
   * @param {() => number} [opts.now]
   * @param {(fn: () => void, ms: number) => any} [opts.schedule]
   * @param {(handle: any) => void} [opts.cancel]
   */
  constructor(opts) {
    this.cfg = opts.cfg
    this.appId = opts.appId
    this.onFlush = opts.onFlush ?? null
    this.now = opts.now ?? (() => Date.now())
    this.schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms))
    this.cancel = opts.cancel ?? ((h) => clearTimeout(h))
    this.slots = new Map()
    this.disposed = false
  }

  /** 还有多少批在等 */
  get size() {
    return this.slots.size
  }

  /** 该 key 当前的等待批次（没有返回 undefined） */
  peek(key) {
    return this.slots.get(key)
  }

  /**
   * 把一条消息塞进对应批。
   *
   * @param {string} key    缓冲键（私聊 = c2c:peer，群聊默认再带 senderId）
   * @param {object} item   { text, senderName, senderId, msgId, hasAttachments, kind }
   * @returns {Promise<{survivor: boolean, absorbed?: boolean, merged?: string, batch?: object}>}
   */
  push(key, item) {
    if (this.disposed) return Promise.resolve({ survivor: false, absorbed: true })

    const now = this.now()
    this.sweep(now)

    let slot = this.slots.get(key)
    if (!slot) {
      slot = createSlot(key, now)
      slot.maxDeadlineTs = now + this.cfg.maxWaitSeconds * 1000
      this.slots.set(key, slot)
      slot.hardTimer = this.schedule(() => this.flush(key, 'max_wait'), this.cfg.maxWaitSeconds * 1000)
    } else {
      // 硬上限早已到点（计时器被饿死等极端情况）：先结算旧的，再开新批
      if (now >= slot.maxDeadlineTs) {
        this.flush(key, 'max_wait')
        slot = createSlot(key, now)
        slot.maxDeadlineTs = now + this.cfg.maxWaitSeconds * 1000
        this.slots.set(key, slot)
        slot.hardTimer = this.schedule(() => this.flush(key, 'max_wait'), this.cfg.maxWaitSeconds * 1000)
      }
    }

    // 规则 4：去重（同人同文本，窗口内只算一条）
    const dedupeKey = `${item?.senderId ?? ''}\u0000${item?.text ?? ''}`
    if (this.cfg.dedupeWindowSeconds > 0 && item?.text) {
      const last = slot.seen.get(dedupeKey)
      if (last !== undefined && now - last < this.cfg.dedupeWindowSeconds * 1000) {
        slot.seen.set(dedupeKey, now)
        return Promise.resolve({ survivor: false, absorbed: true, batch: { key, deduped: true } })
      }
      slot.seen.set(dedupeKey, now)
    }

    const waitMs = (item?.hasAttachments ? this.cfg.imageDebounceSeconds : this.cfg.debounceSeconds) * 1000
    slot.updatedTs = now
    slot.deadlineTs = Math.min(now + waitMs, slot.maxDeadlineTs)

    // resolve 必须在任何同步 flush 之前就位，否则 max_merge 立即收口时
    // entry.resolve 还是 null，push 返回的 promise 会永远挂着。
    const entry = { item, resolve: null, isSurvivor: false }
    const promise = new Promise((resolve) => {
      entry.resolve = resolve
    })
    slot.entries.push(entry)

    // 规则 1：滑动窗口
    if (slot.softTimer !== null) this.cancel(slot.softTimer)
    const delay = Math.max(0, slot.deadlineTs - now)
    slot.softTimer = this.schedule(() => this.flush(key, 'quiet'), delay)

    // 规则 3：条数上限（可能同步收口，含本条）
    if (slot.entries.length >= this.cfg.maxMergeMessages) {
      this.flush(key, 'max_merge')
    }

    return promise
  }

  /**
   * 收口：选最后一条当幸存者，把合并文本交给它，其余静默返回。
   * @param {string} key
   * @param {string} why  quiet | max_wait | max_merge | expire | dispose
   */
  flush(key, why) {
    const slot = this.slots.get(key)
    if (!slot || slot.flushed) return
    slot.flushed = true
    this.slots.delete(key)

    if (slot.softTimer !== null) this.cancel(slot.softTimer)
    if (slot.hardTimer !== null) this.cancel(slot.hardTimer)

    const entries = slot.entries
    if (entries.length === 0) return

    const survivor = entries[entries.length - 1]
    survivor.isSurvivor = true

    const merged = mergeMessages(
      entries.map((e) => e.item),
      { appId: this.appId, acrossSenders: this.cfg.groupMergeAcrossSenders },
    )

    const batch = {
      key,
      why,
      count: entries.length,
      merged,
      items: entries.map((e) => e.item),
      firstTs: slot.firstTs,
      lastTs: slot.updatedTs,
    }

    try {
      this.onFlush?.(why, batch)
    } catch {
      /* 日志失败绝不影响收口 */
    }

    for (const e of entries) {
      try {
        e.resolve?.({ survivor: e.isSurvivor, merged: e.isSurvivor ? merged : undefined, batch })
      } catch {
        /* resolve 不会抛，防御性兜底 */
      }
    }
  }

  /** 规则 5：过期清理（防内存泄漏 + 防幽灵回复） */
  sweep(now = this.now()) {
    const floor = Math.max(20_000, (this.cfg.debounceSeconds + 8) * 1000)
    for (const [key, slot] of this.slots) {
      if (now - slot.updatedTs > floor) this.flush(key, 'expire')
    }
  }

  /** 卸载时把还在排队的批次全部放行（不丢用户的最后一句话） */
  dispose() {
    if (this.disposed) return
    for (const key of [...this.slots.keys()]) this.flush(key, 'dispose')
    this.disposed = true
  }
}
