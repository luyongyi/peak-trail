// Offline CPU tests use the actual vendored Three/GLTF/Meshopt implementations.
// Only texture pixels are stubbed: this cannot measure WebGL, image decode, or
// Safari behavior. No network is allowed by this helper.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function geometryAuditRuntime({ sourceRoot, fallbackRoot } = {}) {
  const platform = fileURLToPath(new URL("../../", import.meta.url));
  sourceRoot ||= path.join(platform, "web/src");
  fallbackRoot ||= sourceRoot;
  const vendor = path.join(platform, "vendor/three/0.180.0");
  const three = pathToFileURL(path.join(vendor, "build/three.module.js")).href;
  const moduleUrl = text => `data:text/javascript;base64,${Buffer.from(text).toString("base64")}`;
  const pending = new Map();
  async function resolveModule(file) {
    if (pending.has(file)) return pending.get(file);
    const task = (async () => {
      let source = await fs.readFile(file, "utf8");
      for (const match of [...source.matchAll(/(^import\b[\s\S]*?\bfrom )(["'])([^"']+)\2/gm)]) {
        const specifier = match[3];
        let url;
        if (specifier === "three") url = three;
        else if (specifier.startsWith("three/addons/")) url = await resolveModule(path.join(vendor, "examples/jsm", specifier.slice(13)));
        else if (specifier.startsWith(".")) {
          let dependency = path.resolve(path.dirname(file), specifier);
          try { await fs.access(dependency); } catch { dependency = path.resolve(fallbackRoot, specifier); }
          url = await resolveModule(dependency);
        } else throw new Error(`Unexpected offline import: ${specifier}`);
        source = source.replace(match[0], `${match[1]}${JSON.stringify(url)}`);
      }
      if (path.basename(file) === "geometry-loader.js") {
        source = source.replaceAll("new GLTFLoader()", "new AuditGLTFLoader()");
        source += `
export const audit = { parses: [] };
class AuditGLTFLoader extends GLTFLoader {
  constructor() { super(); this.register(() => ({ name: "PEAK_cpu_test_skip_texture_pixels", loadTexture: () => Promise.resolve(new THREE.Texture()) })); }
  async parseAsync(...args) {
    const start = performance.now(); const value = await super.parseAsync(...args);
    audit.parses.push(performance.now() - start); return value;
  }
}
export { batchStaticMeshes, preserveAffineMatrices };
`;
      }
      return moduleUrl(source);
    })();
    pending.set(file, task); return task;
  }
  const url = await resolveModule(path.join(sourceRoot, "geometry-loader.js"));
  return { geometry: await import(url), THREE: await import(three) };
}
