# PEAK Trail 快速验收

网站当前下载为 **PEAK 回忆录 Mod 0.8.0 实验版**，DLL 为 `PeakReplayLab.dll`，
已公开为 [v0.8.0 GitHub prerelease](https://github.com/luyongyi/peak-memories/releases/tag/v0.8.0)。它在游戏内录制与回放；网页内嵌地图，展示审核通过的个人完整关卡轨迹。
普通玩家不需要采集地图，也不需要安装 Blender。源码与正式发布记录见
[peak-memories](https://github.com/luyongyi/peak-memories)。

## 1. 安装与游戏内录制

1. 关闭游戏，在 Steam 的 PEAK 页面「管理 → 浏览本地文件」找到 `PEAK.exe`。
   先安装 BepInEx 5 Windows x64，启动一次后退出；已有加载器可跳过。
2. 将网站下载的 `PeakReplayLab.dll` 放入 `BepInEx/plugins/`。升级时只替换同名 DLL；
   移走旧足迹／直播 Mod 的 `PeakTrailRecorder.dll`，保留旧日志、录像和配置。
3. 启动游戏，进入关卡后自动缓存最近最多 120 秒。录制与分享前征得同局参与者同意。

- **F6 随时留片段**：完整录制开着或关着，都能保存最近最多 120 秒；没按保存键的缓存退出时不会自动保存。
- **完整录制独立开关**：主菜单「回忆录 → 录制方式」开启后，进岛自动录制完整录像；
  F4 开启／关闭，关闭时封存当前文件。设置会保留，片段缓存不会清空。

两者可同时使用。保存后在游戏主菜单的「回忆录」中选择录像观看，底部拉手与 H 可展开／收起控制台。
观看回放时不再采集；建议回主菜单等待完整录像封存提示后再退出游戏。

默认输出：

```text
PEAK/BepInEx/PeakReplayLab/
  Recordings/*.peakrun       独立开启完整录制后保存的整局
  Memories/*.peakreplay      F6 保存的精彩片段
```

回忆录中的「打开文件夹」会打开当前分类。配置位于 `BepInEx/config/cn.mylus.peakreplaylab.cfg`，
升级时保留。`.partial` 为录制中或异常中断文件，当前不能当作完整录像播放或上传；排查时保留录像与
`BepInEx/LogOutput.log`。0.8.0 的游戏内显示、性能和多人录制仍待实测。

## 2. 分享轨迹与查看地图

在游戏的「回忆录 → 完整录像 → 详情」选择「上传轨迹」。Mod 先在本地提取最多 10 Hz 的
坐标、昵称和必要地图信息，预览并确认后才发送；不发送原始录像。120 秒片段、录制中与异常
文件不支持上传。投稿默认待审核，个人完整走完的关卡才会加入公开路线统计。

如果只看地图和大家的线路，无需先导入个人日志：从首页选 **进入地图**，点击顶部「返回」旁的
「路线与热力」，再用侧栏中的「线路图层」切换「仅地图」「大家的路线」「热力图」。默认铺满纯地图、收起侧栏，选择具体关卡后
可按难度和高度层筛选；在路线模式中勾选或隐藏个人路径。热力统计审核通过、完整走完
本关的路线。「所有关概览」不合并各关热力，先选具体关卡再查看。没有匹配当前构建、
场景与关卡分支的投稿时，保留地图并说明没有可展示的线路。

网页不直接播放 `.peakrun` 或 `.peakreplay`，录像请在游戏内观看。上传接口首次需管理员配置私有目录和服务，
未配置时返回 `503 storage-unconfigured`，不影响本地录像；页面没有直播轮询。
详见 [地图内线路图层](docs/community-map-layer.md)。

网站也可在本机启动，使用期间保持启动窗口运行。公开版本会匿名验证 GitHub 发布、
精确源码标签和 DLL 哈希，无需指定本机 DLL：

```powershell
node PeakTrailPlatform/tools/serve-site.mjs --open
```

也可在仓库根目录运行 `.\Start-Viewer.cmd`。若此前设置过 `PEAK_TRAIL_MEMORIES_DLL`，
先在启动终端取消开发覆盖变量：`Remove-Item Env:PEAK_TRAIL_MEMORIES_DLL -ErrorAction SilentlyContinue`。
已发布构建不能以本机文件代替。开发描述符与打包 profile 见
[下载与验证说明](docs/memories-download-preview.md)。

直接双击 `index.html` 会被浏览器阻止加载解析模块。

### 可选：导入已有旧足迹日志

网站继续保留「导入旧日志」。选择旧 `PeakTrailHistory.ndjson` 或 `PeakTrailRecordings` 总目录；
这些是原 PeakTrailRecorder 的文件，新的回忆录 Mod 不输出 NDJSON。旧查看器会：

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

原 Recorder `0.3.0` 日志没有装扮事件，因此无法恢复当时的套装；已有新版旧足迹日志中的
装扮事件仍可显示。升级回忆录不会替旧日志补写装扮。

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
node PeakTrailPlatform/tools/stage-site.mjs --preview --profile pages
```

每日轮换只更新关卡索引，不需要每天重新建模。游戏更新后需要为新 build 重新生成，历史
build 的包保留供旧日志使用；Pages 每次只加载当前所选局次的包。

`finalize-offline-maps.mjs` 将 GLB 额外做无损 gzip、签名并登记；`--slot 16` 可只登记一套。
`--replace-build` 要求完整 21 套，备份原 catalog 后，只替换同 build 的旧绘制版本，原文件
仍留在本机。页面逐关解压，三角面、法线、UV 和纹理不损失。打包会检查整站不超过
保守的 10 亿字节预算，避免超过 [GitHub Pages 容量限制](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)。

### 可选：运行时核验捕获

此维护命令仅属于保留的旧 `PeakTrailRecorder`，不是新回忆录 DLL 的录制快捷键。
维护者运行旧工具、进入真实加载的岛屿后按 `F8`，等待 BepInEx 日志出现
`Map pack complete`。输出默认位于：

```text
C:\Program Files (x86)\Steam\steamapps\common\PEAK\BepInEx\PeakTrailMapPacks\
```

用起点、营火、高点等至少三个分散地标确认路线和地图一致，再登记通过验收的包：

```powershell
node PeakTrailPlatform/tools/register-map-pack.mjs "<F8 导出的完整目录>" --activate-build
node PeakTrailPlatform/tools/validate-data.mjs
node PeakTrailPlatform/tools/stage-site.mjs --preview --profile pages
```

不要在同一个游戏进程里强制轮流加载 21 个场景；场景生命周期会触发 Photon、生成器和持久单例。
批量建设地图库使用上面的离线工具，F8 只用于正常加载场景的比对。

## 4. 资源与部署

只克隆代码不会得到游戏资源；正式资源保存在总目录内的 `local/assets`，由 `.gitignore`
排除。网页构建时仍将获准资源嵌入站点。当前 0.8.0 从公开 Release 核验 DLL、源码 tag 和
build-manifest，不能提供本机 DLL 替代。服务器打包默认 2 GB；Pages 打包显式使用
`--profile pages` 保留 1 GB 门限。详见 [下载与验证说明](docs/memories-download-preview.md)。

代码检查不需要真实资源。每日更新与 Pages 流程分别由仓库变量 `PEAK_DAILY_ENABLED`
和 `PEAK_PAGES_ENABLED` 显式启用，默认关闭。上线前先确认分发范围，并配置独立资产
取回步骤；不要为使 Actions 通过而强制提交私人日志或大型游戏资源。详见根目录 README。

## 隐私

回忆录录像留在本机；手动分享只发送筛选后的轨迹和昵称，不传原始录像、骨骼、物品、外观、
声音或原始 Steam ID。审核后其他人可以看到昵称和行程，分享前征得同局参与者同意。
旧足迹日志可能保留稳定平台 ID 与详细游戏状态，网页只在浏览器中解析导入文件，不自动上传。
