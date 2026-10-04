// Deux outils de travail qui font économiser des tokens.
// tester : les tests d'un fichier (ou de tout le dossier partagé), et seulement ce qui échoue — un `bun test` complet
// renvoie des pages que l'agent paie en entier. lire_web : une page web en texte, sans le HTML autour, plutôt
// qu'un curl qui rend menus et scripts compris.
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { normaliserChemin } from "./tableau.ts";

const TESTER_MAX = 5000;
const WEB_MAX = 8000;

const NOMS_MAX = 30;
const DERNIERES = 20;

const pluriel = (n: number, un: string, plusieurs: string) => `${n} ${n > 1 ? plusieurs : un}`;
const secondes = (s: number) => `${s.toFixed(s < 1 ? 2 : 1).replace(".", ",")} s`;

// Le bilan de bun test, en nombres : lu dans ses lignes « N pass », « N fail », « N error(s) »… et
// « Ran N tests across … [0.60s] » (durée facultative : une sortie coupée peut la perdre). Codes ANSI retirés. Un
// compteur absent reste absent : `| tail -3` peut ne garder que « 0 fail », « expect() calls » et « Ran 71 tests ».
export type Bilan = { pass?: number; fail?: number; error?: number; skip?: number; todo?: number; ran?: number; duree?: number };
export function lireBilan(lignes: string[]): Bilan {
  const n: Bilan = {};
  for (const brute of lignes) {
    const l = brute.replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
    const m = /^\s*(\d+) (pass|fail|skip|todo|error)s?$/.exec(l);
    if (m) { n[m[2] as "pass"] = Number(m[1]); continue; }
    const r = /^Ran (\d+) tests?\b(?:.*\[([\d.]+)(ms|s)\])?/.exec(l);
    if (r && n.ran === undefined) {
      n.ran = Number(r[1]);
      if (r[2]) n.duree = Number(r[2]) / (r[3] === "ms" ? 1000 : 1);
    }
  }
  return n;
}

// Le bilan mis en texte pour code_tester, comme avant le bilan chiffré (« 0 réussi » quand pass manque) ; undefined
// quand ni pass ni fail n'est lu.
export function texteBilan(n: Bilan): string | undefined {
  if (n.pass === undefined && n.fail === undefined) return undefined;
  const morceaux = [pluriel(n.pass ?? 0, "réussi", "réussis"), pluriel(n.fail ?? 0, "échoué", "échoués")];
  if (n.error) morceaux.push(pluriel(n.error, "erreur", "erreurs"));
  if (n.skip) morceaux.push(pluriel(n.skip, "ignoré", "ignorés"));
  if (n.todo) morceaux.push(`${n.todo} à faire`);
  if (n.duree !== undefined) morceaux.push(secondes(n.duree));
  return morceaux.join(" · ");
}

// code_tester : sans detail, le bilan puis le nom de chaque échec (30 au plus) ; avec detail, le bloc
// d'erreur qui précède chaque « (fail) ». Les erreurs hors d'un test (« Unhandled error », un fichier qui ne se
// charge pas) sont gardées dans les deux cas ; sans aucun test nommé, les dernières lignes de la sortie.
// invalide : un paramètre invalide, rendu en refus par l'outil ; les autres codes sont des résultats.
export function tester(partage: string, fichier?: string, bun = process.env.ESSAIM_BUN ?? "bun", o: { detail?: boolean; delaiMs?: number } = {}): { code: number; texte: string; invalide?: boolean; bilan?: Bilan } {
  const racine = resolve(partage);
  let cible = "./"; // la barre oblique compte : sans elle, bun test filtre par sous-chaîne
  if (fichier) {
    const propre = normaliserChemin(fichier);
    if (!propre || !existsSync(join(racine, propre))) return { code: 2, invalide: true, texte: `${fichier} est introuvable dans le dossier partagé. Se lève quand le fichier existe` };
    cible = `./${propre}`;
  }
  const delaiMs = o.delaiMs ?? 120_000;
  // La sortie va dans des fichiers, pas dans un tuyau : un processus laissé en fond par un test tiendrait le tuyau,
  // et spawnSync attendrait tout le délai pour annoncer à tort « dépassé » ; au-delà d'1 Mio, bun test serait tué (ENOBUFS)
  // et l'échec masqué. On rend la main quand bun sort ; ce qui reste en fond, le ramassage du lanceur le prend.
  const temp = mkdtempSync(join(tmpdir(), "essaim-tester-"));
  const [fOut, fErr] = [join(temp, "sortie"), join(temp, "erreurs")];
  const [dOut, dErr] = [openSync(fOut, "w"), openSync(fErr, "w")];
  let r: ReturnType<typeof spawnSync>, sortie: string;
  try {
    r = spawnSync(bun, ["test", cible], { cwd: racine, stdio: ["ignore", dOut, dErr], timeout: delaiMs, env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" } });
  } finally { closeSync(dOut); closeSync(dErr); }
  try { sortie = `${readFileSync(fOut, "utf8")}\n${readFileSync(fErr, "utf8")}`; } finally { rmSync(temp, { recursive: true, force: true }); }
  const lignes = sortie.replace(/\x1b\[[0-9;]*m/g, "").split("\n");
  const dernieres = () => lignes.filter((l) => l.trim()).slice(-DERNIERES);
  if (r.status === null && r.error && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    return tronquer({ code: 1, bilan: lireBilan(lignes), texte: [`${cible} a dépassé ${String(delaiMs / 1000).replace(".", ",")} s, arrêté`, ...dernieres()].join("\n") });
  }
  // Bun écrit le détail d'une erreur juste avant sa ligne « (fail) » ; une erreur hors test, entre deux lignes de tirets.
  const noms: string[] = [];
  const echecs: string[] = [];
  const horsTest: string[] = [];
  let bloc: string[] = [];
  let horsTestEnCours: string[] | undefined;
  for (const l of lignes) {
    if (horsTestEnCours) {
      horsTestEnCours.push(l);
      if (/^-{5,}$/.test(l) && horsTestEnCours.length > 2) { horsTest.push(horsTestEnCours.filter((x) => x.trim() && !/^-{5,}$/.test(x)).join("\n")); horsTestEnCours = undefined; }
      continue;
    }
    if (/^# Unhandled error/.test(l)) { horsTestEnCours = [l]; continue; }
    if (/^\((pass|skip|todo)\)/.test(l)) { bloc = []; continue; }
    if (/^\(fail\)/.test(l)) {
      noms.push(l.replace(/\s*\[[\d.]+m?s\]\s*$/, ""));
      echecs.push([...bloc.slice(-12), l].filter((x) => x.trim() !== "").join("\n"));
      bloc = [];
      continue;
    }
    bloc.push(l);
  }
  const code = r.status ?? 1;
  const chiffres = lireBilan(lignes);
  const bilan = texteBilan(chiffres);
  const parties = [bilan ?? `code ${code}, aucun bilan lu`];
  if (o.detail) parties.push(...echecs.map((e) => `\n${e}`));
  else if (noms.length) parties.push(...noms.slice(0, NOMS_MAX), ...(noms.length > NOMS_MAX ? [`… et ${noms.length - NOMS_MAX} autres`] : []));
  if (horsTest.length) parties.push(...horsTest.map((e) => `\n${e.split("\n").slice(0, DERNIERES).join("\n")}`));
  else if (!noms.length && (code !== 0 || !bilan)) parties.push(...dernieres());
  return tronquer({ code, bilan: chiffres, texte: parties.join("\n") });
}

const tronquer = <R extends { code: number; texte: string }>(r: R): R =>
  r.texte.length > TESTER_MAX ? { ...r, texte: r.texte.slice(0, TESTER_MAX) + "\n… (tronqué à 5 000 caractères)" } : r;

const ENTITES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", eacute: "é", egrave: "è", agrave: "à", ccedil: "ç", rsquo: "’", laquo: "«", raquo: "»", hellip: "…", mdash: "—", ndash: "–" };

// Le texte d'une page HTML : le titre, les titres de section, les paragraphes, les listes, les blocs de code.
// Retirer les blocs ouvre…ferme par positions, pas par une expression paresseuse : sur des balises jamais fermées
// (« <nav <nav <nav… »), celle-ci repartirait de chaque ouverture jusqu'au bout du texte, en temps quadratique, et gèlerait
// l'agent. Un bloc jamais fermé est gardé, comme avant.
function retirerBlocs(h: string, ouvre: string, ferme: string, motEntier = true): string {
  const bas = h.toLowerCase();
  let sortie = "", i = 0;
  for (let d = bas.indexOf(ouvre); d !== -1; d = bas.indexOf(ouvre, i)) {
    if (motEntier && /[a-z0-9_]/.test(bas[d + ouvre.length] ?? "")) { sortie += h.slice(i, d + 1); i = d + 1; continue; }
    const f = bas.indexOf(ferme, d + ouvre.length);
    if (f === -1) break;
    const fin = ferme.endsWith(">") ? f + ferme.length : bas.indexOf(">", f) + 1 || h.length;
    sortie += h.slice(i, d) + " ";
    i = fin;
  }
  return sortie + h.slice(i);
}
const entite = (m: string, e: string): string => {
  if (e[0] !== "#") return ENTITES[e.toLowerCase()] ?? m;
  const n = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
  return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m; // hors de l'Unicode : gardée
};

export function texteDePage(html: string): { titre: string; texte: string } {
  const bas = html.toLowerCase(), t = bas.indexOf("<title"), tf = t === -1 ? -1 : bas.indexOf("</title", t);
  const titre = t !== -1 && tf !== -1 ? html.slice(bas.indexOf(">", t) + 1, tf).trim() : "";
  let h = retirerBlocs(html, "<!--", "-->", false);
  for (const b of ["head", "script", "style", "noscript", "svg", "nav", "footer", "iframe", "template", "form"]) h = retirerBlocs(h, `<${b}`, `</${b}`);
  // [^<>] et non [^>] : une balise jamais fermée s'arrête à la suivante, le temps reste linéaire.
  h = h.replace(/<h([1-6])[^<>]*>/gi, (_m, n) => `\n\n${"#".repeat(Number(n))} `).replace(/<\/h[1-6]>/gi, "\n")
    .replace(/<li[^<>]*>/gi, "\n- ").replace(/<pre[^<>]*>/gi, "\n```\n").replace(/<\/pre>/gi, "\n```\n")
    .replace(/<(br|\/p|\/div|\/tr|\/section|\/article|\/table)[^<>]*>/gi, "\n").replace(/<[^<>]+>/g, "")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, entite);
  const texte = h.split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim()).filter((l, i, t) => l !== "" || (t[i - 1] ?? "") !== "").join("\n").trim();
  return { titre, texte };
}

// Le corps lu par morceaux, 2 Mo au plus : r.text() lirait sans fin un flux (SSE, archive, vidéo) et remplirait
// la mémoire de pi.
const WEB_OCTETS_MAX = 2 * 1024 * 1024;
async function corpsBorne(r: Response): Promise<string> {
  if (!r.body) return "";
  const lecteur = r.body.getReader(), morceaux: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await lecteur.read();
    if (done) break;
    morceaux.push(value);
    total += value.length;
    if (total >= WEB_OCTETS_MAX) { await lecteur.cancel().catch(() => {}); return new TextDecoder().decode(Buffer.concat(morceaux).subarray(0, WEB_OCTETS_MAX)) + "\n… (page tronquée à 2 Mo)"; }
  }
  return new TextDecoder().decode(Buffer.concat(morceaux));
}

export async function lireWeb(url: string, depuis = 0): Promise<{ code: number; texte: string; invalide?: boolean }> {
  let u: URL;
  try { u = new URL(url); } catch { return { code: 2, invalide: true, texte: `l'adresse ${url} est illisible. Se lève avec une adresse complète, https://…` }; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { code: 2, invalide: true, texte: `l'adresse ${url} n'est ni https ni http. Se lève avec une adresse https:// ou http://` };
  try {
    const r = await fetch(u, { redirect: "follow", signal: AbortSignal.timeout(20_000), headers: { "user-agent": "Mozilla/5.0 (essaim ; lecture de documentation)", accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5" } });
    const type = r.headers.get("content-type") ?? "";
    const brut = await corpsBorne(r);
    const { titre, texte } = /html/i.test(type) || /^\s*<(!doctype|html)/i.test(brut) ? texteDePage(brut) : { titre: "", texte: brut };
    const debut = Math.max(0, depuis);
    const morceau = texte.slice(debut, debut + WEB_MAX);
    const suite = debut + WEB_MAX < texte.length ? `\n… (${texte.length - debut - WEB_MAX} caractères de plus : web_lire avec depuis=${debut + WEB_MAX})` : "";
    return { code: r.ok ? 0 : 1, texte: `${r.status} ${u.href}${titre ? `\ntitre : ${titre}` : ""}\n${texte.length} caractères de texte${debut ? `, à partir du ${debut}ᵉ` : ""}\n\n${morceau}${suite}` };
  } catch (e) {
    return { code: 1, texte: `web_lire : ${u.href} ne répond pas : ${(e as Error).message ?? e}` };
  }
}
