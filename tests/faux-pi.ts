#!/usr/bin/env bun
// Faux pi : imite `pi --mode json -p` sans appeler aucun modèle. Il accepte et
// ignore toutes les options de pi, rejoue la fixture ESSAIM_FIXTURE ligne par
// ligne sur stdout et, pour chaque tool_execution_start d'un outil que la vraie extension enregistre (l'outil de
// résumé compris quand ESSAIM_COMPACTAGE est défini ; aucune liste écrite ici), appelle réellement l'outil,
// puis émet le tool_execution_end correspondant. Un outil de pi ou un nom inconnu de l'extension est émis tel quel. Le lanceur ne sait pas qu'il parle à un
// faux ; l'extension est exercée pour de vrai ; zéro token.
//
// Variables : ESSAIM_FIXTURE (chemin du .jsonl ; ESSAIM_FIXTURE_ANTOINE prime
// pour Antoine, ce qui permet deux scénarios dans un même run ; ESSAIM_FIXTURE_PASSE_2
// prime à la deuxième passe, pour rejouer une relance ; ESSAIM_FIXTURE_<AGENT>_PASSE_2 pour lui seul), ESSAIM_FIXTURE_DELAI_MS (délai
// entre lignes, 0), ESSAIM_FIXTURE_CODE (code de sortie, 0). Un événement
// {"type":"faux:dormir","ms":N} attend N ms sans rien émettre ; {"type":"faux:session","contenu":"…"}
// écrit <run>/sessions/faux_<agent>.jsonl, la mémoire que pi relirait.
// Dans chaque ligne, {PARTAGE}, {RUN} et {AGENT} sont remplacés ; un tool_execution_start de `write`
// écrit vraiment args.content dans args.path (relatif au bureau, comme pi) avant d'être émis, et c'est la
// fixture qui donne la fin plus loin ; {"type":"faux:attendre","chemin":…} attend qu'un fichier existe (5 s au
// plus) et {"type":"faux:toucher","chemin":…} le crée : de quoi imposer un ordre entre deux agents.
// {"type":"faux:ecrire","chemin":…,"contenu":…} écrit un fichier : ce qu'un bash aurait écrit, entre son
// tool_execution_start et sa fin. {"type":"faux:lancer","commande":[…]} lance un processus enfant sans l'attendre.
// À chaque lancement, ses arguments et son environnement ESSAIM_* sont ajoutés
// à <run>/journal/<agent>.args si ce dossier existe.
// Les messages comme pi (print-mode.js:98-109, agent-session.js:828-853) : le faux pi
// charge les extensions de ses -e, dans l'ordre (outils-essaim.ts avec ouvrirBun, se-resumer.ts…), émet d'abord
// l'en-tête {"type":"session",…}, puis traite chaque message passé après -- : une commande /nom args d'une extension
// est exécutée et n'émet rien (un compactage demandé par la commande se termine après ESSAIM_FAUX_COMPACTAGE_MS,
// 0 par défaut) ; un autre message passe par les gestionnaires input, puis est émis en message_end de rôle user avec
// le texte final (rien si un gestionnaire l'a pris en charge). Ensuite seulement, la fixture est rejouée.
// ESSAIM_FAUX_ARRET_ENTETE=1 : pi meurt entre son en-tête et son message utilisateur — commandes et
// gestionnaires input ont tourné, mais rien d'autre que l'en-tête n'est émis ; sortie avec ESSAIM_FIXTURE_CODE.
// ESSAIM_FAUX_ARRET_ENTETE_PASSE=N : la même mort, au N-ième lancement de l'agent seulement.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { OUTILS_PI } from "../src/noms-outils.ts";
import { ouvrirBun } from "../src/tableau-bun.ts";
import { fauxPi } from "./aide/faux-extension-api.ts";

// Une fixture propre à un agent prime : ESSAIM_FIXTURE_ANTOINE pour Antoine (le prénom en capitales).
const agent = process.env.ESSAIM_AGENT, tableau = process.env.ESSAIM_TABLEAU;
// Un chemin relatif est pris depuis la racine du dépôt (le répertoire de travail du faux pi est le bureau de l'agent).
const RACINE = resolve(import.meta.dir, "..");
let passe = 1; // le nombre de lancements de cet agent dans ce run, lu dans <run>/journal/<agent>.args
if (agent && tableau) {
  const journal = join(dirname(tableau), "journal");
  if (existsSync(journal)) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("ESSAIM_")));
    const args = join(journal, `${agent}.args`);
    appendFileSync(args, JSON.stringify({ args: process.argv.slice(2), env }) + "\n");
    passe = readFileSync(args, "utf8").split("\n").filter(Boolean).length;
  }
}
const AGENT = agent?.toUpperCase().replaceAll("-", "_");
const demandee = (AGENT && process.env[`ESSAIM_FIXTURE_${AGENT}_PASSE_${passe}`]) || process.env[`ESSAIM_FIXTURE_PASSE_${passe}`]
  || (AGENT && process.env[`ESSAIM_FIXTURE_${AGENT}`]) || process.env.ESSAIM_FIXTURE;
const fixture = demandee ? resolve(RACINE, demandee) : undefined;
const delai = Number(process.env.ESSAIM_FIXTURE_DELAI_MS ?? 0);
const code = Number(process.env.ESSAIM_FIXTURE_CODE ?? 0);

const emettre = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Les extensions de la ligne de commande (-e), chargées dans l'ordre comme pi ; le second argument (ouvrirBun) n'est lu
// que par outils-essaim.ts, qui sans lui ouvrirait node:sqlite.
const argv = process.argv.slice(2);
const tiret = argv.indexOf("--");
const options = tiret < 0 ? argv : argv.slice(0, tiret);
const messages = tiret < 0 ? [] : argv.slice(tiret + 1);
const ext = fauxPi();
for (let i = 0; i < options.length; i++)
  if (options[i] === "-e" && options[i + 1]) (await import(resolve(options[++i]!))).default(ext.api, ouvrirBun);
const option = (nom: string) => { const i = options.indexOf(nom); return i < 0 ? undefined : options[i + 1]; };

emettre({ type: "session", version: 3, id: option("--session-id") ?? "faux", timestamp: new Date().toISOString(), cwd: process.cwd() });
const aEmettre: unknown[] = [];
for (const m of messages) {
  const commande = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(m);
  if (commande && ext.aCommande(commande[1]!)) {
    const vus = ext.compacts.length;
    let finie = false;
    const p = Promise.resolve(ext.commande(commande[1]!, commande[2] ?? "")).finally(() => { finie = true; });
    for (let i = vus; !finie; await dormir(1))
      while (i < ext.compacts.length) {
        const c = ext.compacts[i++]!;
        await dormir(Number(process.env.ESSAIM_FAUX_COMPACTAGE_MS ?? 0));
        c.onComplete?.({});
      }
    await p;
    continue;
  }
  const texte = await ext.saisir(m);
  if (texte !== undefined) aEmettre.push({ type: "message_end", message: { role: "user", content: [{ type: "text", text: texte }], timestamp: Date.now() } });
}
if (process.env.ESSAIM_FAUX_ARRET_ENTETE === "1" || process.env.ESSAIM_FAUX_ARRET_ENTETE_PASSE === String(passe)) {
  await new Promise((r) => process.stdout.write("", r)); // l'en-tête sort avant la mort
  process.exit(code);
}
for (const ev of aEmettre) emettre(ev);
if (!fixture) {
  console.error("faux pi : ESSAIM_FIXTURE manquant");
  process.exit(2);
}

const emis = new Set<string>();
const echapper = (x: string) => JSON.stringify(x).slice(1, -1);
const partage = process.env.ESSAIM_PARTAGE ?? "";
for (const brute of readFileSync(fixture, "utf8").split("\n")) {
  if (!brute.trim()) continue;
  const ligne = brute.replaceAll("{PARTAGE}", echapper(partage)).replaceAll("{RUN}", echapper(dirname(partage))).replaceAll("{AGENT}", echapper(agent ?? ""));
  const ev = JSON.parse(ligne) as { type: string; toolCallId?: string; toolName?: string; args?: unknown; ms?: number; chemin?: string };
  if (delai) await dormir(delai);
  if (ev.type === "faux:dormir") {
    await dormir(ev.ms ?? 0);
    continue;
  }
  if (ev.type === "faux:session") { // écrit la session de pi de l'agent, comme pi le ferait dans <run>/sessions
    if (agent && tableau) writeFileSync(join(dirname(tableau), "sessions", `faux_${agent}.jsonl`), String((ev as { contenu?: string }).contenu ?? ""));
    continue;
  }
  if (ev.type === "faux:attendre") {
    for (let i = 0; i < 250 && !existsSync(ev.chemin!); i++) await dormir(20);
    continue;
  }
  if (ev.type === "faux:lancer") { // un processus enfant laissé tourner (garde-fou de la mémoire) : ce qu'un bash aurait lancé
    Bun.spawn((ev as { commande?: string[] }).commande ?? ["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    continue;
  }
  if (ev.type === "faux:toucher") {
    writeFileSync(ev.chemin!, "");
    continue;
  }
  if (ev.type === "faux:ecrire") {
    mkdirSync(dirname(ev.chemin!), { recursive: true });
    writeFileSync(ev.chemin!, String((ev as { contenu?: string }).contenu ?? ""));
    continue;
  }
  // write et edit passent d'abord par les gestionnaires tool_call des extensions, comme dans pi (agent-loop.js :
  // tool_execution_start, puis beforeToolCall) : un block rend l'appel en erreur, sans rien écrire, et la fin donnée
  // par la fixture pour cet appel n'est pas émise (le refus du rôle, vu de bout en bout).
  if (ev.type === "tool_execution_start" && (ev.toolName === "write" || ev.toolName === "edit")) {
    const r = await ext.emettre("tool_call", { type: "tool_call", toolName: ev.toolName, toolCallId: ev.toolCallId, input: ev.args ?? {} }) as { block?: boolean; reason?: string } | undefined;
    if (r?.block) {
      emettre(ev);
      emis.add(String(ev.toolCallId));
      emettre({ type: "tool_execution_end", toolCallId: ev.toolCallId, toolName: ev.toolName, result: { content: [{ type: "text", text: r.reason || "Tool execution was blocked" }] }, isError: true });
      continue;
    }
  }
  if (ev.type === "tool_execution_start" && ev.toolName === "write") { // l'outil write de pi : le fichier est sur disque avant la fin
    const a = ev.args as { path: string; content: string };
    const chemin = resolve(process.cwd(), a.path);
    mkdirSync(dirname(chemin), { recursive: true });
    writeFileSync(chemin, a.content);
  }
  if (ev.type === "tool_execution_start" && ev.toolName && !(OUTILS_PI as readonly string[]).includes(ev.toolName)
    && ext.noms().includes(ev.toolName)) {
    emettre(ev);
    let result: unknown, isError = false;
    try {
      result = await ext.appeler(ev.toolName, ev.args ?? {}, { id: String(ev.toolCallId) });
    } catch (e) {
      result = { content: [{ type: "text", text: String((e as Error).message ?? e) }] };
      isError = true;
    }
    emis.add(String(ev.toolCallId));
    emettre({ type: "tool_execution_end", toolCallId: ev.toolCallId, toolName: ev.toolName, result, isError });
    continue;
  }
  if (ev.type === "tool_execution_end" && emis.has(String(ev.toolCallId))) continue;
  emettre(ev);
}
process.exitCode = code;
