import { once } from 'node:events';
import { createWriteStream, type WriteStream } from 'node:fs';
import { CSV_BOM, CSV_EOL, type CsvValue, csvLine } from '@kept/shared';
import type pg from 'pg';
import { type ReadContext, readEntity } from '../data.js';
import { type EntityDef, fieldsOf } from '../registry.js';

// The readable copy's spreadsheets (D159, D169; plan T13, Q12): UTF-8 with a BOM (so a
// spreadsheet reads Arabic), CRLF line ends, every cell through @kept/shared's safeCsvCell() (a
// leading `=`, `+`, `-`, `@`, tab or carriage return neutralised). things.csv and places.csv are
// written for people (names, not ids); every other entity's CSV has the registry's fields, plus
// the thing's name beside a `thing_id`.

/** A CSV written a line at a time, waiting for the disk when it asks to. */
export class CsvFile {
  private readonly out: WriteStream;
  rows = 0;

  constructor(file: string, header: readonly string[]) {
    this.out = createWriteStream(file, { mode: 0o600 });
    this.out.write(`${CSV_BOM}${csvLine(header)}${CSV_EOL}`);
  }

  async line(cells: readonly CsvValue[]): Promise<void> {
    this.rows += 1;
    if (!this.out.write(`${csvLine(cells)}${CSV_EOL}`)) await once(this.out, 'drain');
  }

  async close(): Promise<void> {
    this.out.end();
    await once(this.out, 'finish');
  }
}

const cellOf = (v: unknown): CsvValue => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  return JSON.stringify(v);
};

/** `<entity>.csv` from the registry's fields, in the requester's scope. */
export async function writeEntityCsv(
  client: pg.ClientBase,
  def: EntityDef,
  ctx: ReadContext,
  file: string,
  thingNames: ReadonlyMap<string, string>,
): Promise<number> {
  const fields = fieldsOf(def).filter((f) => ctx.showMoney || !def.money?.includes(f.column));
  const named = fields.some((f) => f.column === 'thing_id');
  const header = fields.flatMap((f) =>
    f.column === 'thing_id' ? ['thing', f.column] : [f.column],
  );
  const csv = new CsvFile(file, header);
  try {
    for await (const row of readEntity(client, def, ctx)) {
      const cells: CsvValue[] = [];
      for (const f of fields) {
        if (named && f.column === 'thing_id') {
          const id = row[f.name];
          cells.push(typeof id === 'string' ? (thingNames.get(id) ?? '') : '');
        }
        cells.push(cellOf(row[f.name]));
      }
      await csv.line(cells);
    }
  } finally {
    await csv.close();
  }
  return csv.rows;
}
