#!/usr/bin/env bash
# 内网生产：只换 web（#45 NP 辐射圈半径可配，presurvey-web:v1.0.2）—— 绝不碰 api/db
# ─────────────────────────────────────────────────────────────────────────────
# 在【内网生产服务器 10.50.131.102】上、以 root 跑：
#   su -c 'bash server-deploy-web-v1.0.2.sh'        # 或 sudo bash server-deploy-web-v1.0.2.sh
# 默认读当前目录的 tar，也可传路径：
#   bash server-deploy-web-v1.0.2.sh /path/to/presurvey-web-v1.0.2-20260603-144430-arm64.tar
#
# 🔴 硬约束（已写进逻辑，请勿改动）：
#   - 本脚本只操作 presurvey-web 容器：stop / rm / run 仅作用于 web。
#   - 绝不出现 api/db 容器的 stop/rm/run，绝不 truncate / docker compose down -v / 跑 init.sql。
#   - Docker 18.09 兼容：只用 docker load / inspect / run / ps，不用 compose、不用 --platform。
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

TAR=${1:-./presurvey-web-v1.0.2-20260603-144430-arm64.tar}
IMAGE=presurvey-web:v1.0.2
CTN=presurvey-web

# 探测失败时的回落默认（与内网 v1.0.1 现状一致）
DEFAULT_NET=presurvey-net
DEFAULT_HOSTPORT=18080

echo "== 0. 检查 tar 文件存在 =="
[ -f "$TAR" ] || { echo "!! tar 不存在：$TAR"; echo "   先拉取：curl -L -O https://img.mangosv5.app/presurvey-web-v1.0.2-20260603-144430-arm64.tar"; exit 1; }
echo "   tar = $TAR"

echo "== 1. 探测现网老 $CTN 的 network / 端口（删除前，删了就探不到了）=="
NET=""
HOSTPORT=""
if docker inspect "$CTN" >/dev/null 2>&1; then
    # NetworkMode = 老容器所在 network 名
    NET=$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$CTN" 2>/dev/null || true)
    # 取映射到容器 80 端口的宿主 HostPort
    HOSTPORT=$(docker inspect -f '{{(index (index .NetworkSettings.Ports "80/tcp") 0).HostPort}}' "$CTN" 2>/dev/null || true)
    echo "   探测到：network=$NET  hostport=$HOSTPORT"
else
    echo "   ⚠️  老 $CTN 容器不存在，无法探测。"
fi

# 回落（探测为空/default/无效时）
if [ -z "$NET" ] || [ "$NET" = "default" ] || [ "$NET" = "null" ]; then
    echo "   ⚠️  network 探测无效（值=[$NET]），回落默认：$DEFAULT_NET"
    NET=$DEFAULT_NET
fi
if [ -z "$HOSTPORT" ] || [ "$HOSTPORT" = "null" ]; then
    echo "   ⚠️  端口探测无效（值=[$HOSTPORT]），回落默认：$DEFAULT_HOSTPORT"
    HOSTPORT=$DEFAULT_HOSTPORT
fi
echo "   ▶ 最终采用：network=$NET  端口映射=${HOSTPORT}:80"

echo "== 2. docker load 新镜像 =="
docker load -i "$TAR"

echo "== 3. 校验 $IMAGE 已 load =="
docker images | grep presurvey-web | grep -q "1.0.2" \
    || { echo "!! 未找到 presurvey-web v1.0.2 镜像，load 失败，停。"; docker images | grep presurvey-web || true; exit 1; }
echo "   OK，镜像就绪。"

echo "== 4. 停删老 web（幂等，只动 web，不碰 api/db）=="
docker stop "$CTN" 2>/dev/null || true
docker rm   "$CTN" 2>/dev/null || true

echo "== 5. 起新 web（Docker 18.09 docker run，沿用探测到的 network/端口）=="
if ! docker run -d --name "$CTN" --network "$NET" -p "${HOSTPORT}:80" "$IMAGE"; then
    echo "!! docker run 失败。供人工核对的探测值："
    echo "     network = $NET"
    echo "     端口    = ${HOSTPORT}:80"
    echo "     镜像    = $IMAGE"
    echo "   排查：端口被占用？network 不存在？docker network ls / docker ps -a 看一下。"
    exit 1
fi

echo "== 6. 验证 =="
sleep 2
if docker ps | grep -q "$CTN"; then
    echo "   容器运行中：$(docker ps --filter name=$CTN --format '{{.Names}}  {{.Status}}  {{.Ports}}')"
else
    echo "!! 容器未在运行，看日志：docker logs $CTN"
    docker ps -a | grep "$CTN" || true
    exit 1
fi

CODE=$(curl -s -o /dev/null -w '%{http_code}' -I "http://localhost:${HOSTPORT}" || echo "000")
echo "   curl -I http://localhost:${HOSTPORT}  ->  HTTP $CODE"
case "$CODE" in
    200|301|302)
        echo ""
        echo "✅ web 已换到 v1.0.2 并就绪（network=$NET  端口=${HOSTPORT}:80）。api/db 未触碰。"
        ;;
    403)
        echo ""
        echo "⚠️  返回 403（nginx 静态文件权限问题）。修复："
        echo "     docker exec $CTN chmod -R 755 /usr/share/nginx/html"
        echo "   修复后重新 curl -I http://localhost:${HOSTPORT} 验证。"
        exit 1
        ;;
    *)
        echo ""
        echo "⚠️  HTTP $CODE 非预期。看日志：docker logs $CTN"
        echo "   老容器探测值供人工核对：network=$NET  端口=${HOSTPORT}:80"
        exit 1
        ;;
esac
