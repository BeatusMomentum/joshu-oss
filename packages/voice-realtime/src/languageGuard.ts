/**
 * Catch the model replying in the wrong language.
 *
 * Native-audio Live models choose the reply language from what they hear, and
 * a noisy phone line heard as Spanish got a Spanish reply (canary box
 * 2026-09-26). The prompt pins the owner's language; this is the backstop: it
 * spots a reply in another language, logs it, and hands the model one
 * correction.
 *
 * Deliberately small: stopword counts for the common Latin-script languages,
 * and a letter-script check for everything else. Short replies ("OK", names)
 * never trigger it.
 */

const STOPWORDS: Record<string, string[]> = {
  english: ["the", "and", "you", "your", "is", "are", "to", "of", "for", "it", "that", "with", "what", "have", "can", "i", "a", "in", "on", "be", "this", "at", "will", "about"],
  spanish: ["el", "la", "los", "las", "que", "de", "y", "en", "por", "para", "con", "una", "un", "es", "está", "usted", "tu", "su", "del", "al", "lo", "pero", "sí", "qué", "cómo", "puedo", "hola", "gracias"],
  french: ["le", "la", "les", "et", "est", "vous", "je", "une", "des", "pour", "que", "qui", "dans", "avec", "pas", "sur", "ce", "votre", "bonjour", "merci"],
  german: ["der", "die", "das", "und", "ist", "sie", "ich", "nicht", "ein", "eine", "mit", "für", "auf", "zu", "den", "ihr", "was", "kann", "hallo", "danke"],
  portuguese: ["o", "os", "as", "que", "de", "e", "em", "não", "para", "com", "uma", "um", "é", "você", "seu", "sua", "do", "da", "olá", "obrigado"],
  italian: ["il", "lo", "gli", "che", "di", "e", "è", "non", "per", "con", "una", "un", "sono", "lei", "suo", "della", "ciao", "grazie"],
};

/** Replies shorter than this many words are not judged. */
const MIN_WORDS = 5;

export type LanguageVerdict = { mismatch: boolean; detected?: string };

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}']+/u)
    .map((word) => word.replace(/^'+|'+$/g, ""))
    .filter(Boolean);
}

/**
 * Whether `text` looks like a language other than `ownerLanguage` (English
 * name, e.g. "English"). Unknown owner languages are only checked by script.
 */
export function detectLanguageMismatch(text: string, ownerLanguage: string): LanguageVerdict {
  const owner = ownerLanguage.trim().toLowerCase();
  const letters = [...text].filter((ch) => /\p{L}/u.test(ch));
  if (letters.length < 12) return { mismatch: false };
  const latin = letters.filter((ch) => /\p{Script=Latin}/u.test(ch)).length;
  const ownerUsesLatin = owner in STOPWORDS;
  if (ownerUsesLatin && latin / letters.length < 0.5) return { mismatch: true, detected: "non-latin script" };

  const tokens = words(text);
  if (tokens.length < MIN_WORDS || !ownerUsesLatin) return { mismatch: false };
  const scores = Object.entries(STOPWORDS).map(([language, list]) => {
    const set = new Set(list);
    return { language, hits: tokens.filter((token) => set.has(token)).length };
  });
  const ownerHits = scores.find((score) => score.language === owner)?.hits ?? 0;
  const best = scores.filter((score) => score.language !== owner).sort((a, b) => b.hits - a.hits)[0];
  if (!best || best.hits < 3) return { mismatch: false };
  // Clearly more of another language than of the owner's.
  if (best.hits >= Math.max(3, ownerHits * 2 + 1)) return { mismatch: true, detected: best.language };
  return { mismatch: false };
}

/** One corrective context note for the model. */
export function languageCorrection(ownerLanguage: string, detected: string | undefined): string {
  return (
    `[Joshu: your last reply was in ${detected && detected !== "non-latin script" ? detected : "another language"}. ` +
    `The owner speaks ${ownerLanguage}. Reply only in ${ownerLanguage} from now on, even if the line sounds like another language.]`
  );
}
