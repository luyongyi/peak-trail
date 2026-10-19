import { getLocale, normalizeLocale, onLocaleChange, setLocale } from "./i18n.js";
import { UI_TEXT } from "./ui-text.js";

const initialized = new WeakMap();
const ATTRIBUTES = ["aria-label", "title", "placeholder", "alt", "content"];
const normalized = value => String(value).trim().replace(/\s+/g, " ");

// Capture only known initial UI copy. Dynamic renderers own any node they later
// replace, and user names are never scanned after startup or after a mutation.
export function collectStaticTranslations(root) {
  const records = [];
  const document = root.ownerDocument || root;
  const tree = document.createTreeWalker(root.documentElement || root, 4);
  for (let node = tree.nextNode(); node; node = tree.nextNode()) {
    if (["SCRIPT", "STYLE", "NOSCRIPT"].includes(node.parentElement?.tagName)) continue;
    const original = node.nodeValue;
    const chinese = normalized(original);
    if (!UI_TEXT.has(chinese)) continue;
    const leading = original.match(/^\s*/)[0], trailing = original.match(/\s*$/)[0];
    records.push({ read: () => node.nodeValue, write: value => { node.nodeValue = value; },
      chinese: `${leading}${chinese}${trailing}`, english: `${leading}${UI_TEXT.get(chinese)}${trailing}`, previous: original });
  }
  for (const node of root.querySelectorAll("*")) for (const attribute of ATTRIBUTES) {
    const original = node.getAttribute(attribute);
    if (original === null || !UI_TEXT.has(normalized(original))) continue;
    const chinese = normalized(original);
    records.push({ read: () => node.getAttribute(attribute), write: value => node.setAttribute(attribute, value),
      chinese, english: UI_TEXT.get(chinese), previous: original });
  }
  return locale => {
    for (const record of records) {
      if (record.read() !== record.previous) continue;
      record.previous = locale === "en" ? record.english : record.chinese;
      record.write(record.previous);
    }
  };
}

export function initLanguageControls(root = document) {
  if (initialized.has(root)) return initialized.get(root);
  // An explicit language link is a choice that should survive returning home.
  // Browser auto-detection alone must remain automatic on later visits.
  try {
    const browser = root.defaultView || root.ownerDocument?.defaultView;
    if (normalizeLocale(new URL(browser?.location?.href).searchParams.get("lang"))) setLocale(getLocale());
  } catch { /* Documents without a browser URL have no explicit language choice. */ }
  const applyStatic = collectStaticTranslations(root);
  const buttons = [...root.querySelectorAll("[data-language-toggle]")];
  const change = () => setLocale(getLocale() === "en" ? "zh-CN" : "en");
  for (const button of buttons) button.addEventListener("click", change);
  const render = () => {
    const locale = getLocale();
    const page = root.documentElement || root.ownerDocument?.documentElement;
    if (page) page.lang = locale;
    applyStatic(locale);
    for (const button of buttons) {
      const label = button.querySelector("[data-language-label]");
      if (label) label.textContent = locale === "en" ? "中文" : "English";
      button.lang = locale === "en" ? "zh-CN" : "en";
      const help = locale === "en" ? "Switch to Simplified Chinese" : "切换为英语";
      button.setAttribute("aria-label", help);
      button.setAttribute("title", help);
    }
  };
  const unsubscribe = onLocaleChange(render);
  const dispose = () => {
    unsubscribe();
    for (const button of buttons) button.removeEventListener("click", change);
    initialized.delete(root);
  };
  initialized.set(root, dispose);
  render();
  return dispose;
}
