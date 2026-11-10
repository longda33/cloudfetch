# CloudFetch ☁️

云端下载器：粘贴链接 → 实时进度 → 自动上传 OpenList → 删除本地文件。

部署在 [Unikraft Cloud](https://unikraft.com) 上，也可本地 / Docker 自托管。

## 特性

- **多种链接类型**
  - HTTP 直链（支持 Range 分片并行 + 断点续传）
  - HLS / m3u8（自动选最高码率，分片并发下载后拼接；**AES-128 加密流与 fMP4 走 ffmpeg**）
  - DASH / mpd（交给 ffmpeg 处理 SegmentTemplate、音视频分离与 init 段）
  - HTTP-FLV 直播流（自动识别，按时间分段录制）
  - RTMP 直播（经 ffmpeg 录制）
- **直播按时间分段**：默认 5 分钟一段，每段先存 R2、传完即删本地；整场录完后由 Actions 合并成一个 MP4
- **强重试**：连接超时、空闲超时、分片失败、上传失败全部带指数退避重试
- **实时进度**：SSE 推送，Web 面板显示速度 / 百分比 / 剩余时间 / 已录段数
- **自动上云**：分段存 R2，最终 MP4 落到 OpenList，本地不长期占盘
- **可选 MP4 转码**：整场 FLV 经 Cloudflare R2 中转，由 GitHub Actions（4 核）合并转成 H.264 MP4 再传回 OpenList

## 转码链路（可选）

```
Unikraft 录制 FLV（5 分钟一段）
   ↓ 每段 PUT 到 Cloudflare R2，成功后删本地（转码开启时不再往 OpenList 传原始 FLV）
   ↓ 整场录完，workflow_dispatch 一次，传 R2 对象键列表（不传文件）
GitHub Actions（ubuntu-24.04，4 核）
   ↓ 逐段从 R2 下载 → concat 合并 → 封装成 MP4 → faststart
   ↓ 分片上传 MP4 到 OpenList
   ↓ 成功后才删掉 R2 里的源文件（失败保留，供重试）
Unikraft 定期轮询 OpenList
   ↓ 真的看到 MP4 才把任务标成「已完成」
```

**两种输出方式**（表单里可切，默认 `remux`）：

| 方式 | 做法 | 耗时 | 代价 |
|---|---|---|---|
| `remux`（默认） | 纯 `-c copy` 重新封装 | 秒级 | 源里坏掉的帧率（`r_frame_rate=1000/1`）会原样带进 MP4，PotPlayer 拖不动进度条 |
| `cfr` | 重编码成恒定帧率 | 2 小时直播约 25 分钟 | 画质有损、占用 Actions 分钟数 |

默认选 `remux`：长直播用 `cfr` 容易撞 Actions 超时（曾出现跑 5 小时只到 45%），
而 `remux` 是秒级且字面无损。遇到拖不动进度条的播放器，在表单里切 `cfr` 重下即可。

**为什么合并后统一转**：每段单独转再拼，接缝处时间戳跳变、拖动会卡；一次转码还能重新分配码率，
体积更小，Actions 分钟数也只花一次。3 小时直播 = 36 段，逐段触发就是 36 次 Actions。

**为什么要轮询确认**：`workflow_dispatch` 返回 204 只代表"已排队"。如果直接当成完成，
Actions 失败时就会出现「任务显示已完成、本地已删、网盘里没有文件」的假成功。
现在只有确认 MP4 落地才写 `remotePath`，超时（默认 380 分钟，比 workflow 的 350 分钟更长）
则标记「转码失败」，历史记录里可以直接点「重新合并」——重试复用 R2 里的源文件，不需要重新录制。

**为什么不在 Unikraft 上转**：实例只有 1 vCPU，转 30 分钟 1080p 要跑半小时以上，
而且转码期间录制会被拖慢。GitHub Actions 免费给 4 核，公开仓库分钟数无限。

**为什么用 R2 中转而不是 GitHub**：GitHub 仓库单文件 100MB、LFS 免费只有 1GB，
一段直播就爆了。R2 免费 10GB，S3 兼容，国内访问也正常。

配置见 `.env.example` 的「转码链路」段。全部留空则自动关闭，行为退回「FLV 直接传 OpenList」。

需要在 GitHub 仓库配置这些 Secrets：

| Secret | 说明 |
|---|---|
| `OPENLIST_URL` | OpenList 地址 |
| `OPENLIST_TOKEN` | OpenList 令牌 |
| `R2_ACCOUNT_ID` | Cloudflare 账户 ID |
| `R2_ACCESS_KEY_ID` | R2 API Token 的 Access Key |
| `R2_SECRET_ACCESS_KEY` | R2 API Token 的 Secret |
| `R2_BUCKET` | 桶名 |


## 快速开始

### 本地运行

```bash
npm install

# 方式一：直接用环境变量启动
PANEL_PASSWORD=your-password npm start

# 方式二：用 Node 内置的 .env 支持（Node 20.6+，注意本项目不自动读取 .env）
cp .env.example .env      # 按需修改
node --env-file=.env src/server.js

# 打开 http://localhost:3000
```

需要 Node 20+。**以下场景需要系统装有 `ffmpeg`**：RTMP 录制、DASH（`.mpd`）、
HLS 加密流（`EXT-X-KEY`）、HLS fMP4（`EXT-X-MAP`）。普通直链与未加密 HLS 不依赖 ffmpeg。

跑测试：

```bash
npm test        # 单元测试（认证 / 写流 / 链接解析 / 配置）
npm run check   # 语法检查
```

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
| `PANEL_PASSWORD` | 面板访问密码。**留空时拒绝所有访问**（fail-closed） | 空 |
| `SESSION_SECRET` | 会话签名密钥。留空则随机生成（重启后需重新登录） | 随机 |
| `DATA_DIR` | 下载临时目录 | `/tmp/cloudfetch` |
| `MAX_FILE_SIZE` | 单文件上限（字节） | 20 GB |
| `MAX_CONCURRENT` | 最大并发任务数 | `2` |
| `MAX_QUEUE` | 队列上限（排队 + 运行中） | `100` |
| `OPENLIST_URL` | OpenList 站点地址 | 空 |
| `OPENLIST_TOKEN` | OpenList API 令牌 | 空 |
| `OPENLIST_UPLOAD_DIR` | 上传目标目录 | `/cloudfetch` |
| `DELETE_AFTER_UPLOAD` | 传完删本地 | `true` |
| `RETRY_MAX_ATTEMPTS` | 最大重试次数 | `8` |
| `IDLE_TIMEOUT` | 空闲多久判定卡死（毫秒） | `60000` |

> `SESSION_SECRET` 不再有硬编码默认值。旧版本用一个写死的字符串做 HMAC 密钥，
> 而签名算法是公开的，等于只要知道仓库内容就能伪造会话。现在没配置就随机生成，
> 代价只是重启后需要重新登录一次。

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

默认 **300 秒（5 分钟）**。这是权衡后的推荐值，理由如下：

| 时长 | 单段大小（4Mbps 码率） | 优点 | 缺点 |
|---|---|---|---|
| 60 秒 | ~30 MB | 断流损失最小；上传最快 | 文件太多（1 小时 = 60 个） |
| **300 秒** | **~150 MB** | **切段失效时也不会撑爆 1GiB 持久卷**；1 小时 12 个文件 | — |
| 600 秒 | ~300 MB | 文件数更少 | 切段失效时单段可能到 900MB |
| 1800 秒 | ~900 MB | 文件极少 | 切段失效时实测出现过单段 933MB，直接把卷撑满 |

`ffmpeg` 的 segment muxer 只在关键帧处切分。直播源长时间不推关键帧时，
`-segment_time` 不会触发，段会一直长下去 —— 所以段长本质上是在给这个
「切段失效」留余量。5 分钟一段时，就算失效 3 倍也只有 150MB。

**为什么不用固定字节数切**：直播是持续的 H.264 tag 流，按字节切会切在 P 帧中间，导致段首花屏、无法独立播放。只有按时间 + 关键帧对齐才能保证每段都能直接播放。

**实际建议**：
- 卷比较小（1GiB）或源站关键帧间隔很长 → 保持 `300` 或更小
- 录制稳定长直播、卷有 10GiB 以上 → 可以用 `600`，文件数少一半
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

### 为什么录制时不分段合并、而是录完再合并

录制过程中**不合并**，有两个实际坏处：

1. **中断损失大** —— 录制 3 小时后进程挂掉，合并后的半成品可能损坏
2. **上传必须等全部结束** —— 5 小时的直播要等 5 小时才开始上传，期间磁盘要一直扛住

所以录制阶段保持「5 分钟一段、边录边传 R2、传完删本地」，磁盘占用恒定在 1～2 段。
真正的合并放在整场结束之后，由 GitHub Actions 做（`concat` + 一次转码），
本地和实例都不承担合并的开销；合并失败时所有分段还在 R2 里，可以只重试合并，不用重录。

如果缺了某一段，**不会**照常合并——少几段拼出来的 MP4 能正常播放但内容中间是断的，
比直接失败更难发现。这种情况会标成「合并失败」，补齐后点「重新合并」即可。

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
- DASH / 加密 HLS / fMP4 依赖 ffmpeg，且**不支持 DRM**（Widevine / FairPlay 等），遇到会以 ffmpeg 报错结束。
- RTMP 录制依赖 ffmpeg，且 `-c copy` 不做转码，源编码不兼容时可能失败。
- 单请求上传受 Cloudflare 约 130MB 限制，超大文件依赖分片上传协议（见上）。

## License

MIT
