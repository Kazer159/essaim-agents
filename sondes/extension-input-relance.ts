// Sonde : extension pi sans modèle.
// Question : l'extension peut-elle construire l'état de la salle à l'événement `input` du premier message
// d'une relance, APRÈS une commande d'extension (/se-resumer) qui dure, et le texte transformé est-il bien
// celui que pi émet en message_end utilisateur, écrit dans la session et envoie au modèle ?
//
// (a) Un fournisseur factice « sonde », modèle « muet » : son streamSimple rend aussitôt « ok », sans réseau
//     (aucun octet vers un fournisseur, 0 $). Il note le dernier message utilisateur qu'il reçoit.
// (b) /sonde-lente <ms> : note son début, attend, écrit une ligne dans SONDE_DB, note sa fin.
// (c) pi.on("input") : note l'appel (texte, ESSAIM_RELANCE), relit SONDE_DB, rend le texte transformé.
// Tout est écrit dans SONDE_PREUVES (JSON), réécrit à chaque événement. Lu par sondes/pi-input-relance.sh.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";

const require = createRequire(import.meta.url);

export default function (pi: ExtensionAPI) {
  const base = process.env.SONDE_DB, fichier = process.env.SONDE_PREUVES;
  if (!base || !fichier) throw new Error("SONDE_DB et SONDE_PREUVES sont requis");
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(base);
  db.exec("PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS sonde(quand TEXT, quoi TEXT)");

  const preuves: Record<string, unknown>[] = [];
  let ordre = 0;
  const noter = (quoi: string, plus: Record<string, unknown> = {}) => {
    preuves.push({ n: ++ordre, quoi, quand: new Date().toISOString(), ...plus });
    writeFileSync(fichier, JSON.stringify(preuves, null, 2));
  };
  noter("chargement", { relance: process.env.ESSAIM_RELANCE ?? null });

  const texteDe = (m: any): string =>
    typeof m?.content === "string" ? m.content
      : (m?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");

  pi.registerProvider("sonde", {
    name: "Sonde (factice, sans réseau)",
    baseUrl: "http://127.0.0.1:9",
    apiKey: "sonde-sans-cle",
    api: "sonde-muet",
    models: [{
      id: "muet", name: "muet", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000, maxTokens: 1000,
    }],
    streamSimple: (model, context) => {
      const users = context.messages.filter((m: any) => m.role === "user");
      noter("fournisseur", { messages: context.messages.length, dernierUtilisateur: texteDe(users.at(-1)) });
      const flux = createAssistantMessageEventStream();
      const message = {
        role: "assistant" as const, content: [{ type: "text" as const, text: "ok" }],
        api: model.api, provider: model.provider, model: model.id,
        usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop" as const, timestamp: Date.now(),
      };
      queueMicrotask(() => {
        flux.push({ type: "start", partial: message });
        flux.push({ type: "done", reason: "stop", message });
        flux.end();
      });
      return flux;
    },
  });

  pi.registerCommand("sonde-lente", {
    description: "attend <ms>, écrit une ligne dans SONDE_DB pendant l'attente",
    handler: async (args) => {
      const ms = Number(args.trim()) || 1000;
      noter("commande_debut", { ms });
      await new Promise((r) => setTimeout(r, ms / 2));
      db.prepare("INSERT INTO sonde VALUES (?, ?)").run(new Date().toISOString(), "fait pendant la commande");
      await new Promise((r) => setTimeout(r, ms / 2));
      noter("commande_fin");
    },
  });

  pi.on("session_compact", () => { noter("compactage_fin"); });
  pi.on("session_compact_failed", (ev: any) => { noter("compactage_echec", { erreur: ev?.errorMessage ?? (ev?.aborted ? "interrompu" : "") }); });

  let n = 0;
  pi.on("input", (ev) => {
    n++;
    const lignes = db.prepare("SELECT quoi FROM sonde").all().map((l: any) => l.quoi);
    noter("input", { texte: ev.text, source: ev.source, relance: process.env.ESSAIM_RELANCE ?? null, lignesEnBase: lignes });
    return { action: "transform", text: `${ev.text}\n\n[salle] sonde ${n}` };
  });
}
