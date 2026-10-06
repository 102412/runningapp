import { ERROR_CATALOG } from '@runningapp/contracts';

interface Operation {
  operationId?: string;
  summary?: string;
  tags?: string[];
  security?: Array<Record<string, unknown>>;
  responses?: Record<string, unknown>;
  parameters?: Array<{ in: string; name: string; required?: boolean }>;
}
interface Spec {
  info?: { title?: string; version?: string };
  tags?: Array<{ name: string }>;
  paths: Record<string, Record<string, Operation>>;
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

function auth(op: Operation, tag: string): string {
  if (!op.security || op.security.length === 0) return 'public';
  if (op.security.some((s) => Object.keys(s).length === 0)) return 'optional';
  return tag === 'Admin' ? 'staff' : 'bearer';
}

/** Renders docs/API_REFERENCE.md from the OpenAPI document. Deterministic: CI diffs it. */
export function renderApiReference(spec: Spec): string {
  const lines: string[] = [
    '# API reference',
    '',
    '> **Generated** from `docs/openapi.json` by `pnpm openapi`. Do not edit by hand.',
    '> The machine-readable contract is [`docs/openapi.json`](./openapi.json); conventions (auth,',
    '> errors, pagination, idempotency) are in [`API.md`](./API.md).',
    '',
    `Version **${spec.info?.version ?? '?'}**. Every path is under \`/v1\`. **Auth** column:`,
    '`public` = no token, `optional` = works anonymously (a presented token must still be valid),',
    '`bearer` = signed-in user, `staff` = moderator/admin only.',
    '',
  ];

  const byTag = new Map<string, Array<{ method: string; path: string; op: Operation }>>();
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;
      const tag = op.tags?.[0] ?? 'Other';
      byTag.set(tag, [...(byTag.get(tag) ?? []), { method, path, op }]);
    }
  }
  const order = [...(spec.tags?.map((t) => t.name) ?? []), ...byTag.keys()];
  const tags = [...new Set(order)].filter((t) => byTag.has(t));

  for (const tag of tags) {
    const ops = byTag.get(tag) ?? [];
    lines.push(
      `## ${tag}`,
      '',
      '| Method | Path | Operation | Auth | What it does | Errors |',
      '|---|---|---|---|---|---|',
    );
    for (const { method, path, op } of ops) {
      const errors = Object.keys(op.responses ?? {})
        .filter((c) => /^[45]/.test(c))
        .sort()
        .join(' ');
      lines.push(
        `| ${method.toUpperCase()} | \`${path}\` | \`${op.operationId ?? ''}\` | ${auth(op, tag)} | ${(op.summary ?? '').replaceAll('|', '\\|')} | ${errors} |`,
      );
    }
    lines.push('');
  }

  lines.push(
    '## Error codes',
    '',
    'Every error is `{ "error": { "code", "message", "requestId", "details?" } }`. Branch on `code`, never on `message`.',
    '',
    '| HTTP | Code | Default message |',
    '|---|---|---|',
  );
  const catalog = Object.entries(ERROR_CATALOG) as Array<
    [string, { status: number; message: string }]
  >;
  for (const [code, { status, message }] of catalog.sort(
    (a, b) => a[1].status - b[1].status || a[0].localeCompare(b[0]),
  )) {
    lines.push(`| ${status} | \`${code}\` | ${message} |`);
  }
  lines.push('');
  return lines.join('\n');
}
