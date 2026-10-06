import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Keeps the modular monolith modular. Cross-module dependencies are PINNED here: adding one is a
 * deliberate architecture decision (edit this table and say why in docs/DECISIONS.md), not
 * something that slips in through an import. The layering mirrors the composition root
 * (src/services.ts): platform <- leaf modules <- content modules <- flows.
 */

const SRC = path.resolve(__dirname, '../src');

/** module -> the other modules it is allowed to import. Everything may import `platform` and `config`. */
const ALLOWED: Record<string, string[]> = {
  // leaves
  'modules/users': [],
  'modules/notifier': [],
  'modules/sports': [],
  'modules/creators': [],
  'modules/integrations': [],
  'modules/media': [],
  'modules/dev': [],
  // identity & graph
  'modules/auth': ['modules/users'],
  'modules/social': ['modules/notifier', 'modules/users'],
  // content
  'modules/activities': ['modules/social', 'modules/sports', 'modules/users'],
  'modules/posts': [
    'modules/activities',
    'modules/media',
    'modules/notifier',
    'modules/social',
    'modules/users',
  ],
  'modules/profiles': ['modules/creators', 'modules/media', 'modules/social', 'modules/users'],
  'modules/engagement': ['modules/notifier', 'modules/posts', 'modules/social', 'modules/users'],
  // consumers of content
  'modules/events': ['modules/posts', 'modules/social'],
  'modules/feed': ['modules/posts', 'modules/social', 'modules/users'],
  'modules/notifications': ['modules/media', 'modules/posts', 'modules/social', 'modules/users'],
  'modules/search': ['modules/posts', 'modules/social', 'modules/users'],
  'modules/discovery': ['modules/posts', 'modules/search', 'modules/users'],
  'modules/moderation': ['modules/notifier', 'modules/posts', 'modules/social', 'modules/users'],
  'modules/exports': ['modules/users'],
  // cross-module orchestration
  flows: ['modules/activities', 'modules/media', 'modules/posts'],
};

/** Third-party packages that may only be touched from specific places (adapters stay isolated). */
const PACKAGE_HOMES: Record<string, string[]> = {
  pg: ['platform'],
  '@aws-sdk/client-s3': ['platform'],
  '@aws-sdk/s3-request-presigner': ['platform'],
  nodemailer: ['platform'],
  '@node-rs/argon2': ['platform'],
  'prom-client': ['platform'],
  jose: ['modules/auth'],
  'fast-xml-parser': ['modules/activities'],
  'node:child_process': ['modules/media'],
};

interface Import {
  from: string; // file (relative to src)
  spec: string;
  typeOnly: boolean;
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(full) : full.endsWith('.ts') ? [full] : [];
  });
}

const ALL = files(SRC).map((f) => path.relative(SRC, f));

function importsOf(rel: string): Import[] {
  const text = readFileSync(path.join(SRC, rel), 'utf8');
  const out: Import[] = [];
  const re = /(?:^|\n)\s*(import|export)\s+(type\s+)?([^'";]*?)\s*from\s*['"]([^'"]+)['"]/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out.push({ from: rel, spec: m[4] as string, typeOnly: Boolean(m[2]) });
  }
  // side-effect and dynamic imports
  for (const m of text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    out.push({ from: rel, spec: m[1] as string, typeOnly: false });
  }
  return out;
}

/** "modules/posts", "platform", "flows" or "root:services" for a path relative to src. */
function unitOf(rel: string): string {
  const parts = rel.split(path.sep);
  if (parts[0] === 'modules' && parts.length > 2) return `modules/${parts[1]}`;
  if (parts.length > 1) return parts[0] as string;
  return `root:${(parts[0] as string).replace(/\.ts$/, '')}`;
}

const resolveUnit = (imp: Import): string | null => {
  if (!imp.spec.startsWith('.')) return null;
  const target = path.normalize(path.join(path.dirname(imp.from), imp.spec));
  return unitOf(target);
};

describe('architecture', () => {
  const imports = ALL.flatMap(importsOf);

  it('every module is declared in the dependency table (new modules must be placed deliberately)', () => {
    const modules = new Set(ALL.map(unitOf).filter((u) => u.startsWith('modules/')));
    expect([...modules].sort()).toEqual(
      Object.keys(ALLOWED)
        .filter((k) => k.startsWith('modules/'))
        .sort(),
    );
  });

  it('modules and flows depend only on the modules they are allowed to', () => {
    const violations: string[] = [];
    for (const imp of imports) {
      const from = unitOf(imp.from);
      const to = resolveUnit(imp);
      if (!to || to === from || !(from in ALLOWED)) continue;
      if (to === 'platform' || to === 'root:config') continue;
      if (to.startsWith('modules/') || to === 'flows') {
        if (!(ALLOWED[from] ?? []).includes(to)) violations.push(`${imp.from} -> ${to}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('only routes files may touch the composition root, and only for its TYPE', () => {
    const violations: string[] = [];
    for (const imp of imports) {
      const from = unitOf(imp.from);
      const to = resolveUnit(imp);
      if (!(from.startsWith('modules/') || from === 'platform' || from === 'flows')) continue;
      if (to === null) continue;
      const touchesRoot = [
        'root:services',
        'root:routes',
        'root:app',
        'root:jobs',
        'root:server',
        'root:worker',
      ].includes(to);
      if (!touchesRoot) continue;
      const isRoutesFile = imp.from.endsWith(`${path.sep}routes.ts`);
      if (!(isRoutesFile && to === 'root:services' && imp.typeOnly)) {
        violations.push(`${imp.from} -> ${to}${imp.typeOnly ? ' (type)' : ''}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('platform knows nothing about modules, flows or the app', () => {
    const violations = imports
      .filter((i) => unitOf(i.from) === 'platform')
      .map((i) => ({ i, to: resolveUnit(i) }))
      .filter(({ to }) => to !== null && to !== 'platform' && to !== 'root:config')
      .map(({ i, to }) => `${i.from} -> ${to}`);
    expect(violations).toEqual([]);
  });

  it('production code never imports tests or scripts', () => {
    const bad = imports.filter(
      (i) => /(^|\/)(test|scripts)\//.test(i.spec) || i.spec.startsWith('vitest'),
    );
    expect(bad.map((i) => `${i.from} -> ${i.spec}`)).toEqual([]);
  });

  it('the module graph has no cycles', () => {
    const graph = new Map<string, Set<string>>();
    for (const imp of imports) {
      const from = unitOf(imp.from);
      const to = resolveUnit(imp);
      if (!to || to === from) continue;
      if (!(from.startsWith('modules/') || from === 'flows')) continue;
      if (!(to.startsWith('modules/') || to === 'flows')) continue;
      graph.set(from, (graph.get(from) ?? new Set()).add(to));
    }
    const state = new Map<string, 'visiting' | 'done'>();
    const cycles: string[] = [];
    const visit = (node: string, trail: string[]) => {
      if (state.get(node) === 'done') return;
      if (state.get(node) === 'visiting') {
        cycles.push([...trail.slice(trail.indexOf(node)), node].join(' -> '));
        return;
      }
      state.set(node, 'visiting');
      for (const next of graph.get(node) ?? []) visit(next, [...trail, node]);
      state.set(node, 'done');
    };
    for (const node of graph.keys()) visit(node, []);
    expect(cycles).toEqual([]);
  });

  it('third-party adapters stay inside their home directories', () => {
    const violations: string[] = [];
    for (const imp of imports) {
      if (imp.spec.startsWith('.')) continue;
      const pkg = imp.spec.startsWith('@')
        ? imp.spec.split('/').slice(0, 2).join('/')
        : imp.spec.split('/')[0];
      const homes = PACKAGE_HOMES[imp.spec] ?? PACKAGE_HOMES[pkg as string];
      if (!homes) continue;
      const from = unitOf(imp.from);
      if (!homes.some((h) => from === h))
        violations.push(`${imp.from} imports ${imp.spec} (allowed in: ${homes.join(', ')})`);
    }
    expect(violations).toEqual([]);
  });

  it('SQL stays out of route handlers (routes call services)', () => {
    const offenders = ALL.filter((f) => f.endsWith(`${path.sep}routes.ts`)).filter((f) =>
      /\.(selectFrom|insertInto|updateTable|deleteFrom)\(/.test(
        readFileSync(path.join(SRC, f), 'utf8'),
      ),
    );
    expect(offenders).toEqual([]);
  });
});
