import { z } from 'zod';
import { envSchema } from './env.js';

function defaultOf(field: z.ZodType): string {
  if (!(field instanceof z.ZodDefault)) return '';
  return `\`${String(field.def.defaultValue)}\``;
}

/**
 * Renders the `.env.example` contract as a markdown table, for `kept admin config` (D81).
 * The variable names, defaults and notes come straight from the zod schema (`.default()` and
 * `.describe()`), so the schema stays the single source of truth.
 */
export function renderEnvReference(): string {
  const rows = Object.entries(envSchema.shape).map(([name, field]) => {
    const description = field.description ?? '';
    return `| \`${name}\` | ${defaultOf(field)} | ${description} |`;
  });
  return ['| Variable | Default | Notes |', '|---|---|---|', ...rows].join('\n');
}
