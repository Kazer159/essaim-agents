# 🧰 Les outils des agents

[← La vue, écran par écran](README.md)

Un outil, c'est un geste que l'agent peut faire : écrire un message, ouvrir un ticket, lancer les tests. Il en a de deux origines : les outils de **pi** (le programme qui fait tourner l'agent : lire, écrire, modifier un fichier, lancer une commande) et les outils de **la salle**, ajoutés par Essaim, dont le nom commence par sa famille (`salle_`, `ticket_`, `depot_`…).

Un outil interdit à un rôle ne lui est même pas proposé : l'agent ne lit pas sa description pour rien. Et ce qu'un rôle n'a pas le droit de faire, ses outils le refusent. Dans la vue, chaque appel s'affiche avec son libellé en clair (la colonne « Dans la vue » ci-dessous).

---

## 💬 La salle

Le tableau, le seul lien entre les agents.

| Outil | Dans la vue | Ce qu'il fait |
|---|---|---|
| `salle_poster` | écrit un message | Écrit un message sur le tableau, visible de tous. Au démarrage, il refuse tant que celui qui te précède dans l'équipe n'a rien posté (tour de parole). |
| `salle_lire` | lit la boîte | Rend les messages nouveaux depuis ta dernière lecture, en commençant par les questions qui te nomment. |
| `salle_attendre` | attend la salle | Patiente sans rendre la main, puis lit tes messages nouveaux. Ne refuse jamais. |
| `salle_chercher` | cherche dans la salle | Cherche par mots dans les messages, les commits, les faits constatés et les tickets, ou lit un message par son numéro, sans rien marquer lu. Absent d'un run témoin (sans mémoire). |
| `salle_equipe` | regarde l'équipe | Liste les agents : nom, surnom, rôle, état, tickets ouverts, et ce qu'attend un dormeur. |
| `salle_surnom` | se surnomme | Enregistre ton surnom, affiché à côté de ton nom. |
| `salle_budget` | consulte le budget | Rend la dépense de toute la salle, ce qui reste et le rythme des 30 dernières minutes. |

---

## 🙋 Moi

Ce que l'agent fait de lui-même : dormir, finir, se résumer, passer la main.

| Outil | Dans la vue | Ce qu'il fait |
|---|---|---|
| `moi_dormir` | se met en veille | Poste un message, puis met l'agent en veille jusqu'à ce qu'on écrive son nom ou qu'un ticket lui soit confié. Refuse un message vide ou un tour de parole non respecté. |
| `moi_finir` | termine | Déclare la mission terminée et quitte la salle, sans retour possible. Refuse si le livrable en page web ne s'ouvre pas sans erreur, ou s'il est absent. Dans un run à rôles, il se lève aussi quand le lanceur constate la fin du run. |
| `moi_resumer` | se résume | Résume ton propre contexte, puis tu reprends. À la coupure de contexte, c'est le seul outil permis. Présent seulement quand le compactage est actif (c'est le cas par défaut). |
| `moi_passation` | — | Laisse ton siège à un nouvel occupant avec une note, et quitte la salle. Refuse une note vide, ou un siège qui a déjà changé d'occupant autant de fois que le run le permet. |

---

## 🪧 Fichier

Les pancartes disent à tous qui écrit dans quel fichier.

| Outil | Dans la vue | Ce qu'il fait |
|---|---|---|
| `fichier_reclamer` | pose une pancarte | Pose ta pancarte sur un fichier du dossier partagé. Refuse si un autre agent en a déjà une. Dans un run à rôles, elle empêche les autres d'écrire ce fichier. |
| `fichier_liberer` | retire une pancarte | Retire ta pancarte d'un fichier. |
| `fichier_pancartes` | lit les pancartes | Liste les pancartes : le fichier, l'agent, la raison et depuis quand. |

---

## 🗺️ Code

| Outil | Dans la vue | Ce qu'il fait |
|---|---|---|
| `code_carte` | lit la carte du code | Dresse la carte du dossier partagé, en lecture seule : les fichiers, qui s'en sert, qui les a écrits, l'ordre de chargement des scripts. |
| `code_tester` | lance les tests | Lance les tests d'un fichier ou de tout le dossier, et rend le bilan avec le nom de chaque test qui échoue. |

---

## 🗄️ Dépôt

Le dossier partagé est un dépôt git tenu par la salle : chaque écriture est commitée au nom de son auteur.

| Outil | Dans la vue | Ce qu'il fait |
|---|---|---|
| `depot_journal` | lit le journal du dépôt | Liste les derniers commits du dossier commun, du plus récent au plus ancien. |
| `depot_essai` | ouvre un essai | Ouvre une branche d'essai : un dossier à toi, copie du dossier commun. Refuse un nom mal formé ou déjà pris. |
| `depot_adopter` | adopte un essai | Fusionne un essai dans le dossier commun. En cas de conflit, il nomme les fichiers sans rien toucher. |
| `depot_restaurer` | restaure un fichier | Remet un seul fichier dans l'état d'un commit d'avant, et l'annonce. Refuse un fichier sous la pancarte d'un autre. |

---

## 🎫 Ticket

Chaque ticket est posté dans le fil `tickets`, en nommant son chargé.

| Outil | Dans la vue | Ce qu'il fait |
|---|---|---|
| `ticket_ouvrir` | ouvre un ticket | Ouvre un ticket (bug, amélioration, question, ou alerte avec sa reproduction) et rend son numéro. Refuse un chargé absent ou parti, et plusieurs confiages interdits à certains rôles. |
| `ticket_modifier` | modifie un ticket | Change l'état, le chargé ou la note d'un ticket, ou le ferme avec un motif. Mêmes refus que l'ouverture. |
| `ticket_lister` | liste les tickets | Liste les tickets : numéro, type, état, auteur, chargé, titre. |
| `ticket_lire` | lit un ticket | Lit un ticket en entier : description, réponse, historique. Refuse un numéro inconnu. |

---

## 🖼️ Page

Pour regarder le livrable comme le fera le juge.

| Outil | Dans la vue | Ce qu'il fait |
|---|---|---|
| `page_voir` | regarde une page | Ouvre une page du dossier partagé dans un navigateur et rend le texte affiché, les erreurs, les exceptions, et ce que donnent les clics. Refuse une page hors du dossier partagé. |
| `page_mesurer` | mesure une page | Rend des chiffres, sans interprétation : temps d'affichage, images par seconde, poids, erreurs. |
| `page_comparer` | compare deux captures | Compare deux captures PNG et rend la part de l'image qui a changé, avec une image où le changement est en rouge. |
| `page_assembler` | assemble une page | Rassemble les scripts module d'une page en un seul script, pour une page qui s'ouvre en double-clic. Refuse une page hors du dossier partagé ou sans script module. |

---

## 🌐 Web

| Outil | Dans la vue | Ce qu'il fait |
|---|---|---|
| `web_lire` | lit une page web | Lit une page web en texte, sans menus ni scripts, par tranches de 8 000 caractères. Refuse une adresse illisible. |

---

## 📋 Spec, plan, exigences, preuves, révisions

Ces outils n'existent que dans un run à rôles. Ils servent à décider ce que la salle va faire, puis à prouver que c'est fait. Aucun n'a de libellé dans la vue.

| Outil | Dans la vue | Ce qu'il fait |
|---|---|---|
| `plan_proposer` | — | Propose la spec (SPEC.md), puis le plan (PLAN.md), à la recette et au gardien. 6 000 signes au plus par fichier. |
| `plan_juger` | — | Juge la dernière version proposée : `valide`, ou `a_revoir` avec ce qui manque. Refuse s'il n'y a aucune version proposée. |
| `exigence_ranger` | — | Range des phrases de la mission en exigence, exigence transversale ou contexte, avec un responsable de contrôle. Refusé à tout autre que le chef. |
| `exigence_jalonner` | — | Découpe une exigence longue en jalons, chacun avec sa portée. Refusé à tout autre que le chef. |
| `exigence_contester` | — | Conteste le classement d'une exigence : une question au chef, dans le fil `tickets`. Refusé à tout autre que le gardien. |
| `exigence_lister` | — | Liste les exigences rangées par le chef, leurs responsables, leurs jalons et les contestations ouvertes. |
| `preuve_demander` | — | Demande au lanceur le reçu d'une exigence : il rejoue la commande lui-même et écrit le résultat. |
| `preuve_attester` | — | Atteste qu'un reçu prouve une exigence, avec sa portée. Seul le siège responsable signe : la recette les parcours, le gardien les mesures. |
| `preuve_apprecier` | — | Signe une appréciation qualitative, comptée à part : elle ne vaut jamais une preuve. |
| `preuve_lister` | — | Liste les preuves : l'état de chaque exigence, les reçus du registre et les demandes en attente. |
| `revision_demander` | — | Le surveillant demande au chef une révision de la spec : « la spec suppose X ; le run mesure Y ». Deux révisions acceptées au plus par run. |
| `revision_repondre` | — | Le chef accepte ou refuse la révision demandée. Refusé à tout autre que celui qui répartit le travail. |

---

## 🧱 Les outils de pi

Ces quatre outils viennent de pi, pas de la salle. Tous les rôles les ont, et c'est le bac à sable de l'agent qui décide où ils peuvent écrire.

| Outil | Dans la vue | Ce qu'il fait |
|---|---|---|
| `read` | lit un fichier | Lit un fichier. |
| `write` | écrit un fichier | Écrit un fichier. Refusé à un rôle qui n'écrit pas le produit, ou hors de ses fichiers. |
| `edit` | modifie un fichier | Modifie un fichier. Mêmes refus que `write`. |
| `bash` | lance une commande | Lance une commande. Pour la recette, le gardien et le surveillant, le bac à sable ferme le dossier partagé à l'écriture. |

---

## 👥 Qui a quoi

Un ✔ dit que le rôle reçoit l'outil. Un outil sans ✔ ne lui est pas proposé. Les quatre outils de pi (`read`, `write`, `edit`, `bash`) sont donnés à tout le monde, et `moi_resumer` aussi (quand le compactage est actif).

Un constructeur qui supplée l'intégrateur ou le chef a en plus `plan_proposer` ; s'il supplée le chef, il a aussi `revision_repondre`. Ces deux cas sont notés « suppléant ».

| Outil | 🧭 chef | 🔗 intégrateur | 🧩 assembleur | 🔨 constructeur | ✅ recette | 🛡️ gardien | 👁️ surveillant |
|---|---|---|---|---|---|---|---|
| `salle_poster` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `salle_lire` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `salle_attendre` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | |
| `salle_chercher` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `salle_equipe` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `salle_surnom` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | |
| `salle_budget` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `moi_dormir` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `moi_finir` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | |
| `moi_resumer` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `moi_passation` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | |
| `fichier_reclamer` | ✔ | ✔ | ✔ | ✔ | | | |
| `fichier_liberer` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | |
| `fichier_pancartes` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `code_carte` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | |
| `code_tester` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | |
| `depot_journal` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `depot_essai` | | ✔ | ✔ | ✔ | | | |
| `depot_adopter` | | ✔ | | ✔ | | | |
| `depot_restaurer` | | ✔ | ✔ | ✔ | | | |
| `ticket_ouvrir` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | |
| `ticket_modifier` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | |
| `ticket_lister` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `ticket_lire` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `page_voir` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | |
| `page_mesurer` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | |
| `page_comparer` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | |
| `page_assembler` | | ✔ | ✔ | ✔ | | | |
| `web_lire` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | |
| `plan_proposer` | ✔ | ✔ | | suppléant | | | |
| `plan_juger` | | | | | ✔ | ✔ | |
| `exigence_ranger` | ✔ | | | | | | |
| `exigence_jalonner` | ✔ | | | | | | |
| `exigence_contester` | | | | | | ✔ | |
| `exigence_lister` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `preuve_demander` | | | | | ✔ | ✔ | |
| `preuve_attester` | | | | | ✔ | ✔ | |
| `preuve_apprecier` | | | | | ✔ | ✔ | |
| `preuve_lister` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `revision_demander` | | | | | | | ✔ |
| `revision_repondre` | ✔ | | | suppléant | | | |

Ce que les outils de chaque rôle lui interdisent, d'après sa fiche :

- 🧭 **Chef** : il organise, il ne construit pas. Pas d'essai, pas d'adoption, pas de `page_assembler`, et ses outils d'écriture refusent le produit et le monde. Il ne ferme pas d'alerte et ne juge pas.
- 🔗 **Intégrateur** : il fait entrer les parts dans le dossier commun. Quand un chef répartit, ses outils refusent l'essai à lui et l'écriture d'un fichier sans sa pancarte. Il ne range pas les exigences.
- 🧩 **Assembleur** : il tient le livrable. Il n'adopte pas d'essai (c'est l'intégrateur), ne reçoit pas plus de deux bugs ou améliorations à la fois, ni de ticket sur la part d'un autre.
- 🔨 **Constructeur** : il écrit sa part. Ses outils refusent d'écrire hors de sa part (sauf dans un essai ou après une réattribution), le monde et le livrable. `moi_finir` est refusé tant qu'il porte un ticket ouvert.
- ✅ **Recette** : elle utilise le livrable et signe les parcours. Aucune écriture du produit, des essais ni du monde, `bash` compris. On ne peut pas lui confier un bug ou une amélioration.
- 🛡️ **Gardien** : il mesure et signe les mesures. Mêmes interdits que la recette, et `preuve_attester` refuse sa signature quand ni la commande ni le banc du reçu n'utilisent un fichier de son bureau privé.
- 👁️ **Surveillant** : il regarde de l'extérieur, avec une liste d'outils réduite à ce qu'il lui faut pour lire et demander une révision. Ses outils n'écrivent rien dans le dossier partagé, et `salle_poster` ou `moi_dormir` ne lui permettent de parler qu'au chef, au gardien et à la recette.

---

## 🙅 Sans rôles

Un run dont la mission n'a pas de `## Type` n'a pas de rôles : tous les agents sont égaux et reçoivent les mêmes outils. Ce sont les 4 outils de pi et 28 outils de la salle : tous ceux des familles salle, moi, fichier, code, dépôt, ticket, page et web.

Rien de la section « Spec, plan, exigences, preuves, révisions » n'existe, et aucun outil n'a de refus de rôle. Deux détails : `moi_resumer` manque si le compactage est coupé, et `salle_chercher` manque dans un run témoin sans mémoire.

---

[← Les règles fines](regles.md) · [↑ Sommaire](README.md)
