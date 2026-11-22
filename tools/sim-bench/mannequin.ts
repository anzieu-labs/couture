import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AnnyModel, type AnnyMeta } from "../../lib/avatar/anny";

/**
 * Node loader for public/mannequin/{mannequin.glb, mannequin.json}: the same data
 * as lib/avatar/loadAnny.ts, read straight from the GLB accessors (no three.js,
 * no DOM). The file only uses plain accessors (KHR_mesh_quantization).
 */

const COMPONENT = {
  5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array,
} as const;
const SIZE = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 } as const;

interface Accessor {
  bufferView?: number;
  byteOffset?: number;
  sparse?: {
    count: number;
    indices: { bufferView: number; byteOffset?: number; componentType: keyof typeof COMPONENT };
    values: { bufferView: number; byteOffset?: number };
  };
  componentType: keyof typeof COMPONENT;
  normalized?: boolean;
  count: number;
  type: keyof typeof SIZE;
}

export function loadMannequin(root: string): AnnyModel {
  const dir = join(root, "public/mannequin");
  const meta = JSON.parse(readFileSync(join(dir, "mannequin.json"), "utf8")) as AnnyMeta;
  const glb = readFileSync(join(dir, "mannequin.glb"));
  const jsonLength = glb.readUInt32LE(12);
  const gltf = JSON.parse(glb.subarray(20, 20 + jsonLength).toString("utf8"));
  const binStart = 20 + jsonLength + 8;
  const bin = glb.buffer.slice(glb.byteOffset + binStart, glb.byteOffset + binStart + glb.readUInt32LE(20 + jsonLength));

  const view = (index: number, componentType: keyof typeof COMPONENT, length: number, byteOffset = 0) => {
    const v = gltf.bufferViews[index];
    if (v.byteStride) throw new Error("mannequin.glb: interleaved buffer views are not supported");
    const Type = COMPONENT[componentType];
    const offset = (v.byteOffset ?? 0) + byteOffset;
    return new Type(bin.slice(offset, offset + length * Type.BYTES_PER_ELEMENT));
  };
  const read = (index: number) => {
    const acc = gltf.accessors[index] as Accessor;
    const size = SIZE[acc.type];
    const array =
      acc.bufferView === undefined ? new COMPONENT[acc.componentType](acc.count * size) : view(acc.bufferView, acc.componentType, acc.count * size, acc.byteOffset);
    // Sparse accessor (the local-change targets): a few values over zeros.
    if (acc.sparse) {
      const ids = view(acc.sparse.indices.bufferView, acc.sparse.indices.componentType, acc.sparse.count, acc.sparse.indices.byteOffset);
      const values = view(acc.sparse.values.bufferView, acc.componentType, acc.sparse.count * size, acc.sparse.values.byteOffset);
      for (let i = 0; i < ids.length; i++) for (let k = 0; k < size; k++) array[ids[i] * size + k] = values[i * size + k];
    }
    return { array, acc };
  };

  const prim = gltf.meshes[0].primitives[0];
  const base = Float32Array.from(read(prim.attributes.POSITION).array);
  const indices = read(prim.indices).array as Uint16Array | Uint32Array;
  const names: string[] = gltf.meshes[0].extras.targetNames;
  const deltas = meta.targets.map(({ name, scale }) => {
    const t = names.indexOf(name);
    if (t < 0) throw new Error(`mannequin.glb: missing morph target ${name}`);
    const { array, acc } = read(prim.targets[t].POSITION);
    // Normalized int16 (as three.js denormalizes it), then the target's scale.
    const k = acc.normalized ? 1 / 32767 : 1;
    const out = new Float32Array(array.length);
    for (let i = 0; i < array.length; i++) out[i] = Math.max(array[i] * k, acc.normalized ? -1 : -Infinity) * scale;
    return out;
  });
  const skin = {
    index: Uint8Array.from(read(prim.attributes.JOINTS_0).array),
    weight: Uint8Array.from(read(prim.attributes.WEIGHTS_0).array),
  };
  return new AnnyModel(meta, base, indices, deltas, skin);
}

/** Area-weighted vertex normals (as three.js BufferGeometry.computeVertexNormals). */
export function vertexNormals(positions: Float32Array, indices: ArrayLike<number>): Float32Array {
  const n = new Float32Array(positions.length);
  for (let t = 0; t < indices.length; t += 3) {
    const a = 3 * indices[t], b = 3 * indices[t + 1], c = 3 * indices[t + 2];
    const ux = positions[c] - positions[b], uy = positions[c + 1] - positions[b + 1], uz = positions[c + 2] - positions[b + 2];
    const vx = positions[a] - positions[b], vy = positions[a + 1] - positions[b + 1], vz = positions[a + 2] - positions[b + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const i of [a, b, c]) {
      n[i] += nx; n[i + 1] += ny; n[i + 2] += nz;
    }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= l; n[i + 1] /= l; n[i + 2] /= l;
  }
  return n;
}
