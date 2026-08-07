# Liyuan Agent 1.2.1

## 本版要点

**修复 Docker Compose 首次启动失败**（[issue #1](https://github.com/weidu12123/Liyuan/issues/1)，感谢 @nuurayho 的详细报告与定位）。

v1.2.0 及更早版本把 `liyuan.config.json` / `liyuan.agent.json` 做了文件级挂载。宿主机上还没有这两个文件时，Docker 会建两个**空目录**顶上去，撞上镜像里的同名文件，容器直接崩：

```
Are you trying to mount a directory onto a file (or vice-versa)?
```

按 README 走 `git clone` + `docker compose up -d --build` 的人必然撞上。现在改成只挂 `data/config` 目录，容器首启时自己从示例配置播种，**不需要任何手工准备**。

已经踩上的用户升级后直接起即可，不用手工删任何东西——启动脚本会认出那两个误建的空目录，清掉并重新播种。若你之前按旧文档手工填过 `data/config/liyuan.agent.json`（是文件不是目录），它会被原样保留，Key 不丢。

## 安装包

| 平台 | 文件 |
|------|------|
| Windows | `Liyuan-1.2.1-windows.zip` |
| Linux | `Liyuan-1.2.1-linux.zip` |
| macOS | `Liyuan-1.2.1-macos.zip` |
| 校验 | `SHA256SUMS.txt` |

| **Docker** | 见仓库 `docker-compose.yml` | `docker compose up -d --build` |

> 装了 v1.1.x / v1.2.0 的用户，主页会出现「新版本 v1.2.1」提示，点开即可一键升级。
>
> 只用 `start.bat` / `start.sh` 本地启动、不碰 Docker 的用户，本版没有功能变化，可以不升。

## 快速开始

见各包内 `RELEASE.txt` / `start.bat` · `start.sh` · `start.command`。需要 Node.js **≥ 22**。

## 说明

- 不含个人 API Key、私有角色卡或运行时会话数据。
- 许可证：PolyForm Noncommercial 1.0.0（个人/非商业）。
