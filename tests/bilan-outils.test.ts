import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ouvrirBun } from "../src/tableau-bun.ts";
import * as T from "../src/tableau.ts";

let dossier: string;
let t: T.Tableau;
let n = 0;

beforeEach(() => {
  dossier = mkdtempSync(join(tmpdir(), "essaim-bilan-outils-"));
  t = ouvrirBun(join(dossier, "tableau.sqlite"));
  T.initialiser(t);
  T.ouvrirRun(t, { id: "run-test", missionChemin: "missions/m.md", missionTexte: "texte", modele: "faux/faux", plafondUsd: 1, silenceMin: 15 });
});
afterEach(() => {
  t.fermer();
  rmSync(dossier, { recursive: true, force: true });
});

// Un appel d'outil tel que le lanceur le trace : un début (arguments) puis une fin (résultat, erreur).
function appel(agent: string, outil: string, args: unknown, resultat = "ok", erreur?: string) {
  const appelId = `a${++n}`;
  T.ajouterEvenement(t, { agent, type: "tool_execution_start", outil, appelId, arguments: args });
  T.ajouterEvenement(t, { agent, type: "tool_execution_end", outil, appelId, resultat, erreur });
}
const bash = (agent: string, command: string) => appel(agent, "bash", { command });
const COUPURE = "refusé : ton contexte fait 161k tokens, au-delà de la coupure (160k). Appelle se_resumer avec ta note.";

describe("bilanOutils sur un ancien run (T9)", () => {
  test("appels, erreurs et refus disjoints, refus rangés par cause", () => {
    appel("Antoine", "poster", { texte: "a" }, "refusé : Fabien ne s'est pas encore exprimé et tu n'as encore rien posté.");
    appel("Antoine", "poster", { texte: "a" }, "message 1 posté dans principal");
    appel("Antoine", "edit", { path: "x" }, COUPURE, COUPURE); // refus en erreur : compté refus, pas erreur
    appel("Antoine", "read", { path: "x" }, "ENOENT", "ENOENT");
    appel("Bernard", "reclamer_fichier", { chemin: "a.js", raison: "r" }, "occupé par Jules depuis 2026-09-25T15:54:04.526Z");
    appel("Bernard", "fini", { raison: "r" }, "refusé, une fois : du travail reste ouvert dans la salle.");
    appel("Bernard", "entrer", { fil: "q" }, "refusé : tu es le dernier dans q-neige : quitter(conclusion) d'abord");
    appel("Bernard", "fini", { raison: "r" }, "refusé : le livrable index.html ne s'ouvre pas sans erreur");
    const b = T.bilanOutils(t);
    expect(b.noms).toBe("anciens");
    expect(b.appels).toBe(8);
    expect(b.erreurs).toBe(1);
    expect(b.refus).toBe(6);
    expect(b.parCause).toEqual({ coupure: 1, tour: 1, tickets: 1, fil: 1, livrable: 1, autres: 1 });
    expect(b.parOutil.poster).toEqual({ appels: 2, erreurs: 0, refus: 1 });
    expect(b.parOutil.read).toEqual({ appels: 1, erreurs: 1, refus: 0 });
    expect(b.parAgent.Bernard!.refus).toBe(4);
  });

  test("deux refus de suite, même agent, même outil, même cause : un refus répété", () => {
    appel("Gaston", "adopter", { nom: "e" }, "refusé : conflit sur a.js. Le dossier commun n'a pas bougé.");
    appel("Hubert", "poster", { texte: "x" }, "message 3 posté dans principal"); // un autre agent entre les deux
    appel("Gaston", "adopter", { nom: "e" }, "refusé : conflit sur b.js. Le dossier commun n'a pas bougé.");
    appel("Gaston", "adopter", { nom: "e" }, "refusé : conflit sur b.js. Le dossier commun n'a pas bougé.");
    appel("Gaston", "bash", { command: "ls" }, COUPURE, COUPURE);
    appel("Gaston", "bash", { command: "ls" }, COUPURE, COUPURE);
    appel("Gaston", "edit", { path: "x" }, COUPURE, COUPURE); // autre outil : pas répété
    const b = T.bilanOutils(t);
    expect(b.repetes).toBe(3);
    expect(b.parAgent.Gaston!.repetes).toBe(3);
  });

  test("un appel refusé ou en erreur suivi d'un autre outil dans les deux appels suivants est corrigé, sauf coupure", () => {
    appel("Denis", "tester", {}, "refusé : fichier introuvable");
    appel("Denis", "tester", {}, "refusé : fichier introuvable");
    appel("Denis", "bash", { command: "bun test" }); // corrige le premier (deux appels plus loin) et le second
    appel("Denis", "voir", { page: "x" }, "panne", "panne");
    appel("Denis", "voir", { page: "x" });
    appel("Denis", "voir", { page: "x" }); // même outil deux fois : pas corrigé
    appel("Denis", "edit", { path: "x" }, COUPURE, COUPURE);
    appel("Denis", "moi_resumer", { note: "n" }); // après une coupure : pas compté
    expect(T.bilanOutils(t).corriges).toBe(2);
  });

  test("bash : bun test, git log, sqlite3, simples et composés, par cible", () => {
    bash("Emile", "bun test");
    bash("Emile", "bun test tests/a.test.js 2>&1 | tail -3");
    bash("Emile", "cd /r/partage && bun test && echo fin");
    bash("Emile", "bun test -t 'la caisse'");
    bash("Emile", "cd /r/partage/essais/lieux && bun test; echo fin");
    bash("Emile", "git log --oneline");
    bash("Emile", "git -C partage log --format='%h %s' -5 | cat");
    bash("Emile", "sqlite3 /r/tableau.sqlite 'select 1'");
    bash("Emile", "sqlite3 /r/tableau.sqlite 'select 1' | head -3");
    bash("Emile", "sqlite3 autre.db 'select 1'"); // pas le tableau
    bash("Emile", "ls");
    const b = T.bilanOutils(t);
    expect(b.bash.bunTest).toEqual({ simples: 3, composees: 2, partage: 3, essai: 1, filtre: 1 });
    // bun test -t est simple ; un cd en tête ne compte pas, ce qui suit bun test le rend composé ; | tail simple
    expect(b.bash.gitLog).toEqual({ simples: 1, composees: 1 });
    expect(b.bash.sqlite3).toEqual({ simples: 2, composees: 0 });
    expect(b.parAgent.Emile).toMatchObject({ appels: 11, bunTest: 5, gitLog: 2, sqlite3: 2 });
  });
});

describe("bilanOutils : noms inconnus et arguments tronqués", () => {
  test("un ancien run : bite et salle_poster inconnus, outil_inconnu à part", () => {
    appel("Denis", "poster", { texte: "x" }, "message 1 posté dans principal");
    appel("Denis", "bite", {}, "Tool bite not found", "Tool bite not found");
    appel("Denis", "outil_inconnu", {}, "Tool not found", "Tool not found");
    appel("Denis", "bite", {}, "Tool bite not found", "Tool bite not found");
    const b = T.bilanOutils(t);
    expect(b.noms).toBe("anciens");
    expect(b.inconnus).toEqual({ bite: 2 });
    expect(b.outilInconnu).toBe(1);
    expect(b.parAgent.Denis!.inconnus).toBe(2);
    expect(b.erreurs).toBe(3);
  });

  test("un nouveau run : les anciens noms sont inconnus", () => {
    appel("Denis", "salle_poster", { texte: "x" }, "message 1 posté dans principal");
    appel("Denis", "poster", { texte: "x" }, "Tool poster not found", "Tool poster not found");
    const b = T.bilanOutils(t);
    expect(b.noms).toBe("nouveaux");
    expect(b.inconnus).toEqual({ poster: 1 });
  });

  test("arguments tronqués : comptés, et la commande quand même lue", () => {
    const long = (`{"command":"cd /r/partage && bun test && bun test ${"x".repeat(4000)}`).slice(0, 4000) + "…";
    appel("Denis", "bash", long);
    appel("Denis", "bash", { command: "git log --oneline" });
    const b = T.bilanOutils(t);
    expect(b.tronques).toBe(1);
    expect(b.bash.bunTest.composees).toBe(1);
    expect(b.bash.gitLog.simples).toBe(1);
  });
});

describe("bilanOutils lit la liste enregistrée dans run (1.3)", () => {
  test("run.outils_json fait foi : un outil de la liste est connu, un autre inconnu, même sans salle_ dans la trace", () => {
    t.run("UPDATE run SET outils_json = ?", [JSON.stringify(["read", "bash", "edit", "write", "salle_poster", "moi_finir"])]);
    appel("Denis", "moi_finir", { raison: "r" });
    appel("Denis", "poster", { texte: "x" }, "Tool poster not found", "Tool poster not found");
    appel("Denis", "salle_lire", {}, "Tool salle_lire not found", "Tool salle_lire not found");
    const b = T.bilanOutils(t);
    expect(b.noms).toBe("nouveaux");
    expect(b.inconnus).toEqual({ poster: 1, salle_lire: 1 });
  });
  test("une liste aux anciens noms : jeu « anciens »", () => {
    t.run("UPDATE run SET outils_json = ?", [JSON.stringify(["read", "bash", "edit", "write", "poster", "fini"])]);
    appel("Denis", "poster", { texte: "x" });
    expect(T.bilanOutils(t).noms).toBe("anciens");
  });
  test("une colonne vide : le jeu se déduit de la trace", () => {
    appel("Denis", "salle_poster", { texte: "x" });
    expect(T.bilanOutils(t)).toMatchObject({ noms: "nouveaux", inconnus: {} });
  });
});

describe("resumeOutils", () => {
  test("le résumé de la ligne du bilan", () => {
    appel("A", "poster", { texte: "x" }, "refusé : Fabien ne s'est pas encore exprimé.");
    appel("A", "poster", { texte: "x" }, "refusé : Fabien ne s'est pas encore exprimé.");
    appel("A", "bite", {}, "Tool bite not found", "Tool bite not found");
    bash("A", "bun test");
    bash("A", "cd x && git log");
    const r = T.resumeOutils(T.bilanOutils(t));
    expect(r).toEqual({ appels: 5, inconnus: 1, refus: 2, repetes: 1, bash: { bunTest: 1, gitLog: 1, sqlite3: 0 } });
  });
});

describe("la sonde sondes/bilan-outils.ts", () => {
  const racineDepot = join(import.meta.dir, "..");
  // Un run fabriqué dans le dossier temporaire : son tableau, son modèle, sa mission, ses appels.
  function fabriquer(nom: string, modele: string, mission: string, remplir: (t: T.Tableau) => void): string {
    const d = join(dossier, nom);
    mkdirSync(d);
    const u = ouvrirBun(join(d, "tableau.sqlite"));
    T.initialiser(u);
    T.ouvrirRun(u, { id: basename(nom), missionChemin: `missions/${mission}`, missionTexte: "m", modele, plafondUsd: 1, silenceMin: 15 });
    remplir(u);
    u.fermer();
    return d;
  }
  const trace = (u: T.Tableau, agent: string, outil: string, args: unknown, resultat = "ok") => {
    T.ajouterEvenement(u, { agent, type: "tool_execution_start", outil, arguments: args });
    T.ajouterEvenement(u, { agent, type: "tool_execution_end", outil, resultat });
  };
  const sonde = (...args: string[]) => {
    const r = Bun.spawnSync(["bun", "sondes/bilan-outils.ts", ...args], { cwd: racineDepot });
    return { code: r.exitCode, sortie: r.stdout.toString(), erreur: r.stderr.toString() };
  };
  const ancien = () => fabriquer("run-a", "xiaomi/mimo", "vallee.md", (u) => {
    trace(u, "Antoine", "poster", { texte: "x" }, "refusé : Fabien ne s'est pas encore exprimé.");
    trace(u, "Antoine", "poster", { texte: "x" }, "refusé : Fabien ne s'est pas encore exprimé.");
    trace(u, "Antoine", "bash", { command: "bun test" });
    trace(u, "Bernard", "bash", { command: "cd partage && git log --oneline | sort" });
    trace(u, "Bernard", "bite", {}, "Tool bite not found");
  });

  test("un run : chiffres, causes, bash, par outil, modèle et mission", () => {
    const r = sonde(ancien());
    expect(r.code).toBe(0);
    expect(r.sortie).toContain("bilan des outils · run-a");
    expect(r.sortie).toContain("modèle : xiaomi/mimo · mission : vallee.md · noms : anciens");
    expect(r.sortie).toMatch(/appels\s+5\n/);
    expect(r.sortie).toMatch(/refus\s+40 \(2\)/);
    expect(r.sortie).toMatch(/refus répétés\s+20 \(1\)/);
    expect(r.sortie).toContain("refus par cause : coupure 0 · tour 2 · tickets 0 · fil 0 · livrable 0 · autres 0");
    expect(r.sortie).toContain("noms inconnus : bite 1");
    expect(r.sortie).toContain("bun test : 1 simple, 0 composée");
    expect(r.sortie).toContain("git log : 0 simple, 1 composée");
    expect(r.sortie).not.toContain("attention");
  });

  test("deux runs : côte à côte pour 100 appels, médiane et max par agent, écart ; l'identifiant se lit dans runs/", () => {
    const a = ancien();
    mkdirSync(join(dossier, "runs"));
    fabriquer("runs/run-b", "xiaomi/mimo", "vallee.md", (u) => {
      trace(u, "Antoine", "salle_poster", { texte: "x" });
      trace(u, "Antoine", "code_tester", {});
      trace(u, "Bernard", "salle_poster", { texte: "x" });
      trace(u, "Bernard", "bash", { command: "bun test" });
    });
    const s = Bun.spawnSync(["bun", join(racineDepot, "sondes/bilan-outils.ts"), a, "run-b"], { cwd: dossier }).stdout.toString(); // run-b : un identifiant de <cwd>/runs
    expect(s).toContain("bilan des outils · run-a ↔ run-b");
    expect(s).toContain("A · modèle : xiaomi/mimo · mission : vallee.md · noms : anciens");
    expect(s).toContain("B · modèle : xiaomi/mimo · mission : vallee.md · noms : nouveaux");
    expect(s).toMatch(/refus\s+40 \(2\)\s+0 \(0\)\s+-40/);
    expect(s).toMatch(/bash : bun test\s+20 \(1\)\s+25 \(1\)\s+\+5/);
    expect(s).toContain("par agent : médiane · max");
    expect(s).toMatch(/\nrefus\s+1 · 2\s+0 · 0/);
    expect(s).not.toContain("attention");
  });

  test("modèle ou mission différents : un avertissement", () => {
    const a = ancien();
    const b = fabriquer("run-c", "google/gemini", "ville.md", (u) => trace(u, "Antoine", "salle_poster", { texte: "x" }));
    const r = sonde(a, b);
    expect(r.code).toBe(0);
    expect(r.sortie).toContain("attention : deux runs ne se comparent que sur le même modèle et la même mission");
  });

  test("un chemin qui n'existe pas : code 2 et un message", () => {
    const r = sonde(join(dossier, "nulle-part"));
    expect(r.code).toBe(2);
    expect(r.erreur).toContain("aucun tableau.sqlite");
  });

  test("lecture seule : le tableau n'est pas modifié", () => {
    const a = ancien();
    const avant = Bun.file(join(a, "tableau.sqlite")).size;
    sonde(a);
    const u = ouvrirBun(join(a, "tableau.sqlite"), { lectureSeule: true });
    expect(u.get<{ n: number }>("SELECT count(*) AS n FROM evenements")?.n).toBe(10);
    u.fermer();
    expect(Bun.file(join(a, "tableau.sqlite")).size).toBe(avant);
  });

  test("un cd en tête ne rend pas une commande composée (F3)", () => {
    expect(T.commandeComposee("cd /x/partage && bun test")).toBe(false);
    expect(T.commandeComposee('cd "/x y" && git log --oneline | head')).toBe(false);
    expect(T.commandeComposee("cd /x && bun test && git log")).toBe(true);
    expect(T.commandeComposee("bun test; echo fin")).toBe(true);
  });
});
