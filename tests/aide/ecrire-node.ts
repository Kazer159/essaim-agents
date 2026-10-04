// Aide de test : sous Node, ouvre le tableau avec l'adaptateur node:sqlite,
// insère deux messages dans une transaction et affiche le compte.
import { ouvrirNode } from "../../src/tableau-node.ts";

const t = ouvrirNode(process.argv[2]!);
t.transaction(() => {
  t.run("INSERT INTO messages(fil_id, auteur, cree_le, texte) VALUES (1, 'agent-02', '2026-09-21T00:00:01Z', ?)", ["un"]);
  t.run("INSERT INTO messages(fil_id, auteur, cree_le, texte) VALUES (1, 'agent-02', '2026-09-21T00:00:02Z', ?)", ["deux"]);
});
console.log(t.get<{ n: number }>("SELECT count(*) AS n FROM messages")?.n);
t.fermer();
