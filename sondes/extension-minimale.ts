// Sonde : extension pi minimale. Au chargement (avant tout appel de modèle),
// elle écrit une ligne dans une base SQLite avec node:sqlite, puis enregistre un
// outil qui ne fait rien. Si la ligne est en base après le lancement de pi, la
// voie « extension sous Node + node:sqlite » est prouvée.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export default function (pi: ExtensionAPI) {
  const chemin = process.env.SONDE_DB;
  if (!chemin) throw new Error("SONDE_DB manquant");
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(chemin);
  db.exec("PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS sonde(quand TEXT)");
  db.prepare("INSERT INTO sonde VALUES (?)").run(new Date().toISOString());
  db.close();

  pi.registerTool({
    name: "sonde",
    label: "Sonde",
    description: "ne fait rien",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "ok" }], details: {} };
    },
  });
}
