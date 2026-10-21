import { gameAssetFingerprint, resolveAppearanceAssets, resolveAppearanceVisuals, resolveGameAssetUrl } from "./game-assets.js";
import { appearanceVisualFingerprint } from "./appearance-visuals.js";

const renderCache = new Map();
const jsonCache = new Map();
const MAX_RENDER_CACHE_ENTRIES = 32;
let threeModulePromise = null;
let renderQueue = Promise.resolve();

export function createAvatarCamera(THREE, viewHeight, aspect) {
  return new THREE.OrthographicCamera(
    -viewHeight * aspect * 0.5,
    viewHeight * aspect * 0.5,
    viewHeight * 0.5,
    -viewHeight * 0.5,
    0.01,
    20,
  );
}

function getThree() {
  if (!threeModulePromise) {
    const task = import("three");
    threeModulePromise = task;
    task.catch(() => { if (threeModulePromise === task) threeModulePromise = null; });
  }
  return threeModulePromise;
}

async function fetchJson(url) {
  if (!jsonCache.has(url)) {
    const task = fetch(url, { cache: "force-cache" }).then(async (response) => {
      if (!response.ok) throw new Error(`模型读取失败（${response.status}）`);
      return response.json();
    });
    jsonCache.set(url, task);
    task.catch(() => {
      if (jsonCache.get(url) === task) jsonCache.delete(url);
    });
    while (jsonCache.size > 64) jsonCache.delete(jsonCache.keys().next().value);
  }
  return jsonCache.get(url);
}

function colorKey(color) {
  return Array.isArray(color) ? color.map((value) => Number(value).toFixed(4)).join(",") : "none";
}

export function avatarAppearanceFingerprint(pack, appearance) {
  if (!pack || !appearance?.captured) return "none";
  return [
    gameAssetFingerprint(pack),
    appearance.ready,
    appearance.formReady,
    appearance.form,
    appearance.skinIndex,
    appearance.eyesIndex,
    appearance.mouthIndex,
    appearance.accessoryIndex,
    appearance.outfitIndex,
    appearance.hatIndex,
    appearance.effectiveHatIndex,
    appearance.sashIndex,
    appearance.medalIndex,
    colorKey(appearance.skinColor),
    appearanceVisualFingerprint(appearance),
  ].join(":");
}

/** A head's identity never depends on sash/medal or body geometry. */
export function headAppearanceFingerprint(pack, appearance) {
  if (!pack || !appearance?.captured) return "none";
  return [
    gameAssetFingerprint(pack),
    appearance.ready,
    appearance.formReady,
    appearance.form,
    appearance.skinIndex,
    appearance.eyesIndex,
    appearance.mouthIndex,
    appearance.accessoryIndex,
    // Outfit metadata can override a hat and the cap/beret's fabric color.
    appearance.outfitIndex,
    appearance.hatIndex,
    appearance.effectiveHatIndex,
    colorKey(appearance.skinColor),
    appearanceVisualFingerprint(appearance),
  ].join(":");
}

export function resolveAvatarHat(pack, appearance, assets = resolveAppearanceAssets(pack, appearance)) {
  const fit = assets?.components.fit?.entry;
  const index = Number.isInteger(appearance?.effectiveHatIndex)
    ? appearance.effectiveHatIndex
    : fit?.overrideHat && Number.isInteger(fit.overrideHatIndex)
      ? fit.overrideHatIndex
      : appearance?.hatIndex;
  const entry = Number.isInteger(index) ? pack?.customizationIndex.hats.get(index) : null;
  return {
    index,
    entry,
    modelUrl: resolveGameAssetUrl(pack, entry?.model),
    material: [0, 1].includes(index) ? fit?.hatMaterial || null : null,
  };
}

/** Fail closed instead of substituting a generic face for missing telemetry. */
export function isHeadAppearanceReady(pack, appearance) {
  const assets = resolveAppearanceAssets(pack, appearance);
  if (!assets || assets.form.unavailable || resolveAppearanceVisuals(pack, appearance, true).some(state => !state.modelUrl)) return false;
  if (assets.form.form === "ghost") return Boolean(appearance.ready === true && assets.form.headModelUrl
    && ownerFaceReady(pack, appearance, assets)
    && (!assets.components.accessory?.entry?.isThirdEye || resolveGameAssetUrl(pack, assets.form.entry?.thirdEyeModel)));
  if (assets?.form.transformed) return Boolean(appearance?.captured && assets.form.headModelUrl);
  const hat = resolveAvatarHat(pack, appearance, assets);
  const faceAvailable = (role) => Boolean(assets && resolveGameAssetUrl(pack,
    selectedTextureReference(role, assets)?.reference));
  const accessory = assets?.components.accessory?.entry;
  const hasSkin = Array.isArray(appearance?.skinColor) && appearance.skinColor.length >= 3
    && appearance.skinColor.slice(0, 3).every(Number.isFinite);
  return Boolean(appearance?.captured && appearance.ready !== false && assets?.avatarModelUrl
    && assets.components.eyes?.entry && assets.components.mouth?.entry && assets.components.accessory?.entry
    && faceAvailable("eyes") && faceAvailable("mouth")
    && (accessory.isBlank || accessory.isThirdEye || faceAvailable("accessory"))
    && (hasSkin || assets.components.skin?.entry)
    && (!accessory.isThirdEye
      || resolveGameAssetUrl(pack, pack.customization.avatar?.thirdEyeModel))
    && hat.modelUrl
    // These two hats inherit their material from the selected outfit. This is
    // metadata only: head rendering never fetches fit/body model geometry.
    && (![0, 1].includes(hat.index) || hat.material));
}

function ownerFaceReady(pack, appearance, assets) {
  const skin = appearance.skinColor || assets.components.skin?.entry?.color;
  const accessory = assets.components.accessory?.entry;
  return Array.isArray(skin) && skin.length >= 3 && skin.slice(0, 3).every(Number.isFinite)
    && assets.components.eyes?.entry && assets.components.mouth?.entry && accessory
    && ["eyes", "mouth"].every(role => resolveGameAssetUrl(pack, selectedTextureReference(role, assets)?.reference))
    && (accessory.isBlank || accessory.isThirdEye || resolveGameAssetUrl(pack, selectedTextureReference("accessory", assets)?.reference));
}

/** Select the independently exported head, not an arbitrary crop of the body. */
export function selectHeadModelParts(model) {
  if (model?.purpose === "form-head" && model.form === "ghost") {
    return partsOf(model).filter(part => ["ghost-body", "eyes", "mouth", "accessory"].includes(part.role));
  }
  const parts = Array.isArray(model?.parts) ? model.parts : [];
  if (model?.purpose === "form-head" && ["skeleton", "mushroom", "chicken"].includes(model.form)) {
    return parts.filter((part) => part.role === "form-head");
  }
  const head = parts.filter((part) => part.role === "skin" && /^head(?:[ _-]?mesh)?$/i.test(part.name || ""));
  if (!head.length) return [];
  return parts.filter((part) => head.includes(part) || ["eyes", "mouth", "accessory"].includes(part.role));
}

const partsOf = model => Array.isArray(model?.parts) ? model.parts : [];

function completeEnoughToRender(appearance, assets) {
  if (!assets || assets.form.unavailable) return false;
  if (assets.form.form === "ghost") return Boolean(appearance?.captured && appearance.ready === true && assets.form.modelUrl);
  if (assets?.form.transformed) return Boolean(appearance?.captured && assets.form.modelUrl);
  return appearance?.ready !== false
    && Number.isInteger(appearance?.outfitIndex)
    && Number.isInteger(appearance?.eyesIndex)
    && Number.isInteger(appearance?.mouthIndex)
    && Number.isInteger(appearance?.accessoryIndex)
    && (Array.isArray(appearance?.skinColor) || Number.isInteger(appearance?.skinIndex))
    && Boolean(assets?.avatarModelUrl && assets?.components.fit?.modelUrl);
}

/** Pure model plan lets tests verify that a transformed head cannot retain
 * ordinary face cards, skin, third eye or a human outfit by accident. */
export function createAvatarRenderPlan(pack, appearance, headOnly = false) {
  const assets = resolveAppearanceAssets(pack, appearance);
  if (headOnly ? !isHeadAppearanceReady(pack, appearance) : !completeEnoughToRender(appearance, assets)) return null;
  const form = assets.form;
  const visuals = resolveAppearanceVisuals(pack, appearance, headOnly);
  if (visuals.some(state => !state.modelUrl)) return null;
  if (form.form === "ghost" && !ownerFaceReady(pack, appearance, assets)) return null;
  const hat = resolveAvatarHat(pack, appearance, assets);
  const models = [{ url: headOnly && form.transformed ? form.headModelUrl : assets.avatarModelUrl, headOnly }];
  if ((!form.transformed || form.form === "ghost") && assets.components.accessory?.entry?.isThirdEye) {
    const url = resolveGameAssetUrl(pack, form.form === "ghost" ? form.entry?.thirdEyeModel : pack.customization.avatar?.thirdEyeModel);
    if (!url) return null;
    models.push({ url });
  }
  if (!headOnly && !form.transformed) models.push({ url: assets.components.fit.modelUrl });
  const hatReady = hat.modelUrl && (![0, 1].includes(hat.index) || hat.material);
  if (hatReady && form.form !== "ghost" && (!form.transformed || form.entry?.retainHat === true)) {
    const offset = form.entry?.hatOffset;
    models.push({ url: hat.modelUrl, material: hat.material,
      offset: Array.isArray(offset) && offset.length === 3 && offset.every(Number.isFinite) ? [...offset] : [0, 0, 0] });
  }
  if (!headOnly && (!form.transformed || form.form === "skeleton")) {
    for (const role of ["sash", "medal"]) if (assets.components[role]?.modelUrl) models.push({ url: assets.components[role].modelUrl });
  }
  for (const visual of visuals) models.push({ url: visual.modelUrl, visual });
  return { assets, form, visuals, hat: hatReady && form.form !== "ghost" && (!form.transformed || form.entry?.retainHat) ? hat : null, models };
}

export function selectedTextureReference(role, assets) {
  const component = role === "eyes"
    ? assets.components.eyes
    : role === "mouth"
      ? assets.components.mouth
      : role === "accessory" ? assets.components.accessory : null;
  if (!component?.entry) return null;
  const decodedPreview = component.entry.textureEncoding === "peak-face-mask"
    ? component.entry.preview
    : null;
  return {
    // PEAK stores face-mask RGB under a fully transparent PNG alpha channel.
    // Browser image decoding premultiplies those hidden colors to black, so the
    // original mask cannot be reconstructed from a canvas. Prefer the exact
    // build's offline-decoded preview; it is still the original game artwork.
    reference: decodedPreview || component.entry.texture || component.entry.preview || null,
    decodeRole: decodedPreview ? null : component.entry.texture ? role : null,
    faceRole: role,
  };
}

function skinColor(appearance, assets, fallback) {
  const recorded = appearance.skinColor;
  const catalog = assets.components.skin?.entry?.color;
  const chosen = Array.isArray(recorded) ? recorded : Array.isArray(catalog) ? catalog : fallback;
  return [0, 1, 2].map((index) => Math.min(1, Math.max(0, Number(chosen?.[index]) || 0)));
}

function decodeFaceMask(THREE, texture, role, pupilScale = 1) {
  if (!role || typeof document === "undefined" || !texture.image) return texture;
  const width = texture.image.naturalWidth || texture.image.width;
  const height = texture.image.naturalHeight || texture.image.height;
  if (!width || !height) return texture;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return texture;
  context.drawImage(texture.image, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height);
  const original = role === "eyes" && Number.isFinite(pupilScale) && pupilScale !== 1
    ? new Uint8ClampedArray(pixels.data)
    : null;
  for (let offset = 0; offset < pixels.data.length; offset += 4) {
    const red = pixels.data[offset];
    let green = pixels.data[offset + 1];
    const blue = pixels.data[offset + 2];
    if (role === "eyes") {
      if (original) {
        const pixel = offset / 4;
        const x = pixel % width;
        const y = Math.floor(pixel / width);
        const sourceX = Math.min(width - 1, Math.max(0, Math.round(
          (x - (width - 1) * 0.5) / pupilScale + (width - 1) * 0.5,
        )));
        const sourceY = Math.min(height - 1, Math.max(0, Math.round(
          (y - (height - 1) * 0.5) / pupilScale + (height - 1) * 0.5,
        )));
        green = original[(sourceY * width + sourceX) * 4 + 1];
      }
      const shade = 255 - green;
      pixels.data[offset] = shade;
      pixels.data[offset + 1] = shade;
      pixels.data[offset + 2] = shade;
      pixels.data[offset + 3] = red;
    } else {
      pixels.data[offset] = 0;
      pixels.data[offset + 1] = 0;
      pixels.data[offset + 2] = 0;
      pixels.data[offset + 3] = 255 - Math.min(red, green, blue);
    }
  }
  context.putImageData(pixels, 0, 0);
  texture.dispose();
  const decoded = new THREE.CanvasTexture(canvas);
  decoded.colorSpace = THREE.SRGBColorSpace;
  return decoded;
}

async function loadTexture(THREE, pack, reference, transform, decodeRole = null, faceRole = null) {
  const url = resolveGameAssetUrl(pack, reference);
  if (!url) return null;
  let texture = await new THREE.TextureLoader().loadAsync(url);
  texture = decodeFaceMask(THREE, texture, decodeRole, Number(transform?.pupilScale) || 1);
  texture.colorSpace = THREE.SRGBColorSpace;
  const scale = Array.isArray(transform?.textureScale) ? transform.textureScale : [1, 1];
  const offset = Array.isArray(transform?.textureOffset) ? transform.textureOffset : [0, 0];
  if (faceRole && Number(transform?.faceScale) > 0) {
    const faceScale = Number(transform.faceScale);
    const faceOffset = Array.isArray(transform.faceOffset) ? transform.faceOffset : [0, 0];
    const repeat = 1 / faceScale;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.repeat.set(repeat, repeat);
    texture.offset.set(
      0.5 - repeat * 0.5 - (Number(faceOffset[0]) || 0),
      0.5 - repeat * 0.5 - (Number(faceOffset[1]) || 0),
    );
  } else {
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(Number(scale[0]) || 1, Number(scale[1]) || 1);
    texture.offset.set(Number(offset[0]) || 0, Number(offset[1]) || 0);
  }
  texture.needsUpdate = true;
  return texture;
}

export function stateMaterialPlan(materialData, visual) {
  if (!visual) return null;
  const source = materialData?.sourceProperties;
  const texture = property => source?.textures?.find(entry => entry.property === property);
  if (visual.state === "petrification") {
    const tint = source?.colors?._Tint;
    const crack = texture("_Texture1");
    return { color: tint ? [tint.r, tint.g, tint.b, tint.a] : materialData.color,
      texture: crack?.asset || null, textureScale: crack ? [crack.scale?.x ?? 1, crack.scale?.y ?? 1] : [1, 1],
      opacity: visual.coverage, unlit: false, renderOrder: 4, amount: visual.amount };
  }
  if (visual.state === "blindness") {
    const sourceTexture = texture("_Texture");
    return { color: materialData.color, texture: sourceTexture?.asset || null,
      textureScale: [sourceTexture?.scale?.x ?? 1, sourceTexture?.scale?.y ?? 1],
      opacity: materialData.color?.[3] ?? 1, unlit: true, renderOrder: 5 };
  }
  return null;
}

async function materialFor(THREE, pack, materialData, appearance, assets, visual = null) {
  const stateMaterial = stateMaterialPlan(materialData, visual);
  if (stateMaterial) {
    const map = stateMaterial.texture ? await loadTexture(THREE, pack, stateMaterial.texture, stateMaterial) : null;
    const color = new THREE.Color(...stateMaterial.color.slice(0, 3));
    const Material = stateMaterial.unlit ? THREE.MeshBasicMaterial : THREE.MeshStandardMaterial;
    const material = new Material({ color, map, transparent: true, depthWrite: false,
      opacity: stateMaterial.opacity, side: THREE.DoubleSide, alphaTest: 0.01,
      ...(stateMaterial.unlit ? {} : { roughness: 1, metalness: 0 }) });
    material.userData.nativeState = visual.state;
    if (Number.isFinite(visual.amount)) material.userData.nativePetrifyAmount = visual.amount;
    return material;
  }
  const role = String(materialData?.role || "").toLowerCase();
  const faceRole = role === "third-eye" ? "eyes" : role;
  const card = ["eyes", "mouth", "accessory"].includes(faceRole);
  // Third-eye cosmetics use their own serialized material, not the player's
  // selected ordinary-eye artwork or the disabled accessory card.
  const override = role === "third-eye"
    ? { reference: materialData.preview || materialData.texture, decodeRole: materialData.preview ? null : "eyes" }
    : selectedTextureReference(role, assets);
  const reference = override?.reference || materialData?.texture || null;
  const decodeRole = override?.decodeRole || (!override && ["eyes", "mouth", "accessory"].includes(role)
    ? role
    : null);
  const map = reference
    ? await loadTexture(THREE, pack, reference, materialData, decodeRole, card ? faceRole : null)
    : null;
  const sourceColor = role === "skin" || role === "ghost-body"
    ? skinColor(appearance, assets, materialData?.color)
    : Array.isArray(materialData?.color) ? materialData.color : [1, 1, 1, 1];
  const opacity = Math.min(1, Math.max(0, Number(sourceColor?.[3] ?? 1)));
  const color = new THREE.Color(
      Number(sourceColor?.[0] ?? 1),
      Number(sourceColor?.[1] ?? 1),
      Number(sourceColor?.[2] ?? 1),
    );
  if (materialData?.colorSpace === "srgb") color.convertSRGBToLinear();
  return new THREE.MeshStandardMaterial({
    color,
    map,
    transparent: card || opacity < 1,
    depthWrite: !card,
    opacity,
    alphaTest: card ? 0.04 : 0,
    roughness: 0.82,
    metalness: 0,
    side: THREE.DoubleSide,
  });
}

async function appendModel(THREE, root, pack, modelUrl, appearance, assets, materialOverride = null, headOnly = false, offset = [0, 0, 0], visual = null) {
  const model = await fetchJson(modelUrl);
  const parts = headOnly ? selectHeadModelParts(model) : Array.isArray(model?.parts) ? model.parts : [];
  if (headOnly && !parts.length) throw new Error("该版本缺少独立头部模型，未使用全身裁切替代");
  for (const part of parts) {
    if (!Array.isArray(part.positions) || !Array.isArray(part.groups)) continue;
    if (part.role === "accessory" && (assets.components.accessory?.entry?.isBlank
      || assets.components.accessory?.entry?.isThirdEye)) continue;
    for (const group of part.groups) {
      if (!Array.isArray(group?.indices) || !group.indices.length) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(part.positions, 3));
      const hasColors = Array.isArray(part.colors) && part.colors.length === part.positions.length
        && part.colors.every(Number.isFinite);
      if (hasColors) geometry.setAttribute("color", new THREE.Float32BufferAttribute(part.colors, 3));
      if (Array.isArray(part.uv) && part.uv.length === (part.positions.length / 3) * 2) {
        geometry.setAttribute("uv", new THREE.Float32BufferAttribute(part.uv, 2));
      }
      geometry.setIndex(group.indices);
      geometry.computeVertexNormals();
      const materialData = materialOverride && String(group.material?.role || "").toLowerCase() === "hat"
        ? materialOverride
        : group.material;
      let material;
      try {
        material = await materialFor(THREE, pack, materialData, appearance, assets, visual);
        material.vertexColors = hasColors;
      } catch (error) {
        geometry.dispose();
        throw error;
      }
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.fromArray(offset);
      mesh.name = `${part.name || "PEAK part"}:${group.material?.name || "material"}`;
      if (visual) mesh.renderOrder = visual.state === "blindness" ? 5 : 4;
      // Skin writes depth; transparent face cards do not occlude one another.
      // The recorded accessory's game metadata determines its layering.
      if (["eyes", "mouth", "accessory", "third-eye"].includes(part.role)) {
        mesh.renderOrder = part.role === "accessory"
          ? assets.components.accessory?.entry?.drawUnderEye ? 1 : 3
          : 2;
      }
      root.add(mesh);
    }
  }
}

async function renderAvatar(pack, appearance, width, height, headOnly = false) {
  if (typeof document === "undefined") return null;
  const plan = createAvatarRenderPlan(pack, appearance, headOnly);
  if (!plan) return null;
  const { assets, form, hat } = plan;
  const THREE = await getThree();
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  let renderer = null;
  let root = null;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(width, height, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0x000000, 0);

    const scene = new THREE.Scene();
    root = new THREE.Group();
    scene.add(root);
    const fit = assets.components.fit?.entry;
    for (const model of plan.models) {
      await appendModel(THREE, root, pack, model.url, appearance, assets, model.material, model.headOnly, model.offset, model.visual);
    }

    const box = new THREE.Box3().setFromObject(root);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    root.position.sub(center);
    const aspect = width / height;
    const padding = headOnly ? 1.2 : 1.14;
    const viewHeight = Math.max(size.y * padding, size.x / aspect * padding, 0.1);
    const camera = createAvatarCamera(THREE, viewHeight, aspect);
    camera.position.set(0, size.y * 0.02, Math.max(3, size.z + 2.5));
    camera.lookAt(0, size.y * 0.02, 0);
    scene.add(new THREE.HemisphereLight(0xfff4dc, 0x19313a, 2.2));
    const key = new THREE.DirectionalLight(0xfff1d0, 2.8);
    key.position.set(-3, 4, 5);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x87cfc8, 1.6);
    rim.position.set(4, 2, -3);
    scene.add(rim);
    renderer.render(scene, camera);
    return {
      dataUrl: canvas.toDataURL("image/png"),
      kind: headOnly ? "recorded-head-composite" : "recorded-model-composite",
      form: form.form,
      portraitScope: form.transformed ? form.entry?.portraitScope || "source-form-head" : "cosmetic-head",
      visualStates: plan.visuals.map(state => state.state),
      fitName: form.transformed ? null : appearance.outfitName || fit?.name || null,
      hatName: hat?.entry
        ? String(hat.entry.name || `Hat ${hat.index}`)
        : null,
      hasHat: Boolean(hat),
      sashName: headOnly ? null : assets.components.sash?.entry?.name || null,
      medalName: headOnly ? null : assets.components.medal?.entry?.name || null,
    };
  } finally {
    root?.traverse((object) => {
      if (!object.isMesh) return;
      object.geometry?.dispose();
      object.material?.map?.dispose();
      object.material?.dispose();
    });
    renderer?.dispose();
    renderer?.forceContextLoss?.();
  }
}

/** Renders extracted PEAK geometry only; it never substitutes generated artwork. */
export function renderAvatarPreview(pack, appearance, { width = 192, height = 256 } = {}) {
  const fingerprint = avatarAppearanceFingerprint(pack, appearance);
  return requestPreview(pack, appearance, fingerprint, width, height, false);
}

/** Exact-build head + selected face + effective hat, with no torso or outfit mesh. */
export function renderHeadPreview(pack, appearance, { width = 128, height = 128 } = {}) {
  if (!isHeadAppearanceReady(pack, appearance)) return Promise.resolve(null);
  return requestPreview(pack, appearance, headAppearanceFingerprint(pack, appearance), width, height, true);
}

function requestPreview(pack, appearance, fingerprint, requestedWidth, requestedHeight, headOnly) {
  if (fingerprint === "none") return Promise.resolve(null);
  const dimension = (value) => Math.min(1024, Math.max(16, Math.round(Number(value) || 128)));
  const width = dimension(requestedWidth);
  const height = dimension(requestedHeight);
  const cacheKey = `${headOnly ? "head" : "body"}:${fingerprint}:${width}x${height}`;
  if (renderCache.has(cacheKey)) return renderCache.get(cacheKey);
  // Snapshot the asynchronous request so advancing the timeline cannot mutate a
  // queued render into a different face under the old cache key.
  const snapshot = { ...appearance, skinColor: appearance.skinColor?.slice() };
  const task = renderQueue.then(() => renderAvatar(pack, snapshot, width, height, headOnly));
  renderQueue = task.catch(() => null);
  renderCache.set(cacheKey, task);
  const forget = () => {
    if (renderCache.get(cacheKey) === task) renderCache.delete(cacheKey);
  };
  task.then((result) => { if (!result) forget(); }, forget);
  while (renderCache.size > MAX_RENDER_CACHE_ENTRIES) {
    renderCache.delete(renderCache.keys().next().value);
  }
  return task;
}
