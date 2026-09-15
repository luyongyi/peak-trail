import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const htmlPath = resolve(root, "index.html");
const html = readFileSync(htmlPath, "utf8");
const missing = [];

for (const match of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
  const reference = match[1];
  if (/^(?:data:|https?:|\/\/)/i.test(reference)) continue;
  const target = resolve(root, reference.replace(/^\.\//, ""));
  if (!existsSync(target)) missing.push(reference);
}

const importMapMatch = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
if (!importMapMatch) throw new Error("index.html 缺少 Three.js import map");
JSON.parse(importMapMatch[1]);

for (const source of ["src/app.js", "src/protocol.js", "src/scene.js"]) {
  const contents = readFileSync(resolve(root, source), "utf8");
  if (contents.includes("innerHTML")) throw new Error(`${source} 不应使用 innerHTML`);
}

if (missing.length) throw new Error(`缺少本地静态资源：${missing.join(", ")}`);
console.log("Static entrypoint, import map and local asset references are valid.");
