// Le moteur de l'outil voir : ouvrir une page livrée dans
// partage/ comme le juge le fera, en file://, avec le chrome-headless-shell
// du cache Playwright que playwright-core (épinglé dans package.json) attend ;
// cliquer, lire le texte, relever les erreurs de console, les exceptions,
// les ressources chargées hors de partage/, les styles sans cible (une feuille
// qui habille un élément que le JS nomme autrement) et ce qui recouvre la page
// (un voile de modale laissé devant l'application entière) ; écrire une capture.
// Importable sous Node (l'extension dans pi) et sous Bun (tests, lanceur) ; ligne
// de commande pour les sondes et les tests. Rien ne se télécharge : si la
// bibliothèque ou la révision manque, c'est un refus explicite (code 2).
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { normaliserChemin } from "./tableau.ts";

export type Voir = { page: string; clics?: string[]; capture?: string; parcours?: boolean; tailles?: string[] };

// Les tailles d'écran regardées d'un coup : un défaut visible à une seule taille échappe à qui les regarde
// une à une. Des écrans d'ordinateur seulement, pour ne pas signaler de défauts sur mobile quand la mission
// n'en veut pas. Un téléphone se demande en le nommant.
export const TAILLES_DEFAUT = ["1280x720", "1366x768", "1440x900", "1920x1080", "2560x1440"];
// invalide : la page demandée est hors du dossier partagé ou absente, un refus que l'outil rend comme tel ; les
// autres codes 2 sont des pannes (navigateur, bibliothèque). Le code de sortie de la ligne de commande reste 2.
// charges (second cerveau) : les fichiers du dossier que la page a réellement demandés, la page comprise, en chemins
// relatifs au dossier ; l'empreinte de page_voir porte sur eux. La capture et la planche écrites par le
// contrôle n'y sont pas : la page ne les demande pas.
export type Resultat = { code: 0 | 1 | 2; texte: string; invalide?: boolean; charges?: string[] };

const require = createRequire(import.meta.url);
const TEXTE_MAX = 4000;
const TEXTE_CLIC_MAX = 1000;

// Le parcours de visiteur : le geste que personne ne fait — ouvrir la deuxième porte et regarder dedans. On
// clique chaque élément visible sur lequel un humain cliquerait, et après chaque clic on pose deux
// questions bêtes : la page a-t-elle bougé, et ce qui vient de s'afficher est-il vide ? Vide se
// mesure sans rien savoir du livrable : une zone de dessin de taille nulle (un canvas 0 × 0), ou une grande zone qui ne contient ni texte ni image ni dessin.
// Les boutons qui détruisent (supprimer, effacer, tout oublier…) ne sont jamais cliqués : le
// contrôle ne doit pas abîmer ce qu'il contrôle.
const DESTRUCTEUR = /supprim|efface|oubli|réinitialis|reinitialis|vider|vide tout|remise à zéro|delete|clear|reset|remove/i;
const PARCOURS_MAX = 20;
type Cible = { i: number; texte: string };

async function parcoursDeVisiteur(page: import("playwright-core").Page, empreinte: () => Promise<string>): Promise<string[]> {
  // Les cibles sont marquées au départ : relevées par leur rang, un bouton inséré entre-temps prendrait la place
  // d'un autre, et le parcours cliquerait « Supprimer tout » en croyant cliquer « Voir ».
  const cibles: Cible[] = await page.evaluate((max) => {
    const sel = 'button, [role="tab"], summary, input[type="button"], input[type="submit"], a[href^="#"]';
    const vus: Array<{ i: number; texte: string }> = [];
    document.querySelectorAll(sel).forEach((e) => {
      const r = (e as HTMLElement).getBoundingClientRect();
      if (vus.length >= max || r.width < 4 || r.height < 4 || (e as HTMLElement).offsetParent === null) return;
      e.setAttribute("data-essaim-cible", String(vus.length));
      vus.push({ i: vus.length, texte: ((e as HTMLElement).innerText || (e as HTMLInputElement).value || (e as HTMLElement).title || "").trim().slice(0, 40) });
    });
    return vus;
  }, PARCOURS_MAX);

  // Ce qui s'affiche est-il vide ? Une grande zone visible, sans texte, dont les dessins sont de
  // taille nulle ou dont l'image compressée ne pèse presque rien (une image unie se compresse à
  // presque rien ; un ciel étoilé, non).
  const zonesVides = async (): Promise<string[]> => {
    const suspectes = await page.evaluate(() => {
      const aire = window.innerWidth * window.innerHeight;
      const vides: Array<{ id: string; w: number; h: number; raison: string; x: number; y: number }> = [];
      for (const e of Array.from(document.querySelectorAll("div, section, main, canvas"))) {
        const el = e as HTMLElement;
        const r = el.getBoundingClientRect();
        if (r.width * r.height < aire * 0.2 || el.offsetParent === null) continue;
        if ((el.innerText ?? "").trim().length > 0) continue;
        if (el.querySelector("img, svg, video")) continue;
        const dessins = Array.from(el.querySelectorAll("canvas")).concat(el.tagName === "CANVAS" ? [el as HTMLCanvasElement] : []);
        const nom = el.id ? "#" + el.id : el.tagName.toLowerCase() + (el.className ? "." + String(el.className).split(" ")[0] : "");
        if (dessins.length && dessins.every((c) => (c as HTMLCanvasElement).width < 2 || (c as HTMLCanvasElement).height < 2)) {
          vides.push({ id: nom, w: Math.round(r.width), h: Math.round(r.height), raison: "sa zone de dessin fait 0 × 0", x: Math.round(r.x), y: Math.round(r.y) });
        } else if (!dessins.length) {
          vides.push({ id: nom, w: Math.round(r.width), h: Math.round(r.height), raison: "elle ne contient ni texte ni image ni dessin", x: Math.round(r.x), y: Math.round(r.y) });
        } else {
          vides.push({ id: nom, w: Math.round(r.width), h: Math.round(r.height), raison: "à photographier", x: Math.round(r.x), y: Math.round(r.y) });
        }
      }
      return vides;
    });
    const dits: string[] = [];
    for (const z of suspectes) {
      if (z.raison !== "à photographier") { dits.push(`la zone ${z.id} (${z.w} × ${z.h}) est vide : ${z.raison}`); continue; }
      try { // une image unie se compresse à presque rien : moins d'un centième d'octet par pixel
        const png = await page.screenshot({ clip: { x: Math.max(0, z.x), y: Math.max(0, z.y), width: z.w, height: z.h } });
        if (png.length / (z.w * z.h) < 0.01) dits.push(`la zone ${z.id} (${z.w} × ${z.h}) est vide : elle est d'une seule couleur`);
      } catch { /* zone hors écran : on ne dit rien */ }
    }
    return dits;
  };

  const dejaDit = new Set<string>();
  const remarques: string[] = [];
  for (const c of cibles) {
    if (DESTRUCTEUR.test(c.texte)) { remarques.push(`« ${c.texte} » n'est pas cliqué : ce bouton détruirait le travail`); continue; }
    try {
      const avant = await empreinte();
      // Le libellé est relu au moment du clic : un bouton devenu destructeur n'est pas cliqué.
      const quoi = await page.evaluate(({ i, motif }) => {
        const e = document.querySelector(`[data-essaim-cible="${i}"]`) as HTMLElement | null;
        if (!e) return "absent";
        const t = (e.innerText || (e as HTMLInputElement).value || e.title || "").trim();
        if (new RegExp(motif, "i").test(t)) return "destructeur";
        e.click();
        return "clic";
      }, { i: c.i, motif: DESTRUCTEUR.source });
      if (quoi === "absent") { remarques.push(`« ${c.texte} » n'est plus dans la page au moment de le cliquer`); continue; }
      if (quoi === "destructeur") { remarques.push(`« ${c.texte} » n'est pas cliqué : ce bouton détruirait le travail`); continue; }
      await page.waitForTimeout(400);
      if ((await empreinte()) === avant) remarques.push(`après le clic sur « ${c.texte} », la page n'a pas changé`);
      for (const v of await zonesVides()) {
        const cle = v.replace(/\(\d+ × \d+\)/, "");
        if (dejaDit.has(cle)) continue;
        dejaDit.add(cle);
        remarques.push(`après le clic sur « ${c.texte} », ${v}`);
      }
    } catch (e) {
      remarques.push(`« ${c.texte} » : clic impossible (${message(e)})`);
    }
  }
  return remarques;
}

// Ce qui recouvre la page : un voile de modale qui porte `hidden` mais reçoit `display:flex` d'une règle
// d'auteur (elle bat le style par défaut du navigateur) reste devant l'application entière, alors que tests,
// console et parcours sont sains. Il faut demander ce qui est *au-dessus*. Deux questions, toutes deux sans faux positif possible :
//   — un élément porte `hidden` et s'affiche quand même (la cause, nommée) ;
//   — le texte visible est-il atteignable, ou quelque chose est-il posé dessus (l'effet, mesuré) ?
type Recouvrement = {
  hidden: Array<{ nom: string; w: number; h: number; display: string }>;
  recouverts: string[];
  total: number;
  parQui: Array<{ nom: string; n: number }>;
};

async function ceQuiRecouvre(page: import("playwright-core").Page): Promise<string[]> {
  const r: Recouvrement = await page.evaluate(() => {
    const nomDe = (e: Element) => {
      const c = typeof e.className === "string" ? e.className.split(" ").filter(Boolean)[0] : "";
      return e.id ? "#" + e.id : e.tagName.toLowerCase() + (c ? "." + c : "");
    };
    const hidden: Recouvrement["hidden"] = [];
    for (const e of Array.from(document.querySelectorAll("[hidden]"))) {
      const s = getComputedStyle(e);
      const b = e.getBoundingClientRect();
      if (s.display !== "none" && s.visibility !== "hidden" && b.width * b.height > 0)
        hidden.push({ nom: nomDe(e), w: Math.round(b.width), h: Math.round(b.height), display: s.display });
    }
    // Chaque bloc qui porte du texte à lui : est-il sous le curseur en son centre, ou masqué par autre chose ?
    const recouverts: string[] = [];
    const parQui = new Map<string, number>();
    let total = 0;
    for (const e of Array.from(document.body.querySelectorAll("*"))) {
      const propre = Array.from(e.childNodes).filter((n) => n.nodeType === 3).map((n) => (n.textContent ?? "").trim()).join("");
      if (propre.length < 2) continue;
      const b = e.getBoundingClientRect();
      if (b.width < 8 || b.height < 8 || b.top > innerHeight || b.bottom < 0 || b.left > innerWidth || b.right < 0) continue;
      if (getComputedStyle(e).visibility === "hidden") continue;
      const x = Math.min(Math.max(b.left + b.width / 2, 1), innerWidth - 1);
      const y = Math.min(Math.max(b.top + b.height / 2, 1), innerHeight - 1);
      total++;
      const haut = document.elementFromPoint(x, y);
      if (!haut || haut === e || e.contains(haut) || haut.contains(e)) continue;
      recouverts.push(nomDe(e));
      const q = nomDe(haut);
      parQui.set(q, (parQui.get(q) ?? 0) + 1);
    }
    return { hidden, recouverts, total, parQui: [...parQui].map(([nom, n]) => ({ nom, n })).sort((a, b) => b.n - a.n) };
  });

  const dits: string[] = [];
  for (const h of r.hidden)
    dits.push(`${h.nom} porte l'attribut hidden mais s'affiche quand même (${h.w} × ${h.h}, display: ${h.display}) : une règle de style écrase le hidden du HTML`);
  // Un bloc isolé peut être couvert par une infobulle ; la moitié de la page, non.
  if (r.total >= 4 && r.recouverts.length >= r.total / 2) {
    const par = r.parQui.map((q) => `${q.nom} (${q.n})`).join(", ");
    dits.push(`${r.recouverts.length} des ${r.total} blocs de texte visibles sont recouverts par autre chose : ${par} — la page est masquée`);
  }
  return dits;
}

// Un style sans cible : une règle dont un nom de classe ou d'id ne correspond à aucun élément de la page
// chargée, et n'apparaît ni dans le HTML ni dans ses scripts (qui pourraient le poser plus tard).
type Orphelin = { selecteur: string; feuille: string };

const tronquer = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);
const message = (e: unknown) => String((e as Error)?.message ?? e).split("\n")[0];
const panne = (raison: string): Resultat => ({ code: 2, texte: `page_voir : 2 outil en panne · ${raison}` });

export const ARGS_NAVIGATEUR = process.env.ESSAIM_VOIR_GPU === "0" ? [] : ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"];

// Le binaire attendu par la révision que playwright-core déclare, dans le cache Playwright ; undefined s'il manque.
export function cheminNavigateur(): string | undefined {
  try {
    const dossier = dirname(require.resolve("playwright-core/package.json"));
    const b = require(join(dossier, "browsers.json")) as { browsers: Array<{ name: string; revision: string }> };
    const revision = b.browsers.find((x) => x.name === "chromium-headless-shell")?.revision;
    if (!revision) return undefined;
    // PLAYWRIGHT_BROWSERS_PATH, la variable de Playwright pour son cache, le déplace (les tests d'une panne la pointent sur un dossier vide).
    const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), "Library", "Caches", "ms-playwright");
    const chemin = join(cache, `chromium_headless_shell-${revision}`, "chrome-headless-shell-mac-arm64", "chrome-headless-shell");
    return existsSync(chemin) ? chemin : undefined;
  } catch {
    return undefined;
  }
}

// Ouvre partage/<page>, clique, lit, trace. Ne touche jamais rien hors de partage/.
export async function voir(partage: string, v: Voir, delaiMs = 15_000): Promise<Resultat> {
  const racine = resolve(partage);
  // Les consignes donnent le dossier partagé en chemin absolu : un agent le recopie volontiers.
  // Une adresse de page peut porter une ancre ou des paramètres (`index.html#salle`) : le fichier est ce qui précède.
  const suite = /[?#].*$/.exec(v.page)?.[0] ?? "";
  const base = v.page.slice(0, v.page.length - suite.length);
  const relatif = base.startsWith(racine + "/") ? base.slice(racine.length + 1) : base;
  const propre = normaliserChemin(relatif);
  if (!propre) return { code: 2, invalide: true, texte: `${v.page} est hors du dossier partagé. Définitif pour ce chemin` };
  const chemin = join(racine, propre);
  if (!existsSync(chemin) || !lstatSync(chemin).isFile()) return { code: 2, invalide: true, texte: `${propre} est introuvable dans le dossier partagé. Se lève quand le fichier existe` };
  const executable = cheminNavigateur();
  if (!executable) return panne("bibliothèque ou révision absente : playwright-core attend chromium_headless_shell-<révision> dans ~/Library/Caches/ms-playwright (bun install, hors run)");
  let pw: typeof import("playwright-core");
  try {
    pw = await import("playwright-core");
  } catch (e) {
    return panne(`playwright-core introuvable : ${message(e)}`);
  }

  const prefixe = pathToFileURL(racine).href + "/";
  const erreurs: string[] = [];
  const exceptions: string[] = [];
  const externes: string[] = [];
  const charges = new Set<string>();
  let navigateur: import("playwright-core").Browser | undefined;
  const travail = async (): Promise<Resultat> => { try {
    // playwright-core passe --no-sandbox lui-même : sous sandbox-exec, Chromium ne peut pas ré-initialiser son bac à
    // sable interne ; la page reste dans le bac à sable de l'essaim.
    // La carte graphique du Mac : sans ces options, le navigateur rend la 3D en logiciel (SwiftShader), à zéro ou
    // quelques images par seconde, loin du rendu du juge. Avec Metal, c'est le GPU qui dessine, y compris dans le bac
    // à sable de l'essaim.
    navigateur = await pw.chromium.launch({ executablePath: executable, headless: true, timeout: delaiMs, args: ARGS_NAVIGATEUR });
    const page = await navigateur.newPage();
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      const l = m.location();
      erreurs.push(l?.url ? `${m.text()} (${l.url.replace(prefixe, "")}:${(l.lineNumber ?? 0) + 1})` : m.text());
    });
    page.on("pageerror", (e) => exceptions.push(e.message));
    // Comme mesurer.ts:47 : request voit aussi les sous-ressources file:// (modules importés compris).
    page.on("request", (r) => {
      if (!r.url().startsWith(prefixe)) { externes.push(r.url()); return; }
      try { charges.add(relative(racine, fileURLToPath(r.url())).split(sep).join("/")); } catch { /* adresse illisible : ignorée */ }
    });
    await page.goto(pathToFileURL(chemin).href + suite, { waitUntil: "domcontentloaded", timeout: delaiMs });
    await page.waitForLoadState("load", { timeout: 5000 }).catch(() => erreurs.push("l'événement load n'est pas arrivé en 5 s (une ressource ne répond pas ?)"));
    const titre = await page.title();
    const texte = await page.innerText("body");
    const apres: string[] = [];
    // Empreinte du contenu de la page : deux clics de suite qui la laissent identique sont le signe d'une
    // action qui ne fait rien (un tri par en-tête qui ne s'inverse jamais au second clic).
    // Le contenu, mais aussi ce que innerHTML ne dit pas : la valeur des champs, les attributs de <html> et <body>,
    // les dessins des canvas ; sinon une calculette ou un jeu sur canvas qui marchent seraient dits « sans effet ».
    const empreinte = () => page.evaluate(() => {
      const champs = Array.from(document.querySelectorAll("input, textarea, select")).map((e) => `${(e as HTMLInputElement).value}|${(e as HTMLInputElement).checked}`).join("¦");
      const attributs = [document.documentElement, document.body].map((e) => Array.from(e.attributes).map((a) => `${a.name}=${a.value}`).join(",")).join("¦");
      const dessins = Array.from(document.querySelectorAll("canvas")).map((c) => { try { return (c as HTMLCanvasElement).toDataURL(); } catch { return "?"; } }).join("¦");
      const h = document.body.innerHTML + champs + attributs + dessins;
      let n = 0;
      for (let i = 0; i < h.length; i++) n = (Math.imul(n, 31) + h.charCodeAt(i)) | 0;
      return `${h.length}:${n}`;
    });
    for (const [i, sel] of (v.clics ?? []).entries()) {
      try {
        const avant = await empreinte();
        await page.click(sel, { timeout: 3000 });
        await page.waitForTimeout(500); // attente de stabilité
        const inchange = (await empreinte()) === avant;
        apres.push(`après le clic ${i + 1} « ${sel} »${inchange ? " (la page n'a pas changé)" : ""} :\n${tronquer(await page.innerText("body"), TEXTE_CLIC_MAX)}`);
      } catch (e) {
        // Dire pourquoi : pas seulement « introuvable », mais désactivé ou recouvert.
        const m = message(e);
        const pourquoi = /not a valid selector|Unexpected token|SyntaxError|Unexpected end|parsing selector/i.test(m) ? "sélecteur invalide"
          : await page.evaluate((s) => {
            let el: Element | null;
            try { el = document.querySelector(s); } catch { return "clic impossible"; } // un sélecteur propre à Playwright
            if (!el) return "sélecteur introuvable";
            if ((el as HTMLButtonElement).disabled) return "désactivé";
            const r = el.getBoundingClientRect();
            const dessus = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
            if (dessus && dessus !== el && !el.contains(dessus)) return `recouvert par <${dessus.tagName.toLowerCase()}${dessus.id ? "#" + dessus.id : ""}>`;
            return r.width < 1 || r.height < 1 ? "invisible (taille nulle)" : "clic impossible";
          }, sel).catch(() => "clic impossible");
        apres.push(`clic ${i + 1} « ${sel} » : ${pourquoi}`);
      }
    }
    // Captures hors du livrable : avec des rôles, dans <bureau>/captures/ et dites en chemin absolu (le texte rendu
    // se lit par read) ; la recette, dont partage/ est en lecture seule, peut en faire. Playwright crée les dossiers. Sans
    // rôles, dans partage/.
    const bureau = process.env.ESSAIM_ROLE ? process.env.ESSAIM_BUREAU : undefined;
    const dossierCaptures = bureau ? join(resolve(bureau), "captures") : racine;
    const dire = (nom: string) => (bureau ? join(dossierCaptures, nom) : nom);
    let capture: string | undefined;
    let captureRefusee: string | undefined;
    if (v.capture) {
      const nom = normaliserChemin(v.capture);
      if (nom) {
        const voulu = nom.toLowerCase().endsWith(".png") ? nom : `${nom}.png`;
        // Ni un fichier que la page charge (sans rôles, « logo » remplaçait l'image du site), ni hors du dossier par un
        // lien. Le plus proche parent existant est résolu avant que Playwright crée les dossiers.
        let parent = dirname(join(dossierCaptures, voulu));
        while (!existsSync(parent)) parent = dirname(parent);
        const dossierReel = realpathSync(existsSync(dossierCaptures) ? dossierCaptures : dirname(dossierCaptures));
        if (!bureau && charges.has(voulu)) captureRefusee = `${voulu} est un fichier que la page charge ; choisis un autre nom`;
        else if (!(realpathSync(parent) + "/").startsWith(dossierReel + "/")) captureRefusee = `${voulu} sortirait du dossier par un lien`;
        else {
          capture = voulu;
          await page.screenshot({ path: join(dossierCaptures, capture), fullPage: true });
        }
      }
    }
    const tailles = v.tailles ? await auxTailles(navigateur, page, v.tailles.length ? v.tailles : TAILLES_DEFAUT, dossierCaptures, capture) : undefined;
    const orphelins = await stylesSansCible(page, dirname(chemin), racine);
    const voiles = await ceQuiRecouvre(page); // ce qui est posé par-dessus, au chargement
    // Le parcours de visiteur ne se déclenche que si on le demande (l'outil fini le demande) : il clique.
    const remarques = v.parcours ? await parcoursDeVisiteur(page, empreinte) : [];
    const vides = remarques.filter((r) => r.includes("est vide"));
    const code = erreurs.length + exceptions.length + orphelins.length + vides.length + voiles.length + (tailles?.defauts ?? 0) > 0 ? 1 : 0;
    const lignes = [
      code === 0 ? "page_voir : 0 page saine" : "page_voir : 1 page en erreur",
      `titre : ${titre}`,
      `texte (${TEXTE_MAX} caractères au plus) :`,
      tronquer(texte, TEXTE_MAX),
      `erreurs de console (${erreurs.length}) :`, ...erreurs,
      `exceptions (${exceptions.length}) :`, ...exceptions,
      `ressources hors de partage/ (${externes.length}) :`, ...externes,
      `styles sans cible (${orphelins.length}) :`, ...orphelins.map((o) => `${o.selecteur} (${o.feuille}) : aucun élément ne correspond, et le nom n'est ni dans la page ni dans ses scripts`),
      `ce qui recouvre la page (${voiles.length}) :`, ...voiles,
      ...apres,
      ...(v.parcours ? [`parcours de visiteur (${remarques.length} remarque${remarques.length > 1 ? "s" : ""}, ${vides.length} zone${vides.length > 1 ? "s" : ""} vide${vides.length > 1 ? "s" : ""}) :`, ...remarques] : []),
    ];
    if (tailles) lignes.push(`aux tailles d'écran (${tailles.lignes.length}, ${tailles.defauts} en défaut) :`, ...tailles.lignes, `planche : ${dire(tailles.planche)}`);
    if (capture) lignes.push(`capture : ${dire(capture)}`);
    if (captureRefusee) lignes.push(`capture refusée : ${captureRefusee}`);
    return { code, texte: lignes.join("\n"), charges: [...charges] };
  } catch (e) {
    return panne(message(e));
  } };
  // Une échéance pour tout l'appel : delaiMs ne borne que le lancement et la navigation ; une page qui boucle
  // après son chargement gèlerait page_voir et moi_finir pour toujours, le rendu à 100 % d'un cœur. Fermer le navigateur
  // tue ce rendu ; la page est dite en erreur, pas la salle en panne.
  let minuterie: ReturnType<typeof setTimeout> | undefined;
  const echeance = new Promise<Resultat>((fin) => {
    minuterie = setTimeout(() => {
      void navigateur?.close().catch(() => {});
      fin({ code: 1, texte: `page_voir : 1 page en erreur\nla page ne répond plus : ${Math.round((delaiMs * 6) / 1000)} s sans rendre la main (une boucle sans fin dans un script ?)`, charges: [...charges] });
    }, delaiMs * 6);
  });
  try {
    return await Promise.race([travail(), echeance]);
  } finally {
    clearTimeout(minuterie);
    await navigateur?.close().catch(() => {});
  }
}

// Chaque taille : la page défile-t-elle de côté (et à cause de quoi), quels textes sont coupés, puis une capture de ce que
// l'écran montre. Les captures finissent côte à côte sur une planche PNG dans le dossier des captures (partage/, ou le
// bureau avec des rôles), lisible d'un coup d'œil.
// Le nom de la planche des tailles, depuis la capture déjà normalisée en .png : le lanceur la commite.
export function nomPlanche(capture?: string): string {
  return capture ? capture.replace(/\.png$/i, "-tailles.png") : "tailles.png";
}

async function auxTailles(navigateur: import("playwright-core").Browser, page: import("playwright-core").Page, tailles: string[], dossier: string, capture?: string): Promise<{ lignes: string[]; defauts: number; planche: string }> {
  const lignes: string[] = [];
  const vignettes: Array<{ nom: string; png: string }> = [];
  let defauts = 0;
  const depart = page.viewportSize();
  for (const brute of tailles) {
    const m = /^\s*(\d{3,4})\s*[x×]\s*(\d{3,4})\s*$/.exec(brute);
    if (!m) { lignes.push(`${brute} : taille illisible (écrire 1280x800)`); continue; }
    const [l, h] = [Number(m[1]), Number(m[2])];
    await page.setViewportSize({ width: l, height: h });
    await page.waitForTimeout(400); // le temps des media queries et des redessins
    const r = await page.evaluate(() => {
      const W = window.innerWidth, large = document.documentElement.scrollWidth;
      const nom = (el: Element) => (el.id ? `#${el.id}` : el.tagName.toLowerCase() + (el.classList[0] ? `.${el.classList[0]}` : ""));
      const coupes = new Set<string>(), dehors = new Set<string>();
      for (const el of Array.from(document.body.querySelectorAll("*"))) {
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden") continue;
        const b = el.getBoundingClientRect();
        if (b.width <= 1 || b.height <= 1) continue; // les textes pour lecteur d'écran, masqués à 1 px, ne sont pas coupés
        const cache = (v: string) => v === "hidden" || v === "clip";
        const texte = Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? "").trim() !== "");
        if (texte && ((cache(cs.overflowX) && el.scrollWidth > el.clientWidth + 1) || (cache(cs.overflowY) && el.scrollHeight > el.clientHeight + 1))) coupes.add(nom(el));
        if (large > W + 1 && b.right > W + 1 && cs.position !== "fixed") dehors.add(nom(el));
      }
      return { W, large, coupes: [...coupes], dehors: [...dehors] };
    });
    const soucis: string[] = [];
    if (r.large > r.W + 1) soucis.push(`la page défile de côté (${r.large} px pour ${r.W}) : ${r.dehors.slice(0, 5).join(", ")}${r.dehors.length > 5 ? "…" : ""}`);
    if (r.coupes.length) soucis.push(`${r.coupes.length} texte${r.coupes.length > 1 ? "s" : ""} coupé${r.coupes.length > 1 ? "s" : ""} : ${r.coupes.slice(0, 5).join(", ")}${r.coupes.length > 5 ? "…" : ""}`);
    if (soucis.length) defauts++;
    lignes.push(`${l}×${h} : ${soucis.length ? soucis.join(" ; ") : "rien ne déborde, aucun texte coupé"}`);
    vignettes.push({ nom: `${l}×${h}`, png: (await page.screenshot()).toString("base64") });
  }
  if (depart) await page.setViewportSize(depart);
  const planche = nomPlanche(capture);
  const feuille = await navigateur.newPage({ viewport: { width: 1600, height: 900 } });
  await feuille.setContent(`<body style="margin:0;padding:16px;background:#222;color:#eee;font:14px sans-serif;display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start">${vignettes.map((v) => `<figure style="margin:0"><figcaption>${v.nom}</figcaption><img src="data:image/png;base64,${v.png}" style="width:360px;border:1px solid #666"></figure>`).join("")}</body>`);
  await feuille.screenshot({ path: join(dossier, planche), fullPage: true });
  await feuille.close();
  return { lignes, defauts, planche };
}

// Les feuilles de style de la page (balises <style> et <link> vers partage/) sont relues en texte, reparsées dans la
// page (une feuille construite est lisible, une feuille file:// ne l'est pas), et chaque sélecteur est testé contre
// le DOM chargé. Une règle qui ne touche rien n'est signalée que si un de ses noms de classe ou d'id est absent du
// HTML et de tous les scripts : `.selected` posé plus tard par le JS se tait, `.grid-table` que personne ne crée parle.
async function stylesSansCible(page: import("playwright-core").Page, dossierPage: string, racine: string): Promise<Orphelin[]> {
  const lire = (href: string) => {
    const propre = normaliserChemin(href.split(/[?#]/)[0]!);
    const chemin = propre && resolve(dossierPage, propre);
    return chemin && chemin.startsWith(racine + "/") && existsSync(chemin) && lstatSync(chemin).isFile() ? readFileSync(chemin, "utf8") : undefined;
  };
  const liens = await page.$$eval("link[rel~='stylesheet'][href], script[src]", (els) => els.map((e) => ({ balise: e.tagName, ref: e.getAttribute(e.tagName === "LINK" ? "href" : "src") ?? "" })));
  const feuilles: Array<{ nom: string; texte: string }> = [];
  let code = (await page.evaluate(() => document.documentElement.outerHTML)).replace(/<style[\s\S]*?<\/style>/gi, ""); // les feuilles en ligne ne sont pas du code
  for (const { balise, ref } of liens) {
    if (/^[a-z]+:/i.test(ref)) continue; // http(s), data… : rien à lire dans partage/
    const texte = lire(ref);
    if (texte === undefined) continue;
    if (balise === "LINK") feuilles.push({ nom: ref, texte });
    else code += "\n" + texte;
  }
  const enLigne = await page.$$eval("style", (els) => els.map((e) => e.textContent ?? ""));
  enLigne.forEach((texte, i) => feuilles.push({ nom: `style en ligne ${i + 1}`, texte }));
  const candidats: Orphelin[] = await page.evaluate((fs) => {
    const sortie: Array<{ selecteur: string; feuille: string }> = [];
    const parcourir = (regles: CSSRuleList, feuille: string) => {
      for (const r of Array.from(regles)) {
        if ("cssRules" in r && (r as CSSGroupingRule).cssRules) parcourir((r as CSSGroupingRule).cssRules, feuille);
        const sel = (r as CSSStyleRule).selectorText;
        if (!sel) continue;
        for (const partie of sel.split(",")) {
          const s = partie.trim();
          const base = s.replace(/::?[a-zA-Z-]+(\([^)]*\))?/g, "").trim(); // sans :hover, ::before…
          if (!base || !/[.#][A-Za-z_-]/.test(base)) continue; // seuls les noms de classe et d'id sont vérifiables
          try { if (document.querySelector(base) === null) sortie.push({ selecteur: s, feuille }); } catch { /* sélecteur que ce navigateur ne lit pas */ }
        }
      }
    };
    for (const f of fs) {
      try { const feuille = new CSSStyleSheet(); feuille.replaceSync(f.texte); parcourir(feuille.cssRules, f.nom); } catch { /* feuille illisible */ }
    }
    return sortie;
  }, feuilles);
  const nomsDuCode = new Set(code.match(/[A-Za-z_][\w-]*/g) ?? []);
  // Un nom peut être construit par concaténation (`"type-" + tp`) : tout littéral finissant par - ou _
  // vaut préfixe, et une classe qui en descend n'est pas tenue pour absente.
  const prefixes = (code.match(/["'`]([A-Za-z_][\w-]*[-_])["'`]/g) ?? []).map((m) => m.slice(1, -1));
  const connu = (n: string) => nomsDuCode.has(n) || prefixes.some((p) => n.startsWith(p));
  return candidats.filter((o) => (o.selecteur.match(/[.#]([A-Za-z_-][\w-]*)/g) ?? []).some((n) => !connu(n.slice(1))));
}

// Ligne de commande : voir.ts --partage DIR PAGE [--clic SEL]… [--capture NOM]
const principal = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (principal) {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: { partage: { type: "string" }, clic: { type: "string", multiple: true }, capture: { type: "string" }, parcours: { type: "boolean" }, taille: { type: "string", multiple: true }, tailles: { type: "boolean" } },
    allowPositionals: true,
    strict: true,
  });
  if (!values.partage || positionals.length !== 1) {
    console.error("usage : voir.ts --partage DIR PAGE [--clic SEL]... [--capture NOM] [--parcours] [--tailles | --taille 1280x800...]");
    process.exit(2);
  }
  const tailles = values.taille ?? (values.tailles ? [] : undefined);
  const r = await voir(values.partage, { page: positionals[0]!, clics: values.clic, capture: values.capture, parcours: values.parcours, tailles });
  console.log(r.invalide ? `page_voir : 2 page refusée · ${r.texte}` : r.texte);
  process.exit(r.code);
}
