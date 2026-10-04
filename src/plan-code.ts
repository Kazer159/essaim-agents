// La carte du livrable : quels fichiers, ce que chacun définit, qui s'en sert, qui l'a écrit, dans quel
// ordre la page les charge. Sans elle, un agent ignore ce qu'un autre a déjà posé et l'écrit une seconde fois. Lecture seule, par expressions régulières : une carte, pas
// un compilateur — elle peut rater un nom construit à la volée, jamais en inventer un.
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import type { Tableau } from "./tableau.ts";

const CODE = new Set([".js", ".mjs", ".cjs", ".ts", ".jsx", ".tsx"]);
const LUS = new Set([...CODE, ".html", ".css"]);
const IGNORES = new Set(["node_modules", ".git"]);
const PLAN_MAX = 12_000; // la carte se lit en une fois ; au-delà, elle coûterait plus qu'elle n'apprend
const TAILLE_MAX = 400_000; // une bibliothèque posée telle quelle (three.js) n'est pas cartographiée, seulement nommée

export type Fichier = { chemin: string; lignes: number; definit: string[]; bibliotheque: boolean };

function lister(racine: string, dossier = racine, sortie: string[] = []): string[] {
  for (const nom of readdirSync(dossier).sort()) {
    if (IGNORES.has(nom) || nom.startsWith(".")) continue;
    const chemin = join(dossier, nom);
    const st = lstatSync(chemin);
    if (st.isDirectory()) lister(racine, chemin, sortie);
    else if (st.isFile() && LUS.has(extname(nom))) sortie.push(relative(racine, chemin));
  }
  return sortie;
}

// Les noms qu'un fichier de code définit à son niveau (au plus deux espaces de retrait : le corps d'un module
// enveloppé dans une fonction compte, les variables locales d'une fonction non) : fonctions, classes, constantes, exports, et les
// propriétés posées sur un espace partagé (`LUMEN.solveur = …`, `window.SORLAC.sim = …`).
export function definitions(code: string): string[] {
  const noms = new Set<string>();
  const motifs = [
    /^(?: {0,2}|\t)(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm,
    /^(?: {0,2}|\t)(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/gm,
    /^(?: {0,2}|\t)(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm,
    /^(?: {0,2}|\t)(?:window\.)?([A-Z][A-Za-z0-9_$]*(?:\.[A-Za-z_$][\w$]*)+)\s*=(?!=)/gm,
  ];
  for (const m of motifs) for (const r of code.matchAll(m)) noms.add(r[1]!);
  return [...noms];
}

// L'auteur d'un fichier, lu dans la trace : qui l'a écrit ou modifié, et combien de fois.
function auteurs(t: Tableau | undefined, chemin: string): string {
  if (!t) return "";
  const lignes = t.all<{ agent: string; n: number }>(
    `SELECT agent, COUNT(*) AS n FROM evenements
     WHERE type = 'tool_execution_start' AND outil IN ('write', 'edit') AND arguments_json LIKE ?
     GROUP BY agent ORDER BY n DESC, agent`, [`%${chemin.replaceAll("%", "")}%`]);
  return lignes.map((l) => `${l.agent} ×${l.n}`).join(", ");
}

export function planDuCode(partage: string, t?: Tableau): string {
  if (!existsSync(partage)) return "dossier partagé introuvable";
  const chemins = lister(partage);
  if (chemins.length === 0) return "le dossier partagé ne contient encore aucun fichier de code, de style ou de page";
  const textes = new Map(chemins.map((c) => {
    const p = join(partage, c);
    return [c, lstatSync(p).size > TAILLE_MAX ? undefined : readFileSync(p, "utf8")] as const;
  }));
  const fichiers: Fichier[] = chemins.map((c) => {
    const texte = textes.get(c);
    return { chemin: c, lignes: texte ? texte.split("\n").length : 0, definit: texte && CODE.has(extname(c)) ? definitions(texte) : [], bibliotheque: texte === undefined };
  });
  const sortie: string[] = [`${fichiers.length} fichiers dans le dossier partagé`];

  // L'ordre de chargement de chaque page : c'est lui qui décide si un nom existe quand un script s'en sert. Les fichiers
  // oubliés ne se cherchent que pour la page qui charge le plus de scripts (une page de preuve ne charge pas tout).
  const pages = chemins.filter((c) => extname(c) === ".html");
  const nScripts = (c: string) => [...(textes.get(c) ?? "").matchAll(/<script\b[^>]*\bsrc\s*=/gi)].length;
  const principale = [...pages].sort((a, b) => nScripts(b) - nScripts(a))[0];
  // Une adresse de la page vers un fichier du dossier : sans ?v=3 ni #ancre ; « //cdn… » est externe comme https:.
  const externe = (s: string) => /^([a-z]+:|\/\/)/i.test(s);
  const fichierDe = (depuis: string, s: string) => join(depuis, "..", s.replace(/[?#].*$/, "")).replace(/^\.\//, "");
  // Ce qu'un module importe, de proche en proche : sans cela, chaque module d'une page en modules paraîtrait oublié.
  const IMPORT = /\bimport\s*(?:[^'"();]*?\bfrom\s*)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  const suivreImports = (depart: string[]) => {
    const vus = new Set(depart), file = [...depart];
    for (let c = file.shift(); c !== undefined; c = file.shift()) {
      for (const m of (textes.get(c) ?? "").matchAll(IMPORT)) {
        const s = (m[1] ?? m[2])!;
        if (!s.startsWith(".")) continue;
        const f = fichierDe(c, s);
        if (chemins.includes(f) && !vus.has(f)) { vus.add(f); file.push(f); }
      }
    }
    return vus;
  };
  for (const page of pages) {
    const html = textes.get(page) ?? "";
    const scripts = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]!);
    const feuilles = [...html.matchAll(/<link\b[^>]*\bhref\s*=\s*["']([^"']+\.css)(?:[?#][^"']*)?["']/gi)].map((m) => m[1]!);
    const absents = [...scripts, ...feuilles].filter((s) => !externe(s) && !chemins.includes(fichierDe(page, s)));
    sortie.push("", `page ${page} : charge ${scripts.length} script${scripts.length > 1 ? "s" : ""} dans cet ordre${scripts.length ? " : " + scripts.join(" → ") : ""}${feuilles.length ? ` ; styles : ${feuilles.join(", ")}` : ""}`);
    if (absents.length) sortie.push(`  introuvables : ${absents.join(", ")}`);
    const charges = suivreImports([...scripts.filter((s) => !externe(s)).map((s) => fichierDe(page, s)), page]); // la page : ses modules en ligne
    const oublies = chemins.filter((c) => CODE.has(extname(c)) && !charges.has(c) && !/(^|\/)(tests?|spec)\//.test(c) && !/\.(test|spec)\./.test(c));
    if (oublies.length && page === principale) sortie.push(`  fichiers de code que cette page ne charge pas : ${oublies.join(", ")}`);
  }

  // Les noms publics définis deux fois d'abord : c'est ce qui casse une page chargée d'un bloc, et ça ne doit pas
  // disparaître si la carte est tronquée.
  const doublons = new Map<string, string[]>();
  for (const f of fichiers) for (const n of f.definit) doublons.set(n, [...(doublons.get(n) ?? []), f.chemin]);
  const deuxFois = [...doublons].filter(([n, fs]) => fs.length > 1 && (n.includes(".") || n.length >= 6)); // publics seulement
  if (deuxFois.length) sortie.push("", "noms définis dans plusieurs fichiers (le dernier chargé gagne, sauf si chaque fichier est enveloppé dans sa propre fonction) :", ...deuxFois.map(([n, fs]) => `- ${n} : ${fs.join(", ")}`));

  // Les mots de chaque fichier, relevés une fois : une expression par nom et par fichier coûterait des dizaines de
  // secondes pour mille fichiers, et gèlerait code_carte sur une bibliothèque recopiée hors de node_modules.
  const mots = new Map<string, Set<string>>();
  const definisParFichier = new Map(fichiers.map((x) => [x.chemin, new Set(x.definit)]));
  const VIDE = new Set<string>();
  const motsDe = (c: string) => { let m = mots.get(c); if (!m) { m = new Set(textes.get(c)?.match(/[A-Za-z_$][\w$]*/g) ?? []); mots.set(c, m); } return m; };
  // Chaque fichier : ce qu'il définit, qui s'en sert ailleurs (approximatif : par le nom), qui l'a écrit.
  sortie.push("", "fichiers :");
  for (const f of fichiers) {
    const qui = auteurs(t, f.chemin);
    if (f.bibliotheque) { sortie.push(`- ${f.chemin} : bibliothèque, non détaillée${qui ? ` · écrit par ${qui}` : ""}`); continue; }
    // Ce que d'autres fichiers de code appellent : un nom de six lettres au moins, cité en entier. Les noms courts
    // (F, C, idx) se retrouvent partout, et une méthode d'espace partagé (`.html`, `.lignes`) aussi : ils ne prouvent rien.
    const publics = f.definit.filter((n) => n.includes(".") || n.length >= 6);
    const citables = f.definit.filter((n) => !n.includes(".") && n.length >= 6);
    const cite = (n: string, c: string) => motsDe(c).has(n);
    const definisPar = (c: string) => definisParFichier.get(c) ?? VIDE;
    const utilisateurs = chemins.filter((c) => c !== f.chemin && CODE.has(extname(c)) && textes.get(c) !== undefined
      && citables.some((n) => !definisPar(c).has(n) && cite(n, c))); // le définir aussi n'est pas s'en servir
    const tests = utilisateurs.filter((c) => /(^|\/)(tests?|spec)\//.test(c) || /\.(test|spec)\./.test(c));
    const code = utilisateurs.filter((c) => !tests.includes(c));
    const montres = [...publics, ...f.definit.filter((n) => !publics.includes(n))];
    const defs = montres.length ? ` · définit ${montres.slice(0, 8).join(", ")}${montres.length > 8 ? ` (+${montres.length - 8})` : ""}` : "";
    const usage = code.length || tests.length ? ` · utilisé par ${[code.join(", "), tests.length ? `${tests.length} fichier${tests.length > 1 ? "s" : ""} de tests` : ""].filter(Boolean).join(" et ")}` : "";
    sortie.push(`- ${f.chemin} (${f.lignes} lignes)${defs}${usage}${qui ? ` · écrit par ${qui}` : ""}`);
  }
  const tout = sortie.join("\n");
  return tout.length > PLAN_MAX ? tout.slice(0, PLAN_MAX) + "\n… (carte tronquée : demande un dossier plus précis)" : tout;
}
