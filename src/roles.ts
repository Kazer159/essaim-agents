// Les rôles des agents : cinq rôles fixés par le lanceur avant le premier message, d'après le
// type de run déclaré par la mission (## Type) et le nombre d'agents. Un rôle se définit par sa mission, ses droits et
// ses refus, jamais par un modèle : le modèle d'un rôle est un réglage de lancement (--modele-role), à part.
// DROITS est la source unique des refus : les outils et le bac à sable la lisent.

import { cleChemin } from "./tableau.ts";

export type Role = "chef" | "integrateur" | "assembleur" | "constructeur" | "recette" | "gardien" | "surveillant";
export type TypeRun = "fichier" | "document" | "jeu" | "application" | "simulation" | "probleme";

// L'ordre d'entrée dans la salle : le chef le premier, puis l'intégrateur, l'assembleur, les constructeurs, la recette, le
// gardien, et le surveillant en dernier (en plus des agents demandés).
export const ROLES: Role[] = ["chef", "integrateur", "assembleur", "constructeur", "recette", "gardien", "surveillant"];
export const TYPES_RUN: TypeRun[] = ["fichier", "document", "jeu", "application", "simulation", "probleme"];

// Le rôle en toutes lettres, tel que les agents le lisent.
export const NOMS_ROLES: Record<Role, string> = {
  chef: "chef", integrateur: "intégrateur", assembleur: "assembleur", constructeur: "constructeur", recette: "recette", gardien: "gardien-mesureur", surveillant: "surveillant",
};

const C = "constructeur" as const;
// L'équipe minimale de chaque type ; document et probleme gagnent une recette à 6 agents (attribuer).
export const GABARITS: Record<TypeRun, Role[]> = {
  fichier: [C],
  jeu: ["integrateur", C, C, C, "recette"], // l'intégrateur répartit aussi
  application: ["chef", "integrateur", C, C, C, C, "recette", "gardien"],
  simulation: ["chef", "integrateur", C, C, C, C, "recette", "gardien"],
  document: ["chef", "integrateur", C, C, "gardien"],
  probleme: ["chef", "integrateur", C, C, "gardien"],
};

// rang : la place du siège parmi ceux du même rôle (1 = le premier). suppleantDe : le siège que ce constructeur reprend
// s'il tombe, nommé au lancement.
export type Siege = { role: Role; rang: number; suppleantDe?: "chef" | "integrateur" };

// Les sièges d'un run, dans l'ordre d'entrée. Plus d'agents que le gabarit : des constructeurs en plus (à document et
// probleme, la recette d'abord, dès 6) ; moins : refusé, avec le minimum du type. Le premier constructeur supplée
// l'intégrateur, le deuxième le chef : jamais le même.
// L'assembleur : avec un ## Livrable et un intégrateur, un siège de plus,
// pris sur les constructeurs dès qu'il en reste trois. L'intégrateur adopte les essais et tient le contrat ; l'assembleur
// tient le livrable et son assemblage. Un seul siège pour les deux laisse les essais attendre pendant chaque assemblage.
export function attribuer(type: TypeRun, n: number, o: { livrable?: boolean } = {}): Siege[] {
  const gabarit = GABARITS[type];
  if (n < gabarit.length) throw new Error(`au moins ${gabarit.length} agent${gabarit.length > 1 ? "s" : ""} pour le type ${type}`);
  const roles = [...gabarit];
  if ((type === "document" || type === "probleme") && n >= 6) roles.push("recette");
  if (o.livrable && roles.includes("integrateur") && n - roles.length >= 1 && roles.filter((r) => r === C).length + (n - roles.length - 1) >= 3) roles.push("assembleur");
  while (roles.length < n) roles.push(C);
  roles.sort((a, b) => ROLES.indexOf(a) - ROLES.indexOf(b));
  const vus = new Map<Role, number>();
  const sieges: Siege[] = roles.map((role) => {
    const rang = (vus.get(role) ?? 0) + 1;
    vus.set(role, rang);
    return { role, rang };
  });
  const constructeurs = sieges.filter((s) => s.role === C);
  if (roles.includes("integrateur")) constructeurs[0]!.suppleantDe = "integrateur";
  if (roles.includes("chef")) constructeurs[1]!.suppleantDe = "chef";
  return sieges;
}

// Le gel : les pancartes des chemins d'un ticket gelé par une révision passent à
// ce porteur fictif ; les refus et les annulations d'écriture des pancartes d'un autre s'y appliquent.
export const PORTEUR_GEL = "gel";

// Le siège du surveillant : ajouté après les sièges du gabarit, en plus
// des agents demandés, quand l'équipe a un chef. Il n'entre ni dans GABARITS ni dans attribuer.
export function avecSurveillant(sieges: Siege[]): Siege[] {
  return sieges.some((s) => s.role === "chef") ? [...sieges, { role: "surveillant", rang: 1 }] : sieges;
}

// Ce que chaque rôle a le droit de faire. ecritProduit : écrire dans partage/ (hors essai) ; fermeAlerte :
// clore une alerte par un motif permis ; attesteDes : les preuves qu'il signe ; resteJusquALaFin : moi_finir refusé
// jusqu'à l'acceptation ou l'arrêt incomplet ; confieTickets : confier et réattribuer les parts.
export type Droits = { ecritProduit: boolean; fermeAlerte: boolean; attesteDes: ("parcours" | "mesure")[]; resteJusquALaFin: boolean; confieTickets: boolean };
export const DROITS: Record<Role, Droits> = {
  chef: { ecritProduit: false, fermeAlerte: false, attesteDes: [], resteJusquALaFin: true, confieTickets: true },
  integrateur: { ecritProduit: true, fermeAlerte: true, attesteDes: [], resteJusquALaFin: true, confieTickets: false },
  assembleur: { ecritProduit: true, fermeAlerte: true, attesteDes: [], resteJusquALaFin: true, confieTickets: false },
  constructeur: { ecritProduit: true, fermeAlerte: true, attesteDes: [], resteJusquALaFin: false, confieTickets: false },
  // La recette et le gardien restent aussi jusqu'au constat : partis, ils ne pourraient pas refaire une preuve quand un
  // changement ultérieur fait échouer son rejeu ; en veille, le message du lanceur qui les nomme les réveille.
  recette: { ecritProduit: false, fermeAlerte: true, attesteDes: ["parcours"], resteJusquALaFin: true, confieTickets: false },
  gardien: { ecritProduit: false, fermeAlerte: true, attesteDes: ["mesure"], resteJusquALaFin: true, confieTickets: false },
  // Le surveillant : il regarde la marche du run de
  // l'extérieur et demande une révision de la spec ; il n'écrit rien, ne juge rien, ne confie rien.
  surveillant: { ecritProduit: false, fermeAlerte: false, attesteDes: [], resteJusquALaFin: true, confieTickets: false },
};

// Les veilles : cinq par agent, sauf pour qui doit rester jusqu'à la fin du run — le
// chef, l'intégrateur, la recette, le gardien-mesureur, et un constructeur qui porte un ticket ouvert. Sans limite, un
// siège ne tombe jamais dans l'impasse « ni dormir ni finir » ; les réveils restent bornés par le plafond et par la salle
// endormie.
// role absent : run sans rôles, cinq veilles pour tous.
export const SOMMEILS_MAX = 5;
// Sans limite pour tous les sièges d'un run à rôles ; la règle du réveil adressé
// coupe les boucles de politesse à la source. ticketsOuverts n'y compte plus.
export const veillesSansLimite = (role: Role | undefined, _ticketsOuverts: number): boolean => !!role;

// Le changement d'occupant d'un siège : après une panne, ou une passation (moi_passation), le lanceur relance le
// siège avec un nouveau prénom du calendrier. Deux changements au plus par siège (ESSAIM_CHANGEMENTS_SIEGE_MAX pour les
// tests) : un siège qui retombe sans cesse ne fait pas payer une relecture de la mission à l'infini.
export const CHANGEMENTS_SIEGE_MAX = 2;
export const changementsSiegeMax = () => Number(process.env.ESSAIM_CHANGEMENTS_SIEGE_MAX ?? CHANGEMENTS_SIEGE_MAX);

// {EQUIPE} dans les consignes des rôles : « Antoine est chef, Bernard intégrateur, Claude constructeur (suppléant de
// l'intégrateur)… ».
export function presenterEquipe(sieges: Array<Siege & { nom: string }>): string {
  const suppleant = { chef: " (suppléant du chef)", integrateur: " (suppléant de l'intégrateur)" };
  return sieges.map((s, i) => `${s.nom}${i === 0 ? " est" : ""} ${NOMS_ROLES[s.role]}${s.suppleantDe ? suppleant[s.suppleantDe] : ""}`).join(", ") + ".";
}

// ---- Les refus du rôle ----------------------------------------------------------------------------------------------
// Un membre de la salle tel que le tableau le garde (agents.nom, agents.role ; role nul sans rôles).
export type Membre = { nom: string; role: string | null; present?: boolean; suppleantDe?: string | null }; // present absent : présent
const LE: Record<Role, string> = { chef: "le chef", integrateur: "l'intégrateur", assembleur: "l'assembleur", constructeur: "le constructeur", recette: "la recette", gardien: "le gardien-mesureur", surveillant: "le surveillant" };

// Qui répartit les parts : le chef ; dans un gabarit sans chef (jeu), l'intégrateur ; personne au type fichier.
// Le dernier occupant présent du siège : sinon un chef tombé et remplacé resterait « celui qui répartit », ses tickets
// iraient à un absent et les refus le nommeraient.
// Sans occupant présent, le suppléant présent nommé pour ce siège le tient, avec le rôle
// du siège (« tu en reprends les droits si ce siège tombe ») ; sans lui, un chef tombé sans
// relance laisserait la salle sans personne pour confier ni annuler jusqu'à la fin du run.
export function repartiteur(equipe: Membre[]): (Membre & { role: Role }) | undefined {
  const siege = (role: string) => {
    const l = equipe.filter((a) => a.role === role);
    const present = l.findLast((a) => a.present !== false);
    if (present) return present;
    const suppleant = equipe.find((a) => a.suppleantDe === role && a.present !== false);
    return suppleant ? { ...suppleant, role } : l[0];
  };
  return (siege("chef") ?? siege("integrateur")) as (Membre & { role: Role }) | undefined;
}

// Qui tient le livrable (## Livrable) : l'assembleur présent ; sans lui, l'intégrateur présent.
export function porteurDuLivrable(equipe: Membre[]): (Membre & { role: Role }) | undefined {
  const present = (role: Role) => equipe.findLast((a) => a.role === role && a.present !== false);
  return (present("assembleur") ?? present("integrateur")) as (Membre & { role: Role }) | undefined;
}

// Confier des chemins avec un ticket, ou réattribuer un ticket qui en porte : réservé à qui répartit les parts
// (DROITS.confieTickets, ou l'intégrateur quand il n'y a pas de chef). role absent : run sans rôles.
// agent : celui qui demande ; le suppléant qui tient le siège confie comme le titulaire.
export function refusConfier(role: Role | undefined, equipe: Membre[], agent?: string): string | undefined {
  const r = repartiteur(equipe);
  if (!role || !r) return "aucun rôle ne répartit les parts dans ce run. Définitif pour ce run";
  if (agent !== undefined && agent === r.nom) return undefined;
  if (DROITS[role].confieTickets && equipe.some((a) => a.role === role && a.present !== false && (agent === undefined || a.nom === agent))) return undefined;
  if (role === r.role && (agent === undefined || agent === r.nom)) return undefined;
  return `les parts se confient par ${LE[r.role]} (${r.nom}). Définitif pour ce rôle`;
}

// Où tombe une écriture, déjà normalisée par l'extension (cible() de depot.ts) : le dossier partagé, un essai, le monde
// (les entrées fixées par la mission, <run>/entrees/) ou ailleurs (le bureau de l'agent…). rel : relatif à sa racine.
export type Cible = { racine: "partage" | "essai" | "monde" | "ailleurs"; rel: string };
// Ce que le refus lit de la salle : l'agent, l'équipe avec ses rôles, les pancartes ouvertes, le ## Livrable (relatif au
// dossier partagé). Pour moi_finir : les tickets ouverts confiés à l'agent, et si le lanceur a constaté le run accepté ou
// incomplet.
// essai : pour depot_adopter, les fichiers du dossier partagé que l'adoption changerait (fichiersDeLEssai de depot.ts).
export type ContexteRefus = { agent: string; equipe: Membre[]; pancartes: Array<{ chemin: string; agent: string }>; livrable?: string;
  ticketsOuverts?: number[]; runConstate?: boolean; essai?: string[];
  // Partir sans demander : sa dernière question au répartiteur sur le travail qui reste (null : aucune
  // depuis son dernier ticket fermé ; absent : règle hors jeu), l'heure et le délai de réponse.
  questionRepartiteur?: { le: string; repondu: boolean } | null; maintenantMs?: number; reponseRepartiteurMs?: number };
export type OutilRefusable = "write" | "edit" | "depot_restaurer" | "depot_adopter" | "depot_essai" | "fichier_reclamer" | "moi_finir";

// Le refus du rôle pour un outil, ou undefined : "<fait>. <levée>", à la forme des refus des outils. Pure :
// la salle arrive par le contexte. Le bureau n'est jamais refusé, un essai seulement à qui n'écrit pas le produit ; le monde l'est à tous ; le dossier
// partagé suit DROITS.ecritProduit, les pancartes des autres (bloquantes quand les rôles sont actifs) et, pour un
// constructeur d'une salle où quelqu'un répartit, ses parts et le livrable. Au type fichier (personne ne répartit), le
// constructeur seul écrit où il veut.
export function refusDuRole(role: Role, outil: OutilRefusable, cible: Cible | undefined, c: ContexteRefus): string | undefined {
  const rep = repartiteur(c.equipe);
  const essai = "dans un essai (depot_essai) proposé à l'intégrateur";
  // Partir : le chef et l'intégrateur restent jusqu'au constat du lanceur ; un constructeur part sans ticket ouvert
  // (plus de rappel « une fois par état » : définitif jusqu'au transfert) ; la recette et le gardien restent aussi.
  if (outil === "moi_finir") {
    if (DROITS[role].resteJusquALaFin && !c.runConstate) return `${LE[role]} reste jusqu'à la fin du run. Se lève quand le lanceur constate le run accepté ou incomplet`;
    const tickets = c.ticketsOuverts ?? [];
    if (role === "constructeur" && tickets.length)
      return `${tickets.length === 1 ? "un ticket ouvert t'est confié" : `${tickets.length} tickets ouverts te sont confiés`} (${tickets.map((n) => `#${n}`).join(", ")}). Se lève quand ils sont fermés ou confiés à un autre`;
    // Partir sans demander : un constructeur demande à qui répartit s'il reste du travail, puis attend sa
    // réponse, au plus reponseRepartiteurMs (un répartiteur muet ne retient personne indéfiniment).
    // Le répartiteur parmi les présents seulement (un chef parti sans relève n'est plus celui qu'on interroge), comme le
    // lanceur qui envoie les rondes.
    const present = repartiteur(c.equipe.filter((a) => a.present !== false));
    if (role === "constructeur" && present && present.nom !== c.agent && c.questionRepartiteur !== undefined) {
      const q = c.questionRepartiteur, delai = c.reponseRepartiteurMs ?? 10 * 60_000, min = `${Math.round(delai / 60_000)} minutes`, r = present.nom;
      if (!q) return `tu n'as pas demandé à ${r}, qui répartit le travail, s'il en reste pour toi depuis ton dernier ticket fermé. Se lève quand un de tes messages commence par « ${r} : » avec une question, et que ${r} t'a répondu ou que ${min} sont passées`;
      if (!q.repondu && (c.maintenantMs ?? Date.now()) - Date.parse(q.le) < delai) return `${r} n'a pas encore répondu à ta question sur le travail qui reste ; moi_dormir avec attend te met en veille jusqu'à sa réponse. Se lève quand ${r} t'a répondu, ou ${min} après ta question`;
    }
    return undefined;
  }
  // Adopter : l'intégrateur ; sans intégrateur, un constructeur. Sinon un correctif trouvé par l'intégrateur sur la part
  // d'un constructeur se recopie à la main, au risque de régresser. Un constructeur adopte donc aussi un essai dont
  // chaque fichier changé porte sa pancarte : le porteur prend le changement tel quel, sans rien recopier.
  if (outil === "depot_adopter") {
    const geles = (c.essai ?? []).filter((f) => c.pancartes.some((p) => p.agent === PORTEUR_GEL && cleChemin(p.chemin) === cleChemin(f)));
    if (geles.length) return `${geles.join(", ")} appartien${geles.length > 1 ? "nent" : "t"} à un ticket gelé par la révision. Se lève au plan révisé`;
    if (role === "integrateur" || (role === "constructeur" && !c.equipe.some((a) => a.role === "integrateur"))) return undefined;
    if (role !== "constructeur") return "l'adoption d'un essai revient à l'intégrateur. Définitif pour ce rôle";
    const essai = c.essai ?? [];
    const autres = essai.filter((f) => !c.pancartes.some((p) => p.chemin === f && p.agent === c.agent));
    if (essai.length && !autres.length) return undefined;
    return `l'adoption d'un essai revient à l'intégrateur, ou au porteur de la pancarte de chaque fichier qu'il change${autres.length ? ` (sans la tienne : ${autres.join(", ")})` : ""}. Se lève quand chaque fichier que l'essai change porte ta pancarte`;
  }
  // Quand un chef répartit, l'intégrateur adopte et tient le contrat : il n'ouvre pas d'essai à lui.
  if (outil === "depot_essai") {
    if (role === "integrateur" && rep?.role === "chef" && rep.nom !== c.agent)
      return `l'intégrateur adopte les essais des constructeurs, il n'en ouvre pas : le travail à construire va à un constructeur, confié par ${rep.nom}. Définitif pour ce rôle quand un chef répartit`;
    return undefined;
  }
  if (outil === "fichier_reclamer") {
    if (role === rep?.role || c.agent === rep?.nom || role === "integrateur" || role === "assembleur" || (role === "constructeur" && !rep)) return undefined;
    if (role === "constructeur") return `tes parts te sont confiées par ${LE[rep!.role]} (${rep!.nom}). Se lève quand ${LE[rep!.role]} te confie ce chemin`;
    return `${LE[role]} n'écrit pas le produit. Définitif pour ce rôle`;
  }
  if (!cible) return undefined;
  if (cible.racine === "monde") return `${cible.rel} est une entrée fixée par la mission. Définitif pour ce chemin`;
  // Un siège qui n'écrit pas le produit n'écrit pas non plus dans un essai, que
  // l'intégrateur adopterait ensuite dans le produit ; ce que la recette et le gardien vérifient ne dépend pas d'eux.
  if (cible.racine === "essai" && !DROITS[role].ecritProduit) return `${LE[role]} n'écrit pas le produit, même dans un essai (${cible.rel}). Définitif pour ce rôle`;
  if (cible.racine !== "partage") return undefined;
  const rel = cible.rel;
  // La spec puis le plan : qui répartit écrit SPEC.md et PLAN.md, à la racine du dossier partagé, même le chef.
  if (rep?.nom === c.agent && ["spec.md", "plan.md"].includes(cleChemin(rel))) return undefined;
  if (!DROITS[role].ecritProduit) return `${LE[role]} n'écrit pas le produit (${rel}). Définitif pour ce rôle`;
  const cle = cleChemin(rel), memeFichier = (x: string | undefined) => x !== undefined && cleChemin(x) === cle; // casse et Unicode
  const porteur = porteurDuLivrable(c.equipe);
  if (rep && memeFichier(c.livrable) && (role === "constructeur" || (role === "integrateur" && porteur?.role === "assembleur" && porteur.nom !== c.agent)))
    return `${rel} est le livrable, tenu par ${porteur?.role === "assembleur" ? "l'assembleur" : "l'intégrateur"}. Se lève ${essai}`;
  const autre = c.pancartes.find((p) => memeFichier(p.chemin) && p.agent !== c.agent);
  if (autre?.agent === PORTEUR_GEL) return `${rel} appartient à un ticket gelé par la révision. Se lève au plan révisé`;
  // Avec un chef, l'intégrateur n'écrit dans le dossier partagé que ce qui porte sa pancarte (le contrat, l'assemblage)
  // et le livrable qu'il tient ; le reste se construit chez un constructeur.
  if (role === "integrateur" && rep?.role === "chef" && rep.nom !== c.agent && !autre && !(memeFichier(c.livrable) && porteur?.nom === c.agent)
    && !c.pancartes.some((p) => memeFichier(p.chemin) && p.agent === c.agent))
    return `${rel} n'est ni le contrat ni l'assemblage : l'intégrateur adopte, il ne construit pas ; ce travail va à un constructeur, confié par ${rep.nom}. Se lève avec ta pancarte sur ce fichier (fichier_reclamer), s'il est du contrat ou de l'assemblage`;
  // Le refus cite le porteur quand il peut adopter l'essai lui-même (constructeur, intégrateur).
  const adopte = ["constructeur", "integrateur"].includes(c.equipe.find((a) => a.nom === autre?.agent)?.role ?? "");
  if (autre) return rep ? `${rel} est la part de ${autre.agent}. Se lève quand ${LE[rep.role]} te confie ce chemin, ou ${adopte ? `dans un essai (depot_essai) que ${autre.agent} adopte` : essai}`
    : `${rel} porte la pancarte de ${autre.agent}. Se lève quand ${autre.agent} la retire`;
  if (role === "constructeur" && rep && !c.pancartes.some((p) => memeFichier(p.chemin) && p.agent === c.agent))
    return `${rel} n'est pas ta part. Se lève quand ${LE[rep.role]} te confie ce chemin, ou ${essai}`;
  return undefined;
}

// ---- Les alertes et les motifs de clôture ------------------------------------------------------------------------
// Ouvrir une alerte : la recette et le gardien-mesureur, qui signent les contrôles (DROITS.attesteDes). role absent : run
// sans rôles, où aucune alerte n'existe.
export function refusAlerte(role: Role | undefined): string | undefined {
  if (!role) return "aucune alerte dans un run sans rôles. Définitif pour ce run";
  return DROITS[role].attesteDes.length ? undefined : "une alerte s'ouvre par la recette ou le gardien-mesureur. Définitif pour ce rôle";
}

// Clore par un motif : annule revient à qui répartit les parts (le chef ; l'intégrateur sans chef) ; corrige et invalide
// suivent DROITS.fermeAlerte (le chef organise le travail, il ne le juge pas). Les conditions du motif lui-même (commit,
// successeur, reçu) sont dans le tableau (refusCloture). role absent : run sans rôles, aucun motif.
export function refusMotif(role: Role | undefined, motif: string, equipe: Membre[], agent?: string): string | undefined {
  if (!role) return "les motifs de clôture valent dans un run à rôles. Définitif pour ce run";
  if (motif === "annule") {
    const r = repartiteur(equipe);
    if (!r) return "aucun rôle ne répartit les parts dans ce run. Définitif pour ce run";
    if (role !== r.role && !(agent !== undefined && agent === r.nom)) return `les tickets s'annulent par ${LE[r.role]} (${r.nom}). Définitif pour ce rôle`;
  }
  if ((motif === "corrige" || motif === "invalide") && !DROITS[role].fermeAlerte) return `${LE[role]} ne ferme pas une alerte. Définitif pour ce rôle`;
  return undefined;
}

// Qui reprend les tickets d'un agent sorti, viré ou perdu : celui qui répartit les parts (le chef ;
// l'intégrateur sans chef) ; si c'est lui qui sort, le constructeur nommé son suppléant au lancement. Personne quand le
// repreneur n'est plus dans la salle, ni sans répartiteur (type fichier, run sans rôles). present : actif ou dormant.
export type Occupant = Membre & { suppleantDe?: string | null; present: boolean };
export function heritier(equipe: Occupant[], sortant: string): string | undefined {
  const rep = repartiteur(equipe);
  if (!rep) return undefined;
  const vers = rep.nom === sortant ? equipe.find((a) => a.suppleantDe === rep.role) : equipe.find((a) => a.nom === rep.nom);
  return vers?.present && vers.nom !== sortant ? vers.nom : undefined;
}
