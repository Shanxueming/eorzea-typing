# FF14 打字游戏 — 开发计划 v4（Sonnet 5 · 中档专用）

> **本版与 v3 的根本区别:全项目最难的 20% 代码已经写好并通过测试。**
>
> `packages/shared/` 下的六个模块与 47 个单元测试是现成的、可运行的。
> 你不需要设计判分算法、不需要研究 IME 合成态、不需要发明反作弊统计规则。
> 你的任务是**在已验证的地基上搭 UI 与服务端**。
>
> 预计工时因此从 12.0h 降到 **8.0h**。

---

## 0. 开工第一件事

```bash
pnpm install
pnpm test
```

**47 个测试必须全绿。** 这是你的起点,不是终点。任何时候测试变红,先修复再继续。

---

## 1. 已经写好的东西（不要重写）

| 文件 | 职责 | 状态 |
|---|---|---|
| `packages/shared/src/types.ts` | 全部数据结构 | ✅ 完成 |
| `packages/shared/src/rng.ts` | seed 驱动的可复现随机数 | ✅ 完成,6 测试 |
| `packages/shared/src/scoring.ts` | 判分、伤害、连击、统计 | ✅ 完成,10 测试 |
| `packages/shared/src/anticheat.ts` | 两层作弊检测 | ✅ 完成,13 测试 |
| `packages/shared/src/typingReducer.ts` | IME 安全的输入状态机 | ✅ 完成,11 测试 |
| `packages/shared/src/wordbank.ts` | 词库加载与筛选 | ✅ 完成,7 测试 |
| `apps/web/src/engine/useTypingInput.ts` | React hook,包装上面的 reducer | ✅ 完成 |
| `apps/web/src/engine/audio.ts` | Web Audio 音效合成 + BGM | ✅ 完成 |

**规则:这八个文件默认只读。** 如果你认为必须改动其中之一,先在 commit message 里说明理由,并确保 47 个测试仍然全绿。

**你要写的是**:React 组件、场景、WebSocket 服务端、CSS、Dockerfile。这些是常规工作,不涉及算法设计。

---

## 2. 已有 API 速查

开工前扫一遍,不要重新发明这些函数。

```ts
import {
  // 判定 —— 比对的是 typeText,不是 text
  judgeInput,        // (entry, input, mode) => { status, matchedLength, target }
                     //   status: 'empty' | 'progress' | 'error' | 'complete'
  targetOf,          // (entry, mode) => string
  computeDamage,     // (difficulty, combo, isInterrupt?) => number
  comboMultiplier,   // (combo) => number,封顶 3
  computeStats,      // (attempts, elapsedMs, mode?, targets?) => SessionStats
  computeScore,      // (damage, interrupts, accuracy) => number

  // 随机 —— 服务端与客户端用同 seed 得到同序列
  createRng,           // (seed) => { next, int, pick, range }
  generateWordSequence, // (pool, count, seed) => T[]

  // 词库
  selectPool,        // (banks, { categories, pureOnly, difficulties? }) => WordEntry[]
  buildSequence,     // (pool, count, seed) => WordEntry[]
  pickInterruptWord, // (pool, seed) => WordEntry | null
  randomCategories,  // (available, seed) => WordCategory[]  联机随机选分类
  HEAVY_CATEGORIES,  // ['items'] —— 禁止静态引入的分类

  // 反作弊
  checkAttempt,      // (attempt, expected, serverElapsedMs) => { ok, flags }
  analyzeSession,    // (attempts, elapsedMs) => { trustScore, flags, metrics, verdict }
  THRESHOLDS,        // 全部阈值,可热调

  // IME 状态机(hook 已封装,一般不用直接调)
  typingReducer, initialTypingState,
} from '@eorzea/shared';
```

`useTypingInput` 的用法:

```tsx
const { state, inputProps } = useTypingInput({
  entry: currentWord,          // WordEntry | null
  mode: 'hanzi',               // 或 'pinyin'
  now: () => performance.now() - battleStartRef.current,
  onComplete: (payload) => {   // 一个词打完时触发,payload 含完整遥测
    // payload: { submitted, keystrokes, backspaces, compositionCommits,
    //            focusLostMs, startedAt, submittedAt }
  },
  disabled: isDown,
});

// state.status        当前判定状态,用于着色
// state.matchedLength 已匹配的字符数,用于高亮前缀
<input {...inputProps} />
```

`audio` 的用法:

```ts
import { audio } from './engine/audio';

audio.unlock();            // ★ 必须在首次点击/按键时调用,否则全程无声
audio.play('hit');         // 'hit' | 'miss' | 'interrupt' | 'hurt'
await audio.loadBgm();     // 文件缺失时静默降级,不会抛错
audio.startBgm();
audio.setMuted(true);
```

---

## 3. 硬性约束

| 约束 | 说明 |
|---|---|
| **不用游戏引擎** | 禁止 Phaser / PixiJS / Three.js。全部 DOM + CSS。 |
| **不做账号系统** | 联机身份 = 昵称 + 房间码。 |
| **联机固定 2 人** | 第 3 人加入返回 `error`。不要写通用的 N 人逻辑。 |
| **单进程部署** | 一个 Node 进程同时托管静态资源与 WebSocket。 |
| **素材可缺失** | `assets/` 全部可选,缺失时降级到 CSS / Web Audio。见 §6。 |
| **不联网下载** | 不下载素材、不抓取词库。 |
| **服务端权威** | 客户端分数仅供显示,最终以服务端重算为准。 |
| **词库只读** | `data/wordbanks/` 禁止修改。 |
| **★ 禁止整体读取大文件** | `items.json` 有 11 MB,`quests.json` 1.1 MB。查看内容只允许 `head -c 500` 或 `jq '.entries[0:3]'`,**禁止 cat 整个文件**,会瞬间烧掉大量上下文。 |

### 依赖白名单

```
根:     typescript, vitest, tsx, @types/node   (已装)
web:    react, react-dom, vite, @vitejs/plugin-react
server: fastify, @fastify/static, ws, nanoid
```

禁止:UI 组件库、状态管理库、动画库、音频库、拼音库、ORM。

---

## 4. 组件契约

按下面的 props 实现,不要自行改签名 —— 这样各组件能并行开发且不会对不上。

```tsx
// components/BossPanel.tsx
interface BossPanelProps {
  name: string;              // 如 "泰坦"
  hp: number; maxHp: number;
  cast: { skillName: string; word: WordEntry; startedAt: number; castMs: number } | null;
  /** 读条被打断时播碎裂动画 */
  shattered: boolean;
}

// components/TypingField.tsx
interface TypingFieldProps {
  entry: WordEntry | null;
  status: JudgeStatus;
  matchedLength: number;
  mode: TypingMode;
  inputProps: React.InputHTMLAttributes<HTMLInputElement> & { ref: React.Ref<HTMLInputElement> };
  /** 是否为打断词,是则红色高亮 */
  isInterrupt: boolean;
}

// components/Avatar.tsx
interface AvatarProps {
  state: AvatarState;        // 'idle' | 'attack' | 'miss'
  nick: string;
  isSelf: boolean;
  /** 'p1' | 'p2',决定读哪张图与降级配色 */
  slot: 'p1' | 'p2';
}

// components/PartyList.tsx
interface PartyListProps {
  players: { playerId: string; nick: string; score: number; isSelf: boolean }[];
  remainingMs: number;
}

// components/HpBar.tsx
interface HpBarProps { value: number; max: number; variant: 'boss' | 'player'; }
```

---

## 5. 里程碑

> 总计 8.0 小时。**每个里程碑结束就 commit,并开一个新会话继续**——
> 单会话从头做到尾会让上下文膨胀到后期每轮都在重读整个项目,消耗翻数倍。

### M0 · 补全脚手架（0.5h）

根配置、`packages/shared`、`vitest.config.ts` 已经就位。你要加的是:

- `apps/web/`:Vite + React 项目,`package.json`、`vite.config.ts`、`index.html`、`src/main.tsx`
- `apps/server/`:Fastify 项目骨架,`package.json`、`src/index.ts`(先只托管静态资源)
- 配好 workspace 依赖,使 `apps/web` 能 `import from '@eorzea/shared'`

**验收**:`pnpm test` 仍是 47 绿;`pnpm --filter web dev` 能打开空白页;`apps/web` 里能成功 import `judgeInput` 并打印结果。

### M1 · 已完成 ✅（0h）

判分、随机、词库、反作弊、IME 状态机全部写好并测试通过。跳过。

### M2 · 单机 Boss 战（2.5h）

**产出**:`MainMenu` + `SoloBattle` + `Results` 三个场景,以及 §4 的五个组件。

战斗循环:
1. 中央出现随机词,打对则 `computeDamage(difficulty, combo)` 扣 Boss 血、连击 +1;打错连击清零。
2. 每 8–15 秒 Boss 读条,附一个 `pickInterruptWord` 取出的难度 3 打断词。读条结束前打完则打断成功(额外伤害 + 碎裂动画),否则玩家 HP −25、连击清零、屏幕红闪。
3. Boss HP 归零或 120 秒耗尽 → 结算页。

主菜单需要:分类多选(用词库文件里的 `label` 字段做显示名,不要另写一份)、模式切换(汉字 / 拼音)、「快速开始」直接用 `starter.json`。

**验收**:
- [ ] 用中文输入法打字,选字过程中输入框不变红
- [ ] `扇舞·序` 显示带中点,打 `扇舞序` 通过
- [ ] 读条超时扣血且连击清零
- [ ] Boss HP 归零进结算页
- [ ] `pnpm test` 仍 47 绿

### M3 · 双人联机（2.5h）

**产出**:`apps/server` 的房间状态机 + `Lobby` + `CoopBattle` 场景。

协议(照抄,不要改字段名):

```ts
type C2S =
  | { t: 'create_room'; nick: string }
  | { t: 'join_room'; code: string; nick: string }
  | { t: 'ready' }
  | { t: 'word_attempt'; attempt: WordAttempt }
  | { t: 'heartbeat'; clientTime: number };

type S2C =
  | { t: 'room_joined'; code: string; playerId: string; players: PlayerPublic[] }
  | { t: 'room_update'; players: PlayerPublic[] }
  | { t: 'battle_start'; config: BattleConfig; startAt: number }
  | { t: 'boss_cast'; castId: string; skillName: string; word: WordEntry; castMs: number }
  | { t: 'cast_resolved'; castId: string; interruptedBy: string | null }
  | { t: 'score_tick'; scores: PlayerTick[]; bossHp: number }
  | { t: 'player_down'; playerId: string; reviveAt: number }
  | { t: 'battle_end'; results: PlayerResult[] }
  | { t: 'error'; msg: string };

interface PlayerTick {
  playerId: string; score: number; damage: number;
  wordsCompleted: number; misses: number;   // ★ 用于驱动对手小人动画
}
```

要点:
- 房间码 6 位大写,`nanoid` 生成。容量固定 2。
- `battle_start` **只下发 seed 与 categories**,双方各自 `buildSequence(pool, n, seed)` 本地生成同一词序。
- `score_tick` 固定 **4 Hz**(250ms),不要每次打词都广播。
- Boss HP 全队共享;打断只要任一方成功即算全队打断,但成功者独享奖励分。
- 断线 5 秒宽限后判出局。

**验收**:`scripts/smoke-coop.ts` 用两个 Node WS 客户端跑完整局,断言:两端 seed 相同、第 3 个客户端被拒、Boss HP 单调递减、`battle_end` 的 results 长度为 2 且排名正确。纳入 `pnpm test`。

### M4 · 反作弊接入（0.5h）

算法已经写好且测试通过,**你只需要接线**:

1. 服务端收到 `word_attempt` 时调 `checkAttempt(attempt, expected, serverElapsedMs)`,`ok === false` 则该次计 0 分并记录 flags。
2. 局末调 `analyzeSession(attempts, elapsedMs)`,把 `trustScore`、`flags`、`verdict` 写进 `PlayerResult`。
3. 结算页展示:`verified` 正常显示,`unverified` 加灰色「未验证」徽章,`rejected` 显示成绩但标注不计入排名,并列出命中的 flags。

**验收**:结算页能正确展示三种 verdict;`pnpm test` 仍全绿。

### M5 · 小人 + 音效 + 部署（2.0h）

**产出**:

1. **`engine/assets.ts`** —— 素材探测与降级,见 §6。
2. **`Avatar` 组件**:
   - `idle`:上下浮动 `translateY(0 → -3px → 0)`,2.4s 循环
   - `attack`:`scale(1) → scale(1.35) + translateY(-14px) → scale(0.95) → scale(1)`,360ms
   - `miss`:左右摇晃 `rotate(-6deg ↔ 6deg)`,同时头顶弹出兔子(从上方 20px 淡入下落、停留 600ms、淡出上移)
   - **★ 连打时动画必须能重播**:用 Web Animations API 的 `el.animate(...)`,每次调用都是新动画。不要用切 class 的方式,那需要 reflow hack 且容易漏。
   - 联机时两个小人并排,自己在左带描边。**对手的动画由 `score_tick` 的 diff 驱动**:`wordsCompleted` 增加播 attack,`misses` 增加播 miss。一个 tick 内只播一次,不要排队。
3. **音效接线**:`audio.unlock()` 挂在首次交互;打对 `hit`、打错 `miss`、打断成功 `interrupt`、受伤 `hurt`;静音开关同时控制音效与 BGM。
4. **`assets/CREDITS.md`**:素材署名表。用了 game-icons.net 的图标必须按 CC BY 3.0 署名作者与链接。
5. **视觉**:`tokens.css` 配色 —— 深蓝黑 `#0B1020`、水晶青 `#7FD8E8`、危险红 `#E85A5A`。三个 CSS 动画:读条碎裂、伤害红闪、连击跳字。
6. **部署**:`Dockerfile`(单阶段 node:22-alpine),目标 Railway 或 Fly.io。README 含启动与部署命令。
7. 移动端不适配,加一句「建议使用桌面浏览器」。

**验收**:
- [ ] `assets/` **完全为空**时,游戏能正常开局、打完、结算,控制台无报错、无裂图
- [ ] 打对小人放大跳动后回原形;快速连打时动画正确重播
- [ ] 打错小人摇晃且头顶弹出兔子,约 600ms 后消失
- [ ] 联机时两个小人都在,对手打对/打错有反应
- [ ] 静音开关同时关掉音效与 BGM
- [ ] 线上 URL 可访问,两台设备能通过房间码进同一局

---

## 6. 素材降级表

`assets/` 下所有文件都是可选的,由人工后续放入。**缺失时必须自动降级,不得报错或裂图。**

| 素材 | 路径 | 缺失时 |
|---|---|---|
| 玩家小人 | `assets/avatar/p1.png` | 56px CSS 圆角方块,填充 `#7FD8E8`,内含昵称首字 |
| 对手小人 | `assets/avatar/p2.png` | 同上,填充改灰 |
| 兔子 | `assets/effects/rabbit.png` | CSS 气泡内含「?」 |
| Boss 剪影 | `assets/boss/titan.svg` | 不显示图形,只显示 Boss 名 |
| BGM | `assets/audio/bgm.mp3` | 不播放,静音按钮仍显示 |

探测方式:图片用 `new Image()` 的 `onerror`;BGM 已由 `audio.loadBgm()` 处理好。
**不要用构建期 glob**,素材是运行时放入的。

**音效不需要素材**,四种全部由 `audio.ts` 实时合成。

---

## 7. 卡住时怎么办

| 情况 | 做法 |
|---|---|
| 缺素材 | 走降级路径,继续推进。这是设计好的,不是问题。 |
| IME 判定异常 | 先跑 `pnpm test` 看 `typing.test.ts` 是否绿。绿的话问题在组件接线,不在 reducer。**不要改 reducer**。 |
| 小人连打不重播 | 用 `el.animate()`,不要切 class。 |
| 无声 | 确认首次交互调了 `audio.unlock()`。仍无声就静音处理,不阻塞。 |
| WS 状态机超时 | 砍掉断线重连,断线即出局。省 30 分钟。 |
| 想看词库内容 | `head -c 500 data/wordbanks/starter.json` 或 `jq '.entries[0:3]'`。**禁止 cat 整个文件**。 |
| 工时不够 | 优先级:M2(单机可玩)> M3(联机)> M5 的小人与音效 > M5 其余。反作弊已经写好,接线只要半小时,不用砍。 |

---

## 8. 词库速查

完整说明见 `data/wordbanks/README.md`。

| 事实 | 值 |
|---|---|
| 总条目 | 96,828,21 个分类 |
| 默认词库 | `starter.json`,2,156 条,已筛好 |
| 最大文件 | `items.json` 11 MB,**禁止静态引入、禁止整体读取** |
| 判定字段 | `typeText`(不是 `text`) |
| 筛选规则 | `pureOnly` 与 characters 的 `named` 已由 `selectPool` 处理,直接用即可 |
| 来源 | 国服客户端解包,无幻觉,版本落后国际服约 1–2 个资料片 |
