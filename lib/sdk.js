/**
 * 找到 dsh-qqbot 用的那一份 SDK。
 *
 * 为什么要走绝对路径：
 *   我们这个包常以 link / file: 方式装在 workspace 目录下，普通 `import '@tencent-connect/qqbot-nodejs'`
 *   会从本包目录向上找 node_modules，很可能命中**第二份拷贝**；两份拷贝的 QQBot.prototype 不是同一个
 *   对象，patch 就完全无效（而且不会报错，属于最难查的那类问题）。
 *   所以优先拼出 profile 里那份的真实路径 —— 和 dsh-qqbot 解析到的是同一个文件，
 *   Node 的模块缓存按 realpath 命中，拿到的是同一个类。
 *
 * 为什么不只信 DSH_PROFILE_DIR：
 *   实测宿主进程里**没有**这个环境变量（它是 spawn shell 时才注入的）。
 *   所以这里做多级探测：环境变量 → 标准 ~/.dsh 布局 → 枚举 profiles/ → 扫 pnpm 的 .pnpm 目录。
 *   探测只读，失败只会让钩子降级，不会影响机器人本身。
 */

import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const PKG = '@tencent-connect/qqbot-nodejs'

/** profile 根下可能出现的布局（pnpm 扁平 / pnpm workspace / npm 浅层） */
function relCandidates() {
  return [
    `node_modules/${PKG}/dist/index.js`,
    `node_modules/${PKG}/lib/index.js`,
    `dependencies/node_modules/${PKG}/dist/index.js`,
  ]
}

/** profile 根目录候选：环境变量优先，其次是标准 ~/.dsh 布局 */
function profileRoots() {
  const roots = []
  const push = (p) => {
    if (typeof p === 'string' && p) roots.push(p)
  }

  push(process.env.DSH_PROFILE_DIR)

  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const profile = process.env.DSH_PROFILE
  if (profile) push(join(home, 'profiles', profile))

  // 枚举 profiles/：桌面版可能装了多个 profile，装 qqbot 的那个才会命中
  try {
    const profilesDir = join(home, 'profiles')
    for (const name of readdirSync(profilesDir)) {
      push(join(profilesDir, name))
    }
  } catch {
    /* 没有 profiles 目录就跳过 */
  }

  return roots
}

/** 在某个目录下扫 pnpm 的 .pnpm 布局（qqbot-nodejs 只被 dsh-qqbot 依赖，通常在顶层已扁平） */
function pnpmCandidates(root) {
  const out = []
  for (const base of [join(root, 'node_modules', '.pnpm'), join(root, 'dependencies', 'node_modules', '.pnpm')]) {
    let names = []
    try {
      if (!existsSync(base)) continue
      names = readdirSync(base)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.startsWith('@tencent-connect+qqbot-nodejs@')) continue
      out.push(join(base, name, 'node_modules', PKG, 'dist', 'index.js'))
    }
  }
  return out
}

export function candidateSdkPaths() {
  const seen = new Set()
  const out = []
  const add = (p) => {
    try {
      if (!existsSync(p)) return
      const real = realpathSync(p) // 软链去重：同一份文件只试一次
      if (seen.has(real)) return
      seen.add(real)
      out.push(real)
    } catch {
      /* 单个候选读不到就跳过 */
    }
  }

  const roots = profileRoots()
  for (const root of roots) {
    for (const rel of relCandidates()) add(join(root, rel))
  }
  for (const root of roots) {
    for (const p of pnpmCandidates(root)) add(p)
  }
  return out
}

/**
 * @param {{ log?: (msg: string) => void }} [opts]
 * @returns {Promise<{ QQBot: Function, via: string } | null>}
 */
export async function loadQQBot(opts = {}) {
  const log = opts.log ?? (() => {})
  const candidates = candidateSdkPaths()

  if (candidates.length === 0) {
    log(`[sdk] 没找到 qqbot-nodejs（探测了 ${profileRoots().length} 个 profile 根）`)
  }

  for (const p of candidates) {
    try {
      const mod = await import(pathToFileURL(p).href)
      if (typeof mod?.QQBot === 'function') return { QQBot: mod.QQBot, via: p }
      log(`[sdk] ${p} 里没有 QQBot 导出`)
    } catch (err) {
      log(`[sdk] 加载失败 ${p}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // 兜底：让 Node 自己解析（只在裸装进 profile 依赖时才可能命中同一份）
  try {
    const mod = await import(PKG)
    if (typeof mod?.QQBot === 'function') return { QQBot: mod.QQBot, via: 'bare-specifier' }
  } catch {
    /* 解析不到属正常情况 */
  }

  return null
}
