/**
 * dsh-qqbot-gate —— 客户端半边：DSH「设置」里的「回话门槛」一页。
 *
 * 数据流：section ⇄ `/qqbot-gate/api/*`（同源 fetch）⇄ `~/.dsh-qqbot/gate-config.json`
 *         ⇄ 插件内部 updateConfig（原地改 cfg，下一条消息立刻按新参数走）
 *
 * 两个刻意的设计：
 *   1. 保存时提交**整份配置**（load 回来原样改几个键）→ 未显示的字段不会被抹掉。
 *   2. 参数写 JSON 而不是回写 profile 的 cordis.patch.yml —— 改后者会触发 Loader
 *      热更新、QQ 网关重连一次；调一个秒数不值得付这个代价。
 *
 * 字段清单 FIELDS 是唯一真相：加参数只改这个数组（kind 决定用哪种控件）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-qqbot-gate',
  factory: (require) => {
    const React = require('react')
    const { createElement: h, useCallback, useEffect, useState } = React

    const API = '/qqbot-gate/api'
    const NS = 'qqbot-gate'
    const ROW_ORDER = 6

    const CSS = [
      '.qg{max-width:780px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:4px}',
      '.qg-title{margin:0;font-size:16px;font-weight:500;line-height:24px}',
      '.qg-intro{color:var(--dsw-alias-label-tertiary);margin:0 0 6px;font-size:13px;line-height:20px}',
      '.qg-state{display:flex;flex-wrap:wrap;gap:6px 10px;padding:10px 12px;border-radius:8px;background:rgba(127,127,127,.08);font-size:12px;line-height:18px}',
      '.qg-pill{display:inline-flex;align-items:center;gap:5px}',
      '.qg-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-tertiary)}',
      '.qg-dot.ok{background:var(--dsw-alias-state-success-primary,#2ea043)}',
      '.qg-dot.warn{background:var(--dsw-alias-state-warning-primary,#d29922)}',
      '.qg-dot.bad{background:var(--dsw-alias-state-error-primary,#d1242f)}',
      '.qg-group{margin-top:16px;font-size:13px;font-weight:600;line-height:20px}',
      '.qg-rows{display:flex;flex-direction:column}',
      '.qg-row{display:flex;justify-content:space-between;align-items:flex-start;gap:10px 20px;padding:10px 0;border-bottom:.5px solid var(--dsw-alias-border-l2);flex-wrap:wrap}',
      '.qg-row:last-child{border-bottom:none}',
      '.qg-row>div:first-child{flex:1;min-width:200px}',
      '.qg-label{font-size:13px;line-height:19px}',
      '.qg-hint{color:var(--dsw-alias-label-tertiary);margin-top:3px;font-size:11.5px;line-height:17px}',
      '.qg-input,.qg-select,.qg-area{background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);font-size:12.5px;padding:0 8px;outline:none;font-family:inherit}',
      '.qg-input,.qg-select{height:28px;min-width:150px}',
      '.qg-input.qg-num{min-width:92px;text-align:right}',
      '.qg-area{width:260px;min-height:56px;padding:6px 8px;line-height:18px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}',
      '.qg-input:focus-visible,.qg-select:focus-visible,.qg-area:focus-visible{border-color:var(--dsw-alias-brand-primary)}',
      '.qg-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l2);align-items:center}',
      '.qg-btn{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground,#fff);border:none;border-radius:6px;font-size:12.5px;height:30px;padding:0 12px;cursor:pointer}',
      '.qg-btn:disabled{opacity:.5;cursor:default}',
      '.qg-btn2{background:transparent;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}',
      '.qg-msg{font-size:12px;line-height:18px}',
      '.qg-msg.bad{color:var(--dsw-alias-state-error-primary)}',
      '.qg-msg.ok{color:var(--dsw-alias-state-success-primary,#2ea043)}',
      '.qg-log{display:flex;flex-direction:column;gap:2px;margin-top:10px;max-height:260px;overflow:auto;font-size:11.5px;line-height:17px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-secondary);background:rgba(127,127,127,.06);border-radius:8px;padding:8px 10px}',
      '.qg-log-row{display:flex;gap:8px;align-items:baseline}',
      '.qg-log-time{color:var(--dsw-alias-label-tertiary);flex:0 0 auto}',
      '.qg-log-tag{flex:0 0 auto;font-weight:600}',
      '.qg-log-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.qg-log-id{flex:0 0 auto;color:var(--dsw-alias-label-tertiary)}',
    ].join('')

    // ── 唯一真相：可调参数（加参数只改这里）──────────────────────
    //   kind: switch | select | number | lines（一行一项，存成数组）| text
    const FIELDS = [
      { group: '总开关', key: 'enabled', label: '启用插件', hint: '关掉后完全空转，等于没装；机器人照常工作', kind: 'switch' },
      {
        group: '总开关', key: 'mode', label: '模式', kind: 'select',
        hint: 'debounce = 只把连发攒成一次；gate = 再加上群聊「该不该说」的判定',
        options: [['off', '关（完全不管）'], ['debounce', '只防抖（合并连发）'], ['gate', '防抖 + 群聊门槛']],
      },

      { group: '门一 · 攒着说', key: 'debounceSeconds', label: '静默多久算说完（秒）', hint: '每来一条就重新计时——你发得慢就把它调大', kind: 'number', min: 0.5, max: 60, step: 0.5 },
      { group: '门一 · 攒着说', key: 'maxWaitSeconds', label: '最长等多久必回（秒）', hint: '防止「一直在说话」导致永远得不到回复', kind: 'number', min: 1, max: 300, step: 1 },
      { group: '门一 · 攒着说', key: 'maxMergeMessages', label: '一次最多合并几条', hint: '攒到这个数立刻收口，不等计时器', kind: 'number', min: 1, max: 50, step: 1 },
      { group: '门一 · 攒着说', key: 'imageDebounceSeconds', label: '带图消息的等待（秒）', hint: '图片常有后续补充，可以比文本长', kind: 'number', min: 0.5, max: 120, step: 0.5 },
      { group: '门一 · 攒着说', key: 'dedupeWindowSeconds', label: '去重窗口（秒）', hint: '同一个人发同一句话，窗口内只算一条；0 = 关', kind: 'number', min: 0, max: 600, step: 5 },

      {
        group: '门二 · 该不该说', key: 'groupMode', label: '群范围', kind: 'select',
        hint: '所有群都判 = 每句都过门槛；只在白名单群判 = 其他群照旧每条都回（想彻底闭嘴用下面的黑名单）',
        options: [['open', '所有群都判'], ['allowlist', '只在白名单群判']],
      },
      { group: '门二 · 该不该说', key: 'groupAllow', label: '群白名单', hint: '一行一个 group openid（看下面记录的右侧那列）。只在上面选「只在白名单群判」时起作用', kind: 'lines' },
      { group: '门二 · 该不该说', key: 'groupDeny', label: '群黑名单', hint: '一行一个；这里的群完全闭嘴，连 @ 都不回', kind: 'lines' },
      { group: '门二 · 该不该说', key: 'ownerOpenids', label: '主人 openid', hint: '这些人在群里说话一律回，且不受冷却/疲劳限制', kind: 'lines' },
      { group: '门二 · 该不该说', key: 'botNames', label: '点名触发词', hint: '文本里出现就算点名（强唤醒），一行一个', kind: 'lines' },
      { group: '门二 · 该不该说', key: 'takeOverMentionGate', label: '接管 @ 门控', hint: '开着由本插件决定要不要回（覆盖官方 requireMention）；关掉则按官方配置走', kind: 'switch' },
      { group: '门二 · 该不该说', key: 'interestKeywords', label: '兴趣词', hint: '命中后按下面的「兴趣词概率」决定接不接话；留空 = 不启用', kind: 'lines' },
      { group: '门二 · 该不该说', key: 'interestProbability', label: '兴趣词接话概率（%）', hint: '50 = 说到我在意的，一半会开口；0 = 永不因兴趣词开口', kind: 'number', min: 0, max: 100, step: 1 },
      { group: '门二 · 该不该说', key: 'ambientProbability', label: '普通消息冒泡率（%）', hint: '没命中兴趣词时也有这个概率随机插一句；9 = 大约十次里一次，0 = 只在感兴趣时说', kind: 'number', min: 0, max: 100, step: 1 },
      { group: '门二 · 该不该说', key: 'questionThreshold', label: '提问打分阈值', hint: '逗号 65 分。问号 40、疑问词 25、「你」15、长度 10；纯表情扣 30', kind: 'number', min: 0, max: 200, step: 5 },
      { group: '门二 · 抑制与省话', key: 'cooldownSeconds', label: '冷却（秒）', hint: '同群两次主动接话的最小间隔；0 = 关', kind: 'number', min: 0, max: 3600, step: 10 },
      { group: '门二 · 抑制与省话', key: 'fatigueLimit', label: '疲劳阈值（次）', hint: '窗口内接话到这个次数后，降级成只回强唤醒；0 = 关', kind: 'number', min: 0, max: 100, step: 1 },
      { group: '门二 · 抑制与省话', key: 'fatigueWindowSeconds', label: '疲劳窗口（秒）', hint: '默认 300（5 分钟）', kind: 'number', min: 30, max: 3600, step: 30 },
      { group: '门二 · 抑制与省话', key: 'coldGroupIdleMinutes', label: '冷场唤醒（分钟）', hint: '群静默超过这么久、有人重新开口就接一句；0 = 关', kind: 'number', min: 0, max: 1440, step: 5 },
      { group: '门二 · 抑制与省话', key: 'peakQuietEnabled', label: '峰时省话', hint: 'DeepSeek 贵价时段只回强唤醒和兴趣词，其余不接话（省 token）', kind: 'switch' },
      { group: '门二 · 抑制与省话', key: 'peakQuietWindows', label: '峰时时段', hint: '默认 09:00-12:00,14:00-18:00（北京时间）。可填多段，逗号分隔', kind: 'text' },
      { group: '门二 · 抑制与省话', key: 'peakQuietWeekdaysOnly', label: '只工作日算峰时', hint: '周末全天是谷价；法定节假日不识别，长假想全天省话就关掉总开关', kind: 'switch' },
      { group: '门二 · 抑制与省话', key: 'peakQuietAllowInterest', label: '兴趣词仍然放行', hint: '关掉 = 峰时连兴趣词都不接，只回 @ / 点名 / 主人', kind: 'switch' },

      { group: '门三 · 旁听', key: 'injectEnabled', label: '旁听注入', hint: '把「没人叫我那段时间」的群聊当背景补给我，接话才不突兀；只在 gate 模式生效', kind: 'switch' },
      { group: '门三 · 旁听', key: 'injectWindowMinutes', label: '往回看多久（分钟）', hint: '15 = 取最近 15 分钟的群聊当背景', kind: 'number', min: 1, max: 240, step: 1 },
      { group: '门三 · 旁听', key: 'injectMaxMessages', label: '最多带几条', hint: '30 = 最多 30 条；和上面的时间窗谁先到算谁', kind: 'number', min: 1, max: 200, step: 1 },
      { group: '门三 · 旁听', key: 'injectMaxChars', label: '单条截断（字）', hint: '每条最多留这么多个字，后面的用…代替', kind: 'number', min: 20, max: 500, step: 10 },

      { group: '门三 · 拾荒', key: 'collectEnabled', label: '拾荒采集', hint: '群里带图的消息顺手存一份，等你在私聊里跟我说话时我挑给你看', kind: 'switch' },
      { group: '门三 · 拾荒', key: 'collectGroups', label: '只收这些群', hint: '一行一个 group openid；留空 = 全部群（拉我进的群都算你审过的）', kind: 'lines' },
      { group: '门三 · 拾荒', key: 'collectMaxPerDay', label: '每天最多存几张', hint: '60 = 一天最多 60 张，超了只记不存', kind: 'number', min: 1, max: 1000, step: 10 },
      { group: '门三 · 拾荒', key: 'collectMaxMB', label: '单图上限（MB）', hint: '超过这个大小的图不存', kind: 'number', min: 0.1, max: 50, step: 0.5 },
      { group: '门三 · 拾荒', key: 'collectKeepDays', label: '保留天数', hint: '7 = 超过 7 天的图自动删（每天清一次）', kind: 'number', min: 1, max: 365, step: 1 },
      { group: '门三 · 拾荒', key: 'collectDir', label: '存到哪个目录', hint: '留空 = 工作目录下的 _qqbot捡到的', kind: 'text' },

      { group: '门四 · 出站过滤', key: 'outguardEnabled', label: '挡住内部维护输出', hint: '记忆整理总结、工具报错、Windows 路径这类不该出现在群里的内容，命中就静默丢弃', kind: 'switch' },

      { group: '门五 · 分段发送', key: 'splitEnabled', label: '分段发送', hint: '一轮回复里有几句就分几条发，像人在打字；关掉跟原来一样（改完要重载插件）', kind: 'switch' },
      {
        group: '门五 · 分段发送', key: 'splitMode', label: '在哪儿切', kind: 'select',
        hint: '只群聊切 = 私聊仍一次说完（技术细节需要连贯）；都切 = 两边都拆',
        options: [['off', '不切'], ['group', '只群聊切'], ['all', '群聊和私聊都切']],
      },
      { group: '门五 · 分段发送', key: 'splitMaxSegments', label: '最多几条', hint: 'QQ 同一条消息最多被动回复 4 次；默认 3 留一次余量，4 会用满、不建议', kind: 'number', min: 1, max: 4, step: 1 },
      { group: '门五 · 分段发送', key: 'splitMinSegmentLength', label: '短段合并（字）', hint: '短于这个字数的段并进相邻段，「嗯。」不会单独成一条', kind: 'number', min: 1, max: 50, step: 1 },
      { group: '门五 · 分段发送', key: 'splitDelayMs', label: '段间隔（毫秒）', hint: '300 = 每条之间等 0.3 秒，看起来像在一条条打字', kind: 'number', min: 0, max: 3000, step: 50 },
      { group: '门五 · 分段发送', key: 'splitSkipIfShorterThan', label: '太短就不切（字）', hint: '整段短于这个字数就一整条发出去', kind: 'number', min: 1, max: 500, step: 10 },
      { group: '门五 · 分段发送', key: 'splitSkipCodeAndTables', label: '跳过代码和表格', hint: '含 ``` 或 | 表格行的不切，切了会散架', kind: 'switch' },
      { group: '门五 · 分段发送', key: 'splitPattern', label: '切分正则', hint: '默认按 。？！~… 切；写坏了会自动退回不切，不会把话吞掉', kind: 'text' },

      { group: '其他', key: 'forgeRemindDays', label: '炼化提醒（天）', hint: '两个笔记（_说话.md / _人际日记.md）超过这么多天没动，状态栏会标 ⚠', kind: 'number', min: 1, max: 365, step: 1 },

      { group: '其他', key: 'groupMergeAcrossSenders', label: '群里跨人合并', hint: '开 = 两个人同时说的话拼成一条回答（默认关，各回各的）', kind: 'switch' },
      { group: '其他', key: 'debug', label: '调试日志', hint: '开着会把每条消息的判定原因打进宿主日志', kind: 'switch' },
    ]

    const REASON_TEXT = {
      c2c: '私聊必回',
      direct_mention: '@ 了',
      owner: '主人说话',
      name_call: '点名',
      question: '提问过线',
      interest: '兴趣词命中',
      ambient: '随机冒泡',
      probability_miss: '兴趣词没抽中',
      ambient_miss: '随机没抽中',
      cold_group: '冷场开口',
      cooldown: '冷却中',
      fatigue: '疲劳降级',
      no_trigger: '没触发',
      group_denied: '群在黑名单',
      group_not_gated: '该群不参与门槛',
      quiet: '静默满窗口',
      max_wait: '到硬上限',
      max_merge: '到条数上限',
      expire: '过期丢弃',
      dispose: '卸载放行',
    }

    const KIND_TEXT = { flush: '收口', skip: '不回', answer: '回', inject: '注入', collect: '拾荒' }

    async function getJson(path, init) {
      const res = await fetch(`${API}/${path}`, {
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        ...init,
      })
      const text = await res.text()
      let data = null
      try {
        data = text ? JSON.parse(text) : null
      } catch {
        throw new Error(`接口返回了非 JSON（HTTP ${res.status}）`)
      }
      if (!res.ok || !data?.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
      return data
    }

    function lineToArray(text) {
      return String(text ?? '')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
    }

    /** 32 位 openid 太长，列表里只显示头尾（悬停能看到完整值） */
    function shortId(value, head = 4, tail = 4) {
      const s = String(value ?? '').trim()
      if (!s) return ''
      if (s.length <= head + tail + 1) return s
      return `${s.slice(0, head)}…${s.slice(-tail)}`
    }

    /** 群标识：跳过的记录带着 group 字段；收口记录只带 key（group:<gid>:<sid>） */
    function rowGroup(row) {
      if (row?.group) return String(row.group)
      const m = /^group:([^:]+):/.exec(String(row?.key ?? ''))
      return m ? m[1] : ''
    }

    function FieldControl({ field, value, onChange }) {
      const common = { className: 'qg-input', disabled: false }

      if (field.kind === 'switch') {
        const checked = value !== false
        return h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer' } },
          h('input', {
            type: 'checkbox',
            checked,
            onChange: (e) => onChange(e.target.checked),
            style: { width: 15, height: 15, accentColor: 'var(--dsw-alias-brand-primary)' },
          }),
          h('span', { style: { fontSize: 12.5 } }, checked ? '开' : '关'),
        )
      }

      if (field.kind === 'select') {
        return h('select', {
          className: 'qg-select',
          value: String(value ?? ''),
          onChange: (e) => onChange(e.target.value),
        }, field.options.map(([v, text]) => h('option', { key: v, value: v }, text)))
      }

      if (field.kind === 'number') {
        return h('input', {
          ...common,
          className: 'qg-input qg-num',
          type: 'number',
          min: field.min,
          max: field.max,
          step: field.step ?? 1,
          value: Number.isFinite(Number(value)) ? Number(value) : '',
          onChange: (e) => {
            const raw = e.target.value
            onChange(raw === '' ? '' : Number(raw))
          },
        })
      }

      if (field.kind === 'lines') {
        const text = Array.isArray(value) ? value.join('\n') : String(value ?? '')
        return h('textarea', {
          className: 'qg-area',
          spellCheck: false,
          value: text,
          onChange: (e) => onChange(lineToArray(e.target.value)),
        })
      }

      return h('input', {
        ...common,
        type: 'text',
        value: String(value ?? ''),
        onChange: (e) => onChange(e.target.value),
      })
    }

    function StateBar({ data }) {
      const rt = data?.runtime ?? {}
      const hook = rt.hook ?? {}
      const dotClass = hook.ok ? 'qg-dot ok' : hook.hooked ? 'qg-dot warn' : 'qg-dot bad'
      const hookText = hook.ok
        ? `已接管 ${hook.instances} 个 bot 实例`
        : hook.hooked
          ? '钩子就绪，等第一条消息触发注册'
          : '钩子没装上 —— 门槛不生效（机器人本身不受影响）'

      return h('div', { className: 'qg-state' },
        h('span', { className: 'qg-pill' }, h('i', { className: dotClass }), h('span', null, hookText)),
        h('span', { className: 'qg-pill' }, `模式：${data?.config?.mode ?? '?'}`),
        h('span', { className: 'qg-pill' }, `待收口：${rt.pendingBatches ?? 0} 批`),
        rt.lastFlush
          ? h('span', { className: 'qg-pill' },
            `上次收口：${rt.lastFlush.count} 条 / ${REASON_TEXT[rt.lastFlush.why] ?? rt.lastFlush.why}`)
          : null,
        rt.inject
          ? h('span', { className: 'qg-pill', title: `窗口 ${rt.inject.windowMinutes} 分钟 · 最多 ${rt.inject.maxMessages} 条` },
            `旁听：${rt.inject.entries ?? 0} 条 · 注入 ${rt.inject.injected ?? 0} 次`)
          : null,
        rt.collect
          ? h('span', { className: 'qg-pill', title: String(rt.collect.dir ?? '') },
            `拾荒：${rt.collect.saved ?? 0} 张（重 ${rt.collect.skipped ?? 0}）`)
          : null,
        rt.forge
          ? h('span', { className: 'qg-pill', title: (rt.forge.items ?? []).map((f) => `${f.name}: ${f.lastAt ?? '没记过'}`).join(' · ') },
            rt.forge.overdue
              ? `炼化：${rt.forge.days === null ? '没记过' : `${rt.forge.days} 天没动`} ⚠`
              : `炼化：${rt.forge.days === null ? '没记过' : `${rt.forge.days} 天前`}`)
          : null,
      )
    }

    function RecentLog({ rows }) {
      if (!Array.isArray(rows) || rows.length === 0) {
        return h('div', { className: 'qg-log' }, h('div', { className: 'qg-log-row' }, '还没有记录。QQ 上收/发一条消息后再点「重新加载」。'))
      }
      return h('div', { className: 'qg-log' },
        rows.slice(-30).reverse().map((row, i) => h('div', { className: 'qg-log-row', key: `${row.at}-${i}` },
          h('span', { className: 'qg-log-time' }, new Date(row.at).toLocaleTimeString('zh-CN', { hour12: false })),
          h('span', { className: 'qg-log-tag' }, KIND_TEXT[row.kind] ?? row.kind),
          h('span', { className: 'qg-log-tag' }, REASON_TEXT[row.reason ?? row.why] ?? (row.reason ?? row.why ?? '')),
          h('span', { className: 'qg-log-text' },
            row.kind === 'flush'
              ? `${row.count} 条`
              : row.kind === 'inject'
                ? `${row.count} 条 / ${row.chars} 字${row.truncated ? '（截断）' : ''}`
                : String(row.text ?? '')),
          h('span', { className: 'qg-log-id', title: rowGroup(row) }, shortId(rowGroup(row))),
          h('span', { className: 'qg-log-id', title: String(row.sender ?? '') }, shortId(row.sender, 6, 0)),
        )),
      )
    }

    function GateSection() {
      const [data, setData] = useState(null)
      const [draft, setDraft] = useState(null)
      const [busy, setBusy] = useState(false)
      const [message, setMessage] = useState(null)
      const [error, setError] = useState(null)

      const load = useCallback(async () => {
        setError(null)
        try {
          const next = await getJson('state')
          setData(next)
          setDraft({ ...next.config })
        } catch (err) {
          setError(String(err?.message ?? err))
        }
      }, [])

      useEffect(() => {
        void load()
      }, [load])

      const save = useCallback(async () => {
        if (!draft) return
        setBusy(true)
        setError(null)
        setMessage(null)
        try {
          const next = await getJson('config', {
            method: 'POST',
            body: JSON.stringify({ config: draft }),
          })
          setData(next)
          setDraft({ ...next.config })
          setMessage('已保存并立即生效（不需要重启，也不会断开 QQ）')
        } catch (err) {
          setError(String(err?.message ?? err))
        } finally {
          setBusy(false)
        }
      }, [draft])

      const reset = useCallback(async () => {
        setBusy(true)
        setError(null)
        setMessage(null)
        try {
          const next = await getJson('reset', { method: 'POST', body: '{}' })
          setData(next)
          setDraft({ ...next.config })
          setMessage('已恢复成 patch 里的出厂默认值')
        } catch (err) {
          setError(String(err?.message ?? err))
        } finally {
          setBusy(false)
        }
      }, [])

      if (error && !draft) {
        return h('div', { className: 'qg' },
          h('style', null, CSS),
          h('h3', { className: 'qg-title' }, '回话门槛'),
          h('div', { className: 'qg-msg bad' }, `读不到配置：${error}`),
          h('div', { className: 'qg-actions' }, h('button', { className: 'qg-btn qg-btn2', onClick: () => void load() }, '重试')),
        )
      }

      if (!draft) {
        return h('div', { className: 'qg' }, h('style', null, CSS), h('div', { className: 'qg-intro' }, '正在读取配置…'))
      }

      const groups = []
      for (const field of FIELDS) {
        const last = groups[groups.length - 1]
        if (!last || last.name !== field.group) groups.push({ name: field.group, fields: [field] })
        else last.fields.push(field)
      }

      const setField = (key, value) => setDraft((prev) => ({ ...prev, [key]: value }))

      return h('div', { className: 'qg' },
        h('style', null, CSS),
        h('h3', { className: 'qg-title' }, '回话门槛'),
        h('p', { className: 'qg-intro' },
          '门一「攒着说」把连发的几句并成一次请求；门二「该不该说」决定群里要不要接话。保存后立即生效，不断开 QQ。'),
        h(StateBar, { data }),
        groups.map((group) => h('div', { key: group.name },
          h('div', { className: 'qg-group' }, group.name),
          h('div', { className: 'qg-rows' }, group.fields.map((field) => h('div', { className: 'qg-row', key: field.key },
            h('div', null,
              h('div', { className: 'qg-label' }, field.label),
              h('div', { className: 'qg-hint' }, field.hint),
            ),
            h(FieldControl, { field, value: draft[field.key], onChange: (v) => setField(field.key, v) }),
          ))),
        )),
        h('div', { className: 'qg-actions' },
          h('button', { className: 'qg-btn', disabled: busy, onClick: () => void save() }, busy ? '保存中…' : '保存'),
          h('button', { className: 'qg-btn qg-btn2', disabled: busy, onClick: () => void load() }, '重新加载'),
          h('button', { className: 'qg-btn qg-btn2', disabled: busy, onClick: () => void reset() }, '恢复 patch 默认'),
          message ? h('span', { className: 'qg-msg ok' }, message) : null,
          error ? h('span', { className: 'qg-msg bad' }, error) : null,
        ),
        h('div', { className: 'qg-group' }, '最近的判定与收口'),
        h('p', { className: 'qg-hint' },
          '「不回」的记录就是门槛拦下来的消息：它仍然进了群历史，只是没进 agent。'
          + '右边两列是群标识和发言人——群标识就是白名单/黑名单里要填的那个值（悬停看完整）。'),
        h(RecentLog, { rows: data?.recent ?? [] }),
        h('p', { className: 'qg-hint' },
          `参数存在 ${data?.overridesFile ?? '~/.dsh-qqbot/gate-config.json'}；状态文件 ${data?.statusFile ?? ''}。`),
      )
    }

    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register(
        { name: 'settings.section', id: NS, order: ROW_ORDER, label: () => '回话门槛' },
        GateSection,
      ), 'qqbot-gate: settings section')
    }

    return { inject: ['slots'], apply }
  },
})
