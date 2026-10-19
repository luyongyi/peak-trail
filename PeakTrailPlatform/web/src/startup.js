// This classic script also runs when index.html is opened directly from the filesystem,
// where browsers block the ES modules that normally handle the selected files.
(() => {
  const normalize = value => /^zh(?:-|$)/i.test(value || "") ? "zh-CN" : /^en(?:-|$)/i.test(value || "") ? "en" : null;
  const language = () => {
    let query, stored;
    try { query = normalize(new URL(window.location.href).searchParams.get("lang")); } catch { /* File/embedded origins may omit a URL. */ }
    try { stored = normalize(window.localStorage.getItem("peak-trail.language")); } catch { /* Storage may be disabled. */ }
    const languages = window.navigator?.languages || [window.navigator?.language].filter(Boolean);
    return query || stored || (String(languages[0] || "").toLowerCase().startsWith("zh") ? "zh-CN" : languages.length ? "en" : "zh-CN");
  };
  const text = (chinese, english) => language() === "en" ? english : chinese;
  document.documentElement.lang = language();
  const notice = document.getElementById("startupNotice");
  const show = (message) => {
    notice.textContent = message;
    notice.hidden = false;
  };
  if (window.location.protocol === "file:") {
    show(text("当前页面直接从文件打开，地图与路线无法加载。请通过网站地址打开页面。", "Maps and routes cannot load from a local HTML file. Open this page through the website address."));
    document.querySelectorAll('input[type="file"], #traceSourceButton').forEach((input) => {
      input.disabled = true;
    });
    document.getElementById("dailyScene").textContent = text("请通过网站访问", "Open through the website");
    return;
  }
  let ready = false;
  const timer = setTimeout(() => {
    if (!ready) show(text("地图与路线页面尚未加载完成，请检查网络后刷新页面。", "Maps and routes are still loading. Check your connection and refresh the page."));
  }, 12000);
  window.addEventListener("peaktrail-ready", () => {
    ready = true;
    clearTimeout(timer);
    notice.hidden = true;
  }, { once: true });
  document.getElementById("applicationScript").addEventListener("error", () => {
    clearTimeout(timer);
    show(text("地图与路线页面加载失败，请检查网络后刷新页面。", "Maps and routes failed to load. Check your connection and refresh the page."));
  });
})();
