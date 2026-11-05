# 基础镜像：Node 20 (Debian slim)，自带 ffmpeg 安装能力
FROM node:20-slim

# 安装 ffmpeg（RTMP 直播录制必需）与 ca-certificates
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先装依赖，利用层缓存
COPY package*.json ./
RUN npm install --omit=dev

# 再拷源码
COPY . .

# 数据目录（临时下载）
ENV DATA_DIR=/tmp/cloudfetch
ENV PORT=3000
ENV NODE_ENV=production

# 非 root 运行
RUN mkdir -p /tmp/cloudfetch && chown -R node:node /tmp/cloudfetch /app
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
