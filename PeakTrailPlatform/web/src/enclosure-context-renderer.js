import { chapterEnclosures } from './map-enclosures.js';

/** Contextual chapter landmarks are display-only siblings of terrain. Keeping
 * them separate prevents the next chapter's shell entering player filtering,
 * recorded hazards, or the current chapter's terrain collision queries. */
export class EnclosureContextRenderer {
  constructor({ THREE, loadGeometry, disposeObject }) {
    this.THREE = THREE;
    this.loadGeometry = loadGeometry;
    this.disposeObject = disposeObject;
    this.root = new THREE.Group();
    this.root.name = 'Adjacent source enclosure';
    this.root.userData.enclosureContext = true;
    this.root.userData.loaded = false;
    this.root.userData.loading = false;
    this.root.userData.sourceSegments = [];
    this.root.visible = false;
    this.entries = [];
    this.sourceSelectionSegment = null;
    this.generation = 0;
    this.key = null;
    this.disposed = false;
  }

  clear() {
    ++this.generation;
    this.key = null;
    this.root.visible = false;
    this.root.userData.loaded = false;
    this.root.userData.loading = false;
    this.root.userData.contextKey = null;
    this.root.userData.mapPackId = null;
    this.root.userData.sourceSegments = [];
    this.root.userData.sourceSelectionSegment = null;
    this.entries = [];
    this.sourceSelectionSegment = null;
    for (const model of [...this.root.children]) this.disposeObject(model);
    this.root.clear();
  }

  get bounds() {
    if (!this.root.visible || !this.root.userData.loaded || !this.entries.length) return null;
    return {
      min: [0, 1, 2].map(axis => Math.min(...this.entries.map(entry => entry.meshBounds.min[axis]))),
      max: [0, 1, 2].map(axis => Math.max(...this.entries.map(entry => entry.meshBounds.max[axis]))),
    };
  }

  async setSelection(mapPack, layer, {
    includeContext = false, origin = new this.THREE.Vector3(), signal, isCurrent = () => true,
  } = {}) {
    if (this.disposed || !isCurrent()) return false;
    const own = new Set(chapterEnclosures(mapPack, layer).map(entry => entry.objectId));
    const entries = includeContext ? chapterEnclosures(mapPack, layer, { includeContext: true })
      .filter(entry => !own.has(entry.objectId)) : [];
    if (!entries.length) {
      this.clear();
      return false;
    }
    const key = JSON.stringify([mapPack.gameBuildId, mapPack.mapPackId, mapPack.source?.sceneSha256,
      layer.segment, entries.map(entry => [entry.objectId, entry.segment, entry.geometrySha256, entry.geometryUrl])]);
    const displayOrigin = new this.THREE.Vector3().copy(origin);
    const translate = model => model.position.copy(displayOrigin).multiplyScalar(-1);
    if (key === this.key && this.root.userData.loaded) {
      for (const model of this.root.children) translate(model);
      this.root.visible = true;
      return true;
    }
    this.clear();
    const generation = this.generation;
    const current = () => !this.disposed && generation === this.generation && isCurrent();
    this.key = key;
    this.root.userData.contextKey = key;
    this.root.userData.mapPackId = mapPack.mapPackId;
    this.root.userData.loading = true;
    this.sourceSelectionSegment = layer.segment;
    this.root.userData.sourceSelectionSegment = layer.segment;
    const models = [];
    try {
      for (const entry of entries) {
        signal?.throwIfAborted?.();
        const model = await this.loadGeometry({ ...entry, id: entry.objectId }, signal, mapPack.gameBuildId);
        models.push(model);
        if (!current()) {
          for (const staged of models) this.disposeObject(staged);
          if (generation === this.generation) this.clear();
          return false;
        }
        signal?.throwIfAborted?.();
        translate(model);
        model.userData.enclosureContext = true;
        model.userData.sourceEnclosure = entry.objectId;
        model.userData.sourceSegment = entry.segment;
        model.userData.sourceMapPackId = mapPack.mapPackId;
      }
      for (const model of models) this.root.add(model);
      this.entries = entries;
      this.root.userData.sourceSegments = [...new Set(entries.map(entry => entry.segment))];
      this.root.userData.loading = false;
      this.root.userData.loaded = true;
      this.root.visible = true;
      return true;
    } catch (error) {
      for (const model of models) this.disposeObject(model);
      if (!current()) {
        if (generation === this.generation) this.clear();
        return false;
      }
      this.clear();
      throw error;
    }
  }

  dispose() {
    this.disposed = true;
    this.clear();
  }
}
