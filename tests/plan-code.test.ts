import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { definitions, planDuCode } from "../src/plan-code.ts";
import { ouvrirBun } from "../src/tableau-bun.ts";
import * as T from "../src/tableau.ts";

describe("plan_du_code (25/09)", () => {
  test("definitions : fonctions, classes, constantes du niveau du module et espace partagé ; pas les variables locales", () => {
    const code = [
      "const SORLAC = window.SORLAC || {};",
      "function attrait(g, x, y) {",
      "    const local = 1;",
      "  return local;",
      "}",
      "export class Ville {}",
      "SORLAC.sim = { jouer };",
      "window.SORLAC.courbes = {};",
      "(function () {",
      "  function interne() {}",
      "})();",
    ].join("\n");
    expect(definitions(code).sort()).toEqual(["SORLAC", "SORLAC.courbes", "SORLAC.sim", "Ville", "attrait", "interne"].sort());
  });
  test("la carte : ordre de chargement, fichiers oubliés ou introuvables, qui utilise quoi, qui a écrit, noms en double", () => {
    const d = mkdtempSync(join(tmpdir(), "essaim-plan-"));
    const p = join(d, "partage");
    mkdirSync(join(p, "tests"), { recursive: true });
    writeFileSync(join(p, "index.html"), '<link rel="stylesheet" href="style.css"><script src="sim.js"></script><script src="vue.js"></script><script src="absent.js"></script>');
    writeFileSync(join(p, "style.css"), "body { margin: 0 }");
    writeFileSync(join(p, "sim.js"), "function attraitCase(x) { return x; }\nfunction jouerAnnee() {}\nconst F = 1;\n");
    writeFileSync(join(p, "vue.js"), "function dessiner() { return attraitCase(2) + F; }\n");
    writeFileSync(join(p, "plan.js"), "function jouerAnnee() {}\n");
    writeFileSync(join(p, "tests", "sim.test.js"), "attraitCase(1);\n");
    const t = ouvrirBun(":memory:");
    T.initialiser(t);
    T.ajouterAgent(t, "Bernard", "/b");
    T.ajouterEvenement(t, { agent: "Bernard", type: "tool_execution_start", outil: "write", arguments: JSON.stringify({ path: join(p, "sim.js"), content: "…" }) });
    T.ajouterEvenement(t, { agent: "Bernard", type: "tool_execution_start", outil: "edit", arguments: JSON.stringify({ path: join(p, "sim.js") }) });
    const plan = planDuCode(p, t);
    expect(plan).toContain("6 fichiers dans le dossier partagé");
    expect(plan).toContain("page index.html : charge 3 scripts dans cet ordre : sim.js → vue.js → absent.js ; styles : style.css");
    expect(plan).toContain("  introuvables : absent.js");
    expect(plan).toContain("  fichiers de code que cette page ne charge pas : plan.js"); // les tests ne sont pas « oubliés »
    expect(plan).toContain("- sim.js (4 lignes) · définit attraitCase, jouerAnnee, F · utilisé par vue.js et 1 fichier de tests · écrit par Bernard ×2");
    expect(plan).toContain("noms définis dans plusieurs fichiers (le dernier chargé gagne, sauf si chaque fichier est enveloppé dans sa propre fonction) :\n- jouerAnnee : plan.js, sim.js");
    expect(plan.indexOf("noms définis dans plusieurs fichiers")).toBeLessThan(plan.indexOf("fichiers :\n")); // avant la liste, jamais tronqué
    t.fermer();
    rmSync(d, { recursive: true, force: true });
  });
  test("?v=3, //cdn et les modules importés : ni introuvables, ni oubliés (29/09, revue N11)", () => {
    const d = mkdtempSync(join(tmpdir(), "essaim-plan-"));
    mkdirSync(join(d, "js"));
    writeFileSync(join(d, "js", "app.js"), 'import { jouer } from "./sim.js";\nimport("./tard.js");\njouer();\n');
    writeFileSync(join(d, "js", "sim.js"), "export function jouer() {}\n");
    writeFileSync(join(d, "js", "tard.js"), "export const x = 1;\n");
    writeFileSync(join(d, "js", "vieux.js"), "const vieux = 1;\n");
    writeFileSync(join(d, "index.html"), '<script src="//cdn.jsdelivr.net/npm/three"></script><script type="module" src="js/app.js?v=3"></script>');
    const plan = planDuCode(d);
    expect(plan).not.toContain("introuvables");
    expect(plan).toContain("fichiers de code que cette page ne charge pas : js/vieux.js");
    rmSync(d, { recursive: true, force: true });
  });
  test("un gros dossier (1 000 fichiers) se cartographie en quelques secondes (29/09, revue N12)", () => {
    const d = mkdtempSync(join(tmpdir(), "essaim-plan-"));
    for (let i = 0; i < 1000; i++) writeFileSync(join(d, `f${i}.js`), Array.from({ length: 10 }, (_, k) => `function fonction${i}_${k}() { return fonction${(i + 1) % 1000}_${k}(); }`).join("\n") + "\n");
    const debut = Date.now();
    planDuCode(d);
    expect(Date.now() - debut).toBeLessThan(8000); // l'ancienne version : 12 s seule ; la suite parallèle ralentit tout
    rmSync(d, { recursive: true, force: true });
  }, 60_000);
  test("un dossier vide le dit", () => {
    const d = mkdtempSync(join(tmpdir(), "essaim-plan-"));
    expect(planDuCode(d)).toBe("le dossier partagé ne contient encore aucun fichier de code, de style ou de page");
    rmSync(d, { recursive: true, force: true });
  });
});
