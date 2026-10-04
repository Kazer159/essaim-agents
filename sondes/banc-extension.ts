// L'extension pi du banc d'essai, chargée par `pi -e` à la place de celles de la salle : elle
// enregistre les outils d'un catalogue figé (BANC_CATALOGUE, écrit par `banc-outils.ts figer`) sans rien exécuter.
// À la première réponse de l'assistant, elle écrit ce message dans BANC_SORTIE et arrête pi : un seul appel au
// fournisseur par lancement. pi validerait puis rejetterait un appel invalide ou un nom inconnu et renverrait l'erreur
// au modèle, d'où l'arrêt ici plutôt qu'un simple refus des appels. Tourne sous Node, dans le processus pi.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync } from "node:fs";

type OutilFige = { name: string; label: string; description: string; promptSnippet?: string; parameters: unknown };

export default function (pi: ExtensionAPI) {
  const catalogue = process.env.BANC_CATALOGUE, sortie = process.env.BANC_SORTIE;
  if (!catalogue || !sortie) throw new Error("BANC_CATALOGUE et BANC_SORTIE sont obligatoires");
  const { outils } = JSON.parse(readFileSync(catalogue, "utf8")) as { outils: OutilFige[] };
  for (const o of outils) {
    // Le schéma JSON tel quel : validateToolArguments de pi-ai accepte un schéma sans marque TypeBox.
    pi.registerTool({ ...o, parameters: o.parameters as never, execute: async () => ({ content: [{ type: "text" as const, text: "banc" }], details: {} }) });
  }
  let requetes = 0;
  // Filet : jamais une deuxième requête au fournisseur (une relance automatique de pi après une erreur, par exemple).
  pi.on("before_provider_request", () => { if (++requetes > 1) process.exit(3); });
  // Aucun outil ne s'exécute, ceux de pi compris.
  pi.on("tool_call", () => ({ block: true, reason: "banc" }));
  pi.on("message_end", (ev) => {
    if ((ev.message as { role?: string }).role !== "assistant") return;
    writeFileSync(sortie, JSON.stringify(ev.message));
    process.exit(0);
  });
}
