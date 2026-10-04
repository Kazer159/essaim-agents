#!/usr/bin/env bun
// Le banc d'essai hors run : l'ancienne et la nouvelle liste d'outils de la salle, posées au
// même modèle sur les mêmes situations, sans salle ni run, sans exécuter aucun outil.
//
//   bun sondes/banc-outils.ts figer <racine-du-depot> <sortie.json>
//     charge <racine>/src/outils-essaim.ts et se-resumer.ts sur un tableau jetable et fige leurs définitions
//     (nom, description, résumé court, schéma) avec les consignes de la salle, gabarits remplis.
//   bun sondes/banc-outils.ts lancer --modele <alias> [--situations f] [--sortie dossier] [--avant f] [--apres f]
//     PAYANT : un appel au fournisseur par situation et par catalogue, par pi (ESSAIM_PI respecté).
//
// Les quatre outils de pi (read, bash, edit, write) ne sont pas figés : pi les fournit lui-même, identiques pour
// les deux listes.
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { lireAlias } from "../src/modeles.ts";
import { OUTILS_PI } from "../src/noms-outils.ts";
import { binairePi, tuerGroupe } from "../src/processus.ts";

export type OutilFige = { name: string; label: string; description: string; promptSnippet?: string; parameters: unknown };
export type Catalogue = { commit: string; consignes: string; outils: OutilFige[] };

const COMPACTAGE = "80000,120000,160000"; // le défaut du lanceur : moi_resumer est chargé, comme dans un run
const SECTION_ENTREES = /\n## Les documents à traiter\n[\s\S]*?(?=\n## |\s*$)/; // retirée par le lanceur sans documents

// Les consignes telles qu'un agent les reçoit dans un run sans documents : prénom Claude, dix agents, un dossier
// partagé fictif.
export function remplirConsignes(modele: string): string {
  return modele.replace(SECTION_ENTREES, "").replaceAll("{NOM}", "Claude").replaceAll("{N}", "10")
    .replaceAll("{PARTAGE}", "/banc/runs/banc/partage");
}

export async function figer(racineBrute: string): Promise<Catalogue> {
  const racine = resolve(racineBrute);
  const dossier = mkdtempSync(join(tmpdir(), "banc-figer-"));
  const env = { ...process.env };
  try {
    // L'extension exige une base, et y écrit son PID (src/outils-essaim.ts) : un tableau jetable, du même dépôt.
    const T = await import(join(racine, "src", "tableau.ts"));
    const { ouvrirBun } = await import(join(racine, "src", "tableau-bun.ts"));
    const chemin = join(dossier, "tableau.sqlite");
    const t = ouvrirBun(chemin);
    T.initialiser(t);
    T.ouvrirRun(t, { id: "banc", missionChemin: "banc", missionTexte: "banc", modele: "banc", plafondUsd: 0, silenceMin: 0 });
    T.ajouterAgent(t, "Claude", dossier);
    Object.assign(process.env, { ESSAIM_AGENT: "Claude", ESSAIM_TABLEAU: chemin, ESSAIM_PARTAGE: join(dossier, "partage"), ESSAIM_COMPACTAGE: COMPACTAGE });
    const outils: OutilFige[] = [];
    const api = {
      registerTool: (d: OutilFige) => outils.push({ name: d.name, label: d.label, description: d.description, promptSnippet: d.promptSnippet,
        parameters: JSON.parse(JSON.stringify(d.parameters)) }), // le schéma tel que pi l'envoie : du JSON, sans les marques TypeBox
      registerCommand: () => {},
      on: () => {},
    };
    (await import(join(racine, "src", "outils-essaim.ts"))).default(api, ouvrirBun);
    (await import(join(racine, "src", "se-resumer.ts"))).default(api);
    t.fermer();
    const commit = execFileSync("git", ["-C", racine, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
    const consignes = remplirConsignes(readFileSync(join(racine, "src", "consignes-salle.md"), "utf8"));
    return { commit, consignes, outils };
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
    Object.assign(process.env, env);
    rmSync(dossier, { recursive: true, force: true });
  }
}

// --- Situations, jugement, rapport (règles écrites dans sondes/banc-situations.json) ---

export type Cote = "avant" | "apres";
export type Attendu = { outil: string; args?: Record<string, unknown>; motif?: string };
export type Situation = { id: string; contexte: string; attendu: Record<Cote, Attendu>; equivalences?: Partial<Record<Cote, string[]>> };
export type FichierSituations = { regles: string[]; preambule: string; situations: Situation[] };
export type Appel = { name: string; arguments: unknown };
export type Reponse = { appels: Appel[]; cout: number; panne?: string };
export type Verdict = {
  situation: string; catalogue: Cote; outil?: string; args?: unknown; nbAppels: number; cout: number;
  bon: boolean; valide: boolean | null; inconnu: boolean; sansAppel: boolean; plusieurs: boolean; panne?: string; erreurSchema?: string;
};

// « outil » ou « outil ~ motif ».
const lireEquivalence = (e: string): Attendu => {
  const i = e.indexOf("~");
  return i < 0 ? { outil: e.trim() } : { outil: e.slice(0, i).trim(), motif: e.slice(i + 1).trim() };
};

const present = (v: unknown) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);

export function correspond(appel: Appel, a: Attendu): boolean {
  if (appel.name !== a.outil) return false;
  const args = (appel.arguments && typeof appel.arguments === "object" ? appel.arguments : {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(a.args ?? {})) {
    const x = args[k];
    if (v === "*") { if (!present(x)) return false; continue; }
    if (typeof v === "string") { if (typeof x !== "string" || x.trim().toLowerCase() !== v.toLowerCase()) return false; continue; }
    if (String(x) !== String(v)) return false; // nombres et booléens : 9 et "9" se valent, comme après la conversion de pi
  }
  return a.motif === undefined || new RegExp(a.motif).test(JSON.stringify(args));
}

export function juger(s: Situation, cote: Cote, catalogue: Catalogue, r: Reponse): Verdict {
  const premier = r.appels[0];
  const base = { situation: s.id, catalogue: cote, nbAppels: r.appels.length, cout: r.cout, sansAppel: !r.panne && r.appels.length === 0, plusieurs: r.appels.length > 1, ...(r.panne ? { panne: r.panne } : {}) };
  if (!premier) return { ...base, bon: false, valide: false, inconnu: false };
  const outil = catalogue.outils.find((o) => o.name === premier.name);
  const dePi = (OUTILS_PI as readonly string[]).includes(premier.name);
  let valide: boolean | null = null, erreurSchema: string | undefined; // null : un outil de pi, dont le schéma n'est pas figé
  if (outil) {
    try { validateToolArguments({ ...outil, parameters: outil.parameters } as never, { type: "toolCall", id: "banc", name: premier.name, arguments: premier.arguments } as never); valide = true; }
    catch (e) { valide = false; erreurSchema = String((e as Error).message ?? e).split("\n").slice(0, 3).join(" "); }
  } else if (!dePi) valide = false;
  const attendus = [s.attendu[cote], ...(s.equivalences?.[cote] ?? []).map(lireEquivalence)];
  return { ...base, outil: premier.name, args: premier.arguments, bon: attendus.some((a) => correspond(premier, a)), valide, inconnu: !outil && !dePi, ...(erreurSchema ? { erreurSchema } : {}) };
}

type Compte = { situations: number; bon: number; valides: number; appelsSalle: number; inconnus: number; sansAppel: number; plusieurs: number; pannes: number; cout: number };

export function rapport(verdicts: Verdict[], o: { modele: string; avant: string; apres: string }) {
  const compter = (cote: Cote): Compte => {
    const v = verdicts.filter((x) => x.catalogue === cote);
    return { situations: v.length, bon: v.filter((x) => x.bon).length, valides: v.filter((x) => x.valide === true).length,
      appelsSalle: v.filter((x) => x.valide !== null && x.outil !== undefined && !x.inconnu).length, inconnus: v.filter((x) => x.inconnu).length,
      sansAppel: v.filter((x) => x.sansAppel).length, plusieurs: v.filter((x) => x.plusieurs).length, pannes: v.filter((x) => x.panne).length,
      cout: v.reduce((n, x) => n + x.cout, 0) };
  };
  const avant = compter("avant"), apres = compter("apres");
  const repli = apres.bon < avant.bon;
  const toutEnPanne = avant.pannes === avant.situations && apres.pannes === apres.situations;
  const phrase = toutEnPanne
    ? "aucune conclusion : tous les appels sont en panne"
    : repli
    ? `repli O4 (anciens noms, autres leviers seuls) à trancher avec l'utilisateur : la nouvelle liste trouve le bon outil du premier coup ${apres.bon} fois sur ${apres.situations}, l'ancienne ${avant.bon} fois sur ${avant.situations}`
    : `seuil tenu : la nouvelle liste trouve le bon outil du premier coup ${apres.bon} fois sur ${apres.situations}, au moins autant que l'ancienne (${avant.bon} sur ${avant.situations})`;
  const pannes = avant.pannes + apres.pannes;
  const col = (a: string, b: string, c: string) => `${a.padEnd(28)}${b.padEnd(20)}${c}`;
  const ids = [...new Set(verdicts.map((x) => x.situation))];
  const marque = (x?: Verdict) => !x ? "—" : x.panne ? "panne" : x.sansAppel ? "sans appel" : `${x.outil}${x.bon ? " (bon)" : ""}${x.valide === false ? " (invalide)" : ""}${x.plusieurs ? ` (+${x.nbAppels - 1})` : ""}`;
  const texte = [
    `banc d'essai des outils · modèle ${o.modele} · ${ids.length} situations · ${verdicts.length} appels`,
    col("", `avant (${o.avant})`, `après (${o.apres})`),
    col("bon outil du premier coup", `${avant.bon}/${avant.situations}`, `${apres.bon}/${apres.situations}`),
    col("paramètres valides", `${avant.valides}/${avant.appelsSalle}`, `${apres.valides}/${apres.appelsSalle}`),
    col("nom inconnu", String(avant.inconnus), String(apres.inconnus)),
    col("sans appel", String(avant.sansAppel), String(apres.sansAppel)),
    col("plusieurs appels", String(avant.plusieurs), String(apres.plusieurs)),
    col("pannes", String(avant.pannes), String(apres.pannes)),
    col("coût", `${avant.cout.toFixed(4)} $`, `${apres.cout.toFixed(4)} $`),
    "",
    "plusieurs appels : seul le premier compte. paramètres valides : sur les premiers appels à un outil de la salle (les outils de pi ne sont pas figés).",
    "",
    ...ids.map((id) => `${id.padEnd(34)}avant : ${marque(verdicts.find((x) => x.situation === id && x.catalogue === "avant"))} · après : ${marque(verdicts.find((x) => x.situation === id && x.catalogue === "apres"))}`),
    "",
    ...(pannes ? [`attention : ${pannes} appel(s) en panne, la comparaison est incomplète`] : []),
    `conclusion : ${phrase}`,
  ].join("\n");
  return { texte, json: { modele: o.modele, catalogues: { avant: o.avant, apres: o.apres }, avant, apres, conclusion: { repli, phrase }, verdicts } };
}

// --- Le lancement : PAYANT hors des tests (un appel au fournisseur par situation et par catalogue) ---

const ICI = import.meta.dir;
export const DEFAUTS = { situations: join(ICI, "banc-situations.json"), avant: join(ICI, "banc", "catalogue-avant.json"), apres: join(ICI, "banc", "catalogue-apres.json") };

// Un alias de modeles.yaml, ou un id complet « fournisseur/modèle » ; réflexion de l'alias, medium sinon.
export function modeleDe(alias: string): { id: string; reflexion: string } {
  const e = lireAlias()[alias] ?? (alias.includes("/") ? { id: alias } : undefined);
  if (!e) throw new Error(`alias de modèle inconnu : ${alias}`);
  return { id: e.id, reflexion: e.reflexion ?? "medium" };
}

// Les arguments de pi : son transport et son authentification, rien d'autre (ni skills, ni extensions de la salle,
// ni fichiers de contexte, ni session).
export function argumentsBanc(m: { id: string; reflexion: string }, consignes: string, texte: string): string[] {
  return ["--mode", "json", "-p", "--no-skills", "--no-extensions", "--no-context-files", "--no-session",
    "-e", join(ICI, "banc-extension.ts"), "--model", m.id, "--thinking", m.reflexion, "--append-system-prompt", consignes, "--", texte];
}

// Un lancement de pi : attend le message écrit par banc-extension.ts (BANC_SORTIE), ou la fin du processus.
async function unAppel(o: { args: string[]; env: Record<string, string>; sortie: string; bureau: string; delaiMs: number }): Promise<Reponse> {
  rmSync(o.sortie, { force: true });
  const proc = Bun.spawn([binairePi(), ...o.args], { cwd: o.bureau, stdin: "ignore", stdout: "ignore", stderr: "pipe", detached: true, env: { ...process.env, ...o.env } });
  const stderr = new Response(proc.stderr).text();
  const minuterie = setTimeout(() => void tuerGroupe(proc.pid, 2000), o.delaiMs);
  await proc.exited;
  clearTimeout(minuterie);
  await tuerGroupe(proc.pid, 2000); // les descendants éventuels
  if (!existsSync(o.sortie)) {
    const fin = (await stderr).trim().split("\n").slice(-3).join(" ").slice(0, 300);
    return { appels: [], cout: 0, panne: `pi sans réponse (code ${proc.exitCode ?? proc.signalCode})${fin ? ` : ${fin}` : ""}` };
  }
  const m = JSON.parse(readFileSync(o.sortie, "utf8")) as { content?: Array<{ type: string; name?: string; arguments?: unknown }>; usage?: { cost?: { total?: number } }; stopReason?: string; errorMessage?: string };
  const appels = (m.content ?? []).filter((c) => c.type === "toolCall").map((c) => ({ name: String(c.name), arguments: c.arguments ?? {} }));
  const cout = typeof m.usage?.cost?.total === "number" ? m.usage.cost.total : 0;
  return m.stopReason === "error" || m.stopReason === "aborted"
    ? { appels: [], cout, panne: `fournisseur : ${m.errorMessage ?? m.stopReason}` }
    : { appels, cout };
}

export async function lancer(o: { modele: string; sortie: string; situations?: string; avant?: string; apres?: string; delaiMs?: number; journal?: (l: string) => void }) {
  o = { ...o, sortie: resolve(o.sortie) }; // pi tourne dans un bureau à part : un chemin relatif y serait perdu
  const m = modeleDe(o.modele);
  const fichier = JSON.parse(readFileSync(o.situations ?? DEFAUTS.situations, "utf8")) as FichierSituations;
  const chemins: Record<Cote, string> = { avant: resolve(o.avant ?? DEFAUTS.avant), apres: resolve(o.apres ?? DEFAUTS.apres) };
  const catalogues: Record<Cote, Catalogue> = { avant: JSON.parse(readFileSync(chemins.avant, "utf8")), apres: JSON.parse(readFileSync(chemins.apres, "utf8")) };
  const appels = join(o.sortie, "appels");
  mkdirSync(appels, { recursive: true });
  const bureau = mkdtempSync(join(tmpdir(), "banc-bureau-")); // un répertoire vide : rien à lire autour de pi
  const verdicts: Verdict[] = [];
  try {
    for (const s of fichier.situations) {
      for (const cote of ["avant", "apres"] as const) {
        const sortie = join(appels, `${s.id}-${cote}.json`);
        const r = await unAppel({ args: argumentsBanc(m, catalogues[cote].consignes, `${fichier.preambule}\n\n${s.contexte}`), sortie, bureau, delaiMs: o.delaiMs ?? 300_000,
          env: { BANC_CATALOGUE: chemins[cote], BANC_SORTIE: sortie, BANC_SITUATION: s.id, BANC_COTE: cote } });
        const v = juger(s, cote, catalogues[cote], r);
        verdicts.push(v);
        o.journal?.(`${s.id} ${cote} : ${v.panne ?? (v.outil ?? "sans appel")}${v.bon ? " (bon)" : ""}`);
      }
    }
  } finally {
    rmSync(bureau, { recursive: true, force: true });
  }
  const r = rapport(verdicts, { modele: m.id, avant: catalogues.avant.commit, apres: catalogues.apres.commit });
  writeFileSync(join(o.sortie, "rapport.txt"), r.texte + "\n");
  writeFileSync(join(o.sortie, "rapport.json"), JSON.stringify(r.json, null, 2) + "\n");
  return r;
}

async function principal(argv: string[]): Promise<number> {
  const [commande, ...reste] = argv;
  if (commande === "figer" && reste.length === 2) {
    const c = await figer(reste[0]!);
    writeFileSync(reste[1]!, JSON.stringify(c, null, 2) + "\n");
    console.log(`${c.outils.length} outils figés depuis ${c.commit} dans ${reste[1]}`);
    return 0;
  }
  if (commande === "lancer") {
    const { values } = parseArgs({ args: reste, options: { modele: { type: "string" }, situations: { type: "string" }, sortie: { type: "string" }, avant: { type: "string" }, apres: { type: "string" } } });
    if (!values.modele) { console.error("--modele manquant"); return 2; }
    const sortie = values.sortie ?? join("runs", `banc-outils-${new Date().toISOString().slice(0, 19).replaceAll(":", "-")}`);
    const r = await lancer({ modele: values.modele, sortie, situations: values.situations, avant: values.avant, apres: values.apres, journal: (l) => console.log(l) });
    console.log(`\n${r.texte}\n\nrapport : ${join(sortie, "rapport.txt")}`);
    return 0;
  }
  console.error("usage : bun sondes/banc-outils.ts figer <racine-du-depot> <sortie.json>\n"
    + "        bun sondes/banc-outils.ts lancer --modele <alias> [--situations f] [--sortie dossier] [--avant f] [--apres f]");
  return 2;
}

if (import.meta.main) process.exit(await principal(Bun.argv.slice(2)));
