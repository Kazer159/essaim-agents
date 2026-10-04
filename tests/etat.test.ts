// Second cerveau : « écrit depuis », l'état de la salle livré à chaque relance et la ligne
// courte. Tableaux fabriqués et vrais fichiers pour « écrit depuis » ; faux ExtensionAPI enchaîné pour input et
// tool_result ; lanceur au faux pi pour les relances et la confirmation.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { formaterBilan, lancer, type Options } from "../src/lancer.ts";
import * as M from "../src/memoire.ts";
import extension from "../src/outils-essaim.ts";
import seResumer from "../src/se-resumer.ts";
import { ouvrirBun } from "../src/tableau-bun.ts";
import * as T from "../src/tableau.ts";
import { fauxPi } from "./aide/faux-extension-api.ts";
import { motsInterdits } from "./aide/mots-interdits.ts";

let dossier: string;
let partage: string;
let chemin: string;
let t: T.Tableau;

beforeEach(() => {
  dossier = mkdtempSync(join(tmpdir(), "essaim-etat-"));
  partage = join(dossier, "partage");
  chemin = join(dossier, "tableau.sqlite");
  mkdirSync(partage);
  t = ouvrirBun(chemin);
  T.initialiser(t);
  T.ouvrirRun(t, { id: "run-test", missionChemin: "m.md", missionTexte: "texte", modele: "faux/faux", plafondUsd: 0.5, silenceMin: 15 });
  for (const a of ["Antoine", "Bernard", "Claude"]) { mkdirSync(join(dossier, "agents", a), { recursive: true }); T.ajouterAgent(t, a, join(dossier, "agents", a)); }
});
afterEach(() => { t.fermer(); rmSync(dossier, { recursive: true, force: true }); });

const ecrire = (fichiers: Record<string, string>, racine = partage) => {
  for (const [f, c] of Object.entries(fichiers)) { mkdirSync(join(racine, f, ".."), { recursive: true }); writeFileSync(join(racine, f), c); }
};
const blob = (c: string) => M.blobGit(new TextEncoder().encode(c));
const noter = (f: T.NouveauFait) => t.transaction(() => T.noterFait(t, f));
const hm = (iso: string) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
const maxFait = () => t.get<{ n: number }>("SELECT COALESCE(MAX(id), 0) AS n FROM faits")!.n;
const fait = (id: number) => M.lireFait(t, id)!;
const racines = (): M.Racines => M.racinesDe(t, partage);
// Une vérification : apres restreint aux fichiers contrôlés, fichiers, racine.
const verif = (agent: string, source: string, o: { fichiers?: string[]; racine?: string; dir?: string; statut?: T.StatutVerification; sujet?: string } = {}) => {
  const apres = M.empreintes(o.dir ?? partage, o.fichiers);
  const fichiers = o.fichiers ?? [...apres.keys()].sort();
  return noter({ type: "verification", agent, source, sujet: o.sujet ?? fichiers[0] ?? "tests (tout le dossier)", statut: o.statut ?? "verifie",
    texte: `${o.statut === "echoue" ? "échoué" : "vérifié"} · ${source} ${o.sujet ?? fichiers[0]} · ${agent}`,
    details: { apres: Object.fromEntries(apres), fichiers, racine: o.racine ?? "partage" } });
};
// Un fait ecriture : blobs des contenus donnés (null : supprimé).
const commit = (agent: string, fichiers: Record<string, string | null>, o: { hash?: string; outil?: string; racine?: string; type?: T.TypeFait } = {}) => {
  const hash = o.hash ?? "3f2a1bc";
  const liste = Object.keys(fichiers).join(", ");
  return noter({ type: o.type ?? "ecriture", agent, source: "lanceur", sujet: liste,
    texte: `écrit · ${liste} · ${agent} · commit ${hash}${o.outil === "bash" ? " · par bash, attribué au mieux" : ""}`,
    details: { hash, message: `write ${liste}`, fichiers: Object.entries(fichiers).map(([c, v]) => ({ chemin: c, blob: v === null ? null : blob(v) })), racine: o.racine ?? "partage", outil: o.outil ?? "write" } });
};
const RELU = new Date(2026, 8, 27, 21, 40, 31);

describe("« rien écrit depuis » et « écrit depuis par X » (M7, R4, R6)", () => {
  const depuis = (id: number, cache: M.Cache = new Map()) => M.ecritDepuis(t, fait(id), racines(), cache, maxFait(), RELU);

  test("rien écrit : le disque relu égale l'empreinte d'après, l'heure de la relecture est dite", () => {
    ecrire({ "index.html": "<p>1</p>", "app.js": "v1" });
    const v = verif("Bernard", "page_voir", { fichiers: ["index.html", "app.js"] });
    const r = depuis(v);
    expect(r).toMatchObject({ rien: true, relu: "21:40:31", texte: "rien écrit depuis (relu à 21:40:31)" });
    expect(Object.keys((r as { empreintes: object }).empreintes).sort()).toEqual(["app.js", "index.html"]);
  });

  test("écrit depuis par Antoine : le blob du disque est celui d'un fait ecriture postérieur ; « attribué au mieux » pour bash", () => {
    ecrire({ "index.html": "<p>1</p>", "app.js": "v1" });
    const v = verif("Bernard", "page_voir", { fichiers: ["index.html", "app.js"] });
    ecrire({ "app.js": "v2" });
    const c = commit("Antoine", { "app.js": "v2" });
    expect(depuis(v)).toEqual({ rien: false, texte: `écrit depuis par Antoine (app.js, commit 3f2a1bc, ${hm(fait(c).cree_le)})` });
    ecrire({ "index.html": "<p>2</p>" });
    const b = commit("Claude", { "index.html": "<p>2</p>" }, { outil: "bash", hash: "9c1e2aa" });
    expect(depuis(v)).toEqual({ rien: false, texte: `écrit depuis par Claude (index.html, commit 9c1e2aa, ${hm(fait(b).cree_le)}, attribué au mieux) ; par Antoine (app.js, commit 3f2a1bc, ${hm(fait(c).cree_le)})` });
  });

  test("une restauration et une adoption comptent comme des écritures", () => {
    ecrire({ "app.js": "v1", "style.css": "s1" });
    const v = verif("Bernard", "page_voir", { fichiers: ["app.js", "style.css"] });
    ecrire({ "app.js": "v0", "style.css": "s2" });
    const r = commit("Antoine", { "app.js": "v0" }, { type: "restauration", hash: "5e6f7a8" });
    const a = commit("Claude", { "style.css": "s2" }, { type: "essai", hash: "7d0e44f" });
    expect(depuis(v)).toEqual({ rien: false, texte: `écrit depuis par Claude (style.css, commit 7d0e44f, ${hm(fait(a).cree_le)}) ; par Antoine (app.js, commit 5e6f7a8, ${hm(fait(r).cree_le)})` });
  });

  test("disque changé sans commit : auteur pas encore connu", () => {
    ecrire({ "app.js": "v1" });
    const v = verif("Bernard", "page_voir", { fichiers: ["app.js"] });
    ecrire({ "app.js": "v2" });
    expect(depuis(v)).toEqual({ rien: false, texte: "écrit depuis (app.js), auteur pas encore connu" });
  });

  test("pour les tests, le dossier est ré-énuméré : un fichier créé ou supprimé depuis compte", () => {
    ecrire({ "app.js": "v1", "a.test.js": "t1" });
    const v = verif("Bernard", "code_tester", { sujet: "tests (tout le dossier)" });
    ecrire({ "b.test.js": "t2" });
    unlinkSync(join(partage, "app.js"));
    expect(depuis(v)).toEqual({ rien: false, texte: "écrit depuis (app.js (supprimé), b.test.js), auteur pas encore connu" });
    const c = commit("Antoine", { "app.js": null }, { hash: "1a2b3c4" });
    expect(depuis(v)).toEqual({ rien: false, texte: `écrit depuis par Antoine (app.js (supprimé), commit 1a2b3c4, ${hm(fait(c).cree_le)}) ; b.test.js, auteur pas encore connu` });
  });

  test("un contenu écrit avant le contrôle et commité après : ni « écrit depuis » ni « touche le contenu vérifié »", () => {
    ecrire({ "app.js": "v2" });
    const v = verif("Bernard", "page_voir", { fichiers: ["app.js"] });
    const c = commit("Antoine", { "app.js": "v2" });
    expect(depuis(v)).toMatchObject({ rien: true });
    expect(M.toucheVerifie(t, fait(c), maxFait())).toBeUndefined();
  });

  test("un commit d'un contenu ancien alors que le disque a déjà changé : auteur pas encore connu, pas l'auteur du commit", () => {
    ecrire({ "app.js": "v1" });
    const v = verif("Bernard", "page_voir", { fichiers: ["app.js"] });
    ecrire({ "app.js": "v3" }); // Claude a déjà réécrit ; le commit de la v2 d'Antoine arrive ensuite
    commit("Antoine", { "app.js": "v2" });
    expect(depuis(v)).toEqual({ rien: false, texte: "écrit depuis (app.js), auteur pas encore connu" });
  });

  test("réécrit avec le même contenu (une annulation O1) : pas d'« auteur pas encore connu » pour toujours (29/09, revue M2)", () => {
    ecrire({ "app.js": "v1" });
    const v = verif("Bernard", "page_voir", { fichiers: ["app.js"] });
    utimesSync(join(partage, "app.js"), new Date(Date.now() + 5000), new Date(Date.now() + 5000)); // même octets, autre date
    const r = depuis(v);
    expect(r?.texte).not.toContain("auteur pas encore connu");
    expect(r).toMatchObject({ rien: true });
  });
  test("jamais d'attribution par un fait d'une autre racine, ni au-delà de la borne jusquA", () => {
    const essai = join(dossier, "essais", "menu-2");
    ecrire({ "app.js": "v1" });
    const v = verif("Bernard", "page_voir", { fichiers: ["app.js"] });
    ecrire({ "app.js": "v2" });
    commit("Antoine", { "app.js": "v2" }, { racine: "essai:menu-2" });
    expect(depuis(v)).toEqual({ rien: false, texte: "écrit depuis (app.js), auteur pas encore connu" });
    const borne = maxFait();
    commit("Antoine", { "app.js": "v2" });
    expect(M.ecritDepuis(t, fait(v), racines(), new Map(), borne, RELU)).toEqual({ rien: false, texte: "écrit depuis (app.js), auteur pas encore connu" });
    // Une vérification dans un essai relit le dossier de l'essai.
    T.noterEssai(t, "menu-2", "Claude", "", essai);
    ecrire({ "app.js": "e1" }, essai);
    const ve = verif("Claude", "page_voir", { fichiers: ["app.js"], racine: "essai:menu-2", dir: essai });
    expect(depuis(ve)).toMatchObject({ rien: true });
  });

  test("touche le contenu vérifié : seulement si un blob diffère du blob d'après de la dernière vérification qui couvre le fichier", () => {
    ecrire({ "app.js": "v1", "index.html": "<p>1</p>" });
    const v = verif("Bernard", "page_voir", { fichiers: ["index.html", "app.js"] });
    const c = commit("Antoine", { "app.js": "v2" });
    expect(M.toucheVerifie(t, fait(c), maxFait())).toBe(`touche le contenu vérifié par Bernard à ${hm(fait(v).cree_le)}`);
    const autre = commit("Antoine", { "autre.js": "x" }); // hors du contenu d'une page vérifiée
    expect(M.toucheVerifie(t, fait(autre), maxFait())).toBeUndefined();
    // Pour des tests, tout le dossier est le contenu : un fichier créé le touche.
    ecrire({ "app.js": "v2" });
    const vt = verif("Claude", "code_tester", { sujet: "tests (tout le dossier)" });
    const nouveau = commit("Antoine", { "b.test.js": "t" });
    expect(M.toucheVerifie(t, fait(nouveau), maxFait())).toBe(`touche le contenu vérifié par Claude à ${hm(fait(vt).cree_le)}`);
    // Une vérification échouée n'est pas un contenu vérifié.
    verif("Bernard", "page_voir", { fichiers: ["index.html"], statut: "echoue" });
    expect(M.toucheVerifie(t, fait(commit("Antoine", { "index.html": "<p>2</p>" })), maxFait())).toBeUndefined();
  });
});

describe("l'état de la salle : contenu, format, taille (§5.2, §5.3, M8)", () => {
  const etat = (agent = "Antoine", o: { cache?: M.Cache; tableau?: T.Tableau } = {}) =>
    M.etatDeLaSalle(o.tableau ?? t, agent, racines(), { cache: o.cache ?? new Map(), maintenant: RELU });
  const debutRun = () => { const d = new Date(t.get<{ debut: string }>("SELECT debut FROM run")!.debut); return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":"); };
  const sansCitations = (s: string) => s.replace(/«[^»]*»/g, "«»");

  test("format exact : en-tête, un fait par ligne du plus récent au plus ancien, ses propres faits compris, non lus par fil", () => {
    T.reclamer(t, "Antoine", "app.js", "le menu");
    ecrire({ "app.js": "v1" });
    const v = verif("Bernard", "page_voir", { fichiers: ["app.js"] });
    ecrire({ "app.js": "v2" });
    const c = commit("Claude", { "app.js": "v2" });
    T.poster(t, "Antoine", "le mien ne compte pas");
    T.poster(t, "Bernard", "salut");
    T.poster(t, "Claude", "horaires", "q-horaires");
    const l = etat()!;
    const p = t.get<{ id: number }>("SELECT id FROM faits WHERE type = 'pancarte'")!.id;
    expect(l.texte).toBe([
      `[salle] Changements depuis le début du run (${debutRun()}) jusqu'à 21:40:31, messages jusqu'au n° 3 :`,
      `${hm(fait(c).cree_le)} écrit · app.js · Claude · commit 3f2a1bc · touche le contenu vérifié par Bernard à ${hm(fait(v).cree_le)}`,
      `${hm(fait(v).cree_le)} vérifié · page_voir app.js · Bernard · écrit depuis par Claude (app.js, commit 3f2a1bc, ${hm(fait(c).cree_le)})`,
      `${hm(fait(p).cree_le)} pancarte · app.js · Antoine · « le menu »`,
      "non lus : 2 messages (principal 1, q-horaires 1), à partir du n° 2",
    ].join("\n"));
    expect(l).toMatchObject({ deFait: 0, aFait: c, aMessage: 3, lignes: 3, retires: 0, caracteres: l.texte.length, rienEcrit: [], messagesLivres: [] });
    expect(motsInterdits(sansCitations(l.texte))).toEqual([]);
  });

  test("« rien écrit depuis » : la vérification et ses empreintes relues sont gardées pour la livraison (K6, vue)", () => {
    ecrire({ "index.html": "<p>1</p>" });
    const v = verif("Bernard", "page_voir", { fichiers: ["index.html"] });
    const l = etat()!;
    expect(l.texte.split("\n")[1]).toBe(`${hm(fait(v).cree_le)} vérifié · page_voir index.html · Bernard · rien écrit depuis (relu à 21:40:31)`);
    expect(l.rienEcrit).toEqual([{ fait: v, relu: "21:40:31", empreintes: { "index.html": expect.objectContaining({ blob: blob("<p>1</p>") }) } }]);
  });

  test("30 lignes au plus : les plus anciennes retirées et comptées ; aucun état quand rien n'a changé et rien n'est non lu", () => {
    expect(etat()).toBeUndefined();
    for (let i = 0; i < 31; i++) noter({ type: "agent", agent: "Claude", source: "tableau", texte: `Claude · en veille ${i}` });
    const l = etat()!;
    const lignes = l.texte.split("\n");
    expect(lignes.length).toBe(32);
    expect(lignes[1]).toEndWith("Claude · en veille 30");
    expect(lignes[30]).toEndWith("Claude · en veille 1");
    expect(lignes[31]).toBe('+ 1 fait plus ancien : salle_chercher(type: "fait") les rend');
    expect(l).toMatchObject({ lignes: 30, retires: 1, aFait: 31 });
    noter({ type: "agent", agent: "Claude", source: "tableau", texte: "Claude · en veille 31" });
    expect(etat()!.texte.split("\n").at(-1)).toBe('+ 2 faits plus anciens : salle_chercher(type: "fait") les rend');
    expect(etat()!.texte).not.toContain("non lus");
    // Depuis la dernière lecture : curseur et livraison confirmée posés (la confirmation est testée à part).
    t.run("INSERT INTO memoire_curseurs(agent, etat_fait_id) VALUES ('Antoine', 32)");
    t.run("INSERT INTO memoire_livraisons(agent, livre_le, moment, de_fait, a_fait, lignes, retires, caracteres, texte, confirme_le) VALUES ('Antoine', ?, 'reveil', 0, 32, 30, 2, 1, 'x', ?)",
      [new Date(2026, 8, 27, 21, 12, 4).toISOString(), new Date().toISOString()]);
    expect(etat()).toBeUndefined();
    noter({ type: "agent", agent: "Claude", source: "tableau", texte: "Claude · réveillé" });
    expect(etat()!.texte.split("\n")[0]).toBe("[salle] Changements depuis ta dernière lecture (21:12:04) jusqu'à 21:40:31, messages jusqu'au n° 0 :");
    expect(etat()!.texte.split("\n").length).toBe(2);
    T.poster(t, "Bernard", "salut");
    t.run("INSERT INTO memoire_curseurs(agent, etat_fait_id) VALUES ('Antoine', 33) ON CONFLICT(agent) DO UPDATE SET etat_fait_id = 33");
    expect(etat()!.texte.split("\n").slice(1)).toEqual(["non lus : 1 message (principal 1), à partir du n° 1"]);
  });

  test("200 caractères au plus hors citation ; une citation garde sa règle des 300 caractères", () => {
    noter({ type: "agent", agent: "Claude", source: "tableau", texte: "x".repeat(250) });
    const citation = "c".repeat(290);
    noter({ type: "agent", agent: "Claude", source: "tableau", texte: `Claude · fini · raison déclarée par Claude : « ${citation} » · ${"y".repeat(200)}` });
    const [, longue, courte] = etat()!.texte.split("\n");
    expect(courte).toBe(`${hm(fait(1).cree_le)} ${"x".repeat(194)}…`);
    expect(longue).toContain(`« ${citation} »`);
    expect([...sansCitations(longue!)].length).toBe(201 + 2); // 200 hors citation, l'ellipse, et les deux guillemets gardés
  });

  test("messagesLivres : les annonces de fil citées en entier, jamais une annonce de ticket ni une citation coupée (P5, R10)", () => {
    T.poster(t, "Bernard", "je commence");
    T.entrer(t, "Bernard", "q-horaires", "vérifier les horaires");
    const annonce = t.get<{ id: number }>("SELECT id FROM messages WHERE auteur = 'salle'")!.id;
    T.poster(t, "Claude", "moi aussi");
    T.entrer(t, "Claude", "q-long", "p".repeat(301));
    T.ouvrirTicket(t, { type: "bug", titre: "menu cassé", description: "d", auteur: "Bernard", annonce: (id) => `ticket #${id} ouvert` });
    const l = etat()!;
    expect(l.messagesLivres).toEqual([annonce]);
    expect(T.annoncesCiteesEntieres(t, l.deFait, l.aFait, l.lignes)).toEqual([annonce]);
    expect(l.texte).toContain(`q-horaires ouvert · pourquoi déclaré par Bernard, msg ${annonce} : « vérifier les horaires »`);
    // Les non lus ne comptent pas l'annonce livrée entière par l'état.
    expect(l.texte).toContain("non lus : 4 messages (principal 3, tickets 1)");
  });

  test("lecture bornée : aucune transaction, un écrivain qui tient le verrou ne la bloque pas, un fait écrit pendant les empreintes n'y entre pas", () => {
    ecrire({ "index.html": "<p>1</p>" });
    verif("Bernard", "page_voir", { fichiers: ["index.html"] });
    let transactions = 0;
    const espion: T.Tableau = { exec: (s) => t.exec(s), run: (s, p) => t.run(s, p), get: (s, p) => t.get(s, p), all: (s, p) => t.all(s, p),
      transaction: (fn) => { transactions++; return t.transaction(fn); }, fermer: () => {} };
    const autre = ouvrirBun(chemin);
    autre.exec("BEGIN IMMEDIATE"); // un reclamer d'un autre agent tient le verrou d'écriture
    autre.run("INSERT INTO faits(cree_le, type, agent, source, texte) VALUES (?, 'pancarte', 'Claude', 'tableau', 'pancarte · x.js · Claude')", [new Date().toISOString()]);
    const l1 = etat("Antoine", { tableau: espion })!;
    autre.exec("COMMIT");
    expect(l1.texte).not.toContain("x.js");
    // Pendant les empreintes (le cache est lu à chaque fichier), un autre écrit un fait : il arrive au suivant.
    const cache: M.Cache = new Map();
    let ecrit = false;
    const cacheEspion = new Proxy(cache, { get(c, k) {
      if (k === "get" && !ecrit) { ecrit = true; T.reclamer(autre, "Claude", "y.js", "après la borne"); }
      const v = Reflect.get(c, k); return typeof v === "function" ? v.bind(c) : v;
    } });
    const l2 = etat("Antoine", { tableau: espion, cache: cacheEspion })!;
    expect(ecrit).toBe(true);
    expect(l2.texte).not.toContain("y.js");
    expect(l2.aFait).toBe(2);
    expect(transactions).toBe(0);
    t.run("INSERT INTO memoire_curseurs(agent, etat_fait_id) VALUES ('Antoine', 2)");
    expect(etat()!.texte).toContain("pancarte · y.js · Claude");
    autre.fermer();
  });
});

describe("la livraison : préparée par l'extension, confirmée par le lanceur (§5.4, R8, R9, E3)", () => {
  const etat = (agent = "Antoine") => M.etatDeLaSalle(t, agent, racines(), { cache: new Map(), maintenant: RELU });
  const curseurs = (agent = "Antoine") => t.get<{ etat_fait_id: number; ligne_fait_id: number }>("SELECT etat_fait_id, ligne_fait_id FROM memoire_curseurs WHERE agent = ?", [agent]);
  const livraisons = () => t.all<Record<string, unknown>>("SELECT * FROM memoire_livraisons ORDER BY id");
  const appelsLivres = () => t.all<{ message_id: number }>("SELECT message_id FROM appels_livres WHERE agent = 'Antoine' ORDER BY message_id").map((r) => r.message_id);
  const message = (texte: string) => `Tu étais en veille.\n\n${texte}`;

  test("preparerLivraison : une ligne non confirmée, texte exact, aucun curseur touché", () => {
    T.reclamer(t, "Claude", "app.js", "");
    const l = etat()!;
    const id = T.preparerLivraison(t, "Antoine", "reveil", l);
    expect(id).toBe(1);
    expect(livraisons()).toEqual([expect.objectContaining({ agent: "Antoine", moment: "reveil", de_fait: 0, a_fait: 1, a_message: 0, lignes: 1, retires: 0,
      caracteres: l.caracteres, texte: l.texte, confirme_le: null, rien_ecrit_json: "[]" })]);
    expect(curseurs()).toBeUndefined();
  });

  test("confirmerLivraison : confirme_le, curseurs portés à a_fait, annonces citées entières notées livrées ; deux fois, même résultat", () => {
    T.poster(t, "Bernard", "je commence");
    T.entrer(t, "Bernard", "q-horaires", "vérifier les horaires");
    const l = etat()!;
    T.preparerLivraison(t, "Antoine", "resume", l);
    expect(T.confirmerLivraison(t, "Antoine", "un autre texte")).toBe(false);
    expect(livraisons()[0]!.confirme_le).toBeNull();
    expect(T.confirmerLivraison(t, "Antoine", message(l.texte))).toBe(true);
    const apres = { l: livraisons(), c: curseurs(), a: appelsLivres() };
    expect(apres.l[0]!.confirme_le).toEqual(expect.any(String));
    expect(apres.c).toEqual({ etat_fait_id: l.aFait, ligne_fait_id: l.aFait });
    expect(apres.a).toEqual(l.messagesLivres);
    expect(T.confirmerLivraison(t, "Antoine", message(l.texte))).toBe(true);
    expect({ l: livraisons(), c: curseurs(), a: appelsLivres() }).toEqual(apres);
  });

  test("deux états confirmés de suite ne répètent aucun fait ; un état préparé jamais confirmé est reconstruit depuis les mêmes curseurs", () => {
    T.reclamer(t, "Claude", "app.js", "le menu");
    const l1 = etat()!;
    T.preparerLivraison(t, "Antoine", "continue", l1); // pi meurt avant son message utilisateur : jamais confirmée
    const l1bis = etat()!;
    expect(l1bis.texte).toBe(l1.texte);
    T.preparerLivraison(t, "Antoine", "continue", l1bis);
    T.confirmerLivraison(t, "Antoine", message(l1bis.texte));
    expect(livraisons().map((x) => x.confirme_le === null)).toEqual([true, false]);
    expect(etat()).toBeUndefined();
    T.liberer(t, "Claude", "app.js");
    const l2 = etat()!;
    expect(l2.deFait).toBe(l1.aFait);
    expect(l2.texte.split("\n").slice(1).map((x) => x.slice(6))).toEqual(["pancarte retirée · app.js · Claude"]);
  });

  test("après confirmation, salle_lire ne relivre pas une annonce de fil citée entière ; une annonce de ticket et une citation coupée, si", () => {
    T.poster(t, "Bernard", "je commence");
    T.entrer(t, "Bernard", "q-horaires", "vérifier les horaires");
    T.poster(t, "Claude", "moi aussi");
    T.entrer(t, "Claude", "q-long", "p".repeat(301));
    T.ouvrirTicket(t, { type: "bug", titre: "menu cassé", description: "d", auteur: "Bernard", annonce: (id) => `ticket #${id} ouvert : menu cassé` });
    const l = etat()!;
    T.preparerLivraison(t, "Antoine", "reveil", l);
    T.confirmerLivraison(t, "Antoine", message(l.texte));
    const lus = T.boite(t, "Antoine").messages.map((m) => m.texte);
    expect(lus).not.toContain("Bernard ouvre q-horaires : vérifier les horaires");
    expect(lus).toContain(`Claude ouvre q-long : ${"p".repeat(301)}`);
    expect(lus).toContain("ticket #1 ouvert : menu cassé");
    expect(lus).toContain("je commence");
  });

  test("la ligne courte est notée confirmée à l'écriture : ligne_fait_id avance, etat_fait_id non", () => {
    T.preparerLivraison(t, "Antoine", "ligne", { texte: "[salle] depuis 21:30 : Edmond fini", deFait: 0, aFait: 7, aMessage: null, lignes: 1, retires: 0, caracteres: 34, rienEcrit: [], messagesLivres: [] });
    expect(livraisons()[0]).toMatchObject({ moment: "ligne", a_fait: 7, confirme_le: expect.any(String) });
    expect(curseurs()).toEqual({ etat_fait_id: 0, ligne_fait_id: 7 });
    // Une ligne n'est jamais prise pour un état à confirmer.
    expect(T.confirmerLivraison(t, "Antoine", "[salle] depuis 21:30 : Edmond fini")).toBe(false);
  });
});

// ---- Quand l'état est livré
// L'état livré, sans le rappel du but qui le suit (tests/rappel-but.test.ts) : seul l'état est noté livraison.
const sansBut = (s: string) => s.split(`\n\n${M.MARQUE_BUT}`)[0]!;
const ENV_EXTENSION = ["ESSAIM_AGENT", "ESSAIM_TABLEAU", "ESSAIM_PARTAGE", "ESSAIM_BUREAU", "ESSAIM_RELANCE", "ESSAIM_MEMOIRE", "ESSAIM_COMPACTAGE"];
const viderEnv = () => { for (const k of ENV_EXTENSION) delete process.env[k]; };
function instance(agent = "Antoine", env: Record<string, string> = {}) {
  viderEnv();
  Object.assign(process.env, { ESSAIM_AGENT: agent, ESSAIM_TABLEAU: chemin, ESSAIM_PARTAGE: partage, ESSAIM_BUREAU: join(dossier, "agents", agent) }, env);
  const faux = fauxPi();
  extension(faux.api, ouvrirBun);
  return faux;
}

describe("l'état construit par le gestionnaire input au premier message d'une relance (§5.1, R1)", () => {
  afterEach(viderEnv);
  const livraisons = () => t.all<{ agent: string; moment: string; texte: string; confirme_le: string | null }>("SELECT agent, moment, texte, confirme_le FROM memoire_livraisons ORDER BY id");

  test("relance : texte de relance intact, ligne vide, puis l'état ; livraison préparée, non confirmée ; un seul input par processus", async () => {
    T.reclamer(t, "Claude", "app.js", "le menu");
    const pi = instance("Antoine", { ESSAIM_RELANCE: "reveil" });
    const texte = await pi.saisir("Tu étais en veille.");
    expect(texte).toStartWith("Tu étais en veille.\n\n[salle] Changements depuis le début du run (");
    expect(texte).toEndWith(`pancarte · app.js · Claude · « le menu »\n\n${M.rappelDuBut(t, "Antoine")}`);
    expect(livraisons()).toEqual([{ agent: "Antoine", moment: "reveil", texte: sansBut(texte!.slice("Tu étais en veille.\n\n".length)), confirme_le: null }]);
    T.liberer(t, "Claude", "app.js");
    expect(await pi.saisir("continue")).toBe("continue");
    expect(livraisons().length).toBe(1);
    expect(pi.erreurs).toEqual([]);
  });

  test("premier lancement (sans ESSAIM_RELANCE), ou ESSAIM_MEMOIRE=non : le texte passe tel quel ; rien de changé : le rappel du but seul ; rien n'est préparé", async () => {
    T.reclamer(t, "Claude", "app.js", "le menu");
    expect(await instance("Antoine").saisir("la mission")).toBe("la mission");
    expect(await instance("Antoine", { ESSAIM_RELANCE: "continue", ESSAIM_MEMOIRE: "non" }).saisir("continue")).toBe("continue");
    t.run("INSERT INTO memoire_curseurs(agent, etat_fait_id) VALUES ('Antoine', 1)");
    expect(await instance("Antoine", { ESSAIM_RELANCE: "continue" }).saisir("continue")).toBe(`continue\n\n${M.rappelDuBut(t, "Antoine")}`);
    expect(livraisons()).toEqual([]);
  });

  test("faux pi : après /se-resumer et un compactage lent, un fait écrit pendant le compactage est dans l'état", async () => {
    writeFileSync(join(dossier, "fixture.jsonl"), '{"type":"agent_start"}\n{"type":"agent_end"}\n');
    const racineDepot = resolve(import.meta.dir, "..");
    const p = Bun.spawn(["bun", join(racineDepot, "tests", "faux-pi.ts"), "--mode", "json", "--session-id", "Antoine",
      "-e", join(racineDepot, "src", "outils-essaim.ts"), "-e", join(racineDepot, "src", "se-resumer.ts"), "--", "/se-resumer note", "REPRISE"], {
      cwd: join(dossier, "agents", "Antoine"), stdout: "pipe", stderr: "pipe",
      env: { ...process.env, ESSAIM_TEST: "1", ESSAIM_AGENT: "Antoine", ESSAIM_TABLEAU: chemin, ESSAIM_PARTAGE: partage, ESSAIM_BUREAU: join(dossier, "agents", "Antoine"),
        ESSAIM_RELANCE: "resume", ESSAIM_COMPACTAGE: "80000,120000,160000", ESSAIM_FAUX_COMPACTAGE_MS: "1500", ESSAIM_FIXTURE: join(dossier, "fixture.jsonl") },
    });
    const lecteur = p.stdout.getReader();
    let sortie = "";
    while (!sortie.includes("\n")) { const { value, done } = await lecteur.read(); if (done) break; sortie += new TextDecoder().decode(value); }
    expect(JSON.parse(sortie.split("\n")[0]!).type).toBe("session"); // l'en-tête : la commande commence juste après
    T.reclamer(t, "Claude", "pendant.js", "écrit pendant le compactage");
    for (;;) { const { value, done } = await lecteur.read(); if (done) break; sortie += new TextDecoder().decode(value); }
    expect(await new Response(p.stderr).text()).toBe("");
    expect(await p.exited).toBe(0);
    const user = sortie.trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.type === "message_end" && l.message.role === "user");
    expect(user.length).toBe(1);
    expect(user[0].message.content[0].text).toStartWith("REPRISE\n\n[salle] Changements depuis");
    expect(user[0].message.content[0].text).toContain("pancarte · pendant.js · Claude · « écrit pendant le compactage »");
    expect(livraisons()).toEqual([expect.objectContaining({ moment: "resume", confirme_le: null })]);
  });
});

describe("le lanceur : un état à chaque relance, confirmé au message utilisateur (§5.1, §5.4, S10, E3)", () => {
  const racineDepot = resolve(import.meta.dir, "..");
  const fixture = (nom: string) => join(racineDepot, "tests", "fixtures", `${nom}.jsonl`);
  const base = (): Options => ({ agents: 1, modele: "faux", plafond: 0.1, mission: join(racineDepot, "tests", "fixtures", "hello-world.md"), racine: dossier, sansBacASable: true });
  const ecrireFixture = (nom: string, lignes: object[]) => { const p = join(dossier, `${nom}.jsonl`); writeFileSync(p, lignes.map((l) => JSON.stringify(l)).join("\n") + "\n"); return p; };
  const lignesDe = (nom: string) => readFileSync(fixture(nom), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const reclamer = { type: "tool_execution_start", toolCallId: "r1", toolName: "fichier_reclamer", args: { chemin: "app.js", raison: "le menu" } };
  const repondu = { type: "message_end", message: { role: "assistant", content: [], usage: { input: 100, output: 10, cost: { total: 0.0001 } }, stopReason: "toolUse" } };
  const erreur = (m: string) => ({ type: "message_end", message: { role: "assistant", content: [], usage: { input: 0, output: 0 }, stopReason: "error", errorMessage: m } });
  const relances = (run: string, nom = "Antoine") => readFileSync(join(run, "journal", `${nom}.args`), "utf8").trim().split("\n").map((l) => JSON.parse(l).env.ESSAIM_RELANCE as string | undefined);
  const messagesUser = (run: string, nom = "Antoine") => readFileSync(join(run, "journal", `${nom}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    .filter((l) => l.type === "message_end" && l.message?.role === "user").map((l) => l.message.content[0].text as string);
  const livraisons = (run: string) => { const x = ouvrirBun(join(run, "tableau.sqlite"), { lectureSeule: true }); const r = x.all<{ agent: string; moment: string; de_fait: number; confirme_le: string | null; texte: string }>("SELECT agent, moment, de_fait, confirme_le, texte FROM memoire_livraisons WHERE moment <> 'ligne' ORDER BY id"); x.fermer(); return r; }; // les états, sans les lignes courtes
  const nettoyer = () => { for (const k of Object.keys(process.env)) if (k.startsWith("ESSAIM_FIXTURE") || k.startsWith("ESSAIM_FAUX_")) delete process.env[k]; delete process.env.ESSAIM_TOUR_MS; viderEnv(); };
  beforeEach(() => { nettoyer(); process.env.ESSAIM_PI = join(racineDepot, "tests", "faux-pi.ts"); });
  afterEach(nettoyer);
  const PANCARTE = "pancarte · app.js · Antoine · « le menu »";
  // La relance porte le texte d'aujourd'hui, une ligne vide, puis l'état ; la livraison est confirmée par le lanceur.
  const verifierRelance = (run: string, moment: string, relance: (s: string) => boolean) => {
    const env = relances(run);
    expect(env[0]).toBeUndefined(); // premier lancement : aucun état
    expect(env[1]).toBe(moment);
    const [premier, second] = messagesUser(run);
    expect(premier).not.toContain(T.MARQUE_ETAT);
    const [texteRelance, etat] = second!.split("\n\n");
    expect(relance(texteRelance!)).toBe(true);
    expect(etat).toStartWith(`${T.MARQUE_ETAT} le début du run (`);
    expect(etat).toContain(PANCARTE);
    expect(livraisons(run)).toEqual([expect.objectContaining({ agent: "Antoine", moment, de_fait: 0, confirme_le: expect.any(String), texte: sansBut(second!.slice(texteRelance!.length + 2)) })]);
  };

  test("passe suivante (continue) et relance après erreur du fournisseur (P4)", async () => {
    process.env.ESSAIM_FIXTURE = ecrireFixture("sans-fini", [reclamer, ...lignesDe("sans-fini")]);
    process.env.ESSAIM_FIXTURE_PASSE_2 = fixture("hello-fini");
    verifierRelance((await lancer(base())).run, "continue", (s) => s === "continue");
    rmSync(join(dossier, "runs"), { recursive: true, force: true });
    process.env.ESSAIM_FIXTURE = ecrireFixture("erreur", [reclamer, ...lignesDe("erreur-fournisseur")]);
    verifierRelance((await lancer(base())).run, "continue", (s) => s === "continue");
  });

  test("erreur passagère : un état après du travail reçu ; au premier lancement sans rien reçu, la mission est renvoyée sans état (S10)", async () => {
    process.env.ESSAIM_FIXTURE = ecrireFixture("passagere", [reclamer, repondu, erreur("Provider timed out after 24036ms"), { type: "agent_end" }]);
    process.env.ESSAIM_FIXTURE_PASSE_2 = fixture("hello-fini");
    verifierRelance((await lancer(base())).run, "passagere", (s) => s.includes("n'a pas répondu à temps"));
    rmSync(join(dossier, "runs"), { recursive: true, force: true });
    process.env.ESSAIM_FIXTURE = ecrireFixture("passagere-vide", [reclamer, ...lignesDe("delai-fournisseur")]);
    const run = (await lancer(base())).run;
    expect(relances(run)).toEqual([undefined, undefined]);
    expect(messagesUser(run).some((m) => m.includes(T.MARQUE_ETAT))).toBe(false);
    expect(livraisons(run)).toEqual([]);
  });

  test("mémoire réparée, mémoire allégée d'images", async () => {
    const empoisonnee = [
      { type: "message", id: "a1", parentId: null, message: { role: "assistant", content: [{ type: "toolCall", id: "", name: "", arguments: {} }] } },
      { type: "message", id: "a2", parentId: "a1", message: { role: "toolResult", toolCallId: "", toolName: "", content: [{ type: "text", text: "Tool  not found" }], isError: true } },
    ].map((l) => JSON.stringify(l)).join("\n") + "\n";
    process.env.ESSAIM_FIXTURE = ecrireFixture("empoisonne", [reclamer, { type: "faux:session", contenu: empoisonnee },
      erreur('400: {"message":"messages[67]: tool messages must include a non-empty string tool_call_id","code":400}'), { type: "agent_end" }]);
    process.env.ESSAIM_FIXTURE_PASSE_2 = fixture("hello-fini");
    verifierRelance((await lancer(base())).run, "reparee", (s) => s.includes("outil_inconnu"));
    rmSync(join(dossier, "runs"), { recursive: true, force: true });
    const image = { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" };
    const memoire = [0, 1, 2, 3, 4, 5].map((i) => JSON.stringify({ type: "message", id: `r${i}`, parentId: i ? `r${i - 1}` : null,
      message: { role: "toolResult", toolCallId: `c${i}`, toolName: "read", content: [{ type: "text", text: "Read image file [image/png]" }, image] } })).join("\n") + "\n";
    process.env.ESSAIM_FIXTURE = ecrireFixture("images", [reclamer, { type: "faux:session", contenu: memoire }, erreur("Too many images in request: 6 > 4"), { type: "agent_end" }]);
    verifierRelance((await lancer(base())).run, "images", (s) => s.includes("images"));
  });

  test("réponse emballée", async () => {
    const maj = (e: Record<string, unknown>) => ({ type: "message_update", assistantMessageEvent: e });
    process.env.ESSAIM_FIXTURE = ecrireFixture("emballee", [reclamer,
      ...Array.from({ length: 35 }, (_, i) => maj({ type: "toolcall_end", contentIndex: i, toolCall: { type: "toolCall", id: `c${i}`, name: "bash", arguments: { command: "true" } } })),
      { type: "faux:dormir", ms: 8000 }, { type: "agent_end" }]);
    process.env.ESSAIM_FIXTURE_PASSE_2 = fixture("hello-fini");
    verifierRelance((await lancer(base())).run, "emballee", (s) => s.includes("s'est emballée"));
  });

  test("réveil (et réveil après résumé) ; reprise après résumé", async () => {
    process.env.ESSAIM_FIXTURE_ANTOINE = ecrireFixture("dormir", [reclamer, ...lignesDe("dormir")]);
    process.env.ESSAIM_FIXTURE = fixture("appelle-antoine");
    process.env.ESSAIM_FIXTURE_PASSE_2 = fixture("reveille-fini");
    process.env.ESSAIM_TOUR_MS = "0";
    const run = (await lancer({ ...base(), agents: 2 })).run;
    verifierRelance(run, "reveil", (s) => s.startsWith("Tu étais en veille. Bernard t'a nommé"));
    expect(messagesUser(run)[1]).toContain("Antoine · en veille");
    rmSync(join(dossier, "runs"), { recursive: true, force: true });
    delete process.env.ESSAIM_FIXTURE_ANTOINE;
    process.env.ESSAIM_FIXTURE = ecrireFixture("resumer", [reclamer, ...lignesDe("resumer")]);
    process.env.ESSAIM_FIXTURE_PASSE_2 = fixture("hello-fini");
    const r = (await lancer(base())).run;
    verifierRelance(r, "resume", (s) => s === "Ton contexte vient d'être résumé. Reprends ton travail.");
  });

  test("pause, puis reprise", async () => {
    const runDir = () => join(dossier, "runs", readdirSync(join(dossier, "runs")).filter((n) => !n.startsWith(".")).sort().at(-1)!);
    const attendre = async (condition: () => boolean, ms = 8000) => { const fin = Date.now() + ms; while (!condition()) { if (Date.now() > fin) throw new Error("condition jamais vraie"); await Bun.sleep(50); } };
    process.env.ESSAIM_FIXTURE = ecrireFixture("long", [reclamer, repondu, { type: "faux:dormir", ms: 60_000 }, { type: "agent_end" }]);
    process.env.ESSAIM_FIXTURE_PASSE_2 = fixture("hello-fini");
    const promesse = lancer({ ...base(), silenceMin: 0.02 });
    await attendre(() => existsSync(join(dossier, "runs")) && readdirSync(join(dossier, "runs")).some((n) => !n.startsWith(".")) && existsSync(join(runDir(), "journal", "Antoine.jsonl")) && readFileSync(join(runDir(), "journal", "Antoine.jsonl"), "utf8").includes('"assistant"'));
    const run = runDir();
    writeFileSync(join(run, "pause"), "test");
    await attendre(() => relances(run).length === 1 && (() => { const x = ouvrirBun(join(run, "tableau.sqlite"), { lectureSeule: true }); const e = x.get("SELECT 1 FROM evenements WHERE type = 'pause' AND agent = 'Antoine'"); x.fermer(); return !!e; })());
    rmSync(join(run, "pause"));
    await promesse;
    verifierRelance(run, "pause", (s) => s.includes("Le run a été mis en pause, puis repris"));
  });

  test("veille de la machine", async () => {
    // Comme tests/lancer.test.ts : le lanceur gelé (SIGSTOP) plus longtemps que le silence toléré, le faux pi répond par une erreur.
    const runDir = () => join(dossier, "runs", readdirSync(join(dossier, "runs")).filter((n) => !n.startsWith(".")).sort().at(-1)!);
    const fx = ecrireFixture("veille", [reclamer, repondu, { type: "faux:dormir", ms: 3500 }, erreur("connexion perdue"), { type: "agent_end" }]);
    const proc = Bun.spawn(["bun", join(racineDepot, "src", "lancer.ts"), "--agents", "1", "--modele", "faux", "--plafond", "0.10", "--mission", join(racineDepot, "tests", "fixtures", "hello-world.md"), "--sans-bac-a-sable", "--silence", "0.04"],
      { cwd: dossier, stdout: "pipe", stderr: "pipe", env: { ...process.env, ESSAIM_TEST: "1", ESSAIM_FIXTURE: fx, ESSAIM_FIXTURE_PASSE_2: fixture("hello-fini"), ESSAIM_VEILLE_MS: "1000" } });
    const fin = Date.now() + 8000;
    while (!(existsSync(join(dossier, "runs")) && readdirSync(join(dossier, "runs")).some((n) => !n.startsWith(".")) && existsSync(join(runDir(), "journal", "Antoine.jsonl"))
      && readFileSync(join(runDir(), "journal", "Antoine.jsonl"), "utf8").includes('"assistant"'))) { if (Date.now() > fin) throw new Error("run jamais commencé"); await Bun.sleep(50); }
    process.kill(proc.pid, "SIGSTOP");
    await Bun.sleep(4000);
    process.kill(proc.pid, "SIGCONT");
    expect(await proc.exited).toBe(0);
    verifierRelance(runDir(), "veille", (s) => s.includes("s'est mis en veille"));
  });

  test("pi mort après son en-tête : livraison non confirmée, curseurs inchangés, et la relance suivante relivre les mêmes faits (E3)", async () => {
    process.env.ESSAIM_FIXTURE = ecrireFixture("sans-fini", [reclamer, ...lignesDe("sans-fini")]);
    process.env.ESSAIM_FAUX_ARRET_ENTETE_PASSE = "2";
    process.env.ESSAIM_FIXTURE_PASSE_3 = fixture("hello-fini");
    const run = (await lancer(base())).run;
    expect(relances(run)).toEqual([undefined, "continue", "continue"]);
    const l = livraisons(run);
    expect(l.map((x) => [x.moment, x.de_fait, x.confirme_le === null])).toEqual([["continue", 0, true], ["continue", 0, false]]);
    expect(l[0]!.texte.split("\n").slice(1)).toEqual(l[1]!.texte.split("\n").slice(1)); // mêmes faits, même curseur de départ
    expect(l[1]!.texte).toContain(PANCARTE);
    expect(messagesUser(run).length).toBe(2); // la mission, puis la troisième passe : la deuxième n'a rien émis après l'en-tête
  });
});

describe("la ligne courte (§6, M9, P3)", () => {
  afterEach(viderEnv);
  const LIGNE = "[salle] depuis ";
  const budget = async (pi: ReturnType<typeof fauxPi>) => (await pi.texte("salle_budget", {})).split("\n");
  const ligneDe = async (pi: ReturnType<typeof fauxPi>) => (await budget(pi)).find((l) => l.startsWith(LIGNE));
  const lu = async (pi: ReturnType<typeof fauxPi>, outil: string, path: string) => pi.emettre("tool_call", { type: "tool_call", toolName: outil, toolCallId: `lu-${path}`, input: { path } });
  const lignes = () => t.all<{ moment: string; de_fait: number; a_fait: number; lignes: number; retires: number; caracteres: number; texte: string; confirme_le: string | null }>(
    "SELECT moment, de_fait, a_fait, lignes, retires, caracteres, texte, confirme_le FROM memoire_livraisons ORDER BY id");
  const curseurs = () => t.get("SELECT etat_fait_id, ligne_fait_id FROM memoire_curseurs WHERE agent = 'Antoine'");
  const h = (id: number) => hm(fait(id).cree_le);

  test("une écriture d'un autre sur un fichier écrit par l'agent (en base) : une ligne, une seule fois, notée confirmée", async () => {
    commit("Antoine", { "app.js": "v1" }, { hash: "1111111" });
    const pi = instance("Antoine");
    expect(await ligneDe(pi)).toBeUndefined();
    const c = commit("Claude", { "app.js": "v2" });
    expect(await ligneDe(pi)).toBe(`[salle] depuis ${h(c)} : app.js écrit par Claude (commit 3f2a1bc)`);
    expect(await ligneDe(pi)).toBeUndefined(); // jamais deux fois pour le même fait
    expect(lignes()).toEqual([{ moment: "ligne", de_fait: 0, a_fait: c, lignes: 1, retires: 0, caracteres: `[salle] depuis ${h(c)} : app.js écrit par Claude (commit 3f2a1bc)`.length,
      texte: `[salle] depuis ${h(c)} : app.js écrit par Claude (commit 3f2a1bc)`, confirme_le: expect.any(String) }]);
    expect(curseurs()).toEqual({ etat_fait_id: 0, ligne_fait_id: c });
    // Une écriture par bash garde « attribué au mieux » ; ses propres écritures ne donnent rien.
    const b = commit("Bernard", { "app.js": "v3" }, { outil: "bash", hash: "9c1e2aa" });
    commit("Antoine", { "app.js": "v4" });
    expect(await ligneDe(pi)).toBe(`[salle] depuis ${h(b)} : app.js écrit par Bernard (commit 9c1e2aa, attribué au mieux)`);
    expect(pi.erreurs).toEqual([]);
  });

  test("un fichier lu, écrit ou édité pendant ce lancement, par un chemin relatif au bureau ; absente pour un fichier qui ne le concerne pas", async () => {
    const pi = instance("Antoine");
    const a = commit("Claude", { "autre.js": "x" });
    expect(await ligneDe(pi)).toBeUndefined(); // autre.js ne le concerne pas encore : considéré, jamais redit
    await lu(pi, "read", "../../partage/autre.js");
    expect(await ligneDe(pi)).toBeUndefined();
    const b = commit("Claude", { "autre.js": "y", "loin.js": "z" }, { hash: "2222222" });
    expect(await ligneDe(pi)).toBe(`[salle] depuis ${h(b)} : autre.js écrit par Claude (commit 2222222)`);
    expect(a).toBeLessThan(b);
    await lu(pi, "edit", join(partage, "css", "style.css")); // chemin absolu
    await lu(pi, "write", "../../essais/menu-2/index.html"); // un essai : sa propre racine
    const c = commit("Bernard", { "css/style.css": "s" }, { hash: "3333333" });
    const d = commit("Bernard", { "index.html": "i" }, { hash: "4444444", racine: "essai:menu-2" });
    const e = commit("Bernard", { "index.html": "p" }, { hash: "5555555" }); // index.html du dossier commun : pas le sien
    expect(await ligneDe(pi)).toBe(`[salle] depuis ${h(c)} : index.html écrit par Bernard (commit 4444444) ; css/style.css écrit par Bernard (commit 3333333)`);
    expect(e).toBeGreaterThan(d);
  });

  test("un chemin en ~/ est normalisé comme D.cible", async () => {
    const maison = mkdtempSync(join(homedir(), ".essaim-etat-"));
    try {
      const p2 = join(maison, "partage");
      mkdirSync(p2);
      const pi = instance("Antoine", { ESSAIM_PARTAGE: p2 });
      await lu(pi, "read", `~/${join(maison.slice(homedir().length + 1), "partage", "app.js")}`);
      const c = commit("Claude", { "app.js": "v2" });
      expect(await ligneDe(pi)).toBe(`[salle] depuis ${h(c)} : app.js écrit par Claude (commit 3f2a1bc)`);
    } finally { rmSync(maison, { recursive: true, force: true }); }
  });

  test("toute vérification d'un autre, tout départ, toute fermeture de fil ; rien pour une veille, une pancarte ou une ouverture de fil", async () => {
    const pi = instance("Antoine");
    ecrire({ "index.html": "<p>1</p>" });
    T.reclamer(t, "Claude", "x.js", "");
    noter({ type: "agent", agent: "Claude", source: "tableau", texte: "Claude · en veille" });
    T.poster(t, "Bernard", "je commence");
    T.entrer(t, "Bernard", "q-horaires", "les horaires");
    expect(await ligneDe(pi)).toBeUndefined();
    const v = verif("Bernard", "page_voir", { fichiers: ["index.html"] });
    noter({ type: "agent", agent: "Edmond", source: "tableau", texte: "Edmond · fini · raison déclarée par Edmond : « page juste 23/23 »" });
    T.quitter(t, "Bernard", "53 min, pas 45");
    expect(await ligneDe(pi)).toBe(`[salle] depuis ${h(v)} : q-horaires fermé ; Edmond fini ; index.html vérifié par Bernard (page_voir)`);
  });

  test("trois faits en forme courte puis le compte, 300 caractères au plus ; aucun mot interdit", async () => {
    const pi = instance("Antoine");
    const premier = verif("Bernard", "page_voir", { fichiers: ["a.html"], sujet: "a".repeat(80) });
    for (const x of ["b", "c", "d"]) verif("Bernard", "page_voir", { fichiers: [`${x}.html`], sujet: x.repeat(80) });
    noter({ type: "agent", agent: "Claude", source: "tableau", texte: "Claude · perdu · raison : silence" });
    const l = (await ligneDe(pi))!;
    expect([...l].length).toBeLessThanOrEqual(300);
    expect(l).toStartWith(`[salle] depuis ${h(premier)} : Claude perdu ; ${"d".repeat(80)} vérifié par Bernard (page_voir) ; `);
    expect(l).toEndWith(' ; +3 faits (salle_chercher(type: "fait"))');
    expect(lignes()[0]).toMatchObject({ lignes: 2, retires: 3 });
    expect(motsInterdits(l)).toEqual([]);
    noter({ type: "agent", agent: "Claude", source: "tableau", texte: "Claude · viré · raison : seuil" });
    expect(await ligneDe(pi)).toBe(`[salle] depuis ${h(maxFait())} : Claude viré`);
  });

  test("rien sous le plancher de l'état préparé dans ce lancement", async () => {
    ecrire({ "index.html": "<p>1</p>" });
    verif("Bernard", "page_voir", { fichiers: ["index.html"] });
    const pi = instance("Antoine", { ESSAIM_RELANCE: "reveil" });
    expect(await pi.saisir("Tu étais en veille.")).toContain("vérifié · page_voir index.html · Bernard");
    expect(await ligneDe(pi)).toBeUndefined(); // l'état vient de le livrer, pas encore confirmé
    const v2 = verif("Claude", "code_tester", { sujet: "tests (tout le dossier)" });
    expect(await ligneDe(pi)).toBe(`[salle] depuis ${h(v2)} : tests (tout le dossier) vérifié par Claude (code_tester)`);
  });

  test("absente sur moi_dormir, moi_finir, moi_resumer et sur un refus de coupure : le fait attend l'outil suivant", async () => {
    const pi = instance("Antoine");
    const v = verif("Bernard", "page_voir", { fichiers: ["index.html"] });
    const contenu = [{ type: "text", text: "ok" }];
    for (const outil of ["moi_dormir", "moi_finir", "moi_resumer"])
      expect(await pi.emettre("tool_result", { type: "tool_result", toolName: outil, toolCallId: outil, input: {}, content: contenu, isError: false })).toBeUndefined();
    expect(await pi.emettre("tool_result", { type: "tool_result", toolName: "salle_lire", toolCallId: "c", input: {}, isError: true,
      content: [{ type: "text", text: "refusé : ton contexte fait 170k tokens, au-delà de la coupure (160k) ; seul moi_resumer passe. Se lève après le résumé." }] })).toBeUndefined();
    expect(await ligneDe(pi)).toBe(`[salle] depuis ${h(v)} : index.html vérifié par Bernard (page_voir)`);
  });

  test("coexiste avec la ligne [contexte] de se-resumer : deux extensions, gestionnaires enchaînés", async () => {
    const pi = instance("Antoine", { ESSAIM_COMPACTAGE: "80000,120000,160000" });
    seResumer(pi.api);
    pi.regler(90_000);
    const v = verif("Bernard", "page_voir", { fichiers: ["index.html"] });
    const r = await budget(pi);
    expect(r.slice(1)).toEqual([ // dans l'ordre de chargement, comme pi : -e outils-essaim.ts puis -e se-resumer.ts
      `[salle] depuis ${h(v)} : index.html vérifié par Bernard (page_voir)`,
      "[contexte] 90k tokens : au-delà de l'avis (80k) ; avertissement à 120k, à 160k seul moi_resumer passe.",
    ]);
  });

  test("ESSAIM_MEMOIRE=non : ni état ni ligne, mais les faits sont écrits", async () => {
    const pi = instance("Antoine", { ESSAIM_MEMOIRE: "non", ESSAIM_RELANCE: "continue" });
    verif("Bernard", "page_voir", { fichiers: ["index.html"] });
    expect(await pi.saisir("continue")).toBe("continue");
    expect(await ligneDe(pi)).toBeUndefined();
    await pi.texte("fichier_reclamer", { chemin: "app.js", raison: "le menu" });
    expect(t.all("SELECT texte FROM faits WHERE agent = 'Antoine'")).toEqual([{ texte: "pancarte · app.js · Antoine · « le menu »" }]);
    expect(lignes()).toEqual([]);
  });
});

describe("sous Node, comme dans pi (M13, phase 7)", () => {
  test("le gestionnaire input transforme le texte de relance et la ligne courte répond, sous node:sqlite ; stderr vide", () => {
    const aide = new URL("./aide/memoire-node.ts", import.meta.url).pathname;
    const base = join(dossier, "node.sqlite");
    const r = Bun.spawnSync(["node", "--no-warnings", "--experimental-strip-types", aide, base, "7", partage], { env: { ...process.env, ESSAIM_TEST: "1", ESSAIM_TOUR_MS: "0" } });
    expect(r.stderr.toString()).toBe("");
    const { phase7 } = JSON.parse(r.stdout.toString());
    expect(phase7.etat).toStartWith(`Tu étais en veille.\n\n${T.MARQUE_ETAT} le début du run (`);
    expect(phase7.etat).toEndWith("pancarte · menu.js · agent-02 · « sous node »\n\n[but] La mission de la salle :\n\nmission\n\nCe que tu fais en ce moment sert-il ce but ?");
    expect(phase7.ligne).toMatch(/\n\[salle\] depuis \d\d:\d\d : agent-02 perdu$/);
    expect(phase7.livraisons).toEqual([["reveil", false], ["ligne", true]]);
    expect(phase7.erreurs).toEqual([]);
  }, 60_000);
});

// ---- Rôles des agents : la passation d'un siège ------------------------------------------
// L'état du siège (memoire.etatDuSiege) : des faits de la salle filtrés sur le siège, livrés au premier message d'un
// nouvel occupant ; puis, au faux pi, un agent perdu relancé (l'état seul) et un agent remplacé vivant (l'état, puis
// sa note).
describe("l'état d'un siège, pour son nouvel occupant (R9)", () => {
  test("tickets repris, alertes du sortant, ses vérifications avec « écrit depuis », pancartes, signatures révoquées", () => {
    t.run("UPDATE agents SET role = 'recette' WHERE nom = 'Bernard'");
    t.run("UPDATE agents SET role = 'constructeur' WHERE nom = 'Antoine'");
    T.ouvrirTicket(t, { type: "amelioration", titre: "le scénario du menu", description: "d", auteur: "Antoine", charge: "Bernard", chemins: ["app.js"] });
    T.ouvrirTicket(t, { type: "bug", titre: "le prix saute", description: "d", auteur: "Bernard", charge: "Antoine", sorte: "alerte", reproduction: { commande: "false", graine: null, commit: "0".repeat(40), banc: {}, monde: {} } });
    T.reclamer(t, "Bernard", "notes.md", "mes scénarios");
    ecrire({ "app.js": "v1" });
    verif("Bernard", "page_voir", { fichiers: ["app.js"] });
    T.noterPhrases(t, [{ n: 1, section: "Mission", texte: "Un titre." }]);
    T.rangerExigence(t, { phrases: [1], classement: "exigence", responsable: "recette", par: "Antoine" });
    T.attester(t, { exigence: "E1", agent: "Bernard", role: "recette", nature: "parcours", recu: null, portee: "pas de navigateur" });
    T.sortirAgent(t, "Bernard", "perdu", "passes épuisées");
    T.ajouterAgent(t, "Denis", join(dossier, "agents", "Denis"), undefined, undefined, { role: "recette", remplace: "Bernard" });
    expect(T.succeder(t, "Bernard", "Denis", "siège repris par Denis")).toEqual({ tickets: [1], revoquees: 1 });
    expect(T.attestationDe(t, "E1")).toBeUndefined(); // le droit de signer est tombé avec l'occupant
    const e = M.etatDuSiege(t, "Denis", racines(), { cache: new Map(), maintenant: RELU })!;
    expect(e.split("\n")[0]).toBe("[siège] Tu prends le siège de recette que tenait Bernard (perdu : passes épuisées). L'état du siège constaté par la salle à 21:40:31 :");
    expect(e).toContain("tickets ouverts qui te sont confiés :\n- #1 · amelioration · ouvert · Antoine → Denis · le scénario du menu · chemins : app.js");
    expect(e).toContain("alertes ouvertes par Bernard :\n- #2 · alerte · bug · ouvert · Bernard → Antoine · le prix saute");
    expect(e).toMatch(/vérifications de Bernard, les plus récentes d'abord :\n- \d\d:\d\d vérifié · page_voir app\.js · Bernard · rien écrit depuis \(relu à 21:40:31\)/);
    expect(e).toContain("pancartes à ton nom : app.js, notes.md");
    expect(e).toContain("signatures de Bernard révoquées au changement d'occupant : E1");
    expect(e).not.toContain("bureau privé");
    expect(motsInterdits(e)).toEqual([]);
    expect(M.etatDuSiege(t, "Antoine", racines(), { cache: new Map() })).toBeUndefined(); // pas un nouvel occupant
  });

  test("un gardien-mesureur reprend le bureau privé du siège, celui du premier occupant", () => {
    t.run("UPDATE agents SET role = 'gardien' WHERE nom = 'Bernard'");
    T.sortirAgent(t, "Bernard", "vire", "silence");
    T.ajouterAgent(t, "Denis", join(dossier, "agents", "Denis"), undefined, undefined, { role: "gardien", remplace: "Bernard" });
    T.sortirAgent(t, "Denis", "perdu", "passes épuisées");
    T.ajouterAgent(t, "Edmond", join(dossier, "agents", "Edmond"), undefined, undefined, { role: "gardien", remplace: "Denis" });
    const e = M.etatDuSiege(t, "Edmond", racines(), { cache: new Map() })!;
    expect(e).toStartWith("[siège] Tu prends le siège de gardien-mesureur que tenait Denis (perdu : passes épuisées).");
    expect(e).toContain(`bureau privé du siège : ${join(dossier, "agents", "Bernard", "prive")}`);
    expect(e).toContain("tickets ouverts qui te sont confiés : aucun");
    expect(e).toContain("vérifications de Denis : aucune");
  });
});

describe("le lanceur relance un siège (R9, spec §7)", () => {
  const racineDepot = resolve(import.meta.dir, "..");
  const fixture = (nom: string) => join(racineDepot, "tests", "fixtures", `${nom}.jsonl`);
  const ecrireFixture = (nom: string, lignes: object[]) => { const p = join(dossier, `${nom}.jsonl`); writeFileSync(p, lignes.map((l) => JSON.stringify(l)).join("\n") + "\n"); return p; };
  const lignesDe = (nom: string) => readFileSync(fixture(nom), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const mission = () => { const p = join(dossier, "mission-fichier.md"); writeFileSync(p, `${readFileSync(join(racineDepot, "tests", "fixtures", "hello-world.md"), "utf8")}\n## Type\n\nfichier\n`); return p; };
  const base = (): Options => ({ agents: 1, modele: "faux", plafond: 0.1, mission: mission(), racine: dossier, sansBacASable: true });
  const reclamer = { type: "tool_execution_start", toolCallId: "r1", toolName: "fichier_reclamer", args: { chemin: "app.js", raison: "le menu" } };
  const lancements = (run: string, nom: string) => readFileSync(join(run, "journal", `${nom}.args`), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { env: Record<string, string> });
  const messagesUser = (run: string, nom: string) => readFileSync(join(run, "journal", `${nom}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    .filter((l) => l.type === "message_end" && l.message?.role === "user").map((l) => l.message.content[0].text as string);
  const nettoyer = () => { for (const k of Object.keys(process.env)) if (k.startsWith("ESSAIM_FIXTURE")) delete process.env[k]; delete process.env.ESSAIM_TOUR_MS; viderEnv(); };
  beforeEach(() => { nettoyer(); process.env.ESSAIM_PI = join(racineDepot, "tests", "faux-pi.ts"); process.env.ESSAIM_TOUR_MS = "0"; });
  afterEach(nettoyer);

  // Un agent sans ticket qui se tait n'est pas perdu (il est mis en veille) ;
  // la panne qui fait relancer le siège est ici une erreur du fournisseur à chaque passe.
  test("agent perdu puis relancé : un nouveau prénom au même siège, l'état du siège livré, sans note ; ses pancartes reprises", async () => {
    process.env.ESSAIM_FIXTURE_ANTOINE = ecrireFixture("perdu", [reclamer, ...lignesDe("erreur-fournisseur")]);
    process.env.ESSAIM_FIXTURE_BERNARD = fixture("hello-fini");
    const b = await lancer(base());
    expect(b).toMatchObject({ finis: 1, perdus: 1, etat: "accepte" });
    expect(b.passations).toEqual([{ role: "constructeur", sortant: "Antoine", entrant: "Bernard", motif: "402: insufficient credits", note: false, livre: true }]);
    expect(lancements(b.run, "Bernard")[0]!.env).toMatchObject({ ESSAIM_ROLE: "constructeur", ESSAIM_RELANCE: "succession" });
    const premier = messagesUser(b.run, "Bernard")[0]!;
    expect(premier).toContain("\n\n[siège] Tu prends le siège de constructeur que tenait Antoine (perdu : 402: insufficient credits).");
    expect(premier).toContain("pancartes à ton nom : app.js");
    expect(premier).not.toContain("Note de passation");
    expect(premier.indexOf("[siège]")).toBeLessThan(premier.indexOf(M.MARQUE_BUT));
    const x = ouvrirBun(join(b.run, "tableau.sqlite"), { lectureSeule: true });
    expect(x.get("SELECT nom, role, remplace FROM agents WHERE nom = 'Bernard'")).toEqual({ nom: "Bernard", role: "constructeur", remplace: "Antoine" });
    expect(x.get<{ texte: string }>("SELECT texte FROM messages WHERE auteur = 'essaim'")!.texte).toBe("[siège] Bernard tient désormais le siège de constructeur d'Antoine (perdu : 402: insufficient credits).");
    expect(x.all<{ resultat_resume: string }>("SELECT resultat_resume FROM evenements WHERE agent = 'Bernard' AND type = 'succession' ORDER BY id").map((e) => e.resultat_resume))
      .toEqual(["siège de constructeur repris d'Antoine (perdu : 402: insufficient credits)", "état du siège livré"]);
    x.fermer();
    expect(formaterBilan(b)).toContain("\nsièges repris : constructeur d'Antoine à Bernard (402: insufficient credits)");
  }, 30_000);

  test("agent remplacé vivant (moi_passation) : l'état du siège, puis sa note citée comme déclarée ; le sortant est fini", async () => {
    process.env.ESSAIM_FIXTURE_ANTOINE = ecrireFixture("passe", [reclamer,
      { type: "tool_execution_start", toolCallId: "p1", toolName: "moi_passation", args: { note: "le menu est commencé dans app.js ; les prix restent à faire" } }, { type: "agent_end" }]);
    process.env.ESSAIM_FIXTURE_BERNARD = fixture("hello-fini");
    const b = await lancer(base());
    expect(b).toMatchObject({ finis: 2, perdus: 0, etat: "accepte" });
    expect(b.passations).toEqual([{ role: "constructeur", sortant: "Antoine", entrant: "Bernard", motif: "passation du siège", note: true, livre: true }]);
    const premier = messagesUser(b.run, "Bernard")[0]!;
    const siege = premier.indexOf("[siège] Tu prends le siège de constructeur que tenait Antoine (fini : passation du siège).");
    const note = premier.indexOf("\n\nNote de passation d'Antoine");
    expect(siege).toBeGreaterThan(0);
    expect(note).toBeGreaterThan(siege);
    expect(premier).toContain("Note de passation d'Antoine, déclaré par Antoine, non vérifié : « le menu est commencé dans app.js ; les prix restent à faire »");
    expect(premier.indexOf(M.MARQUE_BUT)).toBeGreaterThan(note);
    const x = ouvrirBun(join(b.run, "tableau.sqlite"), { lectureSeule: true });
    expect(x.get("SELECT agent, role, entrant, livree_le IS NOT NULL AS livree FROM passations")).toEqual({ agent: "Antoine", role: "constructeur", entrant: "Bernard", livree: 1 });
    expect(x.get("SELECT etat, raison_sortie FROM agents WHERE nom = 'Antoine'")).toEqual({ etat: "fini", raison_sortie: "passation du siège" });
    x.fermer();
  }, 30_000);

  test("deux changements d'occupant au plus par siège : le troisième perdu n'est plus relancé, le run est incomplet", async () => {
    process.env.ESSAIM_FIXTURE = fixture("erreur-fournisseur"); // une panne, pas un silence sans ticket
    const b = await lancer(base());
    expect(b).toMatchObject({ finis: 0, perdus: 3, etat: "incomplet" });
    expect(b.passations!.map((p) => `${p.sortant}→${p.entrant}`)).toEqual(["Antoine→Bernard", "Bernard→Claude"]);
    expect(b.raisonsEtat![0]).toBe("siège tombé sans successeur : constructeur de Claude (402: insufficient credits)");
  }, 30_000);

  test("sans rôles, un agent perdu n'est jamais relancé", async () => {
    process.env.ESSAIM_FIXTURE = ecrireFixture("perdu", [reclamer, ...lignesDe("sans-fini")]);
    const b = await lancer({ ...base(), mission: join(racineDepot, "tests", "fixtures", "hello-world.md") });
    expect(b).toMatchObject({ finis: 0, perdus: 1 });
    expect(b.passations).toBeUndefined();
    expect(b.etat).toBeUndefined();
  }, 30_000);
});
