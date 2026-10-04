// Les rôles des agents : les gabarits par type de run, l'attribution des sièges et des
// suppléants, la table des droits, et aucun modèle d'IA nommé dans un rôle.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { attribuer, avecSurveillant, DROITS, GABARITS, heritier, porteurDuLivrable, presenterEquipe, refusConfier, repartiteur, ROLES, TYPES_RUN, type Role } from "../src/roles.ts";
import { destinatairesSurveillant, refusParoleSurveillant } from "../src/surveillant.ts";

const racine = resolve(import.meta.dir, "..");
const roles = (n: ReturnType<typeof attribuer>) => n.map((s) => s.role);

describe("les gabarits (spec §4)", () => {
  test("un type par gabarit, dans l'ordre d'entrée : chef, intégrateur, constructeurs, recette, gardien", () => {
    expect(Object.keys(GABARITS).sort()).toEqual([...TYPES_RUN].sort());
    expect(GABARITS.fichier).toEqual(["constructeur"]);
    expect(GABARITS.jeu).toEqual(["integrateur", "constructeur", "constructeur", "constructeur", "recette"]);
    for (const t of ["application", "simulation"] as const)
      expect(GABARITS[t]).toEqual(["chef", "integrateur", "constructeur", "constructeur", "constructeur", "constructeur", "recette", "gardien"]);
    for (const t of ["document", "probleme"] as const)
      expect(GABARITS[t]).toEqual(["chef", "integrateur", "constructeur", "constructeur", "gardien"]);
  });
});

describe("attribuer(type, n)", () => {
  test("au gabarit exact : un siège par rôle, rang dans le rôle", () => {
    const s = attribuer("jeu", 5);
    expect(roles(s)).toEqual(GABARITS.jeu);
    expect(s.map((x) => x.rang)).toEqual([1, 1, 2, 3, 1]);
  });

  test("au-delà du gabarit : les sièges en plus sont des constructeurs, rangés avec les autres", () => {
    expect(roles(attribuer("application", 10))).toEqual(["chef", "integrateur", ...Array(6).fill("constructeur"), "recette", "gardien"]);
    expect(roles(attribuer("fichier", 3))).toEqual(["constructeur", "constructeur", "constructeur"]);
  });

  test("document et probleme : la recette entre à 6 agents, les constructeurs ensuite", () => {
    expect(roles(attribuer("document", 5))).toEqual(GABARITS.document);
    expect(roles(attribuer("probleme", 6))).toEqual(["chef", "integrateur", "constructeur", "constructeur", "recette", "gardien"]);
    expect(roles(attribuer("document", 8))).toEqual(["chef", "integrateur", "constructeur", "constructeur", "constructeur", "constructeur", "recette", "gardien"]);
  });

  test("en dessous du gabarit : refus qui dit le minimum du type", () => {
    expect(() => attribuer("application", 7)).toThrow("au moins 8 agents pour le type application");
    expect(() => attribuer("jeu", 4)).toThrow("au moins 5 agents pour le type jeu");
    expect(() => attribuer("document", 4)).toThrow("au moins 5 agents pour le type document");
    expect(() => attribuer("fichier", 0)).toThrow("au moins 1 agent pour le type fichier");
  });

  test("les suppléants de l'intégrateur et du chef : deux constructeurs distincts, nommés au lancement (spec §7)", () => {
    for (const type of ["application", "simulation", "document", "probleme"] as const) {
      const s = attribuer(type, GABARITS[type].length);
      const integ = s.filter((x) => x.suppleantDe === "integrateur");
      const chef = s.filter((x) => x.suppleantDe === "chef");
      expect(integ.length).toBe(1);
      expect(chef.length).toBe(1);
      expect(integ[0]!.role).toBe("constructeur");
      expect(chef[0]!.role).toBe("constructeur");
      expect(integ[0]).not.toBe(chef[0]);
    }
    const jeu = attribuer("jeu", 5); // sans chef : le seul suppléant est celui de l'intégrateur
    expect(jeu.filter((x) => x.suppleantDe).map((x) => [x.role, x.rang, x.suppleantDe])).toEqual([["constructeur", 1, "integrateur"]]);
    expect(attribuer("fichier", 2).some((x) => x.suppleantDe)).toBe(false);
  });
});

describe("l'assembleur (02/10) : avec un ## Livrable et un intégrateur", () => {
  test("un siège pris sur les constructeurs, après l'intégrateur ; jamais sans livrable, sans intégrateur, ni sous trois constructeurs", () => {
    const roles = (type: Parameters<typeof attribuer>[0], n: number, livrable = true) => attribuer(type, n, { livrable }).map((x) => x.role);
    expect(roles("document", 20).slice(0, 4)).toEqual(["chef", "integrateur", "assembleur", "constructeur"]);
    expect(roles("document", 20).filter((r) => r === "constructeur")).toHaveLength(15);
    expect(roles("document", 20, false)).not.toContain("assembleur");
    expect(roles("fichier", 4)).not.toContain("assembleur");
    expect(roles("jeu", 5)).not.toContain("assembleur"); // trois constructeurs : il en resterait deux
    expect(roles("jeu", 6)).toEqual(["integrateur", "assembleur", "constructeur", "constructeur", "constructeur", "recette"]);
    expect(attribuer("jeu", 6, { livrable: true }).find((x) => x.role === "assembleur")!.suppleantDe).toBeUndefined();
  });
});

describe("DROITS (spec §3.1) : la source unique des refus", () => {
  test("écrire le produit : intégrateur, assembleur et constructeur seulement", () => {
    expect(ROLES.filter((r) => DROITS[r].ecritProduit)).toEqual(["integrateur", "assembleur", "constructeur"]);
  });
  test("le chef ne ferme aucune alerte ; recette et gardien signent chacun leur sorte de preuve", () => {
    expect(DROITS.chef.fermeAlerte).toBe(false);
    expect(DROITS.recette.attesteDes).toEqual(["parcours"]);
    expect(DROITS.gardien.attesteDes).toEqual(["mesure"]);
    for (const r of ["chef", "integrateur", "assembleur", "constructeur"] as Role[]) expect(DROITS[r].attesteDes).toEqual([]);
  });
  test("chef, intégrateur, assembleur, recette, gardien et surveillant restent jusqu'à la fin (A5, 02/10) ; le chef seul confie les tickets", () => {
    expect(ROLES.filter((r) => DROITS[r].resteJusquALaFin)).toEqual(["chef", "integrateur", "assembleur", "recette", "gardien", "surveillant"]);
    expect(ROLES.filter((r) => DROITS[r].confieTickets)).toEqual(["chef"]);
  });
});

describe("l'équipe présentée aux agents ({EQUIPE})", () => {
  test("un prénom par siège, le rôle en toutes lettres, les suppléants dits", () => {
    const s = attribuer("jeu", 5).map((x, i) => ({ ...x, nom: ["Antoine", "Bernard", "Claude", "Denis", "Edmond"][i]! }));
    expect(presenterEquipe(s)).toBe("Antoine est intégrateur, Bernard constructeur (suppléant de l'intégrateur), Claude constructeur, Denis constructeur, Edmond recette.");
    const a = attribuer("application", 8).map((x, i) => ({ ...x, nom: `A${i}` }));
    expect(presenterEquipe(a)).toContain("A0 est chef");
    expect(presenterEquipe(a)).toContain("(suppléant du chef)");
    expect(presenterEquipe(a)).toContain("A7 gardien-mesureur.");
  });
});

// Un rôle se définit par sa mission, ses droits et ses refus, jamais par un modèle d'IA (« claude » est aussi un prénom de la salle : hors de la liste).
describe("aucun rôle ne nomme un modèle (D2)", () => {
  test("src/roles.ts et src/roles/*.md", () => {
    const dossier = join(racine, "src", "roles");
    const fichiers = [join(racine, "src", "roles.ts"), ...(existsSync(dossier) ? readdirSync(dossier).filter((f) => f.endsWith(".md")).map((f) => join(dossier, f)) : [])];
    expect(fichiers.length).toBe(1 + ROLES.length); // un fichier de consignes par rôle
    for (const f of fichiers) expect(readFileSync(f, "utf8"), f).not.toMatch(/deepseek|glm|mimo|gemini|gpt|grok|qwen|kimi/i);
  });
});

// Le surveillant : un siège de plus quand il y a un chef ; jamais
// répartiteur, porteur du livrable ni héritier ; il parle au chef, au gardien et à la recette présents.
describe("le surveillant : siège, place dans l'équipe, destinataires", () => {
  test("avecSurveillant : un siège de plus, le dernier, avec un chef seulement ; aucun droit d'écrire, de juger ou de confier", () => {
    expect(avecSurveillant(attribuer("application", 8)).map((s) => s.role).at(-1)).toBe("surveillant");
    expect(avecSurveillant(attribuer("application", 8))).toHaveLength(9);
    expect(avecSurveillant(attribuer("jeu", 5)).some((s) => s.role === "surveillant")).toBe(false);
    expect(avecSurveillant(attribuer("fichier", 1))).toHaveLength(1);
    expect(DROITS.surveillant).toEqual({ ecritProduit: false, fermeAlerte: false, attesteDes: [], resteJusquALaFin: true, confieTickets: false });
  });
  test("ni répartiteur, ni porteur du livrable, ni héritier, ni confieur, même chef et suppléant absents", () => {
    const equipe = [{ nom: "A", role: "chef", present: false }, { nom: "B", role: "integrateur", present: false }, { nom: "C", role: "constructeur", suppleantDe: "chef", present: false },
      { nom: "Y", role: "surveillant", present: true }];
    expect(repartiteur(equipe)?.nom).not.toBe("Y");
    expect(porteurDuLivrable(equipe)?.nom).not.toBe("Y");
    expect(heritier(equipe, "A")).not.toBe("Y");
    expect(refusConfier("surveillant", equipe, "Y")).toBeDefined();
  });
  test("destinataires : chef (ou son suppléant qui tient le siège), gardien, recette présents ; sans recette, deux", () => {
    const e = [{ nom: "A", role: "chef" }, { nom: "C", role: "constructeur", suppleantDe: "chef" }, { nom: "G", role: "gardien" }, { nom: "R", role: "recette" }, { nom: "Y", role: "surveillant" }];
    expect(destinatairesSurveillant(e)).toEqual(["A", "G", "R"]);
    expect(destinatairesSurveillant(e.map((a) => a.nom === "A" ? { ...a, present: false } : a))).toEqual(["C", "G", "R"]);
    expect(destinatairesSurveillant(e.filter((a) => a.role !== "recette"))).toEqual(["A", "G"]);
  });
  test("sa parole : un destinataire en tête, personne d'autre ; un nom dans le corps ne compte pas", () => {
    const m = ["A", "C", "G", "R"].map((nom) => ({ nom, alias: [nom === "A" ? "Antoine" : nom === "C" ? "Claude" : nom === "G" ? "Gaston" : "Remi"] }));
    const d = ["A", "G", "R"];
    expect(refusParoleSurveillant("Antoine : S4 allumé, pas de contradiction", d, m)).toBeUndefined();
    expect(refusParoleSurveillant("Antoine, Gaston, Remi : la spec suppose X", d, m)).toBeUndefined();
    expect(refusParoleSurveillant("Antoine : Claude a fermé #3", d, m)).toBeUndefined();
    expect(refusParoleSurveillant("Claude : arrête", d, m)).toContain("le surveillant parle au chef");
    expect(refusParoleSurveillant("Antoine, Claude : voyez", d, m)).toBeDefined();
    expect(refusParoleSurveillant("rien à signaler", d, m)).toBeDefined();
  });
});
