import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createMediaCollector, imageExtension, pickImages } from '../lib/collect-media.js'
import { normalizeConfig } from '../lib/config.js'

/** 一个能被魔数认出来的假 PNG（8 字节头 + 填充） */
function fakePng(seed = 1) {
  const head = Buffer.from('89504e470d0a1a0a', 'hex')
  const body = Buffer.alloc(16, seed)
  return Buffer.concat([head, body])
}

function tmpRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'qgate-collect-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const GROUP = 'G1'

function msgWith(url, over = {}) {
  return {
    kind: 'group',
    groupOpenid: GROUP,
    senderName: '阿甲',
    content: '看图',
    attachments: [{ url, content_type: 'image/png', filename: 'a.png' }],
    ...over,
  }
}

/** 把 fetch 换成返回固定字节的假实现 */
function stubFetch(buf, status = 200) {
  const real = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  })
  return () => {
    globalThis.fetch = real
  }
}

test('魔数识别图片格式', () => {
  assert.equal(imageExtension(fakePng()), '.png')
  assert.equal(imageExtension(Buffer.from('4749463839610000000000', 'hex').length === 11 ? Buffer.concat([Buffer.from('474946383961', 'hex'), Buffer.alloc(8)]) : Buffer.alloc(0)), '.gif')
  assert.equal(imageExtension(Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0])), '.jpg')
  assert.equal(imageExtension(Buffer.from('short')), null)
})

test('只挑带 url 的图片附件（视频/文件/语音跳过）', () => {
  const images = pickImages({
    attachments: [
      { url: 'https://x/1.png', content_type: 'image/png' },
      { url: 'https://x/2.mp4', content_type: 'video/mp4' },
      { url: 'https://x/3.bin', content_type: 'file' },
      { content_type: 'image/png' },
    ],
  })
  assert.equal(images.length, 1)
  assert.equal(images[0].url, 'https://x/1.png')
})

test('存一张图：落盘 + index.jsonl 记一行', async () => {
  const { dir, cleanup } = tmpRoot()
  const restore = stubFetch(fakePng(1))
  try {
    const cfg = normalizeConfig({ collectEnabled: true, collectDir: dir })
    const mc = createMediaCollector({ cfg, root: dir })
    const res = await mc.collect(msgWith('https://example.com/a.png'))

    assert.equal(res.saved, 1)
    const files = readdirSync(join(dir, 'images'))
    assert.equal(files.length, 1)
    assert.match(files[0], /^\d{8}-\d{6}-[0-9a-f]{8}\.png$/)

    const lines = readFileSync(join(dir, 'index.jsonl'), 'utf8').trim().split('\n')
    assert.equal(lines.length, 1)
    const row = JSON.parse(lines[0])
    assert.equal(row.sha8, files[0].match(/-([0-9a-f]{8})\.png$/)[1])
    assert.equal(row.group, GROUP)
    assert.equal(row.kind, 'image')
    assert.equal(row.text, '看图')
  } finally {
    restore()
    cleanup()
  }
})

test('同一张图第二次不再落盘（sha8 去重）', async () => {
  const { dir, cleanup } = tmpRoot()
  const restore = stubFetch(fakePng(7))
  try {
    const cfg = normalizeConfig({ collectDir: dir })
    const mc = createMediaCollector({ cfg, root: dir })
    await mc.collect(msgWith('https://example.com/a.png'))
    const again = await mc.collect(msgWith('https://example.com/b.png'))

    assert.equal(again.saved, 0)
    assert.equal(again.skipped, 1)
    assert.equal(readdirSync(join(dir, 'images')).length, 1)
  } finally {
    restore()
    cleanup()
  }
})

test('非图片附件 / 关掉开关 → 什么都不做', async () => {
  const { dir, cleanup } = tmpRoot()
  try {
    const off = createMediaCollector({ cfg: normalizeConfig({ collectEnabled: false, collectDir: dir }), root: dir })
    assert.equal((await off.collect(msgWith('https://example.com/a.png'))).saved, 0)

    const only = createMediaCollector({ cfg: normalizeConfig({ collectDir: dir }), root: dir })
    const noImage = await only.collect({ kind: 'group', groupOpenid: GROUP, attachments: [{ url: 'https://x/v.mp4', content_type: 'video/mp4' }] })
    assert.equal(noImage.saved, 0)
    const dirFiles = existsSync(join(dir, 'images')) ? readdirSync(join(dir, 'images')) : []
    assert.deepEqual(dirFiles, [], '不该落任何文件')
  } finally {
    cleanup()
  }
})

test('群过滤：设了白名单就只收名单里的群', async () => {
  const { dir, cleanup } = tmpRoot()
  const restore = stubFetch(fakePng(3))
  try {
    const cfg = normalizeConfig({ collectDir: dir, collectGroups: ['G2'] })
    const mc = createMediaCollector({ cfg, root: dir })
    assert.equal((await mc.collect(msgWith('https://example.com/a.png'))).saved, 0, 'G1 不在名单')

    const inList = await mc.collect(msgWith('https://example.com/a.png', { groupOpenid: 'G2' }))
    assert.equal(inList.saved, 1)
  } finally {
    restore()
    cleanup()
  }
})

test('每日上限：到数就停', async () => {
  const { dir, cleanup } = tmpRoot()
  let seed = 0
  const restore = (() => {
    const real = globalThis.fetch
    globalThis.fetch = async () => {
      seed += 1
      const buf = fakePng(seed)
      return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) }
    }
    return () => {
      globalThis.fetch = real
    }
  })()
  try {
    const cfg = normalizeConfig({ collectDir: dir, collectMaxPerDay: 2 })
    const mc = createMediaCollector({ cfg, root: dir })
    await mc.collect(msgWith('https://example.com/1.png'))
    await mc.collect(msgWith('https://example.com/2.png'))
    const third = await mc.collect(msgWith('https://example.com/3.png'))

    assert.equal(third.saved, 0)
    assert.equal(readdirSync(join(dir, 'images')).length, 2)
  } finally {
    restore()
    cleanup()
  }
})

test('超过保留期的图会被清掉（连 index 一起）', async () => {
  const { dir, cleanup } = tmpRoot()
  try {
    // 手工造一条 10 天前的记录 + 对应文件
    const imagesDir = join(dir, 'images')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(imagesDir, { recursive: true })
    const old = join(imagesDir, 'old.png')
    writeFileSync(old, fakePng(9))
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString()
    writeFileSync(join(dir, 'index.jsonl'), `${JSON.stringify({ ts: tenDaysAgo, file: 'images/old.png', sha8: 'deadbeef' })}\n`, 'utf8')

    const cfg = normalizeConfig({ collectDir: dir, collectKeepDays: 7 })
    const mc = createMediaCollector({ cfg, root: dir })
    await mc.collect({ kind: 'group', groupOpenid: GROUP, attachments: [] }) // 触发 loadOnce → cleanup

    assert.equal(existsSync(old), false, '过期文件应被删除')
    assert.equal(readFileSync(join(dir, 'index.jsonl'), 'utf8').trim(), '', 'index 里的旧行也该清掉')
  } finally {
    cleanup()
  }
})
