# 素材署名

四种音效(打对/打错/打断成功/受伤)全部由 `apps/web/src/engine/audio.ts` 用
Web Audio API 实时合成,不依赖任何音频文件,不需要在这里署名。

## 已放入的素材

- `assets/avatar/p1.png`、`assets/avatar/p2.png`(玩家/对手小人)、
  `assets/effects/rabbit.png`、`rabbit-2.png`(打错时弹出的兔子,两套风格):
  项目负责人提供的自制插画,非 game-icons.net 等第三方授权素材,来源与版权
  由提供者自行确认。
- `assets/boss/titan.png`(泰坦剪影):项目负责人确认为其本人有权使用的素材
  (委托创作/已购买授权等),来源与版权同样由提供者自行确认。抠掉了原图的
  白色背景,没有做其他修改。
## 背景音乐:不进版本控制、不参与部署下发

`assets/audio/` 已在 `.gitignore` 与 `.dockerignore` 中排除(只保留 `.gitkeep`
与该目录的 `README.md`)。原因有二:音频体积远大于全部代码,且每个人放进去的
曲目授权状态各不相同,不适合随仓库一起分发。

因此**线上部署没有 BGM**——`/api/audio-playlist` 返回空列表,前端走既有降级
路径静默不播,不影响开局、打断与通关。想听 BGM 的人自行把已获授权的音频放进
本地 `assets/audio/`,刷新页面即生效。

放入前请自行确认版权/授权状态;游戏本体的四种音效由 Web Audio 实时合成,
不依赖任何音频文件,不受此影响。

## 后续如果放入其余素材,按许可要求在这里追加条目

- 若用 [game-icons.net](https://game-icons.net) 的 CC BY 3.0 图标,必须在此
  列出图标名、原作者与链接,例如:

  > 「XXX」图标 by 某某作者(game-icons.net),CC BY 3.0,<链接>
