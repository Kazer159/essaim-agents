#!/bin/sh
# Sonde : sous le bac à sable de l'essaim (src/bac-a-sable.sb, mêmes -D et même environnement git que
# le lanceur), un agent peut-il écrire dans le .git du run, lire des identifiants, ou pousser ?
# Coût : 0 $, aucun modèle, aucune requête vers GitHub.
# Chaque ligne dit OK quand le bac à sable fait ce qu'on attend de lui, ÉCHEC sinon.
# Un push vers un dépôt local ne sort pas de la machine : ce qui compte, c'est qu'un agent ne puisse ni ajouter
# de remote ni s'identifier auprès de GitHub.
# Le refus du trousseau (mach-lookup) empêche `gh auth token` et `git credential-osxkeychain`
# de rendre des identifiants sous le bac à sable.
set -u
ESSAIM="$(cd "$(dirname "$0")/.." && pwd)"
D="$ESSAIM/runs/.sonde-push-$(date +%Y%m%d-%H%M%S)"   # sous runs/ : comme un vrai run
mkdir -p "$D/partage" "$D/essais/x"
git -C "$D/partage" init -q -b main && git -C "$D/partage" -c user.name=essaim -c user.email=e@l commit -q --allow-empty -m ouverture
printf 'gitdir: ailleurs\n' > "$D/essais/x/.git"
ENV="GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0 GIT_ASKPASS=/usr/bin/false GH_TOKEN= GITHUB_TOKEN= GH_CONFIG_DIR=$D/gh GH_PROMPT_DISABLED=1"
boite() { env -u SSH_AUTH_SOCK $ENV sandbox-exec -f "$ESSAIM/src/bac-a-sable.sb" -D "PROJET=$D" -D "HOME=$HOME" sh -c "$1" >/dev/null 2>&1; }
attendu_refus() { if boite "$2"; then echo "ÉCHEC  $1"; ECHECS=$((ECHECS+1)); else echo "OK     $1 (refusé)"; fi; }
attendu_permis() { if boite "$2"; then echo "OK     $1 (permis)"; else echo "ÉCHEC  $1"; ECHECS=$((ECHECS+1)); fi; }
ECHECS=0
attendu_permis "écrire dans partage/"                    "echo a > '$D/partage/a.js'"
attendu_permis "lire le dépôt (git log)"                 "cd '$D/partage' && git log --oneline"
attendu_refus  "écrire .git/config (core.fsmonitor)"     "git -C '$D/partage' config core.fsmonitor 'touch /tmp/x'"
attendu_refus  "écrire un hook"                          "echo x > '$D/partage/.git/hooks/pre-commit'"
attendu_refus  "supprimer le hook pre-push"              "rm '$D/partage/.git/hooks/pre-push' 2>/dev/null || rm '$D/partage/.git/HEAD'"
attendu_refus  "déplacer partage/.git"                   "mv '$D/partage/.git' '$D/partage/git-vole'"
attendu_refus  "réécrire le .git d'un essai"             "echo 'gitdir: /tmp' > '$D/essais/x/.git'"
attendu_refus  "commiter à la main"                      "cd '$D/partage' && git add a.js && git -c user.name=a -c user.email=a@a commit -m x"
attendu_refus  "ajouter un remote"                       "git -C '$D/partage' remote add dehors https://github.com/x/y.git"
attendu_refus  "lire ~/.ssh"                             "ls '$HOME/.ssh'"
attendu_refus  "lire ~/.config/gh"                       "ls '$HOME/.config/gh'"
attendu_refus  "jeton gh (gh auth token)"                "gh auth token 2>/dev/null | grep -q '^gh'"
attendu_refus  "trousseau : security find-internet-password" "security find-internet-password -s github.com"
attendu_refus  "trousseau : git credential-osxkeychain"  "printf 'protocol=https\nhost=github.com\n\n' | git -c credential.helper=osxkeychain credential fill | grep -q password="
attendu_permis "HTTPS sortant (pi joint son fournisseur)" "curl -sS -o /dev/null --max-time 10 https://openrouter.ai"
echo "renommer partage/ reste possible (parade : le lanceur vérifie l'inode du .git) :"
boite "mv '$D/partage' '$D/partage-2'" && echo "       permis, comme prévu" || echo "       refusé"
rm -rf "$D"
echo "$ECHECS échec(s)"
exit "$ECHECS"
