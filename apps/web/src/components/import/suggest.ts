/**
 * The import stepper's guesses (plan T30): which field each column is, from its header in any of
 * the five languages ("Name", "الاسم", "Désignation"); which date format the dates are in; and
 * which separator the place paths use. Guesses only fill the form: the person changes any of them,
 * and the server's dry run checks every cell again.
 */
import { DATE_FORMATS, type DateFormat, type MappableField, parseCsvDate } from '@kept/shared';

/** Fields at most one column can map to; every other field takes several (the server's MULTI). */
export const MULTI_FIELDS: ReadonlySet<string> = new Set([
  'notes',
  'tags',
  'aliases',
  'legacy_code',
  'own_code',
  'ignore',
]);

/** A header as it's compared: lowercase, no diacritics, tatweel or punctuation, one space. */
export function normaliseHeader(header: string): string {
  return header
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/ـ/g, '')
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/^ال(?=\p{L}{2})/u, '')
    .replace(/\s+/g, ' ');
}

/**
 * Header words per field, in English, Arabic, French, German and Italian, compared after
 * normaliseHeader() (so Arabic is listed without its article: "اسم" matches "الاسم").
 */
const WORDS: Record<Exclude<MappableField, `custom.${string}` | 'ignore'>, string[]> = {
  name: [
    'name',
    'item',
    'item name',
    'thing',
    'title',
    'product',
    'product name',
    'اسم',
    'صنف',
    'منتج',
    'nom',
    'article',
    'designation',
    'objet',
    'bezeichnung',
    'artikel',
    'gegenstand',
    'nome',
    'oggetto',
    'articolo',
  ],
  quantity: [
    'quantity',
    'qty',
    'count',
    'number of items',
    'كمية',
    'عدد',
    'quantite',
    'qte',
    'nombre',
    'menge',
    'anzahl',
    'stuck',
    'quantita',
    'qta',
  ],
  brand: [
    'brand',
    'make',
    'maker',
    'manufacturer',
    'ماركة',
    'علامة التجارية',
    'علامة تجارية',
    'شركة المصنعة',
    'مصنع',
    'marque',
    'fabricant',
    'marke',
    'hersteller',
    'marca',
    'produttore',
  ],
  model: ['model', 'model number', 'موديل', 'طراز', 'modele', 'modell', 'modello'],
  serial: [
    'serial',
    'serial number',
    'serial no',
    'sn',
    's n',
    'رقم تسلسلي',
    'رقم التسلسلي',
    'سيريال',
    'numero de serie',
    'n de serie',
    'seriennummer',
    'numero di serie',
    'matricola',
  ],
  barcode: [
    'barcode',
    'ean',
    'upc',
    'gtin',
    'باركود',
    'رمز شريطي',
    'code barres',
    'code a barres',
    'strichcode',
    'barcode nummer',
    'codice a barre',
  ],
  colour: ['colour', 'color', 'لون', 'couleur', 'farbe', 'colore'],
  condition: ['condition', 'state', 'حالة', 'etat', 'zustand', 'condizione', 'stato'],
  notes: [
    'notes',
    'note',
    'description',
    'comments',
    'comment',
    'remarks',
    'ملاحظات',
    'ملاحظة',
    'وصف',
    'remarques',
    'commentaire',
    'notizen',
    'notiz',
    'beschreibung',
    'bemerkungen',
    'descrizione',
    'commenti',
  ],
  tags: [
    'tags',
    'tag',
    'labels',
    'وسوم',
    'وسم',
    'تصنيفات',
    'etiquettes',
    'mots cles',
    'schlagworter',
    'etichette',
  ],
  place_path: [
    'place',
    'location',
    'room',
    'where',
    'path',
    'place path',
    'مكان',
    'موقع',
    'غرفة',
    'emplacement',
    'lieu',
    'piece',
    'ort',
    'standort',
    'raum',
    'lagerort',
    'posizione',
    'luogo',
    'stanza',
  ],
  type: [
    'type',
    'category',
    'kind',
    'نوع',
    'فئة',
    'categorie',
    'typ',
    'kategorie',
    'tipo',
    'categoria',
  ],
  aliases: [
    'aliases',
    'alias',
    'also known as',
    'other names',
    'أسماء أخرى',
    'اسماء اخرى',
    'autres noms',
    'andere namen',
    'altri nomi',
  ],
  purchased_on: [
    'purchase date',
    'purchased',
    'purchased on',
    'purchase time',
    'date purchased',
    'bought',
    'bought on',
    'date bought',
    'تاريخ الشراء',
    'تاريخ شراء',
    'date d achat',
    'achete le',
    'kaufdatum',
    'gekauft am',
    'data di acquisto',
    'data acquisto',
  ],
  vendor: [
    'vendor',
    'shop',
    'store',
    'seller',
    'retailer',
    'purchased from',
    'purchase from',
    'bought from',
    'where bought',
    'متجر',
    'بائع',
    'محل',
    'magasin',
    'vendeur',
    'boutique',
    'handler',
    'geschaft',
    'verkaufer',
    'negozio',
    'venditore',
  ],
  price: [
    'price',
    'cost',
    'purchase price',
    'amount paid',
    'paid',
    'سعر',
    'ثمن',
    'تكلفة',
    'prix',
    'cout',
    'preis',
    'kaufpreis',
    'kosten',
    'prezzo',
    'costo',
  ],
  currency: ['currency', 'عملة', 'devise', 'monnaie', 'wahrung', 'valuta'],
  manual_url: [
    'manual',
    'manual url',
    'manual link',
    'user manual',
    'دليل',
    'دليل الاستخدام',
    'كتيب',
    'manuel',
    'mode d emploi',
    'handbuch',
    'anleitung',
    'bedienungsanleitung',
    'manuale',
  ],
  legacy_code: [
    'code',
    'asset id',
    'asset tag',
    'asset number',
    'inventory number',
    'label',
    'label code',
    'رمز',
    'كود',
    'رقم الأصل',
    'رقم الاصل',
    'رقم الجرد',
    'numero d inventaire',
    'code inventaire',
    'inventarnummer',
    'anlagennummer',
    'numero di inventario',
    'codice',
  ],
  own_code: [
    'own code',
    'my code',
    'kept code',
    'رمزي',
    'الرمز الخاص',
    'كودي',
    'mon code',
    'code personnel',
    'eigener code',
    'mein code',
    'codice personale',
    'mio codice',
  ],
  source_id: [
    'id',
    'uuid',
    'guid',
    'ref',
    'reference',
    'import ref',
    'row id',
    'item id',
    'معرف',
    'مرجع',
  ],
};

const LOOKUP = (() => {
  const map = new Map<string, MappableField>();
  for (const [field, words] of Object.entries(WORDS)) {
    for (const w of words) map.set(normaliseHeader(w), field as MappableField);
  }
  return map;
})();

/** The field a header names, or null. A Homebox export's `HB.` prefix is looked past. */
export function fieldFromHeader(header: string): MappableField | null {
  const h = normaliseHeader(header);
  return LOOKUP.get(h) ?? LOOKUP.get(h.replace(/^hb /, '')) ?? null;
}

/**
 * A mapping for these headers: each column its guessed field, or `ignore`. A field that takes one
 * column goes to the first column that names it; a later one is left for the person to choose.
 */
export function suggestMapping(columns: readonly string[]): Record<string, MappableField> {
  const out: Record<string, MappableField> = {};
  const used = new Set<string>();
  for (const column of columns) {
    const field = fieldFromHeader(column);
    if (field && (MULTI_FIELDS.has(field) || !used.has(field))) {
      out[column] = field;
      used.add(field);
    } else out[column] = 'ignore';
  }
  return out;
}

/**
 * The date formats that read the most sampled dates (all of them, in a clean file), in
 * DATE_FORMATS' order: one when the file settles it, several when it doesn't (every day ≤ 12),
 * none when nothing reads. A date that doesn't read in any format (31/02) doesn't decide it.
 */
export function dateFormatsFor(values: readonly string[]): DateFormat[] {
  const sample = values.filter((v) => v.trim() !== '').slice(0, 500);
  const counts = DATE_FORMATS.map((f) => sample.filter((v) => parseCsvDate(v, f) !== null).length);
  const best = Math.max(0, ...counts);
  return best === 0 ? [] : DATE_FORMATS.filter((_, i) => counts[i] === best);
}

/** The separator the place paths use most: `>`, `/` or `\`; `>` when none appears. */
export function separatorFor(values: readonly string[]): '>' | '/' | '\\' {
  const counts = { '>': 0, '/': 0, '\\': 0 };
  for (const v of values.slice(0, 500)) {
    for (const ch of v) if (ch === '>' || ch === '/' || ch === '\\') counts[ch] += 1;
  }
  const best = (Object.entries(counts) as ['>' | '/' | '\\', number][]).sort(
    (a, b) => b[1] - a[1],
  )[0];
  return best && best[1] > 0 ? best[0] : '>';
}

/** A custom field's key as registry keys are written, for the `custom.<key>` choice. */
export const CUSTOM_KEY = /^[a-z][a-z0-9_]{0,39}$/;
