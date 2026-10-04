// La sonde de vivacité : bun sondes/vivacite.ts <run>.
// <run> est un dossier de run, ou un identifiant pris dans runs/ du dépôt courant. Lecture seule de tableau.sqlite :
// compte les impasses d'un run, la mesure avant/après de l'agent disponible et des refus qui se lèvent.
// - veilles acceptées (moi_dormir rendu « en veille ») et réveils (événements reveil) ;
// - réveils par liste : le message qui a réveillé (cité tronqué dans l'événement) s'adresse (T.sAdresseA) à trois
//   membres de l'équipe ou plus ;
// - refus « une fois » par outil, et parmi eux les répétés : même agent, même outil, même texte qu'un refus déjà dit ;
// - agents à court de veilles (refus « N veilles déjà prises ») ;
// - agents « perdus : passes épuisées » sans ticket ouvert : aucun ticket passé au remplaçant (événement succession)
//   ni transféré (note « transféré de X ») ; et les relèves de ces agents.
// Sortie : 0 mesure écrite, 2 run introuvable ou illisible. Aucune écriture.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ouvrirBun } from "../src/tableau-bun.ts";
import * as T from "../src/tableau.ts";

export type Vivacite = {
  veilles: number; reveils: number; reveilsParListe: number;
  refusUneFois: Record<string, number>; refusRepetes: Record<string, number>;
  courtDeVeilles: string[]; perdusSansTicket: string[]; releves: string[];
};

export function mesurer(argument: string, racine = process.cwd()): Vivacite {
  const dossier = [resolve(argument), join(racine, "runs", argument)].find((d) => existsSync(join(d, "tableau.sqlite")));
  if (!dossier) throw new Error(`aucun tableau.sqlite pour « ${argument} » (ni dossier de run, ni identifiant dans ${join(racine, "runs")})`);
  const t = ouvrirBun(join(dossier, "tableau.sqlite"), { lectureSeule: true });
  try {
    const fins = (outil: string) => t.all<{ agent: string; r: string }>(
      "SELECT agent, COALESCE(resultat_resume, '') AS r FROM evenements WHERE type = 'tool_execution_end' AND outil = ? ORDER BY id", [outil]);
    const dormir = fins("moi_dormir"), finir = fins("moi_finir");
    const veilles = dormir.filter((e) => e.r.startsWith("en veille")).length;

    const equipe = t.all<{ nom: string; surnom: string | null }>("SELECT nom, surnom FROM agents");
    const designes = (texte: string) => equipe.filter((a) => [a.nom, a.surnom].some((m) => m && T.sAdresseA(texte, m))).length;
    const reveils = t.all<{ r: string }>("SELECT COALESCE(resultat_resume, '') AS r FROM evenements WHERE type = 'reveil'");
    const cite = (r: string) => { const i = r.indexOf(" : "); return i < 0 ? "" : r.slice(i + 3); };
    const reveilsParListe = reveils.filter((e) => designes(cite(e.r)) >= 3).length;

    const refusUneFois: Record<string, number> = {}, refusRepetes: Record<string, number> = {};
    for (const [outil, evs] of [["moi_dormir", dormir], ["moi_finir", finir]] as const) {
      const dits = new Set<string>();
      for (const e of evs) {
        if (!e.r.startsWith("refusé une fois")) continue;
        refusUneFois[outil] = (refusUneFois[outil] ?? 0) + 1;
        const cle = `${e.agent}\n${e.r}`;
        if (dits.has(cle)) refusRepetes[outil] = (refusRepetes[outil] ?? 0) + 1;
        dits.add(cle);
      }
    }
    const courtDeVeilles = [...new Set(dormir.filter((e) => /^refusé : \d+ veilles déjà prises/.test(e.r)).map((e) => e.agent))];

    const successions = t.all<{ agent: string; r: string }>("SELECT agent, COALESCE(resultat_resume, '') AS r FROM evenements WHERE type = 'succession' AND resultat_resume LIKE 'siège%'");
    const transferts = t.all<{ texte: string }>("SELECT texte FROM ticket_notes WHERE texte LIKE 'transféré%'").map((n) => n.texte);
    const perdus = t.all<{ nom: string }>("SELECT nom FROM agents WHERE etat = 'perdu' AND raison_sortie = 'passes épuisées'").map((a) => a.nom);
    const reprisDe = (nom: string) => successions.filter((s) => s.r.includes(`repris ${T.deNom(nom)} (`));
    const perdusSansTicket = perdus.filter((nom) => !reprisDe(nom).some((s) => s.r.includes("· tickets"))
      && !transferts.some((x) => x.startsWith(`transféré ${T.deNom(nom)} `)));
    const releves = perdusSansTicket.flatMap((nom) => reprisDe(nom).map((s) => `${s.agent} (relève ${T.deNom(nom)})`));
    return { veilles, reveils: reveils.length, reveilsParListe, refusUneFois, refusRepetes, courtDeVeilles, perdusSansTicket, releves };
  } finally {
    t.fermer();
  }
}

export function formater(v: Vivacite): string {
  const liste = (xs: string[]) => (xs.length ? ` : ${xs.join(", ")}` : "");
  return [
    `veilles acceptées : ${v.veilles}`,
    `réveils : ${v.reveils}`,
    `réveils par un message qui s'adresse à trois agents ou plus : ${v.reveilsParListe}`,
    ...["moi_dormir", "moi_finir"].map((o) => `${o} refusé une fois : ${v.refusUneFois[o] ?? 0} (dont ${v.refusRepetes[o] ?? 0} répétés pour une même situation)`),
    `agents à court de veilles : ${v.courtDeVeilles.length}${liste(v.courtDeVeilles)}`,
    `perdus « passes épuisées » sans ticket ouvert : ${v.perdusSansTicket.length}${liste(v.perdusSansTicket)}`,
    `relèves de ces agents : ${v.releves.length}${liste(v.releves)}`,
  ].join("\n");
}

if (import.meta.main) {
  const run = process.argv[2];
  if (!run) { console.error("usage : bun sondes/vivacite.ts <run>"); process.exit(2); }
  try {
    console.log(formater(mesurer(run)));
  } catch (e) {
    console.error(String((e as Error).message ?? e));
    process.exit(2);
  }
}
