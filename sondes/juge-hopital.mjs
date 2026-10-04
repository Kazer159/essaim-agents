// juge-hopital.mjs — le juge mécanique de la mission « hôpital » (missions/hopital.md).
// Il ne lit aucune doc pour agir et n'importe pas une ligne du livrable :
//  1. un vérificateur à lui, écrit d'après la mission et regles.csv (effectifs, absences, nuit, repos, semaines,
//     nuits et jours de suite, heures dues, week-ends), plus l'équité, les vœux et la régularité ;
//  2. trois mondes à lui, tirés à graine fixe : (a) un autre service faisable — prouvé par construction : un
//     planning témoin est bâti soignant par soignant, passé au vérificateur, et les besoins sont tirés de sa
//     couverture ; (b) un monde impossible (une nuit demande plus d'IDE qu'il n'y en a d'autorisés) ; (c) le monde
//     fourni deux fois plus grand (faisable : le planning livré, cloné, le tient), avec le temps de calcul ;
//  3. le programme lancé sur chaque monde ; ce qu'il affirme (console, RAPPORT.md) comparé à ce qu'on mesure ;
//  4. les valeurs du monde écrites en dur dans src/ ;
//  5. la page en file://, réseau coupé : vue d'ensemble, soignant, jour, semaine, équité, manques ; 1920, 390, A3 ;
//  6. bun test dans une copie, et le mode d'emploi rejoué tel qu'écrit sur le monde (a).
// Il constate ; la note se donne avec la grille. Lancé depuis le dépôt :
//   node sondes/juge-hopital.mjs runs/<run>/partage runs/<run>/juge
// Il n'écrit que dans le dossier de sortie (copie du livrable comprise).
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
const MONDE_FOURNI = join(depot, "missions", "entrees", "hopital");
const res = { conventions: {}, mondes: {}, affirmations: [], valeursEnDur: {}, page: {}, bunTest: {}, modeEmploi: {}, faussesAffirmations: 0 };
const dire = (ok, quoi) => { console.log(`${ok ? "ok" : "KO"}  ${quoi}`); return !!ok; };
const titre = (t) => console.log(`\n== ${t}`);
const nb = (s) => Number(String(s).replace(/\s| | /g, "").replace("−", "-").replace(",", "."));
const arr = (x) => Math.round(x * 100) / 100;

// ================================================================== le monde, lu comme la mission le décrit
function lireCsv(fichier) {
  const texte = readFileSync(fichier, "utf8").replace(/^﻿/, "").replace(/\r/g, "");
  const lignes = [];
  for (const brute of texte.split("\n")) {
    if (!brute.trim()) continue;
    const champs = []; let cur = "", q = false;
    for (let i = 0; i < brute.length; i++) {
      const c = brute[i];
      if (q) { if (c === '"' && brute[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
      else if (c === '"') q = true; else if (c === ",") { champs.push(cur); cur = ""; } else cur += c;
    }
    champs.push(cur); lignes.push(champs);
  }
  const [tete, ...corps] = lignes;
  return corps.map((l) => Object.fromEntries(tete.map((t, i) => [t.trim(), (l[i] ?? "").trim()])));
}
const ecrireCsv = (fichier, tete, lignes) =>
  writeFileSync(fichier, [tete.join(","), ...lignes.map((l) => tete.map((t) => { const v = String(l[t] ?? ""); return /[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; }).join(","))].join("\n") + "\n");

const JOUR_MS = 864e5;
const versMs = (j) => Date.parse(j + "T00:00:00Z");
const versJour = (ms) => new Date(ms).toISOString().slice(0, 10);
const hm = (s) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };

function chargerMonde(dossier) {
  const soignants = lireCsv(join(dossier, "soignants.csv")).map((s) => ({
    id: s.id, prenom: s.prenom, nom: s.nom, metier: s.metier, pct: Number(s.contrat_pct),
    comp: new Set((s.competences || "").split(";").map((x) => x.trim()).filter(Boolean)), nuit: /^oui$/i.test(s.nuit_autorisee),
  }));
  const postes = {};
  for (const p of lireCsv(join(dossier, "postes.csv"))) {
    const d = hm(p.debut), f = hm(p.fin);
    postes[p.poste] = { id: p.poste, debut: d, fin: f <= d ? f + 1440 : f, heures: Number(p.heures), nuit: f <= d };
  }
  const regles = Object.fromEntries(lireCsv(join(dossier, "regles.csv")).map((r) => [r.regle, r.valeur]));
  const R = {
    debut: regles.periode_debut, jours: Number(regles.periode_jours), reposEntre: Number(regles.repos_entre_postes_min),
    reposHebdo: Number(regles.repos_hebdomadaire_min), nuitsMax: Number(regles.nuits_consecutives_max),
    joursMax: Number(regles.jours_travailles_consecutifs_max), heuresSemMax: Number(regles.heures_semaine_max),
    heuresContrat: Number(regles.heures_contrat_semaine), ecart: Number(regles.ecart_heures_periode_max), weMin: Number(regles.weekends_repos_min),
  };
  const t0 = versMs(R.debut);
  const jours = Array.from({ length: R.jours }, (_, i) => versJour(t0 + i * JOUR_MS));
  const besoins = lireCsv(join(dossier, "besoins.csv")).map((b) => ({ jour: b.jour, poste: b.poste, metier: b.metier, comp: b.competence || "", min: Number(b.effectif_min) }));
  const absences = lireCsv(join(dossier, "absences.csv"));
  const voeux = lireCsv(join(dossier, "voeux.csv")).map((v) => ({ soignant: v.soignant, jour: v.jour, voeu: v.voeu }));
  const absent = new Map(soignants.map((s) => [s.id, new Set()]));
  for (const a of absences) for (let t = versMs(a.debut); t <= versMs(a.fin); t += JOUR_MS) { const j = versJour(t); if (jours.includes(j)) absent.get(a.soignant)?.add(j); }
  return { soignants, parId: new Map(soignants.map((s) => [s.id, s])), postes, R, jours, besoins, absences, voeux, absent };
}
const dow = (j) => new Date(versMs(j)).getUTCDay(); // 0 dimanche … 6 samedi

// ================================================================== le vérificateur du juge
// Conventions retenues (écrites dans le JSON) : besoins en lecture concurrente ; heures de la semaine au jour de
// début du poste ; repos hebdomadaire mesuré à l'intérieur de la semaine civile (lundi 0 h → lundi 0 h, bornée à
// la période) ; jour travaillé = jour où un poste commence ; week-end libre = aucun poste ne commence le samedi ni
// le dimanche (lecture stricte, avec la nuit du vendredi, donnée à titre d'information) ; heures dues = contrat ×
// jours/7 − jours d'absence × contrat/7 (contrat = heures_contrat_semaine × pct/100).
res.conventions = {
  besoins: "lecture concurrente : chaque ligne est une borne ; un soignant compétent compte pour la ligne métier et pour la ligne compétence (la lecture additive est mesurée à part, pour information)",
  heuresSemaine: "un poste compte dans la semaine civile de son jour de début",
  reposHebdo: "plus long repos à l'intérieur de chaque semaine civile (lundi 0 h → lundi 0 h, bornée à la période), les postes qui débordent étant coupés à la frontière",
  jourTravaille: "un jour où un poste commence (la fin d'une nuit le lendemain matin ne fait pas un jour travaillé)",
  weekendLibre: "aucun poste ne commence le samedi ni le dimanche ; variante stricte (nuit du vendredi comprise) donnée pour information",
  heuresDues: "heures_contrat_semaine × pct/100 × jours/7 − jours d'absence dans la période × heures_contrat_semaine/7 × pct/100",
  soir: "poste qui commence à 12 h ou plus sans passer minuit ; nuit : poste qui passe minuit",
  equite: "par métier, attendu = total du métier × pct / Σ pct (nuits : seulement les soignants autorisés de nuit)",
  regularite: "changement = deux jours de calendrier consécutifs travaillés avec deux postes différents",
};

function verifier(M, affs) {
  const V = { besoins: [], absence: [], unParJour: [], nuitAutorisee: [], metierCompetence: [], inconnu: [], horsPeriode: [], reposEntre: [], reposHebdo: [], heuresSemaine: [], nuitsConsec: [], joursConsec: [], ecartHeures: [], weekends: [] };
  const info = { besoinsAdditifs: 0, weekendsStricts: 0 };
  const idx = new Map(M.jours.map((j, i) => [j, i]));
  const parPers = new Map(M.soignants.map((s) => [s.id, []]));
  const cle = new Map();
  for (const a of affs) {
    const s = M.parId.get(a.soignant), p = M.postes[a.poste];
    if (!s || !p) { V.inconnu.push(a); continue; }
    if (!idx.has(a.jour)) { V.horsPeriode.push(a); continue; }
    parPers.get(s.id).push({ d: idx.get(a.jour), jour: a.jour, poste: a.poste });
    const k = `${a.jour}|${a.poste}`; if (!cle.has(k)) cle.set(k, []); cle.get(k).push(s);
    if (M.absent.get(s.id).has(a.jour)) V.absence.push({ soignant: s.id, jour: a.jour });
    if (p.nuit && !s.nuit) V.nuitAutorisee.push({ soignant: s.id, jour: a.jour });
    if (!M.besoins.some((b) => b.jour === a.jour && b.poste === a.poste && b.metier === s.metier))
      V.metierCompetence.push({ soignant: s.id, jour: a.jour, poste: a.poste, quoi: `métier ${s.metier} non demandé` });
  }
  // effectifs
  for (const b of M.besoins) {
    const la = (cle.get(`${b.jour}|${b.poste}`) || []).filter((s) => s.metier === b.metier && (!b.comp || s.comp.has(b.comp)));
    if (la.length < b.min) V.besoins.push({ jour: b.jour, poste: b.poste, metier: b.metier, competence: b.comp, min: b.min, couvert: la.length, manque: b.min - la.length });
  }
  const groupes = new Map();
  for (const b of M.besoins) { const k = `${b.jour}|${b.poste}|${b.metier}`; groupes.set(k, (groupes.get(k) || 0) + b.min); }
  for (const [k, somme] of groupes) { const [j, p, m] = k.split("|"); const c = (cle.get(`${j}|${p}`) || []).filter((s) => s.metier === m).length; if (c < somme) info.besoinsAdditifs++; }
  // par soignant
  const R = M.R, D = M.jours.length, finPeriode = D * 1440;
  const lundi0 = -((dow(M.jours[0]) + 6) % 7); // index (peut être négatif) du lundi de la première semaine
  const personnes = {};
  for (const s of M.soignants) {
    const L = parPers.get(s.id).sort((x, y) => x.d - y.d || M.postes[x.poste].debut - M.postes[y.poste].debut);
    const r = verifierPersonne(M, s, L, lundi0, finPeriode);
    for (const k of Object.keys(r.v)) V[k].push(...r.v[k]);
    info.weekendsStricts += r.weStrictKO ? 1 : 0;
    personnes[s.id] = r.m;
  }
  const compte = Object.fromEntries(Object.entries(V).map(([k, v]) => [k, v.length]));
  const total = Object.values(compte).reduce((a, b) => a + b, 0);
  return { V, compte, total, info, personnes };
}

function verifierPersonne(M, s, L, lundi0, finPeriode) {
  const R = M.R, D = M.jours.length;
  const v = { unParJour: [], reposEntre: [], reposHebdo: [], heuresSemaine: [], nuitsConsec: [], joursConsec: [], ecartHeures: [], weekends: [] };
  const parJour = new Map();
  for (const x of L) { if (!parJour.has(x.d)) parJour.set(x.d, []); parJour.get(x.d).push(x); }
  for (const [d, xs] of parJour) if (xs.length > 1) v.unParJour.push({ soignant: s.id, jour: M.jours[d], postes: xs.map((x) => x.poste).join("+") });
  const inter = L.map((x) => ({ ...x, a: x.d * 1440 + M.postes[x.poste].debut, b: x.d * 1440 + M.postes[x.poste].fin, h: M.postes[x.poste].heures, nuit: M.postes[x.poste].nuit }));
  for (let i = 1; i < inter.length; i++) {
    const repos = (inter[i].a - inter[i - 1].b) / 60;
    if (repos < R.reposEntre) v.reposEntre.push({ soignant: s.id, de: `${inter[i - 1].jour} ${inter[i - 1].poste}`, a: `${inter[i].jour} ${inter[i].poste}`, repos: arr(repos), manque: arr(R.reposEntre - repos) });
  }
  // semaines civiles
  for (let w0 = lundi0; w0 < D; w0 += 7) {
    const debutW = Math.max(0, w0) * 1440, finW = Math.min(D, w0 + 7) * 1440;
    const h = inter.filter((x) => x.d >= w0 && x.d < w0 + 7).reduce((a, x) => a + x.h, 0);
    if (h > R.heuresSemMax + 1e-9) v.heuresSemaine.push({ soignant: s.id, semaine: M.jours[Math.max(0, w0)], heures: h, depassement: arr(h - R.heuresSemMax) });
    if (finW - debutW < R.reposHebdo * 60) continue; // semaine de bord trop courte pour être jugée
    const occ = inter.map((x) => [Math.max(x.a, debutW), Math.min(x.b, finW)]).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
    let t = debutW, max = 0;
    for (const [a, b] of occ) { max = Math.max(max, a - t); t = Math.max(t, b); }
    max = Math.max(max, finW - t);
    if (max < R.reposHebdo * 60) v.reposHebdo.push({ soignant: s.id, semaine: M.jours[Math.max(0, w0)], reposMax: arr(max / 60), manque: arr(R.reposHebdo - max / 60) });
  }
  // suites
  const travaille = new Array(D).fill(false), nuit = new Array(D).fill(false), posteDe = new Array(D).fill(null);
  for (const x of inter) { travaille[x.d] = true; if (x.nuit) nuit[x.d] = true; posteDe[x.d] = x.poste; }
  const suites = (tab, max, cle) => { let n = 0; for (let d = 0; d <= D; d++) { if (d < D && tab[d]) n++; else { if (n > max) v[cle].push({ soignant: s.id, fin: M.jours[d - 1], suite: n, depassement: n - max }); n = 0; } } };
  suites(nuit, R.nuitsMax, "nuitsConsec");
  suites(travaille, R.joursMax, "joursConsec");
  // heures dues
  const contrat = R.heuresContrat * s.pct / 100;
  const du = contrat * D / 7 - M.absent.get(s.id).size * contrat / 7;
  const planifie = inter.reduce((a, x) => a + x.h, 0);
  if (Math.abs(planifie - du) > R.ecart + 1e-9) v.ecartHeures.push({ soignant: s.id, planifie, du: arr(du), ecart: arr(planifie - du), depassement: arr(Math.abs(planifie - du) - R.ecart) });
  // week-ends
  let libres = 0, libresStricts = 0, travailles = 0;
  for (let d = 0; d < D - 1; d++) {
    if (dow(M.jours[d]) !== 6) continue;
    const libre = !travaille[d] && !travaille[d + 1];
    libres += libre; travailles += !libre;
    libresStricts += libre && !(d > 0 && nuit[d - 1]);
  }
  if (libres < R.weMin) v.weekends.push({ soignant: s.id, libres, manque: R.weMin - libres });
  let changements = 0;
  for (let d = 1; d < D; d++) if (travaille[d] && travaille[d - 1] && posteDe[d] !== posteDe[d - 1]) changements++;
  const soirs = inter.filter((x) => !x.nuit && M.postes[x.poste].debut >= 720).length;
  return { v, weStrictKO: libresStricts < R.weMin, m: { planifie, du: arr(du), ecart: arr(planifie - du), nuits: inter.filter((x) => x.nuit).length, weTravailles: travailles, weLibres: libres, soirs, changements } };
}

function mesurer(M, affs, ver) {
  const P = ver.personnes;
  // vœux
  const aff = new Map(affs.map((a) => [`${a.soignant}|${a.jour}`, a.poste]));
  let tenus = 0; const parS = new Map();
  for (const v of M.voeux) {
    const p = aff.get(`${v.soignant}|${v.jour}`);
    const ok = v.voeu === "repos" ? !p : p === v.voeu;
    tenus += ok; if (!parS.has(v.soignant)) parS.set(v.soignant, [0, 0]); parS.get(v.soignant)[0] += ok; parS.get(v.soignant)[1]++;
  }
  const tousRefuses = [...parS].filter(([, [t]]) => t === 0).map(([id]) => id).sort();
  const tousTenus = [...parS].filter(([, [t, n]]) => t === n).map(([id]) => id).sort();
  // équité
  const equite = {};
  for (const metier of [...new Set(M.soignants.map((s) => s.metier))]) {
    equite[metier] = {};
    for (const [crit, champ, filtre] of [["nuits", "nuits", (s) => s.nuit], ["weekends", "weTravailles", () => true], ["soirs", "soirs", () => true]]) {
      const qui = M.soignants.filter((s) => s.metier === metier && filtre(s));
      if (!qui.length) continue;
      const total = qui.reduce((a, s) => a + P[s.id][champ], 0), spct = qui.reduce((a, s) => a + s.pct, 0);
      const val = qui.map((s) => P[s.id][champ]), norm = qui.map((s) => P[s.id][champ] * 100 / s.pct);
      const ecarts = qui.map((s) => P[s.id][champ] - total * s.pct / spct);
      equite[metier][crit] = { soignants: qui.length, total, min: Math.min(...val), max: Math.max(...val), etendue: Math.max(...val) - Math.min(...val),
        etendueA100: arr(Math.max(...norm) - Math.min(...norm)), ecartMin: arr(Math.min(...ecarts)), ecartMax: arr(Math.max(...ecarts)) };
    }
  }
  const changements = Object.values(P).reduce((a, p) => a + p.changements, 0);
  const ecarts = Object.values(P).map((p) => p.ecart);
  return { affectations: affs.length, voeux: { total: M.voeux.length, tenus, tousRefuses, tousTenus }, equite, regularite: { changements },
    heures: { planifie: arr(Object.values(P).reduce((a, p) => a + p.planifie, 0)), du: arr(Object.values(P).reduce((a, p) => a + p.du, 0)), ecartMin: Math.min(...ecarts), ecartMax: Math.max(...ecarts) } };
}

const lirePlanning = (f) => lireCsv(f).map((l) => ({ soignant: l.soignant, jour: l.jour, poste: l.poste }));

// ================================================================== les mondes du juge
function hasard(graine) { let a = graine >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function ecrireMonde(dossier, M) {
  mkdirSync(dossier, { recursive: true });
  ecrireCsv(join(dossier, "soignants.csv"), ["id", "prenom", "nom", "metier", "contrat_pct", "competences", "nuit_autorisee", "anciennete_ans"],
    M.soignants.map((s) => ({ ...s, contrat_pct: s.pct, competences: [...s.comp].join(";"), nuit_autorisee: s.nuit ? "oui" : "non", anciennete_ans: s.anciennete ?? 5 })));
  const f = (m) => `${String(Math.floor((m % 1440) / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  ecrireCsv(join(dossier, "postes.csv"), ["poste", "debut", "fin", "heures"], Object.values(M.postes).map((p) => ({ poste: p.id, debut: f(p.debut), fin: f(p.fin), heures: p.heures })));
  ecrireCsv(join(dossier, "besoins.csv"), ["jour", "poste", "metier", "competence", "effectif_min"], M.besoins.map((b) => ({ ...b, competence: b.comp, effectif_min: b.min })));
  ecrireCsv(join(dossier, "absences.csv"), ["soignant", "debut", "fin", "motif"], M.absences);
  ecrireCsv(join(dossier, "voeux.csv"), ["soignant", "jour", "voeu"], M.voeux);
  const R = M.R;
  ecrireCsv(join(dossier, "regles.csv"), ["regle", "valeur", "precision", "unite"], [
    ["periode_debut", R.debut, "premier jour du planning"], ["periode_jours", R.jours, "jours"], ["repos_entre_postes_min", R.reposEntre, "heures entre la fin d'un poste et le début du suivant"],
    ["repos_hebdomadaire_min", R.reposHebdo, "heures consécutives de repos dans chaque semaine civile"], ["nuits_consecutives_max", R.nuitsMax, "nuits de suite"],
    ["jours_travailles_consecutifs_max", R.joursMax, "jours de suite"], ["heures_semaine_max", R.heuresSemMax, "heures dans une semaine civile"],
    ["heures_contrat_semaine", R.heuresContrat, "heures par semaine à 100 %, au prorata du contrat"], ["ecart_heures_periode_max", R.ecart, "écart toléré sur la période entre heures planifiées et heures dues, en plus ou en moins"],
    ["weekends_repos_min", R.weMin, "week-ends entièrement libres sur la période, pour chacun"],
  ].map(([regle, valeur, unite]) => ({ regle, valeur, precision: "", unite })));
}

// (a) Un autre service de 34 soignants, sur cinq semaines de 2027, avec d'autres règles et d'autres horaires.
// Faisable par construction : chaque soignant reçoit un planning témoin tiré au hasard et gardé seulement s'il passe
// le vérificateur du juge ; les besoins sont ensuite 80 % de ce que le témoin couvre. Le témoin tient donc tout.
function mondeA() {
  const rng = hasard(20260928);
  const pick = (t) => t[Math.floor(rng() * t.length)];
  const R = { debut: "2027-03-01", jours: 35, reposEntre: 12, reposHebdo: 35, nuitsMax: 2, joursMax: 5, heuresSemMax: 44, heuresContrat: 33, ecart: 10, weMin: 2 };
  const postes = { M: { id: "M", debut: hm("07:00"), fin: hm("14:30"), heures: 7.5, nuit: false }, S: { id: "S", debut: hm("14:00"), fin: hm("21:30"), heures: 7.5, nuit: false },
    N: { id: "N", debut: hm("21:30"), fin: hm("07:30") + 1440, heures: 10, nuit: true } };
  const PRENOMS = ["Maëlle", "Erwan", "Soizic", "Gwenaël", "Yann", "Nolwenn", "Loïc", "Anaïs", "Tugdual", "Rozenn", "Malo", "Awen", "Klervi", "Brieuc", "Enora", "Ronan", "Solenn", "Corentin", "Morgane", "Goulven", "Katell", "Aziliz", "Mikaël", "Riwal", "Sterenn", "Jakez", "Nina", "Paol", "Lena", "Alan", "Maiwenn", "Glenn", "Youenn", "Armelle"];
  const NOMS = ["Le Goff", "Kerbrat", "Quéméner", "Tanguy", "Le Bihan", "Morvan", "Cariou", "Jaouen", "Salaün", "Péron", "Bescond", "Nédélec", "Floch", "Riou", "Coadou", "Lagadec", "Le Gall", "Cloarec", "Abgrall", "Prigent", "Hamon", "Olier", "Kerléo", "Madec", "Tréguer", "Uguen", "Le Meur", "Sévellec", "Donnart", "Castel", "Guéguen", "Pouliquen", "Rannou", "Créach"];
  const soignants = [];
  for (let i = 0; i < 34; i++) {
    const metier = i < 20 ? "IDE" : "AS";
    const comp = new Set();
    if (metier === "IDE" && rng() < 0.45) comp.add("referent");
    if (metier === "IDE" && rng() < 0.25) comp.add("dialyse");
    soignants.push({ id: `B${101 + i}`, prenom: PRENOMS[i], nom: NOMS[i], metier, pct: pick([100, 100, 100, 80, 80, 50]), comp, nuit: rng() < 0.72, anciennete: Math.floor(rng() * 30) });
  }
  const t0 = versMs(R.debut);
  const jours = Array.from({ length: R.jours }, (_, i) => versJour(t0 + i * JOUR_MS));
  const absences = [];
  for (let k = 0; k < 9; k++) { const s = soignants[Math.floor(rng() * 34)], d = Math.floor(rng() * 32), n = 1 + Math.floor(rng() * 4); absences.push({ soignant: s.id, debut: jours[d], fin: jours[Math.min(34, d + n - 1)], motif: pick(["conges", "formation", "maladie"]) }); }
  const M = { soignants, parId: new Map(soignants.map((s) => [s.id, s])), postes, R, jours, besoins: [], absences, voeux: [], absent: new Map(soignants.map((s) => [s.id, new Set()])) };
  for (const a of absences) for (let t = versMs(a.debut); t <= versMs(a.fin); t += JOUR_MS) M.absent.get(a.soignant).add(versJour(t));
  // types : au moins 4 IDE et 3 AS de nuit parmi les autorisés
  const nuitIDE = soignants.filter((s) => s.metier === "IDE" && s.nuit).slice(0, 5), nuitAS = soignants.filter((s) => s.metier === "AS" && s.nuit).slice(0, 4);
  const deNuit = new Set([...nuitIDE, ...nuitAS].map((s) => s.id));
  const temoin = [];
  const samedis = jours.map((j, d) => d).filter((d) => dow(jours[d]) === 6 && d + 1 < R.jours);
  for (const s of soignants) {
    let trouve = null;
    for (let essai = 0; essai < 200000 && !trouve; essai++) {
      const off = new Set([...M.absent.get(s.id)].map((j) => jours.indexOf(j)));
      const libres = [...samedis].sort(() => rng() - 0.5).slice(0, R.weMin + (rng() < 0.4 ? 1 : 0));
      for (const d of libres) { off.add(d); off.add(d + 1); }
      const L = []; let d = Math.floor(rng() * 3);
      const [gmin, gspan] = s.pct === 100 ? [1, 2] : s.pct === 80 ? [1, 3] : [2, 4];
      while (d < R.jours) {
        const nuit = deNuit.has(s.id);
        const long = 1 + Math.floor(rng() * (nuit ? R.nuitsMax : R.joursMax));
        const poste = nuit ? "N" : rng() < 0.5 ? "M" : "S";
        for (let k = 0; k < long && d < R.jours; k++, d++) { if (off.has(d)) break; L.push({ d, jour: jours[d], poste }); }
        d += gmin + Math.floor(rng() * gspan);
      }
      const r = verifierPersonne(M, s, L, 0, R.jours * 1440);
      if (Object.values(r.v).every((x) => !x.length)) trouve = L;
    }
    if (!trouve) throw new Error(`monde (a) : pas de témoin pour ${s.id}`);
    for (const x of trouve) temoin.push({ soignant: s.id, jour: x.jour, poste: x.poste });
  }
  // besoins : 80 % de la couverture du témoin, par métier ; compétences quand le témoin en a
  for (const j of jours) for (const p of Object.keys(postes)) {
    const la = temoin.filter((a) => a.jour === j && a.poste === p).map((a) => M.parId.get(a.soignant));
    for (const metier of ["IDE", "AS"]) M.besoins.push({ jour: j, poste: p, metier, comp: "", min: Math.floor(la.filter((s) => s.metier === metier).length * 0.8) });
    const refs = la.filter((s) => s.metier === "IDE" && s.comp.has("referent")).length;
    if (refs) M.besoins.push({ jour: j, poste: p, metier: "IDE", comp: "referent", min: 1 });
    const dial = la.filter((s) => s.metier === "IDE" && s.comp.has("dialyse")).length;
    if (dial && p === "M" && [2, 4, 6].includes(dow(j))) M.besoins.push({ jour: j, poste: p, metier: "IDE", comp: "dialyse", min: 1 });
  }
  const vus = new Set();
  while (M.voeux.length < 45) {
    const s = pick(soignants), j = pick(jours), v = pick(s.nuit ? ["M", "S", "N", "repos", "repos"] : ["M", "S", "repos", "repos"]);
    if (vus.has(s.id + j) || M.absent.get(s.id).has(j)) continue; vus.add(s.id + j); M.voeux.push({ soignant: s.id, jour: j, voeu: v });
  }
  const ver = verifier(M, temoin);
  return { M, temoin, preuve: ver.total };
}

// (b) Le monde fourni, avec une nuit qui demande trois IDE de plus qu'il n'y a d'IDE autorisés de nuit présents ce jour-là.
function mondeImpossible(F) {
  const jour = F.jours[10];
  const dispo = F.soignants.filter((s) => s.metier === "IDE" && s.nuit && !F.absent.get(s.id).has(jour)).length;
  const besoins = F.besoins.map((b) => (b.jour === jour && b.poste === "N" && b.metier === "IDE" && !b.comp ? { ...b, min: dispo + 3 } : b));
  return { M: { ...F, besoins }, cible: { jour, poste: "N", metier: "IDE", demande: dispo + 3, autorises: dispo, manqueMinimal: 3 } };
}

// (c) Le monde fourni deux fois plus grand : chaque soignant a un jumeau (autre identifiant, autre nom), besoins doublés.
function mondeDouble(F) {
  const n = F.soignants.length, id = (s) => `S${String(Number(s.id.replace(/\D/g, "")) + n).padStart(2, "0")}`;
  const jum = F.soignants.map((s) => ({ ...s, id: id(s), nom: s.nom + "-Kervella", comp: new Set(s.comp) }));
  const soignants = [...F.soignants, ...jum], parId = new Map(soignants.map((s) => [s.id, s]));
  const map = new Map(F.soignants.map((s) => [s.id, id(s)]));
  const absences = [...F.absences, ...F.absences.map((a) => ({ ...a, soignant: map.get(a.soignant) }))];
  const voeux = [...F.voeux, ...F.voeux.map((v) => ({ ...v, soignant: map.get(v.soignant) }))];
  const absent = new Map([...F.absent, ...[...F.absent].map(([k, v]) => [map.get(k), new Set(v)])]);
  return { M: { ...F, soignants, parId, besoins: F.besoins.map((b) => ({ ...b, min: b.min * 2 })), absences, voeux, absent }, jumeau: map };
}

// ================================================================== le programme, lancé comme le mode d'emploi le dit
// La copie garde la disposition du run (partage/ à côté d'entrees/) : les tests du livrable lisent ../entrees.
const banc = join(sortie, "banc"), copie = join(banc, "partage");
rmSync(banc, { recursive: true, force: true }); rmSync(join(sortie, "copie-partage"), { recursive: true, force: true });
cpSync(partage, copie, { recursive: true, filter: (s) => !s.includes("node_modules") });
if (existsSync(join(partage, "..", "entrees"))) cpSync(join(partage, "..", "entrees"), join(banc, "entrees"), { recursive: true });

function lancer(nom, donnees, graine) {
  const out = join(sortie, "sorties", nom);
  rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true });
  const args = ["src/main.js", donnees, out, ...(graine != null ? [`--graine=${graine}`] : [])];
  const t = Date.now();
  const r = spawnSync("node", args, { cwd: copie, encoding: "utf8", timeout: 900000 });
  const duree = Date.now() - t;
  const lu = (f) => (existsSync(join(out, f)) ? readFileSync(join(out, f), "utf8") : null);
  return { commande: `node ${args.join(" ")}`, code: r.status, dureeMs: duree, console: (r.stdout || "") + (r.stderr || ""), out, planning: existsSync(join(out, "planning.csv")) ? lirePlanning(join(out, "planning.csv")) : null, rapport: lu("RAPPORT.md"), page: existsSync(join(out, "index.html")) };
}

// ---- lecture de ce que le programme affirme
const LIGNES_REGLES = [[/Effectif minimal/i, "besoins"], [/absence/i, "absence"], [/Au plus un poste/i, "unParJour"], [/Nuit autoris/i, "nuitAutorisee"], [/Métier et compétence/i, "metierCompetence"],
  [/Repos minimal entre/i, "reposEntre"], [/Repos hebdomadaire/i, "reposHebdo"], [/Heures maximales/i, "heuresSemaine"], [/Nuits consécutives/i, "nuitsConsec"],
  [/Jours travaillés consécutifs/i, "joursConsec"], [/Écart toléré/i, "ecartHeures"], [/Week-ends/i, "weekends"]];
function section(md, n) { const i = md.indexOf(`## ${n}.`); if (i < 0) return ""; const j = md.indexOf("\n## ", i + 3); return md.slice(i, j < 0 ? undefined : j); }
const tableau = (txt) => txt.split("\n").filter((l) => /^\|/.test(l) && !/^\|\s*-/.test(l)).slice(1).map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));

function comparer(nom, M, run, ver, mes) {
  const A = []; // { quoi, affirme, mesure, vrai }
  const aff = (quoi, affirme, mesure, vrai) => { A.push({ monde: nom, quoi, affirme, mesure, vrai }); dire(vrai, `[${nom}] ${quoi} : affirmé ${affirme}, mesuré ${mesure}`); };
  const md = run.rapport || "", con = run.console || "";
  const toutTenu = /Toutes les règles sont tenues/i.test(md) || /toutes tenues/i.test(con);
  aff("verdict « toutes les règles tenues »", toutTenu ? "toutes tenues" : "pas toutes tenues", ver.total ? `${ver.total} violation(s)` : "0 violation", toutTenu === (ver.total === 0));
  for (const l of tableau(section(md, 2))) {
    const k = LIGNES_REGLES.find(([re]) => re.test(l[0]))?.[1];
    if (!k || /signal/i.test(l[1])) continue;
    const ditTenue = /^tenue$/i.test(l[1]);
    if (ditTenue || ver.compte[k] === 0) { if (ditTenue !== (ver.compte[k] === 0)) aff(`règle « ${l[0]} »`, `${l[1]} (${l[2]} écart)`, `${ver.compte[k]} violation(s)`, false); }
    else A.push({ monde: nom, quoi: `règle « ${l[0]} » avouée non tenue`, affirme: `${l[2]} écart(s)`, mesure: `${ver.compte[k]} violation(s)`, vrai: true, aveu: true });
  }
  const vx = md.match(/\*\*(\d+) vœux tenus\*\* sur (\d+)/);
  if (vx) aff("vœux tenus", `${vx[1]}/${vx[2]}`, `${mes.voeux.tenus}/${mes.voeux.total}`, +vx[1] === mes.voeux.tenus && +vx[2] === mes.voeux.total);
  const cv = con.match(/vœux tenus (\d+)\/(\d+)/);
  if (cv) aff("vœux tenus (console)", `${cv[1]}/${cv[2]}`, `${mes.voeux.tenus}/${mes.voeux.total}`, +cv[1] === mes.voeux.tenus);
  const inj = md.match(/(\d+) soignants? voient tous leurs vœux refusés \(([^)]*)\)(?: alors que (\d+) autres? voient tous les leurs tenus \(([^)]*)\))?/);
  if (inj) {
    const a = inj[2].split(/,\s*/).sort().join(",");
    const abrege = /…$/.test(inj[4] || ""), listeB = (inj[4] || "").replace(/…$/, "").split(/,\s*/).filter(Boolean);
    const b = abrege ? (+inj[3] === mes.voeux.tousTenus.length && listeB.every((x) => mes.voeux.tousTenus.includes(x)) ? mes.voeux.tousTenus.join(",") : "faux") : listeB.sort().join(",");
    aff("soignants dont tous les vœux sont refusés", inj[2], mes.voeux.tousRefuses.join(", "), a === mes.voeux.tousRefuses.join(","));
    if (inj[4] != null) aff("soignants dont tous les vœux sont tenus", inj[4], mes.voeux.tousTenus.join(", "), b === mes.voeux.tousTenus.join(","));
  }
  const rg = md.match(/\*\*(\d+) changements de poste\*\*/);
  if (rg) aff("changements de poste (régularité)", rg[1], mes.regularite.changements, +rg[1] === mes.regularite.changements);
  const hs = md.match(/Total planifié \*\*([\d\s ,]+) h\*\* contre \*\*([\d\s ,]+) h\*\* dues/);
  if (hs) aff("heures totales planifiées / dues", `${hs[1]} / ${hs[2]}`, `${mes.heures.planifie} / ${mes.heures.du}`, Math.abs(nb(hs[1]) - mes.heures.planifie) < 0.01 && Math.abs(nb(hs[2]) - mes.heures.du) < 0.6);
  // tableaux par soignant : heures (section 3), équité et changements (section 4)
  let ko3 = [], n3 = 0;
  for (const l of tableau(section(md, 3))) { const p = ver.personnes[l[0]]; if (!p) continue; n3++; if (Math.abs(nb(l[3]) - p.planifie) > 0.01 || Math.abs(nb(l[4]) - p.du) > 0.6) ko3.push(`${l[0]} ${l[3]}/${l[4]} ≠ ${p.planifie}/${p.du}`); }
  if (n3) aff("heures planifiées et dues, soignant par soignant", `${n3} lignes`, ko3.length ? ko3.slice(0, 5).join(" ; ") : "toutes justes", ko3.length === 0);
  let ko4 = [], n4 = 0;
  for (const l of tableau(section(md, 4))) {
    const p = ver.personnes[l[0]]; if (!p) continue; n4++;
    const r = (c) => (c.startsWith("—") ? 0 : nb(c.split("/")[0]));
    const d = [["nuits", r(l[3]), p.nuits], ["WE", r(l[4]), p.weTravailles], ["soirs", r(l[5]), p.soirs], ["changements", nb(l[6]), p.changements]].filter(([, a, b]) => a !== b);
    if (d.length) ko4.push(`${l[0]} ${d.map(([q, a, b]) => `${q} ${a}≠${b}`).join(",")}`);
  }
  if (n4) aff("nuits, week-ends, soirs et changements, soignant par soignant", `${n4} lignes`, ko4.length ? ko4.slice(0, 6).join(" ; ") : "tous justes", ko4.length === 0);
  for (const m of Object.keys(mes.equite)) for (const [crit, mot] of [["nuits", "nuits"], ["weekends", "week-ends travaillés"], ["soirs", "postes du soir"]]) {
    const re = new RegExp(`- ${m} —[^\\n]*?\\*\\*${mot}\\*\\* : total (\\d+) pour (\\d+) soignants[^;]*?réalisé de (\\d+) à (\\d+), \\*\\*étendue max−min = (\\d+)\\*\\*`);
    const x = md.match(re); const e = mes.equite[m][crit];
    if (x && e) aff(`équité ${m} ${crit} (total, effectif, min, max)`, `${x[1]} pour ${x[2]}, ${x[3]} à ${x[4]}`, `${e.total} pour ${e.soignants}, ${e.min} à ${e.max}`, +x[1] === e.total && +x[2] === e.soignants && +x[3] === e.min && +x[4] === e.max);
  }
  // les compromis chiffrent-ils des écarts qui existent ?
  const cn = md.match(/Écart de (\d+) nuit\(s\) entre le moins et le plus chargé/);
  if (cn) {
    const parMetier = Object.values(mes.equite).map((e) => e.nuits?.etendue ?? 0);
    const tous = Object.values(ver.personnes).map((p) => p.nuits);
    const global = Math.max(...tous) - Math.min(...tous);
    A.push({ monde: nom, quoi: "compromis « écart de nuits »", affirme: cn[1], mesure: `par métier ${parMetier.join("/")}, tous soignants confondus (non autorisés de nuit compris) ${global}`, vrai: parMetier.includes(+cn[1]) || global === +cn[1], nuance: !parMetier.includes(+cn[1]) });
  }
  return A;
}

// ================================================================== 1-3. mondes, vérifications, affirmations
titre("les mondes");
const F = chargerMonde(MONDE_FOURNI);
const livre = lirePlanning(join(partage, "planning.csv"));
const verLivre = verifier(F, livre), mesLivre = mesurer(F, livre, verLivre);
dire(verLivre.total === 0, `planning.csv livré : ${verLivre.total} violation(s) ${JSON.stringify(verLivre.compte)}`);
res.mondes.livre = { violations: verLivre.compte, exemples: Object.fromEntries(Object.entries(verLivre.V).filter(([, v]) => v.length).map(([k, v]) => [k, v.slice(0, 5)])), info: verLivre.info, mesures: mesLivre };
res.affirmations.push(...comparer("livré", F, { rapport: readFileSync(join(partage, "RAPPORT.md"), "utf8"), console: "" }, verLivre, mesLivre));

const dirs = { a: join(sortie, "mondes", "a-autre-service"), b: join(sortie, "mondes", "b-impossible"), c: join(sortie, "mondes", "c-double") };
const A = mondeA(); ecrireMonde(dirs.a, A.M);
dire(A.preuve === 0, `monde (a) faisable par construction : le témoin (${A.temoin.length} postes) a ${A.preuve} violation au vérificateur du juge`);
ecrireCsv(join(dirs.a, "..", "a-temoin-planning.csv"), ["soignant", "jour", "poste"], A.temoin);
const B = mondeImpossible(F); ecrireMonde(dirs.b, B.M);
const C = mondeDouble(F); ecrireMonde(dirs.c, C.M);
const cloneLivre = [...livre, ...livre.map((a) => ({ ...a, soignant: C.jumeau.get(a.soignant) }))];
const preuveC = verifier(C.M, cloneLivre).total;
dire(preuveC === 0, `monde (c) faisable : le planning livré, cloné, a ${preuveC} violation`);
// relire chaque monde depuis le disque : le juge vérifie ce que le programme lit, pas sa mémoire
const MA = chargerMonde(dirs.a), MB = chargerMonde(dirs.b), MC = chargerMonde(dirs.c);
res.conventions.faisabiliteA = `construction : planning témoin (${A.temoin.length} postes, sondes/juge-hopital.mjs → mondes/a-temoin-planning.csv), 0 violation, besoins = 80 % de sa couverture ; relu du disque : ${verifier(MA, A.temoin).total} violation`;
res.conventions.faisabiliteC = `le planning livré cloné sur les jumeaux : ${verifier(MC, cloneLivre).total} violation`;
res.conventions.impossibleB = B.cible;

const essais = [
  ["fourni-graine-1", MONDE_FOURNI, F, 1], ["fourni-defaut", MONDE_FOURNI, F, null],
  ["a-autre-service", dirs.a, MA, null], ["b-impossible", dirs.b, MB, null], ["c-double", dirs.c, MC, null],
];
const runs = {};
for (const [nom, dossier, M, graine] of essais) {
  titre(`programme sur ${nom}`);
  const r = lancer(nom, dossier, graine); runs[nom] = r;
  const e = { commande: r.commande, code: r.code, dureeMs: r.dureeMs, console: r.console.slice(0, 1500) };
  if (!r.planning) { dire(false, `${nom} : pas de planning (code ${r.code}) ${r.console.slice(0, 300)}`); res.mondes[nom] = e; continue; }
  const ver = verifier(M, r.planning), mes = mesurer(M, r.planning, ver);
  dire(r.code === 0, `${nom} : code ${r.code}, ${r.dureeMs} ms, ${r.planning.length} affectations`);
  dire(ver.total === 0, `${nom} : ${ver.total} violation(s) ${JSON.stringify(Object.fromEntries(Object.entries(ver.compte).filter(([, v]) => v)))}`);
  Object.assign(e, { violations: ver.compte, total: ver.total, exemples: Object.fromEntries(Object.entries(ver.V).filter(([, v]) => v.length).map(([k, v]) => [k, v.slice(0, 6)])), info: ver.info, mesures: mes });
  res.affirmations.push(...comparer(nom, M, r, ver, mes));
  res.mondes[nom] = e;
  if (nom === "fourni-graine-1") {
    const a = livre.map((x) => `${x.soignant},${x.jour},${x.poste}`).sort().join("\n"), b = r.planning.map((x) => `${x.soignant},${x.jour},${x.poste}`).sort().join("\n");
    e.reproduitLeLivre = a === b; dire(a === b, "la graine 1 (celle écrite dans la page livrée) redonne planning.csv à l'identique");
  }
  if (nom === "b-impossible") {
    const md = r.rapport || "", c = B.cible;
    const mesure = ver.V.besoins.find((x) => x.jour === c.jour && x.poste === "N" && x.metier === "IDE" && !x.competence);
    const [aa, mm, jj] = c.jour.split("-");
    const reDate = new RegExp(`${c.jour}|${+jj}\\s*(nov|/\\s*${mm})|${jj}/${mm}`, "i");
    const lignes = (md + "\n" + r.console).split("\n").filter((l) => reDate.test(l) && /IDE/.test(l) && /\bN\b|nuit/i.test(l));
    const chiffre = lignes.filter((l) => mesure && new RegExp(`(^|[^\\d])${mesure.manque}([^\\d,]|$)`).test(l));
    e.impossible = { cible: c, manqueMesure: mesure?.manque ?? 0, lignesQuiLeDisent: lignes.slice(0, 6), chiffreJuste: chiffre.length > 0,
      ditPourquoi: new RegExp(`autoris[^\\n]{0,80}${c.autorises}|${c.autorises}[^\\n]{0,80}autoris|${c.demande}[^\\n]{0,40}${c.autorises}`, "i").test(md + r.console),
      rienPresenteCommeTenu: !/Toutes les règles sont tenues/i.test(md) && !/toutes tenues/i.test(r.console) };
    dire(lignes.length > 0, `impossible : le rapport nomme le ${c.jour}, la nuit, les IDE (${lignes.length} ligne(s))`);
    dire(chiffre.length > 0, `impossible : il chiffre le manque mesuré (${mesure?.manque})`);
    dire(e.impossible.ditPourquoi, `impossible : il dit pourquoi (${c.demande} demandés, ${c.autorises} IDE autorisés de nuit présents)`);
    dire(e.impossible.rienPresenteCommeTenu, "impossible : rien n'est présenté comme tout tenu");
  }
}
res.faussesAffirmations = res.affirmations.filter((a) => !a.vrai).length;

// ================================================================== 4. valeurs du monde écrites en dur
titre("valeurs en dur");
{
  const src = join(partage, "src");
  const fichiers = readdirSync(src).filter((f) => /\.(m?js|ts|html)$/.test(f));
  const noms = [...new Set(F.soignants.flatMap((s) => [s.prenom, s.nom]))];
  const motifs = [
    ["identifiant de soignant", /\bS\d{2}\b/], ["date de la période", /\b2026-1[01]-\d\d\b/], ["nom du service", /Sarrat/i],
    ["horaire de postes.csv", /\b(06:45|14:15|13:45|21:15|21:00|07:00)\b/], ["prénom ou nom de soignants.csv", new RegExp(`(?<![\\p{L}])(${noms.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\p{L}])`, "u")],
    ["seuil de regles.csv ou effectif", /(?<![\w.#-])(11|36|48|7\.5|35|46|28|1288)(?![\w.%])/], ["ligne de planning écrite", /[A-Z]\d{2},\d{4}-\d\d-\d\d,[A-Z]/],
  ];
  // faux positifs, relus un par un et justifiés (la règle : distinguer un vrai défaut d'une taille CSS)
  const lu = [];
  for (const f of fichiers) {
    const lignes = readFileSync(join(src, f), "utf8").split("\n");
    let css = false;
    lignes.forEach((l, i) => {
      if (/<style/.test(l)) css = true; if (/<\/style/.test(l)) { css = false; return; }
      const code = l.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "").replace(/^\s*\*.*$/, "");
      for (const [quoi, re] of motifs) {
        if (!re.test(code)) continue;
        let verdict = "à lire", raison = "";
        if (css || /\d(px|em|rem|%|mm|s)\b|font|rgba|letter-spacing|z-index|line-height/.test(code)) { verdict = "faux positif"; raison = "taille ou style CSS"; }
        else if (/1288/.test(code)) { verdict = "défaut mineur"; raison = "46 × 28 = 1288, la taille du monde fourni, sert d'étalon au budget d'itérations du solveur : n'affecte aucune règle, mais c'est une valeur du monde fourni dans le code"; }
        else if (/L\.push\(|'- \*\*|RAPPORT|console\./.test(code)) { verdict = "faux positif"; raison = "texte du rapport ou message"; }
        lu.push({ fichier: f, ligne: i + 1, quoi, texte: code.trim().slice(0, 160), verdict, raison });
      }
    });
  }
  // identifiants de postes : le format de la mission les nomme (M, S, N) ; on les liste à part
  const postesEnDur = [];
  for (const f of fichiers) readFileSync(join(src, f), "utf8").split("\n").forEach((l, i) => { const c = l.replace(/\/\/.*$/, ""); if (/===\s*'(N|S|M)'|'(N|S)'\s*\|\|/.test(c)) postesEnDur.push(`${f}:${i + 1} ${c.trim().slice(0, 110)}`); });
  res.valeursEnDur = { constats: lu, postesParIdentifiant: postesEnDur,
    lecture: "le format fixe M, S, N (mission : « trois postes (M, S, N) ») ; le code reconnaît la nuit par le passage de minuit OU l'id N, mais le soir par l'id S (solveur.js, rapport.js) — un monde aux postes renommés perdrait l'équité des soirs, pas les règles" };
  for (const x of lu) dire(x.verdict === "faux positif", `${x.fichier}:${x.ligne} ${x.quoi} — ${x.verdict}${x.raison ? " (" + x.raison + ")" : ""} : ${x.texte.slice(0, 90)}`);
  console.log(`identifiants de postes comparés en dur : ${postesEnDur.length}`);
}

// ================================================================== 5. la page
titre("la page");
const navigateur = await chromium.launch({ executablePath, headless: true });
async function ouvrir(fichier, contexte = {}) {
  const ctx = await navigateur.newContext({ viewport: { width: 1920, height: 1080 }, offline: true, ...contexte });
  const reseau = [];
  await ctx.route("**/*", (r) => (r.request().url().startsWith("file:") ? r.continue() : (reseau.push(r.request().url()), r.abort())));
  const page = await ctx.newPage();
  const erreurs = [];
  page.on("pageerror", (e) => erreurs.push(e.message.split("\n")[0]));
  page.on("console", (m) => { if (m.type() === "error") erreurs.push(m.text().slice(0, 160)); });
  await page.goto(pathToFileURL(fichier).href, { waitUntil: "load" });
  await page.waitForTimeout(700);
  return { ctx, page, erreurs, reseau };
}
const onglet = async (page, re) => { const b = page.locator("button, [role=tab], a").filter({ hasText: re }).first(); await b.click(); await page.waitForTimeout(250); };
const nomDe = (s) => `${s.nom} ${s.prenom}`;
const P = res.page;
try {
  const { ctx, page, erreurs, reseau } = await ouvrir(join(partage, "index.html"));
  P.erreurs = erreurs; P.requetesReseau = reseau;
  dire(!erreurs.length, `la page s'ouvre en file://, réseau coupé, sans erreur${erreurs.length ? " : " + erreurs[0] : ""}`);
  dire(!reseau.length, `aucune requête réseau${reseau.length ? " : " + reseau[0] : ""}`);
  await page.screenshot({ path: join(sortie, "page-1920-ensemble.png"), fullPage: true });
  // vue d'ensemble : un soignant par ligne, un jour par colonne ; on compare chaque case au planning
  const grille = await page.evaluate(() => {
    const t = [...document.querySelectorAll("table")].sort((a, b) => b.rows.length - a.rows.length)[0];
    const lignes = [...t.rows].filter((r) => r.cells.length > 20 && r.querySelector("th") && r.querySelectorAll("td").length > 20 && !/—/.test(r.cells[0].innerText));
    const tete = [...t.rows].find((r) => [...r.cells].filter((c) => /\d/.test(c.innerText)).length > 20);
    const we = tete ? [...tete.cells].slice(1).map((c) => c.className) : [];
    return { lignes: lignes.map((r) => ({ nom: r.cells[0].innerText.replace(/\s*\d+\s*%\s*$/, "").trim(), cases: [...r.querySelectorAll("td")].map((c) => c.innerText.trim()), classes: [...r.querySelectorAll("td")].map((c) => c.className + " " + c.innerHTML.match(/class="[^"]*"/g)?.join(" ")), titres: [...r.querySelectorAll("td")].map((c) => c.title) })), we };
  });
  const parNom = new Map(F.soignants.map((s) => [nomDe(s), s]));
  const attendu = new Map(livre.map((a) => [`${a.soignant}|${a.jour}`, a.poste]));
  let justes = 0, fausses = [], lignesLues = 0, voeuxMarques = 0;
  for (const l of grille.lignes) {
    const s = parNom.get(l.nom); if (!s) continue; lignesLues++;
    l.cases.slice(0, F.jours.length).forEach((c, d) => {
      const j = F.jours[d], p = attendu.get(`${s.id}|${j}`);
      const vu = /^[MSN]/.test(c) ? c[0] : /^A/.test(c) ? "A" : "-";
      const doit = p ?? (F.absent.get(s.id).has(j) ? "A" : "-");
      if (vu === doit) justes++; else fausses.push(`${s.id} ${j} vu ${c} attendu ${doit}`);
    });
    voeuxMarques += l.classes.filter((c) => /v(oe|œ)u|souhait|wish/i.test(c)).length + l.titres.filter((t) => /v(oe|œ)u/i.test(t)).length;
  }
  P.ensemble = { lignesLues, soignants: F.soignants.length, casesJustes: justes, casesFausses: fausses.length, exemples: fausses.slice(0, 5), voeuxMarques, voeuxTotal: F.voeux.length,
    weekendsDistingues: new Set(grille.we.filter((_, i) => [0, 6].includes(dow(F.jours[i] ?? F.jours[0])))).size > 0 && grille.we.some((c, i) => [0, 6].includes(dow(F.jours[i])) && c !== grille.we[0]) };
  dire(lignesLues === F.soignants.length && !fausses.length, `vue d'ensemble : ${lignesLues}/${F.soignants.length} lignes, ${justes} cases justes, ${fausses.length} fausses`);
  dire(voeuxMarques >= F.voeux.length * 0.9, `vœux marqués dans la grille : ${voeuxMarques} pour ${F.voeux.length} vœux`);
  dire(P.ensemble.weekendsDistingues, "les week-ends ont une classe à eux dans l'en-tête");
  // une semaine
  const avant = await page.evaluate(() => [...document.querySelectorAll("th")].filter((c) => c.offsetParent && /^\D{2,4}\s*\n?\s*\d\d$/.test(c.innerText.trim())).length);
  const bs = page.locator("button").filter({ hasText: /^S2$/ });
  if (await bs.count()) {
    await bs.first().click(); await page.waitForTimeout(300);
    const apres = await page.evaluate(() => [...document.querySelectorAll("th")].filter((c) => c.offsetParent && /^\D{2,4}\s*\n?\s*\d\d$/.test(c.innerText.trim())).length);
    const texteS2 = await page.evaluate(() => [...document.querySelectorAll("th")].filter((c) => c.offsetParent && /^\D{2,4}\s*\n?\s*\d\d$/.test(c.innerText.trim())).map((c) => c.innerText.replace(/\s+/g, " ")).join(" "));
    P.semaine = { colonnesAvant: avant, colonnesApres: apres, jours: texteS2 };
    dire(apres === 7 && /lun 09/.test(texteS2), `une semaine : ${avant} colonnes → ${apres} (${texteS2})`);
    await page.screenshot({ path: join(sortie, "page-1920-semaine2.png"), fullPage: true });
  } else { P.semaine = { trouve: false }; dire(false, "aucun bouton de semaine trouvé"); }
  // un soignant : le premier par ordre d'identifiant, avec son absence
  const s1 = F.parId.get("S01"), m1 = verLivre.personnes.S01;
  await onglet(page, /soignant/i);
  const sel = page.locator("select:visible").first();
  const opt = await sel.locator("option").evaluateAll((os, n) => os.find((o) => o.textContent.includes(n))?.value, nomDe(s1));
  if (opt != null) await sel.selectOption(opt);
  await page.waitForTimeout(300);
  const tS = (await page.innerText("main")).replace(/[\s  ]+/g, " ");
  const f = (x) => String(x).replace(".", ",");
  P.soignant = { qui: s1.id, planifie: m1.planifie, du: m1.du, nuits: m1.nuits, voit: { heures: tS.includes(`${f(m1.planifie)} h planifiées`), dues: tS.includes(`${f(m1.du)} h dues`), nuits: new RegExp(`${m1.nuits} nuits`).test(tS), weekends: /week-ends/.test(tS), voeux: /v(œ|oe)ux?/i.test(tS) } };
  dire(Object.values(P.soignant.voit).every(Boolean), `un soignant (${s1.id}) : ${JSON.stringify(P.soignant.voit)}`);
  await page.screenshot({ path: join(sortie, "page-1920-soignant.png"), fullPage: true });
  // un jour : le 12, chaque affecté y est, par poste
  const j12 = F.jours[10];
  await onglet(page, /par jour/i);
  const selJ = page.locator("select:visible").first();
  const optJ = await selJ.locator("option").evaluateAll((os, j) => os.find((o) => o.value === j || o.textContent.includes(String(+j.slice(8)) + " novembre"))?.value, j12);
  if (optJ != null) await selJ.selectOption(optJ);
  await page.waitForTimeout(300);
  const tJ = (await page.innerText("main")).replace(/[\s  ]+/g, " ");
  const la = livre.filter((a) => a.jour === j12).map((a) => nomDe(F.parId.get(a.soignant)));
  const manquants = la.filter((n) => !tJ.includes(n));
  P.jour = { jour: j12, affectes: la.length, absentsDeLaVue: manquants, etatEffectif: /complet|atteint|manque/i.test(tS + tJ) };
  dire(!manquants.length && P.jour.etatEffectif, `un jour (${j12}) : ${la.length - manquants.length}/${la.length} affectés visibles, état des effectifs affiché`);
  await page.screenshot({ path: join(sortie, "page-1920-jour.png"), fullPage: true });
  // l'équité
  await onglet(page, /équité|equite/i);
  const tE = (await page.innerText("main")).replace(/[\s  ]+/g, " ");
  const eIDE = mesLivre.equite.IDE.nuits;
  P.equite = { nuits: /nuits/i.test(tE), weekends: /week-ends/i.test(tE), soirs: /soir/i.test(tE), ecart: /écart|étendue|max.{0,3}min/i.test(tE), extrait: tE.slice(tE.search(/Équité entre/), tE.search(/Équité entre/) + 700) };
  dire(P.equite.nuits && P.equite.weekends && P.equite.soirs && P.equite.ecart, `l'équité : nuits ${P.equite.nuits}, week-ends ${P.equite.weekends}, soirs ${P.equite.soirs}, écart ${P.equite.ecart}`);
  await page.screenshot({ path: join(sortie, "page-1920-equite.png"), fullPage: true });
  await onglet(page, /conformit/i);
  await page.screenshot({ path: join(sortie, "page-1920-conformite.png"), fullPage: true });
  await ctx.close();

  // téléphone : aucune vue ne fait défiler la page de côté
  const tel = await ouvrir(join(partage, "index.html"), { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  P.telephone = { erreurs: tel.erreurs, vues: {} };
  for (const [nom, re] of [["ensemble", /ensemble/i], ["soignant", /soignant/i], ["jour", /par jour/i], ["equite", /équité/i], ["conformite", /conformit/i]]) {
    await onglet(tel.page, re);
    const m = await tel.page.evaluate(() => ({ page: document.documentElement.scrollWidth, fenetre: window.innerWidth, corps: document.body.scrollWidth }));
    P.telephone.vues[nom] = m;
    m.deborde = m.page > 391;
    dire(!m.deborde, `téléphone 390, vue ${nom} : largeur ${m.page} pour 390`);
    await tel.page.screenshot({ path: join(sortie, `page-390-${nom}.png`), fullPage: nom !== "ensemble" });
  }
  await tel.ctx.close();

  // A3 paysage : le PDF, et le rendu à la taille d'une feuille pour voir si la grille tient dans la largeur
  const imp = await ouvrir(join(partage, "index.html"), { viewport: { width: 1587, height: 1123 } });
  await imp.page.emulateMedia({ media: "print" });
  await imp.page.waitForTimeout(300);
  const mesA3 = await imp.page.evaluate(() => { const t = [...document.querySelectorAll("table")].sort((a, b) => b.rows.length - a.rows.length)[0]; const r = t.getBoundingClientRect(); return { largeurGrille: Math.round(r.width), largeurPage: window.innerWidth, hauteurGrille: Math.round(r.height), police: getComputedStyle(t.querySelector("td")).fontSize }; });
  await imp.page.screenshot({ path: join(sortie, "page-a3-ecran-impression.png"), fullPage: false });
  const pdf = join(sortie, "page-a3-paysage.pdf");
  await imp.page.pdf({ path: pdf, format: "A3", landscape: true, printBackground: true });
  const nbPages = (readFileSync(pdf, "latin1").match(/\/Type\s*\/Page(?!s)/g) || []).length;
  try { execFileSync("pdftoppm", ["-r", "50", "-png", pdf, join(sortie, "page-a3-paysage")], { stdio: "ignore" }); }
  catch { try { execFileSync("sips", ["-s", "format", "png", pdf, "--out", join(sortie, "page-a3-paysage-1.png")], { stdio: "ignore" }); } catch {} }
  const utile = 1123 - 2 * 34; // hauteur d'une feuille A3 paysage à 96 ppp, moins les marges de 9 mm
  P.a3 = { ...mesA3, pagesPdf: nbPages, hauteurUtile: utile, grilleSurUneFeuille: mesA3.largeurGrille <= mesA3.largeurPage && mesA3.hauteurGrille <= utile };
  dire(mesA3.largeurGrille <= mesA3.largeurPage, `A3 paysage : grille ${mesA3.largeurGrille} px de large pour ${mesA3.largeurPage}, police ${mesA3.police}, ${nbPages} page(s) de PDF`);
  dire(P.a3.grilleSurUneFeuille, `A3 paysage : la grille (${mesA3.hauteurGrille} px de haut) tient sur une feuille (${utile} px utiles)`);
  await imp.ctx.close();

  // la page d'un autre monde montre l'autre planning ; celle du monde impossible montre ses manques
  for (const [nom, M, pl] of [["a-autre-service", MA, runs["a-autre-service"]?.planning], ["b-impossible", MB, runs["b-impossible"]?.planning]]) {
    const f2 = join(sortie, "sorties", nom, "index.html"); if (!existsSync(f2)) { dire(false, `${nom} : pas de page`); continue; }
    const o = await ouvrir(f2);
    const t = (await o.page.innerText("body")).replace(/[\s  ]+/g, " ");
    const g = await o.page.evaluate(() => [...document.querySelectorAll("table")].sort((a, b) => b.rows.length - a.rows.length)[0].rows.length);
    const x = { erreurs: o.erreurs, lignesGrille: g, soignants: M.soignants.length, nomsDuMonde: M.soignants.filter((s) => t.includes(nomDe(s))).length, nomsDuFourni: F.soignants.filter((s) => t.includes(nomDe(s)) && !M.parId.has(s.id)).length };
    if (nom === "b-impossible") {
      const c = B.cible;
      x.banniere = /impossible|ne tient pas|manque/i.test(t.slice(0, 3000));
      x.toutTenu = /Toutes les règles tenues/i.test(t);
      await onglet(o.page, /par jour/i);
      const s2 = o.page.locator("select:visible").first();
      const v = await s2.locator("option").evaluateAll((os, j) => os.find((q) => q.value === j || q.textContent.includes(String(+j.slice(8)) + " novembre"))?.value, c.jour);
      if (v != null) await s2.selectOption(v);
      await o.page.waitForTimeout(300);
      const tj = (await o.page.innerText("main")).replace(/[\s  ]+/g, " ");
      x.jourCible = tj.slice(tj.search(/Poste N/), tj.search(/Poste N/) + 220);
      await o.page.screenshot({ path: join(sortie, "page-impossible-jour.png"), fullPage: true });
      await onglet(o.page, /conformit/i);
      await o.page.screenshot({ path: join(sortie, "page-impossible-conformite.png"), fullPage: true });
      dire(x.banniere && !x.toutTenu, `page du monde impossible : bandeau ${x.banniere}, « toutes tenues » ${x.toutTenu} ; jour ${c.jour} : ${x.jourCible.slice(0, 160)}`);
    } else {
      await o.page.screenshot({ path: join(sortie, "page-a-autre-service.png"), fullPage: true });
      dire(x.nomsDuMonde === M.soignants.length && !x.nomsDuFourni, `page du monde (a) : ${x.nomsDuMonde}/${M.soignants.length} noms de ce monde, ${x.nomsDuFourni} du monde fourni`);
    }
    P[nom] = x; await o.ctx.close();
  }
} finally { await navigateur.close(); }

// ================================================================== 6. bun test, mode d'emploi, rapport
titre("bun test");
{
  const r = spawnSync("bun", ["test"], { cwd: copie, encoding: "utf8", timeout: 900000 });
  const txt = (r.stdout || "") + (r.stderr || "");
  const pass = +(txt.match(/(\d+) pass/)?.[1] ?? 0), fail = +(txt.match(/(\d+) fail/)?.[1] ?? 0);
  res.bunTest = { code: r.status, pass, fail, fin: txt.slice(-600) };
  dire(r.status === 0 && fail === 0, `bun test : ${pass} verts, ${fail} rouges (code ${r.status})`);
}
titre("mode d'emploi");
{
  const me = readFileSync(join(partage, "MODE-D-EMPLOI.md"), "utf8");
  const ra = runs["a-autre-service"];
  res.modeEmploi = { commandeEcrite: me.match(/node src\/main\.js <dossier_donnees> \[dossier_sortie\] \[--graine=N\]/)?.[0] ?? null, rejoueeSurA: ra?.commande, code: ra?.code,
    fichiers: ra ? ["planning.csv", "index.html", "RAPPORT.md"].filter((f) => existsSync(join(ra.out, f))) : [],
    graineParDefaut: /par défaut 42/.test(me), graineDuLivre: "la page livrée dit « graine 1 » ; le mode d'emploi ne dit pas avec quelle graine planning.csv a été produit" };
  dire(ra?.code === 0 && res.modeEmploi.fichiers.length === 3, `le mode d'emploi, rejoué tel qu'écrit sur le monde (a) : code ${ra?.code}, ${res.modeEmploi.fichiers.join(", ")}`);
}

res.resume = {
  livre: verLivre.total, fourniDefaut: res.mondes["fourni-defaut"]?.total, a: res.mondes["a-autre-service"]?.total, impossible: res.mondes["b-impossible"]?.violations, double: res.mondes["c-double"]?.total,
  tempsDouble: res.mondes["c-double"]?.dureeMs, tempsFourni: res.mondes["fourni-defaut"]?.dureeMs, faussesAffirmations: res.faussesAffirmations,
};
writeFileSync(join(sortie, "juge-hopital.json"), JSON.stringify(res, null, 1));
console.log(`\nfausses affirmations : ${res.faussesAffirmations} — ${res.affirmations.filter((a) => !a.vrai).map((a) => `[${a.monde}] ${a.quoi}`).join(" ; ")}`);
console.log(`écrit : ${join(sortie, "juge-hopital.json")}`);
