# Feuille de route — Couture (atelier 3D)

Référence pour les prochaines étapes. Mettre à jour les cases et les notes à chaque étape livrée.

## État actuel

- **Mannequin** : Anny (NAVER LABS Europe, Apache 2.0, MakeHuman CC0) exporté en GLB + JSON
  (`tools/mannequin/`), morphologie homme ↔ femme, mensurations lisibles et modifiables (stature,
  poitrine, taille, hanches), 18 ajustements de couture.
- **Patrons** : t‑shirt col rond, cape à capuche, jupe trapèze, tracés depuis les mesures du corps
  (`lib/pattern/`). T-shirt (`tshirt.ts`) : 4 pièces,
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

- [x] **Éditeur de patron 2D interactif** (`components/PatternEditor.tsx`, bouton « Éditer le patron
  en 2D » de l'onglet Patron ; à gauche de la 3D sur grand écran, par-dessus sur mobile) :
  - le tracé reste paramétrique : une modification est le **déplacement d'un point nommé** par
    rapport à sa position tracée (`PatternEdits`, `lib/pattern/tshirt.ts`), elle survit donc à un
    changement de morphologie ou de coupe. Points d'ancrage (encolure-épaule, milieu d'encolure, point
    d'épaule, dessous de bras, côté-bas, milieu bas ; haut de tête, dessous de bras et bas de manche)
    et poignées de Bézier (encolure, emmanchure, tête de manche) qui suivent leur ancrage. Pièces
    symétriques : on édite la moitié droite, l'autre est son miroir ; les points du milieu ne bougent
    que verticalement, les poignées voisines qu'horizontalement (courbe lisse au milieu) ;
  - la tête de manche se recale sur l'emmanchure modifiée (hauteur résolue sur la longueur), les
    modifications propres à la manche s'appliquent ensuite ;
  - glisser (Maj : un seul axe, pas de 1 mm), flèches 1 mm / Maj 1 cm, double-clic ou Suppr : rétablir
    le point, annuler / rétablir (⌘Z / ⇧⌘Z, 100 pas), molette : zoom, glisser le fond : déplacer ;
  - longueurs des coutures comparées en direct (épaule et côté devant / dos, embu de tête de manche),
    survol d'une ligne = coutures surlignées ; marges de coupe affichées ;
  - recouture 3D au relâcher ; un contour qui se recoupe, se retourne ou a un bord écrasé est signalé
    (`lib/pattern/validate.ts`), la 3D garde la dernière version valide et les exports sont suspendus.
  Corrigé au passage : course entre l'analyse de démêlage d'un vêtement et la recouture suivante
  (réponse écrite dans les buffers GPU du nouveau maillage, erreur WebGPU) ; échec de la triangulation
  contrainte sur certaines formes (arête contrainte sur l'enveloppe convexe : cadre de 4 points ajouté,
  maillage inchangé pour le tracé d'origine). Essai : 300 jeux de modifications aléatoires, 0 échec de
  maillage ou de marges sur les contours valides.
  *À faire* : édition libre de la manche (devant ≠ dos), ajout / suppression de points, pinces.
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
- [x] **Cape qui marche à 1–8 i/s** (diagnostic 2026-11) : deux causes. (1) Rythme « temps réel » sans
  garde-fou : une image simulée un peu au-dessus du budget (~14 ms GPU pour la cape + le rendu)
  faisait rattraper jusqu'à 6 images d'un coup, puis saturer la file GPU (gel ~0,7 s). Désormais au
  plus 2 images simulées en vol et 2 de rattrapage : le mouvement ralentit au lieu de geler. (2) Lancer
  la marche pendant la chute de la cape la coinçait entre le bras et la hanche : tissu écrasé, jusqu'à
  5 500 triangles dans une case de 2,7 cm, auto-collision ×40 (380 ms / image) jusqu'à la perte du
  GPU. Désormais `settleTime` (temps de tomber avant que le corps bouge, cape 3 s) et plafond de
  256 candidats par sommet / arête dans l'auto-collision (GPU et CPU), pour que le coût reste borné
  si du tissu se fait écraser quand même (filet non mis à l'épreuve : l'écrasement n'a pas pu être
  reproduit à la demande une fois le délai en place).
  Coût mesuré (GPU, marche) : t-shirt 9–11 ms / image simulée, jupe 12, cape 12–14 ; l'auto-collision
  en fait ~55 %. Reconstruire la table de hachage coûte cher (préfixe sur un seul groupe de travail,
  10 fois par image) : une table 8× plus grande est plus lente.
- [ ] **Pistes d'optimisation (littérature)** :
  - reconstruire le hachage une fois par image au lieu de chaque passe, avec une marge, et ne refaire
    la détection que quand assez de sommets sortent de leur borne de déplacement (Offset Geometric
    Contact, Chen et al. SIGGRAPH 2025 : borne ≈ 0,45 × distance au plus proche, nouvelle détection
    quand > 1 % des sommets la dépassent) ; préfixe parallèle multi-groupes ;
  - taille de case sur la moyenne des boîtes des triangles plutôt que la plus grande arête (PSCC,
    Tang et al. I3D 2018) ; culling par cônes de normales pour les zones sans auto-contact possible ;
  - auto-collision tous les 3 sous-pas pour les grands vêtements (−25 % mesuré, à valider en croisements) ;
  - tissu pincé entre deux parties du corps : « collision flypapering » (Baraff, Witkin, Kass 2003).
- [ ] Arrêt de la simulation au repos réellement efficace (mesure du mouvement plus fréquente).
- [ ] Rigidité réelle des tissés : l'étirement résiduel décroît en h² (10 sous-pas : 7,5 %,
  20 : 2,7 %, 40 : 1 % en haut du devant, denim). Pistes : plus d'itérations d'étirement,
  multigrille, ou forces de contrainte (λ) pour la carte de tension.

## 4. Autres vêtements

Catalogue : `lib/pattern/garments.ts` (nom, description, image, réglages, tracé). Choix par une
fenêtre plein écran de cartes (`components/GarmentPicker.tsx`, bouton « Changer » de l'onglet Patron) ;
images du vêtement drapé dans `public/garments/`, recapturées par `tools/thumbnails/capture.mjs`
(à relancer après l'ajout d'un vêtement ou un changement de rendu) ; réglages et modifications (avec leur historique) gardés par vêtement. Types communs dans
`lib/pattern/types.ts` ; chaque patron décrit ses cotes, ses coutures à comparer dans l'éditeur et
ses besoins de simulation (`sim` : finesse du maillage, hauteur de chute, amortissement, durée). Mise
en place 3D par type dans `lib/garment/place.ts`.

- [x] **Cape à capuche** (`lib/pattern/cape.ts`) : cercle complet ouvert devant (dos en
  demi-cercle, coupable au pli ; deux devants en quart de cercle moins 5°), capuche deux pièces à
  couture milieu, pointe réglable, encolure de capuche coupée au cran d'épaule (devant / dos).
  Placement : le cercle est plat, posé à plat à la base du cou juste au-dessus des épaules (hauteur
  mesurée sur le corps), sans distorsion ; capuche en deux panneaux verticaux de part et d'autre de la
  tête. Le tissu tombe ensuite en pendule autour des épaules : amortissement 6 /s (sur-amorti), sinon
  le bas passe sous la cape, s'y coince et s'emmêle. Maillage 2,2× plus lâche (~11 000 sommets GPU).
  *Limites* : bouts des doigts qui traversent (doigts plus fins que le champ de distance) ; 50 pages A4
  pour la longueur par défaut (le SVG sur traceur est plus adapté).
- [x] **Jupe trapèze** (`lib/pattern/skirt.ts`) : devant et dos (au pli), sans pinces (galbe pris
  dans la couture de côté, de la hanche à la taille), évasement réglable, bas d'équerre avec le côté.
  Placement rang par rang : chaque ligne horizontale du patron enroulée sur une ellipse autour de la
  section du corps à cette hauteur (jambes réunies sous l'entrejambe), de périmètre égal à sa largeur.
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
- Champ de distance du corps : boîte du vêtement (+ chute) bornée à celle du corps (hors de la boîte
  le champ vaut « loin ») ; pas de 1 cm, plus grossier au-delà de 1,5 M cellules (cape).
- Mesures pour les vêtements (`lib/avatar/bodyMeasures.ts`) : tête (hauteur, profondeur, largeur),
  cou (section à l'encolure), taille naturelle, taille → hanche / genou, sections du bas du corps.
- Après un nouvel export du mannequin, la grille d'influences (`BodySdf.skin`) dépend des attributs
  `JOINTS_0` / `WEIGHTS_0` du GLB et de `bones.parents` du JSON.
