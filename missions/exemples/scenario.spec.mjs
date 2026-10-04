// scenario.spec.mjs — un scénario Playwright minimal sur un Puissance 4 livré (P4, A2) :
// ouvrir index.html en file://, cliquer sur la colonne 4, lire le texte du tour, cliquer
// « Nouvelle partie », affirmer que la grille est vide. Sort 0 si tout passe, 1 sinon.
// Lancé depuis le dossier partagé : `node scenario.spec.mjs`. Il n'a besoin que de
// playwright-core épinglé dans le dépôt de l'essaim (ESSAIM_DEPOT, exporté par le lanceur
// dans l'environnement des agents) et du chrome-headless-shell du cache : rien ne se
// télécharge, rien ne s'installe. Script autonome : le chemin du navigateur est recopié
// de src/voir.ts pour que ce fichier reste copiable seul.
// Contrat DOM attendu (à écrire dans la mission qui l'exige) : les colonnes sont les
// enfants directs de #grille, un jeton posé porte une classe qui commence par « joueur »,
// le tour s'affiche dans #info ou #statut, le bouton s'appelle #nouvellePartie.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const depot = process.env.ESSAIM_DEPOT ?? resolve(dirname(new URL(import.meta.url).pathname), "..", "..");
const require = createRequire(join(depot, "package.json"));
const { chromium } = require("playwright-core");
const browsers = JSON.parse(readFileSync(join(dirname(require.resolve("playwright-core/package.json")), "browsers.json"), "utf8"));
const revision = browsers.browsers.find((b) => b.name === "chromium-headless-shell").revision;
const executablePath = join(homedir(), "Library", "Caches", "ms-playwright", `chromium_headless_shell-${revision}`, "chrome-headless-shell-mac-arm64", "chrome-headless-shell");
if (!existsSync(executablePath)) { console.error(`navigateur absent : ${executablePath}`); process.exit(1); }

const page_html = resolve(process.argv[2] ?? "index.html");
const echecs = [];
const affirmer = (ok, quoi) => { console.log(`${ok ? "ok" : "KO"}  ${quoi}`); if (!ok) echecs.push(quoi); };

const navigateur = await chromium.launch({ executablePath, headless: true });
try {
  const page = await navigateur.newPage();
  const erreurs = [];
  page.on("pageerror", (e) => erreurs.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") erreurs.push(m.text()); });
  await page.goto(pathToFileURL(page_html).href, { waitUntil: "load" });
  affirmer(erreurs.length === 0, `la page se charge sans erreur${erreurs.length ? " : " + erreurs[0] : ""}`);
  const jetons = () => page.$$eval("#grille [class*='joueur']", (els) => els.length);
  affirmer((await jetons()) === 0, "la grille est vide au départ");
  await page.click("#grille > div:nth-child(4)");
  await page.waitForTimeout(800); // le jeton humain, puis la réponse de l'ordinateur
  const apres = await jetons();
  affirmer(apres >= 1, `un jeton est posé après le clic sur la colonne 4 (${apres} jeton${apres > 1 ? "s" : ""})`);
  affirmer(apres === 2, "l'ordinateur a répondu");
  const statut = await page.$eval("#info, #statut", (e) => e.textContent.trim()).catch(() => "");
  affirmer(/jouer|tour|vous/i.test(statut), `le tour est affiché : « ${statut} »`);
  await page.click("#nouvellePartie");
  await page.waitForTimeout(300);
  affirmer((await jetons()) === 0, "« Nouvelle partie » vide la grille");
} catch (e) {
  affirmer(false, `exception : ${String(e.message ?? e).split("\n")[0]}`);
} finally {
  await navigateur.close();
}
process.exit(echecs.length ? 1 : 0);
