/**
 * 虚拟时钟：让防抖逻辑在测试里能"快进"，
 * 不用真的等 3 秒，也不依赖 --test 的 fake timer 特性。
 */
export function createClock(startAt = 0) {
  let now = startAt
  let seq = 0
  const timers = new Map()

  const schedule = (fn, ms) => {
    const id = ++seq
    timers.set(id, { fn, at: now + Math.max(0, ms), id })
    return id
  }

  const cancel = (id) => {
    timers.delete(id)
  }

  /** 按时间顺序执行所有到期的计时器（同刻按登记顺序） */
  const advance = (ms) => {
    const target = now + ms
    for (;;) {
      let next = null
      for (const t of timers.values()) {
        if (t.at > target) continue
        if (!next || t.at < next.at || (t.at === next.at && t.id < next.id)) next = t
      }
      if (!next) break
      timers.delete(next.id)
      now = next.at
      next.fn()
    }
    now = target
  }

  return {
    now: () => now,
    schedule,
    cancel,
    advance,
    pending: () => timers.size,
  }
}
