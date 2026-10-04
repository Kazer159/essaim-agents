// Les employés de la salle portent un prénom du calendrier français plutôt qu'un
// numéro : plus lisible dans les fils et la trace. Sans accent, pour rester dans
// l'alphabet accepté par les noms de session, de dossier et de variable
// d'environnement. L'ordre d'entrée est l'ordre d'insertion dans le tableau
// (rowid) : alphabétique avec un seul modèle, alterné hommes/femmes avec deux. Avec des rôles, alphabétique
// aussi, dans l'ordre des sièges : le modèle suit le rôle, plus le côté (repartir(n, false)).
export const PRENOMS = [
  "Antoine", "Bernard", "Claude", "Denis", "Edmond", "Fabien", "Gaston", "Hubert",
  "Jules", "Lucien", "Marcel", "Norbert", "Olivier", "Pascal", "Raymond", "Simon",
  "Thomas", "Urbain", "Valentin", "Xavier",
] as const;

// Les agentes, sur le second modèle : mêmes initiales que les hommes, sauf la dernière (Yvonne).
export const PRENOMS_FEMMES = [
  "Agathe", "Brigitte", "Cecile", "Denise", "Elise", "Florence", "Genevieve", "Helene",
  "Jeanne", "Louise", "Marthe", "Nicole", "Odile", "Pauline", "Rose", "Solange",
  "Therese", "Ursule", "Valerie", "Yvonne",
] as const;

// La relève : les prénoms des nouveaux occupants d'un siège, quand ceux de l'équipe sont tous pris
// (20 agents). Aucun n'est dans les deux listes ci-dessus.
export const PRENOMS_RELEVE = [
  "Achille", "Basile", "Cyprien", "Damien", "Emile", "Felix", "Gilbert", "Henri", "Isidore", "Joseph",
  "Leon", "Maurice", "Noel", "Octave", "Paul", "Rene", "Samuel", "Theodore", "Victor", "Yves",
] as const;

// Au-delà de la relève, la salle crée ses prénoms : deux syllabes, sans accent ni chiffre, pour rester dans le même
// alphabet et se lire comme un prénom (Bano, Belor…). 12 × 12 prénoms, plus que tout run ne relancera.
const DEBUTS = ["Ba", "Be", "Da", "Fe", "Ga", "Li", "Ma", "No", "Ra", "Sa", "Ti", "Vo"] as const;
const FINS = ["no", "lor", "ric", "mon", "nel", "rel", "ban", "dor", "lin", "mas", "zan", "tel"] as const;

// Le premier prénom libre pour un nouvel occupant : l'équipe, puis la relève, puis les prénoms créés.
export function prenomLibre(pris: ReadonlySet<string>): string {
  for (const p of [...PRENOMS, ...PRENOMS_RELEVE]) if (!pris.has(p)) return p;
  for (const d of DEBUTS) for (const f of FINS) if (!pris.has(d + f)) return d + f;
  throw new Error("plus aucun prénom libre"); // 184 prénoms : aucun run n'en relance autant
}

export type Cote = "hommes" | "femmes";

// Le prénom du i-ème agent (1 = le premier) : après le calendrier, la relève prend la suite, 40 au plus. Un nouvel occupant de siège
// prend ensuite le premier prénom libre (prenomLibre), relève comprise.
const EQUIPE_MAX = [...PRENOMS, ...PRENOMS_RELEVE];
export function nomAgent(i: number): string {
  const p = EQUIPE_MAX[i - 1];
  if (!p) throw new Error(`au plus ${EQUIPE_MAX.length} agents : un prénom chacun`);
  return p;
}

// L'équipe dans son ordre d'entrée. Deux modèles : parts égales, arrondi aux hommes (7 = 4 + 3), en alternance
// pour que les deux modèles démarrent ensemble. Avec deux modèles, 20 agents au plus ; avec un seul, 40 (nomAgent).
export function repartir(n: number, mixte: boolean): Array<{ nom: string; cote: Cote }> {
  if (mixte && n > PRENOMS.length) throw new Error(`au plus ${PRENOMS.length} agents avec deux modèles : un prénom chacun`);
  if (!mixte) return Array.from({ length: n }, (_, i) => ({ nom: nomAgent(i + 1), cote: "hommes" as const }));
  if (n < 2) throw new Error("avec deux modèles, 2 agents au moins");
  const equipe: Array<{ nom: string; cote: Cote }> = [];
  for (let i = 0; equipe.length < n; i++) {
    equipe.push({ nom: PRENOMS[i]!, cote: "hommes" });
    if (equipe.length < n) equipe.push({ nom: PRENOMS_FEMMES[i]!, cote: "femmes" });
  }
  return equipe;
}
