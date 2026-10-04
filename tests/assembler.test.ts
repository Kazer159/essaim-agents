import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assembler } from "../src/assembler.ts";
import { cheminNavigateur } from "../src/voir.ts";

const racine = resolve(import.meta.dir, "..");
const present = cheminNavigateur() !== undefined;

function dossier() {
  const p = mkdtempSync(join(tmpdir(), "essaim-assembler-test-"));
  mkdirSync(join(p, "src"));
  writeFileSync(join(p, "src", "sim.js"), "export const habitants = (niveau) => [0, 4, 12, 30][niveau];\n");
  writeFileSync(join(p, "src", "app.js"), 'import { habitants } from "./sim.js";\ndocument.getElementById("r").textContent = "niveau 3 : " + habitants(3) + " habitants </script> compris";\n');
  writeFileSync(join(p, "src", "page.html"), '<!doctype html><title>Sorlac</title><link rel="stylesheet" href="../style.css"><p id="r">rien</p><script type="module" src="app.js"></script>');
  writeFileSync(join(p, "style.css"), "p { color: #123 }");
  return p;
}

describe("assembler (25/09)", () => {
  test("des modules qui s'importent deviennent un seul script classique collé dans la page", () => {
    const p = dossier();
    const r = assembler(p, "src/page.html", "index.html");
    expect(r.code).toBe(0);
    expect(r.texte).toContain("page_assembler : index.html écrit depuis src/page.html");
    const html = readFileSync(join(p, "index.html"), "utf8");
    expect(html).not.toContain('type="module"');
    expect(html).not.toMatch(/\bimport\s*\{/);
    expect(html).toContain("<\\/script> compris"); // la chaîne ne ferme pas la balise
    expect(html).toContain('href="../style.css"'); // le reste de la page est intact
    rmSync(p, { recursive: true, force: true });
  });
  test.skipIf(!present)("la page assemblée s'ouvre en file:// et le code tourne", () => {
    const p = dossier();
    writeFileSync(join(p, "src", "page.html"), '<!doctype html><title>Sorlac</title><p id="r">rien</p><script type="module" src="app.js"></script>');
    expect(assembler(p, "src/page.html", "index.html").code).toBe(0);
    const v = Bun.spawnSync(["node", join(racine, "src", "voir.ts"), "--partage", p, "index.html"], { stdout: "pipe", stderr: "pipe" });
    expect(v.stdout.toString()).toContain("page_voir : 0 page saine");
    expect(v.stdout.toString()).toContain("niveau 3 : 30 habitants");
    rmSync(p, { recursive: true, force: true });
  }, 30_000);
  const voirTexte = (p: string, page: string) => Bun.spawnSync(["node", join(racine, "src", "voir.ts"), "--partage", p, page], { stdout: "pipe", stderr: "pipe" }).stdout.toString();
  test.skipIf(!present)("un module placé dans <head> tourne après la lecture de la page, comme dans la source (29/09, revue N8)", () => {
    const p = dossier();
    writeFileSync(join(p, "src", "page.html"), '<!doctype html><head><title>Sorlac</title><script type="module" src="app.js"></script></head><body><p id="r">rien</p></body>');
    expect(assembler(p, "src/page.html", "src/sortie.html").code).toBe(0);
    expect(voirTexte(p, "src/sortie.html")).toContain("niveau 3 : 30 habitants");
    rmSync(p, { recursive: true, force: true });
  }, 30_000);
  test.skipIf(!present)("deux entrées qui partagent un module partagent son état, comme dans la source (29/09, revue N9)", () => {
    const p = dossier();
    writeFileSync(join(p, "src", "etat.js"), "export const etat = { n: 0 };\n");
    writeFileSync(join(p, "src", "a.js"), 'import { etat } from "./etat.js";\netat.n = 42;\n');
    writeFileSync(join(p, "src", "b.js"), 'import { etat } from "./etat.js";\ndocument.getElementById("r").textContent = "etat.n=" + etat.n;\n');
    writeFileSync(join(p, "src", "page.html"), '<!doctype html><p id="r">rien</p><script type="module" src="a.js"></script><script type="module" src="b.js"></script>');
    expect(assembler(p, "src/page.html", "src/sortie.html").code).toBe(0);
    expect(voirTexte(p, "src/sortie.html")).toContain("etat.n=42");
    rmSync(p, { recursive: true, force: true });
  }, 30_000);
  test("une sortie dans un autre dossier que la source garde ses liens relatifs : <base> vers le dossier de la source (29/09, revue N10)", () => {
    const p = dossier();
    expect(assembler(p, "src/page.html", "index.html").code).toBe(0);
    expect(readFileSync(join(p, "index.html"), "utf8")).toContain('<base href="src/">');
    expect(assembler(p, "src/page.html", "src/sortie.html").code).toBe(0);
    expect(readFileSync(join(p, "src", "sortie.html"), "utf8")).not.toContain("<base");
    rmSync(p, { recursive: true, force: true });
  });
  test("les refus : même page, hors du dossier, rien à rassembler, import cassé", () => {
    const p = dossier();
    expect(assembler(p, "src/page.html", "src/page.html")).toEqual({ code: 1, invalide: true, texte: "la page de sortie est la page source. Se lève avec une sortie différente" });
    expect(assembler(p, "../ailleurs.html")).toEqual({ code: 1, invalide: true, texte: "la page source ou la page de sortie est hors du dossier partagé. Définitif pour ces chemins" });
    expect(assembler(p, "absente.html")).toEqual({ code: 1, invalide: true, texte: "absente.html est introuvable dans le dossier partagé. Se lève quand le fichier existe" });
    writeFileSync(join(p, "vide.html"), "<p>rien</p>");
    expect(assembler(p, "vide.html")).toEqual({ code: 1, invalide: true, texte: 'vide.html ne contient aucun <script type="module" src="…">. Se lève quand la page en contient un' });
    writeFileSync(join(p, "dehors.html"), '<script type="module" src="../../ailleurs.js"></script>');
    expect(assembler(p, "dehors.html").texte).toBe("le script ../../ailleurs.js est hors du dossier partagé. Définitif pour ce chemin");
    writeFileSync(join(p, "trou.html"), '<script type="module" src="absent.js"></script>');
    expect(assembler(p, "trou.html").texte).toBe("le script absent.js est introuvable. Se lève quand le fichier existe");
    writeFileSync(join(p, "src", "app.js"), 'import { absent } from "./nulle-part.js";\nabsent();\n');
    const r = assembler(p, "src/page.html");
    expect(r).toMatchObject({ code: 1, invalide: true });
    expect(r.texte.split("\n")[0]).toBe("le script app.js ne se rassemble pas. Se lève quand le script se rassemble");
    expect(r.texte).toContain("nulle-part");
    rmSync(p, { recursive: true, force: true });
  });
});
