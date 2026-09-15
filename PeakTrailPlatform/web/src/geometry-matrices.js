/** Factor a reflection out of an instance so Three can set winding per draw.
 * Column-major matrices: M = F * (F * M), where F = diag(-1,1,1,1).
 * The caller gives the batch object scale.x=-1 only for reflected instances. */
export function positiveInstanceTransform(elements) {
  if (elements.length !== 16 || !Array.from(elements).every(Number.isFinite)) throw new Error("Invalid instance affine matrix");
  const determinant = elements[0] * (elements[5] * elements[10] - elements[9] * elements[6])
    - elements[4] * (elements[1] * elements[10] - elements[9] * elements[2])
    + elements[8] * (elements[1] * elements[6] - elements[5] * elements[2]);
  const reflected = determinant < 0;
  const matrix = Array.from(elements);
  if (reflected) for (const index of [0, 4, 8, 12]) matrix[index] = -matrix[index];
  return { reflected, matrix };
}
