// Rôles des agents : au début d'un run avec chef, le lanceur découpe mécaniquement la mission en
// phrases et puces numérotées (sans interprétation) et les livre au chef ; le chef range chacune en exigence (E1, E2…),
// exigence transversale ou contexte, avec un responsable de contrôle (recette ou gardien-mesureur) ; le gardien-mesureur
// conteste un classement ; tout le monde lit la liste.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { formaterBilan, lancer } from "../src/lancer.ts";
import { phrasesNumerotees } from "../src/mission.ts";
import { ouvrirBun } from "../src/tableau-bun.ts";
import * as T from "../src/tableau.ts";
import { fauxPi } from "./aide/faux-extension-api.ts";
import extension from "../src/outils-essaim.ts";
import { raisonAuFormat } from "./aide/refus.ts";

const racine = resolve(import.meta.dir, "..");

describe("phrasesNumerotees (tâche 3)", () => {
  test("phrases et puces, numérotées dans l'ordre, avec leur section ; titres, lignes vides et blocs de code exclus", () => {
    const texte = [
      "# Une page", "", "Une page minuscule. Elle affiche « Bonjour ».", "Un bouton compte les clics : trois clics",
      "affichent 3.", "", "## Règles", "", "- Tout se compte en **nombres entiers**. « Arrondi » veut dire au plus",
      "  proche.", "- le temps en minutes", "1. premier point", "", "```js", "const a = 1. Pas une phrase.", "```", "",
      "| plat | prix |", "|------|-----:|", "| soupe | 450 |", "", "Voir l. 95 et la p. 3 du rapport ! Puis la suite ?", "**Un client pressé** compte contre la mission.",
    ].join("\n");
    expect(phrasesNumerotees(texte)).toEqual([
      { n: 1, section: "Une page", texte: "Une page minuscule." },
      { n: 2, section: "Une page", texte: "Elle affiche « Bonjour »." },
      { n: 3, section: "Une page", texte: "Un bouton compte les clics : trois clics affichent 3." },
      { n: 4, section: "Règles", texte: "Tout se compte en **nombres entiers**." },
      { n: 5, section: "Règles", texte: "« Arrondi » veut dire au plus proche." },
      { n: 6, section: "Règles", texte: "le temps en minutes" },
      { n: 7, section: "Règles", texte: "premier point" },
      { n: 8, section: "Règles", texte: "| plat | prix |" },
      { n: 9, section: "Règles", texte: "| soupe | 450 |" },
      { n: 10, section: "Règles", texte: "Voir l. 95 et la p. 3 du rapport !" },
      { n: 11, section: "Règles", texte: "Puis la suite ?" },
      { n: 12, section: "Règles", texte: "**Un client pressé** compte contre la mission." },
    ]);
  });

  test("sur missions/restaurant-6.md, les exigences oubliées par « C'est fini quand » sont bien des phrases (l. 95-96, 241-243)", () => {
    const mission = readFileSync(join(racine, "missions", "restaurant-6.md"), "utf8");
    const phrases = phrasesNumerotees(mission);
    expect(phrases.length).toBeGreaterThan(100);
    expect(phrases.map((p) => p.n)).toEqual(phrases.map((_, i) => i + 1));
    for (const p of phrases) { expect(p.texte).not.toContain("\n"); expect(p.texte.trim()).toBe(p.texte); expect(p.texte).not.toBe(""); }
    // L. 95-96 : la seconde phrase d'une puce, seule, sans la première.
    const presse = phrases.find((p) => p.texte.includes("Un client pressé"))!;
    expect(presse.texte).toBe("**Un client pressé, un plat servi avant que le précédent soit mangé, une attente coupée par un départ forcé** comptent contre la mission, pas pour elle.");
    // L. 241-243 : une phrase d'un paragraphe, sur trois lignes.
    const duree = phrases.find((p) => p.texte.startsWith("Le temps passé à chaque étape"))!;
    expect(duree.texte).toBe("Le temps passé à chaque étape se lit sur la fiche de la table (arrivée, commande, chaque suite prête et servie, addition, départ), et le tableau de bord donne la **durée moyenne d'un repas** (de l'installation au règlement, sur les tables réglées, arrondie à la minute).");
    expect(phrases.some((p) => p.section === "C'est fini quand")).toBe(true);
  });
});

// L'extension chargée avec un rôle sur un tableau d'équipe « application » ; les phrases posées comme le lanceur le fait.
const APPLICATION: Array<[string, string]> = [["Antoine", "chef"], ["Bernard", "integrateur"], ["Claude", "constructeur"], ["Denis", "constructeur"], ["Fabien", "recette"], ["Gilles", "gardien"]];
const ENV = ["ESSAIM_AGENT", "ESSAIM_TABLEAU", "ESSAIM_PARTAGE", "ESSAIM_BUREAU", "ESSAIM_ROLE", "ESSAIM_TOUR_MS"];
const MISSION = "# Bienvenue\n\nUn titre « Bonjour ». Une phrase d'accueil.\n\n## C'est fini quand\n\nTrois clics affichent 3.\n\n- La page s'ouvre sans erreur.\n";

describe("les exigences dans le tableau et les outils (tâche 3)", () => {
  let dossier: string, run: string, chemin: string, t: T.Tableau, envAvant: Record<string, string | undefined> = {};
  const instance = (agent: string, role?: string) => {
    Object.assign(process.env, { ESSAIM_AGENT: agent, ESSAIM_TABLEAU: chemin, ESSAIM_PARTAGE: join(run, "partage"), ESSAIM_BUREAU: join(run, "agents", agent) });
    if (role) process.env.ESSAIM_ROLE = role; else delete process.env.ESSAIM_ROLE;
    const faux = fauxPi();
    extension(faux.api, ouvrirBun);
    return faux;
  };
  const par = (nom: string) => instance(nom, APPLICATION.find(([n]) => n === nom)![1]);
  const equipe = (roles: Array<[string, string]>) => { for (const [nom, r] of roles) { mkdirSync(join(run, "agents", nom), { recursive: true }); T.ajouterAgent(t, nom, join(run, "agents", nom), undefined, undefined, { role: r }); } };

  beforeEach(() => {
    envAvant = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    process.env.ESSAIM_TOUR_MS = "0";
    dossier = mkdtempSync(join(tmpdir(), "essaim-exigences-"));
    run = join(dossier, "run");
    mkdirSync(join(run, "partage"), { recursive: true });
    chemin = join(run, "tableau.sqlite");
    t = ouvrirBun(chemin);
    T.initialiser(t);
    T.ouvrirRun(t, { id: "run-test", missionChemin: "m.md", missionTexte: MISSION, modele: "faux/faux", plafondUsd: 0.5, silenceMin: 15 });
  });
  afterEach(() => {
    t.fermer();
    rmSync(dossier, { recursive: true, force: true });
    for (const [k, v] of Object.entries(envAvant)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  });

  test("T.rangerExigence : E1, E2… ; re-ranger une phrase la déplace, une exigence sans phrase est retirée ; refus du tableau", () => {
    T.noterPhrases(t, phrasesNumerotees(MISSION));
    expect(T.phrases(t).map((p) => [p.n, p.section, p.classement])).toEqual([[1, "Bienvenue", null], [2, "Bienvenue", null], [3, "C'est fini quand", null], [4, "C'est fini quand", null]]);
    expect(T.rangerExigence(t, { phrases: [1, 2], classement: "exigence", responsable: "recette", par: "Antoine" })).toEqual({ ok: true, libelle: "E1", retirees: [] });
    expect(T.rangerExigence(t, { phrases: [4], classement: "transversale", responsable: "gardien", par: "Antoine" })).toEqual({ ok: true, libelle: "E2", retirees: [] });
    expect(T.rangerExigence(t, { phrases: [3], classement: "contexte", par: "Antoine" })).toEqual({ ok: true, retirees: [] });
    expect(T.rangerExigence(t, { phrases: [1, 2, 3], classement: "exigence", responsable: "recette", par: "Antoine" })).toEqual({ ok: true, libelle: "E3", retirees: ["E1"] });
    expect(T.listerExigences(t)).toEqual([
      { libelle: "E1", classement: "exigence", responsable: "recette", phrases: [], retiree: true, contestations: [] },
      { libelle: "E2", classement: "transversale", responsable: "gardien", phrases: [4], retiree: false, contestations: [] },
      { libelle: "E3", classement: "exigence", responsable: "recette", phrases: [1, 2, 3], retiree: false, contestations: [] },
    ]);
    const refus = (r: { ok: boolean; raison?: string }) => { expect(r.ok).toBe(false); expect(raisonAuFormat(r.raison!), r.raison).toBe(true); return r.raison; };
    expect(refus(T.rangerExigence(t, { phrases: [], classement: "exigence", responsable: "recette", par: "Antoine" }))).toBe("aucune phrase. Se lève avec au moins un numéro de phrase");
    expect(refus(T.rangerExigence(t, { phrases: [9], classement: "exigence", responsable: "recette", par: "Antoine" }))).toBe("aucune phrase n° 9. Se lève avec un numéro de 1 à 4");
    expect(refus(T.rangerExigence(t, { phrases: [1], classement: "souhait", par: "Antoine" }))).toBe("classement souhait inconnu. Se lève avec exigence, transversale ou contexte");
    expect(refus(T.rangerExigence(t, { phrases: [1], classement: "exigence", par: "Antoine" }))).toBe("une exigence sans responsable de contrôle. Se lève avec recette ou gardien");
    expect(refus(T.rangerExigence(t, { phrases: [1], classement: "exigence", responsable: "chef", par: "Antoine" }))).toBe("responsable chef inconnu. Se lève avec recette ou gardien");
    expect(refus(T.rangerExigence(t, { phrases: [1], classement: "contexte", responsable: "recette", par: "Antoine" }))).toBe("un contexte n'a pas de responsable de contrôle. Se lève sans responsable");
  });

  // Sorties incomplètes : « le texte ne sort pas de la machine » ne se prouve par aucune commande ; rangée en
  // exigence, elle laisserait le run « incomplet ». Une section Engagements la pose rangée.
  test("## Engagements : phrases posées en engagement ; exigence_ranger les refuse ; exigence_lister les montre ; pas « non rangées »", async () => {
    equipe(APPLICATION);
    const mission = MISSION + "\n\n## Engagements\n\n- Rien n'est publié ni envoyé à un service en ligne.\n- Le texte reste sur la machine.\n";
    T.noterPhrases(t, phrasesNumerotees(mission));
    expect(T.phrases(t).slice(4).map((p) => [p.n, p.section, p.classement])).toEqual([[5, "Engagements", "engagement"], [6, "Engagements", "engagement"]]);
    expect(T.engagements(t).map((p) => p.n)).toEqual([5, 6]);
    expect(T.estSectionEngagements("Engagements (non attestés)")).toBe(true);
    expect(T.estSectionEngagements("ENGAGEMENT")).toBe(true);
    expect(T.estSectionEngagements("Les engagements")).toBe(false);
    const chef = par("Antoine");
    expect(await chef.texte("exigence_ranger", { phrases: [4, 5], classement: "exigence", responsable: "gardien" }))
      .toBe("refusé : la phrase n° 5 est un engagement (section Engagements de la mission), pas une exigence : elle est suivie au bilan, sans preuve. Définitif pour cette phrase.");
    expect(await chef.texte("exigence_ranger", { phrases: [6], classement: "contexte" })).toStartWith("refusé : la phrase n° 6 est un engagement");
    expect(T.listerExigences(t)).toEqual([]);
    const liste = await par("Fabien").texte("exigence_lister", {});
    expect(liste).toContain("engagements (section Engagements, suivis au bilan, jamais des exigences) : phrases 5, 6");
    expect(liste).not.toContain("[5]");
    expect(raisonAuFormat("la phrase n° 5 est un engagement (section Engagements de la mission), pas une exigence : elle est suivie au bilan, sans preuve. Définitif pour cette phrase")).toBe(true);
  });

  test("exigence_ranger : le chef seul ; responsable absent de l'équipe refusé ; rend le libellé et les retraits", async () => {
    equipe(APPLICATION.filter(([, r]) => r !== "gardien"));
    T.noterPhrases(t, phrasesNumerotees(MISSION));
    const chef = par("Antoine");
    expect(await chef.texte("exigence_ranger", { phrases: [1, 2], classement: "exigence", responsable: "recette" })).toBe("E1 (exigence) : phrases 1, 2 · contrôle : recette (Fabien)");
    expect(await chef.texte("exigence_ranger", { phrases: [3], classement: "contexte" })).toBe("phrases 3 : contexte");
    expect(await chef.texte("exigence_ranger", { phrases: [4], classement: "transversale", responsable: "gardien" }))
      .toBe("refusé : aucun gardien-mesureur dans l'équipe. Se lève avec un responsable que l'équipe compte.");
    expect(await chef.texte("exigence_ranger", { phrases: [2, 3], classement: "exigence", responsable: "recette" })).toBe("E2 (exigence) : phrases 2, 3 · contrôle : recette (Fabien)");
    expect(await chef.texte("exigence_ranger", { phrases: [1], classement: "contexte" })).toBe("phrases 1 : contexte · retirée faute de phrase : E1");
    for (const nom of ["Bernard", "Claude", "Fabien"])
      await expect(par(nom).texte("exigence_ranger", { phrases: [4], classement: "contexte" })).rejects.toThrow("outil inconnu"); // outil retiré à ce rôle
  });

  test("exigence_ranger dans un run sans chef (jeu) : définitif pour le run ; sans phrases numérotées : idem", async () => {
    equipe([["Antoine", "integrateur"], ["Bernard", "constructeur"], ["Edmond", "recette"]]);
    await expect(instance("Antoine", "integrateur").texte("exigence_ranger", { phrases: [1], classement: "contexte" })).rejects.toThrow("outil inconnu"); // outil retiré à ce rôle
    expect(await instance("Edmond", "recette").texte("exigence_lister", {})).toBe("aucune phrase numérotée dans ce run");
  });

  test("exigence_contester : le gardien seul ; ouvre au chef un ticket (question) qui cite les phrases ; exigence_lister le montre", async () => {
    equipe(APPLICATION);
    T.noterPhrases(t, phrasesNumerotees(MISSION));
    await par("Antoine").texte("exigence_ranger", { phrases: [1, 2], classement: "exigence", responsable: "recette" });
    await par("Antoine").texte("exigence_ranger", { phrases: [3, 4], classement: "contexte" });
    const gilles = par("Gilles");
    expect(await gilles.texte("exigence_contester", { phrases: [3], raison: "trois clics, c'est ce que le juge mesure" })).toBe("ticket #1 ouvert au chef (Antoine) : contestation des phrases 3");
    const k = T.lireTicket(t, 1)!;
    expect(k).toMatchObject({ type: "question", sorte: "travail", auteur: "Gilles", charge: "Antoine", titre: "contestation des phrases 3", etat: "ouvert" });
    expect(k.description).toBe("trois clics, c'est ce que le juge mesure\n[3] (C'est fini quand, rangée : contexte) Trois clics affichent 3.");
    expect(t.get<{ texte: string }>("SELECT m.texte FROM messages m JOIN fils f ON f.id = m.fil_id WHERE f.nom = 'tickets'")!.texte)
      .toBe("[ticket #1 · question] contestation des phrases 3 — confié à Antoine : trois clics, c'est ce que le juge mesure");
    expect(await gilles.texte("exigence_contester", { exigence: "E1", raison: "deux phrases, deux contrôles" })).toBe("ticket #2 ouvert au chef (Antoine) : contestation de E1");
    await expect(par("Fabien").texte("exigence_contester", { exigence: "E1", raison: "x" })).rejects.toThrow("outil inconnu"); // outil retiré à ce rôle
    expect(await gilles.texte("exigence_contester", { raison: "x" })).toBe("refusé : ni exigence ni phrase contestée. Se lève avec exigence ou phrases.");
    expect(await gilles.texte("exigence_contester", { exigence: "E9", raison: "x" })).toBe("refusé : aucune exigence E9. Se lève avec un libellé que exigence_lister donne.");
    expect(await gilles.texte("exigence_contester", { phrases: [7], raison: "x" })).toBe("refusé : aucune phrase n° 7. Se lève avec un numéro de 1 à 4.");
    expect(await gilles.texte("exigence_contester", { exigence: "E1", raison: " " })).toBe("refusé : une contestation sans raison. Se lève avec une raison non vide.");
    const liste = await par("Claude").texte("exigence_lister", {});
    expect(liste).toBe([
      "E1 · exigence · contrôle : recette (Fabien) · phrases 1, 2 · contestée : #2",
      "  [1] Un titre « Bonjour ».",
      "  [2] Une phrase d'accueil.",
      "contexte : phrases 3, 4",
      "contestations ouvertes : #1 (phrases 3), #2 (E1)",
    ].join("\n"));
    // La réponse du chef ferme la contestation, comme toute question.
    expect(await par("Antoine").texte("ticket_modifier", { id: 1, etat: "ferme", note: "rangée en exigence : E2" })).toStartWith("ticket #1 : fermé");
    expect(await par("Claude").texte("exigence_lister", {})).toEndWith("contestations ouvertes : #2 (E1)");
  });
});

// Le lanceur livre les phrases numérotées au chef, dans le message de son premier lancement, et les pose au tableau.
describe("le lanceur livre les phrases au chef (tâche 3)", () => {
  let racineRun: string;
  const argsDe = (run: string, nom: string) => (JSON.parse(readFileSync(join(run, "journal", `${nom}.args`), "utf8").trim().split("\n")[0]!) as { args: string[] }).args;
  beforeEach(() => {
    racineRun = mkdtempSync(join(tmpdir(), "essaim-exigences-lancer-"));
    process.env.ESSAIM_PI = join(racine, "tests", "faux-pi.ts");
    process.env.ESSAIM_FIXTURE = join(racine, "tests", "fixtures", "hello-fini.jsonl");
    process.env.ESSAIM_TOUR_MS = "0";
  });
  afterEach(() => { rmSync(racineRun, { recursive: true, force: true }); for (const v of ["ESSAIM_PI", "ESSAIM_FIXTURE", "ESSAIM_TOUR_MS"]) delete process.env[v]; });

  test("application : le chef reçoit la mission puis ses phrases numérotées ; les autres, la mission seule ; sans chef, rien", async () => {
    const mission = join(racineRun, "mission.md");
    writeFileSync(mission, readFileSync(join(racine, "missions", "exemples", "roles-mini.md"), "utf8"));
    const b = await lancer({ agents: 8, modele: "faux", plafond: 0.1, mission, racine: racineRun, sansBacASable: true });
    const texteMission = readFileSync(mission, "utf8");
    const chef = argsDe(b.run, "Antoine").at(-1)!;
    const phrases = phrasesNumerotees(texteMission);
    expect(chef).toBe(`${texteMission}\n\nLes phrases de la mission, découpées et numérotées par la salle, sans interprétation :\n${phrases.map((p) => `${p.n}. [${p.section}] ${p.texte}`).join("\n")}`);
    expect(argsDe(b.run, "Bernard").at(-1)).toBe(texteMission);
    const t = ouvrirBun(join(b.run, "tableau.sqlite"));
    expect(T.phrases(t).map((p) => ({ n: p.n, section: p.section, texte: p.texte }))).toEqual(phrases);
    t.fermer();
    const jeu = join(racineRun, "jeu.md");
    writeFileSync(jeu, texteMission.replace("application", "jeu"));
    const sansChef = await lancer({ agents: 5, modele: "faux", plafond: 0.1, mission: jeu, racine: racineRun, sansBacASable: true });
    const t2 = ouvrirBun(join(sansChef.run, "tableau.sqlite"));
    expect(T.phrases(t2)).toEqual([]);
    t2.fermer();
  }, 60_000);

  // Les engagements arrivent rangés au tableau, marqués dans le message du chef, listés au bilan.
  test("## Engagements : marqués « engagement, déjà rangé » pour le chef, posés en engagement, listés au bilan", async () => {
    const mission = join(racineRun, "mission.md");
    writeFileSync(mission, readFileSync(join(racine, "missions", "exemples", "roles-mini.md"), "utf8") + "\n## Engagements\n\n- Rien n'est envoyé à un service en ligne.\n");
    const b = await lancer({ agents: 8, modele: "faux", plafond: 0.1, mission, racine: racineRun, sansBacASable: true });
    const n = phrasesNumerotees(readFileSync(mission, "utf8")).length;
    expect(argsDe(b.run, "Antoine").at(-1)!).toContain(`\n${n}. [Engagements] (engagement, déjà rangé) Rien n'est envoyé à un service en ligne.`);
    const t = ouvrirBun(join(b.run, "tableau.sqlite"));
    expect(T.engagements(t).map((p) => [p.n, p.classement])).toEqual([[n, "engagement"]]);
    t.fermer();
    expect(b.engagements).toEqual(["Rien n'est envoyé à un service en ligne."]);
    expect(formaterBilan(b)).toContain("\nengagements de la mission (non attestés, sans effet sur l'acceptation) :\n- Rien n'est envoyé à un service en ligne.");
  }, 60_000);
});
