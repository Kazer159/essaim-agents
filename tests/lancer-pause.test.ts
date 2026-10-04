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

describe("la pause et la veille de la machine (24/09)", () => {
  const ecrire = (nom: string, lignes: object[]) => { const p = join(racine, `${nom}.jsonl`); writeFileSync(p, lignes.map((l) => JSON.stringify(l)).join("\n") + "\n"); return p; };
  const runDir = () => join(racine, "runs", readdirSync(join(racine, "runs")).filter((n) => !n.startsWith(".")).sort().at(-1)!);
  const attendre = async (condition: () => boolean, ms = 8000) => {
    const fin = Date.now() + ms;
    while (!condition()) { if (Date.now() > fin) throw new Error("condition jamais vraie"); await Bun.sleep(50); }
  };
  const evenements = (run: string, type: string) => { const t = lire(run); const e = t.all<{ agent: string; resultat_resume: string; id: number }>("SELECT id, agent, resultat_resume FROM evenements WHERE type = ? ORDER BY id", [type]); t.fermer(); return e; };
  const repondu = { type: "message_end", message: { role: "assistant", content: [], usage: { input: 100, output: 10, cost: { total: 0.0001 } }, stopReason: "toolUse" } };
  const poste = [
    { type: "tool_execution_start", toolCallId: "p1", toolName: "salle_poster", args: { texte: "je commence" } },
    { type: "tool_execution_end", toolCallId: "p1", toolName: "salle_poster" },
    repondu,
  ];
  const lancements = (run: string, nom: string) => readFileSync(join(run, "journal", `${nom}.args`), "utf8").trim().split("\n").map((l) => JSON.parse(l).args as string[]);

  test("pause : l'agent est arrêté, pas viré pendant la pause, puis relancé sur sa session sans consommer de passe", async () => {
    process.env.ESSAIM_FIXTURE = ecrire("long", [...poste, { type: "faux:dormir", ms: 60_000 }, { type: "agent_end" }]);
    process.env.ESSAIM_FIXTURE_PASSE_2 = fixture("hello-fini");
    const promesse = lancer({ ...base(), silenceMin: 0.02 }); // 1,2 s de silence toléré
    await attendre(() => existsSync(join(racine, "runs")) && readdirSync(join(racine, "runs")).some((n) => !n.startsWith(".")) && existsSync(join(runDir(), "journal", "Antoine.jsonl")) && readFileSync(join(runDir(), "journal", "Antoine.jsonl"), "utf8").includes("message_end"));
    const run = runDir();
    writeFileSync(join(run, "pause"), "test");
    await attendre(() => evenements(run, "pause").some((e) => e.agent === "Antoine"));
    await Bun.sleep(2500); // bien plus que le silence toléré : personne n'est viré pendant la pause
    expect(agentEnBase(run, "Antoine").etat).toBe("actif");
    expect(lancements(run, "Antoine").length).toBe(1); // rien ne tourne pendant la pause
    rmSync(join(run, "pause"));
    const b = await promesse;
    expect(b).toMatchObject({ finis: 1, vires: 0, perdus: 0 });
    const a = agentEnBase(run, "Antoine");
    expect([a.etat, a.passes]).toEqual(["fini", 1]);
    const l = lancements(run, "Antoine");
    expect(l.length).toBe(2);
    expect(l[1]!.at(-1)).toContain("Le run a été mis en pause, puis repris");
    expect(l[1]![l[1]!.indexOf("--session-id") + 1]).toBe("Antoine");
    expect(evenements(run, "pause").map((e) => [e.agent, e.resultat_resume])).toEqual([
      ["lanceur", "pause demandée : chaque agent s'arrête après son action en cours"], ["Antoine", "mis en pause"]]);
    expect(evenements(run, "reprise")[0]?.resultat_resume).toBe("run repris après 1 min de pause");
  });

  test("une longue pause : à la reprise, l'agent est relancé, pas viré pour silence (nuit du 24 au 25/09)", async () => {
    // Après une longue pause, l'agent n'est pas coupé pour silence. Le lanceur voit la pause levée avant que l'agent
    // le remarque (il sonde toutes les 2 s) : le silence ne se mesure pas depuis la mise en pause. Ici l'agent sonde lentement, la pause dure plus que le silence toléré.
    process.env.ESSAIM_FIXTURE = ecrire("long-2", [...poste, { type: "faux:dormir", ms: 60_000 }, { type: "agent_end" }]);
    process.env.ESSAIM_FIXTURE_PASSE_2 = fixture("hello-fini");
    process.env.ESSAIM_SONDAGE_MS = "1500";
    try {
      const promesse = lancer({ ...base(), silenceMin: 0.02 }); // 1,2 s de silence toléré
      await attendre(() => existsSync(join(racine, "runs")) && readdirSync(join(racine, "runs")).some((n) => !n.startsWith(".")) && existsSync(join(runDir(), "journal", "Antoine.jsonl")) && readFileSync(join(runDir(), "journal", "Antoine.jsonl"), "utf8").includes("message_end"));
      const run = runDir();
      writeFileSync(join(run, "pause"), "test");
      await attendre(() => evenements(run, "pause").some((e) => e.agent === "Antoine"));
      await Bun.sleep(2500);
      rmSync(join(run, "pause"));
      const b = await promesse;
      expect(b).toMatchObject({ finis: 1, vires: 0, perdus: 0 });
    } finally {
      delete process.env.ESSAIM_SONDAGE_MS;
    }
  });

  test("la pause attend la fin de l'action en cours ; une action trop longue est coupée au délai", async () => {
    process.env.ESSAIM_FIXTURE_ANTOINE = ecrire("courte", [repondu,
      { type: "tool_execution_start", toolCallId: "b1", toolName: "bash", args: { command: "bun test" } },
      { type: "faux:dormir", ms: 800 },
      { type: "tool_execution_end", toolCallId: "b1", toolName: "bash", result: "ok", isError: false },
      { type: "faux:dormir", ms: 60_000 }, { type: "agent_end" }]);
    process.env.ESSAIM_FIXTURE_BERNARD = ecrire("longue", [repondu,
      { type: "tool_execution_start", toolCallId: "b2", toolName: "bash", args: { command: "sleep 3600" } },
      { type: "faux:dormir", ms: 60_000 }, { type: "agent_end" }]);
    process.env.ESSAIM_FIXTURE_PASSE_2 = fixture("hello-fini");
    process.env.ESSAIM_TOUR_MS = "0";
    const promesse = lancer({ ...base(), agents: 2 });
    await attendre(() => existsSync(join(racine, "runs")) && readdirSync(join(racine, "runs")).some((n) => !n.startsWith(".")) && ["Antoine", "Bernard"].every((n) => existsSync(join(runDir(), "journal", `${n}.jsonl`)) && readFileSync(join(runDir(), "journal", `${n}.jsonl`), "utf8").includes("bash")));
    const run = runDir();
    writeFileSync(join(run, "pause"), "test");
    await attendre(() => evenements(run, "pause").length === 3);
    const t = lire(run);
    const finBash = t.get<{ id: number }>("SELECT id FROM evenements WHERE agent = 'Antoine' AND type = 'tool_execution_end'")!.id;
    t.fermer();
    const pauses = Object.fromEntries(evenements(run, "pause").map((e) => [e.agent, e]));
    expect(pauses.Antoine!.id).toBeGreaterThan(finBash); // arrêté après la fin de son bun test, pas pendant
    expect(pauses.Antoine!.resultat_resume).toBe("mis en pause");
    expect(pauses.Bernard!.resultat_resume).toBe("mis en pause pendant bash, trop long à attendre");
    rmSync(join(run, "pause"));
    const b = await promesse;
    expect(b).toMatchObject({ finis: 2, vires: 0, perdus: 0 });
    expect(agentEnBase(run, "Bernard").passes).toBe(1); // l'outil jamais fermé du processus tué n'est pas pris pour un outil bloqué
  });

  test("fermer pendant la pause : les agents sont virés, le run se clôt, le fichier pause disparaît", async () => {
    process.env.ESSAIM_FIXTURE = ecrire("long", [...poste, { type: "faux:dormir", ms: 60_000 }, { type: "agent_end" }]);
    const promesse = lancer(base());
    await attendre(() => existsSync(join(racine, "runs")) && readdirSync(join(racine, "runs")).some((n) => !n.startsWith(".")) && existsSync(join(runDir(), "journal", "Antoine.jsonl")));
    const run = runDir();
    writeFileSync(join(run, "pause"), "test");
    await attendre(() => evenements(run, "pause").some((e) => e.agent === "Antoine"));
    writeFileSync(join(run, "arret"), "test");
    const b = await promesse;
    expect(b).toMatchObject({ finis: 0, vires: 1 });
    expect(agentEnBase(run, "Antoine").raison_sortie).toBe("arrêté depuis la vue");
    expect(existsSync(join(run, "pause"))).toBe(false);
  });

  test("veille de la machine : personne n'est viré pour le temps de la veille, la réponse coupée ne coûte pas de passe", async () => {
    // La veille est imitée en gelant le lanceur (SIGSTOP) plus longtemps que le silence toléré ; pendant ce temps,
    // le faux pi voit sa « connexion » tomber et répond par une erreur, comme pi au réveil.
    const erreur = { type: "message_end", message: { role: "assistant", content: [], usage: { input: 0, output: 0 }, stopReason: "error", errorMessage: "connexion perdue" } };
    const fx = ecrire("veille", [...poste, { type: "faux:dormir", ms: 3500 }, erreur, { type: "agent_end" }]);
    const proc = Bun.spawn(["bun", join(racineDepot, "src", "lancer.ts"), "--agents", "1", "--modele", "faux", "--plafond", "0.10", "--mission", join(racineDepot, "tests", "fixtures", "hello-world.md"), "--sans-bac-a-sable", "--silence", "0.04"],
      { cwd: racine, stdout: "pipe", stderr: "pipe", env: { ...process.env, ESSAIM_TEST: "1", ESSAIM_FIXTURE: fx, ESSAIM_FIXTURE_PASSE_2: fixture("hello-fini"), ESSAIM_VEILLE_MS: "1000" } });
    await attendre(() => existsSync(join(racine, "runs")) && readdirSync(join(racine, "runs")).some((n) => !n.startsWith(".")) && existsSync(join(runDir(), "journal", "Antoine.jsonl")) && readFileSync(join(runDir(), "journal", "Antoine.jsonl"), "utf8").includes("message_end"));
    process.kill(proc.pid, "SIGSTOP");
    await Bun.sleep(4000); // plus que les 2,4 s de silence toléré
    process.kill(proc.pid, "SIGCONT");
    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stdout).text()).toContain("1/1 finis · 0 virés · 0 perdus");
    const run = runDir();
    expect(agentEnBase(run, "Antoine").passes).toBe(1);
    expect(evenements(run, "veille")[0]?.resultat_resume).toMatch(/^la machine a dormi \d+ min : ce temps ne compte pas comme silence$/);
    expect(evenements(run, "relance")[0]?.resultat_resume).toBe("relancé après la veille de la machine, sans consommer de passe : connexion perdue");
    expect(lancements(run, "Antoine")[1]!.at(-1)).toContain("s'est mis en veille");
  });
  test("une erreur du fournisseur bien après le réveil n'est plus excusée par la veille : elle consomme sa passe (29/09, revue F21)", async () => {
    const reussi = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "je reprends" }], usage: { input: 10, output: 5 }, stopReason: "stop" } };
    const erreur = { type: "message_end", message: { role: "assistant", content: [], usage: { input: 0, output: 0 }, stopReason: "error", errorMessage: "modèle introuvable" } };
    const fx = ecrire("veille-puis-erreur", [...poste, { type: "faux:dormir", ms: 3500 }, reussi, { type: "faux:dormir", ms: 3000 }, erreur, { type: "agent_end" }]);
    const proc = Bun.spawn(["bun", join(racineDepot, "src", "lancer.ts"), "--agents", "1", "--modele", "faux", "--plafond", "0.10", "--mission", join(racineDepot, "tests", "fixtures", "hello-world.md"), "--sans-bac-a-sable", "--silence", "0.5"],
      { cwd: racine, stdout: "pipe", stderr: "pipe", env: { ...process.env, ESSAIM_TEST: "1", ESSAIM_FIXTURE: fx, ESSAIM_FIXTURE_PASSE_2: fixture("hello-fini"), ESSAIM_VEILLE_MS: "1000" } });
    await attendre(() => existsSync(join(racine, "runs")) && readdirSync(join(racine, "runs")).some((n) => !n.startsWith(".")) && existsSync(join(runDir(), "journal", "Antoine.jsonl")) && readFileSync(join(runDir(), "journal", "Antoine.jsonl"), "utf8").includes("message_end"));
    process.kill(proc.pid, "SIGSTOP");
    await Bun.sleep(4000);
    process.kill(proc.pid, "SIGCONT");
    expect(await proc.exited).toBe(0);
    const run = runDir();
    expect(evenements(run, "veille")).toHaveLength(1); // la veille a bien été vue
    expect(evenements(run, "relance")[0]?.resultat_resume).toStartWith("relancé après une erreur du fournisseur (passe 2/");
    expect(agentEnBase(run, "Antoine").passes).toBe(2);
  }, 30_000);
});

describe("fermeture propre, bilan, refus, verrou", () => {
  test("le bilan n'est écrit qu'après la fermeture des processus et le vidage des flux", async () => {
    const p = join(racine, "tardif.jsonl");
    writeFileSync(p, readFileSync(fixture("hello-fini"), "utf8").replace('{"type":"agent_end"}', '{"type":"faux:dormir","ms":500}\n{"type":"agent_end"}'));
    process.env.ESSAIM_FIXTURE = p;
    const b = await lancer(base());
    expect(b.finis).toBe(1);
    const t = lire(b.run);
    const run = t.get<{ etat: string; fin: string }>("SELECT etat, fin FROM run")!;
    const dernier = t.get<{ type: string; horodatage: string }>("SELECT type, horodatage FROM evenements WHERE type != 'sortie' ORDER BY id DESC LIMIT 1")!; // le dernier événement venu de pi
    const sortie = t.get<{ horodatage: string }>("SELECT horodatage FROM evenements WHERE type = 'sortie'")!;
    t.fermer();
    expect(run.etat).toBe("termine");
    expect(dernier.type).toBe("agent_end");
    expect(dernier.horodatage <= sortie.horodatage && sortie.horodatage <= run.fin).toBe(true);
  });
  test("formaterBilan", () => {
    const ligne = formaterBilan({ finis: 1, vires: 0, perdus: 0, depense: 0.0012, plafond: 0.1, depassement: 0, run: join(process.cwd(), "runs", "2026-09-21T10-00-00") });
    expect(ligne).toBe("1/1 finis · 0 virés · 0 perdus · dépensé 0,0012 $ / seuil 0,10 $ · runs/2026-09-21T10-00-00");
  });
  test("formaterBilan : la ligne des outils, pluriels compris", () => {
    const b = { finis: 1, vires: 0, perdus: 0, depense: 0.0012, plafond: 0.1, depassement: 0, run: join(process.cwd(), "runs", "r") };
    expect(formaterBilan({ ...b, outils: { appels: 12, inconnus: 1, refus: 3, repetes: 1, bash: { bunTest: 2, gitLog: 1, sqlite3: 0 } } }))
      .toEndWith("\noutils : 12 appels · 1 nom inconnu · 3 refus (1 répété) · bash : 2 bun test, 1 git log, 0 sqlite3");
    expect(formaterBilan({ ...b, outils: { appels: 1, inconnus: 2, refus: 0, repetes: 0, bash: { bunTest: 0, gitLog: 0, sqlite3: 0 } } }))
      .toEndWith("\noutils : 1 appel · 2 noms inconnus · 0 refus (0 répété) · bash : 0 bun test, 0 git log, 0 sqlite3");
  });
  test("un run au faux pi porte bilan.outils et sa ligne", async () => {
    process.env.ESSAIM_FIXTURE = fixture("hello-fini");
    const b = await lancer(base());
    expect(b.outils).toEqual({ appels: 2, inconnus: 0, refus: 0, repetes: 0, bash: { bunTest: 0, gitLog: 0, sqlite3: 0 } });
    expect(formaterBilan(b).split("\n")[1]).toBe("outils : 2 appels · 0 nom inconnu · 0 refus (0 répété) · bash : 0 bun test, 0 git log, 0 sqlite3");
    const t = lire(b.run);
    expect(JSON.parse(t.get<{ bilan_json: string }>("SELECT bilan_json FROM run")!.bilan_json).outils).toEqual(b.outils);
    t.fermer();
  });
  test("refus : plafond, nombre d'agents, mission sans définition de « fait », tarif inconnu", async () => {
    process.env.ESSAIM_FIXTURE = fixture("hello-fini");
    await expect(lancer({ ...base(), plafond: 0 })).rejects.toThrow("le plafond doit être supérieur à 0");
    await expect(lancer({ ...base(), agents: 0 })).rejects.toThrow("il faut au moins un agent");
    const sans = join(racine, "sans.md");
    writeFileSync(sans, "# Mission\n\nfais quelque chose\n");
    await expect(lancer({ ...base(), mission: sans })).rejects.toThrow("C'est fini quand");
    await expect(lancer({ ...base(), modele: "openrouter/personne/inconnu" })).rejects.toThrow("tarif inconnu pour openrouter/personne/inconnu");
    expect(existsSync(join(racine, "runs", ".verrou"))).toBe(false);
  });
  test("verrou : deux lancements simultanés, le second est refusé ; un verrou d'un pid mort est remplacé", async () => {
    process.env.ESSAIM_FIXTURE = fixture("hello-fini");
    const r = await Promise.allSettled([lancer(base()), lancer(base())]);
    expect(r.map((x) => x.status).sort()).toEqual(["fulfilled", "rejected"]);
    const refus = r.find((x) => x.status === "rejected") as PromiseRejectedResult;
    expect(String(refus.reason.message)).toBe("un run est déjà en cours");
    // le verrou porte aussi le run : « <pid> <run> » vivant refuse toujours
    writeFileSync(join(racine, "runs", ".verrou"), `${process.pid} un-run`);
    await expect(lancer(base())).rejects.toThrow("un run est déjà en cours");
    writeFileSync(join(racine, "runs", ".verrou"), "999999");
    const b = await lancer(base());
    expect(b.finis).toBe(1);
  });
  test("la ligne de commande : --help en français, et un run complet", async () => {
    const aide = Bun.spawnSync(["bun", join(racineDepot, "src", "lancer.ts"), "--help"]);
    expect(aide.stdout.toString()).toContain("--agents");
    expect(aide.stdout.toString()).toContain("--plafond");
    expect(aide.exitCode).toBe(0);
    const run = Bun.spawnSync(["bun", join(racineDepot, "src", "lancer.ts"), "--agents", "1", "--modele", "faux", "--plafond", "0.10", "--mission", join(racineDepot, "tests", "fixtures", "hello-world.md"), "--sans-bac-a-sable"],
      { cwd: racine, env: { ...process.env, ESSAIM_TEST: "1", ESSAIM_FIXTURE: fixture("hello-fini") } });
    expect(run.stderr.toString()).toBe("");
    expect(run.stdout.toString()).toContain("1/1 finis · 0 virés · 0 perdus · dépensé 0,0012 $ / seuil 0,10 $ · runs/");
    expect(run.exitCode).toBe(0);
    const erreur = Bun.spawnSync(["bun", join(racineDepot, "src", "lancer.ts"), "--agents", "1", "--modele", "faux", "--plafond", "0", "--mission", "x.md"], { cwd: racine });
    expect(erreur.exitCode).toBe(1);
    expect(erreur.stderr.toString()).toContain("essaim : le plafond doit être supérieur à 0");
  });
});

describe("la liste des outils enregistrée dans run (G18)", () => {
  const outilsDuRun = (run: string) => { const t = lire(run); const r = t.get<{ outils_json: string | null }>("SELECT outils_json FROM run"); t.fermer(); return JSON.parse(r!.outils_json!) as string[]; };
  test("avec le compactage (défaut), les outils de pi et nomsSalle(true) ; sans, sans l'outil de résumé", async () => {
    process.env.ESSAIM_FIXTURE = fixture("hello-fini");
    expect(outilsDuRun((await lancer(base())).run)).toEqual([...OUTILS_PI, ...nomsSalle(true)]);
    expect(outilsDuRun((await lancer({ ...base(), compactage: null })).run)).toEqual([...OUTILS_PI, ...nomsSalle(false)]);
  });
  test("un ancien tableau, sans la colonne, la gagne en passant par initialiser", () => {
    const t = ouvrirBun(join(racine, "ancien.sqlite"));
    t.exec(T.SCHEMA);
    expect(T.aColonne(t, "run", "outils_json")).toBe(false);
    T.initialiser(t);
    expect(T.aColonne(t, "run", "outils_json")).toBe(true);
    t.fermer();
  });
});

describe("le faux pi dérive ses outils de l'extension (G21)", () => {
  const ecrireFixture = (nom: string, lignes: object[]) => { const p = join(racine, `${nom}.jsonl`); writeFileSync(p, lignes.map((l) => JSON.stringify(l)).join("\n") + "\n"); return p; };
  test("un outil de la salle est exécuté par la vraie extension ; un nom inconnu d'elle, ancien nom compris, est émis tel quel", async () => {
    process.env.ESSAIM_FIXTURE = ecrireFixture("derive", [
      { type: "tool_execution_start", toolCallId: "c1", toolName: "code_carte", args: {} },
      { type: "tool_execution_start", toolCallId: "c2", toolName: "outil_imaginaire", args: {} },
      { type: "tool_execution_end", toolCallId: "c2", toolName: "outil_imaginaire", result: { content: [{ type: "text", text: "Tool outil_imaginaire not found" }] }, isError: true },
      { type: "tool_execution_start", toolCallId: "c4", toolName: "poster", args: { texte: "ancien nom" } },
      { type: "tool_execution_end", toolCallId: "c4", toolName: "poster", result: { content: [{ type: "text", text: "Tool poster not found" }] }, isError: true },
      { type: "tool_execution_start", toolCallId: "c3", toolName: "moi_finir", args: { raison: "fait" } },
      { type: "agent_end" },
    ]);
    const b = await lancer(base());
    const t = lire(b.run);
    const fins = t.all<{ outil: string; resultat_resume: string; erreur: string | null }>("SELECT outil, resultat_resume, erreur FROM evenements WHERE type = 'tool_execution_end' ORDER BY id");
    t.fermer();
    expect(fins.map((f) => f.outil)).toEqual(["code_carte", "outil_imaginaire", "poster", "moi_finir"]);
    expect(fins[0]!.resultat_resume).toContain("aucun fichier de code");
    expect(fins[1]!.erreur).toContain("not found");
    expect(fins[2]!.erreur).toContain("not found"); // un ancien nom, émis tel quel, jamais exécuté
    expect(fins[3]!.resultat_resume).toContain("session terminée");
  });
});

describe("se résumer (compactage)", () => {
  const lancements = (run: string) => readFileSync(join(run, "journal", "Antoine.args"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { args: string[]; env: Record<string, string> });
  const REPRISE = "Ton contexte vient d'être résumé. Reprends ton travail.";

  test("lireCompactage : k et M, non, refus", () => {
    expect(lireCompactage("80k/120k/160k")).toEqual([80_000, 120_000, 160_000]);
    expect(lireCompactage("5k/8k/12k")).toEqual([5_000, 8_000, 12_000]);
    expect(lireCompactage("0.1M/0.2M/0.3M")).toEqual([100_000, 200_000, 300_000]);
    expect(lireCompactage("non")).toBeNull();
    for (const v of ["abc", "80k/80k/90k", "80k/120k", ""]) expect(() => lireCompactage(v)).toThrow();
  });
  test("verifierCoupure : au plus 90 % de la fenêtre du modèle, rien à vérifier si elle est inconnue", () => {
    expect(() => verifierCoupure([80_000, 120_000, 160_000], 128_000)).toThrow("90 %");
    expect(() => verifierCoupure([80_000, 120_000, 160_000], 1_048_576)).not.toThrow();
    expect(() => verifierCoupure([1e6, 2e6, 3e6], 1_048_576)).toThrow();
    expect(() => verifierCoupure([80_000, 120_000, 160_000], undefined)).not.toThrow();
  });
  test("par défaut : seconde extension et seuils 80k/120k/160k ; avec null : ni l'une ni les autres", async () => {
    process.env.ESSAIM_FIXTURE = fixture("hello-fini");
    const avec = lancements((await lancer(base())).run)[0]!;
    expect(avec.args).toContain(join(racineDepot, "src", "se-resumer.ts"));
    expect(avec.env.ESSAIM_COMPACTAGE).toBe("80000,120000,160000");
    const sans = lancements((await lancer({ ...base(), compactage: null })).run)[0]!;
    expect(sans.args).not.toContain(join(racineDepot, "src", "se-resumer.ts"));
    expect(sans.env.ESSAIM_COMPACTAGE).toBeUndefined();
  });
  test("se_resumer : relancé avec /se-resumer <note> puis la reprise, sans consommer de passe", async () => {
    process.env.ESSAIM_FIXTURE = fixture("resumer");
    process.env.ESSAIM_FIXTURE_PASSE_2 = fixture("hello-fini");
    const b = await lancer(base());
    expect(b).toMatchObject({ finis: 1, perdus: 0 });
    const l = lancements(b.run);
    expect(l.length).toBe(2);
    expect(l[1]!.args.slice(-2)).toEqual(["/se-resumer but : bonjour ; prochaine action : poster", REPRISE]);
    expect(agentEnBase(b.run, "Antoine").passes).toBe(1);
    const t = lire(b.run);
    expect(t.all("SELECT resultat_resume FROM evenements WHERE type = 'relance'")).toEqual([{ resultat_resume: "reprise après résumé" }]);
    t.fermer();
  });
  test("quatre résumés de suite : l'agent n'est pas perdu", async () => {
    process.env.ESSAIM_FIXTURE = fixture("resumer");
    process.env.ESSAIM_FIXTURE_PASSE_5 = fixture("hello-fini");
    const b = await lancer(base());
    expect(b).toMatchObject({ finis: 1, perdus: 0 });
    expect(lancements(b.run).length).toBe(5);
  });
  test("résumé forcé : réponse finie au-delà de la coupure sans résumé", async () => {
    process.env.ESSAIM_FIXTURE = fixture("force");
    process.env.ESSAIM_FIXTURE_PASSE_2 = fixture("hello-fini");
    const b = await lancer(base());
    expect(b).toMatchObject({ finis: 1, perdus: 0 });
    expect(lancements(b.run)[1]!.args.slice(-2)).toEqual(["/se-resumer", REPRISE]);
    const t = lire(b.run);
    expect(t.all("SELECT resultat_resume FROM evenements WHERE type = 'resume_force'")).toEqual([{ resultat_resume: "résumé forcé : 170k tokens, au-delà de la coupure (160k)" }]);
    t.fermer();
  });
  test("compactage en échec : refait deux fois sans passe (R1, 02/10), puis retour à la règle des passes, pas de boucle", async () => {
    process.env.ESSAIM_FIXTURE_PASSE_1 = fixture("force");
    process.env.ESSAIM_FIXTURE = fixture("force-rate");
    const b = await lancer(base());
    expect(b).toMatchObject({ finis: 0, perdus: 1 });
    expect(lancements(b.run).length).toBe(6); // passe 1, sa relance de résumé, deux résumés refaits, puis les passes 2 et 3
    expect(agentEnBase(b.run, "Antoine").raison_sortie).toBe("passes épuisées");
  });
});

describe("deux modèles (24/09)", () => {
  const mixte = (agents: number): Options => ({ ...base(), agents, modeleFemmes: "faux-bis" });
  const args = (run: string, nom: string) => readFileSync(join(run, "journal", `${nom}.args`), "utf8").trim().split("\n").map((l) => JSON.parse(l).args as string[]);
  const option = (a: string[], nom: string) => a[a.indexOf(nom) + 1];
  const ecrireFixture = (nom: string, lignes: object[]) => { const p = join(racine, `${nom}.jsonl`); writeFileSync(p, lignes.map((l) => JSON.stringify(l)).join("\n") + "\n"); return p; };

  test("chaque agent a son modèle, son côté, sa réflexion et son tarif ; bilan par côté", async () => {
    process.env.ESSAIM_FIXTURE = fixture("hello-fini");
    process.env.ESSAIM_FIXTURE_AGATHE = fixture("hello-fini-sans-cout");
    process.env.ESSAIM_TOUR_MS = "0"; // on compte les messages, pas le tour de parole du démarrage
    const b = await lancer(mixte(3));
    const t = lire(b.run);
    expect(t.all("SELECT nom, modele, cote FROM agents ORDER BY rowid")).toEqual([
      { nom: "Antoine", modele: "faux/faux", cote: "hommes" }, { nom: "Agathe", modele: "faux/faux-bis", cote: "femmes" }, { nom: "Bernard", modele: "faux/faux", cote: "hommes" }]);
    expect(t.get<{ m: string; f: string }>("SELECT modele AS m, modele_femmes AS f FROM run")).toEqual({ m: "faux/faux", f: "faux/faux-bis" });
    const agathe = t.get<{ cout_usd: number; cout_estime: number }>("SELECT cout_usd, cout_estime FROM agents WHERE nom = 'Agathe'")!;
    t.fermer();
    expect(agathe.cout_usd).toBeCloseTo((1200 * 2 + 80 * 10) / 1e6, 9); // le tarif de faux-bis, appliqué faute de coût fourni
    expect(agathe.cout_estime).toBe(1);
    for (const [nom, id, reflexion] of [["Antoine", "faux/faux", "off"], ["Agathe", "faux/faux-bis", "low"], ["Bernard", "faux/faux", "off"]] as const) {
      const a = args(b.run, nom)[0]!;
      expect([option(a, "--model"), option(a, "--thinking")]).toEqual([id, reflexion]);
    }
    expect(b.ouvreur).toBe("hommes");
    expect(b.parCote).toEqual([
      { cote: "hommes", modele: "faux/faux", agents: 2, finis: 2, vires: 0, perdus: 0, cout: 0.0024, coutEstime: false, tokens: 2560, appels: 4, messages: 2 },
      { cote: "femmes", modele: "faux/faux-bis", agents: 1, finis: 1, vires: 0, perdus: 0, cout: 0.0032, coutEstime: true, tokens: 1280, appels: 2, messages: 1 },
    ]);
    expect(b.depense).toBeCloseTo(0.0056, 9);
    const lignes = formaterBilan(b).split("\n");
    expect(lignes.length).toBe(3); // la ligne existante, celle des outils, celle des côtés
    expect(lignes[1]).toStartWith("outils : ");
    expect(lignes[2]).toBe("hommes · faux : 0,0024 $ · 2 agents · 2 messages · 4 appels  |  femmes · faux-bis : 0,0032 $ · 1 agent · 1 message · 2 appels");
  });

  test("--reflexion s'applique aux deux modèles ; une relance garde le modèle de l'agente", async () => {
    process.env.ESSAIM_FIXTURE = fixture("hello-fini");
    process.env.ESSAIM_FIXTURE_AGATHE = fixture("sans-fini");
    process.env.ESSAIM_FIXTURE_PASSE_2 = fixture("hello-fini-sans-cout");
    const b = await lancer({ ...mixte(2), reflexion: "high" });
    const lancements = args(b.run, "Agathe");
    expect(lancements.length).toBe(2);
    for (const a of lancements) expect([option(a, "--model"), option(a, "--thinking")]).toEqual(["faux/faux-bis", "high"]);
    expect(option(args(b.run, "Antoine")[0]!, "--thinking")).toBe("high");
  });

  test("le même modèle des deux côtés est refusé, alias ou id complet, avant le verrou", async () => {
    await expect(lancer({ ...base(), agents: 2, modeleFemmes: "faux" })).rejects.toThrow("il en faut deux différents");
    // un alias et son id complet sont le même modèle (catalogue de pi, comme le test de la fenêtre) ; une clé réservée
    // factice : sans elle, le refus viendrait de la clé manquante, avant la comparaison des modèles
    writeFileSync(join(racine, "cle-essaim"), "sk-factice\n");
    process.env.ESSAIM_CLE_OPENROUTER = join(racine, "cle-essaim");
    try {
      await expect(lancer({ ...base(), agents: 2, modele: "deepseek-flash", modeleFemmes: "openrouter/deepseek/deepseek-v4-flash" })).rejects.toThrow("même modèle (openrouter/deepseek/deepseek-v4-flash)");
    } finally { delete process.env.ESSAIM_CLE_OPENROUTER; }
    expect(existsSync(join(racine, "runs", ".verrou"))).toBe(false);
  });

  test("plafond commun : deux dépenses chacune sous le seuil, leur somme le franchit", async () => {
    const chere = ecrireFixture("chere", [
      { type: "message_end", message: { role: "assistant", stopReason: "stop", usage: { input: 1200, output: 80, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } },
      { type: "faux:dormir", ms: 6000 },
      { type: "agent_end" },
    ]);
    process.env.ESSAIM_FIXTURE = fixture("hello-fini");
    process.env.ESSAIM_FIXTURE_AGATHE = chere;
    process.env.ESSAIM_FIXTURE_BRIGITTE = chere;
    const debut = Date.now();
    const b = await lancer({ ...mixte(4), plafond: 0.005 }); // 0,0032 $ chacune : 0,0064 $ ensemble
    expect(Date.now() - debut).toBeLessThan(5000);
    expect(agentEnBase(b.run, "Agathe").raison_sortie).toBe("plafond");
    expect(agentEnBase(b.run, "Brigitte").raison_sortie).toBe("plafond");
    expect(b.depassement).toBeGreaterThan(0);
  });

  test("refus avant le verrou : un seul agent, second modèle inconnu, fenêtre du second modèle trop petite", async () => {
    await expect(lancer(mixte(1))).rejects.toThrow("avec deux modèles, 2 agents au moins");
    await expect(lancer({ ...mixte(2), modeleFemmes: "pas-un-alias" })).rejects.toThrow("--modele-femmes pas-un-alias");
    await expect(lancer({ ...mixte(2), modeleFemmes: "gemini-flash", compactage: [1e6, 2e6, 3e6] })).rejects.toThrow("--modele-femmes gemini-flash");
    expect(existsSync(join(racine, "runs", ".verrou"))).toBe(false);
    expect(existsSync(join(racine, "runs")) ? readdirSync(join(racine, "runs")) : []).toEqual([]);
  });

  test("un seul modèle : ni parCote ni ouvreur, bilan sur une ligne", async () => {
    process.env.ESSAIM_FIXTURE = fixture("hello-fini");
    const b = await lancer({ ...base(), agents: 2 });
    expect(b.parCote).toBeUndefined();
    expect(b.ouvreur).toBeUndefined();
    expect(formaterBilan(b).split("\n").map((l) => l.split(" ")[0])).toEqual(["2/2", "outils"]); // la ligne des outils, pas celle des côtés
    const t = lire(b.run);
    expect(t.all("SELECT nom, cote FROM agents ORDER BY rowid")).toEqual([{ nom: "Antoine", cote: "hommes" }, { nom: "Bernard", cote: "hommes" }]);
    expect(t.get<{ f: string | null }>("SELECT modele_femmes AS f FROM run")?.f).toBeNull();
    t.fermer();
  });
});

// Second cerveau : le run témoin. Ni salle_chercher, ni les deux ajouts des consignes,
// ESSAIM_MEMOIRE=non pour l'extension (ni état, ni ligne courte) ; tous les faits notés quand même.
describe("--memoire non : le run témoin (M14)", () => {
  const CHERCHER = " ; `salle_chercher` cherche par mots dans les messages, les commits, les faits constatés et les tickets, ou lit des messages par numéro";
  const ETAT = " **À chaque réveil, reprise ou résumé, la salle ajoute ce qui a changé depuis ta dernière lecture : des faits qu'elle a constatés elle-même, et des paroles d'agents citées telles quelles, marquées « déclaré par ».**";
  const lancements = (run: string) => readFileSync(join(run, "journal", "Antoine.args"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { args: string[]; env: Record<string, string> });
  const ligneSalle = (consignes: string) => consignes.split("\n").find((l) => l.startsWith("- **salle**"))!;
  const duRun = (run: string) => { const t = lire(run); const r = t.get<{ memoire: string | null; outils_json: string }>("SELECT memoire, outils_json FROM run")!; t.fermer(); return { memoire: r.memoire, outils: JSON.parse(r.outils_json) as string[] }; };
  const faits = (run: string) => { const t = lire(run); const f = t.all<{ type: string; source: string; statut: string | null }>("SELECT type, source, statut FROM faits ORDER BY id"); t.fermer(); return f; };
  const fixtureTemoin = () => {
    const lignes = [
      { type: "tool_execution_start", toolCallId: "w1", toolName: "write", args: { path: "{PARTAGE}/a.test.ts", content: 'import { test, expect } from "bun:test";\ntest("un", () => expect(1).toBe(1));\n' } },
      { type: "tool_execution_end", toolCallId: "w1", toolName: "write", result: { content: [{ type: "text", text: "ok" }] }, isError: false },
      { type: "tool_execution_start", toolCallId: "c1", toolName: "code_tester", args: {} },
      { type: "tool_execution_start", toolCallId: "s1", toolName: "salle_chercher", args: { mots: "un" } }, // exécuté seulement si l'extension l'enregistre
      { type: "tool_execution_start", toolCallId: "f1", toolName: "moi_finir", args: { raison: "fait" } },
      { type: "agent_end" },
    ];
    const p = join(racine, "temoin.jsonl");
    writeFileSync(p, lignes.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return p;
  };
  const finsChercher = (run: string) => { const t = lire(run); const n = t.get<{ n: number }>("SELECT count(*) AS n FROM evenements WHERE type = 'tool_execution_end' AND outil = 'salle_chercher'")!.n; t.fermer(); return n; };

  test("--memoire non : run.memoire, 31 outils, ESSAIM_MEMOIRE=non, les deux ajouts retirés, faits notés (vérifications comprises)", async () => {
    process.env.ESSAIM_FIXTURE = fixtureTemoin();
    const b = await lancer({ ...base(), memoire: false });
    expect(b.finis).toBe(1);
    expect(duRun(b.run)).toEqual({ memoire: "non", outils: [...OUTILS_PI, ...nomsSalle(true, false)] });
    expect(duRun(b.run).outils).toHaveLength(31);
    expect(duRun(b.run).outils).not.toContain("salle_chercher");
    const l = lancements(b.run)[0]!;
    expect(l.env.ESSAIM_MEMOIRE).toBe("non");
    const consignes = l.args[l.args.indexOf("--append-system-prompt") + 1]!;
    const modele = ligneSalle(readFileSync(join(racineDepot, "src", "consignes-salle.md"), "utf8"));
    expect(modele).toContain(CHERCHER);
    expect(modele).toContain(ETAT);
    expect(ligneSalle(consignes)).toBe(modele.replace(CHERCHER, "").replace(ETAT, "")); // remplacement exact, le reste intact
    expect(ligneSalle(consignes)).toContain("`salle_budget` dit la dépense de toute la salle. Au départ, seul le fil `principal` existe");
    expect(consignes).not.toContain("salle_chercher");
    expect(consignes).not.toContain("À chaque réveil, reprise ou résumé");
    expect(finsChercher(b.run)).toBe(0); // l'outil n'est pas enregistré : le faux pi n'a rien exécuté
    const f = faits(b.run);
    expect(f.some((x) => x.type === "ecriture")).toBe(true);
    expect(f).toContainEqual({ type: "verification", source: "code_tester", statut: "verifie" });
  }, 60_000);

  test("sans l'option : run.memoire = 'oui', 32 outils, pas de ESSAIM_MEMOIRE, consignes entières, salle_chercher exécuté", async () => {
    process.env.ESSAIM_FIXTURE = fixtureTemoin();
    const b = await lancer(base());
    expect(duRun(b.run)).toEqual({ memoire: "oui", outils: [...OUTILS_PI, ...nomsSalle(true)] });
    expect(duRun(b.run).outils).toHaveLength(32);
    const l = lancements(b.run)[0]!;
    expect(l.env.ESSAIM_MEMOIRE).toBeUndefined();
    const consignes = l.args[l.args.indexOf("--append-system-prompt") + 1]!;
    expect(ligneSalle(consignes)).toContain(CHERCHER + "." + ETAT);
    expect(finsChercher(b.run)).toBe(1);
    expect(faits(b.run)).toContainEqual({ type: "verification", source: "code_tester", statut: "verifie" });
  }, 60_000);

  test("sans compactage non plus : 30 outils, et moi_resumer et les deux ajouts retirés ensemble", async () => {
    process.env.ESSAIM_FIXTURE = fixture("hello-fini");
    const b = await lancer({ ...base(), memoire: false, compactage: null });
    expect(duRun(b.run).outils).toEqual([...OUTILS_PI, ...nomsSalle(false, false)]);
    expect(duRun(b.run).outils).toHaveLength(30);
    const l = lancements(b.run)[0]!;
    const consignes = l.args[l.args.indexOf("--append-system-prompt") + 1]!;
    expect(consignes).not.toContain("salle_chercher");
    expect(consignes).not.toContain("moi_resumer");
    expect(consignes).not.toContain("À chaque réveil, reprise ou résumé");
  });

  test("lireMemoire : « non » seulement ; la ligne de commande refuse une autre valeur avec un message clair", () => {
    expect(lireMemoire("non")).toBe(false);
    for (const v of ["oui", "Non", "", "false"]) expect(() => lireMemoire(v)).toThrow("--memoire n'accepte que « non »");
    const aide = Bun.spawnSync(["bun", join(racineDepot, "src", "lancer.ts"), "--help"]);
    expect(aide.stdout.toString()).toContain("--memoire non");
    const refus = Bun.spawnSync(["bun", join(racineDepot, "src", "lancer.ts"), "--agents", "1", "--modele", "faux", "--plafond", "0.10", "--mission", join(racineDepot, "tests", "fixtures", "hello-world.md"), "--sans-bac-a-sable", "--memoire", "oui"],
      { cwd: racine, env: { ...process.env, ESSAIM_TEST: "1", ESSAIM_FIXTURE: fixture("hello-fini") } });
    expect(refus.exitCode).toBe(1);
    expect(refus.stderr.toString()).toBe("essaim : --memoire n'accepte que « non » (run témoin), reçu « oui »\n");
    expect(existsSync(join(racine, "runs"))).toBe(false); // refusé avant d'ouvrir un run
  });
});

