// Rôles des agents : deux sortes de tickets (travail, alerte), des motifs de clôture vérifiés
// dans la transaction du ticket, la reproduction figée d'une alerte et la demande de rejeu (servie par le lanceur). Sans motif, la clôture d'un ticket reste celle d'avant.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ouvrirBun } from "../src/tableau-bun.ts";
import * as T from "../src/tableau.ts";
import { raisonAuFormat } from "./aide/refus.ts";

let dossier: string, t: T.Tableau;
const H1 = "1111111111111111111111111111111111111111", H2 = "2222222222222222222222222222222222222222";
const REPRO: T.Reproduction = { commande: "bun test banc.test.ts", graine: "42", commit: H1, banc: { "/b/banc.test.ts": "aa" }, monde: { "clients.json": "bb" } };

beforeEach(() => {
  dossier = mkdtempSync(join(tmpdir(), "essaim-alertes-"));
  t = ouvrirBun(join(dossier, "tableau.sqlite"));
  T.initialiser(t);
});
afterEach(() => {
  t.fermer();
  rmSync(dossier, { recursive: true, force: true });
});

const travail = (chemins: string[] = ["moteur.js"], charge = "Claude") =>
  T.ouvrirTicket(t, { type: "amelioration", titre: "le moteur", description: "d", auteur: "Antoine", charge, chemins });
const alerte = (charge?: string) =>
  T.ouvrirTicket(t, { type: "bug", titre: "la cuisson dure 3 min", description: "d", auteur: "Fabien", charge, sorte: "alerte", reproduction: REPRO });
const refus = (r: { ok: boolean; raison?: string }) => { expect(r.ok).toBe(false); expect(raisonAuFormat(r.raison!), r.raison).toBe(true); return r.raison; };

describe("le schéma (tâche 1)", () => {
  test("MOTIFS : cinq motifs, trois pour le travail, deux pour une alerte", () => {
    expect([...T.MOTIFS]).toEqual(["livre", "remplace_par", "annule", "corrige", "invalide"]);
    expect(T.MOTIFS_PAR_SORTE).toEqual({ travail: ["livre", "remplace_par", "annule"], alerte: ["corrige", "invalide"] });
  });

  test("un ticket ouvert sans sorte est un ticket de travail, sans motif ni reproduction", () => {
    const k = T.lireTicket(t, travail())!;
    expect(k).toMatchObject({ sorte: "travail", motif: null, remplace_par: null, reproduction: null, bloque_par: null });
  });

  test("une alerte garde sa reproduction figée ; l'ouverture le dit dans la note et le fait", () => {
    const id = alerte("Claude");
    const k = T.lireTicket(t, id)!;
    expect(k.sorte).toBe("alerte");
    expect(T.reproductionDuTicket(k)).toEqual(REPRO);
    expect(k.notes[0]!.texte).toBe("ouvert (alerte), confié à Claude");
    expect(t.get<{ texte: string }>("SELECT texte FROM faits WHERE type = 'ticket'")!.texte).toStartWith(`ticket #${id} ouvert · alerte · bug · confié à Claude`);
    // Aucun changement ne touche la reproduction : ni un transfert, ni une note.
    T.majTicket(t, id, "Antoine", { charge: "Denis", note: "à toi" });
    expect(T.reproductionDuTicket(T.lireTicket(t, id)!)).toEqual(REPRO);
  });

  test("la table des demandes de rejeu existe, vide", () => {
    expect(T.aTable(t, "demandes_rejeu")).toBe(true);
    expect(t.all("SELECT * FROM demandes_rejeu")).toEqual([]);
  });
});

describe("les motifs de clôture, dans la transaction du ticket (tâche 1)", () => {
  test("livre : exige un commit qui touche un chemin du ticket (cas 14b15f1 du restaurant-5)", () => {
    const id = travail(["moteur.js", "rendu/"]);
    expect(refus(T.majTicket(t, id, "Claude", { motif: "livre" }))).toBe("un ticket livré sans commit. Se lève avec le commit de main qui touche un de ses chemins");
    expect(refus(T.majTicket(t, id, "Claude", { motif: "livre", commit: H1, fichiers: ["carte.js", "README.md"] })))
      .toBe(`le commit 1111111 ne touche aucun chemin du ticket #${id} (moteur.js, rendu/). Se lève avec un commit qui touche l'un d'eux`);
    expect(T.lireTicket(t, id)!.etat).toBe("ouvert");
    expect(T.majTicket(t, id, "Claude", { motif: "livre", commit: H2, fichiers: ["rendu/ombres.js"] })).toEqual({ ok: true });
    const k = T.lireTicket(t, id)!;
    expect(k).toMatchObject({ etat: "ferme", motif: "livre", commit_ferme: H2 });
    expect(k.notes.at(-1)!.texte).toBe("fermé (livré) par le commit 2222222");
    expect(t.get<{ texte: string }>("SELECT texte FROM faits WHERE type = 'ticket' ORDER BY id DESC")!.texte)
      .toBe(`ticket #${id} fermé (livré) · commit 2222222 constaté dans le dossier commun · par Claude`);
  });

  test("livre : un ticket sans chemin ne se livre pas", () => {
    const id = T.ouvrirTicket(t, { type: "bug", titre: "x", description: "y", auteur: "Antoine", charge: "Claude" });
    expect(refus(T.majTicket(t, id, "Claude", { motif: "livre", commit: H1, fichiers: ["a.js"] })))
      .toBe(`le ticket #${id} n'a aucun chemin confié. Se lève quand un chemin lui est confié, ou avec remplace_par ou annule`);
  });

  test("remplace_par : un successeur ouvert, de travail, avec un chargé, en une transition", () => {
    const id = travail();
    const sansCharge = T.ouvrirTicket(t, { type: "amelioration", titre: "b", description: "d", auteur: "Antoine" });
    const al = alerte("Claude");
    const bon = travail(["rendu.js"], "Denis");
    expect(refus(T.majTicket(t, id, "Antoine", { motif: "remplace_par" }))).toBe("remplace_par sans successeur. Se lève avec le numéro du ticket qui le remplace");
    expect(refus(T.majTicket(t, id, "Antoine", { motif: "remplace_par", remplacePar: 99 }))).toBe("aucun ticket #99. Définitif pour ce numéro");
    expect(refus(T.majTicket(t, id, "Antoine", { motif: "remplace_par", remplacePar: id }))).toBe("un ticket ne se remplace pas par lui-même. Définitif pour ce numéro");
    expect(refus(T.majTicket(t, id, "Antoine", { motif: "remplace_par", remplacePar: sansCharge }))).toBe(`le ticket #${sansCharge} n'a pas de chargé. Se lève quand il est confié à un agent`);
    expect(refus(T.majTicket(t, id, "Antoine", { motif: "remplace_par", remplacePar: al }))).toBe(`le ticket #${al} est une alerte. Se lève avec un ticket de travail`);
    T.majTicket(t, sansCharge, "Antoine", { charge: "Denis" });
    T.majTicket(t, sansCharge, "Antoine", { motif: "annule", note: "doublon" });
    expect(refus(T.majTicket(t, id, "Antoine", { motif: "remplace_par", remplacePar: sansCharge }))).toBe(`le ticket #${sansCharge} est fermé. Se lève avec un successeur ouvert`);
    expect(T.majTicket(t, id, "Antoine", { motif: "remplace_par", remplacePar: bon })).toEqual({ ok: true });
    expect(T.lireTicket(t, id)).toMatchObject({ etat: "ferme", motif: "remplace_par", remplace_par: bon });
    expect(T.lireTicket(t, id)!.notes.at(-1)!.texte).toBe(`fermé (remplacé par #${bon})`);
  });

  test("annule : avec une raison ; déjà fermé, un second motif est refusé", () => {
    const id = travail();
    expect(refus(T.majTicket(t, id, "Antoine", { motif: "annule" }))).toBe("un ticket annulé sans raison. Se lève avec une note non vide");
    expect(T.majTicket(t, id, "Antoine", { motif: "annule", note: "la mission ne le demande pas" })).toEqual({ ok: true });
    expect(T.lireTicket(t, id)).toMatchObject({ etat: "ferme", motif: "annule" });
    expect(T.lireTicket(t, id)!.notes.at(-1)!.texte).toBe("fermé (annulé) ; la mission ne le demande pas");
    expect(refus(T.majTicket(t, id, "Antoine", { motif: "annule", note: "encore" }))).toBe(`le ticket #${id} est déjà fermé. Définitif pour ce numéro`);
  });

  test("un motif d'alerte ne ferme pas un ticket de travail, ni l'inverse", () => {
    const id = travail(), al = alerte("Claude");
    expect(refus(T.majTicket(t, id, "Claude", { motif: "corrige", recu: "preuves/1.json" }))).toBe("le motif corrige ne ferme pas un ticket de travail. Se lève avec livre, remplace_par ou annule");
    expect(refus(T.majTicket(t, al, "Claude", { motif: "livre", commit: H1, fichiers: ["moteur.js"] }))).toBe("le motif livre ne ferme pas une alerte. Se lève avec corrige ou invalide");
  });

  test("une alerte ne se ferme que sur le reçu du lanceur : ni par son état, ni par un motif seul", () => {
    const al = alerte("Claude");
    const raison = "une alerte se ferme sur le reçu du lanceur. Se lève quand le rejeu demandé par corrige ou invalide passe";
    expect(refus(T.majTicket(t, al, "Claude", { etat: "ferme", commit: H2 }))).toBe(raison);
    expect(refus(T.majTicket(t, al, "Claude", { motif: "corrige" }))).toBe(raison);
    expect(T.lireTicket(t, al)!.etat).toBe("ouvert");
    // Le lanceur ferme avec le reçu.
    expect(T.majTicket(t, al, "essaim", { motif: "corrige", recu: "preuves/1.json" })).toEqual({ ok: true });
    expect(T.lireTicket(t, al)).toMatchObject({ etat: "ferme", motif: "corrige" });
    expect(T.lireTicket(t, al)!.notes.at(-1)!.texte).toBe("fermé (corrigé) sur le reçu preuves/1.json");
  });

  test("transférer, rendre, bloqué par : jamais une clôture", () => {
    const id = travail(), autre = travail(["rendu.js"], "Denis");
    expect(refus(T.majTicket(t, id, "Antoine", { bloquePar: 99 }))).toBe("aucun ticket #99. Définitif pour ce numéro");
    expect(refus(T.majTicket(t, id, "Antoine", { bloquePar: id }))).toBe("un ticket ne se bloque pas lui-même. Définitif pour ce numéro");
    expect(T.majTicket(t, id, "Antoine", { bloquePar: autre })).toEqual({ ok: true });
    expect(T.majTicket(t, id, "Claude", { charge: "Antoine" })).toEqual({ ok: true });
    const k = T.lireTicket(t, id)!;
    expect(k).toMatchObject({ etat: "ouvert", motif: null, bloque_par: autre, charge: "Antoine" });
    expect(k.notes.map((n) => n.texte).slice(1)).toEqual([`bloqué par #${autre}`, "confié à Antoine"]);
  });

  test("sans motif, la clôture d'avant : un bug ferme sur un commit, une question sur sa réponse, sans motif gardé", () => {
    const bug = T.ouvrirTicket(t, { type: "bug", titre: "x", description: "y", auteur: "Antoine" });
    expect(T.majTicket(t, bug, "Bernard", { etat: "ferme" })).toEqual({ ok: false, raison: T.raisonSansCommit("bug") });
    expect(T.majTicket(t, bug, "Bernard", { etat: "ferme", commit: H1 })).toEqual({ ok: true });
    expect(T.lireTicket(t, bug)).toMatchObject({ etat: "ferme", motif: null, commit_ferme: H1 });
  });
});

describe("la demande de rejeu, dans le tableau (tâche 2)", () => {
  test("corrige : refusée au même commit que la reproduction ; déposée sur un autre, l'alerte reste ouverte", () => {
    const al = alerte("Claude");
    expect(refus(T.demanderRejeu(t, { ticket: al, demandeur: "Claude", motif: "corrige", commit: H1 })))
      .toBe("le produit n'a pas changé depuis l'alerte. Se lève avec un commit qui change le produit, ou une contre-preuve aux mêmes conditions (invalide)");
    expect(T.demanderRejeu(t, { ticket: al, demandeur: "Claude", motif: "corrige", commit: H2 })).toEqual({ ok: true, id: 1 });
    expect(t.all("SELECT ticket_id, exigence, motif, commande, graine, commit_produit, demandeur, etat, recu FROM demandes_rejeu")).toEqual([
      { ticket_id: al, exigence: null, motif: "corrige", commande: "bun test banc.test.ts", graine: "42", commit_produit: H2, demandeur: "Claude", etat: "attente", recu: null }]);
    expect(T.lireTicket(t, al)!.etat).toBe("ouvert");
    expect(T.lireTicket(t, al)!.notes.at(-1)!.texte).toBe("demande de rejeu #1 déposée (corrige), produit au commit 2222222 ; l'alerte reste ouverte jusqu'au reçu du lanceur");
    expect(refus(T.demanderRejeu(t, { ticket: al, demandeur: "Claude", motif: "corrige", commit: H2 })))
      .toBe(`une demande de rejeu de l'alerte #${al} attend le lanceur. Se lève quand le lanceur a rendu son reçu`);
  });

  test("invalide : une contre-preuve aux mêmes conditions (graine de la reproduction), même au commit de l'alerte", () => {
    const al = alerte();
    expect(refus(T.demanderRejeu(t, { ticket: al, demandeur: "Denis", motif: "invalide", commit: H1 })))
      .toBe("une invalidation sans contre-preuve. Se lève avec contre_preuve, la commande rejouée aux mêmes conditions");
    expect(T.demanderRejeu(t, { ticket: al, demandeur: "Denis", motif: "invalide", commit: H1, contrePreuve: "bun test contre.test.ts" })).toMatchObject({ ok: true });
    expect(t.get("SELECT motif, commande, graine, commit_produit FROM demandes_rejeu")).toEqual({ motif: "invalide", commande: "bun test contre.test.ts", graine: "42", commit_produit: H1 });
    expect(T.lireTicket(t, al)!.notes.at(-1)!.texte).toBe("demande de rejeu #1 déposée (invalide), produit au commit 1111111 ; contre-preuve : bun test contre.test.ts ; l'alerte reste ouverte jusqu'au reçu du lanceur");
  });

  test("refus : un ticket de travail, une alerte fermée, un ticket inconnu", () => {
    const id = travail(), al = alerte();
    expect(refus(T.demanderRejeu(t, { ticket: id, demandeur: "Claude", motif: "corrige", commit: H2 }))).toBe("le motif corrige ne ferme pas un ticket de travail. Se lève avec livre, remplace_par ou annule");
    T.majTicket(t, al, "essaim", { motif: "corrige", recu: "preuves/1.json" });
    expect(refus(T.demanderRejeu(t, { ticket: al, demandeur: "Claude", motif: "corrige", commit: H2 }))).toBe(`le ticket #${al} est déjà fermé. Définitif pour ce numéro`);
    expect(refus(T.demanderRejeu(t, { ticket: 99, demandeur: "Claude", motif: "corrige", commit: H2 }))).toBe("aucun ticket #99. Définitif pour ce numéro");
    expect(t.all("SELECT * FROM demandes_rejeu")).toEqual([]);
  });
});

// ---- Les outils : l'extension chargée avec un rôle, sur un vrai dépôt git ---------------------------------
import { mkdirSync, writeFileSync } from "node:fs";
import { fauxPi } from "./aide/faux-extension-api.ts";
import extension from "../src/outils-essaim.ts";
import * as D from "../src/depot.ts";
import { blobGit } from "../src/memoire.ts";
import { refusAlerte, refusMotif, type Membre } from "../src/roles.ts";

const APPLICATION: Array<[string, string]> = [["Antoine", "chef"], ["Bernard", "integrateur"], ["Claude", "constructeur"], ["Denis", "constructeur"], ["Fabien", "recette"], ["Gilles", "gardien"]];
const ENV = ["ESSAIM_AGENT", "ESSAIM_TABLEAU", "ESSAIM_PARTAGE", "ESSAIM_BUREAU", "ESSAIM_ROLE", "ESSAIM_TOUR_MS"];

describe("les outils : alertes, motifs, rejeu (tâche 2)", () => {
  let run: string, partage: string, chemin: string, envAvant: Record<string, string | undefined> = {};
  // L'extension chargée pour un agent ; role : ESSAIM_ROLE (absent : run sans rôles).
  const instance = (agent: string, role?: string) => {
    Object.assign(process.env, { ESSAIM_AGENT: agent, ESSAIM_TABLEAU: chemin, ESSAIM_PARTAGE: partage, ESSAIM_BUREAU: join(run, "agents", agent) });
    if (role) process.env.ESSAIM_ROLE = role; else delete process.env.ESSAIM_ROLE;
    const faux = fauxPi();
    extension(faux.api, ouvrirBun);
    return faux;
  };
  const role = (nom: string) => APPLICATION.find(([n]) => n === nom)![1];
  const par = (nom: string) => instance(nom, role(nom));
  const main = async () => (await D.contenuDans(partage, "main") as { hash: string }).hash;
  // Un commit de Claude dans main ; rend son hash complet (commiter rend le court).
  const commit = async (fichier: string, contenu: string) => {
    writeFileSync(join(partage, fichier), contenu);
    await D.commiter(partage, "Claude", `write ${fichier}`);
    return main();
  };
  const fil = () => t.all<{ texte: string }>("SELECT m.texte FROM messages m JOIN fils f ON f.id = m.fil_id WHERE f.nom = 'tickets' ORDER BY m.id").map((m) => m.texte);

  beforeEach(async () => {
    envAvant = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    process.env.ESSAIM_TOUR_MS = "0";
    run = join(dossier, "run");
    partage = join(run, "partage");
    chemin = join(dossier, "tableau.sqlite");
    await D.ouvrirDepot(partage);
    mkdirSync(join(run, "entrees"), { recursive: true });
    writeFileSync(join(run, "entrees", "clients.json"), "[1, 2, 3]\n");
    T.ouvrirRun(t, { id: "run-test", missionChemin: "m.md", missionTexte: "texte", modele: "faux/faux", plafondUsd: 0.5, silenceMin: 15 });
    for (const [nom, r] of APPLICATION) { mkdirSync(join(run, "agents", nom), { recursive: true }); T.ajouterAgent(t, nom, join(run, "agents", nom), undefined, undefined, { role: r }); }
    writeFileSync(join(run, "agents", "Fabien", "banc.test.ts"), "test('cuisson', () => {})\n");
  });
  afterEach(() => { for (const [k, v] of Object.entries(envAvant)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });

  test("refusAlerte et refusMotif : la recette et le gardien ouvrent ; le chef annule, ne ferme pas une alerte", () => {
    const equipe: Membre[] = APPLICATION.map(([nom, r]) => ({ nom, role: r }));
    expect(refusAlerte("recette")).toBeUndefined();
    expect(refusAlerte("gardien")).toBeUndefined();
    for (const r of ["chef", "integrateur", "constructeur"] as const) expect(refusAlerte(r)).toBe("une alerte s'ouvre par la recette ou le gardien-mesureur. Définitif pour ce rôle");
    expect(refusAlerte(undefined)).toBe("aucune alerte dans un run sans rôles. Définitif pour ce run");
    expect(refusMotif("chef", "annule", equipe)).toBeUndefined();
    expect(refusMotif("constructeur", "annule", equipe)).toBe("les tickets s'annulent par le chef (Antoine). Définitif pour ce rôle");
    expect(refusMotif("chef", "corrige", equipe)).toBe("le chef ne ferme pas une alerte. Définitif pour ce rôle");
    expect(refusMotif("chef", "invalide", equipe)).toBe("le chef ne ferme pas une alerte. Définitif pour ce rôle");
    expect(refusMotif("constructeur", "corrige", equipe)).toBeUndefined();
    expect(refusMotif("constructeur", "livre", equipe)).toBeUndefined();
    expect(refusMotif(undefined, "livre", [])).toBe("les motifs de clôture valent dans un run à rôles. Définitif pour ce run");
    for (const r of ["refusé : une alerte s'ouvre par la recette ou le gardien-mesureur. Définitif pour ce rôle.", "refusé : les tickets s'annulent par le chef (Antoine). Définitif pour ce rôle."])
      expect(raisonAuFormat(r.slice("refusé : ".length, -1))).toBe(true);
  });

  test("ticket_ouvrir alerte : la recette ouvre, l'outil relève la reproduction (banc, monde, commit de main) et la fige", async () => {
    const h = await main();
    const r = await par("Fabien").texte("ticket_ouvrir", { type: "bug", titre: "la cuisson dure 3 min", description: "le plat sort trop tôt", charge: "Claude", sorte: "alerte",
      reproduction: { commande: "bun test banc.test.ts", graine: "7", banc: ["banc.test.ts"] } });
    expect(r).toBe("ticket #1 ouvert, posté dans le fil tickets");
    const k = T.lireTicket(t, 1)!;
    expect(k.sorte).toBe("alerte");
    expect(T.reproductionDuTicket(k)).toEqual({ commande: "bun test banc.test.ts", graine: "7", commit: h,
      banc: { [join(run, "agents", "Fabien", "banc.test.ts")]: blobGit(Buffer.from("test('cuisson', () => {})\n")) },
      monde: { "clients.json": blobGit(Buffer.from("[1, 2, 3]\n")) } });
    expect(fil()).toEqual([`[ticket #1 · alerte · bug] la cuisson dure 3 min — confié à Claude : le plat sort trop tôt (reproduction : bun test banc.test.ts, graine 7, main ${h.slice(0, 7)} ; reproduction essayée : échoue (code 1))`]);
    expect(await par("Fabien").texte("ticket_lister", {})).toBe("#1 · alerte · bug · ouvert · Fabien → Claude · la cuisson dure 3 min");
    expect(await par("Fabien").texte("ticket_lire", { id: 1 })).toContain(`reproduction : bun test banc.test.ts · graine 7 · main ${h.slice(0, 7)} · banc : 1 fichier · monde : 1 fichier`);
  });

  // Sorties incomplètes : une reproduction qui montre le défaut (elle passe tant qu'il est là) n'est jamais fermée par
  // corrige, qui ferme quand le rejeu passe : l'alerte resterait ouverte à jamais.
  test("ticket_ouvrir alerte : une reproduction qui passe déjà est refusée (sens inversé) ; qui échoue, ouverte ; délai dépassé, ouverte", async () => {
    await commit("texte.jsonl", '{"key":"018:041","text":"Ton jardin deviendra"}\n');
    const inversee = `grep -q '"key":"018:041","text":"Ton jardin' texte.jsonl`;
    expect(await par("Fabien").texte("ticket_ouvrir", { type: "bug", titre: "frontière 18:40/41", description: "d", sorte: "alerte", reproduction: { commande: inversee } }))
      .toBe("refusé : ta reproduction passe déjà sur le produit actuel : elle doit échouer tant que le défaut est là et passer une fois corrigé, car corrige ferme l'alerte quand le rejeu passe. Se lève avec une reproduction qui échoue.");
    expect(T.listerTickets(t)).toEqual([]);
    expect(await par("Fabien").texte("ticket_ouvrir", { type: "bug", titre: "frontière 18:40/41", description: "d", sorte: "alerte", reproduction: { commande: `! ${inversee}` } }))
      .toBe("ticket #1 ouvert, posté dans le fil tickets");
    expect(fil()[0]).toEndWith("; reproduction essayée : échoue (code 1))");
    // La graine passe dans GRAINE, comme au rejeu du lanceur.
    expect(await par("Fabien").texte("ticket_ouvrir", { type: "bug", titre: "g", description: "d", sorte: "alerte", reproduction: { commande: 'test "$GRAINE" = 7', graine: "7" } }))
      .toStartWith("refusé : ta reproduction passe déjà");
    process.env.ESSAIM_ESSAI_REPRO_MS = "200";
    try {
      expect(await par("Fabien").texte("ticket_ouvrir", { type: "bug", titre: "lent", description: "d", sorte: "alerte", reproduction: { commande: "sleep 5" } }))
        .toBe("ticket #2 ouvert, posté dans le fil tickets");
      expect(fil()[1]).toEndWith("; reproduction essayée : délai dépassé)");
    } finally { delete process.env.ESSAIM_ESSAI_REPRO_MS; }
    expect(raisonAuFormat("ta reproduction passe déjà sur le produit actuel : elle doit échouer tant que le défaut est là et passer une fois corrigé, car corrige ferme l'alerte quand le rejeu passe. Se lève avec une reproduction qui échoue")).toBe(true);
  });

  test("ticket_ouvrir : refus d'une alerte hors de la recette et du gardien, sans reproduction, banc introuvable ; sorte inconnue ; sans rôles", async () => {
    const repro = { commande: "bun test x" };
    expect(await par("Claude").texte("ticket_ouvrir", { type: "bug", titre: "a", description: "d", sorte: "alerte", reproduction: repro }))
      .toBe("refusé : une alerte s'ouvre par la recette ou le gardien-mesureur. Définitif pour ce rôle.");
    expect(await par("Antoine").texte("ticket_ouvrir", { type: "bug", titre: "a", description: "d", sorte: "alerte", reproduction: repro }))
      .toBe("refusé : une alerte s'ouvre par la recette ou le gardien-mesureur. Définitif pour ce rôle.");
    expect(await par("Gilles").texte("ticket_ouvrir", { type: "bug", titre: "a", description: "d", sorte: "alerte" }))
      .toBe("refusé : une alerte sans reproduction. Se lève avec reproduction.commande non vide.");
    expect(await par("Gilles").texte("ticket_ouvrir", { type: "bug", titre: "a", description: "d", sorte: "alerte", reproduction: { commande: "x", banc: ["absent.js"] } }))
      .toBe("refusé : absent.js est introuvable. Se lève avec un fichier ou un dossier qui existe.");
    expect(await par("Fabien").texte("ticket_ouvrir", { type: "bug", titre: "a", description: "d", sorte: "urgent" })).toBe("refusé : sorte urgent inconnue. Se lève avec travail ou alerte.");
    expect(await par("Fabien").texte("ticket_ouvrir", { type: "bug", titre: "a", description: "d", reproduction: repro })).toBe("refusé : une reproduction sans alerte. Se lève avec sorte alerte.");
    expect(await instance("Fabien").texte("ticket_ouvrir", { type: "bug", titre: "a", description: "d", sorte: "alerte", reproduction: repro }))
      .toBe("refusé : aucune alerte dans un run sans rôles. Définitif pour ce run.");
    expect(T.listerTickets(t)).toEqual([]);
  });

  test("livre : un commit sans rapport est refusé (cas 14b15f1) ; le commit qui touche la part ferme, les pancartes vont au chef", async () => {
    await par("Antoine").texte("ticket_ouvrir", { type: "amelioration", titre: "le moteur", description: "d", charge: "Claude", chemins: ["moteur.js"] });
    const claude = par("Claude");
    const sans = await commit("carte.js", "x\n");
    expect(await claude.texte("ticket_modifier", { id: 1, motif: "livre", commit: sans }))
      .toStartWith(`refusé : le commit ${sans.slice(0, 7)} ne touche aucun chemin du ticket #1 (moteur.js). Se lève avec un commit qui touche l'un d'eux.\n[salle] pour toi : message 1 de Antoine (tickets)`); // l'annonce du ticket, une fois
    // Dans un run à rôles, fermer un bug ou une amélioration par son état, c'est livrer : même contrôle.
    expect(await claude.texte("ticket_modifier", { id: 1, etat: "ferme", commit: sans }))
      .toBe(`refusé : le commit ${sans.slice(0, 7)} ne touche aucun chemin du ticket #1 (moteur.js). Se lève avec un commit qui touche l'un d'eux.`);
    expect(await claude.texte("ticket_modifier", { id: 1, motif: "livre" })).toBe("refusé : un ticket livré sans commit. Se lève avec le commit de main qui touche un de ses chemins.");
    const bon = await commit("moteur.js", "boucle\n");
    expect(await claude.texte("ticket_modifier", { id: 1, motif: "livre", commit: bon })).toBe(`ticket #1 : fermé (livré) par le commit ${bon.slice(0, 7)}`);
    expect(T.lireTicket(t, 1)).toMatchObject({ etat: "ferme", motif: "livre", commit_ferme: bon });
    expect(T.reclamations(t).map((r) => [r.chemin, r.agent])).toEqual([["moteur.js", "Antoine"]]);
    expect(await claude.texte("ticket_lister", {})).toBe(`#1 · amelioration · ferme (livré) · Antoine → Claude · le moteur (corrigé par ${bon.slice(0, 7)}) · chemins : moteur.js`);
  });

  test("remplace_par, annule (chef seul), bloque_par ; un motif inconnu ou avec un autre état est refusé", async () => {
    const chef = par("Antoine");
    await chef.texte("ticket_ouvrir", { type: "amelioration", titre: "a", description: "d", charge: "Claude", chemins: ["a.js"] });
    await chef.texte("ticket_ouvrir", { type: "amelioration", titre: "b", description: "d", charge: "Denis", chemins: ["b.js"] });
    await chef.texte("ticket_ouvrir", { type: "amelioration", titre: "c", description: "d", charge: "Denis", chemins: ["c.js"] });
    const claude = par("Claude");
    expect(await claude.texte("ticket_modifier", { id: 1, motif: "fini" })).toStartWith("refusé : motif fini inconnu. Se lève avec livre, remplace_par, annule, corrige ou invalide.\n[salle] pour toi : message 1 de Antoine (tickets)");
    expect(await claude.texte("ticket_modifier", { id: 1, motif: "livre", etat: "en_cours" })).toBe("refusé : un motif ferme le ticket, l'état en_cours le laisse ouvert. Se lève sans etat, ou avec etat ferme.");
    expect(await claude.texte("ticket_modifier", { id: 1, motif: "annule", note: "inutile" })).toBe("refusé : les tickets s'annulent par le chef (Antoine). Définitif pour ce rôle.");
    expect(await claude.texte("ticket_modifier", { id: 1, bloque_par: 2 })).toBe("ticket #1 : bloqué par #2");
    expect(T.lireTicket(t, 1)).toMatchObject({ etat: "ouvert", bloque_par: 2 });
    expect(await claude.texte("ticket_modifier", { id: 1, motif: "remplace_par", remplace_par: 2 })).toBe("ticket #1 : fermé (remplacé par #2)");
    expect(await chef.texte("ticket_modifier", { id: 3, motif: "annule", note: "la mission ne le demande pas" })).toBe("ticket #3 : fermé (annulé) ; la mission ne le demande pas");
    expect(T.listerTickets(t).map((k) => [k.id, k.etat, k.motif])).toEqual([[1, "ferme", "remplace_par"], [2, "ouvert", null], [3, "ferme", "annule"]]);
  });

  test("corrige : refusé au chef et au même commit ; après un commit, la demande de rejeu est déposée, l'alerte reste ouverte", async () => {
    await par("Fabien").texte("ticket_ouvrir", { type: "bug", titre: "cuisson", description: "d", charge: "Claude", sorte: "alerte", reproduction: { commande: "bun test banc.test.ts", graine: "7" } });
    expect(await par("Antoine").texte("ticket_modifier", { id: 1, motif: "corrige" })).toBe("refusé : le chef ne ferme pas une alerte. Définitif pour ce rôle.");
    const claude = par("Claude");
    expect(await claude.texte("ticket_modifier", { id: 1, motif: "corrige" }))
      .toStartWith("refusé : le produit n'a pas changé depuis l'alerte. Se lève avec un commit qui change le produit, ou une contre-preuve aux mêmes conditions (invalide).\n[salle] pour toi : message 1 de Fabien (tickets)");
    expect(await claude.texte("ticket_modifier", { id: 1, etat: "ferme", commit: await main() }))
      .toBe("refusé : une alerte se ferme sur le reçu du lanceur. Se lève quand le rejeu demandé par corrige ou invalide passe.");
    const h = await commit("cuisson.js", "20 min\n");
    expect(await claude.texte("ticket_modifier", { id: 1, motif: "corrige" }))
      .toBe(`ticket #1 : demande de rejeu #1 déposée (corrige), produit au commit ${h.slice(0, 7)} ; l'alerte reste ouverte jusqu'au reçu du lanceur`);
    expect(T.lireTicket(t, 1)!.etat).toBe("ouvert");
    expect(t.get("SELECT motif, commande, graine, commit_produit, demandeur, etat FROM demandes_rejeu")).toEqual({ motif: "corrige", commande: "bun test banc.test.ts", graine: "7", commit_produit: h, demandeur: "Claude", etat: "attente" });
    expect(fil().at(-1)).toBe(`[ticket #1] cuisson : demande de rejeu #1 déposée (corrige), produit au commit ${h.slice(0, 7)} ; l'alerte reste ouverte jusqu'au reçu du lanceur (chargé : Claude)`);
  });

  test("invalide : la recette dépose une contre-preuve, même sans changement du produit", async () => {
    const fabien = par("Fabien");
    await fabien.texte("ticket_ouvrir", { type: "bug", titre: "cuisson", description: "d", sorte: "alerte", reproduction: { commande: "bun test banc.test.ts" } });
    expect(await fabien.texte("ticket_modifier", { id: 1, motif: "invalide" })).toBe("refusé : une invalidation sans contre-preuve. Se lève avec contre_preuve, la commande rejouée aux mêmes conditions.");
    expect(await fabien.texte("ticket_modifier", { id: 1, motif: "invalide", contre_preuve: "bun test contre.test.ts" })).toStartWith("ticket #1 : demande de rejeu #1 déposée (invalide)");
    expect(t.get("SELECT motif, commande, graine FROM demandes_rejeu")).toEqual({ motif: "invalide", commande: "bun test contre.test.ts", graine: null });
  });

  test("sans rôles : aucun motif ; la clôture d'avant ne change pas", async () => {
    const pi = instance("Claude");
    await pi.texte("ticket_ouvrir", { type: "bug", titre: "a", description: "d" });
    expect(await pi.texte("ticket_modifier", { id: 1, motif: "livre", commit: await main() })).toBe("refusé : les motifs de clôture valent dans un run à rôles. Définitif pour ce run.");
    const h = await commit("x.js", "x\n");
    expect(await pi.texte("ticket_modifier", { id: 1, etat: "ferme", commit: h })).toBe(`ticket #1 : fermé par le commit ${h.slice(0, 7)}`);
    expect(T.lireTicket(t, 1)!.motif).toBeNull();
  });
});

// ---- Qui reprend les tickets d'un sortant ------------------------------------------------------------------
import { heritier, refusConfier, refusDuRole, refusMotif, repartiteur, type Occupant } from "../src/roles.ts";

describe("le transfert à la sortie : qui reprend (tâche 3)", () => {
  const app = (absents: string[] = []): Occupant[] => [
    { nom: "Antoine", role: "chef", present: !absents.includes("Antoine") },
    { nom: "Bernard", role: "integrateur", present: !absents.includes("Bernard") },
    { nom: "Claude", role: "constructeur", suppleantDe: "integrateur", present: !absents.includes("Claude") },
    { nom: "Denis", role: "constructeur", suppleantDe: "chef", present: !absents.includes("Denis") },
    { nom: "Fabien", role: "recette", present: !absents.includes("Fabien") }];
  test("le chef reprend ; si c'est le chef qui sort, son suppléant nommé au lancement", () => {
    expect(heritier(app(["Claude"]), "Claude")).toBe("Antoine");
    expect(heritier(app(["Fabien"]), "Fabien")).toBe("Antoine");
    expect(heritier(app(["Antoine"]), "Antoine")).toBe("Denis");
  });
  test("sans chef (jeu), l'intégrateur reprend, et son suppléant s'il sort", () => {
    const jeu: Occupant[] = [{ nom: "Antoine", role: "integrateur", present: true }, { nom: "Bernard", role: "constructeur", suppleantDe: "integrateur", present: true }, { nom: "Claude", role: "constructeur", present: false }];
    expect(heritier(jeu, "Claude")).toBe("Antoine");
    expect(heritier(jeu.map((a) => ({ ...a, present: a.nom !== "Antoine" })), "Antoine")).toBe("Bernard");
  });
  test("un chef tombé et remplacé : c'est son successeur, présent, qui reprend (29/09, revue R1)", () => {
    const equipe: Occupant[] = [{ nom: "Antoine", role: "chef", present: false }, { nom: "Bernard", role: "integrateur", present: true },
      { nom: "Claude", role: "constructeur", present: false }, { nom: "Zoe", role: "chef", present: true }];
    expect(heritier(equipe, "Claude")).toBe("Zoe");
    expect(refusConfier("integrateur", equipe)).toContain("le chef (Zoe)");
  });
  test("chef tombé sans relance : son suppléant tient le siège, confie, annule et pose des pancartes ; un autre non (30/09, D2)", () => {
    const equipe: Occupant[] = [{ nom: "Antoine", role: "chef", present: false }, { nom: "Bernard", role: "integrateur", present: true },
      { nom: "Claude", role: "constructeur", present: true }, { nom: "Denis", role: "constructeur", suppleantDe: "chef", present: true }];
    expect(repartiteur(equipe)).toMatchObject({ nom: "Denis", role: "chef" });
    expect(refusConfier("constructeur", equipe, "Denis")).toBeUndefined();
    expect(refusConfier("constructeur", equipe, "Claude")).toBe("les parts se confient par le chef (Denis). Définitif pour ce rôle");
    expect(refusMotif("constructeur", "annule", equipe, "Denis")).toBeUndefined();
    expect(refusMotif("constructeur", "annule", equipe, "Claude")).toContain("le chef (Denis)");
    expect(refusDuRole("constructeur", "fichier_reclamer", undefined, { agent: "Denis", equipe, pancartes: [] })).toBeUndefined();
    expect(heritier(equipe, "Claude")).toBe("Denis");
    // le chef présent, le suppléant n'est qu'un constructeur
    const avecChef = equipe.map((a) => (a.nom === "Antoine" ? { ...a, present: true } : a));
    expect(refusConfier("constructeur", avecChef, "Denis")).toBe("les parts se confient par le chef (Antoine). Définitif pour ce rôle");
  });
  test("personne : repreneur déjà sorti, type fichier, run sans rôles", () => {
    expect(heritier(app(["Claude", "Antoine"]), "Claude")).toBe("Denis"); // le chef tombé, son suppléant présent reprend
    expect(heritier(app(["Claude", "Antoine", "Denis"]), "Claude")).toBeUndefined(); // ni chef ni suppléant présents : personne
    expect(heritier(app(["Antoine", "Denis"]), "Antoine")).toBeUndefined();
    expect(heritier([{ nom: "Antoine", role: "constructeur", present: false }], "Antoine")).toBeUndefined();
    expect(heritier([{ nom: "agent-01", role: null, present: false }, { nom: "agent-02", role: null, present: true }], "agent-01")).toBeUndefined();
  });
});
