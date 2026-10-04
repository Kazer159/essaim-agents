// Le dépôt git du run : partage/ est un dépôt, et le lanceur en est le seul écrivain. Il y commite
// chaque écriture au nom de l'agent qui l'a faite, et il y exécute les demandes des agents (restaurer un fichier,
// ouvrir un essai, l'adopter). Les agents, eux, n'ont que la lecture : le bac à sable leur ferme les .git.
// Un agent qui pourrait écrire dans .git/config ferait exécuter ce qu'il veut (core.fsmonitor, un filtre) au git
// du lanceur, qui tourne hors du bac à sable.
//
// Tout est asynchrone (execFile) avec un délai maximal par commande : le lanceur ne gèle jamais pendant un git,
// le plafond, la pause et la surveillance du silence continuent de tourner. La configuration de la machine est
// ignorée (ni globale ni système) : ni signature, ni hook, ni filtre ne viennent d'ailleurs.
import { execFile } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { nomPlanche } from "./voir.ts";
import { cleChemin, listeFichiers, noterAdoption, poster, noterEssai, noterFait, normaliserChemin, raisonDeclaree, prendreDemandes, repondreDemande, type DemandeGit, type FichierCommit, type NouveauFait, type Tableau } from "./tableau.ts";

export const BRANCHE = "main";
const ESSAIM = "essaim <essaim@local>";
const ENV_GIT = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };
// --literal-pathspecs : un fichier nommé « *.js » ne désigne que lui. fsmonitor et hooks coupés même si la
// configuration du dépôt disait autre chose ; les sous-dépôts jamais visités par diff et status.
const OPTIONS = ["--literal-pathspecs", "-c", "user.name=essaim", "-c", "user.email=essaim@local", "-c", "commit.gpgsign=false",
  "-c", "core.quotepath=false", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "diff.ignoreSubmodules=all"];
// Un verrou de git : un chemin absolu sous un .git (« Unable to create '/…/.git/index.lock' »). Pas un nom de fichier du
// dossier cité par une autre erreur (« pathspec 'bun.lock' did not match ») : celui-là serait effacé relativement
// au dossier courant du lanceur, la racine d'essaim.
const VERROU = /'(\/[^']*\/\.git\/[^']+\.lock)'/;
const DELAI_MS = 30_000;

export const signature = (agent: string) => (agent === "essaim" ? ESSAIM : `${agent} <${agent.toLowerCase()}@essaim.local>`);
const attendre = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Sortie = { code: number; sortie: string; octets: Buffer; erreur: string };

// seulEcrivain : le lanceur seul. Un verrou trouvé en travers d'une opération est forcément abandonné (un git
// coupé par le délai) : il est retiré au lieu d'être attendu.
export async function git(dossier: string, args: string[], o: { env?: Record<string, string>; seulEcrivain?: boolean } = {}): Promise<Sortie> {
  for (let essai = 0; ; essai++) {
    const s = await lancerGit(dossier, [...OPTIONS, ...args], { ...process.env, ...ENV_GIT, ...o.env });
    const verrou = s.code !== 0 ? s.erreur.match(VERROU)?.[1] : undefined;
    if (!verrou || essai >= 20) return s;
    if (o.seulEcrivain) rmSync(verrou, { force: true });
    else await attendre(100);
  }
}

// Sous Bun (lanceur, tests, vue), Bun.spawn, comme partout ailleurs dans le projet ; sous Node (l'extension dans
// pi), execFile. Bun 1.3.11 refermait une seconde fois des descripteurs après des execFile : quand SQLite avait
// repris le numéro, macOS tuait le processus net (EXC_GUARD). Corrigé par Bun 1.4.2.
async function lancerGit(dossier: string, args: string[], env: Record<string, string | undefined>): Promise<Sortie> {
  if (typeof Bun !== "undefined") {
    const p = Bun.spawn(["git", ...args], { cwd: dossier, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const coupure = setTimeout(() => p.kill("SIGTERM"), DELAI_MS);
    const [octets, erreur, code] = await Promise.all([new Response(p.stdout).arrayBuffer().then((b) => Buffer.from(b)), new Response(p.stderr).text(), p.exited]);
    clearTimeout(coupure);
    const coupe = p.signalCode !== null;
    return { code: coupe ? 124 : code, sortie: octets.toString(), octets, erreur: erreur + (coupe ? `\ngit coupé après ${DELAI_MS / 1000} s` : "") };
  }
  return new Promise<Sortie>((fin) => {
    execFile("git", args, { cwd: dossier, encoding: "buffer", env, maxBuffer: 64 * 1024 * 1024, timeout: DELAI_MS }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 124) : 0;
      fin({ code, sortie: stdout.toString(), octets: stdout, erreur: stderr.toString() + (err && (err as { killed?: boolean }).killed ? `\ngit coupé après ${DELAI_MS / 1000} s` : "") });
    });
  });
}

async function exiger(dossier: string, args: string[], o?: Parameters<typeof git>[2]): Promise<string> {
  const r = await git(dossier, args, o);
  if (r.code !== 0) throw new Error(`git ${args[0]} : ${r.erreur.trim() || r.sortie.trim()}`);
  return r.sortie;
}

// La file du lanceur : une opération git à la fois, dans l'ordre d'arrivée. Une opération en échec ne bloque pas
// les suivantes ; son erreur revient à celui qui l'a mise en file.
export class FileGit {
  private fin: Promise<unknown> = Promise.resolve();
  mettre<T>(op: () => Promise<T>): Promise<T> {
    const p = this.fin.then(op);
    this.fin = p.catch(() => undefined);
    return p;
  }
  vider(): Promise<void> {
    return this.fin.then(() => undefined);
  }
}

// Idempotent. Aucun remote, un hook pre-push qui refuse (les agents ne peuvent pas le retirer : .git leur est
// fermé), et rien de ce qui ne doit pas finir dans l'historique.
export async function ouvrirDepot(partage: string): Promise<void> {
  mkdirSync(partage, { recursive: true });
  if (existsSync(join(partage, ".git"))) return;
  await exiger(partage, ["init", "-q", "-b", BRANCHE]);
  mkdirSync(join(partage, ".git", "hooks"), { recursive: true });
  mkdirSync(join(partage, ".git", "info"), { recursive: true });
  const hook = join(partage, ".git", "hooks", "pre-push");
  writeFileSync(hook, "#!/bin/sh\necho \"refusé : le dépôt du run ne se pousse jamais\" >&2\nexit 1\n");
  chmodSync(hook, 0o755);
  writeFileSync(join(partage, ".git", "info", "exclude"), "node_modules/\n.DS_Store\n*.sqlite\n*.sqlite-*\n");
  await exiger(partage, ["commit", "-q", "--allow-empty", "-m", "ouverture du run", `--author=${ESSAIM}`]);
}

// Ce qui a changé dans le dossier (suivi ou non), chemins relatifs. -z : les noms tels quels, sans guillemets.
async function changes(dossier: string): Promise<string[]> {
  const brut = (await exiger(dossier, ["status", "--porcelain", "-z", "--untracked-files=all"])).split("\0");
  const fichiers: string[] = [];
  for (let i = 0; i < brut.length; i++) {
    const e = brut[i]!;
    if (e.length < 4) continue;
    fichiers.push(e.slice(3));
    if (e[0] === "R" || e[0] === "C") i++; // l'ancien nom suit
  }
  return fichiers;
}

// Ce qui a changé, pour le lanceur, avant le commit d'un bash dans un run à rôles.
export const fichiersChanges = (dossier: string) => changes(dossier);

// Remettre des fichiers à leur dernier état commité (HEAD), sans commit ni rien toucher d'autre : un
// fichier suivi reprend son contenu (même supprimé), un fichier que HEAD ne connaît pas est retiré. Rend le hash court de
// HEAD. Le lanceur seul l'appelle, dans sa file, sur des chemins relatifs que git vient de lister.
export async function remettre(dossier: string, chemins: string[]): Promise<string> {
  const head = (await exiger(dossier, ["rev-parse", "--short", "HEAD"])).trim();
  for (const c of chemins) {
    if ((await git(dossier, ["ls-tree", "HEAD", "--", c])).sortie.trim()) await exiger(dossier, ["checkout", "-q", "HEAD", "--", c], { seulEcrivain: true });
    else rmSync(join(dossier, c), { force: true });
  }
  return head;
}

// Le fait d'une écriture par bash annulée : type restauration, au nom de l'agent dont le bash a écrit (l'agent
// concerné), sans commit. details.annule porte chaque fichier, son porteur et son ticket ; pas de details.fichiers : ce
// n'est pas une écriture, rien ne doit l'attribuer à personne (ecritDepuis, toucheVerifie).
export type Annule = { chemin: string; porteur: string; ticket?: number };
export const aQui = (a: Annule) => `${a.porteur}${a.ticket !== undefined ? ` (ticket #${a.ticket})` : ""}`;
export function faitAnnulation(agent: string, depuis: string, annules: Annule[]): NouveauFait {
  const liste = annules.map((a) => a.chemin).join(", ");
  const aQuiTexte = annules.length === 1 ? `à ${aQui(annules[0]!)}` : annules.map((a) => `${a.chemin} à ${aQui(a)}`).join(", ");
  return {
    type: "restauration", agent, source: "lanceur", sujet: liste,
    texte: `annulé · ${liste} · écrit par bash par ${agent} · ${aQuiTexte} · remis au commit ${depuis}`,
    details: { racine: "partage", depuis, annule: { outil: "bash", fichiers: annules } },
  };
}

// Ce qu'un commit a réellement changé (second cerveau) : chaque fichier et son blob, nul pour un fichier
// supprimé. --no-renames : un renommage est une suppression et un ajout. diff-tree ne rend rien pour un commit de
// fusion : premierParent le lit contre son premier parent (deux arbres explicites). --root : le commit d'ouverture.
export async function fichiersDuCommit(dossier: string, hash: string, o: { premierParent?: boolean } = {}): Promise<FichierCommit[]> {
  const arbres = o.premierParent ? [`${hash}^1`, hash] : ["--root", hash];
  const brut = (await exiger(dossier, ["diff-tree", "-r", "-z", "--no-commit-id", "--no-renames", ...arbres])).split("\0");
  const fichiers: FichierCommit[] = [];
  for (let i = 0; i + 1 < brut.length; i += 2) {
    const blob = brut[i]!.split(" ")[3]!; // :<mode> <mode> <avant> <après> <état>
    fichiers.push({ chemin: brut[i + 1]!, blob: /^0+$/.test(blob) ? null : blob });
  }
  return fichiers;
}

export type CommitFait = { hash: string; message: string; fichiers: FichierCommit[] };

// Le fait ecriture d'un commit (second cerveau), le même pour le lanceur (fins d'outils, fin du run) et pour le
// commit « avant adoption » : ce que la salle a constaté, sans l'heure. racine : "partage" ou "essai:<nom>" ; outil :
// l'outil dont la fin a déclenché le commit (bash : son auteur est attribué au mieux, un bash commite tout ce qui a
// changé). Au-delà de cinq fichiers, le texte les compte ; details les garde tous, avec leurs blobs.
export const racineDuFait = (racine: string, partage: string) => (racine === partage ? "partage" : `essai:${basename(racine)}`);
export function faitEcriture(c: CommitFait, agent: string, racine: string, outil: string): NouveauFait {
  const liste = listeFichiers(c.fichiers);
  const essai = racine.startsWith("essai:") ? ` · essai ${racine.slice(6)}` : "";
  return {
    type: "ecriture", agent, source: "lanceur", sujet: liste,
    texte: `écrit · ${liste} · ${agent} · commit ${c.hash}${essai}${outil === "bash" ? " · par bash, attribué au mieux" : ""}`,
    details: { hash: c.hash, message: c.message, fichiers: c.fichiers, racine, outil },
  };
}

// Commite, au nom de l'agent, les chemins donnés ou, sans chemins, tout ce qui a changé sauf `sauf` (les fichiers
// qu'un autre agent est en train d'écrire). Seuls ces fichiers partent, même si d'autres sont en attente.
// Rend le hash court et les fichiers que le commit a réellement changés (pas les candidats), ou undefined s'il n'y
// avait rien à commiter.
export async function commiter(dossier: string, agent: string, message: string, o: { chemins?: string[]; sauf?: string[]; seulEcrivain?: boolean } = {}): Promise<CommitFait | undefined> {
  const sauf = new Set(o.sauf ?? []);
  // Un dépôt imbriqué (partage/app/.git) n'est jamais commité : le bac à sable n'en ferme pas le .git, et une fois
  // suivi, le git du lanceur, hors bac à sable, y exécute le filtre que l'agent a posé dans sa configuration.
  const fichiers = (o.chemins ?? await changes(dossier)).filter((f) => !sauf.has(f) && !existsSync(join(dossier, f, ".git")));
  if (fichiers.length === 0) return undefined;
  const g = { seulEcrivain: o.seulEcrivain };
  // La liste passe par un fichier, pas en arguments : un .venv de vingt mille fichiers dépasse ARG_MAX (E2BIG),
  // et plus aucun commit de bash ne passerait.
  const temp = mkdtempSync(join(tmpdir(), "essaim-chemins-"));
  const liste = join(temp, "chemins");
  writeFileSync(liste, fichiers.join("\0"));
  const depuisListe = [`--pathspec-from-file=${liste}`, "--pathspec-file-nul"];
  try {
    const add = await git(dossier, ["add", "-A", ...depuisListe], g);
    if (add.code !== 0 && !/did not match any files/.test(add.erreur)) throw new Error(`git add : ${add.erreur.trim()}`);
    const indexe = new Set((await exiger(dossier, ["diff", "--cached", "--name-only", "--no-renames", "-z"])).split("\0"));
    if (!fichiers.some((f) => indexe.has(f))) return undefined;
    const r = await git(dossier, ["commit", "-q", "--no-verify", `--author=${signature(agent)}`, "-m", message, ...depuisListe], g);
    if (r.code !== 0) {
      if (/nothing to commit|no changes added|did not match any file/i.test(r.sortie + r.erreur)) return undefined;
      throw new Error(`git commit : ${r.erreur.trim() || r.sortie.trim()}`);
    }
  } finally { rmSync(temp, { recursive: true, force: true }); }
  const hash = (await exiger(dossier, ["rev-parse", "--short", "HEAD"])).trim();
  return { hash, message, fichiers: await fichiersDuCommit(dossier, hash) };
}

// Seuls les essais qu'un bash a pu toucher : ceux de son auteur et ceux que sa commande nomme.
// Les parcourir tous après chaque bash ralentissait la file git du lanceur.
export function essaisDuBash(essais: string[], siens: Iterable<string>, commande: string): string[] {
  const a = new Set([...siens].map((x) => resolve(x)));
  return essais.filter((r) => a.has(resolve(r)) || commande.includes(basename(r)));
}

// Un commit peut remettre des lignes dans leur état d'avant les commits d'un autre agent sans que rien ne le
// signale. Pour chaque fichier texte du commit, les derniers commits d'un
// autre auteur sur ce fichier : un commit est défait quand le nouveau retire des lignes qu'il avait ajoutées ET remet des
// lignes qu'il avait retirées (une simple réécriture ne remet rien). Les commits du lanceur (essaim) ne comptent pas.
export type Defait = { chemin: string; commit: string; auteur: string; lignes: number };
const lignesDuDiff = (diff: string) => {
  const ajoutees = new Set<string>(), retirees = new Set<string>();
  for (const l of diff.split("\n")) {
    if (l.startsWith("+++") || l.startsWith("---")) continue;
    if (l.startsWith("+")) ajoutees.add(l.slice(1));
    else if (l.startsWith("-")) retirees.add(l.slice(1));
  }
  return { ajoutees, retirees };
};
export async function defaits(dossier: string, c: CommitFait, auteur: string, o: { profondeur?: number } = {}): Promise<Defait[]> {
  const resultat: Defait[] = [];
  // Un seul appel pour trier : seuls les fichiers où le commit ajoute ET retire des lignes peuvent défaire (30 au plus).
  const stat = await git(dossier, ["diff", "--numstat", "-z", "--no-renames", `${c.hash}^`, c.hash]);
  if (stat.code !== 0) return resultat;
  const candidats = stat.sortie.split("\0").filter(Boolean).map((l) => l.split("\t")).filter(([plus, moins]) => Number(plus) > 0 && Number(moins) > 0).map((x) => x[2]!).slice(0, 30);
  for (const chemin of candidats) {
    const d = await git(dossier, ["diff", "-U0", "--no-color", "--no-ext-diff", `${c.hash}^`, c.hash, "--", chemin]);
    if (d.code !== 0) continue;
    const nouveau = lignesDuDiff(d.sortie);
    if (!nouveau.retirees.size || !nouveau.ajoutees.size) continue;
    const log = await git(dossier, ["log", `-n${o.profondeur ?? 10}`, "--no-merges", "--format=%h%x1f%an", `${c.hash}^`, "--", chemin]);
    if (log.code !== 0) continue;
    for (const ligne of log.sortie.split("\n").filter(Boolean)) {
      const [k, a] = ligne.split("\x1f") as [string, string];
      if (a === auteur || a === "essaim") continue;
      const dk = await git(dossier, ["diff", "-U0", "--no-color", "--no-ext-diff", `${k}^`, k, "--", chemin]);
      if (dk.code !== 0) continue;
      const ancien = lignesDuDiff(dk.sortie);
      const retires = [...ancien.ajoutees].filter((l) => nouveau.retirees.has(l)).length;
      const remis = [...ancien.retirees].some((l) => nouveau.ajoutees.has(l));
      if (retires && remis) resultat.push({ chemin, commit: k, auteur: a, lignes: retires });
    }
  }
  return resultat;
}

export type Commit = { hash: string; auteur: string; date: string; message: string; fichiers: string[] };

// Les commits, du plus récent au plus ancien (pour la vue et les tests ; les agents lisent avec git dans bash).
export async function historique(dossier: string, o: { chemin?: string; limite?: number; branche?: string } = {}): Promise<Commit[]> {
  const r = await git(dossier, ["log", `-n${o.limite ?? 30}`, "--name-only", "--format=%x1e%h%x1f%an%x1f%aI%x1f%s", o.branche ?? "HEAD", "--", ...(o.chemin ? [o.chemin] : [])]);
  if (r.code !== 0) return [];
  return r.sortie.split("\x1e").filter((b) => b.trim()).map((bloc) => {
    const [tete, ...fichiers] = bloc.split("\n");
    const [hash, auteur, date, message] = tete!.split("\x1f");
    return { hash: hash!, auteur: auteur!, date: date!, message: message!, fichiers: fichiers.filter(Boolean) };
  });
}

// Le journal de l'outil depot_journal : comme historique, mais une panne git se distingue d'une liste vide
// (historique la masque). Lecture seule, sans verrou (ENV_GIT), chemin littéral (--literal-pathspecs). Le plafond
// GIT_CEILING_DIRECTORIES empêche un dossier sans .git de lire le dépôt d'un parent (runs/ vit dans le dépôt essaim).
export async function journal(dossier: string, o: { chemin?: string; nombre: number }): Promise<{ ok: true; commits: Commit[] } | { ok: false; erreur: string }> {
  const r = await git(dossier, ["log", `-n${o.nombre}`, "--format=%x1e%h%x1f%an%x1f%aI%x1f%s", "HEAD", "--", ...(o.chemin ? [o.chemin] : [])],
    { env: { GIT_CEILING_DIRECTORIES: dirname(resolve(dossier)) } });
  if (r.code !== 0) return { ok: false, erreur: r.erreur.trim() || `git log : code ${r.code}` };
  return { ok: true, commits: r.sortie.split("\x1e").filter((b) => b.trim()).map((bloc) => {
    const [hash, auteur, date, message] = bloc.trim().split("\x1f");
    return { hash: hash!, auteur: auteur!, date: date!, message: message!, fichiers: [] };
  }) };
}

async function resoudre(dossier: string, ref: string): Promise<string | undefined> {
  if (!ref || ref.startsWith("-")) return undefined;
  const r = await git(dossier, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return r.code === 0 ? r.sortie.trim() : undefined;
}

// Les raisons des refus suivent la forme des outils : "<fait>. <ce qui le lève>", sans préfixe ni point final.
// Un refus levé par une fonction qui lève (ouvrirEssai) est un Refus ; toute autre erreur est une panne.
export class Refus extends Error {}

// Pour fermer un ticket : le commit existe ET il est dans le dossier commun (pas dans un essai jamais adopté).
export async function contenuDans(partage: string, ref: string): Promise<{ hash: string } | { raison: string }> {
  const hash = await resoudre(partage, ref);
  const levee = "Se lève quand le commit est dans le dossier commun";
  if (!hash) return { raison: `commit ${ref} inconnu. ${levee}` };
  if ((await git(partage, ["merge-base", "--is-ancestor", hash, BRANCHE])).code !== 0) return { raison: `le commit ${ref} est hors du dossier commun. ${levee}` };
  return { hash };
}

// Restaurer UN fichier à une version d'avant, en octets (une image reste intacte), puis le commiter aussitôt.
// Jamais de reset ni de checkout global : rien d'autre ne bouge.
export async function restaurer(partage: string, chemin: string, commit: string, agent: string, raison: string): Promise<{ ok: true; hash?: string; chemin: string; depuis: string; commit?: CommitFait } | { ok: false; raison: string; panne?: true }> {
  const propre = normaliserChemin(chemin.startsWith(partage + "/") ? chemin.slice(partage.length + 1) : chemin);
  if (!propre || propre === ".git" || propre.startsWith(".git/")) return { ok: false, raison: `${chemin} est hors du dossier partagé. Définitif pour ce chemin` };
  const hash = await resoudre(partage, commit);
  if (!hash) return { ok: false, raison: `commit ${commit} inconnu. Définitif pour ce commit` };
  const arbre = (await git(partage, ["ls-tree", hash, "--", propre])).sortie.trim();
  const [mode, type] = arbre.split(/\s+/);
  if (!arbre || type !== "blob") return { ok: false, raison: `${propre} est absent au commit ${commit}. Définitif pour ce fichier à ce commit` };
  if (mode === "120000") return { ok: false, raison: `${propre} est un lien symbolique au commit ${commit}. Définitif pour ce fichier à ce commit` };
  const cible = join(partage, propre);
  if (lstatSync(cible, { throwIfNoEntry: false })?.isSymbolicLink()) return { ok: false, raison: `${propre} est un lien symbolique. Se lève quand ${propre} n'est plus un lien` };
  const racine = realpathSync(partage);
  const sort = { ok: false as const, raison: `${propre} sort du dossier partagé par un lien. Définitif pour ce chemin` };
  const dedans = (d: string) => { try { return (realpathSync(d) + "/").startsWith(racine + "/"); } catch { return false; } };
  // Le plus proche parent qui existe est vérifié avant de créer quoi que ce soit : un parent devenu lien faisait
  // créer au lanceur, hors bac à sable, des dossiers hors de partage/ avant le refus.
  let existant = dirname(cible);
  while (!lstatSync(existant, { throwIfNoEntry: false })) existant = dirname(existant);
  if (!dedans(existant)) return sort;
  mkdirSync(dirname(cible), { recursive: true });
  if (!dedans(dirname(cible))) return sort;
  const contenu = await git(partage, ["cat-file", "blob", `${hash}:${propre}`]);
  if (contenu.code !== 0) return { ok: false, panne: true, raison: `git cat-file : ${contenu.erreur.trim()}` };
  writeFileSync(cible, contenu.octets);
  chmodSync(cible, mode === "100755" ? 0o755 : 0o644);
  const court = hash.slice(0, 7);
  const c = await commiter(partage, agent, `restaurer ${propre} à ${court} : ${uneLigne(raison, 60)}`, { chemins: [propre], seulEcrivain: true });
  return c ? { ok: true, chemin: propre, depuis: court, hash: c.hash, commit: c } : { ok: true, chemin: propre, depuis: court, hash: undefined };
}

// ---- Les essais : une branche essai/<nom> et son propre dossier, hors de partage/ ----------------------

export const NOM_ESSAI = /^[a-z0-9][a-z0-9-]{0,39}$/;

export async function ouvrirEssai(partage: string, essais: string, nom: string): Promise<string> {
  if (!NOM_ESSAI.test(nom)) throw new Refus(`le nom d'essai ${nom} est mal formé. Se lève avec un nom en minuscules, chiffres et tirets, 40 caractères au plus`);
  // Une branche n'est jamais supprimée : un nom pris l'est pour tout le run.
  if ((await git(partage, ["rev-parse", "--verify", "--quiet", `refs/heads/essai/${nom}`])).code === 0) throw new Refus(`l'essai ${nom} existe déjà. Définitif pour ce nom`);
  const dossier = join(essais, nom);
  mkdirSync(essais, { recursive: true });
  await git(partage, ["worktree", "prune"], { seulEcrivain: true });
  await exiger(partage, ["worktree", "add", "-q", "-b", `essai/${nom}`, dossier, BRANCHE], { seulEcrivain: true });
  return dossier;
}

// Adopter un essai dans le dossier commun. La fusion est d'abord calculée à blanc (merge-tree) : sur conflit,
// rien n'est touché et les fichiers en cause sont nommés. Branche et dossier de l'essai restent.
// fichiers et blobs : ce que le commit de fusion change dans le dossier commun (contre son premier parent) ;
// avant : appelé avec le commit « avant adoption » fait dans l'essai, s'il y en a un (même en cas de refus ensuite).
export async function adopter(partage: string, essais: string, nom: string, agent: string, avant?: (c: CommitFait, dossier: string) => void): Promise<{ ok: true; hash: string; fichiers: string[]; blobs: FichierCommit[] } | { ok: false; raison: string; conflits?: string[]; panne?: true }> {
  const branche = `essai/${nom}`;
  if ((await git(partage, ["rev-parse", "--verify", "--quiet", `refs/heads/${branche}`])).code !== 0) return { ok: false, raison: `aucun essai ${nom}. Se lève après depot_essai de ce nom` };
  const courante = (await git(partage, ["symbolic-ref", "--short", "-q", "HEAD"])).sortie.trim();
  if (courante !== BRANCHE) return { ok: false, raison: `le dossier commun n'est pas sur ${BRANCHE} (${courante || "HEAD détachée"}). Se lève quand il revient sur ${BRANCHE}` };
  const dossier = join(essais, nom);
  if (existsSync(dossier)) {
    const c = await commiter(dossier, agent, `avant adoption de l'essai ${nom}`, { seulEcrivain: true });
    if (c) avant?.(c, dossier);
  }
  // Ce que l'essai change depuis qu'il a quitté le dossier commun (trois points : depuis leur ancêtre commun) : des
  // candidats, seulement pour refuser une adoption qui ne changerait rien.
  const candidats = (await git(partage, ["diff", "--name-only", `${BRANCHE}...${branche}`])).sortie.split("\n").filter(Boolean);
  if (candidats.length === 0) return { ok: false, raison: `l'essai ${nom} ne change aucun fichier du dossier commun. Se lève quand l'essai change un fichier` };
  const blanc = await git(partage, ["merge-tree", "--write-tree", "--name-only", "--no-messages", BRANCHE, branche]);
  if (blanc.code === 1) {
    const conflits = blanc.sortie.split("\n").slice(1).filter(Boolean);
    return { ok: false, raison: `conflit sur ${conflits.join(", ")}, le dossier commun n'a pas bougé. Se lève quand l'essai ne contredit plus ces lignes`, conflits };
  }
  if (blanc.code !== 0) return { ok: false, panne: true, raison: `git merge-tree : ${blanc.erreur.trim()}` };
  const email = signature(agent).match(/<(.+)>/)![1]!;
  const r = await git(partage, ["merge", "--no-ff", "-q", "-m", `adopter l'essai ${nom}`, branche], { seulEcrivain: true, env: { GIT_AUTHOR_NAME: agent, GIT_AUTHOR_EMAIL: email } });
  if (r.code !== 0) {
    if (existsSync(join(partage, ".git", "MERGE_HEAD"))) await git(partage, ["merge", "--abort"], { seulEcrivain: true });
    return { ok: false, raison: `le dossier commun a des changements pas encore commités sur ces fichiers. Se lève quand la salle les a commités, en quelques secondes\n${(r.erreur || r.sortie).trim()}` };
  }
  const hash = (await exiger(partage, ["rev-parse", "--short", "HEAD"])).trim();
  const blobs = await fichiersDuCommit(partage, hash, { premierParent: true });
  return { ok: true, hash, fichiers: blobs.map((f) => f.chemin), blobs };
}

// Ce qu'une adoption de l'essai changerait dans le dossier commun : ses commits depuis qu'il en est parti
// (trois points, comme adopter) et ce qui n'y est pas encore commité, que l'adoption commite d'abord. Lecture seule,
// sans verrou : l'extension le lit pour savoir qui peut adopter. [] : essai inconnu, ou rien de changé.
export async function fichiersDeLEssai(partage: string, essais: string, nom: string): Promise<string[]> {
  if (!NOM_ESSAI.test(nom)) return [];
  const commites = await git(partage, ["diff", "--name-only", "-z", `${BRANCHE}...essai/${nom}`]);
  if (commites.code !== 0) return [];
  const dossier = join(essais, nom);
  const enCours = existsSync(dossier) ? await git(dossier, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]) : undefined;
  const pendants = enCours?.code === 0 ? enCours.sortie.split("\0").filter(Boolean).map((l) => l.slice(3)) : [];
  return [...new Set([...commites.sortie.split("\0").filter(Boolean), ...pendants])];
}

// L'identité d'un .git (son inode) : le lanceur la note quand il crée le dépôt ou un essai, et refuse de
// travailler dans un .git qui a changé. Sans ça, un agent qui renomme partage/ (le bac à sable ne ferme que
// l'intérieur des .git) et en recrée un piégé ferait exécuter sa configuration au git du lanceur.
export function identite(racine: string): number | undefined {
  return lstatSync(join(racine, ".git"), { throwIfNoEntry: false })?.ino;
}

// ---- Les commits automatiques : à chaque fin d'outil qui écrit -------------------------------------------

const uneLigne = (s: string, n: number) => { const l = s.replace(/\s+/g, " ").trim(); return l.length > n ? l.slice(0, n) + "…" : l; };

// Où tombe un chemin écrit par un agent : partage/ ou un essai, et le chemin relatif à ce dossier. Un chemin
// relatif part du bureau de l'agent, comme pour pi. undefined : hors de tout dépôt (le bureau, /tmp…).
export function cible(runDir: string, bureau: string, brut: string): { racine: string; rel: string } | undefined {
  if (!brut) return undefined;
  const chemin = resolve(bureau, brut.startsWith("~/") ? join(homedir(), brut.slice(2)) : brut).normalize("NFC");
  const partage = join(runDir, "partage"), essais = join(runDir, "essais");
  // Les préfixes se comparent sans la casse : le disque du Mac la confond, et « PARTAGE/app.js » écrivait dans
  // partage/ sans passer ni par les refus du rôle ni par le commit.
  const sous = (prefixe: string) => cleChemin(chemin).startsWith(cleChemin(prefixe) + "/") ? chemin.slice(prefixe.length + 1) : undefined;
  const dansEssais = sous(essais), dansPartage = sous(partage);
  const racine = dansEssais !== undefined ? join(essais, dansEssais.split("/")[0]!) : dansPartage !== undefined ? partage : undefined;
  if (!racine) return undefined;
  const rel = dansEssais !== undefined ? dansEssais.split("/").slice(1).join("/") : dansPartage!;
  if (!rel) return undefined;
  if (cleChemin(rel) === ".git" || cleChemin(rel).startsWith(".git/")) return undefined;
  return { racine, rel };
}

// Ce qu'un outil terminé doit commiter. write et edit : leur fichier. page_voir : sa capture et sa planche des tailles. bash : tout ce qui a
// changé, dans partage et les essais, sauf les fichiers en cours d'écriture par un write ou un edit (`enCours`,
// chemins absolus) — ceux-là partiront sous leur propre nom. Les autres outils n'écrivent pas.
export type Engagement = { racine: string; message: string; chemins?: string[]; sauf?: string[] };
// essais : les dossiers d'essai ouverts par le lanceur, les seuls où il commite (jamais un dossier créé par un agent).
export function aCommiter(runDir: string, bureau: string, outil: string, args: Record<string, unknown> | undefined, enCours: Iterable<string> = [], essais: string[] = []): Engagement[] {
  if (outil === "write" || outil === "edit") {
    const c = cible(runDir, bureau, String(args?.path ?? ""));
    return c ? [{ racine: c.racine, message: `${outil} ${c.rel}`, chemins: [c.rel] }] : [];
  }
  if (outil === "page_assembler") { // la page de sortie, relative au dossier partagé (comme l'outil)
    const c = cible(runDir, join(runDir, "partage"), String(args?.sortie ?? "index.html"));
    return c ? [{ racine: c.racine, message: `page_assembler : ${c.rel}`, chemins: [c.rel] }] : [];
  }
  if (outil === "page_voir") {
    const brute = typeof args?.capture === "string" ? normaliserChemin(args.capture) : undefined;
    const capture = brute && (brute.toLowerCase().endsWith(".png") ? brute : `${brute}.png`);
    const planche = Array.isArray(args?.tailles) ? nomPlanche(capture) : undefined; // la planche, comme la capture
    if (!capture && !planche) return [];
    const page = cible(runDir, join(runDir, "partage"), String(args?.page ?? ""));
    const racine = page?.racine ?? join(runDir, "partage");
    const quoi = [...(capture ? [`capture ${capture}`] : []), ...(planche ? [`planche ${planche}`] : [])].join(", ");
    return [{ racine, message: `page_voir : ${quoi}`, chemins: [capture, planche].filter((c): c is string => !!c) }];
  }
  if (outil === "bash") {
    const message = `bash : ${uneLigne(String(args?.command ?? ""), 72)}`;
    const ouverts = [...enCours];
    return [join(runDir, "partage"), ...essais].map((racine) => ({
      racine, message, sauf: ouverts.filter((p) => p.startsWith(racine + "/")).map((p) => relative(racine, p)),
    }));
  }
  return [];
}

// Pour le bilan et le juge : commits signés par chaque agent sur toutes les branches, et adoptions à part.
export async function bilanCommits(partage: string): Promise<{ total: number; parAgent: Record<string, number>; adoptions: Record<string, number> }> {
  const compter = (sortie: string) => {
    const n: Record<string, number> = {};
    for (const a of sortie.split("\n").filter(Boolean)) if (a !== "essaim") n[a] = (n[a] ?? 0) + 1;
    return n;
  };
  const parAgent = compter((await git(partage, ["log", "--all", "--no-merges", "--format=%an"])).sortie);
  const adoptions = compter((await git(partage, ["log", BRANCHE, "--merges", "--format=%an"])).sortie);
  return { total: Object.values(parAgent).reduce((s, n) => s + n, 0), parAgent, adoptions };
}

// ---- Les demandes des agents : restaurer, essai, adopter, servies dans la file du lanceur ------------------

export type Surs = Map<string, number>; // les dépôts ouverts par le lanceur (partage et essais) et l'inode de leur .git
// panne : la demande n'a pas pu être faite (git en échec, demande inconnue) ; l'outil lève une erreur au lieu d'un refus.
export type Reponse = { ok: boolean; texte?: string; raison?: string; panne?: boolean; hash?: string; dossier?: string; chemin?: string; conflits?: string[]; fichiers?: string[]; blobs?: FichierCommit[]; depuis?: string; commit?: CommitFait };

export async function servirDemande(t: Tableau, runDir: string, surs: Surs, d: DemandeGit): Promise<Reponse> {
  const partage = join(runDir, "partage"), essais = join(runDir, "essais");
  if (surs.get(partage) === undefined || identite(partage) !== surs.get(partage)) return { ok: false, raison: "le dépôt du run a disparu ou a été remplacé. Définitif pour ce run" };
  const a = d.args;
  switch (d.action) {
    case "restaurer": {
      const raison = String(a.raison ?? "");
      const r = await restaurer(partage, String(a.chemin ?? ""), String(a.commit ?? ""), d.agent, raison);
      if (!r.ok || !r.commit) return r;
      const c = r.commit, dite = raisonDeclaree(raison, d.agent);
      // Un commit de demande, un seul fait : la restauration porte hash, fichiers et blobs, sans fait ecriture.
      t.transaction(() => noterFait(t, { type: "restauration", agent: d.agent, source: "lanceur", sujet: r.chemin,
        texte: `restauré · ${r.chemin} à ${r.depuis} · ${d.agent} · commit ${c.hash}${dite.texte}`,
        details: { hash: c.hash, message: c.message, fichiers: c.fichiers, racine: "partage", depuis: r.depuis, ...dite.details } }));
      return r;
    }
    case "essai": {
      const nom = String(a.nom ?? "");
      try {
        const dossier = await ouvrirEssai(partage, essais, nom);
        surs.set(dossier, identite(dossier)!);
        noterEssai(t, nom, d.agent, String(a.raison ?? ""), dossier);
        return { ok: true, dossier };
      } catch (e) {
        if (e instanceof Refus) return { ok: false, raison: e.message };
        return { ok: false, panne: true, raison: String((e as Error).message ?? e) };
      }
    }
    case "adopter": {
      const nom = String(a.nom ?? "");
      const dossier = join(essais, nom);
      if (existsSync(dossier) && surs.has(dossier) && identite(dossier) !== surs.get(dossier)) return { ok: false, raison: `le dossier de l'essai ${nom} a été remplacé. Définitif pour cet essai` };
      const r = await adopter(partage, essais, nom, d.agent, (c, racine) => t.transaction(() => noterFait(t, faitEcriture(c, d.agent, racineDuFait(racine, partage), "depot_adopter"))));
      if (r.ok) noterAdoption(t, nom, d.agent, r.hash, r.blobs);
      return r;
    }
    default:
      return { ok: false, panne: true, raison: `demande inconnue : ${d.action}` };
  }
}

// Sonde les demandes toutes les `ms` et les sert dans la file, une à la fois. Rend la fonction qui arrête.
// Le lanceur l'utilise pendant tout le run ; les tests des outils aussi, faute de lanceur.
// L'annonce d'une demande servie, par la salle et non par l'outil : l'outil n'attend que
// DEMANDE_MS ; une demande servie après son abandon ne serait annoncée à personne, et l'agent ne connaîtrait jamais le
// dossier de son essai. Un refus arrivé après l'attente est dit à l'agent, nommé (il se réveille s'il dort).
const demandeMs = () => Number(process.env.ESSAIM_DEMANDE_MS ?? 60_000); // le délai de l'outil, lu comme lui
function annoncerDemande(t: Tableau, d: DemandeGit, r: Reponse): void {
  const a = d.args;
  if (r.ok) {
    if (d.action === "restaurer") poster(t, d.agent, `[restauré] ${String(a.chemin)} revient à sa version du commit ${String(a.commit)}${r.hash ? ` (nouveau commit ${r.hash})` : " (il était déjà identique)"} : ${String(a.raison ?? "")}`);
    if (d.action === "essai") poster(t, d.agent, `[essai] j'ouvre l'essai ${String(a.nom)} dans ${r.dossier} : ${String(a.raison ?? "")}`);
    if (d.action === "adopter") poster(t, d.agent, `[adopté] l'essai ${String(a.nom)} entre dans le dossier commun (commit ${r.hash}) : ${r.fichiers?.join(", ")}`);
    return;
  }
  const tard = d.cree_le !== undefined && Date.now() - Date.parse(d.cree_le) >= demandeMs();
  if (tard) poster(t, "essaim", `${d.agent} : ta demande depot_${d.action} ${String(a.nom ?? a.chemin ?? "")}, faite après ton attente, est refusée : ${r.raison}`);
}

export function servirDemandes(t: Tableau, runDir: string, file: FileGit, surs: Surs, ms: number, apres?: (d: DemandeGit, r: Reponse) => void): () => void {
  const minuterie = setInterval(() => {
    for (const d of prendreDemandes(t)) {
      void file.mettre(async () => {
        let r: Reponse;
        try {
          r = await servirDemande(t, runDir, surs, d);
        } catch (e) {
          r = { ok: false, panne: true, raison: `la salle n'a pas pu le faire : ${String((e as Error).message ?? e).slice(0, 300)}` };
        }
        repondreDemande(t, d.id, r);
        annoncerDemande(t, d, r);
        apres?.(d, r);
      });
    }
  }, ms);
  return () => clearInterval(minuterie);
}
