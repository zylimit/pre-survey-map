#!/usr/bin/env bash
# 腾讯云源站：nginx serve 部署包下载目录（配合 Cloudflare 橙云 img.mangosv5.app）
# 一键：bash deploy/prod/tencent-dl-nginx.sh
# CF 侧需：img.mangosv5.app A→43.163.3.9 橙云(Proxied) + SSL/TLS=Flexible
set -euo pipefail
DOMAIN=img.mangosv5.app
DLDIR=/var/www/dl

command -v nginx >/dev/null 2>&1 || { sudo apt-get update && sudo apt-get install -y nginx; }
sudo mkdir -p "$DLDIR"

# 把已打好的部署包 + init.sql 放进下载目录（路径按你项目实际位置）
PROJ=${PROJ:-~/pre-survey-map}
[ -f "$PROJ/presurvey-f20-arm64.tar" ] && sudo cp "$PROJ/presurvey-f20-arm64.tar" "$DLDIR/"
[ -f "$PROJ/deploy/db/init.sql" ]      && sudo cp "$PROJ/deploy/db/init.sql"      "$DLDIR/"
# ⚠️ 必须 chmod：sudo cp 落地是 0600(root)，nginx 的 www-data 读不了会 403（实测踩过）
sudo chmod 755 /var/www "$DLDIR"
sudo chmod 644 "$DLDIR"/* 2>/dev/null || true

sudo tee /etc/nginx/conf.d/dl.conf >/dev/null <<EOF
server {
    listen 80;
    server_name $DOMAIN;

    # —— 主用：静态文件下载（部署包）——
    root $DLDIR;
    autoindex on;
    location / { try_files \$uri =404; }

    # —— 特殊情况：同域名反向代理腾讯云测试环境（按需取消注释）——
    # location /app/ { proxy_pass http://127.0.0.1:5173/; proxy_set_header Host \$host; proxy_set_header X-Forwarded-For \$remote_addr; }
    # location /api/ { proxy_pass http://127.0.0.1:8000/; proxy_set_header Host \$host; proxy_set_header X-Forwarded-For \$remote_addr; }
}
EOF

sudo nginx -t && sudo systemctl reload nginx
pkill -f "http.server 8088" 2>/dev/null || true

echo "✅ nginx:80 就绪，下载目录 $DLDIR"
ls -lh "$DLDIR"
echo "等 CF 橙云证书签发后验证："
echo "  curl -I https://$DOMAIN/presurvey-f20-arm64.tar   # 期望 200 + server: cloudflare"
