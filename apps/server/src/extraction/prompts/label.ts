/**
 * LABEL mode (engineering spec §2.1; D19, D175): a nameplate, a rating label or a vehicle
 * document. Brand and model fill in the thing when confident; a serial, VIN, plate and dates wait
 * for review. The spike (2026-09-26) saw the serial copied into `vin`; checks.ts drops a VIN that
 * fails its checksum, and the prompt says not to.
 */
import { type BuiltPrompt, type PromptContext, systemPrompt } from './common.js';

export const PROMPT_VERSION = 'label-v1';

export function labelPrompt(_ctx: PromptContext): BuiltPrompt {
  return {
    version: PROMPT_VERSION,
    system: systemPrompt('read a label, nameplate or vehicle document', [
      'brand: the maker as printed.',
      'model: the model name or model code, copied exactly as printed (keep letters, digits, dashes and slashes).',
      'serial: the serial number, only when it is labelled as one (S/N, Serial, SN, Seriennummer, الرقم التسلسلي); copy it exactly.',
      'vin: only a vehicle identification number or chassis number labelled as such. Never copy the serial into vin.',
      'plate: only a vehicle licence plate or registration number labelled as such.',
      'document_kind: registration, insurance, licence or inspection for a vehicle or official document; other for any other document; leave it out for a nameplate or label on a product.',
      'expires_on and manufactured_on: YYYY-MM-DD, only when printed.',
    ]),
    text: 'Read this label.',
  };
}
