import { describe, expect, test } from "bun:test";
import { fauxPi } from "./aide/faux-extension-api.ts";
import extension, { instructions, lireSeuils, palier } from "../src/se-resumer.ts";

const S: [number, number, number] = [80_000, 120_000, 160_000];

function instance() {
  process.env.ESSAIM_COMPACTAGE = S.join(",");
  const faux = fauxPi();
  extension(faux.api);
  return faux;
}

// Le texte ajouté par l'extension au résultat d'un outil, ou "" s'il n'y en a pas.
async function ajout(faux: ReturnType<typeof fauxPi>, tokens: number | null) {
  faux.regler(tokens);
  const r = (await faux.emettre("tool_result", { type: "tool_result", toolName: "read", content: [{ type: "text", text: "contenu" }] })) as { content?: Array<{ text?: string }> } | undefined;
  return r?.content ? r.content.slice(1).map((c) => c.text ?? "").join("\n") : "";
}

describe("T1 lireSeuils", () => {
  test("trois nombres croissants", () => {
    expect(lireSeuils("80000,120000,160000")).toEqual(S);
  });
  test("refuse ordre non croissant, moins de trois nombres, non-nombre", () => {
    expect(() => lireSeuils("80000,80000,90000")).toThrow();
    expect(() => lireSeuils("80000,120000")).toThrow();
    expect(() => lireSeuils("abc,1,2")).toThrow();
    expect(() => lireSeuils("")).toThrow();
  });
});

describe("palier", () => {
  test("rien, avis, avertissement, coupure", () => {
    expect(palier(79_999, S)).toBe("rien");
    expect(palier(80_000, S)).toBe("avis");
    expect(palier(120_000, S)).toBe("avertissement");
    expect(palier(160_000, S)).toBe("coupure");
    expect(palier(null, S)).toBe("rien");
  });
});

describe("T2 avis et avertissement", () => {
  test("rien sous l'avis, puis l'avis une seule fois", async () => {
    const f = instance();
    expect(await ajout(f, 79_000)).toBe("");
    const avis = await ajout(f, 81_000);
    expect(avis).toContain("81k");
    expect(avis).toContain("moi_resumer");
    expect(await ajout(f, 85_000)).toBe("");
  });
  test("l'avertissement une seule fois, avec le seuil de coupure", async () => {
    const f = instance();
    await ajout(f, 81_000);
    const avert = await ajout(f, 121_000);
    expect(avert).toContain("160k");
    expect(await ajout(f, 125_000)).toBe("");
  });
  test("un saut direct donne l'avertissement seul", async () => {
    const f = instance();
    expect(await ajout(f, 50_000)).toBe("");
    const t = await ajout(f, 125_000);
    expect(t).toContain("160k");
    expect(await ajout(f, 126_000)).toBe("");
  });
  test("tokens inconnus : rien", async () => {
    expect(await ajout(instance(), null)).toBe("");
  });
});

describe("T3 coupure", () => {
  test("au-delà de la coupure, tout outil sauf se_resumer est bloqué", async () => {
    const f = instance();
    f.regler(161_000);
    const r = (await f.emettre("tool_call", { type: "tool_call", toolName: "salle_poster", input: {} })) as { block?: boolean; reason?: string };
    expect(r.block).toBe(true);
    expect(r.reason).toContain("moi_resumer");
    expect(await f.emettre("tool_call", { type: "tool_call", toolName: "moi_resumer", input: {} })).toBeUndefined();
  });
  test("sous la coupure, rien n'est bloqué", async () => {
    const f = instance();
    f.regler(159_000);
    expect(await f.emettre("tool_call", { type: "tool_call", toolName: "salle_poster", input: {} })).toBeUndefined();
  });
});

describe("T4 outil et commande", () => {
  test("se_resumer termine la réponse sans compacter, une seule fois", async () => {
    const f = instance();
    const r = await f.appeler("moi_resumer", { note: "but : tableur ; prochaine action : tests" });
    expect(r.terminate).toBe(true);
    expect(f.compacts.length).toBe(0);
    const r2 = await f.appeler("moi_resumer", { note: "encore" });
    expect(r2.terminate).toBe(true); // sans lui, un lot [moi_resumer, moi_resumer] ne finit pas la réponse
    expect(r2.content[0]!.text).toContain("déjà");
  });
  test("à la coupure, une fois le résumé demandé, un outil bloqué termine aussi la réponse (29/09, revue)", async () => {
    // pi ne termine un lot d'outils que si chacun porte terminate : [moi_resumer, read] tourne sans fin à plein contexte.
    const f = instance();
    f.regler(165_000);
    const avant = (await f.emettre("tool_call", { type: "tool_call", toolName: "read", input: {} })) as { block?: boolean; terminate?: boolean };
    expect(avant).toMatchObject({ block: true });
    expect(avant.terminate).toBeUndefined(); // pas encore demandé : l'agent doit pouvoir appeler moi_resumer
    await f.appeler("moi_resumer", { note: "n" });
    const apres = (await f.emettre("tool_call", { type: "tool_call", toolName: "read", input: {} })) as { block?: boolean; terminate?: boolean };
    expect(apres).toMatchObject({ block: true, terminate: true });
  });
  test("la commande compacte avec la note et le rappel du tableau, et attend la fin", async () => {
    const f = instance();
    let rendu = false;
    const p = f.commande("se-resumer", "prochaine action : tests").then(() => { rendu = true; });
    await Promise.resolve();
    expect(f.compacts.length).toBe(1);
    expect(f.compacts[0]!.customInstructions).toContain("prochaine action : tests");
    expect(f.compacts[0]!.customInstructions).toContain("Le tableau garde tous les messages.");
    expect(rendu).toBe(false);
    f.compacts[0]!.onComplete!({});
    await p;
    expect(rendu).toBe(true);
  });
  test("la commande rend aussi la main si le compactage échoue", async () => {
    const f = instance();
    const p = f.commande("se-resumer", "");
    f.compacts[0]!.onError!(new Error("raté"));
    await p;
  });
  test("instructions sans note", () => {
    expect(instructions()).toContain("Le tableau garde tous les messages.");
    expect(instructions()).not.toContain("fil_historique"); // outil retiré
    expect(instructions()).not.toContain("Note de l'agent");
  });
});
