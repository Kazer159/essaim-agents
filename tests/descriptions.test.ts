// Outils des agents : chaque outil de la salle suit le même modèle de description, et aucun
// texte lu par le modèle ne lui dit quand ni comment se servir d'un outil. Les contrôles portent sur les
// définitions réellement enregistrées par l'extension, pas sur la source recopiée ; seule la présence d'un refus dans
// le code se lit dans la source, bloc par bloc.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ouvrirBun } from "../src/tableau-bun.ts";
import * as T from "../src/tableau.ts";
import { fauxPi } from "./aide/faux-extension-api.ts";
import extension from "../src/outils-essaim.ts";
import seResumer from "../src/se-resumer.ts";
import { nomsSalle, OUTILS_ROLES } from "../src/noms-outils.ts";

// La liste des tournures interdites vit dans tests/aide/mots-interdits.ts, partagée avec le test des consignes.
import { motsInterdits } from "./aide/mots-interdits.ts";

type Schema = { properties?: Record<string, { description?: string }>; required?: string[] };
type Definition = { name: string; description: string; promptSnippet?: string; parameters: Schema };

// Les blocs pi.registerTool({ … }) de la source, par nom d'outil : du début du bloc à sa fermeture « }); » au même
// retrait.
function blocs(fichier: string): Map<string, string> {
  const lignes = readFileSync(new URL(`../src/${fichier}`, import.meta.url), "utf8").split("\n");
  const r = new Map<string, string>();
  for (let i = 0; i < lignes.length; i++) {
    const m = lignes[i]!.match(/^(\s*)pi\.registerTool\(\{/);
    if (!m) continue;
    const fin = lignes.findIndex((l, j) => j > i && l === `${m[1]}});`);
    const bloc = lignes.slice(i, fin + 1).join("\n");
    r.set(bloc.match(/name: "([a-z_]+)"/)![1]!, bloc);
  }
  return r;
}

let dossier: string;
let definitions: Definition[] = [];
const sources = new Map([...blocs("outils-essaim.ts"), ...blocs("se-resumer.ts")]);

beforeAll(() => {
  dossier = mkdtempSync(join(tmpdir(), "essaim-descriptions-"));
  const chemin = join(dossier, "tableau.sqlite");
  mkdirSync(join(dossier, "partage"));
  const t = ouvrirBun(chemin);
  T.initialiser(t);
  T.ouvrirRun(t, { id: "run-test", missionChemin: "m.md", missionTexte: "texte", modele: "faux/faux", plafondUsd: 0.5, silenceMin: 15 });
  T.ajouterAgent(t, "agent-01", join(dossier, "agents", "agent-01"));
  t.fermer();
  // Avec un rôle : les outils des exigences et des preuves sont lus eux aussi.
  const env = { ESSAIM_AGENT: "agent-01", ESSAIM_TABLEAU: chemin, ESSAIM_PARTAGE: join(dossier, "partage"), ESSAIM_COMPACTAGE: "80000,120000,160000", ESSAIM_ROLE: "chef" };
  const avant = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    // Chaque rôle n'a que ses outils : l'union des sept rôles (le surveillant en dernier).
    const parNom = new Map<string, Definition>();
    for (const role of ["chef", "integrateur", "assembleur", "constructeur", "recette", "gardien", "surveillant"]) {
      process.env.ESSAIM_ROLE = role;
      const pi = fauxPi();
      extension(pi.api, ouvrirBun);
      seResumer(pi.api);
      for (const n of pi.noms()) parNom.set(n, pi.definition(n) as unknown as Definition);
    }
    definitions = [...parNom.values()];
  } finally {
    for (const [k, v] of Object.entries(avant)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});
afterAll(() => rmSync(dossier, { recursive: true, force: true }));

describe("T2 : le modèle de description (§4)", () => {
  test("les 28 outils de la salle et ceux des rôles sont lus, chacun avec son bloc dans la source", () => {
    expect(definitions).toHaveLength(28 + OUTILS_ROLES.length);
    expect(definitions.map((d) => d.name).sort()).toEqual(nomsSalle(true, true, true).sort());
    for (const d of definitions) expect(sources.has(d.name)).toBe(true);
  });

  test("le résumé court : nom(paramètres) : phrase, sur une ligne, paramètres du schéma dans l'ordre, ? pour un facultatif", () => {
    for (const d of definitions) {
      const requis = new Set(d.parameters.required ?? []);
      const params = Object.keys(d.parameters.properties ?? {}).map((k) => (requis.has(k) ? k : `${k}?`)).join(", ");
      expect(d.promptSnippet, d.name).toStartWith(`${d.name}(${params}) : `);
      expect(d.promptSnippet!.length, d.name).toBeGreaterThan(`${d.name}(${params}) : `.length);
      expect(d.promptSnippet, d.name).not.toContain("\n");
      expect(d.promptSnippet!.endsWith("."), d.name).toBe(false);
    }
  });

  test("le résumé court de salle_poster dit où va le message par défaut (E3)", () => {
    expect(definitions.find((d) => d.name === "salle_poster")!.promptSnippet)
      .toBe("salle_poster(texte, fil?) : écrire un message ; sans fil, dans principal");
  });

  test("la description commence par un verbe à l'infinitif", () => {
    const EXCEPTIONS: string[] = [];
    for (const d of definitions) {
      const premier = d.description.split(/[\s,.:;]/)[0]!.toLowerCase();
      if (EXCEPTIONS.includes(premier)) continue;
      expect(premier, d.name).toMatch(/(er|ir|re|oir)$/);
    }
  });

  test("la description contient « Rend : », et « Refus : » si et seulement si le code de l'outil refuse", () => {
    for (const d of definitions) {
      expect(d.description, d.name).toContain("Rend : ");
      const refuse = /refusé|refuse\(/.test(sources.get(d.name)!);
      expect(d.description.includes("Refus : "), `${d.name} : le code ${refuse ? "refuse" : "ne refuse pas"}`).toBe(refuse);
      // « Refus : » vient en dernier : ses cas, séparés par « ; », seront comptés contre les tests qui les provoquent.
      if (refuse) expect(d.description.indexOf("Refus : "), d.name).toBeGreaterThan(d.description.indexOf("Rend : "));
    }
  });

  test("chaque paramètre a une description non vide dans le schéma", () => {
    for (const d of definitions)
      for (const [k, p] of Object.entries(d.parameters.properties ?? {}))
        expect(p.description?.trim().length ?? 0, `${d.name}.${k}`).toBeGreaterThan(0);
  });
});

// Les littéraux de chaîne d'un fichier source, hors commentaires : guillemets, apostrophes et gabarits (le texte
// hors des ${…}, les gabarits imbriqués compris). Un « / » après un opérateur ouvre une expression régulière, sautée.
function litteraux(source: string): Array<{ ligne: number; texte: string }> {
  const r: Array<{ ligne: number; texte: string }> = [];
  let i = 0;
  const ligne = (k: number) => source.slice(0, k).split("\n").length;
  const avantRegex = (k: number) => { let j = k - 1; while (j >= 0 && /\s/.test(source[j]!)) j--; return j < 0 || /[(,=:[!&|?{};+\-*%<>~^]/.test(source[j]!) || /\breturn$/.test(source.slice(Math.max(0, j - 5), j + 1)); };
  const chaine = (q: string): string => { let t = ""; i++; while (i < source.length && source[i] !== q) { if (source[i] === "\\") { t += source[i + 1]; i += 2; continue; } t += source[i++]; } i++; return t; };
  const gabarit = (): string => {
    let t = ""; i++;
    while (i < source.length && source[i] !== "`") {
      if (source[i] === "\\") { t += source[i + 1]; i += 2; continue; }
      if (source[i] === "$" && source[i + 1] === "{") { i += 2; code(1); t += " "; continue; }
      t += source[i++];
    }
    i++;
    return t;
  };
  // Parcourt du code jusqu'à la fermeture de `profondeur` accolades (0 : jusqu'à la fin).
  const code = (profondeur: number) => {
    let d = profondeur;
    while (i < source.length) {
      const c = source[i]!, n = source[i + 1];
      if (c === "/" && n === "/") { while (i < source.length && source[i] !== "\n") i++; continue; }
      if (c === "/" && n === "*") { i = source.indexOf("*/", i + 2) + 2; continue; }
      if (c === "/" && avantRegex(i)) { i++; let classe = false; while (i < source.length && (classe || source[i] !== "/")) { if (source[i] === "\\") i++; else if (source[i] === "[") classe = true; else if (source[i] === "]") classe = false; i++; } i++; continue; }
      if (c === '"' || c === "'") { const k = i; r.push({ ligne: ligne(k), texte: chaine(c) }); continue; }
      if (c === "`") { const k = i; r.push({ ligne: ligne(k), texte: gabarit() }); continue; }
      if (c === "{") d++;
      if (c === "}") { d--; if (profondeur > 0 && d === 0) { i++; return; } }
      i++;
    }
  };
  code(0);
  return r;
}

// Les fichiers dont les textes vont aux agents, et les trois messages du lanceur.
// memoire.ts (second cerveau) : les réponses et refus de salle_chercher, puis l'état et la ligne courte.
const FICHIERS_GABARITS = ["outils-essaim.ts", "se-resumer.ts", "outils-travail.ts", "voir.ts", "mesurer.ts", "assembler.ts", "depot.ts", "tableau.ts", "processus.ts", "memoire.ts"];
const HORS_CHANTIER = ["Ne répète pas la même action", "Appelle les outils par leur nom exact", "Relis seulement la capture dont"];

describe("T3 : aucun mot interdit (D4)", () => {
  test("la liste attrape les ordres et laisse passer les faits", () => {
    expect(motsInterdits("Lis-le d'abord")).not.toEqual([]);
    expect(motsInterdits("dis dans le fil ce que tu en retiens")).not.toEqual([]);
    expect(motsInterdits("tu ne restaures jamais deux fichiers")).not.toEqual([]);
    expect(motsInterdits("le dépôt du run a disparu")).toEqual([]);
    expect(motsInterdits("une branche n'est jamais effacée")).toEqual([]);
  });

  test("le lecteur de littéraux lit les chaînes et gabarits, pas les commentaires ni les expressions régulières", () => {
    const lus = litteraux("// « dis-le » en commentaire\nconst a = \"un\"; /* 'non' */ const r = /l'a/; const b = `x ${f(`y ${'z'}`)} w`;").map((l) => l.texte);
    expect(lus.sort()).toEqual(["un", "x   w", "y  ", "z"].sort());
  });

  test("ni dans les réponses, les refus et les notifications écrits par l'essaim (G9)", () => {
    const fautes: string[] = [];
    for (const f of FICHIERS_GABARITS) {
      const source = readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
      for (const l of litteraux(source)) {
        if (HORS_CHANTIER.some((h) => l.texte.includes(h))) continue;
        const m = motsInterdits(l.texte);
        if (m.length) fautes.push(`${f}:${l.ligne} ${m.join(", ")} · ${l.texte.slice(0, 120)}`);
      }
    }
    expect(fautes).toEqual([]);
  });

  test("ni dans les descriptions, ni dans les résumés courts, ni dans les descriptions de paramètres", () => {
    for (const d of definitions) {
      const textes: Array<[string, string]> = [["description", d.description], ["promptSnippet", d.promptSnippet ?? ""],
        ...Object.entries(d.parameters.properties ?? {}).map(([k, p]) => [k, p.description ?? ""] as [string, string])];
      for (const [ou, texte] of textes) expect(motsInterdits(texte), `${d.name} · ${ou}`).toEqual([]);
    }
  });
});

// Rôles des agents : les consignes d'un rôle disent sa mission, ses droits et ses refus, jamais une méthode.
describe("T3 : les consignes des rôles, sans tournure interdite (D4)", () => {
  test.each(["chef", "integrateur", "assembleur", "constructeur", "recette", "gardien", "surveillant"])("src/roles/%s.md", (role) => {
    const texte = readFileSync(new URL(`../src/roles/${role}.md`, import.meta.url), "utf8");
    expect(texte).toContain("{EQUIPE}");
    expect(motsInterdits(texte)).toEqual([]);
  });
});
