"""Checks that public/mannequin/{glb,json} reproduce Anny's rest shape, using the
same slider → morph-weight logic as the browser (lib/avatar/anny.ts)."""
import json, struct
from pathlib import Path
import numpy as np, torch, anny

D = Path(__file__).resolve().parents[2] / "public" / "mannequin"
meta = json.loads((D / "mannequin.json").read_text())

def read_glb(path):
    raw = path.read_bytes()
    jl = struct.unpack_from("<I", raw, 12)[0]
    g = json.loads(raw[20:20 + jl]); binary = raw[20 + jl + 8:]
    def acc(i):
        a = g["accessors"][i]
        dt = {5126: np.float32, 5122: np.int16, 5123: np.uint16, 5125: np.uint32}[a["componentType"]]
        n = {"SCALAR": 1, "VEC3": 3}[a["type"]]
        if "bufferView" in a:
            v = g["bufferViews"][a["bufferView"]]
            out = np.frombuffer(binary, dt, a["count"] * n, v["byteOffset"]).reshape(a["count"], n).astype(np.float64)
        else:
            out = np.zeros((a["count"], n))
        if "sparse" in a:
            s = a["sparse"]; iv = g["bufferViews"][s["indices"]["bufferView"]]; vv = g["bufferViews"][s["values"]["bufferView"]]
            idt = {5123: np.uint16, 5125: np.uint32}[s["indices"]["componentType"]]
            idx = np.frombuffer(binary, idt, s["count"], iv["byteOffset"])
            out[idx] = np.frombuffer(binary, dt, s["count"] * n, vv["byteOffset"]).reshape(-1, n)
        if a.get("normalized"): out = out / 32767.0
        return out
    prim = g["meshes"][0]["primitives"][0]
    return acc(prim["attributes"]["POSITION"]), [acc(t["POSITION"]) for t in prim["targets"]]

base, targets = read_glb(D / "mannequin.glb")

def interp(v, anchors):
    a = np.asarray(anchors); v = min(max(v, a[0]), a[-1])
    i = int(np.clip(np.searchsorted(a, v, side="left"), 1, len(a) - 1))
    t = (v - a[i - 1]) / (a[i] - a[i - 1]); w = np.zeros(len(a)); w[i - 1] = 1 - t; w[i] = t
    return w

def shape(ph, lc):
    col = {}
    for feat, vars_ in meta["variations"].items():
        if feat == "race":
            for k in vars_: col[k] = meta["race"][k]
        else:
            w = interp(ph[feat], meta["anchors"][feat])
            for k, x in zip(vars_, w): col[k] = x
    cols = [col[c] for c in meta["variationColumns"]]
    w = np.array([np.prod([cols[c] for c in row]) for row in meta["macroTargets"]])
    a = np.asarray(meta["pca"]["b"]) + w @ np.asarray(meta["pca"]["W"])
    v = base.copy()
    names = [t["name"] for t in meta["targets"]]
    for r in range(meta["pca"]["rank"]):
        v += targets[r] * meta["targets"][r]["scale"] * a[r]
    for label, x in lc.items():
        i = names.index(f"lc:{label}:{'+' if x >= 0 else '-'}")
        v += targets[i] * meta["targets"][i]["scale"] * abs(x)
    return v

model = anny.Anny(topology="anny-noeyes-notongue", local_changes=meta["localChanges"], phenotypes="all")
rng = np.random.default_rng(1)
for trial in range(5):
    ph = {p["label"]: rng.uniform(p["min"], p["max"]) for p in meta["phenotypes"]}
    lc = {meta["localChanges"][rng.integers(len(meta["localChanges"]))]: rng.uniform(-1, 1)}
    ref = model(phenotype_kwargs={**ph, **meta["race"]}, local_changes_kwargs=lc)["rest_vertices"][0].numpy()
    ref = np.stack([ref[:, 0], ref[:, 2], -ref[:, 1]], 1)
    err = np.linalg.norm(shape(ph, lc) - ref, axis=1)
    print(f"trial {trial}: gender={ph['gender']:.2f} height={np.ptp(ref[:,1]):.3f} m  max err {err.max()*1000:.2f} mm  mean {err.mean()*1000:.3f} mm")
