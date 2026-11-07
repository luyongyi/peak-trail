# 统一网页与导航发布

日常发布只有一个入口：提交到 `main`。GitHub Actions 完成代码、接口、制品和迁移测试后，由受限部署账号构建新版本，原子切换 `current`，重启 Web 服务并检查健康；检查失败则恢复上一版。

| 更新内容 | 发布来源 |
| --- | --- |
| 地图页面、直播跟随、导航页、导航历史 | `web/` |
| 房间查询、鉴权、下载代理 | `server/packet-replay-api.mjs`，随现有 Web 服务部署 |
| Windows 回放包 | GitHub Release 的版本制品，由 `data/packet-replay/release.json` 固定地址、大小和 SHA-256 |
| 3.0.1 地图资源 | 既有只读资源目录，继续校验与复用 |

页面不再由 `/opt/peak-packet-replay/site-overlay` 覆盖，`record.html` 也不再由独立服务提供。已有 API 路径、房间号鉴权、本机查询历史、录像存储和保留策略保持兼容。新浏览器不获取全站房间列表。

## 一次性切换

先发布本提交：浏览器资源与现有覆盖层内容一致，旧接收器可以正常部署；新导航 API 默认关闭，原服务继续处理请求。构建产物 `deployment/unified-web.json` 用于证明迁移依赖已经发布。

再以 owner 身份运行已经打包和预检的 `migrate-unified-web.py apply`。它只修改发布接收器、当前站点的 Nginx 路由，以及 `peak-trail-live.service` 的专用 drop-in：

- 导航页改为从 `current` 读取，两个导航 API 前缀切到现有 Web 服务。
- systemd 为 Web 服务读取既有 `web.env` 并显式启用导航 API；脚本不读取或显示环境文件内容。
- 接收器保留 3.0.1 资源检查、发布锁、原子切换、健康回滚和旧版本保留；移除旧覆盖层及固定 ZIP 路径。
- 先备份、校验配置、启动新 API，健康通过后切换代理。任何一步失败均恢复原配置。

这次需要管理员权限，因为现有配置由 root 管理。不会给 GitHub Actions 任意 sudo 权限；后续上述日常更新不再修改 root 文件。

迁移后，Actions 每次都会检查 Web 和导航 API 两个健康端点。手动回退只能选择含统一发布标记的版本。原独立桥接服务及旧覆盖层暂留作迁移回滚材料，不再提供对外入口。

## 更新回放组件

1. 构建并验证 Windows 分发包，使用新版本号，例如 `2026.11.07.1`。
2. 发布到本仓库的 `packet-replay-windows-<版本>` Release，资产名保持 `peak-packet-replay-windows.zip`；不要覆盖旧版本资产。
3. 更新 `data/packet-replay/release.json` 的版本、地址、字节数及 SHA-256，运行 `node PeakTrailPlatform/tools/check-packet-replay-download.mjs --public`。
4. 提交到 `main`。构建时验证完整包和必要文件，再发布到网站原下载地址。

仓库和制品只包含可公开的代码与分发文件。Steam 凭据、管理员访问码、采集录像和本机游戏程序集不得入库。

## 保持独立的部分

Steam 认证与 Photon 采集器不随 Web 发布重启。正在录制的房间会继续采集；Web 切换会短暂重连，正在进行的下载可重试。管理员登录会话在 Web 重启后需要重新登录，普通房间导航无需登录。

首次 Steam 扫码、采集器本体/原生依赖升级和系统配置变更仍属于独立运维操作。本次没有把这些权限授予公开仓库的部署流程。
