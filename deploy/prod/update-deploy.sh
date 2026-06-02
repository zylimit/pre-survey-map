#!/usr/bin/env bash
# 腾讯云打包机一键出包：跨架构构建 arm64 + 带版本号打包 + 上架 CF 下载站 + 打印跳板机拉取 URL
# 用法（在腾讯云项目根目录）：bash deploy/prod/update-deploy.sh [版本标签]
#   例：bash deploy/prod/update-deploy.sh f20      → 镜像 tag :f20，包名带时间戳
#
# 设计：镜像 tag = 版本标签（稳定，server-deploy-*.sh 不用改）；
#       tar 文件名 = presurvey-<标签>-<时间戳>-arm64.tar（每次不同 → 天然绕开 CF 边缘旧缓存）
set -euo pipefail

TAG=${1:-f20}                           # 版本标签（对应里程碑，默认 f20）
TS=$(date +%Y%m%d-%H%M%S)               # 时间戳（防缓存 + 可追溯）
PKG="presurvey-${TAG}-${TS}-arm64.tar"
DLDIR=/var/www/dl
PROJ=${PROJ:-~/pre-survey-map}
cd "$PROJ"

echo "== 1. QEMU + buildx =="
docker run --privileged --rm tonistiigi/binfmt --install arm64 >/dev/null 2>&1 || true
docker buildx use pmb 2>/dev/null || docker buildx create --use --name pmb
docker buildx inspect --bootstrap >/dev/null

echo "== 2. 跨架构构建 arm64（web+api，tag :$TAG 稳定）=="
docker buildx build --platform linux/arm64 -t "presurvey-web:$TAG" --load ./web
docker buildx build --platform linux/arm64 -t "presurvey-api:$TAG" --load ./api

echo "== 3. 架构校验（必须 arm64）=="
A_WEB=$(docker image inspect "presurvey-web:$TAG" --format '{{.Architecture}}')
A_API=$(docker image inspect "presurvey-api:$TAG" --format '{{.Architecture}}')
echo "   web=$A_WEB  api=$A_API"
[ "$A_WEB" = "arm64" ] && [ "$A_API" = "arm64" ] || { echo "!! 架构不是 arm64，QEMU 没生效，停。"; exit 1; }

echo "== 4. save 带版本号 tar =="
docker save "presurvey-web:$TAG" "presurvey-api:$TAG" -o "$PKG"

echo "== 5. 上架 CF 下载站 + chmod 644（防 nginx 403）=="
sudo mkdir -p "$DLDIR"
sudo cp "$PKG" "$DLDIR/"
sudo cp "$PROJ/deploy/db/init.sql" "$DLDIR/" 2>/dev/null || true
sudo chmod 755 /var/www "$DLDIR"
sudo chmod 644 "$DLDIR"/*

SZ=$(du -h "$DLDIR/$PKG" | cut -f1)
echo ""
echo "✅ 出包完成：$PKG（$SZ），镜像 tag = presurvey-web:$TAG / presurvey-api:$TAG"
echo "────────────────────────────────────────────────────────────"
echo "跳板机拉取（文件名带时间戳，绕开 CF 旧缓存）："
echo "  curl -L -O https://img.mangosv5.app/$PKG"
echo "  curl -L -O https://img.mangosv5.app/init.sql"
echo "服务器 load 后镜像 tag 仍是 :$TAG → server-deploy-${TAG}.sh 不用改"
echo "  （load 的 tar 是 $PKG，但解出来的镜像 tag 是 :$TAG，docker run 照常用 :$TAG）"
echo "────────────────────────────────────────────────────────────"
echo "可浏览所有历史包：https://img.mangosv5.app/   （nginx autoindex）"
