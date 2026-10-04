// Le flux JSON de pi (--mode json), ligne par ligne, et les compteurs par agent
// tenus en mémoire par le lanceur : coût, tokens, appels, échecs, fini vu,
// erreur du fournisseur, dernière activité, outil en cours. Les garde-fous
// lisent ces compteurs, jamais la base.
import type { Tarif } from "./modeles.ts";

export type Ev = { type: string; [k: string]: unknown };

export type EvenementTrace = {
  type: string; outil?: string; appelId?: string; arguments?: unknown; resultat?: string; dureeMs?: number;
  tokensEntree?: number; tokensSortie?: number; coutUsd?: number; erreur?: string;
};

export function analyserLigne(ligne: string): Ev | undefined {
  const l = ligne.trim();
  if (!l.startsWith("{")) return undefined;
  try {
    const o = JSON.parse(l);
    return o && typeof o === "object" && typeof o.type === "string" ? (o as Ev) : undefined;
  } catch {
    return undefined;
  }
}

const tronquer = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

function resumeResultat(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  const r = result as { content?: Array<{ type?: string; text?: string }> };
  if (Array.isArray(r.content)) return r.content.map((c) => c.text ?? "").filter(Boolean).join("\n");
  return JSON.stringify(result);
}

type Usage = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };

export const COMPACTAGE = "compactage"; // l'identifiant de l'« outil » résumé en cours

// Une réponse qui s'emballe : le modèle écrit sans fin sans jamais la finir (par exemple le même appel d'outil des
// milliers de fois). On les reconnaît à la forme de ce qui arrive, pas à la durée. Les morceaux vides d'un appel
// d'outil ne comptent pas : certains modèles en envoient un par dizaine de caractères pendant qu'ils préparent les
// arguments, puis les arguments d'un bloc. Seuls les vides de la pensée et du texte comptent.
export const EMBALLEMENT = {
  appelsIdentiques: Number(process.env.ESSAIM_APPELS_IDENTIQUES ?? 30), // le même appel, mêmes arguments, dans une réponse
  videsDeSuite: Number(process.env.ESSAIM_VIDES_DE_SUITE ?? 300), // des morceaux vides à la suite
  motif: 300, // la longueur du passage dont on cherche les répétitions
  repetitions: 4, // ce passage revu tant de fois dans la mémoire récente : la pensée tourne en boucle
  memoire: 8_000, // la pensée récente gardée pour chercher les répétitions
};

// La plus petite période d'un texte, si elle tient en une ligne courte (60 caractères au plus) ; sinon undefined.
function periodeCourte(t: string): number | undefined {
  for (let p = 1; p <= 60 && p < t.length; p++) if (t.slice(p) === t.slice(0, -p)) return p;
  return undefined;
}

export class Compteur {
  cout = 0;
  coutEstime = false;
  tokensEntree = 0;
  tokensSortie = 0;
  appels = 0;
  echecs = 0;
  finiVu = false;
  erreur?: string;
  derniereActivite: number;
  // Le silence ne se mesure pas au bruit : un agent qui parle sans rien faire n'est pas
  // silencieux au sens du flux, mais il n'avance plus. `dernierProgres` ne bouge que pour un
  // événement qui vaut la peine d'être écrit en base — un outil, un message, une sortie.
  dernierProgres: number;
  outilEnCours?: { id: string; nom: string; depuis: number };
  // se résumer : la note d'un se_resumer réussi, le contexte de la dernière réponse (entrée du dernier message_end),
  // et un compactage en échec. Remis à zéro par le lanceur à chaque passe (nouvellePasse).
  resumeDemande?: string;
  contexte = 0;
  compactageRate = false;
  // La réponse en cours d'écriture : depuis quand, le dernier morceau qui disait quelque chose, et
  // pourquoi elle s'emballe, le cas échéant. Réfléchir longtemps n'est pas un silence ; c'est la répétition
  // qui trahit une boucle.
  reponseDepuis?: number;
  dernierMorceau?: number;
  emballement?: string;
  private appelsVus = new Map<string, number>();
  private videsDeSuite = 0;
  private pensee = "";
  private penseeVerifiee = 0;
  private noteEnCours?: string;
  private debuts = new Map<string, { nom: string; depuis: number }>();

  // tarifFixe : pour un modèle `abonnement: true` de modeles.yaml, le tarif manuel prime sur le prix que pi calcule
  // au tarif public. Un modèle payé par un abonnement (sol-codex, tarif 0) compterait sinon au prix d'OpenRouter,
  // et le plafond couperait la salle pour une dépense qui n'existe pas.
  constructor(private tarif?: Tarif, maintenant = Date.now(), private tarifFixe = false) {
    this.derniereActivite = maintenant;
    this.dernierProgres = maintenant;
  }

  // La machine a dormi : le temps de la veille ne compte ni comme silence ni comme outil bloqué.
  decaler(ms: number): void {
    this.derniereActivite += ms;
    this.dernierProgres += ms;
    if (this.outilEnCours) this.outilEnCours.depuis += ms;
    for (const d of this.debuts.values()) d.depuis += ms;
    if (this.reponseDepuis !== undefined) this.reponseDepuis += ms;
    if (this.dernierMorceau !== undefined) this.dernierMorceau += ms;
  }

  // Reprise après une pause : le processus a été tué, ses outils ouverts ne se fermeront jamais,
  // et le temps de la pause ne compte pas comme silence.
  reprendre(maintenant = Date.now()): void {
    this.debuts.clear();
    this.outilEnCours = undefined;
    this.derniereActivite = maintenant;
    this.dernierProgres = maintenant;
    this.oublierReponse();
  }

  nouvellePasse(): void {
    if (this.outilEnCours?.id === COMPACTAGE) this.outilEnCours = undefined;
    this.oublierReponse();
    this.emballement = undefined;
    this.resumeDemande = undefined;
    this.contexte = 0;
    this.compactageRate = false;
  }

  // Met à jour les compteurs ; renvoie la ligne à tracer en base, ou undefined si l'événement n'a pas d'intérêt.
  absorber(ev: Ev, maintenant = Date.now()): EvenementTrace | undefined {
    this.derniereActivite = maintenant;
    const trace = this.absorberInterne(ev, maintenant);
    if (trace) this.dernierProgres = maintenant; // seul ce qui s'écrit en base compte comme progrès
    return trace;
  }

  private oublierReponse(): void {
    this.reponseDepuis = undefined;
    this.dernierMorceau = undefined;
    this.appelsVus.clear();
    this.videsDeSuite = 0;
    this.pensee = "";
    this.penseeVerifiee = 0;
  }

  // Un morceau de la réponse en cours. Renvoie la trace de l'emballement, une seule fois, quand il est constaté.
  private morceau(e: { type?: string; delta?: unknown; toolCall?: { name?: string; arguments?: unknown } }, maintenant: number): EvenementTrace | undefined {
    if (this.emballement) return undefined;
    this.reponseDepuis ??= maintenant;
    let raison: string | undefined;
    if (e.type === "toolcall_end" && e.toolCall) {
      const cle = `${e.toolCall.name}:${JSON.stringify(e.toolCall.arguments ?? null)}`;
      const n = (this.appelsVus.get(cle) ?? 0) + 1;
      this.appelsVus.set(cle, n);
      if (n >= EMBALLEMENT.appelsIdentiques) raison = `${n} appels identiques à ${e.toolCall.name} dans une même réponse`;
    } else if (typeof e.delta === "string") {
      if (e.delta === "") {
        if (e.type !== "toolcall_delta" && ++this.videsDeSuite >= EMBALLEMENT.videsDeSuite) raison = `${this.videsDeSuite} morceaux vides à la suite`;
      } else {
        this.videsDeSuite = 0;
        this.dernierMorceau = maintenant;
        if (e.type === "thinking_delta" || e.type === "text_delta") raison = this.penser(e.delta);
      }
    }
    if (!raison) return undefined;
    this.emballement = raison;
    return { type: "emballement", resultat: `réponse emballée : ${raison}` };
  }

  // La pensée qui tourne en boucle : le dernier passage revient plusieurs fois dans la mémoire récente.
  private penser(texte: string): string | undefined {
    const E = EMBALLEMENT;
    this.pensee = (this.pensee + texte).slice(-E.memoire);
    this.penseeVerifiee += texte.length;
    if (this.penseeVerifiee < E.motif || this.pensee.length < E.motif * E.repetitions) return undefined;
    this.penseeVerifiee = 0;
    const motif = this.pensee.slice(-E.motif);
    // Un motif à courte période : une grille « 0, 0, 0 », un séparateur « ---- » reviennent sans que la pensée
    // tourne ; ils ne comptent que s'ils remplissent toute la mémoire récente (« wait, wait, wait… » sans fin).
    const p = periodeCourte(motif);
    if (p) return this.pensee.length >= E.memoire && this.pensee.slice(p) === this.pensee.slice(0, -p) ? `la même pensée revient ${Math.floor(this.pensee.length / p)} fois de suite` : undefined;
    let n = 0; // sans chevauchement : un passage compte une fois
    for (let i = this.pensee.indexOf(motif); i !== -1; i = this.pensee.indexOf(motif, i + E.motif)) n++;
    return n >= E.repetitions ? `la même pensée revient ${n} fois de suite` : undefined;
  }

  private absorberInterne(ev: Ev, maintenant: number): EvenementTrace | undefined {
    switch (ev.type) {
      case "message_update":
        return this.morceau((ev.assistantMessageEvent ?? {}) as Parameters<Compteur["morceau"]>[0], maintenant);
      case "tool_execution_start": {
        const id = String(ev.toolCallId), nom = String(ev.toolName);
        this.debuts.set(id, { nom, depuis: maintenant });
        this.outilEnCours = { id, nom, depuis: maintenant };
        this.appels++;
        if (nom === "moi_resumer") this.noteEnCours = String((ev.args as { note?: unknown } | undefined)?.note ?? "");
        return { type: ev.type, outil: nom, appelId: id, arguments: tronquer(JSON.stringify(ev.args ?? null), 4000) }; // la vue replie à 200, on garde de quoi lire
      }
      case "tool_execution_end": {
        const id = String(ev.toolCallId), nom = String(ev.toolName);
        const debut = this.debuts.get(id);
        this.debuts.delete(id);
        const resume = tronquer(resumeResultat(ev.result), 4000);
        const enErreur = ev.isError === true;
        if (enErreur) this.echecs++;
        // un refus de `moi_finir` (livrable malade, tickets ou travail ouvert) n'est pas un départ
        if (nom === "moi_finir" && !enErreur && !resume.startsWith("refusé")) this.finiVu = true;
        if (nom === "moi_resumer" && !enErreur && this.resumeDemande === undefined) this.resumeDemande = this.noteEnCours ?? "";
        const restant = this.debuts.entries().next().value;
        this.outilEnCours = restant ? { id: restant[0], nom: restant[1].nom, depuis: restant[1].depuis } : undefined;
        return { type: ev.type, outil: nom, appelId: id, resultat: resume, dureeMs: debut ? maintenant - debut.depuis : undefined, erreur: enErreur ? resume : undefined };
      }
      case "message_end": {
        const m = ev.message as { role?: string; stopReason?: string; errorMessage?: string; usage?: Usage } | undefined;
        if (!m || m.role !== "assistant") return undefined;
        this.oublierReponse();
        const u = m.usage ?? {};
        const entree = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
        const sortie = u.output ?? 0;
        this.tokensEntree += entree;
        this.tokensSortie += sortie;
        if (entree > 0) this.contexte = entree;
        let cout = !this.tarifFixe && typeof u.cost?.total === "number" ? u.cost.total : 0;
        if (cout === 0 && this.tarif && entree + sortie > 0) { // rien à estimer sur un message sans tokens (erreur du fournisseur)
          cout = (entree * this.tarif.entree + sortie * this.tarif.sortie) / 1e6;
          this.coutEstime = true;
        }
        this.cout += cout;
        let erreur: string | undefined;
        if (m.stopReason === "error") {
          erreur = String(m.errorMessage ?? "erreur du fournisseur");
          this.erreur = erreur;
        } else if (m.stopReason !== "aborted") this.erreur = undefined; // pi a relancé seul et la réponse a abouti
        return { type: ev.type, tokensEntree: entree, tokensSortie: sortie, coutUsd: cout, erreur };
      }
      // Le résumé en cours : pi ne dit rien entre le début et la fin d'un compactage, qui peut durer
      // plusieurs minutes. On le tient pour un outil en cours : le silence ne compte pas, sa propre borne le remplace.
      case "compaction_start":
        this.outilEnCours = { id: COMPACTAGE, nom: "se résumer", depuis: maintenant };
        return { type: ev.type };
      case "compaction_end": {
        if (this.outilEnCours?.id === COMPACTAGE) {
          const restant = this.debuts.entries().next().value;
          this.outilEnCours = restant ? { id: restant[0], nom: restant[1].nom, depuis: restant[1].depuis } : undefined;
        }
        const r = ev.result as { usage?: Usage; tokensBefore?: number; estimatedTokensAfter?: number } | undefined;
        const ru = r?.usage;
        const cout = this.tarifFixe && this.tarif
          ? (((ru?.input ?? 0) + (ru?.cacheRead ?? 0) + (ru?.cacheWrite ?? 0)) * this.tarif.entree + (ru?.output ?? 0) * this.tarif.sortie) / 1e6
          : ru?.cost?.total;
        if (typeof cout === "number") this.cout += cout;
        if (ev.aborted === true || typeof ev.errorMessage === "string") this.compactageRate = true;
        const k = (n: number) => `${Math.round(n / 1000)}k`;
        const avant = typeof r?.tokensBefore === "number" ? r.tokensBefore : undefined;
        const apres = typeof r?.estimatedTokensAfter === "number" ? r.estimatedTokensAfter : undefined;
        const resultat = avant === undefined ? undefined : apres === undefined ? `${k(avant)} tokens résumés` : `${k(avant)} → ${k(apres)} tokens`;
        return { type: ev.type, coutUsd: cout, tokensEntree: avant, resultat, erreur: typeof ev.errorMessage === "string" ? ev.errorMessage : undefined };
      }
      case "agent_end":
        return { type: ev.type };
      default:
        return undefined;
    }
  }
}
