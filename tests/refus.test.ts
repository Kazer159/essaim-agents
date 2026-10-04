// Chaque refus a la forme commune
// « refusé : <le fait>. <ce qui le lève>. » (ou « refusé une fois : … » pour les rappels), et chaque cas annoncé dans la
// ligne « Refus : » d'une description est provoqué ici, dans son état réel (tableau, dépôt git, dossier partagé), sans
// effet sur le tableau ni sur le dépôt. Une liste peut suivre le refus sur les lignes d'après (tickets, erreurs de page).
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ouvrirBun } from "../src/tableau-bun.ts";
import * as T from "../src/tableau.ts";
import { fauxPi } from "./aide/faux-extension-api.ts";
import extension from "../src/outils-essaim.ts";
import seResumer from "../src/se-resumer.ts";
import { cheminNavigateur } from "../src/voir.ts";
import { FORME } from "./aide/refus.ts";
import * as D from "../src/depot.ts";

let dossier: string;
let chemin: string;
let partage: string;
let t: T.Tableau;

type Contexte = { t: T.Tableau; dossier: string; partage: string; essais: string; surs: D.Surs };
type Cas = {
  outil: string;
  cas: string;
  args: Record<string, unknown>;
  agent?: string;
  env?: Record<string, string>;
  preparer?: (c: Contexte) => Promise<void> | void;
  ouvrir?: (chemin: string) => T.Tableau; // un tableau truqué (base occupée)
  navigateur?: boolean; // le cas exige le navigateur de Playwright
  depot?: boolean; // le dépôt du run est ouvert et ses demandes servies, comme par le lanceur
};

// Préparations partagées.
// Rôles : agent-01 tient le siège de chef, agent-02 celui de constructeur (avec ESSAIM_ROLE du cas).
const rolesEnBase = (roles: Record<string, string>) => ({ t }: Contexte) => { for (const [nom, role] of Object.entries(roles)) t.run("UPDATE agents SET role = ? WHERE nom = ?", [role, nom]); };
const chefEnBase = ({ t }: Contexte) => { t.run("UPDATE agents SET role = 'chef' WHERE nom = 'agent-01'"); t.run("UPDATE agents SET role = 'constructeur' WHERE nom = 'agent-02'"); };
const parle = (agent = "agent-01") => T.poster(t, agent, `bonjour de ${agent}`);
const commiter = async (c: Contexte, fichiers: Record<string, string>, racine = c.partage) => {
  for (const [f, contenu] of Object.entries(fichiers)) { mkdirSync(join(racine, f, ".."), { recursive: true }); writeFileSync(join(racine, f), contenu); }
  return D.commiter(racine, "agent-02", "write");
};
const essaiQuiChange = async (c: Contexte, nom = "x") => { const d = await D.ouvrirEssai(c.partage, c.essais, nom); await commiter(c, { "moteur.js": "three\n" }, d); return d; };
const depotRemplace = (c: Contexte) => { c.surs.set(c.partage, -1); };
// Rôles : un ticket de travail confié à agent-02 avec un chemin, une alerte dont la reproduction est figée au commit
// donné (par défaut, un commit qui n'est pas main).
const travailEnBase = (c: Contexte) => { chefEnBase(c); T.ouvrirTicket(c.t, { type: "amelioration", titre: "x", description: "y", auteur: "agent-01", charge: "agent-02", chemins: ["a.js"] }); };
const alerteEnBase = (commit = "0".repeat(40)) => (c: Contexte) => { chefEnBase(c);
  T.ouvrirTicket(c.t, { type: "bug", titre: "x", description: "y", auteur: "agent-01", charge: "agent-02", sorte: "alerte", reproduction: { commande: "bun test", graine: null, commit, banc: {}, monde: {} } }); };
const alerteAuCommitDeMain = async (c: Contexte) => alerteEnBase((await D.contenuDans(c.partage, "main") as { hash: string }).hash)(c);
// Rôles : les rôles donnés, et deux phrases numérotées de la mission, comme le lanceur les pose.
const phrasesEnBase = (roles: Record<string, string>) => (c: Contexte) => { rolesEnBase(roles)(c);
  T.noterPhrases(c.t, [{ n: 1, section: "Mission", texte: "Un titre." }, { n: 2, section: "Mission", texte: "Trois clics affichent 3." }]); };
const RANGER = { env: { ESSAIM_ROLE: "chef" }, preparer: phrasesEnBase({ "agent-01": "chef", "agent-02": "recette" }) };
const CONTESTER = { env: { ESSAIM_ROLE: "gardien" }, preparer: phrasesEnBase({ "agent-01": "gardien", "agent-02": "chef" }) };
// Rôles : E1 tenue par la recette (agent-01), E2 par le gardien (agent-02), et trois reçus du lanceur dans preuves/ :
// 1 passe pour E1, 2 passe pour E2, 3 ne passe pas pour E1. Le dossier partagé est vide : aucun reçu n'est périmé.
const preuvesEnBase = (roles: Record<string, string> = { "agent-01": "recette", "agent-02": "gardien" }) => (c: Contexte) => {
  phrasesEnBase(roles)(c);
  T.rangerExigence(c.t, { phrases: [1], classement: "exigence", responsable: "recette", par: "chef" });
  T.rangerExigence(c.t, { phrases: [2], classement: "exigence", responsable: "gardien", par: "chef" });
  mkdirSync(join(c.dossier, "preuves"), { recursive: true });
  const recu = (n: number, o: object) => writeFileSync(join(c.dossier, "preuves", `${n}.json`), JSON.stringify({ n, demande: n, sorte: "exigence", exigence: "E1", demandeur: "agent-01",
    commande: "true", graine: null, commit: null, conditions: { banc: [], monde: [] }, empreintes: { banc: {}, monde: {}, produit: {} }, code: 0, sortie: "", dureeMs: 1, date: "", passe: true, texte: `preuves/${n}.json`, ...o }));
  recu(1, {}); recu(2, { exigence: "E2" }); recu(3, { passe: false, code: 1 });
};
const RECETTE = { env: { ESSAIM_ROLE: "recette" }, preparer: preuvesEnBase() };
// Les jalons : E1 rangée par le chef (agent-01), puis découpée en E1.1 et E1.2.
const e1EnBase = (c: Contexte) => { RANGER.preparer(c); T.rangerExigence(c.t, { phrases: [1], classement: "exigence", responsable: "recette", par: "agent-01" }); };
const jalonsEnBase = (c: Contexte) => { e1EnBase(c); T.jalonner(c.t, { parent: "E1", portees: ["a", "b"], par: "agent-01" }); };
const decoupeeEnBase = (c: Contexte) => { preuvesEnBase()(c); T.jalonner(c.t, { parent: "E1", portees: ["a", "b"], par: "chef" }); };
const CONSTRUCTEUR = { agent: "agent-02", env: { ESSAIM_ROLE: "constructeur" } };
const CHEF = { env: { ESSAIM_ROLE: "chef" } };

// Le surveillant : agent-01 surveille, agent-02 est constructeur ; personne ne
// tient les sièges de chef, de gardien ni de recette : aucun message ne peut partir.
// La révision : une ligne de revisions dans l'état donné ; le surveillant agent-01, le chef agent-02, le
// début du run reculé de deux heures (la grâce finie) et un signe du lanceur déjà posé.
const revisionEnBase = (t: T.Tableau, etat: string) => t.run("INSERT INTO revisions(demandeur, constat, tickets_json, etat, cree_le, repondu_le, tickets_geles_json) VALUES ('agent-01', 'c', '[]', ?, ?, ?, '[]')",
  [etat, new Date().toISOString(), etat === "demandee" ? null : new Date().toISOString()]).lastId;
const surveillantEnBase = (c: Contexte) => { rolesEnBase({ "agent-01": "surveillant", "agent-02": "chef" })(c); c.t.run("UPDATE run SET debut = ?", [new Date(Date.now() - 2 * 3_600_000).toISOString()]);
  c.t.run("INSERT INTO evenements(agent, horodatage, type, resultat_resume) VALUES ('lanceur', ?, 'signe', 'agent-01 réveillé : S4')", [new Date().toISOString()]); };
const SURVEILLANT_CHEF = { env: { ESSAIM_ROLE: "surveillant" } };
const SURVEILLANT = { env: { ESSAIM_ROLE: "surveillant" }, preparer: rolesEnBase({ "agent-01": "surveillant", "agent-02": "constructeur" }) };
const CAS: Cas[] = [
  // salle_poster
  { outil: "salle_poster", cas: "tour de parole", agent: "agent-02", env: { ESSAIM_TOUR_MS: "90000" }, args: { texte: "mon plan" } },
  { outil: "salle_poster", cas: "surveillant hors de ses destinataires", ...SURVEILLANT, args: { texte: "agent-02 : arrête" } },

  // moi_dormir
  { outil: "moi_dormir", cas: "message vide", args: { message: "   " } },
  { outil: "moi_dormir", cas: "surveillant hors de ses destinataires", ...SURVEILLANT, args: { message: "agent-02 : rien à signaler" } },
  { outil: "moi_dormir", cas: "tour de parole", agent: "agent-02", env: { ESSAIM_TOUR_MS: "90000" }, args: { message: "je dors" } },
  { outil: "moi_dormir", cas: "ticket ouvert confié", preparer: ({ t }) => { T.ouvrirTicket(t, { type: "bug", titre: "carte vide", description: "index.html", auteur: "agent-02", charge: "agent-01" }); }, args: { message: "je dors" } },
  { outil: "moi_dormir", cas: "cinq veilles prises", preparer: ({ t }) => { t.run("UPDATE agents SET sommeils = 5 WHERE nom = 'agent-01'"); }, args: { message: "je dors" } },

  // plan_proposer, plan_juger (préparer la mission)
  { outil: "plan_proposer", cas: "un autre que celui qui répartit", agent: "agent-02", env: { ESSAIM_ROLE: "integrateur" }, preparer: rolesEnBase({ "agent-01": "chef", "agent-02": "integrateur" }), args: { etape: "spec", resume: "le plan" } },
  { outil: "plan_proposer", cas: "étape inconnue", ...CHEF, preparer: chefEnBase, args: { etape: "tout", resume: "r" } },
  { outil: "plan_proposer", cas: "résumé vide", ...CHEF, preparer: chefEnBase, args: { etape: "spec", resume: "   " } },
  { outil: "plan_proposer", cas: "fichier de l'étape absent", ...CHEF, preparer: chefEnBase, args: { etape: "spec", resume: "r" } },
  { outil: "plan_proposer", cas: "fichier trop long", ...CHEF, preparer: (c) => { chefEnBase(c); writeFileSync(join(c.partage, "SPEC.md"), "x".repeat(6001)); }, args: { etape: "spec", resume: "r" } },
  { outil: "plan_proposer", cas: "spec déjà validée", ...CHEF, preparer: (c) => { chefEnBase(c); writeFileSync(join(c.partage, "SPEC.md"), "# Spec"); T.marquerPlanValide(c.t, T.proposerPlan(c.t, "agent-01", "s", "SPEC.md", "spec")); }, args: { etape: "spec", resume: "r" } },
  { outil: "plan_proposer", cas: "plan avant la spec validée", ...CHEF, preparer: (c) => { chefEnBase(c); writeFileSync(join(c.partage, "PLAN.md"), "# Plan"); }, args: { etape: "plan", resume: "r" } },
  // Le surveillant : la spec rouverte par une révision acceptée.
  { outil: "plan_proposer", cas: "pendant une révision, spec sans exigences_changees", ...CHEF, preparer: (c) => { chefEnBase(c); writeFileSync(join(c.partage, "SPEC.md"), "# Spec"); revisionEnBase(c.t, "acceptee"); }, args: { etape: "spec", resume: "r" } },
  { outil: "plan_proposer", cas: "exigence déclarée inconnue", ...CHEF, preparer: (c) => { chefEnBase(c); writeFileSync(join(c.partage, "SPEC.md"), "# Spec"); }, args: { etape: "spec", resume: "r", exigences_changees: ["E9"] } },
  { outil: "plan_proposer", cas: "pendant une révision, exigence déclarée pas rangée de nouveau", ...CHEF, preparer: (c) => { chefEnBase(c); writeFileSync(join(c.partage, "PLAN.md"), "# Plan");
    const r = revisionEnBase(c.t, "acceptee"); c.t.run("INSERT INTO exigences(libelle, classement, responsable, range_par, cree_le) VALUES ('E1', 'exigence', 'recette', 'agent-01', '2026-10-03T00:00:00Z')");
    T.marquerPlanValide(c.t, T.proposerPlan(c.t, "agent-01", "s", "SPEC.md", "spec", { revision: r, exigencesChangees: ["E1"] })); }, args: { etape: "plan", resume: "r" } },
  { outil: "plan_proposer", cas: "ticket repris pas gelé", ...CHEF, preparer: (c) => { chefEnBase(c); writeFileSync(join(c.partage, "PLAN.md"), "# Plan");
    const r = revisionEnBase(c.t, "acceptee"); T.marquerPlanValide(c.t, T.proposerPlan(c.t, "agent-01", "s", "SPEC.md", "spec", { revision: r, exigencesChangees: [] })); }, args: { etape: "plan", resume: "r", tickets_repris: [5] } },
  { outil: "plan_juger", cas: "fichier changé depuis la proposition", env: { ESSAIM_ROLE: "recette" }, preparer: (c) => { writeFileSync(join(c.partage, "SPEC.md"), "# Spec réécrite"); T.proposerPlan(c.t, "agent-02", "s", "SPEC.md", "spec", { empreinte: "0".repeat(64) }); }, args: { plan: 1, verdict: "valide", raison: "r" } },
  // revision_demander : agent-01 surveille, agent-02 est chef ; la grâce part du début du run, reculé de deux heures.
  { outil: "revision_demander", cas: "préparation en cours", ...SURVEILLANT_CHEF, preparer: (c) => { surveillantEnBase(c); T.ouvrirPreparation(c.t); }, args: { constat: "x", tickets: [] } },
  { outil: "revision_demander", cas: "grâce pas finie", ...SURVEILLANT_CHEF, preparer: (c) => { surveillantEnBase(c); c.t.run("UPDATE run SET debut = ?", [new Date().toISOString()]); }, args: { constat: "x", tickets: [] } },
  { outil: "revision_demander", cas: "révision déjà demandée", ...SURVEILLANT_CHEF, preparer: (c) => { surveillantEnBase(c); revisionEnBase(c.t, "demandee"); }, args: { constat: "x", tickets: [] } },
  { outil: "revision_demander", cas: "deux révisions acceptées", ...SURVEILLANT_CHEF, preparer: (c) => { surveillantEnBase(c); revisionEnBase(c.t, "close"); revisionEnBase(c.t, "close"); }, args: { constat: "x", tickets: [] } },
  { outil: "revision_demander", cas: "aucun signe", ...SURVEILLANT_CHEF, preparer: (c) => { surveillantEnBase(c); c.t.run("DELETE FROM evenements WHERE type = 'signe'"); }, args: { constat: "x", tickets: [] } },
  { outil: "revision_demander", cas: "constat vide", ...SURVEILLANT_CHEF, preparer: surveillantEnBase, args: { constat: "  ", tickets: [] } },
  { outil: "revision_demander", cas: "ticket inconnu", ...SURVEILLANT_CHEF, preparer: surveillantEnBase, args: { constat: "la spec suppose X ; le run mesure Y", tickets: [99] } },
  // revision_repondre : agent-01 est chef ; agent-02, constructeur suppléant du chef, ne répartit pas tant qu'il est là.
  { outil: "revision_repondre", cas: "un autre que celui qui répartit", agent: "agent-02", env: { ESSAIM_ROLE: "constructeur", ESSAIM_SUPPLEANT_DE: "chef" }, preparer: (c) => { chefEnBase(c); revisionEnBase(c.t, "demandee"); }, args: { accepte: false, raison: "r" } },
  { outil: "revision_repondre", cas: "aucune révision en attente", ...CHEF, preparer: chefEnBase, args: { accepte: false, raison: "r" } },
  { outil: "revision_repondre", cas: "raison vide", ...CHEF, preparer: (c) => { chefEnBase(c); revisionEnBase(c.t, "demandee"); }, args: { accepte: false, raison: " " } },
  { outil: "revision_repondre", cas: "ticket gelé inconnu", ...CHEF, preparer: (c) => { chefEnBase(c); revisionEnBase(c.t, "demandee"); }, args: { accepte: true, raison: "r", tickets_geles: [99] } },
  { outil: "plan_juger", cas: "aucun plan proposé", env: { ESSAIM_ROLE: "recette" }, args: { plan: 1, verdict: "valide", raison: "r" } },
  { outil: "plan_juger", cas: "verdict inconnu", env: { ESSAIM_ROLE: "recette" }, preparer: ({ t }) => { T.proposerPlan(t, "agent-02", "le plan"); }, args: { plan: 1, verdict: "oui", raison: "r" } },
  { outil: "plan_juger", cas: "raison vide", env: { ESSAIM_ROLE: "recette" }, preparer: ({ t }) => { T.proposerPlan(t, "agent-02", "le plan"); }, args: { plan: 1, verdict: "valide", raison: "  " } },
  // moi_finir
  { outil: "moi_finir", cas: "livrable qui ne s'ouvre pas sans erreur", navigateur: true, env: { ESSAIM_LIVRABLE: "livrable.html" },
    preparer: ({ partage }) => writeFileSync(join(partage, "livrable.html"), "<!doctype html><title>L</title><style>.absente { color: red; }</style><p>bonjour</p>"), args: { raison: "fait" } },
  { outil: "moi_finir", cas: "livrable absent (Q1)", env: { ESSAIM_LIVRABLE: "index.html" }, args: { raison: "fait" } },
  { outil: "moi_finir", cas: "ticket ouvert confié", preparer: ({ t }) => { T.ouvrirTicket(t, { type: "bug", titre: "carte vide", description: "index.html", auteur: "agent-02", charge: "agent-01" }); }, args: { raison: "fait" } },
  { outil: "moi_finir", cas: "chef (comme l'intégrateur, la recette, le gardien) avant le constat du run", env: { ESSAIM_ROLE: "chef" }, preparer: chefEnBase, args: { raison: "fait" } },
  { outil: "moi_finir", cas: "constructeur qui porte un ticket ouvert", agent: "agent-02", env: { ESSAIM_ROLE: "constructeur" },
    preparer: (c) => { chefEnBase(c); T.ouvrirTicket(c.t, { type: "bug", titre: "carte vide", description: "index.html", auteur: "agent-01", charge: "agent-02" }); }, args: { raison: "fait" } },
  { outil: "moi_finir", cas: "constructeur qui n'a pas demandé à celui qui répartit s'il reste du travail", agent: "agent-02", env: { ESSAIM_ROLE: "constructeur" }, preparer: chefEnBase, args: { raison: "fait" } },
  { outil: "moi_finir", cas: "tickets ouverts dans la salle", preparer: ({ t }) => { T.ouvrirTicket(t, { type: "question", titre: "quel moteur ?", description: "three ?", auteur: "agent-02" }); }, args: { raison: "fait" } },

  // moi_passation
  { outil: "moi_passation", cas: "note vide", env: { ESSAIM_ROLE: "constructeur" }, args: { note: "  " } },
  { outil: "moi_passation", cas: "siège qui ne peut plus changer d'occupant", env: { ESSAIM_ROLE: "constructeur", ESSAIM_CHANGEMENTS_SIEGE_MAX: "0" }, args: { note: "le moteur est à moitié fait" } },

  // fichier_reclamer
  { outil: "fichier_reclamer", cas: "chemin hors du dossier partagé", args: { chemin: "../secret", raison: "x" } },
  { outil: "fichier_reclamer", cas: "pancarte d'un autre", preparer: ({ t }) => { T.reclamer(t, "agent-02", "a.js", "le moteur"); }, args: { chemin: "a.js", raison: "x" } },
  { outil: "fichier_reclamer", cas: "pancarte déjà posée par soi", preparer: ({ t }) => { T.reclamer(t, "agent-01", "a.js", "le moteur"); }, args: { chemin: "a.js", raison: "x" } },
  { outil: "fichier_reclamer", cas: "pancarte hors de tes parts", agent: "agent-02", env: { ESSAIM_ROLE: "constructeur" }, preparer: rolesEnBase({ "agent-01": "chef", "agent-02": "constructeur" }), args: { chemin: "a.js", raison: "x" } },
  { outil: "fichier_reclamer", cas: "base occupée", args: { chemin: "a.js", raison: "x" },
    ouvrir: (c) => ({ ...ouvrirBun(c), transaction: () => { throw new Error("database is locked (SQLITE_BUSY)"); } }) },

  // ticket_ouvrir
  { outil: "ticket_ouvrir", cas: "chargé absent", args: { type: "bug", titre: "x", description: "y", charge: "Zoé" } },
  { outil: "ticket_ouvrir", cas: "bug à l'assembleur par un autre que le chef (K10, 03/10)", agent: "agent-02", env: { ESSAIM_ROLE: "constructeur" }, preparer: (c) => { T.ajouterAgent(c.t, "agent-03", "agents/agent-03"); rolesEnBase({ "agent-01": "chef", "agent-02": "constructeur", "agent-03": "assembleur" })(c); }, args: { type: "bug", titre: "x", description: "y", charge: "agent-03" } },
  { outil: "ticket_ouvrir", cas: "troisième bug à l'assembleur (O1, 03/10)", env: { ESSAIM_ROLE: "chef" }, preparer: (c) => { T.ajouterAgent(c.t, "agent-03", "agents/agent-03"); rolesEnBase({ "agent-01": "chef", "agent-02": "constructeur", "agent-03": "assembleur" })(c); for (const n of [1, 2]) T.ouvrirTicket(c.t, { type: "bug", titre: `x${n}`, description: "y", auteur: "agent-01", charge: "agent-03" }); }, args: { type: "bug", titre: "x", description: "y", charge: "agent-03", chemins: ["a.ts"] } },
  { outil: "ticket_ouvrir", cas: "bug à l'intégrateur quand un chef répartit (I1, 03/10)", env: { ESSAIM_ROLE: "chef" }, preparer: (c) => { T.ajouterAgent(c.t, "agent-03", "agents/agent-03"); rolesEnBase({ "agent-01": "chef", "agent-02": "constructeur", "agent-03": "integrateur" })(c); }, args: { type: "bug", titre: "x", description: "y", charge: "agent-03" } },
  { outil: "ticket_ouvrir", cas: "bug à l'assembleur sur la part d'un autre (T2, 03/10)", env: { ESSAIM_ROLE: "chef" }, preparer: (c) => { T.ajouterAgent(c.t, "agent-03", "agents/agent-03"); rolesEnBase({ "agent-01": "chef", "agent-02": "constructeur", "agent-03": "assembleur" })(c); T.reclamer(c.t, "agent-02", "a.ts", "sa part"); }, args: { type: "bug", titre: "x", description: "y", charge: "agent-03", chemins: ["a.ts"] } },
  { outil: "ticket_ouvrir", cas: "bug à un constructeur pendant la préparation (03/10)", env: { ESSAIM_ROLE: "chef" }, preparer: (c) => { rolesEnBase({ "agent-01": "chef", "agent-02": "constructeur" })(c); T.ouvrirPreparation(c.t); }, args: { type: "bug", titre: "x", description: "y", charge: "agent-02" } },
  { outil: "ticket_ouvrir", cas: "bug à la recette (T3, 03/10)", env: { ESSAIM_ROLE: "chef" }, preparer: (c) => { T.ajouterAgent(c.t, "agent-03", "agents/agent-03"); rolesEnBase({ "agent-01": "chef", "agent-02": "constructeur", "agent-03": "recette" })(c); }, args: { type: "bug", titre: "x", description: "y", charge: "agent-03" } },
  { outil: "ticket_ouvrir", cas: "bug à l'assembleur sans chemins (K10, 03/10)", env: { ESSAIM_ROLE: "chef" }, preparer: (c) => { T.ajouterAgent(c.t, "agent-03", "agents/agent-03"); rolesEnBase({ "agent-01": "chef", "agent-02": "constructeur", "agent-03": "assembleur" })(c); }, args: { type: "bug", titre: "x", description: "y", charge: "agent-03" } },
  { outil: "ticket_ouvrir", cas: "livrable confié à un autre que l'intégrateur (J2, 02/10)", env: { ESSAIM_ROLE: "chef", ESSAIM_LIVRABLE: "texte.jsonl" }, preparer: (c) => { T.ajouterAgent(c.t, "agent-03", "agents/agent-03"); rolesEnBase({ "agent-01": "chef", "agent-02": "constructeur", "agent-03": "integrateur" })(c); }, args: { type: "bug", titre: "x", description: "y", charge: "agent-02", chemins: ["texte.jsonl"] } },
  { outil: "ticket_ouvrir", cas: "chargé parti (O1, 02/10)", preparer: ({ t }) => { t.run("UPDATE agents SET etat = 'perdu' WHERE nom = 'agent-02'"); }, args: { type: "bug", titre: "x", description: "y", charge: "agent-02" } },
  { outil: "ticket_ouvrir", cas: "type inconnu", args: { type: "tache", titre: "x", description: "y" } },
  { outil: "ticket_ouvrir", cas: "titre ou description vide", args: { type: "bug", titre: " ", description: "y" } },
  // Rôles : les chemins confiés.
  { outil: "ticket_ouvrir", cas: "chemins confiés par un autre que celui qui répartit (run sans rôles)", args: { type: "bug", titre: "x", description: "y", charge: "agent-02", chemins: ["a.js"] } },
  { outil: "ticket_ouvrir", cas: "chemins sans chargé", env: { ESSAIM_ROLE: "chef" }, preparer: chefEnBase, args: { type: "bug", titre: "x", description: "y", chemins: ["a.js"] } },
  { outil: "ticket_ouvrir", cas: "chemin hors du dossier partagé", env: { ESSAIM_ROLE: "chef" }, preparer: chefEnBase, args: { type: "bug", titre: "x", description: "y", charge: "agent-02", chemins: ["../a.js"] } },
  // Rôles : les alertes.
  { outil: "ticket_ouvrir", cas: "sorte inconnue", args: { type: "bug", titre: "x", description: "y", sorte: "urgent" } },
  { outil: "ticket_ouvrir", cas: "alerte hors de la recette et du gardien, ou sans rôles", args: { type: "bug", titre: "x", description: "y", sorte: "alerte", reproduction: { commande: "bun test" } } },
  { outil: "ticket_ouvrir", cas: "alerte sans reproduction", env: { ESSAIM_ROLE: "recette" }, preparer: rolesEnBase({ "agent-01": "recette" }), args: { type: "bug", titre: "x", description: "y", sorte: "alerte" } },
  { outil: "ticket_ouvrir", cas: "fichier du banc introuvable", env: { ESSAIM_ROLE: "recette" }, preparer: rolesEnBase({ "agent-01": "recette" }),
    args: { type: "bug", titre: "x", description: "y", sorte: "alerte", reproduction: { commande: "bun test", banc: ["absent.test.ts"] } } },
  { outil: "ticket_ouvrir", cas: "reproduction qui passe déjà (sens inversé)", env: { ESSAIM_ROLE: "recette" }, preparer: rolesEnBase({ "agent-01": "recette" }),
    args: { type: "bug", titre: "x", description: "y", sorte: "alerte", reproduction: { commande: "true" } } },
  { outil: "ticket_ouvrir", cas: "reproduction sans alerte", args: { type: "bug", titre: "x", description: "y", reproduction: { commande: "bun test" } } },
  { outil: "ticket_ouvrir", cas: "exigence sans alerte", args: { type: "bug", titre: "x", description: "y", exigence: "E1" } },
  { outil: "ticket_ouvrir", cas: "exigence inconnue ou retirée", env: { ESSAIM_ROLE: "recette" }, preparer: phrasesEnBase({ "agent-01": "recette" }),
    args: { type: "bug", titre: "x", description: "y", sorte: "alerte", reproduction: { commande: "bun test" }, exigence: "E9" } },

  // ticket_modifier ; les cas du commit (inconnu, hors du dossier commun) sont avec le dépôt, plus bas.
  { outil: "ticket_modifier", cas: "chargé absent", preparer: ({ t }) => { T.ouvrirTicket(t, { type: "bug", titre: "x", description: "y", auteur: "agent-01" }); }, args: { id: 1, charge: "Zoé" } },
  { outil: "ticket_modifier", cas: "bug à l'assembleur par un autre que le chef (K10, 03/10)", agent: "agent-02", env: { ESSAIM_ROLE: "constructeur" }, preparer: (c) => { T.ajouterAgent(c.t, "agent-03", "agents/agent-03"); rolesEnBase({ "agent-01": "chef", "agent-02": "constructeur", "agent-03": "assembleur" })(c); T.ouvrirTicket(c.t, { type: "bug", titre: "x", description: "y", auteur: "agent-01", charge: "agent-02" }); }, args: { id: 1, charge: "agent-03" } },
  { outil: "ticket_modifier", cas: "troisième bug à l'assembleur (O1, 03/10)", env: { ESSAIM_ROLE: "chef" }, preparer: (c) => { T.ajouterAgent(c.t, "agent-03", "agents/agent-03"); rolesEnBase({ "agent-01": "chef", "agent-02": "constructeur", "agent-03": "assembleur" })(c); T.ouvrirTicket(c.t, { type: "bug", titre: "x", description: "y", auteur: "agent-01", charge: "agent-02" }); for (const n of [1, 2]) T.ouvrirTicket(c.t, { type: "bug", titre: `x${n}`, description: "y", auteur: "agent-01", charge: "agent-03" }); }, args: { id: 1, charge: "agent-03", chemins: ["a.ts"] } },
  { outil: "ticket_modifier", cas: "bug à l'intégrateur quand un chef répartit (I1, 03/10)", env: { ESSAIM_ROLE: "chef" }, preparer: (c) => { T.ajouterAgent(c.t, "agent-03", "agents/agent-03"); rolesEnBase({ "agent-01": "chef", "agent-02": "constructeur", "agent-03": "integrateur" })(c); T.ouvrirTicket(c.t, { type: "bug", titre: "x", description: "y", auteur: "agent-01", charge: "agent-02" }); }, args: { id: 1, charge: "agent-03" } },
  { outil: "ticket_modifier", cas: "bug à l'assembleur sur la part d'un autre (T2, 03/10)", env: { ESSAIM_ROLE: "chef" }, preparer: (c) => { T.ajouterAgent(c.t, "agent-03", "agents/agent-03"); rolesEnBase({ "agent-01": "chef", "agent-02": "constructeur", "agent-03": "assembleur" })(c); T.reclamer(c.t, "agent-02", "a.ts", "sa part"); T.ouvrirTicket(c.t, { type: "bug", titre: "x", description: "y", auteur: "agent-01", charge: "agent-02" }); }, args: { id: 1, charge: "agent-03", chemins: ["a.ts"] } },
  { outil: "ticket_modifier", cas: "bug à un constructeur pendant la préparation (03/10)", env: { ESSAIM_ROLE: "chef" }, preparer: (c) => { T.ajouterAgent(c.t, "agent-03", "agents/agent-03"); rolesEnBase({ "agent-01": "chef", "agent-02": "constructeur", "agent-03": "constructeur" })(c); T.ouvrirTicket(c.t, { type: "bug", titre: "x", description: "y", auteur: "agent-01", charge: "agent-03" }); T.ouvrirPreparation(c.t); }, args: { id: 1, charge: "agent-02" } },
  { outil: "ticket_modifier", cas: "bug à la recette (T3, 03/10)", env: { ESSAIM_ROLE: "chef" }, preparer: (c) => { T.ajouterAgent(c.t, "agent-03", "agents/agent-03"); rolesEnBase({ "agent-01": "chef", "agent-02": "constructeur", "agent-03": "recette" })(c); T.ouvrirTicket(c.t, { type: "bug", titre: "x", description: "y", auteur: "agent-01", charge: "agent-02" }); }, args: { id: 1, charge: "agent-03" } },
  { outil: "ticket_modifier", cas: "bug à l'assembleur sans chemins (K10, 03/10)", env: { ESSAIM_ROLE: "chef" }, preparer: (c) => { T.ajouterAgent(c.t, "agent-03", "agents/agent-03"); rolesEnBase({ "agent-01": "chef", "agent-02": "constructeur", "agent-03": "assembleur" })(c); T.ouvrirTicket(c.t, { type: "bug", titre: "x", description: "y", auteur: "agent-01", charge: "agent-02" }); }, args: { id: 1, charge: "agent-03" } },
  { outil: "ticket_modifier", cas: "livrable confié à un autre que l'intégrateur (J2, 02/10)", env: { ESSAIM_ROLE: "chef", ESSAIM_LIVRABLE: "texte.jsonl" }, preparer: (c) => { T.ajouterAgent(c.t, "agent-03", "agents/agent-03"); rolesEnBase({ "agent-01": "chef", "agent-02": "constructeur", "agent-03": "integrateur" })(c); T.ouvrirTicket(c.t, { type: "bug", titre: "x", description: "y", auteur: "agent-01", charge: "agent-02" }); }, args: { id: 1, chemins: ["texte.jsonl"] } },
  { outil: "ticket_modifier", cas: "chargé parti (O1, 02/10)", preparer: ({ t }) => { T.ouvrirTicket(t, { type: "bug", titre: "x", description: "y", auteur: "agent-01" }); t.run("UPDATE agents SET etat = 'vire' WHERE nom = 'agent-02'"); }, args: { id: 1, charge: "agent-02" } },
  { outil: "ticket_modifier", cas: "état inconnu", preparer: ({ t }) => { T.ouvrirTicket(t, { type: "bug", titre: "x", description: "y", auteur: "agent-01" }); }, args: { id: 1, etat: "fini" } },
  { outil: "ticket_modifier", cas: "ticket inconnu", args: { id: 7, etat: "en_cours" } },
  { outil: "ticket_modifier", cas: "bug fermé sans commit", preparer: ({ t }) => { T.ouvrirTicket(t, { type: "bug", titre: "x", description: "y", auteur: "agent-01" }); }, args: { id: 1, etat: "ferme" } },
  { outil: "ticket_modifier", cas: "question fermée sans note", preparer: ({ t }) => { T.ouvrirTicket(t, { type: "question", titre: "x", description: "y", auteur: "agent-01" }); }, args: { id: 1, etat: "ferme" } },
  { outil: "ticket_modifier", cas: "rien à changer", preparer: ({ t }) => { T.ouvrirTicket(t, { type: "bug", titre: "x", description: "y", auteur: "agent-01" }); }, args: { id: 1, etat: "ouvert" } },

  { outil: "ticket_modifier", cas: "chemins confiés par un autre que celui qui répartit (run sans rôles)", preparer: ({ t }) => { T.ouvrirTicket(t, { type: "bug", titre: "x", description: "y", auteur: "agent-01", charge: "agent-02" }); }, args: { id: 1, chemins: ["a.js"] } },
  { outil: "ticket_modifier", cas: "chemins sans chargé", env: { ESSAIM_ROLE: "chef" }, preparer: (c) => { chefEnBase(c); T.ouvrirTicket(c.t, { type: "bug", titre: "x", description: "y", auteur: "agent-01" }); }, args: { id: 1, chemins: ["a.js"] } },
  { outil: "ticket_modifier", cas: "chemin hors du dossier partagé", env: { ESSAIM_ROLE: "chef" }, preparer: (c) => { chefEnBase(c); T.ouvrirTicket(c.t, { type: "bug", titre: "x", description: "y", auteur: "agent-01", charge: "agent-02" }); }, args: { id: 1, chemins: ["../a.js"] } },
  // Rôles : les motifs de clôture et les demandes de rejeu.
  { outil: "ticket_modifier", cas: "motif inconnu", ...CONSTRUCTEUR, preparer: travailEnBase, args: { id: 1, motif: "fini" } },
  { outil: "ticket_modifier", cas: "motif avec un état autre que ferme", ...CONSTRUCTEUR, preparer: travailEnBase, args: { id: 1, motif: "livre", etat: "en_cours" } },
  { outil: "ticket_modifier", cas: "motif dans un run sans rôles", preparer: ({ t }) => { T.ouvrirTicket(t, { type: "bug", titre: "x", description: "y", auteur: "agent-01" }); }, args: { id: 1, motif: "annule", note: "x" } },
  { outil: "ticket_modifier", cas: "motif d'une autre sorte que le ticket", ...CONSTRUCTEUR, preparer: alerteEnBase(), args: { id: 1, motif: "livre" } },
  { outil: "ticket_modifier", cas: "ticket déjà fermé", ...CHEF, preparer: (c) => { travailEnBase(c); T.majTicket(c.t, 1, "agent-01", { motif: "annule", note: "doublon" }); }, args: { id: 1, motif: "annule", note: "encore" } },
  { outil: "ticket_modifier", cas: "livre sans commit, sans rapport ou sans chemin", ...CONSTRUCTEUR, preparer: travailEnBase, args: { id: 1, motif: "livre" } },
  { outil: "ticket_modifier", cas: "remplace_par sans successeur", ...CHEF, preparer: travailEnBase, args: { id: 1, motif: "remplace_par" } },
  { outil: "ticket_modifier", cas: "annule par un autre que celui qui répartit", ...CONSTRUCTEUR, preparer: travailEnBase, args: { id: 1, motif: "annule", note: "x" } },
  { outil: "ticket_modifier", cas: "annule sans note", ...CHEF, preparer: travailEnBase, args: { id: 1, motif: "annule" } },
  { outil: "ticket_modifier", cas: "alerte fermée par son état", ...CONSTRUCTEUR, preparer: alerteEnBase(), args: { id: 1, etat: "ferme" } },
  { outil: "ticket_modifier", cas: "corrige ou invalide par le chef", ...CHEF, preparer: alerteEnBase(), args: { id: 1, motif: "corrige" } },
  { outil: "ticket_modifier", cas: "corrige au même commit de main que la reproduction", ...CONSTRUCTEUR, depot: true, preparer: alerteAuCommitDeMain, args: { id: 1, motif: "corrige" } },
  { outil: "ticket_modifier", cas: "invalide sans contre-preuve", ...CONSTRUCTEUR, depot: true, preparer: alerteEnBase(), args: { id: 1, motif: "invalide" } },
  { outil: "ticket_modifier", cas: "demande de rejeu déjà en attente", ...CONSTRUCTEUR, depot: true,
    preparer: (c) => { alerteEnBase()(c); T.demanderRejeu(c.t, { ticket: 1, demandeur: "agent-02", motif: "corrige", commit: "1".repeat(40) }); }, args: { id: 1, motif: "corrige" } },
  { outil: "ticket_modifier", cas: "bloque_par inconnu ou le ticket lui-même", ...CHEF, preparer: travailEnBase, args: { id: 1, bloque_par: 9 } },

  { outil: "ticket_modifier", cas: "commit inconnu ou hors du dossier commun", depot: true, preparer: ({ t }) => { T.ouvrirTicket(t, { type: "bug", titre: "x", description: "y", auteur: "agent-01" }); }, args: { id: 1, etat: "ferme", commit: "deadbee" } },

  // depot_restaurer
  { outil: "depot_restaurer", cas: "chemin hors du dossier partagé", depot: true, args: { chemin: "../x.js", commit: "HEAD", raison: "r" } },
  { outil: "depot_restaurer", cas: "pancarte d'un autre", depot: true, preparer: ({ t }) => { T.reclamer(t, "agent-02", "a.js", "le moteur"); }, args: { chemin: "a.js", commit: "HEAD", raison: "r" } },
  { outil: "depot_restaurer", cas: "fichier qui n'est pas ta part", agent: "agent-02", env: { ESSAIM_ROLE: "constructeur" }, preparer: rolesEnBase({ "agent-01": "chef", "agent-02": "constructeur" }), args: { chemin: "a.js", commit: "HEAD", raison: "r" } },
  { outil: "depot_restaurer", cas: "commit inconnu", depot: true, args: { chemin: "a.js", commit: "deadbee", raison: "r" } },
  { outil: "depot_restaurer", cas: "fichier absent à ce commit", depot: true, args: { chemin: "b.js", commit: "HEAD", raison: "r" } },
  { outil: "depot_restaurer", cas: "lien symbolique à ce commit", depot: true,
    preparer: async (c) => { symlinkSync("a.js", join(c.partage, "lien.js")); await commiter(c, { "a.js": "a\n" }); }, args: { chemin: "lien.js", commit: "HEAD", raison: "r" } },
  { outil: "depot_restaurer", cas: "fichier actuel en lien symbolique", depot: true,
    preparer: async (c) => { await commiter(c, { "a.js": "a\n" }); rmSync(join(c.partage, "a.js")); symlinkSync(join(c.dossier, "cible"), join(c.partage, "a.js")); }, args: { chemin: "a.js", commit: "HEAD", raison: "r" } },
  { outil: "depot_restaurer", cas: "chemin qui sort par un lien", depot: true,
    preparer: async (c) => { await commiter(c, { "sous/a.js": "a\n" }); rmSync(join(c.partage, "sous"), { recursive: true }); mkdirSync(join(c.dossier, "dehors")); symlinkSync(join(c.dossier, "dehors"), join(c.partage, "sous")); },
    args: { chemin: "sous/a.js", commit: "HEAD", raison: "r" } },
  { outil: "depot_restaurer", cas: "dépôt du run remplacé", depot: true, preparer: depotRemplace, args: { chemin: "a.js", commit: "HEAD", raison: "r" } },
  // depot_journal
  { outil: "depot_journal", cas: "chemin hors du dossier partagé", depot: true, args: { chemin: "../x.js" } },

  // depot_essai
  { outil: "depot_essai", cas: "nom mal formé", depot: true, args: { nom: "Mal Formé", raison: "r" } },
  { outil: "depot_essai", cas: "nom déjà pris", depot: true, preparer: async (c) => { await D.ouvrirEssai(c.partage, c.essais, "x"); }, args: { nom: "x", raison: "r" } },
  { outil: "depot_essai", cas: "dépôt du run remplacé", depot: true, preparer: depotRemplace, args: { nom: "x", raison: "r" } },
  { outil: "depot_essai", cas: "ouvert par l'intégrateur quand un chef répartit (I1, 03/10)", depot: true, agent: "agent-02", env: { ESSAIM_ROLE: "integrateur" }, preparer: rolesEnBase({ "agent-01": "chef", "agent-02": "integrateur" }), args: { nom: "x", raison: "r" } },

  // depot_adopter
  { outil: "depot_adopter", cas: "essai inconnu", depot: true, args: { nom: "rien" } },
  { outil: "depot_adopter", cas: "dossier commun hors de main", depot: true,
    preparer: async (c) => { await essaiQuiChange(c); await D.git(c.partage, ["checkout", "-q", "-b", "autre"]); }, args: { nom: "x" } },
  { outil: "depot_adopter", cas: "essai sans changement", depot: true, preparer: async (c) => { await D.ouvrirEssai(c.partage, c.essais, "x"); }, args: { nom: "x" } },
  { outil: "depot_adopter", cas: "conflit", depot: true,
    preparer: async (c) => { await commiter(c, { "moteur.js": "commun\n" }); await essaiQuiChange(c); await commiter(c, { "moteur.js": "babylon\n" }); }, args: { nom: "x" } },
  { outil: "depot_adopter", cas: "changements pas encore commités", depot: true,
    preparer: async (c) => { await commiter(c, { "moteur.js": "commun\n" }); await essaiQuiChange(c); writeFileSync(join(c.partage, "moteur.js"), "en cours\n"); }, args: { nom: "x" } },
  { outil: "depot_adopter", cas: "dossier de l'essai remplacé", depot: true,
    preparer: async (c) => { const d = await essaiQuiChange(c); c.surs.set(d, -1); }, args: { nom: "x" } },
  { outil: "depot_adopter", cas: "dépôt du run remplacé", depot: true, preparer: depotRemplace, args: { nom: "x" } },
  { outil: "depot_adopter", cas: "fichier gelé par une révision", depot: true, env: { ESSAIM_ROLE: "integrateur" }, preparer: async (c) => { rolesEnBase({ "agent-01": "integrateur", "agent-02": "chef" })(c); await essaiQuiChange(c);
    c.t.run("INSERT INTO reclamations(chemin, agent, raison, pose_le) VALUES ('moteur.js', 'gel', '#1 gelé par la révision n°1', ?)", [new Date().toISOString()]); }, args: { nom: "x" } },
  { outil: "depot_adopter", cas: "adoption par un autre que l'intégrateur", env: { ESSAIM_ROLE: "constructeur" }, preparer: rolesEnBase({ "agent-01": "constructeur", "agent-02": "integrateur" }), args: { nom: "x" } },

  // page_voir, page_mesurer, page_comparer, page_assembler, code_tester, web_lire : un paramètre invalide est un refus.
  { outil: "page_voir", cas: "page hors du dossier partagé", args: { page: "../tableau.sqlite" } },
  { outil: "page_voir", cas: "page introuvable", args: { page: "absente.html" } },
  { outil: "page_mesurer", cas: "page introuvable", args: { page: "absente.html" } },
  { outil: "page_mesurer", cas: "taille illisible", preparer: ({ partage }) => writeFileSync(join(partage, "p.html"), "<p>x</p>"), args: { page: "p.html", taille: "grand" } },
  { outil: "page_comparer", cas: "capture introuvable", args: { avant: "a.png", apres: "b.png" } },
  { outil: "page_comparer", cas: "sortie non PNG", preparer: ({ partage }) => { writeFileSync(join(partage, "a.png"), "a"); writeFileSync(join(partage, "b.png"), "b"); }, args: { avant: "a.png", apres: "b.png", sortie: "diff.jpg" } },
  { outil: "page_assembler", cas: "chemins hors du dossier partagé", args: { source: "../ailleurs.html" } },
  { outil: "page_assembler", cas: "sortie égale à la source", args: { source: "index.html", sortie: "index.html" } },
  { outil: "page_assembler", cas: "source introuvable", args: { source: "src/page.html" } },
  { outil: "page_assembler", cas: "aucun script module", preparer: ({ partage }) => writeFileSync(join(partage, "vide.html"), "<p>rien</p>"), args: { source: "vide.html" } },
  { outil: "page_assembler", cas: "script hors du dossier partagé ou introuvable",
    preparer: ({ partage }) => writeFileSync(join(partage, "page.html"), '<script type="module" src="absent.js"></script>'), args: { source: "page.html" } },
  { outil: "page_assembler", cas: "script qui ne se rassemble pas", preparer: ({ partage }) => {
    writeFileSync(join(partage, "page.html"), '<script type="module" src="app.js"></script>');
    writeFileSync(join(partage, "app.js"), 'import { absent } from "./nulle-part.js";\nabsent();\n');
  }, args: { source: "page.html" } },
  { outil: "code_tester", cas: "fichier de tests introuvable", args: { fichier: "absent.test.ts" } },
  { outil: "web_lire", cas: "adresse illisible", args: { url: "pas une adresse" } },
  { outil: "web_lire", cas: "adresse ni https ni http", args: { url: "ftp://exemple.org/doc" } },

  // ticket_lire
  { outil: "ticket_lire", cas: "ticket inconnu", args: { id: 4 } },

  // exigence_ranger, exigence_contester (rôles des agents)
  { outil: "exigence_ranger", cas: "numéro de phrase inconnu", ...RANGER, args: { phrases: [9], classement: "contexte" } },
  { outil: "exigence_ranger", cas: "classement inconnu", ...RANGER, args: { phrases: [1], classement: "souhait" } },
  { outil: "exigence_ranger", cas: "phrase d'engagement", ...RANGER, preparer: (c: Contexte) => { RANGER.preparer(c); c.t.run("UPDATE phrases SET classement = 'engagement' WHERE n = 1"); }, args: { phrases: [1], classement: "contexte" } },
  { outil: "exigence_ranger", cas: "exigence sans responsable", ...RANGER, args: { phrases: [1], classement: "exigence" } },
  { outil: "exigence_ranger", cas: "contexte avec un responsable", ...RANGER, args: { phrases: [1], classement: "contexte", responsable: "recette" } },
  { outil: "exigence_ranger", cas: "responsable dont l'équipe n'a pas le siège", ...RANGER, args: { phrases: [1], classement: "exigence", responsable: "gardien" } },
  // Les jalons : E1 rangée sur la phrase 1, découpée selon le cas.
  { outil: "exigence_ranger", cas: "phrases d'une exigence découpée hors de la préparation", ...RANGER, preparer: (c: Contexte) => { jalonsEnBase(c); }, args: { phrases: [1], classement: "contexte" } },
  { outil: "exigence_jalonner", cas: "hors de la préparation et d'une révision", ...RANGER, preparer: (c: Contexte) => { e1EnBase(c); }, args: { exigence: "E1", jalons: ["a", "b"] } },
  { outil: "exigence_jalonner", cas: "révision : exigence rangée avant l'acceptation", ...RANGER, preparer: (c: Contexte) => { e1EnBase(c); c.t.run("UPDATE exigences SET cree_le = '2026-10-01T00:00:00Z'"); revisionEnBase(c.t, "acceptee"); }, args: { exigence: "E1", jalons: ["a", "b"] } },
  { outil: "exigence_jalonner", cas: "exigence inconnue", ...RANGER, preparer: (c: Contexte) => { e1EnBase(c); T.ouvrirPreparation(c.t); }, args: { exigence: "E9", jalons: ["a", "b"] } },
  { outil: "exigence_jalonner", cas: "un jalon", ...RANGER, preparer: (c: Contexte) => { jalonsEnBase(c); T.ouvrirPreparation(c.t); }, args: { exigence: "E1.1", jalons: ["a", "b"] } },
  { outil: "exigence_jalonner", cas: "moins de 2 portées", ...RANGER, preparer: (c: Contexte) => { e1EnBase(c); T.ouvrirPreparation(c.t); }, args: { exigence: "E1", jalons: ["a"] } },
  { outil: "exigence_jalonner", cas: "portée vide", ...RANGER, preparer: (c: Contexte) => { e1EnBase(c); T.ouvrirPreparation(c.t); }, args: { exigence: "E1", jalons: ["a", " "] } },
  { outil: "exigence_jalonner", cas: "deux portées identiques", ...RANGER, preparer: (c: Contexte) => { e1EnBase(c); T.ouvrirPreparation(c.t); }, args: { exigence: "E1", jalons: ["a", "a"] } },
  { outil: "plan_juger", cas: "découpage changé depuis la proposition", env: { ESSAIM_ROLE: "recette" }, preparer: (c) => { writeFileSync(join(c.partage, "SPEC.md"), "# Spec"); e1EnBase(c);
    T.proposerPlan(c.t, "agent-02", "s", "SPEC.md", "spec", { decoupage: T.empreinteDecoupage(c.t) }); T.jalonner(c.t, { parent: "E1", portees: ["a", "b"], par: "chef" }); }, args: { plan: 1, verdict: "valide", raison: "r" } },
  { outil: "exigence_contester", cas: "ni exigence ni phrases", ...CONTESTER, args: { raison: "x" } },
  { outil: "exigence_contester", cas: "exigence inconnue", ...CONTESTER, args: { exigence: "E9", raison: "x" } },
  { outil: "exigence_contester", cas: "numéro de phrase inconnu", ...CONTESTER, args: { phrases: [9], raison: "x" } },
  { outil: "exigence_contester", cas: "raison vide", ...CONTESTER, args: { phrases: [1], raison: " " } },

  // preuve_demander, preuve_attester, preuve_apprecier (rôles des agents)
  { outil: "preuve_demander", cas: "exigence inconnue", ...RECETTE, args: { exigence: "E9", commande: "true" } },
  { outil: "preuve_demander", cas: "exigence découpée", ...RECETTE, preparer: decoupeeEnBase, args: { exigence: "E1", commande: "true" } },
  { outil: "preuve_demander", cas: "commande vide", ...RECETTE, args: { exigence: "E1", commande: " " } },
  { outil: "preuve_demander", cas: "fichier du banc introuvable", ...RECETTE, args: { exigence: "E1", commande: "true", banc: ["absent.ts"] } },
  { outil: "preuve_demander", cas: "demande déjà en attente", ...RECETTE, depot: true, preparer: (c) => { preuvesEnBase()(c);
    T.demanderPreuve(c.t, { exigence: "E1", demandeur: "agent-01", commande: "true", graine: null, reproduction: { commande: "true", graine: null, commit: "0".repeat(40), banc: {}, monde: {} } }); }, args: { exigence: "E1", commande: "true" } },
  { outil: "preuve_attester", cas: "exigence inconnue", ...RECETTE, args: { exigence: "E9", recu: "1", portee: "x" } },
  { outil: "preuve_attester", cas: "exigence découpée", ...RECETTE, preparer: decoupeeEnBase, args: { exigence: "E1", recu: "1", portee: "x" } },
  { outil: "preuve_attester", cas: "exigence de l'autre siège de contrôle", ...RECETTE, args: { exigence: "E2", recu: "2", portee: "x" } },
  { outil: "preuve_attester", cas: "exigence déjà signée par un autre", ...RECETTE, preparer: (c) => { preuvesEnBase()(c); T.attester(c.t, { exigence: "E1", agent: "Rose", role: "recette", nature: "parcours", recu: "preuves/1.json", portee: "x" }); }, args: { exigence: "E1", recu: "1", portee: "x" } },
  { outil: "preuve_attester", cas: "ni reçu ni non_verifiee", ...RECETTE, args: { exigence: "E1", portee: "x" } },
  { outil: "preuve_attester", cas: "reçu et non_verifiee ensemble", ...RECETTE, args: { exigence: "E1", recu: "1", non_verifiee: true, portee: "x" } },
  { outil: "preuve_attester", cas: "reçu absent du registre", ...RECETTE, args: { exigence: "E1", recu: "9", portee: "x" } },
  { outil: "preuve_attester", cas: "reçu d'une autre exigence", ...RECETTE, args: { exigence: "E1", recu: "2", portee: "x" } },
  { outil: "preuve_attester", cas: "reçu qui ne passe pas", ...RECETTE, args: { exigence: "E1", recu: "3", portee: "x" } },
  { outil: "preuve_attester", cas: "reçu périmé", ...RECETTE, preparer: (c) => { preuvesEnBase()(c); writeFileSync(join(c.partage, "app.js"), "1\n"); }, args: { exigence: "E1", recu: "1", portee: "x" } },
  { outil: "preuve_attester", cas: "gardien dont le reçu n'utilise aucun fichier de son bureau privé", agent: "agent-02", env: { ESSAIM_ROLE: "gardien" },
    preparer: (c) => { preuvesEnBase()(c); mkdirSync(join(c.dossier, "agents", "agent-02", "prive"), { recursive: true }); }, args: { exigence: "E2", recu: "2", portee: "x" } },
  { outil: "preuve_attester", cas: "portée vide", ...RECETTE, args: { exigence: "E1", recu: "1", portee: " " } },
  { outil: "preuve_apprecier", cas: "exigence inconnue", ...RECETTE, args: { exigence: "E9", texte: "x", portee: "y" } },
  { outil: "preuve_apprecier", cas: "exigence découpée", ...RECETTE, preparer: decoupeeEnBase, args: { exigence: "E1", texte: "x", portee: "y" } },
  { outil: "preuve_apprecier", cas: "texte ou portée vide", ...RECETTE, args: { exigence: "E1", texte: "x", portee: " " } },

  // salle_chercher (second cerveau)
  { outil: "salle_chercher", cas: "ni mots, ni numéro, ni filtre", args: {} },
  { outil: "salle_chercher", cas: "plage de plus de 50 messages", args: { numero: 1, jusqua: 60 } },
  { outil: "salle_chercher", cas: "numéro avec un type autre que message ou fait", args: { numero: 1, type: "ticket" } },
  { outil: "salle_chercher", cas: "type inconnu", args: { mots: "carte", type: "tache" } },
  { outil: "salle_chercher", cas: "date illisible", args: { mots: "carte", depuis: "hier soir" } },
  { outil: "salle_chercher", cas: "avant qui n'est pas un nombre", args: { mots: "carte", avant: "message:61" } },
  { outil: "salle_chercher", cas: "aucun mot cherchable", args: { mots: "... !" } },
];

function instance(agent: string, ouvrir: (chemin: string) => T.Tableau = ouvrirBun) {
  process.env.ESSAIM_AGENT = agent;
  process.env.ESSAIM_TABLEAU = chemin;
  process.env.ESSAIM_PARTAGE = partage;
  const faux = fauxPi();
  extension(faux.api, ouvrir);
  return faux;
}

// Ce qu'un refus ne doit pas toucher : le tableau, et la branche main et les fichiers du dossier commun.
async function etat(): Promise<string> {
  const git = existsSync(join(partage, ".git"))
    ? [(await D.git(partage, ["rev-parse", "main"])).sortie, (await D.git(partage, ["status", "--porcelain"])).sortie] : null;
  return JSON.stringify({
    git,
    messages: t.all("SELECT id, texte FROM messages ORDER BY id"),
    tickets: t.all("SELECT * FROM tickets ORDER BY id"),
    notes: t.all("SELECT * FROM ticket_notes ORDER BY id"),
    pancartes: t.all("SELECT chemin, agent, retire_le FROM reclamations ORDER BY id"),
    presences: t.all("SELECT agent, fil_id FROM presences ORDER BY agent"),
    agents: t.all("SELECT nom, etat, sommeils FROM agents ORDER BY nom"),
    fils: t.all("SELECT nom, ouvert_le, ferme_le, conclusion FROM fils ORDER BY id"),
    exigences: [t.all("SELECT * FROM phrases ORDER BY n"), t.all("SELECT * FROM exigences ORDER BY libelle"), t.all("SELECT * FROM contestations ORDER BY id")],
    preuves: [t.all("SELECT * FROM demandes_rejeu ORDER BY id"), t.all("SELECT * FROM attestations ORDER BY id"), t.all("SELECT * FROM appreciations ORDER BY id")],
  });
}

let envAvant: Record<string, string | undefined> = {};
beforeEach(() => {
  envAvant = Object.fromEntries(["ESSAIM_TOUR_MS", "ESSAIM_LIVRABLE", "ESSAIM_AGENT", "ESSAIM_TABLEAU", "ESSAIM_PARTAGE", "ESSAIM_ROLE", "ESSAIM_CHANGEMENTS_SIEGE_MAX", "ESSAIM_SUPPLEANT_DE"].map((k) => [k, process.env[k]]));
  process.env.ESSAIM_TOUR_MS = "0";
  dossier = mkdtempSync(join(tmpdir(), "essaim-refus-"));
  chemin = join(dossier, "tableau.sqlite");
  partage = join(dossier, "partage");
  mkdirSync(partage);
  t = ouvrirBun(chemin);
  T.initialiser(t);
  T.ouvrirRun(t, { id: "run-test", missionChemin: "m.md", missionTexte: "texte", modele: "faux/faux", plafondUsd: 0.5, silenceMin: 15 });
  T.ajouterAgent(t, "agent-01", join(dossier, "agents", "agent-01"));
  T.ajouterAgent(t, "agent-02", join(dossier, "agents", "agent-02"));
});
afterEach(() => {
  for (const [k, v] of Object.entries(envAvant)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  t.fermer();
  rmSync(dossier, { recursive: true, force: true });
});

describe("T4 : la forme commune", () => {
  test("FORME accepte le fait puis la levée, et rien d'autre", () => {
    expect("refusé : message vide. Se lève avec un message non vide.").toMatch(FORME);
    expect("refusé une fois : ces tickets ouverts te sont confiés. Le même appel, tickets inchangés, est accepté.").toMatch(FORME);
    expect("refusé : cinq veilles déjà prises dans ce run. Définitif pour ce run.").toMatch(FORME);
    expect("refusé : message vide.").not.toMatch(FORME);
    expect("refusé : message vide. Écris un message.").not.toMatch(FORME);
    expect("occupé par agent-02 depuis 10:00").not.toMatch(FORME);
  });

  test("la coupure de contexte (se-resumer) : seul moi_resumer passe, levé après le résumé", async () => {
    process.env.ESSAIM_COMPACTAGE = "80000,120000,160000";
    try {
      const pi = fauxPi();
      seResumer(pi.api);
      pi.regler(161_000);
      const r = await pi.emettre("tool_call", { toolName: "salle_lire" }) as { block: boolean; reason: string };
      expect(r.block).toBe(true);
      expect(r.reason).toMatch(FORME);
      expect(r.reason).toBe("refusé : ton contexte fait 161k tokens, au-delà de la coupure (160k) ; seul moi_resumer passe. Se lève après le résumé.");
    } finally {
      delete process.env.ESSAIM_COMPACTAGE;
    }
  });
});

describe("T13 : chaque refus annoncé est provoqué, à la forme commune, sans effet", () => {
  for (const c of CAS) {
    test.skipIf(!!c.navigateur && cheminNavigateur() === undefined)(`${c.outil} : ${c.cas}`, async () => {
      Object.assign(process.env, c.env ?? {});
      const surs: D.Surs = new Map();
      let arreter = () => {};
      if (c.depot) {
        await D.ouvrirDepot(partage);
        surs.set(partage, D.identite(partage)!);
        arreter = D.servirDemandes(t, dossier, new D.FileGit(), surs, 20); // le rôle du lanceur
      }
      try {
        await c.preparer?.({ t, dossier, partage, essais: join(dossier, "essais"), surs });
        const pi = instance(c.agent ?? "agent-01", c.ouvrir);
        const avant = await etat();
        const r = await pi.appeler(c.outil, c.args) as { content: Array<{ text?: string }>; terminate?: boolean };
        const texte = r.content.map((x) => x.text ?? "").join("\n");
        expect(texte.split("\n")[0]!, texte).toMatch(FORME);
        expect(r.terminate).toBeFalsy();
        expect(await etat()).toBe(avant);
      } finally {
        arreter();
      }
    }, 30_000);
  }

  test("méta-test : autant de cas provoqués que de cas annoncés dans la ligne « Refus : » de chaque outil", () => {
    process.env.ESSAIM_COMPACTAGE = "80000,120000,160000";
    // Les outils des rôles sont comptés eux aussi ; chaque rôle n'a que les siens : l'union des sept (surveillant compris).
    try {
      const definitions = new Map<string, string>();
      for (const role of ["chef", "integrateur", "assembleur", "constructeur", "recette", "gardien", "surveillant"]) {
        process.env.ESSAIM_ROLE = role;
        const p = instance("agent-01");
        seResumer(p.api);
        for (const nom of p.noms()) definitions.set(nom, p.definition(nom)!.description);
      }
      const pi = { noms: () => [...definitions.keys()] };
      const ecarts: string[] = [];
      for (const nom of pi.noms()) {
        const d = definitions.get(nom)!;
        const i = d.indexOf("Refus : ");
        const annonces = i < 0 ? 0 : d.slice(i + "Refus : ".length).split(";").length;
        const provoques = CAS.filter((c) => c.outil === nom).length;
        if (annonces !== provoques) ecarts.push(`${nom} : ${annonces} annoncés, ${provoques} provoqués`);
      }
      for (const c of CAS) if (!pi.noms().includes(c.outil)) ecarts.push(`${c.outil} : pas un outil`);
      expect(ecarts).toEqual([]);
    } finally {
      delete process.env.ESSAIM_COMPACTAGE;
      delete process.env.ESSAIM_ROLE;
    }
  });

  test("un rappel se mémorise par lancement : le même appel passe, une relance de pi le refait (G2)", async () => {
    T.ouvrirTicket(t, { type: "bug", titre: "carte vide", description: "index.html", auteur: "agent-02", charge: "agent-01" });
    parle();
    const refus = await instance("agent-01").texte("moi_dormir", { message: "je dors" });
    expect(refus).toStartWith("refusé une fois : ");
    expect(refus.split("\n")[1]).toContain("#1 · bug");
    expect(await instance("agent-01").texte("moi_dormir", { message: "je dors" })).toStartWith("refusé une fois : "); // nouvelle instance : le même refus revient
  });

  test("les refus s'enchaînent : tickets confiés, puis ceux de la salle (G2)", async () => {
    T.ouvrirTicket(t, { type: "bug", titre: "carte vide", description: "index.html", auteur: "agent-02", charge: "agent-01" });
    T.ouvrirTicket(t, { type: "question", titre: "quel moteur ?", description: "three ?", auteur: "agent-02" });
    const pi = instance("agent-01");
    const un = await pi.texte("moi_finir", { raison: "fait" });
    expect(un).toStartWith("refusé une fois : ces tickets ouverts te sont confiés.");
    const deux = await pi.texte("moi_finir", { raison: "fait" });
    expect(deux.split("\n")[0]).toMatch(FORME);
    expect(deux).toStartWith("refusé une fois : des tickets restent ouverts dans la salle.");
    expect(deux).not.toContain("Tu peux");
    const r = await pi.appeler("moi_finir", { raison: "fait" }) as { terminate?: boolean };
    expect(r.terminate).toBe(true);
  });

  test("une panne du dépôt est une erreur d'outil, pas un refus (G6)", async () => {
    await D.ouvrirDepot(partage);
    const arreter = D.servirDemandes(t, dossier, new D.FileGit(), new Map([[partage, D.identite(partage)!]]), 20);
    try {
      mkdirSync(join(dossier, "essais"));
      writeFileSync(join(dossier, "essais", "bloque"), "un fichier à la place du dossier de l'essai");
      expect(instance("agent-01").appeler("depot_essai", { nom: "bloque", raison: "r" })).rejects.toThrow();
    } finally {
      arreter();
    }
  });

  test("un paramètre invalide est un refus, une panne reste une erreur d'outil : navigateur absent (G7)", async () => {
    writeFileSync(join(partage, "p.html"), "<p>x</p>");
    const pi = instance("agent-01");
    const avant = process.env.PLAYWRIGHT_BROWSERS_PATH;
    process.env.PLAYWRIGHT_BROWSERS_PATH = join(dossier, "cache-vide"); // plus de cache Playwright : le navigateur manque
    try {
      expect(pi.appeler("page_voir", { page: "p.html" })).rejects.toThrow("outil en panne");
      expect(pi.appeler("page_mesurer", { page: "p.html" })).rejects.toThrow("navigateur absent");
      expect((await pi.texte("page_voir", { page: "absente.html" })).split("\n")[0]).toMatch(FORME); // la page d'abord
    } finally {
      if (avant === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH; else process.env.PLAYWRIGHT_BROWSERS_PATH = avant;
    }
  });

  test("champ vide contre champ manquant : refus contre erreur de schéma (G7)", async () => {
    const pi = instance("agent-01");
    expect((await pi.texte("moi_dormir", { message: "" })).split("\n")[0]).toMatch(FORME);
    expect(pi.appeler("moi_dormir", {})).rejects.toThrow("Validation failed");
  });
});
