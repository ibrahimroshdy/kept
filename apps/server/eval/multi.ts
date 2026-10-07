/**
 * V2's probe: can a provider return usable boxes for several things in one photo (D20, D129)?
 * Multi-item capture ships in 1.x (D130), so this is **evaluation only**: the worker has no such
 * mode, THING's schema allows one object, and nothing here is imported by `src/`. The harness
 * sends it through the same `callModel` door as every extraction (the ledger task is
 * `extract_thing`), with its own prompt and wire schema, and scores the boxes against the case's.
 */
import type { JSONSchema7 } from 'ai';
import { z } from 'zod';
import { type BuiltPrompt, systemPrompt } from '../src/extraction/prompts/common.js';

export const MULTI_PROMPT_VERSION = 'multi-probe-v1';

export function multiPrompt(): BuiltPrompt {
  return {
    version: MULTI_PROMPT_VERSION,
    system: systemPrompt('list every separate object in the photo', [
      'objects: one entry per separate physical object a person would put in an inventory. Leave out walls, shelves, tables and other furniture the objects stand on.',
      'name: a short everyday name in English, such as "Mug" or "Book".',
      "bbox: the object's box as [x, y, width, height], each from 0 to 1 of the photo's width and height; x and y are the top-left corner. Fit it tightly around the whole object.",
    ]),
    text: 'List the objects in this photo.',
  };
}

const unit = { type: 'number', minimum: 0, maximum: 1 } as const;

export const MULTI_WIRE: JSONSchema7 = {
  type: 'object',
  properties: {
    objects: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          confidence: { ...unit },
          bbox: { type: 'array', items: { ...unit }, minItems: 4, maxItems: 4 },
        },
        required: ['name', 'bbox'],
        additionalProperties: false,
      },
    },
  },
  required: ['objects'],
  additionalProperties: false,
};

const MultiObject = z.object({
  name: z.string().trim().min(1).max(120),
  confidence: z.number().min(0).max(1).optional(),
  bbox: z.tuple([
    z.number().min(0).max(1),
    z.number().min(0).max(1),
    z.number().min(0).max(1),
    z.number().min(0).max(1),
  ]),
});

/** Keeps the objects that parse; null when there is no `objects` array at all. */
export function parseMulti(
  raw: unknown,
): { objects: z.output<typeof MultiObject>[]; dropped: number } | null {
  const list = (raw as { objects?: unknown })?.objects;
  if (!Array.isArray(list)) return null;
  const objects: z.output<typeof MultiObject>[] = [];
  let dropped = 0;
  for (const o of list) {
    const p = MultiObject.safeParse(o);
    if (p.success) objects.push(p.data);
    else dropped++;
  }
  return { objects, dropped };
}
