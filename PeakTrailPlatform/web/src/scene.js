import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { loadGameGeometry, updateRecordedMineVisibility } from "./geometry-loader.js";
import { layoutPortraitLabels } from "./portrait-layout.js";
import { ReplayCamera, REPLAY_CAMERA_HELP } from "./replay-camera.js";
import { chooseRecordedInteriorPose, isInteriorLayer } from "./camera-placement.js";
import { WorldRenderer } from "./world-renderer.js";

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
    this.playerPortraits = new Map();
    this.playerLabels = new Map();
    this.labelPosition = new THREE.Vector3();
    this.labelOverlay = document.createElement("div");
    this.labelOverlay.className = "trail-player-labels";
    this.labelOverlay.setAttribute("aria-hidden", "true");
    canvas.parentElement.append(this.labelOverlay);
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
    this.freeCamera = new ReplayCamera({ THREE, camera: this.camera, controls: this.controls, canvas,
      onModeChange: (mode) => this.canvas.dispatchEvent(new CustomEvent("cameramodechange", { detail: { mode, help: REPLAY_CAMERA_HELP } })) });
    this.worldRenderer = new WorldRenderer(canvas);
    this.gameAssetPack = null;
    this.lastFrameTime = null;
    this.cameraSelectionRevision = 0;
    this.controls.addEventListener("start", () => { ++this.cameraSelectionRevision; });

    this.worldRoot = new THREE.Group();
    this.terrainRoot = new THREE.Group();
    this.trailRoot = new THREE.Group();
    this.gridRoot = new THREE.Group();
    this.worldRoot.add(this.gridRoot, this.terrainRoot, this.trailRoot, this.worldRenderer.root);
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

  animate(timestamp) {
    const delta = this.lastFrameTime === null ? 0 : (timestamp - this.lastFrameTime) / 1000;
    this.lastFrameTime = timestamp;
    if (this.freeCamera.mode === "free") this.freeCamera.update(delta);
    else this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.updatePlayerLabelPositions();
    this.worldRenderer.projectLabels(this.camera);
    this.animationFrame = requestAnimationFrame(this.animate);
  }

  async setData({ mapPack, trace, useMap, activeSegment }) {
    const cameraRevision = this.cameraSelectionRevision;
    if (this.trace !== trace) this.playerPortraits.clear();
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
    this.labelOverlay.replaceChildren();
    this.playerLabels.clear();
    this.buildGrid(this.currentBounds);
    this.worldRenderer.setData(this.trace, this.gameAssetPack, this.origin);

    if (this.useMap) await this.buildTerrain(token);
    if (token !== this.buildToken) return;
    if (this.trace) this.buildTracks();
    this.applyHeightScale();
    this.applyLayerVisibility();
    this.setTime(this.currentTime);
    if (cameraRevision === this.cameraSelectionRevision) {
      this.fitView();
      if (isInteriorLayer(this.selectedLayer(), this.mapPack?.route)) this.enterInteriorView(false);
    }
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
      this.setTime(this.currentTime);
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
    this.rebuildPlayerLabels();
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

  setPlayerPortrait(playerId, url) {
    if (url) this.playerPortraits.set(playerId, url);
    else this.playerPortraits.delete(playerId);
    const label = this.playerLabels.get(playerId);
    if (!label || label.url === (url || null)) return;
    label.url = url || null;
    label.image.hidden = !url;
    label.fallback.hidden = Boolean(url);
    if (url) label.image.src = url;
    else label.image.removeAttribute("src");
  }

  rebuildPlayerLabels() {
    this.labelOverlay.replaceChildren();
    this.playerLabels.clear();
    for (const participant of this.trace?.participants || []) {
      if (!this.playerObjects.has(participant.id)) continue;
      const label = document.createElement("div");
      const leader = document.createElement("div");
      leader.className = "trail-player-leader";
      leader.style.setProperty("--player-color", this.getPlayerColor(participant.id));
      leader.hidden = true;
      label.className = "trail-player-label";
      label.style.setProperty("--player-color", this.getPlayerColor(participant.id));
      label.hidden = true;
      const portrait = document.createElement("span");
      portrait.className = "trail-player-portrait";
      const image = document.createElement("img");
      image.alt = "";
      image.hidden = true;
      const fallback = document.createElement("span");
      fallback.textContent = Array.from(participant.nickname || participant.id)[0] || "?";
      portrait.append(image, fallback);
      const name = document.createElement("span");
      name.className = "trail-player-name";
      name.textContent = participant.nickname || participant.id;
      label.append(portrait, name);
      this.labelOverlay.append(leader, label);
      this.playerLabels.set(participant.id, { element: label, leader, image, fallback, url: null });
      this.setPlayerPortrait(participant.id, this.playerPortraits.get(participant.id));
    }
  }

  updatePlayerLabelPositions() {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    const anchors = [];
    for (const [id, label] of this.playerLabels) {
      const object = this.playerObjects.get(id);
      let visible = Boolean(object?.group.visible && object?.marker.visible);
      if (visible) {
        object.marker.getWorldPosition(this.labelPosition);
        this.labelPosition.project(this.camera);
        const { x, y, z } = this.labelPosition;
        visible = Number.isFinite(x + y + z) && z >= -1 && z <= 1 && Math.abs(x) < 1 && Math.abs(y) < 1;
        if (visible) {
          label.element.hidden = false;
          anchors.push({ id, x: (x + 1) * width / 2, y: (1 - y) * height / 2,
            width: label.element.offsetWidth || 80, height: label.element.offsetHeight || 62 });
        }
      }
      label.element.hidden = !visible;
      if (label.leader) label.leader.hidden = true;
    }
    for (const position of layoutPortraitLabels(anchors, { width, height })) {
      const label = this.playerLabels.get(position.id);
      label.element.style.transform = `translate(${position.left}px, ${position.top}px)`;
      if (label.leader) {
        const endX = Math.max(position.left, Math.min(position.left + position.width, position.anchorX));
        const endY = position.top + position.height;
        const dx = endX - position.anchorX, dy = endY - position.anchorY;
        const length = Math.hypot(dx, dy);
        label.leader.hidden = length < 12;
        label.leader.style.width = `${length}px`;
        label.leader.style.transform = `translate(${position.anchorX}px, ${position.anchorY}px) rotate(${Math.atan2(dy, dx)}rad)`;
      }
    }
  }

  setTime(seconds) {
    this.currentTime = Math.max(0, Number(seconds) || 0);
    const worldPlayers = [];
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
      const life = this.trace.events.findLast((event) => event.playerId === group.userData.playerId && event.t <= this.currentTime && ["death", "revive", "join"].includes(event.type));
      if (sample && this.currentTime - sample.t <= maxGap && isPresent && life?.type !== "death" && (this.playerVisibility.get(group.userData.playerId) ?? true)) worldPlayers.push(sample);
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
    this.worldRenderer.update(this.currentTime, { players: worldPlayers, heightScale: this.heightScale,
      bounds: this.useMap && this.activeSegment !== null ? this.viewBounds() : null });
    updateRecordedMineVisibility(this.terrainRoot, this.worldRenderer.objects, this.trace?.events, this.currentTime);
  }

  setGameAssetPack(pack) {
    this.gameAssetPack = pack;
    this.worldRenderer.setData(this.trace, pack, this.origin);
    this.setTime(this.currentTime);
  }

  setWorldVisibility(visible) {
    this.worldRenderer.enabled = Boolean(visible);
    this.setTime(this.currentTime);
  }

  setHeightScale(value) {
    this.heightScale = THREE.MathUtils.clamp(Number(value) || 1, 0.2, 5);
    this.applyHeightScale();
    this.setTime(this.currentTime);
  }

  applyHeightScale() {
    this.terrainRoot.scale.y = this.heightScale;
    this.trailRoot.scale.y = this.heightScale;
    this.worldRenderer.root.scale.y = this.heightScale;
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
    this.setTime(this.currentTime);
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
    const selected = this.activeSegment;
    const cameraRevision = this.cameraSelectionRevision;
    const buildRevision = this.buildToken;
    void this.ensureGeometryLayers().then(() => {
      if (selected === this.activeSegment && buildRevision === this.buildToken && cameraRevision === this.cameraSelectionRevision && isInteriorLayer(this.selectedLayer(), this.mapPack?.route)) this.enterInteriorView(false);
    });
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

  selectedLayer() { return this.mapPack?.layers.find((entry) => entry.segment === this.activeSegment) || null; }

  enterInteriorView(focus = true) {
    ++this.cameraSelectionRevision;
    const pose = chooseRecordedInteriorPose(this.trace, this.currentTime, this.viewBounds(), { playerVisibility: this.playerVisibility });
    if (pose) {
      const yaw = THREE.MathUtils.degToRad(pose.yaw || 0);
      this.freeCamera.enterAt([pose.pos[0] - this.origin.x, (pose.pos[1] - this.origin.y + 1.6) * this.heightScale, pose.pos[2] - this.origin.z], [Math.sin(yaw), 0, Math.cos(yaw)], { focus });
      this.cameraPlacementNote = pose.t === this.currentTime ? "当前玩家位置" : "已记录的关内玩家位置";
    } else {
      // A bounding box centre can be air or solid rock. Require a floor AND a
      // ceiling from real loaded geometry, not a fabricated 'interior' point.
      const bounds = this.viewBounds();
      let point = null;
      this.terrainRoot.updateMatrixWorld(true);
      const meshes = this.terrainRoot.children.filter((group) => group.visible);
      const ray = new THREE.Raycaster(), probe = new THREE.Vector3();
      for (const h of [0.25, 0.4, 0.55, 0.7]) {
        for (const [x, z] of [[0.5, 0.5], [0.35, 0.5], [0.65, 0.5], [0.5, 0.3], [0.5, 0.7]]) {
          probe.set(THREE.MathUtils.lerp(bounds.min[0], bounds.max[0], x) - this.origin.x,
            (THREE.MathUtils.lerp(bounds.min[1], bounds.max[1], h) - this.origin.y) * this.heightScale,
            THREE.MathUtils.lerp(bounds.min[2], bounds.max[2], z) - this.origin.z);
          ray.set(probe, new THREE.Vector3(0, -1, 0));
          const floor = ray.intersectObjects(meshes, true)[0];
          ray.set(probe, new THREE.Vector3(0, 1, 0));
          const ceiling = ray.intersectObjects(meshes, true)[0];
          if (floor && ceiling && ceiling.point.y - floor.point.y > 2.4 * this.heightScale) {
            point = floor.point.clone(); point.y += 1.6 * this.heightScale; break;
          }
        }
        if (point) break;
      }
      if (point) { this.freeCamera.enterAt(point, [0, 0, 1], { focus }); this.cameraPlacementNote = "内部几何参考点（非玩家位置）"; }
      else { this.freeCamera.setMode("free", { focus }); this.cameraPlacementNote = "未找到可靠内部落点，可用 WASD 自行移入"; }
    }
    this.canvas.dispatchEvent(new CustomEvent("cameraplacement", { detail: { note: this.cameraPlacementNote } }));
    if (focus) this.freeCamera.focus();
  }

  toggleFreeCamera() { ++this.cameraSelectionRevision; this.freeCamera.setMode(this.freeCamera.mode === "free" ? "orbit" : "free"); this.freeCamera.focus(); }

  focusWorldEvent(event) {
    if (!event.objectId || !event.pos) return;
    ++this.cameraSelectionRevision;
    const target = new THREE.Vector3(event.pos[0] - this.origin.x, (event.pos[1] - this.origin.y) * this.heightScale, event.pos[2] - this.origin.z);
    const position = target.clone().add(new THREE.Vector3(9, 10, -12));
    this.freeCamera.enterAt(position, target.clone().sub(position), { focus: false });
    this.canvas.dispatchEvent(new CustomEvent("cameraplacement", { detail: { note: "事件近景 · 特效为回放示意" } }));
  }

  fitView() {
    ++this.cameraSelectionRevision;
    this.freeCamera.setMode("orbit");
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
    ++this.cameraSelectionRevision;
    this.freeCamera.setMode("orbit");
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
    ++this.cameraSelectionRevision;
    ++this.buildToken;
    ++this.geometrySelectionToken;
    cancelAnimationFrame(this.animationFrame);
    this.resizeObserver.disconnect();
    this.freeCamera.dispose();
    this.worldRenderer.dispose();
    this.controls.dispose();
    this.geometryAbort?.abort();
    this.geometryLoads.clear();
    disposeObject(this.terrainRoot);
    disposeObject(this.trailRoot);
    disposeObject(this.gridRoot);
    this.labelOverlay?.remove();
    this.playerLabels?.clear();
    this.playerPortraits?.clear();
    this.renderer.dispose();
  }
}
