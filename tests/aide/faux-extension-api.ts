// Faux ExtensionAPI : capture les définitions d'outils que l'extension
// enregistre et permet de les appeler comme pi le ferait
// (execute(toolCallId, params, signal, onUpdate, ctx)). Capture aussi les
// gestionnaires d'événements (on) et les commandes (registerCommand), pour
// l'extension se-resumer ; ctx est un faux contexte dont le remplissage se règle
// depuis le test, et qui range les appels à compact.
// Les paramètres passent d'abord par validateToolArguments, comme dans pi (pi-agent-core/dist/agent-loop.js:411) : un champ requis manquant est une erreur de schéma levée avant l'extension ; un nombre écrit en texte est converti.
// Un appel suit ensuite la suite de pi : identifiant appel-N croissant (ou donné),
// tool_call enchaîné (le premier block arrête, sans exécuter ni émettre tool_result : agent-loop.js:426-435),
// execute, puis tool_result enchaîné comme runner.js:693-723 (chaque gestionnaire reçoit le contenu déjà complété),
// y compris sur une erreur de l'outil (isError). Un résultat d'erreur (blocage, outil en panne) est rendu comme un
// rejet dont le message est le texte final : c'est ce que tests/faux-pi.ts émet en isError, comme pi.
// Comme pi, une exception d'un gestionnaire tool_result ou input est notée (erreurs) sans arrêter la suite ;
// celle d'un gestionnaire tool_call bloque l'appel.
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";

type Outil = {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  parameters: unknown;
  execute: (id: string, params: never, signal: AbortSignal, onUpdate: () => void, ctx: unknown) => Promise<{ content: Array<{ type: string; text?: string }>; details?: unknown; terminate?: boolean }>;
};
type Commande = { description?: string; handler: (args: string, ctx: unknown) => Promise<void> };
type OptionsCompact = { customInstructions?: string; onComplete?: (r: unknown) => void; onError?: (e: Error) => void };

type Contenu = Array<{ type: string; text?: string }>;
type ResultatOutil = { content: Contenu; details?: unknown; isError?: boolean; terminate?: boolean };
type Gestionnaire = (ev: unknown, ctx: unknown) => unknown;

export function fauxPi() {
  const outils = new Map<string, Outil>();
  const gestionnaires = new Map<string, Gestionnaire[]>();
  const commandes = new Map<string, Commande>();
  const compacts: OptionsCompact[] = [];
  const erreurs: string[] = [];
  let tokens: number | null = 0;
  let appels = 0;
  const ctx = {
    getContextUsage: () => ({ tokens, contextWindow: 1_048_576, percent: tokens === null ? null : (tokens / 1_048_576) * 100 }),
    compact: (o: OptionsCompact) => { compacts.push(o); },
  };
  const liste = (nom: string) => gestionnaires.get(nom) ?? [];

  // emitToolCall (runner.js:745-763) : le dernier résultat rendu, sauf un block qui arrête tout de suite.
  const emettreToolCall = async (ev: unknown) => {
    let r: { block?: boolean; reason?: string } | undefined;
    for (const h of liste("tool_call")) {
      const x = (await h(ev, ctx)) as typeof r;
      if (x) { r = x; if (r.block) return r; }
    }
    return r;
  };
  // emitToolResult (runner.js:693-723) : content, details et isError enchaînés ; undefined si rien n'a changé.
  const emettreToolResult = async (ev: Record<string, unknown>) => {
    const courant = { ...ev };
    let modifie = false;
    for (const h of liste("tool_result")) {
      try {
        const x = (await h(courant, ctx)) as { content?: unknown; details?: unknown; isError?: boolean } | undefined;
        if (!x) continue;
        if (x.content !== undefined) { courant.content = x.content; modifie = true; }
        if (x.details !== undefined) { courant.details = x.details; modifie = true; }
        if (x.isError !== undefined) { courant.isError = x.isError; modifie = true; }
      } catch (e) { erreurs.push(`tool_result : ${(e as Error).message ?? e}`); }
    }
    return modifie ? { content: courant.content as Contenu, details: courant.details, isError: courant.isError as boolean | undefined } : undefined;
  };
  // emitInput (runner.js:974-1006) : transform enchaîné, handled arrête.
  const emettreInput = async (texte: string) => {
    let courant = texte;
    for (const h of liste("input")) {
      try {
        const x = (await h({ type: "input", text: courant, images: undefined, source: "interactive", streamingBehavior: undefined }, ctx)) as { action?: string; text?: string } | undefined;
        if (x?.action === "handled") return x;
        if (x?.action === "transform") courant = String(x.text);
      } catch (e) { erreurs.push(`input : ${(e as Error).message ?? e}`); }
    }
    return courant !== texte ? { action: "transform", text: courant } : { action: "continue" };
  };

  const texteDe = (c: Contenu) => c.map((x) => x.text ?? "").join("\n");
  const executer = async (nom: string, params: unknown, o: { id?: string } = {}): Promise<ResultatOutil> => {
    const outil = outils.get(nom);
    if (!outil) throw new Error(`outil inconnu : ${nom}`);
    const id = o.id ?? `appel-${++appels}`;
    const valides = validateToolArguments(outil as never, { type: "toolCall", id, name: nom, arguments: params } as never);
    const avant = await emettreToolCall({ type: "tool_call", toolName: nom, toolCallId: id, input: valides });
    if (avant?.block) throw new Error(avant.reason || "Tool execution was blocked");
    let r: ResultatOutil, isError = false;
    try {
      r = await outil.execute(id, valides as never, new AbortController().signal, () => {}, ctx);
    } catch (e) {
      r = { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], details: {} };
      isError = true;
    }
    const apres = await emettreToolResult({ type: "tool_result", toolName: nom, toolCallId: id, input: valides, content: r.content, details: r.details, isError });
    if (apres) {
      r = { ...r, content: apres.content ?? r.content, details: apres.details ?? r.details };
      isError = apres.isError ?? isError;
    }
    if (isError) throw new Error(texteDe(r.content));
    return r;
  };
  return {
    api: {
      registerTool: (d: Outil) => outils.set(d.name, d),
      registerCommand: (nom: string, d: Commande) => commandes.set(nom, d),
      on: (nom: string, h: Gestionnaire) => gestionnaires.set(nom, [...liste(nom), h]),
    } as never,
    // Un appel d'outil par la suite de pi ; o.id impose l'identifiant (sinon appel-1, appel-2… par instance).
    appeler: (nom: string, params: unknown, o?: { id?: string }) => executer(nom, params, o),
    texte: async (nom: string, params: unknown, o?: { id?: string }) => texteDe((await executer(nom, params, o)).content),
    noms: () => [...outils.keys()],
    definition: (nom: string) => outils.get(nom),
    // Un événement émis à la main, enchaîné comme pi : tool_call, tool_result et input comme ci-dessus ;
    // tout autre événement : chaque gestionnaire, le dernier résultat rendu.
    emettre: async (nom: string, ev: unknown) => {
      if (nom === "tool_call") return emettreToolCall(ev);
      if (nom === "tool_result") return emettreToolResult(ev as Record<string, unknown>);
      if (nom === "input") return emettreInput(String((ev as { text?: unknown }).text ?? ""));
      let r: unknown;
      for (const h of liste(nom)) r = (await h(ev, ctx)) ?? r;
      return r;
    },
    // Un message saisi (agent-session.js:842-853) : le texte que pi enverrait au modèle, ou undefined si un
    // gestionnaire l'a pris en charge (handled).
    saisir: async (texte: string): Promise<string | undefined> => {
      const r = await emettreInput(texte);
      return r.action === "handled" ? undefined : r.action === "transform" ? String(r.text) : texte;
    },
    aCommande: (nom: string) => commandes.has(nom),
    commande: (nom: string, args: string) => {
      const c = commandes.get(nom);
      if (!c) throw new Error(`commande inconnue : ${nom}`);
      return c.handler(args, ctx);
    },
    regler: (n: number | null) => { tokens = n; },
    compacts,
    erreurs,
  };
}
