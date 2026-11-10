/**
 * 用户配置的读写 —— GUI 保存的那一份。
 *
 * 分层（重要）：
 *   patch 里的 config = **出厂默认**（bundle 的 cordis.patch.yml + profile 的覆盖行）
 *   ~/.dsh-qqbot/gate-config.json = **用户在 GUI 里改过的值**，优先级更高
 *   插件每次启动时 `{ ...patchConfig, ...overrides }` 合成，再 normalizeConfig。
 *
 * 为什么不把 GUI 的改动写回 profile 的 cordis.patch.yml：
 *   改那个文件会触发 DSH Loader 热更新，整个 QQ 插件会被重建（网关重连）；
 *   而调一个秒数不该付这个代价。写这里 + 插件内部热应用，改完立刻生效、不重连。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { STATUS_DIR } from './status.js'

export const CONFIG_FILE = join(STATUS_DIR, 'gate-config.json')

/**
 * @returns {{ ok: boolean, data: object, error?: string }} 读不到就当空（用 patch 默认）
 */
export function readOverrides() {
  try {
    const raw = readFileSync(CONFIG_FILE, 'utf8')
    const data = JSON.parse(raw)
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, data: {}, error: '配置文件不是对象' }
    }
    return { ok: true, data }
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: true, data: {} }
    return { ok: false, data: {}, error: String(err?.message ?? err) }
  }
}

/**
 * 原子写：先写 .tmp 再 rename，读的人不会看到半个文件。
 * @returns {{ ok: boolean, error?: string }}
 */
export function writeOverrides(data) {
  try {
    mkdirSync(STATUS_DIR, { recursive: true })
    const tmp = `${CONFIG_FILE}.tmp`
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    renameSync(tmp, CONFIG_FILE)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) }
  }
}
