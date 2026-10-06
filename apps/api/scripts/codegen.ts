import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadDotEnv } from '../src/config';

// Regenerates src/platform/db/generated.ts from the LIVE schema. Run after `db:migrate`.
loadDotEnv();
const config = loadConfig();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync(
  'pnpm',
  [
    'exec',
    'kysely-codegen',
    '--dialect',
    'postgres',
    '--url',
    config.DATABASE_URL,
    '--out-file',
    path.join(root, 'src/platform/db/generated.ts'),
    '--camel-case',
    '--exclude-pattern',
    'public.schema_migrations',
    '--numeric-parser',
    'number-or-string',
    // pg returns `date` as 'YYYY-MM-DD' strings and int8 as numbers (see platform/db/client.ts).
    '--type-mapping',
    JSON.stringify({ date: 'string', int8: 'number' }),
  ],
  { cwd: root, stdio: 'inherit' },
);
process.exit(result.status ?? 1);
