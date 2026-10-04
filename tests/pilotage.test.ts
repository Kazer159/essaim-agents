// Pilotage de la salle : le rythme de dépense, ce qu'un dormeur attend, l'équipe détaillée et les constructeurs oisifs.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { phrasesNumerotees } from "../src/mission.ts";
import { ouvrirBun } from "../src/tableau-bun.ts";
import * as T from "../src/tableau.ts";
import { appel, DORMIR, ecrireFixture, fin } from "./aide/parcours.ts";

let dossier: string;
let t: T.Tableau;
const MIN = 60_000;

beforeEach(() => {
  dossier = mkdtempSync(join(tmpdir(), "essaim-pilotage-"));
  mkdirSync(join(dossier, "partage"));
  t = ouvrirBun(join(dossier, "tableau.sqlite"));
  T.initialiser(t);
  T.ouvrirRun(t, { id: "run-test", missionChemin: "m.md", missionTexte: "texte", modele: "faux/faux", plafondUsd: 10, silenceMin: 15 });
  for (const [nom, role] of [["Antoine", "chef"], ["Bernard", "integrateur"], ["Claude", "constructeur"], ["Denis", "constructeur"], ["Edmond", "constructeur"], ["Fabien", "recette"]])
    T.ajouterAgent(t, nom!, join(dossier, "agents", nom!), undefined, undefined, { role: role! });
});
afterEach(() => { t.fermer(); rmSync(dossier, { recursive: true, force: true }); });

const vieillir = (nom: string, minutes: number) =>
  t.run("UPDATE agents SET endormi_le = ? WHERE nom = ?", [new Date(Date.now() - minutes * MIN).toISOString(), nom]);

describe("rythme de dépense (P1)", () => {
  test("somme des réponses de la fenêtre, divisée par la fenêtre ; les réponses plus anciennes ne comptent pas", () => {
    t.run("UPDATE run SET debut = ?", [new Date(Date.now() - 120 * MIN).toISOString()]);
    T.ajouterEvenement(t, { agent: "Claude", type: "message", coutUsd: 1.5 });
    T.ajouterEvenement(t, { agent: "Denis", type: "message", coutUsd: 0.5 });
    t.run("INSERT INTO evenements(agent, horodatage, type, cout_usd) VALUES ('Claude', ?, 'message', 5)", [new Date(Date.now() - 45 * MIN).toISOString()]);
    t.run("UPDATE agents SET cout_usd = 4 WHERE nom = 'Claude'");
    const r = T.rythme(t, Date.now(), undefined, 30 * MIN);
    expect(r.dollarsHeure).toBeCloseTo(4, 3); // 2 $ en 30 min
    expect(r.tempsRestantMin).toBe(90); // reste 6 $ à 4 $/h
    expect(T.rythme(t, Date.now(), 2, 30 * MIN).tempsRestantMin).toBe(30); // le reste passé par le lanceur prime
  });

  test("un run plus court que la fenêtre divise par sa durée ; rien dépensé : temps restant inconnu", () => {
    t.run("UPDATE run SET debut = ?", [new Date(Date.now() - 10 * MIN).toISOString()]);
    expect(T.rythme(t, Date.now(), undefined, 30 * MIN)).toEqual({ dollarsHeure: 0, tempsRestantMin: null });
    T.ajouterEvenement(t, { agent: "Claude", type: "message", coutUsd: 1 });
    expect(T.rythme(t, Date.now(), undefined, 30 * MIN).dollarsHeure).toBeCloseTo(6, 1); // 1 $ en 10 min
  });
});

describe("attente et oisifs (P3)", () => {
  test("endormir garde ce qu'on attend et l'heure ; le réveil les efface", () => {
    T.endormir(t, "Claude", "  la réponse de Bernard sur #4 ");
    expect(T.attenteDe(t, "Claude")).toEqual({ texte: "déclaré : la réponse de Bernard sur #4", perimee: false });
    T.reveiller(t, "Claude");
    expect(t.get("SELECT attend, endormi_le FROM agents WHERE nom = 'Claude'")).toEqual({ attend: null, endormi_le: null });
    T.endormir(t, "Claude", "   ");
    expect(T.attenteDe(t, "Claude")).toBeNull();
  });

  test("en attente : ticket confié, rejeu pas fait, demande au dépôt ; oisif sinon", () => {
    for (const n of ["Claude", "Denis", "Edmond"]) T.endormir(t, n);
    T.ouvrirTicket(t, { type: "amelioration", titre: "lire 510-524", description: "d", auteur: "Antoine", charge: "Claude" });
    t.run("INSERT INTO demandes_rejeu(commande, demandeur, etat, cree_le) VALUES ('true', 'Denis', 'prise', ?)", [new Date().toISOString()]);
    expect(T.attenteDe(t, "Claude")?.texte).toBe("ticket #1");
    expect(T.attenteDe(t, "Denis")?.texte).toBe("rejeu #1");
    expect(T.oisifs(t).map((o) => o.nom)).toEqual(["Edmond"]);
    t.run("UPDATE demandes_rejeu SET etat = 'faite'");
    T.deposerDemande(t, "Denis", "commit", {});
    expect(T.oisifs(t).map((o) => o.nom)).toEqual(["Edmond"]);
  });

  test("O2 (02/10) : en veille sur un ticket que rien ne fait bouger depuis 20 min, il compte disponible, sur son ticket", () => {
    T.endormir(t, "Claude");
    T.ouvrirTicket(t, { type: "amelioration", titre: "lire 510-524", description: "d", auteur: "Antoine", charge: "Claude" });
    vieillir("Claude", 25);
    expect(T.oisifs(t, { ticketMaxMs: 20 * MIN })).toEqual([]); // le ticket vient d'être confié : il a bougé
    t.run("UPDATE tickets SET maj_le = ?", [new Date(Date.now() - 25 * MIN).toISOString()]);
    expect(T.attenteDe(t, "Claude", { ticketMaxMs: 20 * MIN })).toEqual({ texte: "en veille sur ticket #1, sans mouvement depuis 25 min", perimee: true, surTicket: true });
    expect(T.oisifs(t, { ticketMaxMs: 20 * MIN })).toEqual([{ nom: "Claude", depuisMs: expect.any(Number), perimee: "en veille sur ticket #1, sans mouvement depuis 25 min", surTicket: true }]);
    T.reveiller(t, "Claude"); // au travail sur son ticket : il attend son ticket, comme avant
    expect(T.attenteDe(t, "Claude", { ticketMaxMs: 20 * MIN })).toEqual({ texte: "ticket #1", perimee: false });
  });

  test("une attente déclarée se périme au bout de 30 min, sans compter le temps de pause", () => {
    T.endormir(t, "Claude", "le jalon strict de Bernard");
    vieillir("Claude", 35);
    expect(T.oisifs(t, { attenteMaxMs: 30 * MIN })).toEqual([{ nom: "Claude", depuisMs: expect.any(Number), perimee: "déclaré : le jalon strict de Bernard" }]);
    const il_y_a = (m: number) => new Date(Date.now() - m * MIN).toISOString();
    t.run("INSERT INTO evenements(agent, horodatage, type, resultat_resume) VALUES ('lanceur', ?, 'pause', 'pause demandée'), ('lanceur', ?, 'reprise', 'run repris après 10 min de pause')", [il_y_a(20), il_y_a(10)]);
    expect(T.oisifs(t, { attenteMaxMs: 30 * MIN })).toEqual([]); // 35 min de veille dont 10 de pause : 25 min d'attente
    expect(Math.round(T.dureeHorsPause(t, Date.now() - 35 * MIN) / MIN)).toBe(25); // décalée, pas remise à zéro
  });

  test("A1 (02/10) : une attente tient si elle cite un ticket ouvert ou nomme un agent présent autre que le répartiteur", () => {
    T.ouvrirTicket(t, { type: "amelioration", titre: "patch", description: "d", auteur: "Antoine", charge: "Bernard" });
    const tient = (attend: string) => T.attenteTient(t, "Claude", attend, "Antoine");
    expect(tient("le commit de #1")).toBe(true); // ticket ouvert
    expect(tient("la réponse de Fabien")).toBe(true); // agent présent
    expect(tient("le plan de la salle")).toBe(true); // ATTENTE_PLAN
    expect(tient("un nouveau ticket d'Antoine")).toBe(false); // le répartiteur seul : attendre une part
    expect(tient("une nouvelle part")).toBe(false);
    expect(tient("ma propre relecture, Claude")).toBe(false); // soi-même
    expect(tient("le ticket #99")).toBe(false); // inconnu
    expect(tient("le verdict de la recette")).toBe(true); // un rôle tenu par un présent (Fabien)
    expect(tient("une part du chef")).toBe(false); // le chef est le répartiteur
    t.run("UPDATE tickets SET etat = 'ferme' WHERE id = 1");
    expect(tient("le commit de #1")).toBe(false); // fermé : l'attente se lève d'elle-même
    t.run("UPDATE agents SET etat = 'fini' WHERE nom = 'Fabien'");
    expect(tient("la réponse de Fabien")).toBe(false); // sorti
  });

  test("A1 : un dormeur à l'attente vague est oisif tout de suite, l'attente rendue à part", () => {
    T.endormir(t, "Claude", "un nouveau ticket d'Antoine");
    T.endormir(t, "Denis", "la réponse de Bernard");
    expect(T.attenteDe(t, "Claude", { repartiteur: "Antoine" })).toEqual({ texte: "déclaré : un nouveau ticket d'Antoine", perimee: false, vague: "un nouveau ticket d'Antoine" });
    expect(T.oisifs(t, { repartiteur: "Antoine" })).toEqual([{ nom: "Claude", depuisMs: expect.any(Number), vague: "un nouveau ticket d'Antoine" }]);
    expect(T.oisifs(t, { repartiteur: "Bernard" }).map((o) => o.nom)).toEqual(["Denis"]); // Bernard répartit : Denis attend une part ; Claude nomme Antoine
  });

  test("seuls les constructeurs sont oisifs ; un suppléant qui tient un siège est exclu", () => {
    for (const n of ["Antoine", "Bernard", "Claude", "Denis", "Fabien"]) T.endormir(t, n);
    expect(T.oisifs(t).map((o) => o.nom)).toEqual(["Claude", "Denis"]);
    expect(T.oisifs(t, { exclus: ["Denis"] }).map((o) => o.nom)).toEqual(["Claude"]);
  });

  test("équipe détaillée : rôle, depuis quand, tickets, attente", () => {
    T.ouvrirTicket(t, { type: "amelioration", titre: "lire", description: "d", auteur: "Antoine", charge: "Denis" });
    T.endormir(t, "Claude", "la recette");
    const e = T.equipeDetaillee(t);
    const claude = e.find((a) => a.nom === "Claude")!;
    expect(claude).toMatchObject({ role: "constructeur", etat: "dormant", tickets: [], attente: { texte: "déclaré : la recette", perimee: false } });
    expect(claude.depuis).not.toBeNull();
    expect(e.find((a) => a.nom === "Denis")).toMatchObject({ etat: "actif", tickets: [1], attente: null });
  });

  test("tickets sans porteur : non confiés ou confiés à un agent sorti", () => {
    T.ouvrirTicket(t, { type: "amelioration", titre: "a", description: "d", auteur: "Antoine" });
    T.ouvrirTicket(t, { type: "amelioration", titre: "b", description: "d", auteur: "Antoine", charge: "Claude" });
    T.ouvrirTicket(t, { type: "amelioration", titre: "c", description: "d", auteur: "Antoine", charge: "Denis" });
    expect(T.ticketsSansPorteur(t, ["Antoine", "Claude"]).map((k) => k.titre)).toEqual(["a", "c"]);
  });
});

describe("A5 : la recette reste jusqu'au constat (02/10)", () => {
  // Un rejeu échoué sans recette éveillée pour refaire la preuve : en veille, le message du lanceur qui la nomme
  // (signé essaim) la réveille, même s'il en nomme d'autres.
  test("un rejeu échoué réveille la recette en veille", () => {
    T.insererMessage(t, "Fabien", "[en sommeil] E1 attestée", "principal", { sommeil: true });
    T.endormir(t, "Fabien", "le constat du lanceur");
    expect(T.appelDormeur(t, "Fabien", T.alias(t, "Fabien"), true)).toBeUndefined();
    T.poster(t, "essaim", "Fabien : E1 n'est plus attestée. Le lanceur a rejoué preuves/1.json, que tu avais attesté, sur le produit du moment : ne passe pas (Claude a changé prix.js)", "principal");
    expect(T.appelDormeur(t, "Fabien", T.alias(t, "Fabien"), true)?.texte).toStartWith("Fabien : E1 n'est plus attestée");
  });
});

describe("O4 : le tableau de bord de celui qui répartit (02/10)", () => {
  test("au travail, en veille (porteurs de tickets d'abord), partis, tickets laissés par un parti, sans porteur, exigences", () => {
    T.endormir(t, "Denis"); T.endormir(t, "Edmond");
    T.ouvrirTicket(t, { type: "amelioration", titre: "a", description: "d", auteur: "Antoine", charge: "Edmond" });
    T.ouvrirTicket(t, { type: "amelioration", titre: "b", description: "d", auteur: "Antoine", charge: "Claude" });
    T.ouvrirTicket(t, { type: "amelioration", titre: "c", description: "d", auteur: "Antoine" });
    t.run("UPDATE agents SET etat = 'perdu' WHERE nom = 'Claude'");
    const b = T.tableauDeBord(t, "Antoine", { exigences: "E1 (à prouver)" }).split("\n");
    expect(b[0]).toMatch(/^État de la salle à \d\d:\d\d, calculé par le lanceur/);
    expect(b.slice(1)).toEqual([
      "- au travail (2) : Bernard (intégrateur), Fabien (recette)",
      "- en veille (2) : Edmond (#1, 0 min), Denis (aucun ticket, 0 min)",
      "- partis (1) : Claude (perdu)",
      "- tickets ouverts encore au nom d'un parti : #2 (Claude)",
      "- tickets ouverts sans porteur : #3",
      "- exigences pas encore tenues : E1 (à prouver)",
      "- essais pas encore adoptés : aucun",
    ]);
  });

  test("J6 (02/10) : la file des essais (le plus ancien, qui adopte) et l'âge du livrable", () => {
    T.noterEssai(t, "lignes-2", "Claude", "deux lignes", join(dossier, "essais", "lignes-2"));
    T.noterEssai(t, "lignes-3", "Denis", "trois lignes", join(dossier, "essais", "lignes-3"));
    t.run("UPDATE essais SET cree_le = ? WHERE nom = 'lignes-2'", [new Date(Date.now() - 48 * MIN).toISOString()]);
    T.noterAdoption(t, "lignes-3", "Bernard", "abc1234", []);
    T.noterEssai(t, "lignes-4", "Edmond", "un ligne", join(dossier, "essais", "lignes-4"));
    const b = T.tableauDeBord(t, "Antoine", { livrable: { chemin: "texte.jsonl", le: new Date(Date.now() - 64 * MIN).toISOString() } }).split("\n");
    expect(b.slice(-2)).toEqual(["- essais pas encore adoptés : 2, le plus ancien depuis 48 min (adoption : Bernard)", "- livrable texte.jsonl inchangé depuis 64 min"]);
  });
});

describe("O3 : une consigne passe en premier (02/10)", () => {
  test("en veille, la consigne réveille avant un ticket confié et avant les appels plus anciens", async () => {
    T.insererMessage(t, "Antoine", "[en sommeil] tout est distribué", "principal", { sommeil: true });
    T.endormir(t, "Antoine");
    await new Promise((r) => setTimeout(r, 2));
    T.poster(t, "Bernard", "Antoine : je relance l'assemblage ou pas");
    T.ouvrirTicket(t, { type: "amelioration", titre: "relire 510-524", description: "d", auteur: "Bernard", charge: "Antoine" });
    const id = T.poster(t, "lanceur", `Antoine${T.MARQUE_CONSIGNE}confie 93 et 105 à des agents présents`);
    expect(T.appelDormeur(t, "Antoine", T.alias(t, "Antoine"), true)).toMatchObject({ id, auteur: "lanceur" });
  });

  test("éveillé, la consigne est livrée en tête et en entier, même derrière plus de trois messages", async () => {
    const { ligneCourte } = await import("../src/memoire.ts");
    const longue = "confie 93 et 105 à des agents présents, " + "puis fais attester chaque exigence ; ".repeat(10);
    const id = T.poster(t, "lanceur", `Antoine${T.MARQUE_CONSIGNE}${longue}`);
    for (const n of ["Bernard", "Claude", "Denis", "Edmond", "Fabien"]) T.poster(t, n, `Antoine : rapport de ${n}`);
    const l = ligneCourte(t, "Antoine", new Set(), 0)!.texte!;
    const lignes = l.split("\n").filter((x) => x.includes("message "));
    expect(lignes[0]).toContain(`message ${id} de lanceur`);
    expect(lignes[0]).toContain(longue.trim().slice(-30));
    expect(l).toContain("+2 messages plus anciens");
  });
});

describe("A6 : l'historique des consignes (02/10)", () => {
  test("transmises : seulement un message du lanceur qui commence par un agent du run ; écartées : lues dans les événements", () => {
    T.poster(t, "lanceur", "Antoine : consigne : relis 510 à 600");
    T.poster(t, "lanceur", "Antoine : ronde du lanceur. Tickets ouverts sans porteur présent : #3 « note : consigne : x »"); // une ronde qui recopie un titre
    T.ajouterEvenement(t, { agent: "lanceur", type: "consigne", resultat: `${T.PREFIXE_ECARTEE}relis 600 à 700` });
    const h = T.consignes(t);
    expect(h.map((c) => [c.destinataire, c.texte, !!c.ecartee])).toEqual([["Antoine", "relis 510 à 600", false], ["", "relis 600 à 700", true]]);
  });
});

describe("outils (P1, P3)", () => {
  // Les outils de la salle sur ce tableau, pour un agent à rôle.
  const outil = async (agent: string, role: string, nom: string, args: Record<string, unknown>) => {
    const { fauxPi } = await import("./aide/faux-extension-api.ts");
    const { default: extension } = await import("../src/outils-essaim.ts");
    Object.assign(process.env, { ESSAIM_AGENT: agent, ESSAIM_ROLE: role, ESSAIM_TABLEAU: join(dossier, "tableau.sqlite"), ESSAIM_PARTAGE: join(dossier, "partage"), ESSAIM_BUREAU: join(dossier, "agents", agent), ESSAIM_TOUR_MS: "0" });
    const pi = fauxPi();
    extension(pi.api, ouvrirBun);
    try { return await pi.texte(nom, args); } finally { for (const k of ["ESSAIM_AGENT", "ESSAIM_ROLE", "ESSAIM_TABLEAU", "ESSAIM_PARTAGE", "ESSAIM_BUREAU", "ESSAIM_TOUR_MS"]) delete process.env[k]; }
  };

  test("moi_dormir garde attend ; salle_equipe montre le rôle, les tickets et l'attente", async () => {
    T.ouvrirTicket(t, { type: "amelioration", titre: "lire", description: "d", auteur: "Antoine", charge: "Denis" });
    expect(await outil("Claude", "constructeur", "moi_dormir", { message: "lot fini", attend: "la contre-lecture de Fabien" })).toStartWith("en veille");
    await outil("Edmond", "constructeur", "moi_dormir", { message: "rien à faire" });
    const equipe = await outil("Antoine", "chef", "salle_equipe", {});
    expect(equipe).toContain("Claude · constructeur · dormant depuis 0 min · aucun ticket · attend : déclaré : la contre-lecture de Fabien");
    expect(equipe).toContain("Denis · constructeur · actif depuis 0 min · tickets #1");
    expect(equipe).toContain("Edmond · constructeur · dormant depuis 0 min · aucun ticket · n'attend rien");
  });

  test("plan proposé puis à revoir : un seul message du lanceur par annonce, qui réveille chaque destinataire de sa tête (02/10)", async () => {
    T.ajouterAgent(t, "Gaston", join(dossier, "agents", "Gaston"), undefined, undefined, { role: "gardien" });
    const reveille = (nom: string) => T.appelDormeur(t, nom, T.alias(t, nom), true)?.auteur;
    mkdirSync(join(dossier, "partage"), { recursive: true });
    writeFileSync(join(dossier, "partage", "SPEC.md"), "# Spec\nle but, le problème, l'approche, les preuves");
    expect(await outil("Antoine", "chef", "plan_proposer", { etape: "spec", resume: "trois parts, Claude lit les pages" })).toBe("spec n°1 proposée ; contrôle attendu de Fabien, Gaston");
    for (const nom of ["Fabien", "Gaston"]) expect(reveille(nom)).toBe("lanceur");
    expect(await outil("Gaston", "gardien", "plan_juger", { plan: 1, verdict: "a_revoir", raison: "la part de Claude n'a pas de preuve" })).toStartWith("spec n°1 : à revoir, annoncé à Antoine, Bernard");
    const lanceur = t.all<{ texte: string }>("SELECT texte FROM messages WHERE auteur = 'lanceur' ORDER BY id").map((m) => m.texte);
    expect(lanceur).toHaveLength(2);
    expect(lanceur[0]).toStartWith("Fabien, Gaston : spec n°1 proposée, à contrôler (plan_juger) : SPEC.md.");
    expect(lanceur[1]).toStartWith("Antoine, Bernard : spec n°1 à revoir, selon le gardien-mesureur");
    for (const nom of ["Antoine", "Bernard"]) expect(reveille(nom)).toBe("lanceur");
    expect(reveille("Claude")).toBeUndefined(); // nommé dans le corps, pas en tête
  });

  test("A1 : moi_dormir signale une attente vague ; salle_equipe la montre comptée disponible", async () => {
    const vague = await outil("Claude", "constructeur", "moi_dormir", { message: "lot fini", attend: "une nouvelle part d'Antoine" });
    expect(vague).toEndWith("Ton attente ne nomme ni ticket ouvert (#n) ni agent autre que Antoine : tu comptes disponible pour un travail précis.");
    expect(await outil("Denis", "constructeur", "moi_dormir", { message: "lot fini", attend: "la contre-lecture de Fabien" })).not.toContain("Ton attente");
    expect(await outil("Fabien", "recette", "moi_dormir", { message: "E1 attestée", attend: "le constat" })).not.toContain("Ton attente"); // la ronde ne compte que les constructeurs
    const equipe = await outil("Antoine", "chef", "salle_equipe", {});
    expect(equipe).toContain("Claude · constructeur · dormant depuis 0 min · aucun ticket · attend (vague, compté disponible) : déclaré : une nouvelle part d'Antoine");
    expect(equipe).toContain("Denis · constructeur · dormant depuis 0 min · aucun ticket · attend : déclaré : la contre-lecture de Fabien");
  });

  test("partir sans demander : un constructeur demande au répartiteur s'il reste du travail, puis attend sa réponse ou 10 minutes", async () => {
    const finir = () => outil("Claude", "constructeur", "moi_finir", { raison: "ma part est faite" });
    expect(await finir()).toBe("refusé : tu n'as pas demandé à Antoine, qui répartit le travail, s'il en reste pour toi depuis ton dernier ticket fermé. Se lève quand un de tes messages commence par « Antoine : » avec une question, et que Antoine t'a répondu ou que 10 minutes sont passées.");
    T.poster(t, "Claude", "Antoine : j'ai fini le lot, que reste-t-il ?");
    expect(await finir()).toBe("refusé : Antoine n'a pas encore répondu à ta question sur le travail qui reste ; moi_dormir avec attend te met en veille jusqu'à sa réponse. Se lève quand Antoine t'a répondu, ou 10 minutes après ta question.");
    t.run("UPDATE messages SET cree_le = ? WHERE auteur = 'Claude'", [new Date(Date.now() - 11 * MIN).toISOString()]);
    expect(await finir()).toBe("session terminée : ma part est faite"); // 10 minutes sans réponse : il part
  });

  test("partir sans demander : la question compte si le répartiteur répond ; une question d'avant son dernier ticket fermé ne compte plus", async () => {
    T.poster(t, "Denis", "Antoine : reste-t-il du travail ?");
    T.poster(t, "Antoine", "Denis : oui, le ticket qui suit");
    const k = T.ouvrirTicket(t, { type: "amelioration", titre: "lire", description: "d", auteur: "Antoine", charge: "Denis" });
    await new Promise((r) => setTimeout(r, 5));
    t.run("UPDATE tickets SET etat = 'ferme', maj_le = ? WHERE id = ?", [new Date().toISOString(), k]);
    expect(await outil("Denis", "constructeur", "moi_finir", { raison: "fait" })).toStartWith("refusé : tu n'as pas demandé à Antoine");
    await new Promise((r) => setTimeout(r, 5));
    T.poster(t, "Denis", "Antoine : ticket fermé, autre chose ?");
    T.poster(t, "Antoine", "Denis : non, merci");
    expect(await outil("Denis", "constructeur", "moi_finir", { raison: "fait" })).toBe("session terminée : fait");
  });

  test("partir sans demander : une réponse par moi_dormir compte ; une question qui ne s'adresse pas au répartiteur, non ; un message à un autre n'est pas une réponse", async () => {
    T.poster(t, "Claude", "Bernard : tu as vu si Antoine a validé ?"); // Antoine cité, pas interrogé
    expect(await outil("Claude", "constructeur", "moi_finir", { raison: "fait" })).toStartWith("refusé : tu n'as pas demandé à Antoine");
    T.poster(t, "Claude", "Antoine : reste-t-il du travail ?");
    T.poster(t, "Antoine", "Denis : prends le lot suivant"); // répond à un autre
    expect(await outil("Claude", "constructeur", "moi_finir", { raison: "fait" })).toStartWith("refusé : Antoine n'a pas encore répondu");
    T.insererMessage(t, "Antoine", "[en sommeil] Claude : rien pour toi, tu peux partir", "principal", { sommeil: true });
    expect(await outil("Claude", "constructeur", "moi_finir", { raison: "fait" })).toBe("session terminée : fait");
  });

  test("partir sans demander : un chef parti sans relève ne retient personne ; l'intégrateur répartit alors", async () => {
    T.sortirAgent(t, "Antoine", "vire", "silence");
    expect(await outil("Claude", "constructeur", "moi_finir", { raison: "fait" })).toStartWith("refusé : tu n'as pas demandé à Bernard");
  });

  test("salle_budget rend le rythme et le temps restant", async () => {
    t.run("UPDATE run SET debut = ?", [new Date(Date.now() - 60 * MIN).toISOString()]);
    T.ajouterEvenement(t, { agent: "Claude", type: "message", coutUsd: 1 });
    t.run("UPDATE agents SET cout_usd = 1 WHERE nom = 'Claude'");
    expect(await outil("Antoine", "chef", "salle_budget", {})).toBe("dépensé 1,0000 $ sur 10,00 $, reste 9,0000 $ ; rythme 2,00 $ par heure sur les 30 dernières minutes, soit environ 4 h 30 min à ce rythme (une pause fait baisser le rythme) (estimation)");
  });
});

// ---- Au faux pi : paliers, ronde, dernière chance, sur un run à rôles de type jeu (5 sièges : Antoine intégrateur,
// qui répartit le travail ; Bernard, Claude, Denis constructeurs ; Edmond recette).
describe("au faux pi : le lanceur informe celui qui répartit (P1, P3)", () => {
  let racine: string;
  const racineDepot = join(import.meta.dir, "..");
  const ENV = ["ESSAIM_TOUR_MS", "ESSAIM_GRACE_MS", "ESSAIM_RONDE_MS", "ESSAIM_PALIERS", "ESSAIM_MEMOIRE_MAX_GO"];
  const nettoyer = () => { for (const k of Object.keys(process.env)) if (k.startsWith("ESSAIM_FIXTURE")) delete process.env[k]; for (const k of ENV) delete process.env[k]; };
  beforeEach(() => { racine = mkdtempSync(join(tmpdir(), "essaim-pilotage-run-")); process.env.ESSAIM_PI = join(racineDepot, "tests", "faux-pi.ts"); nettoyer(); process.env.ESSAIM_TOUR_MS = "0"; });
  afterEach(() => { rmSync(racine, { recursive: true, force: true }); nettoyer(); });
  const ecrire = (nom: string, lignes: object[]) => ecrireFixture(racine, nom, lignes);
  const mission = (extra = "") => {
    const p = join(racine, "mission-jeu.md");
    writeFileSync(p, "# Un compteur\n\nUne page avec un bouton qui compte les clics.\n\n## Type\n\njeu\n\n## C'est fini quand\n\nTrois clics affichent 3.\n" + extra);
    return p;
  };
  const coute = (usd: number) => ({ type: "message_end", message: { role: "assistant", stopReason: "stop", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: usd } } } });
  const lancerJeu = async (extra = "", preparation = false) => {
    const { lancer } = await import("../src/lancer.ts");
    return lancer({ agents: 5, modele: "faux", plafond: 1, mission: mission(extra), racine, sansBacASable: true, preparation });
  };
  const lireRun = (run: string) => ouvrirBun(join(run, "tableau.sqlite"), { lectureSeule: true });

  test("garde-fou de la mémoire (02/10) : une commande d'agent au-delà de la limite est arrêtée, l'agent le lit, l'agent lui-même n'est pas touché", async () => {
    process.env.ESSAIM_MEMOIRE_MAX_GO = "0.0001"; // ~100 Ko : un `sleep` les dépasse
    process.env.ESSAIM_FIXTURE = ecrire("dort", DORMIR);
    process.env.ESSAIM_FIXTURE_CLAUDE = ecrire("gourmand", [ // une seule fois : le message du lanceur le réveille, et la fixture se rejoue
      { type: "faux:lancer", commande: ["sh", "-c", "test -e {RUN}/lance || { touch {RUN}/lance; exec sleep 30; }"] }, { type: "faux:dormir", ms: 1500 }, ...DORMIR]);
    const b = await lancerJeu();
    const r = lireRun(b.run);
    const ev = r.all<{ agent: string; resultat_resume: string }>("SELECT agent, resultat_resume FROM evenements WHERE type = 'memoire'");
    const msg = r.all<{ texte: string }>("SELECT texte FROM messages WHERE auteur = 'lanceur' AND texte LIKE '%mémoire%'").map((m) => m.texte);
    const claude = r.get<{ etat: string }>("SELECT etat FROM agents WHERE nom = 'Claude'")!.etat;
    r.fermer();
    expect(ev).toHaveLength(1);
    expect(ev[0]!.agent).toBe("Claude");
    expect(ev[0]!.resultat_resume).toMatch(/^commande arrêtée par le lanceur : \d+,\d Go de mémoire \(limite 0,0001 Go\) : \d+ sleep 30$/);
    expect(msg).toHaveLength(1);
    expect(msg[0]).toMatch(/^Claude : ta commande a été arrêtée par le lanceur, elle prenait \d+,\d Go de mémoire \(limite 0,0001 Go\) : sleep 30$/);
    expect(claude).not.toBe("perdu"); // pi (le faux) a fini son tour normalement
    const pid = Number(ev[0]!.resultat_resume.match(/: (\d+) sleep/)![1]);
    expect(() => process.kill(pid, 0)).toThrow(); // le sleep est mort
  }, 30_000);

  test("O4 (02/10) : réveillé, celui qui répartit reçoit l'état de la salle calculé par le lanceur ; un autre, non", async () => {
    process.env.ESSAIM_FIXTURE = ecrire("dort", DORMIR);
    process.env.ESSAIM_FIXTURE_ANTOINE_PASSE_1 = ecrire("antoine-dort", [{ type: "faux:toucher", chemin: "{RUN}/antoine" }, ...DORMIR]);
    process.env.ESSAIM_FIXTURE_ANTOINE_PASSE_2 = ecrire("antoine-reveille", [{ type: "faux:toucher", chemin: "{RUN}/antoine-reveille" }, ...DORMIR]);
    process.env.ESSAIM_FIXTURE_CLAUDE = ecrire("appelle", [{ type: "faux:attendre", chemin: "{RUN}/antoine" }, { type: "faux:dormir", ms: 600 }, appel("p1", "salle_poster", { texte: "Antoine : le lot est fini, que reste-t-il" }),
      { type: "faux:attendre", chemin: "{RUN}/antoine-reveille" }, ...DORMIR]);
    const b = await lancerJeu();
    const lancements = (nom: string) => readFileSync(join(b.run, "journal", `${nom}.args`), "utf8").trim().split("\n").map((l) => (JSON.parse(l).args as string[]).at(-1)!);
    const reveil = lancements("Antoine").find((m) => m.startsWith("Tu étais en veille."));
    expect(reveil).toContain("État de la salle à ");
    expect(reveil).toContain("- au travail (");
    expect(reveil).toContain("- tickets ouverts encore au nom d'un parti : aucun");
    for (const m of lancements("Claude")) expect(m).not.toContain("État de la salle");
  }, 30_000);

  test("J3 (02/10) : l'intégrateur reçoit à son réveil la file des essais pas encore adoptés ; un constructeur, non", async () => {
    process.env.ESSAIM_FIXTURE = ecrire("dort", DORMIR);
    process.env.ESSAIM_FIXTURE_ANTOINE_PASSE_1 = ecrire("antoine-dort", [{ type: "faux:toucher", chemin: "{RUN}/antoine" }, ...DORMIR]);
    process.env.ESSAIM_FIXTURE_CLAUDE = ecrire("essai", [{ type: "faux:attendre", chemin: "{RUN}/antoine" }, { type: "faux:dormir", ms: 1200 }, appel("e1", "depot_essai", { nom: "lignes-2", raison: "deux lignes corrigés dans le fragment" }),
      appel("p1", "salle_poster", { texte: "Antoine : mon essai lignes-2 est prêt, peux-tu l adopter ?" }),
      { type: "faux:attendre", chemin: "{RUN}/antoine-reveille" }, ...DORMIR]);
    process.env.ESSAIM_FIXTURE_ANTOINE_PASSE_2 = ecrire("antoine-reveille", [{ type: "faux:toucher", chemin: "{RUN}/antoine-reveille" }, ...DORMIR]);
    const b = await lancerJeu();
    const lancements = (nom: string) => readFileSync(join(b.run, "journal", `${nom}.args`), "utf8").trim().split("\n").map((l) => (JSON.parse(l).args as string[]).at(-1)!);
    const reveil = lancements("Antoine").find((m) => m.startsWith("Tu étais en veille."));
    expect(reveil).toMatch(/Essais pas encore adoptés \(1\), calculés par le lanceur à l'instant :\n- lignes-2 \(Claude, ouvert il y a \d+ min : deux lignes corrigés dans le fragment\)/);
    for (const m of lancements("Claude")) expect(m).not.toContain("Essais pas encore adoptés");
  }, 30_000);

  // La recette, réveillée par un ticket après une longue veille, ne sort pas « passes épuisées ».
  test("K12 : un réveil remet les passes à une ; deux tours sans se rendormir après le réveil ne font pas sortir l'agent", async () => {
    const fin = { type: "agent_end" };
    process.env.ESSAIM_FIXTURE = ecrire("dort", DORMIR);
    process.env.ESSAIM_FIXTURE_ANTOINE_PASSE_1 = ecrire("antoine", [appel("t1", "ticket_ouvrir", { type: "amelioration", titre: "lot", description: "d", charge: "Bernard" }),
      { type: "faux:attendre", chemin: "{RUN}/bernard-dort" }, { type: "faux:dormir", ms: 300 }, appel("p1", "salle_poster", { texte: "Bernard : reprends le lot, il reste les pages 10 à 12" }),
      { type: "faux:attendre", chemin: "{RUN}/bernard-fini" }, ...DORMIR]);
    process.env.ESSAIM_FIXTURE_BERNARD_PASSE_1 = ecrire("b1", [fin]);
    process.env.ESSAIM_FIXTURE_BERNARD_PASSE_2 = ecrire("b2", [fin]);
    process.env.ESSAIM_FIXTURE_BERNARD_PASSE_3 = ecrire("b3", [{ type: "faux:toucher", chemin: "{RUN}/bernard-dort" }, ...DORMIR]);
    process.env.ESSAIM_FIXTURE_BERNARD_PASSE_4 = ecrire("b4", [fin]);
    process.env.ESSAIM_FIXTURE_BERNARD_PASSE_5 = ecrire("b5", [fin]);
    process.env.ESSAIM_FIXTURE_BERNARD_PASSE_6 = ecrire("b6", [{ type: "faux:toucher", chemin: "{RUN}/bernard-fini" }, ...DORMIR]);
    const b = await lancerJeu();
    const r = lireRun(b.run);
    const bernard = r.get<{ etat: string; raison_sortie: string | null }>("SELECT etat, raison_sortie FROM agents WHERE nom = 'Bernard'")!;
    r.fermer();
    expect(bernard.raison_sortie).not.toBe("passes épuisées");
    expect(readFileSync(join(b.run, "journal", "Bernard.args"), "utf8").trim().split("\n")).toHaveLength(6);
  }, 30_000);

  test("paliers : un seul message pour le plus haut palier franchi, signé lanceur, qui ne réveille que le répartiteur", async () => {
    process.env.ESSAIM_FIXTURE = ecrire("dort", DORMIR);
    process.env.ESSAIM_FIXTURE_CLAUDE = ecrire("cher", [coute(0.8), { type: "faux:dormir", ms: 1500 }, ...DORMIR]);
    const b = await lancerJeu();
    const r = lireRun(b.run);
    const messages = r.all<{ texte: string }>("SELECT texte FROM messages WHERE auteur = 'lanceur' AND texte LIKE '%palier%'");
    const paliers = r.all<{ resultat_resume: string }>("SELECT resultat_resume FROM evenements WHERE type = 'palier'");
    const reveils = r.all<{ agent: string; resultat_resume: string }>("SELECT agent, resultat_resume FROM evenements WHERE type = 'reveil' AND resultat_resume LIKE 'réveillé par lanceur%'");
    r.fermer();
    expect(paliers.map((p) => p.resultat_resume)).toEqual(["palier 75 % : Antoine prévenu"]);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.texte).toStartWith("Antoine : palier de 75 % du budget atteint. dépensé 0,80 $ sur 1,00 $, reste 0,20 $");
    expect(messages[0]!.texte).not.toContain("?");
    expect(reveils.map((x) => x.agent)).toEqual(["Antoine"]);
  }, 30_000);

  test("ronde : les constructeurs qui dorment sans rien attendre sont signalés au répartiteur ; qui attend ne l'est pas ; au plus trois rondes sans effet", async () => {
    process.env.ESSAIM_RONDE_MS = "400";
    process.env.ESSAIM_FIXTURE = ecrire("dort", DORMIR);
    process.env.ESSAIM_FIXTURE_CLAUDE = ecrire("attend", [appel("d1", "moi_dormir", { message: "lot lu", attend: "la contre-lecture d'Edmond" }), appel("d2", "moi_dormir", { message: "lot lu", attend: "la contre-lecture d'Edmond" }), fin]);
    process.env.ESSAIM_FIXTURE_EDMOND = ecrire("occupe", [{ type: "faux:dormir", ms: 6000 }, ...DORMIR]); // la salle ne dort pas entière
    const b = await lancerJeu();
    const r = lireRun(b.run);
    const rondes = r.all<{ resultat_resume: string }>("SELECT resultat_resume FROM evenements WHERE type = 'ronde'");
    const texte = r.get<{ texte: string }>("SELECT texte FROM messages WHERE auteur = 'lanceur' AND texte LIKE '%ronde du lanceur%' ORDER BY id LIMIT 1")?.texte ?? "";
    const reveils = r.all<{ agent: string }>("SELECT DISTINCT agent FROM evenements WHERE type = 'reveil' AND resultat_resume LIKE 'réveillé par lanceur%'");
    r.fermer();
    expect(rondes.length).toBeGreaterThanOrEqual(1);
    expect(rondes.length).toBeLessThanOrEqual(3);
    expect(rondes[0]!.resultat_resume).toBe("ronde : Antoine prévenu, disponibles Bernard, Denis");
    expect(texte).toStartWith("Antoine : ronde du lanceur, des constructeurs dorment sans rien attendre. Constructeurs qui n'attendent rien : Bernard (");
    expect(texte).not.toContain("Claude");
    expect(reveils.map((x) => x.agent)).toEqual(["Antoine"]);
  }, 30_000);

  test("ronde (A1) : une attente vague ne cache pas le dormeur ; elle est citée avec lui", async () => {
    process.env.ESSAIM_RONDE_MS = "400";
    process.env.ESSAIM_FIXTURE = ecrire("dort", DORMIR);
    const vague = [appel("d1", "moi_dormir", { message: "lot lu", attend: "une nouvelle part d'Antoine" }), appel("d2", "moi_dormir", { message: "lot lu", attend: "une nouvelle part d'Antoine" }), fin];
    process.env.ESSAIM_FIXTURE_DENIS = ecrire("vague", vague);
    process.env.ESSAIM_FIXTURE_EDMOND = ecrire("occupe", [{ type: "faux:dormir", ms: 6000 }, ...DORMIR]);
    const b = await lancerJeu();
    const r = lireRun(b.run);
    const rondes = r.all<{ resultat_resume: string }>("SELECT resultat_resume FROM evenements WHERE type = 'ronde'");
    const texte = r.get<{ texte: string }>("SELECT texte FROM messages WHERE auteur = 'lanceur' AND texte LIKE '%ronde du lanceur%' ORDER BY id LIMIT 1")?.texte ?? "";
    r.fermer();
    expect(rondes[0]!.resultat_resume).toBe("ronde : Antoine prévenu, disponibles Bernard, Claude, Denis");
    expect(texte).toMatch(/Denis \(\d+ min, attente vague : une nouvelle part d'Antoine\)/);
  }, 30_000);

  test("ronde : un répartiteur qui répond, même sans confier de travail, n'est plus relancé pour la même liste (S1, B1)", async () => {
    process.env.ESSAIM_RONDE_MS = "300";
    process.env.ESSAIM_FIXTURE = ecrire("dort", DORMIR);
    process.env.ESSAIM_FIXTURE_ANTOINE = ecrire("repond", [appel("p1", "salle_poster", { texte: "rien à confier pour l'instant" }), ...DORMIR]);
    process.env.ESSAIM_FIXTURE_EDMOND = ecrire("occupe", [{ type: "faux:dormir", ms: 5000 }, ...DORMIR]);
    const b = await lancerJeu();
    const r = lireRun(b.run);
    const rondes = r.all<{ resultat_resume: string }>("SELECT resultat_resume FROM evenements WHERE type = 'ronde'").map((x) => x.resultat_resume);
    r.fermer();
    expect(rondes.length).toBeGreaterThanOrEqual(1); // une ronde par liste : la liste peut grandir le temps que chacun s'endorme
    expect(new Set(rondes).size).toBe(rondes.length);
  }, 30_000);

  test("ronde : rien au-delà de 90 % du plafond", async () => {
    process.env.ESSAIM_RONDE_MS = "300";
    process.env.ESSAIM_FIXTURE = ecrire("dort", DORMIR);
    process.env.ESSAIM_FIXTURE_EDMOND = ecrire("cher-occupe", [coute(0.92), { type: "faux:dormir", ms: 3000 }, ...DORMIR]);
    const b = await lancerJeu();
    const r = lireRun(b.run);
    const n = r.get<{ n: number }>("SELECT count(*) AS n FROM evenements WHERE type = 'ronde'")!.n;
    r.fermer();
    expect(n).toBe(0);
  }, 30_000);

  test("sans rôles : ni palier ni ronde", async () => {
    process.env.ESSAIM_RONDE_MS = "300";
    process.env.ESSAIM_FIXTURE = ecrire("cher", [coute(0.6), appel("f1", "moi_finir", { raison: "fait" }), fin]);
    const { lancer } = await import("../src/lancer.ts");
    const b = await lancer({ agents: 2, modele: "faux", plafond: 2, mission: join(racineDepot, "tests", "fixtures", "hello-world.md"), racine, sansBacASable: true });
    const r = lireRun(b.run);
    const n = r.get<{ n: number }>("SELECT count(*) AS n FROM evenements WHERE type IN ('palier', 'ronde')")!.n;
    r.fermer();
    expect(n).toBe(0);
  }, 30_000);

  test("dernière chance : toute la salle dort avec un ticket ouvert ; le répartiteur est réveillé une fois, puis la salle se ferme", async () => {
    process.env.ESSAIM_FIXTURE = ecrire("dort", DORMIR);
    process.env.ESSAIM_FIXTURE_ANTOINE = ecrire("ouvre", [appel("t1", "ticket_ouvrir", { type: "amelioration", titre: "lire les pages 510 à 524", description: "sur l'image" }), ...DORMIR]);
    process.env.ESSAIM_FIXTURE_PASSE_2 = process.env.ESSAIM_FIXTURE; // réveillé, Antoine se rendort sans rien changer
    const b = await lancerJeu("\n## Vérification\n\nfalse\n"); // pas acceptable : la salle endormie est incomplète
    const r = lireRun(b.run);
    const rondes = r.all<{ resultat_resume: string }>("SELECT resultat_resume FROM evenements WHERE type = 'ronde'");
    const texte = r.get<{ texte: string }>("SELECT texte FROM messages WHERE auteur = 'lanceur' ORDER BY id LIMIT 1")?.texte ?? "";
    r.fermer();
    expect(rondes).toHaveLength(1);
    expect(rondes[0]!.resultat_resume).toStartWith("dernière chance : Antoine prévenu");
    expect(texte).toContain("Antoine : toute la salle dort alors qu'il reste du travail et de l'argent.");
    expect(texte).toContain("#1 « lire les pages 510 à 524 »");
    expect(b.etat).toBe("incomplet");
  }, 30_000);

  test("dernière chance (A2, A3) : les exigences pas encore tenues, avec ce que la recette a déclaré, et la charge de chaque porteur", async () => {
    const m = join(racine, "mission-application.md");
    writeFileSync(m, "# Un compteur\n\nUne page avec un bouton qui compte les clics.\n\n## Type\n\napplication\n\n## C'est fini quand\n\nTrois clics affichent 3.\n\n## Vérification\n\nfalse\n");
    const phrases = phrasesNumerotees(readFileSync(m, "utf8")).map((p) => p.n);
    process.env.ESSAIM_FIXTURE = ecrire("dort", DORMIR);
    process.env.ESSAIM_FIXTURE_ANTOINE = ecrire("range", [appel("r1", "exigence_ranger", { phrases, classement: "exigence", responsable: "recette" }),
      appel("t1", "ticket_ouvrir", { type: "amelioration", titre: "corriger", description: "d", charge: "Claude" }), { type: "faux:toucher", chemin: "{RUN}/range" }, ...DORMIR]);
    process.env.ESSAIM_FIXTURE_PASSE_2 = process.env.ESSAIM_FIXTURE; // réveillés, tous se rendorment sans rien changer
    process.env.ESSAIM_FIXTURE_GASTON = ecrire("declare", [{ type: "faux:attendre", chemin: "{RUN}/range" },
      appel("a1", "preuve_attester", { exigence: "E1", non_verifiee: true, portee: "315 trous restants sur 26 288 ?" }), ...DORMIR]);
    const { lancer } = await import("../src/lancer.ts");
    const b = await lancer({ agents: 8, modele: "faux", plafond: 1, mission: m, racine, sansBacASable: true });
    const r = lireRun(b.run);
    const roles = Object.fromEntries(r.all<{ nom: string; role: string }>("SELECT nom, role FROM agents").map((a) => [a.nom, a.role]));
    const texte = r.get<{ texte: string }>("SELECT texte FROM messages WHERE auteur = 'lanceur' AND texte LIKE '%toute la salle dort%' ORDER BY id LIMIT 1")?.texte ?? "";
    r.fermer();
    expect([roles.Antoine, roles.Claude, roles.Gaston]).toEqual(["chef", "constructeur", "recette"]);
    expect(texte).toContain(" Tickets ouverts par porteur : Claude 1.");
    expect(texte).toMatch(/ Exigences pas encore tenues : E1 \(non vérifiée : 315 trous restants sur 26 288 \)(, E\d+ \((non vérifiée : 315 trous restants sur 26 288 |à prouver)\))*\./);
    expect(texte).not.toContain("?");
  }, 30_000);

  test("dernière chance : un répartiteur qui ouvre un ticket à chaque réveil sans le confier n'est réveillé que trois fois", async () => {
    process.env.ESSAIM_FIXTURE = ecrire("dort", DORMIR);
    process.env.ESSAIM_FIXTURE_ANTOINE = ecrire("ouvre", [appel("t1", "ticket_ouvrir", { type: "amelioration", titre: "lire", description: "sur l'image" }), ...DORMIR]);
    const b = await lancerJeu("\n## Vérification\n\nfalse\n");
    const r = lireRun(b.run);
    const n = r.get<{ n: number }>("SELECT count(*) AS n FROM evenements WHERE type = 'ronde'")!.n;
    r.fermer();
    expect(n).toBe(3);
    expect(b.etat).toBe("incomplet");
  }, 30_000);

  test("A6 (02/10) : une consigne déposée par la vue est postée au répartiteur, signée lanceur, sans « ? » ; elle le réveille, l'historique dit lu et sa réponse", async () => {
    process.env.ESSAIM_FIXTURE = ecrire("dort", DORMIR);
    // Antoine s'endort d'abord (sinon il lit la consigne sans être réveillé, sous charge) ; Claude attend le signal.
    process.env.ESSAIM_FIXTURE_ANTOINE = ecrire("dort-signale", [appel("d1", "moi_dormir", { message: "rien pour l'instant" }), { type: "faux:toucher", chemin: "{RUN}/antoine-dort" }, fin]);
    process.env.ESSAIM_FIXTURE_CLAUDE = ecrire("depose", [{ type: "faux:attendre", chemin: "{RUN}/antoine-dort" }, { type: "faux:dormir", ms: 300 }, { type: "faux:ecrire", chemin: "{RUN}/consignes/0.txt/piege", contenu: "un dossier, pas une consigne" }, { type: "faux:ecrire", chemin: "{RUN}/consignes/1.txt", contenu: "relis le texte des pages 510 à 600, pas seulement les fins ?" }, { type: "faux:dormir", ms: 2000 }, ...DORMIR]); // éveillé le temps qu'Antoine réponde : sinon la salle endormie est jugée avant
    process.env.ESSAIM_FIXTURE_ANTOINE_PASSE_2 = ecrire("repond", [appel("p1", "salle_poster", { texte: "Denis : prends les pages 510 à 524" }), ...DORMIR]);
    const b = await lancerJeu();
    const r = lireRun(b.run);
    const message = r.get<{ texte: string }>("SELECT texte FROM messages WHERE auteur = 'lanceur' AND texte LIKE '%consigne%'")?.texte;
    const evenement = r.get<{ resultat_resume: string }>("SELECT resultat_resume FROM evenements WHERE type = 'consigne'")?.resultat_resume;
    const reveils = r.all<{ agent: string }>("SELECT DISTINCT agent FROM evenements WHERE type = 'reveil' AND resultat_resume LIKE 'réveillé par lanceur%'").map((x) => x.agent);
    const historique = T.consignes(r);
    r.fermer();
    expect(message).toBe("Antoine : consigne : relis le texte des pages 510 à 600, pas seulement les fins");
    expect(evenement).toStartWith("consigne à Antoine (message ");
    expect(reveils).toEqual(["Antoine"]);
    expect(historique).toHaveLength(1);
    expect(historique[0]).toMatchObject({ destinataire: "Antoine", texte: "relis le texte des pages 510 à 600, pas seulement les fins", reponse: { texte: "Denis : prends les pages 510 à 524" } });
    expect(historique[0]!.lu_le).not.toBeNull();
    expect(existsSync(join(b.run, "consignes", "1.txt"))).toBe(false);
  }, 30_000);

  // ---- Préparer la mission ----
  const lance = (run: string, nom: string) => existsSync(join(run, "journal", `${nom}.args`));
  const plans = (run: string) => { const r = lireRun(run); const e = r.all<{ resultat_resume: string }>("SELECT resultat_resume FROM evenements WHERE type = 'plan' ORDER BY id").map((x) => x.resultat_resume); r.fermer(); return e; };

  test("préparation : les constructeurs attendent en veille ; le plan proposé puis validé par la recette ouvre la construction", async () => {
    process.env.ESSAIM_FIXTURE = ecrire("dort", DORMIR);
    // La spec d'abord, validée, puis le plan ; le plan avant la spec est refusé.
    process.env.ESSAIM_FIXTURE_ANTOINE = ecrire("propose", [{ type: "faux:ecrire", chemin: "{PARTAGE}/SPEC.md", contenu: "# Spec" }, { type: "faux:ecrire", chemin: "{PARTAGE}/PLAN.md", contenu: "# Plan" },
      appel("p0", "plan_proposer", { etape: "plan", resume: "trop tôt" }), appel("p1", "plan_proposer", { etape: "spec", resume: "le but, l'approche" }), { type: "faux:toucher", chemin: "{RUN}/spec" },
      { type: "faux:attendre", chemin: "{RUN}/spec-ok" }, appel("p2", "plan_proposer", { etape: "plan", resume: "trois tickets" }), { type: "faux:toucher", chemin: "{RUN}/plan" }, ...DORMIR]);
    process.env.ESSAIM_FIXTURE_EDMOND = ecrire("juge", [{ type: "faux:attendre", chemin: "{RUN}/spec" }, appel("j1", "plan_juger", { plan: 1, verdict: "valide", raison: "chaque exigence a sa commande" }), { type: "faux:toucher", chemin: "{RUN}/spec-ok" },
      { type: "faux:attendre", chemin: "{RUN}/plan" }, appel("j2", "plan_juger", { plan: 2, verdict: "valide", raison: "chaque partie a son ticket" }), ...DORMIR]);
    const b = await lancerJeu("", true);
    expect(plans(b.run)[0]).toBe("préparation ouverte : 3 constructeurs en veille, Antoine prévenu");
    expect(plans(b.run)).toContain("spec n°1 validée");
    expect(plans(b.run)).toContain("plan n°2 validé : la construction commence");
    const resultats = (() => { const r = lireRun(b.run); const x = r.all<{ r: string }>("SELECT resultat_resume AS r FROM evenements WHERE agent = 'Antoine' AND outil = 'plan_proposer' AND type = 'tool_execution_end' ORDER BY id").map((e) => e.r); r.fermer(); return x; })();
    expect(resultats[0]).toStartWith("refusé : la spec n'est pas encore validée.");
    for (const n of ["Bernard", "Claude", "Denis"]) expect(lance(b.run, n)).toBe(false); // jamais lancés : aucun ticket
    const r = lireRun(b.run);
    expect(r.get<{ p: string }>("SELECT preparation AS p FROM run")!.p).toBe("validee");
    expect(r.get<{ n: number }>("SELECT count(*) AS n FROM agents WHERE attend = ?", [T.ATTENTE_PLAN])!.n).toBe(0);
    r.fermer();
  }, 30_000);

  test("préparation : la direction exploite un constructeur par un ticket d'exploration, qui le réveille", async () => {
    process.env.ESSAIM_FIXTURE = ecrire("dort", DORMIR);
    process.env.ESSAIM_FIXTURE_ANTOINE = ecrire("explore", [appel("t1", "ticket_ouvrir", { type: "question", titre: "essayer la lecture sur 5 pages", description: "mesurer le temps", charge: "Claude" }), ...DORMIR]);
    const b = await lancerJeu("", true);
    expect(lance(b.run, "Claude")).toBe(true);
    expect(lance(b.run, "Bernard")).toBe(false);
  }, 30_000);

  test("préparation : close par le lanceur à 25 % du plafond sans plan validé", async () => {
    process.env.ESSAIM_FIXTURE = ecrire("dort", DORMIR);
    process.env.ESSAIM_FIXTURE_ANTOINE = ecrire("cher", [coute(0.3), { type: "faux:dormir", ms: 1500 }, ...DORMIR]);
    const b = await lancerJeu("", true);
    expect(plans(b.run)).toContain("préparation close sans plan validé (25 % du plafond)");
  }, 30_000);

  // Sur un modèle gratuit, la dépense reste à 0 $ ; la préparation est close par la durée.
  test("P2 : préparation close par le lanceur après ESSAIM_PREPARATION_MAX_MS sans plan validé, même à 0 $ dépensé", async () => {
    process.env.ESSAIM_PREPARATION_MAX_MS = "1";
    try {
      process.env.ESSAIM_FIXTURE = ecrire("dort", DORMIR);
      process.env.ESSAIM_FIXTURE_ANTOINE = ecrire("gratuit", [{ type: "faux:dormir", ms: 1500 }, ...DORMIR]);
      const b = await lancerJeu("", true);
      expect(plans(b.run).some((p) => /^préparation close sans plan validé \(\d+ min\)$/.test(p))).toBe(true);
      const r = lireRun(b.run);
      expect(r.get<{ p: string }>("SELECT preparation AS p FROM run")!.p).toBe("close");
      expect(r.get<{ n: number }>("SELECT count(*) AS n FROM messages WHERE auteur = 'lanceur' AND texte LIKE '%minutes sont passées sans plan validé%'")!.n).toBe(1);
      r.fermer();
    } finally { delete process.env.ESSAIM_PREPARATION_MAX_MS; }
  }, 30_000);
});
