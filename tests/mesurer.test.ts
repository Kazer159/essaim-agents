import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cheminNavigateur } from "../src/voir.ts";

// Sous Node, comme pi charge l'extension : on passe par un petit script.
const racine = resolve(import.meta.dir, "..");
const present = cheminNavigateur() !== undefined;
const node = (code: string) => {
  const p = Bun.spawnSync(["node", "--input-type=module", "-e", code], { cwd: racine, stdout: "pipe", stderr: "pipe" });
  return p.stdout.toString() + p.stderr.toString();
};

describe("mesurer et comparer (25/09)", () => {
  test.skipIf(!present)("mesurer : temps d'affichage, images par seconde, poids, rendu, erreurs", () => {
    const d = mkdtempSync(join(tmpdir(), "essaim-mesurer-"));
    writeFileSync(join(d, "index.html"), '<!doctype html><meta charset="utf-8"><title>M</title><p>bonjour</p><script src="lourd.js"></script>');
    writeFileSync(join(d, "lourd.js"), "// " + "x".repeat(50_000) + "\nconsole.error('aïe');\n");
    const out = node(`import { mesurer } from "./src/mesurer.ts"; const r = await mesurer(${JSON.stringify(d)}, "index.html", 1); console.log(r.code); console.log(r.texte);`);
    expect(out).toContain("page_mesurer : index.html à 1280×800");
    expect(out).toMatch(/premier affichage : \d+ ms · page prête \(DOMContentLoaded\) : \d+ ms · chargement complet : \d+ ms/);
    expect(out).toMatch(/images par seconde : \d+ en moyenne sur 1 s/);
    expect(out).toMatch(/poids : 2 fichiers, \d+ Ko \(les plus lourds : lourd\.js \d+ Ko, index\.html 0 Ko\)/);
    expect(out).toContain("rendu : ANGLE (Apple, ANGLE Metal Renderer");
    expect(out).toContain("erreurs (1) : aïe");
    rmSync(d, { recursive: true, force: true });
  }, 30_000);
  test.skipIf(!present)("comparer : la part de l'image qui a changé, la zone, et l'image en rouge", () => {
    const d = mkdtempSync(join(tmpdir(), "essaim-comparer-"));
    const png = (couleur: string, nom: string) => node(`import { chromium } from "playwright-core"; import { cheminNavigateur } from "./src/voir.ts"; const b = await chromium.launch({ executablePath: cheminNavigateur(), headless: true }); const p = await b.newPage({ viewport: { width: 200, height: 100 } }); await p.setContent('<body style="margin:0;background:#fff"><div style="position:absolute;left:50px;top:20px;width:40px;height:30px;background:${couleur}"></div>'); await p.screenshot({ path: ${JSON.stringify(d)} + "/${nom}" }); await b.close();`);
    png("#000", "avant.png"); png("#0a0", "apres.png");
    const out = node(`import { comparer } from "./src/mesurer.ts"; const r = await comparer(${JSON.stringify(d)}, "avant.png", "apres.png"); console.log(r.texte);`);
    expect(out).toContain("page_comparer : avant.png → apres.png");
    expect(out).toContain("6,00 % de l'image a changé, dans la zone de (50, 20) à (89, 49)");
    expect(statSync(join(d, "comparaison.png")).size).toBeGreaterThan(500);
    const meme = node(`import { comparer } from "./src/mesurer.ts"; const r = await comparer(${JSON.stringify(d)}, "avant.png", "avant.png", "memes.png"); console.log(r.texte);`);
    expect(meme).toContain("aucune différence visible");
    // Rôles : avec le dossier des captures du bureau, la sortie y va, hors du livrable, et une capture s'y lit par
    // son chemin absolu.
    const captures = join(d, "bureau", "captures");
    const bureau = node(`import { mkdirSync, copyFileSync } from "node:fs"; mkdirSync(${JSON.stringify(captures)}, { recursive: true }); copyFileSync(${JSON.stringify(join(d, "apres.png"))}, ${JSON.stringify(join(captures, "apres.png"))});
      import("./src/mesurer.ts").then(async ({ comparer }) => { const r = await comparer(${JSON.stringify(d)}, "avant.png", ${JSON.stringify(join(captures, "apres.png"))}, "diff.png", ${JSON.stringify(captures)}); console.log(r.texte); });`);
    expect(bureau).toContain("6,00 % de l'image a changé");
    expect(bureau).toContain(`image : ${join(captures, "diff.png")} (en rouge, ce qui a changé)`);
    expect(statSync(join(captures, "diff.png")).size).toBeGreaterThan(500);
    expect(() => statSync(join(d, "diff.png"))).toThrow();
    rmSync(d, { recursive: true, force: true });
  }, 30_000);
});

describe("une page qui boucle (29/09, revue N7)", () => {
  test.skipIf(cheminNavigateur() === undefined)("mesurer rend la main à l'échéance, page en erreur", async () => {
    const { mesurer } = await import("../src/mesurer.ts");
    const d = mkdtempSync(join(tmpdir(), "essaim-mesure-boucle-"));
    writeFileSync(join(d, "boucle.html"), "<!doctype html><p>x</p><script>setTimeout(() => { for (;;) {} }, 0)</script>");
    try {
      const debut = Date.now();
      const r = await mesurer(d, "boucle.html", 1, "1280x800", 5000);
      expect(Date.now() - debut).toBeLessThan(15_000);
      expect(r).toMatchObject({ code: 1 });
      expect(r.texte).toContain("ne répond plus");
    } finally { rmSync(d, { recursive: true, force: true }); }
  }, 30_000);
});
