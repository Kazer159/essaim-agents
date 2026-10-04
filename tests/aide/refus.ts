// La forme commune d'un refus : « refusé : <le fait>. <ce qui le lève>. », ou « refusé une fois : … » pour
// les rappels ; la levée commence par « Se lève », « Le même appel » ou « Définitif pour ce ». Sur la première ligne :
// une liste peut suivre. Une raison sans préfixe ni point final ("<fait>. <levée>") se vérifie avec raisonAuFormat.
export const FORME = /^refusé(?: une fois)? : .+\. (?:Se lève|Le même appel|Définitif pour ce)[^\n]*\.$/;
export const raisonAuFormat = (raison: string) => FORME.test(`refusé : ${raison.split("\n")[0]}.`);
