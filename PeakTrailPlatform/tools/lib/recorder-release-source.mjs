import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { validateRecorderRelease } from "./recorder-release.mjs";

const execFileAsync = promisify(execFile);
const REPOSITORY = "https://github.com/luyongyi/peak-trail.git";

// Git peels annotated (including nested annotated) tags to their final target.
// Accept only the two exact refs requested, never a similar version or branch.
export function verifyRecorderSourceRefs(output, release) {
  release = validateRecorderRelease(release);
  const ref = `refs/tags/recorder-v${release.version}`;
  const refs = new Map();
  if (typeof output !== "string" || output.length > 4096) {
    throw new Error("Invalid recorder release tag response");
  }
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    const match = line.match(/^([a-f0-9]{40})\t([^\s]+)$/);
    if (!match || ![ref, `${ref}^{}`].includes(match[2]) || refs.has(match[2])) {
      throw new Error("Invalid recorder release tag response");
    }
    refs.set(match[2], match[1]);
  }
  if (!refs.has(ref)) throw new Error("Published recorder release tag is missing");
  const revision = refs.get(`${ref}^{}`) || refs.get(ref);
  if (revision !== release.sourceRevision) {
    throw new Error("Recorder release tag does not match pinned sourceRevision");
  }
  return revision;
}

export async function verifyPublishedRecorderSource(release, {
  execFileImpl = execFileAsync, sleepImpl = delay,
} = {}) {
  release = validateRecorderRelease(release);
  const ref = `refs/tags/recorder-v${release.version}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    let stdout;
    try {
      ({ stdout } = await execFileImpl("git", [
        "ls-remote", "--exit-code", "--tags", REPOSITORY, ref, `${ref}^{}`,
      ], {
        encoding: "utf8", timeout: 15_000, maxBuffer: 4096, windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      }));
    } catch (error) {
      // Do not print git stderr: host configuration may contain credentials.
      if (error.code === 2) throw new Error("Published recorder release tag is missing");
      if (error.code === "ENOENT") throw new Error("Git is required to verify the recorder release source");
      const transient = error.killed || (error.code === 128 &&
        /could not resolve|failed to connect|connection.*(?:reset|closed|timed out)|timed out|TLS|SSL|RPC failed|early EOF|HTTP (?:429|5\d\d)|returned error: (?:429|5\d\d)/i.test(error.stderr || ""));
      if (!transient || attempt === 2) throw new Error("Recorder release tag lookup failed");
      await sleepImpl(300 * 2 ** attempt);
      continue;
    }
    // Validation failures are deterministic; never retry a moved or malformed tag.
    return verifyRecorderSourceRefs(stdout, release);
  }
}
