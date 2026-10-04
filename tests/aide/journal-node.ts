// Aide de test : sous Node, comme l'extension dans pi, ouvre le dépôt du run
// (D.ouvrirDepot, git par execFile), y commite un fichier, charge l'extension (ouvrirNode, ESSAIM_PARTAGE) et
// appelle depot_journal et code_tester sur le faux ExtensionAPI ; affiche un JSON.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import * as D from "../../src/depot.ts";
import extension from "../../src/outils-essaim.ts";
import { fauxPi } from "./faux-extension-api.ts";

const [chemin, partage] = [process.argv[2]!, process.argv[3]!];
await D.ouvrirDepot(partage);
writeFileSync(join(partage, "simu.js"), "export const x = 1;\n");
await D.commiter(partage, "Bernard", "write simu.js");
writeFileSync(join(partage, "a.test.ts"), 'import { test, expect } from "bun:test";\ntest("la caisse de 1997", () => expect(229).toBe(319));\n');

process.env.ESSAIM_AGENT = "agent-01";
process.env.ESSAIM_TABLEAU = chemin;
process.env.ESSAIM_PARTAGE = partage;
const pi = fauxPi();
extension(pi.api); // ouvrirNode, comme pi
console.log(JSON.stringify({
  journal: await pi.texte("depot_journal", {}),
  journalSimu: await pi.texte("depot_journal", { chemin: "simu.js" }),
  tester: await pi.texte("code_tester", { fichier: "a.test.ts" }),
}));
