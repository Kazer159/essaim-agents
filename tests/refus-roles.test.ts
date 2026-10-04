// Rôles des agents : les parts confiées avec un ticket (pancartes au nom du chargé), les refus
// du rôle outil par outil (refusDuRole, pure, puis le crochet de l'extension) et moi_finir selon le rôle. Sans
// ESSAIM_ROLE, aucun refus nouveau.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { ouvrirBun } from "../src/tableau-bun.ts";
import * as T from "../src/tableau.ts";
import { fauxPi } from "./aide/faux-extension-api.ts";
import extension from "../src/outils-essaim.ts";
import { refusConfier, repartiteur, type Membre } from "../src/roles.ts";
import { FORME } from "./aide/refus.ts";

// L'équipe d'une application, et celle d'un jeu (sans chef) et d'un fichier (un constructeur seul).
const APPLICATION: Array<[string, string]> = [["Antoine", "chef"], ["Bernard", "integrateur"], ["Claude", "constructeur"], ["Denis", "constructeur"], ["Fabien", "recette"], ["Gilles", "gardien"]];
const JEU: Array<[string, string]> = [["Antoine", "integrateur"], ["Bernard", "constructeur"], ["Claude", "constructeur"], ["Denis", "recette"]];
const membres = (e: Array<[string, string]>): Membre[] => e.map(([nom, role]) => ({ nom, role }));

let dossier: string, chemin: string, partage: string, t: T.Tableau;
const ENV = ["ESSAIM_AGENT", "ESSAIM_TABLEAU", "ESSAIM_PARTAGE", "ESSAIM_BUREAU", "ESSAIM_ROLE", "ESSAIM_LIVRABLE", "ESSAIM_TOUR_MS", "ESSAIM_QUORUM_MS"];
let envAvant: Record<string, string | undefined> = {};

// Une salle : chaque agent avec son rôle (null : sans rôles).
function salle(equipe: Array<[string, string | null]>) {
  for (const [nom, role] of equipe) T.ajouterAgent(t, nom, join(dossier, "agents", nom), undefined, undefined, role ? { role } : undefined);
}
// L'extension chargée pour un agent ; role : ESSAIM_ROLE (absent : run sans rôles).
function instance(agent: string, role?: string, env: Record<string, string> = {}) {
  Object.assign(process.env, { ESSAIM_AGENT: agent, ESSAIM_TABLEAU: chemin, ESSAIM_PARTAGE: partage, ESSAIM_BUREAU: join(dossier, "agents", agent), ...env });
  if (role) process.env.ESSAIM_ROLE = role; else delete process.env.ESSAIM_ROLE;
  const faux = fauxPi();
  extension(faux.api, ouvrirBun);
  return faux;
}
const pancartes = () => T.reclamations(t).map((r) => [r.chemin, r.agent]);

beforeEach(() => {
  envAvant = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  process.env.ESSAIM_TOUR_MS = "0";
  dossier = mkdtempSync(join(tmpdir(), "essaim-refus-roles-"));
  chemin = join(dossier, "tableau.sqlite");
  partage = join(dossier, "partage");
  mkdirSync(partage);
  t = ouvrirBun(chemin);
  T.initialiser(t);
  T.ouvrirRun(t, { id: "run-test", missionChemin: "m.md", missionTexte: "texte", modele: "faux/faux", plafondUsd: 0.5, silenceMin: 15 });
});
afterEach(() => {
  for (const [k, v] of Object.entries(envAvant)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  t.fermer();
  rmSync(dossier, { recursive: true, force: true });
});

describe("qui répartit les parts (tâche 1)", () => {
  test("repartiteur : le chef ; sans chef, l'intégrateur ; au type fichier, personne", () => {
    expect(repartiteur(membres(APPLICATION))?.nom).toBe("Antoine");
    expect(repartiteur(membres(JEU))).toEqual({ nom: "Antoine", role: "integrateur" });
    expect(repartiteur([{ nom: "Antoine", role: "constructeur" }])).toBeUndefined();
    expect(repartiteur([{ nom: "Antoine", role: null }])).toBeUndefined();
  });

  test("refusConfier : le chef confie ; l'intégrateur seulement sans chef ; les autres rôles et un run sans rôles, jamais", () => {
    expect(refusConfier("chef", membres(APPLICATION))).toBeUndefined();
    expect(refusConfier("integrateur", membres(APPLICATION))).toBe("les parts se confient par le chef (Antoine). Définitif pour ce rôle");
    expect(refusConfier("integrateur", membres(JEU))).toBeUndefined();
    expect(refusConfier("constructeur", membres(JEU))).toBe("les parts se confient par l'intégrateur (Antoine). Définitif pour ce rôle");
    expect(refusConfier("recette", membres(APPLICATION))).toBe("les parts se confient par le chef (Antoine). Définitif pour ce rôle");
    expect(refusConfier(undefined, [{ nom: "Antoine", role: null }])).toBe("aucun rôle ne répartit les parts dans ce run. Définitif pour ce run");
    expect(refusConfier("constructeur", [{ nom: "Antoine", role: "constructeur" }])).toBe("aucun rôle ne répartit les parts dans ce run. Définitif pour ce run");
    for (const r of ["les parts se confient par le chef (Antoine). Définitif pour ce rôle", "aucun rôle ne répartit les parts dans ce run. Définitif pour ce run"])
      expect(`refusé : ${r}.`).toMatch(FORME);
  });
});

describe("les parts : tickets à chemins et pancartes confiées (tâche 1)", () => {
  test("le chef confie deux chemins à Claude : pancartes à son nom, chemins dans le ticket, l'annonce les cite", async () => {
    salle(APPLICATION);
    const r = await instance("Antoine", "chef").texte("ticket_ouvrir", { type: "amelioration", titre: "le moteur", description: "la boucle du jeu", charge: "Claude", chemins: ["moteur.js", `${partage}/rendu.js`] });
    expect(r).toBe("ticket #1 ouvert, posté dans le fil tickets");
    expect(pancartes()).toEqual([["moteur.js", "Claude"], ["rendu.js", "Claude"]]);
    expect(T.cheminsDuTicket(T.lireTicket(t, 1)!)).toEqual(["moteur.js", "rendu.js"]);
    expect(T.lireTicket(t, 1)!.notes[0]!.texte).toBe("ouvert, confié à Claude, chemins : moteur.js, rendu.js");
    expect(t.get<{ texte: string }>("SELECT texte FROM messages ORDER BY id DESC LIMIT 1")!.texte).toBe("[ticket #1 · amelioration] le moteur — confié à Claude (chemins : moteur.js, rendu.js) : la boucle du jeu");
    expect(await instance("Antoine", "chef").texte("ticket_lister", {})).toBe("#1 · amelioration · ouvert · Antoine → Claude · le moteur · chemins : moteur.js, rendu.js");
  });

  test("confier reprend la pancarte d'un autre (réattribution du chef)", async () => {
    salle(APPLICATION);
    T.reclamer(t, "Denis", "moteur.js", "je m'y mets");
    await instance("Antoine", "chef").texte("ticket_ouvrir", { type: "amelioration", titre: "le moteur", description: "d", charge: "Claude", chemins: ["moteur.js"] });
    expect(pancartes()).toEqual([["moteur.js", "Claude"]]);
    expect(t.all<{ texte: string }>("SELECT texte FROM faits WHERE type = 'pancarte' ORDER BY id").map((f) => f.texte))
      .toEqual(["pancarte · moteur.js · Denis · « je m'y mets »", "pancarte retirée · moteur.js · Denis", "pancarte · moteur.js · Claude · « ticket #1 »"]);
  });

  test("réattribuer le ticket : les pancartes suivent le chargé ; à la clôture, elles vont au chef", async () => {
    salle(APPLICATION);
    const chef = instance("Antoine", "chef");
    await chef.texte("ticket_ouvrir", { type: "question", titre: "le moteur", description: "d", charge: "Claude", chemins: ["moteur.js"] });
    await chef.texte("ticket_modifier", { id: 1, charge: "Denis", chemins: ["rendu.js"] });
    expect(pancartes()).toEqual([["moteur.js", "Denis"], ["rendu.js", "Denis"]]);
    expect(T.lireTicket(t, 1)!.notes.at(-1)!.texte).toBe("confié à Denis ; chemins confiés : rendu.js");
    await instance("Denis", "constructeur").texte("ticket_modifier", { id: 1, etat: "ferme", note: "fait" });
    expect(pancartes()).toEqual([["moteur.js", "Antoine"], ["rendu.js", "Antoine"]]);
  });

  // Confié à un autre, le livrable serait écrasé au réassemblage suivant.
  test("J2 : le livrable ne se confie qu'à l'intégrateur, ni à l'ouverture ni par réattribution ; sa pancarte reste à lui", async () => {
    salle(APPLICATION);
    T.reclamer(t, "Bernard", "texte.jsonl", "le livrable (## Livrable)");
    const chef = instance("Antoine", "chef", { ESSAIM_LIVRABLE: "texte.jsonl" });
    const refus = "refusé : texte.jsonl est le livrable, tenu par l'intégrateur (Bernard) : une correction se confie dans la source qu'il assemble, ou dans un essai (depot_essai) que l'intégrateur adopte. Se lève avec Bernard pour chargé.";
    expect(await chef.texte("ticket_ouvrir", { type: "bug", titre: "6 lignes", description: "d", charge: "Claude", chemins: ["Texte.jsonl"] })).toBe(refus);
    expect(await chef.texte("ticket_ouvrir", { type: "bug", titre: "6 lignes", description: "d", charge: "Claude", chemins: ["fragments/a.jsonl"] })).toBe("ticket #1 ouvert, posté dans le fil tickets");
    expect(await chef.texte("ticket_modifier", { id: 1, chemins: ["texte.jsonl"] })).toBe(refus);
    expect(await chef.texte("ticket_ouvrir", { type: "bug", titre: "assembler", description: "d", charge: "Bernard", chemins: ["texte.jsonl"] })).toBe("ticket #2 ouvert, posté dans le fil tickets");
    expect(await chef.texte("ticket_modifier", { id: 2, charge: "Claude" })).toBe(refus);
    expect(pancartes()).toEqual([["texte.jsonl", "Bernard"], ["fragments/a.jsonl", "Claude"]]);
  });

  test("K10 : un bug ou une amélioration ne va à l'assembleur que du chef, avec chemins ; une question ou une alerte passent", async () => {
    salle([["Antoine", "chef"], ["Bernard", "integrateur"], ["Hector", "assembleur"], ["Claude", "constructeur"], ["Fabien", "recette"]]);
    const claude = instance("Claude", "constructeur", { ESSAIM_LIVRABLE: "texte.jsonl" });
    expect(await claude.texte("ticket_ouvrir", { type: "bug", titre: "huit écarts", description: "d", charge: "Hector" }))
      .toBe("refusé : Hector est l'assembleur : il ne reçoit que l'assemblage, confié par Antoine. Un écart du livrable se corrige dans sa source, et le ticket va au porteur de cette source (sa pancarte). Définitif pour ce chargé.");
    expect(await claude.texte("ticket_ouvrir", { type: "question", titre: "quand assembles-tu", description: "d", charge: "Hector" })).toBe("ticket #1 ouvert, posté dans le fil tickets");
    const chef = instance("Antoine", "chef", { ESSAIM_LIVRABLE: "texte.jsonl" });
    expect(await chef.texte("ticket_ouvrir", { type: "bug", titre: "rectifier", description: "d", charge: "Hector" }))
      .toBe("refusé : Hector est l'assembleur : un ticket ne lui va qu'avec ses chemins (le livrable, le programme qui l'assemble, ses gardes) ; un écart du livrable se corrige chez le porteur de sa source. Se lève avec chemins.");
    expect(await chef.texte("ticket_ouvrir", { type: "amelioration", titre: "assembler", description: "d", charge: "Hector", chemins: ["assemble.ts"] })).toBe("ticket #2 ouvert, posté dans le fil tickets");
    expect(await chef.texte("ticket_ouvrir", { type: "bug", titre: "écart", description: "d", charge: "Claude" })).toBe("ticket #3 ouvert, posté dans le fil tickets");
    expect((await chef.texte("ticket_modifier", { id: 3, charge: "Hector" }))).toStartWith("refusé : Hector est l'assembleur : un ticket ne lui va qu'avec ses chemins");
  });

  test("O1 (03/10) : deux bugs ou améliorations ouverts au plus pour l'assembleur, chef compris ; le refus nomme les constructeurs disponibles", async () => {
    salle([["Antoine", "chef"], ["Bernard", "integrateur"], ["Hector", "assembleur"], ["Claude", "constructeur"], ["Denis", "constructeur"], ["Fabien", "recette"]]);
    T.endormir(t, "Denis");
    t.run("UPDATE agents SET endormi_le = ? WHERE nom = 'Denis'", [new Date(Date.now() - 40 * 60_000).toISOString()]);
    const chef = instance("Antoine", "chef", { ESSAIM_LIVRABLE: "texte.jsonl" });
    for (const n of [1, 2]) expect(await chef.texte("ticket_ouvrir", { type: "amelioration", titre: `assembler ${n}`, description: "d", charge: "Hector", chemins: ["assemble.ts"] })).toBe(`ticket #${n} ouvert, posté dans le fil tickets`);
    expect(await chef.texte("ticket_ouvrir", { type: "bug", titre: "écart", description: "d", charge: "Hector", chemins: ["assemble.ts"] }))
      .toBe("refusé : Hector (assembleur) porte déjà 2 tickets ouverts : l'assemblage passe d'abord. Constructeurs disponibles maintenant : Denis. Se lève quand l'assembleur en porte moins de 2.");
    expect(await chef.texte("ticket_ouvrir", { type: "question", titre: "où en est l'assemblage", description: "d", charge: "Hector" })).toBe("ticket #3 ouvert, posté dans le fil tickets");
  });

  test("J2 avec un assembleur : le livrable se confie à lui seul ; l'intégrateur ne l'écrit plus, le refus nomme l'assembleur", async () => {
    salle([["Antoine", "chef"], ["Bernard", "integrateur"], ["Hector", "assembleur"], ["Claude", "constructeur"], ["Fabien", "recette"]]);
    T.reclamer(t, "Hector", "texte.jsonl", "le livrable (## Livrable)");
    const chef = instance("Antoine", "chef", { ESSAIM_LIVRABLE: "texte.jsonl" });
    expect(await chef.texte("ticket_ouvrir", { type: "bug", titre: "x", description: "d", charge: "Bernard", chemins: ["texte.jsonl"] }))
      .toBe("refusé : texte.jsonl est le livrable, tenu par l'assembleur (Hector) : une correction se confie dans la source qu'il assemble, ou dans un essai (depot_essai) que l'intégrateur adopte. Se lève avec Hector pour chargé.");
    expect(await chef.texte("ticket_ouvrir", { type: "bug", titre: "x", description: "d", charge: "Hector", chemins: ["texte.jsonl", "assemble.ts"] })).toBe("ticket #1 ouvert, posté dans le fil tickets");
    const write = (pi: ReturnType<typeof fauxPi>) => pi.emettre("tool_call", { type: "tool_call", toolName: "write", toolCallId: "w", input: { path: join(partage, "texte.jsonl"), content: "x" } }) as Promise<{ reason?: string } | undefined>;
    expect((await write(instance("Bernard", "integrateur", { ESSAIM_LIVRABLE: "texte.jsonl" })))?.reason).toBe("refusé : texte.jsonl est le livrable, tenu par l'assembleur. Se lève dans un essai (depot_essai) proposé à l'intégrateur.");
    expect(await write(instance("Hector", "assembleur", { ESSAIM_LIVRABLE: "texte.jsonl" }))).toBeUndefined();
  });

  test("I1 (03/10) : avec un chef, un bug ou une amélioration ne va à l'intégrateur que sur ses fichiers ; une question passe ; sans chef, tout passe", async () => {
    salle([["Antoine", "chef"], ["Bernard", "integrateur"], ["Claude", "constructeur"], ["Fabien", "recette"]]);
    T.reclamer(t, "Bernard", "contrat.md", "le contrat");
    const chef = instance("Antoine", "chef");
    expect(await chef.texte("ticket_ouvrir", { type: "amelioration", titre: "une garde", description: "d", charge: "Bernard", chemins: ["garde.ts"] }))
      .toStartWith("refusé : Bernard est l'intégrateur : il adopte les essais et tient le contrat, il ne construit pas.");
    expect(await chef.texte("ticket_ouvrir", { type: "bug", titre: "contrat", description: "d", charge: "Bernard", chemins: ["contrat.md"] })).toBe("ticket #1 ouvert, posté dans le fil tickets");
    expect(await chef.texte("ticket_ouvrir", { type: "question", titre: "q", description: "d", charge: "Bernard" })).toBe("ticket #2 ouvert, posté dans le fil tickets");
    expect(await chef.texte("ticket_ouvrir", { type: "bug", titre: "b", description: "d", charge: "Claude" })).toBe("ticket #3 ouvert, posté dans le fil tickets");
    expect(await chef.texte("ticket_modifier", { id: 3, charge: "Bernard" })).toStartWith("refusé : Bernard est l'intégrateur");
  });

  test("T2 (03/10) : la part d'un autre ne va pas à l'assembleur, même du chef ; le livrable et un chemin libre passent", async () => {
    salle([["Antoine", "chef"], ["Bernard", "integrateur"], ["Hector", "assembleur"], ["Claude", "constructeur"], ["Fabien", "recette"]]);
    T.reclamer(t, "Hector", "texte.jsonl", "le livrable (## Livrable)");
    T.reclamer(t, "Claude", "feuilles/432.json", "sa part");
    const chef = instance("Antoine", "chef", { ESSAIM_LIVRABLE: "texte.jsonl" });
    expect(await chef.texte("ticket_ouvrir", { type: "bug", titre: "x", description: "d", charge: "Hector", chemins: ["feuilles/432.json"] }))
      .toBe("refusé : feuilles/432.json est la part de Claude : sa correction va à son porteur, pas à l'assembleur. Se lève avec des chemins que personne d'autre ne porte (le livrable, le programme qui l'assemble, ses gardes).");
    expect(await chef.texte("ticket_ouvrir", { type: "bug", titre: "x", description: "d", charge: "Hector", chemins: ["texte.jsonl", "assemble.ts"] })).toBe("ticket #1 ouvert, posté dans le fil tickets");
  });

  test("T3 (03/10) : un bug ou une amélioration ne va ni à la recette ni au gardien ; une question et une alerte passent", async () => {
    salle([["Antoine", "chef"], ["Bernard", "integrateur"], ["Claude", "constructeur"], ["Fabien", "recette"], ["Gilles", "gardien"]]);
    const chef = instance("Antoine", "chef");
    expect(await chef.texte("ticket_ouvrir", { type: "bug", titre: "x", description: "d", charge: "Fabien" })).toStartWith("refusé : Fabien est la recette : il contrôle, il n'écrit pas le produit.");
    expect(await chef.texte("ticket_ouvrir", { type: "amelioration", titre: "x", description: "d", charge: "Gilles" })).toStartWith("refusé : Gilles est le gardien-mesureur : il contrôle");
    expect(await chef.texte("ticket_ouvrir", { type: "question", titre: "q", description: "d", charge: "Fabien" })).toBe("ticket #1 ouvert, posté dans le fil tickets");
  });

  test("03/10 : pendant la préparation, le refus nomme les constructeurs qui attendent le plan", async () => {
    salle([["Antoine", "chef"], ["Bernard", "integrateur"], ["Claude", "constructeur"], ["Denis", "constructeur"], ["Fabien", "recette"]]);
    for (const n of ["Claude", "Denis"]) T.endormir(t, n, T.ATTENTE_PLAN);
    expect(await instance("Antoine", "chef").texte("ticket_ouvrir", { type: "bug", titre: "x", description: "d", charge: "Fabien" }))
      .toBe("refusé : Fabien est la recette : il contrôle, il n'écrit pas le produit. Constructeurs qui attendent le plan, à qui une exploration se confie : Claude, Denis. Définitif pour ce chargé.");
  });

  test("03/10 : ni tour de parole ni attente de la moitié de la salle dans un run à rôles ; sans rôles, le tour reste", async () => {
    salle([["Antoine", "chef"], ["Bernard", "integrateur"], ["Fabien", "recette"]]);
    Object.assign(process.env, { ESSAIM_TOUR_MS: "90000", ESSAIM_QUORUM_MS: "300000" });
    const debut = Date.now();
    expect(await instance("Fabien", "recette").texte("salle_poster", { texte: "Antoine : prête à juger le plan" })).toStartWith("message ");
    expect(Date.now() - debut).toBeLessThan(5_000);
    expect(await instance("Bernard").texte("salle_poster", { texte: "bonjour" })).toStartWith("refusé : tour de parole, Antoine n'a pas encore posté");
  });

  test("03/10 : pendant la préparation, un constructeur ne reçoit qu'une exploration (question) ; après, tout passe", async () => {
    salle([["Antoine", "chef"], ["Bernard", "integrateur"], ["Claude", "constructeur"], ["Fabien", "recette"]]);
    T.ouvrirPreparation(t);
    const chef = instance("Antoine", "chef");
    expect(await chef.texte("ticket_ouvrir", { type: "amelioration", titre: "lire les pages 109–123", description: "d", charge: "Claude" }))
      .toBe("refusé : la préparation est en cours : Claude ne reçoit qu'une exploration, une question dont la réponse est une mesure pour la spec ou le plan. Se lève avec type question, ou quand le plan est validé ou la préparation close.");
    expect(await chef.texte("ticket_ouvrir", { type: "question", titre: "combien de temps pour lire 2 pages au format page/ligne/ligne", description: "d", charge: "Claude" })).toBe("ticket #1 ouvert, posté dans le fil tickets");
    T.clorePreparation(t, "validee");
    expect(await chef.texte("ticket_ouvrir", { type: "amelioration", titre: "lire les pages 109–123", description: "d", charge: "Claude" })).toBe("ticket #2 ouvert, posté dans le fil tickets");
  });

  test("I1 : sans chef, l'intégrateur répartit et reçoit du travail", async () => {
    salle([["Bernard", "integrateur"], ["Claude", "constructeur"], ["Fabien", "recette"]]);
    expect(await instance("Claude", "constructeur").texte("ticket_ouvrir", { type: "bug", titre: "b", description: "d", charge: "Bernard" })).toBe("ticket #1 ouvert, posté dans le fil tickets");
  });

  test("à la clôture, une pancarte déjà reprise pour un autre ticket reste à son nouveau porteur", async () => {
    salle(APPLICATION);
    const chef = instance("Antoine", "chef");
    await chef.texte("ticket_ouvrir", { type: "question", titre: "a", description: "d", charge: "Claude", chemins: ["moteur.js", "rendu.js"] });
    await chef.texte("ticket_ouvrir", { type: "question", titre: "b", description: "d", charge: "Denis", chemins: ["rendu.js"] });
    await instance("Claude", "constructeur").texte("ticket_modifier", { id: 1, etat: "ferme", note: "fait" });
    expect(pancartes()).toEqual([["rendu.js", "Denis"], ["moteur.js", "Antoine"]]);
  });

  test("son chargé peut rendre le ticket au chef ; il ne peut pas le passer à un autre constructeur", async () => {
    salle(APPLICATION);
    await instance("Antoine", "chef").texte("ticket_ouvrir", { type: "question", titre: "a", description: "d", charge: "Claude", chemins: ["moteur.js"] });
    const claude = instance("Claude", "constructeur");
    // L'annonce du ticket qui lui est confié s'adresse à Claude ; sa ligne courte la porte, une fois
    expect(await claude.texte("ticket_modifier", { id: 1, charge: "Denis" })).toBe("refusé : les parts se confient par le chef (Antoine). Définitif pour ce rôle.\n[salle] pour toi : message 1 de Antoine (tickets) : « [ticket #1 · question] a — confié à Claude (chemins : moteur.js) : d »");
    expect(await claude.texte("ticket_modifier", { id: 1, charge: "Antoine" })).toBe("ticket #1 : confié à Antoine");
    expect(pancartes()).toEqual([["moteur.js", "Antoine"]]);
  });

  test("dans un jeu (sans chef), l'intégrateur confie ; un constructeur ne confie pas", async () => {
    salle(JEU);
    expect(await instance("Antoine", "integrateur").texte("ticket_ouvrir", { type: "question", titre: "a", description: "d", charge: "Bernard", chemins: ["jeu.js"] })).toBe("ticket #1 ouvert, posté dans le fil tickets");
    expect(await instance("Bernard", "constructeur").texte("ticket_ouvrir", { type: "question", titre: "b", description: "d", charge: "Claude", chemins: ["x.js"] }))
      .toBe("refusé : les parts se confient par l'intégrateur (Antoine). Définitif pour ce rôle.\n[salle] pour toi : message 1 de Antoine (tickets) : « [ticket #1 · question] a — confié à Bernard (chemins : jeu.js) : d »");
    expect(pancartes()).toEqual([["jeu.js", "Bernard"]]);
  });

  test("refus : l'intégrateur sous un chef, chemins sans chargé, chemin hors du dossier partagé, run sans rôles ; sans effet", async () => {
    salle(APPLICATION);
    expect(await instance("Bernard", "integrateur").texte("ticket_ouvrir", { type: "question", titre: "a", description: "d", charge: "Claude", chemins: ["a.js"] }))
      .toBe("refusé : les parts se confient par le chef (Antoine). Définitif pour ce rôle.");
    const chef = instance("Antoine", "chef");
    expect(await chef.texte("ticket_ouvrir", { type: "question", titre: "a", description: "d", chemins: ["a.js"] })).toBe("refusé : des chemins sans chargé. Se lève avec un chargé.");
    expect(await chef.texte("ticket_ouvrir", { type: "question", titre: "a", description: "d", charge: "Claude", chemins: ["../a.js"] })).toBe("refusé : ../a.js est hors du dossier partagé. Définitif pour ce chemin.");
    await chef.texte("ticket_ouvrir", { type: "question", titre: "a", description: "d" });
    expect(await chef.texte("ticket_modifier", { id: 1, chemins: ["a.js"] })).toBe("refusé : des chemins sans chargé. Se lève avec un chargé.");
    expect(await instance("Claude", "constructeur").texte("ticket_modifier", { id: 1, charge: "Claude", chemins: ["a.js"] })).toBe("refusé : les parts se confient par le chef (Antoine). Définitif pour ce rôle.");
    expect(pancartes()).toEqual([]);
    expect(T.lireTicket(t, 1)!.chemins).toBeNull();
  });

  test("sans rôles : des chemins sont refusés (aucun répartiteur) ; les tickets sans chemins, comme avant", async () => {
    salle([["agent-01", null], ["agent-02", null]]);
    const pi = instance("agent-01");
    expect(await pi.texte("ticket_ouvrir", { type: "bug", titre: "a", description: "d", charge: "agent-02", chemins: ["a.js"] }))
      .toBe("refusé : aucun rôle ne répartit les parts dans ce run. Définitif pour ce run.");
    expect(await pi.texte("ticket_ouvrir", { type: "bug", titre: "a", description: "d", charge: "agent-02" })).toBe("ticket #1 ouvert, posté dans le fil tickets");
    expect(await instance("agent-02").texte("ticket_modifier", { id: 1, charge: "agent-01" })).toBe("ticket #1 : confié à agent-01\n[salle] pour toi : message 1 de agent-01 (tickets) : « [ticket #1 · bug] a — confié à agent-02 : d »");
  });
});

// ---- refusDuRole, pure, puis le crochet et les outils de la salle ----------------------------------------
import { refusDuRole, type Cible, type ContexteRefus } from "../src/roles.ts";

describe("refusDuRole : la table §3.1, outil par outil (tâche 2)", () => {
  const P = (rel: string): Cible => ({ racine: "partage", rel });
  const app = (agent: string, pancartes: Array<[string, string]> = [], livrable = "index.html"): ContexteRefus =>
    ({ agent, equipe: membres(APPLICATION), pancartes: pancartes.map(([chemin, a]) => ({ chemin, agent: a })), livrable });
  const jeu = (agent: string, pancartes: Array<[string, string]> = []): ContexteRefus => ({ ...app(agent, pancartes), equipe: membres(JEU) });
  const fichier = (agent: string, pancartes: Array<[string, string]> = []): ContexteRefus => ({ ...app(agent, pancartes), equipe: [{ nom: agent, role: "constructeur" }, { nom: "Bernard", role: "constructeur" }] });

  test("chef, recette, gardien : toute écriture du produit refusée, définitif, write, edit et restauration compris", () => {
    for (const outil of ["write", "edit", "depot_restaurer"] as const) {
      expect(refusDuRole("chef", outil, P("app.js"), app("Antoine"))).toBe("le chef n'écrit pas le produit (app.js). Définitif pour ce rôle");
      expect(refusDuRole("recette", outil, P("app.js"), app("Fabien"))).toBe("la recette n'écrit pas le produit (app.js). Définitif pour ce rôle");
      expect(refusDuRole("gardien", outil, P("app.js"), app("Gilles", [["app.js", "Gilles"]]))).toBe("le gardien-mesureur n'écrit pas le produit (app.js). Définitif pour ce rôle");
    }
  });

  test("le monde : refusé à tous les rôles ; le bureau, jamais ; un essai, seulement à qui n'écrit pas le produit (D4, 30/09)", () => {
    for (const [nom, role] of APPLICATION)
      expect(refusDuRole(role as never, "write", { racine: "monde", rel: "entrees/clients.json" }, app(nom))).toBe("entrees/clients.json est une entrée fixée par la mission. Définitif pour ce chemin");
    for (const [nom, role] of APPLICATION) {
      const essai = refusDuRole(role as never, "write", { racine: "essai", rel: "app.js" }, app(nom, [["app.js", "Claude"]]));
      if (["constructeur", "integrateur"].includes(role)) expect(essai).toBeUndefined();
      else expect(essai).toEndWith("n'écrit pas le produit, même dans un essai (app.js). Définitif pour ce rôle");
      expect(refusDuRole(role as never, "edit", { racine: "ailleurs", rel: "/bureau/notes.md" }, app(nom))).toBeUndefined();
      expect(refusDuRole(role as never, "write", undefined, app(nom))).toBeUndefined();
    }
  });

  test("constructeur : sa part s'écrit ; la part d'un autre, un fichier sans part et le livrable sont refusés", () => {
    const c = app("Claude", [["moteur.js", "Claude"], ["rendu.js", "Denis"], ["index.html", "Bernard"]]);
    expect(refusDuRole("constructeur", "write", P("moteur.js"), c)).toBeUndefined();
    expect(refusDuRole("constructeur", "edit", P("rendu.js"), c)).toBe("rendu.js est la part de Denis. Se lève quand le chef te confie ce chemin, ou dans un essai (depot_essai) que Denis adopte");
    expect(refusDuRole("constructeur", "write", P("neuf.js"), c)).toBe("neuf.js n'est pas ta part. Se lève quand le chef te confie ce chemin, ou dans un essai (depot_essai) proposé à l'intégrateur");
    expect(refusDuRole("constructeur", "write", P("index.html"), c)).toBe("index.html est le livrable, tenu par l'intégrateur. Se lève dans un essai (depot_essai) proposé à l'intégrateur");
    // Même confié par erreur, le livrable reste à l'intégrateur.
    expect(refusDuRole("constructeur", "write", P("index.html"), app("Claude", [["index.html", "Claude"]]))).toBe("index.html est le livrable, tenu par l'intégrateur. Se lève dans un essai (depot_essai) proposé à l'intégrateur");
    expect(refusDuRole("constructeur", "depot_restaurer", P("rendu.js"), c)).toStartWith("rendu.js est la part de Denis.");
  });

  test("intégrateur : écrit hors des parts des autres (le livrable, ses fichiers) ; la part d'un constructeur lui est refusée", () => {
    const c = app("Bernard", [["moteur.js", "Claude"], ["index.html", "Bernard"]]);
    expect(refusDuRole("integrateur", "write", P("index.html"), c)).toBeUndefined();
    // Avec un chef, l'intégrateur n'écrit que ce qui porte sa pancarte (le contrat, l'assemblage) et le livrable.
    expect(refusDuRole("integrateur", "write", P("contrat.js"), c)).toBe("contrat.js n'est ni le contrat ni l'assemblage : l'intégrateur adopte, il ne construit pas ; ce travail va à un constructeur, confié par Antoine. Se lève avec ta pancarte sur ce fichier (fichier_reclamer), s'il est du contrat ou de l'assemblage");
    expect(refusDuRole("integrateur", "write", P("contrat.js"), app("Bernard", [["contrat.js", "Bernard"]]))).toBeUndefined();
    expect(refusDuRole("integrateur", "write", { racine: "essai", rel: "temoin.md" }, c)).toBeUndefined();
    expect(refusDuRole("integrateur", "depot_essai", undefined, c)).toBe("l'intégrateur adopte les essais des constructeurs, il n'en ouvre pas : le travail à construire va à un constructeur, confié par Antoine. Définitif pour ce rôle quand un chef répartit");
    expect(refusDuRole("constructeur", "depot_essai", undefined, app("Claude"))).toBeUndefined();
    expect(refusDuRole("integrateur", "edit", P("moteur.js"), c)).toBe("moteur.js est la part de Claude. Se lève quand le chef te confie ce chemin, ou dans un essai (depot_essai) que Claude adopte");
    // La part rendue au chef à la clôture d'un ticket : le chef n'adopte pas, la voie de l'essai reste l'intégrateur.
    expect(refusDuRole("constructeur", "write", P("vieux.js"), app("Claude", [["vieux.js", "Antoine"]]))).toBe("vieux.js est la part de Antoine. Se lève quand le chef te confie ce chemin, ou dans un essai (depot_essai) proposé à l'intégrateur");
  });

  test("03/10 : qui répartit écrit SPEC.md et PLAN.md à la racine, même le chef ; un autre fichier lui reste refusé", () => {
    expect(refusDuRole("chef", "write", P("SPEC.md"), app("Antoine"))).toBeUndefined();
    expect(refusDuRole("chef", "edit", P("PLAN.md"), app("Antoine"))).toBeUndefined();
    expect(refusDuRole("chef", "write", P("notes/SPEC.md"), app("Antoine"))).toBe("le chef n'écrit pas le produit (notes/SPEC.md). Définitif pour ce rôle");
    expect(refusDuRole("recette", "write", P("SPEC.md"), app("Fabien"))).toBe("la recette n'écrit pas le produit (SPEC.md). Définitif pour ce rôle");
  });

  test("jeu (sans chef) : l'intégrateur répartit, la levée le nomme", () => {
    // Sans chef, l'intégrateur répartit et construit aussi.
    expect(refusDuRole("integrateur", "write", P("neuf.js"), jeu("Bernard"))).toBeUndefined();
    expect(refusDuRole("integrateur", "depot_essai", undefined, jeu("Bernard"))).toBeUndefined();
    expect(refusDuRole("constructeur", "write", P("neuf.js"), jeu("Bernard"))).toBe("neuf.js n'est pas ta part. Se lève quand l'intégrateur te confie ce chemin, ou dans un essai (depot_essai) proposé à l'intégrateur");
  });

  test("fichier (constructeurs seuls) : ni part ni livrable ; une pancarte d'un autre reste bloquante, levée par son porteur", () => {
    expect(refusDuRole("constructeur", "write", P("index.html"), fichier("Antoine"))).toBeUndefined();
    expect(refusDuRole("constructeur", "write", P("neuf.svg"), fichier("Antoine"))).toBeUndefined();
    expect(refusDuRole("constructeur", "write", P("a.svg"), fichier("Antoine", [["a.svg", "Bernard"]]))).toBe("a.svg porte la pancarte de Bernard. Se lève quand Bernard la retire");
    expect(refusDuRole("constructeur", "depot_adopter", undefined, fichier("Antoine"))).toBeUndefined();
  });

  test("depot_adopter : l'intégrateur, dès qu'il y en a un ; un constructeur, l'essai qui ne change que sa part (R14)", () => {
    expect(refusDuRole("integrateur", "depot_adopter", undefined, app("Bernard"))).toBeUndefined();
    for (const [role, nom] of [["chef", "Antoine"], ["recette", "Fabien"], ["gardien", "Gilles"]])
      expect(refusDuRole(role as never, "depot_adopter", undefined, { ...app(nom, [["a.ts", nom]]), essai: ["a.ts"] })).toBe("l'adoption d'un essai revient à l'intégrateur. Définitif pour ce rôle");
    const leve = "Se lève quand chaque fichier que l'essai change porte ta pancarte";
    expect(refusDuRole("constructeur", "depot_adopter", undefined, app("Claude"))).toBe(`l'adoption d'un essai revient à l'intégrateur, ou au porteur de la pancarte de chaque fichier qu'il change. ${leve}`);
    expect(refusDuRole("constructeur", "depot_adopter", undefined, jeu("Bernard"))).toBe(`l'adoption d'un essai revient à l'intégrateur, ou au porteur de la pancarte de chaque fichier qu'il change. ${leve}`);
    // Le porteur de chaque fichier que l'essai change l'adopte ; un seul fichier d'un autre, ou sans pancarte, suffit à refuser.
    const c = app("Claude", [["a.ts", "Claude"], ["b.ts", "Claude"], ["c.ts", "Denis"]]);
    expect(refusDuRole("constructeur", "depot_adopter", undefined, { ...c, essai: ["a.ts", "b.ts"] })).toBeUndefined();
    expect(refusDuRole("constructeur", "depot_adopter", undefined, { ...c, essai: ["a.ts", "c.ts", "neuf.ts"] }))
      .toBe(`l'adoption d'un essai revient à l'intégrateur, ou au porteur de la pancarte de chaque fichier qu'il change (sans la tienne : c.ts, neuf.ts). ${leve}`);
    expect(refusDuRole("constructeur", "depot_adopter", undefined, { ...jeu("Bernard", [["a.ts", "Bernard"]]), essai: ["a.ts"] })).toBeUndefined();
  });

  test("fichier_reclamer : chef et intégrateur posent ; un constructeur reçoit ses parts ; recette et gardien, jamais", () => {
    expect(refusDuRole("chef", "fichier_reclamer", undefined, app("Antoine"))).toBeUndefined();
    expect(refusDuRole("integrateur", "fichier_reclamer", undefined, app("Bernard"))).toBeUndefined();
    expect(refusDuRole("integrateur", "fichier_reclamer", undefined, jeu("Antoine"))).toBeUndefined();
    expect(refusDuRole("constructeur", "fichier_reclamer", undefined, app("Claude"))).toBe("tes parts te sont confiées par le chef (Antoine). Se lève quand le chef te confie ce chemin");
    expect(refusDuRole("constructeur", "fichier_reclamer", undefined, fichier("Antoine"))).toBeUndefined();
    expect(refusDuRole("recette", "fichier_reclamer", undefined, app("Fabien"))).toBe("la recette n'écrit pas le produit. Définitif pour ce rôle");
    expect(refusDuRole("gardien", "fichier_reclamer", undefined, app("Gilles"))).toBe("le gardien-mesureur n'écrit pas le produit. Définitif pour ce rôle");
  });

  test("chaque refus a la forme commune", () => {
    const refus: string[] = [];
    const c = app("Claude", [["rendu.js", "Denis"]]);
    for (const [nom, role] of APPLICATION)
      for (const outil of ["write", "depot_adopter", "fichier_reclamer"] as const)
        for (const cible of [P("rendu.js"), P("neuf.js"), P("index.html"), { racine: "monde", rel: "entrees/x" } as Cible]) {
          const r = refusDuRole(role as never, outil, cible, { ...c, agent: nom });
          if (r) refus.push(r);
        }
    refus.push(refusDuRole("constructeur", "write", P("a.svg"), fichier("Antoine", [["a.svg", "Bernard"]]))!);
    expect(refus.length).toBeGreaterThan(10);
    for (const r of refus) expect(`refusé : ${r}.`, r).toMatch(FORME);
  });
});

describe("le crochet tool_call : write et edit selon le rôle (tâche 2)", () => {
  const appel = (pi: ReturnType<typeof fauxPi>, toolName: string, path: string) =>
    pi.emettre("tool_call", { type: "tool_call", toolName, toolCallId: "c1", input: { path, content: "x" } }) as Promise<{ block?: boolean; reason?: string } | undefined>;

  test("recette : partage/ refusé en chemin absolu, relatif au bureau et en ~/ ; son bureau et un essai passent", async () => {
    salle(APPLICATION);
    const pi = instance("Fabien", "recette");
    const refus = { block: true, reason: "refusé : la recette n'écrit pas le produit (app.js). Définitif pour ce rôle." };
    expect(await appel(pi, "write", join(partage, "app.js"))).toEqual(refus);
    expect(await appel(pi, "edit", "../../partage/app.js")).toEqual(refus);
    expect(await appel(pi, "write", `~/${relative(homedir(), join(partage, "app.js"))}`)).toEqual(refus);
    expect(await appel(pi, "write", "scenario.md")).toBeUndefined();
    // Ni dans un essai que l'intégrateur adopterait ensuite — ce qu'elle vérifie ne dépend pas d'elle
    expect((await appel(pi, "write", join(dossier, "essais", "x", "app.js")))?.reason).toBe("refusé : la recette n'écrit pas le produit, même dans un essai (app.js). Définitif pour ce rôle.");
    expect(await appel(instance("Claude", "constructeur"), "write", join(dossier, "essais", "x", "app.js"))).toBeUndefined();
    expect(await appel(pi, "read", join(partage, "app.js"))).toBeUndefined();
  });

  test("constructeur : sa part passe, celle d'un autre est refusée ; le monde est refusé à tous", async () => {
    salle(APPLICATION);
    await instance("Antoine", "chef").texte("ticket_ouvrir", { type: "question", titre: "a", description: "d", charge: "Claude", chemins: ["moteur.js"] });
    await instance("Antoine", "chef").texte("ticket_ouvrir", { type: "question", titre: "b", description: "d", charge: "Denis", chemins: ["rendu.js"] });
    const claude = instance("Claude", "constructeur");
    expect(await appel(claude, "write", join(partage, "moteur.js"))).toBeUndefined();
    expect((await appel(claude, "edit", join(partage, "rendu.js")))?.reason).toBe("refusé : rendu.js est la part de Denis. Se lève quand le chef te confie ce chemin, ou dans un essai (depot_essai) que Denis adopte.");
    for (const [nom, role] of APPLICATION)
      expect((await appel(instance(nom, role), "write", join(dossier, "entrees", "clients.json")))?.reason).toBe("refusé : entrees/clients.json est une entrée fixée par la mission. Définitif pour ce chemin.");
  });

  test("page_assembler écrit dans partage/ : même refus qu'un write sur sa sortie (29/09, revue F1)", async () => {
    salle(APPLICATION);
    const assembler = (pi: ReturnType<typeof fauxPi>, input: Record<string, string>) =>
      pi.emettre("tool_call", { type: "tool_call", toolName: "page_assembler", toolCallId: "c1", input }) as Promise<{ block?: boolean; reason?: string } | undefined>;
    expect((await assembler(instance("Fabien", "recette"), { source: "dev.html" }))?.reason).toBe("refusé : la recette n'écrit pas le produit (index.html). Définitif pour ce rôle.");
    const claude = instance("Claude", "constructeur", { ESSAIM_LIVRABLE: "index.html" });
    expect((await assembler(claude, { source: "dev.html" }))?.reason).toBe("refusé : index.html est le livrable, tenu par l'intégrateur. Se lève dans un essai (depot_essai) proposé à l'intégrateur.");
    expect(await assembler(instance("Bernard", "integrateur", { ESSAIM_LIVRABLE: "index.html" }), { source: "dev.html", sortie: "index.html" })).toBeUndefined();
  });

  test("une autre casse ne contourne ni la pancarte, ni le livrable, ni le monde, ni le dossier partagé (29/09, revue R3, R4)", async () => {
    salle(APPLICATION);
    await instance("Antoine", "chef").texte("ticket_ouvrir", { type: "question", titre: "a", description: "d", charge: "Claude", chemins: ["src/app.js"] });
    const bernard = instance("Bernard", "integrateur");
    expect((await appel(bernard, "write", join(partage, "SRC", "App.js")))?.reason).toStartWith("refusé : SRC/App.js est la part de Claude");
    for (const [nom, role] of APPLICATION)
      expect((await appel(instance(nom, role), "write", join(dossier, "Entrees", "clients.json")))?.block).toBe(true);
    expect((await appel(instance("Fabien", "recette"), "write", join(dossier, "PARTAGE", "app.js")))?.reason).toBe("refusé : la recette n'écrit pas le produit (app.js). Définitif pour ce rôle.");
  });

  test("un refus du crochet n'exécute pas l'outil (la suite de pi s'arrête au block)", async () => {
    salle(APPLICATION);
    const pi = instance("Antoine", "chef");
    expect(await appel(pi, "write", join(partage, "app.js"))).toMatchObject({ block: true });
  });

  test("sans rôles : aucun refus, même sur le monde ou la pancarte d'un autre", async () => {
    salle([["agent-01", null], ["agent-02", null]]);
    T.reclamer(t, "agent-02", "app.js", "à moi");
    const pi = instance("agent-01");
    expect(await appel(pi, "write", join(partage, "app.js"))).toBeUndefined();
    expect(await appel(pi, "write", join(dossier, "entrees", "clients.json"))).toBeUndefined();
    expect(await pi.texte("fichier_reclamer", { chemin: "b.js", raison: "x" })).toBe("pancarte posée sur b.js");
  });
});

describe("les outils de la salle : restaurer, adopter, poser une pancarte (tâche 2)", () => {
  test("depot_restaurer : refusé au chef et à un constructeur hors de sa part, avant toute demande au dépôt", async () => {
    salle(APPLICATION);
    await expect(instance("Antoine", "chef").texte("depot_restaurer", { chemin: "app.js", commit: "HEAD", raison: "r" })).rejects.toThrow("outil inconnu"); // outil retiré à ce rôle
    expect(await instance("Claude", "constructeur").texte("depot_restaurer", { chemin: `${partage}/app.js`, commit: "HEAD", raison: "r" }))
      .toBe("refusé : app.js n'est pas ta part. Se lève quand le chef te confie ce chemin, ou dans un essai (depot_essai) proposé à l'intégrateur.");
    expect(t.all("SELECT * FROM demandes_git")).toEqual([]);
  });

  test("depot_adopter : refusé à un constructeur quand il y a un intégrateur ; l'intégrateur dépose sa demande", async () => {
    salle(APPLICATION);
    expect(await instance("Claude", "constructeur").texte("depot_adopter", { nom: "x" })).toBe("refusé : l'adoption d'un essai revient à l'intégrateur, ou au porteur de la pancarte de chaque fichier qu'il change. Se lève quand chaque fichier que l'essai change porte ta pancarte.");
    expect(t.all("SELECT * FROM demandes_git")).toEqual([]);
    process.env.ESSAIM_DEMANDE_MS = "50";
    try {
      expect(await instance("Bernard", "integrateur").texte("depot_adopter", { nom: "x" })).toContain("n'a pas répondu");
    } finally { delete process.env.ESSAIM_DEMANDE_MS; }
  });

  test("fichier_reclamer : le constructeur reçoit ses parts, la recette ne pose rien, l'intégrateur pose", async () => {
    salle(APPLICATION);
    expect(await instance("Claude", "constructeur").texte("fichier_reclamer", { chemin: "a.js", raison: "x" })).toBe("refusé : tes parts te sont confiées par le chef (Antoine). Se lève quand le chef te confie ce chemin.");
    await expect(instance("Fabien", "recette").texte("fichier_reclamer", { chemin: "a.js", raison: "x" })).rejects.toThrow("outil inconnu"); // outil retiré à ce rôle
    expect(await instance("Bernard", "integrateur").texte("fichier_reclamer", { chemin: "contrat.js", raison: "le contrat" })).toBe("pancarte posée sur contrat.js");
    expect(pancartes()).toEqual([["contrat.js", "Bernard"]]);
  });
});

// ---- moi_finir selon le rôle ------------------------------------------------------------------------------
describe("moi_finir selon le rôle (tâche 3)", () => {
  const ctx = (agent: string, o: Partial<ContexteRefus> = {}): ContexteRefus => ({ agent, equipe: membres(APPLICATION), pancartes: [], ...o });

  test("refusDuRole : chef, intégrateur, recette et gardien restent jusqu'au constat ; constructeur, tant qu'il porte un ticket", () => {
    expect(refusDuRole("chef", "moi_finir", undefined, ctx("Antoine"))).toBe("le chef reste jusqu'à la fin du run. Se lève quand le lanceur constate le run accepté ou incomplet");
    expect(refusDuRole("integrateur", "moi_finir", undefined, ctx("Bernard"))).toBe("l'intégrateur reste jusqu'à la fin du run. Se lève quand le lanceur constate le run accepté ou incomplet");
    expect(refusDuRole("chef", "moi_finir", undefined, ctx("Antoine", { runConstate: true }))).toBeUndefined();
    expect(refusDuRole("constructeur", "moi_finir", undefined, ctx("Claude", { ticketsOuverts: [3] }))).toBe("un ticket ouvert t'est confié (#3). Se lève quand ils sont fermés ou confiés à un autre");
    expect(refusDuRole("constructeur", "moi_finir", undefined, ctx("Claude", { ticketsOuverts: [1, 4] }))).toBe("2 tickets ouverts te sont confiés (#1, #4). Se lève quand ils sont fermés ou confiés à un autre");
    expect(refusDuRole("constructeur", "moi_finir", undefined, ctx("Claude", { ticketsOuverts: [] }))).toBeUndefined();
    // La recette et le gardien restent aussi jusqu'au constat, leurs exigences tenues ou non.
    expect(refusDuRole("recette", "moi_finir", undefined, ctx("Fabien"))).toBe("la recette reste jusqu'à la fin du run. Se lève quand le lanceur constate le run accepté ou incomplet");
    expect(refusDuRole("gardien", "moi_finir", undefined, ctx("Gilles"))).toBe("le gardien-mesureur reste jusqu'à la fin du run. Se lève quand le lanceur constate le run accepté ou incomplet");
    expect(refusDuRole("recette", "moi_finir", undefined, ctx("Fabien", { runConstate: true }))).toBeUndefined();
    expect(refusDuRole("gardien", "moi_finir", undefined, ctx("Gilles", { runConstate: true }))).toBeUndefined();
    for (const r of ["le chef reste jusqu'à la fin du run. Se lève quand le lanceur constate le run accepté ou incomplet", "un ticket ouvert t'est confié (#3). Se lève quand ils sont fermés ou confiés à un autre",
      "la recette reste jusqu'à la fin du run. Se lève quand le lanceur constate le run accepté ou incomplet"]) expect(`refusé : ${r}.`).toMatch(FORME);
  });

  test("le chef ne part pas ; il part quand <run>/accepte existe ; moi_dormir lui reste permis", async () => {
    salle(APPLICATION);
    const pi = instance("Antoine", "chef");
    const r = await pi.appeler("moi_finir", { raison: "fait" });
    expect(r.content[0]!.text).toBe("refusé : le chef reste jusqu'à la fin du run. Se lève quand le lanceur constate le run accepté ou incomplet.");
    expect(r.terminate).toBeFalsy();
    expect((await pi.appeler("moi_dormir", { message: "je veille" })).terminate).toBe(true);
    writeFileSync(join(dossier, "accepte"), "");
    expect((await instance("Antoine", "chef").appeler("moi_finir", { raison: "accepté" })).terminate).toBe(true);
  });

  test("constructeur : refusé à chaque appel tant qu'il porte un ticket (plus de « une fois ») ; parti une fois le ticket rendu", async () => {
    salle(APPLICATION);
    await instance("Antoine", "chef").texte("ticket_ouvrir", { type: "question", titre: "le moteur", description: "d", charge: "Claude", chemins: ["moteur.js"] });
    const claude = instance("Claude", "constructeur");
    const refus = "refusé : un ticket ouvert t'est confié (#1). Se lève quand ils sont fermés ou confiés à un autre.";
    expect(await claude.texte("moi_finir", { raison: "fait" })).toBe(refus);
    expect(await claude.texte("moi_finir", { raison: "fait" })).toBe(refus);
    await claude.texte("ticket_modifier", { id: 1, charge: "Antoine" });
    T.poster(t, "Claude", "Antoine : reste-t-il du travail pour moi ?"); // avant de partir, il demande, le chef répond
    T.poster(t, "Antoine", "Claude : rien pour toi");
    expect(await claude.texte("moi_finir", { raison: "fait" })).toStartWith("refusé une fois : des tickets restent ouverts dans la salle."); // le rappel de la salle, comme avant
    expect((await claude.appeler("moi_finir", { raison: "fait" })).terminate).toBe(true);
  });

  test("recette et gardien restent jusqu'au constat, puis partent (A5, 02/10) ; sans rôles, moi_finir comme avant", async () => {
    salle(APPLICATION);
    expect(await instance("Fabien", "recette").texte("moi_finir", { raison: "fait" })).toBe("refusé : la recette reste jusqu'à la fin du run. Se lève quand le lanceur constate le run accepté ou incomplet.");
    expect((await instance("Gilles", "gardien").appeler("moi_finir", { raison: "fait" })).terminate).toBeFalsy();
    writeFileSync(join(dossier, "accepte"), "");
    expect((await instance("Fabien", "recette").appeler("moi_finir", { raison: "fait" })).terminate).toBe(true);
    expect((await instance("Gilles", "gardien").appeler("moi_finir", { raison: "fait" })).terminate).toBe(true);
    T.ouvrirTicket(t, { type: "bug", titre: "carte vide", description: "index.html", auteur: "Antoine", charge: "Denis" });
    const sansRole = instance("Denis");
    expect(await sansRole.texte("moi_finir", { raison: "fait" })).toStartWith("refusé une fois : ces tickets ouverts te sont confiés.");
  });
});
