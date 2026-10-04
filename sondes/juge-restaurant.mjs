// juge-restaurant.mjs — le juge mécanique de la mission « restaurant » (missions/restaurant.md).
// Il agit comme un serveur : il clique et tape dans l'interface visible, jamais dans l'objet JavaScript de la page.
// Les valeurs attendues viennent de sondes/restaurant.py (référence écrite depuis la mission seule, avant de regarder
// le livrable). Il constate, contrôle par contrôle (ok / KO et la raison) ; il ne note pas.
// Lancé depuis le dépôt : `node sondes/juge-restaurant.mjs runs/<run>/partage runs/<run>/juge`
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const depot = resolve(dirname(new URL(import.meta.url).pathname), "..");
const require = createRequire(join(depot, "package.json"));
const { chromium } = require("playwright-core");
const browsers = JSON.parse(readFileSync(join(dirname(require.resolve("playwright-core/package.json")), "browsers.json"), "utf8"));
const revision = browsers.browsers.find((b) => b.name === "chromium-headless-shell").revision;
const executablePath = join(homedir(), "Library", "Caches", "ms-playwright", `chromium_headless_shell-${revision}`, "chrome-headless-shell-mac-arm64", "chrome-headless-shell");
if (!existsSync(executablePath)) { console.error(`navigateur absent : ${executablePath}`); process.exit(1); }

const partage = resolve(process.argv[2] ?? ".");
const sortie = resolve(process.argv[3] ?? join(partage, "..", "juge"));
mkdirSync(sortie, { recursive: true });
const R = JSON.parse(execFileSync("python3", [join(depot, "sondes", "restaurant.py")], { encoding: "utf8" }));
writeFileSync(join(sortie, "restaurant-reference.json"), JSON.stringify(R, null, 1));
const base = pathToFileURL(join(partage, "index.html")).href;
const NOM = R.noms.carte, ING = R.noms.ingredients;

// ------------------------------------------------------------------ outils de constat
const plat = (s) => String(s ?? "").replace(/[\s\u00a0\u202f]+/g, " ").trim();
const eur = (c) => { const e = Math.floor(Math.abs(c) / 100), r = String(Math.abs(c) % 100).padStart(2, "0"); return `${c < 0 ? "-" : ""}${String(e).replace(/\B(?=(\d{3})+(?!\d))/g, " ")},${r} €`; };
const lireEur = (s) => { const m = plat(s).match(/(?<![\d,])(-?\d{1,3}(?: \d{3})*),(\d{2})\s*€/); return m ? Math.round(parseInt(m[1].replace(/ /g, ""), 10) * 100 + parseInt(m[2], 10)) : null; };
const exact = (s) => new RegExp(`^\\s*${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`);
const controles = [], introuvables = [], syncs = [], constats = {};
let section = "";
const titre = (t) => { section = t; console.log(`\n== ${t}`); };
const dire = (bon, quoi) => { controles.push({ section, ok: !!bon, quoi }); console.log(`${bon ? "ok" : "KO"}  ${quoi}`); return !!bon; };
const egal = (lu, attendu, quoi) => dire(lu === attendu, `${quoi} : attendu ${attendu}, lu ${lu ?? "rien"}`);
const erreurs = [];
const touches = { n: 0 };

function suivre(p, nom) {
  p.on("pageerror", (e) => erreurs.push(`${nom} : exception ${e.message.split("\n")[0]}`));
  p.on("console", (m) => { if (m.type() === "error") erreurs.push(`${nom} : console ${m.text().slice(0, 160)}`); });
  p.on("dialog", (d) => d.accept());
}

// un geste : attendre que la cible soit visible, cliquer ; sinon le geste est introuvable (ou bloqué) et se note
async function toucher(loc, quoi, { timeout = 2500 } = {}) {
  const l = loc.first();
  try { await l.waitFor({ state: "visible", timeout }); } catch { introuvables.push(quoi); dire(false, `geste introuvable : ${quoi}`); return false; }
  try { await l.click({ timeout: 3000 }); touches.n++; return true; } catch { }
  // une notification fixe peut couvrir la cible : on fait défiler comme un humain puis on retente
  try {
    await l.evaluate((e) => e.scrollIntoView({ block: "start" }));
    await l.click({ timeout: 3000 }); touches.n++;
    (constats.cibles_couvertes ??= []).push(quoi);
    return true;
  } catch (e) {
    // ce qui se trouve sous le doigt, au centre de la cible
    const qui = await l.evaluate((el) => { const r = el.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2; const d = document.elementFromPoint(x, y);
      if (!d || d === el || el.contains(d)) return `cible en ${Math.round(x)},${Math.round(y)} hors de l'écran ou désactivée`;
      const t = d.closest("#toasts .toast, .toast, #voile, header") || d; return `couverte par ${t.tagName.toLowerCase()}${t.id ? "#" + t.id : ""}.${String(t.className).trim().replace(/\s+/g, ".")} « ${(t.innerText || "").replace(/\s+/g, " ").trim().slice(0, 50)} »`; }).catch(() => "");
    introuvables.push(`${quoi} (bloqué${qui ? " : " + qui : ""})`); dire(false, `geste bloqué : ${quoi}${qui ? " — " + qui : ""}`); return false;
  }
}
async function remplir(loc, valeur, quoi) {
  const l = loc.first();
  try { await l.waitFor({ state: "visible", timeout: 2500 }); await l.fill(String(valeur)); return true; }
  catch { introuvables.push(`champ ${quoi}`); dire(false, `champ introuvable : ${quoi}`); return false; }
}
const texte = async (p) => plat(await p.evaluate(() => document.body.innerText));
const txt = async (loc) => { try { return plat(await loc.first().innerText({ timeout: 1500 })); } catch { return ""; } };

// délai de synchronisation : horodatage avant le geste, attente de la condition dans chaque autre fenêtre
async function mesurer(quoi, geste, obs) {
  const t0 = Date.now();
  await geste();
  const res = await Promise.all(obs.map(async ([p, nom, fn, arg]) => {
    try { await p.waitForFunction(fn, arg, { timeout: 3000, polling: 20 }); return [nom, Date.now() - t0]; } catch { return [nom, null]; }
  }));
  for (const [nom, ms] of res) {
    syncs.push({ geste: quoi, fenetre: nom, ms });
    dire(ms !== null && ms < 1000, `synchro « ${quoi} » → ${nom} : ${ms === null ? "jamais vu en 3 s" : `${ms} ms`}`);
  }
}

// ------------------------------------------------------------------ gestes de l'application (par l'interface)
const allerA = async (p, page) => {
  const lien = p.locator("#nav a", { hasText: new RegExp(page, "i") });
  if (!(await toucher(lien, `lien de navigation « ${page} »`))) await p.goto(`${base}#${page.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")}`);
  await p.waitForTimeout(150);
};
async function reglerHeure(p, hhmm) {
  if (!(await toucher(p.locator("header button.horloge, header [aria-label*='heure' i]"), "horloge du bandeau"))) return false;
  await remplir(p.locator("#modale input[type=time]"), hhmm, "heure du service");
  const ok = await toucher(p.locator("#modale").getByRole("button", { name: exact("Régler") }), "bouton Régler l'heure");
  await p.keyboard.press("Escape");
  return ok;
}
const carteTable = (p, t) => p.locator(`button[aria-label^="Table ${t},"]`);
async function installer(p, t, cv) {
  if (!(await toucher(carteTable(p, t), `table ${t} sur le plan`))) return false;
  await remplir(p.locator("#modale").getByLabel(/Couverts/), cv, `couverts de ${t}`);
  const ok = await toucher(p.locator("#modale").getByRole("button", { name: /Installer les clients/ }), `installer ${t}`);
  await p.keyboard.press("Escape");
  return ok;
}
const article = (p, code) => p.locator("button.article").filter({ has: p.locator(".nom", { hasText: exact(NOM[code]) }) });
async function choisirTable(p, t) { return toucher(p.locator(".tabs button", { hasText: new RegExp(`^\\s*${t}\\s·`) }), `onglet de la table ${t}`); }
async function commander(p, t, lignes) {
  await choisirTable(p, t);
  for (const [code, q] of lignes) for (let i = 0; i < q; i++) if (!(await toucher(article(p, code), `article ${NOM[code]} (${t})`))) break;
}
const envoyer = (p, t) => toucher(p.getByRole("button", { name: /Envoyer en cuisine/ }), `envoyer en cuisine (${t})`);

async function etatsCuisine(p) {
  return p.evaluate(() => [...document.querySelectorAll(".kds-carte")].map((c, i) => ({
    i, table: c.querySelector(".kc-table")?.textContent.trim(), nom: c.querySelector(".kc-nom")?.textContent.trim(),
    statut: c.querySelector(".badge")?.textContent.trim(), attente: c.querySelector(".kc-attente")?.textContent.trim(),
    poste: c.closest(".kds-colonne")?.querySelector("h2")?.firstChild?.textContent.trim(),
  })));
}
// fait avancer chaque ligne d'une table jusqu'à « prête » (ou la sert si servir)
async function avancerTable(p, t, servir = false) {
  for (let k = 0; k < 60; k++) {
    const cs = (await etatsCuisine(p)).filter((c) => c.table === t);
    const c = cs.find((x) => servir ? x.statut === "prête" : x.statut === "envoyée" || x.statut === "en préparation");
    if (!c) return true;
    if (!(await toucher(p.locator(".kds-carte").nth(c.i).getByRole("button", { name: servir ? /Servi/ : /En préparation|Prêt/ }), `avancer ${c.nom} (${t}) en cuisine`))) return false;
    await p.waitForTimeout(60);
  }
  return false;
}
async function lireStocks(p) {
  return p.evaluate(() => Object.fromEntries([...document.querySelectorAll(".ligne-addition")].map((r) => {
    const nom = r.querySelector("b")?.textContent.trim(); const v = r.querySelector(".prix")?.textContent.trim();
    return [nom, v ? parseInt(v, 10) : null];
  }).filter(([n, v]) => n && v !== null && !Number.isNaN(v))));
}
async function stats(p) {
  return p.evaluate(() => Object.fromEntries([...document.querySelectorAll(".stat")].map((s) => [s.querySelector(".libelle")?.textContent.trim(), s.querySelector(".valeur")?.textContent.replace(/[\s\u00a0\u202f]+/g, " ").trim()])));
}
const stat = (s, debut) => { const k = Object.keys(s).find((x) => x.startsWith(debut)); return k ? s[k] : null; };
const apresRendu = (p) => p.evaluate(() => new Promise((r) => {
  const m = document.getElementById("modale"); if (!m) return r();
  const o = new MutationObserver(() => { o.disconnect(); r(); }); o.observe(m, { childList: true }); setTimeout(() => { o.disconnect(); r(); }, 1500);
}));
async function ouvrirReglement(p, t) {
  await choisirTable(p, t);
  return toucher(p.getByRole("button", { name: /Régler l.addition/ }), `régler l'addition de ${t}`);
}
async function encaisserUneFois(p, t, montant, mode, recu) {
  const m = p.locator("#modale");
  await toucher(m.getByRole("button", { name: exact("En une fois") }), `onglet « en une fois » (${t})`);
  await toucher(m.getByRole("button", { name: mode === "especes" ? /Espèces/ : /Carte/ }), `mode ${mode} (${t})`);
  await apresRendu(p); // la modale de paiement se redessine chaque seconde : on tape juste après un rendu
  if (recu !== undefined) await remplir(m.getByLabel(/Montant reçu/), (recu / 100).toFixed(2), "montant reçu");
  await remplir(m.getByLabel(/Montant à encaisser/), (montant / 100).toFixed(2), "montant à encaisser");
  return toucher(m.getByRole("button", { name: /^Encaisser/ }), `encaisser ${eur(montant)} (${t})`);
}
async function paiementsAffiches(p) {
  return p.evaluate(() => [...document.querySelectorAll("#app .paiement")].map((e) => e.innerText.replace(/[\s\u00a0\u202f]+/g, " ").trim()));
}

// ------------------------------------------------------------------ mesures de mise en page (dans la page)
function mesuresPage(tactile) {
  const vw = innerWidth, out = { defileCote: document.documentElement.scrollWidth > vw + 1, deborde: [], coupes: [], petites: [], sansNom: [], contrastes: [] };
  const visible = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && !e.closest("#voile:not(.ouvert)"); };
  const dansDefilant = (e) => { for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) { const o = getComputedStyle(a).overflowX; if (o === "auto" || o === "scroll") return true; } return false; };
  const nom = (e) => (e.id ? "#" + e.id : e.tagName.toLowerCase() + (e.className && typeof e.className === "string" ? "." + e.className.trim().split(/\s+/).join(".") : "")) + " « " + (e.innerText || e.value || e.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 30) + " »";
  for (const e of document.querySelectorAll("body *")) {
    if (!visible(e) || e.closest("#toasts")) continue;
    const r = e.getBoundingClientRect();
    if ((r.right > vw + 1 || r.left < -1) && !dansDefilant(e) && e.children.length === 0) out.deborde.push(nom(e));
    const s = getComputedStyle(e);
    const aTexte = [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (aTexte && e.scrollWidth > e.clientWidth + 1 && (s.overflowX === "hidden" || s.overflowX === "clip" || s.textOverflow === "ellipsis")) out.coupes.push(nom(e));
  }
  const cliquables = [...document.querySelectorAll("a[href], button, input:not([type=hidden]), select, textarea, [data-act], [role=button]")].filter((e) => visible(e) && !e.closest("#toasts"));
  for (const e of cliquables) {
    const r = e.getBoundingClientRect();
    if (tactile && (r.width < 44 || r.height < 44) && e.type !== "checkbox") out.petites.push(`${nom(e)} ${Math.round(r.width)}×${Math.round(r.height)}`);
    if ((e.tagName === "BUTTON" || e.tagName === "A") && !(e.innerText.trim() || e.getAttribute("aria-label") || e.getAttribute("title"))) out.sansNom.push(nom(e));
  }
  // contraste texte / fond effectif (WCAG), sur les éléments porteurs de texte
  const rgb = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const [r, g, b, a = 1] = m[1].split(",").map(parseFloat); return { r, g, b, a }; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const fond = (e) => { for (let a = e; a; a = a.parentElement) { const s = getComputedStyle(a); if (s.backgroundImage && s.backgroundImage !== "none") return null; const c = rgb(s.backgroundColor); if (c && c.a > 0.5) return c; } return { r: 255, g: 255, b: 255 }; };
  for (const e of document.querySelectorAll("#app *, header *")) {
    if (!visible(e) || ![...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    const s = getComputedStyle(e); const f = fond(e); const c = rgb(s.color); if (!f || !c) continue;
    const L1 = lum(c), L2 = lum(f); const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const px = parseFloat(s.fontSize), gras = parseInt(s.fontWeight, 10) >= 700;
    const seuil = px >= 24 || (gras && px >= 18.66) ? 3 : 4.5;
    if (ratio < seuil) out.contrastes.push(`${nom(e)} ${ratio.toFixed(2)}`);
  }
  return out;
}

// ======================================================================================== le service
const PAGES = ["salle", "commande", "cuisine", "caisse", "reservations", "carte", "stocks", "tableau"];
const TAILLES = [[390, 844], [768, 1024], [1024, 768], [1440, 900], [1920, 1080]];
const navigateur = await chromium.launch({ executablePath, headless: true });
try {
  // ---------------------------------------------------------------- 1. les huit pages à leur adresse
  titre("Les huit pages à leur adresse");
  {
    const ctx = await navigateur.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await ctx.newPage(); const avant = erreurs.length; suivre(p, "ouverture");
    await p.goto(base); await p.waitForTimeout(600);
    const acc = await texte(p);
    const liens = await p.evaluate(() => [...document.querySelectorAll("#app a[href^='#']")].map((a) => a.getAttribute("href")));
    dire(PAGES.every((x) => liens.includes(`#${x}`)), `index.html seul ouvre un accueil qui mène aux huit pages (${liens.length} liens)`);
    for (const x of PAGES) {
      await p.goto("about:blank"); await p.goto(`${base}#${x}`); await p.waitForTimeout(500);
      const h1 = await txt(p.locator("#app h1"));
      const actif = await txt(p.locator("#nav a.actif"));
      dire(h1 && actif.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").includes(x.slice(0, 5)), `index.html#${x} ouvre sa page (titre « ${h1} », lien actif « ${actif} »)`);
    }
    dire(erreurs.length === avant, `aucune exception ni erreur de console à l'ouverture${erreurs.length > avant ? " : " + erreurs.slice(avant).join(" | ") : ""}`);
    constats.accueil_extrait = acc.slice(0, 200);
    await ctx.close();
  }

  // ---------------------------------------------------------------- 1 bis. la règle de réservation sur une journée ouverte avant midi
  // L'application part de l'heure réelle : ouverte l'après-midi, elle a déjà passé les réservations du midi en « non venue »
  // avant qu'on règle l'horloge. On rejoue donc les réservations dans un navigateur dont l'heure système est 12:10.
  titre("Variante : journée ouverte à 12:10 (heure du navigateur), réservations");
  {
    const cv = await navigateur.newContext({ viewport: { width: 1024, height: 768 } });
    const d = new Date(); d.setHours(12, 10, 0, 0); await cv.clock.setFixedTime(d);
    const p = await cv.newPage(); suivre(p, "variante 12:10");
    await p.goto(`${base}#reservations`); await p.waitForSelector("#app h1");
    await reglerHeure(p, "12:20");
    const carte = (nom) => p.locator("#app .card").filter({ has: p.locator("b", { hasText: exact(nom) }) });
    const cree = async (nom, heure, cv) => {
      await remplir(p.getByLabel("Nom", { exact: true }), nom, "nom"); await remplir(p.getByLabel("Heure", { exact: true }), heure, "heure");
      await remplir(p.getByLabel("Couverts", { exact: true }), cv, "couverts"); await toucher(p.getByRole("button", { name: exact("Réserver") }), "Réserver");
      await p.waitForTimeout(150);
    };
    dire(/non venue/.test(await txt(carte("Martin"))) && /attente/.test(await txt(carte("Lefèvre"))), `à 12:20 : Martin non venue, Lefèvre en attente`);
    await cree("Juge A", "12:45", 3);
    const ja = await txt(carte("Juge A"));
    dire(ja.includes(`Table ${R.reservations.juge_A.table}`), `Juge A (12:45, 3 couverts) attribuée à ${R.reservations.juge_A.table} : lu « ${ja.slice(0, 70)} »`);
    await cree("Juge Z", "12:40", 8);
    const tz = await txt(p.locator("#toasts .erreur"));
    dire(!(await carte("Juge Z").count()) && /aucune table/i.test(tz), `Juge Z (12:40, 8 couverts) refusée avec motif : « ${tz.slice(0, 110)} »`);
    await allerA(p, "Salle");
    const et = await p.evaluate(() => Object.fromEntries([...document.querySelectorAll("button[aria-label^='Table ']")].map((b) => { const m = b.getAttribute("aria-label").match(/^Table (T\d+), (.*)$/); return [m[1], m[2]]; })));
    const f = Object.entries(R.reservations.tables_a_12h20_avant_installation).filter(([t, e]) => et[t] !== e);
    dire(f.length === 0, `états des douze tables à 12:20${f.length ? " : " + f.map(([t, e]) => `${t} attendu ${e}, lu ${et[t]}`).join(" ; ") : ""}`);
    await installer(p, "T3", 4);
    await allerA(p, "Réservations");
    dire(/install/i.test(await txt(carte("Lefèvre"))), `installer T3 réservée passe Lefèvre « installée »`);
    await cv.close();
  }

  // ---------------------------------------------------------------- 2. trois fenêtres et le service scénarisé
  const ctx = await navigateur.newContext({ viewport: { width: 1024, height: 768 } });
  const ouvrir = async (ancre, w, h, nom) => { const p = await ctx.newPage(); await p.setViewportSize({ width: w, height: h }); suivre(p, nom); await p.goto(`${base}#${ancre}`); await p.waitForSelector("#app h1"); return p; };
  const cmd = await ouvrir("commande", 1024, 768, "commande 1024×768");
  const cui = await ouvrir("cuisine", 1440, 900, "cuisine 1440×900");
  const tab = await ouvrir("tableau", 390, 844, "tableau 390×844");
  const aux = await ouvrir("salle", 1024, 768, "salle/caisse 1024×768");
  const cmd2 = await ouvrir("commande", 768, 1024, "commande n°2 768×1024");

  titre("Horloge réglée, partagée par toutes les fenêtres");
  await mesurer("horloge réglée à 12:20", () => reglerHeure(aux, "12:20"),
    [[cmd, "commande", () => document.querySelector("#horloge-heure")?.textContent === "12:20"], [cui, "cuisine", () => document.querySelector("#horloge-heure")?.textContent === "12:20"], [tab, "tableau", () => document.querySelector("#horloge-heure")?.textContent === "12:20"]]);

  titre("Réservations");
  await allerA(aux, "Réservations");
  const carteResa = (nom) => aux.locator("#app .card").filter({ has: aux.locator("b", { hasText: exact(nom) }) });
  for (const [nom, t] of Object.entries(R.reservations.csv)) {
    const c = await txt(carteResa(nom));
    dire(c.includes(`Table ${t}`), `réservation ${nom} (données) attribuée à ${t} : lu « ${c.slice(0, 70)} »`);
  }
  dire((await txt(carteResa("Martin"))).includes("non venue"), `à 12:20, Martin (12:00) est « non venue » : lu « ${(await txt(carteResa("Martin"))).slice(0, 60)} »`);
  const nouvelleResa = async (nom, heure, cv) => {
    await remplir(aux.getByLabel("Nom", { exact: true }), nom, "nom de réservation");
    await remplir(aux.getByLabel("Heure", { exact: true }), heure, "heure de réservation");
    await remplir(aux.getByLabel("Couverts", { exact: true }), cv, "couverts de réservation");
    await remplir(aux.getByLabel(/Téléphone/), "06 00 00 00 00", "téléphone");
    await toucher(aux.getByRole("button", { name: exact("Réserver") }), "bouton Réserver");
    await aux.waitForTimeout(150);
  };
  await nouvelleResa("Juge A", "12:45", 3);
  const ja = await txt(carteResa("Juge A"));
  dire(ja.includes(`Table ${R.reservations.juge_A.table}`), `Juge A (12:45, 3 couverts) attribuée à ${R.reservations.juge_A.table} : lu « ${ja.slice(0, 70)} »`);
  await nouvelleResa("Juge Z", "12:40", 8);
  const toastZ = await txt(aux.locator("#toasts"));
  dire(!(await carteResa("Juge Z").count()) && /aucune table|impossible|refus/i.test(toastZ), `Juge Z (12:40, 8 couverts) refusée avec motif : « ${toastZ.slice(0, 110)} »`);
  constats.motif_refus = toastZ;

  titre("Plan de salle à 12:20");
  await allerA(aux, "Salle");
  const etats = await aux.evaluate(() => Object.fromEntries([...document.querySelectorAll("button[aria-label^='Table ']")].map((b) => { const m = b.getAttribute("aria-label").match(/^Table (T\d+), (.*)$/); return m ? [m[1], m[2]] : ["?", ""]; })));
  const faux = Object.entries(R.reservations.tables_a_12h20_avant_installation).filter(([t, e]) => etats[t] !== e);
  dire(faux.length === 0, `états des douze tables à 12:20${faux.length ? " : " + faux.map(([t, e]) => `${t} attendu ${e}, lu ${etats[t]}`).join(" ; ") : ""}`);

  titre("Installations");
  touches.n = 0;
  await mesurer("installer T5 (3 couverts)", () => installer(aux, "T5", 3),
    [[cmd, "commande", () => [...document.querySelectorAll(".tabs button")].some((b) => /^T5\b/.test(b.textContent.trim()))], [tab, "tableau", () => [...document.querySelectorAll(".stat")].some((x) => /Tables occupées/.test(x.textContent) && x.querySelector(".valeur")?.textContent.trim() === "1")]]);
  constats.touches_installer = touches.n;
  await installer(aux, "T3", 4); await installer(aux, "T10", 4); await installer(aux, "T9", 2);
  const et2 = await aux.evaluate(() => [...document.querySelectorAll("button[aria-label^='Table ']")].map((b) => b.getAttribute("aria-label")));
  dire(["T5", "T3", "T10", "T9"].every((t) => et2.includes(`Table ${t}, occupée`)), `T5, T3 (réservée Lefèvre), T10, T9 occupées`);
  await allerA(aux, "Réservations");
  dire(/install/i.test(await txt(carteResa("Lefèvre"))), `la réservation Lefèvre passe « installée » : lu « ${(await txt(carteResa("Lefèvre"))).slice(0, 60)} »`);

  titre("Commandes, annulation, stocks");
  touches.n = 0;
  await commander(cmd, "T5", R.commandes.T5);
  const panierT5 = lireEur(await txt(cmd.locator(".total-bar .t")));
  egal(panierT5, R.commandes.T5.reduce((s, [c, q]) => s + q * { E1: 850, P1: 2200, P3: 1900, B4: 650, B1: 450 }[c], 0), "total du panier T5 avant envoi");
  await mesurer("envoi de la commande T5", () => envoyer(cmd, "T5"),
    [[cui, "cuisine", () => [...document.querySelectorAll(".kds-carte")].some((c) => c.innerText.includes("T5") && c.innerText.includes("Velouté"))],
      [tab, "tableau (valeur du stock)", (v) => ![...document.querySelectorAll(".stat")].some((x) => x.textContent.replace(/[\s\u00a0\u202f]+/g, " ").includes(v)), `Valeur du stock${eur(R.stocks.valeur_depart)}`]]);
  constats.touches_commande_T5 = touches.n;
  await mesurer("annuler la ligne Eau (T5)", () => toucher(cmd.locator(".envoyees .panier-ligne", { hasText: NOM.B1 }).getByRole("button", { name: /Annuler/ }), "annuler la ligne Eau minérale"),
    [[cui, "cuisine", () => ![...document.querySelectorAll(".kds-carte")].some((c) => c.innerText.includes("T5") && c.innerText.includes("Eau min"))]]);
  await allerA(aux, "Stocks");
  {
    const s = await lireStocks(aux); const att = R.stocks.apres_annulation_B1;
    const touchés = ["potimarron", "creme", "boeuf", "vin_cuisine", "champignon", "riz", "cepes", "beurre", "vin_rouge", "eau"];
    const f = touchés.filter((k) => s[ING[k]] !== att[k]);
    dire(f.length === 0, `stocks après envoi T5 et annulation de l'eau${f.length ? " : " + f.map((k) => `${ING[k]} attendu ${att[k]}, lu ${s[ING[k]]}`).join(" ; ") : " (eau revenue à 48)"}`);
  }

  await reglerHeure(aux, "12:25");
  await commander(cmd, "T10", R.commandes.T10); await envoyer(cmd, "T10");
  await commander(cmd, "T3", R.commandes.T3); await envoyer(cmd, "T3");
  {
    const cs = await etatsCuisine(cui);
    const chaud = cs.filter((c) => c.poste === "Chaud").map((c) => c.table);
    const ordre = chaud.join(",");
    dire(/^(T5,)+(T10,)+(T3,?)+$/.test(ordre + ","), `cuisine : lignes du poste chaud dans l'ordre d'envoi (T5 puis T10 puis T3) : lu ${ordre}`);
    const postes = new Set(cs.map((c) => c.poste));
    dire(["Froid", "Chaud", "Dessert", "Bar"].every((x) => postes.has(x) || x === "Dessert"), `cuisine : lignes par poste (${[...postes].join(", ")})`);
  }

  titre("Cuisine : lignes avancées, salle prévenue");
  await reglerHeure(aux, "12:40");
  await allerA(aux, "Salle");
  await avancerTable(cui, "T5");
  await cmd.waitForTimeout(50);
  const t0 = Date.now();
  let vuSalle = null;
  try { await aux.waitForFunction(() => /Prêt/i.test(document.querySelector("button[aria-label^='Table T5,']")?.innerText || ""), null, { timeout: 3000, polling: 20 }); vuSalle = Date.now() - t0; } catch { }
  dire(vuSalle !== null, `plan de salle : T5 signalée prête quand toutes ses lignes sont prêtes${vuSalle !== null ? ` (vu en ${vuSalle} ms après la dernière touche)` : ""}`);
  const cmdTxt = await texte(cmd);
  dire(/T5[^.]{0,40}pr[êe]t|pr[êe]t[^.]{0,40}T5/i.test(cmdTxt), `prise de commande (sur une autre table) prévenue que T5 est prête`);
  await choisirTable(cmd, "T5");
  const envT5 = await cmd.evaluate(() => [...document.querySelectorAll(".envoyees .panier-ligne")].map((e) => e.innerText.replace(/\s+/g, " ")));
  dire(envT5.filter((e) => /prête/.test(e)).length === 4, `prise de commande T5 : 4 lignes « prête » (lu ${envT5.join(" | ")})`);
  const attT5 = (await etatsCuisine(cui)).filter((c) => c.table === "T5").map((c) => c.attente);
  dire(attT5.length === 4 && attT5.every((a) => a === "20 min"), `cuisine : attente des lignes T5 = 20 min (lu ${attT5.join(", ")})`);
  await avancerTable(cui, "T5", true);
  dire(!(await etatsCuisine(cui)).some((c) => c.table === "T5"), `lignes T5 servies, sorties de l'écran de cuisine`);
  await reglerHeure(aux, "12:52");
  await avancerTable(cui, "T10");
  const attT10 = (await etatsCuisine(cui)).filter((c) => c.table === "T10").map((c) => c.attente);
  dire(attT10.length === 4 && attT10.every((a) => a === "27 min"), `cuisine : attente des lignes T10 = 27 min (lu ${attT10.join(", ")})`);

  titre("Article offert");
  await allerA(aux, "Caisse");
  await choisirTable(aux, "T5");
  await toucher(aux.locator("#app .ligne-addition", { hasText: NOM.B4 }).getByRole("button", { name: /Offrir/ }), "offrir le verre de vin rouge (T5)");
  await remplir(aux.locator("#modale").getByLabel(/Auteur/), "Juge", "auteur du geste");
  await remplir(aux.locator("#modale").getByLabel(/Raison/), "anniversaire", "raison du geste");
  await toucher(aux.locator("#modale").getByRole("button", { name: exact("Offrir") }), "confirmer l'offre");
  {
    const t = await texte(aux);
    dire(t.includes(`Total TTC ${eur(R.tickets.T5.total)}`), `addition T5 avec le vin offert : ${eur(R.tickets.T5.total)} (lu « ${(t.match(/Total TTC [\d ,]+€/) || [""])[0]} »)`);
    dire(/offert · Juge/i.test(t), `le geste offert garde son auteur (« offert · Juge »)`);
    dire(/anniversaire/.test(t), `le geste offert garde sa raison (« anniversaire » visible en caisse)`);
  }

  titre("Rupture jusqu'à disparition de la prise de commande");
  await commander(cmd, "T9", [["D4", 13]]); await envoyer(cmd, "T9");
  await cmd2.waitForTimeout(700);
  const d4Actif = async (p) => p.evaluate((nom) => { const b = [...document.querySelectorAll("button.article")].find((x) => x.querySelector(".nom")?.textContent.trim() === nom); return b ? !(b.classList.contains("rupture") || b.getAttribute("aria-disabled") === "true" || b.disabled) : false; }, NOM.D4);
  dire(await d4Actif(cmd2), `avec ${R.stocks.fromage_avant_rupture} portion de fromage en stock, l'assiette de fromages se commande encore (autre fenêtre)`);
  await commander(cmd, "T9", [["D4", 1]]);
  await mesurer("envoi de la 18e assiette de fromages (rupture)", () => envoyer(cmd, "T9"),
    [[cmd2, "commande n°2", (nom) => { const b = [...document.querySelectorAll("button.article")].find((x) => x.querySelector(".nom")?.textContent.trim() === nom); return !b || b.classList.contains("rupture") || b.getAttribute("aria-disabled") === "true" || b.disabled; }, NOM.D4],
      [tab, "tableau (ruptures)", (nom) => document.body.innerText.includes(nom), NOM.D4]]);
  const visibleD4 = await article(cmd2, "D4").count();
  constats.rupture_dans_commande = visibleD4 ? "l'article reste affiché, grisé « Rupture », non commandable" : "l'article disparaît";
  {
    const avant = await txt(cmd2.locator(".panier"));
    if (visibleD4) { try { await article(cmd2, "D4").first().click({ timeout: 1500 }); } catch { } }
    await cmd2.waitForTimeout(200);
    dire(avant === (await txt(cmd2.locator(".panier"))), `toucher l'article en rupture n'ajoute rien au panier (${constats.rupture_dans_commande})`);
  }
  await allerA(aux, "Carte");
  dire(/rupture/.test(await txt(aux.locator("#app .card").filter({ has: aux.locator("b", { hasText: exact(NOM.D4) }) }))), `page carte : l'assiette de fromages marquée « rupture »`);
  await allerA(aux, "Stocks");
  egal((await lireStocks(aux))[ING.fromage], R.stocks.fromage_a_la_rupture, "stock de fromage à la rupture");
  dire(/sous le seuil/.test(await txt(aux.locator("#app .ligne-addition", { hasText: ING.fromage }))), `fromage signalé sous le seuil sur la page des stocks`);

  titre("Commande fournisseur proposée puis reçue");
  await toucher(aux.locator("#app .ligne-addition", { hasText: R.stocks.commande_proposee.fournisseur }).getByRole("button", { name: /Commander/ }), "commander chez Laiterie du Col");
  {
    const prop = await aux.evaluate(() => [...document.querySelectorAll("#modale .ligne-addition")].map((r) => [r.querySelector("span")?.firstChild?.textContent.trim(), r.querySelector("input")?.value]));
    const att = Object.entries(R.stocks.commande_proposee.lignes).map(([k, q]) => [ING[k], String(q)]);
    dire(JSON.stringify(prop) === JSON.stringify(att), `commande proposée : attendu ${JSON.stringify(att)}, lu ${JSON.stringify(prop)}`);
  }
  await mesurer("réception de la commande fournisseur", () => toucher(aux.locator("#modale").getByRole("button", { name: /Réceptionner/ }), "réceptionner"),
    [[cmd2, "commande n°2 (retour de l'article)", (nom) => { const b = [...document.querySelectorAll("button.article")].find((x) => x.querySelector(".nom")?.textContent.trim() === nom); return b && !b.classList.contains("rupture") && b.getAttribute("aria-disabled") !== "true"; }, NOM.D4]]);
  egal((await lireStocks(aux))[ING.fromage], 25, "stock de fromage après réception");

  titre("Changement de prix et de recette, puis commande");
  await allerA(aux, "Carte");
  await toucher(aux.locator("#app .card").filter({ has: aux.locator("b", { hasText: exact(NOM.B3) }) }).getByRole("button", { name: /Modifier/ }), "modifier le café");
  await toucher(aux.locator("#modale li", { hasText: ING.cafe }).getByRole("button"), "retirer le café en grains de la recette");
  {
    const sel = aux.locator("#modale").getByLabel(/Ajouter un ingrédient/);
    try { const opt = await sel.evaluate((s, n) => [...s.options].find((o) => o.textContent.startsWith(n))?.value, ING.cafe); await sel.selectOption(opt); } catch { introuvables.push("choix de l'ingrédient"); }
    await remplir(aux.locator("#modale").getByLabel(/Quantité/), 10, "quantité d'ingrédient");
    await toucher(aux.locator("#modale").getByRole("button", { name: exact("Ajouter") }), "ajouter l'ingrédient");
    await remplir(aux.locator("#modale").getByLabel(/Prix TTC/), "3.00", "prix TTC");
    await toucher(aux.locator("#modale").getByRole("button", { name: /Enregistrer/ }), "enregistrer l'article");
    await aux.keyboard.press("Escape");
    const c = await txt(aux.locator("#app .card").filter({ has: aux.locator("b", { hasText: exact(NOM.B3) }) }));
    dire(c.includes("3,00 €") && /Café en grains 10\s*g/.test(c), `carte : café à 3,00 € et recette 10 g (lu « ${c.slice(0, 90)} »)`);
  }
  await commander(cmd, "T9", R.commandes.T9.slice(2)); await envoyer(cmd, "T9");
  await allerA(aux, "Stocks");
  egal((await lireStocks(aux))[ING.cafe], R.stocks.cafe_apres_B3, "café en grains après 2 cafés à la nouvelle recette");

  titre("Additions");
  await allerA(aux, "Caisse");
  // TVA affichée pour chaque table avant règlement
  for (const t of ["T5", "T10", "T3", "T9"]) {
    await choisirTable(aux, t);
    const lu = await aux.evaluate(() => [...document.querySelectorAll("#app .tva-table tbody tr")].map((r) => r.innerText.replace(/[\s\u00a0\u202f]+/g, " ").trim()));
    const att = Object.entries(R.tickets[t].tva).filter(([, v]) => v.ttc > 0 || true).map(([taux, v]) => `${taux} % ${eur(v.ttc)} ${eur(v.tva)} ${eur(v.ht)}`);
    const manque = att.filter((a) => !lu.some((l) => l === a) && !(a.includes(" 0,00 € 0,00 € 0,00 €")));
    dire(manque.length === 0, `TVA par taux de ${t} : ${manque.length ? `absentes ${manque.join(" ; ")} (lu ${lu.join(" ; ")})` : att.filter((a) => !a.includes(" 0,00 € 0,00 € 0,00 €")).join(" ; ")}`);
    const tt = lireEur((await texte(aux)).match(/Total TTC [\d ,]+€/)?.[0]);
    egal(tt, R.tickets[t].total, `total TTC de l'addition ${t}`);
  }
  // T5 : en une fois, carte
  touches.n = 0;
  await mesurer("règlement de T5 en une fois, carte", async () => { await ouvrirReglement(aux, "T5"); await toucher(aux.locator("#modale").getByRole("button", { name: /^Encaisser/ }), "encaisser T5"); },
    [[tab, "tableau (chiffre)", (v) => [...document.querySelectorAll(".stat")].some((x) => x.textContent.replace(/[\s\u00a0\u202f]+/g, " ").includes(v)), `Chiffre d'affaires TTC${eur(R.tickets.T5.total)}`]]);
  constats.touches_encaisser_T5 = touches.n;
  // T10 : trois parts égales, carte puis espèces avec rendu
  await ouvrirReglement(aux, "T10");
  {
    const m = aux.locator("#modale");
    await toucher(m.getByRole("button", { name: exact("Parts égales") }), "onglet parts égales");
    await remplir(m.getByLabel(/Nombre de personnes/), 3, "nombre de personnes");
    await toucher(m.getByRole("button", { name: /Recalculer/ }), "recalculer les parts");
    const parts = await aux.evaluate(() => [...document.querySelectorAll("#modale li")].map((l) => l.innerText.replace(/[\s\u00a0\u202f]+/g, " ")));
    const lues = parts.map(lireEur);
    dire(JSON.stringify(lues) === JSON.stringify(R.tickets.T10.parts), `trois parts égales de ${eur(R.tickets.T10.total)} : attendu ${R.tickets.T10.parts.map(eur).join(" / ")}, lu ${lues.map((x) => x === null ? "?" : eur(x)).join(" / ")}`);
    const modeParts = await m.getByRole("button", { name: /Espèces/ }).count();
    dire(modeParts > 0, `l'onglet « parts égales » propose de payer une part en espèces avec rendu`);
    await toucher(m.locator("li").first().getByRole("button", { name: /Encaisser/ }), "encaisser la part 1 (carte)");
    // la saisie tient-elle ? (la modale se redessine)
    await toucher(m.getByRole("button", { name: exact("En une fois") }), "onglet en une fois");
    await toucher(m.getByRole("button", { name: /Espèces/ }), "mode espèces");
    await remplir(m.getByLabel(/Montant reçu/), "50", "montant reçu");
    await aux.waitForTimeout(1300);
    const tenu = await m.getByLabel(/Montant reçu/).inputValue().catch(() => "");
    dire(tenu === "50", `une somme tapée dans « Montant reçu » reste affichée après 1,3 s (lu « ${tenu} »)`);
    await encaisserUneFois(aux, "T10", R.tickets.T10.paiements[1].montant, "especes", 5000);
    await encaisserUneFois(aux, "T10", R.tickets.T10.paiements[2].montant, "especes", 4000);
    await aux.keyboard.press("Escape");
    const ps = await paiementsAffiches(aux);
    dire(ps.some((x) => x.includes(`rendu ${eur(1233)}`)) && ps.some((x) => x.includes(`rendu ${eur(234)}`)), `monnaie rendue affichée : ${eur(1233)} et ${eur(234)} (lu ${ps.join(" | ")})`);
    dire(ps.length === 3 && lireEur(ps[0]) === R.tickets.T10.parts[0], `trois paiements enregistrés pour T10`);
  }
  // T3 : par articles (E4 + P5 en carte), reste en espèces
  await ouvrirReglement(aux, "T3");
  {
    const m = aux.locator("#modale");
    await toucher(m.getByRole("button", { name: exact("Par articles") }), "onglet par articles");
    await toucher(m.getByRole("button", { name: /Carte/ }), "mode carte (par articles)");
    await toucher(m.locator("li", { hasText: NOM.E4 }).locator("input[type=checkbox]"), "cocher les salades de chèvre");
    await toucher(m.locator("li", { hasText: NOM.P5 }).locator("input[type=checkbox]"), "cocher les plats du jour");
    const selTxt = await txt(m.locator(".total-bar"));
    egal(lireEur(selTxt), R.tickets.T3.paiements[0].montant, "sélection par articles (E4 + P5)");
    await toucher(m.getByRole("button", { name: /Encaisser la sélection/ }), "encaisser la sélection");
    await encaisserUneFois(aux, "T3", R.tickets.T3.paiements[1].montant, "especes", 5000);
    await aux.keyboard.press("Escape");
    const ps = await paiementsAffiches(aux);
    dire(ps.length === 2 && lireEur(ps[0]) === 5200 && ps.some((x) => x.includes(`rendu ${eur(500)}`)), `T3 : ${eur(5200)} en carte puis ${eur(4500)} en espèces, rendu ${eur(500)} (lu ${ps.join(" | ")})`);
  }
  // T9 : carte 100 € + espèces 50 €
  await ouvrirReglement(aux, "T9");
  await encaisserUneFois(aux, "T9", 10000, "carte");
  await encaisserUneFois(aux, "T9", R.tickets.T9.paiements[1].montant, "especes", 5000);
  await aux.keyboard.press("Escape");
  {
    const ps = await paiementsAffiches(aux);
    dire(ps.length === 2 && ps.some((x) => x.includes(`rendu ${eur(400)}`)), `T9 : ${eur(10000)} carte + ${eur(4600)} espèces, rendu ${eur(400)} (lu ${ps.join(" | ")})`);
  }
  // ticket T10
  await choisirTable(aux, "T10");
  await toucher(aux.getByRole("button", { name: /Ticket/ }), "ticket de T10");
  {
    const tk = await txt(aux.locator("#modale"));
    dire(tk.includes(`TVA 10% ${eur(845)}`) && tk.includes(`TVA 20% ${eur(333)}`) && tk.includes(`TOTAL TTC ${eur(11300)}`), `ticket T10 : TVA 10 % ${eur(845)}, 20 % ${eur(333)}, total ${eur(11300)}`);
    dire((tk.match(/carte|espèces/gi) || []).length >= 3, `ticket T10 : les trois paiements y figurent`);
    dire(/Imprimer/.test(tk), `ticket prêt à imprimer (bouton Imprimer)`);
    await aux.keyboard.press("Escape");
  }
  await allerA(aux, "Salle");
  {
    const et = await aux.evaluate(() => [...document.querySelectorAll("button[aria-label^='Table ']")].map((b) => b.getAttribute("aria-label")));
    dire(["T5", "T10", "T3", "T9"].every((t) => et.includes(`Table ${t}, à débarrasser`)), `additions réglées : T5, T10, T3, T9 « à débarrasser »`);
  }
  await toucher(carteTable(aux, "T5"), "table T5");
  await toucher(aux.locator("#modale").getByRole("button", { name: /Débarrasser/ }), "débarrasser T5");
  await aux.keyboard.press("Escape");
  dire(await carteTable(aux, "T5").getAttribute("aria-label").then((a) => a === "Table T5, libre").catch(() => false), `T5 débarrassée → libre`);
  await installer(aux, "T11", 3);

  titre("Réservation non venue");
  await reglerHeure(aux, "13:05");
  await allerA(aux, "Réservations");
  for (const nom of R.reservations.non_venues_a_13h05) dire(/non venue/.test(await txt(carteResa(nom))), `à 13:05, ${nom} est « non venue »`);
  await allerA(aux, "Salle");
  dire(await carteTable(aux, R.reservations.juge_A.table).getAttribute("aria-label").then((a) => a.endsWith("libre")).catch(() => false), `${R.reservations.juge_A.table} redevient libre après la non-venue de Juge A`);

  titre("Tableau de bord (fenêtre téléphone), comparé à la référence");
  await tab.waitForTimeout(500);
  const S = await stats(tab);
  const T = R.tableau;
  egal(lireEur(stat(S, "Chiffre d'affaires TTC")), T.ca_ttc, "chiffre d'affaires TTC (centimes)");
  egal(lireEur(stat(S, "Chiffre d'affaires HT")), T.ca_ht, `chiffre d'affaires HT (TVA du jour calculée sur le total de chaque taux ; ${T.ca_ttc - T.tva_par_taux_somme_des_tickets["10"] - T.tva_par_taux_somme_des_tickets["20"]} si l'on somme les TVA des tickets)`);
  egal(parseInt(stat(S, "Couverts"), 10), T.couverts, "couverts");
  egal(lireEur(stat(S, "Ticket moyen")), T.ticket_moyen, "ticket moyen (centimes)");
  egal(parseInt(stat(S, "Attente moyenne"), 10), T.attente_moyenne, "attente moyenne (min)");
  egal(parseInt(stat(S, "Attente la plus longue"), 10), T.attente_max, "attente la plus longue (min)");
  egal(lireEur(stat(S, "Valeur du stock")), R.stocks.valeur_fin, "valeur du stock (centimes)");
  egal(parseInt(stat(S, "Tables occupées"), 10), T.tables_occupees.length, "tables occupées");
  {
    const rows = await tab.evaluate(() => [...document.querySelectorAll("#app .tva-table tbody tr")].map((r) => r.innerText.replace(/[\s\u00a0\u202f]+/g, " ").trim()));
    for (const [taux, v] of Object.entries(T.tva_par_taux)) {
      const r = rows.find((x) => x.startsWith(`${taux} %`)); const lu = r ? lireEur(r.split("€")[1] + "€") : null;
      dire(lu === v, `TVA ${taux} % du jour : attendu ${eur(v)} (arrondi sur le total du taux ; somme des tickets ${eur(T.tva_par_taux_somme_des_tickets[taux])}), lu ${lu === null ? "rien" : eur(lu)}`);
    }
    const top = await tab.evaluate(() => { const c = [...document.querySelectorAll("#app .card")].find((x) => /Top 5/.test(x.querySelector("h2")?.textContent || "")); return c ? [...c.querySelectorAll("li")].map((l) => l.innerText.replace(/\s+/g, " ").trim()) : []; });
    const att = T.top5.map((x) => `${x.nom} ${x.portions}`);
    const lus = top.map((l) => l.replace(/^\d+\s*/, "").replace(/ portion\(s\)$/, ""));
    dire(JSON.stringify(lus) === JSON.stringify(att), `top 5 : attendu ${att.join(" ; ")}, lu ${lus.join(" ; ")}`);
    const tt = await texte(tab);
    dire(/Table T11/.test(tt) && /Aucune rupture/.test(tt) && /Aucune alerte/.test(tt), `tableau : T11 occupée, aucune rupture, aucune alerte`);
    const avenir = ["Garnier", "Chevalier", "Morel", "Fontaine"].filter((n) => !tt.includes(n));
    dire(avenir.length === 0 && !/Juge A ·/.test(tt), `réservations à venir : Garnier, Chevalier, Morel, Fontaine (sans les non-venues)${avenir.length ? " ; absentes " + avenir.join(", ") : ""}`);
  }
  await allerA(aux, "Stocks");
  {
    const s = await lireStocks(aux);
    const f = Object.entries(R.stocks.fin).filter(([k, v]) => s[ING[k]] !== v);
    dire(f.length === 0, `les 27 stocks en fin de service${f.length ? " : " + f.map(([k, v]) => `${ING[k]} attendu ${v}, lu ${s[ING[k]]}`).join(" ; ") : ""}`);
    const v = lireEur((await texte(aux)).match(/Valeur du stock : [\d ,]+€/)?.[0]);
    egal(v, R.stocks.valeur_fin, "valeur du stock sur la page des stocks");
  }

  titre("Cohérence entre pages");
  {
    const s = await stats(tab);
    await allerA(aux, "Accueil");
    const hs = await aux.evaluate(() => Object.fromEntries([...document.querySelectorAll(".hs")].map((h) => [h.querySelector("span")?.textContent.trim(), h.querySelector("b")?.textContent.replace(/[\s\u00a0\u202f]+/g, " ").trim()])));
    dire(lireEur(hs["Chiffre d'affaires"]) === lireEur(stat(s, "Chiffre d'affaires TTC")), `chiffre d'affaires : accueil ${hs["Chiffre d'affaires"]}, tableau ${stat(s, "Chiffre d'affaires TTC")}`);
    dire(hs["Tables occupées"] === stat(s, "Tables occupées"), `tables occupées : accueil ${hs["Tables occupées"]}, tableau ${stat(s, "Tables occupées")}`);
    dire(hs["Couverts"] === stat(s, "Couverts"), `couverts : accueil ${hs["Couverts"]}, tableau ${stat(s, "Couverts")}`);
    await allerA(aux, "Salle");
    const occ = await aux.evaluate(() => [...document.querySelectorAll("button[aria-label$=', occupée']")].length);
    dire(String(occ) === stat(s, "Tables occupées"), `tables occupées : plan de salle ${occ}, tableau ${stat(s, "Tables occupées")}`);
    await allerA(aux, "Carte");
    const rc = await aux.evaluate(() => [...document.querySelectorAll("#app .badge")].filter((b) => b.textContent.trim() === "rupture").length);
    dire(String(rc) === hs["Ruptures"], `ruptures : carte ${rc}, accueil ${hs["Ruptures"]}`);
  }

  titre("Persistance : tout fermer, rouvrir");
  for (const p of ctx.pages()) await p.close();
  const re = await ouvrir("tableau", 1024, 768, "réouverture");
  {
    const s = await stats(re);
    egal(lireEur(stat(s, "Chiffre d'affaires TTC")), T.ca_ttc, "après réouverture, chiffre d'affaires TTC");
    egal(await txt(re.locator("#horloge-heure")), "13:05", "après réouverture, horloge réglée");
    await allerA(re, "Salle");
    const et = await re.evaluate(() => [...document.querySelectorAll("button[aria-label^='Table ']")].map((b) => b.getAttribute("aria-label")));
    dire(et.includes("Table T11, occupée") && et.includes("Table T10, à débarrasser"), `après réouverture, T11 occupée et T10 à débarrasser`);
  }

  titre("Captures et cinq tailles (sur l'état du service)");
  const mesTailles = {};
  for (const [w, h] of TAILLES) {
    await re.setViewportSize({ width: w, height: h });
    for (const x of ["accueil", ...PAGES]) {
      await re.goto(`${base}#${x}`); await re.waitForTimeout(250);
      const m = await re.evaluate(mesuresPage, w <= 1024);
      mesTailles[`${x} ${w}×${h}`] = m;
      if ((w === 1024 && h === 768) || w === 390) await re.screenshot({ path: join(sortie, `${x}-${w}x${h}.png`), fullPage: true });
    }
  }
  for (const x of ["accueil", ...PAGES]) {
    const k = TAILLES.map(([w, h]) => [`${w}×${h}`, mesTailles[`${x} ${w}×${h}`]]);
    const def = k.filter(([, m]) => m.defileCote || m.deborde.length);
    dire(def.length === 0, `${x} : rien ne déborde ni ne défile de côté aux cinq tailles${def.length ? " ; " + def.map(([t, m]) => `${t} ${m.defileCote ? "défile" : ""} ${m.deborde.slice(0, 3).join(", ")}`).join(" ; ") : ""}`);
    const cp = k.filter(([, m]) => m.coupes.length);
    dire(cp.length === 0, `${x} : aucun texte coupé${cp.length ? " ; " + cp.map(([t, m]) => `${t} ${m.coupes.length} (${m.coupes.slice(0, 2).join(", ")})`).join(" ; ") : ""}`);
    const pt = k.filter(([t, m]) => m.petites.length && parseInt(t, 10) <= 1024);
    dire(pt.length === 0, `${x} : toutes les cibles ≥ 44 px sur téléphone et tablette${pt.length ? " ; " + pt.map(([t, m]) => `${t} ${m.petites.length} (${m.petites.slice(0, 2).join(", ")})`).join(" ; ") : ""}`);
    const ct = mesTailles[`${x} 1024×768`].contrastes;
    dire(ct.length === 0, `${x} : contrastes texte/fond suffisants (WCAG AA)${ct.length ? ` ; ${ct.length} sous le seuil (${ct.slice(0, 3).join(", ")})` : ""}`);
    const sn = mesTailles[`${x} 1024×768`].sansNom;
    dire(sn.length === 0, `${x} : chaque bouton et lien a un nom lisible par un lecteur d'écran${sn.length ? ` ; ${sn.length} sans nom` : ""}`);
  }
  writeFileSync(join(sortie, "restaurant-tailles.json"), JSON.stringify(mesTailles, null, 1));

  titre("Clôture de la journée et archive");
  await re.setViewportSize({ width: 1024, height: 768 });
  await re.goto(`${base}#tableau`); await re.waitForTimeout(300);
  await toucher(re.getByRole("button", { name: /Clôturer la journée/ }), "clôturer la journée");
  await re.waitForTimeout(300);
  {
    const s = await stats(re);
    egal(lireEur(stat(s, "Chiffre d'affaires TTC")), 0, "après clôture, chiffre du jour remis à zéro");
    await allerA(re, "Salle");
    const et = await re.evaluate(() => [...document.querySelectorAll("button[aria-label^='Table ']")].map((b) => b.getAttribute("aria-label")));
    dire(!et.some((a) => /occupée|débarrasser/.test(a)), `après clôture, tables vidées`);
    await allerA(re, "Stocks");
    egal((await lireStocks(re))[ING.fromage], R.stocks.fin.fromage, "après clôture, stock de fromage gardé");
    await allerA(re, "Carte");
    dire((await txt(re.locator("#app .card").filter({ has: re.locator("b", { hasText: exact(NOM.B3) }) }))).includes("3,00 €"), `après clôture, la carte garde le café à 3,00 €`);
    await allerA(re, "Tableau");
    await toucher(re.getByRole("button", { name: /Archives/ }), "relire les archives");
    const ar = await txt(re.locator("#modale"));
    dire(ar.includes(eur(T.ca_ttc)) && ar.includes(`${T.couverts} couverts`), `archive relue : ${eur(T.ca_ttc)}, ${T.couverts} couverts (lu « ${ar.slice(0, 120)} »)`);
    await re.keyboard.press("Escape");
  }
  await ctx.close();

  // ---------------------------------------------------------------- 3. expérience, sur une journée neuve
  titre("Expérience : pages vides, touches, retour, annulation, erreur, sombre, clavier");
  {
    const c3 = await navigateur.newContext({ viewport: { width: 1024, height: 768 } });
    const p = await c3.newPage(); suivre(p, "expérience");
    await p.goto(`${base}#commande`); await p.waitForTimeout(300);
    const vide = await texte(p);
    dire(/Installez|installer/i.test(vide), `page de commande vide : dit quoi faire (« ${vide.match(/Aucune[^.]*\.?[^.]*/)?.[0]?.slice(0, 90) ?? ""} »)`);
    await p.goto(`${base}#caisse`); await p.waitForTimeout(200);
    dire(/Aucune addition|apparaîtront/i.test(await texte(p)), `caisse vide : dit ce qui apparaîtra`);
    await p.goto(`${base}#salle`); await p.waitForTimeout(200);
    await reglerHeure(p, "15:00");
    // parcours pressé : installer (couverts par défaut), commander deux articles, envoyer, encaisser
    touches.n = 0;
    await toucher(carteTable(p, "T8"), "table T8"); await toucher(p.locator("#modale").getByRole("button", { name: /Installer les clients/ }), "installer T8");
    constats.touches_installer_presse = touches.n;
    const retour = await txt(p.locator("#toasts"));
    dire(retour.length > 0, `retour visible après l'installation (« ${retour.slice(0, 60)} »)`);
    dire(/Annuler/.test(retour), `l'installation s'annule depuis la notification`);
    touches.n = 0;
    await toucher(carteTable(p, "T8"), "table T8 (commande)"); await toucher(p.locator("#modale").getByRole("button", { name: /Prendre la commande/ }), "prendre la commande de T8");
    await toucher(article(p, "B3"), "café"); await toucher(article(p, "D2"), "moelleux");
    await envoyer(p, "T8");
    constats.touches_commander_2_articles = touches.n;
    touches.n = 0;
    await allerA(p, "Salle");
    await toucher(carteTable(p, "T8"), "table T8 (addition)"); await toucher(p.locator("#modale").getByRole("button", { name: /Addition/ }), "addition de T8");
    await toucher(p.getByRole("button", { name: /Régler l.addition/ }), "régler T8"); await toucher(p.locator("#modale").getByRole("button", { name: /^Encaisser/ }), "encaisser T8");
    constats.touches_encaisser = touches.n - 0;
    dire(constats.touches_installer_presse <= 3, `installer une table : ${constats.touches_installer_presse} touches`);
    dire(constats.touches_commander_2_articles <= 6, `commander deux articles depuis le plan de salle : ${constats.touches_commander_2_articles} touches`);
    dire(constats.touches_encaisser <= 5, `encaisser en une fois depuis le plan de salle : ${constats.touches_encaisser} touches (plus le lien « Salle »)`);
    // annulation d'un geste
    await allerA(p, "Salle");
    await toucher(carteTable(p, "T12"), "table T12"); await toucher(p.locator("#modale").getByRole("button", { name: /Installer les clients/ }), "installer T12");
    const installee = await carteTable(p, "T12").getAttribute("aria-label").then((a) => a === "Table T12, occupée").catch(() => false);
    await toucher(p.locator("#toasts").getByRole("button", { name: /Annuler/ }).last(), "annuler l'installation depuis la notification");
    await p.waitForTimeout(200);
    dire(installee && await carteTable(p, "T12").getAttribute("aria-label").then((a) => a === "Table T12, libre").catch(() => false), `« Annuler » défait l'installation de T12${installee ? "" : " (T12 n'a pas pu être installée)"}`);
    // se tromper exprès
    await toucher(carteTable(p, "T1"), "table T1"); await remplir(p.locator("#modale").getByLabel(/Couverts/), 5, "couverts T1");
    await toucher(p.locator("#modale").getByRole("button", { name: /Installer les clients/ }), "installer 5 couverts à T1 (2 places)");
    const err = await txt(p.locator("#toasts .erreur"));
    dire(/2 places/.test(err), `erreur exprès (5 couverts à T1) : le message dit ce qui ne va pas (« ${err.slice(0, 80)} »)`);
    await p.keyboard.press("Escape");
    // réservation sans nom
    await allerA(p, "Réservations");
    await toucher(p.getByRole("button", { name: exact("Réserver") }), "réserver sans nom");
    dire(/nom est requis/i.test(await txt(p.locator("#toasts"))), `réservation sans nom : l'erreur dit quoi réparer`);
    // mode sombre
    await allerA(p, "Cuisine");
    const fondCui = await p.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const sombre = (c) => { const [r, g, b] = c.match(/\d+/g).map(Number); return 0.2126 * r + 0.7152 * g + 0.0722 * b < 60; };
    dire(sombre(fondCui), `cuisine en mode sombre par défaut (fond ${fondCui})`);
    await toucher(p.getByRole("button", { name: /Clair/ }), "passer la cuisine en clair"); await toucher(p.getByRole("button", { name: /Sombre/ }), "repasser en sombre");
    await allerA(p, "Salle");
    const fondSalle = await p.evaluate(() => getComputedStyle(document.body).backgroundColor);
    dire(sombre(fondSalle), `le mode sombre choisi vaut aussi pour le soir sur les autres pages (salle : ${fondSalle})`);
    // clavier
    await p.goto("about:blank"); await p.goto(`${base}#salle`); await p.waitForTimeout(200);
    const focus = [];
    for (let i = 0; i < 6; i++) {
      await p.keyboard.press("Tab");
      focus.push(await p.evaluate(() => { const e = document.activeElement; const s = getComputedStyle(e); return { el: e.tagName + " " + (e.innerText || "").trim().slice(0, 20), visible: (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== "none" }; }));
    }
    dire(focus.every((f) => f.visible) && focus.some((f) => f.el.startsWith("BUTTON") || f.el.startsWith("A")), `focus clavier visible sur les six premières tabulations (${focus.map((f) => `${f.el}${f.visible ? "" : " (invisible)"}`).join(", ")})`);
    await toucher(carteTable(p, "T2"), "table T2 (clavier)");
    await p.keyboard.press("Escape");
    dire(!(await p.locator("#voile.ouvert").count()), `Échap ferme la fenêtre de la table`);
    const focusDansModale = await (async () => { await toucher(carteTable(p, "T2"), "table T2 (clavier 2)"); const v = await p.evaluate(() => !!document.activeElement.closest("#modale")); await p.keyboard.press("Escape"); return v; })();
    dire(focusDansModale, `à l'ouverture d'une fenêtre, le focus clavier y entre`);
    // clic sur tout ce qui se clique
    titre("Clic sur tout ce qui se clique");
    // chaque sorte de cible (action + texte) est cliquée une fois ; dans une fenêtre ouverte, ses boutons aussi
    const avant = erreurs.length; let clics = 0; const sautes = [], vus = new Set();
    const SEL = "#app [data-act], #app a[href], #app button, header button, header a";
    const cle = (e) => (e.getAttribute("data-act") || e.getAttribute("href") || "") + "|" + (e.innerText || "").trim().replace(/\d+/g, "#").slice(0, 24);
    for (const x of ["accueil", ...PAGES]) {
      await p.goto(`${base}#${x}`); await p.waitForTimeout(200);
      const t0 = Date.now();
      const n = await p.locator(SEL).count();
      for (let i = 0; i < n && Date.now() - t0 < 25000; i++) {
        if (!p.url().endsWith(`#${x}`)) { await p.goto(`${base}#${x}`); await p.waitForTimeout(80); }
        const el = p.locator(SEL).nth(i);
        const quoi = await el.evaluate(cle).catch(() => null);
        if (quoi === null || vus.has(quoi)) continue;
        vus.add(quoi);
        if (/imprimer/i.test(quoi)) { sautes.push(quoi); continue; }
        try { await el.click({ timeout: 400 }); clics++; } catch { }
        await p.waitForTimeout(40);
        if (await p.locator("#voile.ouvert").count()) {
          const nm = await p.locator("#modale button, #modale input[type=checkbox]").count();
          for (let j = 0; j < Math.min(nm, 8); j++) {
            if (!(await p.locator("#voile.ouvert").count())) break;
            const b = p.locator("#modale button, #modale input[type=checkbox]").nth(j);
            const q = await b.evaluate(cle).catch(() => "");
            if (/imprimer/i.test(q) || vus.has("modale " + q)) continue;
            vus.add("modale " + q);
            try { await b.click({ timeout: 400 }); clics++; } catch { }
          }
          await p.keyboard.press("Escape");
        }
      }
    }
    dire(erreurs.length === avant, `${clics} clics sur les neuf pages et leurs fenêtres : aucune exception ni erreur${erreurs.length > avant ? " ; " + [...new Set(erreurs.slice(avant))].slice(0, 4).join(" | ") : ""}`);
    constats.clics_sautes = sautes;
    await c3.close();
  }
} finally {
  await navigateur.close();
}

// ---------------------------------------------------------------- 4. bun test, documents, architecture
titre("bun test dans le dossier partagé");
{
  const r = spawnSync("bun", ["test"], { cwd: partage, encoding: "utf8", timeout: 180000 });
  const out = (r.stdout || "") + (r.stderr || "");
  const pass = +(out.match(/(\d+) pass/)?.[1] ?? 0), fail = +(out.match(/(\d+) fail/)?.[1] ?? 0);
  constats.bun_test = { pass, fail, code: r.status };
  dire(r.status === 0 && fail === 0 && pass > 0, `bun test : ${pass} réussis, ${fail} échecs`);
}

titre("Documents");
{
  const base = join(partage, "..", "tableau.sqlite");
  const lignes = execFileSync("sqlite3", ["-readonly", "-separator", "\t", `file:${base}?mode=ro`, "select id, auteur from messages; "], { encoding: "utf8" }).trim().split("\n");
  const auteur = Object.fromEntries(lignes.map((l) => l.split("\t")).map(([i, a]) => [+i, a]));
  const agents = execFileSync("sqlite3", ["-readonly", `file:${base}?mode=ro`, "select nom from agents"], { encoding: "utf8" }).trim().split("\n");
  for (const doc of ["ARCHITECTURE.md", "DECISIONS.md", "MODE-D-EMPLOI.md"]) {
    const f = join(partage, doc);
    if (!dire(existsSync(f), `${doc} présent`)) continue;
    const t = readFileSync(f, "utf8");
    dire(t.length > 1500, `${doc} : ${t.length} caractères`);
    if (doc === "MODE-D-EMPLOI.md") {
      const pour = ["serveur", "cuisin", "patron"].filter((x) => new RegExp(x, "i").test(t));
      dire(pour.length === 3, `MODE-D-EMPLOI.md s'adresse au serveur, au cuisinier et au patron (${pour.join(", ")})`);
      continue;
    }
    // chaque « message N » est attribué au nom le plus proche qui le précède dans la même phrase
    const re = /messages?\s+(\d+(?:\s*(?:,|et)\s*\d+)*)/g; let m, fin = 0; const mauvais = [], sansNom = []; let n = 0;
    while ((m = re.exec(t))) {
      const debut = Math.max(fin, m.index - 220, t.lastIndexOf("\n-", m.index), t.lastIndexOf("\n\n", m.index));
      const fenetre = t.slice(debut, m.index + m[0].length + 30);
      const noms = agents.filter((a) => new RegExp(`\\b${a}\\b`).test(fenetre));
      for (const num of m[1].split(/\s*(?:,|et)\s*/).map(Number)) {
        n++;
        if (!auteur[num]) mauvais.push(`message ${num} inexistant`);
        else if (!noms.length) sansNom.push(num);
        else if (!noms.includes(auteur[num])) (m[1].match(/\d+/g).length > 1 ? sansNom.push(num) : mauvais.push(`message ${num} écrit par ${auteur[num]}, cité près de ${noms.join("/")}`));
      }
      fin = m.index + m[0].length;
    }
    dire(n > 0 && mauvais.length === 0, `${doc} : ${n} citations de messages, ${mauvais.length} fausses${mauvais.length ? " (" + mauvais.slice(0, 5).join(" ; ") + ")" : ""}${sansNom.length ? `, ${sansNom.length} sans auteur nommé à côté` : ""}`);
  }
}

titre("Architecture constatée");
{
  const fichiers = [];
  const parcourir = (d) => { for (const n of readdirSync(d)) { if (n === ".git" || n === "node_modules") continue; const f = join(d, n); if (statSync(f).isDirectory()) parcourir(f); else fichiers.push(relative(partage, f)); } };
  parcourir(partage);
  const code = fichiers.filter((f) => /\.(js|css|html|mjs|ts)$/.test(f));
  const html = readFileSync(join(partage, "index.html"), "utf8");
  const charges = [...html.matchAll(/<(?:script[^>]*\ssrc|link[^>]*\shref)="([^"]+)"/g)].map((x) => x[1]).filter((x) => !x.startsWith("data:"));
  const blocs = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((x) => x[1].trim());
  const style = (html.match(/<style>([\s\S]*?)<\/style>/) || [])[1]?.trim() ?? "";
  const identiques = code.filter((f) => { const c = readFileSync(join(partage, f), "utf8").trim(); return c.length > 200 && (blocs.includes(c) || c === style); });
  const tests = fichiers.filter((f) => f.startsWith("tests/"));
  const importesParTests = new Set(tests.flatMap((f) => [...readFileSync(join(partage, f), "utf8").matchAll(/(?:import|require)\s*\(?\s*["']\.\.\/([^"']+)["']/g)].map((x) => x[1])));
  const autresHtml = code.filter((f) => f.endsWith(".html") && f !== "index.html");
  const chargesAilleurs = new Set(autresHtml.flatMap((f) => [...readFileSync(join(partage, f), "utf8").matchAll(/(?:src|href)="([^"#][^"]*)"/g)].map((x) => x[1])));
  const lieAIndex = autresHtml.filter((f) => html.includes(f));
  const morts = code.filter((f) => f !== "index.html" && !tests.includes(f) && !charges.includes(f) && !identiques.includes(f) && !importesParTests.has(f));
  constats.architecture = { fichiers_code: code.length, charges_par_index: charges, blocs_inlines: blocs.length, sources_identiques_aux_blocs: identiques, importes_par_tests: [...importesParTests], autres_pages_html: autresHtml, reliees_depuis_index: lieAIndex, chargees_par_les_autres_pages: [...chargesAilleurs], code_mort: morts };
  console.log(JSON.stringify(constats.architecture, null, 1));
  dire(charges.length === 0 || charges.every((c) => existsSync(join(partage, c))), `index.html charge ${charges.length} fichier(s) externes, tous présents ; ${blocs.length} blocs de script et une feuille de style inlinés`);
  dire(morts.length === 0, `code mort : ${morts.length} fichier(s) jamais chargés par index.html ni par les tests (${morts.join(", ")})`);
}

// ---------------------------------------------------------------- bilan
const ok = controles.filter((c) => c.ok).length;
const ms = syncs.map((s) => s.ms).filter((x) => x !== null).sort((a, b) => a - b);
const bilan = { ok, total: controles.length, controles, introuvables, syncs, sync_ms: { min: ms[0], mediane: ms[Math.floor(ms.length / 2)], max: ms[ms.length - 1], jamais: syncs.filter((s) => s.ms === null).length }, erreurs: [...new Set(erreurs)], constats };
writeFileSync(join(sortie, "juge-restaurant.json"), JSON.stringify(bilan, null, 1));
console.log(`\n${ok}/${controles.length} contrôles réussis · synchro ${bilan.sync_ms.min}–${bilan.sync_ms.max} ms (médiane ${bilan.sync_ms.mediane}) · ${introuvables.length} gestes introuvables · ${bilan.erreurs.length} erreurs de page`);
console.log(`captures et détails : ${sortie}`);
