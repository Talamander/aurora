// Small, explainable language guess for posts whose source gives no language.
// Counts common function words per language; answers only when one language clearly leads.

const STOPWORDS: Record<string, string[]> = {
  en: ['the', 'and', 'is', 'are', 'was', 'of', 'to', 'in', 'that', 'it', 'for', 'with', 'this', 'you', 'not', 'have', 'but', 'what', 'just', 'from'],
  es: ['el', 'la', 'los', 'las', 'y', 'es', 'de', 'que', 'en', 'un', 'una', 'por', 'para', 'con', 'como', 'pero', 'lo', 'del', 'se', 'más'],
  fr: ['le', 'la', 'les', 'et', 'est', 'de', 'des', 'que', 'un', 'une', 'pour', 'dans', 'avec', 'pas', 'qui', 'sur', 'du', 'ce', 'mais', 'très'],
  de: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'ein', 'eine', 'zu', 'mit', 'auf', 'für', 'von', 'den', 'sich', 'auch', 'es', 'ich', 'wie', 'aber'],
  pt: ['o', 'os', 'as', 'e', 'é', 'de', 'que', 'em', 'um', 'uma', 'para', 'com', 'não', 'do', 'da', 'mais', 'por', 'como', 'mas', 'isso'],
  it: ['il', 'lo', 'gli', 'e', 'è', 'di', 'che', 'un', 'una', 'per', 'con', 'non', 'del', 'della', 'sono', 'come', 'ma', 'anche', 'questo', 'più'],
  nl: ['de', 'het', 'een', 'en', 'is', 'van', 'dat', 'niet', 'op', 'te', 'met', 'voor', 'zijn', 'ook', 'maar', 'je', 'ik', 'wat', 'naar', 'dit'],
};
const SETS = Object.fromEntries(Object.entries(STOPWORDS).map(([k, v]) => [k, new Set(v)]));

export function guessLang(text: string): string | null {
  const words = text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .split(/[^\p{L}]+/u)
    .filter(Boolean);
  if (words.length < 6) return null;
  const scores = Object.entries(SETS)
    .map(([lang, set]) => [lang, words.reduce((n, w) => n + (set.has(w) ? 1 : 0), 0)] as const)
    .sort((a, b) => b[1] - a[1]);
  const [best, second] = scores;
  if (best[1] < 2 || best[1] < second[1] * 1.5 + 1) return null;
  return best[0];
}
