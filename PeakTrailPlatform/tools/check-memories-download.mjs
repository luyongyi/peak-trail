import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMemoriesArtifact, readMemoriesRelease, requirePublicMemoriesRelease } from "./lib/memories-release.mjs";
import { optionValue } from "./lib/site-release.mjs";

const platform = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const release = await readMemoriesRelease(resolve(platform, "data/memories/release.json"));
const localPath = optionValue(process.argv.slice(2), "--dll");
if (process.argv.includes("--public")) {
  requirePublicMemoriesRelease(release);
  if (localPath) throw new Error("Public release verification cannot use --dll");
  await loadMemoriesArtifact(release);
  console.log(`Published memories ${release.version}: release API, exact source tag, build manifest, DLL size and SHA-256 verified anonymously.`);
} else if (localPath) {
  if (release.channel !== "development") throw new Error("Use --public to verify published memories; --dll is only for local development");
  await loadMemoriesArtifact(release, { localPath });
  console.log(`Memories ${release.version} development DLL: ${release.size} bytes and SHA-256 verified; not a public release or source verification.`);
} else {
  console.log(`Memories ${release.version} ${release.channel} descriptor valid. Metadata only; DLL bytes and published source are not verified.${release.channel === "development" ? " No public release exists in this descriptor." : " Run --public for full remote verification."}`);
}
