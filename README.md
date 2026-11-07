# CloudFetch ☁️

云端下载器：粘贴链接 → 实时进度 → 自动上传 OpenList → 删除本地文件。

部署在 [Cloady](https://cloady.com) PaaS 上，也可本地 / Docker 自托管。

## 特性

- **多种链接类型**
  - HTTP 直链（支持 Range 分片并行 + 断点续传）
  - HLS / m3u8（自动选最高码率，分片并发下载后拼接）
  - HTTP-FLV 直播流（自动识别，按时间分段录制）
  - RTMP 直播（经 ffmpeg 录制）
- **直播按时间分段**：每段独立文件、独立上传、**不合并**；分段点对齐关键帧，每段可单独播放
- **强重试**：连接超时、空闲超时、分片失败、上传失败全部带指数退避重试
- **实时进度**：SSE 推送，Web 面板显示速度 / 百分比 / 剩余时间 / 已录段数
- **自动上云**：每段录完立即上传 OpenList，成功后删除本地，不占磁盘
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

### 直播分段时长怎么选

默认 **600 秒（10 分钟）**。这是权衡后的推荐值，理由如下：

| 时长 | 单段大小（4Mbps 码率） | 优点 | 缺点 |
|---|---|---|---|
| 60 秒 | ~30 MB | 断流损失最小；上传最快 | 文件太多（1 小时 = 60 个）；网盘目录难管理 |
| 180 秒 | ~90 MB | 断流损失小 | 文件仍偏多 |
| **600 秒** | **~300 MB** | **损失与数量的平衡点**；1 小时只 6 个文件 | — |
| 1800 秒 | ~900 MB | 文件极少 | 断流损失大；上传失败重试成本高 |

**为什么不用固定字节数切**：直播是持续的 H.264 tag 流，按字节切会切在 P 帧中间，导致段首花屏、无法独立播放。只有按时间 + 关键帧对齐才能保证每段都能直接播放。

**实际建议**：
- 拉国内直播源、网络抖动多 → 用 `180`（3 分钟），减少断流损失
- 录制稳定长直播（会议、课程）→ 用 `600`（10 分钟），文件数少一半
- 只想留片段 → 用 `60`，配合 OpenList 的目录浏览很方便

改法：GitHub 仓库加 Variable `LIVE_SEGMENT_SECONDS`，或在 Cloady 环境变量里设。

> 注意：ffmpeg 的 `-segment_time` 是**目标值**，实际会在该时间点之后的第一个关键帧切分。若源的关键帧间隔是 2 秒，10 分钟段可能实际是 10 分 00 秒～10 分 02 秒，这是正常的。

### 关键：ffmpeg 自动重连（决定分段时长能否生效）

很多直播源会在固定间隔主动断开 HTTP 连接（典型现象是 ffmpeg 报
`Stream ends prematurely` 或 `Input/output error`）。若不处理，ffmpeg 一断就退出，
**segment 计时器随之归零**，于是每段被源站的断流节奏切成几十秒，
`-segment_time` 设多大都没用。

因此启动 ffmpeg 时必须带这几个参数：

```
-reconnect 1                 # 连接断开后自动重连
-reconnect_streamed 1        # 对流式输入也启用重连
-reconnect_delay_max 5       # 重连最大等待 5 秒
-reconnect_at_eof 1          # 遇到 EOF 也尝试重连
```

加上之后 ffmpeg 在同一进程内续传，segment 计时器持续累加，分段时长才按设置走。
外层的 `while` 循环只作为兜底：当 ffmpeg 连重连都失败、进程真的退出时才重启。

### 分段去重

重连或重启时，ffmpeg 会从 `-segment_start_number` 继续编号，可能生成与已有文件同名的段。
处理逻辑：

1. 若 ffmpeg 写出的文件名**恰好就是**目标文件名 → 直接采用，不做 rename
2. 若目标文件**已存在且有内容** → 判定为重复段，删除新产物并跳过，不重复上传
3. 只有文件名不同且目标不存在时，才执行 rename

这避免了「同一段被上传两次」以及 `rename` 自己到自己静默失败导致的计数错乱。

### 为什么分段后不合并

合并成一个大文件有两个实际坏处：

1. **中断损失大** —— 录制 3 小时后进程挂掉，未合并的分段全在，合并后的半成品可能损坏
2. **上传必须等全部结束** —— 5 小时的直播要等 5 小时才开始上传，期间磁盘要一直扛住

分段 + 边录边传的方案下，第 1 段录完 10 秒内就上云并从本地删除，磁盘占用恒定在 1～2 段的大小。

### 断点续传

HTTP 分片下载会把已完成分片记在 `<file>.parts/` 目录，重启后自动跳过已完成部分。单流下载用 `.part` 后缀文件记录进度。

### 上传：分片协议（大文件不受 413 限制）

OpenList 的 `PUT /api/fs/put` 是**单请求上传**，请求体受 Cloudflare 上限约束——
实测超过约 130MB 会被直接挡回 `413 Payload Too Large`（返回 HTML 错误页，
请求根本没到 OpenList）。

因此上传优先走 **resumable multipart 协议**，把文件切成 10MB 一片逐片上传：

```
POST /api/fs/multipart/init
  必需头：File-Path（URL 编码的完整路径）、X-File-Size、X-Chunk-Size、
          Last-Modified、Content-Type、Overwrite
  返回：{ upload_id, chunk_size, total_chunks, received }

PUT  /api/fs/multipart/chunk
  必需头：X-Upload-Id、X-Chunk-Index
  请求体：该片的原始字节

POST /api/fs/multipart/complete
  必需头：X-Upload-Id
```

**踩坑记录**：少传任何一个头都会失败，而且错误信息有误导性——
只给 `X-File-Size` 会返回 `storage not found; please add a storage first`，
看起来像存储没挂载，实际是缺 `File-Path` 和 `X-Chunk-Size`。

实测 150MB 文件切成 15 片，19 秒传完，complete 后远端大小与本地一致。

服务端或存储驱动不支持分片时（`init` 返回 404/405 或 `data:null`），
自动回退到单请求 `PUT`，但那条路径仍受 130MB 限制。

### 进度统计

直播的总大小未知，进度条显示已下载字节数和已录段数（不确定态）；普通文件按 `已下载 / Content-Length` 计算百分比。

## 已知限制

- Cloady 免费额度：0.5 CPU / 1 GB 内存 / 5 GB 存储。大文件需注意磁盘余量。
- DASH（`.mpd`）暂不支持。
- RTMP 录制依赖 ffmpeg，且 `-c copy` 不做转码，源编码不兼容时可能失败。

## License

MIT
