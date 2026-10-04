// Second cerveau : les faits de vérification écrits par l'outil qui vérifie, dans l'extension,
// avec l'empreinte du contenu avant et après le contrôle. Extension réelle sur le faux ExtensionAPI
// enchaîné comme pi ; navigateur réel pour page_voir et moi_finir (sautés s'il manque), bun réel pour code_tester.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ouvrirBun } from "../src/tableau-bun.ts";
import * as T from "../src/tableau.ts";
import { cheminNavigateur } from "../src/voir.ts";
import extension from "../src/outils-essaim.ts";
import { fauxPi } from "./aide/faux-extension-api.ts";
import { motsInterdits } from "./aide/mots-interdits.ts";

let dossier: string;
let partage: string;
let chemin: string;
let t: T.Tableau;
const navigateur = cheminNavigateur() !== undefined;

type Fait = { id: number; type: string; agent: string; source: string; sujet: string | null; statut: string | null; texte: string; details: Record<string, unknown> };
const verifications = (): Fait[] => t.all<Omit<Fait, "details"> & { details_json: string | null }>("SELECT * FROM faits WHERE type = 'verification' ORDER BY id")
  .map(({ details_json, ...f }) => ({ ...f, details: details_json ? JSON.parse(details_json) : {} }));
const hashObject = (f: string) => spawnSync("git", ["hash-object", f], { encoding: "utf8" }).stdout.trim();

function instance(agent = "Bernard") {
  process.env.ESSAIM_AGENT = agent;
  process.env.ESSAIM_TABLEAU = chemin;
  process.env.ESSAIM_PARTAGE = partage;
  process.env.ESSAIM_BUREAU = join(dossier, "agents", agent);
  const faux = fauxPi();
  extension(faux.api, ouvrirBun);
  return faux;
}
const ecrire = (fichiers: Record<string, string>, racine = partage) => {
  for (const [f, c] of Object.entries(fichiers)) { mkdirSync(join(racine, f, ".."), { recursive: true }); writeFileSync(join(racine, f), c); }
};
const PAGE = {
  "index.html": '<!doctype html><html><head><title>I</title><link rel="stylesheet" href="style.css"></head><body><p>bonjour</p><script src="app.js"></script></body></html>',
  "app.js": "document.body.dataset.ok = '1';\n",
  "style.css": "p { color: #222; }\n",
  "autre.js": "// jamais chargé\n",
};

beforeEach(() => {
  process.env.ESSAIM_TOUR_MS = "0";
  dossier = mkdtempSync(join(tmpdir(), "essaim-verif-"));
  partage = join(dossier, "partage");
  chemin = join(dossier, "tableau.sqlite");
  mkdirSync(partage);
  mkdirSync(join(dossier, "agents", "Bernard"), { recursive: true });
  t = ouvrirBun(chemin);
  T.initialiser(t);
  T.ouvrirRun(t, { id: "run-test", missionChemin: "m.md", missionTexte: "texte", modele: "faux/faux", plafondUsd: 0.5, silenceMin: 15 });
  T.ajouterAgent(t, "Bernard", join(dossier, "agents", "Bernard"));
});
afterEach(() => {
  delete process.env.ESSAIM_TOUR_MS;
  delete process.env.ESSAIM_TEST_CROCHET_VOIR;
  t.fermer();
  rmSync(dossier, { recursive: true, force: true });
});

describe("page_voir : un fait de vérification sur la page et ce qu'elle a chargé (M5)", () => {
  test.skipIf(!navigateur)("un détour par essais/.. ne fait pas du run entier un essai : refusé, aucun fait sur le run (29/09, revue F18)", async () => {
    ecrire(PAGE);
    // Avant : racine = le run, empreintes de tout le run, fait au sujet « partage/index.html ». Maintenant : refusé.
    expect(await instance().texte("page_voir", { page: `${dossier}/essais/../partage/index.html` })).toContain("est hors du dossier partagé");
    expect(verifications()).toEqual([]);
  }, 30_000);
  test.skipIf(!navigateur)("page saine : vérifié, contenu = la page et ses fichiers chargés, empreintes avant et après", async () => {
    ecrire(PAGE);
    await instance().texte("page_voir", { page: "index.html" });
    const [f, ...reste] = verifications();
    expect(reste).toEqual([]);
    expect(f).toMatchObject({ agent: "Bernard", source: "page_voir", sujet: "index.html", statut: "verifie" });
    expect(f!.texte).toBe("vérifié · page_voir index.html · page saine (0) · Bernard · contenu : index.html, style.css, app.js");
    expect(f!.details).toMatchObject({ code: 0, racine: "partage", fichiers: ["index.html", "style.css", "app.js"] });
    const apres = f!.details.apres as Record<string, { blob: string }>;
    expect(Object.keys(apres).sort()).toEqual(["app.js", "index.html", "style.css"]); // autre.js n'est pas contrôlé
    expect(apres["app.js"]!.blob).toBe(hashObject(join(partage, "app.js")));
    expect(Object.keys(f!.details.avant as object).sort()).toEqual(["app.js", "index.html", "style.css"]);
    expect(motsInterdits(f!.texte)).toEqual([]);
  }, 30_000);

  test.skipIf(!navigateur)("page en erreur : échoué, avec le code ; la capture écrite par le contrôle n'est pas du contenu", async () => {
    ecrire({ "e.html": "<body><p>x</p><script>console.error('boum')</script></body>" });
    await instance().texte("page_voir", { page: "e.html", capture: "cap.png" });
    const [f] = verifications();
    expect(f).toMatchObject({ statut: "echoue", sujet: "e.html" });
    expect(f!.texte).toBe("échoué · page_voir e.html · erreurs (1) · Bernard · contenu : e.html");
    expect(f!.details).toMatchObject({ code: 1, fichiers: ["e.html"] });
  }, 30_000);

  test.skipIf(!navigateur)("un fichier chargé réécrit pendant le contrôle → inconnu ; réécrit puis remis identique → instable ; un fichier non chargé ne compte pas", async () => {
    ecrire(PAGE);
    const pi = instance();
    process.env.ESSAIM_TEST_CROCHET_VOIR = JSON.stringify({ fichier: "app.js", contenu: "document.body.dataset.ok = '2';\n" });
    await pi.texte("page_voir", { page: "index.html" });
    process.env.ESSAIM_TEST_CROCHET_VOIR = JSON.stringify({ fichier: "app.js", contenu: "réécrit", remettre: true });
    await pi.texte("page_voir", { page: "index.html" });
    process.env.ESSAIM_TEST_CROCHET_VOIR = JSON.stringify({ fichier: "autre.js", contenu: "réécrit" });
    await pi.texte("page_voir", { page: "index.html" });
    const [inconnu, instable, verifie] = verifications();
    expect(inconnu).toMatchObject({ statut: "inconnu" });
    expect(inconnu!.texte).toEndWith(" · contenu changé pendant le contrôle : app.js");
    expect(instable).toMatchObject({ statut: "instable" });
    expect(instable!.texte).toEndWith(" · réécrit pendant le contrôle, même contenu : app.js");
    expect(verifie).toMatchObject({ statut: "verifie" });
  }, 60_000);

  test("un refus n'écrit aucun fait ; une panne du navigateur non plus", async () => {
    const pi = instance();
    await pi.texte("page_voir", { page: "absente.html" });
    ecrire(PAGE);
    const avant = process.env.PLAYWRIGHT_BROWSERS_PATH;
    process.env.PLAYWRIGHT_BROWSERS_PATH = join(dossier, "cache-vide");
    try {
      await expect(pi.appeler("page_voir", { page: "index.html" })).rejects.toThrow();
    } finally {
      if (avant === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH; else process.env.PLAYWRIGHT_BROWSERS_PATH = avant;
    }
    expect(verifications()).toEqual([]);
  });

  test.skipIf(!navigateur)("une page d'essai est empreintée dans l'essai", async () => {
    const essai = join(dossier, "essais", "menu-2");
    ecrire(PAGE, essai);
    await instance().texte("page_voir", { page: join(essai, "index.html") });
    const [f] = verifications();
    expect(f).toMatchObject({ statut: "verifie", sujet: "index.html" });
    expect(f!.details).toMatchObject({ racine: "essai:menu-2", fichiers: ["index.html", "style.css", "app.js"] });
    expect(f!.texte).toStartWith("vérifié · page_voir index.html (essai menu-2) · page saine (0) · Bernard");
  }, 30_000);
});

const TEST = 'import { test, expect } from "bun:test";\n';
describe("code_tester : un fait avec le bilan chiffré, tout le dossier empreinté (M4)", () => {
  test("tout le dossier : vérifié, chiffres, empreinte de chaque fichier du dossier", async () => {
    ecrire({ "a.test.ts": `${TEST}test("un", () => expect(1).toBe(1));\n`, "b.test.ts": `${TEST}test("deux", () => expect(2).toBe(2));\n`, "app.js": "x\n" });
    await instance().texte("code_tester", {});
    const [f] = verifications();
    expect(f).toMatchObject({ source: "code_tester", sujet: "tests (tout le dossier)", statut: "verifie" });
    expect(f!.texte).toBe("vérifié · code_tester tests (tout le dossier) · 2 réussis, 0 échoué · Bernard");
    expect(f!.details).toMatchObject({ racine: "partage", bilan: { pass: 2, fail: 0, ran: 2 }, fichiers: ["a.test.ts", "app.js", "b.test.ts"] });
    expect(motsInterdits(f!.texte)).toEqual([]);
  }, 60_000);
  test("un seul fichier : échoué, sujet = le fichier, empreinte de tout le dossier quand même", async () => {
    ecrire({ "a.test.ts": `${TEST}test("un", () => expect(1).toBe(1));\ntest("caisse", () => expect(229).toBe(319));\n`, "b.test.ts": `${TEST}test("deux", () => expect(2).toBe(2));\n` });
    await instance().texte("code_tester", { fichier: "a.test.ts" });
    const [f] = verifications();
    expect(f).toMatchObject({ sujet: "tests (fichier a.test.ts)", statut: "echoue" });
    expect(f!.texte).toBe("échoué · code_tester tests (fichier a.test.ts) · 1 réussi, 1 échoué · Bernard");
    expect(f!.details.fichiers).toEqual(["a.test.ts", "b.test.ts"]);
  }, 60_000);
  test("fichier introuvable : un refus, aucun fait", async () => {
    await instance().texte("code_tester", { fichier: "absent.test.ts" });
    expect(verifications()).toEqual([]);
  });
});

describe("moi_finir : le contrôle du livrable est une vérification (P12, M5)", () => {
  const livrable = (f: string | undefined, corps: () => Promise<void>) => async () => {
    const avant = process.env.ESSAIM_LIVRABLE;
    if (f === undefined) delete process.env.ESSAIM_LIVRABLE; else process.env.ESSAIM_LIVRABLE = f;
    try { await corps(); } finally { if (avant === undefined) delete process.env.ESSAIM_LIVRABLE; else process.env.ESSAIM_LIVRABLE = avant; }
  };
  test.skipIf(!navigateur)("code 0 : vérifié, source moi_finir, puis le départ", livrable("index.html", async () => {
    ecrire(PAGE);
    expect(await instance().texte("moi_finir", { raison: "livré" })).toContain("session terminée");
    const [f] = verifications();
    expect(f).toMatchObject({ source: "moi_finir", sujet: "index.html", statut: "verifie" });
    expect(f!.texte).toBe("vérifié · moi_finir index.html · page saine (0) · Bernard · contenu : index.html, style.css, app.js");
    expect(f!.details).toMatchObject({ code: 0, parcours: true });
  }), 60_000);
  test.skipIf(!navigateur)("code 1 : échoué, écrit avant le refus qui retient l'agent", livrable("index.html", async () => {
    ecrire({ "index.html": "<body><p>x</p><script>console.error('boum')</script></body>" });
    expect(await instance().texte("moi_finir", { raison: "livré" })).toStartWith("refusé : le livrable index.html ne s'ouvre pas sans erreur.");
    const [f] = verifications();
    expect(f).toMatchObject({ source: "moi_finir", statut: "echoue" });
    expect(t.get<{ etat: string }>("SELECT etat FROM agents WHERE nom = 'Bernard'")!.etat).not.toBe("fini");
  }), 60_000);
  test("livrable absent, ou navigateur absent : aucun fait", livrable("index.html", async () => {
    const pi = instance();
    expect(await pi.texte("moi_finir", { raison: "livré" })).toStartWith("refusé : le livrable index.html est absent");
    ecrire(PAGE);
    const avant = process.env.PLAYWRIGHT_BROWSERS_PATH;
    process.env.PLAYWRIGHT_BROWSERS_PATH = join(dossier, "cache-vide");
    try { expect(await pi.texte("moi_finir", { raison: "livré" })).toContain("session terminée"); }
    finally { if (avant === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH; else process.env.PLAYWRIGHT_BROWSERS_PATH = avant; }
    expect(verifications()).toEqual([]);
  }));
});

describe("dossierDeTest : la racine d'un bun test par le cd de tête (R3)", () => {
  test("le dossier du cd de tête, guillemets retirés ; aucun autre cd avant bun test ; deux bun test signalés", () => {
    expect(T.dossierDeTest("cd /x/partage && bun test")).toEqual({ dossier: "/x/partage" });
    expect(T.dossierDeTest(`cd "/x/par tage" && bun test 2>&1 | tail -3`)).toEqual({ dossier: "/x/par tage" });
    expect(T.dossierDeTest("cd '~/partage' && ls && bun test ./a.test.js")).toEqual({ dossier: "~/partage" });
    expect(T.dossierDeTest("cd /x && bun test a && bun test b")).toEqual({ dossier: "/x", plusieurs: true });
    expect(T.dossierDeTest("bun test")).toBeUndefined();
    expect(T.dossierDeTest("cd /x && cd sous && bun test")).toBeUndefined();
    expect(T.dossierDeTest("cd /x && ls; cd .. && bun test")).toBeUndefined();
    expect(T.dossierDeTest("ls; cd /x && bun test")).toBeUndefined();
    expect(T.dossierDeTest("cd /x && ls")).toBeUndefined();
  });
});

// Une sortie réelle : `| tail -3`, sans ligne pass.
const SORTIE_B = "bilan.js\nmoteur.js\nmoteur.test.js\nnavigation.js\nvue-ligne.js\nvues-trajet.js\n 0 fail\n 7694 expect() calls\nRan 71 tests across 4 files. [19.00ms]\n";
describe("bash + bun test : un fait de vérification, racine par cd en tête (M6, R3)", () => {
  const bash = async (pi: ReturnType<typeof fauxPi>, commande: string, sortie: string, id = "b-1") => {
    await pi.emettre("tool_call", { type: "tool_call", toolName: "bash", toolCallId: id, input: { command: commande } });
    await pi.emettre("tool_result", { type: "tool_result", toolName: "bash", toolCallId: id, input: { command: commande }, content: [{ type: "text", text: sortie }], details: {}, isError: false });
  };
  test("la sortie de B → vérifié, « 71 tests lancés, 0 échoué », tout le dossier ré-énuméré, la commande en détail", async () => {
    ecrire({ "moteur.test.js": "x", "moteur.js": "y" });
    const pi = instance();
    const commande = `cd ${partage} && bun test 2>&1 | tail -3`;
    await bash(pi, commande, SORTIE_B);
    const [f, ...reste] = verifications();
    expect(reste).toEqual([]);
    expect(f).toMatchObject({ source: "bash", statut: "verifie", sujet: "tests (bun test)" });
    expect(f!.texte).toBe("vérifié · bash tests (bun test) · 71 tests lancés, 0 échoué · Bernard");
    expect(f!.details).toMatchObject({ commande, racine: "partage", bilan: { fail: 0, ran: 71 }, fichiers: ["moteur.js", "moteur.test.js"] });
    expect(motsInterdits(f!.texte)).toEqual([]);
  });
  test("une ligne errors dans la queue → échoué ; | head → inconnu ; deux bun test → inconnu", async () => {
    const pi = instance();
    await bash(pi, `cd ${partage} && bun test | tail -4`, " 0 fail\n 1 error\n 3 expect() calls\nRan 3 tests across 1 file. [5.00ms]\n", "b-1");
    await bash(pi, `cd ${partage} && bun test | head -5`, "bun test v1.4.2\n\nmoteur.test.js:\n(pass) un [0.1ms]\n(pass) deux\n", "b-2");
    await bash(pi, `cd ${partage} && bun test a.test.js && bun test b.test.js`, SORTIE_B, "b-3");
    expect(verifications().map((f) => f.statut)).toEqual(["echoue", "inconnu", "inconnu"]);
    expect(verifications()[1]!.texte).toBe("inconnu · bash tests (bun test) · bilan non lu · Bernard");
  });
  test("aucun fait : sans cd en tête, cd vers un sous-dossier ou hors du dossier commun, second cd, commande sans bun test", async () => {
    mkdirSync(join(partage, "tests"));
    const pi = instance();
    await bash(pi, "bun test", SORTIE_B, "b-1");
    await bash(pi, `cd ${join(partage, "tests")} && bun test`, SORTIE_B, "b-2");
    await bash(pi, `cd ${dossier} && bun test`, SORTIE_B, "b-3");
    await bash(pi, `cd ${partage} && cd tests && bun test`, SORTIE_B, "b-4");
    await bash(pi, `cd ${partage} && ls`, SORTIE_B, "b-5");
    expect(verifications()).toEqual([]);
  });
  test("cd relatif au bureau : résolu, égalité exacte avec le dossier commun", async () => {
    const pi = instance();
    await bash(pi, "cd ../../partage && bun test", SORTIE_B, "b-1");
    expect(verifications()).toHaveLength(1);
  });
  test("deux appels qui se croisent sont appariés par toolCallId ; un essai ouvert est une racine", async () => {
    const essai = join(dossier, "essais", "menu-2");
    ecrire({ "e.test.js": "e" }, essai);
    ecrire({ "p.test.js": "p" });
    t.transaction(() => T.noterEssai(t, "menu-2", "Bernard", "r", essai));
    const pi = instance();
    const ev = (id: string, commande: string, sortie?: string) => sortie === undefined
      ? pi.emettre("tool_call", { type: "tool_call", toolName: "bash", toolCallId: id, input: { command: commande } })
      : pi.emettre("tool_result", { type: "tool_result", toolName: "bash", toolCallId: id, input: { command: commande }, content: [{ type: "text", text: sortie }], details: {}, isError: sortie !== SORTIE_B });
    const a = `cd ${partage} && bun test`, b = `cd ${essai} && bun test`;
    await ev("A", a);
    await ev("B", b);
    await ev("B", b, " 2 fail\nRan 5 tests across 1 file.\n");
    await ev("A", a, SORTIE_B);
    const [fb, fa] = verifications();
    expect(fb).toMatchObject({ statut: "echoue" });
    expect(fb!.details).toMatchObject({ racine: "essai:menu-2", fichiers: ["e.test.js"] });
    expect(fb!.texte).toBe("échoué · bash tests (bun test) (essai menu-2) · 5 tests lancés, 2 échoués · Bernard");
    expect(fa).toMatchObject({ statut: "verifie" });
    expect(fa!.details).toMatchObject({ racine: "partage", fichiers: ["p.test.js"] });
  });
  test("un fichier créé pendant les tests → inconnu (dossier ré-énuméré)", async () => {
    const pi = instance();
    const commande = `cd ${partage} && bun test`;
    await pi.emettre("tool_call", { type: "tool_call", toolName: "bash", toolCallId: "c", input: { command: commande } });
    ecrire({ "nouveau.js": "n" });
    await pi.emettre("tool_result", { type: "tool_result", toolName: "bash", toolCallId: "c", input: { command: commande }, content: [{ type: "text", text: SORTIE_B }], details: {}, isError: false });
    const [f] = verifications();
    expect(f).toMatchObject({ statut: "inconnu" });
    expect(f!.texte).toEndWith(" · contenu changé pendant le contrôle : nouveau.js");
  });
  test("le gestionnaire ne change pas le résultat de bash", async () => {
    const pi = instance();
    await pi.emettre("tool_call", { type: "tool_call", toolName: "bash", toolCallId: "c", input: { command: `cd ${partage} && bun test` } });
    const r = await pi.emettre("tool_result", { type: "tool_result", toolName: "bash", toolCallId: "c", input: {}, content: [{ type: "text", text: SORTIE_B }], details: {}, isError: false });
    expect(r).toBeUndefined();
  });
});

describe("sous Node, comme dans pi (M13, phase 5)", () => {
  test("code_tester écrit son fait sous node:sqlite, et le blob calculé égale celui de git", () => {
    const aide = new URL("./aide/memoire-node.ts", import.meta.url).pathname;
    const r = Bun.spawnSync(["node", "--no-warnings", "--experimental-strip-types", aide, chemin, "5", partage],
      { env: { ...process.env, ESSAIM_TEST: "1", ESSAIM_TOUR_MS: "0" } });
    expect(r.stderr.toString()).toBe("");
    const { phase5 } = JSON.parse(r.stdout.toString());
    expect(phase5).toMatchObject({ statut: "verifie", fait: "vérifié · code_tester tests (tout le dossier) · 1 réussi, 0 échoué · Bernard", blobEgal: true });
    expect(phase5.texte).toStartWith("1 réussi · 0 échoué");
  }, 60_000);
});
