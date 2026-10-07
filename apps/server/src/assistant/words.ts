// The assistant's fixed sentences (step-6 plan Q23, screens §8): what the thread says when Kept,
// not the model, answers. Stored as the answer's text in the question's interface language (Q22),
// so the thread reads the same on every device. The location's name is the person's own text,
// isolated with FSI…PDI so it reads correctly inside a right-to-left sentence (lib/bidi.ts's rule
// on the web).

export type WordsLocale = 'en' | 'ar' | 'fr' | 'de' | 'it';

const FSI = '⁨';
const PDI = '⁩';
const iso = (s: string) => `${FSI}${s}${PDI}`;

export function wordsLocale(locale: string): WordsLocale {
  const base = locale.slice(0, 2).toLowerCase();
  return base === 'ar' || base === 'fr' || base === 'de' || base === 'it' ? base : 'en';
}

const VIEWER: Record<WordsLocale, (location: string) => string> = {
  en: (l) => `Viewers can't make changes here. Ask an admin of ${iso(l)}.`,
  ar: (l) => `لا يمكن للمشاهدين إجراء تغييرات هنا. اطلب ذلك من أحد مسؤولي ${iso(l)}.`,
  fr: (l) =>
    `Les lecteurs ne peuvent rien modifier ici. Demandez à un administrateur de ${iso(l)}.`,
  de: (l) => `Betrachter können hier nichts ändern. Frag eine Admin-Person von ${iso(l)}.`,
  it: (l) => `Chi visualizza non può fare modifiche qui. Chiedi a un amministratore di ${iso(l)}.`,
};

const NO_CHANGES: Record<WordsLocale, string> = {
  en: "You can't make changes here.",
  ar: 'لا يمكنك إجراء تغييرات هنا.',
  fr: 'Vous ne pouvez rien modifier ici.',
  de: 'Du kannst hier nichts ändern.',
  it: 'Non puoi fare modifiche qui.',
};

const NO_ANSWER: Record<WordsLocale, string> = {
  en: "I couldn't finish that answer. Ask again, perhaps more narrowly.",
  ar: 'لم أتمكن من إكمال هذه الإجابة. اسأل مرة أخرى، وربما بشكل أدق.',
  fr: "Je n'ai pas pu terminer cette réponse. Reposez la question, peut-être plus précisément.",
  de: 'Ich konnte die Antwort nicht abschließen. Frag noch einmal, vielleicht genauer.',
  it: 'Non sono riuscito a completare la risposta. Chiedi di nuovo, magari in modo più preciso.',
};

/** Screens §8: a viewer asked for a change, and the model tried one anyway. */
export function viewerRefusal(locale: string, locationName: string | null): string {
  const w = wordsLocale(locale);
  return locationName ? VIEWER[w](locationName) : NO_CHANGES[w];
}

/** The turn ran out of steps or time without an answer. */
export function noAnswer(locale: string): string {
  return NO_ANSWER[wordsLocale(locale)];
}
