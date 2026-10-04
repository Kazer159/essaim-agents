# Une page de bienvenue

Une page web minuscule : un titre « Bonjour », une phrase d'accueil sous le titre, et un bouton « Compter » qui
affiche à côté de lui le nombre de clics depuis l'ouverture de la page. Un seul fichier, ouvrable en double-clic,
sans dépendance externe.

Le juge ouvrira la page, lira le titre et la phrase, et cliquera trois fois sur le bouton : il attend « 3 ».

## Type

application

## C'est fini quand

`index.html` existe dans le dossier partagé, s'ouvre sans erreur ni exception, montre le titre « Bonjour » et la
phrase d'accueil, et trois clics sur « Compter » affichent 3.

## Livrable

index.html

## Vérification

grep -q "Bonjour" index.html
