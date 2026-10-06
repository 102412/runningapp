/**
 * Post-processing for the generated OpenAPI document.
 *
 * `fastify-type-provider-zod` emits an *input* and an *output* variant of every registered
 * schema (suffixing input ids with "Input") and dumps the whole registry into `components`.
 * That is correct but noisy. This pass produces the tidy contract clients see:
 *   1. keep only components reachable from `paths`,
 *   2. merge `X` and `XInput` when they are structurally identical (fixed point, so a difference
 *      in a nested schema correctly keeps its parents apart),
 *   3. drop the `Input` suffix when there is no conflicting `X`.
 * Truly different input/output shapes (e.g. a default makes a field optional on input but
 * required on output) keep both names.
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const REF_PREFIX = '#/components/schemas/';
const REF_PATTERN = /"#\/components\/schemas\/([^"]+)"/g;

function isObject(v: Json | undefined): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function collectRefs(node: Json, into: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, into);
  } else if (isObject(node)) {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string' && value.startsWith(REF_PREFIX)) {
        into.add(value.slice(REF_PREFIX.length));
      } else {
        collectRefs(value, into);
      }
    }
  }
}

function rewriteRefs(node: Json, rename: (name: string) => string): Json {
  if (Array.isArray(node)) return node.map((n) => rewriteRefs(n, rename));
  if (isObject(node)) {
    const out: JsonObject = {};
    for (const [key, value] of Object.entries(node)) {
      out[key] =
        key === '$ref' && typeof value === 'string' && value.startsWith(REF_PREFIX)
          ? `${REF_PREFIX}${rename(value.slice(REF_PREFIX.length))}`
          : rewriteRefs(value, rename);
    }
    return out;
  }
  return node;
}

/** Stable JSON (sorted keys) so structural comparison ignores key order. */
function canonical(node: Json): string {
  if (Array.isArray(node)) return `[${node.map(canonical).join(',')}]`;
  if (isObject(node)) {
    return `{${Object.keys(node)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(node[k] as Json)}`)
      .join(',')}}`;
  }
  return JSON.stringify(node);
}

export function tidyOpenApi<T extends object>(spec: T): T {
  const doc = JSON.parse(JSON.stringify(spec)) as JsonObject;
  const components = doc.components;
  if (!isObject(components) || !isObject(components.schemas)) return spec;
  let schemas = components.schemas;

  // ---- 1. reachability from paths -----------------------------------------------------------
  const reachable = new Set<string>();
  const queue: string[] = [];
  const seed = new Set<string>();
  collectRefs(doc.paths ?? null, seed);
  for (const name of seed) queue.push(name);
  while (queue.length > 0) {
    const name = queue.pop();
    if (name === undefined || reachable.has(name)) continue;
    reachable.add(name);
    const schema = schemas[name];
    if (schema === undefined) continue;
    const refs = new Set<string>();
    collectRefs(schema, refs);
    for (const r of refs) if (!reachable.has(r)) queue.push(r);
  }
  schemas = Object.fromEntries(Object.entries(schemas).filter(([name]) => reachable.has(name)));

  // ---- 2. merge identical X / XInput pairs (fixed point) ------------------------------------
  const pairs = Object.keys(schemas).filter(
    (n) => n.endsWith('Input') && n.length > 5 && schemas[n.slice(0, -5)] !== undefined,
  );
  const mergeable = new Set(pairs);
  const baseOf = (n: string): string => n.slice(0, -5);
  let changed = true;
  while (changed) {
    changed = false;
    const alias = (n: string): string => (mergeable.has(n) ? baseOf(n) : n);
    for (const input of [...mergeable]) {
      const a = canonical(rewriteRefs(schemas[input] as Json, alias));
      const b = canonical(rewriteRefs(schemas[baseOf(input)] as Json, alias));
      if (a !== b) {
        mergeable.delete(input);
        changed = true;
      }
    }
  }

  // ---- 3. final names: merged pairs collapse; lone `XInput` loses its suffix ----------------
  const finalName = (n: string): string => {
    if (mergeable.has(n)) return baseOf(n);
    if (n.endsWith('Input') && n.length > 5 && schemas[baseOf(n)] === undefined) return baseOf(n);
    return n;
  };

  const tidied: JsonObject = {};
  for (const name of Object.keys(schemas).sort()) {
    if (mergeable.has(name)) continue; // represented by its base
    tidied[finalName(name)] = rewriteRefs(schemas[name] as Json, finalName);
  }

  doc.paths = rewriteRefs(doc.paths ?? null, finalName);
  doc.components = { ...components, schemas: tidied };
  // Re-run the pattern check so a stray reference to a dropped component fails loudly in tests.
  const dangling = [...JSON.stringify(doc).matchAll(REF_PATTERN)]
    .map((m) => m[1])
    .filter((n): n is string => n !== undefined && tidied[n] === undefined);
  if (dangling.length > 0)
    throw new Error(`OpenAPI tidy left dangling refs: ${[...new Set(dangling)].join(', ')}`);

  return doc as unknown as T;
}
