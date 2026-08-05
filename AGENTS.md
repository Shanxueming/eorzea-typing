# 项目:eorzea-typing

FF14 主题网页打字游戏。**这份文档描述的是当前实际状态,不是原始开发计划**——
`CODEX_PLAN.md` 是项目最初的规格文档(v4),写于开工之前,现在已经过时,
仅作历史参考。真要了解现状,看这份 AGENTS.md 和代码本身。

## 现状:功能已经完整,不是从零开始

M0→M5 六个里程碑(脚手架、单机 Boss 战、双人联机、反作弊接入、小人动效与部署)
全部完成,之后又做了三轮用户驱动的功能迭代:

1. 素材抠图(p1/p2 猫娘小人、兔子错误提示、泰坦剪影)+ 打错时的烟雾特效与合成音效
2. P1/P2 多套皮肤 + 兔子多套风格的运行时选择框架
3. 联机血条机制重做(两人共用一条血条,归零秒结,不再有"倒地复活")+
   房主流程(房主选难度点开始,非房主先准备)+ 普通词限时 + 打断回血 +
   一个字打错立刻算失败 + 读条前 1 秒预警 + 连击数分列左右

`git log --oneline` 能看到每个阶段的完整 commit 历史与理由,commit message
写得比这份文档更细,遇到"为什么这么设计"先去翻 commit message。

## 开工第一件事

```bash
pnpm install && pnpm test
```

**50 个单测 + `scripts/smoke-coop.ts` 联机冒烟测试必须全绿。**
任何时候测试变红,先修复再继续,不要在红的基础上继续加功能。

## 仓库结构

```
packages/shared/src/       判分、随机、词库、反作弊、IME 状态机、战斗常量与协议类型
apps/web/                  React + Vite 前端
  src/scenes/               MainMenu / SoloBattle / Results / Lobby / CoopSession / CoopBattle / CoopResults
  src/components/            BossPanel / TypingField / Avatar / PartyList / HpBar / SkinPicker
  src/engine/                useTypingInput / audio / assets(素材探测) / skinPrefs(皮肤选择持久化) / coopProtocol
  src/battle/constants.ts    从 shared 重导出战斗常量 + 前端专属的动画时长/难度显示表
apps/server/src/            Fastify 静态资源托管 + WebSocket 房间状态机
  rooms/room.ts              房间状态机主体,单个房间的完整生命周期都在这一个类里
  rooms/protocol.ts          C2S/S2C 协议类型(权威定义,apps/web/src/engine/coopProtocol.ts 是前端镜像)
  rooms/wordbankStore.ts     服务端自己的词库读取(不依赖前端的 loader)
data/wordbanks/             96,828 条词库,只读,见 data/wordbanks/README.md
assets/                     素材目录,见下面「素材约定」
scripts/
  smoke-coop.ts               联机集成测试,起临时服务端 + 两个真实 WS 客户端
  process_avatars.py          一次性抠图脚本(白底/黑底洪水填充去背景),留着方便复用
```

## 八个"原始只读文件"——现在只剩一半还完全没动过

最初的开发计划把这八个文件划为只读:

- `packages/shared/src/{types,rng,scoring,anticheat,typingReducer,wordbank}.ts`
- `apps/web/src/engine/{useTypingInput,audio}.ts`

**判分、随机、反作弊、IME 状态机四个文件(types/rng/scoring/anticheat/typingReducer/wordbank)
从未改动过,继续当只读文件对待,不要重写或"优化"。**

`audio.ts` 后来破例加过一次:新增 `'poof'` 音效类型(打错弹兔子时的烟雾弹音),
只加了一个枚举成员和一条纯新增的音色定义,没碰其余四种音效的参数或类方法。
如果还要加新音色,同样的克制原则:只加,不改现有的。

`packages/shared/src/battle.ts` 是后来新增的文件(不在原始八件套里),放战斗
常量(血量/伤害/难度倍数/普通词限时倍数等)和 `createWordQueue`/`verdictOf`
这两个跨端共用的函数。**新增战斗常量或跨端共用逻辑都往这个文件加**,不要在
apps/web 和 apps/server 里各写一份可能跑偏的副本。

## 联机协议(WS)

权威定义在 `apps/server/src/rooms/protocol.ts`,前端镜像在
`apps/web/src/engine/coopProtocol.ts`——**两边字段必须手动保持同步**,改协议
两个文件都要改。当前完整字段见那两个文件顶部的注释,记录了每一处相对最初
"CODEX_PLAN.md §5"协议的新增和理由。核心点:

- 房主流程:第一个加入房间的人是房主(`PlayerPublic.isHost`),没有「准备」
  按钮,选好难度后发 `{t:'start', difficulty}`。非房主先发 `{t:'ready'}`,
  房主才能点开始。
- 联机两人**共用一条血条**(`score_tick.teamHp`),不是各自一条。归零直接
  结束战斗(判负),没有个人复活。
- `PlayerTick.combo` 是服务端广播的权威连击数,前端不要再本地维护一份。
- `boss_cast_warning` 在真正的 `boss_cast` 前 1 秒广播,预警阶段还打不了。
- 词序列(`createWordQueue(pool, seed)`)客户端和服务端各自独立生成,只靠
  相同的 seed 保证一致——服务端不主动推送"当前该打哪个词",只在
  `word_attempt` 到达时核对 wordId 是否对得上。这是乐观预测 + 服务端权威
  校验的设计,改动前先想清楚这个前提。

## 战斗规则速览(写代码前对一下,别凭直觉猜)

- 打对普通词:`computeDamage(difficulty, combo, false)` 扣 Boss 血,连击 +1。
- **输入模式**(`InputMode`,和 `TypingMode` 是两个正交维度):
  - `composed` 组合输入(默认):缓存区语义,输入随便改,不匹配只把输入框染红,
    既不判负也不清空,内容完全等于目标词才算过。
  - `sequential` 逐字输入:一旦输入不再是目标词的前缀就算打错。
  - **地狱难度强制逐字**(`resolveInputMode`):「打错立刻判负」与「错了可以改」
    语义互斥。服务端会自己再收敛一次,不信客户端下发的值。
  - ★ 判定函数一个字没改 —— `judgeInput` 的四个状态对两种模式都够用,区别只在
    战斗场景怎么响应 `error`,所以只读的 scoring.ts / typingReducer.ts 没被动过。
- 打错一个字:逐字模式下**只有地狱难度**会立刻结算为失败,简单/普通/困难都允许
  原词重输(清空输入、不重置该词的限时起点,见 `useTypingInput` 的 `reset`);
  组合模式下打错完全不结算。
- 普通词也**限时**:时限是这局读条时长(按难度换算过)的 2.5 倍
  (`NORMAL_WORD_TIMEOUT_MULTIPLIER`),超时按失败处理。联机由服务端用
  定时器强制执行,客户端本地也跑一份同样的计时器保持体验一致。
- 读条(泰坦之怒)**不按墙钟定时**,而是在每次普通词结算之后按概率插进来
  (`TITAN_WRATH_ON_SUCCESS_CHANCE` / `TITAN_WRATH_ON_FAILURE_CHANCE`),
  所以不会抢断玩家正在输入的词。实际概率一律走 `titanWrathChance()`:
  每多结算一个词加 `TITAN_WRATH_PITY_STEP`(封顶 `PITY_CAP`)的保底,触发后
  计数归零;触发后 `TITAN_WRATH_COOLDOWN_WORDS` 个词内必不再触发,
  **地狱难度不吃这层冷却**。计数器在联机侧是**全房一份**,不是每人一份。打断词固定取 ≤4 个判定字符的短词
  (`pickShortInterruptWord`)。打断成功用
  `computeDamage(word.difficulty, combo, true)`,并回血
  `PLAYER_HEAL_ON_INTERRUPT`;窗口内没人打断算团队躲避失败,扣
  `PLAYER_DAMAGE_ON_FAIL`。
- **Boss 机制统一在 `packages/shared/src/mechanics.ts`**,三个机制(泰坦之怒 /
  三连桶 / 三穿一)共用同一条路径:战斗场景只认 `MechanicState`,不认识任何
  具体机制。**加新机制看那个文件顶部的四步说明**,不要往战斗场景里加 if。
  - 触发方式抽象成 `trigger`:泰坦之怒是「每次普通词结算按概率」,三连桶与
    三穿一是「Boss 血量跌破 67% / 33%」(无限模式改用 80/60/40/20 各自掷骰)。
  - ⚠ **每一条让 Boss 掉血的路径都要调 `tryTriggerHpMechanic`**。打断成功带
    2.5 倍伤害加成,一击跨过整个阈值区间是常事 —— 漏一处就会让那一档机制被
    静默跳过,不报任何错。目前有两处:普通词命中、机制成功。
  - 机制词从**没按难度筛过的完整池**取(理由同打断词)。
- **泰坦之怒是「插进来」的一次挑战,不消耗普通词队列**:普通词在打断期间原地
  冻结(连它的限时计时器一起停),打完读条回到同一个词接着打。服务端
  `Room.triggerCast` 不动 `bs.currentWord`,单机 `SoloBattle` 用
  `pendingNormalWord` 存,两边语义必须一致 —— 理由见下面「已知的坑」第 6 条。
- **角色与技能**(目前只有单人模式有,联机仍是「P1/P2 = 座位」):
  - p1 黑皮猫娘「原初的解放」:换掉当前词、连击不断,**不造成任何伤害**,
    也不推进保底计数器 —— 它不是一次结算,只是换一个词。
  - p2 灰皮猫娘「浴血」:接下来 `BLOODBATH_WORDS` 个词伤害与扣血同时 ×1.5,
    普通词限时 ×`BLOODBATH_TIME_SCALE`。奖惩一起放大是它的设计核心,
    只放大奖励就成了纯收益。
  - 冷却 `SKILL_COOLDOWN_MS`,一局(180 秒)大约能开两次。**打断期间不能开**:
    读条阶段放行会让「原初的解放」变成白嫖打断。
  - 角色和皮肤是两层:角色决定技能,皮肤只是同一角色的不同外观(仍存
    localStorage,不进协议)。
- **玩法模式**(`GameMode`):
  - `standard` 标准:打 `BATTLE_DURATION_MS` 一局,打死泰坦通关,时间到判负。
  - `endless` 无限:没有狂暴倒计时,泰坦打死一只立刻刷下一只、血量按
    `ENDLESS_BOSS_HP_GROWTH` 逐只加厚,击杀回血 `ENDLESS_KILL_HEAL`,
    **玩家血量归零才结束**。难度固定 `ENDLESS_DIFFICULTY`(困难)以便成绩可比,
    输入模式仍由玩家选但会记进成绩。
- ⚠ **反作弊:单机跑的那一份只是「本机自查」,不是防线**。
  `SoloBattle` 局末会跑 `checkAttempt`(逐次硬校验)+ `analyzeSession`(整局节奏
  统计),把 `trustScore`/`trustFlags` 记进成绩 —— 它挡得住随手写的自动化脚本
  (实测一个合成事件脚本会拿到 0 分、命中六个 flag),但**挡不住认真改客户端的人**,
  因为它就跑在玩家自己的浏览器里,改个数字就是 100 分。
  **排行榜真正的防线必须是服务端重放**:上榜时把 `attempts` + `seed` + 配置
  一起上传,服务端用同一个 seed 重建词序列、逐个核对 wordId/submitted、重跑两层
  反作弊、重算得分,再和客户端声称的对比。这一步还没做,做排行榜时必须补上,
  否则单机成绩形同虚设(联机不受影响 —— 它本来就每一次提交都在服务端校验)。
- **成绩记录**在 `apps/web/src/engine/records.ts`,目前落 localStorage。
  `GameRecord` 是按「一条可上传的成绩」设计的,不是按界面形状 —— 等账号系统和
  数据库定下来,同一个对象直接 POST 上去即可,不用改调用方。**比较成绩必须
  三个维度都一致**(玩法 + 难度 + 输入模式):拿组合输入的成绩去比逐字的纪录
  没有意义,组合输入允许反复退格,准确率天然更低。
- **四档难度的全部差异**都集中在 `packages/shared/src/battle.ts` 的几张表里,
  调手感直接改表,不要在场景里写 `if (difficulty === ...)`:

  | | 简单 | 普通 | 困难 | 地狱 |
  |---|---|---|---|---|
  | 普通词限时 | 25s | 16s | 12s | 9s |
  | 读条窗口 | (不触发) | 10s | 6.5s | 5s |
  | 打错扣血 | 3 | 5 | 10 | 20 |
  | 词库字数 | 1~3 字 | 1~6 字 | 3~7 字 | 3~7 字 |
  | 泰坦之怒 | 不触发 | 有 | 有 | 有(无冷却窗口) |
  | 组合输入 | 可选 | 可选 | 可选 | 强制逐字 |
  | 拼音提示 | 显示 | — | — | — |

  地狱与困难**刻意共用同一批词**:它的难度来自 9 秒限时 + 强制逐字,再叠字数
  只会变成折磨而非更高的技巧上限。限时与读条窗口现在是**两张独立的表**,
  不再由一个倍数互相锁死 —— 调一个不会连带改另一个。

  字数按 `typeText.length`(玩家实际要敲的字符数)筛,**不用 `WordEntry.difficulty`**
  ——那个字段只有 ≤3 / 4~6 / ≥7 三档,表达不了「3~7 字」这种跨档区间。
  词库自身的字数分布很不均匀(starter 里 2 字 704、3 字 63、4 字 779、5 字 15、
  7 字 548),所以困难档虽然写着 3~7 字,实际抽到的九成是 4 字和 7 字 ——
  这是词库的形状,不是筛选出了问题。

  ⚠ **打断词永远从没按难度筛过的完整池里取**(`pickShortInterruptWord`)。
  它要 ≤4 字,而困难/地狱掐掉了 2 字词,可选范围本就变窄;自定义分类下完全
  可能一个都不剩,那样泰坦之怒会**静默失效**、没有任何报错。定义在
  `packages/shared/src/battle.ts`(`DIFFICULTY_CAST_MULTIPLIER`)和
  `apps/web/src/battle/constants.ts`(`DIFFICULTY_SHOW_READING`/`DIFFICULTY_LABEL`,
  纯前端渲染表,不需要跨端同步)。
- 血量归零:单机直接秒结(defeat,没有复活);联机是团队共享血条归零直接
  判负结束战斗。都不再有旧版本那种"倒地 5 秒复活"的设计。

## 已知的坑(踩过的,别重踩)

1. **React 18 StrictMode 会把没写清理函数的非幂等 effect 多跑一次**
   (开发环境专属行为,用来揪 bug)。`SoloBattle.tsx`/`CoopBattle.tsx` 里
   "打错立刻上报"的 effect 因此加了基于 `typingState` 对象引用的去重
   (不能用 `currentWord.id` 去重,因为第一次调用已经把 currentWord 改到
   下一个词了,第二次调用读到的是新词的 id)。以后写监听某个状态变化就
   触发副作用的 effect,默认假设 StrictMode 下会跑两次。
2. **Vite 默认构建产物目录 `dist/assets/` 和游戏素材的 `/assets/` 静态路由
   撞名**,生产模式下 JS/CSS 会 404。已经在 `apps/web/vite.config.ts` 里用
   `build.assetsDir: 'app-assets'` 避开,不要删掉这个配置。
3. **Windows 上 Vite dev server 不显式设 `host` 有时只绑定 IPv6 的 `::1`**,
   浏览器把 `localhost` 解析成 IPv4 时会连不上。`vite.config.ts` 里已经设了
   `server.host: true`。
4. **`checkAttempt` 会核对 `submittedAt` 与服务端墙钟的偏差(±3s)**,写测试
   /脚本模拟 `WordAttempt` 时,时间戳必须用"相对战斗开始的真实经过毫秒数"
   (`Date.now() - startAt`),不能每次从 0 起算——`scripts/smoke-coop.ts`
   里有真实案例和详细注释。
5. **判定用 `typeText`,不是 `text`**。`judgeInput`/`targetOf` 已经处理好,
   直接调用,不要自己重新拼接判定文本。
6. **联机的词队列靠「两边消费次数逐次相等」维持,没有任何对账机制**。服务端
   不下发「当前该打哪个词」,只在 `word_attempt` 到达时核对 wordId;一旦某条
   分支上一边推进了、另一边没推进,游标就永久错开,之后所有提交都会走进
   `handleWordAttempt` 里「wordId 不匹配 → 直接 return」那条分支被静默丢弃 ——
   玩家打不出任何伤害,只会被普通词超时一路扣血到团灭,而且**没有任何报错**。
   客户端消费队列的时机只有三处(`CoopBattle.tsx`):进战斗取第一个词、打对
   普通词后乐观推进、收到 `word_advanced` 且 wordId 对得上时推进。**收到
   `cast_resolved` 时不推进。** 服务端任何改动都必须与这三条对齐。
   `scripts/smoke-coop.ts` 里那条 `wordsCompleted === normalSubmits` 断言就是
   为此存在的,它模拟了客户端的完整消费时机,别删。
   (历史上这里真出过事:服务端在「打对普通词 + 随机触发泰坦之怒」时跳过了
   `drawNext`,而客户端两处都推进,15% 概率一触发就永久错位。)

## 素材约定

`assets/` 全部可选,运行时用 `Image().onerror` 探测(`apps/web/src/engine/assets.ts`),
缺失就走 CSS/文字降级,不构建期 glob。**多皮肤约定**:1 号沿用原文件名
(`p1.png`/`rabbit.png`),2 号及以后加数字后缀(`p1-2.png`、`rabbit-3.png`……),
最多探测到 6 号(`MAX_SKIN_INDEX`)。主菜单的 `SkinPicker` 探测到 ≤1 套时不
显示选择器。玩家选择存 `localStorage`(`apps/web/src/engine/skinPrefs.ts`),
纯本地偏好,不进战斗协议、不跨端同步。

当前已放入:`avatar/p1.png`、`avatar/p2.png`、`effects/rabbit.png`、
`effects/rabbit-2.png`、`boss/titan.png`。版权说明见 `assets/CREDITS.md`——
**放新素材前一定要先跟提出需求的人确认版权/授权状态,尤其是看起来像专业
渲染/商业美术质感的图,不要自己判断"看着没事就能用"。**

`data/wordbanks/` 只读,`items.json` 11MB,**禁止整体读取**,只能
`head -c 500` 或 `jq '.entries[0:3]'`。

## 依赖白名单

```
根:     typescript, vitest, tsx, @types/node, ws, @types/ws
web:    react, react-dom, vite, @vitejs/plugin-react
server: fastify, @fastify/static, ws, nanoid
```

禁止:UI 组件库、状态管理库、动画库(小人动画用原生 Web Animations API 的
`el.animate()`,不切 class)、音频库(音效全部 Web Audio 实时合成)、
拼音库、ORM、游戏引擎。

## 常用命令

```bash
pnpm install
pnpm test                              # 50 单测 + smoke-coop,提交前必须全绿
pnpm typecheck                         # 根 tsconfig.base.json,只覆盖 packages/shared
pnpm --filter @eorzea/web exec tsc -p tsconfig.json --noEmit   # 前端单独类型检查
pnpm --filter @eorzea/server exec tsc -p tsconfig.json --noEmit # 服务端单独类型检查

pnpm --filter @eorzea/server dev       # 开发态服务端,默认 :8799
pnpm --filter @eorzea/web dev          # 开发态前端,默认 :5173,代理到 8799

pnpm build                             # = pnpm --filter @eorzea/web build,产出 apps/web/dist
pnpm start                             # = pnpm --filter @eorzea/server start,单进程同时托管前端产物+词库+素材+WS
```

`pnpm start` 之前必须先 `pnpm build` 过一次(否则没有 `apps/web/dist`,
服务端会退回到"找不到就 404",除非你是要接 `apps/web` 自己的 dev server)。

## 卡住时

- 缺素材 → 走降级路径,继续推进,这是设计好的。
- IME 异常 → 先看 `packages/shared/tests/typing.test.ts` 是否绿。绿的话
  问题在组件接线,**不要改 `typingReducer.ts`**。
- 小人连打不重播 → 检查是不是又切 class 了,得用 `el.animate()`。
- 无声 → 确认某个用户手势(点击/按键)里同步调用了 `audio.unlock()`。
- 联机测试卡住不动 → 大概率是 `checkAttempt` 的 clock_skew 拦截,检查
  `WordAttempt.startedAt/submittedAt` 是不是用了真实经过时间。
- 歧义 → 选实现更简单的方案,commit message 里写清楚为什么,别猜。

## 完成后

输出报告:实际耗时、取舍、已知缺陷、后续 TODO,以及哪些素材位置处于降级状态。
