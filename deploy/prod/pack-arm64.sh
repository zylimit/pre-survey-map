#!/usr/bin/env bash
# 腾讯云 x86 跨架构打包脚本 —— 在【项目根目录】跑：bash deploy/prod/pack-arm64.sh
# 产出：presurvey-deploy-arm64.tar.gz（含 arm64 镜像 tar + compose.prod + init.sql + geo_data + 部署脚本）
# 前提：腾讯云已装 docker + buildx；代码已是最新（含 #37）。
set -euo pipefail

PLATFORM=linux/arm64
POSTGIS=postgis/postgis:16-3.4
OUT=presurvey-deploy-arm64

echo "== 0. 代码最新性自查（确保含最新提交）=="
git log --oneline -1 || true

echo "== 1. 启用 QEMU 跨架构模拟 =="
docker run --privileged --rm tonistiigi/binfmt --install arm64
docker buildx create --use --name presurvey-builder 2>/dev/null || docker buildx use presurvey-builder
docker buildx inspect --bootstrap

echo "== 2. 确认 postgis:16-3.4 有 arm64 =="
if docker manifest inspect "$POSTGIS" | grep -q '"architecture": "arm64"'; then
  echo "   ✅ $POSTGIS 含 arm64"
else
  echo "   !! $POSTGIS 无 arm64 —— 停。改用 imresamu/postgis 的 arm64 tag，告诉规划侧调整。"; exit 1
fi

echo "== 3. buildx 跨架构构建 arm64 镜像（QEMU 模拟，较慢，耐心等）=="
docker buildx build --platform "$PLATFORM" -t presurvey-web:arm64 --load ./web
docker buildx build --platform "$PLATFORM" -t presurvey-api:arm64 --load ./api

echo "== 4. 拉 arm64 postgis =="
docker pull --platform "$PLATFORM" "$POSTGIS"

echo "== 5. save 三镜像到一个 tar =="
docker save presurvey-web:arm64 presurvey-api:arm64 "$POSTGIS" -o presurvey-arm64-images.tar

echo "== 6. 组装离线部署包 =="
rm -rf "$OUT" && mkdir -p "$OUT"
mv presurvey-arm64-images.tar "$OUT/"
cp deploy/prod/docker-compose.prod.yml "$OUT/"
cp deploy/prod/.env.prod.example       "$OUT/"
cp deploy/prod/load-and-up.sh          "$OUT/"
cp deploy/db/init.sql                  "$OUT/init.sql"
if [ -d deploy/db/geo_data ]; then cp -r deploy/db/geo_data "$OUT/geo_data"; else echo "   !! 缺 deploy/db/geo_data，确认底图数据路径"; fi
tar czf "$OUT.tar.gz" "$OUT"
rm -rf "$OUT"

echo ""
echo "✅ 打包完成：$(pwd)/$OUT.tar.gz  （$(du -h "$OUT.tar.gz" | cut -f1)）"
echo "   下一步：跳板机下载它 → 上传内网服务器 → 解压 → cp .env.prod.example .env.prod 改密码 → bash load-and-up.sh"
