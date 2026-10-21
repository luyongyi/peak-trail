import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { readGameAssets } from '../lib/game-assets.mjs';

const directory = new URL('../../data/item-event-assets/', import.meta.url);

test('bundled item event assets retain exact-build solid geometry and allowlisted textures', async () => {
  const root = fileURLToPath(directory);
  const pack = await readGameAssets(root);
  for (const build of pack.catalog.builds) {
    const catalog = JSON.parse(await readFile(new URL(build.catalog, directory), 'utf8'));
    assert.match(catalog.sourceAssemblySha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(catalog.customization, {});
    const allowed = new Set(catalog.assets.map(asset => asset.path));
    const actual = (await readdir(resolve(root, build.gameBuildId), { recursive: true, withFileTypes: true }))
      .filter(entry => entry.isFile()).map(entry => resolve(entry.parentPath, entry.name));
    assert.deepEqual(actual.sort(), ['catalog.json', ...allowed].map(path => resolve(root, build.gameBuildId, path)).sort());
    for (const path of allowed) {
      if (!path.endsWith('.json')) continue;
      const model = JSON.parse(await readFile(new URL(`${build.gameBuildId}/${path}`, directory), 'utf8'));
      assert.equal(model.coordinateSpace, 'unity-prefab-local-meters');
      assert.ok(model.parts.length > 0, path);
      for (const part of model.parts) {
        assert.ok(part.positions.length >= 9 && part.positions.length % 3 === 0, path);
        assert.ok(part.positions.every(Number.isFinite), path);
        const vertices = part.positions.length / 3;
        assert.equal(part.uv.length, vertices * 2, path);
        assert.ok(part.uv.every(Number.isFinite), path);
        for (const group of part.groups) {
          assert.ok(group.indices.length >= 3 && group.indices.length % 3 === 0, path);
          assert.ok(group.indices.every(index => Number.isInteger(index) && index >= 0 && index < vertices), path);
          if (group.material.texture) assert.ok(allowed.has(group.material.texture), group.material.texture);
        }
      }
    }
    for (const prefab of ['ClimbingSpikeHammered', 'ShelfShroomSpawn', 'CloudFungusPlaced', 'RopeAnchorForRopeShooter']) {
      assert.ok(catalog.worldObjects.find(entry => entry.prefabName === prefab)?.model, prefab);
    }
    const particles = catalog.worldObjects.find(entry => entry.prefabName === 'HealingPuffShroomSpawn');
    assert.equal(particles.model, undefined);
    assert.equal(particles.modelUnavailableReason, 'source-has-no-solid-mesh');
    assert.ok(allowed.has(particles.icon));
  }
});
