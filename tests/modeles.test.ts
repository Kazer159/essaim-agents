import { describe, expect, test } from "bun:test";
import { resoudreModele, lireCatalogue, type Catalogue } from "../src/modeles.ts";

const catalogue: Catalogue = {
  "openrouter/google/gemini-3.8-flash": { input: 0.75, output: 3.75 },
  "openrouter/gratuit/zero": { input: 0, output: 0 },
};
const yaml = {
  "gemini-flash": { id: "openrouter/google/gemini-3.8-flash", reflexion: "medium" },
  "inconnu": { id: "openrouter/x/inconnu", reflexion: "medium" },
  "zero": { id: "openrouter/gratuit/zero", reflexion: "medium" },
  "manuel": { id: "openrouter/x/inconnu", reflexion: "high", tarif: { entree: 1, sortie: 2 } },
  "faux": { id: "faux/faux", reflexion: "off", tarif: { entree: 0, sortie: 0 } },
};

describe("resoudreModele", () => {
  test("alias connu du catalogue : tarif du catalogue, non estimé", () => {
    expect(resoudreModele("gemini-flash", catalogue, yaml)).toEqual({ id: "openrouter/google/gemini-3.8-flash", reflexion: "medium", tarif: { entree: 0.75, sortie: 3.75 }, estime: false });
  });
  test("un tarif manuel mal écrit est refusé : virgule française, texte, négatif (29/09, revue B7)", () => {
    // « { entree: 0,045, sortie: 0,14 } » se lit { entree: 0, 45: null, sortie: 0, 14: null } : un run sans plafond.
    const lu = Bun.YAML.parse("v:\n  id: a/b\n  tarif: { entree: 0,045, sortie: 0,14 }\n") as Record<string, never>;
    expect(() => resoudreModele("v", catalogue, lu)).toThrow("tarif manuel illisible pour a/b");
    for (const tarif of [{ entree: "0,045", sortie: 1 }, { entree: -1, sortie: 1 }, { entree: 1 }])
      expect(() => resoudreModele("t", catalogue, { t: { id: "a/c", tarif } } as never)).toThrow("tarif manuel illisible pour a/c");
    expect(resoudreModele("faux", catalogue, yaml).tarif).toEqual({ entree: 0, sortie: 0 }); // un zéro écrit exprès reste permis
  });
  test("id inconnu du catalogue sans tarif manuel : refusé", () => {
    expect(() => resoudreModele("inconnu", catalogue, yaml)).toThrow("tarif inconnu pour openrouter/x/inconnu : ajoute tarif: dans modeles.yaml");
  });
  test("tarif catalogue à zéro sans tarif manuel : refusé", () => {
    expect(() => resoudreModele("zero", catalogue, yaml)).toThrow("tarif inconnu pour openrouter/gratuit/zero : ajoute tarif: dans modeles.yaml");
  });
  test("tarif manuel : accepté et marqué estimé, même à zéro", () => {
    expect(resoudreModele("manuel", catalogue, yaml)).toEqual({ id: "openrouter/x/inconnu", reflexion: "high", tarif: { entree: 1, sortie: 2 }, estime: true });
    expect(resoudreModele("faux", catalogue, yaml)).toEqual({ id: "faux/faux", reflexion: "off", tarif: { entree: 0, sortie: 0 }, estime: true });
  });
  test("alias inconnu : refusé", () => {
    expect(() => resoudreModele("nimporte", catalogue, yaml)).toThrow("alias de modèle inconnu");
  });
  test("un id complet est accepté tel quel", () => {
    expect(resoudreModele("openrouter/google/gemini-3.8-flash", catalogue, yaml)).toEqual({ id: "openrouter/google/gemini-3.8-flash", reflexion: "medium", tarif: { entree: 0.75, sortie: 3.75 }, estime: false });
  });
  test("le modeles.yaml du dépôt est lu par défaut", () => {
    expect(resoudreModele("faux", catalogue)).toEqual({ id: "faux/faux", reflexion: "off", tarif: { entree: 0, sortie: 0 }, estime: true });
  });
});

describe("lireCatalogue", () => {
  test("la fenêtre de contexte est lue quand le catalogue la donne", () => {
    const c = lireCatalogue({ openrouter: { models: [{ id: "deepseek/deepseek-v4-flash", provider: "openrouter", contextWindow: 1_024_000, cost: { input: 0.05, output: 0.11 } }] } });
    expect(c["openrouter/deepseek/deepseek-v4-flash"]).toEqual({ input: 0.05, output: 0.11, fenetre: 1_024_000 });
    expect(resoudreModele("openrouter/deepseek/deepseek-v4-flash", c, {}).fenetre).toBe(1_024_000);
  });
  test("lit la forme réelle de models-store.json (fournisseur → models[] avec id et cost)", () => {
    const c = lireCatalogue({ openrouter: { models: [{ id: "google/gemini-3.8-flash", provider: "openrouter", cost: { input: 0.75, output: 3.75, cacheRead: 0.075 } }] }, openai: { models: [{ id: "gpt-4", provider: "openai", cost: { input: 30, output: 60 } }] } });
    expect(c).toEqual({ "openrouter/google/gemini-3.8-flash": { input: 0.75, output: 3.75 }, "openai/gpt-4": { input: 30, output: 60 } });
  });
  test("sans argument, lit le catalogue de pi sur la machine", () => {
    const c = lireCatalogue();
    expect(Object.keys(c).length).toBeGreaterThan(10);
  });
});
