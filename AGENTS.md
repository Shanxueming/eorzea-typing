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

**47 个单测 + `scripts/smoke-coop.ts` 联机冒烟测试必须全绿。**
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
- **打错一个字就立刻算失败**,不等玩家退格重试或按 Enter——`TypingField`
  的 `status` 变成 `'error'` 的瞬间,战斗场景就会自动上报失败(见下面的
  StrictMode 坑)。
- 普通词也**限时**:时限是这局读条时长(按难度换算过)的 2.5 倍
  (`NORMAL_WORD_TIMEOUT_MULTIPLIER`),超时按失败处理。联机由服务端用
  定时器强制执行,客户端本地也跑一份同样的计时器保持体验一致。
- Boss 每 8–15 秒读一次条,读条前 1 秒预警,预警结束后进入可打断窗口
  (`castDurationMs = CAST_DURATION_MS × 难度倍数`)。打断成功用
  `computeDamage(word.difficulty, combo, true)`,并回血
  `PLAYER_HEAL_ON_INTERRUPT`;窗口内没人打断算团队躲避失败,扣
  `PLAYER_DAMAGE_ON_FAIL`。
- 三档难度只影响读条/普通词限时的倍数和是否显示拼音提示,不影响词库内容,
  定义在 `packages/shared/src/battle.ts`(`DIFFICULTY_CAST_MULTIPLIER`)和
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
pnpm test                              # 47 单测 + smoke-coop,提交前必须全绿
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
