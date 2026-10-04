// Le bac à sable par rôle : sous le VRAI sandbox-exec, comme dans processus.test.ts. `bash` ne se filtre pas par son texte : la recette et le gardien reçoivent un profil où
// partage/ est en lecture seule ; le bureau privé du gardien est illisible des autres ; le registre des preuves est
// fermé en écriture à tous.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { lancer } from "../src/lancer.ts";
import { argumentsPi, bacASable, bacDuRole, envSansIdentifiants, SANS_PRIVE, type OptionsBac, type ParamsAgent } from "../src/processus.ts";

const racine = resolve(import.meta.dir, "..");
let run: string;

beforeEach(() => {
  run = mkdtempSync(join(racine, "runs", ".test-bac-roles-")); // sous runs/ comme un vrai run (tmpdir est déjà inscriptible)
  for (const d of ["partage", "preuves", "agents/Antoine", "agents/Gaston/prive", "agents/Rose"]) mkdirSync(join(run, d), { recursive: true });
  writeFileSync(join(run, "agents", "Gaston", "prive", "cas.json"), '{"cas":"réservé"}\n');
  writeFileSync(join(run, "partage", "app.js"), "// produit\n");
});
afterEach(() => rmSync(run, { recursive: true, force: true }));

// Une commande shell sous le profil voulu ; le code de sortie seulement.
const sh = (c: string, o?: OptionsBac) =>
  Bun.spawnSync(bacASable(run, ["bash", "-c", c], o), { cwd: run, env: envSansIdentifiants(run) as Record<string, string>, stderr: "pipe" }).exitCode;

describe("le choix du profil", () => {
  test("sans rôles : exactement la ligne d'avant (profil commun, PROJET et HOME, rien d'autre)", () => {
    expect(bacASable(run, ["true"])).toEqual(["sandbox-exec", "-f", join(racine, "src", "bac-a-sable.sb"), "-D", `PROJET=${run}`, "-D", `HOME=${process.env.HOME}`, "-D", `AUTH_PI=${join(homedir(), ".pi", "agent", "auth.json")}`, "true"]);
  });
  test("selon DROITS[role].ecritProduit : constructeur et intégrateur écrivent le produit ; recette, gardien et chef ont le profil de contrôle", () => {
    expect(bacDuRole(run, "constructeur", "Claude", "Gaston").profil).toBe("produit");
    expect(bacDuRole(run, "integrateur", "Bernard", "Gaston").profil).toBe("produit");
    expect(bacDuRole(run, "recette", "Rose", "Gaston").profil).toBe("controle");
    expect(bacDuRole(run, "gardien", "Gaston", "Gaston").profil).toBe("controle");
    expect(bacDuRole(run, "chef", "Antoine", "Gaston").profil).toBe("controle");
  });
  test("le bureau privé du gardien est fermé aux autres ; le gardien lui-même, ou un run sans gardien, reçoit un chemin inexistant", () => {
    expect(bacDuRole(run, "constructeur", "Claude", "Gaston").prive).toBe(join(run, "agents", "Gaston", "prive"));
    expect(bacDuRole(run, "gardien", "Gaston", "Gaston").prive).toBe(SANS_PRIVE);
    expect(bacDuRole(run, "recette", "Rose").prive).toBe(SANS_PRIVE);
  });
  test("le profil de contrôle passe PRIVE et le dossier des profils ; celui du produit, PRIVE", () => {
    const controle = bacASable(run, ["true"], { profil: "controle", prive: SANS_PRIVE });
    expect(controle.slice(0, 3)).toEqual(["sandbox-exec", "-f", join(racine, "src", "bac-a-sable-controle.sb")]);
    expect(controle).toContain(`PRIVE=${SANS_PRIVE}`);
    expect(controle).toContain(`PROFILS=${join(racine, "src")}`);
    const produit = bacASable(run, ["true"], { profil: "produit", prive: join(run, "agents", "Gaston", "prive") });
    expect(produit[2]).toBe(join(racine, "src", "bac-a-sable.sb"));
    expect(produit).toContain(`PRIVE=${join(run, "agents", "Gaston", "prive")}`);
  });
  test("argumentsPi : le profil du rôle quand le lanceur le donne, la ligne d'avant sinon", () => {
    const p: ParamsAgent = { nom: "Rose", runDir: run, bureau: join(run, "agents", "Rose"), modele: "faux/faux", reflexion: "off", mission: "m", consignes: "c", passe: 1, sansBacASable: false };
    expect(argumentsPi(p).args[1]).toBe(join(racine, "src", "bac-a-sable.sb"));
    expect(argumentsPi({ ...p, role: "recette", bac: bacDuRole(run, "recette", "Rose", "Gaston") }).args[1]).toBe(join(racine, "src", "bac-a-sable-controle.sb"));
  });
});

describe("les .git hors d'atteinte par renommage d'un parent, revue du 29/09", () => {
  test("ni partage/, ni essais/, ni un essai, ni le run ne se renomment ; on écrit toujours dedans", () => {
    mkdirSync(join(run, "essais", "e1"), { recursive: true });
    mkdirSync(join(run, "partage", ".git"), { recursive: true });
    const produit = bacDuRole(run, "constructeur", "Claude", "Gaston");
    for (const o of [undefined, produit]) {
      expect(sh(`mv '${run}/partage' '${run}/p2'`, o)).not.toBe(0);
      expect(sh(`mv '${run}/essais' '${run}/e2'`, o)).not.toBe(0);
      expect(sh(`mv '${run}/essais/e1' '${run}/essais/e2'`, o)).not.toBe(0);
      expect(sh(`mv '${run}' '/private/tmp/essaim-revue-run-deplace'`, o)).not.toBe(0);
      expect(sh(`echo x > '${run}/partage/app2.js' && echo y > '${run}/essais/e1/f.js'`, o)).toBe(0);
    }
    expect(existsSync(join(run, "partage", ".git"))).toBe(true);
    rmSync("/private/tmp/essaim-revue-run-deplace", { recursive: true, force: true });
  });
});

describe("les sockets Unix de la machine (Docker, Herdr, Claude Code), revue du 29/09", () => {
  test("un socket sous ~ est fermé (Docker y vit) ; un socket du run reste ouvert", async () => {
    // Par le socket de Docker, un agent a lancé un conteneur qui écrivait dans ~ : hors du bac à sable.
    const d = mkdtempSync(join(homedir(), ".essaim-test-sock-"));
    const serveur = Bun.spawn(["bun", "-e", `for (const f of ['${d}/s.sock', '${run}/s.sock']) Bun.serve({ unix: f, fetch: () => new Response('ok') })`], { stdout: "ignore", stderr: "ignore" });
    try {
      for (let i = 0; i < 50 && !(existsSync(join(d, "s.sock")) && existsSync(join(run, "s.sock"))); i++) await Bun.sleep(50);
      expect(Bun.spawnSync(["curl", "-s", "-m", "3", "--unix-socket", join(d, "s.sock"), "http://d/"]).exitCode).toBe(0); // hors bac : il répond
      for (const o of [undefined, bacDuRole(run, "recette", "Rose", "Gaston")]) {
        expect(sh(`curl -s -m 3 --unix-socket '${d}/s.sock' http://d/`, o)).not.toBe(0);
        expect(sh(`curl -s -m 3 --unix-socket '${run}/s.sock' http://d/`, o)).toBe(0);
      }
    } finally { serveur.kill(); rmSync(d, { recursive: true, force: true }); }
  }, 20_000);
});

describe("ce qui s'exécute hors du bac à sable plus tard, revue du 29/09", () => {
  test("ni ~/.bun/bin (le bun du lanceur), ni les extensions de pi, ni le Chromium des juges ; le cache de bun reste ouvert", () => {
    const home = homedir();
    for (const d of [join(home, ".bun", "bin"), join(home, ".pi", "agent", "extensions"), join(home, "Library", "Caches", "ms-playwright")]) {
      if (!existsSync(d)) continue;
      const f = join(d, ".essaim-test-persistance");
      expect(sh(`touch '${f}'`)).not.toBe(0);
      rmSync(f, { force: true });
    }
    const cache = join(home, ".bun", "install", "cache");
    if (existsSync(cache)) { expect(sh(`touch '${cache}/.essaim-test' && rm '${cache}/.essaim-test'`)).toBe(0); }
  });
});

describe("les contrôleurs n'écrivent pas dans un essai (D4, 30/09)", () => {
  test("recette et gardien : essais/ en lecture seule, bash compris ; un constructeur y écrit", () => {
    mkdirSync(join(run, "essais", "e1"), { recursive: true });
    for (const o of [bacDuRole(run, "recette", "Rose", "Gaston"), bacDuRole(run, "gardien", "Gaston", "Gaston")]) {
      expect(sh(`cat '${run}/essais/e1' 2>/dev/null; ls '${run}/essais' > /dev/null`, o)).toBe(0);
      expect(sh(`echo x > '${run}/essais/e1/f.js'`, o)).not.toBe(0);
    }
    expect(sh(`echo x > '${run}/essais/e1/f.js'`, bacDuRole(run, "constructeur", "Claude", "Gaston"))).toBe(0);
  });
});

describe("la spec puis le plan (03/10)", () => {
  test("le chef écrit SPEC.md et PLAN.md à la racine de partage/, bash compris, et rien d'autre ; la recette ni l'un ni l'autre", () => {
    mkdirSync(join(run, "partage"), { recursive: true });
    const chef = bacDuRole(run, "chef", "Antoine", "Gaston");
    expect(sh(`echo s > '${run}/partage/SPEC.md' && echo p > '${run}/partage/PLAN.md'`, chef)).toBe(0);
    expect(sh(`echo x > '${run}/partage/app.js'`, chef)).not.toBe(0);
    expect(sh(`echo x > '${run}/partage/SPEC.md'`, bacDuRole(run, "recette", "Rose", "Gaston"))).not.toBe(0);
  });
  // Le surveillant : le profil de contrôle, sans SPEC.md ni PLAN.md.
  test("le surveillant : profil de contrôle ; ni SPEC.md, ni PLAN.md, ni le produit, bash compris", () => {
    mkdirSync(join(run, "partage"), { recursive: true });
    const s = bacDuRole(run, "surveillant", "Yves", "Gaston");
    expect(s.profil).toBe("controle");
    expect(s.specPlan).toBeUndefined();
    expect(sh(`echo x > '${run}/partage/SPEC.md'`, s)).not.toBe(0);
    expect(sh(`echo x > '${run}/partage/PLAN.md'`, s)).not.toBe(0);
    expect(sh(`echo x > '${run}/partage/app.js'`, s)).not.toBe(0);
  });
});

describe("les secrets de l'utilisateur illisibles (D1, O2, 29/09)", () => {
  test("auth.json de pi, ~/.config (la clé de l'essaim y vit), Docker, Claude, historiques : fermés ; ouverts hors bac", () => {
    const home = homedir();
    const secrets = [".pi/agent/auth.json", ".pi/agent/profiles", ".config", ".docker", ".zsh_history", ".bash_history", ".claude", ".claude.json", ".aws", ".npmrc", ".gnupg"]
      .map((f) => join(home, f)).filter((f) => existsSync(f));
    expect(secrets.length).toBeGreaterThan(0);
    for (const f of secrets) {
      expect(Bun.spawnSync(["test", "-r", f]).exitCode).toBe(0);
      expect(sh(`ls '${f}' > /dev/null 2>&1 || cat '${f}' > /dev/null 2>&1`)).not.toBe(0);
    }
  });
  test("un run Codex garde auth.json lisible (pi y renouvelle le jeton de l'abonnement) ; le reste reste fermé", () => {
    const auth = join(homedir(), ".pi", "agent", "auth.json");
    if (!existsSync(auth)) return;
    const codex = (c: string) => Bun.spawnSync(bacASable(run, ["bash", "-c", c], undefined, true), { cwd: run, env: envSansIdentifiants(run) as Record<string, string> }).exitCode;
    expect(codex(`test -r '${auth}' && head -c 1 '${auth}' > /dev/null`)).toBe(0);
    expect(sh(`head -c 1 '${auth}' > /dev/null`)).not.toBe(0);
    if (existsSync(join(homedir(), ".config"))) expect(codex(`ls '${join(homedir(), ".config")}' > /dev/null`)).not.toBe(0);
  });
});

describe("le monde fixé par la mission (entrees/), revue du 29/09", () => {
  test("aucun profil n'écrit, ne supprime ni ne renomme entrees/ ; tous le lisent", () => {
    mkdirSync(join(run, "entrees"), { recursive: true });
    writeFileSync(join(run, "entrees", "monde.json"), '{"arrivees":[1,2,3]}\n');
    for (const o of [undefined, bacDuRole(run, "constructeur", "Claude", "Gaston"), bacDuRole(run, "recette", "Rose", "Gaston")]) {
      expect(sh(`cat '${run}/entrees/monde.json' > /dev/null`, o)).toBe(0);
      expect(sh(`echo triche > '${run}/entrees/monde.json'`, o)).not.toBe(0);
      expect(sh(`echo x > '${run}/entrees/neuf.json'`, o)).not.toBe(0);
      expect(sh(`mv '${run}/entrees' '${run}/ailleurs'`, o)).not.toBe(0);
    }
    expect(readFileSync(join(run, "entrees", "monde.json"), "utf8")).toBe('{"arrivees":[1,2,3]}\n');
  });
});

describe("les consignes de l'utilisateur (consignes/), A6, revue du 02/10", () => {
  test("aucun profil n'écrit, ne crée, ne renomme ni ne remplace consignes/ par un lien", () => {
    for (const o of [undefined, bacDuRole(run, "constructeur", "Claude", "Gaston"), bacDuRole(run, "chef", "Antoine", "Gaston")]) {
      expect(sh(`mkdir '${run}/consignes'`, o)).not.toBe(0);
      expect(sh(`ln -s /etc '${run}/consignes'`, o)).not.toBe(0);
    }
    mkdirSync(join(run, "consignes"), { recursive: true });
    for (const o of [undefined, bacDuRole(run, "constructeur", "Claude", "Gaston")]) {
      expect(sh(`echo abandonne > '${run}/consignes/0.txt'`, o)).not.toBe(0);
      expect(sh(`ln -s ~/.pi/agent/auth.json '${run}/consignes/1.txt'`, o)).not.toBe(0);
      expect(sh(`mv '${run}/consignes' '${run}/ailleurs'`, o)).not.toBe(0);
    }
    expect(sh(`echo x > '${run}/libre.txt'`, bacDuRole(run, "constructeur", "Claude", "Gaston"))).toBe(0); // témoin : le reste du run s'écrit
    expect(readdirSync(join(run, "consignes"))).toEqual([]);
  });
});

describe("le run isolé (ESSAIM_ISOLER=1, run ligne du 28/09)", () => {
  const avant = process.env.ESSAIM_ISOLER;
  afterEach(() => { if (avant === undefined) delete process.env.ESSAIM_ISOLER; else process.env.ESSAIM_ISOLER = avant; });
  const autre = () => { const d = mkdtempSync(join(racine, "runs", ".test-bac-autre-")); writeFileSync(join(d, "moteur.js"), "// ancien\n"); return d; };
  test("isolé : ni un autre run, ni sondes/, ni missions/ ; son propre run se lit et s'écrit", () => {
    const vieux = autre();
    try {
      process.env.ESSAIM_ISOLER = "1";
      expect(bacASable(run, ["true"])).toContain("ISOLE=1");
      expect(sh(`cat '${vieux}/moteur.js'`)).not.toBe(0);
      expect(sh(`ls '${racine}/runs'`)).not.toBe(0);
      expect(sh(`ls '${racine}/sondes'`)).not.toBe(0);
      expect(sh(`ls '${racine}/missions'`)).not.toBe(0);
      expect(sh(`cat '${run}/partage/app.js' && echo y > '${run}/partage/neuf.js'`)).toBe(0);
      expect(sh(`cat '${racine}/src/voir.ts' > /dev/null`)).toBe(0);
      // l'extension de pi ouvre le tableau par node:sqlite, qui lit les métadonnées des dossiers parents (runs/) :
      // fermer runs/ en entier fait tomber les agents au démarrage (« unable to open database file »)
      expect(sh(`node -e 'new (require("node:sqlite").DatabaseSync)("${run}/t.sqlite").exec("create table t(x)")' 2>/dev/null`)).toBe(0);
      expect(sh(`cat '${run}/agents/Gaston/prive/cas.json'`, bacDuRole(run, "constructeur", "Claude", "Gaston"))).not.toBe(0);
    } finally { rmSync(vieux, { recursive: true, force: true }); }
  });
  test("isolé : ni la vue (4700) ni les livrables (4701), qui servent tous les runs ; les autres ports locaux restent ouverts (29/09, revue F12)", async () => {
    // Quelqu'un écoute sur 4700 et 4701 : la vraie vue si elle tourne, sinon un serveur d'un instant dans un autre processus
    // (spawnSync bloque celui-ci). 4702 : un port quelconque, celui d'un serveur qu'un agent lance pour ses tests.
    const ecoute = Bun.spawn(["bun", "-e", "for (const port of [4700, 4701, 4702]) try { Bun.serve({ hostname: '127.0.0.1', port, fetch: () => new Response('ok') }) } catch {}"], { stdout: "ignore", stderr: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 500));
      const curl = (port: number) => sh(`curl -s -m 3 -o /dev/null http://127.0.0.1:${port}/ && curl -s -m 3 -o /dev/null http://localhost:${port}/`);
      delete process.env.ESSAIM_ISOLER;
      // La vue (4700) ferme, supprime ou met en pause des runs ; un agent forge Origin avec curl, elle
      // est donc fermée à tous les runs. Les livrables (4701), en lecture seule, restent ouverts hors run isolé.
      expect([curl(4700), curl(4701), curl(4702)]).toEqual([7, 0, 0]);
      process.env.ESSAIM_ISOLER = "1";
      expect(curl(4700)).not.toBe(0);
      expect(curl(4701)).not.toBe(0);
      expect(curl(4702)).toBe(0);
    } finally { ecoute.kill(); }
  }, 20_000);
  test("sans ESSAIM_ISOLER : la lecture reste ouverte, comme avant", () => {
    const vieux = autre();
    try {
      delete process.env.ESSAIM_ISOLER;
      expect(bacASable(run, ["true"])).not.toContain("ISOLE=1");
      expect(sh(`cat '${vieux}/moteur.js'`)).toBe(0);
    } finally { rmSync(vieux, { recursive: true, force: true }); }
  });
});

describe("sous le vrai bac à sable", () => {
  const constructeur = () => bacDuRole(run, "constructeur", "Claude", "Gaston");
  const recette = () => bacDuRole(run, "recette", "Rose", "Gaston");
  const gardien = () => bacDuRole(run, "gardien", "Gaston", "Gaston");

  test("partage/ : écrit par le constructeur, refusé à la recette et au gardien, bash compris ; lisible de tous", () => {
    expect(sh(`echo x > '${run}/partage/app.js'`, constructeur())).toBe(0);
    expect(sh(`echo x > '${run}/partage/app.js'`, recette())).not.toBe(0);
    expect(sh(`echo x > '${run}/partage/neuf.js'`, gardien())).not.toBe(0);
    expect(sh(`rm '${run}/partage/app.js'`, recette())).not.toBe(0);
    expect(sh(`mv '${run}/partage' '${run}/ailleurs'`, recette())).not.toBe(0);
    expect(sh(`cat '${run}/partage/app.js'`, recette())).toBe(0);
    expect(sh(`cat '${run}/partage/app.js'`, gardien())).toBe(0);
  });
  test("le contrôle écrit toujours dans son bureau (scénarios, captures) et le reste du run", () => {
    expect(sh(`mkdir -p '${run}/agents/Rose/captures' && echo s > '${run}/agents/Rose/scenario.md'`, recette())).toBe(0);
    expect(sh(`echo s > '${run}/agents/Gaston/prive/variante.json'`, gardien())).toBe(0);
  });
  test("le bureau privé du gardien : illisible et inscriptible pour les autres, même en renommant ses parents ; lisible du gardien", () => {
    const cas = `${run}/agents/Gaston/prive/cas.json`;
    expect(sh(`cat '${cas}'`, constructeur())).not.toBe(0);
    expect(sh(`cat '${cas}'`, recette())).not.toBe(0);
    expect(sh(`ls '${run}/agents/Gaston/prive'`, constructeur())).not.toBe(0);
    expect(sh(`echo x > '${cas}'`, constructeur())).not.toBe(0);
    expect(sh(`mv '${run}/agents/Gaston' '${run}/agents/Autre' && cat '${run}/agents/Autre/prive/cas.json'`, constructeur())).not.toBe(0);
    expect(sh(`mv '${run}/agents' '${run}/bureaux'`, constructeur())).not.toBe(0);
    expect(sh(`cat '${cas}'`, gardien())).toBe(0);
  });
  test("preuves/ : fermé en écriture à tous (le lanceur seul l'écrit), même en renommant le run ; lisible", () => {
    writeFileSync(join(run, "preuves", "1.json"), "{}\n");
    for (const o of [constructeur(), recette(), gardien(), bacDuRole(run, "chef", "Antoine", "Gaston")]) {
      expect(sh(`touch '${run}/preuves/x'`, o)).not.toBe(0);
      expect(sh(`echo faux > '${run}/preuves/1.json'`, o)).not.toBe(0);
      expect(sh(`cat '${run}/preuves/1.json'`, o)).toBe(0);
    }
    expect(sh(`mv '${run}' '${run}-bis'`, constructeur())).not.toBe(0);
  });
  test("sans rôles, rien ne change : partage/ et le bureau d'un autre s'écrivent, .git reste fermé", () => {
    mkdirSync(join(run, "partage", ".git"));
    expect(sh(`echo x > '${run}/partage/app.js'`)).toBe(0);
    expect(sh(`cat '${run}/agents/Gaston/prive/cas.json'`)).toBe(0);
    expect(sh(`echo x > '${run}/partage/.git/config'`)).not.toBe(0);
  });
  test("le profil de contrôle garde les fermetures du profil commun : .git, ~/.ssh", () => {
    mkdirSync(join(run, "partage", ".git"));
    expect(sh(`echo x > '${run}/partage/.git/config'`, recette())).not.toBe(0);
    expect(sh(`echo x > '${process.env.HOME}/.essaim-test-hors-run'`, recette())).not.toBe(0);
    expect(sh(`ls '${process.env.HOME}/.ssh'`, recette())).not.toBe(0);
  });
});

// Le lanceur : avec des rôles, il crée le registre des preuves et le bureau privé du gardien, et donne au gardien
// le chemin de ce bureau (ESSAIM_PRIVE) ; sans ## Type, ni l'un ni l'autre.
describe("le lanceur prépare les lieux", () => {
  const depot = resolve(import.meta.dir, "..");
  let racineRun: string;
  const missionTypee = (type: string) => { const p = join(racineRun, `mission-${type}.md`); writeFileSync(p, readFileSync(join(depot, "tests", "fixtures", "hello-world.md"), "utf8") + `\n## Type\n\n${type}\n`); return p; };
  const env = (run: string, nom: string) => (JSON.parse(readFileSync(join(run, "journal", `${nom}.args`), "utf8").trim().split("\n")[0]!) as { env: Record<string, string> }).env;
  beforeEach(() => {
    racineRun = mkdtempSync(join(tmpdir(), "essaim-lancer-roles-"));
    process.env.ESSAIM_PI = join(depot, "tests", "faux-pi.ts");
    process.env.ESSAIM_FIXTURE = join(depot, "tests", "fixtures", "hello-fini.jsonl");
    process.env.ESSAIM_TOUR_MS = "0";
  });
  afterEach(() => { rmSync(racineRun, { recursive: true, force: true }); delete process.env.ESSAIM_FIXTURE; delete process.env.ESSAIM_TOUR_MS; });

  test("type application : preuves/ et agents/<gardien>/prive/ ; ESSAIM_PRIVE au gardien seul", async () => {
    const b = await lancer({ agents: 8, modele: "faux", plafond: 0.1, mission: missionTypee("application"), racine: racineRun, sansBacASable: true });
    expect(existsSync(join(b.run, "preuves"))).toBe(true);
    expect(existsSync(join(b.run, "agents", "Hubert", "prive"))).toBe(true); // le huitième siège, le gardien
    expect(env(b.run, "Hubert").ESSAIM_ROLE).toBe("gardien");
    expect(env(b.run, "Hubert").ESSAIM_PRIVE).toBe(join(b.run, "agents", "Hubert", "prive"));
    expect(env(b.run, "Antoine").ESSAIM_PRIVE).toBeUndefined();
  });
  // Avec des rôles, page_voir écrit ses captures dans le bureau ; le lanceur ne commite plus en son nom un fichier
  // du même nom qui serait dans partage/ (ici déposé par un autre, commité à la fin du run par l'essaim).
  test("page_voir : sa capture commitée au nom de l'agent sans rôles, jamais avec", async () => {
    const outil = (id: string, nom: string, args: object) => [{ type: "tool_execution_start", toolCallId: id, toolName: nom, args }, { type: "tool_execution_end", toolCallId: id, toolName: nom, result: { content: [{ type: "text", text: "ok" }] }, isError: false }];
    const f = join(racineRun, "voir.jsonl");
    writeFileSync(f, [{ type: "faux:toucher", chemin: "{PARTAGE}/vue.png" }, ...outil("v1", "page_voir", { page: "index.html", capture: "vue" }),
      { type: "tool_execution_start", toolCallId: "f1", toolName: "moi_finir", args: { raison: "fait" } }, { type: "agent_end" }].map((l) => JSON.stringify(l)).join("\n") + "\n");
    process.env.ESSAIM_FIXTURE = f;
    const sujets = (run: string) => Bun.spawnSync(["git", "log", "--format=%s", "--", "vue.png"], { cwd: join(run, "partage"), env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } }).stdout.toString().trim();
    const sans = await lancer({ agents: 1, modele: "faux", plafond: 0.1, mission: join(depot, "tests", "fixtures", "hello-world.md"), racine: racineRun, sansBacASable: true });
    expect(sujets(sans.run)).toBe("page_voir : capture vue.png");
    const avec = await lancer({ agents: 1, modele: "faux", plafond: 0.1, mission: missionTypee("fichier"), racine: racineRun, sansBacASable: true });
    expect(sujets(avec.run)).toBe("fin du run");
  });
  test("sans ## Type : ni preuves/, ni bureau privé, ni ESSAIM_PRIVE", async () => {
    const b = await lancer({ agents: 1, modele: "faux", plafond: 0.1, mission: join(depot, "tests", "fixtures", "hello-world.md"), racine: racineRun, sansBacASable: true });
    expect(existsSync(join(b.run, "preuves"))).toBe(false);
    expect(existsSync(join(b.run, "agents", "Antoine", "prive"))).toBe(false);
    expect(env(b.run, "Antoine").ESSAIM_PRIVE).toBeUndefined();
  });
});
