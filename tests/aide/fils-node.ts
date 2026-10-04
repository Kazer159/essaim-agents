// Aide de test (fils de concentration) : sous Node, comme l'extension dans pi, ouvre le tableau avec
// node:sqlite, exerce entrer, poster et quitter du tableau (gardés pour les anciens runs), puis les outils de
// l'extension sur le faux ExtensionAPI (dont salle_lire, les quatre outils de tickets et salle_budget), et affiche un
// JSON d'état. node:sqlite n'imbrique pas les transactions : une imbrication ferait planter ici.
import { ouvrirNode } from "../../src/tableau-node.ts";
import * as T from "../../src/tableau.ts";
import extension from "../../src/outils-essaim.ts";
import { fauxPi } from "./faux-extension-api.ts";

const chemin = process.argv[2]!;
const t = ouvrirNode(chemin);
T.initialiser(t);
T.poster(t, "agent-02", "bonjour");
const entrer = T.entrer(t, "agent-02", "q-pluie", "la pluie");
T.poster(t, "agent-02", "il pleut", "q-pluie");
const quitter = T.quitter(t, "agent-02", "il a plu");

process.env.ESSAIM_AGENT = "agent-01";
process.env.ESSAIM_TABLEAU = chemin;
const pi = fauxPi();
extension(pi.api); // ouvrirNode, comme pi
await pi.texte("salle_poster", { texte: "bonjour" });
const outils: Record<string, string> = {};
outils.salle_lire = await pi.texte("salle_lire", {});
outils.poster = await pi.texte("salle_poster", { texte: "dans le fil", fil: "q-neige" });
await pi.texte("salle_lire", {});
outils.dormir = await pi.texte("moi_dormir", { message: "j'attends" });
T.reveiller(t, "agent-01"); // le lanceur le relance
outils.ticket_ouvrir = await pi.texte("ticket_ouvrir", { type: "question", titre: "combien ?", description: "combien de flocons", charge: "agent-02" });
outils.ticket_modifier = await pi.texte("ticket_modifier", { id: 1, etat: "ferme", note: "trois" });
outils.ticket_lister = await pi.texte("ticket_lister", {});
outils.ticket_lire = await pi.texte("ticket_lire", { id: 1 });
outils.salle_budget = await pi.texte("salle_budget", {});
outils.fini = await pi.texte("moi_finir", { raison: "fait" });

console.log(JSON.stringify({
  tableau: { entrer: entrer.ok, quitter: quitter.ok },
  outils,
  fils: t.all("SELECT nom, conclusion, ferme_le IS NOT NULL AS ferme FROM fils ORDER BY id"),
  presences: t.get<{ n: number }>("SELECT count(*) AS n FROM presences")?.n,
}));
t.fermer();
