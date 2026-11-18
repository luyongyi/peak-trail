import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const toolDirectory = dirname(fileURLToPath(import.meta.url));
const repository = resolve(toolDirectory, "..", "..");
const releasePaths = ["PeakTrailPlatform", ".github/workflows", ".gitattributes"];
const prePush = `#!/bin/sh
entry="$(git rev-parse --show-toplevel)/PeakTrailPlatform/tools/web-release-check.mjs"
if [ -f "$entry" ]; then
  exec node "$entry" pre-push
fi
while read -r local_ref local_oid remote_ref remote_oid; do
  if [ "$remote_ref" = refs/heads/main ]; then
    echo "Load the current Web release checks before pushing production main." >&2
    exit 1
  fi
done
`;

function run(command, args, cwd, capture = false, input = "inherit") {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "inherit"] : [input, "inherit", "inherit"] });
  if (result.status !== 0) throw new Error(`${command} failed${result.error ? `: ${result.error.message}` : ` (${result.status ?? result.signal})`}`);
  return capture ? result.stdout.trim() : undefined;
}

function git(args) {
  return run("git", args, repository, true);
}

function checkWeb() {
  if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Web release verification requires Node.js 24 or newer");
  const args = ["--prefix", "PeakTrailPlatform/web", "run", "check"];
  if (process.platform === "win32") run("cmd.exe", ["/d", "/c", "npm --prefix PeakTrailPlatform/web run check"], repository);
  else run("npm", args, repository);
  for (const relative of ["PeakTrailPlatform/web/tests", "PeakTrailPlatform/tools/tests"]) {
    const files = readdirSync(resolve(repository, relative)).filter(name => name.endsWith(".test.mjs")).sort();
    if (files.length === 0) throw new Error(`No Web release tests found in ${relative}`);
    // Keep paths relative so the test command fits Windows' argument limit.
    run(process.execPath, ["--test", ...files.map(name => join(relative, name))], repository);
  }
}

function install() {
  const configured = spawnSync("git", ["config", "--get", "core.hooksPath"], { cwd: repository, encoding: "utf8" });
  if (configured.status !== 1) throw new Error("Git already has a custom hooks path. Add the Web check to that hook explicitly.");
  const hook = git(["rev-parse", "--path-format=absolute", "--git-path", "hooks/pre-push"]);
  mkdirSync(dirname(hook), { recursive: true });
  if (existsSync(hook)) {
    if (readFileSync(hook, "utf8") !== prePush) throw new Error("Git already has a pre-push hook. Add the Web check to that hook explicitly.");
  } else writeFileSync(hook, prePush, { mode: 0o755, flag: "wx" });
  console.log(`Installed the Web production pre-push check at ${hook}`);
}

function checkCommit(commit) {
  const temporary = realpathSync(tmpdir());
  const scratch = realpathSync(mkdtempSync(join(temporary, "peak-web-prepush-")));
  const archive = join(scratch, "candidate.tar");
  const checkout = join(scratch, "candidate");
  try {
    mkdirSync(checkout);
    git(["archive", "--format=tar", "--output", archive, commit]);
    // Git for Windows can select GNU tar, which interprets a drive-letter
    // archive argument as a remote host. Pass the archive through stdin.
    const descriptor = openSync(archive, "r");
    try { run("tar", ["-xf", "-"], checkout, false, descriptor); }
    finally { closeSync(descriptor); }
    run(process.execPath, ["PeakTrailPlatform/tools/web-release-check.mjs", "check"], checkout);
  } finally {
    if (realpathSync(scratch) !== scratch || dirname(scratch) !== temporary || !basename(scratch).startsWith("peak-web-prepush-")) {
      throw new Error(`Temporary Web verification directory needs manual review: ${scratch}`);
    }
    rmSync(scratch, { recursive: true, force: true });
  }
}

function checkPush() {
  const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
  for (const line of readFileSync(0, "utf8").trim().split(/\r?\n/)) {
    const [, commit, remoteRef, previous] = line.trim().split(/\s+/);
    if (remoteRef !== "refs/heads/main" || /^0+$/.test(commit ?? "")) continue;
    if (!objectId.test(commit ?? "") || !objectId.test(previous ?? "")) throw new Error("Invalid Git production push input");
    const known = !/^0+$/.test(previous) && spawnSync("git", ["cat-file", "-e", `${previous}^{commit}`], { cwd: repository, stdio: "ignore" }).status === 0;
    if (known && !git(["diff", "--name-only", previous, commit, "--", ...releasePaths])) continue;
    console.log(`Checking Web and loopback API for the exact proposed production commit ${commit.slice(0, 12)}…`);
    checkCommit(commit);
  }
}

try {
  const command = process.argv[2];
  if (command === "check") checkWeb();
  else if (command === "install") install();
  else if (command === "pre-push") checkPush();
  else throw new Error("Usage: node PeakTrailPlatform/tools/web-release-check.mjs check|install");
} catch (error) {
  console.error(`Web release check: ${error.message}`);
  process.exitCode = 1;
}
