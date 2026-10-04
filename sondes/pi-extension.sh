#!/bin/sh
# Sonde : le vrai pi charge-t-il une extension qui écrit avec node:sqlite,
# sous sandbox-exec, depuis un répertoire de travail étranger au dépôt ?
# Coût : 0 $. Le modèle demandé n'existe pas, la requête échoue, c'est voulu :
# l'écriture a lieu au chargement de l'extension, avant tout appel de modèle.
#
# Deux variantes : pi sous Node (la voie retenue) et pi sous Bun (informatif).
set -u
ESSAIM="$(cd "$(dirname "$0")/.." && pwd)"
DOSSIER="/tmp/essaim-sonde/$(date +%Y%m%d-%H%M%S)"
BUREAU="$DOSSIER/bureau"
mkdir -p "$BUREAU"
cd "$BUREAU" || exit 1

PI_CLI="/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"
OPTIONS="--mode json -p --no-skills --no-extensions --no-context-files --no-session --model openrouter/inexistant/aucun"

echo "pi $(command pi --version 2>/dev/null | head -1) · dossier $DOSSIER"

# --- Variante Node (la voie retenue) -------------------------------------
SONDE_DB="$DOSSIER/sonde-node.sqlite"
export SONDE_DB
# shellcheck disable=SC2086
sandbox-exec -f "$ESSAIM/src/bac-a-sable.sb" -D PROJET="$DOSSIER" -D HOME="$HOME" \
  command pi $OPTIONS -e "$ESSAIM/sondes/extension-minimale.ts" -- "bonjour" < /dev/null \
  > "$DOSSIER/node.stdout" 2> "$DOSSIER/node.stderr"
COMPTE=$(sqlite3 "$SONDE_DB" "SELECT count(*) FROM sonde" 2>/dev/null || echo 0)
if [ "$COMPTE" = "1" ]; then
  echo "SONDE NODE : ligne écrite"
else
  echo "SONDE NODE : ÉCHEC"
  sed 's/^/  stderr | /' "$DOSSIER/node.stderr"
fi

# --- Variante Bun (informative : la voie retenue reste Node) --------------
SONDE_DB="$DOSSIER/sonde-bun.sqlite"
export SONDE_DB
# shellcheck disable=SC2086
sandbox-exec -f "$ESSAIM/src/bac-a-sable.sb" -D PROJET="$DOSSIER" -D HOME="$HOME" \
  bun "$PI_CLI" $OPTIONS -e "$ESSAIM/sondes/extension-minimale.ts" -- "bonjour" < /dev/null \
  > "$DOSSIER/bun.stdout" 2> "$DOSSIER/bun.stderr"
COMPTE=$(sqlite3 "$SONDE_DB" "SELECT count(*) FROM sonde" 2>/dev/null || echo 0)
if [ "$COMPTE" = "1" ]; then
  echo "SONDE BUN : ligne écrite"
else
  ERREUR=$(grep -m1 -E "^[A-Za-z]*Error" "$DOSSIER/bun.stderr" 2>/dev/null | cut -c1-120)
  echo "SONDE BUN : ÉCHEC (${ERREUR:-aucune ligne lisible})"
fi
