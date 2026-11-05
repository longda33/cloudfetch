# CloudFetch ☁️

云端下载器：粘贴链接 → 实时进度 → 自动上传 OpenList → 删除本地文件。

部署在 [Cloady](https://cloady.com) PaaS 上，也可本地 / Docker 自托管。

## 特性

- **多种链接类型**
  - HTTP 直链（支持 Range 分片并行 + 断点续传）
  - HLS / m3u8（自动选最高码率，分片并发下载后拼接）
  - HTTP-FLV 直播流（自动识别，单文件长连接）
  - RTMP 直播（经 ffmpeg 录制）
- **直播不分段**：默认一次连接写一个完整文件；**仅在连接中断时**自动重连并把已下内容另存分段，最后合并
- **强重试**：连接超时、空闲超时、分片失败、上传失败全部带指数退避重试
- **实时进度**：SSE 推送，Web 面板显示速度 / 百分比 / 剩余时间 / 分片进度
- **自动上云**：下载完成即上传 OpenList，成功后删除本地文件
- **省存储**：默认下到 `/tmp`，不占持久卷

## 快速开始

### 本地运行

```bash
npm install
cp .env.example .env      # 按需修改
npm start
# 打开 http://localhost:3000
```

需要 Node 20+。RTMP 直播需要系统装有 `ffmpeg`。

### Docker

```bash
docker build -t cloudfetch .
docker run -d --name cloudfetch -p 3000:3000 \
  -e OPENLIST_URL=https://pan.example.com \
  -e OPENLIST_TOKEN=your-token \
  -e PANEL_PASSWORD=your-password \
  cloudfetch
```

镜像已内置 ffmpeg。

### 部署到 Cloady

```bash
export CLOADY_TOKEN=cldy_xxx
export GIT_REPO_URL=https://github.com/<user>/cloudfetch
./deploy.sh
```

脚本会：创建应用 → 注入环境变量 → 触发部署 → 轮询状态 → 打印访问地址。

## 配置

全部通过环境变量，见 [.env.example](.env.example)。关键几项：

| 变量 | 说明 | 默认 |
|---|---|---|
| `PORT` | 监听端口 | `3000` |
| `PANEL_PASSWORD` | 面板访问密码，留空则不鉴权 | 空 |
| `DATA_DIR` | 下载临时目录 | `/tmp/cloudfetch` |
| `MAX_FILE_SIZE` | 单文件上限（字节） | 20 GB |
| `MAX_CONCURRENT` | 最大并发任务数 | `2` |
| `OPENLIST_URL` | OpenList 站点地址 | 空 |
| `OPENLIST_TOKEN` | OpenList API 令牌 | 空 |
| `OPENLIST_UPLOAD_DIR` | 上传目标目录 | `/cloudfetch` |
| `DELETE_AFTER_UPLOAD` | 传完删本地 | `true` |
| `RETRY_MAX_ATTEMPTS` | 最大重试次数 | `8` |
| `IDLE_TIMEOUT` | 空闲多久判定卡死（毫秒） | `60000` |

### 获取 OpenList 令牌

OpenList 后台 → **设置** → **其他** → **令牌**，复制即可。也支持填账号密码自动登录换 token。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/health` | 健康检查与限额 |
| `POST` | `/api/tasks` | 新建任务（`{url}` 或 `{text:"多行"}` 或 `{urls:[]}`） |
| `GET` | `/api/tasks` | 任务列表 |
| `GET` | `/api/tasks/:id` | 单个任务详情 |
| `POST` | `/api/tasks/:id/cancel` | 取消 |
| `DELETE` | `/api/tasks/:id` | 删除记录 |
| `POST` | `/api/tasks/clear` | 清空已结束 |
| `GET` | `/api/events` | SSE 实时推送 |
| `GET` | `/api/openlist/check` | OpenList 连接测试 |
| `GET` | `/api/disk` | 磁盘空间 |

命令行提交任务：

```bash
curl -X POST http://localhost:3000/api/tasks \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com/video.mp4"}'
```

## 设计说明

### 为什么直播不分段

直播源不稳定时，传统做法是固定时长切段（每分钟一个文件）。但这样正常播放时也会被切成碎片，后期还要合并。

本项目反过来：**默认一整条长连接写单个文件**，只有当连接真的断了，才把已下载部分保留为分段并重连。这样：

- 直播稳定 → 得到完整单文件
- 直播抖动 → 只在中断处产生分段，损失最小

### 断点续传

HTTP 分片下载会把已完成分片记在 `<file>.parts/` 目录，重启后自动跳过已完成部分。单流下载用 `.part` 后缀文件记录进度。

### 进度统计

直播流的总大小未知，进度条显示已下载字节数（不确定态）；普通文件按 `已下载 / Content-Length` 计算百分比。

## 已知限制

- Cloady 免费额度：0.5 CPU / 1 GB 内存 / 5 GB 存储。大文件需注意磁盘余量。
- DASH（`.mpd`）暂不支持。
- RTMP 录制依赖 ffmpeg，且 `-c copy` 不做转码，源编码不兼容时可能失败。

## License

MIT
