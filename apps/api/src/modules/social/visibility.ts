import { sql, type RawBuilder } from 'kysely';

/**
 * Visibility predicates — THE single source of truth for "can viewer V see X".
 *
 * Every query that returns another user's content (feeds, profile grids, comments, search,
 * notifications...) must AND one of these into its WHERE clause, so privacy and blocking are
 * enforced in the database rather than remembered per endpoint. Single-resource lookups use the
 * same predicates and answer 404 (never 403) when the predicate fails, so existence is not leaked.
 *
 * `viewerId === null` means an anonymous viewer: only PUBLIC content of PUBLIC accounts passes.
 * Column refs are SQL identifiers such as 'p.author_id' (always internal constants, never input).
 */
export type ColumnRef = string;

const ref = (r: ColumnRef) => sql.ref(r);

/** TRUE when a block exists between viewer and the user in either direction. */
export function blockedBetween(viewerId: string | null, userRef: ColumnRef): RawBuilder<boolean> {
  if (viewerId === null) return sql<boolean>`false`;
  return sql<boolean>`exists (
    select 1 from blocks _b
     where (_b.blocker_id = ${viewerId} and _b.blocked_id = ${ref(userRef)})
        or (_b.blocker_id = ${ref(userRef)} and _b.blocked_id = ${viewerId})
  )`;
}

/** TRUE when the viewer follows the user (accepted follows only; pending requests do not count). */
export function viewerFollows(viewerId: string | null, userRef: ColumnRef): RawBuilder<boolean> {
  if (viewerId === null) return sql<boolean>`false`;
  return sql<boolean>`exists (
    select 1 from follows _f where _f.follower_id = ${viewerId} and _f.followee_id = ${ref(userRef)}
  )`;
}

export interface AuthorRefs {
  /** The content author's user id column. */
  authorId: ColumnRef;
  /** The author's users.status column (join `users`). */
  authorStatus: ColumnRef;
  /** The author's profiles.account_visibility column (join `profiles`). */
  authorAccountVisibility: ColumnRef;
}

/**
 * Whether the viewer may see an account at all (profile header, appearing in lists):
 * the account must be ACTIVE and no block may exist in either direction. Self always passes.
 */
export function accountVisibleTo(
  viewerId: string | null,
  refs: Pick<AuthorRefs, 'authorId' | 'authorStatus'>,
): RawBuilder<boolean> {
  if (viewerId === null) return sql<boolean>`${ref(refs.authorStatus)} = 'ACTIVE'`;
  return sql<boolean>`(
    ${ref(refs.authorId)} = ${viewerId}
    or (${ref(refs.authorStatus)} = 'ACTIVE' and not ${blockedBetween(viewerId, refs.authorId)})
  )`;
}

/**
 * Whether the viewer may see a piece of content with the given `visibility` column.
 * Effective audience = min(content visibility, account privacy):
 *   - PUBLIC content of a PRIVATE account is still followers-only.
 *   - FOLLOWERS content requires an accepted follow.
 *   - PRIVATE content is author-only.
 *   - The author always sees their own content; blocked pairs and non-ACTIVE authors never do.
 */
export function contentVisibleTo(
  viewerId: string | null,
  refs: AuthorRefs & { visibility: ColumnRef },
): RawBuilder<boolean> {
  const publicToAnon = sql<boolean>`(${ref(refs.visibility)} = 'PUBLIC' and ${ref(refs.authorAccountVisibility)} = 'PUBLIC')`;
  if (viewerId === null) {
    return sql<boolean>`(${ref(refs.authorStatus)} = 'ACTIVE' and ${publicToAnon})`;
  }
  const follows = viewerFollows(viewerId, refs.authorId);
  return sql<boolean>`(
    ${ref(refs.authorId)} = ${viewerId}
    or (
      ${ref(refs.authorStatus)} = 'ACTIVE'
      and not ${blockedBetween(viewerId, refs.authorId)}
      and (
        (${ref(refs.visibility)} = 'PUBLIC' and (${ref(refs.authorAccountVisibility)} = 'PUBLIC' or ${follows}))
        or (${ref(refs.visibility)} = 'FOLLOWERS' and ${follows})
      )
    )
  )`;
}
