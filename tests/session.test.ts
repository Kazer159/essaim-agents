import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fichierSession, historiqueEmpoisonne, OUTIL_INCONNU, reparerAppelsVides, retirerImages, tropDImages } from "../src/session.ts";

// La forme exacte observée : un appel d'outil sans nom ni numéro, son
// résultat « Tool not found » sans numéro, puis les refus du fournisseur.
const ligne = (o: unknown) => JSON.stringify(o);
const EMPOISONNEE = [
  ligne({ type: "session", id: "Agathe" }),
  ligne({ type: "message", id: "a1", parentId: null, message: { role: "assistant", content: [{ type: "toolCall", id: "call_ok", name: "salle_poster", arguments: {} }] } }),
  ligne({ type: "message", id: "a2", parentId: "a1", message: { role: "toolResult", toolCallId: "call_ok", toolName: "salle_poster", content: [] } }),
  ligne({ type: "message", id: "a3", parentId: "a2", message: { role: "assistant", content: [{ type: "thinking", thinking: "je me résume" }, { type: "toolCall", id: "", name: "", arguments: {} }] } }),
  ligne({ type: "message", id: "a4", parentId: "a3", message: { role: "toolResult", toolCallId: "", toolName: "", content: [{ type: "text", text: "Tool  not found" }], isError: true } }),
  ligne({ type: "message", id: "a5", parentId: "a4", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "400: messages[67]: tool messages must include a non-empty string tool_call_id" } }),
].join("\n") + "\n";

let dossier = "";
afterEach(() => { if (dossier) rmSync(dossier, { recursive: true, force: true }); });

describe("la mémoire empoisonnée par un appel d'outil vide (run festival, 24/09)", () => {
  test("l'appel vide et son résultat reçoivent le même numéro et un nom ; le reste ne bouge pas", () => {
    dossier = mkdtempSync(join(tmpdir(), "essaim-session-"));
    const f = join(dossier, "2026-09-24T15-10-11-700Z_Agathe.jsonl");
    writeFileSync(f, EMPOISONNEE);
    expect(reparerAppelsVides(f)).toBe(1);
    const l = readFileSync(f, "utf8").split("\n").filter(Boolean).map((x) => JSON.parse(x));
    const appel = l[3].message.content[1], resultat = l[4].message;
    expect(appel.id).toBeTruthy();
    expect(appel.name).toBe(OUTIL_INCONNU);
    expect(resultat.toolCallId).toBe(appel.id);
    expect(resultat.toolName).toBe(OUTIL_INCONNU);
    expect(l[1].message.content[0].id).toBe("call_ok");
    expect(l.map((e) => e.id)).toEqual(["Agathe", "a1", "a2", "a3", "a4", "a5"]); // l'arbre de la session est intact
    expect(reparerAppelsVides(f)).toBe(0); // une seconde fois : rien à faire, fichier inchangé
  });

  test("une seconde réparation plus tard dans le run ne réutilise pas les numéros de la première (29/09, revue)", () => {
    dossier = mkdtempSync(join(tmpdir(), "essaim-session-"));
    const f = join(dossier, "2026-09-24T15-10-11-700Z_Agathe.jsonl");
    writeFileSync(f, EMPOISONNEE);
    expect(reparerAppelsVides(f)).toBe(1);
    writeFileSync(f, readFileSync(f, "utf8") + [ // plus tard, un second appel vide
      ligne({ type: "message", id: "b1", parentId: "a5", message: { role: "assistant", content: [{ type: "toolCall", id: "", name: "", arguments: {} }] } }),
      ligne({ type: "message", id: "b2", parentId: "b1", message: { role: "toolResult", toolCallId: "", toolName: "", content: [] } }),
    ].join("\n") + "\n");
    expect(reparerAppelsVides(f)).toBe(1);
    const ids = readFileSync(f, "utf8").split("\n").filter(Boolean).map((x) => JSON.parse(x))
      .flatMap((e) => (Array.isArray(e.message?.content) ? e.message.content : [])).filter((p: { type?: string }) => p.type === "toolCall").map((p: { id: string }) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  test("on reconnaît l'erreur, et on trouve le fichier de l'agent", () => {
    expect(historiqueEmpoisonne('400: {"message":"messages[21]: tool messages must include a non-empty string tool_call_id"}')).toBe(true);
    expect(historiqueEmpoisonne("402: insufficient credits")).toBe(false);
    dossier = mkdtempSync(join(tmpdir(), "essaim-session-"));
    writeFileSync(join(dossier, "2026-09-24T15-10-11-700Z_Agathe.jsonl"), "");
    writeFileSync(join(dossier, "2026-09-24T15-10-11-701Z_Agnes.jsonl"), "");
    expect(fichierSession(dossier, "Agathe")).toBe(join(dossier, "2026-09-24T15-10-11-700Z_Agathe.jsonl"));
    expect(fichierSession(dossier, "Bernard")).toBeUndefined();
  });
});

// La forme observée : des captures lues avec `read`, gardées dans la mémoire après un
// résumé ; le fournisseur refuse toute la requête (« Too many images in request: 6 > 4 »), à chaque relance.
describe("trop d'images dans la mémoire (run ville, 25/09)", () => {
  const image = { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" };
  const AVEC_IMAGES = [
    ligne({ type: "session", id: "Hubert" }),
    ligne({ type: "compaction", id: "c1", summary: "## Goal" }),
    ligne({ type: "message", id: "a1", parentId: "c1", message: { role: "assistant", content: [{ type: "toolCall", id: "r1", name: "read", arguments: { path: "partage/plan.png" } }] } }),
    ligne({ type: "message", id: "a2", parentId: "a1", message: { role: "toolResult", toolCallId: "r1", toolName: "read", content: [{ type: "text", text: "Read image file [image/png]" }, image] } }),
    ligne({ type: "message", id: "a3", parentId: "a2", message: { role: "toolResult", toolCallId: "r2", toolName: "read", content: [{ type: "text", text: "Read image file [image/png]" }, image, image] } }),
    ligne({ type: "message", id: "a4", parentId: "a3", message: { role: "user", content: [{ type: "text", text: "continue" }] } }),
  ].join("\n") + "\n";

  test("l'erreur est reconnue, et elle seule", () => {
    expect(tropDImages("Too many images in request: 6 > 4")).toBe(true);
    expect(tropDImages('413: {"message":"Downloaded image content cannot exceed 30MB","code":413}')).toBe(true);
    expect(tropDImages("Provider timed out after 23836ms")).toBe(false);
    expect(tropDImages(undefined)).toBe(false);
  });

  test("chaque image devient une ligne de texte qui dit comment la revoir ; le reste ne bouge pas", () => {
    dossier = mkdtempSync(join(tmpdir(), "essaim-session-"));
    const f = join(dossier, "2026-09-25T09-21-55-100Z_Hubert.jsonl");
    writeFileSync(f, AVEC_IMAGES);
    expect(retirerImages(f)).toBe(3);
    const texte = readFileSync(f, "utf8");
    expect(texte).not.toContain('"type":"image"');
    const l = texte.split("\n").filter(Boolean).map((x) => JSON.parse(x));
    expect(l[3].message.content).toHaveLength(2);
    expect(l[3].message.content[1].type).toBe("text");
    expect(l[3].message.content[1].text).toContain("relis le fichier");
    expect(l[3].message.toolCallId).toBe("r1");
    expect(l[0]).toEqual({ type: "session", id: "Hubert" });
    expect(l[5].message.content).toEqual([{ type: "text", text: "continue" }]);
    expect(retirerImages(f)).toBe(0); // plus rien à retirer : le fichier n'est pas réécrit
  });
});
