import { defineConfig } from 'tsup';

// Bundles the API and the worker. Workspace packages are inlined so the production
// image needs only third-party node_modules. Migrations ship as plain .sql files.
export default defineConfig({
  entry: { server: 'src/server.ts', worker: 'src/worker.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  clean: true,
  noExternal: [/^@runningapp\//],
  esbuildOptions(options) {
    options.conditions = ['source'];
  },
});
