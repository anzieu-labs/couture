# Feuille de route — Couture (atelier 3D)

Référence pour les prochaines étapes. Mettre à jour les cases et les notes à chaque étape livrée.

## État actuel

- **Mannequin** : Anny (NAVER LABS Europe, Apache 2.0, MakeHuman CC0) exporté en GLB + JSON
  (`tools/mannequin/`), morphologie homme ↔ femme, mensurations lisibles et modifiables (stature,
  poitrine, taille, hanches), 18 ajustements de couture.
- **Patron** : t‑shirt col rond tracé depuis les mesures du corps (`lib/pattern/tshirt.ts`), 4 pièces,
  coutures appariées, maillage Delaunay contraint (Delaunator + Constrainautor). Pièces à couper avec
  marges, crans et repères ; export PDF A4 tuilé, SVG 1:1, DXF AAMA.
- **Simulation** : XPBD (étirement anisotrope, flexion isométrique de Bergou,
  couture progressive, contact SDF avec le corps, auto-collision sommet ↔ triangle). GPU (WebGPU compute, sur le device du rendu,
  coque épaisse calculée sur le GPU, sans relecture) ou CPU en repli (worker).
- **Tissus** : 10 textiles procéduraux avec propriétés physiques (grammage, rigidité en flexion,
  élasticité chaîne/trame, épaisseur, frottement).
- **Pose et mouvement** : squelette d'Anny réduit à 27 articulations (skinning LBS), écartement des
  bras réglable, marche sur place (vitesse réglable) et tour complet ; le tissu suit (collision en
  espace repos).

## 1. Rendre l'outil utile à quelqu'un qui coud

- [x] **Carte de tension** (fit map) : boutons « Tissu / Tension / Étirement » dans la vue 3D.
  Tension (N/m) = allongement chaîne / trame × module du tissu ; étirement (%) = allongement
  principal max. Calcul sur GPU (avec le noyau des normales) ou CPU, lissé une fois.
  *Limite* : pour les tissés raides (denim, lin), un résidu numérique d'étirement (~0,5–1 %)
  multiplié par leur module élevé surestime la tension ; fiable pour les mailles.
- [x] **Marges de couture et repères** (`lib/pattern/markings.ts`, onglet Patron « Marges et export ») :
  marges réglables (coutures et encolure 1 cm, ourlets 2,5 cm par défaut) ajoutées hors du patron net
  (= le patron simulé, inchangé). Coins en onglet ; coins d'ourlet **en miroir** (la marge de côté est
  symétrisée autour de la ligne de pli de l'ourlet : une fois l'ourlet remonté, il épouse la pièce,
  évasé sous une manche qui se resserre). Boucles du décalage retirées là où le rayon de courbure est
  plus petit que la marge (encolure dos près de l'épaule). Crans posés à la même fraction de longueur
  des deux côtés d'une couture (même appariement que le maillage) : simple au devant d'emmanchure, double
  au dos, haut de tête de manche, milieux devant / dos. Droit-fil, nom, quantité à couper, marges
  incluses. Option « au pli » : devant et dos en demi-pièces (ni coupe ni couture tracées le long du pli).
- [x] **Export du patron** (`lib/pattern/export/`, sans dépendance) :
  - PDF tuilé A4 (vectoriel, Helvetica standard) : page de garde avec plan d'assemblage, consignes et
    carré test de 10 cm ; tuiles avec cadre, losanges d'alignement, nom de page et voisines ; pages
    vides omises. Mise en page cherchée pour le minimum de pages (largeur en tuiles × pièces tournées
    d'un quart de tour, rangement par étagères) : 14 pages + garde au pli, 20 + garde en pièces entières
    (mesures moyennes).
  - SVG d'une seule planche à l'échelle 1 (unités en cm), carré test inclus.
  - DXF AAMA (R12 ASCII, mm) : un BLOCK par pièce entière, calques 1 contour de coupe + textes
    (`Piece Name`, `Quantity`…), 2 points d'angle, 3 points de courbe, 4 crans (segments), 7 droit-fil,
    14 ligne de couture. Validé par ezdxf (lecture stricte, audit sans erreur) ; pas encore essayé dans
    CLO / Gerber. *À faire* : variante ASTM D6673 (crans en POINT + angle, calques 80+), demi-pièces
    avec ligne miroir (calque 6).

## 2. Cœur de l'outil de conception

- [ ] **Éditeur de patron 2D interactif** : déplacer les points, modifier les courbes (encolure,
  emmanchure), recouture automatique en 3D.
- [ ] **Variantes du t‑shirt** : col V, manches longues, oversize / cintré.
- [ ] **Finitions des bords libres** (choix par bord, au design) : ourlet replié, bord-côte cousu, biais,
  parementure. Aujourd'hui tous les bords sont francs. Un premier essai d'ourlet automatique sur tous les bords
  (masse ×2, flexion ×4, épaisseur ×3) a été retiré : voir l'historique git.

## 3. Réalisme de la simulation

- [x] **Auto-collision** du tissu (`lib/sim/selfCollision.ts`, `lib/sim/untangle.ts`, noyaux
  `self*WGSL`), distance minimale entre couches = épaisseur + 2 mm :
  - **sommet ↔ triangle** (× ½, l'autre couche fait l'autre moitié) et **arête ↔ arête** (points
    les plus proches, correction répartie PBD sur les 4 extrémités) — l'arête ↔ arête attrape les
    couches qui se croisent en biais et les coutures repliées à plat, où aucun sommet ne tombe dans
    un triangle. Corrections moyennées par sommet (Jacobi) ;
  - côté mémorisé à la passe précédente (un élément qui a traversé est renvoyé de son côté) ;
  - hachage spatial par tri par comptage (compte, préfixe sur un groupe de travail, remplissage),
    sans limite de capacité par case ; triangles et arêtes dans deux grilles. L'arête ↔ arête,
    coûteuse (~300 candidates par arête), ne porte que sur les arêtes proches d'une autre couche
    (marquées par le passage sommet ↔ triangle) et seules celles-ci sont hachées : sans ce tri, la
    marche tombait à ~27 i/s ; avec, 120 i/s ;
  - **démêlage** (analyse globale des intersections, Baraff et al. 2003) toutes les 0,2 s simulées :
    arêtes qui traversent un triangle coupées, le vêtement découpé le long ; une petite île
    (contour fermé) est du mauvais côté → côté imposé par une direction de correction, elle est
    repoussée à travers ; contour ouvert (bord libre, couture repliée) → sommets « libérés »
    (aucun côté imposé) jusqu'à la prochaine analyse, l'élasticité les démêle. Sur GPU, positions
    relues de façon asynchrone et analyse dans le worker ;
  - une passe tous les 2 sous-pas (GPU), 5 (CPU) ; démarre 0,4 s après la couture (`SELF_DELAY`,
    filet de sécurité : le démêlage défait aussi un croisement figé dès la fin de la couture).
  Mesures (croisements arête ↔ triangle en moyenne, maillage et réglages GPU) : marche bras à 20°
  106 sans auto-collision → 4,8 sommet ↔ triangle seul → 0 avec arête ↔ arête et démêlage ; bras à
  15° 206 → 66 → 0 ; tour bras à 15° 97 → 76 → 0. Nappes emmêlées sur un disque de 3 cm : figées
  sans démêlage (76 croisements), démêlées en 20 passes avec.
  *Limites* : bras sous 20° (épaule écrasée par le skinning : c'est la peau qui pince la manche) ; une île plus grande que 15 % du
  vêtement n'est pas retournée (heuristique de Baraff : la petite région est la fautive) ; pour
  plusieurs vêtements, il faudra ordonner les couches (côté imposé entre vêtements).
- [x] **Animation du mannequin** (onglet « Pose » + boutons Marche / Tour) : écartement des bras
  (20–70°), marche sur place en boucle (60–150 pas/min, foulée proportionnelle), un tour complet sur
  le socle. Le vêtement est toujours cousu dans la pose de repos (bras en A) ; la pose choisie
  s'applique après la couture (`MOTION_DELAY`). Collision « en espace repos » : chaque sommet du
  tissu est ramené dans la pose de repos par l'inverse de la transformation mélangée (poids de la
  grille d'influences dérivée du SDF), testé contre le SDF de repos puis reposé ; frottement relatif
  à la peau. Deux itérations de point fixe + test de cohérence (|M₁·q₀ − p| < 5 mm) : là où le
  bras libère l'espace qu'il occupait au repos (bras levés), l'antécédent est ambigu (dans le torse
  avec les poids du bras, dans le bras de repos avec ceux du torse) ; sans ce test le tissu y était
  expulsé le long du bras et tout le t-shirt remontait. Écart corps de collision / peau rendue :
  p99 0,3 mm. Aucune pénétration mesurée
  (jersey, denim) contre un SDF indépendant du corps posé.
  Marche pilotée par les pieds (comme sur un tapis roulant) : en appui le pied est au sol et recule
  à vitesse constante (talon, pied à plat, pointe), en oscillation il revient sur un arc ; IK à deux
  segments hanche-genou, inclinaison du pied à la cheville, bassin abaissé au double appui juste
  assez pour que la jambe avant touche le sol (oscillation verticale ~3 cm). Les deux pieds touchent
  donc le sol ensemble quelle que soit la morphologie (±3 mm) ; des courbes d'angles imposées
  faisaient flotter un pied et enfoncer l'autre, et le corps sautillait de l'un à l'autre.
  *Limites* : marche sur place (le pied d'appui glisse comme sur un tapis), écartement des bras
  limité à 20° (en dessous, le skinning écrase le dessus de l'épaule et pince la manche), solveur
  CPU ~3× plus lent quand le corps bouge (la marche passe au ralenti si le processeur ne suit pas).
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
- Animation : `lib/avatar/skeleton.ts` (cinématique directe, rotations en axes du monde au repos
  autour des têtes d'os : valable pour toute morphologie), `lib/avatar/motion.ts` (`Animator`,
  fonction pure du temps, rejouée à l'identique par le worker), `lib/sim/posedBody.ts` (collision en
  espace repos, mêmes formules que le noyau `contactsWGSL`). En mode GPU l'horloge d'animation suit
  le temps simulé (temps réel pendant un mouvement, avance rapide sinon) ; en mode CPU le worker
  possède la chronologie et envoie la pose avec chaque image.
- Après un nouvel export du mannequin, la grille d'influences (`BodySdf.skin`) dépend des attributs
  `JOINTS_0` / `WEIGHTS_0` du GLB et de `bones.parents` du JSON.
