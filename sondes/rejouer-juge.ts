// La phase finale d'un run : bun sondes/rejouer-juge.ts <run> <juge.mjs> [arguments du juge].
// Rejoue le juge mécanique sur chaque commit de la première lignée de main du dossier commun (une adoption compte
// comme un commit, les commits d'un essai non), du plus ancien au plus récent. Chaque arbre est extrait par
// `git archive | tar -x` dans un dossier temporaire : rien n'est écrit dans le .git du run, ni worktree ni checkout.
// Trois issues : livrable absent (juge non lancé), score (lignes ok sur ok + KO), juge
// en panne (sortie en erreur ou sans ligne ok/KO). En tête : le score final, le premier commit qui l'atteint et la
// phase finale (run.fin moins la date de ce commit). Seuls les juges à <partage> sont admis.
// <run> est un dossier de run, ou un identifiant pris dans runs/ du dépôt courant.
// Sortie : 0 rapport écrit, 2 run introuvable, juge refusé ou dépôt illisible.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { analyserMission, lireMission } from "../src/mission.ts";
import { ouvrirBun } from "../src/tableau-bun.ts";

export type Score = { ok: number; total: number };
export type Commit = { hash: string; date: string; auteur: string; sujet: string; issue: "absent" | "score" | "panne"; ok?: number; total?: number; detail?: string };
export type Rapport = {
  run: string; juge: string; livrable?: string; fin?: string; commits: Commit[];
  final?: Score; atteint?: Commit; phaseFinaleS?: number; sansPhase?: string;
};

// Les juges qui prennent <run> lisent aussi le tableau et les essais : un arbre seul ne
// leur suffit pas.
export function refusJuge(juge: string): string | undefined {
  if (/const\s+run\s*=\s*resolve\(process\.argv\[2\]\)/.test(readFileSync(juge, "utf8")))
    return `${basename(juge)} prend <run> et lit aussi le tableau et les essais : le rejeu ne donne qu'un dossier à la place de partage, juge refusé (spec §10.1)`;
}

const ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
function git(partage: string, args: string[]): { code: number; sortie: Buffer } {
  const r = Bun.spawnSync(["git", "-C", partage, ...args], { env: ENV, stderr: "pipe" });
  return { code: r.exitCode ?? 1, sortie: r.stdout };
}
function gitTexte(partage: string, args: string[]): string {
  const r = git(partage, args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} a échoué dans ${partage}`);
  return r.sortie.toString();
}

function lireRun(run: string): { livrable?: string; fin?: string } {
  const t = ouvrirBun(join(run, "tableau.sqlite"), { lectureSeule: true });
  try {
    const r = t.get<{ mission_chemin: string | null; mission_texte: string | null; fin: string | null }>("SELECT mission_chemin, mission_texte, fin FROM run LIMIT 1");
    let livrable: string | undefined;
    try {
      if (r?.mission_texte) livrable = analyserMission(r.mission_chemin ?? "?", r.mission_texte).livrable;
      else if (r?.mission_chemin && existsSync(r.mission_chemin)) livrable = lireMission(r.mission_chemin).livrable;
    } catch { /* mission illisible : pas de livrable nommé */ }
    return { livrable, fin: r?.fin ?? undefined };
  } finally {
    t.fermer();
  }
}

// Le juge sur un arbre extrait ; même appel qu'à la main, le dossier temporaire à la place de partage.
function juger(partage: string, hash: string, juge: string, args: string[]): Pick<Commit, "issue" | "ok" | "total" | "detail"> {
  const dossier = mkdtempSync(join(tmpdir(), "essaim-rejeu-"));
  try {
    const archive = git(partage, ["archive", "--format=tar", hash]);
    if (archive.code !== 0) return { issue: "panne", detail: "git archive a échoué" };
    const tar = Bun.spawnSync(["tar", "-x", "-C", dossier], { stdin: archive.sortie, stderr: "pipe" });
    if (tar.exitCode !== 0) return { issue: "panne", detail: "tar a échoué" };
    const r = Bun.spawnSync(["node", juge, dossier, ...args], { env: process.env, stderr: "pipe", timeout: 600_000 });
    const lignes = r.stdout.toString().split("\n");
    const ok = lignes.filter((l) => /^ok\b/.test(l)).length, total = ok + lignes.filter((l) => /^KO\b/.test(l)).length;
    if (r.exitCode !== 0 || total === 0) {
      const erreur = r.stderr.toString().trim().split("\n").pop() || (r.exitCode !== 0 ? `code ${r.exitCode}` : "aucune ligne ok/KO");
      return { issue: "panne", detail: erreur };
    }
    return { issue: "score", ok, total };
  } finally {
    rmSync(dossier, { recursive: true, force: true });
  }
}

const ratio = (s: Score) => (s.total ? s.ok / s.total : 0);
const scoreDe = (c: Commit): Score | undefined => (c.issue === "score" ? { ok: c.ok!, total: c.total! } : c.issue === "absent" ? { ok: 0, total: 0 } : undefined);

export function rejouer(run: string, juge: string, args: string[] = []): Rapport {
  const refus = refusJuge(juge);
  if (refus) throw new Error(refus);
  const partage = join(run, "partage");
  const { livrable, fin } = lireRun(run);
  const hashes = gitTexte(partage, ["rev-list", "--first-parent", "--reverse", "main"]).split("\n").filter(Boolean);
  const parArbre = new Map<string, Pick<Commit, "issue" | "ok" | "total" | "detail">>(); // même arbre, même verdict
  const commits: Commit[] = hashes.map((hash) => {
    const [date, auteur, sujet] = gitTexte(partage, ["show", "-s", "--format=%cI%x00%an%x00%s", hash]).trim().split("\0") as [string, string, string];
    const present = livrable ? git(partage, ["cat-file", "-e", `${hash}:${livrable}`]).code === 0 : gitTexte(partage, ["ls-tree", hash]).trim() !== "";
    if (!present) return { hash, date, auteur, sujet, issue: "absent" };
    const arbre = gitTexte(partage, ["rev-parse", `${hash}^{tree}`]).trim();
    if (!parArbre.has(arbre)) parArbre.set(arbre, juger(partage, hash, juge, args));
    return { hash, date, auteur, sujet, ...parArbre.get(arbre)! };
  });

  const r: Rapport = { run, juge, livrable, fin, commits };
  const dernier = commits.at(-1);
  r.final = dernier && scoreDe(dernier);
  if (r.final) r.atteint = commits.find((c) => { const s = scoreDe(c); return s !== undefined && ratio(s) >= ratio(r.final!); });
  const pannes = commits.filter((c) => c.issue === "panne").length;
  if (!commits.length) r.sansPhase = "aucun commit sur main";
  else if (pannes) r.sansPhase = `juge en panne sur ${pannes} commit${pannes > 1 ? "s" : ""}`;
  else if (!fin) r.sansPhase = "run sans fin (run.fin vide)";
  else r.phaseFinaleS = Math.round((Date.parse(fin) - Date.parse(r.atteint!.date)) / 1000);
  return r;
}

const heure = (iso: string) => iso.slice(0, 19).replace("T", " ");
const duree = (s: number) => `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}`;
const score = (s: Score) => `${s.ok}/${s.total}${s.total ? ` (${Math.round((100 * s.ok) / s.total)} %)` : ""}`;
function issue(c: Commit): string {
  if (c.issue === "absent") return "livrable absent";
  if (c.issue === "panne") return `juge en panne : ${c.detail}`;
  return score({ ok: c.ok!, total: c.total! });
}

export function formater(r: Rapport): string {
  const l = [`rejouer-juge · ${basename(r.run)} · ${basename(r.juge)} · livrable ${r.livrable ?? "non nommé par la mission"} · ${r.commits.length} commits (première lignée de main)`];
  const final = r.commits.at(-1);
  if (r.final && r.atteint) l.push(`score final : ${score(r.final)}${final?.issue === "absent" ? ", livrable absent" : ""} · atteint par ${r.atteint.hash.slice(0, 7)} à ${heure(r.atteint.date)} (${r.atteint.auteur})`);
  else l.push(`score final : aucun${final ? ` (${issue(final)})` : ""}`);
  l.push(r.phaseFinaleS !== undefined ? `phase finale : ${duree(r.phaseFinaleS)} (fin du run ${r.fin})` : `phase finale : non calculée, ${r.sansPhase}`);
  l.push("");
  for (const c of r.commits) l.push(`${c.hash.slice(0, 7)}  ${heure(c.date)}  ${c.auteur.padEnd(10)}  ${issue(c)}`);
  return l.join("\n");
}

if (import.meta.main) {
  const [argument, juge, ...args] = process.argv.slice(2);
  if (!argument || !juge) {
    console.error("usage : bun sondes/rejouer-juge.ts <run> <juge.mjs> [arguments du juge]");
    process.exit(2);
  }
  const run = [resolve(argument), join(process.cwd(), "runs", argument)].find((d) => existsSync(join(d, "tableau.sqlite")) && existsSync(join(d, "partage", ".git")));
  if (!run) {
    console.error(`aucun run avec tableau.sqlite et partage/.git pour « ${argument} »`);
    process.exit(2);
  }
  try {
    console.log(formater(rejouer(run, resolve(juge), args)));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
}
