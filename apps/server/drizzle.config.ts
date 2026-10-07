import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './migrations',
  schemaFilter: ['public', 'kept', 'auth'],
  migrations: {
    table: 'migrations',
    schema: 'kept_meta',
  },
  dbCredentials: {
    url: process.env.KEPT_OWNER_DATABASE_URL ?? '',
  },
});
