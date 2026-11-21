// Renderer-world metres. The plane always contains the building's source
// axis. The horizontal viewing direction decides which half faces the viewer.
export function createSectionPlane(THREE) {
  return { value: new THREE.Vector4(0, 1, 0, 0), footing: { value: new THREE.Vector4(0, 0, 0, 0) },
    axisX: 0, axisZ: 0, eye: new THREE.Vector3() };
}

export function orientSectionPlane(section, backX, backZ, eye) {
  const plane = section.value;
  const length = Math.hypot(backX, backZ);
  // A directly overhead camera has no horizontal bearing. Keep the last cut.
  let nx = length > 0.0001 ? backX / length : plane.x;
  let nz = length > 0.0001 ? backZ / length : plane.y;
  const foot = section.footing.value;
  if (section.keepContactWall && foot.w > 0) {
    const dx = foot.x - section.axisX, dz = foot.z - section.axisZ, radius = Math.hypot(dx, dz);
    if (radius > foot.w) {
      // Auto-follow may need to look inward at an inner column's OUTSIDE face.
      // Reflect the radial component into the empty half, leaving the entire
      // climbing wall behind the plane. A manual orbit rotates the cut freely.
      const rx = dx / radius, rz = dz / radius, radialDot = nx * rx + nz * rz;
      const margin = Math.min(foot.w / radius, 0.3) * Math.min(1, (radius - foot.w) / foot.w);
      if (radialDot > -margin) {
        const correction = radialDot + Math.max(Math.abs(radialDot), margin);
        nx -= correction * rx; nz -= correction * rz;
        const scale = Math.hypot(nx, nz); nx /= scale; nz /= scale;
      }
    }
  }
  plane.set(nx, nz, -(nx * section.axisX + nz * section.axisZ), 1);
  section.eye.copy(eye);
}

// Same half-space and contact patch as the structural material. Intersections
// are two-sided; orient a face toward the candidate camera as the GPU does.
export function cutsSectionPoint(section, point, normal) {
  const plane = section.value;
  if (!plane.w || point.x * plane.x + point.z * plane.y + plane.z <= 0) return false;
  const foot = section.footing.value;
  const dx = point.x - foot.x, dy = point.y - foot.y, dz = point.z - foot.z;
  if (!(foot.w > 0 && dx * dx + dz * dz <= foot.w * foot.w && dy >= -2 && dy <= 1.25)) return true;
  const eye = section.eye;
  const facing = normal.x * (eye.x - point.x) + normal.y * (eye.y - point.y) + normal.z * (eye.z - point.z);
  if (dy <= 0 && (facing < 0 ? -normal.y : normal.y) >= 0.55) return false;
  let ex = eye.x - foot.x, ez = eye.z - foot.z;
  if (ex * ex + ez * ez < 1e-8) { ex = plane.x; ez = plane.y; }
  return dx * ex + dz * ez > 0;
}
