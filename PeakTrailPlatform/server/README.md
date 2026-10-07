# PEAK 回忆录服务

默认提供回忆录轨迹上传、路线与热力图、每日地图与部署健康检查，见 [trajectory-v1 运行、上传、审核与查询](trajectory-README.md)。旧足迹直播暂时下线：`/api/runs` 及所有子接口、`/watch` 返回 `410 legacy-live-disabled`，不接收或展示旧直播记录；旧存储保留，不读取或删除。

直播实现仅用于将来恢复或本地兼容测试。必须显式传入 `--legacy-live`（程序调用时为 `legacyLiveEnabled: true`）才会接收 PeakTrailRecorder 实时推送并开放 SSE；该选项不影响回忆录轨迹接口。**旧直播 v1 信任模型：4 位 run 码是唯一凭证**。

## 运行

```powershell
node PeakTrailPlatform/server/live-server.mjs --port 8787 --routes-dir <回忆录轨迹私有目录> [--host 127.0.0.1]
```

- 默认只绑 `127.0.0.1`。现有部署不传 `--legacy-live`，旧接口默认关闭。
- `--dir` 仅在显式恢复旧直播时生效；默认模式不会创建此目录或写入旧 NDJSON。
- 默认 `/` 为简单回忆录服务说明，不展示旧对局列表；网站的旧 `guide.html` 与独立 `routes.html` 发布为回首页的下线页。

## 保留的旧直播工作方式（仅显式启用后）

1. **run 码**：录像端从房间共享的 `RunManager.RunId` 派生 4 位码
   （`server/run-code.mjs` ↔ `PeakTrailRecorder/RunCode.cs`，跨语言向量锁定在
   `tests/LiveContract` 与 `tools/tests/live-server.test.mjs`）。同一局的每个装 mod
   客户端推导出**同一个码**。
2. **确认**：`POST /api/runs {code, runId, manifest}` —— 服务器重算派生以确认码与
   runId 匹配；同 runId 再次注册直接合并进既有 run；不同 runId 撞码返回 409，
   录像端按确定性序号尝试下一个码（全队自动收敛，无需协调）。
3. **上传**：`POST /api/runs/:code/records?producer=<本机playerId>`，body 为 NDJSON
   （与离线 `stream.ndjson` 同一条记录 schema，信封额外带 `roomTs`）。
4. **去重**：键为 `type|playerId|roomTs`。`roomTs` 是 Photon 房间共享时钟——同一帧
   被多个队友各自记录时，先到者入库，后到者计为重复。缺 `roomTs` 时键退化为
   `producer|t`（永不跨生产者去重，宁多勿错）。
5. **观看**：`GET /api/runs/:code/stream?after=SEQ`（SSE）。先发 `hello`
   （manifest + 全队最新快照），再回放/推送 `record` 事件；`snapshot` 端点可单独取快照。

## 接口一览

| 方法/路径 | 说明 |
| --- | --- |
| `GET /api/health` | 部署健康检查，仅返回 `{ok:true,service:"peak-trail-live"}`，不含对局或玩家信息 |
| `POST /api/runs` | 注册/确认 run（code+runId 校验，409=撞码重试下一序号） |
| `POST /api/runs/:code/records` | NDJSON 批量上传（≤500 行/批，≤1 MB，120 批/分钟） |
| `GET /api/runs` | 活跃 run 列表（含生产者/观众/去重计数） |
| `GET /api/runs/:code` | 单 run 元数据与 manifest |
| `GET /api/runs/:code/snapshot` | 每玩家最新 sample/state/inventory/appearance/status |
| `GET /api/runs/:code/stream` | SSE：hello(快照) → record(增量)，15s 心跳，断线用 `after` 续传 |

内存上限：每 run 2 万条环形（约 6 人 10 分钟，超出丢弃最旧并计数）、3×10⁵ 去重键（FIFO）、
200 个 run、每 run 50 观众。run 在最后上传 30 秒后进入宽限，无观众即回收。

## 测试

```powershell
node --test PeakTrailPlatform/tools/tests/live-server.test.mjs
```

覆盖：码校验/合并/撞码回退、跨生产者去重（含缺 roomTs 退化）、坏行隔离、快照、SSE 回放+实时。

## 保留的旧主查看器接入说明

以下为旧实现说明；当前网页已关闭旧足迹、导入旧日志与直播入口。恢复旧查看器时，左侧"实时直播"行填中继地址（如
`http://192.168.50.131:8787`）→ 连接 → 自动列出活跃 run 并接入当前最新的一局。
地图按 manifest 的 build/mapSlot 自动匹配内嵌地图包，头像/体力卡/事件列表与普通回放
完全一致；"跟随最新位置"勾选时播放头始终贴住直播边缘，取消勾选可回拖（数据仍持续接收）。
多生产者的 `t` 已由中继归一到房间时钟（`localT` 保留原值），回放时间线是全队一致的。

## 安全边界（公网部署前必读）

### 当前个人服务器部署

- 回忆录网页和 API 共用 `https://peak.mylus.cn`；旧直播 API 默认返回 410。
- 服务保持 `--host 127.0.0.1 --port 8787`，由 nginx 转发 `/api/`；保留的 SSE 配置仅在显式恢复旧直播后使用。
- Recorder 0.7.1 的 `Live.ServerUrl` 默认改为 `https://peak.mylus.cn`。已有 BepInEx 配置不会被默认值覆盖，需要手动更新这一项；`Live.Enabled` 仍由用户控制。
- 当前部署不启用旧直播；以下四位码边界只适用于显式恢复该功能后。
- 当前模式不读取或写入旧直播存储。本地历史足迹和录像不会自动上传。

### 原有边界与可选加固

- **码即凭证**：31⁴ ≈ 92 万种组合，可被穷举。v1 请置于反向代理（Caddy/nginx）的
  访问控制之后（basic auth / IP 白名单 / mTLS），或只对小圈子开放。
- **流内容是敏感的**：实时位置 + 真实 SteamID + 昵称（与离线录制文件同一隐私等级，
  见根 README 的 consent 约定）。`Enabled` 在 mod 侧默认 **关闭**。
- 记录者上传的是**全队**的数据：直播间可见的每一个人都在被实时展示。对局内提示、
  观众 ACL、匿名化（`memberKey`）与 revoke 是下一版的内容（见设计文档）。
- 服务器为内存态：进程重启即清空；`--dir` 只做追加落档，不自动重载。
