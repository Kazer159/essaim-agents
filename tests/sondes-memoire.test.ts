// La sonde rejouer-juge sur un dépôt fabriqué, avec des faux juges. Ni navigateur ni réseau.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ouvrirBun } from "../src/tableau-bun.ts";
import * as T from "../src/tableau.ts";
import { formater, refusJuge, rejouer } from "../sondes/rejouer-juge.ts";

const MISSION = "# Mission\n\nune page\n\n## Livrable\n\nindex.html\n\n## C'est fini quand\n\nla page est là\n";
const FIN = "2026-09-26T12:00:00.000Z";

let racine: string, run: string, partage: string, juge: string, jugePanne: string, jugeArgs: string;

function git(args: string[], date?: string) {
  const env = { ...process.env, GIT_AUTHOR_NAME: "Antoine", GIT_AUTHOR_EMAIL: "a@essaim", GIT_COMMITTER_NAME: "Antoine", GIT_COMMITTER_EMAIL: "a@essaim" };
  if (date) Object.assign(env, { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  const r = Bun.spawnSync(["git", ...args], { cwd: partage, env });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} : ${r.stderr.toString()}`);
}
function commit(lignes: string, date: string, message: string) {
  writeFileSync(join(partage, "index.html"), lignes);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", message], date);
}
// Chaque fichier sous `dossier` avec sa taille et sa date : rien ne doit bouger pendant le rejeu.
function empreinte(dossier: string): Record<string, string> {
  const e: Record<string, string> = {};
  const parcourir = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n), s = statSync(p);
      e[p] = `${s.size}:${s.mtimeMs}`;
      if (s.isDirectory()) parcourir(p);
    }
  };
  parcourir(dossier);
  return e;
}

beforeAll(() => {
  racine = mkdtempSync(join(tmpdir(), "essaim-rejouer-"));
  run = join(racine, "run");
  partage = join(run, "partage");
  mkdirSync(partage, { recursive: true });
  const t = ouvrirBun(join(run, "tableau.sqlite"));
  T.initialiser(t);
  T.ouvrirRun(t, { id: "run-test", missionChemin: "missions/m.md", missionTexte: MISSION, modele: "faux/faux", plafondUsd: 1, silenceMin: 15 });
  t.run("UPDATE run SET fin = ?", [FIN]);
  t.fermer();

  // Le faux juge imprime les lignes du livrable (ok/KO), comme les juges de sondes/ ; le second échoue ; le troisième
  // rend ses arguments pour vérifier qu'ils passent.
  juge = join(racine, "juge-faux.mjs");
  writeFileSync(juge, `import { readFileSync } from "node:fs";\nimport { join } from "node:path";\nconsole.log(readFileSync(join(process.argv[2], "index.html"), "utf8"));\n`);
  jugePanne = join(racine, "juge-panne.mjs");
  writeFileSync(jugePanne, `console.error("navigateur absent"); process.exit(1);\n`);
  jugeArgs = join(racine, "juge-args.mjs");
  writeFileSync(jugeArgs, `console.log(process.argv[3] === "reponses.json" ? "ok  argument reçu" : "KO  argument perdu");\n`);

  // Comme depot.ts : un commit d'ouverture vide, puis le travail sur main, un essai adopté par une fusion.
  git(["init", "-q", "-b", "main"]);
  git(["commit", "-q", "--allow-empty", "-m", "ouverture"], "2026-09-26T10:00:00Z");
  commit("ok  a\nKO  b\nKO  c\n", "2026-09-26T10:10:00Z", "premier jet");
  commit("ok  a\nok  b\nKO  c\n", "2026-09-26T10:20:00Z", "deuxième");
  git(["checkout", "-q", "-b", "essai/x"]);
  commit("ok  a\nok  b\nok  c\n", "2026-09-26T10:30:00Z", "essai 1");
  commit("ok  a\nok  b\nok  c\n\nfin\n", "2026-09-26T10:35:00Z", "essai 2");
  git(["checkout", "-q", "main"]);
  git(["merge", "-q", "--no-ff", "-m", "adoption de essai/x", "essai/x"], "2026-09-26T11:00:00Z");
  commit("ok  a\nok  b\nok  c\n\nfin !\n", "2026-09-26T11:30:00Z", "retouche");
});
afterAll(() => rmSync(racine, { recursive: true, force: true }));

describe("rejouer-juge (M16)", () => {
  test("première lignée : ouverture vide → livrable absent, scores, une adoption comptée une fois, phase finale", () => {
    const avant = empreinte(partage);
    const r = rejouer(run, juge);
    expect(empreinte(partage)).toEqual(avant); // rien créé ni modifié dans .git ni dans le dossier
    expect(r.livrable).toBe("index.html");
    expect(r.commits.map((c) => c.sujet)).toEqual(["ouverture", "premier jet", "deuxième", "adoption de essai/x", "retouche"]);
    expect(r.commits[0]).toMatchObject({ issue: "absent", auteur: "Antoine" });
    expect(r.commits.slice(1).map((c) => [c.ok, c.total])).toEqual([[1, 3], [2, 3], [3, 3], [3, 3]]);
    expect(r.final).toEqual({ ok: 3, total: 3 });
    expect(r.atteint?.sujet).toBe("adoption de essai/x");
    expect(r.phaseFinaleS).toBe(3600); // 11 h 00 → fin à 12 h 00
    const texte = formater(r);
    expect(texte).toContain("score final : 3/3");
    expect(texte).toContain("phase finale : 60 min");
    expect(texte).toContain("livrable absent");
  });

  test("juge en panne : commits marqués, phase finale non calculée et dite", () => {
    const r = rejouer(run, jugePanne);
    expect(r.commits[0]!.issue).toBe("absent"); // le juge n'est pas lancé sans livrable
    expect(r.commits.slice(1).every((c) => c.issue === "panne")).toBe(true);
    expect(r.phaseFinaleS).toBeUndefined();
    expect(r.sansPhase).toContain("juge en panne");
    const texte = formater(r);
    expect(texte).toContain("juge en panne");
    expect(texte).toContain("phase finale : non calculée");
  });

  test("les arguments du juge passent après le dossier", () => {
    const r = rejouer(run, jugeArgs, ["reponses.json"]);
    expect(r.final).toEqual({ ok: 1, total: 1 });
  });

  test("les juges qui prennent <run> sont refusés avec leur motif, les juges à <partage> admis", () => {
    for (const j of ["juge-ligne", "juge-festival"]) {
      const chemin = new URL(`../sondes/${j}.mjs`, import.meta.url).pathname;
      expect(refusJuge(chemin)).toContain("<run>");
      expect(() => rejouer(run, chemin)).toThrow("<run>");
    }
    for (const j of ["juge-hopital", "juge-restaurant"])
      expect(refusJuge(new URL(`../sondes/${j}.mjs`, import.meta.url).pathname)).toBeUndefined();
  });
});
