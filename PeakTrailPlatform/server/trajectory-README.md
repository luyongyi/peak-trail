# 历史轨迹收集（trajectory-v1）

本模块接收回忆录 Mod 在本地重新提取的小包。它不接收 `.peakrun`、录像资源、库存、状态条、音频或世界物件；直播接口保留原实现。新投稿默认 `pending`，不出现在公开查询中。

## 本地运行

```powershell
node PeakTrailPlatform/server/live-server.mjs --port 8787 --routes-dir C:/Users/lu452/Downloads/PeakTrail/local/trajectory-store
```

`--routes-dir` / `PEAK_TRAJECTORY_DIR` 必须指向静态站点之外的私有目录；未配置时新接口返回 `503 route-storage-unconfigured`。数据包含昵称和精简 XYZ，不能加入 Git、静态发布目录或游戏资源包。

## 上传协议

`POST /api/route-uploads`，`Content-Type: application/json`，`Content-Encoding: gzip`，可带 `X-Trajectory-Format: trajectory-v1`。

字段由 [trajectory-contract.mjs](trajectory-contract.mjs) 完整验证并重新构造，任何层级的未列明字段均拒绝；验证失败不会写投稿文件。协议为：

```text
format: trajectory-v1
recordingId: SHA256（64 位小写 hex）
runKey?: 共享对局 ID 的 SHA256
timeOriginMs?: 共享时间原点（-60 秒到 7 天）；没有时跨录像不合并
startedUtc: UTC ISO 时间
durationMs: <= 4 小时
sampleHz: 10
coordinateUnit: cm
map:
  buildId, scene: Level_N
  levelIndex?: 描述当时地图轮换；不用上传当天日图替代
  layoutKey?: 原生场景布局证据的 SHA256
  route: 按真实选择的关卡顺序排列的名字
  stages: [{index, name, enterZCm?, exitZCm?}]
difficulty: {ascent: 整数或 null, custom: bool 或 null, mini: bool 或 null}
players:
  [{key: 按 runKey/recordingId 作用域散列的玩家身份,
    name, owner: bool, evidence: native-state | legacy-unknown,
    points: [[tMs,xCm,yCm,zCm]],
    events: [{tMs,kind: join|leave|dead|revive|break|warp|finish,stageIndex?}]}]
```

最多 16 人；每人每 100 ms 桶最多一个真实点，不插值补点；整数厘米保留 XYZ。`stages` 必须连续编号且名字与 `route` 一致。原生关卡门限必须成对且 `exitZCm > enterZCm`；旧录像可以同时缺失。昵称仅在玩家头信息中写一次，同名玩家凭哈希 key 区分。

压缩请求上限 12 MiB，解压上限 64 MiB。gzip 解压、JSON 验证、关卡筛选、索引读取、聚合和大型响应编码都在 worker 中完成。HTTP 最多 4 个请求进入有界队列，worker 串行运行；同时最多接收一个上传；多余请求返回 429。每来源每分钟最多 20 次上传、120 次公开查询；`--trusted-proxy` 仅在已绑定 loopback 且受信反代设置 `X-Real-IP` 时启用。

成功返回 `201`（新包）或 `200`（重复包）：

```json
{"uploadId":"<canonical-payload-sha256>","duplicate":false,"moderationStatus":"pending","mapCompatibility":"waiting-map","mapPackId":null,"stages":[{"playerKey":"<sha256>","stages":[{"index":0,"completion":"complete","routeCount":1}]}]}
```

`completion` 为 `complete / partial / unknown`，按每个玩家独立计算。只有声明有原生状态证据、录到入口到出口、期间持续存活且没有缺口/传送的尝试才生成完整关路线。超过 1.5 秒采样缺口、异常位移、死亡、离开、warp/break 都中断当前尝试；队伍全局推进或 finish 不能替所有玩家补通关。入口容差 3 m 用于角色中心与原生平面的差异，半关开录不会成为完整路线。旧录像没有状态证据或门限时为 `unknown`，仍接受上传。

## 私有存储与审核

```text
PRIVATE_DIR/index/<uploadId>.json       小型索引与审核状态
PRIVATE_DIR/uploads/<uploadId>.json.gz  重建后的白名单轨迹
PRIVATE_DIR/routes/<uploadId>-pN-sN-aN.json.gz  完整个人关卡尝试
```

blob/route 文件先落盘，索引以原子创建提交；服务重启重新读索引。公开状态只来源于提交的索引，损坏条目不会重新获得审批。失败写入会清理本次拥有的新文件；异常退出的孤立文件也计入容量，不会绕过配额。总存储按实际私有目录字节限制 2 GiB，最多 10,000 投稿、100,000 条路线；达到上限返回 503，由管理员决定清理策略，不自动删除用户历史。

```powershell
node PeakTrailPlatform/server/route-admin.mjs --dir PRIVATE_DIR list
node PeakTrailPlatform/server/route-admin.mjs --dir PRIVATE_DIR approve UPLOAD_SHA256
node PeakTrailPlatform/server/route-admin.mjs --dir PRIVATE_DIR hide UPLOAD_SHA256
node PeakTrailPlatform/server/route-admin.mjs --dir PRIVATE_DIR reject UPLOAD_SHA256
node PeakTrailPlatform/server/route-admin.mjs --dir PRIVATE_DIR pending UPLOAD_SHA256
```

通过现有 SSH 管理身份执行，不提供公共审核写接口。公开查询每次读取当前审核状态，`hide/reject/pending` 在下一次请求中撤销路线及热力贡献。审核数据与站点部署版本分开保存，部署回滚不会回滚投稿状态。

内容 SHA 幂等防止重传；有共享对局、玩家 key 和共享时间原点时，重叠关卡尝试合并，优先采用 owner 观测及点数更多的记录。缺共享时钟时只在同一 `recordingId` 内去重；不同名字不作为不同人证据，同名也不合并不同 key。

游戏原生 `RunId` RPC 同步晚于录制启动时，共享时间原点可能为负（例如 -2000 ms）；原岸边坐标仍保留，不通过裁掉前段消除负值。点时间始终为录制内非负时间，跨生产者去重仅使用 `timeOriginMs + tMs`。

## 公开查询

| 路径 | 结果 |
| --- | --- |
| `GET /api/route-groups` | `{groups:[{id,map,mapCompatibility,mapPackId,difficulties,stageSummaries:[{index,name,routeCount}]}]}` |
| `GET /api/route-groups/:id/stages/:index/routes?difficulty=KEY&limit=200` | `{groupId,stageIndex,mapCompatibility,mapPackId,totalRouteCount,routes:[{id,playerKey,name,difficulty,points,breaks}],truncated,pointCount}` |
| `GET /api/route-groups/:id/stages/:index/heatmap?difficulty=KEY` | `{groupId,stageIndex,mapCompatibility,mapPackId,totalRouteCount,cellSizeCm:200,heightBandCm:200,cells:[[xIndex,yIndex,zIndex,count]],routeCount}` |

只有 `approved` 且个人关卡完整的数据进入公开结果。每次路线响应最多 200 条且最多 200,000 个点；达到任一上限会明确 `truncated:true`，不会把截断结果冒充全部统计。热力统计仍遍历该筛选条件下的完整有效路线，每条尝试在同一体素仅贡献一次；保留高度带，不把上下层混成一层；不会穿过不连续位移连线。格网最多 250,000 单元。

地图组依据录制的构建、场景、实际布局与分关信息，日期只是导航。目录存在对应 build/scene，且已有原生分支证据匹配时返回 `matched`；没有底图或证据冲突为 `waiting-map`。`mapPackId` 只标识用于显示的导出包，不作为统计组永久主键。

网页入口位于首页「进入地图」后的同一张 3D 地图内，提供「线路图层：仅地图 / 大家的路线 / 热力图」。客户端进一步核对当前 `mapPackId`、构建、场景、原生关卡顺序与终章分支，并且只选一个录制布局组；不能将多个同名场景布局自动混在一起。`waiting-map` 投稿仍保留、可以审核，但地图界面不会叠加其路线，也不会借用旧构建底图。选择具体关卡才查询该关路线和热力，「所有关概览」不造合计热力。这里只使用 GET，无直播轮询、SSE 或网页写入审核接口。

## 验证

```powershell
node --test PeakTrailPlatform/tools/tests/trajectory-server.test.mjs
```

包括真实 HTTP gzip 上传、白名单拒绝、10 Hz 上限、个人状态/断点、同名与同局合并、难度过滤、高度热力、默认待审核/隐藏撤销、持久化重启、解压上限与孤立文件容量。测试使用合成数据、loopback 和临时私有目录，不连接生产上传接口。
