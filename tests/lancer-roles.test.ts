import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { lancer, formaterBilan, lireCompactage, lireMemoire, lireModeleRole, verifierCoupure, type Options } from "../src/lancer.ts";
import { ouvrirBun } from "../src/tableau-bun.ts";
import { nomAgent, PRENOMS, PRENOMS_FEMMES, PRENOMS_RELEVE, prenomLibre, repartir } from "../src/prenoms.ts";
import { nomsSalle, OUTILS_PI } from "../src/noms-outils.ts";
import * as T from "../src/tableau.ts";
import * as P from "../src/preuves.ts";
import { phrasesNumerotees } from "../src/mission.ts";
import { appel, DORMIR, ecrireFixture, fin } from "./aide/parcours.ts";

const racineDepot = resolve(import.meta.dir, "..");
const fixture = (nom: string) => join(racineDepot, "tests", "fixtures", `${nom}.jsonl`);
let racine: string;

const base = (): Options => ({ agents: 1, modele: "faux", plafond: 0.1, mission: join(racineDepot, "tests", "fixtures", "hello-world.md"), racine, sansBacASable: true });
const nettoyerEnv = () => { for (const k of Object.keys(process.env)) if (k.startsWith("ESSAIM_FIXTURE")) delete process.env[k]; delete process.env.ESSAIM_TOUR_MS; delete process.env.ESSAIM_GRACE_MS; delete process.env.ESSAIM_CHANGEMENTS_SIEGE_MAX; };
const lire = (run: string) => ouvrirBun(join(run, "tableau.sqlite"), { lectureSeule: true });
const agentEnBase = (run: string, nom: string) => { const t = lire(run); const a = t.get<Record<string, unknown>>("SELECT * FROM agents WHERE nom = ?", [nom]); t.fermer(); return a!; };

beforeEach(() => {
  racine = mkdtempSync(join(tmpdir(), "essaim-lancer-"));
  process.env.ESSAIM_PI = join(racineDepot, "tests", "faux-pi.ts");
  nettoyerEnv();
});
afterEach(() => { rmSync(racine, { recursive: true, force: true }); nettoyerEnv(); });

// Rôles des agents : une mission avec ## Type fait attribuer les sièges par le lanceur avant le premier
// message ; le rôle, le suppléant et le modèle du rôle arrivent à pi. Sans ## Type, rien ne change.
describe("les rôles : sièges, suppléants, modèle par rôle (R2)", () => {
  const missionTypee = (type: string) => { const p = join(racine, `mission-${type}.md`); writeFileSync(p, readFileSync(join(racineDepot, "tests", "fixtures", "hello-world.md"), "utf8") + `\n## Type\n\n${type}\n`); return p; };
  const lancements = (run: string, nom: string) => readFileSync(join(run, "journal", `${nom}.args`), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { args: string[]; env: Record<string, string> });
  const option = (a: string[], nom: string) => a[a.indexOf(nom) + 1];

  test("type jeu à 6 : sièges en base dans l'ordre des rôles, prénoms du calendrier, ESSAIM_ROLE et ESSAIM_SUPPLEANT_DE", async () => {
    process.env.ESSAIM_FIXTURE = fixture("hello-fini");
    process.env.ESSAIM_TOUR_MS = "0";
    process.env.ESSAIM_CHANGEMENTS_SIEGE_MAX = "0"; // les sièges de départ seulement (la relance d'un siège : tests/etat.test.ts)
    const b = await lancer({ ...base(), agents: 6, mission: missionTypee("jeu") });
    expect(b.finis).toBe(6); // l'intégrateur reste jusqu'au constat du lanceur, moi_finir lui est refusé ;
    const t = lire(b.run); // sans ticket, son tour muet le met en veille, fermée par le constat
    expect(t.get("SELECT etat, raison_sortie FROM agents WHERE nom = 'Antoine'")).toEqual({ etat: "fini", raison_sortie: "run accepté, constaté par le lanceur" });
    expect(t.all("SELECT nom, role, suppleant_de, cote FROM agents ORDER BY rowid")).toEqual([
      { nom: "Antoine", role: "integrateur", suppleant_de: null, cote: "hommes" },
      { nom: "Bernard", role: "constructeur", suppleant_de: "integrateur", cote: "hommes" },
      { nom: "Claude", role: "constructeur", suppleant_de: null, cote: "hommes" },
      { nom: "Denis", role: "constructeur", suppleant_de: null, cote: "hommes" },
      { nom: "Edmond", role: "constructeur", suppleant_de: null, cote: "hommes" },
      { nom: "Fabien", role: "recette", suppleant_de: null, cote: "hommes" }]);
    t.fermer();
    const env = (nom: string) => lancements(b.run, nom)[0]!.env;
    expect(env("Antoine").ESSAIM_ROLE).toBe("integrateur");
    expect(env("Antoine").ESSAIM_SUPPLEANT_DE).toBeUndefined();
    expect([env("Bernard").ESSAIM_ROLE, env("Bernard").ESSAIM_SUPPLEANT_DE]).toEqual(["constructeur", "integrateur"]);
    expect(env("Fabien").ESSAIM_ROLE).toBe("recette");
  });

  test("type application : le chef entre le premier, le gardien le dernier ; suppléants distincts", async () => {
    process.env.ESSAIM_FIXTURE = fixture("hello-fini");
    process.env.ESSAIM_TOUR_MS = "0";
    process.env.ESSAIM_CHANGEMENTS_SIEGE_MAX = "0";
    const b = await lancer({ ...base(), agents: 8, mission: missionTypee("application") });
    const t = lire(b.run);
    const rangs = t.all<{ nom: string; role: string; suppleant_de: string | null }>("SELECT nom, role, suppleant_de FROM agents ORDER BY rowid");
    t.fermer();
    // Le surveillant : en plus des huit demandés, le dernier, nommé par le premier prénom libre.
    expect(rangs.map((r) => r.role)).toEqual(["chef", "integrateur", "constructeur", "constructeur", "constructeur", "constructeur", "recette", "gardien", "surveillant"]);
    expect(rangs[0]!.nom).toBe("Antoine");
    expect(rangs[8]!.nom).toBe("Jules");
    expect(rangs.filter((r) => r.suppleant_de).map((r) => [r.nom, r.suppleant_de])).toEqual([["Claude", "integrateur"], ["Denis", "chef"]]);
  });

  // Le surveillant : vingt agents demandés en donnent vingt et un, le
  // surveillant prend le modèle du chef sans --modele-role surveillant, et n'est jamais lancé sans un signe (veille
  // initiale) ; sans chef (jeu), pas de surveillant.
  test("surveillant : en plus des vingt, modèle du chef, en veille sans passe pi ; absent sans chef", async () => {
    process.env.ESSAIM_FIXTURE = fixture("hello-fini");
    process.env.ESSAIM_TOUR_MS = "0";
    process.env.ESSAIM_CHANGEMENTS_SIEGE_MAX = "0";
    const b = await lancer({ ...base(), agents: 20, mission: missionTypee("application"), modeleRole: { chef: "faux-bis" } });
    const t = lire(b.run);
    const s = t.get<{ nom: string; modele: string }>("SELECT nom, modele FROM agents WHERE role = 'surveillant'")!;
    expect(t.get<{ n: number }>("SELECT count(*) AS n FROM agents")!.n).toBe(21);
    t.fermer();
    expect(s).toEqual({ nom: PRENOMS_RELEVE[0], modele: "faux/faux-bis" });
    expect(existsSync(join(b.run, "journal", `${s.nom}.args`))).toBe(false); // aucune passe pi
    const j = await lancer({ ...base(), agents: 5, mission: missionTypee("jeu") });
    const tj = lire(j.run);
    expect(tj.get("SELECT 1 FROM agents WHERE role = 'surveillant'")).toBeUndefined();
    tj.fermer();
    const r = await lancer({ ...base(), agents: 8, mission: missionTypee("application"), modeleRole: { chef: "faux-bis", surveillant: "faux" } });
    expect(agentEnBase(r.run, "Jules").modele).toBe("faux/faux");
  }, 60_000);

  // Réveillé par le chef qui le nomme en tête, Fabien (surveillant) tombe
  // sur une panne du fournisseur ; son siège est relancé, et son remplaçant entre en veille sans aucune passe pi.
  test("surveillant perdu puis relancé : le remplaçant entre en veille, sans passe pi", async () => {
    process.env.ESSAIM_FIXTURE = fixture("hello-fini");
    process.env.ESSAIM_FIXTURE_ANTOINE = ecrireFixture(racine, "chef-reveille", [appel("p1", "salle_poster", { texte: "Fabien : regarde le run" }), ...readFileSync(fixture("hello-fini"), "utf8").trim().split("\n").map((l) => JSON.parse(l))]);
    process.env.ESSAIM_FIXTURE_FABIEN = fixture("erreur-fournisseur");
    process.env.ESSAIM_TOUR_MS = "0";
    const b = await lancer({ ...base(), agents: 5, mission: missionTypee("document") });
    const t = lire(b.run);
    const remplacant = t.get<{ nom: string; etat: string; remplace: string }>("SELECT nom, etat, remplace FROM agents WHERE role = 'surveillant' AND remplace = 'Fabien'")!;
    t.fermer();
    expect(agentEnBase(b.run, "Fabien").etat).toBe("perdu");
    expect(remplacant.remplace).toBe("Fabien");
    expect(existsSync(join(b.run, "journal", `${remplacant.nom}.args`))).toBe(false); // aucune passe pi
  }, 60_000);

  test("--modele-role : le modèle d'un rôle ; les autres gardent --modele", async () => {
    process.env.ESSAIM_FIXTURE = fixture("hello-fini");
    process.env.ESSAIM_TOUR_MS = "0";
    const b = await lancer({ ...base(), agents: 5, mission: missionTypee("jeu"), modeleRole: { recette: "faux-bis" } });
    expect(option(lancements(b.run, "Edmond")[0]!.args, "--model")).toBe("faux/faux-bis");
    for (const nom of ["Antoine", "Bernard", "Claude", "Denis"]) expect(option(lancements(b.run, nom)[0]!.args, "--model")).toBe("faux/faux");
    expect(agentEnBase(b.run, "Edmond").modele).toBe("faux/faux-bis");
  });

  test("refus avant le verrou : sous le minimum du type, --modele-femmes avec des rôles, --modele-role sans type, alias inconnu", async () => {
    await expect(lancer({ ...base(), agents: 4, mission: missionTypee("jeu") })).rejects.toThrow("au moins 5 agents pour le type jeu");
    await expect(lancer({ ...base(), agents: 5, mission: missionTypee("jeu"), modeleFemmes: "faux-bis" })).rejects.toThrow("avec des rôles, le modèle se choisit par rôle : --modele-role");
    await expect(lancer({ ...base(), modeleRole: { recette: "faux-bis" } })).rejects.toThrow("--modele-role demande une mission avec une section « ## Type »");
    await expect(lancer({ ...base(), agents: 5, mission: missionTypee("jeu"), modeleRole: { recette: "pas-un-alias" } })).rejects.toThrow("--modele-role recette pas-un-alias");
    expect(existsSync(join(racine, "runs", ".verrou"))).toBe(false);
    expect(existsSync(join(racine, "runs")) ? readdirSync(join(racine, "runs")) : []).toEqual([]);
  });

  test("le livrable (## Livrable) porte la pancarte de l'intégrateur, posée avant le premier message (R3)", async () => {
    process.env.ESSAIM_FIXTURE = fixture("hello-fini");
    process.env.ESSAIM_TOUR_MS = "0";
    const b = await lancer({ ...base(), agents: 8, mission: join(racineDepot, "missions", "exemples", "roles-mini.md") });
    const t = lire(b.run);
    const premiere = t.get<{ id: number; chemin: string; agent: string; raison: string }>("SELECT id, chemin, agent, raison FROM reclamations ORDER BY id LIMIT 1");
    const premierMessage = t.get<{ cree_le: string }>("SELECT cree_le FROM messages ORDER BY id LIMIT 1");
    const pose = t.get<{ pose_le: string }>("SELECT pose_le FROM reclamations ORDER BY id LIMIT 1")!.pose_le;
    t.fermer();
    expect(premiere).toEqual({ id: 1, chemin: "index.html", agent: "Bernard", raison: "le livrable (## Livrable)" });
    expect(pose <= premierMessage!.cree_le).toBe(true);
  });

  test("assembleur (02/10) : avec un agent de plus que le gabarit, il entre après l'intégrateur et porte la pancarte du livrable ; sa fiche lui est donnée", async () => {
    process.env.ESSAIM_FIXTURE = fixture("hello-fini");
    process.env.ESSAIM_TOUR_MS = "0";
    const b = await lancer({ ...base(), agents: 9, mission: join(racineDepot, "missions", "exemples", "roles-mini.md") });
    const t = lire(b.run);
    const roles = t.all<{ nom: string; role: string }>("SELECT nom, role FROM agents ORDER BY rowid").slice(0, 3);
    const premiere = t.get<{ chemin: string; agent: string }>("SELECT chemin, agent FROM reclamations ORDER BY id LIMIT 1");
    t.fermer();
    expect(roles).toEqual([{ nom: "Antoine", role: "chef" }, { nom: "Bernard", role: "integrateur" }, { nom: "Claude", role: "assembleur" }]);
    expect(premiere).toEqual({ chemin: "index.html", agent: "Claude" });
    const consignes = readFileSync(join(b.run, "journal", "Claude.args"), "utf8");
    expect(consignes).toContain("## Ton rôle : assembleur");
    expect(consignes).toContain("Claude assembleur");
  });

  // Rôles : Antoine (intégrateur d'un jeu, qui répartit) confie le moteur à Claude ; Claude, qui ne finit
  // pas (moi_finir refusé tant qu'il porte le ticket), est perdu au bout de ses passes : le ticket et sa pancarte passent
  // à Antoine, toujours là. Antoine, perdu à son tour, le passe à Bernard, son suppléant, si Bernard est encore dans la
  // salle (il peut avoir fini avant l'ouverture du ticket : l'ordre dépend des lancements).
  test("un constructeur perdu ne laisse pas de ticket orphelin : ticket et pancarte vont à celui qui répartit (R5)", async () => {
    process.env.ESSAIM_FIXTURE = fixture("hello-fini");
    process.env.ESSAIM_FIXTURE_ANTOINE = fixture("confie-puis-attend");
    process.env.ESSAIM_FIXTURE_CLAUDE = fixture("attend-confie");
    process.env.ESSAIM_FIXTURE_PASSE_2 = fixture("hello-fini");
    process.env.ESSAIM_FIXTURE_PASSE_3 = fixture("hello-fini");
    process.env.ESSAIM_TOUR_MS = "0";
    process.env.ESSAIM_CHANGEMENTS_SIEGE_MAX = "0"; // aucun siège relancé : les tickets vont à celui qui répartit
    const b = await lancer({ ...base(), agents: 5, mission: missionTypee("jeu") });
    const t = lire(b.run);
    const etats = Object.fromEntries(t.all<{ nom: string; etat: string }>("SELECT nom, etat FROM agents").map((a) => [a.nom, a.etat]));
    const ticket = T.lireTicket(t, 1)!;
    const faits = t.all<{ texte: string }>("SELECT texte FROM faits WHERE type IN ('ticket', 'pancarte') ORDER BY id").map((f) => f.texte);
    t.fermer();
    expect(etats).toMatchObject({ Antoine: "perdu", Claude: "perdu" });
    expect(ticket.etat).toBe("ouvert"); // transférer ne ferme jamais
    const transferts = ticket.notes.filter((n) => n.texte.startsWith("transféré")).map((n) => n.texte);
    expect(transferts[0]).toBe("transféré de Claude à Antoine (perdu : passes épuisées)");
    expect(faits).toContain("ticket #1 transféré de Claude à Antoine · perdu : passes épuisées");
    expect(faits).toContain("pancarte · jeu.js · Antoine · « transfert du ticket #1 »");
    expect(transferts.slice(1)).toEqual(ticket.charge === "Bernard" ? ["transféré d'Antoine à Bernard (perdu : passes épuisées)"] : []);
    expect(ticket.charge).toBe(transferts.length === 2 ? "Bernard" : "Antoine");
  }, 30_000);

  // Claude, constructeur qui a livré, dort ; Antoine
  // (l'intégrateur, qui répartit) poste six listes de noms qui le citent, puis lui confie un ticket. Claude ne se réveille
  // qu'une fois, sur le ticket, et le message de réveil le dit.
  test("V1 : un dormeur n'est pas réveillé par des listes de noms, mais par un ticket qui lui est confié", async () => {
    process.env.ESSAIM_FIXTURE = fixture("hello-fini");
    process.env.ESSAIM_FIXTURE_CLAUDE = ecrireFixture(racine, "claude-dort", [appel("c1", "salle_poster", { texte: "ma part est livrée" }), appel("c2", "moi_dormir", { message: "ma part est livrée" }), { type: "faux:toucher", chemin: "{RUN}/dort" }, fin]);
    process.env.ESSAIM_FIXTURE_ANTOINE = ecrireFixture(racine, "antoine-listes", [{ type: "faux:attendre", chemin: "{RUN}/dort" },
      { type: "faux:dormir", ms: 1000 }, // le lanceur met Claude en veille, même sous charge (--parallel)
      ...[1, 2, 3, 4, 5, 6].map((i) => appel(`l${i}`, "salle_poster", { texte: `Bernard/Denis/Claude/Edmond : priorité ${i}, écrivez vos fichiers` })),
      { type: "faux:dormir", ms: 400 },
      appel("t1", "ticket_ouvrir", { type: "bug", titre: "la carte est vide", description: "index.html", charge: "Claude" }),
      appel("d1", "moi_dormir", { message: "ticket confié" }), fin]);
    process.env.ESSAIM_FIXTURE_PASSE_2 = ecrireFixture(racine, "dormir-deux", DORMIR);
    process.env.ESSAIM_TOUR_MS = "0";
    process.env.ESSAIM_CHANGEMENTS_SIEGE_MAX = "0";
    const b = await lancer({ ...base(), agents: 5, mission: missionTypee("jeu") });
    const t = lire(b.run);
    const reveils = t.all<{ resultat_resume: string }>("SELECT resultat_resume FROM evenements WHERE agent = 'Claude' AND type = 'reveil'").map((e) => e.resultat_resume);
    t.fermer();
    expect(reveils).toEqual(["réveillé par Antoine : ticket #1 confié à toi par Antoine : la carte est vide"]);
    const relance = lancements(b.run, "Claude")[1]!.args;
    expect(relance[relance.length - 1]).toStartWith("Tu étais en veille. Ticket #1 confié à toi par Antoine : « la carte est vide ».");
  }, 30_000);

  // Un constructeur sans ticket qui s'arrête sans rien
  // appeler n'est jamais « perdu » : le lanceur le met en veille sans consommer de passe, et aucune relève ne vient.
  const silence = (id: string) => [{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `Rien à faire (${id}).` }], api: "openai-completions", provider: "openrouter", model: "google/gemini-3.8-flash", usage: { input: 500, output: 40, cacheRead: 0, cacheWrite: 0, totalTokens: 540, cost: { input: 0.0005, output: 0.0001, cacheRead: 0, cacheWrite: 0, total: 0.0006 } }, stopReason: "stop", timestamp: 0 } }, fin];
  test("V3 : un constructeur sans ticket qui se tait trois fois est en veille, jamais perdu, sans relève", async () => {
    process.env.ESSAIM_FIXTURE = fixture("hello-fini");
    process.env.ESSAIM_FIXTURE_CLAUDE = ecrireFixture(racine, "claude-muet", silence("claude"));
    process.env.ESSAIM_FIXTURE_BERNARD = ecrireFixture(racine, "bernard-appelle", [{ type: "faux:dormir", ms: 1500 },
      appel("b1", "salle_poster", { texte: "Claude : as-tu fini ta part ?" }), { type: "faux:dormir", ms: 1500 },
      appel("b2", "salle_poster", { texte: "Claude : et maintenant ?" }), { type: "faux:dormir", ms: 1500 },
      appel("b3", "moi_finir", { raison: "ma part est faite" }), fin]);
    process.env.ESSAIM_FIXTURE_PASSE_2 = ecrireFixture(racine, "muet-2", silence("2"));
    process.env.ESSAIM_FIXTURE_PASSE_3 = ecrireFixture(racine, "muet-3", silence("3"));
    process.env.ESSAIM_TOUR_MS = "0";
    const b = await lancer({ ...base(), agents: 5, mission: missionTypee("jeu") });
    const t = lire(b.run);
    const claude = t.get<{ etat: string; raison_sortie: string; passes: number }>("SELECT etat, raison_sortie, passes FROM agents WHERE nom = 'Claude'")!;
    const types = t.all<{ type: string }>("SELECT type FROM evenements WHERE agent = 'Claude' AND type IN ('disponible', 'reveil', 'relance') ORDER BY id").map((e) => e.type);
    const successions = t.get<{ n: number }>("SELECT count(*) AS n FROM evenements WHERE type = 'succession'")!.n;
    const veille = t.get<{ n: number }>("SELECT count(*) AS n FROM messages WHERE auteur = 'Claude' AND sommeil = 1 AND texte = '[en sommeil] disponible'")!.n;
    t.fermer();
    expect(claude.etat).not.toBe("perdu");
    expect(claude.raison_sortie).not.toContain("passes épuisées");
    expect(claude.passes).toBe(1);
    expect(types).toEqual(["disponible", "reveil", "disponible", "reveil", "disponible"]);
    expect(veille).toBe(3);
    expect(successions).toBe(0);
    expect(lancements(b.run, "Claude").length).toBe(3);
  }, 30_000);

  // Le garde-fou demeure. Un constructeur qui porte un ticket ouvert et se tait trois fois est perdu.
  test("V5 : un constructeur qui porte un ticket ouvert et se tait trois fois est perdu", async () => {
    process.env.ESSAIM_FIXTURE = fixture("hello-fini");
    process.env.ESSAIM_FIXTURE_ANTOINE = fixture("confie-puis-attend");
    process.env.ESSAIM_FIXTURE_CLAUDE = fixture("attend-confie");
    process.env.ESSAIM_FIXTURE_PASSE_2 = ecrireFixture(racine, "muet-2", silence("2"));
    process.env.ESSAIM_FIXTURE_PASSE_3 = ecrireFixture(racine, "muet-3", silence("3"));
    process.env.ESSAIM_TOUR_MS = "0";
    process.env.ESSAIM_CHANGEMENTS_SIEGE_MAX = "0";
    const b = await lancer({ ...base(), agents: 5, mission: missionTypee("jeu") });
    const t = lire(b.run);
    const claude = t.get<{ etat: string; raison_sortie: string; passes: number }>("SELECT etat, raison_sortie, passes FROM agents WHERE nom = 'Claude'")!;
    const disponible = t.get<{ n: number }>("SELECT count(*) AS n FROM evenements WHERE agent = 'Claude' AND type = 'disponible'")!.n;
    t.fermer();
    expect(claude).toEqual({ etat: "perdu", raison_sortie: "passes épuisées", passes: 3 });
    expect(disponible).toBe(0);
  }, 30_000);

  test("sans ## Type : ni rôle en base, ni ESSAIM_ROLE, comme avant", async () => {
    process.env.ESSAIM_FIXTURE = fixture("hello-fini");
    const b = await lancer(base());
    expect(agentEnBase(b.run, "Antoine")).toMatchObject({ role: null, suppleant_de: null });
    const env = lancements(b.run, "Antoine")[0]!.env;
    expect(env.ESSAIM_ROLE).toBeUndefined();
    expect(env.ESSAIM_SUPPLEANT_DE).toBeUndefined();
  });

  test("lireModeleRole : ROLE=ALIAS, répétable ; rôle inconnu, forme fausse ou rôle en double refusés ; --help le documente", () => {
    expect(lireModeleRole(["recette=faux-bis", "chef=faux"])).toEqual({ recette: "faux-bis", chef: "faux" });
    expect(() => lireModeleRole(["designer=faux"])).toThrow("--modele-role attend ROLE=ALIAS");
    expect(() => lireModeleRole(["recette"])).toThrow("--modele-role attend ROLE=ALIAS");
    expect(() => lireModeleRole(["recette=a", "recette=b"])).toThrow("deux modèles pour le rôle recette");
    const aide = Bun.spawnSync(["bun", join(racineDepot, "src", "lancer.ts"), "--help"]).stdout.toString();
    expect(aide).toContain("--modele-role ROLE=ALIAS");
    expect(aide).toContain("## Type");
    expect(aide).toContain("ESSAIM_CHANGEMENTS_SIEGE_MAX");
  });
});

