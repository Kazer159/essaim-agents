import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { lancer, erreurPassagere, seuilRonde, formaterBilan, lireCompactage, lireMemoire, lireModeleRole, verifierCoupure, type Options } from "../src/lancer.ts";
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

describe("les quatre garde-fous", () => {
  const ecrireFixture = (nom: string, lignes: object[]) => { const p = join(racine, `${nom}.jsonl`); writeFileSync(p, lignes.map((l) => JSON.stringify(l)).join("\n") + "\n"); return p; };
  const messageCher = (total: number) => ({ type: "message_end", message: { role: "assistant", stopReason: "stop", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total } } } });
  const pancartes = (run: string) => { const t = lire(run); const r = t.all<{ chemin: string }>("SELECT chemin FROM reclamations WHERE retire_le IS NULL"); t.fermer(); return r.map((p) => p.chemin); };

  test("seuil : la dépense observée atteint le plafond, l'agent encore actif est viré, l'agent déjà fini reste fini", async () => {
    process.env.ESSAIM_FIXTURE_ANTOINE = fixture("hello-fini");
    process.env.ESSAIM_FIXTURE_BERNARD = ecrireFixture("cher", [
      { type: "tool_execution_start", toolCallId: "p1", toolName: "fichier_reclamer", args: { chemin: "x.md", raison: "brouillon" } },
      { type: "faux:dormir", ms: 1000 },
      messageCher(0.1),
      { type: "faux:dormir", ms: 6000 },
      { type: "agent_end" },
    ]);
    const debut = Date.now();
    const b = await lancer({ ...base(), agents: 2 });
    expect(Date.now() - debut).toBeLessThan(5000);
    expect(b).toMatchObject({ finis: 1, vires: 1, perdus: 0 });
    expect(b.depassement).toBeGreaterThan(0);
    expect(b.depense).toBeCloseTo(0.1012, 6);
    expect(agentEnBase(b.run, "Antoine").etat).toBe("fini");
    const a2 = agentEnBase(b.run, "Bernard");
    expect([a2.etat, a2.raison_sortie]).toEqual(["vire", "plafond"]);
    expect(pancartes(b.run)).toEqual([]);
    const t = lire(b.run);
    expect(t.all("SELECT resultat_resume, erreur FROM evenements WHERE agent = 'Bernard' AND type = 'sortie'")).toEqual([{ resultat_resume: "vire : plafond", erreur: "vire : plafond" }]);
    t.fermer();
  });

  test("silence : aucun événement pendant plus que le silence toléré", async () => {
    process.env.ESSAIM_FIXTURE = ecrireFixture("muet", [{ type: "faux:dormir", ms: 6000 }, { type: "agent_end" }]);
    const debut = Date.now();
    const b = await lancer({ ...base(), silenceMin: 0.03 });
    expect(Date.now() - debut).toBeLessThan(4000);
    expect(b).toMatchObject({ finis: 0, vires: 1, perdus: 0 });
    expect(agentEnBase(b.run, "Antoine").raison_sortie).toBe("silence");
  });

  test("l'agent qui parle sans rien faire est coupé : le silence se compte sur le travail, pas sur le bruit", async () => {
    // Un agent qui émet du texte sans action utile n'est jamais « silencieux » : le garde-fou doit le voir quand même.
    const bruit = Array.from({ length: 40 }, () => [{ type: "turn_start" }, { type: "faux:dormir", ms: 150 }]).flat();
    process.env.ESSAIM_FIXTURE = ecrireFixture("bavard", [
      { type: "tool_execution_start", toolCallId: "c1", toolName: "salle_poster", args: { texte: "je commence" } },
      { type: "tool_execution_end", toolCallId: "c1", toolName: "salle_poster", content: [{ type: "text", text: "message 1 posté" }] },
      ...bruit,
      { type: "agent_end" },
    ]);
    const debut = Date.now();
    const b = await lancer({ ...base(), silenceMin: 0.03 });
    expect(Date.now() - debut).toBeLessThan(5000);
    expect(b).toMatchObject({ finis: 0, vires: 1, perdus: 0 });
    expect(agentEnBase(b.run, "Antoine").raison_sortie).toBe("silence");
  });

  const maj = (e: Record<string, unknown>) => ({ type: "message_update", assistantMessageEvent: e });
  const helloFini = () => readFileSync(fixture("hello-fini"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const emballee = () => [
    ...Array.from({ length: 35 }, (_, i) => maj({ type: "toolcall_end", contentIndex: i, toolCall: { type: "toolCall", id: `c${i}`, name: "bash", arguments: { command: "true" } } })),
    { type: "faux:dormir", ms: 8000 }, { type: "agent_end" },
  ];
  test("une réponse emballée est coupée et l'agent relancé sans consommer de passe (Hubert, run ville du 25/09)", async () => {
    process.env.ESSAIM_FIXTURE = ecrireFixture("emballee", emballee());
    process.env.ESSAIM_FIXTURE_PASSE_2 = fixture("hello-fini");
    const debut = Date.now();
    const b = await lancer(base());
    expect(Date.now() - debut).toBeLessThan(5000); // coupée tout de suite, sans attendre la fin de la réponse
    expect(b).toMatchObject({ finis: 1, vires: 0, perdus: 0 });
    expect(agentEnBase(b.run, "Antoine").passes).toBe(1);
    const lancements = readFileSync(join(b.run, "journal", "Antoine.args"), "utf8").trim().split("\n").map((l) => JSON.parse(l).args as string[]);
    expect(lancements[1]!.at(-1)).toContain("s'est emballée (30 appels identiques à bash dans une même réponse)");
    const t = lire(b.run);
    expect(t.all<{ resultat_resume: string }>("SELECT resultat_resume FROM evenements WHERE type IN ('emballement', 'relance') ORDER BY id")).toEqual([
      { resultat_resume: "réponse emballée : 30 appels identiques à bash dans une même réponse" },
      { resultat_resume: "réponse emballée coupée (1/3), relancé sans consommer de passe : 30 appels identiques à bash dans une même réponse" },
    ]);
    t.fermer();
  });
  test("emballé à chaque relance : perdu à la quatrième fois", async () => {
    process.env.ESSAIM_FIXTURE = ecrireFixture("emballee", emballee());
    const b = await lancer(base());
    expect(b).toMatchObject({ perdus: 1 });
    const a = agentEnBase(b.run, "Antoine");
    expect([a.etat, a.raison_sortie, a.passes]).toEqual(["perdu", "réponse emballée 4 fois : 30 appels identiques à bash dans une même réponse", 1]);
  });
  test("une longue réflexion qui avance n'est pas un silence (Jules, run ville du 25/09)", async () => {
    const pensee = Array.from({ length: 24 }, (_, i) => [maj({ type: "thinking_delta", delta: `Étape ${i} : la forme ${i * 7} demande ${i * 3} sommets. ` }), { type: "faux:dormir", ms: 150 }]).flat();
    process.env.ESSAIM_FIXTURE = ecrireFixture("pensee-longue", [...pensee, ...helloFini()]);
    const b = await lancer({ ...base(), silenceMin: 0.03 }); // 1,8 s de silence toléré, 3,6 s de pensée
    expect(b).toMatchObject({ finis: 1, vires: 0 });
  });
  test("une seule réponse a sa borne : au-delà, « réflexion sans fin »", async () => {
    const pensee = Array.from({ length: 40 }, (_, i) => [maj({ type: "thinking_delta", delta: `Étape ${i} : la forme ${i * 7} demande ${i * 3} sommets. ` }), { type: "faux:dormir", ms: 100 }]).flat();
    process.env.ESSAIM_FIXTURE = ecrireFixture("pensee-sans-fin", [...pensee, { type: "agent_end" }]);
    process.env.ESSAIM_REFLEXION_MAX_MS = "1000";
    try {
      const b = await lancer(base());
      expect(b).toMatchObject({ vires: 1 });
      expect(agentEnBase(b.run, "Antoine").raison_sortie).toBe("réflexion sans fin");
    } finally { delete process.env.ESSAIM_REFLEXION_MAX_MS; }
  });

  test("un résumé long n'est coupé ni pour silence ni pour outil bloqué (run réseau du 24/09)", async () => {
    process.env.ESSAIM_FIXTURE = ecrireFixture("resume-long", [
      { type: "tool_execution_start", toolCallId: "c1", toolName: "salle_poster", args: { texte: "je commence" } },
      { type: "tool_execution_end", toolCallId: "c1", toolName: "salle_poster", content: [{ type: "text", text: "message 1 posté" }] },
      { type: "compaction_start", reason: "manual" },
      { type: "faux:dormir", ms: 1500 },
      { type: "compaction_end", reason: "manual", result: { tokensBefore: 150_000 }, aborted: false, willRetry: false },
      { type: "tool_execution_start", toolCallId: "c2", toolName: "moi_finir", args: { raison: "fait" } },
      { type: "tool_execution_end", toolCallId: "c2", toolName: "moi_finir", content: [{ type: "text", text: "fini" }] },
      { type: "agent_end" },
    ]);
    const b = await lancer({ ...base(), silenceMin: 0.01, outilMaxMin: 0.01 }); // 600 ms chacun, le résumé en dure 1 500
    expect(b).toMatchObject({ finis: 1, vires: 0 });
  });

  test("un résumé au-delà de sa borne est refait (A8, 02/10), puis refait sur une mémoire sans images ; au troisième blocage, l'agent est coupé", async () => {
    const image = { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" };
    const memoire = [0, 1].map((i) => JSON.stringify({ type: "message", id: `r${i}`, parentId: i ? `r${i - 1}` : null,
      message: { role: "toolResult", toolCallId: `c${i}`, toolName: "read", content: [{ type: "text", text: "Read image file [image/png]" }, image] } })).join("\n") + "\n";
    process.env.ESSAIM_FIXTURE = ecrireFixture("resume-bloque", [
      { type: "faux:session", contenu: memoire },
      { type: "compaction_start", reason: "manual" },
      { type: "faux:dormir", ms: 6000 },
      { type: "agent_end" },
    ]);
    process.env.ESSAIM_FIXTURE_ANTOINE_PASSE_2 = ecrireFixture("resume-bloque-2", [{ type: "compaction_start", reason: "manual" }, { type: "faux:dormir", ms: 6000 }, { type: "agent_end" }]);
    process.env.ESSAIM_FIXTURE_ANTOINE_PASSE_3 = process.env.ESSAIM_FIXTURE_ANTOINE_PASSE_2;
    process.env.ESSAIM_RESUME_MAX_MS = "600";
    const debut = Date.now();
    try {
      const b = await lancer(base());
      expect(Date.now() - debut).toBeLessThan(8000);
      expect(b).toMatchObject({ vires: 1 });
      expect(agentEnBase(b.run, "Antoine").raison_sortie).toBe("résumé bloqué");
      const t = ouvrirBun(join(b.run, "tableau.sqlite"), { lectureSeule: true });
      const relances = t.all<{ resultat_resume: string }>("SELECT resultat_resume FROM evenements WHERE type = 'relance' AND resultat_resume LIKE 'résumé bloqué%' ORDER BY id").map((e) => e.resultat_resume);
      t.fermer();
      expect(relances).toEqual(["résumé bloqué coupé (1/2), résumé refait sans consommer de passe", "résumé bloqué coupé (2/2), mémoire allégée de 2 images, résumé refait sans consommer de passe"]);
      expect(readFileSync(join(b.run, "sessions", "faux_Antoine.jsonl"), "utf8")).not.toContain('"image"');
    } finally {
      delete process.env.ESSAIM_RESUME_MAX_MS;
    }
  });

  test("A8 : un résumé refait qui aboutit garde l'agent, sans passe consommée", async () => {
    process.env.ESSAIM_FIXTURE = ecrireFixture("resume-bloque-une-fois", [{ type: "compaction_start", reason: "manual" }, { type: "faux:dormir", ms: 6000 }, { type: "agent_end" }]);
    process.env.ESSAIM_FIXTURE_ANTOINE_PASSE_2 = fixture("hello-fini");
    process.env.ESSAIM_RESUME_MAX_MS = "600";
    try {
      const b = await lancer(base());
      expect(b).toMatchObject({ finis: 1, vires: 0 });
    } finally {
      delete process.env.ESSAIM_RESUME_MAX_MS;
    }
  });

  test("R1 (02/10) : un résumé raté (réponse vide) est refait sans passe, la 2e fois sur une mémoire sans images ; réussi, l'agent continue", async () => {
    const rate = [
      { type: "compaction_start", reason: "manual" },
      { type: "compaction_end", reason: "manual", aborted: false, willRetry: false, errorMessage: "Compaction failed: Summarization failed: Provider returned an empty response" },
      { type: "tool_execution_start", toolCallId: "r1", toolName: "moi_resumer", args: { note: "je relisais les pages" } },
      { type: "agent_end" },
    ];
    process.env.ESSAIM_FIXTURE = ecrireFixture("resume-rate", rate);
    process.env.ESSAIM_FIXTURE_ANTOINE_PASSE_3 = fixture("hello-fini");
    const b = await lancer(base());
    expect(b).toMatchObject({ finis: 1, perdus: 0 });
    const t = lire(b.run);
    const relances = t.all<{ resultat_resume: string }>("SELECT resultat_resume FROM evenements WHERE type = 'relance' AND resultat_resume LIKE 'résumé raté%' ORDER BY id").map((e) => e.resultat_resume);
    t.fermer();
    expect(relances).toEqual(["résumé raté (1/2), résumé refait sans consommer de passe", "résumé raté (2/2), résumé refait sans consommer de passe"]);
    expect(agentEnBase(b.run, "Antoine").passes).toBe(1);
  });

  test("R1 : pas de boucle ; un résumé qui réussit puis rate deux fois, encore et encore, s'arrête à six résumés refaits, puis la règle des passes", async () => {
    const rate = [
      { type: "compaction_start", reason: "manual" },
      { type: "compaction_end", reason: "manual", aborted: false, willRetry: false, errorMessage: "Compaction failed: Summarization failed: Provider returned an empty response" },
      { type: "tool_execution_start", toolCallId: "r1", toolName: "moi_resumer", args: { note: "suite" } }, { type: "agent_end" },
    ];
    const reussi = [ // le résumé passe, mais la mémoire reste trop grosse : l'agent le redemande aussitôt
      { type: "compaction_start", reason: "manual" }, { type: "compaction_end", reason: "manual", aborted: false, willRetry: false, result: { tokensBefore: 170000 } },
      { type: "tool_execution_start", toolCallId: "r2", toolName: "moi_resumer", args: { note: "suite" } }, { type: "agent_end" },
    ];
    process.env.ESSAIM_FIXTURE = ecrireFixture("rate-toujours", rate);
    for (const n of [3, 6, 9]) process.env[`ESSAIM_FIXTURE_ANTOINE_PASSE_${n}`] = ecrireFixture(`reussi-${n}`, reussi);
    const b = await lancer(base());
    expect(b).toMatchObject({ finis: 0, perdus: 1 });
    const t = lire(b.run);
    const rates = t.get<{ n: number }>("SELECT count(*) AS n FROM evenements WHERE type = 'relance' AND resultat_resume LIKE 'résumé raté%'")!.n;
    t.fermer();
    expect(rates).toBe(6);
    expect(agentEnBase(b.run, "Antoine").raison_sortie).toBe("passes épuisées");
  }, 30_000);

  test("R1 : « Provider returned an empty response » est une erreur passagère ; une erreur d'outil ne l'est pas", () => {
    expect(erreurPassagere("Provider returned an empty response")).toBe(true);
    expect(erreurPassagere("Compaction failed: Summarization failed: Provider returned an empty response")).toBe(true);
    expect(erreurPassagere("fichier introuvable")).toBe(false);
  });

  test("K11 (03/10) : « JSON error injected into SSE stream » est passagère ; une image trop grosse ne l'est pas (K9, traitée à part)", () => {
    expect(erreurPassagere("JSON error injected into SSE stream")).toBe(true);
    expect(erreurPassagere('413: {"message":"Downloaded image content cannot exceed 30MB","code":413}')).toBe(false);
  });

  test("R2 (02/10) : la ronde part dès trois constructeurs disponibles, un tiers d'une petite équipe, deux au moins", () => {
    expect([2, 3, 4, 6, 7, 9, 15, 30].map(seuilRonde)).toEqual([2, 2, 2, 2, 3, 3, 3, 3]);
  });

  test("outil trop long : un outil commencé sans fin au-delà du délai", async () => {
    process.env.ESSAIM_FIXTURE = ecrireFixture("bloque", [
      { type: "tool_execution_start", toolCallId: "call_9", toolName: "bash", args: { command: "sleep 3600" } },
      { type: "faux:dormir", ms: 6000 },
      { type: "agent_end" },
    ]);
    const debut = Date.now();
    const b = await lancer({ ...base(), outilMaxMin: 0.03 });
    expect(Date.now() - debut).toBeLessThan(4000);
    expect(b).toMatchObject({ vires: 1 });
    expect(agentEnBase(b.run, "Antoine").raison_sortie).toBe("outil bloqué : bash");
  });

});

describe("le sommeil", () => {
  test("toute la salle dort : le run se ferme, les dormeurs comptent comme finis", async () => {
    process.env.ESSAIM_FIXTURE = fixture("dormir");
    process.env.ESSAIM_TOUR_MS = "0"; // le tour de parole du démarrage a son propre test
    const b = await lancer({ ...base(), agents: 2 });
    expect(b).toMatchObject({ finis: 2, vires: 0, perdus: 0, endormis: 2 });
    for (const nom of ["Antoine", "Bernard"]) {
      const a = agentEnBase(b.run, nom);
      expect(a.etat).toBe("fini");
      expect(a.raison_sortie).toBe("salle endormie : personne ne l'a rappelé");
      expect(a.sommeils).toBe(1);
      expect(a.passes).toBe(1); // dormir ne consomme pas de passe
    }
    expect(formaterBilan(b)).toContain("salle endormie : 2 en veille à la fermeture");
    const t = lire(b.run);
    expect(t.all("SELECT texte FROM messages WHERE texte LIKE '[en sommeil]%'").length).toBe(2);
    t.fermer();
  });

  test("un dormeur n'est coupé ni pour silence ni pour outil bloqué", async () => {
    process.env.ESSAIM_FIXTURE = fixture("dormir");
    process.env.ESSAIM_TOUR_MS = "0";
    process.env.ESSAIM_GRACE_MS = "1500"; // la salle ne ferme qu'après ; le silence aurait coupé bien avant
    const debut = Date.now();
    const b = await lancer({ ...base(), silenceMin: 0.01, outilMaxMin: 0.01 }); // 600 ms chacun
    expect(Date.now() - debut).toBeGreaterThan(1500);
    expect(b).toMatchObject({ finis: 1, vires: 0, endormis: 1 });
    expect(agentEnBase(b.run, "Antoine").raison_sortie).toBe("salle endormie : personne ne l'a rappelé");
  });

  test("un agent nommé se réveille sur ce qu'on lui a dit, reprend sans consommer de passe et sort par fini", async () => {
    process.env.ESSAIM_FIXTURE_ANTOINE = fixture("dormir");
    process.env.ESSAIM_FIXTURE = fixture("appelle-antoine");
    process.env.ESSAIM_FIXTURE_PASSE_2 = fixture("reveille-fini"); // seul Antoine est relancé
    process.env.ESSAIM_TOUR_MS = "0"; // Bernard n'attend pas son tour pour lancer l'appel
    const b = await lancer({ ...base(), agents: 2 });
    expect(b).toMatchObject({ finis: 2, vires: 0, perdus: 0 });
    expect(b.endormis).toBeUndefined();
    const a = agentEnBase(b.run, "Antoine");
    expect(a.raison_sortie).toBe("réveillé puis parti");
    expect(a.etat).toBe("fini");
    expect(a.passes).toBe(1); // un réveil n'est pas une passe
    const lignes = readFileSync(join(b.run, "journal", "Antoine.args"), "utf8").trim().split("\n");
    expect(lignes.length).toBe(2);
    const relance = JSON.parse(lignes[1]!).args as string[];
    expect(relance[relance.length - 1]).toContain("Tu étais en veille. Bernard t'a nommé");
    expect(relance[relance.length - 1]).toContain("le bouton Annuler ne restaure rien");
    expect(relance).not.toContain("continue");
    const t = lire(b.run);
    expect(t.get<{ resultat_resume: string }>("SELECT resultat_resume FROM evenements WHERE type = 'reveil'")?.resultat_resume).toContain("réveillé par Bernard");
    t.fermer();
  });

  test("une veille plus longue que le délai de silence ne fait pas virer au réveil (run vallée, Claude)", async () => {
    process.env.ESSAIM_FIXTURE_ANTOINE = fixture("dormir");
    process.env.ESSAIM_FIXTURE = fixture("appelle-antoine-tard"); // Bernard travaille 2,4 s avant de nommer Antoine
    process.env.ESSAIM_FIXTURE_PASSE_2 = fixture("reveille-lent-fini"); // pi relit sa session avant de répondre
    process.env.ESSAIM_TOUR_MS = "0";
    const b = await lancer({ ...base(), agents: 2, silenceMin: 0.02 }); // 1,2 s de silence au plus
    expect(agentEnBase(b.run, "Antoine")).toMatchObject({ etat: "fini", raison_sortie: "réveillé puis parti" });
    expect(b).toMatchObject({ finis: 2, vires: 0 });
  });

  test("contexte trop gros avant la veille : le réveil passe par un résumé", async () => {
    process.env.ESSAIM_FIXTURE_ANTOINE = fixture("dormir-contexte");
    process.env.ESSAIM_FIXTURE = fixture("appelle-antoine");
    process.env.ESSAIM_FIXTURE_PASSE_2 = fixture("reveille-fini");
    process.env.ESSAIM_TOUR_MS = "0";
    const b = await lancer({ ...base(), agents: 2, plafond: 1 });
    expect(b).toMatchObject({ finis: 2 });
    const relance = JSON.parse(readFileSync(join(b.run, "journal", "Antoine.args"), "utf8").trim().split("\n")[1]!).args as string[];
    expect(relance.some((x) => x.startsWith("/se-resumer"))).toBe(true);
    expect(relance[relance.length - 1]).toContain("Tu étais en veille");
    const t = lire(b.run);
    expect(t.get<{ resultat_resume: string }>("SELECT resultat_resume FROM evenements WHERE type = 'reveil'")?.resultat_resume).toContain("après résumé");
    t.fermer();
  });
});

describe("fils de concentration : les résumés de lots servis par le lanceur (26/09, W3, W4, O41)", () => {
  const ecrireFixture = (nom: string, lignes: object[]) => { const p = join(racine, `${nom}.jsonl`); writeFileSync(p, lignes.map((l) => JSON.stringify(l)).join("\n") + "\n"); return p; };
  const appel = (id: string, toolName: string, args: object) => ({ type: "tool_execution_start", toolCallId: id, toolName, args });
  // Antoine poste dans q-neige un message qui fait un lot à lui seul (ESSAIM_TAILLE_LOT = 150 ; principal reste en
  // dessous, sans lot), attend que le lecteur ait lu (le premier demandeur du lot, c'est lui) et part.
  const ecrivain = () => ecrireFixture("ecrivain", [
    appel("a1", "salle_poster", { texte: "je prends la neige" }),
    appel("a3", "salle_poster", { texte: "la neige tombe trop vite sur la carte du nord. ".repeat(5), fil: "q-neige" }),
    { type: "faux:toucher", chemin: "{RUN}/antoine-a-poste" },
    { type: "faux:attendre", chemin: "{RUN}/lecteur-a-lu" },
    appel("a5", "moi_finir", { raison: "neige faite" })]);
  // Le lecteur lit sa boîte une fois le lot écrit : le lot clos de q-neige lui est demandé résumé.
  const lecteur = (suite: object[]) => ecrireFixture("lecteur", [{ type: "faux:attendre", chemin: "{RUN}/antoine-a-poste" }, appel("l1", "salle_lire", {}), { type: "faux:toucher", chemin: "{RUN}/lecteur-a-lu" }, ...suite]);
  let compte: string;
  const appelsResumeur = () => (existsSync(compte) ? readFileSync(compte, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { modele: string }) : []);
  const lots = (run: string) => { const t = lire(run); const r = t.all<Record<string, unknown>>("SELECT etat, essais, cout_usd, demande_par, cote, modele FROM lots"); t.fermer(); return r; };
  beforeEach(() => {
    compte = join(racine, "resumeur.txt");
    Object.assign(process.env, { ESSAIM_RESUMEUR: join(racineDepot, "tests", "aide", "faux-resumeur.ts"), ESSAIM_FAUX_RESUME_COMPTE: compte, ESSAIM_TAILLE_LOT: "150", ESSAIM_ATTENTE_RESUME: "5000", ESSAIM_TOUR_MS: "0" });
  });
  afterEach(() => { for (const k of ["ESSAIM_RESUMEUR", "ESSAIM_FAUX_RESUME_COMPTE", "ESSAIM_FAUX_RESUME_MODE", "ESSAIM_FAUX_RESUME_MS", "ESSAIM_TAILLE_LOT", "ESSAIM_ATTENTE_RESUME"]) delete process.env[k]; });

  test("le coût des résumés entre dans le seuil : les seuls résumés au-delà du plafond coupent la salle ; lots.cout_usd et bilan", async () => {
    process.env.ESSAIM_FIXTURE_ANTOINE = ecrivain();
    process.env.ESSAIM_FIXTURE = lecteur([{ type: "faux:dormir", ms: 6000 }, { type: "agent_end" }]);
    const debut = Date.now();
    const b = await lancer({ ...base(), agents: 2, plafond: 0.001 }); // un résumé du faux coûte 0,0012 $ ; les agents, rien
    expect(Date.now() - debut).toBeLessThan(5000);
    expect(agentEnBase(b.run, "Bernard")).toMatchObject({ etat: "vire", raison_sortie: "plafond" });
    expect(b.depense).toBeCloseTo(0.0012, 9);
    expect(b.depassement).toBeCloseTo(0.0002, 9);
    expect(b.resumes).toEqual({ cout: 0.0012, lots: 1 });
    expect(lots(b.run)).toEqual([{ etat: "fait", essais: 1, cout_usd: 0.0012, demande_par: "Bernard", cote: "hommes", modele: "faux/faux" }]);
    const t = lire(b.run);
    expect(t.all("SELECT agent FROM evenements WHERE type = 'resumes_livres'")).toContainEqual({ agent: "Bernard" }); // la boîte n'a pas attendu pour rien
    t.fermer();
  });

  test("run à deux modèles : le lot est résumé par le modèle du côté du premier demandeur et compté de son côté (O41)", async () => {
    process.env.ESSAIM_FIXTURE_ANTOINE = ecrivain();
    process.env.ESSAIM_FIXTURE = lecteur([appel("l2", "moi_finir", { raison: "lu" })]);
    const b = await lancer({ ...base(), agents: 2, modeleFemmes: "faux-bis" });
    expect(b).toMatchObject({ finis: 2 });
    expect(appelsResumeur().map((a) => a.modele)).toEqual(["faux/faux-bis"]);
    expect(lots(b.run)).toEqual([{ etat: "fait", essais: 1, cout_usd: 0.0012, demande_par: "Agathe", cote: "femmes", modele: "faux/faux-bis" }]);
    expect(b.parCote?.map((c) => [c.cote, c.cout])).toEqual([["hommes", 0], ["femmes", 0.0012]]);
    expect(b.depense).toBeCloseTo(0.0012, 9);
  });

  test("fin du run : le résumeur en cours est tué et attendu, son lot passe en échec ; la boîte a reçu les bruts (W4, P5)", async () => {
    process.env.ESSAIM_FAUX_RESUME_MODE = "lent";
    process.env.ESSAIM_FAUX_RESUME_MS = "20000";
    process.env.ESSAIM_ATTENTE_RESUME = "300";
    process.env.ESSAIM_FIXTURE_ANTOINE = ecrivain();
    process.env.ESSAIM_FIXTURE = lecteur([appel("l2", "moi_finir", { raison: "lu" })]);
    const debut = Date.now();
    const b = await lancer({ ...base(), agents: 2 });
    expect(Date.now() - debut).toBeLessThan(8000);
    expect(b).toMatchObject({ finis: 2 });
    expect(appelsResumeur().length).toBe(1);
    expect(lots(b.run)).toMatchObject([{ etat: "echec", essais: 1, demande_par: "Bernard" }]);
    const t = lire(b.run);
    expect(t.get<{ n: number }>("SELECT count(*) AS n FROM evenements WHERE type = 'resumes_livres'")?.n).toBe(0);
    expect(t.get<{ n: number }>("SELECT count(*) AS n FROM presences")?.n).toBe(0);
    t.fermer();
  });
});

describe("arrêt depuis la vue", () => {
  test("un fichier arret dans le dossier du run vire les agents actifs et clôt le run", async () => {
    const p = join(racine, "long.jsonl");
    writeFileSync(p, [{ type: "faux:dormir", ms: 6000 }, { type: "agent_end" }].map((l) => JSON.stringify(l)).join("\n") + "\n");
    process.env.ESSAIM_FIXTURE = p;
    const debut = Date.now();
    const minuterie = setTimeout(() => {
      const runs = join(racine, "runs");
      for (const d of readdirSync(runs)) if (!d.startsWith(".")) writeFileSync(join(runs, d, "arret"), "test");
    }, 500);
    const b = await lancer({ ...base(), agents: 2 });
    clearTimeout(minuterie);
    expect(Date.now() - debut).toBeLessThan(5000);
    expect(b).toMatchObject({ finis: 0, vires: 2, perdus: 0 });
    expect(agentEnBase(b.run, "Antoine").raison_sortie).toBe("arrêté depuis la vue");
    expect(lire(b.run).get<{ etat: string }>("SELECT etat FROM run")?.etat).toBe("termine");
  });
});

