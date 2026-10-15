import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadIndex } from "../../server/trajectory-store.mjs";
import { digest } from "../../server/trajectory-contract.mjs";

test("batched index reads retain directory order, omit damage and reread moderation changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "peak-index-test-"));
  try {
    const folder = join(root, "index"); await mkdir(folder);
    const ids = Array.from({ length: 37 }, (_, index) => digest(`synthetic-index-${index}`));
    for (const id of ids) await writeFile(join(folder, `${id}.json`), JSON.stringify({ version: 1, id, moderationStatus: "approved" }));
    await writeFile(join(folder, `${ids[3]}.json`), "{broken");
    await writeFile(join(folder, `${ids[17]}.json`), JSON.stringify({ version: 1, id: ids[18], moderationStatus: "approved" }));
    await writeFile(join(folder, `${ids[34]}.json`), JSON.stringify({ version: 1, id: ids[34], moderationStatus: "unrecognized" }));
    await writeFile(join(folder, "ignored.json"), JSON.stringify({ version: 1, id: ids[0], moderationStatus: "approved" }));
    const omitted = new Set([ids[3], ids[17], ids[34]]);
    const expectedOrder = (await readdir(folder)).filter(file => /^[a-f0-9]{64}\.json$/.test(file)).map(file => file.slice(0, -5)).filter(id => !omitted.has(id));
    const first = await loadIndex(root);
    assert.deepEqual(first.map(entry => entry.id), expectedOrder);
    const path = join(folder, `${ids[0]}.json`), changed = JSON.parse(await readFile(path, "utf8"));
    changed.moderationStatus = "hidden"; await writeFile(path, JSON.stringify(changed));
    assert.equal((await loadIndex(root)).find(entry => entry.id === ids[0]).moderationStatus, "hidden");
    await rm(path);
    assert.equal((await loadIndex(root)).some(entry => entry.id === ids[0]), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
