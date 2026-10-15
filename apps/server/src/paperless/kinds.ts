import type { PaperlessKind } from '../db/schema/paperless.js';

// What a Paperless document is, in Kept's paperwork roles (D248): its document type's name says
// so first, then its tags; a name that says nothing makes it a plain document. Paperless's types
// and tags are the person's own words, so the match is on whole words in the five languages Kept
// speaks, case- and accent-blind. "Copy into Kept" attaches the copy in this role.

const WORDS: readonly [PaperlessKind, readonly string[]][] = [
  ['warranty_doc', ['warranty', 'warranties', 'guarantee', 'garantie', 'garanzia', 'ضمان']],
  [
    'manual',
    [
      'manual',
      'manuals',
      'handbuch',
      'anleitung',
      'bedienungsanleitung',
      'manuel',
      'manuale',
      'دليل',
    ],
  ],
  ['invoice', ['invoice', 'invoices', 'rechnung', 'facture', 'fattura', 'فاتورة']],
  [
    'receipt',
    [
      'receipt',
      'receipts',
      'quittung',
      'kassenbon',
      'beleg',
      'reçu',
      'ticket',
      'ricevuta',
      'scontrino',
      'إيصال',
    ],
  ],
];

const fold = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

const FOLDED = WORDS.map(([kind, words]) => [kind, new Set(words.map(fold))] as const);

function kindOfName(name: string | null | undefined): PaperlessKind | null {
  if (!name) return null;
  const words = fold(name)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  for (const [kind, set] of FOLDED) if (words.some((w) => set.has(w))) return kind;
  return null;
}

/** The document type's name decides; failing that the first tag that names a kind. */
export function kindOf(
  typeName: string | null | undefined,
  tagNames: readonly string[],
): PaperlessKind {
  return kindOfName(typeName) ?? tagNames.map(kindOfName).find((k) => k !== null) ?? 'document';
}
