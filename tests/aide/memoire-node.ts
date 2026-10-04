// Aide de test (second cerveau) : sous Node, comme l'extension dans pi, ouvre le
// tableau avec node:sqlite et exerce ce que chaque phase fait tourner dans pi ; imprime un JSON, une clé par section.
// Lancé par node --no-warnings --experimental-strip-types tests/aide/memoire-node.ts <base> [sections] [partage], comme
// tests/aide/fils-node.ts. sections : liste séparée par des virgules (« 6 »), toutes par défaut. Une section par phase
// (3, 5, 6, 7), chacune dans son bloc : les sections ne se croisent pas.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ouvrirNode } from "../../src/tableau-node.ts";
import * as T from "../../src/tableau.ts";
import extension from "../../src/outils-essaim.ts";
import { fauxPi } from "./faux-extension-api.ts";

const chemin = process.argv[2]!;
const sections = new Set((process.argv[3] ?? "3,5,6,7").split(","));
const sortie: Record<string, unknown> = {};
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- phase 3 : les faits du tableau écrits par les quatre fonctions que l'extension appelle (endormir, reclamer,
// liberer, fini), chacune dans sa transaction, sans transaction englobante.
if (sections.has("3")) {
  const t = ouvrirNode(chemin);
  T.initialiser(t);
  T.ouvrirRun(t, { id: "run-node", missionChemin: "m.md", missionTexte: "mission", modele: "faux/faux", plafondUsd: 0.5, silenceMin: 15 });
  for (const a of ["agent-01", "agent-02"]) T.ajouterAgent(t, a, `/tmp/bureau-${a}`);
  process.env.ESSAIM_TABLEAU = chemin;
  const instance = (agent: string) => {
    process.env.ESSAIM_AGENT = agent;
    const pi = fauxPi();
    extension(pi.api); // ouvrirNode, comme pi
    return pi;
  };
  const a1 = instance("agent-01");
  await a1.texte("fichier_reclamer", { chemin: "app.js", raison: "le menu" });
  await a1.texte("fichier_liberer", { chemin: "app.js" });
  await a1.texte("moi_dormir", { message: "j'attends" });
  T.reveiller(t, "agent-01"); // le lanceur le relance
  await a1.texte("moi_finir", { raison: "fait" });
  sortie.phase3 = { faits: t.all<{ texte: string }>("SELECT texte FROM faits ORDER BY id").map((f) => f.texte) };
  t.fermer();
}

// ---- phase 5 : code_tester écrit son fait de vérification, et le blob calculé égale celui de git ; le dossier
// partagé est le quatrième argument (à côté du tableau par défaut).
if (sections.has("5")) {
  const partage = process.argv[4] ?? join(dirname(chemin), "partage");
  mkdirSync(partage, { recursive: true });
  const t = ouvrirNode(chemin);
  T.initialiser(t);
  process.env.ESSAIM_AGENT = "Bernard";
  process.env.ESSAIM_TABLEAU = chemin;
  process.env.ESSAIM_PARTAGE = partage;
  writeFileSync(join(partage, "n.test.ts"), 'import { test, expect } from "bun:test";\ntest("un", () => expect(1).toBe(1));\n');
  const pi = fauxPi();
  extension(pi.api); // ouvrirNode, comme pi
  const texte = await pi.texte("code_tester", {});
  const f = t.get<{ statut: string; texte: string; details_json: string }>("SELECT statut, texte, details_json FROM faits WHERE type = 'verification' AND source = 'code_tester' ORDER BY id DESC LIMIT 1");
  const apres = f ? (JSON.parse(f.details_json).apres as Record<string, { blob: string }>) : {};
  const git = spawnSync("git", ["hash-object", join(partage, "n.test.ts")], { encoding: "utf8" }).stdout.trim();
  sortie.phase5 = { texte, statut: f?.statut, fait: f?.texte, blobEgal: apres["n.test.ts"]?.blob === git };
  t.fermer();
}

// ---- phase 6 : FTS5 sous node:sqlite, l'index rempli par déclencheur depuis l'extension, salle_chercher ; des
// messages postés pendant que le test, sous Bun, écrit des commits dans la même base (les deux passent).
if (sections.has("6")) {
  const memoire = ouvrirNode(":memory:");
  memoire.exec("CREATE VIRTUAL TABLE essai USING fts5(texte, tokenize = 'unicode61 remove_diacritics 2')");
  memoire.run("INSERT INTO essai(texte) VALUES (?)", ["l'élève lit navigation.js"]);
  const fts = memoire.get<{ extrait: string; rang: number }>(
    "SELECT snippet(essai, 0, '[', ']', '…', 12) AS extrait, bm25(essai) AS rang FROM essai WHERE essai MATCH 'eleve'");
  memoire.fermer();

  const t = ouvrirNode(chemin);
  T.initialiser(t);
  if (!t.get("SELECT 1 FROM agents WHERE nom = 'agent-01'")) T.ajouterAgent(t, "agent-01", "/tmp/agent-01");
  process.env.ESSAIM_AGENT = "agent-01";
  process.env.ESSAIM_TABLEAU = chemin;
  delete process.env.ESSAIM_MEMOIRE;
  const pi = fauxPi();
  extension(pi.api); // ouvrirNode, comme pi
  const poste = await pi.texte("salle_poster", { texte: "l'élève a réécrit navigation.js" });
  const trouve = await pi.texte("salle_chercher", { mots: "eleve navigation.js" });
  const numero = await pi.texte("salle_chercher", { numero: 1 });
  const refus = await pi.texte("salle_chercher", {});
  const n = Number(process.env.ESSAIM_NODE_POSTES ?? 40);
  for (let i = 0; i < n; i++) { T.poster(t, "agent-01", `poste sous node ${i}`); await dormir(2); }
  sortie.phase6 = { fts: fts ? { extrait: fts.extrait, rang: typeof fts.rang } : null, poste, trouve, numero, refus, postes: n };
  t.fermer();
}

// ---- phase 7 : l'état construit par le gestionnaire input d'une relance, et la ligne courte, sous node:sqlite comme dans
// pi. Autonome : sa connexion, initialiser, agent-01 et agent-02 créés s'ils manquent.
if (sections.has("7")) {
  const partage = process.argv[4] ?? join(dirname(chemin), "partage");
  mkdirSync(partage, { recursive: true });
  const t = ouvrirNode(chemin);
  T.initialiser(t);
  if (!t.get("SELECT 1 FROM run")) T.ouvrirRun(t, { id: "run-node", missionChemin: "m.md", missionTexte: "mission", modele: "faux/faux", plafondUsd: 0.5, silenceMin: 15 });
  for (const a of ["agent-01", "agent-02"]) if (!t.get("SELECT 1 FROM agents WHERE nom = ?", [a])) T.ajouterAgent(t, a, `/tmp/bureau-${a}`);
  T.reclamer(t, "agent-02", "menu.js", "sous node");
  Object.assign(process.env, { ESSAIM_AGENT: "agent-01", ESSAIM_TABLEAU: chemin, ESSAIM_PARTAGE: partage, ESSAIM_RELANCE: "reveil" });
  delete process.env.ESSAIM_MEMOIRE;
  const pi = fauxPi();
  extension(pi.api); // ouvrirNode, comme pi
  const etat = await pi.saisir("Tu étais en veille.");
  T.sortirAgent(t, "agent-02", "perdu", "silence");
  const ligne = await pi.texte("salle_budget", {});
  const livraisons = t.all<{ moment: string; confirme_le: string | null }>("SELECT moment, confirme_le FROM memoire_livraisons WHERE agent = 'agent-01' ORDER BY id")
    .map((l) => [l.moment, l.confirme_le !== null]);
  delete process.env.ESSAIM_RELANCE;
  sortie.phase7 = { etat, ligne, livraisons, erreurs: pi.erreurs };
  t.fermer();
}

console.log(JSON.stringify(sortie));
