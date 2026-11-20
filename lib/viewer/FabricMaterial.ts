import * as THREE from "three/webgpu";
import type { Textile } from "../textiles/catalog";
import type { TextileColors } from "../textiles/generate";
import type { TextureRequest, TextureResponse } from "../textiles/textures.worker";

const SIZE = 512;

/**
 * PBR material of the garment. Optical parameters apply immediately; the
 * procedural albedo/normal maps are generated in a worker and swapped in when
 * ready (same textures, new pixels: no shader recompilation).
 */
export class FabricMaterial {
  readonly material: THREE.MeshPhysicalMaterial;
  private readonly albedoCanvas = document.createElement("canvas");
  private readonly normalCanvas = document.createElement("canvas");
  private readonly albedo: THREE.CanvasTexture;
  private readonly normal: THREE.CanvasTexture;
  private readonly worker = new Worker(new URL("../textiles/textures.worker.ts", import.meta.url), { type: "module" });
  private requestId = 0;

  constructor(maxAnisotropy: number) {
    const make = (canvas: HTMLCanvasElement, fill: string, colorSpace: THREE.ColorSpace) => {
      canvas.width = canvas.height = SIZE;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = fill;
      ctx.fillRect(0, 0, SIZE, SIZE);
      const t = new THREE.CanvasTexture(canvas);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.colorSpace = colorSpace;
      t.anisotropy = Math.min(8, maxAnisotropy);
      return t;
    };
    this.albedo = make(this.albedoCanvas, "#ffffff", THREE.SRGBColorSpace);
    this.normal = make(this.normalCanvas, "#8080ff", THREE.NoColorSpace);
    this.material = new THREE.MeshPhysicalMaterial({
      side: THREE.DoubleSide,
      map: this.albedo,
      normalMap: this.normal,
      sheenColor: new THREE.Color("#ffffff"),
    });
    this.worker.onmessage = (e: MessageEvent<TextureResponse>) => {
      if (e.data.id !== this.requestId) return;
      this.albedoCanvas.getContext("2d")!.putImageData(new ImageData(e.data.albedo, SIZE, SIZE), 0, 0);
      this.normalCanvas.getContext("2d")!.putImageData(new ImageData(e.data.normal, SIZE, SIZE), 0, 0);
      this.albedo.needsUpdate = true;
      this.normal.needsUpdate = true;
    };
  }

  /** Applies a textile, its colours and a pattern scale multiplier. */
  set(textile: Textile, colors: TextileColors, scale = 1) {
    const m = this.material;
    m.roughness = textile.roughness;
    m.sheen = textile.sheen;
    m.sheenRoughness = textile.sheenRoughness;
    m.sheenColor.set(colors.primary).lerp(new THREE.Color("#ffffff"), 0.45);
    m.normalScale.set(textile.normalStrength, textile.normalStrength);
    const repeat = 1 / (textile.tile * scale);
    this.albedo.repeat.set(repeat, repeat);
    this.normal.repeat.set(repeat, repeat);
    this.worker.postMessage({ id: ++this.requestId, textile, colors, size: SIZE } satisfies TextureRequest);
  }

  dispose() {
    this.worker.terminate();
    this.albedo.dispose();
    this.normal.dispose();
    this.material.dispose();
  }
}
