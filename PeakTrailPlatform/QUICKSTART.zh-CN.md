# PEAK Trail 快速验收

最终产品只需要玩家安装一个 `PeakTrailRecorder.dll`。它会自动记录所有同步的人类玩家；
网站内嵌预渲染地图和游戏视觉资源。普通玩家不需要采集地图，也不需要安装 Blender。
同一个 DLL 内的 `F8` 地图捕获保留为维护工具，不是第二个 Mod。

## 1. 生成一局足迹

1. 通过 Steam 启动 PEAK，并在录制和分享前征得所有参与者同意。
2. 和朋友进入可游玩的岛屿，正常游玩至少 30–60 秒。最好覆盖加入、离开、死亡、复活、
   传送、体力变化、拿取/移动/消耗物品等情况。
3. 正常结束该局。崩溃或强制退出时，查看器仍会读取已经完整写入的 NDJSON 行。

默认输出：

```text
C:\Program Files (x86)\Steam\steamapps\common\PEAK\BepInEx\PeakTrailRecordings\
  PeakTrailHistory.ndjson
  <每局目录>\manifest.json
  <每局目录>\stream.ndjson
```

每局目录里的 `.partial` 文件也可恢复。`PeakTrailHistory.ndjson` 是最方便的跨日入口：它会
持续追加所有局次，而每局文件仍作为独立的崩溃恢复副本保留。

## 2. 打开 2.5D 查看器

Windows 下直接双击本文件同目录的 `Start-Viewer.cmd`。它会生成最新页面并打开浏览器，
使用期间保持启动窗口运行。请在打开的 `http://127.0.0.1:…/` 网页里选择目录；
直接双击 `index.html` 会被浏览器阻止加载解析模块。

也可以从仓库根目录运行：

```powershell
node PeakTrailPlatform/tools/serve-site.mjs --open
```

访问启动程序显示的本地网址，然后选择 `PeakTrailHistory.ndjson`，或者选择整个
`PeakTrailRecordings` 总目录。查看器会：

- 按 `startedAtUtc` 转换到浏览器本地日期，拆分出天数与每一天的局次；
- 拖动或播放时间线，同步显示所有人的历史路线、当前位置与事件；
- 默认只显示一关，顶部可上一关/下一关、手动选关，或恢复跟随回放进度；
- “所有关概览”需主动选择，平常按关加载模型，切关自动调整相机；
- 在每名玩家卡片中回放体力、额外体力、手持物和各物品槽；
- 使用当前录制 build 的真实游戏图标，以及记录的肤色、五官、套装与帽子呈现角色；
- 对旧日志或远端尚未同步的数据明确显示“未记录”或“同步中”；
- 自动从 Pages 内嵌 catalog 加载与该局场景、Steam build 和地图身份严格一致的 2.5D 地图。

普通用户不需要上传地图文件。没有精确匹配的地图时，页面只显示无底图路线并解释原因，
不会套用当天地图或相似场景。

旧版 `0.3.0` 日志没有装扮事件，因此无法恢复当时的套装；新版 DLL 从下一次游戏启动后
记录装扮，旧文件仍然可以回放地图、足迹、体力和图标化物品。

## 3. 维护者离线生成与登记地图

`tools/offline-maps/export_meshes.py` 直接读取本机 Unity 的 BuildSettings、Mesh、Transform
和材质，把该游戏 build 的 `Level_0` 至 `Level_20` 预先生成原始网格 GLB 包。必须以
BuildSettings 的场景路径映射为准，不能把 `levelN` 文件名当作 `Level_N`：当前 build
25306743 的 `Level_16` 对应 `level21`，而 `level4` 是另一座岛屿。

详见 `tools/offline-maps/MESH-CONTRACT.md`。每包保留场景文件哈希、完整父级世界变换、
原始三角面、UV、法线和游戏 build 身份；通过实例共享及无损压缩减小体积，不减面。
页面不再把高度场拉成山体，也不把俯视贴图投到垂直面上。PNG/高度场仅留作测绘参考及
旧格式兼容。自定义 shader、动态水面和风仍是近似效果，并非游戏实时渲染器。
回放保留原始 XYZ，并透视显示路线以防洞穴、悬挑遮住足迹。

生成后登记并核验：

```powershell
node PeakTrailPlatform/tools/finalize-offline-maps.mjs "<mesh-v3 的 build 目录>" --replace-build
node PeakTrailPlatform/tools/check-trace-alignment.mjs "<真实每局目录>" "<对应地图包目录>"
node PeakTrailPlatform/tools/validate-data.mjs
node PeakTrailPlatform/tools/stage-site.mjs
```

每日轮换只更新关卡索引，不需要每天重新建模。游戏更新后需要为新 build 重新生成，历史
build 的包保留供旧日志使用；Pages 每次只加载当前所选局次的包。

`finalize-offline-maps.mjs` 将 GLB 额外做无损 gzip、签名并登记；`--slot 16` 可只登记一套。
`--replace-build` 要求完整 21 套，备份原 catalog 后，只替换同 build 的旧绘制版本，原文件
仍留在本机。页面逐关解压，三角面、法线、UV 和纹理不损失。打包会检查整站不超过
保守的 10 亿字节预算，避免超过 [GitHub Pages 容量限制](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)。

### 可选：运行时核验捕获

进入真实加载的岛屿后按 `F8`，等待 BepInEx 日志出现
`Map pack complete`。输出默认位于：

```text
C:\Program Files (x86)\Steam\steamapps\common\PEAK\BepInEx\PeakTrailMapPacks\
```

用起点、营火、高点等至少三个分散地标确认路线和地图一致，再登记通过验收的包：

```powershell
node PeakTrailPlatform/tools/register-map-pack.mjs "<F8 导出的完整目录>" --activate-build
node PeakTrailPlatform/tools/validate-data.mjs
node PeakTrailPlatform/tools/stage-site.mjs
```

不要在同一个游戏进程里强制轮流加载 21 个场景；场景生命周期会触发 Photon、生成器和持久单例。
批量建设地图库使用上面的离线工具，F8 只用于正常加载场景的比对。

## 4. GitHub Pages

本项目已独立初始化本地 Git，尚未连接远端或上线。只克隆代码不会得到游戏资源；正式资源
保存在总目录内的 `local/assets`，由 `.gitignore` 排除。网页构建时仍将获准资源嵌入站点。

代码检查不需要真实资源。每日更新与 Pages 流程分别由仓库变量 `PEAK_DAILY_ENABLED`
和 `PEAK_PAGES_ENABLED` 显式启用，默认关闭。上线前先确认分发范围，并配置独立资产
取回步骤；不要为使 Actions 通过而强制提交私人日志或大型游戏资源。详见根目录 README。

## 隐私

Recorder 按需求记录所有同步的人类玩家，并保留真实、稳定的平台 ID 与昵称，不生成随机 ID。
足迹、体力和物品历史属于可识别的多人遥测；录制与分享前必须得到所有参与者同意。查看器仅在
浏览器本地解析所选文件，不会把日志上传到服务器。
