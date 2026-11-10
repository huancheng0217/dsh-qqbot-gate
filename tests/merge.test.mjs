import assert from 'node:assert/strict'
import test from 'node:test'

import { cleanText, groupIdOf, isContentFree, mergeMessages, stripMention } from '../lib/merge.js'

test('群标识优先取 groupOpenid（真实字段名），不能直接落到 senderId', () => {
  assert.equal(groupIdOf({ groupOpenid: 'G-OPENID', senderId: 'S1' }), 'G-OPENID')
  // 兼容别名：只有 groupId 时也能用
  assert.equal(groupIdOf({ groupId: 'G-ALIAS', senderId: 'S1' }), 'G-ALIAS')
  // 完全没有群信息时才回退（c2c / 老形状）
  assert.equal(groupIdOf({ senderId: 'S1' }), 'S1')
  assert.equal(groupIdOf(undefined), '')
})

test('剥掉指向本 bot 的 @ 标记，保留其他人的', () => {
  assert.equal(stripMention('<@!123> 在吗', '123'), '在吗')
  assert.equal(stripMention('<@123>在吗', '123'), '在吗')
  assert.equal(stripMention('<@!999> 你说', '123'), '<@!999> 你说')
  assert.equal(stripMention('没有标记', '123'), '没有标记')
})

test('纯表情 / 纯标点算空内容', () => {
  assert.equal(isContentFree(''), true)
  assert.equal(isContentFree('   '), true)
  assert.equal(isContentFree('？？？'), true)
  assert.equal(isContentFree('【表情: 笑】'), true)
  assert.equal(isContentFree('[<face,id=100/>]'), true)
  assert.equal(isContentFree('哈哈'), false)
  assert.equal(isContentFree('在吗？'), false)
})

test('单条消息直接返回清洗后的原文', () => {
  const merged = mergeMessages([{ text: '<@!123> 你好', senderId: 'A' }], { appId: '123' })
  assert.equal(merged, '你好')
})

test('同一个人连发 → 换行拼接，不重复加名字', () => {
  const merged = mergeMessages(
    [
      { text: '帮我看看', senderId: 'A', senderName: '皮' },
      { text: '这个报错', senderId: 'A', senderName: '皮' },
      { text: '怎么修', senderId: 'A', senderName: '皮' },
    ],
    { appId: '123' },
  )
  assert.equal(merged, '帮我看看\n这个报错\n怎么修')
})

test('不同人且开了跨人合并 → 每行带名字前缀', () => {
  const merged = mergeMessages(
    [
      { text: '甲的问题', senderId: 'A', senderName: '甲' },
      { text: '乙的问题', senderId: 'B', senderName: '乙' },
    ],
    { appId: '123', acrossSenders: true },
  )
  assert.equal(merged, '[甲] 甲的问题\n[乙] 乙的问题')
})

test('关了跨人合并 → 即使混了人也不加前缀（保底行为）', () => {
  const merged = mergeMessages(
    [
      { text: '一', senderId: 'A', senderName: '甲' },
      { text: '二', senderId: 'B', senderName: '乙' },
    ],
    { appId: '123', acrossSenders: false },
  )
  assert.equal(merged, '一\n二')
})

test('被吸收的消息带过附件 → 末尾补一行说明', () => {
  const merged = mergeMessages(
    [
      { text: '看这张', senderId: 'A', hasAttachments: true },
      { text: '还有这张', senderId: 'A', hasAttachments: true },
      { text: '算了', senderId: 'A' },
    ],
    { appId: '123' },
  )
  assert.match(merged, /^看这张\n还有这张\n算了\n\[注：/)
  assert.match(merged, /2 条消息带了图片\/文件/)
})

test('空的条目被跳过，全空时返回空串', () => {
  assert.equal(mergeMessages([{ text: '' }, { text: '  ' }], {}), '')
  assert.equal(mergeMessages([], {}), '')
  assert.equal(cleanText({ text: '<@!1>  ' }, '1'), '')
})
