# Le Refuge du Sarrat, une soirée qui vit

Mission écrite le 27/09, suite des missions « restaurant » et « restaurant-2 » du même jour. Le livrable est
**l'application complète d'un restaurant**, dans le dossier partagé indiqué par tes consignes, ouvrable en
double-clic, sans serveur et sans internet : celle du **Refuge du Sarrat**, trente tables en salle, en
terrasse et en mezzanine (cent dix places), une cuisine à quatre postes, un bar. Ceux qui s'en servent :
les serveurs sur une **tablette**, les cuisiniers sur un **écran d'ordinateur** au passe, le patron sur son
**téléphone** comme sur son ordinateur.

L'application a **huit pages**, et **chaque geste sur l'une se voit sur les autres**, en direct : une
commande prise en salle part en cuisine, le plat prêt prévient la salle, les ingrédients sortent du stock,
un plat en rupture disparaît de la prise de commande, l'addition réglée libère la table et fait monter le
chiffre du jour. Plusieurs pages restent ouvertes en même temps, chacune dans sa fenêtre, sur des écrans de
tailles différentes : **ce qui change dans une fenêtre apparaît dans les autres en moins d'une seconde, sans
recharger**.

**La finalité de cette mission : voir l'application vivre un service du soir entier** (plus bas, « La
soirée »), et que tout ce qu'elle montre corresponde.

Le découpage, les fichiers, les rôles et la façon de travailler sont à vous.

## D'où l'on part

La version précédente est celle du run du 27/09 `restaurant-2`, dans
`runs/2026-09-27T13-52-50/partage/` (lecture seule ; son historique git est
dans le même dossier, sa salle dans `../tableau.sqlite`). Elle tenait douze tables ; le restaurant en a
maintenant trente. Ce qu'elle fait bien se garde, ce qu'elle fait mal se répare, et rien de ce qui marchait
ne casse.

Un juge a suivi trois clients de bout en bout dans cette version (6/10 pour le parcours ; détail, script et
captures dans `runs/2026-09-27T13-52-50/juge/parcours/`). Ce qu'il a constaté :
une table débarrassée garde l'état du repas précédent ; la cuisine peut lancer une suite que la salle n'a
pas réclamée ; une table réservée bientôt est proposée à un client sans réservation ; la liste d'attente
n'annonce aucune attente ; le temps d'attente d'une suite compte depuis la commande et non depuis sa
réclamation ; reculer l'horloge donne des repas de durée négative ; au paiement par articles, ce qui est
déjà payé reste cochable ; la fiche de la table n'a pas l'heure de service, de l'addition ni du départ, et
disparaît au débarrassage ; rien ne propose de table à un client sans réservation ; le plan montre des
tables, pas des clients ; on encaisse une table dont des plats prêts n'ont jamais été servis ; les
notifications recouvrent encore des boutons sur tablette.

## La soirée

Le juge veut **voir vivre l'application pendant un service du soir complet, de 19 h à la fermeture** :
**220 couverts**, dont **la moitié sur réservation** et la moitié sans.

- **Rien n'est écrit d'avance.** La soirée se tire **au hasard pendant qu'elle se joue** : les
  appels de réservation, qui arrive, quand, à combien, en retard, en avance ou pas du tout ; les
  clients sans réservation ; ce que chaque table commande, suite après suite ; le temps passé en cuisine
  et à table ; le café, le digestif ; la façon de régler. Deux soirées ne se ressemblent jamais.
- **Aucune liste d'arrivées n'est préparée.** Ni l'ordre ni l'heure d'arrivée d'un client, réservé ou
  non, n'est connu avant l'instant où il arrive : un nouveau client sans réservation naît au moment où il
  pousse la porte ; **une réservation naît au moment où le téléphone sonne**, dans l'après-midi (la
  soirée commence avant le service, salle vide) ou pendant le service pour plus tard, et elle suit la
  règle des réservations à cet instant ; ensuite, si le client réservé vient, quand et à combien se décide
  au moment même. Arrêtée à n'importe quel instant, l'application ne contient
  aucune arrivée future.
- **La soirée passe par les mêmes règles et les mêmes pages qu'un vrai service** : ce qui arrive se voit
  sur le plan de salle, la prise de commande, la cuisine, la caisse, les stocks et le tableau de bord, comme
  si des serveurs et des cuisiniers le faisaient. À tout moment, le juge peut **reprendre la main**, faire
  un geste lui-même au milieu de la soirée, et la soirée continue avec.
- **Les problèmes d'un vrai service arrivent** : la salle pleine et la file d'attente qui s'allonge, la
  cuisine débordée, un plat en rupture au milieu du service, une réservation en retard ou qui ne vient pas,
  un groupe plus grand que prévu, un client qui attend trop. **Chacun se voit quand il arrive, et sa
  solution se trouve à l'instant même**, comme un bon restaurant la trouverait ; aucun client ne reste
  bloqué ; ce qui ne peut pas se résoudre se dit, avec la raison.
- **Ce qui peut s'anticiper s'anticipe** : un problème qui approche (la salle qui va être pleine, une
  réservation qui va manquer de table, un ingrédient qui va manquer, la cuisine qui va déborder) se voit
  **avant** d'arriver, et la solution se prend à temps ; le juge compte les problèmes vus venir et ceux
  qui ont surpris.
- **Le visuel reflète toute la soirée** : chaque arrivée, chaque réservation, chaque commande, chaque
  problème, ce qui a été anticipé et chaque solution se voient au moment où ils arrivent ; rien ne se passe
  hors de l'écran ; et, la soirée finie, le juge relit dans le visuel **la soirée entière**, du premier appel
  à la fermeture, avec ce qui s'est passé et quand.
- **Le juge regarde la soirée entière en quelques minutes**, peut la ralentir, l'arrêter, la reprendre,
  la relancer, et en suivre un moment à la vitesse réelle. **D'un coup d'œil, il comprend la vie du
  restaurant** : où sont les clients, ce qui attend, ce qui brûle, ce qui rapporte, et comment la soirée
  se déroule.
- **Tout correspond** : à la fin, chaque couvert arrivé est passé par le parcours complet ou dit pourquoi
  il ne l'a pas fini ; le chiffre, la TVA, les couverts, le ticket moyen, les attentes, la durée moyenne
  d'un repas, les articles vendus, les stocks et leur valeur, l'archive de la journée sont exactement ce
  qui s'est passé à l'écran ; le même chiffre a la même valeur sur toutes les pages.

## Ce qui compte d'abord : le design et l'expérience

**Le juge note d'abord le design et l'expérience d'usage**, avant l'exactitude et avant le nombre de
fonctions. Il cherche une application qu'un restaurant aurait envie d'acheter, pas un prototype :

- **le design** : une identité propre au Refuge du Sarrat (couleurs, typographie, icônes, ton des textes),
  tenue sur les huit pages ; une hiérarchie claire (ce qui compte se voit d'abord), des espacements
  réguliers, des états visibles (libre, occupée, en retard, en rupture, prête) qui se lisent d'un coup d'œil,
  y compris de loin sur l'écran de la cuisine ; un mode sombre pour la cuisine et le soir ; rien de gris
  par défaut, rien d'esquissé ;
- **un design plus soigné que la version précédente**, qui va plus loin que des couleurs et des cadres :
  images, illustrations, photos des plats, icônes, animations, ou tout autre moyen que la salle choisit,
  faits par elle, rangés dans le dossier et affichés sans internet ; le juge compare chaque page, et la
  soirée, à la version précédente ;
- **l'expérience** : chaque geste fréquent se fait en peu de touches et sans chercher (installer une table,
  prendre une commande, marquer « prêt », encaisser) ; une cible de doigt est assez grande sur téléphone et
  tablette ; chaque action se confirme par un retour visible et **s'annule** quand c'est possible ; une
  erreur dit ce qui s'est passé et comment la réparer ; une page vide dit quoi faire ; rien ne bloque un
  serveur pressé (pas de fenêtre qui s'ouvre sans raison, pas de chargement qui fige) ; le clavier et les
  lecteurs d'écran fonctionnent ;
- **le rythme d'un service** : l'application reste lisible et rapide avec trente tables pleines, une file
  d'attente, cent lignes en cuisine et plusieurs fenêtres ouvertes, pendant toute la soirée.

Le juge comparera l'application aux bons logiciels de caisse et de cuisine qu'il connaît.

## Les données fournies

Cinq fichiers, seule source de vérité :

- `tables.csv` : les trente tables, leur zone et leur nombre de places ;
- `carte.csv` : les vingt articles de la carte : code, nom, catégorie, prix TTC en centimes, taux de TVA
  (10 ou 20 %), poste qui le prépare (`froid`, `chaud`, `dessert`, `bar`) ;
- `recettes.csv` : ce qu'une portion de chaque article consomme, ingrédient par ingrédient ;
- `ingredients.csv` : chaque ingrédient, son unité, son stock de départ, son seuil d'alerte, son stock
  cible, son fournisseur et son prix d'achat en centimes par unité ;
- `reservations.csv` : les réservations déjà prises (aucune ce soir : celles de la soirée se tirent au
  hasard).

## Les huit pages

Chacune s'ouvre directement à son adresse, dans sa propre fenêtre :

| Adresse | Page |
|---|---|
| `index.html#salle` | le plan de salle |
| `index.html#commande` | la prise de commande |
| `index.html#cuisine` | l'écran de la cuisine |
| `index.html#caisse` | la caisse |
| `index.html#reservations` | les réservations |
| `index.html#carte` | la carte et les recettes |
| `index.html#stocks` | les stocks et les fournisseurs |
| `index.html#tableau` | le tableau de bord du patron |

`index.html` seul ouvre un accueil qui mène aux huit.

## Le parcours d'un client, d'un bout à l'autre

Chaque étape déclenche la suivante, se voit sur les pages concernées, et **rien ne se saisit deux fois** :

1. **L'arrivée** : un client avec réservation est retrouvé par son nom et installé à sa table ; un client
   sans réservation reçoit la plus petite table libre qui a assez de places (la règle des réservations) ;
   s'il n'y en a pas, il entre sur une **liste d'attente**, avec l'attente annoncée, et la première table
   libérée assez grande lui est proposée.
2. **La commande** : boissons, entrées, plats et desserts se prennent en une fois ou en plusieurs ; chaque
   ligne porte sa **suite** (`boisson`, `entrée`, `plat`, `dessert`). Les boissons partent au bar tout de
   suite ; la première suite de cuisine part à l'envoi ; **les suites suivantes attendent en cuisine**,
   affichées « en attente », jusqu'à ce que la salle les **réclame**.
3. **La préparation** : chaque poste voit ses lignes, les passe `en préparation` puis `prêtes` ; quand une
   suite entière est prête pour une table, la salle en est prévenue sur le plan de salle **et** sur la
   prise de commande.
4. **Le service** : la salle marque la suite `servie` ; la table affiche où elle en est (« entrées
   servies », « plats réclamés », « plats servis », « dessert en préparation »…) ; réclamer la suite
   suivante la fait passer en cuisine.
5. **La fin du repas** : le café et le digestif se commandent et se servent comme le reste ; la table
   demande l'**addition**, qui s'affiche à la caisse sans rien ressaisir.
6. **Le règlement** : en une fois, en parts égales ou par articles, en carte, en espèces ou les deux, dans
   tous les cas ; la table passe `à débarrasser`.
7. **Le débarrassage** : la table redevient `libre`, et si la liste d'attente a un client qui y tient, elle
   lui est proposée.
8. **Le chiffre** : à chaque étape, le tableau de bord, les stocks et le plan de salle suivent.

**Chaque étape se comprend d'elle-même.** Un serveur, un cuisinier ou le patron qui découvre
l'application voit, à chaque instant, où en est chaque client dans son parcours, ce qui vient d'arriver,
et ce qui peut se faire ensuite, sans explication ni mode d'emploi ; le passage d'une étape à la suivante
se voit, dans chaque fenêtre concernée. **La manière d'y arriver est à trouver** : le juge ne cherche pas un
dessin précis, il juge si le parcours se lit et se fait sans hésiter, et si le design de chaque étape est
meilleur que dans la version précédente.

Le temps passé à chaque étape se lit sur la fiche de la table (arrivée, commande, chaque suite prête et
servie, addition, départ), et le tableau de bord donne la **durée moyenne d'un repas** (de l'installation au
règlement, sur les tables réglées, arrondie à la minute).

## Les règles du restaurant

Tout se compte en **nombres entiers** : les prix en centimes, les quantités dans l'unité de
`ingredients.csv`, le temps en minutes. « Arrondi » veut dire au plus proche, et au-dessus à égalité.

**L'heure du restaurant.** L'application a une horloge : l'heure réelle par défaut, et une heure qu'on peut
régler (pour saisir un service passé ou avancer le temps) ; toutes les heures ci-dessous sont celles de cette
horloge, et toutes les fenêtres ouvertes partagent la même.

**Une table** est `libre`, `réservée`, `occupée` ou `à débarrasser`. Elle est `réservée` de 15 minutes avant
l'heure d'une réservation qui lui est attribuée jusqu'à l'installation des clients ; si personne n'est
installé 15 minutes après l'heure, la réservation passe « non venue » et la table redevient `libre`. On
**installe** des clients à une table libre ou réservée (avec leur nombre de couverts, au plus ses places) :
elle est `occupée`. Une fois l'addition entièrement réglée, elle est `à débarrasser`, puis `libre` quand on la
débarrasse.

**Une réservation** reçoit, à sa création, la **plus petite table libre de toute la période** qui a assez de
places (à places égales, la plus petite dans l'ordre de `tables.csv`) ; la période va de 15 minutes avant son
heure à 90 minutes après. Sans table possible, la réservation est refusée et le motif s'affiche.

**Une commande** appartient à une table occupée. Ses lignes (un article, une quantité, une note libre) sont
**envoyées en cuisine** ensemble. À l'envoi, pour chaque portion, les ingrédients de la recette **sortent du
stock**. Un article est **en rupture** quand un de ses ingrédients a un stock inférieur à ce qu'une portion
consomme : on ne peut plus le commander, et il apparaît comme tel partout où la carte se montre. Une ligne
peut être **annulée** tant qu'elle n'est pas `en préparation` : ses ingrédients reviennent au stock.

**En cuisine**, chaque ligne envoyée passe par `envoyée`, `en préparation`, `prête`, puis `servie` (en
salle). L'écran de la cuisine montre les lignes par poste, dans l'ordre d'envoi. Quand toutes les lignes
d'un même envoi pour une table sont `prêtes`, la salle en est prévenue sur le plan de salle et sur la prise
de commande. **Le temps d'attente** d'une ligne est la minute où elle est `prête` moins la minute de son envoi.

**L'addition** d'une table est la somme des prix TTC de ses lignes non annulées ; un article peut être
**offert** (prix 0, le geste est gardé avec son auteur et sa raison). La TVA se calcule **par taux** sur le
total TTC de ce taux : `TVA = arrondi(TTC × taux / (100 + taux))`, et `HT = TTC − TVA`. L'addition se règle :

- **en une fois**, ou **en parts égales** entre `n` personnes : chaque part vaut `total // n`, et les
  `total − n × (total // n)` premières parts ont un centime de plus ;
- **par articles** : chacun paie les lignes qu'il choisit ;
- en **carte**, en **espèces** (la monnaie à rendre s'affiche) ou les deux ; plusieurs paiements
  s'enchaînent jusqu'à ce que le reste dû soit nul.

Un ticket s'imprime (s'affiche prêt à imprimer) avec le détail, la TVA par taux et les paiements.

**Les stocks.** Un ingrédient **sous son seuil d'alerte** est signalé sur la page des stocks et sur le tableau
de bord. Une **commande fournisseur** se prépare pour un fournisseur : elle propose, pour chacun de ses
ingrédients sous le seuil, `stock cible − stock` ; on peut changer les quantités ; à la **réception**, le stock
monte d'autant. La valeur du stock est la somme de `stock × prix d'achat` (arrondi au centime).

**La carte** se modifie : prix, taux, poste, recette, article retiré de la vente. Un changement vaut pour les
envois suivants, jamais pour ce qui est déjà envoyé ou réglé.

**Le tableau de bord** montre, pour la journée, et à jour en direct : le chiffre d'affaires TTC et HT, la
TVA par taux, le nombre de couverts (ceux des tables installées), le ticket moyen (chiffre TTC ÷ couverts,
arrondi au centime), le temps d'attente moyen et le plus long (sur les lignes prêtes, arrondi à la minute),
les cinq articles les plus vendus (en portions ; à égalité, dans l'ordre de `carte.csv`), les tables
occupées, les ruptures et les alertes de stock, les réservations à venir.

**Une journée.** Tout se garde : fermer puis rouvrir l'application, dans n'importe quelle fenêtre, retrouve
tout. « Clôturer la journée » archive la journée (on la relit ensuite), vide les tables et les commandes,
et garde les stocks et la carte.

## Ce que le juge fera, sans lire aucune doc

- **lancer la soirée** avec la salle vide, trois fenêtres ouvertes, et la **regarder vivre** depuis les premiers
  appels de l'après-midi jusqu'à la fermeture, en accéléré puis un moment à la vitesse réelle ; la ralentir, l'arrêter, la reprendre ; la
  **relancer plusieurs fois** et vérifier que chaque soirée est différente ;
- **arrêter la soirée à des instants pris au hasard et fouiller** ce que l'application garde (stockage,
  code, mémoire) : aucune arrivée future, aucun ordre d'arrivée préparé ne doit s'y trouver ;
- à tout moment de la soirée, **faire arriver un client d'un bouton** : un client tiré au hasard pousse la
  porte à cet instant (et, de même, un appel de réservation), et le juge le suit, traité comme les autres,
  jusqu'à son départ ;
- au milieu d'une soirée, **reprendre la main** : installer un client, prendre une commande, servir, régler
  une addition lui-même, puis laisser la soirée continuer ;
- noter, pour chaque problème de service qu'il voit arriver, s'il l'a compris d'un coup d'œil et comment il
  s'est résolu ; chercher un client bloqué ;
- à la fin de chaque soirée, **tout recalculer à la main** depuis ce qu'il a vu et depuis l'archive :
  couverts arrivés (220 attendus, la moitié réservés), chiffre, TVA, ticket moyen, attentes, durée moyenne
  d'un repas, articles vendus, stocks et leur valeur ; tout doit correspondre, sur toutes les pages ;

- ouvrir `index.html` en double-clic, puis **trois fenêtres à la fois** : la prise de commande en taille
  **tablette** (1024 × 768), la cuisine en taille **ordinateur** (1440 × 900), le tableau de bord en taille
  **téléphone** (390 × 844) ; tout geste dans une fenêtre se voit dans les deux autres en moins d'une
  seconde ;
- faire le parcours **comme quelqu'un qui découvre l'application**, sans lire aucune doc : noter chaque
  moment où il hésite, ne sait pas où en est un client ou ne trouve pas le geste suivant, et comparer
  chaque étape, écran par écran, à la version précédente ;
- suivre **trois clients d'un bout à l'autre**, dans trois fenêtres à la fois : un avec réservation, un
  sans, un qui passe par la liste d'attente ; entrées, puis plats réclamés, puis desserts et cafés,
  addition, règlement, débarrassage ; sans jamais ressaisir ce qui a déjà été dit ;
- régler l'horloge en avant **et en arrière**, installer des clients, prendre des commandes à plusieurs tables, en annuler une ligne,
  faire avancer les lignes en cuisine, servir, offrir un article, régler des additions en une fois, en parts
  égales et par articles, en carte et en espèces, débarrasser ;
- créer des réservations, dont une impossible, laisser passer une réservation sans venue ;
- commander jusqu'à la **rupture** d'un article et le voir disparaître partout de la prise de commande ;
  préparer et recevoir une commande fournisseur ; le voir revenir ;
- changer un prix et une recette sur la carte, puis commander ;
- lire le tableau de bord et le **recalculer à la main** : chiffre, TVA, couverts, ticket moyen, attentes,
  articles les plus vendus, valeur du stock ; il fera des services que cette mission ne cite pas ;
- fermer toutes les fenêtres, rouvrir : tout est là ; clôturer la journée et relire l'archive ;
- ouvrir **chaque page** aux trois tailles, plus **768 × 1024** (tablette en hauteur) et **1920 × 1080** :
  rien ne déborde, aucun texte n'est coupé, rien ne défile de côté, tout se touche au doigt sur téléphone et
  tablette ;
- faire un service complet en **pressé** : compter les touches des gestes fréquents, se tromper exprès et
  voir comment l'application aide à réparer ;
- regarder chaque page de près, au calme, comme un client qui choisit un logiciel : identité, lisibilité,
  finition ;
- regarder si l'application **se tient d'une page à l'autre** : les mêmes éléments ont la même allure et le
  même comportement partout, un même chiffre a la même valeur sur toutes les pages qui le montrent.

## Les documents

- `ARCHITECTURE.md` : comment l'application est découpée et pourquoi, d'où vient chaque donnée affichée,
  comment les fenêtres restent d'accord, et les autres découpages envisagés puis écartés, avec les numéros
  des messages du fil où ils ont été discutés : **chaque message cité existe, écrit par la personne nommée** ;
- `DECISIONS.md` : les choix, qui les a proposés, qui s'y est opposé et pourquoi, comment la salle a
  tranché, ce qui a changé grâce à la question d'un autre, ce qui reste en désaccord, avec les numéros des
  messages ;
- `MODE-D-EMPLOI.md` : pour un serveur, un cuisinier et le patron qui n'ont pas lu cette mission, où est
  chaque chose et comment faire chaque geste.

## C'est fini quand

La soirée se lance, vit, se regarde et se comprend comme décrit plus haut ; chaque soirée est différente,
tirée au hasard pendant qu'elle se joue ; les problèmes de service arrivent, se voient et se résolvent ;
aucun client ne reste bloqué ; à la fin, tout correspond ; le design va plus loin que la version
précédente ; rien de ce qui marchait dans la version précédente ne casse ;
le parcours d'un client s'enchaîne d'un bout à l'autre sans ressaisie ; le dossier livré ne contient que
ce que l'application charge, ses tests et ses documents ;
le design et l'expérience tiennent ce qui est décrit plus haut, sur les huit pages et les cinq tailles ;
les huit pages s'ouvrent à leur adresse, sans erreur ni exception, y compris en cliquant tout ce qui se
clique ; trois fenêtres ouvertes en même temps restent d'accord en moins d'une seconde ; toutes les règles
ci-dessus se vérifient à la main sur un service que la mission ne cite pas ; chaque page tient aux cinq
tailles ; `bun test` passe dans le dossier partagé et couvre les règles ; `ARCHITECTURE.md`, `DECISIONS.md`
et `MODE-D-EMPLOI.md` sont écrits.

## Livrable

index.html

## Vérification

bun test
node {DEPOT}/src/voir.ts --partage . index.html --parcours
