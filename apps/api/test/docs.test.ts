import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PEOPLE } from '../scripts/seed/world';

/**
 * Documentation is part of the contract with the people building the UI, so it is checked like
 * code: every relative link must resolve (including #anchors), the commands the docs tell people
 * to run must exist, and every seeded demo account must be documented in HANDOFF.md.
 */
const ROOT = path.resolve(__dirname, '../../..');
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');

const DOCS = [
  'README.md',
  'HANDOFF.md',
  ...readdirSync(path.join(ROOT, 'docs'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => `docs/${f}`),
];

/** GitHub's heading -> anchor rule (lower-case, drop punctuation, spaces to hyphens). */
const slug = (heading: string) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');

/** Lines outside fenced code blocks. */
function proseLines(markdown: string): string[] {
  let fenced = false;
  return markdown.split('\n').filter((line) => {
    if (line.startsWith('```')) {
      fenced = !fenced;
      return false;
    }
    return !fenced;
  });
}

const anchorCache = new Map<string, Set<string>>();
function anchorsOf(absolute: string): Set<string> {
  const cached = anchorCache.get(absolute);
  if (cached) return cached;
  const anchors = new Set<string>();
  for (const line of proseLines(readFileSync(absolute, 'utf8'))) {
    const match = /^#{1,6}\s+(.*)$/.exec(line);
    if (!match?.[1]) continue;
    const base = slug(match[1].replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'));
    let candidate = base;
    for (let n = 1; anchors.has(candidate); n++) candidate = `${base}-${n}`;
    anchors.add(candidate);
  }
  anchorCache.set(absolute, anchors);
  return anchors;
}

describe('documentation', () => {
  it('has every document the hand-off promises', () => {
    for (const file of [
      'README.md',
      'HANDOFF.md',
      'docs/ARCHITECTURE.md',
      'docs/API.md',
      'docs/DATABASE.md',
      'docs/SECURITY.md',
      'docs/MEDIA_PIPELINE.md',
      'docs/FEED.md',
      'docs/FRONTEND_INTEGRATION.md',
      'docs/LOCAL_DEVELOPMENT.md',
      'docs/DECISIONS.md',
    ]) {
      expect(existsSync(path.join(ROOT, file)), file).toBe(true);
    }
  });

  it('has no broken relative links or anchors', () => {
    const broken: string[] = [];
    for (const file of DOCS) {
      const absolute = path.join(ROOT, file);
      proseLines(read(file)).forEach((line, index) => {
        for (const match of line.matchAll(/\]\(([^)\s]+)\)/g)) {
          const link = match[1] ?? '';
          if (/^(https?:|mailto:)/.test(link)) continue;
          const [target, hash] = link.split('#');
          const resolved = target ? path.resolve(path.dirname(absolute), target) : absolute;
          if (!existsSync(resolved)) {
            broken.push(`${file}: missing file ${link}`);
          } else if (hash && resolved.endsWith('.md') && !anchorsOf(resolved).has(hash)) {
            broken.push(`${file}: missing anchor ${link} (near line ${index + 1})`);
          }
        }
      });
    }
    expect(broken).toEqual([]);
  });

  it('only mentions pnpm scripts that exist', () => {
    const rootScripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> })
      .scripts;
    const missing = new Set<string>();
    for (const file of DOCS) {
      for (const match of read(file).matchAll(/(?:^|`)pnpm ([a-z][a-z:-]*)/gm)) {
        const script = match[1] ?? '';
        const builtIn = ['install', 'test', 'exec', 'pack', 'audit', 'deploy', 'add', 'dlx'];
        if (!(script in rootScripts) && !builtIn.includes(script))
          missing.add(`${file}: ${script}`);
      }
    }
    expect([...missing]).toEqual([]);
  });

  it('documents every seeded demo account in HANDOFF.md', () => {
    const handoff = read('HANDOFF.md');
    const section = handoff.slice(handoff.indexOf('## Seed accounts'));
    const undocumented = PEOPLE.filter((p) => !section.includes(`\`${p.username}\``)).map(
      (p) => p.username,
    );
    expect(undocumented).toEqual([]);
  });

  it('keeps the generated API reference in step with the OpenAPI document', () => {
    const openapi = JSON.parse(read('docs/openapi.json')) as {
      paths: Record<string, Record<string, { operationId?: string }>>;
    };
    const reference = read('docs/API_REFERENCE.md');
    const missing: string[] = [];
    for (const methods of Object.values(openapi.paths)) {
      for (const operation of Object.values(methods)) {
        if (operation.operationId && !reference.includes(`\`${operation.operationId}\``)) {
          missing.push(operation.operationId);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
