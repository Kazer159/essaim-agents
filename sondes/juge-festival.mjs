// juge-festival.mjs — le juge mécanique de la mission « festival ». Quatre étages :
//  1. le moteur (window.LUMEN) : 92 programmes (les 32 de base et 60 « et si » que la mission ne cite
//     pas), 60 instants de foule, les quatre pics — contre sondes/festival-questions.py ;
//  2. l'interface pilotée : jours, festivaliers, heures, envies, comme dans la foule ;
//  3. l'allure : 3 identités × 8 tailles d'écran, contrastes, cibles au pouce, mouvement réduit ;
//  4. DECISIONS.md recoupé avec le tableau de la salle : chaque « Nom (msg N) » doit exister, écrit par Nom.
// Lancé depuis le dépôt : `node sondes/juge-festival.mjs runs/<run> ` (questions.json dans <run>/juge).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const depot = resolve(dirname(new URL(import.meta.url).pathname), "..");
const require = createRequire(join(depot, "package.json"));
const { chromium } = require("playwright-core");
const browsers = JSON.parse(readFileSync(join(dirname(require.resolve("playwright-core/package.json")), "browsers.json"), "utf8"));
const revision = browsers.browsers.find((b) => b.name === "chromium-headless-shell").revision;
const executablePath = join(homedir(), "Library", "Caches", "ms-playwright", `chromium_headless_shell-${revision}`, "chrome-headless-shell-mac-arm64", "chrome-headless-shell");
if (!existsSync(executablePath)) { console.error(`navigateur absent : ${executablePath}`); process.exit(1); }

const run = resolve(process.argv[2]);
const partage = join(run, "partage"), captures = join(run, "juge");
const Q = JSON.parse(readFileSync(join(captures, "questions.json"), "utf8"));
const url = pathToFileURL(join(partage, "index.html")).href;
const res = { moteur: {}, interface: [], allure: {}, decisions: {}, exceptions: [] };
const dire = (ok, quoi) => { console.log(`${ok ? "ok" : "KO"}  ${quoi}`); return ok; };
const plat = (s) => (s ?? "").replace(/[\s  ]+/g, " ");
const sansAccent = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const TAILLES = [[360, 740], [390, 844], [844, 390], [768, 1024], [1024, 768], [1280, 800], [1920, 1080], [2560, 1440]];

const navigateur = await chromium.launch({ executablePath, headless: true });
try {
  const ctx = await navigateur.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => res.exceptions.push(e.message.split("\n")[0]));
  page.on("console", (m) => { if (m.type() === "error") res.exceptions.push(m.text().slice(0, 160)); });
  const t0 = Date.now();
  await page.goto(url);
  await page.waitForFunction(() => window.LUMEN && window.LUMEN.solveur && document.querySelector("#vue-maintenant")?.textContent.trim().length > 0);
  res.ouverture_ms = Date.now() - t0;

  // ---- 1. le moteur ----
  console.log("== moteur ==");
  const progs = await page.evaluate((qs) => qs.map((q) => {
    const d = performance.now();
    const o = { envies: q.envies };
    if (q.arrivee) o.arrivee = q.arrivee;
    if (q.limite) o.limite = q.limite;
    const p = window.LUMEN.solveur.meilleurProgramme(q.fid, q.jour, o);
    return { ms: performance.now() - d, points: p.points, concerts: p.concerts, marche: p.minutesMarche };
  }), Q.programmes);
  const fautes = [];
  let justes = 0;
  Q.programmes.forEach((q, i) => {
    const p = progs[i];
    const ok = p.points === q.points && p.marche === q.marche && JSON.stringify(p.concerts) === JSON.stringify(q.concerts);
    if (ok) justes++; else fautes.push({ q: `${q.fid} ${q.jour} ${q.arrivee ?? ""}→${q.limite ?? ""}`, attendu: `${q.points}pts ${q.marche}min ${q.concerts.join(",")}`, obtenu: `${p.points}pts ${p.marche}min ${p.concerts.join(",")}` });
  });
  const ms = progs.map((p) => p.ms).sort((a, b) => a - b);
  res.moteur.programmes = { justes, total: Q.programmes.length, base: progs.slice(0, 32).filter((p, i) => p.points === Q.programmes[i].points && JSON.stringify(p.concerts) === JSON.stringify(Q.programmes[i].concerts)).length, ms_max: ms.at(-1), fautes };
  dire(justes === Q.programmes.length, `programmes justes ${justes}/${Q.programmes.length} (dont ${res.moteur.programmes.base}/32 de base), pire ${ms.at(-1).toFixed(1)} ms`);
  fautes.slice(0, 6).forEach((f) => console.log("    ", JSON.stringify(f)));
  const foules = await page.evaluate((qs) => qs.map((q) => window.LUMEN.core.siteCrowd(q.jour, q.cle)), Q.foule);
  const fFaux = Q.foule.filter((q, i) => foules[i] !== q.site);
  res.moteur.foule = { justes: Q.foule.length - fFaux.length, total: Q.foule.length };
  dire(!fFaux.length, `foule du site juste à ${Q.foule.length - fFaux.length}/${Q.foule.length} instants`);
  const pics = await page.evaluate((js) => js.map((j) => { const p = window.LUMEN.core.peak(j); return [j, p.value, p.time]; }), Object.keys(Q.pics));
  const pFaux = pics.filter(([j, v, h]) => v !== Q.pics[j].valeur || h !== Q.pics[j].heure);
  res.moteur.pics = { justes: 4 - pFaux.length, fautes: pFaux };
  dire(!pFaux.length, `pics justes ${4 - pFaux.length}/4`);
  const base = await page.evaluate(() => ({ chev: window.LUMEN.core.overlaps().map((o) => o.a.id + "/" + o.b.id), alertes: window.LUMEN.core.alerts().length, apres: window.LUMEN.core.afterMidnight().length }));
  dire(base.chev.join() === "C082/C083" && base.alertes === 11 && base.apres === 16, `chevauchement ${base.chev.join()}, ${base.alertes} alertes, ${base.apres} après minuit`);
  res.moteur.base = base;

  // ---- 2. l'interface ----
  console.log("\n== interface ==");
  const point = (ok, quoi, detail = "") => { res.interface.push({ ok, quoi, detail }); dire(ok, quoi + (detail && !ok ? ` — ${detail}` : "")); };
  const jour = async (nom) => { await page.locator("#contexte button", { hasText: nom }).first().click(); await page.waitForTimeout(150); };
  const vue = async (v) => { await page.click(`[data-vue="${v}"]`); await page.waitForTimeout(150); };
  const fest = async (nom) => { await vue("festivalier"); await page.selectOption("#choix-fest", { label: nom }); await page.waitForTimeout(200); return plat(await page.textContent("#vue-festivalier")); };
  const heure = async (champ, h) => { await page.fill(champ, h); await page.dispatchEvent(champ, "change"); await page.waitForTimeout(200); return plat(await page.textContent("#vue-festivalier")); };
  await vue("programme"); await jour("jeudi");
  let txt = plat(await page.textContent("#vue-programme"));
  point(txt.indexOf("Argile Parade") > txt.indexOf("Fauve du Nord") && /02:30/.test(txt), "programme du jeudi : la nuit après minuit à sa place (Argile Parade, 02:30, après Fauve du Nord, 16:00)");
  await jour("samedi"); txt = plat(await page.textContent("#vue-programme"));
  point(/Silex Parade/.test(txt) && /Onde [ÉE]lectriques/.test(txt) && /chevauch/i.test(txt), "samedi : l'erreur du programme à la Serre est signalée");
  await jour("jeudi"); txt = await fest("Inès");
  point(/5 ?(points|pts)/.test(txt) && /22 ?min/.test(txt) && /Fauve Fant[ôo]mes/.test(txt), "Inès, jeudi : 5 points, 22 min, Fauve Fantômes à 00:30", txt.slice(0, 160));
  txt = await fest("Marc");
  point(/8 ?(points|pts)/.test(txt), "Marc, jeudi : 8 points");
  txt = await heure("#ed-depart", "03:00");
  point(/9 ?(points|pts)/.test(txt) && /Ivoire Atlas/.test(txt), "Marc peut rester jusqu'à 03:00 : 9 points avec Ivoire Atlas (C015)", txt.slice(0, 160));
  await page.click("#ed-reset"); await page.waitForTimeout(200);
  await jour("samedi"); txt = await fest("Sofia");
  point(/0 ?(point|pts)/.test(txt) || /aucun concert/i.test(txt), "Sofia, samedi : aucun concert possible, et la page dit pourquoi", txt.slice(0, 200));
  const opt = await page.$$eval("#ed-ajout option", (os) => os.find((o) => /Les Atlas|C079/.test(o.textContent + o.value))?.value);
  if (opt) { await page.selectOption("#ed-ajout", opt); await page.selectOption("#ed-ajout-prio", "3"); await page.click("#ed-ajouter"); await page.waitForTimeout(250); }
  txt = plat(await page.textContent("#vue-festivalier"));
  point(!!opt && /3 ?(points|pts)/.test(txt), "Sofia ajoute C079 en priorité 3 : son samedi vaut 3 points", txt.slice(0, 160));
  await page.click("#ed-reset"); await page.waitForTimeout(200);
  await page.reload(); await page.waitForTimeout(500);
  point(await page.evaluate(() => document.documentElement.getAttribute("data-festivalier")) === "F3", "après rechargement, le festivalier choisi est gardé");
  await page.fill("#recherche", "arg"); await page.waitForTimeout(250);
  point(/Argile/.test(plat(await page.textContent("#resultats"))), "trois lettres retrouvent un artiste (arg → Argile …)");
  await vue("regie"); await jour("vendredi");
  txt = plat(await page.textContent("#vue-regie"));
  point(/21:50/.test(txt) && /43 ?620/.test(txt), "régie, vendredi : le pic 43 620 à 21:50", txt.slice(0, 160));

  // bascule d'identité : temps et même information
  const noms = await page.$$eval("[data-identite-btn]", (bs) => bs.map((b) => b.getAttribute("data-identite-btn")));
  const temps = [];
  let memeInfo = true;
  const ref = plat(await page.textContent("#contenu"));
  for (const n of noms) {
    const d = await page.evaluate(async (n) => { const t = performance.now(); document.querySelector(`[data-identite-btn="${n}"]`).click(); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); return performance.now() - t; }, n);
    temps.push(d);
    if (plat(await page.textContent("#contenu")).replace(/\d{2}:\d{2}/g, "") !== ref.replace(/\d{2}:\d{2}/g, "")) memeInfo = false;
  }
  point(noms.length === 3 && Math.max(...temps) < 200, `trois identités (${noms.join(", ")}), bascule en ${Math.max(...temps).toFixed(0)} ms au pire`);
  point(memeInfo, "la même information après chaque bascule");

  // ---- 3. l'allure ----
  console.log("\n== allure : 3 identités × 8 tailles ==");
  const defauts = [];
  const contrastes = {};
  for (const [w, h] of TAILLES) {
    const p = await (await navigateur.newContext({ viewport: { width: w, height: h }, isMobile: w < 900, hasTouch: w < 900 })).newPage();
    p.on("pageerror", (e) => res.exceptions.push(`${w}: ${e.message.split("\n")[0]}`));
    await p.goto(url); await p.waitForTimeout(300);
    for (const n of noms) {
      await p.evaluate((n) => document.querySelector(`[data-identite-btn="${n}"]`).click(), n); await p.waitForTimeout(120);
      for (const v of ["maintenant", "programme", "festivalier", "regie"]) {
        await p.evaluate((v) => document.querySelector(`[data-vue="${v}"]`).click(), v); await p.waitForTimeout(150);
        const m = await p.evaluate(({ w, v }) => {
          const out = { deborde: document.documentElement.scrollWidth > w + 1 ? document.documentElement.scrollWidth : 0, coupes: [], petits: 0, cote: null };
          for (const e of document.querySelectorAll("body *")) {
            const r = e.getBoundingClientRect(); if (r.width <= 2 || r.height <= 2) continue; // un texte pour lecteur d'écran, masqué exprès
            const s = getComputedStyle(e);
            if (s.clip !== "auto" && s.position === "absolute") continue;
            if (e.children.length === 0 && e.textContent.trim() && /hidden|clip/.test(s.overflowX + s.overflow) && e.scrollWidth > e.clientWidth + 2 && s.textOverflow !== "ellipsis") out.coupes.push(e.textContent.trim().slice(0, 30));
            if (w < 480 && e.matches("button, a[href], select, input:not([type=hidden])") && (r.width < 44 || r.height < 44) && r.top < innerHeight * 3) out.petits++;
          }
          if (v === "regie" && w >= 1920) {
            const plan = [...document.querySelectorAll("#vue-regie svg")].find((s) => /plan/i.test(s.getAttribute("aria-label") || ""));
            const table = document.querySelector("#vue-regie table");
            out.cote = !!plan && !!table && plan.getBoundingClientRect().bottom <= innerHeight + 1 && table.getBoundingClientRect().top < innerHeight;
          }
          return out;
        }, { w, v });
        if (m.deborde) defauts.push(`${w}×${h} ${n} ${v} : la page défile de côté (${m.deborde}px)`);
        if (m.coupes.length) defauts.push(`${w}×${h} ${n} ${v} : ${m.coupes.length} textes coupés (${m.coupes.slice(0, 2).join(" | ")})`);
        if (m.petits) defauts.push(`${w}×${h} ${n} ${v} : ${m.petits} cibles de moins de 44 px`);
        if (m.cote === false) defauts.push(`${w}×${h} ${n} : le plan et la journée ne se voient pas ensemble`);
      }
      if (w === 1280) {
        await p.evaluate(() => document.querySelector(`[data-vue="festivalier"]`).click());
        contrastes[n] = await p.evaluate(() => {
          const lum = (c) => { const [r, g, b] = c.map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
          const rgb = (s) => (s.match(/[\d.]+/g) || []).map(Number);
          const fond = (e) => { for (let x = e; x; x = x.parentElement) { const s = getComputedStyle(x); if (s.backgroundImage !== "none") return null; const c = rgb(s.backgroundColor); if (c.length >= 3 && (c[3] ?? 1) > 0.9) return c; } return [255, 255, 255]; };
          let total = 0, faibles = 0, pire = 99, ex = "";
          for (const e of document.querySelectorAll("body *")) {
            if (![...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
            const r = e.getBoundingClientRect(); if (!r.width || r.bottom < 0 || r.top > innerHeight * 2) continue;
            const s = getComputedStyle(e); if (s.visibility === "hidden" || +s.opacity < 0.5) continue;
            const b = fond(e); if (!b) continue;
            const f = rgb(s.color); const [l1, l2] = [lum(f), lum(b)].sort((a, b) => b - a); const k = (l1 + 0.05) / (l2 + 0.05);
            const grand = parseFloat(s.fontSize) >= 24 || (parseFloat(s.fontSize) >= 18.66 && +s.fontWeight >= 700);
            total++; if (k < (grand ? 3 : 4.5)) { faibles++; if (k < pire) { pire = k; ex = e.textContent.trim().slice(0, 30); } }
          }
          return { total, faibles, pire: +pire.toFixed(2), ex };
        });
      }
    }
    await p.context().close();
  }
  res.allure.defauts = defauts;
  res.allure.contrastes = contrastes;
  dire(!defauts.length, `24 rendus × 4 vues : ${defauts.length} défauts`);
  defauts.slice(0, 12).forEach((d) => console.log("     ", d));
  for (const [n, c] of Object.entries(contrastes)) dire(c.faibles === 0, `contraste « ${n} » : ${c.total - c.faibles}/${c.total} textes au seuil${c.faibles ? `, pire ${c.pire} : « ${c.ex} »` : ""}`);

  const lent = await (await navigateur.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" })).newPage();
  await lent.goto(url); await lent.waitForTimeout(300);
  await lent.evaluate(() => document.querySelector(`[data-vue="regie"]`).click());
  const avant = await lent.evaluate(() => document.documentElement.getAttribute("data-heure"));
  await lent.waitForTimeout(1500);
  const mouvement = await lent.evaluate(() => ({ heure: document.documentElement.getAttribute("data-heure"), anim: document.getAnimations().filter((a) => a.playState === "running" && a.effect?.getTiming().iterations === Infinity).length }));
  res.allure.mouvementReduit = mouvement;
  dire(mouvement.heure === avant && mouvement.anim === 0, `mouvement réduit : rien ne bouge seul (${mouvement.anim} animation sans fin)`);
  await lent.context().close();

  // ---- 4. DECISIONS.md contre le tableau ----
  console.log("\n== DECISIONS.md ==");
  const dec = readFileSync(join(partage, "DECISIONS.md"), "utf8");
  const db = new DatabaseSync(join(run, "tableau.sqlite"), { readOnly: true });
  const auteur = (id) => db.prepare("SELECT auteur FROM messages WHERE id = ?").get(id)?.auteur;
  const citations = [...dec.matchAll(/([A-ZÉÈ][a-zéèêëïîôç]+)\s*\((?:msg|message)s?\s*(\d+)\)/g)].map((m) => ({ nom: m[1], id: +m[2] }));
  const agents = new Set(db.prepare("SELECT nom FROM agents").all().map((a) => sansAccent(a.nom)));
  const nominatives = citations.filter((c) => agents.has(sansAccent(c.nom)));
  const fausses = nominatives.filter((c) => sansAccent(auteur(c.id) ?? "") !== sansAccent(c.nom));
  const decisions = (dec.match(/^## \d+\./gm) || []).length;
  const bloc = dec.split(/^## Changements dus à une question/m)[1]?.split(/^## /m)[0] ?? "";
  const changements = (bloc.match(/^(\d+\.|###|- \*\*)/gm) || []).length;
  res.decisions = { decisions, changements, citations: nominatives.length, fausses: fausses.slice(0, 10), nbFausses: fausses.length };
  dire(decisions >= 8, `${decisions} décisions numérotées (au moins 8)`);
  dire(changements >= 5, `${changements} changements dus à une question (au moins 5)`);
  dire(nominatives.length > 0 && fausses.length === 0, `citations « Nom (msg N) » : ${nominatives.length - fausses.length}/${nominatives.length} retrouvées sous ce nom dans le fil`);
  fausses.slice(0, 6).forEach((f) => console.log("     ", `${f.nom} (msg ${f.id}) → écrit par ${auteur(f.id) ?? "personne"}`));

  const ok = res.interface.filter((p) => p.ok).length;
  res.resume = { programmes: `${justes}/${Q.programmes.length}`, foule: `${res.moteur.foule.justes}/60`, pics: `${res.moteur.pics.justes}/4`, interface: `${ok}/${res.interface.length}`, rendus_defauts: defauts.length, contrastes: Object.fromEntries(Object.entries(contrastes).map(([n, c]) => [n, `${c.total - c.faibles}/${c.total}`])), decisions: `${decisions} décisions, ${changements} changements, ${nominatives.length - fausses.length}/${nominatives.length} citations`, exceptions: res.exceptions.length, ouverture_ms: res.ouverture_ms };
  console.log("\n", JSON.stringify(res.resume));
  writeFileSync(join(captures, "juge-festival.json"), JSON.stringify(res, null, 1));
} finally {
  await navigateur.close();
}
