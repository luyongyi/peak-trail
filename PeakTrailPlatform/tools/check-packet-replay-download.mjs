import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPacketReplayArtifact, readPacketReplayRelease } from "./lib/packet-replay-release.mjs";

const platform = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const localPath = args[0] === "--zip" && args.length === 2 ? args[1] : undefined;
if (!(args.length === 0 || args.length === 1 && args[0] === "--public" || localPath))
  throw new Error("Use --public to verify the published ZIP, or --zip <file> for the exact local package");
const release = await readPacketReplayRelease(resolve(platform, "data/packet-replay/release.json"));
if (args.length) {
  await loadPacketReplayArtifact(release, { localPath });
  console.log(`Windows replay ${release.version}: ${localPath ? "local" : "public GitHub"} ZIP size, SHA-256, launchers and package paths verified (${release.bytes} bytes).`);
} else console.log(`Windows replay ${release.version} descriptor valid. Use --public to verify the download.`);
