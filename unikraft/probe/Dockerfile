# 验证镜像：确认 Unikraft 上能否跑 Node + ffmpeg + 持久卷
#
# 为什么基于 debian 而不是 node:20-slim：
#   实测 node 官方镜像的 base-compat 运行时没有 ext4 块设备驱动，
#   挂载卷时直接报 "Init function failed with error -19 (ENODEV)"。
#   debian 镜像带驱动，挂卷正常（已验证 lost+found 可见、可读写）。
#
# 这个镜像只做四件事，不做业务：
#   1. 打印 node / ffmpeg 版本，确认二进制能在 unikernel 里执行
#   2. 往 /data 写文件再读回，确认持久卷可写
#   3. spawn 一个子进程，确认 fork/exec 可用（ffmpeg 依赖这个）
#   4. 测一次出站下载速率
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_MAJOR=20

# ca-certificates：拉直播流和调 OpenList 都走 HTTPS
# ffmpeg：核心依赖
# curl：测带宽、健康检查
# xz-utils：解压 Node 官方 tar.xz
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils ffmpeg \
 && rm -rf /var/lib/apt/lists/*

# 装 Node 20（用官方二进制，不用 nodesource 源，体积更可控）
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) node_arch=x64 ;; \
      arm64) node_arch=arm64 ;; \
      *) echo "unsupported arch: $arch" >&2; exit 1 ;; \
    esac; \
    ver="20.20.2"; \
    curl -fsSL --retry 3 -o /tmp/node.tar.xz \
      "https://nodejs.org/dist/v${ver}/node-v${ver}-linux-${node_arch}.tar.xz"; \
    tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
      --exclude='*/CHANGELOG.md' --exclude='*/LICENSE' --exclude='*/README.md'; \
    rm -f /tmp/node.tar.xz; \
    node --version; npm --version

WORKDIR /app
COPY probe.mjs ./

# 数据目录走持久卷挂载点；rootfs 是只读的，所有可写内容必须落在 /data
ENV DATA_DIR=/data
ENV PORT=8080

EXPOSE 8080

# 直接跑探测脚本，跑完起一个 HTTP 服务保活
CMD ["/usr/local/bin/node", "/app/probe.mjs"]
