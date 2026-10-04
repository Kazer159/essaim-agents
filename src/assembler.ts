// Assembler : les agents écrivent des modules qui s'importent (`import { jouer } from "./sim.js"`), et la page
// livrée reste un seul fichier qui s'ouvre en double-clic. Un script `type="module"` ne se charge pas depuis file://
// (Chrome le refuse) : c'est ce qui forçait chaque salle à tout poser dans un espace global partagé (`LUMEN.*`,
// `SORLAC.*`), dans un ordre de chargement fragile, avec des astuces pour tester. Ici, chaque script module de la page
// source est rassemblé par `bun build` en un seul script classique, collé dans la page de sortie. Rien à télécharger.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { normaliserChemin } from "./tableau.ts";

// invalide : un refus (chemin, page ou script invalide, script qui ne se rassemble pas) ; un code 1 sans invalide est
// une panne (bun absent ou arrêté), levée en erreur par l'outil.
export type Assemblage = { code: 0 | 1; texte: string; invalide?: boolean };
const refus = (texte: string): Assemblage => ({ code: 1, invalide: true, texte });

const MODULE = /<script\b([^>]*\btype\s*=\s*["']module["'][^>]*)\bsrc\s*=\s*["']([^"']+)["']([^>]*)>\s*<\/script>|<script\b([^>]*)\bsrc\s*=\s*["']([^"']+)["']([^>]*\btype\s*=\s*["']module["'][^>]*)>\s*<\/script>/gi;

// Un script collé dans la page ne doit pas fermer sa balise trop tôt.
const coller = (js: string) => js.replace(/<\/script/gi, "<\\/script");

export function assembler(partage: string, source: string, sortie = "index.html", bun = process.env.ESSAIM_BUN ?? "bun"): Assemblage {
  const racine = resolve(partage);
  const src = normaliserChemin(source), dst = normaliserChemin(sortie);
  if (!src || !dst) return refus("la page source ou la page de sortie est hors du dossier partagé. Définitif pour ces chemins");
  if (src === dst) return refus("la page de sortie est la page source. Se lève avec une sortie différente");
  const cheminSource = join(racine, src);
  if (!existsSync(cheminSource) || !lstatSync(cheminSource).isFile()) return refus(`${src} est introuvable dans le dossier partagé. Se lève quand le fichier existe`);
  const html = readFileSync(cheminSource, "utf8");
  const scripts = [...html.matchAll(MODULE)].map((m) => ({ balise: m[0], src: (m[2] ?? m[5])! }));
  if (scripts.length === 0) return refus(`${src} ne contient aucun <script type="module" src="…">. Se lève quand la page en contient un`);
  const tmp = mkdtempSync(join(tmpdir(), "essaim-assembler-"));
  try {
    const entrees: string[] = [];
    for (const s of scripts) {
      const entree = resolve(dirname(cheminSource), s.src);
      if (!entree.startsWith(racine + "/")) return refus(`le script ${s.src} est hors du dossier partagé. Définitif pour ce chemin`);
      if (!existsSync(entree)) return refus(`le script ${s.src} est introuvable. Se lève quand le fichier existe`);
      entrees.push(entree);
    }
    // Un seul paquet qui importe chaque entrée dans l'ordre de la page : assemblées à part, deux entrées copiaient
    // chacune un module partagé, dont l'état ne l'était plus. Un module s'évalue une fois, comme dans la source.
    const entreeUnique = join(tmp, "entrees.js");
    writeFileSync(entreeUnique, entrees.map((e) => `import ${JSON.stringify(e)};`).join("\n") + "\n");
    const sortieJs = join(tmp, "page.js");
    const r = spawnSync(bun, ["build", entreeUnique, "--outfile", sortieJs, "--target", "browser", "--format", "iife"], { encoding: "utf8", cwd: racine, timeout: 60_000 });
    if (r.error) return { code: 1, texte: `page_assembler : bun build n'a pas tourné : ${r.error.message}` }; // bun absent ou arrêté : panne
    const noms = scripts.map((x) => x.src).join(", ");
    if (r.status !== 0 || !existsSync(sortieJs)) {
      const erreur = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() || "bun build a échoué";
      return refus(`${scripts.length > 1 ? `les scripts ${noms} ne se rassemblent pas` : `le script ${noms} ne se rassemble pas`}. Se lève quand le script se rassemble\n${erreur.slice(0, 3000)}`);
    }
    const js = readFileSync(sortieJs, "utf8");
    // Les balises module retirées, le script collé en fin de <body> : un module s'exécute après la lecture de la
    // page ; collé à sa place dans <head>, le script classique tournait avant que <body> existe.
    let page = html;
    for (const s of scripts) page = page.replace(s.balise, "");
    const colle = `<script>\n${coller(js)}\n</script>`;
    const finBody = page.search(/<\/body>/i);
    page = finBody === -1 ? `${page}\n${colle}\n` : `${page.slice(0, finBody)}${colle}\n${page.slice(finBody)}`;
    // Une sortie hors du dossier de la source : ses liens relatifs (styles, images, fetch) visaient le dossier de
    // la source ; un <base> les y ramène, la page se comporte comme la source.
    const versSource = relative(dirname(join(racine, dst)), dirname(cheminSource)).split(sep).join("/");
    if (versSource && !/<base\b/i.test(page)) {
      const base = `<base href="${versSource}/">`;
      const tete = /<head\b[^<>]*>/i.exec(page);
      page = tete ? page.replace(tete[0], `${tete[0]}${base}`) : page.replace(/^(\s*<!doctype[^<>]*>)?/i, (d) => `${d}${base}`);
    }
    writeFileSync(join(racine, dst), page);
    const lignes = scripts.map((x) => `- ${x.src}`);
    return { code: 0, texte: [`page_assembler : ${dst} écrit depuis ${src} (${Math.round(page.length / 1024)} Ko), ${scripts.length} script${scripts.length > 1 ? "s" : ""} module rassemblé${scripts.length > 1 ? "s" : ""} en un script de ${Math.round(js.length / 1024)} Ko, en fin de page :`, ...lignes, "Les feuilles de style et les images restent des fichiers à côté."].join("\n") };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
