import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeConfig } from '../lib/config.js'

test('空配置 → 全部取默认值，mode 默认 debounce', () => {
  const cfg = normalizeConfig(undefined)
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.mode, 'debounce')
  assert.equal(cfg.debounceSeconds, 3)
  assert.equal(cfg.maxWaitSeconds, 12)
  assert.equal(cfg.maxMergeMessages, 8)
  assert.equal(cfg.imageDebounceSeconds, 8)
  assert.equal(cfg.groupMergeAcrossSenders, false)
  assert.equal(cfg.coldGroupIdleMinutes, 0)
})

test('未知 mode 回落默认，不抛错', () => {
  assert.equal(normalizeConfig({ mode: 'nonsense' }).mode, 'debounce')
  assert.equal(normalizeConfig({ mode: 'gate' }).mode, 'gate')
  assert.equal(normalizeConfig({ mode: 'off' }).mode, 'off')
})

test('硬上限不能比静默窗口短', () => {
  const cfg = normalizeConfig({ debounceSeconds: 10, maxWaitSeconds: 4 })
  assert.equal(cfg.maxWaitSeconds, 10)
})

test('图片等待不得短于文本等待', () => {
  const cfg = normalizeConfig({ debounceSeconds: 6, imageDebounceSeconds: 2 })
  assert.equal(cfg.imageDebounceSeconds, 6)
})

test('字符串数字也认，越界夹紧', () => {
  const cfg = normalizeConfig({ debounceSeconds: '5', maxMergeMessages: '500', questionThreshold: -3 })
  assert.equal(cfg.debounceSeconds, 5)
  assert.equal(cfg.maxMergeMessages, 50)
  assert.equal(cfg.questionThreshold, 0)
})

test('字符串数组去空去重，大小写视为重复', () => {
  const cfg = normalizeConfig({ botNames: ['鲸鱼', ' 鲸鱼 ', '', 'D酱', 'd酱', 42] })
  assert.deepEqual(cfg.botNames, ['鲸鱼', 'D酱'])
})

test('布尔字符串也认', () => {
  assert.equal(normalizeConfig({ debug: 'true' }).debug, true)
  assert.equal(normalizeConfig({ groupMergeAcrossSenders: 'true' }).groupMergeAcrossSenders, true)
  assert.equal(normalizeConfig({ takeOverMentionGate: false }).takeOverMentionGate, false)
})
