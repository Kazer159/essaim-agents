// La mesure des outils d'un run : bun sondes/bilan-outils.ts <run> [run à comparer].
// <run> est un dossier de run, ou un identifiant pris dans runs/ du dépôt courant. Lecture seule de tableau.sqlite,
// par T.bilanOutils, la fonction que le lanceur appelle pour la ligne « outils : … » du bilan : mêmes règles de
// comptage pour un ancien run (anciens noms) et un nouveau. Avec un second run : les chiffres côte à côte, rapportés
// à 100 appels, la médiane et le maximum par agent, et l'écart.
// Sortie : 0 rapport écrit, 2 run introuvable ou illisible.
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { ouvrirBun } from "../src/tableau-bun.ts";
import * as T from "../src/tableau.ts";

export type RunMesure = { id: string; modele: string; mission: string; bilan: T.BilanOutils };

export function mesurer(argument: string, racine = process.cwd()): RunMesure {
  const dossier = [resolve(argument), join(racine, "runs", argument)].find((d) => existsSync(join(d, "tableau.sqlite")));
  if (!dossier) throw new Error(`aucun tableau.sqlite pour « ${argument} » (ni dossier de run, ni identifiant dans ${join(racine, "runs")})`);
  const t = ouvrirBun(join(dossier, "tableau.sqlite"), { lectureSeule: true });
  try {
    const r = t.get<{ id: string; modele: string | null; modele_femmes: string | null; mission_chemin: string | null }>(
      "SELECT id, modele, modele_femmes, mission_chemin FROM run LIMIT 1");
    const modele = [r?.modele, r?.modele_femmes].filter(Boolean).join(" + ") || "?";
    return { id: r?.id ?? basename(dossier), modele, mission: r?.mission_chemin ? basename(r.mission_chemin) : "?", bilan: T.bilanOutils(t) };
  } finally {
    t.fermer();
  }
}

const nombre = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(1).replace(".", ","));
const pour100 = (n: number, appels: number) => (appels ? (n * 100) / appels : 0);
const somme = (r: Record<string, number>) => Object.values(r).reduce((s, n) => s + n, 0);
function mediane(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

type Bilan = T.BilanOutils;
const INDICATEURS: Array<[string, (b: Bilan) => number]> = [
  ["erreurs", (b) => b.erreurs],
  ["refus", (b) => b.refus],
  ["refus répétés", (b) => b.repetes],
  ["appels corrigés (approché)", (b) => b.corriges],
  ["noms inconnus", (b) => somme(b.inconnus)],
  ["bash : bun test", (b) => b.bash.bunTest.simples + b.bash.bunTest.composees],
  ["bash : git log", (b) => b.bash.gitLog.simples + b.bash.gitLog.composees],
  ["bash : sqlite3", (b) => b.bash.sqlite3.simples + b.bash.sqlite3.composees],
];
type ParAgent = Bilan["parAgent"][string];
const PAR_AGENT: Array<[string, keyof ParAgent]> = [
  ["refus", "refus"], ["refus répétés", "repetes"], ["noms inconnus", "inconnus"],
  ["bash : bun test", "bunTest"], ["bash : git log", "gitLog"], ["bash : sqlite3", "sqlite3"],
];

const colonne = (s: string, n: number) => s.padEnd(n);
const pluriel = (n: number, mot: string) => `${n} ${mot}${n > 1 ? "s" : ""}`;
const L = 30, C = 22;

function details(m: RunMesure): string[] {
  const b = m.bilan;
  const inconnus = Object.entries(b.inconnus).map(([n, k]) => `${n} ${k}`).join(", ") || "aucun";
  const { bunTest, gitLog, sqlite3 } = b.bash;
  const outils = Object.entries(b.parOutil).sort((x, y) => y[1].appels - x[1].appels)
    .map(([n, o]) => `  ${colonne(n, 20)} ${pluriel(o.appels, "appel").padStart(12)} · ${pluriel(o.erreurs, "erreur")} · ${o.refus} refus`);
  return [
    `refus par cause : ${(Object.entries(b.parCause) as Array<[string, number]>).map(([c, n]) => `${c} ${n}`).join(" · ")}`,
    `noms inconnus : ${inconnus} · outil_inconnu : ${b.outilInconnu} · arguments tronqués : ${b.tronques}`,
    `bun test : ${pluriel(bunTest.simples, "simple")}, ${pluriel(bunTest.composees, "composée")} · partage ${bunTest.partage}, essai ${bunTest.essai}, filtre ${bunTest.filtre}`,
    `git log : ${pluriel(gitLog.simples, "simple")}, ${pluriel(gitLog.composees, "composée")} · sqlite3 : ${pluriel(sqlite3.simples, "simple")}, ${pluriel(sqlite3.composees, "composée")}`,
    "par outil :", ...outils,
  ];
}

export function rapport(a: RunMesure, b?: RunMesure): string {
  const runs = b ? [a, b] : [a];
  const out: string[] = [`bilan des outils · ${runs.map((r) => r.id).join(" ↔ ")}`];
  runs.forEach((r, i) => out.push(`${b ? `${"AB"[i]} · ` : ""}modèle : ${r.modele} · mission : ${r.mission} · noms : ${r.bilan.noms}`));
  if (b && (a.modele !== b.modele || a.mission !== b.mission))
    out.push("attention : deux runs ne se comparent que sur le même modèle et la même mission");
  out.push("");
  const entete = colonne("", L) + runs.map((_, i) => colonne(b ? `${"AB"[i]} (pour 100 appels)` : "(pour 100 appels)", C)).join("") + (b ? "écart B − A" : "");
  out.push(entete);
  out.push(colonne("appels", L) + runs.map((r) => colonne(String(r.bilan.appels), C)).join(""));
  for (const [nom, f] of INDICATEURS) {
    const v = runs.map((r) => pour100(f(r.bilan), r.bilan.appels));
    out.push(colonne(nom, L) + runs.map((r, i) => colonne(`${nombre(v[i]!)} (${f(r.bilan)})`, C)).join("") + (b ? `${v[1]! - v[0]! >= 0 ? "+" : ""}${nombre(v[1]! - v[0]!)}` : ""));
  }
  out.push("", colonne("par agent : médiane · max", L) + runs.map((r) => colonne(`${Object.keys(r.bilan.parAgent).length} agents`, C)).join(""));
  for (const [nom, cle] of PAR_AGENT) {
    out.push(colonne(nom, L) + runs.map((r) => {
      const xs = Object.values(r.bilan.parAgent).map((x) => x[cle]);
      return colonne(`${nombre(mediane(xs))} · ${xs.length ? Math.max(...xs) : 0}`, C);
    }).join(""));
  }
  runs.forEach((r, i) => out.push("", `${b ? `${"AB"[i]} · ` : ""}${r.id}`, ...details(r)));
  return out.map((l) => l.trimEnd()).join("\n");
}

if (import.meta.main) {
  const [x, y] = process.argv.slice(2);
  if (!x) {
    console.error("usage : bun sondes/bilan-outils.ts <run> [run à comparer]");
    process.exit(2);
  }
  try {
    console.log(rapport(mesurer(x), y ? mesurer(y) : undefined));
  } catch (e) {
    console.error(`bilan-outils : ${(e as Error).message}`);
    process.exit(2);
  }
}
