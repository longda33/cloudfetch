#!/usr/bin/env bash
# 把 CloudFetch 部署到 Unikraft Cloud。
#
# 前提：
#   - 已 unikraft login
#   - 镜像已构建推送（GitHub Actions: unikraft-deploy.yml）
#   - 环境变量准备好（OpenList 地址/令牌、面板密码）
#
# 用法：
#   export OPENLIST_URL=... OPENLIST_TOKEN=... PANEL_PASSWORD=...
#   ./deploy-app.sh [metro]
#
# 内存说明：ffmpeg 的 rootfs 约 600MB 且常驻内存，
# 1GiB 是最小可用值，建议给满 4GiB（配额上限）。

set -euo pipefail

METRO="${1:-fra}"
ORG="${UNIKRAFT_ORG:-panpp123}"
IMAGE="${ORG}/cloudfetch:latest"
INSTANCE="cloudfetch"
VOLUME="cfdata"
VOLUME_SIZE="${VOLUME_SIZE:-1GiB}"
MEMORY="${MEMORY:-4GiB}"

log() { printf '\033[36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33m!!  %s\033[0m\n' "$*"; }
die() { printf '\033[31mxx  %s\033[0m\n' "$*" >&2; exit 1; }

# ---------- 0) 必需的环境变量 ----------
[ -n "${OPENLIST_URL:-}" ]   || die "缺少 OPENLIST_URL"
[ -n "${OPENLIST_TOKEN:-}" ] || die "缺少 OPENLIST_TOKEN"
[ -n "${PANEL_PASSWORD:-}" ] || die "缺少 PANEL_PASSWORD"

# ---------- 1) 持久卷 ----------
log "检查持久卷 ${VOLUME}"
if unikraft volumes list --metro "$METRO" -o json 2>/dev/null | grep -q "\"name\": *\"${VOLUME}\""; then
  log "卷已存在"
else
  log "创建卷 ${VOLUME} (${VOLUME_SIZE})"
  unikraft volumes create --metro "$METRO" --name "$VOLUME" --size "$VOLUME_SIZE"
fi

# ---------- 2) 清掉旧实例 ----------
if unikraft instances list --metro "$METRO" -o json 2>/dev/null | grep -q "\"name\": *\"${INSTANCE}\""; then
  warn "发现同名实例，先删除"
  unikraft instances delete --force "$INSTANCE" || true
  sleep 3
fi

# ---------- 3) 部署 ----------
# 参数说明（都是实测踩出来的）：
#   -v cfdata:/data         持久卷。rootfs 只读，可写内容必须落这里。
#                           config.js 会自动探测 /data 可写，用它做 DATA_DIR。
#   --scale-to-zero=policy=off
#                           必须关。默认开启，空闲会把实例挂起，
#                           直播录制一旦被挂起 ffmpeg 就没了。
#                           可选值 on|idle|off，不是布尔开关。
#   --restart=on-failure    崩溃自动拉起
#   -m ${MEMORY}            ffmpeg rootfs 常驻内存，给足
#   -p 443:8080/http+tls    容器内 PORT=8080
log "部署 ${INSTANCE}（${MEMORY}，metro=${METRO}）"

# 转码链路是可选能力：只有显式提供了才注入，避免把空值写进实例环境
# （空字符串会覆盖镜像里的默认值）。
EXTRA_ENV=()
for k in R2_ACCOUNT_ID R2_ENDPOINT R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET R2_PREFIX \
         GH_REPO GH_TOKEN GH_WORKFLOW GH_REF TRANSCODE_ENABLED TRANSCODE_TIMEOUT; do
  v="${!k:-}"
  [ -n "$v" ] && EXTRA_ENV+=(-e "${k}=${v}")
done

unikraft run \
  --metro "$METRO" \
  --name "$INSTANCE" \
  --image "$IMAGE" \
  -m "$MEMORY" \
  --vcpus 1 \
  -v "${VOLUME}:/data" \
  -p 443:8080/http+tls \
  --scale-to-zero=policy=off \
  --restart=on-failure \
  -e "OPENLIST_URL=${OPENLIST_URL}" \
  -e "OPENLIST_TOKEN=${OPENLIST_TOKEN}" \
  -e "OPENLIST_UPLOAD_DIR=${OPENLIST_UPLOAD_DIR:-/od-20200439/cloudfetch}" \
  -e "PANEL_PASSWORD=${PANEL_PASSWORD}" \
  -e "DELETE_AFTER_UPLOAD=${DELETE_AFTER_UPLOAD:-true}" \
  -e "LIVE_SEGMENT_SECONDS=${LIVE_SEGMENT_SECONDS:-300}" \
  ${EXTRA_ENV[@]+"${EXTRA_ENV[@]}"}

# ---------- 4) 等就绪 ----------
log "等待 running"
if ! unikraft instances wait --metro "$METRO" --until state=running --timeout 180s "$INSTANCE"; then
  warn "未进入 running，拉日志："
  unikraft instances logs "$INSTANCE" || true
  exit 1
fi

log "实例信息"
unikraft instances get "$INSTANCE"

log "启动日志"
sleep 8
unikraft instances logs "$INSTANCE" || true

FQDN=$(unikraft instances get "$INSTANCE" -o json 2>/dev/null \
  | grep -o '"fqdn": *"[^"]*"' | head -1 | cut -d'"' -f4 || true)

if [ -n "${FQDN:-}" ]; then
  log "面板地址: https://${FQDN}"
  log "健康检查: https://${FQDN}/api/health"
  echo
  echo "验证健康检查："
  curl -s --max-time 20 "https://${FQDN}/api/health" || warn "健康检查未响应（可能还在启动）"
fi
