// integration.test.js — charge regles.js, ia.js et interface.js dans UNE SEULE
// portée, comme le navigateur le fait quand index.html les inclut l'un après
// l'autre. `bun test` seul charge chaque fichier isolément et ne voit pas une
// déclaration en double entre deux fichiers (essaim Puissance 4 du 21/09 :
// « Identifier 'NB_COLONNES' has already been declared »). Ce test est un
// complément au geste du juge (ouvrir la page), pas son remplaçant.
// À recopier tel quel dans le dossier partagé, à côté des trois fichiers.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const element = () => ({
  addEventListener() {}, removeEventListener() {}, appendChild(e) { return e; }, removeChild() {}, replaceChildren() {},
  classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  style: {}, textContent: "", innerHTML: "", dataset: {}, children: [], setAttribute() {}, getAttribute() { return null; },
  querySelector: () => element(), querySelectorAll: () => [], closest: () => null, focus() {},
});
const document = { ...element(), body: element(), documentElement: element(), getElementById: () => element(), createElement: () => element(), createTextNode: () => element(), readyState: "complete" };
const fenetre = { document, console, requestAnimationFrame: (f) => f(), setTimeout, clearTimeout, setInterval, clearInterval, Math, JSON, Object, Array };
fenetre.window = fenetre;
fenetre.globalThis = fenetre;

test("regles.js, ia.js et interface.js se chargent ensemble sans erreur", () => {
  const contexte = vm.createContext(fenetre);
  for (const f of ["regles.js", "ia.js", "interface.js"]) {
    expect(() => vm.runInContext(readFileSync(f, "utf8"), contexte, { filename: f })).not.toThrow();
  }
});
// Il n'affirme rien sur les noms exposés (window.Regles, module.exports…) : la
// mission laisse le découpage aux agents, et le témoin du 21/09 n'exposait pas
// de global nommé. Ce que le juge verra, c'est voir(index.html).
