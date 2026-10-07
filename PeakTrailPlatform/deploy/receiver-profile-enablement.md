# 正式服务器发布与一次性轨迹服务安装

2026-10-07 已通过现有严格 SSH alias `peak-trail` 将轨迹服务候选传到 owner 的 `~/peak-trajectory-service-review`。只准备了该 owner 目录，尚未安装 root 配置、发布站点或重启服务。

- 历史轨迹服务：`enable-trajectory-service.sh`、`live-start.sh`、`peak-trail-live.service`、`trajectory-service.sha256`。
- 减少交互操作的最终 wrapper：`enable-trajectory-service-once.sh`，已加入同一 SHA 清单。

已改用仓库内明确的 `site-build-profile.json` 服务器配置。现有 root-owned receiver 无参数调用 staging 即可读取它，**不需要安装或修改 receiver**；早前发送的 receiver upgrade 命令可以跳过。固定仓库、环境白名单、精确 main 提交、部署锁、原子切换、文件/资源/DLL 校验及回滚逻辑保持原状。

代码、静态站与每日地图仍走 push → Actions → receiver。`server` 的静态文件预算明确为 **2,000,000,000 字节**，Pages workflow 明确选 `pages`，保持 **1,000,000,000 字节**。正式发布验证公开回忆录 Release 和对应 DLL，不用 `--preview` 绕过发布检查。

新的轨迹持久化需要 root 安装 unit/launcher 和私有目录；目前 owner `sudo -n` 及 `sudo -l -n` 均要求密码。现有受限 CI 仅能重启固定服务，不能安装这些管理员配置。

待经过完整测试的 Web 提交已正式发布，并确认公开 `/release.json` 为其完整 40 位提交后，owner 在自己的交互终端执行（sudo 密码仅输入该终端）：

```sh
cd ~/peak-trajectory-service-review
sha256sum --check trajectory-service.sha256
sudo sh ./enable-trajectory-service-once.sh EXACT_40_HEX_PUBLISHED_WEB_COMMIT
```

wrapper 在任何 `prepare` 副作用之前核对当前精确提交和功能模块，然后在同一个 sudo 进程中调用既有 prepare、自动提取 receipt，再调用 activate。activate 在部署锁内独立重查精确提交和原配置；未发布、已变化或校验失败即停止。一次交互 sudo 即可完成，不需要手动复制 receipt 或再次认证。

保留先 prepare、之后再 activate 的分阶段用法，适合源码发布前预先准备。只有管理员在自己的终端执行：

```sh
sudo sh ./enable-trajectory-service.sh prepare
# 记下该命令打印的确切 Prepared receipt；等待实际发布完成。
sudo sh ./enable-trajectory-service.sh activate /var/backups/peak-trail-trajectory/EXACT_PREPARE_RECEIPT EXACT_40_HEX_WEB_COMMIT
```

这两个参数由实际 prepare 收据和正式发布结果填写；不能提前用本机 HEAD 或拟发布提交代替。激活只更新 `peak-trail-live.service` 和固定 launcher，检查健康与轨迹分组接口；失败恢复此前服务配置。它不处理 Nginx、其他站点或真人录像，也不批准投稿。

若代码先发布而服务尚未激活，新的 route GET/POST 会返回 `503 route-storage-unconfigured`。网站可先更新下载、每日地图和直播隐藏，但不能把轨迹收集或空分组接口称为已经可用。成功激活后再核对 HTTPS health 与 route-groups；投稿默认待审核。

检查 SHA 和语法只证明待审文件未损坏，不能替代真实安装及上线验证。
