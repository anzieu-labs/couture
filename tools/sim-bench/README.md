# Banc de mesure de la simulation

Boucle de rétroaction pour toute modification du solveur : on mesure avant, on change, on
remesure, et on ne garde que ce qui améliore le réalisme sans coûter plus cher (ou l'inverse).

Trois outils, du plus rapide au plus fidèle à ce que voit l'utilisateur.

## 1. Tests physiques (`npm run bench:physics`, ~1 min)

Une bande de tissu seule, sans corps ni couture, comparée à une valeur connue
(`physics.ts`) :

- **bande suspendue** par le haut : sous son propre poids elle s'allonge de ρ g L² / (2 Y).
  Un solveur XPBD pas convergé s'allonge bien plus (l'excès croît avec le nombre de rangs du
  maillage) : c'est la mesure directe de l'étirement parasite. La colonne « peak » dit si la
  bande rebondit quand on la lâche ;
- **porte-à-faux** : une bande tenue à l'horizontale fléchit sous son poids ; comparée au même
  essai avec 8 × plus de sous-pas (la réponse convergée du solveur), elle dit si la flexion
  est assez résolue ;
- **chute sur le sol** : un carré de tissu lâché à 30 cm, à cheval sur le bord du socle, doit
  se poser (dessus du socle d'un côté, sol 4 cm plus bas de l'autre) sans jamais le traverser.

`npm run bench:physics -- '{"stretchSweeps":2,"bendSweeps":2}'` rejoue les essais avec
d'autres réglages du solveur (`ClothParams`).

`npm run bench:physics -- --vbd` rejoue les mêmes essais sur un prototype de solveur Vertex
Block Descent (`vbd.ts`, pour ce banc seulement), à côté du solveur XPBD : mêmes énergies, donc
seule la convergence diffère. Le budget est donné de deux façons — millisecondes sur ce CPU
(l'arithmétique) et passes par image sur un GPU (une passe résout une couleur en parallèle).

## 2. Vêtements sur le mannequin (`npm run bench`, ~3 min)

Les vêtements de l'application, cousus sur le mannequin par défaut par le solveur CPU
(`lib/sim/cloth.ts`, la référence du solveur GPU : mêmes formules), au repos et en marche.
La préparation est celle de l'application (`lib/garment/prepare.ts`) et le mannequin est lu
directement dans `public/mannequin/` (`mannequin.ts`).

```sh
npm run bench -- --label avant                 # enregistre results/avant.json
npm run bench -- --compare avant               # … après la modification : affiche les écarts
npm run bench -- --only skirt --verbose        # un scénario, suivi toutes les 0,5 s simulées
npm run bench -- --cloth '{"substeps":20}'     # avec d'autres réglages du solveur
npm run bench -- --full                        # + réglages du GPU (maillage 1 cm, 20 sous-pas) : lent
npm run bench -- --grab                        # le tissu tenu à la main (voir plus bas), au lieu des scénarios habituels
npm run bench -- --grab --hold '{"force":1.5}' # … avec d'autres réglages de la prise (lib/sim/grab.ts GRAB)
```

Mesures (`metrics.ts`, indépendantes des variables internes du solveur) :

| Colonne | Ce qu'elle dit |
| --- | --- |
| `ms/frame` | temps de calcul par image simulée (1/60 s), médiane des 2 dernières secondes ; détail par phase en tête |
| `strain mean / p99 / max` | allongement des arêtes par rapport au patron à plat. Un tissé (1–2 % sous charge légère) ne devrait montrer qu'une fraction de pour cent : au-delà, c'est le solveur |
| `p99 worst` | pire 99ᵉ centile pendant l'essai : un pic trahit un à-coup (corps qui saute, contact brutal) |
| `cross end / mean / max` | arêtes traversant un triangle non voisin : 0 pour un vêtement sans auto-intersection |
| `pen verts / mm` | sommets sous la peau du corps posé, contre un champ de distance reconstruit dans la pose (indépendant de la collision en espace repos ; distances exactes aux triangles du corps) |
| `skin through / max / mm` | points du corps affiché (sommets et milieux de faces) qui dépassent du tissu, à la fin et au pire de l'essai, et de combien : ce que l'œil voit comme un trou. Les sommets du tissu peuvent tous être où le solveur les veut pendant que la peau passe entre eux (`pen` ne le voit pas) |
| `limbs through %` | part des relevés où un avant-bras, une main, une jambe ou un pied traverse un triangle du tissu : 0 pour un membre resté sous le vêtement (il peut sortir par une ouverture) |
| `drop cm` | descente du haut du vêtement depuis la fin de la couture : au-delà de quelques cm, il glisse |
| `above floor cm` | hauteur du sommet le plus bas au-dessus du sol sur tout l'essai : négative, le tissu a traversé le sol |
| `speed mm/s`, `rest at` | mouvement résiduel à la fin, instant où le détecteur de repos se déclenche |

Avec `--grab`, une main prend le tissu une fois le vêtement tombé (`lib/sim/grab.ts`), le tire
en une demi-seconde, le tient une seconde et le lâche — là où il peut suivre (ourlet soulevé) et
là où le vêtement le retient (ourlet tiré vers le bas, poitrine tirée de côté) :

| Colonne | Ce qu'elle dit |
| --- | --- |
| `held verts` | sommets tenus (le disque de tissu autour du point saisi) |
| `pull asked / moved cm` | déplacement demandé à la main, et celui du point tenu à la fin : égaux, le tissu suit ; très inférieur, le vêtement retient et la prise glisse (force plafonnée) |
| `held p99 / max %` | pire allongement des arêtes pendant la prise : il doit rester borné même quand le vêtement ne peut pas suivre |
| `back to cm` | distance du point tenu à sa position de départ, une fois lâché et retombé |

Les colonnes habituelles (`cross end`, `pen mm`, `strain`) disent dans quel état la prise laisse
le vêtement : à comparer au même vêtement au repos.

Les résultats (`results/`) ne sont pas versionnés : les temps dépendent de la machine.
Le lanceur est Node seul (`register.mjs` résout les imports sans extension) : les boucles du
solveur tournent comme une fois empaquetées, ce qui n'est pas le cas sous `jiti` ou `tsx`
(4 × plus lent sur les contacts).

## 3. Solveur GPU dans le navigateur (`gpu-probe.js`)

Le solveur GPU ne tourne que dans un navigateur WebGPU. En développement (`npm run dev`),
`window.__couture` est le viewer : coller `gpu-probe.js` dans la console puis
`await coutureProbe()` donne, pour le vêtement affiché, le temps GPU par image simulée,
l'allongement des arêtes et la hauteur du haut du vêtement. À comparer à
`npm run bench -- --full` (mêmes réglages sur le solveur CPU) pour vérifier que les deux
solveurs s'accordent.

## Ce que le banc a déjà montré

- un à-coup du corps (1 cm en un sous-pas) suffit à décrocher un vêtement : toujours vérifier
  la continuité d'une animation (`p99 worst`) ;
- l'étirement parasite vient de la convergence, pas des paramètres du tissu : un rang de
  maillage ne transmet qu'une fraction d'une charge par balayage ;
- réappliquer les multiplicateurs du sous-pas précédent (« warm start ») diverge avec un seul
  passage de Gauss-Seidel (stable seulement en dessous de la moitié, soit un gain de 2 au mieux) ;
- tenir le tissu à la main (`--grab`) : ce qui limite la force d'une prise, c'est l'auto-collision.
  Une main qui accélère le tissu plus vite que les passes ne le rattrapent le fait traverser les
  autres épaisseurs, loin du point tenu (là où le vêtement soulevé se tasse, sous les bras) : d'où
  une passe à chaque sous-pas pendant la prise et une accélération plafonnée (`lib/sim/grab.ts`).
  Élargir le disque tenu aggrave les choses (la prise devient plus forte) ;
- la collision se résout dans une pose de référence (`lib/sim/posedBody.ts`), par une
  approximation dont l'erreur croît avec l'écart à cette pose. Tant que la référence était la
  pose A du mannequin (bras à 40°) alors qu'il se tient bras à 20°, le tissu posé sur les épaules
  était jusqu'à 7 mm à côté de la peau affichée : la peau passait au travers (cape au repos :
  37 points visibles, 82 sommets sous la peau jusqu'à 26 mm ; 0 et 0 avec la pose debout comme
  référence, et un contact 7 × moins cher au repos puisqu'il n'y a plus rien à inverser) ;
- la marge peau se règle sur la maille (`prepare.ts` `skinGapFor`) : trop petite, la peau sort
  au milieu des triangles ; trop grande, le tissu n'a plus de place entre le bras et le corps et
  se croise (cape en marche, maille 3,3 cm : 9 mm de marge → 460 croisements, 6 mm → 0 à 13) ;
- le champ de distance du solveur valait, près de la peau, la distance au plan du sommet le plus
  proche : 1 mm d'écart quadratique avec la vraie distance sur épaules et cou, jusqu'à 2,5 mm à la
  base du cou — presque toute la marge. Avec la distance exacte aux triangles (`bodySdf.ts`
  `exactBand`) : 0,24 mm, le reste venant de l'interpolation sur les cellules de 1 cm ;
- la peau ressort d'abord là où le corps est anguleux et les triangles grands : dessus des épaules
  d'une silhouette mince, sous les triangles de bord d'une cape (1,75 × la maille). D'où le
  scénario « cape jersey rest, thin body » (`phenotype`), et un champ gonflé selon sa propre
  courbure (`bodySdf.ts` `inflateSharp`) plutôt qu'une marge uniforme plus grande ;
- borner un membre par une sphère est trop large dès que les bras sont le long du corps : celle
  de l'avant-bras (21 cm) englobait la hanche, dont le tissu recevait le traitement des impacts
  (jupe étirée de 180 %). D'où des capsules (`bodySdf.ts`) ;
- Vertex Block Descent (`--vbd`) ne fait pas mieux que XPBD sur la bande suspendue en denim
  (0,05 % attendu) : à nombre de passes GPU voisin, 0,5 à 0,7 % (20 sous-pas × 5 balayages, 700
  passes) contre 0,75 % (XPBD 20 sous-pas, 860 passes), pour 5 × plus d'arithmétique ; à grands
  pas de temps (1 × 100) la bande s'allonge de 12 % ; la flexion est moins bien résolue
  (porte-à-faux 11,8 cm contre 10,9 ; convergé 10,5) et le sol, en pénalité, se laisse traverser
  de 0,1 à 4 mm. Le départ « adaptatif » de l'article masque l'allongement (0,06 à 0,3 %) mais la
  bande ne s'arrête jamais (10 à 200 mm/s résiduels) : sans convergence, le point de départ des
  itérations fait partie de la dynamique ;
- une correction multigrille par agrégats rigides divise l'allongement d'une bande suspendue
  par 10, mais n'est stable sur un tissu fluide qu'à demi-gain et crée des croisements en marche :
  piste à reprendre (voir ROADMAP).
