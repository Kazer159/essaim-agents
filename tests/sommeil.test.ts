// Les veilles : cinq par agent sans rôles ; sans limite pour tous les sièges d'un run à rôles.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ouvrirBun } from "../src/tableau-bun.ts";
import * as T from "../src/tableau.ts";
import { fauxPi } from "./aide/faux-extension-api.ts";
import extension from "../src/outils-essaim.ts";
import { veillesSansLimite } from "../src/roles.ts";

let dossier: string;
let chemin: string;
let t: T.Tableau;

function instance(agent: string, role?: string) {
  Object.assign(process.env, { ESSAIM_AGENT: agent, ESSAIM_TABLEAU: chemin, ESSAIM_PARTAGE: join(dossier, "partage"), ESSAIM_BUREAU: join(dossier, "agents", agent) });
  if (role) process.env.ESSAIM_ROLE = role; else delete process.env.ESSAIM_ROLE;
  const faux = fauxPi();
  extension(faux.api, ouvrirBun);
  return faux;
}

beforeEach(() => {
  process.env.ESSAIM_TOUR_MS = "0";
  dossier = mkdtempSync(join(tmpdir(), "essaim-sommeil-"));
  chemin = join(dossier, "tableau.sqlite");
  mkdirSync(join(dossier, "partage"));
  t = ouvrirBun(chemin);
  T.initialiser(t);
  T.ouvrirRun(t, { id: "run-test", missionChemin: "m.md", missionTexte: "texte", modele: "faux/faux", plafondUsd: 0.5, silenceMin: 15 });
  for (const [nom, role] of [["Antoine", "chef"], ["Bernard", "constructeur"], ["Claude", "constructeur"], ["Denis", "recette"], ["Edmond", "integrateur"], ["Fabien", "gardien"]])
    T.ajouterAgent(t, nom!, join(dossier, "agents", nom!), undefined, undefined, { role: role! });
});
afterEach(() => {
  for (const k of ["ESSAIM_TOUR_MS", "ESSAIM_ROLE", "ESSAIM_AGENT", "ESSAIM_TABLEAU", "ESSAIM_PARTAGE", "ESSAIM_BUREAU"]) delete process.env[k];
  t.fermer();
  rmSync(dossier, { recursive: true, force: true });
});

// n veilles de suite ; le lanceur réveille l'agent entre deux (T.reveiller). Rend la réponse de la dernière.
async function veiller(agent: string, role: string | undefined, n: number): Promise<string> {
  let r = "";
  for (let i = 1; i <= n; i++) {
    r = await instance(agent, role).texte("moi_dormir", { message: `veille ${i}` });
    if (r.startsWith("refusé")) return r;
    T.reveiller(t, agent);
  }
  return r;
}

describe("les veilles (28/09)", () => {
  test("cinquième veille acceptée pour tous : sans rôles, constructeur sans ticket, chef", async () => {
    expect(await veiller("Claude", undefined, 5)).toContain("en veille (5/5)");
    expect(await veiller("Bernard", "constructeur", 5)).toContain("en veille (5, sans limite pour ton rôle)"); // sans limite pour tous les sièges
    expect(await veiller("Antoine", "chef", 5)).toContain("en veille (5, sans limite pour ton rôle)");
  });

  // Un constructeur sans ticket veille sans limite.
  test("sixième veille refusée sans rôles, acceptée à un constructeur sans ticket ; le refus ne poste rien", async () => {
    expect(await veiller("Claude", undefined, 6)).toBe("refusé : 5 veilles déjà prises dans ce run. Définitif pour ce run.");
    expect(await veiller("Bernard", "constructeur", 6)).toContain("en veille (6, sans limite pour ton rôle)");
    expect(t.get<{ n: number }>("SELECT count(*) AS n FROM messages")?.n).toBe(11);
  });

  test("sixième veille acceptée pour le chef et pour un constructeur qui tient un ticket ouvert", async () => {
    expect(await veiller("Antoine", "chef", 6)).toContain("en veille (6, sans limite pour ton rôle)");
    T.ouvrirTicket(t, { type: "bug", titre: "carte vide", description: "index.html", auteur: "Antoine", charge: "Bernard" });
    // Le rappel des tickets refuse une fois par lancement ; le même appel passe : la veille compte à la seconde.
    for (let i = 1; i <= 6; i++) {
      const pi = instance("Bernard", "constructeur");
      const un = await pi.texte("moi_dormir", { message: `veille ${i}` });
      const r = un.startsWith("refusé une fois") ? await pi.texte("moi_dormir", { message: `veille ${i}` }) : un;
      expect(r).toContain(`en veille (${i}, sans limite pour ton rôle)`);
      T.reveiller(t, "Bernard");
    }
    expect(T.sommeils(t, "Bernard")).toBe(6);
  });

  test("l'intégrateur, la recette et le gardien-mesureur veillent sans limite", async () => {
    for (const [nom, role] of [["Edmond", "integrateur"], ["Denis", "recette"], ["Fabien", "gardien"]] as const)
      expect(await veiller(nom, role, 7)).toContain("en veille (7, sans limite pour ton rôle)");
  });

  test("veillesSansLimite : tous les rôles, constructeur sans ticket compris (29/09) ; jamais sans rôles", () => {
    expect(["chef", "integrateur", "recette", "gardien"].every((r) => veillesSansLimite(r as never, 0))).toBe(true);
    expect(veillesSansLimite("constructeur", 0)).toBe(true);
    expect(veillesSansLimite("constructeur", 1)).toBe(true);
    expect(veillesSansLimite(undefined, 3)).toBe(false);
  });
});

// Les refus « une fois » tenus par le tableau : dans un run à rôles, la mémoire d'un refus survit à
// la relance de pi, et la situation qui compte est celle de l'agent, pas celle de la salle.
describe("les refus une fois dans un run à rôles (29/09)", () => {
  // Partir sans demander : Bernard demande au chef s'il reste du travail, le chef répond.
  const demandeEtReponse = () => { T.poster(t, "Bernard", "Antoine : reste-t-il du travail pour moi ?"); T.poster(t, "Antoine", "Bernard : pas pour l'instant"); };
  // Deux refus en 8 s, la salle ayant bougé entre les deux appels.
  test("V2 : constructeur sans ticket, moi_finir refusé une fois ; la salle bouge ; le second appel, autres arguments, est accepté", async () => {
    T.ouvrirTicket(t, { type: "bug", titre: "carte vide", description: "index.html", auteur: "Antoine", charge: "Claude" });
    demandeEtReponse();
    const pi = instance("Bernard", "constructeur");
    expect(await pi.texte("moi_finir", { raison: "ma part est faite" })).toStartWith("refusé une fois : des tickets restent ouverts dans la salle.");
    T.ouvrirTicket(t, { type: "amelioration", titre: "ombres", description: "scene.js", auteur: "Antoine", charge: "Claude" });
    T.ouvrirTicket(t, { type: "question", titre: "quel moteur ?", description: "three ?", auteur: "Denis" });
    T.poster(t, "Antoine", "Claude/Denis/Edmond : priorité au moteur");
    T.poster(t, "Denis", "Edmond, la page s'ouvre-t-elle chez toi ?");
    const r = await pi.appeler("moi_finir", { raison: "rien ne m'est confié, je pars", fichier: "index.html" }) as { terminate?: boolean };
    expect(r.terminate).toBe(true);
    expect(T.equipe(t).find((a) => a.nom === "Bernard")?.etat).toBe("fini");
  });

  test("V2 : un message qui s'adresse à lui ou un ticket qui lui est confié depuis le refus refait le rappel", async () => {
    T.ouvrirTicket(t, { type: "bug", titre: "carte vide", description: "index.html", auteur: "Antoine", charge: "Claude" });
    demandeEtReponse();
    const pi = instance("Bernard", "constructeur");
    expect(await pi.texte("moi_finir", { raison: "fait" })).toStartWith("refusé une fois : des tickets restent ouverts dans la salle.");
    T.poster(t, "Antoine", "Bernard : reprends la carte avec Claude");
    expect(await pi.texte("moi_finir", { raison: "fait" })).toStartWith("refusé une fois : des tickets restent ouverts dans la salle.");
    T.ouvrirTicket(t, { type: "bug", titre: "légende", description: "index.html", auteur: "Antoine", charge: "Bernard" });
    expect(await pi.texte("moi_finir", { raison: "fait" })).toStartWith("refusé : un ticket ouvert t'est confié (#2)."); // le refus du rôle, avant tout rappel
  });

  // Le même rappel ne se rejoue pas à chaque relance de pi.
  test("V4 : moi_dormir refusé une fois pour ses tickets ; relancé (nouvelle instance), il n'est pas refusé une seconde fois", async () => {
    T.ouvrirTicket(t, { type: "bug", titre: "carte vide", description: "index.html", auteur: "Antoine", charge: "Bernard" });
    expect(await instance("Bernard", "constructeur").texte("moi_dormir", { message: "j'attends la recette" })).toStartWith("refusé une fois : ces tickets ouverts te sont confiés.");
    expect(await instance("Bernard", "constructeur").texte("moi_dormir", { message: "j'attends la recette" })).toContain("en veille");
    T.reveiller(t, "Bernard");
    T.ouvrirTicket(t, { type: "bug", titre: "légende", description: "index.html", auteur: "Antoine", charge: "Bernard" });
    expect(await instance("Bernard", "constructeur").texte("moi_dormir", { message: "j'attends" })).toStartWith("refusé une fois : ces tickets ouverts te sont confiés."); // un ticket nouveau refait le rappel
  });
});
