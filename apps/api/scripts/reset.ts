import pg from 'pg';
import { loadConfig, loadDotEnv } from '../src/config';
import { migrate } from '../src/platform/db/migrate';

// Drops and recreates the public schema, then re-runs all migrations. Development only.
loadDotEnv();
const config = loadConfig();
if (config.isProduction) {
  console.error('Refusing to reset the database when NODE_ENV=production.');
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 1 });
try {
  await pool.query('drop schema public cascade');
  await pool.query('create schema public');
  const result = await migrate(pool);
  console.log(`Database reset. Applied ${result.applied.length} migration(s).`);
} finally {
  await pool.end();
}
