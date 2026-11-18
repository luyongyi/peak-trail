# 统一网页与导航发布

日常发布只有一个入口：提交到 `main`。GitHub Actions 完成代码、接口、制品和迁移测试后，由受限部署账号构建新版本，原子切换 `current`，重启 Web 服务并检查健康；检查失败则恢复上一版。

## 本地验证后发布

每台开发机在仓库根目录安装一次推送检查，需要 Node.js 24、Git 和 `tar`。

```powershell
node PeakTrailPlatform/tools/web-release-check.mjs install
```

改页面时先用 `npm --prefix PeakTrailPlatform/web start` 打开本地预览，走一遍改动涉及的页面和交互。提交后推送 Web 相关改动到 `main` 时，Git hook 会从待推送提交取得干净的源码副本，再运行页面静态检查、网页测试、站点构建样例和本机 HTTP 接口测试。失败时 Git 会中止这次推送。开发中可随时运行 `node PeakTrailPlatform/tools/web-release-check.mjs check`。

Actions 会独立重跑这些检查，并验证 Linux 部署和下载包。安装了精简保留策略的服务器会在新版本通过健康检查后回收退役发布。如果上线后发现问题，回退对应 Git 提交并按同样流程重新部署。

## 录像空间

采集器以录像目录所在磁盘的可用空间计算，默认预留 15 GiB 给服务器上的其他服务。每局原始录像上限为 256 MiB，服务还会预留封包开销。新房间成功接入时，如需腾出空间，按封存时间从旧到新回收可回收的录像。网页的录像空间提示为只读估算，录制中的录像和正在下载的 ZIP 受保护。

| 更新内容 | 发布来源 |
| --- | --- |
| 地图页面、直播跟随、导航页、导航历史 | `web/` |
| 房间查询、鉴权、下载代理 | `server/packet-replay-api.mjs`，随现有 Web 服务部署 |
| Windows 回放包 | GitHub Release 的版本制品，由 `data/packet-replay/release.json` 固定地址、大小和 SHA-256 |
| 3.0.1 地图资源 | 既有只读资源目录，继续校验与复用 |

页面不再由 `/opt/peak-packet-replay/site-overlay` 覆盖，`record.html` 也不再由独立服务提供。已有 API 路径、房间号鉴权、本机查询历史、录像存储和保留策略保持兼容。新浏览器不获取全站房间列表。

## PEAK 3.1 导航（2026-11-16）

新建导航使用 8 位房间号，Photon 匹配版本为 `3.1_2.49`。旧 6 位房间号继续用于查询、历史和 ZIP 下载，不再发起新采集。PEAKNET1 的房间字段仍采用原来的长度前缀，读取边界扩展到 8 字节，保留旧录像编码。

地图 build `26542162` 具有独立的 208 个 manifest 和签名身份。等价证明绑定之前的完整证明，并重新验证当前 7 个地图包、地图顺序、地图选择代码及外部材质；部署仍按 SHA-256 校验实际复用资产。3.0.1 地图继续支持历史导航。新的每日地图默认查询游戏接口版本 `3.1`。

3.1 暂使用玩家位置标记，未把旧版角色模型冒充新版资源。这个发布模式只允许 catalog 中明确声明、且匹配固定地图 plan/receipt 的 build；其他发布仍要求对应版本的完整角色资源。

Windows 下载包暂保留 `2026.11.09.2`，仅支持 PEAK 3.0.1。3.1 的录像 ZIP 可先下载保存，游戏内回放组件需要后续适配。修改导航页不代表更新了回放 DLL。

网页、API、地图元数据继续由正常 Actions 流程发布。私有采集服务及其 3.1 profile 独立事务升级，保留 Steam 凭据、`Peak_Map` 昵称、同房去重、并发和每位房主两份／七天的保留策略；升级不主动认证或加入房间。

## 一次性切换（2026-11-08 已完成）

线上已完成这次配置迁移。以下保留迁移设计，日常网页、API 和下载版本更新不需要再次执行迁移或手动 SSH。

先发布本提交：浏览器资源与现有覆盖层内容一致，旧接收器可以正常部署；新导航 API 默认关闭，原服务继续处理请求。构建产物 `deployment/unified-web.json` 用于证明迁移依赖已经发布。

再以 owner 身份运行已经打包和预检的 `migrate-unified-web.py apply`。它只修改发布接收器、当前站点的 Nginx 路由，以及 `peak-trail-live.service` 的专用 drop-in：

- 导航页改为从 `current` 读取，两个导航 API 前缀切到现有 Web 服务。
- systemd 为 Web 服务读取既有 `web.env` 并显式启用导航 API；脚本不读取或显示环境文件内容。
- 接收器保留 3.0.1 资源检查、发布锁、原子切换、健康回滚和旧版本保留；移除旧覆盖层及固定 ZIP 路径。
- 先备份、校验配置、启动新 API，健康通过后切换代理。任何一步失败均恢复原配置。

这次需要管理员权限，因为现有配置由 root 管理。不会给 GitHub Actions 任意 sudo 权限；后续上述日常更新不再修改 root 文件。

迁移后，Actions 每次都会检查 Web 和导航 API 两个健康端点。手动回退只能选择含统一发布标记的版本。原独立桥接服务及旧覆盖层暂留作迁移回滚材料，不再提供对外入口。

## 更新回放组件

1. 在构建机使用私有项目的 `tools/Publish-InGamePlayer.ps1` 生成并验证 Windows 分发包，使用新版本号，例如 `2026.11.08.1`。新包只含游戏内回放 DLL、说明和许可证，不再分发 CMD、PowerShell 启动器或独立游戏副本工具。
2. 发布到本仓库的 `packet-replay-windows-<版本>` Release，资产名保持 `peak-packet-replay-windows.zip`；不要覆盖旧版本资产。
3. 打开 GitHub Actions 的 **Publish Windows replay download**，选择 `main`，填入分发包版本号，选择它支持的 PEAK 游戏版本并运行。
4. 工作流依据 GitHub 提供的大小与 SHA-256 验证下载，并核对 ZIP 内声明的游戏版本与 build。通过后自动更新 `data/packet-replay/release.json` 并提交到 `main`。
5. 工作流显式启动 **Check PEAK Trail code**；完整检查通过后，现有部署流程将网页、API 和选定下载包一起发布到网站。后一个工作流成功才表示上线成功。

重复填写当前版本也会重新验证并触发检查与部署，不产生多余提交。同版本资产被替换时会拒绝更新；应使用新版本号。若提交时 `main` 已被其他更新推进，正常 push 会安全失败，不强推，重新运行即可。

该入口发布构建机生成的 ZIP。当前验证器接受 PEAK 3.0.1 / build 26155610 和 PEAK 3.1.0 / build 26542162。提交描述符后，工作流显式触发网站检查与部署。

新包固定包含 `BepInEx/patchers/PeakPacketReplay.Loader.dll` 和 `BepInEx/plugins/PeakPacketReplay/PeakPacketReplay.dll`。玩家先安装 BepInEx 5，再合并组件文件夹，正常启动游戏，从主菜单选择录像 ZIP。验证器仅为已发布的 `2026.10.31.2` 保留旧格式读取；后续版本必须使用游戏内 DLL 格式。网页说明与新下载描述符须一同发布。

需要在本机预检时，可运行：

```sh
node PeakTrailPlatform/tools/update-packet-replay-release.mjs --version 2026.11.08.1 --game-version 3.0.1
```

它仅验证已有公开制品并更新本地描述符，不提交、不部署。

仓库和制品只包含可公开的代码与分发文件。Steam 凭据、管理员访问码、采集录像和本机游戏程序集不得入库。

## 保持独立的部分

Steam 认证与 Photon 采集器不随 Web 发布重启。正在录制的房间会继续采集；Web 切换会短暂重连，正在进行的下载可重试。管理员登录会话在 Web 重启后需要重新登录，普通房间导航无需登录。

首次 Steam 扫码、采集器本体/原生依赖升级和系统配置变更仍属于独立运维操作。本次没有把这些权限授予公开仓库的部署流程。

## 按昵称查找录像

网页与 Windows 游戏内组件共用 `POST /api/navigation/replays/search`，JSON 请求为 `{ "hostName": "录制时的房主昵称" }`。仅返回该昵称匹配的已完成、尚未过期且 ZIP 存在的录像，字段为 `hostName`、`history`、`hasMore`；单次最多 100 条，同名记录继续用房间号和时间区分。空查询不返回全站目录，不包含活动房间、Steam 身份或管理凭据，也不会启动采集。

桥接调用 Collector 的只读 `GET /api/v1/replays/search?hostName=...`，在完整存储中先按昵称过滤再限制数量；不能用全站最近 100 条代替昵称查询。安装新 Collector 接口后，再通过 Actions 一起发布网页与组件包。下载沿用既有房间号与特征码 ZIP 路径。

生产环境仍走网站 HTTPS（443），内部 Web 服务仍为 8787，Collector 仍只监听 127.0.0.1:17863，不增加公网端口。开发时游戏组件的 `[Replay] ServiceOrigin` 可指向本机 Web 服务（如 `http://localhost:8787`）；Web 与 DLL 使用同一接口。DLL 在游戏主线程读取原生 `NetworkingUtilities.GetUsername()` 预填昵称，只发送查询昵称，不发送 Steam 票据。
