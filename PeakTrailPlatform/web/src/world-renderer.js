import * as THREE from 'three';
import { resolveGameAssetUrl, resolveItemAsset } from './game-assets.js';
import { worldObjectsAtTime, worldObjectVisible, worldObjectInBounds, worldWarning, worldEffectsAtTime } from './world-timeline.js';
import { createReplayFogMaterial } from './fog-material.js';
import { getSourceEffectMaterial } from './source-materials.js';

const LABELS = { item: '掉落物', placed_object: '放置物', mine: '孢子地雷', zombie: '蘑菇僵尸', zombie_spawn: '僵尸生成点', sleep_fog: '昏睡雾', spore_cloud: '孢子云', fog_safe_zone: '灯光保护区' };
function disposeTree(root) {
  const geometries = new Set(), materials = new Set(), textures = new Set();
  root.traverse((node) => { if (node.geometry) geometries.add(node.geometry); for (const material of Array.isArray(node.material) ? node.material : node.material ? [node.material] : []) materials.add(material); });
  for (const material of materials) { for (const value of Object.values(material)) if (value?.isTexture) textures.add(value); material.dispose(); }
  for (const texture of textures) texture.dispose();
  for (const geometry of geometries) geometry.dispose();
  root.clear();
}

export class WorldRenderer {
  constructor(canvas) {
    this.root = new THREE.Group();
    this.effectRoot = new THREE.Group();
    this.root.add(this.effectRoot);
    this.canvas = canvas;
    this.overlay = document.createElement('div');
    this.overlay.className = 'world-labels';
    this.overlay.setAttribute('aria-hidden', 'true');
    canvas.parentElement.append(this.overlay);
    this.entries = new Map();
    this.templates = new Map();
    this.pack = null;
    this.trace = null;
    this.revision = 0;
    this.origin = new THREE.Vector3();
    this.enabled = true;
    this.effectsKey = '';
    this.alerts = [];
  }

  setData(trace, pack, origin) {
    if (trace !== this.trace || pack !== this.pack) {
      ++this.revision;
      for (const entry of this.entries.values()) {
        entry.group.removeFromParent(); entry.label.remove();
        if (entry.owned) disposeTree(entry.group);
      }
      this.entries.clear();
      // Templates own shared model geometries/materials; clones do not dispose them.
      for (const promise of this.templates.values()) void promise.then((template) => { if (template) disposeTree(template); });
      this.templates.clear();
      disposeTree(this.effectRoot); this.effectsKey = '';
    }
    this.trace = trace; this.pack = pack; this.origin.copy(origin);
  }

  resolveAsset(object) {
    const canonical = (name) => String(name || '').replace(/\(Clone\)$/i, '').trim().toLowerCase();
    const exact = (this.pack?.catalog.worldObjects || []).find((entry) => canonical(entry.prefabName) === canonical(object.prefabName));
    const kindFallback = ['zombie', 'zombie_spawn'].includes(object.kind)
      ? (this.pack?.catalog.worldObjects || []).find((entry) => entry.kind === 'zombie') : null;
    const item = resolveItemAsset(this.pack, object);
    const entry = exact || kindFallback || item?.entry;
    return { modelUrl: resolveGameAssetUrl(this.pack, entry?.worldModel || entry?.model),
      iconUrl: resolveGameAssetUrl(this.pack, entry?.icon) || item?.iconUrl,
      name: entry?.name || item?.name || LABELS[object.kind] || object.prefabName };
  }

  async template(url) {
    if (!this.templates.has(url)) {
      const revision = this.revision, pack = this.pack;
      this.templates.set(url, (async () => {
        const response = await fetch(url, { cache: 'force-cache' });
        if (!response.ok) throw new Error('模型读取失败');
        const model = await response.json();
        if (model.coordinateSpace !== 'unity-prefab-local-meters' || !Array.isArray(model.parts)) throw new Error('世界模型坐标系无效');
        const root = new THREE.Group();
        const textures = new Map();
        try {
          for (const part of model.parts) {
            if (!Array.isArray(part.positions) || part.positions.length % 3) continue;
            for (const section of part.groups || []) {
              const geometry = new THREE.BufferGeometry();
              geometry.setAttribute('position', new THREE.Float32BufferAttribute(part.positions, 3));
              if (part.uv?.length === part.positions.length / 3 * 2) geometry.setAttribute('uv', new THREE.Float32BufferAttribute(part.uv, 2));
              geometry.setIndex(section.indices); geometry.computeVertexNormals();
              const input = section.material || {}, rgba = input.color || [1, 1, 1, 1];
              const color = new THREE.Color().fromArray(rgba);
              if (input.colorSpace === 'srgb') color.convertSRGBToLinear();
              const material = new THREE.MeshStandardMaterial({ color, roughness: 0.9, side: THREE.DoubleSide,
                opacity: rgba[3] ?? 1, transparent: (rgba[3] ?? 1) < 1, alphaTest: 0.08 });
              const mesh = new THREE.Mesh(geometry, material); root.add(mesh);
              const textureUrl = resolveGameAssetUrl(pack, input.texture);
              if (textureUrl) {
                const key = JSON.stringify([textureUrl, input.textureScale, input.textureOffset]);
                if (!textures.has(key)) {
                  const texture = await new THREE.TextureLoader().loadAsync(textureUrl);
                  texture.colorSpace = THREE.SRGBColorSpace; texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
                  if (input.textureScale) texture.repeat.fromArray(input.textureScale);
                  if (input.textureOffset) texture.offset.fromArray(input.textureOffset);
                  textures.set(key, texture);
                }
                material.map = textures.get(key); material.needsUpdate = true;
              }
            }
          }
          if (revision !== this.revision) { disposeTree(root); return null; }
          return root;
        } catch (error) { disposeTree(root); throw error; }
      })().catch(() => null));
    }
    return this.templates.get(url);
  }

  createEntry(object) {
    const group = new THREE.Group(), asset = this.resolveAsset(object);
    const label = document.createElement('div'); label.className = 'world-label';
    const icon = document.createElement('img'); icon.alt = ''; icon.hidden = !asset.iconUrl;
    if (asset.iconUrl) icon.src = asset.iconUrl;
    const text = document.createElement('span'); text.textContent = asset.name;
    label.append(icon, text); label.hidden = true; this.overlay.append(label);
    const entry = { group, label, text, asset, object, owned: true, warning: null };
    this.root.add(group); this.entries.set(object.objectId, entry);
    if (['sleep_fog', 'spore_cloud'].includes(object.kind)) {
      const material = createReplayFogMaterial();
      material.uniforms.sphere.value = object.shape !== 'box';
      material.uniforms.fogColor.value.set(object.kind === 'sleep_fog' ? '#b698d9' : '#cad77f');
      if (object.source.includes('StatusFieldGloom')) {
        const source = getSourceEffectMaterial(this.pack?.gameBuildId, 'FogSurface', 'GD/FogSurface');
        if (source) material.uniforms.fogColor.value.fromArray(source.baseColor);
      }
      const volume = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), material);
      const localCamera = new THREE.Vector3();
      volume.onBeforeRender = (_renderer, _scene, camera) => {
        material.uniforms.inverseWorld.value.copy(volume.matrixWorld).invert();
        if (camera) {
          localCamera.copy(camera.position).applyMatrix4(material.uniforms.inverseWorld.value);
          // Outside: test the front entry surface, not an underground back face.
          // Inside: the camera is already in the recorded volume; exit faces may
          // sit behind terrain. This bounded overlay is not a scene-depth shader.
          material.depthTest = Math.max(...localCamera.toArray().map(Math.abs)) >= 1;
        }
      };
      group.add(volume); entry.fogMaterial = material;
    } else if (object.kind === 'fog_safe_zone') {
      const safe = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 12), new THREE.MeshBasicMaterial({ color: 0x9bdeb8, wireframe: true, transparent: true, opacity: 0.18, depthWrite: false }));
      group.add(safe);
    } else {
      // A small location ring is an explicitly symbolic fallback, never a fake item model.
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.28, 0.4, 24), new THREE.MeshBasicMaterial({ color: object.kind === 'mine' ? 0xe59d50 : 0x83dcc6, side: THREE.DoubleSide, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2; ring.position.y = 0.06; group.add(ring);
      if (asset.modelUrl && !['zombie', 'zombie_spawn'].includes(object.kind)) {
        const revision = this.revision;
        void this.template(asset.modelUrl).then((template) => {
          if (!template || revision !== this.revision || this.entries.get(object.objectId) !== entry) return;
          disposeTree(group); group.add(template.clone(true)); entry.owned = false;
        });
      }
    }
    return entry;
  }

  update(time, { bounds = null, players = [], heightScale = 1 } = {}) {
    this.time = time; this.root.scale.y = heightScale; this.heightScale = heightScale;
    this.alerts = [];
    const alive = new Set();
    const objects = worldObjectsAtTime(this.trace?.worldTimeline, time);
    const safeZones = objects.filter((object) => object.kind === 'fog_safe_zone' && worldObjectVisible(object) && object.radius > 0);
    this.objects = objects;
    for (const object of objects) {
      if (!worldObjectVisible(object) || !worldObjectInBounds(object, bounds)) continue;
      alive.add(object.objectId);
      const entry = this.entries.get(object.objectId) || this.createEntry(object);
      entry.object = object;
      entry.warning = worldWarning(object, players);
      if (entry.warning) this.alerts.push(entry.warning);
      const enemy = ['zombie', 'zombie_spawn'].includes(object.kind);
      entry.group.visible = this.enabled && (!enemy || Boolean(entry.warning));
      entry.group.position.fromArray(object.pos).sub(this.origin);
      entry.group.quaternion.fromArray(object.rot).normalize();
      if (['sleep_fog', 'spore_cloud'].includes(object.kind)) {
        const r = object.radius;
        const size = object.size || (r !== null ? [r * 2, r * 2, r * 2] : null);
        entry.group.visible &&= Boolean(size?.every((n) => n > 0));
        if (size) entry.group.scale.set(...size.map((n) => Math.abs(n) / 2));
        const uniforms = entry.fogMaterial.uniforms;
        uniforms.replayTime.value = time; uniforms.worldOrigin.value.copy(this.origin); uniforms.heightScale.value = heightScale;
        const nearbySafeZones = object.kind === 'sleep_fog' ? [...safeZones].sort((a, b) => Math.hypot(...a.pos.map((v, i) => v - object.pos[i])) - Math.hypot(...b.pos.map((v, i) => v - object.pos[i]))).slice(0, 32) : [];
        uniforms.safeCount.value = nearbySafeZones.length;
        nearbySafeZones.forEach((safe, i) => uniforms.safeZones.value[i].set(...safe.pos, safe.radius));
      } else if (object.kind === 'fog_safe_zone') {
        entry.group.scale.setScalar(object.radius ?? 0);
      } else entry.group.scale.fromArray(object.scale);
      const distance = entry.warning ? ` · ${Math.round(entry.warning.distance)}m` : '';
      const name = ['item', 'placed_object'].includes(object.kind) ? entry.asset.name : LABELS[object.kind];
      entry.text.textContent = `${name}${distance}${enemy ? entry.warning?.active ? ' · 已激活' : ' · 预警' : ''}${object.statusEnabled === false ? ' · 昏睡关闭' : ''}`;
      entry.label.classList.toggle('is-danger', Boolean(entry.warning?.active));
      entry.label.dataset.kind = object.kind;
      entry.label.title = `${object.prefabName} · ${object.activity} · ${object.source}${entry.asset.modelUrl ? '' : ' · 图标/范围示意'}`;
    }
    for (const [id, entry] of this.entries) {
      if (alive.has(id)) continue;
      entry.group.removeFromParent(); entry.label.remove();
      if (entry.owned) disposeTree(entry.group);
      this.entries.delete(id);
    }
    const effects = worldEffectsAtTime(this.trace?.events, time).filter((effect) => worldObjectInBounds(effect, bounds));
    const key = effects.map((effect) => `${effect.objectId}:${effect.t}`).join('|');
    if (key !== this.effectsKey) {
      disposeTree(this.effectRoot); this.effectsKey = key;
      for (const effect of effects) {
        const burst = new THREE.Group(); burst.userData.event = effect;
        const ring = new THREE.Mesh(new THREE.RingGeometry(0.88, 1, 48), new THREE.MeshBasicMaterial({ color: 0xffb84b, side: THREE.DoubleSide, transparent: true, depthTest: false, depthWrite: false }));
        ring.rotation.x = -Math.PI / 2; ring.renderOrder = 60; burst.add(ring);
        const sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 10), new THREE.MeshBasicMaterial({ color: 0xff784c, wireframe: true, transparent: true, opacity: 0.7, depthTest: false, depthWrite: false }));
        sphere.renderOrder = 60; burst.add(sphere); this.effectRoot.add(burst);
      }
    }
    for (const burst of this.effectRoot.children) {
      const event = burst.userData.event, progress = (time - event.t) / 3;
      burst.position.fromArray(event.pos).sub(this.origin); burst.position.y += 0.15;
      const radius = Math.max(0.5, event.radius ?? 4) * (0.08 + Math.sqrt(progress) * 0.92);
      burst.scale.setScalar(radius); burst.visible = this.enabled;
      for (const mesh of burst.children) mesh.material.opacity = (1 - progress) * 0.8;
    }
    this.root.visible = this.enabled;
  }

  projectLabels(camera) {
    const width = this.canvas.clientWidth, height = this.canvas.clientHeight, point = new THREE.Vector3();
    let count = 0;
    // Prewarned enemies are always prioritized over ordinary item labels.
    const sorted = [...this.entries.values()].sort((a, b) => Number(Boolean(b.warning)) - Number(Boolean(a.warning)));
    for (const entry of sorted) {
      entry.label.hidden = true;
      if (!entry.group.visible || !this.enabled || count >= 36) continue;
      const object = entry.object;
      point.set(object.pos[0] - this.origin.x, (object.pos[1] - this.origin.y + (object.kind.includes('zombie') ? 2 : 0.6)) * this.heightScale, object.pos[2] - this.origin.z).project(camera);
      if (point.z < -1 || point.z > 1 || Math.abs(point.x) > 0.98 || Math.abs(point.y) > 0.92) continue;
      entry.label.hidden = false; count++;
      entry.label.style.transform = `translate(${(point.x * 0.5 + 0.5) * width}px, ${(-point.y * 0.5 + 0.5) * height}px) translate(-50%,-100%)`;
    }
  }

  dispose() { this.setData(null, null, this.origin); disposeTree(this.root); this.overlay.remove(); }
}
