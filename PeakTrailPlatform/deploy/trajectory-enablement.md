# 将历史轨迹接口启用到现有服务器

这是一套待管理员执行的增量安装方案；当前请求只做了只读核验和本地准备，未部署、重启或真实上传。

## 已核验的现状（2026-10-07）

- 本机已有 `peak-trail` SSH alias，owner `mylu` 可以使用已配置密钥和严格主机指纹验证免交互登录。
- 生产和 GitHub `luyongyi/peak-trail` 的 `main` 均为 `792b4d0c6cbdc2f32fc4dd05bb86804b21bcfaec`；`/release.json` 显示部署于 2026-09-28。
- GitHub `PEAK_SERVER_ENABLED=true`，已有 `production` 环境的受限部署密钥；main 的通过测试提交会由 receiver 原子发布并重启唯一 `peak-trail-live.service`。
- 该服务正在运行，用户为 `peaklive`；root-owned `/srv/peak-trail/live-start.sh` 目前只启动直播服务。unit 为 `/etc/systemd/system/peak-trail-live.service`，现有 512 MiB 限额、`ProtectSystem=strict`，没有 `StateDirectory` 或可写路径。
- 私有 `/var/lib/peak-trail-routes` 不存在，新 API 当前返回 404。磁盘约 27 GiB 可用，内存约 2.7 GiB available，满足待审模板 768 MiB 上限。
- owner 的 `sudo -n` 查询需要密码，现有受限 CI 账户只获准重启服务。**不能通过现有免交互身份安装 root-owned unit/launcher 和私有目录。** 由 owner 在自己的交互服务器终端执行下面的 `sudo`；不向聊天或日志提供密码。

本地 `PeakTrail` HEAD 另为 `88d4884175d5d0aad142bf9251f6622574dd3387`，包含早前回忆录提交，并有已有的 camera/scene/geometry 未提交修改。不能直接将整个工作树发布。本次最小发布必须从远端 main 建立干净分支/工作树，只移入本功能文件和明确补丁；尤其 `web/src/app.js` 与 `scene.js` 只移入直播开关、地图内线路图层接入及渲染改动，不能整文件夹带先前相机修改。

## 两阶段管理员脚本

候选文件为 `enable-trajectory-service.sh`、`enable-trajectory-service-once.sh`、`live-start.sh`、`peak-trail-live.service`、`trajectory-service.sha256`。管理员先核对其内容和 SHA256，再将这五个明确文件放到服务器 owner 的候选目录。不要把本地 `local/`、录像、日志或私钥作为安装包。

正常代码仍由 push 后的 Actions 自动部署；仓库 `tools/site-build-profile.json` 明确选择 server 的 2 GB 预算，Pages workflow 保持显式 pages 的 1 GB 预算，现有 root-owned receiver 无需修改。正式代码发布后可使用一次 sudo 的 `enable-trajectory-service-once.sh EXACT_40_HEX_PUBLISHED_WEB_COMMIT`；它先核对线上精确提交，随后自动执行这两个阶段，见 [单次管理员安装说明](receiver-profile-enablement.md)。以下保留分阶段方法，适合先准备、稍后激活。

服务器 owner 的交互终端中：

```sh
cd ~/peak-trajectory-service-review
sha256sum --check trajectory-service.sha256
sudo sh ./enable-trajectory-service.sh prepare
```

`prepare` 检查固定 root 路径、原 service 用户和原配置；把原 unit/launcher 及候选文件保存到 root-only `/var/backups/peak-trail-trajectory/<timestamp>-<pid>`，创建 `peaklive:peaklive 0700` 私有目录。**它不替换正在使用的 unit/launcher，也不重启服务。** 因此当前源码还是旧版时，崩溃恢复或定时部署不会意外加载尚不匹配的新启动参数。记下打印的 receipt 路径。

之后只发布经过独立测试的本功能提交，通过既有 receiver 确认 `/release.json` 为该完整 40 位 commit。旧 launcher 会继续运行新源码，直到最后激活；这段间隔新接口返回 storage-unconfigured，不能宣称上线完成。

确认源码已发布后，在同一 owner 终端执行：

```sh
sudo sh ./enable-trajectory-service.sh activate /var/backups/peak-trail-trajectory/RECEIPT EXACT_40_HEX_FEATURE_COMMIT
```

脚本核验当前 `/release.json` 为指定提交、当前发布目录存在新 API 与地图内线路图层模块、候选文件与备份摘要一致、原安装配置未被其他人修改、私有目录归属/权限正确。它取得既有 `.deploy-lock`，原子安装两个固定目标，daemon-reload，并且只重启 `peak-trail-live.service`；验证安全 health 与 route-groups 返回格式。不会改 Nginx、证书、其他站点或其他服务，不会上传或批准任何录像。

若激活或验证失败，脚本恢复此前 unit/launcher 并尝试重启、验证旧配置；明确报告恢复失败。源码发布和私有投稿仍保留，不把服务配置恢复冒充站点源码回滚。备份与投稿目录不会递归删除。

成功后再通过 HTTPS 检查 `/api/health`、`/api/route-groups`，并从首页点击「进入地图」，切换「线路图层」的路线与热力选项；此时上传会默认待审核。对应构建地图尚未适配的投稿仍为 `waiting-map`，在地图内不叠加路线，不使用旧底图。

## 最小代码发布范围

运行时需包括 `server/trajectory-{contract,store,worker,api}.mjs`、`server/route-admin.mjs`、`server/live-server.mjs` 的接入改动；Web 为 `src/community-routes.js`、`src/community-route-model.js`、`src/community-map-panel.js`、`src/community-route-overlay.js`、共享 `src/route-collection-model.js`、`src/features.js` 及首页/样式/应用/场景接入补丁。若清理旧 `routes.html`、`routes.css`、`route-collection.js`，也要在部署验证和打包清单中撤销旧页面依赖；开发静态服务保留有界同源 GET API proxy。

连同相关测试、文档、unit/launcher、管理员脚本和摘要作为单独提交。`local/checks/trajectory-0.8.0/deployment-increment.json` 是前一轮本地验收记录，发布本轮功能前需重新核对明确文件清单；它不进入公开仓库。不要并入 camera-placement、follow-terrain、geometry-loader、室内跟随模块或旧回忆录目录的既有修改；`scene.js` 仅移入本轮线路图层所需补丁。

管理员脚本已在本地通过 Bash 语法检查；生产安装和真实流量验收仍需管理员完成，不能用语法通过替代上线结论。
