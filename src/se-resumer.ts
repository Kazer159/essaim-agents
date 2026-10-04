// L'extension pi « se résumer » : chaque agent gère son propre contexte.
// Chargée par un second `-e` quand ESSAIM_COMPACTAGE vaut « avis,avertissement,coupure » (en tokens).
// Trois paliers lus après chaque outil : l'avis et l'avertissement sont ajoutés une seule fois au résultat
// (une phrase répétée grossirait le contexte qu'on veut réduire), la coupure bloque tout outil sauf se_resumer.
// En mode `-p`, un compactage lancé pendant la réponse meurt avec elle :
// l'outil se_resumer termine donc la réponse, et le lanceur relance l'agent avec la commande /se-resumer <note>,
// qui compacte au début du nouveau lancement, puis la reprise. Un lancement = un cycle de paliers.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export type Seuils = [number, number, number];

const texte = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });
const k = (n: number) => `${Math.round(n / 1000)}k`;

export function lireSeuils(brut: string): Seuils {
  const n = brut.split(",").map((x) => Number(x.trim()));
  if (n.length !== 3 || n.some((x) => !Number.isFinite(x) || x <= 0) || !(n[0]! < n[1]! && n[1]! < n[2]!))
    throw new Error(`seuils de compactage invalides : « ${brut} » (trois nombres croissants attendus)`);
  return n as Seuils;
}

export function palier(tokens: number | null, s: Seuils): "rien" | "avis" | "avertissement" | "coupure" {
  if (tokens === null) return "rien";
  if (tokens >= s[2]) return "coupure";
  if (tokens >= s[1]) return "avertissement";
  if (tokens >= s[0]) return "avis";
  return "rien";
}

// Ajouté au prompt de résumé de pi, jamais en remplacement.
export function instructions(note?: string): string {
  const base = "Tu résumes le contexte d'un agent de l'essaim, qui reprendra son travail juste après. Garde : le but de la mission, "
    + "l'état du livrable, les décisions prises et leurs raisons, les fichiers réclamés, et la prochaine action. "
    + "Le tableau garde tous les messages.";
  return note?.trim() ? `${base}\n\nNote de l'agent : ${note.trim()}` : base;
}

export default function (pi: ExtensionAPI) {
  const s = lireSeuils(process.env.ESSAIM_COMPACTAGE ?? "");
  let avisDonne = false, avertiDonne = false, demande = false;

  pi.registerTool({
    name: "moi_resumer", label: "Se résumer",
    description: "Résumer ton propre contexte : ta réponse s'arrête, ton contexte est résumé, puis tu reprends. Rend : la confirmation. Ne refuse pas : à la coupure de contexte, c'est le seul outil permis.",
    promptSnippet: "moi_resumer(note) : résumer ton propre contexte, puis reprendre",
    parameters: Type.Object({ note: Type.String({ description: "texte joint au résumé" }) }),
    async execute() {
      if (demande) return { ...texte("résumé déjà demandé : il aura lieu dès la fin de cette réponse"), terminate: true };
      demande = true;
      return { ...texte("résumé demandé : ta réponse s'arrête ici, tu reprendras juste après le résumé"), terminate: true };
    },
  });

  pi.registerCommand("se-resumer", {
    description: "compacter le contexte avec la note de l'agent, et attendre la fin",
    handler: (note, ctx) => new Promise<void>((fin) => {
      ctx.compact({ customInstructions: instructions(note), onComplete: () => fin(), onError: () => fin() });
    }),
  });

  pi.on("tool_call", (ev, ctx) => {
    if (ev.toolName === "moi_resumer") return undefined;
    const tokens = ctx.getContextUsage()?.tokens ?? null;
    if (palier(tokens, s) !== "coupure") return undefined;
    // Une fois le résumé demandé, le refus termine aussi la réponse : pi ne termine un lot d'outils que si chacun
    // porte terminate, et [moi_resumer, read] tournerait sinon sans fin, à plein contexte.
    return { block: true, reason: `refusé : ton contexte fait ${k(tokens!)} tokens, au-delà de la coupure (${k(s[2])}) ; seul moi_resumer passe. Se lève après le résumé.`, ...(demande ? { terminate: true } : {}) };
  });

  pi.on("tool_result", (ev, ctx) => {
    const tokens = ctx.getContextUsage()?.tokens ?? null;
    const p = palier(tokens, s);
    let phrase: string | undefined;
    if ((p === "avertissement" || p === "coupure") && !avertiDonne) {
      avertiDonne = avisDonne = true;
      phrase = `[contexte] ${k(tokens!)} tokens : au-delà de l'avertissement (${k(s[1])}) ; à ${k(s[2])}, seul moi_resumer passe.`;
    } else if (p === "avis" && !avisDonne) {
      avisDonne = true;
      phrase = `[contexte] ${k(tokens!)} tokens : au-delà de l'avis (${k(s[0])}) ; avertissement à ${k(s[1])}, à ${k(s[2])} seul moi_resumer passe.`;
    }
    return phrase ? { content: [...ev.content, { type: "text" as const, text: phrase }] } : undefined;
  });
}
