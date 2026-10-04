// Le surveillant : un septième rôle qui regarde la
// marche du run de l'extérieur. Le lanceur calcule des signes de construction qui tourne en rond (S1 à S4), sans token,
// et le réveille ; il cherche le fait mesuré qui contredit la spec et demande une révision au chef. Ce module garde ce
// qui se teste sans lanceur : ses destinataires, les seuils, la grâce et les signes.

import { PORTEUR_GEL } from "./roles.ts";
import { aColonne, aTable, ajouterEvenement, JALONS_MIN, ordreLibelle, cheminsDuTicket, cleChemin, dureeHorsPause, majTicket, nomme, poster, preparation, type Tableau, type Ticket } from "./tableau.ts";

// Ce que le surveillant attend en veille : un signe du lanceur, toujours (veille initiale).
export const ATTENTE_SIGNE = "un signe du lanceur";

// À qui il parle : les présents qui tiennent les sièges chef (ou le suppléant qui tient le siège du chef),
// gardien et recette. Une équipe document ou problème de cinq agents n'a pas de recette : le chef et le gardien.
export type MembreSalle = { nom: string; role: string | null; suppleantDe?: string | null; present?: boolean };
export function destinatairesSurveillant(equipe: MembreSalle[]): string[] {
  const presents = equipe.filter((a) => a.present !== false);
  const tenant = (role: string) => presents.findLast((a) => a.role === role)?.nom;
  const chef = tenant("chef") ?? presents.find((a) => a.suppleantDe === "chef")?.nom;
  return [chef, tenant("gardien"), tenant("recette")].filter((n): n is string => !!n);
}

// La tête d'un message (avant le premier « : » de la première ligne) : le surveillant n'y nomme que ses destinataires, et
// au moins l'un d'eux. Rend le refus, ou undefined. alias : prénom et surnom de chaque membre.
export function refusParoleSurveillant(texte: string, destinataires: string[], membres: Array<{ nom: string; alias: string[] }>): string | undefined {
  const ligne = texte.split("\n", 1)[0] ?? "";
  const i = ligne.indexOf(":");
  const tete = i >= 0 ? ligne.slice(0, i) : "";
  const cites = membres.filter((m) => m.alias.some((x) => x && nomme(tete, x))).map((m) => m.nom);
  const ok = cites.length > 0 && cites.every((n) => destinataires.includes(n));
  return ok ? undefined : `le surveillant parle au chef, au gardien et à la recette : son message commence par leur prénom (${destinataires.join(", ") || "aucun présent"}) et ne nomme personne d'autre en tête. Définitif pour ce rôle`;
}

// ---- Les signes ---------------------------------------------------------------------------------------------------
// Les seuils de l'essaim, en minutes, chacun surchargeable par une variable d'environnement (les tests les réduisent).
// Lus à chaque appel, pas au chargement du module.
const min = (nom: string, defaut: number) => Number(process.env[nom] ?? defaut) * 60_000;
export const seuils = () => ({
  s1Ms: min("ESSAIM_SIGNE_S1_MIN", 45), s2Ms: min("ESSAIM_SIGNE_S2_MIN", 30), s2Echecs: Number(process.env.ESSAIM_SIGNE_S2_ECHECS ?? 3),
  s3Ms: min("ESSAIM_SIGNE_S3_MIN", 60), s3Recidives: Number(process.env.ESSAIM_SIGNE_S3_RECIDIVES ?? 2), s4Ms: min("ESSAIM_SIGNE_S4_MIN", 30),
  gracePremierMs: min("ESSAIM_GRACE_PREMIER_MIN", 60), graceRevisionMs: min("ESSAIM_GRACE_REVISION_MIN", 30),
  rappelMs: min("ESSAIM_REVISION_RAPPEL_MIN", 15), expirationMs: min("ESSAIM_REVISION_EXPIRATION_MIN", 30), revisionMaxMs: min("ESSAIM_REVISION_MAX_MIN", 45),
  revisionsMax: Number(process.env.ESSAIM_REVISIONS_MAX ?? 2),
});

// L'origine de la grâce : la validation du dernier plan ; sans plan validé, la clôture de la préparation
// par le lanceur ; sans préparation, le début du run. Rien pendant la préparation : les signes n'ont pas d'origine.
export function origineGrace(t: Tableau): { le: string; revise: boolean } | undefined {
  const etat = preparation(t);
  if (etat === "en_cours") return undefined;
  if (aColonne(t, "plans", "valide_le")) {
    const revision = aColonne(t, "plans", "revision_id") ? ", revision_id" : ", NULL AS revision_id";
    const p = t.get<{ valide_le: string; revision_id: number | null }>(`SELECT valide_le${revision} FROM plans WHERE etape = 'plan' AND valide_le IS NOT NULL ORDER BY valide_le DESC LIMIT 1`);
    if (p) return { le: p.valide_le, revise: p.revision_id !== null };
  }
  if (etat === "close") {
    const e = t.get<{ h: string }>("SELECT horodatage AS h FROM evenements WHERE agent = 'lanceur' AND type = 'plan' AND resultat_resume LIKE 'préparation close%' ORDER BY id DESC LIMIT 1");
    if (e) return { le: e.h, revise: false };
  }
  const debut = t.get<{ debut: string | null }>("SELECT debut FROM run")?.debut;
  return debut ? { le: debut, revise: false } : undefined;
}

// La grâce : 1 h après le premier plan, 30 min après un plan révisé, hors pause. Rend l'heure (ms) de sa fin, ou
// undefined sans origine.
export function finDeGrace(t: Tableau, maintenantMs: number): { finie: boolean; resteMs: number } | undefined {
  const o = origineGrace(t);
  if (!o) return undefined;
  const s = seuils();
  const duree = o.revise ? s.graceRevisionMs : s.gracePremierMs;
  const passe = dureeHorsPause(t, Date.parse(o.le), maintenantMs);
  return { finie: passe >= duree, resteMs: Math.max(0, duree - passe) };
}

// Un signe allumé : son code, sa cible (ce qui l'allume : l'exigence, le chemin, l'heure de référence), et son texte, avec
// le chiffre et l'activité de la fenêtre (un indice, pas une preuve de boucle).
export type Signe = { code: "S1" | "S2" | "S3" | "S4"; cible: string; texte: string };
// L'âge du livrable, lu dans git par le lanceur hors de la boucle (S1) : la date de commit du dernier commit qui le
// touche, ou l'erreur de la lecture (« mesure indisponible », jamais un signe). Absent : pas encore lu.
export type MesureLivrable = { le?: string; erreur?: string };

const minutes = (ms: number) => `${Math.round(ms / 60_000)} min`;

// L'activité d'une fenêtre : tickets fermés, essais adoptés, commits du livrable depuis `depuis`.
function activite(t: Tableau, depuis: string): string {
  const fermes = aColonne(t, "tickets", "ferme_le") ? t.get<{ n: number }>("SELECT count(*) AS n FROM tickets WHERE ferme_le >= ?", [depuis])!.n : 0;
  const adoptes = t.get<{ n: number }>("SELECT count(*) AS n FROM essais WHERE adopte_le >= ?", [depuis])!.n;
  return `${fermes} ticket${fermes > 1 ? "s" : ""} fermé${fermes > 1 ? "s" : ""}, ${adoptes} essai${adoptes > 1 ? "s" : ""} adopté${adoptes > 1 ? "s" : ""} dans la même fenêtre`;
}

// Les exigences actives, et la plus récente première attestation valide (non révoquée, avec un reçu) de chacune.
// Les jalons : les feuilles seulement ; une exigence découpée ne se signe pas, ses
// jalons la portent, et un jalon nouvellement attesté est un progrès.
function exigencesActives(t: Tableau): Array<{ libelle: string; tenue: boolean; premiere: string | null }> {
  if (!aTable(t, "exigences")) return [];
  const decoupee = aColonne(t, "exigences", "parent") ? ` AND (SELECT count(*) FROM exigences j WHERE j.parent = e.libelle AND j.retiree_le IS NULL) < ${JALONS_MIN}` : "";
  return t.all<{ libelle: string; tenue: number; premiere: string | null }>(`SELECT e.libelle,
      EXISTS (SELECT 1 FROM attestations a WHERE a.exigence = e.libelle AND a.revoquee_le IS NULL AND a.id = (SELECT MAX(id) FROM attestations b WHERE b.exigence = e.libelle AND b.revoquee_le IS NULL) AND a.non_verifiee = 0) AS tenue,
      (SELECT MIN(cree_le) FROM attestations a WHERE a.exigence = e.libelle AND a.revoquee_le IS NULL AND a.non_verifiee = 0) AS premiere
    FROM exigences e WHERE e.retiree_le IS NULL${decoupee}`).sort((a, b) => ordreLibelle(a.libelle, b.libelle)).map((e) => ({ ...e, tenue: e.tenue === 1 }));
}

// Les signes allumés à l'instant. Rien sans origine de grâce (préparation en cours). La grâce et les
// révisions ne les éteignent pas : le lanceur les mesure toujours, et ne réveille qu'en dehors (Occurrences).
export function signes(t: Tableau, o: { maintenantMs: number; livrable?: string; mesure?: MesureLivrable }): Signe[] {
  const origine = origineGrace(t);
  if (!origine) return [];
  const s = seuils(), m = o.maintenantMs, l: Signe[] = [];
  const depuis = (le: string) => dureeHorsPause(t, Date.parse(le), m);
  const exigences = exigencesActives(t);
  const toutesTenues = exigences.length > 0 && exigences.every((e) => e.tenue);
  const debut = t.get<{ debut: string | null }>("SELECT debut FROM run")?.debut ?? origine.le;
  // S1 : le livrable n'a pas changé depuis 45 min (sans livrable : aucun essai adopté). Muet quand tout est attesté, quand
  // des rejeux sont en cours, ou quand la mesure git manque.
  const rejeux = aTable(t, "demandes_rejeu") && !!t.get("SELECT 1 FROM demandes_rejeu WHERE etat IN ('attente', 'prise')");
  const dernier = o.livrable ? o.mesure?.erreur || !o.mesure ? undefined : (o.mesure.le ?? debut)
    : (t.get<{ le: string | null }>("SELECT MAX(adopte_le) AS le FROM essais")?.le ?? debut);
  if (dernier !== undefined && !toutesTenues && !rejeux) {
    const ref = Date.parse(dernier) > Date.parse(debut) ? dernier : debut;
    const age = depuis(ref);
    if (age >= s.s1Ms) l.push({ code: "S1", cible: ref, texte: `S1 : ${o.livrable ? `le livrable ${o.livrable} n'a pas changé` : "aucun essai adopté"} depuis ${minutes(age)} ; ${activite(t, new Date(m - age).toISOString())}` });
  }
  // S2 : la même exigence a trois rejeux échoués en 30 min (événements rejeu_echoue du lanceur).
  const echecs = new Map<string, number>();
  for (const e of t.all<{ h: string; r: string | null }>("SELECT horodatage AS h, resultat_resume AS r FROM evenements WHERE agent = 'lanceur' AND type = 'rejeu_echoue' AND horodatage >= ?", [new Date(m - 2 * s.s2Ms - 3_600_000).toISOString()])) {
    const x = /^(\S+) n'est plus attestée/.exec(e.r ?? "")?.[1];
    if (x && depuis(e.h) <= s.s2Ms) echecs.set(x, (echecs.get(x) ?? 0) + 1);
  }
  for (const [x, n] of echecs) if (n >= s.s2Echecs) l.push({ code: "S2", cible: x, texte: `S2 : ${x} a ${n} rejeux échoués en ${minutes(s.s2Ms)}` });
  // S3 : deux tickets de travail ouverts dans l'heure reprennent un ticket fermé dans l'heure : même exigence, ou, sans
  // exigence, un chemin commun (un dossier contient ses fichiers).
  if (aColonne(t, "tickets", "ferme_le")) {
    const fenetre = new Date(m - s.s3Ms).toISOString();
    type K = { id: number; exigence: string | null; chemins: string | null };
    const fermes = t.all<K>("SELECT id, exigence, chemins FROM tickets WHERE sorte = 'travail' AND ferme_le >= ?", [fenetre]);
    const ouverts = t.all<K & { cree_le: string }>("SELECT id, exigence, chemins, cree_le FROM tickets WHERE sorte = 'travail' AND type <> 'question' AND cree_le >= ?", [fenetre]);
    const chemins = (k: K) => (k.chemins ? JSON.parse(k.chemins) as string[] : []).map(cleChemin);
    const commun = (a: string[], b: string[]) => a.find((x) => b.some((y) => x === y || y.startsWith(x.endsWith("/") ? x : x + "/") || x.startsWith(y.endsWith("/") ? y : y + "/")));
    const recidives = new Map<string, Set<number>>();
    for (const f of fermes) for (const k of ouverts) {
      if (k.id === f.id) continue;
      const cible = f.exigence ? (k.exigence === f.exigence ? f.exigence : undefined) : commun(chemins(f), chemins(k));
      if (cible) recidives.set(cible, (recidives.get(cible) ?? new Set()).add(k.id));
    }
    for (const [cible, ks] of recidives) if (ks.size >= s.s3Recidives) l.push({ code: "S3", cible, texte: `S3 : ${ks.size} tickets ouverts dans l'heure (${[...ks].map((n) => `#${n}`).join(", ")}) reprennent ${cible}, déjà traité par un ticket fermé dans l'heure` });
  }
  // S4 : des exigences restent sans attestation valide, et aucune n'a reçu sa première attestation valide depuis 30 min
  // (une ré-attestation ne compte pas). La fenêtre part au plus tôt de l'origine de la grâce.
  const restantes = exigences.filter((e) => !e.tenue);
  if (restantes.length) { // jalons : un jalon nouvellement attesté compte comme une exigence
    const premieres = exigences.map((e) => e.premiere).filter((x): x is string => !!x).sort();
    const ref = [origine.le, premieres.at(-1)].filter((x): x is string => !!x).sort().at(-1)!;
    const age = depuis(ref);
    if (age >= s.s4Ms) l.push({ code: "S4", cible: ref, texte: `S4 : aucune exigence ni aucun jalon nouvellement attesté depuis ${minutes(age)} ; ${restantes.length} sans attestation valide (${restantes.slice(0, 8).map((e) => e.libelle).join(", ")}) ; ${activite(t, new Date(m - age).toISOString())}` });
  }
  return l;
}

// Les occurrences : un signe s'allume (sa clé apparaît), réveille une fois, puis plus tant qu'il reste allumé ;
// éteint puis rallumé, c'est une nouvelle occurrence. Consommer : les occurrences en cours ne réveillent plus (après un
// diagnostic sans contradiction, une demande, un refus, une expiration).
export class Occurrences {
  private allumes = new Map<string, { depuis: number; signe: Signe; reveille: boolean; consomme: boolean }>();
  // Met à jour avec les signes mesurés à l'instant ; rend ceux qui doivent réveiller (si reveiller est vrai, ils sont
  // marqués réveillés).
  maj(l: Signe[], maintenantMs: number, reveiller: boolean): Signe[] {
    const vus = new Set<string>();
    for (const x of l) {
      const cle = `${x.code}:${x.cible}`;
      vus.add(cle);
      const a = this.allumes.get(cle);
      if (a) a.signe = x; else this.allumes.set(cle, { depuis: maintenantMs, signe: x, reveille: false, consomme: false });
    }
    for (const cle of [...this.allumes.keys()]) if (!vus.has(cle)) this.allumes.delete(cle);
    const nouveaux = [...this.allumes.values()].filter((a) => !a.reveille && !a.consomme);
    if (reveiller) for (const a of nouveaux) a.reveille = true;
    return reveiller ? nouveaux.map((a) => a.signe) : [];
  }
  consommer(): void { for (const a of this.allumes.values()) a.consomme = true; }
  // Une occurrence non consommée : de quoi lever le refus de revision_demander.
  nonConsommees(): Signe[] { return [...this.allumes.values()].filter((a) => !a.consomme).map((a) => a.signe); }
  // Pour un remplaçant : les occurrences allumées non consommées se réveillent de nouveau.
  rearmer(): void { for (const a of this.allumes.values()) if (!a.consomme) a.reveille = false; }
}

// Une révision demandée sans réponse, ou acceptée et pas encore close : une seule à la fois. Pendant ce
// temps, les signes ne réveillent pas.
export function revisionEnCours(t: Tableau): { id: number; etat: "demandee" | "acceptee"; cree_le: string; repondu_le: string | null; rappel_le: string | null } | undefined {
  if (!aTable(t, "revisions")) return undefined;
  return t.get("SELECT id, etat, cree_le, repondu_le, rappel_le FROM revisions WHERE etat IN ('demandee', 'acceptee') ORDER BY id DESC LIMIT 1");
}

// Les occurrences consommées : un diagnostic sans contradiction, une demande, un refus, une expiration posent
// l'événement signes_consommes ; revision_demander exige un signe réveillé depuis le dernier.
export const CONSOMMES = "signes_consommes";
export function consommerSignes(t: Tableau, agent: string, raison: string): void {
  t.run("INSERT INTO evenements(agent, horodatage, type, resultat_resume) VALUES (?, ?, ?, ?)", [agent, new Date().toISOString(), CONSOMMES, raison]);
}
export function signeNonConsomme(t: Tableau): boolean {
  const dernier = t.get<{ id: number | null }>("SELECT MAX(id) AS id FROM evenements WHERE type = ?", [CONSOMMES])?.id ?? 0;
  return !!t.get("SELECT 1 FROM evenements WHERE type = 'signe' AND id > ?", [dernier]);
}

// ---- La révision ------------------------------------------------------------------------------------------------
export type Revision = { id: number; demandeur: string; constat: string; tickets_json: string; etat: "demandee" | "refusee" | "expiree" | "acceptee" | "close";
  raison: string | null; tickets_geles_json: string | null; repondu_par: string | null; cree_le: string; rappel_le: string | null; repondu_le: string | null;
  close_le: string | null; close_par: string | null };
const ici = () => new Date().toISOString();
export function demanderRevision(t: Tableau, r: { demandeur: string; constat: string; tickets: number[] }): number {
  return t.run("INSERT INTO revisions(demandeur, constat, tickets_json, cree_le) VALUES (?, ?, ?, ?)", [r.demandeur, r.constat, JSON.stringify(r.tickets), ici()]).lastId;
}
// Les révisions acceptées, closes comprises (deux au plus) ; un refus ou une expiration ne compte pas.
export const revisionsAcceptees = (t: Tableau): number => aTable(t, "revisions") ? t.get<{ n: number }>("SELECT count(*) AS n FROM revisions WHERE etat IN ('acceptee', 'close')")!.n : 0;
export const lireRevision = (t: Tableau, id: number) => t.get<Revision>("SELECT * FROM revisions WHERE id = ?", [id]);
export const listerRevisions = (t: Tableau): Revision[] => aTable(t, "revisions") ? t.all<Revision>("SELECT * FROM revisions ORDER BY id") : [];
export function repondreRevision(t: Tableau, id: number, r: { accepte: boolean; raison: string; par: string; tickets?: number[] }): void {
  t.run("UPDATE revisions SET etat = ?, raison = ?, repondu_par = ?, repondu_le = ?, tickets_geles_json = ? WHERE id = ? AND etat = 'demandee'",
    [r.accepte ? "acceptee" : "refusee", r.raison, r.par, ici(), r.accepte ? JSON.stringify(r.tickets ?? []) : null, id]);
}
export const rappelerRevision = (t: Tableau, id: number) => t.run("UPDATE revisions SET rappel_le = ? WHERE id = ?", [ici(), id]);
export const expirerRevision = (t: Tableau, id: number) => t.run("UPDATE revisions SET etat = 'expiree', close_le = ? WHERE id = ? AND etat = 'demandee'", [ici(), id]).changes > 0;
export const cloreRevision = (t: Tableau, id: number, par: "plan" | "delai") =>
  t.run("UPDATE revisions SET etat = 'close', close_le = ?, close_par = ? WHERE id = ? AND etat = 'acceptee'", [ici(), par, id]).changes > 0;

// ---- Le gel ---------------------------------------------------------------------------------------------------------
// Geler à l'acceptation (dans la transaction de la réponse, sans transaction imbriquée) : gele_le posé, les pancartes des
// chemins passent au porteur fictif gel. Rend les tickets gelés et leur porteur, que l'appelant prévient après.
export function gelerTickets(t: Tableau, revision: number, ids: number[]): Array<{ id: number; charge: string | null }> {
  const le = ici(), geles: Array<{ id: number; charge: string | null }> = [];
  for (const id of ids) {
    const k = t.get<Ticket>("SELECT * FROM tickets WHERE id = ?", [id]);
    if (!k) continue;
    t.run("UPDATE tickets SET gele_le = ? WHERE id = ?", [le, id]);
    for (const c of cheminsDuTicket(k)) {
      t.run("UPDATE reclamations SET retire_le = ? WHERE chemin = ? AND retire_le IS NULL", [le, c]);
      t.run("INSERT INTO reclamations(chemin, agent, raison, pose_le) VALUES (?, ?, ?, ?)", [c, PORTEUR_GEL, `#${id} gelé par la révision n°${revision}`, le]);
    }
    geles.push({ id, charge: k.charge });
  }
  return geles;
}
// Le porteur d'un ticket gelé, prévenu par un message qui le nomme seul : il compte disponible.
export function annoncerGel(t: Tableau, revision: number, geles: Array<{ id: number; charge: string | null }>): void {
  for (const g of geles) if (g.charge) poster(t, "lanceur", `${g.charge} : ticket #${g.id} gelé par la révision n°${revision} : tu n'y travailles plus jusqu'au nouveau plan ; tu es disponible pour un autre travail.`);
}
const lireGeles = (t: Tableau, revision: number): Ticket[] => {
  const ids: number[] = JSON.parse(lireRevision(t, revision)?.tickets_geles_json ?? "[]");
  return ids.map((id) => t.get<Ticket>("SELECT * FROM tickets WHERE id = ?", [id])).filter((k): k is Ticket => !!k && !!k.gele_le);
};
// Dégeler : la pancarte gel retirée ; rendue au porteur du ticket s'il est encore ouvert et confié.
function degeler(t: Tableau, k: Ticket, rendre: boolean): void {
  const le = ici();
  t.run("UPDATE tickets SET gele_le = NULL WHERE id = ?", [k.id]);
  for (const c of cheminsDuTicket(k)) {
    t.run("UPDATE reclamations SET retire_le = ? WHERE chemin = ? AND agent = ? AND retire_le IS NULL", [le, c, PORTEUR_GEL]);
    if (rendre && k.charge) t.run("INSERT INTO reclamations(chemin, agent, raison, pose_le) VALUES (?, ?, ?, ?)", [c, k.charge, `ticket #${k.id}, dégelé`, le]);
  }
}
// La révision close par le délai : tous les tickets gelés sont dégelés et rendus.
export function degelerTout(t: Tableau, revision: number): void {
  for (const k of lireGeles(t, revision)) {
    degeler(t, k, true);
    if (k.charge) poster(t, "lanceur", `${k.charge} : ticket #${k.id} dégelé, la révision n°${revision} est close sans plan ; tu le reprends.`);
  }
}
// À la validation du plan révisé : les tickets gelés que le plan reprend sont dégelés et rendus, les autres annulés
// (motif annule, note « non repris par le plan révisé »). Rend la phrase de l'annonce.
export function resoudreGel(t: Tableau, revision: number, plan: number): string {
  const repris: number[] = JSON.parse(t.get<{ x: string | null }>("SELECT tickets_repris AS x FROM plans WHERE id = ?", [plan])?.x ?? "[]");
  const faits: number[] = [], annules: number[] = [];
  for (const k of lireGeles(t, revision)) {
    if (repris.includes(k.id)) {
      degeler(t, k, true);
      faits.push(k.id);
      if (k.charge) poster(t, "lanceur", `${k.charge} : ticket #${k.id} repris par le plan révisé : il est de nouveau à toi.`);
    } else {
      degeler(t, k, false);
      majTicket(t, k.id, "lanceur", { motif: "annule", note: "non repris par le plan révisé" });
      annules.push(k.id);
      if (k.charge) poster(t, "lanceur", `${k.charge} : ticket #${k.id} annulé, non repris par le plan révisé.`);
    }
  }
  const l = (x: number[]) => x.map((n) => `#${n}`).join(", ");
  return [faits.length ? ` Tickets repris : ${l(faits)}.` : "", annules.length ? ` Annulés, non repris par le plan révisé : ${l(annules)}.` : ""].join("");
}

// Le suivi d'une révision par le lanceur, hors pause : sans réponse du chef, un rappel au bout de 15 min
// et l'expiration au bout de 30 ; acceptée sans plan validé au bout de 45 min, close par le délai, les tickets dégelés.
const sansQuestion = (x: string) => x.replace(/\?/g, "");
export function suivreRevision(t: Tableau, maintenantMs: number, equipe: MembreSalle[]): void {
  const rev = revisionEnCours(t);
  if (!rev) return;
  const s = seuils(), dest = destinatairesSurveillant(equipe), r = lireRevision(t, rev.id)!;
  if (rev.etat === "demandee") {
    const age = dureeHorsPause(t, Date.parse(rev.cree_le), maintenantMs);
    if (age >= s.expirationMs) {
      if (!expirerRevision(t, rev.id)) return;
      consommerSignes(t, "lanceur", `révision n°${rev.id} expirée`);
      poster(t, "lanceur", `${[...new Set([r.demandeur, ...dest])].join(", ")} : révision n°${rev.id} expirée, sans réponse en ${minutes(s.expirationMs)} ; le bilan le dira.`);
      ajouterEvenement(t, { agent: "lanceur", type: "revision", resultat: `révision n°${rev.id} expirée sans réponse` });
    } else if (age >= s.rappelMs && !rev.rappel_le) {
      rappelerRevision(t, rev.id);
      poster(t, "lanceur", `${dest.join(", ")} : rappel, la révision n°${rev.id} demandée par ${r.demandeur} attend sa réponse (revision_repondre) ; elle expire dans ${minutes(s.expirationMs - age)}. ${sansQuestion(r.constat.slice(0, 300))}`);
      ajouterEvenement(t, { agent: "lanceur", type: "revision", resultat: `révision n°${rev.id} : rappel` });
    }
  } else if (rev.repondu_le && dureeHorsPause(t, Date.parse(rev.repondu_le), maintenantMs) >= s.revisionMaxMs) {
    if (!cloreRevision(t, rev.id, "delai")) return;
    degelerTout(t, rev.id);
    poster(t, "lanceur", `${[...new Set([...dest, r.demandeur])].join(", ")} : révision n°${rev.id} close sans plan validé en ${minutes(s.revisionMaxMs)} ; le plan d'avant reste, les tickets gelés sont rendus.`);
    ajouterEvenement(t, { agent: "lanceur", type: "revision", resultat: `révision n°${rev.id} close par le délai` });
  }
}
