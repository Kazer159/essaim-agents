// Le second cerveau de la salle : empreintes et
// statuts des vérifications, recherche, « écrit depuis », état de la salle et ligne courte, bilan.
// Lu sous Bun (lanceur, vue, tests, sondes) ET sous Node (l'extension dans pi) : aucun pilote SQLite (le tableau vient
// de l'appelant, interface T.Tableau), aucun Bun.*, aucun import.meta.dir, aucun import de processus.ts.
// Les quatre imports par espace de noms ci-dessous suffisent (crypto.createHash, fs.readFileSync, path.join, T.noterFait…).
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as T from "./tableau.ts";

// ---- Empreintes et statuts
// L'empreinte d'un fichier est son blob git (sha1 de « blob <taille>\0<contenu> »), calculé sans git : le même
// identifiant que dans les commits, ce qui compare le disque, les faits ecriture et l'historique sans conversion.

export type Empreinte = { blob: string; taille: number; mtimeMs: number };
// Par processus : chemin absolu → dernière empreinte lue ; relue seulement si la taille ou la date a changé.
export type Cache = Map<string, Empreinte & { chemin: string }>;

export function blobGit(octets: Uint8Array): string {
  return crypto.createHash("sha1").update(`blob ${octets.byteLength}\0`).update(octets).digest("hex");
}

const IGNORES = new Set([".git", "node_modules"]);

// Les fichiers ordinaires de racine (hors .git et node_modules, liens jamais suivis), ou seulement ceux de la liste
// qui existent. Clés : chemins relatifs à racine, barres obliques.
export function empreintes(racine: string, fichiers?: string[], cache?: Cache): Map<string, Empreinte> {
  const res = new Map<string, Empreinte>();
  const prendre = (rel: string) => {
    const abs = path.join(racine, rel);
    let st: fs.Stats;
    try { st = fs.lstatSync(abs); } catch { return; }
    if (!st.isFile()) return;
    const connu = cache?.get(abs);
    if (connu && connu.taille === st.size && connu.mtimeMs === st.mtimeMs) { res.set(rel, { blob: connu.blob, taille: connu.taille, mtimeMs: connu.mtimeMs }); return; }
    let octets: Buffer;
    try { octets = fs.readFileSync(abs); } catch { return; } // supprimé entre-temps
    const e = { blob: blobGit(octets), taille: st.size, mtimeMs: st.mtimeMs };
    cache?.set(abs, { ...e, chemin: abs });
    res.set(rel, e);
  };
  if (fichiers) { for (const f of fichiers) prendre(f); return res; }
  const parcourir = (rel: string) => {
    let entrees: fs.Dirent[];
    try { entrees = fs.readdirSync(path.join(racine, rel), { withFileTypes: true }); } catch { return; }
    for (const x of entrees) {
      const sous = rel ? `${rel}/${x.name}` : x.name;
      // Un dépôt imbriqué n'est pas parcouru : commiter ne le commite jamais, ses écritures restaient sans auteur.
      if (x.isDirectory()) { if (!IGNORES.has(x.name) && !fs.existsSync(path.join(racine, sous, ".git"))) parcourir(sous); }
      else if (x.isFile()) prendre(sous);
    }
  };
  parcourir("");
  return res;
}

// Le statut d'un contrôle, sur les seuls fichiers contrôlés. changes : ceux dont le contenu ou la date a changé
// entre les deux relevés (créés et supprimés compris).
export function statutVerification(avant: Map<string, Empreinte>, apres: Map<string, Empreinte>, controles: string[],
  resultat: "succes" | "echec" | "illisible"): { statut: T.StatutVerification; changes: string[] } {
  const contenu: string[] = [], date: string[] = [];
  let illisibles = 0; // contrôlé mais absent des deux relevés : un lien, une ressource manquante ; rien n'a été empreint
  for (const c of controles) {
    const a = avant.get(c), b = apres.get(c);
    if (!a && !b) { illisibles++; continue; }
    if (!a || !b || a.blob !== b.blob) contenu.push(c);
    else if (a.mtimeMs !== b.mtimeMs) date.push(c);
  }
  const changes = [...contenu, ...date];
  if (resultat === "illisible" || contenu.length || illisibles) return { statut: "inconnu", changes };
  if (date.length) return { statut: "instable", changes };
  return { statut: resultat === "echec" ? "echoue" : "verifie", changes };
}

// Le HEAD du dépôt de racine, lu sans git (7 caractères), à titre d'information : le contenu vérifié peut ne pas être
// encore commité. Dossier sans dépôt, ou dépôt illisible : undefined. Suit un worktree (.git fichier).
export function tete(racine: string): string | undefined {
  try {
    let gitdir = path.join(racine, ".git");
    if (fs.statSync(gitdir).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitdir, "utf8"));
      if (!m) return undefined;
      gitdir = path.resolve(racine, m[1]!.trim());
    }
    const head = fs.readFileSync(path.join(gitdir, "HEAD"), "utf8").trim();
    if (!head.startsWith("ref:")) return head.slice(0, 7);
    const ref = head.slice(4).trim();
    let commun = gitdir;
    try { commun = path.resolve(gitdir, fs.readFileSync(path.join(gitdir, "commondir"), "utf8").trim()); } catch { /* pas un worktree */ }
    for (const d of [gitdir, commun]) {
      try { return fs.readFileSync(path.join(d, ref), "utf8").trim().slice(0, 7); } catch { /* ref rangée ailleurs */ }
    }
    const ligne = fs.readFileSync(path.join(commun, "packed-refs"), "utf8").split("\n").find((l) => l.endsWith(" " + ref));
    return ligne?.slice(0, 7);
  } catch {
    return undefined;
  }
}

const MOT_STATUT: Record<T.StatutVerification, string> = { verifie: "vérifié", echoue: "échoué", inconnu: "inconnu", instable: "instable" };
const CONTENU_MAX = 6;
const liste = (noms: string[]) => noms.length <= CONTENU_MAX ? noms.join(", ") : `${noms.slice(0, CONTENU_MAX).join(", ")} et ${noms.length - CONTENU_MAX} autres`;

// La ligne d'un fait de vérification, sans l'heure : des faits, des chiffres, jamais un jugement.
// « vérifié · page_voir index.html · page saine (0) · Bernard · contenu : index.html, app.js ».
export function texteVerification(o: { statut: T.StatutVerification; changes: string[]; outil: string; sujet: string; essai?: string;
  resultat: string; agent: string; contenu?: string[] }): string {
  const morceaux = [MOT_STATUT[o.statut], `${o.outil} ${o.sujet}${o.essai ? ` (essai ${o.essai})` : ""}`, o.resultat, o.agent];
  if (o.contenu) morceaux.push(`contenu : ${liste(o.contenu)}`);
  if (o.changes.length && o.statut === "inconnu") morceaux.push(`contenu changé pendant le contrôle : ${liste(o.changes)}`);
  if (o.changes.length && o.statut === "instable") morceaux.push(`réécrit pendant le contrôle, même contenu : ${liste(o.changes)}`);
  return morceaux.join(" · ");
}

// Le bilan chiffré de bun test (lireBilan, outils-travail.ts) lu en résultat : échec si fail > 0 ou une ligne
// errors ; succès si fail = 0 et Ran N lus, sans ligne errors (bun l'écrit entre les deux) ; sinon illisible
// (| head, | grep fail, sortie coupée).
type BilanLu = { pass?: number; fail?: number; error?: number; ran?: number };
export function resultatDuBilan(b: BilanLu): "succes" | "echec" | "illisible" {
  if ((b.fail ?? 0) > 0 || (b.error ?? 0) > 0) return "echec";
  if (b.fail === 0 && b.ran !== undefined && b.ran > 0) return "succes"; // aucun test lancé ne prouve rien
  return "illisible";
}
const nombre = (n: number, un: string, plusieurs: string) => `${n} ${n > 1 ? plusieurs : un}`;
// Les chiffres lus, tels quels : « 29 réussis, 17 échoués » ; sans pass, « 71 tests lancés, 0 échoué ».
export function chiffresBilan(b: BilanLu): string {
  const m: string[] = [];
  if (b.pass !== undefined) m.push(nombre(b.pass, "réussi", "réussis"));
  else if (b.ran !== undefined) m.push(nombre(b.ran, "test lancé", "tests lancés"));
  if (b.fail !== undefined) m.push(nombre(b.fail, "échoué", "échoués"));
  if (b.error) m.push(nombre(b.error, "erreur", "erreurs"));
  return m.length ? m.join(", ") : "bilan non lu";
}

// ---- Recherche
// salle_chercher : la table FTS5 recherche, remplie par les déclencheurs du SCHEMA, lue ici sans rien écrire
// (rien n'est marqué lu). Trié et paginé par le rowid de recherche, croissant à chaque entrée dans l'index.

export const TYPES_RECHERCHE = ["message", "resume", "commit", "fait", "ticket"] as const;
export type TypeRecherche = (typeof TYPES_RECHERCHE)[number];
// type et avant arrivent tels que l'agent les écrit : chercher les refuse s'ils ne se lisent pas.
export type ParamsChercher = { mots?: string; numero?: number; jusqua?: number; debut_de_mot?: boolean;
  type?: TypeRecherche | string; auteur?: string; fil?: string; depuis?: string; avant?: number | string };

const RESULTATS_MAX = 20;
const PLAGE_MAX = 50;
const REPRISES_MAX = 5;
const COURT = 200; // un texte court est rendu entier ; au-delà, un extrait
const cherchable = /[\p{L}\p{N}]/u;

// Chaque mot de l'agent devient une phrase FTS5 (guillemets doublés) : « navigation.js » brut est une erreur de
// syntaxe. Une expression entre guillemets reste une phrase. Les phrases sont toutes exigées (ET implicite).
// Un mot sans lettre ni chiffre ne donne aucun terme et est laissé ; s'il ne reste rien : undefined.
export function requeteFts(mots: string, debutDeMot: boolean): string | undefined {
  // Les caractères de contrôle retirés : un NUL faisait lever SQLite, une erreur d'outil au lieu d'un refus.
  const phrases = [...mots.replace(/[\u0000-\u001f\u007f]/g, " ").matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]!).filter((p) => cherchable.test(p));
  if (phrases.length === 0) return undefined;
  return phrases.map((p) => `"${p.replaceAll('"', '""')}"${debutDeMot ? "*" : ""}`).join(" ");
}

const deuxChiffres = (n: number) => String(n).padStart(2, "0");
const heureLocale = (iso: string) => { const d = new Date(iso); return `${deuxChiffres(d.getHours())}:${deuxChiffres(d.getMinutes())}`; };
const uneLigne = (s: string) => s.replace(/\s+/g, " ").trim();
const debutDuTexte = (s: string) => { const c = [...uneLigne(s)]; return c.length > COURT ? `${c.slice(0, COURT).join("")}…` : c.join(""); };
const ETATS_TICKET_LUS: Record<string, string> = { ouvert: "ouvert", en_cours: "en cours", ferme: "fermé" };

// depuis : « HH:MM » ou « HH:MM:SS » (la forme des heures de l'état) du jour du run (date locale de run.debut, sinon du jour), ou une date ISO ; rendu en ISO UTC,
// comparable aux cree_le de l'index.
function lireDepuis(t: T.Tableau, depuis: string, maintenant: Date): string | undefined {
  const hm = depuis.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (hm) {
    const [h, m, s] = [Number(hm[1]), Number(hm[2]), Number(hm[3] ?? 0)];
    if (h > 23 || m > 59 || s > 59) return undefined;
    const debut = t.get<{ debut: string | null }>("SELECT debut FROM run LIMIT 1")?.debut;
    const jour = debut ? new Date(debut) : maintenant;
    const d = new Date(jour.getFullYear(), jour.getMonth(), jour.getDate(), h, m, s);
    // Un run qui passe minuit : une heure avant le début du run, déjà passée le lendemain, est celle du lendemain.
    const lendemain = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, h, m, s);
    return (debut && d < new Date(debut) && lendemain <= maintenant ? lendemain : d).toISOString();
  }
  if (!/^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(depuis.trim())) return undefined;
  const d = new Date(depuis.trim());
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

// Les messages postérieurs qui citent ce message (« msg 88 », « message 88 », pas « #88 ») ou ce commit (hash de 7
// caractères) : un constat de citation, pas de sens. Cinq numéros au plus, les premiers.
function reprisPar(t: T.Tableau, type: string, ref: string, creeLe: string): number[] {
  let lus: Array<{ id: number; texte: string }>, motif: RegExp;
  if (type === "message") {
    lus = t.all("SELECT id, texte FROM messages WHERE id > ? AND texte LIKE ? ORDER BY id", [Number(ref), `%${ref}%`]);
    motif = new RegExp(`(?<![\\p{L}\\p{N}_])(?:msg|message)\\s+${ref}(?!\\p{N})`, "iu");
  } else if (type === "commit") {
    const court = ref.slice(0, 7).toLowerCase();
    if (!/^[0-9a-f]{7}$/.test(court)) return [];
    lus = t.all("SELECT id, texte FROM messages WHERE cree_le >= ? AND lower(texte) LIKE ? ORDER BY id", [creeLe, `%${court}%`]);
    motif = new RegExp(`(?<![0-9a-f])${court}`, "i");
  } else return [];
  return lus.filter((m) => motif.test(m.texte)).slice(0, REPRISES_MAX).map((m) => m.id);
}

type Entree = { r: number; texte: string; extrait: string; type: string; ref: string; auteur: string | null; fil: string | null; cree_le: string };

function ligneResultat(t: T.Tableau, e: Entree): string {
  const h = heureLocale(e.cree_le);
  const extrait = uneLigne(e.extrait);
  const reprises = reprisPar(t, e.type, String(e.ref), e.cree_le);
  const repris = reprises.length ? ` · repris par msg ${reprises.join(", ")}` : "";
  switch (e.type) {
    case "message": return `[message] msg ${e.ref} · ${e.fil} · ${h} · ${e.auteur} : ${extrait}${repris}`;
    case "resume": {
      const lot = t.get<{ debut_id: number; fin_id: number }>("SELECT debut_id, fin_id FROM lots WHERE id = ?", [Number(e.ref)]);
      const couvre = lot ? ` · msg ${lot.debut_id} à ${lot.fin_id}` : "";
      return `[résumé de lot] lot ${e.ref} · ${e.fil}${couvre} · ${h} · écrit par un modèle : ${extrait}`;
    }
    case "commit": return `[commit] ${String(e.ref).slice(0, 7)} · ${h} · ${e.auteur} : ${extrait}${repris}`;
    case "fait": return `[fait] fait ${e.ref} · ${h} · ${e.auteur} : ${extrait}`;
    default: {
      const etat = t.get<{ etat: string }>("SELECT etat FROM tickets WHERE id = ?", [Number(e.ref)])?.etat;
      return `[ticket] #${e.ref}${etat ? ` · ${ETATS_TICKET_LUS[etat] ?? etat}` : ""} · ${h} · ${e.auteur} : ${extrait}`;
    }
  }
}

// Lecture par numéro : les messages entiers, une ligne « [fil] message N, date auteur : texte » chacun, ou le fait entier,
// citation comprise.
function lireParNumero(t: T.Tableau, p: ParamsChercher & { numero: number }): { texte: string; resultats: number } {
  if (p.type === "fait") {
    const f = t.get<{ id: number; cree_le: string; agent: string; texte: string; details_json: string | null }>(
      "SELECT id, cree_le, agent, texte, details_json FROM faits WHERE id = ?", [p.numero]);
    if (!f) return { texte: `aucun fait n° ${p.numero}`, resultats: 0 };
    const citation = f.details_json ? (JSON.parse(f.details_json) as { citation?: unknown }).citation : undefined;
    const ligne = `[fait] fait ${f.id} · ${heureLocale(f.cree_le)} · ${f.agent} : ${f.texte}`;
    return { texte: typeof citation === "string" ? `${ligne}\ncitation entière : ${citation}` : ligne, resultats: 1 };
  }
  const [de, a] = p.jusqua === undefined ? [p.numero, p.numero] : [Math.min(p.numero, p.jusqua), Math.max(p.numero, p.jusqua)];
  const ms = t.all<T.Message>(
    `SELECT m.id, f.nom AS fil, m.auteur, m.cree_le, m.texte FROM messages m JOIN fils f ON f.id = m.fil_id
     WHERE m.id BETWEEN ? AND ? ORDER BY m.id`, [de, a]);
  if (ms.length === 0) return { texte: de === a ? `aucun message n° ${de}` : `aucun message du n° ${de} au n° ${a}`, resultats: 0 };
  return { texte: ms.map((m) => `[${m.fil}] message ${m.id}, ${m.cree_le} ${m.auteur} : ${m.texte}`).join("\n"), resultats: ms.length };
}

// { refus } : la raison "<fait>. <levée>", mise en forme par l'outil ; sinon le texte rendu à l'agent.
export function chercher(t: T.Tableau, p: ParamsChercher, maintenant = new Date()): { texte: string; resultats: number } | { refus: string } {
  if (p.type !== undefined && !(TYPES_RECHERCHE as readonly string[]).includes(p.type))
    return { refus: `type inconnu : ${p.type}. Se lève avec message, resume, commit, fait ou ticket` };
  let avant: number | undefined;
  if (p.avant !== undefined) {
    avant = typeof p.avant === "number" ? p.avant : /^\s*\d+\s*$/.test(p.avant) ? Number(p.avant) : NaN;
    if (!Number.isInteger(avant)) return { refus: `avant n'est pas un nombre : ${p.avant}. Se lève avec le nombre rendu par la réponse précédente` };
  }
  const depuis = p.depuis === undefined ? undefined : lireDepuis(t, p.depuis, maintenant);
  if (p.depuis !== undefined && depuis === undefined) return { refus: `date illisible : ${p.depuis}. Se lève avec une heure « HH:MM » ou « HH:MM:SS », ou une date ISO` };
  if (p.numero !== undefined) {
    if (p.type !== undefined && p.type !== "message" && p.type !== "fait")
      return { refus: `numéro avec le type ${p.type}. Se lève avec le type message ou fait` };
    const n = p.jusqua === undefined ? 1 : Math.abs(p.jusqua - p.numero) + 1;
    if (p.type !== "fait" && n > PLAGE_MAX) return { refus: `plage de ${n} messages, plus de ${PLAGE_MAX}. Se lève avec une plage de ${PLAGE_MAX} messages au plus` };
    return lireParNumero(t, p as ParamsChercher & { numero: number });
  }
  const mots = p.mots?.trim() ? p.mots : undefined;
  if (mots === undefined && p.type === undefined && p.auteur === undefined && p.fil === undefined && p.depuis === undefined)
    return { refus: "ni mots, ni numéro, ni filtre. Se lève avec des mots, un numéro, ou l'un des filtres type, auteur, fil ou depuis" };
  const requete = mots === undefined ? undefined : requeteFts(mots, !!p.debut_de_mot);
  if (mots !== undefined && requete === undefined) return { refus: `aucun mot cherchable dans « ${mots} ». Se lève avec au moins un mot` };

  // L'auteur par prénom ou par surnom ; un nom inconnu est cherché tel quel.
  const auteur = p.auteur === undefined ? undefined
    : t.get<{ nom: string }>("SELECT nom FROM agents WHERE nom = ? COLLATE NOCASE OR surnom = ? COLLATE NOCASE", [p.auteur, p.auteur])?.nom ?? p.auteur;
  const conditions: string[] = [], params: unknown[] = [];
  if (requete) { conditions.push("recherche MATCH ?"); params.push(requete); }
  if (p.type !== undefined) { conditions.push("type = ?"); params.push(p.type); }
  if (auteur !== undefined) { conditions.push("auteur = ? COLLATE NOCASE"); params.push(auteur); }
  if (p.fil !== undefined) { conditions.push("fil = ?"); params.push(p.fil); }
  if (depuis !== undefined) { conditions.push("cree_le >= ?"); params.push(depuis); }
  if (avant !== undefined) { conditions.push("rowid < ?"); params.push(avant); }
  const extrait = requete
    ? `CASE WHEN length(texte) <= ${COURT} THEN highlight(recherche, 0, '[', ']') ELSE snippet(recherche, 0, '[', ']', '…', 12) END`
    : "texte";
  const lus = t.all<Entree>(`SELECT rowid AS r, texte, ${extrait} AS extrait, type, ref, auteur, fil, cree_le FROM recherche
    WHERE ${conditions.join(" AND ")} ORDER BY rowid DESC LIMIT ?`, [...params, RESULTATS_MAX + 1]);

  // Les critères donnés, dans l'ordre des paramètres : rappelés quand rien ne répond, repris dans la ligne de suite.
  const criteres: Array<[string, unknown]> = [["debut_de_mot", p.debut_de_mot || undefined], ["type", p.type], ["auteur", p.auteur],
    ["fil", p.fil], ["depuis", p.depuis], ["avant", avant]].filter(([, v]) => v !== undefined) as Array<[string, unknown]>;
  if (lus.length === 0) {
    const filtres = criteres.filter(([k]) => k !== "debut_de_mot").map(([k, v]) => `${k}: ${v}`).join(", ");
    return { texte: `aucun résultat${mots ? ` pour « ${mots} »` : ""}${filtres ? ` avec ${filtres}` : ""}`, resultats: 0 };
  }
  const page = lus.slice(0, RESULTATS_MAX).map((e) => ({ ...e, extrait: requete ? e.extrait : debutDuTexte(e.texte) }));
  const sortie = page.map((e) => ligneResultat(t, e));
  if (lus.length > RESULTATS_MAX) {
    const appel = [...(mots ? [["mots", mots] as [string, unknown]] : []), ...criteres.filter(([k]) => k !== "avant"), ["avant", page.at(-1)!.r] as [string, unknown]]
      .map(([k, v]) => `${k}: ${typeof v === "string" ? JSON.stringify(v) : v}`).join(", ");
    sortie.push(`pour la suite : salle_chercher(${appel})`);
  }
  return { texte: sortie.join("\n"), resultats: page.length };
}

// ---- « Écrit depuis », état et ligne courte
// « Rien écrit depuis » et « écrit depuis par X » ne sont pas stockés, ils sont recalculés à chaque livraison
// (et à chaque sondage de la vue) en relisant le disque. Seule l'égalité des blobs attribue une écriture : jamais la
// date d'un commit (la file git est asynchrone, lancer.ts commiterOutil).

export type FaitLu = { id: number; cree_le: string; type: T.TypeFait; agent: string; source: string; sujet: string | null;
  statut: T.StatutVerification | null; texte: string; message_id: number | null; details: Record<string, unknown> };
// Où se trouvent les racines des faits (details.racine) : "partage", ou "essai:<nom>" → son dossier.
export type Racines = { partage?: string; essais: Record<string, string> };

type LigneFait = Omit<FaitLu, "details"> & { details_json: string | null };
const lu = ({ details_json, ...f }: LigneFait): FaitLu => ({ ...f, details: details_json ? JSON.parse(details_json) as Record<string, unknown> : {} });
export function lireFait(t: T.Tableau, id: number): FaitLu | undefined {
  const f = t.get<LigneFait>("SELECT * FROM faits WHERE id = ?", [id]);
  return f && lu(f);
}
export function racinesDe(t: T.Tableau, partage: string | undefined): Racines {
  return { partage, essais: Object.fromEntries(T.essais(t).map((e) => [e.nom, e.dossier])) };
}
const dossierDe = (r: Racines, racine: unknown): string | undefined =>
  racine === "partage" ? r.partage : typeof racine === "string" && racine.startsWith("essai:") ? r.essais[racine.slice(6)] : undefined;

const hms = (d: Date) => `${deuxChiffres(d.getHours())}:${deuxChiffres(d.getMinutes())}:${deuxChiffres(d.getSeconds())}`;
const TESTS = new Set(["code_tester", "bash"]); // leur contenu est tout le dossier ; page_voir et moi_finir : la page et ses charges
const LISTE_COURTE = 3;
const listeCourte = (noms: string[]) => noms.length <= LISTE_COURTE ? noms.join(", ") : `${noms.slice(0, LISTE_COURTE).join(", ")} + ${noms.length - LISTE_COURTE} autres`;
const nomFichier = (chemin: string, blob: string | null) => (blob === null ? `${chemin} (supprimé)` : chemin);
const fichiersDu = (f: FaitLu) => (Array.isArray(f.details.fichiers) ? f.details.fichiers as T.FichierCommit[] : []);
const ECRITURES = "('ecriture', 'restauration', 'essai')"; // les faits qui portent des fichiers et leurs blobs

// Le disque relu, comparé à l'empreinte d'après d'une vérification. Pour les tests, le dossier ré-énuméré (un fichier
// créé ou supprimé compte) ; pour une page, la page et ce qu'elle a chargé. Un fichier changé est attribué au fait
// d'écriture le plus récent de même racine, postérieur au contrôle et au plus jusquA, dont un blob égale celui du
// disque ; sinon « auteur pas encore connu ». undefined : racine inconnue (dossier absent de racines).
export function ecritDepuis(t: T.Tableau, verif: FaitLu, racines: Racines, cache: Cache, jusquA: number, maintenant = new Date()):
  { rien: true; relu: string; texte: string; empreintes: Record<string, Empreinte> } | { rien: false; texte: string } | undefined {
  const dir = dossierDe(racines, verif.details.racine);
  if (!dir) return undefined;
  const apres = (verif.details.apres ?? {}) as Record<string, Empreinte>;
  const tests = TESTS.has(verif.source);
  const controles = Array.isArray(verif.details.fichiers) ? verif.details.fichiers as string[] : Object.keys(apres);
  const actuel = empreintes(dir, tests ? undefined : controles, cache);
  const cles = tests ? [...new Set([...Object.keys(apres), ...actuel.keys()])].sort() : controles;
  const changes = cles.filter((c) => {
    const a = apres[c], b = actuel.get(c);
    return !a !== !b || (!!a && !!b && (a.blob !== b.blob || a.taille !== b.taille || a.mtimeMs !== b.mtimeMs));
  });
  const relu = hms(maintenant);
  // Réécrit avec les mêmes octets (une annulation remet un fichier en place) : aucun commit ne viendra, le
  // contenu vérifié tient ; dire « auteur pas encore connu » périmait la vérification pour toujours.
  const memeContenu = (c: string) => !!apres[c] && apres[c]!.blob === actuel.get(c)?.blob;
  if (changes.length > 0 && changes.every(memeContenu))
    return { rien: true, relu, texte: `rien écrit depuis, ${listeCourte(changes)} réécrit${changes.length > 1 ? "s" : ""} avec le même contenu (relu à ${relu})`, empreintes: Object.fromEntries(cles.flatMap((c) => { const e = actuel.get(c); return e ? [[c, e]] : []; })) };
  if (changes.length === 0)
    return { rien: true, relu, texte: `rien écrit depuis (relu à ${relu})`, empreintes: Object.fromEntries(cles.flatMap((c) => { const e = actuel.get(c); return e ? [[c, e]] : []; })) };
  const ecritures = t.all<LigneFait>(`SELECT * FROM faits WHERE type IN ${ECRITURES} AND id > ? AND id <= ? ORDER BY id DESC`, [verif.id, jusquA])
    .map(lu).filter((f) => f.details.racine === verif.details.racine);
  const parFait = new Map<number, { f: FaitLu; noms: string[] }>();
  const inconnus: string[] = [];
  for (const c of changes) {
    const b = actuel.get(c)?.blob ?? null;
    const f = ecritures.find((e) => fichiersDu(e).some((x) => x.chemin === c && x.blob === b));
    if (!f) { inconnus.push(nomFichier(c, b)); continue; }
    if (!parFait.has(f.id)) parFait.set(f.id, { f, noms: [] });
    parFait.get(f.id)!.noms.push(nomFichier(c, b));
  }
  const groupes = [...parFait.values()].sort((a, b) => b.f.id - a.f.id).map(({ f, noms }) =>
    `par ${f.agent} (${listeCourte(noms)}, commit ${String(f.details.hash ?? "").slice(0, 7)}, ${heureLocale(f.cree_le)}${f.details.outil === "bash" ? ", attribué au mieux" : ""})`);
  if (groupes.length === 0) return { rien: false, texte: `écrit depuis (${listeCourte(inconnus)}), auteur pas encore connu` };
  return { rien: false, texte: `écrit depuis ${groupes.join(" ; ")}${inconnus.length ? ` ; ${listeCourte(inconnus)}, auteur pas encore connu` : ""}` };
}

// Symétrique : un fait d'écriture touche le contenu vérifié quand, pour un de ses fichiers, la dernière
// vérification antérieure qui le couvre (même racine ; tests : tout le dossier, page : ses fichiers) est « vérifié » et
// que son blob d'après diffère du blob écrit. Le commit tardif d'un contenu déjà contrôlé ne le dit pas.
export function toucheVerifie(t: T.Tableau, ecriture: FaitLu, jusquA: number): string | undefined {
  const fichiers = fichiersDu(ecriture);
  if (fichiers.length === 0) return undefined;
  const verifs = t.all<LigneFait>("SELECT * FROM faits WHERE type = 'verification' AND id < ? AND id <= ? ORDER BY id DESC", [ecriture.id, jusquA])
    .map(lu).filter((v) => v.details.racine === ecriture.details.racine);
  let touche: FaitLu | undefined;
  for (const x of fichiers) {
    const v = verifs.find((v) => TESTS.has(v.source) || (Array.isArray(v.details.fichiers) && (v.details.fichiers as string[]).includes(x.chemin)));
    if (!v || v.statut !== "verifie") continue;
    const avant = ((v.details.apres ?? {}) as Record<string, Empreinte>)[x.chemin]?.blob ?? null;
    if (avant !== x.blob && (!touche || v.id > touche.id)) touche = v;
  }
  return touche && `touche le contenu vérifié par ${touche.agent} à ${heureLocale(touche.cree_le)}`;
}

// L'état de la salle : ce qui a changé depuis la dernière lecture confirmée de l'agent (curseur
// etat_fait_id, 0 au premier état : tout le run). Des faits datés et des paroles citées, rien d'autre.
// deFait/aFait : les faits couverts ]deFait, aFait] ; aMessage : le dernier message pris en compte ; rienEcrit : les
// vérifications dites « rien écrit depuis », avec les empreintes relues (vue) ; messagesLivres : les annonces de
// fil rendues en entier, notées livrées à la confirmation.
export type Livraison = { texte: string; deFait: number; aFait: number; aMessage: number | null; lignes: number; retires: number;
  caracteres: number; rienEcrit: object[]; messagesLivres: number[] };
const LIGNES_MAX = 30;
const LIGNE_MAX = 200; // hors citation

// Une ligne coupée à LIGNE_MAX caractères hors citation (« … ») : une citation suit sa propre règle.
function borner(ligne: string): string {
  let dans = 0, compte = 0, i = 0;
  const c = [...ligne];
  for (; i < c.length; i++) {
    if (c[i] === "«") dans++;
    else if (c[i] === "»" && dans > 0) dans--;
    else if (dans === 0 && ++compte > LIGNE_MAX) return `${c.slice(0, i).join("")}…`;
  }
  return ligne;
}

// Construit sans transaction : les bornes max(faits.id) et max(messages.id) d'abord, puis chaque requête bornée
// par elles (faits et messages ne changent jamais) ; les empreintes du disque ensuite, hors de tout verrou. Ce qui
// s'écrit pendant la construction arrive au suivant. undefined : aucun fait nouveau et aucun message non lu.
export function etatDeLaSalle(t: T.Tableau, agent: string, racines: Racines, o: { cache: Cache; maintenant?: Date }): Livraison | undefined {
  const maxFait = t.get<{ n: number }>("SELECT COALESCE(MAX(id), 0) AS n FROM faits")!.n;
  const maxMessage = t.get<{ n: number }>("SELECT COALESCE(MAX(id), 0) AS n FROM messages")!.n;
  const de = t.get<{ n: number }>("SELECT etat_fait_id AS n FROM memoire_curseurs WHERE agent = ?", [agent])?.n ?? 0;
  const faits = t.all<LigneFait>("SELECT * FROM faits WHERE id > ? AND id <= ? ORDER BY id DESC LIMIT ?", [de, maxFait, LIGNES_MAX]).map(lu);
  const total = t.get<{ n: number }>("SELECT count(*) AS n FROM faits WHERE id > ? AND id <= ?", [de, maxFait])!.n;
  const messagesLivres = T.annoncesCiteesEntieres(t, de, maxFait, LIGNES_MAX);
  const nonLus = t.all<{ nom: string; n: number; premier: number }>(
    `SELECT f.nom, count(*) AS n, MIN(m.id) AS premier FROM messages m JOIN fils f ON f.id = m.fil_id
     LEFT JOIN lectures l ON l.agent = ? AND l.fil_id = m.fil_id
     WHERE m.id > COALESCE(l.dernier_id, 0) AND m.id <= ? AND m.auteur <> ?
       AND NOT EXISTS (SELECT 1 FROM appels_livres x WHERE x.agent = ? AND x.message_id = m.id)
       AND m.id NOT IN (${messagesLivres.map(() => "?").join(", ")})
     GROUP BY m.fil_id ORDER BY MIN(m.id)`, [agent, maxMessage, agent, agent, ...messagesLivres]);
  if (faits.length === 0 && nonLus.length === 0) return undefined;

  const maintenant = o.maintenant ?? new Date();
  const rienEcrit: object[] = [];
  const lignes = faits.map((f) => {
    let suite: string | undefined;
    if (f.type === "verification") {
      const e = ecritDepuis(t, f, racines, o.cache, maxFait, maintenant);
      if (e?.rien) rienEcrit.push({ fait: f.id, relu: e.relu, empreintes: e.empreintes });
      suite = e?.texte;
    } else if (fichiersDu(f).length) suite = toucheVerifie(t, f, maxFait);
    return borner(`${heureLocale(f.cree_le)} ${f.texte}${suite ? ` · ${suite}` : ""}`);
  });
  const derniere = t.get<{ livre_le: string }>(
    "SELECT livre_le FROM memoire_livraisons WHERE agent = ? AND moment <> 'ligne' AND confirme_le IS NOT NULL ORDER BY id DESC LIMIT 1", [agent]);
  const debut = derniere?.livre_le ?? t.get<{ debut: string | null }>("SELECT debut FROM run LIMIT 1")?.debut;
  const depuis = derniere ? `ta dernière lecture (${hms(new Date(derniere.livre_le))})` : `le début du run${debut ? ` (${hms(new Date(debut))})` : ""}`;
  const texte = [`${T.MARQUE_ETAT} ${depuis} jusqu'à ${hms(maintenant)}, messages jusqu'au n° ${maxMessage} :`, ...lignes];
  if (nonLus.length) {
    const n = nonLus.reduce((s, r) => s + r.n, 0);
    texte.push(`non lus : ${nombre(n, "message", "messages")} (${nonLus.map((r) => `${r.nom} ${r.n}`).join(", ")}), à partir du n° ${Math.min(...nonLus.map((r) => r.premier))}`);
  }
  const retires = total - faits.length;
  if (retires > 0) texte.push(`+ ${retires} ${retires > 1 ? "faits plus anciens" : "fait plus ancien"} : salle_chercher(type: "fait") les rend`);
  const s = texte.join("\n");
  return { texte: s, deFait: de, aFait: maxFait, aMessage: maxMessage, lignes: faits.length, retires, caracteres: s.length, rienEcrit, messagesLivres };
}

// Le rappel du but (le « refocus » d'OpenRig) : livré à chaque relance après l'état, pour qu'un agent sorti
// d'un résumé ou d'une veille relise la finalité et pas seulement sa tâche du moment : des choix défendables un à
// un peuvent, bout à bout, trahir la finalité. La tête de la mission (tout ce qui précède
// sa première section « ## », où elle dit son but), les tickets en cours de l'agent, une question. Le but seulement,
// jamais la manière. undefined sans texte de mission.
export const MARQUE_BUT = "[but] La mission de la salle :";
const TETE_MAX = 2000;
export function rappelDuBut(t: T.Tableau, agent: string): string | undefined {
  const mission = t.get<{ m: string | null }>("SELECT mission_texte AS m FROM run LIMIT 1")?.m?.trim();
  if (!mission) return undefined;
  const fin = mission.search(/^##\s/m);
  let tete = (fin < 0 ? mission : mission.slice(0, fin)).trim();
  if (tete.length > TETE_MAX) {
    const coupe = tete.lastIndexOf("\n\n", TETE_MAX);
    tete = `${tete.slice(0, coupe > 0 ? coupe : TETE_MAX).trim()}\n\n[…]`;
  }
  const tickets = T.listerTickets(t, { etat: "en_cours", charge: agent });
  // Pour le chef, le but se sert en répartissant ; la question des constructeurs le tournait vers le fond.
  const chef = t.get<{ role: string | null }>("SELECT role FROM agents WHERE nom = ?", [agent])?.role === "chef";
  return [MARQUE_BUT, tete,
    ...(tickets.length ? [`Tes tickets en cours : ${tickets.map((k) => `#${k.id} « ${k.titre} »`).join(", ")}.`] : []),
    chef ? "Chaque agent présent a-t-il une part, chaque ticket ouvert un porteur présent, chaque exigence son contrôle ?" : "Ce que tu fais en ce moment sert-il ce but ?"].join("\n\n");
}

// L'état d'un siège (rôles des agents) : livré au premier message d'un nouvel occupant (relance après une
// panne, ou passation), avant la note du sortant et le rappel du but. Des faits constatés par la salle, filtrés sur le
// siège : les tickets ouverts qui lui sont confiés (repris du sortant), les alertes ouvertes par le sortant, ses
// vérifications avec « écrit depuis », les pancartes, les signatures révoquées et, pour le gardien-mesureur, son bureau
// privé (celui du premier occupant, qui reste celui du siège). undefined : pas un nouvel occupant.
export const MARQUE_SIEGE = "[siège]";
const NOM_ROLE: Record<string, string> = { chef: "chef", integrateur: "intégrateur", assembleur: "assembleur", constructeur: "constructeur", recette: "recette", gardien: "gardien-mesureur" };
const VERIFS_SIEGE = 10;
export function etatDuSiege(t: T.Tableau, entrant: string, racines: Racines, o: { cache: Cache; maintenant?: Date }): string | undefined {
  const sortant = T.predecesseur(t, entrant);
  if (!sortant) return undefined;
  const maintenant = o.maintenant ?? new Date();
  const s = t.get<{ role: string | null; etat: string; raison_sortie: string | null }>("SELECT role, etat, raison_sortie FROM agents WHERE nom = ?", [sortant]);
  const role = NOM_ROLE[s?.role ?? ""] ?? s?.role ?? "?";
  const ouverts = (k: T.Ticket) => k.etat !== "ferme";
  const ligne = (k: T.Ticket) => `#${k.id}${k.sorte === "alerte" ? ` · alerte${k.exigence ? ` sur ${k.exigence}` : ""}` : ""} · ${k.type} · ${k.etat} · ${k.auteur}${k.charge ? ` → ${k.charge}` : ""} · ${k.titre}${k.chemins ? ` · chemins : ${T.cheminsDuTicket(k).join(", ")}` : ""}`;
  const tickets = T.listerTickets(t, { charge: entrant }).filter(ouverts);
  const alertes = T.listerTickets(t).filter((k) => ouverts(k) && k.sorte === "alerte" && k.auteur === sortant);
  const maxFait = t.get<{ n: number }>("SELECT COALESCE(MAX(id), 0) AS n FROM faits")!.n;
  const verifs = t.all<LigneFait>("SELECT * FROM faits WHERE type = 'verification' AND agent = ? ORDER BY id DESC LIMIT ?", [sortant, VERIFS_SIEGE]).map(lu).map((f) => {
    const e = ecritDepuis(t, f, racines, o.cache, maxFait, maintenant);
    return borner(`${heureLocale(f.cree_le)} ${f.texte}${e ? ` · ${e.texte}` : ""}`);
  });
  const pancartes = T.reclamations(t).filter((p) => p.agent === entrant).map((p) => p.chemin);
  const revoquees = T.aTable(t, "attestations") ? t.all<{ exigence: string }>("SELECT DISTINCT exigence FROM attestations WHERE agent = ? AND revoquee_le IS NOT NULL ORDER BY exigence", [sortant]).map((a) => a.exigence) : [];
  let premier = sortant;
  for (let p = T.predecesseur(t, premier); p; p = T.predecesseur(t, premier)) premier = p;
  const bureau = t.get<{ bureau: string | null }>("SELECT bureau FROM agents WHERE nom = ?", [premier])?.bureau;
  return [`${MARQUE_SIEGE} Tu prends le siège de ${role} que tenait ${sortant} (${s?.etat ?? "?"}${s?.raison_sortie ? ` : ${s.raison_sortie}` : ""}). L'état du siège constaté par la salle à ${hms(maintenant)} :`,
    tickets.length ? `tickets ouverts qui te sont confiés :\n${tickets.map((k) => `- ${ligne(k)}`).join("\n")}` : "tickets ouverts qui te sont confiés : aucun",
    ...(alertes.length ? [`alertes ouvertes par ${sortant} :\n${alertes.map((k) => `- ${ligne(k)}`).join("\n")}`] : []),
    verifs.length ? `vérifications de ${sortant}, les plus récentes d'abord :\n${verifs.map((v) => `- ${v}`).join("\n")}` : `vérifications de ${sortant} : aucune`,
    `pancartes à ton nom : ${pancartes.length ? pancartes.join(", ") : "aucune"}`,
    ...(revoquees.length ? [`signatures de ${sortant} révoquées au changement d'occupant : ${revoquees.join(", ")}`] : []),
    ...(s?.role === "gardien" && bureau ? [`bureau privé du siège : ${path.join(bureau, "prive")}`] : []),
  ].join("\n");
}
// La note du sortant, citée telle quelle : une parole, jamais un fait. undefined après une panne.
export function notePassation(t: T.Tableau, entrant: string): string | undefined {
  const p = T.passationPour(t, entrant);
  return p && `Note de passation ${T.deNom(p.agent)}, déclaré par ${p.agent}, non vérifié : « ${p.texte} »`;
}

// La ligne courte : à la fin d'un outil, les faits d'autres agents au-delà de MAX(ligne_fait_id, plancher)
// qui concernent l'agent — une écriture, restauration ou adoption d'un de ses fichiers, toute vérification, un départ,
// une fermeture de fil. Ses fichiers : ceux de ses faits d'écriture et de vérification (en base), et fichiersVus, les
// clés cleFichier de ses read, write et edit de ce lancement. Une requête indexée, rien quand rien n'a changé.
// undefined : aucun fait nouveau d'un autre ; texte absent : des faits considérés (jusqu'à aFait), aucun ne le concerne.
export const cleFichier = (racine: string, chemin: string) => `${racine}:${chemin}`;
const COURTE_MAX = 300;
const COURTE_FAITS = 3;
const DEPART = /^\S+ · (fini|viré|perdu)(?=\s|$)/u;
const FERME = /^\S+ fermé(?=\s|$)/u;

function fichiersSiens(t: T.Tableau, agent: string): Set<string> {
  const siens = new Set<string>();
  for (const f of t.all<LigneFait>(`SELECT * FROM faits WHERE agent = ? AND type IN ('ecriture', 'restauration', 'essai', 'verification')`, [agent]).map(lu)) {
    const racine = String(f.details.racine ?? "");
    const chemins = f.type === "verification" ? (Array.isArray(f.details.fichiers) ? f.details.fichiers as string[] : []) : fichiersDu(f).map((x) => x.chemin);
    for (const c of chemins) siens.add(cleFichier(racine, c));
  }
  return siens;
}

// Ce qui concerne l'agent lui-même : un agent qui enchaîne les bash sans lire la salle doit quand même apprendre qu'on
// l'arrête ou que son ticket et sa pancarte sont passés à un autre. Des lignes « [salle] pour toi : », une par fait ou par message, avant la ligne des faits
// de la salle : son écriture par bash annulée, un de ses tickets confié à un autre, une de ses pancartes passée à un
// autre, et les messages nouveaux qui s'adressent à lui (T.sAdresseA, la règle des questions adressées), au plus
// COURTE_MESSAGES, chacun en une ligne. Un message est considéré une fois : le curseur est le a_message de ses lignes
// courtes (memoire_livraisons), et un message lu (lectures) ou livré comme appel (appels_livres) ne revient pas. Chaque
// ligne fait au plus COURTE_MAX caractères. Témoin (ESSAIM_MEMOIRE=non) : seule l'annulation, qui est un refus du rôle.
const POUR_TOI = "[salle] pour toi : ";
const COURTE_MESSAGES = 3;
const EXTRAIT_MAX = 160;
const couper = (texte: string) => ([...texte].length <= COURTE_MAX ? texte : `${[...texte].slice(0, COURTE_MAX - 1).join("")}…`);
type Annule = { chemin: string; porteur: string; ticket?: number };
const aQui = (a: Annule) => `${a.porteur}${a.ticket !== undefined ? ` (ticket #${a.ticket})` : ""}`;
function ligneAnnulation(annules: Annule[]): string {
  const chemins = annules.map((a) => a.chemin).join(", ");
  const aQuiTexte = annules.length === 1 ? `ce fichier est à ${aQui(annules[0]!)}` : annules.map((a) => `${a.chemin} est à ${aQui(a)}`).join(", ");
  return `refusé : tes changements de ${chemins} (par bash) ont été annulés ; ${aQuiTexte}`;
}
function extrait(m: T.Message, max = EXTRAIT_MAX): string {
  const l = m.texte.replace(/\s+/g, " ").trim();
  const c = [...l];
  const cite = c.length <= max ? l : `${c.slice(0, max).join("")}… (suite : salle_chercher(numero: ${m.id}))`;
  return `message ${m.id} de ${m.auteur} (${m.fil}) : « ${cite} »`;
}

export function ligneCourte(t: T.Tableau, agent: string, fichiersVus: Set<string>, plancher: number, o: { temoin?: boolean } = {}):
  { texte?: string; deFait: number; aFait: number; aMessage: number | null; lignes: number; retires: number } | undefined {
  const curseur = t.get<{ n: number }>("SELECT ligne_fait_id AS n FROM memoire_curseurs WHERE agent = ?", [agent])?.n ?? 0;
  const de = Math.max(curseur, plancher);
  // Les faits d'un autre ; de lui-même, seulement l'annulation de son écriture (le fait est à son nom).
  const nouveaux = t.all<LigneFait>(`SELECT * FROM faits WHERE id > ? AND (agent <> ? OR (type = 'restauration' AND json_extract(details_json, '$.annule') IS NOT NULL)) ORDER BY id`, [de, agent]).map(lu);
  const aFait = nouveaux.at(-1)?.id ?? de;
  const personnels: string[] = [];
  const courts: Array<{ f: FaitLu; court: string }> = [];
  const confies: string[] = []; // les chemins des tickets confiés à un autre : leurs pancartes ne se redisent pas
  const pancartes: FaitLu[] = [];
  let siens: Set<string> | undefined;
  const sien = (racine: string, chemin: string) => { siens ??= fichiersSiens(t, agent); const k = cleFichier(racine, chemin); return siens.has(k) || fichiersVus.has(k); };
  for (const f of nouveaux) {
    const annule = f.details.annule as { fichiers?: Annule[] } | undefined;
    if (annule) { if (f.agent === agent && annule.fichiers?.length) personnels.push(ligneAnnulation(annule.fichiers)); continue; }
    if (o.temoin) continue;
    if (f.type === "ticket" && f.details.de === agent && typeof f.details.vers === "string") {
      const k = T.lireTicket(t, Number(String(f.sujet).slice(1)));
      const chemins = k ? T.cheminsDuTicket(k) : [];
      confies.push(...chemins);
      personnels.push(`ton ticket ${f.sujet}${chemins.length ? ` (${chemins.join(", ")})` : ""} est maintenant à ${f.details.vers}`);
      continue;
    }
    if (f.type === "pancarte" && f.details.de === agent) { pancartes.push(f); continue; }
    const hash = String(f.details.hash ?? "").slice(0, 7);
    let court: string | undefined;
    if (f.type === "verification") court = `${f.sujet} ${MOT_STATUT[f.statut ?? "inconnu"]} par ${f.agent} (${f.source})`;
    else if (f.type === "agent") { const m = DEPART.exec(f.texte); if (m) court = `${f.agent} ${m[1]}`; }
    else if (f.type === "fil") { if (FERME.test(f.texte)) court = `${f.sujet} fermé`; }
    else {
      const concernes = fichiersDu(f).filter((x) => sien(String(f.details.racine ?? ""), x.chemin)).map((x) => nomFichier(x.chemin, x.blob));
      if (concernes.length) {
        const pluriel = concernes.length > 1 ? "s" : "";
        const quoi = f.type === "restauration" ? `restauré${pluriel}` : `écrit${pluriel}`;
        const essai = f.type === "essai" ? `essai ${f.sujet} adopté, ` : "";
        court = `${listeCourte(concernes)} ${quoi} par ${f.agent} (${essai}commit ${hash}${f.details.outil === "bash" ? ", attribué au mieux" : ""})`;
      }
    }
    if (court) courts.push({ f, court });
  }
  // Une pancarte qui suit un ticket ne se redit pas, qu'un autre l'ait confié (la ligne du ticket) ou l'agent lui-même
  // (il a rendu son ticket : ses propres faits de ticket, hors de nouveaux).
  if (pancartes.length) for (const r of t.all<{ sujet: string }>("SELECT sujet FROM faits WHERE id > ? AND agent = ? AND type = 'ticket'", [de, agent])) {
    const k = T.lireTicket(t, Number(r.sujet.slice(1)));
    if (k) confies.push(...T.cheminsDuTicket(k));
  }
  for (const f of pancartes) if (!confies.includes(String(f.sujet))) personnels.push(`ta pancarte sur ${f.sujet} est maintenant à ${f.agent}`);

  // Les messages qui s'adressent à lui, nouveaux depuis sa dernière ligne courte, non lus et pas livrés comme appels.
  let aMessage: number | null = null;
  const messages: string[] = [];
  if (!o.temoin) {
    const mots = T.alias(t, agent);
    const depuis = t.get<{ n: number | null }>("SELECT MAX(a_message) AS n FROM memoire_livraisons WHERE agent = ? AND moment = 'ligne'", [agent])?.n ?? 0;
    aMessage = t.get<{ n: number }>("SELECT COALESCE(MAX(id), 0) AS n FROM messages")!.n;
    const adresses = t.all<T.Message>(
      `SELECT m.id, f.nom AS fil, m.auteur, m.cree_le, m.texte
       FROM messages m JOIN fils f ON f.id = m.fil_id
       LEFT JOIN lectures l ON l.agent = ? AND l.fil_id = m.fil_id
       WHERE m.id > ? AND m.id <= ? AND m.id > COALESCE(l.dernier_id, 0) AND m.auteur <> ? AND m.auteur <> 'salle'
         AND NOT EXISTS (SELECT 1 FROM appels_livres x WHERE x.agent = ? AND x.message_id = m.id)
       ORDER BY m.id`, [agent, depuis, aMessage, agent, agent]).filter((m) => mots.some((mot) => T.sAdresseA(m.texte, mot)));
    // Une consigne (signée lanceur, « X : consigne : … ») passe en tête et en entier, quel que soit le nombre de
    // messages : derrière les autres, elle attendait trop.
    const estConsigne = (m: T.Message) => m.auteur === "lanceur" && m.texte.includes(T.MARQUE_CONSIGNE);
    const consignes = adresses.filter(estConsigne), autres = adresses.filter((m) => !estConsigne(m));
    const montres = autres.slice(-COURTE_MESSAGES);
    const reste = autres.length - montres.length;
    messages.push(...consignes.map((m) => extrait(m, T.CONSIGNE_MAX_SIGNES)));
    if (reste) messages.push(`+${reste} ${reste > 1 ? "messages plus anciens s'adressent" : "message plus ancien s'adresse"} à toi, à partir du n° ${autres[0]!.id} (salle_lire)`);
    messages.push(...montres.map((m) => extrait(m)));
  }
  if (nouveaux.length === 0 && messages.length === 0) return undefined;
  const pourToi = [...personnels, ...messages].map((l) => couper(`${POUR_TOI}${l}`));

  let salle: { texte: string; n: number; reste: number } | undefined;
  if (courts.length) {
    const recents = [...courts].reverse();
    const tete = `[salle] depuis ${heureLocale(courts[0]!.f.cree_le)} : `;
    for (let n = Math.min(COURTE_FAITS, recents.length); n >= 1 && !salle; n--) {
      const reste = recents.length - n;
      const texte = `${tete}${recents.slice(0, n).map((x) => x.court).join(" ; ")}${reste ? ` ; +${reste} ${reste > 1 ? "faits" : "fait"} (salle_chercher(type: "fait"))` : ""}`;
      if ([...texte].length <= COURTE_MAX || n === 1) salle = { texte: couper(texte), n, reste };
    }
  }
  const lignes = [...pourToi, ...(salle ? [salle.texte] : [])];
  if (lignes.length === 0) return { deFait: de, aFait, aMessage, lignes: 0, retires: 0 };
  return { texte: lignes.join("\n"), deFait: de, aFait, aMessage, lignes: (salle?.n ?? 0) + pourToi.length, retires: salle?.reste ?? 0 };
}

// ---- Bilan
