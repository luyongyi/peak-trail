# 历史轨迹收集（trajectory-v1）

本模块接收回忆录 Mod 在本地重新提取的小包。它不接收 `.peakrun`、录像资源、库存、状态条、音频或世界物件。旧足迹直播接口默认关闭，回忆录上传、路线与热力查询保持正常。通过白名单协议验证的新投稿自动 `approved`；公开路线与热力仍只使用完整的个人关卡尝试，并要求原生地图对齐证明。

## 队伍搜索与查看

`GET /api/route-teams?member=<昵称片段>&group=<可选地图组哈希>&difficulty=<可选难度key>&limit=50` 返回 `{teams,truncated}`。昵称采用 Unicode NFKC 规范化、不区分大小写的子串匹配；同名仅匹配文本，不合并玩家身份。默认 50、最多 100 支队伍，按最近录制时间排序。队伍摘要包含 `id/groupId/startedUtc/lastStartedUtc/difficulty/map/members/stageSummaries/summitCompleted/finisherKeys`；`members` 返回队内全部成员，不按原版人数或 16/64 人截断。

队伍身份由地图布局组、难度和可靠的对局作用域散列产生。只有同时具有 `runKey` 和有效共享 `timeOriginMs` 的上传才跨录像归队；否则按 `recordingId` 隔离。旧索引已有完整路线时可沿用其已验证的 `dedupe.scope`，没有可靠证据不猜测归队。录制者 `owner` 仅用于优选本人的观察，不能当作队长。

`GET /api/route-teams/<teamId>` 返回 `{team}`，在摘要上添加现有的 `mapCompatibility/mapPackId/mapAlignment`。`GET /api/route-teams/<teamId>/stages/<stage>/routes` 返回队内成员的实际预览，包括部分线路、`completion/completed/gameCompleted/summitCompleted` 与真实 `breaks`。同一成员的多个来源优先选该关有点、本人录制、原生切关证据和点数，不将多个来源拼接成完整线路。该关无点的成员仍返回空路线，避免误认为该成员已经离队。每条路线时间保持原始非负 `tMs`，`timeBasis=recording-ms`；可靠共享时钟时另附 `timeOriginMs`，包括合法的负原点。

队内预览以整个成员为单位分页，单页最多 200,000 个点并受约 12 MiB 响应预算约束；不截短成员坐标、不丢弃后面的成员。`nextCursor` 非空时，以 `?cursor=<nextCursor>` 顺序读取剩余页；游标是上一页最后一个成员的 `playerKey`。每页 `totalRouteCount` 都是全队人数，`pointCount` 是本页点数，`truncated:false`；网页会自动读取全部页。响应还包含全队一致的 `summitCompleted/finisherKeys/stageCompleted`，以及绑定当前已批准来源集合的 `teamRevision`；翻页期间来源发生变化时，网页拒绝混合两次修订的结果。大型队伍仍受请求字节、存储容量、worker 内存与时限保护，不承诺无限载荷。

新上传在私有小型索引保存版本 2 的队伍及分关摘要；普通搜索只读索引，不全站解压轨迹。查看一支旧队伍时，顺序核验其全部旧来源，在响应中恢复实际分关、生死及登顶摘要，不写回索引、不改变队伍身份。旧录像缺少关卡门限和原生时间线时仍接受，无法分关的成员返回 `unknown` 空路线，不猜测其坐标属于哪关。

至少一名原生状态证明仍存活的成员触发明确的 `summit` 事件，整个队伍即为 `summitCompleted:true`，`finisherKeys` 标识实际完成者。旧 `finish` 同时曾用于几何出口，不能据此宣布全队登顶；到达熔炉或最后关也不等于登顶。团队完成标记不会把死亡队员的部分线路伪造成完整线路，也不替他们增加热力。每位队员的坐标只保留存活区间，死亡当刻的真实采样保留，后续幽灵坐标丢弃；确实复活后恢复记录并在生死边界断开连接。连接状态与生死状态独立：`join` 只恢复在场，不会把死亡者变为存活；只有明确 `revive` 清除死亡状态，离线者还必须重新加入。

已批准但只有部分线路的地图组也可查询和打开；它们不贡献公开完整路线或热力。所有队伍接口按每次请求的当前审核状态生成，隐藏、拒绝或保留投稿立即撤销对应来源。

公开 `routes` 与 `heatmap` 端点可带 `team=<teamId>`，仍同时受当前地图组、关卡和难度约束。热力增加 `countBy=team|player`（默认 `player`）：同队在同一 2 米三维格只计一次，按成员则同队同成员只计一次；不同队伍/对局独立累加。`routeCount` 仍为完整个人尝试数量，另返回 `countBy/teamCount`。部分、死亡、断点和未知证据的预览不会混入热力；高度分层保持独立。团队简图仅由网页展示层生成，不修改这些个人原始坐标或通关判定。

## 本地运行

```powershell
node PeakTrailPlatform/server/live-server.mjs --port 8787 --routes-dir C:/Users/lu452/Downloads/PeakTrail/local/trajectory-store
```

`--routes-dir` / `PEAK_TRAJECTORY_DIR` 必须指向静态站点之外的私有目录；未配置时新接口返回 `503 route-storage-unconfigured`。数据包含昵称和精简 XYZ，不能加入 Git、静态发布目录或游戏资源包。

服务默认从同一发布版本的 `site-dist/data/maps/catalog.json` 读取地图，连同其旁边的 `packs/`、原生路线和地标证据核验。源码目录 `data/maps/catalog.json` 仅是元数据，不能替代带完整模型资源的发布目录。API 测试可以显式传入 `catalogPath`，生产默认不会降级到其他发布版本或源码目录。

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
  alignment?: {version:1, coordinateSpace:"unity-world-cm",
    landmarks:[{key,kind:segment-root|progress-point,stageIndex?,name,
      positionCm:[xCm,yCm,zCm],rotation?:[x,y,z,w],scale?:[x,y,z]}]}
difficulty: {ascent: 整数或 null, custom: bool 或 null, mini: bool 或 null}
players:
  [{key: 按 runKey/recordingId 作用域散列的玩家身份,
    name, owner: bool, evidence: native-state | legacy-unknown,
    points: [[tMs,xCm,yCm,zCm]],
    events: [{tMs,kind: join|leave|dead|revive|break|warp|finish|summit|game-stage|checkpoint,stageIndex?}]}]
```

不设独立玩家人数上限，所有成员均按白名单协议接收；每人每 100 ms 桶最多一个真实点，不插值补点；整数厘米保留 XYZ。单次上传仍须满足下述字节和时长预算，不能通过增加人数绕过资源保护。`stages` 必须连续编号且名字与 `route` 一致。原生关卡门限必须成对且 `exitZCm > enterZCm`；旧录像可以同时缺失。昵称仅在玩家头信息中写一次，同名玩家凭哈希 key 区分。`summit` 只允许 `native-state`，必须带最后一个非 Void 关卡编号；它表示原生个人完成状态，不能由 Z 门限推算。

`alignment` 是录制开始时一次性读取的地图物件证据，最多 16 个地标，不增加逐帧读取。根使用 `segment-root:<index>`，原生进度点使用 `progress-point:<index>`，山顶使用 `progress-point:peak`。名字来自实际 Transform；根必须同时带世界旋转和缩放，进度点不带它们。关卡门限必须等于对应进度点的 Z，不能把半关随意改成完整关卡。旧录像不借用上传时正在游玩的地图补地标。

压缩请求上限 12 MiB，解压上限 64 MiB。gzip 解压、JSON 验证、关卡筛选、索引读取、聚合和大型响应编码都在 worker 中完成。HTTP 最多 4 个请求进入有界队列，worker 串行运行；同时最多接收一个上传；多余请求返回 429。每来源每分钟最多 20 次上传、120 次公开查询；429 返回 `Retry-After`（限频 60 秒、瞬时忙碌 5 秒），大型分包上传可等待后继续，不截掉剩余成员。`--trusted-proxy` 仅在已绑定 loopback 且受信反代设置 `X-Real-IP` 时启用。

上传器可发送标准 `Prefer: return=minimal` 请求头，成功响应附 `Preference-Applied: return=minimal`，只返回 `uploadId/groupId/duplicate/moderationStatus/mapCompatibility` 五个字段，不回传全体成员的逐关 receipt，避免人数较多时回复超过客户端预算。未指定偏好的旧客户端仍收到完整兼容 receipt。分包以完整成员为单位，保留原 `recordingId/runKey/timeOriginMs`；这些成员仍属于同一队伍。

成功返回 `201`（新包）或 `200`（重复包）：

```json
{"uploadId":"<canonical-payload-sha256>","groupId":"<recorded-map-group-sha256>","duplicate":false,"moderationStatus":"approved","mapCompatibility":"waiting-map","mapPackId":null,"stages":[{"playerKey":"<sha256>","stages":[{"index":0,"completion":"complete","routeCount":1}]}]}
```

`completion` 为 `complete / partial / unknown`，按每个玩家独立计算。只有声明有原生状态证据、录到入口到出口、期间持续存活且没有缺口/传送的尝试才生成完整关路线。超过 1.5 秒采样缺口、异常位移、死亡、离开、warp/break 都中断当前尝试；队伍全局推进或 finish 不能替所有玩家补通关。入口容差 3 m 用于角色中心与原生平面的差异，半关开录不会成为完整路线。旧录像没有状态证据或门限时为 `unknown`，仍接受上传。

新导出器可补充每个玩家的 `game-stage` 时间线：首次观察和原生 `World.Segment` 映射关卡变化时记录 `{tMs,kind:"game-stage",stageIndex}`，用于按实际切关时间分配坐标。相邻普通关卡正常推进时，仅本人在切关边界持续存活、在场且没有传送或生命周期中断，才能在同一 `tMs` 添加上一关的 `{kind:"checkpoint",stageIndex}`；事件同毫秒的排列先后不限。服务器要求 checkpoint 与唯一的相邻普通关卡变化精确匹配，拒绝缺关卡编号、重复、错时间、跨关跳跃、Void 转换及未知原生状态的 checkpoint。

原版点燃篝火可在下一关标题平面之前推进关卡，因此个人 checkpoint 可以成为完整线路的真实终点；不修改地图原生 Z 门限或布局哈希。服务器仍要求该玩家亲自录到入口、连续存活、无断点地走到 checkpoint。本人上一关 checkpoint 可证明下一关的原生入口；首次半途观察到 game-stage 只用于分关。关卡变化位于两个 10 Hz 点之间时保留相邻的真实采样点，不插值或跨不连续区间补点。已上传旧包没有时间线时完全沿用原 Z 门限规则，需从完整录像重新导出才能恢复缺失的篝火证据。

## 私有存储与审核

```text
PRIVATE_DIR/index/<uploadId>.json       小型索引与审核状态
PRIVATE_DIR/uploads/<uploadId>.json.gz  重建后的白名单轨迹
PRIVATE_DIR/routes/<uploadId>-pN-sN-aN.json.gz  完整个人关卡尝试
```

blob/route 文件先落盘，索引以原子创建提交；服务重启重新读索引。公开状态只来源于提交的索引，损坏条目不会重新获得审批。失败写入会清理本次拥有的新文件；异常退出的孤立文件也计入容量，不会绕过配额。总存储按实际私有目录字节限制 2 GiB，最多 10,000 投稿、100,000 条路线；达到上限返回 503，由管理员决定清理策略，不自动删除用户历史。

新投稿记录真实 `startedUtc`、`reviewedUtc` 与 `reviewMethod=automatic-contract-v1`。服务实例首次处理真实轨迹 worker 请求时，迁移以前未审核的 `pending` 投稿：先重新验证原精简 gzip 的完整白名单协议与内容 SHA，再核对索引身份、玩家、个人关卡判定及全部派生路线的实际坐标/断点；通过后原子改为 `approved`，从轨迹包恢复录制时间。损坏数据保留 `pending`；有 `reviewedUtc` 的人工保留、隐藏或拒绝均不自动改变。迁移每个服务实例只运行一次，后续普通查询不反复解压未通过的历史包。

迁移提交和人工审核共用每条索引的独占 `.review-lock`，迁移在锁内重读当前状态，人工撤销不会被自动迁移覆盖；正常结束后删除锁。异常终止若遗留锁，该条迁移跳过、人工操作返回忙碌，不强抢仍可能在用的锁。管理员仅在确认无审核正在运行后处理遗留锁。所有原始简化轨迹和地图证据保持录制时原值。

```powershell
node PeakTrailPlatform/server/route-admin.mjs --dir PRIVATE_DIR list
node PeakTrailPlatform/server/route-admin.mjs --dir PRIVATE_DIR approve UPLOAD_SHA256
node PeakTrailPlatform/server/route-admin.mjs --dir PRIVATE_DIR hide UPLOAD_SHA256
node PeakTrailPlatform/server/route-admin.mjs --dir PRIVATE_DIR reject UPLOAD_SHA256
node PeakTrailPlatform/server/route-admin.mjs --dir PRIVATE_DIR pending UPLOAD_SHA256
```

通过现有 SSH 管理身份执行，不提供公共审核写接口。人工操作记录 `reviewMethod=administrator`；公开查询每次读取当前审核状态，`hide/reject/pending` 在下一次请求中撤销路线、热力及验收预览。人工 `pending` 是明确保留，不会再次自动通过。审核数据与站点部署版本分开保存，部署回滚不会回滚投稿状态。

内容 SHA 幂等防止重传；有共享对局、玩家 key 和共享时间原点时，重叠关卡尝试合并，优先采用 owner 观测；owner 身份相同则优先有原生分关时间线的记录，再比较点数。新的派生路线索引仅在存在 game-stage 时添加 `nativeProgress:true`，旧索引保持原字段形状。重新导出纠正的原生分关路线因此优先于同一人旧平面分关的更长路线，两份投稿均保留。缺共享时钟时只在同一 `recordingId` 内去重；不同名字不作为不同人证据，同名也不合并不同 key。

游戏原生 `RunId` RPC 同步晚于录制启动时，共享时间原点可能为负（例如 -2000 ms）；原岸边坐标仍保留，不通过裁掉前段消除负值。点时间始终为录制内非负时间，跨生产者去重仅使用 `timeOriginMs + tMs`。

## 公开查询

| 路径 | 结果 |
| --- | --- |
| `GET /api/route-groups` | `{groups:[{id,map,firstStartedUtc,lastStartedUtc,mapCompatibility,mapPackId,difficulties,stageSummaries:[{index,name,routeCount}]}]}` |
| `GET /api/route-groups/:id/stages/:index/routes?difficulty=KEY&limit=200` | `{groupId,stageIndex,mapCompatibility,mapPackId,totalRouteCount,routes:[{id,playerKey,name,difficulty,points,breaks}],truncated,pointCount}` |
| `GET /api/route-groups/:id/stages/:index/heatmap?difficulty=KEY` | `{groupId,stageIndex,mapCompatibility,mapPackId,totalRouteCount,cellSizeCm:200,heightBandCm:200,cells:[[xIndex,yIndex,zIndex,count]],routeCount}` |
| `GET /api/route-groups/:groupId/uploads/:uploadId/stages/:index/inspection` | `{groupId,uploadId,stageIndex,inspection:true,excludedFromAggregation:true,startedUtc,mapCompatibility,mapPackId,mapAlignment,coordinateSpace,routes:[{id,playerKey,name,difficulty,points,breaks,completion,completed,gameCompleted}],totalRouteCount,pointCount,truncated}` |

只有 `approved` 且个人关卡完整的数据进入公开聚合。旧地图组普通路线端点每次响应最多 200 条且最多 200,000 个点；达到任一上限会明确 `truncated:true`，不会把截断结果冒充全部统计。查看具体队伍使用前述自动翻页端点，全部成员和部分线路都保留，不受这 200 条限制。热力统计仍遍历该筛选条件下的完整有效路线，每条尝试在同一体素仅贡献一次；保留高度带，不把上下层混成一层；不会穿过不连续位移连线。格网最多 250,000 单元。

验收预览是独立的只读查询，要求精确地图组和投稿 ID，而且投稿当前为 `approved`；隐藏、拒绝或人工保留返回 404。它只读取已经上传的精简白名单包，重新验证内容 SHA，有 game-stage 时按原生分关时间筛选真实坐标；旧包回退到该关原生 Z 门限及角色中心 3 m 容差，不生成插值点。原 warp/break、生死、入离事件，以及采样缺口、异常位移和离关后重新进入都形成毫秒断点，不能跨传送连线。它可以展示 `partial/unknown` 的尝试，用于模型位置验收；`excludedFromAggregation:true` 明确表示不增加完整路线或热力统计。最多返回 200,000 个点，超出会标记 `truncated`。坐标使用与公开完整路线相同的严格地图对齐变换，网页仍拒绝未经证明的模型叠加。

预览的 `gameCompleted` 与 `completed` 分开：前者是有原生状态及时间线时个人 checkpoint 所证明的游戏通关，后者表示录到了可聚合的完整连续线路。曾发生传送、死亡或半途开录仍可能后来正常点燃篝火，显示 `gameCompleted:true,completed:false`，不会伪造完整热力。无原生个人状态或旧时间线时 `gameCompleted:null`；有时间线但没有本关完成证据时为 false。明确的存活个人 `summit` 可证明最后关游戏完成，即使录制点不连续；只有 `summitCompleted` 用于判断登顶。原有最终关 finish 保留作为兼容事件，完整终点轨迹仍可证明完整线路，无法验证的 finish 显示 null，不虚构进入 Void 的 checkpoint。

地图组的 `firstStartedUtc/lastStartedUtc` 来源于录制包的真实时间，不以上传时间替代。历史验收链接指定录制的地图组与投稿，仅切换这一访问页面，不更改当天的轮换服务数据。

地图组依据录制的构建、场景、实际布局与分关信息，日期只是导航。目录存在对应 build/scene、原生分支匹配且真实布局证明通过时返回 `matched`；没有底图或证据冲突为 `waiting-map`。`mapPackId` 只标识用于显示的导出包，不作为统计组永久主键。

`matched` 还要求真实布局对齐证明。服务读取对应构建的 `landmarks.<build>.json`，按精确 `mapPackId` 和 `sourceSceneSha256` 绑定底图的 `map-pack.json`。新录像须具有相同完整地标身份，并至少有三个分散、非共线的位置；仅允许整体正向刚性旋转和平移，所有点的误差须不超过 5 cm，根旋转与缩放也须匹配。地标缺失、非刚性变形、不同关卡、不同构建均不能借用底图。返回 `mapAlignment.status=verified|pending` 及原因；历史投稿及审核状态始终保留。

发布 staging 会重建 `routes.<build>.json` 和 `landmarks.<build>.json` 的公开白名单，仅包含实际发布 catalog 中的导出包，绑定其源场景 SHA。已经提供地标的构建必须覆盖该构建的完整 catalog；缺行、重复、错版本、错误场景、无原生路线证明或不可验证的地标会在替换现有站点之前失败。不发布旁边的私人文件或未经引用的旁数据行。

较旧录像只有 `layoutKey` 时，仅在导出工具能从原场景、DLL MVID、完整根路径/XYZ 和原生门限重建完全相等的 `expectedLegacyLayoutKey`，且原生代码已确认无运行时根 TRS 写入时，允许 `legacy-layout-key` 方式证明原位。该方式只使用单位变换；哈希不等、缺原源版本或门限不一致时仍等待证据，绝不猜测旧录像偏移。

私有存储中的坐标、地标和门限保留录制时原值。路线查询先按已验证的整体变换返回 `coordinateSpace=canonical-map-world-cm`，热力图使用同一转换后的点聚合；未证明时只返回 `recording-world-cm` 原始坐标，地图网页拒绝叠加。路线与模型仍共用网页显示原点、一次 Z 镜像和高度缩放。不同实际布局保留独立组，不能因为匹配同一底图就合并统计。

网页入口位于首页「进入地图」后的同一张 3D 地图内，提供「线路图层：仅地图 / 大家的路线 / 热力图」。客户端进一步核对当前 `mapPackId`、构建、场景、原生关卡顺序与终章分支，并且只选一个录制布局组；不能将多个同名场景布局自动混在一起。`waiting-map` 投稿仍保留、可以审核，但地图界面不会叠加其路线，也不会借用旧构建底图。选择具体关卡才查询该关路线和热力，「所有关概览」不造合计热力。这里只使用 GET，无直播轮询、SSE 或网页写入审核接口。

## 验证

```powershell
node --test PeakTrailPlatform/tools/tests/map-alignment.test.mjs PeakTrailPlatform/tools/tests/trajectory-server.test.mjs
```

包括真实 HTTP gzip 上传、白名单拒绝、10 Hz 上限、个人状态/断点、同名与同局合并、难度过滤、高度热力、自动通过及历史迁移、损坏内容不迁移、人工保留/隐藏/拒绝、审核锁、真实录制日期、隔离验收预览、持久化重启、解压上限与孤立文件容量。原生分关额外覆盖篝火早于标题 54 m、两采样点之间切关、多人死亡/传送/晚加入、最终关 finish 与明确 summit 区分、旧索引兼容，以及新旧投稿并存时的分关去重优先级。扩展队伍覆盖 70 人上传、65 个独立旧来源、260,065 点完整翻页、1,000 人精简 receipt、生死区间剔除、死亡末段实际渲染，以及队伍登顶不伪造个人完整热力。测试使用合成数据、loopback 和临时私有目录，不连接生产上传接口。

对齐测试额外覆盖原位、整体平移/旋转、厘米量化、镜像/缩放/单关偏移拒绝、源场景 SHA 绑定、路线和热力统一空间、旧地标缺失保留及精确旧布局哈希兼容。网页校验响应的同一对齐证明 ID，防止切图或更新地标后叠加过期坐标。
