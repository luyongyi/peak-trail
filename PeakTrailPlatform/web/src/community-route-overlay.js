import * as THREE from "three";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { normalizeRoutes, normalizeHeatmap, routeEdges } from "./route-collection-model.js";
import { buildTeamRouteSegments, teamMemberColor } from "./team-route-model.js";

function release(root) {
  const geometries = new Set(), materials = new Set();
  root.traverse(object => {
    if (object.geometry) geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : object.material ? [object.material] : []) materials.add(material);
    if (object.isInstancedMesh) object.dispose();
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  root.clear();
}

/** Verified historical overlays only: no network, portraits, animation or clock.
 * Attach root beneath the scene's existing Unity-to-Three mirrored worldRoot.
 * The controller verifies approval and map identity before this renderer is used.
 */
export class CommunityRouteOverlay {
  constructor() {
    this.root = new THREE.Group();
    this.root.name = "community-routes";
    this.root.visible = false;
    this.players = new Map();
    this.lineMaterials = new Set();
    this.width = this.height = 1;
    this.source = null;
    this.mode = "off";
  }

  clear() {
    release(this.root);
    this.players.clear();
    this.lineMaterials.clear();
    this.root.visible = false;
    this.source = null;
    this.mode = "off";
  }

  setViewport(width, height) {
    this.width = Math.max(1, Number(width) || 1);
    this.height = Math.max(1, Number(height) || 1);
    for (const material of this.lineMaterials) material.resolution.set(this.width, this.height);
  }

  setVisiblePlayers(keys) {
    const visible = keys === null || keys === undefined ? null : new Set(keys);
    for (const [id, entry] of this.players) entry.group.visible = Boolean(!visible || visible.has(id)
      || visible.has(entry.playerKey) || entry.playerKeys?.some(key => visible.has(key)));
  }

  addLines(positions, endpoints, color, metadata, width = 2.8) {
    if (!positions.length) return null;
    const geometry = new LineSegmentsGeometry();
    geometry.setPositions(positions);
    const group = new THREE.Group();
    group.name = "community-route";
    group.userData = metadata;
    for (const [opacity, depthFunc, lineWidth, order] of [[.2, THREE.GreaterDepth, width * .72, 21], [.85, THREE.LessEqualDepth, width, 22]]) {
      // Screen-space ribbons keep their winding after the world Z mirror,
      // while Three reverses its front-face rule for that negative matrix.
      const material = new LineMaterial({ color, linewidth: lineWidth, worldUnits: false, transparent: true, opacity,
        depthTest: true, depthFunc, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true });
      material.resolution.set(this.width, this.height);
      this.lineMaterials.add(material);
      const line = new LineSegments2(geometry, material);
      line.renderOrder = order;
      group.add(line);
    }
    if (endpoints.length) {
      const pointsGeometry = new THREE.BufferGeometry();
      pointsGeometry.setAttribute("position", new THREE.Float32BufferAttribute(endpoints, 3));
      const points = new THREE.Points(pointsGeometry, new THREE.PointsMaterial({ color, size: 5, sizeAttenuation: false,
        transparent: true, opacity: .85, depthTest: false, depthWrite: false }));
      points.renderOrder = 23;
      group.add(points);
    }
    this.root.add(group);
    return group;
  }

  setData(input, origin, heightScale = 1) {
    if (!input || input.mode === "off" || !Number.isInteger(input.stageIndex)) { this.clear(); return; }
    const band = input.heightBand === null || input.heightBand === undefined ? null : input.heightBand;
    if (band !== null && !Number.isSafeInteger(band)) throw new Error("Invalid community height band");
    if (!["team", "routes", "heatmap"].includes(input.mode)) throw new Error("Invalid community overlay mode");
    const memberSelection = input.visiblePlayers == null ? null : JSON.stringify([...input.visiblePlayers].sort());
    const referencePlayerKey = input.referencePlayerKey || null;
    const source = this.source;
    const same = source && source.mode === input.mode && source.routes === input.routes && source.heatmap === input.heatmap
      && source.stageIndex === input.stageIndex && source.band === band && source.origin.every((value, axis) => value === origin.getComponent(axis))
      && (input.mode !== "team" || source.memberSelection === memberSelection && source.referencePlayerKey === referencePlayerKey);
    if (same) {
      this.root.scale.y = heightScale;
      this.setVisiblePlayers(input.visiblePlayers);
      return;
    }
    this.clear();
    const local = point => [point[1] / 100 - origin.x, point[2] / 100 - origin.y, point[3] / 100 - origin.z];
    if (input.mode === "routes") {
      const routes = normalizeRoutes({ routes: input.routes || [] }).routes;
      const heightBandCm = input.heatmap?.heightBandCm || 200;
      routes.forEach(route => {
        const positions = [], endpoints = [];
        const edges = routeEdges(route, { band, heightBandCm });
        let previousEnd = null;
        for (const [start, end] of edges) {
          positions.push(...local(start), ...local(end));
          if (!previousEnd || start.some((value, axis) => value !== previousEnd[axis])) {
            if (previousEnd) endpoints.push(...local(previousEnd));
            endpoints.push(...local(start));
          }
          previousEnd = end;
        }
        if (previousEnd) endpoints.push(...local(previousEnd));
        const group = this.addLines(positions, endpoints, teamMemberColor(route.playerKey || route.id),
          { routeId: route.id, playerKey: route.playerKey, stageIndex: input.stageIndex });
        if (group) this.players.set(route.id, { group, playerKey: route.playerKey });
      });
    } else if (input.mode === "team") {
      const pieces = buildTeamRouteSegments(input.routes, { visiblePlayers: input.visiblePlayers, referencePlayerKey,
        band, heightBandCm: input.heatmap?.heightBandCm || 200 });
      const batches = new Map();
      for (const piece of pieces) {
        // Batch shared pieces by member count. Individual branches retain each
        // member's stable color, with a slightly stronger reference route.
        const shared = piece.members.length > 1, key = shared ? `shared-${piece.members.length}-${piece.reference}` : piece.members[0];
        let batch = batches.get(key);
        if (!batch) {
          batch = { positions: [], members: new Set(), reference: piece.reference, shared,
            color: shared ? "#f1d389" : teamMemberColor(piece.members[0]) };
          batches.set(key, batch);
        }
        batch.positions.push(...local(piece.start), ...local(piece.end));
        piece.members.forEach(member => batch.members.add(member));
      }
      for (const [key, batch] of batches) {
        const playerKeys = [...batch.members];
        const group = this.addLines(batch.positions, [], batch.color, { team: true, shared: batch.shared,
          reference: batch.reference, playerKeys, stageIndex: input.stageIndex }, batch.shared ? 3.6 : batch.reference ? 3.2 : 2.6);
        if (group) this.players.set(key, { group, playerKeys });
      }
    } else {
      const heatmap = normalizeHeatmap(input.heatmap);
      const cells = band === null ? heatmap.cells : heatmap.cells.filter(cell => cell[1] === band);
      if (cells.length) {
        const width = heatmap.cellSizeCm / 100, height = heatmap.heightBandCm / 100;
        const geometry = new THREE.BoxGeometry(width, height, width);
        // This is a spatial data layer: terrain must not hide cells within its
        // recorded height band. Keep their real positions rather than lifting
        // them onto the ground, and keep data colors out of scene tone mapping.
        const material = new THREE.MeshBasicMaterial({ transparent: true, opacity: .55, depthTest: false,
          depthWrite: false, toneMapped: false });
        const mesh = new THREE.InstancedMesh(geometry, material, cells.length);
        mesh.name = "community-heatmap";
        mesh.renderOrder = 20;
        const matrix = new THREE.Matrix4(), color = new THREE.Color();
        const maximum = cells.reduce((value, cell) => Math.max(value, cell[3]), 1);
        cells.forEach(([x, y, z, count], index) => {
          matrix.makeTranslation((x + .5) * width - origin.x, (y + .5) * height - origin.y, (z + .5) * width - origin.z);
          mesh.setMatrixAt(index, matrix);
          color.setHSL(.14 * (1 - count / maximum), .95, .5);
          mesh.setColorAt(index, color);
        });
        mesh.instanceMatrix.needsUpdate = true;
        mesh.instanceColor.needsUpdate = true;
        this.root.add(mesh);
      }
    }
    this.mode = input.mode;
    this.source = { mode: input.mode, routes: input.routes, heatmap: input.heatmap, stageIndex: input.stageIndex,
      band, origin: origin.toArray(), memberSelection, referencePlayerKey };
    this.root.scale.y = heightScale;
    this.root.visible = true;
    this.setVisiblePlayers(input.visiblePlayers);
  }

  dispose() { this.clear(); this.root.removeFromParent(); }
}
