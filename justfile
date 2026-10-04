# Essaim : recettes du quotidien. `just` sans argument liste les recettes.

# Toute la suite de tests, avec les chronomètres courts
tests:
    ESSAIM_TEST=1 bun test ./tests/ --parallel

# Sonde : le vrai pi charge une extension node:sqlite sous sandbox, sans dépenser
sonde:
    sh sondes/pi-extension.sh

# La vue : serveur en lecture seule sur http://127.0.0.1:4700
vue port="4700":
    bun src/serveur.ts --port {{port}}

# Lancer un essaim : just lancer 10 deepseek-flash-41 2.00 missions/hotel.md
lancer agents modele plafond mission:
    bun src/lancer.ts --agents {{agents}} --modele {{modele}} --plafond {{plafond}} --mission {{mission}}

# Deux modèles, hommes puis agentes, à parts égales : just lancer-mixte 6 deepseek-flash-41 glm-flash-53 2.00 missions/hotel.md
lancer-mixte agents modele modele-femmes plafond mission:
    bun src/lancer.ts --agents {{agents}} --modele {{modele}} --modele-femmes {{modele-femmes}} --plafond {{plafond}} --mission {{mission}}

# Supprimer les runs de plus de N jours (7 par défaut)
menage jours="7":
    find runs -maxdepth 1 -mindepth 1 -type d -mtime +{{jours}} -exec rm -r {} +
