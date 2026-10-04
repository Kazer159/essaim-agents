// Le rappel du but (« refocus » de la vidéo OpenRig) : à chaque relance, l'agent relit la tête de la mission,
// ses tickets en cours et une question. Contre la « niche devenue base lunaire » : des choix défendables un à un qui,
// mis bout à bout, trahissent la finalité. Le but seulement, jamais la manière.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as M from "../src/memoire.ts";
import extension from "../src/outils-essaim.ts";
import { ouvrirBun } from "../src/tableau-bun.ts";
import * as T from "../src/tableau.ts";
import { fauxPi } from "./aide/faux-extension-api.ts";
import { motsInterdits } from "./aide/mots-interdits.ts";

const MISSION = "# Le Refuge\n\nL'application d'un restaurant.\n\n**La finalité : aucun client n'attend plus de dix minutes.**\n\n## D'où l'on part\n\nLa version précédente.\n\n## C'est fini quand\n\n- tout marche\n";

let dossier: string;
let t: T.Tableau;
const ENV = ["ESSAIM_AGENT", "ESSAIM_TABLEAU", "ESSAIM_PARTAGE", "ESSAIM_BUREAU", "ESSAIM_RELANCE", "ESSAIM_MEMOIRE"];

function ouvrir(mission: string) {
  t = ouvrirBun(join(dossier, "tableau.sqlite"));
  T.initialiser(t);
  T.ouvrirRun(t, { id: "run-test", missionChemin: "m.md", missionTexte: mission, modele: "faux/faux", plafondUsd: 0.5, silenceMin: 15 });
  for (const a of ["Antoine", "Bernard"]) { mkdirSync(join(dossier, "agents", a), { recursive: true }); T.ajouterAgent(t, a, join(dossier, "agents", a)); }
}
function instance(env: Record<string, string>) {
  for (const k of ENV) delete process.env[k];
  Object.assign(process.env, { ESSAIM_AGENT: "Antoine", ESSAIM_TABLEAU: join(dossier, "tableau.sqlite"), ESSAIM_PARTAGE: join(dossier, "partage"), ESSAIM_BUREAU: join(dossier, "agents", "Antoine") }, env);
  const faux = fauxPi();
  extension(faux.api, ouvrirBun);
  return faux;
}

beforeEach(() => { dossier = mkdtempSync(join(tmpdir(), "essaim-but-")); mkdirSync(join(dossier, "partage")); });
afterEach(() => { for (const k of ENV) delete process.env[k]; t.fermer(); rmSync(dossier, { recursive: true, force: true }); });

describe("rappelDuBut", () => {
  test("la tête de la mission (avant la première section), puis la question ; aucune section du corps", () => {
    ouvrir(MISSION);
    expect(M.rappelDuBut(t, "Antoine")).toBe(
      "[but] La mission de la salle :\n\n# Le Refuge\n\nL'application d'un restaurant.\n\n**La finalité : aucun client n'attend plus de dix minutes.**\n\nCe que tu fais en ce moment sert-il ce but ?");
  });

  test("O5 (02/10) : pour le chef, la question porte sur la répartition", () => {
    ouvrir(MISSION);
    t.run("UPDATE agents SET role = 'chef' WHERE nom = 'Antoine'");
    const r = M.rappelDuBut(t, "Antoine")!;
    expect(r).toEndWith("Chaque agent présent a-t-il une part, chaque ticket ouvert un porteur présent, chaque exigence son contrôle ?");
    expect(motsInterdits(r)).toEqual([]);
    expect(M.rappelDuBut(t, "Bernard")).toEndWith("Ce que tu fais en ce moment sert-il ce but ?");
  });

  test("les tickets en cours de l'agent, pas ceux des autres ni les ouverts ou fermés", () => {
    ouvrir(MISSION);
    const a = T.ouvrirTicket(t, { type: "bug", titre: "la porte bloque", description: "d", auteur: "Bernard", charge: "Antoine" });
    T.ouvrirTicket(t, { type: "bug", titre: "pas encore pris", description: "d", auteur: "Bernard", charge: "Antoine" });
    const b = T.ouvrirTicket(t, { type: "amelioration", titre: "le ticket de Bernard", description: "d", auteur: "Bernard", charge: "Bernard" });
    T.majTicket(t, a, "Antoine", { etat: "en_cours" });
    T.majTicket(t, b, "Bernard", { etat: "en_cours" });
    const r = M.rappelDuBut(t, "Antoine")!;
    expect(r).toContain(`Tes tickets en cours : #${a} « la porte bloque ».\n\nCe que tu fais`);
    expect(r).not.toContain("pas encore pris");
    expect(r).not.toContain("Bernard");
  });

  test("une tête trop longue est coupée à un paragraphe et le dit ; sans texte de mission, rien", () => {
    ouvrir(`# Titre\n\n${"a".repeat(1500)}\n\n${"b".repeat(1500)}\n\n## Suite\n`);
    const r = M.rappelDuBut(t, "Antoine")!;
    expect(r).toContain("a".repeat(1500));
    expect(r).not.toContain("bbbb");
    expect(r).toContain("[…]");
    t.fermer();
    rmSync(join(dossier, "tableau.sqlite"));
    ouvrir("");
    expect(M.rappelDuBut(t, "Antoine")).toBeUndefined();
  });

  test("aucune tournure qui dit la manière", () => {
    ouvrir(MISSION);
    expect(motsInterdits(M.rappelDuBut(t, "Antoine")!.replace(MISSION.split("## ")[0]!.trim(), ""))).toEqual([]);
  });
});

describe("livré au premier message d'une relance", () => {
  test("après l'état de la salle quand il y en a un, seul sinon ; rien au premier lancement ni en témoin", async () => {
    ouvrir(MISSION);
    expect(await instance({ ESSAIM_RELANCE: "resume" }).saisir("Reprends.")).toBe(`Reprends.\n\n${M.rappelDuBut(t, "Antoine")}`);
    T.reclamer(t, "Bernard", "app.js", "le menu");
    const texte = (await instance({ ESSAIM_RELANCE: "reveil" }).saisir("Tu étais en veille."))!;
    expect(texte).toStartWith("Tu étais en veille.\n\n[salle] Changements depuis");
    expect(texte).toEndWith(`« le menu »\n\n${M.rappelDuBut(t, "Antoine")}`);
    expect(await instance({}).saisir("la mission")).toBe("la mission");
    expect(await instance({ ESSAIM_RELANCE: "continue", ESSAIM_MEMOIRE: "non" }).saisir("continue")).toBe("continue");
  });
});

// Rôles des agents : au premier message d'un nouvel occupant du siège, l'état du siège, puis la
// note du sortant (après une passation seulement), puis le rappel du but.
describe("la passation d'un siège et le rappel du but, ensemble", () => {
  const siege = (o: { note?: string } = {}) => {
    ouvrir(MISSION);
    t.run("UPDATE agents SET role = 'constructeur' WHERE nom IN ('Antoine', 'Bernard')");
    T.sortirAgent(t, "Bernard", o.note ? "fini" : "perdu", o.note ? "passation du siège" : "passes épuisées");
    if (o.note) T.noterPassation(t, "Bernard", "constructeur", o.note);
    t.run("UPDATE agents SET remplace = 'Bernard' WHERE nom = 'Antoine'");
    T.succeder(t, "Bernard", "Antoine", "siège repris par Antoine");
  };

  test("remplacé vivant : la mission, l'état du siège, la note citée comme déclarée, puis le but", async () => {
    siege({ note: "le menu est à moitié fait ; j'hésite sur les prix" });
    const texte = (await instance({ ESSAIM_RELANCE: "succession" }).saisir("la mission"))!;
    expect(texte).toStartWith("la mission\n\n[siège] Tu prends le siège de constructeur que tenait Bernard (fini : passation du siège).");
    expect(texte).toContain("\n\nNote de passation de Bernard, déclaré par Bernard, non vérifié : « le menu est à moitié fait ; j'hésite sur les prix »\n\n[but]");
    expect(texte).toEndWith(`\n\n${M.rappelDuBut(t, "Antoine")}`);
  });

  test("après une panne : l'état du siège seul, puis le but ; aucune note", async () => {
    siege();
    const texte = (await instance({ ESSAIM_RELANCE: "succession" }).saisir("la mission"))!;
    expect(texte).toStartWith("la mission\n\n[siège] Tu prends le siège de constructeur que tenait Bernard (perdu : passes épuisées).");
    expect(texte).not.toContain("Note de passation");
    expect(texte).toEndWith(`\n\n${M.rappelDuBut(t, "Antoine")}`);
  });

  test("un premier lancement ordinaire, ou un agent sans prédécesseur, ne reçoit aucun état de siège", async () => {
    ouvrir(MISSION);
    expect(await instance({}).saisir("la mission")).toBe("la mission");
    expect(await instance({ ESSAIM_RELANCE: "succession" }).saisir("la mission")).toBe(`la mission\n\n${M.rappelDuBut(t, "Antoine")}`);
  });
});
