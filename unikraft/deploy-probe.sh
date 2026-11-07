#!/usr/bin/env bash
# 部署验证实例到 Unikraft，并把探测结果拉回来。
#
# 前提：
#   - 已 unikraft login
#   - 验证镜像已构建并推送（见 .github/workflows/unikraft-probe.yml）
#   - 持久卷 cfdata 已存在（不存在则自动创建）
#
# 用法：
#   ./deploy-probe.sh [metro]
#   默认 metro=fra

set -euo pipefail

METRO="${1:-fra}"
ORG="${UNIKRAFT_ORG:-panpp123}"
IMAGE="${ORG}/cloudfetch-probe:latest"
INSTANCE="cf-probe"
VOLUME="cfdata"
VOLUME_SIZE="1GiB"

log() { printf '\033[36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33m!!  %s\033[0m\n' "$*"; }

# ---------- 1) 卷 ----------
log "检查持久卷 ${VOLUME}"
if unikraft volumes list --metro "$METRO" -o json 2>/dev/null | grep -q "\"name\": *\"${VOLUME}\""; then
  log "卷已存在，跳过创建"
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
# 关键参数说明（都是实测踩出来的）：
#   -v cfdata:/data
#       挂持久卷。rootfs 是只读的，所有可写内容必须落在 /data。
#   --scale-to-zero=policy=off
#       必须关掉。Unikraft 默认开启 scale-to-zero，空闲时会把实例挂起；
#       直播录制这种长任务一旦被挂起，ffmpeg 进程就没了。
#       CLI 的可选值是 on | idle | off，不是布尔开关。
#   -m 1024MiB
#       ffmpeg 转封装要占内存，512MiB 偏紧。
#   -p 443:8080/http+tls
#       暴露 HTTPS，用于健康检查和读取探测结果。
log "部署实例 ${INSTANCE}"
unikraft run \
  --metro "$METRO" \
  --name "$INSTANCE" \
  --image "$IMAGE" \
  -m 1024MiB \
  --vcpus 1 \
  -v "${VOLUME}:/data" \
  -p 443:8080/http+tls \
  --scale-to-zero=policy=off \
  --restart=on-failure

# ---------- 4) 取探测结果 ----------
# 注意：instances logs / get / delete 都没有 --metro 参数，
# 实例名在各 metro 内全局唯一，直接传名字即可。
log "实例信息"
unikraft instances get "$INSTANCE"

log "探测结果"
# 给应用几秒把五项检查跑完
sleep 12
unikraft instances logs "$INSTANCE" || true

FQDN=$(unikraft instances get "$INSTANCE" -o json 2>/dev/null \
  | grep -o '"fqdn": *"[^"]*"' | head -1 | cut -d'"' -f4 || true)

if [ -n "${FQDN:-}" ]; then
  log "公网地址: https://${FQDN}"
  log "JSON 结果: https://${FQDN}/probe"
fi
