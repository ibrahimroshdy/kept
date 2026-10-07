/**
 * THING mode (engineering spec §2.1; D19, D20, D41): what one object in the photo is. Name, brand,
 * model, type and colour are filled in without asking when confident (apply.ts); a serial and a
 * quantity above 1 wait for review. Printed model codes and serials belong to LABEL mode (spike
 * 2026-09-26 finding 5: THING mode left out a clearly printed model and serial).
 */
import { type BuiltPrompt, languageList, type PromptContext, systemPrompt } from './common.js';

export const PROMPT_VERSION = 'thing-v1';

export function thingPrompt(ctx: PromptContext): BuiltPrompt {
  const langs = ctx.languages.length > 0 ? ctx.languages : ['en'];
  const first = langs[0] as string;
  return {
    version: PROMPT_VERSION,
    system: systemPrompt('describe the one main object in the photo', [
      `objects: exactly one entry, for the main object. Ignore the background and anything only partly in view.`,
      `name: a short everyday name a person would search for, in ${languageList([first])}, such as "Cordless drill" or "HDMI cable". No brand or model in the name unless that is what people call it.`,
      'brand and model: only when printed on the object or unmistakable from its design. Copy a printed model code exactly.',
      'colour: the main colour in one or two plain words.',
      'type_hint: a general kind in English, such as "power tool", "cable", "phone", "furniture" or "kitchen appliance".',
      'quantity: only when several identical objects are clearly shown; the count.',
      'serial: only when a serial number is printed and readable; copy it exactly.',
      `aliases: 3 to 6 search keywords per language, for each of ${languageList(langs)}, keyed by the language code: other words people use for this object (synonyms, the category, what it is for). Lower case, no brand repeated in every keyword.`,
      'bbox: leave it out.',
    ]),
    text: 'What is the main object in this photo?',
  };
}
