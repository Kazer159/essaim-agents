import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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

describe("un agent qui finit", () => {
  test("hello-fini : bilan 1/1, dossier du run, base tracée, verrou levé", async () => {
    process.env.ESSAIM_FIXTURE = fixture("hello-fini");
    const b = await lancer(base());
    expect(b).toMatchObject({ finis: 1, vires: 0, perdus: 0, plafond: 0.1, depassement: 0 });
    expect(b.depense).toBeCloseTo(0.0012, 6);
    expect(b.run.startsWith(join(racine, "runs"))).toBe(true);
    for (const f of ["tableau.sqlite", "partage", "agents/Antoine", "sessions", "journal/Antoine.jsonl"]) expect(existsSync(join(b.run, f))).toBe(true);
    const t = lire(b.run);
    expect(t.get<{ etat: string }>("SELECT etat FROM run")?.etat).toBe("termine");
    expect(t.get<{ texte: string; auteur: string }>("SELECT texte, auteur FROM messages")).toEqual({ texte: "bonjour de agent-01", auteur: "Antoine" });
    expect(t.get<{ n: number }>("SELECT count(*) AS n FROM evenements")?.n).toBe(7); // 6 du faux pi + la sortie tracée par le lanceur
    expect(t.all("SELECT type, resultat_resume, erreur FROM evenements WHERE agent = 'Antoine' AND type = 'sortie'")).toEqual([{ type: "sortie", resultat_resume: "fini : message posté", erreur: null }]);
    const a = t.get<Record<string, unknown>>("SELECT * FROM agents")!;
    expect(a.etat).toBe("fini");
    expect(a.raison_sortie).toBe("message posté");
    expect(a.cout_usd).toBeCloseTo(0.0012, 6);
    expect(a.appels).toBe(2);
    expect(a.tokens_entree).toBe(1200);
    t.fermer();
    expect(existsSync(join(racine, "runs", ".verrou"))).toBe(false);
    expect(readFileSync(join(b.run, "journal", "Antoine.jsonl"), "utf8").trim().split("\n").length).toBe(8); // en-tête et message utilisateur, comme pi, puis les 6 de la fixture
  });
});

// Le faux pi traite ses messages comme pi 0.85.1.
describe("le faux pi traite ses messages comme pi (en-tête, commandes, input, message utilisateur)", () => {
  const EXTENSION = `import { appendFileSync } from "node:fs";
const trace = (s: string) => appendFileSync(process.env.FAUX_TRACE!, Date.now() + " " + s + "\\n");
export default function (pi: any) {
  pi.registerCommand("lente", { handler: async (args: string) => { trace("commande " + args); await new Promise((r) => setTimeout(r, 50)); trace("fin de commande"); } });
  pi.on("input", (ev: any) => { trace("input " + ev.text); return { action: "transform", text: ev.text + "\\n\\n[salle] état" }; });
}
`;
  const lancerFaux = async (messages: string[], env: Record<string, string> = {}, extensions?: string[]) => {
    writeFileSync(join(racine, "ext.ts"), EXTENSION);
    writeFileSync(join(racine, "fixture.jsonl"), '{"type":"agent_start"}\n{"type":"agent_end"}\n');
    const e = (extensions ?? [join(racine, "ext.ts")]).flatMap((x) => ["-e", x]);
    const p = Bun.spawn(["bun", join(racineDepot, "tests", "faux-pi.ts"), "--mode", "json", "--session-id", "Antoine", ...e, "--", ...messages], {
      cwd: racine, stdout: "pipe", stderr: "pipe",
      env: { ...process.env, ESSAIM_FIXTURE: join(racine, "fixture.jsonl"), FAUX_TRACE: join(racine, "trace.txt"), ...env },
    });
    const [sortie, erreur, code] = [await new Response(p.stdout).text(), await new Response(p.stderr).text(), await p.exited];
    const trace = existsSync(join(racine, "trace.txt")) ? readFileSync(join(racine, "trace.txt"), "utf8").trim().split("\n").map((l) => { const [ms, ...r] = l.split(" "); return { ms: Number(ms), quoi: r.join(" ") }; }) : [];
    return { lignes: sortie.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)), erreur, code, trace };
  };

  test("l'en-tête d'abord ; la commande n'émet rien ; le message passe par input et sort en message_end user ; puis la fixture", async () => {
    const r = await lancerFaux(["/lente 1 2", "REPRISE", "/inconnue a"]);
    expect(r.erreur).toBe("");
    expect(r.code).toBe(0);
    expect(r.lignes[0]).toMatchObject({ type: "session", version: 3, id: "Antoine", cwd: expect.any(String) });
    expect(r.lignes.slice(1).map((l) => l.type === "message_end" ? `user : ${l.message.content[0].text}` : l.type)).toEqual([
      "user : REPRISE\n\n[salle] état", "user : /inconnue a\n\n[salle] état", "agent_start", "agent_end"]); // une commande inconnue part comme un message, comme pi
    expect(r.lignes[1].message).toMatchObject({ role: "user", timestamp: expect.any(Number) });
    expect(r.trace.map((x) => x.quoi)).toEqual(["commande 1 2", "fin de commande", "input REPRISE", "input /inconnue a"]);
  });

  test("/se-resumer (vraie extension) : l'input de la reprise arrive après la fin du compactage, même lent", async () => {
    const r = await lancerFaux(["/se-resumer garde le but", "REPRISE"], { ESSAIM_COMPACTAGE: "80000,120000,160000", ESSAIM_FAUX_COMPACTAGE_MS: "300" },
      [join(racineDepot, "src", "se-resumer.ts"), join(racine, "ext.ts")]);
    expect(r.erreur).toBe("");
    expect(r.lignes.filter((l) => l.type === "message_end").map((l) => l.message.content[0].text)).toEqual(["REPRISE\n\n[salle] état"]);
    expect(r.trace.map((x) => x.quoi)).toEqual(["input REPRISE"]);
    const debut = Date.parse(r.lignes[0].timestamp);
    expect(r.trace[0]!.ms - debut).toBeGreaterThanOrEqual(290);
  });

  test("ESSAIM_FAUX_ARRET_ENTETE=1 : input a tourné, mais seul l'en-tête sort (E3) ; code de ESSAIM_FIXTURE_CODE", async () => {
    const r = await lancerFaux(["REPRISE"], { ESSAIM_FAUX_ARRET_ENTETE: "1", ESSAIM_FIXTURE_CODE: "3" });
    expect(r.lignes.map((l) => l.type)).toEqual(["session"]);
    expect(r.code).toBe(3);
    expect(r.trace.map((x) => x.quoi)).toEqual(["input REPRISE"]);
  });

  test("par le lanceur : le journal commence par l'en-tête puis la mission en message utilisateur ; le Compteur l'ignore", async () => {
    process.env.ESSAIM_FIXTURE = fixture("hello-fini");
    const b = await lancer(base());
    const lignes = readFileSync(join(b.run, "journal", "Antoine.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lignes[0]).toMatchObject({ type: "session", id: "Antoine" });
    expect(lignes[1]).toMatchObject({ type: "message_end", message: { role: "user" } });
    expect(lignes[1].message.content[0].text).toContain("bonjour");
    expect(agentEnBase(b.run, "Antoine")).toMatchObject({ etat: "fini", appels: 2, tokens_entree: 1200 });
  });
});

describe("les consignes envoyées à pi", () => {
  test("sans entrée : la section « Les documents à traiter » est retirée en entier, le reste est substitué", async () => {
    process.env.ESSAIM_FIXTURE = fixture("hello-fini");
    const b = await lancer(base());
    const args = JSON.parse(readFileSync(join(b.run, "journal", "Antoine.args"), "utf8").trim().split("\n")[0]!).args as string[];
    const consignes = args[args.indexOf("--append-system-prompt") + 1]!;
    expect(consignes).not.toContain("{ENTREES}");
    expect(consignes).not.toContain("Les documents à traiter");
    expect(consignes).toContain("## Internet et installations");
    expect(consignes).toContain("## Le budget");
    expect(consignes).toContain("Tu es **Antoine**, un agent parmi **1**");
    expect(consignes).toContain(join(b.run, "partage"));
  });

  // Sans compactage, aucun agent ne lit le nom d'un outil qu'il n'a pas. Si la phrase
  // de l'annexe change, ce test casse : c'est voulu.
  test("sans compactage, moi_resumer quitte la ligne de la famille moi ; avec, il y reste", async () => {
    process.env.ESSAIM_FIXTURE = fixture("hello-fini");
    const consignesDe = (run: string) => { const args = JSON.parse(readFileSync(join(run, "journal", "Antoine.args"), "utf8").trim().split("\n")[0]!).args as string[]; return args[args.indexOf("--append-system-prompt") + 1]!; };
    const sans = consignesDe((await lancer({ ...base(), compactage: null })).run);
    expect(sans).not.toContain("moi_resumer");
    expect(sans).toContain("- **moi** — `moi_dormir` et `moi_finir` (plus bas).\n");
    const avec = consignesDe((await lancer(base())).run);
    expect(avec).toContain("- **moi** — `moi_dormir` et `moi_finir` (plus bas), `moi_resumer` résume ton propre contexte.\n");
  });
});

describe("la mission envoyée à pi", () => {
  test("{DEPOT} est remplacé par la racine du dépôt, dans le premier message et en base", async () => {
    process.env.ESSAIM_FIXTURE = fixture("hello-fini");
    const mission = join(racine, "mission-depot.md");
    writeFileSync(mission, "Recopie `{DEPOT}/missions/exemples/integration.test.js`.\n\n## C'est fini quand\n\nfini appelé\n");
    const b = await lancer({ ...base(), mission });
    const args = JSON.parse(readFileSync(join(b.run, "journal", "Antoine.args"), "utf8").trim().split("\n")[0]!).args as string[];
    expect(args.at(-1)).toContain(`${racineDepot}/missions/exemples/integration.test.js`);
    expect(args.at(-1)).not.toContain("{DEPOT}");
    const t = lire(b.run);
    expect(t.get<{ m: string }>("SELECT mission_texte AS m FROM run")?.m).not.toContain("{DEPOT}");
    t.fermer();
  });
});

describe("les documents d'entrée (--fichier)", () => {
  const entree = join(racineDepot, "tests", "fixtures", "entree.md");
  const sha = (chemin: string) => new Bun.CryptoHasher("sha256").update(readFileSync(chemin)).digest("hex");
  test("copié dans entrees/, empreinte et taille en base, chemin absolu dans les consignes et la mission", async () => {
    process.env.ESSAIM_FIXTURE = fixture("hello-fini");
    const mission = join(racine, "mission-entrees.md");
    writeFileSync(mission, "Lis {ENTREES}.\n\n## C'est fini quand\n\nfini appelé\n");
    const b = await lancer({ ...base(), mission, fichiers: [entree] });
    const copie = join(b.run, "entrees", "entree.md");
    expect(existsSync(copie)).toBe(true);
    expect(sha(copie)).toBe(sha(entree));
    const t = lire(b.run);
    const e = JSON.parse(t.get<{ e: string }>("SELECT entrees_json AS e FROM run")!.e);
    expect(e).toEqual([{ nom: "entree.md", taille: statSync(entree).size, sha256: sha(entree) }]);
    expect(e[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(t.get<{ m: string }>("SELECT mission_texte AS m FROM run")?.m).toContain(`Lis ${copie}.`);
    t.fermer();
    const args = JSON.parse(readFileSync(join(b.run, "journal", "Antoine.args"), "utf8").trim().split("\n")[0]!).args as string[];
    const consignes = args[args.indexOf("--append-system-prompt") + 1]!;
    expect(consignes).toContain(`Les documents à traiter sont dans ${copie}.`);
    expect(consignes).not.toContain("{ENTREES}");
    expect(b.entreesModifiees).toBeUndefined();
  });
  test("refus : trop gros, trop gros ensemble, pas du texte, même nom, absent ; rien n'est ouvert", async () => {
    const gros = join(racine, "gros.md"); writeFileSync(gros, "a".repeat(50 * 1024 + 1));
    const juste = (n: string) => { const p = join(racine, n); writeFileSync(p, "b".repeat(50 * 1024)); return p; };
    const png = join(racine, "image.png"); writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
    const autre = join(racine, "ailleurs"); mkdirSync(autre); writeFileSync(join(autre, "entree.md"), "autre");
    const avant = existsSync(join(racine, "runs")) ? readdirSync(join(racine, "runs")).length : 0;
    await expect(lancer({ ...base(), fichiers: [gros] })).rejects.toThrow("entrée trop grosse");
    await expect(lancer({ ...base(), fichiers: [juste("a.md"), juste("b.md"), juste("c.md"), juste("d.md")] })).rejects.toThrow("150 Ko");
    await expect(lancer({ ...base(), fichiers: [png] })).rejects.toThrow("pas du texte UTF-8");
    await expect(lancer({ ...base(), fichiers: [entree, join(autre, "entree.md")] })).rejects.toThrow("deux entrées du même nom");
    await expect(lancer({ ...base(), fichiers: [join(racine, "absent.md")] })).rejects.toThrow("introuvable");
    await expect(lancer({ ...base(), fichiers: [racine] })).rejects.toThrow("fichier ordinaire");
    expect(existsSync(join(racine, "runs")) ? readdirSync(join(racine, "runs")).length : 0).toBe(avant);
  });
  test("une entrée modifiée pendant le run : tracée sous l'auteur lanceur et dans le bilan", async () => {
    process.env.ESSAIM_FIXTURE = fixture("entree-fini"); // 300 ms d'attente avant de finir
    const promesse = lancer({ ...base(), fichiers: [entree] });
    await new Promise((r) => setTimeout(r, 120));
    const run = readdirSync(join(racine, "runs")).filter((n) => !n.startsWith(".")).sort().at(-1)!;
    writeFileSync(join(racine, "runs", run, "entrees", "entree.md"), "modifié par un agent");
    const b = await promesse;
    expect(b.entreesModifiees).toEqual(["entree.md"]);
    const t = lire(b.run);
    expect(t.all("SELECT agent, type, erreur FROM evenements WHERE type = 'entrees'")).toEqual([{ agent: "lanceur", type: "entrees", erreur: "entrées modifiées : entree.md" }]);
    t.fermer();
  });
});

describe("le constat de sortie (livrable et vérification)", () => {
  const missionAvec = (nom: string, sections: string) => { const p = join(racine, nom); writeFileSync(p, `Mission.\n\n## C'est fini quand\n\nfini appelé\n${sections}`); return p; };
  const dernierRun = () => readdirSync(join(racine, "runs")).filter((n) => !n.startsWith(".")).sort().at(-1)!;
  const lanceur = (run: string, type: string) => { const t = lire(run); const e = t.all<Record<string, unknown>>("SELECT agent, type, outil, resultat_resume, erreur FROM evenements WHERE agent = 'lanceur' AND type = ?", [type]); t.fermer(); return e; };
  const etatAgent = (run: string) => { const t = lire(run); const a = t.get<{ etat: string }>("SELECT etat FROM agents")!.etat; t.fermer(); return a; };

  test("livrable présent : taille et empreinte tracées sous l'auteur lanceur, dans le bilan et sa ligne", async () => {
    process.env.ESSAIM_FIXTURE = fixture("livrable-fini"); // 300 ms avant fini : le temps d'écrire le livrable
    const promesse = lancer({ ...base(), mission: missionAvec("m-livrable.md", "\n## Livrable\n\nindex.html\n") });
    await new Promise((r) => setTimeout(r, 120));
    writeFileSync(join(racine, "runs", dernierRun(), "partage", "index.html"), "<p>jeu</p>");
    const b = await promesse;
    expect(b.constat?.livrable).toMatchObject({ chemin: "index.html", present: true, taille: 10 });
    expect(b.constat?.livrable?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(b.constat?.verification).toBeUndefined();
    expect(lanceur(b.run, "livrable")).toEqual([{ agent: "lanceur", type: "livrable", outil: null, resultat_resume: `index.html · 10 octets · sha256 ${b.constat!.livrable!.sha256}`, erreur: null }]);
    expect(formaterBilan(b)).toContain("· livrable ok");
    expect(etatAgent(b.run)).toBe("fini");
  });
  test("livrable derrière un dossier qui est un lien vers l'extérieur : refusé, pas présent (29/09, revue F24)", async () => {
    process.env.ESSAIM_FIXTURE = fixture("livrable-fini");
    const ailleurs = mkdtempSync(join(racine, "ailleurs-"));
    writeFileSync(join(ailleurs, "index.html"), "<p>ancien run</p>");
    const promesse = lancer({ ...base(), mission: missionAvec("m-lien.md", "\n## Livrable\n\ndist/index.html\n") });
    await new Promise((r) => setTimeout(r, 120));
    symlinkSync(ailleurs, join(racine, "runs", dernierRun(), "partage", "dist"));
    const b = await promesse;
    expect(b.constat?.livrable).toMatchObject({ present: false, detail: "refusé : dist/index.html est un lien symbolique ou n'est pas un fichier" });
  });
  test("vérification qui laisse un processus tenir sa sortie : le constat n'attend pas ce processus (29/09, revue F25)", async () => {
    process.env.ESSAIM_FIXTURE = fixture("hello-fini");
    const debut = Date.now();
    const b = await lancer({ ...base(), mission: missionAvec("m-reste.md", "\n## Vérification\n\nsleep 20 & echo ok\n") });
    expect(b.constat?.verification).toMatchObject({ code: 0 });
    expect(b.constat?.verification?.sortie).toContain("ok");
    expect(Date.now() - debut).toBeLessThan(15_000);
  }, 40_000);
  test("livrable absent : tracé en erreur, les agents restent fini (D10)", async () => {
    process.env.ESSAIM_FIXTURE = fixture("hello-fini");
    // Un livrable qui n'est pas une page web : moi_finir ne le regarde pas (un .html absent refuse le départ).
    const b = await lancer({ ...base(), mission: missionAvec("m-absent.md", "\n## Livrable\n\nrapport.md\n") });
    expect(b.constat?.livrable).toMatchObject({ present: false, detail: "absent : rapport.md" });
    expect(lanceur(b.run, "livrable")[0]).toMatchObject({ erreur: "livrable absent" });
    expect(formaterBilan(b)).toContain("· livrable absent");
    expect(etatAgent(b.run)).toBe("fini");
  });
  test("vérification : lancée une fois dans partage/, sortie et code tracés, code non nul en erreur, agents inchangés", async () => {
    process.env.ESSAIM_FIXTURE = fixture("hello-fini");
    const ok = await lancer({ ...base(), mission: missionAvec("m-verif.md", "\n## Vérification\n\necho salut; pwd\n") });
    expect(ok.constat?.verification).toMatchObject({ commande: "echo salut; pwd", code: 0 });
    expect(ok.constat?.verification?.sortie).toContain("salut");
    expect(ok.constat?.verification?.sortie).toContain(join(ok.run, "partage"));
    const traces = lanceur(ok.run, "verification");
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ outil: "echo salut; pwd", erreur: null });
    expect(formaterBilan(ok)).toContain("· vérification code 0");
    const ko = await lancer({ ...base(), mission: missionAvec("m-verif-ko.md", "\n## Vérification\n\necho raté >&2; exit 3\n") });
    expect(ko.constat?.verification).toMatchObject({ code: 3 });
    expect(lanceur(ko.run, "verification")[0]).toMatchObject({ erreur: "code de sortie 3", resultat_resume: "raté" });
    expect(etatAgent(ko.run)).toBe("fini");
  });
  test("vérification : le code des agents qu'elle exécute ne voit ni jeton GitHub ni agent SSH (29/09, revue F3)", async () => {
    process.env.ESSAIM_FIXTURE = fixture("hello-fini");
    const avant = { gh: process.env.GH_TOKEN, ssh: process.env.SSH_AUTH_SOCK };
    process.env.GH_TOKEN = "jeton-de-l-utilisateur";
    process.env.SSH_AUTH_SOCK = "/tmp/agent-ssh-de-l-utilisateur";
    try {
      const b = await lancer({ ...base(), mission: missionAvec("m-env.md", "\n## Vérification\n\necho \"gh=[$GH_TOKEN] ssh=[$SSH_AUTH_SOCK]\"\n") });
      expect(b.constat?.verification?.sortie).toContain("gh=[] ssh=[]");
    } finally {
      for (const [k, v] of [["GH_TOKEN", avant.gh], ["SSH_AUTH_SOCK", avant.ssh]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
  test("vérification en plusieurs commandes : lancées à la suite dans le même dossier, arrêtées à la première en échec", async () => {
    process.env.ESSAIM_FIXTURE = fixture("hello-fini");
    // Une couture ne se voit qu'en enchaînant : la deuxième commande lit ce que la première a écrit.
    const ok = await lancer({ ...base(), mission: missionAvec("m-suite.md", "\n## Vérification\n\necho un > trace.txt\ncat trace.txt\necho fin\n") });
    expect(ok.constat?.verifications).toHaveLength(3);
    expect(ok.constat?.verifications?.[1]).toMatchObject({ commande: "cat trace.txt", code: 0 });
    expect(ok.constat?.verifications?.[1]?.sortie).toContain("un"); // l'état laissé par la commande d'avant
    expect(ok.constat?.verification).toMatchObject({ commande: "echo fin", code: 0 });
    expect(lanceur(ok.run, "verification")).toHaveLength(3);
    expect(formaterBilan(ok)).toContain("· vérification (3) code 0");

    const ko = await lancer({ ...base(), mission: missionAvec("m-suite-ko.md", "\n## Vérification\n\necho un\nexit 4\necho jamais\n") });
    expect(ko.constat?.verifications).toHaveLength(2); // la troisième ne se joue pas
    expect(ko.constat?.verification).toMatchObject({ commande: "exit 4", code: 4 });
    expect(formaterBilan(ko)).toContain("· vérification (2ᵉ en échec) code 4");
  });
  test("vérification trop longue : coupée au délai (2 s sous test)", async () => {
    process.env.ESSAIM_FIXTURE = fixture("hello-fini");
    const debut = Date.now();
    const b = await lancer({ ...base(), mission: missionAvec("m-lent.md", "\n## Vérification\n\nsleep 30\n") });
    expect(Date.now() - debut).toBeLessThan(10_000);
    expect(b.constat?.verification).toMatchObject({ code: null, coupe: "coupé : délai dépassé" });
    expect(lanceur(b.run, "verification")[0]).toMatchObject({ erreur: "coupé : délai dépassé" });
    expect(formaterBilan(b)).toContain("· vérification coupé : délai dépassé");
  });
  test("un fichier arret pendant la vérification la coupe", async () => {
    process.env.ESSAIM_FIXTURE = fixture("hello-fini");
    const promesse = lancer({ ...base(), mission: missionAvec("m-arret.md", "\n## Vérification\n\nsleep 30\n") });
    await new Promise((r) => setTimeout(r, 500));
    writeFileSync(join(racine, "runs", dernierRun(), "arret"), "");
    const b = await promesse;
    expect(b.constat?.verification?.coupe).toBe("coupé : arrêt demandé depuis la vue");
    expect(b.constat?.verification?.dureeMs).toBeLessThan(2000);
  });
  test("{DEPOT} et {ENTREES} sont substitués dans la commande de vérification", async () => {
    process.env.ESSAIM_FIXTURE = fixture("hello-fini");
    const entree = join(racineDepot, "tests", "fixtures", "entree.md");
    const b = await lancer({ ...base(), fichiers: [entree], mission: missionAvec("m-subst.md", "\n## Vérification\n\necho {DEPOT} {ENTREES}\n") });
    expect(b.constat?.verification?.sortie).toBe(`${racineDepot} ${join(b.run, "entrees", "entree.md")}`);
  });
});

describe("les prénoms", () => {
  test("Antoine, Bernard, Claude… dans l'ordre alphabétique, sans accent, uniques ; refus au-delà de la liste", async () => {
    expect(PRENOMS.slice(0, 3)).toEqual(["Antoine", "Bernard", "Claude"]);
    expect([...PRENOMS].sort()).toEqual([...PRENOMS]);
    expect(new Set(PRENOMS).size).toBe(PRENOMS.length);
    for (const p of PRENOMS) expect(p).toMatch(/^[A-Z][a-z]+$/);
    expect(nomAgent(1)).toBe("Antoine");
    expect(nomAgent(PRENOMS.length + 1)).toBe(PRENOMS_RELEVE[0]); // la relève prend la suite (25 agents demandés)
    expect(() => nomAgent(PRENOMS.length + PRENOMS_RELEVE.length + 1)).toThrow("au plus 40 agents");
    await expect(lancer({ ...base(), agents: 41 })).rejects.toThrow("au plus 40 agents");
  });

  test("les agentes : vingt prénoms sans accent, uniques, distincts des hommes", () => {
    expect(PRENOMS_FEMMES.length).toBe(20);
    expect(PRENOMS_FEMMES.slice(0, 3)).toEqual(["Agathe", "Brigitte", "Cecile"]);
    expect(new Set(PRENOMS_FEMMES).size).toBe(20);
    for (const p of PRENOMS_FEMMES) expect(p).toMatch(/^[A-Z][a-z]+$/);
    for (const p of PRENOMS_FEMMES) expect(PRENOMS as readonly string[]).not.toContain(p);
  });

  test("la relève (O2, 28/09) : vingt prénoms de plus, puis des prénoms créés ; aucun doublon, jamais épuisé à 20 agents", () => {
    expect(PRENOMS_RELEVE.length).toBe(20);
    for (const p of PRENOMS_RELEVE) expect(p).toMatch(/^[A-Z][a-z]+$/);
    for (const p of PRENOMS_RELEVE) expect([...PRENOMS, ...PRENOMS_FEMMES] as string[]).not.toContain(p);
    expect(prenomLibre(new Set(["Antoine"]))).toBe("Bernard");
    const pris = new Set<string>(PRENOMS);
    expect(prenomLibre(pris)).toBe("Achille");
    for (const p of PRENOMS_RELEVE) pris.add(p);
    const crees: string[] = [];
    for (let i = 0; i < 100; i++) { const p = prenomLibre(pris); crees.push(p); pris.add(p); }
    expect(crees[0]).toBe("Bano");
    expect(new Set(crees).size).toBe(100);
    for (const p of crees) expect(p).toMatch(/^[A-Z][a-z]+$/);
    for (const p of crees) expect([...PRENOMS, ...PRENOMS_FEMMES, ...PRENOMS_RELEVE] as string[]).not.toContain(p);
  });

  test("repartir : un seul modèle, tous des hommes, comme nomAgent", () => {
    expect(repartir(3, false)).toEqual([
      { nom: "Antoine", cote: "hommes" }, { nom: "Bernard", cote: "hommes" }, { nom: "Claude", cote: "hommes" },
    ]);
    expect(repartir(25, false).map((a) => a.nom).slice(19, 22)).toEqual(["Xavier", "Achille", "Basile"]);
    expect(() => repartir(41, false)).toThrow("au plus 40 agents");
  });

  test("repartir : deux modèles, parts égales arrondies aux hommes, en alternance", () => {
    expect(repartir(7, true).map((a) => `${a.nom}:${a.cote[0]}`)).toEqual(
      ["Antoine:h", "Agathe:f", "Bernard:h", "Brigitte:f", "Claude:h", "Cecile:f", "Denis:h"]);
    const six = repartir(6, true);
    expect(six.filter((a) => a.cote === "hommes").length).toBe(3);
    expect(six.filter((a) => a.cote === "femmes").length).toBe(3);
    expect(repartir(2, true).map((a) => a.nom)).toEqual(["Antoine", "Agathe"]);
    expect(repartir(20, true).length).toBe(20);
    expect(() => repartir(1, true)).toThrow("avec deux modèles, 2 agents au moins");
    expect(() => repartir(21, true)).toThrow("au plus 20 agents avec deux modèles");
  });
});

describe("deux agents en même temps", () => {
  test("deux agents postent au même instant : deux messages, aucun « database is locked »", async () => {
    process.env.ESSAIM_FIXTURE = fixture("hello-fini");
    process.env.ESSAIM_TOUR_MS = "0"; // ici on éprouve le verrou de la base, pas le tour de parole du démarrage
    const b = await lancer({ ...base(), agents: 2 });
    expect(b).toMatchObject({ finis: 2, vires: 0, perdus: 0 });
    const t = lire(b.run);
    expect(t.get<{ n: number }>("SELECT count(*) AS n FROM messages")?.n).toBe(2);
    expect(t.all("SELECT agent FROM evenements WHERE resultat_resume LIKE '%locked%' OR erreur LIKE '%locked%'")).toEqual([]);
    t.fermer();
    delete process.env.ESSAIM_TOUR_MS;
  });
});

describe("le dépôt du run (A7)", () => {
  const git = (run: string, ...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: join(run, "partage"), env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } }).stdout.toString().trim();
  const auteurDe = (run: string, f: string) => git(run, "log", "-1", "--format=%an", "--", f);
  test("deux agents écrivent au même instant : un commit chacun, à son nom ; le bureau n'est pas suivi ; bilan et traces", async () => {
    process.env.ESSAIM_FIXTURE = fixture("ecrit-fini");
    const b = await lancer({ ...base(), agents: 2 });
    expect(auteurDe(b.run, "Antoine.js")).toBe("Antoine");
    expect(auteurDe(b.run, "Bernard.js")).toBe("Bernard");
    expect(git(b.run, "status", "--porcelain")).toBe("");
    expect(git(b.run, "log", "--format=%s", "-n1", "--", "Antoine.js")).toBe("write Antoine.js");
    expect(existsSync(join(b.run, "partage", ".git", "index.lock"))).toBe(false);
    expect(b.commits).toEqual({ total: 2, parAgent: { Antoine: 1, Bernard: 1 }, adoptions: {} });
    const t = lire(b.run);
    expect(t.all<{ agent: string; appel_id: string }>("SELECT agent, appel_id FROM evenements WHERE type = 'commit' ORDER BY agent")).toEqual([{ agent: "Antoine", appel_id: "w1" }, { agent: "Bernard", appel_id: "w1" }]);
    t.fermer();
  });
  test("un bash qui finit pendant le write d'un autre ne lui vole pas son fichier", async () => {
    process.env.ESSAIM_FIXTURE_ANTOINE = fixture("ecrit-lent"); // write de lent.js, puis attend la barrière avant sa fin
    process.env.ESSAIM_FIXTURE = fixture("bash-pendant"); // Bernard : bash fini pendant ce temps, puis pose la barrière
    const b = await lancer({ ...base(), agents: 2 });
    expect(auteurDe(b.run, "lent.js")).toBe("Antoine");
    expect(auteurDe(b.run, "a.js")).toBe("Bernard");
    expect(git(b.run, "log", "--format=%s", "-n1", "--", "a.js")).toBe("bash : echo a > a.js");
  });
  test("un .git remplacé en cours de run : signalé, et plus aucun commit n'y est fait", async () => {
    process.env.ESSAIM_FIXTURE = fixture("ecrit-apres-barriere"); // n'écrit qu'une fois la barrière posée
    const run = lancer(base());
    let runDir: string | undefined;
    for (let i = 0; i < 200 && !runDir; i++) {
      await Bun.sleep(10);
      const runs = existsSync(join(racine, "runs")) ? readdirSync(join(racine, "runs")).filter((n) => !n.startsWith(".")) : [];
      if (runs[0] && existsSync(join(racine, "runs", runs[0], "journal", "Antoine.args"))) runDir = join(racine, "runs", runs[0]);
    }
    rmSync(join(runDir!, "partage", ".git"), { recursive: true, force: true });
    Bun.spawnSync(["git", "init", "-q", join(runDir!, "partage")]);
    writeFileSync(join(runDir!, "barriere"), "");
    const b = await run;
    expect(git(b.run, "log", "--oneline")).toBe(""); // le faux .git n'a reçu aucun commit
    const t = lire(b.run);
    expect(t.get<{ resultat_resume: string }>("SELECT resultat_resume FROM evenements WHERE type = 'depot'")?.resultat_resume).toContain("disparu ou remplacé");
    t.fermer();
  });
});

describe("faits ecriture à chaque commit (second cerveau, M2, R13, R14)", () => {
  const git = (run: string, ...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: join(run, "partage"), env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } }).stdout.toString().trim();
  const blob = (run: string, f: string) => git(run, "rev-parse", `HEAD:${f}`);
  const faitsEcriture = (run: string) => { const t = lire(run); const f = t.all<{ agent: string; source: string; texte: string; details_json: string }>("SELECT agent, source, texte, details_json FROM faits WHERE type = 'ecriture' ORDER BY id"); t.fermer(); return f.map((x) => ({ ...x, details: JSON.parse(x.details_json) })); };
  const outil = (id: string, nom: string, args: object) => [{ type: "tool_execution_start", toolCallId: id, toolName: nom, args }, { type: "tool_execution_end", toolCallId: id, toolName: nom, result: { content: [{ type: "text", text: "ok" }] }, isError: false }];
  test("write, page_assembler, bash et fin du run : un fait par commit, avec hash, message, fichiers et blobs", async () => {
    const lignes = [
      ...outil("w1", "write", { path: "{PARTAGE}/app.js", content: "app\n" }),
      ...outil("w2", "write", { path: "{PARTAGE}/src.html", content: '<script type="module" src="./m.js"></script>\n' }),
      ...outil("w3", "write", { path: "{PARTAGE}/m.js", content: "document.title = 'x';\n" }),
      { type: "tool_execution_start", toolCallId: "p1", toolName: "page_assembler", args: { source: "src.html", sortie: "sortie.html" } },
      { type: "tool_execution_start", toolCallId: "b1", toolName: "bash", args: { command: "echo b > b.js" } },
      { type: "faux:toucher", chemin: "{PARTAGE}/b.js" },
      { type: "tool_execution_end", toolCallId: "b1", toolName: "bash", result: { content: [{ type: "text", text: "" }] }, isError: false },
      { type: "faux:dormir", ms: 1500 }, // le commit du bash avant reste.txt, même sous charge (--parallel)
      { type: "faux:toucher", chemin: "{PARTAGE}/reste.txt" },
      { type: "tool_execution_start", toolCallId: "f1", toolName: "moi_finir", args: { raison: "fait" } },
      { type: "agent_end" },
    ];
    const p = join(racine, "ecrit-tout.jsonl");
    writeFileSync(p, lignes.map((l) => JSON.stringify(l)).join("\n") + "\n");
    process.env.ESSAIM_FIXTURE = p;
    const b = await lancer(base());
    const hash = (f: string) => git(b.run, "log", "-1", "--format=%h", "--", f);
    const faits = faitsEcriture(b.run);
    expect(faits.map((f) => f.texte)).toEqual([
      `écrit · app.js · Antoine · commit ${hash("app.js")}`,
      `écrit · src.html · Antoine · commit ${hash("src.html")}`,
      `écrit · m.js · Antoine · commit ${hash("m.js")}`,
      `écrit · sortie.html · Antoine · commit ${hash("sortie.html")}`,
      `écrit · b.js · Antoine · commit ${hash("b.js")} · par bash, attribué au mieux`,
      `écrit · reste.txt · essaim · commit ${hash("reste.txt")}`,
    ]);
    expect(faits[0]!.details).toEqual({ hash: hash("app.js"), message: "write app.js", fichiers: [{ chemin: "app.js", blob: blob(b.run, "app.js") }], racine: "partage", outil: "write" });
    expect(faits[3]!.details).toMatchObject({ message: "page_assembler : sortie.html", outil: "page_assembler", fichiers: [{ chemin: "sortie.html", blob: blob(b.run, "sortie.html") }] });
    expect(git(b.run, "log", "-1", "--format=%an", "--", "sortie.html")).toBe("Antoine"); // au nom de l'agent
    expect(faits[4]!.details).toMatchObject({ outil: "bash", message: "bash : echo b > b.js" });
    expect(faits[5]).toMatchObject({ agent: "essaim", source: "lanceur", details: { outil: "fin du run", message: "fin du run" } });
    expect(faits.every((f) => f.source === "lanceur")).toBe(true);
    // Un fait ecriture entre dans l'index comme un commit, sous son message.
    const t = lire(b.run);
    expect(t.get<{ n: number }>("SELECT count(*) AS n FROM recherche WHERE type = 'commit'")!.n).toBe(6);
    t.fermer();
  });
  test("aucun commit, aucun fait", async () => {
    process.env.ESSAIM_FIXTURE = fixture("hello-fini");
    const b = await lancer(base());
    expect(faitsEcriture(b.run)).toEqual([]);
  });
});

describe("passes, perdu, erreur fournisseur", () => {
  test("sans fini : trois passes sur la même session, puis perdu « passes épuisées »", async () => {
    process.env.ESSAIM_FIXTURE = fixture("sans-fini");
    const b = await lancer(base());
    expect(b).toMatchObject({ finis: 0, vires: 0, perdus: 1 });
    expect(b.depense).toBeCloseTo(0.0015, 6);
    const journal = readFileSync(join(b.run, "journal", "Antoine.jsonl"), "utf8");
    expect(journal.match(/"agent_end"/g)!.length).toBe(3);
    const lancements = readFileSync(join(b.run, "journal", "Antoine.args"), "utf8").trim().split("\n").map((l) => JSON.parse(l).args as string[]);
    expect(lancements.length).toBe(3);
    expect(lancements[0]!.at(-1)).toContain("bonjour");
    expect(lancements[1]!.at(-1)).toBe("continue");
    expect(lancements[2]!.at(-1)).toBe("continue");
    for (const l of lancements) expect(l[l.indexOf("--session-id") + 1]).toBe("Antoine");
    const a = agentEnBase(b.run, "Antoine");
    expect([a.etat, a.raison_sortie, a.passes]).toEqual(["perdu", "passes épuisées", 3]);
  });
  test("erreur du fournisseur : relancé sur la même session avec « continue », tracé, puis fini", async () => {
    process.env.ESSAIM_FIXTURE = fixture("erreur-fournisseur");
    process.env.ESSAIM_FIXTURE_PASSE_2 = fixture("hello-fini");
    const b = await lancer(base());
    expect(b).toMatchObject({ finis: 1, vires: 0, perdus: 0 });
    const lancements = readFileSync(join(b.run, "journal", "Antoine.args"), "utf8").trim().split("\n").map((l) => JSON.parse(l).args as string[]);
    expect(lancements.length).toBe(2);
    expect(lancements[1]!.at(-1)).toBe("continue");
    const a = agentEnBase(b.run, "Antoine");
    expect([a.etat, a.raison_sortie, a.passes]).toEqual(["fini", "message posté", 2]);
    const t = lire(b.run);
    expect(t.all<{ resultat_resume: string }>("SELECT resultat_resume FROM evenements WHERE type = 'relance'")).toEqual([{ resultat_resume: "relancé après une erreur du fournisseur (passe 2/3) : 402: insufficient credits" }]);
    t.fermer();
  });
  test("mémoire empoisonnée par un appel d'outil vide : réparée, reprise sans perdre de passe (run festival, 24/09)", async () => {
    const empoisonnee = [
      { type: "message", id: "a1", parentId: null, message: { role: "assistant", content: [{ type: "toolCall", id: "", name: "", arguments: {} }] } },
      { type: "message", id: "a2", parentId: "a1", message: { role: "toolResult", toolCallId: "", toolName: "", content: [{ type: "text", text: "Tool  not found" }], isError: true } },
    ].map((l) => JSON.stringify(l)).join("\n") + "\n";
    const erreur = '400: {"message":"messages[67]: tool messages must include a non-empty string tool_call_id","code":400}';
    const racineF = mkdtempSync(join(tmpdir(), "essaim-fixture-"));
    const f = join(racineF, "empoisonne.jsonl");
    writeFileSync(f, [{ type: "faux:session", contenu: empoisonnee }, { type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: erreur } }, { type: "agent_end" }].map((l) => JSON.stringify(l)).join("\n") + "\n");
    process.env.ESSAIM_FIXTURE = f;
    process.env.ESSAIM_FIXTURE_PASSE_2 = fixture("hello-fini");
    const b = await lancer(base());
    expect(b).toMatchObject({ finis: 1, perdus: 0 });
    expect(agentEnBase(b.run, "Antoine").passes).toBe(1); // la réparation ne coûte pas de passe
    const lancements = readFileSync(join(b.run, "journal", "Antoine.args"), "utf8").trim().split("\n").map((l) => JSON.parse(l).args as string[]);
    expect(lancements[1]!.at(-1)).toContain("outil_inconnu"); // relancé sur un message qui explique, pas sur la mission
    const session = readFileSync(join(b.run, "sessions", "faux_Antoine.jsonl"), "utf8");
    expect(session).not.toContain('"toolCallId":""');
    const t = lire(b.run);
    expect(t.all<{ resultat_resume: string }>("SELECT resultat_resume FROM evenements WHERE type = 'relance'")).toEqual([{ resultat_resume: "mémoire réparée : 1 appel d'outil sans numéro, reprise sans perdre de passe" }]);
    t.fermer();
    rmSync(racineF, { recursive: true, force: true });
  });
  test("trop d'images dans la mémoire : retirées, reprise sans perdre de passe (F14, run ville, 25/09)", async () => {
    const image = { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" };
    const memoire = [0, 1, 2, 3, 4, 5].map((i) => ({ type: "message", id: `r${i}`, parentId: i ? `r${i - 1}` : null,
      message: { role: "toolResult", toolCallId: `c${i}`, toolName: "read", content: [{ type: "text", text: "Read image file [image/png]" }, image] } }))
      .map((l) => JSON.stringify(l)).join("\n") + "\n";
    const racineF = mkdtempSync(join(tmpdir(), "essaim-fixture-"));
    const f = join(racineF, "trop-d-images.jsonl");
    writeFileSync(f, [{ type: "faux:session", contenu: memoire }, { type: "message_end", message: { role: "assistant", content: [], usage: { input: 0, output: 0 }, stopReason: "error", errorMessage: "Too many images in request: 6 > 4" } }, { type: "agent_end" }].map((l) => JSON.stringify(l)).join("\n") + "\n");
    process.env.ESSAIM_FIXTURE = f;
    process.env.ESSAIM_FIXTURE_PASSE_2 = fixture("hello-fini");
    const b = await lancer(base());
    expect(b).toMatchObject({ finis: 1, perdus: 0 });
    expect(agentEnBase(b.run, "Antoine").passes).toBe(1); // le refus ne coûte pas de passe
    const lancements = readFileSync(join(b.run, "journal", "Antoine.args"), "utf8").trim().split("\n").map((l) => JSON.parse(l).args as string[]);
    expect(lancements[1]!.at(-1)).toContain("images"); // relancé sur un message qui explique
    expect(readFileSync(join(b.run, "sessions", "faux_Antoine.jsonl"), "utf8")).not.toContain('"type":"image"');
    const t = lire(b.run);
    expect(t.all<{ resultat_resume: string }>("SELECT resultat_resume FROM evenements WHERE type = 'relance'")).toEqual([{ resultat_resume: "mémoire allégée : 6 images retirées (le fournisseur refusait : Too many images in request: 6 > 4), reprise sans perdre de passe" }]);
    t.fermer();
    rmSync(racineF, { recursive: true, force: true });
  });
  test("délai dépassé chez le fournisseur : relancé sans consommer de passe (run ville, 25/09)", async () => {
    process.env.ESSAIM_FIXTURE = fixture("delai-fournisseur");
    process.env.ESSAIM_FIXTURE_PASSE_2 = fixture("hello-fini");
    const b = await lancer(base());
    expect(b).toMatchObject({ finis: 1, perdus: 0 });
    expect(agentEnBase(b.run, "Antoine").passes).toBe(1);
    const lancements = readFileSync(join(b.run, "journal", "Antoine.args"), "utf8").trim().split("\n").map((l) => JSON.parse(l).args as string[]);
    expect(lancements[1]!.at(-1)).toBe(lancements[0]!.at(-1)!); // rien reçu du modèle au premier lancement : la mission est renvoyée
    const t = lire(b.run);
    expect(t.all<{ resultat_resume: string }>("SELECT resultat_resume FROM evenements WHERE type = 'relance'")).toEqual([{ resultat_resume: "relancé après une erreur passagère du fournisseur (1/20), sans consommer de passe : Provider timed out after 23836ms" }]);
    t.fermer();
  });
  test("délai dépassé en cours de travail : la reprise dit ce qui s'est passé, sans renvoyer la mission", async () => {
    const racineF = mkdtempSync(join(tmpdir(), "essaim-fixture-"));
    const f = join(racineF, "delai-en-cours.jsonl");
    const repondu = { type: "message_end", message: { role: "assistant", content: [], usage: { input: 100, output: 10, cost: { total: 0.0001 } }, stopReason: "toolUse" } };
    const delai = { type: "message_end", message: { role: "assistant", content: [], usage: { input: 0, output: 0 }, stopReason: "error", errorMessage: "Provider timed out after 24036ms" } };
    writeFileSync(f, [repondu, delai, { type: "agent_end" }].map((l) => JSON.stringify(l)).join("\n") + "\n");
    process.env.ESSAIM_FIXTURE = f;
    process.env.ESSAIM_FIXTURE_PASSE_2 = fixture("hello-fini");
    const b = await lancer(base());
    expect(b).toMatchObject({ finis: 1 });
    const lancements = readFileSync(join(b.run, "journal", "Antoine.args"), "utf8").trim().split("\n").map((l) => JSON.parse(l).args as string[]);
    expect(lancements[1]!.at(-1)).toContain("n'a pas répondu à temps");
    rmSync(racineF, { recursive: true, force: true });
  });
  test("erreurs passagères au-delà de leur borne : la règle des passes reprend, puis perdu", async () => {
    process.env.ESSAIM_FIXTURE = fixture("delai-fournisseur");
    process.env.ESSAIM_PASSAGERES_MAX = "2";
    try {
      const b = await lancer(base());
      expect(b).toMatchObject({ perdus: 1 });
      const a = agentEnBase(b.run, "Antoine");
      expect([a.etat, a.raison_sortie, a.passes]).toEqual(["perdu", "Provider timed out after 23836ms", 3]);
      expect(readFileSync(join(b.run, "journal", "Antoine.args"), "utf8").trim().split("\n").length).toBe(5); // 2 passagères + 3 passes
    } finally { delete process.env.ESSAIM_PASSAGERES_MAX; }
  });
  test("erreur du fournisseur à chaque passe : perdu avec le message après la troisième", async () => {
    process.env.ESSAIM_FIXTURE = fixture("erreur-fournisseur");
    const b = await lancer(base());
    expect(b).toMatchObject({ finis: 0, vires: 0, perdus: 1 });
    const a = agentEnBase(b.run, "Antoine");
    expect([a.etat, a.raison_sortie, a.passes]).toEqual(["perdu", "402: insufficient credits", 3]);
  });
  test("code de sortie non nul : perdu « code de sortie 1 », sans relance", async () => {
    process.env.ESSAIM_FIXTURE = fixture("sans-fini");
    process.env.ESSAIM_FIXTURE_CODE = "1";
    const b = await lancer(base());
    expect(b).toMatchObject({ perdus: 1 });
    const a = agentEnBase(b.run, "Antoine");
    expect([a.etat, a.raison_sortie, a.passes]).toEqual(["perdu", "code de sortie 1", 1]);
  });
});

