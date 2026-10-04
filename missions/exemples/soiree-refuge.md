# Le Refuge du Sarrat : une soirée où personne n'attend

## Le but

**Pendant une soirée tirée au hasard, aucun client n'attend plus de dix minutes, à aucune étape de son repas**,
dans le monde que décrit `rythme.csv`, et la soirée se voit vivre à l'écran.

Le livrable est **l'application complète d'un restaurant**, ouvrable en double-clic, sans serveur et sans
internet : celle du **Refuge du Sarrat**, trente tables en salle, en terrasse et en mezzanine (cent dix places),
une cuisine à quatre postes et un bar.

Ceux qui s'en servent : les **serveurs** sur une tablette, les **cuisiniers** sur un écran d'ordinateur au passe,
le **patron** sur son téléphone comme sur son ordinateur. Aucun n'a lu cette mission ni un mode d'emploi.

Ce qui compte, dans cet ordre : que personne n'attende, que la soirée se comprenne d'un coup d'œil, que chaque
chiffre soit juste. Le découpage, les fichiers et la façon de travailler sont à vous.

## Les données fournies

Six fichiers, dans le dossier des documents à traiter ({ENTREES}), seule source de vérité :

- `tables.csv` : les trente tables, leur zone et leur nombre de places ;
- `carte.csv` : les vingt articles : code, nom, catégorie, prix TTC en centimes, taux de TVA (10 ou 20 %), poste
  qui le prépare (`froid`, `chaud`, `dessert`, `bar`) ;
- `recettes.csv` : ce qu'une portion de chaque article consomme, ingrédient par ingrédient ;
- `ingredients.csv` : chaque ingrédient, son unité, son stock de départ, son seuil d'alerte, son stock cible, son
  fournisseur et son prix d'achat en centimes ;
- `rythme.csv` : le monde (plus bas) ;
- `reservations.csv` : les réservations déjà prises (aucune ce soir : celles de la soirée se tirent au hasard).

## Le monde

`rythme.csv` décrit le monde dans lequel le restaurant travaille, et que l'application ne choisit pas : le temps de
préparation d'une portion à chaque poste, combien de portions un cuisinier mène en même temps, le personnel présent
et ce qu'il coûte, la durée des gestes d'un serveur, le temps qu'un client prend pour choisir, manger chaque suite,
boire son café et demander l'addition, l'avance et le retard des clients réservés, la part qui ne vient pas, la
taille des groupes, et, quart d'heure par quart d'heure, combien de couverts arrivent avec et sans réservation.

- **L'application lit ce fichier et ne le change pas** : chaque durée, chaque capacité et chaque loi d'arrivée en
  vient ; aucune n'est écrite ailleurs dans le code.
- **Les solutions agissent sur le restaurant, jamais sur le monde** : comment il place, réserve, organise,
  cuisine, sert et encaisse est à vous ; ce que le monde impose ne se négocie pas.
- **Le juge apporte son propre monde** : il remplacera `rythme.csv` par d'autres valeurs, plus dures ou plus
  douces, que vous ne connaissez pas. Tout ce qui est dit ici doit tenir dans ce monde-là aussi, ou l'application
  dit, chiffres à l'appui, pourquoi ce n'est pas possible.

## Personne n'attend

Attendre, c'est rester sans que rien n'arrive pour soi : à la porte ou au téléphone avant d'avoir une table ou une
réponse, assis avant qu'on prenne sa commande, entre le moment où une suite est réclamée et celui où elle est
servie, entre la demande de l'addition et le règlement.

- **La soirée se tire au hasard pendant qu'elle se joue** : ni l'heure ni l'ordre d'une arrivée ne sont connus
  avant qu'elle arrive. Relancée dans les mêmes conditions, une soirée est toujours différente, et rien de ce que
  l'application garde ne permet d'en prédire la suite.
- **Renvoyer un client n'est pas une attente évitée** : chaque client renvoyé se compte à part, avec les couverts
  et le chiffre perdus, et le juge regarde s'il y avait une table libre assez grande.
- **Un client pressé ne compte pas** : un plat servi avant que le précédent soit mangé, ou un départ forcé, compte
  contre la mission.
- **Chaque attente se mesure et se voit** : pour chaque client, chaque attente, sa durée et sa cause ; pour la
  soirée, la plus longue, la moyenne et le nombre de clients au-delà de dix minutes, en direct et à la fin.
- **Chaque solution se voit et se chiffre** : appliquée dans la soirée, elle se voit quand elle joue, avec ce
  qu'elle coûte (couverts refusés, plats retirés, personnel). Une solution écartée s'écrit avec sa raison.

## La soirée

Le juge veut voir vivre un service du soir complet, des premiers appels de l'après-midi à la fermeture : **environ
220 couverts**, la moitié avec réservation, selon les lois de `rythme.csv`.

- Les problèmes d'un vrai service arrivent : la salle pleine, la cuisine débordée, un plat en rupture, une
  réservation en retard ou absente, un groupe plus grand que prévu. **Chacun se voit quand il arrive, et sa
  solution se trouve à l'instant** ; ce qui peut s'anticiper se voit **avant** d'arriver.
- Le juge regarde la soirée entière en quelques minutes, peut la ralentir, l'arrêter, la reprendre, la relancer,
  et **reprendre la main** à tout moment : installer un client, servir, encaisser lui-même.

## Les huit pages

Chacune s'ouvre à son adresse, dans sa propre fenêtre ; ce qui change dans une fenêtre apparaît dans les autres
**en moins d'une seconde, sans recharger** :

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

## Le parcours d'un client

Chaque étape déclenche la suivante, se voit sur les pages concernées, et **rien ne se saisit deux fois** :
l'arrivée (avec réservation, sans, ou par la liste d'attente), la commande par suites (boissons, entrées, plats,
desserts, les suites suivantes attendant en cuisine jusqu'à ce que la salle les réclame), la préparation poste
par poste, le service, la fin du repas, l'addition, le règlement, le débarrassage.

## Les règles du restaurant

Tout se compte en **nombres entiers** : les prix en centimes, les quantités dans l'unité de `ingredients.csv`, le
temps en minutes. « Arrondi » veut dire au plus proche, et au-dessus à égalité.

- **Une réservation** reçoit la plus petite table libre qui a assez de places, sur la période de 15 minutes avant
  son heure à 90 minutes après ; sans table possible, elle est refusée avec son motif.
- **Une commande envoyée** fait sortir du stock les ingrédients de chaque portion. Un article dont un ingrédient
  manque pour une portion est **en rupture** et disparaît partout de la prise de commande.
- **L'addition** est la somme des prix TTC des lignes non annulées. La TVA se calcule par taux :
  `TVA = arrondi(TTC × taux / (100 + taux))`, `HT = TTC − TVA`. Elle se règle en une fois, en parts égales (les
  premières parts portent le centime restant) ou par articles, en carte, en espèces ou les deux.
- **Le tableau de bord** montre en direct le chiffre TTC et HT, la TVA par taux, les couverts, le ticket moyen,
  les attentes moyenne et la plus longue, les cinq articles les plus vendus, les ruptures et les alertes de stock.
- **Tout se garde** : fermer puis rouvrir l'application retrouve tout ; « clôturer la journée » archive la journée.

## Ce qui compte d'abord : le design et l'expérience

Le juge cherche une application qu'un restaurant aurait envie d'acheter : une identité propre au Refuge tenue sur
les huit pages, des états lisibles d'un coup d'œil (libre, occupée, en retard, en rupture, prête), un mode sombre
pour la cuisine, des gestes fréquents en peu de touches, des cibles assez grandes au doigt, des actions qui
s'annulent, et une application qui reste rapide avec trente tables pleines et cent lignes en cuisine.

## Ce que le juge fera, sans lire aucune doc

- remplacer `rythme.csv` par son propre monde, puis chercher dans le code toute durée ou capacité qui n'en vient
  pas ;
- mesurer les attentes sur au moins dix soirées tirées au hasard, avec sa propre horloge, et les recalculer
  depuis ce qu'il voit ;
- arrêter la soirée à un instant pris au hasard et fouiller ce que l'application garde : aucune arrivée future ;
- suivre trois clients d'un bout à l'autre, dans trois fenêtres à la fois (tablette 1024 × 768, ordinateur
  1440 × 900, téléphone 390 × 844) ;
- tout recalculer à la main à la fin : couverts, chiffre, TVA, ticket moyen, attentes, stocks et leur valeur.

## Les documents

- `SOLUTIONS.md` : chaque cause d'attente trouvée, chaque solution appliquée ou écartée avec sa raison, ce qu'elle
  a changé mesuré sur des soirées, et ce qu'elle coûte ;
- `DECISIONS.md` : les choix, qui les a proposés, qui s'y est opposé, comment la salle a tranché, avec les numéros
  des messages du fil ;
- `MODE-D-EMPLOI.md` : pour un serveur, un cuisinier et le patron, où est chaque chose et comment faire chaque
  geste.

## Engagements

Rien n'est publié ni envoyé hors de la machine. Aucun service extérieur n'est appelé pendant la soirée.

## Type

application

## C'est fini quand

Sur toutes les soirées tirées au hasard, dans le monde de `rythme.csv` et dans celui du juge, aucun client n'attend
plus de dix minutes à aucune étape, et chaque attente se mesure et se voit ; les huit pages s'ouvrent à leur
adresse sans erreur ni exception ; trois fenêtres ouvertes restent d'accord en moins d'une seconde ; à la fin de
chaque soirée, les chiffres du tableau de bord, des stocks et de l'archive se recalculent à la main ; `bun test`
passe dans le dossier partagé et couvre les règles du restaurant ; `SOLUTIONS.md`, `DECISIONS.md` et
`MODE-D-EMPLOI.md` sont écrits.

## Livrable

index.html

## Vérification

bun test
node {DEPOT}/src/voir.ts --partage . index.html --parcours
