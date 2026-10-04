import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lireBilan, lireWeb, tester, texteBilan, texteDePage } from "../src/outils-travail.ts";

// Le bilan chiffré : un compteur absent reste absent.
const SORTIE_B = "bilan.js\nmoteur.js\nmoteur.test.js\nnavigation.js\nvue-ligne.js\nvues-trajet.js\n 0 fail\n 7694 expect() calls\nRan 71 tests across 4 files. [19.00ms]\n"; // une sortie réelle

describe("lireBilan chiffré (R2)", () => {
  test("la sortie réelle de B (| tail, sans pass) : fail et ran, pass laissé absent", () => {
    expect(lireBilan(SORTIE_B.split("\n"))).toEqual({ fail: 0, ran: 71, duree: 0.019 });
  });
  test("codes ANSI retirés, tous les compteurs de bun, Ran sans durée", () => {
    const l = ["\x1b[32m 12 pass\x1b[0m", " 1 skip", " 2 todo", "\x1b[31m 3 fail\x1b[0m", " 2 errors", " 40 expect() calls", "Ran 18 tests across 2 files."];
    expect(lireBilan(l)).toEqual({ pass: 12, skip: 1, todo: 2, fail: 3, error: 2, ran: 18 });
    expect(lireBilan([" 1 error"])).toEqual({ error: 1 });
    expect(lireBilan(["Ran 1 test across 1 file. [1.5s]"])).toEqual({ ran: 1, duree: 1.5 });
  });
  test("rien de lu : un bilan vide ; texteBilan garde le texte d'avant", () => {
    expect(lireBilan(["(pass) x", "bonjour"])).toEqual({});
    expect(texteBilan({})).toBeUndefined();
    expect(texteBilan({ fail: 0, ran: 71, duree: 0.019 })).toBe("0 réussi · 0 échoué · 0,02 s");
    expect(texteBilan({ pass: 2, fail: 1, error: 2, skip: 1, todo: 3, duree: 1.25 })).toBe("2 réussis · 1 échoué · 2 erreurs · 1 ignoré · 3 à faire · 1,3 s");
  });
});

describe("web_lire : bornes (29/09, revue N4 à N6)", () => {
  test("des balises jamais fermées ne gèlent pas la lecture (N5)", () => {
    for (const html of ["<nav ".repeat(1e5), "<head ".repeat(1e5), "<a ".repeat(2e5)]) {
      const debut = Date.now();
      texteDePage(html);
      expect(Date.now() - debut).toBeLessThan(1000);
    }
  });
  test("une entité hors de l'Unicode reste telle quelle, la page est lue (N6)", () => {
    expect(texteDePage("<p>a &#99999999; b &#233;</p>").texte).toBe("a &#99999999; b é");
  });
  test("un flux sans fin est lu jusqu'à une borne, sans remplir la mémoire (N4)", async () => {
    const morceau = new TextEncoder().encode("x".repeat(64 * 1024));
    const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(new ReadableStream({ pull(c) { c.enqueue(morceau); } }), { headers: { "content-type": "text/plain" } }) });
    try {
      const debut = Date.now();
      const r = await lireWeb(`http://127.0.0.1:${srv.port}/`);
      expect(Date.now() - debut).toBeLessThan(5000);
      expect(r.code).toBe(0);
      expect(Number(/\n(\d+) caractères de texte/.exec(r.texte)![1])).toBeLessThan(2_200_000); // lu jusqu'à 2 Mo, pas plus
    } finally { srv.stop(true); }
  }, 30_000);
});

describe("tester : le bilan d'abord (B1, G11, T6)", () => {
  const TEST = 'import { test, expect } from "bun:test";\n';
  const dossier = (fichiers: Record<string, string>) => {
    const d = mkdtempSync(join(tmpdir(), "essaim-tester-"));
    for (const [f, c] of Object.entries(fichiers)) writeFileSync(join(d, f), c);
    return d;
  };
  const BILAN = /^\d+ réussis? · \d+ échoués? .*· \d+,\d+ s$/;

  test("un test qui laisse un processus en fond : le bilan tout de suite, pas un faux « délai dépassé » (29/09, revue N1)", () => {
    const d = dossier({ "garde.test.ts": `${TEST}import { spawn } from "node:child_process";\ntest("lance un serveur", () => { spawn("sleep", ["30"], { stdio: "inherit", detached: true }).unref(); expect(1).toBe(1); });\n` });
    const debut = Date.now();
    const r = tester(d, "garde.test.ts", undefined, { delaiMs: 8000 });
    expect(Date.now() - debut).toBeLessThan(6000);
    expect(r.code).toBe(0);
    expect(r.texte).toMatch(/^1 réussi · 0 échoué/);
    Bun.spawnSync(["pkill", "-f", "^sleep 30$"]);
  }, 20_000);
  test("un test bavard (plus d'1 Mio de sortie) ne masque pas son échec (29/09, revue N2)", () => {
    const d = dossier({ "gros.test.ts": `${TEST}test("bavard", () => { for (let i = 0; i < 60000; i++) console.log("ligne de journal numéro " + i); });\ntest("la caisse", () => expect(1).toBe(2));\n` });
    const r = tester(d, "gros.test.ts");
    expect(r.texte.split("\n")[0]).toMatch(/^1 réussi · 1 échoué/);
    expect(r.texte).toContain("(fail) la caisse");
  }, 30_000);
  test("sans detail : le bilan, puis le nom de chaque échec, sans le détail", () => {
    const d = dossier({
      "a.test.ts": `${TEST}test("un passe", () => expect(1).toBe(1));\ntest("la caisse de 1997", () => expect(229).toBe(319));\n`,
      "b.test.ts": `${TEST}test("autre", () => expect(2).toBe(2));\n`,
    });
    const r = tester(d, "a.test.ts");
    expect(r.code).toBe(1);
    const lignes = r.texte.split("\n");
    expect(lignes[0]).toMatch(/^1 réussi · 1 échoué · \d+,\d+ s$/);
    expect(lignes.slice(1)).toEqual(["(fail) la caisse de 1997"]);
    expect(r.bilan).toMatchObject({ pass: 1, fail: 1, ran: 2 });
    expect(r.texte).not.toContain("Expected");
    expect(tester(d).texte.split("\n")[0]).toMatch(/^2 réussis · 1 échoué · /);
    expect(tester(d, "absent.test.ts")).toEqual({ code: 2, invalide: true, texte: "absent.test.ts est introuvable dans le dossier partagé. Se lève quand le fichier existe" });
    rmSync(d, { recursive: true, force: true });
  }, 60_000);

  test("avec detail : le détail de chaque échec, comme avant", () => {
    const d = dossier({ "a.test.ts": `${TEST}test("un passe", () => expect(1).toBe(1));\ntest("la caisse de 1997", () => expect(229).toBe(319));\n` });
    const r = tester(d, "a.test.ts", undefined, { detail: true });
    expect(r.texte.split("\n")[0]).toMatch(BILAN);
    expect(r.texte).toContain("(fail) la caisse de 1997");
    expect(r.texte).toContain("Expected: 319");
    expect(r.texte).not.toContain("(pass) un passe");
    rmSync(d, { recursive: true, force: true });
  }, 60_000);

  test("35 échecs : 30 noms, puis le compte des autres", () => {
    const tests = Array.from({ length: 36 }, (_, i) => `test("cas ${i}", () => expect(${i}).toBe(${i === 0 ? 0 : -1}));`).join("\n");
    const d = dossier({ "n.test.ts": `${TEST}${tests}\n` });
    const lignes = tester(d).texte.split("\n");
    expect(lignes[0]).toMatch(/^1 réussi · 35 échoués · /);
    expect(lignes.slice(1, 31).every((l) => /^\(fail\) cas \d+$/.test(l))).toBe(true);
    expect(lignes.slice(31)).toEqual(["… et 5 autres"]);
    rmSync(d, { recursive: true, force: true });
  }, 60_000);

  test("zéro test : le bilan seul", () => {
    const d = dossier({ "z.test.ts": "const x = 1;\n" });
    const r = tester(d, "z.test.ts");
    expect(r.code).toBe(0);
    expect(r.texte).toMatch(/^0 réussi · 0 échoué · \d+,\d+ s$/);
    rmSync(d, { recursive: true, force: true });
  }, 60_000);

  test("une erreur de chargement dans un fichier, des échecs nommés dans un autre : les noms et l'erreur", () => {
    const d = dossier({
      "a.test.ts": `${TEST}test("la caisse de 1997", () => expect(229).toBe(319));\n`,
      "c.test.ts": `${TEST}import "./manque.ts";\ntest("x", () => {});\n`,
    });
    const r = tester(d);
    expect(r.texte.split("\n")[0]).toMatch(/^0 réussi · 2 échoués · 1 erreur · /);
    expect(r.texte).toContain("(fail) la caisse de 1997");
    expect(r.texte).toContain("Cannot find module './manque.ts'");
    expect(r.texte).not.toContain("Expected");
    rmSync(d, { recursive: true, force: true });
  }, 60_000);

  test("aucun test nommé : les dernières lignes de la sortie", () => {
    const d = dossier({});
    const r = tester(d);
    expect(r.code).not.toBe(0);
    expect(r.texte).toContain("did not match any test files");
    rmSync(d, { recursive: true, force: true });
  }, 60_000);

  test("délai dépassé : les dernières lignes reçues sont gardées", () => {
    const d = dossier({});
    const faux = join(d, "bun-qui-dort");
    writeFileSync(faux, "#!/bin/sh\necho 'a.test.ts:'\necho '(fail) la caisse de 1997 [0.1ms]'\necho 'chargement du moteur 3D'\nexec sleep 5\n");
    chmodSync(faux, 0o755);
    const r = tester(d, undefined, faux, { delaiMs: 500 });
    expect(r.code).toBe(1);
    expect(r.texte.split("\n")[0]).toBe("./ a dépassé 0,5 s, arrêté");
    expect(r.texte).toContain("chargement du moteur 3D");
    rmSync(d, { recursive: true, force: true });
  }, 60_000);

  test("une sortie trop longue est tronquée à 5 000 caractères", () => {
    const tests = Array.from({ length: 30 }, (_, i) => `test("cas ${i}", () => expect("${"x".repeat(300)}").toBe("y"));`).join("\n");
    const d = dossier({ "n.test.ts": `${TEST}${tests}\n` });
    const r = tester(d, undefined, undefined, { detail: true });
    expect(r.texte.endsWith("\n… (tronqué à 5 000 caractères)")).toBe(true);
    expect(r.texte.length).toBeLessThan(5100);
    rmSync(d, { recursive: true, force: true });
  }, 60_000);
});

describe("lire_web (25/09)", () => {
  test("texteDePage : titres, paragraphes, listes, code, sans scripts ni menus", () => {
    const html = '<html><head><title>three.js – docs</title><style>p{}</style><script>var x=1</script></head><body><nav>Accueil · Blog</nav><h1>Ombres</h1><p>Active <b>renderer.shadowMap</b> &amp; lance.</p><ul><li>un</li><li>deux</li></ul><pre>renderer.shadowMap.enabled = true;</pre><footer>© 2026</footer></body></html>';
    const { titre, texte } = texteDePage(html);
    expect(titre).toBe("three.js – docs");
    expect(texte).toBe("# Ombres\nActive renderer.shadowMap & lance.\n\n- un\n- deux\n```\nrenderer.shadowMap.enabled = true;\n```");
  });
  test("une page servie : statut, titre, texte, et la suite annoncée", async () => {
    const long = "<p>" + "moteur ".repeat(2000) + "</p>";
    const srv = Bun.serve({ port: 0, fetch: () => new Response(`<!doctype html><title>Moteurs</title><h2>Comparatif</h2>${long}`, { headers: { "content-type": "text/html; charset=utf-8" } }) });
    try {
      const r = await lireWeb(`http://127.0.0.1:${srv.port}/`);
      expect(r.code).toBe(0);
      expect(r.texte).toContain("200 http://127.0.0.1:");
      expect(r.texte).toContain("titre : Moteurs");
      expect(r.texte).toContain("## Comparatif");
      expect(r.texte).toMatch(/caractères de plus : web_lire avec depuis=8000\)$/);
      const suite = await lireWeb(`http://127.0.0.1:${srv.port}/`, 8000);
      expect(suite.texte).toContain("à partir du 8000ᵉ");
    } finally { srv.stop(true); }
    expect(await lireWeb("ftp://exemple.org")).toEqual({ code: 2, invalide: true, texte: "l'adresse ftp://exemple.org n'est ni https ni http. Se lève avec une adresse https:// ou http://" });
    expect(await lireWeb("exemple.org")).toEqual({ code: 2, invalide: true, texte: "l'adresse exemple.org est illisible. Se lève avec une adresse complète, https://…" });
  });
});
