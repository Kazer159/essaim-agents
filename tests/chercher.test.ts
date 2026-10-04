// Second cerveau : salle_chercher.
// Tableaux fabriqués sous Bun (messages, lots faits, faits, tickets et leurs notes) ; l'index est rempli par les
// déclencheurs, jamais à la main.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ouvrirBun } from "../src/tableau-bun.ts";
import * as T from "../src/tableau.ts";
import { chercher, requeteFts, type ParamsChercher } from "../src/memoire.ts";
import { motsInterdits } from "./aide/mots-interdits.ts";
import { fauxPi } from "./aide/faux-extension-api.ts";
import extension from "../src/outils-essaim.ts";

let dossier: string;
let t: T.Tableau;

beforeEach(() => {
  dossier = mkdtempSync(join(tmpdir(), "essaim-chercher-"));
  t = ouvrirBun(join(dossier, "tableau.sqlite"));
  T.initialiser(t);
  T.ouvrirRun(t, { id: "run-test", missionChemin: "m.md", missionTexte: "texte", modele: "faux/faux", plafondUsd: 0.5, silenceMin: 15 });
  for (const a of ["Antoine", "Bernard", "Denis"]) T.ajouterAgent(t, a, join(dossier, "agents", a));
});
afterEach(() => {
  t.fermer();
  rmSync(dossier, { recursive: true, force: true });
});

// L'heure d'une ligne, telle que la machine l'affiche (HH:MM locale).
const heure = (iso: string) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
// Un message à une date choisie (poster date à l'instant) : le déclencheur copie cree_le dans l'index.
const message = (auteur: string, texte: string, fil = "principal", creeLe = new Date().toISOString()) => {
  t.run("INSERT OR IGNORE INTO fils(nom, cree_par, cree_le) VALUES (?, ?, ?)", [fil, auteur, creeLe]);
  return t.run("INSERT INTO messages(fil_id, auteur, cree_le, texte) VALUES ((SELECT id FROM fils WHERE nom = ?), ?, ?, ?)", [fil, auteur, creeLe, texte]).lastId;
};
const fait = (f: Partial<T.NouveauFait> = {}) =>
  t.transaction(() => T.noterFait(t, { type: "agent", agent: "Edmond", source: "tableau", texte: "Edmond · en veille", ...f }));
const commit = (agent: string, hash: string, message: string, fichiers: string[]) =>
  fait({ type: "ecriture", agent, source: "lanceur", texte: `écrit · ${fichiers.join(", ")} · ${agent} · commit ${hash.slice(0, 7)}`,
    details: { hash, message, fichiers: fichiers.map((chemin) => ({ chemin, blob: "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391" })) } });
const lotFait = (fil: string, debut: number, fin: number, texte: string) => {
  const id = t.run("INSERT INTO lots(fil_id, debut_id, fin_id, demande_par, cree_le) VALUES ((SELECT id FROM fils WHERE nom = ?), ?, ?, 'Denis', ?)",
    [fil, debut, fin, new Date().toISOString()]).lastId;
  T.finirLot(t, id, { ok: true, texte, cout: 0, estime: false, modele: "resumeur/mimo" });
  return id;
};
const texte = (p: ParamsChercher) => {
  const r = chercher(t, p);
  if ("refus" in r) throw new Error(`refus inattendu : ${r.refus}`);
  return r.texte;
};
const refus = (p: ParamsChercher) => {
  const r = chercher(t, p);
  if (!("refus" in r)) throw new Error(`réponse inattendue : ${r.texte}`);
  return r.refus;
};
const lignes = (p: ParamsChercher) => texte(p).split("\n");

describe("requeteFts : chaque mot cité en phrase FTS5 (§7.1)", () => {
  test("mots cités, guillemets doublés, expression entre guillemets gardée, début de mot", () => {
    expect(requeteFts("navigation.js", false)).toBe('"navigation.js"');
    expect(requeteFts("carte  menu", false)).toBe('"carte" "menu"');
    expect(requeteFts('a"b', false)).toBe('"a""b"');
    expect(requeteFts('"page saine" menu', false)).toBe('"page saine" "menu"');
    expect(requeteFts("navig menu", true)).toBe('"navig"* "menu"*');
    expect(requeteFts("l'élève", false)).toBe(`"l'élève"`);
  });

  test("ponctuation seule : aucun mot cherchable ; un mot de ponctuation au milieu est laissé", () => {
    expect(requeteFts("... ; !", false)).toBeUndefined();
    expect(requeteFts('""', false)).toBeUndefined();
    expect(requeteFts("   ", false)).toBeUndefined();
    expect(requeteFts("carte ... menu", false)).toBe('"carte" "menu"');
  });

  test("la requête brute avec un point est une erreur de syntaxe ; la phrase citée trouve le fichier", () => {
    message("Antoine", "j'ai réécrit navigation.js ce matin");
    expect(() => t.all("SELECT rowid FROM recherche WHERE recherche MATCH 'navigation.js'")).toThrow(/syntax error/);
    expect(t.all("SELECT rowid FROM recherche WHERE recherche MATCH ?", [requeteFts("navigation.js", false)])).toHaveLength(1);
  });
});

describe("M10 : chercher par mots", () => {
  test("mot avec un point, accents et casse ignorés, message court rendu entier, mot trouvé entre crochets", () => {
    const id = message("Denis", "navigation.js manque encore", "q-horaires", "2026-09-27T19:19:00.000Z");
    message("Bernard", "l'élève a rendu sa copie");
    const l = lignes({ mots: "navigation.js" });
    expect(l).toEqual([`[message] msg ${id} · q-horaires · ${heure("2026-09-27T19:19:00.000Z")} · Denis : [navigation.js] manque encore`]);
    expect(texte({ mots: "ELEVE" })).toContain("l'[élève] a rendu sa copie");
    expect(texte({ mots: "eleve" })).toContain("[élève]");
  });

  test("début de mot : navig trouve navigation seulement avec debut_de_mot", () => {
    message("Denis", "la navigation est cassée");
    expect(texte({ mots: "navig" })).toBe("aucun résultat pour « navig »");
    expect(texte({ mots: "navig", debut_de_mot: true })).toContain("[navigation]");
  });

  test("tous les mots présents (ET), une expression entre guillemets reste une expression", () => {
    message("Denis", "la carte seule");
    const deux = message("Denis", "la carte et le menu");
    message("Denis", "le menu seul");
    expect(lignes({ mots: "carte menu" }).map((x) => x.split(" · ")[0])).toEqual([`[message] msg ${deux}`]);
    const suite = message("Bernard", "la page saine enfin");
    message("Bernard", "saine est la page");
    expect(lignes({ mots: '"page saine"' }).map((x) => x.split(" · ")[0])).toEqual([`[message] msg ${suite}`]);
  });

  test("un long message rend un extrait de 12 mots autour du mot trouvé", () => {
    const long = `${"avant ".repeat(60)}cible ${"après ".repeat(60)}`;
    message("Denis", long);
    const l = texte({ mots: "cible" });
    expect(l).toContain("[cible]");
    expect(l).toContain("…");
    expect(l.length).toBeLessThan(200);
  });

  test("un extrait tient sur une ligne", () => {
    message("Denis", "première ligne\ndeuxième ligne avec le mot");
    expect(lignes({ mots: "mot" })).toHaveLength(1);
  });
});

describe("M10 : les types et leurs lignes", () => {
  test("commit : hash court, heure, auteur, message et fichiers", () => {
    const id = commit("Antoine", "3f2a1bc9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3", "write app.js", ["app.js"]);
    const cree = t.get<{ cree_le: string }>("SELECT cree_le FROM faits WHERE id = ?", [id])!.cree_le;
    expect(texte({ mots: "app.js" })).toBe(`[commit] 3f2a1bc · ${heure(cree)} · Antoine : write [app.js] · [app.js]`);
  });

  test("fait : numéro, heure, agent, la ligne", () => {
    const id = fait({ type: "verification", agent: "Bernard", source: "page_voir", statut: "verifie", texte: "vérifié · page_voir index.html · page saine (0) · Bernard" });
    const cree = t.get<{ cree_le: string }>("SELECT cree_le FROM faits WHERE id = ?", [id])!.cree_le;
    expect(texte({ mots: "saine" })).toBe(`[fait] fait ${id} · ${heure(cree)} · Bernard : vérifié · page_voir index.html · page [saine] (0) · Bernard`);
  });

  test("ticket : numéro, état actuel, auteur ; plusieurs notes d'un même ticket, chacune une ligne", () => {
    const n = T.ouvrirTicket(t, { type: "bug", titre: "carte vide", description: "la carte reste blanche", auteur: "Bernard" });
    T.majTicket(t, n, "Antoine", { note: "la carte vient du cache" });
    const l = lignes({ mots: "carte", type: "ticket" }); // le fait « ticket #N ouvert » sort sous le type fait
    expect(l).toHaveLength(2);
    expect(l[0]).toMatch(new RegExp(`^\\[ticket\\] #${n} · ouvert · \\d\\d:\\d\\d · Antoine : la \\[carte\\] vient du cache$`));
    expect(l[1]).toMatch(new RegExp(`^\\[ticket\\] #${n} · ouvert · \\d\\d:\\d\\d · Bernard : \\[carte\\] vide la \\[carte\\] reste blanche$`));
    T.majTicket(t, n, "Antoine", { etat: "ferme", commit: "abcdef1" });
    expect(lignes({ mots: "carte", type: "ticket" })[0]).toContain(`[ticket] #${n} · fermé · `);
  });

  test("résumé de lot : signalé « écrit par un modèle », avec les messages qu'il couvre", () => {
    const a = message("Denis", "un", "q-horaires");
    const b = message("Denis", "deux", "q-horaires");
    const lot = lotFait("q-horaires", a, b, "navigation.js toujours absent [msg 68]");
    expect(texte({ mots: "absent" })).toMatch(new RegExp(`^\\[résumé de lot\\] lot ${lot} · q-horaires · msg ${a} à ${b} · \\d\\d:\\d\\d · écrit par un modèle : navigation\\.js toujours \\[absent\\] \\[msg 68\\]$`));
  });
});

describe("M10 : les filtres", () => {
  beforeEach(() => {
    T.surnom(t, "Denis", "Dédé");
    message("Denis", "horaires du matin", "q-horaires", "2026-09-27T08:00:00.000Z");
    message("Antoine", "horaires du soir", "principal", "2026-09-27T20:00:00.000Z");
    commit("Antoine", "1234567890abcdef1234567890abcdef12345678", "write horaires.js", ["horaires.js"]);
    fait({ agent: "Denis", texte: "Denis · fini · raison déclarée par Denis : « horaires faits »" });
  });

  test("type", () => {
    expect(lignes({ mots: "horaires", type: "commit" }).every((l) => l.startsWith("[commit] "))).toBe(true);
    expect(lignes({ mots: "horaires", type: "fait" })).toHaveLength(1);
    expect(lignes({ mots: "horaires", type: "message" })).toHaveLength(2);
  });

  test("auteur par prénom ou par surnom, casse ignorée", () => {
    expect(lignes({ mots: "horaires", auteur: "Denis" })).toHaveLength(2);
    expect(lignes({ mots: "horaires", auteur: "dédé" })).toHaveLength(2);
    expect(lignes({ mots: "horaires", auteur: "antoine" })).toHaveLength(2);
  });

  test("fil : messages et résumés seulement", () => {
    expect(lignes({ mots: "horaires", fil: "q-horaires" })).toEqual([expect.stringContaining("[horaires] du matin")]);
  });

  test("un caractère de contrôle dans les mots ne fait pas lever la recherche (29/09, revue M4)", () => {
    expect(() => chercher(t, { mots: "a\u0000b" })).not.toThrow();
    expect(() => chercher(t, { mots: "a\u0000b", debut_de_mot: true })).not.toThrow();
  });
  test("un run qui passe minuit : « 01:00 » demandé le lendemain désigne le lendemain (29/09, revue M5)", () => {
    const veille = new Date(2026, 8, 25, 23, 0);
    t.run("UPDATE run SET debut = ?", [veille.toISOString()]);
    t.run("DELETE FROM recherche");
    message("Denis", "juste après le début", "principal", new Date(2026, 8, 25, 23, 5).toISOString());
    message("Denis", "après minuit", "principal", new Date(2026, 8, 26, 1, 10).toISOString());
    const r = chercher(t, { depuis: "01:00" }, new Date(2026, 8, 26, 1, 30));
    expect("texte" in r && r.texte).toContain("après minuit");
    expect("texte" in r && r.texte).not.toContain("juste après le début");
  });
  test("depuis : une heure HH:MM ou HH:MM:SS du jour du run, ou une date ISO", () => {
    const debut = t.get<{ debut: string }>("SELECT debut FROM run")!.debut;
    const jour = new Date(debut);
    const iso = (h: number, m: number) => new Date(jour.getFullYear(), jour.getMonth(), jour.getDate(), h, m).toISOString();
    t.run("DELETE FROM recherche"); // un index neuf, aux dates choisies
    message("Denis", "tôt le matin", "principal", iso(7, 0));
    message("Denis", "tard le soir", "principal", iso(21, 30));
    expect(lignes({ depuis: "21:30" })).toEqual([expect.stringContaining("tard le soir")]);
    expect(lignes({ depuis: "21:29:40" })).toEqual([expect.stringContaining("tard le soir")]); // HH:MM:SS, comme l'écrit l'état
    expect(refus({ mots: "x", depuis: "21:30:61" })).toStartWith("date illisible : 21:30:61.");
    expect(lignes({ mots: "le", depuis: "08:00" })).toHaveLength(1);
    expect(lignes({ depuis: iso(6, 0) })).toHaveLength(2);
    expect(lignes({ depuis: "2999-01-01" })).toEqual(["aucun résultat avec depuis: 2999-01-01"]);
  });

  test("filtres seuls : type fait liste les faits, début du texte", () => {
    expect(lignes({ type: "fait" })).toEqual([expect.stringMatching(/^\[fait\] fait \d+ · \d\d:\d\d · Denis : Denis · fini · raison déclarée par Denis : « horaires faits »$/)]);
    expect(lignes({ auteur: "Antoine" })).toHaveLength(2);
  });

  test("filtres seuls : un long texte est coupé, sans crochets", () => {
    message("Bernard", "x".repeat(500));
    const l = lignes({ auteur: "Bernard" })[0]!;
    expect(l).toEndWith("…");
    expect(l.length).toBeLessThan(300);
  });

  test("aucun résultat : les mots et les filtres rappelés", () => {
    expect(texte({ mots: "licorne", type: "commit", auteur: "Antoine" })).toBe("aucun résultat pour « licorne » avec type: commit, auteur: Antoine");
    expect(texte({ mots: "licorne" })).toBe("aucun résultat pour « licorne »");
  });
});

describe("M10 : 20 résultats au plus, tri et pagination par rowid", () => {
  test("20 au plus, du plus récent au plus ancien ; pages sans trou ni doublon, dates égales, notes d'un ticket, entrée ajoutée entre deux pages", () => {
    const meme = "2026-09-27T10:00:00.000Z";
    for (let i = 0; i < 25; i++) message("Denis", `pomme ${i}`, "principal", meme);
    const k = T.ouvrirTicket(t, { type: "question", titre: "pomme ?", description: "quelle pomme", auteur: "Bernard" });
    for (let i = 0; i < 4; i++) T.majTicket(t, k, "Antoine", { note: `pomme note ${i}` });
    const total = t.get<{ n: number }>("SELECT count(*) AS n FROM recherche WHERE recherche MATCH 'pomme'")!.n;
    expect(total).toBe(25 + 1 + 4 + 1); // le ticket et ses notes (la note « ouvert » ne dit pas pomme), plus le fait « ticket #N ouvert »

    const vus: string[] = [];
    const page = (avant?: number) => {
      const l = lignes({ mots: "pomme", avant });
      const suite = l.at(-1)!.startsWith("pour la suite") ? l.pop()! : undefined;
      vus.push(...l);
      return suite ? Number(suite.match(/avant: (\d+)\)$/)![1]) : undefined;
    };
    const rowids = t.all<{ r: number }>("SELECT rowid AS r FROM recherche WHERE recherche MATCH 'pomme' ORDER BY rowid DESC").map((x) => x.r);
    const a1 = page();
    expect(vus).toHaveLength(20);
    expect(a1).toBe(rowids[19]);
    expect(texte({ mots: "pomme" }).split("\n").at(-1)).toBe(`pour la suite : salle_chercher(mots: "pomme", avant: ${a1})`);
    message("Denis", "pomme tardive"); // entre dans l'index entre deux pages : n'apparaît pas dans la suite
    const a2 = page(a1);
    expect(a2).toBeUndefined();
    expect(vus).toHaveLength(total);
    expect(new Set(vus).size).toBe(total);
    expect(vus.some((l) => l.includes("tardive"))).toBe(false);
    expect(vus[0]).toContain("[pomme] note 3"); // la dernière entrée de l'index en tête
  });

  test("la ligne de suite reprend les paramètres donnés", () => {
    for (let i = 0; i < 21; i++) message("Denis", `poire ${i}`, "q-fruits");
    const suite = lignes({ mots: "poire", fil: "q-fruits", auteur: "Denis", debut_de_mot: true }).at(-1)!;
    expect(suite).toMatch(/^pour la suite : salle_chercher\(mots: "poire", debut_de_mot: true, auteur: "Denis", fil: "q-fruits", avant: \d+\)$/);
  });

  test("index vide : aucun résultat", () => {
    expect(texte({ mots: "rien" })).toBe("aucun résultat pour « rien »");
    expect(texte({ type: "fait" })).toBe("aucun résultat avec type: fait");
  });
});

describe("M10 : « repris par »", () => {
  test("msg N et message N oui, #N non, cinq numéros au plus, messages postérieurs seulement", () => {
    const n = message("Denis", "l'attente réelle est de 53 min");
    const autres = [message("Antoine", `d'accord avec msg ${n}`), message("Bernard", `le message ${n} dit vrai`),
      message("Bernard", `#${n} est faux`), message("Bernard", `msg ${n}0 n'a rien à voir`)];
    expect(texte({ mots: "attente" })).toEndWith(` · repris par msg ${autres[0]}, ${autres[1]}`);
    for (let i = 0; i < 6; i++) message("Antoine", `encore msg ${n}`);
    expect(texte({ mots: "attente" }).match(/repris par (.*)$/)![1]!.split(", ")).toHaveLength(5);
  });

  test("un commit repris par son hash de 7 caractères", () => {
    commit("Antoine", "3f2a1bc9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3", "write app.js", ["app.js"]);
    const m = message("Bernard", "le commit 3f2a1bc casse la carte");
    message("Bernard", "3f2a1bd n'est pas le même");
    expect(texte({ type: "commit" })).toEndWith(` · repris par msg ${m}`);
  });

  test("sans reprise, rien n'est ajouté", () => {
    message("Denis", "seul");
    expect(texte({ mots: "seul" })).not.toContain("repris par");
  });
});

describe("M10 : lecture par numéro", () => {
  test("un message entier, au format de fil_historique", () => {
    const long = "début " + "x".repeat(600) + " fin";
    const id = message("Denis", long, "q-horaires", "2026-09-27T19:19:00.000Z");
    expect(texte({ numero: id })).toBe(`[q-horaires] message ${id}, 2026-09-27T19:19:00.000Z Denis : ${long}`);
    expect(texte({ numero: id, type: "message" })).toBe(`[q-horaires] message ${id}, 2026-09-27T19:19:00.000Z Denis : ${long}`);
  });

  test("une plage à cheval sur deux fils, du plus ancien au plus récent ; 50 au plus", () => {
    const a = message("Denis", "un", "q-a");
    const b = message("Antoine", "deux", "q-b");
    const c = message("Denis", "trois", "q-a");
    const l = lignes({ numero: a, jusqua: c });
    expect(l.map((x) => x.split(",")[0])).toEqual([`[q-a] message ${a}`, `[q-b] message ${b}`, `[q-a] message ${c}`]);
    expect(lignes({ numero: 1, jusqua: 50 })).toHaveLength(3);
  });

  test("un fait avec sa citation entière", () => {
    const parole = "p".repeat(400);
    const c = T.citer(parole, {});
    const id = fait({ texte: `Edmond · fini · raison déclarée par Edmond : « ${c.texte} »`, details: { citation: parole } });
    const l = lignes({ type: "fait", numero: id });
    expect(l[0]).toMatch(new RegExp(`^\\[fait\\] fait ${id} · \\d\\d:\\d\\d · Edmond : Edmond · fini · raison déclarée par Edmond : « p{300}… \\(suite : salle_chercher\\(type: "fait", numero: ${id}\\)\\) »$`));
    expect(l[1]).toBe(`citation entière : ${parole}`);
    expect(l).toHaveLength(2);
  });

  test("numéro inconnu : aucun message n° N, aucun fait n° N (pas un refus)", () => {
    expect(texte({ numero: 999 })).toBe("aucun message n° 999");
    expect(texte({ numero: 998, jusqua: 999 })).toBe("aucun message du n° 998 au n° 999");
    expect(texte({ type: "fait", numero: 999 })).toBe("aucun fait n° 999");
  });
});

describe("M10 : rien n'est marqué lu", () => {
  test("ni lectures ni appels_livres ne changent", () => {
    const id = message("Denis", "Antoine, regarde ceci");
    message("Bernard", "pomme");
    const avant = JSON.stringify([t.all("SELECT * FROM lectures ORDER BY agent, fil_id"), t.all("SELECT * FROM appels_livres ORDER BY agent, message_id")]);
    texte({ mots: "pomme" });
    texte({ numero: id });
    texte({ type: "message" });
    expect(JSON.stringify([t.all("SELECT * FROM lectures ORDER BY agent, fil_id"), t.all("SELECT * FROM appels_livres ORDER BY agent, message_id")])).toBe(avant);
  });
});

describe("M10 : les refus (§7.5)", () => {
  const FORME = /^refusé : .+\. Se lève[^\n]*\.$/;
  const cas: Array<[string, ParamsChercher, string]> = [
    ["ni mots, ni numéro, ni filtre", { debut_de_mot: true }, "ni mots, ni numéro, ni filtre"],
    ["plage de plus de 50", { numero: 1, jusqua: 51 }, "plage de 51 messages, plus de 50"],
    ["numéro avec un autre type", { numero: 3, type: "commit" }, "numéro avec le type commit"],
    ["type inconnu", { mots: "x", type: "tache" }, "type inconnu : tache"],
    ["date illisible", { mots: "x", depuis: "hier" }, "date illisible : hier"],
    ["avant non numérique", { mots: "x", avant: "message:61" }, "avant n'est pas un nombre : message:61"],
    ["aucun mot cherchable", { mots: "... !" }, "aucun mot cherchable dans « ... ! »"],
  ];
  for (const [nom, p, debut] of cas)
    test(nom, () => {
      const r = refus(p);
      expect(r).toStartWith(debut + ". Se lève");
      expect(`refusé : ${r}.`).toMatch(FORME);
      expect(motsInterdits(r)).toEqual([]);
    });

  test("un nombre écrit en texte passe pour avant ; 25:00 est illisible", () => {
    message("Denis", "pomme");
    expect(texte({ mots: "pomme", avant: "999999" })).toContain("pomme");
    expect(refus({ mots: "pomme", depuis: "25:00" })).toStartWith("date illisible : 25:00.");
  });
});

describe("M12 : aucun mot interdit dans les réponses", () => {
  test("lignes, suite, aucun résultat, lecture", () => {
    for (let i = 0; i < 21; i++) message("Denis", `pomme ${i}`);
    const id = fait({ texte: "Edmond · en veille", details: { citation: "c" } });
    for (const r of [texte({ mots: "pomme" }), texte({ mots: "licorne", type: "fait" }), texte({ type: "fait", numero: id }), texte({ numero: 999 })])
      expect(motsInterdits(r)).toEqual([]);
  });
});

describe("M11 : l'outil salle_chercher dans l'extension", () => {
  // L'environnement reste posé pendant le test : salle_poster lit ESSAIM_TOUR_MS à l'appel.
  let envAvant: Record<string, string | undefined> = {};
  beforeEach(() => { envAvant = Object.fromEntries(["ESSAIM_AGENT", "ESSAIM_TABLEAU", "ESSAIM_TOUR_MS", "ESSAIM_MEMOIRE"].map((k) => [k, process.env[k]])); });
  afterEach(() => { for (const [k, v] of Object.entries(envAvant)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  const instance = (env: Record<string, string> = {}) => {
    delete process.env.ESSAIM_MEMOIRE;
    Object.assign(process.env, { ESSAIM_AGENT: "Denis", ESSAIM_TABLEAU: join(dossier, "tableau.sqlite"), ESSAIM_TOUR_MS: "0" }, env);
    const pi = fauxPi();
    extension(pi.api, ouvrirBun);
    return pi;
  };

  test("un message posté par salle_poster est retrouvé par salle_chercher ; lecture par numéro", async () => {
    const pi = instance();
    await pi.texte("salle_poster", { texte: "navigation.js est réécrit" });
    const id = t.get<{ id: number }>("SELECT max(id) AS id FROM messages")!.id;
    expect(await pi.texte("salle_chercher", { mots: "navigation.js" })).toMatch(new RegExp(`^\\[message\\] msg ${id} · principal · \\d\\d:\\d\\d · Denis : \\[navigation\\.js\\] est réécrit$`));
    expect(await pi.texte("salle_chercher", { numero: id })).toMatch(new RegExp(`^\\[principal\\] message ${id}, .* Denis : navigation\\.js est réécrit$`));
  });

  test("avant écrit en texte passe le schéma ; un refus a la forme commune", async () => {
    const pi = instance();
    await pi.texte("salle_poster", { texte: "pomme" });
    expect(await pi.texte("salle_chercher", { mots: "pomme", avant: "999999" })).toContain("[pomme]");
    expect(await pi.texte("salle_chercher", {})).toBe("refusé : ni mots, ni numéro, ni filtre. Se lève avec des mots, un numéro, ou l'un des filtres type, auteur, fil ou depuis.");
  });

  test("absent sous ESSAIM_MEMOIRE=non", () => {
    expect(instance({ ESSAIM_MEMOIRE: "non" }).noms()).not.toContain("salle_chercher");
    expect(instance().noms()).toContain("salle_chercher");
  });
});

describe("M13 : salle_chercher sous node:sqlite", () => {
  test("FTS5, snippet et bm25 sous Node ; salle_poster remplit l'index, salle_chercher le retrouve ; un poster sous Node et un commit sous Bun en même temps passent tous deux", async () => {
    T.ajouterAgent(t, "agent-01", join(dossier, "agents", "agent-01"));
    const aide = new URL("./aide/memoire-node.ts", import.meta.url).pathname;
    const p = Bun.spawn(["node", "--no-warnings", "--experimental-strip-types", aide, join(dossier, "tableau.sqlite"), "6"],
      { env: { ...process.env, ESSAIM_TEST: "1", ESSAIM_TOUR_MS: "0", ESSAIM_NODE_POSTES: "40" }, stdout: "pipe", stderr: "pipe" });
    let commits = 0, fini = false;
    p.exited.then(() => { fini = true; });
    while (!fini || commits < 5) {
      commit("Antoine", `${String(commits).padStart(7, "0")}${"a".repeat(33)}`, `write bun-${commits}.js`, [`bun-${commits}.js`]);
      commits++;
      await Bun.sleep(2);
    }
    await p.exited;
    expect(await new Response(p.stderr).text()).toBe("");
    const r = JSON.parse(await new Response(p.stdout).text()).phase6;
    expect(r.fts).toEqual({ extrait: "l'[élève] lit navigation.js", rang: "number" });
    expect(r.poste).toStartWith("message 1 posté dans principal");
    expect(r.trouve).toMatch(/^\[message\] msg 1 · principal · \d\d:\d\d · agent-01 : l'\[élève\] a réécrit \[navigation\.js\]$/);
    expect(r.numero).toMatch(/^\[principal\] message 1, .* agent-01 : l'élève a réécrit navigation\.js$/);
    expect(r.refus).toStartWith("refusé : ni mots, ni numéro, ni filtre.");
    const compte = (type: string, motif: string) =>
      t.get<{ n: number }>("SELECT count(*) AS n FROM recherche WHERE type = ? AND texte LIKE ?", [type, motif])!.n;
    expect(compte("message", "poste sous node %")).toBe(40);
    expect(compte("commit", "write bun-%")).toBe(commits);
    expect(t.get<{ n: number }>("SELECT count(*) AS n FROM messages")!.n).toBe(41);
  }, 60_000);
});
