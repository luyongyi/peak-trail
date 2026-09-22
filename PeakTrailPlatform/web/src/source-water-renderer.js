import * as THREE from 'three';
import { normalizeMapWater, sourceWaterVisible } from './map-water.js';

/** A separate sibling of terrainRoot: the 5 km sea must not affect the chapter
 * framing or be treated as a solid cliff by the following camera. */
export class SourceWaterRenderer {
  constructor() {
    this.root = new THREE.Group();
    this.root.name = 'Source ocean';
    this.root.userData.sourceWater = true;
    this.segment = null;
  }

  setMap(mapPack, origin) {
    this.dispose();
    const metadata = normalizeMapWater(mapPack?.mapWater, mapPack);
    if (!metadata) return false;
    this.root.position.copy(origin).multiplyScalar(-1);
    for (const surface of metadata.surfaces) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(surface.corners.flat(), 3));
      geometry.setIndex([0, 2, 1, 0, 3, 2]);
      geometry.computeVertexNormals();
      const material = new THREE.MeshStandardMaterial({
        color: new THREE.Color().fromArray(surface.material.linearColor),
        roughness: 0.8, metalness: 0, side: THREE.DoubleSide,
        // The game's depth shader generates alpha; color.a is NOT opacity.
        // Opaque primary-color approximation preserves actual water occlusion.
        transparent: false, opacity: 1, depthWrite: true,
      });
      material.userData.peakSourceEffect = { kind: 'water', source: surface.material,
        approximation: 'Source flat ocean and primary color; no depth tint, refraction, foam or waves' };
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = surface.objectId;
      mesh.userData = { sourceWater: true, surface };
      mesh.visible = sourceWaterVisible(surface, this.segment);
      this.root.add(mesh);
    }
    return true;
  }

  setSegment(segment) {
    this.segment = segment;
    for (const mesh of this.root.children) mesh.visible = sourceWaterVisible(mesh.userData.surface, segment);
  }

  dispose() {
    for (const mesh of this.root.children) { mesh.geometry.dispose(); mesh.material.dispose(); }
    this.root.clear();
  }
}
