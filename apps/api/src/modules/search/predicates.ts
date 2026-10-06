import { sql, type RawBuilder } from 'kysely';
import { postListableBy } from '../posts/visibility';
import { accountVisibleTo, viewerFollows } from '../social/visibility';

/**
 * What search and recommendations may surface, on top of normal visibility:
 *  - accounts that opted out (`discoverable = false`) are reachable only by their followers and themself;
 *  - accounts younger than MINOR_PUBLIC_MIN_AGE are never surfaced by search or suggestions
 *    (they are still reachable by exact profile link and by their followers).
 */

/** Callers join `profiles as p` and `users as u`. */
export function searchableUser(
  viewerId: string | null,
  minorCutoffDate: string,
): RawBuilder<boolean> {
  const opted =
    viewerId === null
      ? sql<boolean>`p.discoverable`
      : sql<boolean>`(p.discoverable or p.user_id = ${viewerId} or ${viewerFollows(viewerId, 'p.user_id')})`;
  return sql<boolean>`(
    u.status = 'ACTIVE'
    and u.birth_date <= ${minorCutoffDate}::date
    and ${accountVisibleTo(viewerId, { authorId: 'p.user_id', authorStatus: 'u.status' })}
    and ${opted}
  )`;
}

/** Callers join `posts as p`, `users as au`, `profiles as ap`. */
export function searchablePost(viewerId: string | null): RawBuilder<boolean> {
  const opted =
    viewerId === null
      ? sql<boolean>`ap.discoverable`
      : sql<boolean>`(ap.discoverable or p.author_id = ${viewerId} or ${viewerFollows(viewerId, 'p.author_id')})`;
  return sql<boolean>`(${postListableBy(viewerId)} and ${opted})`;
}

/** The date on or before which someone must have been born to be surfaced (UTC, YYYY-MM-DD). */
export function minorCutoffDate(now: Date, minAge: number): string {
  return new Date(Date.UTC(now.getUTCFullYear() - minAge, now.getUTCMonth(), now.getUTCDate()))
    .toISOString()
    .slice(0, 10);
}

/**
 * Public, discoverable posts using a topic, capped at 1000 (so a hot topic stays cheap to count).
 * `topicIdRef` is a column reference such as 't.id'.
 */
export function publicTopicPostCount(topicIdRef: string): RawBuilder<number> {
  return sql<number>`(
    select count(*)::int from (
      select 1
        from post_topics _pt
        join posts p on p.id = _pt.post_id
        join users au on au.id = p.author_id
        join profiles ap on ap.user_id = p.author_id
       where _pt.topic_id = ${sql.ref(topicIdRef)}
         and ${postListableBy(null)}
         and ap.discoverable
       limit 1000
    ) _c
  )`;
}

/** Escapes LIKE wildcards in user input. */
export function likeEscape(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Turns free text into a safe tsquery: alphanumeric tokens joined with AND, the last one a
 * prefix match. Returns null when nothing searchable is left. (Tokens are restricted to
 * letters/digits/underscore, so no tsquery operator can be injected.)
 */
export function toPrefixTsQuery(text: string): string | null {
  const tokens = (text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).slice(0, 8);
  if (tokens.length === 0) return null;
  return tokens.map((t, i) => (i === tokens.length - 1 ? `${t}:*` : t)).join(' & ');
}

/** Strips a leading "#"/"@" and collapses whitespace. */
export function normalizeSearchText(raw: string): string {
  return raw
    .trim()
    .replace(/^[#@]+/, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}
