/**
 * dsh-qqbot-gate —— 入口壳。
 *
 * 为什么这里只有一句动态 import：
 *   Node 的 ESM 模块缓存按 URL 命中，插件热重载时 loader 仍然用同一个 URL，
 *   于是**改完代码重载还是跑旧模块**（静默，最难查的那类）。
 *   带上时间戳 query 之后，每次激活都是一份全新的模块实例，改完立刻生效。
 *   代价是旧模块留在内存里 —— 对一个几十 KB 的插件可以接受，换来的是
 *   「改一行就能验证一行」，这个交换很值。
 *
 * 真正的实现全在 lib/app.js。
 */

export const name = 'dsh-qqbot-gate'
export const inject = []

export async function apply(ctx, config) {
  const stamp = Date.now()
  const mod = await import(`./lib/app.js?v=${stamp}`)
  return mod.apply(ctx, config)
}
