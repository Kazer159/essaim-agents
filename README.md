# Essaim

Une équipe d'agents IA qui réfléchit et construit ensemble.

[Sécurité](#sécurité) · [La salle](#la-salle) · [Les rôles](#les-rôles) · [Le déroulé](#le-déroulé-dun-run) · [La vue](#le-lanceur-et-la-vue) · [Installer](#installer) · [Lancer](#lancer) · [Écrire une mission](#écrire-une-mission)

Essaim fait travailler jusqu'à 40 agents IA sur une même mission, comme une vraie équipe. Tu écris la
mission dans un fichier texte, tu lances, et les agents s'organisent pour livrer un seul résultat.

Ils ne
travaillent pas chacun dans leur coin : avant de construire, ils mesurent, se relisent et se contredisent,
et ils continuent pendant tout le run.

![La vue pendant un run : la discussion, les tickets, et qui travaille sur quoi](docs/images/pendant-fils.png)

🖥️ **[Voir l'interface, écran par écran →](docs/README.md)** : chaque écran de la vue expliqué sur un run d'exemple.

📏 **[Les règles fines de la salle →](docs/regles.md)** : ce que le lanceur, les outils et le bac à sable font respecter.

🧰 **[Les outils des agents →](docs/outils.md)** : chaque outil, en une phrase, et qui a quoi selon son rôle.

<a id="sécurité"></a>
## ⚠️ Sécurité, à lire avant d'essayer

> [!WARNING]
> Les agents exécutent de vraies commandes sur ta machine : lis cette section avant d'essayer.

- Les agents exécutent de **vraies commandes shell sur ta machine**. Ils tournent dans un bac à sable macOS
  (`sandbox-exec`, profil `src/bac-a-sable.sb`) qui limite l'écriture au dossier du run et refuse l'accès à
  `~/.ssh`, à la configuration de `gh` et au trousseau macOS. Ne lance jamais un run sans bac à sable.
- Les agents peuvent **sortir sur internet en HTTPS, vers n'importe quel site** : `sandbox-exec` ne filtre
  pas par nom de domaine.
- Il faut **ta propre clé OpenRouter**, lue dans `~/.config/essaim/openrouter.key` (ou
  `ESSAIM_CLE_OPENROUTER`). Un run coûte de quelques centimes à quelques dollars : crée une clé dédiée
  avec un plafond de dépense. Le lanceur coupe aussi tout au plafond donné par `--plafond`.
- Avec un **abonnement** (voir *Modèles et abonnements*), pi garde lui-même son jeton de connexion : les agents qui
  tournent sur cet abonnement lisent alors le dossier de pi du compte (`~/.pi/agent`, `auth.json` compris). Ne
  l'utilise que sur une machine et un compte où c'est acceptable.
- Rien n'est envoyé ailleurs qu'au fournisseur du modèle. La vue web n'écoute que sur `127.0.0.1`.

---

<a id="la-salle"></a>
## 🏠 La salle

Tous les agents sont dans une même salle virtuelle :

- **Le tableau blanc** (une base SQLite par run) : leur seul moyen de se parler. Chaque message est lu par
  toute la salle, et chacun paie sa lecture : un message est court, adressé à quelqu'un par son prénom, et
  le détail va dans un fichier.
- **Le dossier partagé** : le produit, ce que verra le juge. Chaque modification y est commitée dans git
  au nom de son auteur.
- **Les pancartes** : avant d'écrire dans un fichier, un agent pose une pancarte dessus ; personne d'autre
  n'écrit dans un fichier qui porte la pancarte d'un collègue.
- **Les tickets** : chaque tâche, bug ou question a un ticket et un responsable.
- **Le bureau privé** : le coin de chaque agent. Le gardien y garde ses cas de test secrets.
- **Le budget commun** : quand il est épuisé, tout le monde s'arrête. La salle raisonne avec lui tout le run :
  le coût fait partie du résultat, chaque lecture se paie, le chef reçoit les paliers de dépense et décide des
  priorités ([penser au budget](docs/regles.md#h-penser-au-budget)).
- **La veille** : un agent sans travail s'endort et ne coûte plus rien ; il se réveille quand un collègue
  lui écrit. Quand tout le monde dort, le run est terminé.
- **Les prénoms** : chaque agent porte un prénom du calendrier, attribué par le lanceur dans l'ordre (Antoine,
  Bernard, Claude…) ; avec des rôles, Antoine est toujours le chef. Le détail est dans
  [les règles fines](docs/regles.md#g-les-prénoms-des-agents).

---

<a id="les-rôles"></a>
## 🎭 Les rôles

Une mission qui porte une section `## Type` fait attribuer des rôles (`src/roles.ts`, fiches dans
`src/roles/`) :

- 🧭 **Le chef** découpe la mission en exigences, écrit la spec et le plan, et donne un ticket à chacun. Il
  n'écrit pas le produit.
- 🔨 **Les constructeurs** écrivent chacun leur part, dans leur propre branche git, avec sa preuve : un test
  ou une commande que les autres peuvent relancer.
- 🔗 **L'intégrateur** relance la preuve de chaque part, vérifie qu'elle s'emboîte avec les autres et l'adopte.
  Il tient le contrat entre les parts.
- 🧩 **L'assembleur** produit le livrable final à partir des parts adoptées.
- ✅ **La recette** joue le premier utilisateur et signale chaque défaut avec une reproduction.
- 🛡️ **Le gardien** vérifie que la réussite n'est pas truquée : test qui vérifie la mauvaise chose, règle de
  la mission assouplie, mesure arrangée.
- 👁️ **Le surveillant** dort la plupart du temps ; il se réveille quand l'équipe tourne en rond et cherche
  l'erreur dans le raisonnement de départ.

La recette, le gardien et le surveillant ne peuvent pas modifier le produit : le bac à sable les en empêche.
Celui qui contrôle n'est jamais celui qui construit.

---

<a id="le-déroulé-dun-run"></a>
## 🔄 Le déroulé d'un run

1. **Préparation** : le chef range chaque phrase de la mission en exigences ; les constructeurs font des
   explorations, des questions dont la réponse est une mesure.
2. **La spec** (`SPEC.md`) : le but, le problème mesuré, l'approche choisie et les options écartées, la
   commande qui prouvera chaque exigence. Une exigence longue se découpe en jalons. La recette et le
   gardien la jugent et la refusent si elle a un défaut (voir [la spec : réfléchie, puis jugée](#la-spec--réfléchie-puis-jugée)).
3. **Le plan** (`PLAN.md`) : le tableau des tickets, avec qui construit et qui vérifie (jamais le même).
4. **La construction** : chaque constructeur propose son travail avec sa preuve ; l'intégrateur la rejoue,
   adopte ou renvoie avec la commande qui échoue.
5. **Le contrôle continu** : la recette et le gardien attestent chaque exigence dès qu'elle passe ; quand le
   produit change, le lanceur rejoue les preuves et réveille celui dont la preuve ne passe plus.
6. **La remise en question** : si l'équipe tourne en rond, le surveillant écrit au chef « la spec suppose
   X, le run mesure Y » ; le chef refuse avec sa raison, ou accepte et les tickets concernés sont gelés le
   temps de revoir la spec et le plan.
7. **La fin** : le run n'est accepté que si toutes les alertes sont fermées et toutes les exigences
   attestées. Aucun agent ne peut déclarer seul que c'est fini.

---

<a id="la-spec--réfléchie-puis-jugée"></a>
## 📝 La spec : réfléchie, puis jugée

Avant que quiconque construise, la salle écrit et fait juger sa façon de résoudre la mission. C'est la spec.

**Le chef la réfléchit.** Il commence par mesurer : il confie des explorations aux constructeurs (« combien de
réservations un vendredi ? »), dont la réponse est un chiffre, pas une opinion.

Puis il écrit `SPEC.md`, 6 000
signes au plus :

- **le but** en une phrase ;
- **le problème, mesuré** : ce qui empêche d'y arriver aujourd'hui ;
- **l'approche choisie**, et **les options écartées avec leur raison** (dans le run d'exemple : pas de
  `localStorage`, qui laisserait des réservations fantômes d'un soir à l'autre), appuyées sur ce que les
  explorations ont mesuré ;
- **chaque exigence avec la commande qui la prouvera** et le rôle qui la vérifiera.

**Les contrôleurs la jugent, et la refusent si elle a un défaut.** La recette et le gardien la lisent contre le
texte entier de la mission, chacun de son côté, et répondent `valide` ou `à revoir` avec leur raison. Ils se
demandent :

- l'approche mène-t-elle vraiment au but, **sans fabriquer de réussite** (une règle de la mission assouplie, une
  mesure arrangée) ?
- chaque exigence a-t-elle une commande de preuve que le lanceur pourra rejouer telle qu'elle est écrite ?
- une phrase de la mission a-t-elle été oubliée, ou mal rangée ?

Une spec **à revoir** retourne au chef avec ce qui manque. Il en écrit une nouvelle version, numérotée, qui est
jugée à nouveau. Elle n'est validée que quand **chaque** contrôleur présent l'a validée, puis elle est **figée** :
plus personne ne la réécrit en douce.

**Le plan suit le même chemin.** `PLAN.md` découpe la spec en tickets. Les contrôleurs vérifient que chaque
exigence a ses tickets, que chaque ticket a un porteur et **un vérificateur qui n'est pas son porteur**, et que le
coût tient dans le budget. Tant que le plan n'est pas validé, les constructeurs attendent.

**Une spec peut encore tomber en cours de route.** Si le run montre qu'elle se trompait, le surveillant écrit au
chef « la spec suppose X, le run mesure Y ». Si le chef accepte, la spec est rouverte, réécrite et jugée de
nouveau, et les tickets touchés sont gelés en attendant.

Pour que la salle ne discute pas sans fin, le lanceur clôt la préparation après 45 minutes sans plan validé, ou
quand un quart du budget est dépensé.

---

<a id="le-lanceur-et-la-vue"></a>
## ⚙️ Le lanceur et la vue

**Le lanceur, c'est le programme que tu démarres** (`just lancer`, ou `bun src/lancer.ts`). Ce n'est pas une IA :
il ne réfléchit pas, ne décide rien du travail et ne coûte aucun token. Il tient la salle, comme un surveillant
d'examen tient une salle d'examen. Tout ce qui est signé `lanceur` dans la vue (un message, un commit, un reçu) vient
de lui.

Ce qu'il fait, du début à la fin d'un run :

- **Il ouvre la salle** : il lit la mission, crée le dossier du run, le tableau et le dépôt git, attribue les
  prénoms et les rôles, et démarre chaque agent dans son bac à sable.
- **Il fait passer les messages** : il réveille l'agent à qui on écrit, transmet les consignes de la vue au chef,
  écrit au chef les paliers de budget, et commite chaque écriture au nom de son auteur.
- **Il surveille** : il coupe un agent muet, bloqué ou qui tourne en boucle, arrête une commande qui prend trop de
  mémoire, et coupe tout le monde au plafond de dépense.
- **Il prouve** : c'est lui, hors des agents, qui rejoue les preuves et écrit les reçus. Aucun agent ne peut
  affirmer que son travail marche : seul un reçu du lanceur qui passe le prouve.
- **Il constate la fin** : il rejoue la vérification de la mission, décide si le run est accepté ou incomplet, et
  écrit le bilan.

Les agents, eux, sont les modèles d'IA : ils réfléchissent, discutent et construisent. Le lanceur les fait
travailler, mais ne travaille jamais à leur place.

La vue (`just vue`, puis http://127.0.0.1:4700) suit le run en direct : le fil des messages, la fiche de
chaque agent, les tickets, l'historique git, et une vue 3D en forme de cerveau qui montre qui parle à qui.
On peut mettre en pause, reprendre, ou envoyer une consigne au chef.

---

<a id="installer"></a>
## 📦 Installer

Prérequis : **macOS sur Apple Silicon**, [Bun](https://bun.sh) 1.4 ou plus, [`just`](https://github.com/casey/just)
(facultatif), et l'agent [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 0.85.1 dans
le `PATH` (ou `ESSAIM_PI=/chemin/vers/pi`).

```sh
bun install
npx playwright-core install chromium-headless-shell   # le navigateur avec lequel les agents regardent leurs pages
mkdir -p ~/.config/essaim && printf '%s' 'sk-or-…' > ~/.config/essaim/openrouter.key
mkdir -p runs
bun run test                                           # sans aucun token : un faux pi joue les agents
```

---

<a id="lancer"></a>
## 🚀 Lancer

```sh
just lancer 6 deepseek-flash-41 0.50 missions/exemples/roles-mini.md
# ou : bun src/lancer.ts --agents 6 --modele deepseek-flash-41 --plafond 0.50 --mission missions/exemples/roles-mini.md
```

Les modèles sont décrits dans `modeles.yaml`. Deux modèles dans la même salle :
`just lancer-mixte 6 deepseek-flash-41 glm-flash-53 0.50 <mission>`.

Chaque run vit dans `runs/<horodatage>/` :
le tableau, le dossier partagé, les sessions et le journal.

Une mission est un fichier Markdown : voir [Écrire une mission](#écrire-une-mission) plus bas.
Les missions du dépôt, avec leurs données dans `missions/entrees/` et leurs juges dans `sondes/` :

- `hopital.md` : un programme qui construit le planning de quatre semaines d'un service de médecine
  (46 soignants, trois postes, règles de repos et d'équité).
- `restaurant.md` à `restaurant-6.md` : l'application complète d'un restaurant, huit pages synchronisées en
  direct ; à partir de la version 4, aucun client ne doit attendre plus de dix minutes pendant une soirée
  tirée au hasard. Les versions 2 à 6 partent du livrable d'un run précédent : leurs chemins `runs/…`
  sont ceux de mes runs, à remplacer par les tiens.
- `hotel.md` : la réception d'un hôtel, réservations, tarifs à plusieurs étages et demandes impossibles.
- `festival.md` : l'application d'un festival, en trois identités visuelles et huit tailles d'écran.
- `ligne.md` : une année de trains sur une ligne de montagne, simulée et affichée.
- `exemples/roles-mini.md` : une petite mission pour essayer les rôles sans dépenser beaucoup.

---

<a id="modèles-et-abonnements"></a>
## 🧠 Modèles et abonnements

Les modèles sont décrits dans `modeles.yaml` : un alias, l'identifiant chez pi, le niveau de réflexion et, au
besoin, un tarif. Par défaut, ils passent par OpenRouter et le plafond compte chaque centime.

**Un abonnement dans un run : c'est fait pour Codex.** Un run peut faire tourner une partie de ses agents sur un
abonnement ChatGPT, par le fournisseur `openai-codex` de pi (alias `sol-codex`, GPT-6 Sol). On le donne en
général aux sièges uniques, ceux qui décident et contrôlent :

```sh
bun src/lancer.ts --agents 8 --modele deepseek-flash-41 --plafond 2 --mission missions/hotel.md \
  --modele-role chef=sol-codex --modele-role gardien=sol-codex
```

Les constructeurs restent sur un modèle bon marché d'OpenRouter, le chef et le gardien raisonnent avec le modèle de
l'abonnement.

> [!NOTE]
> Le tarif de l'abonnement est à 0 dans `modeles.yaml` : le plafond ne compte que ce qui passe par
> OpenRouter, et le quota du forfait n'est pas suivi par l'essaim. Il faut s'être connecté une fois dans pi
> (`pi`, puis `/login`).

**Prochain objectif : un abonnement Claude.** Faire tourner les agents, ou au moins les sièges uniques, sur un
abonnement Claude, comme c'est déjà possible avec Codex.

---

<a id="écrire-une-mission"></a>
## ✍️ Écrire une mission

La mission est le seul texte que les agents reçoivent de toi. Tout ce qu'elle ne dit pas, ils le décideront à ta
place.

**1. Un but précis et détaillé : obligatoire.** Avant toute section, la mission dit ce qu'on veut obtenir, pour
qui, dans quelle situation, et ce qui compte le plus. Un but vague (« une appli de réservation ») laisse les agents
remplir les trous à leur façon, et le gardien ne peut pas dire si la réussite est vraie. Un but précis se mesure :
« pendant une soirée tirée au hasard, aucun client n'attend plus de dix minutes ».

Le lanceur ne vérifie pas le but
à ta place : c'est la règle d'écriture qui compte le plus.

**2. Les sections.** Les titres s'écrivent exactement ainsi ; un titre presque bon (« ## Vérifications ») est
refusé au lancement, pour ne pas être ignoré en silence.

| Section | Rôle | |
|---|---|---|
| `## C'est fini quand` | ce que le juge constatera, en phrases prouvables | **exigée** : sans elle, le lanceur refuse la mission |
| `## Type` | `application`, `jeu`, `simulation`, `document`, `probleme` ou `fichier` : donne des rôles à la salle | conseillée |
| `## Livrable` | le fichier final, relatif au dossier partagé (`index.html`) | conseillée |
| `## Vérification` | une ou plusieurs commandes, rejouées par le lanceur à la fin | conseillée |
| `## Engagements` | les règles de conduite (« rien n'est publié ») : suivies, jamais bloquantes | si besoin |

**3. Chaque exigence dit comment elle se prouve** : une commande que le lanceur peut rejouer, ou le cas d'un juge.
Une phrase qu'aucune commande ne peut prouver n'est pas une exigence : mets-la dans le but ou dans le contexte.

**4. Les interdictions de conduite vont dans `## Engagements`**, pas dans les exigences : sinon le run ne peut
jamais être accepté sur elles.

**5. « C'est fini quand » ne contient que des phrases prouvables**, au sens de la règle 3.

**6. Le monde en données.** Les chiffres qui décident de la réussite (durées, capacités, tarifs, règles) vont dans
des fichiers de données, donnés au lancement avec `--fichier` (répétable, 50 Ko par fichier). Ils arrivent dans le
dossier des documents à traiter, en lecture seule pour tous les agents, et `{ENTREES}` dans la mission donne leurs
chemins ; ceux des missions du dépôt sont dans `missions/entrees/`. Le juge peut alors les remplacer par les siens :
une réussite obtenue en changeant le monde (une cuisson ramenée de 14 à 4 minutes…) ne passe plus.

### 🍽️ Un exemple complet : la soirée du Refuge

La mission [`missions/exemples/soiree-refuge.md`](missions/exemples/soiree-refuge.md) demande l'application
complète d'un restaurant de trente tables, et un but qui se mesure : **pendant une soirée tirée au hasard, aucun
client n'attend plus de dix minutes**. Voici comment elle est construite, section par section.

| Section | Ce qu'elle apporte | Règle |
|---|---|---|
| `## Le but` | le résultat mesurable (personne n'attend plus de dix minutes), pour qui (serveurs sur tablette, cuisiniers au passe, patron sur téléphone), et ce qui compte dans quel ordre | 1 |
| `## Les données fournies` | six fichiers CSV, seule source de vérité : tables, carte, recettes, ingrédients, réservations, et le monde | 6 |
| `## Le monde` | `rythme.csv` : temps de cuisson, gestes, arrivées. L'application le lit sans le changer, et le juge le remplace par le sien | 6 |
| `## Personne n'attend` | ce que veut dire « attendre », ce qui ne compte pas comme une attente évitée (renvoyer un client, presser une table), et comment chaque attente se mesure | 1, 3 |
| `## La soirée` | 220 couverts tirés au hasard pendant qu'elle se joue, les problèmes d'un vrai service, et le juge qui peut reprendre la main | 1 |
| `## Les huit pages` | les adresses des pages et la règle des fenêtres d'accord en moins d'une seconde | 3 |
| `## Le parcours d'un client` | de l'arrivée au débarrassage, sans rien ressaisir | 3 |
| `## Les règles du restaurant` | les calculs exacts : réservation, rupture, TVA par taux, parts égales au centime près | 3 |
| `## Ce qui compte d'abord : le design et l'expérience` | ce que le juge regarde en premier | 1 |
| `## Ce que le juge fera, sans lire aucune doc` | ses gestes, annoncés d'avance : son propre monde, dix soirées, trois fenêtres, tout recalculé à la main | 3 |
| `## Les documents` | `SOLUTIONS.md`, `DECISIONS.md`, `MODE-D-EMPLOI.md` | 3 |
| `## Engagements` | « rien n'est publié ni envoyé hors de la machine » : suivi, jamais bloquant | 4 |
| `## Type` | `application` : la salle reçoit ses rôles | 2 |
| `## C'est fini quand` | uniquement des phrases que le juge ou une commande peuvent prouver | 2, 5 |
| `## Livrable` et `## Vérification` | `index.html`, puis `bun test` et un parcours de visiteur rejoué par le lanceur | 2, 3 |

Ce qui la rend bonne :

- **Le but ne laisse rien à deviner.** « Une appli de restaurant » laisserait chaque agent imaginer la sienne ;
  « personne n'attend plus de dix minutes, sur une soirée tirée au hasard » dit au chef quoi mesurer, aux
  constructeurs quoi optimiser, et au gardien quoi vérifier.
- **Le monde est dans les données.** Une salle tentée de raccourcir une cuisson pour tenir les dix minutes ne
  peut pas : la cuisson vient de `rythme.csv`, que le juge remplace par le sien.
- **Le juge est annoncé.** Les agents savent d'avance comment ils seront jugés : ils construisent pour ces
  gestes-là, et la recette peut les rejouer avant lui.

Pour la lancer, avec ses données :

```sh
bun src/lancer.ts --agents 10 --modele deepseek-flash-41 --plafond 5 --mission missions/exemples/soiree-refuge.md \
  --fichier missions/entrees/restaurant-6/tables.csv --fichier missions/entrees/restaurant-6/carte.csv \
  --fichier missions/entrees/restaurant-6/recettes.csv --fichier missions/entrees/restaurant-6/ingredients.csv \
  --fichier missions/entrees/restaurant-6/rythme.csv --fichier missions/entrees/restaurant-6/reservations.csv
```

> [!NOTE]
> Le [run d'exemple de la documentation](docs/README.md) utilise une mission volontairement plus petite (une page
> de réservations), pour que chaque écran reste lisible sur une capture.

---

<a id="comment-il-a-été-construit"></a>
## 🛠️ Comment il a été construit

Le code (TypeScript sur Bun, plus de 1 000 tests), les specs et les plans ont été écrits avec Claude Code.
Chaque règle vient d'un défaut constaté dans un vrai run ; les commentaires du code en gardent la trace.

---

<a id="licence"></a>
## 📄 Licence

MIT, voir `LICENSE`.
