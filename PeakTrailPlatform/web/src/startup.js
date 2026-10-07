// This classic script also runs when index.html is opened directly from the filesystem,
// where browsers block the ES modules that normally handle the selected files.
(() => {
  const notice = document.getElementById("startupNotice");
  const show = (message) => {
    notice.textContent = message;
    notice.hidden = false;
  };
  if (window.location.protocol === "file:") {
    show("当前页面直接从文件打开，地图与路线无法加载。请通过网站地址打开页面。");
    document.querySelectorAll('input[type="file"], #traceSourceButton').forEach((input) => {
      input.disabled = true;
    });
    document.getElementById("dailyScene").textContent = "请通过网站访问";
    return;
  }
  let ready = false;
  const timer = setTimeout(() => {
    if (!ready) show("地图与路线页面尚未加载完成，请检查网络后刷新页面。");
  }, 12000);
  window.addEventListener("peaktrail-ready", () => {
    ready = true;
    clearTimeout(timer);
    notice.hidden = true;
  }, { once: true });
  document.getElementById("applicationScript").addEventListener("error", () => {
    clearTimeout(timer);
    show("地图与路线页面加载失败，请检查网络后刷新页面。");
  });
})();
