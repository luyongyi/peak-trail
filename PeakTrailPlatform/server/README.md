# PEAK 回忆录与直播服务

默认提供回忆录轨迹上传、路线与热力图、每日地图与部署健康检查，见 [trajectory-v1 运行、上传、审核与查询](trajectory-README.md)。旧足迹直播暂时下线：`/api/runs` 及所有子接口、`/watch` 返回 `410 legacy-live-disabled`，不接收或展示旧直播记录；旧存储保留，不读取或删除。

旧直播实现仅用于本地兼容测试。必须显式传入 `--legacy-live`（程序调用时为 `legacyLiveEnabled: true`）才会接收旧版 PeakTrailRecorder 实时推送并开放 v1 SSE；该选项不影响回忆录轨迹接口和新直播 v2。**旧直播 v1 信任模型：4 位 run 码是唯一凭证**。

## 新匿名直播 v2

默认同时提供 `/api/live/v2`，无账号登录，也无公开房间列表。Recorder 0.8.0 用 `POST /api/live/v2/sessions` 注册单推流源；服务端返回随机 `watchId` 和独立 `publishToken`。发布端以 Bearer 凭证调用 `/sessions/:sessionId/records`、`/heartbeat`、`/end`，观众只用 `/watch/:watchId` 与 `/watch/:watchId/stream`（SSE）。**观战链接不能发布数据**，读接口不返回发布凭证、原始房间 ID 或平台用户 ID。

服务端另分配四位大写 `watchCode`，使用 `ABCDEFGHJKLMNPQRSTUVWXYZ`（不含 I/O）随机生成，冲突最多重试 32 次。注册成功仍为 `201`；成功响应和待命端的 `409 publisher-active` 都带同一场的码，重注册及租约接管不换码。`GET /api/live/v2/codes/:code` 在直播或断线重连宽限期返回 `{watchCode,watchId,watchPath,status}`，不返回发布凭证；格式错误、未知码和已结束会话均为 `404 unknown-watch-code`。该入口每 IP 每分钟最多 30 次，成功和失败查询都计数，超限返回 `429 rate-limited` 与 `retryAfterMs:60000`，不占用旧长链接的读取额度。

短码只便于输入观战，不能发布，也不提供长随机链接同等的防猜测能力。结束即停止短码解析，码仍保留至会话清理以免立即指向另一场；原 `/?watch=<watchId>` 长链接及结束快照照常保留。观战元数据与 SSE `hello` 带 `watchCode`，结束后为 `null`。没有公开房间列表或短码列表接口。

机场阶段可先 `POST /api/live/v2/reservations {roomKey,clientId}` 预约：`roomKey` 是同一 Photon 机场房间的 64 位小写散列，`clientId` 是本发布端的 32 位小写随机 ID。首次预约和同 owner 重试均返回 `201`，字段沿用注册响应并增加 `status:"waiting"`、`epoch:0`、`manifest:null`；序号均为 0。四位码和旧长链接立即可访问，但元数据和 SSE `hello` 只给等待状态、空快照与空 manifest，网页此时不得加载假地图。别的发布端在有效租约内收到 `409 publisher-active`，含同一 session/watch/code、status 和 epoch，不含 token。预约与直接开播共用唯一短码索引、创建限流和会话配额，不存在单独可枚举的预约列表。

进入真实对局后，由预约 owner 以原 Bearer 凭证调用 `POST /api/live/v2/sessions/:sessionId/activate {roomKey,manifest}`；这里的 `roomKey` 为正式对局散列，manifest 必须通过既有直播验证。持久化完成后返回 `200` 注册响应，将状态升级到 `live`、epoch 1，sessionId/watchId/watchCode/publishToken 全部保留，并向已经等待的 SSE 观众发一次真实 manifest 的 `hello`。完全相同的激活重试返回现有序号，不再次写入、重置快照或发 hello。已激活后更换 roomKey/manifest 返回 `409 activation-conflict`；正式对局已有另一未结束发布者则返回 `409 run-room-active`，保留当前预约，不抢占或合并另一直播。

机场房间索引保留至会话结束，包括已经激活的阶段。新版发布端始终先调用 `/reservations`，避免较早加载完成的待命端另开一场：同 owner 重试仍返回现有直播；租约过期后新 owner 在同一个预约接口接管，等待阶段保持 epoch 0，已经开播则复用已验证 manifest 并按现有规则进入新 epoch，两者都保留观战码并轮换 token。等待时复用 `/heartbeat` 与 `/end`，心跳保持 `waiting`；`/records` 返回 `409 session-not-active`。15 秒租约、60 秒失联结束、24 小时最大生命周期（从预约创建起算）、结束后 15 分钟保留沿用原规则。取消或超时且从未激活的长链接终态为 `ended`、epoch 0、null manifest、空快照；短码即时变 404，并隔离至清理。退出机场、关闭直播或返回机场准备新一局时，发布端应主动结束旧会话再预约。旧 `/sessions` 直接注册接口仍兼容原客户端。

仅成功 owner 注册/激活响应另带私有 `runRoomKey`：等待时为 null，激活后为正式对局散列。发布端必须核对它与当前真实对局一致才发送轨迹；若旧场结束请求丢失、预约误接管了旧场，应先结束旧会话再预约，不能把新场记录送入旧 manifest。该字段和散列不出现在 409 待命响应、观战元数据、SSE、短码解析或 WAL 中。

租约为 15 秒，建议每 5 秒心跳；失联 60 秒或持续 24 小时结束，结束后保留 15 分钟供观看，观众不延长生命周期。过期租约接管保留观战链接、更新 epoch 并作废旧凭证；SSE 用 epoch 与 seq 续传，过旧游标重置为有界的最新状态及近期路径快照。`summit`、各 `nadir-*`、`nadir`、`native-checkpoint` 和 `run_end` 另按事件、玩家和关卡保留最新里程碑，路径窗口淘汰不会使新观众漏掉这些状态；这不改变个人通关的证据要求。生产 nginx 的通用 `/api/` 转发和关闭 SSE 缓冲即可沿用。

道具只记录 `event:"item-use"`（实际使用位置）与 `event:"item-spawn"`（实际生成位置）两个事件，均须带 `id`、`pos`（米）和现有白名单 `item`，可带同一次动作的 `actionId`；两种 ID 均为 64 位小写 SHA256。不能证明归属时省略 `playerId`，不以附近玩家或人物坐标猜生成点。`hello` 只保留最近 128 个道具事件，仍受全部最新状态合计 128 KiB 和快照预算约束；全程历史由下面的持久通道承接。生成点是静态记录，不包含物体旋转、后续移动、消耗或生命周期状态。

### 直播路径持久化

生产 v2 必须配置 `--routes-dir`（或 `PEAK_TRAJECTORY_DIR`）。服务在其私有 `live-archive/<sessionId>.wal` 追加路径事务：注册、epoch 接管、接收记录和结束先写入并完成文件 fsync，再返回成功或广播 SSE；新文件还同步父目录。元数据和 `hello` 的 `persistence:"durable"` 明确表示此模式。没有私有目录时注册返回 `503 live-archive-unconfigured`，不悄悄降级；只有程序化测试可显式设 `liveV2.memoryOnly:true`，读接口会标明 `persistence:"memory"`。`--dir` 仍仅影响旧 v1。

WAL 保留匿名参与者、坐标/朝向/关卡、原生路线、生死和事件的白名单投影，省略背包、外观、体力和一般事件的物品明细；仅 `item-use` / `item-spawn` 额外保留经过直播白名单验证的 `item/id/actionId`。不保存 roomKey、clientId 或 publishToken。每个事务记录 session/epoch、连续的服务端 seq 和 producerSeq 范围，即使该批只有被省略的内容也保存空投影事务。同一 session 的写入、接管和结束串行；已接受的 producerSeq 重传不追加第二份。不同 epoch 的 p1 不作为同一人拼接，WAL 不从全队 activeSegment、直播断开或 `run_end` 猜测个人通关。

预约首先写 `reserve`（epoch 0、null manifest），等待接管写 `reservation-claim`，首次进图写 `activate`（epoch 1、真实 manifest），取消可以直接接 `end`；这些事务同样先 fsync 再确认，尚未激活时禁止 batch。原有 `open/epoch/batch/end` 档案仍可校验。预约/激活与直接注册使用同一注册锁，并与 session 内写入/结束串行，只有持久化成功才更新房间索引、身份或 SSE。预约也不保存机场房间散列、客户端 ID 和发布凭证；心跳只续当前进程租约，不恢复重启前的身份。

启动后第一次写入先流式校验已有 WAL 的 SHA256、事务和序号连续性，仅截去未以换行结束的半条尾事务；完整但损坏的事务、非普通文件和不安全路径均阻止新写入。写入或 fsync 出错后本进程继续拒绝写入，需管理员排查并重启恢复；可能完整写入但未确认的事务仍留在私有档案。重启不恢复旧 token 或直播会话，旧 session/watch 查询返回 404，客户端新建会话；旧路径档案保留。正常 SIGTERM/SIGINT 会等待进行中的持久化并追加结束事务。

Linux 目录/文件权限为 0700/0600；数据不放进静态站点、Git 或公共下载。WAL 独立限额为总计 2 GiB、单档 128 MiB、10,000 个文件、单事务 512 KiB，待写队列最多 16 操作/4 MiB；孤立文件也计入配额。达到限额返回 503，已确认前缀保留，不自动清理档案。直播内存会话的 15 分钟清理不会删除 WAL。`--routes-dir/.migration-maintenance` 存在时阻止 WAL 写入和尾部修复；迁移前仍须停止/排空已进入的请求，该标记不是跨进程锁。同一私有根只允许一个服务写入。Windows 本地测试执行文件 fsync；生产 Linux 额外执行目录 fsync。

WAL 是私有兜底，不直接生成公开路线或热力。Recorder 同时在本地持久记录原生 10 Hz 精简轨迹，在切关、个人 checkpoint 和结束封存累计前缀，补交 `/api/route-uploads`。正式历史管线使用可靠的 run/player 作用域、共享时钟、地图对齐及个人状态证据；按原审核规则提供完整路线/热力或部分预览。网络失败时客户端保留本地待上传包，服务端不把近期 SSE 窗口当作全程档案。两条通道的区别、Nadir 和审核规则见 [历史轨迹协议](trajectory-README.md)。

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

## 保留的旧接口一览（仅显式启用后）

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
node --test PeakTrailPlatform/tools/tests/live-server.test.mjs PeakTrailPlatform/tools/tests/live-v2-api.test.mjs PeakTrailPlatform/tools/tests/live-wal.test.mjs PeakTrailPlatform/tools/tests/live-reservations.test.mjs
```

覆盖：旧协议兼容、匿名权限与短码、序号重传/接管、快照淘汰和慢观众预算；真实临时私有目录验证 fsync 前不确认/广播、持久化投影、重启和半尾恢复、损坏拒写、维护标记、配额、重试去重与关闭排空。

## 保留的旧主查看器接入说明

以下为旧实现说明；当前网页已关闭旧足迹、导入旧日志与直播入口。恢复旧查看器时，左侧"实时直播"行填中继地址（如
`http://192.168.50.131:8787`）→ 连接 → 自动列出活跃 run 并接入当前最新的一局。
地图按 manifest 的 build/mapSlot 自动匹配内嵌地图包，头像/体力卡/事件列表与普通回放
完全一致；"跟随最新位置"勾选时播放头始终贴住直播边缘，取消勾选可回拖（数据仍持续接收）。
多生产者的 `t` 已由中继归一到房间时钟（`localT` 保留原值），回放时间线是全队一致的。

## 安全边界（公网部署前必读）

### 当前个人服务器部署

- 回忆录网页和 API 共用 `https://peak.mylus.cn`；旧直播 API 默认返回 410。
- 服务保持 `--host 127.0.0.1 --port 8787`，由 nginx 转发 `/api/`；SSE 配置同时服务新直播 v2。
- Recorder 0.7.1 的 `Live.ServerUrl` 默认改为 `https://peak.mylus.cn`。已有 BepInEx 配置不会被默认值覆盖，需要手动更新这一项；`Live.Enabled` 仍由用户控制。
- 当前部署不启用旧直播；以下四位码边界只适用于显式恢复该功能后。
- 当前模式不读取或写入旧直播存储。新 v2 使用上述私有 WAL；Recorder 的新原生路线通道按封存前缀自动补交精简轨迹，不上传 `.peakrun` 原始录像。

### 原有边界与可选加固

- **码即凭证**：31⁴ ≈ 92 万种组合，可被穷举。v1 请置于反向代理（Caddy/nginx）的
  访问控制之后（basic auth / IP 白名单 / mTLS），或只对小圈子开放。
- **流内容是敏感的**：实时位置 + 真实 SteamID + 昵称（与离线录制文件同一隐私等级，
  见根 README 的 consent 约定）。`Enabled` 在 mod 侧默认 **关闭**。
- 记录者上传的是**全队**的数据：直播间可见的每一个人都在被实时展示。对局内提示、
  观众 ACL、匿名化（`memberKey`）与 revoke 是下一版的内容（见设计文档）。
- 服务器为内存态：进程重启即清空；`--dir` 只做追加落档，不自动重载。
