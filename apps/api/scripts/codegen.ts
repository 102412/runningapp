import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config';

// Regenerates src/platform/db/generated.ts from the LIVE schema. Run after `db:migrate`.
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
    // pg returns `date` columns as 'YYYY-MM-DD' strings (see platform/db/client.ts).
    '--type-mapping',
    JSON.stringify({ date: 'string' }),
  ],
  { cwd: root, stdio: 'inherit' },
);
process.exit(result.status ?? 1);
