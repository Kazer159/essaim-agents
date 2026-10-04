// Le banc d'essai hors run : situations, catalogues figés, lancement sur un faux modèle.
// Aucun réseau, aucun vrai pi : ESSAIM_PI désigne tests/aide/faux-banc.ts.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ANCIENS_OUTILS_SALLE, OUTIL_MEMOIRE, OUTILS_RETIRES, OUTILS_SALLE } from "../src/noms-outils.ts";
import { motsInterdits } from "./aide/mots-interdits.ts";

const RACINE = new URL("..", import.meta.url).pathname;
type Attendu = { outil: string; args?: Record<string, unknown>; motif?: string };
type Situation = { id: string; contexte: string; attendu: { avant: Attendu; apres: Attendu }; equivalences?: { avant?: string[]; apres?: string[] } };
const fichier = JSON.parse(readFileSync(`${RACINE}sondes/banc-situations.json`, "utf8")) as { regles: string[]; preambule: string; situations: Situation[] };

describe("situations du banc (8.1)", () => {
  test("une vingtaine, identifiants uniques, chacune avec un attendu par catalogue", () => {
    const ids = fichier.situations.map((s) => s.id);
    expect(ids.length).toBeGreaterThanOrEqual(18);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of fichier.situations) {
      expect(s.contexte.length).toBeGreaterThan(0);
      expect(s.attendu.avant.outil.length).toBeGreaterThan(0);
      expect(s.attendu.apres.outil.length).toBeGreaterThan(0);
      for (const a of [s.attendu.avant, s.attendu.apres]) if (a.motif) expect(() => new RegExp(a.motif!)).not.toThrow();
    }
  });

  test("les règles sont écrites dans le fichier : sans appel, plusieurs appels, seuil de repli", () => {
    const regles = fichier.regles.join("\n");
    expect(regles).toContain("« sans appel »");
    expect(regles).toContain("seul le premier compte");
    expect(regles).toContain("au moins aussi bien que l'ancienne en « bon outil du premier coup »");
    expect(regles).toContain("repli O4 (anciens noms, autres leviers seuls) à trancher avec l'utilisateur");
  });

  test("D4 : un contexte dit des faits, sans tournure interdite ni nom d'outil", () => {
    // Les noms à tiret bas seulement : poster, voir, essai… sont aussi des mots de la langue.
    const noms = [...OUTILS_SALLE, ...ANCIENS_OUTILS_SALLE].filter((n) => n.includes("_"));
    for (const texte of [fichier.preambule, ...fichier.situations.map((s) => s.contexte)]) {
      expect(motsInterdits(texte)).toEqual([]);
      expect(noms.filter((n) => texte.includes(n))).toEqual([]);
      expect(texte).not.toContain("`");
    }
  });
});

describe("catalogues figés (8.2, G20)", () => {
  test("figer(racine) sur ce dépôt : 28 outils sérialisables et les consignes aux gabarits remplis", async () => {
    const { figer } = await import("../sondes/banc-outils.ts");
    const avantEnv = { ...process.env };
    const c = await figer(RACINE);
    expect(process.env.ESSAIM_AGENT).toBe(avantEnv.ESSAIM_AGENT); // l'environnement est rendu tel quel
    expect(process.env.ESSAIM_TABLEAU).toBe(avantEnv.ESSAIM_TABLEAU);
    expect(c.outils.map((o) => o.name).sort()).toEqual([...OUTILS_SALLE].sort());
    for (const o of c.outils) {
      expect(o.description.length).toBeGreaterThan(0);
      expect(o.promptSnippet?.startsWith(`${o.name}(`)).toBe(true);
      expect(JSON.parse(JSON.stringify(o.parameters))).toEqual(o.parameters as never);
      expect((o.parameters as { type?: string }).type).toBe("object");
    }
    expect(c.commit).toMatch(/^[0-9a-f]{7,}$/);
    expect(c.consignes).toContain("**Claude**");
    expect(c.consignes).toContain("**10**");
    for (const g of ["{NOM}", "{N}", "{PARTAGE}", "{ENTREES}", "## Les documents à traiter"]) expect(c.consignes).not.toContain(g);
    expect(c.consignes).toContain("moi_resumer"); // compactage chargé : la mention reste
  });

  test("les catalogues commités : 26 anciens outils avant, les 30 nouveaux après (dont les 3 de fil retirés depuis), même forme", () => {
    const lire = (n: string) => JSON.parse(readFileSync(`${RACINE}sondes/banc/catalogue-${n}.json`, "utf8")) as { commit: string; consignes: string; outils: Array<{ name: string; parameters: unknown }> };
    const avant = lire("avant"), apres = lire("apres");
    expect(avant.commit).toBe("2a1adef");
    expect(avant.outils.map((o) => o.name).sort()).toEqual([...ANCIENS_OUTILS_SALLE].sort());
    // figé avant le second cerveau : sans salle_chercher, et avec les trois outils de fil, retirés depuis
    expect(apres.outils.map((o) => o.name).sort()).toEqual([...OUTILS_SALLE.filter((n) => n !== OUTIL_MEMOIRE), ...OUTILS_RETIRES].sort());
    for (const c of [avant, apres]) {
      expect(c.consignes).toContain("**Claude**");
      expect(c.consignes).not.toContain("{NOM}");
    }
  });
});

describe("jugement et rapport (8.3)", () => {
  const catalogue = JSON.parse(readFileSync(`${RACINE}sondes/banc/catalogue-apres.json`, "utf8"));
  const sit: Situation = { id: "s", contexte: "…", attendu: { avant: { outil: "ticket", args: { id: 9 } }, apres: { outil: "ticket_modifier", args: { id: 9, etat: "ferme" } } }, equivalences: { apres: ["bash ~ git[^\"]*log"] } };

  test("bon outil : nom, arguments attendus (texte sans casse, « * » présent), motif, équivalences", async () => {
    const { juger } = await import("../sondes/banc-outils.ts");
    const j = (appels: Array<{ name: string; arguments: unknown }>) => juger(sit, "apres", catalogue, { appels, cout: 0.001 });
    expect(j([{ name: "ticket_modifier", arguments: { id: 9, etat: " Ferme " } }])).toMatchObject({ bon: true, valide: true, inconnu: false, sansAppel: false, plusieurs: false });
    expect(j([{ name: "ticket_modifier", arguments: { id: 8, etat: "ferme" } }])).toMatchObject({ bon: false, valide: true });
    expect(j([{ name: "bash", arguments: { command: "git log --oneline" } }])).toMatchObject({ bon: true, valide: null });
    expect(j([{ name: "bash", arguments: { command: "ls" } }])).toMatchObject({ bon: false });
    expect(j([{ name: "ticket_modifier", arguments: { etat: "ferme" } }])).toMatchObject({ bon: false, valide: false });
    expect(j([{ name: "ticket_fermer", arguments: {} }])).toMatchObject({ bon: false, inconnu: true, valide: false });
    expect(j([])).toMatchObject({ bon: false, sansAppel: true, plusieurs: false });
    expect(j([]).outil).toBeUndefined();
    expect(j([{ name: "ticket_modifier", arguments: { id: 9, etat: "ferme" } }, { name: "salle_poster", arguments: { texte: "x" } }])).toMatchObject({ bon: true, plusieurs: true, nbAppels: 2 });
    const etoile: Situation = { ...sit, attendu: { ...sit.attendu, apres: { outil: "fil_quitter", args: { conclusion: "*" }, motif: "accord" } } };
    expect(juger(etoile, "apres", catalogue, { appels: [{ name: "fil_quitter", arguments: { conclusion: "accord trouvé" } }], cout: 0 }).bon).toBe(true);
    expect(juger(etoile, "apres", catalogue, { appels: [{ name: "fil_quitter", arguments: { conclusion: "" } }], cout: 0 }).bon).toBe(false);
  });

  test("le rapport compte par catalogue et conclut selon le seuil de repli", async () => {
    const { rapport } = await import("../sondes/banc-outils.ts");
    const v = (catalogue: "avant" | "apres", bon: boolean) => ({ situation: "s", catalogue, bon, valide: true, inconnu: false, sansAppel: false, plusieurs: false, nbAppels: 1, cout: 0.01, outil: "x" });
    const tenu = rapport([v("avant", true), v("apres", true)], { modele: "m", avant: "a1", apres: "b2" });
    expect(tenu.json.conclusion.repli).toBe(false);
    expect(tenu.texte).toContain("seuil tenu");
    const repli = rapport([v("avant", true), v("apres", false)], { modele: "m", avant: "a1", apres: "b2" });
    expect(repli.json.conclusion.repli).toBe(true);
    expect(repli.texte).toContain("repli O4 (anciens noms, autres leviers seuls) à trancher avec l'utilisateur");
  });
});

describe("T16 : le banc sur un faux modèle (8.4)", () => {
  const situations = {
    regles: [], preambule: "La salle construit une simulation de neige.",
    situations: [
      { id: "budget", contexte: "Chloé demande ce qui reste.", attendu: { avant: { outil: "budget" }, apres: { outil: "salle_budget" } } },
      { id: "ticket-9", contexte: "Le ticket 9 est corrigé par abc1234.", attendu: { avant: { outil: "ticket", args: { id: 9, etat: "ferme" } }, apres: { outil: "ticket_modifier", args: { id: 9, etat: "ferme" } } } },
      { id: "relire", contexte: "Ton contexte vient d'être résumé.", attendu: { avant: { outil: "boite", args: { complet: true } }, apres: { outil: "fil_historique" } } },
    ],
  };
  // Par situation et par catalogue : bon outil, mauvais outil, nom inconnu, arguments invalides, aucun appel, deux appels.
  const premier = {
    budget: { avant: [{ name: "budget", arguments: {} }], apres: [{ name: "salle_budget", arguments: {} }, { name: "salle_poster", arguments: { texte: "il reste 2 $" } }] },
    "ticket-9": { avant: [{ name: "poster", arguments: { texte: "fermé" } }], apres: [{ name: "ticket_modifier", arguments: { etat: "ferme" } }] },
    relire: { avant: [], apres: [{ name: "fil_relire", arguments: {} }] },
  };
  const lancerFaux = async (reponses: object, sortieRelative?: string) => {
    const d = mkdtempSync(join(tmpdir(), "banc-t16-"));
    writeFileSync(join(d, "situations.json"), JSON.stringify(situations));
    writeFileSync(join(d, "reponses.json"), JSON.stringify(reponses));
    const env = { ESSAIM_PI: process.env.ESSAIM_PI, FAUX_BANC_REPONSES: process.env.FAUX_BANC_REPONSES, FAUX_BANC_JOURNAL: process.env.FAUX_BANC_JOURNAL };
    Object.assign(process.env, { ESSAIM_PI: `${RACINE}tests/aide/faux-banc.ts`, FAUX_BANC_REPONSES: join(d, "reponses.json"), FAUX_BANC_JOURNAL: join(d, "journal.jsonl") });
    try {
      const { lancer } = await import("../sondes/banc-outils.ts");
      const sortie = sortieRelative ?? join(d, "sortie");
      const r = await lancer({ modele: "faux", sortie, situations: join(d, "situations.json") });
      const journal = readFileSync(join(d, "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      const rapportTexte = readFileSync(join(sortie, "rapport.txt"), "utf8");
      expect(JSON.parse(readFileSync(join(sortie, "rapport.json"), "utf8")).conclusion).toEqual(r.json.conclusion);
      rmSync(d, { recursive: true, force: true });
      return { r, journal, rapportTexte };
    } finally {
      for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  };

  test("chaque cas est compté juste, et la commande de pi est celle du banc", async () => {
    const { r, journal, rapportTexte } = await lancerFaux(premier);
    const { avant, apres } = r.json;
    expect(avant).toMatchObject({ situations: 3, bon: 1, valides: 2, appelsSalle: 2, inconnus: 0, sansAppel: 1, plusieurs: 0, pannes: 0 });
    expect(apres).toMatchObject({ situations: 3, bon: 1, valides: 1, appelsSalle: 2, inconnus: 1, sansAppel: 0, plusieurs: 1, pannes: 0 });
    expect(avant.cout).toBeCloseTo(0.003);
    const v = (s: string, c: string) => r.json.verdicts.find((x: { situation: string; catalogue: string }) => x.situation === s && x.catalogue === c);
    expect(v("ticket-9", "apres")).toMatchObject({ outil: "ticket_modifier", valide: false, bon: false });
    expect(v("ticket-9", "avant")).toMatchObject({ outil: "poster", valide: true, bon: false });
    expect(v("budget", "apres")).toMatchObject({ bon: true, plusieurs: true, nbAppels: 2 });
    expect(r.json.conclusion.repli).toBe(false); // 1 contre 1 : au moins aussi bien
    expect(rapportTexte).toContain("seul le premier compte");
    expect(rapportTexte).toContain("seuil tenu");

    // Deux lancements par situation, un par catalogue, avec les consignes et les outils de ce catalogue.
    expect(journal.length).toBe(6);
    const cat = (c: string) => JSON.parse(readFileSync(`${RACINE}sondes/banc/catalogue-${c}.json`, "utf8"));
    for (const j of journal) {
      const a: string[] = j.argv;
      const c = cat(j.cote);
      expect(j.outils).toBe(c.outils.length);
      for (const opt of ["--mode", "-p", "--no-skills", "--no-extensions", "--no-context-files", "--no-session"]) expect(a).toContain(opt);
      expect(a[a.indexOf("-e") + 1]).toBe(`${RACINE}sondes/banc-extension.ts`);
      expect(a[a.indexOf("--model") + 1]).toBe("faux/faux");
      expect(a[a.indexOf("--thinking") + 1]).toBe("off");
      expect(a[a.indexOf("--append-system-prompt") + 1]).toBe(c.consignes);
      expect(a[a.indexOf("--") + 1]!.startsWith("La salle construit une simulation de neige.\n\n")).toBe(true);
      expect(a.length).toBe(a.indexOf("--") + 2);
    }
  });

  test("banc-extension sous Node : outils enregistrés, appels bloqués, arrêt à la première réponse, jamais deux requêtes", () => {
    const d = mkdtempSync(join(tmpdir(), "banc-ext-"));
    const script = (suite: string) => `
      import ext from ${JSON.stringify(`${RACINE}sondes/banc-extension.ts`)};
      const outils = [], h = {};
      ext({ registerTool: (o) => outils.push(o), on: (n, f) => { h[n] = f; } });
      console.log(JSON.stringify({ n: outils.length, param: outils[0].parameters.type, bloque: h.tool_call({}) }));
      ${suite}`;
    const node = (suite: string) => Bun.spawnSync(["node", "--no-warnings", "--experimental-strip-types", "--input-type=module", "-e", script(suite)],
      { env: { ...process.env, BANC_CATALOGUE: `${RACINE}sondes/banc/catalogue-apres.json`, BANC_SORTIE: join(d, "m.json") } });
    const r = node(`h.before_provider_request({}); h.message_end({ message: { role: "user" } }); h.message_end({ message: { role: "assistant", content: [] } }); console.log("encore");`);
    expect(r.exitCode).toBe(0);
    const sortie = r.stdout.toString();
    expect(JSON.parse(sortie.split("\n")[0]!)).toEqual({ n: 30, param: "object", bloque: { block: true, reason: "banc" } });
    expect(sortie).not.toContain("encore");
    expect(JSON.parse(readFileSync(join(d, "m.json"), "utf8"))).toEqual({ role: "assistant", content: [] });
    expect(node(`h.before_provider_request({}); h.before_provider_request({}); console.log("encore");`).exitCode).toBe(3);
    rmSync(d, { recursive: true, force: true });
  });

  test("la nouvelle liste fait moins bien : le rapport conclut au repli ; une panne est comptée à part", async () => {
    const { r } = await lancerFaux({ ...premier, relire: { avant: [{ name: "boite", arguments: { complet: true } }], apres: { panne: true } }, budget: { avant: premier.budget.avant, apres: { erreur: "Provider timed out" } } });
    expect(r.json.avant.bon).toBe(2);
    expect(r.json.apres).toMatchObject({ bon: 0, pannes: 2, sansAppel: 0 });
    expect(r.json.conclusion.repli).toBe(true);
    expect(r.texte).toContain("repli O4 (anciens noms, autres leviers seuls) à trancher avec l'utilisateur");
    expect(r.texte).toContain("2 appel(s) en panne");
  });

  test("une sortie relative est ramenée au dossier courant, pas au bureau de pi (27/09)", async () => {
    const ici = process.cwd();
    const d = mkdtempSync(join(tmpdir(), "banc-relatif-"));
    process.chdir(d);
    try {
      const { r } = await lancerFaux(premier, "sortie-relative");
      expect(r.json.avant.pannes + r.json.apres.pannes).toBe(0);
    } finally { process.chdir(ici); rmSync(d, { recursive: true, force: true }); }
  });

  test("tous les appels en panne : aucune conclusion", async () => {
    const tout = Object.fromEntries(Object.keys(premier).map((k) => [k, { avant: { panne: true }, apres: { panne: true } }]));
    const { r } = await lancerFaux(tout);
    expect(r.json.conclusion.phrase).toContain("aucune conclusion");
  });
});
