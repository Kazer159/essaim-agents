// L'outil voir, par sa ligne de commande, lancée sous Node : c'est sous Node que
// pi charge l'extension. Le navigateur est le chrome-headless-shell du cache
// Playwright (révision épinglée par playwright-core) ; s'il manque, les tests
// qui l'exigent sont sautés, pas cassés.
import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cheminNavigateur, TAILLES_DEFAUT, voir } from "../src/voir.ts";

const racine = resolve(import.meta.dir, "..");
const fixtures = join(racine, "tests", "fixtures", "voir");
const present = cheminNavigateur() !== undefined;

function lancer(page: string, ...args: string[]): { code: number; sortie: string; partage: string } {
  const partage = mkdtempSync(join(tmpdir(), "essaim-voir-"));
  cpSync(fixtures, partage, { recursive: true });
  const p = Bun.spawnSync(["node", join(racine, "src", "voir.ts"), "--partage", partage, page, ...args], { cwd: racine, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, sortie: p.stdout.toString() + p.stderr.toString(), partage };
}

describe("voir", () => {
  // Second cerveau : ce que la page a réellement chargé dans son dossier, pour l'empreinte de page_voir.
  const pageTemp = (html: string) => { const d = mkdtempSync(join(tmpdir(), "essaim-voir-revue-")); writeFileSync(join(d, "p.html"), html); return d; };
  test.skipIf(!present)("le parcours ne clique pas un bouton destructeur apparu à la place d'un autre (29/09, revue V2)", async () => {
    const d = pageTemp(`<!doctype html><div id="z"><button id="ajouter">Ajouter</button> <button id="voir">Voir</button></div><script>
ajouter.onclick = () => { const b = document.createElement("button"); b.textContent = "Supprimer tout"; b.onclick = () => console.error("DONNEES SUPPRIMEES"); ajouter.after(b); };
voir.onclick = () => { document.body.dataset.vu = "1"; };
</script>`);
    try {
      const r = await voir(d, { page: "p.html", parcours: true });
      expect(r.texte).not.toContain("DONNEES SUPPRIMEES");
    } finally { rmSync(d, { recursive: true, force: true }); }
  }, 40_000);
  test.skipIf(!present)("un clic sur un champ ou un canvas qui change est vu (29/09, revue V4)", async () => {
    const d = pageTemp(`<!doctype html><input id="i"><button id="go" onclick="i.value='calcule 42'">Go</button><canvas id="c" width="50" height="50"></canvas><button id="d" onclick="c.getContext('2d').fillRect(0,0,20,20)">Dessiner</button>`);
    try {
      const r = await voir(d, { page: "p.html", clics: ["#go", "#d"] });
      expect(r.texte).not.toContain("n'a pas changé");
    } finally { rmSync(d, { recursive: true, force: true }); }
  }, 40_000);
  test.skipIf(!present)("un clic impossible dit pourquoi : désactivé, sélecteur invalide, introuvable (29/09, revue V3)", async () => {
    const d = pageTemp(`<!doctype html><button id="off" disabled>Off</button>`);
    try {
      const r = await voir(d, { page: "p.html", clics: ["#off", "button[", "#absent"] });
      expect(r.texte).toContain("« #off » : désactivé");
      expect(r.texte).toContain("« button[ » : sélecteur invalide");
      expect(r.texte).toContain("« #absent » : sélecteur introuvable");
    } finally { rmSync(d, { recursive: true, force: true }); }
  }, 40_000);
  test.skipIf(!present)("une capture n'écrase pas un fichier que la page charge, ni ne sort du dossier par un lien (29/09, revue V5)", async () => {
    const d = pageTemp(`<!doctype html><img src="logo.png"><p>x</p>`);
    const dehors = mkdtempSync(join(tmpdir(), "essaim-voir-dehors-"));
    writeFileSync(join(d, "logo.png"), "ORIGINAL");
    symlinkSync(dehors, join(d, "lien"));
    try {
      const r = await voir(d, { page: "p.html", capture: "logo" });
      expect(readFileSync(join(d, "logo.png"), "utf8")).toBe("ORIGINAL");
      expect(r.texte).toContain("capture refusée");
      await voir(d, { page: "p.html", capture: "lien/fuite.png" });
      expect(existsSync(join(dehors, "fuite.png"))).toBe(false);
    } finally { rmSync(d, { recursive: true, force: true }); rmSync(dehors, { recursive: true, force: true }); }
  }, 60_000);
  test.skipIf(!present)("une page qui boucle après son chargement : voir rend la main, page en erreur, navigateur fermé (29/09, revue)", async () => {
    const partage = mkdtempSync(join(tmpdir(), "essaim-boucle-"));
    writeFileSync(join(partage, "boucle.html"), "<!doctype html><p>avant</p><script>setTimeout(() => { for (;;) {} }, 0)</script>");
    const chromes = () => Bun.spawnSync(["pgrep", "-f", `chrome-headless-shell.*${partage}`]).stdout.toString().trim();
    try {
      const debut = Date.now();
      const r = await voir(partage, { page: "boucle.html" }, 2000);
      expect(Date.now() - debut).toBeLessThan(20_000);
      expect(r.code).toBe(1);
      expect(r.texte).toContain("la page ne répond plus");
    } finally { rmSync(partage, { recursive: true, force: true }); }
  }, 40_000);
  test.skipIf(!present)("charges : la page, un script, une feuille de style, une image et un module importé ; ni la capture ni la planche ; le dehors reste dehors", async () => {
    const d = mkdtempSync(join(tmpdir(), "essaim-charges-"));
    const partage = join(d, "partage");
    mkdirSync(join(partage, "js"), { recursive: true });
    mkdirSync(join(d, "dehors"));
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    writeFileSync(join(partage, "pic.png"), png);
    writeFileSync(join(d, "dehors", "loin.png"), png);
    writeFileSync(join(partage, "style.css"), "body { color: #222; }\n");
    writeFileSync(join(partage, "app.js"), "document.body.dataset.app = '1';\n");
    // En file://, Chrome bloque tout module (CORS), mais la demande est faite : elle compte (le résultat en dépend).
    writeFileSync(join(partage, "js", "main.js"), "document.body.dataset.x = 'main';\n");
    writeFileSync(join(partage, "js", "lib.js"), "export const x = 'lib';\n");
    writeFileSync(join(partage, "index.html"), `<!doctype html><html><head><title>C</title><link rel="stylesheet" href="style.css"></head><body><p>bonjour</p>
<img src="pic.png" alt="p"><img src="${"file://" + join(d, "dehors", "loin.png")}" alt="l">
<script src="app.js"></script><script type="module" src="js/main.js"></script><script type="module">import { x } from "./js/lib.js";</script></body></html>`);
    const r = await voir(partage, { page: "index.html#salle", capture: "cap.png", tailles: ["1280x800"] });
    expect(r.code === 0 || r.code === 1).toBe(true);
    expect([...(r.charges ?? [])].sort()).toEqual(["app.js", "index.html", "js/lib.js", "js/main.js", "pic.png", "style.css"]);
    expect(existsSync(join(partage, "cap.png"))).toBe(true);
    expect(r.texte).toContain("ressources hors de partage/ (1) :");
    expect(r.texte).toContain("dehors/loin.png");
    rmSync(d, { recursive: true, force: true });
  }, 30_000);

  test("cheminNavigateur : le binaire attendu par la révision épinglée, ou undefined", () => {
    const c = cheminNavigateur();
    if (c === undefined) return;
    expect(c.endsWith("chrome-headless-shell")).toBe(true);
    expect(c).toContain(join("Library", "Caches", "ms-playwright", "chromium_headless_shell-"));
  });

  test("par défaut, des tailles d'écran d'ordinateur seulement : ni téléphone ni tablette (F12, run ville)", () => {
    expect(TAILLES_DEFAUT.length).toBeGreaterThan(0);
    for (const t of TAILLES_DEFAUT) expect(Number(t.split("x")[0])).toBeGreaterThanOrEqual(1280);
    expect(TAILLES_DEFAUT).toContain("2560x1440");
  });

  test.skipIf(!present)("--tailles sans liste : les tailles d'ordinateur, aucune sous 1280 px", () => {
    const r = lancer("saine.html", "--tailles");
    expect(r.sortie).toContain(`aux tailles d'écran (${TAILLES_DEFAUT.length}, 0 en défaut) :`);
    expect(r.sortie).toContain("1280×720 :");
    expect(r.sortie).not.toContain("390×844");
    expect(r.sortie).not.toContain("768×1024");
    rmSync(r.partage, { recursive: true, force: true });
  }, 30_000);

  test.skipIf(!present)("page saine : code 0, titre et texte", () => {
    const r = lancer("saine.html");
    expect(r.code).toBe(0);
    expect(r.sortie).toContain("page_voir : 0 page saine");
    expect(r.sortie).toContain("titre : Saine");
    expect(r.sortie).toContain("bonjour");
    rmSync(r.partage, { recursive: true, force: true });
  }, 30_000);

  test.skipIf(!present)("la 3D est rendue par la carte graphique du Mac, pas en logiciel (25/09)", () => {
    const r = lancer("webgl.html");
    expect(r.code).toBe(0);
    expect(r.sortie).toContain("rendu : ANGLE (Apple, ANGLE Metal Renderer");
    expect(r.sortie).not.toContain("SwiftShader");
    rmSync(r.partage, { recursive: true, force: true });
  }, 30_000);

  test.skipIf(!present)("tailles : ce qui défile de côté et les textes coupés à chaque taille, une planche PNG (25/09)", () => {
    const r = lancer("tailles.html", "--taille", "1280x800", "--taille", "1920x1080", "--taille", "12x9");
    expect(r.code).toBe(1);
    expect(r.sortie).toContain("aux tailles d'écran (3, 2 en défaut) :");
    expect(r.sortie).toContain("1280×800 : la page défile de côté (1608 px pour 1280) : div.bandeau ; 1 texte coupé : p.etiquette");
    expect(r.sortie).toContain("1920×1080 : 1 texte coupé : p.etiquette"); // le bandeau tient ; le texte pour lecteur d'écran n'est pas compté
    expect(r.sortie).toContain("12x9 : taille illisible (écrire 1280x800)");
    expect(r.sortie).toContain("planche : tailles.png");
    expect(statSync(join(r.partage, "tailles.png")).size).toBeGreaterThan(1000);
    rmSync(r.partage, { recursive: true, force: true });
  }, 30_000);

  test.skipIf(!present)("erreur de console : code 1, le message", () => {
    const r = lancer("erreur-script.html");
    expect(r.code).toBe(1);
    expect(r.sortie).toContain("page_voir : 1 page en erreur");
    expect(r.sortie).toMatch(/erreurs de console \(1\)[\s\S]*boum/);
    rmSync(r.partage, { recursive: true, force: true });
  }, 30_000);

  test.skipIf(!present)("exception non interceptée : code 1, le message", () => {
    const r = lancer("exception.html");
    expect(r.code).toBe(1);
    expect(r.sortie).toMatch(/exceptions \(1\)[\s\S]*cassé/);
    rmSync(r.partage, { recursive: true, force: true });
  }, 30_000);

  test.skipIf(!present)("le bug du 21/09 en miniature : deux const dans une seule portée, code 1", () => {
    const r = lancer("double-const.html");
    expect(r.code).toBe(1);
    expect(r.sortie).toContain("already been declared");
    rmSync(r.partage, { recursive: true, force: true });
  }, 30_000);

  test.skipIf(!present)("un clic, puis le texte changé", () => {
    const r = lancer("bouton.html", "--clic", "#go");
    expect(r.code).toBe(0);
    expect(r.sortie).toMatch(/après le clic 1 « #go » :[\s\S]*cliqué/);
    rmSync(r.partage, { recursive: true, force: true });
  }, 30_000);

  test.skipIf(!present)("un sélecteur introuvable est dit, sans arrêter", () => {
    const r = lancer("bouton.html", "--clic", "#absent", "--clic", "#go");
    expect(r.code).toBe(0);
    expect(r.sortie).toContain("clic 1 « #absent » : sélecteur introuvable");
    expect(r.sortie).toMatch(/après le clic 2 « #go » :[\s\S]*cliqué/);
    rmSync(r.partage, { recursive: true, force: true });
  }, 30_000);

  test.skipIf(!present)("une ressource chargée hors de partage/ est tracée", () => {
    const r = lancer("distante.html");
    expect(r.sortie).toMatch(/ressources hors de partage\/ \(1\)[\s\S]*https:\/\/example\.invalid\/x\.png/);
    rmSync(r.partage, { recursive: true, force: true });
  }, 30_000);

  test.skipIf(!present)("une capture PNG écrite dans partage/", () => {
    const r = lancer("saine.html", "--capture", "vue");
    expect(r.code).toBe(0);
    expect(r.sortie).toContain("capture : vue.png");
    const png = join(r.partage, "vue.png");
    expect(existsSync(png)).toBe(true);
    expect(statSync(png).size).toBeGreaterThan(100);
    expect(readFileSync(png).subarray(1, 4).toString()).toBe("PNG");
    rmSync(r.partage, { recursive: true, force: true });
  }, 30_000);

  test.skipIf(!present)("un chemin absolu à l'intérieur de partage/ est accepté (les consignes le donnent ainsi)", () => {
    const partage = mkdtempSync(join(tmpdir(), "essaim-voir-"));
    cpSync(fixtures, partage, { recursive: true });
    const p = Bun.spawnSync(["node", join(racine, "src", "voir.ts"), "--partage", partage, join(partage, "saine.html")], { cwd: racine, stdout: "pipe", stderr: "pipe" });
    expect(p.exitCode).toBe(0);
    expect(p.stdout.toString()).toContain("page_voir : 0 page saine");
    rmSync(partage, { recursive: true, force: true });
  }, 30_000);

  test.skipIf(!present)("style sans cible : code 1, la règle et sa feuille, mais rien pour les classes que le JS pose plus tard", () => {
    const r = lancer("style-orphelin.html");
    expect(r.code).toBe(1);
    expect(r.sortie).toContain("page_voir : 1 page en erreur");
    expect(r.sortie).toContain("styles sans cible (3) :");
    expect(r.sortie).toContain(".grille (orphelin.css) : aucun élément ne correspond, et le nom n'est ni dans la page ni dans ses scripts");
    expect(r.sortie).toContain(".grille td.selected (orphelin.css)");
    expect(r.sortie).toContain(".grille td (style en ligne 1)");
    expect(r.sortie).not.toContain(".actif"); // posée par le script, présente au chargement
    expect(r.sortie).not.toContain("#grid"); // dans la page
    expect(r.sortie).not.toContain("td:hover"); // pas de nom de classe ni d'id
    rmSync(r.partage, { recursive: true, force: true });
  }, 30_000);

  test.skipIf(!present)("couture saine : les classes que le script externe pose plus tard ne sont pas signalées, @media compris", () => {
    const r = lancer("style-couture.html");
    expect(r.code).toBe(0);
    expect(r.sortie).toContain("styles sans cible (0) :");
    rmSync(r.partage, { recursive: true, force: true });
  }, 30_000);

  test.skipIf(!present)("parcours de visiteur : le second onglet s'affiche vide, et le bouton qui détruit n'est pas cliqué", () => {
    const r = lancer("onglet-vide.html", "--parcours");
    expect(r.code).toBe(1); // une zone vide suffit à refuser le livrable
    expect(r.sortie).toContain("parcours de visiteur");
    expect(r.sortie).toMatch(/après le clic sur « Second », la zone #deux[^\n]*est vide/);
    expect(r.sortie).toContain("« Tout effacer » n'est pas cliqué");
    expect(r.sortie).not.toMatch(/la zone #un[^\n]*est vide/); // le premier onglet dessine vraiment
    rmSync(r.partage, { recursive: true, force: true });
  }, 30_000);

  test.skipIf(!present)("sans --parcours, rien n'est cliqué et la page reste saine", () => {
    const r = lancer("onglet-vide.html");
    expect(r.code).toBe(0);
    expect(r.sortie).not.toContain("parcours de visiteur");
    rmSync(r.partage, { recursive: true, force: true });
  }, 30_000);

  test.skipIf(!present)("ce qui recouvre la page : un hidden sans effet, et le texte masqué comptés", () => {
    const r = lancer("voile.html");
    expect(r.code).toBe(1); // la page s'ouvre sur un écran gris : elle est refusée
    expect(r.sortie).toContain("div.voile porte l'attribut hidden mais s'affiche quand même");
    expect(r.sortie).toContain("display: flex");
    expect(r.sortie).toMatch(/\d+ des \d+ blocs de texte visibles sont recouverts par autre chose/);
    expect(r.sortie).toContain("la page est masquée");
    expect(r.sortie).toContain("erreurs de console (0)"); // rien d'autre ne signalait le défaut
    rmSync(r.partage, { recursive: true, force: true });
  }, 30_000);

  test.skipIf(!present)("le même voile écrit correctement ne dit rien : hidden traité par la règle", () => {
    const r = lancer("hidden-sage.html");
    expect(r.code).toBe(0);
    expect(r.sortie).toContain("ce qui recouvre la page (0) :");
    rmSync(r.partage, { recursive: true, force: true });
  }, 30_000);

  test("page hors de partage/ ou absente : code 2, page refusée (invalide, pas une panne)", () => {
    for (const page of ["../x.html", "/etc/hosts", "absente.html"]) {
      const r = lancer(page);
      expect(r.code).toBe(2);
      expect(r.sortie).toContain("page_voir : 2 page refusée · ");
      rmSync(r.partage, { recursive: true, force: true });
    }
  });

  test.skipIf(!present)("une adresse avec ancre ou paramètres ouvre le fichier et garde la suite (index.html#salle, 27/09)", () => {
    for (const [page, attendu] of [["ancre.html#salle", "page salle"], ["ancre.html?t=12#cuisine", "page cuisine avec t=12"]]) {
      const r = lancer(page);
      expect(r.code).toBe(0);
      expect(r.sortie).toContain(attendu);
      rmSync(r.partage, { recursive: true, force: true });
    }
    const r = lancer("absente.html#salle");
    expect(r.code).toBe(2);
    rmSync(r.partage, { recursive: true, force: true });
  }, 60_000);
});

// Captures hors du livrable.
// Avec des rôles (ESSAIM_ROLE, posé par le lanceur), capture et planche vont dans <bureau>/captures/ et le texte rendu
// donne leur chemin absolu, lisible par read ; la recette, dont partage/ est en lecture seule, peut donc en faire.
describe("voir avec des rôles : les captures dans le bureau", () => {
  test.skipIf(!present)("capture et planche dans <bureau>/captures/, chemins absolus ; rien d'écrit dans partage/", () => {
    const partage = mkdtempSync(join(tmpdir(), "essaim-voir-"));
    cpSync(fixtures, partage, { recursive: true });
    const bureau = mkdtempSync(join(tmpdir(), "essaim-bureau-"));
    const p = Bun.spawnSync(["node", join(racine, "src", "voir.ts"), "--partage", partage, "tailles.html", "--capture", "vues/accueil", "--taille", "1280x800"],
      { cwd: racine, stdout: "pipe", stderr: "pipe", env: { ...process.env, ESSAIM_ROLE: "recette", ESSAIM_BUREAU: bureau } });
    const sortie = p.stdout.toString() + p.stderr.toString();
    const capture = join(bureau, "captures", "vues", "accueil.png");
    const planche = join(bureau, "captures", "vues", "accueil-tailles.png");
    expect(sortie).toContain(`capture : ${capture}`);
    expect(sortie).toContain(`planche : ${planche}`);
    expect(readFileSync(capture).subarray(1, 4).toString()).toBe("PNG");
    expect(statSync(planche).size).toBeGreaterThan(1000);
    expect(existsSync(join(partage, "vues"))).toBe(false);
    expect(existsSync(join(partage, "vues", "accueil-tailles.png"))).toBe(false);
    rmSync(partage, { recursive: true, force: true });
    rmSync(bureau, { recursive: true, force: true });
  }, 30_000);
});
