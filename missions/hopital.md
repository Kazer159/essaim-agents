# Le planning du service de médecine de l'hôpital de Sarrat

Mission écrite le 28/09/2026. Ce n'est pas une application à montrer : c'est **un problème à résoudre**.

Le service de médecine interne de l'hôpital de Sarrat tourne jour et nuit. Quarante-six soignants (infirmiers
diplômés, IDE, et aides-soignants, AS) s'y relaient sur trois postes : le matin, l'après-midi et la nuit. Chaque
mois, la cadre de santé passe des jours à construire le planning des quatre semaines suivantes, à la main, et
reçoit des plaintes : des nuits toujours pour les mêmes, des week-ends jamais libres, des repos trop courts
entre deux postes. Le livrable est **un programme qui construit ce planning**, à partir de n'importe quelles
données au format décrit plus bas, **le planning des quatre semaines fournies**, et une page pour le lire.

**La finalité : un planning que le service peut afficher lundi**, qui tient toutes les règles, couvre tous
les besoins, et qu'un soignant trouve juste quand il le compare à celui de ses collègues. Quand c'est
impossible, le programme le dit, et dit pourquoi, chiffres à l'appui.

Le découpage, les fichiers, les méthodes de résolution et la façon de travailler sont à vous.

## Type

probleme

## Le monde

Six fichiers décrivent **le monde** : le service, ses besoins et ses règles ({ENTREES}). Le programme les lit
et ne les change pas ; aucune valeur n'est écrite ailleurs dans le code.

- `soignants.csv` : chaque soignant, son métier (`IDE` ou `AS`), son contrat (100, 80 ou 50 %), ses
  compétences (`referent`, `dialyse`, séparées par `;`), s'il peut travailler de nuit, son ancienneté ;
- `postes.csv` : les trois postes (`M`, `S`, `N`), leurs heures de début et de fin, leur durée ;
- `besoins.csv` : pour chaque jour et chaque poste, l'effectif minimal par métier, et par compétence quand
  une compétence est exigée ;
- `absences.csv` : les absences déjà connues (congés, formation, maladie), bornes comprises ;
- `voeux.csv` : les vœux des soignants pour un jour (un poste précis, ou `repos`) ;
- `regles.csv` : la période et les règles de travail.

**Le juge apporte son propre monde** : au moment de juger, il lance le programme sur d'autres fichiers au
même format, que vous ne connaissez pas : un autre service, d'autres effectifs, d'autres absences, d'autres
règles, parfois impossibles à tenir toutes. Ce qui est dit plus bas doit tenir dans ce monde-là aussi.

## Ce que le planning doit tenir

Ces règles viennent de `regles.csv`, avec les valeurs de ce fichier ; aucune n'est une préférence :

- chaque jour et chaque poste, l'effectif minimal de `besoins.csv` est atteint, par métier et par compétence ;
- un soignant tient au plus un poste par jour, jamais pendant une absence, jamais un poste de nuit s'il n'y
  est pas autorisé, jamais un poste qui exige un métier ou une compétence qu'il n'a pas ;
- entre la fin d'un poste et le début du suivant, le repos minimal est respecté (un poste de nuit finit le
  lendemain matin) ;
- dans chaque semaine civile : le repos hebdomadaire consécutif minimal, et les heures maximales ;
- au plus le nombre maximal de nuits de suite, et de jours travaillés de suite ;
- sur la période, les heures planifiées de chacun restent dans l'écart toléré autour de ses heures dues
  (heures de contrat à 100 %, au prorata de son contrat, moins ses jours d'absence) ;
- chacun a au moins le nombre minimal de week-ends entièrement libres.

## Ce qui fait un bon planning

Parmi les plannings qui tiennent toutes les règles, le meilleur est celui que le service trouve juste :

- **l'équité** : les nuits, les week-ends travaillés et les postes du soir sont répartis entre soignants de
  même métier au prorata de leur contrat ; l'écart entre le plus chargé et le moins chargé se mesure et se
  voit ;
- **les vœux** : le plus grand nombre de vœux tenus, et aucun soignant dont tous les vœux sont refusés
  quand d'autres voient tous les leurs tenus ;
- **la régularité** : pas de changements de poste inutiles d'un jour à l'autre pour une même personne.

Ces trois critères se chiffrent, et le programme donne ses chiffres. Un choix entre deux critères qui
s'opposent est écrit avec sa raison.

## Quand c'est impossible

Dans certains mondes du juge, aucun planning ne tient toutes les règles. Le programme ne le cache pas :

- il dit quelles règles ne peuvent pas tenir ensemble, où (jour, poste, métier) et de combien ;
- il rend le planning qui s'en approche le plus, chaque manque et chaque dépassement listé et chiffré ;
- il ne présente jamais comme tenu ce qui ne l'est pas.

## Ce que le juge fera, sans lire aucune doc

- lancer le programme sur les données fournies, puis sur ses propres mondes, et mesurer lui-même, avec son
  propre vérificateur, chaque règle, sur chaque soignant, chaque jour et chaque semaine ;
- comparer ce que le programme affirme (règles tenues, chiffres d'équité, vœux tenus) à ce qu'il mesure :
  toute affirmation fausse compte plus lourd qu'un défaut avoué ;
- chercher dans le code des valeurs du monde écrites en dur, ou un planning écrit à l'avance ;
- donner au programme un monde impossible, et regarder ce qu'il en dit ;
- mesurer le temps de calcul sur un service deux fois plus grand ;
- ouvrir la page et lire le planning d'un soignant, d'un jour, d'une semaine, et les chiffres d'équité, sur
  grand écran, sur téléphone et en aperçu d'impression A3, et juger son design ;
- lire le rapport, et vérifier que chacune de ses affirmations se retrouve dans les chiffres.

## La page du planning

Le planning s'affiche dans la salle de soins et se consulte sur le téléphone de chaque soignant : la page est
**la sortie que le service voit**, et son design compte autant que le calcul.

- **D'un coup d'œil** : le planning des quatre semaines, un soignant par ligne et un jour par colonne, où l'on
  distingue immédiatement un matin, un après-midi, une nuit, un repos, une absence et un vœu tenu ou refusé ;
  les week-ends et les semaines se repèrent sans chercher.
- **Pour un soignant** : son mois à lui, ses heures planifiées face à ses heures dues, ses nuits, ses
  week-ends, ses vœux tenus.
- **Pour un jour** : qui est là à chaque poste, et si l'effectif et les compétences exigées sont atteints.
- **L'équité se voit** : la répartition des nuits, des week-ends et des soirs entre soignants de même métier,
  et l'écart entre le plus chargé et le moins chargé.
- **Ce qui ne tient pas se voit** : un manque d'effectif, une règle dépassée, un vœu refusé sont signalés à
  leur place, sans qu'il faille lire le rapport.
- **Où on la lit** : sur un grand écran, sur un téléphone, et imprimée sur une feuille A3 pour le mur de la
  salle de soins ; elle reste lisible dans les trois cas.
- **Le soin du design** : une identité propre à un service hospitalier (couleurs, typographie, lisibilité à
  distance, contrastes suffisants pour tous), pas un tableau brut.

La page se construit à partir du planning calculé et de ses chiffres : sur un autre monde, elle montre
l'autre planning.

## Les documents

Dans le dossier livré, à côté du programme et de la page :

- `planning.csv` : le planning des données fournies, une ligne par soignant et par jour travaillé
  (`soignant,jour,poste`) ;
- `RAPPORT.md` : ce que le planning tient, ses chiffres d'équité et de vœux, les compromis et leur raison,
  les limites connues ;
- `MODE-D-EMPLOI.md` : comment lancer le programme sur un autre dossier de données.

## C'est fini quand

Le programme se lance sur un dossier de données au format décrit et écrit un planning au même format que
`planning.csv`, sans valeur du monde écrite dans le code ; sur les données fournies, `planning.csv` tient
toutes les règles de « Ce que le planning doit tenir », mesuré par un vérificateur indépendant du
programme ; les chiffres d'équité, de vœux et de régularité sont donnés par le programme et vrais ; sur un
monde impossible, le programme dit ce qui ne tient pas, où et de combien, sans rien présenter comme tenu ;
la page s'ouvre en double-clic, sans serveur ni internet, et tient tout ce que dit « La page du planning » :
vue d'ensemble, vue par soignant et par jour, équité et manques visibles, lisible sur grand écran, sur
téléphone et imprimée en A3, avec un design soigné ; `bun test` passe dans le dossier partagé et couvre les règles ; `RAPPORT.md` et
`MODE-D-EMPLOI.md` sont écrits et chacune de leurs affirmations se vérifie.

## Livrable

index.html

## Vérification

bun test
node {DEPOT}/src/voir.ts --partage . index.html --parcours
