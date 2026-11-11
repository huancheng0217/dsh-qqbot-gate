# dsh-qqbot-gate

给 QQ 机器人加五道门：**「攒着说」**、**「该不该说」**、**「听见什么」**、**「别让内部话漏出去」**、**「像人一样分几条发」**。

不改官方插件、不 fork、不重启就生效；`mode: off` 一键回到没装过的样子。

> **适配版本**：在 `@tencent-connect/dsh-qqbot` **0.5.5** + `@tencent-connect/qqbot-nodejs` **1.0.5** 上验证通过。
> 本插件钩的是 SDK 内部契约（`QQBot.prototype.use` / `middlewares` / `handleInboundMessage`），
> 换了版本不一定工作——**但不会把机器人搞坏**：钩子装不上时会自检失败并降级，
> 所有功能失效、官方插件照常收发行，原因写在 `~/.dsh-qqbot/gate-status.json` 的 `hook` 段。

```
QQ 消息
  │
  ├─ 该不该说？── 不回 ──> 交给官方 mentionGate 挡下（消息照样记进群历史，只是不打扰）
  │
  └─ 要回 ──> 攒 3 秒，把连发的几句合成一条 ──> 补上「刚才群里的闲聊」当背景 ──> 走完整官方链 ──> agent（一次请求）
```

---

## 安装

**前提**：你得先有一个能跑起来的 `@tencent-connect/dsh-qqbot`（官方 QQ 机器人插件，扫码绑定、收发消息正常）。本插件不改它，只在它外面包一层中间件。

### 1. 装

```bash
# GitHub
dsh plugin --profile <你的 profile> add github:huancheng0217/dsh-qqbot-gate

# 或者本地开发：clone 下来后 link
dsh plugin --profile <你的 profile> add link:/path/to/dsh-qqbot-gate
```

> **如果 profile 由 Electron 桌面版独占管理**（会报 `profile "desktop" is managed exclusively by the Electron application`），走手工方式：`package.json` 的 `dependencies` 加 `"dsh-qqbot-gate": "link:/path/to/it"`、`dsh.profile.bundles` 加 `"dsh-qqbot-gate"`、`node_modules` 下建目录联接（`mklink /J`），最后**重启**。

### 2. 配

配置有两处，**用户值优先于出厂默认**：

| 位置 | 作用 |
| --- | --- |
| profile 的 `cordis.patch.yml` 里 `- id: qqbot-gate` 段 | 出厂默认。**改它会触发宿主热重载** |
| `~/.dsh-qqbot/gate-config.json` | 设置页保存的值，**优先于 patch**。只热应用配置，不换代码 |

**别手写 `gate-config.json`**——它只在插件加载时读一次，手写不会热应用，设置页还显示旧值，一保存就覆盖掉了。

改配置请打开 **设置 → 回话门槛**。

> ⚠️ **本插件不存 QQ 的 appId / appSecret。**那些是官方 `dsh-qqbot` 的配置，不在这里填。

### 3. 验收

重启后看两处：

- 设置页「回话门槛」能打开、能保存；
- `~/.dsh-qqbot/gate-status.json` 开始更新（含 `hook.instances`、`recent` 判定记录）。

`hook.instances` 是 bot 实例数——**它是 0 表示 QQ 网关根本没登上**，那不是本插件的问题，去查 `dsh-qqbot` 的密钥是否失效。

### 4. 回滚

| 档 | 做法 |
| --- | --- |
| 最轻 | 设置页把 `mode` 改成 `off`（完全空转，等于没装） |
| 中 | `enabled: false` |
| 彻底 | 从 `dsh.profile.bundles` 里删掉 |

---

## 它解决什么

| 现象 | 门 |
|---|---|
| 你连发三条，机器人回三次，且前言不搭后语 | 门一：防抖合并 |
| 群里谁说话机器人都接，抢话、刷屏 | 门二：群聊唤醒判定 |
| 机器人接话突兀，不知道刚才在聊什么 | 门三：旁听注入 |
| 群里好玩的图/表情包一闪就过，找不回来 | 门三：拾荒采集 |
| 机器人把自己的内部维护话术、工具报错发进群里 | 门四：出站过滤 |
| 一整段长文糊成一坨，QQ 里没法读 | 门五：分段发送 |

**它不改什么**：流式、工具调用、审批、问答通道、会话管理，全部还是官方的。

> 开头那张图只画了门一、门二的主链路。门三到门五在下面各自的章节。

---

## 三档模式

| `mode` | 行为 | 什么时候用 |
|---|---|---|
| `off` | 完全空转，等于没装 | 出问题时一键回滚 |
| `debounce` | 只合并连发消息，不筛内容 | **默认，先跑两天** |
| `gate` | 合并 + 群聊门槛（不是每句都说） | 防抖验证稳定后 |

改完由宿主热重载，不用重启。

---

## 门一 · 攒着说

**问题**：你连发三条，机器人回三次——而且处理第一条的时候后面两条已经在排队，答案前言不搭后语。

**做法**：把一小段时间内的连发**收口成一次** agent 请求。六条规则：

| 规则 | 行为 |
| --- | --- |
| 滑动窗口 | 每来一条就重新计时，`debounceSeconds` 内没有新消息才算说完 |
| 硬上限 | 到 `maxWaitSeconds` 强制作答——防「一直说话的人永远得不到回复」 |
| 条数上限 | 攒到 `maxMergeMessages` 条立刻收口，不等计时器 |
| 去重 | 同一个人发同一句话，窗口内只算一条 |
| 带图更久 | 图片常有后续补充，单独用 `imageDebounceSeconds` |
| 命令直通 | `/` 开头不缓冲，否则 `/stop` 也要等三秒 |

被吸收的那几条**不会各自进 agent**，它们合成一条文本。带过附件的话会在合并文本里注明
（附件本身没法合并，只有最后一条的会跟着走）。

---

## 门二 · 该不该说（`mode: gate`）

**强唤醒 —— 一票通过，不看概率、不受冷却/疲劳限制：**

1. `@` 了机器人（`GROUP_AT_MESSAGE_CREATE` / `mentions.is_you` / 文本里的 `<@!appId>`）
2. 主人在群里说话（`ownerOpenids` 里的人）
3. 点名叫到机器人（`botNames` 里的词）

**弱唤醒 —— 要过打分/概率，且受抑制器管：**

4. 提问打分 ≥ `questionThreshold`（默认 65）
   `？` +40 · 疑问词 +25 · 「你/你们」+15 · 长度≥4 +10 · 纯表情/复读 −30
5. **接话概率**（两条并存）
   - 没命中兴趣词的普通内容 → 抽 `ambientProbability`（默认 9%）：群里总有想插一句的时候
   - 命中 `interestKeywords` → 换成 `interestProbability`（默认 50%）：说到我在意的，更可能开口
   - 纯表情/复读/纯标点**不进随机池**（对一堆表情符随机接话只会显得傻）
6. 冷场唤醒（`coldGroupIdleMinutes > 0` 才启用，默认关）

**抑制器（只压弱唤醒）：**

- 冷却：同群上次放行后 `cooldownSeconds` 内不再主动开口
- 疲劳：`fatigueWindowSeconds` 内已放行满 `fatigueLimit` 次，降级成只回强唤醒

没说话的那条会打一行日志：`不回(no_trigger) 群=... 人=... 文本="..."`。
**它同时仍然进了群历史缓冲**，只是没进 agent。

### 峰时省话（`peakQuietEnabled`，默认开）

DeepSeek 有峰谷计价，贵的时段少说话等于直接省钱。**峰时只放行强唤醒和兴趣词**，
提问打分、基础冒泡、冷场全部不接。

| 项 | 值 |
| --- | --- |
| 峰时时段 | 默认 `09:00-12:00,14:00-18:00`（北京时间，可填多段、可跨零点） |
| 只算工作日 | 默认开——**周末全天是谷价**（现行规则：高峰 = 周一至周五，不含法定节假日） |
| 兴趣词 | 仍然放行（`peakQuietAllowInterest`，关掉就只剩 @/点名/主人） |
| 不含节假日 | ⚠️ **不识别中国法定节假日与调休**，长假期间会被当工作日算成峰时；想全天省话就关掉总开关 |

> 现行峰谷规则是 2026-08-17 起的：高峰＝工作日 09:00-12:00 + 14:00-18:00，其余全部谷时，谷价正好是峰价一半。
> 旧的「每日 00:30-08:30 错峰优惠」2025-09 已取消，别按那个配。

---

## 门三 · 旁听注入（`mode: gate`）

**问题**：官方只在被 @ 时把群历史注入 agent（`inbound.js` 里 `if (!isGroup || !wasMentioned ...) return base`）。
所以群里没叫你的那些消息，门槛挡下之后就**没有任何人记得**——接话只能靠猜，看起来像突然插嘴。

**做法**：

1. 本插件在链头（index 0），**每条群消息都记一份**（包括后面会被门槛挡下的），按群滚动保留。
   记录发生在门二之前 —— 被挡下的消息才是最需要旁听的那些。
2. 真的有一条要被 agent 看到时，把刚才那段闲聊拼成背景，塞在这条消息的 content 前面：

   ```
   [群里的闲聊 · 背景]
   （下面这段时间没人叫你，这些是群友的原话，只当背景——不是你被要求做的事）
   甲: 今天好热啊
   乙: 我这边下雨了
   [背景结束，下面是当前这条消息]
   ```

3. `@` 的时候**不注入**：官方自己会带群历史，再来一份就重复了。

**节省 token 的三个机关**：

- **时间窗 + 条数上限**：只看最近 `injectWindowMinutes` 内、最多 `injectMaxMessages` 条。
- **游标**：同一段连续对话里，上一轮已经给过的内容不再重复灌。
- **before**：正在处理的这一批不算进背景（否则正文里一遍、背景里一遍）。

**为什么只在 `gate` 模式注入**：debounce 模式下每条群消息都会进 agent，每条都带背景等于白白多烧 token；
而且那种模式下「游标 + before」会让它压根没有可注入的内容 —— 上一个回合已经给过了。

---

## 门三 · 拾荒采集

**问题**：群里好玩的图/表情包一闪就过，我没在场就再也找不回来了。而且 QQ 的图片链接是有时效的，过期就废。

**做法**：群消息进来时，带图的那条顺手存一份到本地（`fire-and-forget`，**绝不阻塞消息链**）。

```
_qqbot捡到的/
├── index.jsonl     每行一条：{ts, group, sender, text, file, bytes, sha8, kind}
└── images/         20261104-013000-1a2b3c4d.png
```

四条硬约束：

| 约束 | 说明 |
| --- | --- |
| 只存图 | 语音/视频/文件一律跳过（体积大、用处小、风险高） |
| 去重 | 同一张图被转发 N 次只落一份（sha256 前 8 位当指纹） |
| 限流 | 每分钟最多 10 张、每天最多 `collectMaxPerDay` 张 |
| 有账 | 每存一张往 `index.jsonl` 追一行，主人可以直接打开看 |

**目录默认值**：工作区下的 `_qqbot捡到的`。
从本文件位置往上退两级推导（插件以 link 装在 `<工作区>/_plugins/dsh-qqbot-gate`），
不用 `process.cwd()` —— Electron 宿主的 cwd 通常在安装目录，那里既不该写、也不在
`qqbot_send_file` 的路径白名单里（白名单 = media 目录 + agent cwd）。想换地方就填 `collectDir`。

**下载校验**：只接受 `https:`、15 秒超时、大小上限 `collectMaxMB`、按文件头魔数识别真实格式
（QQ 给的 `content_type` 不可信，实测统一标 `image/png`）。

**清理**：每天最多跑一次，删掉超过 `collectKeepDays` 天的图，并把 index 里对应行一起删掉。

**投递**：本插件只负责「存」。挑哪张、发不发，是模型在私聊窗口里用自己的判断做的
（`qqbot_send_file` 传绝对路径）。

**状态栏**：设置页顶部会多两个计数 —— `旁听：N 条 · 注入 M 次`、`拾荒：N 张（重 M）`，
外加一个 `炼化：N 天前 / N 天没动 ⚠`（读 `_说话.md` 与 `_人际日记.md` 头部的「上次炼化」日期，
超过 `forgeRemindDays` 就标 ⚠ —— 对应教训「记下来 ≠ 处理掉」）。

---

## 门四 · 出站过滤

**问题**（2026-11-04 真事故）：记忆插件的 dream 会往当前会话注入指令，而 agent 的回复就是用户可见输出。
QQ 群会话空闲 3 小时也会跑 dream，于是「记完了。这一轮落下的东西…」直接发进了群，连工具报错
`FsError: FS_EDIT_NOT_FOUND` 都一起出去了。

**做法**：这一层是**兜底**。真正治本的是别让 QQ 会话跑 dream（给会话打 dream_skip）；
但真出问题（上下文被压缩、提示词被冲掉）时，得靠代码拦住。命中就**丢弃并记日志**，
不抛错、不回复用户，静默得像没发生。

**取舍**：只挡**几乎不可能出现在正常聊天里**的特征——记忆插件自己的标记、dream 收尾话术、
`FsError` 这类工具报错、以及 Windows 绝对路径。不挡普通词（比如「记忆」），那会误伤群友的正常发言。

| 项 | 说明 |
| --- | --- |
| 开关 | `outguardEnabled`（默认开） |
| 内置规则 | 代码里的 `DEFAULT_PATTERNS`，改它要改代码 |
| 为什么连路径也挡 | 群里只说「我的房间」，不说目录名 |

> ⚠️ **只在群聊生效。** `dsh-qqbot` 的私聊走**流式输出**（`outbound.js` 的 `shouldStream` → `openStream()` 的 `session.update/complete`），
> 完全不经过 `QQBot.prototype.sendMarkdown`，而这一层就挂在那里。所以私聊里这条过滤是哑的。
> 判断依据：私聊发一条消息，`gate-status.json` 的 `outLog` 会不会多一条——不会，就说明走了流式。
> 想连私聊一起挡，得额外钩 `openStream`，或者从源头给会话打 dream_skip。

---

## 门五 · 分段发送

**问题**：一整段长文糊在一个气泡里，QQ 客户端上就是没法读。

**做法**：把一轮回复按标点切成几条依次发出，像人在打字。装在 `QQBot.prototype.sendMarkdown` 上，
所以只影响文本，**图片/文件不走这条路**。

**装载顺序有讲究**：分段必须包在门四外面
（`splitter` 在外 → `outguard` 在内 → 原方法）。
反过来的话，过滤会先看到整段长文，命中就整条吞掉，分段根本没机会跑。

| 参数 | 说明 |
| --- | --- |
| `splitEnabled` | 默认**关**，要自己打开 |
| `splitMode` | `group`（只群聊切，私聊一次说完）/ `all` / `off` |
| `splitPattern` | 切分正则。**字符类里的 `\n` 不能删**——删了会丢没有标点的整行（见「已知限制」） |
| `splitMaxSegments` | 一轮最多切几条，上限 4 |
| `splitMinSegmentLength` | 短于这个字数的段会并进相邻段，避免「嗯。」单独成条 |
| `splitDelayMs` | 两条之间停多久，像在打字 |
| `splitSkipIfShorterThan` | 整条短于这个字数就不切 |
| `splitSkipCodeAndTables` | 含代码块或表格不切（切开就散架了） |

> **`splitMaxSegments` 为什么上限是 4**：`dsh-qqbot` 里写死了 `new ReplyLimiter({ limit: 4 })`，
> 约束**同一条用户消息**能被被动回复几次。切成 N 条就消耗 N 次。
> 切到 4 正好用满、一点余量不剩；留 3 是更稳的选择。
> 超出的部分会先换缓存里别的 msgId 兜底，全都不可用才降级成主动推送（那要烧主动额度）。

> ⚠️ **同样只在群聊生效**（原因和门四一样：私聊走流式，不经过 `sendMarkdown`）。
> 所以 `splitMode: all` 在私聊里其实切不动——真要切私聊，得先关掉 `streaming`。

---

## 配置

写进 profile 的 `cordis.patch.yml`，`id: qqbot-gate` 那一段。改的是**整段 config**（不是合并），所以照抄一份再改。

```yaml
- id: qqbot-gate
  name: dsh-qqbot-gate
  config:
    enabled: true
    mode: debounce            # off | debounce | gate

    # ── 门一：攒着说 ──
    debounceSeconds: 3        # 静默多久算说完
    maxWaitSeconds: 12        # 最长等多久必回（防"一直说话的人永远得不到回复"）
    maxMergeMessages: 8       # 一次最多合并几条
    imageDebounceSeconds: 8   # 带图的消息多等一会（常有后续补充）
    dedupeWindowSeconds: 30   # 同人同文本在窗口内只算一条

    # ── 门二：该不该说 ──
    groupMode: open           # open | allowlist
    groupAllow: []
    groupDeny: []
    ownerOpenids: []          # 主人在群里说话一律回
    botNames: []              # 点名，如 ["鲸鱼","女仆","D酱"]
    takeOverMentionGate: true # gate 模式下由本插件决定"要不要 @"，覆盖官方 requireMention
    interestKeywords: []
    interestProbability: 50
    ambientProbability: 9       # 没命中兴趣词时的随机冒泡率，0 = 只在感兴趣时说
    questionThreshold: 65
    cooldownSeconds: 90
    fatigueLimit: 5
    fatigueWindowSeconds: 300
    coldGroupIdleMinutes: 0   # 0 = 关闭冷场唤醒
    groupMergeAcrossSenders: false  # 群里不同人的话要不要拼成一条

    # ── 峰时省话（DeepSeek 贵价时段只回强唤醒和兴趣词）──
    peakQuietEnabled: true
    peakQuietWindows: '09:00-12:00,14:00-18:00'  # 北京时间，可多段、可跨零点
    peakQuietWeekdaysOnly: true   # 周末全天谷价，不算峰时
    peakQuietAllowInterest: true  # 关掉 = 峰时只回 @ / 点名 / 主人

    # ── 门三：旁听注入（只在 gate 模式生效）──
    injectEnabled: true
    injectWindowMinutes: 15   # 往回看多久
    injectMaxMessages: 30     # 最多带几条（和时间窗谁先到算谁）
    injectMaxChars: 80        # 单条截断字数

    # ── 门三：拾荒采集 ──
    collectEnabled: true
    collectGroups: []         # 空 = 全部群
    collectMaxPerDay: 60      # 每天最多存几张
    collectMaxMB: 5           # 单图上限
    collectKeepDays: 7        # 保留天数
    collectDir: ''            # 空 = <工作区>/_qqbot捡到的
    forgeRemindDays: 7        # 两个笔记超过几天没炼就标 ⚠

    # ── 门四：出站过滤（挡内部维护输出、工具报错、Windows 路径）──
    outguardEnabled: true

    # ── 门五：分段发送（默认关，要自己打开）──
    splitEnabled: false
    splitMode: group          # off | group | all
    splitPattern: '.*?[。？！~…\n]+|.+$'   # 字符类里的 \n 不能删，删了会丢整行
    splitMaxSegments: 3       # 上限 4（= ReplyLimiter limit），3 留一次余量
    splitMinSegmentLength: 6
    splitDelayMs: 300
    splitSkipIfShorterThan: 20
    splitSkipCodeAndTables: true

    debug: false              # true = 每条消息都打判定原因
```

**`ownerOpenids`**：群里 `senderId` 和私聊 openid 是同一套 user openid。
现成的可以从 `~/.dsh-qqbot/model-prefs.json` 里 `qqbot:<appId>:c2c:<openid>` 读出来。

---

## 日志与排障

日志前缀 `[qgate]`，在宿主日志里搜。

```
[qgate] 模式=debounce（只防抖（把连发攒成一次，不筛内容）） 防抖=3s 硬上限=12s 合并上限=8
[qgate] 钩子已装上 via=C:\Users\...\node_modules\@tencent-connect\qqbot-nodejs\dist\index.js
[qgate] 已接管 1 个 bot 实例
[qgate] 收口(quiet) key=c2c:XXXX 条数=3 用时=3012ms
[qgate] 不回(no_trigger) 群=G... 人=甲 文本="今天好热啊"
```

**看到这两行就说明门槛没生效**（但机器人本身不受影响）：

```
[qgate] 钩子未装上（sdk-not-found）...
[qgate] 钩子就绪，等第一个 bot 实例（下一条 QQ 消息到达时会自动注册）
```

第二行是正常的等待态，第一条消息到达后就变成「已接管 1 个 bot 实例」。

---

## 它怎么插进去的（技术要点）

`dsh-qqbot` 把 bot 当局部变量，没暴露成服务。能用的入口只有 SDK 类原型上的两个方法：

- `QQBot.prototype.use(...)` —— dsh-qqbot 建好 bot 立刻连调十几次
- `QQBot.prototype.handleInboundMessage(raw)` —— 每条入站消息都走

两个都钩，谁先到都能抓到实例。抓到的瞬间 `bot.middlewares.unshift(我们的层)`。
SDK 每条消息都现拼链（`const chain = [...this.middlewares, downstream]`），所以**任何时刻插入，下一条消息立即生效**，不用重启；注册发生在原方法体之前，连第一条也不会漏。

「不说话」不靠自己 `stop()`，而是写 `ctx.state.policy.group.requireMention`，由官方 `mentionGate` 执行 —— 这是 SDK 文档化的策略注入点，比我们自己拦截稳。

**唯一脆的地方**：SDK 内部字段名（`middlewares` / `handleInboundMessage`）。官方哪天改了，插件会自检失败并降级，机器人照常工作，只是门槛失效 —— 日志里看得见，不会静默。

---

## 已知限制

1. **生成中不支持打断**。回复已经开始生成，新消息只能排下一轮。
2. **命令直通**：`/` 开头不缓冲（`//` 开头的普通聊天也会被当命令，与官方 `slashCommand` 判定一致）。
3. **被吸收消息的附件会丢**：3 秒内先发图再说话，只有最后一条的附件进 agent；合并文本里会注明「之前还有 N 条带了图片/文件」。
4. **群里不同人默认各成一批**（`groupMergeAcrossSenders: false`）。想"一句话回答两个人"再开。
5. **群聊历史上下文**：官方只对 `wasMentioned` 的消息注入群历史（`inbound.js` 里 `if (!isGroup || !wasMentioned ...) return base`）。
   本插件的门三在 `gate` 模式下补这一段（见上文），debounce 模式下不补（省 token）。
   旁听环**只在内存里**：插件重载就清空，最多丢十几分钟的闲聊；要落盘得靠「拾荒采集」。
6. **待答问题会晚 3 秒**：用户在等 `ask_user_question` 的答案时回一句「1」，这条也要过防抖窗口。3 秒不影响功能（官方超时 5 分钟）。
7. **分段正则有坑，动它要跑测试**：`String.match(re, 'g')` 会**静默丢掉没匹配到的片段**。
   旧的 `.*?[。？！~…]+|.+$` 里 `.` 不匹配换行，所以「一整行没有标点」的行匹配不上、整行消失
   （实测 5 个样本丢 4 个，最长吞掉开头一整段）。把它加进字符类后拼回才完整。
   `tests/splitter.test.mjs` 里有一条专门断言 `parts.join('') === 原文` 的回归测试，别删。

---

## 下一步（如果愿意继续做）

- ~~**群聊历史注入**~~：已做（门三 · 旁听）。
- ~~**拾荒采集**~~：已做（门三 · 拾荒），含下载、去重、保留期。**投递仍靠模型自己判断**——插件只负责存。
- **主动插话**：冷场定时器 + 每群每日上限，属于另一条通道（"没人理它它主动说"）。
- **小模型智能收口**：只有"疑似半句话"时才问一次小模型，比固定窗口更聪明，代价是延迟和成本。
- **提 PR 给官方**：加 `debounce` 配置项 + 暴露 bot 实例给其他插件。PR 合并后本插件可以退化成薄配置层。

---

## 测试

```bash
cd _plugins/dsh-qqbot-gate
node tests/config.test.mjs        # 配置夹紧、默认值
node tests/merge.test.mjs         # 文本合并、群标识取哪个字段
node tests/gate.test.mjs          # 门二判定管线：强唤醒/打分/概率/冷却/疲劳
node tests/debounce.test.mjs      # 门一六条规则（虚拟时钟，不用真等）
node tests/inject.test.mjs        # 门三旁听环 + 背景拼装
node tests/collect-media.test.mjs # 门三拾荒：魔数识别/去重/限流/清理
node tests/forge.test.mjs         # 「上次炼化」读取与超期判断
node tests/outguard.test.mjs      # 门四：该挡的挡、不该挡的不误杀
node tests/splitter.test.mjs      # 门五：切点、条数上限、**不丢字**
node tests/hook.test.mjs          # 钩子、幂等、热重载
node tests/integration.chain.test.mjs  # 塞进真 SDK 中间件链跑
```

> 不要用 `node --test tests/`：测试运行器会 spawn 子进程，在沙箱里会 EPERM。逐个文件跑即可。

集成测试里最关键的两条是 **「policy 注入真的能覆盖官方 mentionGate 的配置」** 和 **「连发三条只产生一次下游调用」** —— 这两个前提不成立，整个方案就得换。
