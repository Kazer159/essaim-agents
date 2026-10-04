// Les preuves (rôles des agents) : le premier acte, le reçu du lanceur. Le lanceur prend une
// demande de rejeu dans sa file (T.prendreRejeux), relit les octets du banc, du monde et du produit, rejoue la commande
// dans partage/ sous le bac à sable de contrôle (partage/ en lecture seule, le bureau privé du gardien lisible : ses cas
// réservés sont souvent le banc), écrit le reçu dans runs/<run>/preuves/<n>.json, que les agents ne peuvent pas écrire,
// puis conclut : une alerte se ferme par ce reçu seul.
// Empreintes : le blob git (sha1 de l'en-tête et du contenu entier), comme la reproduction figée d'une alerte et les
// faits du second cerveau. Une seule méthode, donc aucune conversion pour comparer ; chaque octet est relu à chaque
// fois, sans le cache taille/date de memoire.ts.
// Chargé aussi sous Node (l'extension lit les reçus et leur péremption) : le lancement de la commande (Bun.spawn, bac à
// sable) n'est importé que dans rejouer, qui ne tourne que dans le lanceur.
import { createHash } from "node:crypto";
import { type Dirent, existsSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { BRANCHE, contenuDans } from "./depot.ts";
import * as M from "./memoire.ts";
import * as T from "./tableau.ts";

export type Empreintes = Record<string, string>;
export type Recu = {
  n: number; demande: number; sorte: "alerte" | "exigence"; ticket?: number; exigence?: string; motif?: "corrige" | "invalide"; demandeur: string;
  commande: string; graine: string | null; commit: string | null;
  // Ce qui a changé depuis la reproduction (l'alerte, ou la demande d'une preuve d'exigence) : les mêmes conditions,
  // c'est deux listes vides.
  conditions: { banc: string[]; monde: string[] };
  // Relevées avant le rejeu. banc : chemins absolus ; monde : relatifs à <run>/entrees/ ; produit : relatifs à partage/.
  empreintes: { banc: Empreintes; monde: Empreintes; produit: Empreintes };
  code: number | null; coupe?: string; sortie: string; dureeMs: number; date: string; passe: boolean; texte: string;
  // Le reçu attesté que le lanceur a rejoué de lui-même, et ce qui avait changé depuis (produit, monde).
  rejoue?: string; depuis?: string[];
};

export const cheminRecu = (n: number) => `preuves/${n}.json`;
const SORTIE_MAX = 4000;
const DELAI_MS = 120_000; // comme la vérification de la mission en fin de run

// Les fichiers, et les liens : la commande rejouée les suit ; sans eux dans l'empreinte, un produit
// changé à travers un lien garderait son attestation. Un lien compte par sa cible écrite et, vers un fichier, par son contenu.
const blobs = (racine: string): Empreintes => ({ ...Object.fromEntries([...M.empreintes(racine)].map(([rel, e]) => [rel, e.blob])), ...liens(racine) });
function liens(racine: string, rel = "", r: Empreintes = {}): Empreintes {
  let entrees: Dirent[];
  try { entrees = readdirSync(join(racine, rel), { withFileTypes: true }); } catch { return r; }
  for (const x of entrees) {
    const sous = rel ? `${rel}/${x.name}` : x.name, abs = join(racine, sous);
    if (x.isSymbolicLink()) {
      let v = `lien ${readlinkSync(abs)}`;
      try { if (statSync(abs).isFile()) v += ` ${M.blobGit(readFileSync(abs))}`; } catch { /* cible absente */ }
      r[sous] = v;
    } else if (x.isDirectory() && x.name !== ".git" && x.name !== "node_modules") liens(racine, sous, r);
  }
  return r;
}
// Un fichier absent n'a pas d'empreinte : il compte comme changé.
function releverBanc(chemins: string[]): Empreintes {
  const r: Empreintes = {};
  for (const c of chemins) { try { r[c] = M.blobGit(readFileSync(c)); } catch { /* absent */ } }
  return r;
}
const ecarts = (avant: Empreintes, apres: Empreintes) =>
  [...new Set([...Object.keys(avant), ...Object.keys(apres)])].filter((k) => avant[k] !== apres[k]).sort();

// Rejoue une demande et écrit son reçu (n = numéro de la demande, jamais réécrit). delaiMs : au-delà, la commande est
// coupée. sansBacASable : tests au faux pi seulement, comme pour pi.
// prive : le bureau privé du gardien quand le demandeur n'est pas lui : le rejeu d'un autre l'ouvrirait en lecture
// comme en écriture, et sa sortie finirait dans un reçu que tous lisent.
export async function rejouer(d: T.DemandeRejeu, runDir: string, o: { sansBacASable?: boolean; delaiMs?: number; prive?: string } = {}): Promise<Recu> {
  const fichier = join(runDir, cheminRecu(d.id));
  if (existsSync(fichier)) throw new Error(`le reçu ${cheminRecu(d.id)} existe déjà`);
  const { bacASable, envSansIdentifiants, SANS_PRIVE, tuerGroupe } = await import("./processus.ts");
  const partage = join(runDir, "partage");
  const r = d.reproduction;
  const empreintes = { banc: releverBanc(Object.keys(r.banc)), monde: blobs(join(runDir, "entrees")), produit: blobs(partage) };
  const c = await contenuDans(partage, BRANCHE);
  const commit = "hash" in c ? c.hash : null;
  const sh = ["/bin/sh", "-c", d.commande];
  const env = envSansIdentifiants(runDir);
  delete env.GRAINE;
  if (d.graine !== null) env.GRAINE = d.graine;
  const debut = Date.now();
  const proc = Bun.spawn(o.sansBacASable ? sh : bacASable(runDir, sh, { profil: "controle", prive: o.prive ?? SANS_PRIVE }),
    { cwd: partage, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true, env });
  const sorties = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  let termine = false;
  void proc.exited.then(() => { termine = true; });
  let coupe: string | undefined;
  while (!termine) {
    if (Date.now() - debut > (o.delaiMs ?? DELAI_MS)) { coupe = "coupé : délai dépassé"; await tuerGroupe(proc.pid, 1000); break; }
    await Bun.sleep(20);
  }
  await proc.exited;
  await tuerGroupe(proc.pid, 1000); // ce que la commande a laissé en fond tiendrait la sortie, et la file des rejeux
  const [out, err] = await sorties;
  const brute = (out + err).trim();
  const code = coupe ? null : proc.exitCode;
  const passe = code === 0;
  const conditions = { banc: ecarts(r.banc, empreintes.banc), monde: ecarts(r.monde, empreintes.monde) };
  const depuis = d.ticket !== null ? "depuis l'alerte" : d.rejoue ? "depuis le reçu rejoué" : "depuis la demande";
  const ancien = d.rejoue ? lireRecu(runDir, d.rejoue) : undefined;
  const changesDepuis = ancien ? ecartsDe(ancien.empreintes, empreintes) : undefined;
  const changees = [...conditions.banc.map((b) => `banc ${b}`), ...conditions.monde.map((m) => `monde ${m}`)];
  const texte = [cheminRecu(d.id), passe ? "passe (code 0)" : coupe ?? `ne passe pas (code ${code})`, `produit au commit ${commit?.slice(0, 7) ?? "inconnu"}`,
    d.graine !== null ? `graine ${d.graine}` : "sans graine", ...(changees.length ? [`conditions changées ${depuis} : ${changees.join(", ")}`] : []),
    ...(d.rejoue ? [`rejeu de ${d.rejoue} par le lanceur`] : [])].join(" · ");
  const recu: Recu = {
    n: d.id, demande: d.id, sorte: d.ticket !== null ? "alerte" : "exigence",
    ...(d.ticket !== null ? { ticket: d.ticket } : {}), ...(d.exigence !== null ? { exigence: d.exigence } : {}), ...(d.motif ? { motif: d.motif } : {}),
    demandeur: d.demandeur, commande: d.commande, graine: d.graine, commit, conditions, empreintes,
    code, ...(coupe ? { coupe } : {}), sortie: brute.length > SORTIE_MAX ? brute.slice(0, SORTIE_MAX) + "…" : brute,
    dureeMs: Date.now() - debut, date: new Date().toISOString(), passe, texte,
    ...(d.rejoue ? { rejoue: d.rejoue, depuis: changesDepuis ?? [] } : {}),
  };
  writeFileSync(fichier, JSON.stringify(recu, null, 2) + "\n", { flag: "wx" });
  return recu;
}

// Sorties incomplètes : la reproduction d'une alerte jouée une fois à l'ouverture, par l'outil,
// dans le bac à sable de l'agent qui l'ouvre (déjà enveloppé : pas de second bac à sable). Elle doit échouer tant que le
// défaut est là, puisque corrige ferme l'alerte quand le rejeu passe ; code 0 = sens inversé. Sous node (pi) comme sous
// Bun : child_process. coupe : délai dépassé, on ne sait pas trancher.
export async function essayerReproduction(partage: string, commande: string, graine: string | null, delaiMs = Number(process.env.ESSAIM_ESSAI_REPRO_MS ?? DELAI_MS)):
  Promise<{ code: number | null; coupe: boolean }> {
  const { spawn } = await import("node:child_process");
  const env = { ...process.env };
  delete env.GRAINE;
  if (graine !== null) env.GRAINE = graine;
  const proc = spawn("/bin/sh", ["-c", commande], { cwd: partage, stdio: "ignore", detached: true, env });
  return await new Promise((fini) => {
    let coupe = false;
    const minuterie = setTimeout(() => { coupe = true; try { process.kill(-proc.pid!, "SIGKILL"); } catch { /* déjà parti */ } }, delaiMs);
    proc.on("error", () => { clearTimeout(minuterie); fini({ code: 127, coupe: false }); });
    proc.on("exit", (code) => { clearTimeout(minuterie); fini(coupe ? { code: null, coupe: true } : { code, coupe: false }); });
  });
}

// Un reçu du registre, par son numéro (« 4 »), son nom (« 4.json ») ou son chemin (« preuves/4.json », absolu) ;
// undefined hors du registre ou illisible.
export function lireRecu(runDir: string, ref: string): Recu | undefined {
  const nom = basename(ref.trim()).replace(/\.json$/, "");
  if (!/^\d+$/.test(nom)) return undefined;
  const brut = ref.trim();
  if (brut.includes("/") && resolve(runDir, brut) !== resolve(runDir, cheminRecu(Number(nom)))) return undefined;
  try { return JSON.parse(readFileSync(join(runDir, cheminRecu(Number(nom))), "utf8")) as Recu; } catch { return undefined; }
}

// Périmé : une empreinte du banc, du monde ou du produit a changé depuis le reçu. Les octets sont relus ; un
// fichier réécrit à l'identique ne périme rien.
// actuel : le monde et le produit relevés une fois pour plusieurs reçus (preuve_lister).
export function perime(recu: Recu, runDir: string, actuel = releverActuel(runDir)): { perime: boolean; changes: string[] } {
  const e = recu.empreintes;
  const changes = [...ecarts(e.banc, releverBanc(Object.keys(e.banc))).map((c) => `banc ${c}`), ...ecartsDe(e, actuel)];
  return { perime: changes.length > 0, changes };
}
// Le monde et le produit changés entre deux relevés, lisibles : « monde x », « produit y ».
const ecartsDe = (avant: { monde: Empreintes; produit: Empreintes }, apres: { monde: Empreintes; produit: Empreintes }) =>
  [...ecarts(avant.monde, apres.monde).map((c) => `monde ${c}`), ...ecarts(avant.produit, apres.produit).map((c) => `produit ${c}`)];
export type Actuel = { monde: Empreintes; produit: Empreintes };
export const releverActuel = (runDir: string): Actuel => ({ monde: blobs(join(runDir, "entrees")), produit: blobs(join(runDir, "partage")) });
// L'état du produit et du monde en une empreinte : un rejeu du lanceur par couple (reçu, état).
export const cleProduit = (a: Actuel) =>
  createHash("sha1").update(JSON.stringify([Object.entries(a.monde).sort(), Object.entries(a.produit).sort()])).digest("hex");

// Le contrôle du gardien (sinon une exigence peut être attestée sur un test écrit par un constructeur, sur des mondes
// inventés par l'équipe) : un reçu repose sur son bureau privé si son banc y compte un fichier, ou si sa
// commande nomme un fichier ou un dossier qui s'y trouve, relatif au dossier partagé où le lanceur la rejoue. Les chemins
// sont suivis jusqu'au bout : un lien du bureau vers le dossier partagé n'y compte pas. Lu du reçu seul (commande, banc) :
// un reçu que le lanceur rejoue garde les deux, et reste donc appuyé sur le même bureau.
export function reposeSurPrive(recu: Pick<Recu, "commande" | "empreintes">, prive: string, partage: string): boolean {
  let racine: string;
  try { racine = realpathSync(prive); } catch { return false; }
  const mots = recu.commande.split(/[\s;|&()<>'"`=,]+/).filter(Boolean).map((m) => resolve(partage, m.startsWith("~/") ? join(homedir(), m.slice(2)) : m));
  return [...Object.keys(recu.empreintes.banc), ...mots].some((c) => {
    try { const r = realpathSync(c); return r === racine || r.startsWith(racine + "/"); } catch { return false; }
  });
}

// L'état prouvé des exigences actives : attestée (reçu non périmé), à rejouer (le produit ou le monde a
// changé depuis le reçu signé, pas le banc : le lanceur le rejoue lui-même), rejeu échoué (ce rejeu, sur le produit
// d'aujourd'hui, ne passe pas ou est tombé en panne), périmée (le banc a changé : la mesure elle-même n'est plus la
// même), non vérifiée (déclarée par le siège responsable), ou à prouver. Une appréciation n'y change rien. Lu par
// preuve_lister, par le lanceur (jugement, ronde) et par la vue.
// Les jalons : deux listes. Les feuilles (jalons actifs, exigences non découpées) se
// prouvent et se rejouent ; les exigences de premier niveau (sans parent) sont celles que le run doit tenir, une découpée
// prenant l'état calculé de ses jalons. jalons : le compte et les feuilles d'une découpée.
export type EtatExigence = { libelle: string; classement: string; responsable: T.Responsable;
  etat: "attestee" | "a_rejouer" | "rejeu_echoue" | "perimee" | "non_verifiee" | "a_prouver";
  attestation?: T.Attestation; changes?: string[]; rejeu?: { demande: number; recu: string | null; texte: string };
  jalons?: { attestes: number; total: number; restants: string[]; feuilles: EtatExigence[] } };
// L'état d'une découpée : attestée si chacun de ses jalons l'est ; sinon le premier état présent dans cet ordre.
const PIRE: EtatExigence["etat"][] = ["rejeu_echoue", "perimee", "non_verifiee", "a_prouver", "a_rejouer"];
// L'état tel que les agents et le bilan le lisent (une seule table).
export const LIBELLES_ETAT: Record<EtatExigence["etat"], string> = { attestee: "attestée", a_rejouer: "à rejouer", rejeu_echoue: "rejeu échoué", perimee: "périmée", non_verifiee: "non vérifiée", a_prouver: "à prouver" };
// L'avancée d'une exigence découpée : « 2/4 jalons, reste E4.3, E4.4 ».
export const texteJalons = (j: { attestes: number; total: number; restants: string[] }) => `${j.attestes}/${j.total} jalons${j.restants.length ? `, reste ${j.restants.join(", ")}` : ""}`;
// Le pire état parmi des jalons, dans l'ordre de PIRE ; attestée s'il n'y en a aucun.
export const pireEtat = (etats: EtatExigence["etat"][]): EtatExigence["etat"] => PIRE.find((x) => etats.includes(x)) ?? "attestee";
export function etatDesExigences(t: T.Tableau, runDir: string, actuel = releverActuel(runDir)): EtatExigence[] {
  const feuilles = etatDesFeuilles(t, runDir, actuel);
  return T.listerExigences(t).filter((e) => !e.retiree && !e.parent).map((e) => {
    const jalons = T.jalonsDe(t, e.libelle);
    if (!T.estDecoupe(jalons)) return feuilles.find((f) => f.libelle === e.libelle)!;
    const siennes = jalons.map((j) => feuilles.find((f) => f.libelle === j.libelle)!);
    const attestes = siennes.filter((f) => f.etat === "attestee").length;
    const pire = siennes.find((f) => f.etat === pireEtat(siennes.map((x) => x.etat)));
    const compte = { attestes, total: siennes.length, restants: siennes.filter((f) => f.etat !== "attestee").map((f) => f.libelle), feuilles: siennes };
    return { libelle: e.libelle, classement: e.classement, responsable: e.responsable, etat: pire?.etat ?? "attestee",
      ...(pire ? { attestation: pire.attestation, changes: pire.changes, rejeu: pire.rejeu } : {}), jalons: compte };
  });
}
export function etatDesFeuilles(t: T.Tableau, runDir: string, actuel = releverActuel(runDir)): EtatExigence[] {
  let cle: string | undefined;
  return T.listerExigences(t).filter((e) => !e.retiree && !T.estDecoupee(t, e.libelle)).map((e) => {
    const base = { libelle: e.libelle, classement: e.classement, responsable: e.responsable };
    const a = T.attestationDe(t, e.libelle);
    if (!a) return { ...base, etat: "a_prouver" as const };
    // Le tableau est inscriptible par les agents ; une attestation n'y compte que si son
    // signataire tient vraiment le rôle responsable (lu dans les agents, pas dans la ligne) et, avec un reçu, si ce reçu du
    // registre fermé aux agents prouve cette exigence — les règles de preuve_attester, relues au moment de compter.
    const role = T.aColonne(t, "agents", "role") ? t.get<{ role: string | null }>("SELECT role FROM agents WHERE nom = ?", [a.agent])?.role : undefined;
    if (a.role !== e.responsable || role !== e.responsable)
      return { ...base, etat: "perimee" as const, attestation: a, changes: [`${a.agent} n'est pas ${e.responsable === "recette" ? "la recette" : "le gardien-mesureur"} : signature à refaire`] };
    if (a.non_verifiee) return { ...base, etat: "non_verifiee" as const, attestation: a };
    const recu = lireRecu(runDir, a.recu!);
    if (!recu) return { ...base, etat: "perimee" as const, attestation: a, changes: [`reçu ${a.recu} illisible`] };
    const faux = recu.sorte !== "exigence" || recu.exigence !== e.libelle ? `le reçu ${a.recu} porte sur ${recu.exigence ?? `l'alerte #${recu.ticket}`}`
      : !recu.passe ? `le reçu ${a.recu} ne passe pas`
      : a.role === "gardien" && !reposeSurPrive(recu, join(runDir, "agents", a.agent, "prive"), join(runDir, "partage")) ? `le reçu ${a.recu} ne repose sur aucun fichier du bureau privé de ${a.agent}`
      : undefined;
    if (faux) return { ...base, etat: "perimee" as const, attestation: a, changes: [`${faux} : signature à refaire`] };
    const p = perime(recu, runDir, actuel);
    if (!p.perime) return { ...base, etat: "attestee" as const, attestation: a };
    if (p.changes.some((c) => c.startsWith("banc "))) return { ...base, etat: "perimee" as const, attestation: a, changes: p.changes };
    const r = T.rejeuAttestation(t, cheminRecu(recu.n), cle ??= cleProduit(actuel));
    if (r?.etat === "faite" && !r.resultat.passe)
      return { ...base, etat: "rejeu_echoue" as const, attestation: a, changes: p.changes,
        rejeu: { demande: r.id, recu: r.recu, texte: r.resultat.panne ? `rejeu #${r.id} en panne, sans reçu : ${r.resultat.panne}` : r.resultat.texte ?? `rejeu #${r.id}` } };
    return { ...base, etat: "a_rejouer" as const, attestation: a, changes: p.changes };
  });
}

// Le lanceur rejoue lui-même les reçus attestés dont seul le produit ou le monde a changé : la même commande,
// la même graine, sur le dossier partagé du moment, par la même file que les demandes des agents. Dépose une demande par
// exigence à rejouer, une seule par couple (reçu, état du produit) ; rend les demandes à
// attendre. Déposé par preuve_lister et par le lanceur quand il juge le run.
export function demanderRejeux(t: T.Tableau, runDir: string): number[] {
  const actuel = releverActuel(runDir);
  const cle = cleProduit(actuel);
  const ids: number[] = [];
  for (const e of etatDesFeuilles(t, runDir, actuel)) { // les jalons se rejouent un par un, comme des exigences
    if (e.etat !== "a_rejouer") continue;
    const recu = lireRecu(runDir, e.attestation!.recu!)!;
    const reproduction: T.Reproduction = { commande: recu.commande, graine: recu.graine, commit: recu.commit ?? "", banc: recu.empreintes.banc, monde: recu.empreintes.monde };
    const id = T.demanderRejeuAttestation(t, { exigence: e.libelle, rejoue: cheminRecu(recu.n), cle, reproduction });
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

// La conclusion du lanceur : la demande est faite, avec son reçu. Pour une alerte : corrige ferme si le rejeu
// passe aux mêmes conditions et que le produit a changé depuis l'alerte ; invalide ferme si la contre-preuve passe aux
// mêmes conditions, et la note garde les deux conclusions ; sinon l'alerte reste ouverte, le reçu cité. L'annonce nomme
// le demandeur : un dormeur se réveille sur sa réponse.
// Un dormeur ne se réveille que sur un message qui le nomme : le reçu d'une preuve d'exigence, qu'aucun ticket
// n'annonce, est posté en le nommant quand le demandeur s'est endormi sans l'attendre (preuve_demander le rend sinon).
export function annoncerPreuve(t: T.Tableau, d: T.DemandeRejeu, quoi: string): void {
  if (d.ticket !== null || !t.get("SELECT 1 FROM agents WHERE nom = ? AND etat = 'dormant'", [d.demandeur])) return;
  T.poster(t, "essaim", `[preuve de ${d.exigence}] ${quoi} (demandée par ${d.demandeur})`, "principal");
}
const annonceRejeu = (d: T.DemandeRejeu) => (x: T.Ticket, quoi: string) => `[ticket #${x.id}] ${x.titre} : ${quoi} (rejeu demandé par ${d.demandeur})`;

export function conclure(t: T.Tableau, d: T.DemandeRejeu, recu: Recu): void {
  if (d.rejoue) return reporter(t, d, recu);
  const chemin = cheminRecu(recu.n);
  T.finirRejeu(t, d.id, chemin, { passe: recu.passe, code: recu.code, texte: recu.texte });
  if (d.ticket === null || !d.motif) return annoncerPreuve(t, d, `reçu ${recu.texte}`);
  const k = T.lireTicket(t, d.ticket);
  if (!k || k.etat === "ferme") return;
  const r = d.reproduction;
  const annonce = annonceRejeu(d);
  const memes = !recu.conditions.banc.length && !recu.conditions.monde.length;
  const change = recu.commit !== null && recu.commit !== r.commit;
  if (recu.passe && memes && (d.motif === "invalide" || change)) {
    const note = d.motif === "invalide" ? `deux conclusions gardées : l'alerte de ${k.auteur} (${r.commande}${r.graine !== null ? `, graine ${r.graine}` : ""}) ne passait pas, la contre-preuve de ${d.demandeur} (${d.commande}) passe` : undefined;
    if (T.majTicket(t, k.id, "essaim", { motif: d.motif, recu: chemin, note }, annonce).ok) return;
  }
  const pourquoi = recu.passe && memes && !change ? " · produit inchangé depuis l'alerte" : "";
  T.majTicket(t, k.id, "essaim", { note: `rejeu #${d.id} (${d.motif}) : ${recu.texte}${pourquoi} ; l'alerte reste ouverte` }, annonce);
}

// La conclusion d'un rejeu du lanceur. Il passe : l'attestation se reporte sur le nouveau reçu, au nom du même
// signataire et avec la même portée (elle dit que ce contrôle mesure l'exigence, et le contrôle n'a pas changé) ; un
// événement « report » le trace, le nouveau reçu cite l'ancien. Il échoue : l'exigence n'est plus attestée, et un message
// qui nomme le signataire le lui dit (sa ligne « pour toi »). Rien si l'attestation a changé entre-temps.
function reporter(t: T.Tableau, d: T.DemandeRejeu, recu: Recu): void {
  const chemin = cheminRecu(recu.n);
  T.finirRejeu(t, d.id, chemin, { passe: recu.passe, code: recu.code, texte: recu.texte });
  const a = T.attestationDe(t, d.exigence!);
  if (!a || a.recu !== d.rejoue) return;
  const depuis = recu.depuis?.length ? recu.depuis.join(", ") : "rien";
  if (!recu.passe) return signalerEchec(t, d, a, `${recu.texte} ; changé depuis ${d.rejoue} : ${depuis}`);
  // Le banc a changé entre le dépôt du rejeu et son exécution : le contrôle rejoué n'est plus celui qui a été
  // signé, son succès ne se reporte pas ; au signataire de signer à nouveau.
  if (recu.conditions.banc.length) return signalerEchec(t, d, a, `${recu.texte} ; le banc a changé (${recu.conditions.banc.join(", ")}), à signer de nouveau`);
  T.attester(t, { exigence: a.exigence, agent: a.agent, role: a.role, nature: a.nature, recu: chemin, portee: a.portee });
  T.ajouterEvenement(t, { agent: "lanceur", type: "report", resultat: `${a.exigence} : attestation de ${a.agent} reportée de ${d.rejoue} sur ${chemin}, rejoué par le lanceur ; changé depuis : ${depuis}` });
}
function signalerEchec(t: T.Tableau, d: T.DemandeRejeu, a: T.Attestation, quoi: string): void {
  T.ajouterEvenement(t, { agent: "lanceur", type: "rejeu_echoue", resultat: `${a.exigence} n'est plus attestée : ${quoi}` });
  T.poster(t, "essaim", `${a.agent} : ${a.exigence} n'est plus attestée. Le lanceur a rejoué ${d.rejoue}, que tu avais attesté, sur le produit du moment : ${quoi}`, "principal");
}

// Sert une demande prise : rejeu, reçu, conclusion. Une panne (dépôt illisible, reçu déjà là) rend la demande faite sans
// reçu : l'alerte reste ouverte ; le demandeur d'une preuve, ou le signataire d'un reçu rejoué par le lanceur, l'apprend.
async function servir(t: T.Tableau, d: T.DemandeRejeu, runDir: string, o: { sansBacASable?: boolean; delaiMs?: number }): Promise<void> {
  try {
    const gardien = T.aColonne(t, "agents", "role") ? t.get<{ nom: string }>("SELECT nom FROM agents WHERE role = 'gardien' ORDER BY rowid LIMIT 1")?.nom : undefined;
    const prive = gardien && gardien !== d.demandeur && t.get<{ role: string | null }>("SELECT role FROM agents WHERE nom = ?", [d.demandeur])?.role !== "gardien"
      ? join(runDir, "agents", gardien, "prive") : undefined;
    conclure(t, d, await rejouer(d, runDir, { ...o, prive }));
  } catch (e) {
    const raison = String((e as Error)?.message ?? e).slice(0, 300);
    T.finirRejeu(t, d.id, null, { panne: raison });
    if (d.ticket !== null) T.majTicket(t, d.ticket, "essaim", { note: `rejeu #${d.id} en panne : ${raison} ; l'alerte reste ouverte` }, annonceRejeu(d));
    else if (d.rejoue) { const a = T.attestationDe(t, d.exigence!); if (a?.recu === d.rejoue) signalerEchec(t, d, a, `rejeu #${d.id} en panne, sans reçu : ${raison}`); }
    else annoncerPreuve(t, d, `rejeu #${d.id} en panne, sans reçu : ${raison}`);
  }
}
// Au constat de fin : tous les reçus attestés à rejouer, rejoués ici même (la minuterie est arrêtée), avant que le
// lanceur décide accepté ou incomplet. Rend le nombre de rejeux faits.
export async function rejouerAttestations(t: T.Tableau, runDir: string, o: { sansBacASable?: boolean; delaiMs?: number } = {}): Promise<number> {
  const ids = demanderRejeux(t, runDir);
  const prises = T.prendreRejeux(t, ids);
  for (const d of prises) await servir(t, d, runDir, o);
  return prises.length;
}

// La minuterie du lanceur (comme servirLots) : un rejeu à la fois, rien en pause ; arreter attend le rejeu en cours.
export function servirRejeux(t: T.Tableau, runDir: string, o: { ms: number; sansBacASable?: boolean; delaiMs?: number; enPause?: () => boolean }): { arreter: () => Promise<void> } {
  let enCours: Promise<void> | undefined;
  const tour = async () => {
    for (const d of T.prendreRejeux(t)) await servir(t, d, runDir, o);
  };
  const minuterie = setInterval(() => {
    if (enCours || o.enPause?.()) return;
    enCours = tour().finally(() => { enCours = undefined; });
  }, o.ms);
  return { arreter: async () => { clearInterval(minuterie); await enCours; } };
}
