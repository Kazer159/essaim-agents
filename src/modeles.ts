// Résolution d'un alias de modèle (modeles.yaml) en id pour pi, réflexion et
// tarif. Le tarif vient du catalogue de pi (~/.pi/agent/models-store.json) ou
// d'un tarif manuel du YAML ; un tarif inconnu ou nul sans tarif manuel est
// refusé, pour que le seuil de dépense compte toujours quelque chose.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Tarif = { entree: number; sortie: number };
export type Catalogue = Record<string, { input: number; output: number; fenetre?: number }>; // fenetre : contextWindow, en tokens
export type Modele = { id: string; reflexion: string; tarif: Tarif; estime: boolean; fenetre?: number; abonnement?: boolean };
type EntreeYaml = { id: string; reflexion?: string; tarif?: Tarif; abonnement?: boolean };

const REFLEXION_DEFAUT = "medium"; // medium partout par défaut, un autre niveau se configure (modeles.yaml ou --reflexion)

// Parcourt récursivement tout objet portant `id` et `cost` ; id complet = provider/id.
export function lireCatalogue(brut?: unknown): Catalogue {
  const source = brut ?? JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "models-store.json"), "utf8"));
  const catalogue: Catalogue = {};
  const visiter = (o: unknown) => {
    if (Array.isArray(o)) return o.forEach(visiter);
    if (!o || typeof o !== "object") return;
    const m = o as { id?: string; provider?: string; contextWindow?: number; cost?: { input?: number; output?: number } };
    if (typeof m.id === "string" && m.cost && typeof m.cost === "object") {
      const id = m.provider ? `${m.provider}/${m.id}` : m.id;
      catalogue[id] = { input: Number(m.cost.input ?? 0), output: Number(m.cost.output ?? 0), ...(typeof m.contextWindow === "number" ? { fenetre: m.contextWindow } : {}) };
      return;
    }
    Object.values(o).forEach(visiter);
  };
  visiter(source);
  return catalogue;
}

export function lireAlias(): Record<string, EntreeYaml> {
  return Bun.YAML.parse(readFileSync(new URL("../modeles.yaml", import.meta.url), "utf8")) as Record<string, EntreeYaml>;
}

export function resoudreModele(aliasOuId: string, catalogue: Catalogue, yaml: Record<string, EntreeYaml> = lireAlias()): Modele {
  const entree = yaml[aliasOuId] ?? (aliasOuId.includes("/") ? { id: aliasOuId } : undefined);
  if (!entree) throw new Error("alias de modèle inconnu");
  const { id } = entree;
  const reflexion = entree.reflexion ?? REFLEXION_DEFAUT;
  const c = catalogue[id];
  if (entree.tarif) {
    // Deux nombres finis ≥ 0, rien d'autre : « 0,045 » se lirait 0 ou NaN, et le plafond ne jouerait plus.
    const t = entree.tarif as Record<string, unknown>;
    const nombre = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
    if (Object.keys(t).sort().join() !== "entree,sortie" || !nombre(t.entree) || !nombre(t.sortie))
      throw new Error(`tarif manuel illisible pour ${id} : deux nombres, entree et sortie, en $ par million de tokens, avec un point décimal (0.045)`);
  }
  if (entree.tarif) return { id, reflexion, tarif: { entree: Number(entree.tarif.entree), sortie: Number(entree.tarif.sortie) }, estime: true, fenetre: c?.fenetre, ...(entree.abonnement ? { abonnement: true } : {}) };
  if (!c || (c.input <= 0 && c.output <= 0)) throw new Error(`tarif inconnu pour ${id} : ajoute tarif: dans modeles.yaml`);
  return { id, reflexion, tarif: { entree: c.input, sortie: c.output }, estime: false, fenetre: c.fenetre };
}

// Le nom court d'un modèle, pour le bilan et la vue : le dernier segment de l'id (« gemini-3.8-flash »).
export function nomCourt(id: string): string {
  return id.slice(id.lastIndexOf("/") + 1);
}
