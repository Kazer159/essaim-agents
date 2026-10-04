# La réception d'un hôtel, application complète

Le livrable est une **application** qui tourne dans une page ouvrable en double-clic, dans le dossier
partagé indiqué par tes consignes : le poste de travail d'une réceptionniste un matin d'été. Elle voit
l'hôtel entier sur trois mois, répond à « il vous reste quelque chose du 13 au 16 juillet pour deux ? »
en quelques secondes, prix compris, place la réservation, déplace un client de chambre, et sait dire
non quand c'est non — en disant pourquoi.

Mission écrite le 23/09 pour quinze agents, un cran au-dessus du planificateur : là, une seule chose
bougeait dans le temps ; ici, **trois cent quatre-vingt-quatorze séjours se disputent trente chambres**,
chaque geste peut en casser un autre, et l'argent doit tomber juste au centime. Elle dit ce que le juge
attend et rien sur la façon de s'y prendre : le découpage, les fichiers, les contrats entre vous et
l'ordre du travail sont à vous.

## Les données fournies

Six fichiers sont dans le dossier des documents à traiter (voir tes consignes). Séparateur `;`,
première ligne = les noms de colonnes, UTF-8 avec accents. C'est un hôtel entier sur un trimestre :
trente-deux chambres, soixante clients, quatre cent vingt réservations, huit demandes en attente.

- `chambres.csv` : `id;nom;type;capacite;etage;vue;etat` — `etat` vaut `en_service` ou `travaux`.
- `reservations.csv` : `id;client;chambre;arrivee;depart;adultes;enfants;statut;services` — `statut`
  vaut `confirmee` ou `annulee` ; `services` est une liste de codes séparés par `|`, parfois vide.
- `clients.csv` : `id;nom;pays;fidelite` — `fidelite` vaut `aucun`, `argent` ou `or`.
- `tarifs.csv` : `saison;debut;fin;type_chambre;prix_nuit` — les bornes des saisons sont comprises.
- `services.csv` : `code;nom;prix;unite` — `unite` vaut `personne_nuit`, `nuit` ou `sejour`.
- `demandes.csv` : `id;client;arrivee;depart;adultes;enfants;vue_souhaitee;services` — huit demandes
  que personne n'a encore placées. Toutes ne sont pas tenables.

## Les règles du jeu

Elles ne disent pas comment calculer — c'est le cœur du travail. Elles fixent le vocabulaire et les
conventions, pour qu'une bonne réponse ne passe pas pour une mauvaise.

- **On compte en nuits.** Un séjour du 3 au 7 occupe les nuits du 3, du 4, du 5 et du 6 : quatre
  nuits, arrivée comprise, départ exclu. **Une chambre libérée le matin peut être reprise le soir
  même** — un départ et une arrivée le même jour ne sont pas un conflit. Il y en a cent dix dans
  les données : une application qui les prend pour des conflits est fausse dès la première seconde.
- **Un conflit** : deux réservations confirmées sur la même chambre qui partagent au moins une nuit.
- **Une réservation annulée** ne compte ni dans l'occupation, ni dans le revenu, ni dans les
  conflits ; elle reste consultable.
- **Une chambre en travaux n'accueille personne** : elle n'est jamais proposée, elle ne compte pas
  dans le parc, et une réservation qui la vise est refusée.
- **La capacité est une limite dure** : adultes et enfants ensemble ne dépassent jamais la capacité
  de la chambre.
- **Le tarif d'une nuit** est celui de la saison dans laquelle tombe cette nuit-là, pour le type de
  la chambre. Un séjour qui enjambe un changement de saison paie chaque nuit à son propre tarif.
- **La remise de fidélité** porte sur l'hébergement seul, jamais sur les services ni sur la taxe :
  `aucun` 0 %, `argent` 5 %, `or` 10 %.
- **Chaque service se compte selon son unité** : `personne_nuit` par personne et par nuit,
  `nuit` par nuit, `sejour` une seule fois.
- **La taxe de séjour** vaut **1,50 € par adulte et par nuit**. Les enfants ne la paient pas, et elle
  ne se remise jamais.
- **L'occupation d'une nuit** est la part des chambres **en service** occupées cette nuit-là.
- **Les montants s'affichent en euros avec deux décimales.** Avec ces données, aucun arrondi n'est
  nécessaire nulle part : si votre calcul en réclame un, c'est qu'il est faux — allez voir pourquoi
  plutôt que d'arrondir.
- **Les dates s'affichent en toutes lettres ou en `AAAA-MM-JJ`**, jamais en numéro de jour.

## Ce que le juge fera, sans lire aucune doc

1. **Ouvrir la page en double-clic** et voir l'hôtel entier : les chambres en lignes, les jours en
   colonnes, chaque séjour posé comme un bloc sur son rang, du 1er juin au 31 août 2026. En un
   regard : où c'est plein, où il reste de la place, et quelles chambres sont hors service.
2. **Lire une réservation** : cliquer sur un bloc donne le client, ses dates, le nombre de nuits, qui
   dort là, les services pris, et **le détail du prix** — hébergement, remise appliquée, services,
   taxe de séjour, total.
3. **Chercher ce qui est libre, entre deux dates** : taper une arrivée, un départ et un nombre de
   personnes, et obtenir la liste des chambres libres sur **toute** la période, chacune avec son
   type, sa vue et ce que coûterait le séjour. La recherche doit répondre sur les trois mois de
   données sans qu'on attende.
4. **Ne rien trouver, et être bien renseigné** : quand rien n'est libre, la page le dit et **montre
   quelles nuits bloquent** — et quand aucune nuit ne bloque à elle seule mais qu'aucune chambre ne
   tient toute la suite, elle le dit aussi, plutôt que d'annoncer « complet » sans plus.
5. **Réserver depuis la recherche** : choisir une chambre, ajouter des services, voir le prix avant
   de confirmer, confirmer — et retrouver le séjour dans le planning, dans la fiche du client et
   dans les totaux, tout de suite.
6. **Traiter les huit demandes en attente** : pour chacune, la page dit si elle tient, dans quelle
   chambre, à quel prix, et si le souhait de vue est satisfait ; pour celles qui ne tiennent pas,
   elle dit pourquoi, précisément.
7. **Déplacer un client de chambre**, à la souris, et voir le prix se refaire quand le type change.
   La page refuse ce qui est impossible — chambre déjà prise (en nommant le séjour qui gêne), trop
   petite, en travaux — en le disant clairement, jamais en silence, jamais dans la console.
8. **Allonger un séjour** en tirant son bord, le raccourcir, et voir le prix suivre ; être refusé si
   la nuit de trop est déjà vendue.
9. **Annuler une réservation, puis la remettre** : elle sort de l'occupation et du revenu, la place
   redevient libre, et tout revient quand on la rétablit.
10. **Annuler et refaire** n'importe lequel de ces gestes, plusieurs fois de suite, et retrouver
    l'écran exactement dans l'état d'avant.
11. **Regarder les chiffres du trimestre** : l'occupation nuit par nuit et mois par mois, le revenu,
    la part de l'hébergement, des services et de la taxe, la nuit la plus remplie et la plus creuse.
    Ces chiffres changent sous les yeux quand on touche à une réservation.
12. **Chercher et filtrer** : retrouver un client par son nom, n'afficher qu'un étage, qu'un type, que
    les séjours annulés, que les arrivées du jour.
13. **Fermer et rouvrir la page** : tout est là, y compris les changements. Et un bouton rend l'hôtel
    tel qu'il était au départ.
14. **Exporter et réimporter** l'hôtel entier dans un fichier texte : ce qui revient est identique.
15. **Lancer `bun test`** : des tests qui prouvent le cœur (au moins : les nuits d'un séjour ; un
    départ suivi d'une arrivée le même jour qui n'est pas un conflit ; un recouvrement qui en est
    un ; le prix d'un séjour à cheval sur deux saisons, avec remise, services et taxe ; les chambres
    libres entre deux dates sur un petit hôtel écrit dans le test ; une capacité dépassée refusée ;
    une chambre en travaux jamais proposée ; un changement annulé puis refait ; l'export puis
    l'import qui redonnent le même hôtel ; et le chargement de tous vos fichiers de code ensemble,
    comme la page le fait), tous verts.
16. **Lire** dans la page ou dans un `MODE-D-EMPLOI.md` ce qu'on peut faire.

Le juge lit le **texte** de la page — les dates, les noms, les montants, les refus — et pas seulement
les pixels : ce qu'il faut comparer doit être lisible par un script. Il clique aussi partout, dans
tous les écrans, et refuse une page où un écran s'affiche vide.

**Et il sortira de ce qui est écrit ici.** Les chiffres donnés plus bas sont des points de contrôle,
pas la liste de ses questions : il cherchera d'autres dates, déplacera d'autres clients, annulera
d'autres séjours, sur ce même hôtel, et comparera à ce que les règles du jeu imposent. Une réponse
apprise par cœur ne tiendra pas trois questions ; seul un calcul qui tourne vraiment tiendra.

## Le design et la prise en main comptent autant que le calcul

Un hôtel juste mais illisible ne sert à personne, et cette mission se juge d'abord comme une
**application** : quelque chose qu'on ouvre, qu'on comprend en dix secondes et qu'on utilise sans
mode d'emploi, avec un client au téléphone. Le style est le vôtre — les couleurs, la mise en page,
les mots de l'interface, la façon de passer d'un écran à l'autre — mais le résultat se juge :

- **on comprend sans qu'on explique** : ce qu'on regarde, quel jour on est, ce qui est sélectionné,
  ce qu'on peut faire. Les gestes du métier — chercher une disponibilité, placer quelqu'un, déplacer
  un client — se trouvent sans être cherchés ;
- **la densité est le vrai problème** : trente chambres sur quatre-vingt-douze jours, c'est beaucoup
  de cases. Faites que ça se lise. Un planning dense et lisible se reconnaît de loin : les mois et
  les semaines se distinguent, les week-ends se voient, chaque bloc dit à qui il est sans qu'on
  clique, et rien ne se chevauche ;
- **chaque geste répond tout de suite et dit ce qu'il a fait** : un client déplacé, un séjour
  allongé, une annulation — on voit quoi a bougé et combien ça change, pas seulement que quelque
  chose a bougé ;
- **les refus sont utiles** : quand une action est impossible, la page dit laquelle, pourquoi, ce
  qui bloque et ce qu'on peut faire à la place ;
- **l'information a une forme** : un séjour annulé se distingue d'un confirmé, une chambre en travaux
  d'une chambre libre, une alerte d'une information — et rien de tout cela ne repose sur la seule
  couleur ;
- **ça tient sur deux écrans** : sur un ordinateur portable (1280 × 800), rien ne se chevauche, rien
  n'est coupé, aucune barre de défilement horizontale sur la page elle-même ; et sur un téléphone
  (390 px de large), l'application reste utilisable — quitte à ce que le planning change de forme.
  Une application de réception qu'on ne peut pas consulter debout ne sert qu'à moitié ;
- **ça se fait aussi au clavier** : on peut atteindre les actions principales sans souris, on voit
  toujours où l'on est, et rien ne piège le curseur ;
- **c'est beau parce que c'est un hôtel** : un planning a ses rythmes — les semaines, les arrivées du
  samedi, les creux de juin — et ce sont eux qui font une belle page, pas des ornements posés dessus.

**La page marche seule** : hors ligne, ouverte en double-clic, sans rien à installer chez celui qui
la reçoit, et **rapide** : le planning entier s'affiche en moins d'une seconde, une recherche de
disponibilité sur les trois mois répond en moins d'un dixième de seconde, et le défilement comme le
déplacement d'un bloc tiennent au moins cinquante images par seconde. Comment vous la faites tenir
debout est à vous — tout écrire, ou poser dans le dossier livré une bibliothèque que vous jugez
meilleure ; dans ce cas la mission lève l'interdiction de télécharger, une seule fois, par une seule
personne. **Le choix s'annonce dans le fil, et la raison donnée s'appuie sur quelque chose que vous
avez mesuré**, jamais sur une préférence.

Il regardera si les chiffres sont justes, si tout se refait quand on touche à quelque chose, si les
refus sont clairs, si les tests sont verts — et, à poids égal, si l'application est belle, rapide et
compréhensible sans qu'on l'explique. Comment vous vous y prenez, à quinze sur un seul dossier, est
votre affaire.

---

## C'est fini quand

La page s'ouvre par `page_voir` avec « page_voir : 0 », y compris avec `--parcours` (aucun écran vide, aucun
bouton sans effet), `bun test` passe sans échec, et tu as vérifié dans la page chacun de ces points
tels quels. **Toutes les valeurs ci-dessous sortent des règles du jeu ci-dessus.**

**L'hôtel tel qu'il est donné :**

- **30 chambres en service** sur 32 (`C208` et `C405` sont en travaux), **394 réservations
  confirmées** et 26 annulées ;
- **1 885 nuitées** vendues sur le trimestre, soit **68,30 %** d'occupation moyenne (1 885
  chambres-nuits sur 2 760) ;
- **revenu total 299 698,20 €** : hébergement remisé 254 289,20 €, services 40 387,00 €, taxe
  5 022,00 €, et 8 034,80 € de remises accordées ;
- par mois : juin **68,22 %** d'occupation et 133 arrivées, juillet **71,08 %** et 125 arrivées,
  août **65,59 %** et 136 arrivées ;
- nuit la plus remplie : **le 12 juin, 26 chambres sur 30** ; la plus creuse : **le 1er juin, 3 sur
  30** ;
- la nuit du **14 juillet**, il reste **11 chambres** : C101, C202, C204, C206, C207, C303, C304,
  C306, C307, C404, C407 ;
- **aucun conflit** dans les données de départ, et **110 départs suivis d'une arrivée le jour même** :
  aucun n'est un conflit.

**Le prix, au centime :**

- `R001` (Hugo Silva, sans fidélité, chambre 101, 4 nuits du 1er au 5 juin, petit-déjeuner) :
  hébergement 312,00 €, services 58,00 €, taxe 6,00 €, **total 376,00 €** ;
- `R032` (Hugo Meyer, argent, chambre 103, 7 nuits du 26 juin au 3 juillet, à cheval sur deux
  saisons, petit-déjeuner) : hébergement **614,00 €**, remise 5 % soit 30,70 €, services 101,50 €,
  taxe 10,50 €, **total 695,30 €** ;
- `R020` (Clara Leroy, or, chambre 102, 3 nuits du 27 au 30 juin, petit-déjeuner et parking) :
  hébergement 234,00 €, remise 10 % soit 23,40 €, services 79,50 €, taxe 4,50 €, **total 294,60 €**.

**Les huit demandes en attente :**

- **cinq tiennent** : `D1` (5 chambres possibles, dont 3 avec la vue mer demandée : C306, C404,
  C407), `D2` (une seule, **C404**), `D4` (11 chambres), `D5` (une seule, **C407**, qui a bien la
  vue mer), `D8` (4 chambres : C302, C304, C305, C402) ;
- **trois ne tiennent pas** : `D3` — six nuits d'affilée sans aucune chambre de quatre places libre,
  du 9 au 14 juin ; `D6` — une seule nuit bloque, **celle du 4 juillet** ; `D7` — **aucune nuit ne
  bloque à elle seule**, mais aucune chambre ne tient les sept nuits d'un bout à l'autre, et la page
  doit le dire ainsi ;
- `D2` placée en C404 (familiale, 4 nuits du 10 au 14 août, 2 adultes 1 enfant, petit-déjeuner et
  parking, cliente argent) coûte **986,40 €** : hébergement 792,00 €, remise 39,60 €, services
  222,00 €, taxe 12,00 €.

**Quand on y touche :**

- déplacer `R006` (Maya Girard, or, 4 nuits du 10 au 14 juillet) de la chambre 101 (simple) vers la
  301 (twin) porte son total de **467,20 €** à **575,20 €** — l'hébergement passe de 448,00 € à
  568,00 € ;
- déplacer `R006` vers la chambre 102 est refusé : `R021` y est déjà, et la page le nomme ;
- prolonger `R006` de deux nuits est refusé : `R007` occupe déjà la chambre après lui ;
- annuler `R006` fait passer la nuit du 10 juillet de 22 à 21 chambres occupées et le revenu total à
  **299 231,00 €** ; le rétablir redonne 299 698,20 € ;
- chercher deux places du **20 au 22 juillet** donne exactement quatre chambres : C302, C304, C305 et
  C402 ; y placer quelqu'un sans fidélité en C302 coûte **290,00 €** ;
- chercher quatre places du **8 au 15 juin** ne donne rien, et la page dit lesquelles des nuits
  bloquent ;
- annuler puis refaire ces changements redonne exactement l'hôtel de départ ;
- après un rechargement de la page, les changements sont encore là ; le bouton qui rend l'hôtel
  d'origine redonne 299 698,20 € et 68,30 % ;
- l'export puis l'import redonnent les mêmes chambres, les mêmes séjours et les mêmes montants.

**L'allure :**

- en 1280 × 800, tout tient : rien ne se chevauche, aucun texte coupé, pas de défilement horizontal
  de la page ; en 390 px de large, l'application reste utilisable et aucun texte ne déborde ;
- le planning s'affiche en moins d'une seconde, une recherche de disponibilité répond en moins d'un
  dixième de seconde, le défilement et le déplacement d'un bloc tiennent au moins cinquante images
  par seconde ;
- on atteint les actions principales au clavier, et on voit toujours où l'on est ;
- un œil qui découvre la page trouve seul comment lire un séjour, chercher une disponibilité entre
  deux dates, placer un client, le déplacer et annuler ;

aucune pancarte ne reste à ton nom, et tu as appelé `moi_finir` avec « réception livrée » et le nom du
fichier que tu as le plus travaillé.

## Livrable

index.html

## Vérification

bun test
node {DEPOT}/src/voir.ts --partage . index.html --parcours
