import type { BufferAttribute, InterleavedBufferAttribute, Mesh } from "three/webgpu";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { AnnyModel, type AnnyMeta } from "./anny";

const BASE_URL = "/mannequin";

/** Loads public/mannequin/{mannequin.glb, mannequin.json} into an AnnyModel. */
export async function loadAnnyModel(): Promise<AnnyModel> {
  const [meta, gltf] = await Promise.all([
    fetch(`${BASE_URL}/mannequin.json`).then((r) => {
      if (!r.ok) throw new Error(`mannequin.json: HTTP ${r.status}`);
      return r.json() as Promise<AnnyMeta>;
    }),
    new GLTFLoader().loadAsync(`${BASE_URL}/mannequin.glb`),
  ]);

  let mesh: Mesh | undefined;
  gltf.scene.traverse((o) => {
    if ((o as Mesh).isMesh) mesh = o as Mesh;
  });
  if (!mesh) throw new Error("mannequin.glb: no mesh");
  const geo = mesh.geometry;
  const base = Float32Array.from((geo.getAttribute("position") as BufferAttribute).array);
  const indices = geo.getIndex()!.array as Uint16Array | Uint32Array;

  // Morph targets → real-scale Float32 deltas (int16-normalized in the file).
  const dict = mesh.morphTargetDictionary ?? {};
  const morphs = geo.morphAttributes.position as (BufferAttribute | InterleavedBufferAttribute)[];
  const deltas = meta.targets.map(({ name, scale }) => {
    const attr = morphs[dict[name]];
    if (!attr) throw new Error(`mannequin.glb: missing morph target ${name}`);
    const out = new Float32Array(attr.count * 3);
    for (let i = 0; i < attr.count; i++) {
      out[3 * i] = attr.getX(i) * scale;
      out[3 * i + 1] = attr.getY(i) * scale;
      out[3 * i + 2] = attr.getZ(i) * scale;
    }
    return out;
  });
  geo.dispose();
  return new AnnyModel(meta, base, indices, deltas);
}
