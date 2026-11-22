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
- **Pose et mouvement** : squelette d'Anny réduit à 27 articulations (skinning LBS), bras le long du
  corps, marche et course sur place (cadence réglable), postures assise et accroupie ; le tissu suit
  (collision en espace repos).
- **Manipulation** : le tissu se saisit à la souris et se tire, dans tous les onglets ; éditeur 2D
  ouvert, les points du patron se déplacent aussi sur le vêtement en 3D.

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
  *Limites* : les lignes restent celles du vêtement cousu jusqu'à la recouture ; en mode GPU les
  positions sont relues à chaque image (une à deux images de retard pendant la couture) ; les
  poignées de courbe éloignées (ourlet de la cape : 70 cm) flottent loin du vêtement.
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
- [ ] Arrêt de la simulation au repos réellement efficace (mesure du mouvement plus fréquente).
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
  un prolongement cohérent avec les multiplicateurs.

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
  le temps simulé (temps réel pendant un mouvement, avance rapide sinon) ; en mode CPU le worker
  possède la chronologie et envoie la pose avec chaque image.
- Champ de distance du corps : boîte du vêtement (+ chute) bornée à celle du corps (hors de la boîte
  le champ vaut « loin ») ; pas de 1 cm, plus grossier au-delà de 1,5 M cellules (cape).
- Mesures pour les vêtements (`lib/avatar/bodyMeasures.ts`) : tête (hauteur, profondeur, largeur),
  cou (section à l'encolure), taille naturelle, taille → hanche / genou, sections du bas du corps.
- Après un nouvel export du mannequin, la grille d'influences (`BodySdf.skin`) dépend des attributs
  `JOINTS_0` / `WEIGHTS_0` du GLB et de `bones.parents` du JSON.
