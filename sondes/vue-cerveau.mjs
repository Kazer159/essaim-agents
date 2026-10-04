#!/usr/bin/env node
// Sonde de la vue Cerveau : ouvre la vraie vue dans le vrai navigateur (le chrome-headless-shell du cache
// Playwright, comme `voir`), choisit un essaim terminé, clique l'onglet Cerveau, lance la lecture du run, et dit si
// le cerveau se dessine : erreurs de console, exceptions, taille du canvas, ligne de compteurs, bouton Jouer, temps
// qui avance. Une consigne écrite est un vœu ; ceci est le contrôle.
//   usage : node sondes/vue-cerveau.mjs [--url http://127.0.0.1:4700] [--run <id>] [--capture runs/.sonde-cerveau.png]
//   codes : 0 tout est bon · 1 un contrôle a échoué · 2 la vue ou le navigateur est absent
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { cheminNavigateur } from "../src/voir.ts";

const { values } = parseArgs({ options: { url: { type: "string", default: "http://127.0.0.1:4700" }, run: { type: "string" }, capture: { type: "string", default: "runs/.sonde-cerveau.png" } }, strict: true });
const lignes = [];
let echecs = 0;
const controle = (ok, texte) => { lignes.push(`${ok ? "ok    " : "ÉCHEC "} ${texte}`); if (!ok) echecs++; };
const panne = (texte) => { console.error(`sonde cerveau : 2 en panne · ${texte}`); process.exit(2); };

const executable = cheminNavigateur();
if (!executable) panne("navigateur absent : playwright-core attend chromium_headless_shell-<révision> dans ~/Library/Caches/ms-playwright (bun install)");
let runs;
try { runs = await (await fetch(values.url + "/api/runs")).json(); } catch (e) { panne(`la vue ne répond pas sur ${values.url} : ${e.message}`); }
const run = values.run ?? runs.find((r) => r.etat === "termine")?.id;
if (!run) panne("aucun essaim terminé à regarder");
if (!runs.some((r) => r.id === run)) panne(`le run ${run} n'est pas dans la liste de la vue`);

// La carte de l'essaim dans la liste de gauche porte sa date à l'heure de la machine, comme quandRun dans la vue.
const MOIS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
const m = run.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/);
const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : null;
const etiquette = d ? `${d.getDate()} ${MOIS[d.getMonth()]} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` : run;

const pw = await import("playwright-core");
const navigateur = await pw.chromium.launch({ executablePath: executable, headless: true, timeout: 15_000 });
const erreurs = [], exceptions = [];
try {
  const page = await navigateur.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("console", (c) => { if (c.type() === "error") erreurs.push(c.text()); });
  page.on("pageerror", (e) => exceptions.push(e.message));
  await page.goto(values.url, { waitUntil: "load", timeout: 15_000 });

  const carte = page.locator(".essaim-corps").filter({ hasText: etiquette }).first();
  await carte.waitFor({ timeout: 10_000 });
  await carte.click();
  await page.getByRole("button", { name: "Cerveau", exact: true }).click();

  // le canvas arrive après la route /cerveau et three.js depuis le CDN ; puis on laisse quelques images se dessiner
  const canvas = page.locator(".scene-cerveau canvas");
  const arrive = await canvas.waitFor({ timeout: 20_000 }).then(() => true).catch(() => false);
  controle(arrive, "le canvas du cerveau apparaît dans la scène");
  await page.waitForTimeout(3000);
  const taille = arrive ? await canvas.evaluate((c) => [c.clientWidth, c.clientHeight, c.width, c.height]) : [0, 0, 0, 0];
  controle(taille[0] > 0 && taille[1] > 0 && taille[2] > 0 && taille[3] > 0, `le canvas a une taille (${taille[0]} × ${taille[1]} px, ${taille[2]} × ${taille[3]} pixels dessinés)`);

  const hud = await page.locator(".hud-cerveau").innerText().catch(() => "");
  controle(/neurone/.test(hud) && /lien/.test(hud), `la ligne de compteurs est là : « ${hud.split("\n")[0]} »`);

  const jouer = page.getByRole("button", { name: "Jouer le run", exact: true });
  const bouton = await jouer.isVisible().catch(() => false);
  controle(bouton, "le bouton « Jouer le run » est visible");
  if (bouton) {
    const avant = await page.locator(".transport .temps").innerText();
    await jouer.click();
    await page.waitForTimeout(2000);
    const pendant = await page.locator(".transport .temps").innerText();
    const pause = await page.getByRole("button", { name: "Pause", exact: true }).isVisible().catch(() => false);
    controle(pause, "pendant la lecture, le bouton dit « Pause »");
    controle(pendant !== avant && /sur/.test(pendant), `le temps avance : « ${avant} » → « ${pendant} »`);
    const direct = await page.locator(".hud-cerveau .direct").innerText().catch(() => "");
    controle(direct.trim().length > 0, `le message en cours s'affiche : « ${direct.trim().slice(0, 80)} »`);
    await page.getByRole("button", { name: "Revenir à la fin", exact: true }).click();
    await page.waitForTimeout(500);
    const fin = await page.locator(".transport .temps").innerText();
    controle(/à la fin du run/.test(fin), `« Revenir à la fin » remet la scène figée : « ${fin} »`);
  }

  mkdirSync(dirname(values.capture), { recursive: true });
  await page.screenshot({ path: values.capture });
  lignes.push(`capture : ${values.capture}`);
} finally {
  await navigateur.close();
}
controle(erreurs.length === 0, `erreurs de console : ${erreurs.length}${erreurs.length ? " · " + erreurs.join(" · ") : ""}`);
controle(exceptions.length === 0, `exceptions : ${exceptions.length}${exceptions.length ? " · " + exceptions.join(" · ") : ""}`);
console.log(`sonde cerveau · ${values.url} · run ${run}\n${lignes.join("\n")}`);
process.exit(echecs ? 1 : 0);
