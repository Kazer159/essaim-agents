// La fin d'un run à rôles : « fini » n'est plus une déclaration d'agent, c'est un état
// constaté par le lanceur, accepté ou incomplet. Sur un tableau fabriqué (etatDuRun, le bilan), puis au faux pi : une
// alerte ouverte dans une salle endormie fait réveiller son porteur puis celui qui répartit ; le plafond donne incomplet ;
// les exigences toutes attestées donnent accepté et lèvent le refus de moi_finir du chef.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { etatDuRun, formaterBilan, lancer, type Bilan, type Options } from "../src/lancer.ts";
import { phrasesNumerotees } from "../src/mission.ts";
import * as P from "../src/preuves.ts";
import { ouvrirBun } from "../src/tableau-bun.ts";
import * as T from "../src/tableau.ts";
import { fauxPi } from "./aide/faux-extension-api.ts";
import { appel, DORMIR, ecrireFixture, fin } from "./aide/parcours.ts";
import extension from "../src/outils-essaim.ts";

const racineDepot = resolve(import.meta.dir, "..");
let racine: string;
const nettoyerEnv = () => { for (const k of Object.keys(process.env)) if (k.startsWith("ESSAIM_FIXTURE")) delete process.env[k]; for (const k of ["ESSAIM_TOUR_MS", "ESSAIM_GRACE_MS", "ESSAIM_ROLE", "ESSAIM_AGENT", "ESSAIM_TABLEAU", "ESSAIM_PARTAGE", "ESSAIM_BUREAU"]) delete process.env[k]; };
beforeEach(() => {
  racine = mkdtempSync(join(tmpdir(), "essaim-fin-"));
  process.env.ESSAIM_PI = join(racineDepot, "tests", "faux-pi.ts");
  nettoyerEnv();
});
afterEach(() => { rmSync(racine, { recursive: true, force: true }); nettoyerEnv(); });

// ---- etatDuRun et le bilan, sur un tableau fabriqué ---------------------------------------------------------------
describe("etatDuRun : accepté ou incomplet, et pourquoi", () => {
  let dossier: string, t: T.Tableau;
  const recu = (n: number, o: object = {}) => writeFileSync(join(dossier, "preuves", `${n}.json`), JSON.stringify({ n, demande: n, sorte: "exigence", exigence: "E1", demandeur: "Gaston",
    commande: "true", graine: null, commit: null, conditions: { banc: [], monde: [] }, empreintes: { banc: {}, monde: {}, produit: {} }, code: 0, sortie: "", dureeMs: 1, date: "", passe: true, texte: `preuves/${n}.json`, ...o }));
  const alerte = (o: { exigence?: string } = {}) => T.ouvrirTicket(t, { type: "bug", titre: "le compteur saute", description: "3 clics, 4", auteur: "Gaston", charge: "Claude", sorte: "alerte",
    reproduction: { commande: "false", graine: null, commit: "0".repeat(40), banc: {}, monde: {} }, ...o });
  beforeEach(() => {
    dossier = mkdtempSync(join(tmpdir(), "essaim-etat-run-"));
    mkdirSync(join(dossier, "partage"));
    mkdirSync(join(dossier, "preuves"));
    t = ouvrirBun(join(dossier, "tableau.sqlite"));
    T.initialiser(t);
    T.ouvrirRun(t, { id: "run-test", missionChemin: "m.md", missionTexte: "texte", modele: "faux/faux", plafondUsd: 0.5, silenceMin: 15 });
    for (const [nom, role] of [["Antoine", "chef"], ["Claude", "constructeur"], ["Gaston", "recette"], ["Hubert", "gardien"]])
      T.ajouterAgent(t, nom!, join(dossier, "agents", nom!), undefined, undefined, { role: role! });
  });
  afterEach(() => { t.fermer(); rmSync(dossier, { recursive: true, force: true }); });

  test("sans chef, sans alerte, vérification absente ou passée : accepté ; vérification en échec : incomplet", () => {
    expect(etatDuRun(t, dossier, "absente")).toEqual({ etat: "accepte", raisons: [], exigences: [], alertes: [] });
    expect(etatDuRun(t, dossier, "passe").etat).toBe("accepte");
    expect(etatDuRun(t, dossier, "echoue")).toMatchObject({ etat: "incomplet", raisons: ["la vérification de la mission ne passe pas"] });
  });

  test("une alerte ouverte : incomplet ; fermée par son reçu, plus rien ne retient", () => {
    const id = alerte();
    expect(etatDuRun(t, dossier, "passe")).toMatchObject({ etat: "incomplet", raisons: ["une alerte ouverte : #1"],
      alertes: [{ ticket: id, titre: "le compteur saute", charge: "Claude", exigence: null }] });
    t.run("UPDATE tickets SET etat = 'ferme', motif = 'corrige' WHERE id = ?", [id]);
    expect(etatDuRun(t, dossier, "passe").etat).toBe("accepte");
  });

  test("avec chef : phrases toutes rangées, chaque exigence attestée sur un reçu non périmé ; sinon ses raisons", () => {
    T.noterPhrases(t, [{ n: 1, section: "Mission", texte: "Un titre." }, { n: 2, section: "Mission", texte: "Trois clics affichent 3." }, { n: 3, section: "Mission", texte: "Contexte." }]);
    expect(etatDuRun(t, dossier, "passe")).toMatchObject({ etat: "incomplet", raisons: ["phrases de la mission pas encore rangées : 1, 2, 3", "aucune exigence rangée"] });
    T.rangerExigence(t, { phrases: [1], classement: "exigence", responsable: "recette", par: "Antoine" });
    T.rangerExigence(t, { phrases: [2], classement: "exigence", responsable: "gardien", par: "Antoine" });
    T.rangerExigence(t, { phrases: [3], classement: "contexte", par: "Antoine" });
    expect(etatDuRun(t, dossier, "passe")).toMatchObject({ etat: "incomplet", raisons: ["exigences non satisfaites : E1 (à prouver), E2 (à prouver)"],
      exigences: [{ libelle: "E1", etat: "à prouver", responsable: "recette" }, { libelle: "E2", etat: "à prouver", responsable: "gardien" }] });
    recu(1);
    T.attester(t, { exigence: "E1", agent: "Gaston", role: "recette", nature: "parcours", recu: "preuves/1.json", portee: "trois clics" });
    // Une exigence déclarée non vérifiée (ou tenue par un siège remplacé) n'est jamais acceptée.
    T.attester(t, { exigence: "E2", agent: "Hubert", role: "gardien", nature: "mesure", recu: null, portee: "pas d'horloge" });
    expect(etatDuRun(t, dossier, "passe")).toMatchObject({ etat: "incomplet", raisons: ["exigences non satisfaites : E2 (non vérifiée)"] });
    // la mesure du gardien repose sur un fichier de son bureau privé, comme preuve_attester l'exige (et le compte)
    mkdirSync(join(dossier, "agents", "Hubert", "prive"), { recursive: true });
    writeFileSync(join(dossier, "agents", "Hubert", "prive", "horloge.json"), "{}");
    recu(2, { exigence: "E2", commande: `cat ${join(dossier, "agents", "Hubert", "prive", "horloge.json")}` });
    T.revoquerSignatures(t, "Hubert");
    T.attester(t, { exigence: "E2", agent: "Hubert", role: "gardien", nature: "mesure", recu: "preuves/2.json", portee: "horloge à part" });
    expect(etatDuRun(t, dossier, "passe")).toEqual({ etat: "accepte", raisons: [], exigences: [], alertes: [] });
    // Le produit change : le banc n'a pas bougé, les reçus sont à rejouer par le lanceur ; en attendant, pas accepté.
    writeFileSync(join(dossier, "partage", "index.html"), "<p>3</p>");
    expect(etatDuRun(t, dossier, "passe")).toMatchObject({ etat: "incomplet", raisons: ["exigences non satisfaites : E1 (à rejouer), E2 (à rejouer)"] });
  });

  test("une alerte ouverte liée à une exigence attestée (tickets.exigence) : l'exigence n'est pas satisfaite", () => {
    T.noterPhrases(t, [{ n: 1, section: "Mission", texte: "Trois clics affichent 3." }]);
    T.rangerExigence(t, { phrases: [1], classement: "exigence", responsable: "recette", par: "Antoine" });
    recu(1);
    T.attester(t, { exigence: "E1", agent: "Gaston", role: "recette", nature: "parcours", recu: "preuves/1.json", portee: "trois clics" });
    alerte({ exigence: "E1" });
    expect(T.lireTicket(t, 1)!.exigence).toBe("E1");
    expect(etatDuRun(t, dossier, "passe")).toMatchObject({ etat: "incomplet", raisons: ["une alerte ouverte : #1", "exigences non satisfaites : E1 (alerte #1 ouverte)"],
      exigences: [{ libelle: "E1", etat: "attestée", responsable: "recette", alertes: [1] }], alertes: [{ ticket: 1, exigence: "E1" }] });
  });

  test("ticket_ouvrir lie une alerte à une exigence active ; l'annonce et la liste la citent", async () => {
    T.noterPhrases(t, [{ n: 1, section: "Mission", texte: "Trois clics affichent 3." }]);
    T.rangerExigence(t, { phrases: [1], classement: "exigence", responsable: "recette", par: "Antoine" });
    const partage = join(dossier, "partage");
    const D = await import("../src/depot.ts");
    await D.ouvrirDepot(partage);
    Object.assign(process.env, { ESSAIM_AGENT: "Gaston", ESSAIM_TABLEAU: join(dossier, "tableau.sqlite"), ESSAIM_PARTAGE: partage, ESSAIM_BUREAU: join(dossier, "agents", "Gaston"), ESSAIM_ROLE: "recette", ESSAIM_TOUR_MS: "0" });
    mkdirSync(join(dossier, "agents", "Gaston"), { recursive: true });
    const pi = fauxPi();
    extension(pi.api, ouvrirBun);
    expect(await pi.texte("ticket_ouvrir", { type: "bug", titre: "4 au lieu de 3", description: "trois clics", charge: "Claude", sorte: "alerte", reproduction: { commande: "false" }, exigence: "E1" }))
      .toBe("ticket #1 ouvert, posté dans le fil tickets");
    expect(T.lireTicket(t, 1)!.exigence).toBe("E1");
    expect(t.get<{ texte: string }>("SELECT texte FROM messages ORDER BY id DESC LIMIT 1")!.texte).toStartWith("[ticket #1 · alerte sur E1 · bug] 4 au lieu de 3");
    expect(await pi.texte("ticket_lister", {})).toStartWith("#1 · alerte sur E1 · bug · ouvert");
  });

  test("formaterBilan : l'état du run, ses raisons, les exigences non satisfaites, les alertes ouvertes, les rejeux clos, les réveils", () => {
    const b: Bilan = { finis: 1, vires: 2, perdus: 0, depense: 0.5, plafond: 1, depassement: 0, run: "/tmp/r", etat: "incomplet", raisonsEtat: ["salle endormie", "une alerte ouverte : #3"],
      exigencesNonSatisfaites: [{ libelle: "E1", etat: "à prouver", responsable: "recette" }, { libelle: "E2", etat: "attestée", responsable: "gardien", alertes: [3] }],
      alertesOuvertes: [{ ticket: 3, titre: "le compteur saute", charge: "Claude", exigence: "E2" }], rejeuxSansObjet: [4], reveils: { Claude: 2, Antoine: 1 } };
    const texte = formaterBilan(b);
    expect(texte).toContain("\nrun incomplet : salle endormie ; une alerte ouverte : #3");
    expect(texte).toContain("\nexigences non satisfaites : E1 (à prouver), E2 (alerte #3 ouverte)");
    expect(texte).toContain("\nalertes ouvertes : #3 « le compteur saute » (Claude)");
    expect(texte).toContain("\ndemandes de rejeu closes sans reçu à la fermeture : #4");
    expect(texte).toContain("\nréveils : Claude 2, Antoine 1");
    expect(formaterBilan({ ...b, etat: "accepte", raisonsEtat: undefined, exigencesNonSatisfaites: undefined, alertesOuvertes: undefined, rejeuxSansObjet: undefined, reveils: undefined }))
      .toContain("\nrun accepté");
  });

  test("abandonnerRejeux : les demandes encore en file sont closes sans reçu, avec la raison", () => {
    T.noterPhrases(t, [{ n: 1, section: "Mission", texte: "Un titre." }]);
    T.rangerExigence(t, { phrases: [1], classement: "exigence", responsable: "recette", par: "Antoine" });
    const r = { commande: "true", graine: null, commit: "0".repeat(40), banc: {}, monde: {} };
    const d = T.demanderPreuve(t, { exigence: "E1", demandeur: "Gaston", commande: "true", graine: null, reproduction: r });
    expect(T.abandonnerRejeux(t, "run accepté et fermé avant ce rejeu")).toEqual([(d as { id: number }).id]);
    expect(T.reponseRejeu(t, 1)).toEqual({ recu: null, resultat: { abandon: "run accepté et fermé avant ce rejeu", texte: "sans reçu : run accepté et fermé avant ce rejeu" } });
    expect(T.abandonnerRejeux(t, "x")).toEqual([]);
  });

  test("le reçu d'une preuve nomme son demandeur quand il dort (sinon il dort pour rien), et seulement alors", () => {
    T.noterPhrases(t, [{ n: 1, section: "Mission", texte: "Un titre." }]);
    T.rangerExigence(t, { phrases: [1], classement: "exigence", responsable: "recette", par: "Antoine" });
    const r = { commande: "true", graine: null, commit: "0".repeat(40), banc: {}, monde: {} };
    const conclureUne = () => {
      T.demanderPreuve(t, { exigence: "E1", demandeur: "Gaston", commande: "true", graine: null, reproduction: r });
      const [d] = T.prendreRejeux(t);
      recu(d!.id);
      P.conclure(t, d!, P.lireRecu(dossier, String(d!.id))!);
    };
    conclureUne(); // Gaston est actif : preuve_demander lui rend le reçu
    expect(t.get<{ n: number }>("SELECT count(*) AS n FROM messages")!.n).toBe(0);
    T.endormir(t, "Gaston");
    conclureUne();
    const m = t.get<{ auteur: string; texte: string }>("SELECT auteur, texte FROM messages")!;
    expect(m).toEqual({ auteur: "essaim", texte: "[preuve de E1] reçu preuves/2.json (demandée par Gaston)" });
    expect(T.appelDormeur(t, "Gaston", ["Gaston"])?.id).toBeDefined();
  });
});

// ---- Au faux pi --------------------------------------------------------------------------------------------------
const ecrire = (nom: string, lignes: object[]) => ecrireFixture(racine, nom, lignes);
const mission = (type: string, extra = "") => {
  const p = join(racine, `mission-${type}.md`);
  writeFileSync(p, `# Un compteur\n\nUne page avec un bouton qui compte les clics.\n\n## Type\n\n${type}\n\n## C'est fini quand\n\nTrois clics affichent 3.\n${extra}`);
  return p;
};
const base = (): Options => ({ agents: 5, modele: "faux", plafond: 1, mission: mission("jeu"), racine, sansBacASable: true });
const lire = (run: string) => ouvrirBun(join(run, "tableau.sqlite"), { lectureSeule: true });

describe("au faux pi : la salle endormie avec une alerte, le plafond, l'acceptation", () => {
  // Type jeu : Antoine intégrateur (qui répartit), Bernard, Claude, Denis constructeurs, Edmond recette. Edmond ouvre une
  // alerte confiée à Claude, puis tout le monde dort : le lanceur nomme Claude, qui se rendort ; puis Antoine, qui se
  // rendort ; plus personne à nommer : le run est incomplet, et les dormeurs sont virés, pas « finis ».
  test("alerte ouverte, salle endormie : réveil du porteur, puis de celui qui répartit, puis incomplet", async () => {
    process.env.ESSAIM_TOUR_MS = "0";
    process.env.ESSAIM_FIXTURE = ecrire("dort", DORMIR);
    process.env.ESSAIM_FIXTURE_EDMOND = ecrire("alerte", [
      appel("a1", "ticket_ouvrir", { type: "bug", titre: "le compteur saute", description: "3 clics, 4", charge: "Claude", sorte: "alerte", reproduction: { commande: "false" } }),
      ...DORMIR]);
    const b = await lancer(base());
    expect(b).toMatchObject({ etat: "incomplet", finis: 0, vires: 5, endormis: 5 });
    expect(b.raisonsEtat![0]).toBe("salle endormie, alerte ouverte #1 sans personne pour la traiter");
    expect(b.alertesOuvertes).toEqual([{ ticket: 1, titre: "le compteur saute", charge: "Claude", exigence: null }]);
    expect(b.reveils).toEqual({ Claude: 2, Antoine: 1 }); // Claude : l'annonce de l'alerte le nomme, puis le lanceur
    expect(existsSync(join(b.run, "accepte"))).toBe(false);
    const t = lire(b.run);
    const appels = t.all<{ auteur: string; texte: string }>("SELECT auteur, texte FROM messages WHERE auteur = 'essaim' ORDER BY id");
    const reveils = t.all<{ agent: string; resultat_resume: string }>("SELECT agent, resultat_resume FROM evenements WHERE type = 'reveil' ORDER BY id");
    const sorties = t.all<{ nom: string; etat: string; raison_sortie: string }>("SELECT nom, etat, raison_sortie FROM agents ORDER BY rowid");
    t.fermer();
    expect(appels).toEqual([
      { auteur: "essaim", texte: "Claude : toute la salle dort et l'alerte #1 « le compteur saute » est ouverte." },
      { auteur: "essaim", texte: "Antoine : toute la salle dort et l'alerte #1 « le compteur saute » est ouverte." }]);
    expect(reveils.map((r) => r.agent)).toEqual(["Claude", "Claude", "Antoine"]);
    expect(reveils[0]!.resultat_resume).toStartWith("réveillé par Edmond");
    expect(reveils[1]!.resultat_resume).toStartWith("réveillé par essaim");
    expect(reveils[2]!.resultat_resume).toStartWith("réveillé par essaim");
    for (const s of sorties) expect([s.etat, s.raison_sortie]).toEqual(["vire", "run incomplet : salle endormie, alerte ouverte #1 sans personne pour la traiter"]);
    expect(formaterBilan(b)).toContain("\nrun incomplet : salle endormie, alerte ouverte #1 sans personne pour la traiter");
  }, 30_000);

  test("salle endormie sans alerte, dans un run qui n'est pas acceptable : incomplet, dormeurs virés", async () => {
    process.env.ESSAIM_TOUR_MS = "0";
    process.env.ESSAIM_FIXTURE = ecrire("dort", DORMIR);
    const b = await lancer({ ...base(), mission: mission("jeu", "\n## Vérification\n\nfalse\n") });
    expect(b).toMatchObject({ etat: "incomplet", finis: 0, vires: 5, endormis: 5 });
    expect(b.raisonsEtat).toEqual(["salle endormie", "la vérification de la mission ne passe pas"]);
    const t = lire(b.run);
    expect(t.all<{ n: number }>("SELECT count(*) AS n FROM evenements WHERE type = 'jugement'")[0]!.n).toBeGreaterThan(0); // la vérification a été jouée en cours de run
    t.fermer();
  }, 30_000);

  test("salle endormie, run acceptable (jeu : alertes fermées, vérification qui passe) : accepté, chacun fini", async () => {
    process.env.ESSAIM_TOUR_MS = "0";
    process.env.ESSAIM_FIXTURE = ecrire("dort", DORMIR);
    const b = await lancer({ ...base(), mission: mission("jeu", "\n## Vérification\n\ntrue\n") });
    expect(b).toMatchObject({ etat: "accepte", finis: 5, vires: 0 });
    expect(b.endormis).toBeUndefined();
    expect(existsSync(join(b.run, "accepte"))).toBe(true);
    expect(formaterBilan(b)).toContain("\nrun accepté");
    const t = lire(b.run);
    expect(t.all<{ raison_sortie: string }>("SELECT DISTINCT raison_sortie FROM agents")).toEqual([{ raison_sortie: "run accepté, constaté par le lanceur" }]);
    t.fermer();
  }, 30_000);

  test("plafond : incomplet, la première raison le dit", async () => {
    process.env.ESSAIM_TOUR_MS = "0";
    process.env.ESSAIM_FIXTURE = ecrire("cher", [{ type: "message_end", message: { role: "assistant", stopReason: "stop", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.3 } } } },
      { type: "faux:dormir", ms: 6000 }, fin]);
    const b = await lancer(base());
    expect(b).toMatchObject({ etat: "incomplet", vires: 5 });
    expect(b.raisonsEtat![0]).toBe("plafond atteint");
  }, 30_000);

  // Type application (8 sièges) : Antoine chef range toutes les phrases de la mission en une exigence E1, tenue par la
  // recette (Gaston) ; Gaston demande la preuve au lanceur, l'atteste, puis part. Le lanceur constate le run accepté :
  // le fichier accepte est écrit (il lève le refus de moi_finir du chef), et le chef et l'intégrateur sont sortis finis.
  test("toutes les exigences attestées : accepté, fichier accepte, refus de moi_finir du chef levé", async () => {
    process.env.ESSAIM_TOUR_MS = "0";
    const m = mission("application");
    const phrases = phrasesNumerotees(readFileSync(m, "utf8")).map((p) => p.n);
    process.env.ESSAIM_FIXTURE = ecrire("fini", [appel("f1", "moi_finir", { raison: "ma part est faite" }), fin]);
    process.env.ESSAIM_FIXTURE_ANTOINE = ecrire("chef", [appel("r1", "exigence_ranger", { phrases, classement: "exigence", responsable: "recette" }),
      { type: "faux:toucher", chemin: "{RUN}/range" }, ...DORMIR]);
    process.env.ESSAIM_FIXTURE_BERNARD = ecrire("integrateur", DORMIR);
    process.env.ESSAIM_FIXTURE_GASTON = ecrire("recette", [{ type: "faux:attendre", chemin: "{RUN}/range" },
      appel("p1", "preuve_demander", { exigence: "E1", commande: "true" }),
      appel("p2", "preuve_attester", { exigence: "E1", recu: "1", portee: "la commande passe" }),
      { type: "faux:dormir", ms: 3000 }, fin]);
    const b = await lancer({ ...base(), agents: 8, mission: m });
    expect(b.etat).toBe("accepte");
    expect(b.exigencesNonSatisfaites).toBeUndefined();
    expect(existsSync(join(b.run, "accepte"))).toBe(true);
    const t = lire(b.run);
    const etats = Object.fromEntries(t.all<{ nom: string; etat: string; raison_sortie: string }>("SELECT nom, etat, raison_sortie FROM agents").map((a) => [a.nom, [a.etat, a.raison_sortie]]));
    expect(t.get<{ resultat_resume: string }>("SELECT resultat_resume FROM evenements WHERE type = 'constat'")!.resultat_resume).toStartWith("run accepté");
    t.fermer();
    expect(etats.Antoine).toEqual(["fini", "run accepté, constaté par le lanceur"]);
    expect(etats.Bernard).toEqual(["fini", "run accepté, constaté par le lanceur"]);
    expect(etats.Gaston![0]).toBe("fini");
    // Le refus de moi_finir du chef se lève sur le fichier accepte (l'extension le lit).
    Object.assign(process.env, { ESSAIM_AGENT: "Antoine", ESSAIM_TABLEAU: join(b.run, "tableau.sqlite"), ESSAIM_PARTAGE: join(b.run, "partage"), ESSAIM_BUREAU: join(b.run, "agents", "Antoine"), ESSAIM_ROLE: "chef" });
    const pi = fauxPi();
    extension(pi.api, ouvrirBun);
    expect(await pi.texte("moi_finir", { raison: "fait" })).not.toContain("reste jusqu'à la fin du run");
    rmSync(join(b.run, "accepte"));
    expect(await fauxPiChef(b.run)).toContain("le chef reste jusqu'à la fin du run");
  }, 30_000);
});

// Au faux pi, type application : Gaston (recette) prouve E1 (« compteur.txt dit 3 ») et s'endort ; puis les autres
// sièges écrivent dans le partage et partent. La ## Vérification attend AUDITS/fin.md, pour que le lanceur ne juge pas le
// run avant ces écritures. Une note sans rapport : le lanceur rejoue le reçu, l'attestation se reporte, accepté. Le
// compteur changé : le rejeu échoue, E1 n'est plus attestée, incomplet, et la raison le dit.
describe("au faux pi : le lanceur rejoue les reçus attestés (O6)", () => {
  const parcours = async (ecritures: object[]) => {
    process.env.ESSAIM_TOUR_MS = "0";
    const m = mission("application", "\n## Vérification\n\ntest -f AUDITS/fin.md\n");
    const phrases = phrasesNumerotees(readFileSync(m, "utf8")).map((p) => p.n);
    process.env.ESSAIM_FIXTURE = ecrire("autres", [{ type: "faux:attendre", chemin: "{RUN}/atteste" }, ...ecritures,
      { type: "faux:ecrire", chemin: "{PARTAGE}/AUDITS/fin.md", contenu: "fin\n" }, appel("f1", "moi_finir", { raison: "ma part est faite" }), fin]);
    process.env.ESSAIM_FIXTURE_ANTOINE = ecrire("chef", [appel("r1", "exigence_ranger", { phrases, classement: "exigence", responsable: "recette" }),
      { type: "faux:toucher", chemin: "{RUN}/range" }, ...DORMIR]);
    process.env.ESSAIM_FIXTURE_BERNARD = ecrire("integrateur", DORMIR);
    process.env.ESSAIM_FIXTURE_GASTON = ecrire("recette", [{ type: "faux:attendre", chemin: "{RUN}/range" },
      { type: "faux:ecrire", chemin: "{PARTAGE}/compteur.txt", contenu: "3\n" },
      appel("p1", "preuve_demander", { exigence: "E1", commande: "grep -qx 3 compteur.txt", graine: "1" }),
      appel("p2", "preuve_attester", { exigence: "E1", recu: "1", portee: "le compteur dit 3" }),
      // La recette reste jusqu'au constat ; elle s'endort avant que les autres écrivent. Réveillée par un rejeu
      // échoué (deuxième passe), elle se rendort sans rien prouver de nouveau.
      { type: "faux:toucher", chemin: "{RUN}/atteste" }, appel("d1", "moi_dormir", { message: "E1 attestée", attend: "le constat du lanceur" }), fin]);
    process.env.ESSAIM_FIXTURE_GASTON_PASSE_2 = ecrire("recette-2", DORMIR);
    const b = await lancer({ ...base(), agents: 8, mission: m });
    const t = lire(b.run);
    const r = { b, attestation: T.attestationDe(t, "E1"), recus: t.all<{ id: number; rejoue: string | null; recu: string | null }>("SELECT id, rejoue, recu FROM demandes_rejeu ORDER BY id"),
      report: t.get<{ resultat_resume: string }>("SELECT resultat_resume FROM evenements WHERE type = 'report'")?.resultat_resume,
      pourGaston: t.get<{ texte: string }>("SELECT texte FROM messages WHERE auteur = 'essaim' AND texte LIKE 'Gaston : %'")?.texte,
      reveilsGaston: t.get<{ n: number }>("SELECT count(*) AS n FROM evenements WHERE agent = 'Gaston' AND type = 'reveil'")!.n };
    t.fermer();
    return r;
  };

  test("une note sans rapport change dans le partage : rejeu du lanceur, attestation reportée, run accepté", async () => {
    const r = await parcours([{ type: "faux:ecrire", chemin: "{PARTAGE}/AUDITS/page.md", contenu: "la page est lisible\n" }]);
    expect(r.b.etat).toBe("accepte");
    expect(r.recus).toEqual([{ id: 1, rejoue: null, recu: "preuves/1.json" }, { id: 2, rejoue: "preuves/1.json", recu: "preuves/2.json" }]); // un seul rejeu
    expect(r.attestation).toMatchObject({ agent: "Gaston", recu: "preuves/2.json", portee: "le compteur dit 3" });
    expect(r.report).toBe("E1 : attestation de Gaston reportée de preuves/1.json sur preuves/2.json, rejoué par le lanceur ; changé depuis : produit AUDITS/fin.md, produit AUDITS/page.md");
    expect(JSON.parse(readFileSync(join(r.b.run, "preuves", "2.json"), "utf8"))).toMatchObject({ demandeur: "lanceur", graine: "1", passe: true, rejoue: "preuves/1.json" });
  }, 30_000);

  test("un changement du produit casse la vérification de E1 : rejeu échoué, E1 plus attestée, run incomplet qui dit pourquoi", async () => {
    const r = await parcours([{ type: "faux:ecrire", chemin: "{PARTAGE}/compteur.txt", contenu: "4\n" }]);
    expect(r.b.etat).toBe("incomplet");
    expect(r.recus).toHaveLength(2);
    expect(r.attestation!.recu).toBe("preuves/1.json");
    expect(r.b.exigencesNonSatisfaites).toHaveLength(1);
    expect(r.b.exigencesNonSatisfaites![0]!.etat).toStartWith("rejeu échoué : preuves/2.json · ne passe pas (code 1)");
    expect(r.b.exigencesNonSatisfaites![0]!.etat).toEndWith("changé depuis preuves/1.json : produit AUDITS/fin.md, produit compteur.txt");
    expect(r.b.raisonsEtat!.some((x) => x.startsWith("exigences non satisfaites : E1 (rejeu échoué : preuves/2.json"))).toBe(true);
    expect(r.pourGaston).toStartWith("Gaston : E1 n'est plus attestée. Le lanceur a rejoué preuves/1.json");
    expect(r.reveilsGaston).toBeGreaterThan(0); // resté en veille, le message du lanceur l'a réveillé
    expect(r.report).toBeUndefined();
  }, 30_000);
});

async function fauxPiChef(run: string): Promise<string> {
  process.env.ESSAIM_TABLEAU = join(run, "tableau.sqlite");
  const pi = fauxPi();
  extension(pi.api, ouvrirBun);
  return pi.texte("moi_finir", { raison: "fait" });
}

// ---- Les leçons : proposées en partant, archivées dans le bilan, jamais relues ----------
describe("les leçons proposées, archivées dans le bilan", () => {
  test("moi_finir(lecons) dans un run à rôles : bilan.lecons et la section du bilan ; textes vides ignorés", async () => {
    process.env.ESSAIM_TOUR_MS = "0";
    process.env.ESSAIM_FIXTURE = ecrire("lecon", [appel("f1", "moi_finir", { raison: "fait", lecons: ["un compteur se teste en cliquant trois fois", "  "] }), fin]);
    const b = await lancer({ ...base(), agents: 1, mission: mission("fichier") });
    expect(b.etat).toBe("accepte");
    expect(b.lecons).toEqual([{ agent: "Antoine", role: "constructeur", date: expect.any(String), texte: "un compteur se teste en cliquant trois fois" }]);
    expect(formaterBilan(b)).toContain("\nleçons proposées (archivées, jamais relues par un autre run) :\n- Antoine (constructeur) : un compteur se teste en cliquant trois fois");
    const t = lire(b.run);
    expect(t.get("SELECT agent, role, run, texte, remplacee_par FROM lecons")).toEqual({ agent: "Antoine", role: "constructeur", run: b.run.split("/runs/")[1]!, texte: "un compteur se teste en cliquant trois fois", remplacee_par: null });
    t.fermer();
  }, 30_000);

  test("moi_passation(lecons) les garde aussi ; sans rôles, moi_finir n'a pas de paramètre lecons", async () => {
    const dossier = mkdtempSync(join(tmpdir(), "essaim-lecons-"));
    try {
      mkdirSync(join(dossier, "partage"));
      const t = ouvrirBun(join(dossier, "tableau.sqlite"));
      T.initialiser(t);
      T.ouvrirRun(t, { id: "run-x", missionChemin: "m.md", missionTexte: "texte", modele: "faux/faux", plafondUsd: 0.5, silenceMin: 15 });
      T.ajouterAgent(t, "Antoine", join(dossier, "agents", "Antoine"), undefined, undefined, { role: "chef" });
      const instance = (role?: string) => {
        Object.assign(process.env, { ESSAIM_AGENT: "Antoine", ESSAIM_TABLEAU: join(dossier, "tableau.sqlite"), ESSAIM_PARTAGE: join(dossier, "partage"), ESSAIM_BUREAU: join(dossier, "agents", "Antoine") });
        if (role) process.env.ESSAIM_ROLE = role; else delete process.env.ESSAIM_ROLE;
        const pi = fauxPi();
        extension(pi.api, ouvrirBun);
        return pi;
      };
      const sans = instance();
      expect(Object.keys((sans.definition("moi_finir")!.parameters as { properties: object }).properties)).toEqual(["raison", "fichier"]);
      expect(sans.definition("moi_finir")!.description).not.toContain("lecons");
      const chef = instance("chef");
      expect(Object.keys((chef.definition("moi_finir")!.parameters as { properties: object }).properties)).toEqual(["raison", "fichier", "lecons"]);
      await chef.texte("moi_passation", { note: "la liste des exigences est faite", lecons: ["ranger les phrases avant de confier les parts"] });
      expect(T.leconsDuRun(t).map((l) => [l.agent, l.role, l.run, l.texte])).toEqual([["Antoine", "chef", "run-x", "ranger les phrases avant de confier les parts"]]);
      t.fermer();
    } finally {
      rmSync(dossier, { recursive: true, force: true });
    }
  });

  // Aucune leçon n'est activée au run suivant. Seuls le tableau (qui les écrit et les rend), le bilan de fin de run
  // (lancer.ts) et la vue (serveur.ts, vue/) peuvent lire la table ; et le bilan ne lit que le tableau de son run.
  test("aucun code ne relit les leçons hors du bilan et de la vue", () => {
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const fichiers = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? fichiers(join(dir, e.name)) : /\.(ts|js|mjs|html|md|sb)$/.test(e.name) ? [join(dir, e.name)] : []);
    const lecteurs = [...fichiers(join(racineDepot, "src")), ...(existsSync(join(racineDepot, "vue")) ? fichiers(join(racineDepot, "vue")) : [])]
      .filter((f) => /FROM\s+lecons|leconsDuRun\s*\(/i.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(racineDepot.length + 1)).sort();
    expect(lecteurs.every((f) => ["src/tableau.ts", "src/lancer.ts", "src/serveur.ts"].includes(f) || f.startsWith("vue/"))).toBe(true);
    expect(lecteurs).toContain("src/lancer.ts");
    const lancerTs = readFileSync(join(racineDepot, "src", "lancer.ts"), "utf8");
    // Dans le lanceur, une seule lecture : celle du bilan, après la fin de tous les agents, sur le tableau du run.
    expect(lancerTs.match(/leconsDuRun\s*\(/g)!.length).toBe(1);
    expect(lancerTs.indexOf("leconsDuRun(")).toBeGreaterThan(lancerTs.indexOf("conduites.push(...agents.map(conduireAgent))"));
    // Aucun texte lu par les agents (consignes, rôles) ne les cite.
    for (const f of fichiers(join(racineDepot, "src")).filter((x) => x.endsWith(".md"))) expect(readFileSync(f, "utf8")).not.toMatch(/leçons? (proposées|des runs)/i);
  });
});
