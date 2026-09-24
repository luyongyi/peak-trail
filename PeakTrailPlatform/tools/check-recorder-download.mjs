import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRecorderArtifact, readRecorderRelease } from "./lib/recorder-release.mjs";
import { verifyPublishedRecorderSource } from "./lib/recorder-release-source.mjs";

const platform = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const release = await readRecorderRelease(resolve(platform, "data/recorder/release.json"));
// CI deliberately checks the published release, not a local override.
await loadRecorderArtifact(release);
await verifyPublishedRecorderSource(release);
console.log(`Published recorder ${release.version}: ${release.size} bytes, SHA-256 and source tag verified.`);
