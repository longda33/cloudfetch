# Unikraft 迁移验证

这个目录是**可行性验证**，不影响现有 Cloady 部署。

## 结论：5/5 通过 ✅

2026-11-07 在 `fra` metro 实测：

```
host=(none) arch=x64 cpus=1 mem=978MB
[PASS] runtime: node=v20.20.2 | ffmpeg version 5.1.9-0+deb12u1
[PASS] volume: 写入回读一致=true 可用=973MB 挂载点=/data
[PASS] spawn: 输出="spawn-ok"
[PASS] network: 下载 19.1MB / 0.34s = 476.2 Mbps
[PASS] ffmpeg-encode: 生成 1892 字节
=== 汇总: 5/5 通过 ===
```

实例：`cf-probe`，公网 `https://falling-morning-6fm16s7e.fra.unikraft.app`

## 带宽：没有限制

| 方向 | 实测 |
|---|---|
| 下行 | 163.4 / 159.9 / 175.4 Mbps |
| 上行 | 87.6 / 157.5 Mbps |
| 镜像内实测 | **476.2 Mbps** |

直播源只需 2.7 MB/s（约 22 Mbps），余量充足。

## 三个关键约束（都是踩出来的）

### 1. 必须用完整 OCI URL，不能传镜像 uuid

```
oci://unikraft.io/official/node:latest   ✅ 能跑
e4ede5cb-8495-45b1-...                   ❌ 59ms 就退出
```

传 uuid 会被平台拼成 `oci://unikraft.io/official/<uuid>:latest`，指向不存在的镜像。

### 2. node 官方镜像不能挂持久卷

```
node + volume → Init function failed with error -19 (ENODEV)
```

node 的 `base-compat` 运行时**没有 ext4 块设备驱动**。debian 镜像有：

```
debian + volume → lost+found 可见，读写正常
```

**所以必须基于 debian 构建自定义镜像。**

### 3. 构建必须有本地 BuildKit

```
error: buildkit not found; please start a docker or buildkit daemon, or set BUILDKIT_HOST
```

`unikraft images build` 不是云端构建，它依赖本地 BuildKit。
GitHub Actions 用 runner 自带的 Docker 提供。

## 镜像体积注意

ffmpeg 一个包就 488MB（含 libllvm15 等依赖），加上 Node 约 100MB，
rootfs 会到 600MB 左右。文档说 rootfs 上限 1-2GB 且**常驻内存**，
当前 1GiB 内存能跑，但内存预算要留意。

如果后续吃紧，可以用 `ffmpeg` 的静态构建或裁掉不用的编解码器。

## 怎么用

### 构建（GitHub Actions）

```
gh workflow run unikraft-probe.yml --repo longda33/cloudfetch
```

需要两个 secret：

- `UNIKRAFT_TOKEN` — 已配置
- `UNIKRAFT_ORG` — 已配置为 `panpp123`

### 部署

```bash
./deploy-probe.sh fra
```

脚本会：建卷（如无）→ 删旧实例 → 部署 → 拉日志 → 输出公网地址。

### 看结果

```bash
unikraft instances logs cf-probe
curl https://<fqdn>/probe
```

## CLI 参数坑

几个容易写错的（已核对 v0.6.2）：

| 想做的事 | 正确写法 | 错误写法 |
|---|---|---|
| 关闭 scale-to-zero | `--scale-to-zero=policy=off` | `--no-scale-to-zero` |
| 等待 running | `instances wait --until state=running` | `--state running` |
| 强制删实例 | `instances delete --force` | `--yes` |
| 看日志 | `instances logs <name>` | `instances logs --metro fra <name>` |
| 挂卷 | `-v cfdata:/data` | 需要 `uuid` + `at`，不是 `mount_path` |

## 下一步

验证通过，可以接业务了。需要做：

1. 把 `src/` + `public/` + `package.json` 打进镜像
2. 临时目录改到 `/data/tmp`（rootfs 只读）
3. 关掉 scale-to-zero（长任务必须）
4. 历史记录可以存 `/data`，不一定还要 OpenList
5. 构建 + 部署流程接进 CI
