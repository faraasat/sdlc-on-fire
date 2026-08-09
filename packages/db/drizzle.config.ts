import { defineConfig } from 'drizzle-kit';

/**
 * Migrations are generated from `src/schema.ts` — the single source of truth.
 * Hand-editing generated SQL would reintroduce exactly the drift this config
 * exists to prevent.
 */
export default defineConfig({
  schema: './src/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
});
