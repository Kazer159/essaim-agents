#!/bin/sh
# Sonde : le chrome-headless-shell du cache Playwright démarre-t-il sous
# le bac à sable de l'essaim (src/bac-a-sable.sb, mêmes -D que le lanceur) ?
# Coût : 0 $, aucun réseau, aucun modèle. Quatre variantes, 20 s chacune :
#   V1 binaire nu --dump-dom            V2 idem + --no-sandbox
#   V3 par playwright-core (Node)       V4 idem + --no-sandbox
# Les refus du bac à sable sont lus dans le journal système (sender Sandbox).
# Preuve attendue : « salle équipée » rendu en moins de 5 s par V1 ou V3.
# --no-sandbox (V2, V4) ne se retient que si V1 et V3 échouent ET que le journal
# montre un refus lié au bac à sable interne de Chromium.
#
# Constat : V1 meurt (« GPU process isn't usable », forbidden-sandbox-reinit
# sur chaque processus fils) ; V2, V3, V4 rendent le texte, V3 parce que
# playwright-core ajoute --no-sandbox lui-même. D'où --no-sandbox, sans
# permission ajoutée.
set -u
ESSAIM="$(cd "$(dirname "$0")/.." && pwd)"
D="$ESSAIM/runs/.sonde-chromium-$(date +%Y%m%d-%H%M%S)"   # sous runs/ : écriture permise par PROJET seulement, comme un vrai run
mkdir -p "$D/partage" "$D/profil"
printf '<!doctype html><title>Sonde</title><h1>salle équipée</h1>\n' > "$D/partage/sonde.html"
REV=$(node -p "require('$ESSAIM/node_modules/playwright-core/browsers.json').browsers.find(b => b.name === 'chromium-headless-shell').revision")
BIN="$HOME/Library/Caches/ms-playwright/chromium_headless_shell-$REV/chrome-headless-shell-mac-arm64/chrome-headless-shell"
[ -x "$BIN" ] || { echo "navigateur absent : $BIN"; exit 2; }
echo "dossier $D · révision $REV"

cat > "$D/pw.cjs" <<EOF
const { chromium } = require("$ESSAIM/node_modules/playwright-core");
(async () => {
  const args = process.env.NO_SANDBOX === "1" ? ["--no-sandbox"] : [];
  const b = await chromium.launch({ headless: true, executablePath: "$BIN", args, timeout: 15000 });
  const p = await b.newPage();
  await p.goto("file://$D/partage/sonde.html");
  console.log(await p.innerText("h1"));
  await b.close();
})().catch((e) => { console.error(String(e.message ?? e).split("\n").slice(0, 5).join("\n")); process.exit(1); });
EOF

log stream --predicate 'sender == "Sandbox"' --style compact > "$D/journal.txt" 2>&1 &
JOURNAL=$!
sleep 2

BAC="sandbox-exec -f $ESSAIM/src/bac-a-sable.sb -D PROJET=$D -D HOME=$HOME"
essai() { # nom, commande…
  nom=$1; shift
  debut=$(date +%s)
  avant=$(wc -l < "$D/journal.txt"); sleep 1
  perl -e 'alarm 20; exec @ARGV' -- $BAC "$@" > "$D/$nom.out" 2> "$D/$nom.err"
  code=$?
  echo "== $nom : code $code, $(( $(date +%s) - debut )) s, sortie : $(grep -c 'salle équipée' "$D/$nom.out") ligne(s) « salle équipée »"
  head -20 "$D/$nom.err" | sed 's/^/   stderr | /'
  sleep 1
  tail -n +$((avant + 1)) "$D/journal.txt" | grep -i 'deny' | sed -E 's/.*Sandbox: //' | sort | uniq -c | sort -rn | head -12 | sed 's/^/   refus  | /'
}

essai V1-binaire        "$BIN" --headless --user-data-dir="$D/profil" --dump-dom "file://$D/partage/sonde.html"
essai V2-binaire-nosbx  "$BIN" --headless --no-sandbox --user-data-dir="$D/profil2" --dump-dom "file://$D/partage/sonde.html"
essai V3-playwright     node "$D/pw.cjs"
NO_SANDBOX=1 essai V4-playwright-nosbx node "$D/pw.cjs"

kill $JOURNAL 2>/dev/null
echo "journal complet : $D/journal.txt (refus comptés par variante ci-dessus ; sorties dans les *.out et *.err)"
