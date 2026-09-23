# PEAK Trail

一个 Mod 记录多人足迹，静态网页按日期、局次与关卡回放。这个独立目录只管理 PEAK Trail，
不包含原下载目录中的其他 Mod、模板测试或工具项目。

## 目录与 Git 边界

```text
PeakTrail/
├── .git/                    本地 Git 仓库
├── PeakTrailRecorder/       唯一需要安装的 Mod 源码
├── PeakMapExporter/         编入 Recorder 的地图导出实现与测试
├── PeakTrailPlatform/       网页、协议、构建工具和地图索引
├── .github/workflows/       代码检查；每日更新和 Pages 部署需显式启用
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

界面只以 **iPad 和桌面浏览器** 为适配与验收目标，不维护手机版。iPad 竖屏首页
采用两列四关，横屏和桌面采用四列；回放页竖屏上下分区，横屏保留地图加侧栏。
平板布局按 744–1100 CSS 像素宽的竖屏窗口适配；更窄的分屏窗口不单独适配。

双击根目录的 `Start-Viewer.cmd`，或在这里运行：

```powershell
node PeakTrailPlatform/tools/serve-site.mjs --open
npm --prefix PeakTrailPlatform/web test
npm --prefix PeakTrailPlatform/web run check
node --test PeakTrailPlatform/tools/tests/*.test.mjs
node PeakTrailPlatform/tools/validate-data.mjs
dotnet build PeakTrailRecorder/PeakTrailRecorder.slnx -c Release -p:DeployModFiles=false
```

当前验证环境为 Node.js 24、.NET 10 SDK（另有 .NET 8 runtime 运行测试）、Python 3.12。
离线工具环境可用 `PeakTrailPlatform/tools/offline-maps/setup-env.ps1` 重建。
构建 Mod 仍需本机已安装 PEAK/BepInEx；游戏 DLL 不复制进源码仓库。
新目录构建不会自动覆盖游戏里的插件。

## 本局分支与玩家头像

首页以统一手绘风格呈现当前四关，Roots 中文名称为「森蕈」。终章插画可展开查看，
随真实路线选择熔炉或城塞，分别表现火山与高塔的内部攀登空间。插画只负责氛围，
不作为地图或足迹定位依据；点击四关仍进入对应的真实地图。轮换数据过期会明确显示
「上次确认的四关」，不会按日期猜测关卡；导入历史足迹也不会改变首页当前路线。

9 幅 PNG 存于 `local/assets/home-art`，继续由 Git 忽略。生成模式与完整提示词见
`PeakTrailPlatform/docs/home-art-prompts.json`；恢复资源备份时需包含这些插画。

登山路线最后两关按实际分支配对：**火山 → 熔炉** 或 **雾岛 → 城塞**，不会将两条
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

当前没有配置 Git 远端，也没有上传 GitHub。GitHub 代码检查不需要大型资源；自动每日更新
和 Pages 发布默认关闭。资源存储/取回方案与公开分发范围确认后，再配置并启用对应流程。

## 日志与旧目录

`local/recordings` 是迁移时的副本，不是对正在写入文件的目录链接。游戏中已安装的 Recorder
仍按原配置向 `PEAK/BepInEx/PeakTrailRecordings` 写日志；本次没有修改游戏配置或移动游戏文件。
可继续直接选择游戏里的总目录回放，新产生的日志不会被 Git 跟踪。

原 `BepInExTemplate-main` 目录完整保留。今后的 PEAK Trail 开发以此独立目录为准。
详细使用说明见 [快速验收](PeakTrailPlatform/QUICKSTART.zh-CN.md)。

## 第三方文件

第三方代码保留各自许可证，见 [第三方说明](THIRD_PARTY_NOTICES.md)。本次整理没有替用户
为原创代码选择新的开源许可；本机游戏资源的存在也不表示其获准公开分发。
