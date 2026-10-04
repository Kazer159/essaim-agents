# Le festival Lumen, application complète et trois identités visuelles

Le livrable est une **application** qui tourne dans une page ouvrable en double-clic, dans le dossier
partagé indiqué par tes consignes : celle du festival Lumen, quatre jours de musique, du jeudi 9 au
dimanche 12 juillet 2026, six scènes, cent dix-huit concerts. On l'ouvre sur son téléphone dans la
foule pour savoir où aller, et sur un grand écran à la régie pour voir le site vivre heure par heure.
Et elle existe **en trois identités visuelles complètes**, qu'on bascule d'un geste.

Mission écrite le 24/09. Elle est différente des précédentes : ici, beaucoup de choses **n'ont pas une
seule bonne réponse**. Quelle identité pour quel public, comment montrer six scènes sur quatorze heures
sans noyer l'œil, que faire quand deux envies se chevauchent, que dire à quelqu'un qui ne pourra voir
aucun de ses concerts. Ces choix se font à plusieurs, et **le juge regardera comment ils ont été faits**
autant que le résultat. Elle dit ce que le juge attend et rien sur la façon de s'y prendre : le
découpage, les fichiers, les contrats entre vous et l'ordre du travail sont à vous.

## Les données fournies

Cinq fichiers sont dans le dossier des documents à traiter (voir tes consignes). Séparateur `;`,
première ligne = les noms de colonnes, UTF-8 avec accents.

- `scenes.csv` : `id;nom;capacite;x;y;ouverture;fermeture` — six scènes et l'entrée du site (`ENT`) ;
  `x` et `y` placent chaque lieu sur le plan, en mètres.
- `concerts.csv` : `id;artiste;genre;scene;jour;debut;fin;affluence` — `jour` est le jour de festival ;
  `affluence` est le nombre de personnes attendues devant la scène.
- `marche.csv` : `de;vers;minutes` — le temps à pied entre deux lieux, dans ce sens-là.
- `festivaliers.csv` : `id;nom;arrivee;depart_limite` — huit festivaliers, l'heure à laquelle ils
  passent l'entrée chaque jour et l'heure à laquelle ils doivent l'avoir repassée pour rentrer.
- `envies.csv` : `festivalier;concert;priorite` — les concerts que chacun voudrait voir, de 1 (si
  possible) à 3 (surtout pas le rater).

## Les règles du jeu

Elles ne disent pas comment calculer. Elles fixent le vocabulaire et les conventions.

- **Une journée de festival va de midi à midi.** Une heure avant midi appartient à la nuit qui suit :
  un concert du jeudi écrit `01:00` joue dans la nuit du jeudi au vendredi, après ceux de `23:00`. Une
  page qui range `00:30` avant `16:00` dans le programme du jeudi est fausse.
- **Un concert occupe sa scène de `debut` compris à `fin` exclue.** Deux concerts d'une même scène qui
  partagent une minute se chevauchent : c'est une **erreur du programme**, que la page signale sans la
  corriger en silence.
- **La foule d'une scène**, à un instant, est l'affluence du concert qui y joue (zéro sinon). **La
  foule du site** est la somme des six scènes. Un concert dont l'affluence dépasse la capacité de sa
  scène est **en alerte**.
- **Voir un concert, c'est le voir en entier**, du début à la fin. Entre deux concerts, il faut le
  temps de marcher de l'une à l'autre scène : on peut arriver pile au début. La marche **n'a pas
  toujours la même durée dans les deux sens** : c'est `marche.csv` qui fait foi.
- **Le programme d'un festivalier pour un jour** part de l'entrée à son heure d'`arrivee`, ne contient
  que des concerts de ses envies, et le ramène à l'entrée au plus tard à son `depart_limite`. Le
  **meilleur programme** est celui qui a **le plus de points** (la somme des priorités) ; à égalité, le
  plus de concerts ; puis le moins de minutes de marche (entrée et retour compris) ; puis celui dont le
  dernier concert finit le plus tôt ; puis celui dont la liste des identifiants, dans l'ordre des
  horaires, est la plus petite.
- **Les heures s'affichent en `HH:MM`**, les jours en toutes lettres (« jeudi 9 juillet »).

## Ce que le juge fera, sans lire aucune doc

**Sur un téléphone, dans la foule :**

1. **Ouvrir la page** et voir tout de suite ce qui joue maintenant et juste après, pour un jour et
   une heure qu'il choisit.
2. **Lire le programme d'un jour** : les six scènes côte à côte, les concerts posés à leur heure, la
   nuit après minuit à sa place, et l'erreur du programme visible là où elle est.
3. **Choisir un festivalier** et voir son meilleur programme pour un jour : les concerts, les
   heures, les minutes de marche entre chaque, les points, et **pourquoi** telle envie n'y est pas
   (elle chevauche un concert qui rapporte plus, elle commence avant qu'on puisse y être, elle finit
   après le dernier train). Quand aucun concert n'est possible, la page dit pourquoi, précisément.
4. **Changer une envie ou une heure** (ajouter un concert, changer une priorité, partir plus tard) et
   voir le programme se refaire aussitôt.
5. **Retrouver un artiste** en tapant trois lettres de son nom.

**Sur un grand écran, à la régie :**

6. **Voir le plan du site** : les scènes à leur place, l'entrée, les chemins, et la foule dessus.
7. **Rejouer une journée** : faire défiler l'heure, ou la laisser avancer seule, et voir la foule se
   déplacer d'une scène à l'autre, le pic du site arriver, les alertes s'allumer. S'arrêter sur une
   heure et lire les chiffres.
8. **Voir la journée d'un regard** : les scènes en lignes, les heures en colonnes, la foule en
   intensité, de façon que le pic, les creux et les alertes sautent aux yeux.
9. **Tracer sur le plan le parcours d'un festivalier** : ses concerts dans l'ordre et ses marches.

**Partout :**

10. **Basculer entre les trois identités visuelles**, d'un geste, sans recharger, et retrouver
    exactement la même information à la même place logique. Chacune a un nom, sa palette, sa
    typographie, sa façon de bouger — et chacune reste lisible (voir « L'allure »).
11. **Fermer et rouvrir la page** : l'identité choisie, le festivalier choisi et ses envies modifiées
    sont encore là. Un bouton rend les envies d'origine.
12. **Lancer `bun test`** : des tests qui prouvent le cœur (au moins : une heure après minuit rangée
    dans la bonne journée ; un chevauchement détecté ; la foule du site à un instant ; une alerte de
    capacité ; une marche plus longue dans un sens que dans l'autre ; le meilleur programme sur un
    petit festival écrit dans le test, avec au moins deux départages ; un départ limité qui retire un
    concert d'après minuit ; un programme vide expliqué ; et le chargement de tous vos fichiers de
    code ensemble, comme la page le fait), tous verts.
13. **Lire** le `MODE-D-EMPLOI.md` et le `DECISIONS.md` (voir plus bas).

Le juge lit le **texte** de la page — les heures, les noms, les chiffres, les refus — et pas seulement
les pixels : ce qu'il faut comparer doit être lisible par un script. Il clique partout, dans les trois
identités, et refuse une page où un écran s'affiche vide.

**Et il sortira de ce qui est écrit ici** : il choisira d'autres festivaliers, d'autres jours, d'autres
heures, modifiera d'autres envies, et comparera à ce que les règles du jeu imposent.

## Trois identités visuelles, et le design qui compte autant que le calcul

**Les trois identités sont à vous**, et c'est le cœur de la mission : aucune n'est imposée, aucune ne
doit ressembler à un gabarit. Chacune se défend par ce qu'elle apporte à un public réel du festival
(celui qui arrive à 14 h avec des enfants, celle qui danse aux Docks à 3 h, le régisseur qui surveille
les jauges), et elles doivent être **vraiment différentes** : pas la même page avec trois couleurs,
mais trois partis pris — de typographie, de mise en page, de mouvement, de rapport à la nuit.

Pour toutes les trois, le résultat se juge :

- **on comprend sans qu'on explique** : quel jour, quelle heure, qui, ce qui est sélectionné ;
- **la densité est le vrai problème** : trente concerts par jour sur six scènes et quatorze heures,
  une foule qui change toutes les minutes. Faites que ça se lise ;
- **le mouvement sert** : ce qui bouge montre quelque chose (la foule qui passe d'une scène à
  l'autre), et tout mouvement s'arrête pour qui l'a demandé à son système ;
- **l'information a une forme** : une alerte se distingue d'une information, un concert vu d'un
  concert raté, la nuit du jour — et rien ne repose sur la seule couleur ;
- **ça tient sur tous les écrans**, pas seulement sur deux : du petit téléphone (360 px) au grand
  écran de régie (2560 px), en passant par le téléphone tenu en largeur, la tablette debout et
  couchée, et l'ordinateur portable. Chaque taille **profite de sa place** au lieu d'étirer ou de
  rétrécir la même page : sur un petit écran, l'essentiel d'abord ; sur un grand, plus de choses
  visibles d'un coup (le plan et la journée côte à côte, par exemple). Nulle part un texte ne déborde,
  rien ne défile de côté sur la page elle-même, rien ne se chevauche ni n'est coupé, et les cibles
  restent assez grandes pour un pouce ;
- **ça se fait aussi au clavier**, on voit toujours où l'on est, rien ne piège le curseur.

**La page marche seule** : hors ligne, ouverte en double-clic, sans rien à installer. Le premier écran
s'affiche en moins d'une seconde, un programme se calcule en moins d'un dixième de seconde, et
changer d'identité prend moins d'un cinquième de seconde. Comment vous la faites tenir debout est à
vous — tout écrire, ou poser dans le dossier livré une bibliothèque que vous jugez meilleure ; dans ce
cas la mission lève l'interdiction de télécharger, une seule fois, par une seule personne. **Le choix
s'annonce dans le fil, et la raison donnée s'appuie sur quelque chose que vous avez mesuré.**

## Les décisions, et ce qui a changé grâce aux autres

Cette mission sert aussi à voir **si une salle qui s'interroge fait mieux qu'une salle qui se
répartit le travail**. Le juge le mesurera sur un fichier `DECISIONS.md`, dans le dossier livré, et il
le recoupera avec le tableau de la salle : **chaque message cité doit exister, écrit par la personne
nommée**.

- **Au moins huit décisions** qui comptaient : pour chacune, la question, les options qui ont été
  vraiment envisagées, qui a proposé quoi, **qui a objecté et pourquoi**, ce qui a été choisi, et le
  numéro du message du fil où cela s'est dit. Les trois identités en font partie : pour chacune, qui
  l'a défendue, qui l'a critiquée, et ce que la critique a changé.
- **Au moins cinq changements dus à une question** : une question posée à quelqu'un (le numéro du
  message), ce qu'elle a fait découvrir, et ce qui a changé dans le livrable à cause d'elle. Un
  changement qui aurait eu lieu de toute façon ne compte pas.
- **Ce qui est resté en désaccord**, s'il y en a : un désaccord honnêtement noté vaut mieux qu'un
  consensus de façade.

## Votre part d'initiative

- **Deux fonctionnalités de votre choix**, absentes de la liste ci-dessus, que la salle choisit
  ensemble. Chacune s'annonce dans le fil avant d'être construite : pour qui, quel problème réel elle
  règle, et pourquoi celle-là. Elles viennent **après** que le cœur tient, ne cassent rien, ont leurs
  tests, et se trouvent sans qu'on les cherche.
- **Une passe sur le design, l'ergonomie et l'interface**, une fois le livrable rejoué : au moins
  **trois défauts d'usage** constatés vous-mêmes en utilisant la page — dans chacune des trois
  identités, sur le téléphone comme sur le grand écran —, corrigés, et décrits (ce qui gênait, ce qui
  a changé, à quoi on voit que c'est mieux).

Le `MODE-D-EMPLOI.md` finit par **« Ce que nous avons ajouté »** et **« Ce que nous avons
amélioré »**.

---

## C'est fini quand

La page s'ouvre par `page_voir` avec « page_voir : 0 », y compris avec `--parcours` (aucun écran vide, aucun
bouton sans effet, rien qui recouvre la page), dans **chacune des trois identités**, `bun test` passe
sans échec, et tu as vérifié dans la page chacun de ces points tels quels. **Toutes les valeurs
ci-dessous sortent des règles du jeu ci-dessus.**

**Le programme :**

- **118 concerts** de 118 artistes, 9 genres, **8 310 minutes** de musique ; jeudi 31 concerts,
  vendredi 28, samedi 30, dimanche 29 ;
- **16 concerts finissent après minuit** ; le dernier, `C020` (Argile Parade, aux Docks), finit à
  **03:30** dans la nuit du jeudi au vendredi ;
- **une seule erreur du programme** : samedi, à la Serre, `C083` (Onde Électriques, 17:25–18:25)
  commence pendant `C082` (Silex Parade, 16:30–17:45) ;
- **11 concerts en alerte de capacité**, dont `C062` à la Grande Scène (32 980 personnes pour 30 000
  places) et `C030` au Kiosque (610 pour 600) ;
- la marche de la Clairière à la Serre prend **5 minutes**, et **3** dans l'autre sens.

**La foule :**

- le pic du site : jeudi **38 850** personnes à **21:20**, vendredi **43 620** à **21:50**, samedi
  **44 300** à **21:15**, dimanche **42 750** à **20:50** ;
- à 22:00 : jeudi 37 160, samedi 40 150 ; à 01:00 dans la nuit du samedi : **2 340**.

**Les programmes :**

- **Inès**, jeudi : `C012`, `C013` puis `C019` à 00:30 aux Docks — 5 points, 22 minutes de marche ;
  sur les quatre jours, **21 points** ;
- **Marc** (dernier train à 01:10), jeudi : `C021`, `C022`, `C023`, `C017` — 8 points, 28 minutes ; s'il
  peut rester jusqu'à **03:00**, il gagne `C015` (01:00–02:00 au Chapiteau) : **9 points**, 32 minutes ;
- **Karim**, vendredi : `C051`, `C052`, `C053`, `C044`, `C041` — **9 points**, 27 minutes ;
- **Sofia** (arrivée 18:30), samedi : **aucun concert possible**, et la page dit pourquoi : ses sept
  envies du samedi commencent toutes avant qu'elle puisse être devant la scène ; si elle ajoute
  `C079` (23:00–00:30 aux Docks) en priorité 3, son samedi devient `C079` seul, 3 points, 18 minutes ;
- **Omar**, samedi, arrive à 20:00 : `C079` seul, 2 points ; s'il arrive à **18:00** : `C088` puis
  `C079`, **5 points**, 23 minutes ;
- **Clara** sur les quatre jours : **31 points** ; **Basile** : **30 points**.

**L'allure :**

- dans chacune des trois identités, le texte courant a un contraste d'au moins **4,5 : 1** avec son
  fond, et les gros titres d'au moins 3 : 1 ;
- avec la réduction des animations demandée par le système, plus rien ne bouge tout seul ;
- à chacune de ces tailles — **360 × 740, 390 × 844, 844 × 390 (téléphone couché), 768 × 1024,
  1024 × 768, 1280 × 800, 1920 × 1080 et 2560 × 1440** — et dans chacune des trois identités, aucun
  texte ne déborde, rien ne défile de côté sur la page, rien ne se chevauche et aucun texte n'est
  coupé ; à partir de 1920 px, le plan et la journée se voient ensemble sans défiler ; en dessous de
  480 px, les boutons font au moins 44 px de côté ;
- le premier écran s'affiche en moins d'une seconde, un programme se calcule en moins d'un dixième de
  seconde, une identité se bascule en moins d'un cinquième de seconde ;

**Les décisions et l'initiative :**

- `DECISIONS.md` contient au moins huit décisions et cinq changements dus à une question, avec les
  numéros de messages, et chacun se retrouve dans le fil sous le nom cité ;
- deux fonctionnalités de votre choix marchent et ont leurs tests ; au moins trois défauts d'usage
  sont corrigés et décrits ;

aucune pancarte ne reste à ton nom, et tu as appelé `moi_finir` avec « festival livré » et le nom du
fichier que tu as le plus travaillé.

## Livrable

index.html

## Vérification

bun test
node {DEPOT}/src/voir.ts --partage . index.html --parcours
