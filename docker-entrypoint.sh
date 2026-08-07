#!/usr/bin/env bash
# 梨园 Docker 入口：把配置/素材落到挂载卷里，再启动服务。
#
# 为什么需要它：应用按 process.cwd()（=/app）读 liyuan.config.json / liyuan.agent.json，
# 但这两个文件若在 compose 里直接做文件级 bind mount，宿主机上不存在时 Docker 会
# 造一个空目录去盖镜像里的文件，runc 直接崩（issue #1）。
# 改法：只挂目录 /app/config，首启从 example 播种，再软链回 /app —— 应用侧读取路径不变。
set -euo pipefail
cd /app

CONFIG_DIR="${LIYUAN_CONFIG_DIR:-/app/config}"

seed_and_link() {
  local name="$1" example="$2"
  local target="${CONFIG_DIR}/${name}"

  # 宿主机挂进来的可能是空目录（老版本 compose 的残留），清掉以免软链失败
  if [[ -d "$target" && ! -L "$target" ]]; then
    if [[ -z "$(ls -A "$target" 2>/dev/null)" ]]; then
      echo "[liyuan] 清理 ${target}（空目录，应为文件——旧版挂载残留）"
      rmdir "$target"
    else
      echo "[liyuan] 警告：${target} 是非空目录，应为文件；跳过播种，请手动处理" >&2
      return 0
    fi
  fi

  if [[ ! -e "$target" ]]; then
    echo "[liyuan] 生成 ${name}（来自 ${example}）"
    cp "$example" "$target"
  fi

  # /app/<name> 始终指向卷里的真身；镜像内置的同名文件是首启前的占位，可安全覆盖
  ln -sfn "$target" "/app/${name}"
}

mkdir -p "$CONFIG_DIR"
seed_and_link liyuan.config.json /app/liyuan.config.example.json
seed_and_link liyuan.agent.json  /app/liyuan.agent.example.json

# 角色卡/世界书目录挂空卷会遮住镜像自带的默认素材，首启补一份进去
seed_assets() {
  local dir="$1" src="$2"
  [[ -d "$src" ]] || return 0
  mkdir -p "$dir"
  if [[ -z "$(ls -A "$dir" 2>/dev/null)" ]]; then
    echo "[liyuan] 初始化 ${dir}（默认素材）"
    cp -r "${src}/." "$dir/" 2>/dev/null || true
  fi
}
seed_assets /app/assets/cards     /app/assets/default/cards
seed_assets /app/assets/lorebooks /app/assets/default/lorebooks

exec "$@"
