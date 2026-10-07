import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { loadRecorderArtifact, readRecorderRelease, validateRecorderRelease } from "./recorder-release.mjs";
import { loadMemoriesArtifact, readMemoriesRelease, requirePublicMemoriesRelease, validateMemoriesRelease } from "./memories-release.mjs";

export function optionValue(argv, flag) {
  const indexes = argv.flatMap((value, index) => value === flag ? [index] : []);
  if (!indexes.length) return undefined;
  const value = argv[indexes[0] + 1];
  if (indexes.length !== 1 || !value || value.startsWith("--")) throw new Error(`${flag} requires one value`);
  return value;
}

export function siteReleaseOptions(argv = [], env = {}) {
  const product = optionValue(argv, "--download-product") || env.PEAK_TRAIL_DOWNLOAD_PRODUCT || "memories";
  if (!["memories", "recorder"].includes(product)) throw new Error("--download-product must be memories or recorder");
  const localPath = product === "memories"
    ? optionValue(argv, "--memories-dll") || env.PEAK_TRAIL_MEMORIES_DLL
    : optionValue(argv, "--recorder-dll") || env.PEAK_TRAIL_RECORDER_DLL;
  return { product, localPath };
}

export function validateSiteRelease(value, product = "memories") {
  if (product === "memories") return validateMemoriesRelease(value);
  if (product === "recorder") return validateRecorderRelease(value);
  throw new Error("Unknown site download product");
}

export async function readSiteRelease(dataDirectory, product = "memories") {
  if (product === "memories") return readMemoriesRelease(resolve(dataDirectory, "memories", "release.json"));
  if (product === "recorder") return readRecorderRelease(resolve(dataDirectory, "recorder", "release.json"));
  throw new Error("Unknown site download product");
}

export async function loadSiteArtifact(release, { product = "memories", preview = false, localPath, ...verification } = {}) {
  if (product === "memories") {
    if (!preview) {
      requirePublicMemoriesRelease(release);
      if (localPath) throw new Error("Public staging cannot use a local memories DLL override");
    }
    return loadMemoriesArtifact(release, { localPath, ...verification });
  }
  if (product === "recorder") return loadRecorderArtifact(release, { localPath });
  throw new Error("Unknown site download product");
}

export function checkSiteDownloadReferences(htmls, release) {
  let found = false;
  for (const html of htmls) for (const match of html.matchAll(/(?:href|src)=["']([^"']+)["']/g)) {
    const reference = match[1].replace(/^(?:\.\/|\/)/, "");
    if (!reference.startsWith("downloads/")) continue;
    if (reference !== release.downloadPath) throw new Error(`Site download link ${reference} does not match selected ${release.filename} descriptor (${release.downloadPath}).`);
    found = true;
  }
  for (const html of htmls) for (const match of html.matchAll(/<a\b[^>]*>/gi)) {
    const href = match[0].match(/\bhref=["']([^"']+)["']/)?.[1]?.replace(/^(?:\.\/|\/)/, "");
    if (href !== release.downloadPath) continue;
    const filename = match[0].match(/\bdownload=["']([^"']*)["']/)?.[1];
    if (filename && filename !== release.filename) throw new Error("Site download filename does not match selected descriptor.");
  }
  if (!found) throw new Error(`Site HTML has no download link for selected ${release.filename} descriptor.`);
}

export function validateSiteBuildProfile(value) {
  if (value?.schemaVersion !== 1 || !["pages", "server"].includes(value.profile)
      || Object.keys(value).some(key => !["schemaVersion", "profile"].includes(key)))
    throw new Error("Invalid tracked site build profile");
  return value.profile;
}

export async function readSiteStagingProfile(path, argv = [], options = {}) {
  let configuredProfile;
  try {
    const source = await readFile(path, "utf8");
    if (source.length > 4096) throw new Error("Invalid tracked site build profile size");
    let value;
    try { value = JSON.parse(source); } catch { throw new Error("Invalid tracked site build profile JSON"); }
    configuredProfile = validateSiteBuildProfile(value);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  return siteStagingProfile(argv, { ...options, configuredProfile });
}

export function siteStagingProfile(argv = [], { preview = false, configuredProfile } = {}) {
  if (configuredProfile !== undefined && !["pages", "server"].includes(configuredProfile))
    throw new Error("Invalid tracked site build profile");
  const profile = optionValue(argv, "--profile") || configuredProfile || "pages";
  if (!["pages", "server"].includes(profile)) throw new Error("--profile must be pages or server");
  if (preview && profile === "server") throw new Error("Server staging cannot use --preview");
  return profile;
}

export function checkSiteBudget(totalBytes, { preview = false, profile = "pages" } = {}) {
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 0) throw new Error("Invalid staged site size");
  siteStagingProfile(["--profile", profile], { preview });
  const limit = profile === "server" ? 2_000_000_000 : 1_000_000_000;
  if (!preview && totalBytes > limit)
    throw new Error(`Staged public site is ${totalBytes} bytes, above the ${profile === "server" ? "server 2 GB" : "conservative GitHub Pages 1 GB"} budget. Reduce published pack versions without altering geometry before public staging.`);
}
