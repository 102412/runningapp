export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * Iterates every item of a cursor-paginated endpoint:
 *
 *   for await (const post of paginate((cursor) => unwrap(await client.GET('/v1/me/bookmarks', { params: { query: { cursor } } })))) ...
 *
 * `maxPages` is a safety valve so a bug can never loop forever.
 */
export async function* paginate<T>(
  fetchPage: (cursor: string | undefined) => Promise<Page<T>>,
  options: { maxPages?: number } = {},
): AsyncGenerator<T> {
  const maxPages = options.maxPages ?? 1000;
  let cursor: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const page = await fetchPage(cursor);
    yield* page.items;
    if (!page.nextCursor) return;
    cursor = page.nextCursor;
  }
}

/** Collects up to `limit` items (default 500) into an array. */
export async function collect<T>(source: AsyncIterable<T>, limit = 500): Promise<T[]> {
  const out: T[] = [];
  for await (const item of source) {
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}
