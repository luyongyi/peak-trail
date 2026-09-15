import assert from "node:assert/strict";
import test from "node:test";
import { collectDroppedFiles } from "../src/file-intake.js";

function fileEntry(name, content = name) {
  return {
    name,
    isFile: true,
    isDirectory: false,
    file(success) {
      queueMicrotask(() => success(new File([content], name, {
        type: "application/x-ndjson",
        lastModified: 1234,
      })));
    },
  };
}

function directory(name, batches) {
  let calls = 0;
  return {
    name,
    isFile: false,
    isDirectory: true,
    get reads() { return calls; },
    createReader() {
      let index = 0;
      return {
        readEntries(success) {
          calls += 1;
          queueMicrotask(() => success(batches[index++] || []));
        },
      };
    },
  };
}

function transfer(...entries) {
  return {
    items: entries.map((entry) => ({ kind: "file", webkitGetAsEntry: () => entry })),
    files: [new File([], "directory-placeholder")],
  };
}

test("dropped directory reads every page and preserves nested session paths", async () => {
  const first = directory("day-one", [[fileEntry("manifest.json", "{}")], [fileEntry("stream.ndjson", "first")]]);
  const second = directory("day-two", [[fileEntry("manifest.json", "{}"), fileEntry("stream.ndjson", "second")]]);
  const root = directory("PeakTrailRecordings", [[first], [second]]);
  const files = await collectDroppedFiles(transfer(root));
  assert.deepEqual(files.map((file) => file.webkitRelativePath), [
    "PeakTrailRecordings/day-one/manifest.json",
    "PeakTrailRecordings/day-one/stream.ndjson",
    "PeakTrailRecordings/day-two/manifest.json",
    "PeakTrailRecordings/day-two/stream.ndjson",
  ]);
  assert.equal(root.reads, 3);
  assert.equal(first.reads, 3);
  assert.equal(second.reads, 2);
  const sample = files[1];
  assert.ok(sample instanceof File);
  assert.equal(sample.name, "stream.ndjson");
  assert.equal(sample.type, "application/x-ndjson");
  assert.equal(sample.lastModified, 1234);
  assert.equal(await sample.text(), "first");
  assert.equal(await sample.slice(1, 4).text(), "irs");
  assert.equal(new TextDecoder().decode(await sample.arrayBuffer()), "first");
  assert.equal(await new Response(sample.stream()).text(), "first");
  const blobUrl = URL.createObjectURL(sample);
  URL.revokeObjectURL(blobUrl);
});

test("entry handles and fallback files are captured during the drop event", async () => {
  let protectedStore = false;
  const entries = [fileEntry("first.ndjson"), fileEntry("second.ndjson")];
  const items = entries.map((entry) => ({
    kind: "file",
    webkitGetAsEntry() {
      assert.equal(protectedStore, false);
      return entry;
    },
  }));
  const pending = collectDroppedFiles({ items, files: [] });
  protectedStore = true;
  const files = await pending;
  assert.deepEqual(files.map((file) => file.name), ["first.ndjson", "second.ndjson"]);

  const file = new File(["history"], "PeakTrailHistory.ndjson");
  assert.deepEqual(await collectDroppedFiles({ files: [file] }), [file]);
  assert.deepEqual(await collectDroppedFiles({
    files: [file],
    items: [{ kind: "file", getAsFile: () => file }],
  }), [file]);
});

test("directory reader and file access failures reject with their relative path", async () => {
  const deniedFile = {
    name: "stream.ndjson.partial",
    isFile: true,
    file(success, failure) { queueMicrotask(() => failure(new Error("permission denied"))); },
  };
  await assert.rejects(
    collectDroppedFiles(transfer(directory("recordings", [[deniedFile]]))),
    /recordings\/stream\.ndjson\.partial.*permission denied/,
  );

  const deniedDirectory = {
    name: "restricted",
    isDirectory: true,
    createReader() {
      return { readEntries(success, failure) { failure(new Error("access denied")); } };
    },
  };
  await assert.rejects(
    collectDroppedFiles(transfer(directory("recordings", [[deniedDirectory]]))),
    /recordings\/restricted.*access denied/,
  );
});
