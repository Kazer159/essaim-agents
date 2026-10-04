// Second cerveau : le schéma des faits, de la mémoire et de l'index de recherche, ses déclencheurs,
// noterFait et citer.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ouvrirBun } from "../src/tableau-bun.ts";
import * as T from "../src/tableau.ts";
import { motsInterdits } from "./aide/mots-interdits.ts";

let dossier: string;
let t: T.Tableau;

beforeEach(() => {
  dossier = mkdtempSync(join(tmpdir(), "essaim-faits-"));
  t = ouvrirBun(join(dossier, "tableau.sqlite"));
  T.initialiser(t);
});
afterEach(() => {
  t.fermer();
  rmSync(dossier, { recursive: true, force: true });
});

type Ligne = { texte: string; type: string; ref: string | number | null; auteur: string | null; fil: string | null; cree_le: string };
const index = (tb = t) => tb.all<Ligne>("SELECT rowid, texte, type, ref, auteur, fil, cree_le FROM recherche ORDER BY rowid");
// Un fait inséré à la main (sans dépendre de noterFait).
const inserer = (type: string, agent: string, texte: string, details?: unknown) =>
  t.run("INSERT INTO faits(cree_le, type, agent, source, texte, details_json) VALUES (?, ?, ?, 'lanceur', ?, ?)",
    ["2026-09-27T10:00:00.000Z", type, agent, texte, details === undefined ? null : JSON.stringify(details)]).lastId;
const fait = (f: Partial<T.NouveauFait> = {}): T.NouveauFait => ({ type: "agent", agent: "Edmond", source: "tableau", texte: "Edmond · en veille", ...f });

describe("2.1 le schéma entier", () => {
  test("après initialiser : faits, memoire_curseurs, memoire_livraisons, recherche, run.memoire, l'index par type", () => {
    for (const n of ["faits", "memoire_curseurs", "memoire_livraisons", "recherche"]) expect(T.aTable(t, n)).toBe(true);
    expect(T.aColonne(t, "run", "memoire")).toBe(true);
    expect(t.get("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'ix_faits_type'")).toBeDefined();
    const colonnes = (table: string) => t.all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name);
    expect(colonnes("faits")).toEqual(["id", "cree_le", "type", "agent", "source", "sujet", "statut", "texte", "message_id", "details_json"]);
    expect(colonnes("memoire_curseurs")).toEqual(["agent", "etat_fait_id", "ligne_fait_id"]);
    expect(colonnes("memoire_livraisons")).toEqual(["id", "agent", "livre_le", "moment", "de_fait", "a_fait", "a_message", "lignes",
      "retires", "caracteres", "texte", "confirme_le", "rien_ecrit_json"]);
    const declencheurs = t.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").map((r) => r.name);
    expect(declencheurs).toEqual(["recherche_commit", "recherche_fait", "recherche_message", "recherche_resume", "recherche_ticket", "recherche_ticket_note"]);
  });

  test("initialiser deux fois de suite passe, sans doubler les déclencheurs", () => {
    T.initialiser(t);
    T.initialiser(t);
    T.poster(t, "Bernard", "bonjour");
    expect(index().length).toBe(1);
  });

  test("une base d'avant ce chantier passée à initialiser gagne tout, ses données intactes", () => {
    const ancien = ouvrirBun(join(dossier, "ancien.sqlite"));
    ancien.exec(T.SCHEMA.slice(0, T.SCHEMA.indexOf("-- Second cerveau")));
    for (const [table, colonne, type] of [["fils", "pourquoi", "TEXT"], ["messages", "hors_fil", "INTEGER NOT NULL DEFAULT 0"], ["messages", "sommeil", "INTEGER NOT NULL DEFAULT 0"], ["run", "outils_json", "TEXT"]])
      ancien.exec(`ALTER TABLE ${table} ADD COLUMN ${colonne} ${type}`);
    T.poster(ancien, "Bernard", "d'avant");
    expect(T.aTable(ancien, "faits")).toBe(false);
    expect(T.aColonne(ancien, "run", "memoire")).toBe(false);
    T.initialiser(ancien);
    for (const n of ["faits", "memoire_curseurs", "memoire_livraisons", "recherche"]) expect(T.aTable(ancien, n)).toBe(true);
    expect(T.aColonne(ancien, "run", "memoire")).toBe(true);
    expect(ancien.get<{ texte: string }>("SELECT texte FROM messages")?.texte).toBe("d'avant");
    T.poster(ancien, "Bernard", "d'après");
    expect(index(ancien).map((l) => l.texte)).toEqual(["d'après"]); // l'index part de la migration, sans rattrapage
    ancien.fermer();
  });

  test("un message posté entre dans l'index : type message, ref, auteur, fil, date", () => {
    T.entrer(t, "Denis", "q-horaires", "les horaires");
    const id = T.poster(t, "Denis", "l'attente réelle est de 53 min, pas 45", "q-horaires");
    const m = t.get<{ cree_le: string }>("SELECT cree_le FROM messages WHERE id = ?", [id])!;
    const l = index().find((x) => x.ref === id)!;
    expect(l).toMatchObject({ texte: "l'attente réelle est de 53 min, pas 45", type: "message", auteur: "Denis", fil: "q-horaires", cree_le: m.cree_le });
    // remove_diacritics 2 : « reelle » trouve « réelle »
    expect(t.all("SELECT rowid FROM recherche WHERE recherche MATCH 'reelle'").length).toBe(1);
  });

  test("un lot passé à fait entre une seule fois, en type resume, auteur = modèle, ref = id du lot", () => {
    T.poster(t, "Bernard", "un");
    t.run("INSERT INTO lots(fil_id, debut_id, fin_id, demande_par, cree_le) VALUES (1, 1, 1, 'Bernard', '2026-09-27T10:00:00Z')");
    const lot = t.get<{ id: number }>("SELECT id FROM lots")!.id;
    const avant = index().length;
    T.finirLot(t, lot, { ok: false, cout: 0, estime: false, modele: "mimo" });
    expect(index().length).toBe(avant); // un échec n'entre pas
    t.run("UPDATE lots SET etat = 'attente' WHERE id = ?", [lot]);
    T.finirLot(t, lot, { ok: true, texte: "navigation.js toujours absent", cout: 0, estime: false, modele: "mimo" });
    t.run("UPDATE lots SET etat = 'fait', essais = 2 WHERE id = ?", [lot]); // mise à jour répétée : fait → fait
    const resumes = index().filter((l) => l.type === "resume");
    expect(resumes.length).toBe(1);
    expect(resumes[0]).toMatchObject({ texte: "navigation.js toujours absent", ref: lot, auteur: "mimo", fil: "principal" });
  });

  test("un fait ecriture entre en commit (ref = details.hash, message et fichiers), pas en fait", () => {
    inserer("ecriture", "Antoine", "écrit · app.js · Antoine · commit 3f2a1bc",
      { hash: "3f2a1bc9", message: "write app.js", fichiers: [{ chemin: "app.js", blob: "aa" }, { chemin: "vieux.js", blob: null }] });
    inserer("ecriture", "essaim", "écrit · fin.txt · essaim · commit 9c1e2aa", { hash: "9c1e2aa0" });
    const l = index();
    expect(l.map((x) => x.type)).toEqual(["commit", "commit"]);
    expect(l[0]).toMatchObject({ texte: "write app.js · app.js, vieux.js", ref: "3f2a1bc9", auteur: "Antoine" });
    expect(l[1]).toMatchObject({ texte: "écrit · fin.txt · essaim · commit 9c1e2aa", ref: "9c1e2aa0", auteur: "essaim" }); // sans message : la ligne
  });

  test("un autre fait entre en fait (ref = id), avec la citation entière quand la ligne la coupe", () => {
    const id = inserer("agent", "Edmond", "Edmond · fini · raison déclarée par Edmond : « court »");
    const id2 = inserer("agent", "Edmond", "Edmond · fini · raison déclarée par Edmond : « long… »", { citation: "long et entier" });
    const l = index();
    expect(l.map((x) => [x.type, x.ref])).toEqual([["fait", id], ["fait", id2]]);
    expect(l[0]!.texte).toBe("Edmond · fini · raison déclarée par Edmond : « court »");
    expect(l[1]!.texte).toBe("Edmond · fini · raison déclarée par Edmond : « long… »\nlong et entier");
    expect(l[0]!.auteur).toBe("Edmond");
  });

  test("un ticket (titre et description) et chaque note entrent en ticket, ref = n° du ticket", () => {
    const n = T.ouvrirTicket(t, { type: "bug", titre: "menu cassé", description: "le menu ne s'ouvre plus", auteur: "Bernard" });
    T.majTicket(t, n, "Bernard", { note: "vu sur mobile aussi" });
    const tickets = index().filter((l) => l.type === "ticket");
    expect(tickets.length).toBeGreaterThanOrEqual(2);
    expect(tickets[0]).toMatchObject({ texte: "menu cassé\nle menu ne s'ouvre plus", ref: n, auteur: "Bernard" });
    expect(tickets.at(-1)).toMatchObject({ texte: "vu sur mobile aussi", ref: n, auteur: "Bernard" });
    expect(tickets.every((l) => l.ref === n)).toBe(true);
  });
});

describe("2.2 noterFait et citer", () => {
  test("rend l'identifiant, écrit chaque colonne, date ISO", () => {
    const id = t.transaction(() => T.noterFait(t, { type: "verification", agent: "Bernard", source: "page_voir", sujet: "index.html", statut: "verifie",
      texte: "vérifié · page_voir index.html · page saine (0) · Bernard", messageId: 12, details: { code: 0 } }));
    expect(id).toBe(1);
    const r = t.get<Record<string, unknown>>("SELECT * FROM faits WHERE id = ?", [id])!;
    expect(r).toMatchObject({ type: "verification", agent: "Bernard", source: "page_voir", sujet: "index.html", statut: "verifie",
      texte: "vérifié · page_voir index.html · page saine (0) · Bernard", message_id: 12, details_json: JSON.stringify({ code: 0 }) });
    expect(String(r.cree_le)).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(t.transaction(() => T.noterFait(t, fait()))).toBe(2);
    const sansDetails = t.get<Record<string, unknown>>("SELECT sujet, statut, message_id, details_json FROM faits WHERE id = 2")!;
    expect(sansDetails).toEqual({ sujet: null, statut: null, message_id: null, details_json: null });
  });

  test("dans une transaction qui échoue ensuite, aucune ligne ne reste (ni fait ni index)", () => {
    expect(() => t.transaction(() => {
      T.noterFait(t, fait());
      throw new Error("échec après le fait");
    })).toThrow("échec après le fait");
    expect(t.get<{ n: number }>("SELECT COUNT(*) AS n FROM faits")!.n).toBe(0);
    expect(index().length).toBe(0);
    expect(t.transaction(() => T.noterFait(t, fait()))).toBe(1); // l'identifiant n'a pas été consommé
  });

  test("{FAIT} dans le texte est remplacé par l'identifiant du fait lui-même", () => {
    t.transaction(() => T.noterFait(t, fait()));
    const id = t.transaction(() => T.noterFait(t, fait({ texte: 'raison : « … (suite : salle_chercher(type: "fait", numero: {FAIT})) »' })));
    expect(id).toBe(2);
    expect(t.get<{ texte: string }>("SELECT texte FROM faits WHERE id = 2")!.texte).toBe('raison : « … (suite : salle_chercher(type: "fait", numero: 2)) »');
  });

  test("sur une base sans table faits (ancien run), ne fait rien et rend 0", () => {
    const ancien = ouvrirBun(join(dossier, "ancien.sqlite"));
    ancien.exec("CREATE TABLE messages(id INTEGER PRIMARY KEY)");
    expect(ancien.transaction(() => T.noterFait(ancien, fait()))).toBe(0);
    expect(T.aTable(ancien, "faits")).toBe(false);
    ancien.fermer();
  });

  test("citer : entière jusqu'à 300 caractères, coupée au-delà avec la suite exacte, par message ou par fait", () => {
    const c300 = "é".repeat(300);
    expect(T.citer(c300, { message: 88 })).toEqual({ texte: c300, entiere: true });
    expect(T.citer("court", {})).toEqual({ texte: "court", entiere: true });
    const c301 = "a".repeat(299) + "😀b"; // 301 caractères : l'émoji n'est pas coupé en deux
    expect(T.citer(c301, { message: 88 })).toEqual({ texte: "a".repeat(299) + "😀… (suite : salle_chercher(numero: 88))", entiere: false });
    expect(T.citer(c301, {})).toEqual({ texte: "a".repeat(299) + '😀… (suite : salle_chercher(type: "fait", numero: {FAIT}))', entiere: false });
  });

  test("CD_EN_TETE et BUN_TEST sont exportés, inchangés", () => {
    expect(T.CD_EN_TETE.test("cd ~/partage && bun test")).toBe(true);
    expect(T.CD_EN_TETE.test("bun test")).toBe(false);
    expect(T.BUN_TEST.test("cd x && bun  test a.test.js")).toBe(true);
    expect(T.BUN_TEST.test("bun run test")).toBe(false);
  });
});

// ---- Les faits du tableau --------------------------------------------------------------------------
type FaitLu = { id: number; type: string; agent: string; source: string; sujet: string | null; statut: string | null; texte: string; message_id: number | null; details_json: string | null };
const faits = (tb = t) => tb.all<FaitLu>("SELECT id, type, agent, source, sujet, statut, texte, message_id, details_json FROM faits ORDER BY id");
const textes = (tb = t) => faits(tb).map((f) => f.texte);

describe("3.1 les fonctions sans transaction écrivent leur fait si la ligne a changé", () => {
  beforeEach(() => {
    for (const n of ["Edmond", "Antoine", "Bernard"]) T.ajouterAgent(t, n, `/b/${n}`);
  });

  test("endormir puis reveiller : en veille, réveillé ; un second appel ne change rien et n'écrit rien ; retours inchangés", () => {
    expect(T.endormir(t, "Edmond")).toBe(1);
    expect(T.endormir(t, "Edmond")).toBe(0); // déjà dormant
    T.reveiller(t, "Edmond");
    T.reveiller(t, "Edmond"); // déjà actif
    expect(faits()).toMatchObject([
      { type: "agent", agent: "Edmond", source: "tableau", texte: "Edmond · en veille", statut: null },
      { type: "agent", agent: "Edmond", source: "tableau", texte: "Edmond · réveillé" },
    ]);
    expect(faits().length).toBe(2);
  });

  test("fini (extension) puis sortirAgent(fini) (lanceur) : un seul départ, raison citée comme déclarée", () => {
    expect(T.fini(t, "Edmond", "page juste 23/23")).toEqual({ ok: true });
    expect(T.sortirAgent(t, "Edmond", "fini", "page juste 23/23")).toBe(false);
    expect(faits()).toMatchObject([{ type: "agent", agent: "Edmond", source: "tableau", texte: "Edmond · fini · raison déclarée par Edmond : « page juste 23/23 »", details_json: null }]);
  });

  test("fini avec une raison de plus de 300 caractères : coupée sur la suite par fait, entière dans details", () => {
    const longue = "x".repeat(320);
    T.fini(t, "Edmond", longue);
    const [f] = faits();
    expect(f!.texte).toBe(`Edmond · fini · raison déclarée par Edmond : « ${"x".repeat(300)}… (suite : salle_chercher(type: "fait", numero: ${f!.id})) »`);
    expect(JSON.parse(f!.details_json!)).toEqual({ citation: longue });
  });

  test("sortirAgent : viré et perdu, la raison écrite par la salle ; un second départ n'écrit rien", () => {
    expect(T.sortirAgent(t, "Antoine", "vire", "silence de 20 min")).toBe(true);
    expect(T.sortirAgent(t, "Antoine", "perdu", "encore")).toBe(false);
    T.endormir(t, "Bernard");
    expect(T.sortirAgent(t, "Bernard", "perdu", "code de sortie 1")).toBe(true); // un dormeur se sort comme un actif
    expect(T.sortirAgent(t, "Edmond", "fini", "salle endormie : personne ne l'a rappelé")).toBe(true);
    expect(textes()).toEqual(["Antoine · viré · raison : silence de 20 min", "Bernard · en veille", "Bernard · perdu · raison : code de sortie 1",
      "Edmond · fini · raison : salle endormie : personne ne l'a rappelé"]);
  });

  test("liberer : pancarte retirée seulement si la pancarte était à lui et ouverte", () => {
    T.reclamer(t, "Antoine", "app.js", "refonte du menu");
    expect(T.liberer(t, "Bernard", "app.js")).toEqual({ ok: false });
    expect(T.liberer(t, "Antoine", "./app.js")).toEqual({ ok: true });
    expect(T.liberer(t, "Antoine", "app.js")).toEqual({ ok: false });
    const retirees = faits().filter((f) => f.texte.startsWith("pancarte retirée"));
    expect(retirees).toMatchObject([{ type: "pancarte", agent: "Antoine", source: "tableau", sujet: "app.js", texte: "pancarte retirée · app.js · Antoine" }]);
    expect(retirees.length).toBe(1);
  });

  test("retirerPancartes : un fait par pancarte retirée, chaque fichier nommé ; rien quand il n'y en a pas ; rend le nombre", () => {
    T.reclamer(t, "Antoine", "app.js", "menu");
    T.reclamer(t, "Antoine", "css/style.css", "couleurs");
    T.reclamer(t, "Bernard", "index.html", "titre");
    T.liberer(t, "Antoine", "app.js");
    const avant = faits().length;
    expect(T.retirerPancartes(t, "Antoine")).toBe(1);
    expect(T.retirerPancartes(t, "Antoine")).toBe(0);
    expect(faits().slice(avant)).toMatchObject([{ type: "pancarte", agent: "Antoine", sujet: "css/style.css", texte: "pancarte retirée · css/style.css · Antoine" }]);
    expect(faits().length).toBe(avant + 1);
  });

  test("le fait est dans la transaction qui change l'état : une transaction englobante annulée n'en laisse aucun", () => {
    T.reclamer(t, "Antoine", "app.js", "menu");
    const avant = faits().length;
    expect(() => t.transaction(() => {
      T.endormir(t, "Edmond");
      T.sortirAgent(t, "Antoine", "perdu", "x");
      T.retirerPancartes(t, "Antoine");
      throw new Error("annulée");
    })).toThrow("annulée");
    expect(faits().length).toBe(avant);
    expect(t.get<{ etat: string }>("SELECT etat FROM agents WHERE nom = 'Edmond'")!.etat).toBe("actif");
    expect(T.reclamations(t).length).toBe(1);
  });

  test("sur une base sans table faits (ancien run), les fonctions marchent comme avant", () => {
    const ancien = ouvrirBun(join(dossier, "ancien.sqlite"));
    ancien.exec(T.SCHEMA.slice(0, T.SCHEMA.indexOf("-- Second cerveau")));
    T.ajouterAgent(ancien, "Edmond", "/b");
    expect(T.endormir(ancien, "Edmond")).toBe(1);
    T.reveiller(ancien, "Edmond");
    expect(T.reclamer(ancien, "Edmond", "a.js", "r")).toEqual({ ok: true });
    expect(T.retirerPancartes(ancien, "Edmond")).toBe(1);
    expect(T.sortirAgent(ancien, "Edmond", "perdu", "x")).toBe(true);
    expect(T.aTable(ancien, "faits")).toBe(false);
    ancien.fermer();
  });
});

describe("3.2 fils ouverts et fermés, pancartes posées", () => {
  beforeEach(() => {
    for (const n of ["Denis", "Antoine", "Bernard"]) T.ajouterAgent(t, n, `/b/${n}`);
    for (const n of ["Denis", "Antoine", "Bernard"]) T.poster(t, n, "bonjour"); // entrer exige un premier message
  });
  const annonce = (texte: string) => t.get<{ id: number }>("SELECT id FROM messages WHERE auteur = 'salle' AND texte = ?", [texte])!.id;
  const deFil = () => faits().filter((f) => f.type === "fil");

  test("entrer qui ouvre : pourquoi déclaré, msg N = l'annonce ; entrer dans un fil déjà ouvert n'écrit rien", () => {
    T.entrer(t, "Denis", "q-horaires", "les horaires");
    T.entrer(t, "Antoine", "q-horaires");
    const n = annonce("Denis ouvre q-horaires : les horaires");
    expect(deFil()).toMatchObject([{ type: "fil", agent: "Denis", source: "tableau", sujet: "q-horaires", message_id: n,
      texte: `q-horaires ouvert · pourquoi déclaré par Denis, msg ${n} : « les horaires »` }]);
    expect(deFil().length).toBe(1);
  });

  test("quitter du dernier : conclusion déclarée, msg N = l'annonce de fermeture ; quitter d'un autre n'écrit rien", () => {
    T.entrer(t, "Denis", "q-horaires", "les horaires");
    T.entrer(t, "Antoine", "q-horaires");
    T.quitter(t, "Antoine");
    T.quitter(t, "Denis", "attente 53 min, pas 45");
    const n = annonce("q-horaires fermé : attente 53 min, pas 45");
    expect(deFil().slice(1)).toMatchObject([{ type: "fil", agent: "Denis", sujet: "q-horaires", message_id: n,
      texte: `q-horaires fermé · conclusion déclarée par Denis, msg ${n} : « attente 53 min, pas 45 »` }]);
    expect(deFil().length).toBe(2);
  });

  test("une conclusion longue est coupée sur la suite par message, entière dans details", () => {
    const longue = "c".repeat(310);
    T.entrer(t, "Denis", "q-long", "p");
    T.quitter(t, "Denis", longue);
    const f = deFil().at(-1)!;
    expect(f.texte).toBe(`q-long fermé · conclusion déclarée par Denis, msg ${f.message_id} : « ${"c".repeat(300)}… (suite : salle_chercher(numero: ${f.message_id})) »`);
    expect(JSON.parse(f.details_json!)).toEqual({ citation: longue });
  });

  test("sortie forcée du dernier vivant (sortirDuFil) et fin du run (fermerFils) : fermé sans conclusion, constaté", () => {
    T.entrer(t, "Denis", "q-a", "a");
    T.entrer(t, "Bernard", "q-b", "b");
    T.sortirAgent(t, "Denis", "perdu", "code de sortie 1");
    T.sortirDuFil(t, "Denis", "perdu : code de sortie 1");
    T.fermerFils(t, "fin du run");
    const [, , a, b] = deFil();
    expect(a).toMatchObject({ agent: "Denis", sujet: "q-a", message_id: annonce("q-a fermé sans conclusion (perdu : code de sortie 1)"),
      texte: "q-a fermé sans conclusion (perdu : code de sortie 1)" });
    expect(b).toMatchObject({ agent: "salle", sujet: "q-b", texte: "q-b fermé sans conclusion (fin du run)" });
    expect(deFil().length).toBe(4);
  });

  test("reclamer réussi : pancarte posée, raison citée ; les refus (déjà posée, par soi ou un autre ; hors du dossier) n'écrivent rien", () => {
    expect(T.reclamer(t, "Antoine", "./app.js", "refonte du menu")).toEqual({ ok: true });
    expect(T.reclamer(t, "Antoine", "app.js", "encore")).toMatchObject({ ok: false, occupe_par: "Antoine" });
    expect(T.reclamer(t, "Bernard", "app.js", "moi aussi")).toMatchObject({ ok: false, occupe_par: "Antoine" });
    expect(T.reclamer(t, "Bernard", "../dehors.js", "x")).toMatchObject({ ok: false });
    expect(faits().filter((f) => f.type === "pancarte")).toMatchObject([{ agent: "Antoine", source: "tableau", sujet: "app.js",
      texte: "pancarte · app.js · Antoine · « refonte du menu »" }]);
    expect(faits().length).toBe(1);
  });
});

describe("3.3 tickets : annonce, note et fait dans une transaction (R7)", () => {
  beforeEach(() => {
    for (const n of ["Bernard", "Claude"]) T.ajouterAgent(t, n, `/b/${n}`);
  });
  const deTicket = () => faits().filter((f) => f.type === "ticket");
  const annonces = () => t.all<{ id: number; auteur: string; texte: string }>("SELECT m.id, m.auteur, m.texte FROM messages m JOIN fils f ON f.id = m.fil_id WHERE f.nom = 'tickets' ORDER BY m.id");
  const ouvrir = (o: Partial<Parameters<typeof T.ouvrirTicket>[1]> = {}) =>
    T.ouvrirTicket(t, { type: "bug", titre: "menu cassé", description: "le menu ne s'ouvre plus", auteur: "Bernard", charge: "Claude",
      annonce: (id) => `[ticket #${id} · bug] menu cassé — confié à Claude : le menu ne s'ouvre plus`, ...o });
  const annonceMaj = (k: T.Ticket, quoi: string) => `[ticket #${k.id}] ${k.titre} : ${quoi}`;

  test("ouvrirTicket : ticket, note, annonce dans le fil tickets et fait ; le fait cite le numéro de l'annonce", () => {
    const id = ouvrir();
    const [a] = annonces();
    expect(a).toMatchObject({ auteur: "Bernard", texte: `[ticket #${id} · bug] menu cassé — confié à Claude : le menu ne s'ouvre plus` });
    expect(deTicket()).toMatchObject([{ type: "ticket", agent: "Bernard", source: "tableau", sujet: `#${id}`, message_id: a!.id,
      texte: `ticket #${id} ouvert · bug · confié à Claude · « menu cassé » déclaré par Bernard, msg ${a!.id}` }]);
    expect(T.lireTicket(t, id)!.notes.map((n) => n.texte)).toEqual(["ouvert, confié à Claude"]);
  });

  test("une annonce qui échoue n'en laisse rien : ni ticket, ni note, ni message, ni fait", () => {
    expect(() => ouvrir({ annonce: () => { throw new Error("annonce impossible"); } })).toThrow("annonce impossible");
    for (const table of ["tickets", "ticket_notes", "faits"]) expect(t.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)!.n).toBe(0);
    expect(annonces()).toEqual([]);
    const id = ouvrir();
    expect(() => T.majTicket(t, id, "Claude", { etat: "en_cours" }, () => { throw new Error("non"); })).toThrow("non");
    expect(T.lireTicket(t, id)!.etat).toBe("ouvert");
    expect(T.lireTicket(t, id)!.notes.length).toBe(1);
  });

  test("fermeture d'un bug : commit constaté dans le dossier commun, note citée comme déclarée, msg = l'annonce", () => {
    const id = ouvrir();
    expect(T.majTicket(t, id, "Claude", { etat: "ferme", commit: "9c1e2aa0f00", note: "corrigé" }, annonceMaj)).toEqual({ ok: true });
    const a = annonces().at(-1)!;
    expect(a).toMatchObject({ auteur: "Claude", texte: `[ticket #${id}] menu cassé : fermé par le commit 9c1e2aa ; corrigé` });
    expect(deTicket().at(-1)).toMatchObject({ agent: "Claude", sujet: `#${id}`, message_id: a.id,
      texte: `ticket #${id} fermé · commit 9c1e2aa constaté dans le dossier commun · « corrigé » déclaré par Claude, msg ${a.id}` });
  });

  test("fermeture sans note, question fermée sur sa réponse, confié à un autre ; en cours, rouvert et note seule sans fait", () => {
    const id = ouvrir({ charge: undefined });
    T.majTicket(t, id, "Bernard", { etat: "en_cours" }, annonceMaj);
    T.majTicket(t, id, "Bernard", { note: "vu sur mobile" }, annonceMaj);
    T.majTicket(t, id, "Bernard", { charge: "Claude", note: "à toi" }, annonceMaj);
    const confie = annonces().at(-1)!.id;
    T.majTicket(t, id, "Claude", { etat: "ferme", commit: "abcdef1234" }, annonceMaj);
    const ferme = annonces().at(-1)!.id;
    T.majTicket(t, id, "Bernard", { etat: "ouvert" }, annonceMaj);
    const q = ouvrir({ type: "question", titre: "quel moteur ?", charge: undefined, annonce: (n) => `[ticket #${n} · question] quel moteur ?` });
    T.majTicket(t, q, "Claude", { etat: "ferme", reponse: "three : plus léger" }, annonceMaj);
    const reponse = annonces().at(-1)!.id;
    expect(deTicket().map((f) => f.texte)).toEqual([
      `ticket #${id} ouvert · bug · « menu cassé » déclaré par Bernard, msg ${annonces()[0]!.id}`,
      `ticket #${id} confié à Claude · « à toi » déclaré par Bernard, msg ${confie}`,
      `ticket #${id} fermé · commit abcdef1 constaté dans le dossier commun · par Claude, msg ${ferme}`,
      `ticket #${q} ouvert · question · « quel moteur ? » déclaré par Bernard, msg ${annonces().find((m) => m.texte.startsWith(`[ticket #${q} ·`))!.id}`,
      `ticket #${q} fermé · réponse « three : plus léger » déclarée par Claude, msg ${reponse}`,
    ]);
  });

  test("sans gabarit d'annonce (tableau seul) : aucun message, le fait cite sans numéro", () => {
    const id = T.ouvrirTicket(t, { type: "bug", titre: "x", description: "y", auteur: "Bernard" });
    T.majTicket(t, id, "Claude", { etat: "ferme", commit: "1234567abc", note: "fait" });
    expect(annonces()).toEqual([]);
    expect(deTicket().map((f) => [f.texte, f.message_id])).toEqual([
      [`ticket #${id} ouvert · bug · « x » déclaré par Bernard`, null],
      [`ticket #${id} fermé · commit 1234567 constaté dans le dossier commun · « fait » déclaré par Claude`, null],
    ]);
  });

  test("majTicket lit le ticket dans sa transaction ; ses refus gardent leurs textes et n'écrivent rien", () => {
    const id = ouvrir();
    const avant = faits().length;
    expect(T.majTicket(t, 99, "A", { etat: "en_cours" }, annonceMaj)).toEqual({ ok: false, raison: "aucun ticket #99. Définitif pour ce numéro" });
    expect(T.majTicket(t, id, "Claude", { etat: "ferme" }, annonceMaj)).toEqual({ ok: false, raison: "un bug ne se ferme pas sans commit. Se lève avec le commit qui corrige" });
    expect(T.majTicket(t, id, "Claude", { etat: "ouvert" }, annonceMaj)).toEqual({ ok: false, raison: `rien à changer sur le ticket #${id}. Se lève avec un état, un chargé ou une note qui diffère` });
    expect(faits().length).toBe(avant);
    expect(annonces().length).toBe(1);
  });
});

describe("3.4 sous Node (M13) : les quatre fonctions appelées par l'extension écrivent leur fait", () => {
  test("endormir, reclamer, liberer, fini, par les outils de l'extension sous node:sqlite ; stderr vide", () => {
    const aide = new URL("./aide/memoire-node.ts", import.meta.url).pathname;
    const base = join(dossier, "node.sqlite");
    const r = Bun.spawnSync(["node", "--no-warnings", "--experimental-strip-types", aide, base, "3"], { env: { ...process.env, ESSAIM_TEST: "1", ESSAIM_TOUR_MS: "0" } });
    expect(r.stderr.toString()).toBe("");
    const sortie = JSON.parse(r.stdout.toString());
    expect(sortie.phase3.faits).toEqual([
      "pancarte · app.js · agent-01 · « le menu »",
      "pancarte retirée · app.js · agent-01",
      "agent-01 · en veille",
      "agent-01 · réveillé",
      "agent-01 · fini · raison déclarée par agent-01 : « fait »",
    ]);
    const b = ouvrirBun(base);
    expect(b.all<{ texte: string }>("SELECT texte FROM faits ORDER BY id").map((f) => f.texte)).toEqual(sortie.phase3.faits); // Bun relit ce que Node a écrit
    b.fermer();
  });
});

describe("3.5 D4 : les gabarits des faits du tableau ne disent ni quand ni comment faire (M12)", () => {
  test("chaque ligne écrite par le tableau, citations retirées, sans mot interdit", () => {
    for (const n of ["Denis", "Antoine"]) { T.ajouterAgent(t, n, `/b/${n}`); T.poster(t, n, "bonjour"); }
    T.reclamer(t, "Antoine", "app.js", "r");
    T.liberer(t, "Antoine", "app.js");
    T.reclamer(t, "Antoine", "b.js", "r");
    T.endormir(t, "Antoine");
    T.reveiller(t, "Antoine");
    T.entrer(t, "Denis", "q-a", "p");
    T.quitter(t, "Denis", "c");
    T.entrer(t, "Denis", "q-b", "p");
    const k = T.ouvrirTicket(t, { type: "bug", titre: "x", description: "y", auteur: "Denis", charge: "Antoine", annonce: () => "a" });
    T.majTicket(t, k, "Denis", { charge: "Denis" }, () => "a");
    T.majTicket(t, k, "Denis", { etat: "ferme", commit: "1234567" }, () => "a");
    const q = T.ouvrirTicket(t, { type: "question", titre: "x", description: "y", auteur: "Denis" });
    T.majTicket(t, q, "Denis", { etat: "ferme", reponse: "z" });
    T.fini(t, "Denis", "r");
    T.sortirAgent(t, "Antoine", "vire", "silence");
    T.retirerPancartes(t, "Antoine");
    T.fermerFils(t, "fin du run");
    const lignes = textes().map((l) => l.replace(/« [^»]* »/g, "«»"));
    expect(new Set(faits().map((f) => f.type))).toEqual(new Set(["agent", "fil", "ticket", "pancarte"]));
    for (const l of lignes) expect(motsInterdits(l)).toEqual([]);
  });
});
