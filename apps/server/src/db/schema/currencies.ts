import { sql } from 'drizzle-orm';
import { boolean, char, check, integer, pgTable, text } from 'drizzle-orm/pg-core';

/** The supported currencies (D136, §7.13): a reference table, so adding one is a row, not a
 * migration. Money columns reference it with a foreign key. Seeded by a custom migration. */
export const currencies = pgTable(
  'currencies',
  {
    code: char('code', { length: 3 }).primaryKey(),
    name: text('name').notNull(),
    minorUnits: integer('minor_units').notNull(),
    symbol: text('symbol').notNull(),
    enabled: boolean('enabled').notNull().default(true),
  },
  () => [
    check('currencies_code_chk', sql`code ~ '^[A-Z]{3}$'`),
    check('currencies_minor_units_chk', sql`minor_units BETWEEN 0 AND 4`),
  ],
);
