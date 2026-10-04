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

// Les consignes du rôle : celles de la salle, où « pas de chef » cède la place au rôle, puis le fichier du
// rôle, {EQUIPE} rempli par le lanceur. Sans ## Type, les consignes sont celles d'avant, octet pour octet.
describe("les rôles : consignes du rôle dans les arguments de pi", () => {
  const missionTypee = (type: string) => { const p = join(racine, `mission-${type}.md`); writeFileSync(p, readFileSync(join(racineDepot, "tests", "fixtures", "hello-world.md"), "utf8") + `\n## Type\n\n${type}\n`); return p; };
  const consignesDe = (run: string, nom: string) => { const a = JSON.parse(readFileSync(join(run, "journal", `${nom}.args`), "utf8").trim().split("\n")[0]!).args as string[]; return a[a.indexOf("--append-system-prompt") + 1]!; };

  test("type jeu : chacun lit son rôle, sa mission, ses refus et toute l'équipe ; plus de « pas de chef »", async () => {
    process.env.ESSAIM_FIXTURE = fixture("hello-fini");
    process.env.ESSAIM_TOUR_MS = "0";
    const b = await lancer({ ...base(), agents: 5, mission: missionTypee("jeu") });
    const equipe = "Antoine est intégrateur, Bernard constructeur (suppléant de l'intégrateur), Claude constructeur, Denis constructeur, Edmond recette.";
    for (const [nom, role, fichier] of [["Antoine", "intégrateur", "integrateur"], ["Bernard", "constructeur", "constructeur"], ["Edmond", "recette", "recette"]] as const) {
      const c = consignesDe(b.run, nom);
      expect(c).toContain(`Tu es **${nom}**, un agent parmi **5**. Même mission pour tous ; ton rôle : **${role}**, décrit à la fin de ces consignes.`);
      expect(c).toContain("Les 5 agents partagent ces consignes de salle, chacun avec son rôle.");
      expect(c).not.toContain("même modèle et des mêmes consignes");
      expect(c).not.toContain("pas de chef");
      expect(c).toContain("et tu reprends dès qu'un ticket t'est confié ou qu'un autre agent s'adresse à toi seul. Veilles sans limite, et chaque réveil");
      expect(c).not.toContain("écrit ton nom");
      // Le réveil et les pancartes, tels que le code les applique dans un run à rôles.
      expect(c).toContain("**Un message réveille celui qui est en veille s'il s'adresse à lui seul** : son prénom en tête");
      expect(c).not.toContain("Écrire le prénom de quelqu'un");
      expect(c).toContain("celle d'un autre refuse tes `write` et `edit` sur ce fichier, et ce qu'un `bash` y écrit est annulé, sauf chez qui régénère le livrable");
      expect(c).not.toContain("elle n'empêche aucune écriture");
      expect(c).not.toContain("chacun parle à son tour"); // ni tour de parole ni attente de la moitié avec des rôles
      expect(c).not.toContain("une salle endormie est une salle finie");
      expect(c).toContain("Le lanceur constate la fin du run : accepté quand");
      const duRole = readFileSync(join(racineDepot, "src", "roles", `${fichier}.md`), "utf8").replaceAll("{EQUIPE}", equipe);
      expect(c.endsWith(duRole)).toBe(true);
      for (const g of ["{EQUIPE}", "{ROLE}", "{NOM}"]) expect(c).not.toContain(g);
    }
  });

  test("sans ## Type : consignes d'avant, sans rôle ni équipe", async () => {
    process.env.ESSAIM_FIXTURE = fixture("hello-fini");
    const c = consignesDe((await lancer(base())).run, "Antoine");
    expect(c).toContain("Tu es **Antoine**, un agent parmi **1**. Même mission pour tous, pas de chef.");
    expect(c).toContain("Cinq veilles au plus, et chaque réveil");
    expect(c).not.toContain("Ton rôle");
    expect(c).not.toContain("ton rôle");
    expect(c.trimEnd().endsWith("une salle endormie est une salle finie.")).toBe(true);
  });
});

// ---- Rôles de bout en bout (sans token) -------------------------------------------------------------------------------
// Un run à rôles complet au faux pi sur missions/exemples/roles-mini.md (type application, 8 sièges : Antoine chef,
// Bernard intégrateur, Claude, Denis, Edmond, Fabien constructeurs, Gaston recette, Hubert gardien-mesureur). Le chef range
// toutes les phrases en une exigence E1 tenue par la recette et confie deux parts ; Claude tente d'écrire la part de Denis
// (refusé par le crochet du rôle), puis écrit la sienne ; Gaston ouvre une alerte sur E1 ; Claude corrige et demande le
// rejeu ; le lanceur rejoue et ferme l'alerte « corrige » ; Gaston demande la preuve de E1 et l'atteste ; le lanceur
// constate le run accepté. Puis la même sonde où Claude ne corrige pas (incomplet), la même sans ## Type (bilan d'avant
// les rôles), et un run à 20 agents dont un siège passe à un prénom de la relève.
describe("rôles de bout en bout (phase 8, sans token)", () => {
  const rolesMini = join(racineDepot, "missions", "exemples", "roles-mini.md");
  const ecrire = (nom: string, lignes: object[]) => ecrireFixture(racine, nom, lignes);
  const CORRIGE = 'grep -q "n += 1" compteur.js';
  // La fin d'un write, que pi émet et qui fait commiter le lanceur (un write refusé ne commite rien).
  const finOutil = (id: string, outil: string) => ({ type: "tool_execution_end", toolCallId: id, toolName: outil, result: { content: [{ type: "text", text: "écrit" }] }, isError: false });
  const parcours = (o: { corrige: boolean }) => {
    const phrases = phrasesNumerotees(readFileSync(rolesMini, "utf8")).map((p) => p.n);
    process.env.ESSAIM_TOUR_MS = "0";
    process.env.ESSAIM_FIXTURE = ecrire("dort", DORMIR);
    // Un siège réveillé (le lanceur nomme le porteur d'une alerte, puis le chef) se rendort : sa fixture n'est jouée qu'une fois.
    process.env.ESSAIM_FIXTURE_PASSE_2 = process.env.ESSAIM_FIXTURE;
    process.env.ESSAIM_FIXTURE_PASSE_3 = process.env.ESSAIM_FIXTURE;
    process.env.ESSAIM_FIXTURE_ANTOINE = ecrire("chef", [
      appel("r1", "exigence_ranger", { phrases, classement: "exigence", responsable: "recette" }),
      appel("t1", "ticket_ouvrir", { type: "amelioration", titre: "le compteur", description: "le bouton Compter et son nombre", charge: "Claude", chemins: ["compteur.js"] }),
      appel("t2", "ticket_ouvrir", { type: "amelioration", titre: "le style", description: "la mise en page", charge: "Denis", chemins: ["style.css"] }),
      { type: "faux:toucher", chemin: "{RUN}/parts" }, ...DORMIR]);
    process.env.ESSAIM_FIXTURE_BERNARD = ecrire("integrateur", [
      appel("w1", "write", { path: "{PARTAGE}/index.html", content: '<h1>Bonjour</h1><p>Bienvenue.</p><button>Compter</button><script src="compteur.js"></script>' }), fin, ...DORMIR]);
    process.env.ESSAIM_FIXTURE_CLAUDE = ecrire("constructeur", [{ type: "faux:attendre", chemin: "{RUN}/parts" },
      appel("w1", "write", { path: "{PARTAGE}/style.css", content: "body { color: red }" }), // la part de Denis : refusé
      appel("w2", "write", { path: "{PARTAGE}/compteur.js", content: "let n = 0; n += 2;" }), finOutil("w2", "write"),
      { type: "faux:toucher", chemin: "{RUN}/v1" },
      ...(o.corrige ? [{ type: "faux:attendre", chemin: "{RUN}/alerte" },
        appel("w3", "write", { path: "{PARTAGE}/compteur.js", content: "let n = 0; n += 1;" }), finOutil("w3", "write"),
        { type: "faux:dormir", ms: 1000 }, // le temps que le lanceur commite : corrige veut un autre commit de main que l'alerte
        appel("m1", "ticket_modifier", { id: 3, motif: "corrige" }),
        { type: "faux:toucher", chemin: "{RUN}/corrige" }] : []),
      ...DORMIR]);
    process.env.ESSAIM_FIXTURE_DENIS = ecrire("style", [{ type: "faux:attendre", chemin: "{RUN}/parts" },
      appel("w1", "write", { path: "{PARTAGE}/style.css", content: "body { margin: 2em }" }), { type: "faux:toucher", chemin: "{RUN}/style" }, ...DORMIR]);
    process.env.ESSAIM_FIXTURE_GASTON = ecrire("recette", [{ type: "faux:attendre", chemin: "{RUN}/v1" },
      appel("a1", "ticket_ouvrir", { type: "bug", titre: "trois clics n'affichent pas 3", description: "le compteur avance de 2", charge: "Claude", sorte: "alerte", reproduction: { commande: CORRIGE }, exigence: "E1" }),
      { type: "faux:toucher", chemin: "{RUN}/alerte" },
      { type: "faux:attendre", chemin: "{RUN}/corrige" }, { type: "faux:attendre", chemin: "{RUN}/style" },
      appel("p1", "preuve_demander", { exigence: "E1", commande: 'grep -q Bonjour index.html && grep -q "n += 1" compteur.js' }),
      appel("p2", "preuve_attester", { exigence: "E1", recu: o.corrige ? "2" : "1", portee: "le titre et le pas du compteur, lus dans les fichiers" }),
      ...DORMIR]);
  };
  const resultats = (run: string, nom: string) => readFileSync(join(run, "journal", `${nom}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    .filter((l) => l.type === "tool_execution_end").map((l) => ({ outil: l.toolName as string, erreur: !!l.isError, texte: (l.result?.content ?? []).map((c: { text?: string }) => c.text ?? "").join("") as string }));

  test("accepté : sièges, parts confiées, refus du rôle, alerte corrigée par le rejeu, preuve attestée, fichier accepte", async () => {
    parcours({ corrige: true });
    const b = await lancer({ ...base(), agents: 8, plafond: 1, mission: rolesMini });
    expect(b).toMatchObject({ etat: "accepte", finis: 9, vires: 0, perdus: 0 }); // huit et le surveillant, en veille
    expect(b.raisonsEtat).toBeUndefined();
    expect(b.exigencesNonSatisfaites).toBeUndefined();
    expect(b.alertesOuvertes).toBeUndefined();
    expect(b.constat?.verification?.code).toBe(0);
    expect(existsSync(join(b.run, "accepte"))).toBe(true);
    expect(formaterBilan(b)).toContain("\nrun accepté");
    // Le refus du rôle : la part de Denis reste à Denis, sur disque comme dans le journal de Claude.
    expect(resultats(b.run, "Claude").find((r) => r.outil === "write")).toEqual({ outil: "write", erreur: true,
      texte: "refusé : style.css est la part de Denis. Se lève quand le chef te confie ce chemin, ou dans un essai (depot_essai) que Denis adopte." });
    expect(readFileSync(join(b.run, "partage", "style.css"), "utf8")).toBe("body { margin: 2em }");
    expect(readFileSync(join(b.run, "partage", "compteur.js"), "utf8")).toBe("let n = 0; n += 1;");
    expect(b.outils!.refus).toBeGreaterThanOrEqual(1);
    const t = lire(b.run);
    try {
      expect(t.all("SELECT nom, role, suppleant_de FROM agents ORDER BY rowid")).toEqual([
        { nom: "Antoine", role: "chef", suppleant_de: null }, { nom: "Bernard", role: "integrateur", suppleant_de: null },
        { nom: "Claude", role: "constructeur", suppleant_de: "integrateur" }, { nom: "Denis", role: "constructeur", suppleant_de: "chef" },
        { nom: "Edmond", role: "constructeur", suppleant_de: null }, { nom: "Fabien", role: "constructeur", suppleant_de: null },
        { nom: "Gaston", role: "recette", suppleant_de: null }, { nom: "Hubert", role: "gardien", suppleant_de: null },
        { nom: "Jules", role: "surveillant", suppleant_de: null }]);
      expect(t.all<{ raison_sortie: string }>("SELECT DISTINCT raison_sortie FROM agents")).toEqual([{ raison_sortie: "run accepté, constaté par le lanceur" }]);
      // Les parts : deux tickets de travail à chemins, les pancartes au nom des chargés (l'intégrateur tient le livrable).
      const tickets = T.listerTickets(t);
      expect(tickets.map((k) => [k.id, k.sorte, k.charge, k.chemins])).toEqual([[1, "travail", "Claude", '["compteur.js"]'], [2, "travail", "Denis", '["style.css"]'], [3, "alerte", "Claude", null]]);
      // L'alerte : fermée par le lanceur, motif corrige, sur le reçu du rejeu.
      const alerte = T.lireTicket(t, 3)!;
      expect([alerte.etat, alerte.motif, alerte.exigence]).toEqual(["ferme", "corrige", "E1"]);
      expect(P.lireRecu(b.run, "1")).toMatchObject({ sorte: "alerte", ticket: 3, passe: true });
      // La preuve de E1 : reçu du lanceur, attestée par la recette, non périmée.
      expect(P.lireRecu(b.run, "2")).toMatchObject({ sorte: "exigence", exigence: "E1", passe: true });
      expect(T.attestationDe(t, "E1")).toMatchObject({ agent: "Gaston", role: "recette", nature: "parcours", recu: "preuves/2.json" });
      expect(P.etatDesExigences(t, b.run).map((e) => [e.libelle, e.etat])).toEqual([["E1", "attestee"]]);
      expect(T.phrases(t).every((p) => p.classement !== null)).toBe(true);
      expect(t.get<{ resultat_resume: string }>("SELECT resultat_resume FROM evenements WHERE type = 'constat'")!.resultat_resume).toStartWith("run accepté");
    } finally {
      t.fermer();
    }
  }, 60_000);

  test("incomplet : l'alerte n'est jamais corrigée ; réveil du porteur puis du chef, E1 en défaut, alerte ouverte au bilan", async () => {
    parcours({ corrige: false });
    const b = await lancer({ ...base(), agents: 8, plafond: 1, mission: rolesMini });
    expect(b).toMatchObject({ etat: "incomplet", finis: 0, vires: 9 });
    expect(b.raisonsEtat![0]).toBe("salle endormie, alerte ouverte #3 sans personne pour la traiter");
    expect(b.alertesOuvertes).toEqual([{ ticket: 3, titre: "trois clics n'affichent pas 3", charge: "Claude", exigence: "E1" }]);
    // La preuve de E1 ne passe pas sur le compteur non corrigé : l'attestation est refusée, E1 reste à prouver.
    expect(b.exigencesNonSatisfaites).toEqual([{ libelle: "E1", etat: "à prouver", responsable: "recette", alertes: [3] }]);
    expect(resultats(b.run, "Gaston").find((r) => r.outil === "preuve_attester")!.texte).toBe("refusé : le reçu preuves/1.json ne passe pas (code 1). Se lève avec un reçu qui passe.");
    expect(existsSync(join(b.run, "accepte"))).toBe(false);
    expect(formaterBilan(b)).toContain("\nexigences non satisfaites : E1 (à prouver, alerte #3 ouverte)");
    const t = lire(b.run);
    const nommes = t.all<{ texte: string }>("SELECT texte FROM messages WHERE auteur = 'essaim' AND texte LIKE '%toute la salle dort%' ORDER BY id").map((m) => m.texte.split(" : ")[0]);
    t.fermer();
    expect(nommes).toEqual(["Claude", "Antoine"]);
  }, 60_000);

  test("la même sonde sans ## Type : ni rôle, ni refus du rôle, ni état du run ; bilan d'avant les rôles", async () => {
    parcours({ corrige: true });
    const mission = join(racine, "roles-mini-sans-type.md");
    writeFileSync(mission, readFileSync(rolesMini, "utf8").replace("## Type\n\napplication\n\n", ""));
    const b = await lancer({ ...base(), agents: 8, plafond: 1, mission });
    for (const cle of ["etat", "raisonsEtat", "exigencesNonSatisfaites", "alertesOuvertes", "rejeuxSansObjet", "passations", "lecons", "invalidees"]) expect(b).not.toHaveProperty(cle);
    expect(b).toMatchObject({ finis: 8, vires: 0, perdus: 0, endormis: 8 });
    expect(formaterBilan(b)).not.toContain("\nrun ");
    expect(existsSync(join(b.run, "preuves"))).toBe(false);
    // Sans rôle, aucun crochet : Claude écrit où il veut ; les outils des rôles n'existent pas, l'alerte (sans exigence
    // possible) et les parts sont refusées.
    expect(resultats(b.run, "Claude").filter((r) => r.outil === "write").every((r) => !r.erreur)).toBe(true);
    expect(resultats(b.run, "Gaston").find((r) => r.outil === "ticket_ouvrir")!.texte).toContain("aucune exigence E1");
    expect(resultats(b.run, "Antoine").find((r) => r.outil === "ticket_ouvrir")!.texte).toContain("aucun rôle ne répartit les parts dans ce run");
    const t = lire(b.run);
    expect(t.all<{ role: string | null }>("SELECT DISTINCT role FROM agents")).toEqual([{ role: null }]);
    t.fermer();
  }, 60_000);

  // 20 agents, type jeu : Antoine intégrateur, Bernard à Valentin constructeurs, Xavier recette ; tous les prénoms de
  // l'équipe sont pris. Thomas passe son siège : le lanceur le relance sous le premier prénom de la relève (Achille), qui
  // reçoit l'état du siège puis la note de Thomas.
  test("20 agents : un siège passé à un prénom de la relève, l'état du siège et la note livrés ; accepté", async () => {
    process.env.ESSAIM_TOUR_MS = "0";
    process.env.ESSAIM_FIXTURE = ecrire("dort", DORMIR);
    process.env.ESSAIM_FIXTURE_THOMAS = ecrire("passe", [appel("p1", "moi_passation", { note: "le moteur est à moitié fait", lecons: ["confier le moteur à un seul siège"] }), fin]);
    const mission = join(racine, "mission-jeu.md");
    writeFileSync(mission, "# Un compteur\n\nUne page avec un bouton qui compte les clics.\n\n## Type\n\njeu\n\n## C'est fini quand\n\nTrois clics affichent 3.\n");
    const b = await lancer({ ...base(), agents: 20, plafond: 1, mission });
    expect(b).toMatchObject({ etat: "accepte", finis: 21, vires: 0, perdus: 0 });
    expect(PRENOMS.every((p) => existsSync(join(b.run, "agents", p)))).toBe(true);
    expect(b.passations).toEqual([{ role: "constructeur", sortant: "Thomas", entrant: PRENOMS_RELEVE[0], motif: "passation du siège", note: true, livre: true }]);
    expect(b.lecons).toEqual([{ agent: "Thomas", role: "constructeur", date: expect.any(String), texte: "confier le moteur à un seul siège" }]);
    expect(formaterBilan(b)).toContain("\nsièges repris : constructeur de Thomas à Achille (passation du siège, avec sa note)");
    const t = lire(b.run);
    try {
      expect(t.get("SELECT role, remplace, etat FROM agents WHERE nom = 'Achille'")).toEqual({ role: "constructeur", remplace: "Thomas", etat: "fini" });
      expect(t.get<{ texte: string }>("SELECT texte FROM messages WHERE auteur = 'essaim' AND texte LIKE '[siège]%'")!.texte).toBe("[siège] Achille tient désormais le siège de constructeur de Thomas (passation).");
    } finally {
      t.fermer();
    }
    const premier = readFileSync(join(b.run, "journal", "Achille.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
      .find((l) => l.type === "message_end" && l.message?.role === "user").message.content[0].text as string;
    expect(premier).toContain("[siège] Tu prends le siège de constructeur que tenait Thomas (fini : passation du siège).");
    expect(premier).toContain("Note de passation de Thomas, déclaré par Thomas, non vérifié : « le moteur est à moitié fait »");
  }, 60_000);
});
