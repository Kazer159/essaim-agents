import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, statSync, symlinkSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { creerServeur, ECRIT_DEPUIS, validerRun, type EcritDepuis, type Serveur } from "../src/serveur.ts";
import { ouvrirBun } from "../src/tableau-bun.ts";
import * as T from "../src/tableau.ts";
import * as P from "../src/preuves.ts";
import { DROITS, ROLES } from "../src/roles.ts";
import { ANCIEN_VERS_NOUVEAU, ANCIENS_OUTILS_SALLE, OUTILS_PI, OUTILS_RETIRES, OUTILS_SALLE, nouveauNom } from "../src/noms-outils.ts";

let racine: string;
let serveur: Serveur;

const SHA_ENTREE = new Bun.CryptoHasher("sha256").update("# doc\n").digest("hex");
function construireRun(nom: string, options: { termine?: boolean; entrees?: boolean } = {}) {
  const dossier = join(racine, "runs", nom);
  mkdirSync(dossier, { recursive: true });
  const t = ouvrirBun(join(dossier, "tableau.sqlite"));
  T.initialiser(t);
  T.ouvrirRun(t, { id: nom, missionChemin: "missions/x.md", missionTexte: `mission de ${nom}`, modele: "faux/faux", plafondUsd: 0.5, silenceMin: 15,
    entreesJson: options.entrees ? JSON.stringify([{ nom: "doc.md", taille: 6, sha256: SHA_ENTREE }]) : undefined });
  if (options.entrees) { mkdirSync(join(dossier, "entrees"), { recursive: true }); writeFileSync(join(dossier, "entrees", "doc.md"), "# doc\n"); }
  T.ajouterAgent(t, "agent-01", join(dossier, "agents", "agent-01"));
  T.ajouterAgent(t, "agent-02", join(dossier, "agents", "agent-02"));
  T.poster(t, "agent-01", "un");
  T.poster(t, "agent-02", "deux");
  T.poster(t, "agent-01", "trois", "design");
  T.poster(t, "agent-02", "quatre");
  T.majAgent(t, "agent-01", { coutUsd: 0.01, tokensEntree: 100, tokensSortie: 10, appels: 3, echecs: 1 });
  T.majAgent(t, "agent-02", { coutUsd: 0.02, tokensEntree: 200, tokensSortie: 20, appels: 4, coutEstime: true });
  T.fini(t, "agent-01", "fait", "x.md");
  // décor des routes agents/:nom et evenements : un troisième agent viré, des pancartes, sept événements
  T.ajouterAgent(t, "agent-03", join(dossier, "agents", "agent-03"));
  T.majAgent(t, "agent-03", { passes: 2 });
  T.sortirAgent(t, "agent-03", "vire", "seuil atteint");
  expect(T.reclamer(t, "agent-02", "sommaire.md", "j'écris ma ligne")).toEqual({ ok: true });
  expect(T.reclamer(t, "agent-01", "intro.md", "mon morceau")).toEqual({ ok: true });
  expect(T.liberer(t, "agent-01", "intro.md")).toEqual({ ok: true });
  expect(T.reclamer(t, "agent-01", "sommaire.md", "moi aussi")).toMatchObject({ ok: false, occupe_par: "agent-02" });
  T.ajouterEvenement(t, { agent: "agent-01", type: "message_end", tokensEntree: 100, tokensSortie: 10, coutUsd: 0.01 });
  T.ajouterEvenement(t, { agent: "agent-01", type: "tool_execution_start", outil: "reclamer_fichier", appelId: "c1", arguments: { chemin: "sommaire.md" } });
  T.ajouterEvenement(t, { agent: "agent-01", type: "tool_execution_end", outil: "reclamer_fichier", appelId: "c1", resultat: "occupé par agent-02 depuis 2026-09-21T13:00:00.000Z", dureeMs: 3 });
  T.ajouterEvenement(t, { agent: "agent-02", type: "tool_execution_end", outil: "poster", appelId: "c2", resultat: "message 2 posté dans principal" });
  T.ajouterEvenement(t, { agent: "agent-01", type: "tool_execution_end", outil: "bash", appelId: "c3", resultat: "commande refusée", erreur: "commande refusée" });
  T.ajouterEvenement(t, { agent: "agent-03", type: "compaction_end", coutUsd: 0.001 });
  T.ajouterEvenement(t, { agent: "agent-03", type: "sortie", resultat: "vire : seuil atteint", erreur: "vire : seuil atteint" });
  if (options.termine) {
    T.ajouterEvenement(t, { agent: "lanceur", type: "livrable", resultat: "index.html · 55 octets · sha256 abc" });
    T.ajouterEvenement(t, { agent: "lanceur", type: "verification", outil: "bun test", resultat: "3 pass", dureeMs: 1200, erreur: "code de sortie 1" });
    T.clore(t, { finis: 1, vires: 0, perdus: 1 });
  }
  t.fermer();
  mkdirSync(join(dossier, "partage"), { recursive: true });
  writeFileSync(join(dossier, "partage", "pelican.svg"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script><circle r="4"/></svg>');
  writeFileSync(join(dossier, "partage", "notes.md"), "# notes\n");
  writeFileSync(join(dossier, "partage", "index.html"), '<!doctype html><script src="jeu.js"></script><p>jeu</p>');
  writeFileSync(join(dossier, "partage", "jeu.js"), "document.title = 'jeu';");
}

// Le décor du cerveau : trois agents qui se nomment par prénom, par surnom, pas du tout, et un piège « Antoinette ».
function construireRunCerveau(nom: string) {
  const dossier = join(racine, "runs", nom);
  mkdirSync(dossier, { recursive: true });
  const t = ouvrirBun(join(dossier, "tableau.sqlite"));
  T.initialiser(t);
  T.ouvrirRun(t, { id: nom, missionChemin: "missions/x.md", missionTexte: "mission", modele: "faux/faux", plafondUsd: 1, silenceMin: 15 });
  for (const a of ["Antoine", "Bernard", "Claude"]) T.ajouterAgent(t, a, join(dossier, "agents", a));
  T.surnom(t, "Bernard", "Nono");
  T.poster(t, "Antoine", "## Tour 1 — Le but\nBernard, je prends intro.md");     // le prénom → Bernard
  T.poster(t, "Bernard", "Antoinette a raison, et Antoine aussi", "filet");      // « Antoinette » ne compte pas, Antoine oui
  T.poster(t, "Claude", "**merci Nono**, je relis");                             // le surnom → Bernard
  T.poster(t, "Antoine", "personne en particulier");                             // aucune cible
  T.fini(t, "Antoine", "fait");
  T.sortirAgent(t, "Claude", "perdu", "passes épuisées");
  T.clore(t, { finis: 1, vires: 0, perdus: 1 });
  t.fermer();
}
// Un run sans le moindre message : le cerveau doit rester vide, pas planter.
function construireRunMuet(nom: string) {
  const dossier = join(racine, "runs", nom);
  mkdirSync(dossier, { recursive: true });
  const t = ouvrirBun(join(dossier, "tableau.sqlite"));
  T.initialiser(t);
  T.ouvrirRun(t, { id: nom, missionChemin: "missions/x.md", missionTexte: "mission", modele: "faux/faux", plafondUsd: 1, silenceMin: 15 });
  T.ajouterAgent(t, "Seul", join(dossier, "agents", "Seul"));
  t.fermer();
}

const api = async (chemin: string) => { const r = await fetch(serveur.url + chemin); return { statut: r.status, type: r.headers.get("content-type") ?? "", corps: r.headers.get("content-type")?.includes("json") ? await r.json() : await r.text() }; };

beforeAll(() => {
  racine = mkdtempSync(join(tmpdir(), "essaim-serveur-"));
  mkdirSync(join(racine, "runs"));
  construireRun("run-a", { termine: true, entrees: true });
  construireRun("run-b");
  construireRunCerveau("run-cerveau");
  construireRunMuet("run-muet");
  construireRun("run-ancien", { termine: true }); // une ancienne base, sans la colonne entrees_json
  const ancien = ouvrirBun(join(racine, "runs", "run-ancien", "tableau.sqlite"));
  ancien.exec("ALTER TABLE run DROP COLUMN entrees_json");
  ancien.fermer();
  mkdirSync(join(racine, "runs", "run-vide"));
  writeFileSync(join(racine, "runs", "run-vide", "tableau.sqlite"), "");
  writeFileSync(join(racine, "runs", ".verrou"), "999999"); // un pid mort : aucun lanceur vivant
  // une base valide HORS de runs/ : aucun chemin ne doit l'atteindre
  const hors = ouvrirBun(join(racine, "tableau.sqlite"));
  T.initialiser(hors);
  T.ouvrirRun(hors, { id: "hors", missionChemin: "m", missionTexte: "m", modele: "m", plafondUsd: 1, silenceMin: 1 });
  hors.fermer();
  serveur = creerServeur({ racine, port: 0 });
});
afterAll(() => { serveur.arreter(); rmSync(racine, { recursive: true, force: true }); });

describe("les documents d'entrée", () => {
  test("la liste : nom, taille, empreinte d'origine et d'aujourd'hui, modifié ou non", async () => {
    const r = await api("/api/runs/run-a/entrees");
    expect(r.statut).toBe(200);
    expect(r.corps).toEqual([{ nom: "doc.md", taille: 6, sha256: SHA_ENTREE, sha256_actuel: SHA_ENTREE, modifie: false }]);
    writeFileSync(join(racine, "runs", "run-a", "entrees", "doc.md"), "# doc modifié\n");
    const apres = await api("/api/runs/run-a/entrees");
    expect(apres.corps[0].modifie).toBe(true);
    expect(apres.corps[0].sha256_actuel).not.toBe(SHA_ENTREE);
    writeFileSync(join(racine, "runs", "run-a", "entrees", "doc.md"), "# doc\n");
  });
  test("sans entrée, ou base d'avant P4 sans la colonne : liste vide", async () => {
    expect((await api("/api/runs/run-b/entrees")).corps).toEqual([]);
    expect((await api("/api/runs/run-ancien/entrees")).corps).toEqual([]);
  });
});

describe("le constat du lanceur", () => {
  test("dans le compteur : le dernier livrable et la dernière vérification, ou null", async () => {
    const a = await api("/api/runs/run-a");
    expect(a.corps.lanceur).toEqual({
      livrable: { horodatage: expect.any(String), outil: null, resultat_resume: "index.html · 55 octets · sha256 abc", duree_ms: null, erreur: null },
      verification: { horodatage: expect.any(String), outil: "bun test", resultat_resume: "3 pass", duree_ms: 1200, erreur: "code de sortie 1" },
      entrees: null,
    });
    expect((await api("/api/runs/run-b")).corps.lanceur).toBeNull();
  });
  test("dans la bande brute, filtrée sur l'auteur lanceur", async () => {
    const r = await api("/api/runs/run-a/evenements?agent=lanceur");
    expect(r.corps.evenements.map((e: { type: string }) => e.type)).toEqual(["livrable", "verification"]);
  });
});

describe("validerRun", () => {
  test("accepte un nom de dossier simple, refuse tout le reste", () => {
    expect(validerRun("2026-09-21T13-30-13")).toBe(true);
    expect(validerRun("run-a")).toBe(true);
    for (const n of ["", "..", ".", ".verrou", "a/b", "../x", "a b", "/tmp"]) expect(validerRun(n)).toBe(false);
  });
});

describe("GET /api/runs", () => {
  test("liste les runs du plus récent au plus ancien, avec compteurs, sans .verrou", async () => {
    const { statut, type, corps } = await api("/api/runs");
    expect(statut).toBe(200);
    expect(type).toBe("application/json; charset=utf-8");
    expect(corps.map((r: { id: string }) => r.id)).toEqual(["run-vide", "run-muet", "run-cerveau", "run-b", "run-ancien", "run-a"]);
    const a = corps.find((r: { id: string }) => r.id === "run-a");
    expect(a).toMatchObject({ etat: "termine", mission_chemin: "missions/x.md", modele: "faux/faux", plafond_usd: 0.5, agents: 3, actifs: 1, finis: 1, vires: 1, perdus: 0, messages: 4, appels: 7, tokens_entree: 300, tokens_sortie: 30, cout_estime: true });
    expect(a.cout_usd).toBeCloseTo(0.03, 6);
    expect(typeof a.debut).toBe("string");
    expect(typeof a.fin).toBe("string");
    const b = corps.find((r: { id: string }) => r.id === "run-b");
    expect(b.etat).toBe("en_cours");
    expect(b.fin).toBeNull();
    const vide = corps.find((r: { id: string }) => r.id === "run-vide");
    expect(vide).toMatchObject({ etat: "en préparation", agents: 0, messages: 0, cout_usd: 0 });
  });
});

describe("GET /api/runs/:run", () => {
  test("le compteur d'un run terminé", async () => {
    const { statut, corps } = await api("/api/runs/run-a");
    expect(statut).toBe(200);
    expect(corps).toMatchObject({ id: "run-a", etat: "termine", modele: "faux/faux", mission_texte: "mission de run-a", plafond_usd: 0.5, cout_estime: true, tokens_entree: 300, tokens_sortie: 30, appels: 7, echecs: 1, agents: 3, actifs: 1, finis: 1, vires: 1, perdus: 0, messages: 4, bilan: { finis: 1, vires: 0, perdus: 1 } });
    expect(corps.cout_usd).toBeCloseTo(0.03, 6);
    expect(corps.reste_usd).toBeCloseTo(0.47, 6);
    expect(corps.duree_s).toBeGreaterThanOrEqual(0);
    expect(corps.duree_s).toBeLessThan(60);
  });
  test("la liste de l'équipe : état, messages, dernière activité de chaque agent", async () => {
    const { corps } = await api("/api/runs/run-a");
    expect(corps.equipe.map((a: { nom: string }) => a.nom)).toEqual(["agent-01", "agent-02", "agent-03"]);
    expect(corps.equipe[0]).toMatchObject({ nom: "agent-01", surnom: null, etat: "fini", raison_sortie: "fait", passes: 1, messages: 2 });
    expect(corps.equipe[0].cout_usd).toBeCloseTo(0.01, 6);
    expect(typeof corps.equipe[0].derniere_activite).toBe("string");
    expect(corps.equipe[2]).toMatchObject({ etat: "vire", messages: 0, derniere_action: "sortie" });
    expect(corps.equipe[0].derniere_action).toBe("bash"); // le dernier événement d'agent-01 est l'appel bash en erreur
  });
  test("un run en cours : durée depuis le début, pas de bilan", async () => {
    const { corps } = await api("/api/runs/run-b");
    expect(corps.fin).toBeNull();
    expect(corps.bilan).toBeNull();
    expect(corps.duree_s).toBeGreaterThanOrEqual(0);
  });
  test("base créée mais run pas encore ouvert (table run vide) : 503 et « en préparation », pas 500 (29/09, revue F20)", async () => {
    const dossier = join(racine, "runs", "run-sans-ligne");
    mkdirSync(dossier, { recursive: true });
    const t = ouvrirBun(join(dossier, "tableau.sqlite"));
    T.initialiser(t);
    t.fermer();
    try {
      expect((await api("/api/runs/run-sans-ligne")).statut).toBe(503);
      expect((await api("/api/runs/run-sans-ligne/cerveau")).statut).toBe(503);
      expect((await api("/api/runs")).corps.find((r: { id: string }) => r.id === "run-sans-ligne")?.etat).toBe("en préparation");
    } finally { rmSync(dossier, { recursive: true, force: true }); }
  });
  test("base pas prête : 503", async () => {
    expect(await api("/api/runs/run-vide")).toMatchObject({ statut: 503, corps: { erreur: "pas encore prêt" } });
    expect(await api("/api/runs/run-vide/fils")).toMatchObject({ statut: 503, corps: { erreur: "pas encore prêt" } });
  });
  test("run inconnu, nom hors périmètre, dossier caché : 404, sans toucher hors de runs/", async () => {
    const avant = statSync(join(racine, "tableau.sqlite")).mtimeMs;
    for (const chemin of ["/api/runs/inconnu", "/api/runs/..", "/api/runs/..%2Frun-a", "/api/runs/a%2Fb", "/api/runs/.verrou", "/api/runs/%2E%2E", "/api/runs/../tableau.sqlite/fils"]) {
      const r = await fetch(serveur.url + chemin);
      expect([404, 400]).toContain(r.status);
    }
    expect(statSync(join(racine, "tableau.sqlite")).mtimeMs).toBe(avant);
    expect(await api("/api/autre")).toMatchObject({ statut: 404, corps: { erreur: "route inconnue" } });
  });
  test("seul GET est accepté", async () => {
    const r = await fetch(serveur.url + "/api/runs", { method: "POST" });
    expect(r.status).toBe(405);
  });
});

describe("GET /api/runs/:run/fils", () => {
  test("fils avec agents, messages dans l'ordre, principal en tête", async () => {
    const { statut, corps } = await api("/api/runs/run-a/fils");
    expect(statut).toBe(200);
    expect(corps.fils.map((f: { nom: string }) => f.nom)).toEqual(["principal", "design"]);
    expect(corps.fils[0]).toMatchObject({ id: 1, nom: "principal", messages: 3, agents: [{ nom: "agent-01", messages: 1 }, { nom: "agent-02", messages: 2 }] });
    expect(corps.messages.map((m: { texte: string }) => m.texte)).toEqual(["un", "deux", "trois", "quatre"]);
    expect(corps.messages[2]).toMatchObject({ id: 3, fil: "design", auteur: "agent-01" });
    expect(corps.reste).toBe(false);
  });
  test("pagination depuis, limite et borne", async () => {
    expect((await api("/api/runs/run-a/fils?depuis=2")).corps.messages.map((m: { id: number }) => m.id)).toEqual([3, 4]);
    const l2 = (await api("/api/runs/run-a/fils?limite=2")).corps;
    expect(l2.messages.map((m: { id: number }) => m.id)).toEqual([1, 2]);
    expect(l2.reste).toBe(true);
    expect((await api("/api/runs/run-a/fils?limite=9999")).corps.messages.length).toBe(4);
    expect((await api("/api/runs/run-a/fils?depuis=abc&limite=-3")).statut).toBe(200);
  });
});

describe("GET /api/runs/:run/agents/:nom", () => {
  test("la fiche : état, raison, fichier livré, passes, compteurs, messages", async () => {
    const { statut, corps } = await api("/api/runs/run-a/agents/agent-01");
    expect(statut).toBe(200);
    expect(corps.agent).toMatchObject({ nom: "agent-01", etat: "fini", raison_sortie: "fait", fichier_livre: "x.md", passes: 1, messages: 2, tokens_entree: 100, tokens_sortie: 10, appels: 3, echecs: 1, cout_estime: false });
    expect(corps.agent.cout_usd).toBeCloseTo(0.01, 6);
    expect(typeof corps.agent.debut).toBe("string");
    const a3 = (await api("/api/runs/run-a/agents/agent-03")).corps.agent;
    expect(a3).toMatchObject({ etat: "vire", raison_sortie: "seuil atteint", passes: 2, messages: 0 });
  });
  test("pancartes en cours seulement", async () => {
    expect((await api("/api/runs/run-a/agents/agent-02")).corps.pancartes).toMatchObject([{ chemin: "sommaire.md", raison: "j'écris ma ligne" }]);
    expect((await api("/api/runs/run-a/agents/agent-01")).corps.pancartes).toEqual([]);
  });
  test("la trace de l'agent, filtrée par type, paginée", async () => {
    const ids = (r: { corps: { evenements: Array<{ id: number }> } }) => r.corps.evenements.map((e) => e.id);
    const tout = await api("/api/runs/run-a/agents/agent-01");
    expect(ids(tout)).toEqual([1, 2, 3, 5]);
    expect(tout.corps.reste).toBe(false);
    expect(tout.corps.evenements[2]).toMatchObject({ type: "tool_execution_end", outil: "reclamer_fichier", appel_id: "c1", resultat_resume: "occupé par agent-02 depuis 2026-09-21T13:00:00.000Z", duree_ms: 3, erreur: null });
    expect(ids(await api("/api/runs/run-a/agents/agent-01?type=echecs"))).toEqual([5]);
    expect(ids(await api("/api/runs/run-a/agents/agent-01?type=outils&depuis=2"))).toEqual([3, 5]);
    expect(ids(await api("/api/runs/run-a/agents/agent-01?type=messages"))).toEqual([1]);
    expect(ids(await api("/api/runs/run-a/agents/agent-03?type=sorties"))).toEqual([7]);
    expect(ids(await api("/api/runs/run-a/agents/agent-03?type=compactages"))).toEqual([6]);
    const l2 = await api("/api/runs/run-a/agents/agent-01?limite=2");
    expect(ids(l2)).toEqual([1, 2]);
    expect(l2.corps.reste).toBe(true);
  });
  test("le filtre compactages : compactage, résumé forcé et appels de l'outil de résumé sous ses deux noms, rien d'autre", async () => {
    const t = ouvrirBun(join(racine, "runs", "run-a", "tableau.sqlite"));
    const avant = t.get<{ n: number }>("SELECT max(id) AS n FROM evenements")!.n;
    T.ajouterEvenement(t, { agent: "agent-03", type: "resume_force", resultat: "résumé forcé : 170k tokens, au-delà de la coupure (160k)" });
    T.ajouterEvenement(t, { agent: "agent-03", type: "tool_execution_start", outil: "se_resumer", appelId: "r1", arguments: { note: "garde le but" } });
    T.ajouterEvenement(t, { agent: "agent-03", type: "tool_execution_end", outil: "se_resumer", appelId: "r1", resultat: "résumé demandé" });
    T.ajouterEvenement(t, { agent: "agent-03", type: "message_end", tokensEntree: 10, tokensSortie: 1, coutUsd: 0 });
    T.ajouterEvenement(t, { agent: "agent-03", type: "tool_execution_end", outil: "moi_resumer", appelId: "r2", resultat: "résumé demandé" }); // nouveau run
    const r = await api("/api/runs/run-a/agents/agent-03?type=compactages");
    t.run("DELETE FROM evenements WHERE id > ?", [avant]); // run-a est partagé par les tests suivants
    t.fermer();
    expect((r.corps.evenements as Array<{ type: string }>).map((e) => e.type)).toEqual(["compaction_end", "resume_force", "tool_execution_start", "tool_execution_end", "tool_execution_end"]);
  });
  test("la borne de 500 événements", async () => {
    const dossier = join(racine, "runs", "run-b");
    const t = ouvrirBun(join(dossier, "tableau.sqlite"));
    T.ajouterAgent(t, "agent-04", join(dossier, "agents", "agent-04"));
    t.transaction(() => { for (let i = 0; i < 501; i++) T.ajouterEvenement(t, { agent: "agent-04", type: "message_end", tokensEntree: 1, tokensSortie: 1, coutUsd: 0 }); });
    t.fermer();
    const r = await api("/api/runs/run-b/agents/agent-04?limite=9999");
    expect(r.corps.evenements.length).toBe(500);
    expect(r.corps.reste).toBe(true);
  });
  test("type inconnu : 400 ; agent inconnu ou nom hostile : 404", async () => {
    expect(await api("/api/runs/run-a/agents/agent-01?type=bidule")).toMatchObject({ statut: 400, corps: { erreur: "type inconnu" } });
    expect(await api("/api/runs/run-a/agents/agent-99")).toMatchObject({ statut: 404, corps: { erreur: "agent inconnu" } });
    for (const nom of ["..", "a%2Fb", "..%2Fagent-01", ".cache"]) expect((await api(`/api/runs/run-a/agents/${nom}`)).statut).toBe(404);
    expect(await api("/api/runs/run-vide/agents/agent-01")).toMatchObject({ statut: 503 });
  });
});

describe("GET /api/runs/:run/evenements", () => {
  const ids = (r: { corps: { evenements: Array<{ id: number }> } }) => r.corps.evenements.map((e) => e.id);
  test("la bande brute, dans l'ordre, chaque ligne portant son agent", async () => {
    const r = await api("/api/runs/run-a/evenements");
    expect(r.statut).toBe(200);
    expect(ids(r)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(r.corps.evenements.map((e: { agent: string }) => e.agent)).toEqual(["agent-01", "agent-01", "agent-01", "agent-02", "agent-01", "agent-03", "agent-03", "lanceur", "lanceur"]);
    expect(r.corps.reste).toBe(false);
  });
  test("filtres agent, outil, texte (sous-chaîne, casse ASCII ignorée, joker sans effet)", async () => {
    expect(ids(await api("/api/runs/run-a/evenements?agent=agent-03"))).toEqual([6, 7]);
    expect(ids(await api("/api/runs/run-a/evenements?outil=reclamer_fichier"))).toEqual([2, 3]);
    expect(ids(await api("/api/runs/run-a/evenements?q=OCCUP"))).toEqual([3]);
    expect(ids(await api("/api/runs/run-a/evenements?q=sommaire"))).toEqual([2]);
    expect(ids(await api("/api/runs/run-a/evenements?q=%25"))).toEqual([]);
    expect(ids(await api("/api/runs/run-a/evenements?agent=agent-01&q=refus"))).toEqual([5]);
    expect(ids(await api("/api/runs/run-a/evenements?agent=agent-02&outil=bash"))).toEqual([]);
  });
  test("pagination depuis et limite", async () => {
    const r = await api("/api/runs/run-a/evenements?depuis=5&limite=1");
    expect(ids(r)).toEqual([6]);
    expect(r.corps.reste).toBe(true);
    expect((await api("/api/runs/run-b/evenements?limite=9999")).corps.evenements.length).toBe(500);
    expect(await api("/api/runs/run-vide/evenements")).toMatchObject({ statut: 503 });
  });
});

describe("GET /api/runs/:run/cerveau", () => {
  test("qui nomme qui : le prénom ou le surnom en mot entier, jamais un morceau ; les liens agrégés ; les agents dans l'ordre des prénoms", async () => {
    const r = await api("/api/runs/run-cerveau/cerveau");
    expect(r.statut).toBe(200);
    const c = r.corps;
    expect(c.etat).toBe("termine");
    expect(c.duree_ms).toBeGreaterThanOrEqual(0);
    expect(c.agents.map((a: { nom: string }) => a.nom)).toEqual(["Antoine", "Bernard", "Claude"]);
    expect(c.agents[0]).toMatchObject({ etat: "fini", raison_sortie: "fait", messages: 2 });
    expect(typeof c.agents[0].t_fin).toBe("number"); // sorti : l'instant de sa dernière activité
    expect(c.agents[1]).toMatchObject({ surnom: "Nono", etat: "actif", messages: 1, t_fin: null });
    expect(c.agents[2]).toMatchObject({ etat: "perdu", raison_sortie: "passes épuisées" });
    expect(c.messages.map((m: { cibles: string[] }) => m.cibles)).toEqual([["Bernard"], ["Antoine"], ["Bernard"], []]);
    expect(c.messages.map((m: { titre: string }) => m.titre)).toEqual(["Tour 1 — Le but", "Antoinette a raison, et Antoine aussi", "merci Nono, je relis", "personne en particulier"]);
    expect(c.messages.map((m: { fil: string }) => m.fil)).toEqual(["principal", "filet", "principal", "principal"]);
    expect(c.messages[0].t).toBeGreaterThanOrEqual(0);
    for (let i = 1; i < c.messages.length; i++) expect(c.messages[i].t).toBeGreaterThanOrEqual(c.messages[i - 1].t);
    expect(c.messages[0]).not.toHaveProperty("texte"); // le texte reste en base, la vue n'a besoin que du titre
    expect(c.liens).toEqual([{ a: "Antoine", b: "Bernard", n: 1 }, { a: "Bernard", b: "Antoine", n: 1 }, { a: "Claude", b: "Bernard", n: 1 }]);
  });
  test("un run sans message : tableaux vides ; base pas prête : 503 ; run inconnu : 404", async () => {
    const muet = await api("/api/runs/run-muet/cerveau");
    expect(muet.statut).toBe(200);
    expect(muet.corps).toMatchObject({ etat: "en_cours", messages: [], liens: [] });
    expect(muet.corps.agents).toEqual([expect.objectContaining({ nom: "Seul", messages: 0 })]);
    expect((await api("/api/runs/run-vide/cerveau")).statut).toBe(503);
    expect((await api("/api/runs/inconnu/cerveau")).statut).toBe(404);
  });
});

describe("les livrables de partage/", () => {
  test("la liste : nom, taille, date, triée", async () => {
    const { statut, corps } = await api("/api/runs/run-a/partage");
    expect(statut).toBe(200);
    expect(corps.map((f: { nom: string }) => f.nom)).toEqual(["index.html", "jeu.js", "notes.md", "pelican.svg"]);
    expect(corps[3].taille).toBeGreaterThan(50); // pelican.svg
    expect(typeof corps[1].modifie).toBe("string");
  });
  test("un fichier : son contenu, son type, et une CSP qui interdit tout script", async () => {
    const r = await fetch(serveur.url + "/api/runs/run-a/partage/pelican.svg");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(await r.text()).toContain("<circle");
    const md = await fetch(serveur.url + "/api/runs/run-a/partage/notes.md");
    expect(md.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  });
  test("une page HTML livrée s'ouvre pour de vrai, dans un bac à sable navigateur ; ses scripts ont leur vrai type", async () => {
    const page = await fetch(serveur.url + "/api/runs/run-a/partage/index.html");
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("content-security-policy")).toBe("sandbox allow-scripts");
    const js = await fetch(serveur.url + "/api/runs/run-a/partage/jeu.js");
    expect(js.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(js.headers.get("content-security-policy")).toContain("default-src 'none'");
  });
  test("fermer ou supprimer depuis une autre origine (page livrée en bac à sable) : 403", async () => {
    expect((await fetch(serveur.url + "/api/runs/run-a/fermer", { method: "POST", headers: { origin: "null" } })).status).toBe(403);
    expect((await fetch(serveur.url + "/api/runs/run-a", { method: "DELETE", headers: { origin: "http://evil.test" } })).status).toBe(403);
    const hote = new URL(serveur.url).host;
    expect((await fetch(serveur.url + "/api/runs/run-a/fermer", { method: "POST", headers: { origin: `http://${hote}` } })).status).toBe(409); // même origine : la garde laisse passer
  });
  test("confiné à partage/ : traversée, fichier absent, run sans partage", async () => {
    for (const chemin of ["/api/runs/run-a/partage/..%2Ftableau.sqlite", "/api/runs/run-a/partage/absent.svg", "/api/runs/run-a/partage/.cache"]) expect((await fetch(serveur.url + chemin)).status).toBe(404);
    expect((await api("/api/runs/run-vide/partage")).corps).toEqual([]);
  });
});

describe("fermer et supprimer un run", () => {
  test("fermer un run en cours dont le lanceur est mort : les agents actifs sont perdus, le run est clos", async () => {
    construireRun("run-c");
    const r = await fetch(serveur.url + "/api/runs/run-c/fermer", { method: "POST" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ message: "clos" });
    const c = (await api("/api/runs/run-c")).corps;
    expect(c.etat).toBe("termine");
    expect(c.equipe.map((a: { nom: string; etat: string }) => [a.nom, a.etat])).toEqual([["agent-01", "fini"], ["agent-02", "perdu"], ["agent-03", "vire"]]);
    expect(c.equipe[1].raison_sortie).toContain("clos depuis la vue");
    expect(c.bilan).toMatchObject({ finis: 1, vires: 1, perdus: 1 });
    expect((await api("/api/runs/run-c/agents/agent-02")).corps.pancartes).toEqual([]);
    expect((await api("/api/runs/run-c/agents/agent-02?type=sorties")).corps.evenements.length).toBe(1);
  });
  test("un dormeur est vivant dans la salle : compté parmi les actifs, puis perdu à la fermeture", async () => {
    construireRun("run-dort");
    const t = ouvrirBun(join(racine, "runs", "run-dort", "tableau.sqlite"));
    expect(T.endormir(t, "agent-02")).toBe(1);
    t.fermer();
    const liste = (await api("/api/runs")).corps as Array<{ id: string; actifs: number }>;
    expect(liste.find((r) => r.id === "run-dort")?.actifs).toBe(1);
    expect((await fetch(serveur.url + "/api/runs/run-dort/fermer", { method: "POST" })).status).toBe(200);
    const c = (await api("/api/runs/run-dort")).corps;
    expect(c.equipe.map((a: { nom: string; etat: string }) => [a.nom, a.etat])).toEqual([["agent-01", "fini"], ["agent-02", "perdu"], ["agent-03", "vire"]]);
  });
  test("second cerveau (M1, E2) : la fermeture depuis la vue, transaction englobante, note les départs perdus, les pancartes retirées et les fils fermés", async () => {
    construireRun("run-faits");
    const t = ouvrirBun(join(racine, "runs", "run-faits", "tableau.sqlite"));
    T.entrer(t, "agent-02", "q-sommaire", "le sommaire");
    t.fermer();
    expect((await fetch(serveur.url + "/api/runs/run-faits/fermer", { method: "POST" })).status).toBe(200);
    const l = ouvrirBun(join(racine, "runs", "run-faits", "tableau.sqlite"), { lectureSeule: true });
    const faits = l.all<{ type: string; agent: string; texte: string }>("SELECT type, agent, texte FROM faits WHERE id > (SELECT id FROM faits WHERE type = 'fil' AND texte LIKE 'q-sommaire ouvert%') ORDER BY id");
    l.fermer();
    expect(faits).toEqual([
      { type: "agent", agent: "agent-02", texte: "agent-02 · perdu · raison : lanceur absent, clos depuis la vue" },
      { type: "pancarte", agent: "agent-02", texte: "pancarte retirée · sommaire.md · agent-02" },
      { type: "fil", agent: "salle", texte: "q-sommaire fermé sans conclusion (lanceur absent, clos depuis la vue)" },
    ]);
  });
  test("fermer un run déjà terminé : 409", async () => {
    expect((await fetch(serveur.url + "/api/runs/run-a/fermer", { method: "POST" })).status).toBe(409);
  });
  test("fermer quand le lanceur tourne : un fichier arret, rien d'autre ; supprimer alors : 409", async () => {
    construireRun("run-e");
    writeFileSync(join(racine, "runs", ".verrou"), String(process.pid)); // « le lanceur », c'est nous
    try {
      const r = await fetch(serveur.url + "/api/runs/run-e/fermer", { method: "POST" });
      expect(r.status).toBe(202);
      expect(statSync(join(racine, "runs", "run-e", "arret")).isFile()).toBe(true);
      expect((await api("/api/runs/run-e")).corps.etat).toBe("en_cours");
      expect((await fetch(serveur.url + "/api/runs/run-e", { method: "DELETE" })).status).toBe(409);
    } finally {
      writeFileSync(join(racine, "runs", ".verrou"), "999999");
    }
  });
  test("un lanceur vivant pour un AUTRE run ne retient pas un run orphelin : fermé par nous, pause refusée (29/09, revue F11)", async () => {
    // Le run A est mort brutalement (code 137) en restant en_cours ; le run B tourne, son lanceur tient le verrou.
    construireRun("run-orphelin");
    writeFileSync(join(racine, "runs", ".verrou"), `${process.pid} run-autre`);
    try {
      expect((await fetch(serveur.url + "/api/runs/run-orphelin/pause", { method: "POST" })).status).toBe(409);
      const r = await fetch(serveur.url + "/api/runs/run-orphelin/fermer", { method: "POST" });
      expect(r.status).toBe(200);
      expect(existsSync(join(racine, "runs", "run-orphelin", "arret"))).toBe(false);
      expect((await api("/api/runs/run-orphelin")).corps.etat).not.toBe("en_cours");
      // le run que ce lanceur fait tourner, lui, reste protégé
      construireRun("run-autre");
      expect((await fetch(serveur.url + "/api/runs/run-autre/fermer", { method: "POST" })).status).toBe(202);
    } finally {
      writeFileSync(join(racine, "runs", ".verrou"), "999999");
    }
  });
  test("pause et reprise quand le lanceur tourne : le fichier pause est posé puis retiré, le compteur le dit", async () => {
    construireRun("run-p");
    writeFileSync(join(racine, "runs", ".verrou"), String(process.pid)); // « le lanceur », c'est nous
    try {
      expect((await api("/api/runs/run-p")).corps.en_pause).toBe(false);
      const r = await fetch(serveur.url + "/api/runs/run-p/pause", { method: "POST" });
      expect(r.status).toBe(202);
      expect(existsSync(join(racine, "runs", "run-p", "pause"))).toBe(true);
      expect((await api("/api/runs/run-p")).corps).toMatchObject({ etat: "en_cours", en_pause: true });
      expect((await fetch(serveur.url + "/api/runs/run-p/reprendre", { method: "POST" })).status).toBe(202);
      expect(existsSync(join(racine, "runs", "run-p", "pause"))).toBe(false);
      expect((await api("/api/runs/run-p")).corps.en_pause).toBe(false);
      expect((await fetch(serveur.url + "/api/runs/run-p/pause", { method: "POST", headers: { origin: "null" } })).status).toBe(403);
    } finally {
      writeFileSync(join(racine, "runs", ".verrou"), "999999");
    }
  });
  test("A6 (02/10) : une consigne au chef est déposée pour le lanceur ; refusée sans répartiteur, sans lanceur, vide, trop longue ou d'une autre origine", async () => {
    construireRun("run-consigne");
    const poster = (texte: unknown, headers: Record<string, string> = {}) => fetch(serveur.url + "/api/runs/run-consigne/consigne", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ texte }) });
    const dossier = join(racine, "runs", "run-consigne", "consignes");
    expect((await poster("fais relire 510 à 600")).status).toBe(409); // le lanceur ne tourne pas
    writeFileSync(join(racine, "runs", ".verrou"), String(process.pid));
    try {
      const r0 = await poster("fais relire 510 à 600");
      expect(r0.status).toBe(409);
      expect((await r0.json()).erreur).toBe("personne ne répartit le travail dans ce run (ni chef ni intégrateur présent)");
      const t = ouvrirBun(join(racine, "runs", "run-consigne", "tableau.sqlite"));
      T.ajouterAgent(t, "Antoine", join(racine, "runs", "run-consigne", "agents", "Antoine"), undefined, undefined, { role: "chef" });
      t.fermer();
      expect((await poster("  ")).status).toBe(400);
      expect((await poster("x".repeat(601))).status).toBe(400);
      expect((await poster("fais relire", { origin: "null" })).status).toBe(403);
      expect(existsSync(dossier)).toBe(false);
      const r = await poster("  fais relire le texte des pages 510 à 600  ");
      expect(r.status).toBe(202);
      const fichiers = readdirSync(dossier);
      expect(fichiers).toHaveLength(1);
      expect(readFileSync(join(dossier, fichiers[0]!), "utf8")).toBe("fais relire le texte des pages 510 à 600");
      expect((await api("/api/runs/run-consigne/consignes")).corps).toMatchObject({ transmises: [], en_attente: [{ texte: "fais relire le texte des pages 510 à 600" }], destinataire: { nom: "Antoine", role: "chef" } });
    } finally {
      writeFileSync(join(racine, "runs", ".verrou"), "999999");
    }
  });
  test("pause refusée sans lanceur vivant ou sur un run terminé : 409, rien n'est écrit", async () => {
    construireRun("run-q");
    const r = await fetch(serveur.url + "/api/runs/run-q/pause", { method: "POST" });
    expect(r.status).toBe(409);
    expect((await r.json()).erreur).toBe("le lanceur ne tourne plus");
    expect(existsSync(join(racine, "runs", "run-q", "pause"))).toBe(false);
    expect((await fetch(serveur.url + "/api/runs/run-a/pause", { method: "POST" })).status).toBe(409);
  });
  test("supprimer un run en préparation pendant que le lanceur tourne : 409, le dossier reste (29/09, revue F3)", async () => {
    // Le lanceur fait git init et copie les entrées avant d'ouvrir la base : « en préparation » n'est pas « terminé ».
    const dossier = join(racine, "runs", "run-prep");
    mkdirSync(join(dossier, "partage"), { recursive: true });
    writeFileSync(join(racine, "runs", ".verrou"), String(process.pid));
    try {
      expect((await fetch(serveur.url + "/api/runs/run-prep", { method: "DELETE" })).status).toBe(409);
      expect(existsSync(dossier)).toBe(true);
    } finally {
      writeFileSync(join(racine, "runs", ".verrou"), "999999");
    }
    expect((await fetch(serveur.url + "/api/runs/run-prep", { method: "DELETE" })).status).toBe(200); // lanceur mort : un reste, supprimable
  });
  test("supprimer un run terminé : le dossier disparaît ; un run inconnu : 404", async () => {
    construireRun("run-d", { termine: true });
    const r = await fetch(serveur.url + "/api/runs/run-d", { method: "DELETE" });
    expect(r.status).toBe(200);
    expect(existsSync(join(racine, "runs", "run-d"))).toBe(false);
    expect((await fetch(serveur.url + "/api/runs/run-d", { method: "DELETE" })).status).toBe(404);
    expect((await fetch(serveur.url + "/api/runs/..%2Ftableau.sqlite", { method: "DELETE" })).status).toBe(404);
    expect(existsSync(join(racine, "tableau.sqlite"))).toBe(true);
  });
  test("les autres méthodes restent refusées", async () => {
    expect((await fetch(serveur.url + "/api/runs", { method: "DELETE" })).status).toBe(405);
    expect((await fetch(serveur.url + "/api/runs/run-a/fils", { method: "POST" })).status).toBe(405);
  });
});

describe("les livrables sur leur propre origine", () => {
  // Servie par l'API, une page livrée serait en bac à sable (`sandbox allow-scripts`), donc sans formulaires
  // ni stockage local. Sur son port à elle, il n'y a aucune API : plus rien à protéger, et la page s'ouvre comme en double-clic.
  const livrable = (chemin: string, init?: RequestInit) => fetch(`${serveur.urlLivrables}/${chemin}`, init);

  test("/api/config donne l'origine des livrables, et elle diffère de celle de la vue", async () => {
    const c = (await api("/api/config")).corps as { livrables: string };
    expect(c.livrables).toBe(serveur.urlLivrables);
    expect(c.livrables).not.toBe(serveur.url);
    expect(serveur.portLivrables).not.toBe(serveur.port);
  });

  test("une page livrée est servie sans bac à sable, avec son type", async () => {
    const r = await livrable("run-a/index.html");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(r.headers.get("content-security-policy")).toBeNull(); // c'est tout l'intérêt de l'origine séparée
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await r.text()).toContain("jeu");
  });

  test("les fichiers voisins suivent, sous-dossiers compris", async () => {
    mkdirSync(join(racine, "runs", "run-a", "partage", "modules"), { recursive: true });
    writeFileSync(join(racine, "runs", "run-a", "partage", "modules", "calcul.js"), "export const a = 1;");
    const r = await livrable("run-a/modules/calcul.js");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/javascript");
    expect((await livrable("run-a/jeu.js")).status).toBe(200);
  });

  test("ce qui est refusé : sortir du dossier, un run inconnu, une écriture", async () => {
    for (const chemin of ["run-a/../../../etc/hosts", "run-a/..%2f..%2fetc%2fhosts", "run-inconnu/index.html", "run-a/absent.html", "run-a"])
      expect((await livrable(chemin)).status).toBe(404);
    expect((await livrable("run-a/index.html", { method: "POST" })).status).toBe(405);
  });

  test("un lien symbolique de partage/ vers l'extérieur n'est ni servi ni listé (29/09, revue F1)", async () => {
    // Le bac à sable interdit à l'agent de lire ~/.ssh, pas d'y poser un lien ; le serveur, lui, n'est pas en bac à sable.
    writeFileSync(join(racine, "secret.txt"), "SECRET");
    const partage = join(racine, "runs", "run-a", "partage");
    symlinkSync(join(racine, "secret.txt"), join(partage, "cle.txt"));
    mkdirSync(join(partage, "sous"), { recursive: true });
    symlinkSync(racine, join(partage, "sous", "dehors"));
    try {
      expect((await livrable("run-a/cle.txt")).status).toBe(404);
      expect((await livrable("run-a/sous/dehors/secret.txt")).status).toBe(404);
      expect((await fetch(serveur.url + "/api/runs/run-a/partage/cle.txt")).status).toBe(404);
      expect(((await api("/api/runs/run-a/partage")).corps as Array<{ nom: string }>).map((f) => f.nom)).not.toContain("cle.txt");
      // un lien qui reste dans partage/ est servi normalement
      symlinkSync(join(partage, "jeu.js"), join(partage, "alias.js"));
      expect((await livrable("run-a/alias.js")).status).toBe(200);
    } finally {
      for (const f of ["cle.txt", "alias.js", "sous"]) rmSync(join(partage, f), { recursive: true, force: true });
    }
  });

  test("un Host étranger (rebinding DNS) est refusé, en lecture comme en écriture, sur les deux ports (29/09, revue F13)", async () => {
    const etranger = (url: string) => ({ host: `evil.test:${new URL(url).port}` });
    expect((await fetch(serveur.url + "/api/runs", { headers: etranger(serveur.url) })).status).toBe(403);
    const d = await fetch(serveur.url + "/api/runs/run-a", { method: "DELETE", headers: { ...etranger(serveur.url), origin: `http://evil.test:${serveur.port}` } });
    expect(d.status).toBe(403);
    expect(existsSync(join(racine, "runs", "run-a"))).toBe(true);
    expect((await livrable("run-a/index.html", { headers: etranger(serveur.urlLivrables) })).status).toBe(403);
    // localhost et 127.0.0.1 passent
    expect((await fetch(serveur.url + "/api/runs", { headers: { host: `localhost:${serveur.port}` } })).status).toBe(200);
    expect((await livrable("run-a/index.html")).status).toBe(200);
  });

  test("une requête venue de l'origine des livrables ne peut rien changer", async () => {
    const r = await fetch(serveur.url + "/api/runs/run-c/fermer", { method: "POST", headers: { origin: serveur.urlLivrables } });
    expect(r.status).toBe(403);
    expect((await r.json()).erreur).toBe("origine refusée");
  });
});

describe("le serveur", () => {
  test("n'écoute que sur 127.0.0.1", () => {
    expect(serveur.hote).toBe("127.0.0.1");
    expect(serveur.url.startsWith("http://127.0.0.1:")).toBe(true);
  });
});

describe("ligne de commande", () => {
  const racineDepot = join(import.meta.dir, "..");
  test("--help en français", () => {
    const r = Bun.spawnSync(["bun", join(racineDepot, "src", "serveur.ts"), "--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain("--port");
    expect(r.stdout.toString()).toContain("--racine");
  });
  test("démarre sur le port demandé et l'annonce", async () => {
    const proc = Bun.spawn(["bun", join(racineDepot, "src", "serveur.ts"), "--port", "0", "--racine", racine], { stdout: "pipe", stderr: "pipe" });
    try {
      const lecteur = proc.stdout.getReader();
      const { value } = await lecteur.read();
      const ligne = new TextDecoder().decode(value);
      expect(ligne).toContain("http://127.0.0.1:");
      expect(ligne).toContain("lecture seule");
      const url = ligne.match(/http:\/\/127\.0\.0\.1:\d+/)![0];
      const r = await fetch(url + "/api/runs");
      expect(r.status).toBe(200);
    } finally {
      proc.kill();
      await proc.exited;
    }
  });
});

describe("la page Essaims", () => {
  test("servie à / et /index.html, sans v-html, Vue depuis le CDN", async () => {
    for (const chemin of ["/", "/index.html"]) {
      const r = await fetch(serveur.url + chemin);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")!.startsWith("text/html")).toBe(true);
      const corps = await r.text();
      expect(corps).toContain("Essaims");
      expect(corps).toContain("cdn.jsdelivr.net/npm/vue@3");
      expect(corps).toContain("/api/runs");
      expect(corps).not.toContain("v-html");
      expect(corps).toContain("function rendreMarkdown"); // un .md livré se lit dans la page, par nœuds texte
      expect(corps).not.toContain("innerHTML =");
    }
  });
  test("les fils de concentration dans la vue (V1-V5) : état, présents, carte, résumés, dehors, badge, budget", async () => {
    const page = await (await fetch(serveur.url + "/")).text();
    for (const texte of ["Dans le fil", "Passés par ici", "a écrit sans entrer", "fermé sans conclusion", "assoupi", "hors du fil", "dehors", "dont résumés de fils", "en veille dans ", "Résumés reçus", "En attente", "Ouvert par", "Pourquoi", "Conclusion", "resumes_livres", "réveil sur le fil"])
      expect(page).toContain(texte);
    expect(page).not.toContain("v-html");
    expect(page).not.toContain("Un agent crée un fil en postant dedans."); // devenu faux : on ouvre un fil avec entrer
    expect(page).not.toContain("filtreAgents"); // une liste en deux groupes, plus de filtre qui cachait des messages
  });
  // Les anciens runs (anciens noms) et les nouveaux s'affichent avec les mêmes libellés.
  test("les noms d'outils : la table ancien → nouveau, nomActuel, un libellé et une icône par nouveau nom", async () => {
    const page = await (await fetch(serveur.url + "/")).text();
    const table = page.match(/const ANCIENS_NOMS = (\{[^;]*\});/);
    expect(table).not.toBeNull();
    expect(JSON.parse(table![1]!)).toEqual(ANCIEN_VERS_NOUVEAU);
    expect(JSON.parse(page.match(/const OUTILS_SALLE = (\[[^\]]*\]);/)![1]!)).toEqual([...OUTILS_SALLE]); // la liste du filtre de la trace
    // nomActuel, extrait de la page et évalué : même règle que nouveauNom, arguments lus dans le JSON de l'événement
    const src = page.match(/function nomActuel\([\s\S]*?\n\}\n/);
    expect(src).not.toBeNull();
    const nomActuel = new Function("ANCIENS_NOMS", `${src![0]}; return nomActuel;`)(JSON.parse(table![1]!)) as (o: string | null, a: string | null) => string;
    const cas: Array<[string, Record<string, unknown> | undefined]> = [
      ...ANCIENS_OUTILS_SALLE.map((o) => [o, undefined] as [string, undefined]),
      ["boite", { complet: true }], ["boite", { fil: "q-neige", complet: true }], ["boite", { complet: false }],
      ["ticket", { id: 3, etat: "ferme" }], ["ticket", { type: "bug", titre: "t" }], ["tickets", { id: 3 }], ["tickets", { etat: "ouvert" }],
      ["salle_poster", { texte: "x" }], ["bash", { command: "ls" }], ["bite", undefined],
    ];
    for (const [o, a] of cas) expect(nomActuel(o, a === undefined ? null : JSON.stringify(a))).toBe(nouveauNom(o, a));
    expect(nomActuel("ticket", "{tronqué")).toBe("ticket_ouvrir"); // arguments illisibles : comme sans arguments
    // chaque nouveau nom a son icône et son libellé (les tables de la page, évaluées)
    const objet = (nom: string) => {
      const m = page.match(new RegExp(`const ${nom} = (\\{[\\s\\S]*?\\});\\n`));
      expect(m).not.toBeNull();
      return new Function(`return ${m![1]};`)() as Record<string, string>;
    };
    const icones = objet("ICONES_ACTION"), libelles = objet("LIBELLES_ACTION");
    for (const n of [...OUTILS_SALLE, ...OUTILS_PI]) {
      expect(icones[n], n).toMatch(/^i-/);
      expect(page).toContain(`<symbol id="${icones[n]}"`);
      expect(libelles[n], n).toBeTruthy();
    }
    for (const n of ANCIENS_OUTILS_SALLE) { expect(icones[n], n).toBeUndefined(); expect(libelles[n], n).toBeUndefined(); } // les anciens passent par nomActuel
    for (const n of OUTILS_RETIRES) { expect(icones[n], n).toMatch(/^i-/); expect(libelles[n], n).toBeTruthy(); } // outils retirés : les runs d'avant les montrent encore
    // refus, note de résumé et pancartes : les deux générations
    for (const texte of ['"se_resumer"', '"moi_resumer"', '"reclamer_fichier"', '"fichier_reclamer"', "/^refusé/", "/^occupé par/"]) expect(page).toContain(texte);
  });
  test("rien d'autre n'est servi", async () => {
    expect((await fetch(serveur.url + "/vue/autre.js")).status).toBe(404);
    expect((await fetch(serveur.url + "/vue/index.html")).status).toBe(404);
  });
  test("le module du cerveau est servi à /cerveau.js, en JavaScript, sans module ES ni import map", async () => {
    const r = await fetch(serveur.url + "/cerveau.js");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")!.startsWith("text/javascript")).toBe(true);
    const corps = await r.text();
    expect(corps).toContain("window.Cerveau");
    expect(corps).not.toMatch(/^\s*import /m);
    expect(corps).not.toContain("importmap");
  });
});

describe("deux modèles (24/09)", () => {
  function construireMixte(nom: string) {
    const dossier = join(racine, "runs", nom);
    mkdirSync(dossier, { recursive: true });
    const t = ouvrirBun(join(dossier, "tableau.sqlite"));
    T.initialiser(t);
    T.ouvrirRun(t, { id: nom, missionChemin: "missions/x.md", missionTexte: "m", modele: "faux/faux", modeleFemmes: "faux/faux-bis", plafondUsd: 0.5, silenceMin: 15 });
    for (const [n, m, c] of [["Antoine", "faux/faux", "hommes"], ["Agathe", "faux/faux-bis", "femmes"], ["Bernard", "faux/faux", "hommes"]] as const) T.ajouterAgent(t, n, join(dossier, "agents", n), m, c);
    T.majAgent(t, "Antoine", { coutUsd: 0.01, appels: 2 });
    T.majAgent(t, "Agathe", { coutUsd: 0.03, appels: 5 });
    T.poster(t, "Antoine", "plan");
    T.poster(t, "Agathe", "ok");
    T.poster(t, "Agathe", "fait");
    T.fini(t, "Antoine", "fait");
    t.fermer();
  }
  // un ancien run : ni agents.modele, ni agents.cote, ni run.modele_femmes
  function construireAvant(nom: string) {
    construireMixte(nom);
    const t = ouvrirBun(join(racine, "runs", nom, "tableau.sqlite"));
    for (const sql of ["ALTER TABLE agents DROP COLUMN modele", "ALTER TABLE agents DROP COLUMN cote", "ALTER TABLE run DROP COLUMN modele_femmes"]) t.exec(sql);
    t.fermer();
  }
  const colonnes = (nom: string, table: string) => { const t = ouvrirBun(join(racine, "runs", nom, "tableau.sqlite"), { lectureSeule: true }); const c = t.all<{ name: string }>(`PRAGMA table_info(${table})`).map((r) => r.name); t.fermer(); return c; };

  test("liste des runs : modele_femmes, nul pour un run à un modèle ou d'avant", async () => {
    construireMixte("run-mixte");
    construireAvant("run-avant");
    const liste = (await api("/api/runs")).corps as Array<{ id: string; modele_femmes: string | null }>;
    expect(liste.find((r) => r.id === "run-mixte")?.modele_femmes).toBe("faux/faux-bis");
    expect(liste.find((r) => r.id === "run-a")?.modele_femmes).toBeNull();
    expect(liste.find((r) => r.id === "run-avant")?.modele_femmes).toBeNull();
    expect(liste.find((r) => r.id === "run-vide")).toMatchObject({ modele_femmes: null });
  });

  test("compteur mixte : équipe dans l'ordre d'entrée avec modèle et côté, par_cote en deux entrées", async () => {
    const c = (await api("/api/runs/run-mixte")).corps;
    expect(c.modele_femmes).toBe("faux/faux-bis");
    expect(c.equipe.map((a: { nom: string; modele: string; cote: string }) => [a.nom, a.modele, a.cote])).toEqual([
      ["Antoine", "faux/faux", "hommes"], ["Agathe", "faux/faux-bis", "femmes"], ["Bernard", "faux/faux", "hommes"]]);
    expect(c.par_cote).toEqual([
      { cote: "hommes", modele: "faux/faux", agents: 2, finis: 1, vires: 0, perdus: 0, cout: 0.01, coutEstime: false, tokens: 0, appels: 2, messages: 1 },
      { cote: "femmes", modele: "faux/faux-bis", agents: 1, finis: 0, vires: 0, perdus: 0, cout: 0.03, coutEstime: false, tokens: 0, appels: 5, messages: 2 },
    ]);
    expect((await api("/api/runs/run-mixte/agents/Agathe")).corps.agent).toMatchObject({ modele: "faux/faux-bis", cote: "femmes" });
  });

  test("un run à un modèle : par_cote nul, rien ne change", async () => {
    const c = (await api("/api/runs/run-a")).corps;
    expect(c.par_cote).toBeNull();
    expect(c.modele_femmes).toBeNull();
  });

  test("un run d'avant : lu sans erreur ni migration", async () => {
    const c = (await api("/api/runs/run-avant")).corps;
    expect(c.modele_femmes).toBeNull();
    expect(c.par_cote).toBeNull();
    expect(c.equipe.map((a: { nom: string; modele: string | null; cote: string | null }) => [a.nom, a.modele, a.cote])).toEqual([
      ["Antoine", null, null], ["Agathe", null, null], ["Bernard", null, null]]);
    expect((await api("/api/runs/run-avant/agents/Agathe")).corps.agent).toMatchObject({ modele: null, cote: null });
    expect(colonnes("run-avant", "agents")).not.toContain("modele");
    expect(colonnes("run-avant", "run")).not.toContain("modele_femmes");
  });

  test("fermer depuis la vue un run mixte sans lanceur : le bilan porte parCote et l'ouvreur", async () => {
    construireMixte("run-mixte-ferme");
    expect((await fetch(serveur.url + "/api/runs/run-mixte-ferme/fermer", { method: "POST" })).status).toBe(200);
    const b = (await api("/api/runs/run-mixte-ferme")).corps.bilan;
    expect(b.ouvreur).toBe("hommes");
    expect(b.parCote.map((c: { cote: string; finis: number; perdus: number }) => [c.cote, c.finis, c.perdus])).toEqual([["hommes", 1, 1], ["femmes", 0, 1]]);
  });

  test("fermer depuis la vue un run d'avant : pas de parCote, pas d'erreur", async () => {
    construireAvant("run-avant-ferme");
    expect((await fetch(serveur.url + "/api/runs/run-avant-ferme/fermer", { method: "POST" })).status).toBe(200);
    expect((await api("/api/runs/run-avant-ferme")).corps.bilan.parCote).toBeUndefined();
  });
});

describe("l'onglet Dépôt (A7)", () => {
  beforeAll(async () => {
    const D = await import("../src/depot.ts");
    const dossier = join(racine, "runs", "run-depot");
    mkdirSync(dossier, { recursive: true });
    const t = ouvrirBun(join(dossier, "tableau.sqlite"));
    T.initialiser(t);
    T.ouvrirRun(t, { id: "run-depot", missionChemin: "m", missionTexte: "m", modele: "faux/faux", plafondUsd: 1, silenceMin: 15 });
    T.ajouterAgent(t, "Antoine", join(dossier, "agents", "Antoine"));
    T.ajouterAgent(t, "Bernard", join(dossier, "agents", "Bernard"));
    const partage = join(dossier, "partage"), essais = join(dossier, "essais");
    await D.ouvrirDepot(partage);
    writeFileSync(join(partage, "index.html"), "v1\n");
    const h1 = (await D.commiter(partage, "Antoine", "write index.html"))!.hash;
    const bon = await D.ouvrirEssai(partage, essais, "moteur-three");
    T.noterEssai(t, "moteur-three", "Bernard", "plus léger", bon);
    writeFileSync(join(bon, "moteur.js"), "three\n");
    await D.commiter(bon, "Bernard", "write moteur.js");
    writeFileSync(join(bon, "carte.js"), "carte\n");
    await D.commiter(bon, "Bernard", "write carte.js");
    const r = await D.adopter(partage, essais, "moteur-three", "Bernard");
    if (r.ok) T.noterAdoption(t, "moteur-three", "Bernard", r.hash, r.blobs);
    const mort = await D.ouvrirEssai(partage, essais, "piste-morte");
    T.noterEssai(t, "piste-morte", "Antoine", "comparer", mort);
    writeFileSync(join(mort, "x.js"), "x\n");
    await D.commiter(mort, "Antoine", "write x.js");
    const id = T.ouvrirTicket(t, { type: "bug", titre: "page blanche", description: "index.html", auteur: "Bernard", charge: "Antoine" });
    T.majTicket(t, id, "Antoine", { etat: "ferme", commit: h1 });
    T.ouvrirTicket(t, { type: "question", titre: "quel moteur ?", description: "three ou babylon", auteur: "Antoine" });
    t.fermer();
  });

  test("tickets avec leur historique, commits de main, essais adoptés ou non", async () => {
    const r = await api("/api/runs/run-depot/depot");
    expect(r.statut).toBe(200);
    const d = r.corps as { depot: boolean; tickets: Array<{ id: number; etat: string; notes: unknown[] }>; commits: { total: number; liste: Array<{ auteur: string; message: string }>; parAgent: Record<string, number>; adoptions: Record<string, number> }; essais: Array<{ nom: string; commits: number; adopte_par: string | null; dernier: string | null }> };
    expect(d.depot).toBe(true);
    expect(d.tickets.map((k) => [k.id, k.etat, k.notes.length])).toEqual([[1, "ferme", 2], [2, "ouvert", 1]]);
    // tous faits dans la même seconde : git ne garantit l'ordre qu'à dates différentes
    expect(d.commits.liste.map((c) => `${c.auteur}:${c.message}`).sort()).toEqual(["Antoine:write index.html", "Bernard:adopter l'essai moteur-three", "Bernard:write carte.js", "Bernard:write moteur.js", "essaim:ouverture du run"]);
    expect(d.commits.total).toBe(5);
    expect(d.commits.parAgent).toEqual({ Antoine: 2, Bernard: 2 });
    expect(d.commits.adoptions).toEqual({ Bernard: 1 });
    expect(d.essais.map((e) => [e.nom, e.commits, e.adopte_par])).toEqual([["moteur-three", 2, "Bernard"], ["piste-morte", 1, null]]);
    expect(d.essais[1]!.dernier).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect((await api("/api/runs/run-depot/depot?limite=2")).corps.commits.liste).toHaveLength(2);
  });
  test("un run d'avant A7 : pas de dépôt, listes vides, pas d'erreur", async () => {
    const ancien = ouvrirBun(join(racine, "runs", "run-b", "tableau.sqlite"));
    ancien.exec("DROP TABLE ticket_notes; DROP TABLE tickets; DROP TABLE essais;");
    ancien.fermer();
    const r = await api("/api/runs/run-b/depot");
    expect(r.statut).toBe(200);
    expect(r.corps).toEqual({ depot: false, tickets: [], commits: { total: 0, liste: [], parAgent: {}, adoptions: {} }, essais: [] });
  });
});

// Fils de concentration : l'API montre les fils, leurs présents, leurs résumés de lots et leur coût ;
// un ancien tableau (sans presences, lots ni colonnes nouvelles) se lit sans erreur ni migration.
describe("les fils de concentration (T10)", () => {
  // q-neige ouvert (Claude endormi avec reveil_fil, Bernard actif, Denis y poste de dehors), deux lots clos demandés par
  // Gaston (l'un résumé, l'autre pris), q-horaire fermé avec conclusion, q-carte fermé sans, q-sieste assoupi (Agathe dort).
  function construireFils(nom: string, o: { cotes?: boolean } = {}) {
    const dossier = join(racine, "runs", nom);
    mkdirSync(dossier, { recursive: true });
    const t = ouvrirBun(join(dossier, "tableau.sqlite"));
    T.initialiser(t);
    T.ouvrirRun(t, { id: nom, missionChemin: "missions/x.md", missionTexte: "m", modele: "faux/faux", modeleFemmes: o.cotes ? "faux/faux-bis" : undefined, plafondUsd: 1, silenceMin: 15 });
    for (const [n, c] of [["Claude", "hommes"], ["Bernard", "hommes"], ["Denis", "hommes"], ["Gaston", "hommes"], ["Agathe", "femmes"]] as const)
      T.ajouterAgent(t, n, join(dossier, "agents", n), o.cotes ? (c === "femmes" ? "faux/faux-bis" : "faux/faux") : undefined, o.cotes ? c : undefined);
    for (const a of ["Claude", "Bernard", "Denis", "Gaston", "Agathe"]) T.poster(t, a, `bonjour de ${a}`);
    T.majAgent(t, "Claude", { coutUsd: 0.1 });
    T.majAgent(t, "Gaston", { coutUsd: 0.2 });
    expect(T.entrer(t, "Claude", "q-neige", "le 203 sort à 60 min")).toMatchObject({ ok: true, ouvert: true });
    expect(T.entrer(t, "Bernard", "q-neige")).toMatchObject({ ok: true, ouvert: false });
    T.poster(t, "Claude", "x".repeat(30), "q-neige");
    T.poster(t, "Bernard", "y".repeat(30), "q-neige");
    T.poster(t, "Denis", "le 203 part à 6 h 12", "q-neige", { horsFil: true });
    t.run("UPDATE presences SET reveil_fil = 1 WHERE agent = 'Claude'");
    T.endormir(t, "Claude");
    const neige = t.get<{ id: number }>("SELECT id FROM fils WHERE nom = 'q-neige'")!.id;
    const [l1] = T.lotsDuRetard(t, neige, 0, 1e9, "Gaston", o.cotes ? "femmes" : null, 30);
    T.finirLot(t, l1!.id, { ok: true, texte: `- écart de 2 min [msg ${l1!.debut_id}]`, cout: 0.011, estime: false, modele: "faux/faux" });
    expect(T.prendreLots(t, 1)).toHaveLength(1); // le second lot, pris par un résumeur que personne ne finira
    for (const a of ["Gaston", "Agathe"]) T.ajouterEvenement(t, { agent: a, type: "resumes_livres", resultat: JSON.stringify([l1!.id]) });
    T.entrer(t, "Gaston", "q-horaire", "l'horaire du 203");
    expect(T.quitter(t, "Gaston", "horaire corrigé")).toMatchObject({ ok: true, ferme: true });
    T.entrer(t, "Denis", "q-carte", "la carte 3D");
    T.sortirDuFil(t, "Denis", "perdu : passes épuisées");
    T.entrer(t, "Agathe", "q-sieste", "attendre le bilan");
    T.endormir(t, "Agathe");
    t.fermer();
  }
  // un tableau d'avant les fils : ni presences, ni lots, ni appels_livres, ni colonnes nouvelles
  function construireSansFils(nom: string) {
    construireRun(nom);
    const t = ouvrirBun(join(racine, "runs", nom, "tableau.sqlite"));
    t.exec(`DROP TABLE presences; DROP TABLE lots; DROP TABLE appels_livres;
      ALTER TABLE fils DROP COLUMN pourquoi; ALTER TABLE fils DROP COLUMN conclusion; ALTER TABLE fils DROP COLUMN ouvert_le; ALTER TABLE fils DROP COLUMN ferme_le;
      ALTER TABLE messages DROP COLUMN hors_fil; ALTER TABLE messages DROP COLUMN sommeil;`);
    t.fermer();
  }
  const lire = (nom: string) => ouvrirBun(join(racine, "runs", nom, "tableau.sqlite"), { lectureSeule: true });
  type Fil = { nom: string; pourquoi: string | null; conclusion: string | null; ouvert_par: string | null; ouvert_le: string | null; ferme_le: string | null; assoupi: boolean;
    presents: Array<{ agent: string; etat: string; reveil_fil: boolean; entre_le: string }>; lots: Array<Record<string, unknown>>; agents: Array<{ nom: string; messages: number; hors_fil: number }> };

  beforeAll(() => { construireFils("run-fils"); construireSansFils("run-sans-fils"); });

  test("/fils : état, raison, conclusion, présents, lots et messages hors du fil", async () => {
    const { statut, corps } = await api("/api/runs/run-fils/fils");
    expect(statut).toBe(200);
    const f = (nom: string) => (corps.fils as Fil[]).find((x) => x.nom === nom)!;
    expect(f("principal")).toMatchObject({ pourquoi: null, conclusion: null, ouvert_le: null, ferme_le: null, assoupi: false, presents: [], lots: [] });
    const neige = f("q-neige");
    expect(neige).toMatchObject({ pourquoi: "le 203 sort à 60 min", conclusion: null, ouvert_par: "Claude", ferme_le: null, assoupi: false });
    expect(typeof neige.ouvert_le).toBe("string");
    expect(neige.presents.map((p) => [p.agent, p.etat, p.reveil_fil]).sort()).toEqual([["Bernard", "actif", false], ["Claude", "dormant", true]]); // même milliseconde : ordre par nom
    expect(typeof neige.presents[0]!.entre_le).toBe("string");
    expect(neige.agents.find((a) => a.nom === "Denis")).toMatchObject({ messages: 1, hors_fil: 1 });
    expect(neige.agents.find((a) => a.nom === "Bernard")).toMatchObject({ messages: 1, hors_fil: 0 });
    expect(neige.lots).toHaveLength(2);
    expect(neige.lots[0]).toMatchObject({ etat: "fait", texte: expect.stringContaining("écart de 2 min"), cout_usd: 0.011, cout_estime: false, modele: "faux/faux", demande_par: "Gaston", essais: 0, messages: 1, lecteurs: ["Agathe", "Gaston"] });
    expect(neige.lots[1]).toMatchObject({ etat: "prise", texte: null, essais: 1, messages: 1, lecteurs: [] });
    expect((neige.lots[0]!.fin_id as number)).toBeLessThan(neige.lots[1]!.debut_id as number);
    expect(f("q-horaire")).toMatchObject({ conclusion: "horaire corrigé", ouvert_par: "Gaston", presents: [] });
    expect(typeof f("q-horaire").ferme_le).toBe("string");
    expect(f("q-carte")).toMatchObject({ conclusion: null, ouvert_par: "Denis", presents: [] });
    expect(typeof f("q-carte").ferme_le).toBe("string");
    expect(f("q-sieste")).toMatchObject({ assoupi: true, presents: [{ agent: "Agathe", etat: "dormant" }] });
    const denis = (corps.messages as Array<{ auteur: string; fil: string; hors_fil: boolean }>).find((m) => m.auteur === "Denis" && m.fil === "q-neige");
    expect(denis?.hors_fil).toBe(true);
    expect((corps.messages as Array<{ hors_fil: boolean }>).filter((m) => m.hors_fil)).toHaveLength(1);
  });

  test("le compteur : coût des résumés compris dans la dépense, et le fil de chaque agent", async () => {
    const c = (await api("/api/runs/run-fils")).corps;
    expect(c.cout_resumes_usd).toBeCloseTo(0.011, 6);
    expect(c.resumes).toBe(1);
    expect(c.cout_usd).toBeCloseTo(0.311, 6);
    expect(c.reste_usd).toBeCloseTo(0.689, 6);
    const e = (nom: string) => (c.equipe as Array<{ nom: string; fil: string | null; reveil_fil: boolean }>).find((a) => a.nom === nom)!;
    expect([e("Claude").fil, e("Claude").reveil_fil]).toEqual(["q-neige", true]);
    expect([e("Bernard").fil, e("Bernard").reveil_fil]).toEqual(["q-neige", false]);
    expect(e("Denis").fil).toBeNull();
    expect(e("Agathe").fil).toBe("q-sieste");
    const liste = (await api("/api/runs")).corps as Array<{ id: string; cout_usd: number }>;
    expect(liste.find((r) => r.id === "run-fils")!.cout_usd).toBeCloseTo(0.311, 6);
    const t = lire("run-fils");
    expect(T.budget(t).depense).toBeCloseTo(0.311, 6);
    t.fermer();
  });

  test("la fiche d'un agent : son fil, ce qui l'attend par fil, les résumés reçus et demandés", async () => {
    const claude = (await api("/api/runs/run-fils/agents/Claude")).corps;
    expect(claude.fil).toMatchObject({ fil: "q-neige", reveil_fil: true });
    expect(typeof claude.fil.entre_le).toBe("string");
    const attente = claude.en_attente as Array<{ fil: string; n: number }>;
    expect(attente.find((a) => a.fil === "q-neige")?.n).toBe(2); // Bernard et Denis ; ses propres messages ne l'attendent pas
    expect(attente.find((a) => a.fil === "principal")!.n).toBeGreaterThan(0);
    expect(claude.resumes).toEqual({ recus: 0, demandes: 0, cout_demandes: 0 });
    const gaston = (await api("/api/runs/run-fils/agents/Gaston")).corps;
    expect(gaston.fil).toBeNull();
    expect(gaston.resumes.recus).toBe(1);
    expect(gaston.resumes.demandes).toBe(2);
    expect(gaston.resumes.cout_demandes).toBeCloseTo(0.011, 6);
  });

  test("deux modèles : chaque lot compte du côté de son premier demandeur", async () => {
    construireFils("run-fils-mixte", { cotes: true });
    const c = (await api("/api/runs/run-fils-mixte")).corps;
    const cote = (x: string) => (c.par_cote as Array<{ cote: string; cout: number }>).find((p) => p.cote === x)!;
    expect(cote("femmes").cout).toBeCloseTo(0.011, 6); // Agathe n'a rien dépensé : c'est le résumé demandé côté femmes
    expect(cote("hommes").cout).toBeCloseTo(0.3, 6);
  });

  test("un tableau d'avant les fils : valeurs vides, aucune erreur, aucune migration", async () => {
    const f = await api("/api/runs/run-sans-fils/fils");
    expect(f.statut).toBe(200);
    for (const x of f.corps.fils as Fil[]) expect(x).toMatchObject({ pourquoi: null, conclusion: null, ouvert_par: null, ouvert_le: null, ferme_le: null, assoupi: false, presents: [], lots: [] });
    expect((f.corps.messages as Array<{ hors_fil: boolean }>).every((m) => m.hors_fil === false)).toBe(true);
    const c = (await api("/api/runs/run-sans-fils")).corps;
    expect(c.cout_resumes_usd).toBe(0);
    expect(c.resumes).toBe(0);
    expect(c.cout_usd).toBeCloseTo(0.03, 6);
    expect((c.equipe as Array<{ fil: string | null; reveil_fil: boolean }>).every((a) => a.fil === null && a.reveil_fil === false)).toBe(true);
    const fiche = (await api("/api/runs/run-sans-fils/agents/agent-02")).corps;
    expect(fiche.fil).toBeNull();
    expect(fiche.resumes).toEqual({ recus: 0, demandes: 0, cout_demandes: 0 });
    expect(Array.isArray(fiche.en_attente)).toBe(true);
    expect((await fetch(serveur.url + "/api/runs/run-sans-fils/fermer", { method: "POST" })).status).toBe(200);
    const t = lire("run-sans-fils");
    expect(T.aTable(t, "presences")).toBe(false);
    expect(T.aColonne(t, "fils", "pourquoi")).toBe(false);
    t.fermer();
  });

  test("fermer sans lanceur : présences retirées, fils fermés sans conclusion, lots pris en échec, résumés dans la dépense", async () => {
    construireFils("run-fils-ferme");
    expect((await fetch(serveur.url + "/api/runs/run-fils-ferme/fermer", { method: "POST" })).status).toBe(200);
    const t = lire("run-fils-ferme");
    expect(t.all("SELECT * FROM presences")).toEqual([]);
    expect(t.all("SELECT etat FROM lots ORDER BY id")).toEqual([{ etat: "fait" }, { etat: "echec" }]);
    expect(t.all("SELECT nom FROM fils WHERE ouvert_le IS NOT NULL AND ferme_le IS NULL")).toEqual([]);
    const annonces = t.all<{ texte: string }>("SELECT texte FROM messages WHERE auteur = 'salle' AND texte LIKE 'q-neige fermé%'").map((m) => m.texte);
    expect(annonces).toEqual(["q-neige fermé sans conclusion (lanceur absent, clos depuis la vue)"]);
    t.fermer();
    const b = (await api("/api/runs/run-fils-ferme")).corps.bilan;
    expect(b.depense).toBeCloseTo(0.311, 6);
    expect(b.resumes).toEqual({ cout: 0.011, lots: 1 });
  });
});

// Second cerveau, onglet Mémoire : faits, vérifications recalculées, livraisons, recherches ; trois
// curseurs indépendants ; lecture seule. Le barré vient de ecritDepuis : ici une fonction injectée qui compare
// details.apres au disque ; la vraie est ECRIT_DEPUIS dans src/serveur.ts.
// Plus d'outil de fil ; la vue range la conversation par sujet, un fil par ticket. /fils rend chaque ticket
// avec sa carte et, dans l'ordre du temps, son ouverture, ses changements (les annonces du fil tickets) et les messages
// des autres fils qui le citent (« #N », « ticket #N »), chacun avec son numéro et son fil.
describe("les fils par ticket (O1, 27/09)", () => {
  type Evenement = { genre: string; id: number | null; fil: string | null; auteur: string; cree_le: string; texte: string };
  type FilTicket = { id: number; type: string; etat: string; titre: string; description: string | null; auteur: string; charge: string | null; commit_ferme: string | null; cree_le: string; agents: string[]; evenements: Evenement[] };
  beforeAll(() => {
    const dossier = join(racine, "runs", "run-tickets");
    mkdirSync(dossier, { recursive: true });
    const t = ouvrirBun(join(dossier, "tableau.sqlite"));
    T.initialiser(t);
    T.ouvrirRun(t, { id: "run-tickets", missionChemin: "m", missionTexte: "m", modele: "faux/faux", plafondUsd: 1, silenceMin: 15 });
    for (const a of ["Antoine", "Bernard", "Claude"]) T.ajouterAgent(t, a, join(dossier, "agents", a));
    const ouvrir = (auteur: string, type: T.TypeTicket, titre: string, description: string, charge?: string) =>
      T.ouvrirTicket(t, { type, titre, description, auteur, charge, annonce: (n) => `[ticket #${n} · ${type}] ${titre}${charge ? ` — confié à ${charge}` : ""} : ${description}` });
    const changer = (id: number, auteur: string, m: Parameters<typeof T.majTicket>[3]) =>
      T.majTicket(t, id, auteur, m, (k, quoi) => `[ticket #${id}] ${k.titre} : ${quoi}${k.charge && k.etat !== "ferme" ? ` (chargé : ${k.charge})` : ""}`);
    T.poster(t, "Antoine", "je regarde la page d'accueil");
    const un = ouvrir("Bernard", "bug", "page blanche", "index.html ne montre rien", "Antoine");
    const deux = ouvrir("Claude", "question", "quel moteur ?", "three ou babylon, voir #1");
    T.poster(t, "Antoine", "je prends le ticket #1, la couleur #1E7F4E n'y est pour rien");
    T.poster(t, "Claude", "#2 : je penche pour three ; #99 n'existe pas ; &#1; non plus", "design");
    changer(un, "Antoine", { etat: "en_cours" });
    changer(deux, "Bernard", { etat: "ferme", reponse: "three" });
    T.poster(t, "Bernard", "merci, ticket #2 réglé");
    t.fermer();
  });

  test("un fil par ticket : la carte, puis l'ouverture, les changements et les citations, dans l'ordre du temps", async () => {
    const r = await api("/api/runs/run-tickets/fils");
    expect(r.statut).toBe(200);
    const tickets = r.corps.tickets as FilTicket[];
    expect(tickets.map((k) => [k.id, k.type, k.etat, k.titre, k.auteur, k.charge])).toEqual([
      [1, "bug", "en_cours", "page blanche", "Bernard", "Antoine"],
      [2, "question", "ferme", "quel moteur ?", "Claude", null],
    ]);
    const un = tickets[0]!, deux = tickets[1]!;
    expect(un.description).toBe("index.html ne montre rien");
    expect(un.evenements.map((e) => [e.genre, e.fil, e.auteur])).toEqual([
      ["ouverture", "tickets", "Bernard"],
      ["citation", "tickets", "Claude"], // l'annonce du #2 cite le #1 dans sa description
      ["citation", "principal", "Antoine"],
      ["changement", "tickets", "Antoine"],
    ]);
    expect(un.evenements[0]!.texte).toBe("[ticket #1 · bug] page blanche — confié à Antoine : index.html ne montre rien");
    expect(un.evenements[2]!.texte).toBe("je prends le ticket #1, la couleur #1E7F4E n'y est pour rien");
    expect(un.evenements[3]!.texte).toBe("[ticket #1] page blanche : passé en cours (chargé : Antoine)");
    for (const e of un.evenements) expect(typeof e.id).toBe("number"); // chaque annonce et chaque citation porte son numéro de message
    expect(un.agents).toEqual(["Antoine", "Bernard", "Claude"]);
    expect(deux.evenements.map((e) => [e.genre, e.fil, e.auteur])).toEqual([
      ["ouverture", "tickets", "Claude"],
      ["citation", "design", "Claude"], // tous les fils sauf les annonces du ticket lui-même ; #99 et &#1; ne citent rien
      ["changement", "tickets", "Bernard"],
      ["citation", "principal", "Bernard"],
    ]);
    const ids = deux.evenements.map((e) => e.id!);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
  });

  test("vue légère (02/10) : avec v, trois parts et leurs empreintes ; une part déjà reçue n'est pas renvoyée ; l'historique d'un ticket par /tickets/<id>", async () => {
    const complet = (await api("/api/runs/run-tickets/fils")).corps;
    const leger = (await api("/api/runs/run-tickets/fils?v=")).corps;
    expect(Object.keys(leger.versions)).toEqual(["fils", "lots", "tickets"]);
    expect(leger.fils.map((f: { nom: string }) => f.nom)).toEqual(complet.fils.map((f: { nom: string }) => f.nom));
    for (const f of leger.fils) expect(f.lots).toBeUndefined();
    expect(Object.keys(leger.lots)).toEqual(complet.fils.map((f: { nom: string }) => f.nom));
    const [un] = leger.tickets as Array<Record<string, unknown>>;
    expect(un!.evenements).toBeUndefined();
    expect(un!.description).toBeUndefined();
    expect(un!.nb_evenements).toBe(4);
    expect(un!.titre).toBe("page blanche");
    expect(leger.messages).toEqual(complet.messages);
    // rien n'a changé : ni fils, ni lots, ni tickets, seulement les empreintes et les messages nouveaux
    const v = encodeURIComponent(JSON.stringify(leger.versions));
    const rien = (await api(`/api/runs/run-tickets/fils?depuis=999&v=${v}`)).corps;
    expect(rien).toEqual({ versions: leger.versions, messages: [], reste: false });
    // une part périmée revient seule ; un v illisible vaut « rien reçu »
    const autre = encodeURIComponent(JSON.stringify({ ...leger.versions, tickets: "ancienne" }));
    expect(Object.keys((await api(`/api/runs/run-tickets/fils?depuis=999&v=${autre}`)).corps)).toEqual(["tickets", "versions", "messages", "reste"]);
    expect((await api("/api/runs/run-tickets/fils?v=%7Bpas-du-json")).corps.tickets).toHaveLength(2);
    const detail = await api("/api/runs/run-tickets/tickets/1");
    expect(detail.statut).toBe(200);
    expect(detail.corps).toEqual(complet.tickets[0]);
    expect((await api("/api/runs/run-tickets/tickets/77")).statut).toBe(404);
  });

  test("sans annonce (le tableau seul), les notes du ticket tiennent lieu d'ouverture et de changements, sans numéro", async () => {
    const dossier = join(racine, "runs", "run-tickets-muets");
    mkdirSync(dossier, { recursive: true });
    const t = ouvrirBun(join(dossier, "tableau.sqlite"));
    T.initialiser(t);
    T.ouvrirRun(t, { id: "run-tickets-muets", missionChemin: "m", missionTexte: "m", modele: "faux/faux", plafondUsd: 1, silenceMin: 15 });
    T.ajouterAgent(t, "Antoine", join(dossier, "agents", "Antoine"));
    const id = T.ouvrirTicket(t, { type: "bug", titre: "carte vide", description: "carte.js", auteur: "Antoine" });
    T.majTicket(t, id, "Antoine", { note: "je regarde" });
    t.fermer();
    const k = ((await api("/api/runs/run-tickets-muets/fils")).corps.tickets as FilTicket[])[0]!;
    expect(k.evenements.map((e) => [e.genre, e.id, e.fil, e.texte])).toEqual([["ouverture", null, null, "ouvert"], ["changement", null, null, "je regarde"]]);
  });

  test("un run d'avant les tickets : tickets vide, pas d'erreur", async () => {
    construireRun("run-sans-tickets");
    const ancien = ouvrirBun(join(racine, "runs", "run-sans-tickets", "tableau.sqlite"));
    ancien.exec("DROP TABLE ticket_notes; DROP TABLE tickets;");
    ancien.fermer();
    const r = await api("/api/runs/run-sans-tickets/fils");
    expect(r.statut).toBe(200);
    expect(r.corps.tickets).toEqual([]);
  });

  test("la vue montre les fils par ticket : section Tickets, carte, lien vers le message cité", async () => {
    const page = await (await fetch(serveur.url + "/")).text();
    for (const texte of ["ticketChoisi", "filTicket", "Confié", "voir le msg", "cite le ticket", "Ouverture", "Changement"]) expect(page).toContain(texte);
    expect(page).not.toContain("v-html");
  });
});

describe("l'onglet Mémoire (M15)", () => {
  let srv: Serveur, sansBranche: Serveur;
  const M = require("../src/memoire.ts") as typeof import("../src/memoire.ts");
  const faux: EcritDepuis = (_t, v, racines, cache) => {
    const racine = v.details.racine === "partage" ? racines.partage : racines.essais[String(v.details.racine).slice("essai:".length)]!;
    const apres = v.details.apres as Record<string, { blob: string }>;
    const disque = M.empreintes(racine, Object.keys(apres), cache);
    const changes = Object.keys(apres).filter((f) => disque.get(f)?.blob !== apres[f]!.blob);
    return changes.length ? { rien: false, texte: `écrit depuis (${changes.join(", ")}), auteur pas encore connu` } : { rien: true, relu: "12:00:00" };
  };
  const partageMem = () => join(racine, "runs", "run-memoire", "partage");
  const appel = async (s: Serveur, chemin: string) => { const r = await fetch(s.url + chemin); return { statut: r.status, corps: await r.json() }; };

  beforeAll(() => {
    const dossier = join(racine, "runs", "run-memoire");
    mkdirSync(join(dossier, "partage"), { recursive: true });
    mkdirSync(join(dossier, "essais", "menu-2"), { recursive: true });
    writeFileSync(join(dossier, "partage", "app.js"), "v1\n");
    utimesSync(join(dossier, "partage", "app.js"), 1_790_000_000, 1_790_000_000); // date entière : les tests la remettent à l'identique
    writeFileSync(join(dossier, "essais", "menu-2", "menu.js"), "m1\n");
    const t = ouvrirBun(join(dossier, "tableau.sqlite"));
    T.initialiser(t);
    T.ouvrirRun(t, { id: "run-memoire", missionChemin: "m", missionTexte: "m", modele: "faux/faux", plafondUsd: 1, silenceMin: 15 });
    for (const a of ["Antoine", "Bernard"]) T.ajouterAgent(t, a, join(dossier, "agents", a));
    T.poster(t, "Antoine", "je regarde le menu");
    expect(T.entrer(t, "Antoine", "q-menu", "le menu casse")).toMatchObject({ ok: true }); // fait 1 : fil, déclaré, msg 2
    expect(T.reclamer(t, "Bernard", "app.js", "refonte")).toEqual({ ok: true });            // fait 2 : pancarte
    const verif = (agent: string, racineFait: string, dossierFait: string, fichier: string, statut: T.StatutVerification) => {
      const e = M.empreintes(dossierFait, [fichier]);
      t.transaction(() => T.noterFait(t, { type: "verification", agent, source: "page_voir", sujet: fichier, statut,
        texte: `vérifié · page_voir ${fichier} · page saine (0) · ${agent}`,
        details: { avant: Object.fromEntries(e), apres: Object.fromEntries(e), fichiers: [fichier], racine: racineFait, head: null, code: 0 } }));
    };
    verif("Bernard", "partage", join(dossier, "partage"), "app.js", "verifie");                  // fait 3
    verif("Antoine", "essai:menu-2", join(dossier, "essais", "menu-2"), "menu.js", "instable");  // fait 4
    // les livraisons, ici en SQL, une confirmée, une non confirmée, une ligne courte
    const livrer = (agent: string, moment: string, texte: string, confirme: boolean) => t.run(
      `INSERT INTO memoire_livraisons(agent, livre_le, moment, de_fait, a_fait, a_message, lignes, retires, caracteres, texte, confirme_le)
       VALUES (?, '2026-09-27T12:00:00.000Z', ?, 0, 4, 3, 2, 1, ?, ?, ?)`, [agent, moment, texte.length, texte, confirme ? "2026-09-27T12:00:01.000Z" : null]);
    livrer("Antoine", "reveil", "[salle] Changements depuis 11:50\n12:00 vérifié · page_voir app.js", true);
    livrer("Bernard", "resume", "[salle] Changements depuis 11:40\n12:00 q-menu ouvert", false);
    livrer("Antoine", "ligne", "[salle] 12:01 Bernard · app.js", true);
    // les recherches : lues dans la bande (tool_execution_start pour les paramètres, _end pour la réponse)
    const chercher = (agent: string, id: string, args: unknown, resultat: string, erreur?: string) => {
      T.ajouterEvenement(t, { agent, type: "tool_execution_start", outil: "salle_chercher", appelId: id, arguments: args });
      T.ajouterEvenement(t, { agent, type: "tool_execution_end", outil: "salle_chercher", appelId: id, resultat, erreur });
    };
    chercher("Antoine", "c1", { mots: "navigation.js" }, "[commit] 3f2a1bc · 12:00 · Antoine : write [navigation.js]\n[message] msg 2 · principal · 12:00 · salle : x");
    chercher("Bernard", "c2", { mots: "zzz", type: "fait" }, "aucun résultat pour « zzz » avec type: fait");
    chercher("Bernard", "c3", {}, "refusé : ni mots, ni numéro, ni filtre. Se lève avec des mots", "refusé : ni mots, ni numéro, ni filtre. Se lève avec des mots");
    chercher("Antoine", "c4", { numero: 1, jusqua: 2 }, "[principal] message 1, 2026-09-27 Antoine : je regarde le menu\n[principal] message 2, 2026-09-27 salle : Antoine ouvre q-menu : le menu casse");
    T.ajouterEvenement(t, { agent: "Antoine", type: "tool_execution_end", outil: "salle_poster", appelId: "c5", resultat: "message 3 posté" }); // pas une recherche
    t.fermer();
    srv = creerServeur({ racine, port: 0, ecritDepuis: faux });
    sansBranche = creerServeur({ racine, port: 0, ecritDepuis: null });
  });
  afterAll(() => { srv.arreter(); sansBranche.arreter(); });

  test("faits, vérifications, livraisons et recherches, depuis zéro", async () => {
    const r = await appel(srv, "/api/runs/run-memoire/memoire?faits=0&livraisons=0&recherches=0");
    expect(r.statut).toBe(200);
    const d = r.corps;
    expect(d.absente).toBeUndefined();
    expect(d.faits.map((f: { id: number; type: string; agent: string }) => [f.id, f.type, f.agent])).toEqual([[1, "fil", "Antoine"], [2, "pancarte", "Bernard"], [3, "verification", "Bernard"], [4, "verification", "Antoine"]]);
    const fil = d.faits[0];
    expect(fil).toMatchObject({ source: "tableau", sujet: "q-menu", statut: null, message_id: 2, message: { id: 2, fil: "principal" } });
    expect(fil.texte).toContain("déclaré par Antoine, msg 2");
    expect(fil.cree_le).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(d.faits[1].message).toBeNull();
    expect(d.faits[3]).toMatchObject({ statut: "instable", source: "page_voir", sujet: "menu.js" });
    expect(d.verifications).toEqual([{ id: 3, perimee: false, texte: "rien écrit depuis (relu à 12:00:00)" }, { id: 4, perimee: false, texte: "rien écrit depuis (relu à 12:00:00)" }]);
    expect(d.livraisons.map((l: { agent: string; moment: string; confirmee: boolean }) => [l.agent, l.moment, l.confirmee])).toEqual([["Antoine", "reveil", true], ["Bernard", "resume", false], ["Antoine", "ligne", true]]);
    expect(d.livraisons[0]).toMatchObject({ lignes: 2, retires: 1, a_fait: 4, texte: "[salle] Changements depuis 11:50\n12:00 vérifié · page_voir app.js" });
    expect(d.livraisons[1].confirme_le).toBeNull();
    expect(d.recherches.map((x: { agent: string; resultats: number | null; vide: boolean; refus: boolean }) => [x.agent, x.resultats, x.vide, x.refus]))
      .toEqual([["Antoine", 2, false, false], ["Bernard", 0, true, false], ["Bernard", 0, false, true], ["Antoine", 2, false, false]]);
    expect(d.recherches[0].parametres).toEqual({ mots: "navigation.js" });
    expect(d.recherches[1].reponse).toBe("aucun résultat pour « zzz » avec type: fait");
    expect(d.recherches[0].horodatage).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(d.curseurs.faits).toBe(4);
    expect(d.curseurs.livraisons).toBe(3);
    expect(d.curseurs.recherches).toBeGreaterThan(0);
  });

  test("trois curseurs indépendants", async () => {
    const tout = (await appel(srv, "/api/runs/run-memoire/memoire?faits=0&livraisons=0&recherches=0")).corps;
    const d = (await appel(srv, `/api/runs/run-memoire/memoire?faits=2&livraisons=0&recherches=${tout.recherches[1].id}`)).corps;
    expect(d.faits.map((f: { id: number }) => f.id)).toEqual([3, 4]);
    expect(d.livraisons).toHaveLength(3);
    expect(d.recherches.map((x: { id: number }) => x.id)).toEqual([tout.recherches[2].id, tout.recherches[3].id]);
    const rien = (await appel(srv, `/api/runs/run-memoire/memoire?faits=4&livraisons=3&recherches=${tout.curseurs.recherches}`)).corps;
    expect([rien.faits, rien.livraisons, rien.recherches]).toEqual([[], [], []]);
    expect(rien.curseurs).toEqual(tout.curseurs);
    expect(rien.verifications).toHaveLength(2); // recalculées à chaque sondage, quel que soit le curseur des faits
  });

  test("une vérification déjà rendue revient barrée au sondage suivant quand son fichier change", async () => {
    const avant = (await appel(srv, "/api/runs/run-memoire/memoire?faits=4&livraisons=3&recherches=999")).corps;
    expect(avant.verifications.find((v: { id: number }) => v.id === 3).perimee).toBe(false);
    writeFileSync(join(partageMem(), "app.js"), "v2, écrit depuis\n");
    const apres = (await appel(srv, "/api/runs/run-memoire/memoire?faits=4&livraisons=3&recherches=999")).corps;
    expect(apres.faits).toEqual([]);
    expect(apres.verifications.find((v: { id: number }) => v.id === 3)).toEqual({ id: 3, perimee: true, texte: "écrit depuis (app.js), auteur pas encore connu" });
    expect(apres.verifications.find((v: { id: number }) => v.id === 4).perimee).toBe(false); // l'essai n'a pas bougé
    rmSync(join(partageMem(), "app.js")); // fichier supprimé depuis : toujours barrée, sans erreur
    const supprime = (await appel(srv, "/api/runs/run-memoire/memoire?faits=4&livraisons=3&recherches=999")).corps;
    expect(supprime.verifications.find((v: { id: number }) => v.id === 3).perimee).toBe(true);
    writeFileSync(join(partageMem(), "app.js"), "v1\n");
    utimesSync(join(partageMem(), "app.js"), 1_790_000_000, 1_790_000_000); // contenu et date d'avant : la vraie ecritDepuis compare aussi la date
  });

  test("point de branchement : sans ecritDepuis (phase 7 pas encore réunie), verifications vide, le reste rendu", async () => {
    const d = (await appel(sansBranche, "/api/runs/run-memoire/memoire?faits=0&livraisons=0&recherches=0")).corps;
    expect(d.verifications).toEqual([]);
    expect(d.faits).toHaveLength(4);
    expect(d.livraisons).toHaveLength(3);
  });

  // Le test du barré sur la vraie fonction : ignoré tant que ECRIT_DEPUIS n'est pas branché
  // (serveur par défaut, sans injection). Textes attendus : « rien écrit depuis (relu à …) », « écrit depuis … ».
  test.skipIf(!ECRIT_DEPUIS)("branché (phase 7) : la vraie ecritDepuis barre une vérification quand son fichier change", async () => {
    const lire = async () => (await appel(serveur, "/api/runs/run-memoire/memoire?faits=4&livraisons=3&recherches=999")).corps.verifications as Array<{ id: number; perimee: boolean; texte: string }>;
    expect((await lire()).find((v) => v.id === 3)).toMatchObject({ perimee: false, texte: expect.stringContaining("rien écrit depuis (relu à ") });
    writeFileSync(join(partageMem(), "app.js"), "v3, sans commit\n");
    try {
      expect((await lire()).find((v) => v.id === 3)).toMatchObject({ perimee: true, texte: expect.stringContaining("écrit depuis (app.js)") });
    } finally { writeFileSync(join(partageMem(), "app.js"), "v1\n"); utimesSync(join(partageMem(), "app.js"), 1_790_000_000, 1_790_000_000); }
  });

  test("une fonction ecritDepuis qui lève : la vérification est laissée de côté, pas d'erreur", async () => {
    const casse = creerServeur({ racine, port: 0, ecritDepuis: (_t, v) => { if (v.id === 3) throw new Error("x"); return { rien: true, relu: "12:00:00" }; } });
    try {
      const d = (await appel(casse, "/api/runs/run-memoire/memoire?faits=0&livraisons=0&recherches=0")).corps;
      expect(d.verifications.map((v: { id: number }) => v.id)).toEqual([4]);
    } finally { casse.arreter(); }
  });

  test("lecture seule : la base n'est pas écrite", async () => {
    const base = join(racine, "runs", "run-memoire", "tableau.sqlite");
    const empreinte = () => new Bun.CryptoHasher("sha256").update(require("node:fs").readFileSync(base)).digest("hex");
    const avant = empreinte();
    await appel(srv, "/api/runs/run-memoire/memoire?faits=0&livraisons=0&recherches=0");
    await appel(srv, "/api/runs/run-memoire/memoire");
    expect(empreinte()).toBe(avant);
    expect(existsSync(base + "-wal") ? statSync(base + "-wal").size : 0).toBe(0);
  });

  test("un run d'avant le second cerveau (pas de table faits) : absente ; run inconnu 404 ; base pas prête 503", async () => {
    const dossier = join(racine, "runs", "run-sans-faits");
    mkdirSync(dossier, { recursive: true });
    const t = ouvrirBun(join(dossier, "tableau.sqlite"));
    T.initialiser(t);
    T.ouvrirRun(t, { id: "run-sans-faits", missionChemin: "m", missionTexte: "m", modele: "faux/faux", plafondUsd: 1, silenceMin: 15 });
    t.exec("DROP TABLE faits");
    t.fermer();
    expect((await appel(srv, "/api/runs/run-sans-faits/memoire")).corps).toEqual({ absente: true });
    expect((await appel(srv, "/api/runs/inconnu/memoire")).statut).toBe(404);
    expect((await appel(srv, "/api/runs/run-vide/memoire")).statut).toBe(503);
  });

  test("l'écran : septième onglet Mémoire après Dépôt, libellé et icône de salle_chercher, les trois parties", async () => {
    const page = await (await fetch(serveur.url + "/")).text();
    const ecrans = new Function(`return ${page.match(/ecrans: (\[[^\]]*\]),/)![1]};`)() as Array<{ id: string; nom: string }>;
    expect(ecrans.map((e) => e.id)).toEqual(["essaims", "fils", "agents", "trace", "cerveau", "depot", "memoire"]);
    expect(ecrans[6]).toEqual({ id: "memoire", nom: "Mémoire" });
    const objet = (nom: string) => new Function(`return ${page.match(new RegExp(`const ${nom} = (\\{[\\s\\S]*?\\});\\n`))![1]};`)() as Record<string, string>;
    expect(objet("LIBELLES_ACTION").salle_chercher).toBe("cherche dans la salle");
    expect(objet("ICONES_ACTION").salle_chercher).toBe("i-chercher");
    for (const texte of ["ecran === 'memoire'", "/memoire?faits=", "Ce que chaque agent a reçu", "Journal des faits", "Recherches des agents", "non confirmée", "perimee", "aucun résultat", "d'avant le second cerveau"])
      expect(page).toContain(texte);
    expect(page).not.toContain("v-html");
  });

  test("run sans livraison ni recherche : listes vides", async () => {
    const d = (await appel(srv, "/api/runs/run-cerveau/memoire")).corps;
    expect(d.livraisons).toEqual([]);
    expect(d.recherches).toEqual([]);
    expect(Array.isArray(d.faits)).toBe(true);
  });
});

// Rôles des agents : la vue lit le rôle et le suppléant de chaque agent, la sorte et le motif de
// chaque ticket, sa reproduction figée, qui l'a ouvert, qui l'a confié, à qui successivement, et qui est dedans. Lecture
// seule ; un run sans rôles, ou d'avant les colonnes, se lit comme avant.
describe("les rôles dans la vue (R10)", () => {
  const annonce = (titre: string) => (n: number) => `[ticket #${n} · bug] ${titre}`;
  const changer = (t: ReturnType<typeof ouvrirBun>, id: number, auteur: string, m: Parameters<typeof T.majTicket>[3]) =>
    T.majTicket(t, id, auteur, m, (k, quoi) => `[ticket #${id}] ${k.titre} : ${quoi}`);
  function construireRoles(nom: string) {
    const dossier = join(racine, "runs", nom);
    mkdirSync(dossier, { recursive: true });
    const t = ouvrirBun(join(dossier, "tableau.sqlite"));
    T.initialiser(t);
    T.ouvrirRun(t, { id: nom, missionChemin: "missions/hopital.md", missionTexte: "# Hôpital\n\n## Type\nprobleme", modele: "faux/faux", plafondUsd: 1, silenceMin: 15 });
    const sieges: Array<[string, string, string?, string?]> = [["Antoine", "chef"], ["Bernard", "integrateur"], ["Claude", "constructeur", "integrateur"],
      ["Denis", "constructeur", "chef"], ["Lucien", "constructeur"], ["Marcel", "constructeur"], ["Valentin", "recette", undefined, "faux/glm"], ["Xavier", "gardien", undefined, "faux/glm"]];
    for (const [n, role, suppleantDe, modele] of sieges) T.ajouterAgent(t, n, join(dossier, "agents", n), modele ?? "faux/faux", undefined, { role, suppleantDe });
    T.poster(t, "Antoine", "je répartis");
    T.poster(t, "Bernard", "contrat posé", "contrat");
    T.poster(t, "Antoine", "vu", "contrat");
    // #1 : une part confiée à Lucien, perdu, rendue au chef, confiée à Marcel
    const un = T.ouvrirTicket(t, { type: "amelioration", titre: "Vérificateur", description: "indépendant", auteur: "Antoine", charge: "Lucien", annonce: annonce("Vérificateur") });
    T.poster(t, "Lucien", "je commence #1");
    T.sortirAgent(t, "Lucien", "perdu", "passes épuisées");
    T.transfererTickets(t, "Lucien", "Antoine", "perdu");
    expect(changer(t, un, "Antoine", { charge: "Marcel" })).toEqual({ ok: true });
    // #2 : une alerte de la recette, confiée par le chef à Denis
    const repro: T.Reproduction = { commande: "bun verifier.ts --jour 2026-11-14", graine: "7", commit: "abc1234", banc: {}, monde: {} };
    const deux = T.ouvrirTicket(t, { type: "bug", titre: "Référent de nuit", description: "manque", auteur: "Valentin", sorte: "alerte", reproduction: repro, annonce: annonce("Référent de nuit") });
    expect(changer(t, deux, "Antoine", { charge: "Denis" })).toEqual({ ok: true });
    T.poster(t, "Denis", "je corrige #2");
    T.poster(t, "Xavier", "vu #2 aussi");
    // #3 : annulé avec sa raison ; #4 : une alerte fermée comme fausse, sur un reçu
    const trois = T.ouvrirTicket(t, { type: "amelioration", titre: "Lecture SQLite", description: "csv", auteur: "Antoine", charge: "Claude" });
    expect(changer(t, trois, "Antoine", { motif: "annule", note: "la lecture en mémoire suffit" })).toEqual({ ok: true });
    const quatre = T.ouvrirTicket(t, { type: "bug", titre: "Heures dues", description: "80 %", auteur: "Xavier", sorte: "alerte", reproduction: repro });
    expect(changer(t, quatre, "Bernard", { motif: "invalide", recu: "reçu 3" })).toEqual({ ok: true });
    // la trace : un refus du rôle
    T.ajouterEvenement(t, { agent: "Valentin", type: "tool_execution_end", outil: "write", appelId: "w1", resultat: "refusé : la recette n'écrit pas le produit" });
    T.ajouterEvenement(t, { agent: "Antoine", type: "tool_execution_end", outil: "ticket_ouvrir", appelId: "t1", resultat: "ticket #1 ouvert" });
    t.fermer();
  }
  beforeAll(() => {
    construireRoles("run-roles");
    construireRoles("run-roles-avant"); // puis retiré des colonnes des rôles : un ancien run
    const t = ouvrirBun(join(racine, "runs", "run-roles-avant", "tableau.sqlite"));
    for (const sql of ["ALTER TABLE agents DROP COLUMN role", "ALTER TABLE agents DROP COLUMN suppleant_de", "ALTER TABLE tickets DROP COLUMN sorte", "ALTER TABLE tickets DROP COLUMN motif",
      "ALTER TABLE tickets DROP COLUMN remplace_par", "ALTER TABLE tickets DROP COLUMN reproduction", "ALTER TABLE tickets DROP COLUMN bloque_par", "ALTER TABLE tickets DROP COLUMN chemins", "DROP TABLE demandes_rejeu"]) t.exec(sql);
    t.fermer();
  });

  test("par_modele : un run à rôles sur deux modèles, la dépense de chacun avec ses rôles ; nul sans rôles", async () => {
    const c = (await api("/api/runs/run-roles")).corps;
    expect(c.par_cote).toBeNull();
    expect(c.par_modele.map((m: { modele: string; agents: number; roles: string[] }) => [m.modele, m.agents, m.roles])).toEqual([
      ["faux/faux", 6, ["chef", "integrateur", "constructeur"]], ["faux/glm", 2, ["recette", "gardien"]]]);
    expect(c.par_modele[0]).toMatchObject({ finis: expect.any(Number), cout: expect.any(Number), coutEstime: false, tokens: expect.any(Number), appels: expect.any(Number), messages: expect.any(Number) });
    expect((await api("/api/runs/run-roles-avant")).corps.par_modele).toBeNull();
    expect((await api("/api/runs/run-a")).corps.par_modele).toBeNull();
    expect((await api("/api/runs/run-mixte")).corps.par_modele).toBeNull();
  });

  test("l'équipe du compteur : rôle, suppléant et modèle de chaque agent, dans l'ordre d'entrée", async () => {
    const c = (await api("/api/runs/run-roles")).corps;
    expect(c.equipe.map((a: { nom: string; role: string; suppleant_de: string | null; modele: string }) => [a.nom, a.role, a.suppleant_de, a.modele])).toEqual([
      ["Antoine", "chef", null, "faux/faux"], ["Bernard", "integrateur", null, "faux/faux"], ["Claude", "constructeur", "integrateur", "faux/faux"],
      ["Denis", "constructeur", "chef", "faux/faux"], ["Lucien", "constructeur", null, "faux/faux"], ["Marcel", "constructeur", null, "faux/faux"],
      ["Valentin", "recette", null, "faux/glm"], ["Xavier", "gardien", null, "faux/glm"]]);
    expect((await api("/api/runs/run-roles/agents/Claude")).corps.agent).toMatchObject({ role: "constructeur", suppleant_de: "integrateur" });
    expect((await api("/api/runs/run-roles/cerveau")).corps.agents.map((a: { nom: string; role: string }) => a.role)).toEqual(
      ["chef", "integrateur", "constructeur", "constructeur", "constructeur", "constructeur", "recette", "gardien"]);
  });

  test("les fils : qui est dedans, dans l'ordre d'arrivée, sans la salle", async () => {
    const f = (await api("/api/runs/run-roles/fils")).corps;
    const fil = (nom: string) => f.fils.find((x: { nom: string }) => x.nom === nom);
    expect(fil("principal").dedans).toEqual(["Antoine", "Lucien", "Denis", "Xavier"]);
    expect(fil("contrat").dedans).toEqual(["Bernard", "Antoine"]);
  });

  test("les tickets des fils : sorte, motif, reproduction, ouvert par, confié par, chargés successifs, qui est dedans", async () => {
    const k = (await api("/api/runs/run-roles/fils")).corps.tickets as Array<Record<string, unknown>>;
    expect(k.map((x) => [x.id, x.sorte, x.etat, x.motif, x.auteur, x.confie_par, x.charge])).toEqual([
      [1, "travail", "ouvert", null, "Antoine", "Antoine", "Marcel"],
      [2, "alerte", "ouvert", null, "Valentin", "Antoine", "Denis"],
      [3, "travail", "ferme", "annule", "Antoine", "Antoine", "Claude"],
      [4, "alerte", "ferme", "invalide", "Xavier", null, null]]);
    expect(k[0]!.charges).toEqual(["Lucien", "Antoine", "Marcel"]);
    expect(k[1]!.charges).toEqual(["Denis"]);
    expect(k[1]!.reproduction).toMatchObject({ commande: "bun verifier.ts --jour 2026-11-14", graine: "7", commit: "abc1234" });
    expect(k[0]!.reproduction).toBeNull();
    expect(k[0]!.dedans).toEqual(["Antoine", "Lucien"]); // la salle (transfert) n'est pas un agent
    expect(k[1]!.dedans).toEqual(["Valentin", "Antoine", "Denis", "Xavier"]);
    expect(k[2]!.note_cloture).toBe("la lecture en mémoire suffit");
    expect(k[3]!.recu).toBe("reçu 3");
  });

  test("le dépôt : les mêmes champs sur chaque ticket", async () => {
    const d = (await api("/api/runs/run-roles/depot")).corps;
    expect(d.tickets.map((x: Record<string, unknown>) => [x.id, x.sorte, x.motif, x.confie_par])).toEqual([
      [1, "travail", null, "Antoine"], [2, "alerte", null, "Antoine"], [3, "travail", "annule", "Antoine"], [4, "alerte", "invalide", null]]);
    expect(d.tickets[0].charges).toEqual(["Lucien", "Antoine", "Marcel"]);
    expect(d.tickets[1].reproduction).toMatchObject({ commande: "bun verifier.ts --jour 2026-11-14" });
  });

  test("la trace filtrée par rôle ; un rôle inconnu : 400", async () => {
    const e = (await api("/api/runs/run-roles/evenements?role=recette")).corps.evenements as Array<{ agent: string }>;
    expect(e.map((x) => x.agent)).toEqual(["Valentin"]);
    expect((await api("/api/runs/run-roles/evenements?role=chef")).corps.evenements.map((x: { agent: string }) => x.agent)).toEqual(["Antoine"]);
    expect((await api("/api/runs/run-roles/evenements?role=pirate")).statut).toBe(400);
  });

  test("un run d'avant les rôles : rôles nuls, tickets de travail sans motif, filtre par rôle vide, aucune migration", async () => {
    const c = (await api("/api/runs/run-roles-avant")).corps;
    expect(c.equipe.every((a: { role: unknown; suppleant_de: unknown }) => a.role === null && a.suppleant_de === null)).toBe(true);
    expect((await api("/api/runs/run-roles-avant/agents/Claude")).corps.agent).toMatchObject({ role: null, suppleant_de: null });
    const k = (await api("/api/runs/run-roles-avant/fils")).corps.tickets as Array<Record<string, unknown>>;
    expect(k.map((x) => [x.id, x.sorte, x.motif, x.reproduction])).toEqual([[1, "travail", null, null], [2, "travail", null, null], [3, "travail", null, null], [4, "travail", null, null]]);
    expect(k[0]!.charges).toEqual(["Lucien", "Antoine", "Marcel"]);
    expect((await api("/api/runs/run-roles-avant/depot")).corps.tickets.map((x: { sorte: string }) => x.sorte)).toEqual(["travail", "travail", "travail", "travail"]);
    expect((await api("/api/runs/run-roles-avant/evenements?role=recette")).corps.evenements).toEqual([]);
    expect((await api("/api/runs/run-roles-avant/cerveau")).corps.agents.every((a: { role: unknown }) => a.role === null)).toBe(true);
    const t = ouvrirBun(join(racine, "runs", "run-roles-avant", "tableau.sqlite"), { lectureSeule: true });
    expect(T.aColonne(t, "agents", "role")).toBe(false);
    t.fermer();
  });

  test("un run sans rôles (colonnes présentes, vides) : rôles nuls", async () => {
    const c = (await api("/api/runs/run-a")).corps;
    expect(c.equipe.every((a: { role: unknown }) => a.role === null)).toBe(true);
  });

  test("la vue : l'équipe en familles, les jetons de qui est dedans, les issues d'alerte, les droits, le filtre par rôle, la légende du cerveau", async () => {
    const page = await (await fetch(serveur.url + "/")).text();
    for (const texte of ["Organiser", "Assembler", "Construire", "Contrôler", "suppléant", "toute l'équipe", "fausse alerte", "corrigée", "Reproduction figée", "Ouverte par",
      "tous les rôles", "Ce que ses outils permettent", "Confié par → à", "remplacé par", '<symbol id="r-chef"', '<symbol id="r-gardien"', "legende-roles"])
      expect(page).toContain(texte);
    expect(page).not.toContain("v-html");
    expect(page).not.toContain("innerHTML =");
    const module = await (await fetch(serveur.url + "/cerveau.js")).text();
    expect(module).toContain("icones"); // l'icône du rôle sur chaque neurone, passée par la vue
  });
  test("les droits de la fiche d'agent sont ceux de src/roles.ts (DROITS), et chaque rôle a son icône", async () => {
    const page = await (await fetch(serveur.url + "/")).text();
    const copie = page.match(/const DROITS = (\{[^\n]*\});\n/);
    expect(copie).not.toBeNull();
    expect(JSON.parse(copie![1]!)).toEqual(DROITS);
    for (const r of ROLES) expect(page).toContain(`<symbol id="r-${r}"`);
  });
});

describe("les exigences et les preuves dans la vue (R10, phase 7 partie 2)", () => {
  const repro: T.Reproduction = { commande: "bun verifier.ts", graine: "7", commit: "abc1234", banc: {}, monde: {} };
  // Un reçu du lanceur, écrit comme P.rejouer l'écrit ; empreintes : celles d'aujourd'hui, ou un produit changé depuis (périmé).
  function ecrireRecu(dossier: string, t: ReturnType<typeof ouvrirBun>, n: number, o: { exigence?: string; ticket?: number; motif?: "corrige" | "invalide"; demandeur: string; passe: boolean; perime?: boolean }) {
    const actuel = P.releverActuel(dossier);
    const produit = o.perime ? { ...actuel.produit, "index.html": "0000000000000000000000000000000000000000" } : actuel.produit;
    // Le gardien mesure avec un fichier de son bureau privé, comme preuve_attester l'exige (et le compte).
    const prive = join(dossier, "agents", o.demandeur, "prive", "cas.json");
    if (o.demandeur === "Xavier") { mkdirSync(join(prive, ".."), { recursive: true }); writeFileSync(prive, "{}"); }
    const recu: P.Recu = { n, demande: n, sorte: o.ticket ? "alerte" : "exigence", ...(o.ticket ? { ticket: o.ticket } : {}), ...(o.exigence ? { exigence: o.exigence } : {}), ...(o.motif ? { motif: o.motif } : {}),
      demandeur: o.demandeur, commande: o.demandeur === "Xavier" ? `bun verifier.ts ${prive}` : "bun verifier.ts", graine: "7", commit: "def5678", conditions: { banc: [], monde: [] },
      empreintes: { banc: {}, monde: actuel.monde, produit }, code: o.passe ? 0 : 1, sortie: o.passe ? "ok" : "il manque 1 référent", dureeMs: 40,
      date: "2026-09-28T10:58:00.000Z", passe: o.passe, texte: `preuves/${n}.json · ${o.passe ? "passe (code 0)" : "ne passe pas (code 1)"}` };
    writeFileSync(join(dossier, "preuves", `${n}.json`), JSON.stringify(recu));
    T.finirRejeu(t, n, `preuves/${n}.json`, { passe: o.passe, code: recu.code, texte: recu.texte });
  }
  function construirePreuves(nom: string) {
    const dossier = join(racine, "runs", nom);
    for (const d of ["partage", "entrees", "preuves"]) mkdirSync(join(dossier, d), { recursive: true });
    writeFileSync(join(dossier, "partage", "index.html"), "<p>planning</p>");
    writeFileSync(join(dossier, "entrees", "besoins.csv"), "poste;effectif\n");
    const t = ouvrirBun(join(dossier, "tableau.sqlite"));
    T.initialiser(t);
    T.ouvrirRun(t, { id: nom, missionChemin: "missions/hopital.md", missionTexte: "# Hôpital\n\n## Type\nprobleme", modele: "faux/faux", plafondUsd: 1, silenceMin: 15 });
    for (const [n, role] of [["Antoine", "chef"], ["Bernard", "integrateur"], ["Denis", "constructeur"], ["Valentin", "recette"], ["Xavier", "gardien"]] as const)
      T.ajouterAgent(t, n, join(dossier, "agents", n), "faux/faux", undefined, { role });
    T.noterPhrases(t, [{ n: 1, section: "But", texte: "L'effectif minimal est atteint." }, { n: 2, section: "But", texte: "Le repos minimal est respecté." },
      { n: 3, section: "But", texte: "Chacun a ses week-ends." }, { n: 4, section: "Page", texte: "La page se lit sur téléphone." },
      { n: 5, section: "Page", texte: "Elle s'imprime en A3." }, { n: 6, section: "Contexte", texte: "Le service a 46 soignants." }, { n: 7, section: "Page", texte: "Et reste sobre." }]);
    for (const [ph, cl, resp] of [[[1], "exigence", "gardien"], [[2], "exigence", "gardien"], [[3], "exigence", "gardien"], [[4], "exigence", "recette"], [[5, 7], "transversale", "recette"], [[6], "contexte", undefined]] as const)
      expect(T.rangerExigence(t, { phrases: [...ph], classement: cl, responsable: resp, par: "Antoine" }).ok).toBe(true);
    // E1 prouvée (reçu 1), E2 à reprouver (reçu 2 périmé), E3 non vérifiée, E4 à prouver et son dernier reçu échoue (3), E5 à prouver avec une alerte ouverte
    for (const [e, qui] of [["E1", "Xavier"], ["E2", "Xavier"], ["E4", "Valentin"]] as const) expect(T.demanderPreuve(t, { exigence: e, demandeur: qui, commande: "bun verifier.ts", graine: "7", reproduction: repro }).ok).toBe(true);
    ecrireRecu(dossier, t, 1, { exigence: "E1", demandeur: "Xavier", passe: true });
    ecrireRecu(dossier, t, 2, { exigence: "E2", demandeur: "Xavier", passe: true, perime: true });
    ecrireRecu(dossier, t, 3, { exigence: "E4", demandeur: "Valentin", passe: false });
    T.attester(t, { exigence: "E1", agent: "Xavier", role: "gardien", nature: "mesure", recu: "preuves/1.json", portee: "les 28 jours, tous les postes" });
    T.attester(t, { exigence: "E2", agent: "Xavier", role: "gardien", nature: "mesure", recu: "preuves/2.json", portee: "les nuits" });
    T.attester(t, { exigence: "E3", agent: "Xavier", role: "gardien", nature: "mesure", recu: null, portee: "aucune commande ne le mesure" });
    T.apprecier(t, { exigence: "E1", agent: "Xavier", role: "gardien", texte: "lisible", portee: "vue d'ensemble" });
    const alerte = T.ouvrirTicket(t, { type: "bug", titre: "E5 : l'impression coupe la semaine 4", description: "A3 paysage", auteur: "Valentin", charge: "Denis", sorte: "alerte", reproduction: repro });
    expect(T.demanderRejeu(t, { ticket: alerte, demandeur: "Denis", motif: "corrige", commit: "def5678" }).ok).toBe(true);
    ecrireRecu(dossier, t, 4, { ticket: alerte, motif: "corrige", demandeur: "Denis", passe: false });
    expect(T.contesterExigence(t, { exigence: "E2", raison: "c'est une transversale", par: "Xavier", chef: "Antoine" }).ok).toBe(true);
    expect(T.contesterExigence(t, { phrases: [6], raison: "46 soignants est une exigence", par: "Xavier", chef: "Antoine" }).ok).toBe(true);
    t.fermer();
  }
  beforeAll(() => {
    construirePreuves("run-preuves");
    construirePreuves("run-preuves-avant"); // puis privé des tables des preuves : un ancien run
    const t = ouvrirBun(join(racine, "runs", "run-preuves-avant", "tableau.sqlite"));
    for (const table of ["phrases", "exigences", "contestations", "attestations", "appreciations"]) t.exec(`DROP TABLE ${table}`);
    t.fermer();
  });

  test("/exigences : les exigences actives, leur texte, leur état, la signature, le reçu signé et le dernier reçu", async () => {
    const r = await api("/api/runs/run-preuves/exigences");
    expect(r.statut).toBe(200);
    const e = r.corps.exigences as Array<Record<string, any>>;
    expect(e.map((x) => [x.libelle, x.classement, x.responsable, x.etat])).toEqual([
      // E2 : le produit a changé depuis son reçu, pas le banc : à rejouer par le lanceur, plus « périmée ».
      ["E1", "exigence", "gardien", "attestee"], ["E2", "exigence", "gardien", "a_rejouer"], ["E3", "exigence", "gardien", "non_verifiee"],
      ["E4", "exigence", "recette", "a_prouver"], ["E5", "transversale", "recette", "a_prouver"]]);
    expect(e[4]!.phrases).toEqual([5, 7]);
    expect(e[4]!.texte).toBe("Elle s'imprime en A3. Et reste sobre.");
    expect(e[0]!.attestation).toMatchObject({ agent: "Xavier", role: "gardien", nature: "mesure", recu: "preuves/1.json", non_verifiee: false, portee: "les 28 jours, tous les postes" });
    expect(e[0]!.recu).toMatchObject({ n: 1, passe: true, perime: false, date: "2026-09-28T10:58:00.000Z" });
    expect(e[1]!.recu).toMatchObject({ n: 2, passe: true, perime: true });
    expect(e[1]!.changes).toEqual(["produit index.html"]);
    expect(e[2]!.attestation).toMatchObject({ agent: "Xavier", non_verifiee: true, recu: null, portee: "aucune commande ne le mesure" });
    expect(e[2]!.recu).toBeNull();
    expect(e[3]!.attestation).toBeNull();
    expect(e[3]!.dernier_recu).toMatchObject({ n: 3, passe: false });
    expect(e[0]!.dernier_recu).toMatchObject({ n: 1, passe: true });
    expect(e[4]!.dernier_recu).toBeNull();
  });

  test("/exigences : alertes ouvertes qui citent l'exigence, contestations ouvertes, appréciations à part", async () => {
    const c = (await api("/api/runs/run-preuves/exigences")).corps;
    const e = c.exigences as Array<Record<string, any>>;
    expect(e[4]!.alertes_ouvertes).toEqual([{ id: 1, titre: "E5 : l'impression coupe la semaine 4" }]);
    expect(e.filter((x) => x.alertes_ouvertes.length).map((x) => x.libelle)).toEqual(["E5"]); // « E5 » ne cite pas E1 ni E4
    expect(e[1]!.contestations).toEqual([{ ticket: 2, exigence: "E2", phrases: [2], par: "Xavier", raison: "c'est une transversale" }]);
    expect(c.contestations.map((x: { ticket: number; exigence: string | null; phrases: number[] }) => [x.ticket, x.exigence, x.phrases])).toEqual([[2, "E2", [2]], [3, null, [6]]]);
    expect(e[0]!.appreciations).toEqual([{ id: 1, agent: "Xavier", role: "gardien", texte: "lisible", portee: "vue d'ensemble" }]);
    expect(e[0]!.etat).toBe("attestee"); // une appréciation ne change rien à l'état
  });

  test("/exigences : une alerte liée par tickets.exigence ne vaut que pour son exigence, même si son texte en cite une autre", async () => {
    construirePreuves("run-preuves-lien");
    const t = ouvrirBun(join(racine, "runs", "run-preuves-lien", "tableau.sqlite"));
    T.ouvrirTicket(t, { type: "bug", titre: "l'effectif manque, vu en vérifiant E4", description: "le 14/11", auteur: "Xavier", charge: "Denis", sorte: "alerte", reproduction: repro, exigence: "E1" });
    t.fermer();
    const e = (await api("/api/runs/run-preuves-lien/exigences")).corps.exigences as Array<Record<string, any>>;
    expect(e.filter((x) => x.alertes_ouvertes.length).map((x) => [x.libelle, x.alertes_ouvertes.map((k: { id: number }) => k.id)])).toEqual([["E1", [4]], ["E5", [1]]]); // #1 sans lien : repli sur le texte
  });

  test("/exigences : les reçus du registre, leur objet, leur signataire, passe ou échoue, périmé", async () => {
    const recus = (await api("/api/runs/run-preuves/exigences")).corps.recus as Array<Record<string, any>>;
    expect(recus.map((x) => [x.n, x.sorte, x.exigence, x.ticket, x.motif, x.demandeur, x.passe, x.perime])).toEqual([
      [1, "exigence", "E1", null, null, "Xavier", true, false], [2, "exigence", "E2", null, null, "Xavier", true, true],
      [3, "exigence", "E4", null, null, "Valentin", false, false], [4, "alerte", null, 1, "corrige", "Denis", false, false]]);
    expect(recus[0]!.signe_par).toEqual([{ agent: "Xavier", role: "gardien", exigence: "E1", nature: "mesure" }]);
    expect(recus[2]!.signe_par).toEqual([]);
    expect(recus[1]!.changes).toEqual(["produit index.html"]);
  });

  test("/exigences : toutes les attestations, pour la fiche d'un agent", async () => {
    const a = (await api("/api/runs/run-preuves/exigences")).corps.attestations as Array<Record<string, any>>;
    expect(a.map((x) => [x.exigence, x.agent, x.recu, x.non_verifiee, x.revoquee])).toEqual([
      ["E1", "Xavier", "preuves/1.json", false, false], ["E2", "Xavier", "preuves/2.json", false, false], ["E3", "Xavier", null, true, false]]);
  });

  test("le rejeu d'une alerte porte son résultat : échoue, sur le reçu 4", async () => {
    const k = (await api("/api/runs/run-preuves/fils")).corps.tickets.find((x: { id: number }) => x.id === 1);
    expect(k.rejeu).toMatchObject({ etat: "faite", recu: "preuves/4.json", resultat: { passe: false, code: 1 } });
    const d = (await api("/api/runs/run-preuves/depot")).corps.tickets.find((x: { id: number }) => x.id === 1);
    expect(d.rejeu.resultat).toMatchObject({ passe: false });
  });

  test("lecture seule : ni la base ni les reçus ne changent", async () => {
    const base = join(racine, "runs", "run-preuves", "tableau.sqlite");
    const avant = [statSync(base).mtimeMs, statSync(join(racine, "runs", "run-preuves", "preuves", "1.json")).mtimeMs];
    await api("/api/runs/run-preuves/exigences");
    expect([statSync(base).mtimeMs, statSync(join(racine, "runs", "run-preuves", "preuves", "1.json")).mtimeMs]).toEqual(avant);
  });

  test("un run d'avant les exigences, un run sans rôles, un run d'avant les rôles : listes vides, sans erreur", async () => {
    const vide = { exigences: [], recus: [], contestations: [], attestations: [] };
    expect((await api("/api/runs/run-preuves-avant/exigences")).corps).toEqual(vide);
    expect((await api("/api/runs/run-a/exigences")).corps).toEqual(vide);
    expect((await api("/api/runs/run-roles-avant/exigences")).corps).toEqual(vide);
    expect((await api("/api/runs/inconnu/exigences")).statut).toBe(404);
  });

  test("la vue : l'encart Exigences, les reçus de preuve, le résultat du rejeu, les preuves signées", async () => {
    const page = await (await fetch(serveur.url + "/")).text();
    for (const texte of ["titre-exigences", "prouvée", "à reprouver", "non vérifiée", "à prouver", "non satisfaite", "Reçus de preuve", "titre-recus-preuve", "Preuves signées", "/exigences"])
      expect(page).toContain(texte);
  });
});

describe("la fin du run, les passations et les leçons dans la vue (R8, R9, D7, phase 7 partie 3)", () => {
  const repro: T.Reproduction = { commande: "bun verifier.ts", graine: "7", commit: "abc1234", banc: {}, monde: {} };
  // Un run à rôles fini incomplet : Lucien perdu sans successeur (son ticket rendu au chef), Bernard qui passe le siège
  // d'intégrateur à Achille avec sa note, Valentin perdu et relevé par Basile sans note ni état livré ; deux leçons, deux
  // réveils de la salle endormie, puis le constat du lanceur et le bilan.
  function construireFin(nom: string, o: { accepte?: boolean } = {}) {
    const dossier = join(racine, "runs", nom);
    mkdirSync(dossier, { recursive: true });
    const t = ouvrirBun(join(dossier, "tableau.sqlite"));
    T.initialiser(t);
    T.ouvrirRun(t, { id: nom, missionChemin: "missions/hopital.md", missionTexte: "# Hôpital\n\n## Type\nprobleme", modele: "faux/faux", plafondUsd: 1, silenceMin: 15 });
    for (const [n, role] of [["Antoine", "chef"], ["Bernard", "integrateur"], ["Denis", "constructeur"], ["Lucien", "constructeur"], ["Valentin", "recette"], ["Xavier", "gardien"]] as const)
      T.ajouterAgent(t, n, join(dossier, "agents", n), "faux/faux", undefined, { role });
    T.ouvrirTicket(t, { type: "amelioration", titre: "Vérificateur", description: "indépendant", auteur: "Antoine", charge: "Lucien" });
    T.ouvrirTicket(t, { type: "amelioration", titre: "Assemblage", description: "main", auteur: "Antoine", charge: "Bernard" });
    T.ouvrirTicket(t, { type: "amelioration", titre: "Solveur", description: "glouton", auteur: "Antoine", charge: "Lucien" });
    T.sortirAgent(t, "Lucien", "perdu", "passes épuisées");
    T.transfererTickets(t, "Lucien", "Antoine", "perdu : passes épuisées");
    T.noterPassation(t, "Bernard", "integrateur", "le contrat tient ; reste l'assemblage de #2");
    T.noterLecons(t, "Bernard", "integrateur", ["Poser le contrat avant la première part."]);
    T.sortirAgent(t, "Bernard", "fini", "passation du siège");
    T.ajouterAgent(t, "Achille", join(dossier, "agents", "Achille"), "faux/faux", undefined, { role: "integrateur", remplace: "Bernard" });
    T.succeder(t, "Bernard", "Achille", "siège repris par Achille");
    T.confirmerSuccession(t, "Achille");
    T.ajouterEvenement(t, { agent: "Achille", type: "succession", resultat: "état du siège livré, puis la note du sortant" });
    T.sortirAgent(t, "Valentin", "perdu", "le fournisseur ne répondait plus");
    T.ajouterAgent(t, "Basile", join(dossier, "agents", "Basile"), "faux/faux", undefined, { role: "recette", remplace: "Valentin" });
    T.succeder(t, "Valentin", "Basile", "siège repris par Basile");
    const alerte = T.ouvrirTicket(t, { type: "bug", titre: "Référent de nuit", description: "le 14/11", auteur: "Xavier", charge: "Denis", sorte: "alerte", reproduction: repro, exigence: "E1" });
    T.noterLecons(t, "Xavier", "gardien", ["Une compétence lue avec une espace en trop a fait mentir la page du jour."]);
    T.ajouterEvenement(t, { agent: "lanceur", type: "reveil_alerte", resultat: `salle endormie, alerte ouverte #${alerte} : Denis nommé` });
    T.ajouterEvenement(t, { agent: "lanceur", type: "reveil_alerte", resultat: `salle endormie, alertes ouvertes #${alerte}, #9 : Denis, Antoine nommés` });
    T.ajouterEvenement(t, { agent: "lanceur", type: "constat", resultat: o.accepte ? "run accepté : alertes fermées, exigences attestées, vérification passée" : "run incomplet : plafond atteint" });
    T.clore(t, { finis: 2, vires: 0, perdus: 2, etat: o.accepte ? "accepte" : "incomplet", raisonsEtat: ["plafond atteint", "une alerte ouverte : #4"], reveils: { Denis: 2 },
      exigencesNonSatisfaites: [{ libelle: "E1", etat: "à prouver", responsable: "gardien", alertes: [alerte] }], alertesOuvertes: [{ ticket: alerte, titre: "Référent de nuit", charge: "Denis", exigence: "E1" }] });
    t.fermer();
  }
  beforeAll(() => {
    construireFin("run-fin");
    construireFin("run-fin-accepte", { accepte: true });
    construireFin("run-fin-avant"); // puis privé des tables et colonnes récentes : un ancien run
    const t = ouvrirBun(join(racine, "runs", "run-fin-avant", "tableau.sqlite"));
    for (const sql of ["DROP TABLE passations", "DROP TABLE lecons", "DROP TABLE ticket_notes", "ALTER TABLE agents DROP COLUMN remplace", "ALTER TABLE tickets DROP COLUMN exigence"]) t.exec(sql);
    t.fermer();
  });

  test("le compteur : l'état constaté par le lanceur, son heure, sa raison courte, et les réveils sur alerte", async () => {
    const f = (await api("/api/runs/run-fin")).corps.fin_run;
    expect(f).toMatchObject({ etat: "incomplet", raison: "plafond atteint" });
    expect(Date.parse(f.le)).toBeGreaterThan(0);
    expect(f.reveils_alerte.map((r: { alertes: string; noms: string[] }) => [r.alertes, r.noms])).toEqual([["#4", ["Denis"]], ["#4, #9", ["Denis", "Antoine"]]]);
    expect((await api("/api/runs/run-fin-accepte")).corps.fin_run).toMatchObject({ etat: "accepte", raison: "alertes fermées, exigences attestées, vérification passée" });
    expect((await api("/api/runs/run-fin")).corps.bilan).toMatchObject({ etat: "incomplet", reveils: { Denis: 2 } }); // le reste du constat : dans le bilan
  });

  test("/passations : le siège repris avec sa note et l'état livré, le siège relevé après une panne, sans note", async () => {
    const r = await api("/api/runs/run-fin/passations");
    expect(r.statut).toBe(200);
    const s = r.corps.sieges as Array<Record<string, any>>;
    expect(s.map((x) => [x.role, x.sortant, x.entrant, x.etat_sortant, x.motif, x.livre, x.tickets])).toEqual([
      ["integrateur", "Bernard", "Achille", "fini", "passation du siège", true, [2]], ["recette", "Valentin", "Basile", "perdu", "le fournisseur ne répondait plus", false, []]]);
    expect(s[0]!.note).toMatchObject({ texte: "le contrat tient ; reste l'assemblage de #2" });
    expect(s[1]!.note).toBeNull();
    expect(Date.parse(s[0]!.le)).toBeGreaterThan(0);
  });

  test("/passations : les tickets d'un agent sorti sans successeur, rendus au chef en une relève ; les leçons dans l'ordre", async () => {
    const c = (await api("/api/runs/run-fin/passations")).corps;
    expect(c.releves.map((x: Record<string, unknown>) => [x.de, x.vers, x.raison, x.tickets])).toEqual([["Lucien", "Antoine", "perdu : passes épuisées", [1, 3]]]);
    expect(c.lecons.map((l: Record<string, unknown>) => [l.agent, l.role, l.texte])).toEqual([
      ["Bernard", "integrateur", "Poser le contrat avant la première part."], ["Xavier", "gardien", "Une compétence lue avec une espace en trop a fait mentir la page du jour."]]);
  });

  test("un run sans rôles, un run d'avant ces tables et colonnes : rien à montrer, sans erreur ni migration", async () => {
    expect((await api("/api/runs/run-a")).corps.fin_run).toBeNull();
    expect((await api("/api/runs/run-b")).corps.fin_run).toBeNull();
    const vide = { sieges: [], releves: [], lecons: [] };
    expect((await api("/api/runs/run-a/passations")).corps).toEqual(vide);
    expect((await api("/api/runs/run-roles-avant/passations")).corps).toMatchObject({ sieges: [], lecons: [] });
    expect((await api("/api/runs/run-fin-avant/passations")).corps).toEqual(vide);
    expect((await api("/api/runs/run-fin-avant")).corps.fin_run).toMatchObject({ etat: "incomplet" });
    expect((await api("/api/runs/inconnu/passations")).statut).toBe(404);
    const t = ouvrirBun(join(racine, "runs", "run-fin-avant", "tableau.sqlite"), { lectureSeule: true });
    expect(T.aTable(t, "passations")).toBe(false);
    t.fermer();
  });

  test("la vue : l'état du run dans l'en-tête, le constat de fin, les passations et les leçons dans Mémoire", async () => {
    const page = await (await fetch(serveur.url + "/")).text();
    for (const texte of ['class="etat-run"', "etat-fin", "fin_run", "fin du run", "exigences non satisfaites", "alertes ouvertes", "réveils", "reçus de preuve",
      "titre-passations", "Passations", "quand un siège change de mains", "Relève après une panne", "titre-lecons", "Leçons du run", "archivées, jamais réactivées seules", "/passations"])
      expect(page).toContain(texte);
    expect(page).toMatch(/etatRun\(\) \{ return this\.avecRoles && this\.compteur\.etat !== "en_cours"/); // rien sans rôles, rien en cours
  });

  test("la vue : un siège unique s'affiche sous le nom de son rôle, son prénom en petit, par une seule règle (nomAffiche)", async () => {
    const page = await (await fetch(serveur.url + "/")).text();
    expect(page).toContain('const SIEGES_UNIQUES = ["chef", "integrateur", "assembleur", "recette", "gardien", "surveillant"];');
    expect(page).toContain('.component("nom-agent", NomAgent)');
    expect(page.match(/^\s*nomAffiche\(nom\) \{/gm)).toHaveLength(1);
    for (const brut of ["{{ m.auteur }}", "{{ e.auteur }}", "{{ l.agent }}", "{{ k.charge }}", "{{ a.nom }}</b>", "{{ neurone.nom }}", ':title="n"'])
      expect(page).not.toContain(brut); // plus aucun prénom affiché hors de la règle
    const module = await (await fetch(serveur.url + "/cerveau.js")).text();
    expect(module).toContain("o.libelles[a.nom] ?? a.nom"); // le cerveau : seulement le texte de l'étiquette
  });

  test("lecture seule : la base n'est pas écrite", async () => {
    const base = join(racine, "runs", "run-fin", "tableau.sqlite");
    const avant = statSync(base).mtimeMs;
    await api("/api/runs/run-fin/passations");
    await api("/api/runs/run-fin");
    expect(statSync(base).mtimeMs).toBe(avant);
  });
});
