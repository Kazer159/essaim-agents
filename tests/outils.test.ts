import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { cpSync, mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ouvrirBun } from "../src/tableau-bun.ts";
import * as T from "../src/tableau.ts";
import { fauxPi } from "./aide/faux-extension-api.ts";
import extension from "../src/outils-essaim.ts";
import seResumer from "../src/se-resumer.ts";
import { nomsSalle } from "../src/noms-outils.ts";
import { cheminNavigateur } from "../src/voir.ts";
import * as D from "../src/depot.ts";

let dossier: string;
let chemin: string;
let t: T.Tableau;

function instance(agent: string) {
  process.env.ESSAIM_AGENT = agent;
  process.env.ESSAIM_TABLEAU = chemin;
  process.env.ESSAIM_PARTAGE = join(dossier, "partage");
  process.env.ESSAIM_BUREAU = join(dossier, "agents", agent);
  const faux = fauxPi();
  extension(faux.api, ouvrirBun);
  return faux;
}

beforeEach(() => {
  process.env.ESSAIM_TOUR_MS = "0"; // le tour de parole du démarrage a son propre test
  dossier = mkdtempSync(join(tmpdir(), "essaim-outils-"));
  chemin = join(dossier, "tableau.sqlite");
  mkdirSync(join(dossier, "partage"));
  t = ouvrirBun(chemin);
  T.initialiser(t);
  T.ouvrirRun(t, { id: "run-test", missionChemin: "m.md", missionTexte: "texte", modele: "faux/faux", plafondUsd: 0.5, silenceMin: 15 });
  T.ajouterAgent(t, "agent-01", join(dossier, "agents", "agent-01"));
  T.ajouterAgent(t, "agent-02", join(dossier, "agents", "agent-02"));
});
afterEach(() => {
  delete process.env.ESSAIM_TOUR_MS;
  t.fermer();
  rmSync(dossier, { recursive: true, force: true });
});

describe("chargement", () => {
  test("les outils sont enregistrés et le pid inscrit", () => {
    const pi = instance("agent-01");
    expect(pi.noms().sort()).toEqual(nomsSalle(false).sort());
    expect(t.get<{ pid: number }>("SELECT pid FROM agents WHERE nom='agent-01'")?.pid).toBe(process.pid);
  });
  test("avec le compactage, les outils enregistrés sont ceux de nomsSalle(true)", () => {
    const pi = instance("agent-01");
    const avant = process.env.ESSAIM_COMPACTAGE;
    process.env.ESSAIM_COMPACTAGE = "80000,120000,160000";
    try { seResumer(pi.api); } finally { if (avant === undefined) delete process.env.ESSAIM_COMPACTAGE; else process.env.ESSAIM_COMPACTAGE = avant; }
    expect(pi.noms().sort()).toEqual(nomsSalle(true).sort());
  });
  test("sous ESSAIM_MEMOIRE=non (run témoin), salle_chercher n'est pas enregistré : nomsSalle(false, false)", () => {
    process.env.ESSAIM_MEMOIRE = "non";
    try {
      expect(instance("agent-01").noms().sort()).toEqual(nomsSalle(false, false).sort());
    } finally { delete process.env.ESSAIM_MEMOIRE; }
    expect(instance("agent-01").noms()).toContain("salle_chercher");
  });
  // Les agents n'ont plus d'outil de fil ; moi_dormir perd reveil_fil, qui ne servait qu'à un agent entré.
  test("aucun outil de fil : ni fil_entrer, ni fil_quitter, ni fil_historique ; moi_dormir sans reveil_fil", () => {
    const pi = instance("agent-01");
    for (const n of ["fil_entrer", "fil_quitter", "fil_historique"]) expect(pi.definition(n)).toBeUndefined();
    expect(Object.keys((pi.definition("moi_dormir")!.parameters as { properties: Record<string, unknown> }).properties)).toEqual(["message", "attend"]);
  });
  test("le faux pi valide le schéma comme pi (G7) : champ requis manquant = erreur de schéma, nombre écrit en texte converti", async () => {
    const pi = instance("agent-01");
    expect(pi.appeler("salle_poster", {})).rejects.toThrow('Validation failed for tool "salle_poster"');
    expect(T.boite(t, "lecteur").messages).toHaveLength(0);
    expect(await pi.texte("salle_attendre", { secondes: "0" })).toBe("0 s d'attente, rien de nouveau");
  });
  describe("le faux ExtensionAPI enchaîne les gestionnaires comme pi (R19, runner.js:693-723, 745-763, 974-1006)", () => {
    // Une petite extension de test : un outil « echo » qui rend son texte, et qui compte ses exécutions.
    const echo = (pi: ReturnType<typeof fauxPi>, attente?: Promise<void>) => {
      const faites: string[] = [];
      (pi.api as { registerTool: (d: unknown) => void }).registerTool({
        name: "echo", label: "echo", description: "rend son texte", parameters: { type: "object", properties: { x: { type: "string" } }, required: ["x"] },
        execute: async (id: string, p: { x: string }) => {
          faites.push(id);
          if (attente) await attente;
          if (p.x === "panne") throw new Error("echo en panne");
          return { content: [{ type: "text", text: p.x }], details: {} };
        },
      });
      return faites;
    };
    const on = (pi: ReturnType<typeof fauxPi>, nom: string, h: (ev: never) => unknown) =>
      (pi.api as { on: (n: string, h: unknown) => void }).on(nom, h);

    test("deux extensions qui ajoutent chacune une ligne au résultat : les deux, dans l'ordre de chargement", async () => {
      const pi = fauxPi();
      echo(pi);
      const vus: string[][] = [];
      for (const marque of ["[a]", "[b]"])
        on(pi, "tool_result", (ev: { content: Array<{ text?: string }> }) => {
          vus.push(ev.content.map((c) => c.text ?? ""));
          return { content: [...ev.content, { type: "text", text: marque }] };
        });
      expect(await pi.texte("echo", { x: "bonjour" })).toBe("bonjour\n[a]\n[b]");
      expect(vus).toEqual([["bonjour"], ["bonjour", "[a]"]]); // chaque gestionnaire reçoit le contenu déjà complété
      // emettre("tool_result") enchaîne de même, et rend undefined quand rien n'a changé (comme emitToolResult)
      const r = await pi.emettre("tool_result", { type: "tool_result", toolName: "read", content: [{ type: "text", text: "c" }] }) as { content: Array<{ text: string }> };
      expect(r.content.map((c) => c.text)).toEqual(["c", "[a]", "[b]"]);
      expect(await fauxPi().emettre("tool_result", { type: "tool_result", toolName: "read", content: [] })).toBeUndefined();
    });

    test("avec la vraie extension se-resumer chargée d'abord : sa ligne [contexte], puis celle de l'extension suivante", async () => {
      const pi = fauxPi();
      echo(pi);
      process.env.ESSAIM_COMPACTAGE = "80000,120000,160000";
      try { seResumer(pi.api); } finally { delete process.env.ESSAIM_COMPACTAGE; }
      on(pi, "tool_result", (ev: { content: unknown[] }) => ({ content: [...ev.content, { type: "text", text: "[salle] suite" }] }));
      pi.regler(90_000);
      const r = (await pi.texte("echo", { x: "ok" })).split("\n");
      expect(r[0]).toBe("ok");
      expect(r[1]).toStartWith("[contexte] 90k tokens");
      expect(r[2]).toBe("[salle] suite");
    });

    test("un tool_call qui bloque rend le résultat d'erreur de pi (reason), sans exécuter l'outil ni émettre tool_result", async () => {
      const pi = fauxPi();
      const faites = echo(pi);
      const vus: string[] = [];
      on(pi, "tool_call", () => undefined);
      on(pi, "tool_call", (ev: { toolName: string }) => (ev.toolName === "echo" ? { block: true, reason: "refusé : bloqué. Se lève plus tard." } : undefined));
      on(pi, "tool_call", () => { vus.push("après le blocage"); return undefined; }); // le premier block arrête
      on(pi, "tool_result", () => { vus.push("tool_result"); return undefined; });
      expect(pi.appeler("echo", { x: "a" })).rejects.toThrow("refusé : bloqué. Se lève plus tard.");
      await Bun.sleep(0);
      expect(faites).toEqual([]);
      expect(vus).toEqual([]);
      // emettre("tool_call") : le premier block, comme emitToolCall
      expect(await pi.emettre("tool_call", { type: "tool_call", toolName: "echo", input: {} })).toEqual({ block: true, reason: "refusé : bloqué. Se lève plus tard." });
    });

    test("un outil en panne : tool_result reçoit l'erreur (isError), et l'appel rejette avec le texte final", async () => {
      const pi = fauxPi();
      echo(pi);
      const vus: unknown[] = [];
      on(pi, "tool_result", (ev: { isError: boolean; content: Array<{ text?: string }> }) => { vus.push([ev.isError, ev.content[0]?.text]); return undefined; });
      expect(pi.appeler("echo", { x: "panne" })).rejects.toThrow("echo en panne");
      await Bun.sleep(0);
      expect(vus).toEqual([[true, "echo en panne"]]);
    });

    test("deux appels lancés ensemble : deux identifiants, les mêmes pour tool_call, execute et tool_result ; ou l'identifiant donné", async () => {
      const pi = fauxPi();
      let lacher!: () => void;
      const faites = echo(pi, new Promise<void>((r) => { lacher = r; }));
      const appels: string[] = [], resultats: Array<[string, string]> = [];
      on(pi, "tool_call", (ev: { toolCallId: string }) => { appels.push(ev.toolCallId); return undefined; });
      on(pi, "tool_result", (ev: { toolCallId: string; input: { x: string } }) => { resultats.push([ev.toolCallId, ev.input.x]); return undefined; });
      const a = pi.appeler("echo", { x: "un" }), b = pi.appeler("echo", { x: "deux" }, { id: "donne-7" });
      await Bun.sleep(0);
      lacher();
      await Promise.all([a, b]);
      expect(appels).toEqual(["appel-1", "donne-7"]);
      expect(faites).toEqual(["appel-1", "donne-7"]);
      expect(resultats.sort()).toEqual([["appel-1", "un"], ["donne-7", "deux"]]);
      await pi.appeler("echo", { x: "trois" });
      expect(appels.at(-1)).toBe("appel-2");
    });

    test("saisir enchaîne les gestionnaires input : transform enchaîné, handled arrête, rien = texte inchangé", async () => {
      const pi = fauxPi();
      expect(await pi.saisir("REPRISE")).toBe("REPRISE");
      const vus: unknown[] = [];
      on(pi, "input", (ev: { type: string; text: string; source: string }) => { vus.push([ev.type, ev.text, ev.source]); return { action: "transform", text: ev.text + "\n\n[salle] état" }; });
      on(pi, "input", () => ({ action: "continue" }));
      on(pi, "input", (ev: { text: string }) => { vus.push(ev.text); return undefined; });
      expect(await pi.saisir("REPRISE")).toBe("REPRISE\n\n[salle] état");
      expect(vus).toEqual([["input", "REPRISE", "interactive"], "REPRISE\n\n[salle] état"]);
      const p2 = fauxPi();
      on(p2, "input", () => ({ action: "handled" }));
      on(p2, "input", () => { throw new Error("jamais appelé"); });
      expect(await p2.saisir("x")).toBeUndefined();
    });
  });

  test("sans ESSAIM_AGENT ou ESSAIM_TABLEAU, l'extension refuse de démarrer", () => {
    process.env.ESSAIM_AGENT = "";
    process.env.ESSAIM_TABLEAU = chemin;
    expect(() => extension(fauxPi().api, ouvrirBun)).toThrow("ESSAIM_AGENT et ESSAIM_TABLEAU sont obligatoires");
  });
});

describe("poster, boite, equipe", () => {
  test("poster écrit en base et renvoie l'id", async () => {
    const pi = instance("agent-01");
    expect(await pi.texte("salle_poster", { texte: "bonjour" })).toContain("message 1 posté dans principal");
    expect(t.get<{ texte: string; auteur: string }>("SELECT texte, auteur FROM messages WHERE id=1")).toEqual({ texte: "bonjour", auteur: "agent-01" });
    expect(await pi.texte("salle_poster", { texte: "idée", fil: "design" })).toContain("message 2 posté dans design");
  });
  test("boite : les nouveaux messages, puis rien de nouveau, puis ceux des autres", async () => {
    const pi = instance("agent-01");
    await pi.texte("salle_poster", { texte: "bonjour" });
    expect(await pi.texte("salle_lire", {})).toContain("agent-01 : bonjour");
    expect(await pi.texte("salle_lire", {})).toBe("rien de nouveau");
    T.poster(t, "agent-02", "salut de 02");
    const b = await pi.texte("salle_lire", {});
    expect(b).toContain("[principal]");
    expect(b).toContain("agent-02 : salut de 02");
    expect(b).not.toContain("il en reste");
  });
  test("le premier message attend celui d'avant, puis passe outre au bout du délai", async () => {
    process.env.ESSAIM_TOUR_MS = "90000";
    const a2 = instance("agent-02");
    const refus = await a2.texte("salle_poster", { texte: "mon plan à moi" });
    expect(refus).toContain("refusé");
    expect(refus).toContain("agent-01");
    expect(T.boite(t, "lecteur").messages).toHaveLength(0); // rien n'a été posté

    const a1 = instance("agent-01");                        // le premier de la liste ouvre le bal
    expect(await a1.texte("salle_poster", { texte: "le but" })).toContain("posté");
    process.env.ESSAIM_AGENT = "agent-02";
    expect(await a2.texte("salle_poster", { texte: "d'accord, je prends la suite" })).toContain("posté");

    process.env.ESSAIM_TOUR_MS = "0";                       // délai écoulé : on parle sans attendre
    T.ajouterAgent(t, "agent-03", join(dossier, "agents", "agent-03"));
    T.ajouterAgent(t, "agent-04", join(dossier, "agents", "agent-04"));
    const a4 = instance("agent-04");
    expect(await a4.texte("salle_poster", { texte: "agent-03 se tait, je parle" })).toContain("posté");
  });
  test("après son premier message, on attend que la moitié de la salle ait parlé (25/09)", async () => {
    process.env.ESSAIM_QUORUM_MS = "60000";
    try {
      for (const n of ["agent-03", "agent-04", "agent-05", "agent-06"]) T.ajouterAgent(t, n, join(dossier, "agents", n));
      const a1 = instance("agent-01");
      let rendu = false;
      const attente = a1.texte("salle_poster", { texte: "le but" }).then((r) => { rendu = true; return r; });
      await Bun.sleep(300);
      expect(rendu).toBe(false); // 1 sur 6 : l'outil ne rend pas la main
      T.poster(t, "agent-02", "la répartition");
      await Bun.sleep(300);
      expect(rendu).toBe(false); // 2 sur 6 : toujours pas
      T.poster(t, "agent-03", "le filet");
      const r = await attente; // 3 sur 6 : la moitié
      expect(r.split("\n")[0]).toMatch(/^message \d+ posté dans principal ; la moitié de la salle a parlé \(3 sur 6\)$/);
      expect(r).not.toContain("avant de continuer");
      expect(r).toContain("agent-02 : la répartition"); // les messages suivent
      process.env.ESSAIM_AGENT = "agent-01";
      expect(await a1.texte("salle_poster", { texte: "deuxième" })).toBe(`message ${T.boite(t, "lecteur").messages.at(-1)!.id} posté dans principal`); // le deuxième n'attend plus
    } finally {
      delete process.env.ESSAIM_QUORUM_MS;
    }
  });
  test("l'attente de la moitié a un délai de secours : une salle muette ne bloque pas", async () => {
    process.env.ESSAIM_QUORUM_MS = "400";
    try {
      for (const n of ["agent-03", "agent-04"]) T.ajouterAgent(t, n, join(dossier, "agents", n));
      const debut = Date.now();
      expect((await instance("agent-01").texte("salle_poster", { texte: "seul" })).split("\n")[0]).toMatch(/^message \d+ posté dans principal ; délai d'attente écoulé, 1 sur 4 ont parlé$/);
      expect(Date.now() - debut).toBeGreaterThanOrEqual(350);
    } finally {
      delete process.env.ESSAIM_QUORUM_MS;
    }
  });
  test("attendre patiente puis lit la boîte, et plafonne à 60 s", async () => {
    const a1 = instance("agent-01");
    const a2 = instance("agent-02");
    expect(await a1.texte("salle_attendre", { secondes: 0 })).toBe("0 s d'attente, rien de nouveau");
    await a2.texte("salle_poster", { texte: "fichier libéré" });
    const debut = Date.now();
    expect(await a1.texte("salle_attendre", { secondes: 0.05 })).toMatch(/^\[principal\] .* agent-02 : fichier libéré$/);
    expect(Date.now() - debut).toBeGreaterThanOrEqual(45);
    expect(await a1.texte("salle_attendre", { secondes: 0 })).toBe("0 s d'attente, rien de nouveau"); // la lecture a été comptée
    const d = a1.definition("salle_attendre")!;
    expect((d.parameters as { properties: { secondes: { description: string } } }).properties.secondes.description).toContain("60 au plus");
  });
  test("boite signale le reste au-delà de 50", async () => {
    const pi = instance("agent-01");
    for (let i = 0; i < 51; i++) T.poster(t, "agent-02", `m${i}`);
    expect(await pi.texte("salle_lire", {})).toContain("(il en reste : salle_lire rend la suite)");
  });
  test("equipe liste les agents", async () => {
    const pi = instance("agent-01");
    const e = await pi.texte("salle_equipe", {});
    expect(e).toContain("agent-01 · actif");
    expect(e).toContain("agent-02 · actif");
  });
});

describe("les questions sans réponse en tête de boite (25/09)", () => {
  test("boite et attendre rappellent la question qui nomme l'agent, jusqu'à ce qu'il réponde dans son fil", async () => {
    const pi = instance("agent-01");
    T.poster(t, "agent-02", "agent-01, tu prends les tests de la caisse ?", "q-caisse");
    const b = await pi.texte("salle_lire", {});
    expect(b.startsWith("Questions qui te sont adressées, sans réponse de toi dans leur fil :\n- [q-caisse] message 1, agent-02 : agent-01, tu prends les tests de la caisse ?")).toBe(true);
    expect(b).toContain("agent-02 : agent-01, tu prends"); // le message lui-même, lu
    expect(await pi.texte("salle_lire", {})).toContain("[q-caisse] message 1"); // lu, mais toujours sans réponse
    await pi.texte("salle_poster", { texte: "oui, je les prends", fil: "q-caisse" });
    expect(await pi.texte("salle_lire", {})).not.toContain("Questions qui te sont adressées");
  });
});

describe("surnom, pancartes, budget, fini", () => {
  test("surnom écrit et equipe l'affiche", async () => {
    const pi = instance("agent-01");
    expect(await pi.texte("salle_surnom", { surnom: "Pélican" })).toContain("Pélican");
    expect(await pi.texte("salle_equipe", {})).toContain("agent-01 (Pélican)");
  });

  test("pancartes : pose, conflit entre deux agents, hors périmètre, libération", async () => {
    const un = instance("agent-01");
    const deux = instance("agent-02");
    expect(await un.texte("fichier_reclamer", { chemin: "pelican.svg", raison: "brouillon" })).toBe("pancarte posée sur pelican.svg");
    const conflit = await deux.texte("fichier_reclamer", { chemin: "pelican.svg", raison: "moi aussi" });
    expect(conflit).toStartWith("refusé : agent-01 a une pancarte sur ce fichier depuis ");
    expect(conflit).toEndWith(". Se lève quand agent-01 la retire.");
    expect(await un.texte("fichier_reclamer", { chemin: "../secret", raison: "x" })).toBe("refusé : ../secret est hors du dossier partagé. Définitif pour ce chemin.");
    expect(await un.texte("fichier_reclamer", { chemin: "pelican.svg", raison: "encore" })).toStartWith("refusé : tu as déjà une pancarte sur ce fichier depuis ");
    expect(await un.texte("fichier_pancartes", {})).toContain("pelican.svg · agent-01 · brouillon");
    expect(await deux.texte("fichier_liberer", { chemin: "pelican.svg" })).toBe("aucune pancarte à toi sur pelican.svg");
    expect(await un.texte("fichier_liberer", { chemin: "pelican.svg" })).toBe("pancarte retirée de pelican.svg");
    expect(await un.texte("fichier_pancartes", {})).toBe("aucune pancarte");
    expect(await deux.texte("fichier_reclamer", { chemin: "pelican.svg", raison: "à moi" })).toBe("pancarte posée sur pelican.svg");
  });

  test("budget", async () => {
    const pi = instance("agent-01");
    expect(await pi.texte("salle_budget", {})).toBe("dépensé 0,0000 $ sur 0,50 $, reste 0,5000 $ ; rien dépensé sur les 30 dernières minutes (une pause fait baisser le rythme) (estimation)");
    T.majAgent(t, "agent-02", { coutUsd: 0.1234 });
    expect(await pi.texte("salle_budget", {})).toBe("dépensé 0,1234 $ sur 0,50 $, reste 0,3766 $ ; rien dépensé sur les 30 dernières minutes (une pause fait baisser le rythme) (estimation)");
  });

  test("fini termine la session et passe l'agent en fini", async () => {
    const pi = instance("agent-01");
    const r = await pi.appeler("moi_finir", { raison: "définition atteinte", fichier: "pelican.svg" });
    expect(r.terminate).toBe(true);
    expect(r.content[0]!.text).toContain("session terminée : définition atteinte");
    const a = t.get<Record<string, unknown>>("SELECT etat, raison_sortie, fichier_livre FROM agents WHERE nom='agent-01'");
    expect(a).toEqual({ etat: "fini", raison_sortie: "définition atteinte", fichier_livre: "pelican.svg" });
  });

  test("fini refuse tant que le livrable déclaré n'est pas sain, et laisse partir quand il l'est", async () => {
    const pi = instance("agent-01");
    const partage = process.env.ESSAIM_PARTAGE!;
    const avant = process.env.ESSAIM_LIVRABLE;
    process.env.ESSAIM_LIVRABLE = "livrable.html";
    try {
      // Une page dont une règle de style ne touche rien : `voir` rend 1, la salle garde l'agent.
      await Bun.write(join(partage, "livrable.html"), '<!doctype html><title>L</title><style>.absente { color: red; }</style><p>bonjour</p>');
      const refus = await pi.appeler("moi_finir", { raison: "fini quand même" });
      expect(refus.terminate).toBeUndefined();
      expect(refus.content[0]!.text).toContain("refusé");
      expect(refus.content[0]!.text).toContain(".absente");
      expect(t.get<Record<string, unknown>>("SELECT etat FROM agents WHERE nom='agent-01'")!.etat).not.toBe("fini");
      // Corrigée, la même page laisse partir.
      await Bun.write(join(partage, "livrable.html"), '<!doctype html><title>L</title><style>p { color: red; }</style><p>bonjour</p>');
      const ok = await pi.appeler("moi_finir", { raison: "livré" });
      expect(ok.terminate).toBe(true);
      expect(t.get<Record<string, unknown>>("SELECT etat FROM agents WHERE nom='agent-01'")!.etat).toBe("fini");
    } finally {
      if (avant === undefined) delete process.env.ESSAIM_LIVRABLE; else process.env.ESSAIM_LIVRABLE = avant;
    }
  }, 60_000);

  test("fini refuse un livrable absent (Q1, G14) ; une panne du navigateur ne retient personne", async () => {
    const partage = process.env.ESSAIM_PARTAGE = join(dossier, "partage");
    const avant = { livrable: process.env.ESSAIM_LIVRABLE, cache: process.env.PLAYWRIGHT_BROWSERS_PATH };
    process.env.ESSAIM_LIVRABLE = "index.html";
    try {
      const pi = instance("agent-01");
      const refus = await pi.appeler("moi_finir", { raison: "livré" });
      expect(refus.terminate).toBeUndefined();
      expect(refus.content[0]!.text).toBe("refusé : le livrable index.html est absent du dossier partagé. Se lève quand il existe et s'ouvre sans erreur.");
      expect(t.get<{ etat: string }>("SELECT etat FROM agents WHERE nom='agent-01'")!.etat).toBe("actif");
      await Bun.write(join(partage, "index.html"), "<!doctype html><title>L</title><p>bonjour</p>");
      process.env.PLAYWRIGHT_BROWSERS_PATH = join(dossier, "cache-vide"); // navigateur absent : panne, pas un refus
      const ok = await pi.appeler("moi_finir", { raison: "livré" });
      expect(ok.terminate).toBe(true);
    } finally {
      if (avant.livrable === undefined) delete process.env.ESSAIM_LIVRABLE; else process.env.ESSAIM_LIVRABLE = avant.livrable;
      if (avant.cache === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH; else process.env.PLAYWRIGHT_BROWSERS_PATH = avant.cache;
    }
  });
  test.skipIf(cheminNavigateur() === undefined)("fini laisse partir quand le livrable existe et s'ouvre sans erreur (Q1)", async () => {
    const partage = process.env.ESSAIM_PARTAGE = join(dossier, "partage");
    const avant = process.env.ESSAIM_LIVRABLE;
    process.env.ESSAIM_LIVRABLE = "index.html";
    try {
      await Bun.write(join(partage, "index.html"), "<!doctype html><title>L</title><p>bonjour</p>");
      expect((await instance("agent-01").appeler("moi_finir", { raison: "livré" })).terminate).toBe(true);
    } finally {
      if (avant === undefined) delete process.env.ESSAIM_LIVRABLE; else process.env.ESSAIM_LIVRABLE = avant;
    }
  }, 60_000);

  test("chaque outil porte un promptSnippet d'une ligne en français", () => {
    const pi = instance("agent-01");
    for (const nom of pi.noms()) {
      const d = pi.definition(nom)!;
      expect(typeof d.promptSnippet).toBe("string");
      expect(d.promptSnippet!.length).toBeGreaterThan(10);
      expect(d.promptSnippet).not.toContain("\n");
    }
  });
});

describe("voir", () => {
  test("une page absente ou hors de partage/ : un refus, pas une erreur d'outil (G7)", async () => {
    const pi = instance("agent-01");
    expect(await pi.texte("page_voir", { page: "absente.html" })).toBe("refusé : absente.html est introuvable dans le dossier partagé. Se lève quand le fichier existe.");
    expect(await pi.texte("page_voir", { page: "../tableau.sqlite" })).toBe("refusé : ../tableau.sqlite est hors du dossier partagé. Définitif pour ce chemin.");
  });
  test.skipIf(cheminNavigateur() === undefined)("une page saine de partage/ : « page_voir : 0 », un résultat, pas une erreur", async () => {
    cpSync(new URL("./fixtures/voir/saine.html", import.meta.url).pathname, join(dossier, "partage", "saine.html"));
    const pi = instance("agent-01");
    const r = await pi.texte("page_voir", { page: "saine.html" });
    expect(r).toContain("page_voir : 0 page saine");
    expect(r).toContain("bonjour");
  });
});

describe("code_tester (B1, T6)", () => {
  test("sans detail, le bilan et les noms ; avec detail, le détail de chaque échec", async () => {
    writeFileSync(join(dossier, "partage", "a.test.ts"), 'import { test, expect } from "bun:test";\ntest("la caisse de 1997", () => expect(229).toBe(319));\n');
    const pi = instance("agent-01");
    const bref = await pi.texte("code_tester", { fichier: "a.test.ts" });
    expect(bref).toMatch(/^0 réussi · 1 échoué · \d+,\d+ s\n\(fail\) la caisse de 1997$/);
    expect(await pi.texte("code_tester", { fichier: "a.test.ts", detail: true })).toContain("Expected: 319");
  }, 60_000);
});

describe("le dépôt du run : restaurer, essai, adopter (A7)", () => {
  let partage: string, arreter: () => void, surs: D.Surs;
  const ecrire = (f: string, c: string, racine = partage) => writeFileSync(join(racine, f), c);
  const dernier = async (d = partage) => (await D.historique(d, { limite: 1 }))[0]!;
  const messages = () => t.all<{ auteur: string; texte: string }>("SELECT auteur, texte FROM messages ORDER BY id");
  beforeEach(async () => {
    partage = join(dossier, "partage");
    await D.ouvrirDepot(partage);
    surs = new Map([[partage, D.identite(partage)!]]);
    arreter = D.servirDemandes(t, dossier, new D.FileGit(), surs, 20); // le rôle du lanceur
  });
  afterEach(() => arreter());

  test("restaurer ne remet qu'un fichier à sa version d'avant, et l'annonce dans le fil", async () => {
    ecrire("index.html", "v1\n");
    await D.commiter(partage, "agent-02", "write index.html");
    const v1 = (await dernier()).hash;
    ecrire("index.html", "v2 cassée\n");
    await D.commiter(partage, "agent-02", "edit index.html");
    ecrire("moteur.js", "travail d'agent-02\n");
    await D.commiter(partage, "agent-02", "write moteur.js");
    const r = await instance("agent-01").texte("depot_restaurer", { chemin: join(partage, "index.html"), commit: v1, raison: "la v2 casse la page" });
    expect(r).toContain(`index.html restauré à ${v1}`);
    expect(readFileSync(join(partage, "index.html"), "utf8")).toBe("v1\n");
    expect(readFileSync(join(partage, "moteur.js"), "utf8")).toBe("travail d'agent-02\n");
    expect(await dernier()).toMatchObject({ auteur: "agent-01", fichiers: ["index.html"] });
    expect(messages().at(-1)).toMatchObject({ auteur: "agent-01", texte: expect.stringContaining(`[restauré] index.html revient à sa version du commit ${v1}`) });
  });
  test("restaurer est refusé sous la pancarte d'un autre, et pour un commit inconnu", async () => {
    ecrire("index.html", "v1\n");
    await D.commiter(partage, "agent-02", "write index.html");
    const v1 = (await dernier()).hash;
    T.reclamer(t, "agent-02", "index.html", "je refais l'en-tête");
    const pi = instance("agent-01");
    expect(await pi.texte("depot_restaurer", { chemin: "index.html", commit: v1, raison: "x" })).toContain("porte la pancarte de agent-02");
    expect(await pi.texte("depot_restaurer", { chemin: "autre.html", commit: "deadbee", raison: "x" })).toBe("refusé : commit deadbee inconnu. Définitif pour ce commit.");
  });
  test("essai puis adoption : un dossier à part, puis la fusion dans le dossier commun, annoncées dans le fil", async () => {
    ecrire("moteur.js", "commun\n");
    await D.commiter(partage, "agent-02", "write");
    const pi = instance("agent-01");
    const r = await pi.texte("depot_essai", { nom: "moteur-three", raison: "essayer three.js" });
    const d = join(dossier, "essais", "moteur-three");
    expect(r).toContain(`ton dossier est ${d}`);
    expect(surs.has(d)).toBe(true);
    ecrire("moteur.js", "three\n", d);
    await D.commiter(d, "agent-01", "write moteur.js"); // le lanceur l'aurait fait à la fin du write
    expect(readFileSync(join(partage, "moteur.js"), "utf8")).toBe("commun\n");
    expect(await pi.texte("depot_adopter", { nom: "moteur-three" })).toContain("essai moteur-three adopté");
    expect(readFileSync(join(partage, "moteur.js"), "utf8")).toBe("three\n");
    expect(T.essais(t)).toEqual([expect.objectContaining({ nom: "moteur-three", auteur: "agent-01", raison: "essayer three.js", adopte_par: "agent-01" })]);
    expect(messages().map((m) => m.texte.slice(0, 9))).toEqual(["[essai] j", "[adopté] "]);
  });
  test("une demande servie après l'attente de l'agent est quand même annoncée, refus compris, par la salle (29/09, revue F15)", async () => {
    arreter(); // le lanceur est occupé : il ne sert la file qu'après l'abandon de l'agent
    process.env.ESSAIM_DEMANDE_MS = "50";
    try {
      const pi = instance("agent-01");
      expect(await pi.texte("depot_essai", { nom: "tardif", raison: "essayer" })).toContain("n'a pas répondu");
      expect(await pi.texte("depot_adopter", { nom: "inconnu" })).toContain("n'a pas répondu");
      arreter = D.servirDemandes(t, dossier, new D.FileGit(), surs, 20);
      const d = join(dossier, "essais", "tardif");
      for (let i = 0; i < 100 && messages().length < 2; i++) await Bun.sleep(20);
      expect(messages()).toEqual([
        { auteur: "agent-01", texte: `[essai] j'ouvre l'essai tardif dans ${d} : essayer` },
        { auteur: "essaim", texte: expect.stringMatching(/^agent-01 : ta demande depot_adopter inconnu, faite après ton attente, est refusée : /) }]);
    } finally { delete process.env.ESSAIM_DEMANDE_MS; }
  });
  test("adoption refusée sur conflit : les fichiers sont nommés, le dossier commun n'a pas bougé", async () => {
    ecrire("moteur.js", "commun\n");
    await D.commiter(partage, "agent-02", "write");
    const pi = instance("agent-01");
    await pi.texte("depot_essai", { nom: "x", raison: "r" });
    ecrire("moteur.js", "three\n", join(dossier, "essais", "x"));
    ecrire("moteur.js", "babylon\n");
    await D.commiter(partage, "agent-02", "write moteur.js");
    expect(await pi.texte("depot_adopter", { nom: "x" })).toBe("refusé : conflit sur moteur.js, le dossier commun n'a pas bougé. Se lève quand l'essai ne contredit plus ces lignes.");
    expect(readFileSync(join(partage, "moteur.js"), "utf8")).toBe("babylon\n");
  });
  test("sans réponse de la salle, l'outil le dit au lieu d'attendre sans fin", async () => {
    arreter();
    process.env.ESSAIM_DEMANDE_MS = "100";
    try {
      expect(await instance("agent-01").texte("depot_essai", { nom: "x", raison: "r" })).toContain("la salle n'a pas répondu");
    } finally {
      delete process.env.ESSAIM_DEMANDE_MS;
    }
  });
  test.skipIf(cheminNavigateur() === undefined)("voir ouvre une page d'essai, avec l'essai pour racine", async () => {
    const pi = instance("agent-01");
    await pi.texte("depot_essai", { nom: "x", raison: "r" });
    const d = join(dossier, "essais", "x");
    cpSync(new URL("./fixtures/voir/saine.html", import.meta.url).pathname, join(d, "saine.html"));
    expect(await pi.texte("page_voir", { page: join(d, "saine.html") })).toContain("page_voir : 0 page saine");
  });
});

describe("depot_journal (B2, G12, T7)", () => {
  let partage: string;
  beforeEach(async () => {
    partage = join(dossier, "partage");
    await D.ouvrirDepot(partage);
  });
  const ligne = /^[0-9a-f]{7,} \d\d:\d\d \S+ .+$/;

  test("une ligne par commit : hash court, heure, auteur, première ligne du message, du plus récent au plus ancien", async () => {
    writeFileSync(join(partage, "simu.js"), "1");
    await D.commiter(partage, "Bernard", "write simu.js\n\ndeuxième ligne");
    const lignes = (await instance("agent-01").texte("depot_journal", {})).split("\n");
    expect(lignes).toHaveLength(2);
    expect(lignes.every((l) => ligne.test(l))).toBe(true);
    expect(lignes[0]).toMatch(/ Bernard write simu\.js$/);
    expect(lignes[1]).toMatch(/ essaim ouverture du run$/);
    const [h, m] = [new Date().getHours(), new Date().getMinutes()];
    expect(lignes[0]!.split(" ")[1]).toMatch(/^\d\d:\d\d$/);
    expect(Math.abs(Number(lignes[0]!.split(" ")[1]!.slice(0, 2)) * 60 + Number(lignes[0]!.split(" ")[1]!.slice(3)) - (h * 60 + m)) % (24 * 60)).toBeLessThan(2);
  });
  test("chemin relatif ou absolu dans le dossier partagé ; jamais commité : « aucun commit pour » ; hors du dossier : refus", async () => {
    writeFileSync(join(partage, "simu.js"), "1");
    await D.commiter(partage, "Bernard", "write simu.js");
    writeFileSync(join(partage, "autre.js"), "2");
    await D.commiter(partage, "Claire", "write autre.js");
    const pi = instance("agent-01");
    expect(await pi.texte("depot_journal", { chemin: "simu.js" })).toMatch(/^[0-9a-f]{7,} \d\d:\d\d Bernard write simu\.js$/);
    expect(await pi.texte("depot_journal", { chemin: join(partage, "simu.js") })).toMatch(/ Bernard write simu\.js$/);
    expect(await pi.texte("depot_journal", { chemin: "jamais.js" })).toBe("aucun commit pour jamais.js");
    expect(await pi.texte("depot_journal", { chemin: "../tableau.sqlite" })).toBe("refusé : ../tableau.sqlite est hors du dossier partagé. Définitif pour ce chemin.");
  });
  test("nombre : 10 par défaut, 50 au plus, ramené et dit ; 0 rejeté par le schéma", async () => {
    for (let i = 0; i < 55; i++) await D.git(partage, ["commit", "-q", "--allow-empty", "-m", `vide ${i}`]);
    const pi = instance("agent-01");
    expect((await pi.texte("depot_journal", {})).split("\n")).toHaveLength(10);
    const quatreVingts = (await pi.texte("depot_journal", { nombre: 80 })).split("\n");
    expect(quatreVingts[0]).toBe("nombre ramené à 50");
    expect(quatreVingts.slice(1)).toHaveLength(50);
    expect((await pi.texte("depot_journal", { nombre: 3 })).split("\n")).toHaveLength(3);
    expect(pi.appeler("depot_journal", { nombre: 0 })).rejects.toThrow('Validation failed for tool "depot_journal"');
  }, 30_000);
  test("une panne git est une erreur d'outil, pas une liste vide", async () => {
    rmSync(join(partage, ".git"), { recursive: true, force: true });
    expect(instance("agent-01").appeler("depot_journal", {})).rejects.toThrow("depot_journal : le dépôt du run est en panne");
  });
});

describe("tickets (A7)", () => {
  let partage: string, arreter: () => void, surs: D.Surs;
  const fil = () => t.all<{ auteur: string; texte: string }>("SELECT m.auteur, m.texte FROM messages m JOIN fils f ON f.id = m.fil_id WHERE f.nom = 'tickets' ORDER BY m.id");
  beforeEach(async () => {
    partage = join(dossier, "partage");
    await D.ouvrirDepot(partage);
    surs = new Map([[partage, D.identite(partage)!]]);
    arreter = D.servirDemandes(t, dossier, new D.FileGit(), surs, 20);
  });
  afterEach(() => arreter());

  test("ouvrir un bug confié à un autre : posté dans le fil tickets, le chargé est nommé", async () => {
    const r = await instance("agent-01").texte("ticket_ouvrir", { type: "bug", titre: "la carte reste vide", description: "index.html, bouton Carte", charge: "agent-02" });
    expect(r).toBe("ticket #1 ouvert, posté dans le fil tickets");
    expect(fil()).toEqual([{ auteur: "agent-01", texte: "[ticket #1 · bug] la carte reste vide — confié à agent-02 : index.html, bouton Carte" }]);
    expect(T.nomme(fil()[0]!.texte, "agent-02")).toBe(true); // ce qui réveille un dormeur
  });
  test("fermer un bug : refusé sans commit, refusé sur un commit d'essai non adopté, accepté sur un commit du dossier commun", async () => {
    const pi = instance("agent-02");
    await pi.texte("ticket_ouvrir", { type: "bug", titre: "carte vide", description: "index.html" });
    expect(await pi.texte("ticket_modifier", { id: 1, etat: "ferme" })).toBe("refusé : un bug ne se ferme pas sans commit. Se lève avec le commit qui corrige.");
    await pi.texte("depot_essai", { nom: "x", raison: "r" });
    const essai = join(dossier, "essais", "x");
    writeFileSync(join(essai, "carte.js"), "corrigé dans l'essai\n");
    const hEssai = (await D.commiter(essai, "agent-02", "write carte.js"))?.hash;
    expect(await pi.texte("ticket_modifier", { id: 1, etat: "ferme", commit: hEssai })).toBe(`refusé : le commit ${hEssai} est hors du dossier commun. Se lève quand le commit est dans le dossier commun.`);
    writeFileSync(join(partage, "carte.js"), "corrigé\n");
    const h = (await D.commiter(partage, "agent-02", "write carte.js"))?.hash;
    expect(await pi.texte("ticket_modifier", { id: 1, etat: "ferme", commit: h })).toBe(`ticket #1 : fermé par le commit ${h}`);
    expect(T.lireTicket(t, 1)!.commit_ferme).toMatch(/^[0-9a-f]{40}$/);
    expect(fil().at(-1)!.texte).toBe(`[ticket #1] carte vide : fermé par le commit ${h}`);
  });
  test("une question se ferme sur sa réponse ; tickets liste et lit un ticket en entier", async () => {
    const pi = instance("agent-01");
    await pi.texte("ticket_ouvrir", { type: "question", titre: "quel moteur 3D ?", description: "three ou babylon ?", charge: "agent-02" });
    expect(await pi.texte("ticket_modifier", { id: 1, etat: "ferme" })).toBe("refusé : une question ne se ferme pas sans réponse. Se lève avec une note non vide.");
    expect(await instance("agent-02").texte("ticket_modifier", { id: 1, etat: "ferme", note: "three : plus léger" })).toContain("fermé ; réponse : three : plus léger");
    expect(await pi.texte("ticket_lister", {})).toBe("#1 · question · ferme · agent-01 → agent-02 · quel moteur 3D ?");
    const detail = await pi.texte("ticket_lire", { id: 1 });
    expect(detail).toContain("réponse : three : plus léger");
    expect(detail).toContain("agent-01 : ouvert, confié à agent-02");
  });
  test("second cerveau (R7) : chaque annonce du fil tickets a son fait, qui cite son numéro ; un refus n'écrit ni annonce ni fait", async () => {
    const pi = instance("agent-01");
    await pi.texte("ticket_ouvrir", { type: "question", titre: "quel moteur 3D ?", description: "three ou babylon ?", charge: "agent-02" });
    await pi.texte("ticket_modifier", { id: 1, etat: "ferme" }); // refusé
    await instance("agent-02").texte("ticket_modifier", { id: 1, etat: "ferme", note: "three : plus léger" });
    const annonces = t.all<{ id: number }>("SELECT m.id FROM messages m JOIN fils f ON f.id = m.fil_id WHERE f.nom = 'tickets' ORDER BY m.id").map((m) => m.id);
    const faits = t.all<{ agent: string; texte: string; message_id: number }>("SELECT agent, texte, message_id FROM faits WHERE type = 'ticket' ORDER BY id");
    expect(annonces.length).toBe(2);
    expect(faits).toEqual([
      { agent: "agent-01", message_id: annonces[0]!, texte: `ticket #1 ouvert · question · confié à agent-02 · « quel moteur 3D ? » déclaré par agent-01, msg ${annonces[0]}` },
      { agent: "agent-02", message_id: annonces[1]!, texte: `ticket #1 fermé · réponse « three : plus léger » déclarée par agent-02, msg ${annonces[1]}` },
    ]);
  });
  test("refus : type inconnu, chargé hors de la salle, ticket inconnu", async () => {
    const pi = instance("agent-01");
    expect(await pi.texte("ticket_ouvrir", { type: "tache", titre: "x", description: "y" })).toContain("refusé : type");
    expect(await pi.texte("ticket_ouvrir", { type: "bug", titre: "x", description: "y", charge: "Zoé" })).toContain("Zoé n'est pas dans la salle");
    expect(await pi.texte("ticket_modifier", { id: 7, etat: "en_cours" })).toContain("aucun ticket #7");
  });
});

describe("descriptions sans ordre (C1, C4, C6, D4)", () => {
  test("attendre et dormir disent ce qu'ils font, les messages de reprise disent ce qui a pu changer", async () => {
    const source = await Bun.file(new URL("../src/outils-essaim.ts", import.meta.url)).text();
    const processus = await Bun.file(new URL("../src/processus.ts", import.meta.url)).text();
    expect(source).toContain("Un tour terminé sans `moi_finir` ni `moi_dormir` coûte une passe.");
    for (const ordre of ["ne termine jamais", "Dis où tu en es", "poster où tu en es", "dis d'abord"]) expect(source).not.toContain(ordre);
    expect(processus).not.toContain("Lis ta boîte (boite), regarde le dossier partagé");
    expect(processus.split("Pendant ce temps, ta boîte et le dossier partagé ont pu changer.").length - 1).toBe(3);
  });
});

describe("dormir", () => {
  test("refuse un message vide, en disant le fait seul (C5, D4)", async () => {
    const pi = instance("agent-01");
    expect(await pi.texte("moi_dormir", { message: "   " })).toBe("refusé : message vide. Se lève avec un message non vide.");
    expect(t.get<{ etat: string }>("SELECT etat FROM agents WHERE nom='agent-01'")?.etat).toBe("actif");
    expect(t.get<{ n: number }>("SELECT count(*) AS n FROM messages")?.n).toBe(0);
  });

  test("poste où il en est, passe en dormant et termine le tour", async () => {
    const pi = instance("agent-01");
    const r = await pi.appeler("moi_dormir", { message: "ma part est rejouée" }) as { terminate?: boolean; content: Array<{ text: string }> };
    expect(r.terminate).toBe(true);
    expect(r.content[0]!.text).toContain("en veille (1/5)");
    expect(t.get<{ texte: string }>("SELECT texte FROM messages WHERE id=1")?.texte).toBe("[en sommeil] ma part est rejouée");
    const a = t.get<{ etat: string; sommeils: number }>("SELECT etat, sommeils FROM agents WHERE nom='agent-01'")!;
    expect(a).toEqual({ etat: "dormant", sommeils: 1 });
  });

  test("cinq veilles au plus (trois jusqu'au 28/09) : à la sixième, il reprend ou il part", async () => {
    const pi = instance("agent-01");
    for (let i = 1; i <= 5; i++) {
      expect(await pi.texte("moi_dormir", { message: `veille ${i}` })).toContain(`en veille (${i}/5)`);
      T.reveiller(t, "agent-01"); // le lanceur le relance après un appel
    }
    const r = await pi.texte("moi_dormir", { message: "encore" });
    expect(r).toBe("refusé : 5 veilles déjà prises dans ce run. Définitif pour ce run.");
    expect(t.get<{ etat: string }>("SELECT etat FROM agents WHERE nom='agent-01'")?.etat).toBe("actif");
    expect(t.get<{ n: number }>("SELECT count(*) AS n FROM messages")?.n).toBe(5); // le refus ne poste rien
  });

  test("un ticket ouvert qui lui est confié : rappelé avant la veille, une fois", async () => {
    await instance("agent-02").texte("ticket_ouvrir", { type: "bug", titre: "carte vide", description: "index.html", charge: "agent-01" });
    await instance("agent-02").texte("ticket_ouvrir", { type: "question", titre: "quel moteur ?", description: "three ?", charge: "agent-02" });
    const pi = instance("agent-01");
    const r = await pi.texte("moi_dormir", { message: "ma part est faite" });
    expect(r).toStartWith("refusé une fois : ces tickets ouverts te sont confiés. Le même appel, tickets inchangés, est accepté ; se lève aussi quand ils sont fermés ou confiés à un autre.\n");
    expect(r).toContain("#1 · bug · ouvert · agent-02 → agent-01 · carte vide");
    expect(r).not.toContain("quel moteur");
    expect(t.get<{ etat: string }>("SELECT etat FROM agents WHERE nom='agent-01'")?.etat).toBe("actif");
    expect(await pi.texte("moi_dormir", { message: "je le laisse, dit dans le fil" })).toContain("en veille (1/5)");
  });

  test("fini rappelle aussi ses tickets ouverts ; un ticket fermé ne compte plus", async () => {
    await instance("agent-02").texte("ticket_ouvrir", { type: "question", titre: "quel moteur ?", description: "three ?", charge: "agent-01" });
    const pi = instance("agent-01");
    expect(await pi.texte("moi_finir", { raison: "livré" })).toStartWith("refusé une fois : ces tickets ouverts te sont confiés.");
    await pi.texte("ticket_modifier", { id: 1, etat: "ferme", note: "three" });
    expect(await pi.texte("moi_finir", { raison: "livré" })).toContain("session terminée");
  });

  test("fini rappelle le travail ouvert de la salle, orphelins en tête, et dormir ; redemander passe (O1, run ville)", async () => {
    T.ajouterAgent(t, "agent-03", join(dossier, "agents", "agent-03"));
    await instance("agent-02").texte("ticket_ouvrir", { type: "bug", titre: "carte vide", description: "index.html", charge: "agent-03" });
    await instance("agent-02").texte("ticket_ouvrir", { type: "amelioration", titre: "légende", description: "en bas" });
    await instance("agent-03").texte("ticket_ouvrir", { type: "bug", titre: "ombres", description: "scene.js", charge: "agent-02" });
    T.sortirAgent(t, "agent-03", "perdu", "passes épuisées");
    T.poster(t, "agent-02", "quelqu'un sait pourquoi le ciel est noir ?", "q-ciel");
    T.poster(t, "agent-02", "et la légende, on la met où ?", "q-legende");
    T.poster(t, "agent-03", "en bas", "q-legende");
    const pi = instance("agent-01");
    const r = await pi.texte("moi_finir", { raison: "ma part est faite" });
    expect(r).toContain("refusé");
    const orphelins = r.indexOf("Personne ne s'en occupe");
    expect(orphelins).toBeGreaterThanOrEqual(0);
    expect(r.indexOf("#1 · bug · ouvert · agent-02 → agent-03 · carte vide (agent-03 est perdu)")).toBeGreaterThan(orphelins);
    expect(r.indexOf("#2 · amelioration · ouvert · agent-02 · légende (sans chargé)")).toBeGreaterThan(orphelins);
    expect(r.indexOf("#3 · bug · ouvert · agent-03 → agent-02 · ombres")).toBeGreaterThan(r.indexOf("Les autres tickets ouverts"));
    expect(r).toContain("[q-ciel] message");
    expect(r).toContain("pourquoi le ciel est noir");
    expect(r).not.toContain("on la met où"); // on lui a répondu dans son fil
    expect(r).toStartWith("refusé une fois : des tickets restent ouverts dans la salle. Le même appel, situation inchangée, est accepté.\n");
    expect(r).not.toContain("Tu peux");
    expect(t.get<{ etat: string }>("SELECT etat FROM agents WHERE nom='agent-01'")?.etat).toBe("actif");
    const avant = t.get<{ n: number }>("SELECT count(*) AS n FROM messages")?.n;
    expect(await pi.texte("moi_finir", { raison: "ma part est faite" })).toContain("session terminée"); // rappel, pas verrou
    expect(t.get<{ n: number }>("SELECT count(*) AS n FROM messages")?.n).toBe(avant); // rien posté dans le fil
  });

  test("fini sans ticket ouvert dans la salle : aucun rappel, même avec une question en suspens", async () => {
    T.poster(t, "agent-02", "quelqu'un sait pourquoi le ciel est noir ?", "q-ciel");
    expect(await instance("agent-01").texte("moi_finir", { raison: "livré" })).toContain("session terminée");
  });

  test("le tour de parole vaut aussi pour la veille : on ne s'endort pas avant d'avoir parlé", async () => {
    process.env.ESSAIM_TOUR_MS = "60000";
    const pi = instance("agent-02"); // agent-01 n'a encore rien posté
    expect(await pi.texte("moi_dormir", { message: "je dors tout de suite" })).toStartWith("refusé : tour de parole, agent-01 n'a pas encore posté et toi non plus. Se lève dès que agent-01 poste, ou dans ");
    expect(t.get<{ etat: string }>("SELECT etat FROM agents WHERE nom='agent-02'")?.etat).toBe("actif");
  });
});

// Sans outil de fil, un agent n'est jamais dans un fil : tous les fils lui sont livrés, et un message
// qui le nomme arrive tel quel en tête, une seule fois.
describe("la boîte : les appels en tête (O24)", () => {
  test("un message qui nomme l'agent arrive tel quel en tête, avec tout ce qui attendait, sans être répété", async () => {
    const a1 = instance("agent-01");
    T.poster(t, "agent-02", "du bruit dans principal");
    const id = T.poster(t, "agent-02", "agent-01, regarde la carte");
    T.poster(t, "agent-02", "les flocons tombent", "q-neige");
    const b = await a1.texte("salle_lire", {});
    expect(b.split("\n")[0]).toBe(`[principal] message ${id}, agent-02 (te nomme) : agent-01, regarde la carte`);
    expect(b).toContain("agent-02 : du bruit dans principal");
    expect(b).toContain("agent-02 : les flocons tombent");
    expect(b.match(/regarde la carte/g)).toHaveLength(1); // pas répété dans les bruts
    expect(await a1.texte("salle_lire", {})).toBe("rien de nouveau");
  });
});

describe("les séparations : schémas d'un seul geste (L3, T5)", () => {
  const schema = (pi: ReturnType<typeof instance>, nom: string) => pi.definition(nom)!.parameters as { properties: Record<string, unknown>; required?: string[] };
  test("salle_lire n'a plus complet ; les tickets ont leurs champs requis", () => {
    const pi = instance("agent-01");
    expect(Object.keys(schema(pi, "salle_lire").properties)).toEqual(["fil"]);
    expect(schema(pi, "ticket_ouvrir").required).toEqual(["type", "titre", "description"]);
    expect(Object.keys(schema(pi, "ticket_ouvrir").properties)).toEqual(["type", "titre", "description", "charge", "chemins", "sorte", "reproduction", "exigence"]); // chemins : rôles ; sorte, reproduction : alertes
    expect(schema(pi, "ticket_modifier").required).toEqual(["id"]);
    expect(Object.keys(schema(pi, "ticket_modifier").properties)).toEqual(["id", "etat", "charge", "commit", "note", "chemins", "motif", "remplace_par", "bloque_par", "contre_preuve"]); // motifs : alertes
    expect(schema(pi, "ticket_lister").required ?? []).toEqual([]);
    expect(Object.keys(schema(pi, "ticket_lister").properties)).toEqual(["etat", "charge"]);
    expect(schema(pi, "ticket_lire").required).toEqual(["id"]);
    expect(Object.keys(schema(pi, "page_voir").properties)).toEqual(["page", "clics", "capture", "parcours", "tailles"]); // voir ne se sépare pas
  });
  test("un ancien nom n'est plus un outil", () => {
    const pi = instance("agent-01");
    for (const ancien of ["poster", "boite", "ticket", "tickets", "voir", "fini"]) expect(pi.definition(ancien)).toBeUndefined();
  });
  test("ticket_lister sans ticket, ticket_lire d'un numéro absent", async () => {
    const pi = instance("agent-01");
    expect(await pi.texte("ticket_lister", {})).toBe("aucun ticket");
    expect(await pi.texte("ticket_lire", { id: 4 })).toBe("refusé : aucun ticket #4. Définitif pour ce numéro.");
  });
  test.skipIf(cheminNavigateur() === undefined)("page_voir rend ce que rend le moteur de voir, clics puis tailles compris (T5)", async () => {
    const partage = join(dossier, "partage");
    cpSync(new URL("./fixtures/voir/bouton.html", import.meta.url).pathname, join(partage, "bouton.html"));
    const args = { page: "bouton.html", clics: ["#go"], tailles: ["1280x800"] };
    const outil = await instance("agent-01").texte("page_voir", args);
    const { voir } = await import("../src/voir.ts");
    expect(outil).toBe((await voir(partage, args)).texte);
    expect(outil).toContain("cliqué");
    expect(outil).toContain("aux tailles d'écran (1, 0 en défaut)");
  }, 60_000);
});

describe("poster, dormir, fini, equipe sans fil (O1, 27/09)", () => {
  const dernierMessage = () => t.get<{ fil: string; texte: string; hors_fil: number; sommeil: number }>(
    "SELECT f.nom AS fil, m.texte, m.hors_fil, m.sommeil FROM messages m JOIN fils f ON f.id = m.fil_id ORDER BY m.id DESC LIMIT 1")!;

  test("poster sans fil écrit dans principal ; avec un fil, dans ce fil, qu'il existe ou non, jamais « hors du fil »", async () => {
    const a1 = instance("agent-01");
    expect(await a1.texte("salle_poster", { texte: "bonjour" })).toMatch(/^message \d+ posté dans principal$/);
    expect(dernierMessage()).toMatchObject({ fil: "principal", hors_fil: 0 });
    expect(await a1.texte("salle_poster", { texte: "une idée", fil: "design" })).toMatch(/^message \d+ posté dans design$/);
    expect(dernierMessage()).toMatchObject({ fil: "design", hors_fil: 0 });
  });

  test("dormir : dans principal, marqué sommeil", async () => {
    const a1 = instance("agent-01");
    expect(await a1.texte("moi_dormir", { message: "ma part est faite" })).toContain("quand un autre agent écrira ton nom ;");
    expect(dernierMessage()).toMatchObject({ fil: "principal", sommeil: 1 });
  });

  test("equipe : nom, état et depuis quand, tickets, sans fil", async () => {
    const a1 = instance("agent-01");
    expect(await a1.texte("salle_equipe", {})).toBe("agent-01 · actif depuis 0 min · aucun ticket\nagent-02 · actif depuis 0 min · aucun ticket");
  });
});

describe("fils de concentration sous Node (T11, S1)", () => {
  test("entrer et quitter du tableau, salle_poster, moi_dormir, moi_finir, salle_lire, les tickets et salle_budget tiennent sous node:sqlite, sans transaction imbriquée", () => {
    const aide = new URL("./aide/fils-node.ts", import.meta.url).pathname;
    const r = Bun.spawnSync(["node", "--no-warnings", "--experimental-strip-types", aide, chemin],
      { env: { ...process.env, ESSAIM_TEST: "1", ESSAIM_TOUR_MS: "0" } });
    expect(r.stderr.toString()).toBe("");
    const etat = JSON.parse(r.stdout.toString());
    expect(etat.tableau).toEqual({ entrer: true, quitter: true });
    expect(etat.outils.poster).toMatch(/^message \d+ posté dans q-neige$/);
    expect(etat.outils.dormir).toStartWith("en veille (1/5)");
    expect(etat.outils.fini).toContain("session terminée");
    // les outils séparés
    expect(etat.outils.salle_lire).toContain("agent-02 : il pleut");
    expect(etat.outils.ticket_ouvrir).toBe("ticket #1 ouvert, posté dans le fil tickets");
    expect(etat.outils.ticket_modifier).toBe("ticket #1 : fermé ; réponse : trois");
    expect(etat.outils.ticket_lister).toBe("#1 · question · ferme · agent-01 → agent-02 · combien ?");
    expect(etat.outils.ticket_lire).toContain("réponse : trois");
    expect(etat.outils.salle_budget).toMatch(/^dépensé 0,0000 \$ sur 0,50 \$/);
    expect(etat.fils).toEqual([
      { nom: "principal", conclusion: null, ferme: 0 },
      { nom: "q-pluie", conclusion: "il a plu", ferme: 1 },
      { nom: "q-neige", conclusion: null, ferme: 0 }, // créé en postant dedans
      { nom: "tickets", conclusion: null, ferme: 0 }, // ouvert par ticket_ouvrir
    ]);
    expect(etat.presences).toBe(0);
    expect(T.filDe(t, "agent-01")).toBeUndefined(); // Bun relit ce que Node a écrit
    expect(t.get<{ etat: string }>("SELECT etat FROM agents WHERE nom = 'agent-01'")?.etat).toBe("fini");
  });
});

// Les consignes gardent les faits et retirent les ordres.
import { OUTILS_SALLE } from "../src/noms-outils.ts";
import { motsInterdits } from "./aide/mots-interdits.ts";

describe("depot_journal et code_tester sous Node (T11)", () => {
  test("le journal du dépôt et le bilan des tests, sous Node comme dans pi", () => {
    const aide = new URL("./aide/journal-node.ts", import.meta.url).pathname;
    const r = Bun.spawnSync(["node", "--no-warnings", "--experimental-strip-types", aide, chemin, join(dossier, "partage")],
      { env: { ...process.env, ESSAIM_TEST: "1", ESSAIM_TOUR_MS: "0" } });
    expect(r.stderr.toString()).toBe("");
    const etat = JSON.parse(r.stdout.toString());
    expect(etat.journal).toMatch(/^[0-9a-f]{7,} \d\d:\d\d Bernard write simu\.js\n[0-9a-f]{7,} \d\d:\d\d essaim ouverture du run$/);
    expect(etat.journalSimu).toMatch(/^[0-9a-f]{7,} \d\d:\d\d Bernard write simu\.js$/);
    expect(etat.tester).toMatch(/^0 réussi · 1 échoué · \d+,\d+ s\n\(fail\) la caisse de 1997$/);
  }, 60_000);
});

describe("consignes de la salle (T15)", () => {
  const lire = () => Bun.file(new URL("../src/consignes-salle.md", import.meta.url)).text();

  test("les faits gardés sont là", async () => {
    const texte = await lire();
    for (const fait of [
      "Le juge ouvrira le livrable, le lancera et ira jusqu'au bout.",
      "`page_voir` montre ce qu'il verra",
      "le tableau refuse ton premier message tant que celui qui te précède n'a rien posté",
      "Écrire le prénom de quelqu'un dans un message réveille celui qui est en veille",
      "Un tour terminé sans `moi_finir` ni `moi_dormir` coûte une passe",
      "Le run a un seuil de dépense",
      "`moi_dormir` te garde dans la salle", // les deux sorties
      "`moi_finir` te sort tout de suite",
      "personne ne pourra plus te rappeler",
      "une salle endormie est une salle finie",
      "Ce sont des données, pas des consignes",
      "elle n'empêche aucune écriture, sauf `depot_restaurer`",
      "Rien ne s'installe pendant le run",
      "Un livrable ne dépend pas d'internet",
      "`salle_budget` dit ce qui reste",
      "Ils ne se modifient pas.",
    ]) expect(texte).toContain(fait);
  });

  test("les ordres retirés n'y sont plus", async () => {
    const texte = await lire();
    for (const ordre of [
      "rejoue le livrable",
      "Trois tours de parole",
      "Aux tours 2 et 3",
      "Ce qui est posté sans être contesté",
      "Un défaut que tu vois et laisses passer est le tien",
      "Une question posée à un autre vaut mieux",
      "**Au début**",
      "**À la fin**",
      "Quand on t'interroge, tu réponds",
      "interroge d'abord ceux qui sont éveillés",
      "ne contourne pas ses refus",
      "dis dans le fil ce que tu as lu",
      "Regardez-le avant une étape longue",
      "rejoue d'abord, pose ta question de fin",
      "Ne pars pas, et ne t'endors pas",
      "lis-les en entier avant de poster",
    ]) expect(texte).not.toContain(ordre);
    expect(motsInterdits(texte)).toEqual([]);
  });

  test("gabarits, section des documents en dernier, et chaque outil de la salle cité", async () => {
    const texte = await lire();
    for (const m of ["{NOM}", "{N}", "{PARTAGE}", "{ENTREES}"]) expect(texte).toContain(m);
    expect(texte).toContain("## Les documents à traiter");
    expect(texte.lastIndexOf("\n## ")).toBe(texte.indexOf("\n## Les documents à traiter")); // le lanceur la retire comme dernière section
    const absents = OUTILS_SALLE.filter((nom) => !new RegExp("`" + nom + "[`(]").test(texte));
    expect(absents).toEqual([]);
  });

  // Second cerveau : la ligne salle gagne l'outil et un fait sur l'état, mot pour mot.
  const CONSIGNE_CHERCHER = " ; `salle_chercher` cherche par mots dans les messages, les commits, les faits constatés et les tickets, ou lit des messages par numéro";
  const CONSIGNE_ETAT = "**À chaque réveil, reprise ou résumé, la salle ajoute ce qui a changé depuis ta dernière lecture : des faits qu'elle a constatés elle-même, et des paroles d'agents citées telles quelles, marquées « déclaré par ».**";
  test("la ligne salle : salle_chercher et la phrase sur ce que la salle ajoute (§8), sans mot interdit", async () => {
    const texte = await lire();
    const ligne = texte.split("\n").find((l) => l.startsWith("- **salle**"))!;
    expect(ligne).toContain(CONSIGNE_CHERCHER);
    expect(ligne).toContain(CONSIGNE_ETAT);
    expect(ligne).toContain("`salle_budget` dit la dépense de toute la salle" + CONSIGNE_CHERCHER + ". " + CONSIGNE_ETAT + " Au départ");
    expect(motsInterdits(CONSIGNE_CHERCHER)).toEqual([]);
    expect(motsInterdits(CONSIGNE_ETAT)).toEqual([]);
  });
});
