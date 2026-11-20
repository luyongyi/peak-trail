import { ChapterSupportGeometry } from './chapter-support-geometry.js';

// A campfire advances team progress before everyone walks onto the next
// chapter. Select display context from recorded positions and real surfaces.
// Bounds only limit which source we might need to read.
function nearLayer(position, layer) {
  const bounds = layer.meshBounds;
  return bounds && position.every((value, axis) =>
    Number.isFinite(value) && value >= bounds.min[axis] - 2 && value <= bounds.max[axis] + (axis === 1 ? 4 : 2));
}

export class ChapterHandoff {
  constructor(viewer, THREE, disposeSource) {
    this.viewer = viewer;
    this.THREE = THREE;
    this.disposeSource = disposeSource;
    this.reset();
  }

  reset() {
    this.request?.abort();
    this.request = null;
    this.positions = [];
    this.lastCheck = -Infinity;
    this.lastAttempt = null;
    this.retryAfter = 0;
    this.nextColdRead = 0;
    this.viewer.chapterSupport.clear();
  }

  update(samples, force = false) {
    const v = this.viewer, support = v.chapterSupport;
    if (!v.useMap || !v.trace || v.mapPack?.identityVersion !== 3 ||
        !Number.isInteger(v.activeSegment) || v.activeSegment < 1 || v.activeSegment > 4) return;
    const previous = v.terrainRoot.children.find(g => g.userData.segment === v.activeSegment - 1);
    const selected = v.terrainRoot.children.find(g => g.userData.segment === v.activeSegment);
    if (!selected || !previous) return;
    const now = performance.now();
    // setTime also drives interpolation at display refresh rate. Re-evaluate
    // moving players at 4 Hz; always handle seeks, layer readiness and exits.
    if (!force && samples.length && now - this.lastCheck < 250) return;
    this.lastCheck = now;
    const positions = samples.filter(s => (s.activeSegment === v.activeSegment || s.segment === v.activeSegment)
      && nearLayer(s.pos, previous.userData.mapLayer)).map(s =>
        new this.THREE.Vector3(s.pos[0] - v.origin.x, (s.pos[1] - v.origin.y) * v.heightScale, v.origin.z - s.pos[2]));
    let missing = positions;
    if (positions.length && selected.userData.loaded) {
      const grounded = support.probeGround({ positions, query: v.currentTerrainQuery(),
        maxDrop: 3 * v.heightScale, rise: .5 * v.heightScale });
      missing = positions.filter((_, i) => !grounded[i]);
    }
    this.positions = missing;
    support.update({ positions: missing, now });
    if (!missing.length) {
      this.request?.abort();
      this.request = null;
      this.lastAttempt = null;
      return;
    }
    if (this.request || support.hasSupport && support.covered(missing, v.heightScale).every(Boolean)) return;
    // Failed evidence at a stationary position must not trigger a download on
    // every heartbeat. Retry if players have moved or after a transport error.
    if (this.lastAttempt?.length === missing.length && missing.every(p => this.lastAttempt.some(a => a.distanceToSquared(p) < 1))
        && now < this.retryAfter) return;
    if (!previous.userData.loaded && !selected.userData.loaded) return;
    this.lastAttempt = missing.map(p => p.clone());
    this.retryAfter = Infinity;
    if (previous.userData.loaded) {
      this.capture(previous);
      return;
    }
    if (!force && now < this.nextColdRead) {
      this.retryAfter = this.nextColdRead;
      return;
    }
    // Fresh tab or backward seek: borrow only the immediate predecessor. It
    // never enters the visible terrain, and is released as soon as clipped.
    void this.load(previous.userData.mapLayer);
  }

  capture(source) {
    const v = this.viewer, support = v.chapterSupport;
    const options = { roots: [source], positions: this.positions, verticalScale: v.heightScale };
    if (!support.hasSupport) {
      support.capture(options);
      return;
    }
    // A second player can join the boundary while the first one stays at
    // camp. Replace the patch only if it preserves existing players' ground.
    const replacement = new ChapterSupportGeometry(this.THREE, support.options);
    const retained = support.covered(this.positions, v.heightScale);
    if (replacement.capture(options) && retained.every((covered, i) => !covered || replacement.sourceGrounded[i])) {
      support.root.parent?.add(replacement.root);
      v.chapterSupport = replacement;
      support.dispose();
    } else replacement.dispose();
  }

  async load(layer) {
    const v = this.viewer, request = new AbortController();
    this.request = request;
    let model;
    try {
      model = await v.loadChapterGeometry(layer, request.signal, v.mapPack.gameBuildId);
      if (request.signal.aborted || !this.positions.length) return;
      model.position.copy(v.origin).multiplyScalar(-1);
      // Apply the same world transforms as resident chapter meshes, without
      // mounting the temporary source or adding it to camera collision roots.
      v.terrainRoot.updateWorldMatrix(true, false);
      model.updateMatrix();
      model.matrix.premultiply(v.terrainRoot.matrixWorld);
      model.matrixAutoUpdate = false;
      this.capture(model);
      this.lastAttempt = this.positions.map(p => p.clone());
      // Airborne players may cross overlapping chapter bounds for several
      // seconds. A moving miss must not repeatedly decode an entire chapter.
      this.nextColdRead = performance.now() + 4000;
    } catch {
      if (!request.signal.aborted) this.retryAfter = performance.now() + 5000;
    } finally {
      if (model) this.disposeSource(model);
      if (this.request === request) this.request = null;
    }
  }
}
