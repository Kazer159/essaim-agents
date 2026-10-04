// Adaptateur bun:sqlite du tableau : lanceur, tests et vue (jamais l'extension,
// qui tourne sous Node dans le processus pi).
import { Database } from "bun:sqlite";
import type { Tableau } from "./tableau.ts";

const propres = (params: unknown[] = []) => params.map((p) => (p === undefined ? null : p)) as never[];

export function ouvrirBun(chemin: string, options: { lectureSeule?: boolean } = {}): Tableau {
  const db = new Database(chemin, { readonly: !!options.lectureSeule, create: !options.lectureSeule });
  db.exec("PRAGMA busy_timeout = 5000"); // par connexion : le schéma ne le pose que pour celle qui l'exécute
  return {
    exec: (sql) => db.exec(sql),
    run: (sql, params) => {
      const r = db.query(sql).run(...propres(params));
      return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
    },
    get: (sql, params) => (db.query(sql).get(...propres(params)) ?? undefined) as never,
    all: (sql, params) => db.query(sql).all(...propres(params)) as never,
    transaction: (fn) => db.transaction(fn).immediate(), // BEGIN IMMEDIATE : une transaction différée qui monte en écriture après une lecture reçoit SQLITE_BUSY sans attendre
    fermer: () => db.close(),
  };
}
