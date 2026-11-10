import { test } from 'node:test'
import assert from 'node:assert'
import { shouldBlock, compilePatterns, DEFAULT_PATTERNS } from '../lib/outguard.js'

test('拦下记忆维护任务的收尾话术', () => {
  assert.equal(shouldBlock('记完了。这一轮落下的东西：更新两条旧记忆').blocked, true)
  assert.equal(shouldBlock('本组整理完成').blocked, true)
  assert.equal(shouldBlock('记忆已写入（project，id=abc）').blocked, true)
  assert.equal(shouldBlock('已记下：qq-group-log 的进展').blocked, true)
})

test('拦下插件标记', () => {
  assert.equal(shouldBlock('[meow-memory-reflect] 记忆反思任务').blocked, true)
  assert.equal(shouldBlock('[meow-memory-dream] 记忆整理任务').blocked, true)
})

test('拦下工具报错', () => {
  assert.equal(shouldBlock('❌ 工具 edit 执行失败\nFsError: FS_EDIT_NOT_FOUND').blocked, true)
  assert.equal(shouldBlock('FS_EDIT_NOT_FOUND').blocked, true)
  assert.equal(shouldBlock('工具 read 执行失败').blocked, true)
})

test('拦下 Windows 绝对路径', () => {
  assert.equal(shouldBlock('文件在 C:/Users/someone/x.txt').blocked, true)
  assert.equal(shouldBlock('路径：D:\\work\\notes\\_日志.md').blocked, true)
  assert.equal(shouldBlock('E:/x').blocked, true)
})

test('不误伤正常聊天', () => {
  const ok = [
    '今天吃什么',
    '哈哈哈，我不听',
    '我记下了',
    '这条我认',
    '死战不退',
    'ok，牛逼',
    '草，我前一秒才说不说这个。',
    '',
    '   ',
  ]
  for (const s of ok) {
    assert.equal(shouldBlock(s).blocked, false, `不该拦: ${JSON.stringify(s)}`)
  }
})

test('自定义配置：/正则/ 编译成正则，其余当字面量', () => {
  const { patterns, literals } = compilePatterns(['/secret\\d+/i', '内部编号'])
  assert.equal(patterns.length, 1)
  assert.deepEqual(literals, ['内部编号'])
})

test('自定义字面量也能拦', () => {
  const r = shouldBlock('这里有个内部编号 42', { extra: ['内部编号'] })
  assert.equal(r.blocked, true)
})

test('坏正则不会拖垮别的规则', () => {
  // 配置里写了语法错误的正则字符串：compilePatterns 会把它降级成字面量，不抛
  const { patterns, literals } = compilePatterns(['/(/'])
  assert.equal(patterns.length, 0)
  assert.deepEqual(literals, ['/(/'])
  assert.equal(typeof shouldBlock('本组整理完成').blocked, 'boolean')
})

test('默认规则数量合理', () => {
  assert.ok(DEFAULT_PATTERNS.length >= 8)
})
