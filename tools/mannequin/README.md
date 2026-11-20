# Mannequin paramétrique (export Anny → GLB)

Génère `public/mannequin/mannequin.glb` et `public/mannequin/mannequin.json` à partir
d'[Anny](https://github.com/naver/anny) (NAVER LABS Europe, Apache 2.0), modèle de corps
paramétrique construit sur les ressources MakeHuman/MPFB2 (CC0 1.0).

Python ne sert qu'ici, hors ligne : l'application web charge les deux fichiers statiques.

```sh
/opt/homebrew/bin/python3.12 -m venv tools/mannequin/.venv
tools/mannequin/.venv/bin/pip install -r tools/mannequin/requirements.txt
tools/mannequin/.venv/bin/python tools/mannequin/export.py   # ~1 min
tools/mannequin/.venv/bin/python tools/mannequin/verify.py   # compare au modèle Anny
```

N'installez pas l'extra `anny[smpl]` : les topologies SMPL/SMPL-X sont non commerciales.

## Contenu de l'export

- **48 déformations ACP** couvrant toutes les morphologies adultes (sexe, âge 18–83 ans,
  musculature, corpulence, taille, proportions, poitrine, fermeté). Erreur moyenne
  < 0,1 mm, maximale ≈ 5 mm aux extrêmes.
- **18 ajustements locaux** (carrure, tours de poitrine / taille / hanches, longueurs…),
  en version + et −.
- Le JSON contient la formule curseurs → poids (portée en TypeScript dans
  `lib/avatar/anny.ts`) et 27 articulations clés pour chaque déformation.

Les déformations sont quantifiées en int16 (`KHR_mesh_quantization`) ; la magnitude réelle
de chaque cible est `scale` dans le JSON.

Pour changer le contenu (rang de l'ACP, ajustements locaux, articulations), modifiez les
constantes en tête de `export.py` et relancez l'export.
