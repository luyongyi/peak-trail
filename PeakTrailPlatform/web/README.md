# PEAK Trail Web

纯前端的 PEAK 多人足迹 2.5D 回放器。它可以直接部署到 GitHub Pages；轨迹文件由用户选择后在浏览器内解析，不上传到服务器。

## 本地运行

Windows 下双击 `PeakTrailPlatform/Start-Viewer.cmd` 即可启动并打开查看器。
也可在本目录运行 `npm start`。ES module 无法从 `file://` 直接加载，页面会明确提示
使用启动程序。命令行方式（从 `PeakTrailPlatform` 目录运行）：

```powershell
node tools/serve-site.mjs --open
```

然后访问程序显示的 `http://127.0.0.1:…/`。无需安装 npm 依赖；Three.js `0.180.0`
固定在仓库的 `vendor` 目录，不依赖 CDN。2.5D 或角色渲染不可用时，页面仍能导入足迹并
查看事件、物品快照与体力。

静态检查与协议测试：

```powershell
npm --prefix web run check
npm --prefix web test
```

## 屏幕常亮（防熄屏）

直播会话存在（含调试演示模式）或回放正在播放时，页面通过 Screen Wake Lock API
保持屏幕不熄灭；暂停、断开或退出即恢复系统默认。直播状态行会显示"常亮"徽标，
API 不可用时徽标会注明原因。切后台浏览器会自动释放锁，回前台自动重新申请。

限制：该 API 仅在安全上下文（HTTPS 或 `localhost`）且浏览器较新时可用
（Chrome 84+ / Safari 16.4+ / Firefox 126+）。局域网 HTTP 直连（如
`http://192.168.x.x:4173`）下 iPhone Safari 拿不到该 API，徽标会显示
"需 HTTPS 才能防熄屏"；此时可在系统设置里临时把"自动锁定"调到"永不"。

## 导入与多日拆分

普通使用只需选择 Recorder 的足迹总目录，或把总目录拖进页面。查看器按
`manifest.startedAtUtc` 转换为浏览器本地日期，再按日期与局次展示。每局仍独立校验，
不会把不同会话的 stream 串在一起。

足迹选择器接受以下两种格式：

- 总目录下多个会话子目录；每个子目录含 `manifest.json`（或 `.partial`）与
  `stream.ndjson`（或 `.partial`）。必须保留相对目录，无法无歧义配对时会拒绝导入。
- 单个追加式 `PeakTrailHistory.ndjson`，其中可包含跨多天、多局的
  `session_start`、`trace_record` 与 `session_end`。

Pages 发布物会内嵌 catalog 登记的 2.5D 地图。选择局次后，查看器优先按该局的
`mapPackId` 精确查找；旧日志只有在场景、构建号、投影版本和坐标系都可验证时才使用
回退匹配。找不到就显示无底图轨迹，不会拿今日或相似地图冒充。手动地图选择器仅保留给
地图制作/维护调试，接受一次多选或一次拖入：

- `map-pack.json`
- JSON 中所有 `layers[].texture` 指向的 PNG
- JSON 中所有 `layers[].height` 指向的 `.f32` 文件

浏览器的普通文件选择器不能自动读取 JSON 同目录下的其他文件，所以本地导入时必须把上述文件一起选中。部署后的地图可通过查询参数自动载入：

```text
https://example.github.io/peak-trail/?mapPack=./data/maps/Level_7/map-pack.json
```

查看器会读取 `./data/daily/current.json` 显示今日轮换，并从
`./data/maps/catalog.json` 自动选择同一 `sceneName`、`mapSlot` 和
`activeGameBuildId` 的地图包。目录未发布今日场景或未显式指定活动构建时，界面会显示
“地图包未发布”，不会猜一个旧构建。`nextChangeAtUtc` 一到期也会立即隐藏自动底图，
直到 Action 写入下一轮有效数据。开发者手动导入和 `?mapPack=` 参数的优先级高于自动选择。

## 追加式历史日志

`PeakTrailHistory.ndjson` 每行是一个 JSON 信封，原轨迹记录完整放在 `record` 中：

```json
{"type":"session_start","sessionId":"run-1","manifest":{"schemaVersion":1,"sessionId":"run-1","startedAtUtc":"2026-09-15T13:04:22Z","sceneName":"Level_7","gameVersion":"2.4.c","gameBuildId":"19492001","coordinateSpace":"unity-world-meters","timeUnit":"milliseconds","identityMode":"platform-user-id","recordingScope":"all-synchronized-players"}}
{"type":"trace_record","sessionId":"run-1","record":{"type":"sample","t":200,"playerId":"7656119...","pos":[34.2,118.7,-19.5],"yaw":82.4,"stamina":72,"maxStamina":100,"extraStamina01":0.35,"item":{"id":"rope","name":"Rope","slot":0}}}
{"type":"session_end","sessionId":"run-1","endedAtUtc":"2026-09-15T13:24:22Z","durationMs":1200000}
```

这是 append-only 文件；即使最后一局尚未写入 `session_end`，已有记录仍可读取。

## 足迹 v1 协议

查看器与 `PeakTrailPlatform/schema` 内的 JSON Schema 对齐，并对旧字段名做少量宽松兼容。

`manifest.json` 的关键字段：

```json
{
  "schemaVersion": 1,
  "sessionId": "2026-09-15T13-04-22Z-7656119...",
  "startedAtUtc": "2026-09-15T13:04:22Z",
  "gameVersion": "2.4.c",
  "gameBuildId": "19492001",
  "sceneName": "Level_7",
  "mapSlot": 7,
  "mapPackId": "sha256-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "projectionVersion": 1,
  "sampleHz": 5,
  "coordinateSpace": "unity-world-meters",
  "positionAuthority": "xyz",
  "segmentResolution": "unassigned",
  "activeSegmentSemantics": "global-maphandler-segments-index",
  "identityMode": "platform-user-id",
  "recordingScope": "all-synchronized-players",
  "timeUnit": "milliseconds"
}
```

NDJSON 每行一条记录。`t` 是从会话单调时钟原点开始的整数毫秒：

```json
{"type":"participant","t":0,"playerId":"7656119...","nickname":"Climber","actorNumber":1,"platform":"steam"}
{"type":"sample","t":200,"playerId":"7656119...","pos":[34.2,118.7,-19.5],"yaw":82.4,"activeSegment":2}
{"type":"event","event":"death","t":82400,"playerId":"7656119...","pos":[35.1,93.2,-21.0],"activeSegment":2}
{"type":"event","event":"segment_change","t":83000,"activeSegment":3}
```

采样可选携带 `stamina`/`maxStamina`、`extraStamina`/`maxExtraStamina`（或对应
`stamina01`、`extraStamina01` 归一化值），以及 `item`。`item: null` 表示明确观测到空手；
字段缺失表示旧 Mod 没有记录。拖动时间线时，玩家卡片会同步显示当时的体力条、额外体力条、
手持物、三个快捷槽、背包槽、临时槽和背包内部四格。物品图像来自同构建 PEAK 的
`Item.UIData.icon`；空、首包同步中、未装备背包和旧日志未记录不会混为一种状态。旧轨迹仍
正常显示坐标和事件，并明确标注缺少的状态。

多人长时间回放的可扩展性约定：侧栏卡片按约 8 Hz 节流刷新（3D 场景仍逐帧，暂停与拖动
时间线立即刷新）；事件列表按滚动位置只渲染可见窗口的行（会话仍有完整事件数据与刻度），
时间线刻度按 0.12% 分桶合并（约 850 个以内）；地图头像标签的尺寸只在首次可见时测量一次，
不逐帧读取布局；画布尺寸由 ResizeObserver 缓存。这些约束避免"每帧强制重排整个页面"，
在一局 6 人 107 分钟（13.8 万采样、8,800 事件）的实录中把回放从 4 fps 提升到流畅帧率。

Recorder 0.3 起还会在玩家静止时写独立的 `state`（体力心跳）和 `inventory`（主机同步的
物品快照）记录；查看器会按同一 `t` 合并到最近的空间采样。`telemetryReady: false` 或
`inventoryReady: false` 表示远端首包尚未到达，页面显示“同步中”，不会把缺失值当成 0。
物品变化事件使用保守名称 `item_acquired`、`item_lost`、`item_moved`、
`item_state_changed`，原生可确认的动作使用 `item_consumed`、`item_thrown`，拿出/收起
状态使用 `item_equipped`、`item_unequipped`。事件的
`source` 与 `confidence` 会保留，避免把快照差异猜成某个具体操作。

Recorder 0.4 起写入带时间戳的 `appearance`。查看器按 `gameBuildId` 精确选择真实游戏素材，
把头部、眼睛、嘴型、配件、套装、`effectiveHatIndex` 对应的有效帽子、肩带和徽章几何在同一
中性姿势坐标中装配；肤色使用同步的 `skinColor`。拖过换装时刻会重建对应预览。例如：

```json
{"type":"appearance","t":12000,"playerId":"7656119...","appearance":{"ready":true,"authority":"persistent-player-data-sync","source":"recorded","skinIndex":4,"eyesIndex":5,"mouthIndex":12,"accessoryIndex":5,"outfitIndex":21,"hatIndex":18,"effectiveHatIndex":18,"sashIndex":9,"medalIndex":1,"skinColor":[0.536,0.319,0.184,1]}}
```

目录没有该构建或日志尚无外观记录时不会回退到“看起来差不多”的新版本/默认人物。旧日志会
显示“本局未记录外观”；若将来展示本地 Steam 缓存的当前外观，必须标为“本地当前 · 非历史”。

局次选择器会显示 `status: recording`、`.partial` 文件和 `endReason`，让未完整结束或异常
结束的旧日志可辨认；它们不会与下一局自动拼接。

### Recorder 0.7：状态占用与真实变形

独立的 `status` 快照记录全部 15 类身体状态和活动效果身份；体力条按游戏的完整容量
显示当前值，右侧分色显示状态占用，而不是把受损后的上限重新当作 100%。例如寒冷
20% + 诅咒 10% 时，当前体力 35%、可用上限 70% 分开显示。石化对额外体力的
占用独立计算。颜色仅为回放图例，不声称复刻游戏 HUD 材质。

普通体力状态包与体力数值包分别同步；`capacityReady: false` 不等于体力为零，
也不代表额外体力上限未知。`effectsReady` 又独立于两者，远端效果没有可靠倒计时，
页面只展示实际记录的类型。死亡、复活或状态清除都读取当时快照，不自动清零诅咒等状态。

`appearance.formReady` 独立于装扮的 `ready`。骸骨之书引起的真实骷髅形态、蘑菇形态
使用同构建原生头部网格；无头的鸡形态使用明确标注的原完整模型图标。侧栏和地图头像
随时间线切换，恢复形态、倒拖与未知快照均会清除旧头像。不会根据是否持有道具猜测变形。
旧日志未记录状态/变形时明确标为未知，原装扮头像只作为参考，不能修复为本局真实形态。

底图材质的 `_TopColor` 世界朝上混合只在 `W/Peak_Rock`（沙、岩）复现——游戏自带的俯视
勘测图证实那里的顶面就是沙色。`GD/FoliageGD`、`W/Peak_Mirage`（所有材质共用同一个默认
`_TopColor`，游戏里仙人掌顶仍是粉色）与 `W/Peak_Petrified_Rock`（会让沙漠石化木变青或
变黑，实录为暖棕）不复现该混合，查看器对这三类着色器把混合量取 0。详见
`tools/offline-maps/MESH-CONTRACT.md`。

3D 回放视图中的地图头像按**记录坐标系 10 米**聚类：多人互相处于 10 米内（允许链式
传递）时，独立头像标签合并为一个包含所有成员头像的大圆圈，圈下并列显示昵称，引线
指向成员屏幕锚点均值；解散距离后各自恢复独立标签。聚团只是展示层的聚合，不修改
轨迹、事件或任何记录数据；玩家隐藏、分层筛选与生死状态仍按各自标签规则独立生效。

可从仓库根运行 `node PeakTrailPlatform/tools/qa-player-conditions.mjs` 生成
`local/verification/player-conditions-qa/`；导入其中 manifest 与 stream 可检查
状态、骷髅、恢复和未知边界。这是明确标注的**合成测试，不是游戏实录**。
本机提取素材与合成/私人日志均不提交到 Git；游戏内新局仍需使用 0.7 DLL 进行验收。

参与者使用 Mod 记录的真实稳定 `playerId` 与 `nickname`；查看器不会生成或替换随机参与者 ID。
XYZ 坐标是权威数据。`activeSegment` 是场景级 `MapHandler.segments` 数组索引，而不是
PEAK 的 `Segment` 枚举值；它只描述全局推进状态，不能证明每名远端玩家属于该地图层。
因此 `segment_change` 是全局事件，Recorder 0.1.1 的逐玩家记录默认不写 `segment`。
只有 `segmentResolution: "position-inferred-v1"` 的轨迹才允许把 `segment` 当作高置信的
`layers[].segment` 所属层。缺少 `segmentResolution` 的旧 v1 轨迹会按
`legacy-global-current` 保守读取：旧 `segment` 转为 `activeSegment`，不参与单层筛选。

## 2.5D 地图包

地图包由一到多个分层组成。高度编码固定为 `float32-le-row-major-minz-minx`：小端 Float32，先沿 X 增长，再沿 Z 增长。每个数值是 Unity 世界坐标的 Y，而不是归一化高度。

```json
{
  "schemaVersion": 1,
  "identityVersion": 2,
  "mapPackId": "sha256-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "gameVersion": "2.4.c",
  "gameBuildId": "19492001",
  "sceneName": "Level_7",
  "mapSlot": 7,
  "projectionVersion": 1,
  "coordinateSpace": "unity-world-meters",
  "textureUv": "u=(x-minX)/(maxX-minX);v=(z-minZ)/(maxZ-minZ)",
  "imageOrigin": "bottom-left-in-uv;viewer-flips-for-top-left-images",
  "layers": [
    {
      "id": "shore",
      "name": "Shore",
      "segment": 0,
      "texture": "shore.png",
      "textureSha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      "height": "shore.f32",
      "heightSha256": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      "heightEncoding": "float32-le-row-major-minz-minx",
      "sampleLocation": "cell-centers",
      "columns": 512,
      "rows": 512,
      "minX": -256,
      "maxX": 256,
      "minY": -3,
      "maxY": 88,
      "minZ": -256,
      "maxZ": 256,
      "noData": "NaN"
    }
  ]
}
```

Exporter 使用像元中心采样，查看器采用完全相同的坐标：

```text
x = minX + (column + 0.5) × (maxX - minX) / columns
z = minZ + (row    + 0.5) × (maxZ - minZ) / rows
u = (column + 0.5) / columns
v = (row    + 0.5) / rows
```

`NaN` 高度不会生成三角形，可用于岛外、洞穴空白与分层遮罩。PNG 是常规左上角图像数据，UV 使用左下角原点；查看器默认执行 Three.js 的上传翻转（`textureFlipY: true`），与 Exporter 的 `imageOrigin: "bottom-left-in-uv;viewer-flips-for-top-left-images"` 约定一致。查看器会拒绝未声明或未知的根级方向约定；特殊输出仍可在分层中显式设为 `false`。

地图包必须声明 `identityVersion: 2`。`mapPackId` 不是标签：Exporter 以
float32 原始位和每层高度文件哈希计算它，登记与 CI 会独立重算并拒绝伪造或损坏的包。
精确规范与跨 C#/Node 测试向量见 `docs/map-pipeline.md`。

为了控制浏览器 GPU 内存，展示网格的单边会降采样到约 420 个顶点，但世界边界、像元中心和轨迹坐标不变。

## 防止叠错地图

地图和足迹同时存在时，查看器只有在以下任一条件成立时才显示底图：

1. `mapPackId` 精确相等；或
2. `sceneName`、非空且非 `0/unknown` 的 `gameBuildId`、`projectionVersion` 与 `coordinateSpace` 全部相等。

任何已提供的 `gameVersion`、`mapSlot` 等字段发生冲突也会阻止叠加。阻止后仍可在网格上播放无底图轨迹，界面会持续显示原因，不会静默猜测。

## GitHub Pages

`PeakTrailPlatform/tools/stage-site.mjs` 会把本目录、schema 与平台数据组装成 Pages artifact：

```text
web/data/daily/current.json
web/data/maps/catalog.json
data/maps/packs/<map-pack-id>/...
```

地图包先用 `PeakTrailPlatform/tools/register-map-pack.mjs` 登记。然后上传生成的
`PeakTrailPlatform/site-dist/`；所有资源都使用相对路径，支持仓库子路径部署。
