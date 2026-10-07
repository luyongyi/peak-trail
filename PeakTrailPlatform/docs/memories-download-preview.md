# 回忆录 DLL 下载与验证

网站下载为 **PEAK Memories v0.8.0 实验版**，已公开为 GitHub prerelease。站内文件是
`downloads/memories/0.8.0/PeakReplayLab.dll`，来自
[v0.8.0 发布页](https://github.com/luyongyi/peak-memories/releases/tag/v0.8.0)。公开发布不等于游戏内显示、性能和多人录制已经实测。

`data/memories/release.json` 固定版本、文件名、大小、SHA-256，以及 `tag`、
`sourceRevision`、`releaseUrl`、`artifactUrl`；公开构建使用 `channel: release`、
`releaseStatus: published`、`sourceDirty: false`。

```text
FileVersion: 0.8.0.0
InformationalVersion: 0.8.0+7c1555992ad00bd5bb741dd133b0e47609ebcaa8
Size: 27,560,448 bytes
SHA256: 908074d4c5c6c43c4f5c41cbfd832eb7576f64afb0e6bc56601b4181b815344e
```

默认打包匿名核对 GitHub API 的已公开状态、精确 Git tag 对应的提交、发布附件
`build-manifest.json` 和 DLL 的大小与 SHA-256。任何不一致均在替换 `site-dist` 前失败。
公开描述符不接受本机 DLL 覆盖；不读取邻近日志、配置、录像或游戏程序集。

## 网站打包

```powershell
node tools/check-memories-download.mjs --public
node tools/stage-site.mjs
node tools/serve-site.mjs --port 4178
```

仓库的 `tools/site-build-profile.json` 明确选择 `server`，公开静态资源总量上限为
2,000,000,000 字节；缺少该文件时仍默认 `pages` 的 1,000,000,000 字节门限。
既有服务器 receiver 无需更改启动参数。Pages workflow 显式指定
`stage-site.mjs --profile pages`，避免误用服务器容量门限。

本地预览使用 `pages` profile；`server` 与 `--preview` 组合会被拒绝。预览不会执行部署：

```powershell
node tools/stage-site.mjs --preview --profile pages
```

DLL 和下载描述符使用 `Cache-Control: no-store`；DLL 响应指定
`application/octet-stream` 与 `Content-Disposition: attachment; filename="PeakReplayLab.dll"`。
HTML 中下载路径与保存文件名必须匹配当前描述符。

## 后续开发构建

尚未公开的本地开发构建须使用独立开发描述符（`development`、`unreleased`、
`sourceDirty: true`），并显式提供与该描述符哈希一致的单个 DLL：

```powershell
node tools/serve-site.mjs --port 4178 --profile pages --memories-dll 'C:/path/to/PeakReplayLab.dll'
node tools/stage-site.mjs --preview --profile pages --memories-dll 'C:/path/to/PeakReplayLab.dll'
node tools/check-memories-download.mjs --dll 'C:/path/to/PeakReplayLab.dll'
```

也可设置 `PEAK_TRAIL_MEMORIES_DLL`，但已发布描述符必须先取消该本地覆盖变量。
开发版没有远端下载回退；`--public` 验证和公开打包会拒绝它。默认不带 `--public` 的
检查只验证元数据，不声称验证 DLL 字节或公开源码。

旧 Recorder 加载器保留独立验证；当前页面已使用回忆录链接，选择
`--download-product recorder` 会因页面下载路径不匹配而失败。

## 路线服务

静态网站发布不会替管理员安装 systemd unit 或私有投稿目录。首次启用轨迹上传需按
[服务器启用说明](../deploy/trajectory-enablement.md) 完成一次配置；配置前接口返回
`503 storage-unconfigured`，本地录像仍可使用。投稿默认待审核，只有审核通过且完整走完的
个人关卡路线会显示在地图内。

```powershell
node --test tools/tests/memories-release.test.mjs tools/tests/memories-public-release.test.mjs tools/tests/stage-site.test.mjs
```
