// Le surveillant : les signes S1 à S4, la grâce et
// les occurrences sur un tableau construit à la main, l'horloge passée en argument ; puis au faux pi, le réveil.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ouvrirBun } from "../src/tableau-bun.ts";
import * as T from "../src/tableau.ts";
import * as S from "../src/surveillant.ts";
import { appel, DORMIR, ecrireFixture } from "./aide/parcours.ts";
import { fauxPi } from "./aide/faux-extension-api.ts";
import extension from "../src/outils-essaim.ts";
import { etatDuRun } from "../src/lancer.ts";
import { refusDuRole } from "../src/roles.ts";

const MIN = 60_000;
let dossier: string;
let t: T.Tableau;
const maintenant = Date.parse("2026-10-03T12:00:00.000Z");
const il_y_a = (min: number) => new Date(maintenant - min * MIN).toISOString();

beforeEach(() => {
  dossier = mkdtempSync(join(tmpdir(), "essaim-surveillant-"));
  t = ouvrirBun(join(dossier, "tableau.sqlite"));
  T.initialiser(t);
  T.ouvrirRun(t, { id: "run", missionChemin: "m.md", missionTexte: "m", modele: "faux/faux", plafondUsd: 1, silenceMin: 15 });
  t.run("UPDATE run SET debut = ?", [il_y_a(300)]);
});
afterEach(() => { t.fermer(); rmSync(dossier, { recursive: true, force: true }); });

const exigence = (libelle: string) => t.run("INSERT INTO exigences(libelle, classement, responsable, range_par, cree_le) VALUES (?, 'exigence', 'recette', 'chef', ?)", [libelle, il_y_a(200)]);
const attester = (exigence: string, min: number, o: { revoquee?: boolean; nonVerifiee?: boolean } = {}) =>
  t.run("INSERT INTO attestations(exigence, agent, role, nature, recu, non_verifiee, portee, cree_le, revoquee_le) VALUES (?, 'Valentin', 'recette', 'parcours', ?, ?, 'p', ?, ?)",
    [exigence, o.nonVerifiee ? null : "preuves/1.json", o.nonVerifiee ? 1 : 0, il_y_a(min), o.revoquee ? il_y_a(1) : null]);
const planValide = (min: number) => t.run("INSERT INTO plans(auteur, resume, cree_le, etape, valide_le) VALUES ('Antoine', 'p', ?, 'plan', ?)", [il_y_a(min + 1), il_y_a(min)]);
const evenement = (type: string, min: number, resultat: string, agent = "lanceur") =>
  t.run("INSERT INTO evenements(agent, horodatage, type, resultat_resume) VALUES (?, ?, ?, ?)", [agent, il_y_a(min), type, resultat]);
const codes = (o: { livrable?: string; mesure?: S.MesureLivrable } = {}) => S.signes(t, { maintenantMs: maintenant, ...o }).map((x) => x.code);

describe("la grâce (D5, R6) : son origine et sa durée, hors pause", () => {
  test("origine : le dernier plan validé ; sans plan, la clôture de la préparation ; sans préparation, le début ; rien pendant la préparation", () => {
    expect(S.origineGrace(t)).toEqual({ le: il_y_a(300), revise: false });
    T.ouvrirPreparation(t);
    expect(S.origineGrace(t)).toBeUndefined();
    expect(S.signes(t, { maintenantMs: maintenant })).toEqual([]);
    T.clorePreparation(t, "close");
    evenement("plan", 100, "préparation close sans plan validé (45 min)");
    expect(S.origineGrace(t)).toEqual({ le: il_y_a(100), revise: false });
    planValide(80);
    expect(S.origineGrace(t)).toEqual({ le: il_y_a(80), revise: false });
  });
  test("60 min après le premier plan ; une pause ne compte pas", () => {
    planValide(59);
    expect(S.finDeGrace(t, maintenant)!.finie).toBe(false);
    t.run("DELETE FROM plans");
    planValide(61);
    expect(S.finDeGrace(t, maintenant)!.finie).toBe(true);
    evenement("pause", 50, "pause");
    evenement("reprise", 45, "reprise");
    expect(S.finDeGrace(t, maintenant)!.finie).toBe(false); // 61 − 5 = 56 min hors pause
  });
});

describe("les signes S1 à S4 (D7) : juste sous et juste au-dessus du seuil", () => {
  test("S1 : le livrable sans commit depuis 45 min ; muet sur mesure indisponible, rejeux en cours, exigences toutes attestées", () => {
    exigence("E1");
    expect(codes({ livrable: "texte.jsonl", mesure: { le: il_y_a(44) } })).not.toContain("S1");
    expect(codes({ livrable: "texte.jsonl", mesure: { le: il_y_a(46) } })).toContain("S1");
    expect(codes({ livrable: "texte.jsonl", mesure: { erreur: "git en panne" } })).not.toContain("S1");
    expect(codes({ livrable: "texte.jsonl" })).not.toContain("S1"); // pas encore lu
    t.run("INSERT INTO demandes_rejeu(exigence, commande, demandeur, etat, cree_le) VALUES ('E1', 'true', 'lanceur', 'attente', ?)", [il_y_a(1)]);
    expect(codes({ livrable: "texte.jsonl", mesure: { le: il_y_a(46) } })).not.toContain("S1");
    t.run("DELETE FROM demandes_rejeu");
    attester("E1", 100);
    expect(codes({ livrable: "texte.jsonl", mesure: { le: il_y_a(46) } })).not.toContain("S1");
  });
  test("S1 sans livrable : aucun essai adopté depuis 45 min", () => {
    t.run("INSERT INTO essais(nom, auteur, dossier, cree_le, adopte_le) VALUES ('e', 'Claude', 'd', ?, ?)", [il_y_a(50), il_y_a(44)]);
    expect(codes()).not.toContain("S1");
    t.run("UPDATE essais SET adopte_le = ?", [il_y_a(46)]);
    expect(codes()).toContain("S1");
  });
  test("S2 : trois rejeux échoués de la même exigence en 30 min", () => {
    evenement("rejeu_echoue", 10, "E3 n'est plus attestée : x");
    evenement("rejeu_echoue", 20, "E3 n'est plus attestée : x");
    evenement("rejeu_echoue", 25, "E4 n'est plus attestée : x");
    evenement("rejeu_echoue", 31, "E3 n'est plus attestée : x");
    expect(codes()).not.toContain("S2");
    evenement("rejeu_echoue", 29, "E3 n'est plus attestée : x");
    expect(S.signes(t, { maintenantMs: maintenant }).filter((x) => x.code === "S2").map((x) => x.cible)).toEqual(["E3"]);
  });
  test("S3 : deux tickets ouverts dans l'heure reprennent un ticket fermé dans l'heure, par exigence ou par chemin ; une note ne date pas une fermeture", () => {
    const ticket = (o: { exigence?: string; chemins?: string[]; cree: number; ferme?: number }) =>
      t.run("INSERT INTO tickets(type, titre, description, auteur, etat, cree_le, maj_le, chemins, exigence, ferme_le) VALUES ('bug', 't', 'd', 'Antoine', ?, ?, ?, ?, ?, ?)",
        [o.ferme === undefined ? "ouvert" : "ferme", il_y_a(o.cree), il_y_a(0), o.chemins ? JSON.stringify(o.chemins) : null, o.exigence ?? null, o.ferme === undefined ? null : il_y_a(o.ferme)]);
    ticket({ exigence: "E3", cree: 90, ferme: 70 }); // fermé il y a 70 min, noté à l'instant (maj_le) : hors fenêtre
    ticket({ exigence: "E3", cree: 30 });
    ticket({ exigence: "E3", cree: 20 });
    expect(codes()).not.toContain("S3");
    ticket({ exigence: "E3", cree: 80, ferme: 40 });
    expect(codes()).toContain("S3");
    t.run("DELETE FROM tickets");
    ticket({ chemins: ["fragments/"], cree: 90, ferme: 30 });
    ticket({ chemins: ["fragments/109-137.jsonl"], cree: 20 });
    expect(codes()).not.toContain("S3");
    ticket({ chemins: ["fragments/138-164.jsonl"], cree: 10 });
    expect(S.signes(t, { maintenantMs: maintenant }).find((x) => x.code === "S3")!.cible).toBe("fragments/");
  });
  test("S4 : 30 min sans première attestation valide ; une ré-attestation, une révocation, une déclaration non vérifiée ne comptent pas", () => {
    exigence("E1"); exigence("E2");
    planValide(200);
    attester("E1", 29);
    expect(codes()).not.toContain("S4");
    t.run("DELETE FROM attestations");
    attester("E1", 31);
    attester("E1", 5); // ré-attestation
    attester("E2", 10, { revoquee: true });
    attester("E2", 8, { nonVerifiee: true });
    expect(codes()).toContain("S4");
    t.run("DELETE FROM attestations");
    attester("E1", 31); attester("E2", 40);
    expect(codes()).not.toContain("S4"); // tout est attesté
  });
});

describe("les occurrences (§4.3) : une fois par allumage", () => {
  const s1 = (cible = "a"): S.Signe => ({ code: "S1", cible, texte: "S1 : x" });
  test("allumé : réveille une fois ; resté allumé, plus ; éteint puis rallumé, de nouveau ; consommé, plus ; réarmé pour un remplaçant", () => {
    const o = new S.Occurrences();
    expect(o.maj([s1()], 0, false)).toEqual([]); // pendant la grâce : mesuré, pas de réveil
    expect(o.maj([s1()], 1, true)).toHaveLength(1); // à la fin de la grâce, déjà allumé : réveille
    expect(o.maj([s1()], 2, true)).toEqual([]);
    expect(o.maj([], 3, true)).toEqual([]);
    expect(o.maj([s1()], 4, true)).toHaveLength(1);
    o.rearmer();
    expect(o.maj([s1()], 5, true)).toHaveLength(1);
    o.consommer();
    o.rearmer();
    expect(o.maj([s1()], 6, true)).toEqual([]);
    expect(o.nonConsommees()).toEqual([]);
  });
});

// Au faux pi : un run de type problème à cinq agents (Antoine chef, Bernard intégrateur, Claude et Denis constructeurs,
// Edmond gardien) et Fabien surveillant, en veille. Seuils réduits : S1 s'allume, Fabien seul est réveillé, une fois ; son
// mot au chef part en message de veille, qui ne réveille personne, et consomme le signe.
describe("au faux pi : le signe réveille le surveillant, et lui seul", () => {
  let racine: string;
  const ENV = ["ESSAIM_TOUR_MS", "ESSAIM_SIGNE_S1_MIN", "ESSAIM_SIGNE_TOUR_MS", "ESSAIM_GRACE_PREMIER_MIN", "ESSAIM_CHANGEMENTS_SIEGE_MAX"];
  const nettoyer = () => { for (const k of Object.keys(process.env)) if (k.startsWith("ESSAIM_FIXTURE")) delete process.env[k]; for (const k of ENV) delete process.env[k]; };
  beforeEach(() => { racine = mkdtempSync(join(tmpdir(), "essaim-surveillant-run-")); process.env.ESSAIM_PI = join(import.meta.dir, "faux-pi.ts"); nettoyer(); });
  afterEach(() => { rmSync(racine, { recursive: true, force: true }); nettoyer(); });

  test("S1 allumé : un seul message signé lanceur à Fabien, un réveil, et le mot au chef ne réveille personne", async () => {
    Object.assign(process.env, { ESSAIM_TOUR_MS: "0", ESSAIM_SIGNE_S1_MIN: "0.01", ESSAIM_SIGNE_TOUR_MS: "200", ESSAIM_GRACE_PREMIER_MIN: "0", ESSAIM_CHANGEMENTS_SIEGE_MAX: "0" });
    const ecrire = (nom: string, lignes: object[]) => ecrireFixture(racine, nom, lignes);
    process.env.ESSAIM_FIXTURE = ecrire("dort", DORMIR);
    process.env.ESSAIM_FIXTURE_CLAUDE = ecrire("occupe", [{ type: "faux:dormir", ms: 3000 }, ...DORMIR]); // la salle ne dort pas entière
    process.env.ESSAIM_FIXTURE_FABIEN = ecrire("surveille", [appel("d1", "moi_dormir", { message: "Antoine : S1 lu, pas de contradiction avec la spec" }), { type: "agent_end" }]);
    const mission = join(racine, "mission.md");
    writeFileSync(mission, "# Un calcul\n\nTrouver la somme.\n\n## Type\n\nprobleme\n\n## C'est fini quand\n\nLa somme est écrite.\n");
    const { lancer } = await import("../src/lancer.ts");
    const b = await lancer({ agents: 5, modele: "faux", plafond: 1, mission, racine, sansBacASable: true, preparation: false });
    const r = ouvrirBun(join(b.run, "tableau.sqlite"), { lectureSeule: true });
    const signes = r.all<{ resultat_resume: string }>("SELECT resultat_resume FROM evenements WHERE type = 'signe'").map((x) => x.resultat_resume);
    const messages = r.all<{ texte: string }>("SELECT texte FROM messages WHERE auteur = 'lanceur' AND texte LIKE 'Fabien : S1%'").map((x) => x.texte);
    const reveils = r.all<{ agent: string }>("SELECT agent FROM evenements WHERE type = 'reveil' AND resultat_resume LIKE 'réveillé par lanceur%'").map((x) => x.agent);
    const consommes = r.get<{ n: number }>("SELECT count(*) AS n FROM evenements WHERE type = ?", [S.CONSOMMES])!.n;
    const role = r.get<{ role: string }>("SELECT role FROM agents WHERE nom = 'Fabien'")!.role;
    r.fermer();
    expect(role).toBe("surveillant");
    expect(signes).toHaveLength(1);
    expect(signes[0]).toStartWith("Fabien réveillé : S1 : aucun essai adopté depuis ");
    expect(messages).toHaveLength(1);
    expect(messages[0]).not.toContain("?");
    expect(reveils).toEqual(["Fabien"]);
    expect(consommes).toBe(1);
  }, 30_000);
});

// La révision de bout en bout, au faux pi des outils : Antoine chef, Valentin recette, Xavier gardien, Claude
// constructeur, Yves surveillant. La spec et le plan de la préparation sont validés il y a deux heures.
describe("la révision (§5) : demande, refus, acceptation, spec et plan révisés, bornes", () => {
  let partage: string;
  const ENV = ["ESSAIM_AGENT", "ESSAIM_TABLEAU", "ESSAIM_PARTAGE", "ESSAIM_ROLE", "ESSAIM_TOUR_MS", "ESSAIM_LIVRABLE"];
  let avant: Record<string, string | undefined> = {};
  const ROLES: Record<string, string> = { Antoine: "chef", Valentin: "recette", Xavier: "gardien", Claude: "constructeur", Yves: "surveillant" };
  const outil = (agent: string, nom: string, args: object) => {
    Object.assign(process.env, { ESSAIM_AGENT: agent, ESSAIM_TABLEAU: join(dossier, "tableau.sqlite"), ESSAIM_PARTAGE: partage, ESSAIM_ROLE: ROLES[agent]!, ESSAIM_TOUR_MS: "0" });
    const pi = fauxPi();
    extension(pi.api, ouvrirBun);
    return pi.texte(nom, args);
  };
  const signe = () => t.run("INSERT INTO evenements(agent, horodatage, type, resultat_resume) VALUES ('lanceur', ?, 'signe', 'Yves réveillé : S4')", [new Date().toISOString()]);
  const ecrire = (f: string, x: string) => writeFileSync(join(partage, f), x);
  beforeEach(() => {
    avant = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    partage = join(dossier, "partage");
    require("node:fs").mkdirSync(partage);
    for (const [nom, role] of Object.entries(ROLES)) { T.ajouterAgent(t, nom, join(dossier, "agents", nom)); t.run("UPDATE agents SET role = ? WHERE nom = ?", [role, nom]); }
    t.run("UPDATE run SET debut = ?", [new Date(Date.now() - 3 * 3_600_000).toISOString()]);
    T.noterPhrases(t, [{ n: 1, section: "Mission", texte: "Un." }, { n: 2, section: "Mission", texte: "Deux." }]);
    T.rangerExigence(t, { phrases: [1], classement: "exigence", responsable: "recette", par: "Antoine" });
    T.rangerExigence(t, { phrases: [2], classement: "exigence", responsable: "gardien", par: "Antoine" });
    T.ouvrirTicket(t, { type: "amelioration", titre: "a", description: "d", auteur: "Antoine", charge: "Claude", chemins: ["a.js"] });
    T.ouvrirTicket(t, { type: "amelioration", titre: "b", description: "d", auteur: "Antoine", charge: "Claude", chemins: ["b.js"] });
    T.ouvrirTicket(t, { type: "bug", titre: "c", description: "d", auteur: "Valentin", charge: "Claude", sorte: "alerte", reproduction: { commande: "true", graine: null, commit: "0".repeat(40), banc: {}, monde: {} } });
    const deux = new Date(Date.now() - 2 * 3_600_000).toISOString();
    t.run("INSERT INTO plans(auteur, resume, fichier, cree_le, etape, valide_le) VALUES ('Antoine', 's', 'SPEC.md', ?, 'spec', ?), ('Antoine', 'p', 'PLAN.md', ?, 'plan', ?)", [deux, deux, deux, deux]);
  });
  afterEach(() => { for (const [k, v] of Object.entries(avant)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });

  test("refus puis acceptation ; spec révisée avec ses exigences rangées de nouveau ; plan révisé qui clôt la révision, une seule fois", async () => {
    expect(await outil("Yves", "revision_demander", { constat: "la spec suppose X ; le run mesure Y", tickets: [1] })).toStartWith("refusé : aucun signe du lanceur");
    signe();
    expect(await outil("Yves", "revision_demander", { constat: "la spec suppose X ; le run mesure Y", tickets: [3] })).toStartWith("refusé : le ticket #3 n'est pas un ticket de travail");
    expect(await outil("Yves", "revision_demander", { constat: "la spec suppose X ? le run mesure Y", tickets: [1, 2] })).toStartWith("révision n°1 demandée");
    const annonce = t.get<{ texte: string }>("SELECT texte FROM messages WHERE auteur = 'lanceur' ORDER BY id DESC LIMIT 1")!.texte;
    expect(annonce).toStartWith("Antoine, Xavier, Valentin : révision n°1 demandée par Yves.");
    expect(annonce).not.toContain("?");
    expect(await outil("Yves", "revision_demander", { constat: "encore", tickets: [] })).toStartWith("refusé : la révision n°1 est demandée");
    expect(await outil("Antoine", "revision_repondre", { accepte: false, raison: "la mesure vient d'un vieux registre" })).toStartWith("révision n°1 refusée");
    expect(await outil("Yves", "revision_demander", { constat: "la spec suppose X ; le run mesure Y", tickets: [1] })).toStartWith("refusé : aucun signe du lanceur"); // consommé par le refus
    signe();
    expect(await outil("Yves", "revision_demander", { constat: "la spec suppose X ; le run mesure Y", tickets: [1, 2] })).toStartWith("révision n°2 demandée");
    expect(await outil("Antoine", "revision_repondre", { accepte: true, raison: "fondé", tickets_geles: [1] })).toStartWith("révision n°2 acceptée");
    expect(S.lireRevision(t, 2)).toMatchObject({ etat: "acceptee", tickets_geles_json: "[1]" });
    // L'ancien plan n'est plus jugeable ; la spec se rouvre et déclare ses exigences changées.
    expect(await outil("Valentin", "plan_juger", { plan: 2, verdict: "valide", raison: "r" })).toStartWith("refusé : aucune version proposée");
    ecrire("SPEC.md", "# Spec révisée");
    expect(await outil("Antoine", "plan_proposer", { etape: "spec", resume: "révisée" })).toStartWith("refusé : pendant une révision, la spec déclare");
    expect(await outil("Antoine", "plan_proposer", { etape: "spec", resume: "révisée", exigences_changees: ["E1"] })).toStartWith("spec n°3 proposée");
    expect(await outil("Valentin", "plan_juger", { plan: 3, verdict: "valide", raison: "r" })).toContain("en attente");
    expect(await outil("Xavier", "plan_juger", { plan: 3, verdict: "valide", raison: "r" })).toContain("spec validée");
    ecrire("PLAN.md", "# Plan révisé");
    expect(await outil("Antoine", "plan_proposer", { etape: "plan", resume: "r", tickets_repris: [1] })).toStartWith("refusé : E1 est déclarée changée");
    T.rangerExigence(t, { phrases: [1], classement: "exigence", responsable: "recette", par: "Antoine" }); // E1 retirée, E3 la remplace
    expect(await outil("Antoine", "plan_proposer", { etape: "plan", resume: "r", tickets_repris: [2] })).toStartWith("refusé : le ticket #2 n'est pas gelé");
    expect(await outil("Antoine", "plan_proposer", { etape: "plan", resume: "r", tickets_repris: [1] })).toStartWith("plan n°4 proposé");
    await outil("Valentin", "plan_juger", { plan: 4, verdict: "valide", raison: "r" });
    expect(await outil("Xavier", "plan_juger", { plan: 4, verdict: "valide", raison: "r" })).toContain("la révision n°2 est close");
    expect(S.lireRevision(t, 2)).toMatchObject({ etat: "close", close_par: "plan" });
    expect(await outil("Xavier", "plan_juger", { plan: 4, verdict: "valide", raison: "encore" })).not.toContain("close"); // validée une fois
    expect(t.all("SELECT 1 FROM messages WHERE texte LIKE '[plan] plan n°4%'")).toHaveLength(1);
    expect(S.revisionsAcceptees(t)).toBe(1);
    expect(S.finDeGrace(t, Date.now())).toMatchObject({ finie: false }); // 30 min de grâce après le plan révisé
    // Deux acceptées : la troisième est refusée.
    t.run("INSERT INTO revisions(demandeur, constat, tickets_json, etat, cree_le) VALUES ('Yves', 'c', '[]', 'close', ?)", [new Date().toISOString()]);
    t.run("UPDATE plans SET valide_le = ? WHERE id = 4", [new Date(Date.now() - 3_600_000).toISOString()]);
    signe();
    expect(await outil("Yves", "revision_demander", { constat: "x", tickets: [] })).toStartWith("refusé : 2 révisions déjà acceptées");
  });

  // Ni une alerte ni le livrable ne se gèlent : la demande et la réponse refusent un ticket qui porte le livrable
  // de la mission, ou une alerte ; un ticket de travail hors du livrable passe.
  test("ni alerte ni livrable : refusés à la demande et à la réponse", async () => {
    process.env.ESSAIM_LIVRABLE = "texte.jsonl";
    T.ouvrirTicket(t, { type: "amelioration", titre: "l", description: "d", auteur: "Antoine", charge: "Claude", chemins: ["texte.jsonl"] });
    signe();
    const refus = "n'est pas un ticket de travail ouvert hors du livrable";
    expect(await outil("Yves", "revision_demander", { constat: "la spec suppose X ; le run mesure Y", tickets: [4] })).toContain(`le ticket #4 ${refus}`);
    expect(await outil("Yves", "revision_demander", { constat: "la spec suppose X ; le run mesure Y", tickets: [3] })).toContain(`le ticket #3 ${refus}`);
    expect(await outil("Yves", "revision_demander", { constat: "la spec suppose X ; le run mesure Y", tickets: [1] })).not.toContain("refusé");
    expect(await outil("Antoine", "revision_repondre", { accepte: true, raison: "r", tickets_geles: [4] })).toContain(`le ticket #4 ${refus}`);
    expect(T.lireTicket(t, 4)!.gele_le ?? null).toBeNull();
  });
  test("le lanceur : rappel à 15 min, expiration à 30 sans réponse ; acceptée sans plan, close à 45 min", () => {
    const equipe = Object.entries(ROLES).map(([nom, role]) => ({ nom, role }));
    S.demanderRevision(t, { demandeur: "Yves", constat: "c", tickets: [] });
    const m = Date.now();
    S.suivreRevision(t, m + 14 * MIN, equipe);
    expect(S.lireRevision(t, 1)!.rappel_le).toBeNull();
    S.suivreRevision(t, m + 16 * MIN, equipe);
    expect(S.lireRevision(t, 1)!.rappel_le).not.toBeNull();
    expect(t.get<{ texte: string }>("SELECT texte FROM messages ORDER BY id DESC LIMIT 1")!.texte).toStartWith("Antoine, Xavier, Valentin : rappel, la révision n°1");
    S.suivreRevision(t, m + 31 * MIN, equipe);
    expect(S.lireRevision(t, 1)!.etat).toBe("expiree");
    expect(S.revisionsAcceptees(t)).toBe(0);
    S.demanderRevision(t, { demandeur: "Yves", constat: "c", tickets: [] });
    S.repondreRevision(t, 2, { accepte: true, raison: "r", par: "Antoine", tickets: [] });
    S.suivreRevision(t, m + 44 * MIN, equipe);
    expect(S.lireRevision(t, 2)!.etat).toBe("acceptee");
    S.suivreRevision(t, m + 46 * MIN, equipe);
    expect(S.lireRevision(t, 2)).toMatchObject({ etat: "close", close_par: "delai" });
    expect(S.revisionsAcceptees(t)).toBe(1);
  });
});

// Le gel : les écritures et l'adoption bloquées sur un chemin gelé, le porteur disponible, repris ou annulé au plan
// révisé, tout rendu à la clôture par le délai ; ni alerte ni livrable.
describe("le gel (§5.5)", () => {
  const ticket = (chemins: string[], charge = "Claude") => T.ouvrirTicket(t, { type: "amelioration", titre: "x", description: "d", auteur: "Antoine", charge, chemins });
  const equipe = [{ nom: "Antoine", role: "chef" }, { nom: "Claude", role: "constructeur" }, { nom: "Bernard", role: "integrateur" }];
  const accepter = (ids: number[]) => {
    const r = S.demanderRevision(t, { demandeur: "Yves", constat: "c", tickets: ids });
    S.repondreRevision(t, r, { accepte: true, raison: "r", par: "Antoine", tickets: ids });
    S.annoncerGel(t, r, S.gelerTickets(t, r, ids));
    return r;
  };
  beforeEach(() => { for (const a of equipe) { T.ajouterAgent(t, a.nom, join(dossier, a.nom)); t.run("UPDATE agents SET role = ? WHERE nom = ?", [a.role, a.nom]); } });

  test("écrire, restaurer, adopter : refusés sur un chemin gelé ; le porteur compte disponible ; prévenu seul", () => {
    ticket(["a.js"]); ticket(["b.js"]);
    accepter([1]);
    const ctx = () => ({ agent: "Claude", equipe: equipe.map((a) => ({ ...a, present: true })), pancartes: T.reclamations(t) });
    expect(refusDuRole("constructeur", "write", { racine: "partage", rel: "a.js" }, ctx())).toBe("a.js appartient à un ticket gelé par la révision. Se lève au plan révisé");
    expect(refusDuRole("integrateur", "depot_restaurer", { racine: "partage", rel: "a.js" }, { ...ctx(), agent: "Bernard" })).toContain("gelé par la révision");
    expect(refusDuRole("integrateur", "depot_adopter", undefined, { ...ctx(), agent: "Bernard", essai: ["a.js", "c.js"] })).toContain("a.js appartient à un ticket gelé");
    expect(refusDuRole("constructeur", "write", { racine: "partage", rel: "b.js" }, ctx())).toBeUndefined();
    expect(T.chargeParPorteur(t, ["Claude"])).toEqual([{ nom: "Claude", tickets: 1 }]);
    expect(T.estActif(T.lireTicket(t, 1)!)).toBe(false);
    expect(t.get<{ texte: string }>("SELECT texte FROM messages WHERE texte LIKE 'Claude : ticket #1 gelé%'")).toBeDefined();
  });
  test("au plan révisé : repris, dégelé et rendu ; non repris, annulé ; à la clôture par le délai, tout est rendu", () => {
    ticket(["a.js"]); ticket(["b.js"]);
    const r = accepter([1, 2]);
    const plan = T.proposerPlan(t, "Antoine", "p", "PLAN.md", "plan", { revision: r, ticketsRepris: [1] });
    expect(S.resoudreGel(t, r, plan)).toBe(" Tickets repris : #1. Annulés, non repris par le plan révisé : #2.");
    expect(T.reclamations(t).map((p) => [p.chemin, p.agent])).toEqual([["a.js", "Claude"]]);
    expect(T.lireTicket(t, 2)).toMatchObject({ etat: "ferme", motif: "annule" });
    expect(T.estActif(T.lireTicket(t, 1)!)).toBe(true);
    ticket(["c.js"]);
    t.run("UPDATE revisions SET etat = 'close' WHERE id = ?", [r]);
    const r2 = accepter([3]);
    S.degelerTout(t, r2);
    expect(T.reclamations(t).map((p) => [p.chemin, p.agent])).toEqual([["a.js", "Claude"], ["c.js", "Claude"]]);
  });
});

// Une révision ouverte ne retient pas le run ; le jugement du lanceur ne lit pas les révisions.
describe("D9 : le run accepté pendant une révision", () => {
  test("sans exigence ni alerte, accepté avec une révision acceptée et pas close", () => {
    S.demanderRevision(t, { demandeur: "Yves", constat: "c", tickets: [] });
    S.repondreRevision(t, 1, { accepte: true, raison: "r", par: "Antoine", tickets: [] });
    expect(S.revisionEnCours(t)?.etat).toBe("acceptee");
    expect(etatDuRun(t, dossier, "absente").etat).toBe("accepte");
  });
});
