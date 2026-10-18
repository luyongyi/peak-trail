import * as THREE from "three";
import { lootTypeStyle, MAP_LOOT_MAX_BEAM_HEIGHT } from "./map-loot-style.js";

export { lootTypeStyle, LOOT_TYPE_STYLES, MAP_LOOT_MAX_BEAM_HEIGHT } from "./map-loot-style.js";

const BEAM_VERTEX = `
  attribute vec3 instanceTint;
  varying vec2 vUv;
  varying vec3 vTint;
  void main() {
    vUv = uv;
    vTint = instanceTint;
    // Keep the ribbon upright in the world, while its horizontal width faces
    // the camera. Its real top and bottom remain at the finite world heights.
    vec4 viewPoint = modelViewMatrix * instanceMatrix * vec4(0.0, position.y, 0.0, 1.0);
    viewPoint.x += position.x * length(instanceMatrix[0].xyz) * mix(1.0, 0.28, position.y);
    gl_Position = projectionMatrix * viewPoint;
  }
`;
const BEAM_FRAGMENT = `
  uniform float opacity;
  varying vec2 vUv;
  varying vec3 vTint;
  void main() {
    float radius = 1.0 - abs(vUv.x * 2.0 - 1.0);
    float glow = pow(max(0.0, radius), 2.4) * 0.36 + pow(max(0.0, radius), 15.0) * 0.56;
    float envelope = smoothstep(0.0, 0.045, vUv.y) * (1.0 - smoothstep(0.62, 1.0, vUv.y));
    float alpha = glow * envelope * opacity;
    if (alpha < 0.002) discard;
    gl_FragColor = vec4(vTint, alpha);
    #include <colorspace_fragment>
  }
`;
const CAP_VERTEX = `
  attribute vec3 markerColor;
  attribute float markerKind;
  uniform float pixelRatio;
  varying vec3 vTint;
  varying float vKind;
  void main() {
    vTint = markerColor;
    vKind = markerKind;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    float isChest = step(0.5, markerKind) * (1.0 - step(1.5, markerKind));
    float isAnimal = step(1.5, markerKind);
    gl_PointSize = (11.0 + 4.0 * isChest + 11.0 * isAnimal) * pixelRatio;
  }
`;
const CAP_FRAGMENT = `
  uniform float opacity;
  varying vec3 vTint;
  varying float vKind;
  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float isChest = step(0.5, vKind) * (1.0 - step(1.5, vKind));
    float isAnimal = step(1.5, vKind);
    float edge = mix(length(p), abs(p.x) + abs(p.y), isChest);
    float alpha = (1.0 - smoothstep(0.86, 1.0, edge)) * opacity;
    if (alpha < 0.005) discard;
    float outline = smoothstep(0.59, 0.73, edge);
    float body = step(abs(p.x), 0.34) * step(abs(p.y), 0.23);
    float lid = step(abs(p.x), 0.34) * step(abs(p.y + 0.05), 0.035);
    float lock = step(abs(p.x), 0.05) * step(abs(p.y - 0.02), 0.08);
    float chest = body * (0.7 + 0.3 * lid) * (1.0 - 0.8 * lock);
    float item = 1.0 - smoothstep(0.20, 0.28, abs(p.x) + abs(p.y));
    // A rounded paw badge makes animals recognizable without another texture
    // or draw call. Kind values select glyphs instead of extrapolating a mix.
    float pawPad = 1.0 - smoothstep(0.82, 1.0, length((p - vec2(0.0, 0.20)) / vec2(0.28, 0.23)));
    float toes = min(min(length(p - vec2(-0.33, -0.10)), length(p - vec2(-0.13, -0.33))),
                    min(length(p - vec2(0.13, -0.33)), length(p - vec2(0.33, -0.10))));
    float paw = max(pawPad, 1.0 - smoothstep(0.10, 0.135, toes));
    float glyph = mix(mix(item, chest, isChest), paw, isAnimal);
    gl_FragColor = vec4(mix(vTint * 0.12, vTint, max(outline, glyph)), alpha);
    #include <colorspace_fragment>
  }
`;

function coordinate(value) {
  if (Array.isArray(value)) return value.slice(0, 3);
  if (value && typeof value === "object") return [value.x, value.y, value.z];
  return null;
}

function finitePoint(value) {
  return Array.isArray(value) && value.length === 3 && value.every(axis => typeof axis === "number" && Number.isFinite(axis) && Math.abs(axis) < 1e7);
}

function normalizeMarker(marker, index, types) {
  if (!marker || typeof marker !== "object") return null;
  const pos = coordinate(marker.pos ?? marker.position);
  if (!finitePoint(pos)) return null;
  const type = String(marker.type ?? "item");
  const definition = types.get(type);
  const requestedCategory = marker.category ?? definition?.category;
  const category = requestedCategory === "chest" || requestedCategory === "animal" ? requestedCategory : "item";
  return { ...marker, id: marker.id ?? `loot-${index}`, type, category, pos,
    color: marker.color ?? definition?.color,
    segment: Number.isInteger(marker.segment) ? marker.segment : Number.isInteger(marker.stageIndex) ? marker.stageIndex : null };
}

function samePlacement(left, right) {
  return left.id === right.id && left.type === right.type && left.category === right.category && left.color === right.color
    && left.segment === right.segment && left.layerId === right.layerId && left.pos.every((axis, index) => axis === right.pos[index]);
}

function sameTypes(left, right) {
  return left === right || (left !== null && right !== null && left.size === right.size && [...left].every(type => right.has(type)));
}

/**
 * Finite, instanced map beacons. Attach root beneath TrailScene.worldRoot, which
 * performs the sole Unity-to-Three Z reflection. Anchors obey heightScale while
 * beacon lengths stay at 9–14 displayed world meters, even in exaggerated views.
 * No clock, DOM, textures or network access is required.
 */
export class MapLootOverlay {
  constructor() {
    this.root = new THREE.Group();
    this.root.name = "map-loot-markers";
    this.root.visible = false;
    this.markers = [];
    this.visibleMarkers = [];
    this.context = { origin: [0, 0, 0], heightScale: 1, activeSegment: null, selectedLayerId: null };
    this.enabled = true;
    this.types = null;
    this.capacity = 0;
    this.pixelRatio = 1;
    this.resources = null;
    this.disposed = false;
  }

  setData(input) {
    if (this.disposed) return this;
    const markers = Array.isArray(input) ? input : input?.markers ?? [];
    const definitions = new Map((Array.isArray(input?.types) ? input.types : []).map(type => [String(type.id), type]));
    const normalized = (Array.isArray(markers) ? markers : []).map((marker, index) => normalizeMarker(marker, index, definitions)).filter(Boolean);
    const same = normalized.length === this.markers.length && normalized.every((marker, index) => samePlacement(marker, this.markers[index]));
    this.markers = normalized;
    if (same) {
      // Panel renders may provide fresh objects for identical placements. Keep
      // provenance/name metadata current without uploading every GPU buffer.
      const byId = new Map(normalized.map(marker => [marker.id, marker]));
      this.visibleMarkers = this.visibleMarkers.map(marker => byId.get(marker.id));
      return this;
    }
    return this.refresh();
  }

  setContext(input = {}) {
    if (this.disposed) return this;
    const next = { ...this.context };
    if (Object.hasOwn(input, "origin")) {
      const origin = coordinate(input.origin);
      if (finitePoint(origin)) next.origin = origin;
    }
    if (Object.hasOwn(input, "heightScale")) next.heightScale = THREE.MathUtils.clamp(Number(input.heightScale) || 1, 0.2, 5);
    if (Object.hasOwn(input, "activeSegment")) next.activeSegment = Number.isInteger(input.activeSegment) ? input.activeSegment : null;
    if (Object.hasOwn(input, "selectedLayerId")) next.selectedLayerId = input.selectedLayerId ?? null;
    if (next.origin.every((axis, index) => axis === this.context.origin[index]) && next.heightScale === this.context.heightScale
        && next.activeSegment === this.context.activeSegment && next.selectedLayerId === this.context.selectedLayerId) return this;
    this.context = next;
    return this.refresh();
  }

  setFilters(input = {}) {
    if (this.disposed) return this;
    const enabled = Object.hasOwn(input, "enabled") ? Boolean(input.enabled) : this.enabled;
    const types = Object.hasOwn(input, "types") ? input.types === null || input.types === undefined ? null : new Set(input.types) : this.types;
    if (enabled === this.enabled && sameTypes(types, this.types)) return this;
    this.enabled = enabled;
    this.types = types;
    return this.refresh();
  }

  setPixelRatio(value) {
    this.pixelRatio = THREE.MathUtils.clamp(Number(value) || 1, 1, 3);
    if (this.resources) for (const material of this.resources.capMaterials) material.uniforms.pixelRatio.value = this.pixelRatio;
    return this;
  }

  refresh() {
    if (this.disposed) return this;
    const { activeSegment, selectedLayerId, origin, heightScale } = this.context;
    const visible = this.enabled ? this.markers.filter(marker =>
      (this.types === null || this.types.has(marker.type))
      && (activeSegment === null || marker.segment === activeSegment)
      && (selectedLayerId === null || !marker.layerId || marker.layerId === selectedLayerId)) : [];
    this.visibleMarkers = visible;
    this.root.visible = visible.length > 0;
    if (!visible.length) {
      if (this.resources) {
        this.resources.beam.count = this.resources.beamXray.count = 0;
        this.resources.ring.count = this.resources.ringXray.count = 0;
        this.resources.cap.geometry.setDrawRange(0, 0);
      }
      return this;
    }
    this.ensureCapacity(visible.length);
    const resources = this.resources;
    const matrix = new THREE.Matrix4(), rotation = new THREE.Quaternion(), center = new THREE.Vector3(), scale = new THREE.Vector3(), color = new THREE.Color();
    visible.forEach((marker, index) => {
      const style = lootTypeStyle(marker.type, marker.category, marker.color);
      const height = Math.min(MAP_LOOT_MAX_BEAM_HEIGHT, style.beamHeight);
      center.set(marker.pos[0] - origin[0], (marker.pos[1] - origin[1]) * heightScale + 0.12, marker.pos[2] - origin[2]);
      color.set(style.color);
      scale.set(style.beamWidth / 2, height, 1);
      matrix.compose(center, rotation, scale);
      resources.beam.setMatrixAt(index, matrix);
      resources.tint.setXYZ(index, color.r, color.g, color.b);
      scale.setScalar(style.kind === "animal" ? 1.1 : style.kind === "chest" ? 1 : 0.7);
      matrix.compose(center, rotation, scale);
      resources.ring.setMatrixAt(index, matrix);
      resources.ring.setColorAt(index, color);
      resources.capPositions.setXYZ(index, center.x, center.y + height, center.z);
      resources.capColors.setXYZ(index, color.r, color.g, color.b);
      resources.capKinds.setX(index, style.kind === "animal" ? 2 : style.kind === "chest" ? 1 : 0);
    });
    resources.beam.count = resources.beamXray.count = resources.ring.count = resources.ringXray.count = visible.length;
    resources.beam.instanceMatrix.needsUpdate = resources.ring.instanceMatrix.needsUpdate = true;
    resources.ringXray.instanceColor = resources.ring.instanceColor;
    resources.ring.instanceColor.needsUpdate = true;
    resources.tint.needsUpdate = resources.capPositions.needsUpdate = resources.capColors.needsUpdate = resources.capKinds.needsUpdate = true;
    resources.cap.geometry.setDrawRange(0, visible.length);
    resources.cap.geometry.computeBoundingSphere();
    return this;
  }

  ensureCapacity(count) {
    if (this.capacity >= count) return;
    this.releaseResources();
    this.capacity = Math.max(16, 2 ** Math.ceil(Math.log2(count)));
    const capacity = this.capacity;
    const beamGeometry = new THREE.PlaneGeometry(2, 1);
    beamGeometry.translate(0, 0.5, 0);
    const tint = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    beamGeometry.setAttribute("instanceTint", tint);
    const beamMaterials = [0.82, 0.13].map((opacity, index) => new THREE.ShaderMaterial({
      vertexShader: BEAM_VERTEX, fragmentShader: BEAM_FRAGMENT, uniforms: { opacity: { value: opacity } },
      transparent: true, depthTest: true, depthFunc: index ? THREE.GreaterDepth : THREE.LessEqualDepth,
      depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
    }));
    const beam = new THREE.InstancedMesh(beamGeometry, beamMaterials[0], capacity);
    const beamXray = new THREE.InstancedMesh(beamGeometry, beamMaterials[1], capacity);
    beamXray.instanceMatrix = beam.instanceMatrix;
    beam.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const ringGeometry = new THREE.RingGeometry(0.79, 0.88, 40);
    ringGeometry.rotateX(-Math.PI / 2);
    const ringMaterials = [0.76, 0.16].map((opacity, index) => new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity, depthTest: true,
      depthFunc: index ? THREE.GreaterDepth : THREE.LessEqualDepth, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
    }));
    const ring = new THREE.InstancedMesh(ringGeometry, ringMaterials[0], capacity);
    const ringXray = new THREE.InstancedMesh(ringGeometry, ringMaterials[1], capacity);
    ringXray.instanceMatrix = ring.instanceMatrix;
    ring.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const capGeometry = new THREE.BufferGeometry();
    const capPositions = new THREE.Float32BufferAttribute(new Float32Array(capacity * 3), 3);
    const capColors = new THREE.Float32BufferAttribute(new Float32Array(capacity * 3), 3);
    const capKinds = new THREE.Float32BufferAttribute(new Float32Array(capacity), 1);
    for (const attribute of [capPositions, capColors, capKinds]) attribute.setUsage(THREE.DynamicDrawUsage);
    capGeometry.setAttribute("position", capPositions);
    capGeometry.setAttribute("markerColor", capColors);
    capGeometry.setAttribute("markerKind", capKinds);
    const capMaterials = [0.98, 0.48].map((opacity, index) => new THREE.ShaderMaterial({
      vertexShader: CAP_VERTEX, fragmentShader: CAP_FRAGMENT,
      uniforms: { opacity: { value: opacity }, pixelRatio: { value: this.pixelRatio } },
      transparent: true, depthTest: true, depthFunc: index ? THREE.GreaterDepth : THREE.LessEqualDepth,
      depthWrite: false, toneMapped: false,
    }));
    const cap = new THREE.Points(capGeometry, capMaterials[0]);
    const capXray = new THREE.Points(capGeometry, capMaterials[1]);
    for (const [object, name, order] of [[beamXray, "loot-beams-occluded", 30], [ringXray, "loot-rings-occluded", 31],
      [beam, "loot-beams", 32], [ring, "loot-rings", 33], [capXray, "loot-badges-occluded", 34], [cap, "loot-badges", 35]]) {
      object.name = name;
      object.renderOrder = order;
      object.frustumCulled = false;
      this.root.add(object);
    }
    this.resources = { beam, beamXray, ring, ringXray, cap, capXray, tint, capPositions, capColors, capKinds, capMaterials };
  }

  /** Returns the source marker under a Three.js raycaster, or null. */
  pick(raycaster) {
    if (!this.root.visible || !this.resources || this.disposed) return null;
    this.root.updateWorldMatrix(true, true);
    const hits = raycaster.intersectObject(this.resources.cap, false);
    return hits.length ? this.visibleMarkers[hits[0].index] ?? null : null;
  }

  clear() {
    this.markers = [];
    return this.refresh();
  }

  releaseResources() {
    const geometries = new Set(), materials = new Set();
    this.root.traverse(object => {
      if (object.geometry) geometries.add(object.geometry);
      if (object.material) materials.add(object.material);
      if (object.isInstancedMesh) object.dispose();
    });
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    this.root.clear();
    this.resources = null;
    this.capacity = 0;
  }

  dispose() {
    if (this.disposed) return;
    this.releaseResources();
    this.markers = this.visibleMarkers = [];
    this.root.visible = false;
    this.root.removeFromParent();
    this.disposed = true;
  }
}
