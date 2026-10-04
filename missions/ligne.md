# La ligne de la Valbrune, une année de trains en montagne

Le livrable est une **vallée de montagne vivante, en 3D plein écran**, dans une page ouvrable en
double-clic, dans le dossier partagé indiqué par tes consignes : celle de la **Valbrune**, où une ligne à
voie unique monte de **Valbrune-Plaine (420 m)** au **Col-du-Sorbier (1 780 m)**, avec une branche vers la
carrière d'ardoise de la Lèze. On y suit **toute l'année 2027, minute par minute** : les trains roulent
selon leur horaire, se croisent dans les gares qui le permettent, s'attendent, prennent du retard, et
ces retards se propagent ; la neige tombe, ralentit puis ferme la voie jusqu'au passage du chasse-neige ;
une avalanche coupe la ligne ; des voyageurs attendent sur les quais, montent, ou renoncent ; la carrière
entasse son ardoise.

Et l'on n'est pas seulement spectateur : **on tient le poste du régulateur**. On change des réglages, on
ajoute ou retire un train de l'horaire, on ferme un canton, et **toute l'année se recalcule**, avec ses
retards en cascade, et la page montre ce que la décision a changé.

**Le fil de toute la page : on voit le temps passer dans la montagne.** Le jour se lève et tombe, les
saisons changent la vallée (la neige sur les pentes l'hiver, les alpages verts l'été), les trains
avancent sur la ligne à leur vraie place de la minute, les signaux passent du vert au rouge quand un
canton s'occupe. C'est ce que le juge regardera d'abord.

La mission demande **quatre choses à la fois**, et aucune ne passe avant les autres :

- **l'exactitude** : la ligne suit des règles précises (plus bas), en nombres entiers, et le juge
  recalculera l'année entière, y compris sur des changements que cette mission ne cite pas ;
- **le détail** : **le plus de détails possible, partout**. Rien n'est esquissé : chaque gare, chaque
  ouvrage, chaque train, chaque village, chaque panneau du poste de commande est travaillé à fond ;
- **la beauté** : la 3D **occupe toute la page**, du bord gauche au bord droit et de haut en bas, et
  l'interface se pose par-dessus ; une vallée qu'on a envie de regarder longtemps, faite pour l'écran
  d'ordinateur, du portable au grand écran ;
- **l'amélioration** : la page est **améliorée** sur trois plans — le design, les fonctionnalités,
  l'aspect de la 3D — et l'amélioration est prouvée (plus bas).

Beaucoup de choses ici **n'ont pas une seule bonne réponse** (à quoi ressemble un viaduc de pierre ou une
gare de montagne, comment montrer un an de circulation sans noyer l'œil, ce que le poste de commande
doit montrer d'abord). Le découpage, les fichiers et la façon de travailler sont à vous.

## Type

simulation

## Les données fournies

Onze fichiers : ils sont la seule source de vérité.

- `gares.csv` : les dix gares (neuf sur la ligne principale, la carrière au bout de la branche) : code,
  nom, ligne, point kilométrique (km), altitude (m), longueur de la voie de croisement (m ; `0` = simple
  halte où l'on ne croise pas ; `999` = terminus), voyageurs par jour, village.
- `ouvrages.csv` : tunnels et viaducs, avec leur ligne et leurs points kilométriques de début et de fin.
- `materiel.csv` : les cinq types de trains : priorité (1 passe d'abord), vitesse sur le plat et en
  descente (km/h), longueur (m), places assises, charge d'ardoise (t).
- `trace.csv` : le tracé posé sur la carte, un point tous les 500 m : ligne, point kilométrique, position
  `x`, `y` en cases de la carte, altitude.
- `relief.txt` : l'altitude (m) de chaque case d'une carte de **64 × 40 cases de 750 m** (une ligne de
  texte par rangée, du nord au sud).
- `carte.txt` : ce qui couvre chaque case : `.` pré, `^` forêt, `r` rocher, `*` neige éternelle,
  `~` rivière, `v` village, `q` carrière.
- `meteo.csv` : les 365 jours de 2027 : température à midi à Valbrune-Plaine (°C), neige tombée (cm),
  pluie (0/1), brouillard (0/1).
- `horaire.csv` : les trains : numéro, type, gare de départ, terminus, heure de départ, jours, saison,
  arrêts.
- `evenements.csv` : les événements de l'année : dates, nature, lieu, heures, valeur, récit.
- `demande.csv` : d'où viennent les voyageurs : la part de la journée qui arrive chaque heure, pour
  chaque sorte de jour, et le coefficient de chaque mois.
- `reglages.csv` : les six réglages du régulateur, avec leurs bornes et leur valeur par défaut.

## Les règles de la ligne

Tout se compte **en nombres entiers**. `a // b` est la division entière arrondie vers le bas ;
« arrondi au-dessus » est la division arrondie vers le haut.

**Le calendrier.** L'année est 2027 ; le 1er janvier est un vendredi. Un train circule le jour `d` si
la lettre du jour est dans sa colonne `jours` — `S` du lundi au vendredi, `A` le samedi, `D` le
dimanche, et `M` ajoute le mercredi — et si sa `saison` le permet : `toute` ; `ete` du 21 juin au
22 septembre inclus ; `neige` : tous les jours où de la neige est tombée ce jour-là ou la veille (quelle
que soit la colonne `jours`). Chaque circulation se nomme par son numéro et sa date.

**Le parcours.** La ligne principale va de VP à CS dans l'ordre de `gares.csv` ; la branche relie PV
à CL. Un train parcourt les gares de son départ à son terminus. Il **dessert** toutes les gares si ses
`arrets` valent `toutes`, sinon celles de la liste, plus son départ et son terminus ; il passe les
autres sans s'arrêter. Un **tronçon** est le chemin entre deux gares consécutives du parcours.

**La vitesse et le temps d'un tronçon.** Sa longueur est la différence des points kilométriques, en
mètres (sur la branche, PV est au point 0 et CL au point 4 500). Sa pente, en ‰, vaut
`|altitude d'arrivée − altitude de départ| × 1000 // longueur`. Un train **monte** si l'altitude
d'arrivée est plus haute. Sa vitesse `v` (km/h, entière) est `vitesse_plat × (100 − pente) // 100` en
montée, `vitesse_descente` en descente ; sous la neige (plus bas), `v = v × vitesse_neige // 100`. Dans
les tunnels du tronçon, la vitesse est `min(v, 40)`. Le temps, en secondes, est la somme de
`3600 × mètres hors tunnel / (1000 × v)` et de `3600 × mètres en tunnel / (1000 × min(v, 40))`, chacun
arrondi au-dessus ; le temps en minutes est ce total divisé par 60, arrondi au-dessus.

**Les arrêts.** Dans une gare qu'il dessert (hors départ et terminus), un train s'arrête
`arret_omnibus` minutes s'il est omnibus, 2 s'il est express, 5 s'il est touristique, 0 sinon. Une
panne (événement) ajoute ses minutes à l'arrêt dans la gare indiquée, ce jour-là.

**L'horaire théorique** d'une circulation part de son heure de départ, puis enchaîne ses tronçons **sans
neige** et ses arrêts : il donne l'heure prévue d'arrivée et de départ à chaque gare. **Le retard** à une
gare est l'heure réelle d'arrivée moins l'heure prévue d'arrivée (au départ : les heures de départ).

**Les cantons.** Les gares à voie de croisement (croisement ≥ 1) coupent la ligne en six cantons :
VP-SA, SA-PV, PV-OH, OH-PS, PS-CS et PV-CL. **Un canton porte un seul train à la fois**, quel que soit le
sens : il est occupé depuis le départ du train de la gare à croisement d'une extrémité jusqu'à son
arrivée à celle de l'autre. Les haltes sont à l'intérieur des cantons : on s'y arrête, on n'y croise pas.

**Les gares à croisement** (les deux terminus VP et CS et le terminus CL exceptés, qui reçoivent sans
limite) reçoivent **au plus deux trains**, en comptant ceux qui y sont et ceux qui roulent vers elles
dans un canton voisin ; et quand il y en a deux, **l'un des deux doit tenir sur la voie de croisement**
(longueur du train ≤ longueur de la voie).

**La neige.** Chaque canton a une épaisseur de neige, en cm, à 0 le 1er janvier ; son altitude est la
moyenne entière des altitudes de ses deux gares (`(a + b) // 2`). La neige du jour tombe en deux fois :
`neige // 2` à 6 h 00, le reste à 14 h 00 ; chaque canton reçoit `part × altitude // 1000`. À 12 h 00, la
température d'un canton vaut `température_midi − 6 × (altitude − 420) // 1000` ; si elle dépasse 0,
l'épaisseur baisse de `température × fonte` (sans descendre sous 0). Au-delà de **10 cm** au moment où un
train part d'une gare, les trains autres que le chasse-neige roulent à `vitesse_neige` sur ce tronçon ; au-delà de `seuil_neige`, ils n'entrent plus dans
le canton. Le chasse-neige, en arrivant au bout d'un canton, le remet à 0.

**Les événements.** `avalanche`, `travaux`, `eboulement` (et les fermetures du régulateur) ferment un
canton de l'heure `debut` à l'heure `fin` incluses, chaque jour de `du` à `au` : aucun train n'y entre
(celui qui y roule déjà continue). `panne` : `valeur` = `numéro:minutes`. `fete` : la demande de la gare
est multipliée par `valeur` / 100 ce jour-là.

**Chaque minute**, du 1er janvier 0 h 00 au 31 décembre 23 h 59, se déroule dans cet ordre :

1. à 0 h 00, la carrière produit `production_ardoise` tonnes, qui s'ajoutent au quai de chargement ;
   à 6 h 00 et 14 h 00, la neige tombe ; à 12 h 00, elle fond ;
2. à chaque heure pile, les voyageurs arrivent sur les quais (plus bas) ;
3. les circulations dont l'heure de départ est venue entrent en gare de départ ;
4. les trains au bout de leur tronçon arrivent : les voyageurs pour cette gare descendent (si elle est
   desservie) ; à une gare à croisement, le train libère son canton ; au terminus, il a fini ;
   sinon, il reste en gare le temps de son arrêt ;
5. les départs : un train part quand son arrêt est fini **et** que l'heure prévue de départ de cette gare
   est venue (jamais en avance). D'une halte, il repart aussitôt. D'une gare à croisement, il demande le
   canton suivant ; **canton par canton, dans l'ordre VP-SA, SA-PV, PV-OH, OH-PS, PS-CS, PV-CL**, les
   trains qui le demandent sont rangés par priorité (1 d'abord), puis du plus en retard au moins en
   retard (retard = minute présente − heure prévue de départ de cette gare), puis par numéro, puis par
   date ; le premier qui n'a **aucun obstacle** part, les autres attendent. Les obstacles, vérifiés dans
   cet ordre, donnent la **cause d'une attente** : `fermeture`, `neige`, `canton occupé`, `gare pleine`,
   `croisement trop court` ; celui qui n'a pas d'obstacle mais voit un autre partir attend pour
   `priorité`. Au départ d'une gare desservie, les voyageurs montent ; au départ de CL, un train de
   marchandises charge `min(quai, 300)` tonnes ;
6. une circulation encore à sa gare de départ **180 minutes** après son heure est **supprimée** ; un train
   arrêté dans une gare **360 minutes** après son heure prévue de départ de cette gare y est **limité** :
   il s'arrête là, ses voyageurs descendent ;
7. les voyageurs qui attendent depuis plus de `attente_max` minutes renoncent.

**Les voyageurs.** À chaque heure pile `h` du jour `d`, pour chaque gare `i` qui a des voyageurs et
chaque autre gare `j` qui en a, il arrive sur le quai de `i` un groupe de
`Vi × Vj × P × M × F // (Si × 1000 × 100 × 100)` voyageurs pour `j`, où `Vi` et `Vj` sont les voyageurs
par jour des deux gares, `Si` la somme des voyageurs par jour de toutes les gares sauf `i`, `P` la part
de l'heure `h` (pour mille) selon la sorte de jour (`S`, `A`, `D` ; le mercredi est un `S`), `M` le
coefficient du mois et `F` la fête (300 un jour de fête à `i`, sinon 100). Les groupes font la queue
dans l'ordre d'arrivée (et, à la même heure, dans l'ordre de `gares.csv`). Quand un train part d'une
gare qu'il dessert, les groupes montent dans l'ordre de la queue s'il dessert plus loin leur
destination, tant qu'il reste des places (un groupe peut monter en partie). Les voyageurs à bord
descendent à leur destination.

**Le bilan de l'année** compte : circulations, arrivées au terminus, supprimées, limitées, ponctualité
(part des arrivées au terminus avec un retard ≤ 5 minutes, à un dixième près), retard moyen et
maximal au terminus, voyageurs montés, voyageurs qui ont renoncé, tonnes d'ardoise arrivées à VP,
quai de la carrière le plus haut et au 31 décembre.

**La place d'un train** à une minute `t` : de son heure de départ à son arrivée au terminus, il est
à l'arrêt en gare entre son arrivée et son départ, et sur un tronçon entre son départ et son arrivée à
la gare suivante ; là, son point kilométrique (en mètres) est
`pk départ + (pk arrivée − pk départ) × (t − départ) // (arrivée − départ)`.

## Ce que le juge fera, sans lire aucune doc

**Regarder la vallée vivre :**

- ouvrir la page en double-clic : la vallée en 3D **plein écran**, le 1er janvier 2027 à 6 h 00 ;
- lancer le temps (de ×1 à ×3600) et aller à n'importe quelle date et heure ; chaque train est à sa
  place de la minute, au point kilométrique près, et **chaque signal** de canton dit s'il est libre ou
  occupé ;
- regarder quatre moments : **un matin d'hiver sous la neige, un midi d'été, un soir de fête, la
  journée de l'avalanche** ; le ciel (soleil et lune à leur place pour la date et l'heure, étoiles,
  nuages de la météo), l'horizon et les montagnes lointaines, la brume, le relief habillé selon
  l'altitude et la saison (prés, forêts, rocher, neige éternelle, neige de l'année à l'épaisseur du
  canton), la rivière qui coule, la pluie, la neige qui tombe, le brouillard ;
- s'approcher de **chaque gare** (toutes différentes), **chaque ouvrage** (portails de tunnel, viaducs de
  pierre à arches, le tunnel hélicoïdal), **chaque village** (maisons, église), **la carrière**, **chaque
  type de train** (locomotive et voitures qui suivent la courbe, phares et fenêtres éclairées la nuit, le
  chasse-neige qui projette la neige) et les **voyageurs sur les quais**, aussi nombreux qu'ils
  attendent ;
- passer d'une caméra à l'autre : vue libre, suivre un train, **cabine du conducteur**, quai d'une gare,
  survol de la vallée ; la 3D reste fluide (au moins 30 images par seconde) ;
- écouter : aucun son avant le premier geste ; ensuite la saison, les trains, les cloches, le vent ; un
  bouton coupe et remet.

**Lire la ligne :**

- le **graphique de circulation** d'une journée au choix (la distance en hauteur, le temps en largeur,
  chaque train une ligne) : l'horaire prévu et la circulation réelle superposés, les croisements, les
  attentes ;
- le tableau des départs de chaque gare, à l'heure affichée, avec retards ;
- la fiche d'un train (son horaire prévu et réel gare par gare, ses retards, **où et pourquoi il a
  attendu**, ses voyageurs) et la fiche d'une gare (sa voie de croisement, ses trains, son quai, sa
  neige) ;
- le bilan de l'année, et des chiffres par mois.

**Tenir le poste du régulateur :**

- changer chacun des six réglages, ajouter un train (type, départ, terminus, heure, jours, saison,
  arrêts), en supprimer un, fermer un canton une date donnée entre deux heures : **l'année entière se
  recalcule en moins d'une seconde**, et la page montre ce qui a changé par rapport à l'année d'avant
  (bilan côte à côte, trains touchés) ; revenir en arrière remet tout ;
- le juge essaiera **au moins trois changements que cette mission ne cite pas**.

**Partout :**

- l'interface se pose sur la 3D sans jamais la remplacer ; une touche cache toute l'interface ;
- fermer la page puis la rouvrir retrouve la date, la caméra, les réglages et les changements du
  régulateur ;
- aux tailles **1280 × 720, 1366 × 768, 1440 × 900, 1920 × 1080 et 2560 × 1440**, la 3D remplit toute la
  fenêtre, aucun texte ne déborde ni n'est coupé, rien ne défile de côté ;
- le premier écran s'affiche en moins de trois secondes.

**Pour le juge, chaque élément doit être très détaillé** : c'est le point le plus important de sa
visite. Il regardera de près, et une forme simple là où l'on attendait un objet travaillé lui coûte.

**Et il sortira de ce qui est écrit ici** : il choisira d'autres dates, d'autres trains, d'autres
changements.

## La 3D : PlayCanvas

**La 3D se fait avec le moteur PlayCanvas** (https://playcanvas.com), dans sa version **2.22.4**, dont
le fichier `build/playcanvas.min.js` du paquet `playcanvas` sur npm se charge comme un script classique
(il définit `pc`). Le télécharger est permis, pour le mettre dans le dossier livré ; la page ouverte
hors ligne ne charge ensuite rien d'internet.

**Le juge est très exigeant sur la qualité visuelle.** Il regarde la vallée comme on regarde un beau
jeu vidéo de montagne : la lumière, les matières, les ombres, la profondeur, les détails de près.

## L'amélioration, prouvée

Les améliorations portent sur trois plans : **le design** (lisibilité, hiérarchie, ergonomie du poste de commande), **les fonctionnalités** (ce qui
manque à un régulateur, ce qui est lourd à faire), **l'aspect de la 3D** (lumière, matières, détails,
mouvement). `AMELIORATIONS.md` décrit chaque amélioration : ce qui n'allait pas, ce qui a changé, qui l'a
faite, le numéro du message du fil où elle a été décidée, et **une image avant et une image après**,
dans le dossier livré. Le juge ouvre les images : la différence doit se voir.

## Les décisions, et ce qui a changé grâce aux autres

`DECISIONS.md` raconte les choix : ce qui a été décidé, qui l'a proposé, qui s'y est opposé et
pourquoi, comment la salle a tranché, et ce qui a changé grâce à la question d'un autre, chacun avec les
numéros des messages du fil : **chaque message cité doit exister, écrit par la personne nommée**. Il dit
aussi ce qui reste en désaccord.

`MODE-D-EMPLOI.md` explique, pour quelqu'un qui n'a pas lu cette mission, où est chaque chose et comment
faire chaque geste du juge.

## C'est fini quand

**Le bilan de l'année, avec les réglages par défaut** : **8 326 circulations**, **8 239 arrivées** au
terminus, **28 supprimées**, **59 limitées**, **ponctualité 48,6 %**, **593 386 voyageurs montés**,
**269 430 qui ont renoncé**, **86 220 tonnes** d'ardoise arrivées à Valbrune-Plaine, un quai de carrière
monté au plus à **1 200 tonnes**, vide le 31 décembre.

**Des trains :** l'express 203 du **3 février** arrive au Col-du-Sorbier avec **60 minutes** de retard
(sa panne à Pont-de-Vausse) ; l'omnibus 101 du **11 novembre**, avec **50 minutes**. Le **12 février à
8 h 17**, trois trains roulent : le 202 au point **20,150 km**, le 103 à **9,800 km** et le 104 à
**37,333 km**. Le **14 janvier**, jour de l'avalanche entre Orcel-le-Haut et Praz-Sauvage, des trains
sont supprimés et limités, et la fiche de chacun dit pourquoi.

**Les réglages :** avec une patience de 120 minutes, **89 247** voyageurs renoncent ; avec
600 tonnes produites par jour, **152 100 tonnes** arrivent à Valbrune-Plaine et **65 400** restent au quai
le 31 décembre ; avec un arrêt de l'omnibus de 3 minutes, la ponctualité tombe à **47,5 %**.

**Le reste :** tous les gestes du juge marchent ; `bun test` passe, et couvre les règles de la ligne ;
`AMELIORATIONS.md`, `DECISIONS.md` et `MODE-D-EMPLOI.md` sont écrits.

## Livrable

index.html

## Vérification

bun test
node {DEPOT}/src/voir.ts --partage . index.html --parcours
