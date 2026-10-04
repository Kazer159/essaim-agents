import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as D from "../src/depot.ts";
import { nomPlanche } from "../src/voir.ts";
import { raisonAuFormat } from "./aide/refus.ts";
import { ouvrirBun } from "../src/tableau-bun.ts";
import * as T from "../src/tableau.ts";

let dossier: string, partage: string, essais: string;
const ecrire = (f: string, contenu: string | Uint8Array, racine = partage) => writeFileSync(join(racine, f), contenu);
const statut = async (d = partage) => (await D.git(d, ["status", "--porcelain"])).sortie.trim();
const dernier = async (d = partage) => (await D.historique(d, { limite: 1 }))[0]!;

beforeEach(async () => {
  dossier = mkdtempSync(join(tmpdir(), "essaim-depot-"));
  partage = join(dossier, "partage");
  essais = join(dossier, "essais");
  await D.ouvrirDepot(partage);
});
afterEach(() => rmSync(dossier, { recursive: true, force: true }));

describe("ouvrir", () => {
  test("un dépôt sur main, un commit d'ouverture par l'essaim, aucun remote, push refusé par le hook", async () => {
    expect((await D.git(partage, ["branch", "--show-current"])).sortie.trim()).toBe("main");
    expect((await D.historique(partage)).map((c) => [c.auteur, c.message])).toEqual([["essaim", "ouverture du run"]]);
    expect((await D.git(partage, ["remote"])).sortie.trim()).toBe("");
    Bun.spawnSync(["git", "init", "-q", "--bare", join(dossier, "dehors.git")]);
    await D.git(partage, ["remote", "add", "dehors", join(dossier, "dehors.git")]);
    const push = Bun.spawnSync(["git", "push", "dehors", "main"], { cwd: partage, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
    expect(push.exitCode).not.toBe(0);
    expect(push.stderr.toString()).toContain("ne se pousse jamais");
  });
  test("rouvrir un dépôt existant ne change rien ; node_modules et les bases SQLite restent hors de l'historique", async () => {
    await D.ouvrirDepot(partage);
    expect(await D.historique(partage)).toHaveLength(1);
    mkdirSync(join(partage, "node_modules"));
    ecrire("node_modules/x.js", "x");
    ecrire("base.sqlite", "x");
    expect(await statut()).toBe("");
  });
});

describe("commiter", () => {
  test("au nom de l'agent, et rien quand rien n'a changé", async () => {
    ecrire("index.html", "<h1>a</h1>");
    expect((await D.commiter(partage, "Antoine", "write index.html", { chemins: ["index.html"] }))?.hash).toMatch(/^[0-9a-f]{7,}$/);
    expect(await dernier()).toMatchObject({ auteur: "Antoine", message: "write index.html", fichiers: ["index.html"] });
    expect(await D.commiter(partage, "Antoine", "write index.html", { chemins: ["index.html"] })).toBeUndefined();
  });
  test("avec un chemin, seul ce fichier part : celui d'un autre attend son propre commit", async () => {
    ecrire("a.js", "a");
    ecrire("b.js", "b");
    await D.commiter(partage, "Antoine", "write a.js", { chemins: ["a.js"] });
    expect(await statut()).toBe("?? b.js");
  });
  test("un fichier nommé *.js ne désigne que lui (chemins littéraux)", async () => {
    ecrire("a.js", "a");
    ecrire("*.js", "joker");
    await D.commiter(partage, "Antoine", "write *.js", { chemins: ["*.js"] });
    expect((await dernier()).fichiers).toEqual(["*.js"]);
    expect(await statut()).toBe("?? a.js");
  });
  test("sans chemin, tout ce qui a changé, suppressions comprises, sauf les fichiers en cours d'écriture", async () => {
    ecrire("a.js", "a");
    await D.commiter(partage, "Antoine", "write a.js", { chemins: ["a.js"] });
    rmSync(join(partage, "a.js"));
    mkdirSync(join(partage, "sous"));
    ecrire("sous/c.js", "c");
    ecrire("b.js", "b, écrit par Bernard, commit pas encore passé");
    await D.commiter(partage, "Claude", "bash : rm a.js && echo c > sous/c.js", { sauf: ["b.js"] });
    expect(await dernier()).toMatchObject({ auteur: "Claude", fichiers: ["a.js", "sous/c.js"] });
    expect(await statut()).toBe("?? b.js");
  });
  test("un fichier écrit puis effacé avant le commit n'est pas une erreur", async () => {
    expect(await D.commiter(partage, "Antoine", "write fantome.js", { chemins: ["fantome.js"] })).toBeUndefined();
  });
  test("un verrou abandonné est retiré par le seul écrivain ; sinon on attend qu'il soit relâché", async () => {
    const verrou = join(partage, ".git", "index.lock");
    writeFileSync(verrou, "");
    ecrire("a.js", "a");
    expect(await D.commiter(partage, "Antoine", "write a.js", { chemins: ["a.js"], seulEcrivain: true })).toBeDefined();
    writeFileSync(verrou, "");
    setTimeout(() => rmSync(verrou, { force: true }), 300);
    ecrire("b.js", "b");
    expect(await D.commiter(partage, "Bernard", "write b.js", { chemins: ["b.js"] })).toBeDefined();
  });
  test("un fichier en .lock effacé avant son commit n'est pas pris pour un verrou : rien n'est supprimé ailleurs (29/09, revue F3)", async () => {
    // git dit « pathspec 'bun.lock' did not match » : ce nom entre apostrophes n'est pas un verrou de git, et le lanceur
    // l'effaçait relativement à son propre dossier courant — la racine d'essaim, qui a justement un bun.lock.
    const ici = process.cwd();
    const temoin = join(dossier, "bun.lock");
    writeFileSync(temoin, "le vrai");
    process.chdir(dossier);
    try {
      await D.commiter(partage, "Antoine", "write bun.lock", { chemins: ["bun.lock"], seulEcrivain: true });
    } finally { process.chdir(ici); }
    expect(existsSync(temoin)).toBe(true);
  });
  test("des milliers de fichiers d'un coup (un .venv) se commitent : la liste ne passe pas en arguments (29/09, revue F2)", async () => {
    // Au-delà d'ARG_MAX (~1 Mo sur macOS), Bun.spawn levait E2BIG : plus aucun commit de bash jusqu'à la fin du run.
    const long = "x".repeat(60);
    for (let i = 0; i < 40; i++) {
      mkdirSync(join(partage, ".venv", `paquet-${long}-${i}`), { recursive: true });
      for (let j = 0; j < 500; j++) ecrire(`.venv/paquet-${long}-${i}/module-${long}-${j}.py`, "");
    }
    ecrire("app.py", "print(1)");
    const c = await D.commiter(partage, "Antoine", "bash : python -m venv .venv");
    expect(c?.fichiers.length).toBe(20_001);
    expect(await D.commiter(partage, "Antoine", "rien de neuf")).toBeUndefined();
  }, 60_000);
  test("git ne gèle pas le processus : une minuterie tourne pendant un commit", async () => {
    let tics = 0;
    const m = setInterval(() => tics++, 1);
    for (let i = 0; i < 5; i++) { ecrire(`f${i}.js`, String(i)); await D.commiter(partage, "Antoine", "w", { chemins: [`f${i}.js`] }); }
    clearInterval(m);
    expect(tics).toBeGreaterThan(5);
  });
  test("un core.fsmonitor piégé dans .git/config n'est jamais exécuté", async () => {
    const temoin = join(dossier, "execute");
    await D.git(partage, ["config", "core.fsmonitor", `touch ${temoin}`]);
    ecrire("a.js", "a");
    await D.commiter(partage, "Antoine", "write a.js");
    await D.git(partage, ["status"]);
    expect(existsSync(temoin)).toBe(false);
  });
  test("un dépôt imbriqué dans partage/ et son filtre piégé ne sont jamais exécutés (29/09, revue F1)", async () => {
    // Le bac à sable ferme partage/.git, pas partage/app/.git : un agent peut y poser un filtre que le git du lanceur,
    // hors bac à sable, lançait en visitant le sous-dépôt.
    const temoin = join(dossier, "execute-sous-depot");
    const app = join(partage, "app");
    mkdirSync(app, { recursive: true });
    const sous = (args: string[]) => Bun.spawnSync(["git", "-c", "user.name=x", "-c", "user.email=x@x", ...args], { cwd: app });
    sous(["init", "-q"]);
    sous(["config", "filter.piege.clean", `sh -c 'touch ${temoin}; cat'`]);
    writeFileSync(join(app, ".gitattributes"), "x filter=piege\n");
    writeFileSync(join(app, "x"), "1");
    sous(["add", "."]);
    sous(["commit", "-qm", "piège"]);
    rmSync(temoin, { force: true });
    await D.commiter(partage, "Antoine", "bash");
    writeFileSync(join(app, "x"), "2");
    await D.git(partage, ["status"]);
    await D.commiter(partage, "Antoine", "bash");
    expect(existsSync(temoin)).toBe(false);
  });
});

describe("commiter rend les fichiers réellement changés et leurs blobs (R13, M2)", () => {
  const hashObjet = (f: string, racine = partage) => Bun.spawnSync(["git", "hash-object", join(racine, f)]).stdout.toString().trim();
  test("{ hash, fichiers } : un candidat identique n'y est pas, un fichier supprimé a blob null, chaque blob égale git hash-object", async () => {
    ecrire("a.js", "a\n");
    ecrire("b.js", "b\n");
    ecrire("vieux.js", "v\n");
    const c1 = await D.commiter(partage, "Antoine", "write");
    expect(c1!.hash).toMatch(/^[0-9a-f]{7,}$/);
    expect(c1!.fichiers).toEqual([
      { chemin: "a.js", blob: hashObjet("a.js") }, { chemin: "b.js", blob: hashObjet("b.js") }, { chemin: "vieux.js", blob: hashObjet("vieux.js") },
    ]);
    ecrire("a.js", "a2\n");
    rmSync(join(partage, "vieux.js"));
    const c2 = await D.commiter(partage, "Antoine", "bash", { chemins: ["a.js", "b.js", "vieux.js"] });
    expect(c2!.fichiers).toEqual([{ chemin: "a.js", blob: hashObjet("a.js") }, { chemin: "vieux.js", blob: null }]);
    expect(c2!.hash).toBe((await dernier()).hash);
    expect(await D.commiter(partage, "Antoine", "write", { chemins: ["a.js"] })).toBeUndefined();
  });
  test("un renommage est une suppression et un ajout (--no-renames)", async () => {
    ecrire("ancien.js", "contenu assez long pour être reconnu comme renommé\n");
    await D.commiter(partage, "Antoine", "write");
    Bun.spawnSync(["mv", join(partage, "ancien.js"), join(partage, "nouveau.js")]);
    const c = await D.commiter(partage, "Antoine", "bash : mv");
    expect(c!.fichiers).toEqual([{ chemin: "ancien.js", blob: null }, { chemin: "nouveau.js", blob: hashObjet("nouveau.js") }]);
  });
  test("fichiersDuCommit : un commit de fusion se lit contre son premier parent ; sans ça, diff-tree ne rend rien", async () => {
    ecrire("moteur.js", "commun\n");
    await D.commiter(partage, "Antoine", "write");
    const d = await D.ouvrirEssai(partage, essais, "x");
    ecrire("moteur.js", "three\n", d);
    ecrire("carte.js", "carte\n", d);
    await D.commiter(d, "Bernard", "write");
    ecrire("autre.js", "pendant ce temps\n");
    await D.commiter(partage, "Claude", "write autre.js");
    const r = await D.adopter(partage, essais, "x", "Bernard");
    if (!r.ok) throw new Error(r.raison);
    expect(await D.fichiersDuCommit(partage, r.hash)).toEqual([]);
    const attendus = [{ chemin: "carte.js", blob: hashObjet("carte.js") }, { chemin: "moteur.js", blob: hashObjet("moteur.js") }];
    expect(await D.fichiersDuCommit(partage, r.hash, { premierParent: true })).toEqual(attendus);
    expect(r.blobs).toEqual(attendus);
    expect(r.fichiers).toEqual(["carte.js", "moteur.js"]);
  });
  test("restaurer rend les blobs de son commit, rien quand le fichier était déjà identique", async () => {
    ecrire("a.js", "v1\n");
    const v1 = (await D.commiter(partage, "Antoine", "write"))!.hash;
    ecrire("a.js", "v2\n");
    await D.commiter(partage, "Antoine", "write");
    const r = await D.restaurer(partage, "a.js", v1, "Claude", "retour");
    expect(r).toMatchObject({ ok: true, chemin: "a.js", depuis: v1.slice(0, 7), commit: { message: `restaurer a.js à ${v1.slice(0, 7)} : retour`, fichiers: [{ chemin: "a.js", blob: hashObjet("a.js") }] } });
    expect((r as { hash: string; commit: D.CommitFait }).hash).toBe((r as { commit: D.CommitFait }).commit.hash);
    const encore = await D.restaurer(partage, "a.js", v1, "Claude", "retour");
    expect(encore).toEqual({ ok: true, chemin: "a.js", depuis: v1.slice(0, 7), hash: undefined });
  });
});

describe("journal (B2, G12, T7)", () => {
  test("les commits du plus récent au plus ancien, ouverture comprise, première ligne du message", async () => {
    ecrire("a.js", "1");
    await D.commiter(partage, "agent-02", "write a.js\n\ndétail sur une autre ligne");
    ecrire("*.js", "étoile");
    await D.commiter(partage, "agent-01", "write *.js");
    const r = await D.journal(partage, { nombre: 10 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.commits.map((c) => [c.auteur, c.message])).toEqual([["agent-01", "write *.js"], ["agent-02", "write a.js"], ["essaim", "ouverture du run"]]);
    expect(r.commits[0]!.hash).toMatch(/^[0-9a-f]{7,}$/);
    expect(r.commits[0]!.date).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d/);
  });
  test("un chemin : les commits qui le touchent ; *.js ne désigne que lui ; un chemin jamais commité : liste vide", async () => {
    ecrire("a.js", "1");
    await D.commiter(partage, "agent-02", "write a.js");
    ecrire("*.js", "étoile");
    await D.commiter(partage, "agent-01", "write *.js");
    const etoile = await D.journal(partage, { chemin: "*.js", nombre: 10 });
    expect(etoile.ok && etoile.commits.map((c) => c.message)).toEqual(["write *.js"]);
    expect(await D.journal(partage, { chemin: "absent.js", nombre: 10 })).toEqual({ ok: true, commits: [] });
    const un = await D.journal(partage, { nombre: 1 });
    expect(un.ok && un.commits.length).toBe(1);
  });
  test("une panne git (dossier sans .git) est une erreur, pas une liste vide, même sous un dépôt parent", async () => {
    await D.ouvrirDepot(dossier); // runs/ vit dans le dépôt essaim : un partage sans .git ne doit pas lire le parent
    rmSync(join(partage, ".git"), { recursive: true, force: true });
    const r = await D.journal(partage, { nombre: 10 });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.erreur).toBeTruthy();
  });
});

describe("git sous Bun", () => {
  test("passe par Bun.spawn, jamais par node:child_process (EXC_GUARD, 25/09)", async () => {
    const vrai = Bun.spawn;
    let appels = 0;
    (Bun as { spawn: typeof Bun.spawn }).spawn = ((...a: Parameters<typeof Bun.spawn>) => { appels++; return vrai(...a); }) as typeof Bun.spawn;
    try {
      expect((await D.git(partage, ["rev-parse", "--is-inside-work-tree"])).sortie.trim()).toBe("true");
    } finally {
      (Bun as { spawn: typeof Bun.spawn }).spawn = vrai;
    }
    expect(appels).toBe(1);
  });
});

describe("la file du lanceur", () => {
  test("une opération à la fois, dans l'ordre, et une erreur ne bloque pas la suite", async () => {
    const file = new D.FileGit();
    const ordre: string[] = [];
    const op = (n: string, ms: number, echoue = false) => file.mettre(async () => { await new Promise((r) => setTimeout(r, ms)); ordre.push(n); if (echoue) throw new Error(n); return n; });
    const a = op("a", 30), b = op("b", 1, true), c = op("c", 1);
    expect(await a).toBe("a");
    expect(b).rejects.toThrow("b");
    expect(await c).toBe("c");
    await file.vider();
    expect(ordre).toEqual(["a", "b", "c"]);
  });
});

describe("restaurer", () => {
  test("un seul fichier revient à sa version d'avant ; le travail des autres ne bouge pas", async () => {
    ecrire("index.html", "v1\n");
    await D.commiter(partage, "Antoine", "write index.html");
    const v1 = (await dernier()).hash;
    ecrire("index.html", "v2 cassée\n");
    ecrire("moteur.js", "travail de Bernard\n");
    await D.commiter(partage, "Bernard", "bash");
    const r = await D.restaurer(partage, "index.html", v1, "Claude", "la v2 casse la page");
    expect(r).toMatchObject({ ok: true, chemin: "index.html" });
    expect(readFileSync(join(partage, "index.html"), "utf8")).toBe("v1\n");
    expect(readFileSync(join(partage, "moteur.js"), "utf8")).toBe("travail de Bernard\n");
    expect(await dernier()).toMatchObject({ auteur: "Claude", fichiers: ["index.html"], message: `restaurer index.html à ${v1} : la v2 casse la page` });
  });
  test("un dossier parent devenu lien vers l'extérieur : refus, et aucun dossier créé dehors (29/09, revue F19)", async () => {
    mkdirSync(join(partage, "lien", "sous"), { recursive: true });
    ecrire("lien/sous/f.txt", "v1\n");
    await D.commiter(partage, "Antoine", "write");
    const v1 = (await dernier()).hash;
    const dehors = join(dossier, "dehors");
    mkdirSync(dehors);
    rmSync(join(partage, "lien"), { recursive: true });
    symlinkSync(dehors, join(partage, "lien"));
    const r = await D.restaurer(partage, "lien/sous/f.txt", v1, "Claude", "retour");
    expect(r).toMatchObject({ ok: false, raison: "lien/sous/f.txt sort du dossier partagé par un lien. Définitif pour ce chemin" });
    expect(existsSync(join(dehors, "sous"))).toBe(false);
  });
  test("une image revient octet pour octet, et un fichier exécutable garde son mode", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0xfe, 0x80]);
    ecrire("carte.png", png);
    ecrire("lancer.sh", "#!/bin/sh\n");
    Bun.spawnSync(["chmod", "+x", join(partage, "lancer.sh")]);
    await D.commiter(partage, "Antoine", "write");
    const v1 = (await dernier()).hash;
    ecrire("carte.png", "abîmée");
    ecrire("lancer.sh", "abîmé");
    await D.commiter(partage, "Bernard", "bash");
    await D.restaurer(partage, "carte.png", v1, "Claude", "image");
    await D.restaurer(partage, "lancer.sh", v1, "Claude", "script");
    expect(new Uint8Array(readFileSync(join(partage, "carte.png")))).toEqual(png);
    expect(statSync(join(partage, "lancer.sh")).mode & 0o111).not.toBe(0);
  });
  test("refus : commit inconnu, fichier absent à ce commit, chemin hors du dossier, .git, lien symbolique", async () => {
    ecrire("a.js", "a");
    await D.commiter(partage, "Antoine", "write a.js");
    const h = (await dernier()).hash;
    const refus = [
      [await D.restaurer(partage, "a.js", "deadbee", "C", "x"), "commit deadbee inconnu. Définitif pour ce commit"],
      [await D.restaurer(partage, "b.js", h, "C", "x"), `b.js est absent au commit ${h}. Définitif pour ce fichier à ce commit`],
      [await D.restaurer(partage, "../dehors.js", h, "C", "x"), "../dehors.js est hors du dossier partagé. Définitif pour ce chemin"],
      [await D.restaurer(partage, ".git/config", h, "C", "x"), ".git/config est hors du dossier partagé. Définitif pour ce chemin"],
    ] as const;
    rmSync(join(partage, "a.js"));
    symlinkSync(join(dossier, "cible"), join(partage, "a.js"));
    const lien = [await D.restaurer(partage, "a.js", h, "C", "x"), "a.js est un lien symbolique. Se lève quand a.js n'est plus un lien"] as const;
    for (const [r, raison] of [...refus, lien]) {
      expect(r).toEqual({ ok: false, raison });
      expect(raisonAuFormat(raison), raison).toBe(true);
    }
  });
});

describe("essais", () => {
  beforeEach(async () => {
    ecrire("moteur.js", "commun\n");
    ecrire("index.html", "page\n");
    await D.commiter(partage, "Antoine", "write");
  });
  test("ouvrir un essai donne un dossier à part ; le dossier commun reste intact", async () => {
    const d = await D.ouvrirEssai(partage, essais, "moteur-three");
    expect(d).toBe(join(essais, "moteur-three"));
    ecrire("moteur.js", "three\n", d);
    await D.commiter(d, "Bernard", "write moteur.js");
    expect(readFileSync(join(partage, "moteur.js"), "utf8")).toBe("commun\n");
    expect(await statut()).toBe("");
    expect(D.identite(d)).toBeNumber();
    // Les refus sont des D.Refus, à la forme commune ; toute autre erreur est une panne.
    for (const [nom, raison] of [["moteur-three", "l'essai moteur-three existe déjà. Définitif pour ce nom"],
      ["../dehors", "le nom d'essai ../dehors est mal formé. Se lève avec un nom en minuscules, chiffres et tirets, 40 caractères au plus"]]) {
      const e = await D.ouvrirEssai(partage, essais, nom!).catch((x) => x);
      expect(e).toBeInstanceOf(D.Refus);
      expect(e.message).toBe(raison);
      expect(raisonAuFormat(raison!)).toBe(true);
    }
  });
  test("adopter fusionne l'essai dans le dossier commun, au nom de l'agent", async () => {
    const d = await D.ouvrirEssai(partage, essais, "moteur-three");
    ecrire("moteur.js", "three\n", d);
    ecrire("nouveau.js", "n\n", d); // pas encore commité : adopter le commite d'abord
    const r = await D.adopter(partage, essais, "moteur-three", "Bernard");
    expect(r).toMatchObject({ ok: true, fichiers: ["moteur.js", "nouveau.js"] });
    expect((r as { blobs: T.FichierCommit[] }).blobs.map((f) => f.chemin)).toEqual(["moteur.js", "nouveau.js"]);
    expect(readFileSync(join(partage, "moteur.js"), "utf8")).toBe("three\n");
    expect(await dernier()).toMatchObject({ auteur: "Bernard", message: "adopter l'essai moteur-three" });
    expect(await D.bilanCommits(partage)).toEqual({ total: 2, parAgent: { Antoine: 1, Bernard: 1 }, adoptions: { Bernard: 1 } });
  });
  test("adoption refusée sur conflit : les fichiers sont nommés et rien n'est touché", async () => {
    const d = await D.ouvrirEssai(partage, essais, "moteur-three");
    ecrire("moteur.js", "three\n", d);
    await D.commiter(d, "Bernard", "write moteur.js");
    ecrire("moteur.js", "babylon\n");
    await D.commiter(partage, "Claude", "write moteur.js");
    const avant = (await dernier()).hash;
    const r = await D.adopter(partage, essais, "moteur-three", "Bernard");
    expect(r).toEqual({ ok: false, raison: "conflit sur moteur.js, le dossier commun n'a pas bougé. Se lève quand l'essai ne contredit plus ces lignes", conflits: ["moteur.js"] });
    expect(raisonAuFormat((r as { raison: string }).raison)).toBe(true);
    expect(readFileSync(join(partage, "moteur.js"), "utf8")).toBe("babylon\n");
    expect((await dernier()).hash).toBe(avant);
    expect(await statut()).toBe("");
  });
  test("adoption refusée quand le dossier commun n'est pas sur main", async () => {
    const d = await D.ouvrirEssai(partage, essais, "x");
    ecrire("moteur.js", "x\n", d);
    await D.git(partage, ["checkout", "-q", "-b", "autre"]);
    expect(await D.adopter(partage, essais, "x", "Bernard")).toEqual({ ok: false, raison: "le dossier commun n'est pas sur main (autre). Se lève quand il revient sur main" });
  });
  test("un essai abandonné reste dans l'historique ; un essai vide ou inconnu ne s'adopte pas", async () => {
    await D.ouvrirEssai(partage, essais, "piste-morte");
    rmSync(join(essais, "piste-morte"), { recursive: true });
    expect((await D.git(partage, ["branch", "--list", "essai/*"])).sortie).toContain("essai/piste-morte");
    expect(await D.adopter(partage, essais, "rien", "Bernard")).toEqual({ ok: false, raison: "aucun essai rien. Se lève après depot_essai de ce nom" });
    expect(await D.adopter(partage, essais, "piste-morte", "Bernard")).toEqual({ ok: false, raison: "l'essai piste-morte ne change aucun fichier du dossier commun. Se lève quand l'essai change un fichier" });
  });
  test("contenuDans : un commit du dossier commun oui, un commit d'essai non adopté non", async () => {
    const d = await D.ouvrirEssai(partage, essais, "x");
    ecrire("moteur.js", "x\n", d);
    const essai = (await D.commiter(d, "Bernard", "write"))?.hash;
    const commun = (await dernier()).hash;
    expect(await D.contenuDans(partage, commun)).toMatchObject({ hash: expect.stringMatching(/^[0-9a-f]{40}$/) });
    expect(await D.contenuDans(partage, essai!)).toEqual({ raison: `le commit ${essai} est hors du dossier commun. Se lève quand le commit est dans le dossier commun` });
    expect(await D.contenuDans(partage, "deadbee")).toEqual({ raison: "commit deadbee inconnu. Se lève quand le commit est dans le dossier commun" });
  });
});

describe("les demandes servies : refus à la forme commune, pannes à part (G6)", () => {
  const demande = (action: string, args: Record<string, unknown>) => ({ id: 1, agent: "Bernard", action, args });
  test("un refus garde sa raison sans panne ; une erreur imprévue, une demande inconnue sont des pannes", async () => {
    const t = ouvrirBun(join(dossier, "tableau.sqlite"));
    T.initialiser(t);
    const surs: D.Surs = new Map([[partage, D.identite(partage)!]]);
    const mal = await D.servirDemande(t, dossier, surs, demande("essai", { nom: "Mal Formé", raison: "r" }));
    expect(mal.ok).toBe(false);
    expect(mal.panne).toBeUndefined();
    expect(raisonAuFormat(mal.raison!)).toBe(true);
    mkdirSync(essais, { recursive: true });
    writeFileSync(join(essais, "bloque"), "un fichier à la place du dossier de l'essai");
    expect(await D.servirDemande(t, dossier, surs, demande("essai", { nom: "bloque", raison: "r" }))).toMatchObject({ ok: false, panne: true });
    expect(await D.servirDemande(t, dossier, surs, demande("effacer", {}))).toMatchObject({ ok: false, panne: true });
    await D.servirDemande(t, dossier, surs, demande("essai", { nom: "x", raison: "r" }));
    surs.set(join(essais, "x"), -1);
    expect(await D.servirDemande(t, dossier, surs, demande("adopter", { nom: "x" }))).toEqual({ ok: false, raison: "le dossier de l'essai x a été remplacé. Définitif pour cet essai" });
    surs.set(partage, -1);
    expect(await D.servirDemande(t, dossier, surs, demande("restaurer", { chemin: "a.js", commit: "HEAD", raison: "r" }))).toEqual({ ok: false, raison: "le dépôt du run a disparu ou a été remplacé. Définitif pour ce run" });
    t.fermer();
  });
  test("adopter sur des changements pas encore commités du dossier commun : refusé, levé quand la salle les a commités", async () => {
    ecrire("moteur.js", "commun\n");
    await D.commiter(partage, "Antoine", "write");
    const d = await D.ouvrirEssai(partage, essais, "x");
    ecrire("moteur.js", "three\n", d);
    ecrire("moteur.js", "en cours d'écriture\n"); // pas encore commité par le lanceur
    const r = await D.adopter(partage, essais, "x", "Bernard");
    expect(r.ok).toBe(false);
    const raison = (r as { raison: string }).raison;
    expect(raison.split("\n")[0]).toBe("le dossier commun a des changements pas encore commités sur ces fichiers. Se lève quand la salle les a commités, en quelques secondes");
    expect(raisonAuFormat(raison)).toBe(true);
  });
});

describe("le texte d'un fait ecriture (faitEcriture)", () => {
  const c = (chemins: [string, string | null][]) => ({ hash: "3f2a1bc", message: "write", fichiers: chemins.map(([chemin, blob]) => ({ chemin, blob })) });
  test("fichiers, auteur, commit ; bash attribué au mieux ; essai nommé ; suppression dite ; au-delà de cinq fichiers, le compte", () => {
    expect(D.faitEcriture(c([["app.js", "a"], ["style.css", "b"]]), "Antoine", "partage", "write")).toEqual({
      type: "ecriture", agent: "Antoine", source: "lanceur", sujet: "app.js, style.css", texte: "écrit · app.js, style.css · Antoine · commit 3f2a1bc",
      details: { hash: "3f2a1bc", message: "write", fichiers: [{ chemin: "app.js", blob: "a" }, { chemin: "style.css", blob: "b" }], racine: "partage", outil: "write" },
    });
    expect(D.faitEcriture(c([["a.js", "a"]]), "Bernard", "partage", "bash").texte).toBe("écrit · a.js · Bernard · commit 3f2a1bc · par bash, attribué au mieux");
    expect(D.faitEcriture(c([["a.js", "a"], ["vieux.js", null]]), "Bernard", "essai:menu-2", "write").texte).toBe("écrit · a.js, vieux.js (supprimé) · Bernard · commit 3f2a1bc · essai menu-2");
    const sept = c(["1", "2", "3", "4", "5", "6", "7"].map((n) => [`${n}.js`, n]));
    expect(D.faitEcriture(sept, "essaim", "partage", "fin du run").texte).toBe("écrit · 1.js, 2.js, 3.js, 4.js, 5.js + 2 autres · essaim · commit 3f2a1bc");
    expect(D.faitEcriture(sept, "essaim", "partage", "fin du run").details!.fichiers).toHaveLength(7);
  });
  test("le commit « avant adoption » fait dans l'essai donne un fait ecriture de l'essai", async () => {
    ecrire("moteur.js", "commun\n");
    await D.commiter(partage, "Antoine", "write");
    const t = ouvrirBun(join(dossier, "tableau.sqlite"));
    T.initialiser(t);
    const surs: D.Surs = new Map([[partage, D.identite(partage)!]]);
    await D.servirDemande(t, dossier, surs, { id: 1, agent: "Bernard", action: "essai", args: { nom: "x", raison: "r" } });
    ecrire("moteur.js", "three\n", join(essais, "x")); // pas encore commité : l'adoption le commite d'abord
    await D.servirDemande(t, dossier, surs, { id: 2, agent: "Claude", action: "adopter", args: { nom: "x" } });
    const f = t.all<{ agent: string; texte: string; details_json: string }>("SELECT agent, texte, details_json FROM faits WHERE type = 'ecriture'");
    expect(f).toHaveLength(1);
    const avant = (await D.historique(join(essais, "x"), { limite: 1, branche: "essai/x" }))[0]!;
    expect(avant.message).toBe("avant adoption de l'essai x");
    expect(f[0]!.texte).toBe(`écrit · moteur.js · Claude · commit ${avant.hash} · essai x`);
    expect(JSON.parse(f[0]!.details_json)).toMatchObject({ racine: "essai:x", outil: "depot_adopter", message: "avant adoption de l'essai x" });
    t.fermer();
  });
});

// Qui peut adopter se lit sur ce que l'adoption changerait, commité ou pas encore (l'adoption le commite d'abord).
test("fichiersDeLEssai : les commits de l'essai depuis son départ, et ce qui n'y est pas encore commité", async () => {
  ecrire("a.ts", "commun\n");
  await D.commiter(partage, "Antoine", "write");
  const x = await D.ouvrirEssai(partage, essais, "x");
  expect(await D.fichiersDeLEssai(partage, essais, "x")).toEqual([]);
  ecrire("a.ts", "corrigé\n", x);
  await D.commiter(x, "Bernard", "write");
  ecrire("b.ts", "commun\n"); // le dossier commun bouge : rien de l'essai
  await D.commiter(partage, "Antoine", "write");
  mkdirSync(join(x, "src"));
  ecrire("src/neuf.ts", "neuf\n", x); // pas encore commité
  expect((await D.fichiersDeLEssai(partage, essais, "x")).sort()).toEqual(["a.ts", "src/neuf.ts"]);
  expect(await D.fichiersDeLEssai(partage, essais, "inconnu")).toEqual([]);
  expect(await D.fichiersDeLEssai(partage, essais, "../x")).toEqual([]);
});

describe("faits essai, adoption et restauration : un par demande servie, avec blobs (M2)", () => {
  const hashObjet = (f: string) => Bun.spawnSync(["git", "hash-object", join(partage, f)]).stdout.toString().trim();
  let t: T.Tableau, surs: D.Surs, n = 0;
  const servir = (agent: string, action: string, args: Record<string, unknown>) => D.servirDemande(t, dossier, surs, { id: ++n, agent, action, args });
  const faits = () => t.all<{ type: string; agent: string; source: string; sujet: string | null; texte: string; details_json: string | null }>("SELECT type, agent, source, sujet, texte, details_json FROM faits ORDER BY id")
    .map(({ details_json, ...f }) => ({ ...f, details: details_json ? JSON.parse(details_json) : null }));
  beforeEach(async () => {
    t = ouvrirBun(join(dossier, "tableau.sqlite"));
    T.initialiser(t);
    surs = new Map([[partage, D.identite(partage)!]]);
    ecrire("app.js", "v1\n");
    ecrire("index.html", "page\n");
    await D.commiter(partage, "Antoine", "write");
  });
  afterEach(() => t.fermer());
  test("essai ouvert : la raison citée, déclarée par l'agent ; adopté : commit, fichiers et blobs, aucun fait ecriture en plus", async () => {
    await servir("Claude", "essai", { nom: "menu-2", raison: "un menu plus court" });
    const d = join(essais, "menu-2");
    ecrire("app.js", "v2\n", d);
    ecrire("nouveau.js", "n\n", d);
    await D.commiter(d, "Claude", "write"); // commité par le lanceur à la fin du write : rien ne reste pour « avant adoption »
    const r = await servir("Claude", "adopter", { nom: "menu-2" });
    expect(r.ok).toBe(true);
    const f = faits();
    expect(f.map((x) => x.texte)).toEqual([
      "essai menu-2 ouvert · Claude · « un menu plus court » déclarée par Claude",
      `essai menu-2 adopté · Claude · commit ${r.hash} · app.js, nouveau.js`,
    ]);
    expect(f.map((x) => [x.type, x.agent, x.source, x.sujet])).toEqual([["essai", "Claude", "lanceur", "menu-2"], ["essai", "Claude", "lanceur", "menu-2"]]);
    expect(f[1]!.details).toEqual({ hash: r.hash, message: "adopter l'essai menu-2", fichiers: [{ chemin: "app.js", blob: hashObjet("app.js") }, { chemin: "nouveau.js", blob: hashObjet("nouveau.js") }], racine: "partage" });
    expect(T.essais(t)[0]).toMatchObject({ adopte_par: "Claude", adopte_hash: r.hash });
  });
  test("restauré : fichier, commit d'origine, nouveau commit, blob et raison déclarée ; déjà identique : ni commit ni fait", async () => {
    const v1 = (await dernier()).hash;
    ecrire("app.js", "v2 cassée\n");
    await D.commiter(partage, "Bernard", "write");
    const r = await servir("Antoine", "restaurer", { chemin: "app.js", commit: v1, raison: "la v2 casse la page" });
    expect(r.ok).toBe(true);
    expect(r.hash).toMatch(/^[0-9a-f]{7,}$/);
    const f = faits();
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ type: "restauration", agent: "Antoine", source: "lanceur", sujet: "app.js",
      texte: `restauré · app.js à ${v1.slice(0, 7)} · Antoine · commit ${r.hash} · « la v2 casse la page » déclarée par Antoine` });
    expect(f[0]!.details).toEqual({ hash: r.hash, message: `restaurer app.js à ${v1.slice(0, 7)} : la v2 casse la page`, fichiers: [{ chemin: "app.js", blob: hashObjet("app.js") }], racine: "partage", depuis: v1.slice(0, 7) });
    expect(await servir("Antoine", "restaurer", { chemin: "app.js", commit: v1, raison: "encore" })).toMatchObject({ ok: true, hash: undefined });
    expect(faits()).toHaveLength(1);
  });
  test("une raison de plus de 300 caractères est coupée sur sa suite par le numéro du fait, gardée entière dans details", async () => {
    const longue = "é".repeat(301);
    await servir("Claude", "essai", { nom: "long", raison: longue });
    const f = t.get<{ id: number; texte: string; details_json: string }>("SELECT id, texte, details_json FROM faits")!;
    expect(f.texte).toBe(`essai long ouvert · Claude · « ${"é".repeat(300)}… (suite : salle_chercher(type: "fait", numero: ${f.id})) » déclarée par Claude`);
    expect(JSON.parse(f.details_json).citation).toBe(longue);
  });
  test("un refus, un essai sans raison, une adoption refusée : pas de fait de trop", async () => {
    await servir("Claude", "essai", { nom: "Mal Formé", raison: "r" });
    expect(faits()).toEqual([]);
    await servir("Claude", "essai", { nom: "vide", raison: "" });
    expect(faits().map((x) => x.texte)).toEqual(["essai vide ouvert · Claude"]);
    await servir("Claude", "adopter", { nom: "vide" }); // l'essai ne change rien : refusé
    expect(faits()).toHaveLength(1);
  });
  test("noterEssai et noterAdoption écrivent leur fait dans leur transaction : un nom déjà pris n'en laisse aucun", () => {
    T.noterEssai(t, "x", "Claude", "r", "/d");
    expect(() => T.noterEssai(t, "x", "Bernard", "r", "/d")).toThrow();
    expect(faits()).toHaveLength(1);
    T.noterAdoption(t, "inconnu", "Claude", "abc1234", []); // aucune ligne changée : aucun fait
    expect(faits()).toHaveLength(1);
  });
});

describe("ce qu'un outil commite", () => {
  const run = () => dossier;
  const bureau = () => join(dossier, "agents", "Antoine");
  test("write : son fichier, chemin absolu ou relatif au bureau ; rien hors du dépôt ni dans .git", () => {
    expect(D.aCommiter(run(), bureau(), "write", { path: join(partage, "a.js") })).toEqual([{ racine: partage, message: "write a.js", chemins: ["a.js"] }]);
    expect(D.aCommiter(run(), bureau(), "edit", { path: "../../partage/sous/b.js" })).toEqual([{ racine: partage, message: "edit sous/b.js", chemins: ["sous/b.js"] }]);
    expect(D.aCommiter(run(), bureau(), "write", { path: "notes.md" })).toEqual([]);
    expect(D.aCommiter(run(), bureau(), "write", { path: join(partage, ".git", "config") })).toEqual([]);
    expect(D.aCommiter(run(), bureau(), "write", { path: join(essais, "x", "m.js") })).toEqual([{ racine: join(essais, "x"), message: "write m.js", chemins: ["m.js"] }]);
  });
  test("voir : sa seule capture ; bash : tout sauf les écritures en cours ; les autres outils rien", async () => {
    expect(D.aCommiter(run(), bureau(), "page_voir", { page: "index.html", capture: "ecran" })).toEqual([{ racine: partage, message: "page_voir : capture ecran.png", chemins: ["ecran.png"] }]);
    expect(D.aCommiter(run(), bureau(), "page_voir", { page: "index.html" })).toEqual([]);
    const x = await D.ouvrirEssai(partage, essais, "x");
    mkdirSync(join(essais, "fabrique-par-un-agent", ".git"), { recursive: true });
    expect(D.aCommiter(run(), bureau(), "bash", { command: "echo a > a.js" }, [join(partage, "b.js")], [x])).toEqual([
      { racine: partage, message: "bash : echo a > a.js", sauf: ["b.js"] },
      { racine: join(essais, "x"), message: "bash : echo a > a.js", sauf: [] },
    ]);
    expect(D.aCommiter(run(), bureau(), "salle_poster", { texte: "x" })).toEqual([]);
  });
  test("page_assembler : sa page de sortie (index.html par défaut), au nom de l'agent (R14)", () => {
    expect(D.aCommiter(run(), bureau(), "page_assembler", { source: "src/page.html" })).toEqual([{ racine: partage, message: "page_assembler : index.html", chemins: ["index.html"] }]);
    expect(D.aCommiter(run(), bureau(), "page_assembler", { source: "src/page.html", sortie: "jeu/sortie.html" })).toEqual([{ racine: partage, message: "page_assembler : jeu/sortie.html", chemins: ["jeu/sortie.html"] }]);
    expect(D.aCommiter(run(), bureau(), "page_assembler", { source: "a.html", sortie: join(partage, "b.html") })).toEqual([{ racine: partage, message: "page_assembler : b.html", chemins: ["b.html"] }]);
    expect(D.aCommiter(run(), bureau(), "page_assembler", { source: "a.html", sortie: "../dehors.html" })).toEqual([]);
  });
  test("page_voir avec tailles : la planche est commitée, avec la capture dans le même engagement (Q2, G13, T8)", () => {
    expect(D.aCommiter(run(), bureau(), "page_voir", { page: "index.html", tailles: [] })).toEqual([{ racine: partage, message: "page_voir : planche tailles.png", chemins: ["tailles.png"] }]);
    expect(D.aCommiter(run(), bureau(), "page_voir", { page: "index.html", capture: "ecran", tailles: ["390x844"] })).toEqual([{ racine: partage, message: "page_voir : capture ecran.png, planche ecran-tailles.png", chemins: ["ecran.png", "ecran-tailles.png"] }]);
    expect(D.aCommiter(run(), bureau(), "page_voir", { page: "index.html", capture: "vue.PNG", tailles: [] })).toEqual([{ racine: partage, message: "page_voir : capture vue.PNG, planche vue-tailles.png", chemins: ["vue.PNG", "vue-tailles.png"] }]);
    expect(D.aCommiter(run(), bureau(), "page_voir", { page: join(essais, "x", "index.html"), tailles: [] })).toEqual([{ racine: join(essais, "x"), message: "page_voir : planche tailles.png", chemins: ["tailles.png"] }]);
    expect(nomPlanche()).toBe("tailles.png");
    expect(nomPlanche("ecran.png")).toBe("ecran-tailles.png");
  });
});
