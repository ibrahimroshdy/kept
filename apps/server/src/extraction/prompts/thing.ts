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

/** 1.4 (D20, D230): every separate thing in the photo, each with its box, when the instance has
 * multi-item photos on. The photo is of a shelf, a drawer or a box's contents; each object becomes
 * its own draft with its own cropped picture. */
export const MANY_VERSION = 'thing-many-v1';

export function thingManyPrompt(ctx: PromptContext): BuiltPrompt {
  const langs = ctx.languages.length > 0 ? ctx.languages : ['en'];
  const first = langs[0] as string;
  return {
    version: MANY_VERSION,
    system: systemPrompt('list each separate object in the photo', [
      'objects: one entry per separate object a person would keep track of, at most 12, the most prominent first. Leave out the shelf, box or surface they sit on, and anything only partly in view or too small to recognise.',
      'Several identical objects side by side are one entry with a quantity.',
      'bbox: [x, y, width, height] of the object, each a fraction of the photo between 0 and 1, from the top left corner, tight around the object.',
      `name: a short everyday name a person would search for, in ${languageList([first])}, such as "Cordless drill" or "HDMI cable".`,
      'brand and model: only when printed on the object or unmistakable from its design.',
      'colour: the main colour in one or two plain words.',
      'type_hint: a general kind in English, such as "power tool", "cable" or "kitchen appliance".',
      'quantity: only when several identical objects are clearly shown; the count.',
      'serial: only when a serial number is printed and readable; copy it exactly.',
      `aliases: 3 to 6 search keywords per language, for each of ${languageList(langs)}, keyed by the language code.`,
    ]),
    text: 'What separate objects are in this photo?',
  };
}
