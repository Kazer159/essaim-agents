#!/bin/sh
# Sonde : l'état de la salle peut-il se construire à l'événement
# `input` du premier message d'une relance, après la commande /se-resumer, et le texte transformé est-il
# celui que pi émet en message_end utilisateur et écrit dans la session ?
# Vrai pi, vrai bac à sable, fournisseur factice déclaré par sondes/extension-input-relance.ts :
# aucun octet ne part vers un fournisseur, 0 $. Si le fournisseur factice ne se charge pas, la sonde
# s'arrête en ÉCHEC (le repli sur un modèle inexistant ne vérifierait pas S2).
set -u
ESSAIM="$(cd "$(dirname "$0")/.." && pwd)"
DOSSIER="/tmp/essaim-sonde/input-relance-$(date +%Y%m%d-%H%M%S)"
BUREAU="$DOSSIER/bureau"
mkdir -p "$BUREAU"
cd "$BUREAU" || exit 1
EXT="$ESSAIM/sondes/extension-input-relance.ts"
OPTIONS="--mode json -p --no-skills --no-extensions --no-context-files --session-dir $DOSSIER/sessions --model sonde/muet"

echo "pi $(command pi --version 2>/dev/null | head -1) · dossier $DOSSIER"

# lancer <nom> <id de session> <relance ou vide> <extensions en plus> -- messages…
lancer() {
  NOM=$1; SESSION=$2; RELANCE=$3; PLUS=$4; shift 5
  # shellcheck disable=SC2086
  env ${RELANCE:+ESSAIM_RELANCE=$RELANCE} SONDE_DB="$DOSSIER/$NOM.sqlite" SONDE_PREUVES="$DOSSIER/$NOM.preuves.json" \
    ESSAIM_COMPACTAGE=80000,120000,160000 \
  sandbox-exec -f "$ESSAIM/src/bac-a-sable.sb" -D PROJET="$DOSSIER" -D HOME="$HOME" \
    command pi $OPTIONS --session-id "$SESSION" $PLUS -e "$EXT" -- "$@" < /dev/null \
    > "$DOSSIER/$NOM.stdout" 2> "$DOSSIER/$NOM.stderr"
  echo "$?" > "$DOSSIER/$NOM.code"
}

unset ESSAIM_RELANCE
lancer s1 sonde resume "" -- "/sonde-lente 3000" "REPRISE"
lancer s4 sonde-continue "" "" -- "continue"
# Assez de contexte pour que le compactage ait quelque chose à résumer (pi garde les 20 000 derniers tokens : deux longs messages, le premier sera résumé).
LONG=$(awk 'BEGIN { for (i = 0; i < 3000; i++) printf "ligne %d du long message de remplissage de la sonde. ", i }')
lancer s5a sonde-resume "" "" -- "$LONG" "$LONG" "dernier message, pour remplir la session"
lancer s5b sonde-resume resume "-e $ESSAIM/src/se-resumer.ts" -- "/se-resumer note" "REPRISE"

# Les critères sont lus par Node (celui qui fait tourner pi) sur les preuves et les sorties.
DOSSIER="$DOSSIER" node --no-warnings - <<'JS'
const fs = require("node:fs"), path = require("node:path");
const D = process.env.DOSSIER;
const lire = (f) => { try { return fs.readFileSync(path.join(D, f), "utf8"); } catch { return ""; } };
const preuves = (nom) => { try { return JSON.parse(lire(`${nom}.preuves.json`)); } catch { return []; } };
const lignes = (nom) => lire(`${nom}.stdout`).split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { brut: l }; } });
const texte = (m) => (m?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("");
const usersFin = (nom) => lignes(nom).filter((e) => e.type === "message_end" && e.message?.role === "user");
const session = (id) => {
  const f = (fs.readdirSync(path.join(D, "sessions"), { withFileTypes: true, recursive: true }))
    .filter((e) => e.isFile() && e.name.endsWith(`_${id}.jsonl`)).map((e) => path.join(e.parentPath ?? e.path, e.name))[0];
  return f ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const dire = (s, ok, vu) => console.log(`SONDE R1 · ${s} : ${ok ? "OK" : "ÉCHEC"} (${vu})`);
const court = (t) => JSON.stringify(t);

// Garde : le fournisseur factice a répondu (sinon le reste ne prouve rien, pas de repli silencieux).
const p1 = preuves("s1"), fournis = p1.filter((p) => p.quoi === "fournisseur");
const reponse = lignes("s1").find((e) => e.type === "message_end" && e.message?.role === "assistant");
const factice = fournis.length > 0 && reponse?.message?.provider === "sonde" && texte(reponse.message) === "ok";
dire("S0 fournisseur factice", factice, factice
  ? `modèle ${reponse.message.provider}/${reponse.message.model}, réponse « ok », coût ${reponse.message.usage?.cost?.total}`
  : `code ${lire("s1.code").trim()}, stderr : ${lire("s1.stderr").split("\n").slice(0, 3).join(" | ")}`);
if (!factice) process.exit(1);

// S1 : un seul input, « REPRISE », après la fin de la commande ; la ligne écrite pendant la commande est lue.
const in1 = p1.filter((p) => p.quoi === "input"), fin = p1.find((p) => p.quoi === "commande_fin");
const deb = p1.find((p) => p.quoi === "commande_debut");
const s1 = in1.length === 1 && in1[0].texte === "REPRISE" && fin && in1[0].n > fin.n && in1[0].quand >= fin.quand
  && in1[0].lignesEnBase?.includes("fait pendant la commande") && in1[0].relance === "resume";
dire("S1", s1, `${in1.length} input ; texte ${court(in1[0]?.texte)} ; commande ${deb?.quand} → ${fin?.quand} ; input ${in1[0]?.quand} ; `
  + `lignes lues ${court(in1[0]?.lignesEnBase)} ; ESSAIM_RELANCE=${in1[0]?.relance}`);

// S2 : message_end utilisateur = texte transformé, même message dans la session, même texte reçu par le modèle.
const attendu = "REPRISE\n\n[salle] sonde 1";
const u1 = usersFin("s1"), sess1 = session("sonde").filter((e) => e.type === "message" && e.message?.role === "user");
const s2 = u1.length === 1 && texte(u1[0].message) === attendu && sess1.length === 1 && texte(sess1[0].message) === attendu
  && fournis.at(-1)?.dernierUtilisateur === attendu;
dire("S2", s2, `message_end user ${court(texte(u1[0]?.message))} (${u1.length}) ; session ${court(texte(sess1[0]?.message))} (${sess1.length}) ; `
  + `reçu par le modèle ${court(fournis.at(-1)?.dernierUtilisateur)}`);

// S3 : la première ligne de la sortie est l'en-tête de session, émise avant tout input.
const l1 = lignes("s1")[0];
const s3 = l1?.type === "session" && in1[0] && l1.timestamp < in1[0].quand && lignes("s1").findIndex((e) => e.type === "message_start") > 0;
dire("S3", s3, `1re ligne type=${l1?.type} à ${l1?.timestamp} ; premier input à ${in1[0]?.quand}`);

// S4 : un seul message « continue » : un seul input, texte « continue », ESSAIM_RELANCE absente.
const in4 = preuves("s4").filter((p) => p.quoi === "input"), u4 = usersFin("s4");
const s4 = in4.length === 1 && in4[0].texte === "continue" && in4[0].relance === null && u4.length === 1
  && texte(u4[0].message) === "continue\n\n[salle] sonde 1";
dire("S4", s4, `${in4.length} input ; texte ${court(in4[0]?.texte)} ; ESSAIM_RELANCE ${in4[0]?.relance === null ? "absente" : in4[0]?.relance} ; `
  + `message_end user ${court(texte(u4[0]?.message))}`);

// S5 (informatif) : vraie extension se-resumer, session remplie d'abord ; un seul input, après la fin du compactage.
const p5 = preuves("s5b"), in5 = p5.filter((p) => p.quoi === "input");
const compact = p5.find((p) => p.quoi === "compactage_fin" || p.quoi === "compactage_echec");
const avant5 = preuves("s5a").filter((p) => p.quoi === "input").length;
const f5 = p5.filter((p) => p.quoi === "fournisseur");
const s5 = avant5 === 3 && in5.length === 1 && in5[0].texte === "REPRISE" && compact && in5[0].n > compact.n
  && f5.at(-1)?.dernierUtilisateur === attendu;
const erreurs5 = lignes("s5b").filter((e) => e.type === "compaction_end" || /compact/i.test(e.type ?? "")).map((e) => e.type);
dire("S5 (informatif)", s5, `remplissage : ${avant5} input ; relance : ${in5.length} input ${court(in5[0]?.texte)} à ${in5[0]?.quand} ; `
  + `${compact ? `${compact.quoi} à ${compact.quand}${compact.erreur ? ` (${compact.erreur})` : ""}` : "aucun événement de compactage vu"} ; `
  + `événements pi : ${court(erreurs5)} ; message_end user ${court(texte(usersFin("s5b")[0]?.message))} ; `
  + `reçu par le modèle après le résumé ${court(f5.at(-1)?.dernierUtilisateur)}`);

for (const nom of ["s1", "s4", "s5a", "s5b"])
  console.log(`  ${nom} : code ${lire(`${nom}.code`).trim()}, ${usersFin(nom).length} message_end user, `
    + `${preuves(nom).filter((p) => p.quoi === "fournisseur").length} appel(s) au fournisseur factice`);
process.exit(s1 && s2 && s3 && s4 ? 0 : 1);
JS
