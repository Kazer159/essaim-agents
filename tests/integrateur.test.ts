// L'intégrateur qui décroche : un commit qui défait le travail récent d'un autre est repéré ;
// la file des essais pas encore adoptés, calculée pour l'intégrateur.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as D from "../src/depot.ts";
import { ouvrirBun } from "../src/tableau-bun.ts";
import * as T from "../src/tableau.ts";

let dossier: string;
beforeEach(() => { dossier = mkdtempSync(join(tmpdir(), "essaim-integrateur-")); });
afterEach(() => rmSync(dossier, { recursive: true, force: true }));

describe("J1 : un commit qui défait le travail récent d'un autre", () => {
  const lignes = (v: Record<string, string>) => Object.entries(v).map(([k, x]) => JSON.stringify({ id: k, texte: x })).join("\n") + "\n";
  const ecrireEtCommiter = async (partage: string, agent: string, contenu: string) => {
    writeFileSync(join(partage, "texte.jsonl"), contenu);
    return (await D.commiter(partage, agent, `bash de ${agent}`))!;
  };

  test("le réassemblage de Bernard remet deux lignes corrigés par Pascal : défait, deux lignes, commit et auteur nommés", async () => {
    const partage = join(dossier, "partage");
    await D.ouvrirDepot(partage);
    await ecrireEtCommiter(partage, "Bernard", lignes({ "1": "a", "2": "b faux", "3": "c faux", "4": "d" }));
    const pascal = await ecrireEtCommiter(partage, "Pascal", lignes({ "1": "a", "2": "b", "3": "c", "4": "d" }));
    const bernard = await ecrireEtCommiter(partage, "Bernard", lignes({ "1": "a", "2": "b faux", "3": "c faux", "4": "d nouveau" }));
    expect(await D.defaits(partage, bernard, "Bernard")).toEqual([{ chemin: "texte.jsonl", commit: pascal.hash, auteur: "Pascal", lignes: 2 }]);
  });

  test("une réécriture qui ne remet rien d'avant, ou un commit de son propre travail : rien", async () => {
    const partage = join(dossier, "partage");
    await D.ouvrirDepot(partage);
    await ecrireEtCommiter(partage, "Bernard", lignes({ "1": "a faux" }));
    await ecrireEtCommiter(partage, "Pascal", lignes({ "1": "a" }));
    const claude = await ecrireEtCommiter(partage, "Claude", lignes({ "1": "a mieux" }));
    expect(await D.defaits(partage, claude, "Claude")).toEqual([]);
    await ecrireEtCommiter(partage, "Claude", lignes({ "1": "a encore mieux" }));
    const retour = await ecrireEtCommiter(partage, "Claude", lignes({ "1": "a mieux" }));
    expect(await D.defaits(partage, retour, "Claude")).toEqual([]);
  });

  test("le dernier mot à Pascal qui remet sa correction par-dessus celle de Claude : Claude est nommé", async () => {
    const partage = join(dossier, "partage");
    await D.ouvrirDepot(partage);
    await ecrireEtCommiter(partage, "Bernard", lignes({ "1": "a faux" }));
    await ecrireEtCommiter(partage, "Pascal", lignes({ "1": "a" }));
    const claude = await ecrireEtCommiter(partage, "Claude", lignes({ "1": "a mieux" }));
    const pascal = await ecrireEtCommiter(partage, "Pascal", lignes({ "1": "a" }));
    expect(await D.defaits(partage, pascal, "Pascal")).toEqual([{ chemin: "texte.jsonl", commit: claude.hash, auteur: "Claude", lignes: 1 }]);
  });
});

describe("K19 : les essais qu'un bash a pu toucher", () => {
  test("ceux de son auteur et ceux que la commande nomme ; pas les autres", () => {
    const essais = ["/run/essais/lignes", "/run/essais/autre", "/run/essais/troisieme"];
    expect(D.essaisDuBash(essais, ["/run/essais/lignes"], "python3 rend.py")).toEqual(["/run/essais/lignes"]);
    expect(D.essaisDuBash(essais, [], "cd ../essais/autre && python3 rend.py")).toEqual(["/run/essais/autre"]);
    expect(D.essaisDuBash(essais, [], "bun test")).toEqual([]);
  });
});
