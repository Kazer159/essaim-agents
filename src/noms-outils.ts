// La source unique des noms d'outils : les outils de pi, les anciens et
// les nouveaux noms de la salle, et la correspondance de l'un à l'autre. Le faux pi, la sonde bilan-outils, le
// lanceur, la vue et les tests lisent ce fichier. Aucun import : il est lu sous Bun et sous Node.

export const OUTILS_PI = ["read", "bash", "edit", "write"] as const;

// Les 26 d'avant le renommage : les 25 de outils-essaim.ts et se_resumer (se-resumer.ts).
export const ANCIENS_OUTILS_SALLE = ["poster", "boite", "attendre", "equipe", "surnom", "budget", "entrer", "quitter",
  "dormir", "fini", "se_resumer", "reclamer_fichier", "liberer_fichier", "reclamations", "plan_du_code", "tester",
  "essai", "adopter", "restaurer", "ticket", "tickets", "voir", "mesurer", "comparer", "assembler", "lire_web"] as const;

// Les 30 nouveaux noms, et salle_chercher, moins les trois outils de fil : 28.
export const OUTILS_SALLE = [
  "salle_poster", "salle_budget", "salle_chercher", "salle_lire", "salle_attendre", "salle_equipe", "salle_surnom",
  "moi_dormir", "moi_finir", "moi_resumer",
  "fichier_reclamer", "fichier_liberer", "fichier_pancartes",
  "code_carte", "code_tester",
  "depot_essai", "depot_adopter", "depot_restaurer", "depot_journal",
  "ticket_ouvrir", "ticket_modifier", "ticket_lister", "ticket_lire",
  "page_voir", "page_mesurer", "page_comparer", "page_assembler",
  "web_lire",
] as const;

// Retirés des agents : fil_entrer et fil_quitter servaient peu, fil_historique
// doublait salle_chercher ; la vue range la conversation par sujet. Leurs noms restent pour lire les runs d'avant.
export const OUTILS_RETIRES = ["fil_entrer", "fil_quitter", "fil_historique"] as const;

// Rôles des agents : les outils des exigences et des preuves, enregistrés seulement dans un run à rôles
// (ESSAIM_ROLE) ; un run sans ## Type garde exactement les outils d'avant.
// moi_passation : laisser son siège à un nouvel occupant.
// revision_demander et revision_repondre : le surveillant demande une révision de la
// spec, le chef y répond.
export const OUTILS_ROLES = ["plan_proposer", "plan_juger", "exigence_ranger", "exigence_jalonner", "exigence_contester", "exigence_lister", "preuve_demander", "preuve_attester", "preuve_apprecier", "preuve_lister", "moi_passation", "revision_demander", "revision_repondre"] as const;

export const OUTIL_COMPACTAGE = "moi_resumer"; // chargé seulement avec ESSAIM_COMPACTAGE
export const OUTIL_MEMOIRE = "salle_chercher"; // absent d'un run témoin (--memoire non, ESSAIM_MEMOIRE=non)

// boite, ticket et tickets se séparent en deux ; entrer, quitter et boite(complet) mènent à des outils retirés depuis : la table donne le nom sans argument, nouveauNom départage.
export const ANCIEN_VERS_NOUVEAU: Record<string, string> = {
  poster: "salle_poster", boite: "salle_lire", attendre: "salle_attendre", equipe: "salle_equipe", surnom: "salle_surnom",
  budget: "salle_budget", entrer: "fil_entrer", quitter: "fil_quitter", dormir: "moi_dormir", fini: "moi_finir",
  se_resumer: "moi_resumer", reclamer_fichier: "fichier_reclamer", liberer_fichier: "fichier_liberer",
  reclamations: "fichier_pancartes", plan_du_code: "code_carte", tester: "code_tester", essai: "depot_essai",
  adopter: "depot_adopter", restaurer: "depot_restaurer", ticket: "ticket_ouvrir", tickets: "ticket_lister",
  voir: "page_voir", mesurer: "page_mesurer", comparer: "page_comparer", assembler: "page_assembler", lire_web: "web_lire",
};

// Le nouveau nom d'un appel, arguments compris : boite(complet) est fil_historique, ticket(id) ticket_modifier,
// tickets(id) ticket_lire. Un nom nouveau, de pi ou inconnu se rend tel quel.
export function nouveauNom(outil: string, args?: Record<string, unknown>): string {
  const aId = args?.id !== undefined && args?.id !== null;
  if (outil === "boite") return args?.complet === true ? "fil_historique" : "salle_lire";
  if (outil === "ticket") return aId ? "ticket_modifier" : "ticket_ouvrir";
  if (outil === "tickets") return aId ? "ticket_lire" : "ticket_lister";
  return Object.hasOwn(ANCIEN_VERS_NOUVEAU, outil) ? ANCIEN_VERS_NOUVEAU[outil]! : outil;
}

// Les outils que l'extension enregistre : OUTILS_SALLE, sans l'outil de résumé quand le compactage est coupé, sans
// salle_chercher quand la mémoire l'est ; avec rôles, OUTILS_ROLES en plus.
export function nomsSalle(compactage: boolean, memoire = true, roles = false): string[] {
  return [...OUTILS_SALLE.filter((n) => (compactage || n !== OUTIL_COMPACTAGE) && (memoire || n !== OUTIL_MEMOIRE)), ...(roles ? OUTILS_ROLES : [])];
}

// Les outils par rôle : un outil refusé définitivement à un rôle ne lui est pas donné, l'agent ne lit pas sa
// description pour rien (la recette n'a pas depot_adopter, le chef pas preuve_attester). avecChef : l'équipe a un siège de chef ; suppleantDe : le
// siège que ce constructeur peut reprendre (et avec lui la répartition).
const CONTROLE = ["plan_juger", "preuve_demander", "preuve_attester", "preuve_apprecier"];
// Le surveillant : une liste blanche, pas une liste noire.
// Un outil ajouté plus tard ne lui est pas donné sans qu'on le décide. Les outils de pi (read, bash) restent ; son bac
// à sable de contrôle ferme le dossier partagé à l'écriture.
export const OUTILS_SURVEILLANT = ["salle_lire", "salle_chercher", "salle_equipe", "salle_budget", "salle_poster", "moi_dormir",
  "ticket_lister", "ticket_lire", "fichier_pancartes", "depot_journal", "exigence_lister", "preuve_lister", "revision_demander"] as const;
export function outilsRetiresDuRole(role: string, o: { suppleantDe?: string } = {}): string[] {
  // revision_demander au surveillant seul ; revision_repondre à qui répartit (le chef, ou son suppléant qui tient le siège).
  const revision = ["revision_demander", ...(role === "chef" || o.suppleantDe === "chef" ? [] : ["revision_repondre"])];
  switch (role) {
    case "chef": return ["depot_essai", "depot_adopter", "depot_restaurer", "page_assembler", "exigence_contester", ...CONTROLE, ...revision];
    case "integrateur": return ["exigence_ranger", "exigence_jalonner", "exigence_contester", ...CONTROLE, ...revision];
    case "assembleur": return ["plan_proposer", "exigence_ranger", "exigence_jalonner", "exigence_contester", "depot_adopter", ...CONTROLE, ...revision];
    case "constructeur": return [...(o.suppleantDe ? [] : ["plan_proposer"]), "exigence_ranger", "exigence_jalonner", "exigence_contester", ...CONTROLE, ...revision];
    case "recette": return ["depot_essai", "depot_adopter", "depot_restaurer", "fichier_reclamer", "page_assembler", "plan_proposer", "exigence_ranger", "exigence_jalonner", "exigence_contester", ...revision];
    case "gardien": return ["depot_essai", "depot_adopter", "depot_restaurer", "fichier_reclamer", "page_assembler", "plan_proposer", "exigence_ranger", "exigence_jalonner", ...revision];
    case "surveillant": return [...OUTILS_SALLE, ...OUTILS_ROLES].filter((n) => !(OUTILS_SURVEILLANT as readonly string[]).includes(n));
    default: return [];
  }
}

