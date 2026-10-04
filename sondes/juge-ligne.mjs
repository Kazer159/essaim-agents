// juge-ligne.mjs — le juge de la mission « ligne » (missions/ligne.md). Les réponses sont calculées par
// sondes/ligne-references.py sur missions/entrees/ligne.
// L'accès à la page passe par `window.Valbrune` :
//   lecture.bilan()          → Valbrune.app.resultat.bilans (voyageurs_montes, ardoise_vp, quai_fin…)
//   simuler(changement)      → Valbrune.regul.chargerEtat(état du poste) puis Valbrune.app.calculer(), état remis ensuite
//   lecture.etatMinute(t)    → Valbrune.app.trainsVisibles(t) (ce que la 3D dessine)
//   lecture.ficheTrain(id)   → Valbrune.ui.ouvrirTrain(n, date), texte lu dans #vb-vue-fiche ; retard au terminus lu sur
//                              la dernière étape du trajet (arrReel − arrTheo), aucun si le trajet est limité ou supprimé
//   onglets Bilan/Ligne/Poste → onglets [data-onglet=bilan|graphique|reglages] ; graphique = canvas/svg de #vb-vue-graphique
//   « Réglages d'origine »   → bouton « Tout réinitialiser » [data-action=tout], sa confirmation acceptée ; comparé à
//                              l'année de la page à l'ouverture (juste ou non : l'exactitude la juge) ; masque → #ui.vb-cache
//   horloge.ui.goto          → ▶/⏸ (#vb-lecture) si le temps court, champ date #vb-date-input puis curseur #vb-curseur
//   cams                     → Vue libre = repère [data-cam=vallee] ; Suivre un train = « Suivre ce train » de la fiche
//                              d'un train en route ; Cabine, Quai, Survol = [data-cam-mode=…]
//   DECISIONS.md             → renvois entre crochets « [66] », « [16, 24, 42] » ; nom lu seulement s'il précède un
//                              renvoi unique (« Xavier s'y est opposé … [66] » n'est pas lu, « d'Antoine [596] » l'est)
// Lancé depuis le dépôt : `node sondes/juge-ligne.mjs <run>`.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

const run = resolve(process.argv[2]);
const partage = join(run, "partage"), sortie = join(run, "juge");
mkdirSync(sortie, { recursive: true });
const fichierRef = join(sortie, "references.json");
if (!existsSync(fichierRef)) execFileSync("python3", ["sondes/ligne-references.py", fichierRef], { cwd: depot, stdio: "ignore" });
const R = JSON.parse(readFileSync(fichierRef, "utf8"));
const url = pathToFileURL(join(partage, "index.html")).href;
const res = { exactitude: {}, gestes: [], visuel: {}, tests: {}, decisions: {}, depot: {}, exceptions: [] };
const dire = (ok, quoi) => { console.log(`${ok ? "ok" : "KO"}  ${quoi}`); return ok; };
const geste = (ok, quoi, detail = "") => { res.gestes.push({ ok, quoi, detail }); dire(ok, quoi + (detail && !ok ? ` — ${detail}` : "")); };
const plat = (s) => (s ?? "").replace(/[\s  ]+/g, " ").trim();
const minute = (iso, hm) => Math.round((Date.parse(iso) - Date.parse("2027-01-01")) / 86_400_000) * 1440 + Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3));
// le bilan de la page, dans les noms de la référence
const versRef = (b) => ({ circulations: b.circulations, arrivees: b.arrivees, supprimes: b.supprimees, limites: b.limitees,
  ponctualite_pct: b.ponctualite ?? b.ponctualite_dixieme / 10, retard_max_min: b.retard_max, montes: b.voyageurs_montes,
  renonces: b.voyageurs_renonces, tonnes: b.ardoise_vp, stock_max: b.quai_max, stock_fin: b.quai_fin });
const ecarts = (lu, att) => Object.keys(lu).filter((k) => lu[k] !== att[k]).map((k) => `${k} ${lu[k]}≠${att[k]}`);
// un changement de la référence, dans la forme que la page attend
// (l'état du poste, src/regulation.js : ajouts, retraits, fermetures { canton, du, au, debut, fin } ; les réglages non
// cités restent à leur valeur d'origine)
const versPage = (ch) => ({ reglages: ch.reglages ?? {}, ajouts: ch.ajouts ?? [], retraits: (ch.retraits ?? []).map(String),
  fermetures: (ch.fermetures ?? []).map((f) => ({ canton: f.lieu, du: f.du, au: f.au, debut: f.debut, fin: f.fin })) });

const navigateur = await chromium.launch({ executablePath, headless: true, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
try {
  const ctx = await navigateur.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => res.exceptions.push(e.message.split("\n")[0].slice(0, 160)));
  page.on("console", (m) => { if (m.type() === "error") res.exceptions.push(m.text().slice(0, 160)); });
  // « Tout réinitialiser » demande confirmation (window.confirm) : on répond oui, comme le régulateur
  page.on("dialog", (d) => d.accept());
  // la page garde son contexte audio pour elle : on note chaque AudioContext créé pour en lire l'état
  await ctx.addInitScript(() => {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    window.__contextesAudio = [];
    const Espion = class extends AC { constructor(...a) { super(...a); window.__contextesAudio.push(this); } };
    window.AudioContext = Espion; window.webkitAudioContext = Espion;
  });
  const renonces = () => page.evaluate(() => window.Valbrune.app.resultat.bilans.voyageurs_renonces);
  const t0 = Date.now();
  await page.goto(url);
  await page.waitForFunction(() => window.Valbrune?.app?.resultat?.bilans);
  res.ouverture_ms = Date.now() - t0;
  dire(res.ouverture_ms < 3000, `ouverture en ${res.ouverture_ms} ms`);
  await page.waitForTimeout(2500);
  const bandeau = plat(await page.innerText("body")).slice(0, 400);
  dire(/01\/01\/2027|1 janvier/i.test(bandeau) && /06:00/.test(bandeau), "la page s'ouvre le 1er janvier 2027 à 6 h 00");
  await page.screenshot({ path: join(sortie, "01-ouverture.png") });
  const sonOuverture = await page.evaluate(() => { const a = window.__contextesAudio ?? []; return a.length ? a.map((c) => c.state).join(",") : "absent"; });

  // ---- 1. l'exactitude ----
  console.log("\n== exactitude ==");
  const bilan = versRef(await page.evaluate(() => window.Valbrune.app.resultat.bilans));
  const e0 = ecarts(bilan, R.variantes.defaut.bilan);
  res.exactitude.defaut = e0;
  dire(!e0.length, `bilan par défaut : ${e0.length ? e0.join(", ") : "les onze chiffres justes"}`);
  res.exactitude.variantes = {};
  for (const [nom, v] of Object.entries(R.variantes)) {
    if (nom === "defaut") continue;
    const r = await page.evaluate((ch) => {
      const V = window.Valbrune, avant = V.regul.etat();
      V.regul.chargerEtat({ ...avant, reglages: { ...avant.reglages, ...ch.reglages }, ajouts: ch.ajouts, retraits: ch.retraits, fermetures: ch.fermetures });
      const d = performance.now(); V.app.calculer(); const ms = performance.now() - d;
      const b = { ...V.app.resultat.bilans };
      V.regul.chargerEtat(avant); V.app.calculer();
      return { ms, b };
    }, versPage(v.changement));
    const e = ecarts(versRef(r.b), v.bilan);
    res.exactitude.variantes[nom] = { ms: Math.round(r.ms), fautes: e };
    dire(!e.length && r.ms < 1000, `${nom} : ${e.length ? e.slice(0, 4).join(", ") : "juste"} (${Math.round(r.ms)} ms)`);
  }
  let pFaux = 0, pTot = 0;
  for (const [inst, attendus] of Object.entries(R.positions)) {
    const [iso, hm] = inst.split(" ");
    const lus = await page.evaluate((t) => window.Valbrune.app.trainsVisibles(t).map((x) => [String(x.trajet.numero), x.ligne, x.pk_m]), minute(iso, hm));
    const cle = (l) => l.map((x) => x.join(":")).sort().join(" ");
    pTot++;
    if (cle(lus) !== cle(attendus)) { pFaux++; console.log(`     ${inst} : lu ${cle(lus)} · attendu ${cle(attendus)}`); }
  }
  res.exactitude.positions = { justes: pTot - pFaux, total: pTot };
  dire(!pFaux, `positions des trains justes à ${pTot - pFaux}/${pTot} instants`);
  res.exactitude.fiches = {};
  for (const [cle, att] of Object.entries(R.fiches)) {
    const [num, iso] = cle.split(" ");
    // la fiche que la page ouvre pour ce train ; le retard lu est celui de la derni\u00e8re ligne (le terminus)
    const f = await page.evaluate(([n, d]) => {
      const V = window.Valbrune, c = V.app.resultat.trajets.find((x) => String(x.numero) === n && x.dateStr === d);
      if (!c) return null;
      V.ui.ouvrirTrain(n, d);
      const m = document.querySelector("#vb-vue-fiche");
      const texte = m ? (m.innerText || m.textContent) : "";
      V.ui.onglet("poste");
      const g = /limit|suppr/.test(c.statut ?? "") ? null : c.etapes?.at(-1);
      return { texte, arrets: [{ arrivee: g?.arrReel ?? null, retard: g && g.arrReel != null && g.arrTheo != null ? g.arrReel - g.arrTheo : null }] };
    }, [num, iso]);
    const texte = JSON.stringify(f?.texte ?? "");
    const sans = (x) => x.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    const dernier = f?.arrets?.at(-1);
    const lu = dernier?.arrivee != null ? dernier.retard : null;
    // le 203 du 3 février : la mission annonçait 60 min par erreur (chiffre d'avant la neige de 6 h et 14 h) ; 62 suit
    // les règles, 60 suit le texte de la mission : les deux sont acceptés
    const accepte = cle === "203 2027-02-03" ? [60, 62] : [att.retard_terminus];
    const retardOk = att.retard_terminus === null ? lu === null && /limit/i.test(texte) : accepte.includes(lu);
    const causesOk = att.causes.every((c) => sans(texte).includes(sans(c)));
    res.exactitude.fiches[cle] = { lu, retardOk, causesOk };
    dire(!!f && retardOk && causesOk, `fiche ${cle} : ${att.etat}${att.retard_terminus !== null ? `, ${att.retard_terminus} min au terminus (lu ${lu})` : ""}${att.causes.length ? `, attentes ${att.causes.join(", ")}` : ""}`);
  }

  // ---- 2. les gestes ----
  console.log("\n== gestes ==");
  await page.click('#vb-onglets [data-onglet="bilan"]');
  await page.waitForTimeout(500);
  const txtBilan = plat(await page.innerText("body"));
  geste(/8\s?326/.test(txtBilan) && /48[,.]6/.test(txtBilan), "l'onglet Bilan affiche 8 326 circulations et 48,6 %");
  await page.screenshot({ path: join(sortie, "02-bilan.png") });
  await page.click('#vb-onglets [data-onglet="graphique"]');
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(sortie, "03-ligne-graphique.png") });
  geste(await page.evaluate(() => !!document.querySelector("#vb-vue-graphique canvas, #vb-vue-graphique svg")), "l'onglet Ligne montre un graphique de circulation");
  await page.click('#vb-onglets [data-onglet="reglages"]');
  await page.waitForTimeout(400);
  // un curseur du poste : patience des voyageurs à 120
  const d0 = Date.now(), renoncesOrigine = await renonces();
  const bouge = await page.evaluate(() => {
    const r = [...document.querySelectorAll("input[type=range]")].find((i) => /patience/i.test(i.closest("div,label,section")?.textContent ?? ""));
    if (!r) return false;
    r.value = "120"; r.dispatchEvent(new Event("input", { bubbles: true })); r.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  });
  await page.waitForFunction((r0) => window.Valbrune.app.resultat.bilans.voyageurs_renonces !== r0, renoncesOrigine, { timeout: 5000 }).catch(() => {});
  const apres = await renonces();
  geste(bouge && apres === 89247, `le curseur « patience » à 120 min recalcule l'année : ${apres} renonces (attendu 89 247)`, `${Date.now() - d0} ms`);
  await page.screenshot({ path: join(sortie, "04-poste-apres-curseur.png") });
  await page.evaluate(() => document.querySelector('#ui [data-action="tout"]')?.click());
  await page.waitForTimeout(2500);
  // l'année par défaut de la page (juste ou non : l'exactitude la juge plus haut), et la référence à côté
  const remis = await renonces();
  geste(remis === renoncesOrigine, "« Réglages d'origine » remet l'année par défaut", `${remis} renonces, ${renoncesOrigine} à l'ouverture, 269 430 attendus`);
  if (remis === renoncesOrigine && remis !== 269430) console.log(`     (année d'origine de la page : ${remis} renonces, la référence en attend 269 430)`);

  // H cache toute l'interface
  await page.mouse.click(800, 450);
  await page.keyboard.press("h"); await page.waitForTimeout(500);
  // l'interface disparaît à l'œil (la capture le montre) ; on compte aussi les panneaux qui restent sous le pointeur
  const masque = await page.evaluate(() => !!document.querySelector("#ui.vb-cache"));
  const sousPointeur = await page.evaluate(() => [[720, 20], [150, 450], [1330, 300], [700, 820]].filter(([x, y]) => document.elementFromPoint(x, y)?.tagName !== "CANVAS").length);
  res.masque = { masque, sousPointeur };
  const visibles = masque ? 0 : 4;
  await page.screenshot({ path: join(sortie, "05-interface-cachee.png") });
  geste(visibles === 0, `la touche H cache toute l'interface${sousPointeur ? ` (mais ${sousPointeur} panneaux invisibles restent sous le pointeur)` : ""}`);
  await page.keyboard.press("h"); await page.waitForTimeout(400);

  // son : muet avant le geste, un contexte audio après
  geste(sonOuverture !== "running", "aucun son avant le premier geste", sonOuverture);

  // ---- 3. le visuel : quatre moments, cinq caméras ----
  console.log("\n== visuel ==");
  // la barre du haut : ⏸ si le temps court, puis la date dans le champ « Aller à une date », puis l'heure au curseur
  // « Minute du jour »
  const aller = async (iso, hm) => {
    await page.evaluate(([d, h]) => {
      if (window.Valbrune.app.vitesse) document.querySelector("#vb-lecture").click();
      const champ = document.querySelector("#vb-date-input");
      champ.value = d; champ.dispatchEvent(new Event("change", { bubbles: true }));
      const cur = document.querySelector("#vb-curseur");
      cur.value = String(Number(h.slice(0, 2)) * 60 + Number(h.slice(3))); cur.dispatchEvent(new Event("input", { bubbles: true }));
    }, [iso, hm]);
    await page.waitForTimeout(2500);
  };
  for (const [nom, iso, hm] of [["hiver-neige-matin", "2027-02-15", "08:30"], ["ete-midi", "2027-06-21", "12:00"], ["fete-soir", "2027-02-20", "19:00"], ["avalanche", "2027-01-14", "10:00"]]) {
    await aller(iso, hm);
    await page.screenshot({ path: join(sortie, `06-moment-${nom}.png`) });
    await page.keyboard.press("h"); await page.waitForTimeout(400);
    await page.screenshot({ path: join(sortie, `06-moment-${nom}-3d-seule.png`) });
    await page.keyboard.press("h"); await page.waitForTimeout(300);
  }
  await aller("2027-06-21", "10:30");
  for (const cam of ["Vue libre", "Suivre un train", "Cabine", "Quai", "Survol"]) {
    if (cam === "Vue libre") await page.click('#ui button[data-cam="vallee"]').catch(() => {});
    else if (cam === "Suivre un train") {
      // la fiche d'un train en route à cette minute, puis son bouton « Suivre ce train »
      await page.evaluate(() => { const V = window.Valbrune, x = V.app.trainsVisibles(V.app.minute)[0]; if (x) V.ui.ouvrirTrain(String(x.trajet.numero), x.trajet.dateStr); });
      await page.click("#vb-vue-fiche [data-suivre]").catch(() => {});
      await page.evaluate(() => window.Valbrune.ui.onglet("poste"));
    } else await page.click(`#ui button[data-cam-mode="${cam.toLowerCase()}"]`).catch(() => {});
    await page.waitForTimeout(2500);
    await page.keyboard.press("h"); await page.waitForTimeout(300);
    await page.screenshot({ path: join(sortie, `07-camera-${cam.replace(/ /g, "-").toLowerCase()}.png`) });
    await page.keyboard.press("h"); await page.waitForTimeout(300);
  }
  const ips = await page.evaluate(() => new Promise((r) => { let n = 0; const t = performance.now(); const f = () => { n++; performance.now() - t < 3000 ? requestAnimationFrame(f) : r(n / 3); }; requestAnimationFrame(f); }));
  res.visuel.ips = Math.round(ips);
  dire(ips >= 30, `3D : ${Math.round(ips)} images par seconde`);
  res.visuel.tailles = [];
  for (const [w, h] of [[1280, 720], [1366, 768], [1440, 900], [1920, 1080], [2560, 1440]]) {
    await page.setViewportSize({ width: w, height: h }); await page.waitForTimeout(800);
    const m = await page.evaluate(() => {
      const c = document.querySelector("canvas"); const r = c?.getBoundingClientRect();
      return { deborde: document.documentElement.scrollWidth > innerWidth + 1, plein: !!r && r.width >= innerWidth - 2 && r.height >= innerHeight - 2 };
    });
    res.visuel.tailles.push({ taille: `${w}x${h}`, ...m });
    await page.screenshot({ path: join(sortie, `08-taille-${w}x${h}.png`) });
    dire(!m.deborde && m.plein, `${w}×${h} : ${m.deborde ? "défile de côté" : "rien ne défile"}, 3D ${m.plein ? "sur toute la fenêtre" : "pas sur toute la fenêtre"}`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  // persistance
  await aller("2027-03-12", "11:00");
  await page.waitForTimeout(1500);
  await page.reload(); await page.waitForTimeout(3500);
  const garde = await page.evaluate(() => window.Valbrune.app.minute);
  geste(garde === minute("2027-03-12", "11:00"), "fermer et rouvrir retrouve la date et l'heure", String(garde));
} finally { await navigateur.close(); }

// ---- 4. bun test, DECISIONS, AMELIORATIONS, dépôt ----
console.log("\n== dossier ==");
const bt = spawnSync("bun", ["test"], { cwd: partage, encoding: "utf8", timeout: 300_000 });
const bilanTests = (bt.stdout + bt.stderr).match(/(\d+) pass[\s\S]*?(\d+) fail/);
res.tests = { pass: Number(bilanTests?.[1]), fail: Number(bilanTests?.[2]) };
dire(res.tests.fail === 0, `bun test : ${res.tests.pass} verts, ${res.tests.fail} rouges`);
const db = new DatabaseSync(join(run, "tableau.sqlite"), { readOnly: true });
const dec = readFileSync(join(partage, "DECISIONS.md"), "utf8");
// « Proposition d'Antoine [1] », « [3, 37] », « [382, 388, 411 ; alertes #26 et #31] » : les nombres nus entre crochets
// sont des messages (« #26 », « ticket #6 », « preuves/24.json », un commit n'en sont pas) ; le nom collé devant un
// renvoi unique est son auteur annoncé
const agents = new Set(db.prepare("SELECT DISTINCT auteur FROM messages").all().map((m) => m.auteur));
const renvois = [...dec.matchAll(/(?:\b(?:d'|d’)?([A-ZÉ][a-zé]+)\s+)?\[([^\]]+)\]/g)].flatMap((m) => {
  const ids = m[2].split(/[,;]/).map((x) => x.trim()).filter((x) => /^\d+$/.test(x)).map(Number);
  const nom = ids.length === 1 && agents.has(m[1]) ? m[1] : undefined;
  return ids.map((id) => (nom ? { id, nom } : { id }));
});
const faux = renvois.filter((r) => { const m = db.prepare("SELECT auteur FROM messages WHERE id = ?").get(r.id); return !m || (r.nom && m.auteur !== r.nom); });
res.decisions = { renvois: renvois.length, faux: faux.map((r) => `msg ${r.id}${r.nom ? ", " + r.nom : ""}`) };
dire(renvois.length >= 10 && faux.length <= Math.ceil(renvois.length / 50), `DECISIONS.md : ${renvois.length} renvois au tableau, ${faux.length} faux${faux.length ? " : " + res.decisions.faux.slice(0, 5).join(" ; ") : ""}`);
const ame = readFileSync(join(partage, "AMELIORATIONS.md"), "utf8");
const images = [...new Set([...ame.matchAll(/([\w./-]+\.png)/g)].map((m) => m[1]))];
const presentes = images.filter((i) => existsSync(join(partage, i)) || existsSync(join(partage, i.replace(/^\.?\//, ""))));
res.ameliorations = { images: images.length, presentes: presentes.length };
dire(images.length >= 4 && presentes.length === images.length, `AMELIORATIONS.md : ${presentes.length}/${images.length} images citées présentes`);
const essais = db.prepare("SELECT nom, auteur, adopte_le FROM essais").all();
const adoptes = essais.filter((e) => e.adopte_le).length;
const branches = execFileSync("git", ["-C", partage, "branch", "--list", "essai/*"], { encoding: "utf8" }).split("\n").filter(Boolean).length;
res.depot = { essais: essais.length, adoptes, abandonnes: essais.length - adoptes, branches, commits: Number(execFileSync("git", ["-C", partage, "rev-list", "--all", "--count"], { encoding: "utf8" }).trim()) };
dire(adoptes >= 8 && essais.length - adoptes >= 1, `essais : ${adoptes} adoptés, ${essais.length - adoptes} non adoptés, ${res.depot.commits} commits`);

console.log(`\nexceptions de la page : ${res.exceptions.length}`, res.exceptions.slice(0, 5));
writeFileSync(join(sortie, "resultats.json"), JSON.stringify(res, null, 1));
console.log(`résultats et captures dans ${sortie}`);
