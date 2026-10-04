// L'extension pi de l'essaim : les gestes d'un agent vers le tableau, voir vers un navigateur, ses outils
// de travail (plan_du_code, assembler, mesurer, comparer, tester, lire_web), trois demandes
// au dépôt git du run (restaurer, essai, adopter) et les tickets.
// Chargée par pi avec `-e`, donc sous Node : le tableau est ouvert avec
// node:sqlite (ouvrirNode). Le second argument de la fabrique n'existe que
// pour les tests, qui tournent sous Bun et passent ouvrirBun ; pi n'appelle
// jamais la fabrique qu'avec un seul argument.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Type } from "typebox";
import { BRANCHE, cible, contenuDans, fichiersDeLEssai, fichiersDuCommit, journal, racineDuFait, type Reponse } from "./depot.ts";
import * as M from "./memoire.ts";
import * as P from "./preuves.ts";
import { changementsSiegeMax, DROITS, NOMS_ROLES, PORTEUR_GEL, porteurDuLivrable, refusAlerte, refusConfier, refusDuRole, refusMotif, repartiteur, ROLES, SOMMEILS_MAX as SOMMEILS_MAX_DEFAUT, veillesSansLimite, type Cible, type ContexteRefus, type Membre, type Role } from "./roles.ts";
import { ouvrirNode } from "./tableau-node.ts";
import * as T from "./tableau.ts";
import { outilsRetiresDuRole } from "./noms-outils.ts";
import * as S from "./surveillant.ts";

const texte = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });
// Un refus : « refusé : <le fait>. <ce qui le lève>. », sans conseil. La raison s'écrit "<fait>. <levée>",
// sans préfixe ni point final ; ses lignes suivantes (une liste) viennent après le point.
const refusAvec = (prefixe: string, raison: string) => {
  const [tete, ...suite] = raison.split("\n");
  return texte([`${prefixe} : ${tete}.`, ...suite].join("\n"));
};
const refuse = (raison: string) => refusAvec("refusé", raison);
const refuseUneFois = (raison: string) => refusAvec("refusé une fois", raison);
const tour = (a: { apres: string; resteS: number }) =>
  `tour de parole, ${a.apres} n'a pas encore posté et toi non plus. Se lève dès que ${a.apres} poste, ou dans ${a.resteS} s`;

export default function (pi: ExtensionAPI, ouvrir: (chemin: string) => T.Tableau = ouvrirNode) {
  const agent = process.env.ESSAIM_AGENT;
  const chemin = process.env.ESSAIM_TABLEAU;
  if (!agent || !chemin) throw new Error("ESSAIM_AGENT et ESSAIM_TABLEAU sont obligatoires");
  const t = ouvrir(chemin);
  T.majAgent(t, agent, { pid: process.pid });

  const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // Rôles des agents : le rôle du siège, posé par le lanceur (ESSAIM_ROLE) ; absent sans ## Type, et alors aucun
  // refus de rôle. L'équipe et ses rôles se relisent au tableau à chaque appel (un siège peut changer d'occupant).
  const role = (ROLES as string[]).includes(process.env.ESSAIM_ROLE ?? "") ? process.env.ESSAIM_ROLE as Role : undefined;
  const equipeRoles = (): Membre[] => (T.aColonne(t, "agents", "role")
    ? t.all<{ nom: string; role: string | null; present: number; suppleantDe: string | null }>(`SELECT nom, role, etat IN ('actif', 'dormant') AS present${T.aColonne(t, "agents", "suppleant_de") ? ", suppleant_de AS suppleantDe" : ", NULL AS suppleantDe"} FROM agents ORDER BY rowid`).map((a) => ({ ...a, present: a.present === 1 }))
    : []);
  // Celui qui répartit le travail parmi les présents (le chef ; le suppléant qui tient son siège ; l'intégrateur sans chef).
  const repartiteurPresent = () => repartiteur(equipeRoles().filter((a) => a.present !== false))?.nom;
  // Partir sans demander : la question du constructeur à qui répartit, lue pour le refus de moi_finir.
  const reponseRepartiteurMs = Number(process.env.ESSAIM_REPONSE_REPARTITEUR_MS ?? 10 * 60_000);
  const questionRepartiteur = () => {
    const rep = role === "constructeur" ? repartiteurPresent() : undefined;
    return rep && rep !== agent ? { questionRepartiteur: T.questionAuRepartiteur(t, agent, rep) ?? null, reponseRepartiteurMs } : {};
  };
  // Les outils par rôle : un outil que le rôle ne peut jamais appeler n'est pas enregistré (noms-outils.ts).
  const retires = new Set(role ? outilsRetiresDuRole(role, { suppleantDe: process.env.ESSAIM_SUPPLEANT_DE }) : []);
  const enregistrer = pi.registerTool.bind(pi);
  pi.registerTool = ((d: { name: string }) => { if (!retires.has(d.name)) enregistrer(d as never); }) as typeof pi.registerTool;
  // Le surveillant parle au chef, au gardien et à la recette présents,
  // à personne d'autre, par salle_poster comme par le message de moi_dormir.
  const refusParole = (texte: string): string | undefined => {
    if (role !== "surveillant") return undefined;
    const equipe = equipeRoles();
    const membres = equipe.filter((a) => a.present !== false && a.nom !== agent).map((a) => ({ nom: a.nom, alias: T.alias(t, a.nom) }));
    return S.refusParoleSurveillant(texte, S.destinatairesSurveillant(equipe), membres);
  };
  const REFUS_PAROLE = " ; pour le surveillant, un message qui ne commence pas par le prénom du chef, du gardien ou de la recette, ou qui en nomme un autre en tête, définitif pour ce rôle";
  const contexteRole = (): ContexteRefus => ({ agent, equipe: equipeRoles(), pancartes: T.reclamations(t), livrable: T.normaliserChemin(process.env.ESSAIM_LIVRABLE ?? "") });

  // En tête de la boîte, les questions qui nomment l'agent et restent sans réponse de lui : lues une fois,
  // elles ne disparaissent plus du regard tant qu'il n'a pas posté dans leur fil.
  // Fils de concentration : dans le périmètre de la lecture seulement (fil = undefined : tous les fils).
  const rappel = (fil?: string): string | undefined => {
    const qs = T.questionsEnAttente(t, agent, T.alias(t, agent), Infinity).filter((q) => fil === undefined || q.fil === fil).slice(0, 3);
    if (qs.length === 0) return undefined;
    const court = (s: string) => { const l = s.replace(/\s+/g, " ").trim(); return l.length > 200 ? l.slice(0, 200) + "…" : l; };
    return ["Questions qui te sont adressées, sans réponse de toi dans leur fil :", ...qs.map((q) => `- [${q.fil}] message ${q.id}, ${q.auteur} : ${court(q.texte)}`)].join("\n");
  };
  // Les messages nouveaux, une ligne chacun, ou undefined s'il n'y a rien ; le rappel des questions devant.
  // Fils de concentration : lecture en trois temps, sans transaction autour (sous Node elles ne
  // s'imbriquent pas ; acquitter tient la sienne). La mémoire garde l'exception d'une page à l'autre. Les appels
  // (un message d'un autre fil qui nomme l'agent) sortent en tête, tels quels.
  // Résumés de lots : un lot clos d'un autre fil compris dans le retard est demandé au lanceur (ligne lots en
  // attente, créée par preparer) ; l'outil sonde le tableau jusqu'à une seule échéance pour toute la lecture
  // (ESSAIM_ATTENTE_RESUME, 25 s), ou tout de suite si le run est en pause. Un lot en échec est réactivé une fois par
  // lecture ; ce qui n'est pas fait à temps est livré brut et sera prêt pour le lecteur suivant.
  const memoire: T.MemoireLecture = {};
  const pause = join(dirname(chemin), "pause");
  const lireBoite = async (fil?: string): Promise<string | undefined> => {
    const selection = T.selectionner(t, agent, fil, memoire);
    const echeance = Date.now() + Number(process.env.ESSAIM_ATTENTE_RESUME ?? 25_000);
    let premiere = true;
    let p!: ReturnType<typeof T.preparer>;
    for (;;) {
      let enCours = false;
      p = T.preparer(t, agent, selection, { limite: 50, obtenirResume: (lot) => {
        if (lot.etat === "fait" && lot.texte !== null) return lot.texte;
        if (lot.etat === "attente" || lot.etat === "prise" || (premiere && lot.etat === "echec" && T.reactiverLot(t, lot.id))) enCours = true;
        return undefined;
      } });
      premiere = false;
      if (!enCours || Date.now() >= echeance || existsSync(pause)) break;
      await dormir(process.env.ESSAIM_TEST ? 20 : 2000);
    }
    T.acquitter(t, agent, p.elements);
    // Chaque livraison de résumés laisse sa trace, quel que soit l'outil qui a lu.
    const livres = p.elements.flatMap((e) => (e.type === "resume" ? [e.lot.id] : []));
    if (livres.length) T.ajouterEvenement(t, { agent, type: "resumes_livres", resultat: JSON.stringify(livres) });
    const noms = new Map(selection.fils.map((r) => [r.filId, r.nom]));
    const brutes = p.elements.flatMap((e) => (e.type === "brut" ? [e.message.id] : []));
    const dehors = new Set(brutes.length && T.aColonne(t, "messages", "hors_fil")
      ? t.all<{ id: number }>(`SELECT id FROM messages WHERE hors_fil = 1 AND id IN (${brutes.map(() => "?").join(",")})`, brutes).map((r) => r.id) : []);
    const lignes = p.elements.map((e) => {
      if (e.type === "appel") return `[${e.message.fil}] message ${e.message.id}, ${e.message.auteur} (te nomme) : ${e.message.texte}`;
      if (e.type === "resume") {
        const nom = noms.get(e.lot.fil_id);
        return `[${nom}] résumé des messages ${e.lot.debut_id} à ${e.lot.fin_id} (lot ${e.lot.id}) : ${e.texte}`;
      }
      const m = e.message;
      return `[${m.fil}] ${m.cree_le} ${m.auteur}${dehors.has(m.id) ? " (hors du fil)" : ""} : ${m.texte}`;
    });
    if (p.reste) lignes.push("(il en reste : salle_lire rend la suite)");
    const r = rappel(selection.perimetre === "tous" ? undefined : fil ?? T.filDe(t, agent)?.fil);
    if (lignes.length === 0) return r;
    return r ? `${r}\n\n${lignes.join("\n")}` : lignes.join("\n");
  };

  pi.registerTool({
    name: "salle_poster", label: "Poster",
    description: "Écrire un message sur le tableau, visible de tous. Rend : le numéro du message et le fil où il est posté ; au premier message, l'outil patiente jusqu'à ce que la moitié de la salle ait parlé, puis rend aussi les messages nouveaux. Refus : au démarrage, tant que l'agent qui te précède dans `salle_equipe` n'a rien posté et que tu n'as rien posté (tour de parole), levé dès qu'il poste ou au bout du délai indiqué en secondes" + (role === "surveillant" ? REFUS_PAROLE : "") + ".",
    promptSnippet: "salle_poster(texte, fil?) : écrire un message ; sans fil, dans principal",
    parameters: Type.Object({ texte: Type.String({ description: "le message" }), fil: Type.Optional(Type.String({ description: "le fil où poster ; un fil inconnu est créé ; sans fil : principal" })) }),
    async execute(_id, p) {
      const fil = p.fil ?? "principal";
      // Le tour de parole du démarrage : le premier message attend celui d'avant. Pas dans un run à rôles :
      // il sert à des agents identiques ; avec des rôles, les sièges uniques attendraient des constructeurs en veille.
      const attente = role ? null : T.tourDeParole(t, agent, Number(process.env.ESSAIM_TOUR_MS ?? 90_000));
      if (attente) return refuse(tour(attente));
      const parole = refusParole(p.texte);
      if (parole) return refuse(parole);
      const dejaParle = !!t.get<{ un: number }>("SELECT 1 AS un FROM messages WHERE auteur = ? LIMIT 1", [agent]);
      const id = T.poster(t, agent, p.texte, fil);
      const poste = `message ${id} posté dans ${fil}`;
      if (dejaParle || role) return texte(poste);
      // Après le premier message, l'attente forcée : l'outil ne rend la main que quand la moitié de la salle a
      // parlé, ou au bout du délai de secours. Rien d'autre ne peut se faire pendant ce temps, et rien ne se paie.
      const grace = Number(process.env.ESSAIM_QUORUM_MS ?? (process.env.ESSAIM_TEST ? 0 : 300_000));
      let q = T.quorumDemarrage(t, agent, grace);
      if (!q) return texte(poste);
      while (q) { await dormir(process.env.ESSAIM_TEST ? 50 : 2000); q = T.quorumDemarrage(t, agent, grace); }
      const parle = t.get<{ n: number }>("SELECT COUNT(DISTINCT m.auteur) AS n FROM messages m JOIN agents a ON a.nom = m.auteur")?.n ?? 0;
      const total = t.get<{ n: number }>("SELECT COUNT(*) AS n FROM agents")?.n ?? 0;
      const tete = `${poste} ; ${parle >= Math.ceil(total / 2) ? `la moitié de la salle a parlé (${parle} sur ${total})` : `délai d'attente écoulé, ${parle} sur ${total} ont parlé`}`;
      const b = await lireBoite();
      return texte(b ? `${tete}\n${b}` : tete);
    },
  });

  // Lire le nouveau. Pour relire, salle_chercher lit les messages par numéro ou par plage.
  pi.registerTool({
    name: "salle_lire", label: "Lire la salle",
    description: "Lire les messages nouveaux depuis ta dernière lecture et les marquer lus. Rend : en tête, les questions qui te nomment et auxquelles tu n'as pas répondu dans leur fil ; puis au plus 50 éléments, du plus ancien au plus récent : d'abord les messages qui te nomment, tels quels, puis les autres ; un gros retard sur un fil arrive en résumés de lots, chacun citant ses messages ; ou « rien de nouveau ».",
    promptSnippet: "salle_lire(fil?) : lire les messages nouveaux depuis ta dernière lecture et les marquer lus",
    parameters: Type.Object({ fil: Type.Optional(Type.String({ description: "ne lire que ce fil" })) }),
    async execute(_id, p) {
      return texte((await lireBoite(p.fil)) ?? "rien de nouveau");
    },
  });

  // Second cerveau : chercher dans l'index FTS5 que remplissent les déclencheurs du tableau, ou lire
  // par numéro ; rien n'est marqué lu. Absent d'un run témoin (--memoire non). memoire.ts est chargé au premier appel.
  if (process.env.ESSAIM_MEMOIRE !== "non") {
    pi.registerTool({
      name: "salle_chercher", label: "Chercher dans la salle",
      description: "Chercher par mots ou par filtres dans les messages, les résumés de lots, les commits, les faits constatés par la salle et les tickets, ou lire un message, une plage de messages ou un fait par numéro, sans rien marquer lu. Rend : au plus 20 résultats, du plus récent au plus ancien, chacun avec son type, sa référence, sa date, son auteur, son fil, un extrait et les messages qui le reprennent ; un résumé de lot est signalé comme écrit par un modèle ; puis le nombre d'où continuer ; ou « aucun résultat pour … ». Par numéro : les messages entiers, ou le fait entier. Refus : ni mots, ni numéro, ni filtre, levé avec l'un d'eux ; plage de plus de 50 messages, levé avec une plage de 50 au plus ; numéro avec un type autre que message ou fait, levé avec l'un des deux ; type inconnu, levé avec message, resume, commit, fait ou ticket ; date illisible, levé avec « HH:MM », « HH:MM:SS » ou une date ISO ; `avant` qui n'est pas un nombre, levé avec le nombre rendu par la réponse précédente ; aucun mot cherchable (ponctuation seule), levé avec un mot.",
      promptSnippet: "salle_chercher(mots?, numero?, jusqua?, debut_de_mot?, type?, auteur?, fil?, depuis?, avant?) : chercher par mots dans ce qui s'est dit et fait dans la salle, ou lire des messages par numéro",
      parameters: Type.Object({
        mots: Type.Optional(Type.String({ description: "les mots cherchés, tous présents ; chaque mot pris tel quel, sans accent ni casse (navigation.js se cherche tel quel) ; une expression entre guillemets reste une expression" })),
        numero: Type.Optional(Type.Number({ description: "lire le message de ce numéro en entier ; avec `jusqua`, les messages de `numero` à `jusqua`, 50 au plus ; avec type fait, le fait de ce numéro en entier, citation complète comprise" })),
        jusqua: Type.Optional(Type.Number({ description: "le dernier numéro de la plage de messages qui commence à `numero`" })),
        debut_de_mot: Type.Optional(Type.Boolean({ description: "vrai : chaque mot vaut aussi pour les mots qui commencent par lui (navig trouve navigation) ; faux par défaut" })),
        type: Type.Optional(Type.String({ description: "message, resume (résumé de lot), commit, fait ou ticket ; sans type : tous" })),
        auteur: Type.Optional(Type.String({ description: "l'agent, par son prénom ou son surnom" })),
        fil: Type.Optional(Type.String({ description: "le fil ; ne retient que des messages et des résumés de lots" })),
        depuis: Type.Optional(Type.String({ description: "une heure « HH:MM » ou « HH:MM:SS » du jour du run, ou une date ISO : seulement ce qui est entré depuis" })),
        avant: Type.Optional(Type.Union([Type.Number(), Type.String()], { description: "pour la page suivante : le nombre rendu par la réponse précédente" })),
      }),
      async execute(_id, p) {
        const { chercher } = await import("./memoire.ts");
        const r = chercher(t, p);
        return "refus" in r ? refuse(r.refus) : texte(r.texte);
      },
    });
  }

  // Patienter sans rendre la main : un tour terminé sans `fini` coûte une passe.
  pi.registerTool({
    name: "salle_attendre", label: "Attendre",
    description: "Patienter sans rendre la main, puis lire tes messages nouveaux comme `salle_lire`. Rend : ce que rend `salle_lire`, ou « N s d'attente, rien de nouveau ». Un tour terminé sans `moi_finir` ni `moi_dormir` coûte une passe. Ne refuse jamais.",
    promptSnippet: "salle_attendre(secondes?) : patienter sans rendre la main, puis lire tes messages nouveaux",
    parameters: Type.Object({ secondes: Type.Optional(Type.Number({ description: "durée de l'attente en secondes, 10 par défaut, 60 au plus" })) }),
    async execute(_id, p) {
      const s = Math.min(60, Math.max(0, p.secondes ?? 10));
      await dormir(s * 1000);
      return texte((await lireBoite()) ?? `${s} s d'attente, rien de nouveau`);
    },
  });

  // Se mettre en veille au lieu de partir. `fini` est sans retour : un agent fini ne peut plus être
  // rappelé. `dormir` termine le tour comme `fini`,
  // mais l'agent reste de la salle : c'est le lanceur qui tient le sommeil, processus fermé — rien ne
  // tourne, rien ne se paie — et qui le relance quand un message le nomme, au besoin après un résumé.
  // Cinq sommeils par agent : au-delà, la salle ne gagne plus rien à le garder (boucle de
  // politesse). Rôles : sans limite pour tous les sièges (roles.veillesSansLimite).
  const SOMMEILS_MAX = Number(process.env.ESSAIM_SOMMEILS_MAX ?? SOMMEILS_MAX_DEFAUT);
  // Ses tickets ouverts, rappelés avant la veille ou le départ. Rappel, pas verrou : redemander avec les mêmes tickets passe, sinon un ticket qu'il ne peut pas
  // corriger le bloquerait pour toujours.
  // Rôles : une alerte est dite, un motif de clôture suit l'état, un ticket bloqué nomme celui qui le bloque.
  const ligneTicket = (k: T.Ticket) => `#${k.id}${k.sorte === "alerte" ? ` · alerte${k.exigence ? ` sur ${k.exigence}` : ""}` : ""} · ${k.type} · ${k.etat}${k.motif ? ` (${T.libelleMotif(k.motif, k.remplace_par)})` : ""} · ${k.auteur}${k.charge ? ` → ${k.charge}` : ""} · ${k.titre}${k.commit_ferme ? ` (corrigé par ${k.commit_ferme.slice(0, 7)})` : ""}${k.chemins ? ` · chemins : ${T.cheminsDuTicket(k).join(", ")}` : ""}${k.bloque_par ? ` · bloqué par #${k.bloque_par}` : ""}`;
  // La mémoire des refus « une fois » : dans un run à rôles, tenue par le tableau, pour
  // qu'une relance de pi (un réveil) ne rejoue pas un refus déjà dit ; sans rôles, par lancement.
  const rappelsDuLancement = new Map<string, string>();
  const dejaDit = (rappel: string, cle: string) => (role ? T.refusDit(t, agent, rappel) : rappelsDuLancement.get(rappel)) === cle;
  const noterDit = (rappel: string, cle: string) => { if (role) T.noterRefusDit(t, agent, rappel, cle); else rappelsDuLancement.set(rappel, cle); };
  const rappelTickets = (): string | undefined => {
    const siens = T.listerTickets(t, { charge: agent }).filter(T.estActif);
    const cle = siens.map((k) => k.id).join(",");
    if (!siens.length || dejaDit("tickets", cle)) return undefined;
    noterDit("tickets", cle);
    return `ces tickets ouverts te sont confiés. Le même appel, tickets inchangés, est accepté ; se lève aussi quand ils sont fermés ou confiés à un autre\n${siens.map(ligneTicket).join("\n")}`;
  };
  // Le travail qui reste dans la salle, rappelé avant de partir. En tête, ceux dont personne ne s'occupe : sans chargé, ou chargé sorti. Rappel, pas verrou, et
  // seulement quand un ticket est ouvert : redemander avec la même situation passe.
  // Rôles : la situation qui compte est celle de l'agent — ses tickets et le dernier message qui s'adresse à
  // lui —, pas celle de la salle, qui bouge sans cesse dans une grande salle.
  const rappelSalle = (): string | undefined => {
    const ouverts = T.listerTickets(t).filter(T.estActif);
    if (!ouverts.length) return undefined;
    const questions = T.questionsSansReponse(t);
    const cle = role
      ? `${ouverts.filter((k) => k.charge === agent).map((k) => k.id).join(",")}|${T.dernierMessageAdresse(t, agent, T.alias(t, agent))}`
      : `${ouverts.map((k) => k.id).join(",")}|${questions.map((q) => q.id).join(",")}`;
    if (dejaDit("salle", cle)) return undefined;
    noterDit("salle", cle);
    const etats = new Map(T.equipe(t).map((a) => [a.nom, a.etat]));
    const sorti = (k: T.Ticket) => !k.charge || ["fini", "vire", "perdu"].includes(etats.get(k.charge) ?? "");
    const orphelins = ouverts.filter(sorti), autres = ouverts.filter((k) => !sorti(k));
    const court = (s: string) => { const l = s.replace(/\s+/g, " ").trim(); return l.length > 200 ? l.slice(0, 200) + "…" : l; };
    return [`des tickets restent ouverts dans la salle. ${role ? "Un second appel est accepté tant qu'aucun ticket ne t'est confié et qu'aucun message ne s'adresse à toi" : "Le même appel, situation inchangée, est accepté"}`,
      ...(orphelins.length ? ["Personne ne s'en occupe (sans chargé, ou chargé sorti de la salle) :", ...orphelins.map((k) => `- ${ligneTicket(k)} (${k.charge ? `${k.charge} est ${etats.get(k.charge)}` : "sans chargé"})`)] : []),
      ...(autres.length ? ["Les autres tickets ouverts :", ...autres.map((k) => `- ${ligneTicket(k)}`)] : []),
      ...(questions.length ? ["Questions de la salle restées sans réponse :", ...questions.map((q) => `- [${q.fil}] message ${q.id}, ${q.auteur} : ${court(q.texte)}`)] : [])].join("\n");
  };
  // Le rappel des tickets dans les descriptions d'un run à rôles : sa mémoire vaut pour tout le run.
  const RAPPEL_TICKETS_ROLES = "une fois par état de tes tickets, si un ticket ouvert t'est confié, levé par un second appel tant qu'aucun autre ticket ne t'est confié, ou quand ils sont fermés ou confiés à un autre";
  pi.registerTool({
    name: "moi_dormir", label: "Dormir",
    description: "Poster un message, puis te mettre en veille : ton tour s'arrête et tu ne consommes plus rien jusqu'à ce qu'" + (role ? "un ticket te soit confié ou qu'un message d'un autre agent s'adresse à toi seul (un nom cité en passant ou dans une liste ne réveille pas). `attend` nomme ce que tu attends pour reprendre : qui répartit le travail ne t'en confie pas d'autre tant que ça dure, au plus " + Math.round(Number(process.env.ESSAIM_ATTENTE_MS ?? 30 * 60_000) / 60_000) + " minutes. Sans `attend`, tu es disponible pour un travail précis" : "un autre agent écrive ton nom ou ton surnom") + ". Rend : la confirmation de la veille. Refus : message vide, levé avec un message non vide ; tour de parole, comme `salle_poster` ; " + (role ? RAPPEL_TICKETS_ROLES : "une fois par état des tickets et par lancement, si un ticket ouvert t'est confié, levé par le même appel avec les tickets inchangés, ou quand ils sont fermés ou confiés à un autre") + " ; au-delà de cinq veilles dans le run, définitif pour ce run, sauf dans un run à rôles, sans limite" + (role === "surveillant" ? REFUS_PAROLE : "") + ".",
    promptSnippet: "moi_dormir(message, attend?) : poster un message, puis te mettre en veille",
    parameters: Type.Object({
      message: Type.String({ description: "ce qui est posté dans principal" }),
      attend: Type.Optional(Type.String({ description: "ce que tu attends pour reprendre : un ticket (#n) ou un agent nommé (la réponse de X sur #n) ; une attente qui ne nomme ni ticket ouvert ni agent autre que celui qui répartit compte disponible ; vide si tu n'attends rien" })),
    }),
    async execute(_id, p) {
      const message = (p.message ?? "").trim();
      if (!message) return refuse("message vide. Se lève avec un message non vide");
      const parole = refusParole(message);
      if (parole) return refuse(parole);
      const attente = role ? null : T.tourDeParole(t, agent, Number(process.env.ESSAIM_TOUR_MS ?? 90_000));
      if (attente) return refuse(tour(attente));
      const tickets = rappelTickets();
      if (tickets) return refuseUneFois(tickets);
      const ouverts = T.listerTickets(t, { charge: agent }).filter(T.estActif).length;
      const limite = !veillesSansLimite(role, ouverts);
      if (limite && T.sommeils(t, agent) >= SOMMEILS_MAX) return refuse(`${SOMMEILS_MAX} veilles déjà prises dans ce run. Définitif pour ce run`);
      // Le message de veille est marqué sommeil.
      T.insererMessage(t, agent, `[en sommeil] ${message}`, "principal", { sommeil: true });
      // Le surveillant : se rendormir consomme les signes qui l'ont réveillé ; il faut un signe qui
      // s'allume de nouveau pour le réveiller, et pour demander une révision.
      if (role === "surveillant") S.consommerSignes(t, agent, "le surveillant se rendort");
      const n = T.endormir(t, agent, p.attend);
      // L'attente d'un constructeur qui ne nomme ni ticket ouvert ni agent compte disponible pour la ronde ; la
      // confirmation le dit (les autres sièges ne sont jamais comptés disponibles).
      const rep = repartiteurPresent();
      const vague = role === "constructeur" && p.attend?.trim() && !T.attenteTient(t, agent, p.attend.trim(), rep)
        ? ` Ton attente ne nomme ni ticket ouvert (#n) ni agent${rep && rep !== agent ? ` autre que ${rep}` : ""} : tu comptes disponible pour un travail précis.` : "";
      return { ...texte(`en veille (${limite ? `${n}/${SOMMEILS_MAX}` : `${n}, sans limite pour ton rôle`}) : ton tour s'arrête ici. Tu reprendras quand ${role ? "un ticket te sera confié ou qu'un autre agent s'adressera à toi seul" : "un autre agent écrira ton nom"} ; ${role ? "si toute la salle s'endort, le lanceur constate le run accepté ou incomplet" : "si toute la salle s'endort, le run se ferme sur le livrable en l'état"}.${vague}`), terminate: true };
    },
  });

  // ---- Vérifications (second cerveau) : « vérifié » est écrit par l'outil qui vérifie, avec
  // l'empreinte (blob git) du contenu juste avant et juste après le contrôle. L'empreinte d'avant porte sur tout le
  // dossier (le cache du processus la rend peu coûteuse) ; celle d'après sur les fichiers contrôlés, ou sur le dossier
  // ré-énuméré quand controles manque (les tests : un fichier créé ou supprimé compte). Aucun fait sur un refus ou une
  // panne (lire rend undefined).
  const cacheEmpreintes: M.Cache = new Map();
  type Controle = { resultat: "succes" | "echec" | "illisible"; controles?: string[]; sujet: string; resultatTexte: string; contenu?: boolean; details: Record<string, unknown> };
  const essaisDir = () => join(dirname(process.env.ESSAIM_PARTAGE ?? ""), "essais");
  const nomEssai = (racine: string) => { const r = relative(essaisDir(), racine); return r && !r.startsWith("..") && !r.includes("/") ? r : undefined; };
  const verifier = async <R>(source: string, racine: string, faire: () => Promise<R>, lire: (r: R) => Controle | undefined): Promise<R> => {
    const avant = M.empreintes(racine, undefined, cacheEmpreintes);
    const r = await faire();
    const c = lire(r);
    if (c) noterVerification(source, racine, avant, c);
    return r;
  };
  const noterVerification = (source: string, racine: string, avant: Map<string, M.Empreinte>, c: Controle) => {
    const apres = M.empreintes(racine, c.controles, cacheEmpreintes);
    const controles = c.controles ?? [...new Set([...avant.keys(), ...apres.keys()])].sort();
    const { statut, changes } = M.statutVerification(avant, apres, controles, c.resultat);
    const restreint = (m: Map<string, M.Empreinte>) => Object.fromEntries(controles.flatMap((f) => { const e = m.get(f); return e ? [[f, e]] : []; }));
    const essai = nomEssai(racine);
    const texteFait = M.texteVerification({ statut, changes, outil: source, sujet: c.sujet, essai, resultat: c.resultatTexte, agent, contenu: c.contenu ? controles : undefined });
    const details = { ...c.details, avant: restreint(avant), apres: restreint(apres), fichiers: controles, racine: essai ? `essai:${essai}` : "partage", head: M.tete(racine) ?? null };
    t.transaction(() => T.noterFait(t, { type: "verification", agent, source, sujet: c.sujet, statut, texte: texteFait, details }));
  };
  // Le contrôle d'une page (page_voir, moi_finir) : la page et ce qu'elle a chargé, code 0 ou 1 ; invalide ou code 2 : rien.
  const controlePage = (page: string, racine: string, details: Record<string, unknown> = {}) => (r: Awaited<ReturnType<typeof import("./voir.ts").voir>>): Controle | undefined => {
    if (r.invalide || r.code === 2) return undefined;
    const base = page.replace(/[?#].*$/, "");
    const sujet = relative(racine, resolve(racine, base));
    return { resultat: r.code === 0 ? "succes" : "echec", controles: r.charges?.length ? r.charges : [sujet], sujet, contenu: true,
      resultatTexte: r.code === 0 ? "page saine (0)" : "erreurs (1)", details: { code: r.code, ...details } };
  };
  // Crochet de test : réécrire un fichier pendant le contrôle, entre les deux empreintes. Jamais hors des tests.
  const crochetVoir = (racine: string) => {
    const c = process.env.ESSAIM_TEST ? process.env.ESSAIM_TEST_CROCHET_VOIR : undefined;
    if (!c) return;
    const o = JSON.parse(c) as { fichier: string; contenu: string; remettre?: boolean };
    const f = join(racine, o.fichier);
    const avant = o.remettre ? readFileSync(f) : undefined;
    writeFileSync(f, o.contenu);
    if (avant) writeFileSync(f, avant);
  };

  // Ouvrir une page livrée comme le juge le fera : le moteur est src/voir.ts, importé au premier appel
  // pour que pi démarre sans charger Playwright. Montage direct : le navigateur tourne dans le
  // bac à sable de l'agent. Code 2 invalide (page absente ou hors du dossier) = un refus ; les autres codes 2 = la
  // salle est en panne, c'est une erreur d'outil ; 0 et 1 sont des résultats.
  pi.registerTool({
    name: "page_voir", label: "Voir",
    description: "Ouvrir une page du dossier partagé dans un navigateur, comme le juge le fera. Rend : le texte affiché, les erreurs de console, les exceptions, les ressources chargées hors du dossier partagé et les règles de style qui ne touchent aucun élément ; après chaque clic, le texte relu, et un clic sans effet signalé ; avec `parcours`, chaque clic qui ne change rien et chaque zone qui s'affiche vide ; avec `tailles`, pour chaque taille (après les clics), ce qui fait défiler la page de côté, les textes coupés et le chemin d'une planche PNG. Refus : page hors du dossier partagé, définitif pour ce chemin ; page introuvable, levé quand le fichier existe.",
    promptSnippet: "page_voir(page, clics?, capture?, parcours?, tailles?) : ouvrir une page du dossier partagé dans un navigateur, comme le juge le fera",
    parameters: Type.Object({ page: Type.String({ description: "la page, relative au dossier partagé, ou le chemin d'une page d'un essai" }), clics: Type.Optional(Type.Array(Type.String(), { description: "sélecteurs CSS cliqués dans l'ordre" })), capture: Type.Optional(Type.String({ description: "une capture PNG, rangée dans le dossier partagé, ou dans ton bureau quand l'équipe a des rôles" })), parcours: Type.Optional(Type.Boolean({ description: "cliquer tout ce qui est cliquable, vingt éléments au plus ; les boutons dont le libellé dit qu'ils détruisent ne sont pas cliqués" })), tailles: Type.Optional(Type.Array(Type.String(), { description: "tailles d'écran, « 1280x800 » ; liste vide : cinq écrans d'ordinateur, de 1280x720 à 2560x1440 ; un téléphone ou une tablette se nomme, « 390x844 »" })) }),
    async execute(_id, p) {
      const partage = process.env.ESSAIM_PARTAGE;
      if (!partage) throw new Error("page_voir : 2 outil en panne · ESSAIM_PARTAGE manquant");
      // Une page d'essai : sa racine est le dossier de l'essai, jamais le dossier commun.
      const essais = join(dirname(partage), "essais");
      // Chemin résolu d'abord : « essais/../partage/index.html » ferait du run entier la racine d'un essai.
      const dansEssais = relative(essais, resolve(partage, p.page));
      const essai = dansEssais && !dansEssais.startsWith("..") && !isAbsolute(dansEssais) ? join(essais, dansEssais.split("/")[0]!) : undefined;
      const { voir } = await import("./voir.ts");
      const racine = essai ?? partage;
      const r = await verifier("page_voir", racine, async () => {
        const x = await voir(racine, { page: p.page, clics: p.clics, capture: p.capture, parcours: p.parcours, tailles: p.tailles });
        crochetVoir(racine);
        return x;
      }, controlePage(p.page, racine, { parcours: p.parcours ?? false, tailles: p.tailles ?? null }));
      if (r.invalide) return refuse(r.texte);
      if (r.code === 2) throw new Error(r.texte);
      return texte(r.texte);
    },
  });

  // La carte du livrable : savoir ce qui existe déjà avant d'écrire, pour ne pas le refaire à côté.
  pi.registerTool({
    name: "code_carte", label: "Plan du code",
    description: "Dresser la carte du dossier partagé, en lecture seule. Rend : les fichiers, ce que chacun définit, qui s'en sert, qui l'a écrit, l'ordre de chargement des scripts de chaque page, les fichiers qu'aucune page ne charge et les noms définis deux fois.",
    promptSnippet: "code_carte() : dresser la carte du dossier partagé",
    parameters: Type.Object({}),
    async execute() {
      const partage = process.env.ESSAIM_PARTAGE;
      if (!partage) throw new Error("code_carte : ESSAIM_PARTAGE manquant");
      const { planDuCode } = await import("./plan-code.ts");
      return texte(planDuCode(partage, t));
    },
  });

  // Assembler : écrire en modules, livrer un seul fichier qui s'ouvre en double-clic.
  pi.registerTool({
    name: "page_assembler", label: "Assembler",
    description: "Rassembler les scripts module d'une page (avec leurs `import`) en un seul script classique collé dans une page de sortie, qui s'ouvre en double-clic. Les feuilles de style et les images restent des fichiers à côté. Rend : le chemin de la page écrite. Refus : page source ou de sortie hors du dossier partagé, définitif pour ces chemins ; sortie égale à la source, levé avec une sortie différente ; page source introuvable, levé quand le fichier existe ; page sans script module, levé quand elle en contient un ; script hors du dossier partagé, définitif pour ce chemin, ou introuvable, levé quand il existe ; script qui ne se rassemble pas, levé quand il se rassemble, le refus cite l'erreur.",
    promptSnippet: "page_assembler(source, sortie?) : rassembler les scripts module d'une page en une page qui s'ouvre en double-clic",
    parameters: Type.Object({ source: Type.String({ description: "la page source, relative au dossier partagé" }), sortie: Type.Optional(Type.String({ description: "la page écrite, index.html par défaut" })) }),
    async execute(_id, p) {
      const partage = process.env.ESSAIM_PARTAGE;
      if (!partage) throw new Error("page_assembler : ESSAIM_PARTAGE manquant");
      const { assembler } = await import("./assembler.ts");
      const r = assembler(partage, p.source, p.sortie ?? "index.html");
      if (r.invalide) return refuse(r.texte);
      if (r.code !== 0) throw new Error(r.texte);
      return texte(r.texte);
    },
  });

  // Mesurer, comparer, tester, lire le web : des chiffres et des extraits plutôt que des pages à payer en entier.
  const partageOuPanne = (outil: string) => {
    const partage = process.env.ESSAIM_PARTAGE;
    if (!partage) throw new Error(`${outil} : ESSAIM_PARTAGE manquant`);
    return partage;
  };
  pi.registerTool({
    name: "page_mesurer", label: "Mesurer",
    description: "Ouvrir une page du dossier partagé et la mesurer. Rend : premier affichage et chargement en millisecondes, images par seconde, poids des fichiers chargés, erreurs ; des chiffres, sans interprétation. Refus : page introuvable dans le dossier partagé, levé quand le fichier existe ; taille illisible, levé avec une taille « 1280x800 ».",
    promptSnippet: "page_mesurer(page, secondes?, taille?) : ouvrir une page du dossier partagé et la mesurer",
    parameters: Type.Object({ page: Type.String({ description: "la page, relative au dossier partagé" }), secondes: Type.Optional(Type.Number({ description: "durée de la mesure en secondes, 5 par défaut" })), taille: Type.Optional(Type.String({ description: "taille d'écran, 1280x800 par défaut" })) }),
    async execute(_id, p) {
      const { mesurer } = await import("./mesurer.ts");
      const r = await mesurer(partageOuPanne("page_mesurer"), p.page, p.secondes ?? 5, p.taille ?? "1280x800");
      if (r.invalide) return refuse(r.texte);
      if (r.code === 2) throw new Error(r.texte);
      return texte(r.texte);
    },
  });
  pi.registerTool({
    name: "page_comparer", label: "Comparer",
    description: "Comparer deux captures PNG, du dossier partagé ou, quand l'équipe a des rôles, de ton bureau. Rend : la part de l'image qui a changé, la zone, et le chemin d'une image où le changement est en rouge, écrite dans le dossier partagé, ou dans ton bureau quand l'équipe a des rôles. Refus : capture introuvable, levé quand le fichier existe ; sortie qui n'est pas un PNG, levé avec un nom en .png.",
    promptSnippet: "page_comparer(avant, apres, sortie?) : comparer deux captures PNG",
    parameters: Type.Object({ avant: Type.String({ description: "la première capture PNG, relative au dossier partagé, ou son chemin absolu dans ton bureau" }), apres: Type.String({ description: "la seconde capture PNG, relative au dossier partagé, ou son chemin absolu dans ton bureau" }), sortie: Type.Optional(Type.String({ description: "le nom du PNG écrit, comparaison.png par défaut" })) }),
    async execute(_id, p) {
      const { comparer } = await import("./mesurer.ts");
      // Rôles : la sortie va dans <bureau>/captures, hors du livrable, comme les captures de page_voir.
      const captures = role ? join(process.env.ESSAIM_BUREAU ?? process.cwd(), "captures") : undefined;
      const r = await comparer(partageOuPanne("page_comparer"), p.avant, p.apres, p.sortie ?? "comparaison.png", captures);
      if (r.invalide) return refuse(r.texte);
      if (r.code === 2) throw new Error(r.texte);
      return texte(r.texte);
    },
  });
  pi.registerTool({
    name: "code_tester", label: "Tester",
    description: "Lancer les tests d'un fichier du dossier partagé, ou de tout le dossier. Rend : le bilan (réussis, échoués, durée) et le nom de chaque test qui échoue, 30 au plus, avec les erreurs survenues hors d'un test ; avec `detail`, le détail de chaque échec ; sans aucun test nommé, les dernières lignes de la sortie. Refus : fichier de tests introuvable, levé quand le fichier existe.",
    promptSnippet: "code_tester(fichier?, detail?) : lancer les tests d'un fichier du dossier partagé, ou de tout le dossier",
    parameters: Type.Object({ fichier: Type.Optional(Type.String({ description: "le fichier de tests, relatif au dossier partagé ; sans fichier : tout le dossier" })), detail: Type.Optional(Type.Boolean({ description: "ajouter le détail de chaque échec" })) }),
    async execute(_id, p) {
      const { tester } = await import("./outils-travail.ts");
      const racine = partageOuPanne("code_tester");
      // Tout le dossier est empreinté, même pour un seul fichier (un test peut passer seul et échouer avec les autres).
      const r = await verifier("code_tester", racine, async () => tester(racine, p.fichier, undefined, { detail: p.detail }), (x) =>
        x.invalide || x.code === 2 || !x.bilan ? undefined : {
          resultat: M.resultatDuBilan(x.bilan), sujet: p.fichier ? `tests (fichier ${relative(racine, resolve(racine, p.fichier))})` : "tests (tout le dossier)",
          resultatTexte: M.chiffresBilan(x.bilan), details: { bilan: x.bilan, code: x.code },
        });
      if (r.invalide) return refuse(r.texte);
      if (r.code === 2) throw new Error(r.texte);
      return texte(r.texte);
    },
  });
  pi.registerTool({
    name: "web_lire", label: "Lire le web",
    description: "Lire une page web (https) en texte : titre, sections, paragraphes, listes, blocs de code, sans menus ni scripts. Rend : 8 000 caractères, et le point d'où continuer. Refus : adresse illisible, levé avec une adresse complète ; adresse ni https ni http, levé avec une adresse https:// ou http://.",
    promptSnippet: "web_lire(url, depuis?) : lire une page web en texte",
    parameters: Type.Object({ url: Type.String({ description: "l'adresse de la page, https ou http" }), depuis: Type.Optional(Type.Number({ description: "où reprendre, en caractères depuis le début du texte, 0 par défaut" })) }),
    async execute(_id, p) {
      const { lireWeb } = await import("./outils-travail.ts");
      const r = await lireWeb(p.url, p.depuis ?? 0);
      if (r.invalide) return refuse(r.texte);
      if (r.code === 2) throw new Error(r.texte);
      return texte(r.texte);
    },
  });

  // ---- Le dépôt du run : le lanceur en est le seul écrivain. Ces outils lui déposent une demande
  // dans le tableau et attendent sa réponse ; la lecture se fait sans lui : depot_journal, ou git dans bash.
  const partage = process.env.ESSAIM_PARTAGE ?? "";
  const DEMANDE_MS = Number(process.env.ESSAIM_DEMANDE_MS ?? 60_000);
  const demander = async (action: string, args: Record<string, unknown>): Promise<Reponse | undefined> => {
    const id = T.deposerDemande(t, agent, action, args);
    const pas = process.env.ESSAIM_TEST ? 20 : 200;
    for (let ecoule = 0; ecoule < DEMANDE_MS; ecoule += pas) {
      const r = T.reponseDemande<Reponse>(t, id);
      if (r) return r;
      await dormir(pas);
    }
    return undefined;
  };
  // Une réponse du lanceur : un refus à la forme commune, ou une panne levée en erreur d'outil.
  const raisonDuDepot = (r: Reponse): string => {
    if (r.panne) throw new Error(`le dépôt du run est en panne : ${r.raison}`);
    return r.raison!;
  };
  const sansReponse = () => texte(`la salle n'a pas répondu en ${Math.round(DEMANDE_MS / 1000)} s ; ta demande reste en file et sera faite, puis annoncée dans principal (un refus te nommera)`);

  pi.registerTool({
    name: "depot_restaurer", label: "Restaurer un fichier",
    description: "Remettre un seul fichier du dossier partagé dans l'état d'un commit d'avant ; la salle le commite à ton nom et l'annonce dans principal. Rend : le commit, ou « il était déjà identique ». Refus : chemin hors du dossier partagé, définitif pour ce chemin ; fichier sous la pancarte d'un autre agent, levé quand il la retire ; dans un run à rôles, fichier qui n'est pas ta part, levé pour un constructeur quand celui qui répartit les parts te le confie ou dans un essai proposé à l'intégrateur ; commit inconnu, définitif pour ce commit ; fichier absent à ce commit, définitif pour ce fichier à ce commit ; fichier en lien symbolique à ce commit, définitif pour ce fichier à ce commit ; fichier actuel en lien symbolique, levé quand il n'est plus un lien ; chemin qui sort du dossier partagé par un lien, définitif pour ce chemin ; dépôt du run disparu ou remplacé, définitif pour ce run.",
    promptSnippet: "depot_restaurer(chemin, commit, raison) : remettre un seul fichier dans l'état d'un commit d'avant",
    parameters: Type.Object({ chemin: Type.String({ description: "le fichier, relatif au dossier partagé" }), commit: Type.String({ description: "le commit d'où le reprendre (`depot_journal` les liste)" }), raison: Type.String({ description: "annoncée dans principal" }) }),
    async execute(_id, p) {
      const propre = T.normaliserChemin(partage && p.chemin.startsWith(partage + "/") ? p.chemin.slice(partage.length + 1) : p.chemin);
      if (!propre) return refuse(`${p.chemin} est hors du dossier partagé. Définitif pour ce chemin`);
      const refusRole = role && refusDuRole(role, "depot_restaurer", { racine: "partage", rel: propre }, contexteRole());
      if (refusRole) return refuse(refusRole);
      const pancarte = T.reclamations(t).find((r) => r.chemin === propre && r.agent !== agent);
      if (pancarte) return refuse(`${propre} porte la pancarte de ${pancarte.agent} (${pancarte.raison}). Se lève quand ${pancarte.agent} la retire`);
      const r = await demander("restaurer", { chemin: propre, commit: p.commit, raison: p.raison });
      if (!r) return sansReponse();
      if (!r.ok) return refuse(raisonDuDepot(r));
      return texte(`${propre} restauré à ${p.commit}${r.hash ? `, commit ${r.hash}` : " (il était déjà identique)"} ; annoncé dans principal`);
    },
  });

  const JOURNAL_MAX = 50;
  const heure = (iso: string) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
  pi.registerTool({
    name: "depot_journal", label: "Journal du dépôt",
    description: "Lister les derniers commits du dossier commun, du plus récent au plus ancien. Rend : une ligne par commit : identifiant court, heure, auteur, première ligne du message ; « aucun commit pour » un chemin qu'aucun commit ne touche. Refus : chemin hors du dossier partagé, définitif pour ce chemin.",
    promptSnippet: "depot_journal(chemin?, nombre?) : lister les derniers commits du dossier commun",
    parameters: Type.Object({ chemin: Type.Optional(Type.String({ description: "seulement les commits qui touchent ce fichier ou ce dossier, relatif au dossier partagé" })), nombre: Type.Optional(Type.Integer({ minimum: 1, description: "combien, 10 par défaut, 50 au plus" })) }),
    async execute(_id, p) {
      const racine = partageOuPanne("depot_journal");
      let chemin: string | undefined;
      if (p.chemin !== undefined) {
        chemin = T.normaliserChemin(p.chemin.startsWith(racine + "/") ? p.chemin.slice(racine.length + 1) : p.chemin);
        if (!chemin) return refuse(`${p.chemin} est hors du dossier partagé. Définitif pour ce chemin`);
      }
      const nombre = Math.min(p.nombre ?? 10, JOURNAL_MAX);
      const r = await journal(racine, { chemin, nombre });
      if (!r.ok) throw new Error(`depot_journal : le dépôt du run est en panne : ${r.erreur}`);
      if (!r.commits.length) return texte(`aucun commit pour ${chemin ?? "le dossier commun"}`);
      const lignes = r.commits.map((c) => `${c.hash} ${heure(c.date)} ${c.auteur} ${c.message}`);
      return texte([...((p.nombre ?? 0) > JOURNAL_MAX ? [`nombre ramené à ${JOURNAL_MAX}`] : []), ...lignes].join("\n"));
    },
  });

  pi.registerTool({
    name: "depot_essai", label: "Ouvrir un essai",
    description: "Ouvrir une branche d'essai : un dossier à toi, copie du dossier commun, où tes écritures sont commitées à ton nom sans toucher au dossier commun ; d'autres peuvent y écrire. Dans un run à rôles, l'intégrateur l'adopte, ou le porteur de la pancarte de chaque fichier qu'il change. Rend : le chemin du dossier de l'essai. Refus : nom mal formé, levé avec un nom en minuscules, chiffres et tirets, 40 caractères au plus ; nom déjà pris, définitif pour ce nom ; dépôt du run disparu ou remplacé, définitif pour ce run ; ouvert par l'intégrateur quand un chef répartit, définitif pour ce rôle.",
    promptSnippet: "depot_essai(nom, raison) : ouvrir une branche d'essai dans un dossier à toi",
    parameters: Type.Object({ nom: Type.String({ description: "le nom de l'essai : minuscules, chiffres et tirets, 40 caractères au plus" }), raison: Type.String({ description: "ce que l'essai tente, annoncé dans principal" }) }),
    async execute(_id, p) {
      const refusRole = role && refusDuRole(role, "depot_essai", undefined, contexteRole());
      if (refusRole) return refuse(refusRole);
      const r = await demander("essai", { nom: p.nom, raison: p.raison });
      if (!r) return sansReponse();
      if (!r.ok) return refuse(raisonDuDepot(r));
      return texte(`essai ${p.nom} ouvert : ton dossier est ${r.dossier} (branche essai/${p.nom}). Le dossier commun ne bouge pas ; annoncé dans principal.`);
    },
  });

  pi.registerTool({
    name: "depot_adopter", label: "Adopter un essai",
    description: "Fusionner un essai dans le dossier commun, après un essai à blanc. Rend : le commit de fusion et les fichiers changés. Refus : essai inconnu, levé après `depot_essai` de ce nom ; dossier commun hors de main, levé quand il revient sur main ; essai sans changement, levé quand l'essai change un fichier ; ce qui a changé entre-temps dans le dossier commun touche les mêmes lignes, le refus nomme les fichiers en conflit et se lève quand l'essai ne les contredit plus ; changements du dossier commun pas encore commités, levé quand la salle les a commités, en quelques secondes ; dossier de l'essai remplacé, définitif pour cet essai ; dépôt du run disparu ou remplacé, définitif pour ce run ; dans un run à rôles, adoption par un constructeur, levé quand chaque fichier que l'essai change porte sa pancarte ; un fichier que l'essai change appartient à un ticket gelé par une révision, levé au plan révisé.",
    promptSnippet: "depot_adopter(nom) : fusionner un essai dans le dossier commun",
    parameters: Type.Object({ nom: Type.String({ description: "le nom de l'essai" }) }),
    async execute(_id, p) {
      // Le gel : quand un chemin est gelé par une révision, les fichiers de l'essai se lisent pour tout rôle.
      const gel = T.reclamations(t).some((x) => x.agent === PORTEUR_GEL);
      const refusRole = role && refusDuRole(role, "depot_adopter", undefined, { ...contexteRole(), essai: (role === "constructeur" || gel) && partage ? await fichiersDeLEssai(partage, essaisDir(), p.nom) : [] });
      if (refusRole) return refuse(refusRole);
      const r = await demander("adopter", { nom: p.nom });
      if (!r) return sansReponse();
      if (!r.ok) return refuse(raisonDuDepot(r));
      return texte(`essai ${p.nom} adopté (commit ${r.hash}) : ${r.fichiers?.join(", ")} ; annoncé dans principal`);
    },
  });

  // Les tickets : locaux, dans le tableau. Ouvrir, confier ou fermer un ticket poste dans le fil `tickets` en
  // nommant le chargé : celui qui dort se réveille. Un bug ou une amélioration se ferme en citant le commit qui
  // corrige, contenu dans le dossier commun ; une question, sur sa réponse.
  const agentConnu = (nom: string) => !!t.get("SELECT 1 FROM agents WHERE nom = ?", [nom]);
  const ticketInconnu = (id: number) => `aucun ticket #${id}. Définitif pour ce numéro`;
  const chargeAbsent = (nom: string) => `${nom} n'est pas dans la salle. Se lève avec un chargé que salle_equipe liste`;
  // Un chargé parti (perdu, viré ou fini) ne reçoit plus rien ; le refus nomme les présents.
  const chargeParti = (nom: string): string | undefined => {
    const a = t.get<{ etat: string }>("SELECT etat FROM agents WHERE nom = ?", [nom]);
    if (!a || a.etat === "actif" || a.etat === "dormant") return undefined;
    const presents = t.all<{ nom: string }>("SELECT nom FROM agents WHERE etat IN ('actif', 'dormant') ORDER BY rowid").map((x) => x.nom);
    return `${nom} a quitté la salle (${a.etat === "vire" ? "viré" : a.etat}). Se lève avec un chargé présent : ${presents.slice(0, 15).join(", ")}${presents.length > 15 ? `, et ${presents.length - 15} autres` : ""}`;
  };
  // L'assembleur doit assembler, pas crouler sous les corrections. Un bug ou une
  // amélioration ne lui va que de celui qui répartit, avec ses chemins (le livrable, le programme qui l'assemble, ses gardes) ;
  // un écart du livrable se corrige dans sa source, chez le porteur de la source. Les questions et les alertes passent.
  const ASSEMBLEUR_TICKETS_MAX = 2;
  const refusAssembleur = (charge: string | undefined, type: string, sorte: string, chemins: string[]): string | undefined => {
    const equipe = equipeRoles();
    if (!charge || type === "question" || sorte === "alerte" || !equipe.some((a) => a.nom === charge && a.role === "assembleur")) return undefined;
    const rep = repartiteur(equipe.filter((a) => a.present !== false));
    if (rep && agent !== rep.nom) return `${charge} est l'assembleur : il ne reçoit que l'assemblage, confié par ${rep.nom}. Un écart du livrable se corrige dans sa source, et le ticket va au porteur de cette source (sa pancarte). Définitif pour ce chargé`;
    if (!chemins.length) return `${charge} est l'assembleur : un ticket ne lui va qu'avec ses chemins (le livrable, le programme qui l'assemble, ses gardes) ; un écart du livrable se corrige chez le porteur de sa source. Se lève avec chemins`;
    // La part d'un autre ne va pas à l'assembleur, même confiée par le chef ; sa correction va
    // à son porteur. Le livrable reste à l'assembleur quelle que soit sa pancarte.
    const livrable = T.cleChemin(T.normaliserChemin(process.env.ESSAIM_LIVRABLE ?? "") ?? "");
    const part = chemins.map((c) => T.cleChemin(relatifAuPartage(c) ?? c)).filter((c) => c !== livrable)
      .map((c) => T.reclamations(t).find((p) => T.cleChemin(p.chemin) === c && p.agent !== charge)).find(Boolean);
    if (part) return `${part.chemin} est la part de ${part.agent} : sa correction va à son porteur, pas à l'assembleur. Se lève avec des chemins que personne d'autre ne porte (le livrable, le programme qui l'assemble, ses gardes)`;
    // Deux bugs ou améliorations
    // ouverts au plus, même venant du chef ; le refus nomme les constructeurs disponibles, pour que la correction aille à l'un d'eux.
    const ouverts = T.listerTickets(t, { charge }).filter((k) => T.estActif(k) && k.type !== "question" && k.sorte !== "alerte").length;
    if (ouverts >= ASSEMBLEUR_TICKETS_MAX) {
      return `${charge} (assembleur) porte déjà ${ouverts} tickets ouverts : l'assemblage passe d'abord. ${aQuiConfier(charge)}. Se lève quand l'assembleur en porte moins de ${ASSEMBLEUR_TICKETS_MAX}`;
    }
    return undefined;
  };
  // Qui peut recevoir le ticket refusé : les constructeurs disponibles ; pendant la préparation, ceux qui attendent
  // le plan, à qui une exploration se confie (T.oisifs ne les compte pas).
  const aQuiConfier = (charge: string): string => {
    const libres = T.oisifs(t).map((x) => x.nom).filter((n) => n !== charge);
    if (libres.length) return `Constructeurs disponibles maintenant : ${libres.slice(0, 8).join(", ")}`;
    const plan = t.all<{ nom: string }>("SELECT nom FROM agents WHERE role = 'constructeur' AND etat = 'dormant' AND attend = ? ORDER BY rowid", [T.ATTENTE_PLAN]).map((x) => x.nom);
    if (plan.length) return `Constructeurs qui attendent le plan, à qui une exploration se confie : ${plan.slice(0, 8).join(", ")}`;
    return "Aucun constructeur n'est disponible : le ticket peut rester sans porteur";
  };
  // Les explorations : un travail confié avant la spec serait à refaire au format qu'elle fixe. Tant que la préparation est en cours, un constructeur ne reçoit qu'une
  // exploration : une question, dont la réponse est une mesure pour la spec ou le plan.
  const refusPreparation = (charge: string | undefined, type: string, sorte: string): string | undefined => {
    if (!charge || type === "question" || sorte === "alerte" || T.preparation(t) !== "en_cours") return undefined;
    if (!equipeRoles().some((a) => a.nom === charge && a.role === "constructeur")) return undefined;
    return `la préparation est en cours : ${charge} ne reçoit qu'une exploration, une question dont la réponse est une mesure pour la spec ou le plan. Se lève avec type question, ou quand le plan est validé ou la préparation close`;
  };
  // Un bug ou une amélioration ne va ni à la recette ni au gardien, qui n'écrivent pas le produit (le ticket
  // resterait bloqué) ; les questions et les alertes passent.
  const refusControle = (charge: string | undefined, type: string, sorte: string): string | undefined => {
    const siege = charge ? equipeRoles().find((a) => a.nom === charge) : undefined;
    if (!siege || type === "question" || sorte === "alerte" || (siege.role !== "recette" && siege.role !== "gardien")) return undefined;
    return `${charge} est ${siege.role === "recette" ? "la recette" : "le gardien-mesureur"} : il contrôle, il n'écrit pas le produit. ${aQuiConfier(charge)}. Définitif pour ce chargé`;
  };
  // Les essais ne doivent pas attendre l'adoption de l'intégrateur. Quand un chef répartit,
  // l'intégrateur ne reçoit un bug ou une amélioration que sur ses propres fichiers (le contrat, l'assemblage : sa
  // pancarte) ; les questions et les alertes passent.
  const refusIntegrateur = (charge: string | undefined, type: string, sorte: string, chemins: string[]): string | undefined => {
    const equipe = equipeRoles();
    if (!charge || type === "question" || sorte === "alerte" || !equipe.some((a) => a.nom === charge && a.role === "integrateur")) return undefined;
    const rep = repartiteur(equipe.filter((a) => a.present !== false));
    if (rep?.role !== "chef" || rep.nom === charge) return undefined;
    const siennes = new Set(T.reclamations(t).filter((p) => p.agent === charge).map((p) => T.cleChemin(p.chemin)));
    if (chemins.length && chemins.every((c) => siennes.has(T.cleChemin(relatifAuPartage(c))))) return undefined;
    return `${charge} est l'intégrateur : il adopte les essais et tient le contrat, il ne construit pas. ${aQuiConfier(charge)}. Se lève avec des chemins qui portent tous sa pancarte (le contrat, l'assemblage)`;
  };
  // Les chemins confiés, relatifs au dossier partagé comme les pancartes ; un chemin absolu dans partage/ est admis.
  const relatifAuPartage = (c: string) => T.normaliserChemin(partage && c.startsWith(partage + "/") ? c.slice(partage.length + 1) : c);
  const refusChemins = (chemins: string[], charge: string | null | undefined): string | undefined => {
    const r = refusConfier(role, equipeRoles(), agent);
    if (r) return r;
    if (!charge) return "des chemins sans chargé. Se lève avec un chargé";
    const hors = chemins.find((c) => !relatifAuPartage(c));
    if (hors !== undefined) return `${hors} est hors du dossier partagé. Définitif pour ce chemin`;
    // Une correction faite dans le livrable est effacée au réassemblage. Avec un intégrateur, le
    // livrable ne se confie qu'à lui : une correction va dans la source qu'il assemble, ou dans un essai qu'il adopte.
    const livrable = T.normaliserChemin(process.env.ESSAIM_LIVRABLE ?? "");
    const porteur = porteurDuLivrable(equipeRoles());
    if (livrable && porteur && charge !== porteur.nom && chemins.some((c) => T.cleChemin(relatifAuPartage(c)) === T.cleChemin(livrable)))
      return `${livrable} est le livrable, tenu par ${porteur.role === "assembleur" ? "l'assembleur" : "l'intégrateur"} (${porteur.nom}) : une correction se confie dans la source qu'il assemble, ou dans un essai (depot_essai) que l'intégrateur adopte. Se lève avec ${porteur.nom} pour chargé`;
    return undefined;
  };
  // Rôles : la reproduction d'une alerte, relevée par l'outil à l'ouverture et figée : la commande et la
  // graine données, les empreintes du banc (fichiers ou dossiers, relatifs au bureau comme pi) et du monde
  // (<run>/entrees/), le commit de main. Rien ne la modifie ensuite ; le lanceur la rejoue.
  const runDuPartage = () => dirname(resolve(partage || join(dirname(chemin), "partage")));
  const releverBanc = (chemins: string[]): { banc: Record<string, string> } | { introuvable: string } => {
    const banc: Record<string, string> = {};
    const bureau = process.env.ESSAIM_BUREAU ?? process.cwd();
    for (const c of chemins) {
      const abs = resolve(bureau, c.startsWith("~/") ? join(homedir(), c.slice(2)) : c);
      let dossier: boolean;
      try { dossier = statSync(abs).isDirectory(); } catch { return { introuvable: c }; }
      for (const [rel, e] of dossier ? M.empreintes(abs) : M.empreintes(dirname(abs), [basename(abs)])) banc[dossier ? join(abs, rel) : abs] = e.blob;
    }
    return { banc };
  };
  const commitDeMain = async (outil: string): Promise<string> => {
    const c = await contenuDans(partage, BRANCHE);
    if ("raison" in c) throw new Error(`${outil} : le dépôt du run est en panne : ${c.raison}`);
    return c.hash;
  };
  // Les fichiers qu'un commit change dans main (un commit de fusion, contre son premier parent) : ce que livre regarde.
  const fichiersTouches = async (hash: string) =>
    (await fichiersDuCommit(partage, hash, { premierParent: true }).catch(() => fichiersDuCommit(partage, hash))).map((f) => f.chemin);

  pi.registerTool({
    name: "ticket_ouvrir", label: "Ouvrir un ticket",
    description: "Ouvrir un ticket, posté dans le fil tickets en nommant le chargé ; avec `chemins`, confier ces fichiers au chargé comme sa part, ses pancartes posées à son nom ; avec `sorte` alerte, ouvrir une alerte, dont l'outil essaie la reproduction une fois (elle doit échouer tant que le défaut est là) puis relève et fige la reproduction : la commande, la graine, les empreintes du banc et du monde, le commit de main ; avec `exigence`, l'alerte est liée à l'exigence qu'elle met en défaut, qui n'est pas satisfaite tant que l'alerte est ouverte. Rend : le numéro du ticket. Refus : chargé absent de la salle, levé avec un chargé que `salle_equipe` liste ; chargé parti (perdu, viré ou fini), levé avec un chargé présent ; un bug ou une amélioration confié à l'assembleur par un autre que celui qui répartit, définitif pour ce chargé ; un bug ou une amélioration confié à l'assembleur sans chemins, levé avec chemins ; un bug ou une amélioration confié à l'assembleur sur la part d'un autre, levé avec des chemins que personne d'autre ne porte ; un troisième bug ou amélioration ouvert confié à l'assembleur, levé quand il en porte moins de deux ; un bug ou une amélioration confié à l'intégrateur quand un chef répartit, levé avec des chemins qui portent tous sa pancarte ; un bug ou une amélioration confié à la recette ou au gardien-mesureur, définitif pour ce chargé ; un bug ou une amélioration confié à un constructeur pendant la préparation, levé avec type question, ou quand le plan est validé ou la préparation close ; le livrable dans `chemins` confié à un autre que son porteur (l'assembleur, sinon l'intégrateur), levé avec lui pour chargé ; type inconnu, levé avec bug, amelioration ou question ; titre ou description vide, levé avec les deux ; sorte inconnue, levé avec travail ou alerte ; alerte ouverte par un autre que la recette ou le gardien-mesureur, définitif pour ce rôle, ou dans un run sans rôles, définitif pour ce run ; alerte sans `reproduction.commande`, levé avec une commande ; reproduction qui passe déjà sur le produit actuel (sens inversé), levé avec une reproduction qui échoue tant que le défaut est là ; fichier du banc introuvable, levé avec un fichier ou un dossier qui existe ; `reproduction` sans alerte, levé avec sorte alerte ; `exigence` sans alerte, levé avec sorte alerte ; exigence inconnue ou retirée, levé avec un libellé que `exigence_lister` donne ; `chemins` confiés par un autre que celui qui répartit les parts (le chef, ou l'intégrateur sans chef), définitif pour ce rôle, ou dans un run sans rôles, définitif pour ce run ; `chemins` sans chargé, levé avec un chargé ; chemin hors du dossier partagé, définitif pour ce chemin.",
    promptSnippet: "ticket_ouvrir(type, titre, description, charge?, chemins?, sorte?, reproduction?, exigence?) : ouvrir un ticket ou une alerte",
    parameters: Type.Object({ type: Type.String({ description: "bug, amelioration ou question" }), titre: Type.String({ description: "le titre du ticket" }), description: Type.String({ description: "où, et comment reproduire" }), charge: Type.Optional(Type.String({ description: "l'agent à qui le confier" })), chemins: Type.Optional(Type.Array(Type.String(), { description: "les fichiers du dossier partagé confiés au chargé comme sa part" })),
      sorte: Type.Optional(Type.String({ description: "travail (sans sorte) ou alerte : un défaut constaté, avec sa reproduction" })),
      reproduction: Type.Optional(Type.Object({ commande: Type.String({ description: "la commande qui vérifie le bon comportement : elle échoue tant que le défaut est là et passe une fois corrigé ; l'outil l'essaie à l'ouverture, le lanceur la rejoue dans le dossier partagé" }), graine: Type.Optional(Type.String({ description: "la graine du tirage, si la commande en tire un ; la commande rejouée la reçoit dans la variable GRAINE" })), banc: Type.Optional(Type.Array(Type.String(), { description: "les fichiers ou dossiers du contrôle, relatifs à ton bureau" })) }, { description: "pour une alerte : ce qui la reproduit, figé à l'ouverture" })),
      exigence: Type.Optional(Type.String({ description: "pour une alerte : le libellé de l'exigence qu'elle met en défaut, E1…" })) }),
    async execute(_id, p) {
      if (p.charge && !agentConnu(p.charge)) return refuse(chargeAbsent(p.charge));
      const parti = p.charge ? chargeParti(p.charge) : undefined;
      if (parti) return refuse(parti);
      if (!T.TYPES_TICKET.includes(p.type as T.TypeTicket)) return refuse(`type ${p.type} inconnu. Se lève avec bug, amelioration ou question`);
      if (!p.titre?.trim() || !p.description?.trim()) return refuse("titre ou description vide. Se lève avec les deux non vides");
      const sorte = (p.sorte ?? "travail") as T.SorteTicket;
      if (!T.SORTES_TICKET.includes(sorte)) return refuse(`sorte ${p.sorte} inconnue. Se lève avec travail ou alerte`);
      if (p.exigence !== undefined) {
        if (sorte !== "alerte") return refuse("une exigence sans alerte. Se lève avec sorte alerte");
        if (!T.exigenceActive(t, p.exigence)) return refuse(`aucune exigence ${p.exigence}. Se lève avec un libellé que exigence_lister donne`);
      }
      let reproduction: T.Reproduction | undefined;
      let essaiRepro = "";
      if (sorte === "alerte") {
        const r = refusAlerte(role);
        if (r) return refuse(r);
        if (!p.reproduction?.commande?.trim()) return refuse("une alerte sans reproduction. Se lève avec reproduction.commande non vide");
        const b = releverBanc(p.reproduction.banc ?? []);
        if ("introuvable" in b) return refuse(`${b.introuvable} est introuvable. Se lève avec un fichier ou un dossier qui existe`);
        const monde = Object.fromEntries([...M.empreintes(join(runDuPartage(), "entrees"))].map(([rel, e]) => [rel, e.blob]));
        const essai = await P.essayerReproduction(join(runDuPartage(), "partage"), p.reproduction.commande, p.reproduction.graine ?? null);
        if (essai.code === 0) return refuse("ta reproduction passe déjà sur le produit actuel : elle doit échouer tant que le défaut est là et passer une fois corrigé, car corrige ferme l'alerte quand le rejeu passe. Se lève avec une reproduction qui échoue");
        essaiRepro = essai.coupe ? "reproduction essayée : délai dépassé" : `reproduction essayée : échoue (code ${essai.code})`;
        reproduction = { commande: p.reproduction.commande, graine: p.reproduction.graine ?? null, commit: await commitDeMain("ticket_ouvrir"), banc: b.banc, monde };
      } else if (p.reproduction) return refuse("une reproduction sans alerte. Se lève avec sorte alerte");
      const chemins = p.chemins?.length ? p.chemins : undefined;
      const assembleur = refusAssembleur(p.charge, p.type, sorte, chemins ?? []);
      if (assembleur) return refuse(assembleur);
      const refusDesChemins = chemins && refusChemins(chemins, p.charge);
      if (refusDesChemins) return refuse(refusDesChemins);
      const integrateur = refusIntegrateur(p.charge, p.type, sorte, chemins ?? []);
      if (integrateur) return refuse(integrateur);
      const controle = refusControle(p.charge, p.type, sorte);
      if (controle) return refuse(controle);
      const exploration = refusPreparation(p.charge, p.type, sorte);
      if (exploration) return refuse(exploration);
      const repro = reproduction ? ` (reproduction : ${reproduction.commande}${reproduction.graine ? `, graine ${reproduction.graine}` : ""}, main ${reproduction.commit.slice(0, 7)} ; ${essaiRepro})` : "";
      // L'annonce est insérée dans la transaction du ticket, avec son fait (second cerveau).
      const id = T.ouvrirTicket(t, { type: p.type as T.TypeTicket, titre: p.titre, description: p.description, auteur: agent, charge: p.charge, chemins: chemins?.map((c) => relatifAuPartage(c)!), sorte, reproduction, exigence: p.exigence,
        annonce: (n) => `[ticket #${n}${reproduction ? ` · alerte${p.exigence ? ` sur ${p.exigence}` : ""}` : ""} · ${p.type}] ${p.titre}${p.charge ? ` — confié à ${p.charge}` : ""}${chemins ? ` (chemins : ${chemins.map((c) => relatifAuPartage(c)).join(", ")})` : ""} : ${p.description}${repro}` });
      return texte(`ticket #${id} ouvert, posté dans le fil tickets`);
    },
  });

  pi.registerTool({
    name: "ticket_modifier", label: "Modifier un ticket",
    description: "Changer l'état, le chargé ou la note d'un ticket, posté dans le fil tickets en nommant le chargé ; avec `chemins`, confier ces fichiers en plus au chargé. Les pancartes d'un ticket à chemins suivent son chargé, et vont à celui qui répartit les parts quand il se ferme. Dans un run à rôles, `motif` ferme le ticket : livre, remplace_par ou annule pour un ticket de travail (fermer un bug ou une amélioration, c'est livrer) ; corrige ou invalide pour une alerte, qui déposent une demande de rejeu au lanceur et laissent l'alerte ouverte jusqu'à son reçu. `bloque_par` le marque bloqué par un autre ticket, sans le fermer. Rend : le numéro du ticket et ce qui a changé, ou la demande de rejeu déposée. Refus : chargé absent de la salle, levé avec un chargé que `salle_equipe` liste ; chargé parti (perdu, viré ou fini), levé avec un chargé présent ; un bug ou une amélioration confié à l'assembleur par un autre que celui qui répartit, définitif pour ce chargé ; un bug ou une amélioration confié à l'assembleur sans chemins, levé avec chemins ; un bug ou une amélioration confié à l'assembleur sur la part d'un autre, levé avec des chemins que personne d'autre ne porte ; un troisième bug ou amélioration ouvert confié à l'assembleur, levé quand il en porte moins de deux ; un bug ou une amélioration confié à l'intégrateur quand un chef répartit, levé avec des chemins qui portent tous sa pancarte ; un bug ou une amélioration confié à la recette ou au gardien-mesureur, définitif pour ce chargé ; un bug ou une amélioration confié à un constructeur pendant la préparation, levé avec type question, ou quand le plan est validé ou la préparation close ; le livrable dans `chemins` confié à un autre que son porteur (l'assembleur, sinon l'intégrateur), levé avec lui pour chargé ; état inconnu, levé avec ouvert, en_cours ou ferme ; ticket inconnu, définitif pour ce numéro ; un bug ou une amélioration fermé sans `commit`, levé avec le commit qui corrige ; commit inconnu ou hors du dossier commun, levé quand le commit est dans le dossier commun ; une question fermée sans `note`, levé avec une note non vide ; rien à changer, levé avec un état, un chargé ou une note qui diffère ; `chemins` confiés, ou ticket à chemins réattribué, par un autre que celui qui répartit les parts (son chargé peut le lui rendre), définitif pour ce rôle, ou dans un run sans rôles, définitif pour ce run ; `chemins` sans chargé, levé avec un chargé ; chemin hors du dossier partagé, définitif pour ce chemin ; motif inconnu, levé avec livre, remplace_par, annule, corrige ou invalide ; motif avec un état autre que ferme, levé sans etat ; motif dans un run sans rôles, définitif pour ce run ; motif d'une autre sorte que le ticket, levé avec un motif de sa sorte ; ticket déjà fermé, définitif pour ce numéro ; livre sans commit, par un commit qui ne touche aucun chemin du ticket, ou sur un ticket sans chemin, levé avec un commit qui touche l'un de ses chemins ; remplace_par sans successeur ouvert, de travail et confié, levé avec un tel successeur ; annule par un autre que celui qui répartit les parts, définitif pour ce rôle ; annule sans `note`, levé avec une raison ; alerte fermée par son état, levé quand le rejeu demandé par corrige ou invalide passe ; corrige ou invalide par le chef, définitif pour ce rôle ; corrige au même commit de main que la reproduction, levé avec un commit qui change le produit, ou une contre-preuve (invalide) ; invalide sans `contre_preuve`, levé avec la commande ; demande de rejeu de l'alerte déjà en attente, levé au reçu du lanceur ; `bloque_par` inconnu ou le ticket lui-même, définitif pour ce numéro.",
    promptSnippet: "ticket_modifier(id, etat?, charge?, commit?, note?, chemins?, motif?, remplace_par?, bloque_par?, contre_preuve?) : changer l'état, le chargé ou la note d'un ticket, ou le fermer par un motif",
    parameters: Type.Object({ id: Type.Number({ description: "le numéro du ticket" }), etat: Type.Optional(Type.String({ description: "ouvert, en_cours ou ferme" })), charge: Type.Optional(Type.String({ description: "l'agent à qui le confier" })), commit: Type.Optional(Type.String({ description: "le commit du dossier commun qui corrige (`depot_journal` les liste) ; exigé pour fermer un bug ou une amélioration, et pour livre" })), note: Type.Optional(Type.String({ description: "la réponse, pour fermer une question ; la raison, pour annule ; sinon un commentaire" })), chemins: Type.Optional(Type.Array(Type.String(), { description: "des fichiers du dossier partagé confiés en plus au chargé" })),
      motif: Type.Optional(Type.String({ description: "livre, remplace_par ou annule (ticket de travail) ; corrige ou invalide (alerte)" })),
      remplace_par: Type.Optional(Type.Number({ description: "pour remplace_par : le ticket qui le remplace, confié à un agent" })),
      bloque_par: Type.Optional(Type.Number({ description: "le ticket qui bloque celui-ci" })),
      contre_preuve: Type.Optional(Type.String({ description: "pour invalide : la commande rejouée aux mêmes conditions que la reproduction" })) }),
    async execute(_id, p) {
      if (p.charge && !agentConnu(p.charge)) return refuse(chargeAbsent(p.charge));
      const parti = p.charge ? chargeParti(p.charge) : undefined;
      if (parti) return refuse(parti);
      if (p.etat !== undefined && !T.ETATS_TICKET.includes(p.etat as T.EtatTicket)) return refuse(`état ${p.etat} inconnu. Se lève avec ouvert, en_cours ou ferme`);
      if (p.motif !== undefined) {
        if (!T.MOTIFS.includes(p.motif as T.Motif)) return refuse(`motif ${p.motif} inconnu. Se lève avec livre, remplace_par, annule, corrige ou invalide`);
        if (p.etat !== undefined && p.etat !== "ferme") return refuse(`un motif ferme le ticket, l'état ${p.etat} le laisse ouvert. Se lève sans etat, ou avec etat ferme`);
        const r = refusMotif(role, p.motif, equipeRoles(), agent);
        if (r) return refuse(r);
      }
      const k = T.lireTicket(t, p.id);
      if (!k) return refuse(ticketInconnu(p.id));
      // Rôles : confier des chemins, ou réattribuer un ticket qui en porte, revient à qui répartit ; son chargé peut
      // le lui rendre.
      const rep = repartiteur(equipeRoles());
      const chemins = p.chemins?.length ? p.chemins : undefined;
      if (p.charge !== undefined && p.charge !== k.charge) {
        const assembleur = refusAssembleur(p.charge, k.type, k.sorte, [...(chemins ?? []), ...T.cheminsDuTicket(k)]);
        if (assembleur) return refuse(assembleur);
      }
      const reattribue = !!k.chemins && p.charge !== undefined && p.charge !== k.charge && !(k.charge === agent && p.charge === rep?.nom);
      if (chemins || reattribue) {
        const r = refusChemins([...(chemins ?? []), ...(reattribue ? T.cheminsDuTicket(k) : [])], p.charge ?? k.charge);
        if (r) return refuse(r);
      }
      if (p.charge !== undefined && p.charge !== k.charge) {
        const integrateur = refusIntegrateur(p.charge, k.type, k.sorte, [...(chemins ?? []), ...T.cheminsDuTicket(k)]);
        if (integrateur) return refuse(integrateur);
        const controle = refusControle(p.charge, k.type, k.sorte);
        if (controle) return refuse(controle);
        const exploration = refusPreparation(p.charge, k.type, k.sorte);
        if (exploration) return refuse(exploration);
      }
      const annonce = (apres: T.Ticket, quoi: string) => `[ticket #${p.id}] ${apres.titre} : ${quoi}${apres.charge && apres.etat !== "ferme" ? ` (chargé : ${apres.charge})` : ""}`;
      const derniereNote = () => texte(`ticket #${p.id} : ${T.lireTicket(t, p.id)!.notes.at(-1)!.texte}`);
      // Rôles : dans un run à rôles, fermer un bug ou une amélioration par son état, c'est le livrer (même contrôle
      // du commit) ; une alerte ne se ferme pas par son état (majTicket le refuse).
      const alerte = k.sorte === "alerte";
      const motif = (p.motif as T.Motif | undefined) ?? (role && p.etat === "ferme" && k.type !== "question" && !alerte ? "livre" : undefined);
      if (motif === "corrige" || motif === "invalide") {
        const r = T.demanderRejeu(t, { ticket: p.id, demandeur: agent, motif, commit: await commitDeMain("ticket_modifier"), contrePreuve: p.contre_preuve }, annonce);
        return r.ok ? derniereNote() : refuse(r.raison);
      }
      let commit: string | undefined, fichiers: string[] | undefined;
      if (motif === "livre" && p.commit) {
        const c = await contenuDans(partage, p.commit);
        if ("raison" in c) return refuse(c.raison);
        commit = c.hash;
        fichiers = await fichiersTouches(c.hash);
      } else if (!motif && p.etat === "ferme" && k.type !== "question" && !alerte) {
        if (!p.commit) return refuse(T.raisonSansCommit(k.type));
        const c = await contenuDans(partage, p.commit);
        if ("raison" in c) return refuse(c.raison);
        commit = c.hash;
      }
      const question = !motif && p.etat === "ferme" && k.type === "question";
      const r = T.majTicket(t, p.id, agent, { etat: p.etat as T.EtatTicket | undefined, charge: p.charge, commit, chemins: chemins?.map((c) => relatifAuPartage(c)!), rendreA: rep?.nom,
        reponse: question ? p.note : undefined, note: question ? undefined : p.note, motif, fichiers, remplacePar: p.remplace_par, bloquePar: p.bloque_par }, annonce);
      if (!r.ok) return refuse(r.raison);
      return derniereNote();
    },
  });

  pi.registerTool({
    name: "ticket_lister", label: "Lister les tickets",
    description: "Lister les tickets. Rend : numéro, type, état, auteur, chargé et titre de chacun, ou « aucun ticket ».",
    promptSnippet: "ticket_lister(etat?, charge?) : lister les tickets",
    parameters: Type.Object({ etat: Type.Optional(Type.String({ description: "filtre : ouvert, en_cours ou ferme" })), charge: Type.Optional(Type.String({ description: "filtre : l'agent chargé" })) }),
    async execute(_id, p) {
      const liste = T.listerTickets(t, { etat: p.etat as T.EtatTicket | undefined, charge: p.charge });
      return texte(liste.length ? liste.map(ligneTicket).join("\n") : "aucun ticket");
    },
  });

  pi.registerTool({
    name: "ticket_lire", label: "Lire un ticket",
    description: "Lire un ticket en entier. Rend : le ticket, sa description, sa réponse et son historique. Refus : ticket inconnu, définitif pour ce numéro.",
    promptSnippet: "ticket_lire(id) : lire un ticket en entier",
    parameters: Type.Object({ id: Type.Number({ description: "le numéro du ticket" }) }),
    async execute(_id, p) {
      const k = T.lireTicket(t, p.id);
      if (!k) return refuse(ticketInconnu(p.id));
      const r = T.reproductionDuTicket(k);
      const fichiers = (o: Record<string, string>) => { const n = Object.keys(o).length; return `${n} fichier${n > 1 ? "s" : ""}`; };
      const repro = r ? [`reproduction : ${r.commande} · graine ${r.graine ?? "aucune"} · main ${r.commit.slice(0, 7)} · banc : ${fichiers(r.banc)} · monde : ${fichiers(r.monde)}`] : [];
      return texte([ligneTicket(k), k.description ?? "", ...repro, ...(k.reponse ? [`réponse : ${k.reponse}`] : []), ...k.notes.map((n) => `${n.cree_le} ${n.auteur} : ${n.texte}`)].join("\n"));
    },
  });

  pi.registerTool({
    name: "salle_equipe", label: "Équipe",
    description: "Lister les agents de la salle. Rend : pour chacun son nom, son surnom, " + (role ? "son rôle, " : "") + "son état (actif, dormant, fini, vire, perdu) et depuis quand, ses tickets ouverts, et pour un dormeur ce qu'il attend (« vague » quand l'attente ne nomme ni ticket ouvert ni agent : il compte disponible) ou « n'attend rien ».",
    promptSnippet: "salle_equipe() : lister les agents de la salle",
    parameters: Type.Object({}),
    async execute() {
      const duree = (le: string | null) => le ? T.dureeTexte(Math.max(0, Math.round((Date.now() - Date.parse(le)) / 60_000))) : "jamais";
      return texte(T.equipeDetaillee(t, { repartiteur: role ? repartiteurPresent() : undefined }).map((a) => [
        `${a.nom}${a.surnom ? " (" + a.surnom + ")" : ""}`,
        ...(a.role ? [a.role + (a.suppleant_de ? ` (suppléant ${a.suppleant_de === "chef" ? "du chef" : "de l'intégrateur"})` : "")] : []),
        `${a.etat} depuis ${duree(a.depuis)}`,
        a.tickets.length ? `tickets ${a.tickets.map((k) => `#${k}`).join(", ")}` : "aucun ticket",
        ...(a.etat === "dormant" ? [a.attente ? `attend${a.attente.vague ? " (vague, compté disponible)" : ""} : ${a.attente.texte}${a.attente.perimee ? ` (depuis plus de ${Math.round(Number(process.env.ESSAIM_ATTENTE_MS ?? 30 * 60_000) / 60_000)} min)` : ""}` : "n'attend rien"] : []),
      ].join(" · ")).join("\n"));
    },
  });

  pi.registerTool({
    name: "salle_surnom", label: "Surnom",
    description: "Enregistrer ton surnom, affiché à côté de ton nom. Rend : le surnom enregistré.",
    promptSnippet: "salle_surnom(surnom) : enregistrer ton surnom, affiché à côté de ton nom",
    parameters: Type.Object({ surnom: Type.String({ description: "le surnom" }) }),
    async execute(_id, p) {
      T.surnom(t, agent, p.surnom);
      return texte(`surnom enregistré : ${p.surnom}`);
    },
  });

  pi.registerTool({
    name: "fichier_reclamer", label: "Réclamer un fichier",
    description: "Poser ta pancarte sur un fichier du dossier partagé. Sans rôles, les pancartes sont consultatives : elles n'empêchent aucune écriture, sauf `depot_restaurer` ; dans un run à rôles, la pancarte d'un autre refuse l'écriture du fichier, et ce qu'un bash y écrit est remis à son dernier commit. Rend : la pancarte posée. Refus : chemin hors du dossier partagé, définitif pour ce chemin ; si un autre agent a une pancarte sur ce fichier, levé quand il la retire ; si tu as déjà une pancarte sur ce fichier, levé par `fichier_liberer` ; base de la salle occupée, levé en quelques secondes ; dans un run à rôles, pancarte hors de tes parts, levé pour un constructeur quand celui qui répartit les parts te confie ce chemin.",
    promptSnippet: "fichier_reclamer(chemin, raison) : poser ta pancarte sur un fichier du dossier partagé",
    parameters: Type.Object({ chemin: Type.String({ description: "le fichier, relatif au dossier partagé" }), raison: Type.String({ description: "ce que tu y fais, montré aux autres" }) }),
    async execute(_id, p) {
      const refusRole = role && refusDuRole(role, "fichier_reclamer", undefined, contexteRole());
      if (refusRole) return refuse(refusRole);
      const r = T.reclamer(t, agent, p.chemin, p.raison);
      if (r.ok) return texte(`pancarte posée sur ${T.normaliserChemin(p.chemin)}`);
      if (r.reessayer) return refuse("la base de la salle est occupée. Se lève en quelques secondes");
      // La pancarte déjà posée par soi se distingue de celle d'un autre.
      if (r.occupe_par === agent) return refuse(`tu as déjà une pancarte sur ce fichier depuis ${r.depuis}. Se lève par fichier_liberer`);
      if (r.occupe_par) return refuse(`${r.occupe_par} a une pancarte sur ce fichier depuis ${r.depuis}. Se lève quand ${r.occupe_par} la retire`);
      return refuse(r.raison!);
    },
  });

  pi.registerTool({
    name: "fichier_liberer", label: "Libérer un fichier",
    description: "Retirer ta pancarte d'un fichier. Rend : la confirmation, ou « aucune pancarte à toi ».",
    promptSnippet: "fichier_liberer(chemin) : retirer ta pancarte d'un fichier",
    parameters: Type.Object({ chemin: Type.String({ description: "le fichier, relatif au dossier partagé" }) }),
    async execute(_id, p) {
      const r = T.liberer(t, agent, p.chemin);
      return texte(r.ok ? `pancarte retirée de ${T.normaliserChemin(p.chemin)}` : `aucune pancarte à toi sur ${p.chemin}`);
    },
  });

  pi.registerTool({
    name: "fichier_pancartes", label: "Réclamations",
    description: "Lister les pancartes du dossier partagé. Rend : pour chacune le fichier, l'agent, la raison et depuis quand ; ou « aucune pancarte ».",
    promptSnippet: "fichier_pancartes() : lister les pancartes du dossier partagé",
    parameters: Type.Object({}),
    async execute() {
      const liste = T.reclamations(t);
      if (liste.length === 0) return texte("aucune pancarte");
      return texte(liste.map((r) => `${r.chemin} · ${r.agent} · ${r.raison} · depuis ${r.pose_le}`).join("\n"));
    },
  });

  // ---- Les exigences (rôles des agents) : seulement dans un run à rôles. Au début d'un run avec chef, le
  // lanceur a posé les phrases numérotées de la mission ; le chef les range, le gardien-mesureur conteste un classement
  // (une question au chef), tous lisent la liste.
  if (role) {
    const siege = (r: string) => equipeRoles().find((a) => a.role === r);
    const sansChef = "aucun chef dans ce run, donc aucune liste d'exigences. Définitif pour ce run";
    const court = (s: string) => (s.length > 160 ? s.slice(0, 160) + "…" : s);

    // ---- Préparer la mission : qui répartit propose le plan, la recette et
    // le gardien le contrôlent (les choix de construction du chef et de l'intégrateur). Validé par chaque contrôleur
    // présent, la préparation se clôt et les constructeurs, qui attendaient le plan, deviennent disponibles.
    const sansQuestion = (x: string) => x.replace(/\?/g, ""); // une question citée réveillerait qui elle nomme
    const presentsDe = (roles: string[]) => equipeRoles().filter((a) => a.present !== false && roles.includes(a.role ?? ""));
    // Une version validée : la spec ouvre l'étape du plan (le chef en est prévenu) ; le plan ouvre la construction.
    // Le surveillant : une version n'est validée qu'une fois ; une seconde validation ne rouvre ni ne clôt rien.
    const valider = (etape: T.EtapePlan, n: number) => {
      if (!T.marquerPlanValide(t, n)) return "";
      if (etape === "plan") return annoncerValide(n);
      const dest = [...new Set([T.lirePlan(t, n)?.auteur ?? agent])];
      T.poster(t, "lanceur", `${dest.join(", ")} : spec n°${n} validée ; elle ne change plus sans révision. Le plan suit : PLAN.md, le tableau des tickets, puis plan_proposer avec etape plan.`, "principal");
      T.ajouterEvenement(t, { agent, type: "plan", resultat: `spec n°${n} validée` });
      return " · spec validée : le plan suit";
    };
    // Le plan d'une révision acceptée : validé, il clôt la révision (la préparation est déjà close).
    const annoncerValide = (n: number) => {
      const rev = S.revisionEnCours(t);
      if (rev?.etat === "acceptee" && T.lirePlan(t, n)?.revision_id === rev.id) {
        if (!S.cloreRevision(t, rev.id, "plan")) return "";
        const suite = S.resoudreGel(t, rev.id, n);
        T.poster(t, "essaim", `[plan] plan n°${n} validé : la révision n°${rev.id} est close.${suite}`, "principal");
        T.ajouterEvenement(t, { agent, type: "plan", resultat: `plan n°${n} validé : révision n°${rev.id} close` });
        return ` · plan validé : la révision n°${rev.id} est close`;
      }
      if (!T.clorePreparation(t, "validee")) return "";
      T.poster(t, "essaim", `[plan] plan n°${n} validé : la construction commence.`, "principal");
      T.ajouterEvenement(t, { agent, type: "plan", resultat: `plan n°${n} validé : la construction commence` });
      return " · plan validé : la construction commence";
    };
    const empreinte = (chemin: string) => createHash("sha256").update(readFileSync(chemin)).digest("hex");
    // La dernière proposition qui se juge : pendant une révision acceptée, celle de la révision (l'ancien plan n'est
    // plus jugeable) ; sinon la dernière.
    const derniereJugeable = () => {
      const rev = S.revisionEnCours(t);
      return rev?.etat === "acceptee" ? T.dernierPlan(t, rev.id) : T.dernierPlan(t);
    };
    // La spec puis le plan, pour qu'un seul fichier ne serve pas à la fois de spec, plan, état et journal. Deux étapes, deux fichiers de noms fixes,
    // écrits par qui répartit : SPEC.md (le but, le problème, l'approche choisie et les options écartées, chaque exigence
    // avec sa preuve), validée puis figée ; PLAN.md (le tableau des tickets), proposé ensuite. 6 000 signes au plus chacun.
    const FICHIER_ETAPE: Record<T.EtapePlan, string> = { spec: "SPEC.md", plan: "PLAN.md" };
    const ETAPE_MAX = 6_000;
    const nomEtape = (e: T.EtapePlan, n: number) => e === "spec" ? `spec n°${n}` : `plan n°${n}`;
    // Les jalons : avec la proposition, chaque exigence découpée, ses phrases de mission en entier puis les
    // portées de ses jalons, pour que la recette et le gardien jugent la couverture et l'équilibre.
    const decoupages = () => {
      const texteDe = new Map(T.phrases(t).map((x) => [x.n, x.texte]));
      const l = T.listerExigences(t).filter((e) => !e.retiree && !e.parent && T.estDecoupee(t, e.libelle)).map((e) =>
        `${e.libelle} : ${e.phrases.map((n) => `[${n}] ${texteDe.get(n) ?? ""}`).join(" ")} Jalons : ${T.jalonsDe(t, e.libelle).map((j) => `${j.libelle} (${j.portee})`).join(", ")}.`);
      return l.length ? sansQuestion(` Découpages à juger : ${l.join(" ")}`) : "";
    };
    pi.registerTool({
      name: "plan_proposer", label: "Proposer la spec ou le plan",
      description: "Proposer, en deux étapes, ce que la salle va faire, aux contrôles de la recette et du gardien-mesureur présents. D'abord `spec` : SPEC.md, le but, le problème mesuré, l'approche choisie avec les options écartées et ce que les explorations ont mesuré, puis chaque exigence avec la commande qui la prouve et son responsable ; validée, elle ne change plus sans révision. Ensuite `plan` : PLAN.md, le tableau des tickets (quoi, fichiers, porteur, vérificateur distinct, exigence couverte, priorité, coût). Chaque fichier est à la racine du dossier partagé, 6 000 signes au plus ; le détail va dans d'autres fichiers. Sans contrôleur présent, la version est validée telle quelle. Une révision demandée par le surveillant et acceptée rouvre la spec : `exigences_changees` y nomme les exigences que la nouvelle spec change (vide permise), rangées de nouveau avant le plan ; le plan nomme dans `tickets_repris` les tickets gelés qu'il reprend, les autres sont annulés à sa validation. Rend : le numéro de la version. Refus : un autre que celui qui répartit le travail, définitif pour ce rôle ; étape inconnue, levé avec spec ou plan ; résumé vide, levé avec un résumé non vide ; fichier de l'étape absent, levé quand SPEC.md ou PLAN.md existe ; fichier de plus de 6 000 signes, levé quand il est raccourci ; spec déjà validée, levé quand une révision est acceptée ; plan avant la spec validée, levé quand la recette et le gardien l'ont validée ; pendant une révision, une spec sans `exigences_changees`, levé avec la liste ; une exigence déclarée inconnue ou retirée, levé avec un libellé que `exigence_lister` donne ; pendant une révision, un plan alors qu'une exigence déclarée changée n'est pas rangée de nouveau, levé quand ses phrases sont rangées de nouveau (`exigence_ranger`) ; un ticket repris qui n'est pas gelé par la révision, levé avec des tickets gelés.",
      promptSnippet: "plan_proposer(etape, resume, exigences_changees?, tickets_repris?) : proposer SPEC.md (spec), puis PLAN.md (plan), à la recette et au gardien",
      parameters: Type.Object({ etape: Type.String({ description: "spec (SPEC.md : le but, le problème, l'approche, les preuves), puis plan (PLAN.md : le tableau des tickets)" }),
        resume: Type.String({ description: "la version en quelques lignes : ce qui a changé depuis la précédente" }),
        exigences_changees: Type.Optional(Type.Array(Type.String(), { description: "pendant une révision, pour la spec : les libellés des exigences que la nouvelle spec change (E3…), vide si aucune" })),
        tickets_repris: Type.Optional(Type.Array(Type.Number(), { description: "pendant une révision, pour le plan : les tickets gelés que le plan reprend" })) }),
      async execute(_id, p) {
        const rep = repartiteur(equipeRoles().filter((a) => a.present !== false));
        if (!rep || rep.nom !== agent) return refuse(`la spec et le plan se proposent par qui répartit le travail${rep ? ` (${rep.nom})` : ""}. Définitif pour ce rôle`);
        if (p.etape !== "spec" && p.etape !== "plan") return refuse("étape inconnue. Se lève avec spec ou plan");
        const etape = p.etape as T.EtapePlan, fichier = FICHIER_ETAPE[etape];
        const resume = (p.resume ?? "").trim();
        if (!resume) return refuse("résumé vide. Se lève avec un résumé non vide");
        const chemin = join(process.env.ESSAIM_PARTAGE ?? "", fichier);
        if (!existsSync(chemin)) return refuse(`${fichier} n'existe pas à la racine du dossier partagé. Se lève quand ${fichier} existe`);
        const signes = [...readFileSync(chemin, "utf8")].length;
        if (signes > ETAPE_MAX) return refuse(`${fichier} fait ${signes} signes, ${ETAPE_MAX} au plus. Se lève quand il est raccourci ; le détail va dans d'autres fichiers, que ${fichier} nomme`);
        const specOk = T.specValidee(t);
        if (etape === "spec" && specOk) return refuse("la spec est déjà validée : elle ne change plus sans révision. Se lève quand une révision demandée par le surveillant est acceptée");
        if (etape === "plan" && !specOk) return refuse("la spec n'est pas encore validée. Se lève quand la recette et le gardien l'ont validée");
        // La révision : les exigences que la nouvelle spec change sont déclarées par le chef, et rangées de
        // nouveau avant le plan (leur ancienne attestation part avec l'exigence retirée) ; le plan dit les tickets gelés repris.
        const rev = S.revisionEnCours(t);
        const enRevision = rev?.etat === "acceptee" ? rev : undefined;
        // Un jalon n'est pas une exigence de la spec : il n'a pas de phrases à ranger de nouveau.
        const actives = new Set(T.listerExigences(t).filter((e) => !e.retiree && !e.parent).map((e) => e.libelle));
        if (enRevision && etape === "spec" && !p.exigences_changees) return refuse("pendant une révision, la spec déclare les exigences qu'elle change (exigences_changees). Se lève avec la liste, vide s'il n'y en a aucune");
        const inconnue = (p.exigences_changees ?? []).find((e) => !actives.has(e));
        if (etape === "spec" && inconnue) return refuse(`l'exigence ${inconnue} est inconnue ou retirée. Se lève avec un libellé que exigence_lister donne`);
        if (enRevision && etape === "plan") {
          const declarees = t.all<{ x: string | null }>("SELECT exigences_changees AS x FROM plans WHERE revision_id = ? AND etape = 'spec' AND valide_le IS NOT NULL", [enRevision.id])
            .flatMap((r) => r.x ? JSON.parse(r.x) as string[] : []);
          const restante = declarees.find((e) => actives.has(e));
          if (restante) return refuse(`${restante} est déclarée changée par la spec révisée et n'est pas rangée de nouveau. Se lève quand ses phrases sont rangées de nouveau (exigence_ranger)`);
          const geles: number[] = JSON.parse(S.lireRevision(t, enRevision.id)?.tickets_geles_json ?? "[]");
          const pasGele = (p.tickets_repris ?? []).find((k) => !geles.includes(k));
          if (pasGele !== undefined) return refuse(`le ticket #${pasGele} n'est pas gelé par la révision. Se lève avec des tickets gelés (${geles.map((k) => `#${k}`).join(", ") || "aucun"})`);
        }
        const n = T.proposerPlan(t, agent, resume, fichier, etape, { revision: enRevision?.id, empreinte: empreinte(chemin), decoupage: T.empreinteDecoupage(t),
          exigencesChangees: enRevision && etape === "spec" ? p.exigences_changees : undefined, ticketsRepris: enRevision && etape === "plan" ? p.tickets_repris ?? [] : undefined });
        const controleurs = presentsDe(["recette", "gardien"]).map((a) => a.nom);
        if (!controleurs.length) {
          // Les jalons : sans contrôleur, un découpage n'est jugé par personne ; le bilan le dit.
          if (T.empreinteDecoupage(t)) T.ajouterEvenement(t, { agent: "lanceur", type: "plan", resultat: `découpage non jugé : ${nomEtape(etape, n)} validée sans contrôleur présent` });
          return texte(`${nomEtape(etape, n)} proposé${etape === "spec" ? "e" : ""}${valider(etape, n) || " (aucun contrôleur présent)"}`);
        }
        // Un message signé lanceur, adressé aux contrôleurs en tête : il ne réveille qu'eux (un message essaim réveille
        // chaque agent qu'il nomme, l'auteur du plan compris, qui repropose à son réveil, en boucle).
        T.poster(t, "lanceur", `${controleurs.join(", ")} : ${nomEtape(etape, n)} proposé${etape === "spec" ? "e" : ""}, à contrôler (plan_juger) : ${fichier}. ${sansQuestion(court(resume))}${decoupages()}`, "principal");
        return texte(`${nomEtape(etape, n)} proposé${etape === "spec" ? "e" : ""} ; contrôle attendu de ${controleurs.join(", ")}`);
      },
    });
    pi.registerTool({
      name: "plan_juger", label: "Juger la spec ou le plan",
      description: "Juger la dernière version proposée. Une spec : l'approche mène-t-elle au but sans fabriquer de réussite, chaque exigence a-t-elle une commande de preuve que le lanceur peut rejouer telle qu'elle est écrite ? Un plan : chaque exigence a-t-elle ses tickets, chaque ticket un porteur et un vérificateur distinct, le coût tient-il dans le budget ? `valide`, ou `a_revoir` avec ce qui manque. Un `a_revoir` est annoncé à qui répartit et à l'intégrateur. Validée par chaque contrôleur présent, la spec ouvre l'étape du plan ; le plan validé ouvre la construction. Pendant une révision, seules les versions de la révision se jugent. Une exigence découpée en jalons : est-elle couverte entière par ses jalons, sans trou, et le travail réparti entre eux sans qu'un jalon porte presque tout ? Le message de la proposition donne ses phrases et ses jalons. Rend : le jugement, et la validation s'il y a lieu. Refus : aucune version proposée ou version qui n'est pas la dernière, levé avec le numéro de la dernière version ; verdict inconnu, levé avec valide ou a_revoir ; raison vide, levé avec une raison non vide ; fichier changé depuis la proposition, levé avec une nouvelle proposition ; découpage en jalons changé depuis la proposition, levé avec une nouvelle proposition.",
      promptSnippet: "plan_juger(plan, verdict, raison) : valider ou renvoyer la dernière version de la spec ou du plan",
      parameters: Type.Object({ plan: Type.Number({ description: "le numéro de la version jugée" }), verdict: Type.String({ description: "valide ou a_revoir" }),
        raison: Type.String({ description: "ce qui a été vérifié, ou ce qui manque" }) }),
      async execute(_id, p) {
        if (role !== "recette" && role !== "gardien") return refuse("le plan se juge par la recette et le gardien-mesureur. Définitif pour ce rôle");
        const dernier = derniereJugeable();
        if (!dernier || dernier.id !== p.plan) return refuse(dernier ? `la version n°${p.plan} n'est pas la dernière. Se lève avec la version n°${dernier.id}` : "aucune version proposée. Se lève avec le numéro d'une version proposée");
        if (p.verdict !== "valide" && p.verdict !== "a_revoir") return refuse("verdict inconnu. Se lève avec valide ou a_revoir");
        const raison = (p.raison ?? "").trim();
        if (!raison) return refuse("raison vide. Se lève avec une raison non vide");
        // On juge la version proposée, pas un fichier réécrit depuis.
        const fichierJuge = join(process.env.ESSAIM_PARTAGE ?? "", dernier.fichier ?? "");
        if (dernier.empreinte && dernier.fichier && (!existsSync(fichierJuge) || empreinte(fichierJuge) !== dernier.empreinte))
          return refuse(`${dernier.fichier} a changé depuis la proposition n°${dernier.id}. Se lève avec une nouvelle proposition`);
        // Les jalons : la couverture jugée est celle de la proposition, pas un découpage refait depuis.
        if (typeof dernier.decoupage === "string" && dernier.decoupage !== T.empreinteDecoupage(t))
          return refuse(`le découpage a changé depuis la proposition n°${dernier.id}. Se lève avec une nouvelle proposition`);
        const etape: T.EtapePlan = dernier.etape === "spec" ? "spec" : "plan", nom = nomEtape(etape, dernier.id);
        const valide = T.jugerPlan(t, { plan: dernier.id, agent, role, verdict: p.verdict, raison }, presentsDe(["recette", "gardien"]).map((a) => a.nom));
        if (p.verdict === "a_revoir") {
          const dest = [...new Set([dernier.auteur, ...presentsDe(["integrateur"]).map((a) => a.nom)])];
          T.poster(t, "lanceur", `${dest.join(", ")} : ${nom} à revoir, selon ${role === "recette" ? "la recette" : "le gardien-mesureur"} : ${sansQuestion(court(raison))}`, "principal");
          return texte(`${nom} : à revoir, annoncé à ${dest.join(", ")}`);
        }
        return texte(`${nom} : valide${valide ? valider(etape, dernier.id) : " ; en attente des autres contrôleurs"}`);
      },
    });

    // ---- La révision : le surveillant la demande, le chef y répond. Une seule à
    // la fois ; deux acceptées au plus ; un seul message signé lanceur pour le chef, le gardien et la recette présents.
    const destinataires = () => S.destinatairesSurveillant(equipeRoles());
    const livrable = () => T.normaliserChemin(process.env.ESSAIM_LIVRABLE ?? "");
    // Les tickets qu'une révision peut geler : des tickets de travail ouverts, jamais une alerte ni le livrable.
    const refusTicketsGel = (ids: number[]): string | undefined => {
      const l = livrable();
      for (const id of ids) {
        const k = T.lireTicket(t, id);
        if (!k || k.etat === "ferme" || (k.sorte ?? "travail") !== "travail" || (l && T.cheminsDuTicket(k).some((c) => T.cleChemin(c) === T.cleChemin(l))))
          return `le ticket #${id} n'est pas un ticket de travail ouvert hors du livrable. Se lève avec des tickets de travail ouverts qui ne portent pas le livrable`;
      }
      return undefined;
    };
    pi.registerTool({
      name: "revision_demander", label: "Demander une révision de la spec",
      description: "Demander au chef une révision de la spec et du plan, quand un fait mesuré pendant le run contredit une hypothèse de la spec : « la spec suppose X ; le run mesure Y », avec la source de la mesure, sans méthode. Avec lui, les tickets de travail ouverts que le défaut touche selon toi ; le chef confirme ou corrige la liste, et les tickets retenus sont gelés jusqu'au plan révisé. Un seul message signé lanceur part au chef, au gardien et à la recette présents ; le chef répond par revision_repondre. Rend : le numéro de la révision. Refus : préparation en cours, levé quand elle se clôt ; grâce pas finie, levé à l'heure donnée ; une révision déjà demandée ou ouverte, levé quand elle est close ; deux révisions déjà acceptées, définitif pour ce run ; aucun signe du lanceur depuis la dernière demande ou le dernier sommeil, levé quand un signe s'allume ; constat vide ou de plus de 1 500 signes, levé avec un constat de 1 à 1 500 signes ; un ticket qui n'est pas de travail, ouvert et hors du livrable, levé avec des tickets de travail ouverts.",
      promptSnippet: "revision_demander(constat, tickets) : demander au chef une révision de la spec, avec le fait qui la contredit",
      parameters: Type.Object({ constat: Type.String({ description: "« la spec suppose X ; le run mesure Y », avec la source de la mesure (commande, fichier, message)" }),
        tickets: Type.Array(Type.Number(), { description: "les tickets de travail ouverts que le défaut touche, selon toi" }) }),
      async execute(_id, p) {
        if (T.preparation(t) === "en_cours") return refuse("la préparation est en cours. Se lève quand elle se clôt");
        const grace = S.finDeGrace(t, Date.now());
        if (!grace) return refuse("la préparation est en cours. Se lève quand elle se clôt");
        if (!grace.finie) return refuse(`la grâce n'est pas finie : le plan agit encore ${Math.ceil(grace.resteMs / 60_000)} min. Se lève à ${new Date(Date.now() + grace.resteMs).toISOString().slice(11, 16)} UTC`);
        const enCours = S.revisionEnCours(t);
        if (enCours) return refuse(`la révision n°${enCours.id} est ${enCours.etat === "demandee" ? "demandée, sans réponse" : "ouverte"}. Se lève quand elle est close`);
        if (S.revisionsAcceptees(t) >= S.seuils().revisionsMax) return refuse(`${S.seuils().revisionsMax} révisions déjà acceptées dans ce run ; au-delà, le surveillant alerte le chef par message. Définitif pour ce run`);
        if (!S.signeNonConsomme(t)) return refuse("aucun signe du lanceur depuis ta dernière demande ou ton dernier sommeil. Se lève quand un signe s'allume et te réveille");
        const constat = (p.constat ?? "").trim();
        if (!constat || [...constat].length > 1_500) return refuse(`constat ${constat ? `de ${[...constat].length} signes` : "vide"}. Se lève avec un constat de 1 à 1 500 signes`);
        const tickets = [...new Set(p.tickets ?? [])];
        const r = refusTicketsGel(tickets);
        if (r) return refuse(r);
        const id = S.demanderRevision(t, { demandeur: agent, constat, tickets });
        S.consommerSignes(t, agent, `révision n°${id} demandée`);
        const dest = destinataires(), chef = repartiteurPresent();
        T.poster(t, "lanceur", `${dest.join(", ")} : révision n°${id} demandée par ${agent}. ${sansQuestion(constat)} Tickets touchés selon ${agent} : ${tickets.map((k) => `#${k}`).join(", ") || "aucun"}.${chef ? ` ${chef} répond par revision_repondre.` : ""}`, "principal");
        T.ajouterEvenement(t, { agent, type: "revision", resultat: `révision n°${id} demandée : ${court(constat)}` });
        return texte(`révision n°${id} demandée ; annoncée à ${dest.join(", ") || "personne"}`);
      },
    });
    pi.registerTool({
      name: "revision_repondre", label: "Répondre à une révision",
      description: "Répondre à la révision demandée par le surveillant. Acceptée : les tickets de `tickets_geles` (sans eux, ceux qu'il a proposés) sont gelés, la spec se rouvre ; SPEC.md puis PLAN.md se proposent par plan_proposer et se jugent comme à la préparation. Refusée : la raison part au surveillant, au gardien et à la recette ; un refus ne compte pas dans les deux révisions permises. Sans réponse, un rappel part au bout de 15 minutes et la demande expire au bout de 30. Rend : la réponse enregistrée. Refus : un autre que celui qui répartit le travail, définitif pour ce rôle ; aucune révision en attente de réponse, levé quand le surveillant en demande une ; raison vide, levé avec une raison non vide ; un ticket gelé qui n'est pas de travail, ouvert et hors du livrable, levé avec des tickets de travail ouverts.",
      promptSnippet: "revision_repondre(accepte, raison, tickets_geles?) : accepter ou refuser la révision demandée par le surveillant",
      parameters: Type.Object({ accepte: Type.Boolean({ description: "vrai : la spec se rouvre ; faux : la révision est refusée" }),
        raison: Type.String({ description: "pourquoi, lu par le surveillant, le gardien et la recette" }),
        tickets_geles: Type.Optional(Type.Array(Type.Number(), { description: "à l'acceptation, les tickets gelés ; sans eux, ceux que le surveillant a proposés" })) }),
      async execute(_id, p) {
        const rep = repartiteurPresent();
        if (rep !== agent) return refuse(`une révision se répond par qui répartit le travail${rep ? ` (${rep})` : ""}. Définitif pour ce rôle`);
        const rev = S.revisionEnCours(t);
        if (!rev || rev.etat !== "demandee") return refuse("aucune révision en attente de réponse. Se lève quand le surveillant en demande une");
        const raison = (p.raison ?? "").trim();
        if (!raison) return refuse("raison vide. Se lève avec une raison non vide");
        const proposes: number[] = JSON.parse(S.lireRevision(t, rev.id)!.tickets_json);
        const geles = [...new Set(p.tickets_geles ?? proposes)];
        if (p.accepte) { const r = refusTicketsGel(geles); if (r) return refuse(r); }
        const surveillant = S.lireRevision(t, rev.id)!.demandeur;
        const dest = [...new Set([surveillant, ...destinataires().filter((n) => n !== agent)])];
        if (!p.accepte) {
          S.repondreRevision(t, rev.id, { accepte: false, raison, par: agent });
          S.consommerSignes(t, agent, `révision n°${rev.id} refusée`);
          T.poster(t, "lanceur", `${dest.join(", ")} : révision n°${rev.id} refusée par ${agent} : ${sansQuestion(court(raison))}`, "principal");
          T.ajouterEvenement(t, { agent, type: "revision", resultat: `révision n°${rev.id} refusée : ${court(raison)}` });
          return texte(`révision n°${rev.id} refusée ; la raison est annoncée à ${dest.join(", ")}`);
        }
        const gelesFaits = t.transaction(() => {
          S.repondreRevision(t, rev.id, { accepte: true, raison, par: agent, tickets: geles });
          return S.gelerTickets(t, rev.id, geles);
        });
        S.annoncerGel(t, rev.id, gelesFaits);
        T.poster(t, "lanceur", `${dest.join(", ")} : révision n°${rev.id} acceptée par ${agent} ; tickets gelés : ${geles.map((k) => `#${k}`).join(", ") || "aucun"}. La spec se rouvre. ${sansQuestion(court(raison))}`, "principal");
        T.ajouterEvenement(t, { agent, type: "revision", resultat: `révision n°${rev.id} acceptée ; gelés ${geles.map((k) => `#${k}`).join(", ") || "aucun"}` });
        return texte(`révision n°${rev.id} acceptée ; la spec se rouvre : SPEC.md puis plan_proposer avec etape spec et exigences_changees, puis les exigences changées rangées de nouveau, puis PLAN.md avec tickets_repris ; la recette et le gardien les jugent`);
      },
    });

    // Les jalons : le découpage change pendant la préparation (« preparation »), ou pendant une
    // révision acceptée (l'heure de l'acceptation : seules les exigences rangées depuis se découpent) ; sinon undefined.
    const momentDecoupage = (): "preparation" | string | undefined => {
      if (T.preparation(t) === "en_cours") return "preparation";
      const rev = S.revisionEnCours(t);
      return rev?.etat === "acceptee" ? rev.repondu_le ?? undefined : undefined;
    };
    pi.registerTool({
      name: "exigence_ranger", label: "Ranger des phrases",
      description: "Ranger des phrases numérotées de la mission en une exigence, une exigence transversale ou du contexte. Une exigence reçoit le libellé suivant (E1, E2…) et un responsable de contrôle : la recette ou le gardien-mesureur, qui seul en signe la preuve. Une phrase déjà rangée est déplacée ; une exigence qui n'a plus aucune phrase est retirée. Rend : le libellé, les phrases et le responsable, ou les phrases rangées en contexte, puis les exigences retirées. Refus : aucune phrase ou numéro inconnu, levé avec un numéro de la liste ; classement inconnu, levé avec exigence, transversale ou contexte ; phrase d'engagement (section Engagements), définitif pour cette phrase ; phrases d'une exigence découpée en jalons rangées en partie, ou hors de la préparation et d'une révision acceptée, levé avec toutes ses phrases à ce moment-là ; exigence sans responsable, ou responsable inconnu, levé avec recette ou gardien ; contexte avec un responsable, levé sans responsable ; responsable dont l'équipe n'a pas le siège, levé avec un responsable que l'équipe compte.",
      promptSnippet: "exigence_ranger(phrases, classement, responsable?) : ranger des phrases numérotées de la mission en exigence, exigence transversale ou contexte",
      parameters: Type.Object({ phrases: Type.Array(Type.Number(), { description: "les numéros des phrases de la mission, tels que la liste numérotée les donne" }),
        classement: Type.String({ description: "exigence, transversale ou contexte" }),
        responsable: Type.Optional(Type.String({ description: "pour une exigence : recette ou gardien, le siège qui en signe la preuve" })) }),
      async execute(_id, p) {
        const chef = siege("chef");
        if (!chef) return refuse(sansChef);
        if (role !== "chef") return refuse(`les exigences se rangent par le chef (${chef.nom}). Définitif pour ce rôle`);
        if (p.classement !== "contexte" && (T.RESPONSABLES as readonly string[]).includes(p.responsable ?? "") && !siege(p.responsable!))
          return refuse(`aucun ${NOMS_ROLES[p.responsable as Role]} dans l'équipe. Se lève avec un responsable que l'équipe compte`);
        // Les jalons : les phrases d'une exigence découpée se rangent de nouveau en entier, et seulement
        // pendant la préparation ou une révision acceptée ; un déplacement partiel laisserait ses jalons sur un autre périmètre.
        const touchee = T.listerExigences(t).find((e) => !e.retiree && !e.parent && T.estDecoupee(t, e.libelle) && e.phrases.some((n) => p.phrases.includes(n)));
        if (touchee && (!momentDecoupage() || !touchee.phrases.every((n) => p.phrases.includes(n))))
          return refuse(`${touchee.libelle} est découpée en jalons : ses phrases se rangent de nouveau en entier, pendant la préparation ou une révision acceptée. Se lève avec toutes ses phrases (${touchee.phrases.join(", ")}), à ce moment-là`);
        const r = T.rangerExigence(t, { phrases: p.phrases, classement: p.classement, responsable: p.responsable, par: agent });
        if (!r.ok) return refuse(r.raison);
        const ns = [...new Set(p.phrases)].sort((a, b) => a - b).join(", ");
        const tete = r.libelle ? `${r.libelle} (${p.classement}) : phrases ${ns} · contrôle : ${NOMS_ROLES[p.responsable as Role]} (${siege(p.responsable!)!.nom})` : `phrases ${ns} : contexte`;
        return texte(`${tete}${r.retirees.length ? ` · retirée${r.retirees.length > 1 ? "s" : ""} faute de phrase : ${r.retirees.join(", ")}` : ""}`);
      },
    });

    // ---- Les jalons : le chef découpe une exigence longue en jalons, pendant la
    // préparation, ou pendant une révision acceptée sur une exigence rangée depuis l'acceptation (nouveau libellé, sans
    // preuve) ; changer le découpage d'une exigence ancienne passe par exigences_changees, comme tout changement.
    pi.registerTool({
      name: "exigence_jalonner", label: "Découper une exigence en jalons",
      description: "Découper une exigence longue en jalons (E4.1, E4.2…), chacun avec sa portée : un morceau prouvable par sa propre commande (« pages 109 à 300 »). L'exigence est alors tenue quand tous ses jalons sont attestés, et ne se prouve plus d'elle-même ; chaque jalon se prouve et se rejoue comme une exigence, par le même responsable. La liste donnée est le découpage entier : un jalon de portée identique est gardé avec ses preuves, les autres sont retirés avec les leurs, et une portée nouvelle reçoit un indice neuf. La couverture se juge avec la spec ou le plan. Rend : les jalons gardés, créés et retirés. Refus : hors de la préparation et d'une révision acceptée, levé à la prochaine révision acceptée ; pendant une révision, une exigence rangée avant l'acceptation, levé en la déclarant changée puis en rangeant ses phrases de nouveau ; exigence inconnue ou retirée, levé avec un libellé que `exigence_lister` donne ; un jalon, définitif pour ce libellé ; moins de 2 ou plus de 12 portées, levé avec 2 à 12 portées ; portée vide ou de plus de 200 signes, levé avec des portées de 1 à 200 signes ; deux portées identiques, levé avec des portées distinctes.",
      promptSnippet: "exigence_jalonner(exigence, jalons) : découper une exigence longue en jalons, chacun avec sa portée",
      parameters: Type.Object({ exigence: Type.String({ description: "le libellé de l'exigence à découper, E4…" }),
        jalons: Type.Array(Type.String(), { description: "les portées des jalons, dans l'ordre : le découpage entier, de 2 à 12" }) }),
      async execute(_id, p) {
        const chef = siege("chef");
        if (!chef) return refuse(sansChef);
        if (role !== "chef") return refuse(`les exigences se découpent par le chef (${chef.nom}). Définitif pour ce rôle`);
        const moment = momentDecoupage();
        if (!moment) return refuse("hors de la préparation et d'une révision acceptée, le découpage ne change pas. Se lève à la prochaine révision acceptée");
        const e = T.exigenceActive(t, p.exigence);
        if (!e) return refuse(`aucune exigence ${p.exigence}. Se lève avec un libellé que exigence_lister donne`);
        if (T.parentDe(t, p.exigence)) return refuse(`${p.exigence} est un jalon : un jalon n'a pas de jalons. Définitif pour ce libellé`);
        if (moment !== "preparation" && (t.get<{ cree_le: string }>("SELECT cree_le FROM exigences WHERE libelle = ?", [p.exigence])?.cree_le ?? "") <= moment)
          return refuse(`${p.exigence} est rangée d'avant la révision : son découpage change avec elle. Se lève en la déclarant changée (exigences_changees) puis en rangeant ses phrases de nouveau`);
        const portees = (p.jalons ?? []).map((x) => x.trim());
        if (portees.length < 2 || portees.length > 12) return refuse(`${portees.length} portée${portees.length > 1 ? "s" : ""}, de 2 à 12 attendues. Se lève avec 2 à 12 portées`);
        if (portees.some((x) => !x || [...x].length > 200)) return refuse("une portée vide ou de plus de 200 signes. Se lève avec des portées de 1 à 200 signes");
        if (new Set(portees).size !== portees.length) return refuse("deux portées identiques. Se lève avec des portées distinctes");
        const r = T.jalonner(t, { parent: p.exigence, portees, par: agent });
        if (!r.ok) return refuse(r.raison);
        const liste = (l: T.Jalon[]) => l.map((j) => `${j.libelle} (${j.portee})`).join(", ");
        T.ajouterEvenement(t, { agent, type: "exigence", resultat: `${p.exigence} découpée : ${[...r.gardes, ...r.crees].sort((a, b) => a.indice - b.indice).map((j) => j.libelle).join(", ")}` });
        return texte(`${p.exigence} découpée en ${r.gardes.length + r.crees.length} jalons`
          + (r.gardes.length ? ` · gardés avec leurs preuves : ${liste(r.gardes)}` : "") + (r.crees.length ? ` · créés : ${liste(r.crees)}` : "")
          + (r.retires.length ? ` · retirés, preuves révoquées : ${liste(r.retires)}` : ""));
      },
    });

    pi.registerTool({
      name: "exigence_contester", label: "Contester un classement",
      description: "Contester le classement d'une exigence ou de phrases de la mission : une question au chef, postée dans le fil tickets en le nommant, qui cite la raison puis chaque phrase visée avec sa section et son rangement ; elle se ferme sur la réponse du chef. Rend : le numéro du ticket. Refus : ni exigence ni phrases, levé avec l'une ou l'autre ; exigence inconnue ou retirée, levé avec un libellé que `exigence_lister` donne ; numéro de phrase inconnu, levé avec un numéro de la liste ; raison vide, levé avec une raison non vide.",
      promptSnippet: "exigence_contester(raison, exigence?, phrases?) : contester le classement d'une exigence ou de phrases de la mission",
      parameters: Type.Object({ raison: Type.String({ description: "ce que le texte de la mission dit et que le classement ne dit pas" }),
        exigence: Type.Optional(Type.String({ description: "le libellé de l'exigence contestée, E1…" })),
        phrases: Type.Optional(Type.Array(Type.Number(), { description: "les numéros des phrases dont le rangement est contesté" })) }),
      async execute(_id, p) {
        const chef = siege("chef");
        if (!chef) return refuse(sansChef);
        if (role !== "gardien") return refuse("une contestation s'ouvre par le gardien-mesureur. Définitif pour ce rôle");
        const r = T.contesterExigence(t, { exigence: p.exigence, phrases: p.phrases, raison: p.raison ?? "", par: agent, chef: chef.nom });
        return r.ok ? texte(`ticket #${r.ticket} ouvert au chef (${chef.nom}) : ${r.titre}`) : refuse(r.raison);
      },
    });

    pi.registerTool({
      name: "exigence_lister", label: "Lister les exigences",
      description: "Lister les exigences de la mission rangées par le chef. Rend : chaque exigence avec son classement, son responsable de contrôle, ses phrases et les contestations ouvertes qui la visent, et pour une exigence découpée, le compte de ses jalons attestés puis chaque jalon avec sa portée et son état ; les exigences retirées ; les phrases rangées en contexte ; les engagements de la mission (section Engagements, rangés d'office, jamais des exigences) ; les phrases pas encore rangées ; les contestations ouvertes ; ou « aucune phrase numérotée dans ce run ».",
      promptSnippet: "exigence_lister() : lister les exigences de la mission et le rangement de ses phrases",
      parameters: Type.Object({}),
      async execute() {
        const toutes = T.phrases(t);
        if (!toutes.length) return texte("aucune phrase numérotée dans ce run");
        const texteDe = new Map(toutes.map((x) => [x.n, x.texte]));
        const nom = (r: string) => `${NOMS_ROLES[r as Role]}${siege(r) ? ` (${siege(r)!.nom})` : ""}`;
        const exigences = T.listerExigences(t);
        // Les jalons : une exigence découpée donne son compte, puis ses jalons en retrait, chacun avec sa
        // portée et son état ; un jalon n'a pas de phrases.
        const etats = new Map(P.etatDesFeuilles(t, runDir).map((f) => [f.libelle, f.etat]));
        const lignes = exigences.filter((e) => !e.retiree && !e.parent).flatMap((e) => {
          const jalons = T.jalonsDe(t, e.libelle);
          const decoupee = T.estDecoupe(jalons);
          const compte = decoupee ? ` · ${jalons.filter((j) => etats.get(j.libelle) === "attestee").length}/${jalons.length} jalons attestés` : "";
          return [
            `${e.libelle} · ${e.classement} · contrôle : ${nom(e.responsable)} · phrases ${e.phrases.join(", ")}${compte}${e.contestations.length ? ` · contestée : ${e.contestations.map((k) => `#${k}`).join(", ")}` : ""}`,
            ...e.phrases.map((n) => `  [${n}] ${court(texteDe.get(n)!)}`),
            ...(decoupee ? jalons.map((j) => `  ${j.libelle} · portée : ${j.portee} · ${P.LIBELLES_ETAT[etats.get(j.libelle) ?? "a_prouver"]}`) : [])];
        });
        const retirees = exigences.filter((e) => e.retiree && !e.parent).map((e) => e.libelle);
        if (retirees.length) lignes.push(`retirées : ${retirees.join(", ")}`);
        const contexte = toutes.filter((x) => x.classement === "contexte").map((x) => x.n);
        if (contexte.length) lignes.push(`contexte : phrases ${contexte.join(", ")}`);
        const engagements = toutes.filter((x) => x.classement === "engagement").map((x) => x.n);
        if (engagements.length) lignes.push(`engagements (section Engagements, suivis au bilan, jamais des exigences) : phrases ${engagements.join(", ")}`);
        const libres = toutes.filter((x) => x.classement === null);
        if (libres.length) lignes.push("pas encore rangées :", ...libres.map((x) => `  [${x.n}] ${court(x.texte)}`));
        const ouvertes = T.contestationsOuvertes(t);
        if (ouvertes.length) lignes.push(`contestations ouvertes : ${ouvertes.map((c) => `#${c.ticket} (${c.exigence ?? `phrases ${c.phrases.join(", ")}`})`).join(", ")}`);
        return texte(lignes.join("\n"));
      },
    });

    // ---- Les preuves : deux actes. Le reçu du lanceur (preuve_demander : le lanceur rejoue la commande
    // hors des agents et écrit le reçu dans preuves/) ; puis l'attestation du siège responsable de l'exigence, un seul
    // signataire. Une appréciation qualitative est signée à part et ne compte jamais comme une preuve.
    const controleur = "seules la recette et le gardien-mesureur signent des preuves. Définitif pour ce rôle";
    const nature = DROITS[role].attesteDes[0];
    const runDir = runDuPartage();
    pi.registerTool({
      name: "preuve_demander", label: "Demander une preuve",
      description: "Demander au lanceur le reçu d'une exigence : l'outil relève les empreintes du banc et du monde et le commit de main ; le lanceur rejoue la commande dans le dossier partagé, en lecture seule, hors des agents, et écrit un reçu dans le registre des preuves, que personne d'autre n'écrit. Rend : le reçu (chemin, passe ou non, code, commit du produit, graine), ou, si le lanceur tarde, le numéro de la demande restée en file. Refus : exigence inconnue ou retirée, levé avec un libellé que `exigence_lister` donne ; exigence découpée en jalons, levé avec le libellé d'un jalon ; commande vide, levé avec une commande non vide ; fichier du banc introuvable, levé avec un fichier ou un dossier qui existe ; demande de preuve de cette exigence déjà en attente, levé au reçu du lanceur.",
      promptSnippet: "preuve_demander(exigence, commande, graine?, banc?) : demander au lanceur le reçu d'une exigence",
      parameters: Type.Object({ exigence: Type.String({ description: "le libellé de l'exigence, E1…" }),
        commande: Type.String({ description: "la commande rejouée par le lanceur dans le dossier partagé ; son code de sortie 0 veut dire qu'elle passe" }),
        graine: Type.Optional(Type.String({ description: "la graine du tirage, si la commande en tire un ; la commande la reçoit dans la variable GRAINE" })),
        banc: Type.Optional(Type.Array(Type.String(), { description: "les fichiers ou dossiers du contrôle, relatifs à ton bureau ; leurs empreintes entrent dans le reçu" })) }),
      async execute(_id, p) {
        if (!nature) return refuse(controleur);
        if (!T.exigenceActive(t, p.exigence)) return refuse(`aucune exigence ${p.exigence}. Se lève avec un libellé que exigence_lister donne`);
        const decoupee = refusDecoupee(p.exigence);
        if (decoupee) return refuse(decoupee);
        if (!p.commande?.trim()) return refuse("une preuve sans commande. Se lève avec une commande non vide");
        const b = releverBanc(p.banc ?? []);
        if ("introuvable" in b) return refuse(`${b.introuvable} est introuvable. Se lève avec un fichier ou un dossier qui existe`);
        const monde = Object.fromEntries([...M.empreintes(join(runDir, "entrees"))].map(([rel, e]) => [rel, e.blob]));
        const reproduction: T.Reproduction = { commande: p.commande, graine: p.graine ?? null, commit: await commitDeMain("preuve_demander"), banc: b.banc, monde };
        const d = T.demanderPreuve(t, { exigence: p.exigence, demandeur: agent, commande: p.commande, graine: p.graine ?? null, reproduction });
        if (!d.ok) return refuse(d.raison);
        const pas = process.env.ESSAIM_TEST ? 20 : 500;
        for (let ecoule = 0; ecoule < DEMANDE_MS; ecoule += pas) {
          const r = T.reponseRejeu<{ texte?: string; panne?: string }>(t, d.id);
          if (r?.resultat.panne) throw new Error(`preuve_demander : le rejeu est en panne : ${r.resultat.panne}`);
          if (r) return texte(`reçu ${r.resultat.texte}`);
          await dormir(pas);
        }
        return texte(`le lanceur n'a pas rendu le reçu en ${Math.round(DEMANDE_MS / 1000)} s ; la demande #${d.id} reste en file, \`preuve_lister\` montrera son reçu`);
      },
    });

    // Les refus communs de l'attestation et de l'appréciation : rôle, exigence.
    // Les jalons : une exigence découpée se prouve jalon par jalon, jamais d'elle-même.
    const refusDecoupee = (exigence: string): string | undefined => {
      const j = T.jalonsDe(t, exigence);
      return T.estDecoupe(j) ? `${exigence} se prouve jalon par jalon (${j[0]!.libelle} à ${j.at(-1)!.libelle}). Se lève avec le libellé d'un jalon` : undefined;
    };
    const refusSignature = (exigence: string): string | undefined => {
      if (!nature) return controleur;
      if (!T.exigenceActive(t, exigence)) return `aucune exigence ${exigence}. Se lève avec un libellé que exigence_lister donne`;
      return refusDecoupee(exigence);
    };
    pi.registerTool({
      name: "preuve_attester", label: "Attester",
      description: "Attester qu'un reçu du lanceur prouve une exigence, avec sa portée (ce que le contrôle mesure, et ses limites) ; ou, avec `non_verifiee`, déclarer l'exigence non vérifiée, la portée disant pourquoi. Seul le siège responsable de l'exigence signe : la recette les parcours, le gardien-mesureur les mesures ; un seul signataire par exigence, et une signature ne compte plus quand le siège change d'occupant. Rend : l'attestation ou la déclaration enregistrée. Refus : exigence inconnue ou retirée, levé avec un libellé que `exigence_lister` donne ; exigence découpée en jalons, levé avec le libellé d'un jalon ; exigence tenue par l'autre siège de contrôle, définitif pour ce rôle ; exigence déjà signée par un autre, définitif pour cette exigence ; ni reçu ni `non_verifiee`, levé avec l'un des deux ; reçu et `non_verifiee` ensemble, levé avec l'un des deux ; reçu absent du registre, levé avec un reçu que `preuve_demander` a rendu ; reçu d'une autre exigence ou d'une alerte, levé avec un reçu de cette exigence ; reçu qui ne passe pas, levé avec un reçu qui passe ; reçu périmé (produit, banc ou monde changé depuis), levé avec un reçu rejoué depuis ; pour le gardien-mesureur, reçu dont ni la commande ni le banc n'utilisent un fichier de son bureau privé, levé avec un reçu qui en utilise un ; portée vide, levé avec une portée non vide.",
      promptSnippet: "preuve_attester(exigence, portee, recu?, non_verifiee?) : attester qu'un reçu du lanceur prouve une exigence, ou la déclarer non vérifiée",
      parameters: Type.Object({ exigence: Type.String({ description: "le libellé de l'exigence, E1…" }),
        portee: Type.String({ description: "ce que le contrôle mesure de l'exigence, et ses limites ; avec non_verifiee, pourquoi elle ne l'est pas" }),
        recu: Type.Optional(Type.String({ description: "le reçu rendu par preuve_demander : preuves/3.json, ou 3" })),
        non_verifiee: Type.Optional(Type.Boolean({ description: "vrai : déclarer l'exigence non vérifiée, sans reçu" })) }),
      async execute(_id, p) {
        const refusCommun = refusSignature(p.exigence);
        if (refusCommun) return refuse(refusCommun);
        const e = T.exigenceActive(t, p.exigence)!;
        if (e.responsable !== role) {
          const tenant = equipeRoles().find((a) => a.role === e.responsable);
          return refuse(`${p.exigence} se signe par ${e.responsable === "recette" ? "la recette" : "le gardien-mesureur"}${tenant ? ` (${tenant.nom})` : ""}. Définitif pour ce rôle`);
        }
        const deja = T.attestationDe(t, p.exigence);
        if (deja && deja.agent !== agent) return refuse(`${p.exigence} est signée par ${deja.agent}, un seul signataire par exigence. Définitif pour cette exigence`);
        if (!p.recu && !p.non_verifiee) return refuse("ni reçu ni non_verifiee. Se lève avec un reçu de preuve_demander, ou non_verifiee");
        if (p.recu && p.non_verifiee) return refuse("un reçu et non_verifiee ensemble. Se lève avec l'un des deux");
        let chemin: string | null = null;
        if (p.recu) {
          const recu = P.lireRecu(runDir, p.recu);
          if (!recu) return refuse(`aucun reçu ${p.recu} dans le registre des preuves. Se lève avec un reçu que preuve_demander a rendu`);
          chemin = P.cheminRecu(recu.n);
          if (recu.sorte !== "exigence" || recu.exigence !== p.exigence)
            return refuse(`le reçu ${chemin} porte sur ${recu.exigence ?? `l'alerte #${recu.ticket}`}. Se lève avec un reçu de ${p.exigence}`);
          if (!recu.passe) return refuse(`le reçu ${chemin} ne passe pas (${recu.coupe ?? `code ${recu.code}`}). Se lève avec un reçu qui passe`);
          const per = P.perime(recu, runDir);
          if (per.perime) return refuse(`le reçu ${chemin} est périmé : ${per.changes.join(", ")}. Se lève avec un reçu rejoué depuis (preuve_demander)`);
          // Une mesure faite avec un outil du produit ou un test de l'équipe ne prouve rien de plus que l'équipe.
          if (role === "gardien") {
            const prive = process.env.ESSAIM_PRIVE ?? join(runDir, "agents", agent, "prive");
            if (!P.reposeSurPrive(recu, prive, join(runDir, "partage")))
              return refuse(`le reçu ${chemin} ne repose sur aucun fichier de ton bureau privé (${prive}) : ni sa commande ni son banc n'en utilisent un. Se lève avec un reçu dont la commande ou le banc utilise un fichier de ton bureau privé`);
          }
        }
        if (!p.portee?.trim()) return refuse("une attestation sans portée. Se lève avec une portée non vide");
        T.attester(t, { exigence: p.exigence, agent, role, nature, recu: chemin, portee: p.portee });
        return texte(chemin ? `${p.exigence} attestée par ${agent} (${nature}) sur le reçu ${chemin} ; portée : ${p.portee}` : `${p.exigence} déclarée non vérifiée par ${agent} ; raison : ${p.portee}`);
      },
    });

    pi.registerTool({
      name: "preuve_apprecier", label: "Apprécier",
      description: "Signer une appréciation qualitative d'une exigence, ce qu'aucune commande ne mesure, avec sa portée ; elle est comptée à part et ne vaut jamais une preuve. Rend : le numéro de l'appréciation. Refus : exigence inconnue ou retirée, levé avec un libellé que `exigence_lister` donne ; exigence découpée en jalons, levé avec le libellé d'un jalon ; texte ou portée vide, levé avec les deux non vides.",
      promptSnippet: "preuve_apprecier(exigence, texte, portee) : signer une appréciation qualitative d'une exigence",
      parameters: Type.Object({ exigence: Type.String({ description: "le libellé de l'exigence, E1…" }), texte: Type.String({ description: "l'appréciation" }),
        portee: Type.String({ description: "sur quoi elle porte, et ses limites" }) }),
      async execute(_id, p) {
        const refusCommun = refusSignature(p.exigence);
        if (refusCommun) return refuse(refusCommun);
        if (!p.texte?.trim() || !p.portee?.trim()) return refuse("une appréciation sans texte ou sans portée. Se lève avec les deux non vides");
        const n = T.apprecier(t, { exigence: p.exigence, agent, role, texte: p.texte, portee: p.portee });
        return texte(`appréciation #${n} sur ${p.exigence}, signée ${agent} ; comptée à part, jamais comme une preuve`);
      },
    });

    pi.registerTool({
      name: "preuve_lister", label: "Lister les preuves",
      description: "Lister les preuves de la salle. Un reçu attesté dont seul le produit ou le monde a changé est confié au lanceur, qui le rejoue lui-même ; l'outil n'attend pas ce rejeu. Rend : pour chaque exigence, son responsable de contrôle et son état (attestée avec son reçu et sa portée ; à rejouer par le lanceur et ce qui a changé ; rejeu échoué, le reçu rejoué et ce qui a changé ; périmée quand le banc a changé ; non vérifiée et pourquoi ; ou à prouver) et ses appréciations ; puis chaque reçu du registre, ce qu'il prouve, s'il passe et ce qui a changé depuis ; les demandes en attente du lanceur ; ou « aucune exigence ni aucun reçu ».",
      promptSnippet: "preuve_lister() : lister les exigences, les reçus et les attestations",
      parameters: Type.Object({}),
      async execute() {
        const lignes: string[] = [];
        const tenant = (r: string) => { const a = equipeRoles().find((x) => x.role === r); return `${NOMS_ROLES[r as Role]}${a ? ` (${a.nom})` : ""}`; };
        const signe = (a: T.Attestation) => `attestée par ${a.agent} (${a.nature}) sur ${a.recu} · portée : ${a.portee}`;
        const apps = T.appreciations(t);
        P.demanderRejeux(t, runDir); // le lanceur rejoue les reçus attestés dont seul le produit ou le monde a changé
        const etatDe = (e: P.EtatExigence) => {
          const a = e.attestation;
          if (!a) return "à prouver";
          return e.etat === "attestee" ? signe(a) : e.etat === "perimee" ? `périmée (${(e.changes ?? []).join(", ")}) : ${signe(a)}`
            : e.etat === "a_rejouer" ? `à rejouer par le lanceur (${(e.changes ?? []).join(", ")}) : ${signe(a)}`
            : e.etat === "rejeu_echoue" ? `rejeu échoué (${e.rejeu?.texte ?? ""} ; changé : ${(e.changes ?? []).join(", ")}) : ${signe(a)}`
            : e.etat === "non_verifiee" ? `non vérifiée, déclaré par ${a.agent} : ${a.portee}` : "à prouver";
        };
        const appreciationsDe = (libelle: string, retrait: string) => apps.filter((x) => x.exigence === libelle).map((x) => `${retrait}appréciation de ${x.agent} : ${x.texte} (portée : ${x.portee})`);
        for (const e of P.etatDesExigences(t, runDir)) {
          // Les jalons : une exigence découpée donne son compte, puis chaque jalon en retrait avec sa portée.
          if (e.jalons) {
            const portee = new Map(T.jalonsDe(t, e.libelle).map((j) => [j.libelle, j.portee]));
            lignes.push(`${e.libelle} · contrôle : ${tenant(e.responsable)} · ${e.jalons.attestes}/${e.jalons.total} jalons attestés`,
              ...e.jalons.feuilles.flatMap((f) => [`  ${f.libelle} (${portee.get(f.libelle)}) · ${etatDe(f)}`, ...appreciationsDe(f.libelle, "    ")]));
            continue;
          }
          lignes.push(`${e.libelle} · contrôle : ${tenant(e.responsable)} · ${etatDe(e)}`, ...appreciationsDe(e.libelle, "  "));
        }
        const actuel = P.releverActuel(runDir);
        const faites = t.all<{ recu: string }>("SELECT recu FROM demandes_rejeu WHERE recu IS NOT NULL ORDER BY id");
        const recus = faites.flatMap(({ recu: c }) => {
          const r = P.lireRecu(runDir, c);
          if (!r) return [];
          const per = P.perime(r, runDir, actuel);
          const sujet = r.sorte === "exigence" ? r.exigence : `alerte #${r.ticket} (${r.motif})`;
          const bancChange = per.changes.some((x) => x.startsWith("banc "));
          return [`  ${c} · ${sujet} · ${r.texte.slice(c.length + 3)}${per.perime ? ` · ${bancChange ? "périmé" : "changé depuis"} : ${per.changes.join(", ")}` : ""}`];
        });
        if (recus.length) lignes.push("reçus :", ...recus);
        const attente = t.all<{ id: number; exigence: string | null; ticket_id: number | null }>("SELECT id, exigence, ticket_id FROM demandes_rejeu WHERE etat <> 'faite' ORDER BY id");
        if (attente.length) lignes.push(`en attente du lanceur : ${attente.map((d) => `demande #${d.id} (${d.exigence ?? `alerte #${d.ticket_id}`})`).join(", ")}`);
        return texte(lignes.length ? lignes.join("\n") : "aucune exigence ni aucun reçu");
      },
    });
  }

  const dollars = T.dollars;
  pi.registerTool({
    name: "salle_budget", label: "Budget",
    description: "Lire la dépense de toute la salle. Rend : le dépensé (agents et résumés de fils), le seuil et ce qui reste, en dollars, le rythme de dépense des 30 dernières minutes et le temps que tient le reste à ce rythme (estimation mise à jour par le lanceur).",
    promptSnippet: "salle_budget() : lire la dépense de toute la salle",
    parameters: Type.Object({}),
    async execute() {
      const b = T.budget(t);
      return texte(`dépensé ${dollars(b.depense, 4)} sur ${dollars(b.plafond, 2)}, reste ${dollars(b.reste, 4)} ; ${T.texteRythme(T.rythme(t))} (estimation)`);
    },
  });

  // Les leçons : proposées en partant, archivées dans le bilan, jamais relues par un autre run.
  const LECONS = Type.Optional(Type.Array(Type.String(), { description: "les leçons que tu proposes pour les runs suivants, une par élément" }));
  pi.registerTool({
    name: "moi_finir", label: "Fini",
    description: "Déclarer la mission terminée (fait atteint, ou impossible à atteindre) et quitter la salle ; personne ne peut plus te rappeler." + (role ? " Avec `lecons`, les leçons que tu proposes sont archivées dans le bilan du run, sans être relues par aucun autre run." : "") + " Rend : la confirmation du départ. Refus : si le livrable en page web de la mission ne s'ouvre pas sans erreur, levé quand il s'ouvre sans erreur ; si ce livrable est absent du dossier partagé, levé quand il existe et s'ouvre sans erreur ; " + (role ? `${RAPPEL_TICKETS_ROLES} ; une fois, si des tickets sont ouverts dans la salle (les questions sans réponse sont citées avec eux), levé par un second appel tant qu'aucun ticket ne t'est confié et qu'aucun message ne s'adresse à toi`
      : "une fois par état des tickets et par lancement, si un ticket ouvert t'est confié, levé par le même appel avec les tickets inchangés, ou quand ils sont fermés ou confiés à un autre ; une fois par état de la salle et par lancement, si des tickets sont ouverts (les questions sans réponse sont citées avec eux), levé par le même appel avec la situation inchangée") + " ; dans un run à rôles, chef, intégrateur, recette ou gardien-mesureur, levé quand le lanceur constate le run accepté ou incomplet ; dans un run à rôles, constructeur qui porte un ticket ouvert, levé quand ses tickets sont fermés ou confiés à un autre ; dans un run à rôles, constructeur qui n'a pas demandé à celui qui répartit le travail s'il en reste depuis son dernier ticket fermé, levé quand un de ses messages s'adresse à lui avec une question et que celui-ci a répondu, ou ${Math.round(reponseRepartiteurMs / 60_000)} minutes après la question.",
    promptSnippet: `moi_finir(raison, fichier?${role ? ", lecons?" : ""}) : déclarer la mission terminée et quitter la salle`,
    parameters: Type.Object({ raison: Type.String({ description: "pourquoi tu pars : fait atteint, ou impossible" }), fichier: Type.Optional(Type.String({ description: "le livrable que tu remets" })), ...(role ? { lecons: LECONS } : {}) }),
    async execute(_id, p) {
      // La salle regarde le livrable avant de laisser partir : un agent peut dire « fini » alors que
      // `voir` signale déjà le défaut. Ce n'est pas une méthode
      // imposée : c'est le même contrôle que le lanceur fait en fin de run, avancé au départ de chacun.
      // Rôles : partir dépend du rôle ; le constat du run est le fichier <run>/accepte du lanceur.
      // La recette et le gardien restent jusqu'au constat, comme le chef et l'intégrateur.
      const refusRole = role && refusDuRole(role, "moi_finir", undefined, { ...contexteRole(), runConstate: existsSync(join(dirname(chemin), "accepte")),
        ticketsOuverts: T.listerTickets(t, { charge: agent }).filter(T.estActif).map((k) => k.id), ...questionRepartiteur() });
      if (refusRole) return refuse(refusRole);
      const tickets = rappelTickets();
      if (tickets) return refuseUneFois(tickets);
      const salle = rappelSalle();
      if (salle) return refuseUneFois(salle);
      const partage = process.env.ESSAIM_PARTAGE;
      const livrable = process.env.ESSAIM_LIVRABLE;
      if (partage && livrable && livrable.toLowerCase().endsWith(".html")) {
        const { voir } = await import("./voir.ts");
        // Le contrôle du départ est une vérification comme une autre : code 1 → échoué, écrit avant le refus.
        const r = await verifier("moi_finir", partage, () => voir(partage, { page: livrable, parcours: true }), controlePage(livrable, partage, { parcours: true }));
        // Un livrable absent refuse aussi ; un code 2 sans invalide (navigateur absent) laisse partir.
        if (r.invalide) return refuse(`le livrable ${livrable} est absent du dossier partagé. Se lève quand il existe et s'ouvre sans erreur`);
        if (r.code === 1) return refuse(`le livrable ${livrable} ne s'ouvre pas sans erreur. Se lève quand il s'ouvre sans erreur\n${r.texte}`);
      }
      if (role) T.noterLecons(t, agent, role, (p as { lecons?: string[] }).lecons);
      T.fini(t, agent, p.raison, p.fichier);
      return { ...texte(`session terminée : ${p.raison}`), terminate: true };
    },
  });

  // ---- La passation d'un siège : le sortant laisse sa note et quitte la salle ; le lanceur relance le siège
  // avec un nouveau prénom, qui reçoit l'état du siège, puis la note citée comme déclarée. Seulement dans un run à rôles.
  if (role) {
    pi.registerTool({
      name: "moi_passation", label: "Passation",
      description: "Laisser ton siège à un nouvel occupant et quitter la salle : ta note est gardée et remise à celui qui te succède, citée comme déclarée par toi et non vérifiée, après l'état du siège constaté par la salle ; tes tickets ouverts et tes pancartes passent à lui, et tes signatures ne comptent plus. Avec `lecons`, les leçons que tu proposes sont archivées dans le bilan du run, sans être relues par aucun autre run. Rend : la confirmation du départ. Refus : note vide, levé avec une note non vide ; siège qui a déjà changé d'occupant autant de fois que le run le permet, définitif pour ce run.",
      promptSnippet: "moi_passation(note, lecons?) : laisser ton siège à un nouvel occupant, avec ta note, et quitter la salle",
      parameters: Type.Object({ note: Type.String({ description: "ce que tu laisses à celui qui te succède : tes intentions, tes décisions, tes doutes" }), lecons: LECONS }),
      async execute(_id, p) {
        const note = (p.note ?? "").trim();
        if (!note) return refuse("note vide. Se lève avec une note non vide");
        let changements = 0;
        for (let x = T.predecesseur(t, agent); x; x = T.predecesseur(t, x)) changements++;
        const max = changementsSiegeMax();
        if (changements >= max) return refuse(`ce siège a déjà changé ${changements} fois d'occupant, ${max} au plus. Définitif pour ce run`);
        T.noterPassation(t, agent, role, note);
        T.noterLecons(t, agent, role, p.lecons);
        return { ...texte("passation enregistrée : tu quittes la salle, le lanceur relance ton siège"), terminate: true };
      },
    });
  }

  // ---- Refus du rôle : write et edit (outils de pi), et page_assembler, passent par ce crochet ; les outils de la salle
  // (depot_restaurer, depot_adopter, fichier_reclamer, moi_finir) refusent dans leur execute, à la forme commune. Le
  // chemin se résout comme pi (relatif au bureau, ~/ compris), puis par cible() comme les commits ; le monde est
  // <run>/entrees/. Sans ESSAIM_ROLE, le crochet n'existe pas : aucun refus nouveau.
  if (role) {
    const runDir = dirname(resolve(process.env.ESSAIM_PARTAGE ?? join(dirname(chemin), "partage")));
    const bureau = process.env.ESSAIM_BUREAU ?? process.cwd();
    const cibleRole = (brut: string): Cible | undefined => {
      if (!brut) return undefined;
      const abs = resolve(bureau, brut.startsWith("~/") ? join(homedir(), brut.slice(2)) : brut);
      const entrees = join(runDir, "entrees");
      if (T.cleChemin(abs) === T.cleChemin(entrees) || T.cleChemin(abs).startsWith(T.cleChemin(entrees) + "/")) return { racine: "monde", rel: relative(runDir, abs) }; // sans la casse
      const c = cible(runDir, bureau, brut);
      if (!c) return { racine: "ailleurs", rel: abs };
      return { racine: c.racine === join(runDir, "partage") ? "partage" : "essai", rel: c.rel };
    };
    pi.on("tool_call", (ev) => {
      // page_assembler écrit sa sortie dans partage/ : le même refus qu'un write sur ce chemin.
      const chemin = ev.toolName === "page_assembler" ? join(runDir, "partage", String((ev.input as { sortie?: unknown }).sortie ?? "index.html"))
        : ev.toolName === "write" || ev.toolName === "edit" ? String((ev.input as { path?: unknown }).path ?? "") : undefined;
      if (chemin === undefined) return undefined;
      const r = refusDuRole(role, "write", cibleRole(chemin), contexteRole());
      return r ? { block: true, reason: `refusé : ${r}.` } : undefined;
    });
  }

  // ---- Vérifications par bash : un bun test lancé par bash est un contrôle comme code_tester, à
  // condition que la commande commence par un cd vers exactement le dossier commun ou la racine d'un essai ouvert
  // (bash tourne dans le bureau : sans ce cd, « tout le dossier » serait un fait faux). Empreinte d'avant à tool_call,
  // rangée par toolCallId (deux appels peuvent se croiser) ; bilan lu dans le contenu et empreinte d'après à
  // tool_result. Ces gestionnaires ne changent rien au résultat de bash.
  const testsBash = new Map<string, { racine: string; avant: Map<string, M.Empreinte>; commande: string; plusieurs: boolean }>();
  const racineDeTest = (dossier: string): string | undefined => {
    const bureau = process.env.ESSAIM_BUREAU ?? process.cwd();
    const abs = resolve(bureau, dossier.startsWith("~/") ? join(homedir(), dossier.slice(2)) : dossier);
    if (process.env.ESSAIM_PARTAGE && abs === resolve(process.env.ESSAIM_PARTAGE)) return abs;
    return T.essais(t).some((e) => resolve(e.dossier) === abs) ? abs : undefined;
  };
  // Un bash sans fin faisait virer l'agent (« outil bloqué : bash », le lanceur coupe à outilMaxMin, 10 min par
  // défaut) : pi coupe la commande à 80 % de cette durée et rend « timed out » à l'agent, qui continue.
  pi.on("tool_call", (ev) => {
    if (ev.toolName !== "bash") return undefined;
    const borne = Math.floor(Number(process.env.ESSAIM_OUTIL_MAX_MIN ?? 10) * 60 * 0.8);
    const input = ev.input as { timeout?: unknown };
    if (typeof input.timeout !== "number" || input.timeout > borne) input.timeout = borne;
    return undefined;
  });
  pi.on("tool_call", (ev) => {
    if (ev.toolName !== "bash") return undefined;
    const commande = String((ev.input as { command?: unknown }).command ?? "");
    const d = T.dossierDeTest(commande);
    const racine = d && racineDeTest(d.dossier);
    if (racine) testsBash.set(ev.toolCallId, { racine, avant: M.empreintes(racine, undefined, cacheEmpreintes), commande, plusieurs: d.plusieurs === true });
    return undefined;
  });
  pi.on("tool_result", async (ev) => {
    const e = testsBash.get(ev.toolCallId);
    if (!e) return undefined;
    testsBash.delete(ev.toolCallId);
    const { lireBilan } = await import("./outils-travail.ts");
    const bilan = lireBilan(ev.content.flatMap((c) => (c.type === "text" ? c.text.split("\n") : [])));
    // Le sujet : la partie bun test de la commande, redirections retirées (la commande entière est dans details).
    const sansRedirections = e.commande.replace(/\s*\d*>&\d+/g, "").replace(/\s*\d*>>?\s*\/dev\/null/g, "");
    const segment = /\bbun\s+test\b[^&|;]*/.exec(sansRedirections)![0].trim().replace(/\s+/g, " ");
    noterVerification("bash", e.racine, e.avant, {
      resultat: e.plusieurs ? "illisible" : M.resultatDuBilan(bilan), sujet: `tests (${segment.length > 60 ? segment.slice(0, 60) + "…" : segment})`,
      resultatTexte: M.chiffresBilan(e.plusieurs ? {} : bilan), details: { bilan, commande: e.commande.slice(0, 2000) },
    });
    return undefined;
  });

  // ---- État : au premier message d'une relance (ESSAIM_RELANCE posée par le lanceur, jamais
  // au premier lancement), pi passe le texte de relance par input, après la fin d'un /se-resumer : l'état est
  // construit là, à jour, et ajouté après une ligne vide. Il est noté préparé ; le lanceur le confirme au message
  // utilisateur que pi émet. Témoin (ESSAIM_MEMOIRE=non) : rien n'est livré, les faits restent notés.
  const memoireLivree = process.env.ESSAIM_MEMOIRE !== "non";
  const racinesSalle = () => M.racinesDe(t, process.env.ESSAIM_PARTAGE);
  let premierInput = true;
  let plancherLigne = 0; // l'aFait de l'état préparé dans ce lancement : la ligne courte ne le redit pas
  pi.on("input", (ev) => {
    const premier = premierInput;
    premierInput = false;
    const moment = process.env.ESSAIM_RELANCE;
    // Rôles : le premier message d'un nouvel occupant du siège reçoit l'état du siège, puis la note du
    // sortant (après une passation seulement), puis le rappel du but ; même dans un run témoin : c'est le siège qui
    // continue, pas le second cerveau.
    if (premier && moment === "succession") {
      const ajouts = [M.etatDuSiege(t, agent, racinesSalle(), { cache: cacheEmpreintes }), M.notePassation(t, agent), M.rappelDuBut(t, agent)].filter((x): x is string => !!x);
      return ajouts.length ? { action: "transform" as const, text: `${ev.text}\n\n${ajouts.join("\n\n")}` } : { action: "continue" as const };
    }
    if (!premier || !moment || !memoireLivree) return { action: "continue" as const };
    const l = M.etatDeLaSalle(t, agent, racinesSalle(), { cache: cacheEmpreintes });
    if (l) {
      T.preparerLivraison(t, agent, moment, l);
      plancherLigne = Math.max(plancherLigne, l.aFait);
    }
    // Le rappel du but suit l'état, ou vient seul quand rien n'a changé : relire la finalité ne dépend pas de la salle.
    const ajouts = [l?.texte, M.rappelDuBut(t, agent)].filter((x): x is string => !!x);
    if (!ajouts.length) return { action: "continue" as const };
    return { action: "transform" as const, text: `${ev.text}\n\n${ajouts.join("\n\n")}` };
  });

  // ---- Ligne courte : ajoutée au résultat d'un outil quand un fait d'un autre concerne l'agent.
  // Ses fichiers vus pendant ce lancement : les chemins de read, write et edit, normalisés comme les commits (D.cible,
  // relatifs au bureau, ~/ compris). Aucune ligne quand le tour s'arrête (moi_dormir, moi_finir, moi_resumer) ni sur
  // un refus de coupure : le fait attend l'outil suivant. Chaque ligne est notée confirmée (elle est dans le résultat).
  const fichiersVus = new Set<string>();
  const SANS_LIGNE = new Set(["moi_dormir", "moi_finir", "moi_resumer", "moi_passation"]);
  pi.on("tool_call", (ev) => {
    const partage = process.env.ESSAIM_PARTAGE;
    if (!partage || !["read", "write", "edit"].includes(ev.toolName)) return undefined;
    const c = cible(dirname(resolve(partage)), process.env.ESSAIM_BUREAU ?? process.cwd(), String((ev.input as { path?: unknown }).path ?? ""));
    if (c) fichiersVus.add(M.cleFichier(racineDuFait(c.racine, resolve(partage)), c.rel));
    return undefined;
  });
  // Témoin : la ligne ne porte que l'annulation d'une écriture par bash, un refus du rôle et pas le second
  // cerveau (comme l'état du siège, livré même dans un run témoin).
  pi.on("tool_result", (ev) => {
    if (SANS_LIGNE.has(ev.toolName)) return undefined;
    const premier = ev.content.find((c) => c.type === "text");
    if (ev.isError && premier?.type === "text" && premier.text.startsWith("refusé : ton contexte")) return undefined;
    const l = M.ligneCourte(t, agent, fichiersVus, plancherLigne, { temoin: !memoireLivree });
    if (!l) return undefined;
    plancherLigne = Math.max(plancherLigne, l.aFait);
    if (!l.texte) return undefined;
    T.preparerLivraison(t, agent, "ligne", { texte: l.texte, deFait: l.deFait, aFait: l.aFait, aMessage: l.aMessage, lignes: l.lignes, retires: l.retires, caracteres: l.texte.length, rienEcrit: [] });
    return { content: [...ev.content, { type: "text" as const, text: l.texte }] };
  });
}
