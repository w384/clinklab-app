#!/usr/bin/env bash
# ============================================================================
# ClinkLab 一键部署脚本（Ubuntu 22.04 / 24.04，Node 24 LTS）
#
# 前置：把整个 clinklab_app 项目上传到服务器（如 scp -r 到 /opt/clinklab_app）
# 用法：在项目根目录执行
#   sudo bash deploy/deploy.sh api.你的域名.com
#
# 幂等：重复执行不会覆盖已生成的 .env、不会重复初始化数据库、服务会重启更新。
# ============================================================================
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"   # 项目根（server 的上级）
SERVER_DIR="$APP_DIR/server"
DOMAIN="${1:-api.YOURDOMAIN.com}"
ENV_FILE="$SERVER_DIR/.env"

echo "=== ClinkLab 部署脚本 ==="
echo "  项目目录: $APP_DIR"
echo "  应用目录: $SERVER_DIR"
echo "  API 域名: $DOMAIN"

# ── 1) Node.js ≥23.6（推荐 24 LTS）────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  echo "[1/6] 安装 Node.js 24 LTS ..."
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
else
  NODE_MAJOR="$(node -e 'console.log(process.versions.node.split(".")[0])')"
  echo "[1/6] Node 已存在: $(node -v)"
  if [ "$NODE_MAJOR" -lt 23 ]; then
    echo "  ⚠ 版本低于 23.6，类型剥离不可用。建议升级："
    echo "    curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y nodejs"
  fi
fi

# ── 2) 依赖 ────────────────────────────────────────────────────────────────
echo "[2/6] 安装依赖 (npm ci --omit=dev) ..."
cd "$SERVER_DIR"
npm ci --omit=dev

# ── 3) 环境变量（仅首次生成）──────────────────────────────────────────────
FIRST_INSTALL=0
if [ -f "$ENV_FILE" ]; then
  echo "[3/6] .env 已存在，保留现有配置"
else
  echo "[3/6] 生成 .env ..."
  ADMIN_PASS="$(openssl rand -hex 12 2>/dev/null || echo 'ChangeMe_123')"
  cat > "$ENV_FILE" <<EOF
APP_ENV=production
MOCK_PAY=true
PORT=3050
HOST=127.0.0.1
API_BASE_URL=https://$DOMAIN
ADMIN_USERNAME=admin
ADMIN_PASSWORD=$ADMIN_PASS
WX_APPID=
WX_APPSECRET=
EOF
  FIRST_INSTALL=1
  echo "  ADMIN_PASSWORD 已随机生成 -> 见 $ENV_FILE"
fi

# ── 4) 初始化数据库（仅首次）──────────────────────────────────────────────
if [ "$FIRST_INSTALL" = "1" ]; then
  echo "[4/6] 首次部署，初始化数据库（建表 + 管理账号 + 演示数据）..."
  node --experimental-strip-types src/seed.ts --reset
else
  echo "[4/6] 非首次部署，跳过数据库初始化（保留既有数据）"
fi

# ── 5) systemd 服务 ───────────────────────────────────────────────────────
echo "[5/6] 安装/更新 systemd 服务 ..."
SERVICE_FILE="/etc/systemd/system/clinklab.service"
cp "$APP_DIR/deploy/clinklab.service" "$SERVICE_FILE"
sed -i "s|__SERVER_DIR__|$SERVER_DIR|g" "$SERVICE_FILE"
sed -i "s|__ENV_FILE__|$ENV_FILE|g" "$SERVICE_FILE"
systemctl daemon-reload
systemctl enable clinklab >/dev/null 2>&1 || true
systemctl restart clinklab
sleep 2

# ── 6) 验证 ───────────────────────────────────────────────────────────────
echo "[6/6] 验证服务 ..."
if curl -fsS "http://127.0.0.1:3050/health"; then
  echo ""
  echo "=== 部署完成 ✅ ==="
  echo "  本地健康检查: http://127.0.0.1:3050/health"
  echo "  管理端:       https://$DOMAIN/admin"
  echo "  管理账号:     admin / 密码见 $ENV_FILE 的 ADMIN_PASSWORD"
  echo ""
  echo "  下一步（见 deploy/README-deploy.md）："
  echo "    1) 配置 Nginx + HTTPS（certbot）："
  echo "         apt-get install -y nginx certbot python3-certbot-nginx"
  echo "         cp deploy/nginx.conf.example /etc/nginx/sites-available/clinklab.conf"
  echo "         sed -i s/api.YOURDOMAIN.com/$DOMAIN/g /etc/nginx/sites-available/clinklab.conf"
  echo "         ln -s /etc/nginx/sites-available/clinklab.conf /etc/nginx/sites-enabled/"
  echo "         certbot --nginx -d $DOMAIN"
  echo "    2) 微信后台配合法域名 + 校验文件（见 README-deploy.md）"
else
  echo ""
  echo "=== 服务未通过健康检查，请查看日志：journalctl -u clinklab -n 50 ==="
  exit 1
fi
