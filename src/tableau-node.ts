// Adaptateur node:sqlite du tableau : c'est celui de l'extension, qui tourne
// dans le processus pi, donc sous Node.
//
// Aucun import statique de node:sqlite : le module est demandé à l'appel, par
// process.getBuiltinModule (Node 22.3+). Ainsi les tests sous Bun peuvent
// importer ce fichier (et l'extension qui l'importe) sans jamais l'exécuter.
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import type { Tableau } from "./tableau.ts";

const propres = (params: unknown[] = []) => params.map((p) => (p === undefined ? null : p)) as never[];

export function ouvrirNode(chemin: string): Tableau {
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as { DatabaseSync: typeof DatabaseSyncType };
  const db = new DatabaseSync(chemin);
  db.exec("PRAGMA busy_timeout = 5000"); // par connexion : le schéma ne le pose que pour celle qui l'exécute
  return {
    exec: (sql) => db.exec(sql),
    run: (sql, params) => {
      const r = db.prepare(sql).run(...propres(params));
      return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
    },
    get: (sql, params) => (db.prepare(sql).get(...propres(params)) ?? undefined) as never,
    all: (sql, params) => db.prepare(sql).all(...propres(params)) as never,
    transaction: (fn) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const r = fn();
        db.exec("COMMIT");
        return r;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    fermer: () => db.close(),
  };
}
