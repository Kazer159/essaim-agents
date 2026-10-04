import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { argumentsPi, bacASable, configPi, envSansIdentifiants, exigerCle, gourmands, lancerPi, restesDuRun, tuerGroupe, tuerRestes, type ParamsAgent } from "../src/processus.ts";
import { ouvrirBun } from "../src/tableau-bun.ts";
import * as T from "../src/tableau.ts";

const racine = resolve(import.meta.dir, "..");
const FAUX_PI = join(racine, "tests", "faux-pi.ts");
let runDir: string;

function params(p: Partial<ParamsAgent> = {}): ParamsAgent {
  return { nom: "agent-01", runDir, bureau: join(runDir, "agents", "agent-01"), modele: "faux/faux", reflexion: "off",
    mission: "poste bonjour", consignes: "Tu es agent-01.", passe: 1, sansBacASable: false, ...p };
}

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), "essaim-run-"));
  for (const d of ["agents/agent-01", "partage", "sessions", "journal"]) mkdirSync(join(runDir, d), { recursive: true });
  const t = ouvrirBun(join(runDir, "tableau.sqlite"));
  T.initialiser(t);
  T.ouvrirRun(t, { id: "r", missionChemin: "m.md", missionTexte: "m", modele: "faux/faux", plafondUsd: 0.1, silenceMin: 15 });
  T.ajouterAgent(t, "agent-01", join(runDir, "agents", "agent-01"));
  t.fermer();
  delete process.env.ESSAIM_PI;
});
afterEach(() => rmSync(runDir, { recursive: true, force: true }));

describe("argumentsPi", () => {
  test("sous bac à sable : sandbox-exec, profil et PROJET absolus, puis la ligne pi complète", () => {
    const { commande, args } = argumentsPi(params());
    expect(commande).toBe("sandbox-exec");
    expect(args.slice(0, 9)).toEqual(["-f", join(racine, "src", "bac-a-sable.sb"), "-D", `PROJET=${runDir}`, "-D", `HOME=${process.env.HOME}`, "-D", `AUTH_PI=${join(process.env.HOME!, ".pi", "agent", "auth.json")}`, "pi"]);
    const pi = args.slice(9);
    expect(pi).toEqual(["--mode", "json", "-p", "--no-skills", "--no-extensions", "--no-context-files",
      "--session-dir", join(runDir, "sessions"), "--session-id", "agent-01", "-e", join(racine, "src", "outils-essaim.ts"),
      "--model", "faux/faux", "--thinking", "off", "--append-system-prompt", "Tu es agent-01.", "--", "poste bonjour"]);
    for (const chemin of [args[1], args[3]!.slice("PROJET=".length), pi[7], pi[11]]) expect(isAbsolute(chemin!)).toBe(true);
  });
  test("sans bac à sable : le préfixe disparaît ; ESSAIM_PI désigne le binaire, rendu absolu", () => {
    process.env.ESSAIM_PI = "tests/faux-pi.ts";
    const { commande, args } = argumentsPi(params({ sansBacASable: true }));
    expect(commande).toBe(FAUX_PI);
    expect(args[0]).toBe("--mode");
  });
  test("un chemin de run relatif est rendu absolu", () => {
    const { args } = argumentsPi(params({ runDir: "runs/x", sansBacASable: true }));
    expect(args[args.indexOf("--session-dir") + 1]).toBe(join(process.cwd(), "runs", "x", "sessions"));
  });
  test("à partir de la deuxième passe, le dernier argument est continue", () => {
    const { args } = argumentsPi(params({ passe: 2, sansBacASable: true }));
    expect(args.at(-2)).toBe("--");
    expect(args.at(-1)).toBe("continue");
  });
  test("compactage : seconde extension après outils-essaim ; relance de résumé : /se-resumer <note> puis la reprise", () => {
    const { args } = argumentsPi(params({ sansBacASable: true, compactage: [80_000, 120_000, 160_000] }));
    const e = args.flatMap((a, i) => (a === "-e" ? [args[i + 1]] : []));
    expect(e).toEqual([join(racine, "src", "outils-essaim.ts"), join(racine, "src", "se-resumer.ts")]);
    expect(args.at(-1)).toBe("poste bonjour");
    const r = argumentsPi(params({ sansBacASable: true, compactage: [80_000, 120_000, 160_000], passe: 2, resumer: { note: "garde le but" } })).args;
    expect(r.slice(r.indexOf("--") + 1)).toEqual(["/se-resumer garde le but", "Ton contexte vient d'être résumé. Reprends ton travail."]);
    const force = argumentsPi(params({ sansBacASable: true, compactage: [80_000, 120_000, 160_000], resumer: {} })).args;
    expect(force.slice(force.indexOf("--") + 1)[0]).toBe("/se-resumer");
    expect(argumentsPi(params({ sansBacASable: true })).args.filter((a) => a === "-e").length).toBe(1);
  });
});

describe("les clés de l'utilisateur hors de portée des agents (D1, O2, 29/09)", () => {
  const CLES = ["OPENAI_API_KEY", "MISTRAL_API_KEY", "XAI_API_KEY", "OPENROUTER_API_KEY", "CLAUDE_CODE_MESSAGING_TOKEN", "HERDR_SOCKET_PATH", "STRIPE_SECRET"];
  test("l'environnement est une liste blanche : aucune clé, aucun jeton ; PATH, HOME et ESSAIM_* restent", () => {
    for (const k of CLES) process.env[k] = "secret";
    process.env.ESSAIM_ESSAI = "gardé";
    try {
      const env = envSansIdentifiants(runDir);
      for (const k of CLES) expect(env[k]).toBeUndefined();
      expect(env).toMatchObject({ PATH: process.env.PATH, HOME: process.env.HOME, ESSAIM_ESSAI: "gardé" });
    } finally { for (const k of CLES) delete process.env[k]; delete process.env.ESSAIM_ESSAI; }
  });
  test("configPi : pi reçoit la clé réservée à l'essaim et un auth.json sans la clé OpenRouter de l'utilisateur", () => {
    const source = join(runDir, "source-pi");
    mkdirSync(source);
    writeFileSync(join(source, "auth.json"), JSON.stringify({ openrouter: { key: "perso" }, "openai-codex": { jeton: "abonnement" } }));
    writeFileSync(join(source, "models.json"), "{}");
    writeFileSync(join(runDir, "cle"), "sk-essaim\n");
    process.env.ESSAIM_CLE_OPENROUTER = join(runDir, "cle");
    try {
      const env = configPi(runDir, "Antoine", "openrouter/xiaomi/mimo", source);
      expect(env.OPENROUTER_API_KEY).toBe("sk-essaim");
      expect(JSON.parse(readFileSync(join(env.PI_CODING_AGENT_DIR!, "auth.json"), "utf8"))).toEqual({});
      expect(readFileSync(join(env.PI_CODING_AGENT_DIR!, "models.json"), "utf8")).toBe("{}");
      expect(configPi(runDir, "Antoine", "faux/faux", source).OPENROUTER_API_KEY).toBeUndefined();
    } finally { delete process.env.ESSAIM_CLE_OPENROUTER; }
  });
  test("exigerCle : un modèle OpenRouter sans clé réservée à l'essaim refuse de lancer ; les autres passent", () => {
    process.env.ESSAIM_CLE_OPENROUTER = join(runDir, "absente");
    try {
      expect(() => exigerCle("openrouter/xiaomi/mimo")).toThrow("clé OpenRouter réservée à l'essaim");
      expect(() => exigerCle("faux/faux")).not.toThrow();
    } finally { delete process.env.ESSAIM_CLE_OPENROUTER; }
  });
});

describe("git dans la salle (A7)", () => {
  test("l'environnement de pi : ni config globale ou système, ni jeton, ni agent SSH, lectures sans verrou", () => {
    process.env.SSH_AUTH_SOCK = "/tmp/agent.sock";
    const env = envSansIdentifiants(runDir);
    expect(env).toMatchObject({ GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GH_TOKEN: "", GITHUB_TOKEN: "", GH_CONFIG_DIR: join(runDir, "gh") });
    expect("SSH_AUTH_SOCK" in env).toBe(false);
    delete process.env.SSH_AUTH_SOCK;
  });
  test("sous le vrai bac à sable : partage/ s'écrit, partage/.git non, le trousseau ne répond pas", () => {
    const run = mkdtempSync(join(racine, "runs", ".test-bac-a-sable-")); // sous runs/ comme un vrai run (tmpdir est déjà inscriptible)
    try {
      mkdirSync(join(run, "partage", ".git"), { recursive: true });
      const sh = (c: string) => Bun.spawnSync(bacASable(run, ["sh", "-c", c]), { env: envSansIdentifiants(run) as Record<string, string> }).exitCode;
      expect(sh(`echo a > '${run}/partage/a.js'`)).toBe(0);
      expect(sh(`echo a > '${run}/partage/.git/config'`)).not.toBe(0);
      expect(sh("security find-internet-password -s github.com")).not.toBe(0);
    } finally {
      rmSync(run, { recursive: true, force: true });
    }
  });
});

describe("lancerPi avec le faux pi", () => {
  test("rejoue hello-fini : en-tête, message utilisateur, puis les six lignes ; code 0, environnement ESSAIM_* transmis, message en base", async () => {
    process.env.ESSAIM_PI = "tests/faux-pi.ts";
    process.env.ESSAIM_FIXTURE = join(racine, "tests", "fixtures", "hello-fini.jsonl");
    const { pid, lignes, fermeture } = lancerPi(params({ sansBacASable: true }));
    expect(pid).toBeGreaterThan(0);
    const lues: string[] = [];
    for await (const l of lignes) lues.push(l);
    expect(lues.length).toBe(8);
    expect(JSON.parse(lues[0]!).type).toBe("session");
    expect(JSON.parse(lues[1]!).message).toMatchObject({ role: "user", content: [{ type: "text", text: "poste bonjour" }] });
    expect(JSON.parse(lues[2]!).type).toBe("tool_execution_start");
    expect(JSON.parse(lues[3]!).result.content[0].text).toBe("message 1 posté dans principal");
    expect(JSON.parse(lues[5]!).result.terminate).toBe(true);
    const f = await fermeture;
    expect(f.code).toBe(0);
    expect(f.signal).toBeNull();
    const journal = JSON.parse(readFileSync(join(runDir, "journal", "agent-01.args"), "utf8").trim());
    expect(journal.env).toMatchObject({ ESSAIM_AGENT: "agent-01", ESSAIM_BUREAU: join(runDir, "agents", "agent-01"), ESSAIM_TABLEAU: join(runDir, "tableau.sqlite"), ESSAIM_PARTAGE: join(runDir, "partage"), ESSAIM_DEPOT: resolve(import.meta.dir, "..") });
    expect(journal.args.at(-1)).toBe("poste bonjour");
    const t = ouvrirBun(join(runDir, "tableau.sqlite"), { lectureSeule: true });
    expect(t.get<{ texte: string }>("SELECT texte FROM messages")?.texte).toBe("bonjour de agent-01");
    expect(t.get<{ etat: string }>("SELECT etat FROM agents")?.etat).toBe("fini");
    t.fermer();
  });
  test("le code de sortie demandé est rendu", async () => {
    process.env.ESSAIM_PI = "tests/faux-pi.ts";
    process.env.ESSAIM_FIXTURE = join(racine, "tests", "fixtures", "sans-fini.jsonl");
    process.env.ESSAIM_FIXTURE_CODE = "1";
    try {
      const { lignes, fermeture } = lancerPi(params({ sansBacASable: true }));
      for await (const _ of lignes) { /* vider */ }
      expect((await fermeture).code).toBe(1);
    } finally {
      delete process.env.ESSAIM_FIXTURE_CODE;
    }
  });
  test("tuerGroupe arrête un faux pi qui dort 60 s en moins de 6 s", async () => {
    process.env.ESSAIM_PI = "tests/faux-pi.ts";
    const fixture = join(runDir, "dort.jsonl");
    writeFileSync(fixture, '{"type":"agent_start"}\n{"type":"faux:dormir","ms":60000}\n{"type":"agent_end"}\n');
    process.env.ESSAIM_FIXTURE = fixture;
    const { pid, lignes, fermeture } = lancerPi(params({ sansBacASable: true }));
    const it = lignes[Symbol.asyncIterator]();
    let premiere = await it.next();
    while (JSON.parse(premiere.value).type !== "agent_start") premiere = await it.next(); // après l'en-tête et le message utilisateur
    expect(JSON.parse(premiere.value).type).toBe("agent_start");
    const debut = Date.now();
    await tuerGroupe(pid);
    const f = await fermeture;
    expect(Date.now() - debut).toBeLessThan(6000);
    expect(["SIGTERM", "SIGKILL"]).toContain(f.signal);
  });
  test("tuerGroupe n'arrête pas au meneur : un membre du groupe qui ignore SIGTERM est tué aussi (29/09, revue F1)", async () => {
    const groupe = Bun.spawn(["bash", "-c", "(trap '' TERM; exec sleep 40) & sleep 40"], { detached: true, stdout: "ignore", stderr: "ignore" });
    await new Promise((r) => setTimeout(r, 300));
    await tuerGroupe(groupe.pid, 1000);
    await new Promise((r) => setTimeout(r, 200));
    expect(() => process.kill(-groupe.pid, 0)).toThrow(); // plus personne dans le groupe
  }, 10_000);
  test("le ramassage suit la descendance : un orphelin tué ne laisse pas son enfant derrière lui (29/09, revue F2)", async () => {
    const abandonne = Bun.spawn(["bash", "-c", `cd ${join(runDir, "partage")} && (sh -c 'sleep 40; true' >/dev/null 2>&1 &)`]);
    await abandonne.exited;
    await new Promise((r) => setTimeout(r, 300));
    await tuerRestes(runDir);
    expect(await restesDuRun(runDir)).toEqual([]);
  }, 15_000);
  test("les processus abandonnés dans le run sont ramassés, ceux qu'on attend encore sont laissés", async () => {
    // Un `bun test` que pi a coupé continue de tourner et se retrouve sans parent : c'est celui-là qu'on ramasse.
    const abandonne = Bun.spawn(["bash", "-c", `cd ${join(runDir, "partage")} && (sleep 30 >/dev/null 2>&1 &)`]);
    await abandonne.exited;
    // Un autre, lancé à l'instant et toujours attendu par son parent : on n'y touche pas.
    const attendu = Bun.spawn(["sleep", "30"], { cwd: join(runDir, "partage") });
    await new Promise((r) => setTimeout(r, 300));

    const restes = await restesDuRun(runDir);
    expect(restes.map((r) => r.commande)).toEqual(["sleep 30"]);
    expect(restes.map((r) => r.pid)).not.toContain(attendu.pid);

    const tues = await tuerRestes(runDir);
    expect(tues).toHaveLength(1);
    expect(await restesDuRun(runDir)).toHaveLength(0);
    expect(() => process.kill(attendu.pid, 0)).not.toThrow(); // toujours vivant
    attendu.kill();
  }, 15_000);
});

// Le garde-fou de la mémoire : un descendant d'agent au-delà du seuil, jamais l'agent ni un processus étranger.
describe("gourmands", () => {
  const ps = [
    "  100     1  50000 bun src/lancer.ts",
    "  200   100  90000 pi",                       // Gaston, l'agent : jamais visé, même gros
    "  300   200   2000 /bin/bash -c cd essais && bun -e …",
    "  400   300 48000000 bun -e chargerProduit()", // 46 Go, petit-enfant de Gaston
    "  500     1 60000000 Google Chrome",           // étranger au run
    "  600   200    900 git status",                 // sous le seuil
  ].join("\n");
  test("le petit-enfant gourmand d'un agent, avec son agent ; ni l'agent, ni un étranger, ni un petit", () => {
    expect(gourmands(ps, new Map([[200, "Gaston"]]), 8 * 1024 * 1024)).toEqual([{ pid: 400, agent: "Gaston", ko: 48000000, commande: "bun -e chargerProduit()" }]);
    expect(gourmands(ps, new Map([[200, "Gaston"]]), 10)).toHaveLength(3); // bash, bun, git : jamais pi
    expect(gourmands("", new Map([[200, "Gaston"]]), 10)).toEqual([]);
  });
});
