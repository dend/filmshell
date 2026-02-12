/**
 * Octahedral aim vector decoder.
 *
 * Converts (octantByte, aimUint16) from fire events into a 3D unit direction vector.
 *
 * The encoding uses octahedral mapping: the unit sphere is projected onto an
 * octahedron (8 faces), then each face is indexed by an octant byte (0-7).
 * The uint16 encodes the position within the triangular face.
 *
 * Octant bits: bit 0 = X sign, bit 1 = Y sign, bit 2 = Z sign
 * (0 = positive, 1 = negative for each axis)
 *
 * This is experimental — the exact bit layout may need validation against real data.
 */

/**
 * Decode an octahedral aim vector from fire event data.
 *
 * @param octantByte - Octant selector (low 3 bits used, 0-7)
 * @param aimUint16 - Position within the octahedral face
 * @returns Unit direction vector {x, y, z}
 */
export function decodeOctahedralAim(
  octantByte: number,
  aimUint16: number
): { x: number; y: number; z: number } {
  const octant = octantByte & 0x07;

  // Split uint16 into two components: u and v
  // Each triangular face of the octahedron can be parameterized with barycentric-like coords.
  // The uint16 encodes a position as two 8-bit values (u, v) where u + v <= 255.
  const u = (aimUint16 >> 8) & 0xff;
  const v = aimUint16 & 0xff;

  // Normalize to [0, 1] range
  const fu = u / 255;
  const fv = v / 255;

  // On the octahedron, each face satisfies |x| + |y| + |z| = 1.
  // For a face, we use two of the barycentric coordinates:
  // Absolute values: a = fu, b = fv, c = 1 - fu - fv
  // Clamp c to avoid negative from rounding
  const a = fu;
  const b = fv;
  const c = Math.max(0, 1 - a - b);

  // Apply signs based on octant bits
  const sx = (octant & 1) ? -1 : 1;
  const sy = (octant & 2) ? -1 : 1;
  const sz = (octant & 4) ? -1 : 1;

  const x = sx * a;
  const y = sy * b;
  const z = sz * c;

  // Normalize to unit vector (should already be close, but ensure precision)
  const len = Math.sqrt(x * x + y * y + z * z);
  if (len < 1e-10) {
    return { x: 0, y: 0, z: 1 };
  }

  return {
    x: x / len,
    y: y / len,
    z: z / len,
  };
}
