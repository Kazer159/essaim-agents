#!/usr/bin/env bun
// Faux résumeur de lots (fils de concentration) : imite `pi --mode json -p … --no-tools <prompt>` pour
// ESSAIM_RESUMEUR, sans appeler aucun modèle. Il lit les ids « [msg N] » du prompt et rend un message_end.
// ESSAIM_FAUX_RESUME_MODE : ok (défaut : un point par message, cité, avec un coût), vide, sans-citation, sans-usage (texte
// cité, aucun usage), longueur (coupé par la longueur), lent (attend ESSAIM_FAUX_RESUME_MS, 2000 par défaut, puis ok).
// ESSAIM_FAUX_RESUME_COMPTE : fichier où il ajoute une ligne JSON par appel ({ modele, args }).
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const modele = args[args.indexOf("--model") + 1];
const prompt = args.at(-1) ?? "";
const mode = process.env.ESSAIM_FAUX_RESUME_MODE ?? "ok";
if (process.env.ESSAIM_FAUX_RESUME_COMPTE) appendFileSync(process.env.ESSAIM_FAUX_RESUME_COMPTE, JSON.stringify({ modele, args }) + "\n");
if (mode === "lent") await new Promise((r) => setTimeout(r, Number(process.env.ESSAIM_FAUX_RESUME_MS ?? 2000)));

const ids = [...prompt.matchAll(/\[msg (\d+)\]/g)].map((m) => m[1]);
const cite = ids.map((id) => `- point du message ${id} [msg ${id}]`).join("\n");
const texte = mode === "vide" ? "" : mode === "sans-citation" ? "un résumé qui ne cite rien" : cite;
const usage = mode === "sans-usage" ? undefined : { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, cost: { total: 0.0012 } };
const message = { role: "assistant", content: [{ type: "text", text: texte }], ...(usage ? { usage } : {}), stopReason: mode === "longueur" ? "length" : "stop" };
process.stdout.write(JSON.stringify({ type: "message_start", message: { role: "assistant" } }) + "\n");
process.stdout.write(JSON.stringify({ type: "message_end", message }) + "\n");
process.stdout.write(JSON.stringify({ type: "agent_end" }) + "\n");
