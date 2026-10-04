// Les jalons d'une exigence : le chef découpe une
// exigence longue en jalons (E4.1, E4.2…) ; elle est attestée quand tous ses jalons le sont. Tableau construit à la main,
// puis les outils au faux pi.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ouvrirBun } from "../src/tableau-bun.ts";
import * as T from "../src/tableau.ts";
import * as P from "../src/preuves.ts";
import { fauxPi } from "./aide/faux-extension-api.ts";
import extension from "../src/outils-essaim.ts";
import * as S from "../src/surveillant.ts";
import { exigencesEtPreuves } from "../src/serveur.ts";
import { formaterBilan } from "../src/lancer.ts";

let dossier: string;
let t: T.Tableau;

beforeEach(() => {
  dossier = mkdtempSync(join(tmpdir(), "essaim-jalons-"));
  t = ouvrirBun(join(dossier, "tableau.sqlite"));
  T.initialiser(t);
  T.ouvrirRun(t, { id: "run", missionChemin: "m.md", missionTexte: "m", modele: "faux/faux", plafondUsd: 1, silenceMin: 15 });
  T.noterPhrases(t, [1, 2, 3, 4, 5].map((n) => ({ n, section: "Mission", texte: `Phrase ${n}.` })));
  for (const n of [1, 2, 3, 4]) T.rangerExigence(t, { phrases: [n], classement: "exigence", responsable: n === 4 ? "gardien" : "recette", par: "Antoine" });
});
afterEach(() => { t.fermer(); rmSync(dossier, { recursive: true, force: true }); });

const signer = (exigence: string, role = "gardien") => T.attester(t, { exigence, agent: "Xavier", role, nature: "mesure", recu: "preuves/1.json", portee: "p" });
const jalonner = (portees: string[], parent = "E4") => {
  const r = T.jalonner(t, { parent, portees, par: "Antoine" });
  if (!r.ok) throw new Error(r.raison);
  return r;
};
const libelles = () => T.jalonsDe(t, "E4").map((j) => j.libelle);

describe("le jalon dans le tableau (§3, §10)", () => {
  test("découper : E4.1 à E4.4, responsable et classement du parent ; E5 suit E4 malgré les jalons", () => {
    const r = jalonner(["p109-300", "p301-500", "p501-700", "p701-878"]);
    expect(r.crees.map((j) => j.libelle)).toEqual(["E4.1", "E4.2", "E4.3", "E4.4"]);
    expect(t.get("SELECT classement, responsable, parent, portee, indice FROM exigences WHERE libelle = 'E4.2'"))
      .toEqual({ classement: "exigence", responsable: "gardien", parent: "E4", portee: "p301-500", indice: 2 });
    expect(T.estDecoupee(t, "E4")).toBe(true);
    expect(T.rangerExigence(t, { phrases: [5], classement: "exigence", responsable: "recette", par: "Antoine" })).toMatchObject({ ok: true, libelle: "E5" });
  });

  test("un indice n'est jamais redonné ; une portée identique garde son libellé et sa signature ; un jalon retiré perd les siennes et ses demandes", () => {
    jalonner(["a", "b", "c"]);
    signer("E4.1"); signer("E4.3");
    t.run("INSERT INTO demandes_rejeu(exigence, commande, demandeur, cree_le) VALUES ('E4.3', 'true', 'Xavier', '2026-10-03T12:00:00.000Z')");
    const r = jalonner(["a", "b"]);
    expect(r.gardes.map((j) => j.libelle)).toEqual(["E4.1", "E4.2"]);
    expect(r.retires.map((j) => j.libelle)).toEqual(["E4.3"]);
    expect(T.attestationDe(t, "E4.1")).toBeDefined();
    expect(T.attestationDe(t, "E4.3")).toBeUndefined();
    expect(t.get<{ etat: string }>("SELECT etat FROM demandes_rejeu WHERE exigence = 'E4.3'")!.etat).toBe("faite");
    // La portée c revient : un indice neuf, sans la vieille signature.
    expect(jalonner(["a", "b", "c"]).crees.map((j) => j.libelle)).toEqual(["E4.4"]);
    expect(libelles()).toEqual(["E4.1", "E4.2", "E4.4"]);
    expect(T.attestationDe(t, "E4.4")).toBeUndefined();
  });

  test("un jalon n'a pas de jalons ; une exigence inconnue ou retirée se refuse", () => {
    jalonner(["a", "b"]);
    expect(T.jalonner(t, { parent: "E4.1", portees: ["x", "y"], par: "Antoine" })).toEqual({ ok: false, raison: "E4.1 est un jalon : un jalon n'a pas de jalons. Définitif pour ce libellé" });
    expect(T.jalonner(t, { parent: "E9", portees: ["x", "y"], par: "Antoine" })).toMatchObject({ ok: false });
  });

  test("le parent retiré par un nouveau rangement emporte ses jalons et leurs signatures", () => {
    jalonner(["a", "b"]);
    signer("E4.1");
    T.rangerExigence(t, { phrases: [4], classement: "contexte", par: "Antoine" });
    expect(libelles()).toEqual([]);
    expect(t.all("SELECT libelle FROM exigences WHERE parent = 'E4' AND retiree_le IS NULL")).toEqual([]);
    expect(T.attestationDe(t, "E4.1")).toBeUndefined();
  });

  test("tri numérique : E4, E4.1, E4.2, …, E4.10, E4.12, E5 ; Number(\"4.10\") rangerait E4.10 avant E4.2", () => {
    jalonner(Array.from({ length: 12 }, (_, i) => `portée ${i + 1}`));
    T.rangerExigence(t, { phrases: [5], classement: "exigence", responsable: "recette", par: "Antoine" });
    const l = T.listerExigences(t).map((e) => e.libelle);
    expect(l.slice(3, 17)).toEqual(["E4", "E4.1", "E4.2", "E4.3", "E4.4", "E4.5", "E4.6", "E4.7", "E4.8", "E4.9", "E4.10", "E4.11", "E4.12", "E5"]);
    expect(T.listerExigences(t).find((e) => e.libelle === "E4.10")).toMatchObject({ parent: "E4", portee: "portée 10", indice: 10, phrases: [] });
  });

  test("tenue sans rien rejouer : 3/4 non, 4/4 oui ; sans découpage, la signature de l'exigence", () => {
    expect(T.exigenceTenue(t, "E4")).toBe(false);
    signer("E4");
    expect(T.exigenceTenue(t, "E4")).toBe(true);
    jalonner(["a", "b", "c", "d"]);
    expect(T.exigenceTenue(t, "E4")).toBe(false); // découpée : la signature de E4 ne compte plus
    for (const j of ["E4.1", "E4.2", "E4.3"]) signer(j);
    expect(T.exigenceTenue(t, "E4")).toBe(false);
    signer("E4.4");
    expect(T.exigenceTenue(t, "E4")).toBe(true);
  });

  test("l'empreinte du découpage change avec une portée, pas sans changement", () => {
    expect(T.empreinteDecoupage(t)).toBe("");
    jalonner(["a", "b"]);
    const e = T.empreinteDecoupage(t);
    jalonner(["a", "b"]);
    expect(T.empreinteDecoupage(t)).toBe(e);
    jalonner(["a", "c"]);
    expect(T.empreinteDecoupage(t)).not.toBe(e);
  });

  test("un ancien tableau sans les colonnes des jalons se lit", () => {
    const vieux = ouvrirBun(join(dossier, "vieux.sqlite"));
    vieux.run("CREATE TABLE exigences(libelle TEXT PRIMARY KEY, classement TEXT, responsable TEXT, range_par TEXT, cree_le TEXT, retiree_le TEXT)");
    vieux.run("CREATE TABLE phrases(n INTEGER PRIMARY KEY, section TEXT, texte TEXT, classement TEXT, exigence TEXT, range_le TEXT)");
    vieux.run("CREATE TABLE contestations(id INTEGER PRIMARY KEY, exigence TEXT, phrases TEXT, raison TEXT, par TEXT, ticket_id INTEGER, cree_le TEXT)");
    vieux.run("CREATE TABLE tickets(id INTEGER PRIMARY KEY, etat TEXT)");
    vieux.run("INSERT INTO exigences VALUES ('E1', 'exigence', 'recette', 'Antoine', 'x', NULL)");
    expect(T.listerExigences(vieux).map((e) => e.libelle)).toEqual(["E1"]);
    expect(T.jalonsDe(vieux, "E1")).toEqual([]);
    expect(T.empreinteDecoupage(vieux)).toBe("");
    vieux.fermer();
  });
});

describe("l'état d'une exigence découpée (§5)", () => {
  const nonVerifie = (exigence: string) => T.attester(t, { exigence, agent: "Xavier", role: "gardien", nature: "mesure", recu: null, portee: "pas mesurable" });
  test("le pire état de ses jalons remonte (non vérifiée avant à prouver) ; sans jalon, l'exigence elle-même", () => {
    T.ajouterAgent(t, "Xavier", join(dossier, "Xavier"), undefined, undefined, { role: "gardien" });
    const etat = () => P.etatDesExigences(t, dossier).find((e) => e.libelle === "E4")!;
    expect(etat()).toMatchObject({ etat: "a_prouver" });
    expect(etat().jalons).toBeUndefined();
    jalonner(["a", "b", "c"]);
    expect(etat()).toMatchObject({ etat: "a_prouver", jalons: { attestes: 0, total: 3, restants: ["E4.1", "E4.2", "E4.3"] } });
    nonVerifie("E4.2");
    expect(etat()).toMatchObject({ etat: "non_verifiee", jalons: { attestes: 0, total: 3 } }); // non vérifiée passe avant à prouver
    expect(P.etatDesFeuilles(t, dossier).map((f) => f.libelle)).toEqual(["E1", "E2", "E3", "E4.1", "E4.2", "E4.3"]);
    expect(P.etatDesExigences(t, dossier).map((e) => e.libelle)).toEqual(["E1", "E2", "E3", "E4"]);
  });

  // L'ordre entier : rejeu échoué, périmée, non vérifiée, à prouver, à rejouer ; attestée si rien d'autre.
  test("le pire état : chaque état l'emporte sur tous ceux qui le suivent", () => {
    const ordre = ["rejeu_echoue", "perimee", "non_verifiee", "a_prouver", "a_rejouer"] as const;
    ordre.forEach((x, i) => { for (const y of [...ordre.slice(i + 1), "attestee" as const]) { expect(P.pireEtat([y, x, "attestee"])).toBe(x); expect(P.pireEtat([x, y])).toBe(x); } });
    expect(P.pireEtat(["attestee", "attestee"])).toBe("attestee");
    expect(P.texteJalons({ attestes: 2, total: 4, restants: ["E4.3", "E4.4"] })).toBe("2/4 jalons, reste E4.3, E4.4");
  });
});

describe("les outils (§4, §6) au faux pi", () => {
  let partage: string;
  const ENV = ["ESSAIM_AGENT", "ESSAIM_TABLEAU", "ESSAIM_PARTAGE", "ESSAIM_ROLE", "ESSAIM_TOUR_MS", "ESSAIM_RUN"];
  let avant: Record<string, string | undefined> = {};
  const ROLES: Record<string, string> = { Antoine: "chef", Valentin: "recette", Xavier: "gardien" };
  const outil = (agent: string, nom: string, args: object) => {
    Object.assign(process.env, { ESSAIM_AGENT: agent, ESSAIM_TABLEAU: join(dossier, "tableau.sqlite"), ESSAIM_PARTAGE: partage, ESSAIM_ROLE: ROLES[agent]!, ESSAIM_TOUR_MS: "0" });
    const pi = fauxPi();
    extension(pi.api, ouvrirBun);
    return pi.texte(nom, args);
  };
  beforeEach(() => {
    avant = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    partage = join(dossier, "partage");
    mkdirSync(partage);
    for (const [nom, role] of Object.entries(ROLES)) T.ajouterAgent(t, nom, join(dossier, "agents", nom), undefined, undefined, { role });
  });
  afterEach(() => { for (const [k, v] of Object.entries(avant)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });

  test("pendant la préparation : découper, refaire d'un bloc ; exigence_lister montre la progression ; ranger ses phrases en entier est permis", async () => {
    T.ouvrirPreparation(t);
    expect(await outil("Antoine", "exigence_jalonner", { exigence: "E4", jalons: ["pages 109 à 300", "pages 301 à 878"] }))
      .toBe("E4 découpée en 2 jalons · créés : E4.1 (pages 109 à 300), E4.2 (pages 301 à 878)");
    signer("E4.1");
    expect(await outil("Antoine", "exigence_jalonner", { exigence: "E4", jalons: ["pages 109 à 300", "pages 301 à 600", "pages 601 à 878"] }))
      .toBe("E4 découpée en 3 jalons · gardés avec leurs preuves : E4.1 (pages 109 à 300) · créés : E4.3 (pages 301 à 600), E4.4 (pages 601 à 878) · retirés, preuves révoquées : E4.2 (pages 301 à 878)");
    const liste = await outil("Antoine", "exigence_lister", {});
    expect(liste).toContain("E4 · exigence · contrôle : gardien-mesureur (Xavier) · phrases 4 · 0/3 jalons attestés"); // la signature de E4.1 n'a pas de reçu ici : gardée, mais périmée
    expect(liste).toContain("  E4.1 · portée : pages 109 à 300 · périmée\n  E4.3 · portée : pages 301 à 600 · à prouver");
    expect(await outil("Antoine", "exigence_ranger", { phrases: [4, 5], classement: "exigence", responsable: "recette" })).not.toStartWith("refusé"); // en entier, en préparation : permis
    expect(T.jalonsDe(t, "E4")).toEqual([]); // E4 retirée, ses jalons avec elle
  });

  test("pendant une révision : une exigence ancienne refusée, une rangée depuis l'acceptation permise", async () => {
    t.run("UPDATE exigences SET cree_le = '2026-10-01T00:00:00.000Z'");
    t.run("INSERT INTO revisions(demandeur, constat, tickets_json, etat, cree_le, repondu_le, tickets_geles_json) VALUES ('Yves', 'c', '[]', 'acceptee', ?, ?, '[]')", [new Date().toISOString(), new Date(Date.now() - 1000).toISOString()]);
    expect(await outil("Antoine", "exigence_jalonner", { exigence: "E4", jalons: ["a", "b"] })).toStartWith("refusé : E4 est rangée d'avant la révision");
    T.rangerExigence(t, { phrases: [5], classement: "exigence", responsable: "gardien", par: "Antoine" });
    expect(await outil("Antoine", "exigence_jalonner", { exigence: "E5", jalons: ["a", "b"] })).toStartWith("E5 découpée en 2 jalons");
    // Un jalon n'est pas une exigence de la spec : il ne se déclare pas changé.
    writeFileSync(join(partage, "SPEC.md"), "# Spec");
    expect(await outil("Antoine", "plan_proposer", { etape: "spec", resume: "r", exigences_changees: ["E5.1"] })).toStartWith("refusé : l'exigence E5.1 est inconnue ou retirée");
    expect(await outil("Antoine", "plan_proposer", { etape: "spec", resume: "r", exigences_changees: ["E5"] })).not.toStartWith("refusé");
  });

  test("hors de la préparation : un rangement qui touche une exigence découpée est refusé ; preuve_lister montre les jalons", async () => {
    jalonner(["a", "b"]);
    expect(await outil("Antoine", "exigence_ranger", { phrases: [4], classement: "contexte" })).toStartWith("refusé : E4 est découpée en jalons");
    const l = await outil("Xavier", "preuve_lister", {});
    expect(l).toContain("E4 · contrôle : gardien-mesureur (Xavier) · 0/2 jalons attestés");
    expect(l).toContain("  E4.1 (a) · à prouver");
  });

  test("la couverture au jugement : le découpage changé depuis la proposition est refusé ; le message aux contrôleurs donne phrases et jalons", async () => {
    T.ouvrirPreparation(t);
    writeFileSync(join(partage, "SPEC.md"), "# Spec");
    await outil("Antoine", "exigence_jalonner", { exigence: "E4", jalons: ["a", "b"] });
    expect(await outil("Antoine", "plan_proposer", { etape: "spec", resume: "r" })).toStartWith("spec n°1 proposée");
    expect(t.get<{ texte: string }>("SELECT texte FROM messages WHERE auteur = 'lanceur' ORDER BY id DESC")!.texte).toContain("Découpages à juger : E4 : [4] Phrase 4. Jalons : E4.1 (a), E4.2 (b).");
    await outil("Antoine", "exigence_jalonner", { exigence: "E4", jalons: ["a", "c"] });
    expect(await outil("Valentin", "plan_juger", { plan: 1, verdict: "valide", raison: "r" })).toStartWith("refusé : le découpage a changé depuis la proposition n°1. Se lève avec une nouvelle proposition.");
  });
});

test("contester un jalon : la question cite sa portée et les phrases de son parent", () => {
  jalonner(["pages 109 à 300", "pages 301 à 878"]);
  const r = T.contesterExigence(t, { exigence: "E4.2", raison: "la portée oublie les notes", par: "Xavier", chef: "Antoine" });
  expect(r.ok).toBe(true);
  expect(T.lireTicket(t, (r as { ticket: number }).ticket)!.description).toBe("la portée oublie les notes\nE4.2 est un jalon de E4, portée : pages 301 à 878\n[4] (Mission, rangée : E4) Phrase 4.");
});

describe("le surveillant (§9)", () => {
  const MIN = 60_000;
  const maintenant = Date.parse("2026-10-03T12:00:00.000Z");
  const il_y_a = (min: number) => new Date(maintenant - min * MIN).toISOString();
  const signerIlYa = (exigence: string, min: number) => t.run("INSERT INTO attestations(exigence, agent, role, nature, recu, non_verifiee, portee, cree_le) VALUES (?, 'Xavier', 'gardien', 'mesure', 'preuves/1.json', 0, 'p', ?)", [exigence, il_y_a(min)]);
  const codes = () => S.signes(t, { maintenantMs: maintenant }).map((x) => x.code);
  beforeEach(() => {
    t.run("UPDATE run SET debut = ?", [il_y_a(300)]);
    t.run("INSERT INTO plans(auteur, resume, cree_le, etape, valide_le) VALUES ('Antoine', 'p', ?, 'plan', ?)", [il_y_a(201), il_y_a(200)]);
    for (const e of ["E1", "E2", "E3"]) signerIlYa(e, 100);
    t.run("INSERT INTO essais(nom, auteur, dossier, cree_le, adopte_le) VALUES ('x', 'Claude', 'x', ?, ?)", [il_y_a(5), il_y_a(5)]); // S1 éteint
  });
  test("S4 : allumé sans progrès ; un jalon attesté il y a 10 min l'éteint ; tous les jalons attestés, muet même sans signature de E4", () => {
    jalonner(["a", "b", "c"]);
    signerIlYa("E4.1", 100);
    expect(codes()).toContain("S4"); // 100 min sans première attestation
    signerIlYa("E4.2", 10);
    expect(codes()).not.toContain("S4"); // E4.3 reste, mais E4.2 est un progrès récent
    signerIlYa("E4.3", 100);
    t.run("UPDATE attestations SET cree_le = ? WHERE exigence = 'E4.2'", [il_y_a(100)]);
    expect(codes()).not.toContain("S4"); // tout est tenu : E4 par ses jalons, sans signature d'elle-même
  });
  test("S2 : trois rejeux échoués du même jalon en 30 min", () => {
    jalonner(["a", "b"]);
    for (const m of [20, 10, 5]) t.run("INSERT INTO evenements(agent, horodatage, type, resultat_resume) VALUES ('lanceur', ?, 'rejeu_echoue', 'E4.2 n''est plus attestée : x')", [il_y_a(m)]);
    expect(S.signes(t, { maintenantMs: maintenant }).find((x) => x.code === "S2")).toMatchObject({ cible: "E4.2" });
  });
});

test("la vue : une exigence découpée avec son compte et ses jalons, sans signature à elle ; une alerte de jalon sous son parent", () => {
  jalonner(["a", "b"]);
  T.ajouterAgent(t, "Xavier", join(dossier, "Xavier"), undefined, undefined, { role: "gardien" });
  T.attester(t, { exigence: "E4.1", agent: "Xavier", role: "gardien", nature: "mesure", recu: null, portee: "pas mesurable" });
  T.ouvrirTicket(t, { type: "bug", titre: "page 120", description: "d", auteur: "Xavier", charge: "Antoine", sorte: "alerte", exigence: "E4.1", reproduction: { commande: "true", graine: null, commit: "0".repeat(40), banc: {}, monde: {} } });
  const e = exigencesEtPreuves(t, dossier).exigences.find((x) => x.libelle === "E4")!;
  expect(e.jalons).toEqual({ attestes: 0, total: 2, liste: [{ libelle: "E4.1", portee: "a", etat: "non_verifiee" }, { libelle: "E4.2", portee: "b", etat: "a_prouver" }] });
  expect(e.attestation).toBeNull();
  expect(e.alertes_ouvertes.map((k) => k.id)).toEqual([1]);
});

test("le bilan : les jalons de chaque exigence découpée, et un découpage non jugé", () => {
  expect(formaterBilan({ finis: 0, vires: 0, perdus: 0, depense: 0, plafond: 1, run: "r", jalons: [{ exigence: "E4", attestes: 3, total: 4, restants: ["E4.4"] }], decoupageNonJuge: true } as never))
    .toContain("\njalons : E4 (3/4 jalons, reste E4.4) ; découpage non jugé (validé sans contrôleur présent)");
});
