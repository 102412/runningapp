import pg from 'pg';
import { loadConfig, loadDotEnv } from '../src/config';
import { migrate } from '../src/platform/db/migrate';

loadDotEnv();
const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 1 });
try {
  const result = await migrate(pool);
  console.log(
    result.applied.length === 0
      ? `Database is up to date (${result.alreadyApplied.length} migrations applied).`
      : `Applied ${result.applied.length} migration(s): ${result.applied.join(', ')}`,
  );
} finally {
  await pool.end();
}
