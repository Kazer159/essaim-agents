// La liste des tournures interdites : une constante des tests, pas une règle d'exécution. Lue par
// tests/descriptions.test.ts (descriptions, littéraux du code) et par le test des consignes.
export const MOTS_INTERDITS: Array<string | RegExp> = [
  "avant de", "avant d'", "quand tu", "pense à", "n'oublie pas", "il faut", "tu dois", "lis-le", "à relancer", "corrige-le",
  /(^|[^\p{L}])dis([^\p{L}]|$)/iu,
  // « ne … jamais » adressé à l'agent (« tu ne … jamais », « t'… jamais ») ; « une branche n'est jamais effacée » passe.
  /\bt(?:u\s+n(?:e\s|')|')\S*\s*\S+\s+jamais\b/iu,
];

export function motsInterdits(texte: string): string[] {
  const bas = texte.toLowerCase().replace(/’/g, "'");
  return MOTS_INTERDITS.filter((m) => (typeof m === "string" ? bas.includes(m) : m.test(bas))).map(String);
}
