// Presentation-only spectator framing. No climbing/contact normals are recorded:
// the optional outward direction below is measured from the loaded map triangles.
export const FOLLOW_DISTANCE = 56;
export const FOLLOW_MIN_DISTANCE = 12;
export const FOLLOW_MAX_DISTANCE = 140;
const TAU = Math.PI * 2;
const clamp = (x, low, high) => Math.min(high, Math.max(low, x));
const angleDelta = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

/** A geometry-aware observer, independent of the network playhead / OrbitControls. */
export class SpectatorCamera {
  constructor({ THREE, query }) {
    this.THREE = THREE;
    this.query = query;
    for (const name of ["position", "look", "anchor", "previous", "velocity", "aim", "direction", "tmp", "right", "end", "viewPosition", "viewRight", "viewUp", "viewRay"])
      this[name] = new THREE.Vector3();
    this.initialized = false;
    this.probeIn = 0;
    this.solution = null;
    this.lastRequest = "";
  }

  // Centre visibility alone can select a long, narrow slot between two rocks.
  // Check the subject's surrounding screen-space footprint, penalizing only
  // foreground hits. The wall directly behind a climber is useful context.
  viewOpenness(direction, distance) {
    this.viewPosition.copy(this.anchor).addScaledVector(direction, distance);
    this.viewRight.set(direction.z, 0, -direction.x).normalize();
    this.viewUp.crossVectors(direction, this.viewRight).normalize();
    let clear = 0;
    for (const [x, y] of [[-.3, 0], [.3, 0], [0, .22], [0, -.22], [-.23, .16], [.23, .16], [-.23, -.16], [.23, -.16]]) {
      this.viewRay.copy(this.anchor).addScaledVector(this.viewRight, distance * x)
        .addScaledVector(this.viewUp, distance * y).sub(this.viewPosition);
      const length = this.viewRay.length();
      this.viewRay.divideScalar(length);
      const hit = this.query?.cast(this.viewPosition, this.viewRay, length * 0.82);
      if (!hit) clear++;
    }
    return clear / 8;
  }

  invalidate() { this.probeIn = 0; }
  reset() { this.initialized = false; this.probeIn = 0; this.solution = null; }

  directionAt(azimuth, pitch, out = this.direction) {
    const c = Math.cos(pitch);
    return out.set(Math.sin(azimuth) * c, Math.sin(pitch), Math.cos(azimuth) * c);
  }

  // Sphere-like camera clearance, tested at the centre and four near-plane
  // offsets. Only exact triangle intersections shorten the boom, never AABBs.
  clearance(origin, direction, distance, wide = false) {
    const padding = 0.8;
    const hit = this.query?.cast(origin, direction, distance + padding);
    let allowed = hit ? Math.max(0.15, hit.distance - padding) : distance;
    if (wide && allowed > 1) {
      this.right.set(direction.z, 0, -direction.x).normalize();
      for (const [horizontal, vertical] of [[0.55, 0], [-0.55, 0], [0, 0.55], [0, -0.55]]) {
        this.end.copy(direction).multiplyScalar(distance).addScaledVector(this.right, horizontal);
        this.end.y += vertical;
        const length = this.end.length();
        this.end.divideScalar(length);
        const side = this.query?.cast(origin, this.end, length + padding);
        if (side) allowed = Math.min(allowed, Math.max(0.15, (side.distance - padding) * distance / length));
      }
    }
    return Math.min(distance, allowed);
  }

  selectView({ distance, azimuth, pitch, preferredAzimuth, interior, manual }) {
    let preferred = Number.isFinite(preferredAzimuth) ? preferredAzimuth : azimuth;
    let normalFound = false;
    let closest = 5;
    if (!manual && !interior) {
      for (let i = 0; i < 8; i++) {
        this.directionAt(i * TAU / 8, 0);
        const hit = this.query?.cast(this.anchor, this.direction, closest);
        // Near-vertical faces only: a floor, tree canopy or a distant mountain
        // must not pretend to be the player's current climbing surface.
        if (hit && hit.distance < closest && Math.abs(hit.normal.y) < 0.7) {
          closest = hit.distance;
          preferred = Math.atan2(hit.normal.x, hit.normal.z);
          normalFound = true;
        }
      }
    }
    const basePitch = manual ? pitch : interior ? 0.1 : 0.22;
    const angles = manual ? [azimuth] : [azimuth, preferred, ...[-1, 1, -2, 2, -3, 3, -4, 4, 6].map((x) => preferred + x * Math.PI / 6)];
    const pitches = manual ? [pitch] : interior ? [basePitch, 0.3] : [basePitch, 0.5, 0.85];
    let best = null, incumbent = null;
    const evaluate = (angle, elevation) => {
      this.directionAt(angle, elevation);
      const available = this.clearance(this.anchor, this.direction, distance, true);
      const reach = available / distance;
      const outward = Math.cos(angleDelta(angle, preferred));
      const continuity = Math.cos(angleDelta(angle, azimuth));
      const openness = !manual && available > 3 ? this.viewOpenness(this.direction, available) : 0;
      const score = reach * 8 + outward * (normalFound ? 2.1 : 0.55)
        + continuity * 0.85 + openness * 3 - Math.abs(elevation - basePitch) * 1.2;
      const candidate = { azimuth: angle, pitch: elevation, distance: available, score, normalFound, openness };
      if (!best || score > best.score) best = candidate;
      return candidate;
    };
    if (!manual && this.solution) incumbent = evaluate(this.azimuth, this.pitch);
    for (const angle of angles) for (const elevation of pitches) evaluate(angle, elevation);
    // Coarse directions can straddle a narrow but genuinely open outside view.
    // Refine around the best one so the result isn't dependent on entry angle.
    if (!manual) for (const step of [Math.PI / 12, Math.PI / 24]) {
      const center = best.azimuth, elevation = best.pitch;
      evaluate(center - step, elevation); evaluate(center + step, elevation);
    }
    // Keep a useful, unobstructed composition across noisy nearest-face normals
    // and discrete openness scores. A material improvement may still win.
    if (incumbent && incumbent.distance > distance * .9 && incumbent.openness >= .75
      && best.score - incumbent.score < 1.35) return incumbent;
    return best;
  }

  update(anchor, deltaSeconds, options = {}) {
    if (!anchor || ![anchor.x, anchor.y, anchor.z].every(Number.isFinite)) return null;
    const dt = clamp(Number.isFinite(deltaSeconds) ? deltaSeconds : 0, 0, 0.05);
    const distance = clamp(Number(options.distance) || FOLLOW_DISTANCE, FOLLOW_MIN_DISTANCE, FOLLOW_MAX_DISTANCE);
    const manual = Boolean(options.manual);
    const initialAzimuth = Number.isFinite(options.azimuth) ? options.azimuth : 0.6;
    const initialPitch = clamp(Number.isFinite(options.pitch) ? options.pitch : 0.22, -0.35, 1.2);
    const jumped = this.initialized && (options.discontinuity || this.previous.distanceTo(anchor) > 25);
    const first = !this.initialized || jumped;
    this.anchor.copy(anchor);
    if (first) {
      this.previous.copy(anchor); this.velocity.set(0, 0, 0);
      this.look.copy(anchor); this.position.copy(options.cameraPosition || anchor);
      this.azimuth = initialAzimuth; this.pitch = initialPitch;
      this.initialized = true; this.probeIn = 0; this.solution = null;
    } else if (dt > 0) {
      this.tmp.copy(anchor).sub(this.previous).divideScalar(dt).clampLength(0, 30);
      this.velocity.lerp(this.tmp, 1 - Math.exp(-dt * 5));
    }
    this.previous.copy(anchor);
    // Very small velocity framing, never a future/recorded pose and no guessed
    // eye-height offset: the recorder supplies the character's torso centre.
    this.tmp.copy(this.velocity).multiplyScalar(0.12).clampLength(0, 1.5);
    this.aim.copy(anchor).add(this.tmp);
    this.look.lerp(this.aim, first ? 1 : 1 - Math.exp(-dt * 9));

    const request = `${manual}:${options.interior}:${distance}:${manual ? `${initialAzimuth}:${initialPitch}` : "auto"}`;
    this.probeIn -= dt;
    if (!this.solution || this.probeIn <= 0 || request !== this.lastRequest) {
      this.solution = this.selectView({ distance, azimuth: manual ? initialAzimuth : this.azimuth,
        pitch: initialPitch, preferredAzimuth: options.preferredAzimuth, interior: options.interior, manual });
      this.probeIn = 0.28;
      this.lastRequest = request;
    }
    let solution = this.solution;
    // A cached opening can close as the player walks around a corner. Re-query
    // in the same frame, using the same wide clearance as final placement.
    this.directionAt(this.azimuth, this.pitch);
    let currentSafe = this.clearance(this.anchor, this.direction, distance, true);
    if (!manual && currentSafe < distance * .65 && solution.distance > distance * .7 && this.probeIn < .28) {
      solution = this.solution = this.selectView({ distance, azimuth: this.azimuth,
        pitch: initialPitch, preferredAzimuth: options.preferredAzimuth, interior: options.interior, manual });
      this.probeIn = .28;
    }
    // Interpolate the orbit, not the chord between camera positions. A Cartesian
    // lerp cuts through a convex cliff even when both orbit endpoints are clear.
    const turn = first || manual ? 1 : 1 - Math.exp(-dt * 2.8);
    let nextAzimuth = this.azimuth + angleDelta(solution.azimuth, this.azimuth) * turn;
    let nextPitch = this.pitch + (solution.pitch - this.pitch) * turn;
    this.directionAt(nextAzimuth, nextPitch);
    let safe = this.clearance(this.anchor, this.direction, distance, true);
    let relocated = false;
    if (!manual && !first && currentSafe > distance * .85 && safe < currentSafe * .8) {
      // Do not abandon an open view to begin an obstructed orbit transition.
      nextAzimuth = this.azimuth; nextPitch = this.pitch; safe = currentSafe;
    }
    // If terrain suddenly closes the current view, cut to a verified clear
    // destination rather than spend seconds looking through the player's body.
    // This is only an automatic emergency transition, never manual orbit.
    if (!manual && safe < distance * .3 && solution.distance > distance * .7) {
      this.directionAt(solution.azimuth, solution.pitch);
      const safeDestination = this.clearance(this.anchor, this.direction, distance, true);
      if (safeDestination > distance * 0.65) {
        nextAzimuth = solution.azimuth; nextPitch = solution.pitch;
        safe = safeDestination; relocated = true;
      }
    }
    this.azimuth = nextAzimuth; this.pitch = nextPitch;
    this.boom = first || relocated ? safe : Math.min(safe, this.boom + (safe - this.boom) * (1 - Math.exp(-dt * 5)));
    this.directionAt(this.azimuth, this.pitch);
    this.position.copy(this.anchor).addScaledVector(this.direction, this.boom);
    return { position: this.position, target: this.look, distance: this.position.distanceTo(anchor),
      desiredDistance: distance, constrained: this.position.distanceTo(anchor) < distance * 0.65,
      geometryDerived: solution.normalFound, azimuth: this.azimuth, pitch: this.pitch, relocated };
  }
}
