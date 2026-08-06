# 单阶段部署:一个 Node 进程同时托管静态资源(web 构建产物 + 词库 + 素材)
# 与 WebSocket 房间服务器。目标 Railway / Fly.io。
# Node 24:内置的 node:sqlite 在这个版本不需要 --experimental-sqlite,
# 账号与排行榜因此不必引第三方数据库驱动(依赖白名单里也没有)。
FROM node:24-alpine

WORKDIR /app

RUN npm install -g pnpm@9

# 先只拷贝依赖清单,让 pnpm install 这层能被 Docker 缓存,改业务代码不用重装依赖
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/server/package.json apps/server/package.json

RUN pnpm install --frozen-lockfile

COPY . .

# apps/server 用 tsx 直接运行 TypeScript,不需要单独编译;
# apps/web 需要 vite build 出静态产物,由 apps/server 托管。
RUN pnpm --filter @eorzea/web build

ENV NODE_ENV=production
ENV PORT=8080
# 数据库落在这个目录,部署时用 bind mount 挂到宿主机,重新部署不会丢数据
ENV EORZEA_DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8080

CMD ["pnpm", "--filter", "@eorzea/server", "start"]
