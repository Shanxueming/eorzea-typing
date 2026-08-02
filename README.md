# eorzea-typing

FF14 主题网页打字游戏。全 DOM + CSS,不用游戏引擎;判分/随机/词库/反作弊/IME 输入状态机
全部在 `packages/shared`,单机与联机、客户端与服务端共用同一份实现。

> 想快速了解现状、接手后续开发?看 [`AGENTS.md`](AGENTS.md)——写给 AI 协作者的
> 项目导览,`CODEX_PLAN.md` 是开工前的原始规格,已经过时,只作历史参考。

## 拿到打包 zip 怎么跑起来

这个包里 `apps/web/dist` 已经是构建好的产物,不需要跑 `pnpm build`,只要:

```bash
pnpm install     # 装依赖,包含运行时需要的 tsx(服务端直接跑 TS,不编译成 JS)
pnpm start       # 单进程同时托管前端产物 + 词库 + 素材 + WebSocket,默认 :8799
```

浏览器打开 <http://localhost:8799>。如果改过 `apps/web/src` 下的代码,要重新
`pnpm build` 一次再 `pnpm start`,否则看到的还是打包时的旧版本。

## 本地开发

```bash
pnpm install
pnpm test          # 47 个单测 + scripts/smoke-coop.ts 的联机冒烟测试
```

起两个开发进程(各自独立热重载):

```bash
pnpm --filter @eorzea/server dev   # Fastify + WebSocket,默认 :8799
pnpm --filter @eorzea/web dev      # Vite,默认 :5173,代理 /wordbanks /assets /ws 到 8799
```

浏览器打开 <http://localhost:5173>。

## 项目结构

```
packages/shared/       判分、随机、词库筛选、反作弊、IME 状态机(只读,见 AGENTS.md)
apps/web/               React + Vite 前端:场景、组件、WebSocket 客户端
apps/server/             Fastify 服务端:静态资源托管 + 房间状态机
data/wordbanks/          96,828 条国服专有名词词库(只读)
assets/                  素材目录,全部可选,缺失时自动降级(见 assets/README.md)
scripts/smoke-coop.ts    联机冒烟测试,起临时服务端实例跑两个真实 WS 客户端
```

## 部署

单进程部署:一个 Node 进程同时托管前端静态产物、词库/素材静态文件与 WebSocket。

```bash
docker build -t eorzea-typing .
docker run -p 8080:8080 eorzea-typing
```

目标 Railway 或 Fly.io,两者都能直接识别根目录的 `Dockerfile`:

- **Railway**:新建项目 → 关联本仓库 → 不需要额外配置,Railway 会自动注入 `PORT`
  环境变量并被 `apps/server/src/app.ts` 读取。
- **Fly.io**:`fly launch` 生成 `fly.toml` 时选择已有 Dockerfile,把
  `internal_port` 设成 `8080`(或 Dockerfile 里 `ENV PORT` 的值)。

线上只有一个公开端口,`/wordbanks/*`、`/assets/*`、`/ws` 与前端页面全部走这一个端口。

## 移动端

不适配移动端,建议使用桌面浏览器——窄屏会显示提示遮罩,不会尝试渲染出一个挤坏的界面。

## 词库

见 [`data/wordbanks/README.md`](data/wordbanks/README.md)。总计 96,828 条,21 个分类,
外加 2,156 条的精选起步包(`starter.json`,单机「快速开始」直接用它)。

## 素材

见 [`assets/README.md`](assets/README.md) 与 [`assets/CREDITS.md`](assets/CREDITS.md)。
当前仓库里 `assets/` 是空的,游戏走完全降级路径也能正常开局、打完、结算。
# 启动游戏

Windows 下可直接双击根目录的 [`启动艾欧泽亚打字游戏.cmd`](启动艾欧泽亚打字游戏.cmd)。它会自动检查依赖、构建页面、启动本地服务，并打开 `http://localhost:8799/`；首次启动需要安装 Node.js LTS，且依赖安装可能需要网络。
