// La caméra, côté coulisses : un serveur Bun sur 127.0.0.1 qui lit
// runs/*/tableau.sqlite (une connexion readonly par requête) et répond en JSON.
// Cinq actions seulement écrivent : fermer un run (un fichier « arret » que le lanceur
// lit, ou la clôture directe si le lanceur est mort), supprimer un run terminé, le
// mettre en pause et le reprendre (un fichier « pause » que le lanceur lit), parler au
// chef (un fichier dans consignes/ que le lanceur poste). Sert aussi vue/index.html.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import * as D from "./depot.ts";
import * as M from "./memoire.ts";
import * as P from "./preuves.ts";
import { repartiteur, ROLES } from "./roles.ts";
import { ouvrirBun } from "./tableau-bun.ts";
import * as T from "./tableau.ts";
import { aColonne, aTable, type Tableau } from "./tableau.ts";

export type OptionsServeur = { racine?: string; port?: number; hote?: string; portLivrables?: number; ecritDepuis?: EcritDepuis | null };
export type Serveur = { url: string; hote: string; port: number; urlLivrables: string; portLivrables: number; arreter(): void };

const RACINE_DEPOT = resolve(import.meta.dir, "..");
const NOM_RUN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/; // ni « / », ni nom caché (.verrou) ; « .. » exclu ci-dessous
const LIMITE_MAX = 200;   // messages par page
const LIMITE_TRACE = 500; // événements par page
const json = (corps: unknown, statut = 200) => new Response(JSON.stringify(corps), { status: statut, headers: { "content-type": "application/json; charset=utf-8" } });

export function validerRun(nom: string): boolean {
  return NOM_RUN.test(nom) && !nom.includes("..");
}

// La base d'un run en lecture seule, ou undefined si elle n'est pas prête (absente, vide, illisible).
function ouvrirLecture(racine: string, run: string): Tableau | undefined {
  const chemin = join(racine, "runs", run, "tableau.sqlite");
  if (!existsSync(chemin) || statSync(chemin).size === 0) return undefined;
  let t: Tableau | undefined;
  try {
    t = ouvrirBun(chemin, { lectureSeule: true });
    if (t.get("SELECT 1 FROM run")) return t; // la table existe dès l'initialisation, sa ligne seulement à l'ouverture du run
  } catch { /* illisible */ }
  t?.fermer();
  return undefined;
}

type LigneRun = { id: string; etat: string; mission_chemin: string | null; modele: string | null; plafond_usd: number | null; debut: string | null; fin: string | null; mission_texte?: string | null; bilan_json?: string | null };
type Agregats = { agents: number; actifs: number; finis: number; vires: number; perdus: number; appels: number; echecs: number; tokens_entree: number; tokens_sortie: number; cout_usd: number; cout_estime: number };

// Les résumés de lots des fils : leur coût (tentatives et échecs compris), estimé ou non, et les lots résumés.
// Un run d'avant les fils n'a pas la table : tout vaut zéro.
function resumesDeLots(t: Tableau): { cout: number; estime: number; faits: number } {
  if (!aTable(t, "lots")) return { cout: 0, estime: 0, faits: 0 };
  const r = t.get<{ cout: number; estime: number; faits: number }>("SELECT coalesce(sum(cout_usd), 0) AS cout, coalesce(max(cout_estime), 0) AS estime, coalesce(sum(etat = 'fait'), 0) AS faits FROM lots")!;
  return { cout: Math.round(r.cout * 1e6) / 1e6, estime: r.estime, faits: r.faits };
}

// cout_usd : la dépense du run, agents et résumés de lots ensemble, comme le seuil du lanceur la compte.
function agregats(t: Tableau): Agregats & { messages: number } {
  const a = t.get<Agregats>(`SELECT count(*) AS agents,
      sum(etat IN ('actif', 'dormant')) AS actifs, sum(etat = 'fini') AS finis, sum(etat = 'vire') AS vires, sum(etat = 'perdu') AS perdus,
      coalesce(sum(appels), 0) AS appels, coalesce(sum(echecs), 0) AS echecs,
      coalesce(sum(tokens_entree), 0) AS tokens_entree, coalesce(sum(tokens_sortie), 0) AS tokens_sortie,
      coalesce(sum(cout_usd), 0) AS cout_usd, coalesce(max(cout_estime), 0) AS cout_estime FROM agents`)!;
  const messages = t.get<{ n: number }>("SELECT count(*) AS n FROM messages")!.n;
  const r = resumesDeLots(t);
  return { ...a, actifs: a.actifs ?? 0, finis: a.finis ?? 0, vires: a.vires ?? 0, perdus: a.perdus ?? 0, messages, cout_usd: a.cout_usd + r.cout, cout_estime: Math.max(a.cout_estime, r.estime) };
}

const dureeS = (debut: string | null, fin: string | null) => debut ? Math.max(0, ((fin ? Date.parse(fin) : Date.now()) - Date.parse(debut)) / 1000) : 0;

// Les colonnes des deux modèles n'existent pas dans les runs d'avant, ouverts en lecture seule : on ne les lit
// que si PRAGMA table_info les montre (aColonne, src/tableau.ts), sinon NULL, sans jamais migrer une base (comme entrees_json).
const colonnesModele = (t: Tableau, alias: string) => aColonne(t, "agents", "cote") ? `${alias}.modele, ${alias}.cote` : "NULL AS modele, NULL AS cote";
// Les rôles des agents : le rôle du siège et le siège qu'un constructeur supplée, nuls sans rôles ou d'avant.
// « Qui écrit ici » rangé par état : les tickets ouverts de l'agent, ce qu'il attend et depuis quand il dort ;
// un tableau d'avant ces colonnes rend 0 et null.
const veilleEtTickets = (t: Tableau) => [
  aTable(t, "tickets") ? "(SELECT count(*) FROM tickets k WHERE k.charge = a.nom AND k.etat <> 'ferme') AS tickets_ouverts" : "0 AS tickets_ouverts",
  aColonne(t, "agents", "attend") ? "a.attend" : "NULL AS attend",
  aColonne(t, "agents", "endormi_le") ? "a.endormi_le" : "NULL AS endormi_le",
].join(", ");
const colonnesRole = (t: Tableau, alias: string) => aColonne(t, "agents", "role") ? `${alias}.role, ${alias}.suppleant_de` : "NULL AS role, NULL AS suppleant_de";
// Le second modèle du run, ou null : run à un modèle, ou run d'avant les deux modèles.
function modeleFemmes(t: Tableau): string | null {
  return aColonne(t, "run", "modele_femmes") ? t.get<{ f: string | null }>("SELECT modele_femmes AS f FROM run")?.f ?? null : null;
}

export function listerRuns(racine: string): unknown[] {
  const runs = join(racine, "runs");
  if (!existsSync(runs)) return [];
  const noms = readdirSync(runs).filter((n) => validerRun(n) && statSync(join(runs, n)).isDirectory()).sort().reverse();
  return noms.map((id) => {
    const t = ouvrirLecture(racine, id);
    if (!t) return { id, etat: "en préparation", mission_chemin: null, modele: null, modele_femmes: null, plafond_usd: null, debut: null, fin: null, agents: 0, actifs: 0, finis: 0, vires: 0, perdus: 0, messages: 0, appels: 0, tokens_entree: 0, tokens_sortie: 0, cout_usd: 0, cout_estime: false };
    try {
      const r = t.get<LigneRun>("SELECT id, etat, mission_chemin, modele, plafond_usd, debut, fin FROM run")!;
      const a = agregats(t);
      return { ...r, modele_femmes: modeleFemmes(t), id, ...a, cout_estime: !!a.cout_estime };
    } finally {
      t.fermer();
    }
  });
}

// Seulement pour un run à rôles (colonne agents.role) où tournent au moins deux modèles ; sinon null.
function parModeleDesRoles(t: Tableau): T.ModeleBilan[] | null {
  if (modeleFemmes(t) || !aColonne(t, "agents", "role") || !aColonne(t, "agents", "modele")) return null;
  const p = T.parModele(t);
  return p.length > 1 ? p : null;
}

export function compteur(t: Tableau): unknown {
  const r = t.get<LigneRun>("SELECT id, etat, mission_chemin, mission_texte, modele, plafond_usd, debut, fin, bilan_json FROM run")!;
  const a = agregats(t);
  const plafond = r.plafond_usd ?? 0;
  const femmes = modeleFemmes(t);
  const resumes = resumesDeLots(t);
  const presences = aTable(t, "presences");
  return {
    id: r.id, etat: r.etat, debut: r.debut, fin: r.fin, duree_s: dureeS(r.debut, r.fin), modele: r.modele, modele_femmes: femmes, mission_chemin: r.mission_chemin, mission_texte: r.mission_texte,
    plafond_usd: plafond, cout_usd: a.cout_usd, cout_estime: !!a.cout_estime, reste_usd: Math.max(0, plafond - a.cout_usd),
    cout_resumes_usd: resumes.cout, resumes: resumes.faits, // la part des résumés de fils dans cout_usd, et les lots résumés
    tokens_entree: a.tokens_entree, tokens_sortie: a.tokens_sortie, appels: a.appels, echecs: a.echecs,
    agents: a.agents, actifs: a.actifs, finis: a.finis, vires: a.vires, perdus: a.perdus, messages: a.messages,
    bilan: r.bilan_json ? JSON.parse(r.bilan_json) : null,
    lanceur: constatLanceur(t), // livrable, vérification, entrées : ce que le lanceur a constaté, ou null
    fin_run: finDuRun(t), // rôles : accepté ou incomplet, l'heure et la raison du constat, ou null
    par_cote: femmes ? T.parCote(t) : null, // run à deux modèles : activité et dépense de chaque côté
    par_modele: parModeleDesRoles(t), // run à rôles sur plusieurs modèles (--modele-role) : activité et dépense de chaque modèle

    // qui est là, dans l'ordre d'entrée : les écrans Fils et Agents en ont besoin à chaque tick, vingt agents au plus ;
    // fil : celui où l'agent s'est isolé, et s'il s'y fait réveiller par tout message du fil (reveil_fil)
    equipe: t.all<{ reveil_fil: number | null }>(`SELECT a.nom, a.surnom, a.etat, a.raison_sortie, a.passes, a.cout_usd, a.derniere_activite, ${colonnesModele(t, "a")}, ${colonnesRole(t, "a")},
      (SELECT count(*) FROM messages m WHERE m.auteur = a.nom) AS messages,
      (SELECT coalesce(e.outil, e.type) FROM evenements e WHERE e.agent = a.nom ORDER BY e.id DESC LIMIT 1) AS derniere_action,
      ${veilleEtTickets(t)},
      ${presences ? "(SELECT f.nom FROM presences p JOIN fils f ON f.id = p.fil_id WHERE p.agent = a.nom) AS fil, (SELECT p.reveil_fil FROM presences p WHERE p.agent = a.nom) AS reveil_fil" : "NULL AS fil, NULL AS reveil_fil"}
      FROM agents a ORDER BY a.rowid`).map((a) => ({ ...a, reveil_fil: a.reveil_fil === 1 })),
  };
}

// Le dernier événement de chaque type tracé sous l'auteur conventionnel « lanceur » ; null s'il n'y en a aucun.
function constatLanceur(t: Tableau): Record<string, unknown> | null {
  const dernier = (type: string) => t.get<Record<string, unknown>>("SELECT horodatage, outil, resultat_resume, duree_ms, erreur FROM evenements WHERE agent = 'lanceur' AND type = ? ORDER BY id DESC LIMIT 1", [type]) ?? null;
  const c = { livrable: dernier("livrable"), verification: dernier("verification"), entrees: dernier("entrees") };
  return c.livrable || c.verification || c.entrees ? c : null;
}

// Le constat du run : l'événement « constat » que le lanceur pose une fois, « run accepté : … » ou « run
// incomplet : … », lu en état, heure et raison courte ; et les réveils de la salle endormie sur une alerte ouverte
// (reveil_alerte) : l'heure, les alertes, les agents nommés. null sans rôles, ou tant que le lanceur n'a rien constaté.
// Les raisons, exigences non satisfaites, alertes ouvertes et réveils par agent sont dans le bilan.
function finDuRun(t: Tableau): { etat: "accepte" | "incomplet"; le: string; raison: string; reveils_alerte: Array<{ le: string; alertes: string; noms: string[] }> } | null {
  const e = t.get<{ horodatage: string; resultat_resume: string | null }>("SELECT horodatage, resultat_resume FROM evenements WHERE agent = 'lanceur' AND type = 'constat' ORDER BY id DESC LIMIT 1");
  const m = e?.resultat_resume?.match(/^run (accepté|incomplet) : (.*)$/s);
  if (!e || !m) return null;
  const reveils_alerte = t.all<{ le: string; texte: string | null }>("SELECT horodatage AS le, resultat_resume AS texte FROM evenements WHERE agent = 'lanceur' AND type = 'reveil_alerte' ORDER BY id")
    .flatMap((r) => { const x = r.texte?.match(/^salle endormie, alertes? ouvertes? (.+) : (.+?) nommés?$/); return x ? [{ le: r.le, alertes: x[1]!, noms: x[2]!.split(", ") }] : []; });
  return { etat: m[1] === "accepté" ? "accepte" : "incomplet", le: e.horodatage, raison: m[2]!, reveils_alerte };
}

// Les sièges et les leçons, pour l'onglet Mémoire, en lecture seule. sieges : chaque changement
// d'occupant (agents.remplace), dans l'ordre d'entrée : le rôle, le sortant et sa sortie (passation, ou la panne), sa note
// (passations) s'il en a laissé une, les tickets repris, et si l'entrant a reçu l'état du siège ; releves : les tickets
// d'un agent sorti sans successeur, rendus à celui qui répartit (notes « transféré … à … (raison) » de la salle), groupés
// par sortie ; lecons : les leçons proposées, archivées. Un run d'avant les rôles rend des listes vides.
export function passationsEtLecons(t: Tableau) {
  const transferts = (aTable(t, "ticket_notes") ? t.all<{ ticket_id: number; cree_le: string; texte: string }>("SELECT ticket_id, cree_le, texte FROM ticket_notes WHERE auteur = 'salle' AND texte LIKE 'transféré %' ORDER BY id") : [])
    .flatMap((n) => { const m = n.texte.match(/^transféré d(?:e |')(\S+) à (\S+) \((.*)\)$/s); return m ? [{ ticket: n.ticket_id, le: n.cree_le, de: m[1]!, vers: m[2]!, raison: m[3]! }] : []; });
  const notes = aTable(t, "passations");
  const sieges = aColonne(t, "agents", "remplace") ? t.all<{ role: string | null; sortant: string; entrant: string; le: string | null; etat_sortant: string | null; motif: string | null }>(
    `SELECT ${aColonne(t, "agents", "role") ? "a.role" : "NULL AS role"}, a.remplace AS sortant, a.nom AS entrant, a.debut AS le, s.etat AS etat_sortant, s.raison_sortie AS motif
     FROM agents a LEFT JOIN agents s ON s.nom = a.remplace WHERE a.remplace IS NOT NULL ORDER BY a.rowid`).map((s) => {
    const note = notes ? t.get<{ texte: string; cree_le: string }>("SELECT texte, cree_le FROM passations WHERE entrant = ? ORDER BY id DESC LIMIT 1", [s.entrant]) : undefined;
    const livre = !!t.get("SELECT 1 FROM evenements WHERE agent = ? AND type = 'succession' AND resultat_resume LIKE 'état du siège livré%'", [s.entrant]);
    return { ...s, note: note ? { texte: note.texte, le: note.cree_le } : null, livre, tickets: transferts.filter((x) => x.de === s.sortant && x.vers === s.entrant).map((x) => x.ticket) };
  }) : [];
  const releves: Array<{ de: string; vers: string; raison: string; le: string; tickets: number[] }> = [];
  for (const x of transferts) {
    if (sieges.some((s) => s.sortant === x.de && s.entrant === x.vers)) continue;
    const r = releves.find((y) => y.de === x.de && y.vers === x.vers && y.raison === x.raison);
    if (r) r.tickets.push(x.ticket); else releves.push({ de: x.de, vers: x.vers, raison: x.raison, le: x.le, tickets: [x.ticket] });
  }
  const lecons = T.leconsDuRun(t).map((l) => ({ id: l.id, agent: l.agent, role: l.role, le: l.cree_le, texte: l.texte }));
  return { sieges, releves, lecons };
}

// Les fils : pour un fil de concentration, pourquoi il s'est ouvert, qui l'a ouvert (lu dans l'annonce de la
// salle, la dernière ouverture compte), sa conclusion, qui y est (presents, assoupi) et ses lots résumés ; hors_fil,
// par auteur et par message, marque ce qui y a été posté de dehors. Un run d'avant les fils rend ces champs vides.
// La vue légère : avec `versions` (le paramètre v, même vide), la réponse est
// découpée en trois parts (fils sans leurs lots, lots par fil, tickets sans description ni historique : `nb_evenements` ;
// le ticket entier se lit par /tickets/<id>), chacune avec son empreinte ; une part dont la vue a déjà l'empreinte n'est pas
// renvoyée, pour ne pas relire toutes les 2 s des données inchangées. Sans v : la réponse entière.
export type Versions = { fils?: string; lots?: string; tickets?: string };
const empreinte = (x: unknown) => Bun.hash(JSON.stringify(x)).toString(36);
export function fils(t: Tableau, depuis: number, limite: number, versions?: Versions): unknown {
  const concentration = aColonne(t, "fils", "ouvert_le");
  const horsFil = aColonne(t, "messages", "hors_fil");
  const listeFils = t.all<{ id: number; nom: string; messages: number; pourquoi: string | null; conclusion: string | null; ouvert_le: string | null; ferme_le: string | null }>(
    `SELECT f.id, f.nom, (SELECT count(*) FROM messages m WHERE m.fil_id = f.id) AS messages,
       ${concentration ? "f.pourquoi, f.conclusion, f.ouvert_le, f.ferme_le" : "NULL AS pourquoi, NULL AS conclusion, NULL AS ouvert_le, NULL AS ferme_le"} FROM fils f ORDER BY f.id`);
  const presents = new Map(T.presences(t).map((p) => [p.fil, p]));
  const lecteurs = lecteursDesLots(t);
  const parFil = listeFils.map((f) => ({
    ...f,
    ouvert_par: f.ouvert_le ? ouvertPar(t, f.nom) : null,
    presents: presents.get(f.nom)?.presents ?? [],
    assoupi: presents.get(f.nom)?.assoupi ?? false,
    lots: lotsDuFil(t, f.id, lecteurs),
    agents: t.all<{ nom: string; messages: number; hors_fil: number }>(`SELECT auteur AS nom, count(*) AS messages, ${horsFil ? "sum(hors_fil)" : "0"} AS hors_fil FROM messages WHERE fil_id = ? GROUP BY auteur ORDER BY auteur`, [f.id]),
    // qui est dedans : ceux qui y ont écrit, dans l'ordre de leur premier message ; la salle n'est pas un agent
    dedans: t.all<{ auteur: string }>("SELECT auteur FROM messages WHERE fil_id = ? AND auteur <> 'salle' GROUP BY auteur ORDER BY min(id)", [f.id]).map((a) => a.auteur),
  }));
  const lus = t.all<{ id: number; fil: string; auteur: string; cree_le: string; texte: string; hors_fil: number }>(
    `SELECT m.id, f.nom AS fil, m.auteur, m.cree_le, m.texte, ${horsFil ? "m.hors_fil" : "0 AS hors_fil"} FROM messages m JOIN fils f ON f.id = m.fil_id WHERE m.id > ? ORDER BY m.id LIMIT ?`, [depuis, limite + 1]);
  const messages = lus.slice(0, limite).map((m) => ({ ...m, hors_fil: m.hors_fil === 1 })), reste = lus.length > limite;
  if (!versions) return { fils: parFil, tickets: filsDeTickets(t), messages, reste };
  const parts = {
    fils: parFil.map(({ lots: _lots, ...f }) => f),
    lots: Object.fromEntries(parFil.map((f) => [f.nom, f.lots])),
    tickets: filsDeTickets(t).map(({ evenements, description: _d, ...k }) => ({ ...k, nb_evenements: evenements.length })),
  };
  const nouvelles = { fils: empreinte(parts.fils), lots: empreinte(parts.lots), tickets: empreinte(parts.tickets) };
  const changees = Object.fromEntries((Object.keys(parts) as (keyof Versions)[]).filter((k) => versions[k] !== nouvelles[k]).map((k) => [k, parts[k]]));
  return { ...changees, versions: nouvelles, messages, reste };
}

// Un ticket et son historique (vue légère) : ce que la liste ne porte plus ; null pour un numéro inconnu.
export function ticketDuFil(t: Tableau, id: number): unknown {
  return filsDeTickets(t).find((k) => k.id === id) ?? null;
}

// Un fil par ticket : les agents n'ont plus d'outil de fil, c'est la vue qui range la conversation par sujet.
// Pour chaque ticket, sa carte, puis dans l'ordre du temps : son ouverture et ses changements (les annonces du fil tickets,
// « [ticket #N · type] » puis « [ticket #N] »), et les messages qui le citent (« #N », « ticket #N ») dans tous les fils,
// annonces des autres tickets comprises. #1E7F4E (une couleur) ou &#1; (une entité) ne citent rien. Sans annonce (un
// tableau sans gabarit d'annonce), les notes du ticket en tiennent lieu, sans numéro de message.
const ANNONCE_TICKET = /^\[ticket #(\d+)( · [^\]]*)?\]/;
const CITATION_TICKET = /(?<![\p{L}\p{N}_&#])#(\d{1,6})(?![\p{L}\p{N}_])/gu;
type EvenementTicket = { genre: "ouverture" | "changement" | "citation"; id: number | null; fil: string | null; auteur: string; cree_le: string; texte: string };
function filsDeTickets(t: Tableau): Array<{ id: number; evenements: EvenementTicket[] } & Record<string, unknown>> {
  if (!aTable(t, "tickets") || !aTable(t, "ticket_notes")) return [];
  const tickets = t.all<{ id: number; type: string; etat: string; titre: string; description: string | null; auteur: string; charge: string | null; commit_ferme: string | null; cree_le: string }>(
    "SELECT id, type, etat, titre, description, auteur, charge, commit_ferme, cree_le FROM tickets ORDER BY id");
  const roles = ticketsAvecRoles(t);
  const parTicket = new Map<number, EvenementTicket[]>(tickets.map((k) => [k.id, []]));
  const ajouter = (n: number, e: EvenementTicket) => parTicket.get(n)?.push(e);
  for (const m of t.all<{ id: number; fil: string; auteur: string; cree_le: string; texte: string }>(
    "SELECT m.id, f.nom AS fil, m.auteur, m.cree_le, m.texte FROM messages m JOIN fils f ON f.id = m.fil_id WHERE instr(m.texte, '#') > 0 ORDER BY m.id")) {
    const annonce = m.fil === "tickets" ? m.texte.match(ANNONCE_TICKET) : null;
    const propre = annonce ? Number(annonce[1]) : undefined;
    if (annonce) ajouter(propre!, { genre: annonce[2] ? "ouverture" : "changement", id: m.id, fil: m.fil, auteur: m.auteur, cree_le: m.cree_le, texte: m.texte });
    const cites = new Set([...m.texte.slice(annonce ? annonce[0].length : 0).matchAll(CITATION_TICKET)].map((c) => Number(c[1])));
    for (const n of cites) if (n !== propre) ajouter(n, { genre: "citation", id: m.id, fil: m.fil, auteur: m.auteur, cree_le: m.cree_le, texte: m.texte });
  }
  const notes = t.all<{ ticket_id: number; auteur: string; cree_le: string; texte: string }>("SELECT ticket_id, auteur, cree_le, texte FROM ticket_notes ORDER BY id");
  return tickets.map((k) => {
    const evenements = parTicket.get(k.id)!;
    if (!evenements.some((e) => e.genre !== "citation"))
      notes.filter((n) => n.ticket_id === k.id).forEach((n, i) => evenements.push({ genre: i === 0 ? "ouverture" : "changement", id: null, fil: null, auteur: n.auteur, cree_le: n.cree_le, texte: n.texte }));
    evenements.sort((a, b) => (a.cree_le < b.cree_le ? -1 : a.cree_le > b.cree_le ? 1 : (a.id ?? 0) - (b.id ?? 0)));
    const dedans = [...new Set(evenements.map((e) => e.auteur).filter((a) => a !== "salle"))]; // qui est dedans, dans l'ordre d'arrivée
    return { ...k, ...roles.get(k.id)!, agents: [...new Set(evenements.map((e) => e.auteur))].sort(), dedans, evenements };
  });
}

// Les rôles sur un ticket, lus dans ses colonnes et ses notes : la sorte (travail d'avant les rôles), le
// motif de clôture et son successeur, la reproduction figée d'une alerte, qui l'a confié (l'auteur de la dernière note
// « confié à »), les chargés successifs (ouverture, « confié à », « transféré … à »), la raison d'une annulation, le reçu
// d'une alerte fermée et la dernière demande de rejeu. Un tableau d'avant les colonnes rend ces champs vides.
export type RolesTicket = { sorte: string; motif: string | null; remplace_par: number | null; bloque_par: number | null; reproduction: unknown;
  confie_par: string | null; charges: string[]; note_cloture: string | null; recu: string | null; rejeu: Record<string, unknown> | null };
function ticketsAvecRoles(t: Tableau): Map<number, RolesTicket> {
  const colonnes = aColonne(t, "tickets", "sorte") ? "sorte, motif, remplace_par, bloque_par, reproduction" : "'travail' AS sorte, NULL AS motif, NULL AS remplace_par, NULL AS bloque_par, NULL AS reproduction";
  const notes = t.all<{ ticket_id: number; auteur: string; texte: string }>("SELECT ticket_id, auteur, texte FROM ticket_notes ORDER BY id");
  const lire = (brut: string | null) => { if (!brut) return null; try { return JSON.parse(brut); } catch { return null; } };
  // resultat : ce que le lanceur a rendu (passe, code, texte ; panne), nul tant que la demande attend
  const rejeux = aTable(t, "demandes_rejeu") ? t.all<{ ticket_id: number; resultat_json: string | null } & Record<string, unknown>>(
    "SELECT ticket_id, motif, etat, recu, demandeur, cree_le, fini_le, resultat_json FROM demandes_rejeu WHERE ticket_id IS NOT NULL ORDER BY id")
    .map(({ resultat_json, ...r }) => ({ ...r, resultat: lire(resultat_json) })) : [];
  return new Map(t.all<{ id: number; sorte: string; motif: string | null; remplace_par: number | null; bloque_par: number | null; reproduction: string | null }>(`SELECT id, ${colonnes} FROM tickets ORDER BY id`).map((k) => {
    let confie_par: string | null = null, note_cloture: string | null = null, recu: string | null = null;
    const charges: string[] = [];
    for (const n of notes.filter((x) => x.ticket_id === k.id)) {
      const confie = n.texte.match(/confié à ([^\s,;()]+)/), transfere = n.texte.match(/^transféré d(?:e |')\S+ à ([^\s,;()]+)/);
      if (confie) confie_par = n.auteur;
      const vers = transfere?.[1] ?? confie?.[1];
      if (vers && charges.at(-1) !== vers) charges.push(vers);
      const ferme = n.texte.match(/^fermé \([^)]*\)(?: sur le reçu ([^;]+))?(?: ; (.*))?$/s);
      if (ferme) { recu = ferme[1]?.trim() ?? null; note_cloture = ferme[2]?.trim() || null; }
    }
    const rejeu = rejeux.filter((r) => r.ticket_id === k.id).at(-1);
    return [k.id, { sorte: k.sorte ?? "travail", motif: k.motif, remplace_par: k.remplace_par, bloque_par: k.bloque_par, reproduction: lire(k.reproduction),
      confie_par, charges, note_cloture, recu, rejeu: rejeu ? (({ ticket_id, ...r }) => r)(rejeu) : null }];
  }));
}

// Les exigences et leurs preuves, en lecture seule. Chaque exigence active : le texte de ses
// phrases, son état prouvé (P.etatDesExigences : attestee, a_rejouer, rejeu_echoue, perimee, non_verifiee, a_prouver ;
// le rejeu du lanceur, s'il a échoué), la signature qui vaut, le
// reçu signé et le dernier reçu rejoué pour elle, les alertes ouvertes qui la mettent en défaut (tickets.exigence,
// comme etatDuRun ; à défaut, colonne absente ou vide, celles qui la citent : « E5 » en mot entier dans le titre ou la
// description), les contestations ouvertes qui la visent et les
// appréciations, à part, jamais comptées. Puis le registre des reçus (runs/<run>/preuves/, dans l'ordre des demandes) avec
// leur signataire et leur péremption, les contestations ouvertes et toutes les attestations. Un run d'avant les preuves
// (tables absentes) ou sans rôles rend des listes vides.
const TABLES_PREUVES = ["phrases", "exigences", "contestations", "attestations", "appreciations", "demandes_rejeu", "tickets"];
export function exigencesEtPreuves(t: Tableau, runDir: string) {
  if (!TABLES_PREUVES.every((x) => aTable(t, x))) return { exigences: [], recus: [], contestations: [], attestations: [] };
  const numero = (chemin: string | null) => Number(chemin?.match(/(\d+)\.json$/)?.[1] ?? NaN);
  const attestations = t.all<{ id: number; exigence: string; agent: string; role: string; nature: string; recu: string | null; non_verifiee: number; portee: string; cree_le: string; revoquee_le: string | null }>(
    "SELECT id, exigence, agent, role, nature, recu, non_verifiee, portee, cree_le, revoquee_le FROM attestations ORDER BY id")
    .map(({ non_verifiee, revoquee_le, ...a }) => ({ ...a, non_verifiee: non_verifiee === 1, revoquee: revoquee_le !== null }));
  const actuel = P.releverActuel(runDir);
  const recus = t.all<{ recu: string }>("SELECT recu FROM demandes_rejeu WHERE recu IS NOT NULL ORDER BY id").flatMap(({ recu: chemin }) => {
    const r = P.lireRecu(runDir, chemin);
    if (!r) return [];
    const p = P.perime(r, runDir, actuel);
    return [{ n: r.n, chemin: P.cheminRecu(r.n), sorte: r.sorte, exigence: r.exigence ?? null, ticket: r.ticket ?? null, motif: r.motif ?? null, demandeur: r.demandeur,
      commande: r.commande, passe: r.passe, code: r.code, coupe: r.coupe ?? null, date: r.date, texte: r.texte, perime: p.perime, changes: p.changes,
      banc_change: p.changes.some((c) => c.startsWith("banc ")), rejoue: r.rejoue ?? null,
      signe_par: attestations.filter((a) => !a.revoquee && numero(a.recu) === r.n).map((a) => ({ agent: a.agent, role: a.role, exigence: a.exigence, nature: a.nature })) }];
  });
  const contestations = t.all<{ ticket: number; exigence: string | null; phrases: string; par: string; raison: string }>(
    "SELECT c.ticket_id AS ticket, c.exigence, c.phrases, c.par, c.raison FROM contestations c JOIN tickets k ON k.id = c.ticket_id WHERE k.etat <> 'ferme' ORDER BY c.id")
    .map((c) => ({ ...c, phrases: JSON.parse(c.phrases) as number[] }));
  const appreciations = t.all<{ id: number; exigence: string; agent: string; role: string; texte: string; portee: string }>("SELECT id, exigence, agent, role, texte, portee FROM appreciations ORDER BY id");
  const lien = aColonne(t, "tickets", "exigence") ? "exigence" : "NULL AS exigence";
  const alertes = aColonne(t, "tickets", "sorte") ? t.all<{ id: number; titre: string; description: string | null; exigence: string | null }>(`SELECT id, titre, description, ${lien} FROM tickets WHERE sorte = 'alerte' AND etat <> 'ferme' ORDER BY id`) : [];
  const phrases = T.phrases(t);
  const bref = (r: (typeof recus)[number] | undefined) => (r ? { n: r.n, passe: r.passe, date: r.date, perime: r.perime } : null);
  // Les jalons : une exigence découpée donne son compte et ses jalons (portée, état) ;
  // sa signature est celle de ses jalons, pas la sienne ; une alerte liée à un jalon s'affiche sous son parent.
  const portees = new Map(aColonne(t, "exigences", "parent") ? t.all<{ libelle: string; portee: string | null }>("SELECT libelle, portee FROM exigences WHERE parent IS NOT NULL").map((x) => [x.libelle, x.portee ?? ""]) : []);
  const exigences = P.etatDesExigences(t, runDir).map((e) => {
    const siennes = phrases.filter((p) => p.exigence === e.libelle);
    const ns = siennes.map((p) => p.n);
    const cite = new RegExp(`(?<![\\p{L}\\p{N}_])${e.libelle}(?![\\p{L}\\p{N}_])`, "u");
    const a = e.jalons ? undefined : e.attestation;
    return {
      libelle: e.libelle, classement: e.classement, responsable: e.responsable, phrases: ns, texte: siennes.map((p) => p.texte).join(" "),
      etat: e.etat, changes: e.changes ?? [], rejeu: e.rejeu ?? null,
      attestation: a ? { agent: a.agent, role: a.role, nature: a.nature, recu: a.recu, non_verifiee: a.non_verifiee === 1, portee: a.portee, cree_le: a.cree_le } : null,
      recu: a?.recu ? bref(recus.find((r) => r.n === numero(a.recu))) : null,
      dernier_recu: bref(recus.filter((r) => r.sorte === "exigence" && r.exigence === e.libelle).at(-1)),
      alertes_ouvertes: alertes.filter((k) => (k.exigence !== null ? k.exigence === e.libelle || T.parentDe(t, k.exigence) === e.libelle : cite.test(`${k.titre}\n${k.description ?? ""}`))).map((k) => ({ id: k.id, titre: k.titre })),
      jalons: e.jalons ? { attestes: e.jalons.attestes, total: e.jalons.total, liste: e.jalons.feuilles.map((f) => ({ libelle: f.libelle, portee: portees.get(f.libelle) ?? "", etat: f.etat })) } : null,
      contestations: contestations.filter((c) => c.exigence === e.libelle || (c.exigence === null && c.phrases.some((n) => ns.includes(n)))),
      appreciations: appreciations.filter((x) => x.exigence === e.libelle).map(({ exigence, ...x }) => x),
    };
  });
  return { exigences, recus, contestations, attestations };
}

// Qui a ouvert le fil : l'annonce « X ouvre q-neige : pourquoi » que la salle poste dans principal (T.entrer).
function ouvertPar(t: Tableau, fil: string): string | null {
  const prefixe = (texte: string) => texte.slice(0, texte.indexOf(` ouvre ${fil} : `));
  const a = t.get<{ texte: string }>("SELECT texte FROM messages WHERE auteur = 'salle' AND instr(texte, ?) > 0 ORDER BY id DESC LIMIT 1", [` ouvre ${fil} : `]);
  return a ? prefixe(a.texte) || null : null;
}

// Pour chaque lot, les agents à qui son résumé a été livré (événements resumes_livres), sans doublon, triés.
function lecteursDesLots(t: Tableau): Map<number, string[]> {
  const parLot = new Map<number, Set<string>>();
  for (const e of t.all<{ agent: string; resultat_resume: string | null }>("SELECT agent, resultat_resume FROM evenements WHERE type = 'resumes_livres'")) {
    let ids: unknown;
    try { ids = JSON.parse(e.resultat_resume ?? "[]"); } catch { continue; }
    if (Array.isArray(ids)) for (const id of ids) if (typeof id === "number") { if (!parLot.has(id)) parLot.set(id, new Set()); parLot.get(id)!.add(e.agent); }
  }
  return new Map([...parLot].map(([id, s]) => [id, [...s].sort()]));
}

function lotsDuFil(t: Tableau, filId: number, lecteurs: Map<number, string[]>): unknown[] {
  if (!aTable(t, "lots")) return [];
  return t.all<{ id: number; cout_estime: number }>(`SELECT l.id, l.debut_id, l.fin_id, l.etat, l.essais, l.texte, l.cout_usd, l.cout_estime, l.modele, l.cote, l.demande_par, l.cree_le, l.fait_le,
      (SELECT count(*) FROM messages m WHERE m.fil_id = l.fil_id AND m.id BETWEEN l.debut_id AND l.fin_id) AS messages
    FROM lots l WHERE l.fil_id = ? ORDER BY l.debut_id`, [filId]).map((l) => ({ ...l, cout_estime: l.cout_estime === 1, lecteurs: lecteurs.get(l.id) ?? [] }));
}

// Filtres de la trace : la clé vient de l'URL, le fragment SQL est fixe (jamais de valeur concaténée).
const FILTRES_TYPE: Record<string, string> = {
  messages: "type = 'message_end'",
  outils: "type IN ('tool_execution_start', 'tool_execution_end')",
  echecs: "erreur IS NOT NULL",
  sorties: "type IN ('sortie', 'relance')",
  compactages: "(type IN ('compaction_end', 'resume_force') OR outil IN ('se_resumer', 'moi_resumer'))",
};
export const TYPES_TRACE = Object.keys(FILTRES_TYPE);

const COLONNES_EVENEMENT = "id, agent, horodatage, type, outil, appel_id, arguments_json, resultat_resume, duree_ms, tokens_entree, tokens_sortie, cout_usd, erreur";

// La fiche d'un employé : ligne d'agent, pancartes en cours, trace filtrée par type. undefined si l'agent n'existe pas.
export function ficheAgent(t: Tableau, nom: string, filtre: { type?: string; depuis: number; limite: number }): unknown {
  const agent = t.get<Record<string, unknown>>(`SELECT nom, surnom, etat, raison_sortie, fichier_livre, passes, debut, derniere_activite, cout_usd, cout_estime, tokens_entree, tokens_sortie, appels, echecs, ${colonnesModele(t, "a")}, ${colonnesRole(t, "a")},
      (SELECT count(*) FROM messages m WHERE m.auteur = a.nom) AS messages FROM agents a WHERE nom = ?`, [nom]);
  if (!agent) return undefined;
  const pancartes = t.all("SELECT chemin, raison, pose_le FROM reclamations WHERE agent = ? AND retire_le IS NULL ORDER BY id", [nom]);
  const condition = filtre.type ? ` AND ${FILTRES_TYPE[filtre.type]}` : "";
  const lus = t.all<{ id: number }>(`SELECT ${COLONNES_EVENEMENT} FROM evenements WHERE agent = ? AND id > ?${condition} ORDER BY id LIMIT ?`, [nom, filtre.depuis, filtre.limite + 1]);
  return { agent: { ...agent, cout_estime: !!agent.cout_estime }, pancartes, ...filEtAttente(t, nom), evenements: lus.slice(0, filtre.limite), reste: lus.length > filtre.limite };
}

// Les fils de concentration dans la fiche : le fil où il est, ce qui l'attend par fil (les messages des
// autres après son curseur, lectures), les résumés reçus (resumes_livres) et ceux qu'il a demandés en premier, qu'il paie.
function filEtAttente(t: Tableau, nom: string) {
  const p = aTable(t, "presences") ? t.get<{ fil: string; entre_le: string; reveil_fil: number }>(
    "SELECT f.nom AS fil, p.entre_le, p.reveil_fil FROM presences p JOIN fils f ON f.id = p.fil_id WHERE p.agent = ?", [nom]) : undefined;
  const en_attente = t.all<{ fil: string; n: number }>(`SELECT f.nom AS fil, count(*) AS n FROM messages m JOIN fils f ON f.id = m.fil_id
    LEFT JOIN lectures l ON l.agent = ? AND l.fil_id = m.fil_id
    WHERE m.id > coalesce(l.dernier_id, 0) AND m.auteur <> ? GROUP BY f.id ORDER BY f.id`, [nom, nom]);
  let recus = 0;
  for (const e of t.all<{ r: string | null }>("SELECT resultat_resume AS r FROM evenements WHERE agent = ? AND type = 'resumes_livres'", [nom])) {
    try { const ids = JSON.parse(e.r ?? "[]"); if (Array.isArray(ids)) recus += ids.length; } catch { /* trace illisible : ignorée */ }
  }
  const d = aTable(t, "lots") ? t.get<{ n: number; c: number }>("SELECT count(*) AS n, coalesce(sum(cout_usd), 0) AS c FROM lots WHERE demande_par = ?", [nom])! : { n: 0, c: 0 };
  return { fil: p ? { fil: p.fil, entre_le: p.entre_le, reveil_fil: p.reveil_fil === 1 } : null, en_attente, resumes: { recus, demandes: d.n, cout_demandes: Math.round(d.c * 1e6) / 1e6 } };
}

// La bande brute : tous les événements du run, filtrés par agent, outil et texte. Paramètres toujours liés par « ? ».
// role : les événements des agents qui tiennent ce rôle ; aucun dans un run sans la colonne.
export function evenements(t: Tableau, filtre: { agent?: string; role?: string; outil?: string; q?: string; depuis: number; limite: number }): unknown {
  const conditions = ["id > ?"];
  const params: unknown[] = [filtre.depuis];
  if (filtre.agent) { conditions.push("agent = ?"); params.push(filtre.agent); }
  if (filtre.role) {
    if (!aColonne(t, "agents", "role")) return { evenements: [], reste: false };
    conditions.push("agent IN (SELECT nom FROM agents WHERE role = ?)"); params.push(filtre.role);
  }
  if (filtre.outil) { conditions.push("outil = ?"); params.push(filtre.outil); }
  if (filtre.q) { // sous-chaîne ; lower() de SQLite ne couvre que l'ASCII, un accent majuscule ne matche pas sa minuscule
    conditions.push("instr(lower(coalesce(outil, '') || ' ' || coalesce(arguments_json, '') || ' ' || coalesce(resultat_resume, '') || ' ' || coalesce(erreur, '')), lower(?)) > 0");
    params.push(filtre.q);
  }
  params.push(filtre.limite + 1);
  const lus = t.all<{ id: number }>(`SELECT ${COLONNES_EVENEMENT} FROM evenements WHERE ${conditions.join(" AND ")} ORDER BY id LIMIT ?`, params);
  return { evenements: lus.slice(0, filtre.limite), reste: lus.length > filtre.limite };
}

// Le cerveau : ce que la vue dessine en 3D pour un essaim terminé. Une interaction, c'est nommer
// quelqu'un — le prénom ou le surnom en mot entier, la règle même qui réveille un dormeur (T.nomme) :
// nommer, c'est parler. Le texte des messages ne sort pas d'ici, seulement sa première ligne.
const premiereLigne = (texte: string | null, max: number) => (texte ?? "").split("\n")[0]!.replace(/^#+\s*/, "").replace(/\*\*/g, "").trim().slice(0, max);

export function cerveau(t: Tableau): unknown {
  const r = t.get<{ id: string; etat: string; debut: string | null; fin: string | null }>("SELECT id, etat, debut, fin FROM run")!;
  const t0 = r.debut ? Date.parse(r.debut) : NaN;
  const depuis = (iso: string | null) => (iso && Number.isFinite(t0) ? Date.parse(iso) - t0 : null); // ms depuis le début du run
  const agents = t.all<{ nom: string; surnom: string | null; etat: string; raison_sortie: string | null; cout_usd: number; appels: number; derniere_activite: string | null; messages: number; role: string | null }>(
    `SELECT a.nom, a.surnom, a.etat, a.raison_sortie, a.cout_usd, a.appels, a.derniere_activite, ${colonnesRole(t, "a")},
       (SELECT count(*) FROM messages m WHERE m.auteur = a.nom) AS messages FROM agents a ORDER BY a.rowid`); // ordre d'entrée, comme l'équipe
  const alias = agents.map((a) => ({ nom: a.nom, mots: [a.nom, a.surnom ?? ""].filter((m) => m.trim() !== "") }));
  const messages = t.all<{ id: number; fil: string; auteur: string; cree_le: string; texte: string }>(
    "SELECT m.id, f.nom AS fil, m.auteur, m.cree_le, m.texte FROM messages m JOIN fils f ON f.id = m.fil_id ORDER BY m.id")
    .map((m) => ({ id: m.id, t: depuis(m.cree_le), fil: m.fil, auteur: m.auteur, titre: premiereLigne(m.texte, 80),
      cibles: alias.filter((a) => a.nom !== m.auteur && a.mots.some((mot) => T.nomme(m.texte, mot))).map((a) => a.nom) }));
  const compte = new Map<string, { a: string; b: string; n: number }>();
  for (const m of messages) for (const b of m.cibles) { const k = `${m.auteur}→${b}`; const l = compte.get(k) ?? { a: m.auteur, b, n: 0 }; l.n++; compte.set(k, l); }
  const liens = [...compte.values()].sort((x, y) => y.n - x.n || x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
  return {
    id: r.id, etat: r.etat, debut: r.debut, fin: r.fin, duree_ms: Math.round(dureeS(r.debut, r.fin) * 1000),
    agents: agents.map((a) => ({ nom: a.nom, surnom: a.surnom, etat: a.etat, raison_sortie: premiereLigne(a.raison_sortie, 120), cout_usd: a.cout_usd, appels: a.appels, messages: a.messages, t_fin: depuis(a.derniere_activite), role: a.role })),
    messages, liens,
  };
}

// Le lanceur de ce run est-il vivant ? Il écrit « <pid> <run> » dans runs/.verrou tant qu'il tourne (un seul run à la
// fois ; le pid seul pendant qu'il prépare le dossier, qui vaut alors pour tous). Un lanceur vivant pour un autre run ne
// retient pas celui-ci : un run mort en plein vol (code 137) restait sinon « en cours » pour toujours.
function lanceurVivant(racine: string, run: string): boolean {
  const verrou = join(racine, "runs", ".verrou");
  if (!existsSync(verrou)) return false;
  const [brut, sien] = readFileSync(verrou, "utf8").trim().split(/\s+/);
  const pid = Number(brut);
  if (!Number.isInteger(pid) || pid <= 1 || (sien && sien !== run)) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export type Reponse = { statut: number; corps: { message?: string; erreur?: string } };

// Fermer un run : si le lanceur tourne, on lui laisse faire (fichier « arret », il vire tout le monde et clôt) ;
// sinon on clôt nous-mêmes la base, les agents encore « actifs » sont perdus.
export function fermerRun(racine: string, run: string): Reponse {
  const dossier = join(racine, "runs", run);
  const lecture = ouvrirLecture(racine, run);
  if (!lecture) return { statut: 503, corps: { erreur: "pas encore prêt" } };
  const etat = lecture.get<{ etat: string }>("SELECT etat FROM run")?.etat;
  lecture.fermer();
  if (etat !== "en_cours") return { statut: 409, corps: { erreur: "déjà terminé" } };
  if (lanceurVivant(racine, run)) {
    writeFileSync(join(dossier, "arret"), new Date().toISOString());
    return { statut: 202, corps: { message: "arrêt demandé, le lanceur ferme la salle" } };
  }
  const t = ouvrirBun(join(dossier, "tableau.sqlite"));
  try {
    t.transaction(() => {
      const raison = "lanceur absent, clos depuis la vue";
      for (const a of t.all<{ nom: string }>("SELECT nom FROM agents WHERE etat IN ('actif', 'dormant')")) {
        T.sortirAgent(t, a.nom, "perdu", raison);
        T.retirerPancartes(t, a.nom);
        T.ajouterEvenement(t, { agent: a.nom, type: "sortie", resultat: `perdu : ${raison}`, erreur: `perdu : ${raison}` });
      }
      // Fils de concentration : plus personne dans aucun fil, les fils ouverts fermés sans conclusion, les lots
      // restés pris sans résumeur en échec ; sans effet sur un run d'avant les fils.
      T.fermerFils(t, raison);
      T.lotsOrphelins(t);
      const b = t.get<{ finis: number; vires: number; perdus: number; depense: number; plafond: number }>(
        "SELECT sum(etat = 'fini') AS finis, sum(etat = 'vire') AS vires, sum(etat = 'perdu') AS perdus, coalesce(sum(cout_usd), 0) AS depense, (SELECT plafond_usd FROM run) AS plafond FROM agents")!;
      const r = resumesDeLots(t);
      b.depense = Math.round((b.depense + r.cout) * 1e6) / 1e6;
      const mixte = modeleFemmes(t) ? { parCote: T.parCote(t), ouvreur: t.get<{ cote: string }>("SELECT cote FROM agents ORDER BY rowid LIMIT 1")?.cote } : {};
      const resumes = r.cout > 0 || r.faits > 0 ? { resumes: { cout: r.cout, lots: r.faits } } : {};
      T.clore(t, { ...b, depassement: Math.max(0, b.depense - b.plafond), ...mixte, ...resumes, note: "clos depuis la vue, lanceur absent" });
    });
  } finally {
    t.fermer();
  }
  return { statut: 200, corps: { message: "clos" } };
}

// Mettre en pause ou reprendre un run : un fichier « pause » dans son dossier, que le lanceur lit à chaque
// tour. Seulement pour un run en cours dont le lanceur tourne : sans lanceur, personne ne tient la pause.
export function pauseRun(racine: string, run: string, pause: boolean): Reponse {
  const lecture = ouvrirLecture(racine, run);
  if (!lecture) return { statut: 503, corps: { erreur: "pas encore prêt" } };
  const etat = lecture.get<{ etat: string }>("SELECT etat FROM run")?.etat;
  lecture.fermer();
  if (etat !== "en_cours") return { statut: 409, corps: { erreur: "déjà terminé" } };
  if (!lanceurVivant(racine, run)) return { statut: 409, corps: { erreur: "le lanceur ne tourne plus" } };
  const fichier = join(racine, "runs", run, "pause");
  if (pause) writeFileSync(fichier, new Date().toISOString());
  else rmSync(fichier, { force: true });
  return { statut: 202, corps: { message: pause ? "pause demandée, les agents s'arrêtent après leur action en cours" : "reprise demandée" } };
}

// Parler au chef : une consigne déposée en fichier (<run>/consignes/<horodatage>.txt) que le
// lanceur poste à celui qui répartit le travail, comme la pause. Seulement pour un run en cours dont le lanceur tourne,
// et qui a quelqu'un pour répartir : le même calcul que le lanceur (repartiteur, suppléant qui tient le siège compris).
export const CONSIGNE_MAX = 600;
const repartiteurDuRun = (t: Tableau): { nom: string; role: string } | undefined => {
  if (!aColonne(t, "agents", "role")) return undefined;
  const equipe = t.all<{ nom: string; role: string | null; suppleant_de: string | null; etat: string }>("SELECT nom, role, suppleant_de, etat FROM agents ORDER BY rowid")
    .map((a) => ({ nom: a.nom, role: a.role, suppleantDe: a.suppleant_de, present: a.etat === "actif" || a.etat === "dormant" }));
  const r = repartiteur(equipe.filter((a) => a.present));
  return r ? { nom: r.nom, role: r.role } : undefined;
};
export function consigneRun(racine: string, run: string, texte: unknown): Reponse {
  if (typeof texte !== "string" || !texte.trim()) return { statut: 400, corps: { erreur: "consigne vide" } };
  if (texte.length > CONSIGNE_MAX) return { statut: 400, corps: { erreur: `consigne trop longue (${CONSIGNE_MAX} signes au plus)` } };
  const lecture = ouvrirLecture(racine, run);
  if (!lecture) return { statut: 503, corps: { erreur: "pas encore prêt" } };
  const etat = lecture.get<{ etat: string }>("SELECT etat FROM run")?.etat;
  const repartit = !!repartiteurDuRun(lecture);
  lecture.fermer();
  if (etat !== "en_cours") return { statut: 409, corps: { erreur: "déjà terminé" } };
  if (!lanceurVivant(racine, run)) return { statut: 409, corps: { erreur: "le lanceur ne tourne plus" } };
  if (!repartit) return { statut: 409, corps: { erreur: "personne ne répartit le travail dans ce run (ni chef ni intégrateur présent)" } };
  const dossier = join(racine, "runs", run, "consignes");
  mkdirSync(dossier, { recursive: true });
  // Écrite à côté puis renommée : le lanceur ne voit jamais un fichier à moitié écrit.
  const nom = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(join(dossier, `${nom}.tmp`), texte.trim());
  renameSync(join(dossier, `${nom}.tmp`), join(dossier, `${nom}.txt`));
  return { statut: 202, corps: { message: "consigne envoyée, le lanceur la transmet au chef" } };
}
// Les consignes : transmises ou écartées (relues dans le tableau), celles encore en attente du lanceur (texte et heure de
// dépôt, lus dans leur fichier), et celui qui les recevra.
function consignesDuRun(racine: string, run: string, t: Tableau): { transmises: T.Consigne[]; en_attente: Array<{ texte: string; le: string }>; destinataire: { nom: string; role: string } | null } {
  const dossier = join(racine, "runs", run, "consignes");
  const en_attente = (existsSync(dossier) ? readdirSync(dossier).filter((f) => f.endsWith(".txt")).sort() : []).flatMap((f) => {
    try { return [{ texte: readFileSync(join(dossier, f), "utf8"), le: new Date(Number(f.split("-")[0]) || 0).toISOString() }]; } catch { return []; } // transmis entre-temps
  });
  return { transmises: T.consignes(t), en_attente, destinataire: repartiteurDuRun(t) ?? null };
}

// Supprimer un run : jamais un run que le lanceur fait encore tourner.
export function supprimerRun(racine: string, run: string): Reponse {
  const dossier = join(racine, "runs", run);
  const lecture = ouvrirLecture(racine, run);
  const etat = lecture ? lecture.get<{ etat: string }>("SELECT etat FROM run")?.etat : undefined;
  lecture?.fermer();
  // Sans état (base pas encore prête), le lanceur est peut-être en train de le préparer : pas « terminé ».
  if ((etat === undefined || etat === "en_cours") && lanceurVivant(racine, run)) return { statut: 409, corps: { erreur: "encore en cours : ferme-le d'abord" } };
  rmSync(dossier, { recursive: true, force: true });
  return { statut: 200, corps: { message: "supprimé" } };
}

// Les livrables : ce que les agents ont écrit dans partage/. Lecture seule, confinée au dossier, servi
// sans exécution possible (un SVG peut porter un script : la CSP l'interdit).
const TYPES: Record<string, string> = { svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", md: "text/plain", txt: "text/plain", json: "application/json", csv: "text/plain", html: "text/html", htm: "text/html", js: "text/javascript", ts: "text/plain", py: "text/plain", css: "text/css", xml: "text/plain" };
const NOM_FICHIER = /^[A-Za-z0-9][A-Za-z0-9._ -]*$/;

// Un fichier de partage/, liens symboliques résolus : le bac à sable interdit à un agent de lire ~/.ssh, pas d'y
// poser un lien, et ce serveur n'est pas en bac à sable. Hors de partage/ une fois résolu, ou pas un fichier : undefined.
function fichierDePartage(racine: string, run: string, rel: string): string | undefined {
  try {
    const partage = realpathSync(join(racine, "runs", run, "partage"));
    const chemin = realpathSync(join(partage, rel));
    return chemin.startsWith(partage + "/") && statSync(chemin).isFile() ? chemin : undefined;
  } catch { return undefined; }
}

export function listerPartage(racine: string, run: string): Array<{ nom: string; taille: number; modifie: string }> {
  const dossier = join(racine, "runs", run, "partage");
  if (!existsSync(dossier)) return [];
  return readdirSync(dossier).filter((n) => NOM_FICHIER.test(n) && !n.includes("..") && fichierDePartage(racine, run, n)).sort()
    .map((nom) => { const st = statSync(join(dossier, nom)); return { nom, taille: st.size, modifie: st.mtime.toISOString() }; });
}

// Les documents d'entrée du run : ce que le lanceur a copié dans entrees/, avec l'empreinte d'origine et celle
// d'aujourd'hui ; un run d'avant les entrées n'a pas la colonne, la liste est vide.
export function entrees(racine: string, run: string, t: Tableau): Array<{ nom: string; taille: number; sha256: string; sha256_actuel: string | null; modifie: boolean }> {
  let brut: string | null;
  try { brut = t.get<{ e: string | null }>("SELECT entrees_json AS e FROM run")?.e ?? null; } catch { return []; }
  if (!brut) return [];
  return (JSON.parse(brut) as Array<{ nom: string; taille: number; sha256: string }>).map((e) => {
    const chemin = join(racine, "runs", run, "entrees", e.nom);
    const actuel = existsSync(chemin) ? createHash("sha256").update(readFileSync(chemin)).digest("hex") : null;
    return { ...e, sha256_actuel: actuel, modifie: actuel !== e.sha256 };
  });
}

// L'onglet Dépôt : les tickets et leur historique, les commits récents de main, les essais. Lecture
// seule : git n'est lancé que pour lire, jamais pour écrire. Un run d'avant le dépôt n'a ni dépôt ni tables : tout est vide.
export async function depot(racine: string, run: string, t: Tableau, limite = 50) {
  const essayer = <X>(f: () => X, defaut: X): X => { try { return f(); } catch { return defaut; } };
  const tickets = essayer(() => { const roles = ticketsAvecRoles(t); return T.listerTickets(t).map((k) => ({ ...T.lireTicket(t, k.id)!, ...roles.get(k.id)! })); },
    [] as Array<NonNullable<ReturnType<typeof T.lireTicket>> & RolesTicket>);
  const essais = essayer(() => T.essais(t), [] as T.Essai[]);
  const partage = join(racine, "runs", run, "partage");
  if (!existsSync(join(partage, ".git"))) return { depot: false, tickets, commits: { total: 0, liste: [], parAgent: {}, adoptions: {} }, essais: essais.map((e) => ({ ...e, commits: 0, dernier: null })) };
  const [liste, total, bilan] = await Promise.all([D.historique(partage, { limite, branche: D.BRANCHE }), D.git(partage, ["rev-list", "--count", D.BRANCHE]), D.bilanCommits(partage)]);
  const avecCommits = await Promise.all(essais.map(async (e) => {
    // Adopté : les commits que la fusion a apportés ; sinon, ce que la branche a de plus que main.
    const plage = e.adopte_hash ? `${e.adopte_hash}^1..${e.adopte_hash}^2` : `${D.BRANCHE}..essai/${e.nom}`;
    const n = Number((await D.git(partage, ["rev-list", "--count", "--no-merges", plage])).sortie.trim() || 0);
    const dernier = (await D.git(partage, ["log", "-1", "--format=%aI", `essai/${e.nom}`])).sortie.trim() || null;
    return { ...e, commits: n, dernier };
  }));
  return { depot: true, tickets, commits: { total: Number(total.sortie.trim() || 0), liste, parAgent: bilan.parAgent, adoptions: bilan.adoptions }, essais: avecCommits };
}

// L'onglet Mémoire (second cerveau) : les faits, les vérifications recalculées, ce que chaque agent a reçu
// (memoire_livraisons) et les appels à salle_chercher lus dans la bande. Trois curseurs indépendants ; lecture seule.
// Un run d'avant la mémoire (pas de table faits) : { absente: true }.
export type VerificationLue = { id: number; cree_le: string; agent: string; source: string; sujet: string | null; statut: string | null; texte: string; details: Record<string, unknown> };
export type RacinesRun = { partage: string; essais: Record<string, string> }; // details.racine : "partage" ou "essai:<nom>"
export type EcritDepuis = (t: Tableau, verif: VerificationLue, racines: RacinesRun, cache: M.Cache, jusquA: number) =>
  { rien: true; relu: string } | { rien: false; texte: string };
// M.ecritDepuis, adapté à cette signature ; une racine inconnue lève, et la vérification est laissée de
// côté comme une illisible.
export const ECRIT_DEPUIS: EcritDepuis | undefined = (t, v, racines, cache, jusquA) => {
  const r = M.ecritDepuis(t, { ...v, type: "verification", statut: v.statut as M.FaitLu["statut"], message_id: null }, racines, cache, jusquA);
  if (!r) throw new Error(`racine inconnue : ${String(v.details.racine)}`);
  return r.rien ? { rien: true, relu: r.relu } : { rien: false, texte: r.texte };
};

const MEMOIRE_MAX = 500; // faits, livraisons ou recherches par sondage
const racinesDuRun = (racine: string, run: string): RacinesRun => {
  const essais = join(racine, "runs", run, "essais");
  const noms = existsSync(essais) ? readdirSync(essais, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : [];
  return { partage: join(racine, "runs", run, "partage"), essais: Object.fromEntries(noms.map((n) => [n, join(essais, n)])) };
};
const lireJson = (brut: string | null): unknown => { if (brut === null) return null; try { return JSON.parse(brut); } catch { return brut; } };
// Une réponse de salle_chercher : refus, vide (« aucun … »), ou le nombre de résultats rendus — une ligne
// d'entrée par résultat, messages lus par numéro compris. La bande coupe à 4 000 caractères : le compte peut être bas.
function lireReponse(texte: string, erreur: string | null): { resultats: number; vide: boolean; refus: boolean } {
  if (erreur !== null || texte.startsWith("refusé")) return { resultats: 0, vide: false, refus: true };
  if (/^aucun (résultat|message n°|message du n°|fait n°)/.test(texte)) return { resultats: 0, vide: true, refus: false };
  const n = texte.split("\n").filter((l) => /^\[(message|résumé de lot|commit|fait|ticket)\] /.test(l) || /^\[[^\]]+\] message \d+, /.test(l)).length;
  return { resultats: n, vide: n === 0, refus: false };
}

export function memoire(t: Tableau, racines: RacinesRun, curseurs: { faits: number; livraisons: number; recherches: number },
  o: { ecritDepuis?: EcritDepuis; cache: M.Cache }): unknown {
  if (!aTable(t, "faits")) return { absente: true };
  const jusquA = t.get<{ n: number }>("SELECT coalesce(max(id), 0) AS n FROM faits")!.n; // lecture bornée d'abord
  const faits = t.all<Record<string, unknown> & { id: number; message_id: number | null; fil: string | null }>(
    `SELECT f.id, f.cree_le, f.type, f.agent, f.source, f.sujet, f.statut, f.texte, f.message_id, fi.nom AS fil FROM faits f
     LEFT JOIN messages m ON m.id = f.message_id LEFT JOIN fils fi ON fi.id = m.fil_id
     WHERE f.id > ? AND f.id <= ? ORDER BY f.id LIMIT ?`, [curseurs.faits, jusquA, MEMOIRE_MAX + 1])
    .map(({ fil, ...f }) => ({ ...f, message: f.message_id !== null && fil !== null ? { id: f.message_id, fil } : null }));
  const verifications: Array<{ id: number; perimee: boolean; texte: string }> = [];
  if (o.ecritDepuis) {
    for (const v of t.all<Omit<VerificationLue, "details"> & { details_json: string | null }>(
      "SELECT id, cree_le, agent, source, sujet, statut, texte, details_json FROM faits WHERE type = 'verification' AND id <= ? ORDER BY id", [jusquA])) {
      const { details_json, ...reste } = v;
      const details = lireJson(details_json);
      if (!details || typeof details !== "object") continue;
      try {
        const e = o.ecritDepuis(t, { ...reste, details: details as Record<string, unknown> }, racines, o.cache, jusquA);
        verifications.push(e.rien ? { id: v.id, perimee: false, texte: `rien écrit depuis (relu à ${e.relu})` } : { id: v.id, perimee: true, texte: e.texte });
      } catch { /* une vérification illisible ne casse pas l'onglet */ }
    }
  }
  const livraisons = aTable(t, "memoire_livraisons") ? t.all<Record<string, unknown> & { confirme_le: string | null }>(
    `SELECT id, agent, livre_le, moment, de_fait, a_fait, a_message, lignes, retires, caracteres, texte, confirme_le
     FROM memoire_livraisons WHERE id > ? ORDER BY id LIMIT ?`, [curseurs.livraisons, MEMOIRE_MAX + 1])
    .map((l) => ({ ...l, confirmee: l.confirme_le !== null })) : [];
  const recherches = t.all<{ id: number; agent: string; horodatage: string; appel_id: string | null; resultat_resume: string | null; erreur: string | null; arguments_json: string | null }>(
    `SELECT e.id, e.agent, e.horodatage, e.appel_id, e.resultat_resume, e.erreur,
       (SELECT d.arguments_json FROM evenements d WHERE d.agent = e.agent AND d.appel_id = e.appel_id AND d.type = 'tool_execution_start' AND d.id < e.id ORDER BY d.id DESC LIMIT 1) AS arguments_json
     FROM evenements e WHERE e.outil = 'salle_chercher' AND e.type = 'tool_execution_end' AND e.id > ? ORDER BY e.id LIMIT ?`, [curseurs.recherches, MEMOIRE_MAX + 1])
    .map((e) => ({ id: e.id, agent: e.agent, horodatage: e.horodatage, parametres: lireJson(e.arguments_json), reponse: e.resultat_resume ?? "", ...lireReponse(e.resultat_resume ?? "", e.erreur) }));
  const garder = <X extends { id: number }>(l: X[], de: number) => ({ liste: l.slice(0, MEMOIRE_MAX), reste: l.length > MEMOIRE_MAX, curseur: l.slice(0, MEMOIRE_MAX).at(-1)?.id ?? de });
  const f = garder(faits, curseurs.faits), l = garder(livraisons as Array<{ id: number }>, curseurs.livraisons), r = garder(recherches, curseurs.recherches);
  return { faits: f.liste, verifications, livraisons: l.liste, recherches: r.liste, reste: f.reste || l.reste || r.reste,
    curseurs: { faits: f.curseur, livraisons: l.curseur, recherches: r.curseur } };
}

function servirLivrable(racine: string, run: string, nom: string): Response {
  if (!NOM_FICHIER.test(nom) || nom.includes("..")) return json({ erreur: "fichier inconnu" }, 404);
  const chemin = fichierDePartage(racine, run, nom);
  if (!chemin) return json({ erreur: "fichier inconnu" }, 404);
  const ext = nom.split(".").pop()!.toLowerCase();
  const type = TYPES[ext] ?? "application/octet-stream";
  // Une page HTML livrée par les agents s'ouvre pour de vrai (scripts et styles du même dossier), mais dans un bac à sable
  // navigateur : origine opaque, donc aucun accès à l'API de la vue (voir la garde d'origine sur POST et DELETE).
  const csp = type === "text/html" ? "sandbox allow-scripts" : "default-src 'none'; style-src 'unsafe-inline'; img-src data:";
  return new Response(Bun.file(chemin), { headers: { "content-type": `${type}; charset=utf-8`, "content-security-policy": csp, "x-content-type-options": "nosniff" } });
}

// Une requête qui change l'état doit venir de la vue elle-même : un livrable ouvert en bac à sable envoie « Origin: null ».
function origineEtrangere(req: Request): boolean {
  const origine = req.headers.get("origin");
  return origine !== null && origine !== `http://${req.headers.get("host")}`;
}

// Rebinding DNS : une page d'evil.test dont le nom pointe ensuite sur 127.0.0.1 parle à nos ports avec son propre
// Host, et la garde d'origine le comparait à lui-même. Seuls les noms de la machine sont acceptés, sur nos deux ports.
function hoteEtranger(req: Request, hote: string, port: number): boolean {
  return ![`127.0.0.1:${port}`, `localhost:${port}`, `${hote}:${port}`].includes(req.headers.get("host") ?? "");
}

// Le serveur des livrables, sur son port à lui. Servie depuis l'API, une page livrée devait rester
// en bac à sable — origine opaque, aucun accès à l'API de la vue — et `sandbox allow-scripts` bloque du même
// coup les formulaires et le stockage local : une page saine en double-clic y cassait.
// Une origine séparée règle les deux : il n'y a aucune API sur ce port, donc plus rien à protéger, et la
// garde d'origine du serveur principal refuse de toute façon une requête venue d'ici. La page s'ouvre alors
// exactement comme en double-clic — c'est ce que la vue doit montrer.
function servirFichierLivrable(racine: string, run: string, cheminRelatif: string): Response {
  const propre = T.normaliserChemin(cheminRelatif); // sous-dossiers acceptés, « .. » et chemins absolus refusés
  if (!propre) return new Response("fichier inconnu", { status: 404 });
  const chemin = fichierDePartage(racine, run, propre);
  if (!chemin) return new Response("fichier inconnu", { status: 404 });
  const type = TYPES[propre.split(".").pop()!.toLowerCase()] ?? "application/octet-stream";
  return new Response(Bun.file(chemin), { headers: { "content-type": `${type}; charset=utf-8`, "x-content-type-options": "nosniff" } });
}

function creerServeurLivrables(racine: string, hote: string, port: number) {
  return Bun.serve({
    hostname: hote,
    port,
    fetch(req, srv) {
      if (hoteEtranger(req, hote, srv.port!)) return new Response("hôte refusé", { status: 403 });
      if (req.method !== "GET") return new Response("méthode refusée", { status: 405 });
      const m = new URL(req.url).pathname.match(/^\/([^/]+)\/(.+)$/);
      if (!m) return new Response("usage : /<run>/<fichier>", { status: 404 });
      let run: string, reste: string;
      try { run = decodeURIComponent(m[1]!); reste = decodeURIComponent(m[2]!); } catch { return new Response("introuvable", { status: 404 }); }
      if (!validerRun(run) || !existsSync(join(racine, "runs", run))) return new Response("run inconnu", { status: 404 });
      return servirFichierLivrable(racine, run, reste);
    },
  });
}

const entier = (v: string | null, defaut: number) => { const n = Number(v); return v !== null && Number.isFinite(n) && n >= 0 ? Math.floor(n) : defaut; };

export function creerServeur(o: OptionsServeur = {}): Serveur {
  const racine = resolve(o.racine ?? process.cwd());
  const hote = o.hote ?? "127.0.0.1";
  // Le port des livrables suit celui de la vue (4700 → 4701) ; avec un port libre (0), le sien l'est aussi.
  const portVue = o.port ?? 4700;
  const srvLivrables = creerServeurLivrables(racine, hote, o.portLivrables ?? (portVue === 0 ? 0 : portVue + 1));
  // L'onglet Mémoire : le recalcul des vérifications (null : aucun) et un cache d'empreintes par run, gardé tant
  // que le serveur tourne : un fichier inchangé ne coûte qu'une lecture de ses attributs.
  const ecritDepuis = o.ecritDepuis === undefined ? ECRIT_DEPUIS : o.ecritDepuis;
  const cachesMemoire = new Map<string, M.Cache>();
  const srv = Bun.serve({
    hostname: hote,
    port: o.port ?? 4700,
    fetch(req, srv) {
      if (hoteEtranger(req, hote, srv.port!)) return json({ erreur: "hôte refusé" }, 403);
      const url = new URL(req.url);
      const action = url.pathname.match(/^\/api\/runs\/([^/]+)(\/fermer|\/pause|\/reprendre|\/consigne)?$/);
      if (action && (req.method === "POST" || req.method === "DELETE")) {
        if (origineEtrangere(req)) return json({ erreur: "origine refusée" }, 403);
        let run: string;
        try { run = decodeURIComponent(action[1]); } catch { return json({ erreur: "run inconnu" }, 404); }
        if (!validerRun(run) || !existsSync(join(racine, "runs", run))) return json({ erreur: "run inconnu" }, 404);
        if (req.method === "POST" && action[2] === "/consigne") {
          return req.json().catch(() => ({})).then((corps: { texte?: unknown }) => { const r = consigneRun(racine, run, corps?.texte); return json(r.corps, r.statut); });
        }
        if (req.method === "POST" && action[2]) {
          const r = action[2] === "/fermer" ? fermerRun(racine, run) : pauseRun(racine, run, action[2] === "/pause");
          return json(r.corps, r.statut);
        }
        if (req.method === "DELETE" && !action[2]) { const r = supprimerRun(racine, run); return json(r.corps, r.statut); }
      }
      if (req.method !== "GET") return json({ erreur: "méthode refusée" }, 405);
      if (url.pathname === "/" || url.pathname === "/index.html") {
        const page = Bun.file(join(RACINE_DEPOT, "vue", "index.html"));
        return page.size > 0 ? new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } }) : json({ erreur: "vue absente" }, 404);
      }
      if (url.pathname === "/api/config") return json({ livrables: `http://${hote}:${srvLivrables.port}`, consigne_max: CONSIGNE_MAX });
      if (url.pathname === "/cerveau.js") { // le module 3D de l'onglet Cerveau, chargé par la page à la demande
        const module = Bun.file(join(RACINE_DEPOT, "vue", "cerveau.js"));
        return module.size > 0 ? new Response(module, { headers: { "content-type": "text/javascript; charset=utf-8" } }) : json({ erreur: "vue absente" }, 404);
      }
      const m = url.pathname.match(/^\/api\/runs(?:\/([^/]+))?(?:\/(fils|evenements|partage|entrees|cerveau|depot|memoire|exigences|passations|consignes)|\/agents\/([^/]+)|\/partage\/([^/]+)|\/tickets\/(\d{1,9}))?$/);
      if (!m) return json({ erreur: "route inconnue" }, 404);
      const [, brut, sousRoute, agentBrut, livrableBrut, ticketBrut] = m;
      if (brut === undefined) return json(listerRuns(racine));
      let run: string;
      try { run = decodeURIComponent(brut); } catch { return json({ erreur: "run inconnu" }, 404); }
      if (!validerRun(run) || !existsSync(join(racine, "runs", run))) return json({ erreur: "run inconnu" }, 404);
      if (sousRoute === "partage") return json(listerPartage(racine, run));
      if (livrableBrut !== undefined) {
        let nom: string;
        try { nom = decodeURIComponent(livrableBrut); } catch { return json({ erreur: "fichier inconnu" }, 404); }
        return servirLivrable(racine, run, nom);
      }
      if (sousRoute === "depot") { // asynchrone (git) : la base se ferme une fois la réponse prête
        const lecture = ouvrirLecture(racine, run);
        if (!lecture) return json({ erreur: "pas encore prêt" }, 503);
        const limite = Math.min(500, entier(url.searchParams.get("limite"), 50) || 50);
        return depot(racine, run, lecture, limite).then((d) => json(d)).finally(() => lecture.fermer());
      }
      const t = ouvrirLecture(racine, run);
      if (!t) return json({ erreur: "pas encore prêt" }, 503);
      try {
        if (sousRoute === "entrees") return json(entrees(racine, run, t));
        if (sousRoute === "cerveau") return json(cerveau(t));
        if (sousRoute === "exigences") return json(exigencesEtPreuves(t, join(racine, "runs", run)));
        if (sousRoute === "passations") return json(passationsEtLecons(t));
        if (sousRoute === "consignes") return json(consignesDuRun(racine, run, t));
        if (ticketBrut !== undefined) { const k = ticketDuFil(t, Number(ticketBrut)); return k ? json(k) : json({ erreur: "ticket inconnu" }, 404); }
        if (sousRoute === "memoire") {
          const q = url.searchParams;
          if (!cachesMemoire.has(run)) cachesMemoire.set(run, new Map());
          return json(memoire(t, racinesDuRun(racine, run), { faits: entier(q.get("faits"), 0), livraisons: entier(q.get("livraisons"), 0), recherches: entier(q.get("recherches"), 0) },
            { ecritDepuis: ecritDepuis ?? undefined, cache: cachesMemoire.get(run)! }));
        }
        const depuis = entier(url.searchParams.get("depuis"), 0);
        if (sousRoute === "fils") {
          const limite = Math.min(LIMITE_MAX, entier(url.searchParams.get("limite"), LIMITE_MAX) || LIMITE_MAX);
          const v = url.searchParams.get("v");
          let versions: Versions | undefined;
          if (v !== null) { try { const x = v ? JSON.parse(v) : {}; versions = x && typeof x === "object" ? x : {}; } catch { versions = {}; } }
          return json(fils(t, depuis, limite, versions));
        }
        const limiteTrace = Math.min(LIMITE_TRACE, entier(url.searchParams.get("limite"), LIMITE_TRACE) || LIMITE_TRACE);
        if (sousRoute === "evenements") {
          const q = url.searchParams;
          const role = q.get("role") || undefined;
          if (role !== undefined && !(ROLES as string[]).includes(role)) return json({ erreur: "rôle inconnu" }, 400);
          return json(evenements(t, { agent: q.get("agent") || undefined, role, outil: q.get("outil") || undefined, q: q.get("q") || undefined, depuis, limite: limiteTrace }));
        }
        if (agentBrut !== undefined) {
          let nom: string;
          try { nom = decodeURIComponent(agentBrut); } catch { return json({ erreur: "agent inconnu" }, 404); }
          if (!validerRun(nom)) return json({ erreur: "agent inconnu" }, 404);
          const type = url.searchParams.get("type") || undefined;
          if (type !== undefined && !(type in FILTRES_TYPE)) return json({ erreur: "type inconnu" }, 400);
          const fiche = ficheAgent(t, nom, { type, depuis, limite: limiteTrace });
          return fiche ? json(fiche) : json({ erreur: "agent inconnu" }, 404);
        }
        return json({ ...(compteur(t) as object), en_pause: existsSync(join(racine, "runs", run, "pause")) });
      } finally {
        t.fermer();
      }
    },
  });
  return {
    url: `http://${hote}:${srv.port}`, hote, port: srv.port,
    urlLivrables: `http://${hote}:${srvLivrables.port}`, portLivrables: srvLivrables.port,
    arreter: () => { srv.stop(true); srvLivrables.stop(true); },
  };
}

const AIDE = `essaim : la vue, en lecture seule

usage : bun src/serveur.ts [--port 4700] [--racine .]

  --port N        port d'écoute sur 127.0.0.1 (défaut 4700 ; 0 = port libre)
                  les livrables sont servis sur le port suivant (4701), sur une origine à eux
  --racine DIR    dossier qui contient runs/ (défaut : le répertoire courant)
  --help          cette aide

Ouvre ensuite http://127.0.0.1:4700 dans le navigateur. Le serveur lit runs/*/tableau.sqlite ;
il n'écrit que pour fermer un run (POST /api/runs/<run>/fermer), le mettre en pause et le reprendre
(POST /api/runs/<run>/pause, /reprendre) ou en supprimer un (DELETE /api/runs/<run>), depuis la vue. Il n'écoute jamais hors de la machine.
`;

if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: { port: { type: "string" }, racine: { type: "string" }, help: { type: "boolean", default: false } },
    strict: true,
  });
  if (values.help) {
    console.log(AIDE);
    process.exit(0);
  }
  const port = values.port === undefined ? 4700 : Number(values.port);
  if (!Number.isInteger(port) || port < 0) {
    console.error("essaim : --port doit être un entier positif ou 0");
    process.exit(1);
  }
  const s = creerServeur({ port, racine: values.racine });
  console.log(`essaim : vue sur ${s.url} (lecture seule, Ctrl-C pour arrêter)`);
  console.log(`essaim : livrables servis sur ${s.urlLivrables} — origine séparée, pour qu'une page s'ouvre comme en double-clic`);
}
