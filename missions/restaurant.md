# Le Refuge du Sarrat, un restaurant qui tourne

Mission écrite le 27/09. Le livrable est **l'application complète d'un restaurant**, dans le dossier partagé
indiqué par tes consignes, ouvrable en double-clic, sans serveur et sans internet : celle du **Refuge du
Sarrat**, douze tables en salle et en terrasse, une cuisine à quatre postes, un bar. Ceux qui s'en servent :
les serveurs sur une **tablette**, les cuisiniers sur un **écran d'ordinateur** au passe, le patron sur son
**téléphone** comme sur son ordinateur.

L'application a **huit pages**, et **chaque geste sur l'une se voit sur les autres**, en direct : une
commande prise en salle part en cuisine, le plat prêt prévient la salle, les ingrédients sortent du stock,
un plat en rupture disparaît de la prise de commande, l'addition réglée libère la table et fait monter le
chiffre du jour. Plusieurs pages restent ouvertes en même temps, chacune dans sa fenêtre, sur des écrans de
tailles différentes : **ce qui change dans une fenêtre apparaît dans les autres en moins d'une seconde, sans
recharger**.

Le découpage, les fichiers, les rôles et la façon de travailler sont à vous.

## Ce qui compte d'abord : le design et l'expérience

**Le juge note d'abord le design et l'expérience d'usage**, avant l'exactitude et avant le nombre de
fonctions. Il cherche une application qu'un restaurant aurait envie d'acheter, pas un prototype :

- **le design** : une identité propre au Refuge du Sarrat (couleurs, typographie, icônes, ton des textes),
  tenue sur les huit pages ; une hiérarchie claire (ce qui compte se voit d'abord), des espacements
  réguliers, des états visibles (libre, occupée, en retard, en rupture, prête) qui se lisent d'un coup d'œil,
  y compris de loin sur l'écran de la cuisine ; un mode sombre pour la cuisine et le soir ; rien de gris
  par défaut, rien d'esquissé ;
- **l'expérience** : chaque geste fréquent se fait en peu de touches et sans chercher (installer une table,
  prendre une commande, marquer « prêt », encaisser) ; une cible de doigt est assez grande sur téléphone et
  tablette ; chaque action se confirme par un retour visible et **s'annule** quand c'est possible ; une
  erreur dit ce qui s'est passé et comment la réparer ; une page vide dit quoi faire ; rien ne bloque un
  serveur pressé (pas de fenêtre qui s'ouvre sans raison, pas de chargement qui fige) ; le clavier et les
  lecteurs d'écran fonctionnent ;
- **le rythme d'un service** : l'application reste lisible et rapide avec douze tables pleines, trente
  lignes en cuisine et plusieurs fenêtres ouvertes.

Le juge comparera l'application aux bons logiciels de caisse et de cuisine qu'il connaît.

## Les données fournies

Cinq fichiers, seule source de vérité :

- `tables.csv` : les douze tables, leur zone et leur nombre de places ;
- `carte.csv` : les vingt articles de la carte : code, nom, catégorie, prix TTC en centimes, taux de TVA
  (10 ou 20 %), poste qui le prépare (`froid`, `chaud`, `dessert`, `bar`) ;
- `recettes.csv` : ce qu'une portion de chaque article consomme, ingrédient par ingrédient ;
- `ingredients.csv` : chaque ingrédient, son unité, son stock de départ, son seuil d'alerte, son stock
  cible, son fournisseur et son prix d'achat en centimes par unité ;
- `reservations.csv` : les réservations du jour.

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

- ouvrir `index.html` en double-clic, puis **trois fenêtres à la fois** : la prise de commande en taille
  **tablette** (1024 × 768), la cuisine en taille **ordinateur** (1440 × 900), le tableau de bord en taille
  **téléphone** (390 × 844) ; tout geste dans une fenêtre se voit dans les deux autres en moins d'une
  seconde ;
- régler l'horloge, installer des clients, prendre des commandes à plusieurs tables, en annuler une ligne,
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

Le design et l'expérience tiennent ce qui est décrit plus haut, sur les huit pages et les cinq tailles ;
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
