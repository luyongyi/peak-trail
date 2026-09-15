// This classic script also runs when index.html is opened directly from the filesystem,
// where browsers block the ES modules that normally handle the selected files.
(() => {
  const notice = document.getElementById("startupNotice");
  const show = (message) => {
    notice.textContent = message;
    notice.hidden = false;
  };
  if (window.location.protocol === "file:") {
    show("当前页面直接从文件打开，浏览器无法启动足迹解析。请双击 PeakTrailPlatform 文件夹中的 Start-Viewer.cmd，再在自动打开的网页中选择足迹目录。");
    document.querySelectorAll('input[type="file"], #traceSourceButton').forEach((input) => {
      input.disabled = true;
    });
    document.getElementById("dailyScene").textContent = "请启动查看器";
    return;
  }
  let ready = false;
  const timer = setTimeout(() => {
    if (!ready) show("页面尚未启动完成，足迹解析还不可用。请刷新页面；本地使用请双击 Start-Viewer.cmd 启动。");
  }, 12000);
  window.addEventListener("peaktrail-ready", () => {
    ready = true;
    clearTimeout(timer);
    notice.hidden = true;
  }, { once: true });
  document.getElementById("applicationScript").addEventListener("error", () => {
    clearTimeout(timer);
    show("足迹查看器加载失败。请刷新页面；本地使用请双击 Start-Viewer.cmd，避免直接打开 index.html。");
  });
})();
