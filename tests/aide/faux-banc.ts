#!/usr/bin/env bun
// Faux pi du banc d'essai : imite `pi -e sondes/banc-extension.ts` sans aucun modèle ni réseau. Il lit le
// catalogue (BANC_CATALOGUE) et la situation (BANC_SITUATION, BANC_COTE), prend la réponse écrite d'avance dans
// FAUX_BANC_REPONSES ({ "<situation>": { "avant": R, "apres": R } }) et fait ce que ferait l'extension : écrire le
// message de l'assistant dans BANC_SORTIE. R vaut une liste d'appels [{ name, arguments }] (vide : aucun appel),
// { "panne": true } (pi meurt sans répondre) ou { "erreur": "…" } (le fournisseur répond en erreur).
// Chaque lancement ajoute ses arguments et le catalogue lu à FAUX_BANC_JOURNAL, s'il est défini.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const env = process.env;
const argv = process.argv.slice(2);
const catalogue = JSON.parse(readFileSync(env.BANC_CATALOGUE!, "utf8")) as { commit: string; outils: Array<{ name: string }> };
if (env.FAUX_BANC_JOURNAL) appendFileSync(env.FAUX_BANC_JOURNAL, JSON.stringify({ argv, situation: env.BANC_SITUATION, cote: env.BANC_COTE, commit: catalogue.commit, outils: catalogue.outils.length }) + "\n");
const reponses = JSON.parse(readFileSync(env.FAUX_BANC_REPONSES!, "utf8")) as Record<string, Record<string, unknown>>;
const r = reponses[env.BANC_SITUATION!]?.[env.BANC_COTE!] ?? [];
if (r && typeof r === "object" && "panne" in r) {
  console.error("faux banc : panne simulée");
  process.exit(1);
}
const erreur = r && typeof r === "object" && "erreur" in r ? String((r as { erreur: unknown }).erreur) : undefined;
const appels = Array.isArray(r) ? (r as Array<{ name: string; arguments: unknown }>) : [];
const message = {
  role: "assistant",
  content: appels.length ? appels.map((a, i) => ({ type: "toolCall", id: `appel-${i + 1}`, name: a.name, arguments: a.arguments })) : [{ type: "text", text: "Je réfléchis." }],
  usage: { input: 1000, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 1050, cost: { total: erreur ? 0 : 0.001 } },
  stopReason: erreur ? "error" : appels.length ? "toolUse" : "stop",
  ...(erreur ? { errorMessage: erreur } : {}),
};
writeFileSync(env.BANC_SORTIE!, JSON.stringify(message));
process.stdout.write(JSON.stringify({ type: "message_end", message }) + "\n");
