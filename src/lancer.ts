// Le chef de salle : ouvre un run, démarre N agents pi (ou le faux pi désigné
// par ESSAIM_PI), lit leur flux JSON, tient les compteurs en mémoire, surveille
// et coupe, relance sur la même session (passes, aussi après une erreur du
// fournisseur), puis écrit le bilan une fois
// tous les processus fermés. Les garde-fous lisent les compteurs, jamais la
// base : la base n'est qu'une trace.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import * as D from "./depot.ts";
import { analyserLigne, COMPACTAGE, Compteur } from "./flux.ts";
import { prenomLibre, repartir, type Cote } from "./prenoms.ts";
import { lireMission, phrasesNumerotees, type Mission } from "./mission.ts";
import { attribuer, avecSurveillant, changementsSiegeMax, PORTEUR_GEL, DROITS, heritier, NOMS_ROLES, porteurDuLivrable, presenterEquipe, repartiteur, ROLES, type Role, type Siege } from "./roles.ts";
import * as M from "./memoire.ts";
import { lireCatalogue, nomCourt, resoudreModele, type Modele } from "./modeles.ts";
import { bacASable, bacDuRole, envSansIdentifiants, exigerCle, lancerPi, type Moment, type Reveil, REPRISE_PAUSE, REPRISE_IMAGES, REPRISE_PASSAGERE, REPRISE_REPAREE, REPRISE_VEILLE, repriseEmballee, tuerGroupe, tuerRestes, gourmands, listerProcessus, tuerGourmand } from "./processus.ts";
import { nomsSalle, OUTILS_PI } from "./noms-outils.ts";
import * as P from "./preuves.ts";
import { servirLots } from "./resume-fil.ts";
import { lireSeuils, type Seuils } from "./se-resumer.ts";
import { fichierSession, historiqueEmpoisonne, reparerAppelsVides, retirerImages, tropDImages } from "./session.ts";
import { ouvrirBun } from "./tableau-bun.ts";
import * as S from "./surveillant.ts";
import * as T from "./tableau.ts";

export type Options = {
  agents: number; modele: string; plafond: number; mission: string; reflexion?: string;
  modeleFemmes?: string; // le second modèle : les agentes, à parts égales, arrondi aux hommes
  silenceMin?: number; outilMaxMin?: number; sansBacASable?: boolean; racine?: string;
  fichiers?: string[]; // documents d'entrée
  compactage?: Seuils | null; // se résumer : seuils avis/avertissement/coupure ; undefined = 80k/120k/160k, null = sans l'extension
  memoire?: boolean; // second cerveau : false = run témoin (--memoire non), ni état, ni ligne courte, ni salle_chercher ; faits notés
  modeleRole?: Partial<Record<Role, string>>; // rôles des agents : le modèle d'un rôle, sinon --modele ; mission avec ## Type seulement
  preparation?: boolean; // préparer la mission : les constructeurs attendent le plan contrôlé ; vrai en ligne de commande
};
export type Bilan = { finis: number; vires: number; perdus: number; depense: number; plafond: number; depassement: number; run: string; entreesModifiees?: string[]; constat?: Constat; restes?: number; endormis?: number;
  parCote?: T.CoteBilan[]; ouvreur?: Cote; // run à deux modèles seulement ; l'ouvreur est le côté du premier entré
  resumes?: { cout: number; lots: number }; // résumés de lots des fils : leur coût, compris dans depense, et les lots résumés
  commits?: { total: number; parAgent: Record<string, number>; adoptions: Record<string, number> }; // le dépôt du run
  outils?: T.ResumeOutils; // la mesure des outils : lue une fois dans la base, en fin de run
  invalidees?: ReturnType<typeof T.invalidations>; // rôles : les alertes invalidées, avec leurs deux conclusions
  reveils?: Record<string, number>; // les réveils par agent, dans l'ordre du premier réveil
  // Rôles : l'état constaté par le lanceur, et pour un run incomplet ses raisons (la première : ce qui l'a
  // arrêté) ; les exigences non satisfaites et les alertes ouvertes à la fin ; les demandes de rejeu closes sans reçu.
  etat?: "accepte" | "incomplet"; raisonsEtat?: string[]; exigencesNonSatisfaites?: EtatRun["exigences"]; alertesOuvertes?: EtatRun["alertes"]; rejeuxSansObjet?: number[];
  // Rôles : chaque changement d'occupant d'un siège, dans l'ordre ; motif : la sortie du sortant (passation,
  // ou la panne) ; note : le sortant en a laissé une ; livre : l'entrant a reçu l'état du siège dans son premier message.
  passations?: Array<{ role: Role; sortant: string; entrant: string; motif: string; note: boolean; livre: boolean }>;
  // Rôles : les leçons proposées par les agents, archivées ici ; aucun run ne les relit.
  lecons?: Array<{ agent: string; role: string | null; date: string; texte: string }>; engagements?: string[];
  // Le surveillant : les révisions demandées, leur issue et les tickets gelés, une révision ouverte
  // comprise (elle ne retient pas le run).
  revisions?: Array<{ n: number; demandeur: string; etat: string; raison: string | null; geles: number[]; closePar: string | null }>;
  // Les jalons : par exigence découpée, les jalons attestés ; un découpage validé sans contrôleur.
  jalons?: Array<{ exigence: string; attestes: number; total: number; restants: string[] }>; decoupageNonJuge?: boolean };
// Le constat de sortie : le lanceur constate le livrable principal et lance la vérification de la mission ;
// il ne note pas et ne change jamais l'état d'un agent.
export type Constat = {
  livrable?: { chemin: string; present: boolean; taille?: number; sha256?: string; detail: string };
  verification?: { commande: string; code: number | null; sortie: string; dureeMs: number; coupe?: string };
  // Une entrée par commande de la suite, dans l'ordre ; `verification` garde celle qui a fait échouer
  // (ou la dernière), pour que tout ce qui lit le constat continue de marcher.
  verifications?: Array<{ commande: string; code: number | null; sortie: string; dureeMs: number; coupe?: string }>;
};
const tronquer = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);
export type Entree = { nom: string; taille: number; sha256: string };

// Les documents d'entrée : 50 Ko par fichier (l'outil read de pi coupe là), 150 Ko par run, texte UTF-8 ou
// Markdown, fichier ordinaire, deux fichiers du même nom refusés. Vérifiés avant l'ouverture du run.
const ENTREE_MAX = 50 * 1024;
const ENTREES_MAX = 150 * 1024;
const sha256 = (octets: Uint8Array) => createHash("sha256").update(octets).digest("hex");

export function lireEntrees(fichiers: string[]): Array<Entree & { octets: Uint8Array }> {
  const entrees: Array<Entree & { octets: Uint8Array }> = [];
  let total = 0;
  for (const f of fichiers) {
    const chemin = resolve(f);
    if (!existsSync(chemin) || !statSync(chemin).isFile()) throw new Error(`entrée introuvable ou pas un fichier ordinaire : ${f}`);
    const octets = readFileSync(chemin);
    if (octets.length > ENTREE_MAX) throw new Error(`entrée trop grosse : ${f} (${octets.length} octets, 50 Ko au plus)`);
    total += octets.length;
    if (total > ENTREES_MAX) throw new Error(`entrées trop grosses ensemble : ${total} octets, 150 Ko au plus par run`);
    try {
      if (octets.includes(0)) throw new Error("octet nul");
      new TextDecoder("utf-8", { fatal: true }).decode(octets);
    } catch {
      throw new Error(`entrée qui n'est pas du texte UTF-8 : ${f}`);
    }
    const nom = basename(chemin);
    if (entrees.some((e) => e.nom === nom)) throw new Error(`deux entrées du même nom : ${nom}`);
    entrees.push({ nom, taille: octets.length, sha256: sha256(octets), octets });
  }
  return entrees;
}

// --compactage : « 80k/120k/160k » (suffixes k et M), ou « non ».
const COMPACTAGE_DEFAUT: Seuils = [80_000, 120_000, 160_000];
export function lireCompactage(brut: string): Seuils | null {
  if (brut.trim() === "non") return null;
  const valeurs = brut.split("/").map((v) => {
    const m = v.trim().match(/^(\d+(?:\.\d+)?)([kM]?)$/);
    return m ? Math.round(Number(m[1]) * (m[2] === "M" ? 1e6 : m[2] === "k" ? 1e3 : 1)) : NaN;
  });
  return lireSeuils(valeurs.join(","));
}

// --memoire : « non » seulement (run témoin) ; sans l'option, la mémoire est là.
export function lireMemoire(brut: string): false {
  if (brut === "non") return false;
  throw new Error(`--memoire n'accepte que « non » (run témoin), reçu « ${brut} »`);
}

// --modele-role ROLE=ALIAS, répétable : le modèle d'un rôle ; un rôle ne connaît aucun modèle, c'est un réglage du lancement.
export function lireModeleRole(valeurs: string[]): Partial<Record<Role, string>> {
  const r: Partial<Record<Role, string>> = {};
  for (const v of valeurs) {
    const m = v.match(/^([a-z]+)=(\S+)$/);
    if (!m || !(ROLES as string[]).includes(m[1]!)) throw new Error(`--modele-role attend ROLE=ALIAS, ROLE parmi : ${ROLES.join(", ")} ; reçu « ${v} »`);
    const role = m[1] as Role;
    if (r[role]) throw new Error(`--modele-role : deux modèles pour le rôle ${role}`);
    r[role] = m[2]!;
  }
  return r;
}

// Les deux ajouts du second cerveau à la ligne salle des consignes, retirés exactement d'un run témoin.
const CONSIGNE_CHERCHER = " ; `salle_chercher` cherche par mots dans les messages, les commits, les faits constatés et les tickets, ou lit des messages par numéro";
const CONSIGNE_ETAT = " **À chaque réveil, reprise ou résumé, la salle ajoute ce qui a changé depuis ta dernière lecture : des faits qu'elle a constatés elle-même, et des paroles d'agents citées telles quelles, marquées « déclaré par ».**";

// Rôles des agents : avec des sièges, « pas de chef » cède la place au rôle ; sans, la phrase reste telle quelle.
const CONSIGNE_SANS_CHEF = "Même mission pour tous, pas de chef.";
const CONSIGNE_ROLE = "Même mission pour tous ; ton rôle : **{ROLE}**, décrit à la fin de ces consignes.";
// Avec des rôles, les agents ne partent plus des mêmes consignes : la phrase qui le disait devient fausse.
const CONSIGNE_MEMES = "Les {N} agents partent du même modèle et des mêmes consignes : au même instant, ils pensent la même chose.";
const CONSIGNE_MEMES_ROLES = "Les {N} agents partagent ces consignes de salle, chacun avec son rôle.";
// Les veilles : dans un run à rôles, sans limite pour tous (roles.veillesSansLimite), et
// le réveil par un ticket confié ou un message qui ne s'adresse qu'à l'agent (T.appelDormeur avec rôles).
const CONSIGNE_VEILLES = "et tu reprends dès qu'un autre écrit ton nom. Cinq veilles au plus, et chaque";
const CONSIGNE_VEILLES_ROLES = "et tu reprends dès qu'un ticket t'est confié ou qu'un autre agent s'adresse à toi seul. Veilles sans limite, et chaque";
// Le réveil et les pancartes : dans un run à rôles, un message ne réveille que
// s'il s'adresse à l'agent seul (T.appelAdresse), et la pancarte d'un autre bloque write et edit (refusDuRole) ; un bash
// qui y écrit est annulé (annulerChezAutrui). Les phrases d'avant, vraies sans rôles, faisaient croire le contraire.
const CONSIGNE_REVEIL = "**Écrire le prénom de quelqu'un dans un message réveille celui qui est en veille**, ce message";
const CONSIGNE_REVEIL_ROLES = "**Un message réveille celui qui est en veille s'il s'adresse à lui seul** : son prénom en tête (« Antoine : … ») ou dans une question, sans autre nom de l'équipe ; « Antoine, Bernard : … » ne réveille personne. Ce message";
const CONSIGNE_PANCARTE = "elle n'empêche aucune écriture, sauf `depot_restaurer`.";
const CONSIGNE_PANCARTE_ROLES = "celle d'un autre refuse tes `write` et `edit` sur ce fichier, et ce qu'un `bash` y écrit est annulé, sauf chez qui régénère le livrable (l'assembleur, sinon l'intégrateur).";
// Le démarrage : sans tour de parole ni attente de la moitié de la salle dans un run à
// rôles, le paragraphe qui les annonce part des consignes.
const CONSIGNE_DEMARRAGE = "\n\nAu démarrage, chacun parle à son tour, dans l'ordre de `salle_equipe` : le tableau refuse ton premier message tant que celui qui te précède n'a rien posté, ou jusqu'à la fin d'un délai. Après ton premier message, le tableau te fait patienter jusqu'à ce que la moitié de la salle ait parlé, cinq minutes au plus.";
// La salle endormie : avec des rôles, le run n'est plus « fini » parce que tout le monde dort.
const CONSIGNE_ENDORMIE = "Quand tous ceux qui restent dorment, le run se ferme sur le livrable en l'état : une salle endormie est une salle finie.";
const CONSIGNE_ENDORMIE_ROLES = "Le lanceur constate la fin du run : accepté quand toutes les alertes sont fermées, chaque exigence attestée et la vérification de la mission passée ; incomplet sinon. Quand tous ceux qui restent dorment avec une alerte ouverte, le lanceur nomme son porteur, puis celui qui répartit les parts ; sans alerte ouverte, une salle endormie qui n'est pas acceptée est incomplète.";

// Coupure au plus 90 % de la fenêtre du modèle : au-delà, pi compacterait de lui-même avant nous et la coupure
// ne servirait jamais. Fenêtre inconnue du catalogue (faux, tarif manuel sans entrée) : rien à vérifier.
export function verifierCoupure(s: Seuils, fenetre: number | undefined): void {
  if (fenetre && s[2] > 0.9 * fenetre)
    throw new Error(`coupure de compactage trop haute : ${s[2]} tokens, au-delà de 90 % de la fenêtre du modèle (${fenetre})`);
}

const RACINE_DEPOT = resolve(import.meta.dir, "..");
const TEST = process.env.ESSAIM_TEST === "1";
const INTERVALLE_MS = TEST ? 200 : 2000;
const DEFAUTS = { silenceMin: 15, outilMaxMin: 10 };
const PASSES_MAX = 3;
// Une erreur passagère du fournisseur (il sature, l'agent n'y est pour rien) ne consomme pas de passe ;
// au-delà de cette borne par agent, la règle des passes reprend, pour ne jamais relancer sans fin.
const PASSAGERES_MAX_DEFAUT = 20;
// Une réponse emballée est coupée et l'agent relancé sans passe, trois fois au plus ; la quatrième, il est perdu.
const EMBALLEMENTS_MAX = 3;
// Un résumé bloqué est coupé et refait (1er blocage), puis refait sur une mémoire sans images (2e) ; au 3e,
// l'agent est viré.
const RESUMES_BLOQUES_MAX = 2;
// Un résumé raté (le fournisseur rend une réponse vide) se refait sans passe, la
// seconde fois sur une mémoire sans images ; au 3e de suite, la règle des passes reprend. Un résumé réussi remet à zéro.
const RESUMES_RATES_MAX = 2;
// … et six au plus sur tout le run, par agent : un résumé qui réussit sans alléger la mémoire, puis rate deux fois, en boucle,
// ne relance pas sans fin.
const RESUMES_RATES_TOTAL = 6;
// Une préparation sans plan validé est close au plus tard après ce délai hors pauses (45 min par défaut).
const preparationMaxMs = () => Number(process.env.ESSAIM_PREPARATION_MAX_MS ?? 45 * 60_000);
// « Provider returned an empty response » : le fournisseur n'a rien rendu, l'agent n'y est pour rien.
// « JSON error injected into SSE stream » : un flux du fournisseur cassé en route, passager comme les autres.
export const erreurPassagere = (erreur: string | undefined): boolean =>
  !!erreur && /timed? ?out|timeout|ETIMEDOUT|ECONNRESET|overloaded|temporarily unavailable|rate.?limit|empty response|error injected into SSE stream|\b(429|502|503|504)\b/i.test(erreur);
// La ronde part dès trois constructeurs disponibles, ou un tiers s'ils sont moins de neuf (deux au moins) ; attendre la
// moitié laissait des dormeurs sans travail.
export const seuilRonde = (constructeurs: number): number => Math.max(2, Math.min(3, Math.ceil(constructeurs / 3)));
const VERIFICATION_MS = TEST ? 2000 : 120_000; // la commande de vérification de la mission
const SOMMEIL_SONDAGE_MS = TEST ? 50 : 2000; // le lanceur regarde le tableau pour un dormeur
const PAUSE_OUTIL_MS = TEST ? 1500 : 30_000; // la pause attend la fin de l'action en cours, jusqu'à ce délai
// Un tour de surveillance en retard de plus que ça : la machine dormait (fermée, en veille).
const VEILLE_MS = Number(process.env.ESSAIM_VEILLE_MS ?? 30_000);
// Une erreur du fournisseur n'est mise sur le compte de la veille que si elle suit le réveil de près : pi perd sa
// connexion au réveil et le dit aussitôt ; une erreur une heure plus tard dans la même passe est une vraie erreur.
const ERREUR_DE_VEILLE_MS = TEST ? 1500 : 120_000;

type Etat = "fini" | "vire" | "perdu";
type Agent = { nom: string; bureau: string; modele: Modele; cote: Cote; siege?: Siege; compteur: Compteur; passe: number; coupe: boolean; pid?: number; etat?: Etat; raison?: string; resumer?: { note?: string }; dort?: boolean; reveil?: Reveil; veilleInitiale?: boolean; // en veille avant toute passe : constructeur pendant la préparation, surveillant toujours
 
  suspendu?: boolean; veille?: number; reprise?: string; // pause et veille de la machine
  moment?: Moment; // second cerveau : la relance en cours, posée avec reprise, reveil ou resumer
  arrete?: boolean; // arrêté par la pause, en attente de relance : la surveillance ne le mesure pas
  passageres?: number; // erreurs passagères du fournisseur déjà relancées sans passe
  emballe?: string; emballements?: number; // réponse emballée coupée par la surveillance, et combien de fois
  resumeBloque?: boolean; resumesBloques?: number; resumesRates?: number; resumesRatesTotal?: number; dernierResume?: { note?: string }; // résumé coupé par la surveillance, combien de fois, et sa demande
  // Rôles : la place du siège dans l'ordre d'entrée ; l'occupant d'avant et celui d'après quand le lanceur
  // a relancé le siège ; changements : combien de fois ce siège a déjà changé d'occupant.
  rangSiege?: number; remplace?: string; remplacePar?: string; changements?: number };

const vivant = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

function prendreVerrou(racine: string): () => void {
  const runs = join(racine, "runs");
  mkdirSync(runs, { recursive: true });
  const verrou = join(runs, ".verrou");
  if (existsSync(verrou)) {
    const pid = Number.parseInt(readFileSync(verrou, "utf8").trim(), 10); // « <pid> <run> », le pid seul pendant la préparation
    if (pid && vivant(pid)) throw new Error("un run est déjà en cours");
  }
  writeFileSync(verrou, String(process.pid));
  return () => { try { rmSync(verrou); } catch { /* déjà levé */ } };
}
// Le run nommé dans le verrou : la vue ne confond plus le lanceur de ce run avec celui d'un run mort avant lui.
const nommerVerrou = (racine: string, runDir: string) => writeFileSync(join(racine, "runs", ".verrou"), `${process.pid} ${basename(runDir)}`);

const horodatage = () => new Date().toISOString().slice(0, 19).replaceAll(":", "-");

// runs/<horodatage>, avec un suffixe -2, -3… si deux runs démarrent dans la même seconde
function dossierDuRun(racine: string): string {
  const base = join(racine, "runs", horodatage());
  let candidat = base;
  for (let n = 2; existsSync(candidat); n++) candidat = `${base}-${n}`;
  return candidat;
}

export async function lancer(o: Options): Promise<Bilan> {
  if (!(o.plafond > 0)) throw new Error("le plafond doit être supérieur à 0");
  if (!(o.agents >= 1)) throw new Error("il faut au moins un agent");
  // Lue avant le verrou : son type décide des sièges, et un refus ne laisse rien derrière lui.
  const mission = lireMission(resolve(o.mission));
  // Le surveillant : un siège de plus après le gabarit quand il y a un chef.
  const sieges = mission.type ? avecSurveillant(attribuer(mission.type, o.agents, { livrable: !!mission.livrable })) : undefined;
  if (sieges && o.modeleFemmes) throw new Error("avec des rôles, le modèle se choisit par rôle : --modele-role");
  if (!sieges && o.modeleRole && Object.keys(o.modeleRole).length) throw new Error("--modele-role demande une mission avec une section « ## Type »");
  const equipe = repartir(o.agents, !!o.modeleFemmes);
  const racine = resolve(o.racine ?? process.cwd());
  const entreesLues = lireEntrees(o.fichiers ?? []); // refus avant le verrou, comme le plafond
  const compactage = o.compactage === undefined ? COMPACTAGE_DEFAUT : o.compactage;
  const memoire = o.memoire !== false;
  // Les deux modèles se résolvent et se vérifient avant le verrou ; l'erreur nomme le modèle fautif.
  const catalogue = lireCatalogue();
  const resoudre = (option: string, alias: string): Modele => {
    try {
      const m = resoudreModele(alias, catalogue);
      if (compactage) verifierCoupure(compactage, m.fenetre);
      exigerCle(m.id); // jamais une clé OpenRouter personnelle
      return m;
    } catch (e) {
      throw new Error(`${option} ${alias} : ${(e as Error).message}`);
    }
  };
  const hommes = resoudre("--modele", o.modele);
  const modeles: Record<Cote, Modele> = { hommes, femmes: o.modeleFemmes ? resoudre("--modele-femmes", o.modeleFemmes) : hommes };
  // Deux modèles veut dire deux modèles différents ; comparé sur l'id, un alias et son id sont le même.
  if (o.modeleFemmes && modeles.femmes.id === hommes.id) throw new Error(`--modele et --modele-femmes désignent le même modèle (${hommes.id}) : il en faut deux différents`);
  const modelesRoles: Partial<Record<Role, Modele>> = {};
  for (const [role, alias] of Object.entries(o.modeleRole ?? {}) as Array<[Role, string]>) modelesRoles[role] = resoudre(`--modele-role ${role}`, alias);
  const libererVerrou = prendreVerrou(racine);
  try {
    const runDir = dossierDuRun(racine);
    nommerVerrou(racine, runDir);
    for (const d of ["partage", "sessions", "journal", "agents"]) mkdirSync(join(runDir, d), { recursive: true });
    // partage/ est un dépôt git dont le lanceur est le seul écrivain (le bac à sable ferme .git aux agents).
    const partage = join(runDir, "partage");
    await D.ouvrirDepot(partage);
    const entrees: Entree[] = entreesLues.map(({ octets: _, ...e }) => e);
    if (entrees.length) {
      mkdirSync(join(runDir, "entrees"), { recursive: true });
      for (const e of entreesLues) writeFileSync(join(runDir, "entrees", e.nom), e.octets);
    }
    const cheminsEntrees = entrees.map((e) => join(runDir, "entrees", e.nom));
    // {DEPOT} : une mission peut renvoyer à un fichier du dépôt (missions/exemples/) ; {ENTREES} : les documents à traiter
    const missionTexte = mission.texte.replaceAll("{DEPOT}", RACINE_DEPOT).replaceAll("{ENTREES}", cheminsEntrees.join(", "));
    const silenceMin = o.silenceMin ?? DEFAUTS.silenceMin;
    const t = ouvrirBun(join(runDir, "tableau.sqlite"));
    T.initialiser(t);
    T.lotsOrphelins(t); // aucun lot ne reste pris sans résumeur vivant (sans effet sur un tableau neuf)
    T.ouvrirRun(t, { id: relative(join(racine, "runs"), runDir), missionChemin: mission.chemin, missionTexte, modele: modeles.hommes.id, modeleFemmes: o.modeleFemmes ? modeles.femmes.id : undefined, plafondUsd: o.plafond, silenceMin, entreesJson: entrees.length ? JSON.stringify(entrees) : undefined, outils: [...OUTILS_PI, ...nomsSalle(compactage !== null, memoire, !!sieges)], memoire });
    const consignesModele = readFileSync(join(RACINE_DEPOT, "src", "consignes-salle.md"), "utf8");

    const agents: Agent[] = [];
    // Le surveillant : en plus des agents demandés ; repartir reste borné à vingt prénoms, le sien est le
    // premier libre (la relève), comme pour un siège relancé.
    const entrants = sieges && sieges.length > equipe.length
      ? [...equipe, ...sieges.slice(equipe.length).map(() => ({ nom: prenomLibre(new Set(equipe.map((e) => e.nom))), cote: "hommes" as Cote }))] : equipe;
    for (const [i, { nom, cote }] of entrants.entries()) { // Antoine, Bernard… ou, à deux modèles, Antoine, Agathe, Bernard…
      const bureau = join(runDir, "agents", nom);
      const siege = sieges?.[i]; // avec des rôles : un siège par prénom, dans l'ordre d'entrée (le chef le premier)
      // sans --modele-role surveillant, le surveillant prend le modèle du chef (un réglage de lancement, pas du rôle).
      const modele = siege ? modelesRoles[siege.role] ?? (siege.role === "surveillant" ? modelesRoles.chef : undefined) ?? hommes : modeles[cote];
      mkdirSync(bureau, { recursive: true });
      T.ajouterAgent(t, nom, bureau, modele.id, cote, siege && { role: siege.role, suppleantDe: siege.suppleantDe });
      agents.push({ nom, bureau, modele, cote, siege, rangSiege: siege ? i : undefined, compteur: new Compteur(modele.tarif, Date.now(), !!modele.abonnement), passe: 1, coupe: false });
    }
    // Rôles : le registre des preuves, que seul le lanceur écrit (le bac à sable le ferme aux agents), et le bureau
    // privé du gardien, fermé aux autres : ses cas réservés et ses variantes du monde.
    const gardien = agents.find((a) => a.siege?.role === "gardien")?.nom;
    if (sieges) mkdirSync(join(runDir, "preuves"), { recursive: true });
    if (gardien) mkdirSync(join(runDir, "agents", gardien, "prive"), { recursive: true });
    // Rôles : le chemin ## Livrable appartient à l'intégrateur, sa pancarte posée avant le premier message.
    // L'assembleur, quand il y en a un, tient le livrable à la place de l'intégrateur.
    const integrateur = agents.find((a) => a.siege?.role === "assembleur") ?? agents.find((a) => a.siege?.role === "integrateur");
    if (integrateur && mission.livrable) T.reclamer(t, integrateur.nom, mission.livrable, "le livrable (## Livrable)");
    // Rôles : dans un run avec chef, la mission découpée en phrases numérotées, sans interprétation, posée au
    // tableau et ajoutée au message du premier lancement du chef, qui les range en exigences.
    const phrases = sieges?.some((s) => s.role === "chef") ? phrasesNumerotees(missionTexte) : [];
    if (phrases.length) T.noterPhrases(t, phrases);
    const missionDuSiege = (a: Agent) => a.siege?.role !== "chef" || !phrases.length ? missionTexte
      : `${missionTexte}\n\nLes phrases de la mission, découpées et numérotées par la salle, sans interprétation :\n${phrases.map((p) => `${p.n}. [${p.section}]${T.estSectionEngagements(p.section) ? " (engagement, déjà rangé)" : ""} ${p.texte}`).join("\n")}`;

    // Le changement d'occupant d'un siège : un nouveau prénom (l'équipe, la relève, puis un prénom créé), le même siège et le même modèle,
    // un premier lancement « succession » (l'extension lui livre l'état du siège, puis la note du sortant). Rien quand le
    // siège a déjà changé autant de fois que permis ou que le plafond est atteint. L'annonce
    // dans principal dit qui tient désormais le siège. Rend le prénom de l'entrant.
    const conduites: Promise<void>[] = [];
    const relancerSiege = (a: Agent, motif: string): string | undefined => {
      if (!a.siege || (a.changements ?? 0) >= changementsSiegeMax() || depenseTotale() >= o.plafond || existsSync(join(runDir, "arret"))) return undefined;
      const nom = prenomLibre(new Set(agents.map((x) => x.nom)));
      const bureau = join(runDir, "agents", nom);
      mkdirSync(bureau, { recursive: true });
      T.ajouterAgent(t, nom, bureau, a.modele.id, a.cote, { role: a.siege.role, suppleantDe: a.siege.suppleantDe, remplace: a.nom });
      const b: Agent = { nom, bureau, modele: a.modele, cote: a.cote, siege: a.siege, rangSiege: a.rangSiege, remplace: a.nom, changements: (a.changements ?? 0) + 1,
        compteur: new Compteur(a.modele.tarif, Date.now(), !!a.modele.abonnement), passe: 1, coupe: false, moment: "succession" };
      a.remplacePar = nom;
      // Le remplaçant d'un surveillant entre en veille lui aussi, sans lancer pi avant un signe.
      if (a.siege.role === "surveillant") { T.endormir(t, nom, S.ATTENTE_SIGNE); b.veilleInitiale = true; occurrences.rearmer(); }
      agents.push(b);
      const { tickets, revoquees } = T.succeder(t, a.nom, nom, `siège repris par ${nom}`);
      const role = NOMS_ROLES[a.siege.role];
      // Pour un surveillant, l'annonce est un message de veille : signée essaim et à son nom, elle le réveillerait aussitôt,
      // avant tout signe.
      T.poster(t, "essaim", `[siège] ${nom} tient désormais le siège de ${role} ${T.deNom(a.nom)} (${motif}).`, "principal", a.siege.role === "surveillant" ? { sommeil: true } : {});
      T.ajouterEvenement(t, { agent: nom, type: "succession", resultat: `siège de ${role} repris ${T.deNom(a.nom)} (${motif})${tickets.length ? ` · tickets ${tickets.map((n) => `#${n}`).join(", ")}` : ""}${revoquees ? ` · ${revoquees} signature${revoquees > 1 ? "s" : ""} révoquée${revoquees > 1 ? "s" : ""}` : ""}` });
      conduites.push(conduireAgent(b));
      return nom;
    };
    // Le constat du run : accepté ou incomplet, posé une fois par le lanceur ; absent sans rôles.
    let constatRun: { etat: "accepte" | "incomplet"; raison: string } | undefined;
    const sortir = (a: Agent, etat: Etat, raison: string, o: { passation?: boolean } = {}) => {
      a.etat = etat;
      a.raison = raison;
      T.sortirAgent(t, a.nom, etat, raison);
      // Rôles : après une panne (viré, perdu) ou une passation, le lanceur relance d'abord le siège ; le
      // nouvel occupant reprend ses tickets, ses pancartes, et le droit de signer du sortant tombe.
      const entrant = sieges && !constatRun && (etat !== "fini" || o.passation) ? relancerSiege(a, o.passation ? "passation" : `${etat === "vire" ? "viré" : "perdu"} : ${raison}`) : undefined;
      // Rôles : sans relance, un agent viré ou perdu ne laisse aucun ticket orphelin ; ses tickets ouverts et
      // leurs pancartes vont à celui qui répartit (au suppléant nommé si c'est lui qui sort), avant que ses autres pancartes
      // ne tombent. Fini : moi_finir a déjà refusé tant qu'il portait un ticket. Le run constaté, plus rien à transférer.
      if (sieges && !entrant && (etat !== "fini" || o.passation) && !constatRun) {
        const vers = heritier(agents.map((x) => ({ nom: x.nom, role: x.siege?.role ?? null, suppleantDe: x.siege?.suppleantDe, present: !x.etat })), a.nom);
        if (vers) T.transfererTickets(t, a.nom, vers, `${etat === "vire" ? "viré" : "perdu"} : ${raison}`);
      }
      T.retirerPancartes(t, a.nom);
      T.sortirDuFil(t, a.nom, `${etat} : ${raison}`); // il quitte son fil ; seul vivant, le fil se ferme sans conclusion
      const resume = `${etat} : ${raison}`; // une ligne dans la trace : le filtre « sorties » de la vue ; viré ou perdu compte aussi comme échec
      T.ajouterEvenement(t, { agent: a.nom, type: "sortie", resultat: resume, erreur: etat === "fini" ? undefined : resume });
    };

    // La section « Les documents à traiter » ne vaut que s'il y a des entrées ; sinon elle disparaît en entier.
    const SECTION_ENTREES = /\n## Les documents à traiter\n[\s\S]*?(?=\n## |\s*$)/;
    const consignesEntrees = entrees.length ? consignesModele.replaceAll("{ENTREES}", cheminsEntrees.join(", ")) : consignesModele.replace(SECTION_ENTREES, "");
    // Sans compactage, moi_resumer n'est pas chargé : aucun agent ne lit le nom d'un outil qu'il n'a pas.
    const consignesCompactage = compactage === null ? consignesEntrees.replace(", `moi_resumer` résume ton propre contexte.", ".") : consignesEntrees;
    // Run témoin : les deux ajouts du second cerveau partent, le reste de la ligne salle reste.
    const consignesRun = memoire ? consignesCompactage : consignesCompactage.replace(CONSIGNE_CHERCHER, "").replace(CONSIGNE_ETAT, "");
    // Rôles : les consignes de la salle, le rôle à la place de « pas de chef », puis le fichier du rôle (src/roles/),
    // l'équipe entière remplie ({EQUIPE}). Sans rôles, consignesRun telles quelles.
    // L'équipe telle qu'elle est au lancement de l'agent : les occupants actuels des sièges, dans l'ordre des sièges.
    const equipeTexte = () => presenterEquipe(agents.filter((a) => a.siege && !a.remplacePar).sort((x, y) => x.rangSiege! - y.rangSiege!).map((a) => ({ ...a.siege!, nom: a.nom })));
    const consignesDuSiege = (a: Agent) => !a.siege ? consignesRun
      : consignesRun.replace(CONSIGNE_SANS_CHEF, CONSIGNE_ROLE.replace("{ROLE}", NOMS_ROLES[a.siege.role])).replace(CONSIGNE_MEMES, CONSIGNE_MEMES_ROLES).replace(CONSIGNE_VEILLES, CONSIGNE_VEILLES_ROLES).replace(CONSIGNE_ENDORMIE, CONSIGNE_ENDORMIE_ROLES)
        .replace(CONSIGNE_REVEIL, CONSIGNE_REVEIL_ROLES).replace(CONSIGNE_PANCARTE, CONSIGNE_PANCARTE_ROLES).replace(CONSIGNE_DEMARRAGE, "")
        + readFileSync(join(RACINE_DEPOT, "src", "roles", `${a.siege.role}.md`), "utf8").replaceAll("{EQUIPE}", equipeTexte());
    // La pause : un fichier « pause » dans le dossier du run, posé et retiré depuis la vue. Tant qu'il est là,
    // aucun agent ne tourne : on peut fermer la machine sans rien casser ni rien payer.
    const sondageMs = Number(process.env.ESSAIM_SONDAGE_MS ?? SOMMEIL_SONDAGE_MS); // lu ici : un test le ralentit
    const fichierPause = join(runDir, "pause");
    const enPause = () => existsSync(fichierPause);
    let pauseDepuis: number | undefined; // posé par la surveillance quand elle voit la pause
    // Pilotage de la salle : l'heure de la dernière ronde, décalée par la reprise et la veille de la machine.
    let derniereRonde = Date.now();
    let derniereEvaluation = 0;
    // Tracée par le premier qui voit la pause levée : l'agent relancé peut finir avant le tour de surveillance suivant.
    // La reprise remet les horloges des agents arrêtés à zéro, ici et pas seulement quand chacun le remarque : la
    // surveillance voit souvent la pause levée avant eux, et mesurerait sinon le silence depuis la mise en pause.
    let pauseMur: number | undefined; // l'heure murale de la mise en pause, pour dire sa vraie durée
    const noterReprise = () => {
      if (pauseDepuis === undefined || enPause()) return;
      for (const a of agents) if (a.arrete && !a.etat) a.compteur.reprendre();
      T.ajouterEvenement(t, { agent: "lanceur", type: "reprise", resultat: `run repris après ${Math.max(1, Math.round((Date.now() - (pauseMur ?? pauseDepuis)) / 60_000))} min de pause` });
      pauseDepuis = undefined;
      pauseMur = undefined;
      derniereRonde = Date.now(); // pilotage : pas de ronde dès la reprise ; le sommeil se compte hors pause (T.dureeHorsPause)
    };
    const attendreFinPause = async (a: Agent) => {
      while (enPause() && !a.coupe && !a.etat) await dormir(sondageMs);
      noterReprise();
      a.compteur.reprendre(); // le temps de la pause ne compte pas comme silence
      a.arrete = false;
    };
    const conduireAgent = async (a: Agent) => {
      const consignes = consignesDuSiege(a).replaceAll("{NOM}", a.nom).replaceAll("{N}", String(o.agents)).replaceAll("{PARTAGE}", join(runDir, "partage"));
      if (a.veilleInitiale) { a.veilleInitiale = false; if (await veiller(a)) return; } // préparation, surveillant : réveillé par un ticket ou un message à lui seul
      while (!a.coupe) {
        if (enPause() || a.arrete) await attendreFinPause(a); // levée entre-temps : on remet quand même ses horloges
        if (a.coupe || a.etat) return;
        const fin = await unePasse(a, consignes);
        if (fin) return;
      }
    };

    // La veille elle-même : le lanceur regarde le tableau toutes les 2 s pour le compte du dormeur, sans rien
    // consommer. Il rend le message qui l'a nommé (ou, avec reveil_fil, écrit dans son fil), ou rien du
    // tout si la salle a été fermée entre-temps.
    const attendreReveil = async (a: Agent): Promise<ReturnType<typeof T.appelDormeur>> => {
      a.dort = true;
      try {
        for (;;) {
          if (a.coupe || a.etat) return undefined;
          if (enPause()) { await dormir(sondageMs); continue; } // personne ne se réveille pendant la pause
          const appel = T.appelDormeur(t, a.nom, T.alias(t, a.nom), !!sieges);
          if (appel) return appel;
          await dormir(sondageMs);
        }
      } finally {
        a.dort = false;
      }
    };

    // Un commit par fin d'outil qui écrit, au nom de l'agent, dans la file du lanceur (une opération git à la fois,
    // asynchrone : la surveillance continue de tourner). Un fichier qu'un write ou un edit est en train d'écrire reste
    // hors des commits de bash jusqu'à son propre commit : il part sous le nom de celui qui l'a écrit.
    const fileGit = new D.FileGit();
    const surs = new Map<string, number>([[partage, D.identite(partage)!]]); // les dépôts que le lanceur a ouverts, et l'inode de leur .git
    const enCours = new Set<string>();
    const perdus = new Set<string>();
    // Les demandes des agents (restaurer, essai, adopter) passent par la même file : un seul écrivain.
    const arreterDemandes = D.servirDemandes(t, runDir, fileGit, surs, TEST ? 50 : 250, (d, r) => {
      if (r.ok && r.hash) T.ajouterEvenement(t, { agent: d.agent, type: "commit", resultat: `${r.hash} ${d.action} ${String(d.args.nom ?? d.args.chemin ?? "")}`.trim() });
    });
    const erreurDepot = (resultat: string, e: unknown) => T.ajouterEvenement(t, { agent: "lanceur", type: "depot", resultat, erreur: String((e as Error)?.message ?? e).slice(0, 500) });
    // Un .git disparu ou remplacé n'est jamais recréé ni suivi : on le dit, une fois, et on n'y commite plus.
    const depotSur = (racine: string): boolean => {
      const ino = surs.get(racine);
      if (ino !== undefined && D.identite(racine) === ino) return true;
      if (ino !== undefined && !perdus.has(racine)) {
        perdus.add(racine);
        erreurDepot(`dépôt ${relative(runDir, racine)} disparu ou remplacé : plus aucun commit n'y sera fait`, ".git changé");
      }
      return false;
    };
    const ecriture = (a: Agent, outil: string, args: Record<string, unknown> | undefined) => {
      if (outil !== "write" && outil !== "edit") return undefined;
      const c = D.cible(runDir, a.bureau, String(args?.path ?? ""));
      return c ? join(c.racine, c.rel) : undefined;
    };
    // Les outils qui écrivent (bash, write, edit) de chaque agent, de leur début jusqu'à la fin de leur
    // commit dans la file ; un outil commencé sans fin (processus mort) est retiré à la fin de la passe.
    const outilsOuverts = new Map<string, Set<string>>();
    const ouvrirOutil = (a: Agent, appelId: string, outil: string) => {
      if (outil !== "bash" && outil !== "write" && outil !== "edit") return;
      if (!outilsOuverts.has(a.nom)) outilsOuverts.set(a.nom, new Set());
      outilsOuverts.get(a.nom)!.add(appelId);
    };
    const fermerOutil = (a: Agent, appelId: string) => outilsOuverts.get(a.nom)?.delete(appelId);
    const commencerEcriture = (a: Agent, outil: string, args: Record<string, unknown> | undefined) => {
      const f = ecriture(a, outil, args);
      if (f) enCours.add(f);
    };
    // Dans un run à rôles, les pancartes font foi (le crochet de l'extension refuse write et edit sur la
    // pancarte d'un autre) ; un bash, lui, écrit ce qu'il veut, et deux agents s'écraseraient l'un l'autre. Avant de commiter un
    // bash de X, chaque fichier changé du dossier partagé qui porte la pancarte d'un autre agent Y encore dans la salle est
    // remis à son dernier état commité (retiré s'il est nouveau) au lieu de partir sous le nom de X ; X l'apprend par un
    // fait (sa ligne courte), la vue par un événement. Exception : Y a lui-même un bash, un write ou un edit ouvert (pas
    // encore commité). Le changement est peut-être le sien : on n'y touche pas, et il reste hors du commit de X pour que
    // le commit de Y le prenne sous son nom, plutôt que de défaire le travail du porteur. Sans rôles, les pancartes
    // restent consultatives (fichier_reclamer) : rien ne change. sauf : les fichiers qu'un write ou un edit est en train
    // d'écrire, jamais touchés ici. Rend les fichiers laissés au porteur occupé, à tenir hors du commit de X.
    // L'intégrateur n'y est pas soumis : il assemble et régénère le livrable, dont des sorties du programme sous les
    // pancartes des autres. Ses bash sont commités à son nom, où qu'ils écrivent : rien ne distingue une sortie
    // régénérée d'une source. Ses write et edit, eux, restent refusés sur la part d'un autre (crochet du rôle).
    const annulerChezAutrui = async (a: Agent, appelId: string, sauf: string[]): Promise<string[]> => {
      const porteurs = new Map(T.reclamations(t).map((p) => [p.chemin, p.agent]));
      const presentsNoms = new Set(agents.filter((x) => !x.etat && !x.coupe).map((x) => x.nom));
      const annules: D.Annule[] = [], laisses: string[] = [];
      // Le livrable reste à l'intégrateur présent, quelle que soit sa pancarte (un ticket ou une clôture a pu
      // la passer à un autre) : sinon des corrections écrites par bash dans le livrable seraient effacées par
      // le réassemblage suivant.
      const integ = porteurDuLivrable(agents.filter((x) => !x.etat && !x.coupe).map((x) => ({ nom: x.nom, role: x.siege?.role ?? null })))?.nom;
      const livrable = mission.livrable ? T.cleChemin(T.normaliserChemin(mission.livrable)) : undefined;
      for (const chemin of await D.fichiersChanges(partage)) {
        const y = integ && T.cleChemin(chemin) === livrable ? integ : porteurs.get(chemin);
        // Le gel : un chemin gelé par une révision n'a pas de porteur présent, mais s'y écrire par bash s'annule aussi.
        if (!y || y === a.nom || sauf.includes(chemin) || (!presentsNoms.has(y) && y !== PORTEUR_GEL)) continue;
        if ((outilsOuverts.get(y)?.size ?? 0) > 0) { laisses.push(chemin); continue; }
        const ticket = T.listerTickets(t, { charge: y }).find((k) => k.etat !== "ferme" && T.cheminsDuTicket(k).includes(chemin));
        annules.push({ chemin, porteur: y, ...(ticket ? { ticket: ticket.id } : {}) });
      }
      if (!annules.length) return laisses;
      const depuis = await D.remettre(partage, annules.map((x) => x.chemin));
      const fait = D.faitAnnulation(a.nom, depuis, annules);
      t.transaction(() => T.noterFait(t, fait));
      T.ajouterEvenement(t, { agent: a.nom, type: "annulation", appelId, resultat: fait.texte, erreur: `écriture par bash dans le fichier d'un autre : ${annules.map((x) => `${x.chemin} (${D.aQui(x)})`).join(", ")}` });
      return laisses;
    };
    // Un commit du dossier partagé qui défait le travail récent d'un autre est dit aux deux, signé essaim (les
    // réveille). Une erreur de lecture git ne bloque pas le commit.
    const signalerDefaits = async (auteur: string, c: D.CommitFait) => {
      let liste: D.Defait[] = [];
      try { liste = await D.defaits(partage, c, auteur); } catch { return; }
      for (const d of liste) {
        const texte = `${auteur}, ${d.auteur} : le commit ${c.hash} de ${auteur} remet ${d.lignes} ligne${d.lignes > 1 ? "s" : ""} de ${d.chemin} dans leur état d'avant le commit ${d.commit} de ${d.auteur}. Si ${d.chemin} est régénéré, la correction de ${d.auteur} va dans la source qui le produit.`;
        T.poster(t, "essaim", texte);
        T.ajouterEvenement(t, { agent: auteur, type: "defait", resultat: texte });
      }
    };
    // enErreur : un write ou un edit rendu en erreur (refusé par le crochet du rôle, ou en échec) n'a rien
    // écrit ; son chemin ne se commite pas. Sinon le commit de son chemin partirait sous son nom avec ce que le
    // disque porte alors : un write refusé sur la pancarte d'un autre commiterait ce qu'un bash venait d'y écrire.
    const commiterOutil = (a: Agent, appelId: string, outil: string, args: Record<string, unknown> | undefined, enErreur = false) => {
      const f = ecriture(a, outil, args);
      if ((!f && outil !== "bash" && outil !== "page_voir" && outil !== "page_assembler") || (outil === "page_voir" && a.siege) || (f && enErreur)) { // avec des rôles, ses captures sont dans son bureau, hors du dépôt
        if (f) enCours.delete(f);
        fermerOutil(a, appelId);
        return;
      }
      void fileGit.mettre(async () => {
        try {
          // Seuls les essais que ce bash a pu toucher (D.essaisDuBash) : les parcourir tous après chaque bash
          // ralentissait la file git.
          // Le commit de fin de run ramasse le reste.
          const commande = outil === "bash" ? String(args?.command ?? "") : "";
          const essais = D.essaisDuBash([...surs.keys()].filter((r) => r !== partage), T.essais(t).filter((x) => x.auteur === a.nom).map((x) => x.dossier), commande);
          for (const e of D.aCommiter(runDir, a.bureau, outil, args, enCours, essais)) {
            if (!depotSur(e.racine)) continue;
            // Celui qui tient le livrable (l'assembleur, sinon l'intégrateur) régénère les sorties, ses bash ne sont pas annulés.
            const regenere = a.siege?.role === (agents.some((x) => x.siege?.role === "assembleur" && !x.etat && !x.coupe) ? "assembleur" : "integrateur");
            const laisses = outil === "bash" && sieges && !regenere && e.racine === partage ? await annulerChezAutrui(a, appelId, e.sauf ?? []) : [];
            const c = await D.commiter(e.racine, a.nom, e.message, { chemins: e.chemins, sauf: [...(e.sauf ?? []), ...laisses], seulEcrivain: true });
            if (!c) continue;
            T.ajouterEvenement(t, { agent: a.nom, type: "commit", appelId, resultat: `${c.hash} ${e.message}${e.racine === partage ? "" : ` (essai ${basename(e.racine)})`}` });
            t.transaction(() => T.noterFait(t, D.faitEcriture(c, a.nom, D.racineDuFait(e.racine, partage), outil)));
            if (e.racine === partage && sieges) await signalerDefaits(a.nom, c);
          }
        } catch (e) {
          erreurDepot(`commit manqué après ${outil} de ${a.nom}`, e);
        } finally {
          if (f) enCours.delete(f);
          fermerOutil(a, appelId);
        }
      });
    };

    // Second cerveau : l'état est préparé par l'extension au premier message d'une relance ; pi émet ce
    // message utilisateur (message_end) puis l'écrit dans la session : c'est là que le lanceur confirme la livraison.
    // L'en-tête de pi, émis avant tout message, ne prouve rien.
    const confirmerEtat = (agent: string, message: unknown) => {
      const m = message as { role?: string; content?: unknown } | undefined;
      if (m?.role !== "user") return;
      const texte = typeof m.content === "string" ? m.content
        : Array.isArray(m.content) ? m.content.flatMap((b: { type?: string; text?: unknown }) => (b?.type === "text" ? [String(b.text ?? "")] : [])).join("\n") : "";
      if (texte.includes(T.MARQUE_ETAT)) T.confirmerLivraison(t, agent, texte);
      if (texte.includes(M.MARQUE_SIEGE)) { // l'état du siège (et la note) est arrivé au nouvel occupant
        T.confirmerSuccession(t, agent);
        T.ajouterEvenement(t, { agent, type: "succession", resultat: `état du siège livré${T.passationPour(t, agent) ? ", puis la note du sortant" : ""}` });
      }
    };

    // La veille tenue par le lanceur : attendre le réveil, puis préparer la relance. Rend true quand l'agent est
    // sorti pendant la veille (salle endormie, arrêt), false pour relancer pi.
    const veiller = async (a: Agent): Promise<boolean> => {
      const c = a.compteur;
      const appel = await attendreReveil(a);
      if (!appel) return true; // la salle s'est endormie : le lanceur l'a déjà sorti
      T.reveiller(t, a.nom);
      // Chaque réveil repart à une passe : comptées sur tout le run, les passes faisaient sortir un agent réveillé tard
      // « passes épuisées ». La borne reste trois tours de suite sans se rendormir.
      a.passe = 1;
      c.reprendre(); // le temps de la veille ne compte pas comme silence
      // Livré tel quel dans le message de réveil, donc entier, et noté livré : il ne réveille plus et boite ne le répète pas.
      // Un ticket confié (run à rôles) n'est pas un message : rien à noter livré.
      if (!appel.ticket) t.run("INSERT OR IGNORE INTO appels_livres(agent, message_id, livre_le) VALUES (?, ?, ?)", [a.nom, appel.id, new Date().toISOString()]);
      a.reveil = { par: appel.auteur, texte: appel.texte, fil: T.filDe(t, a.nom)?.fil, parFil: appel.reveilFil, ticket: appel.ticket };
      a.moment = "reveil";
      if (compactage && c.contexte >= compactage[0]) a.resumer = { note: "tu sors d'une veille : garde le but, l'état du livrable, ce que tu as promis à la salle et ce qu'on vient de te demander" };
      T.ajouterEvenement(t, { agent: a.nom, type: "reveil", resultat: `réveillé par ${appel.auteur}${appel.reveilFil ? ` dans ${appel.fil}` : ""}${a.resumer ? ", après résumé" : ""} : ${tronquer(appel.texte, 200)}` });
      return false;
    };

    // Une passe = un processus pi sur la session de l'agent. Renvoie true quand l'agent est sorti.
    const unePasse = async (a: Agent, consignes: string): Promise<boolean> => {
      // Celui qui répartit reçoit l'état de la salle à chaque réveil et après chaque résumé.
      const rep = sieges && (a.reveil || a.resumer) ? repartiteur(agents.filter((x) => !x.etat && !x.coupe).map((x) => ({ nom: x.nom, role: x.siege?.role ?? null, suppleantDe: x.siege?.suppleantDe })))?.nom : undefined;
      // L'intégrateur reçoit à chaque lancement la file des essais pas encore adoptés, calculée par le lanceur :
      // sans elle, un successeur ne connaît pas les essais en attente.
      const file = a.siege?.role === "integrateur" ? T.fileDesEssais(t) : undefined;
      // L'âge du livrable, lu dans git (son dernier commit) ; absent tant qu'il n'a jamais été commité.
      const dernier = rep === a.nom && mission.livrable ? (await D.historique(partage, { chemin: mission.livrable, limite: 1 }).catch(() => []))[0] : undefined;
      const livrable = dernier ? { chemin: mission.livrable!, le: dernier.date } : undefined;
      const etatSalle = [rep === a.nom ? T.tableauDeBord(t, a.nom, { exigences: exigencesNonTenues(t, runDir), livrable }) : undefined, file].filter(Boolean).join("\n\n") || undefined;
      const proc = lancerPi({ etatSalle, nom: a.nom, runDir, bureau: a.bureau, modele: a.modele.id, reflexion: o.reflexion ?? a.modele.reflexion, mission: missionDuSiege(a), consignes, passe: a.passe, sansBacASable: !!o.sansBacASable, livrable: mission.livrable, compactage: compactage ?? undefined, memoire, resumer: a.resumer, reveil: a.reveil, reprise: a.reprise, moment: a.moment, outilMaxMin: o.outilMaxMin, role: a.siege?.role, suppleantDe: a.siege?.suppleantDe, bac: a.siege && bacDuRole(runDir, a.siege.role, a.siege.role === "gardien" && gardien ? gardien : a.nom, gardien) });
      a.dernierResume = a.resumer;
      a.resumer = undefined;
      a.moment = undefined;
      a.reveil = undefined;
      a.reprise = undefined;
      a.veille = undefined;
      a.compteur.nouvellePasse();
      a.pid = proc.pid;
      T.majAgent(t, a.nom, { pid: proc.pid, passes: a.passe });
      const journal = join(runDir, "journal", `${a.nom}.jsonl`);
      const c = a.compteur;
      const argsEnCours = new Map<string, { outil: string; args: Record<string, unknown> | undefined }>(); // ce que chaque outil a reçu, pour son commit
      for await (const ligne of proc.lignes) {
        appendFileSync(journal, ligne + "\n");
        const ev = analyserLigne(ligne);
        if (!ev) continue;
        const trace = c.absorber(ev);
        if (trace) T.ajouterEvenement(t, { agent: a.nom, ...trace });
        if (ev.type === "message_end") confirmerEtat(a.nom, ev.message);
        if (ev.type === "tool_execution_start") {
          const args = ev.args as Record<string, unknown> | undefined;
          argsEnCours.set(String(ev.toolCallId), { outil: String(ev.toolName), args });
          ouvrirOutil(a, String(ev.toolCallId), String(ev.toolName));
          commencerEcriture(a, String(ev.toolName), args);
        } else if (ev.type === "tool_execution_end") {
          const id = String(ev.toolCallId);
          commiterOutil(a, id, String(ev.toolName), argsEnCours.get(id)?.args, ev.isError === true);
          argsEnCours.delete(id);
        }
        T.majAgent(t, a.nom, { coutUsd: c.cout, coutEstime: c.coutEstime, tokensEntree: c.tokensEntree, tokensSortie: c.tokensSortie, appels: c.appels, echecs: c.echecs, derniereActivite: new Date(c.derniereActivite).toISOString() });
      }
      const f = await proc.fermeture;
      // Commencés sans fin, ils n'écriront plus ; leur fichier n'est plus retenu hors des commits des autres.
      for (const [id, { outil, args }] of argsEnCours) { fermerOutil(a, id); const f = ecriture(a, outil, args); if (f) enCours.delete(f); }
      a.pid = undefined;
      const suspendu = a.suspendu;
      a.suspendu = false;
      if (f.stderr.trim()) appendFileSync(join(runDir, "journal", `${a.nom}.stderr`), f.stderr);
      if (a.coupe) return true; // le lanceur l'a tué : son état est déjà écrit
      // Un résumé bloqué chez le fournisseur (emballé ou figé : pi n'a pas de borne de
      // durée totale) ne vient pas de ce qu'on lui envoie ; le même résumé relancé passe le plus souvent. On le refait sans
      // consommer de passe, la seconde fois sur une mémoire sans images (plus légère à relire après coup).
      if (a.resumeBloque && !c.finiVu) {
        a.resumeBloque = false;
        a.resumesBloques = (a.resumesBloques ?? 0) + 1;
        let allege = "";
        if (a.resumesBloques === RESUMES_BLOQUES_MAX) {
          const f = fichierSession(join(runDir, "sessions"), a.nom);
          const n = f ? retirerImages(f) : 0;
          if (n > 0) allege = `, mémoire allégée de ${n} image${n > 1 ? "s" : ""}`;
        }
        T.ajouterEvenement(t, { agent: a.nom, type: "relance", resultat: `résumé bloqué coupé (${a.resumesBloques}/${RESUMES_BLOQUES_MAX})${allege}, résumé refait sans consommer de passe` });
        c.erreur = undefined;
        c.reprendre();
        a.resumer = a.dernierResume ?? {};
        a.moment = "resume";
        return false;
      }
      if (a.emballe && !c.finiVu) { // coupé par la surveillance au milieu d'une réponse emballée
        const raison = a.emballe;
        a.emballe = undefined;
        a.emballements = (a.emballements ?? 0) + 1;
        if (a.emballements > EMBALLEMENTS_MAX) { sortir(a, "perdu", `réponse emballée ${a.emballements} fois : ${raison}`); return true; }
        T.ajouterEvenement(t, { agent: a.nom, type: "relance", resultat: `réponse emballée coupée (${a.emballements}/${EMBALLEMENTS_MAX}), relancé sans consommer de passe : ${raison}` });
        c.erreur = undefined;
        c.reprendre();
        a.reprise = repriseEmballee(raison);
        a.moment = "emballee";
        return false;
      }
      // moi_passation a fermé le tour ; le siège est relancé avec un nouvel occupant, qui reçoit la note.
      if (sieges && T.passationEnAttente(t, a.nom)) { sortir(a, "fini", "passation du siège", { passation: true }); return true; }
      if (c.finiVu) {
        const raison = t.get<{ raison_sortie: string | null }>("SELECT raison_sortie FROM agents WHERE nom = ?", [a.nom])?.raison_sortie;
        sortir(a, "fini", raison ?? "fini");
        return true;
      }
      // Le sommeil : `dormir` a fermé le tour proprement et écrit l'état en base. Le lanceur prend le
      // relais, processus fermé — rien ne tourne, rien ne se paie — et relance l'agent dès qu'un message le
      // nomme, derrière un résumé si son contexte a grossi : c'est la relecture qui fait le prix d'un réveil.
      // Un réveil ne consomme pas de passe ; le nombre de veilles est borné par l'outil lui-même.
      if (t.get<{ etat: string }>("SELECT etat FROM agents WHERE nom = ?", [a.nom])?.etat === "dormant") return veiller(a);
      // Arrêté pour la pause : ni passe consommée ni sortie. La boucle attend la fin de la pause, puis relance la même
      // session sur un mot qui dit ce qui s'est passé — ou sur la mission, si pi n'avait encore rien reçu en retour.
      if (suspendu) {
        a.arrete = true;
        if (a.passe > 1 || c.tokensEntree > 0) { a.reprise = REPRISE_PAUSE; a.moment = "pause"; }
        if (compactage && c.resumeDemande !== undefined) { a.resumer = { note: c.resumeDemande || undefined }; a.moment ??= "resume"; }
        c.erreur = undefined; // une réponse coupée par l'arrêt n'est pas une erreur du fournisseur
        c.reprendre();
        return false;
      }
      // Se résumer : le résumé se fait au début d'une relance, qui ne consomme pas de passe.
      // Un compactage en échec dans cette passe renvoie à la règle normale des passes, pour ne jamais boucler.
      // Le résumé de cette passe a raté et l'agent en a encore besoin (il le redemande, ou sa mémoire passe la coupure).
      const besoinResume = !!compactage && (c.resumeDemande !== undefined || c.contexte >= compactage[2]);
      if (compactage && c.compactageRate && besoinResume && (a.resumesRates ?? 0) < RESUMES_RATES_MAX && (a.resumesRatesTotal ?? 0) < RESUMES_RATES_TOTAL) {
        a.resumesRates = (a.resumesRates ?? 0) + 1;
        a.resumesRatesTotal = (a.resumesRatesTotal ?? 0) + 1;
        let allege = "";
        if (a.resumesRates === RESUMES_RATES_MAX) {
          const f = fichierSession(join(runDir, "sessions"), a.nom);
          const n = f ? retirerImages(f) : 0;
          if (n > 0) allege = `, mémoire allégée de ${n} image${n > 1 ? "s" : ""}`;
        }
        T.ajouterEvenement(t, { agent: a.nom, type: "relance", resultat: `résumé raté (${a.resumesRates}/${RESUMES_RATES_MAX})${allege}, résumé refait sans consommer de passe` });
        a.resumer = { note: c.resumeDemande || undefined };
        a.moment = "resume";
        return false;
      }
      if (compactage && !c.compactageRate) {
        a.resumesRates = 0; // le résumé d'avant, s'il y en a eu un, a réussi
        const force = c.resumeDemande === undefined && c.contexte >= compactage[2];
        if (c.resumeDemande !== undefined || force) {
          const k = (n: number) => `${Math.round(n / 1000)}k`;
          T.ajouterEvenement(t, force
            ? { agent: a.nom, type: "resume_force", resultat: `résumé forcé : ${k(c.contexte)} tokens, au-delà de la coupure (${k(compactage[2])})` }
            : { agent: a.nom, type: "relance", resultat: "reprise après résumé" });
          a.resumer = { note: c.resumeDemande || undefined };
          a.moment = "resume";
          return false;
        }
      }
      if (c.erreur) constaterVeille(); // l'erreur du réveil peut arriver avant le premier tour de surveillance
      if (c.erreur && a.veille !== undefined && Date.now() - a.veille < ERREUR_DE_VEILLE_MS) { // la veille de la machine a coupé la connexion : ce n'est pas la faute du fournisseur, pas de passe consommée
        T.ajouterEvenement(t, { agent: a.nom, type: "relance", resultat: `relancé après la veille de la machine, sans consommer de passe : ${c.erreur}` });
        c.erreur = undefined;
        a.reprise = REPRISE_VEILLE;
        a.moment = "veille";
        return false;
      }
      // Une mémoire empoisonnée : un appel d'outil mal formé du modèle fait refuser toute la session.
      // On la répare, puis on reprend sans consommer de passe ; si rien n'est réparable, la règle des passes joue.
      if (historiqueEmpoisonne(c.erreur)) {
        const f = fichierSession(join(runDir, "sessions"), a.nom);
        const n = f ? reparerAppelsVides(f) : 0;
        if (n > 0) {
          T.ajouterEvenement(t, { agent: a.nom, type: "relance", resultat: `mémoire réparée : ${n} appel${n > 1 ? "s" : ""} d'outil sans numéro, reprise sans perdre de passe` });
          c.erreur = undefined;
          a.reprise = REPRISE_REPAREE;
          a.moment = "reparee";
          return false;
        }
      }
      // Trop d'images dans la mémoire : même geste. Relancer sur la même session renvoyait les
      // mêmes images et coûtait une passe à chaque fois ; on les retire, puis on reprend sans consommer de passe.
      // Pas de boucle : un nouveau refus demande que l'agent ait relu des images, donc travaillé entre-temps.
      if (tropDImages(c.erreur)) {
        const f = fichierSession(join(runDir, "sessions"), a.nom);
        const n = f ? retirerImages(f) : 0;
        if (n > 0) {
          T.ajouterEvenement(t, { agent: a.nom, type: "relance", resultat: `mémoire allégée : ${n} image${n > 1 ? "s" : ""} retirée${n > 1 ? "s" : ""} (le fournisseur refusait : ${c.erreur}), reprise sans perdre de passe` });
          c.erreur = undefined;
          a.reprise = REPRISE_IMAGES;
          a.moment = "images";
          return false;
        }
      }
      const passageresMax = Number(process.env.ESSAIM_PASSAGERES_MAX ?? PASSAGERES_MAX_DEFAUT);
      if (erreurPassagere(c.erreur) && (a.passageres ?? 0) < passageresMax) {
        a.passageres = (a.passageres ?? 0) + 1;
        T.ajouterEvenement(t, { agent: a.nom, type: "relance", resultat: `relancé après une erreur passagère du fournisseur (${a.passageres}/${passageresMax}), sans consommer de passe : ${c.erreur}` });
        c.erreur = undefined;
        // Rien encore reçu du modèle au premier lancement : la mission n'a peut-être jamais été lue, on la renvoie.
        if (a.passe > 1 || c.tokensEntree > 0) { a.reprise = REPRISE_PASSAGERE; a.moment = "passagere"; }
        else if (a.remplace) a.moment = "succession"; // le premier message d'un nouvel occupant garde l'état du siège
        await dormir(TEST ? 0 : Math.min(60_000, 5_000 * a.passageres)); // laisser le fournisseur respirer, un peu plus à chaque fois
        return false;
      }
      if (c.erreur) { // le fournisseur a coupé la réponse : on reprend la même session, comme après un silence
        if (a.passe >= PASSES_MAX) { sortir(a, "perdu", c.erreur); return true; }
        T.ajouterEvenement(t, { agent: a.nom, type: "relance", resultat: `relancé après une erreur du fournisseur (passe ${a.passe + 1}/${PASSES_MAX}) : ${c.erreur}` });
        c.erreur = undefined;
        a.passe++;
        a.moment = "continue"; // une reprise sur la même session
        await dormir(TEST ? 0 : 2000);
        return false;
      }
      if (f.code !== 0) { sortir(a, "perdu", `code de sortie ${f.code ?? f.signal}`); return true; }
      // L'agent disponible : dans un run à rôles, un agent qui ne porte aucun
      // ticket ouvert et s'arrête sans moi_finir ni moi_dormir n'a pas de travail qu'il néglige : le lanceur le met en veille
      // (la même écriture que moi_dormir), sans consommer de passe et sans relève. Les passes restent pour
      // qui porte un ticket ouvert et pour les erreurs du fournisseur (plus haut).
      if (sieges && !T.listerTickets(t, { charge: a.nom }).some(T.estActif)) {
        T.insererMessage(t, a.nom, "[en sommeil] disponible", "principal", { sommeil: true });
        T.endormir(t, a.nom);
        T.ajouterEvenement(t, { agent: a.nom, type: "disponible", resultat: "tour fini sans moi_finir ni moi_dormir, aucun ticket ouvert : mis en veille, sans consommer de passe" });
        return veiller(a);
      }
      if (a.passe < PASSES_MAX) { a.passe++; a.moment = "continue"; return false; } // même session, dernier argument « continue »
      sortir(a, "perdu", "passes épuisées");
      return true;
    };

    // Surveillance : toutes les 2 s (200 ms sous ESSAIM_TEST=1), depuis les compteurs en mémoire.
    let endormis = 0; // agents que la salle endormie a fermés
    const silenceMs = silenceMin * 60_000;
    // salle entièrement endormie : le temps qu'un dernier appel réveille quelqu'un
    const graceSalleMs = Number(process.env.ESSAIM_GRACE_MS ?? (TEST ? 300 : 15_000));
    const outilMs = (o.outilMaxMin ?? DEFAUTS.outilMaxMin) * 60_000;
    // Un résumé en cours a sa propre borne, plus longue que celle des outils ; un résumé coupé est refait (unePasse).
    const resumeMs = Number(process.env.ESSAIM_RESUME_MAX_MS ?? 8 * 60_000);
    // Une réponse qui avance : penser longtemps n'est pas un silence. Le silence se compte alors depuis son dernier morceau
    // qui disait quelque chose, et une seule réponse a sa propre borne ; la boucle, elle, se reconnaît à sa forme (flux.ts).
    const reflexionMs = Number(process.env.ESSAIM_REFLEXION_MAX_MS ?? 45 * 60_000);
    const couper = (a: Agent, raison: string) => {
      if (a.etat || a.coupe || a.compteur.finiVu) return; // un agent qui a dit fini termine tranquillement
      a.coupe = true;
      sortir(a, "vire", raison);
      if (a.pid) void tuerGroupe(a.pid);
    };
    // Le sommeil : un dormeur n'a plus de processus, donc ni outil en cours ni progrès — les deux
    // garde-fous du temps le tueraient. On les lève pour lui et on les remplace par la seule borne qui reste
    // vraie : quand toute la salle dort, plus rien n'arrivera, et le run se ferme sur le livrable en l'état.
    // Le délai de grâce laisse passer le réveil de celui qu'un dernier message vient de nommer.
    let tousDormentDepuis: number | undefined;
    const fermerDormeur = (a: Agent) => {
      if (a.etat || a.coupe) return;
      a.coupe = true;
      endormis++;
      sortir(a, "fini", "salle endormie : personne ne l'a rappelé");
      if (a.pid) void tuerGroupe(a.pid);
    };
    // La machine a dormi : le tour de surveillance arrive avec des minutes de retard. Sans rien faire, tout le
    // monde serait viré pour silence au réveil ; on décale les horloges du temps de la veille, et la relance qui suit
    // la connexion coupée ne consomme pas de passe.
    let dernierTour = Date.now();
    const constaterVeille = () => {
      const maintenant = Date.now();
      const trou = maintenant - dernierTour - INTERVALLE_MS;
      dernierTour = maintenant;
      if (trou <= VEILLE_MS) return;
      for (const a of agents) {
        a.compteur.decaler(trou);
        if (!a.etat) a.veille = maintenant; // l'heure du réveil ; effacée au lancement suivant
      }
      if (tousDormentDepuis !== undefined) tousDormentDepuis += trou;
      if (pauseDepuis !== undefined) pauseDepuis += trou;
      derniereRonde += trou; // pilotage : la veille de la machine ne compte pas
      T.ajouterEvenement(t, { agent: "lanceur", type: "veille", resultat: `la machine a dormi ${Math.max(1, Math.round(trou / 60_000))} min : ce temps ne compte pas comme silence` });
    };
    // La dépense du run : les agents et les résumés de lots, depuis les compteurs en mémoire, jamais la base.
    let coutResumes = 0;
    const depenseTotale = () => agents.reduce((somme, a) => somme + a.compteur.cout, 0) + coutResumes;
    // ---- Le constat du run : seulement avec des rôles. noterConstat le pose et le trace ; constaterRun ferme
    // en plus ceux qui restent : « fini » à l'acceptation (le fichier accepte lève d'abord le refus de moi_finir du chef et
    // de l'intégrateur), « viré » quand le run est incomplet.
    const presents = () => agents.filter((a) => !a.etat && !a.coupe);
    const noterConstat = (etat: "accepte" | "incomplet", raison: string) => {
      if (!sieges || constatRun) return false;
      constatRun = { etat, raison };
      if (etat === "accepte") writeFileSync(join(runDir, "accepte"), `${new Date().toISOString()}\n`);
      T.ajouterEvenement(t, { agent: "lanceur", type: "constat", resultat: `run ${etat === "accepte" ? "accepté" : "incomplet"} : ${raison}` });
      return true;
    };
    const constaterRun = (etat: "accepte" | "incomplet", raison: string) => {
      if (!noterConstat(etat, raison)) return;
      for (const a of presents()) {
        a.coupe = true;
        sortir(a, etat === "accepte" ? "fini" : "vire", etat === "accepte" ? "run accepté, constaté par le lanceur" : `run incomplet : ${raison}`);
        if (a.pid) void tuerGroupe(a.pid);
      }
    };
    // Juger le run en cours : quand ses conditions tiennent sans la ## Vérification, le lanceur lance celle-ci, puis
    // accepte si rien n'a bougé entre-temps. Une fois par état du run (cleDuRun : faits, attestations, rangement des
    // phrases, tickets). Dans un run sans exigences (sans chef), seulement quand la salle est au repos, chacun en veille
    // (le chef et l'intégrateur aussi peuvent dormir) : sans quoi un run vide serait accepté dès son début.
    let cleEvaluee: string | undefined;
    let jugeEnCours = false;
    const cleDuRun = () => JSON.stringify(t.get(`SELECT (SELECT COALESCE(MAX(id), 0) FROM faits) AS f, (SELECT COALESCE(MAX(id), 0) FROM attestations) AS a,
      (SELECT count(*) FROM attestations WHERE revoquee_le IS NOT NULL) AS r, (SELECT MAX(range_le) FROM phrases) AS p,
      (SELECT count(*) FROM exigences WHERE retiree_le IS NOT NULL) AS x, (SELECT count(*) FROM exigences) AS j, (SELECT MAX(maj_le) FROM tickets) AS k`)); // j : un jalon créé
    const auRepos = () => presents().every((a) => a.dort);
    const substituer = (c: string) => c.replaceAll("{DEPOT}", RACINE_DEPOT).replaceAll("{ENTREES}", cheminsEntrees.join(" "));
    const essayerDeJuger = () => {
      if (!sieges || constatRun || jugeEnCours) return;
      if (!T.phrases(t).length && !auRepos()) return;
      const cle = cleDuRun();
      if (cle === cleEvaluee) return;
      cleEvaluee = cle;
      // D'abord ce qui ne coûte rien : une alerte ouverte, une phrase non rangée, une exigence sans signature ; les reçus
      // (qui relisent les octets du produit) seulement ensuite.
      if (T.listerTickets(t).some((k) => k.sorte === "alerte" && k.etat !== "ferme") || T.phrases(t).some((x) => x.classement === null)
        || T.listerExigences(t).some((e) => !e.retiree && !e.parent && !T.exigenceTenue(t, e.libelle))) return; // jalons : une découpée, par ses jalons
      // Les reçus attestés dont seul le produit ou le monde a changé, rejoués par la file ; le report d'une attestation
      // change l'état du run, qui est jugé de nouveau.
      if (P.demanderRejeux(t, runDir).length) return;
      if (etatDuRun(t, runDir, "absente").etat !== "accepte") return;
      jugeEnCours = true;
      void (async () => {
        try {
          const v = statutVerification(await lancerVerifications(mission, runDir, t, { sansBacASable: !!o.sansBacASable, substituer, type: "jugement" }));
          if (constatRun) return;
          if (cleDuRun() !== cle) { cleEvaluee = undefined; return; } // le run a bougé pendant la vérification : jugé de nouveau
          const e = etatDuRun(t, runDir, v);
          if (e.etat === "accepte") constaterRun("accepte", `alertes fermées, exigences attestées, vérification ${v === "passe" ? "passée" : "absente"}`);
          else T.ajouterEvenement(t, { agent: "lanceur", type: "jugement", resultat: `pas encore accepté : ${e.raisons.join(" ; ")}` });
        } catch (e) {
          T.ajouterEvenement(t, { agent: "lanceur", type: "jugement", resultat: "jugement en panne", erreur: String((e as Error)?.message ?? e).slice(0, 500) });
        } finally {
          jugeEnCours = false;
        }
      })();
    };
    // Salle entièrement endormie, avec des rôles : une alerte ouverte fait réveiller son porteur, puis celui qui
    // répartit (le chef ; l'intégrateur sans chef), par un message qui les nomme ; sinon, une fois l'état du run jugé,
    // le run est incomplet. Aucun dormeur n'est plus classé « fini ».
    const etapesAlerte = new Map<number, number>(); // alerte → 1 : porteur nommé ; 2 : répartiteur nommé
    const salleEndormie = (dormeurs: Agent[]) => {
      const ouvertes = T.listerTickets(t).filter((k) => k.sorte === "alerte" && k.etat !== "ferme");
      const present = (nom: string | null) => !!nom && presents().some((a) => a.nom === nom);
      if (ouvertes.length) {
        const rep = repartiteur(presents().map((a) => ({ nom: a.nom, role: a.siege?.role ?? null, suppleantDe: a.siege?.suppleantDe })))?.nom; // le suppléant tient le siège
        const noms = new Set<string>();
        for (const k of ouvertes) {
          const etape = etapesAlerte.get(k.id) ?? 0;
          if (etape === 0 && present(k.charge)) { noms.add(k.charge!); etapesAlerte.set(k.id, 1); continue; }
          if (etape < 2) { etapesAlerte.set(k.id, 2); if (rep && rep !== k.charge) noms.add(rep); }
        }
        if (noms.size) {
          const alertes = ouvertes.map((k) => `#${k.id} « ${k.titre} »`).join(", ");
          T.poster(t, "essaim", `${[...noms].join(", ")} : toute la salle dort et ${ouvertes.length > 1 ? `les alertes ${alertes} sont ouvertes` : `l'alerte ${alertes} est ouverte`}.`, "tickets");
          T.ajouterEvenement(t, { agent: "lanceur", type: "reveil_alerte", resultat: `salle endormie, alerte${ouvertes.length > 1 ? "s" : ""} ouverte${ouvertes.length > 1 ? "s" : ""} ${ouvertes.map((k) => `#${k.id}`).join(", ")} : ${[...noms].join(", ")} nommé${noms.size > 1 ? "s" : ""}` });
          tousDormentDepuis = undefined;
          return;
        }
        endormis += dormeurs.length;
        return constaterRun("incomplet", `salle endormie, ${ouvertes.length > 1 ? "alertes ouvertes" : "alerte ouverte"} ${ouvertes.map((k) => `#${k.id}`).join(", ")} sans personne pour ${ouvertes.length > 1 ? "les" : "la"} traiter`);
      }
      if (jugeEnCours || cleDuRun() !== cleEvaluee || T.rejeuxAttestationsEnCours(t)) return; // l'état du run n'est pas encore jugé : le tour suivant le juge
      // La ronde de dernière chance : il reste de l'argent et du travail, et toute la salle dort. Le
      // répartiteur est réveillé une fois par état du travail, trois fois au plus ; s'il se rendort sans rien changer, la salle se
      // ferme.
      if (derniereChance !== cleDuTravail() && dernieresChances < DERNIERES_CHANCES_MAX && dernierAppel(Date.now())) { derniereChance = cleDuTravail(); dernieresChances++; tousDormentDepuis = undefined; return; }
      endormis += dormeurs.length;
      constaterRun("incomplet", "salle endormie");
    };

    // ---- Pilotage de la salle : le lanceur informe
    // celui qui répartit le travail (le chef ; son suppléant qui tient le siège ; l'intégrateur sans chef), il ne décide rien.
    // Ses messages sont signés « lanceur » et commencent par « <répartiteur> : » sans question : la règle d'adressage ne
    // réveille que lui (un message signé essaim réveillerait tous les dormeurs qu'il nomme).
    // Les paliers : une annonce par palier franchi (25, 50, 75, 90 % du plafond), la plus haute seulement quand un tour
    // en franchit plusieurs. La ronde : toutes les ESSAIM_RONDE_MS (10 min), quand au moins la moitié des constructeurs
    // présents (deux au moins) dorment sans rien attendre depuis ce temps ; au plus trois rondes de suite sans effet pour la
    // même liste. Une salle qui dort alors qu'il reste du travail et de l'argent est un échec de répartition.
    const PALIERS = [25, 50, 75, 90];
    const paliersFaits = new Set<number>();
    const rondeMs = Number(process.env.ESSAIM_RONDE_MS ?? 10 * 60_000);
    const RONDES_SANS_EFFET = 3;
    // La dernière ronde : la liste des disponibles, son heure, les rondes de suite sans effet, et `repondu` : le répartiteur
    // a bougé depuis (ticket, message qui n'est pas une mise en veille). Même liste : s'il a répondu, silence (il a vu, et
    // peut avoir dit pourquoi il n'y a pas de travail) ; sinon trois rondes au plus. Silence jusqu'à ce que la liste change.
    let ronde: { cle: string; le: string; sansEffet: number; silence?: boolean } | undefined;
    let derniereChance: string | undefined;
    // Un répartiteur qui change l'état du run à chaque réveil sans confier de travail (un ticket de plus, personne pour
    // le prendre) relancerait la dernière chance sans fin : trois au plus par run.
    const DERNIERES_CHANCES_MAX = 3;
    // L'état du travail, pour la dernière chance : les tickets, les attestations, le rangement des phrases. Pas cleDuRun,
    // dont les faits changent à chaque mise en veille (le répartiteur réveillé qui se rendort changerait l'état).
    const cleDuTravail = () => JSON.stringify(t.get(`SELECT (SELECT MAX(maj_le) FROM tickets) AS k, (SELECT COALESCE(MAX(id), 0) FROM attestations) AS a,
      (SELECT count(*) FROM attestations WHERE revoquee_le IS NOT NULL) AS r, (SELECT MAX(range_le) FROM phrases) AS p`));
    let dernieresChances = 0;
    const membres = () => presents().map((a) => ({ nom: a.nom, role: a.siege?.role ?? null, suppleantDe: a.siege?.suppleantDe }));
    const aQuiRendreCompte = () => sieges ? repartiteur(membres())?.nom : undefined;
    // Les suppléants qui tiennent un siège (chef ou intégrateur absent) : ils pilotent, jamais comptés disponibles.
    const tenantsDeSiege = () => {
      const m = membres();
      return (["chef", "integrateur"] as const).flatMap((role) => m.some((a) => a.role === role) ? [] : m.filter((a) => a.suppleantDe === role).map((a) => a.nom));
    };
    const etatBudget = () => {
      const depense = depenseTotale();
      const reste = Math.max(0, o.plafond - depense);
      return `dépensé ${T.dollars(depense, 2)} sur ${T.dollars(o.plafond, 2)}, reste ${T.dollars(reste, 2)}, ${T.texteRythme(T.rythme(t, Date.now(), reste))}`;
    };
    // La préparation : validée par plan_juger ; close par le lanceur quand 25 % du plafond sont dépensés sans plan
    // validé, pour que la préparation ne mange pas le budget de la construction.
    // Ou après preparationMaxMs() hors pauses : sur un modèle gratuit, la dépense reste à
    // 0 $ et la préparation ne serait jamais close.
    const suivrePreparation = () => {
      if (T.preparation(t) !== "en_cours") return;
      const debut = t.get<{ debut: string | null }>("SELECT debut FROM run")?.debut;
      const duree = debut ? T.dureeHorsPause(t, Date.parse(debut)) : 0;
      const parBudget = depenseTotale() >= 0.25 * o.plafond, parDuree = duree >= preparationMaxMs();
      if ((!parBudget && !parDuree) || !T.clorePreparation(t, "close")) return;
      const cause = parBudget ? "25 % du budget sont dépensés" : `${Math.round(duree / 60_000)} minutes sont passées`;
      T.ajouterEvenement(t, { agent: "lanceur", type: "plan", resultat: `préparation close sans plan validé (${parBudget ? "25 % du plafond" : `${Math.round(duree / 60_000)} min`})` });
      const rep = aQuiRendreCompte();
      if (rep) T.poster(t, "lanceur", `${rep} : ${cause} sans plan validé ; la préparation est close, les constructeurs sont disponibles. Tu répartis le travail : confie à chacun un ticket borné.`);
    };
    // Les signes du surveillant : mesurés sans token au plus une fois par
    // minute ; une occurrence nouvelle, après la grâce et hors révision, réveille le surveillant par un seul message signé
    // lanceur qui le nomme (sansQuestion : aucun autre nom ne se réveille). S1 lit git hors de la boucle : un cache,
    // rafraîchi au plus une fois par minute ; une lecture en panne vaut « mesure indisponible ».
    const occurrences = new S.Occurrences();
    const signeTourMs = Number(process.env.ESSAIM_SIGNE_TOUR_MS ?? 60_000);
    let derniersSignes = 0, dernierConsomme = 0, mesureLivrable: S.MesureLivrable | undefined, lectureLivrable = false, livrableLu = 0;
    const lireLivrable = (maintenant: number) => {
      if (!mission.livrable || lectureLivrable || maintenant - livrableLu < signeTourMs) return;
      lectureLivrable = true;
      livrableLu = maintenant;
      void D.git(partage, ["log", "-n1", "--format=%cI", "HEAD", "--", mission.livrable]).then((r) => {
        mesureLivrable = r.code === 0 ? { le: r.sortie.trim() || undefined } : { erreur: r.erreur.trim() || `git log : code ${r.code}` };
      }, (e) => { mesureLivrable = { erreur: String((e as Error)?.message ?? e) }; }).finally(() => { lectureLivrable = false; });
    };
    const suivreSignes = (maintenant: number) => {
      const surveillant = presents().find((a) => a.siege?.role === "surveillant");
      if (!surveillant) return;
      lireLivrable(maintenant);
      if (maintenant - derniersSignes < signeTourMs) return;
      derniersSignes = maintenant;
      const consomme = t.get<{ id: number | null }>("SELECT MAX(id) AS id FROM evenements WHERE type = ?", [S.CONSOMMES])?.id ?? 0;
      if (consomme !== dernierConsomme) { dernierConsomme = consomme; occurrences.consommer(); }
      const l = S.signes(t, { maintenantMs: maintenant, livrable: mission.livrable, mesure: mesureLivrable });
      const grace = S.finDeGrace(t, maintenant);
      const reveiller = !!grace?.finie && !S.revisionEnCours(t);
      const nouveaux = occurrences.maj(l, maintenant, reveiller);
      if (!nouveaux.length) return;
      T.poster(t, "lanceur", sansQuestion(`${surveillant.nom} : ${nouveaux.map((x) => x.texte).join(" ; ")}`));
      for (const x of nouveaux) T.ajouterEvenement(t, { agent: "lanceur", type: "signe", resultat: `${surveillant.nom} réveillé : ${x.texte}` });
    };
    // La révision : sans réponse du chef, un rappel au bout de 15 min et l'expiration au bout de 30 ;
    // acceptée sans plan validé au bout de 45 min, close par le délai, les tickets dégelés. Hors pause.
    const suivreRevision = (maintenant: number) =>
      S.suivreRevision(t, maintenant, agents.filter((a) => a.siege).map((a) => ({ nom: a.nom, role: a.siege!.role, suppleantDe: a.siege!.suppleantDe, present: !a.etat && !a.coupe })));
    const annoncerPalier = () => {
      const rep = aQuiRendreCompte();
      if (!rep || !(o.plafond > 0)) return;
      const part = (depenseTotale() / o.plafond) * 100;
      const franchis = PALIERS.filter((p) => p <= part && !paliersFaits.has(p));
      if (!franchis.length) return;
      for (const p of franchis) paliersFaits.add(p);
      const p = franchis.at(-1)!;
      T.poster(t, "lanceur", `${rep} : palier de ${p} % du budget atteint. ${etatBudget()}. Tu répartis le travail : ce qui reste à faire et ce qui passe en priorité, en gardant de quoi assembler et faire attester, va à ceux que ça change, chacun par son nom.`);
      T.ajouterEvenement(t, { agent: "lanceur", type: "palier", resultat: `palier ${p} % : ${rep} prévenu` });
    };
    const sansQuestion = (x: string) => x.replace(/\?/g, "");
    const disponibles = (maintenant: number, rep: string) => {
      const exclus = [rep, ...tenantsDeSiege()];
      const constructeurs = presents().filter((a) => a.siege?.role === "constructeur" && !exclus.includes(a.nom)).map((a) => a.nom);
      return { constructeurs, liste: T.oisifs(t, { maintenantMs: maintenant, exclus, repartiteur: rep }).filter((x) => constructeurs.includes(x.nom)) };
    };
    // Chaque exigence sans attestation à jour, avec son état ; le lanceur recopie, il ne calcule rien du métier.
    // Une erreur de lecture du dossier partagé (un lien supprimé pendant le relevé) ne fait pas tomber la ronde : la phrase
    // est alors omise.
    const exigencesRestantes = (): string => exigencesNonTenues(t, runDir);
    // Le message d'une ronde : les disponibles (qui n'attendent rien, ou une attente vague), à part ceux dont l'attente
    // a passé 30 minutes,
    // les tickets sans porteur présent, le budget.
    const posterRonde = (rep: string, tete: string, liste: ReturnType<typeof T.oisifs>, evenement: string) => {
      const precision = (x: (typeof liste)[number]) => x.vague ? `attente vague : ${x.vague}` : x.perimee;
      const noms = (l: typeof liste) => l.map((x) => `${x.nom} (${T.dureeTexte(Math.max(1, Math.round(x.depuisMs / 60_000)))}${precision(x) ? `, ${sansQuestion(precision(x)!)}` : ""})`).join(", ");
      const libres = liste.filter((x) => !x.perimee), perimes = liste.filter((x) => x.perimee && !x.surTicket), surTicket = liste.filter((x) => x.surTicket);
      const sansPorteur = T.ticketsSansPorteur(t, presents().map((a) => a.nom));
      const tickets = sansPorteur.length ? sansPorteur.slice(0, 10).map((k) => `#${k.id} « ${sansQuestion(k.titre)} »`).join(", ") + (sansPorteur.length > 10 ? `, et ${sansPorteur.length - 10} autres` : "") : "aucun";
      const attente = Math.round(Number(process.env.ESSAIM_ATTENTE_MS ?? 30 * 60_000) / 60_000);
      // La charge de chacun ; ce qui reste à prouver, recopié de ce que la recette et le gardien ont déclaré.
      const porteurs = T.chargeParPorteur(t, presents().map((a) => a.nom));
      const charge = porteurs.slice(0, 5).map((x) => `${x.nom} ${x.tickets}`).join(", ") + (porteurs.length > 5 ? `, et ${porteurs.length - 5} autres` : "");
      const restantes = exigencesRestantes();
      T.poster(t, "lanceur", `${rep} : ${tete}. Constructeurs qui n'attendent rien : ${libres.length ? noms(libres) : "aucun"}.${perimes.length ? ` Attente de plus de ${attente} min, sans réponse : ${noms(perimes)}.` : ""}${surTicket.length ? ` En veille sur leur ticket, sans mouvement : ${surTicket.map((x) => `${x.nom} (${sansQuestion(x.perimee!.replace(/^en veille sur /, ""))})`).join(", ")}.` : ""} Tickets ouverts sans porteur présent : ${tickets}.${charge ? ` Tickets ouverts par porteur : ${charge}.` : ""}${restantes ? ` Exigences pas encore tenues : ${sansQuestion(restantes)}.` : ""} Budget : ${etatBudget()}. Tu répartis le travail : confie à chaque disponible un travail précis (un ticket borné à son nom), ou écris-lui pourquoi il n'y en a pas. Un agent qui attend quelque chose ne reçoit pas de travail en plus.`);
      T.ajouterEvenement(t, { agent: "lanceur", type: "ronde", resultat: `${evenement} : ${rep} prévenu, disponibles ${liste.map((x) => x.nom).join(", ") || "aucun"}` });
    };
    // La ronde périodique : trois constructeurs présents disponibles depuis rondeMs, ou un tiers d'une petite équipe, deux au
    // moins.
    const ronder = (maintenant: number): boolean => {
      const rep = aQuiRendreCompte();
      if (!rep || depenseTotale() >= 0.9 * o.plafond || T.preparation(t) === "en_cours") return false; // les constructeurs attendent le plan

      const { constructeurs, liste } = disponibles(maintenant, rep);
      const mures = liste.filter((x) => x.depuisMs >= rondeMs);
      if (mures.length < seuilRonde(constructeurs.length)) return false;
      const cle = mures.map((x) => x.nom).join(",");
      const le = new Date(maintenant).toISOString();
      if (ronde?.cle === cle) {
        if (ronde.silence) return false;
        const repondu = !!t.get("SELECT 1 FROM ticket_notes WHERE auteur = ? AND cree_le > ?", [rep, ronde.le]) || !!t.get("SELECT 1 FROM tickets WHERE auteur = ? AND cree_le > ?", [rep, ronde.le])
          || !!t.get("SELECT 1 FROM messages WHERE auteur = ? AND sommeil = 0 AND cree_le > ?", [rep, ronde.le]);
        if (repondu || ronde.sansEffet + 1 >= RONDES_SANS_EFFET) { ronde.silence = true; return false; }
        ronde = { cle, le, sansEffet: ronde.sansEffet + 1 };
      } else ronde = { cle, le, sansEffet: 0 };
      posterRonde(rep, "ronde du lanceur, des constructeurs dorment sans rien attendre", mures, "ronde");
      return true;
    };
    // La dernière chance : toute la salle dort ; ni seuil ni délai, mais du travail qui reste.
    const dernierAppel = (maintenant: number): boolean => {
      const rep = aQuiRendreCompte();
      if (!rep || depenseTotale() >= 0.9 * o.plafond) return false;
      const travail = T.listerTickets(t).some(T.estActif) || T.listerExigences(t).some((e) => !e.retiree && !e.parent && !T.exigenceTenue(t, e.libelle));
      if (!travail) return false;
      posterRonde(rep, "toute la salle dort alors qu'il reste du travail et de l'argent", disponibles(maintenant, rep).liste, "dernière chance");
      return true;
    };

    // Les consignes déposées par la vue (<run>/consignes/*.txt), postées dans l'ordre à celui qui
    // répartit le travail, signées lanceur, sans « ? » (règle d'adressage) ; sans répartiteur présent, elles sont écartées
    // et l'événement le dit. Pendant une pause aussi : le message attend le réveil.
    // Le dossier est fermé aux agents par le bac à sable ; le lanceur ne suit pourtant ni lien ni dossier,
    // et une consigne illisible est sautée sans faire tomber la surveillance.
    const dossierConsignes = join(runDir, "consignes");
    const TRACE_CONSIGNE = 300; // signes de la consigne recopiés dans l'événement
    const transmettreConsignes = () => {
      if (!existsSync(dossierConsignes) || !lstatSync(dossierConsignes).isDirectory()) return;
      for (const f of readdirSync(dossierConsignes).filter((x) => x.endsWith(".txt")).sort()) {
        const chemin = join(dossierConsignes, f);
        try {
          if (!lstatSync(chemin).isFile()) continue;
          const texte = sansQuestion(readFileSync(chemin, "utf8")).trim();
          rmSync(chemin, { force: true });
          if (!texte) continue;
          const rep = aQuiRendreCompte();
          if (!rep) { T.ajouterEvenement(t, { agent: "lanceur", type: "consigne", resultat: `${T.PREFIXE_ECARTEE}${texte.slice(0, TRACE_CONSIGNE)}` }); continue; }
          const id = T.poster(t, "lanceur", `${rep}${T.MARQUE_CONSIGNE}${texte}`);
          T.ajouterEvenement(t, { agent: "lanceur", type: "consigne", resultat: `consigne à ${rep} (message ${id}) : ${texte.slice(0, TRACE_CONSIGNE)}` });
        } catch (e) {
          T.ajouterEvenement(t, { agent: "lanceur", type: "consigne", resultat: `consigne ${f} illisible`, erreur: String((e as Error)?.message ?? e).slice(0, 300) });
        }
      }
    };

    const surveiller = () => {
      const maintenant = Date.now();
      constaterVeille();
      transmettreConsignes();
      const actifs = agents.filter((a) => !a.etat && !a.coupe);
      if (actifs.length === 0) return;
      if (existsSync(join(runDir, "arret"))) { noterConstat("incomplet", "arrêté depuis la vue"); return actifs.forEach((a) => couper(a, "arrêté depuis la vue")); } // la caméra a demandé la fermeture
      if (depenseTotale() >= o.plafond) { noterConstat("incomplet", "plafond atteint"); return actifs.forEach((a) => couper(a, "plafond")); }
      // Pause : chaque agent est arrêté dès qu'il n'a plus d'action en cours (au plus PAUSE_OUTIL_MS d'attente) ; les
      // garde-fous du temps et la salle endormie ne jouent pas. L'arrêt et le plafond, au-dessus, jouent toujours.
      if (enPause()) {
        if (pauseDepuis === undefined) {
          pauseDepuis = maintenant;
          pauseMur = maintenant;
          T.ajouterEvenement(t, { agent: "lanceur", type: "pause", resultat: "pause demandée : chaque agent s'arrête après son action en cours" });
        }
        for (const a of actifs) {
          if (!a.pid || a.suspendu || (a.compteur.outilEnCours && maintenant - pauseDepuis < PAUSE_OUTIL_MS)) continue;
          a.suspendu = true;
          T.ajouterEvenement(t, { agent: a.nom, type: "pause", resultat: a.compteur.outilEnCours ? `mis en pause pendant ${a.compteur.outilEnCours.nom}, trop long à attendre` : "mis en pause" });
          void tuerGroupe(a.pid);
        }
        tousDormentDepuis = undefined;
        return;
      }
      noterReprise();
      for (const a of actifs) {
        const c = a.compteur;
        if (a.dort) continue; // en veille : ni silence ni outil bloqué, c'est la salle endormie qui borne
        if (a.arrete) continue; // arrêté par la pause, pas encore relancé : aucun processus à surveiller
        if (c.outilEnCours) {
          const resume = c.outilEnCours.id === COMPACTAGE;
          if (maintenant - c.outilEnCours.depuis > (resume ? resumeMs : outilMs)) {
            if (resume && (a.resumesBloques ?? 0) < RESUMES_BLOQUES_MAX && a.pid && !a.resumeBloque) { a.resumeBloque = true; void tuerGroupe(a.pid); } // refait, pas viré
            else if (!a.resumeBloque) couper(a, resume ? "résumé bloqué" : `outil bloqué : ${c.outilEnCours.nom}`);
          }
        } else if (c.emballement && a.pid && !a.emballe) { // couper la réponse et relancer l'agent, pas le virer
          a.emballe = c.emballement;
          void tuerGroupe(a.pid);
        } else if (c.reponseDepuis !== undefined && maintenant - c.reponseDepuis > reflexionMs) couper(a, "réflexion sans fin");
        else if (maintenant - Math.max(c.dernierProgres, c.dernierMorceau ?? 0) > silenceMs) couper(a, "silence");
      }
      if (sieges) {
        // Une alerte ouverte que plus personne dans la salle ne peut fermer : le run est incomplet.
        const ouverte = T.listerTickets(t).find((k) => k.sorte === "alerte" && k.etat !== "ferme");
        if (ouverte && !presents().some((a) => a.siege && DROITS[a.siege.role].fermeAlerte))
          return constaterRun("incomplet", `alerte #${ouverte.id} ouverte, plus personne dans la salle pour la traiter`);
        essayerDeJuger();
        if (constatRun) return;
        annoncerPalier();
        suivrePreparation();
        suivreSignes(maintenant);
        suivreRevision(maintenant);
        if (maintenant - derniereRonde >= rondeMs && maintenant - derniereEvaluation >= Math.min(rondeMs, 60_000)) { // pas à chaque tour
          derniereEvaluation = maintenant;
          if (ronder(maintenant)) derniereRonde = maintenant;
        }
      }
      if (actifs.every((a) => a.dort)) {
        tousDormentDepuis ??= maintenant;
        if (maintenant - tousDormentDepuis > graceSalleMs) {
          if (sieges) salleEndormie(actifs);
          else actifs.forEach(fermerDormeur);
        }
      } else tousDormentDepuis = undefined;
    };
    // Les processus abandonnés : pi coupe une commande trop longue et rend la main, mais le `bun test`
    // qui boucle continue et se retrouve sans parent. Une fois par minute, on ramasse ceux dont le répertoire
    // courant est dans le run et que plus personne n'attend ; un `bun test` lancé à l'instant par un agent a
    // toujours son parent, il n'est jamais touché.
    let restesTues = 0;
    let ramassageEnCours = false;
    const RAMASSAGE_TOURS = Math.max(1, Math.round(60_000 / INTERVALLE_MS));
    let tours = 0;
    const ramasser = () => {
      if (ramassageEnCours) return;
      ramassageEnCours = true;
      void tuerRestes(runDir).then((restes) => {
        restesTues += restes.length;
        for (const r of restes) T.ajouterEvenement(t, { agent: "lanceur", type: "reste", resultat: `processus abandonné arrêté : ${r.pid} ${r.commande}` });
      }).finally(() => { ramassageEnCours = false; });
    };
    // Le garde-fou de la mémoire : toutes
    // les 10 s, une commande d'agent au-delà de ESSAIM_MEMOIRE_MAX_GO (8 Go par défaut) est arrêtée ; l'agent le lit dans
    // un message du lanceur qui le nomme seul, et l'événement `memoire` le garde. L'agent lui-même (pi) n'est jamais visé.
    const MEMOIRE_TOURS = Math.max(1, Math.round((TEST ? 200 : 10_000) / INTERVALLE_MS));
    const memoireMaxGo = Number(process.env.ESSAIM_MEMOIRE_MAX_GO ?? 8);
    let gardeEnCours = false;
    const garderMemoire = () => {
      if (gardeEnCours || !(memoireMaxGo > 0)) return;
      gardeEnCours = true;
      const parPid = new Map(agents.filter((a) => a.pid).map((a) => [a.pid!, a.nom]));
      void listerProcessus().then(async (ps) => {
        for (const g of gourmands(ps, parPid, memoireMaxGo * 1024 * 1024)) {
          await tuerGourmand(g.pid);
          const go = (g.ko / 1024 / 1024).toFixed(1).replace(".", ","), max = String(memoireMaxGo).replace(".", ",");
          T.ajouterEvenement(t, { agent: g.agent, type: "memoire", resultat: `commande arrêtée par le lanceur : ${go} Go de mémoire (limite ${max} Go) : ${g.pid} ${g.commande}` });
          T.poster(t, "lanceur", `${g.agent} : ta commande a été arrêtée par le lanceur, elle prenait ${go} Go de mémoire (limite ${max} Go) : ${sansQuestion(g.commande)}`);
        }
      }).finally(() => { gardeEnCours = false; });
    };
    const minuterie = setInterval(() => { surveiller(); if (++tours % RAMASSAGE_TOURS === 0) ramasser(); if (tours % MEMOIRE_TOURS === 0) garderMemoire(); }, INTERVALLE_MS);
    // Les résumés de lots des fils : une minuterie à part, rien en pause ni au plafond, arrêtée avec le run.
    const lots = servirLots(t, { runDir, modeles, enPause, auPlafond: () => depenseTotale() >= o.plafond, ajouterCout: (c) => { coutResumes += c; }, ms: TEST ? 50 : 1000 });
    // Rôles : la file des rejeux, servie hors des agents ; les reçus vont dans preuves/, fermé aux agents.
    const rejeux = sieges ? P.servirRejeux(t, runDir, { ms: TEST ? 50 : 1000, sansBacASable: !!o.sansBacASable, enPause }) : undefined;
    let constat: Constat | undefined;
    try {
      // Préparer la mission : avec un répartiteur, les constructeurs démarrent
      // en veille, en attendant le plan ; un ticket confié ou un message qui ne s'adresse qu'à eux les réveille (une
      // exploration confiée par la direction).
      const rep = aQuiRendreCompte();
      if (o.preparation && rep) {
        T.ouvrirPreparation(t);
        for (const a of agents) if (a.siege?.role === "constructeur") { T.endormir(t, a.nom, T.ATTENTE_PLAN); a.veilleInitiale = true; }
        T.poster(t, "lanceur", `${rep} : la salle commence par préparer la mission, en deux étapes, contrôlées par la recette et le gardien (plan_proposer). D'abord SPEC.md : le but, le problème mesuré, l'approche choisie avec les options écartées, chaque exigence avec la commande qui la prouve ; validée, elle ne change plus. Ensuite PLAN.md : le tableau des tickets, chacun avec son porteur et un vérificateur distinct. Tu écris les deux, 6 000 signes au plus chacun. Les constructeurs attendent le plan, en veille : jusqu'à sa validation, un ticket qui leur est confié est une exploration (une question), dont la réponse est une mesure pour la spec ou le plan.`);
        T.ajouterEvenement(t, { agent: "lanceur", type: "plan", resultat: `préparation ouverte : ${agents.filter((a) => a.veilleInitiale && a.siege?.role === "constructeur").length} constructeurs en veille, ${rep} prévenu` });
      }
      // Le surveillant : en veille avant toute passe, pi n'est lancé qu'au premier signe qui le réveille.
      for (const a of agents) if (a.siege?.role === "surveillant") { T.endormir(t, a.nom, S.ATTENTE_SIGNE); a.veilleInitiale = true; }
      conduites.push(...agents.map(conduireAgent));
      // Un siège relancé ajoute sa conduite pendant que les autres tournent : on attend jusqu'à ce qu'il n'en vienne plus.
      for (let vues = 0; vues < conduites.length;) { const n = conduites.length; await Promise.all(conduites); vues = n; }
      // tous les agents sont sortis ; la surveillance tourne encore (fichier arret) pendant le constat
      constat = await constaterLivrable(mission, runDir, t, { sansBacASable: !!o.sansBacASable, substituer });
    } finally {
      clearInterval(minuterie);
      arreterDemandes();
      await lots.arreter(); // résumeurs tués et attendus, aucun lot ne reste pris
      await rejeux?.arreter(); // le rejeu en cours finit et conclut
    }
    // Rôles : tous les agents sortis d'eux-mêmes, le lanceur constate le run sur le constat de sortie ; une demande
    // de rejeu encore en file n'a plus personne à qui répondre ni plus rien à fermer (un run accepté n'a aucune alerte
    // ouverte) : elle est close sans reçu, et le bilan la cite.
    let fin: EtatRun | undefined;
    let rejeuxSansObjet: number[] = [];
    try {
      if (sieges) {
        if (!constatRun) await P.rejouerAttestations(t, runDir, { sansBacASable: !!o.sansBacASable }); // avant de décider
        fin = etatDuRun(t, runDir, statutVerification(constat?.verifications));
        // Un siège tombé (viré, perdu) sans successeur n'a pas tenu jusqu'au bout : le run ne peut pas être accepté.
        const tombes = agents.filter((a) => a.siege && !a.remplacePar && (a.etat === "vire" || a.etat === "perdu"));
        if (!constatRun && fin.etat === "accepte" && !tombes.length) noterConstat("accepte", "tous sortis, alertes fermées, exigences attestées, vérification passée ou absente");
        else if (!constatRun) noterConstat("incomplet", tombes.length ? `siège${tombes.length > 1 ? "s" : ""} tombé${tombes.length > 1 ? "s" : ""} sans successeur : ${tombes.map((a) => `${NOMS_ROLES[a.siege!.role]} ${T.deNom(a.nom)} (${a.raison})`).join(", ")}` : "tous sortis avant l'acceptation");
        rejeuxSansObjet = T.abandonnerRejeux(t, `run ${constatRun!.etat === "accepte" ? "accepté" : "incomplet"} et fermé avant ce rejeu`);
      }
    } finally {
      T.fermerFils(t, "fin du run");
      rmSync(join(runDir, "pause"), { force: true }); // un run fermé pendant sa pause : plus rien à reprendre
    }
    // Dernier ramassage : rien ne doit tourner après le run (le constat, lui, a son parent et n'est pas touché).
    const derniers = await tuerRestes(runDir);
    restesTues += derniers.length;
    for (const r of derniers) T.ajouterEvenement(t, { agent: "lanceur", type: "reste", resultat: `processus abandonné arrêté : ${r.pid} ${r.commande}` });

    const depense = depenseTotale();
    const lotsResumes = t.get<{ n: number }>("SELECT count(*) AS n FROM lots WHERE etat = 'fait'")?.n ?? 0;
    // La file vidée, ce que personne n'a commité (un bash coupé, le constat) part au nom de l'essaim, partout.
    await fileGit.vider();
    let commits: Bilan["commits"];
    try {
      for (const racine of surs.keys()) {
        if (!depotSur(racine)) continue;
        const c = await D.commiter(racine, "essaim", "fin du run", { seulEcrivain: true });
        if (c) t.transaction(() => T.noterFait(t, D.faitEcriture(c, "essaim", D.racineDuFait(racine, partage), "fin du run")));
      }
      if (depotSur(partage)) commits = await D.bilanCommits(partage);
    } catch (e) {
      erreurDepot("dernier commit manqué", e);
    }
    // Les entrées sont des données : un agent qui les a modifiées (le dossier du run est inscriptible), ça se voit.
    const entreesModifiees = entrees.filter((e) => { const f = join(runDir, "entrees", e.nom); return !existsSync(f) || sha256(readFileSync(f)) !== e.sha256; }).map((e) => e.nom);
    if (entreesModifiees.length) T.ajouterEvenement(t, { agent: "lanceur", type: "entrees", resultat: `empreinte changée pendant le run : ${entreesModifiees.join(", ")}`, erreur: `entrées modifiées : ${entreesModifiees.join(", ")}` });
    // La mesure des outils : une seule lecture de la base, en fin de run ; aucun garde-fou ni compteur n'en dépend.
    const outils = T.resumeOutils(T.bilanOutils(t));
    const invalidees = sieges ? T.invalidations(t) : [];
    const passations = agents.filter((b) => b.remplace && b.siege).map((b) => ({ role: b.siege!.role, sortant: b.remplace!, entrant: b.nom,
      motif: agents.find((a) => a.nom === b.remplace)?.raison ?? "", note: !!T.passationPour(t, b.nom),
      livre: !!t.get("SELECT 1 FROM evenements WHERE agent = ? AND type = 'succession' AND resultat_resume LIKE 'état du siège livré%'", [b.nom]) }));
    const lecons = T.leconsDuRun(t).map((l) => ({ agent: l.agent, role: l.role, date: l.cree_le, texte: l.texte }));
    const engagements = T.engagements(t).map((p) => p.texte); // suivis, jamais attestés
    let jalons: NonNullable<Bilan["jalons"]> = [];
    try { jalons = P.etatDesExigences(t, runDir).filter((e) => e.jalons).map((e) => ({ exigence: e.libelle, attestes: e.jalons!.attestes, total: e.jalons!.total, restants: e.jalons!.restants })); } catch { /* bilan sans les jalons */ }
    const decoupageNonJuge = !!t.get("SELECT 1 FROM evenements WHERE type = 'plan' AND resultat_resume LIKE 'découpage non jugé%'");
    const revisions = S.listerRevisions(t).map((r) => ({ n: r.id, demandeur: r.demandeur, etat: r.etat, raison: r.raison, geles: JSON.parse(r.tickets_geles_json ?? "[]") as number[], closePar: r.close_par }));
    // Les réveils par agent : ce que les veilles ont coûté en relectures, compté dans la trace.
    const reveils = Object.fromEntries(t.all<{ agent: string; n: number }>("SELECT agent, count(*) AS n FROM evenements WHERE type = 'reveil' GROUP BY agent ORDER BY MIN(id)").map((r) => [r.agent, r.n]));
    const bilan: Bilan = {
      finis: agents.filter((a) => a.etat === "fini").length,
      vires: agents.filter((a) => a.etat === "vire").length,
      perdus: agents.filter((a) => a.etat === "perdu").length,
      depense, plafond: o.plafond, depassement: Math.max(0, depense - o.plafond), run: runDir,
      ...(entreesModifiees.length ? { entreesModifiees } : {}),
      ...(constat ? { constat } : {}),
      ...(restesTues ? { restes: restesTues } : {}),
      ...(endormis ? { endormis } : {}),
      ...(o.modeleFemmes ? { parCote: T.parCote(t), ouvreur: equipe[0]!.cote } : {}),
      ...(coutResumes > 0 || lotsResumes > 0 ? { resumes: { cout: Math.round(coutResumes * 1e6) / 1e6, lots: lotsResumes } } : {}),
      ...(commits ? { commits } : {}),
      outils,
      ...(invalidees.length ? { invalidees } : {}),
      ...(Object.keys(reveils).length ? { reveils } : {}),
      ...(constatRun ? { etat: constatRun.etat, ...(constatRun.etat === "incomplet" ? { raisonsEtat: [constatRun.raison, ...fin!.raisons.filter((r) => r !== constatRun!.raison)] } : {}) } : {}),
      ...(fin?.exigences.length ? { exigencesNonSatisfaites: fin.exigences } : {}),
      ...(fin?.alertes.length ? { alertesOuvertes: fin.alertes } : {}),
      ...(rejeuxSansObjet.length ? { rejeuxSansObjet } : {}),
      ...(passations.length ? { passations } : {}),
      ...(lecons.length ? { lecons } : {}),
      ...(engagements.length ? { engagements } : {}),
      ...(revisions.length ? { revisions } : {}),
      ...(jalons.length ? { jalons } : {}),
      ...(decoupageNonJuge ? { decoupageNonJuge } : {}),
    };
    T.clore(t, bilan);
    t.fermer();
    notifier(formaterBilan(bilan));
    return bilan;
  } finally {
    libererVerrou();
  }
}

// Le livrable principal déclaré par la mission (existe ? taille, empreinte), puis la commande de vérification dans
// partage/, sous le bac à sable, délai 120 s (2 s sous test), fichier arret honoré, sortie bornée. Tracés sous
// l'auteur conventionnel « lanceur », qui n'est pas un agent.
async function constaterLivrable(mission: Mission, runDir: string, t: T.Tableau, o: { sansBacASable: boolean; substituer: (c: string) => string }): Promise<Constat | undefined> {
  if (!mission.livrable && !mission.verification) return undefined;
  const constat: Constat = {};
  const partage = join(runDir, "partage");
  if (mission.livrable) {
    const chemin = join(partage, mission.livrable);
    let st: ReturnType<typeof lstatSync> | undefined;
    try { st = lstatSync(chemin); } catch { /* absent */ }
    if (!st) constat.livrable = { chemin: mission.livrable, present: false, detail: `absent : ${mission.livrable}` };
    // Un dossier intermédiaire qui est un lien : partage/dist → un ancien run passait pour un livrable présent.
    else if (st.isSymbolicLink() || !st.isFile() || !realpathSync(chemin).startsWith(realpathSync(partage) + "/")) constat.livrable = { chemin: mission.livrable, present: false, detail: `refusé : ${mission.livrable} est un lien symbolique ou n'est pas un fichier` };
    else {
      const octets = readFileSync(chemin);
      constat.livrable = { chemin: mission.livrable, present: true, taille: octets.length, sha256: sha256(octets), detail: `${mission.livrable} · ${octets.length} octets · sha256 ${sha256(octets)}` };
    }
    T.ajouterEvenement(t, { agent: "lanceur", type: "livrable", resultat: constat.livrable.detail, erreur: constat.livrable.present ? undefined : "livrable absent" });
  }
  const verifications = await lancerVerifications(mission, runDir, t, { ...o, type: "verification" });
  if (verifications.length) { constat.verifications = verifications; constat.verification = verifications.at(-1); }
  return constat;
}

// La suite de la ## Vérification de la mission, dans partage/, sous le bac à sable, délai 120 s (2 s sous test), fichier
// arret honoré, sortie bornée ; arrêtée à la première commande en échec. type : l'événement tracé, « verification » au
// constat de sortie, « jugement » quand le lanceur juge le run en cours.
type Verification = NonNullable<Constat["verifications"]>[number];
async function lancerVerifications(mission: Mission, runDir: string, t: T.Tableau, o: { sansBacASable: boolean; substituer: (c: string) => string; type: string }): Promise<Verification[]> {
  const partage = join(runDir, "partage");
  const resultats: Verification[] = [];
  for (const brute of (mission.verifications ?? (mission.verification ? [mission.verification] : []))) {
    const commande = o.substituer(brute);
    const cmd = o.sansBacASable ? ["/bin/sh", "-c", commande] : bacASable(runDir, ["/bin/sh", "-c", commande]);
    const debut = Date.now();
    const proc = Bun.spawn(cmd, { cwd: partage, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true, env: { ...envSansIdentifiants(runDir), ESSAIM_DEPOT: RACINE_DEPOT } }); // le code des agents : ni jeton ni agent SSH, comme leur bash
    const stdout = new Response(proc.stdout).text();
    const stderr = new Response(proc.stderr).text();
    let termine = false;
    void proc.exited.then(() => { termine = true; });
    let coupe: string | undefined;
    while (!termine) {
      if (Date.now() - debut > VERIFICATION_MS) { coupe = "coupé : délai dépassé"; await tuerGroupe(proc.pid); break; }
      if (existsSync(join(runDir, "arret"))) { coupe = "coupé : arrêt demandé depuis la vue"; await tuerGroupe(proc.pid); break; }
      await dormir(TEST ? 50 : 200);
    }
    await proc.exited;
    await tuerGroupe(proc.pid, 1000); // ce que la commande a laissé en fond tiendrait la sortie ouverte, et le constat avec
    const dureeMs = Date.now() - debut;
    const sortie = tronquer(((await stdout) + (await stderr)).trim(), 4000);
    const code = coupe ? null : proc.exitCode;
    const resultat = { commande, code, sortie, dureeMs, ...(coupe ? { coupe } : {}) };
    resultats.push(resultat);
    T.ajouterEvenement(t, { agent: "lanceur", type: o.type, outil: commande, resultat: coupe ? `${coupe}\n${sortie}` : sortie, dureeMs, erreur: coupe ?? (code !== 0 ? `code de sortie ${code}` : undefined) });
    if (coupe || code !== 0) break; // la suite ne se joue pas sur un état que la commande d'avant a laissé en panne
  }
  return resultats;
}
// La ## Vérification au sens du constat du run : absente (la mission n'en a pas), passe (toutes à 0), ou échoue.
export const statutVerification = (v: Verification[] | undefined): "passe" | "echoue" | "absente" =>
  !v?.length ? "absente" : v.every((x) => x.code === 0 && !x.coupe) ? "passe" : "echoue";

// L'état du run : « fini » n'est plus une déclaration d'agent, c'est un état constaté par le lanceur.
// accepte : toutes les alertes fermées (un motif permis : seul un reçu du lanceur ferme une alerte), chaque exigence active
// attestée sur un reçu non périmé et sans alerte ouverte qui la met en défaut (tickets.exigence), toutes les phrases de la
// mission rangées dans un run avec chef, et la ## Vérification qui passe (ou absente). Une exigence déclarée non vérifiée,
// ou tenue par un siège remplacé, n'est jamais acceptée. Sinon incomplet, avec ses raisons. Lu en lecture seule : la vue
// peut l'appeler sur un run fini.
export type EtatRun = { etat: "accepte" | "incomplet"; raisons: string[];
  exigences: Array<{ libelle: string; etat: string; responsable: string; alertes?: number[] }>; // les exigences non satisfaites
  alertes: Array<{ ticket: number; titre: string; charge: string | null; exigence: string | null }> }; // les alertes ouvertes
// Les exigences sans attestation à jour, avec leur état (ronde, tableau de bord) ; vide si le relevé échoue.
function exigencesNonTenues(t: T.Tableau, runDir: string): string {
  const etat = (e: P.EtatExigence) => e.etat === "non_verifiee" ? `${LIBELLES_EXIGENCE.non_verifiee} : ${(e.attestation?.portee ?? "").replace(/\s+/g, " ").slice(0, 200)}` : LIBELLES_EXIGENCE[e.etat];
  try {
    const l = P.etatDesExigences(t, runDir).filter((e) => e.etat !== "attestee");
    // Les jalons : « E4 (2/4 jalons, reste E4.3, E4.4) ».
    const texte = (e: P.EtatExigence) => e.jalons ? P.texteJalons(e.jalons) : etat(e);
    return l.slice(0, 10).map((e) => `${e.libelle} (${texte(e)})`).join(", ") + (l.length > 10 ? `, et ${l.length - 10} autres` : "");
  } catch { return ""; }
}
const LIBELLES_EXIGENCE = P.LIBELLES_ETAT;
export function etatDuRun(t: T.Tableau, runDir: string, verification: "passe" | "echoue" | "absente"): EtatRun {
  const alertes = T.listerTickets(t).filter((k) => k.sorte === "alerte" && k.etat !== "ferme")
    .map((k) => ({ ticket: k.id, titre: k.titre, charge: k.charge, exigence: k.exigence ?? null }));
  const phrases = T.phrases(t);
  const actives = T.listerExigences(t).filter((e) => !e.retiree);
  const exigences = (actives.length ? P.etatDesExigences(t, runDir) : []).flatMap((e) => {
    // Une alerte liée à un jalon met son parent en défaut.
    const liees = alertes.filter((a) => a.exigence === e.libelle || (a.exigence && T.parentDe(t, a.exigence) === e.libelle)).map((a) => a.ticket);
    // Un rejeu échoué dit pourquoi : le reçu rejoué, son code, ce qui a changé.
    const etat = (e.etat === "rejeu_echoue" ? `${LIBELLES_EXIGENCE[e.etat]} : ${e.rejeu!.texte} ; changé depuis ${e.attestation!.recu} : ${e.changes!.join(", ")}` : LIBELLES_EXIGENCE[e.etat])
      + (e.jalons ? ` (${P.texteJalons(e.jalons)})` : ""); // jalons
    return e.etat === "attestee" && !liees.length ? [] : [{ libelle: e.libelle, etat, responsable: e.responsable, ...(liees.length ? { alertes: liees } : {}) }];
  });
  const raisons: string[] = [];
  if (alertes.length) raisons.push(`${alertes.length > 1 ? `${alertes.length} alertes ouvertes` : "une alerte ouverte"} : ${alertes.map((a) => `#${a.ticket}`).join(", ")}`);
  if (phrases.length) {
    const libres = phrases.filter((x) => x.classement === null).map((x) => x.n);
    if (libres.length) raisons.push(`phrases de la mission pas encore rangées : ${libres.join(", ")}`);
    if (!actives.length) raisons.push("aucune exigence rangée");
  }
  if (exigences.length) raisons.push(`exigences non satisfaites : ${exigences.map((e) => `${e.libelle} (${[...(e.etat !== "attestée" ? [e.etat] : []), ...(e.alertes ?? []).map((n) => `alerte #${n} ouverte`)].join(", ")})`).join(", ")}`);
  if (verification === "echoue") raisons.push("la vérification de la mission ne passe pas");
  return { etat: raisons.length ? "incomplet" : "accepte", raisons, exigences, alertes };
}

const dollars = T.dollars;

export function formaterBilan(b: Bilan): string {
  const total = b.finis + b.vires + b.perdus;
  let ligne = `${b.finis}/${total} finis · ${b.vires} virés · ${b.perdus} perdus · dépensé ${dollars(b.depense, 4)} / seuil ${dollars(b.plafond, 2)} · ${relative(process.cwd(), b.run) || b.run}`;
  if (b.constat?.livrable) ligne += ` · livrable ${b.constat.livrable.present ? "ok" : "absent"}`;
  if (b.constat?.verification) {
    const suite = b.constat.verifications ?? [];
    const rang = suite.length > 1 ? ` (${suite.length}${suite[suite.length - 1]?.code === 0 ? "" : "ᵉ en échec"})` : "";
    ligne += ` · vérification${rang} ${b.constat.verification.coupe ?? `code ${b.constat.verification.code}`}`;
  }
  if (b.endormis) ligne += ` · salle endormie : ${b.endormis} en veille à la fermeture`;
  if (b.restes) ligne += ` · ${b.restes} processus abandonné${b.restes > 1 ? "s" : ""} arrêté${b.restes > 1 ? "s" : ""}`;
  const pluriel = (n: number, mot: string) => `${n} ${mot}${n > 1 ? "s" : ""}`;
  if (b.outils) {
    const o = b.outils;
    ligne += `\noutils : ${pluriel(o.appels, "appel")} · ${o.inconnus} ${o.inconnus > 1 ? "noms inconnus" : "nom inconnu"} · ${o.refus} refus (${pluriel(o.repetes, "répété")})`
      + ` · bash : ${o.bash.bunTest} bun test, ${o.bash.gitLog} git log, ${o.bash.sqlite3} sqlite3`;
  }
  if (b.etat) ligne += `\nrun ${b.etat === "accepte" ? "accepté" : `incomplet : ${(b.raisonsEtat ?? []).join(" ; ")}`}`;
  if (b.exigencesNonSatisfaites?.length)
    ligne += `\nexigences non satisfaites : ${b.exigencesNonSatisfaites.map((e) => `${e.libelle} (${[...(e.etat !== "attestée" ? [e.etat] : []), ...(e.alertes ?? []).map((n) => `alerte #${n} ouverte`)].join(", ")})`).join(", ")}`;
  if (b.alertesOuvertes?.length) ligne += `\nalertes ouvertes : ${b.alertesOuvertes.map((a) => `#${a.ticket} « ${a.titre} »${a.charge ? ` (${a.charge})` : ""}`).join(", ")}`;
  if (b.rejeuxSansObjet?.length) ligne += `\ndemandes de rejeu closes sans reçu à la fermeture : ${b.rejeuxSansObjet.map((n) => `#${n}`).join(", ")}`;
  if (b.passations?.length)
    ligne += `\nsièges repris : ${b.passations.map((p) => `${NOMS_ROLES[p.role]} ${T.deNom(p.sortant)} à ${p.entrant} (${p.motif}${p.note ? ", avec sa note" : ""}${p.livre ? "" : ", état non livré"})`).join(", ")}`;
  if (b.lecons?.length)
    ligne += `\nleçons proposées (archivées, jamais relues par un autre run) :\n${b.lecons.map((l) => `- ${l.agent}${l.role ? ` (${NOMS_ROLES[l.role as Role] ?? l.role})` : ""} : ${l.texte}`).join("\n")}`;
  if (b.engagements?.length)
    ligne += `\nengagements de la mission (non attestés, sans effet sur l'acceptation) :\n${b.engagements.map((e) => `- ${e}`).join("\n")}`;
  if (b.jalons?.length) ligne += `\njalons : ${b.jalons.map((j) => `${j.exigence} (${P.texteJalons(j)})`).join(", ")}${b.decoupageNonJuge ? " ; découpage non jugé (validé sans contrôleur présent)" : ""}`;
  if (b.reveils) ligne += `\nréveils : ${Object.entries(b.reveils).map(([a, n]) => `${a} ${n}`).join(", ")}`;
  if (b.invalidees?.length) // une alerte invalidée garde ses deux conclusions
    ligne += "\n" + b.invalidees.map((i) => `alerte #${i.ticket} invalidée : l'alerte de ${i.auteur} (${i.alerte}) ne passait pas, la contre-preuve de ${i.demandeur} (${i.contrePreuve}) passe, reçu ${i.recu}`).join("\n");
  if (b.parCote) {
    ligne += "\n" + b.parCote.map((c) => `${c.cote} · ${nomCourt(c.modele)} : ${dollars(c.cout, 4)} · ${pluriel(c.agents, "agent")} · ${pluriel(c.messages, "message")} · ${pluriel(c.appels, "appel")}`).join("  |  ");
  }
  return ligne;
}

// Notification macOS, ignorée sous test ou si osascript manque.
function notifier(message: string): void {
  if (TEST) return;
  try {
    Bun.spawn(["osascript", "-e", `display notification ${JSON.stringify(message)} with title "Essaim"`], { stdout: "ignore", stderr: "ignore" });
  } catch { /* pas de notification, pas grave */ }
}

const AIDE = `essaim : lancer un essaim d'agents pi sur une mission

usage : bun src/lancer.ts --agents N --modele ALIAS --plafond DOLLARS --mission FICHIER.md [options]

  --agents N            nombre d'agents (1 au moins, 20 au plus au total : un prénom du calendrier chacun) ; un siège
                        relancé (run à rôles) prend le premier prénom libre, du calendrier puis de la relève
  --modele ALIAS        alias de modeles.yaml (gemini-flash, deepseek-flash, faux) ou id complet
  --modele-femmes ALIAS second modèle : les agentes (Agathe, Brigitte…), à parts égales avec les hommes,
                        arrondi aux hommes ; dans la même salle, sur le même livrable, un bilan par côté ;
                        refusé avec une mission typée (## Type) : --modele-role
  --modele-role ROLE=ALIAS
                        le modèle d'un rôle (chef, integrateur, constructeur, recette, gardien), répétable ;
                        les autres rôles prennent --modele ; mission avec une section « ## Type » seulement
  --plafond DOLLARS     seuil de dépense observée : au-delà, tout le monde est coupé
  --mission FICHIER     mission Markdown avec une section « ## C'est fini quand » ; une section « ## Type » (fichier,
                        document, jeu, application, simulation, probleme) fait attribuer les rôles par le lanceur
                        selon le gabarit du type (--agents au moins le gabarit ; au-delà, des constructeurs)
  --fichier CHEMIN      document d'entrée, répétable ; 50 Ko par fichier, 150 Ko en tout, texte UTF-8 ou Markdown ;
                        copié dans <run>/entrees/, donné aux agents comme donnée ({ENTREES}), envoyé au fournisseur
  --reflexion NIVEAU    off, minimal, low, medium, high, xhigh, max (défaut : celui de l'alias)
  --silence MINUTES     silence toléré sans événement (défaut 15)
  --outil-max MINUTES   durée maximale d'un appel d'outil (défaut 10)
  --compactage SEUILS   se résumer : avis/avertissement/coupure en tokens, suffixes k et M (défaut 80k/120k/160k) ;
                        « non » pour un run sans l'outil moi_resumer
  --memoire non         run témoin : ni état, ni ligne courte, ni salle_chercher ; les faits sont notés
  --sans-bac-a-sable    ne pas envelopper pi dans sandbox-exec (tests avec le faux pi seulement)
  --sans-preparation    run à rôles : les constructeurs démarrent tout de suite, sans attendre le plan contrôlé
  --help                cette aide

variable d'environnement :
  ESSAIM_CHANGEMENTS_SIEGE_MAX
                        run à rôles : changements d'occupant d'un siège au plus, après une panne ou une
                        passation (défaut 2) ; au-delà, le siège n'est plus relancé
`;

if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      agents: { type: "string" }, modele: { type: "string" }, "modele-femmes": { type: "string" }, "modele-role": { type: "string", multiple: true }, plafond: { type: "string" }, mission: { type: "string" },
      fichier: { type: "string", multiple: true }, reflexion: { type: "string" }, silence: { type: "string" }, "outil-max": { type: "string" },
      compactage: { type: "string" }, memoire: { type: "string" }, "sans-bac-a-sable": { type: "boolean", default: false }, "sans-preparation": { type: "boolean", default: false }, help: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.help) {
    console.log(AIDE);
    process.exit(0);
  }
  const nombre = (v: string | undefined) => (v === undefined ? undefined : Number(v));
  try {
    if (!values.modele || !values.mission) throw new Error("--modele et --mission sont obligatoires (--help pour l'aide)");
    const bilan = await lancer({
      agents: nombre(values.agents) ?? 1, modele: values.modele, modeleFemmes: values["modele-femmes"], plafond: nombre(values.plafond) ?? 0, mission: values.mission,
      reflexion: values.reflexion, silenceMin: nombre(values.silence), outilMaxMin: nombre(values["outil-max"]),
      sansBacASable: values["sans-bac-a-sable"], fichiers: values.fichier, preparation: !values["sans-preparation"],
      compactage: values.compactage === undefined ? undefined : lireCompactage(values.compactage),
      memoire: values.memoire === undefined ? undefined : lireMemoire(values.memoire),
      modeleRole: values["modele-role"] === undefined ? undefined : lireModeleRole(values["modele-role"]),
    });
    console.log(formaterBilan(bilan));
    process.exit(0);
  } catch (e) {
    console.error(`essaim : ${(e as Error).message}`);
    process.exit(1);
  }
}
