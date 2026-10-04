// Dans un run à rôles, l'écriture par bash dans le fichier qui porte la pancarte d'un autre est annulée par le
// lanceur, et son auteur l'apprend par sa ligne courte. La ligne courte porte aussi ce qui concerne l'agent lui-même (messages qui s'adressent à lui, ticket et pancarte passés à un autre).
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { lancer, type Options } from "../src/lancer.ts";
import { ouvrirBun } from "../src/tableau-bun.ts";
import * as T from "../src/tableau.ts";
import * as D from "../src/depot.ts";
import extension from "../src/outils-essaim.ts";
import { fauxPi } from "./aide/faux-extension-api.ts";
import { appel, DORMIR, ecrireFixture, fin } from "./aide/parcours.ts";

const racineDepot = resolve(import.meta.dir, "..");

// ---- L'annulation des écritures par bash, au faux pi----------------------------------------------------------------
describe("O1 : une écriture par bash dans le fichier d'un autre est annulée (au faux pi)", () => {
  let racine: string;
  const nettoyer = () => { for (const k of Object.keys(process.env)) if (k.startsWith("ESSAIM_FIXTURE")) delete process.env[k]; delete process.env.ESSAIM_TOUR_MS; };
  beforeEach(() => {
    racine = mkdtempSync(join(tmpdir(), "essaim-bash-"));
    nettoyer();
    process.env.ESSAIM_PI = join(racineDepot, "tests", "faux-pi.ts");
    process.env.ESSAIM_TOUR_MS = "0";
  });
  afterEach(() => { rmSync(racine, { recursive: true, force: true }); nettoyer(); });

  const mission = (type?: string) => {
    const p = join(racine, `mission-${type ?? "sans"}.md`);
    writeFileSync(p, readFileSync(join(racineDepot, "tests", "fixtures", "hello-world.md"), "utf8") + (type ? `\n## Type\n\n${type}\n` : ""));
    return p;
  };
  const base = (o: Partial<Options> = {}): Options => ({ agents: 2, modele: "faux", plafond: 0.5, mission: mission("fichier"), racine, sansBacASable: true, ...o });
  const fixture = (nom: string, lignes: object[]) => ecrireFixture(racine, nom, lignes);
  const git = (run: string, ...args: string[]) => execFileSync("git", ["-C", join(run, "partage"), ...args], { encoding: "utf8" }).trim();
  const auteurs = (run: string, chemin: string) => git(run, "log", "--format=%an", "--", chemin).split("\n").filter(Boolean);
  // Le texte rendu par un outil, lu dans le journal de l'agent (tool_execution_end émis par le faux pi).
  const resultat = (run: string, agent: string, id: string) => {
    const l = readFileSync(join(run, "journal", `${agent}.jsonl`), "utf8").trim().split("\n").map((x) => JSON.parse(x))
      .find((x) => x.type === "tool_execution_end" && x.toolCallId === id);
    return (l?.result?.content ?? []).map((c: { text?: string }) => c.text ?? "").join("\n") as string;
  };
  const ecrire = (id: string, chemin: string, contenu: string) => [
    { type: "tool_execution_start", toolCallId: id, toolName: "write", args: { path: `{PARTAGE}/${chemin}`, content: contenu } },
    { type: "tool_execution_end", toolCallId: id, toolName: "write", result: { content: [{ type: "text", text: "écrit" }] }, isError: false },
  ];
  const bashDebut = (id: string, commande: string) => ({ type: "tool_execution_start", toolCallId: id, toolName: "bash", args: { command: commande } });
  const bashFin = (id: string) => ({ type: "tool_execution_end", toolCallId: id, toolName: "bash", result: { content: [{ type: "text", text: "" }] }, isError: false });
  const par = (chemin: string, contenu: string) => ({ type: "faux:ecrire", chemin: `{PARTAGE}/${chemin}`, contenu });
  const attendre = (nom: string) => ({ type: "faux:attendre", chemin: `{RUN}/${nom}` });
  const toucher = (nom: string) => ({ type: "faux:toucher", chemin: `{RUN}/${nom}` });
  const pause = (ms: number) => ({ type: "faux:dormir", ms });
  const finir = [appel("f1", "moi_finir", { raison: "ma part est faite" }), fin];
  const lire = (run: string) => ouvrirBun(join(run, "tableau.sqlite"), { lectureSeule: true });

  // Type fichier : Antoine et Bernard, constructeurs, chacun pose ses pancartes.
  test("1. la pancarte d'Antoine sur a.ts : le bash de Bernard est annulé sur a.ts, b.ts part sous son nom, il reçoit le refus", async () => {
    process.env.ESSAIM_FIXTURE_ANTOINE = fixture("antoine", [appel("r1", "fichier_reclamer", { chemin: "a.ts", raison: "ma part" }), ...ecrire("w1", "a.ts", "de Antoine\n"),
      pause(500), toucher("pret"), attendre("fin-x"), ...finir]);
    process.env.ESSAIM_FIXTURE_BERNARD = fixture("bernard", [attendre("pret"), bashDebut("b1", "echo x > a.ts; echo b > b.ts"), par("a.ts", "de Bernard\n"), par("b.ts", "libre\n"), bashFin("b1"),
      pause(600), appel("p1", "fichier_pancartes", {}), appel("p2", "fichier_pancartes", {}), toucher("fin-x"), ...finir]);
    const b = await lancer(base());
    expect(readFileSync(join(b.run, "partage", "a.ts"), "utf8")).toBe("de Antoine\n");
    expect(auteurs(b.run, "a.ts")).toEqual(["Antoine"]);
    expect(auteurs(b.run, "b.ts")).toEqual(["Bernard"]);
    expect(git(b.run, "status", "--porcelain")).toBe("");
    expect(resultat(b.run, "Bernard", "p1")).toContain("\n[salle] pour toi : refusé : tes changements de a.ts (par bash) ont été annulés ; ce fichier est à Antoine");
    expect(resultat(b.run, "Bernard", "p2")).not.toContain("refusé"); // livré une fois
    const t = lire(b.run);
    const f = t.get<{ agent: string; texte: string; details_json: string }>("SELECT agent, texte, details_json FROM faits WHERE type = 'restauration'")!;
    const e = t.all<{ agent: string; resultat_resume: string }>("SELECT agent, resultat_resume FROM evenements WHERE type = 'annulation'");
    t.fermer();
    const head = git(b.run, "log", "-n1", "--format=%h", "--", "a.ts");
    expect(f.agent).toBe("Bernard");
    expect(f.texte).toBe(`annulé · a.ts · écrit par bash par Bernard · à Antoine · remis au commit ${head}`);
    expect(JSON.parse(f.details_json)).toEqual({ racine: "partage", depuis: head, annule: { outil: "bash", fichiers: [{ chemin: "a.ts", porteur: "Antoine" }] } });
    expect(e).toEqual([{ agent: "Bernard", resultat_resume: f.texte }]);
  }, 30_000);

  // Le gel : la pancarte d'un chemin gelé par une révision va au porteur fictif
  // gel, absent de la salle ; une écriture par bash y est annulée quand même. La pancarte est posée ici dans le tableau,
  // comme gelerTickets le fait à l'acceptation d'une révision.
  test("gel. a.ts gelé par une révision : le bash de Bernard y est annulé, porteur gel ; b.ts part sous son nom", async () => {
    const geler = "UPDATE reclamations SET retire_le = '2026-10-03T12:00:00.000Z' WHERE chemin = 'a.ts' AND retire_le IS NULL;"
      + " INSERT INTO reclamations(chemin, agent, raison, pose_le) VALUES ('a.ts', 'gel', '#1 gelé par la révision', '2026-10-03T12:00:00.000Z');";
    process.env.ESSAIM_FIXTURE_ANTOINE = fixture("antoine", [appel("r1", "fichier_reclamer", { chemin: "a.ts", raison: "ma part" }), ...ecrire("w1", "a.ts", "de Antoine\n"),
      pause(500), { type: "faux:lancer", commande: ["sqlite3", "{RUN}/tableau.sqlite", geler] }, pause(500), toucher("pret"), attendre("fin-x"), ...finir]);
    process.env.ESSAIM_FIXTURE_BERNARD = fixture("bernard", [attendre("pret"), bashDebut("b1", "echo x > a.ts; echo b > b.ts"), par("a.ts", "de Bernard\n"), par("b.ts", "libre\n"), bashFin("b1"),
      pause(600), toucher("fin-x"), ...finir]);
    const b = await lancer(base());
    expect(readFileSync(join(b.run, "partage", "a.ts"), "utf8")).toBe("de Antoine\n");
    expect(auteurs(b.run, "a.ts")).toEqual(["Antoine"]);
    expect(auteurs(b.run, "b.ts")).toEqual(["Bernard"]);
    const t = lire(b.run);
    const f = t.get<{ details_json: string }>("SELECT details_json FROM faits WHERE type = 'restauration'")!;
    t.fermer();
    expect(JSON.parse(f.details_json).annule.fichiers).toEqual([{ chemin: "a.ts", porteur: "gel" }]);
  });
  test("un write commencé sans fin (agent sorti) ne retient plus son fichier : le bash suivant d'un autre le commite (29/09, revue F22)", async () => {
    process.env.ESSAIM_FIXTURE_ANTOINE = fixture("antoine", [{ type: "tool_execution_start", toolCallId: "w1", toolName: "write", args: { path: "{PARTAGE}/x.ts", content: "x" } },
      toucher("pret"), ...finir]);
    process.env.ESSAIM_FIXTURE_BERNARD = fixture("bernard", [attendre("pret"), pause(800), bashDebut("b1", "echo x > x.ts"), par("x.ts", "de Bernard\n"), bashFin("b1"), pause(600), ...finir]);
    const b = await lancer(base({ mission: mission() }));
    expect(auteurs(b.run, "x.ts")).toEqual(["Bernard"]);
  }, 30_000);

  test("2. sans pancarte, ou sur sa propre pancarte : le bash est commité comme avant ; sans rôles, la pancarte d'un autre ne change rien", async () => {
    process.env.ESSAIM_FIXTURE_ANTOINE = fixture("antoine", [toucher("pret"), attendre("fin-x"), ...finir]);
    process.env.ESSAIM_FIXTURE_BERNARD = fixture("bernard", [attendre("pret"), appel("r1", "fichier_reclamer", { chemin: "c.ts", raison: "la mienne" }),
      bashDebut("b1", "echo > c.ts; echo > d.ts"), par("c.ts", "c\n"), par("d.ts", "d\n"), bashFin("b1"), pause(600), toucher("fin-x"), ...finir]);
    const b = await lancer(base());
    expect(auteurs(b.run, "c.ts")).toEqual(["Bernard"]);
    expect(auteurs(b.run, "d.ts")).toEqual(["Bernard"]);
    const t = lire(b.run);
    expect(t.get<{ n: number }>("SELECT count(*) AS n FROM faits WHERE type = 'restauration'")!.n).toBe(0);
    t.fermer();

    // Sans rôles : la pancarte d'Antoine reste consultative, le bash de Bernard part sous son nom.
    process.env.ESSAIM_FIXTURE_ANTOINE = fixture("antoine2", [appel("r1", "fichier_reclamer", { chemin: "a.ts", raison: "ma part" }), ...ecrire("w1", "a.ts", "de Antoine\n"),
      pause(500), toucher("pret2"), attendre("fin-y"), ...finir]);
    process.env.ESSAIM_FIXTURE_BERNARD = fixture("bernard2", [attendre("pret2"), bashDebut("b1", "echo x > a.ts"), par("a.ts", "de Bernard\n"), bashFin("b1"), pause(600), toucher("fin-y"), ...finir]);
    const s = await lancer(base({ mission: mission() }));
    expect(readFileSync(join(s.run, "partage", "a.ts"), "utf8")).toBe("de Bernard\n");
    expect(auteurs(s.run, "a.ts")).toEqual(["Bernard", "Antoine"]);
  }, 60_000);

  test("3. Antoine a un bash ouvert : le changement de a.ts n'est pas annulé, ni pris par le commit de Bernard ; celui d'Antoine le prend", async () => {
    process.env.ESSAIM_FIXTURE_ANTOINE = fixture("antoine", [appel("r1", "fichier_reclamer", { chemin: "a.ts", raison: "ma part" }), ...ecrire("w1", "a.ts", "de Antoine\n"),
      pause(500), bashDebut("b0", "bun test"), toucher("pret"), attendre("fin-x"), bashFin("b0"), pause(500), ...finir]);
    process.env.ESSAIM_FIXTURE_BERNARD = fixture("bernard", [attendre("pret"), bashDebut("b1", "echo x > a.ts"), par("a.ts", "de Bernard\n"), bashFin("b1"),
      pause(600), toucher("fin-x"), ...finir]);
    const b = await lancer(base());
    expect(readFileSync(join(b.run, "partage", "a.ts"), "utf8")).toBe("de Bernard\n");
    expect(auteurs(b.run, "a.ts")).toEqual(["Antoine", "Antoine"]); // le bash d'Antoine, puis son write
    const t = lire(b.run);
    expect(t.get<{ n: number }>("SELECT count(*) AS n FROM faits WHERE type = 'restauration'")!.n).toBe(0);
    t.fermer();
  }, 30_000);

  // Un scénario en petit (type jeu : Antoine intégrateur, qui répartit ; Bernard, Claude, Denis constructeurs ; Edmond
  // recette). Antoine confie src/solveur.ts à Claude, qui l'écrit ; Antoine le réattribue à Denis et poste « STOP » à
  // Claude ; Claude, qui n'a rien lu, réécrit le fichier par bash. Le fichier revient à l'état commité, et l'outil suivant
  // de Claude lui livre l'annulation, la réattribution et le message.
  test("régression du run hôpital : réattribution, STOP, écriture par bash ; le fichier revient, Claude reçoit tout", async () => {
    process.env.ESSAIM_FIXTURE = fixture("dort", DORMIR);
    process.env.ESSAIM_FIXTURE_ANTOINE = fixture("antoine", [
      appel("t1", "ticket_ouvrir", { type: "amelioration", titre: "le solveur", description: "le cœur", charge: "Claude", chemins: ["src/solveur.ts"] }),
      toucher("confie"), attendre("claude-a-ecrit"), pause(500),
      appel("t2", "ticket_modifier", { id: 1, charge: "Denis", note: "Réattribué : Claude stagne" }),
      appel("m1", "salle_poster", { texte: "Antoine → Claude : STOP net sur src/solveur.ts. Le ticket #1 est à Denis." }),
      toucher("stop"), ...DORMIR]);
    process.env.ESSAIM_FIXTURE_CLAUDE = fixture("claude", [attendre("confie"), ...ecrire("w1", "src/solveur.ts", "v1 de Claude\n"), toucher("claude-a-ecrit"),
      attendre("stop"), bashDebut("b1", "python3 - <<EOF … open(p,'w')"), par("src/solveur.ts", "v2 de Claude par bash\n"), bashFin("b1"),
      pause(800), appel("p1", "fichier_pancartes", {}), ...DORMIR]);
    const b = await lancer(base({ agents: 5, mission: mission("jeu") }));
    expect(readFileSync(join(b.run, "partage", "src", "solveur.ts"), "utf8")).toBe("v1 de Claude\n");
    expect(auteurs(b.run, "src/solveur.ts")).toEqual(["Claude"]); // son write de v1 seulement
    const texte = resultat(b.run, "Claude", "p1");
    const t = lire(b.run);
    const stop = t.get<{ id: number }>("SELECT id FROM messages WHERE texte LIKE 'Antoine → Claude : STOP%'")!.id;
    t.fermer();
    expect(texte).toContain("\n[salle] pour toi : refusé : tes changements de src/solveur.ts (par bash) ont été annulés ; ce fichier est à Denis (ticket #1)");
    expect(texte).toContain("\n[salle] pour toi : ton ticket #1 (src/solveur.ts) est maintenant à Denis");
    expect(texte).toContain(`\n[salle] pour toi : message ${stop} de Antoine (principal) : « Antoine → Claude : STOP net sur src/solveur.ts. Le ticket #1 est à Denis. »`);
    expect(texte).not.toContain("ta pancarte"); // elle a suivi le ticket : une seule ligne
  }, 60_000);

  // L'intégrateur, qui assemble et régénère le livrable, n'est pas soumis à l'annulation ; un constructeur l'est
  // toujours. Type jeu : Antoine intégrateur (il répartit), Bernard, Claude, Denis constructeurs, Edmond recette.
  test("R12. le bash de l'intégrateur sur la part d'un constructeur est commité à son nom ; celui d'un constructeur est annulé", async () => {
    process.env.ESSAIM_FIXTURE = fixture("dort", DORMIR);
    process.env.ESSAIM_FIXTURE_ANTOINE = fixture("antoine", [
      appel("t1", "ticket_ouvrir", { type: "amelioration", titre: "les sorties", description: "d", charge: "Bernard", chemins: ["planning.csv"] }),
      toucher("confie"), attendre("bernard-a-ecrit"), pause(500),
      bashDebut("b1", "node src/main.js ../entrees ."), par("planning.csv", "régénéré par Antoine\n"), bashFin("b1"),
      pause(800), toucher("regenere"), ...DORMIR]);
    process.env.ESSAIM_FIXTURE_BERNARD = fixture("bernard", [attendre("confie"), ...ecrire("w1", "planning.csv", "v1 de Bernard\n"), toucher("bernard-a-ecrit"), ...DORMIR]);
    process.env.ESSAIM_FIXTURE_CLAUDE = fixture("claude", [attendre("regenere"),
      bashDebut("b2", "node src/main.js ../entrees ."), par("planning.csv", "régénéré par Claude\n"), bashFin("b2"), pause(800), toucher("fin-x"), ...DORMIR]);
    process.env.ESSAIM_FIXTURE_EDMOND = fixture("edmond", [attendre("fin-x"), ...finir]);
    const b = await lancer(base({ agents: 5, mission: mission("jeu") }));
    expect(readFileSync(join(b.run, "partage", "planning.csv"), "utf8")).toBe("régénéré par Antoine\n");
    expect(auteurs(b.run, "planning.csv")).toEqual(["Antoine", "Bernard"]);
    const t = lire(b.run);
    const e = t.all<{ agent: string; erreur: string }>("SELECT agent, erreur FROM evenements WHERE type = 'annulation'");
    t.fermer();
    expect(e).toEqual([{ agent: "Claude", erreur: "écriture par bash dans le fichier d'un autre : planning.csv (Bernard (ticket #1))" }]);
  }, 60_000);

  // Un réassemblage qui remet des lignes corrigées par un autre ne passe plus sans alerte.
  test("J1. un bash qui remet un fichier dans son état d'avant le commit d'un autre : les deux sont prévenus, signé essaim", async () => {
    process.env.ESSAIM_FIXTURE = fixture("dort", DORMIR);
    process.env.ESSAIM_FIXTURE_BERNARD_PASSE_1 = fixture("bernard", [
      bashDebut("b1", "assembler"), par("sortie.txt", "v1\n"), bashFin("b1"), pause(800), toucher("v1"),
      attendre("v2"), bashDebut("b3", "assembler"), par("sortie.txt", "v1\n"), bashFin("b3"), pause(1500), toucher("fin"), ...DORMIR]);
    process.env.ESSAIM_FIXTURE_CLAUDE_PASSE_1 = fixture("claude", [attendre("v1"),
      bashDebut("b2", "corriger"), par("sortie.txt", "v2\n"), bashFin("b2"), pause(800), toucher("v2"), ...DORMIR]);
    process.env.ESSAIM_FIXTURE_EDMOND = fixture("edmond", [attendre("fin"), ...finir]);
    const b = await lancer(base({ agents: 5, mission: mission("jeu") }));
    const t = lire(b.run);
    const msg = t.all<{ auteur: string; texte: string }>("SELECT auteur, texte FROM messages WHERE texte LIKE '%dans leur état d''avant%'");
    const ev = t.all<{ agent: string }>("SELECT agent FROM evenements WHERE type = 'defait'");
    t.fermer();
    const [v2, v3] = git(b.run, "log", "--format=%h", "-n2", "--", "sortie.txt").split("\n").reverse();
    expect(msg).toEqual([{ auteur: "essaim", texte: `Bernard, Claude : le commit ${v3} de Bernard remet 1 ligne de sortie.txt dans leur état d'avant le commit ${v2} de Claude. Si sortie.txt est régénéré, la correction de Claude va dans la source qui le produit.` }]);
    expect(ev).toEqual([{ agent: "Bernard" }]);
  }, 60_000);

  // Le parcours sans recopie : l'intégrateur met le changement dans un essai, le porteur de la pancarte l'adopte
  // lui-même. Un autre constructeur, lui, ne le peut pas.
  test("R14. l'intégrateur ouvre un essai qui change a.ts, part de Bernard ; Bernard l'adopte, a.ts porte exactement l'essai", async () => {
    process.env.ESSAIM_FIXTURE = fixture("dort", DORMIR);
    process.env.ESSAIM_FIXTURE_PASSE_2 = process.env.ESSAIM_FIXTURE; // réveillé (par le ticket), un agent se rendort sans rejouer ses écritures
    process.env.ESSAIM_FIXTURE_ANTOINE = fixture("antoine", [
      appel("t1", "ticket_ouvrir", { type: "amelioration", titre: "le solveur", description: "d", charge: "Bernard", chemins: ["a.ts"] }),
      toucher("confie"), attendre("bernard-a-ecrit"), pause(500),
      appel("e1", "depot_essai", { nom: "correctif", raison: "le correctif de a.ts, à adopter par son porteur" }),
      { type: "tool_execution_start", toolCallId: "w2", toolName: "write", args: { path: "{RUN}/essais/correctif/a.ts", content: "ligne 1\nligne 2 corrigée\n" } },
      { type: "tool_execution_end", toolCallId: "w2", toolName: "write", result: { content: [{ type: "text", text: "écrit" }] }, isError: false },
      pause(800), toucher("essai-pret"), ...DORMIR]);
    process.env.ESSAIM_FIXTURE_BERNARD = fixture("bernard", [attendre("confie"), ...ecrire("w1", "a.ts", "ligne 1\nligne 2\n"), toucher("bernard-a-ecrit"),
      attendre("claude-refuse"), appel("a2", "depot_adopter", { nom: "correctif" }), pause(500), toucher("fin-x"), ...DORMIR]);
    process.env.ESSAIM_FIXTURE_CLAUDE = fixture("claude", [attendre("essai-pret"), appel("a1", "depot_adopter", { nom: "correctif" }), toucher("claude-refuse"), ...DORMIR]);
    process.env.ESSAIM_FIXTURE_EDMOND = fixture("edmond", [attendre("fin-x"), ...finir]);
    const b = await lancer(base({ agents: 5, mission: mission("jeu") }));
    expect(resultat(b.run, "Claude", "a1")).toStartWith("refusé : l'adoption d'un essai revient à l'intégrateur, ou au porteur de la pancarte de chaque fichier qu'il change (sans la tienne : a.ts).");
    expect(resultat(b.run, "Bernard", "a2")).toStartWith("essai correctif adopté (commit ");
    expect(readFileSync(join(b.run, "partage", "a.ts"), "utf8")).toBe("ligne 1\nligne 2 corrigée\n");
    expect(git(b.run, "show", "essai/correctif:a.ts")).toBe(git(b.run, "show", "main:a.ts"));
    // Le commit de fusion au nom de Bernard, qui adopte ; le changement lui-même au nom d'Antoine, qui l'a écrit.
    expect(git(b.run, "log", "-n1", "--merges", "--format=%an %s", "main")).toBe("Bernard adopter l'essai correctif");
    expect(auteurs(b.run, "a.ts")).toEqual(["Antoine", "Bernard"]);
  }, 60_000);
});

// ---- La ligne courte et le témoin, au niveau de l'extension -------------------------------------------------------------------
describe("O4 : la ligne courte porte ce qui concerne l'agent lui-même", () => {
  let dossier: string, chemin: string, partage: string, t: T.Tableau;
  const ENV = ["ESSAIM_AGENT", "ESSAIM_TABLEAU", "ESSAIM_PARTAGE", "ESSAIM_BUREAU", "ESSAIM_ROLE", "ESSAIM_MEMOIRE", "ESSAIM_TOUR_MS"];
  let envAvant: Record<string, string | undefined> = {};
  const instance = (agent: string, role?: string, env: Record<string, string> = {}) => {
    Object.assign(process.env, { ESSAIM_AGENT: agent, ESSAIM_TABLEAU: chemin, ESSAIM_PARTAGE: partage, ESSAIM_BUREAU: join(dossier, "agents", agent), ...env });
    if (role) process.env.ESSAIM_ROLE = role; else delete process.env.ESSAIM_ROLE;
    const faux = fauxPi();
    extension(faux.api, ouvrirBun);
    return faux;
  };
  // Le résultat d'un bash, tel que pi le rend après les gestionnaires tool_result (undefined : rien ajouté).
  const bash = async (pi: ReturnType<typeof fauxPi>, id: string) => {
    const r = await pi.emettre("tool_result", { type: "tool_result", toolName: "bash", toolCallId: id, input: { command: "true" }, content: [{ type: "text", text: "ok" }], details: {}, isError: false }) as { content: Array<{ text: string }> } | undefined;
    return r?.content.slice(1).map((c) => c.text).join("\n");
  };
  beforeEach(() => {
    envAvant = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    process.env.ESSAIM_TOUR_MS = "0";
    delete process.env.ESSAIM_MEMOIRE;
    dossier = mkdtempSync(join(tmpdir(), "essaim-ligne-"));
    chemin = join(dossier, "tableau.sqlite");
    partage = join(dossier, "partage");
    mkdirSync(partage);
    t = ouvrirBun(chemin);
    T.initialiser(t);
    T.ouvrirRun(t, { id: "run-test", missionChemin: "m.md", missionTexte: "texte", modele: "faux/faux", plafondUsd: 0.5, silenceMin: 15 });
    for (const [nom, role] of [["Antoine", "chef"], ["Bernard", "integrateur"], ["Claude", "constructeur"], ["Denis", "constructeur"]] as const)
      T.ajouterAgent(t, nom, join(dossier, "agents", nom), undefined, undefined, { role });
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(envAvant)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    t.fermer();
    rmSync(dossier, { recursive: true, force: true });
  });

  test("4. un message qui s'adresse à Claude arrive pendant ses bash : la ligne de l'outil suivant le porte, une seule fois", async () => {
    const claude = instance("Claude", "constructeur");
    expect(await bash(claude, "b1")).toBeUndefined();
    const id = T.poster(t, "Antoine", "Antoine → Claude : STOP net sur src/solveur.ts.");
    T.poster(t, "Bernard", "Bernard → Antoine : la 3D de Claude est jolie"); // le cite en passant : ne s'adresse pas à lui
    expect(await bash(claude, "b2")).toBe(`[salle] pour toi : message ${id} de Antoine (principal) : « Antoine → Claude : STOP net sur src/solveur.ts. »`);
    expect(await bash(claude, "b3")).toBeUndefined();
    // Au plus trois, les plus récents ; le reste compté ; un long message coupé, sa suite par salle_chercher.
    const ids = [1, 2, 3, 4].map((n) => T.poster(t, "Denis", `Claude, question ${n} ?${n === 4 ? " " + "x".repeat(300) : ""}`));
    const l = (await bash(claude, "b4"))!.split("\n");
    expect(l).toHaveLength(4);
    expect(l[0]).toBe(`[salle] pour toi : +1 message plus ancien s'adresse à toi, à partir du n° ${ids[0]} (salle_lire)`);
    expect(l[1]).toStartWith(`[salle] pour toi : message ${ids[1]} de Denis (principal) : « Claude, question 2 ? »`);
    expect(l[3]).toEndWith(`… (suite : salle_chercher(numero: ${ids[3]})) »`);
    for (const x of l) expect([...x].length).toBeLessThanOrEqual(300);
    // Lu par salle_lire : plus rien ; la mémoire témoin : aucune ligne pour un message.
    T.poster(t, "Antoine", "Claude : relis le ticket.");
    await claude.texte("salle_lire", {});
    expect(await bash(claude, "b5")).toBeUndefined();
    const temoin = instance("Denis", "constructeur", { ESSAIM_MEMOIRE: "non" });
    T.poster(t, "Antoine", "Denis : tu prends le solveur.");
    expect(await bash(temoin, "b6")).toBeUndefined();
  });

  test("5. un ticket de Claude réattribué à Denis : une ligne, sans redire la pancarte ; une pancarte reprise seule, sa ligne", async () => {
    const chef = instance("Antoine", "chef");
    await chef.texte("ticket_ouvrir", { type: "amelioration", titre: "le solveur", description: "d", charge: "Claude", chemins: ["src/solveur.ts"] });
    await chef.texte("ticket_ouvrir", { type: "amelioration", titre: "la page", description: "d", charge: "Claude", chemins: ["page.html"] });
    const claude = instance("Claude", "constructeur");
    await claude.texte("salle_lire", {}); // les annonces lues
    expect(await bash(claude, "b1")).toBeUndefined();
    await instance("Antoine", "chef").texte("ticket_modifier", { id: 1, charge: "Denis" });
    expect(await bash(claude, "b2")).toBe("[salle] pour toi : ton ticket #1 (src/solveur.ts) est maintenant à Denis");
    expect(await bash(claude, "b3")).toBeUndefined();
    // Le chef confie page.html à Denis par un autre ticket : la pancarte de Claude passe, son ticket #2 reste à lui.
    await instance("Antoine", "chef").texte("ticket_ouvrir", { type: "amelioration", titre: "reprise", description: "d", charge: "Denis", chemins: ["page.html"] });
    const l = await bash(claude, "b4");
    expect(l).toBe("[salle] pour toi : ta pancarte sur page.html est maintenant à Denis");
  });

  test("témoin : l'annulation d'une écriture par bash est livrée quand même (un refus du rôle), le reste non", async () => {
    const claude = instance("Claude", "constructeur", { ESSAIM_MEMOIRE: "non" });
    t.transaction(() => T.noterFait(t, D.faitAnnulation("Claude", "abc1234", [{ chemin: "src/solveur.ts", porteur: "Denis", ticket: 4 }])));
    T.poster(t, "Antoine", "Antoine → Claude : STOP.");
    expect(await bash(claude, "b1")).toBe("[salle] pour toi : refusé : tes changements de src/solveur.ts (par bash) ont été annulés ; ce fichier est à Denis (ticket #4)");
    expect(await bash(claude, "b2")).toBeUndefined();
    // Denis ne reçoit rien de ce fait : il n'est pas à lui, et son fichier n'a pas changé.
    expect(await bash(instance("Denis", "constructeur"), "b3")).toBeUndefined();
  });
});
