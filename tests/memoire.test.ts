// Le second cerveau de la salle : src/memoire.ts.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as M from "../src/memoire.ts";

// ---- Empreintes et statuts

const hashObject = (chemin: string) => spawnSync("git", ["hash-object", chemin], { encoding: "utf8" }).stdout.trim();

describe("empreintes en blob git (M3)", () => {
  let d: string;
  beforeEach(() => { d = mkdtempSync(join(tmpdir(), "essaim-empreintes-")); });
  afterEach(() => rmSync(d, { recursive: true, force: true }));

  test("blobGit égale git hash-object : fichier vide, binaire, UTF-8", () => {
    const cas: Array<[string, Uint8Array | string]> = [["vide", ""], ["binaire", new Uint8Array([0, 255, 1, 128, 0, 10, 13])], ["utf8", "élève · 🐝 « navigation.js »\n"]];
    for (const [nom, contenu] of cas) {
      writeFileSync(join(d, nom), contenu);
      const octets = typeof contenu === "string" ? new TextEncoder().encode(contenu) : contenu;
      expect(M.blobGit(octets)).toBe(hashObject(join(d, nom)));
    }
  });

  test("empreintes parcourt les fichiers ordinaires hors .git et node_modules, sans suivre les liens", () => {
    mkdirSync(join(d, "src", "sous"), { recursive: true });
    mkdirSync(join(d, ".git"));
    mkdirSync(join(d, "node_modules", "x"), { recursive: true });
    writeFileSync(join(d, "index.html"), "<p>x</p>");
    writeFileSync(join(d, "src", "sous", "app.js"), "let a = 1;\n");
    writeFileSync(join(d, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(d, "node_modules", "x", "i.js"), "x");
    symlinkSync(join(d, "index.html"), join(d, "lien.html"));
    mkdirSync(join(d, "ailleurs"));
    symlinkSync(join(d, "src"), join(d, "ailleurs", "src-lien"));
    const e = M.empreintes(d);
    expect([...e.keys()].sort()).toEqual(["index.html", "src/sous/app.js"]);
    const app = e.get("src/sous/app.js")!;
    expect(app.blob).toBe(hashObject(join(d, "src", "sous", "app.js")));
    expect(app.taille).toBe(11);
    expect(typeof app.mtimeMs).toBe("number");
  });

  test("empreintes d'une liste de fichiers : ceux qui existent seulement, liens exclus", () => {
    writeFileSync(join(d, "a.js"), "a");
    writeFileSync(join(d, "b.js"), "b");
    symlinkSync(join(d, "a.js"), join(d, "l.js"));
    const e = M.empreintes(d, ["a.js", "absent.js", "l.js"]);
    expect([...e.keys()]).toEqual(["a.js"]);
  });

  test("le cache ne relit pas un fichier dont chemin, taille et date sont inchangés", () => {
    const f = join(d, "app.js");
    writeFileSync(f, "aaaa");
    utimesSync(f, 1_000_000, 1_000_000);
    const cache: M.Cache = new Map();
    const premier = M.empreintes(d, undefined, cache).get("app.js")!;
    // Même taille, même date, contenu différent : avec le cache, le blob d'avant (le fichier n'a pas été relu).
    writeFileSync(f, "bbbb");
    utimesSync(f, 1_000_000, 1_000_000);
    expect(M.empreintes(d, undefined, cache).get("app.js")!.blob).toBe(premier.blob);
    expect(M.empreintes(d).get("app.js")!.blob).toBe(hashObject(f));
    // La date change : relu.
    utimesSync(f, 1_000_001, 1_000_001);
    expect(M.empreintes(d, undefined, cache).get("app.js")!.blob).toBe(hashObject(f));
  });
});

describe("empreintes : un dépôt imbriqué n'est pas parcouru, comme commiter ne le commite pas (29/09, revue M3)", () => {
  test("app/.git : app/main.js n'y est pas", () => {
    const d = mkdtempSync(join(tmpdir(), "essaim-empr-"));
    mkdirSync(join(d, "app", ".git"), { recursive: true });
    writeFileSync(join(d, "app", "main.js"), "x");
    writeFileSync(join(d, "index.html"), "<p>");
    expect([...M.empreintes(d).keys()]).toEqual(["index.html"]);
    rmSync(d, { recursive: true, force: true });
  });
});

describe("statutVerification (M3)", () => {
  const e = (blob: string, mtimeMs = 1): M.Empreinte => ({ blob, taille: 1, mtimeMs });
  const carte = (o: Record<string, M.Empreinte>) => new Map(Object.entries(o));
  const avant = carte({ "a.js": e("1"), "b.js": e("2"), "autre.js": e("3") });

  test("inchangé → verifie ; échec lu → echoue", () => {
    expect(M.statutVerification(avant, carte({ "a.js": e("1"), "b.js": e("2") }), ["a.js", "b.js"], "succes")).toEqual({ statut: "verifie", changes: [] });
    expect(M.statutVerification(avant, carte({ "a.js": e("1"), "b.js": e("2") }), ["a.js", "b.js"], "echec")).toEqual({ statut: "echoue", changes: [] });
  });
  test("contenu changé → inconnu, même sur un échec ; un fichier hors des contrôlés ne compte pas", () => {
    const apres = carte({ "a.js": e("9"), "b.js": e("2"), "autre.js": e("7") });
    expect(M.statutVerification(avant, apres, ["a.js", "b.js"], "echec")).toEqual({ statut: "inconnu", changes: ["a.js"] });
    expect(M.statutVerification(avant, apres, ["b.js"], "succes")).toEqual({ statut: "verifie", changes: [] });
  });
  test("fichier créé ou supprimé pendant le contrôle → inconnu", () => {
    expect(M.statutVerification(avant, carte({ "a.js": e("1") }), ["a.js", "b.js"], "succes")).toEqual({ statut: "inconnu", changes: ["b.js"] });
    expect(M.statutVerification(avant, carte({ "a.js": e("1"), "n.js": e("4") }), ["a.js", "n.js"], "succes")).toEqual({ statut: "inconnu", changes: ["n.js"] });
  });
  test("même contenu, date changée → instable", () => {
    expect(M.statutVerification(avant, carte({ "a.js": e("1", 2), "b.js": e("2") }), ["a.js", "b.js"], "succes")).toEqual({ statut: "instable", changes: ["a.js"] });
  });
  test("un fichier contrôlé absent des deux relevés (un lien, une ressource manquante) → inconnu, pas vérifié (29/09, revue M1)", () => {
    expect(M.statutVerification(new Map(), new Map(), ["index.html"], "succes").statut).toBe("inconnu");
  });
  test("résultat illisible → inconnu", () => {
    expect(M.statutVerification(avant, carte({ "a.js": e("1"), "b.js": e("2") }), ["a.js", "b.js"], "illisible")).toEqual({ statut: "inconnu", changes: [] });
  });
});

describe("tete : le HEAD du dépôt, lu sans git (détail d'une vérification)", () => {
  test("dépôt, worktree, dossier sans dépôt", () => {
    const d = mkdtempSync(join(tmpdir(), "essaim-tete-"));
    const g = (cwd: string, ...a: string[]) => spawnSync("git", a, { cwd, encoding: "utf8" }).stdout.trim();
    const depot = join(d, "partage");
    mkdirSync(depot);
    g(depot, "init", "-q", "-b", "main");
    writeFileSync(join(depot, "a"), "a");
    g(depot, "add", "a");
    g(depot, "-c", "user.name=x", "-c", "user.email=x@x", "commit", "-qm", "un");
    expect(M.tete(depot)).toBe(g(depot, "rev-parse", "HEAD").slice(0, 7));
    g(depot, "pack-refs", "--all");
    expect(M.tete(depot)).toBe(g(depot, "rev-parse", "HEAD").slice(0, 7));
    g(depot, "worktree", "add", "-q", "-b", "essai/x", join(d, "essai-x"));
    expect(M.tete(join(d, "essai-x"))).toBe(g(join(d, "essai-x"), "rev-parse", "HEAD").slice(0, 7));
    expect(M.tete(d)).toBeUndefined();
    rmSync(d, { recursive: true, force: true });
  });
});

describe("le bilan de tests en fait (M4, M6, R2)", () => {
  test("resultatDuBilan : échec lu, succès lu (fail = 0 et Ran, sans errors), sinon illisible", () => {
    expect(M.resultatDuBilan({ fail: 0, ran: 71 })).toBe("succes");
    expect(M.resultatDuBilan({ pass: 0, fail: 0, ran: 0 })).toBe("illisible"); // aucun test lancé ne prouve rien
    expect(M.resultatDuBilan({ pass: 3, fail: 0, ran: 3 })).toBe("succes");
    expect(M.resultatDuBilan({ fail: 2, ran: 5 })).toBe("echec");
    expect(M.resultatDuBilan({ fail: 0, error: 1, ran: 5 })).toBe("echec");
    expect(M.resultatDuBilan({ error: 1 })).toBe("echec");
    expect(M.resultatDuBilan({ fail: 0 })).toBe("illisible"); // | head : Ran manque
    expect(M.resultatDuBilan({ pass: 5 })).toBe("illisible");
    expect(M.resultatDuBilan({})).toBe("illisible");
  });
  test("chiffresBilan : les chiffres lus, rien d'inventé", () => {
    expect(M.chiffresBilan({ fail: 0, ran: 71 })).toBe("71 tests lancés, 0 échoué");
    expect(M.chiffresBilan({ pass: 29, fail: 17, ran: 46 })).toBe("29 réussis, 17 échoués");
    expect(M.chiffresBilan({ pass: 1, fail: 0, error: 2, ran: 1 })).toBe("1 réussi, 0 échoué, 2 erreurs");
    expect(M.chiffresBilan({ ran: 1 })).toBe("1 test lancé");
    expect(M.chiffresBilan({})).toBe("bilan non lu");
  });
});
