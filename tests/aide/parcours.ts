// Les pièces des parcours au faux pi (fin de run, rôles de bout en bout) : une fixture écrite depuis le test, un appel
// d'outil, la fin d'un tour, et deux appels de moi_dormir (le premier peut être refusé une fois, un ticket confié ; le
// second passe).
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export const ecrireFixture = (dossier: string, nom: string, lignes: object[]) => {
  const p = join(dossier, `${nom}.jsonl`);
  writeFileSync(p, lignes.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return p;
};
export const appel = (id: string, toolName: string, args: object) => ({ type: "tool_execution_start", toolCallId: id, toolName, args });
export const fin = { type: "agent_end" };
export const DORMIR = [appel("d1", "moi_dormir", { message: "ma part est faite" }), appel("d2", "moi_dormir", { message: "ma part est faite" }), fin];
