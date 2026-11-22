# Feuille de route — Couture (atelier 3D)

Référence pour les prochaines étapes. Mettre à jour les cases et les notes à chaque étape livrée.

## État actuel

- **Mannequin** : Anny (NAVER LABS Europe, Apache 2.0, MakeHuman CC0) exporté en GLB + JSON
  (`tools/mannequin/`), morphologie homme ↔ femme, mensurations lisibles et modifiables (stature,
  poitrine, taille, hanches), 18 ajustements de couture affichés en centimètres.
- **Patrons** : 8 vêtements en coupe homme et en coupe femme (t‑shirt col rond, t‑shirt manches
  longues, débardeur, robe t‑shirt, cape à capuche, pèlerine, jupe trapèze, jupe longue), tracés
  depuis les mesures du corps sur trois blocs — t‑shirt, cape, jupe (`lib/pattern/`). Accessoires
  posés sur le patron : fermoir, ceinture. T-shirt (`tshirt.ts`) : 4 pièces,
  coutures appariées, maillage Delaunay contraint (Delaunator + Constrainautor). Pièces à couper avec
  marges, crans et repères ; export PDF A4 tuilé, SVG 1:1, DXF AAMA.
- **Simulation** : XPBD (étirement anisotrope, flexion isométrique de Bergou,
  couture progressive, contact SDF avec le corps, auto-collision sommet ↔ triangle). GPU (WebGPU compute, sur le device du rendu,
  coque épaisse calculée sur le GPU, sans relecture) ou CPU en repli (worker).
- **Tissus** : 10 textiles procéduraux avec propriétés physiques (grammage, rigidité en flexion,
  élasticité chaîne/trame, épaisseur, frottement), choisis dans une fenêtre de cartes comme les
  vêtements (`components/TextilePicker.tsx`), plus un **tissu sur mesure** (2026-11,
  `customTextile`) dont l'utilisateur remplit la fiche : nom, aspect (celui d'un tissu de la
  bibliothèque), famille, armure, composition, grammage, épaisseur, rigidité en flexion (0,5 à
  300 µN·m, réglée par son exposant ; le tombé en découle), élasticités, frottement — le
  vêtement est recousu dedans à chaque changement de sa mécanique. Un seul, non enregistré.
  Retirés de l'interface (2026-11) : le réglage d'échelle du motif, le bouton « Recoudre » (la
  couture repart d'elle-même à chaque changement) et les pastilles « Rendu WebGPU » /
  « Simulation GPU ».
- **Pose et mouvement** : squelette d'Anny réduit à 27 articulations (skinning LBS), bras le long du
  corps, marche et course sur place (cadence réglable), postures assise et accroupie ; le tissu suit
  (collision ramenée dans la pose debout, celle du mannequin affiché). Pose et mouvement
  n'existent que dans l'onglet Pose : en le quittant, le mannequin revient debout, immobile.
- **Mise en page** : panneau de l'atelier à gauche, vue 3D au centre, patron 2D à droite quand il
  est ouvert (sous la 3D sur mobile).
- **Manipulation** : le tissu se saisit à la souris et se tire, dans tous les onglets ; éditeur 2D
  ouvert, les points du patron se déplacent aussi sur le vêtement en 3D.

## 1. Rendre l'outil utile à quelqu'un qui coud

- [x] **Carte de tension** (fit map) : boutons « Tissu / Tension / Étirement » dans la vue 3D.
  Tension (N/m) = allongement chaîne / trame × module du tissu ; étirement (%) = allongement
  principal max. Calcul sur GPU (avec le noyau des normales) ou CPU, lissé une fois.
  *Limite* : pour les tissés raides (denim, lin), un résidu numérique d'étirement (~0,5–1 %)
  multiplié par leur module élevé surestime la tension ; fiable pour les mailles.
- [x] **Ajustements de couture en centimètres** (2026-11, `lib/avatar/localMeasures.ts`,
  `useLocalSpans`) : chaque réglage affiche la mesure dont il porte le nom, en entier
  (« Tour de cou 42,9 cm »), au lieu d'un pourcentage de sa course, et dit au survol où elle est
  prise. Elle est prise sur le corps tel qu'il est, autres ajustements compris, 200 ms après la
  dernière action (elle s'accorde avec les mensurations : poitrine, taille, hanches) ; pendant
  qu'un curseur bouge, elle le suit par ce que le réglage lui ajoute. Tours pris comme les mensurations (ruban tendu sur la coupe : poitrine, taille, hanches,
  sous-poitrine, ventre, cou, bras, cuisse sous l'entrejambe), longueurs entre les articulations
  (épaule à épaule, épaule-coude, coude-poignet, hanche-genou, genou-cheville, cou-taille,
  taille-hanches), largeur devant entre les deux points que le réglage déplace le plus ;
  « Buste en V » : écart poitrine − taille ; « Fessiers » : tour de hanches. Ce que chaque
  réglage ajoute est mesuré à −1, −½, ½ et 1 sur la silhouette courante, à stature égale (allonger la cuisse raccourcit le reste),
  interpolé par une parabole de chaque côté : à 0,3 cm près de la mesure directe sur dix
  morphologies. 18 réglages = 72 corps, 0,4 s : un réglage par tâche, à l'ouverture de la section
  et après chaque pause des curseurs de silhouette.
  Au passage : les mensurations étaient prises 150 ms après la demande d'image, donc sur l'ancien
  corps quand l'image tardait (page en arrière-plan, tombé en cours) — et le patron tracé pour
  lui ; elles sont prises après la mise à jour du corps.
  *Limites* : pas de saisie d'une valeur en cm (seules poitrine, taille et hanches se fixent,
  dans les mensurations) ; « Fessiers » et « Tour de hanches » affichent la même mesure.
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

- [x] **Éditeur de patron 2D interactif** (`components/PatternEditor.tsx` ; s'ouvre avec l'onglet
  Patron et se ferme quand on le quitte — il n'existe que dans cet onglet, où le bouton « Éditer le
  patron en 2D » permet de le fermer et de le rouvrir ; à gauche de la 3D sur grand écran,
  par-dessus sur mobile) :
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
- [x] **Patron dessiné sur le vêtement, points déplaçables en 3D** (2026-11, `lib/viewer/PatternOverlay.ts`),
  seulement quand l'éditeur 2D est ouvert :
  - chaque bord de pièce est tracé sur le vêtement simulé, dans la couleur de sa couture (celles
    de l'éditeur, `components/seamColors.ts`) ; les bords non cousus (ourlets, ouvertures) à l'encre.
    Le maillage garde pour cela ses sommets le long de chaque bord du patron (`GarmentMesh.edges`).
    Lignes épaisses (`LineSegments2`), décollées de 1 mm de chaque face du tissu : visibles de
    l'extérieur comme de l'intérieur, cachées par le corps et les autres épaisseurs ;
  - les points de l'éditeur (ancrages et poignées de courbe) sont posés là où ils se trouvent sur le
    tissu : la position sur le patron est lue dans le triangle du maillage qui la contient, par sa
    transformation plat → drapé (les poignées, hors de la pièce, sont prolongées dans le plan du
    tissu à leur ancrage) ;
  - **tirer un point en 3D modifie le même point du patron** : le déplacement du pointeur, pris
    dans le plan du tissu à cet endroit, est relu en coordonnées du patron (base tangente du
    triangle) — le point reste sous le curseur, 2 cm le long du tissu font 2 cm sur le patron,
    avec les mêmes contraintes d'axe et le même pas de 1 mm qu'en 2D (`lib/pattern/edit.ts`). Vu
    presque par la tranche (moins de 20°), le point est tiré dans le plan face à la caméra ;
  - les deux vues partagent la modification en cours : tirer un point en 2D déplace le point en 3D,
    et inversement ; le point survolé d'un côté est surligné de l'autre. Au relâcher : même
    historique (annuler / rétablir) et recouture ;
  - un point l'emporte sur le tissu qu'il recouvre ; ailleurs le tissu se saisit comme d'habitude.
  Vérifié dans le navigateur (GPU) : milieu bas du t-shirt tiré de 20 px → point déplacé de 20 px
  à l'écran, Δ −7,8 cm, longueur 72,9 → 80,7 cm après recouture ; point d'épaule tiré en 2D de
  +8,8 / +4,4 cm → 10 cm en 3D ; cape (25 points) et jupe (22 points).
  Rien n'est tracé pendant qu'un vêtement se coud et tombe (`PatternOverlay.hold`) : les lignes
  et les points reviennent une fois le tombé posé.
  *Limites* : les lignes restent celles du vêtement cousu jusqu'à la recouture ; en mode GPU les
  positions sont relues à chaque image (une à deux images de retard pendant la couture) ; les
  poignées de courbe éloignées (ourlet de la cape : 70 cm) flottent loin du vêtement.
- [x] **Fermoir** (2026-11, `lib/pattern/clasp.ts`, outil « Fermoir » de l'éditeur 2D) : deux points
  du vêtement tenus ensemble une fois porté — une cape fermée au cou.
  - deux clics : le point de départ, puis le point où il se raccroche. Près d'un bord le clic s'y
    pose, près d'un coin il prend le coin. Sur une pièce coupée en double dont une seule est
    dessinée (« Devant ×2 »), un second clic sur la pièce du premier désigne **l'autre exemplaire**
    (Alt : le même) ; il est dessiné en anneau à la même place, le départ en pastille ;
  - un point est repéré depuis le contour (`PiecePoint` : bord, fraction de sa longueur, décalage
    dans le repère du bord) : il suit le tracé quand on déplace un point ou change la morphologie ;
  - même historique que les points du tracé (annuler / rétablir), liste des fermoirs avec
    suppression, Échap pour abandonner, Suppr sur un fermoir sélectionné ;
  - simulé comme un point de couture de plus entre les sommets du maillage les plus proches des
    deux extrémités (`GarmentMesh.clasps`), **agrafé une fois le vêtement enfilé** (`CLASP`,
    `lib/sim/model.ts`) : cousu puis laissé tomber 1,5 s, après quoi les deux points ne peuvent
    plus être écartés de plus d'une distance qui descend de 60 cm à 0 en 1,2 s — rejoints sans
    à-coup où qu'ils soient, puis tenus. Dans les deux solveurs : une couture dont la longueur
    de départ est négative, et un uniforme de plus par sous-pas sur le GPU (`claspGoal`). Le
    repos n'est cherché qu'après (`ClothModel.fastenedAt`).
  Mesuré (cape en jersey, 4 s de marche puis arrêt) : dessus des épaules couvert à 79 % sans
  fermoir, 100 % avec un fermoir aux deux coins d'encolure des devants ; vérifié sur le GPU réel.
  Scénario « cape jersey walk, clasp at the neck » au banc.
  **La cape en a un d'office** (`CAPE_CLASPS`, `GarmentDef.clasps` : le point de départ de
  l'historique de chaque vêtement), au cou, retirable comme les autres.
  **Cape accrochée au menton** (2026-11) : capuche tirée sur le visage, encolure sur la mâchoire.
  La cape était posée à plat au-dessus de tout ce qu'elle aurait pu traverser à moins de 5 cm
  au-dessus du point d'épaule — donc à hauteur du menton, les côtés du cou comptant pour des
  épaules : l'encolure (49 cm) fait juste le tour menton-nuque, elle y restait, fermoir ou non
  (avec le maillage fin du GPU ; le maillage grossier du repli CPU passait une fois sur deux).
  Elle est maintenant descendue autour du cou, sous le menton, avant la couture
  (`seatGarment`, `lib/garment/place.ts`) : à la hauteur, à partir de 0,5 cm au-dessus du point
  d'épaule, où le moins de ses points démarrent dans le corps (0,5 à 3 cm selon la morphologie ;
  au plus 4 points à 8 mm, contre 8 à 10 mm), la capuche avec elle (aucun point dans le corps).
  Mesuré sur le GPU réel (12 581 sommets, longueur 120 cm) : coin d'encolure à 5 cm au-dessus du
  point d'épaule et 11 cm en avant du cou (sur le menton) → 7,6 cm en dessous et 5 cm en avant
  (base du cou), fermoir fermé. Au banc (`apres-courbure` → `apres-cou`) : la cape descend
  moins des épaules (jersey au repos 3,3 → 1,3 cm, laine à la marche 7,2 → 5,6, à la course
  20,4 → 9,2) et la peau ne se voit plus à la marche (laine : 10 points à la fin, 41 au pire →
  0) ni à la course (14 / 41 → 0 / 2) ; t-shirt et jupe : résultats identiques.
  *Reste* : à la course en laine, 5 sommets passent sous la peau (7 mm) et l'allongement p99 en
  fin d'essai monte (27 → 52 %, le pire de l'essai 48 → 53 %) ; les croisements du jersey à
  l'ourlet des côtés restent là (1 176 au repos ; 950 à 1 760 selon les versions, 359 une fois) :
  la cape tombe d'un mètre à plat avant que l'auto-collision ne s'active.
  *À faire* : repère du fermoir sur les exports (PDF, SVG, DXF) et sur le vêtement en 3D ;
  fermoir avec du jeu (cordon, chaînette) ; vignette de la cape à refaire (`tools/thumbnails`).
- [x] **Ceinture** (2026-11, `lib/pattern/belt.ts`, outil « Ceinture ») : un élastique le long d'un
  bord libre existant du patron — on clique le bord (taille, bas, encolure, bas de manche,
  emmanchure d'un débardeur ; pas une couture), il devient ceinture **sur tout son tour** : les
  autres moitiés du bord et, à travers chaque couture, le bord de même nom de la pièce cousue
  (`beltRing` : taille de jupe = 4 bords, bas de t-shirt = 4, bas d'une manche = 1). Dessinée
  par-dessus ses bords, son élasticité écrite sur le patron et dans la liste « Accessoires », où
  on la règle par pas de 5 % (− / +) et où on la retire : rigide (0), élastique (+5 à +40 % :
  elle peut s'allonger d'autant), ou **froncée** (−5 à −40 % : plus courte que son bord, le tissu
  fronce dessus). Une par tour ; même historique que les points et les fermoirs.
  La jupe arrive avec la sienne (`SKIRT_BELTS`, rigide, à la taille), comme la cape avec son
  fermoir : le réglage « Élasticité de la ceinture » de la coupe est supprimé (sans ceinture =
  la retirer).
  Simulation : une bande (`Pattern.bands`, déjà là pour la ceinture de jupe). Froncée, elle ne
  peut pas être tenue comme une bande — la longueur de tissu le long du bord ne raccourcit pas,
  il fronce : tenue ainsi, le bord était écrasé contre les contraintes d'étirement (150 %
  d'allongement, et pas plus court pour autant). Elle tient alors le **tour extérieur** de ses
  sommets (`BELT`, `solveBelt`, noyau `bandsWGSL`) : le plus éloigné du centre dans chacune de 32
  directions, vu de dessus ; trop long, les sommets sont ramenés vers le centre, à niveau. Elle
  tient à la longueur de son bord dès la couture puis se resserre (0,25 m/s, 1,5 s après la
  couture) — sans rien tenir d'ici là, une jupe était aux genoux quand elle se serrait.
  Mesuré sur le GPU réel (jupe) : rigide, tour 84,4 cm pour 85,2 ; +10 %, 94,9 pour 93,7 ; froncée
  de 10 % (76,7 cm, moins que le tour de taille du corps : 85,8), la jupe reste à la taille, tour
  87,3 (le corps l'emporte), au repos en 6,6 s.
  *Limites* : le tour est mesuré à plat (vu de dessus) — juste pour une taille ou un bas debout,
  approché pour un bas de manche, faux assis ; pas de ceinture à une hauteur libre du vêtement
  (il faut un bord : une découpe à la taille) ; pas de repère sur les exports ni en 3D.
  **Palette d'accessoires** : le bouton « Accessoires + » de l'éditeur 2D ouvre les accessoires
  disponibles (icône, nom, une ligne) ; on en choisit un puis on clique sur le patron. Pour en
  ajouter : une entrée de `ACCESSORIES` (`components/PatternEditor.tsx`), son outil, et ce que la
  simulation en fait.
  Avec l'outil, le bord survolé — et tout son tour — prend la couleur de la ceinture s'il peut la
  recevoir (rien sur une couture).
- [x] **Patron libre** (2026-11, `lib/pattern/free.ts`) : dessiner son propre patron. Dans le
  choix du vêtement, « Dessiner son propre patron » : partir de formes simples (une tunique sans
  manches : devant et dos avec encolure et emmanchures, cousus aux épaules et sur les côtés) ou
  **copier le vêtement porté** (mêmes pièces, bords — leurs noms gardés : ses fermoirs et
  ceintures tiennent encore — et coutures ; chaque pièce devient un dessin à part). Un seul
  dessin, repris par « Reprendre mon patron ».
  - Dessin (`FreePattern`) : des pièces faites de points, un bord entre deux points, droit ou
    courbé — il passe par le point qu'on tire en son milieu (parabole), ou garde la courbe
    copiée d'un tracé tant qu'on n'y touche pas. Converti en `Pattern` (`draftFree`) : maillage,
    simulation, exports, fermoirs et ceintures n'y voient aucune différence.
  - Éditeur 2D : glisser un point ou le milieu d'un bord (aussi sur le vêtement en 3D) ;
    double-clic sur un bord : un point de plus ; Suppr ou double-clic sur un point : l'enlever
    (sur un milieu : bord redevenu droit) ; « Couture » : un bord, puis celui auquel il se coud
    (sens deviné d'après la direction des deux bords sur la feuille, inversable par ⇄ dans la
    liste, ×  pour découdre) ; « Pièce + » : un rectangle sur la zone choisie ; liste des pièces
    avec leur zone et leur suppression. Les déplacements sont pris dans le dessin à chaque geste
    (`bakeFree`) : pas d'« écarts » à réinitialiser ; même annuler / rétablir.
  - **Zone du corps** de chaque pièce (`Zone`, `Piece.zone`) : devant ou dos (enroulée autour du
    tronc), bras gauche ou droit (autour du bras) — c'est ce qui dit où la poser avant couture
    (`placeTShirt`, par zone et non plus par nom de pièce). Une pièce est dessinée là où elle se
    porte : x depuis le milieu du corps (ou le dessus du bras), y depuis la ligne d'épaule.
  Vérifié sur le GPU réel : tunique de départ cousue et portée (8 240 sommets, au repos en
  5,3 s) ; point ajouté sur l'ourlet du dos et tiré de 3,5 cm (recousu en pointe) ; pièce « Bras
  gauche » ajoutée puis cousue bord à bord en tube sur le bras ; ceinture sur l'ourlet. Au
  solveur de référence, 8 s de marche : départ simple (homme et femme), copies du t-shirt, de la
  jupe et de la robe — allongement p99 10 à 21 %, tout fini.
  *Limites* : zones du haut du corps seulement — une jupe copiée est posée comme un cylindre
  (elle tient par sa ceinture), pas de zone jambe (pantalon), une cape ne se copie pas (son
  cercle se pose à plat) ; pas de pièce miroir (les deux manches se dessinent séparément), ni de
  couture d'un bord sur le milieu d'une pièce (poche), ni de renommage des pièces ; un dessin
  n'est pas enregistré (perdu au rechargement) ; les bords n'ont que la courbure d'un point.
- [x] **Import DXF AAMA / ASTM** (2026-11, `lib/pattern/import/dxf.ts`) : « Importer un DXF… »
  dans « Dessiner son propre patron » lit les pièces d'un fichier DXF texte vers un patron libre.
  Lu : un BLOCK par pièce ou des pièces en vrac dans ENTITIES ; POLYLINE / VERTEX (arcs « bulge »
  compris), LWPOLYLINE, LINE séparées raboutées, SPLINE (points de passage) ; la ligne de couture
  (calque 14) si elle existe, sinon la ligne de coupe (calque 1), sinon le plus grand contour
  fermé ; les coins = points d'angle (calque 2) qui tombent sur le contour, sinon là où il tourne
  de plus de 30° ; le nom (« Piece Name: »), la quantité (« Quantity: 2 » : la pièce arrive deux
  fois) ; les unités (« Units: METRIC / ENGLISH », `$INSUNITS`, `$MEASUREMENT`, sinon devinées
  d'après les tailles, ou imposées : mm, cm, pouces). Les courbes gardent leur forme exacte
  (bords « shape »). Chaque pièce est centrée, son haut à la ligne d'épaule (à la taille si son
  nom dit jupe, pantalon…), sur la zone que son nom suggère (dos / back, manche / sleeve : bras
  gauche puis droit, sinon devant) ; un compte rendu sous le vêtement dit ce qui a été lu.
  Un DXF ne dit ni les coutures ni où se portent les pièces : elles arrivent **non cousues**
  (elles tombent au sol tant qu'on n'a rien cousu) ; dans l'éditeur, zone et hauteur de chaque
  pièce (↑ ↓ : 5 cm, `movePiece`) puis outil « Couture ».
  Vérifié : aller-retour de nos exports (t-shirt avec et sans marges, jupe, cape, robe : contours
  identiques au dixième de millimètre, 263,0 / 250,6 / 101,6 cm pour le t-shirt) ; fichier en
  pouces sans blocs, LWPOLYLINE avec arc et LINE séparées ; fichier façon ASTM (points d'angle,
  noms en capitales, quantité) ; fichier illisible refusé avec un message ; dans l'app, 4 pièces
  lues et affichées dans l'éditeur.
  *Limites* : DXF binaire non lu ; crans (calque 4), droit-fil (7), lignes internes (8) et ligne
  miroir des demi-pièces (6) ignorés — une demi-pièce au pli arrive en demi-pièce ; ARC et
  ELLIPSE isolés non lus ; fichiers de gradation (.rul) non lus : une seule taille ; aucun fichier
  d'un logiciel du commerce n'a été essayé, seulement nos exports et des fichiers écrits à la main.
  *À faire* : proposer des coutures d'après les longueurs de bords et les crans ; export du
  patron libre vers ces mêmes formats (il passe déjà par l'export existant).
- [x] **Assistant** (2026-11-22, `lib/assistant/tools.ts`, `app/api/assistant/route.ts`,
  `components/AssistantPanel.tsx`, `components/hooks/useAssistant.ts`) : une conversation gardée
  ouverte à droite de la vue 3D (repliable ; sur téléphone, un bouton l'ouvre par-dessus), avec
  un modèle qui règle l'atelier à la place de l'utilisateur. Ses outils n'ont pas de côté
  serveur : le modèle (Vercel AI Gateway, AI SDK 7 `streamText` + `useChat`) dit quel outil
  appeler, la page l'exécute sur ses propres états et répond ce qui a été fait — mesures relues
  sur le mannequin comprises — puis le modèle confirme. Neuf outils : morphologie (stature, âge,
  corpulence, musculature, poitrine, fermeté, homme / femme), tours fixés en cm (poitrine,
  taille, hanches), ajustements locaux du corps, pose et marche / course, tissu et couleurs,
  tissu sur mesure, vêtement du catalogue et ses réglages, dessin d'un vêtement par description
  (la route `/api/pattern`), vue 3D et cartes de tension. À chaque message la page envoie l'état
  de l'atelier ; le modèle reçoit les 30 derniers messages.
  **Mémoire, sans compte** : les conversations (voir l'historique plus bas) et les
  réglages de l'atelier — mannequin, tours fixés, tissu, couleurs, tissu sur mesure, vêtement et
  réglages de chaque vêtement (`couture.workshop.v1`) — sont gardés dans le `localStorage` du
  navigateur et retrouvés à l'ouverture. Non gardés : la
  pose, un patron dessiné (le dernier vêtement du catalogue porté l'est).
  Modèle : `google/gemini-2.5-flash` (`ASSISTANT_MODEL` pour un autre), sur le même budget de
  5 $ par mois que le dessin de patrons ; budget épuisé ou trop de demandes sont dits en clair.
  Vérifié dans l'app : « rends-le plus grand et plus mince, et passe le t-shirt en lin couleur
  sauge » → stature 183 cm, corpulence 30 %, lin lavé sauge ; « robe en coupe femme de 85 cm,
  tour de taille à 78 cm, fais-le courir » → trois réglages faits ; après rechargement, la
  conversation et les réglages (190 cm, velours bordeaux) sont là.
  *Défaut rencontré* : sans consigne ferme, le modèle répondait « c'est fait » sans appeler
  d'outil ; le prompt dit maintenant que rien ne change sans appel d'outil.
  **Retoucher le vêtement porté** (2026-11-22) : « enlève la capuche » était refusé — l'assistant
  ne savait que choisir un vêtement, bouger ses curseurs ou en faire dessiner un neuf. Cinq
  outils de plus, qui partent du vêtement tel qu'il est (un vêtement du catalogue est d'abord
  copié en dessin ; un dessin est modifié en un pas, annulable dans l'éditeur 2D) :
  retirer des pièces avec leurs coutures (immédiat, rien d'autre ne bouge) ; retouche libre
  (« raccourcis-la aux hanches », « manches plus longues ») — le patron en cours part en
  croquis à `/api/pattern` (`base`), le modèle de dessin le rend modifié, et les pièces revenues
  identiques sont gardées telles qu'elles étaient dessinées ici, courbes et sens de couture
  compris (60 à 90 s) ; poser un fermoir (deux points le long de bords, remis aux bouts voisins
  quand le modèle confond début et fin d'un bord, `clasp.ts` `nearestEnds`) ; poser une ceinture
  sur un bord libre (rigide, froncée ou élastique) ; retirer fermoirs ou ceintures. La page dit
  au modèle les pièces du vêtement, leurs bords (cousus ou libres, d'où à où) et ses accessoires.
  Les outils d'une même réponse s'exécutent l'un après l'autre, la page se mettant à jour entre
  deux : « mets la cape puis enlève la capuche » échouait, le second lisant encore le t-shirt.
  **Historique des conversations** (`couture.assistant.v2`, l'ancien format n'est pas repris) :
  30 conversations gardées, titrées par la première demande ; le bouton « Historique » les
  liste (date, nombre de messages), en reprend une ou l'oublie ; « Nouvelle » en commence une
  sans perdre la précédente.
  Vérifié dans l'app : « mets-lui la cape à capuche puis enlève la capuche » → cape copiée en
  dessin, 3 pièces ; « retire le fermoir » puis « rajoute un fermoir au niveau du cou » →
  fermoir entre les deux devants, aux coins du milieu devant, la cape tient aux épaules ;
  « raccourcis la cape pour qu'elle s'arrête aux hanches » → 73 cm, coutures et fermoir gardés,
  drapée aux hanches (jersey) en 70 s ; deux conversations listées, la première reprise.
  **Cape qui tombait avant son fermoir** (2026-11-22, `lib/sim/model.ts` `CLASP`) : le fermoir
  attend que le vêtement soit en place pour se fermer (1,5 s après la couture, puis 1,2 s) ;
  d'ici là ses deux points étaient libres, et une cape sans capuche dans un tissu qui glisse
  (satin, frottement 0,15) quittait les épaules et finissait au sol. Premier correctif, écarté :
  tenir les deux points à leur distance de pose (1,4 cm) — le devant redevenait un anneau fermé
  pendant que les coutures de la capuche le remontent au menton, et le fermoir finissait dans la
  bouche (signalé le jour même). Retenu : jusqu'à la fermeture, les deux points peuvent
  s'écarter de 10 cm (`CLASP.slack`), pas plus — une largeur de main laisse passer le menton,
  pas le cou. Vérifié sur le GPU : cape à capuche en grosse maille sur le mannequin par défaut,
  mince, et grand et fort (190 cm) : fermée à la gorge (le devant s'ouvre de 10 cm pendant la
  pose, puis se ferme) ; pèlerine en satin : tenue aux épaules, fermoir fermé au cou. L'idée de
  poser la cape en deux parties, devant et dos, déjà enroulées, ne s'applique pas à une cape en
  cercle : c'est un disque plat, qui ne prend sa forme qu'en tombant.
  Banc CPU (`fermoir2` contre `final`) : cape en jersey au repos, croisements du tissu sur
  lui-même 711 contre 1 176, corps mince 1 816 contre 1 462 (même ordre de grandeur : ce sont
  ceux de l'ourlet, déjà connus) ; allongement, chute et pèlerine inchangés.
  **Interface** (2026-11-22) : le formulaire « décrire le vêtement » du sélecteur de vêtement
  est retiré — le dessin par description se demande à l'assistant, qui appelle la même route ;
  la mention « Couture · Atelier 3D » sur la vue est retirée ;
  Tissu / Tension / Étirement sont en haut à droite de la vue, le bouton « Assistant » (quand il
  est replié) en bas à droite. Dans l'éditeur 2D, les pièces se rangent en autant de rangées
  qu'il faut pour être les plus grandes possible dans la place disponible : l'une au-dessus de
  l'autre dans un panneau haut, côte à côte dans un panneau large (avant : une seule rangée,
  une bande au milieu d'un panneau vide).
  Une couture survolée dans la liste « Coutures » de l'éditeur 2D est aussi mise en évidence
  sur le vêtement en 3D (`PatternOverlay.setHighlight`) : ses bords redessinés deux fois plus
  épais dans la couleur de la couture, les autres lignes du patron atténuées. Et dans l'autre
  sens : le bord du patron sous la souris sur le vêtement (`PatternOverlay.pickEdge` : le plus
  proche du pointeur à l'écran, à 9 pixels au plus, sauf si du tissu ou la peau le cache) allume
  sa couture sur le patron 2D et sa ligne dans la liste ; un bord libre (ourlet, encolure) est
  montré seul.
  Le panneau de gauche (« Atelier ») se replie comme l'assistant (flèche dans son en-tête, bouton
  « Atelier » sur la vue 3D pour le rouvrir ; ordinateur seulement, sur téléphone il est la page
  sous la vue) : la vue 3D prend la place, les réglages et l'onglet ouvert sont gardés.
  Le palier gratuit du gateway limite aussi le débit : après une vingtaine de demandes
  rapprochées, « trop de demandes » pendant une minute (dit en clair dans la conversation).
  *Limites* : il ne déplace pas un point ni une couture à la main (éditeur 2D) ; pas de limite
  de débit par visiteur ; pas de test automatisé ; un modèle peut encore annoncer un réglage
  qu'il n'a pas fait — les lignes cochées de la conversation font foi.
- [x] **Patron décrit en texte** (2026-11-22, `lib/pattern/describe.ts`, `app/api/pattern/route.ts`) :
  on décrit le vêtement à l'assistant (« une robe trapèze sans manches, col en V, jusqu'aux
  genoux » ; d'abord un formulaire dans « Dessiner son propre patron », retiré depuis) et une
  IA le dessine et le coud : il arrive en patron libre, porté, retouchable comme un autre. La page envoie la description
  (600 caractères au plus) et les mesures du mannequin à la route `/api/pattern`, qui interroge
  un modèle par le Vercel AI Gateway (AI SDK 7, sortie structurée validée par un schéma zod).
  Le modèle ne rend pas un `FreePattern` mais un croquis plus sûr : pièces (zone, points en cm),
  bords courbés par les points où ils passent, coutures comme paires de bords, ceintures. Le
  sens de chaque couture est calculé (bouts à la même hauteur, ou du même côté pour un bord à
  plat) ; contours remis dans le bon sens ; ids dédoublonnés. Le prompt donne les repères du
  corps, ses mesures et deux patrons du catalogue tracés sur ce corps même (t-shirt, jupe à
  ceinture). Si le croquis ne se coud pas (contour qui se recoupe, bords cousus de longueurs
  différentes à plus de 10 %, ceinture sur un bord cousu), le serveur le dit au modèle et
  redemande une fois ; ce qui reste est affiché sous le vêtement.
  Modèle : `google/gemini-2.5-flash` — le crédit gratuit du gateway refuse les Gemini 3 et 4
  (« Free tier users do not have access to this model ») ; `PATTERN_MODEL=google/gemini-4-hydrogen`
  dès que l'équipe a des crédits payants. Authentification par le jeton OIDC du projet Vercel
  (en local : `vercel env pull .env.local`, à refaire quand le jeton expire, ~12 h).
  Vérifié : aller-retour croquis → patron sur 5 vêtements du catalogue (longueurs à 0,35 cm près,
  sens des coutures identiques) ; robe trapèze, t-shirt ample à manches longues (4 pièces, 10
  coutures, drapé au repos en 7,5 s, allongement p99 7 %), jupe crayon à taille élastiquée
  (ceinture −20 %), « pantalon large » rendu en jupe longue avec l'explication. 23 à 55 s et
  9 000 à 15 000 jetons par patron (2 à 3 centimes).
  **Capes et capuches** (2026-11-22) : l'IA dessine toujours, cape comprise. Premier essai
  d'une cape : sa capuche, dessinée comme une pièce du « devant », était enroulée sur la
  poitrine et cousue au haut de la cape — un anneau autour du cou, la tête dans le trou. Les
  patrons dessinés ont donc quatre zones de plus (`types.ts` Zone, `place.ts`) : « Capuche
  gauche / droite » — une moitié de capuche debout de chaque côté de la tête, x depuis
  l'ouverture du visage vers l'arrière, y depuis la ligne d'épaule — et « Cape · devant / dos »
  — une pièce posée à plat sur les épaules autour du cou, en secteur d'anneau, puis descendue
  autour du cou comme la cape du catalogue (`seatGarment`, désormais par zones). Dans
  l'éditeur, « Pièce + » propose une demi-capuche et des pièces de cape toutes faites ; la cape
  du catalogue se copie en dessin (« Copier le vêtement porté » : même drapé, allongement p99
  7,7 % contre 7,5 %). Un patron dessiné règle la finesse de son maillage sur sa surface (une
  cape longue fait six t-shirts : maillage 2,2 fois plus lâche, ~14 000 sommets).
  Pour l'IA : le croquis porte aussi des fermoirs (points le long d'un bord) ; le prompt montre
  la cape du catalogue dessinée sur ce corps (5 pièces, fermoir au cou) et une capuche à coudre
  à l'encolure du t-shirt ; le sens des coutures capuche ↔ encolure est calculé (le bout côté
  visage va au milieu devant, le bout côté nuque au milieu dos). Vérifications ajoutées, dites
  au modèle : capuche assez haute et assez profonde à mi-hauteur de tête, un seul bord libre par
  moitié de capuche (sinon le dessus reste ouvert), encolure de cape qui fait le tour du cou ;
  un fermoir dont les deux points sont loin l'un de l'autre est remis aux bouts voisins des
  deux bords (le modèle confond début et fin d'un bord). 2 réponses au plus par patron.
  Vérifié dans l'app : « cape ample ouverte devant, capuche en pointe, mi-cuisse » → 5 pièces,
  7 coutures, fermoir, cape sur les épaules et capuche sur la tête, allongement p99 8 % ;
  « sweat à capuche ample » → 6 pièces, 15 coutures, p99 6,4 %, 39 s.
  *Limites* : une cape demande souvent la deuxième réponse (90 s, 5 à 6 centimes) et Gemini 2.5
  Flash simplifie volontiers la capuche ; pas de jambes séparées ; pas de pinces ni de poches ;
  pas de test automatisé.
  *Dépense* : budget AI Gateway de 5 $ par mois sur le projet Vercel `couture`
  (`vercel ai-gateway budgets set project couture --amount 5 --refresh-period monthly`, posé le
  2026-11-22 ; il compte les appels faits avec le jeton OIDC du projet, donc ceux de la route).
  Une fois dépensé, le gateway répond 402 jusqu'au mois suivant et la page le dit (« budget
  mensuel épuisé ») ; c'est un plafond souple, la demande qui le franchit aboutit. La route n'a
  ni authentification ni limite de débit : n'importe qui peut épuiser ce budget, pas plus.
  *À faire* : limite de débit par visiteur ; repartir du patron en cours (« rallonge les
  manches ») ; réponse en flux pour voir les pièces arriver.
- [ ] **Variantes du t‑shirt** : col V, oversize.
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
- [x] **Animation du mannequin** (onglet « Pose » + boutons Marche / Tour) : par défaut, une fois le
  vêtement cousu, bras le long du corps (20°, `ARM_SPREAD`) et coudes relâchés (jusqu'à 35°
  d'extension quand les bras descendent : la pose de repos a les coudes pliés de 44°, avant-bras vers
  l'avant) ; bouton « Repos » pour la pose de couture (bras en A) — *remplacé depuis : bras à 20° dès
  la couture, sans réglage ni bouton « Repos », voir « bras le long du corps dès le départ » plus bas*. Le réglage « Proportions » d'Anny
  n'est plus proposé (fixé à 0,5). **Mains placées à la souris** (onglet Pose : repère de translation
  à trois axes sur chaque poignet, `lib/viewer/HandHandles.ts` — flèche = déplacement contraint à
  l'axe, centre = libre face à la caméra ; axe vu de face masqué et non saisissable ; taille constante
  à l'écran) : cinématique inverse à deux segments
  (`lib/avatar/armIK.ts`, coude du côté où il est au repos, cibles hors d'atteinte ramenées à bras
  tendu), bras indépendants, cible lissée (0,2 s) pour que la simulation suive ; remplace l'écartement
  et le balancier de la marche pour ce bras ; « Libérer les mains », le curseur ou « Repos » rendent
  les bras au réglage commun. Le vêtement est toujours cousu au repos, la pose s'applique ensuite.
  *Limites* : main au-dessus de la tête ou derrière le dos = zone fragile de la collision en espace
  repos (épaule).
  Écartement des bras
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
- [x] **Marche, course et postures** (2026-11, `lib/avatar/motion.ts`) :
  - marche resserrée : les chevilles viennent à 5,5 cm du plan médian (12–13 cm entre elles au lieu
    de 28 ; la pose de repos a les pieds écartés de 41 cm), l'adduction étant calculée sur la
    longueur de jambe de la morphologie ; pied en oscillation continu en vitesse (il part et arrive
    à la vitesse qu'il a au sol : cubique d'Hermite) ; jambe qui ralentit en arrivant en extension
    (`SOFT_REACH`). Saut de vitesse le plus fort d'un point de peau : 0,5 m/s (1,45 avant) ;
  - **course** au-delà d'un seuil de cadence (`RUN_CADENCE` : marche jusqu'à 135 pas/min, course à
    partir de 155, fondu entre les deux ; curseur jusqu'à 180) : appui raccourci (38 % du cycle, donc
    phase de vol), foulée plus longue sur genoux fléchis, pied levé haut derrière, bassin au plus bas
    en milieu d'appui et remontant en vol (3 cm), buste penché, coudes fléchis. En vol aucun pied ne
    porte le corps : l'ancrage au sol du squelette s'estompe avec le poids total des pieds
    (`Skeleton.pose`), et les pieds sont posés sur les mêmes points de semelle que cet ancrage —
    sinon tout le corps sautait de 1,5 mm à chaque pose de pied ;
  - **postures** « Assise » et « Accroupie » (onglet Pose) : chevilles placées depuis les hanches
    par la même cinématique inverse, pieds à plat au sol, transition de 1,4 s ; s'asseoir arrête la
    marche, marcher relève le mannequin. Le siège n'est pas représenté ;
  - bouton « Tour complet » retiré de l'interface (`GarmentViewer.turn` existe toujours) ;
  - **bras le long du corps dès le départ** (`ARM_SPREAD` = 20°, plus de réglage d'écartement) : le
    vêtement est cousu dans cette pose, on ne voit plus les bras partir de la pose en A puis
    descendre. Les pièces placées le long des bras (manches) le sont deux fois, autour du bras de
    repos (espace de collision, `PreparedGarment.initial`) et autour du bras posé (départ de la
    simulation, `start`) ; les autres ne bougent pas. Mesuré aux réglages GPU sur le solveur de
    référence : t-shirt jersey 0 croisement, étirement moyen 0,79 %. *Limite* : l'aisselle plus
    serrée laisse des croisements sur le t-shirt en jersey — ~30 en repli CPU (maillage 1,5 cm ;
    0 en pose en A), 16 mesurés sur le GPU réel ;
  - onglet Pose réduit à un bloc « Posture » : Debout, Marche (ou Course), Assise, Accroupie ; la
    cadence n'apparaît qu'en marche. Sections « Bras » et « Mains » retirées (la cinématique
    inverse des bras et les repères de poignet restent dans le code, sans interface).
  *Limites mesurées (repli CPU)* : en course le t-shirt tient (étirement 0,7 %) mais se croise
  (≈ 95 croisements, pénétration jusqu'à 15 mm) ; accroupi ou assis, les cuisses rejoignent le buste et
  la collision en espace repos ne sait plus de quel côté pousser : 500–900 croisements, pénétrations
  de 3–5 cm. Les postures sont donc justes pour le corps, approximatives pour le vêtement.
- [x] **Peau visible à travers la cape, sur les épaules** (2026-11, `lib/avatar/motion.ts`,
  `lib/sim/posedBody.ts`, `lib/sim/bodySdf.ts`, `lib/garment/prepare.ts`, mesure `skin through` du
  banc) : au repos, deux trous symétriques sur les épaules. Les coutures étaient fermées (écart max
  0,2 mm) : c'était la peau, au travers du tissu. Quatre causes, quatre mesures :
  - *pose de référence* : la collision se résolvait dans la pose A du mannequin (bras à 40°) alors
    qu'il se tient bras à 20°. Même immobile, chaque sommet passait donc par le skinning inverse,
    dont l'erreur (poids de la grille, interpolés) croît avec l'écart à la référence : jusqu'à 7 mm
    sur le dessus de l'épaule, et en maillage grossier le test de cohérence privait de tout contact
    3 sommets de la jonction épaule / encolure. La référence est maintenant la pose debout
    (`standingBody`) : l'animateur donne les os depuis cette pose (identité à l'arrêt) ; le corps
    affiché, la mise en place du vêtement et le champ de distance en partent. Une seule mise en
    place au lieu de deux (`initial` et `start`). Écart de pose au repos : 0 ;
  - *sphères des membres* : bras le long du corps, la sphère englobante de l'avant-bras (21 cm)
    recouvrait la hanche, dont le tissu recevait la marge des impacts (28 mm) : jupe en marche
    étirée de 15 à 33 % (p99). Capsules ajustées à chaque membre (axe principal de ses sommets) ;
  - *marge peau réglée sur la maille* (`skinGapFor`) : une part pour l'erreur du champ de distance,
    plus la flèche d'un triangle posé sur une partie convexe, L² / (6R) : 3 mm jusqu'à 1,5 cm de
    maille, 3,9 mm à 2,2 cm, 5,9 mm à 3,3 cm. À 9 mm la peau est cachée aussi, mais le tissu n'a
    plus de place entre le bras et le corps et se croise (460 croisements en marche) ;
  - *champ de distance exact près de la peau* (`bodySdf.ts` `exactBand`, les triangles du corps
    voyagent avec la requête) : à moins de 3 cm d'un sommet, distance exacte aux triangles au
    lieu du plan du sommet le plus proche, signe par la normale interpolée au point le plus
    proche. Écart entre le champ et la vraie distance, là où le tissu repose sur épaules et cou :
    1,0 → 0,24 mm (quadratique), pire cas +1,6 → +0,8 mm (ce qui reste est l'interpolation sur
    les cellules de 1 cm) ; préparation + 0,15 s. Le liseré de peau qui subsistait dans le pli
    capuche / épaule après une marche a disparu sur le GPU réel ;
  - *parties anguleuses gonflées selon la maille* (`bodySdf.ts` `inflateSharp`) : avec une
    corpulence mince, la peau ressortait encore de 0,6 à 2,4 mm sur le dessus des épaules, sous
    les plus grands triangles de la cape (jusqu'à 3,9 cm le long de la couture d'épaule, 1,75 ×
    la maille), tous leurs sommets pourtant à la marge. Un triangle posé en travers d'une arête
    s'enfonce de côté² × courbure / 8 (/ 6 une fois étiré) : là où la courbure du champ — son
    laplacien — dépasse celle d'un membre (rayon 5 cm), la distance est réduite d'autant, 9 mm
    au plus. La marge suit donc le corps au lieu d'être la même partout : rien de plus sur les
    parties rondes (bras, torse), où une marge uniforme plus grande faisait se croiser le tissu.
    GPU réel, corpulence mince, jersey et fermoir : 3 points de peau au repos → 0, et 0 pendant
    8 s de marche et après l'arrêt.
  Mesuré en repli CPU, avant → après : cape jersey au repos, 99 → 1 point de peau visible (10 →
  0,5 mm) et 82 → 0 sommets sous la peau ; cape laine en marche 91 → 0 ; t-shirt jersey au repos
  2 → 0, croisements 32 → 15 ; jupes inchangées ; contact 7 × moins cher au repos (plus de skinning
  inverse), 15 % plus cher en mouvement (capsules). Sur le GPU réel (cape, maille 2,2 cm) : 0 point
  visible au repos.
  *Reste* : accroupi et assis inchangés ; la cape en jersey, sans fermoir, glisse des épaules en
  marchant (après 4 s de marche, 65 % du dessus des épaules encore couvert ; 67 % avant ces
  changements — un fermoir au cou la retient, voir « Fermoir ») ; le bord de l'oreille peut percer la capuche (plus fin qu'un triangle, comme les
  doigts). Non retenu : corps rendu 2 mm en retrait de la surface de collision (le liseré
  disparaissait, mais les lèvres s'ouvraient).
- [x] **Bras et mains qui traversaient la cape en courant** (2026-11, `lib/sim/posedBody.ts`,
  mesure `limbs through` du banc) : en marche rien ne traversait ; en course (170 pas/min) les
  avant-bras étaient à travers le tissu 85–91 % du temps. Trois causes, trois mesures :
  - *membre invisible* : la collision en espace repos suit chaque sommet depuis sa position
    précédente ; le tissu qui pend devant le buste ne « voit » pas l'avant-bras qui arrive. Un sommet
    sans contact est donc aussi testé contre les extrémités qui s'éloignent beaucoup de leur place de
    repos (avant-bras, mains, jambes, pieds : `SdfGrid.limbs`, transformation rigide de leur os), et
    suivi sur ce membre ensuite ;
  - *effet de coin* : les contacts ne portent que sur les sommets, repoussés à l'écart de l'axe du
    membre ; un avant-bras rapide écartait les sommets plus vite que l'étirement ne les retenait, et le
    triangle finissait enfilé sur le bras (arêtes à 2–3 × leur longueur, sommets pourtant bien à 5 mm
    de la peau). Au-delà de 1,5 m/s de vitesse relative sur une extrémité, le sommet reste donc où il
    a été touché (point d'entrée de sa trajectoire, cherché par dichotomie) au lieu de glisser autour ;
  - *doigts plus fins que le maillage* : la marge de contact grandit avec la vitesse relative (distance
    parcourue en 5 ms, 2,5 cm au plus) : le tissu part avant que la main n'arrive, sans écart au repos.
  Résultat : plus aucun membre à travers sur le solveur de référence (repli CPU et réglages GPU) ;
  sur le GPU, avant-bras 0 % (100 % avant), mains 21 % par une mesure approchée. Marche inchangée.
  *Contrepartie* : un membre qui emporte le tissu le secoue ; la cape, sans attache, quitte les
  épaules du coureur, et se replie sur elle-même plus vite que l'auto-collision ne la démêle
  (croisements × 5 en course, repli CPU).
  Essai retiré : tester aussi le milieu des arêtes — sur un corps convexe il est toujours un peu
  sous la marge des sommets, la passe repoussait donc sans frottement tout le tissu posé (cape qui
  glisse au sol même en marche) ; limitée au voisinage de la peau, elle n'empêchait plus rien.
  *À faire* : une attache de cape (comme la ceinture de la jupe).
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
- [ ] **Performance : mesures et plan** (état au 2026-11-22).
  Coût d'une image simulée sur le GPU (ms ; le temps réel en laisse 16,7, rendu compris ; mesuré
  dans l'app en mettant 10 images en file d'un coup, 20 sous-pas) :

  | Vêtement (sommets) | repos | marche | course | course sans auto-collision |
  | --- | --- | --- | --- | --- |
  | t-shirt (9 700) | 10,4 | 10,5 | 11,1 | 5,1 |
  | robe (13 050) | 11,3 | 12,7 | 13,9 | 6,0 |
  | cape (12 580) | 14,2 | 13,2 | **19,1** | 5,6 |

  La course ne coûte pas plus que le repos, sauf pour la cape (tissu écrasé : plus de candidats
  d'auto-collision), seule à sortir du budget : elle court au ralenti. L'auto-collision fait 50 à
  70 % du coût partout. Le repli CPU (maillage 2 fois plus lâche, 10 sous-pas) est à 25–120 ms par
  image : jamais en temps réel dès que le corps bouge. Ce qui cède en course est la tenue, pas la
  vitesse : cape en laine, 5 000 à 9 400 croisements et jusqu'à 51 points de peau ; t-shirt, 30
  sommets sous la peau, 20 % d'allongement au pire.
  *À faire, dans l'ordre* :
  1. **Sonde GPU rejouable** : la mesure ci-dessus en un geste (vêtements × repos / marche /
     course, part de l'auto-collision), enregistrée avec les résultats du banc — aujourd'hui elle
     se fait à la main dans la console.
  2. **Budgets et seuils** au banc (`npm run bench`) : échec si le coût par image, les
     croisements ou la peau visible dépassent la référence de plus d'une marge ; c'est le premier
     pas des tests automatisés (§ 5).
  3. ~~Mode mouvement~~ : fait, voir ci-dessous.
  4. Pour la marche de la cape (13 ms, près du budget) : auto-collision tous les 3 sous-pas
     (−25 % mesuré), et les pistes ci-dessous.
- [x] **Mode mouvement, à la manière d'un jeu vidéo** (2026-11-22, `lib/sim/tether.ts`) : quand le
  corps court (`Animator.running` : allure de course établie), le vêtement est tenu par des
  attaches au squelette et l'auto-collision n'est plus résolue ; à l'arrêt ou à la marche, retour
  à la simulation complète. Les attaches sont posées à chaque repos, corps debout : chaque sommet
  est relié à son appui — l'endroit où le vêtement repose sur le corps le plus proche le long du
  tissu, les plus hauts d'abord (la cape pend des épaules, pas de l'avant-bras qu'elle frôle ; la
  jupe, de la taille) — et ne peut s'en éloigner de plus que sa distance le long du tissu drapé
  (+ 5 % et 2 cm). C'est la contrainte « long range attachment » (Kim, Chentanez, Müller 2012) des
  moteurs de jeu : rien ne s'étire sans fin ni ne se décroche, et dans cette longueur le tissu
  reste simulé (il vole, le corps le repousse). Calcul des attaches dans le worker (Dijkstra sur
  les arêtes et les coutures, depuis les positions relues du GPU), contrainte en un noyau WGSL
  avant les contacts ; même code sur le repli CPU.
  Première version écartée : chaque sommet tenu dans une sphère autour de sa place au repos
  portée par l'os de son appui (« motion constraint ») — parfait pour le t-shirt, mais cape et
  jupe s'y déchiraient (allongement p99 110 % et 350 % au banc : des voisins portés par des os
  différents s'écartent plus que leur rayon).
  Mesures, course à 170 pas/min. GPU réel (ms par image simulée, avant → après) : t-shirt 11,1 →
  5,2 ; robe 13,9 → 5,8 ; cape 19,1 → 6,3 ; jupe longue 16,2 → 6,5 — tout court en temps réel.
  Tenue sur le GPU : cape, allongement p99 17 % en course, 8,5 % après l'arrêt (7,5 % avant) ;
  jupe longue, 55 % en course au lieu de 180 % et 14 % après l'arrêt au lieu de 70 % (en
  simulation complète elle est piétinée et ne s'en remet pas). Banc CPU (`--only " run"`,
  résultats `mouvement2`), mode mouvement contre simulation complète : cape en laine, 0 point de
  peau visible au lieu de 51, croisements 3 700 contre 4 300 en moyenne, 62 ms contre 87 ; jupe,
  allongement p99 au pire 48 % contre 65 %, chute 8 cm contre 15,5, 40 ms contre 57 ; t-shirt,
  tenue égale, 46 ms contre 61. *Limites* : sans auto-collision le tissu peut se traverser
  lui-même pendant la course (les couches se remettent en ordre à l'arrêt, par le démêlage) ; un
  vêtement mis en course avant son premier repos n'a pas d'attaches et court en simulation
  complète ; la marche reste en simulation complète (cape : 13 ms).
- [ ] **Pistes d'optimisation (littérature)** :
  - reconstruire le hachage une fois par image au lieu de chaque passe, avec une marge, et ne refaire
    la détection que quand assez de sommets sortent de leur borne de déplacement (Offset Geometric
    Contact, Chen et al. SIGGRAPH 2025 : borne ≈ 0,45 × distance au plus proche, nouvelle détection
    quand > 1 % des sommets la dépassent) ; préfixe parallèle multi-groupes ;
  - taille de case sur la moyenne des boîtes des triangles plutôt que la plus grande arête (PSCC,
    Tang et al. I3D 2018) ; culling par cônes de normales pour les zones sans auto-contact possible ;
  - auto-collision tous les 3 sous-pas pour les grands vêtements (−25 % mesuré, à valider en croisements) ;
  - tissu pincé entre deux parties du corps : « collision flypapering » (Baraff, Witkin, Kass 2003).
- [x] **Sol** (2026-11) : un vêtement qui tombait traversait le socle (aucune collision : la
  simulation s'arrêtait simplement au bout de sa durée). Le socle est maintenant un cylindre posé
  sur le sol (`PLINTH`, `ClothParams.floorY`), traité avec les contacts dans les deux solveurs, en
  espace monde, avec le même frottement de Coulomb : un sommet entré dans le socle ressort par la
  face la plus proche (dessus ou côté — poussé vers le haut quelle que soit la profondeur, le tissu
  pendant au bord était renvoyé sur le socle et ne se posait jamais). Mesuré : carré de tissu lâché
  à cheval sur le bord (`npm run bench:physics`) et jupe sans ceinture sur le GPU : le point le
  plus bas reste à une demi-épaisseur du sol, puis repos.
  *Limite* : le champ de distance du corps ne descend que 25 cm sous le vêtement (2 m pour la
  cape) : un vêtement qui tombe plus bas ne rencontre plus les jambes ni les pieds, seulement le sol.
- [x] **Tissu tenu à la main** (2026-11, `lib/sim/grab.ts`, `lib/viewer/ClothGrab.ts`) : cliquer sur le
  vêtement et tirer, dans tous les onglets ; ailleurs le même geste fait tourner la caméra.
  - *La prise* : un ressort (300 N/m) entre la main et le centre de masse d'un disque de tissu de
    4 cm de rayon autour du point saisi (distance mesurée le long du tissu, à travers les coutures
    mais pas à travers l'air : l'autre épaisseur d'une manche n'est pas prise). Sa force est
    répartie sur le disque en accélération uniforme, estompée vers le bord : le disque ne garde ni
    forme ni orientation, il pend et se plie comme le tissu autour. Appliquée aux positions prédites,
    avant les balayages — ce qu'est une force extérieure pour XPBD —, ressort implicite (stable quel
    que soit le sous-pas), mêmes formules dans les deux solveurs (`solveGrab`, `grabWGSL` : une
    invocation) ; la main est interpolée sur les sous-pas ;
  - *Force plafonnée* : la main n'accélère jamais le point tenu de plus de 1 800 m/s² (0,3 à 0,6 N
    sur du jersey, soit le poids de 0,2 à 0,4 m² ; davantage sur un tissu lourd, 2,5 N au plus). Un
    vêtement qui ne peut pas suivre n'est pas étiré sans limite : la prise glisse ;
  - *Auto-collision* : pendant la prise et 1,5 s après, une passe à chaque sous-pas sur le GPU au
    lieu d'une sur deux (`selfIntervalHeld`) : la main accélère le tissu plus vite que des passes
    espacées ne le rattrapent (ourlet soulevé de 27 cm : 30 à 45 croisements laissés, puis 0) ;
  - *Viewer* : le point saisi est trouvé par lancer de rayon sur les positions connues côté
    interface (mode CPU : celles du worker ; mode GPU : relues toutes les 120 ms tant que le tissu
    bouge), sauf si le corps est devant ; la main se déplace dans le plan face à la caméra ; la
    simulation, arrêtée au repos, est réveillée et tourne en temps réel pendant la prise et 1,5 s
    après (le tissu retombe à vitesse réelle), puis retrouve le repos ;
  - *Mesures* (`npm run bench -- --grab`, t-shirt jersey aux réglages du GPU sur le solveur de
    référence) : ourlet soulevé de 27 cm, le point tenu suit sur 21 cm ; replié de 36 cm jusqu'à la
    poitrine, sur 24 cm ; tiré de 50 cm vers le bas, le vêtement retient (1,6 cm). Dans les trois
    cas 0 croisement pendant et après, allongement p99 9 % pendant la prise (6,6 % au repos), point
    tenu revenu à 1 cm de son départ. Sur le GPU réel (16 croisements au repos sur ce t-shirt) : ourlet
    soulevé de 29 cm, suivi au millimètre, 20 croisements après, retour à 1 mm ; tiré de 40 cm vers le
    bas ou de 30 cm de côté à la poitrine, le vêtement retient (4 à 6 cm de déplacement), 20
    croisements après, retour à 1 cm ; allongement p99 pendant la prise 9 % (6,5 % au repos).
  *Limites* : replier fortement le tissu sur lui-même contre le corps (ourlet remonté de 36 cm
  jusqu'à la poitrine) laisse, une fois sur deux sur le GPU, une centaine de croisements — la même
  faiblesse de l'auto-collision que dans les poses assises ; « Recoudre » repart de zéro. Le repli
  CPU a la même force mais suit moins bien (maillage grossier, 10 sous-pas). On ne tire que dans le
  plan de l'écran : tourner la caméra pour tirer dans une autre direction. Pas encore d'épingle
  (tenir un point pendant qu'on en tire un autre).
- [x] **Manches qui s'agitaient à la marche** (2026-11, `IMPACT_MARGIN` dans
  `lib/sim/posedBody.ts`) : sur le GPU, le bas des manches du t-shirt sautait de 1 à 3 cm d'une
  image à l'autre, côté extérieur du bras (secousses 3,7 à 4,7 mm/image² en médiane, 13 à 16 au
  pire, contre 1,1 pour le devant ; 0,7 sur le solveur de référence, où le cycle ne s'amorçait
  pas). Cause : la marge d'impact des membres — prévue pour qu'un avant-bras rapide pousse la
  cape devant lui — comptait sur la vitesse du tissu *par rapport* à la peau : une manche qui
  retombe vite sur un bras lent passait pour un choc, était rejetée à la marge (jusqu'à 2,5 cm
  en un sous-pas), retombait plus vite encore, etc. La marge arrête toujours le tissu qui
  arrive ; elle ne le rejette plus que si la peau elle-même va vite (`IMPACT_SPEED`), sinon elle
  l'empêche seulement d'approcher. Mesuré sur le GPU réel : manches 0,85 à 0,95 mm/image² (2,3 à
  3,1 au pire), comme le reste du t-shirt. Au banc : marche inchangée (cape en laine, peau 0/0 ;
  jersey 0/1), avant-bras jamais à travers la cape en course (0 %).
  *Prix* : cape en laine à la course, 51 points de peau visibles en fin d'essai (0 à 41 selon
  les versions précédentes) et 9 400 croisements (5 200) : l'essai le plus chaotique du banc, à
  reprendre. Essais écartés : ne compter l'impact que si la peau va vite (avant-bras à travers
  la cape 58 % du temps en course, doigts visibles à la marche) ; ne jamais rejeter (53 %).
- [x] **Repos détecté quand plus aucun point ne bouge** (2026-11, `REST` dans `lib/sim/model.ts`) :
  le point le plus rapide sous 4 mm/s (un pixel en plusieurs secondes à l'écran) sur deux
  fenêtres de 0,25 s de suite, entières après le dernier mouvement du corps ou de la main.
  Sur le GPU la vitesse était lue dans les vitesses du solveur : un tissu posé y tremble de
  quelques centièmes de millimètre par sous-pas — 70 mm/s en moyenne, 570 au plus, immobile —
  si bien que le repos n'était jamais détecté et que tout s'arrêtait au délai (durée du
  vêtement, ou 3 s après le lâcher : le point le plus rapide allait encore à 6,5 mm/s, bien plus
  sur une cape). On mesure maintenant le chemin fait par chaque sommet d'une mesure à la
  suivante (`motionWGSL` : positions de la mesure précédente gardées sur le GPU, 16 octets
  relus). Mesuré sur le GPU réel, t-shirt jersey : enfilage arrêté à 6,5–7,3 s sous 1 mm/s (5 s
  à 5–6 mm/s avant) ; ourlet soulevé de 25 cm puis lâché, repos à 5,5 s (3 s avant). Même règle
  pour le repli CPU (`RestDetector`, qui comparait déjà les positions : 30 images au lieu de 20).
  Garde-fou : un pli qui glisse sans fin (10 à 20 mm/s pendant plus de 10 s, vu une fois sur un
  ourlet replié sur la poitrine) ne passe jamais le seuil ; arrêt 8 s après le dernier mouvement,
  ou à une fois et demie la durée du vêtement pendant l'enfilage (`restDeadline`).
- [ ] Rigidité réelle des tissés : l'étirement résiduel décroît en h² (10 sous-pas : 7,5 %,
  20 : 2,7 %, 40 : 1 % en haut du devant, denim). Cause mesurée (`npm run bench:physics`) : une
  charge portée le long de N arêtes n'est corrigée que d'environ 1/N² par balayage de Gauss-Seidel
  (bande de denim de 60 cm suspendue : 1,49 % d'allongement au lieu de 0,05 % ; idem pour la tension
  d'un anneau posé sur les hanches). **Fait (2026-11)** : 4 balayages d'étirement et de coutures +
  1 de flexion par sous-pas au lieu de 2 + 2 (`sweepPlan`, CPU et GPU), à coût égal (GPU : 9,45 ms
  par image contre 9,8) : bande suspendue 0,75 %, t-shirt jersey 0,72 % d'étirement moyen au lieu de
  1,81 % sur le GPU (p99 7,2 % au lieu de 16,5 %), flexion à peine plus souple (porte-à-faux de
  12 cm : +1,5 %). L'ancien plan 2 + 2 est gardé jusqu'au démarrage de l'auto-collision : plus
  raide, le tissu ne se dégageait plus des croisements de la couture.
  *Reste* : l'étirement se concentre là où le vêtement porte sur le corps (épaules : 10–20 %
  localement), la raideur effective d'une arête étant bornée par m / h² par balayage.
  Essais non retenus : réappliquer les multiplicateurs du sous-pas précédent (« warm start ») —
  instable au-delà de la moitié avec un seul passage, gain 2 au mieux ; correction multigrille par
  agrégats rigides (les arêtes entre deux plaques résolues ensemble, plaques déplacées en bloc) —
  bande suspendue à 0,12 %, jupe tenue sans ceinture en denim, mais stable sur un tissu fluide
  seulement à demi-gain (sinon le tissu « bout » : plus la flexion est faible, plus c'est instable),
  quelques croisements en marche, et tension seule ou déplacements lissés font pire. À reprendre avec
  un prolongement cohérent avec les multiplicateurs. Vertex Block Descent à la place de XPBD
  (prototype `tools/sim-bench/vbd.ts`, `npm run bench:physics -- --vbd`, mêmes énergies) : à nombre
  de passes GPU voisin, bande suspendue à 0,5–0,7 % (20 sous-pas × 5 balayages) contre 0,75 %, pour
  5 × plus d'arithmétique ; 12 % à grands pas de temps (1 × 100) ; flexion moins bien résolue, sol
  en pénalité traversé de 0,1 à 4 mm. Le départ « adaptatif » de l'article masque l'allongement
  mais la bande ne s'arrête plus. C'est aussi un Gauss-Seidel local : la limite en 1/N² reste.

## 4. Autres vêtements

Catalogue : `lib/pattern/garments.ts` — des **styles** (nom, réglages, tracé, accessoires fournis)
en deux **coupes**, homme et femme : le même tracé parti d'autres réglages (plus près du corps,
cintré, encolure dégagée, manches plus courtes pour la femme ; jupe droite façon kilt pour
l'homme) et sa propre image. Une coupe se trace sur les mesures du mannequin quelle que soit sa
morphologie. 8 styles (2026-11) sur trois blocs qui disent aussi comment le vêtement est posé
avant couture (`kind`) : t-shirt, **manches longues** (jusqu'au poignet, resserrées), **débardeur**
(sans manches : emmanchures libres, bretelle et profondeur réglables), **robe t-shirt** (couture
de côté passant par la taille et la hanche, bas évasé) ; cape, **pèlerine** (cape courte sans
capuche) ; jupe, **jupe longue**. Nouveaux réglages du bloc t-shirt : cintrage à la taille,
encolure abaissée. Nouvelles mesures : épaule-poignet, HPS-taille, taille-sol.
Choix par une fenêtre plein écran de **petites cartes** (6 par rangée : le catalogue doit en
recevoir une cinquantaine) avec une bascule Homme / Femme (`components/GarmentPicker.tsx`, bouton
« Changer » de l'onglet Patron) ; la coupe portée est rappelée sur la carte de l'autre coupe.
Images du vêtement drapé sur le mannequin de sa coupe dans `public/garments/<style>-<coupe>.webp`,
recapturées par `tools/thumbnails/capture.mjs` (mis à jour pour les coupes, **non relancé** : les
16 images ont été prises depuis le volet de test, même cadrage) ;
vérifié au banc (`catalogue: …`, 13 scénarios) : tous cousus et portés sans sommet sous la peau.
*Limites* : la coupe ne change pas le mannequin (la bascule part de la coupe portée) ; pas encore
de pantalon ni de chemise (nouveaux placements : jambes, col, boutonnage) ; la jupe longue
s'arrête 26 cm au-dessus du sol (plus bas, l'ourlet est piétiné à la marche : 875 croisements,
60 à 95 % d'allongement à 10 cm) ; réglages et modifications (avec leur historique) gardés par vêtement. Types communs dans
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
  Bouts des doigts qui traversaient la cape : la collision ne teste que les sommets du tissu, et les
  triangles de la cape (2,2 cm) sont plus larges qu'un doigt ; corrigé en « gonflant » les mains de
  1,2 cm dans le champ de distance (moufle : distance réduite selon le poids de peau des poignets,
  `BodySdf` option `inflate`), commun GPU / CPU.
  Cape éjectée en marchant bras le long du corps : le tissu pincé entre la main et la cuisse se
  croisait ; l'analyse globale des croisements (untangle.ts) découpait alors la cape en milliers de
  fragments (1 région, puis 95, 2 000… 10 000 sur 12 600 sommets en 15 s) et imposait un côté à chacun :
  l'auto-collision poussait presque tout le tissu dans des sens contraires, ce qui créait d'autres
  croisements — emballement jusqu'à l'éjection. Au-delà de 24 régions ou de 5 % du vêtement, l'analyse
  libère désormais les sommets concernés au lieu de les forcer (comme pour un contour ouvert) : 0 à 7
  petites régions pendant toute la marche, cape stable sur 3 essais de 30 s. Essais sans effet, retirés :
  plafonner la vitesse ou le déplacement d'un contact (pire), chercher plusieurs antécédents au repos
  (main et cuisse vues ensemble ; pas d'effet mesurable).
  *Limite* : 50 pages A4 pour la longueur par défaut (le SVG sur traceur est plus adapté).
  **Panneaux éditables en 2D** (2026-11) : dos et devants étaient des arcs de cercle purs, seule la
  capuche avait des points. Ils sont tracés par des points nommés et des courbes de Bézier
  (`PointSet` « cape » : milieu bas et milieu d'encolure du dos, bas et encolure à l'épaule, bas et
  encolure au milieu devant, poignées des courbes du bas et de l'encolure ; quart de cercle par une
  cubique : 0,4 mm d'écart sur le bas). Les deux points de la ligne d'épaule appartiennent au dos et
  au devant à la fois : une modification déplace les deux, la couture d'épaule reste appariée ;
  l'encolure de la capuche se recale sur l'encolure modifiée. L'éditeur cadre désormais les trois
  pièces (la capuche est à un zoom près).
- [x] **Jupe trapèze** (`lib/pattern/skirt.ts`) : devant et dos (au pli), sans pinces (galbe pris
  dans la couture de côté, de la hanche à la taille), évasement réglable, bas d'équerre avec le côté.
  Placement rang par rang : chaque ligne horizontale du patron enroulée sur une ellipse autour de la
  section du corps à cette hauteur (jambes réunies sous l'entrejambe), de périmètre égal à sa largeur.
  **Jupe qui tombait** (corrigé 2026-11, mesuré avec `tools/sim-bench`) : deux causes.
  (1) Au premier sous-pas de la marche, le corps descendait de 11,7 mm et les genoux avançaient de
  48 mm d'un coup (vitesse équivalente : 58 m/s) : le fléchissement du genou et la hauteur du pied
  s'appliquaient en entier au lieu de suivre le fondu de la marche ; à chaque pas, le genou
  « claquait » aussi de quelques mm en se verrouillant en extension (pente infinie de l'angle du
  genou à jambe tendue). Corrigé dans `lib/avatar/motion.ts` (fondu, extension limitée à celle de la
  pose de repos) : plus aucun saut, le point de peau le plus rapide est le pied en oscillation (2 m/s).
  (2) Rien ne retenait la taille sinon l'étirement du tissu, que le solveur sous-estime pour un
  anneau (voir « Rigidité réelle des tissés ») : la taille s'ouvrait de 19 % et passait les hanches,
  même au repos en jersey : sans ceinture, il est normal qu'elle tombe. D'où le réglage
  **« Élasticité de la ceinture »** (onglet Patron, Coupe) : allongement maximal du tour de taille,
  de 0 % (ceinture rigide, par défaut) à 40 % (« sans ceinture » : bord franc, comme avant).
  `Pattern.bands` → contrainte `BandModel` (CPU et GPU) : la longueur du tour de taille ne dépasse
  pas celle du patron × (1 + élasticité) ; un anneau trop long est contracté uniformément autour de
  son barycentre (exact pour le périmètre, sans distorsion, quantité de mouvement et moment cinétique
  conservés ; déplacer les sommets le long du gradient de la longueur déchirait le contour).
  Mesures : en marche (9 s, repli CPU) descente de 2,5 cm (denim) et 4,2 cm (jersey), oscillation du
  bassin comprise ; sur le GPU, ceinture rigide à la taille, 10 % : 11 cm plus bas, sur les hanches ;
  sans ceinture : la jupe tombe. *À faire* : dessiner la ceinture sur le patron et dans les exports
  (largeur, élastique plus court que la taille) ; image du sélecteur à recapturer.
- [ ] Pantalon (entrejambe, jambes).

## 5. Socle technique

- [ ] Tests automatisés des parties de calcul (mesures, tracé du patron, maillage, solveur CPU).
  Premier pas : `tools/sim-bench` (`npm run bench`, `npm run bench:physics`, sonde GPU) mesure le
  solveur — étirement, croisements, pénétration, glissement, temps — sur les vêtements de
  l'application et contre des valeurs analytiques ; voir son README. Pas encore de seuils ni d'intégration continue.
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
- Simulation : 20 sous-pas sur GPU, 10 en repli CPU ; par sous-pas, 4 balayages étirement + coutures
  et 1 de flexion (`sweepPlan`), puis ceintures, auto-collision, contacts (corps puis sol). Toute modification du
  solveur se mesure avant / après avec `tools/sim-bench`. Placement initial sans étirement (ellipse
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
  le temps simulé ; en mode CPU le worker possède la chronologie et envoie la pose avec chaque
  image.
- Cadence en mode GPU (`GarmentViewer.stepGpuGarment`) : **temps réel, toujours** (2026-11) —
  le vêtement se coud et tombe à la vitesse où il le ferait, comme quand la main ou le corps le
  remet en mouvement ensuite. Avant, l'enfilage était en avance rapide (2 à 24 images simulées
  par image affichée, réglé sur l'intervalle mesuré entre deux images) : le réglage suivait mal
  le coût des images, et l'on voyait le vêtement sauter en place à quelques images par seconde ;
  1,5 s après qu'on avait lâché le tissu, l'avance rapide reprenait au compte laissé par
  l'enfilage (23 pour le t-shirt), avec le même effet jusqu'à l'arrêt. Mesuré sur le GPU réel :
  t-shirt posé en 5,6 s simulées = 5,6 s, repos détecté (voir « Repos »).
  *Non mesuré à l'écran* : vérifié en pilotant la boucle image par image (1 à 2 images simulées
  par image), le volet de test étant en arrière-plan.
- Champ de distance du corps : boîte du vêtement (+ chute) bornée à celle du corps (hors de la boîte
  le champ vaut « loin ») ; pas de 1 cm, plus grossier au-delà de 1,5 M cellules (cape).
- Mesures pour les vêtements (`lib/avatar/bodyMeasures.ts`) : tête (hauteur, profondeur, largeur),
  cou (section à l'encolure), taille naturelle, taille → hanche / genou, sections du bas du corps.
- Après un nouvel export du mannequin, la grille d'influences (`BodySdf.skin`) dépend des attributs
  `JOINTS_0` / `WEIGHTS_0` du GLB et de `bones.parents` du JSON.
