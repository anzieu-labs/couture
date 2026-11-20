# Feuille de route — Couture (atelier 3D)

Référence pour les prochaines étapes. Mettre à jour les cases et les notes à chaque étape livrée.

## État actuel

- **Mannequin** : Anny (NAVER LABS Europe, Apache 2.0, MakeHuman CC0) exporté en GLB + JSON
  (`tools/mannequin/`), morphologie homme ↔ femme, mensurations lisibles et modifiables (stature,
  poitrine, taille, hanches), 18 ajustements de couture.
- **Patron** : t‑shirt col rond tracé depuis les mesures du corps (`lib/pattern/tshirt.ts`), 4 pièces,
  coutures appariées, maillage Delaunay contraint (Delaunator + Constrainautor).
- **Simulation** : XPBD (étirement anisotrope, flexion isométrique de Bergou, ourlets doublés,
  couture progressive, contact SDF avec le corps). GPU (WebGPU compute, sur le device du rendu,
  coque épaisse calculée sur le GPU, sans relecture) ou CPU en repli (worker).
- **Tissus** : 10 textiles procéduraux avec propriétés physiques (grammage, rigidité en flexion,
  élasticité chaîne/trame, épaisseur, frottement).

## 1. Rendre l'outil utile à quelqu'un qui coud

- [x] **Carte de tension** (fit map) : boutons « Tissu / Tension / Étirement » dans la vue 3D.
  Tension (N/m) = allongement chaîne / trame × module du tissu ; étirement (%) = allongement
  principal max. Calcul sur GPU (avec le noyau des normales) ou CPU, lissé une fois.
  *Limite* : pour les tissés raides (denim, lin), un résidu numérique d'étirement (~0,5–1 %)
  multiplié par leur module élevé surestime la tension ; fiable pour les mailles.
- [ ] **Marges de couture et repères** sur le patron : crans d'assemblage, droit-fil, nom des pièces.
- [ ] **Export du patron** : SVG / PDF à l'échelle 1 (tuilé A4 imprimable), puis DXF AAMA/ASTM
  (interopérable CLO, Gerber…).

## 2. Cœur de l'outil de conception

- [ ] **Éditeur de patron 2D interactif** : déplacer les points, modifier les courbes (encolure,
  emmanchure), recouture automatique en 3D.
- [ ] **Variantes du t‑shirt** : col V, manches longues, oversize / cintré.
- [ ] **Bord-côte d'encolure** : vraie pièce cousue (aujourd'hui une simple bande renforcée).

## 3. Réalisme de la simulation

- [ ] **Auto-collision** du tissu (hachage spatial sur GPU) — prérequis aux vêtements multicouches
  et aux plis profonds.
- [ ] **Animation du mannequin** (marche, rotation) via le squelette d'Anny.
- [ ] Arrêt de la simulation au repos réellement efficace (mesure du mouvement plus fréquente).
- [ ] Rigidité réelle des tissés : l'étirement résiduel décroît en h² (10 sous-pas : 7,5 %,
  20 : 2,7 %, 40 : 1 % en haut du devant, denim). Pistes : plus d'itérations d'étirement,
  multigrille, ou forces de contrainte (λ) pour la carte de tension.

## 4. Autres vêtements

- [ ] Jupe.
- [ ] Pantalon (entrejambe, jambes).

## 5. Socle technique

- [ ] Tests automatisés des parties de calcul (mesures, tracé du patron, maillage, solveur CPU).
- [ ] Mise en ligne en site statique (Vercel ou serveur Coolify).
- [ ] Sauvegarde / partage d'un modèle (morphologie + patron + tissu) par lien.

## Repères techniques

- Rendu : Three.js `WebGPURenderer` (repli WebGL 2). Les buffers GPU des attributs de la coque sont
  créés via `renderer.backend` (API interne : à revérifier à chaque mise à jour de three).
- Le worker (`lib/garment/sim.worker.ts`) fait le travail CPU lourd ; en mode GPU il n'envoie que le
  modèle de contraintes, la simulation tourne sur le thread principal (`GarmentViewer.stepGpuGarment`).
- Les solveurs CPU (`lib/sim/cloth.ts`) et GPU (`lib/sim/gpu/`) partagent `lib/sim/model.ts` :
  toute modification physique doit être faite dans les deux.
- Pas de SMPL / SMPL‑X dans le dépôt (licences non commerciales).
- Simulation : 20 sous-pas sur GPU, 10 en repli CPU. Placement initial sans étirement (ellipse
  dimensionnée sur le patron, longueurs conservées) et frottement de Coulomb proportionnel à la
  poussée de contact : sinon le tissu reste étiré artificiellement.
- Essai abandonné : attaches longue portée (LRA) à sens unique vers les épaules — elles injectent
  une force non compensée et font décoller les tissus lourds (grosse maille). À ne pas reprendre
  sans version symétrique (atomiques sur GPU).
- Placement des manches : tube qui suit le bras épaule → coude → poignet (repère qui tourne au
  coude). Un cylindre droit faisait traverser la manche par l'avant-bras (manches longues).
- Le champ de distance du corps a une vraie distance à l'intérieur (transformée de distance), pour
  qu'un point enfoncé soit toujours repoussé vers l'extérieur.
