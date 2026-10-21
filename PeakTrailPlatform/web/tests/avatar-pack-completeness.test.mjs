import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { loadGameAssetPack } from '../src/game-assets.js';
import { createAvatarRenderPlan, isHeadAppearanceReady, selectHeadModelParts } from '../src/avatar-renderer.js';
import { readGameAssets } from '../../tools/lib/game-assets.mjs';

const GROUPS = ['skins', 'eyes', 'mouths', 'accessories', 'fits', 'hats', 'sashes', 'medals'];
const FORMS = ['skeleton', 'mushroom', 'chicken'];
// Audited against this build's native Customization arrays and playerHats.
// The 47 real hat renderers include 45 selectable hats and two outfit-only
// overrides. Future builds must be independently audited instead of relabeled.
const NATIVE_OPTION_COUNTS = { '25739797': { skins: 9, eyes: 18, mouths: 19,
  accessories: 21, fits: 34, hats: 47, sashes: 10, medals: 2 } };
const hash = value => createHash('sha256').update(value).digest('hex');

// Validate the real render plan, plus references inside model JSON (not just
// catalog references). Work is linear in options plus the fit/hat combinations.
async function validateAvatarPack(pack, readAsset, expectedCounts = NATIVE_OPTION_COUNTS[pack?.gameBuildId]) {
  assert.ok(pack, 'Exact-build avatar pack is missing');
  const c = pack.customization, allowed = new Map(pack.catalog.assets.map(entry => [entry.path, entry]));
  const files = new Map(), models = new Map();
  async function asset(path, label) {
    assert.ok(typeof path === 'string' && /^[a-zA-Z0-9_./-]+\.(json|png|webp|jpg|jpeg)$/.test(path)
      && !path.startsWith('/') && !path.split('/').includes('..'), `${label}: unsafe/missing asset reference`);
    assert.ok(allowed.has(path), `${label}: unlisted asset ${path}`);
    if (!files.has(path)) {
      const data = await readAsset(path), entry = allowed.get(path);
      assert.equal(data.length, entry.bytes, `${path}: byte count differs`);
      assert.equal(hash(data), entry.sha256, `${path}: hash differs`);
      assert.ok(data.length > 0, `${path}: empty asset`);
      files.set(path, data);
    }
    return files.get(path);
  }
  async function material(value, label, decoded = false) {
    assert.ok(value && typeof value === 'object', `${label}: material missing`);
    for (const key of ['texture', 'preview']) if (value[key]) await asset(value[key], `${label}.${key}`);
    if (decoded && value.texture) {
      assert.equal(value.textureEncoding, 'peak-face-mask', `${label}: raw face mask is not decoded`);
      await asset(value.preview, `${label}: decoded face preview`);
    }
    for (const key of ['color', 'textureScale', 'textureOffset', 'faceOffset']) if (value[key]) {
      assert.ok(Array.isArray(value[key]) && value[key].every(Number.isFinite), `${label}.${key}: invalid values`);
    }
  }
  async function model(path, label, head = false) {
    if (!models.has(path)) {
      const value = JSON.parse((await asset(path, label)).toString('utf8'));
      assert.ok(Array.isArray(value.parts) && value.parts.length, `${label}: model parts missing`);
      for (const part of value.parts) {
        assert.ok(Array.isArray(part.positions) && part.positions.length >= 9 && part.positions.length % 3 === 0
          && part.positions.every(Number.isFinite), `${label}: invalid positions`);
        const vertices = part.positions.length / 3;
        assert.ok(Array.isArray(part.groups) && part.groups.length, `${label}: material groups missing`);
        if (part.uv) assert.ok(part.uv.length === vertices * 2 && part.uv.every(Number.isFinite), `${label}: invalid UVs`);
        if (part.colors) assert.ok(part.colors.length === vertices * 3 && part.colors.every(Number.isFinite), `${label}: invalid colors`);
        for (const group of part.groups) {
          assert.ok(Array.isArray(group.indices) && group.indices.length % 3 === 0
            && group.indices.every(i => Number.isInteger(i) && i >= 0 && i < vertices), `${label}: invalid triangle indices`);
          await material(group.material, `${label}:${part.name}`, part.role === 'third-eye');
        }
      }
      models.set(path, value);
    }
    const value = models.get(path);
    if (head) assert.ok(selectHeadModelParts(value).length, `${label}: independent head geometry missing`);
    return value;
  }
  for (const group of GROUPS) {
    assert.ok(Array.isArray(c[group]) && c[group].length, `${group}: native option array missing`);
    assert.deepEqual(c[group].map(entry => entry.index), c[group].map((_, index) => index), `${group}: native option indices not contiguous`);
    if (expectedCounts?.[group] !== undefined) {
      assert.equal(c[group].length, expectedCounts[group], `${group}: native option count differs`);
    }
  }
  const avatar = await model(c.avatar?.model, 'avatar base', true);
  for (const role of ['skin', 'eyes', 'mouth', 'accessory']) {
    assert.ok(avatar.parts.some(part => part.role === role), `avatar base: ${role} renderer missing`);
  }
  for (const entry of c.skins) assert.ok(Array.isArray(entry.color) && entry.color.length >= 3 && entry.color.every(Number.isFinite), 'skin: color missing');
  for (const group of ['eyes', 'mouths', 'accessories']) for (const entry of c[group]) {
    if (group === 'accessories' && (entry.isBlank || entry.isThirdEye)) continue;
    assert.equal(entry.textureEncoding, 'peak-face-mask', `${group}:${entry.index}: raw face mask is not decoded`);
    await asset(entry.texture, `${group}:${entry.index}: original mask`);
    await asset(entry.preview, `${group}:${entry.index}: decoded preview`);
  }
  if (c.accessories.some(entry => entry.isThirdEye)) {
    const third = await model(c.avatar?.thirdEyeModel, 'third eye');
    assert.ok(third.parts.some(part => part.role === 'third-eye'), 'third eye: source renderer missing');
  }
  for (const group of ['fits', 'hats', 'sashes', 'medals']) for (const entry of c[group]) {
    // Medal_None is an actual no-medal option, not a missing model to fabricate.
    if (group === 'medals' && entry.index === 0 && !entry.model) continue;
    await model(entry.model, `${group}:${entry.index}`);
    if (group === 'fits') {
      await material(entry.hatMaterial, `fits:${entry.index}: inherited hat material`);
      if (entry.overrideHat) assert.ok(pack.customizationIndex.hats.has(entry.overrideHatIndex), `fits:${entry.index}: override hat is absent`);
    }
  }
  const baseline = { captured: true, ready: true, formReady: true, form: 'normal', skinIndex: 0,
    eyesIndex: 0, mouthIndex: 0, accessoryIndex: 0, outfitIndex: 0, hatIndex: 0, sashIndex: 0, medalIndex: 0 };
  let checkedPlans = 0;
  function plan(appearance, label) {
    assert.equal(isHeadAppearanceReady(pack, appearance), true, `${label}: head cannot be rendered`);
    assert.ok(createAvatarRenderPlan(pack, appearance, true), `${label}: head plan missing`);
    assert.ok(createAvatarRenderPlan(pack, appearance, false), `${label}: body plan missing`);
    checkedPlans++;
  }
  const fields = { skins: 'skinIndex', eyes: 'eyesIndex', mouths: 'mouthIndex', accessories: 'accessoryIndex',
    fits: 'outfitIndex', hats: 'effectiveHatIndex', sashes: 'sashIndex', medals: 'medalIndex' };
  for (const group of GROUPS) for (const entry of c[group]) plan({ ...baseline, [fields[group]]: entry.index }, `${group}:${entry.index}`);
  for (const fit of c.fits) for (const hat of [0, 1]) {
    assert.ok(pack.customizationIndex.hats.has(hat), `Inherited hat ${hat} missing`);
    plan({ ...baseline, outfitIndex: fit.index, effectiveHatIndex: hat }, `fit ${fit.index} / inherited hat ${hat}`);
    const derived = createAvatarRenderPlan(pack, { ...baseline, outfitIndex: fit.index, hatIndex: hat }, true);
    assert.equal(derived.hat.index, fit.overrideHat ? fit.overrideHatIndex : hat, 'outfit override must select its real hat');
  }
  for (const form of FORMS) {
    const entry = c.forms?.find(value => value.form === form);
    assert.ok(entry, `${form}: transformation missing`);
    const body = await model(entry.model, `${form} body`), head = await model(entry.headModel, `${form} head`, true);
    assert.equal(body.form, form); assert.equal(head.form, form); assert.equal(head.purpose, 'form-head');
    assert.ok(Number.isSafeInteger(entry.source?.meshPathId) && entry.source.meshPathId > 0, `${form}: original source mesh missing`);
    assert.equal(entry.retainHat, form !== 'mushroom', `${form}: native hat rule differs`);
    if (form === 'chicken') assert.equal(entry.portraitScope, 'whole-form-no-head', 'A headless chicken must not acquire an invented face');
    const observed = { captured: true, ready: false, formReady: true, form };
    plan(observed, `observed ${form}`);
    assert.equal(createAvatarRenderPlan(pack, observed, true).models.length, 1, 'Unknown hats must not be invented for transformations');
  }
  return { build: pack.gameBuildId, options: Object.fromEntries(GROUPS.map(group => [group, c[group].length])),
    checkedPlans, models: models.size, referencedFiles: files.size, forms: FORMS.length };
}

function fixture() {
  const data = new Map();
  const put = (path, value) => { data.set(path, Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))); return path; };
  const part = (role, name = role) => ({ role, name, positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], uv: [0, 0, 1, 0, 0, 1],
    groups: [{ indices: [0, 1, 2], material: { color: [1, 1, 1, 1] } }] });
  const image = put('mask.png', 'test-original-mask'), preview = put('preview.png', 'test-decoded-mask');
  const face = index => ({ index, texture: image, preview, textureEncoding: 'peak-face-mask' });
  const mesh = put('model.json', { parts: [part('hat')] });
  const c = {
    avatar: { model: put('avatar.json', { parts: [part('skin', 'HeadMesh'), part('eyes'), part('mouth'), part('accessory')] }),
      thirdEyeModel: put('third-eye.json', { parts: [{ ...part('third-eye'), groups: [{ indices: [0, 1, 2],
        material: { texture: image, preview, textureEncoding: 'peak-face-mask' } }] }] }) },
    skins: [{ index: 0, color: [1, .5, .2, 1] }], eyes: [face(0)], mouths: [face(0)],
    accessories: [{ index: 0, isBlank: true }, { index: 1, isThirdEye: true }, face(2)],
    fits: [{ index: 0, model: mesh, hatMaterial: { texture: image }, overrideHat: true, overrideHatIndex: 1 }],
    hats: [{ index: 0, model: mesh }, { index: 1, model: mesh }], sashes: [{ index: 0, model: mesh }],
    medals: [{ index: 0 }, { index: 1, model: mesh }],
    forms: FORMS.map((form, index) => ({ form, retainHat: form !== 'mushroom', source: { meshPathId: index + 1 },
      portraitScope: form === 'chicken' ? 'whole-form-no-head' : 'source-head-bone-topology',
      model: put(`${form}.json`, { form, parts: [part('form-body')] }),
      headModel: put(`${form}-head.json`, { form, purpose: 'form-head', parts: [part('form-head')] }) })),
  };
  const catalog = { assets: [...data].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes) })), customization: c };
  const pack = { gameBuildId: 'fixture', catalogUrl: new URL('https://assets.invalid/fixture/catalog.json'), catalog, customization: c,
    customizationIndex: Object.fromEntries(GROUPS.map(group => [group, new Map(c[group].map(entry => [entry.index, entry]))])) };
  return { pack, c, data, read: path => data.get(path) };
}

test('complete catalog validates all native dimensions and real no-medal option without Cartesian expansion', async () => {
  const f = fixture(), report = await validateAvatarPack(f.pack, f.read);
  assert.equal(report.forms, 3); assert.equal(report.checkedPlans, 17);
});

test('native option counts detect omitted tail entries even when remaining indices are contiguous', async () => {
  const f = fixture();
  await assert.rejects(validateAvatarPack(f.pack, f.read, { eyes: 2 }), /native option count differs/);
  await assert.rejects(validateAvatarPack(f.pack, f.read, { hats: 3 }), /native option count differs/);
});

for (const [name, mutate, error] of [
  ['decoded eyes', f => { delete f.c.eyes[0].preview; }, /decoded preview/],
  ['third-eye renderer', f => { delete f.c.avatar.thirdEyeModel; }, /third eye/],
  ['outfit hat material', f => { delete f.c.fits[0].hatMaterial; }, /inherited hat material/],
  ['real outfit override', f => { f.c.fits[0].overrideHatIndex = 999; }, /override hat is absent/],
  ['native option gap', f => { f.c.mouths[0].index = 1; }, /indices not contiguous/],
  ['transformed head', f => { delete f.c.forms[0].headModel; }, /skeleton head/],
  ['source form evidence', f => { delete f.c.forms[1].source; }, /original source mesh missing/],
  ['unknown model texture', f => { const value = JSON.parse(f.data.get('model.json')); value.parts[0].groups[0].material.texture = 'missing.png';
    const bytes = Buffer.from(JSON.stringify(value)); f.data.set('model.json', bytes);
    Object.assign(f.pack.catalog.assets.find(a => a.path === 'model.json'), { bytes: bytes.length, sha256: hash(bytes) }); }, /unlisted asset missing.png/],
  ['corrupt model', f => { f.data.set('avatar.json', Buffer.from('corrupted')); }, /byte count differs/],
  ['missing independent head', f => { const value = JSON.parse(f.data.get('avatar.json')); value.parts[0].name = 'BodyMesh';
    const bytes = Buffer.from(JSON.stringify(value)); f.data.set('avatar.json', bytes);
    Object.assign(f.pack.catalog.assets.find(a => a.path === 'avatar.json'), { bytes: bytes.length, sha256: hash(bytes) }); }, /independent head/],
  ['missing face renderer', f => { const value = JSON.parse(f.data.get('avatar.json')); value.parts = value.parts.filter(part => part.role !== 'mouth');
    const bytes = Buffer.from(JSON.stringify(value)); f.data.set('avatar.json', bytes);
    Object.assign(f.pack.catalog.assets.find(a => a.path === 'avatar.json'), { bytes: bytes.length, sha256: hash(bytes) }); }, /mouth renderer missing/],
]) test(`incomplete pack rejects ${name} instead of silently leaving portraits blank`, async () => {
  const f = fixture(); mutate(f); await assert.rejects(validateAvatarPack(f.pack, f.read), error);
});

const realRoot = process.env.PEAK_TRAIL_AVATAR_ASSET_ROOT
  || fileURLToPath(new URL('../../data/avatar-assets/', import.meta.url));
test('actual exported current-build pack has complete avatar geometry, masks, cosmetics and transformations', async t => {
  const buildId = process.env.PEAK_TRAIL_AVATAR_BUILD || '25739797';
  await readGameAssets(realRoot); // Validate the complete deployment allowlist and hashes.
  const indexUrl = pathToFileURL(resolve(realRoot, 'catalog.json'));
  const pack = await loadGameAssetPack(buildId, { indexUrl, fetchImpl: async input => {
    try { const bytes = await readFile(fileURLToPath(input)); return { ok: true, json: async () => JSON.parse(bytes) }; }
    catch { return { ok: false, status: 404 }; }
  } });
  assert.ok(pack && pack.gameBuildId === buildId, 'The current build is not genuinely indexed');
  const report = await validateAvatarPack(pack, path => readFile(resolve(realRoot, buildId, path)));
  t.diagnostic(JSON.stringify(report));
});
