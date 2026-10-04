import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ANCIEN_VERS_NOUVEAU, ANCIENS_OUTILS_SALLE, nomsSalle, nouveauNom, OUTIL_COMPACTAGE, OUTIL_MEMOIRE, OUTILS_PI, OUTILS_RETIRES, OUTILS_SALLE } from "../src/noms-outils.ts";

describe("la source unique des noms (T1)", () => {
  test("4 outils de pi, 26 anciens noms de la salle, 28 nouveaux", () => {
    expect([...OUTILS_PI]).toEqual(["read", "bash", "edit", "write"]);
    expect(ANCIENS_OUTILS_SALLE.length).toBe(26);
    expect(new Set(ANCIENS_OUTILS_SALLE).size).toBe(26);
    expect(OUTILS_SALLE.length).toBe(28);
    expect(new Set(OUTILS_SALLE).size).toBe(28);
    expect(OUTILS_SALLE).toContain(OUTIL_COMPACTAGE);
    expect(OUTIL_MEMOIRE).toBe("salle_chercher");
    expect(OUTILS_SALLE.indexOf(OUTIL_MEMOIRE)).toBe(OUTILS_SALLE.indexOf("salle_budget") + 1);
    expect(OUTILS_SALLE).toContain("depot_journal");
  });

  test("chaque ancien nom a une correspondance parmi les nouveaux, ou parmi les outils retirés (entrer, quitter)", () => {
    for (const ancien of ANCIENS_OUTILS_SALLE) {
      expect(ANCIEN_VERS_NOUVEAU[ancien]).toBeDefined();
      expect([...OUTILS_SALLE, ...OUTILS_RETIRES] as string[]).toContain(ANCIEN_VERS_NOUVEAU[ancien]!);
    }
  });

  // Les trois outils de fil quittent les agents ; leurs noms restent connus pour lire les runs d'avant.
  test("fil_entrer, fil_quitter et fil_historique sont retirés : hors de OUTILS_SALLE et de nomsSalle, gardés dans OUTILS_RETIRES", () => {
    expect([...OUTILS_RETIRES]).toEqual(["fil_entrer", "fil_quitter", "fil_historique"]);
    for (const n of OUTILS_RETIRES) {
      expect(OUTILS_SALLE as readonly string[]).not.toContain(n);
      for (const c of [true, false]) for (const m of [true, false]) expect(nomsSalle(c, m)).not.toContain(n);
    }
  });

  test("boite, ticket et tickets se départagent par leurs arguments", () => {
    expect(nouveauNom("boite")).toBe("salle_lire");
    expect(nouveauNom("boite", { complet: true })).toBe("fil_historique");
    expect(nouveauNom("boite", { complet: false })).toBe("salle_lire");
    expect(nouveauNom("ticket", { id: 3 })).toBe("ticket_modifier");
    expect(nouveauNom("ticket", { type: "bug", titre: "x" })).toBe("ticket_ouvrir");
    expect(nouveauNom("tickets", { id: 3 })).toBe("ticket_lire");
    expect(nouveauNom("tickets")).toBe("ticket_lister");
    expect(nouveauNom("se_resumer")).toBe("moi_resumer");
    expect(nouveauNom("voir")).toBe("page_voir");
  });

  test("un nom nouveau, de pi ou inconnu se rend tel quel", () => {
    expect(nouveauNom("salle_poster")).toBe("salle_poster");
    expect(nouveauNom("bash")).toBe("bash");
    expect(nouveauNom("bite")).toBe("bite");
  });

  test("nomsSalle rend les 28 nouveaux noms, 27 sans compactage (sans moi_resumer)", () => {
    expect(nomsSalle(true)).toEqual([...OUTILS_SALLE]);
    expect(nomsSalle(true).length).toBe(28);
    expect(nomsSalle(false)).toEqual(OUTILS_SALLE.filter((n) => n !== OUTIL_COMPACTAGE));
    expect(nomsSalle(false).length).toBe(27);
    for (const ancien of ANCIENS_OUTILS_SALLE) expect(nomsSalle(true)).not.toContain(ancien);
  });

  // Second cerveau : la mémoire coupée (--memoire non) retire salle_chercher ; défaut : la mémoire.
  test("nomsSalle(compactage, memoire) : 28, 27 sans compactage, 27 sans mémoire, 26 sans les deux (32, 31, 31, 30 avec pi)", () => {
    const compte = (c: boolean, m: boolean) => [nomsSalle(c, m).length, [...OUTILS_PI, ...nomsSalle(c, m)].length];
    expect(compte(true, true)).toEqual([28, 32]);
    expect(compte(false, true)).toEqual([27, 31]);
    expect(compte(true, false)).toEqual([27, 31]);
    expect(compte(false, false)).toEqual([26, 30]);
    expect(nomsSalle(true, false)).toEqual(OUTILS_SALLE.filter((n) => n !== OUTIL_MEMOIRE));
    expect(nomsSalle(false, false)).not.toContain(OUTIL_COMPACTAGE);
    expect(nomsSalle(true)).toEqual(nomsSalle(true, true));
  });
});

// Aucun ancien nom écrit comme outil dans les textes de src/ — entre accents graves, ou suivi de « ( ».
// Seuls les littéraux de chaîne hors lignes de commentaire sont lus : un appel de fonction interne (tester(partage, …))
// n'est pas un littéral, et un nom entre guillemets simples dans du SQL ('se_resumer') n'est ni l'un ni l'autre.
describe("T12 : les anciens noms ont quitté les textes de src/", () => {
  const LITTERAL = /(["'`])(?:\\.|(?!\1)[^\\])*\1/g;
  const noms = ANCIENS_OUTILS_SALLE.join("|");
  const COMME_OUTIL = new RegExp(String.raw`\\?` + "`" + String.raw`(?:${noms})\\?` + "`" + String.raw`|(?<![\w-])(?<!(?:INTO|TABLE|EXISTS) )(?:${noms})\(`);
  const racine = new URL("../src/", import.meta.url).pathname;
  const fichiers = readdirSync(racine).filter((f) => f.endsWith(".ts") && f !== "noms-outils.ts");

  test("la règle reconnaît un nom entre accents graves ou suivi de « ( », et rien d'autre", () => {
    const trouve = (ligne: string) => [...ligne.matchAll(LITTERAL)].some((m) => COMME_OUTIL.test(m[0].slice(1, -1)));
    expect(trouve("texte(`lis-le d'abord (\\`boite\\`, \\`attendre\\`)`)")).toBe(true);
    expect(trouve('texte("pour remonter : boite(\\"x\\", complet)")')).toBe(true);
    expect(trouve("const r = tester(partage, p.fichier);")).toBe(false);
    expect(trouve("outil IN ('se_resumer', 'moi_resumer')")).toBe(false);
    expect(trouve('t.run("INSERT INTO reclamations(chemin) VALUES (?)")')).toBe(false);
    expect(trouve('texte("pour remonter : fil_historique(\\"x\\")")')).toBe(false);
    expect(trouve('texte("page_voir : 0 page saine")')).toBe(false);
  });

  test.each(fichiers)("%s", (f) => {
    const trouves: string[] = [];
    readFileSync(join(racine, f), "utf8").split("\n").forEach((ligne, i) => {
      if (ligne.trim().startsWith("//")) return;
      for (const m of ligne.matchAll(LITTERAL)) if (COMME_OUTIL.test(m[0].slice(1, -1))) trouves.push(`${f}:${i + 1} ${m[0].slice(0, 120)}`);
    });
    expect(trouves).toEqual([]);
  });
});

// De même, les consignes et les missions sont du texte lu par le modèle, lu ligne à ligne en entier.
// L'en-tête « voir : 0 » que les missions citent est devenu « page_voir : 0 ». missions/depot.md
// nomme une branche git `essai` (l'exercice de la mission), et le fil `tickets` porte le nom de l'ancien outil : ni l'un
// ni l'autre n'est un outil.
describe("T12 : les anciens noms ont quitté les consignes et les missions", () => {
  const noms = ANCIENS_OUTILS_SALLE.join("|");
  const COMME_OUTIL = new RegExp("`(?:" + noms + ")`|(?<![\\w-])(?:" + noms + ")\\(|« voir : ");
  const PERMIS: Record<string, string[]> = { "*": ["fil `tickets`"], "missions/depot.md": ["`essai`"] };
  const racine = new URL("../", import.meta.url).pathname;
  const fichiers = ["src/consignes-salle.md", ...readdirSync(join(racine, "missions")).filter((f) => f.endsWith(".md")).map((f) => `missions/${f}`)];

  test("la règle reconnaît un nom entre accents graves, suivi de « ( », ou l'ancien en-tête de voir", () => {
    expect(COMME_OUTIL.test("tu as appelé `fini` avec")).toBe(true);
    expect(COMME_OUTIL.test("relis boite(fil)")).toBe(true);
    expect(COMME_OUTIL.test("il a rendu « voir : 0 »")).toBe(true);
    expect(COMME_OUTIL.test("il a rendu « page_voir : 0 »")).toBe(false);
    expect(COMME_OUTIL.test("`equipe.csv` : `nom;metier`")).toBe(false);
    expect(COMME_OUTIL.test("node {DEPOT}/src/voir.ts --partage . index.html")).toBe(false);
  });

  test.each(fichiers)("%s", (f) => {
    const trouves: string[] = [];
    readFileSync(join(racine, f), "utf8").split("\n").forEach((ligne, i) => {
      let l = ligne;
      for (const p of [...PERMIS["*"]!, ...(PERMIS[f] ?? [])]) l = l.replaceAll(p, "");
      if (COMME_OUTIL.test(l)) trouves.push(`${f}:${i + 1} ${ligne.slice(0, 120)}`);
    });
    expect(trouves).toEqual([]);
  });
});

// Les trois outils de fil retirés ne se lisent plus dans ce que voient les agents — littéraux de src/ hors
// commentaires, consignes, missions —, ni le paramètre reveil_fil de moi_dormir, qui ne servait qu'à un agent entré dans
// un fil. tableau.ts et serveur.ts sont hors du relevé : T.entrer et T.quitter restent pour fabriquer les runs d'avant
// (aucun outil ne les appelle plus), et la vue lit toujours leurs présences.
describe("O1 : les outils de fil retirés ont quitté les textes des agents", () => {
  const LITTERAL = /(["'`])(?:\\.|(?!\1)[^\\])*\1/g;
  const RETIRE = new RegExp(`(?:${[...OUTILS_RETIRES, "reveil_fil"].join("|")})`);
  const racine = new URL("../", import.meta.url).pathname;
  const sources = readdirSync(join(racine, "src")).filter((f) => f.endsWith(".ts") && !["noms-outils.ts", "tableau.ts", "serveur.ts"].includes(f)).map((f) => `src/${f}`);
  const textes = ["src/consignes-salle.md", ...readdirSync(join(racine, "missions")).filter((f) => f.endsWith(".md")).map((f) => `missions/${f}`)];

  test.each(sources)("%s", (f) => {
    const trouves: string[] = [];
    readFileSync(join(racine, f), "utf8").split("\n").forEach((ligne, i) => {
      if (ligne.trim().startsWith("//")) return;
      for (const m of ligne.matchAll(LITTERAL)) if (RETIRE.test(m[0])) trouves.push(`${f}:${i + 1} ${m[0].slice(0, 120)}`);
    });
    expect(trouves).toEqual([]);
  });
  test.each(textes)("%s", (f) => {
    const trouves = readFileSync(join(racine, f), "utf8").split("\n").flatMap((l, i) => (RETIRE.test(l) ? [`${f}:${i + 1} ${l.slice(0, 120)}`] : []));
    expect(trouves).toEqual([]);
  });
});
