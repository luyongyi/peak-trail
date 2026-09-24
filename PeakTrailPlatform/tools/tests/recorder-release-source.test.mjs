import assert from "node:assert/strict";
import test from "node:test";
import { verifyPublishedRecorderSource, verifyRecorderSourceRefs } from "../lib/recorder-release-source.mjs";

const release = {
  schemaVersion: 1, version: "0.7.1", filename: "PeakTrailRecorder.dll",
  sourceRevision: "a".repeat(40), sha256: "b".repeat(64), size: 212992,
  artifactUrl: "https://github.com/luyongyi/peak-trail/releases/download/recorder-v0.7.1/PeakTrailRecorder.dll",
  downloadPath: "downloads/recorder/0.7.1/PeakTrailRecorder.dll",
};
const ref = "refs/tags/recorder-v0.7.1";
const line = (hash = release.sourceRevision, name = ref) => `${hash}\t${name}\n`;

test("release source accepts exact lightweight and peeled annotated tags", () => {
  assert.equal(verifyRecorderSourceRefs(line(), release), release.sourceRevision);
  const annotated = line("c".repeat(40)) + line(release.sourceRevision, `${ref}^{}`);
  assert.equal(verifyRecorderSourceRefs(annotated, release), release.sourceRevision);
  assert.equal(verifyRecorderSourceRefs(annotated.replaceAll("\n", "\r\n"), release), release.sourceRevision);
  assert.equal(verifyRecorderSourceRefs(line(release.sourceRevision, `${ref}^{}`) + line("c".repeat(40)), release), release.sourceRevision);
});

test("release source rejects missing, moved, duplicate and unrelated refs", () => {
  for (const output of ["", line(release.sourceRevision, `${ref}^{}`)]) {
    assert.throws(() => verifyRecorderSourceRefs(output, release), /tag is missing/);
  }
  for (const output of [line("c".repeat(40)), line() + line("c".repeat(40), `${ref}^{}`)]) {
    assert.throws(() => verifyRecorderSourceRefs(output, release), /does not match pinned sourceRevision/);
  }
  for (const output of [line() + line(), line("invalid"), line(release.sourceRevision, ref + "0"),
    line(release.sourceRevision, "refs/heads/main"), " ", "x".repeat(4097), null]) {
    assert.throws(() => verifyRecorderSourceRefs(output, release), /Invalid recorder release tag response/);
  }
});

test("source lookup uses exact public refs without shell interpolation or API credentials", async () => {
  const revision = await verifyPublishedRecorderSource(release, { execFileImpl: async (file, args, options) => {
    assert.equal(file, "git");
    assert.deepEqual(args, ["ls-remote", "--exit-code", "--tags",
      "https://github.com/luyongyi/peak-trail.git", ref, `${ref}^{}`]);
    assert.equal(options.shell, undefined);
    assert.equal(options.timeout, 15000);
    assert.equal(options.maxBuffer, 4096);
    assert.equal(options.windowsHide, true);
    assert.equal(options.env.GIT_TERMINAL_PROMPT, "0");
    return { stdout: line() };
  } });
  assert.equal(revision, release.sourceRevision);
});

test("source lookup retries bounded transport failures and timeouts", async () => {
  let calls = 0;
  const sleeps = [];
  const revision = await verifyPublishedRecorderSource(release, {
    execFileImpl: async () => {
      calls++;
      if (calls === 1) throw { code: 128, stderr: "fatal: unable to access https://secret.invalid: connection reset" };
      if (calls === 2) throw { killed: true };
      return { stdout: line() };
    }, sleepImpl: async ms => sleeps.push(ms),
  });
  assert.equal(revision, release.sourceRevision);
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [300, 600]);
  calls = 0;
  await assert.rejects(verifyPublishedRecorderSource(release, {
    execFileImpl: async () => { calls++; throw { code: 128, stderr: "SSL secret" }; }, sleepImpl: async () => {},
  }), error => error.message === "Recorder release tag lookup failed");
  assert.equal(calls, 3);
});

test("missing or moved tags and deterministic lookup errors fail immediately", async () => {
  for (const outcome of [
    { error: { code: 2 }, pattern: /tag is missing/ },
    { error: { code: "ENOENT" }, pattern: /Git is required/ },
    { error: { code: 128, stderr: "secret authentication failure" }, pattern: /^Recorder release tag lookup failed$/ },
    { stdout: line("c".repeat(40)), pattern: /does not match/ },
  ]) {
    let calls = 0;
    await assert.rejects(verifyPublishedRecorderSource(release, {
      execFileImpl: async () => { calls++; if (outcome.error) throw outcome.error; return { stdout: outcome.stdout }; },
      sleepImpl: async () => assert.fail("Must not retry deterministic errors"),
    }), error => { assert.match(error.message, outcome.pattern); return true; });
    assert.equal(calls, 1);
  }
  await assert.rejects(verifyPublishedRecorderSource({ ...release, version: "0.7.1;injected" }, {
    execFileImpl: async () => assert.fail("Invalid manifests must not start Git"),
  }), /Invalid pinned recorder release manifest/);
});
