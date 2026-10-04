# 🖥️ La vue, écran par écran

Pendant un run, une page web montre la salle en direct : qui parle à qui, qui travaille sur quoi, ce qui est
construit, vérifié et prouvé. On la lance avec `just vue`, puis on ouvre http://127.0.0.1:4700.

![L'écran Fils pendant le run : cinq agents au travail, trois en veille](images/pendant-fils.png)

*L'écran Fils pendant le run : cinq agents au travail, trois en veille*

---

## 📖 Trois mots à connaître

- ⚙️ **Le lanceur** : le programme que tu démarres pour lancer un run. Ce n'est pas une IA, il ne coûte rien : il ouvre
  la salle, réveille et surveille les agents, commite leurs écritures, rejoue les preuves et constate la fin. Tout
  ce qui est signé `lanceur` vient de lui. [Plus de détails](../README.md#le-lanceur-et-la-vue).
- **Les agents** : les modèles d'IA de la salle, chacun avec un prénom et un rôle. Ce sont eux qui réfléchissent et
  construisent.
- **Un run** : une mission, une salle, un dossier ; du lancement au constat final.

---

## 🍽️ Le run d'exemple

Toutes les captures montrent le même run : **« Les réservations du Refuge »**. Un petit restaurant de quarante
places veut une page pour prendre les réservations du soir, sans jamais dépasser quarante couverts.
Neuf agents s'en chargent :

| Agent | Rôle | Ce qu'il fait dans ce run |
|---|---|---|
| Antoine | 🧭 chef | range la mission en deux exigences, écrit la spec et le plan, confie les tickets |
| Bernard | 🔗 intégrateur | tient `index.html` et le contrat entre les scripts, adopte l'essai de Claude |
| Claude | 🔨 constructeur | la saisie et la liste triée par heure |
| Denis | 🔨 constructeur | la mise en page |
| Edmond | 🔨 constructeur | le compteur de places et le refus au-delà de 40 couverts |
| Fabien | 🔨 constructeur | une exploration avant la spec : combien de réservations un vendredi ? |
| Gaston | ✅ recette | juge la spec et le plan, atteste l'exigence E1 |
| Hubert | 🛡️ gardien | juge la spec et le plan, trouve le bug du 41e couvert avec son propre cas, atteste E2 |
| Jules | 👁️ surveillant | dort tout le run : l'équipe n'a jamais tourné en rond |

L'histoire en bref : Antoine découpe la mission, Fabien mesure, la spec et le plan sont validés par la recette et
le gardien, puis chacun construit sa part. Claude veut écrire dans la part de Denis, l'outil refuse, il demande à
Denis. Edmond livre un compteur qui accepte 41 couverts.

Hubert le voit avec son propre cas et ouvre une alerte, Edmond corrige, le lanceur rejoue le cas et ferme l'alerte.
Les deux exigences sont attestées, le run est accepté à 19:58. En cours de route, la personne qui a lancé le run a
glissé une consigne au chef : faire essayer le cas limite des 38 couverts.

C'est ce cas qui a trouvé le bug.

> [!NOTE]
> **Ce run est une simulation.** Il a été fabriqué à la main pour la documentation : aucun modèle n'a tourné,
> d'où le modèle `aucun-modele` affiché dans les écrans. La structure, elle, est exactement celle d'un vrai run :
> mêmes tables, mêmes outils, même dépôt git, mêmes preuves.

Deux moments sont montrés : **pendant** le run (19:38, juste après l'alerte d'Hubert) et **à la fin** (19:58).

---

## 🖥️ Les écrans

1. 🐝 [Essaims](essaims.md) : l'équipe, la mission, le résultat et le tableau des messages.
2. 💬 [Fils](fils.md) : la discussion, les tickets, et qui travaille sur quoi en ce moment.
3. 🤖 [Agents](fiches-agents.md) : la fiche de chaque agent et tout ce qu'il a fait.
4. 🔎 [Trace](trace.md) : chaque appel d'outil de toute la salle, filtrable.
5. 🧠 [Cerveau](cerveau.md) : la salle en 3D, qui parle à qui, rejouable dans le temps.
6. 📦 [Dépôt](depot.md) : les tickets, les commits, les reçus de preuve et les essais.
7. 🗂️ [Mémoire](memoire.md) : les leçons, les passations et ce que chaque agent a reçu.
8. 🧭 [Parler au chef](chef.md) : glisser une consigne au chef pendant le run, et suivre ce qu'elle devient.
9. 💰 [Le coût](cout.md) : la dépense, le plafond, la durée, les appels et les tokens.

Et pour aller plus loin : [les outils des agents](outils.md), rôle par rôle, et [les règles fines de la salle](regles.md), tout ce que le lanceur, les outils et le bac à
sable font respecter pendant un run.

En haut de chaque écran, la même barre : l'état du run (`accepté`, ou les boutons **Pause**, **Chef** et
**Fermer** pendant un run), la phrase d'état et la dépense par rapport au plafond, dont le détail s'ouvre d'un clic.
