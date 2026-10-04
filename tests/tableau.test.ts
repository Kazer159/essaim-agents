import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ouvrirBun } from "../src/tableau-bun.ts";
import { initialiser, type Tableau } from "../src/tableau.ts";
import * as T from "../src/tableau.ts";

let dossier: string;
let chemin: string;
let t: Tableau;

beforeEach(() => {
  dossier = mkdtempSync(join(tmpdir(), "essaim-tableau-"));
  chemin = join(dossier, "tableau.sqlite");
  t = ouvrirBun(chemin);
  initialiser(t);
});
afterEach(() => {
  t.fermer();
  rmSync(dossier, { recursive: true, force: true });
});

describe("schéma", () => {
  test("le schéma crée les tables et le fil principal", () => {
    const noms = t.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name);
    for (const n of ["run", "agents", "fils", "messages", "lectures", "reclamations", "evenements"]) expect(noms).toContain(n);
    expect(t.get<{ nom: string }>("SELECT nom FROM fils WHERE id=1")?.nom).toBe("principal");
    expect(t.get<{ journal_mode: string }>("PRAGMA journal_mode")?.journal_mode).toBe("wal");
  });
  test("fils de concentration (26/09) : une base neuve a presences, lots et appels_livres ; un lot n'a qu'une ligne par début", () => {
    const noms = t.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name);
    for (const n of ["presences", "lots", "appels_livres"]) expect(noms).toContain(n);
    expect(t.get("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'ix_lots_etat'")).toBeDefined();
    const lot = "INSERT INTO lots(fil_id, debut_id, fin_id, demande_par, cree_le) VALUES (1, 10, 20, 'Bernard', '2026-09-26T00:00:00Z')";
    t.run(lot);
    expect(() => t.run(lot)).toThrow(/UNIQUE/);
    expect(t.run(lot.replace("INSERT", "INSERT OR IGNORE")).changes).toBe(0);
    expect(t.get<{ etat: string; essais: number }>("SELECT etat, essais FROM lots")).toEqual({ etat: "attente", essais: 0 });
  });
  test("initialiser ajoute à un tableau d'avant les fils ses colonnes nouvelles, et se relance sans planter", () => {
    const ancien = ouvrirBun(join(dossier, "ancien.sqlite"));
    // fils et messages tels que dans le SCHEMA de main avant les fils de concentration
    ancien.exec(`CREATE TABLE fils(id INTEGER PRIMARY KEY, nom TEXT UNIQUE NOT NULL, cree_par TEXT, cree_le TEXT);
      CREATE TABLE messages(id INTEGER PRIMARY KEY, fil_id INTEGER NOT NULL REFERENCES fils(id),
        auteur TEXT NOT NULL, cree_le TEXT NOT NULL, texte TEXT NOT NULL);
      INSERT INTO fils(id, nom) VALUES (1, 'principal');
      INSERT INTO messages(fil_id, auteur, cree_le, texte) VALUES (1, 'Bernard', '2026-09-25T00:00:00Z', 'ancien');`);
    expect(T.aColonne(ancien, "fils", "pourquoi")).toBe(false);
    expect(T.aTable(ancien, "presences")).toBe(false);
    initialiser(ancien);
    for (const c of ["pourquoi", "conclusion", "ouvert_le", "ferme_le"]) expect(T.aColonne(ancien, "fils", c)).toBe(true);
    for (const c of ["hors_fil", "sommeil"]) expect(T.aColonne(ancien, "messages", c)).toBe(true);
    expect(T.aTable(ancien, "presences")).toBe(true);
    expect(ancien.get("SELECT hors_fil, sommeil FROM messages")).toEqual({ hors_fil: 0, sommeil: 0 });
    expect(() => initialiser(ancien)).not.toThrow();
    ancien.fermer();
  });
});

// Rôles des agents : le siège de chaque agent en base, NULL pour un run sans rôles ; migration douce.
describe("rôles des agents : agents.role et agents.suppleant_de", () => {
  test("ajouterAgent les écrit avec un siège ; sans siège, NULL comme avant", () => {
    T.ajouterAgent(t, "Antoine", "/b/Antoine", "a/h", "hommes", { role: "integrateur" });
    T.ajouterAgent(t, "Bernard", "/b/Bernard", "a/h", "hommes", { role: "constructeur", suppleantDe: "integrateur" });
    T.ajouterAgent(t, "Claude", "/b/Claude");
    expect(t.all("SELECT nom, role, suppleant_de FROM agents ORDER BY rowid")).toEqual([
      { nom: "Antoine", role: "integrateur", suppleant_de: null }, { nom: "Bernard", role: "constructeur", suppleant_de: "integrateur" },
      { nom: "Claude", role: null, suppleant_de: null }]);
  });
  test("une base d'avant gagne les deux colonnes à l'initialisation, sans rien perdre", () => {
    const ancien = ouvrirBun(join(dossier, "ancien-roles.sqlite"));
    ancien.exec("CREATE TABLE agents(nom TEXT PRIMARY KEY, bureau TEXT); INSERT INTO agents VALUES ('Antoine', '/b');");
    expect(T.aColonne(ancien, "agents", "role")).toBe(false);
    initialiser(ancien);
    for (const c of ["role", "suppleant_de"]) expect(T.aColonne(ancien, "agents", c)).toBe(true);
    expect(ancien.get("SELECT nom, role, suppleant_de FROM agents")).toEqual({ nom: "Antoine", role: null, suppleant_de: null });
    ancien.fermer();
  });
});

describe("WAL à deux connexions", () => {
  const racine = new URL("..", import.meta.url).pathname;
  test("une connexion Node lit ce qu'une connexion Bun écrit", () => {
    t.run("INSERT INTO messages(fil_id, auteur, cree_le, texte) VALUES (1, 'agent-01', '2026-09-21T00:00:00Z', 'bonjour')");
    const r = Bun.spawnSync(["node", "--no-warnings", "-e",
      "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);console.log(d.prepare('SELECT count(*) AS n FROM messages').get().n)", chemin]);
    expect(r.stdout.toString().trim()).toBe("1");
  });
  test("une connexion Bun lit ce qu'une connexion Node écrit", () => {
    const r = Bun.spawnSync(["node", "--no-warnings", "--experimental-strip-types", join(racine, "tests/aide/ecrire-node.ts"), chemin]);
    expect(r.stderr.toString()).toBe("");
    expect(r.stdout.toString().trim()).toBe("2");
    expect(t.get<{ n: number }>("SELECT count(*) AS n FROM messages")?.n).toBe(2);
  });
});

describe("les entrées du run", () => {
  test("ouvrirRun écrit entrees_json quand il y en a", () => {
    T.ouvrirRun(t, { id: "run-e", missionChemin: "m", missionTexte: "m", modele: "m", plafondUsd: 1, silenceMin: 1, entreesJson: '[{"nom":"doc.md","taille":6,"sha256":"ab"}]' });
    expect(t.get<{ e: string }>("SELECT entrees_json AS e FROM run")?.e).toBe('[{"nom":"doc.md","taille":6,"sha256":"ab"}]');
  });
});

describe("requêtes de la salle", () => {
  const runDefaut = { id: "run-test", missionChemin: "missions/x.md", missionTexte: "texte", modele: "faux/faux", plafondUsd: 0.5, silenceMin: 15 };
  beforeEach(() => {
    T.ouvrirRun(t, runDefaut);
    T.ajouterAgent(t, "agent-01", "/tmp/bureau-01");
    T.ajouterAgent(t, "agent-02", "/tmp/bureau-02");
  });

  test("ouvrirRun écrit la ligne run", () => {
    const r = t.get<Record<string, unknown>>("SELECT * FROM run")!;
    expect(r.id).toBe("run-test");
    expect(r.entrees_json).toBeNull();
    expect(r.plafond_usd).toBe(0.5);
    expect(r.etat).toBe("en_cours");
    expect(typeof r.debut).toBe("string");
  });

  test("ajouterAgent crée un agent actif", () => {
    const a = t.get<Record<string, unknown>>("SELECT * FROM agents WHERE nom='agent-01'")!;
    expect(a.etat).toBe("actif");
    expect(a.bureau).toBe("/tmp/bureau-01");
    expect(a.passes).toBe(1);
  });

  test("poster renvoie un id croissant et crée un fil inconnu", () => {
    expect(T.poster(t, "agent-01", "un")).toBe(1);
    expect(T.poster(t, "agent-01", "deux")).toBe(2);
    expect(T.poster(t, "agent-01", "trois", "design")).toBe(3);
    expect(t.get<{ nom: string; cree_par: string }>("SELECT nom, cree_par FROM fils WHERE id=2")).toEqual({ nom: "design", cree_par: "agent-01" });
  });

  test("insererMessage (S1) : insère sans ouvrir de transaction, crée le fil, marque hors_fil et sommeil", () => {
    let transactions = 0;
    const compte: Tableau = { ...t, transaction: (fn) => { transactions++; return t.transaction(fn); } };
    expect(T.insererMessage(compte, "agent-01", "un", "q-neige")).toBe(1);
    expect(T.insererMessage(compte, "agent-02", "de dehors", "q-neige", { horsFil: true })).toBe(2);
    expect(T.insererMessage(compte, "agent-01", "[en sommeil] je dors", "q-neige", { sommeil: true })).toBe(3);
    expect(transactions).toBe(0);
    expect(t.all("SELECT f.nom AS fil, m.hors_fil, m.sommeil FROM messages m JOIN fils f ON f.id = m.fil_id ORDER BY m.id")).toEqual([
      { fil: "q-neige", hors_fil: 0, sommeil: 0 }, { fil: "q-neige", hors_fil: 1, sommeil: 0 }, { fil: "q-neige", hors_fil: 0, sommeil: 1 },
    ]);
    // dans une transaction de l'appelant, comme entrer et quitter le feront avec leurs annonces
    expect(t.transaction(() => T.insererMessage(t, "salle", "q-neige ouvert", "principal"))).toBe(4);
    expect(T.poster(compte, "agent-01", "par poster")).toBe(5);
    expect(transactions).toBe(1);
  });

  test("boite ne renvoie que les nouveaux messages et avance le curseur", () => {
    T.poster(t, "agent-02", "a");
    T.poster(t, "agent-02", "b");
    const b1 = T.boite(t, "agent-01");
    expect(b1.messages.map((m) => m.texte)).toEqual(["a", "b"]);
    expect(b1.messages[0]!.fil).toBe("principal");
    expect(b1.reste).toBe(false);
    expect(T.boite(t, "agent-01").messages).toEqual([]);
    T.poster(t, "agent-02", "c");
    expect(T.boite(t, "agent-01").messages.map((m) => m.texte)).toEqual(["c"]);
  });

  test("boite plafonne à la limite, signale le reste et n'avance que jusqu'au dernier renvoyé", () => {
    for (let i = 1; i <= 60; i++) T.poster(t, "agent-02", `m${i}`);
    const b1 = T.boite(t, "agent-01");
    expect(b1.messages.length).toBe(50);
    expect(b1.reste).toBe(true);
    const b2 = T.boite(t, "agent-01");
    expect(b2.messages.map((m) => m.texte)).toEqual(Array.from({ length: 10 }, (_, i) => `m${51 + i}`));
    expect(b2.reste).toBe(false);
    const b3 = T.boite(t, "agent-01", undefined, 5);
    expect(b3.messages).toEqual([]);
  });

  test("boite sans fil lit tous les fils, avec fil un seul", () => {
    T.poster(t, "agent-02", "p", "principal");
    T.poster(t, "agent-02", "d", "design");
    expect(T.boite(t, "agent-01", "design").messages.map((m) => m.texte)).toEqual(["d"]);
    expect(T.boite(t, "agent-01").messages.map((m) => m.texte)).toEqual(["p"]);
  });

  test("equipe et surnom", () => {
    T.surnom(t, "agent-01", "Pélican");
    const e = T.equipe(t);
    expect(e.map((a) => a.nom)).toEqual(["agent-01", "agent-02"]);
    expect(e[0]).toEqual({ nom: "agent-01", surnom: "Pélican", etat: "actif", derniere_activite: null });
  });

  test("normaliserChemin confine à partage/", () => {
    expect(T.normaliserChemin("pelican.svg")).toBe("pelican.svg");
    expect(T.normaliserChemin("./a/../b/c.md")).toBe("b/c.md");
    expect(T.normaliserChemin("")).toBeUndefined();
    expect(T.normaliserChemin("../x")).toBeUndefined();
    expect(T.normaliserChemin("a/../../x")).toBeUndefined();
    expect(T.normaliserChemin("/tmp/x")).toBeUndefined();
  });

  test("une pancarte vaut pour le fichier, pas pour sa casse ni sa forme Unicode : le disque du Mac les confond (29/09, revue T1)", () => {
    expect(T.reclamer(t, "Antoine", "src/solveur.ts", "ma part")).toEqual({ ok: true });
    expect(T.reclamer(t, "Bernard", "src/Solveur.ts", "la mienne")).toMatchObject({ ok: false, occupe_par: "Antoine" });
    expect(T.reclamer(t, "Antoine", "cafe\u0301.ts", "nfd")).toEqual({ ok: true });
    expect(T.reclamer(t, "Bernard", "caf\u00e9.ts", "nfc")).toMatchObject({ ok: false, occupe_par: "Antoine" });
  });
  test("le porteur libère entre l'échec et la relecture : « réessaie », pas un refus vide (29/09, revue T4)", () => {
    expect(T.reclamer(t, "Antoine", "x.js", "a")).toEqual({ ok: true });
    // La relecture du porteur ne trouve plus rien : il a libéré dans cet intervalle, sur une autre connexion.
    const entre = new Proxy(t, { get(o, k) {
      if (k === "get") return (sql: string, a?: unknown[]) => (/FROM reclamations WHERE chemin/.test(sql) ? undefined : o.get(sql, a as never));
      const v = (o as unknown as Record<string | symbol, unknown>)[k];
      return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(o) : v;
    } });
    expect(T.reclamer(entre, "Bernard", "x.js", "b")).toEqual({ ok: false, reessayer: true });
  });
  test("reclamer, doublon, liberer, hors périmètre", () => {
    expect(T.reclamer(t, "agent-01", "pelican.svg", "brouillon")).toEqual({ ok: true });
    const r = T.reclamer(t, "agent-02", "./pelican.svg", "moi aussi");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.occupe_par).toBe("agent-01");
      expect(typeof r.depuis).toBe("string");
    }
    expect(T.reclamer(t, "agent-01", "../x", "r")).toEqual({ ok: false, raison: "../x est hors du dossier partagé. Définitif pour ce chemin" });
    expect(T.reclamer(t, "agent-01", "/tmp/x", "r")).toEqual({ ok: false, raison: "/tmp/x est hors du dossier partagé. Définitif pour ce chemin" });
    expect(T.reclamations(t).map((p) => [p.chemin, p.agent, p.raison])).toEqual([["pelican.svg", "agent-01", "brouillon"]]);
    expect(T.liberer(t, "agent-02", "pelican.svg")).toEqual({ ok: false });
    expect(T.liberer(t, "agent-01", "pelican.svg")).toEqual({ ok: true });
    expect(T.reclamations(t)).toEqual([]);
    expect(T.reclamer(t, "agent-02", "pelican.svg", "à moi")).toEqual({ ok: true });
  });

  test("budget", () => {
    T.majAgent(t, "agent-01", { coutUsd: 0.12 });
    T.majAgent(t, "agent-02", { coutUsd: 0.08 });
    expect(T.budget(t)).toEqual({ depense: 0.2, plafond: 0.5, reste: 0.3 });
  });

  test("fini et sortirAgent respectent les états terminaux", () => {
    T.fini(t, "agent-01", "définition atteinte", "pelican.svg");
    let a = t.get<Record<string, unknown>>("SELECT * FROM agents WHERE nom='agent-01'")!;
    expect([a.etat, a.raison_sortie, a.fichier_livre]).toEqual(["fini", "définition atteinte", "pelican.svg"]);
    expect(T.sortirAgent(t, "agent-01", "vire", "plafond")).toBe(false);
    a = t.get<Record<string, unknown>>("SELECT * FROM agents WHERE nom='agent-01'")!;
    expect(a.etat).toBe("fini");
    expect(T.sortirAgent(t, "agent-02", "perdu", "passes épuisées")).toBe(true);
    expect(T.sortirAgent(t, "agent-02", "vire", "durée")).toBe(false);
    a = t.get<Record<string, unknown>>("SELECT * FROM agents WHERE nom='agent-02'")!;
    expect([a.etat, a.raison_sortie]).toEqual(["perdu", "passes épuisées"]);
  });

  test("ajouterEvenement et majAgent", () => {
    T.ajouterEvenement(t, { agent: "agent-01", type: "tool_execution_end", outil: "poster", appelId: "c1", arguments: { texte: "x" }, resultat: "message 1 posté", dureeMs: 12 });
    const e = t.get<Record<string, unknown>>("SELECT * FROM evenements")!;
    expect([e.agent, e.type, e.outil, e.appel_id, e.arguments_json, e.resultat_resume, e.duree_ms]).toEqual(["agent-01", "tool_execution_end", "poster", "c1", '{"texte":"x"}', "message 1 posté", 12]);
    T.majAgent(t, "agent-01", { pid: 42, coutUsd: 0.01, coutEstime: true, tokensEntree: 100, tokensSortie: 20, appels: 3, echecs: 1, derniereActivite: "2026-09-21T00:00:00Z", passes: 2 });
    const a = t.get<Record<string, unknown>>("SELECT * FROM agents WHERE nom='agent-01'")!;
    expect([a.pid, a.cout_usd, a.cout_estime, a.tokens_entree, a.tokens_sortie, a.appels, a.echecs, a.derniere_activite, a.passes]).toEqual([42, 0.01, 1, 100, 20, 3, 1, "2026-09-21T00:00:00Z", 2]);
  });

  test("retirerPancartes ferme toutes les pancartes d'un agent", () => {
    T.reclamer(t, "agent-01", "a.md", "r");
    T.reclamer(t, "agent-01", "b.md", "r");
    T.reclamer(t, "agent-02", "c.md", "r");
    expect(T.retirerPancartes(t, "agent-01")).toBe(2);
    expect(T.reclamations(t).map((p) => p.chemin)).toEqual(["c.md"]);
  });

  test("clore écrit la fin, l'état et le bilan", () => {
    T.clore(t, { finis: 1, vires: 0 });
    const r = t.get<Record<string, unknown>>("SELECT * FROM run")!;
    expect(r.etat).toBe("termine");
    expect(typeof r.fin).toBe("string");
    expect(JSON.parse(r.bilan_json as string)).toEqual({ finis: 1, vires: 0 });
  });
});

describe("le sommeil", () => {
  beforeEach(() => {
    T.ouvrirRun(t, { id: "r", missionChemin: "m", missionTexte: "t", modele: "faux", plafondUsd: 1, silenceMin: 15 });
    T.ajouterAgent(t, "Antoine", "/b/Antoine");
    T.ajouterAgent(t, "Bernard", "/b/Bernard");
  });

  test("endormir compte les veilles et reveiller fait le retour, sans toucher un agent sorti", () => {
    expect(T.endormir(t, "Antoine")).toBe(1);
    expect(T.equipe(t).find((a) => a.nom === "Antoine")?.etat).toBe("dormant");
    expect(T.endormir(t, "Antoine")).toBe(0); // déjà endormi : rien à compter
    T.reveiller(t, "Antoine");
    expect(T.equipe(t).find((a) => a.nom === "Antoine")?.etat).toBe("actif");
    expect(T.endormir(t, "Antoine")).toBe(2);
    expect(T.sommeils(t, "Antoine")).toBe(2);
    T.sortirAgent(t, "Bernard", "fini", "parti");
    expect(T.endormir(t, "Bernard")).toBe(0); // un agent sorti ne se rendort pas
  });

  test("alias rend le prénom, et le surnom quand il y en a un", () => {
    expect(T.alias(t, "Antoine")).toEqual(["Antoine"]);
    T.surnom(t, "Antoine", "le relecteur");
    expect(T.alias(t, "Antoine")).toEqual(["Antoine", "le relecteur"]);
  });

  test("un dormeur se sort comme un actif : le lanceur peut le fermer", () => {
    T.endormir(t, "Antoine");
    expect(T.sortirAgent(t, "Antoine", "fini", "salle endormie")).toBe(true);
    expect(T.sortirAgent(t, "Antoine", "vire", "trop tard")).toBe(false);
  });

  test("appelNonLu ne retient que les messages non lus, d'un autre, qui nomment l'agent", () => {
    T.poster(t, "Bernard", "on se répartit la page");
    expect(T.appelNonLu(t, "Antoine", ["Antoine"])).toBeUndefined();
    T.poster(t, "Antoine", "Antoine parle de lui-même");
    expect(T.appelNonLu(t, "Antoine", ["Antoine"])).toBeUndefined();
    T.poster(t, "Bernard", "antoine, le bouton Annuler ne restaure rien");
    expect(T.appelNonLu(t, "Antoine", ["Antoine"])).toMatchObject({ auteur: "Bernard", texte: "antoine, le bouton Annuler ne restaure rien" });
    T.boite(t, "Antoine"); // tout lu
    expect(T.appelNonLu(t, "Antoine", ["Antoine"])).toBeUndefined();
  });

  test("le nom entier, pas un morceau, et le surnom réveille aussi", () => {
    T.poster(t, "Bernard", "Antoinette a tout relu");
    expect(T.appelNonLu(t, "Antoine", ["Antoine"])).toBeUndefined();
    expect(T.appelNonLu(t, "Antoine", ["Antoine", "le relecteur"])).toBeUndefined();
    T.poster(t, "Bernard", "merci le relecteur !");
    expect(T.appelNonLu(t, "Antoine", ["Antoine", "le relecteur"])).toMatchObject({ texte: "merci le relecteur !" });
    expect(T.appelNonLu(t, "Antoine", [])).toBeUndefined();
  });

  test("une annonce de la salle n'est pas un appel (S4) ; un appel déjà livré ne réveille plus (W6)", () => {
    T.poster(t, "salle", "Bernard ouvre q-neige : Antoine a cassé la neige", "principal");
    expect(T.appelNonLu(t, "Antoine", ["Antoine"])).toBeUndefined();
    const id = T.poster(t, "Bernard", "Antoine, tu relis ?");
    expect(T.appelNonLu(t, "Antoine", ["Antoine"])?.id).toBe(id);
    t.run("INSERT INTO appels_livres(agent, message_id, livre_le) VALUES ('Antoine', ?, '2026-09-26T00:00:00Z')", [id]);
    expect(T.appelNonLu(t, "Antoine", ["Antoine"])).toBeUndefined();
    expect(T.appelNonLu(t, "Bernard", ["Bernard"])).toBeUndefined(); // livré à Antoine seulement ; Bernard ne s'appelle pas
    T.poster(t, "Bernard", "Antoine, et la page ?");
    expect(T.appelNonLu(t, "Antoine", ["Antoine"])?.texte).toBe("Antoine, et la page ?");
  });

  test("un surnom avec % ou _ ne devient pas un joker", () => {
    T.poster(t, "Bernard", "rendez-vous à midi");
    expect(T.appelNonLu(t, "Antoine", ["%"])).toBeUndefined();
    expect(T.appelNonLu(t, "Antoine", ["_"])).toBeUndefined();
  });
});

// La règle du mot entier sert aussi à la vue Cerveau : nommer quelqu'un, c'est lui parler.
describe("nomme : le mot entier", () => {
  test("le prénom, le surnom, sans la casse ; jamais un morceau de mot", () => {
    expect(T.nomme("Merci Antoine !", "Antoine")).toBe(true);
    expect(T.nomme("Antoinette a raison", "Antoine")).toBe(false);
    expect(T.nomme("bravo ANTOINE", "Antoine")).toBe(true);
    expect(T.nomme("(Antoine)", "Antoine")).toBe(true);
    expect(T.nomme("vu avec Marcel — planificateur ce matin", "Marcel — planificateur")).toBe(true);
    expect(T.nomme("le planificateur", "Marcel — planificateur")).toBe(false);
  });
});

describe("busy_timeout par connexion", () => {
  test("une seconde connexion Bun, qui n'exécute pas le schéma, attend 5 s au lieu d'échouer", () => {
    const autre = ouvrirBun(chemin);
    expect(autre.get<{ timeout: number }>("PRAGMA busy_timeout")?.timeout).toBe(5000);
    autre.fermer();
  });
  test("idem pour une connexion Node", () => {
    const racine = new URL("..", import.meta.url).pathname;
    const r = Bun.spawnSync(["node", "--no-warnings", "--experimental-strip-types", "-e",
      `import("${join(racine, "src/tableau-node.ts")}").then(({ ouvrirNode }) => { const t = ouvrirNode(process.argv[1]); console.log(t.get("PRAGMA busy_timeout").timeout); t.fermer(); })`, chemin]);
    expect(r.stdout.toString().trim()).toBe("5000");
  });
});

describe("deux modèles (24/09)", () => {
  const entrer = (...equipe: Array<[string, string, "hommes" | "femmes"]>) => { for (const [nom, modele, cote] of equipe) T.ajouterAgent(t, nom, `/b/${nom}`, modele, cote); };

  test("modèle et côté en base ; run.modele_femmes, NULL sans second modèle", () => {
    T.ouvrirRun(t, { id: "r", missionChemin: "m.md", missionTexte: "m", modele: "a/h", modeleFemmes: "b/f", plafondUsd: 1, silenceMin: 15 });
    entrer(["Antoine", "a/h", "hommes"], ["Agathe", "b/f", "femmes"]);
    T.ajouterAgent(t, "Bernard", "/b/Bernard"); // appel d'avant : ni modèle ni côté
    expect(t.all("SELECT nom, modele, cote FROM agents ORDER BY rowid")).toEqual([
      { nom: "Antoine", modele: "a/h", cote: "hommes" }, { nom: "Agathe", modele: "b/f", cote: "femmes" }, { nom: "Bernard", modele: null, cote: null }]);
    expect(t.get<{ f: string }>("SELECT modele_femmes AS f FROM run")?.f).toBe("b/f");
  });

  test("l'équipe et le tour de parole suivent l'ordre d'entrée : Antoine, puis Agathe", () => {
    entrer(["Antoine", "a/h", "hommes"], ["Agathe", "b/f", "femmes"], ["Bernard", "a/h", "hommes"]);
    expect(T.equipe(t).map((a) => a.nom)).toEqual(["Antoine", "Agathe", "Bernard"]);
    expect(T.tourDeParole(t, "Antoine")).toBeNull();
    expect(T.tourDeParole(t, "Agathe")?.apres).toBe("Antoine");
    expect(T.tourDeParole(t, "Bernard")?.apres).toBe("Agathe");
  });

  test("la grâce part de l'ouverture du tour, pas du lancement (run réseau du 24/09)", () => {
    entrer(["Antoine", "a/h", "hommes"], ["Agathe", "b/f", "femmes"], ["Bernard", "a/h", "hommes"], ["Brigitte", "b/f", "femmes"]);
    const t0 = Date.parse("2026-09-24T12:00:00.000Z");
    const a = (s: number) => new Date(t0 + s * 1000).toISOString();
    t.run("UPDATE agents SET debut = ?", [a(0)]);
    T.poster(t, "Antoine", "le but");
    t.run("UPDATE messages SET cree_le = ? WHERE auteur = 'Antoine'", [a(94)]); // douze fichiers à lire : Antoine parle à 94 s
    const g = 90_000;
    // La grâce de chacun ne compte pas depuis le lancement : Bernard attend encore Agathe à 100 s.
    expect(T.tourDeParole(t, "Bernard", g, t0 + 100_000)).toEqual({ apres: "Agathe", resteS: 84 }); // Agathe a jusqu'à 94 + 90 s
    expect(T.tourDeParole(t, "Agathe", g, t0 + 100_000)).toBeNull();
    expect(T.tourDeParole(t, "Bernard", g, t0 + 184_000)).toBeNull(); // Agathe muette : Bernard passe quand même
    expect(T.tourDeParole(t, "Brigitte", g, t0 + 200_000)?.apres).toBe("Bernard"); // son tour s'ouvre à 184 s
    expect(T.tourDeParole(t, "Brigitte", g, t0 + 274_000)).toBeNull();
    T.poster(t, "Agathe", "la répartition");
    t.run("UPDATE messages SET cree_le = ? WHERE auteur = 'Agathe'", [a(120)]);
    expect(T.tourDeParole(t, "Bernard", g, t0 + 121_000)).toBeNull();
    expect(T.tourDeParole(t, "Brigitte", g, t0 + 121_000)).toEqual({ apres: "Bernard", resteS: 89 });
  });

  test("quorumDemarrage : la moitié arrondie au-dessus, délai compté depuis son premier message", () => {
    entrer(["Antoine", "a/h", "hommes"], ["Agathe", "b/f", "femmes"], ["Bernard", "a/h", "hommes"], ["Brigitte", "b/f", "femmes"], ["Claude", "a/h", "hommes"]);
    const t0 = Date.parse("2026-09-25T08:00:00.000Z");
    T.poster(t, "Antoine", "le but");
    t.run("UPDATE messages SET cree_le = ?", [new Date(t0).toISOString()]);
    expect(T.quorumDemarrage(t, "Antoine", 300_000, t0 + 10_000)).toEqual({ parle: 1, total: 5, requis: 3, resteS: 290 });
    T.poster(t, "Agathe", "oui");
    T.poster(t, "Bernard", "oui");
    expect(T.quorumDemarrage(t, "Antoine", 300_000, t0 + 10_000)).toBeNull(); // 3 sur 5
  });
  test("quorumDemarrage : le délai de secours lève l'attente", () => {
    entrer(["Antoine", "a/h", "hommes"], ["Agathe", "b/f", "femmes"], ["Bernard", "a/h", "hommes"]);
    const t0 = Date.parse("2026-09-25T08:00:00.000Z");
    T.poster(t, "Antoine", "le but");
    t.run("UPDATE messages SET cree_le = ?", [new Date(t0).toISOString()]);
    expect(T.quorumDemarrage(t, "Antoine", 300_000, t0 + 299_000)?.resteS).toBe(1);
    expect(T.quorumDemarrage(t, "Antoine", 300_000, t0 + 300_000)).toBeNull();
  });

  test("le réveil ignore les accents, garde le mot entier", () => {
    entrer(["Antoine", "a/h", "hommes"], ["Cecile", "b/f", "femmes"], ["Helene", "b/f", "femmes"], ["Elise", "b/f", "femmes"], ["Denise", "b/f", "femmes"]);
    T.poster(t, "Antoine", "Cécile, tu relis ?");
    T.poster(t, "Antoine", "hélène : les tests");
    T.poster(t, "Antoine", "ÉLISE, merci");
    T.poster(t, "Antoine", "Denis s'en charge");
    expect(T.appelNonLu(t, "Cecile", ["Cecile"])?.texte).toBe("Cécile, tu relis ?");
    expect(T.appelNonLu(t, "Helene", ["Helene"])?.texte).toBe("hélène : les tests");
    expect(T.appelNonLu(t, "Elise", ["Elise"])?.texte).toBe("ÉLISE, merci");
    expect(T.appelNonLu(t, "Denise", ["Denise"])).toBeUndefined();
    T.poster(t, "Cecile", "Antoinette ?");
    expect(T.appelNonLu(t, "Antoine", ["Antoine"])).toBeUndefined();
  });

  test("parCote : sommes par côté, totaux conservés, messages sans multiplication, témoin A=A en deux entrées", () => {
    entrer(["Antoine", "a/x", "hommes"], ["Agathe", "a/x", "femmes"], ["Bernard", "a/x", "hommes"]);
    T.majAgent(t, "Antoine", { coutUsd: 0.1, tokensEntree: 100, tokensSortie: 10, appels: 3 });
    T.majAgent(t, "Bernard", { coutUsd: 0.2, tokensEntree: 200, tokensSortie: 20, appels: 4, coutEstime: true });
    T.majAgent(t, "Agathe", { coutUsd: 0.05, tokensEntree: 50, tokensSortie: 5, appels: 2 });
    T.sortirAgent(t, "Antoine", "fini", "ok");
    T.sortirAgent(t, "Bernard", "vire", "silence");
    for (let i = 0; i < 3; i++) T.poster(t, "Antoine", `m${i}`);
    T.poster(t, "Agathe", "m");
    expect(T.parCote(t)).toEqual([
      { cote: "hommes", modele: "a/x", agents: 2, finis: 1, vires: 1, perdus: 0, cout: 0.3, coutEstime: true, tokens: 330, appels: 7, messages: 3 },
      { cote: "femmes", modele: "a/x", agents: 1, finis: 0, vires: 0, perdus: 0, cout: 0.05, coutEstime: false, tokens: 55, appels: 2, messages: 1 },
    ]);
  });

  test("parCote : vide quand aucun agent n'a de côté", () => {
    T.ajouterAgent(t, "Antoine", "/b/Antoine");
    expect(T.parCote(t)).toEqual([]);
  });
});

describe("questions en attente (25/09)", () => {
  test("une question qui nomme l'agent, sans réponse de lui dans son fil ; elle sort de la liste dès qu'il y répond", () => {
    const t = ouvrirBun(":memory:");
    T.initialiser(t);
    for (const n of ["Antoine", "Cecile", "Denis"]) T.ajouterAgent(t, n, "/b");
    T.poster(t, "Cecile", "@Antoine — as-tu relancé tes 96 combinaisons ?", "q-96");
    T.poster(t, "Denis", "Antoine a fini son plan.", "principal"); // pas une question
    T.poster(t, "Denis", "Cécile, tu prends la heatmap ?", "q-heatmap"); // nomme une autre
    T.poster(t, "Denis", "antoine : qui écrit index.html ?", "principal");
    expect(T.questionsEnAttente(t, "Antoine", ["Antoine"]).map((q) => [q.id, q.fil, q.auteur])).toEqual([[4, "principal", "Denis"], [1, "q-96", "Cecile"]]);
    T.poster(t, "Antoine", "Oui : 0 KO.", "q-96");
    expect(T.questionsEnAttente(t, "Antoine", ["Antoine"]).map((q) => q.id)).toEqual([4]);
    expect(T.questionsEnAttente(t, "Cecile", ["Cecile"]).map((q) => q.id)).toEqual([3]); // « Cécile » avec l'accent la nomme
    t.fermer();
  });
  test("seulement l'agent à qui la question s'adresse, pas celui qu'elle cite en passant (F6, run ville)", () => {
    const t = ouvrirBun(":memory:");
    T.initialiser(t);
    for (const n of ["Antoine", "Denis", "Hubert", "Edmond"]) T.ajouterAgent(t, n, "/b");
    // un message réel, raccourci : adressé à Antoine, il cite Hubert dans une phrase qui n'est pas la question
    T.poster(t, "Denis", "Denis → **Antoine** : tu prends `temps.js` + `plan.js`. Mais la même horloge pilote trois vues : ton plan, la 3D d'Hubert et la visite. Ma question : qui consomme le flux ?", "q-flux");
    // Edmond nommé dans la phrase qui pose la question : il est bien interrogé
    T.poster(t, "Denis", "Point sur la fiche. Edmond, la pollution vient-elle de ton moteur ?", "q-fiche");
    expect(T.questionsEnAttente(t, "Antoine", ["Antoine"]).map((q) => q.id)).toEqual([1]);
    expect(T.questionsEnAttente(t, "Hubert", ["Hubert"])).toEqual([]);
    expect(T.questionsEnAttente(t, "Edmond", ["Edmond"]).map((q) => q.id)).toEqual([2]);
    t.fermer();
  });
});

describe("questions en attente : fils de concentration (26/09, O37)", () => {
  test("une annonce de la salle n'est pas une question ; la 3D d'Hubert n'interroge pas Hubert", () => {
    const t = ouvrirBun(":memory:");
    T.initialiser(t);
    for (const n of ["Antoine", "Denis", "Hubert"]) T.ajouterAgent(t, n, "/b");
    T.poster(t, "salle", "Denis ouvre q-flux : Hubert, qui consomme le flux ?", "principal");
    T.poster(t, "Denis", "Antoine : la 3D d'Hubert attend. Qui branche le flux ?", "q-flux");
    expect(T.questionsEnAttente(t, "Hubert", ["Hubert"])).toEqual([]);
    expect(T.questionsEnAttente(t, "Antoine", ["Antoine"]).map((q) => q.id)).toEqual([2]);
    t.fermer();
  });
});

describe("tickets (A7)", () => {
  test("ouvrir, lire, lister : chaque changement laisse une note", () => {
    const id = T.ouvrirTicket(t, { type: "bug", titre: "la carte ne s'affiche pas", description: "index.html, clic sur Carte : rien", auteur: "Antoine", charge: "Bernard" });
    const k = T.lireTicket(t, id)!;
    expect(k).toMatchObject({ id, type: "bug", etat: "ouvert", auteur: "Antoine", charge: "Bernard", commit_ferme: null });
    expect(k.notes.map((n) => [n.auteur, n.texte])).toEqual([["Antoine", "ouvert, confié à Bernard"]]);
    expect(T.majTicket(t, id, "Bernard", { etat: "en_cours" })).toEqual({ ok: true });
    expect(T.listerTickets(t, { etat: "en_cours" }).map((x) => x.id)).toEqual([id]);
    expect(T.listerTickets(t, { charge: "Claude" })).toEqual([]);
    expect(T.lireTicket(t, id)!.notes.at(-1)).toMatchObject({ auteur: "Bernard", texte: "passé en cours" });
  });
  test("un bug fermé sans commit est refusé ; avec un commit, il est fermé et le commit gardé", () => {
    const id = T.ouvrirTicket(t, { type: "bug", titre: "x", description: "y", auteur: "Antoine" });
    expect(T.majTicket(t, id, "Bernard", { etat: "ferme" })).toEqual({ ok: false, raison: "un bug ne se ferme pas sans commit. Se lève avec le commit qui corrige" });
    expect(T.lireTicket(t, id)!.etat).toBe("ouvert");
    const hash = "0123456789abcdef0123456789abcdef01234567";
    expect(T.majTicket(t, id, "Bernard", { etat: "ferme", commit: hash })).toEqual({ ok: true });
    expect(T.lireTicket(t, id)).toMatchObject({ etat: "ferme", commit_ferme: hash });
    expect(T.lireTicket(t, id)!.notes.at(-1)!.texte).toBe("fermé par le commit 0123456");
  });
  test("une question se ferme sur une réponse écrite, sans commit", () => {
    const id = T.ouvrirTicket(t, { type: "question", titre: "quel moteur 3D ?", description: "three ou babylon", auteur: "Antoine" });
    expect(T.majTicket(t, id, "Bernard", { etat: "ferme" })).toMatchObject({ ok: false });
    expect(T.majTicket(t, id, "Bernard", { etat: "ferme", reponse: "three : plus léger" })).toEqual({ ok: true });
    expect(T.lireTicket(t, id)).toMatchObject({ etat: "ferme", reponse: "three : plus léger", commit_ferme: null });
  });
  test("rôles (R5) : une base d'avant les alertes gagne leurs colonnes ; un ticket fermé d'avant reste lisible, de travail et sans motif", () => {
    const ancien = ouvrirBun(join(dossier, "ancien.sqlite"));
    ancien.exec(T.SCHEMA); // sans les colonnes ajoutées : le schéma d'avant pour les tickets
    ancien.run("INSERT INTO tickets(type, titre, auteur, etat, commit_ferme, cree_le, maj_le) VALUES ('bug', 'x', 'Antoine', 'ferme', 'abc', 'le', 'le')");
    expect(T.aColonne(ancien, "tickets", "sorte")).toBe(false);
    T.initialiser(ancien);
    for (const c of ["sorte", "motif", "remplace_par", "reproduction", "bloque_par"]) expect(T.aColonne(ancien, "tickets", c)).toBe(true);
    expect(T.lireTicket(ancien, 1)).toMatchObject({ etat: "ferme", commit_ferme: "abc", sorte: "travail", motif: null });
    expect(T.listerTickets(ancien, { etat: "ferme" }).map((k) => k.id)).toEqual([1]);
    ancien.fermer();
  });
  test("type et état hors liste refusés par la base ; ticket inconnu refusé", () => {
    expect(() => T.ouvrirTicket(t, { type: "tache" as T.TypeTicket, titre: "x", description: "y", auteur: "A" })).toThrow();
    expect(T.majTicket(t, 99, "A", { etat: "en_cours" })).toEqual({ ok: false, raison: "aucun ticket #99. Définitif pour ce numéro" });
  });
});

// Rôles des agents : un agent viré ou perdu ne laisse aucun ticket orphelin.
describe("transfererTickets : les tickets ouverts d'un sortant et leurs pancartes (R5)", () => {
  const pancartes = () => T.reclamations(t).map((r) => [r.chemin, r.agent]);
  test("un agent qui porte trois tickets (dont un fermé) : les deux ouverts passent au chef, avec leurs pancartes ; une note, un fait, une annonce chacun", () => {
    const a = T.ouvrirTicket(t, { type: "amelioration", titre: "le moteur", description: "d", auteur: "Antoine", charge: "Claude", chemins: ["moteur.js"] });
    const b = T.ouvrirTicket(t, { type: "bug", titre: "les ombres", description: "d", auteur: "Fabien", charge: "Claude" });
    const c = T.ouvrirTicket(t, { type: "amelioration", titre: "le rendu", description: "d", auteur: "Antoine", charge: "Claude", chemins: ["rendu.js"] });
    T.majTicket(t, c, "Claude", { motif: "annule", note: "doublon", rendreA: "Antoine" });
    T.reclamer(t, "Claude", "notes.md", "mes notes"); // une pancarte hors ticket : elle reste au sortant (sortir la retire)
    expect(T.transfererTickets(t, "Claude", "Antoine", "perdu : code de sortie 1")).toEqual([a, b]);
    expect(T.listerTickets(t).map((k) => [k.id, k.charge, k.etat])).toEqual([[a, "Antoine", "ouvert"], [b, "Antoine", "ouvert"], [c, "Claude", "ferme"]]);
    expect(pancartes()).toEqual([["rendu.js", "Antoine"], ["notes.md", "Claude"], ["moteur.js", "Antoine"]]);
    expect(T.lireTicket(t, a)!.notes.at(-1)).toMatchObject({ auteur: "salle", texte: "transféré de Claude à Antoine (perdu : code de sortie 1)" });
    expect(t.all<{ auteur: string; texte: string }>("SELECT m.auteur, m.texte FROM messages m JOIN fils f ON f.id = m.fil_id WHERE f.nom = 'tickets' ORDER BY m.id")).toEqual([
      { auteur: "salle", texte: `[ticket #${a}] le moteur : transféré de Claude à Antoine (perdu : code de sortie 1) (chargé : Antoine)` },
      { auteur: "salle", texte: `[ticket #${b}] les ombres : transféré de Claude à Antoine (perdu : code de sortie 1) (chargé : Antoine)` }]);
    expect(T.nomme(`[ticket #${a}] le moteur : transféré de Claude à Antoine`, "Antoine")).toBe(true); // un repreneur endormi se réveille
    expect(t.all<{ agent: string; source: string; texte: string }>("SELECT agent, source, texte FROM faits WHERE type = 'ticket' AND texte LIKE '%transféré%' ORDER BY id")).toEqual([
      { agent: "Claude", source: "lanceur", texte: `ticket #${a} transféré de Claude à Antoine · perdu : code de sortie 1` },
      { agent: "Claude", source: "lanceur", texte: `ticket #${b} transféré de Claude à Antoine · perdu : code de sortie 1` }]);
  });

  test("la sortie du chef : ses tickets vont à son suppléant ; une pancarte reprise pour un autre ticket reste à son porteur ; sans ticket, rien", () => {
    const a = T.ouvrirTicket(t, { type: "amelioration", titre: "a", description: "d", auteur: "Antoine", charge: "Antoine", chemins: ["a.js", "b.js"] });
    T.ouvrirTicket(t, { type: "amelioration", titre: "b", description: "d", auteur: "Antoine", charge: "Claude", chemins: ["b.js"] });
    expect(T.transfererTickets(t, "Antoine", "Denis", "viré : silence")).toEqual([a]);
    expect(T.lireTicket(t, a)!.notes.at(-1)!.texte).toBe("transféré d'Antoine à Denis (viré : silence)");
    expect(pancartes()).toEqual([["b.js", "Claude"], ["a.js", "Denis"]]);
    expect(T.transfererTickets(t, "Bernard", "Denis", "perdu")).toEqual([]);
  });
});

describe("fils de concentration : présences (26/09)", () => {
  beforeEach(() => {
    T.ouvrirRun(t, { id: "r", missionChemin: "m", missionTexte: "t", modele: "faux", plafondUsd: 1, silenceMin: 15 });
    for (const nom of ["Antoine", "Bernard", "Cecile", "Denis"]) T.ajouterAgent(t, nom, `/b/${nom}`);
    for (const nom of ["Antoine", "Bernard", "Cecile"]) T.poster(t, nom, `bonjour de ${nom}`);
  });
  const placer = (agent: string, fil: string) => {
    T.poster(t, "system", "création", fil);
    const id = t.get<{ id: number }>("SELECT id FROM fils WHERE nom = ?", [fil])!.id;
    t.run("INSERT INTO presences(agent, fil_id, entre_le) VALUES (?, ?, '2026-09-26T00:00:00Z')", [agent, id]);
  };

  test("estDernier : seuls les présents actifs ou dormants comptent (W2)", () => {
    expect(T.estDernier(t, "Antoine")).toBe(false); // aucune présence
    placer("Antoine", "q-neige");
    expect(T.estDernier(t, "Antoine")).toBe(true);
    placer("Bernard", "q-neige");
    expect(T.estDernier(t, "Antoine")).toBe(false);
    T.endormir(t, "Bernard");
    expect(T.estDernier(t, "Antoine")).toBe(false); // un dormeur est vivant
    T.sortirAgent(t, "Bernard", "perdu", "passes épuisées");
    expect(T.estDernier(t, "Antoine")).toBe(true); // un perdu ne compte plus, même s'il reste inscrit
  });

  const etat = () => ({
    presences: t.all("SELECT agent, fil_id, reveil_fil FROM presences ORDER BY agent"),
    fils: t.all("SELECT id, nom, pourquoi, conclusion, ouvert_le, ferme_le FROM fils ORDER BY id"),
    messages: t.get<{ n: number }>("SELECT count(*) AS n FROM messages")!.n,
  });
  const annonces = () => t.all<{ texte: string }>("SELECT m.texte FROM messages m WHERE m.auteur = 'salle' AND m.fil_id = 1 ORDER BY m.id").map((m) => m.texte);

  test("entrer ouvre un fil avec son pourquoi, une seule annonce ; une entrée simple n'annonce rien", () => {
    expect(T.entrer(t, "Antoine", "q-neige", "la neige ne tombe pas")).toEqual({ ok: true, ouvert: true, presents: [], pourquoi: "la neige ne tombe pas" });
    const f = t.get<{ cree_par: string; pourquoi: string; ouvert_le: string | null; ferme_le: string | null }>("SELECT cree_par, pourquoi, ouvert_le, ferme_le FROM fils WHERE nom = 'q-neige'")!;
    expect([f.cree_par, f.pourquoi, !!f.ouvert_le, f.ferme_le]).toEqual(["Antoine", "la neige ne tombe pas", true, null]);
    expect(annonces()).toEqual(["Antoine ouvre q-neige : la neige ne tombe pas"]);
    expect(T.entrer(t, "Bernard", "q-neige")).toEqual({ ok: true, ouvert: false, presents: ["Antoine"], pourquoi: "la neige ne tombe pas" });
    expect(annonces()).toHaveLength(1);
    expect(t.all("SELECT agent, reveil_fil FROM presences ORDER BY agent")).toEqual([{ agent: "Antoine", reveil_fil: 0 }, { agent: "Bernard", reveil_fil: 0 }]);
  });

  test("entrer dans son propre fil : sans effet (W9)", () => {
    T.entrer(t, "Antoine", "q-neige", "pourquoi");
    T.entrer(t, "Bernard", "q-neige");
    const avant = etat();
    expect(T.entrer(t, "Antoine", "q-neige", "autre pourquoi")).toEqual({ ok: true, ouvert: false, presents: ["Bernard"], pourquoi: "pourquoi" });
    expect(etat()).toEqual(avant);
  });

  test("entrer : chaque refus laisse présences et fils inchangés", () => {
    T.entrer(t, "Antoine", "q-neige", "pourquoi");
    T.poster(t, "Cecile", "un fil ordinaire", "design");
    const avant = etat();
    for (const fil of ["principal", "verification", "tickets"])
      expect(T.entrer(t, "Bernard", fil, "x")).toEqual({ ok: false, raison: `${fil} est un fil de la salle, on n'y entre pas. Définitif pour ce fil` });
    expect(T.entrer(t, "Denis", "q-neige")).toEqual({ ok: false, raison: "tu n'as encore rien posté. Se lève à ton premier message" });
    expect(T.entrer(t, "Antoine", "q-pluie", "autre chose")).toEqual({ ok: false, raison: "tu es le dernier présent de q-neige. Se lève après fil_quitter avec une conclusion" });
    expect(T.entrer(t, "Bernard", "design")).toEqual({ ok: false, raison: "design n'est pas ouvert et aucun pourquoi n'est donné. Se lève avec un pourquoi non vide" });
    expect(T.entrer(t, "Bernard", "q-pluie", "  ")).toEqual({ ok: false, raison: "q-pluie n'est pas ouvert et aucun pourquoi n'est donné. Se lève avec un pourquoi non vide" });
    expect(etat()).toEqual(avant);
  });

  test("entrer ailleurs fait sortir du premier fil quand on n'y est pas le dernier (O18, O22)", () => {
    T.entrer(t, "Antoine", "q-neige", "neige");
    T.entrer(t, "Bernard", "q-neige");
    expect(T.entrer(t, "Bernard", "q-pluie", "pluie")).toMatchObject({ ok: true, ouvert: true });
    expect(t.all("SELECT p.agent, f.nom FROM presences p JOIN fils f ON f.id = p.fil_id ORDER BY p.agent")).toEqual([{ agent: "Antoine", nom: "q-neige" }, { agent: "Bernard", nom: "q-pluie" }]);
  });

  test("quitter : refus hors d'un fil, et au dernier sans conclusion ; une conclusion d'un non-dernier est ignorée (O10)", () => {
    expect(T.quitter(t, "Antoine")).toEqual({ ok: false, raison: "tu n'es dans aucun fil. Se lève après fil_entrer" });
    T.entrer(t, "Antoine", "q-neige", "neige");
    T.entrer(t, "Bernard", "q-neige");
    expect(T.quitter(t, "Bernard", "ma conclusion")).toEqual({ ok: true, fil: "q-neige", ferme: false });
    expect(t.get("SELECT conclusion, ferme_le FROM fils WHERE nom = 'q-neige'")).toEqual({ conclusion: null, ferme_le: null });
    const avant = etat();
    expect(T.quitter(t, "Antoine", "   ")).toEqual({ ok: false, raison: "tu es le dernier présent de q-neige et la conclusion est vide. Se lève avec une conclusion non vide" });
    expect(etat()).toEqual(avant);
    expect(T.quitter(t, "Antoine", "la neige tombe")).toEqual({ ok: true, fil: "q-neige", ferme: true });
    const f = t.get<{ conclusion: string; ferme_le: string | null }>("SELECT conclusion, ferme_le FROM fils WHERE nom = 'q-neige'")!;
    expect([f.conclusion, !!f.ferme_le]).toEqual(["la neige tombe", true]);
    expect(annonces()).toEqual(["Antoine ouvre q-neige : neige", "q-neige fermé : la neige tombe"]);
    expect(T.filDe(t, "Antoine")).toBeUndefined();
  });

  test("un fil fermé se rouvre avec un pourquoi, messages gardés, conclusion effacée", () => {
    T.entrer(t, "Antoine", "q-neige", "neige");
    T.poster(t, "Antoine", "premier essai", "q-neige");
    T.quitter(t, "Antoine", "abandonné");
    expect(T.entrer(t, "Bernard", "q-neige")).toEqual({ ok: false, raison: "q-neige n'est pas ouvert et aucun pourquoi n'est donné. Se lève avec un pourquoi non vide" });
    expect(T.entrer(t, "Bernard", "q-neige", "on reprend")).toEqual({ ok: true, ouvert: true, presents: [], pourquoi: "on reprend" });
    expect(t.get("SELECT pourquoi, conclusion, ferme_le FROM fils WHERE nom = 'q-neige'")).toEqual({ pourquoi: "on reprend", conclusion: null, ferme_le: null });
    expect(t.get<{ n: number }>("SELECT count(*) AS n FROM messages m JOIN fils f ON f.id = m.fil_id WHERE f.nom = 'q-neige'")!.n).toBe(1);
    expect(annonces().at(-1)).toBe("Bernard ouvre q-neige : on reprend");
  });

  test("sortirDuFil : sans conclusion ; le fil se ferme « sans conclusion » quand plus aucun vivant n'y est", () => {
    T.entrer(t, "Antoine", "q-neige", "neige");
    T.entrer(t, "Bernard", "q-neige");
    T.sortirAgent(t, "Antoine", "vire", "plafond");
    T.sortirDuFil(t, "Antoine", "vire : plafond");
    expect(T.filDe(t, "Antoine")).toBeUndefined();
    expect(t.get("SELECT ferme_le FROM fils WHERE nom = 'q-neige'")).toEqual({ ferme_le: null }); // Bernard y est encore
    T.sortirDuFil(t, "Bernard", "perdu : passes épuisées");
    const f = t.get<{ conclusion: string | null; ferme_le: string | null }>("SELECT conclusion, ferme_le FROM fils WHERE nom = 'q-neige'")!;
    expect([f.conclusion, !!f.ferme_le]).toEqual([null, true]);
    expect(annonces().at(-1)).toBe("q-neige fermé sans conclusion (perdu : passes épuisées)");
    expect(() => T.sortirDuFil(t, "Cecile", "fini : rien")).not.toThrow(); // pas dans un fil : sans effet
  });

  test("fermerFils (fin du run) : toutes les présences retirées, même d'un agent terminé ; une annonce par fil ouvert", () => {
    T.entrer(t, "Antoine", "q-neige", "neige");
    T.entrer(t, "Bernard", "q-pluie", "pluie");
    T.entrer(t, "Cecile", "q-pluie");
    T.quitter(t, "Cecile");
    T.entrer(t, "Cecile", "q-vent", "vent");
    T.quitter(t, "Cecile", "calme");
    T.sortirAgent(t, "Antoine", "fini", "fait");
    T.fermerFils(t, "fin du run");
    expect(t.get<{ n: number }>("SELECT count(*) AS n FROM presences")!.n).toBe(0);
    expect(t.all("SELECT nom, conclusion, ferme_le IS NOT NULL AS ferme FROM fils WHERE ouvert_le IS NOT NULL ORDER BY nom")).toEqual([
      { nom: "q-neige", conclusion: null, ferme: 1 }, { nom: "q-pluie", conclusion: null, ferme: 1 }, { nom: "q-vent", conclusion: "calme", ferme: 1 }]);
    expect(annonces().filter((a) => a.includes("fin du run"))).toEqual(["q-neige fermé sans conclusion (fin du run)", "q-pluie fermé sans conclusion (fin du run)"]);
  });

  test("filDe et presences : le fil de chacun, et « assoupi » quand tous ses présents vivants dorment (O31)", () => {
    T.entrer(t, "Antoine", "q-neige", "neige");
    T.entrer(t, "Bernard", "q-neige");
    T.entrer(t, "Cecile", "q-pluie", "pluie");
    t.run("UPDATE presences SET reveil_fil = 1 WHERE agent = 'Bernard'");
    expect(T.filDe(t, "Bernard")).toEqual({ fil: "q-neige", reveil_fil: true });
    expect(T.filDe(t, "Denis")).toBeUndefined();
    T.endormir(t, "Antoine");
    T.endormir(t, "Cecile");
    const vue = () => T.presences(t).map((p) => ({ fil: p.fil, agents: p.presents.map((a) => a.agent), assoupi: p.assoupi }));
    expect(vue()).toEqual([{ fil: "q-neige", agents: ["Antoine", "Bernard"], assoupi: false }, { fil: "q-pluie", agents: ["Cecile"], assoupi: true }]);
    T.endormir(t, "Bernard");
    expect(vue()[0]!.assoupi).toBe(true);
    expect(T.presences(t)[0]!.presents[1]).toMatchObject({ agent: "Bernard", etat: "dormant", reveil_fil: true });
  });

  // fil_quitter est retiré des agents : fini ne refuse plus le dernier présent.
  test("fini retire la présence, celle du dernier présent comprise (O1, 27/09)", () => {
    T.entrer(t, "Antoine", "q-neige", "neige");
    T.entrer(t, "Bernard", "q-neige");
    expect(T.fini(t, "Antoine", "ma part est faite")).toEqual({ ok: true });
    expect(t.get("SELECT etat FROM agents WHERE nom = 'Antoine'")).toEqual({ etat: "fini" });
    expect(T.filDe(t, "Antoine")).toBeUndefined();
    expect(T.fini(t, "Bernard", "moi aussi")).toEqual({ ok: true });
    expect(t.get("SELECT etat, raison_sortie FROM agents WHERE nom = 'Bernard'")).toEqual({ etat: "fini", raison_sortie: "moi aussi" });
    expect(T.filDe(t, "Bernard")).toBeUndefined();
    // Le dernier présent parti par fini ferme le fil, comme s'il en sortait, sinon il resterait ouvert sans personne.
    expect(t.get<{ ferme_le: string | null }>("SELECT ferme_le FROM fils WHERE nom = 'q-neige'")!.ferme_le).not.toBeNull();
  });

  test("un tableau d'avant les fils, sans presences : sortirDuFil, fermerFils, filDe et presences sans effet", () => {
    const ancien = ouvrirBun(join(dossier, "ancien.sqlite"));
    ancien.exec("CREATE TABLE fils(id INTEGER PRIMARY KEY, nom TEXT UNIQUE NOT NULL, cree_par TEXT, cree_le TEXT);");
    expect(() => T.sortirDuFil(ancien, "Antoine", "fini")).not.toThrow();
    expect(() => T.fermerFils(ancien, "lanceur absent")).not.toThrow();
    expect(T.filDe(ancien, "Antoine")).toBeUndefined();
    expect(T.presences(ancien)).toEqual([]);
    ancien.fermer();
  });
});

describe("fils de concentration : lecture (26/09)", () => {
  beforeEach(() => {
    T.ouvrirRun(t, { id: "r", missionChemin: "m", missionTexte: "t", modele: "faux", plafondUsd: 1, silenceMin: 15 });
    for (const nom of ["Antoine", "Bernard", "Cecile"]) T.ajouterAgent(t, nom, `/b/${nom}`);
  });
  const idFil = (nom: string) => t.get<{ id: number }>("SELECT id FROM fils WHERE nom = ?", [nom])!.id;
  // n messages de `taille` caractères dans `fil` ; rend leurs ids
  const remplir = (fil: string, n: number, taille = 40, auteur = "Bernard") =>
    Array.from({ length: n }, (_, i) => T.poster(t, auteur, `${fil} ${i + 1} `.padEnd(taille, "x"), fil));
  const bornes = (lots: T.Lot[]) => lots.map((l) => [l.debut_id, l.fin_id, l.entier]);

  test("lots figés (O26) : mêmes bornes quel que soit le lecteur ; lot entamé ; la queue n'est jamais un lot", () => {
    const m = remplir("q-neige", 10); // 40 caractères chacun : un lot clos tous les 3 messages à 100
    const f = idFil("q-neige");
    // un lecteur dont le curseur est sur m5 et qui ne voit que jusqu'à m8 : le lot m4-m6 est entamé
    expect(bornes(T.lotsDuRetard(t, f, m[4]!, m[7]!, "Cecile", null, 100))).toEqual([[m[3], m[5], false]]);
    // un lecteur qui part de zéro obtient les mêmes bornes, plus le lot m7-m9 ; m10 reste la queue
    expect(bornes(T.lotsDuRetard(t, f, 0, m[9]!, "Antoine", null, 100))).toEqual([[m[0], m[2], true], [m[3], m[5], true], [m[6], m[8], true]]);
    expect(t.all("SELECT debut_id, fin_id, demande_par, etat FROM lots ORDER BY debut_id")).toEqual([
      { debut_id: m[0], fin_id: m[2], demande_par: "Cecile", etat: "attente" },
      { debut_id: m[3], fin_id: m[5], demande_par: "Cecile", etat: "attente" },
      { debut_id: m[6], fin_id: m[8], demande_par: "Antoine", etat: "attente" }]);
    // curseur exactement sur une borne : le lot suivant est entier, le précédent n'est pas rendu
    expect(bornes(T.lotsDuRetard(t, f, m[2]!, m[9]!, "Bernard", null, 100))).toEqual([[m[3], m[5], true], [m[6], m[8], true]]);
    // un lecteur qui ne voit que jusqu'à m7 : le lot m7-m9 le dépasse, il est entamé
    expect(bornes(T.lotsDuRetard(t, f, m[2]!, m[6]!, "Bernard", null, 100))).toEqual([[m[3], m[5], true], [m[6], m[8], false]]);
  });

  test("un message plus grand que la taille d'un lot fait un lot à lui seul ; fil vide : aucun lot", () => {
    const [a, b, c] = [T.poster(t, "Bernard", "x".repeat(250), "q-gros"), T.poster(t, "Bernard", "petit", "q-gros"), T.poster(t, "Bernard", "y".repeat(120), "q-gros")];
    expect(bornes(T.lotsDuRetard(t, idFil("q-gros"), 0, c, "Antoine", null, 100))).toEqual([[a, a, true], [b, c, true]]);
    T.poster(t, "system", "création", "q-vide");
    t.run("DELETE FROM messages WHERE fil_id = ?", [idFil("q-vide")]);
    expect(T.lotsDuRetard(t, idFil("q-vide"), 0, 999, "Antoine", null, 100)).toEqual([]);
  });

  test("P6 : dix demandes, deux connexions, une seule ligne par lot ; côté noté", () => {
    const m = remplir("q-neige", 6);
    const autre = ouvrirBun(chemin);
    for (let i = 0; i < 10; i++) T.lotsDuRetard(i % 2 ? autre : t, idFil("q-neige"), 0, m[5]!, `agent-${i}`, "hommes", 100);
    autre.fermer();
    expect(t.all("SELECT debut_id, demande_par, cote FROM lots ORDER BY debut_id")).toEqual([
      { debut_id: m[0], demande_par: "agent-0", cote: "hommes" }, { debut_id: m[3], demande_par: "agent-0", cote: "hommes" }]);
  });

  test("reactiverLot (W5) : un échec repasse en attente tant qu'il a moins de trois essais", () => {
    const m = remplir("q-neige", 3);
    const [lot] = T.lotsDuRetard(t, idFil("q-neige"), 0, m[2]!, "Antoine", null, 100);
    expect(T.reactiverLot(t, lot!.id)).toBe(false); // en attente : rien à réactiver
    for (const essais of [1, 2]) {
      t.run("UPDATE lots SET etat = 'echec', essais = ? WHERE id = ?", [essais, lot!.id]);
      expect(T.reactiverLot(t, lot!.id)).toBe(true);
      expect(t.get("SELECT etat FROM lots WHERE id = ?", [lot!.id])).toEqual({ etat: "attente" });
    }
    t.run("UPDATE lots SET etat = 'echec', essais = 3 WHERE id = ?", [lot!.id]);
    expect(T.reactiverLot(t, lot!.id)).toBe(false);
    t.run("UPDATE lots SET etat = 'fait', essais = 1 WHERE id = ?", [lot!.id]);
    expect(T.reactiverLot(t, lot!.id)).toBe(false); // un lot fait n'est jamais réécrit
  });

  const toutLu = (agent: string) => t.run(`INSERT OR REPLACE INTO lectures(agent, fil_id, dernier_id)
    SELECT ?, fil_id, MAX(id) FROM messages GROUP BY fil_id`, [agent]);
  const ecrits = () => ({ lectures: t.all("SELECT * FROM lectures"), appels: t.all("SELECT * FROM appels_livres"), lots: t.all("SELECT * FROM lots") });

  test("selectionner hors d'un fil : tous les fils, retard compté avant toute pagination, rien d'écrit", () => {
    const p = remplir("principal", 60);
    const d = remplir("design", 2, 10);
    const avant = ecrits();
    const s = T.selectionner(t, "Antoine");
    expect(s.perimetre).toBe("tous");
    expect(s.exception).toBeUndefined();
    expect(s.fils.map((r) => [r.nom, r.depuis, r.jusqua, r.n, r.taille])).toEqual([["principal", 0, p[59], 60, 2400], ["design", 0, d[1], 2, 20]]);
    expect(T.selectionner(t, "Antoine", "design").fils.map((r) => [r.nom, r.n])).toEqual([["design", 2]]);
    expect(T.selectionner(t, "Antoine", "design").perimetre).toBe("fil");
    expect(T.selectionner(t, "Antoine", "inconnu").fils).toEqual([]);
    expect(ecrits()).toEqual(avant);
  });

  test("selectionner dans un fil (O1) : ce fil seulement ; l'annonce de la salle et un appel dans son propre fil ne sont pas l'exception", () => {
    T.poster(t, "Antoine", "bonjour");
    T.entrer(t, "Antoine", "q-neige", "Antoine veut comprendre la neige"); // l'annonce de la salle nomme Antoine
    T.poster(t, "Bernard", "Antoine, dans le fil : regarde ça", "q-neige");
    remplir("design", 3);
    const s = T.selectionner(t, "Antoine");
    expect([s.perimetre, s.exception, s.fils.map((r) => [r.nom, r.n])]).toEqual(["sien", undefined, [["q-neige", 1]]]);
  });

  test("l'exception (W6) : un appel d'un autre fil ouvre tous les fils, et le périmètre tient jusqu'au vidage du retard capturé", () => {
    T.poster(t, "Antoine", "bonjour");
    T.entrer(t, "Antoine", "q-neige", "neige");
    toutLu("Antoine");
    remplir("design", 3);
    const appel = T.poster(t, "Bernard", "Antoine, tu relis le design ?", "principal");
    const memoire: T.MemoireLecture = {};
    const s = T.selectionner(t, "Antoine", undefined, memoire);
    expect([s.perimetre, s.exception?.id, s.fils.map((r) => r.nom)]).toEqual(["tous", appel, ["design", "principal"]]);
    expect(memoire.exception).toBe(appel);
    // l'appel est livré à part : il n'y a plus d'appel non lu, mais le retard capturé n'est pas vidé
    t.run("INSERT INTO appels_livres(agent, message_id, livre_le) VALUES ('Antoine', ?, 'x')", [appel]);
    const suite = T.selectionner(t, "Antoine", undefined, memoire);
    expect([suite.perimetre, suite.exception]).toEqual(["tous", undefined]);
    expect(T.selectionner(t, "Antoine").perimetre).toBe("sien"); // sans la mémoire de l'outil, pas d'exception
    // le retard capturé lu, un message arrivé après ne garde pas l'exception
    for (const fil of ["design", "principal"]) t.run("INSERT OR REPLACE INTO lectures(agent, fil_id, dernier_id) VALUES ('Antoine', ?, ?)", [idFil(fil), appel]);
    T.poster(t, "Cecile", "rien pour toi", "design");
    expect(T.selectionner(t, "Antoine", undefined, memoire).perimetre).toBe("sien");
    expect(memoire.exception).toBeUndefined();
  });

  // un élément en une ligne lisible : « a:12 » appel, « b:12 » brut, « r:10-12 » résumé
  const vue = (els: T.Element[]) => els.map((e) => e.type === "resume" ? `r:${e.lot.debut_id}-${e.lot.fin_id}` : `${e.type[0]}:${e.message.id}`);

  test("preparer sans résumeur : les bruts dans l'ordre des ids, tous fils mêlés, et aucun lot créé", () => {
    const a = T.poster(t, "Bernard", "p1");
    const b = T.poster(t, "Cecile", "d1", "design");
    const c = T.poster(t, "Bernard", "p2");
    const p = T.preparer(t, "Antoine", T.selectionner(t, "Antoine"));
    expect([vue(p.elements), p.reste]).toEqual([[`b:${a}`, `b:${b}`, `b:${c}`], false]);
    expect(p.elements[1]).toMatchObject({ type: "brut", message: { fil: "design", auteur: "Cecile", texte: "d1" } });
    expect(t.all("SELECT * FROM lots")).toEqual([]);
  });

  test("preparer : les appels en tête, tels quels, jamais répétés ; ni la salle ni soi-même ne sont des appels (O24, S4)", () => {
    const a = T.poster(t, "Bernard", "p1");
    const b = T.poster(t, "salle", "Antoine ouvre q-neige : neige");
    const c = T.poster(t, "Antoine", "moi, Antoine");
    const d = T.poster(t, "Cecile", "Antoine, tu relis ?", "design");
    const e = T.poster(t, "Bernard", "p2");
    const deja = T.poster(t, "Bernard", "Antoine, déjà livré");
    t.run("INSERT INTO appels_livres(agent, message_id, livre_le) VALUES ('Antoine', ?, 'x')", [deja]);
    expect(vue(T.preparer(t, "Antoine", T.selectionner(t, "Antoine")).elements)).toEqual([`a:${d}`, `b:${a}`, `b:${b}`, `b:${c}`, `b:${e}`]);
  });

  test("preparer avec résumés : un lot clos entier d'un autre fil est résumé, un lot sans résumé et la queue restent bruts (D5, P5)", () => {
    const m = remplir("q-neige", 10);
    const textes = new Map([[m[0], "résumé A [msg 1]"], [m[6], "résumé C [msg 7]"]]);
    const p = T.preparer(t, "Antoine", T.selectionner(t, "Antoine"), { obtenirResume: (l) => textes.get(l.debut_id), taille: 100 });
    expect(vue(p.elements)).toEqual([`r:${m[0]}-${m[2]}`, `b:${m[3]}`, `b:${m[4]}`, `b:${m[5]}`, `r:${m[6]}-${m[8]}`, `b:${m[9]}`]);
    expect(p.elements[0]).toMatchObject({ type: "resume", texte: "résumé A [msg 1]" });
    expect(t.all("SELECT demande_par FROM lots")).toEqual([{ demande_par: "Antoine" }, { demande_par: "Antoine" }, { demande_par: "Antoine" }]);
  });

  test("preparer : un lot entamé est brut ; un appel dans un lot résumé sort en tête et le résumé reste entier", () => {
    const m = remplir("q-neige", 6);
    const appel = T.poster(t, "Cecile", "Antoine : ".padEnd(40, "y"), "q-neige"); // m7, dans le lot m7-m9
    const n = remplir("q-neige", 2);
    t.run("INSERT INTO lectures(agent, fil_id, dernier_id) VALUES ('Antoine', ?, ?)", [idFil("q-neige"), m[1]]); // curseur sur m2
    const p = T.preparer(t, "Antoine", T.selectionner(t, "Antoine"), { obtenirResume: () => "résumé", taille: 100 });
    expect(vue(p.elements)).toEqual([`a:${appel}`, `b:${m[2]}`, `r:${m[3]}-${m[5]}`, `r:${appel}-${n[1]}`]);
  });

  test("preparer : le fil où l'on est reste brut, sans lot ; les autres fils sont résumés", () => {
    T.poster(t, "Antoine", "bonjour");
    T.entrer(t, "Antoine", "q-neige", "neige");
    t.run("INSERT OR REPLACE INTO lectures(agent, fil_id, dernier_id) SELECT 'Antoine', fil_id, MAX(id) FROM messages GROUP BY fil_id");
    const m = remplir("q-neige", 3);
    const d = remplir("design", 3);
    const appel = T.poster(t, "Bernard", "Antoine, regarde le design");
    const p = T.preparer(t, "Antoine", T.selectionner(t, "Antoine"), { obtenirResume: () => "résumé", taille: 100 }); // exception : tous
    expect(vue(p.elements)).toEqual([`a:${appel}`, ...m.map((id) => `b:${id}`), `r:${d[0]}-${d[2]}`]);
    expect(t.all("SELECT fil_id FROM lots")).toEqual([{ fil_id: idFil("design") }]);
  });

  test("preparer coupe à 50 éléments, appels compris, et le dit", () => {
    remplir("principal", 49);
    const appel = T.poster(t, "Bernard", "Antoine ?", "design");
    remplir("principal", 5);
    const p = T.preparer(t, "Antoine", T.selectionner(t, "Antoine"));
    expect([p.elements.length, p.reste, vue(p.elements)[0]]).toEqual([50, true, `a:${appel}`]);
    expect(T.preparer(t, "Antoine", T.selectionner(t, "Antoine"), { limite: 60 }).reste).toBe(false);
  });

  const curseur = (agent: string, fil: string) => t.get<{ d: number }>("SELECT dernier_id AS d FROM lectures WHERE agent = ? AND fil_id = ?", [agent, idFil(fil)])?.d ?? 0;

  test("O1 : dans un fil, la boîte ne livre que ce fil ; le reste n'est pas marqué lu et arrive après quitter", () => {
    T.poster(t, "Antoine", "bonjour");
    T.poster(t, "Bernard", "bonjour");
    T.entrer(t, "Antoine", "q-neige", "neige");
    T.entrer(t, "Bernard", "q-neige");
    const p = T.poster(t, "Cecile", "pendant ce temps", "principal");
    const q = T.poster(t, "Bernard", "dans le fil", "q-neige");
    expect(T.boite(t, "Antoine").messages.map((m) => m.id)).toEqual([q]);
    expect(T.boite(t, "Antoine").messages).toEqual([]);
    T.quitter(t, "Antoine");
    expect(T.boite(t, "Antoine").messages.map((m) => m.texte)).toEqual(["bonjour", "bonjour", "Antoine ouvre q-neige : neige", "pendant ce temps"]);
    expect(curseur("Antoine", "principal")).toBe(p);
  });

  test("acquitter (W1) : un lot brut de 60 messages suivi d'un lot résumé ; 50 éléments, curseur au 50e, rien de sauté", () => {
    const m = remplir("q-neige", 120); // taille 2 400 : deux lots de 60 messages
    const resume = (l: T.Lot) => (l.debut_id === m[60] ? "résumé du second lot" : undefined);
    const livres: number[] = [];
    const lire = () => {
      const p = T.preparer(t, "Antoine", T.selectionner(t, "Antoine"), { obtenirResume: resume, taille: 2400 });
      T.acquitter(t, "Antoine", p.elements);
      for (const e of p.elements) livres.push(...(e.type === "resume" ? m.filter((id) => id >= e.lot.debut_id && id <= e.lot.fin_id) : [e.message.id]));
      return p;
    };
    expect([lire().elements.length, curseur("Antoine", "q-neige")]).toEqual([50, m[49]]);
    const p2 = lire();
    expect([p2.elements.length, p2.reste, p2.elements.at(-1)!.type, curseur("Antoine", "q-neige")]).toEqual([11, false, "resume", m[119]]);
    expect(livres).toEqual(m);
  });

  test("acquitter : un appel livré est noté sans avancer le curseur au-delà d'un brut non livré ; dernier_id ne recule jamais", () => {
    remplir("principal", 55);
    const appel = T.poster(t, "Bernard", "Antoine ?", "principal"); // 56e : hors de la première page, sorti en tête
    const s = T.selectionner(t, "Antoine");
    const p = T.preparer(t, "Antoine", s);
    expect(p.elements[0]).toMatchObject({ type: "appel", message: { id: appel } });
    // une autre lecture du même agent passe entre-temps et lit tout
    T.acquitter(t, "Antoine", T.preparer(t, "Antoine", s, { limite: 100 }).elements);
    expect(curseur("Antoine", "principal")).toBe(appel);
    T.acquitter(t, "Antoine", p.elements); // la première lecture, en retard, n'a livré que 50 éléments
    expect(curseur("Antoine", "principal")).toBe(appel);
    expect(t.all("SELECT agent, message_id FROM appels_livres")).toEqual([{ agent: "Antoine", message_id: appel }]);
  });

  test("acquitter : l'appel sorti en tête ne fait pas sauter les bruts d'avant lui ; la page suivante ne le répète pas", () => {
    const m = remplir("principal", 55);
    const appel = T.poster(t, "Bernard", "Antoine ?", "principal");
    const b1 = T.boite(t, "Antoine");
    expect([b1.messages[0]!.id, b1.messages.length, b1.reste, curseur("Antoine", "principal")]).toEqual([appel, 50, true, m[48]]);
    expect(T.appelNonLu(t, "Antoine", ["Antoine"])).toBeUndefined(); // livré : il ne réveille plus
    const b2 = T.boite(t, "Antoine");
    expect([b2.messages.map((x) => x.id), b2.reste, curseur("Antoine", "principal")]).toEqual([m.slice(49), false, appel]);
  });

  test("l'exception par boite : l'appel en tête, l'agent reste dans son fil, la page suivante garde tous les fils", () => {
    T.poster(t, "Antoine", "bonjour");
    T.entrer(t, "Antoine", "q-neige", "neige");
    toutLu("Antoine");
    const d = remplir("design", 60);
    const appel = T.poster(t, "Bernard", "Antoine, tu relis le design ?", "principal");
    const memoire: T.MemoireLecture = {};
    const b1 = T.boite(t, "Antoine", undefined, 50, memoire);
    expect([b1.messages[0]!.id, b1.messages.length, b1.reste]).toEqual([appel, 50, true]);
    expect(T.filDe(t, "Antoine")?.fil).toBe("q-neige");
    const b2 = T.boite(t, "Antoine", undefined, 50, memoire);
    expect([b2.messages.map((m) => m.id), b2.reste]).toEqual([d.slice(49), false]);
    expect(curseur("Antoine", "principal")).toBe(appel);
    T.poster(t, "Cecile", "rien pour toi", "design");
    const q = T.poster(t, "Bernard", "dans le fil", "q-neige");
    expect(T.boite(t, "Antoine", undefined, 50, memoire).messages.map((m) => m.id)).toEqual([q]); // retour au seul fil
  });


  test("TAILLE_LOT vaut 8 000 caractères par défaut", () => {
    expect(T.TAILLE_LOT).toBe(8000);
  });
});

describe("fils de concentration : réveil d'un dormeur (26/09, O28, O35)", () => {
  beforeEach(() => {
    T.ouvrirRun(t, { id: "r", missionChemin: "m", missionTexte: "t", modele: "faux", plafondUsd: 1, silenceMin: 15 });
    for (const nom of ["Antoine", "Bernard", "Cecile"]) T.ajouterAgent(t, nom, `/b/${nom}`);
    for (const nom of ["Antoine", "Bernard"]) T.poster(t, nom, `bonjour de ${nom}`);
    T.boite(t, "Antoine"); // Antoine a tout lu avant d'entrer
    expect(T.entrer(t, "Antoine", "q-neige", "la neige tombe mal").ok).toBe(true);
    expect(T.entrer(t, "Bernard", "q-neige").ok).toBe(true);
    T.boite(t, "Antoine");
  });
  const reveilFil = (oui: boolean) => t.run("UPDATE presences SET reveil_fil = ? WHERE agent = 'Antoine'", [oui ? 1 : 0]);

  test("sans reveil_fil, seul le nom réveille ; le message du fil ne réveille pas", () => {
    T.poster(t, "Bernard", "la neige est blanche", "q-neige");
    expect(T.appelDormeur(t, "Antoine", ["Antoine"])).toBeUndefined();
    T.poster(t, "Cecile", "Antoine, tu relis la carte ?", "principal");
    expect(T.appelDormeur(t, "Antoine", ["Antoine"])).toMatchObject({ auteur: "Cecile", reveilFil: false });
  });

  test("avec reveil_fil, un message d'un autre dans son fil réveille ; le nom passe d'abord", () => {
    reveilFil(true);
    T.poster(t, "Antoine", "je regarde", "q-neige"); // le sien : non
    T.poster(t, "Cecile", "rien à voir", "principal"); // hors de son fil, sans son nom : non
    expect(T.appelDormeur(t, "Antoine", ["Antoine"])).toBeUndefined();
    const id = T.poster(t, "Bernard", "la neige est blanche", "q-neige");
    expect(T.appelDormeur(t, "Antoine", ["Antoine"])).toMatchObject({ id, fil: "q-neige", auteur: "Bernard", reveilFil: true });
    T.poster(t, "Cecile", "Antoine, tu relis ?", "principal");
    expect(T.appelDormeur(t, "Antoine", ["Antoine"])).toMatchObject({ auteur: "Cecile", reveilFil: false });
  });

  test("O35 : un message de mise en sommeil ne réveille pas par le fil ; ni la salle, ni un message lu ou déjà livré", () => {
    reveilFil(true);
    T.poster(t, "Bernard", "[en sommeil] j'attends la carte", "q-neige", { sommeil: true });
    T.poster(t, "salle", "q-neige : une annonce", "q-neige");
    expect(T.appelDormeur(t, "Antoine", ["Antoine"])).toBeUndefined();
    const lu = T.poster(t, "Bernard", "déjà lu", "q-neige");
    T.boite(t, "Antoine");
    expect(T.appelDormeur(t, "Antoine", ["Antoine"])?.id).not.toBe(lu);
    expect(T.appelDormeur(t, "Antoine", ["Antoine"])).toBeUndefined();
    const livre = T.poster(t, "Bernard", "la neige est blanche", "q-neige");
    t.run("INSERT INTO appels_livres(agent, message_id, livre_le) VALUES ('Antoine', ?, '2026-09-26T00:00:00Z')", [livre]);
    expect(T.appelDormeur(t, "Antoine", ["Antoine"])).toBeUndefined();
  });

  test("R6 : un message de mise en sommeil qui nomme un dormeur ne le réveille pas ; le même nom dans un message normal, si", () => {
    T.poster(t, "Bernard", "[en sommeil] Bernard en veille. Message adressé à Antoine/Cecile.", "principal", { sommeil: true });
    expect(T.appelNonLu(t, "Antoine", ["Antoine"])).toBeUndefined();
    expect(T.appelDormeur(t, "Antoine", ["Antoine"])).toBeUndefined();
    reveilFil(true);
    T.poster(t, "Bernard", "[en sommeil] Antoine, je dors", "q-neige", { sommeil: true });
    expect(T.appelDormeur(t, "Antoine", ["Antoine"])).toBeUndefined();
    const id = T.poster(t, "Cecile", "Antoine, la carte est prête", "principal");
    expect(T.appelDormeur(t, "Antoine", ["Antoine"])).toMatchObject({ id, reveilFil: false });
    // toujours lisible : la lecture le livre
    expect(T.boite(t, "Antoine").messages.map((m) => m.texte)).toContain("[en sommeil] Bernard en veille. Message adressé à Antoine/Cecile.");
  });

  test("hors d'un fil : le nom seulement", () => {
    expect(T.quitter(t, "Antoine").ok).toBe(true);
    T.poster(t, "Bernard", "la neige est blanche", "q-neige");
    expect(T.appelDormeur(t, "Antoine", ["Antoine"])).toBeUndefined();
  });
});

describe("fils de concentration : le coût des résumés (26/09, P7, W3, O41)", () => {
  test("budget compte lots.cout_usd ; parCote compte chaque lot de son côté", () => {
    T.ouvrirRun(t, { id: "r", missionChemin: "m", missionTexte: "t", modele: "a/h", modeleFemmes: "b/f", plafondUsd: 1, silenceMin: 15 });
    T.ajouterAgent(t, "Antoine", "/b/Antoine", "a/h", "hommes");
    T.ajouterAgent(t, "Bernard", "/b/Bernard", "a/h", "hommes");
    T.ajouterAgent(t, "Agathe", "/b/Agathe", "b/f", "femmes");
    T.majAgent(t, "Antoine", { coutUsd: 0.1 });
    T.majAgent(t, "Agathe", { coutUsd: 0.2 });
    const m = T.poster(t, "Antoine", "x".repeat(30), "q-neige");
    const f = t.get<{ id: number }>("SELECT id FROM fils WHERE nom = 'q-neige'")!.id;
    const lot = (debut: number, cote: string, cout: number, estime = 0) => t.run(
      "INSERT INTO lots(fil_id, debut_id, fin_id, etat, cout_usd, cout_estime, cote, demande_par, cree_le) VALUES (?, ?, ?, 'fait', ?, ?, ?, 'x', 'now')", [f, debut, m, cout, estime, cote]);
    lot(m, "femmes", 0.03, 1);
    lot(m - 1, "femmes", 0.01);
    lot(m - 2, "hommes", 0.005);
    expect(T.budget(t)).toEqual({ depense: 0.345, plafond: 1, reste: 0.655 });
    expect(T.parCote(t).map((c) => [c.cote, c.cout, c.coutEstime, c.agents])).toEqual([["hommes", 0.105, false, 2], ["femmes", 0.24, true, 1]]);
  });

  test("un tableau d'avant les fils, sans table lots : budget et parCote comme avant", () => {
    const ancien = ouvrirBun(join(dossier, "ancien.sqlite"));
    ancien.exec(T.SCHEMA.slice(0, T.SCHEMA.indexOf("-- Second cerveau")).replace(/CREATE TABLE IF NOT EXISTS lots[\s\S]*?UNIQUE\(fil_id, debut_id\)\);/, "").replace(/CREATE INDEX IF NOT EXISTS ix_lots_etat[^;]*;/, ""));
    expect(T.aTable(ancien, "lots")).toBe(false);
    T.ouvrirRun(ancien, { id: "r", missionChemin: "m", missionTexte: "t", modele: "a/h", plafondUsd: 1, silenceMin: 15 });
    T.ajouterAgent(ancien, "Antoine", "/b/Antoine", "a/h", "hommes");
    T.majAgent(ancien, "Antoine", { coutUsd: 0.1 });
    expect(T.budget(ancien)).toEqual({ depense: 0.1, plafond: 1, reste: 0.9 });
    expect(T.parCote(ancien).map((c) => c.cout)).toEqual([0.1]);
    ancien.fermer();
  });
});

// L'agent disponible : dans un run à rôles, un dormeur ne se réveille que pour un ticket qui
// lui est confié depuis qu'il dort, un message d'un autre qui ne s'adresse qu'à lui, ou un message du lanceur qui le nomme.
describe("le réveil adressé d'un run à rôles (29/09)", () => {
  const equipe = ["Antoine", "Hubert", "Jules", "Lucien", "Olivier"];
  const dort = (agent: string) => { T.insererMessage(t, agent, "[en sommeil] ma part est livrée", "principal", { sommeil: true }); T.endormir(t, agent); };
  beforeEach(() => {
    T.ouvrirRun(t, { id: "r", missionChemin: "m.md", missionTexte: "x", modele: "faux/faux", plafondUsd: 1, silenceMin: 15 });
    for (const nom of equipe) T.ajouterAgent(t, nom, `/tmp/${nom}`, undefined, undefined, { role: nom === "Antoine" ? "chef" : "constructeur" });
  });

  test("V1 : six listes de noms qui le citent ne le réveillent pas ; un ticket qui lui est confié le réveille", async () => {
    dort("Olivier");
    for (let i = 1; i <= 6; i++) T.poster(t, "Antoine", `Hubert/Jules/Lucien/Olivier : priorité ${i}, écrivez vos fichiers`);
    T.poster(t, "Antoine", "Hubert, Jules et Olivier : qui prend la gare ?");
    expect(T.appelDormeur(t, "Olivier", ["Olivier"], true)).toBeUndefined();
    expect(T.appelDormeur(t, "Olivier", ["Olivier"])?.auteur).toBe("Antoine"); // sans rôles : le nom cité réveille, comme avant
    await new Promise((r) => setTimeout(r, 2)); // maj_le du ticket strictement après la mise en veille
    const id = T.ouvrirTicket(t, { type: "bug", titre: "la gare flotte", description: "scene.js", auteur: "Antoine", charge: "Olivier" });
    expect(T.appelDormeur(t, "Olivier", ["Olivier"], true)).toMatchObject({ auteur: "Antoine", ticket: id, texte: `ticket #${id} confié à toi par Antoine : la gare flotte`, reveilFil: false });
  });

  test("une liste de noms en tête d'un message signé lanceur réveille chacun ; un agent cité dans le corps, non ; la même liste d'un agent, personne (02/10)", () => {
    dort("Olivier"); dort("Jules"); dort("Hubert");
    T.poster(t, "Antoine", "Olivier, Jules : la gare d'abord");
    expect(T.appelDormeur(t, "Olivier", ["Olivier"], true)).toBeUndefined();
    const id = T.poster(t, "lanceur", "Olivier, Jules : plan n°1 à revoir, selon la recette : la part d'Hubert n'a pas de preuve");
    expect(T.appelDormeur(t, "Olivier", ["Olivier"], true)).toMatchObject({ id, auteur: "lanceur" });
    expect(T.appelDormeur(t, "Jules", ["Jules"], true)).toMatchObject({ id, auteur: "lanceur" });
    expect(T.appelDormeur(t, "Hubert", ["Hubert"], true)).toBeUndefined();
  });

  test("un message qui ne s'adresse qu'à lui le réveille ; un ticket confié avant sa veille, non ; le lanceur qui le nomme, oui", async () => {
    T.ouvrirTicket(t, { type: "bug", titre: "vieux", description: "x", auteur: "Antoine", charge: "Olivier" });
    await new Promise((r) => setTimeout(r, 2));
    dort("Olivier");
    expect(T.appelDormeur(t, "Olivier", ["Olivier"], true)).toBeUndefined();
    T.poster(t, "Hubert", "la gare de Jules et d'Olivier est prête"); // cité en passant
    expect(T.appelDormeur(t, "Olivier", ["Olivier"], true)).toBeUndefined();
    T.poster(t, "essaim", "Olivier, Antoine : toute la salle dort et l'alerte #3 est ouverte.", "tickets");
    expect(T.appelDormeur(t, "Olivier", ["Olivier"], true)?.auteur).toBe("essaim");
    t.run("INSERT INTO appels_livres(agent, message_id, livre_le) SELECT 'Olivier', id, 'x' FROM messages WHERE auteur = 'essaim'");
    const id = T.poster(t, "Antoine", "Olivier : reprends la gare, s'il te plaît");
    expect(T.appelDormeur(t, "Olivier", ["Olivier"], true)).toMatchObject({ id, auteur: "Antoine", reveilFil: false });
  });
});
