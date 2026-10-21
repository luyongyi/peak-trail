import * as THREE from 'three';
import { WorldRenderer } from './world-renderer.js';
import { relatedUseEvent, visibleItemEvents } from './item-events.js';

// These are recorded locations, not persistent world objects. Models are small
// symbolic markers: neither orientation nor continued existence was recorded.
export class ItemEventOverlay {
  constructor(canvas, { modelLoader = null } = {}) {
    this.root = new THREE.Group();
    this.models = new THREE.Group(); this.root.add(this.models);
    this.points = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ size: 8, sizeAttenuation: false, vertexColors: true, depthTest: false, transparent: true, opacity: .9 }));
    this.points.renderOrder = 20; this.root.add(this.points);
    this.link = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xe5c274, depthTest: false, transparent: true, opacity: .8 }));
    this.link.renderOrder = 21; this.root.add(this.link); this.link.visible = false;
    this.loader = modelLoader || new WorldRenderer(canvas); this.loader.overlay.hidden = true;
    this.canvas = canvas; this.origin = new THREE.Vector3(); this.input = {}; this.visible = []; this.generation = 0;
  }
  setData(input, origin, heightScale) {
    this.input = input; this.origin.copy(origin); this.root.scale.y = heightScale;
    const changed = this.loader.pack !== input.pack;
    this.loader.setData(null, input.pack || null, origin);
    if (changed) this.key = null;
    this.setTime(input.timeMs / 1000, input.playerVisibility);
  }
  setTime(time, playerVisibility) {
    const input = this.input;
    const players = input.live && playerVisibility ? new Set((input.events || []).filter(event => playerVisibility.get(event.playerKey) !== false).map(event => event.playerKey)) : input.visiblePlayers;
    this.visible = input.enabled ? visibleItemEvents(input.events || [], { stageIndex: input.stageIndex, timeMs: input.live ? time * 1000 : Infinity, visiblePlayers: players }) : [];
    const key = `${this.origin.toArray()}|${this.visible.map(event => event.id).join(',')}`;
    if (key !== this.key) {
      this.key = key; ++this.generation; this.models.clear();
      const positions = [], colors = [];
      for (const event of this.visible) {
        positions.push(...new THREE.Vector3().fromArray(event.pos).sub(this.origin).toArray());
        colors.push(...new THREE.Color(event.kind === 'item-spawn' ? 0xe7be6a : 0x80caba).toArray());
      }
      this.points.geometry.dispose(); this.points.geometry = new THREE.BufferGeometry();
      this.points.geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      this.points.geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      const generation = this.generation;
      for (const event of this.visible.filter(value => value.kind === 'item-spawn').slice(0, 32)) {
        // Exact generated prefab wins over the source item's world model.
        const asset = this.loader.resolveAsset({ ...event.item, kind: 'placed_object' });
        if (!asset.modelUrl) continue;
        void this.loader.template(asset.modelUrl).then(template => {
          if (!template || generation !== this.generation) return;
          const group = new THREE.Group(), model = template.clone(true);
          const size = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
          model.scale.multiplyScalar(Math.min(1, 1.2 / Math.max(size.x, size.y, size.z, .01)));
          group.add(model); group.position.fromArray(event.pos).sub(this.origin); this.models.add(group);
        });
      }
    }
    if (this.selectedId && !this.visible.some(event => event.id === this.selectedId)) {
      this.selectedId = null; this.canvas.dispatchEvent(new CustomEvent('peaktrail-item-event', { detail: { id: null } }));
    }
    this.updateLink();
  }
  select(id) { this.selectedId = id; this.updateLink(); }
  updateLink() {
    const event = this.visible.find(value => value.id === this.selectedId);
    const use = relatedUseEvent(this.input.events || [], event);
    this.link.visible = Boolean(use);
    const key = use ? `${use.id}:${event.id}:${this.origin.toArray()}` : null;
    if (this.linkKey === key) return;
    this.linkKey = key;
    if (!use) return;
    this.link.geometry.dispose();
    this.link.geometry = new THREE.BufferGeometry().setFromPoints([use, event].map(value => new THREE.Vector3().fromArray(value.pos).sub(this.origin)));
  }
  pickScreen({ x, y, width, height, camera }) {
    this.root.updateWorldMatrix(true, false);
    let selected = null, distance = 14;
    for (const event of this.visible) {
      const p = new THREE.Vector3().fromArray(event.pos).sub(this.origin).applyMatrix4(this.root.matrixWorld).project(camera);
      if (p.z < -1 || p.z > 1) continue;
      const d = Math.hypot((p.x + 1) * width / 2 - x, (1 - p.y) * height / 2 - y);
      if (d < distance) { selected = event; distance = d; }
    }
    return selected;
  }
  dispose() {
    ++this.generation; this.models.clear(); this.points.geometry.dispose(); this.points.material.dispose();
    this.link.geometry.dispose(); this.link.material.dispose(); this.loader.dispose(); this.root.removeFromParent();
  }
}
