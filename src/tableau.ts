// Le tableau blanc de la salle : schéma et requêtes en SQL pur, écrits contre
// une interface de six méthodes que tableau-bun.ts (lanceur, tests, vue) et
// tableau-node.ts (extension dans pi) réalisent. Ce fichier n'importe aucun
// pilote SQLite, ni celui de Bun ni celui de Node.
import { createHash } from "node:crypto";
import type { Cote } from "./prenoms.ts";
import { ANCIENS_OUTILS_SALLE, OUTILS_PI, OUTILS_RETIRES, OUTILS_SALLE } from "./noms-outils.ts";

export interface Tableau {
  exec(sql: string): void;
  run(sql: string, params?: unknown[]): { changes: number; lastId: number };
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | undefined;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
  transaction<T>(fn: () => T): T;
  fermer(): void;
}

export const SCHEMA = `
PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS run(id TEXT PRIMARY KEY, mission_chemin TEXT, mission_texte TEXT, modele TEXT,
  plafond_usd REAL, silence_min INTEGER, debut TEXT, fin TEXT, etat TEXT NOT NULL DEFAULT 'en_cours', bilan_json TEXT, entrees_json TEXT,
  modele_femmes TEXT);
CREATE TABLE IF NOT EXISTS agents(nom TEXT PRIMARY KEY, surnom TEXT, bureau TEXT, pid INTEGER, debut TEXT,
  derniere_activite TEXT, etat TEXT NOT NULL DEFAULT 'actif', raison_sortie TEXT, fichier_livre TEXT,
  passes INTEGER NOT NULL DEFAULT 1, cout_usd REAL NOT NULL DEFAULT 0, cout_estime INTEGER NOT NULL DEFAULT 0,
  tokens_entree INTEGER NOT NULL DEFAULT 0, tokens_sortie INTEGER NOT NULL DEFAULT 0,
  appels INTEGER NOT NULL DEFAULT 0, echecs INTEGER NOT NULL DEFAULT 0, sommeils INTEGER NOT NULL DEFAULT 0,
  modele TEXT, cote TEXT);
CREATE TABLE IF NOT EXISTS fils(id INTEGER PRIMARY KEY, nom TEXT UNIQUE NOT NULL, cree_par TEXT, cree_le TEXT);
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, fil_id INTEGER NOT NULL REFERENCES fils(id),
  auteur TEXT NOT NULL, cree_le TEXT NOT NULL, texte TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS lectures(agent TEXT NOT NULL, fil_id INTEGER NOT NULL, dernier_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(agent, fil_id));
CREATE TABLE IF NOT EXISTS reclamations(id INTEGER PRIMARY KEY, chemin TEXT NOT NULL, agent TEXT NOT NULL,
  raison TEXT, pose_le TEXT NOT NULL, retire_le TEXT);
CREATE TABLE IF NOT EXISTS evenements(id INTEGER PRIMARY KEY, agent TEXT NOT NULL, horodatage TEXT NOT NULL,
  type TEXT NOT NULL, outil TEXT, appel_id TEXT, arguments_json TEXT, resultat_resume TEXT, duree_ms INTEGER,
  tokens_entree INTEGER, tokens_sortie INTEGER, cout_usd REAL, erreur TEXT);
CREATE TABLE IF NOT EXISTS demandes_git(id INTEGER PRIMARY KEY, agent TEXT NOT NULL, action TEXT NOT NULL, args_json TEXT,
  etat TEXT NOT NULL DEFAULT 'attente', resultat_json TEXT, cree_le TEXT NOT NULL, fini_le TEXT);
CREATE TABLE IF NOT EXISTS essais(nom TEXT PRIMARY KEY, auteur TEXT NOT NULL, raison TEXT, dossier TEXT NOT NULL, cree_le TEXT NOT NULL,
  adopte_le TEXT, adopte_par TEXT, adopte_hash TEXT);
CREATE TABLE IF NOT EXISTS tickets(id INTEGER PRIMARY KEY, type TEXT NOT NULL CHECK (type IN ('bug', 'amelioration', 'question')),
  titre TEXT NOT NULL, description TEXT, auteur TEXT NOT NULL, charge TEXT,
  etat TEXT NOT NULL DEFAULT 'ouvert' CHECK (etat IN ('ouvert', 'en_cours', 'ferme')), commit_ferme TEXT, reponse TEXT,
  cree_le TEXT NOT NULL, maj_le TEXT NOT NULL);
-- Rôles des agents : les demandes de rejeu d'une alerte (corrige, invalide), servies par le lanceur comme
-- demandes_git ; l'alerte reste ouverte jusqu'à son reçu. commit_produit : main au dépôt de la demande ;
-- exigence : la clause d'une preuve, nulle pour une alerte.
CREATE TABLE IF NOT EXISTS demandes_rejeu(id INTEGER PRIMARY KEY, ticket_id INTEGER REFERENCES tickets(id), exigence TEXT,
  motif TEXT CHECK (motif IN ('corrige', 'invalide')), commande TEXT NOT NULL, graine TEXT, commit_produit TEXT,
  demandeur TEXT NOT NULL, etat TEXT NOT NULL DEFAULT 'attente' CHECK (etat IN ('attente', 'prise', 'faite')), recu TEXT,
  resultat_json TEXT, cree_le TEXT NOT NULL, fini_le TEXT);
-- Rôles des agents : les phrases de la mission, numérotées par le lanceur au début d'un run avec
-- chef ; le chef en range chacune (classement ; exigence : le libellé qui la porte). Une exigence sans plus aucune phrase
-- est retirée, jamais effacée. Une contestation du gardien est une question au chef (ticket_id).
CREATE TABLE IF NOT EXISTS phrases(n INTEGER PRIMARY KEY, section TEXT NOT NULL, texte TEXT NOT NULL,
  classement TEXT CHECK (classement IN ('exigence', 'transversale', 'contexte', 'engagement')), exigence TEXT, range_le TEXT);
CREATE TABLE IF NOT EXISTS exigences(libelle TEXT PRIMARY KEY, classement TEXT NOT NULL CHECK (classement IN ('exigence', 'transversale')),
  responsable TEXT NOT NULL CHECK (responsable IN ('recette', 'gardien')), range_par TEXT NOT NULL, cree_le TEXT NOT NULL, retiree_le TEXT);
CREATE TABLE IF NOT EXISTS contestations(id INTEGER PRIMARY KEY, exigence TEXT, phrases TEXT NOT NULL, raison TEXT NOT NULL, par TEXT NOT NULL,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id), cree_le TEXT NOT NULL);
-- Rôles des agents : le second acte d'une preuve, signé par le siège responsable de l'exigence
-- (recette : parcours ; gardien-mesureur : mesures) ; recu nul et non_verifiee à 1 : l'exigence déclarée non vérifiée.
-- revoquee_le : le siège a changé d'occupant, sa signature ne compte plus. Une appréciation ne compte jamais comme preuve.
CREATE TABLE IF NOT EXISTS attestations(id INTEGER PRIMARY KEY, exigence TEXT NOT NULL, agent TEXT NOT NULL, role TEXT NOT NULL,
  nature TEXT NOT NULL CHECK (nature IN ('parcours', 'mesure')), recu TEXT, non_verifiee INTEGER NOT NULL DEFAULT 0, portee TEXT NOT NULL,
  cree_le TEXT NOT NULL, revoquee_le TEXT);
CREATE TABLE IF NOT EXISTS appreciations(id INTEGER PRIMARY KEY, exigence TEXT NOT NULL, agent TEXT NOT NULL, role TEXT NOT NULL, texte TEXT NOT NULL,
  portee TEXT NOT NULL, cree_le TEXT NOT NULL);
-- Rôles des agents : la note de passation d'un sortant (moi_passation) ; entrant : le nouvel occupant
-- du siège, posé par le lanceur ; livree_le : la note et l'état du siège reçus par l'entrant (confirmé par le lanceur).
CREATE TABLE IF NOT EXISTS passations(id INTEGER PRIMARY KEY, agent TEXT NOT NULL, role TEXT NOT NULL, texte TEXT NOT NULL, cree_le TEXT NOT NULL,
  entrant TEXT, livree_le TEXT);
-- Rôles des agents : les leçons proposées par les agents (moi_finir, moi_passation), archivées dans le
-- bilan, jamais relues par un autre run ; remplacee_par : posé hors run, quand une leçon en remplace une autre.
CREATE TABLE IF NOT EXISTS lecons(id INTEGER PRIMARY KEY, agent TEXT NOT NULL, role TEXT, run TEXT NOT NULL, cree_le TEXT NOT NULL, texte TEXT NOT NULL,
  remplacee_par INTEGER);
CREATE TABLE IF NOT EXISTS ticket_notes(id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL REFERENCES tickets(id), auteur TEXT NOT NULL,
  cree_le TEXT NOT NULL, texte TEXT NOT NULL);
-- Fils de concentration : une présence par agent, un seul fil à la fois par construction.
CREATE TABLE IF NOT EXISTS presences(agent TEXT PRIMARY KEY, fil_id INTEGER NOT NULL REFERENCES fils(id),
  entre_le TEXT NOT NULL, reveil_fil INTEGER NOT NULL DEFAULT 0);
-- Lots figés d'un fil et leurs résumés : bornes fixées à la création, résumé écrit une fois.
CREATE TABLE IF NOT EXISTS lots(id INTEGER PRIMARY KEY, fil_id INTEGER NOT NULL REFERENCES fils(id),
  debut_id INTEGER NOT NULL, fin_id INTEGER NOT NULL, etat TEXT NOT NULL DEFAULT 'attente'
    CHECK (etat IN ('attente', 'prise', 'fait', 'echec')),
  essais INTEGER NOT NULL DEFAULT 0, texte TEXT, cout_usd REAL NOT NULL DEFAULT 0, cout_estime INTEGER NOT NULL DEFAULT 0,
  modele TEXT, cote TEXT, demande_par TEXT NOT NULL, cree_le TEXT NOT NULL, fait_le TEXT, UNIQUE(fil_id, debut_id));
-- Les appels livrés tels quels, sans avancer le curseur du fil.
CREATE TABLE IF NOT EXISTS appels_livres(agent TEXT NOT NULL, message_id INTEGER NOT NULL, livre_le TEXT NOT NULL,
  PRIMARY KEY(agent, message_id));
-- Les refus « une fois » d'un run à rôles : la dernière situation rappelée à l'agent,
-- par rappel (tickets, salle). Tenue par le tableau et non par le processus : une relance de pi ne rejoue pas le refus.
CREATE TABLE IF NOT EXISTS refus_une_fois(agent TEXT NOT NULL, rappel TEXT NOT NULL, cle TEXT NOT NULL, le TEXT NOT NULL,
  PRIMARY KEY(agent, rappel));
CREATE INDEX IF NOT EXISTS ix_messages_fil ON messages(fil_id, id);
CREATE INDEX IF NOT EXISTS ix_lots_etat ON lots(etat, id);
CREATE INDEX IF NOT EXISTS ix_evenements_agent ON evenements(agent, id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_reclamation_ouverte ON reclamations(chemin) WHERE retire_le IS NULL;
INSERT OR IGNORE INTO fils(id, nom, cree_par, cree_le) VALUES (1, 'principal', 'system', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
-- Second cerveau : le journal des faits constatés par la salle, jamais modifié ni supprimé.
CREATE TABLE IF NOT EXISTS faits(id INTEGER PRIMARY KEY, cree_le TEXT NOT NULL,
  type TEXT NOT NULL,           -- ecriture, verification, agent, fil, ticket, pancarte, essai, restauration
  agent TEXT NOT NULL,          -- l'agent concerné (l'auteur d'un commit, celui qui vérifie, celui qui part…)
  source TEXT NOT NULL,         -- qui constate : 'lanceur', ou l'outil (page_voir, code_tester, bash, moi_finir, tableau)
  sujet TEXT,                   -- fichier, page, fil, n° de ticket…
  statut TEXT,                  -- pour une vérification : verifie, echoue, inconnu, instable ; sinon NULL
  texte TEXT NOT NULL,          -- la ligne telle qu'un agent la lira, sans l'heure
  message_id INTEGER,           -- le message cité, pour une déclaration (conclusion, ticket, départ)
  details_json TEXT);           -- blobs avant/après, fichiers, hash, bilan chiffré, citation entière, HEAD au contrôle
CREATE INDEX IF NOT EXISTS ix_faits_type ON faits(type, id);
-- Ce qui a été livré à chaque agent : ses curseurs, et chaque livraison, texte exact compris.
CREATE TABLE IF NOT EXISTS memoire_curseurs(agent TEXT PRIMARY KEY, etat_fait_id INTEGER NOT NULL DEFAULT 0,
  ligne_fait_id INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS memoire_livraisons(id INTEGER PRIMARY KEY, agent TEXT NOT NULL, livre_le TEXT NOT NULL,
  moment TEXT NOT NULL,          -- reveil, resume, pause, veille, reparee, images, passagere, emballee, continue, ligne
  de_fait INTEGER NOT NULL, a_fait INTEGER NOT NULL, a_message INTEGER, lignes INTEGER NOT NULL, retires INTEGER NOT NULL,
  caracteres INTEGER NOT NULL, texte TEXT NOT NULL,
  confirme_le TEXT,              -- état : posé par le lanceur ; ligne courte : posé à l'écriture
  rien_ecrit_json TEXT);         -- les vérifications dites « rien écrit depuis », avec les empreintes relues
-- L'index de salle_chercher, rempli par déclencheurs quelle que soit la connexion qui écrit (Node ou Bun).
-- rowid croissant : l'ordre d'entrée dans l'index, et le curseur « avant » de la pagination.
CREATE VIRTUAL TABLE IF NOT EXISTS recherche USING fts5(texte, type UNINDEXED, ref UNINDEXED, auteur UNINDEXED,
  fil UNINDEXED, cree_le UNINDEXED, tokenize = 'unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS recherche_message AFTER INSERT ON messages BEGIN
  INSERT INTO recherche(texte, type, ref, auteur, fil, cree_le)
  VALUES (NEW.texte, 'message', NEW.id, NEW.auteur, (SELECT nom FROM fils WHERE id = NEW.fil_id), NEW.cree_le);
END;
CREATE TRIGGER IF NOT EXISTS recherche_resume AFTER UPDATE OF etat ON lots WHEN NEW.etat = 'fait' AND OLD.etat <> 'fait' BEGIN
  INSERT INTO recherche(texte, type, ref, auteur, fil, cree_le)
  VALUES (COALESCE(NEW.texte, ''), 'resume', NEW.id, NEW.modele, (SELECT nom FROM fils WHERE id = NEW.fil_id),
    COALESCE(NEW.fait_le, strftime('%Y-%m-%dT%H:%M:%fZ','now')));
END;
-- Un commit n'est indexé qu'une fois, en type commit : son message (details.message) et ses fichiers, sinon la ligne du fait.
CREATE TRIGGER IF NOT EXISTS recherche_commit AFTER INSERT ON faits WHEN NEW.type = 'ecriture' BEGIN
  INSERT INTO recherche(texte, type, ref, auteur, fil, cree_le)
  VALUES (COALESCE(json_extract(NEW.details_json, '$.message') || ' · '
      || COALESCE((SELECT group_concat(json_extract(value, '$.chemin'), ', ') FROM json_each(NEW.details_json, '$.fichiers')), ''),
    NEW.texte), 'commit', json_extract(NEW.details_json, '$.hash'), NEW.agent, NULL, NEW.cree_le);
END;
-- Les autres faits : leur ligne, et la citation entière quand la ligne la coupe (details.citation).
CREATE TRIGGER IF NOT EXISTS recherche_fait AFTER INSERT ON faits WHEN NEW.type <> 'ecriture' BEGIN
  INSERT INTO recherche(texte, type, ref, auteur, fil, cree_le)
  VALUES (NEW.texte || COALESCE(char(10) || json_extract(NEW.details_json, '$.citation'), ''), 'fait', NEW.id, NEW.agent, NULL, NEW.cree_le);
END;
CREATE TRIGGER IF NOT EXISTS recherche_ticket AFTER INSERT ON tickets BEGIN
  INSERT INTO recherche(texte, type, ref, auteur, fil, cree_le)
  VALUES (NEW.titre || COALESCE(char(10) || NEW.description, ''), 'ticket', NEW.id, NEW.auteur, NULL, NEW.cree_le);
END;
-- Préparer la mission : les versions du plan proposées par qui répartit, et
-- les jugements de la recette et du gardien sur chacune.
CREATE TABLE IF NOT EXISTS plans(id INTEGER PRIMARY KEY, auteur TEXT NOT NULL, resume TEXT NOT NULL, fichier TEXT, cree_le TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS plan_jugements(id INTEGER PRIMARY KEY, plan_id INTEGER NOT NULL REFERENCES plans(id), agent TEXT NOT NULL,
  role TEXT NOT NULL, verdict TEXT NOT NULL CHECK (verdict IN ('valide', 'a_revoir')), raison TEXT NOT NULL, cree_le TEXT NOT NULL);
-- Le surveillant : les révisions de la spec demandées par le surveillant ; une
-- seule demandée ou acceptée à la fois. close_par : plan (le plan révisé validé) ou delai (45 min sans plan).
CREATE TABLE IF NOT EXISTS revisions(id INTEGER PRIMARY KEY, demandeur TEXT NOT NULL, constat TEXT NOT NULL, tickets_json TEXT NOT NULL,
  etat TEXT NOT NULL DEFAULT 'demandee' CHECK (etat IN ('demandee', 'refusee', 'expiree', 'acceptee', 'close')), raison TEXT,
  tickets_geles_json TEXT, repondu_par TEXT, cree_le TEXT NOT NULL, rappel_le TEXT, repondu_le TEXT, close_le TEXT, close_par TEXT);
-- La réponse qui ferme une question entre dans une note : pas de déclencheur sur la mise à jour de tickets.
CREATE TRIGGER IF NOT EXISTS recherche_ticket_note AFTER INSERT ON ticket_notes BEGIN
  INSERT INTO recherche(texte, type, ref, auteur, fil, cree_le)
  VALUES (NEW.texte, 'ticket', NEW.ticket_id, NEW.auteur, NULL, NEW.cree_le);
END;
`;

// Colonnes ajoutées aux tables existantes. Seul initialiser (le lanceur) les ajoute ;
// la vue ouvre les anciens runs en lecture seule et teste leur présence (aColonne, aTable) sans jamais migrer.
const COLONNES_AJOUTEES: Array<[string, string, string]> = [
  ["fils", "pourquoi", "TEXT"], ["fils", "conclusion", "TEXT"], ["fils", "ouvert_le", "TEXT"], ["fils", "ferme_le", "TEXT"],
  ["messages", "hors_fil", "INTEGER NOT NULL DEFAULT 0"], ["messages", "sommeil", "INTEGER NOT NULL DEFAULT 0"],
  // La liste des outils disponibles du run, pi compris, en JSON.
  ["run", "outils_json", "TEXT"],
  // Second cerveau : 'non' pour un run témoin (--memoire non), 'oui' sinon.
  ["run", "memoire", "TEXT"],
  // Le rôle du siège et, pour un constructeur, le siège qu'il supplée ; NULL sans rôles.
  ["agents", "role", "TEXT"], ["agents", "suppleant_de", "TEXT"],
  // Les chemins confiés avec un ticket (JSON), dont le chargé porte les pancartes.
  ["tickets", "chemins", "TEXT"],
  // La sorte (travail ou alerte), le motif de clôture, le successeur (remplace_par), la
  // reproduction figée d'une alerte (JSON) et le ticket qui en bloque un autre. Un ticket d'avant est de travail.
  ["tickets", "sorte", "TEXT NOT NULL DEFAULT 'travail'"], ["tickets", "motif", "TEXT"], ["tickets", "remplace_par", "INTEGER"],
  ["tickets", "reproduction", "TEXT"], ["tickets", "bloque_par", "INTEGER"],
  // La reproduction d'une demande de preuve d'exigence (JSON, comme celle d'une alerte),
  // relevée à la demande ; nulle pour une alerte, qui garde la sienne dans son ticket.
  ["demandes_rejeu", "reproduction", "TEXT"],
  // L'exigence (E1…) qu'une alerte met en défaut, donnée à son ouverture ; une exigence
  // liée à une alerte ouverte n'est pas satisfaite (etatDuRun). Nulle pour un ticket de travail ou une alerte sans lien.
  ["tickets", "exigence", "TEXT"],
  // L'occupant d'avant, quand le lanceur a relancé le siège (panne, passation).
  ["agents", "remplace", "TEXT"],
  // Le rejeu d'un reçu attesté par le lanceur lui-même, quand le produit ou le monde a
  // changé : rejoue, le reçu rejoué (preuves/<n>.json) ; cle_produit, l'empreinte du produit et du monde à la demande.
  // Un seul rejeu par couple (reçu, état du produit).
  ["demandes_rejeu", "rejoue", "TEXT"], ["demandes_rejeu", "cle_produit", "TEXT"],
  // Pilotage de la salle : ce qu'un dormeur a dit attendre (moi_dormir), et l'heure de sa mise en veille
  // (derniere_activite ne convient pas : majAgent l'écrase après la fin du tour). Effacés au réveil.
  ["agents", "attend", "TEXT"], ["agents", "endormi_le", "TEXT"],
  // Préparer la mission : l'état de la préparation du run ('en_cours', 'validee', 'close') ; NULL sans préparation.
  ["run", "preparation", "TEXT"],
  // La spec puis le plan : l'étape d'une proposition ('spec' ou 'plan' ; NULL : un plan
  // d'avant) et l'heure où chaque contrôleur présent l'a validée.
  ["plans", "etape", "TEXT"], ["plans", "valide_le", "TEXT"],
  // Le surveillant : l'heure de fermeture d'un ticket (maj_le change à chaque
  // note), lue par un des signes du surveillant.
  ["tickets", "ferme_le", "TEXT"],
  // Le surveillant : chaque proposition liée à sa révision (NULL : la préparation), l'empreinte sha256
  // de son fichier à la proposition, et pendant une révision, les exigences que le chef déclare changées (spec) et les
  // tickets gelés qu'il reprend (plan), en JSON.
  ["tickets", "gele_le", "TEXT"],
  ["plans", "revision_id", "INTEGER"], ["plans", "empreinte", "TEXT"], ["plans", "exigences_changees", "TEXT"], ["plans", "tickets_repris", "TEXT"],
  // Les jalons : un jalon est une exigence avec un parent, une portée écrite par le
  // chef et un indice jamais redonné (E4.1, E4.2…) ; la proposition de spec ou de plan garde l'empreinte du découpage.
  ["exigences", "parent", "TEXT"], ["exigences", "portee", "TEXT"], ["exigences", "indice", "INTEGER"],
  ["plans", "decoupage", "TEXT"],
];

// Le prédicat SQL d'un ticket actif (estActif) : gele_le existe sur tout tableau initialisé.
const ACTIF = "etat <> 'ferme' AND gele_le IS NULL";
export const aColonne = (t: Tableau, table: string, colonne: string) =>
  t.all<{ name: string }>(`PRAGMA table_info(${table})`).some((c) => c.name === colonne);
export const aTable = (t: Tableau, table: string) =>
  !!t.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [table]);

export function initialiser(t: Tableau): void {
  t.exec(SCHEMA);
  for (const [table, colonne, type] of COLONNES_AJOUTEES)
    if (!aColonne(t, table, colonne)) t.exec(`ALTER TABLE ${table} ADD COLUMN ${colonne} ${type}`);
}

// ---- Requêtes de la salle -------------------------------------------------

const maintenant = () => new Date().toISOString();
const arrondi = (x: number) => Math.round(x * 1e6) / 1e6;

// entreesJson : les documents d'entrée copiés dans <run>/entrees/ ([{ nom, taille, sha256 }]), absent si aucun.
// modele : celui des hommes ; modeleFemmes : le second modèle, absent = run à un modèle.
// outils : les outils disponibles des agents, écrits seulement sur une base migrée par initialiser.
// memoire : 'oui' ou 'non' (run témoin), même condition ; absent : colonne laissée nulle.
export function ouvrirRun(t: Tableau, r: { id: string; missionChemin: string; missionTexte: string; modele: string; modeleFemmes?: string; plafondUsd: number; silenceMin: number; entreesJson?: string; outils?: string[]; memoire?: boolean }): void {
  t.run("INSERT INTO run(id, mission_chemin, mission_texte, modele, modele_femmes, plafond_usd, silence_min, debut, entrees_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [r.id, r.missionChemin, r.missionTexte, r.modele, r.modeleFemmes ?? null, r.plafondUsd, r.silenceMin, maintenant(), r.entreesJson ?? null]);
  if (r.outils && aColonne(t, "run", "outils_json")) t.run("UPDATE run SET outils_json = ? WHERE id = ?", [JSON.stringify(r.outils), r.id]);
  if (r.memoire !== undefined && aColonne(t, "run", "memoire")) t.run("UPDATE run SET memoire = ? WHERE id = ?", [r.memoire ? "oui" : "non", r.id]);
}

// L'ordre d'insertion est l'ordre d'entrée (rowid) : l'équipe et le tour de parole le suivent. siege : le rôle attribué par
// le lanceur, écrit seulement sur une base migrée par initialiser ; absent, les colonnes restent nulles.
export function ajouterAgent(t: Tableau, nom: string, bureau: string, modele?: string, cote?: Cote, siege?: { role: string; suppleantDe?: string; remplace?: string }): void {
  t.run("INSERT INTO agents(nom, bureau, debut, modele, cote) VALUES (?, ?, ?, ?, ?)", [nom, bureau, maintenant(), modele ?? null, cote ?? null]);
  if (siege && aColonne(t, "agents", "role")) t.run("UPDATE agents SET role = ?, suppleant_de = ? WHERE nom = ?", [siege.role, siege.suppleantDe ?? null, nom]);
  if (siege?.remplace) t.run("UPDATE agents SET remplace = ? WHERE nom = ?", [siege.remplace, nom]);
}

function filId(t: Tableau, nom: string, createur?: string): number | undefined {
  const f = t.get<{ id: number }>("SELECT id FROM fils WHERE nom = ?", [nom]);
  if (f) return f.id;
  if (!createur) return undefined;
  return t.run("INSERT INTO fils(nom, cree_par, cree_le) VALUES (?, ?, ?)", [nom, createur, maintenant()]).lastId;
}

// Insère un message sans ouvrir de transaction : l'adaptateur Node n'imbrique pas les transactions,
// entrer, quitter et leurs annonces l'appellent donc dans la leur. hors_fil et sommeil ne sont écrits que marqués,
// et seulement sur une base migrée par initialiser ; sinon les valeurs par défaut (0) suffisent.
export function insererMessage(t: Tableau, auteur: string, texte: string, fil: string, options: { horsFil?: boolean; sommeil?: boolean } = {}): number {
  const id = filId(t, fil, auteur)!;
  if ((options.horsFil || options.sommeil) && aColonne(t, "messages", "hors_fil"))
    return t.run("INSERT INTO messages(fil_id, auteur, cree_le, texte, hors_fil, sommeil) VALUES (?, ?, ?, ?, ?, ?)",
      [id, auteur, maintenant(), texte, options.horsFil ? 1 : 0, options.sommeil ? 1 : 0]).lastId;
  return t.run("INSERT INTO messages(fil_id, auteur, cree_le, texte) VALUES (?, ?, ?, ?)", [id, auteur, maintenant(), texte]).lastId;
}

// ---- Le journal des faits (second cerveau) ------------------------------------------------------
export type TypeFait = "ecriture" | "verification" | "agent" | "fil" | "ticket" | "pancarte" | "essai" | "restauration";
export type StatutVerification = "verifie" | "echoue" | "inconnu" | "instable";
export type FichierCommit = { chemin: string; blob: string | null }; // blob nul : fichier supprimé
// details, par convention lue par l'index (déclencheurs du SCHEMA) : hash, message et fichiers (FichierCommit[]) pour
// un fait ecriture ; citation (la parole entière) quand le texte la coupe.
export type NouveauFait = {
  type: TypeFait; agent: string; source: string; sujet?: string; statut?: StatutVerification;
  texte: string; messageId?: number; details?: Record<string, unknown>;
};

// Sans transaction (comme insererMessage) : toujours appelée DANS une transaction d'écriture, celle qui change l'état
// décrit. L'identifiant est max(id)+1, sûr sous le verrou d'écriture (un fait n'est jamais supprimé), et remplace
// {FAIT} dans le texte (suite d'une citation sans message). Sur une base sans table faits (ancien run) : rien, 0.
export function noterFait(t: Tableau, f: NouveauFait): number {
  if (!aTable(t, "faits")) return 0;
  const id = t.get<{ id: number }>("SELECT COALESCE(MAX(id), 0) + 1 AS id FROM faits")!.id;
  t.run("INSERT INTO faits(id, cree_le, type, agent, source, sujet, statut, texte, message_id, details_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [id, maintenant(), f.type, f.agent, f.source, f.sujet ?? null, f.statut ?? null, f.texte.replaceAll("{FAIT}", String(id)),
      f.messageId ?? null, f.details === undefined ? null : JSON.stringify(f.details)]);
  return id;
}

// Citation d'une parole d'agent : telle quelle jusqu'à 300 caractères, sinon coupée sur
// « … (suite : salle_chercher(numero: N)) », ou « … (suite : salle_chercher(type: "fait", numero: {FAIT})) » quand
// elle n'a pas de message ({FAIT} remplacé par noterFait). Les caractères sont comptés en points de code.
export const CITATION_MAX = 300;
export function citer(texte: string, suite: { message?: number }): { texte: string; entiere: boolean } {
  const c = [...texte];
  if (c.length <= CITATION_MAX) return { texte, entiere: true };
  const ou = suite.message !== undefined ? `numero: ${suite.message}` : 'type: "fait", numero: {FAIT}';
  return { texte: `${c.slice(0, CITATION_MAX).join("")}… (suite : salle_chercher(${ou}))`, entiere: false };
}

// Une parole d'agent dans la ligne d'un fait : entre guillemets, coupée par citer ; entière dans details.citation
// quand la ligne la coupe (l'index la lit là). Sans message, la suite renvoie au fait lui-même ({FAIT}).
function cite(parole: string, message?: number): { texte: string; details?: Record<string, unknown> } {
  const c = citer(parole, { message });
  return { texte: `« ${c.texte} »`, details: c.entiere ? undefined : { citation: parole } };
}
const noterAgent = (t: Tableau, agent: string, texte: string, details?: Record<string, unknown>) =>
  noterFait(t, { type: "agent", agent, source: "tableau", texte, details });
const noterPancarteRetiree = (t: Tableau, agent: string, chemin: string) =>
  noterFait(t, { type: "pancarte", agent, source: "tableau", sujet: chemin, texte: `pancarte retirée · ${chemin} · ${agent}` });

export function poster(t: Tableau, auteur: string, texte: string, fil = "principal", options: { horsFil?: boolean; sommeil?: boolean } = {}): number {
  return t.transaction(() => insererMessage(t, auteur, texte, fil, options));
}

export type Message = { id: number; fil: string; auteur: string; cree_le: string; texte: string };

// La boîte d'un agent : selectionner → preparer sans résumé → acquitter. Rend les messages livrés, appels en tête ;
// memoire (celle de l'outil) garde le périmètre d'une exception d'une page à l'autre. Aucune transaction englobante :
// sous Node elles ne s'imbriquent pas, et acquitter tient la sienne.
export function boite(t: Tableau, agent: string, fil?: string, limite = 50, memoire: MemoireLecture = {}): { messages: Message[]; reste: boolean } {
  const p = preparer(t, agent, selectionner(t, agent, fil, memoire), { limite });
  acquitter(t, agent, p.elements);
  return { messages: p.elements.flatMap((e) => (e.type === "resume" ? [] : [(({ fil_id: _, ...m }) => m)(e.message)])), reste: p.reste };
}

export function equipe(t: Tableau): Array<{ nom: string; surnom: string | null; etat: string; derniere_activite: string | null }> {
  return t.all("SELECT nom, surnom, etat, derniere_activite FROM agents ORDER BY rowid");
}

// Le tour de parole du démarrage : tant que celui qui le précède dans `equipe` n'a rien posté,
// le premier message d'un agent attend. Sans ça, tous les agents écrivent le même plan dans la même
// minute sans s'être lus. Passé le délai de grâce, on parle quand
// même : un agent muet, parti ou mort ne bloque jamais la salle.
// La grâce part de l'ouverture du tour de chacun, pas du lancement : le tour s'ouvre quand le
// précédent a parlé, ou quand sa propre grâce a expiré. Sinon, quand le premier met longtemps à
// lire, la grâce de tous est déjà passée avant qu'il parle.
export function tourDeParole(t: Tableau, agent: string, graceMs = 90_000, maintenantMs = Date.now()): { apres: string; resteS: number } | null {
  const premier = (nom: string) => t.get<{ le: string | null }>("SELECT MIN(cree_le) AS le FROM messages WHERE auteur = ?", [nom])?.le ?? undefined;
  if (premier(agent)) return null; // seul le premier message attend son tour
  const liste = t.all<{ nom: string; etat: string; debut: string | null }>("SELECT nom, etat, debut FROM agents ORDER BY rowid");
  const i = liste.findIndex((a) => a.nom === agent);
  if (i <= 0) return null; // inconnu, ou premier de la liste : il ouvre le bal
  let ouverture = liste[0]!.debut ? Date.parse(liste[0]!.debut) : maintenantMs;
  for (let k = 1; k <= i; k++) {
    const p = liste[k - 1]!;
    const parle = premier(p.nom);
    ouverture = parle ? Date.parse(parle) : p.etat !== "actif" ? ouverture : ouverture + graceMs;
  }
  const reste = ouverture - maintenantMs;
  if (reste <= 0) return null;
  return { apres: liste[i - 1]!.nom, resteS: Math.ceil(reste / 1000) };
}

// La moitié de la salle avant de continuer : après son premier message, un agent attend qu'au moins la
// moitié des agents aient posté le leur. Le délai de secours part de son propre premier message : une salle où
// des agents se taisent ou sont perdus n'est jamais bloquée. Renvoie null quand on peut continuer.
export function quorumDemarrage(t: Tableau, agent: string, graceMs: number, maintenantMs = Date.now()): { parle: number; total: number; requis: number; resteS: number } | null {
  const total = t.get<{ n: number }>("SELECT COUNT(*) AS n FROM agents")?.n ?? 0;
  const requis = Math.ceil(total / 2);
  const parle = t.get<{ n: number }>("SELECT COUNT(DISTINCT m.auteur) AS n FROM messages m JOIN agents a ON a.nom = m.auteur")?.n ?? 0;
  if (parle >= requis) return null;
  const premier = t.get<{ le: string | null }>("SELECT MIN(cree_le) AS le FROM messages WHERE auteur = ?", [agent])?.le;
  const reste = (premier ? Date.parse(premier) : maintenantMs) + graceMs - maintenantMs;
  if (reste <= 0) return null;
  return { parle, total, requis, resteS: Math.ceil(reste / 1000) };
}

export function surnom(t: Tableau, agent: string, surnom: string): void {
  t.run("UPDATE agents SET surnom = ? WHERE nom = ?", [surnom, agent]);
}

// Le sommeil : sans lui la salle se vide dès que chacun a fini sa part, et un agent parti ne se
// rappelle pas. Un dormeur, lui, reste vivant : il ne consomme rien
// tant qu'on ne le nomme pas. L'état `dormant` n'est pas terminal.
// Second cerveau : le fait « en veille » est écrit dans la même transaction, seulement si l'état a changé.
export function endormir(t: Tableau, agent: string, attend?: string): number {
  return t.transaction(() => {
    const le = maintenant();
    const fait = (aColonne(t, "agents", "endormi_le") // un ancien run n'a pas les colonnes du pilotage
      ? t.run("UPDATE agents SET etat = 'dormant', sommeils = sommeils + 1, derniere_activite = ?, attend = ?, endormi_le = ? WHERE nom = ? AND etat = 'actif'", [le, attend?.trim() || null, le, agent])
      : t.run("UPDATE agents SET etat = 'dormant', sommeils = sommeils + 1, derniere_activite = ? WHERE nom = ? AND etat = 'actif'", [le, agent])).changes > 0;
    if (!fait) return 0;
    noterAgent(t, agent, `${agent} · en veille`);
    return t.get<{ n: number }>("SELECT sommeils AS n FROM agents WHERE nom = ?", [agent])?.n ?? 0;
  });
}

// Combien de fois cet agent s'est déjà endormi : le plafond de réveils se lit là (la boucle de politesse,
// deux dormeurs qui se réveillent pour se remercier, paie une relecture de contexte à chaque échange).
export function sommeils(t: Tableau, agent: string): number {
  return t.get<{ n: number }>("SELECT sommeils AS n FROM agents WHERE nom = ?", [agent])?.n ?? 0;
}

// Les refus « une fois » d'un run à rôles : la clé de la situation déjà rappelée, et son écriture.
export function refusDit(t: Tableau, agent: string, rappel: string): string | undefined {
  return t.get<{ cle: string }>("SELECT cle FROM refus_une_fois WHERE agent = ? AND rappel = ?", [agent, rappel])?.cle;
}
export function noterRefusDit(t: Tableau, agent: string, rappel: string, cle: string): void {
  t.run("INSERT OR REPLACE INTO refus_une_fois(agent, rappel, cle, le) VALUES (?, ?, ?, ?)", [agent, rappel, cle, maintenant()]);
}

// Le dernier message d'un autre (ni lui, ni la salle) qui s'adresse à l'agent (sAdresseA), ou 0 : la part « messages »
// de la situation de l'agent.
export function dernierMessageAdresse(t: Tableau, agent: string, alias: string[]): number {
  const mots = alias.filter((a) => a && a.trim() !== "");
  if (mots.length === 0) return 0;
  const candidats = t.all<{ id: number; texte: string }>("SELECT id, texte FROM messages WHERE auteur <> ? AND auteur <> 'salle' ORDER BY id DESC", [agent]);
  return candidats.find((m) => mots.some((mot) => sAdresseA(m.texte, mot)))?.id ?? 0;
}

// Le prénom de l'agent et son surnom : les deux mots qui le réveillent.
export function alias(t: Tableau, agent: string): string[] {
  const a = t.get<{ surnom: string | null }>("SELECT surnom FROM agents WHERE nom = ?", [agent]);
  return [agent, a?.surnom ?? ""].filter((x) => x !== "");
}

export function reveiller(t: Tableau, agent: string): void {
  t.transaction(() => {
    const pilotage = aColonne(t, "agents", "endormi_le") ? ", attend = NULL, endormi_le = NULL" : "";
    if (t.run(`UPDATE agents SET etat = 'actif', derniere_activite = ?${pilotage} WHERE nom = ? AND etat = 'dormant'`, [maintenant(), agent]).changes > 0)
      noterAgent(t, agent, `${agent} · réveillé`);
  });
}

const echapperRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// « Cécile » nomme Cecile : les prénoms sont sans accent, les agents les écrivent souvent avec.
const sansAccents = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "");
// « Antoine » nomme Antoine, « Antoinette » non : le mot entier, sans distinction de casse ni d'accent.
// Exportée : la vue Cerveau compte les interactions avec cette même règle (nommer, c'est parler).
export const nomme = (texte: string, mot: string) => new RegExp(`(^|[^\\p{L}\\p{N}])${echapperRegex(sansAccents(mot))}($|[^\\p{L}\\p{N}])`, "iu").test(sansAccents(texte));

// Le premier message non lu, écrit par un autre, qui nomme l'agent (son prénom ou son surnom).
// Il n'est pas marqué lu : le dormeur se réveille dessus, puis lit tout son retard d'un coup.
// Pas de préfiltre SQL : LIKE ne voit pas les accents. Les non-lus d'une salle se comptent en centaines au plus.
// Une annonce de la salle n'appelle personne, et un appel déjà livré tel quel
// (appels_livres) ne réveille plus et ne relance plus l'exception, même si le curseur de son fil ne l'a pas passé.
// Un message de mise en sommeil (« [en sommeil] … », sommeil = 1) ne réveille personne par le nom non plus :
// il nomme d'autres agents en passant, et chaque dormeur nommé payait un tour pour répondre « rien à faire ». Il reste
// lisible : salle_lire le livre, et l'exception d'un fil (selectionner) le compte toujours comme un appel.
export function appelNonLu(t: Tableau, agent: string, alias: string[]): Message | undefined {
  return appelsNonLus(t, agent, alias, { sansSommeil: true })[0];
}

// Ce qui réveille un dormeur : d'abord un appel par le nom ; sinon, s'il a demandé reveil_fil, le
// premier message non lu de son fil écrit par un autre (ni lui ni la salle), qui n'est pas une mise en sommeil (deux
// dormeurs d'un même fil ne se réveillent pas en boucle) et pas encore livré. reveilFil dit lequel des deux.
// Run à rôles : d'abord un ticket qui lui est confié depuis qu'il dort
// (ticket rendu dans `ticket`, sans message : id 0), puis un appel adressé à lui seul (appelAdresse), puis son fil. Un
// message adressé à une liste de noms ne réveille donc pas tous les dormeurs de la liste.
export function appelDormeur(t: Tableau, agent: string, alias: string[], roles = false): (Message & { reveilFil: boolean; ticket?: number }) | undefined {
  if (roles) {
    // Une consigne du lanceur à cet agent réveille d'abord, avant un ticket confié ou un autre appel.
    const consigne = appelsNonLus(t, agent, alias, { sansSommeil: true }).find((m) => m.auteur === "lanceur" && m.texte.includes(MARQUE_CONSIGNE) && alias.some((x) => x && sAdresseA(m.texte, x)));
    if (consigne) return { ...consigne, reveilFil: false };
    const depuis = t.get<{ le: string }>("SELECT MAX(cree_le) AS le FROM messages WHERE auteur = ? AND sommeil = 1", [agent])?.le
      ?? (aColonne(t, "agents", "endormi_le") ? t.get<{ le: string | null }>("SELECT endormi_le AS le FROM agents WHERE nom = ?", [agent])?.le ?? undefined : undefined); // en veille dès le départ (préparation)
    const k = depuis ? ticketConfieDepuis(t, agent, depuis) : undefined;
    if (k) {
      const par = t.get<{ auteur: string }>("SELECT auteur FROM ticket_notes WHERE ticket_id = ? AND cree_le = ? ORDER BY id DESC LIMIT 1", [k.id, k.maj_le])?.auteur ?? k.auteur;
      return { id: 0, fil: "tickets", auteur: par, cree_le: k.maj_le, texte: `ticket #${k.id} confié à toi par ${par} : ${k.titre}`, reveilFil: false, ticket: k.id };
    }
  }
  const appel = roles
    ? appelAdresse(t, agent, alias, equipe(t).filter((a) => a.nom !== agent).map((a) => [a.nom, a.surnom ?? ""]))
    : appelNonLu(t, agent, alias);
  if (appel) return { ...appel, reveilFil: false };
  if (!filDe(t, agent)?.reveil_fil) return undefined;
  const m = t.get<Message>(
    `SELECT m.id, f.nom AS fil, m.auteur, m.cree_le, m.texte
     FROM presences p JOIN fils f ON f.id = p.fil_id JOIN messages m ON m.fil_id = p.fil_id
     LEFT JOIN lectures l ON l.agent = p.agent AND l.fil_id = p.fil_id
     WHERE p.agent = ? AND m.id > COALESCE(l.dernier_id, 0) AND m.auteur <> ? AND m.auteur <> 'salle' AND m.sommeil = 0
       AND NOT EXISTS (SELECT 1 FROM appels_livres x WHERE x.agent = ? AND x.message_id = m.id)
     ORDER BY m.id LIMIT 1`, [agent, agent, agent]);
  return m && { ...m, reveilFil: true };
}

// Un appel adressé : le premier message non lu d'un autre, pas une mise en sommeil, qui s'adresse à l'agent
// (sAdresseA) et à aucun autre membre de l'équipe (une liste de noms en tête ne réveille aucun d'eux), hors du fil tickets
// (ses annonces : un ticket confié réveille par ticketConfieDepuis, et une seule fois) ; un message du
// lanceur (auteur essaim : salle endormie, preuve rendue) le réveille dès qu'il le nomme, comme avant. Un message signé
// lanceur réveille chaque nom de sa tête, liste comprise : « Antoine, Bernard : plan n°1 à revoir » au lieu d'un
// message par destinataire ; seul le code du lanceur signe ainsi, jamais un agent.
export function appelAdresse(t: Tableau, agent: string, alias: string[], autres: string[][]): Message | undefined {
  const mots = alias.filter((a) => a && a.trim() !== "");
  const pour = (texte: string, noms: string[]) => noms.some((m) => m && m.trim() !== "" && sAdresseA(texte, m));
  return appelsNonLus(t, agent, alias, { sansSommeil: true }).find((m) =>
    m.auteur === "essaim" || (m.fil !== "tickets" && pour(m.texte, mots) && (m.auteur === "lanceur" || !autres.some((noms) => pour(m.texte, noms)))));
}

// Un ticket ouvert confié à l'agent qui a changé depuis sa mise en veille (créé, confié, rouvert ou annoté) : maj_le après
// `depuis`, le plus ancien d'abord.
export function ticketConfieDepuis(t: Tableau, agent: string, depuis: string): Ticket | undefined {
  return t.get<Ticket>(`SELECT * FROM tickets WHERE charge = ? AND ${ACTIF} AND maj_le > ? ORDER BY maj_le, id LIMIT 1`, [agent, depuis]);
}

function appelsNonLus(t: Tableau, agent: string, alias: string[], o: { sansSommeil?: boolean } = {}): Message[] {
  const mots = alias.filter((a) => a && a.trim() !== "");
  if (mots.length === 0) return [];
  const sommeil = o.sansSommeil && aColonne(t, "messages", "sommeil") ? "AND m.sommeil = 0" : "";
  const candidats = t.all<Message>(
    `SELECT m.id, f.nom AS fil, m.auteur, m.cree_le, m.texte
     FROM messages m JOIN fils f ON f.id = m.fil_id
     LEFT JOIN lectures l ON l.agent = ? AND l.fil_id = m.fil_id
     WHERE m.id > COALESCE(l.dernier_id, 0) AND m.auteur <> ? AND m.auteur <> 'salle' ${sommeil}
       AND NOT EXISTS (SELECT 1 FROM appels_livres x WHERE x.agent = ? AND x.message_id = m.id)
     ORDER BY m.id`, [agent, agent, agent]);
  return candidats.filter((m) => mots.some((mot) => nomme(m.texte, mot)));
}

// Les questions qui nomment l'agent et auxquelles il n'a rien répondu dans leur fil, les plus récentes d'abord :
// sans rappel, une question lue s'oublie. Une question, c'est un
// message d'un autre, avec un point d'interrogation, qui nomme l'agent ; y répondre, c'est poster ensuite dans le même fil.
// Les annonces de la salle (ouverture, fermeture d'un fil) ne sont jamais des questions.
export function questionsEnAttente(t: Tableau, agent: string, alias: string[], limite = 3): Message[] {
  const mots = alias.filter((a) => a && a.trim() !== "");
  if (mots.length === 0) return [];
  const candidats = t.all<Message>(
    `SELECT m.id, f.nom AS fil, m.auteur, m.cree_le, m.texte
     FROM messages m JOIN fils f ON f.id = m.fil_id
     WHERE m.auteur <> ? AND m.auteur <> 'salle' AND m.texte LIKE '%?%'
       AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.fil_id = m.fil_id AND r.auteur = ? AND r.id > m.id)
     ORDER BY m.id DESC`, [agent, agent]);
  return candidats.filter((m) => mots.some((mot) => sAdresseA(m.texte, mot))).slice(0, limite);
}

// Les questions de la salle restées sans réponse : un message avec un point d'interrogation
// après lequel personne d'autre que son auteur n'a posté dans son fil ; les plus récentes d'abord. Le fil tickets est
// laissé aux tickets, qui se rappellent eux-mêmes.
export function questionsSansReponse(t: Tableau, limite = 3): Message[] {
  return t.all<Message>(
    `SELECT m.id, f.nom AS fil, m.auteur, m.cree_le, m.texte
     FROM messages m JOIN fils f ON f.id = m.fil_id
     WHERE m.texte LIKE '%?%' AND f.nom <> 'tickets'
       AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.fil_id = m.fil_id AND r.auteur <> m.auteur AND r.id > m.id)
     ORDER BY m.id DESC LIMIT ?`, [limite]);
}

// À qui s'adresse une question : l'agent nommé en tête du message (« Denis → Antoine : »,
// « Edmond — question de Bernard »), ou dans une phrase qui pose la question. Pas celui qu'elle cite en passant :
// « la 3D d'Hubert » faisait rappeler à Hubert une question posée à Antoine.
export function sAdresseA(texte: string, mot: string): boolean {
  const ligne = texte.split("\n", 1)[0]!;
  const deuxPoints = ligne.indexOf(":");
  const tete = (deuxPoints >= 0 ? ligne.slice(0, deuxPoints) : ligne).slice(0, 160);
  if (nomme(tete, mot)) return true;
  return (texte.match(/[^.!?\n]*\?/g) ?? []).some((phrase) => nomme(phrase, mot));
}

// undefined = hors de partage/ (vide, absolu, ou remontant au-dessus de la racine)
export function normaliserChemin(chemin: string): string | undefined {
  if (!chemin || chemin.trim() === "") return undefined;
  if (chemin.startsWith("/")) return undefined;
  const segments: string[] = [];
  for (const s of chemin.split("/")) {
    if (s === "" || s === ".") continue;
    if (s === "..") {
      if (segments.length === 0) return undefined;
      segments.pop();
    } else segments.push(s);
  }
  return segments.length === 0 ? undefined : segments.join("/");
}

// La clé d'un chemin pour le comparer à un autre : le disque du Mac (APFS) ignore la casse et la forme Unicode ;
// « src/Solveur.ts » et « src/solveur.ts » sont un seul fichier, qu'une comparaison exacte prenait pour deux.
export const cleChemin = (chemin: string): string => chemin.normalize("NFC").toLowerCase();

export type Reclamation = { ok: true } | { ok: false; raison?: string; occupe_par?: string; depuis?: string; reessayer?: boolean };

export function reclamer(t: Tableau, agent: string, chemin: string, raison: string): Reclamation {
  const propre = normaliserChemin(chemin);
  if (!propre) return { ok: false, raison: `${chemin} est hors du dossier partagé. Définitif pour ce chemin` };
  const meme = t.all<{ chemin: string; agent: string; pose_le: string }>("SELECT chemin, agent, pose_le FROM reclamations WHERE retire_le IS NULL")
    .find((r) => r.chemin !== propre && cleChemin(r.chemin) === cleChemin(propre));
  if (meme) return meme.agent === agent ? { ok: true } : { ok: false, occupe_par: meme.agent, depuis: meme.pose_le };
  try {
    t.transaction(() => {
      t.run("INSERT INTO reclamations(chemin, agent, raison, pose_le) VALUES (?, ?, ?, ?)", [propre, agent, raison, maintenant()]);
      const c = raison.trim() ? cite(raison) : undefined;
      noterFait(t, { type: "pancarte", agent, source: "tableau", sujet: propre, texte: `pancarte · ${propre} · ${agent}${c ? ` · ${c.texte}` : ""}`, details: c?.details });
    });
    return { ok: true };
  } catch (e) {
    const message = String((e as Error).message ?? e);
    if (/UNIQUE/i.test(message)) {
      const p = t.get<{ agent: string; pose_le: string }>("SELECT agent, pose_le FROM reclamations WHERE chemin = ? AND retire_le IS NULL", [propre]);
      return p ? { ok: false, occupe_par: p.agent, depuis: p.pose_le } : { ok: false, reessayer: true }; // libérée entre-temps
    }
    if (/BUSY|LOCKED/i.test(message)) return { ok: false, reessayer: true };
    throw e;
  }
}

export function liberer(t: Tableau, agent: string, chemin: string): { ok: boolean } {
  const propre = normaliserChemin(chemin);
  if (!propre) return { ok: false };
  return t.transaction(() => {
    const ok = t.run("UPDATE reclamations SET retire_le = ? WHERE chemin = ? AND agent = ? AND retire_le IS NULL", [maintenant(), propre, agent]).changes > 0;
    if (ok) noterPancarteRetiree(t, agent, propre);
    return { ok };
  });
}

export function reclamations(t: Tableau): Array<{ chemin: string; agent: string; raison: string; pose_le: string }> {
  return t.all("SELECT chemin, agent, raison, pose_le FROM reclamations WHERE retire_le IS NULL ORDER BY id");
}

// Le bilan par côté d'un run à deux modèles : groupé par côté, la colonne qui dit qui est homme ou femme
// (le lanceur refuse deux fois le même modèle, mais le côté reste la vraie clé). Les messages passent par une sous-requête groupée : une
// jointure directe multiplierait coûts et appels par le nombre de messages. Activité et dépense, pas qualité.
export type CoteBilan = { cote: Cote; modele: string; agents: number; finis: number; vires: number; perdus: number; cout: number; coutEstime: boolean; tokens: number; appels: number; messages: number };
// Fils de concentration : chaque résumé de lot compte du côté de son premier demandeur (lots.cote, hommes
// à défaut), par une sous-requête groupée elle aussi, lue une fois par côté (max) pour ne pas la multiplier par les agents.
export function parCote(t: Tableau): CoteBilan[] {
  const avecLots = aTable(t, "lots");
  const lignes = t.all<Omit<CoteBilan, "coutEstime"> & { coutEstime: number }>(`SELECT a.cote, max(a.modele) AS modele, count(*) AS agents,
      coalesce(sum(a.etat = 'fini'), 0) AS finis, coalesce(sum(a.etat = 'vire'), 0) AS vires, coalesce(sum(a.etat = 'perdu'), 0) AS perdus,
      coalesce(sum(a.cout_usd), 0)${avecLots ? " + coalesce(max(l.c), 0)" : ""} AS cout,
      ${avecLots ? "max(coalesce(max(a.cout_estime), 0), coalesce(max(l.e), 0))" : "coalesce(max(a.cout_estime), 0)"} AS coutEstime,
      coalesce(sum(a.tokens_entree + a.tokens_sortie), 0) AS tokens, coalesce(sum(a.appels), 0) AS appels, coalesce(sum(m.n), 0) AS messages
    FROM agents a LEFT JOIN (SELECT auteur, count(*) AS n FROM messages GROUP BY auteur) m ON m.auteur = a.nom
    ${avecLots ? "LEFT JOIN (SELECT coalesce(cote, 'hommes') AS cote, sum(cout_usd) AS c, max(cout_estime) AS e FROM lots GROUP BY 1) l ON l.cote = a.cote" : ""}
    WHERE a.cote IS NOT NULL GROUP BY a.cote ORDER BY a.cote = 'femmes'`);
  return lignes.map((l) => ({ ...l, cout: arrondi(l.cout), coutEstime: !!l.coutEstime }));
}

// Un run à rôles sur plusieurs modèles (--modele-role) : activité et dépense de chaque modèle, avec les rôles
// qu'il tient. Les résumés de lots n'y sont pas : ils restent comptés à part (« dont résumés de fils »).
export type ModeleBilan = Omit<CoteBilan, "cote"> & { roles: string[] };
export function parModele(t: Tableau): ModeleBilan[] {
  const lignes = t.all<Omit<ModeleBilan, "coutEstime" | "roles"> & { coutEstime: number; roles: string | null }>(`SELECT a.modele, count(*) AS agents,
      coalesce(sum(a.etat = 'fini'), 0) AS finis, coalesce(sum(a.etat = 'vire'), 0) AS vires, coalesce(sum(a.etat = 'perdu'), 0) AS perdus,
      coalesce(sum(a.cout_usd), 0) AS cout, coalesce(max(a.cout_estime), 0) AS coutEstime,
      coalesce(sum(a.tokens_entree + a.tokens_sortie), 0) AS tokens, coalesce(sum(a.appels), 0) AS appels, coalesce(sum(m.n), 0) AS messages,
      group_concat(DISTINCT a.role) AS roles
    FROM agents a LEFT JOIN (SELECT auteur, count(*) AS n FROM messages GROUP BY auteur) m ON m.auteur = a.nom
    WHERE a.modele IS NOT NULL GROUP BY a.modele ORDER BY min(a.rowid)`);
  return lignes.map((l) => ({ ...l, cout: arrondi(l.cout), coutEstime: !!l.coutEstime, roles: l.roles ? l.roles.split(",") : [] }));
}

// La dépense vue d'un agent : ses collègues et les résumés de lots, lus en base ; le lanceur, lui, garde ses compteurs.
export function budget(t: Tableau): { depense: number; plafond: number; reste: number } {
  const resumes = aTable(t, "lots") ? t.get<{ s: number | null }>("SELECT SUM(cout_usd) AS s FROM lots")?.s ?? 0 : 0;
  const depense = arrondi((t.get<{ s: number | null }>("SELECT SUM(cout_usd) AS s FROM agents")?.s ?? 0) + resumes);
  const plafond = t.get<{ p: number }>("SELECT plafond_usd AS p FROM run")?.p ?? 0;
  return { depense, plafond, reste: arrondi(plafond - depense) };
}

// Pilotage de la salle : les montants et les durées dits aux agents, par l'outil et par le lanceur.
export const dollars = (x: number, decimales: number) => x.toFixed(decimales).replace(".", ",") + " $";
export const dureeTexte = (minutes: number) => minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;

// Pilotage de la salle : le rythme de dépense sur la dernière fenêtre (30 min), en dollars par heure,
// et le temps que tient le reste à ce rythme (null quand rien n'a été dépensé dans la fenêtre). evenements.cout_usd est
// le coût d'une seule réponse ; les lots, celui des résumés de fils. Un run plus court que la fenêtre divise par sa durée.
// Pas d'index sur horodatage : lu seulement par salle_budget et les annonces du lanceur, jamais à chaque tour.
export function rythme(t: Tableau, maintenantMs = Date.now(), reste?: number, fenetreMs = Number(process.env.ESSAIM_RYTHME_MS ?? 30 * 60_000)): { dollarsHeure: number; tempsRestantMin: number | null } {
  const depuis = new Date(maintenantMs - fenetreMs).toISOString();
  const agents = t.get<{ s: number | null }>("SELECT SUM(cout_usd) AS s FROM evenements WHERE horodatage >= ?", [depuis])?.s ?? 0;
  const resumes = aTable(t, "lots") ? t.get<{ s: number | null }>("SELECT SUM(cout_usd) AS s FROM lots WHERE fait_le >= ?", [depuis])?.s ?? 0 : 0;
  const debut = t.get<{ debut: string | null }>("SELECT debut FROM run")?.debut;
  const duree = Math.min(fenetreMs, debut ? maintenantMs - Date.parse(debut) : fenetreMs);
  const dollarsHeure = duree > 0 ? arrondi((agents + resumes) / (duree / 3_600_000)) : 0;
  reste ??= budget(t).reste; // le lanceur passe le sien, tenu en mémoire comme la coupure au plafond
  return { dollarsHeure, tempsRestantMin: dollarsHeure > 0 ? Math.max(0, Math.round((reste / dollarsHeure) * 60)) : null };
}
// Le rythme dit en une phrase, la même pour salle_budget et les messages du lanceur (la pause y est dite).
export function texteRythme(r: { dollarsHeure: number; tempsRestantMin: number | null }): string {
  return (r.tempsRestantMin === null ? "rien dépensé sur les 30 dernières minutes"
    : `rythme ${dollars(r.dollarsHeure, 2)} par heure sur les 30 dernières minutes, soit environ ${dureeTexte(r.tempsRestantMin)} à ce rythme`) + " (une pause fait baisser le rythme)";
}

// Le temps écoulé depuis `depuisMs`, sans les pauses du run ni les veilles de la machine : lues dans les
// événements du lanceur (pause → reprise, la veille avec sa durée), pour que l'outil et le lanceur comptent pareil.
export function dureeHorsPause(t: Tableau, depuisMs: number, maintenantMs = Date.now()): number {
  const ev = t.all<{ horodatage: string; type: string; resultat_resume: string | null }>(
    "SELECT horodatage, type, resultat_resume FROM evenements WHERE agent = 'lanceur' AND type IN ('pause', 'reprise', 'veille') AND horodatage >= ? ORDER BY id",
    [new Date(depuisMs - 24 * 3_600_000).toISOString()]);
  const trous: Array<[number, number]> = [];
  let pause: number | undefined;
  for (const e of ev) {
    const h = Date.parse(e.horodatage);
    if (e.type === "pause") pause ??= h;
    else if (e.type === "reprise") { if (pause !== undefined) trous.push([pause, h]); pause = undefined; }
    else { const min = Number(/(\d+) min/.exec(e.resultat_resume ?? "")?.[1] ?? 0); trous.push([h - min * 60_000, h]); }
  }
  if (pause !== undefined) trous.push([pause, maintenantMs]);
  const exclu = trous.reduce((s, [a, b]) => s + Math.max(0, Math.min(b, maintenantMs) - Math.max(a, depuisMs)), 0);
  return Math.max(0, maintenantMs - depuisMs - exclu);
}

// Pilotage de la salle : ce qu'un agent attend. En attente : un ticket confié ouvert ou en cours, une
// demande de rejeu pas encore faite, une demande au dépôt en attente, ou ce qu'il a dit attendre en s'endormant (attend),
// tant que ce n'est pas plus vieux que attenteMaxMs, pauses exclues ; au-delà, l'attente est périmée et l'agent redevient
// oisif.
// Une attente déclarée ne tient que si elle nomme quelque chose (attenteTient) ; sinon elle
// est vague (« un nouveau ticket d'Antoine », « une nouvelle part ») et l'agent est disponible tout de suite.
// vague : l'attente déclarée telle quelle, quand elle ne tient pas.
// surTicket : en veille sur un ticket ouvert que rien n'a fait bouger depuis ticketMaxMs.
export type Attente = { texte: string; perimee: boolean; vague?: string; surTicket?: boolean } | null;
export type HorlogePilotage = { maintenantMs?: number; attenteMaxMs?: number; ticketMaxMs?: number };
// repartiteur : celui qui répartit le travail ; attendre de lui une part, c'est être disponible.
export type OptionsAttente = HorlogePilotage & { repartiteur?: string };
const attenteMax = (o: HorlogePilotage) => o.attenteMaxMs ?? Number(process.env.ESSAIM_ATTENTE_MS ?? 30 * 60_000);
const endormiDepuis = (t: Tableau, endormiLe: string | null, maintenantMs: number) => endormiLe ? dureeHorsPause(t, Date.parse(endormiLe), maintenantMs) : 0;
// Sans limite, un constructeur en veille qui porte un ticket « attend son ticket » indéfiniment et aucune ronde ne
// part. Au-delà de ESSAIM_TICKET_DORT_MS (20 min, pauses exclues) sans
// que ni lui ni son ticket ne bouge, l'attente est périmée : il compte disponible, sur son ticket.
const ticketMax = (o: HorlogePilotage) => o.ticketMaxMs ?? Number(process.env.ESSAIM_TICKET_DORT_MS ?? 20 * 60_000);
export function attenteDe(t: Tableau, nom: string, o: OptionsAttente = {}): Attente {
  const tickets = t.all<{ id: number; maj_le: string }>(`SELECT id, maj_le FROM tickets WHERE charge = ? AND ${ACTIF} ORDER BY id`, [nom]);
  if (tickets.length) {
    const texte = `ticket${tickets.length > 1 ? "s" : ""} ${tickets.map((k) => `#${k.id}`).join(", ")}`;
    const dort = t.get<{ endormi_le: string | null }>("SELECT endormi_le FROM agents WHERE nom = ? AND etat = 'dormant'", [nom]);
    const bouge = [dort?.endormi_le ?? "", ...tickets.map((k) => k.maj_le)].sort().at(-1)!;
    if (dort?.endormi_le && endormiDepuis(t, bouge, o.maintenantMs ?? Date.now()) >= ticketMax(o)) {
      const min = Math.round(endormiDepuis(t, bouge, o.maintenantMs ?? Date.now()) / 60_000);
      return { texte: `en veille sur ${texte}, sans mouvement depuis ${min} min`, perimee: true, surTicket: true };
    }
    return { texte, perimee: false };
  }
  const rejeu = t.get<{ id: number }>("SELECT id FROM demandes_rejeu WHERE demandeur = ? AND etat <> 'faite' ORDER BY id LIMIT 1", [nom]);
  if (rejeu) return { texte: `rejeu #${rejeu.id}`, perimee: false };
  const git = t.get<{ id: number }>("SELECT id FROM demandes_git WHERE agent = ? AND etat = 'attente' ORDER BY id LIMIT 1", [nom]);
  if (git) return { texte: `demande au dépôt #${git.id}`, perimee: false };
  const a = t.get<{ attend: string | null; endormi_le: string | null }>("SELECT attend, endormi_le FROM agents WHERE nom = ?", [nom]);
  if (!a?.attend) return null;
  if (!attenteTient(t, nom, a.attend, o.repartiteur)) return { texte: `déclaré : ${a.attend}`, perimee: false, vague: a.attend };
  return { texte: `déclaré : ${a.attend}`, perimee: endormiDepuis(t, a.endormi_le, o.maintenantMs ?? Date.now()) >= attenteMax(o) };
}
// Une attente déclarée tient si elle est celle du plan, cite un ticket #n qui n'est pas fermé, ou nomme (prénom,
// surnom ou rôle, mot entier) un agent présent autre que l'agent et le répartiteur : « le verdict de la recette » tient
// tant qu'une recette est là. Mécanique, sans liste de mots vagues.
const NOMS_DE_ROLE: Record<string, string[]> = { chef: ["chef"], integrateur: ["intégrateur"], assembleur: ["assembleur"], recette: ["recette"], gardien: ["gardien", "gardien-mesureur"], constructeur: [] };
export function attenteTient(t: Tableau, nom: string, attend: string, repartiteur?: string): boolean {
  if (attend === ATTENTE_PLAN) return true;
  for (const [, n] of attend.matchAll(/#(\d+)/g)) if (t.get(`SELECT 1 FROM tickets WHERE id = ? AND ${ACTIF}`, [Number(n)])) return true;
  const role = aColonne(t, "agents", "role") ? "role" : "NULL AS role";
  return t.all<{ nom: string; surnom: string | null; role: string | null }>(`SELECT nom, surnom, ${role} FROM agents WHERE etat IN ('actif', 'dormant') AND nom <> ?`, [nom])
    .filter((a) => a.nom !== repartiteur)
    .some((a) => [a.nom, a.surnom ?? "", ...(NOMS_DE_ROLE[a.role ?? ""] ?? [])].some((x) => x.trim() !== "" && nomme(attend, x)));
}

// salle_equipe détaillée : T.equipe, lue toutes les 2 s par chaque dormeur, ne change pas. depuis :
// la mise en veille pour un dormeur (endormi_le), sinon le dernier réveil, sinon l'arrivée dans la salle.
export type MembreDetaille = { nom: string; surnom: string | null; role: string | null; suppleant_de: string | null; etat: string;
  depuis: string | null; tickets: number[]; attente: Attente };
export function equipeDetaillee(t: Tableau, o: OptionsAttente = {}): MembreDetaille[] {
  const lignes = t.all<{ nom: string; surnom: string | null; role: string | null; suppleant_de: string | null; etat: string; debut: string | null; endormi_le: string | null }>(
    "SELECT nom, surnom, role, suppleant_de, etat, debut, endormi_le FROM agents ORDER BY rowid");
  return lignes.map((a) => {
    const reveil = t.get<{ le: string | null }>("SELECT MAX(horodatage) AS le FROM evenements WHERE agent = ? AND type = 'reveil'", [a.nom])?.le;
    const tickets = t.all<{ id: number }>(`SELECT id FROM tickets WHERE charge = ? AND ${ACTIF} ORDER BY id`, [a.nom]).map((k) => k.id);
    return { nom: a.nom, surnom: a.surnom, role: a.role, suppleant_de: a.suppleant_de, etat: a.etat,
      depuis: a.etat === "dormant" ? a.endormi_le : (reveil ?? a.debut), tickets, attente: a.etat === "dormant" ? attenteDe(t, a.nom, o) : null };
  });
}

// Les constructeurs oisifs : en veille, n'attendant rien (attente absente, vague ou périmée), hors `exclus`
// (les suppléants qui tiennent un siège : ils pilotent). depuisMs : le temps de veille, pauses exclues. perimee ou vague :
// le texte de l'attente déclarée.
export function oisifs(t: Tableau, o: OptionsAttente & { exclus?: string[] } = {}): Array<{ nom: string; depuisMs: number; perimee?: string; vague?: string; surTicket?: boolean }> {
  const maintenantMs = o.maintenantMs ?? Date.now();
  const dormeurs = t.all<{ nom: string; endormi_le: string | null }>("SELECT nom, endormi_le FROM agents WHERE role = 'constructeur' AND etat = 'dormant' ORDER BY rowid");
  return dormeurs.filter((a) => !(o.exclus ?? []).includes(a.nom)).flatMap((a) => {
    const attente = attenteDe(t, a.nom, o);
    if (attente && !attente.perimee && !attente.vague) return [];
    const depuisMs = endormiDepuis(t, a.endormi_le, maintenantMs);
    if (attente?.vague) return [{ nom: a.nom, depuisMs, vague: attente.vague }];
    return [{ nom: a.nom, depuisMs, ...(attente ? { perimee: attente.texte } : {}), ...(attente?.surTicket ? { surTicket: true } : {}) }];
  });
}

// Partir sans demander : un constructeur ne quitte la salle qu'après avoir demandé à celui qui répartit
// le travail s'il en reste. La question : son dernier message (pas une mise en veille) dont la tête (avant « : ») nomme
// le répartiteur (prénom ou surnom), avec un point d'interrogation, posté après la fermeture de son dernier ticket.
// repondu : un message du répartiteur depuis, qui nomme l'agent, mise en veille comprise (« Claude : non, tu peux partir »).
export function questionAuRepartiteur(t: Tableau, agent: string, rep: string): { le: string; repondu: boolean } | undefined {
  const depuis = t.get<{ le: string | null }>("SELECT MAX(maj_le) AS le FROM tickets WHERE charge = ? AND etat = 'ferme'", [agent])?.le ?? "";
  const noms = alias(t, rep);
  const tete = (texte: string) => { const l = texte.split("\n", 1)[0]!; const i = l.indexOf(":"); return i < 0 ? "" : l.slice(0, i); };
  const q = t.all<{ id: number; cree_le: string; texte: string }>("SELECT id, cree_le, texte FROM messages WHERE auteur = ? AND sommeil = 0 AND cree_le > ? ORDER BY id DESC", [agent, depuis])
    .find((m) => m.texte.includes("?") && noms.some((n) => nomme(tete(m.texte), n)));
  if (!q) return undefined;
  const moi = alias(t, agent);
  const reponses = t.all<{ texte: string }>("SELECT texte FROM messages WHERE auteur = ? AND id > ?", [rep, q.id]);
  return { le: q.cree_le, repondu: reponses.some((m) => moi.some((n) => nomme(m.texte, n))) };
}

// Préparer la mission : les constructeurs démarrent en veille avec cette
// attente ; la direction prépare un plan, la recette et le gardien le contrôlent ; validé (ou la préparation close par le
// lanceur), l'attente est levée.
export const ATTENTE_PLAN = "le plan de la salle";
export type EtatPreparation = "en_cours" | "validee" | "close";
export function preparation(t: Tableau): EtatPreparation | null {
  return aColonne(t, "run", "preparation") ? (t.get<{ p: EtatPreparation | null }>("SELECT preparation AS p FROM run")?.p ?? null) : null;
}
export function ouvrirPreparation(t: Tableau): void { t.run("UPDATE run SET preparation = 'en_cours'"); }
export function clorePreparation(t: Tableau, etat: Exclude<EtatPreparation, "en_cours">): boolean {
  return t.transaction(() => {
    if (t.run("UPDATE run SET preparation = ? WHERE preparation = 'en_cours'", [etat]).changes === 0) return false;
    t.run("UPDATE agents SET attend = NULL WHERE attend = ?", [ATTENTE_PLAN]);
    return true;
  });
}
export type EtapePlan = "spec" | "plan";
export type Plan = { id: number; auteur: string; resume: string; fichier: string | null; cree_le: string; etape?: EtapePlan | null; valide_le?: string | null; decoupage?: string | null;
  revision_id?: number | null; empreinte?: string | null; exigences_changees?: string | null; tickets_repris?: string | null };
export function proposerPlan(t: Tableau, auteur: string, resume: string, fichier?: string, etape: EtapePlan = "plan",
  r: { revision?: number; empreinte?: string; exigencesChangees?: string[]; ticketsRepris?: number[]; decoupage?: string } = {}): number {
  const id = aColonne(t, "plans", "etape")
    ? t.run("INSERT INTO plans(auteur, resume, fichier, cree_le, etape) VALUES (?, ?, ?, ?, ?)", [auteur, resume, fichier ?? null, maintenant(), etape]).lastId
    : t.run("INSERT INTO plans(auteur, resume, fichier, cree_le) VALUES (?, ?, ?, ?)", [auteur, resume, fichier ?? null, maintenant()]).lastId;
  if (aColonne(t, "plans", "revision_id"))
    t.run("UPDATE plans SET revision_id = ?, empreinte = ?, exigences_changees = ?, tickets_repris = ? WHERE id = ?", [r.revision ?? null, r.empreinte ?? null,
      r.exigencesChangees ? JSON.stringify(r.exigencesChangees) : null, r.ticketsRepris ? JSON.stringify(r.ticketsRepris) : null, id]);
  // Les jalons : l'empreinte du découpage au moment de la proposition, vérifiée au jugement.
  if (r.decoupage !== undefined && aColonne(t, "plans", "decoupage")) t.run("UPDATE plans SET decoupage = ? WHERE id = ?", [r.decoupage, id]);
  return id;
}
// La spec puis le plan : une version validée par tous les contrôleurs présents est marquée ; la spec validée
// ouvre l'étape du plan et ne se repropose plus.
// Le surveillant : une version n'est validée qu'une fois ; rend vrai au premier passage seulement.
export function marquerPlanValide(t: Tableau, id: number): boolean {
  return aColonne(t, "plans", "valide_le") && t.run("UPDATE plans SET valide_le = ? WHERE id = ? AND valide_le IS NULL", [maintenant(), id]).changes > 0;
}
// Pendant une révision acceptée, la spec validée qui compte est celle de la révision.
export function specValidee(t: Tableau): boolean {
  if (!aColonne(t, "plans", "etape")) return false;
  const revision = aTable(t, "revisions") ? t.get<{ id: number }>("SELECT id FROM revisions WHERE etat = 'acceptee' ORDER BY id DESC LIMIT 1")?.id : undefined;
  if (revision !== undefined) return !!t.get("SELECT 1 FROM plans WHERE etape = 'spec' AND valide_le IS NOT NULL AND revision_id = ?", [revision]);
  return !!t.get("SELECT 1 FROM plans WHERE etape = 'spec' AND valide_le IS NOT NULL");
}
// revision : la dernière proposition de cette révision (surveillant).
export function dernierPlan(t: Tableau, revision?: number): Plan | undefined {
  if (!aTable(t, "plans")) return undefined;
  return revision === undefined ? t.get<Plan>("SELECT * FROM plans ORDER BY id DESC LIMIT 1") : t.get<Plan>("SELECT * FROM plans WHERE revision_id = ? ORDER BY id DESC LIMIT 1", [revision]);
}
export const lirePlan = (t: Tableau, id: number): Plan | undefined => aTable(t, "plans") ? t.get<Plan>("SELECT * FROM plans WHERE id = ?", [id]) : undefined;
// Juger la dernière version ; rend si chaque contrôleur présent l'a désormais jugée « valide » (son dernier jugement).
export function jugerPlan(t: Tableau, j: { plan: number; agent: string; role: string; verdict: "valide" | "a_revoir"; raison: string }, controleurs: string[]): boolean {
  t.run("INSERT INTO plan_jugements(plan_id, agent, role, verdict, raison, cree_le) VALUES (?, ?, ?, ?, ?, ?)", [j.plan, j.agent, j.role, j.verdict, j.raison, maintenant()]);
  return controleurs.every((c) => t.get<{ v: string }>("SELECT verdict AS v FROM plan_jugements WHERE plan_id = ? AND agent = ? ORDER BY id DESC LIMIT 1", [j.plan, c])?.v === "valide");
}

// Parler au chef pendant un run. La vue dépose une consigne (fichier <run>/consignes/*.txt) ; le
// lanceur la poste, signée lanceur, à celui qui répartit le travail : « Antoine : consigne : … », qui ne réveille que lui.
// L'historique se relit dans les messages : livrée (appels_livres), et le début du premier message qu'il a écrit
// ensuite ; une consigne n'est retenue que si le message commence par « <un agent du run> : consigne : » (pas une ronde
// qui recopierait un titre). Les consignes écartées faute de répartiteur viennent des événements du lanceur.
export const MARQUE_CONSIGNE = " : consigne : ";
export const CONSIGNE_MAX_SIGNES = 700; // la consigne (600 signes au plus, serveur) et sa tête « Antoine : consigne : »
export const PREFIXE_ECARTEE = "consigne écartée, personne ne répartit le travail : ";
const DEBUT_REPONSE = 200; // signes du premier message du destinataire montrés dans l'historique
export type Consigne = { id: number; destinataire: string; texte: string; le: string; lu_le: string | null; reponse: { le: string; texte: string } | null; ecartee?: true };
export function consignes(t: Tableau): Consigne[] {
  const agents = new Set(t.all<{ nom: string }>("SELECT nom FROM agents").map((a) => a.nom));
  const transmises = t.all<{ id: number; texte: string; cree_le: string }>("SELECT id, texte, cree_le FROM messages WHERE auteur = 'lanceur' AND instr(texte, ?) > 0 ORDER BY id", [MARQUE_CONSIGNE])
    .flatMap((m) => {
      const i = m.texte.indexOf(MARQUE_CONSIGNE), destinataire = m.texte.slice(0, i);
      if (!agents.has(destinataire)) return [];
      const lu = t.get<{ le: string }>("SELECT livre_le AS le FROM appels_livres WHERE agent = ? AND message_id = ?", [destinataire, m.id])?.le ?? null;
      const r = t.get<{ le: string; texte: string }>("SELECT cree_le AS le, texte FROM messages WHERE auteur = ? AND id > ? AND sommeil = 0 ORDER BY id LIMIT 1", [destinataire, m.id]);
      return [{ id: m.id, destinataire, texte: m.texte.slice(i + MARQUE_CONSIGNE.length), le: m.cree_le, lu_le: lu, reponse: r ? { le: r.le, texte: r.texte.slice(0, DEBUT_REPONSE) } : null }];
    });
  const ecartees = t.all<{ id: number; horodatage: string; resultat_resume: string }>("SELECT id, horodatage, resultat_resume FROM evenements WHERE agent = 'lanceur' AND type = 'consigne' AND resultat_resume LIKE ?", [`${PREFIXE_ECARTEE}%`])
    .map((e) => ({ id: -e.id, destinataire: "", texte: e.resultat_resume.slice(PREFIXE_ECARTEE.length), le: e.horodatage, lu_le: null, reponse: null, ecartee: true as const }));
  return [...transmises, ...ecartees].sort((a, b) => a.le.localeCompare(b.le));
}

// Les présents qui portent des tickets de travail ouverts (comme ticketsSansPorteur), du plus chargé au moins chargé.
export function chargeParPorteur(t: Tableau, presents: string[]): Array<{ nom: string; tickets: number }> {
  return t.all<{ nom: string; tickets: number }>(`SELECT charge AS nom, count(*) AS tickets FROM tickets WHERE ${ACTIF} AND sorte = 'travail' AND charge IS NOT NULL GROUP BY charge ORDER BY tickets DESC, MIN(id)`)
    .filter((x) => presents.includes(x.nom));
}

// Les tickets de travail ouverts qui n'ont pas de porteur présent : non confiés, ou confiés à un agent sorti.
// L'état de la salle calculé par le lanceur, donné à celui qui répartit à chaque réveil et
// après chaque résumé : ses résumés gardent le récit et perdent la répartition (tickets confiés à des agents
// partis, dormeurs oubliés). Des faits seulement, aucune
// consigne ; exigences : la ligne déjà composée par l'appelant (vide : omise).
// Deux lignes de plus pour que l'intégrateur ne soit pas chargé comme un constructeur : la file des essais, l'âge du livrable
// (livrable : son chemin et la date de son dernier commit, lue par l'appelant).
export function tableauDeBord(t: Tableau, moi: string, o: HorlogePilotage & { exigences?: string; livrable?: { chemin: string; le: string } } = {}): string {
  const maintenantMs = o.maintenantMs ?? Date.now();
  const agents = t.all<{ nom: string; etat: string; role: string | null }>("SELECT nom, etat, role FROM agents WHERE nom <> ? ORDER BY rowid", [moi]);
  const ouverts = t.all<{ id: number; charge: string | null; sorte: string }>("SELECT id, charge, sorte FROM tickets WHERE etat <> 'ferme' ORDER BY id");
  const deLui = (nom: string) => ouverts.filter((k) => k.charge === nom).map((k) => `#${k.id}`);
  const nom = (a: { nom: string; role: string | null }) => a.role && a.role !== "constructeur" ? `${a.nom} (${(NOMS_DE_ROLE as Record<string, string[]>)[a.role]?.at(-1) ?? a.role})` : a.nom;
  const liste = (l: string[], max = 25) => l.length ? l.slice(0, max).join(", ") + (l.length > max ? `, et ${l.length - max} autres` : "") : "personne";
  const travail = agents.filter((a) => a.etat === "actif").map((a) => { const k = deLui(a.nom); return `${nom(a)}${k.length ? ` ${k.join(" ")}` : ""}`; });
  const veille = agents.filter((a) => a.etat === "dormant").map((a) => {
    const k = deLui(a.nom);
    const le = t.get<{ e: string | null }>("SELECT endormi_le AS e FROM agents WHERE nom = ?", [a.nom])?.e;
    const min = le ? Math.round(endormiDepuis(t, le, maintenantMs) / 60_000) : 0;
    return { texte: `${nom(a)} (${k.length ? k.join(" ") : "aucun ticket"}, ${min} min)`, avec: k.length > 0 };
  }).sort((x, y) => Number(y.avec) - Number(x.avec)).map((x) => x.texte);
  const partis = agents.filter((a) => a.etat !== "actif" && a.etat !== "dormant");
  const laisses = ouverts.filter((k) => k.charge && partis.some((a) => a.nom === k.charge)).map((k) => `#${k.id} (${k.charge})`);
  const sansPorteur = ouverts.filter((k) => !k.charge).map((k) => `#${k.id}`);
  const heure = new Date(maintenantMs).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  return [
    `État de la salle à ${heure}, calculé par le lanceur à l'instant (ta mémoire peut ne plus l'être) :`,
    `- au travail (${travail.length}) : ${liste(travail)}`,
    `- en veille (${veille.length}) : ${liste(veille)}`,
    `- partis (${partis.length}) : ${liste(partis.map((a) => `${a.nom} (${a.etat === "vire" ? "viré" : a.etat})`), 30)}`,
    `- tickets ouverts encore au nom d'un parti : ${laisses.length ? liste(laisses) : "aucun"}`,
    `- tickets ouverts sans porteur : ${sansPorteur.length ? liste(sansPorteur) : "aucun"}`,
    ...(o.exigences ? [`- exigences pas encore tenues : ${o.exigences}`] : []),
    ...essaisDuTableau(t, maintenantMs),
    ...(o.livrable ? [`- livrable ${o.livrable.chemin} inchangé depuis ${Math.round(dureeHorsPause(t, Date.parse(o.livrable.le), maintenantMs) / 60_000)} min`] : []),
  ].join("\n");
}

function essaisDuTableau(t: Tableau, maintenantMs: number): string[] {
  if (!aTable(t, "essais")) return [];
  const attente = essais(t).filter((e) => !e.adopte_le);
  if (!attente.length) return ["- essais pas encore adoptés : aucun"];
  const integ = t.get<{ nom: string }>("SELECT nom FROM agents WHERE role = 'integrateur' AND etat IN ('actif', 'dormant')")?.nom;
  const min = Math.round(dureeHorsPause(t, Date.parse(attente[0]!.cree_le), maintenantMs) / 60_000);
  return [`- essais pas encore adoptés : ${attente.length}, le plus ancien depuis ${min} min${integ ? ` (adoption : ${integ})` : ""}`];
}

export function ticketsSansPorteur(t: Tableau, presents: string[]): Array<{ id: number; titre: string }> {
  return t.all<{ id: number; titre: string; charge: string | null }>(`SELECT id, titre, charge FROM tickets WHERE ${ACTIF} AND sorte = 'travail' ORDER BY id`)
    .filter((k) => !k.charge || !presents.includes(k.charge)).map(({ id, titre }) => ({ id, titre }));
}

// L'agent quitte son fil en partant. Le dernier présent n'est pas refusé : sans quoi un agent resté seul
// dans un fil ne pourrait plus jamais partir.
export function fini(t: Tableau, agent: string, raison: string, fichier?: string): { ok: true } {
  return t.transaction(() => {
    const change = t.run("UPDATE agents SET etat = 'fini', raison_sortie = ?, fichier_livre = ?, derniere_activite = ? WHERE nom = ? AND etat = 'actif'",
      [raison, fichier ?? null, maintenant(), agent]).changes > 0;
    if (change) {
      const c = cite(raison);
      noterAgent(t, agent, `${agent} · fini · raison déclarée par ${agent} : ${c.texte}`, c.details);
    }
    // Comme sortirDuFil : le dernier présent qui part ferme le fil, sans conclusion ; il restait ouvert sans personne.
    const p = aTable(t, "presences") ? t.get<{ fil_id: number; nom: string; ouvert_le: string | null; ferme_le: string | null }>(
      "SELECT p.fil_id, f.nom, f.ouvert_le, f.ferme_le FROM presences p JOIN fils f ON f.id = p.fil_id WHERE p.agent = ?", [agent]) : undefined;
    t.run("DELETE FROM presences WHERE agent = ?", [agent]);
    if (p && presentsVivants(t, p.fil_id).length === 0 && p.ouvert_le !== null && p.ferme_le === null) fermerFil(t, p.fil_id, p.nom, agent, null, `fini : ${raison}`);
    return { ok: true as const };
  });
}

// ---- Les fils de concentration -------------------------------
// Un agent entre dans un fil pour s'y isoler ; le dernier qui sort conclut. « Le dernier présent » se décide dans
// la transaction qui retire la présence ou écrit l'état terminal, sur les seuls agents vivants.

function presentsVivants(t: Tableau, filId: number): string[] {
  return t.all<{ agent: string }>(
    "SELECT p.agent FROM presences p JOIN agents a ON a.nom = p.agent WHERE p.fil_id = ? AND a.etat IN ('actif', 'dormant') ORDER BY p.entre_le, p.agent",
    [filId]).map((r) => r.agent);
}

export function estDernier(t: Tableau, agent: string): boolean {
  const p = t.get<{ fil_id: number }>("SELECT fil_id FROM presences WHERE agent = ?", [agent]);
  if (!p) return false;
  const vivants = presentsVivants(t, p.fil_id);
  return vivants.length === 1 && vivants[0] === agent;
}

const FILS_SALLE = ["principal", "verification", "tickets"];
type FilConcentration = { id: number; nom: string; pourquoi: string | null; ouvert_le: string | null; ferme_le: string | null };

// Entrer dans un fil : tout dans une transaction, annonce comprise. presents = les autres
// présents vivants. Un fil qui n'est pas encore de concentration, ou fermé, ne s'ouvre qu'avec un pourquoi.
export function entrer(t: Tableau, agent: string, fil: string, pourquoi?: string):
  { ok: true; ouvert: boolean; presents: string[]; pourquoi: string } | { ok: false; raison: string } {
  return t.transaction(() => {
    const cible = t.get<FilConcentration>("SELECT id, nom, pourquoi, ouvert_le, ferme_le FROM fils WHERE nom = ?", [fil]);
    const actuel = t.get<{ fil_id: number; nom: string }>("SELECT p.fil_id, f.nom FROM presences p JOIN fils f ON f.id = p.fil_id WHERE p.agent = ?", [agent]);
    const autres = (id: number) => presentsVivants(t, id).filter((a) => a !== agent);
    if (cible && actuel?.fil_id === cible.id) return { ok: true as const, ouvert: false, presents: autres(cible.id), pourquoi: cible.pourquoi ?? "" };
    if (FILS_SALLE.includes(fil)) return { ok: false as const, raison: `${fil} est un fil de la salle, on n'y entre pas. Définitif pour ce fil` };
    if (!t.get("SELECT 1 FROM messages WHERE auteur = ?", [agent])) return { ok: false as const, raison: "tu n'as encore rien posté. Se lève à ton premier message" };
    if (actuel && estDernier(t, agent)) return { ok: false as const, raison: `tu es le dernier présent de ${actuel.nom}. Se lève après fil_quitter avec une conclusion` };
    const ouvre = !cible || cible.ouvert_le === null || cible.ferme_le !== null;
    const motif = pourquoi?.trim() ?? "";
    if (ouvre && !motif) return { ok: false as const, raison: `${fil} n'est pas ouvert et aucun pourquoi n'est donné. Se lève avec un pourquoi non vide` };
    const id = filId(t, fil, agent)!;
    if (ouvre) {
      t.run("UPDATE fils SET ouvert_le = ?, pourquoi = ?, conclusion = NULL, ferme_le = NULL WHERE id = ?", [maintenant(), motif, id]);
      const n = insererMessage(t, "salle", `${agent} ouvre ${fil} : ${motif}`, "principal");
      const c = cite(motif, n);
      noterFait(t, { type: "fil", agent, source: "tableau", sujet: fil, messageId: n, texte: `${fil} ouvert · pourquoi déclaré par ${agent}, msg ${n} : ${c.texte}`, details: c.details });
    }
    t.run(`INSERT INTO presences(agent, fil_id, entre_le) VALUES (?, ?, ?)
           ON CONFLICT(agent) DO UPDATE SET fil_id = excluded.fil_id, entre_le = excluded.entre_le, reveil_fil = 0`, [agent, id, maintenant()]);
    return { ok: true as const, ouvert: ouvre, presents: autres(id), pourquoi: ouvre ? motif : cible!.pourquoi ?? "" };
  });
}

// Ferme un fil et l'annonce dans principal ; sans conclusion, la raison de la sortie forcée est dite.
// Le fait (second cerveau) : la conclusion est déclarée par agent, citée avec le numéro de l'annonce ; une fermeture
// sans conclusion est constatée (agent : celui dont la sortie ferme le fil, « salle » à la fin du run).
function fermerFil(t: Tableau, id: number, nom: string, agent: string, conclusion: string | null, raison?: string): void {
  t.run("UPDATE fils SET conclusion = ?, ferme_le = ? WHERE id = ?", [conclusion, maintenant(), id]);
  const annonce = conclusion !== null ? `${nom} fermé : ${conclusion}` : `${nom} fermé sans conclusion (${raison})`;
  const n = insererMessage(t, "salle", annonce, "principal");
  const c = conclusion !== null ? cite(conclusion, n) : undefined;
  noterFait(t, { type: "fil", agent, source: "tableau", sujet: nom, messageId: n, details: c?.details,
    texte: c ? `${nom} fermé · conclusion déclarée par ${agent}, msg ${n} : ${c.texte}` : annonce });
}

// Quitter son fil : le dernier présent vivant doit conclure, et sa conclusion ferme le fil.
export function quitter(t: Tableau, agent: string, conclusion?: string): { ok: true; fil: string; ferme: boolean } | { ok: false; raison: string } {
  return t.transaction(() => {
    const p = t.get<{ fil_id: number; nom: string }>("SELECT p.fil_id, f.nom FROM presences p JOIN fils f ON f.id = p.fil_id WHERE p.agent = ?", [agent]);
    if (!p) return { ok: false as const, raison: "tu n'es dans aucun fil. Se lève après fil_entrer" };
    const dernier = estDernier(t, agent);
    const texte = conclusion?.trim() ?? "";
    if (dernier && !texte) return { ok: false as const, raison: `tu es le dernier présent de ${p.nom} et la conclusion est vide. Se lève avec une conclusion non vide` };
    t.run("DELETE FROM presences WHERE agent = ?", [agent]);
    if (dernier) fermerFil(t, p.fil_id, p.nom, agent, texte);
    return { ok: true as const, fil: p.nom, ferme: dernier };
  });
}

// Les sorties forcées (fini, viré, perdu, fermeture de la salle) : la présence part sans conclusion ; le fil se ferme
// « sans conclusion » s'il n'y reste aucun vivant. Sans effet sur un tableau d'avant les fils.
export function sortirDuFil(t: Tableau, agent: string, raison: string): void {
  if (!aTable(t, "presences")) return;
  t.transaction(() => {
    const p = t.get<{ fil_id: number; nom: string; ouvert_le: string | null; ferme_le: string | null }>(
      "SELECT p.fil_id, f.nom, f.ouvert_le, f.ferme_le FROM presences p JOIN fils f ON f.id = p.fil_id WHERE p.agent = ?", [agent]);
    if (!p) return;
    t.run("DELETE FROM presences WHERE agent = ?", [agent]);
    if (presentsVivants(t, p.fil_id).length === 0 && p.ouvert_le !== null && p.ferme_le === null) fermerFil(t, p.fil_id, p.nom, agent, null, raison);
  });
}

// La fin du run : plus personne dans aucun fil, agents terminés compris, et chaque fil encore ouvert fermé.
export function fermerFils(t: Tableau, raison: string): void {
  if (!aTable(t, "presences")) return;
  t.transaction(() => {
    t.run("DELETE FROM presences");
    for (const f of t.all<{ id: number; nom: string }>("SELECT id, nom FROM fils WHERE ouvert_le IS NOT NULL AND ferme_le IS NULL ORDER BY id"))
      fermerFil(t, f.id, f.nom, "salle", null, raison);
  });
}

export function filDe(t: Tableau, agent: string): { fil: string; reveil_fil: boolean } | undefined {
  if (!aTable(t, "presences")) return undefined;
  const p = t.get<{ fil: string; reveil_fil: number }>("SELECT f.nom AS fil, p.reveil_fil FROM presences p JOIN fils f ON f.id = p.fil_id WHERE p.agent = ?", [agent]);
  return p && { fil: p.fil, reveil_fil: p.reveil_fil === 1 };
}

// Qui est dans quel fil, par fil. assoupi : le fil a des présents vivants et tous dorment.
export type Presence = { agent: string; etat: string; entre_le: string; reveil_fil: boolean };
export function presences(t: Tableau): Array<{ fil: string; presents: Presence[]; assoupi: boolean }> {
  if (!aTable(t, "presences")) return [];
  const lignes = t.all<{ fil: string; agent: string; etat: string | null; entre_le: string; reveil_fil: number }>(
    `SELECT f.nom AS fil, p.agent, a.etat, p.entre_le, p.reveil_fil FROM presences p JOIN fils f ON f.id = p.fil_id
     LEFT JOIN agents a ON a.nom = p.agent ORDER BY f.id, p.entre_le, p.agent`);
  const parFil = new Map<string, Presence[]>();
  for (const l of lignes) {
    if (!parFil.has(l.fil)) parFil.set(l.fil, []);
    parFil.get(l.fil)!.push({ agent: l.agent, etat: l.etat ?? "inconnu", entre_le: l.entre_le, reveil_fil: l.reveil_fil === 1 });
  }
  return [...parFil].map(([fil, presents]) => {
    const vivants = presents.filter((p) => p.etat === "actif" || p.etat === "dormant");
    return { fil, presents, assoupi: vivants.length > 0 && vivants.every((p) => p.etat === "dormant") };
  });
}

// ---- Les lots figés d'un fil -----------------------------------
// Les messages d'un fil sont découpés en lots consécutifs qui ne dépendent pas du lecteur : un lot commence après la
// fin du précédent et se clôt au premier message qui porte sa taille à `taille` caractères. Ce qui suit le dernier lot
// clos est la queue, toujours livrée brute. Un lot naît (en attente de résumé) la première fois qu'un lecteur en a
// besoin, et ses bornes ne bougent plus : dix lecteurs qui le demandent en même temps n'en font qu'une ligne.

export const TAILLE_LOT = Number(process.env.ESSAIM_TAILLE_LOT ?? 8000);

// entier : le lot tient tout entier dans le retard ]depuis, jusqua] ; sinon il est entamé (lu en partie, ou dépassant).
export type Lot = { id: number; fil_id: number; debut_id: number; fin_id: number; etat: string; essais: number; texte: string | null; entier: boolean };

export function lotsDuRetard(t: Tableau, filId: number, depuisId: number, jusquId: number, demandePar: string, cote: string | null, taille = TAILLE_LOT): Lot[] {
  return t.transaction(() => {
    const dernier = t.get<{ fin: number | null }>("SELECT MAX(fin_id) AS fin FROM lots WHERE fil_id = ?", [filId])?.fin ?? 0;
    let debut: number | undefined;
    let somme = 0;
    for (const m of t.all<{ id: number; n: number }>("SELECT id, length(texte) AS n FROM messages WHERE fil_id = ? AND id > ? AND id <= ? ORDER BY id", [filId, dernier, jusquId])) {
      debut ??= m.id;
      somme += m.n;
      if (somme < taille) continue;
      t.run("INSERT OR IGNORE INTO lots(fil_id, debut_id, fin_id, demande_par, cote, cree_le) VALUES (?, ?, ?, ?, ?, ?)", [filId, debut, m.id, demandePar, cote, maintenant()]);
      debut = undefined;
      somme = 0;
    }
    return t.all<Omit<Lot, "entier">>(
      "SELECT id, fil_id, debut_id, fin_id, etat, essais, texte FROM lots WHERE fil_id = ? AND fin_id > ? AND debut_id <= ? ORDER BY debut_id",
      [filId, depuisId, jusquId]).map((l) => ({ ...l, entier: l.debut_id > depuisId && l.fin_id <= jusquId }));
  });
}

// Un lot en échec repasse en attente tant qu'il a moins de trois essais ; un lot fait n'est jamais réécrit.
export function reactiverLot(t: Tableau, id: number): boolean {
  return t.run("UPDATE lots SET etat = 'attente' WHERE id = ? AND etat = 'echec' AND essais < 3", [id]).changes > 0;
}

// La file des résumés, servie par le lanceur : jusqu'à n lots en attente, pris dans la même transaction
// (etat 'prise', un essai de plus) : aucun n'est servi deux fois.
export type LotPris = { id: number; fil_id: number; debut_id: number; fin_id: number; cote: string | null; demande_par: string };
export function prendreLots(t: Tableau, n: number): LotPris[] {
  return t.transaction(() => {
    const lots = t.all<LotPris>("SELECT id, fil_id, debut_id, fin_id, cote, demande_par FROM lots WHERE etat = 'attente' ORDER BY id LIMIT ?", [n]);
    for (const l of lots) t.run("UPDATE lots SET etat = 'prise', essais = essais + 1 WHERE id = ?", [l.id]);
    return lots;
  });
}

export function messagesDuLot(t: Tableau, lot: { fil_id: number; debut_id: number; fin_id: number }): Array<{ id: number; auteur: string; cree_le: string; texte: string }> {
  return t.all("SELECT id, auteur, cree_le, texte FROM messages WHERE fil_id = ? AND id >= ? AND id <= ? ORDER BY id", [lot.fil_id, lot.debut_id, lot.fin_id]);
}

// Le résultat d'un essai : fait (texte) ou échec ; le coût s'ajoute, échecs compris. Un lot fait n'est jamais réécrit.
export function finirLot(t: Tableau, id: number, r: { ok: boolean; texte?: string; cout: number; estime: boolean; modele: string }): void {
  t.run(`UPDATE lots SET etat = ?, texte = ?, cout_usd = cout_usd + ?, cout_estime = MAX(cout_estime, ?), modele = ?, fait_le = ?
         WHERE id = ? AND etat <> 'fait'`, [r.ok ? "fait" : "echec", r.ok ? r.texte ?? null : null, r.cout, r.estime ? 1 : 0, r.modele, maintenant(), id]);
}

// Les lots restés pris sans résumeur vivant : au démarrage d'un run, et à la fermeture sans lanceur.
export function lotsOrphelins(t: Tableau): number {
  if (!aTable(t, "lots")) return 0;
  return t.run("UPDATE lots SET etat = 'echec' WHERE etat = 'prise'").changes;
}

// ---- La lecture en trois temps -----------------------------------
// selectionner (rien d'écrit) → preparer (résumés des lots clos d'un autre fil, appels en tête) → acquitter (le seul
// préfixe contigu livré). La boîte d'un agent dans un fil ne livre que ce fil, sauf quand un message d'un autre
// fil le nomme : c'est l'exception, qui ouvre tous les fils jusqu'à ce que le retard capturé soit livré.

// Le retard d'un fil : messages d'id > depuis (le curseur), jusqu'à jusqua ; n et taille comptés avant toute pagination.
export type Retard = { filId: number; nom: string; depuis: number; premier: number; jusqua: number; n: number; taille: number };
export type Selection = { perimetre: "fil" | "sien" | "tous"; exception?: Message; fils: Retard[] };
// Tenue par l'outil, une par agent, jamais en base : le seuil (id) du retard capturé par une exception.
export type MemoireLecture = { exception?: number };

export function selectionner(t: Tableau, agent: string, fil?: string, memoire: MemoireLecture = {}): Selection {
  const retards = (nom?: string) => t.all<Retard>(
    `SELECT m.fil_id AS filId, f.nom, COALESCE(l.dernier_id, 0) AS depuis, MIN(m.id) AS premier, MAX(m.id) AS jusqua,
            count(*) AS n, SUM(length(m.texte)) AS taille
     FROM messages m JOIN fils f ON f.id = m.fil_id
     LEFT JOIN lectures l ON l.agent = ? AND l.fil_id = m.fil_id
     WHERE m.id > COALESCE(l.dernier_id, 0) ${nom === undefined ? "" : "AND f.nom = ?"}
     GROUP BY m.fil_id ORDER BY MIN(m.id)`, nom === undefined ? [agent] : [agent, nom]);
  if (fil !== undefined) return { perimetre: "fil", fils: retards(fil) };
  const sien = filDe(t, agent)?.fil;
  const tous = retards();
  if (sien === undefined) {
    memoire.exception = undefined;
    return { perimetre: "tous", fils: tous };
  }
  const exception = appelsNonLus(t, agent, alias(t, agent)).find((m) => m.fil !== sien);
  if (exception) {
    memoire.exception = Math.max(memoire.exception ?? 0, ...tous.map((r) => r.jusqua));
    return { perimetre: "tous", exception, fils: tous };
  }
  if (memoire.exception !== undefined && tous.some((r) => r.nom !== sien && r.premier <= memoire.exception!)) return { perimetre: "tous", fils: tous };
  memoire.exception = undefined;
  return { perimetre: "sien", fils: tous.filter((r) => r.nom === sien) };
}

// Ce que la lecture livre : un appel (un message d'un autre fil qui nomme l'agent, livré tel quel en tête), un
// message brut, ou le résumé d'un lot clos d'un autre fil. fil_id sert à l'acquittement.
export type MessageLu = Message & { fil_id: number };
export type Element = { type: "appel" | "brut"; message: MessageLu } | { type: "resume"; lot: Lot; texte: string };

// Construit la liste ordonnée des éléments : les appels d'abord, puis bruts et résumés dans l'ordre des ids (un résumé à
// la place de son premier message), coupée à `limite` éléments. Le fil où l'agent se trouve reste brut. Pour un autre
// fil, un lot entier devient un résumé si obtenirResume en rend un, sinon ses messages restent bruts ; un lot
// entamé et la queue restent bruts. Sans obtenirResume, aucun lot n'est créé : c'est la boîte d'avant les fils.
// Un appel déjà livré (appels_livres) ne se répète pas ; sorti en tête, il ne change ni les bornes ni le résumé de son lot.
export function preparer(t: Tableau, agent: string, selection: Selection,
  o: { obtenirResume?: (lot: Lot) => string | undefined; limite?: number; taille?: number } = {}): { elements: Element[]; reste: boolean } {
  const limite = o.limite ?? 50;
  const sien = filDe(t, agent)?.fil;
  const mots = alias(t, agent);
  const cote = t.get<{ cote: string | null }>("SELECT cote FROM agents WHERE nom = ?", [agent])?.cote ?? null;
  const dejaLivres = new Set(t.all<{ message_id: number }>("SELECT message_id FROM appels_livres WHERE agent = ?", [agent]).map((r) => r.message_id));
  const appels: MessageLu[] = [];
  const suite: Array<[number, Element]> = [];
  for (const r of selection.fils) {
    const dehors = r.nom !== sien;
    const resumes: Lot[] = [];
    if (dehors && o.obtenirResume)
      for (const lot of lotsDuRetard(t, r.filId, r.depuis, r.jusqua, agent, cote, o.taille)) {
        const texte = lot.entier ? o.obtenirResume(lot) : undefined;
        if (texte === undefined) continue;
        resumes.push(lot);
        suite.push([lot.debut_id, { type: "resume", lot, texte }]);
      }
    const messages = t.all<MessageLu>(
      `SELECT m.id, f.nom AS fil, m.fil_id, m.auteur, m.cree_le, m.texte FROM messages m JOIN fils f ON f.id = m.fil_id
       WHERE m.fil_id = ? AND m.id > ? AND m.id <= ? ORDER BY m.id`, [r.filId, r.depuis, r.jusqua]);
    for (const m of messages) {
      if (dejaLivres.has(m.id)) continue;
      if (dehors && m.auteur !== agent && m.auteur !== "salle" && mots.some((mot) => nomme(m.texte, mot))) appels.push(m);
      else if (!resumes.some((l) => l.debut_id <= m.id && m.id <= l.fin_id)) suite.push([m.id, { type: "brut", message: m }]);
    }
  }
  const tout: Element[] = [...appels.sort((a, b) => a.id - b.id).map((message) => ({ type: "appel" as const, message })),
    ...suite.sort((a, b) => a[0] - b[0]).map(([, e]) => e)];
  return { elements: tout.slice(0, limite), reste: tout.length > limite };
}

// Acquitte ce qui a été livré, en une transaction : par fil, le curseur n'avance que sur le préfixe contigu de
// messages livrés bruts, couverts par un résumé livré, ou déjà livrés comme appels ; il s'arrête au premier message
// resté non livré et ne recule jamais. Chaque appel livré est noté dans appels_livres. Les fils où ne restent devant le
// curseur que des appels déjà livrés avancent aussi. Une lecture coupée n'appelle pas acquitter : rien n'est acquitté.
export function acquitter(t: Tableau, agent: string, elements: Element[]): void {
  t.transaction(() => {
    const couverts = new Map<number, Array<[number, number]>>();
    const couvrir = (filId: number, de: number, a: number) => {
      if (!couverts.has(filId)) couverts.set(filId, []);
      couverts.get(filId)!.push([de, a]);
    };
    for (const e of elements) {
      if (e.type === "resume") couvrir(e.lot.fil_id, e.lot.debut_id, e.lot.fin_id);
      else couvrir(e.message.fil_id, e.message.id, e.message.id);
      if (e.type === "appel") t.run("INSERT OR IGNORE INTO appels_livres(agent, message_id, livre_le) VALUES (?, ?, ?)", [agent, e.message.id, maintenant()]);
    }
    for (const { fil_id } of t.all<{ fil_id: number }>(
      `SELECT DISTINCT m.fil_id FROM appels_livres x JOIN messages m ON m.id = x.message_id
       LEFT JOIN lectures l ON l.agent = x.agent AND l.fil_id = m.fil_id
       WHERE x.agent = ? AND m.id > COALESCE(l.dernier_id, 0)`, [agent])) if (!couverts.has(fil_id)) couverts.set(fil_id, []);
    for (const [filId, intervalles] of couverts) {
      const depuis = t.get<{ d: number }>("SELECT dernier_id AS d FROM lectures WHERE agent = ? AND fil_id = ?", [agent, filId])?.d ?? 0;
      let dernier = depuis;
      for (const m of t.all<{ id: number; livre: number }>(
        `SELECT m.id, EXISTS (SELECT 1 FROM appels_livres x WHERE x.agent = ? AND x.message_id = m.id) AS livre
         FROM messages m WHERE m.fil_id = ? AND m.id > ? ORDER BY m.id`, [agent, filId, depuis])) {
        if (!m.livre && !intervalles.some(([de, a]) => de <= m.id && m.id <= a)) break;
        dernier = m.id;
      }
      if (dernier > depuis)
        t.run(`INSERT INTO lectures(agent, fil_id, dernier_id) VALUES (?, ?, ?)
               ON CONFLICT(agent, fil_id) DO UPDATE SET dernier_id = MAX(dernier_id, excluded.dernier_id)`, [agent, filId, dernier]);
    }
  });
}

// ---- Les livraisons de l'état et de la ligne courte (second cerveau) ---------------
// Les annonces de fil que l'état rend en entier : parmi les `lignes` faits les plus récents de ]de, a] (ceux
// que l'état montre), les faits fil portant leur annonce (message_id) sans citation coupée (details.citation absente).
// Jamais une annonce de ticket : la ligne n'en cite que le titre ou la note. Lu par l'état et par sa confirmation.
export function annoncesCiteesEntieres(t: Tableau, de: number, a: number, lignes: number): number[] {
  return t.all<{ type: string; message_id: number | null; details_json: string | null }>(
    "SELECT type, message_id, details_json FROM faits WHERE id > ? AND id <= ? ORDER BY id DESC LIMIT ?", [de, a, lignes])
    .filter((f) => f.type === "fil" && f.message_id !== null && !(f.details_json && "citation" in (JSON.parse(f.details_json) as object)))
    .map((f) => f.message_id!).sort((x, y) => x - y);
}

// Ce que preparerLivraison garde d'une livraison (memoire.ts, Livraison).
export type LivraisonNotee = { texte: string; deFait: number; aFait: number; aMessage: number | null; lignes: number; retires: number;
  caracteres: number; rienEcrit: object[] };
const porterCurseurs = (t: Tableau, agent: string, etat: number, ligne: number) =>
  t.run(`INSERT INTO memoire_curseurs(agent, etat_fait_id, ligne_fait_id) VALUES (?, ?, ?)
         ON CONFLICT(agent) DO UPDATE SET etat_fait_id = MAX(etat_fait_id, excluded.etat_fait_id), ligne_fait_id = MAX(ligne_fait_id, excluded.ligne_fait_id)`,
  [agent, etat, ligne]);

// Un état est noté préparé (confirme_le nul) sans toucher aux curseurs : seul le lanceur le confirme, quand pi a émis
// le message utilisateur qui le porte. Une ligne courte (moment 'ligne') fait partie du résultat d'outil : notée
// confirmée à l'écriture, elle avance ligne_fait_id, jamais etat_fait_id (le prochain état reprend ses faits en entier).
// Rend l'identifiant de la livraison ; 0 sur une base sans la table.
export function preparerLivraison(t: Tableau, agent: string, moment: string, l: LivraisonNotee): number {
  if (!aTable(t, "memoire_livraisons")) return 0;
  const noter = (confirme: string | null) => t.run(`INSERT INTO memoire_livraisons(agent, livre_le, moment, de_fait, a_fait, a_message, lignes, retires,
      caracteres, texte, confirme_le, rien_ecrit_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [agent, maintenant(), moment, l.deFait, l.aFait, l.aMessage, l.lignes, l.retires, l.caracteres, l.texte, confirme, JSON.stringify(l.rienEcrit)]).lastId;
  if (moment !== "ligne") return noter(null);
  return t.transaction(() => { const id = noter(maintenant()); porterCurseurs(t, agent, 0, l.aFait); return id; });
}

// Le début de tout état (memoire.ts) : le lanceur ne cherche une livraison à confirmer que dans un message qui le porte.
export const MARQUE_ETAT = "[salle] Changements depuis";

// La confirmation : la dernière livraison d'état de l'agent dont le texte est contenu dans le message utilisateur
// émis par pi. Transaction courte et idempotente : confirme_le posé une fois, curseurs portés à MAX(actuel, a_fait),
// annonces citées entières notées dans appels_livres. false : aucune livraison ne correspond.
export function confirmerLivraison(t: Tableau, agent: string, texteMessage: string): boolean {
  if (!aTable(t, "memoire_livraisons")) return false;
  return t.transaction(() => {
    const l = t.get<{ id: number; de_fait: number; a_fait: number; lignes: number; confirme_le: string | null }>(
      `SELECT id, de_fait, a_fait, lignes, confirme_le FROM memoire_livraisons
       WHERE agent = ? AND moment <> 'ligne' AND instr(?, texte) > 0 ORDER BY id DESC LIMIT 1`, [agent, texteMessage]);
    if (!l) return false;
    if (l.confirme_le === null) t.run("UPDATE memoire_livraisons SET confirme_le = ? WHERE id = ?", [maintenant(), l.id]);
    porterCurseurs(t, agent, l.a_fait, l.a_fait);
    for (const m of annoncesCiteesEntieres(t, l.de_fait, l.a_fait, l.lignes))
      t.run("INSERT OR IGNORE INTO appels_livres(agent, message_id, livre_le) VALUES (?, ?, ?)", [agent, m, maintenant()]);
    return true;
  });
}

export function ajouterEvenement(t: Tableau, e: { agent: string; type: string; outil?: string; appelId?: string; arguments?: unknown; resultat?: string; dureeMs?: number; tokensEntree?: number; tokensSortie?: number; coutUsd?: number; erreur?: string }): void {
  t.run(`INSERT INTO evenements(agent, horodatage, type, outil, appel_id, arguments_json, resultat_resume, duree_ms, tokens_entree, tokens_sortie, cout_usd, erreur)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [e.agent, maintenant(), e.type, e.outil ?? null, e.appelId ?? null, e.arguments === undefined ? null : typeof e.arguments === "string" ? e.arguments : JSON.stringify(e.arguments),
     e.resultat ?? null, e.dureeMs ?? null, e.tokensEntree ?? null, e.tokensSortie ?? null, e.coutUsd ?? null, e.erreur ?? null]);
}

const COLONNES_AGENT: Record<string, string> = {
  pid: "pid", coutUsd: "cout_usd", coutEstime: "cout_estime", tokensEntree: "tokens_entree", tokensSortie: "tokens_sortie",
  appels: "appels", echecs: "echecs", derniereActivite: "derniere_activite", passes: "passes",
};

export function majAgent(t: Tableau, nom: string, champs: Partial<{ pid: number; coutUsd: number; coutEstime: boolean; tokensEntree: number; tokensSortie: number; appels: number; echecs: number; derniereActivite: string; passes: number }>): void {
  const set: string[] = [];
  const params: unknown[] = [];
  for (const [cle, valeur] of Object.entries(champs)) {
    if (valeur === undefined) continue;
    set.push(`${COLONNES_AGENT[cle]} = ?`);
    params.push(typeof valeur === "boolean" ? (valeur ? 1 : 0) : valeur);
  }
  if (set.length === 0) return;
  params.push(nom);
  t.run(`UPDATE agents SET ${set.join(", ")} WHERE nom = ?`, params);
}

// false si l'agent est déjà dans un état terminal (fini, vire, perdu). Un dormeur se sort comme un actif :
// il est vivant, et c'est le lanceur qui ferme la salle quand plus personne n'a de quoi le rappeler.
// La raison d'une sortie par le lanceur (ou la vue) est écrite par la salle : elle n'est pas citée comme déclarée.
const LIBELLE_SORTIE = { fini: "fini", vire: "viré", perdu: "perdu" } as const;
export function sortirAgent(t: Tableau, nom: string, etat: "fini" | "vire" | "perdu", raison: string): boolean {
  return t.transaction(() => {
    const change = t.run("UPDATE agents SET etat = ?, raison_sortie = ? WHERE nom = ? AND etat IN ('actif', 'dormant')", [etat, raison, nom]).changes > 0;
    if (change) noterAgent(t, nom, `${nom} · ${LIBELLE_SORTIE[etat]} · raison : ${raison}`);
    return change;
  });
}

// Les pancartes ouvertes sont lues dans la transaction, avant d'être retirées : un fait par fichier.
export function retirerPancartes(t: Tableau, agent: string): number {
  return t.transaction(() => {
    const ouvertes = t.all<{ chemin: string }>("SELECT chemin FROM reclamations WHERE agent = ? AND retire_le IS NULL ORDER BY id", [agent]);
    const n = t.run("UPDATE reclamations SET retire_le = ? WHERE agent = ? AND retire_le IS NULL", [maintenant(), agent]).changes;
    for (const r of ouvertes) noterPancarteRetiree(t, agent, r.chemin);
    return n;
  });
}

export function clore(t: Tableau, bilan: object): void {
  t.run("UPDATE run SET fin = ?, etat = 'termine', bilan_json = ?", [maintenant(), JSON.stringify(bilan)]);
}

// ---- Les demandes git ------------------------------------------
// Le lanceur est le seul écrivain du dépôt du run : un agent qui veut restaurer un fichier, ouvrir un essai ou
// l'adopter dépose une demande ici, le lanceur la prend dans sa file et y écrit la réponse, que l'outil attend.

export type DemandeGit = { id: number; agent: string; action: string; args: Record<string, unknown>; cree_le?: string };

export function deposerDemande(t: Tableau, agent: string, action: string, args: Record<string, unknown>): number {
  return t.run("INSERT INTO demandes_git(agent, action, args_json, cree_le) VALUES (?, ?, ?, ?)", [agent, action, JSON.stringify(args), maintenant()]).lastId;
}

// Les demandes en attente, marquées prises dans la même transaction : aucune n'est servie deux fois.
export function prendreDemandes(t: Tableau): DemandeGit[] {
  return t.transaction(() => {
    const lignes = t.all<{ id: number; agent: string; action: string; args_json: string | null; cree_le: string }>("SELECT id, agent, action, args_json, cree_le FROM demandes_git WHERE etat = 'attente' ORDER BY id");
    for (const l of lignes) t.run("UPDATE demandes_git SET etat = 'prise' WHERE id = ?", [l.id]);
    return lignes.map((l) => ({ id: l.id, agent: l.agent, action: l.action, args: l.args_json ? JSON.parse(l.args_json) : {}, cree_le: l.cree_le }));
  });
}

export function repondreDemande(t: Tableau, id: number, resultat: object): void {
  t.run("UPDATE demandes_git SET etat = 'faite', resultat_json = ?, fini_le = ? WHERE id = ?", [JSON.stringify(resultat), maintenant(), id]);
}

export function reponseDemande<R = Record<string, unknown>>(t: Tableau, id: number): R | undefined {
  const r = t.get<{ resultat_json: string | null }>("SELECT resultat_json FROM demandes_git WHERE id = ? AND etat = 'faite'", [id]);
  return r?.resultat_json ? (JSON.parse(r.resultat_json) as R) : undefined;
}

export type Essai = { nom: string; auteur: string; raison: string | null; dossier: string; cree_le: string; adopte_le: string | null; adopte_par: string | null; adopte_hash: string | null };

// Les fichiers d'un commit tels qu'un fait les nomme (second cerveau) : un fichier supprimé est dit, au-delà de
// cinq fichiers le reste est compté (details les garde tous, avec leurs blobs).
export function listeFichiers(fichiers: FichierCommit[]): string {
  const noms = fichiers.map((f) => (f.blob === null ? `${f.chemin} (supprimé)` : f.chemin));
  return noms.length > 5 ? `${noms.slice(0, 5).join(", ")} + ${noms.length - 5} autres` : noms.join(", ");
}

// La raison d'une demande (essai, restauration), citée telle quelle et déclarée par l'agent, sans numéro de message :
// le fait est écrit en servant la demande, avant que l'outil ne poste son annonce. Rien quand elle est vide.
export function raisonDeclaree(raison: string, agent: string): { texte: string; details: { citation?: string } } {
  if (!raison.trim()) return { texte: "", details: {} };
  const c = citer(raison, {});
  return { texte: ` · « ${c.texte} » déclarée par ${agent}`, details: c.entiere ? {} : { citation: raison } };
}

// Chacune dans sa transaction, avec son fait ; l'adoption seulement si elle a changé une ligne.
export function noterEssai(t: Tableau, nom: string, auteur: string, raison: string, dossier: string): void {
  t.transaction(() => {
    t.run("INSERT INTO essais(nom, auteur, raison, dossier, cree_le) VALUES (?, ?, ?, ?, ?)", [nom, auteur, raison, dossier, maintenant()]);
    const r = raisonDeclaree(raison, auteur);
    noterFait(t, { type: "essai", agent: auteur, source: "lanceur", sujet: nom, texte: `essai ${nom} ouvert · ${auteur}${r.texte}`, details: { racine: `essai:${nom}`, dossier, ...r.details } });
  });
}

export function noterAdoption(t: Tableau, nom: string, par: string, hash: string, fichiers: FichierCommit[]): void {
  t.transaction(() => {
    const n = t.run("UPDATE essais SET adopte_le = ?, adopte_par = ?, adopte_hash = ? WHERE nom = ?", [maintenant(), par, hash, nom]).changes;
    if (n > 0) noterFait(t, { type: "essai", agent: par, source: "lanceur", sujet: nom, texte: `essai ${nom} adopté · ${par} · commit ${hash} · ${listeFichiers(fichiers)}`,
      details: { hash, message: `adopter l'essai ${nom}`, fichiers, racine: "partage" } });
  });
}

export function essais(t: Tableau): Essai[] {
  return t.all("SELECT * FROM essais ORDER BY cree_le");
}

// La file des essais pas encore adoptés, du plus ancien au plus récent, pour l'intégrateur. Undefined sans
// essai en attente.
export function fileDesEssais(t: Tableau, maintenantMs = Date.now(), max = 15): string | undefined {
  const attente = essais(t).filter((e) => !e.adopte_le);
  if (!attente.length) return undefined;
  const ligne = (e: Essai) => {
    const min = Math.round(dureeHorsPause(t, Date.parse(e.cree_le), maintenantMs) / 60_000);
    const raison = e.raison ? ` : ${e.raison.length > 80 ? `${e.raison.slice(0, 79)}…` : e.raison}` : "";
    return `- ${e.nom} (${e.auteur}, ouvert il y a ${min} min${raison})`;
  };
  return [`Essais pas encore adoptés (${attente.length}), calculés par le lanceur à l'instant :`, ...attente.slice(0, max).map(ligne),
    ...(attente.length > max ? [`- et ${attente.length - max} autres`] : [])].join("\n");
}

// ---- Les tickets : locaux, jamais GitHub -------------------------
// Un défaut vu par un agent ne se perd plus dans le fil : il a un numéro, un auteur, un chargé et un état. Un bug ou
// une amélioration ne se ferme qu'en citant le commit qui corrige (l'outil vérifie qu'il est dans le dossier commun :
// le tableau ne connaît pas git) ; une question se ferme sur une réponse écrite. Chaque changement laisse une note.

export const TYPES_TICKET = ["bug", "amelioration", "question"] as const;
export type TypeTicket = (typeof TYPES_TICKET)[number];
export const ETATS_TICKET = ["ouvert", "en_cours", "ferme"] as const;
export type EtatTicket = (typeof ETATS_TICKET)[number];
export type Ticket = { id: number; type: TypeTicket; titre: string; description: string | null; auteur: string; charge: string | null;
  etat: EtatTicket; commit_ferme: string | null; reponse: string | null; cree_le: string; maj_le: string; chemins?: string | null;
  sorte?: SorteTicket; motif?: Motif | null; remplace_par?: number | null; reproduction?: string | null; bloque_par?: number | null; exigence?: string | null;
  gele_le?: string | null; ferme_le?: string | null };
// Un ticket actif : ouvert ou en cours, et pas gelé par une révision. Seul
// prédicat de ce qui compte comme travail : attentes, réveils, charge, disponibles, départ.
export const estActif = (k: Ticket): boolean => k.etat !== "ferme" && !k.gele_le;

// Rôles des agents : un ticket de travail (une part à faire) ou une alerte (un défaut constaté par la
// recette ou le gardien, avec sa reproduction figée). Chaque sorte se ferme par ses motifs ; sans motif, la clôture
// d'avant (commit ou réponse) reste celle des runs sans rôles, et une alerte ne se ferme jamais ainsi.
export const SORTES_TICKET = ["travail", "alerte"] as const;
export type SorteTicket = (typeof SORTES_TICKET)[number];
export const MOTIFS = ["livre", "remplace_par", "annule", "corrige", "invalide"] as const;
export type Motif = (typeof MOTIFS)[number];
export const MOTIFS_PAR_SORTE: Record<SorteTicket, Motif[]> = { travail: ["livre", "remplace_par", "annule"], alerte: ["corrige", "invalide"] };
// La reproduction d'une alerte, relevée par l'outil à l'ouverture et jamais modifiée : la commande, la graine, les
// empreintes (blob git) du banc (chemins absolus) et du monde (relatifs à <run>/entrees/), le commit de main.
export type Reproduction = { commande: string; graine: string | null; commit: string; banc: Record<string, string>; monde: Record<string, string> };
export const reproductionDuTicket = (k: Ticket): Reproduction | undefined => (k.reproduction ? JSON.parse(k.reproduction) as Reproduction : undefined);
export type NoteTicket = { auteur: string; cree_le: string; texte: string };

// Second cerveau : l'annonce du fil tickets est insérée dans la transaction du ticket, avec la note et le
// fait, qui cite son numéro ; une annonce qui échoue n'en laisse rien. Sans gabarit d'annonce (le tableau seul, les
// tests) : aucun message, et la citation du fait n'a pas de numéro.
const declare = (parole: string, agent: string, message: number | undefined, accord = "") => {
  const c = cite(parole, message);
  return { texte: `${c.texte} déclaré${accord} par ${agent}${message !== undefined ? `, msg ${message}` : ""}`, details: c.details };
};
// Rôles des agents : les chemins confiés d'un ticket ; [] sans chemins, ou sur un tableau d'avant la colonne.
export const cheminsDuTicket = (k: Ticket): string[] => (k.chemins ? JSON.parse(k.chemins) as string[] : []);
// Confier, réattribuer ou rendre des chemins : les pancartes passent au nom de `agent`, reprises à qui les portait. Dans la
// transaction de l'appelant ; un fait par pancarte retirée et par pancarte posée, comme reclamer et liberer.
function confierPancartes(t: Tableau, agent: string, chemins: string[], raison: string): void {
  for (const chemin of chemins) {
    const p = t.get<{ agent: string }>("SELECT agent FROM reclamations WHERE chemin = ? AND retire_le IS NULL", [chemin]);
    if (p?.agent === agent) continue;
    if (p) {
      t.run("UPDATE reclamations SET retire_le = ? WHERE chemin = ? AND retire_le IS NULL", [maintenant(), chemin]);
      noterPancarteRetiree(t, p.agent, chemin);
    }
    t.run("INSERT INTO reclamations(chemin, agent, raison, pose_le) VALUES (?, ?, ?, ?)", [chemin, agent, raison, maintenant()]);
    // details.de : l'ancien porteur, que sa ligne courte prévient du passage de sa pancarte.
    noterFait(t, { type: "pancarte", agent, source: "tableau", sujet: chemin, texte: `pancarte · ${chemin} · ${agent} · ${cite(raison).texte}`, details: p ? { de: p.agent } : undefined });
  }
}

// chemins : les parts confiées avec le ticket, normalisées par l'appelant ; le chargé en porte les pancartes.
// sorte, reproduction : une alerte et sa reproduction figée, écrite ici une fois pour toutes.
export function ouvrirTicket(t: Tableau, o: { type: TypeTicket; titre: string; description: string; auteur: string; charge?: string; chemins?: string[]; sorte?: SorteTicket; reproduction?: Reproduction; exigence?: string; annonce?: (id: number) => string }): number {
  return t.transaction(() => {
    const le = maintenant();
    const id = t.run("INSERT INTO tickets(type, titre, description, auteur, charge, cree_le, maj_le) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [o.type, o.titre, o.description, o.auteur, o.charge ?? null, le, le]).lastId;
    const alerte = o.sorte === "alerte";
    if (alerte) t.run("UPDATE tickets SET sorte = 'alerte', reproduction = ? WHERE id = ?", [o.reproduction ? JSON.stringify(o.reproduction) : null, id]);
    if (alerte && o.exigence) t.run("UPDATE tickets SET exigence = ? WHERE id = ?", [o.exigence, id]);
    const chemins = o.chemins ?? [];
    if (chemins.length && o.charge) {
      t.run("UPDATE tickets SET chemins = ? WHERE id = ?", [JSON.stringify(chemins), id]);
      confierPancartes(t, o.charge, chemins, `ticket #${id}`);
    }
    t.run("INSERT INTO ticket_notes(ticket_id, auteur, cree_le, texte) VALUES (?, ?, ?, ?)", [id, o.auteur, le, `ouvert${alerte ? ` (alerte${o.exigence ? ` sur ${o.exigence}` : ""})` : ""}${o.charge ? `, confié à ${o.charge}` : ""}${chemins.length && o.charge ? `, chemins : ${chemins.join(", ")}` : ""}`]);
    const n = o.annonce ? insererMessage(t, o.auteur, o.annonce(id), "tickets") : undefined;
    const d = declare(o.titre, o.auteur, n);
    noterFait(t, { type: "ticket", agent: o.auteur, source: "tableau", sujet: `#${id}`, messageId: n, details: d.details,
      texte: `ticket #${id} ouvert · ${alerte ? `alerte${o.exigence ? ` sur ${o.exigence}` : ""} · ` : ""}${o.type}${o.charge ? ` · confié à ${o.charge}` : ""} · ${d.texte}` });
    return id;
  });
}

export function lireTicket(t: Tableau, id: number): (Ticket & { notes: NoteTicket[] }) | undefined {
  const k = t.get<Ticket>("SELECT * FROM tickets WHERE id = ?", [id]);
  if (!k) return undefined;
  return { ...k, notes: t.all<NoteTicket>("SELECT auteur, cree_le, texte FROM ticket_notes WHERE ticket_id = ? ORDER BY id", [id]) };
}

export function listerTickets(t: Tableau, filtre: { etat?: EtatTicket; charge?: string } = {}): Ticket[] {
  const conditions: string[] = [], params: unknown[] = [];
  if (filtre.etat) { conditions.push("etat = ?"); params.push(filtre.etat); }
  if (filtre.charge) { conditions.push("charge = ?"); params.push(filtre.charge); }
  return t.all<Ticket>(`SELECT * FROM tickets ${conditions.length ? "WHERE " + conditions.join(" AND ") : ""} ORDER BY id`, params);
}

// Fermer sans commit (bug, amélioration) ou sans réponse (question) est refusé ici, quel que soit l'appelant. Les raisons
// suivent la forme des refus des outils : "<fait>. <levée>".
export const raisonSansCommit = (type: TypeTicket) => `${type === "bug" ? "un bug" : "une amélioration"} ne se ferme pas sans commit. Se lève avec le commit qui corrige`;
// Le refus d'une clôture par motif, lu dans la transaction du ticket : la sorte et ses motifs, puis la
// condition de chacun. livre : un commit (constaté dans main par l'outil) dont les fichiers touchent un chemin du ticket,
// un fichier ou un dossier ; remplace_par : un successeur ouvert, de travail, avec un chargé ; annule : une raison
// (réservé au chef par l'outil) ; corrige et invalide : le reçu du lanceur, seul à fermer une alerte. Sans motif, une
// alerte ne se ferme pas, un ticket de travail suit la règle d'avant (commit ou réponse).
export type Cloture = { motif?: Motif; commit?: string; fichiers?: string[]; remplacePar?: number; note?: string; recu?: string };
const recuExige = "une alerte se ferme sur le reçu du lanceur. Se lève quand le rejeu demandé par corrige ou invalide passe";
// Un motif sur un ticket déjà fermé, ou qui n'est pas de sa sorte (lu aussi par demanderRejeu).
function refusMotifSorte(k: Ticket, motif: Motif): string | undefined {
  if (k.etat === "ferme") return `le ticket #${k.id} est déjà fermé. Définitif pour ce numéro`;
  if (MOTIFS_PAR_SORTE[k.sorte ?? "travail"].includes(motif)) return undefined;
  return k.sorte === "alerte" ? `le motif ${motif} ne ferme pas une alerte. Se lève avec corrige ou invalide`
    : `le motif ${motif} ne ferme pas un ticket de travail. Se lève avec livre, remplace_par ou annule`;
}
export function refusCloture(t: Tableau, k: Ticket, m: Cloture): string | undefined {
  const refus = m.motif && refusMotifSorte(k, m.motif);
  if (refus) return refus;
  if (k.sorte === "alerte") return m.motif && m.recu ? undefined : recuExige;
  if (m.motif === "livre") {
    if (!m.commit) return "un ticket livré sans commit. Se lève avec le commit de main qui touche un de ses chemins";
    const chemins = cheminsDuTicket(k);
    if (!chemins.length) return `le ticket #${k.id} n'a aucun chemin confié. Se lève quand un chemin lui est confié, ou avec remplace_par ou annule`;
    const touche = (m.fichiers ?? []).some((f) => chemins.some((c) => f === c || f.startsWith(c.endsWith("/") ? c : c + "/")));
    if (!touche) return `le commit ${m.commit.slice(0, 7)} ne touche aucun chemin du ticket #${k.id} (${chemins.join(", ")}). Se lève avec un commit qui touche l'un d'eux`;
  }
  if (m.motif === "remplace_par") {
    if (m.remplacePar === undefined) return "remplace_par sans successeur. Se lève avec le numéro du ticket qui le remplace";
    if (m.remplacePar === k.id) return "un ticket ne se remplace pas par lui-même. Définitif pour ce numéro";
    const s = t.get<Ticket>("SELECT * FROM tickets WHERE id = ?", [m.remplacePar]);
    if (!s) return `aucun ticket #${m.remplacePar}. Définitif pour ce numéro`;
    if ((s.sorte ?? "travail") !== "travail") return `le ticket #${s.id} est une alerte. Se lève avec un ticket de travail`;
    if (s.etat === "ferme") return `le ticket #${s.id} est fermé. Se lève avec un successeur ouvert`;
    if (!s.charge) return `le ticket #${s.id} n'a pas de chargé. Se lève quand il est confié à un agent`;
  }
  if (m.motif === "annule" && !m.note?.trim()) return "un ticket annulé sans raison. Se lève avec une note non vide";
  return undefined;
}
const LIBELLE_MOTIF: Record<Motif, string> = { livre: "livré", remplace_par: "remplacé", annule: "annulé", corrige: "corrigé", invalide: "invalidé" };
// Le motif tel que les agents le lisent : « livré », « remplacé par #3 »…
export const libelleMotif = (motif: Motif, remplacePar?: number | null) => motif === "remplace_par" ? `remplacé par #${remplacePar}` : LIBELLE_MOTIF[motif];
const libelleFerme = (m: Cloture) => (m.motif ? `fermé (${libelleMotif(m.motif, m.remplacePar)})` : "fermé");

// Demander le rejeu d'une alerte : corrige rejoue la reproduction figée sur main, invalide une
// contre-preuve aux mêmes conditions (la graine de la reproduction). La demande attend le lanceur, qui seul
// ferme l'alerte sur son reçu. commit : main au moment de la demande, relevé par l'outil. Un vert sans changement du
// produit n'est qu'un autre tirage : corrige est refusé au commit de la reproduction. Une demande à la fois par alerte.
export function demanderRejeu(t: Tableau, d: { ticket: number; demandeur: string; motif: "corrige" | "invalide"; commit: string; contrePreuve?: string },
  annonce?: (k: Ticket, quoi: string) => string): { ok: true; id: number } | { ok: false; raison: string } {
  return t.transaction(() => {
    const k = t.get<Ticket>("SELECT * FROM tickets WHERE id = ?", [d.ticket]);
    if (!k) return { ok: false as const, raison: `aucun ticket #${d.ticket}. Définitif pour ce numéro` };
    const refus = refusMotifSorte(k, d.motif);
    if (refus) return { ok: false as const, raison: refus };
    if (t.get("SELECT 1 FROM demandes_rejeu WHERE ticket_id = ? AND etat <> 'faite'", [k.id]))
      return { ok: false as const, raison: `une demande de rejeu de l'alerte #${k.id} attend le lanceur. Se lève quand le lanceur a rendu son reçu` };
    const r = reproductionDuTicket(k)!;
    if (d.motif === "corrige" && d.commit === r.commit)
      return { ok: false as const, raison: "le produit n'a pas changé depuis l'alerte. Se lève avec un commit qui change le produit, ou une contre-preuve aux mêmes conditions (invalide)" };
    if (d.motif === "invalide" && !d.contrePreuve?.trim())
      return { ok: false as const, raison: "une invalidation sans contre-preuve. Se lève avec contre_preuve, la commande rejouée aux mêmes conditions" };
    const le = maintenant();
    const commande = d.motif === "corrige" ? r.commande : d.contrePreuve!;
    const id = t.run("INSERT INTO demandes_rejeu(ticket_id, motif, commande, graine, commit_produit, demandeur, cree_le) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [k.id, d.motif, commande, r.graine, d.commit, d.demandeur, le]).lastId;
    const quoi = `demande de rejeu #${id} déposée (${d.motif}), produit au commit ${d.commit.slice(0, 7)}${d.motif === "invalide" ? ` ; contre-preuve : ${commande}` : ""} ; l'alerte reste ouverte jusqu'au reçu du lanceur`;
    t.run("INSERT INTO ticket_notes(ticket_id, auteur, cree_le, texte) VALUES (?, ?, ?, ?)", [k.id, d.demandeur, le, quoi]);
    const n = annonce ? insererMessage(t, d.demandeur, annonce(k, quoi), "tickets") : undefined;
    noterFait(t, { type: "ticket", agent: d.demandeur, source: "tableau", sujet: `#${k.id}`, messageId: n,
      texte: `ticket #${k.id} · demande de rejeu #${id} (${d.motif}) · produit au commit ${d.commit.slice(0, 7)} · par ${d.demandeur}${n !== undefined ? `, msg ${n}` : ""}` });
    return { ok: true as const, id };
  });
}

// ---- La file des rejeux : le lanceur prend les demandes comme celles du dépôt (prendreDemandes), rejoue
// (preuves.ts), écrit le reçu et rend la demande faite ; l'outil qui a déposé une preuve d'exigence attend reponseRejeu.
// reproduction : celle du ticket pour une alerte, celle de la demande pour une exigence.
// rejoue : le reçu attesté que le lanceur rejoue de lui-même, nul pour une demande d'agent.
export type DemandeRejeu = { id: number; ticket: number | null; exigence: string | null; motif: "corrige" | "invalide" | null; commande: string;
  graine: string | null; commitProduit: string | null; demandeur: string; reproduction: Reproduction; rejoue?: string | null };
type LigneRejeu = { id: number; ticket_id: number | null; exigence: string | null; motif: "corrige" | "invalide" | null; commande: string;
  graine: string | null; commit_produit: string | null; demandeur: string; reproduction: string | null; repro_ticket: string | null; rejoue: string | null };
// ids : seulement ces demandes-là (le constat de fin du lanceur rejoue les siennes) ; toutes sinon.
export function prendreRejeux(t: Tableau, ids?: number[]): DemandeRejeu[] {
  return t.transaction(() => {
    const lignes = t.all<LigneRejeu>(`SELECT d.id, d.ticket_id, d.exigence, d.motif, d.commande, d.graine, d.commit_produit, d.demandeur, d.reproduction,
      d.rejoue, k.reproduction AS repro_ticket FROM demandes_rejeu d LEFT JOIN tickets k ON k.id = d.ticket_id WHERE d.etat = 'attente' ORDER BY d.id`)
      .filter((l) => !ids || ids.includes(l.id));
    for (const l of lignes) t.run("UPDATE demandes_rejeu SET etat = 'prise' WHERE id = ?", [l.id]);
    return lignes.map((l) => ({ id: l.id, ticket: l.ticket_id, exigence: l.exigence, motif: l.motif, commande: l.commande, graine: l.graine,
      commitProduit: l.commit_produit, demandeur: l.demandeur, reproduction: JSON.parse((l.repro_ticket ?? l.reproduction)!) as Reproduction, rejoue: l.rejoue }));
  });
}
// Le rejeu d'un reçu attesté, déposé au nom du lanceur. Un seul par couple (reçu, état du produit) : la demande
// déjà faite ou en file pour ce couple est rendue telle quelle ; undefined si une autre demande de l'exigence attend (une
// seule en attente par exigence, comme pour une preuve).
export function demanderRejeuAttestation(t: Tableau, d: { exigence: string; rejoue: string; cle: string; reproduction: Reproduction }): number | undefined {
  return t.transaction(() => {
    const deja = rejeuAttestation(t, d.rejoue, d.cle);
    if (deja) return deja.id;
    if (t.get("SELECT 1 FROM demandes_rejeu WHERE exigence = ? AND etat <> 'faite'", [d.exigence])) return undefined;
    return t.run("INSERT INTO demandes_rejeu(exigence, commande, graine, commit_produit, demandeur, reproduction, rejoue, cle_produit, cree_le) VALUES (?, ?, ?, ?, 'lanceur', ?, ?, ?, ?)",
      [d.exigence, d.reproduction.commande, d.reproduction.graine, d.reproduction.commit, JSON.stringify(d.reproduction), d.rejoue, d.cle, maintenant()]).lastId;
  });
}
// La demande de rejeu d'un reçu pour un état du produit, s'il y en a une : en file, ou faite (resultat : passe, panne…).
export function rejeuAttestation(t: Tableau, rejoue: string, cle: string): { id: number; etat: string; recu: string | null; resultat: { passe?: boolean; code?: number | null; texte?: string; panne?: string } } | undefined {
  if (!aColonne(t, "demandes_rejeu", "rejoue")) return undefined; // run d'avant la colonne, lu par la vue
  const r = t.get<{ id: number; etat: string; recu: string | null; resultat_json: string | null }>(
    "SELECT id, etat, recu, resultat_json FROM demandes_rejeu WHERE rejoue = ? AND cle_produit = ? ORDER BY id DESC LIMIT 1", [rejoue, cle]);
  return r && { id: r.id, etat: r.etat, recu: r.recu, resultat: JSON.parse(r.resultat_json ?? "{}") };
}
// Des rejeux du lanceur attendent encore : la salle endormie ne se constate pas avant leur conclusion.
export const rejeuxAttestationsEnCours = (t: Tableau) => aColonne(t, "demandes_rejeu", "rejoue") && !!t.get("SELECT 1 FROM demandes_rejeu WHERE rejoue IS NOT NULL AND etat <> 'faite'");
// recu : le chemin du reçu, relatif au run (preuves/<n>.json) ; nul quand le rejeu est tombé en panne.
export function finirRejeu(t: Tableau, id: number, recu: string | null, resultat: object): void {
  t.run("UPDATE demandes_rejeu SET etat = 'faite', recu = ?, resultat_json = ?, fini_le = ? WHERE id = ?", [recu, JSON.stringify(resultat), maintenant(), id]);
}
// Rôles : à la fermeture du run, les demandes encore en file n'ont plus personne à qui répondre ; elles sont closes
// sans reçu, la raison dans leur résultat. Rend leurs numéros, pour le bilan.
export function abandonnerRejeux(t: Tableau, raison: string): number[] {
  return t.transaction(() => {
    const ids = t.all<{ id: number }>("SELECT id FROM demandes_rejeu WHERE etat = 'attente' ORDER BY id").map((d) => d.id);
    for (const id of ids) finirRejeu(t, id, null, { abandon: raison, texte: `sans reçu : ${raison}` });
    return ids;
  });
}
export function reponseRejeu<R = Record<string, unknown>>(t: Tableau, id: number): { recu: string | null; resultat: R } | undefined {
  const r = t.get<{ recu: string | null; resultat_json: string | null }>("SELECT recu, resultat_json FROM demandes_rejeu WHERE id = ? AND etat = 'faite'", [id]);
  return r && { recu: r.recu, resultat: JSON.parse(r.resultat_json ?? "{}") as R };
}
// Les alertes invalidées et leurs deux conclusions, pour le bilan : l'alerte (sa commande, son auteur) et la
// contre-preuve rejouée par le lanceur (la dernière demande invalide faite, et son reçu).
export function invalidations(t: Tableau): Array<{ ticket: number; titre: string; auteur: string; alerte: string; demandeur: string; contrePreuve: string; recu: string }> {
  return t.all<{ ticket: number; titre: string; auteur: string; reproduction: string; demandeur: string; contrePreuve: string; recu: string }>(
    `SELECT k.id AS ticket, k.titre, k.auteur, k.reproduction, d.demandeur, d.commande AS contrePreuve, d.recu FROM tickets k
     JOIN demandes_rejeu d ON d.id = (SELECT MAX(id) FROM demandes_rejeu WHERE ticket_id = k.id AND motif = 'invalide' AND etat = 'faite' AND recu IS NOT NULL)
     WHERE k.motif = 'invalide' ORDER BY k.id`).map(({ reproduction, ...r }) => ({ ...r, alerte: (JSON.parse(reproduction) as Reproduction).commande }));
}

// ---- Les exigences ---------------------------------------------------------------------------------------
// Le lanceur pose les phrases numérotées (mission.phrasesNumerotees) ; le chef les range ; le gardien conteste. L'état
// prouvé d'une exigence (attestée, périmée, non vérifiée) se lit avec ses preuves (preuves.ts), pas ici.
export const CLASSEMENTS = ["exigence", "transversale", "contexte"] as const;
export type Classement = (typeof CLASSEMENTS)[number];
export const RESPONSABLES = ["recette", "gardien"] as const;
export type Responsable = (typeof RESPONSABLES)[number];
export type PhraseRangee = { n: number; section: string; texte: string; classement: Classement | "engagement" | null; exigence: string | null };
export type Exigence = { libelle: string; classement: "exigence" | "transversale"; responsable: Responsable; phrases: number[]; retiree: boolean; contestations: number[]; parent?: string; portee?: string; indice?: number };

// Sorties incomplètes : les phrases d'une section « Engagements » sont posées déjà rangées, en
// engagement : suivies au bilan, jamais des exigences, donc jamais un motif d'incomplet (« rien ne sort de la machine »
// ne se prouve par aucune commande).
export const estSectionEngagements = (section: string) =>
  section.normalize("NFD").replace(/\p{M}/gu, "").trim().toLowerCase().startsWith("engagement");
export function noterPhrases(t: Tableau, phrases: Array<{ n: number; section: string; texte: string }>): void {
  const le = maintenant();
  t.transaction(() => {
    for (const p of phrases) t.run("INSERT INTO phrases(n, section, texte, classement, range_le) VALUES (?, ?, ?, ?, ?)",
      [p.n, p.section, p.texte, estSectionEngagements(p.section) ? "engagement" : null, estSectionEngagements(p.section) ? le : null]);
  });
}
export const engagements = (t: Tableau): PhraseRangee[] => phrases(t).filter((p) => p.classement === "engagement");
export const phrases = (t: Tableau): PhraseRangee[] => t.all<PhraseRangee>("SELECT n, section, texte, classement, exigence FROM phrases ORDER BY n");

// Les numéros de phrases inconnus, à la forme des refus ; undefined quand tous existent.
function refusPhrases(t: Tableau, ns: number[]): string | undefined {
  if (!ns.length) return "aucune phrase. Se lève avec au moins un numéro de phrase";
  const max = t.get<{ n: number | null }>("SELECT MAX(n) AS n FROM phrases")?.n ?? 0;
  const inconnu = ns.find((n) => !Number.isInteger(n) || n < 1 || n > max);
  return inconnu === undefined ? undefined : `aucune phrase n° ${inconnu}. Se lève avec un numéro de 1 à ${max}`;
}

// Ranger des phrases (le chef, vérifié par l'outil) : une exigence ou une exigence transversale reçoit le libellé suivant
// (E1, E2…) et un responsable de contrôle ; un contexte n'en a pas. Une phrase déjà rangée est déplacée ; une exigence
// restée sans phrase est retirée (retirees).
export function rangerExigence(t: Tableau, o: { phrases: number[]; classement: string; responsable?: string; par: string }):
  { ok: true; libelle?: string; retirees: string[] } | { ok: false; raison: string } {
  return t.transaction(() => {
    const ns = [...new Set(o.phrases)].sort((a, b) => a - b);
    const refus = refusPhrases(t, ns);
    if (refus) return { ok: false as const, raison: refus };
    const engagement = ns.find((n) => t.get("SELECT 1 FROM phrases WHERE n = ? AND classement = 'engagement'", [n]));
    if (engagement !== undefined) return { ok: false as const, raison: `la phrase n° ${engagement} est un engagement (section Engagements de la mission), pas une exigence : elle est suivie au bilan, sans preuve. Définitif pour cette phrase` };
    if (!(CLASSEMENTS as readonly string[]).includes(o.classement)) return { ok: false as const, raison: `classement ${o.classement} inconnu. Se lève avec exigence, transversale ou contexte` };
    const contexte = o.classement === "contexte";
    if (contexte && o.responsable) return { ok: false as const, raison: "un contexte n'a pas de responsable de contrôle. Se lève sans responsable" };
    if (!contexte && !o.responsable) return { ok: false as const, raison: "une exigence sans responsable de contrôle. Se lève avec recette ou gardien" };
    if (!contexte && !(RESPONSABLES as readonly string[]).includes(o.responsable!)) return { ok: false as const, raison: `responsable ${o.responsable} inconnu. Se lève avec recette ou gardien` };
    const le = maintenant();
    const anciennes = new Set(t.all<{ exigence: string }>(`SELECT DISTINCT exigence FROM phrases WHERE exigence IS NOT NULL AND n IN (${ns.map(() => "?").join(",")})`, ns).map((r) => r.exigence));
    let libelle: string | undefined;
    if (!contexte) {
      // Les jalons : le numéro se compte sur les exigences sans parent ; E4.1 à E4.4 ne font pas sauter E5.
      libelle = `E${(t.get<{ n: number }>(`SELECT COUNT(*) AS n FROM exigences${aColonne(t, "exigences", "parent") ? " WHERE parent IS NULL" : ""}`)?.n ?? 0) + 1}`;
      t.run("INSERT INTO exigences(libelle, classement, responsable, range_par, cree_le) VALUES (?, ?, ?, ?, ?)", [libelle, o.classement, o.responsable!, o.par, le]);
    }
    for (const n of ns) t.run("UPDATE phrases SET classement = ?, exigence = ?, range_le = ? WHERE n = ?", [o.classement, libelle ?? null, le, n]);
    const retirees = [...anciennes].filter((e) => !t.get("SELECT 1 FROM phrases WHERE exigence = ?", [e])).sort(ordreLibelle);
    for (const e of retirees) {
      t.run("UPDATE exigences SET retiree_le = ? WHERE libelle = ?", [le, e]);
      for (const j of jalonsDe(t, e)) retirerJalon(t, j.libelle, le); // les jalons partent avec leur parent
    }
    return { ok: true as const, ...(libelle ? { libelle } : {}), retirees };
  });
}

// Les exigences dans l'ordre des libellés, retirées comprises ; contestations : les tickets ouverts qui les contestent.
// Les jalons : un jalon suit son parent, par indice (E4, E4.1, E4.2, …, E4.10, E5) ; parent, portée et indice
// sont lus seulement si le tableau les a (un ancien run ouvert par la vue n'est jamais migré).
export function listerExigences(t: Tableau): Exigence[] {
  const jalons = aColonne(t, "exigences", "parent");
  return t.all<{ libelle: string; classement: "exigence" | "transversale"; responsable: Responsable; retiree_le: string | null; parent?: string | null; portee?: string | null; indice?: number | null }>(
    `SELECT libelle, classement, responsable, retiree_le${jalons ? ", parent, portee, indice" : ""} FROM exigences`).sort((a, b) => ordreLibelle(a.libelle, b.libelle)).map((e) => ({
    libelle: e.libelle, classement: e.classement, responsable: e.responsable,
    phrases: t.all<{ n: number }>("SELECT n FROM phrases WHERE exigence = ? ORDER BY n", [e.libelle]).map((p) => p.n), retiree: e.retiree_le !== null,
    contestations: contestationsOuvertes(t).filter((c) => c.exigence === e.libelle).map((c) => c.ticket),
    ...(e.parent ? { parent: e.parent, portee: e.portee ?? "", indice: e.indice ?? 0 } : {}),
  }));
}

// ---- Les jalons d'une exigence ------------------------------------------------------
// Un jalon est une exigence avec un parent : E4.1, E4.2… Le chef découpe une exigence longue ; elle est attestée quand
// tous ses jalons le sont (preuves.ts). Un indice n'est jamais redonné : un reçu ne vaut que pour son libellé, une vieille
// preuve ne vaut donc jamais pour un nouveau jalon.
// L'ordre des libellés : le numéro de l'exigence, puis l'indice du jalon (E4.10 après E4.2 ; Number("4.10") ne le ferait pas).
export function ordreLibelle(a: string, b: string): number {
  const [pa, ja] = a.slice(1).split(".").map(Number), [pb, jb] = b.slice(1).split(".").map(Number);
  return (pa! - pb!) || ((ja ?? 0) - (jb ?? 0));
}
export type Jalon = { libelle: string; portee: string; indice: number };
// Les jalons actifs d'une exigence, par indice ; aucun sur un tableau d'avant les jalons.
export function jalonsDe(t: Tableau, parent: string): Jalon[] {
  if (!aColonne(t, "exigences", "parent")) return [];
  return t.all<Jalon>("SELECT libelle, portee, indice FROM exigences WHERE parent = ? AND retiree_le IS NULL ORDER BY indice", [parent]);
}
// Découpée : au moins deux jalons actifs. Sinon, l'exigence se prouve elle-même, comme avant.
// La règle se lit ici seulement : JALONS_MIN et estDecoupe la portent pour tous les appelants.
export const JALONS_MIN = 2;
export const estDecoupe = (jalons: readonly unknown[]) => jalons.length >= JALONS_MIN;
export const estDecoupee = (t: Tableau, libelle: string) => estDecoupe(jalonsDe(t, libelle));
// Le parent d'un jalon, ou undefined.
export const parentDe = (t: Tableau, libelle: string) =>
  aColonne(t, "exigences", "parent") ? t.get<{ parent: string | null }>("SELECT parent FROM exigences WHERE libelle = ?", [libelle])?.parent ?? undefined : undefined;
// Révoquer toutes les signatures d'un libellé (un jalon retiré) ; rend le nombre de signatures révoquées.
export function revoquerAttestationsDe(t: Tableau, libelle: string): number {
  return t.run("UPDATE attestations SET revoquee_le = ? WHERE exigence = ? AND revoquee_le IS NULL", [maintenant(), libelle]).changes;
}
// Retirer un jalon : retiré, ses signatures révoquées, ses demandes de preuve et de rejeu encore en file closes sans reçu.
function retirerJalon(t: Tableau, libelle: string, le: string): void {
  t.run("UPDATE exigences SET retiree_le = ? WHERE libelle = ? AND retiree_le IS NULL", [le, libelle]);
  revoquerAttestationsDe(t, libelle);
  t.run("UPDATE demandes_rejeu SET etat = 'faite', fini_le = ?, resultat_json = ? WHERE exigence = ? AND etat <> 'faite'",
    [le, JSON.stringify({ passe: false, panne: "jalon retiré" }), libelle]);
}
// Découper une exigence (exigence_jalonner), d'un bloc, dans une transaction : un jalon actif de portée identique est
// gardé (libellé et signatures), les autres sont retirés, les portées nouvelles prennent un indice neuf. Les refus (rôle,
// moment, nombre, longueur) sont à l'outil ; ici, seulement ce que le tableau sait.
export function jalonner(t: Tableau, o: { parent: string; portees: string[]; par: string }):
  { ok: true; gardes: Jalon[]; crees: Jalon[]; retires: Jalon[] } | { ok: false; raison: string } {
  return t.transaction(() => {
    const p = exigenceActive(t, o.parent);
    if (!p) return { ok: false as const, raison: exigenceInconnue(o.parent) };
    if (parentDe(t, o.parent)) return { ok: false as const, raison: `${o.parent} est un jalon : un jalon n'a pas de jalons. Définitif pour ce libellé` };
    const le = maintenant();
    const actifs = jalonsDe(t, o.parent);
    const gardes = actifs.filter((j) => o.portees.includes(j.portee)), retires = actifs.filter((j) => !o.portees.includes(j.portee));
    for (const j of retires) retirerJalon(t, j.libelle, le);
    let indice = t.get<{ n: number | null }>("SELECT MAX(indice) AS n FROM exigences WHERE parent = ?", [o.parent])?.n ?? 0;
    const crees: Jalon[] = [];
    for (const portee of o.portees.filter((x) => !gardes.some((j) => j.portee === x))) {
      indice += 1;
      const libelle = `${o.parent}.${indice}`;
      t.run("INSERT INTO exigences(libelle, classement, responsable, range_par, cree_le, parent, portee, indice) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [libelle, p.classement, p.responsable, o.par, le, o.parent, portee, indice]);
      crees.push({ libelle, portee, indice });
    }
    return { ok: true as const, gardes, crees, retires };
  });
}
// L'empreinte du découpage : sha256 des couples (libellé, portée) des jalons actifs, triés ; vide sans jalon.
export function empreinteDecoupage(t: Tableau): string {
  if (!aColonne(t, "exigences", "parent")) return "";
  const l = t.all<{ libelle: string; portee: string }>("SELECT libelle, portee FROM exigences WHERE parent IS NOT NULL AND retiree_le IS NULL")
    .sort((a, b) => ordreLibelle(a.libelle, b.libelle));
  return l.length ? createHash("sha256").update(JSON.stringify(l.map((j) => [j.libelle, j.portee]))).digest("hex") : "";
}
// Tenue, sans rien rejouer (le contrôle sans coût du lanceur) : une signature non révoquée ; pour une exigence découpée,
// une sur chacun de ses jalons actifs. L'état détaillé (reçus, péremption) est dans preuves.ts.
export function exigenceTenue(t: Tableau, libelle: string): boolean {
  const jalons = jalonsDe(t, libelle);
  return estDecoupe(jalons) ? jalons.every((j) => !!attestationDe(t, j.libelle)) : !!attestationDe(t, libelle);
}

// Contester un classement (le gardien, vérifié par l'outil) : une question au chef, dans le fil tickets, qui cite la raison
// puis chaque phrase visée avec sa section et son rangement. Elle se ferme comme toute question, sur la réponse du chef.
export function contesterExigence(t: Tableau, o: { exigence?: string; phrases?: number[]; raison: string; par: string; chef: string }):
  { ok: true; ticket: number; titre: string } | { ok: false; raison: string } {
  const exigence = o.exigence?.trim() || undefined;
  if (!exigence && !o.phrases?.length) return { ok: false, raison: "ni exigence ni phrase contestée. Se lève avec exigence ou phrases" };
  if (exigence && !exigenceActive(t, exigence)) return { ok: false, raison: exigenceInconnue(exigence) };
  const refus = o.phrases?.length ? refusPhrases(t, o.phrases) : undefined;
  if (refus) return { ok: false, raison: refus };
  if (!o.raison.trim()) return { ok: false, raison: "une contestation sans raison. Se lève avec une raison non vide" };
  // Les jalons : un jalon n'a pas de phrases ; sa contestation cite sa portée et les phrases de son parent.
  const parent = exigence ? parentDe(t, exigence) : undefined;
  const ns = o.phrases?.length ? [...new Set(o.phrases)].sort((a, b) => a - b) : t.all<{ n: number }>("SELECT n FROM phrases WHERE exigence = ? ORDER BY n", [parent ?? exigence!]).map((p) => p.n);
  const titre = exigence ? `contestation de ${exigence}` : `contestation des phrases ${ns.join(", ")}`;
  const cites = phrases(t).filter((p) => ns.includes(p.n))
    .map((p) => `[${p.n}] (${p.section}, rangée : ${p.exigence ?? p.classement ?? "non rangée"}) ${p.texte}`);
  // ouvrirTicket tient sa transaction (sous Node, elles ne s'imbriquent pas) : la contestation s'écrit juste après.
  const portee = parent ? [`${exigence} est un jalon de ${parent}, portée : ${t.get<{ portee: string }>("SELECT portee FROM exigences WHERE libelle = ?", [exigence!])?.portee ?? ""}`] : [];
  const ticket = ouvrirTicket(t, { type: "question", titre, description: [o.raison, ...portee, ...cites].join("\n"), auteur: o.par, charge: o.chef,
    annonce: (id) => `[ticket #${id} · question] ${titre} — confié à ${o.chef} : ${o.raison}` });
  t.run("INSERT INTO contestations(exigence, phrases, raison, par, ticket_id, cree_le) VALUES (?, ?, ?, ?, ?, ?)", [exigence ?? null, JSON.stringify(ns), o.raison, o.par, ticket, maintenant()]);
  return { ok: true, ticket, titre };
}
export function contestationsOuvertes(t: Tableau): Array<{ ticket: number; exigence: string | null; phrases: number[] }> {
  return t.all<{ ticket: number; exigence: string | null; phrases: string }>(
    "SELECT c.ticket_id AS ticket, c.exigence, c.phrases FROM contestations c JOIN tickets k ON k.id = c.ticket_id WHERE k.etat <> 'ferme' ORDER BY c.ticket_id")
    .map((c) => ({ ...c, phrases: JSON.parse(c.phrases) as number[] }));
}

// ---- Les attestations et les demandes de preuve ------------------------------------------------------
// Une exigence active (non retirée) : son libellé et son responsable ; undefined sinon.
export const exigenceActive = (t: Tableau, libelle: string) =>
  t.get<{ libelle: string; classement: string; responsable: Responsable }>("SELECT libelle, classement, responsable FROM exigences WHERE libelle = ? AND retiree_le IS NULL", [libelle]);
const exigenceInconnue = (e: string) => `aucune exigence ${e}. Se lève avec un libellé que exigence_lister donne`;

// Demander la preuve d'une exigence : une demande de rejeu sans ticket, avec la reproduction relevée par l'outil. Une
// seule demande en attente par exigence, comme pour une alerte.
export function demanderPreuve(t: Tableau, d: { exigence: string; demandeur: string; commande: string; graine: string | null; reproduction: Reproduction }):
  { ok: true; id: number } | { ok: false; raison: string } {
  return t.transaction(() => {
    if (!exigenceActive(t, d.exigence)) return { ok: false as const, raison: exigenceInconnue(d.exigence) };
    if (t.get("SELECT 1 FROM demandes_rejeu WHERE exigence = ? AND etat <> 'faite'", [d.exigence]))
      return { ok: false as const, raison: `une demande de preuve de ${d.exigence} attend le lanceur. Se lève quand le lanceur a rendu son reçu` };
    const id = t.run("INSERT INTO demandes_rejeu(exigence, commande, graine, commit_produit, demandeur, reproduction, cree_le) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [d.exigence, d.commande, d.graine, d.reproduction.commit, d.demandeur, JSON.stringify(d.reproduction), maintenant()]).lastId;
    return { ok: true as const, id };
  });
}

export type Attestation = { id: number; exigence: string; agent: string; role: string; nature: "parcours" | "mesure"; recu: string | null; non_verifiee: number; portee: string; cree_le: string };
// La signature qui vaut pour une exigence : la dernière non révoquée.
export const attestationDe = (t: Tableau, exigence: string) =>
  t.get<Attestation>("SELECT id, exigence, agent, role, nature, recu, non_verifiee, portee, cree_le FROM attestations WHERE exigence = ? AND revoquee_le IS NULL ORDER BY id DESC LIMIT 1", [exigence]);
export function attester(t: Tableau, a: { exigence: string; agent: string; role: string; nature: "parcours" | "mesure"; recu: string | null; portee: string }): void {
  t.run("INSERT INTO attestations(exigence, agent, role, nature, recu, non_verifiee, portee, cree_le) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [a.exigence, a.agent, a.role, a.nature, a.recu, a.recu === null ? 1 : 0, a.portee, maintenant()]);
}
// Le droit de signer tombe quand le siège change d'occupant : ses signatures ne comptent plus, l'exigence
// redevient à prouver. Appelé par le lanceur à la relance d'un siège. Rend le nombre de signatures révoquées.
export function revoquerSignatures(t: Tableau, agent: string): number {
  return t.run("UPDATE attestations SET revoquee_le = ? WHERE agent = ? AND revoquee_le IS NULL", [maintenant(), agent]).changes;
}
export function apprecier(t: Tableau, a: { exigence: string; agent: string; role: string; texte: string; portee: string }): number {
  return t.run("INSERT INTO appreciations(exigence, agent, role, texte, portee, cree_le) VALUES (?, ?, ?, ?, ?, ?)", [a.exigence, a.agent, a.role, a.texte, a.portee, maintenant()]).lastId;
}
export const appreciations = (t: Tableau) =>
  t.all<{ id: number; exigence: string; agent: string; texte: string; portee: string }>("SELECT id, exigence, agent, texte, portee FROM appreciations ORDER BY id");

// Le ticket est relu dans la transaction. annonce(k, quoi) reçoit le ticket changé et le texte de la note.
// Un fait pour les trois changements que la salle constate : fermé, confié ; l'ouverture est dans ouvrirTicket.
// Le commit est dit « constaté dans le dossier commun » : l'outil l'a vérifié avant (contenuDans), le tableau ne connaît pas git.
// Rôles : chemins ajoute des parts au ticket, posées au nom du chargé ; un changement de chargé lui passe les pancartes
// du ticket que l'ancien portait encore ; à la clôture, elles vont à rendreA (celui qui répartit les parts).
// Rôles : un motif ferme le ticket (refusCloture) ; bloquePar le dit bloqué par un autre, sans le fermer.
export function majTicket(t: Tableau, id: number, auteur: string, m: { etat?: EtatTicket; charge?: string; commit?: string; reponse?: string; note?: string; chemins?: string[]; rendreA?: string; bloquePar?: number } & Cloture,
  annonce?: (k: Ticket, quoi: string) => string): { ok: true } | { ok: false; raison: string } {
  return t.transaction(() => {
    const k = t.get<Ticket>("SELECT * FROM tickets WHERE id = ?", [id]);
    if (!k) return { ok: false as const, raison: `aucun ticket #${id}. Définitif pour ce numéro` };
    const etat = m.motif ? "ferme" : m.etat;
    if (etat === "ferme") {
      const refus = refusCloture(t, k, m);
      if (refus) return { ok: false as const, raison: refus };
      if (!m.motif && k.type !== "question" && !m.commit) return { ok: false as const, raison: raisonSansCommit(k.type) };
      if (!m.motif && k.type === "question" && !m.reponse?.trim()) return { ok: false as const, raison: "une question ne se ferme pas sans réponse. Se lève avec une note non vide" };
    }
    if (m.bloquePar !== undefined) {
      if (m.bloquePar === id) return { ok: false as const, raison: "un ticket ne se bloque pas lui-même. Définitif pour ce numéro" };
      if (!t.get("SELECT 1 FROM tickets WHERE id = ?", [m.bloquePar])) return { ok: false as const, raison: `aucun ticket #${m.bloquePar}. Définitif pour ce numéro` };
    }
    const ferme = etat === "ferme" && k.etat !== "ferme";
    const confie = m.charge !== undefined && m.charge !== k.charge;
    const changements: string[] = [];
    if (etat && etat !== k.etat) changements.push(etat === "ferme" ? `${libelleFerme(m)}${m.commit ? ` par le commit ${m.commit.slice(0, 7)}` : ""}${m.recu ? ` sur le reçu ${m.recu}` : ""}` : etat === "en_cours" ? "passé en cours" : "rouvert");
    if (confie) changements.push(`confié à ${m.charge}`);
    const anciens = cheminsDuTicket(k);
    const nouveaux = (m.chemins ?? []).filter((c, i, l) => !anciens.includes(c) && l.indexOf(c) === i);
    if (nouveaux.length) changements.push(`chemins confiés : ${nouveaux.join(", ")}`);
    if (m.bloquePar !== undefined && m.bloquePar !== k.bloque_par) changements.push(`bloqué par #${m.bloquePar}`);
    if (m.reponse) changements.push(`réponse : ${m.reponse}`);
    if (m.note) changements.push(m.note);
    if (changements.length === 0) return { ok: false as const, raison: `rien à changer sur le ticket #${id}. Se lève avec un état, un chargé ou une note qui diffère` };
    const le = maintenant();
    const quoi = changements.join(" ; ");
    t.run(`UPDATE tickets SET etat = ?, charge = ?, commit_ferme = ?, reponse = ?, maj_le = ? WHERE id = ?`,
      [etat ?? k.etat, m.charge ?? k.charge, etat === "ferme" ? m.commit ?? null : etat ? null : k.commit_ferme, m.reponse ?? k.reponse, le, id]);
    if (ferme && m.motif) t.run("UPDATE tickets SET motif = ?, remplace_par = ? WHERE id = ?", [m.motif, m.motif === "remplace_par" ? m.remplacePar! : null, id]);
    if (ferme && aColonne(t, "tickets", "ferme_le")) t.run("UPDATE tickets SET ferme_le = ? WHERE id = ?", [le, id]);
    if (m.bloquePar !== undefined) t.run("UPDATE tickets SET bloque_par = ? WHERE id = ?", [m.bloquePar, id]);
    if (nouveaux.length) t.run("UPDATE tickets SET chemins = ? WHERE id = ?", [JSON.stringify([...anciens, ...nouveaux]), id]);
    // Les pancartes du ticket que l'ancien chargé porte encore (le répartiteur a pu en reprendre une pour un autre ticket).
    const portes = anciens.filter((c) => t.get<{ agent: string }>("SELECT agent FROM reclamations WHERE chemin = ? AND retire_le IS NULL", [c])?.agent === k.charge);
    if (ferme && m.rendreA) confierPancartes(t, m.rendreA, [...portes, ...nouveaux], `rendu à la clôture du ticket #${id}`);
    else if (confie && m.charge) confierPancartes(t, m.charge, [...portes, ...nouveaux], `ticket #${id}`);
    else if (nouveaux.length && (m.charge ?? k.charge)) confierPancartes(t, (m.charge ?? k.charge)!, nouveaux, `ticket #${id}`);
    t.run("INSERT INTO ticket_notes(ticket_id, auteur, cree_le, texte) VALUES (?, ?, ?, ?)", [id, auteur, le, quoi]);
    const n = annonce ? insererMessage(t, auteur, annonce(t.get<Ticket>("SELECT * FROM tickets WHERE id = ?", [id])!, quoi), "tickets") : undefined;
    if (ferme || confie) {
      const msg = n !== undefined ? `, msg ${n}` : "";
      const note = m.note?.trim() ? declare(m.note, auteur, n) : undefined;
      const suite = note ? note.texte : `par ${auteur}${msg}`;
      const f = ferme && k.type === "question" && !m.motif
        ? (() => { const r = declare(m.reponse!, auteur, n, "e"); return { texte: `ticket #${id} fermé · réponse ${r.texte}`, details: r.details }; })()
        : ferme ? { texte: `ticket #${id} ${libelleFerme(m)}${m.commit ? ` · commit ${m.commit.slice(0, 7)} constaté dans le dossier commun` : ""}${m.recu ? ` · reçu ${m.recu}` : ""} · ${suite}`, details: note?.details }
        : { texte: `ticket #${id} confié à ${m.charge} · ${suite}`, details: note?.details };
      // details.de et vers : un ticket confié à un autre ; l'ancien chargé le lit dans sa ligne courte.
      const passe = confie && k.charge ? { de: k.charge, vers: m.charge } : undefined;
      noterFait(t, { type: "ticket", agent: auteur, source: "tableau", sujet: `#${id}`, messageId: n, texte: f.texte, details: f.details || passe ? { ...f.details, ...passe } : undefined });
    }
    return { ok: true as const };
  });
}

// Rôles des agents : les tickets ouverts d'un agent sorti (viré, perdu) passent à `vers` (le chef, ou le
// suppléant nommé si c'est le chef qui sort : roles.heritier), avec les pancartes de leurs chemins qu'il porte encore,
// par le même helper que confier et rendre. Une note dans chaque ticket, un fait, et une annonce dans le fil tickets qui
// nomme le repreneur (un dormeur se réveille). Transférer ne ferme jamais. Rend les numéros transférés.
// « d'Antoine », « de Claude » : l'élision devant un prénom qui commence par une voyelle ou un h.
export const deNom = (nom: string) => (/^[aeiouyhéèê]/i.test(nom) ? `d'${nom}` : `de ${nom}`);
export function transfererTickets(t: Tableau, de: string, vers: string, raison: string): number[] {
  return t.transaction(() => {
    const tickets = t.all<Ticket>("SELECT * FROM tickets WHERE charge = ? AND etat <> 'ferme' ORDER BY id", [de]);
    const le = maintenant();
    const depuis = deNom(de);
    for (const k of tickets) {
      const portes = cheminsDuTicket(k).filter((c) => t.get<{ agent: string }>("SELECT agent FROM reclamations WHERE chemin = ? AND retire_le IS NULL", [c])?.agent === de);
      t.run("UPDATE tickets SET charge = ?, maj_le = ? WHERE id = ?", [vers, le, k.id]);
      confierPancartes(t, vers, portes, `transfert du ticket #${k.id}`);
      const quoi = `transféré ${depuis} à ${vers} (${raison})`;
      t.run("INSERT INTO ticket_notes(ticket_id, auteur, cree_le, texte) VALUES (?, ?, ?, ?)", [k.id, "salle", le, quoi]);
      const n = insererMessage(t, "salle", `[ticket #${k.id}] ${k.titre} : ${quoi} (chargé : ${vers})`, "tickets");
      noterFait(t, { type: "ticket", agent: de, source: "lanceur", sujet: `#${k.id}`, messageId: n, texte: `ticket #${k.id} transféré ${depuis} à ${vers} · ${raison}` });
    }
    return tickets.map((k) => k.id);
  });
}

// ---- La passation d'un siège ------------------------------------------------------------------------
// La note du sortant (moi_passation) : ses intentions, ses décisions, ses doutes, gardés tels quels. Le lanceur relance
// le siège, et l'entrant la reçoit citée comme déclarée, après l'état du siège constaté par la salle.
export function noterPassation(t: Tableau, agent: string, role: string, texte: string): number {
  return t.run("INSERT INTO passations(agent, role, texte, cree_le) VALUES (?, ?, ?, ?)", [agent, role, texte, maintenant()]).lastId;
}
export type Passation = { id: number; agent: string; role: string; texte: string; cree_le: string; entrant: string | null; livree_le: string | null };
// La note d'un sortant encore sans entrant : le lanceur relance son siège.
export const passationEnAttente = (t: Tableau, agent: string) =>
  t.get<Passation>("SELECT * FROM passations WHERE agent = ? AND entrant IS NULL ORDER BY id DESC LIMIT 1", [agent]);
// La note remise à un entrant (undefined après une panne : le sortant n'en a pas écrit).
export const passationPour = (t: Tableau, entrant: string) =>
  aTable(t, "passations") ? t.get<Passation>("SELECT * FROM passations WHERE entrant = ? ORDER BY id DESC LIMIT 1", [entrant]) : undefined;
export const predecesseur = (t: Tableau, agent: string) =>
  aColonne(t, "agents", "remplace") ? t.get<{ remplace: string | null }>("SELECT remplace FROM agents WHERE nom = ?", [agent])?.remplace ?? undefined : undefined;
// Le siège change d'occupant : l'entrant reçoit les tickets ouverts et toutes les pancartes du sortant (le livrable de
// l'intégrateur compris), la note du sortant lui est attribuée, et le droit de signer du sortant tombe.
// Rend les tickets transférés et le nombre de signatures révoquées.
export function succeder(t: Tableau, sortant: string, entrant: string, raison: string): { tickets: number[]; revoquees: number } {
  const tickets = transfererTickets(t, sortant, entrant, raison);
  return t.transaction(() => {
    const restes = t.all<{ chemin: string }>("SELECT chemin FROM reclamations WHERE agent = ? AND retire_le IS NULL ORDER BY id", [sortant]).map((r) => r.chemin);
    confierPancartes(t, entrant, restes, `siège repris de ${sortant}`);
    t.run("UPDATE passations SET entrant = ? WHERE agent = ? AND entrant IS NULL", [entrant, sortant]);
    return { tickets, revoquees: revoquerSignatures(t, sortant) };
  });
}
// L'entrant a reçu l'état du siège (et la note) dans son premier message : le lanceur le constate (message_end de pi).
export function confirmerSuccession(t: Tableau, entrant: string): void {
  t.run("UPDATE passations SET livree_le = ? WHERE entrant = ? AND livree_le IS NULL", [maintenant(), entrant]);
}

// ---- Les leçons ---------------------------------------------------------------------------------------
// Archivées, jamais activées : seuls le bilan de fin de run (leconsDuRun) et la vue les lisent, et seulement dans le
// tableau de leur run (tests/fin-de-run.test.ts le vérifie). Les textes vides sont ignorés. Rend le nombre gardé.
export function noterLecons(t: Tableau, agent: string, role: string | undefined, lecons: string[] | undefined): number {
  const textes = (lecons ?? []).map((l) => String(l ?? "").trim()).filter(Boolean);
  if (!textes.length || !aTable(t, "lecons")) return 0;
  const run = t.get<{ id: string }>("SELECT id FROM run LIMIT 1")?.id ?? "";
  const le = maintenant();
  t.transaction(() => { for (const x of textes) t.run("INSERT INTO lecons(agent, role, run, cree_le, texte) VALUES (?, ?, ?, ?, ?)", [agent, role ?? null, run, le, x]); });
  return textes.length;
}
export type Lecon = { id: number; agent: string; role: string | null; run: string; cree_le: string; texte: string; remplacee_par: number | null };
export const leconsDuRun = (t: Tableau): Lecon[] => (aTable(t, "lecons") ? t.all<Lecon>("SELECT * FROM lecons ORDER BY id") : []);

// ---- La mesure des outils --------------------------------------------------------------------
// Une seule fonction, en lecture seule, pour la sonde bilan-outils et le bilan de fin de run ; elle lit les anciens
// runs (anciens noms) comme les nouveaux. Appels comptés sur tool_execution_end, commandes bash sur
// tool_execution_start (champ command).

// Un refus : le résultat commence par « refusé » (ou « occupé par », la pancarte des anciens runs). Une erreur :
// erreur non nul et pas un refus. Refus et erreurs sont disjoints.
const REFUS = /^(refusé|occupé par)/;
// Les causes d'un refus, essayées dans l'ordre ; rien ne correspond : « autres ».
const CAUSES_REFUS: Array<[Exclude<CauseRefus, "autres">, RegExp]> = [
  ["coupure", /au-delà de la coupure/],
  ["tour", /tour de parole|ne s'est pas encore exprimé/],
  ["tickets", /ticket|reste ouvert/],
  ["fil", /dernier|fil de la salle|aucun fil|pourquoi|conclusion/],
  ["livrable", /livrable/],
];
// Une commande composée enchaîne (&&, ||, ;) ou envoie sa sortie (|) à autre chose qu'un filtre de lecture : un outil
// ne la remplacerait pas seul. Un « cd <dossier> && » en tête ne compte pas : les agents l'écrivent presque toujours.
export const CD_EN_TETE = /^\s*cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*/;
const ENCHAINEMENT = /&&|\|\||;/;
const TUBE = /(?<!\|)\|(?!\|)\s*([^\s|;&]+)/g;
const FILTRES_LECTURE = new Set(["grep", "tail", "head", "wc"]);
export const BUN_TEST = /\bbun\s+test\b/;
// La racine d'un bun test lancé par bash (second cerveau) : bash tourne dans le bureau de l'agent, seul le cd de
// tête dit quel dossier est testé. Le dossier tel qu'écrit (guillemets retirés ; l'extension le résout depuis le
// bureau), à condition qu'aucun autre cd ne vienne avant bun test ; plusieurs : deux bun test ou plus, bilans mêlés.
// undefined : pas de bun test, pas de cd en tête, ou un autre cd avant bun test.
export function dossierDeTest(commande: string): { dossier: string; plusieurs?: true } | undefined {
  const tete = /^\s*cd\s+("[^"]*"|'[^']*'|\S+)\s*&&\s*/.exec(commande);
  if (!tete) return undefined;
  const reste = commande.slice(tete[0].length);
  const premier = BUN_TEST.exec(reste);
  if (!premier || /(^|[\s;&|(])cd(\s|$)/.test(reste.slice(0, premier.index))) return undefined;
  const dossier = tete[1]!.replace(/^(["'])(.*)\1$/, "$2");
  return (reste.match(new RegExp(BUN_TEST.source, "g")) ?? []).length > 1 ? { dossier, plusieurs: true } : { dossier };
}
const GIT_LOG = /\bgit(?:\s+(?:-[Cc]\s+\S+|--?[\w-]+(?:=\S+)?))*\s+log\b/;
const SQLITE3_TABLEAU = /\bsqlite3\b[\s\S]*tableau\.sqlite/;
const BUN_TEST_ESSAI = /\/essais\//;
const BUN_TEST_FILTRE = /\s(?:-t|--test-name-pattern)(?:\s|=)/;
// « Appels corrigés » est un indicateur approché : un appel en erreur ou refusé (hors coupure) suivi, par le même
// agent, d'un autre outil dans les deux appels suivants — le mauvais outil du premier coup.
const FENETRE_CORRECTION = 2;
const OUTIL_INCONNU = "outil_inconnu"; // le nom que session.ts donne à un appel sans nom réparé

export type CauseRefus = "coupure" | "tour" | "tickets" | "fil" | "livrable" | "autres";
export type BilanOutils = {
  noms: "anciens" | "nouveaux"; // run.outils_json, sinon présence d'un outil « salle_% »
  appels: number; erreurs: number; refus: number; repetes: number; corriges: number;
  inconnus: Record<string, number>; outilInconnu: number; tronques: number;
  parOutil: Record<string, { appels: number; erreurs: number; refus: number }>;
  parCause: Record<CauseRefus, number>;
  parAgent: Record<string, { appels: number; refus: number; repetes: number; inconnus: number; bunTest: number; gitLog: number; sqlite3: number }>;
  bash: { bunTest: { simples: number; composees: number; partage: number; essai: number; filtre: number };
          gitLog: { simples: number; composees: number }; sqlite3: { simples: number; composees: number } };
};
export type ResumeOutils = { appels: number; inconnus: number; refus: number; repetes: number; bash: { bunTest: number; gitLog: number; sqlite3: number } };

export const causeRefus = (resultat: string): CauseRefus => CAUSES_REFUS.find(([, r]) => r.test(resultat))?.[0] ?? "autres";

export function commandeComposee(commande: string): boolean {
  commande = commande.replace(CD_EN_TETE, "");
  if (ENCHAINEMENT.test(commande)) return true;
  for (const m of commande.matchAll(TUBE)) if (!FILTRES_LECTURE.has(m[1]!.split("/").pop()!)) return true;
  return false;
}

// La commande d'un appel bash ; des arguments tronqués (JSON illisible) sont lus quand même, par expression régulière.
function lireCommande(argumentsJson: string | null): { commande?: string; tronque: boolean } {
  if (argumentsJson === null) return { tronque: false };
  try {
    const a = JSON.parse(argumentsJson) as { command?: unknown } | null;
    return { commande: typeof a?.command === "string" ? a.command : undefined, tronque: false };
  } catch {
    const m = /"command"\s*:\s*"((?:\\.|[^"\\])*)/.exec(argumentsJson);
    if (!m) return { tronque: true };
    let commande = m[1]!;
    try { commande = JSON.parse(`"${commande.replace(/\\$/, "")}"`) as string; } catch { /* gardée telle quelle */ }
    return { commande, tronque: true };
  }
}

type LigneOutil = { agent: string; type: string; outil: string | null; arguments_json: string | null; resultat_resume: string | null; erreur: string | null };
type AppelLu = { outil: string; refus: boolean; erreur: boolean; cause?: CauseRefus };

export function bilanOutils(t: Tableau): BilanOutils {
  const lignes = t.all<LigneOutil>(`SELECT agent, type, outil, arguments_json, resultat_resume, erreur FROM evenements
    WHERE type IN ('tool_execution_start', 'tool_execution_end') ORDER BY id`);
  // Le jeu de noms : la liste enregistrée dans run quand elle existe, sinon la présence d'un outil « salle_% ».
  const brut = aColonne(t, "run", "outils_json") ? t.get<{ outils_json: string | null }>("SELECT outils_json FROM run")?.outils_json : undefined;
  const liste = brut ? (JSON.parse(brut) as string[]) : undefined;
  const nouveaux = liste ? liste.some((n) => n.startsWith("salle_")) : lignes.some((l) => l.outil?.startsWith("salle_"));
  const connus = new Set<string>(liste ?? [...OUTILS_PI, ...(nouveaux ? [...OUTILS_SALLE, ...OUTILS_RETIRES] : ANCIENS_OUTILS_SALLE)]);
  const b: BilanOutils = {
    noms: nouveaux ? "nouveaux" : "anciens",
    appels: 0, erreurs: 0, refus: 0, repetes: 0, corriges: 0, inconnus: {}, outilInconnu: 0, tronques: 0,
    parOutil: {}, parCause: { coupure: 0, tour: 0, tickets: 0, fil: 0, livrable: 0, autres: 0 }, parAgent: {},
    bash: { bunTest: { simples: 0, composees: 0, partage: 0, essai: 0, filtre: 0 }, gitLog: { simples: 0, composees: 0 }, sqlite3: { simples: 0, composees: 0 } },
  };
  const parAgent = (nom: string) => (b.parAgent[nom] ??= { appels: 0, refus: 0, repetes: 0, inconnus: 0, bunTest: 0, gitLog: 0, sqlite3: 0 });
  const suites = new Map<string, AppelLu[]>(); // les appels de chaque agent, dans l'ordre, pour répétés et corrigés

  for (const l of lignes) {
    const outil = l.outil ?? "";
    if (l.type === "tool_execution_start") {
      const { commande, tronque } = lireCommande(l.arguments_json);
      if (tronque) b.tronques++;
      if (outil !== "bash" || commande === undefined) continue;
      const compose = commandeComposee(commande);
      const a = parAgent(l.agent);
      if (BUN_TEST.test(commande)) {
        a.bunTest++;
        b.bash.bunTest[compose ? "composees" : "simples"]++;
        b.bash.bunTest[BUN_TEST_ESSAI.test(commande) ? "essai" : BUN_TEST_FILTRE.test(commande) ? "filtre" : "partage"]++;
      }
      if (GIT_LOG.test(commande)) { a.gitLog++; b.bash.gitLog[compose ? "composees" : "simples"]++; }
      if (SQLITE3_TABLEAU.test(commande)) { a.sqlite3++; b.bash.sqlite3[compose ? "composees" : "simples"]++; }
      continue;
    }
    const resultat = l.resultat_resume ?? "";
    const refus = REFUS.test(resultat);
    const erreur = !refus && l.erreur !== null;
    const a = parAgent(l.agent);
    const o = (b.parOutil[outil] ??= { appels: 0, erreurs: 0, refus: 0 });
    b.appels++; a.appels++; o.appels++;
    if (erreur) { b.erreurs++; o.erreurs++; }
    if (outil === OUTIL_INCONNU) b.outilInconnu++;
    else if (!connus.has(outil)) { b.inconnus[outil] = (b.inconnus[outil] ?? 0) + 1; a.inconnus++; }
    const suite = suites.get(l.agent) ?? [];
    suites.set(l.agent, suite);
    const lu: AppelLu = { outil, refus, erreur };
    if (refus) {
      lu.cause = causeRefus(resultat);
      b.refus++; a.refus++; o.refus++; b.parCause[lu.cause]++;
      const avant = suite.at(-1);
      if (avant?.refus && avant.outil === outil && avant.cause === lu.cause) { b.repetes++; a.repetes++; }
    }
    suite.push(lu);
  }

  for (const suite of suites.values())
    suite.forEach((c, i) => {
      if (!(c.refus || c.erreur) || c.cause === "coupure") return;
      if (suite.slice(i + 1, i + 1 + FENETRE_CORRECTION).some((d) => d.outil !== c.outil)) b.corriges++;
    });
  return b;
}

export function resumeOutils(b: BilanOutils): ResumeOutils {
  const { bunTest, gitLog, sqlite3 } = b.bash;
  return {
    appels: b.appels, inconnus: Object.values(b.inconnus).reduce((s, n) => s + n, 0), refus: b.refus, repetes: b.repetes,
    bash: { bunTest: bunTest.simples + bunTest.composees, gitLog: gitLog.simples + gitLog.composees, sqlite3: sqlite3.simples + sqlite3.composees },
  };
}
