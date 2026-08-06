# 部署与运维

线上是**有真实玩家在用**的服务，动手之前先读这一页。

> ⚠ **这个文件会被推到公开仓库,里面绝不能出现任何密码、密钥或凭证明文。**
> 需要具体的值时,去服务器上 `docker inspect eorzea` 看环境变量。

---

## 线上环境

| | |
|---|---|
| 服务器 | 阿里云**轻量应用服务器**(不是 ECS —— 防火墙配置位置不同) |
| 地域 | 华东2(上海),2 vCPU / 2 GiB / 40 GiB |
| 公网 | `47.103.120.8` |
| 游戏地址 | `http://47.103.120.8:8799` |
| 管理后台 | `http://47.103.120.8:8799/#admin`(菜单里没有入口,只能手敲) |
| 系统 | Alibaba Cloud Linux 8,Docker 26.1.3,时区 CST |
| SSH | `ssh -i ~/.ssh/打字.pem root@47.103.120.8` |

**端口**:只开了 22 和 8799。轻量服务器的防火墙在
「实例详情 → 防火墙 → 添加规则」,**不是 ECS 那个「安全组」**。
系统内的 firewalld 没装、iptables 全通,所以只有阿里云那一道。

⚠ **8799 这个非标端口是刻意的**:华东2 是大陆地域,未备案实例的 80/443
会被阿里云直接阻断,非标端口不受影响。想上域名或 80 端口就得备案,
或者把机器换到香港/新加坡地域。

---

## 目录与挂载

宿主机上有三处状态,**都在容器之外**,重新部署不会丢:

```
/root/eorzea-data/      SQLite 数据库      → 容器 /data       (读写)
/root/game-audio/       BGM(7 首 mp3)     → 容器 /app/assets/audio (只读)
/root/eorzea-backups/   每日备份 + 日志
```

代码本身在 `/root/eorzea/`,每次部署整个覆盖 —— 不要往那儿放任何要留存的东西。

---

## 部署一次新版本

在**本机仓库目录**执行:

```bash
# 1. 本地必须先全绿
pnpm test

# 2. 打包(排除音频、依赖、构建产物、密钥、本地数据库)
tar --exclude='node_modules' --exclude='.git' --exclude='assets/audio/*.mp3' \
    --exclude='apps/web/dist' --exclude='*.pem' --exclude='.data' \
    -czf /tmp/eorzea.tar.gz .
```

上传并重建(PowerShell,注意 scp 的路径):

```powershell
$key = "$env:USERPROFILE\.ssh\打字.pem"
scp -i $key "$env:TEMP\eorzea.tar.gz" root@47.103.120.8:/root/eorzea.tar.gz
```

然后 SSH 上去:

```bash
rm -rf /root/eorzea && mkdir -p /root/eorzea
tar -xzf /root/eorzea.tar.gz -C /root/eorzea
cd /root/eorzea && docker build -t eorzea-typing .
docker rm -f eorzea
docker run -d --name eorzea --restart unless-stopped \
  -p 8799:8080 -e PORT=8080 -e EORZEA_DATA_DIR=/data \
  -e EORZEA_ADMIN_USER=... -e EORZEA_ADMIN_PASSWORD=... -e EORZEA_ADMIN_SECOND_PASSWORD=... \
  -v /root/game-audio:/app/assets/audio:ro \
  -v /root/eorzea-data:/data \
  eorzea-typing
```

⚠ **`docker rm -f` 千万别加 `-v`** —— 那会把数据卷一起删掉。

⚠ **三个 `EORZEA_ADMIN_*` 环境变量必须带上**,漏了管理后台会整个 404
(这是刻意的:配不全就关闭,而不是退化成无密码可进)。当前值从旧容器捞:
`docker inspect eorzea --format '{{json .Config.Env}}'`。

部署后自查:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8799/healthz          # 200
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8799/api/admin/players # 401(不是 404)
docker logs eorzea | tail -5   # 应看到「管理后台已启用」和 SQLite 就绪
```

---

## 换 BGM

音频是挂载卷,**不进镜像也不进 git**(体积 + 授权原因)。

```bash
scp -i ~/.ssh/打字.pem "某首歌.mp3" root@47.103.120.8:/root/game-audio/
```

- **加/删单个文件** → 立刻生效,服务端每次请求都重扫目录
- **整个目录搬走换新的** → 必须 `docker restart eorzea`。
  bind mount 绑的是 inode,`mv` 掉目录之后容器看到的还是旧的那批

建议控制在 **128 kbps** 左右。服务器带宽实测约 690 KB/s,一首 16 MB 的高码率
mp3 要下 20 多秒,前端等的是 `canplaythrough`,玩家会觉得"没有音乐"。
转码(服务器上跑,不用来回传):

```bash
docker run --rm -v /root/game-audio:/in:ro -v /root/out:/out mwader/static-ffmpeg \
  -i "/in/歌.mp3" -c:a libmp3lame -b:a 128k "/out/歌.mp3"
```

⚠ 这个镜像**只有 ffmpeg 没有 ffprobe**。用 ffprobe 做校验会静默返回空值,
看起来"全部通过"其实什么都没查。要验证转码结果就完整解码一遍:
`ffmpeg -v error -i 文件 -f null -`,无输出即健康。

---

## 备份

`crontab` 里每天 **04:00** 跑 `/root/eorzea-backup.sh`。

- 日备份保留 **14 天**,每月 1 号另存一份到 `monthly/` 长期保留
- 日志:`/root/eorzea-backups/backup.log`

⚠ **备份绝不能用 `cp` 复制数据库文件**。库开了 WAL,新写入先落在 `-wal`,
主库文件可能长期几乎是空的(实测主库 4 KB / WAL 1.1 MB)。脚本走的是容器里的
`VACUUM INTO`,产出一个自洽的单文件副本,并且**当场校验**:账号数与成绩数
要和主库一致、`integrity_check` 要通过,任何一项不过就记失败。

### 恢复

```bash
docker stop eorzea
gunzip -c /root/eorzea-backups/eorzea-YYYY-MM-DD_HHMM.db.gz > /root/eorzea-data/eorzea.db
rm -f /root/eorzea-data/eorzea.db-wal /root/eorzea-data/eorzea.db-shm   # 别漏这行
docker start eorzea
```

删 `-wal` / `-shm` 是必须的:留着旧 WAL 会和恢复出来的主库对不上。

---

## 管理后台

`http://47.103.120.8:8799/#admin`。用户名 + 密码 + 二次口令三样都对才进得去。

能做:

- **玩家忘记登录密码** —— 让他把 root 密码发来,在后台核对,**核对通过才会出现
  重置按钮**,重置出一个新密码给他
- 搜索账号、封禁/解封
- 看每条成绩的可信度与命中的检测项,一键下榜/恢复(只隐藏不删,可还原)

⚠ **原密码谁也查不出来,包括管理员**。两套凭证都是加盐 scrypt 哈希入库,
所以流程只能是「核对身份 → 重置」。重置登录密码**不会动 root 密码**,
玩家下次再忘还能用同一个凭证来找你。

二次因子当前是**静态口令**(简单)。它的弱点是不随时间变化,两串密码一起泄露
就等于没有第二道。代码同时支持 TOTP —— 配上 `EORZEA_ADMIN_TOTP_SECRET`
就自动切到动态码,不用改代码。首次配置时服务端启动日志里会打印绑定用的
otpauth 链接。

---

## 排查

```bash
docker logs eorzea --tail 50           # 服务端日志
docker stats eorzea --no-stream        # 内存占用(正常一百多 MB)
df -h /                                 # 磁盘
docker exec eorzea node /tmp/backup-db.js   # 数据库健康自检(顺带生成快照)
```

**玩家说打不开** → 先确认是不是漏了 `:8799`。八成是这个。

**联机进不去/词打了不算** → 看服务端日志有没有异常;真出问题优先怀疑
「客户端与服务端词队列错位」,那类 bug 的表现就是**打对了也不计分、只被超时
扣血,而且没有任何报错**。`scripts/smoke-coop.ts` 里那条
`wordsCompleted === normalSubmits` 断言就是防它的,别删。

**成绩传不上去** → 服务端会返回具体原因(`score_overclaim` / `word_not_in_sequence`
/ `not_cleared` / `unranked_difficulty`),结算页会翻译成人话显示给玩家。
