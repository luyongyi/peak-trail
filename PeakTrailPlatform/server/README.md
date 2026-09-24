# PeakTrail live relay（v1）

零依赖 Node 服务器：接收游戏内 PeakTrailRecorder 的实时推送，按"同一局合并为一条流"去重，
并向浏览器观众开放 SSE 实时流。**v1 信任模型：4 位 run 码是唯一凭证**，适合测试与受控部署；
公网开放前请阅读下文"安全边界"。

## 运行

```powershell
node PeakTrailPlatform/server/live-server.mjs --port 8787 [--host 127.0.0.1] [--dir <持久化目录>]
```

- 默认只绑 `127.0.0.1`。`--host 0.0.0.0` 对公网开放时会打印警告。
- `--dir` 可选：把收到的记录按 run 追加写入 NDJSON 文件（不做重放加载）。
- 状态页：`/`；观看页：`/watch/<code>`（原生 EventSource，无需构建）。

## 工作方式

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

## 主查看器接入

查看器页面（`node tools/serve-site.mjs`）左侧"实时直播"行填中继地址（如
`http://192.168.50.131:8787`）→ 连接 → 自动列出活跃 run 并接入当前最新的一局。
地图按 manifest 的 build/mapSlot 自动匹配内嵌地图包，头像/体力卡/事件列表与普通回放
完全一致；"跟随最新位置"勾选时播放头始终贴住直播边缘，取消勾选可回拖（数据仍持续接收）。
多生产者的 `t` 已由中继归一到房间时钟（`localT` 保留原值），回放时间线是全队一致的。

## 安全边界（公网部署前必读）

### 当前个人服务器部署

- 网页与直播共用 `https://peak.mylus.cn`；HTTPS 网页默认连接同源 `/api/`，不访问公网 `8787`。
- 中继保持 `--host 127.0.0.1 --port 8787`，由 nginx 转发 `/api/`；SSE 需要 `proxy_buffering off` 和较长读取超时。
- Recorder 0.7.1 的 `Live.ServerUrl` 默认改为 `https://peak.mylus.cn`。已有 BepInEx 配置不会被默认值覆盖，需要手动更新这一项；`Live.Enabled` 仍由用户控制。
- 按当前部署选择，不增加账号或口令登录：网页可以列出活跃对局，知晓网址的人可观看直播。4 位码是房间标识，不是可靠访问控制。
- 不启用 `--dir`，中继只在内存暂存；本地历史足迹不会自动上传。进程重启清空当前直播缓存。

### 原有边界与可选加固

- **码即凭证**：31⁴ ≈ 92 万种组合，可被穷举。v1 请置于反向代理（Caddy/nginx）的
  访问控制之后（basic auth / IP 白名单 / mTLS），或只对小圈子开放。
- **流内容是敏感的**：实时位置 + 真实 SteamID + 昵称（与离线录制文件同一隐私等级，
  见根 README 的 consent 约定）。`Enabled` 在 mod 侧默认 **关闭**。
- 记录者上传的是**全队**的数据：直播间可见的每一个人都在被实时展示。对局内提示、
  观众 ACL、匿名化（`memberKey`）与 revoke 是下一版的内容（见设计文档）。
- 服务器为内存态：进程重启即清空；`--dir` 只做追加落档，不自动重载。
