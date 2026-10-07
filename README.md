# PEAK Trail

每日 3D 地图与玩家线路网站。当前提供 **PEAK 回忆录 Mod 0.8.0 实验版**：
在游戏内录制、回看旅程，手动分享精简轨迹；审核通过的完整关卡路线可在网页地图中查看。
回忆录独立维护于 [peak-memories](https://github.com/luyongyi/peak-memories)，本站 0.8.0 下载已公开为 GitHub 实验版 Release。
本目录管理网站、地图库和旧足迹日志兼容工具；网页不直接播放回忆录的 `.peakrun` 或 `.peakreplay`。

## 目录与 Git 边界

```text
PeakTrail/
├── .git/                    本地 Git 仓库
├── PeakTrailRecorder/       旧足迹／直播 Mod 源码，保留旧日志与维护工具兼容
├── PeakMapExporter/         编入 Recorder 的地图导出实现与测试
├── PeakTrailPlatform/       网页、协议、构建工具和地图索引
├── .github/workflows/       代码检查；每日更新与服务器部署带独立开关
└── local/                  同一个总目录内，但整个目录被 .gitignore 忽略
    ├── assets/
    │   ├── maps/packs/      21 套按 SHA-256 定址的正式地图资源
    │   ├── maps/working/    可重新生成的离线地图工作文件
    │   ├── game-assets/     游戏图标、角色模型与贴图
    │   └── home-art/        9 幅 AI 主题插画（非地图实景）
    ├── recordings/          迁移时复制的私人足迹快照
    ├── archives/            私人外观预览、旧 DLL 和资源审计报告
    └── python/.venv/        本项目的离线资源工具环境
```

`artifacts/`、`site-dist/`、`node_modules/` 等构建文件也被忽略。正式地图索引和合成测试
样本可以提交，地图、图标、角色模型等游戏派生资源与真人日志不提交。唯一随代码保留的
小型材质参数快照是 `tools/offline-maps/source-effect-materials.25306743.json`（位于
`PeakTrailPlatform/` 下），用于材质适配回归测试，不含模型、贴图或玩家数据。
资源不用 Git LFS，也不以子模块或目录链接
指回旧工作区；要完整备份项目，请连同 `local/` 一起备份。

## 启动与验证

界面支持 **手机、iPad 和桌面浏览器**。手机（320–743 CSS px）首页两列，
不足 360 px 时单列；回放页地图与玩家面板上下排列，底部保留时间轴和播放速度。
底部「玩家 / 地图」可直接切换查看位置；手机横屏使用单行顶栏和时间轴，为地图留出空间。
iPad 竖屏（744–1100 CSS px）首页两列、回放上下分区；横屏和桌面保留四列首页、地图加侧栏。
触屏环绕视角使用单指转向、双指缩放和平移；进入关内后可按住屏幕方向键移动与升降。
回忆录 DLL 只安装在 Windows 游戏电脑上，录像在游戏里观看。手机/iPad 可直接看网页地图与公开线路；
已有旧足迹日志仍可传到设备后用「导入旧日志」打开。

### 在地图里看大家的线路

从首页点击 **进入地图**，默认只显示铺满视图的地图。点击顶部「返回」旁的「路线与热力」，展开侧栏后选择「仅地图」「大家的路线」或「热力图」。
再次点击该按钮可收起侧栏并关闭图层。选择具体关卡后，可以按难度、高度层筛选；路线模式可单独显示或隐藏每位玩家的路径。
热力按已审核、完整通过当前关卡的个人路线统计，每条路线在同一空间格只计一次。
「所有关概览」只看整座山，需选择具体关卡才显示线路统计。

分享来源是独立 [Peak Memories](https://github.com/luyongyi/peak-memories) Mod 的完整录像库「上传轨迹」：
先在本地提取最多 10 Hz 的坐标、姓名和必要地图信息，确认后发送，不上传原始录像或 120 秒回忆片段。
待审核、未完整通关或未匹配当前地图版本/分支的数据不会叠到地图；不同记录组分别选择。
本地日志回放继续只在浏览器中解析。直播入口、演示和轮询默认隐藏。
操作与验证边界见 [地图内线路图层](PeakTrailPlatform/docs/community-map-layer.md)；正式上传服务仍需按管理员部署步骤启用。

网站默认核对已公开的 v0.8.0 Release、精确源码 tag 与下载文件哈希。本地预览直接运行以下命令，
不提供本机 DLL 覆盖；游戏资源仍从独立的 `PEAK_TRAIL_ASSET_ROOT` 读取：

```powershell
node PeakTrailPlatform/tools/serve-site.mjs --open
npm --prefix PeakTrailPlatform/web test
npm --prefix PeakTrailPlatform/web run check
node --test PeakTrailPlatform/tools/tests/*.test.mjs
node PeakTrailPlatform/tools/validate-data.mjs
dotnet build PeakTrailRecorder/PeakTrailRecorder.slnx -c Release -p:DeployModFiles=false
```

也可运行 `.\Start-Viewer.cmd`。若此前设置了 `PEAK_TRAIL_MEMORIES_DLL`，先取消该开发覆盖变量；
已发布构建始终从公开 Release 核验，不能以本地文件代替。

当前验证环境为 Node.js 24、.NET 10 SDK（另有 .NET 8 runtime 运行测试）、Python 3.12。
离线工具环境可用 `PeakTrailPlatform/tools/offline-maps/setup-env.ps1` 重建。
上面的 Recorder 构建命令只用于保留的旧日志／地图维护工具。新回忆录的构建见独立
[开发说明](https://github.com/luyongyi/peak-memories/blob/main/docs/development.md)。
构建 Mod 仍需本机已安装 PEAK/BepInEx；游戏 DLL 不复制进源码仓库，构建不会自动覆盖插件。

### 回忆录 Mod 0.8.0 实验版

关闭游戏，将本站的 `PeakReplayLab.dll` 放入 `BepInEx/plugins/`。升级只替换同名 DLL；
如装过旧足迹／直播 Mod，移走 `PeakTrailRecorder.dll`，保留旧日志、录像及配置，不同时运行两套。
当前下载为 26.3 MiB 已发布实验版，游戏内显示、性能和多人录制仍待实测。

片段缓存与完整录制可以同时使用：

- **完整录制独立开关**：主菜单「回忆录 → 录制方式」开启后，进岛自动写入 `.peakrun`；
  F4 开启／关闭，关闭时封存录像，设置会保留。返回主菜单后等封存完成。
  文件位于 `BepInEx/PeakReplayLab/Recordings/`。
- **最近 120 秒片段**：完整录制开着或关着，都能用 F6 随时保存最近最多 120 秒为 `.peakreplay`。
  切换完整录制不清空缓存，未保存的缓存退出后丢弃。
  文件位于 `BepInEx/PeakReplayLab/Memories/`。

从游戏主菜单回忆录选择录像回放；底部拉手可展开控制台，H 收起／展开，观看时不再录制。
完整录像详情的「上传轨迹」先筛出最多 10 Hz 坐标、昵称和必要地图信息，确认后上传；
原始录像不发送，120 秒片段与未完成文件不支持投稿。
新录像格式为 Schema 14，继续读取 10–13；异常 `.partial` 不冒充完整可播放录像。
配置位于 `BepInEx/config/cn.mylus.peakreplaylab.cfg`，升级时保留。
详细安装和验收见 [快速验收](PeakTrailPlatform/QUICKSTART.zh-CN.md)。

## 本局分支与玩家头像

首页以统一手绘风格呈现当前四关，Roots 中文名称为「森蕈」，Tropics 为「雨林」。终章插画默认展开，
随真实路线选择熔炉或城塞，分别表现火山与高塔的内部攀登空间。插画只负责氛围，
不作为地图或足迹定位依据；点击四关仍进入对应的真实地图。轮换数据过期会明确显示
「上次确认的四关」，不会按日期猜测关卡；导入历史足迹也不会改变首页当前路线。

9 幅 PNG 存于 `local/assets/home-art`，继续由 Git 忽略。生成模式与完整提示词见
`PeakTrailPlatform/docs/home-art-prompts.json`；恢复资源备份时需包含这些插画。

登山路线最后两关按实际分支配对：**火山 → 熔炉** 或 **雾沼 → 城塞**，不会将两条
线路串在一起。游戏的每对关卡共用同一个 biome 枚举，因此不能按枚举名称直接命名。
当前 21 套资源的分支证据在 `PeakTrailPlatform/data/maps/routes.25306743.json`，绑定
确切地图 ID 与源场景哈希。构建网页时附加该元数据，不改动原始网格或地图身份。
虚空保留为手动选择的额外区域，不算作第六关。

Recorder 0.5.0 在日志中记录运行时真正选择的路线，网页优先使用该记录。旧日志只在
地图版本/场景匹配时采用离线配置，并明确标注来源；如果记录与底图分支冲突，隐藏
冲突关卡的底图，但保留原始足迹。分支记录不代表各玩家所属关卡。

玩家卡片和地图当前位置展示游戏原始头部、脸部与帽子，并随时间轴中的外观记录改变。
外观缺失或尚未同步时只显示姓名占位，不把当前外观补写成历史。0.4.0 已记录的外观可
直接使用；0.5.0 的新增采集是路线信息。这里复现的是选择的脸型，不是逐帧面部动画。

## 资源恢复与部署

只克隆 Git 仓库不会得到游戏资源或私人日志。把独立备份中的 `local/assets` 恢复到同名
位置后再运行 `validate-data.mjs` 和 `stage-site.mjs`。也可设置 `PEAK_TRAIL_ASSET_ROOT`
指向另一份资源目录；默认始终使用本项目的 `local/assets`。

构建出的网页包含 `data/maps/packs`、`data/game-assets` 和 `data/home-art`；构建
只复制已登记、已验证的资源，不会带上 `local/recordings` 或 `local/archives`。

代码仓库为 [luyongyi/peak-trail](https://github.com/luyongyi/peak-trail)，GitHub 代码检查不需要大型资源。
服务器发布采用独立部署密钥、严格主机指纹验证和原子版本切换。站点为 `https://peak.mylus.cn`，
网页与路线 `/api/` 使用同一 HTTPS 域名；后台进程只监听服务器回环地址，不直接开放 8787。
实时追踪代码保留，网页入口和轮询默认隐藏；历史轨迹接口的私有持久存储须由管理员单独启用。
服务器资源与部署权限验证完成后才启用 `PEAK_SERVER_ENABLED`，Pages 保持关闭。
准备脚本不等于服务器已经上线；实际启用状态以 Actions 配置与运行结果为准。
首次配置、资源边界与剩余操作见 [服务器部署说明](PeakTrailPlatform/deploy/README.md)。

首页提供回忆录 Mod 下载和三步安装教程（BepInEx 5 Windows x64 → 放入 DLL → 游戏内录制与回放）。
源码链接指向 `peak-memories` 与网站仓库，并提供真实的
[v0.8.0 发布页](https://github.com/luyongyi/peak-memories/releases/tag/v0.8.0) 和 GitHub 备用下载。
网站打包核对公开 Release、精确源码 tag、build-manifest 及实际 DLL 的 SHA-256；
不提交 DLL、游戏依赖或个人配置到 Git。
后续回忆录发布流程见 [发布说明](https://github.com/luyongyi/peak-memories/blob/main/docs/releases.md)。

## 日志与旧目录

`local/recordings` 是迁移时的旧足迹日志副本，不是对正在写入文件的目录链接。
旧 `PEAK/BepInEx/PeakTrailRecordings` 文件继续可从网页「导入旧日志」查看；卸载旧 Recorder
无需删除这些文件。新回忆录使用 `PeakReplayLab/Recordings` 与 `Memories`，在游戏内回放。

原 `BepInExTemplate-main` 目录完整保留。今后的 PEAK Trail 开发以此独立目录为准。
详细使用说明见 [快速验收](PeakTrailPlatform/QUICKSTART.zh-CN.md)。

## 第三方文件

第三方代码保留各自许可证，见 [第三方说明](THIRD_PARTY_NOTICES.md)。本次整理没有替用户
为原创代码选择新的开源许可；本机游戏资源的存在也不表示其获准公开分发。
