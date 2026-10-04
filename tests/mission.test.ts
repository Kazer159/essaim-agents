import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyserMission, lireMission } from "../src/mission.ts";

const dossier = mkdtempSync(join(tmpdir(), "essaim-mission-"));
const ecrire = (nom: string, contenu: string) => { const p = join(dossier, nom); writeFileSync(p, contenu); return p; };
const ERREUR = "la mission doit contenir une section « ## C'est fini quand » non vide";

describe("lireMission", () => {
  test("renvoie le texte et la définition de « fait »", () => {
    const p = ecrire("ok.md", "# Pélican\n\nDessine un pélican.\n\n## C'est fini quand\n\n`partage/pelican.svg` existe et s'ouvre.\n\n## Contraintes\n\nSVG pur.\n");
    const m = lireMission(p);
    expect(m.chemin).toBe(p);
    expect(m.texte).toContain("Dessine un pélican.");
    expect(m.finiQuand).toBe("`partage/pelican.svg` existe et s'ouvre.");
  });
  test("la section peut être la dernière", () => {
    const p = ecrire("fin.md", "Mission.\n\n## C'est fini quand\nle message est posté\n");
    expect(lireMission(p).finiQuand).toBe("le message est posté");
  });
  test("refuse sans la section", () => {
    expect(() => lireMission(ecrire("sans.md", "# Mission\n\nfais un truc\n"))).toThrow(ERREUR);
  });
  test("refuse une section vide", () => {
    expect(() => lireMission(ecrire("vide.md", "Mission\n\n## C'est fini quand\n\n\n## Suite\nbla\n"))).toThrow(ERREUR);
  });
  test("Livrable et Vérification, facultatives : absentes → undefined", () => {
    const m = lireMission(ecrire("sans-livrable.md", "Mission.\n\n## C'est fini quand\n\nfini\n"));
    expect(m.livrable).toBeUndefined();
    expect(m.verification).toBeUndefined();
  });
  test("Livrable : un chemin relatif à partage/, normalisé ; hors périmètre ou deux lignes → erreur", () => {
    expect(lireMission(ecrire("l1.md", "M.\n\n## C'est fini quand\n\nfini\n\n## Livrable\n\nindex.html\n")).livrable).toBe("index.html");
    expect(lireMission(ecrire("l2.md", "M.\n\n## C'est fini quand\n\nfini\n\n## Livrable\n\n./sous/fichier.md\n")).livrable).toBe("sous/fichier.md");
    expect(() => lireMission(ecrire("l3.md", "M.\n\n## C'est fini quand\n\nfini\n\n## Livrable\n\n../x\n"))).toThrow("chemin relatif à partage/");
    expect(() => lireMission(ecrire("l4.md", "M.\n\n## C'est fini quand\n\nfini\n\n## Livrable\n\n/etc/hosts\n"))).toThrow("chemin relatif à partage/");
    expect(() => lireMission(ecrire("l5.md", "M.\n\n## C'est fini quand\n\nfini\n\n## Livrable\n\na.md\nb.md\n"))).toThrow("sur une ligne");
    expect(() => lireMission(ecrire("l6.md", "M.\n\n## C'est fini quand\n\nfini\n\n## Livrable\n\n\n## Suite\nx\n"))).toThrow("chemin relatif à partage/");
  });
  test("Vérification : une commande, ou une suite de commandes ; vide → erreur", () => {
    const une = lireMission(ecrire("v1.md", "M.\n\n## C'est fini quand\n\nfini\n\n## Vérification\n\nbun test\n"));
    expect(une.verification).toBe("bun test");
    expect(une.verifications).toEqual(["bun test"]);
    // Une couture ne se voit qu'en enchaînant : la suite se lance dans l'ordre, sans nettoyage entre deux.
    const suite = lireMission(ecrire("v2.md", "M.\n\n## C'est fini quand\n\nfini\n\n## Vérification\n\nbun test\nbun depot.js init && bun depot.js log\n"));
    expect(suite.verifications).toEqual(["bun test", "bun depot.js init && bun depot.js log"]);
    expect(suite.verification).toBe("bun test");
    expect(() => lireMission(ecrire("v3.md", "M.\n\n## C'est fini quand\n\nfini\n\n## Vérification\n\n\n"))).toThrow("au moins une commande");
  });
  test("les missions du dépôt déclarent livrable et vérification", () => {
    for (const f of ["hopital.md", "ligne.md"]) {
      const m = lireMission(new URL(`../missions/${f}`, import.meta.url).pathname);
      expect(m.livrable, f).toBe("index.html");
      expect(m.verification, f).toBe("bun test");
    }
  });
  test("la mission hello-world des tests est valide", () => {
    const m = lireMission(new URL("./fixtures/hello-world.md", import.meta.url).pathname);
    expect(m.finiQuand.length).toBeGreaterThan(5);
    expect(m.texte).toContain("fini");
  });
  // Rôles des agents : ## Type, facultatif, un mot parmi les types de run ; sans lui, la mission tourne comme avant.
  test("Type : un mot parmi les types de run ; absent → undefined ; inconnu, vide ou deux mots → erreur", () => {
    expect(lireMission(ecrire("t0.md", "M.\n\n## C'est fini quand\n\nfini\n")).type).toBeUndefined();
    expect(lireMission(ecrire("t1.md", "M.\n\n## Type\n\napplication\n\n## C'est fini quand\n\nfini\n")).type).toBe("application");
    expect(lireMission(ecrire("t2.md", "M.\n\n## C'est fini quand\n\nfini\n\n## Type\n\n  jeu  \n")).type).toBe("jeu");
    const erreur = "le type doit être l'un de : fichier, document, jeu, application, simulation, probleme";
    expect(() => lireMission(ecrire("t3.md", "M.\n\n## C'est fini quand\n\nfini\n\n## Type\n\nsite\n"))).toThrow(erreur);
    expect(() => lireMission(ecrire("t4.md", "M.\n\n## C'est fini quand\n\nfini\n\n## Type\n\n\n"))).toThrow(erreur);
    expect(() => lireMission(ecrire("t5.md", "M.\n\n## C'est fini quand\n\nfini\n\n## Type\n\njeu\napplication\n"))).toThrow(erreur);
  });
  test("la mission exemple des rôles (missions/exemples/roles-mini.md) : type application, livrable, vérification", () => {
    const m = lireMission(new URL("../missions/exemples/roles-mini.md", import.meta.url).pathname);
    expect(m.type).toBe("application");
    expect(m.livrable).toBe("index.html");
    expect(m.verifications?.length).toBeGreaterThan(0);
  });
  test("seules ligne et hôpital déclarent un type, écrites pour un run à rôles : les autres tournent comme avant", () => {
    const dossier = new URL("../missions/", import.meta.url).pathname;
    const types: Record<string, string> = { "ligne.md": "simulation", "hopital.md": "probleme" };
    for (const f of readdirSync(dossier).filter((f) => f.endsWith(".md"))) expect(lireMission(join(dossier, f)).type, f).toBe(types[f]);
  });
});

describe("un titre de section presque bon arrête le lancement (D6, 30/09)", () => {
  const FIN = "## C'est fini quand\n\nfini appelé\n";
  test("« Vérifications », « Verification », « vérification : » : refusés, avec le bon titre dans le message", () => {
    for (const titre of ["## Vérifications", "## Verification", "## vérification :", "## Livrables", "## type"])
      expect(() => analyserMission("m.md", `${FIN}\n${titre}\n\nbun test\n`)).toThrow("ressemble à");
    expect(() => analyserMission("m.md", `${FIN}\n## Vérifications\n\nbun test\n`)).toThrow("« ## Vérification »");
  });
  test("un accent tapé autrement (é décomposé) est reconnu ; un titre simplement proche n'est pas touché", () => {
    expect(analyserMission("m.md", `${FIN}\n## Vérification\n\nbun test\n`).verifications).toEqual(["bun test"]);
    expect(analyserMission("m.md", `${FIN}\n## Les deux passes de vérification\n\ntexte\n`).verifications).toBeUndefined();
  });
});
