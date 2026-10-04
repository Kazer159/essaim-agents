// Réparer la mémoire d'un agent qu'un appel d'outil mal formé a empoisonnée.
//
// Un modèle peut écrire un appel d'outil sans nom ni numéro
// (`id: ""`). pi le range tel quel, avec son résultat « Tool not found » lui aussi sans numéro, et
// renvoie toute la session au fournisseur à chaque requête : OpenRouter refuse alors pour toujours
// (« tool messages must include a non-empty string tool_call_id »). Relancer ne sert à rien. On donne à l'appel vide et à son résultat un
// numéro et un nom : l'historique redevient valide, et le modèle y lit qu'il a fait un appel inconnu.
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const OUTIL_INCONNU = "outil_inconnu";

// L'erreur du fournisseur qui dit que l'historique lui-même est refusé, et pas la requête du moment.
export const historiqueEmpoisonne = (erreur: string | undefined): boolean => !!erreur && /tool_call_id/i.test(erreur);

// Le fichier de session de pi pour un agent : `<horodatage>_<Nom>.jsonl` dans le dossier des sessions.
export function fichierSession(dossier: string, agent: string): string | undefined {
  if (!existsSync(dossier)) return undefined;
  return readdirSync(dossier).filter((f) => f.endsWith(`_${agent}.jsonl`)).sort().map((f) => join(dossier, f)).at(-1);
}

type Entree = { type?: string; message?: { role?: string; content?: unknown; toolCallId?: string; toolName?: string } };
type Partie = { type?: string; id?: string; name?: string };

// Renvoie le nombre d'appels réparés ; ne réécrit le fichier que s'il y a quelque chose à réparer.
export function reparerAppelsVides(fichier: string): number {
  const brut = readFileSync(fichier, "utf8");
  const lignes = brut.split("\n");
  // Les numéros reprennent après ceux d'une réparation précédente : repartir de 1 donnerait deux appels au même
  // numéro, que des fournisseurs refusent.
  const deja = Math.max(0, ...[...brut.matchAll(/essaim_repare_(\d+)/g)].map((m) => Number(m[1])));
  let n = 0, dernier = deja;
  let enAttente: string[] = []; // les numéros donnés aux appels vides, dans l'ordre, pour leurs résultats
  const sortie = lignes.map((ligne) => {
    if (!ligne.trim()) return ligne;
    let e: Entree;
    try { e = JSON.parse(ligne) as Entree; } catch { return ligne; }
    const m = e.message;
    if (e.type !== "message" || !m) return ligne;
    if (m.role === "assistant" && Array.isArray(m.content)) {
      let touche = false;
      for (const p of m.content as Partie[]) {
        if (p?.type === "toolCall" && !p.id) {
          n++;
          p.id = `essaim_repare_${++dernier}`;
          if (!p.name) p.name = OUTIL_INCONNU;
          enAttente.push(p.id);
          touche = true;
        }
      }
      return touche ? JSON.stringify(e) : ligne;
    }
    if (m.role === "toolResult" && !m.toolCallId) {
      m.toolCallId = enAttente.shift() ?? (n++, `essaim_repare_${++dernier}`);
      if (!m.toolName) m.toolName = OUTIL_INCONNU;
      return JSON.stringify(e);
    }
    return ligne;
  });
  if (n === 0) return 0;
  const tmp = `${fichier}.reparation`;
  writeFileSync(tmp, sortie.join("\n"));
  renameSync(tmp, fichier);
  return n;
}

// Trop d'images dans la mémoire : les captures qu'un agent lit avec `read` restent dans sa
// session, résumé compris, et pi les renvoie à chaque requête. Certains fournisseurs en refusent plus de quatre :
// « Too many images in request: 6 > 4 », à chaque relance sur la même session.
// De même pour « Downloaded image content cannot exceed 30MB » (une page rendue à très haute résolution).
export const tropDImages = (erreur: string | undefined): boolean => !!erreur && /too many images|image content cannot exceed/i.test(erreur);

export const IMAGE_RETIREE = "[image retirée de ta mémoire par la salle : le fournisseur refusait ces images (trop nombreuses, ou plus de 30 Mo). Si tu as encore besoin de la voir, relis le fichier, plus petit s'il était lourd.]";

// Chaque image de la session devient une ligne de texte ; renvoie le nombre d'images retirées, et ne réécrit le
// fichier que s'il y en avait. Toutes partent : la limite dépend du fournisseur, et l'agent relit celle qu'il lui faut.
export function retirerImages(fichier: string): number {
  let n = 0;
  const sortie = readFileSync(fichier, "utf8").split("\n").map((ligne) => {
    if (!ligne.includes('"image"')) return ligne;
    let e: Entree;
    try { e = JSON.parse(ligne) as Entree; } catch { return ligne; }
    const m = e.message;
    if (e.type !== "message" || !m || !Array.isArray(m.content)) return ligne;
    const avant = n;
    m.content = (m.content as Partie[]).map((p) => (p?.type === "image" ? (n++, { type: "text", text: IMAGE_RETIREE }) : p));
    return n > avant ? JSON.stringify(e) : ligne;
  });
  if (n === 0) return 0;
  const tmp = `${fichier}.reparation`;
  writeFileSync(tmp, sortie.join("\n"));
  renameSync(tmp, fichier);
  return n;
}
