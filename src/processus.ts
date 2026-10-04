// Un processus pi (ou le faux pi désigné par ESSAIM_PI) : sa ligne de commande,
// absolue de bout en bout parce que son répertoire de travail est le bureau de
// l'agent ; son lancement dans son propre groupe de processus ; son arrêt par
// groupe, pour atteindre aussi les bash qu'il aurait lancés.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DROITS, type Role } from "./roles.ts";

export type ParamsAgent = {
  nom: string; runDir: string; bureau: string; modele: string; reflexion: string; livrable?: string;
  mission: string; consignes: string; passe: number; sansBacASable: boolean;
  compactage?: number[]; // seuils de se-resumer (avis, avertissement, coupure) ; absent : extension non chargée
  resumer?: { note?: string }; // relance de résumé : /se-resumer <note> au début du lancement, puis la reprise
  reveil?: Reveil; // sortie de veille : ce qu'on lui dit en reprenant, à la place de « continue »
  reprise?: string; // après une pause ou une veille de la machine : ce qu'on lui dit en reprenant, à la place de « continue »
  memoire?: boolean; // false : run témoin (--memoire non), ESSAIM_MEMOIRE=non pour l'extension
  outilMaxMin?: number; // la coupure du lanceur (« outil bloqué ») : l'extension borne bash en dessous (ESSAIM_OUTIL_MAX_MIN)
  moment?: Moment; // second cerveau : la relance, passée à pi par ESSAIM_RELANCE ; absent au premier lancement
  role?: string; suppleantDe?: string; // rôles des agents : ESSAIM_ROLE et ESSAIM_SUPPLEANT_DE ; absents sans ## Type
  bac?: OptionsBac; // le bac à sable du rôle (bacDuRole) ; absent sans ## Type : le profil commun, comme avant
  etatSalle?: string; // le tableau de bord de celui qui répartit, ajouté à son message de réveil ou de reprise
};

// Les relances du lanceur : l'extension ajoute l'état de la salle au premier message d'une
// relance, jamais d'un premier lancement. « continue » : passe suivante, et relance après une erreur du fournisseur.
// « succession » (rôles) : le premier lancement d'un nouvel occupant d'un siège, qui reçoit l'état du siège.
export type Moment = "reveil" | "resume" | "pause" | "veille" | "reparee" | "images" | "passagere" | "emballee" | "continue" | "succession";

// La reprise qui suit /se-resumer : le résumé se fait au début d'un lancement, jamais pendant une réponse.
export const REPRISE = "Ton contexte vient d'être résumé. Reprends ton travail.";

// La reprise d'un dormeur : il a fermé son tour avec `dormir`, le lanceur a attendu qu'un message le
// nomme, et le relance là-dessus. Fils de concentration : ou qu'un autre écrive dans son fil, s'il a demandé
// reveil_fil (parFil) ; le message est livré ici tel quel et noté livré, `boite` ne le répète pas. fil : le fil où
// il est encore.
export type Reveil = { par: string; texte: string; fil?: string; parFil?: boolean; ticket?: number };
// Run à rôles : un ticket confié réveille ; le texte de l'appel est alors « ticket #N confié à toi par X : titre ».
export const messageReveil = (r: Reveil) =>
  `Tu étais en veille. ${r.ticket !== undefined ? r.texte.replace(/^ticket (#\d+ confié à toi par .+?) : ([\s\S]*)$/, "Ticket $1 : « $2 ».") : `${r.par} ${r.parFil ? `a écrit dans ${r.fil}` : "t'a nommé"} : « ${r.texte} ».`}${r.fil ? ` Tu es encore dans le fil ${r.fil}.` : ""} Pendant ce temps, ta boîte et le dossier partagé ont pu changer.`;

// La reprise après une pause demandée depuis la vue : le processus a été arrêté entre deux actions, la
// session garde tout ce qui était fini ; la réponse en cours d'écriture, elle, est perdue.
export const REPRISE_PAUSE = "Le run a été mis en pause, puis repris. Ta dernière réponse a pu être coupée. Pendant ce temps, ta boîte et le dossier partagé ont pu changer.";
// La reprise après une veille de la machine : la connexion au fournisseur est morte pendant la veille.
export const REPRISE_VEILLE = "L'ordinateur qui fait tourner la salle s'est mis en veille et ta dernière réponse a été coupée. Pendant ce temps, ta boîte et le dossier partagé ont pu changer.";
// La reprise après une mémoire réparée : un appel d'outil sans nom ni numéro a été complété dans la session.
export const REPRISE_REPAREE = "Ta dernière réponse contenait un appel d'outil sans nom, que le fournisseur refusait : il a été marqué « outil_inconnu » dans ta mémoire. Appelle les outils par leur nom exact, et reprends là où tu en étais.";

// La reprise après une mémoire allégée de ses images : le fournisseur refusait d'en recevoir autant.
export const REPRISE_IMAGES = "Le fournisseur refusait ta mémoire : elle contenait trop d'images, ou une image de plus de 30 Mo (captures et pages lues). Elles en ont été retirées, chacune remplacée par une ligne qui le dit. Relis seulement l'image dont tu as besoin, une ou deux à la fois, à une résolution qui reste sous 30 Mo, et reprends là où tu en étais.";

// La reprise après une erreur passagère du fournisseur : délai dépassé ou surcharge, la réponse n'est pas arrivée.
export const REPRISE_PASSAGERE = "Le fournisseur du modèle n'a pas répondu à temps (surcharge passagère) : ta dernière réponse n'est pas arrivée. Reprends là où tu en étais.";

// La reprise après une réponse emballée : le lanceur l'a coupée, rien de ce qu'elle contenait n'est gardé.
export const repriseEmballee = (raison: string) =>
  `Ta dernière réponse s'est emballée (${raison}) et le lanceur l'a coupée : rien de ce qu'elle contenait n'a été gardé. Ne répète pas la même action : regarde où tu en es (salle_lire, dossier partagé) et reprends autrement.`;

const RACINE = resolve(import.meta.dir, "..");
export const binairePi = () => (process.env.ESSAIM_PI ? resolve(process.env.ESSAIM_PI) : "pi");

// Une commande enveloppée dans le bac à sable de l'essaim (écriture limitée au run) : pour pi, et pour la
// commande de vérification de la mission que le lanceur lance en fin de run.
// Avec des rôles : o donne le profil du rôle et le bureau privé du gardien à fermer ; sans o, la ligne d'avant.
export type OptionsBac = { profil: "produit" | "controle"; prive: string; specPlan?: boolean };
// authPiOuvert : un pi qui garde son propre jeton (Codex) lit ~/.pi/agent/auth.json ; sinon il est fermé (AUTH_PI).
export function bacASable(runDir: string, commande: string[], o?: OptionsBac, authPiOuvert = false): string[] {
  const src = join(RACINE, "src");
  const profil = join(src, o?.profil === "controle" ? "bac-a-sable-controle.sb" : "bac-a-sable.sb");
  // La spec puis le plan : le chef, au profil des contrôleurs, écrit SPEC.md et PLAN.md, et eux seuls, dans partage/.
  const specPlan = (f: string) => o?.specPlan ? join(resolve(runDir), "partage", f) : SANS_PRIVE;
  const roles = o ? ["-D", `PRIVE=${o.prive}`, ...(o.profil === "controle" ? ["-D", `PROFILS=${src}`, "-D", `SPEC=${specPlan("SPEC.md")}`, "-D", `PLANF=${specPlan("PLAN.md")}`] : [])] : [];
  // ESSAIM_ISOLER=1 : le run ne lit ni les autres runs, ni les juges, ni les missions, ni les notes personnelles
  // (bac-a-sable.sb, ISOLE). Au choix, run par run.
  const isole = process.env.ESSAIM_ISOLER === "1" ? ["-D", "ISOLE=1"] : [];
  const auth = authPiOuvert ? SANS_PRIVE : join(homedir(), ".pi", "agent", "auth.json");
  return ["sandbox-exec", "-f", profil, "-D", `PROJET=${resolve(runDir)}`, "-D", `HOME=${homedir()}`, "-D", `AUTH_PI=${auth}`, ...roles, ...isole, ...commande];
}

// Un chemin qui n'existe pas et que personne ne peut créer (/var/empty appartient à root) : le PRIVE du gardien lui-même,
// qui lit son propre bureau privé, et de tous dans un run sans gardien.
export const SANS_PRIVE = "/var/empty/essaim-sans-prive";

// Le bac à sable d'un siège : le profil suit DROITS[role].ecritProduit (source unique des refus) ; le bureau privé
// du gardien est fermé à tous les autres.
export function bacDuRole(runDir: string, role: Role, nom: string, gardien?: string): OptionsBac {
  return { profil: DROITS[role].ecritProduit ? "produit" : "controle", prive: gardien && gardien !== nom ? join(resolve(runDir), "agents", gardien, "prive") : SANS_PRIVE, ...(role === "chef" ? { specPlan: true } : {}) };
}

const avecEtat = (message: string, etat?: string) => (etat ? `${message}\n\n${etat}` : message);

// commande = "sandbox-exec", ou le binaire pi quand sansBacASable
export function argumentsPi(p: ParamsAgent): { commande: string; args: string[] } {
  const runDir = resolve(p.runDir);
  const pi = [
    "--mode", "json", "-p", "--no-skills", "--no-extensions", "--no-context-files",
    "--session-dir", join(runDir, "sessions"), "--session-id", p.nom,
    "-e", join(RACINE, "src", "outils-essaim.ts"),
    ...(p.compactage ? ["-e", join(RACINE, "src", "se-resumer.ts")] : []),
    "--model", p.modele, "--thinking", p.reflexion,
    "--append-system-prompt", p.consignes,
    "--", ...(p.resumer
      ? [`/se-resumer ${p.resumer.note ?? ""}`.trim(), avecEtat(p.reveil ? messageReveil(p.reveil) : REPRISE, p.etatSalle)]
      : [avecEtat(p.reveil ? messageReveil(p.reveil) : p.reprise ?? (p.passe > 1 ? "continue" : p.mission), p.etatSalle)]),
  ];
  if (p.sansBacASable) return { commande: binairePi(), args: pi };
  const [commande, ...args] = bacASable(runDir, [binairePi(), ...pi], p.bac, !piIsole(p.modele));
  return { commande: commande!, args };
}

export type Fermeture = { code: number | null; signal: string | null; stderr: string };

// Git dans la salle : les agents lisent le dépôt du run, n'écrivent jamais dedans (le bac à sable ferme .git)
// et ne poussent rien. Ni la configuration git du compte (aide d'identification, trousseau), ni jeton GitHub, ni agent
// SSH ; une lecture ne prend jamais de verrou. Le bac à sable refuse en plus la lecture de ~/.ssh et ~/.config/gh.
// L'environnement d'un agent est une liste blanche : celui du lanceur porte des clés (OPENAI_API_KEY, OPENROUTER_API_KEY
// personnelle, jeton de Claude Code…), et HTTPS est ouvert. La seule clé que pi reçoit est celle réservée à l'essaim, par configPi.
const GARDEES = /^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TERM|COLORTERM|TZ|LANG|LANGUAGE|LC_[A-Z]+|NO_COLOR|FORCE_COLOR|PLAYWRIGHT_BROWSERS_PATH|BUN_INSTALL|ESSAIM_[A-Z0-9_]+)$/;
export function envSansIdentifiants(runDir: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => GARDEES.test(k))), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0", GIT_ASKPASS: "/usr/bin/false", SSH_ASKPASS: "/usr/bin/false", GH_TOKEN: "", GITHUB_TOKEN: "", GH_CONFIG_DIR: join(resolve(runDir), "gh"), GH_PROMPT_DISABLED: "1" };
  delete env.SSH_AUTH_SOCK;
  return env;
}

// La clé OpenRouter réservée à l'essaim : créée avec une limite de dépense, dans un fichier que le bac
// à sable ferme aux agents (~/.config). Jamais la clé personnelle de ~/.pi/agent/auth.json.
export const fichierCle = () => process.env.ESSAIM_CLE_OPENROUTER ?? join(homedir(), ".config", "essaim", "openrouter.key");
export function cleEssaim(): string | undefined {
  try { return readFileSync(fichierCle(), "utf8").trim() || undefined; } catch { return undefined; }
}
export function exigerCle(modele: string): void {
  if (modele.startsWith("openrouter/") && !cleEssaim())
    throw new Error(`pas de clé OpenRouter réservée à l'essaim : crée-la sur openrouter.ai/settings/keys avec une limite de dépense, puis écris-la seule dans ${fichierCle()}`);
}
// Un modèle dont pi garde le jeton lui-même (abonnement Codex) : pi le renouvelle dans son auth.json, que des copies par agent
// invalideraient l'une l'autre. Pour ceux-là, le dossier de pi reste celui du compte, auth.json lisible (noté au rapport).
export const piIsole = (modele: string) => modele.startsWith("openrouter/") || modele.startsWith("faux/");
// Le dossier de pi d'un agent, refait à chaque lancement (un agent qui y changerait les prix n'agit sur aucun pi vivant) :
// les modèles et leurs prix copiés, un auth.json vide ; la clé réservée passe par OPENROUTER_API_KEY.
export function configPi(runDir: string, nom: string, modele: string, source = join(homedir(), ".pi", "agent")): Record<string, string> {
  if (!piIsole(modele)) return {};
  const dossier = join(resolve(runDir), "pi-config", nom);
  mkdirSync(dossier, { recursive: true });
  for (const f of ["models.json", "models-store.json"]) { try { copyFileSync(join(source, f), join(dossier, f)); } catch { /* absent */ } }
  writeFileSync(join(dossier, "auth.json"), "{}", { mode: 0o600 });
  const cle = modele.startsWith("openrouter/") ? cleEssaim() : undefined;
  return { PI_CODING_AGENT_DIR: dossier, ...(cle ? { OPENROUTER_API_KEY: cle } : {}) };
}

export function lancerPi(p: ParamsAgent): { pid: number; lignes: AsyncIterable<string>; fermeture: Promise<Fermeture> } {
  const runDir = resolve(p.runDir);
  const bureau = resolve(p.bureau);
  const { commande, args } = argumentsPi(p);
  const proc = Bun.spawn([commande, ...args], {
    cwd: bureau,
    stdin: "ignore", // pi -p attend sur stdin tant qu'elle est ouverte
    stdout: "pipe",
    stderr: "pipe",
    detached: true, // son propre groupe : process.kill(-pid) atteint ses descendants, sauf les bash de pi, lancés chacun dans leur groupe : pi les tue au SIGTERM, et après un SIGKILL c'est le ramassage (tuerRestes) qui les prend
    env: { ...envSansIdentifiants(runDir), ...configPi(runDir, p.nom, p.modele), ESSAIM_AGENT: p.nom, ESSAIM_BUREAU: bureau, ESSAIM_TABLEAU: join(runDir, "tableau.sqlite"), ESSAIM_PARTAGE: join(runDir, "partage"), ESSAIM_DEPOT: RACINE, ...(p.livrable ? { ESSAIM_LIVRABLE: p.livrable } : {}), ...(p.compactage ? { ESSAIM_COMPACTAGE: p.compactage.join(",") } : {}), ...(p.memoire === false ? { ESSAIM_MEMOIRE: "non" } : {}), ...(p.moment ? { ESSAIM_RELANCE: p.moment } : {}), ...(p.outilMaxMin ? { ESSAIM_OUTIL_MAX_MIN: String(p.outilMaxMin) } : {}), ...(p.role ? { ESSAIM_ROLE: p.role } : {}), ...(p.suppleantDe ? { ESSAIM_SUPPLEANT_DE: p.suppleantDe } : {}), ...(p.role === "gardien" ? { ESSAIM_PRIVE: join(bureau, "prive") } : {}) }, // ESSAIM_DEPOT : missions/exemples/ et playwright-core ; ESSAIM_LIVRABLE : l'outil fini le regarde avant de laisser partir
  });
  const stderr = new Response(proc.stderr).text();
  const fermeture = (async (): Promise<Fermeture> => {
    await proc.exited;
    const signal = proc.signalCode ?? null;
    return { code: signal ? null : proc.exitCode, signal, stderr: await stderr };
  })();
  return { pid: proc.pid, lignes: lignesDe(proc.stdout), fermeture };
}

async function* lignesDe(flux: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const decodeur = new TextDecoder();
  let tampon = "";
  for await (const morceau of flux) {
    tampon += decodeur.decode(morceau, { stream: true });
    let i: number;
    while ((i = tampon.indexOf("\n")) >= 0) {
      yield tampon.slice(0, i);
      tampon = tampon.slice(i + 1);
    }
  }
  tampon += decodeur.decode();
  if (tampon) yield tampon;
}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

// SIGTERM au groupe (-pid), puis SIGKILL après delaiMs si quelqu'un du groupe vit encore : le meneur mort au SIGTERM
// ne dit rien de ses membres (un enfant qui ignore SIGTERM survit).
export async function tuerGroupe(pid: number, delaiMs = 5000): Promise<void> {
  const vivant = () => { try { process.kill(-pid, 0); return true; } catch { try { process.kill(pid, 0); return true; } catch { return false; } } };
  const signaler = (s: NodeJS.Signals) => { try { process.kill(-pid, s); } catch { try { process.kill(pid, s); } catch { /* déjà parti */ } } };
  if (!vivant()) return;
  signaler("SIGTERM");
  const fin = Date.now() + delaiMs;
  while (vivant() && Date.now() < fin) await dormir(50);
  if (vivant()) signaler("SIGKILL");
}

// Les processus que les agents laissent derrière eux : pi coupe lui-même une commande trop longue
// (un `bun test` qui boucle) et rend la main à l'agent, mais le processus, lui, continue ; quand pi ferme, il
// est réparenté à 1 et tourne jusqu'au redémarrage de la machine. On les reconnaît sans jamais se tromper de cible :
// leur répertoire courant est dans le dossier du run, et personne ne les attend plus (parent 1).
export type Reste = { pid: number; commande: string };

export async function restesDuRun(runDir: string): Promise<Reste[]> {
  const sortie = async (cmd: string[]) => {
    const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
    const texte = await new Response(p.stdout).text();
    await p.exited;
    return texte;
  };
  try {
    const pids = (await sortie(["lsof", "-a", "-d", "cwd", "-t", "+D", resolve(runDir)])).split("\n").map((l) => Number(l.trim())).filter((n) => n > 1 && n !== process.pid);
    if (!pids.length) return [];
    const lignes = (await sortie(["ps", "-o", "pid=,ppid=,command=", "-p", pids.join(",")])).split("\n");
    const restes: Reste[] = [];
    for (const ligne of lignes) {
      const m = ligne.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (m && m[2] === "1") restes.push({ pid: Number(m[1]), commande: m[3]!.slice(0, 120) });
    }
    return restes;
  } catch { return []; } // pas de lsof : le filet ne tient pas, le run continue
}

// SIGTERM puis SIGKILL une seconde plus tard ; rend ce qui a été tué, pour le journal. Un orphelin tué laisse ses
// enfants orphelins à leur tour : on recommence tant qu'il en reste, cinq tours au plus.
export async function tuerRestes(runDir: string): Promise<Reste[]> {
  const tues: Reste[] = [];
  const vivant = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (let tour = 0; tour < 5; tour++) {
    const restes = await restesDuRun(runDir);
    if (!restes.length) break;
    for (const r of restes) try { process.kill(r.pid, "SIGTERM"); } catch { /* déjà parti */ }
    await dormir(1000);
    for (const r of restes) if (vivant(r.pid)) try { process.kill(r.pid, "SIGKILL"); } catch { /* déjà parti */ }
    tues.push(...restes);
  }
  return tues;
}

// Le garde-fou de la mémoire : un processus lancé par un agent peut gonfler jusqu'à des dizaines de Go.
// Le bac à sable borne l'écriture, pas la mémoire. Un gourmand : un descendant d'un agent (jamais l'agent lui-
// même, pi) dont la mémoire résidente dépasse le seuil. `ps` = la sortie de `ps -Ao pid=,ppid=,rss=,command=` (rss en Ko).
export type Gourmand = { pid: number; agent: string; ko: number; commande: string };
export function gourmands(ps: string, agents: Map<number, string>, seuilKo: number): Gourmand[] {
  const procs = new Map<number, { ppid: number; ko: number; commande: string }>();
  for (const ligne of ps.split("\n")) {
    const m = ligne.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (m) procs.set(Number(m[1]), { ppid: Number(m[2]), ko: Number(m[3]), commande: m[4]!.slice(0, 120) });
  }
  const trouves: Gourmand[] = [];
  for (const [pid, p] of procs) {
    if (p.ko <= seuilKo || agents.has(pid)) continue;
    let haut = p.ppid;
    for (let i = 0; i < 64 && haut > 1 && !agents.has(haut); i++) haut = procs.get(haut)?.ppid ?? 0;
    if (agents.has(haut)) trouves.push({ pid, agent: agents.get(haut)!, ko: p.ko, commande: p.commande });
  }
  return trouves;
}

export async function listerProcessus(): Promise<string> {
  try {
    const p = Bun.spawn(["ps", "-Ao", "pid=,ppid=,rss=,command="], { stdout: "pipe", stderr: "ignore" });
    const texte = await new Response(p.stdout).text();
    await p.exited;
    return texte;
  } catch { return ""; } // pas de ps : le garde-fou ne tient pas, le run continue
}

// SIGTERM puis SIGKILL une seconde plus tard : un processus aussi gros peut ne pas répondre au premier signal.
export async function tuerGourmand(pid: number): Promise<void> {
  try { process.kill(pid, "SIGTERM"); } catch { return; }
  await dormir(1000);
  try { process.kill(pid, "SIGKILL"); } catch { /* parti */ }
}
