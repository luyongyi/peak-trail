# 发布首页可下载的 Recorder

编译 DLL 作为 GitHub Release 附件发布，不提交到 Git；不打包游戏程序集、BepInEx 本体、个人配置或日志。首页主下载由服务器同站提供，GitHub 附件作为备用。

## 发布顺序

1. 在已安装对应 PEAK/BepInEx 的电脑上构建并测试 Recorder，核对 DLL 实际版本、构建来源提交、字节数与 SHA-256。
2. 将原始 `PeakTrailRecorder.dll` 和校验文件发布到 `recorder-v<版本>` GitHub Release。标签指向 DLL 中记录的构建来源提交。不要覆盖已发布的同版本二进制；变更请升版本。
3. 更新 `PeakTrailPlatform/data/recorder/release.json`，填写精确版本、来源提交、大小、摘要、GitHub 版本化下载 URL 与 `downloads/recorder/<版本>/PeakTrailRecorder.dll`。
4. 同步首页下载链接/版本/大小及发行说明。首页回归测试会检查其与 manifest、源码版本一致。
5. 推送代码后 Actions 验证公开附件可下载且摘要匹配。部署预检再次拉取并校验，之后才将单个 DLL 放进静态网站。下载失败或不匹配会阻止新站点发布，不替换旧站点。
6. 发布后从线上同站下载地址读取并核对 SHA-256。网页更改不会自动替换玩家电脑上的 DLL，用户需退出游戏后手动更新。

## 本地预览

默认预览也会验证 GitHub 公开附件。无网络时，可为当前进程设置 `PEAK_TRAIL_RECORDER_DLL` 指向本地构建的 DLL；必须与 manifest 的大小及摘要完全一致。此变量只用于预检读取，不能绕过校验，也不会复制旁边的配置、依赖或日志。

```powershell
node PeakTrailPlatform/tools/check-recorder-download.mjs
node PeakTrailPlatform/tools/stage-site.mjs
```

第一条命令始终验证远端附件，不采用本地覆盖。
