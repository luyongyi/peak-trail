import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { loadGameGeometry } from "./geometry-loader.js";

const PLAYER_COLORS = [
  "#efb74e",
  "#70d4c4",
  "#ee7f74",
  "#9e8bf0",
  "#77aef2",
  "#b5d86b",
  "#f08ac1",
  "#e69b62",
];

const DISCONTINUITY_EVENTS = new Set([
  "warp",
  "death",
  "revive",
  "join",
  "leave",
  "segment_change",
]);

function binaryUpperBound(values, target) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle] <= target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function crossesDiscontinuity(events, startTime, endTime) {
  return events.some((event) => event.t > startTime && event.t <= endTime);
}

function isImplausibleJump(before, after, gap) {
  const distance = Math.hypot(
    after.pos[0] - before.pos[0],
    after.pos[1] - before.pos[1],
    after.pos[2] - before.pos[2],
  );
  return distance > Math.max(20, gap * 30);
}

function sampleAtTime(samples, target, maxGap, blockingEvents = []) {
  if (!samples.length || target < samples[0].t) return null;
  let low = 0;
  let high = samples.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (samples[middle].t <= target) low = middle + 1;
    else high = middle;
  }
  const beforeIndex = Math.max(0, low - 1);
  const before = samples[beforeIndex] || null;
  const after = samples[beforeIndex + 1] || null;
  if (!before || !after || target >= after.t) return before;
  const gap = after.t - before.t;
  if (gap <= 0
      || gap > maxGap
      || before.segment !== after.segment
      || before.activeSegment !== after.activeSegment
      || crossesDiscontinuity(blockingEvents, before.t, after.t)
      || isImplausibleJump(before, after, gap)) return before;

  const alpha = THREE.MathUtils.clamp((target - before.t) / gap, 0, 1);
  const yawDelta = ((((after.yaw || 0) - (before.yaw || 0)) % 360) + 540) % 360 - 180;
  return {
    ...before,
    t: target,
    pos: [
      THREE.MathUtils.lerp(before.pos[0], after.pos[0], alpha),
      THREE.MathUtils.lerp(before.pos[1], after.pos[1], alpha),
      THREE.MathUtils.lerp(before.pos[2], after.pos[2], alpha),
    ],
    yaw: (before.yaw || 0) + yawDelta * alpha,
  };
}

function hashString(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function heightColor(value, min, max) {
  const range = Math.max(0.001, max - min);
  const t = THREE.MathUtils.clamp((value - min) / range, 0, 1);
  const low = new THREE.Color("#172c2c");
  const middle = new THREE.Color("#466c5c");
  const high = new THREE.Color("#c7b56c");
  return t < 0.58 ? low.lerp(middle, t / 0.58) : middle.lerp(high, (t - 0.58) / 0.42);
}

function disposeObject(root) {
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();
  root.traverse((object) => {
    if (object.geometry) geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : object.material ? [object.material] : []) materials.add(material);
    if (object.isInstancedMesh) object.dispose();
  });
  for (const material of materials) {
    for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    material.dispose();
  }
  for (const texture of textures) texture.dispose();
  for (const geometry of geometries) geometry.dispose();
  root.clear();
}

export class TrailScene {
  constructor(canvas) {
    this.canvas = canvas;
    this.mapPack = null;
    this.trace = null;
    this.useMap = false;
    this.activeSegment = null;
    this.currentTime = 0;
    this.heightScale = 1;
    this.showTracks = true;
    this.showMarkers = true;
    this.playerVisibility = new Map();
    this.playerColors = new Map();
    this.playerObjects = new Map();
    this.origin = new THREE.Vector3();
    this.currentBounds = null;
    this.buildToken = 0;
    this.geometrySelectionToken = 0;
    this.geometryLoads = new Map();
    this.geometryAbort = null;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.93;
    this.renderer.localClippingEnabled = true;

    this.scene = new THREE.Scene();
    // Survey cameras are hundreds of metres away; decorative exponential fog
    // was darkening real surfaces according to camera distance, not geometry.
    this.scene.fog = null;
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 20000);
    this.camera.position.set(65, 85, 75);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.screenSpacePanning = false;
    this.controls.minDistance = 2;
    this.controls.maxDistance = 12000;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.target.set(0, 0, 0);

    this.worldRoot = new THREE.Group();
    this.terrainRoot = new THREE.Group();
    this.trailRoot = new THREE.Group();
    this.gridRoot = new THREE.Group();
    this.worldRoot.add(this.gridRoot, this.terrainRoot, this.trailRoot);
    this.scene.add(this.worldRoot);

    const hemisphere = new THREE.HemisphereLight(0xbad9d2, 0x17201e, 1.7);
    const key = new THREE.DirectionalLight(0xffe3ad, 2.4);
    key.position.set(-120, 190, 80);
    const rim = new THREE.DirectionalLight(0x6fd4c5, 1.1);
    rim.position.set(140, 80, -130);
    this.scene.add(hemisphere, key, rim);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement);
    this.resize();
    this.buildGrid({ min: [-50, -2, -50], max: [50, 15, 50] });

    this.animate = this.animate.bind(this);
    this.animationFrame = requestAnimationFrame(this.animate);
  }

  resize() {
    const container = this.canvas.parentElement;
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  animate() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.animationFrame = requestAnimationFrame(this.animate);
  }

  async setData({ mapPack, trace, useMap, activeSegment }) {
    this.mapPack = mapPack || null;
    this.trace = trace || null;
    this.useMap = Boolean(useMap && mapPack);
    const firstMountain = mapPack?.layers?.find((layer) => String(layer.biome).toLowerCase() !== "void");
    this.activeSegment = activeSegment === null ? null
      : Number.isInteger(activeSegment) ? activeSegment : firstMountain?.segment ?? null;
    // The Void's 5 km collision floor is real, but is not the daily mountain's
    // overview extent. It is available only through explicit layer selection.
    const mountainLayers = mapPack?.layers?.filter((layer) => String(layer.biome).toLowerCase() !== "void") || [];
    const mountainBounds = mountainLayers.length ? {
      min: [Math.min(...mountainLayers.map((l) => l.minX)), Math.min(...mountainLayers.map((l) => l.minY)), Math.min(...mountainLayers.map((l) => l.minZ))],
      max: [Math.max(...mountainLayers.map((l) => l.maxX)), Math.max(...mountainLayers.map((l) => l.maxY)), Math.max(...mountainLayers.map((l) => l.maxZ))],
    } : mapPack?.bounds;
    const bounds = this.useMap ? mountainBounds : trace?.bounds || mapPack?.bounds || null;
    if (bounds) {
      this.currentBounds = bounds;
      this.origin.fromArray([
        (bounds.min[0] + bounds.max[0]) / 2,
        (bounds.min[1] + bounds.max[1]) / 2,
        (bounds.min[2] + bounds.max[2]) / 2,
      ]);
    } else {
      this.currentBounds = { min: [-50, -2, -50], max: [50, 15, 50] };
      this.origin.set(0, 0, 0);
    }

    const token = ++this.buildToken;
    ++this.geometrySelectionToken;
    this.geometryAbort?.abort();
    this.geometryAbort = new AbortController();
    this.geometryLoads.clear();
    disposeObject(this.terrainRoot);
    disposeObject(this.trailRoot);
    this.playerObjects.clear();
    this.buildGrid(this.currentBounds);

    if (this.useMap) await this.buildTerrain(token);
    if (token !== this.buildToken) return;
    if (this.trace) this.buildTracks();
    this.applyHeightScale();
    this.applyLayerVisibility();
    this.setTime(this.currentTime);
    this.fitView();
  }

  buildGrid(bounds) {
    disposeObject(this.gridRoot);
    const spanX = bounds.max[0] - bounds.min[0];
    const spanZ = bounds.max[2] - bounds.min[2];
    const size = Math.max(20, spanX, spanZ) * 1.35;
    const divisions = THREE.MathUtils.clamp(Math.round(size / 12), 12, 64);
    const grid = new THREE.GridHelper(size, divisions, 0x39534f, 0x20302f);
    grid.material.transparent = true;
    grid.material.opacity = 0.38;
    grid.position.y = bounds.min[1] - this.origin.y - 0.7;
    grid.renderOrder = -2;
    this.gridRoot.add(grid);

    const ringGeometry = new THREE.RingGeometry(size * 0.44, size * 0.4415, 128);
    const ringMaterial = new THREE.MeshBasicMaterial({
      color: 0x385b55,
      transparent: true,
      opacity: 0.28,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const ring = new THREE.Mesh(ringGeometry, ringMaterial);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = grid.position.y + 0.02;
    this.gridRoot.add(ring);
  }

  async buildTerrain(token) {
    if (this.mapPack.identityVersion === 3) {
      for (const layer of this.mapPack.layers) {
        const group = new THREE.Group();
        group.userData = { layerId: layer.id, segment: layer.segment, mapLayer: layer, loaded: false };
        this.terrainRoot.add(group);
      }
      await this.ensureGeometryLayers(token);
      return;
    }
    const textureLoader = new THREE.TextureLoader();
    const layerTasks = this.mapPack.layers.map(async (layer) => {
      const maxRenderedSide = 420;
      const columnStep = Math.max(1, Math.ceil(layer.columns / maxRenderedSide));
      const rowStep = Math.max(1, Math.ceil(layer.rows / maxRenderedSide));
      const columns = [];
      const rows = [];
      for (let column = 0; column < layer.columns; column += columnStep) columns.push(column);
      for (let row = 0; row < layer.rows; row += rowStep) rows.push(row);
      if (columns.at(-1) !== layer.columns - 1) columns.push(layer.columns - 1);
      if (rows.at(-1) !== layer.rows - 1) rows.push(layer.rows - 1);

      const positions = [];
      const colors = [];
      const uvs = [];
      const validity = [];
      const spanX = layer.maxX - layer.minX;
      const spanZ = layer.maxZ - layer.minZ;

      for (const row of rows) {
        for (const column of columns) {
          const sourceIndex = row * layer.columns + column;
          const rawHeight = layer.heightData[sourceIndex];
          const valid = Number.isFinite(rawHeight);
          const x = layer.minX + ((column + 0.5) / layer.columns) * spanX;
          const z = layer.minZ + ((row + 0.5) / layer.rows) * spanZ;
          const y = valid ? rawHeight : layer.minY;
          positions.push(x - this.origin.x, y - this.origin.y, z - this.origin.z);
          const color = heightColor(y, layer.minY, layer.maxY);
          colors.push(color.r, color.g, color.b);
          uvs.push((column + 0.5) / layer.columns, (row + 0.5) / layer.rows);
          validity.push(valid);
        }
      }

      const indices = [];
      const renderedColumns = columns.length;
      const renderedRows = rows.length;
      for (let row = 0; row < renderedRows - 1; row += 1) {
        for (let column = 0; column < renderedColumns - 1; column += 1) {
          const a = row * renderedColumns + column;
          const b = a + 1;
          const c = a + renderedColumns;
          const d = c + 1;
          if (validity[a] && validity[c] && validity[b]) indices.push(a, c, b);
          if (validity[b] && validity[c] && validity[d]) indices.push(b, c, d);
        }
      }

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
      geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
      geometry.setIndex(indices);
      geometry.computeVertexNormals();
      geometry.computeBoundingSphere();

      let texture = null;
      if (layer.textureUrl) {
        try {
          texture = await textureLoader.loadAsync(layer.textureUrl);
          texture.colorSpace = THREE.SRGBColorSpace;
          // Exported PNGs are top-left image data while map UVs use bottom-left semantics.
          // Three's default upload flip keeps row 0 aligned with the declared imageOrigin.
          // identity v2 binds imageOrigin, not an optional textureFlipY field.
          // Never let unsigned metadata override the canonical orientation.
          texture.flipY = true;
          texture.minFilter = THREE.LinearMipmapLinearFilter;
          texture.magFilter = THREE.LinearFilter;
          texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
          texture.needsUpdate = true;
        } catch {
          texture = null;
        }
      }

      const material = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map: texture,
        vertexColors: !texture,
        roughness: 0.91,
        metalness: 0.015,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.userData.layerId = layer.id;
      mesh.userData.segment = layer.segment;
      mesh.userData.mapLayer = layer;
      mesh.receiveShadow = false;
      return mesh;
    });

    const meshes = await Promise.all(layerTasks);
    if (token !== this.buildToken) {
      meshes.forEach((mesh) => disposeObject(mesh));
      return;
    }
    for (const mesh of meshes) this.terrainRoot.add(mesh);
  }

  emitMapStatus(status, message, segment = this.activeSegment) {
    this.canvas.dispatchEvent(new CustomEvent("peaktrail-map-status", { detail: { status, message, segment } }));
  }

  isGeometryLayerRequested(layer) {
    return this.useMap && this.mapPack?.identityVersion === 3 && (this.activeSegment === null
      ? String(layer.biome).toLowerCase() !== "void"
      : layer.segment === this.activeSegment);
  }

  async ensureGeometryLayers(token = this.buildToken, selectionToken = this.geometrySelectionToken) {
    if (!this.useMap || this.mapPack?.identityVersion !== 3) return;
    const selected = this.activeSegment;
    const isCurrent = () => token === this.buildToken && selectionToken === this.geometrySelectionToken;
    const groups = this.terrainRoot.children.filter((group) => this.isGeometryLayerRequested(group.userData.mapLayer));
    this.emitMapStatus("loading", "正在加载本关真实网格…", selected);
    try {
      // Sequential parsing limits memory spikes in the explicitly requested overview.
      for (const group of groups) {
        if (!isCurrent()) return;
        const layer = group.userData.mapLayer;
        if (!group.userData.loaded) {
          if (!this.geometryLoads.has(layer.id)) {
            const origin = this.origin.clone();
            const task = loadGameGeometry(layer, this.geometryAbort.signal, this.mapPack.gameBuildId).then((model) => {
              // A shared request can still serve A -> B -> A. Its ownership is
              // the current build/layer, not the selection that first started it.
              if (token !== this.buildToken || !this.isGeometryLayerRequested(layer)) {
                disposeObject(model);
                if (this.geometryLoads.get(layer.id) === task) this.geometryLoads.delete(layer.id);
                return;
              }
              model.position.copy(origin).multiplyScalar(-1);
              group.add(model);
              group.userData.loaded = true;
            }).catch((error) => {
              if (this.geometryLoads.get(layer.id) === task) this.geometryLoads.delete(layer.id);
              throw error;
            });
            this.geometryLoads.set(layer.id, task);
          }
          await this.geometryLoads.get(layer.id);
          if (!isCurrent()) return;
        }
      }
      if (!isCurrent()) return;
      // A single-chapter view keeps only that chapter's GPU resources resident.
      if (selected !== null) {
        for (const group of this.terrainRoot.children) {
          if (group.userData.segment === selected || !group.userData.loaded) continue;
          disposeObject(group);
          group.userData.loaded = false;
          this.geometryLoads.delete(group.userData.mapLayer.id);
        }
      }
      this.applyLayerVisibility();
      this.emitMapStatus("ready", selected === null ? "真实网格概览" : "本关真实网格已就绪", selected);
    } catch (error) {
      if (!isCurrent() || error.name === "AbortError") return;
      this.emitMapStatus("error", error.message, selected);
    }
  }

  buildTracks() {
    disposeObject(this.trailRoot);
    this.playerObjects.clear();
    const sampleHz = Number(this.trace.manifest.sampleHz) || 5;
    // At 5 Hz this allows the recorder's 1 s stationary heartbeat plus jitter,
    // without drawing through multi-second dropouts. Lower configured rates get
    // a proportional allowance, shared by both trails and marker interpolation.
    const maxGap = Math.max(1.5, 2.5 / sampleHz);

    for (const participant of this.trace.participants) {
      const samples = this.trace.tracks.get(participant.id) || [];
      if (!samples.length) continue;
      const blockingEvents = this.trace.events.filter(
        (event) =>
          DISCONTINUITY_EVENTS.has(event.type) && (!event.playerId || event.playerId === participant.id),
      );
      const lifecycleEvents = this.trace.events.filter(
        (event) => ["join", "leave"].includes(event.type) && event.playerId === participant.id,
      );
      const color = this.getPlayerColor(participant.id);
      const material = new LineMaterial({
        color,
        linewidth: 3,
        worldUnits: false,
        transparent: true,
        opacity: 0.92,
        // A 2.5D top surface omits caves and overhangs. Keep original XYZ but
        // draw the analytical trail through terrain so it is never lost in it.
        depthTest: false,
        depthWrite: false,
      });
      const segmentPositions = [];
      const segmentEndTimes = [];
      for (let index = 1; index < samples.length; index += 1) {
        const start = samples[index - 1];
        const end = samples[index];
        if (end.t - start.t > maxGap) continue;
        if (end.segment !== start.segment) continue;
        if (end.activeSegment !== start.activeSegment) continue;
        if (crossesDiscontinuity(blockingEvents, start.t, end.t)) continue;
        if (isImplausibleJump(start, end, end.t - start.t)) continue;
        // A global progression index is not a per-player segment. Keep an
        // unassigned XYZ route visible when only the base-map layer changes.
        if (this.activeSegment !== null && Number.isInteger(end.segment) && end.segment !== this.activeSegment) continue;
        segmentPositions.push(
          start.pos[0] - this.origin.x,
          start.pos[1] - this.origin.y + 0.28,
          start.pos[2] - this.origin.z,
          end.pos[0] - this.origin.x,
          end.pos[1] - this.origin.y + 0.28,
          end.pos[2] - this.origin.z,
        );
        segmentEndTimes.push(end.t);
      }
      const lineGeometry = new LineSegmentsGeometry();
      lineGeometry.setPositions(segmentPositions.length ? segmentPositions : [0, 0, 0, 0, 0, 0]);
      lineGeometry.instanceCount = 0;
      const line = new LineSegments2(lineGeometry, material);
      line.userData.endTimes = segmentEndTimes;
      line.renderOrder = 10;
      const outline = new LineSegments2(lineGeometry, new LineMaterial({
        color: 0x081011, linewidth: 5, worldUnits: false,
        transparent: true, opacity: 0.8, depthTest: false, depthWrite: false,
      }));
      outline.renderOrder = 9;

      const marker = this.createPlayerMarker(color);
      const group = new THREE.Group();
      group.add(outline, line, marker);
      group.userData.playerId = participant.id;
      group.visible = this.playerVisibility.get(participant.id) ?? true;
      this.trailRoot.add(group);
      this.playerObjects.set(participant.id, {
        group,
        line,
        outline,
        marker,
        samples,
        blockingEvents,
        lifecycleEvents,
        maxGap,
      });
    }
  }

  createPlayerMarker(color) {
    const root = new THREE.Group();
    const halo = new THREE.Mesh(
      new THREE.RingGeometry(0.78, 1.02, 30),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }),
    );
    halo.rotation.x = -Math.PI / 2;
    halo.position.y = 0.07;
    const body = new THREE.Mesh(
      new THREE.SphereGeometry(0.52, 18, 12),
      new THREE.MeshBasicMaterial({ color }),
    );
    body.position.y = 0.52;
    const direction = new THREE.Mesh(
      new THREE.ConeGeometry(0.36, 1.25, 3),
      new THREE.MeshBasicMaterial({ color }),
    );
    direction.rotation.x = Math.PI / 2;
    direction.position.set(0, 0.35, 0.9);
    root.add(halo, body, direction);
    root.traverse((object) => {
      if (!object.material) return;
      object.material.depthTest = false;
      object.material.depthWrite = false;
      object.renderOrder = 11;
    });
    return root;
  }

  setTime(seconds) {
    this.currentTime = Math.max(0, Number(seconds) || 0);
    for (const {
      group,
      line,
      outline,
      marker,
      samples,
      blockingEvents,
      lifecycleEvents,
      maxGap,
    } of this.playerObjects.values()) {
      line.geometry.instanceCount = binaryUpperBound(line.userData.endTimes, this.currentTime);
      line.visible = this.showTracks;
      outline.visible = this.showTracks;
      const sample = sampleAtTime(samples, this.currentTime, maxGap, blockingEvents);
      const latestLifecycle = lifecycleEvents.findLast((event) => event.t <= this.currentTime);
      const isPresent = latestLifecycle?.type !== "leave";
      const segmentMatches =
        sample && (this.activeSegment === null || !Number.isInteger(sample.segment) || sample.segment === this.activeSegment);
      marker.visible = Boolean(this.showMarkers && sample && segmentMatches && isPresent);
      if (sample) {
        marker.position.set(
          sample.pos[0] - this.origin.x,
          sample.pos[1] - this.origin.y + 0.36,
          sample.pos[2] - this.origin.z,
        );
        marker.rotation.y = THREE.MathUtils.degToRad(sample.yaw || 0);
      }
      group.visible = this.playerVisibility.get(group.userData.playerId) ?? true;
    }
  }

  setHeightScale(value) {
    this.heightScale = THREE.MathUtils.clamp(Number(value) || 1, 0.2, 5);
    this.applyHeightScale();
  }

  applyHeightScale() {
    this.terrainRoot.scale.y = this.heightScale;
    this.trailRoot.scale.y = this.heightScale;
  }

  setTrackVisibility(visible) {
    this.showTracks = Boolean(visible);
    this.setTime(this.currentTime);
  }

  setMarkerVisibility(visible) {
    this.showMarkers = Boolean(visible);
    this.setTime(this.currentTime);
  }

  setPlayerVisibility(playerId, visible) {
    this.playerVisibility.set(playerId, Boolean(visible));
    const object = this.playerObjects.get(playerId);
    if (object) object.group.visible = Boolean(visible);
  }

  setActiveSegment(segment) {
    const next = segment === null || segment === "all" ? null : Number(segment);
    if (next === this.activeSegment) return;
    this.activeSegment = next;
    ++this.geometrySelectionToken;
    this.applyLayerVisibility();
    if (this.trace) this.buildTracks();
    this.setTime(this.currentTime);
    this.fitView();
    void this.ensureGeometryLayers();
  }

  applyLayerVisibility() {
    for (const mesh of this.terrainRoot.children) {
      const isVoid = String(mesh.userData.mapLayer?.biome).toLowerCase() === "void";
      mesh.visible = this.activeSegment === null
        ? !isVoid
        : mesh.userData.segment === this.activeSegment;
    }
  }

  getPlayerColor(playerId) {
    if (!this.playerColors.has(playerId)) {
      const index = hashString(playerId) % PLAYER_COLORS.length;
      this.playerColors.set(playerId, PLAYER_COLORS[index]);
    }
    return this.playerColors.get(playerId);
  }

  viewBounds() {
    const layer = this.activeSegment === null ? null : this.mapPack?.layers.find((entry) => entry.segment === this.activeSegment);
    if (layer) return { min: [layer.minX, layer.minY, layer.minZ], max: [layer.maxX, layer.maxY, layer.maxZ] };
    return this.useMap ? this.currentBounds : this.trace?.bounds || this.currentBounds;
  }

  fitView() {
    const bounds = this.viewBounds();
    if (!bounds) return;
    const width = Math.max(5, bounds.max[0] - bounds.min[0]);
    const height = Math.max(5, (bounds.max[1] - bounds.min[1]) * this.heightScale);
    const depth = Math.max(5, bounds.max[2] - bounds.min[2]);
    const largest = Math.max(width / Math.min(1, this.camera.aspect), depth, height * 1.35);
    const distance = Math.max(25, largest / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) * 1.05);
    this.camera.up.set(0, 1, 0);
    const target = new THREE.Vector3(
      (bounds.min[0] + bounds.max[0]) / 2 - this.origin.x,
      ((bounds.min[1] + bounds.max[1]) / 2 - this.origin.y) * this.heightScale,
      (bounds.min[2] + bounds.max[2]) / 2 - this.origin.z,
    );
    // Daily scenes climb toward +Z. Looking from the sea (-Z) keeps later,
    // taller biomes behind the recorded route instead of in the foreground.
    this.camera.position.copy(target).add(new THREE.Vector3(distance * 0.52, distance * 0.7, -distance * 0.62));
    this.controls.target.copy(target);
    this.camera.near = Math.max(0.1, distance / 5000);
    this.camera.far = Math.max(2000, distance * 8);
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  topView() {
    const bounds = this.viewBounds();
    if (!bounds) return;
    const width = Math.max(5, bounds.max[0] - bounds.min[0]);
    const depth = Math.max(5, bounds.max[2] - bounds.min[2]);
    const largest = Math.max(width / Math.min(1, this.camera.aspect), depth);
    const distance = Math.max(30, largest / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) * 1.1);
    this.camera.up.set(0, 0, -1);
    const target = new THREE.Vector3(
      (bounds.min[0] + bounds.max[0]) / 2 - this.origin.x,
      ((bounds.min[1] + bounds.max[1]) / 2 - this.origin.y) * this.heightScale,
      (bounds.min[2] + bounds.max[2]) / 2 - this.origin.z,
    );
    this.camera.position.copy(target).add(new THREE.Vector3(0, distance, 0.001));
    this.controls.target.copy(target);
    this.camera.near = Math.max(0.1, distance / 5000);
    this.camera.far = Math.max(2000, distance * 8);
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  dispose() {
    ++this.buildToken;
    ++this.geometrySelectionToken;
    cancelAnimationFrame(this.animationFrame);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.geometryAbort?.abort();
    this.geometryLoads.clear();
    disposeObject(this.terrainRoot);
    disposeObject(this.trailRoot);
    disposeObject(this.gridRoot);
    this.renderer.dispose();
  }
}
