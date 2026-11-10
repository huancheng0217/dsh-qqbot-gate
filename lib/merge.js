/**
 * 合并文本 —— 纯函数，无副作用，可单独跑测试。
 *
 * 目标：把同一小段时间里收到的 N 条消息，拼成 agent 看得到的**一条**：
 *   - 同一个人的连发：直接换行拼（不重复加名字，读起来才像"一口气说完"）
 *   - 不同人（开了 groupMergeAcrossSenders 时）：每行前面加 `[名字] `
 *   - 被吸收的消息带过附件：留一行说明，别让模型以为用户只发了文字
 */

/** QQ 的 @ 标记：`<@!123>` / `<@123>`。判定与清洗共用同一份正则来源。 */
export function mentionPattern(appId) {
  const id = String(appId ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (!id) return null
  return new RegExp(`<@!?${id}>`, 'g')
}

/** 去掉指向本 bot 的 @ 标记（后面的 contentSanitizer 也会做，但我们要先判空/判定） */
export function stripMention(text, appId) {
  const s = String(text ?? '')
  const re = mentionPattern(appId)
  if (!re) return s.replace(/\s+/g, ' ').trim()
  return s.replace(re, ' ').replace(/\s+/g, ' ').trim()
}

/** 纯表情 / 纯标点 / 纯空白：没有任何值得回应的文本内容 */
export function isContentFree(text) {
  const s = String(text ?? '').trim()
  if (!s) return true
  // 去掉表情标签、括号表情、标点、空白后还有东西 → 不算空
  const stripped = s
    .replace(/\[<face,id=\d+\/?>]/g, '')
    .replace(/<faceType=\d+,faceId="[^"]*",ext="[^"]*">/g, '')
    .replace(/【表情[:：][^】]*】/g, '')
    .replace(/[\s\p{P}\p{S}]/gu, '')
  return stripped.length === 0
}

/** 单条消息的可读文本（已去 @ 标记；只 @ 不说话时返回空串） */
export function cleanText(entry, appId) {
  return stripMention(entry?.text ?? '', appId)
}

/**
 * 群标识 —— **字段名是 `groupOpenid`，不是 `groupId`**。
 *
 * 这是踩过的坑：QQBot 的 InboundMessage 只有 `groupOpenid`（见 SDK 的
 * protocol/gateway/event-dispatcher.d.ts）。写成 `groupId` 会永远拿到 undefined，
 * 一路回退到 senderId —— 于是「同一个群里不同的人被当成不同的群」：
 * 冷却按人算、群白名单永远匹配不上，而日志看起来一切正常。
 *
 * 保留 `groupId` 兜底只为兼容自造的测试对象与将来可能的别名。
 */
export function groupIdOf(msg) {
  return String(msg?.groupOpenid ?? msg?.groupId ?? msg?.senderId ?? '')
}

/**
 * 把一批消息合并成 agent 看到的一段文本。
 *
 * @param {Array<{text:string, senderName?:string, senderId?:string, hasAttachments?:boolean}>} entries
 * @param {{ appId?: string, acrossSenders?: boolean }} opts
 * @returns {string}
 */
export function mergeMessages(entries, opts = {}) {
  const list = Array.isArray(entries) ? entries.filter(Boolean) : []
  if (list.length === 0) return ''
  if (list.length === 1) return cleanText(list[0], opts.appId)

  const senders = new Set(list.map((e) => String(e.senderId ?? '')))
  const multiSender = opts.acrossSenders === true && senders.size > 1

  const lines = []
  for (const e of list) {
    const text = cleanText(e, opts.appId)
    if (!text) continue
    lines.push(multiSender ? `[${senderLabel(e)}] ${text}` : text)
  }

  const merged = lines.join('\n')

  // 被吸收的消息带了附件：后续中间件只会看到幸存者那一条的 attachments，
  // 所以这里补一行说明，避免模型误判「用户只发了文字」。
  const absorbed = list.slice(0, -1)
  const droppedMedia = absorbed.filter((e) => e?.hasAttachments).length
  if (droppedMedia > 0) {
    return `${merged}\n[注：本条之前还有 ${droppedMedia} 条消息带了图片/文件，已合并到这条里，附件本身未随本条上传]`
  }
  return merged
}

function senderLabel(entry) {
  const name = String(entry?.senderName ?? '').trim()
  if (name) return name
  const id = String(entry?.senderId ?? '').trim()
  return id ? id.slice(0, 8) : '某人'
}
