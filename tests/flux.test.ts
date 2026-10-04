import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { analyserLigne, Compteur, type Ev } from "../src/flux.ts";

const fixture = (nom: string): Ev[] =>
  readFileSync(new URL(`./fixtures/${nom}.jsonl`, import.meta.url), "utf8").split("\n").map(analyserLigne).filter((e): e is Ev => !!e);

describe("analyserLigne", () => {
  test("ignore une ligne vide, non JSON ou sans type", () => {
    expect(analyserLigne("")).toBeUndefined();
    expect(analyserLigne("Warning: Model not found")).toBeUndefined();
    expect(analyserLigne('{"type":"agent_end"')).toBeUndefined();
    expect(analyserLigne('{"sans":"type"}')).toBeUndefined();
  });
  test("renvoie l'objet d'une ligne JSON typée", () => {
    expect(analyserLigne('{"type":"agent_end"}')).toEqual({ type: "agent_end" });
  });
});

describe("Compteur", () => {
  test("hello-fini : coût, tokens, appels, fini vu, aucun outil en cours", () => {
    const c = new Compteur();
    let t = 1000;
    const traces = fixture("hello-fini").map((e) => c.absorber(e, (t += 100)));
    expect(c.cout).toBeCloseTo(0.0012, 6);
    expect(c.coutEstime).toBe(false);
    expect(c.tokensEntree).toBe(1200);
    expect(c.tokensSortie).toBe(80);
    expect(c.appels).toBe(2);
    expect(c.echecs).toBe(0);
    expect(c.finiVu).toBe(true);
    expect(c.outilEnCours).toBeUndefined();
    expect(c.erreur).toBeUndefined();
    expect(c.derniereActivite).toBe(1600);
    expect(traces.length).toBe(6);
    expect(traces[0]).toEqual({ type: "tool_execution_start", outil: "salle_poster", appelId: "call_1", arguments: '{"texte":"bonjour de agent-01"}' });
    expect(traces[1]).toEqual({ type: "tool_execution_end", outil: "salle_poster", appelId: "call_1", resultat: "message 1 posté dans principal", dureeMs: 100, erreur: undefined });
    expect(traces[4]).toEqual({ type: "message_end", tokensEntree: 1200, tokensSortie: 80, coutUsd: 0.0012, erreur: undefined });
    expect(traces[5]).toEqual({ type: "agent_end" });
  });
  test("outil-bloque : l'outil reste en cours", () => {
    const c = new Compteur();
    for (const e of fixture("outil-bloque")) c.absorber(e, 5000);
    expect(c.outilEnCours).toEqual({ id: "call_9", nom: "bash", depuis: 5000 });
    expect(c.appels).toBe(1);
  });
  test("erreur-fournisseur : l'erreur est retenue, coût nul", () => {
    const c = new Compteur();
    const traces = fixture("erreur-fournisseur").map((e) => c.absorber(e));
    expect(c.erreur).toBe("402: insufficient credits");
    expect(c.cout).toBe(0);
    expect(traces[0]?.erreur).toBe("402: insufficient credits");
  });
  test("compaction : le coût du compactage est ajouté une fois", () => {
    const c = new Compteur();
    fixture("compaction").forEach((e) => c.absorber(e));
    expect(c.cout).toBeCloseTo(0.003, 6);
    expect(c.tokensEntree).toBe(900);
  });
  test("compaction : tokens avant et après dans la trace, échec marqué", () => {
    const c = new Compteur();
    const tr = c.absorber({ type: "compaction_end", reason: "manual", result: { tokensBefore: 124_000, estimatedTokensAfter: 19_400, usage: { cost: { total: 0.01 } } }, aborted: false, willRetry: false });
    expect(tr).toMatchObject({ type: "compaction_end", tokensEntree: 124_000, resultat: "124k → 19k tokens", coutUsd: 0.01 });
    expect(c.compactageRate).toBe(false);
    const rate = c.absorber({ type: "compaction_end", reason: "manual", aborted: true, willRetry: false, errorMessage: "raté" });
    expect(rate).toMatchObject({ erreur: "raté" });
    expect(c.compactageRate).toBe(true);
  });
  test("compaction : le résumé en cours compte comme un outil, pas comme un silence (run réseau du 24/09)", () => {
    const c = new Compteur(undefined, 0);
    expect(c.absorber({ type: "compaction_start", reason: "manual" }, 1_000)).toMatchObject({ type: "compaction_start" });
    expect(c.outilEnCours).toEqual({ id: "compactage", nom: "se résumer", depuis: 1_000 });
    expect(c.dernierProgres).toBe(1_000);
    c.absorber({ type: "compaction_end", reason: "manual", result: { tokensBefore: 150_000 }, aborted: false, willRetry: false }, 700_000);
    expect(c.outilEnCours).toBeUndefined();
    c.absorber({ type: "compaction_start", reason: "manual" }, 800_000);
    c.nouvellePasse(); // une passe coupée en plein résumé ne laisse pas de résumé fantôme
    expect(c.outilEnCours).toBeUndefined();
  });
  test("se_resumer : note retenue, contexte de la dernière réponse, remis à zéro par passe", () => {
    const c = new Compteur();
    c.absorber({ type: "message_end", message: { role: "assistant", usage: { input: 1000, cacheRead: 90_000, output: 10 } } });
    c.absorber({ type: "tool_execution_start", toolCallId: "r", toolName: "moi_resumer", args: { note: "garde le but" } });
    c.absorber({ type: "tool_execution_end", toolCallId: "r", toolName: "moi_resumer", result: { content: [{ type: "text", text: "résumé demandé" }] }, isError: false });
    expect([c.resumeDemande, c.contexte]).toEqual(["garde le but", 91_000]);
    c.nouvellePasse();
    expect([c.resumeDemande, c.contexte, c.compactageRate]).toEqual([undefined, 0, false]);
  });
  test("un outil en échec compte un échec et ne marque pas fini", () => {
    const c = new Compteur();
    c.absorber({ type: "tool_execution_start", toolCallId: "x", toolName: "moi_finir", args: {} }, 10);
    c.absorber({ type: "tool_execution_end", toolCallId: "x", toolName: "moi_finir", result: { content: [{ type: "text", text: "boum" }] }, isError: true }, 20);
    expect(c.echecs).toBe(1);
    expect(c.finiVu).toBe(false);
  });
  test("un fini refusé ne marque pas fini (run vallée : Fabien, refusé deux fois, puis sorti au lieu de dormir)", () => {
    const c = new Compteur();
    c.absorber({ type: "tool_execution_start", toolCallId: "x", toolName: "moi_finir", args: {} }, 10);
    c.absorber({ type: "tool_execution_end", toolCallId: "x", toolName: "moi_finir", result: { content: [{ type: "text", text: "refusé, une fois : du travail reste ouvert dans la salle." }] } }, 20);
    expect(c.finiVu).toBe(false);
    c.absorber({ type: "tool_execution_start", toolCallId: "y", toolName: "moi_finir", args: {} }, 30);
    c.absorber({ type: "tool_execution_end", toolCallId: "y", toolName: "moi_finir", result: { content: [{ type: "text", text: "session terminée : livré" }] } }, 40);
    expect(c.finiVu).toBe(true);
  });
  test("F1 : seuls moi_finir et moi_resumer arment le départ et le résumé ; les anciens noms n'arment plus rien (T14)", () => {
    const c = new Compteur();
    c.absorber({ type: "tool_execution_start", toolCallId: "a", toolName: "fini", args: {} }, 10);
    c.absorber({ type: "tool_execution_end", toolCallId: "a", toolName: "fini", result: { content: [{ type: "text", text: "session terminée : livré" }] } }, 20);
    c.absorber({ type: "tool_execution_start", toolCallId: "b", toolName: "se_resumer", args: { note: "n" } }, 30);
    c.absorber({ type: "tool_execution_end", toolCallId: "b", toolName: "se_resumer", result: { content: [{ type: "text", text: "résumé demandé" }] } }, 40);
    expect([c.finiVu, c.resumeDemande]).toEqual([false, undefined]);
    c.absorber({ type: "tool_execution_start", toolCallId: "c", toolName: "moi_resumer", args: { note: "garde le but" } }, 50);
    c.absorber({ type: "tool_execution_end", toolCallId: "c", toolName: "moi_resumer", result: { content: [{ type: "text", text: "résumé demandé" }] } }, 60);
    c.absorber({ type: "tool_execution_start", toolCallId: "d", toolName: "moi_finir", args: {} }, 70);
    c.absorber({ type: "tool_execution_end", toolCallId: "d", toolName: "moi_finir", result: { content: [{ type: "text", text: "session terminée : livré" }] } }, 80);
    expect([c.finiVu, c.resumeDemande]).toEqual([true, "garde le but"]);
  });
  test("coût absent ou nul : estimation depuis le tarif manuel", () => {
    const c = new Compteur({ entree: 1, sortie: 2 });
    c.absorber({ type: "message_end", message: { role: "assistant", stopReason: "stop", usage: { input: 1_000_000, output: 500_000, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } });
    expect(c.cout).toBeCloseTo(2, 6);
    expect(c.coutEstime).toBe(true);
    const sans = new Compteur();
    sans.absorber({ type: "message_end", message: { role: "assistant", stopReason: "stop", usage: { input: 10, output: 5 } } });
    expect(sans.cout).toBe(0);
  });
  test("tarif manuel fixé : il prime sur le prix calculé par pi (abonnement à 0, run ligne du 28/09)", () => {
    const u = { input: 1_000_000, output: 500_000, cacheRead: 0, cacheWrite: 0, cost: { total: 35 } };
    const abonnement = new Compteur({ entree: 0, sortie: 0 }, 0, true);
    abonnement.absorber({ type: "message_end", message: { role: "assistant", stopReason: "stop", usage: u } });
    abonnement.absorber({ type: "compaction_end", result: { usage: u } });
    expect(abonnement.cout).toBe(0);
    const manuel = new Compteur({ entree: 1, sortie: 2 }, 0, true);
    manuel.absorber({ type: "message_end", message: { role: "assistant", stopReason: "stop", usage: u } });
    expect(manuel.cout).toBeCloseTo(2, 6);
    const catalogue = new Compteur({ entree: 0, sortie: 0 });
    catalogue.absorber({ type: "message_end", message: { role: "assistant", stopReason: "stop", usage: u } });
    expect(catalogue.cout).toBe(35);
  });
  test("les tokens d'entrée additionnent input, cacheRead et cacheWrite", () => {
    const c = new Compteur();
    c.absorber({ type: "message_end", message: { role: "assistant", stopReason: "stop", usage: { input: 100, output: 5, cacheRead: 20, cacheWrite: 30, cost: { total: 0.01 } } } });
    expect(c.tokensEntree).toBe(150);
  });
  test("les messages non assistant et les événements sans intérêt ne produisent pas de trace mais comptent comme activité", () => {
    const c = new Compteur(undefined, 0);
    expect(c.absorber({ type: "message_end", message: { role: "user" } }, 7)).toBeUndefined();
    expect(c.absorber({ type: "turn_start" }, 8)).toBeUndefined();
    expect(c.derniereActivite).toBe(8);
    expect(c.cout).toBe(0);
  });
  test("arguments et résultat gardés jusqu'à 4 000 caractères, tronqués au-delà", () => {
    const c = new Compteur();
    const long = "x".repeat(5000);
    const s = c.absorber({ type: "tool_execution_start", toolCallId: "l", toolName: "bash", args: { command: long } })!;
    expect((s.arguments as string).length).toBe(4001);
    const e = c.absorber({ type: "tool_execution_end", toolCallId: "l", toolName: "bash", result: { content: [{ type: "text", text: long }] }, isError: false })!;
    expect(e.resultat!.length).toBe(4001);
    const court = c.absorber({ type: "tool_execution_end", toolCallId: "m", toolName: "bash", result: { content: [{ type: "text", text: "y".repeat(700) }] }, isError: false })!;
    expect(court.resultat!.length).toBe(700);
  });
  test("decaler : la veille de la machine repousse silence et outil en cours, rien d'autre", () => {
    const c = new Compteur(undefined, 1000);
    c.absorber({ type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: {} }, 2000);
    c.decaler(60_000);
    expect([c.derniereActivite, c.dernierProgres, c.outilEnCours?.depuis]).toEqual([62_000, 62_000, 62_000]);
    expect(c.absorber({ type: "tool_execution_end", toolCallId: "a", toolName: "bash", result: "ok", isError: false }, 63_000)?.dureeMs).toBe(1000);
  });
  test("reprendre : les outils ouverts d'un processus tué sont oubliés, les horloges repartent de maintenant", () => {
    const c = new Compteur(undefined, 1000);
    c.absorber({ type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: {} }, 2000);
    c.reprendre(50_000);
    expect(c.outilEnCours).toBeUndefined();
    expect([c.derniereActivite, c.dernierProgres]).toEqual([50_000, 50_000]);
    c.absorber({ type: "tool_execution_start", toolCallId: "b", toolName: "salle_poster", args: {} }, 51_000);
    c.absorber({ type: "tool_execution_end", toolCallId: "b", toolName: "salle_poster", result: "ok", isError: false }, 52_000);
    expect(c.outilEnCours).toBeUndefined(); // l'outil « a » ne revient pas
  });
});

describe("une réponse qui s'emballe (run ville, 25/09)", () => {
  const maj = (e: Record<string, unknown>): Ev => ({ type: "message_update", assistantMessageEvent: e });
  const appel = (i: number) => maj({ type: "toolcall_end", contentIndex: i, toolCall: { type: "toolCall", id: `c${i}`, name: "bash", arguments: { command: "true" } } });
  test("le même appel répété dans une réponse : emballement, tracé une seule fois (Hubert)", () => {
    const c = new Compteur();
    const traces = Array.from({ length: 40 }, (_, i) => c.absorber(appel(i), 1000 + i)).filter(Boolean);
    expect(c.emballement).toBe("30 appels identiques à bash dans une même réponse");
    expect(traces).toEqual([{ type: "emballement", resultat: "réponse emballée : 30 appels identiques à bash dans une même réponse" }]);
  });
  test("des appels différents ne sont pas un emballement", () => {
    const c = new Compteur();
    for (let i = 0; i < 60; i++) c.absorber(maj({ type: "toolcall_end", toolCall: { name: "read", arguments: { path: `f${i}.js` } } }));
    expect(c.emballement).toBeUndefined();
  });
  test("des morceaux vides à la suite dans la pensée ou le texte : emballement ; un morceau plein remet le compte à zéro", () => {
    const c = new Compteur();
    for (let i = 0; i < 299; i++) c.absorber(maj({ type: "thinking_delta", delta: "" }));
    c.absorber(maj({ type: "thinking_delta", delta: "je relis" }));
    for (let i = 0; i < 299; i++) c.absorber(maj({ type: "text_delta", delta: "" }));
    expect(c.emballement).toBeUndefined();
    c.absorber(maj({ type: "text_delta", delta: "" }));
    expect(c.emballement).toBe("300 morceaux vides à la suite");
  });
  test("les morceaux vides d'un appel d'outil ne comptent pas : MiMo les envoie pendant qu'il prépare les arguments (Lucien)", () => {
    const c = new Compteur();
    c.absorber(maj({ type: "toolcall_start" }));
    for (let i = 0; i < 1000; i++) c.absorber(maj({ type: "toolcall_delta", delta: "" }));
    c.absorber(maj({ type: "toolcall_delta", delta: "{\"fil\": \"verification\", \"texte\": \"…\"}" }));
    expect(c.emballement).toBeUndefined();
  });
  test("une pensée qui tourne en boucle : emballement", () => {
    const c = new Compteur();
    const boucle = "Je vérifie la case (19, 14) : attrait 3, pollution 0. Puis je relis la règle des étages et je reviens à la case. ".repeat(3);
    for (let i = 0; i < 12; i++) c.absorber(maj({ type: "thinking_delta", delta: boucle }));
    expect(c.emballement).toMatch(/^la même pensée revient \d+ fois de suite$/);
  });
  test("une grille ou un séparateur ne sont pas une boucle ; un mot répété sur toute la mémoire l'est (29/09, revue)", () => {
    for (const texte of ["0, ".repeat(440), "-".repeat(1200), "| 0 | 1 | 0 | 1 |\n".repeat(80)]) {
      const c = new Compteur();
      c.absorber(maj({ type: "thinking_delta", delta: texte }));
      expect(c.emballement).toBeUndefined();
    }
    const c = new Compteur();
    for (let i = 0; i < 20; i++) c.absorber(maj({ type: "thinking_delta", delta: "wait, ".repeat(100) }));
    expect(c.emballement).toMatch(/^la même pensée revient \d+ fois de suite$/);
  });
  test("une longue pensée qui avance n'est pas un emballement ; elle date le dernier morceau, pas le progrès (Jules)", () => {
    const c = new Compteur(undefined, 0);
    for (let i = 0; i < 400; i++) c.absorber(maj({ type: "thinking_delta", delta: `Étape ${i} : la forme ${i * 7} du bâtiment ${i % 13} demande ${i * 3} sommets. ` }), 1000 + i);
    expect(c.emballement).toBeUndefined();
    expect([c.reponseDepuis, c.dernierMorceau, c.dernierProgres]).toEqual([1000, 1399, 0]);
  });
  test("la fin de la réponse et une nouvelle passe oublient la réponse ; l'emballement tient jusqu'à la passe suivante", () => {
    const c = new Compteur();
    for (let i = 0; i < 30; i++) c.absorber(appel(i));
    c.absorber({ type: "message_end", message: { role: "assistant", stopReason: "toolUse", usage: {} } });
    expect([c.reponseDepuis, c.emballement]).toEqual([undefined, "30 appels identiques à bash dans une même réponse"]);
    c.nouvellePasse();
    expect(c.emballement).toBeUndefined();
    for (let i = 0; i < 29; i++) c.absorber(appel(i));
    expect(c.emballement).toBeUndefined(); // le compte repart de zéro
  });
});

describe("run réel du 21/09", () => {
  test("un message_end en erreur sans tokens ne lève pas le drapeau estimation", () => {
    const c = new Compteur({ entree: 0.75, sortie: 3.75 });
    c.absorber({ type: "message_end", message: { role: "assistant", stopReason: "toolUse", usage: { input: 2260, output: 9, cacheRead: 0, cacheWrite: 0, cost: { total: 0.00172875 } } } });
    c.absorber({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "Gemini models require OpenRouter reasoning details", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } });
    expect(c.coutEstime).toBe(false);
    expect(c.cout).toBeCloseTo(0.00172875, 8);
    expect(c.erreur).toContain("reasoning details");
  });
  test("une erreur suivie d'une réponse réussie (relance automatique de pi) ne reste pas enregistrée (29/09, revue)", () => {
    const c = new Compteur();
    c.absorber({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "429 rate limited", usage: { input: 0, output: 0 } } });
    expect(c.erreur).toBe("429 rate limited");
    c.absorber({ type: "message_end", message: { role: "assistant", stopReason: "stop", usage: { input: 100, output: 10 } } });
    expect(c.erreur).toBeUndefined();
  });
});
