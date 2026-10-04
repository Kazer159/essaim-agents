// Rôles des agents : le premier acte d'une preuve, le reçu du lanceur. Le lanceur prend les
// demandes de rejeu dans sa file, relit les octets du banc, du monde et du produit, rejoue la commande dans partage/
// sous le bac à sable de contrôle (partage/ en lecture seule), écrit un reçu dans preuves/ et ferme l'alerte : corrige
// si le rejeu passe et que le produit a changé, invalide si la contre-preuve passe aux mêmes conditions. Un reçu dont
// une empreinte a changé est périmé.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as D from "../src/depot.ts";
import { etatDuRun, formaterBilan, lancer } from "../src/lancer.ts";
import * as M from "../src/memoire.ts";
import * as P from "../src/preuves.ts";
import { ouvrirBun } from "../src/tableau-bun.ts";
import * as T from "../src/tableau.ts";

const racine = resolve(import.meta.dir, "..");
let run: string, partage: string, banc: string, t: T.Tableau;
// Les exigences d'un siège ni attestées ni déclarées non vérifiées (ex-P.exigencesEnAttente).
const enAttente = (role: string) => P.etatDesExigences(t, run).filter((e) => e.responsable === role && e.etat !== "attestee" && e.etat !== "non_verifiee").map((e) => e.libelle);
const blob = (f: string) => M.blobGit(readFileSync(f));
const main = async () => ((await D.contenuDans(partage, D.BRANCHE)) as { hash: string }).hash;
const commiter = (message: string) => D.commiter(partage, "Claude", message, { seulEcrivain: true });

beforeEach(async () => {
  run = mkdtempSync(join(racine, "runs", ".test-preuves-")); // sous runs/ comme un vrai run, pour le vrai bac à sable
  partage = join(run, "partage");
  await D.ouvrirDepot(partage);
  for (const d of ["preuves", "agents/Fabien", "entrees"]) mkdirSync(join(run, d), { recursive: true });
  writeFileSync(join(partage, "prix.js"), "export const prix = () => 3;\n");
  await commiter("le prix");
  // Le banc de la recette, dans son bureau : il attend 4, le produit rend 3.
  banc = join(run, "agents", "Fabien", "prix.test.ts");
  writeFileSync(banc, `import { expect, test } from "bun:test";\nimport { prix } from "${partage}/prix.js";\ntest("prix", () => expect(prix()).toBe(4));\n`);
  writeFileSync(join(run, "entrees", "carte.csv"), "plat;prix\n");
  t = ouvrirBun(join(run, "tableau.sqlite"));
  T.initialiser(t);
});
afterEach(() => {
  t.fermer();
  rmSync(run, { recursive: true, force: true });
});

// Une alerte de Fabien (recette) confiée à Claude, avec sa reproduction figée au commit de main.
const alerte = async (commande = `bun test ${banc}`, graine: string | null = "42") => {
  const reproduction: T.Reproduction = { commande, graine, commit: await main(), banc: { [banc]: blob(banc) }, monde: { "carte.csv": blob(join(run, "entrees", "carte.csv")) } };
  return T.ouvrirTicket(t, { type: "bug", titre: "le prix", description: "d", auteur: "Fabien", charge: "Claude", sorte: "alerte", reproduction });
};
const corriger = async () => {
  writeFileSync(join(partage, "prix.js"), "export const prix = () => 4;\n");
  await commiter("prix corrigé");
};
const prendre = () => { const l = T.prendreRejeux(t); expect(l).toHaveLength(1); return l[0]!; };
const lireRecu = (n: number) => JSON.parse(readFileSync(join(run, "preuves", `${n}.json`), "utf8")) as P.Recu;

describe("la file des rejeux (tâche 1)", () => {
  test("prendreRejeux : les demandes en attente, marquées prises, avec la reproduction de leur alerte", async () => {
    const id = await alerte();
    await corriger();
    T.demanderRejeu(t, { ticket: id, demandeur: "Claude", motif: "corrige", commit: await main() });
    const d = prendre();
    expect(d).toMatchObject({ id: 1, ticket: id, exigence: null, motif: "corrige", commande: `bun test ${banc}`, graine: "42", demandeur: "Claude" });
    expect(d.reproduction.banc).toEqual({ [banc]: blob(banc) });
    expect(T.prendreRejeux(t)).toEqual([]); // jamais servie deux fois
    expect(t.get<{ etat: string }>("SELECT etat FROM demandes_rejeu WHERE id = 1")!.etat).toBe("prise");
  });
});

describe("le rejeu et le reçu, sous le vrai bac à sable de contrôle (tâche 1)", () => {
  test("un bun test rejoué avant et après la correction : reçu écrit dans preuves/, ne passe pas puis passe", async () => {
    const id = await alerte();
    T.demanderRejeu(t, { ticket: id, demandeur: "Fabien", motif: "invalide", commit: await main(), contrePreuve: `bun test ${banc}` });
    const avant = await P.rejouer(prendre(), run);
    expect(avant).toMatchObject({ n: 1, demande: 1, sorte: "alerte", ticket: id, motif: "invalide", graine: "42", passe: false, code: 1 });
    expect(avant.sortie).toContain("1 fail");
    expect(lireRecu(1)).toEqual(avant);
    T.finirRejeu(t, 1, "preuves/1.json", {});
    await corriger();
    T.demanderRejeu(t, { ticket: id, demandeur: "Claude", motif: "corrige", commit: await main() });
    const apres = await P.rejouer(prendre(), run);
    expect(apres).toMatchObject({ n: 2, passe: true, code: 0, commit: await main(), conditions: { banc: [], monde: [] } });
    expect(apres.empreintes).toEqual({ banc: { [banc]: blob(banc) }, monde: { "carte.csv": blob(join(run, "entrees", "carte.csv")) }, produit: { "prix.js": blob(join(partage, "prix.js")) } });
    expect(apres.texte).toBe(`preuves/2.json · passe (code 0) · produit au commit ${(await main()).slice(0, 7)} · graine 42`);
  }, 30_000);

  test("partage/ est en lecture seule pendant le rejeu ; la graine arrive dans GRAINE", async () => {
    const id = await alerte(`test "$GRAINE" = 42 && echo trace > trace.txt`);
    await corriger();
    T.demanderRejeu(t, { ticket: id, demandeur: "Claude", motif: "corrige", commit: await main() });
    const r = await P.rejouer(prendre(), run);
    expect(r.passe).toBe(false);
    expect(r.sortie).toContain("Operation not permitted");
    expect(existsSync(join(partage, "trace.txt"))).toBe(false);
  });

  test("graine absente : le reçu le dit, GRAINE n'est pas posée", async () => {
    const id = await alerte(`test -z "$GRAINE"`, null);
    await corriger();
    T.demanderRejeu(t, { ticket: id, demandeur: "Claude", motif: "corrige", commit: await main() });
    const r = await P.rejouer(prendre(), run);
    expect(r).toMatchObject({ graine: null, passe: true });
    expect(r.texte).toEndWith("· sans graine");
  });

  test("banc modifié entre l'alerte et le rejeu : le reçu dit les conditions changées", async () => {
    const id = await alerte();
    await corriger();
    writeFileSync(banc, readFileSync(banc, "utf8").replace("toBe(4)", "toBeGreaterThan(0)")); // la jauge relâchée
    T.demanderRejeu(t, { ticket: id, demandeur: "Claude", motif: "corrige", commit: await main() });
    const r = await P.rejouer(prendre(), run);
    expect(r.passe).toBe(true);
    expect(r.conditions).toEqual({ banc: [banc], monde: [] });
    expect(r.texte).toContain(`· conditions changées depuis l'alerte : banc ${banc}`);
  }, 30_000);

  test("une commande trop longue est coupée ; un reçu n'est jamais réécrit", async () => {
    const id = await alerte("sleep 5");
    await corriger();
    T.demanderRejeu(t, { ticket: id, demandeur: "Claude", motif: "corrige", commit: await main() });
    const d = prendre();
    const r = await P.rejouer(d, run, { delaiMs: 300 });
    expect(r).toMatchObject({ passe: false, code: null, coupe: "coupé : délai dépassé" });
    await expect(P.rejouer(d, run)).rejects.toThrow();
  });
});

describe("les fuites du rejeu (revue 29/09)", () => {
  test("une commande qui laisse un processus en fond ne bloque pas le rejeu (P2)", async () => {
    const id = await alerte("sleep 30 & echo lancé");
    await corriger();
    T.demanderRejeu(t, { ticket: id, demandeur: "Claude", motif: "corrige", commit: await main() });
    const debut = Date.now();
    const r = await P.rejouer(prendre(), run, { delaiMs: 500 });
    expect(Date.now() - debut).toBeLessThan(5000);
    expect(r.sortie).toContain("lancé");
  }, 20_000);
  test("le rejeu d'un autre que le gardien ne lit ni n'écrit son bureau privé (P3)", async () => {
    mkdirSync(join(run, "agents", "Gaston", "prive"), { recursive: true });
    writeFileSync(join(run, "agents", "Gaston", "prive", "cas.txt"), "CAS-SECRET\n");
    T.ajouterAgent(t, "Gaston", join(run, "agents", "Gaston"), undefined, undefined, { role: "gardien" });
    T.ajouterAgent(t, "Fabien", join(run, "agents", "Fabien"), undefined, undefined, { role: "recette" });
    const id = await alerte("cat ../agents/Gaston/prive/cas.txt; echo triche > ../agents/Gaston/prive/cas.txt");
    await corriger();
    T.demanderRejeu(t, { ticket: id, demandeur: "Claude", motif: "corrige", commit: await main() });
    const file = P.servirRejeux(t, run, { ms: 20 });
    for (let i = 0; i < 200 && !existsSync(join(run, "preuves", "1.json")); i++) await Bun.sleep(25);
    await file.arreter();
    expect(lireRecu(1).sortie).not.toContain("CAS-SECRET");
    expect(readFileSync(join(run, "agents", "Gaston", "prive", "cas.txt"), "utf8")).toBe("CAS-SECRET\n");
  }, 30_000);
});

describe("l'empreinte du produit voit à travers un lien (29/09, revue P4)", () => {
  test("un lien de partage/ vers un fichier du bureau : changer la cible change l'empreinte du produit", () => {
    const cible = join(run, "agents", "Fabien", "cible.js");
    writeFileSync(cible, "export const x = 1;\n");
    symlinkSync(cible, join(partage, "lien.js"));
    const avant = P.releverActuel(run).produit["lien.js"];
    expect(avant).toBeDefined();
    writeFileSync(cible, "export const x = 2;\n");
    expect(P.releverActuel(run).produit["lien.js"]).not.toBe(avant);
  });
});

describe("la péremption d'un reçu (tâche 1)", () => {
  test("périmé dès qu'une empreinte change : produit, banc ou monde ; les octets sont relus, pas la date", async () => {
    const id = await alerte();
    await corriger();
    T.demanderRejeu(t, { ticket: id, demandeur: "Claude", motif: "corrige", commit: await main() });
    const r = await P.rejouer(prendre(), run);
    expect(P.perime(r, run)).toEqual({ perime: false, changes: [] });
    // Même contenu réécrit (la date change) : pas périmé.
    writeFileSync(join(partage, "prix.js"), readFileSync(join(partage, "prix.js")));
    expect(P.perime(r, run).perime).toBe(false);
    writeFileSync(join(partage, "prix.js"), "export const prix = () => 5;\n");
    writeFileSync(join(partage, "neuf.js"), "1\n");
    expect(P.perime(r, run)).toEqual({ perime: true, changes: ["produit neuf.js", "produit prix.js"] });
    writeFileSync(banc, "// vide\n");
    rmSync(join(run, "entrees", "carte.csv"));
    expect(P.perime(r, run).changes).toEqual([`banc ${banc}`, "monde carte.csv", "produit neuf.js", "produit prix.js"]);
  }, 30_000);

  test("lireRecu : par numéro, par chemin relatif ou absolu ; rien hors du registre", async () => {
    const id = await alerte("true");
    await corriger();
    T.demanderRejeu(t, { ticket: id, demandeur: "Claude", motif: "corrige", commit: await main() });
    const r = await P.rejouer(prendre(), run);
    for (const c of ["1", "1.json", "preuves/1.json", join(run, "preuves", "1.json")]) expect(P.lireRecu(run, c), c).toEqual(r);
    expect(P.lireRecu(run, "2")).toBeUndefined();
    expect(P.lireRecu(run, "../tableau.sqlite")).toBeUndefined();
  });
});

describe("la conclusion du lanceur (tâche 1)", () => {
  const servir = async () => { const d = prendre(); const r = await P.rejouer(d, run); P.conclure(t, d, r); return r; };

  test("corrige : le rejeu passe et le produit a changé → l'alerte se ferme sur le reçu ; la demande est faite", async () => {
    const id = await alerte();
    await corriger();
    T.demanderRejeu(t, { ticket: id, demandeur: "Claude", motif: "corrige", commit: await main() });
    await servir();
    const k = T.lireTicket(t, id)!;
    expect(k).toMatchObject({ etat: "ferme", motif: "corrige" });
    expect(k.notes.at(-1)).toMatchObject({ auteur: "essaim", texte: "fermé (corrigé) sur le reçu preuves/1.json" });
    expect(t.get("SELECT etat, recu FROM demandes_rejeu WHERE id = 1")).toEqual({ etat: "faite", recu: "preuves/1.json" });
    expect(t.get<{ texte: string }>("SELECT texte FROM messages ORDER BY id DESC")!.texte).toBe("[ticket #1] le prix : fermé (corrigé) sur le reçu preuves/1.json (rejeu demandé par Claude)");
  }, 30_000);

  test("le rejeu ne passe pas : l'alerte reste ouverte, le reçu cité ; une nouvelle demande est possible", async () => {
    const id = await alerte();
    writeFileSync(join(partage, "prix.js"), "export const prix = () => 5;\n");
    await commiter("autre prix");
    T.demanderRejeu(t, { ticket: id, demandeur: "Claude", motif: "corrige", commit: await main() });
    await servir();
    const k = T.lireTicket(t, id)!;
    expect(k.etat).toBe("ouvert");
    expect(k.notes.at(-1)!.texte).toBe(`rejeu #1 (corrige) : preuves/1.json · ne passe pas (code 1) · produit au commit ${(await main()).slice(0, 7)} · graine 42 ; l'alerte reste ouverte`);
    await corriger();
    expect(T.demanderRejeu(t, { ticket: id, demandeur: "Claude", motif: "corrige", commit: await main() }).ok).toBe(true);
  }, 30_000);

  test("corrige qui passe sur un banc changé : pas les mêmes conditions, l'alerte reste ouverte", async () => {
    const id = await alerte();
    await corriger();
    writeFileSync(banc, "// plus rien\n");
    T.demanderRejeu(t, { ticket: id, demandeur: "Claude", motif: "corrige", commit: await main() });
    await servir();
    expect(T.lireTicket(t, id)!.etat).toBe("ouvert");
    expect(T.lireTicket(t, id)!.notes.at(-1)!.texte).toEndWith("; l'alerte reste ouverte");
  }, 30_000);

  test("invalide : la contre-preuve passe aux mêmes conditions → invalidée, les deux conclusions gardées", async () => {
    const id = await alerte();
    T.demanderRejeu(t, { ticket: id, demandeur: "Claude", motif: "invalide", commit: await main(), contrePreuve: `test "$GRAINE" = 42` });
    await servir();
    const k = T.lireTicket(t, id)!;
    expect(k).toMatchObject({ etat: "ferme", motif: "invalide" });
    expect(k.notes.at(-1)!.texte).toBe(`fermé (invalidé) sur le reçu preuves/1.json ; deux conclusions gardées : l'alerte de Fabien (bun test ${banc}, graine 42) ne passait pas, la contre-preuve de Claude (test "$GRAINE" = 42) passe`);
    expect(T.invalidations(t)).toEqual([{ ticket: id, titre: "le prix", auteur: "Fabien", alerte: `bun test ${banc}`, demandeur: "Claude", contrePreuve: `test "$GRAINE" = 42`, recu: "preuves/1.json" }]);
    const bilan = formaterBilan({ finis: 0, vires: 0, perdus: 0, depense: 0, plafond: 1, depassement: 0, run, invalidees: T.invalidations(t) });
    expect(bilan.split("\n").at(-1)).toBe(`alerte #${id} invalidée : l'alerte de Fabien (bun test ${banc}) ne passait pas, la contre-preuve de Claude (test "$GRAINE" = 42) passe, reçu preuves/1.json`);
  });

  test("servirRejeux : la minuterie du lanceur sert la file, un rejeu à la fois, et s'arrête en attendant celui en cours", async () => {
    const id = await alerte();
    await corriger();
    const f = P.servirRejeux(t, run, { ms: 20 });
    T.demanderRejeu(t, { ticket: id, demandeur: "Claude", motif: "corrige", commit: await main() });
    for (let i = 0; i < 300 && T.lireTicket(t, id)!.etat !== "ferme"; i++) await Bun.sleep(20);
    await f.arreter();
    expect(T.lireTicket(t, id)!.motif).toBe("corrige");
  }, 30_000);
});

// Le lanceur au faux pi (jeu : Antoine intégrateur, Bernard, Claude et Denis constructeurs, Edmond recette) : Edmond ouvre
// une alerte, Claude écrit la correction puis demande le rejeu ; la file du lanceur rejoue et ferme l'alerte.
describe("le lanceur sert la file (tâche 1)", () => {
  let racineRun: string;
  const fixture = (nom: string, lignes: object[]) => { const f = join(racineRun, `${nom}.jsonl`); writeFileSync(f, lignes.map((l) => JSON.stringify(l)).join("\n") + "\n"); return f; };
  const fin = [{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }], api: "openai-completions", provider: "openrouter", model: "faux", usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 1 } }, { type: "agent_end" }];
  const variables = ["ESSAIM_PI", "ESSAIM_FIXTURE", "ESSAIM_FIXTURE_ANTOINE", "ESSAIM_FIXTURE_EDMOND", "ESSAIM_FIXTURE_CLAUDE", "ESSAIM_FIXTURE_PASSE_2", "ESSAIM_FIXTURE_PASSE_3", "ESSAIM_TOUR_MS"];
  beforeEach(() => { racineRun = mkdtempSync(join(tmpdir(), "essaim-preuves-lancer-")); });
  afterEach(() => { rmSync(racineRun, { recursive: true, force: true }); for (const v of variables) delete process.env[v]; });

  test("alerte, correction, demande de rejeu : l'alerte se ferme sur le reçu du lanceur", async () => {
    const mission = join(racineRun, "mission.md");
    writeFileSync(mission, readFileSync(join(racine, "tests", "fixtures", "hello-world.md"), "utf8") + "\n## Type\n\njeu\n");
    const hello = join(racine, "tests", "fixtures", "hello-fini.jsonl");
    process.env.ESSAIM_PI = join(racine, "tests", "faux-pi.ts");
    process.env.ESSAIM_TOUR_MS = "0";
    process.env.ESSAIM_FIXTURE = hello;
    process.env.ESSAIM_FIXTURE_PASSE_2 = hello;
    process.env.ESSAIM_FIXTURE_PASSE_3 = hello;
    // Antoine, qui répartit les parts, confie corrige.txt à Claude : sans cela, le crochet du rôle refuse son write.
    process.env.ESSAIM_FIXTURE_ANTOINE = fixture("antoine", [
      { type: "tool_execution_start", toolCallId: "a1", toolName: "ticket_ouvrir", args: { type: "amelioration", titre: "la correction", description: "corrige.txt", charge: "Claude", chemins: ["corrige.txt"] } },
      { type: "faux:toucher", chemin: "{RUN}/part" }, ...readFileSync(hello, "utf8").trim().split("\n").map((l) => JSON.parse(l))]);
    process.env.ESSAIM_FIXTURE_EDMOND = fixture("edmond", [{ type: "faux:attendre", chemin: "{RUN}/part" },
      { type: "tool_execution_start", toolCallId: "e1", toolName: "ticket_ouvrir", args: { type: "bug", titre: "rien de corrigé", description: "corrige.txt manque", charge: "Claude", sorte: "alerte", reproduction: { commande: "test -f corrige.txt", graine: "7" } } },
      { type: "faux:toucher", chemin: "{RUN}/alerte" }, { type: "faux:dormir", ms: 5000 }, ...fin]);
    process.env.ESSAIM_FIXTURE_CLAUDE = fixture("claude", [
      { type: "faux:attendre", chemin: "{RUN}/alerte" },
      { type: "tool_execution_start", toolCallId: "c1", toolName: "write", args: { path: "{PARTAGE}/corrige.txt", content: "ok\n" } },
      { type: "tool_execution_end", toolCallId: "c1", toolName: "write", result: { content: [{ type: "text", text: "écrit" }] }, isError: false },
      { type: "faux:dormir", ms: 1500 },
      { type: "tool_execution_start", toolCallId: "c2", toolName: "ticket_modifier", args: { id: 2, motif: "corrige" } },
      { type: "faux:dormir", ms: 2000 }, ...fin]);
    const b = await lancer({ agents: 5, modele: "faux", plafond: 0.1, mission, racine: racineRun, sansBacASable: true });
    const tb = ouvrirBun(join(b.run, "tableau.sqlite"));
    const k = T.lireTicket(tb, 2)!;
    tb.fermer();
    expect(k).toMatchObject({ sorte: "alerte", etat: "ferme", motif: "corrige" });
    expect(JSON.parse(readFileSync(join(b.run, "preuves", "1.json"), "utf8"))).toMatchObject({ sorte: "alerte", ticket: 2, motif: "corrige", passe: true, graine: "7" });
  }, 60_000);
});

// ---- Les attestations : l'extension chargée avec un rôle, sur ce même run ; la file du lanceur tourne à côté.
import { fauxPi } from "./aide/faux-extension-api.ts";
import extension from "../src/outils-essaim.ts";

const EQUIPE: Array<[string, string]> = [["Antoine", "chef"], ["Claude", "constructeur"], ["Fabien", "recette"], ["Gilles", "gardien"]];
const ENV_OUTILS = ["ESSAIM_AGENT", "ESSAIM_TABLEAU", "ESSAIM_PARTAGE", "ESSAIM_BUREAU", "ESSAIM_ROLE", "ESSAIM_TOUR_MS", "ESSAIM_DEMANDE_MS"];

describe("les preuves dans les outils (tâche 2)", () => {
  let envAvant: Record<string, string | undefined> = {}, file: { arreter: () => Promise<void> };
  const instance = (agent: string, role: string) => {
    Object.assign(process.env, { ESSAIM_AGENT: agent, ESSAIM_TABLEAU: join(run, "tableau.sqlite"), ESSAIM_PARTAGE: partage, ESSAIM_BUREAU: join(run, "agents", agent), ESSAIM_ROLE: role });
    const faux = fauxPi();
    extension(faux.api, ouvrirBun);
    return faux;
  };
  const par = (nom: string) => instance(nom, EQUIPE.find(([n]) => n === nom)?.[1] ?? "recette");
  const bancRel = "prix.test.ts"; // relatif au bureau de Fabien, comme pi
  beforeEach(() => {
    envAvant = Object.fromEntries(ENV_OUTILS.map((k) => [k, process.env[k]]));
    process.env.ESSAIM_TOUR_MS = "0";
    process.env.ESSAIM_DEMANDE_MS = "20000";
    T.ouvrirRun(t, { id: "run-test", missionChemin: "m.md", missionTexte: "m", modele: "faux/faux", plafondUsd: 0.5, silenceMin: 15 });
    for (const [nom, r] of EQUIPE) { mkdirSync(join(run, "agents", nom), { recursive: true }); T.ajouterAgent(t, nom, join(run, "agents", nom), undefined, undefined, { role: r }); }
    T.noterPhrases(t, [{ n: 1, section: "M", texte: "Le prix est de 4." }, { n: 2, section: "M", texte: "La carte se charge vite." }, { n: 3, section: "M", texte: "Le ton est chaleureux." }]);
    T.rangerExigence(t, { phrases: [1], classement: "exigence", responsable: "recette", par: "Antoine" });
    T.rangerExigence(t, { phrases: [2], classement: "exigence", responsable: "gardien", par: "Antoine" });
    T.rangerExigence(t, { phrases: [3], classement: "transversale", responsable: "recette", par: "Antoine" });
    file = P.servirRejeux(t, run, { ms: 20 });
  });
  afterEach(async () => {
    await file.arreter();
    for (const [k, v] of Object.entries(envAvant)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  });

  test("preuve_demander : la recette dépose, le lanceur rejoue ; l'outil rend le reçu ; refus hors des contrôleurs, exigence inconnue", async () => {
    const fabien = par("Fabien");
    expect(await fabien.texte("preuve_demander", { exigence: "E1", commande: `bun test ${banc}`, banc: [bancRel] })).toBe(`reçu preuves/1.json · ne passe pas (code 1) · produit au commit ${(await main()).slice(0, 7)} · sans graine`);
    await corriger();
    expect(await fabien.texte("preuve_demander", { exigence: "E1", commande: `bun test ${banc}`, banc: [bancRel], graine: "3" })).toBe(`reçu preuves/2.json · passe (code 0) · produit au commit ${(await main()).slice(0, 7)} · graine 3`);
    expect(lireRecu(2)).toMatchObject({ sorte: "exigence", exigence: "E1", demandeur: "Fabien", empreintes: { banc: { [banc]: blob(banc) } } });
    await expect(par("Claude").texte("preuve_demander", { exigence: "E1", commande: "true" })).rejects.toThrow("outil inconnu"); // outil retiré à ce rôle
    expect(await fabien.texte("preuve_demander", { exigence: "E7", commande: "true" })).toBe("refusé : aucune exigence E7. Se lève avec un libellé que exigence_lister donne.");
    expect(await fabien.texte("preuve_demander", { exigence: "E1", commande: " " })).toBe("refusé : une preuve sans commande. Se lève avec une commande non vide.");
    expect(await fabien.texte("preuve_demander", { exigence: "E1", commande: "true", banc: ["absent.ts"] })).toBe("refusé : absent.ts est introuvable. Se lève avec un fichier ou un dossier qui existe.");
    await file.arreter(); // plus de lanceur : la demande reste en file
    process.env.ESSAIM_DEMANDE_MS = "100"; // lu au chargement de l'extension
    const presse = par("Fabien");
    expect(await presse.texte("preuve_demander", { exigence: "E3", commande: "true" })).toBe("le lanceur n'a pas rendu le reçu en 0 s ; la demande #3 reste en file, `preuve_lister` montrera son reçu");
    expect(await presse.texte("preuve_demander", { exigence: "E3", commande: "true" })).toBe("refusé : une demande de preuve de E3 attend le lanceur. Se lève quand le lanceur a rendu son reçu.");
    expect((await presse.texte("preuve_lister", {})).split("\n").at(-1)).toBe("en attente du lanceur : demande #3 (E3)");
  }, 60_000);

  test("preuve_attester : le siège responsable seul, un seul signataire, un reçu de l'exigence qui passe et n'est pas périmé", async () => {
    const fabien = par("Fabien");
    await fabien.texte("preuve_demander", { exigence: "E1", commande: `bun test ${banc}`, banc: [bancRel] }); // 1 : ne passe pas
    await corriger();
    await fabien.texte("preuve_demander", { exigence: "E1", commande: `bun test ${banc}`, banc: [bancRel] }); // 2 : passe
    await fabien.texte("preuve_demander", { exigence: "E3", commande: "true" }); // 3 : passe, pour E3
    await expect(par("Claude").texte("preuve_attester", { exigence: "E1", recu: "preuves/2.json", portee: "x" })).rejects.toThrow("outil inconnu"); // outil retiré à ce rôle
    expect(await par("Gilles").texte("preuve_attester", { exigence: "E1", recu: "preuves/2.json", portee: "x" })).toBe("refusé : E1 se signe par la recette (Fabien). Définitif pour ce rôle.");
    expect(await fabien.texte("preuve_attester", { exigence: "E9", recu: "2", portee: "x" })).toBe("refusé : aucune exigence E9. Se lève avec un libellé que exigence_lister donne.");
    expect(await fabien.texte("preuve_attester", { exigence: "E1", portee: "x" })).toBe("refusé : ni reçu ni non_verifiee. Se lève avec un reçu de preuve_demander, ou non_verifiee.");
    expect(await fabien.texte("preuve_attester", { exigence: "E1", recu: "9", portee: "x" })).toBe("refusé : aucun reçu 9 dans le registre des preuves. Se lève avec un reçu que preuve_demander a rendu.");
    expect(await fabien.texte("preuve_attester", { exigence: "E1", recu: "3", portee: "x" })).toBe("refusé : le reçu preuves/3.json porte sur E3. Se lève avec un reçu de E1.");
    expect(await fabien.texte("preuve_attester", { exigence: "E1", recu: "1", portee: "x" })).toBe("refusé : le reçu preuves/1.json ne passe pas (code 1). Se lève avec un reçu qui passe.");
    expect(await fabien.texte("preuve_attester", { exigence: "E1", recu: "2", portee: " " })).toBe("refusé : une attestation sans portée. Se lève avec une portée non vide.");
    expect(await fabien.texte("preuve_attester", { exigence: "E1", recu: "preuves/2.json", portee: "le prix de la soupe seulement" }))
      .toBe("E1 attestée par Fabien (parcours) sur le reçu preuves/2.json ; portée : le prix de la soupe seulement");
    // Un second occupant du siège de recette ne cosigne pas ; le droit tombe quand le siège change d'occupant.
    T.ajouterAgent(t, "Rose", join(run, "agents", "Rose"), undefined, undefined, { role: "recette" });
    const rose = instance("Rose", "recette");
    expect(await rose.texte("preuve_attester", { exigence: "E1", recu: "2", portee: "x" })).toBe("refusé : E1 est signée par Fabien, un seul signataire par exigence. Définitif pour cette exigence.");
    expect(T.revoquerSignatures(t, "Fabien")).toBe(1);
    expect(await rose.texte("preuve_attester", { exigence: "E1", recu: "2", portee: "reprise du siège" })).toBe("E1 attestée par Rose (parcours) sur le reçu preuves/2.json ; portée : reprise du siège");
    // Périmé : le produit a changé depuis le reçu.
    writeFileSync(join(partage, "prix.js"), "export const prix = () => 4; // commentaire\n");
    expect(await rose.texte("preuve_attester", { exigence: "E1", recu: "2", portee: "x" })).toBe("refusé : le reçu preuves/2.json est périmé : produit prix.js. Se lève avec un reçu rejoué depuis (preuve_demander).");
  }, 60_000);

  // Le gardien n'atteste pas sur un test écrit par un constructeur dans le dossier partagé. Son attestation doit s'appuyer sur un fichier
  // de son bureau privé, nommé par la commande du reçu ou compté dans son banc ; la recette n'est pas concernée.
  test("preuve_attester du gardien : refusée sur un reçu qui n'utilise aucun fichier de son bureau privé ; la recette n'est pas concernée", async () => {
    mkdirSync(join(partage, "test"), { recursive: true });
    const testDeLEquipe = `import { expect, test } from "bun:test";\nimport { prix } from "${partage}/prix.js";\ntest("prix", () => expect(prix()).toBe(3));\n`;
    writeFileSync(join(partage, "test", "audit.test.ts"), testDeLEquipe);
    await commiter("le test de l'équipe");
    const prive = join(run, "agents", "Gilles", "prive");
    mkdirSync(prive, { recursive: true });
    writeFileSync(join(prive, "mesure.test.ts"), testDeLEquipe);
    symlinkSync(join(partage, "test", "audit.test.ts"), join(prive, "lien.test.ts")); // un lien vers le partage n'est pas un fichier du bureau
    const gilles = par("Gilles");
    const refus = (n: number) => `refusé : le reçu preuves/${n}.json ne repose sur aucun fichier de ton bureau privé (${prive}) : ni sa commande ni son banc n'en utilisent un. Se lève avec un reçu dont la commande ou le banc utilise un fichier de ton bureau privé.`;
    expect(await gilles.texte("preuve_demander", { exigence: "E2", commande: "bun test ./test/audit.test.ts" })).toStartWith("reçu preuves/1.json · passe (code 0)");
    expect(await gilles.texte("preuve_attester", { exigence: "E2", recu: "1", portee: "le prix" })).toBe(refus(1));
    expect(await gilles.texte("preuve_demander", { exigence: "E2", commande: "test -f ../agents/Gilles/prive/lien.test.ts" })).toStartWith("reçu preuves/2.json · passe (code 0)");
    expect(await gilles.texte("preuve_attester", { exigence: "E2", recu: "2", portee: "le prix" })).toBe(refus(2));
    expect(T.attestationDe(t, "E2")).toBeUndefined();
    // La commande nomme un fichier du bureau privé, relatif au dossier partagé où le lanceur la rejoue.
    expect(await gilles.texte("preuve_demander", { exigence: "E2", commande: "bun test ../agents/Gilles/prive/mesure.test.ts" })).toStartWith("reçu preuves/3.json · passe (code 0)");
    expect(await gilles.texte("preuve_attester", { exigence: "E2", recu: "3", portee: "le prix" })).toBe("E2 attestée par Gilles (mesure) sur le reçu preuves/3.json ; portée : le prix");
    // Ou le banc en compte un (relatif à son bureau, comme pi), même si la commande n'en nomme aucun.
    expect(await gilles.texte("preuve_demander", { exigence: "E2", commande: "bun test ./test/audit.test.ts", banc: ["prive/mesure.test.ts"] })).toStartWith("reçu preuves/4.json · passe (code 0)");
    expect(await gilles.texte("preuve_attester", { exigence: "E2", recu: "4", portee: "le prix" })).toBe("E2 attestée par Gilles (mesure) sur le reçu preuves/4.json ; portée : le prix");
    // La recette signe sur un test du dossier partagé : rien ne change pour elle.
    const fabien = par("Fabien");
    expect(await fabien.texte("preuve_demander", { exigence: "E1", commande: "bun test ./test/audit.test.ts" })).toStartWith("reçu preuves/5.json · passe (code 0)");
    expect(await fabien.texte("preuve_attester", { exigence: "E1", recu: "5", portee: "le prix" })).toBe("E1 attestée par Fabien (parcours) sur le reçu preuves/5.json ; portée : le prix");
  }, 60_000);

  test("non vérifiée, appréciation, exigences en attente et moi_finir de la recette ; preuve_lister", async () => {
    const fabien = par("Fabien"), gilles = par("Gilles");
    expect(enAttente("recette")).toEqual(["E1", "E3"]);
    expect(await fabien.texte("moi_finir", { raison: "fait" })).toBe("refusé : la recette reste jusqu'à la fin du run. Se lève quand le lanceur constate le run accepté ou incomplet.");
    expect(await gilles.texte("preuve_attester", { exigence: "E2", non_verifiee: true, portee: "aucune horloge fiable dans ce bac à sable" })).toBe("E2 déclarée non vérifiée par Gilles ; raison : aucune horloge fiable dans ce bac à sable");
    expect(await fabien.texte("preuve_attester", { exigence: "E3", recu: "1", non_verifiee: true, portee: "x" })).toBe("refusé : un reçu et non_verifiee ensemble. Se lève avec l'un des deux.");
    expect(await fabien.texte("preuve_apprecier", { exigence: "E3", texte: "le ton est chaleureux sur les huit pages", portee: "lecture des textes affichés" }))
      .toBe("appréciation #1 sur E3, signée Fabien ; comptée à part, jamais comme une preuve");
    await expect(par("Claude").texte("preuve_apprecier", { exigence: "E3", texte: "x", portee: "y" })).rejects.toThrow("outil inconnu"); // outil retiré à ce rôle
    expect(await fabien.texte("preuve_apprecier", { exigence: "E8", texte: "x", portee: "y" })).toBe("refusé : aucune exigence E8. Se lève avec un libellé que exigence_lister donne.");
    expect(await fabien.texte("preuve_apprecier", { exigence: "E3", texte: " ", portee: "y" })).toBe("refusé : une appréciation sans texte ou sans portée. Se lève avec les deux non vides.");
    expect(enAttente("recette")).toEqual(["E1", "E3"]); // une appréciation ne compte jamais comme une réussite
    expect(enAttente("gardien")).toEqual([]);
    await corriger();
    const f2 = par("Fabien"); // le bureau se lit dans l'environnement du processus, un seul agent par pi
    await f2.texte("preuve_demander", { exigence: "E1", commande: `bun test ${banc}`, banc: [bancRel] });
    await f2.texte("preuve_attester", { exigence: "E1", recu: "1", portee: "le prix" });
    await f2.texte("preuve_attester", { exigence: "E3", non_verifiee: true, portee: "aucune commande ne mesure le ton" });
    expect(enAttente("recette")).toEqual([]);
    const liste = await par("Claude").texte("preuve_lister", {});
    expect(liste).toBe([
      "E1 · contrôle : recette (Fabien) · attestée par Fabien (parcours) sur preuves/1.json · portée : le prix",
      "E2 · contrôle : gardien-mesureur (Gilles) · non vérifiée, déclaré par Gilles : aucune horloge fiable dans ce bac à sable",
      "E3 · contrôle : recette (Fabien) · non vérifiée, déclaré par Fabien : aucune commande ne mesure le ton",
      "  appréciation de Fabien : le ton est chaleureux sur les huit pages (portée : lecture des textes affichés)",
      "reçus :",
      `  preuves/1.json · E1 · passe (code 0) · produit au commit ${(await main()).slice(0, 7)} · sans graine`,
    ].join("\n"));
    // Le produit change, pas le banc : l'attestation de E1 est à rejouer ; preuve_lister la confie au lanceur
    // sans l'attendre (le rejeu lui-même : describe ci-dessous). La recette reste jusqu'au constat.
    writeFileSync(join(partage, "prix.js"), "export const prix = () => 4; // v2\n");
    expect(enAttente("recette")).toEqual(["E1"]);
    expect((await par("Claude").texte("preuve_lister", {})).split("\n")[0]).toBe("E1 · contrôle : recette (Fabien) · à rejouer par le lanceur (produit prix.js) : attestée par Fabien (parcours) sur preuves/1.json · portée : le prix");
    expect(await par("Fabien").texte("moi_finir", { raison: "fait" })).toBe("refusé : la recette reste jusqu'à la fin du run. Se lève quand le lanceur constate le run accepté ou incomplet.");
    expect(t.all("SELECT id FROM demandes_rejeu WHERE rejoue IS NOT NULL")).toHaveLength(1);
  }, 60_000);
});

// ---- Le lanceur rejoue lui-même un reçu attesté dont seul le produit ou le monde a changé : une note écrite après
// le gel n'oblige plus à refaire les attestations d'un programme inchangé.
describe("O6 : le lanceur rejoue les reçus attestés", () => {
  const commande = () => `bun test ${banc}`;
  beforeEach(() => {
    T.ouvrirRun(t, { id: "run-test", missionChemin: "m.md", missionTexte: "m", modele: "faux/faux", plafondUsd: 0.5, silenceMin: 15 });
    for (const [nom, r] of [["Antoine", "chef"], ["Fabien", "recette"]] as const) T.ajouterAgent(t, nom, join(run, "agents", nom), undefined, undefined, { role: r });
    T.noterPhrases(t, [{ n: 1, section: "M", texte: "Le prix est de 4." }]);
    T.rangerExigence(t, { phrases: [1], classement: "exigence", responsable: "recette", par: "Antoine" });
  });
  // E1 prouvée par Fabien : sa demande, le rejeu du lanceur, puis sa signature.
  const prouver = async () => {
    await corriger();
    const reproduction: T.Reproduction = { commande: commande(), graine: "5", commit: await main(), banc: { [banc]: blob(banc) }, monde: { "carte.csv": blob(join(run, "entrees", "carte.csv")) } };
    expect(T.demanderPreuve(t, { exigence: "E1", demandeur: "Fabien", commande: commande(), graine: "5", reproduction }).ok).toBe(true);
    const d = prendre();
    P.conclure(t, d, await P.rejouer(d, run));
    T.attester(t, { exigence: "E1", agent: "Fabien", role: "recette", nature: "parcours", recu: "preuves/1.json", portee: "le prix de la soupe" });
    expect(etatDuRun(t, run, "absente").etat).toBe("accepte");
  };

  test("une note sans rapport change dans le partage : au constat, le lanceur rejoue, l'attestation se reporte, le run est accepté", async () => {
    await prouver();
    mkdirSync(join(partage, "AUDITS"));
    writeFileSync(join(partage, "AUDITS", "page.md"), "la page est lisible\n");
    expect(P.etatDesExigences(t, run)[0]).toMatchObject({ etat: "a_rejouer", changes: ["produit AUDITS/page.md"] });
    expect(etatDuRun(t, run, "absente")).toMatchObject({ etat: "incomplet", raisons: ["exigences non satisfaites : E1 (à rejouer)"] });
    expect(await P.rejouerAttestations(t, run)).toBe(1);
    expect(lireRecu(2)).toMatchObject({ sorte: "exigence", exigence: "E1", demandeur: "lanceur", commande: commande(), graine: "5", passe: true,
      rejoue: "preuves/1.json", depuis: ["produit AUDITS/page.md"], conditions: { banc: [], monde: [] } });
    expect(lireRecu(2).texte).toEndWith("graine 5 · rejeu de preuves/1.json par le lanceur");
    expect(T.attestationDe(t, "E1")).toMatchObject({ agent: "Fabien", role: "recette", nature: "parcours", recu: "preuves/2.json", portee: "le prix de la soupe" });
    expect(t.get<{ resultat_resume: string }>("SELECT resultat_resume FROM evenements WHERE type = 'report'")!.resultat_resume)
      .toBe("E1 : attestation de Fabien reportée de preuves/1.json sur preuves/2.json, rejoué par le lanceur ; changé depuis : produit AUDITS/page.md");
    expect(etatDuRun(t, run, "absente")).toEqual({ etat: "accepte", raisons: [], exigences: [], alertes: [] });
    expect(await P.rejouerAttestations(t, run)).toBe(0); // plus rien à rejouer
  }, 30_000);

  test("un changement du produit casse la vérification : le rejeu échoue, l'exigence n'est plus attestée, le signataire le sait, le run est incomplet et dit pourquoi", async () => {
    await prouver();
    writeFileSync(join(partage, "prix.js"), "export const prix = () => 5;\n");
    expect(await P.rejouerAttestations(t, run)).toBe(1);
    expect(lireRecu(2)).toMatchObject({ passe: false, code: 1, rejoue: "preuves/1.json", depuis: ["produit prix.js"] });
    expect(T.attestationDe(t, "E1")!.recu).toBe("preuves/1.json"); // rien de reporté
    const e = P.etatDesExigences(t, run)[0]!;
    expect(e).toMatchObject({ etat: "rejeu_echoue", changes: ["produit prix.js"], rejeu: { demande: 2, recu: "preuves/2.json" } });
    expect(e.rejeu!.texte).toStartWith("preuves/2.json · ne passe pas (code 1)");
    const raison = etatDuRun(t, run, "absente");
    expect(raison.etat).toBe("incomplet");
    expect(raison.raisons[0]).toStartWith("exigences non satisfaites : E1 (rejeu échoué : preuves/2.json · ne passe pas (code 1) · produit au commit ");
    expect(raison.raisons[0]).toEndWith("rejeu de preuves/1.json par le lanceur ; changé depuis preuves/1.json : produit prix.js)");
    const m = t.get<{ auteur: string; texte: string }>("SELECT auteur, texte FROM messages ORDER BY id DESC LIMIT 1")!;
    expect(m.auteur).toBe("essaim");
    expect(m.texte).toStartWith("Fabien : E1 n'est plus attestée. Le lanceur a rejoué preuves/1.json, que tu avais attesté, sur le produit du moment : preuves/2.json · ne passe pas (code 1)");
    expect(T.sAdresseA(m.texte, "Fabien")).toBe(true); // sa ligne « pour toi » le lui dit
    expect(t.get<{ resultat_resume: string }>("SELECT resultat_resume FROM evenements WHERE type = 'rejeu_echoue'")!.resultat_resume).toStartWith("E1 n'est plus attestée : preuves/2.json");
    expect(enAttente("recette")).toEqual(["E1"]);
  }, 30_000);


  // Les jalons : E1 découpée en E1.1 et E1.2, chacun prouvé par son reçu ; E1 est
  // tenue quand les deux le sont, sans preuve d'elle-même ; un jalon dont le rejeu échoue fait retomber E1 ; la
  // vérification de la mission reste exigée.
  test("jalons : E1 attestée par ses deux jalons, 1/2 ne suffit pas, un rejeu échoué de jalon la fait retomber, la vérification reste", async () => {
    T.jalonner(t, { parent: "E1", portees: ["la soupe", "le dessert"], par: "Antoine" });
    await corriger();
    const prouverJalon = async (jalon: string, n: number) => {
      const reproduction: T.Reproduction = { commande: commande(), graine: "5", commit: await main(), banc: { [banc]: blob(banc) }, monde: { "carte.csv": blob(join(run, "entrees", "carte.csv")) } };
      expect(T.demanderPreuve(t, { exigence: jalon, demandeur: "Fabien", commande: commande(), graine: "5", reproduction }).ok).toBe(true);
      const d = prendre();
      P.conclure(t, d, await P.rejouer(d, run));
      T.attester(t, { exigence: jalon, agent: "Fabien", role: "recette", nature: "parcours", recu: `preuves/${n}.json`, portee: jalon });
    };
    await prouverJalon("E1.1", 1);
    expect(P.etatDesExigences(t, run)).toMatchObject([{ libelle: "E1", etat: "a_prouver", jalons: { attestes: 1, total: 2, restants: ["E1.2"] } }]);
    expect(etatDuRun(t, run, "absente").raisons).toEqual(["exigences non satisfaites : E1 (à prouver (1/2 jalons, reste E1.2))"]);
    await prouverJalon("E1.2", 2);
    expect(P.etatDesExigences(t, run)).toMatchObject([{ libelle: "E1", etat: "attestee", jalons: { attestes: 2, total: 2, restants: [] } }]);
    expect(etatDuRun(t, run, "absente").etat).toBe("accepte");
    expect(etatDuRun(t, run, "echoue")).toMatchObject({ etat: "incomplet", raisons: ["la vérification de la mission ne passe pas"] });
    writeFileSync(join(partage, "prix.js"), "export const prix = () => 5;\n");
    expect(await P.rejouerAttestations(t, run)).toBe(2); // chaque jalon se rejoue, comme une exigence
    expect(P.etatDesExigences(t, run)[0]).toMatchObject({ libelle: "E1", etat: "rejeu_echoue", jalons: { attestes: 0, total: 2 } });
    expect(etatDuRun(t, run, "absente").etat).toBe("incomplet");
    expect(t.all<{ r: string }>("SELECT resultat_resume AS r FROM evenements WHERE type = 'rejeu_echoue' ORDER BY id").map((e) => e.r.slice(0, 26)))
      .toEqual(["E1.1 n'est plus attestée :", "E1.2 n'est plus attestée :"]);
  }, 30_000);

  // Douze jalons : chacun prouvé, E1 tenue à 12/12 ; un produit changé les rejoue tous, un par un.
  test("douze jalons : tous prouvés, E1 attestée ; le produit changé les rejoue tous les douze", async () => {
    const portees = Array.from({ length: 12 }, (_, i) => `partie ${i + 1}`);
    T.jalonner(t, { parent: "E1", portees, par: "Antoine" });
    await corriger();
    for (let i = 1; i <= 12; i++) {
      const reproduction: T.Reproduction = { commande: commande(), graine: "5", commit: await main(), banc: { [banc]: blob(banc) }, monde: { "carte.csv": blob(join(run, "entrees", "carte.csv")) } };
      expect(T.demanderPreuve(t, { exigence: `E1.${i}`, demandeur: "Fabien", commande: commande(), graine: "5", reproduction }).ok).toBe(true);
      const d = prendre();
      P.conclure(t, d, await P.rejouer(d, run));
      T.attester(t, { exigence: `E1.${i}`, agent: "Fabien", role: "recette", nature: "parcours", recu: `preuves/${i}.json`, portee: `E1.${i}` });
    }
    expect(P.etatDesExigences(t, run)).toMatchObject([{ libelle: "E1", etat: "attestee", jalons: { attestes: 12, total: 12 } }]);
    writeFileSync(join(partage, "prix.js"), "export const prix = () => 5;\n");
    expect(await P.rejouerAttestations(t, run)).toBe(12);
    expect(P.etatDesExigences(t, run)[0]).toMatchObject({ etat: "rejeu_echoue", jalons: { attestes: 0, total: 12 } });
  }, 60_000);

  test("une attestation écrite à la main dans le tableau ne compte pas sans le reçu qui la prouve (30/09, D3)", async () => {
    await prouver(); // E1 attestée par Fabien sur preuves/1.json : attestee
    expect(P.etatDesExigences(t, run)[0]!.etat).toBe("attestee");
    const refaire = (o: Partial<Parameters<typeof T.attester>[1]>) => {
      t.run("DELETE FROM attestations");
      T.attester(t, { exigence: "E1", agent: "Fabien", role: "recette", nature: "parcours", recu: "preuves/1.json", portee: "p", ...o });
      return P.etatDesExigences(t, run)[0]!;
    };
    // un reçu qui n'existe pas dans le registre
    expect(refaire({ recu: "preuves/99.json" })).toMatchObject({ etat: "perimee" });
    // un reçu qui ne passe pas, ou d'une autre exigence
    writeFileSync(join(run, "preuves", "7.json"), JSON.stringify({ ...lireRecu(1), n: 7, passe: false }));
    expect(refaire({ recu: "preuves/7.json" }).changes?.[0]).toContain("ne passe pas");
    writeFileSync(join(run, "preuves", "8.json"), JSON.stringify({ ...lireRecu(1), n: 8, exigence: "E2" }));
    expect(refaire({ recu: "preuves/8.json" }).changes?.[0]).toContain("porte sur E2");
    // un constructeur qui se dit recette
    T.ajouterAgent(t, "Claude", join(run, "agents", "Claude"), undefined, undefined, { role: "constructeur" });
    expect(refaire({ agent: "Claude" }).changes?.[0]).toContain("Claude n'est pas");
    // la vraie reste valable
    expect(refaire({}).etat).toBe("attestee");
  }, 30_000);
  test("le banc change entre le dépôt du rejeu et son exécution : rien n'est reporté (29/09, revue P1)", async () => {
    await prouver();
    writeFileSync(join(partage, "prix.js"), "export const prix = () => 5;\n"); // le produit casse
    expect(P.demanderRejeux(t, run)).toHaveLength(1);
    // pendant l'attente en file, le banc devient un test qui passe toujours
    writeFileSync(banc, `import { test } from "bun:test";\ntest("prix", () => {});\n`);
    const d = prendre();
    const recu = await P.rejouer(d, run);
    expect(recu).toMatchObject({ passe: true, conditions: { banc: [banc] } });
    P.conclure(t, d, recu);
    expect(T.attestationDe(t, "E1")!.recu).toBe("preuves/1.json"); // rien de reporté sur un contrôle que personne n'a signé
    expect(etatDuRun(t, run, "absente").etat).toBe("incomplet");
  }, 30_000);

  test("le banc du contrôleur change : le reçu est vraiment périmé, aucun rejeu", async () => {
    await prouver();
    writeFileSync(banc, readFileSync(banc, "utf8") + "// un cas de plus\n");
    writeFileSync(join(partage, "note.md"), "x\n");
    expect(P.etatDesExigences(t, run)[0]).toMatchObject({ etat: "perimee", changes: [`banc ${banc}`, "produit note.md"] });
    expect(P.demanderRejeux(t, run)).toEqual([]);
    expect(await P.rejouerAttestations(t, run)).toBe(0);
    expect(existsSync(join(run, "preuves", "2.json"))).toBe(false);
    expect(etatDuRun(t, run, "absente").raisons).toEqual(["exigences non satisfaites : E1 (périmée)"]);
  }, 30_000);

  test("pas de double rejeu du même reçu sur le même produit ; un nouveau produit, un nouveau rejeu", async () => {
    await prouver();
    writeFileSync(join(partage, "prix.js"), "export const prix = () => 5;\n");
    const [id] = P.demanderRejeux(t, run);
    expect(P.demanderRejeux(t, run)).toEqual([id!]); // déjà en file : la même demande
    expect(await P.rejouerAttestations(t, run)).toBe(1);
    // Le rejeu a échoué sur ce produit : ni preuve_lister, ni moi_finir, ni le constat ne le relancent.
    expect(P.etatDesExigences(t, run)[0]!.etat).toBe("rejeu_echoue");
    expect(P.demanderRejeux(t, run)).toEqual([]);
    expect(await P.rejouerAttestations(t, run)).toBe(0);
    writeFileSync(join(partage, "prix.js"), readFileSync(join(partage, "prix.js"))); // mêmes octets, date neuve
    expect(await P.rejouerAttestations(t, run)).toBe(0);
    expect(t.all("SELECT id FROM demandes_rejeu WHERE rejoue IS NOT NULL")).toHaveLength(1);
    // Le produit est réparé : un autre état, un autre rejeu, qui passe ; l'attestation se reporte.
    writeFileSync(join(partage, "prix.js"), "export const prix = () => 4; // réparé\n");
    expect(await P.rejouerAttestations(t, run)).toBe(1);
    expect(T.attestationDe(t, "E1")!.recu).toBe("preuves/3.json");
    expect(lireRecu(3)).toMatchObject({ passe: true, rejoue: "preuves/1.json" });
    expect(etatDuRun(t, run, "absente").etat).toBe("accepte");
  }, 30_000);
});
