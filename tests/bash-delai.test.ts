// Un bash sans fin (un serveur lancé sous node qui ne rend jamais la main) ne doit pas faire virer l'agent. L'extension donne à bash un délai sous celui du lanceur :
// pi coupe la commande et rend « timed out » à l'agent, qui continue.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ouvrirBun } from "../src/tableau-bun.ts";
import * as T from "../src/tableau.ts";
import extension from "../src/outils-essaim.ts";
import { fauxPi } from "./aide/faux-extension-api.ts";

let dossier: string;
let t: T.Tableau;

function instance() {
  process.env.ESSAIM_AGENT = "Bernard";
  process.env.ESSAIM_TABLEAU = join(dossier, "tableau.sqlite");
  process.env.ESSAIM_PARTAGE = join(dossier, "partage");
  process.env.ESSAIM_BUREAU = join(dossier, "agents", "Bernard");
  const faux = fauxPi();
  extension(faux.api, ouvrirBun);
  return faux;
}
const bash = async (pi: ReturnType<typeof fauxPi>, input: Record<string, unknown>) => {
  await pi.emettre("tool_call", { type: "tool_call", toolName: "bash", toolCallId: "b1", input });
  return input;
};

beforeEach(() => {
  dossier = mkdtempSync(join(tmpdir(), "essaim-delai-"));
  mkdirSync(join(dossier, "partage"));
  mkdirSync(join(dossier, "agents", "Bernard"), { recursive: true });
  t = ouvrirBun(join(dossier, "tableau.sqlite"));
  T.initialiser(t);
  T.ouvrirRun(t, { id: "run-test", missionChemin: "m.md", missionTexte: "texte", modele: "faux/faux", plafondUsd: 0.5, silenceMin: 15 });
  T.ajouterAgent(t, "Bernard", join(dossier, "agents", "Bernard"));
});
afterEach(() => {
  delete process.env.ESSAIM_OUTIL_MAX_MIN;
  t.fermer();
  rmSync(dossier, { recursive: true, force: true });
});

describe("bash : un délai sous celui du lanceur", () => {
  test("sans délai : 8 minutes (le lanceur coupe à 10)", async () => {
    expect(await bash(instance(), { command: "node soiree.js" })).toEqual({ command: "node soiree.js", timeout: 480 });
  });

  test("un délai plus long que la borne est ramené à la borne ; un plus court est gardé", async () => {
    const pi = instance();
    expect((await bash(pi, { command: "x", timeout: 3600 })).timeout).toBe(480);
    expect((await bash(pi, { command: "x", timeout: 60 })).timeout).toBe(60);
  });

  test("la borne suit --outil-max du lanceur (ESSAIM_OUTIL_MAX_MIN) : 80 % de sa durée", async () => {
    process.env.ESSAIM_OUTIL_MAX_MIN = "5";
    expect((await bash(instance(), { command: "x" })).timeout).toBe(240);
  });

  test("les autres outils ne sont pas touchés", async () => {
    const pi = instance();
    const input = { path: "a.js" };
    await pi.emettre("tool_call", { type: "tool_call", toolName: "read", toolCallId: "r1", input });
    expect(input).toEqual({ path: "a.js" });
  });
});
