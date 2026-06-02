#!/usr/bin/env bash
# 内网 ARM 服务器部署脚本 —— 在部署包解压目录里跑：bash load-and-up.sh
# 前提：本目录含 presurvey-arm64-images.tar / docker-compose.prod.yml / .env.prod / init.sql / geo_data/
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .env.prod ]; then
  echo "!! 缺 .env.prod —— 先 cp .env.prod.example .env.prod 并改密码"; exit 1
fi

echo "== 1. load 三个 arm64 镜像 =="
docker load -i presurvey-arm64-images.tar

echo "== 2. 起容器（用 image，不 build）=="
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d

echo "== 3. 容器状态 =="
docker compose -f docker-compose.prod.yml ps

echo "== 4. 等 db healthy + 探 api health =="
sleep 10
source .env.prod
curl -s "localhost:${API_PORT:-8000}/health" && echo "" || echo "(api 还在起，稍后再 curl)"

echo ""
echo "✅ 部署完成。前端访问： http://<服务器内网IP>:${WEB_PORT:-80}/"
echo "   数据是空的（清库重来）——用图层的 [导入图层] 导真实数据。"
