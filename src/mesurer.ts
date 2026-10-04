// Mesurer et comparer, avec le même navigateur que `voir`, carte graphique comprise.
// Mesurer : les missions demandent des chiffres (premier écran en moins d'une seconde, 30 images par seconde en 3D),
// sans que l'agent bricole ses propres scripts pour les obtenir. Comparer : une capture
// avant, une après, et ce qui a bougé entouré — pour voir qu'une correction a cassé autre chose.
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normaliserChemin } from "./tableau.ts";
import { ARGS_NAVIGATEUR, cheminNavigateur } from "./voir.ts";

// invalide : un paramètre invalide (fichier introuvable, taille illisible, sortie non PNG), rendu en refus par l'outil.
export type Mesure = { code: 0 | 1 | 2; texte: string; invalide?: boolean };

const panne = (t: string): Mesure => ({ code: 2, texte: t });
const invalide = (t: string): Mesure => ({ code: 2, invalide: true, texte: t });
const introuvable = (nom: string) => invalide(`${nom} est introuvable dans le dossier partagé. Se lève quand le fichier existe`);

async function navigateur() {
  const executable = cheminNavigateur();
  if (!executable) throw new Error("navigateur absent du cache Playwright");
  const pw = await import("playwright-core");
  return pw.chromium.launch({ executablePath: executable, headless: true, args: ARGS_NAVIGATEUR });
}

function fichierDuPartage(racine: string, nom: string): string | undefined {
  const propre = normaliserChemin(nom.startsWith(racine + "/") ? nom.slice(racine.length + 1) : nom);
  if (!propre) return undefined;
  const chemin = join(racine, propre);
  return existsSync(chemin) && lstatSync(chemin).isFile() ? chemin : undefined;
}

export async function mesurer(partage: string, page: string, secondes = 5, taille = "1280x800", echeanceMs?: number): Promise<Mesure> {
  const racine = resolve(partage);
  const suite = /[?#].*$/.exec(page)?.[0] ?? ""; // `index.html#salle` : le fichier est ce qui précède
  const chemin = fichierDuPartage(racine, page.slice(0, page.length - suite.length));
  if (!chemin) return introuvable(page);
  const m = /^(\d{3,4})[x×](\d{3,4})$/.exec(taille.trim());
  if (!m) return invalide(`la taille ${taille} est illisible. Se lève avec une taille « 1280x800 »`);
  const duree = Math.min(20, Math.max(1, secondes));
  let b: Awaited<ReturnType<typeof navigateur>> | undefined;
  const travail = async (): Promise<Mesure> => { try {
    b = await navigateur();
    const p = await b.newPage({ viewport: { width: Number(m[1]), height: Number(m[2]) } });
    const erreurs: string[] = [];
    const fichiers = new Set<string>();
    p.on("console", (x) => { if (x.type() === "error") erreurs.push(x.text()); });
    p.on("pageerror", (e) => erreurs.push(e.message));
    p.on("request", (r) => { if (r.url().startsWith("file://")) fichiers.add(fileURLToPath(r.url())); });
    const debut = Date.now();
    await p.goto(pathToFileURL(chemin).href + suite, { waitUntil: "load", timeout: 30_000 });
    const charge = Date.now() - debut;
    // Les images par seconde : compter les rafraîchissements pendant la durée demandée, et la plus longue image.
    const ips = await p.evaluate((ms) => new Promise<{ n: number; pire: number }>((fin) => {
      let n = 0, pire = 0, avant = performance.now();
      const t0 = avant;
      const tour = (maintenant: number) => {
        n++; pire = Math.max(pire, maintenant - avant); avant = maintenant;
        if (maintenant - t0 < ms) requestAnimationFrame(tour); else fin({ n, pire: Math.round(pire) });
      };
      requestAnimationFrame(tour);
    }), duree * 1000);
    // Le premier affichage se lit après quelques images : au moment du « load », il n'est pas toujours noté.
    const t = await p.evaluate(() => {
      const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      const peinture = performance.getEntriesByName("first-contentful-paint")[0];
      return { dom: nav ? Math.round(nav.domContentLoadedEventEnd) : null, peinture: peinture ? Math.round(peinture.startTime) : null };
    });
    const rendu = await p.evaluate(() => {
      const gl = document.createElement("canvas").getContext("webgl2");
      const info = gl?.getExtension("WEBGL_debug_renderer_info");
      return gl ? String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) : "aucun WebGL";
    });
    const tailles = [...fichiers].filter((f) => existsSync(f)).map((f) => ({ f, o: statSync(f).size }));
    const total = tailles.reduce((s, x) => s + x.o, 0);
    const lourds = tailles.sort((a, b) => b.o - a.o).slice(0, 5).map((x) => `${x.f.startsWith(racine + "/") ? x.f.slice(racine.length + 1) : x.f} ${Math.round(x.o / 1024)} Ko`);
    const lignes = [
      `page_mesurer : ${page} à ${m[1]}×${m[2]}`,
      `premier affichage : ${t.peinture ?? "?"} ms · page prête (DOMContentLoaded) : ${t.dom ?? "?"} ms · chargement complet : ${charge} ms`,
      `images par seconde : ${Math.round(ips.n / duree)} en moyenne sur ${duree} s · la plus longue image : ${ips.pire} ms`,
      `poids : ${tailles.length} fichier${tailles.length > 1 ? "s" : ""}, ${Math.round(total / 1024)} Ko${lourds.length ? ` (les plus lourds : ${lourds.join(", ")})` : ""}`,
      `rendu : ${rendu}`,
      `erreurs (${erreurs.length})${erreurs.length ? " : " + erreurs.slice(0, 5).join(" | ") : ""}`,
      "Le navigateur est sans écran : les images par seconde y sont un ordre de grandeur, pas la mesure d'un écran réel.",
    ];
    return { code: erreurs.length ? 1 : 0, texte: lignes.join("\n") };
  } catch (e) {
    return panne(`page_mesurer : ${(e as Error).message ?? e}`);
  } };
  // Une échéance pour tout l'appel, comme voir : sans délai sur les evaluate, une page qui boucle après son
  // chargement gèlerait l'outil jusqu'à ce que le lanceur renvoie l'agent. Fermer le navigateur tue le rendu bloqué.
  const limite = echeanceMs ?? 30_000 + duree * 1000 + 15_000;
  let minuterie: ReturnType<typeof setTimeout> | undefined;
  const echeance = new Promise<Mesure>((fin) => {
    minuterie = setTimeout(() => {
      void b?.close().catch(() => {});
      fin({ code: 1, texte: `page_mesurer : ${page} ne répond plus après ${Math.round(limite / 1000)} s (une boucle sans fin dans un script ?)` });
    }, limite);
  });
  try {
    return await Promise.race([travail(), echeance]);
  } finally {
    clearTimeout(minuterie);
    await b?.close().catch(() => {});
  }
}

// Deux captures PNG du dossier partagé, comparées pixel par pixel dans le navigateur ; la sortie montre la seconde,
// atténuée, avec en rouge ce qui a changé, et dit quelle part de l'image a bougé et où.
// captures (rôles) : le dossier des captures du bureau de l'agent ; la sortie y est écrite, hors du livrable, et une
// capture peut y être donnée par son chemin absolu. Absent : tout dans le dossier partagé, comme avant.
export async function comparer(partage: string, avant: string, apres: string, sortie = "comparaison.png", captures?: string): Promise<Mesure> {
  const racine = resolve(partage);
  const bureau = captures ? resolve(captures) : undefined;
  const lire = (nom: string) => (bureau && nom.startsWith(bureau + "/") ? fichierDuPartage(bureau, nom) : fichierDuPartage(racine, nom));
  const a = lire(avant), b2 = lire(apres);
  const dst = normaliserChemin(sortie);
  if (!a || !b2) return introuvable(!a ? avant : apres);
  if (!dst || !dst.toLowerCase().endsWith(".png")) return invalide(`la sortie ${sortie} n'est pas un PNG du dossier partagé. Se lève avec un nom en .png du dossier partagé`);
  let b: Awaited<ReturnType<typeof navigateur>> | undefined;
  try {
    b = await navigateur();
    const p = await b.newPage();
    const url = (f: string) => `data:image/png;base64,${readFileSync(f).toString("base64")}`;
    const r = await p.evaluate(async ({ ua, ub }) => {
      const charger = (u: string) => new Promise<HTMLImageElement>((ok, ko) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => ko(new Error("image illisible")); i.src = u; });
      const [ia, ib] = await Promise.all([charger(ua), charger(ub)]);
      const l = Math.max(ia.width, ib.width), h = Math.max(ia.height, ib.height);
      const lire = (i: HTMLImageElement) => { const c = document.createElement("canvas"); c.width = l; c.height = h; const x = c.getContext("2d")!; x.drawImage(i, 0, 0); return x.getImageData(0, 0, l, h).data; };
      const da = lire(ia), db = lire(ib);
      const c = document.createElement("canvas"); c.width = l; c.height = h;
      const x = c.getContext("2d")!;
      x.globalAlpha = 0.35; x.drawImage(ib, 0, 0); x.globalAlpha = 1;
      const out = x.getImageData(0, 0, l, h);
      let n = 0, x0 = l, y0 = h, x1 = -1, y1 = -1;
      for (let y = 0; y < h; y++) for (let xx = 0; xx < l; xx++) {
        const k = (y * l + xx) * 4;
        const d = Math.abs(da[k]! - db[k]!) + Math.abs(da[k + 1]! - db[k + 1]!) + Math.abs(da[k + 2]! - db[k + 2]!);
        if (d > 30) { n++; out.data[k] = 230; out.data[k + 1] = 20; out.data[k + 2] = 40; out.data[k + 3] = 255; x0 = Math.min(x0, xx); y0 = Math.min(y0, y); x1 = Math.max(x1, xx); y1 = Math.max(y1, y); }
      }
      x.putImageData(out, 0, 0);
      if (n) { x.strokeStyle = "rgb(230,20,40)"; x.lineWidth = 3; x.strokeRect(x0 - 4, y0 - 4, x1 - x0 + 8, y1 - y0 + 8); }
      return { l, h, n, zone: n ? [x0, y0, x1, y1] : null, meme: ia.width === ib.width && ia.height === ib.height, png: c.toDataURL("image/png").split(",")[1]! };
    }, { ua: url(a), ub: url(b2) });
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const image = join(bureau ?? racine, dst);
    if (bureau) mkdirSync(dirname(image), { recursive: true });
    writeFileSync(image, Buffer.from(r.png, "base64"));
    const part = (100 * r.n) / (r.l * r.h);
    return { code: 0, texte: [
      `page_comparer : ${avant} → ${apres}`,
      r.n === 0 ? "aucune différence visible" : `${part < 0.01 ? "moins de 0,01" : part.toFixed(2).replace(".", ",")} % de l'image a changé, dans la zone de (${r.zone![0]}, ${r.zone![1]}) à (${r.zone![2]}, ${r.zone![3]})`,
      ...(r.meme ? [] : ["les deux captures n'ont pas la même taille : comparées coin haut gauche contre coin haut gauche"]),
      `image : ${bureau ? image : dst} (en rouge, ce qui a changé)`,
    ].join("\n") };
  } catch (e) {
    return panne(`page_comparer : ${(e as Error).message ?? e}`);
  } finally {
    await b?.close().catch(() => {});
  }
}
