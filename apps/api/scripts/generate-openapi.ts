import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { tidyOpenApi } from '../src/platform/http/openapi';
import { createPlatform } from '../src/platform/create';
import { createServices } from '../src/services';
import { renderApiReference } from './api-reference';

/**
 * Writes the machine-readable API contract to docs/openapi.json and the human-readable endpoint
 * table to docs/API_REFERENCE.md. No database connection is made:
 * the spec is derived purely from route/schema registration. Committed output is verified by CI.
 */
const config = loadConfig({
  ...process.env,
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DEV_ENDPOINTS_ENABLED: 'true',
  PUBLIC_BASE_URL: 'http://localhost:3000',
  RATE_LIMIT_ENABLED: 'false',
});
const platform = createPlatform(config);
const app = await buildApp(platform, createServices(platform));
await app.ready();

const spec = tidyOpenApi(app.swagger());
const out = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../docs/openapi.json',
);
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, `${JSON.stringify(spec, null, 2)}\n`);
console.log(`Wrote ${out} (${Object.keys(spec.paths ?? {}).length} paths)`);

const reference = path.resolve(path.dirname(out), 'API_REFERENCE.md');
await writeFile(reference, renderApiReference(spec as Parameters<typeof renderApiReference>[0]));
console.log(`Wrote ${reference}`);

await app.close();
await platform.close();
