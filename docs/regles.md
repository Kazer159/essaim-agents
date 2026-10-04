# Les règles fines de la salle

[← La vue, écran par écran](README.md)

Ce que le lanceur, les outils et le bac à sable font respecter pendant un run, au-delà des grandes lignes du
README. Chaque règle est née d'un défaut vu dans un vrai run.

## A. Parler et se réveiller

**A1. Un message est court et adressé.** Le prénom de celui qu'il concerne en tête, puis une décision, un fait
ou une demande, en quelques lignes. Le détail (mesures, listes, diagnostics) va dans un fichier du dossier
partagé, et le message donne son chemin : chaque message est relu par chaque agent qu'il réveille, et chacun le
paie.

**A2. Le réveil par le prénom.** Un agent en veille ne se réveille que pour un message qui s'adresse **à lui
seul**, son prénom en tête. Une liste de prénoms en tête (« Claude, Edmond, Denis : … ») ne réveille personne :
pour réveiller plusieurs agents, on leur écrit un message chacun, ou on leur confie un ticket.

**A3. Les questions sans réponse.** Quand un agent relit sa boîte, les questions qui l'attendent (un message
d'un autre, avec un point d'interrogation, qui le nomme en tête) lui sont rappelées en premier, trois au plus.
Répondre est un devoir.

**A4. La veille.** `moi_dormir` met l'agent en veille : son tour s'arrête, il ne coûte plus rien, et il reprend
quand un ticket lui est confié ou qu'un message s'adresse à lui seul. Dans un run à rôles, les veilles sont sans
limite. Quand tous ceux qui restent dorment, le run se ferme : une salle endormie est une salle finie.

## B. Les rôles et leurs limites

**B1. Les outils par rôle.** Un outil de la salle interdit à un rôle ne lui est même pas proposé : la recette n'a
pas d'outil pour adopter un essai, le surveillant n'a qu'une courte liste d'outils, surtout de lecture.

**B2. Celui qui contrôle ne construit pas.** La recette, le gardien et le surveillant ne peuvent pas écrire le
produit, ni par les outils ni par une commande `bash` : le bac à sable leur ferme le dossier partagé en
écriture. Ce qu'ils vérifient ne dépend pas d'eux.

**B3. Les suppléants et la relève.** Chaque siège important a un suppléant : si le chef ou l'intégrateur tombe,
son suppléant tient le siège. Un agent qui part laisse une note de passation ; celui qui reprend son siège, sous
un nouveau prénom, la reçoit avec l'état du siège.

**B4. Chacun son assemblage.** L'intégrateur adopte les essais et tient le contrat entre les parts, rien
d'autre. Quand la mission a un livrable et assez de constructeurs, un assembleur tient le livrable et le
programme qui l'assemble.

**B5. Partir.** Un constructeur ne quitte pas le run de lui-même : il demande d'abord à celui qui répartit s'il
reste du travail, puis attend sa réponse (dix minutes au plus).

## C. Préparer avant de construire

**C1. La spec, puis le plan.** Le chef écrit `SPEC.md` (le but, le problème mesuré, l'approche et les options
écartées, la preuve de chaque exigence), puis `PLAN.md` (le tableau des tickets). Deux fichiers de 6 000 signes
au plus, chacun jugé par la recette et le gardien, qui peuvent le refuser. La spec validée est figée.

**C2. Les explorations.** Pendant la préparation, un constructeur ne reçoit qu'une exploration : une question dont
la réponse est une mesure (un temps, un compte, une liste). On mesure avant de décider.

**C3. La préparation a une fin.** Sans plan validé au bout de 45 minutes, ou quand un quart du plafond est
dépensé, le lanceur clôt la préparation et la salle construit quand même.

**C4. Les jalons.** Une exigence qui ne se prouverait qu'au bout de tout le travail se découpe en jalons
(E4.1, E4.2…), prouvés un à un. L'exigence est attestée quand tous ses jalons le sont, et la progression se voit.

**C5. Les engagements.** Les phrases d'une section `## Engagements` (« rien n'est publié »…) sont rangées à part :
dites, suivies, listées au bilan, mais elles ne bloquent jamais l'acceptation.

## D. Prouver sans croire sur parole

**D1. Les pancartes.** Avant d'écrire dans un fichier, un agent pose sa pancarte dessus. Celle d'un autre refuse
`write` et `edit`, et annule ce qu'un `bash` y écrit. Pour toucher la part d'un autre, on ouvre un essai (une
branche à soi) et on le propose avec sa preuve à son porteur, qui l'adopte ou le renvoie.

**D2. L'alerte « à l'envers » est refusée.** À l'ouverture d'une alerte, l'outil essaie la reproduction une
fois : elle doit **échouer** tant que le défaut est là, puisque l'alerte se ferme quand elle passe. Une
reproduction qui passe déjà est refusée.

**D3. Les reçus.** Seul le lanceur rejoue une preuve, hors des agents, et écrit un reçu qu'aucun agent ne peut
modifier. Quand le produit change, il rejoue lui-même les reçus et réveille celui dont la preuve ne passe plus :
une exigence attestée peut redevenir à prouver.

**D4. Les cas du gardien.** Le gardien prouve ses exigences avec **ses propres** cas, rangés dans un bureau privé
que l'équipe ne peut pas lire. Son attestation est refusée si la preuve ne s'appuie sur aucun de ses fichiers :
une mesure faite avec les tests de l'équipe ne prouve rien de plus que l'équipe elle-même.

**D5. Accepté ou incomplet.** Le run est **accepté** quand toutes les alertes sont fermées, chaque exigence
attestée sur un reçu à jour, et la `## Vérification` de la mission passée. Aucun agent ne peut déclarer seul que
c'est fini. Sinon, le run est **incomplet**, avec ce qui manque.

**D6. La vérification en plusieurs commandes.** `## Vérification` accepte une suite de commandes, lancées l'une
après l'autre, sans nettoyage entre deux : une couture ne se voit qu'en enchaînant.

## E. Le lanceur qui surveille

**E1. Les garde-fous.** Le lanceur coupe un agent silencieux (aucun progrès depuis 15 minutes), un outil bloqué
(plus de 10 minutes), ou une réponse emballée (30 appels identiques, des centaines de morceaux vides, une pensée
qui tourne en boucle) : dans ce dernier cas, l'agent est relancé sans perdre de passe, trois fois au plus.

**E2. Le plafond.** Au plafond de dépense, tout le monde est coupé net, livrable gardé en l'état. C'est une
coupure sur la dépense **observée** : la requête en cours au moment de la coupure est déjà payée.

**E3. Les paliers de budget.** À 25, 50, 75 et 90 % du plafond, le chef reçoit un message du lanceur, avec le
rythme de dépense des 30 dernières minutes et le temps que tient le reste à ce rythme.

**E4. Le surveillant.** Le lanceur mesure, sans dépenser un token, quatre signes d'une salle qui tourne en rond :
le livrable sans commit depuis 45 minutes, trois rejeux échoués de la même exigence en 30 minutes, des tickets
qui reprennent un ticket fermé dans l'heure, 30 minutes sans aucune attestation. Un signe réveille le
surveillant, qui cherche le fait qui contredit la spec (« la spec suppose X, le run mesure Y ») et demande une
révision. Le chef refuse avec sa raison, ou accepte : les tickets touchés sont gelés le temps de revoir la spec et
le plan. Une révision à la fois, deux acceptées au plus.

**E5. La dernière chance.** Si toute la salle dort alors qu'il reste du travail et de l'argent, le lanceur
réveille le chef, trois fois au plus, avant de constater le run incomplet.

**E6. La mémoire et les restes.** Le lanceur arrête toute commande d'un agent qui dépasse 8 Go de mémoire, et
ramasse chaque minute les processus orphelins laissés dans le dossier du run (un serveur de test oublié…).

**E7. Les relances sans coût.** Une erreur passagère du fournisseur relance l'agent sur la même session. Un
résumé de mémoire raté est refait, la seconde fois sans images. Dans les deux cas, l'agent ne perd pas de passe.

## F. Toi, pendant le run

**F1. La pause et la veille de l'ordinateur.** *Pause*, dans la vue, arrête chaque agent dès qu'il n'a plus
d'action en cours : plus rien ne tourne ni ne se paie. *Reprendre* relance chacun sur sa session. Si l'ordinateur
se met en veille, personne n'est coupé pour le temps de la veille.

**F2. Parler au chef.** Le bouton *Chef* envoie une consigne de 600 signes au plus à celui qui répartit le
travail. Elle passe avant le reste de son travail ; voir [Parler au chef](chef.md).

**F3. La taille de la salle.** Jusqu'à 40 agents avec un seul modèle. Avec deux modèles dans la même salle
(`--modele` et `--modele-femmes`), 20 agents au plus, à parts égales : le bilan donne la dépense et l'activité de
chaque côté.

## G. Les prénoms des agents

**G1. Un prénom plutôt qu'un numéro.** Chaque agent porte un prénom du calendrier, sans accent : c'est plus lisible
dans les fils et la trace. Ce prénom signe ses messages, ses pancartes, ses commits, sa session et son bureau. Tu ne
le choisis pas : le lanceur l'attribue au lancement, toujours dans le même ordre.

**G2. L'ordre d'entrée.** Avec un seul modèle, les agents entrent dans l'ordre alphabétique : Antoine, Bernard,
Claude, Denis, Edmond, Fabien, Gaston, Hubert, Jules, Lucien… jusqu'à Xavier, le vingtième. Au-delà, jusqu'à 40,
la liste de la relève prend la suite (Achille, Basile, Cyprien…).

**G3. Les rôles suivent l'ordre des sièges.** Dans un run à rôles, les sièges sont attribués dans l'ordre : le chef
d'abord, puis l'intégrateur, les constructeurs, la recette et le gardien. Avec huit agents sur une application,
Antoine est donc toujours le chef, Bernard l'intégrateur, Claude à Fabien les constructeurs, Gaston la recette et
Hubert le gardien. Le surveillant vient **en plus** des agents demandés et prend le premier prénom libre (Jules,
ici).

**G4. Deux modèles : des agentes.** Avec `--modele-femmes`, le second modèle reçoit des prénoms féminins aux mêmes
initiales (Agathe, Brigitte, Cecile…, Yvonne pour la dernière), à parts égales, en alternance avec les hommes : on
voit d'un coup d'œil quel modèle a écrit quoi.

**G5. La relève.** Quand un agent part et qu'un autre reprend son siège, le nouvel occupant prend le premier prénom
encore libre : la suite du calendrier (Lucien, après une équipe de huit et son surveillant), puis la liste de la
relève (Achille…). Jamais celui d'un agent déjà passé dans le run, pour que la trace ne mélange pas deux agents.

**G6. Le surnom.** Un agent peut se donner un surnom (`salle_surnom`), affiché à côté de son prénom. On le réveille
aussi bien par son prénom que par son surnom, écrit en mot entier en tête du message.

**G7. Parler à un agent.** Dans une consigne au chef ou dans la mission, on désigne un agent par son prénom, et
plutôt par son rôle quand on ne sait pas encore qui le tiendra (« le chef », « le gardien »). Pour qu'un message le
réveille, son prénom doit être **seul en tête** (règle A2).
