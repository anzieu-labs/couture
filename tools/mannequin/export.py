"""
Export a parametric adult mannequin from Anny (NAVER LABS Europe, Apache-2.0;
MakeHuman/MPFB2 assets, CC0) to a static GLB + JSON usable in the browser.

    tools/mannequin/.venv/bin/python tools/mannequin/export.py

Outputs (in public/mannequin/):
  - mannequin.glb  : rest-pose mesh (mean adult) + morph targets
                     * pca00..pcaNN  : PCA basis of all adult phenotypes
                     * lc:<label>:+/- : selected local changes (sewing measurements)
                     Morph deltas are int16-normalized (KHR_mesh_quantization); each
                     target's real magnitude is restored with its `scale` from the JSON.
  - mannequin.json : everything needed to turn slider values into morph weights,
                     plus key skeleton joints for each morph.

How the phenotype sliders work (ported to JS in lib/avatar/anny.ts):
  1. Each MakeHuman macro target is a product of "variations" (e.g. female ×
     young × maxmuscle × averageweight). Its weight is the product of the 1-D
     linear interpolation coefficients of the corresponding sliders.
  2. The rest shape is linear in those macro weights `w`, so the PCA coefficients
     are an affine function of them: a = w @ W + b (exact, computed here).
"""

from __future__ import annotations

import json
import struct
from pathlib import Path

import numpy as np
import torch

import anny
from anny.models.model_data import PHENOTYPE_VARIATIONS
from anny.models.phenotype import phenotype_blendshape_weights

ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT / "public" / "mannequin"

# --- Configuration -----------------------------------------------------------

PCA_RANK = 48
N_SAMPLES = 4000
SEED = 0

# Adult range of Anny's `age` parameter (calibration anchors: 0.77 = 18 y, 0.83 = 64 y).
AGE_RANGE = (0.77, 0.9)

# Slider definitions exposed to the UI: (label, min, max, default).
PHENOTYPES = [
    ("gender", 0.0, 1.0, 0.0),
    ("age", AGE_RANGE[0], AGE_RANGE[1], 0.8),
    ("muscle", 0.0, 1.0, 0.5),
    ("weight", 0.0, 1.0, 0.5),
    ("height", 0.0, 1.0, 0.5),
    ("proportions", 0.0, 1.0, 0.5),
    ("cupsize", 0.0, 1.0, 0.5),
    ("firmness", 0.0, 1.0, 0.5),
]
RACE = {"african": 1 / 3, "asian": 1 / 3, "caucasian": 1 / 3}  # neutral average, not exposed

# Local changes relevant to garment making (value in [-1, 1]).
LOCAL_CHANGES = [
    "measure-shoulder-dist-incr",
    "measure-bust-circ-incr",
    "measure-underbust-circ-incr",
    "measure-waist-circ-incr",
    "measure-hips-circ-incr",
    "measure-napetowaist-dist-incr",
    "measure-waisttohip-dist-incr",
    "measure-frontchest-dist-incr",
    "measure-neck-circ-incr",
    "measure-upperarm-circ-incr",
    "measure-upperarm-length-incr",
    "measure-lowerarm-length-incr",
    "measure-thigh-circ-incr",
    "measure-upperleg-height-incr",
    "measure-lowerleg-height-incr",
    "torso-vshape-incr",
    "buttocks-volume-incr",
    "stomach-pregnant-incr",
]

# Skeleton joints exported as landmarks (garment placement, measurement bands) and as
# the animation rig: the skin weights of every other bone (fingers, toes, twist bones,
# eyes…) are merged into its closest ancestor in this list.
KEY_BONES = [
    "root", "pelvis.L", "pelvis.R", "upperleg01.L", "upperleg01.R",
    "lowerleg01.L", "lowerleg01.R", "foot.L", "foot.R",
    "spine05", "spine04", "spine03", "spine02", "spine01",
    "clavicle.L", "clavicle.R", "shoulder01.L", "shoulder01.R",
    "upperarm01.L", "upperarm01.R", "lowerarm01.L", "lowerarm01.R",
    "wrist.L", "wrist.R", "neck01", "neck03", "head",
]

# Skin influences kept per vertex (glTF JOINTS_0 / WEIGHTS_0).
SKIN_INFLUENCES = 4

# Anny frame: Z up, front = -Y (Blender). glTF frame: Y up, front = +Z.
def to_gltf(p: np.ndarray) -> np.ndarray:
    return np.stack([p[..., 0], p[..., 2], -p[..., 1]], axis=-1)


# --- Model -------------------------------------------------------------------

def main() -> None:
    torch.manual_seed(SEED)
    dt = torch.float64
    print("Loading Anny…")
    model = anny.Anny(
        topology="anny-noeyes-notongue",
        local_changes=LOCAL_CHANGES,
        phenotypes="all",
    )
    labels = model.phenotype_labels  # all 11 (8 sliders + 3 race)
    proj = model.phenotype_blendshape_projection  # (624, Kc)
    kc = proj.shape[1]
    mask = model.stacked_phenotype_blend_shapes_mask  # (624, 26)
    B = model.blendshapes  # (Kc + 2*nLC, V, 3)
    nv = B.shape[1]
    assert B.shape[0] == kc + 2 * len(LOCAL_CHANGES), B.shape
    lc_labels = list(model.local_change_labels)  # Anny's own order
    assert sorted(lc_labels) == sorted(LOCAL_CHANGES), lc_labels
    template = model.template_vertices  # (V, 3)
    bone_idx = [model.bone_labels.index(b) for b in KEY_BONES]
    Bb = model.bone_heads_blendshapes[:, bone_idx]  # (K, nb, 3)
    bone_template = model.template_bone_heads[bone_idx]
    anchors = {k: model.anchors[k] for k in [p[0] for p in PHENOTYPES]}
    key_parents, skin_index, skin_weight = skin_rig(model)

    def macro_weights(params: torch.Tensor) -> torch.Tensor:
        return phenotype_blendshape_weights(
            params, labels, model.anchors, mask, extrapolate=False
        )

    # --- Rows (macro targets) that can be non-zero for adults ---------------
    columns = [v for vs in PHENOTYPE_VARIATIONS.values() for v in vs]
    age_cols = [columns.index(a) for a in PHENOTYPE_VARIATIONS["age"]]
    adult_cols = {columns.index("young"), columns.index("old")}
    keep = [
        r for r in range(mask.shape[0])
        if all(c in adult_cols for c in age_cols if mask[r, c] > 0)
    ]
    print(f"{len(keep)}/{mask.shape[0]} macro targets reachable by adults")

    # --- Sample adult phenotypes (random + all box corners) ------------------
    def sample(n: int) -> torch.Tensor:
        cols = []
        for label in labels:
            if label in RACE:
                cols.append(torch.full((n,), RACE[label], dtype=dt))
            else:
                lo, hi = next((p[1], p[2]) for p in PHENOTYPES if p[0] == label)
                cols.append(lo + (hi - lo) * torch.rand(n, dtype=dt))
        return torch.stack(cols, 1)

    params = sample(N_SAMPLES)
    slider_idx = [labels.index(p[0]) for p in PHENOTYPES]
    corners = torch.cartesian_prod(*[torch.tensor([p[1], p[2]], dtype=dt) for p in PHENOTYPES])
    corner_params = sample(len(corners))
    corner_params[:, slider_idx] = corners
    params = torch.cat([params, corner_params])

    with torch.no_grad():
        w = macro_weights(params)  # (N, 624)
        c = w @ proj  # (N, Kc)
        Bc = B[:kc].reshape(kc, -1)  # (Kc, 3V)
        V = template.reshape(1, -1) + c @ Bc  # (N, 3V)

        # Sanity check against the full model.
        ref = model(phenotype_kwargs=params[:4])["rest_vertices"].reshape(4, -1)
        assert torch.allclose(ref, V[:4], atol=1e-8), "rest shape mismatch"

        # --- PCA ------------------------------------------------------------
        mean = V.mean(0)
        _, S, Vh = torch.linalg.svd(V - mean, full_matrices=False)
        basis = Vh[:PCA_RANK]  # (R, 3V), orthonormal
        rec = ((V - mean) @ basis.T) @ basis
        err = (rec - (V - mean)).reshape(len(V), nv, 3).norm(dim=-1)
        print(
            f"PCA rank {PCA_RANK}: max error {err.max() * 1000:.2f} mm, "
            f"p99 {err.flatten().quantile(0.99) * 1000:.3f} mm"
        )

        # a = ((template - mean) + (w @ proj) @ Bc) @ basis.T  (affine in w)
        W_mesh = proj @ (Bc @ basis.T)  # (624, R)
        b_mesh = (template.reshape(-1) - mean) @ basis.T  # (R,)

        # Skeleton joints: exact affine map from w, plus per local-change deltas.
        Bbc = Bb[:kc].reshape(kc, -1)
        W_bone = proj @ Bbc  # (624, nb*3)
        b_bone = bone_template.reshape(-1)

        # Morph deltas (glTF frame).
        pca_deltas = to_gltf(basis.reshape(PCA_RANK, nv, 3).numpy())
        lc_deltas = to_gltf(B[kc:].numpy())  # (2*nLC, V, 3): [+ , -] per label
        lc_bone_deltas = Bb[kc:].numpy()  # anny frame, converted below

    # --- Assemble targets ------------------------------------------------------
    targets = []  # (name, deltas (V,3) float64)
    for r in range(PCA_RANK):
        targets.append((f"pca{r:02d}", pca_deltas[r]))
    for i, label in enumerate(lc_labels):
        targets.append((f"lc:{label}:+", lc_deltas[2 * i]))
        targets.append((f"lc:{label}:-", lc_deltas[2 * i + 1]))

    base = to_gltf(mean.reshape(nv, 3).numpy())
    faces = model.faces.numpy().astype(np.uint16 if nv < 65536 else np.uint32)

    # --- GLB -------------------------------------------------------------------
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    scales = write_glb(OUT_DIR / "mannequin.glb", base, faces, targets, skin_index, skin_weight)

    def bones_to_gltf(flat: np.ndarray) -> list:
        return np.round(to_gltf(flat.reshape(-1, len(KEY_BONES), 3)), 6).reshape(flat.shape[0], -1).tolist()

    meta = {
        "source": "Anny 0.6.2 (NAVER LABS Europe, Apache-2.0) — MakeHuman/MPFB2 assets (CC0 1.0)",
        "units": "meters, Y up, front +Z (rest pose: arms slightly abducted)",
        "vertexCount": nv,
        "phenotypes": [
            {"label": l, "min": lo, "max": hi, "default": d} for (l, lo, hi, d) in PHENOTYPES
        ],
        "race": RACE,
        "anchors": {k: [round(float(x), 9) for x in v] for k, v in anchors.items()},
        "variations": {k: list(v) for k, v in PHENOTYPE_VARIATIONS.items()},
        "variationColumns": columns,
        "macroTargets": [
            [int(c_) for c_ in torch.nonzero(mask[r]).flatten().tolist()] for r in keep
        ],
        "pca": {
            "rank": PCA_RANK,
            # a_r = (b_r + Σ_rows w_row * W[row][r]) ; morph weight = a_r / scale_r
            "W": np.round(W_mesh[keep].numpy(), 7).tolist(),
            "b": np.round(b_mesh.numpy(), 7).tolist(),
        },
        "localChanges": lc_labels,
        "targets": [{"name": n, "scale": s} for (n, _), s in zip(targets, scales)],
        "bones": {
            "labels": KEY_BONES,
            # Index of each joint's parent in `labels` (-1: root); skin weights in the GLB.
            "parents": key_parents,
            "base": np.round(to_gltf(b_bone.numpy().reshape(-1, 3)), 6).reshape(-1).tolist(),
            "W": bones_to_gltf(W_bone[keep].numpy()),
            "localChanges": bones_to_gltf(lc_bone_deltas.reshape(len(lc_bone_deltas), -1)),
        },
    }
    (OUT_DIR / "mannequin.json").write_text(json.dumps(meta, separators=(",", ":")))
    for f in ("mannequin.glb", "mannequin.json"):
        print(f"{f}: {(OUT_DIR / f).stat().st_size / 1e6:.2f} MB")


# --- Skinning rig ------------------------------------------------------------------

def skin_rig(model) -> tuple[list[int], np.ndarray, np.ndarray]:
    """
    Reduces Anny's skeleton to KEY_BONES: each bone maps to its closest ancestor in
    the list (itself if listed), and its skin weights are summed there. Keeps the
    SKIN_INFLUENCES largest weights per vertex, quantized to bytes summing to 255.
    Returns the parent of each key bone (index in KEY_BONES), joint indices and weights.
    """
    labels, parents = model.bone_labels, model.bone_parents

    def key_ancestor(b: int) -> int:
        while labels[b] not in KEY_BONES:
            b = parents[b]
        return KEY_BONES.index(labels[b])

    to_key = np.array([key_ancestor(b) for b in range(len(labels))])
    key_parents = [-1 if parents[labels.index(k)] < 0 else key_ancestor(parents[labels.index(k)]) for k in KEY_BONES]

    w = model.vertex_bone_weights.numpy()
    idx = model.vertex_bone_indices.numpy()
    nv = w.shape[0]
    dense = np.zeros((nv, len(KEY_BONES)))
    np.add.at(dense, (np.repeat(np.arange(nv), w.shape[1]), to_key[idx].reshape(-1)), w.reshape(-1))
    top = np.argsort(-dense, axis=1)[:, :SKIN_INFLUENCES]
    tw = np.take_along_axis(dense, top, 1)
    tw /= tw.sum(1, keepdims=True)
    q = np.floor(tw * 255 + 0.5).astype(np.int32)
    q[:, 0] += 255 - q.sum(1)  # exact sum on the largest weight
    top[q == 0] = 0
    print(f"skin: {(dense > 0).sum(1).max()} influences max → {SKIN_INFLUENCES}, "
          f"weight dropped ≤ {(1 - np.sort(dense, 1)[:, ::-1][:, :SKIN_INFLUENCES].sum(1)).max():.3f}")
    return key_parents, top.astype(np.uint8), q.astype(np.uint8)


# --- Minimal GLB writer --------------------------------------------------------

def write_glb(path: Path, positions: np.ndarray, faces: np.ndarray, targets,
              skin_index: np.ndarray, skin_weight: np.ndarray) -> list[float]:
    """
    Writes one mesh with int16-normalized morph targets and per-vertex skin
    influences (JOINTS_0 / WEIGHTS_0, no glTF skin: the rig is in the JSON).
    Returns each target's scale.
    """
    chunks: list[bytes] = []
    views, accessors = [], []
    offset = 0

    def add_view(data: bytes, target: int | None = None) -> int:
        nonlocal offset
        pad = (-len(data)) % 4
        view = {"buffer": 0, "byteOffset": offset, "byteLength": len(data)}
        if target is not None:
            view["target"] = target
        views.append(view)
        chunks.append(data + b"\0" * pad)
        offset += len(data) + pad
        return len(views) - 1

    def add_accessor(**kw) -> int:
        accessors.append(kw)
        return len(accessors) - 1

    pos = positions.astype(np.float32)
    pos_acc = add_accessor(
        bufferView=add_view(pos.tobytes(), 34962), componentType=5126, count=len(pos),
        type="VEC3", min=pos.min(0).tolist(), max=pos.max(0).tolist(),
    )
    joints_acc = add_accessor(
        bufferView=add_view(skin_index.tobytes(), 34962), componentType=5121,
        count=len(skin_index), type="VEC4",
    )
    weights_acc = add_accessor(
        bufferView=add_view(skin_weight.tobytes(), 34962), componentType=5121,
        normalized=True, count=len(skin_weight), type="VEC4",
    )
    idx_type = 5123 if faces.dtype == np.uint16 else 5125
    idx_acc = add_accessor(
        bufferView=add_view(faces.reshape(-1).tobytes(), 34963),
        componentType=idx_type, count=faces.size, type="SCALAR",
    )

    gltf_targets, names, scales = [], [], []
    for name, d in targets:
        scale = float(np.abs(d).max()) or 1.0
        q = np.round(d / scale * 32767).astype(np.int16)
        deq = q.astype(np.float32) / 32767
        nz = np.nonzero(np.any(q != 0, axis=1))[0]
        common = dict(componentType=5122, normalized=True, count=len(d), type="VEC3",
                      min=deq.min(0).tolist(), max=deq.max(0).tolist())
        if len(nz) < 0.6 * len(d):  # sparse accessor for localized targets
            sparse_idx = nz.astype(np.uint16 if len(d) < 65536 else np.uint32)
            acc = add_accessor(
                **common,
                sparse={
                    "count": int(len(nz)),
                    "indices": {"bufferView": add_view(sparse_idx.tobytes()),
                                "componentType": 5123 if sparse_idx.dtype == np.uint16 else 5125},
                    "values": {"bufferView": add_view(q[nz].tobytes())},
                },
            )
        else:
            acc = add_accessor(bufferView=add_view(q.tobytes(), 34962), **common)
        gltf_targets.append({"POSITION": acc})
        names.append(name)
        scales.append(scale)

    gltf = {
        "asset": {"version": "2.0", "generator": "couture/tools/mannequin/export.py"},
        "extensionsUsed": ["KHR_mesh_quantization"],
        "extensionsRequired": ["KHR_mesh_quantization"],
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"name": "mannequin", "mesh": 0}],
        "meshes": [{
            "name": "mannequin",
            "primitives": [{"attributes": {"POSITION": pos_acc, "JOINTS_0": joints_acc, "WEIGHTS_0": weights_acc},
                            "indices": idx_acc,
                            "targets": gltf_targets}],
            "weights": [0.0] * len(gltf_targets),
            "extras": {"targetNames": names},
        }],
        "buffers": [{"byteLength": offset}],
        "bufferViews": views,
        "accessors": accessors,
    }
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * ((-len(js)) % 4)
    binary = b"".join(chunks)
    total = 12 + 8 + len(js) + 8 + len(binary)
    with open(path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, total))
        f.write(struct.pack("<II", len(js), 0x4E4F534A) + js)
        f.write(struct.pack("<II", len(binary), 0x004E4942) + binary)
    return scales


if __name__ == "__main__":
    main()
