import { sql, type RawBuilder } from 'kysely';
import { contentVisibleTo } from '../social/visibility';

/**
 * Post visibility predicates. Callers must join `posts as p`, `users as au` (the author) and
 * `profiles as ap` (the author's profile) — see the helpers in service.ts.
 */

/** Everything a viewer may OPEN: their own posts in any state, others' only when published, clean and in audience. */
export function postReadableBy(viewerId: string | null): RawBuilder<boolean> {
  const audience = contentVisibleTo(viewerId, {
    authorId: 'p.author_id',
    authorStatus: 'au.status',
    authorAccountVisibility: 'ap.account_visibility',
    visibility: 'p.visibility',
  });
  const published = sql<boolean>`(p.status = 'PUBLISHED' and p.moderation_status = 'CLEAN' and ${audience})`;
  if (viewerId === null) return sql<boolean>`(p.deleted_at is null and ${published})`;
  return sql<boolean>`(p.deleted_at is null and (p.author_id = ${viewerId} or ${published}))`;
}

/** What may appear in feeds, grids, search and recommendations: published + clean + in the viewer's audience. */
export function postListableBy(viewerId: string | null): RawBuilder<boolean> {
  const audience = contentVisibleTo(viewerId, {
    authorId: 'p.author_id',
    authorStatus: 'au.status',
    authorAccountVisibility: 'ap.account_visibility',
    visibility: 'p.visibility',
  });
  return sql<boolean>`(p.deleted_at is null and p.status = 'PUBLISHED' and p.moderation_status = 'CLEAN' and ${audience})`;
}
