import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { loadGameGeometry, updateRecordedMineVisibility, updateMapFogSurfaceVisibility } from "./geometry-loader.js";
import { layoutPortraitLabels, clusterPlayerEntries } from "./portrait-layout.js";
import { ReplayCamera, REPLAY_CAMERA_HELP } from "./replay-camera.js";
import { chooseRecordedInteriorPose, isInteriorLayer } from "./camera-placement.js";
import { WorldRenderer } from "./world-renderer.js";
import { pointInBounds, clipTrailSegment } from "./trail-spatial.js";
import { FogDepthPass } from "./fog-depth-pass.js";
import { latestLifeEventBefore, MARKER_LIFE_EVENT_TYPES } from "./protocol.js";
import { SpectatorCamera, FOLLOW_DISTANCE, FOLLOW_MIN_DISTANCE, FOLLOW_MAX_DISTANCE, FOLLOW_INTERIOR_DISTANCE, FOLLOW_INTERIOR_MIN_DISTANCE, FOLLOW_INTERIOR_MAX_DISTANCE } from "./spectator-camera.js";
import { followLayerAtPosition } from "./map-enclosures.js";
import { FollowTerrainQuery } from "./follow-terrain.js";
import { SourceWaterRenderer } from "./source-water-renderer.js";

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
    this.playerGroups = new Map();
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

    // ===== 跟随相机 =====
    // 真实网格外侧观测 + 平滑跟随 + 手动环绕；网络播放头独立运行。
    // 锚点 = 播放头插值后的玩家标记世界坐标（setTime 每帧刷新）。
    this.followTargetId = null;
    this.followAnchor = new THREE.Vector3();
    this.followTmp = new THREE.Vector3();
    this.followAzimuth = 0.6;
    this.followPitch = 0.22;
    this.followDistance = FOLLOW_DISTANCE;
    this.followUserOrbit = false;
    this.followAutoRotate = false;
    this.followAutoSwitchAt = 0;
    this.followPointer = null;
    this.followDownAt = null;
    this.raycaster = new THREE.Raycaster();
    this.followTerrain = new FollowTerrainQuery(THREE);
    this.followRig = new SpectatorCamera({ THREE, query: this.followTerrain });
    this.followTerrainDirty = true;
    this.followListeners = [
      [canvas, "pointerdown", (event) => this.onFollowPointerDown(event)],
      [canvas, "pointermove", (event) => this.onFollowPointerMove(event)],
      [canvas.ownerDocument, "pointerup", (event) => this.onFollowPointerUp(event)],
      [canvas, "wheel", (event) => this.onFollowWheel(event)],
    ];
    for (const [target, name, handler] of this.followListeners) target.addEventListener(name, handler);

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
    this.sourceWater = new SourceWaterRenderer();
    this.fogDepthPass = new FogDepthPass(THREE);
    this.gameAssetPack = null;
    this.lastFrameTime = null;
    this.cameraSelectionRevision = 0;
    this.controls.addEventListener("start", () => { ++this.cameraSelectionRevision; });

    this.worldRoot = new THREE.Group();
    this.terrainRoot = new THREE.Group();
    this.trailRoot = new THREE.Group();
    this.gridRoot = new THREE.Group();
    this.worldRoot.add(this.gridRoot, this.sourceWater.root, this.terrainRoot, this.trailRoot, this.worldRenderer.root);
    // PEAK's world is Unity left-handed; three is right-handed. Rendering the raw
    // coordinates unchanged mirrors every horizontal view (a game-right landmark
    // appears game-left). Negating Z of the whole rendered world is the standard
    // LH→RH conversion and keeps terrain, props, trails and markers consistent.
    this.worldRoot.scale.z = -1;
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
    // Cached for the per-frame label pass: reading clientWidth there forced a
    // synchronous layout of the whole viewer DOM on every single frame.
    this.viewportWidth = width;
    this.viewportHeight = height;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  animate(timestamp) {
    const delta = this.lastFrameTime === null ? 0 : (timestamp - this.lastFrameTime) / 1000;
    this.lastFrameTime = timestamp;
    if (this.freeCamera.mode === "free") this.freeCamera.update(delta);
    else if (this.followTargetId !== null) this.updateFollowCamera(delta);
    else this.controls.update();
    this.updateCameraMarkerVisibility();
    this.fogDepthPass.render({ renderer: this.renderer, scene: this.scene, camera: this.camera,
      fogEntries: this.worldRenderer.entries.values(), hiddenRoots: [this.trailRoot, this.gridRoot] });
    this.renderer.render(this.scene, this.camera);
    this.updatePlayerLabelPositions();
    this.worldRenderer.projectLabels(this.camera, this.viewportWidth, this.viewportHeight, true);
    this.animationFrame = requestAnimationFrame(this.animate);
  }

  async setData({ mapPack, trace, useMap, activeSegment }) {
    if (this.trace !== trace) this.setFollowTarget(null);
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
    this.followTerrain?.setRoots([]);
    this.followTerrainDirty = true;
    disposeObject(this.terrainRoot);
    disposeObject(this.trailRoot);
    this.playerObjects.clear();
    this.labelOverlay.replaceChildren();
    this.playerLabels.clear();
    this.playerGroups.clear();
    this.buildGrid(this.currentBounds);
    this.worldRenderer.setData(this.trace, this.gameAssetPack, this.origin);
    this.worldRenderer.setMapFog(this.useMap ? this.mapPack : null);
    this.sourceWater?.setMap(this.useMap ? this.mapPack : null, this.origin);

    // The overview legitimately loads every chapter: without it the empty daily
    // viewer would show a bare grid forever (its "loading" status never
    // resolves). First paint stays fast because terrain streams in per chapter.
    if (this.useMap) await this.buildTerrain(token);
    if (token !== this.buildToken) return;
    if (this.trace) this.buildTracks();
    this.applyHeightScale();
    this.applyLayerVisibility();
    this.setTime(this.currentTime);
    if (cameraRevision === this.cameraSelectionRevision && this.followTargetId === null) {
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

  async loadChapterGeometry(layer, signal, gameBuildId) {
    const enclosures = (this.mapPack.mapEnclosures?.enclosures || []).filter(entry => entry.segment === layer.segment);
    const model = await loadGameGeometry(layer, signal, gameBuildId);
    try {
      // The exact-source siblings were missed by the original root traversal.
      // Load them into the same chapter, including its terrain collision query.
      for (const enclosure of enclosures) {
        signal?.throwIfAborted?.();
        const shell = await loadGameGeometry({ ...enclosure, id: enclosure.objectId }, signal, gameBuildId);
        shell.userData.sourceEnclosure = enclosure.objectId;
        model.add(shell);
      }
      return model;
    } catch (error) { disposeObject(model); throw error; }
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
        // A round can await a task that settles without mounting anything (a
        // stale task from an aborted round disposes its model and removes
        // itself). Retry with a fresh request instead of leaving the chapter
        // silently unloaded; genuine failures still surface as errors.
        let attempts = 0;
        while (!group.userData.loaded && attempts < 3) {
          attempts += 1;
          if (!isCurrent()) return;
          if (!this.geometryLoads.has(layer.id)) {
            const origin = this.origin.clone();
            const task = this.loadChapterGeometry(layer, this.geometryAbort.signal, this.mapPack.gameBuildId).then((model) => {
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
        if (!group.userData.loaded) throw new Error(`第 ${layer.segment} 关真实网格未能就绪`);
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
    const displayBounds = this.useMap && this.activeSegment !== null ? this.viewBounds() : null;

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
        // The opaque map populates depth first. Visible and occluded strokes
        // use complementary tests so a wall never looks like the route floor.
        depthTest: true,
        depthFunc: THREE.LessEqualDepth,
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
        // Keep recorded layer assignments, but do not infer one from shared
        // progression. Spatial clipping is a view filter, not a data rewrite.
        if (this.activeSegment !== null && Number.isInteger(end.segment) && end.segment !== this.activeSegment) continue;
        const clipped = clipTrailSegment(start, end, displayBounds);
        if (!clipped) continue;
        segmentPositions.push(
          clipped.startPos[0] - this.origin.x,
          clipped.startPos[1] - this.origin.y,
          clipped.startPos[2] - this.origin.z,
          clipped.endPos[0] - this.origin.x,
          clipped.endPos[1] - this.origin.y,
          clipped.endPos[2] - this.origin.z,
        );
        segmentEndTimes.push(clipped.visibleAt);
      }
      const lineGeometry = new LineSegmentsGeometry();
      lineGeometry.setPositions(segmentPositions.length ? segmentPositions : [0, 0, 0, 0, 0, 0]);
      lineGeometry.instanceCount = 0;
      const line = new LineSegments2(lineGeometry, material);
      line.userData.endTimes = segmentEndTimes;
      line.renderOrder = 10;
      const outline = new LineSegments2(lineGeometry, new LineMaterial({
        color: 0x081011, linewidth: 5, worldUnits: false,
        transparent: true, opacity: 0.8, depthTest: true, depthWrite: false,
        depthFunc: THREE.LessEqualDepth,
      }));
      outline.renderOrder = 9;
      const occludedLine = new LineSegments2(lineGeometry, new LineMaterial({
        color, linewidth: 2.5, worldUnits: false,
        transparent: true, opacity: 0.18, depthTest: true, depthWrite: false,
        depthFunc: THREE.GreaterDepth,
      }));
      occludedLine.renderOrder = 8;

      const marker = this.createPlayerMarker(color);
      const group = new THREE.Group();
      group.add(occludedLine, outline, line, marker);
      group.userData.playerId = participant.id;
      group.visible = this.playerVisibility.get(participant.id) ?? true;
      this.trailRoot.add(group);
      this.playerObjects.set(participant.id, {
        group,
        line,
        outline,
        occludedLine,
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
    const body = new THREE.Mesh(
      new THREE.SphereGeometry(0.52, 18, 12),
      new THREE.MeshBasicMaterial({ color }),
    );
    const direction = new THREE.Mesh(
      new THREE.ConeGeometry(0.36, 1.25, 3),
      new THREE.MeshBasicMaterial({ color }),
    );
    direction.rotation.x = Math.PI / 2;
    direction.position.set(0, 0, 0.9);
    root.add(halo, body, direction);
    for (const object of [...root.children]) {
      if (!object.material) return;
      object.material.transparent = true;
      object.material.depthTest = true;
      object.material.depthWrite = false;
      object.material.depthFunc = THREE.LessEqualDepth;
      object.renderOrder = 11;
      const ghost = object.clone();
      ghost.material = object.material.clone();
      ghost.material.depthFunc = THREE.GreaterDepth;
      ghost.material.opacity = 0.18;
      ghost.renderOrder = 8;
      root.add(ghost);
    }
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
    this.playerGroups.clear();
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
    const width = this.viewportWidth || this.canvas.clientWidth;
    const height = this.viewportHeight || this.canvas.clientHeight;
    const entries = [];
    for (const [id, label] of this.playerLabels) {
      const object = this.playerObjects.get(id);
      let visible = Boolean(object?.group.visible && object?.marker.visible);
      if (visible) {
        object.marker.getWorldPosition(this.labelPosition);
        const pos = [this.labelPosition.x, this.labelPosition.y, this.labelPosition.z];
        this.labelPosition.project(this.camera);
        const { x, y, z } = this.labelPosition;
        visible = Number.isFinite(x + y + z) && z >= -1 && z <= 1 && Math.abs(x) < 1 && Math.abs(y) < 1;
        if (visible) {
          entries.push({ id, x: (x + 1) * width / 2, y: (1 - y) * height / 2, pos, label });
          continue;
        }
      }
      label.element.hidden = true;
      if (label.leader) label.leader.hidden = true;
    }

    // Players within 10 recorded metres share one big circle containing every
    // member's head portrait; only genuinely separate players keep their own label.
    const anchors = [];
    const activeGroups = new Set();
    for (const cluster of clusterPlayerEntries(entries)) {
      if (cluster.length === 1) {
        const entry = cluster[0];
        entry.label.element.hidden = false;
        // Measured once per label. A forced layout read on every frame re-lays out
        // the whole viewer DOM (its event list can hold thousands of rows) and was
        // the single most expensive thing in the frame.
        anchors.push({ id: entry.id, x: entry.x, y: entry.y, ...this.labelElementSize(entry.label, 80, 62) });
        continue;
      }
      for (const entry of cluster) {
        entry.label.element.hidden = true;
        if (entry.label.leader) entry.label.leader.hidden = true;
      }
      const group = this.ensurePlayerGroup(cluster);
      activeGroups.add(group.key);
      group.element.hidden = false;
      const anchorX = cluster.reduce((sum, entry) => sum + entry.x, 0) / cluster.length;
      const anchorY = cluster.reduce((sum, entry) => sum + entry.y, 0) / cluster.length;
      anchors.push({ id: group.key, x: anchorX, y: anchorY, ...this.labelElementSize(group, 96, 96) });
    }
    for (const [key, group] of this.playerGroups) {
      if (!activeGroups.has(key)) {
        group.element.hidden = true;
        group.leader.hidden = true;
      }
    }

    for (const position of layoutPortraitLabels(anchors, { width, height })) {
      const label = this.playerLabels.get(position.id) || this.playerGroups.get(position.id);
      if (!label) continue;
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

  /** Element box cached after its first visible frame. Label content never changes
   * size after creation (fixed portrait boxes, names set once), so re-measuring
   * every frame would only force a synchronous layout of the entire viewer. */
  labelElementSize(target, fallbackWidth, fallbackHeight) {
    if (!target.size?.width) {
      target.size = {
        width: target.element.offsetWidth || fallbackWidth,
        height: target.element.offsetHeight || fallbackHeight,
      };
    }
    return target.size;
  }

  /** One badge per exact member set; the key rebuilds it whenever the party
   * walking together changes. Portrait URLs refresh per frame behind a dataset
   * fingerprint so rendered heads pop in as soon as they are available. */
  ensurePlayerGroup(cluster) {
    const key = cluster.map((entry) => entry.id).sort().join("+");
    let group = this.playerGroups.get(key);
    if (!group) {
      const element = document.createElement("div");
      element.className = "trail-player-group";
      element.hidden = true;
      const ring = document.createElement("div");
      ring.className = "trail-player-group-ring";
      const names = document.createElement("span");
      names.className = "trail-player-group-names";
      element.append(ring, names);
      const leader = document.createElement("div");
      leader.className = "trail-player-leader trail-player-group-leader";
      leader.hidden = true;
      this.labelOverlay.append(leader, element);

      const members = new Map();
      const nicknames = [];
      for (const entry of cluster) {
        const participant = this.trace?.participants?.find((item) => item.id === entry.id);
        const nickname = participant?.nickname || entry.id;
        nicknames.push(nickname);
        const portrait = document.createElement("span");
        portrait.className = "trail-player-group-portrait";
        portrait.style.setProperty("--player-color", this.getPlayerColor(entry.id));
        portrait.title = nickname;
        const image = document.createElement("img");
        image.alt = "";
        image.hidden = true;
        const fallback = document.createElement("span");
        fallback.textContent = Array.from(nickname)[0] || "?";
        portrait.append(image, fallback);
        ring.append(portrait);
        members.set(entry.id, { image, fallback });
      }
      // Pack the heads tightly — up to three per row — so the badge hugs its members
      // instead of framing a big empty circle. CSS owns the pixel sizes and derives
      // the width from the column count.
      const columns = Math.min(3, cluster.length);
      ring.style.setProperty("--group-columns", String(columns));
      names.textContent = `${cluster.length} 人 · ${nicknames.join(" · ")}`;
      element.title = nicknames.join(" · ");
      group = { key, element, ring, names, leader, members, columns };
      this.playerGroups.set(key, group);
    }
    for (const [id, member] of group.members) {
      const url = this.playerPortraits.get(id) || null;
      const token = url || "";
      if (member.image.dataset.assetUrl === token) continue;
      member.image.dataset.assetUrl = token;
      if (url) {
        member.image.src = url;
        member.image.hidden = false;
        member.fallback.hidden = true;
      } else {
        member.image.removeAttribute("src");
        member.image.hidden = true;
        member.fallback.hidden = false;
      }
    }
    return group;
  }

  /** 自动巡游跟随：沿路径跟随玩家，每 60 秒自动轮换；◎ 锁定后停止轮换。 */
  startAutoFollow() {
    const id = [...this.playerObjects.keys()].find((key) => this.canFollowPlayer(key));
    if (id == null) return false;
    this.followAutoRotate = true;
    this.followUserOrbit = false;
    this.followAutoSwitchAt = performance.now() + 60_000;
    this.setFollowTarget(id);
    this.emitFollowStatus();
    return true;
  }

  setFollowTarget(playerId) {
    if (playerId !== null && playerId !== undefined && !this.playerObjects.has(playerId)) return;
    const next = playerId ?? null;
    // `== null` covers scenes whose constructor never ran (fixtures) where the
    // field is undefined rather than null: already-not-following is a no-op.
    if (next === null ? this.followTargetId == null : next === this.followTargetId) return;
    this.followTargetId = next;
    ++this.cameraSelectionRevision;
    if (next !== null) {
      this.freeCamera.setMode("orbit", { focus: false });
      // Clear accumulated OrbitControls damping before taking ownership.
      const damping = this.controls.enableDamping;
      this.controls.enableDamping = false;
      this.controls.update();
      this.controls.enableDamping = damping;
      this.controls.enabled = false;
      this.updateFollowAnchor();
      const offset = this.followTmp.copy(this.camera.position).sub(this.followAnchor);
      const context = this.followViewContext();
      this.followViewMode = context.interior ? "interior" : "exterior";
      this.followDistance = context.interior ? FOLLOW_INTERIOR_DISTANCE : FOLLOW_DISTANCE;
      this.followAzimuth = Math.atan2(offset.x, offset.z);
      this.followPitch = 0.22;
      this.camera.up.set(0, 1, 0);
      this.camera.near = 0.08;
      this.camera.updateProjectionMatrix();
      this.followRig?.reset();
      this.followUserOrbit = false;
    } else {
      // 退出：以当前注视点为轨道中心，无缝交还用户。
      this.camera.getWorldDirection(this.followTmp);
      this.controls.target.copy(this.camera.position).addScaledVector(this.followTmp, 8);
      this.controls.enabled = true;
      this.followAutoRotate = false;
      this.followRig?.reset();
      if (this.followPointer) {
        try { this.canvas.releasePointerCapture?.(this.followPointer.id); } catch { /* optional */ }
        this.followPointer = null;
      }
    }
    this.applyFollowMarkerOverlay();
    this.emitFollowStatus();
  }

  cycleFollowTarget() {
    const ids = [...this.playerObjects.keys()]
      .filter((id) => this.canFollowPlayer(id));
    if (!ids.length) return;
    const index = ids.indexOf(this.followTargetId);
    this.setFollowTarget(ids[(index + 1) % ids.length]);
  }

  /** 用户通过 ◎ / 标记点击锁定某位玩家：关闭自动轮换。 */
  lockFollowTarget(playerId) {
    this.followAutoRotate = false;
    this.setFollowTarget(playerId);
    this.emitFollowStatus();
  }

  emitFollowStatus() {
    const playerId = this.followTargetId;
    const participant = playerId !== null ? this.trace?.participants?.find((entry) => entry.id === playerId) : null;
    this.canvas.dispatchEvent(new CustomEvent("peaktrail-follow-status", {
      detail: {
        active: playerId !== null, playerId,
        name: participant?.nickname ?? playerId ?? null,
        autoRotate: playerId !== null && this.followAutoRotate,
        viewMode: this.followViewMode || "exterior",
      },
    }));
  }

  updateFollowAnchor() {
    const marker = this.playerObjects.get(this.followTargetId)?.marker;
    if (!marker) return false;
    marker.updateWorldMatrix(true, false);
    marker.getWorldPosition(this.followAnchor);
    return true;
  }

  canFollowPlayer(id) {
    const object = this.playerObjects.get(id);
    return Boolean(object?.marker && object.group?.visible !== false
      && (this.playerVisibility.get(id) ?? true)
      && (object.marker.userData.followable ?? object.marker.userData.replayVisible));
  }

  followViewContext() {
    const point = [this.followAnchor.x + this.origin.x,
      this.followAnchor.y / this.heightScale + this.origin.y, -this.followAnchor.z + this.origin.z];
    const layer = followLayerAtPosition(this.mapPack, this.activeSegment, point);
    const interior = isInteriorLayer(layer, this.mapPack?.route);
    const enclosure = interior ? this.mapPack?.mapEnclosures?.enclosures?.find(entry => entry.segment === layer.segment) : null;
    const center = enclosure?.interiorReference;
    return { layer, interior, interiorReference: center ? { center: [center[0] - this.origin.x,
      (center[1] - this.origin.y) * this.heightScale, -(center[2] - this.origin.z)] } : null };
  }

  updateFollowCamera(deltaSeconds) {
    const object = this.playerObjects.get(this.followTargetId);
    if (!object?.marker || !this.canFollowPlayer(this.followTargetId) || !this.updateFollowAnchor()) {
      if (this.followAutoRotate) {
        const next = [...this.playerObjects.keys()].find((id) => this.canFollowPlayer(id));
        if (next) { this.setFollowTarget(next); return; }
      }
      this.setFollowTarget(null);
      return;
    }

    // 自动巡游：每 60 秒轮换到下一位玩家（◎ 锁定后关闭）。
    if (this.followAutoRotate && performance.now() >= this.followAutoSwitchAt) {
      this.followAutoSwitchAt = performance.now() + 60_000;
      this.cycleFollowTarget();
      return;
    }

    if (this.followTerrainDirty) {
      this.terrainRoot.updateWorldMatrix(true, true);
      this.followTerrain.setRoots(this.terrainRoot.children);
      this.followTerrainDirty = false;
      this.followRig.invalidate();
    }
    const context = this.followViewContext();
    const viewMode = context.interior ? "interior" : "exterior";
    if (viewMode !== this.followViewMode) {
      this.followViewMode = viewMode;
      this.followDistance = context.interior ? FOLLOW_INTERIOR_DISTANCE : FOLLOW_DISTANCE;
      this.followUserOrbit = false;
      this.followRig.reset();
      this.emitFollowStatus();
    }
    // Current chapter bounds are only a weak prior. Nearby true surface normals
    // and candidate visibility win; the whole-map centre is not a climbing face.
    const bounds = this.viewBounds();
    const preferredAzimuth = bounds ? Math.atan2(
      this.followAnchor.x - ((bounds.min[0] + bounds.max[0]) / 2 - this.origin.x),
      this.followAnchor.z + ((bounds.min[2] + bounds.max[2]) / 2 - this.origin.z)) : this.followAzimuth;
    const result = this.followRig.update(this.followAnchor, deltaSeconds, {
      cameraPosition: this.camera.position, distance: this.followDistance,
      azimuth: this.followAzimuth, pitch: this.followPitch, manual: this.followUserOrbit,
      preferredAzimuth, interior: context.interior, interiorReference: context.interiorReference,
      discontinuity: this.followDiscontinuity,
    });
    this.followDiscontinuity = false;
    if (!result) return;
    if (!this.followUserOrbit) { this.followAzimuth = result.azimuth; this.followPitch = result.pitch; }
    this.camera.position.copy(result.position);
    this.camera.lookAt(result.target);
    // OrbitControls 目标同步：退出跟随时无缝交还。
    this.controls.target.copy(result.target);
  }

  /** Respect terrain depth; camera placement, not an opaque x-ray marker,
   * establishes the relationship between the climber and the mountain. */
  applyFollowMarkerOverlay() {
    for (const entry of this.playerObjects.values()) {
      entry.marker.traverse((node) => {
        if (!node.isMesh) return;
        const materials = Array.isArray(node.material) ? node.material : [node.material];
        for (const material of materials) {
          material.depthTest = true;
        }
        node.renderOrder = 0;
      });
    }
  }

  onFollowPointerDown(event) {
    if (event.isPrimary === false || event.button !== 0) return;
    this.followDownAt = { x: event.clientX, y: event.clientY, time: performance.now() };
    if (this.followTargetId === null || this.freeCamera.mode === "free") return;
    event.preventDefault();
    this.followPointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
    try { this.canvas.setPointerCapture?.(event.pointerId); } catch { /* optional */ }
  }

  onFollowPointerMove(event) {
    if (this.followTargetId === null || this.freeCamera.mode === "free" || this.followPointer?.id !== event.pointerId) return;
    const dx = event.clientX - this.followPointer.x;
    const dy = event.clientY - this.followPointer.y;
    this.followPointer.x = event.clientX;
    this.followPointer.y = event.clientY;
    if (!Number.isFinite(dx + dy)) return;
    event.preventDefault();
    this.followUserOrbit = true;
    this.followAzimuth -= dx * 0.006;
    this.followPitch = THREE.MathUtils.clamp(this.followPitch + dy * 0.005, -0.45, 1.3);
  }

  onFollowPointerUp(event) {
    if (this.followPointer?.id === event.pointerId) {
      this.followPointer = null;
      try { this.canvas.releasePointerCapture?.(event.pointerId); } catch { /* optional */ }
      return;
    }
    // 跟随未开启时，把对玩家标记的"点击"（非拖拽）作为跟随入口。
    if (!this.followDownAt || event.button !== 0) return;
    const moved = Math.hypot(event.clientX - this.followDownAt.x, event.clientY - this.followDownAt.y);
    const elapsed = performance.now() - this.followDownAt.time;
    this.followDownAt = null;
    if (moved > 6 || elapsed > 500) return;
    const hit = this.pickPlayerMarker(event);
    if (hit) this.lockFollowTarget(hit);
  }

  pickPlayerMarker(event) {
    const rect = this.canvas.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(pointer, this.camera);
    const markers = [...this.playerObjects.values()].map((entry) => entry.marker);
    if (!markers.length) return null;
    const hits = this.raycaster.intersectObjects(markers, true);
    for (const hit of hits) {
      let owner = hit.object;
      while (owner && !owner.userData?.playerId) owner = owner.parent;
      if (owner?.userData?.playerId && (this.playerVisibility.get(owner.userData.playerId) ?? true)) {
        return owner.userData.playerId;
      }
    }
    return null;
  }

  onFollowWheel(event) {
    if (this.followTargetId === null || this.freeCamera.mode === "free") return;
    event.preventDefault();
    const interior = this.followViewMode === "interior";
    this.followDistance = THREE.MathUtils.clamp(this.followDistance * Math.exp(event.deltaY * 0.001),
      interior ? FOLLOW_INTERIOR_MIN_DISTANCE : FOLLOW_MIN_DISTANCE,
      interior ? FOLLOW_INTERIOR_MAX_DISTANCE : FOLLOW_MAX_DISTANCE);
  }

  updateCameraMarkerVisibility() {
    // A torso-anchored interior camera can sit inside its own sphere/cone.
    // Hide only nearby presentation markers, not data or recorded trails;
    // restore them automatically when the free camera moves away.
    this.markerWorldPosition ||= new THREE.Vector3();
    const clearance = 1.8 * Math.max(1, this.heightScale);
    for (const { marker } of this.playerObjects.values()) {
      marker.updateWorldMatrix(true, false);
      marker.getWorldPosition(this.markerWorldPosition);
      marker.visible = Boolean(marker.userData.replayVisible)
        && this.camera.position.distanceToSquared(this.markerWorldPosition) > clearance * clearance;
    }
  }

  setTime(seconds) {
    const nextTime = Math.max(0, Number(seconds) || 0);
    if (nextTime < this.currentTime - 0.01 || nextTime > this.currentTime + 1) this.followDiscontinuity = true;
    this.currentTime = nextTime;
    const worldPlayers = [];
    for (const {
      group,
      line,
      outline,
      occludedLine,
      marker,
      samples,
      blockingEvents,
      lifecycleEvents,
      maxGap,
    } of this.playerObjects.values()) {
      line.geometry.instanceCount = binaryUpperBound(line.userData.endTimes, this.currentTime);
      line.visible = this.showTracks;
      outline.visible = this.showTracks;
      occludedLine.visible = this.showTracks;
      const sample = sampleAtTime(samples, this.currentTime, maxGap, blockingEvents);
      const latestLifecycle = lifecycleEvents.findLast((event) => event.t <= this.currentTime);
      const isPresent = latestLifecycle?.type !== "leave";
      const life = latestLifeEventBefore(this.trace, group.userData.playerId, this.currentTime, MARKER_LIFE_EVENT_TYPES);
      if (sample && this.currentTime - sample.t <= maxGap && isPresent && life?.type !== "death" && (this.playerVisibility.get(group.userData.playerId) ?? true)) worldPlayers.push(sample);
      const segmentMatches =
        sample && (this.activeSegment === null || !Number.isInteger(sample.segment) || sample.segment === this.activeSegment);
      const displayBounds = this.useMap && this.activeSegment !== null ? this.viewBounds() : null;
      marker.visible = Boolean(this.showMarkers && sample && segmentMatches && isPresent && pointInBounds(sample.pos, displayBounds));
      marker.userData.replayVisible = marker.visible;
      marker.userData.followable = Boolean(sample && segmentMatches && isPresent && life?.type !== "death"
        && this.currentTime - sample.t <= maxGap && pointInBounds(sample.pos, displayBounds));
      if (sample) {
        marker.position.set(
          sample.pos[0] - this.origin.x,
          sample.pos[1] - this.origin.y,
          sample.pos[2] - this.origin.z,
        );
        marker.rotation.y = THREE.MathUtils.degToRad(sample.yaw || 0);
      }
      group.visible = this.playerVisibility.get(group.userData.playerId) ?? true;
    }
    this.worldRenderer.update(this.currentTime, { players: worldPlayers, heightScale: this.heightScale,
      segment: this.activeSegment,
      bounds: this.useMap && this.activeSegment !== null ? this.viewBounds() : null });
    updateRecordedMineVisibility(this.terrainRoot, this.worldRenderer.objects, this.trace?.events, this.currentTime);
    // The verified map sidecar identifies original fog surfaces even when a
    // captured world is empty or its live fog has moved. Never leave a fixed
    // initial surface behind the real replay, or guess association by proximity.
    const fogReplacements = this.trace?.worldTimeline?.captured
      ? this.worldRenderer.mapFog?.volumes || [] : this.worldRenderer.objects;
    updateMapFogSurfaceVisibility(this.terrainRoot, this.worldRenderer.enabled ? fogReplacements : []);
  }

  setGameAssetPack(pack) {
    this.gameAssetPack = pack;
    this.worldRenderer.setData(this.trace, pack, this.origin);
    this.setTime(this.currentTime);
  }

  /** Live sources grow their tracks in place; rebuild only the trail geometry,
   * labels and time-driven state (terrain, camera and bounds stay untouched). */
  refreshTracks() {
    if (!this.trace) return;
    this.buildTracks();
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
    this.followTerrainDirty = true;
    this.followRig?.reset();
    this.terrainRoot.scale.y = this.heightScale;
    this.trailRoot.scale.y = this.heightScale;
    this.worldRenderer.root.scale.y = this.heightScale;
    if (this.sourceWater) this.sourceWater.root.scale.y = this.heightScale;
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
    if (this.followTargetId == null) this.fitView();
    const selected = this.activeSegment;
    const cameraRevision = this.cameraSelectionRevision;
    const buildRevision = this.buildToken;
    void this.ensureGeometryLayers().then(() => {
      if (this.followTargetId == null && selected === this.activeSegment && buildRevision === this.buildToken && cameraRevision === this.cameraSelectionRevision && isInteriorLayer(this.selectedLayer(), this.mapPack?.route)) this.enterInteriorView(false);
    });
  }

  applyLayerVisibility() {
    this.followTerrainDirty = true;
    this.sourceWater?.setSegment(this.activeSegment);
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
    this.setFollowTarget(null);
    ++this.cameraSelectionRevision;
    const pose = chooseRecordedInteriorPose(this.trace, this.currentTime, this.viewBounds(), { playerVisibility: this.playerVisibility });
    if (pose) {
      const yaw = THREE.MathUtils.degToRad(pose.yaw || 0);
      // Recorder pos is Character.Center (torso), NOT feet. No head pose was
      // recorded, so adding a standing eye height could put us above a ceiling.
      // The camera lives OUTSIDE the Z-mirrored world root, so every coordinate
      // and direction handed to it must be in rendered space (Z negated).
      this.freeCamera.enterAt([pose.pos[0] - this.origin.x, (pose.pos[1] - this.origin.y) * this.heightScale, -(pose.pos[2] - this.origin.z)], [Math.sin(yaw), 0, -Math.cos(yaw)], { focus });
      this.cameraPlacementNote = "已记录的玩家中心 · 关内参考视点，非眼位";
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
          const worldZ = THREE.MathUtils.lerp(bounds.min[2], bounds.max[2], z);
          probe.set(THREE.MathUtils.lerp(bounds.min[0], bounds.max[0], x) - this.origin.x,
            (THREE.MathUtils.lerp(bounds.min[1], bounds.max[1], h) - this.origin.y) * this.heightScale,
            -(worldZ - this.origin.z));
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

  toggleFreeCamera() { this.setFollowTarget(null); ++this.cameraSelectionRevision; this.freeCamera.setMode(this.freeCamera.mode === "free" ? "orbit" : "free"); this.freeCamera.focus(); }

  focusWorldEvent(event) {
    if (!event.objectId || !event.pos) return;
    this.setFollowTarget(null);
    ++this.cameraSelectionRevision;
    // Rendered space: the world root is Z-mirrored (Unity LH → three RH).
    const target = new THREE.Vector3(event.pos[0] - this.origin.x, (event.pos[1] - this.origin.y) * this.heightScale, -(event.pos[2] - this.origin.z));
    const position = target.clone().add(new THREE.Vector3(9, 10, -12));
    this.freeCamera.enterAt(position, target.clone().sub(position), { focus: false });
    this.canvas.dispatchEvent(new CustomEvent("cameraplacement", { detail: { note: "事件近景 · 特效为回放示意" } }));
  }

  fitView() {
    this.setFollowTarget(null);
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
      -((bounds.min[2] + bounds.max[2]) / 2 - this.origin.z),
    );
    // Daily scenes climb toward +Z. Looking from the sea keeps later, taller
    // biomes behind the recorded route; the Z-mirrored world renders the sea
    // (game -Z) on the +Z side.
    this.camera.position.copy(target).add(new THREE.Vector3(distance * 0.52, distance * 0.7, distance * 0.62));
    this.controls.target.copy(target);
    this.camera.near = Math.max(0.1, distance / 5000);
    this.camera.far = Math.max(2000, distance * 8);
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  topView() {
    this.setFollowTarget(null);
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
      -((bounds.min[2] + bounds.max[2]) / 2 - this.origin.z),
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
    this.setFollowTarget(null);
    this.followTerrain?.dispose();
    for (const [target, name, handler] of this.followListeners || []) target.removeEventListener(name, handler);
    this.followListeners = [];
    this.freeCamera.dispose();
    this.worldRenderer.dispose();
    this.sourceWater?.dispose();
    this.fogDepthPass.dispose();
    this.controls.dispose();
    this.geometryAbort?.abort();
    this.geometryLoads.clear();
    disposeObject(this.terrainRoot);
    disposeObject(this.trailRoot);
    disposeObject(this.gridRoot);
    this.labelOverlay?.remove();
    this.playerLabels?.clear();
    this.playerGroups?.clear();
    this.playerPortraits?.clear();
    this.renderer.dispose();
  }
}
