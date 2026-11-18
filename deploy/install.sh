#!/usr/bin/env bash
# ============================================================================
# Server Panel · 一键安装 / 升级脚本
# ----------------------------------------------------------------------------
# 三种用法，效果一致（都需要 root）：
#
#   1) 服务器上已 clone：
#        sudo ./deploy/install.sh
#
#   2) 上传了 tar.gz 包：
#        tar -xzf server-panel-1.0.0.tar.gz && cd server-panel-1.0.0
#        sudo ./deploy/install.sh
#
#   3) 什么都没有，直接拉最新 main：
#        curl -fsSL https://raw.githubusercontent.com/Oppenhello/server-panel/main/deploy/install.sh \
#          | sudo bash -s -- --port 3100
#
# 常用参数：
#   --port N           面板后端端口（默认 3100）
#   --user NAME        登录用户名（默认 admin）
#   --pass PASS        登录口令；不传则随机生成并打印一次
#   --server-name NAME 域名，写进 nginx server_name（默认 _ 即本机所有地址）
#   --no-nginx         不装 nginx，Node 直接托管静态文件（仅内网/试跑）
#   --dir PATH         程序安装目录（默认 /opt/server-panel）
#   --web PATH         静态文件目录（默认 /var/www/panel）
#   --uninstall        卸载（保留 /etc/server-panel-hosts.json 远程主机清单）
#   -h, --help         看帮助
#
# 重复执行即为升级：程序与静态文件覆盖，/etc/server-panel.env 里的口令保持不变。
# ============================================================================
set -euo pipefail

PORT=3100
PANEL_USER_NAME="admin"
PANEL_PASS_IN=""
SERVER_NAME="_"
USE_NGINX=1
APP_DIR="/opt/server-panel"
WEB_DIR="/var/www/panel"
ENV_FILE="/etc/server-panel.env"
UNIT_FILE="/etc/systemd/system/server-panel.service"
NGINX_CONF="/etc/nginx/conf.d/server-panel.conf"
SERVICE="server-panel"
UNINSTALL=0

REPO_TARBALL="https://codeload.github.com/Oppenhello/server-panel/tar.gz/refs/heads/main"

# ---------- 输出 ----------
info() { printf '\033[36m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m[ok]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[!]\033[0m %s\n' "$*"; }
die()  { printf '\033[31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '3,29p' "${BASH_SOURCE[0]:-$0}" 2>/dev/null | sed 's/^# \{0,1\}//' || true
  exit 0
}

# ---------- 参数 ----------
while [ $# -gt 0 ]; do
  case "$1" in
    --port)        PORT="${2:?--port 需要参数}"; shift 2 ;;
    --user)        PANEL_USER_NAME="${2:?--user 需要参数}"; shift 2 ;;
    --pass)        PANEL_PASS_IN="${2:?--pass 需要参数}"; shift 2 ;;
    --server-name) SERVER_NAME="${2:?--server-name 需要参数}"; shift 2 ;;
    --dir)         APP_DIR="${2:?--dir 需要参数}"; shift 2 ;;
    --web)         WEB_DIR="${2:?--web 需要参数}"; shift 2 ;;
    --no-nginx)    USE_NGINX=0; shift ;;
    --uninstall)   UNINSTALL=1; shift ;;
    -h|--help)     usage ;;
    *)             die "未知参数：$1（用 --help 查看用法）" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "请用 root 运行：sudo $0"

# ---------- 卸载 ----------
if [ "$UNINSTALL" -eq 1 ]; then
  info "卸载 Server Panel"
  systemctl stop "$SERVICE" 2>/dev/null || true
  systemctl disable "$SERVICE" 2>/dev/null || true
  rm -f "$UNIT_FILE"
  systemctl daemon-reload 2>/dev/null || true
  rm -rf "$APP_DIR" "$WEB_DIR"
  rm -f "$NGINX_CONF"
  command -v nginx >/dev/null 2>&1 && nginx -t >/dev/null 2>&1 && systemctl reload nginx 2>/dev/null || true
  rm -f "$ENV_FILE"
  ok "已卸载。远程主机清单仍在 /etc/server-panel-hosts.json（需要删除请手动 rm）"
  exit 0
fi

# ---------- 找源文件 ----------
SRC=""
self_dir=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi
if [ -n "$self_dir" ] && [ -f "$self_dir/../server/server.js" ]; then
  SRC="$(cd "$self_dir/.." && pwd)"
  info "使用本地文件：$SRC"
else
  info "未找到本地源码，下载 main 分支快照"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  got=0
  if command -v curl >/dev/null 2>&1; then
    if curl -fsSL "$REPO_TARBALL" | tar -xz -C "$TMP" --strip-components=1; then got=1; fi
  fi
  if [ "$got" -eq 0 ] && command -v wget >/dev/null 2>&1; then
    if wget -qO- "$REPO_TARBALL" | tar -xz -C "$TMP" --strip-components=1; then got=1; fi
  fi
  if [ "$got" -eq 0 ] && command -v git >/dev/null 2>&1; then
    if git clone --depth=1 https://github.com/Oppenhello/server-panel.git "$TMP/repo" >/dev/null 2>&1; then
      TMP="$TMP/repo"; got=1
    fi
  fi
  [ "$got" -eq 1 ] || die "下载源码失败（网络受限？）。请在能上网的机器上 clone 或下载发行包，再执行本脚本"
  SRC="$TMP"
fi

[ -f "$SRC/server/server.js" ] || die "源码不完整：缺 server/server.js"
[ -f "$SRC/web/index.html" ]  || die "源码不完整：缺 web/index.html"

# ---------- 依赖检查 ----------
info "检查 Node.js"
command -v node >/dev/null 2>&1 || die "未安装 Node.js 18+。请先装：
  CentOS/Rocky: dnf module install -y nodejs:20
  Debian/Ubuntu: curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt install -y nodejs"
NODE_BIN="$(command -v node)"
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "Node 版本 $("$NODE_BIN" -v) 过低，需要 18 及以上"
ok "Node $("$NODE_BIN" -v) → $NODE_BIN"

command -v npm >/dev/null 2>&1 || die "未找到 npm（应与 Node 一起安装）"

if [ "$USE_NGINX" -eq 1 ] && ! command -v nginx >/dev/null 2>&1; then
  warn "未检测到 nginx。改用「Node 直接托管」模式（等价于 --no-nginx）"
  USE_NGINX=0
fi

# ---------- 安装程序文件 ----------
info "安装到 $APP_DIR"
mkdir -p "$APP_DIR"
for f in server.js remote.js package.json package-lock.json; do
  [ -f "$SRC/server/$f" ] && install -m 644 "$SRC/server/$f" "$APP_DIR/$f"
done
( cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1 || npm install --omit=dev --no-audit --no-fund >/dev/null )
ok "依赖已安装（ws、ssh2）"

# ---------- 静态文件 ----------
info "安装静态文件到 $WEB_DIR"
mkdir -p "$WEB_DIR"
install -m 644 "$SRC/web/index.html" "$WEB_DIR/index.html"
install -m 644 "$SRC/web/style.css"  "$WEB_DIR/style.css"
install -m 644 "$SRC/web/app.js"     "$WEB_DIR/app.js"
chmod -R a+rX "$WEB_DIR"
ok "静态文件就绪"

# ---------- 配置文件 ----------
# 用 awk 改写单个键：口令里可能含 $ | & 等字符，走 sed/heredoc 容易被解释
set_env() {
  local k="$1" v="$2"
  v="${v//\\/\\\\}"   # 反斜杠要先转义一层，否则 awk -v 会把它当转义序列吃掉
  awk -v k="$k" -v v="$v" '
    BEGIN { done = 0 }
    index($0, k "=") == 1 { print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }
  ' "$ENV_FILE" > "$ENV_FILE.tmp" && mv "$ENV_FILE.tmp" "$ENV_FILE"
}

if [ -f "$ENV_FILE" ]; then
  info "保留已有配置 $ENV_FILE（口令不变）"
  set_env PANEL_PORT "$PORT"
  set_env PANEL_USER "$PANEL_USER_NAME"
  set_env PANEL_WEB "$WEB_DIR"
  [ -n "$PANEL_PASS_IN" ] && set_env PANEL_PASS "$PANEL_PASS_IN"
  GEN_PASS=""
else
  info "生成配置 $ENV_FILE"
  if [ -n "$PANEL_PASS_IN" ]; then
    GEN_PASS="$PANEL_PASS_IN"
  elif command -v openssl >/dev/null 2>&1; then
    GEN_PASS="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-20)"
  else
    GEN_PASS="$(head -c 18 /dev/urandom | base64 | tr -d '/+=')"
  fi
  BIND_HOST="127.0.0.1"
  [ "$USE_NGINX" -eq 0 ] && BIND_HOST="0.0.0.0"
  umask 077
  {
    printf 'PANEL_PORT=%s\n' "$PORT"
    printf 'PANEL_HOST=%s\n' "$BIND_HOST"
    printf 'PANEL_USER=%s\n' "$PANEL_USER_NAME"
    printf 'PANEL_PASS=%s\n' "$GEN_PASS"
    printf 'PANEL_WEB=%s\n' "$WEB_DIR"
    printf 'PANEL_WATCH=%s\n' 'nginx.service,sshd.service,server-panel.service'
    printf 'PANEL_PUBLIC_IP=\n'
  } > "$ENV_FILE"
  umask 022
fi
chmod 600 "$ENV_FILE"
ok "配置 $ENV_FILE（600）"

# 绑定地址跟部署形态保持一致：nginx 反代 → 只听本机；直连 → 必须 0.0.0.0
if [ "$USE_NGINX" -eq 1 ]; then
  set_env PANEL_HOST "127.0.0.1"
else
  set_env PANEL_HOST "0.0.0.0"
  if [ -f "$NGINX_CONF" ]; then
    warn "检测到上次安装留下的 $NGINX_CONF，本次是直连模式；如需清理：rm $NGINX_CONF && systemctl reload nginx"
  fi
fi

# ---------- systemd ----------
info "写入 systemd 单元"
cat > "$UNIT_FILE" <<EOF
[Unit]
Description=Server Panel (monitor & control)
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN server.js
Restart=always
RestartSec=3
User=root
LimitNOFILE=8192

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1 || true
systemctl restart "$SERVICE"
sleep 2
systemctl is-active --quiet "$SERVICE" || {
  warn "服务未能启动，最近日志："
  journalctl -u "$SERVICE" -n 20 --no-pager || true
  die "启动失败"
}
ok "服务已启动并设为开机自启"

# ---------- nginx ----------
if [ "$USE_NGINX" -eq 1 ]; then
  info "写入 nginx 站点配置 $NGINX_CONF"
  cat > "$NGINX_CONF" <<EOF
# 由 deploy/install.sh 生成
server {
    listen 80;
    server_name $SERVER_NAME;
    root $WEB_DIR;
    index index.html;

    location / {
        try_files \$uri \$uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_read_timeout 120s;
        proxy_buffering off;
    }

    location = /ws {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
    }
}
EOF
  if nginx -t >/dev/null 2>&1; then
    systemctl reload nginx 2>/dev/null || systemctl restart nginx
    ok "nginx 已重载"
  else
    warn "nginx 配置检查未通过，请手动执行 nginx -t 查看原因"
  fi

  # CentOS / Rocky 上 SELinux 会拦 nginx 反代到本机端口
  if command -v getenforce >/dev/null 2>&1 && [ "$(getenforce)" = "Enforcing" ]; then
    if command -v setsebool >/dev/null 2>&1; then
      setsebool -P httpd_can_network_connect 1 2>/dev/null && ok "已放开 SELinux httpd_can_network_connect"
    fi
  fi
fi

# ---------- 自检 ----------
info "本地探测 /api/ping"
PING_HOST="127.0.0.1"
if command -v curl >/dev/null 2>&1; then
  if curl -fsS -m 5 "http://$PING_HOST:$PORT/api/ping" >/dev/null 2>&1; then
    ok "后端响应正常"
  else
    warn "后端未响应，检查 journalctl -u $SERVICE -n 50"
  fi
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -z "$IP" ] && IP="<服务器地址>"

echo
echo "──────────────────────────────────────────────"
if [ "$USE_NGINX" -eq 1 ]; then
  echo " 访问地址   http://${IP}/"
else
  warn "当前是 --no-nginx 模式：服务监听 0.0.0.0:$PORT，面板等价 root 权限，"
  warn "请不要直接暴露到公网；正式使用建议加 nginx + HTTPS。"
  echo " 访问地址   http://${IP}:${PORT}/"
fi
echo " 用户名     $PANEL_USER_NAME"
if [ -n "${GEN_PASS:-}" ]; then
  echo " 登录口令   $GEN_PASS      <-- 只显示这一次，请立即保存"
else
  echo " 登录口令   （沿用 $ENV_FILE 中原有口令）"
fi
echo
echo " 配置       $ENV_FILE       （改完 systemctl restart $SERVICE）"
echo " 日志       journalctl -u $SERVICE -f"
echo " 升级       重新运行本脚本即可（口令不变）"
echo " 卸载       sudo $0 --uninstall"
echo "──────────────────────────────────────────────"
