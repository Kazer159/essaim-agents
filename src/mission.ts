// Lecture d'une mission : un fichier Markdown qui doit contenir une section
// « ## C'est fini quand » non vide, la définition de « fait » que chaque agent
// lit et que le lanceur refuse d'omettre. Deux sections facultatives :
// « ## Livrable » (un chemin relatif à partage/, le fichier qui fait foi en fin
// de run) et « ## Vérification » (une commande sur une ligne, lancée par le
// lanceur dans partage/ quand tous les agents sont sortis). Rôles des agents : « ## Type », facultative,
// un mot parmi les types de run ; avec elle, le lanceur attribue les sièges, sans elle, rien ne change.
import { readFileSync } from "node:fs";
import { TYPES_RUN, type TypeRun } from "./roles.ts";
import { normaliserChemin } from "./tableau.ts";

const TITRE = /^##\s+C'est fini quand\s*$/m;
const ERREUR = "la mission doit contenir une section « ## C'est fini quand » non vide";

// La vérification est une suite de commandes : elles se lancent l'une après l'autre dans
// partage/, sans nettoyage entre deux, parce qu'une couture ne se voit qu'en enchaînant — la seconde
// commande travaille sur ce que la première a laissé.
export type Mission = { chemin: string; texte: string; finiQuand: string; livrable?: string; verification?: string; verifications?: string[]; type?: TypeRun };

// Le corps d'une section « ## titre », jusqu'au prochain « ## » ; undefined si la section n'existe pas
function section(texte: string, titre: RegExp): string | undefined {
  const debut = texte.search(titre);
  if (debut < 0) return undefined;
  const corps = texte.slice(debut).replace(titre, "");
  const suivant = corps.search(/^##\s/m);
  return (suivant < 0 ? corps : corps.slice(0, suivant)).trim();
}

export function lireMission(chemin: string): Mission {
  return analyserMission(chemin, readFileSync(chemin, "utf8"));
}

// La même lecture sur un texte déjà en main (run.mission_texte, pour les sondes qui relisent un run).
// Un titre presque bon (« ## Vérifications », « ## Verification », « ## vérification : ») ferait tourner le run sans
// sa vérification, sans que rien le dise. Le lancement s'arrête donc
// sur un titre qui ressemble, en entier, à l'une des sections lues ; un accent décomposé est d'abord recomposé (NFC).
const SECTIONS = ["C'est fini quand", "Livrable", "Vérification", "Type"];
const plier = (t: string) => t.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[’`]/g, "'").replace(/[\s:.!]+$/, "").replace(/s$/, "").trim();
function titresPresqueBons(texte: string): void {
  for (const m of texte.matchAll(/^##\s+(.*?)\s*$/gm)) {
    const titre = m[1]!;
    const voulu = SECTIONS.find((x) => plier(x) === plier(titre));
    if (voulu && titre !== voulu) throw new Error(`le titre « ## ${titre} » ressemble à « ## ${voulu} » : écris-le exactement ainsi, sinon la section serait ignorée`);
  }
}

export function analyserMission(chemin: string, brut: string): Mission {
  const texte = brut.normalize("NFC");
  titresPresqueBons(texte);
  const finiQuand = section(texte, TITRE);
  if (!finiQuand) throw new Error(ERREUR);
  const m: Mission = { chemin, texte, finiQuand };
  const livrable = section(texte, /^##\s+Livrable\s*$/m);
  if (livrable !== undefined) {
    const lignes = livrable.split("\n").map((l) => l.trim()).filter(Boolean);
    const propre = lignes.length === 1 ? normaliserChemin(lignes[0]!) : undefined;
    if (!propre) throw new Error("le livrable doit être un chemin relatif à partage/, sur une ligne");
    m.livrable = propre;
  }
  const verification = section(texte, /^##\s+Vérification\s*$/m);
  if (verification !== undefined) {
    const lignes = verification.split("\n").map((l) => l.trim()).filter(Boolean).filter((l) => !l.startsWith("```"));
    if (!lignes.length) throw new Error("la vérification demande au moins une commande, non vide");
    m.verifications = lignes;
    m.verification = lignes[0]!; // la première reste seule dans `verification` : rien ne casse en amont
  }
  const type = section(texte, /^##\s+Type\s*$/m);
  if (type !== undefined) {
    if (!(TYPES_RUN as string[]).includes(type)) throw new Error(`le type doit être l'un de : ${TYPES_RUN.join(", ")}`);
    m.type = type as TypeRun;
  }
  return m;
}

// Rôles des agents : le texte de la mission découpé mécaniquement, pour le chef qui range chaque phrase en
// exigence, exigence transversale ou contexte. Sans interprétation : un paragraphe, une puce ou une ligne de tableau est
// coupé en phrases à chaque fin de phrase (. ! ? …) suivie d'une majuscule, d'un guillemet ou d'un gras ; les lignes
// d'un même paragraphe ou d'une même puce sont jointes. Hors découpage : les titres (ils donnent la section), les lignes
// vides, les blocs de code et les lignes de séparation d'un tableau. « C'est fini quand » peut omettre des
// exigences écrites plus haut.
export type Phrase = { n: number; section: string; texte: string };
const FIN_DE_PHRASE = /(?<=[.!?…][*_»)"'`]*)\s+(?=[«*_`(]*\s?\p{Lu})/u;
export function phrasesNumerotees(texte: string): Phrase[] {
  const phrases: Phrase[] = [];
  let section = "", unite: string[] = [], code = false;
  const vider = () => {
    const joint = unite.join(" ").replace(/\s+/g, " ").trim();
    unite = [];
    for (const p of joint ? joint.split(FIN_DE_PHRASE) : []) if (p.trim()) phrases.push({ n: phrases.length + 1, section, texte: p.trim() });
  };
  for (const ligne of texte.split("\n")) {
    if (/^\s*(```|~~~)/.test(ligne)) { vider(); code = !code; continue; }
    if (code) continue;
    const titre = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(ligne);
    if (titre) { vider(); section = titre[1]!; continue; }
    if (!ligne.trim()) { vider(); continue; }
    if (/^\s*\|/.test(ligne)) { vider(); if (!/^\s*\|?[\s:|-]+\|?\s*$/.test(ligne)) { unite = [ligne]; vider(); } continue; }
    const puce = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(ligne);
    if (puce) { vider(); unite = [puce[1]!]; continue; }
    unite.push(ligne);
  }
  vider();
  return phrases;
}
