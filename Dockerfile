# CloudFetch 生产镜像
#
# 同时适配两个平台：
#   - Unikraft Cloud（挂 /data 持久卷）
#   - Cloady（无持久卷，落 /tmp）
# config.js 会自动探测 /data 是否可写来决定用哪个。
#
# 为什么基于 debian 而不是 node:20-slim：
#   实测 node 官方镜像的 base-compat 运行时没有 ext4 块设备驱动，
#   Unikraft 上挂持久卷直接报 "Init function failed with error -19 (ENODEV)"。
#   debian 镜像带驱动，挂卷正常。
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# ffmpeg 是核心依赖（RTMP/FLV 直播录制必需）。
# --no-install-recommends 已把体积压到最小，但它仍会带进 libllvm15 等
# 一堆依赖，总共约 488MB。清掉文档和语言包能省几十 MB。
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      xz-utils \
      ffmpeg \
 && rm -rf /var/lib/apt/lists/* \
 && rm -rf /usr/share/doc/* /usr/share/man/* /usr/share/locale/*

# Node 20（官方二进制，比 nodesource 源体积可控）
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

# 先装依赖，利用层缓存
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund \
 && npm cache clean --force

# 再拷源码（路径基于 __dirname，与 cwd 无关）
COPY src/ ./src/
COPY public/ ./public/

# 端口用 8080：Unikraft 的服务映射是 443→8080。
# Cloady 那边靠 PORT 环境变量覆盖成 3000，不受影响。
ENV PORT=8080
ENV NODE_ENV=production

# 分段时间 30 分钟（1800 秒）。
# 敢用这么长是因为上传走分片协议，单段体积不受 CDN 单请求上限约束。
ENV LIVE_SEGMENT_SECONDS=1800

EXPOSE 8080

# 不切 USER：Unikraft 实例以 root 运行，
# 且持久卷挂载后属主可能不是 node，切用户会写不进去。
#
# 必须用绝对路径：实测 Unikraft 不遵守 WORKDIR，
# 写 ["node", "src/server.js"] 会被解析成 /src/server.js 然后 MODULE_NOT_FOUND。
CMD ["node", "/app/src/server.js"]
