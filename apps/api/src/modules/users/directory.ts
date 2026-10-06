import type { Avatar, UserSummary } from '@runningapp/contracts';
import type { Db } from '../../platform/db/client';

/** Resolves avatar media ids to signed URLs. Supplied by the media module at composition time. */
export type AvatarResolver = (mediaIds: string[]) => Promise<Map<string, Avatar>>;

const noAvatars: AvatarResolver = async () => new Map();

/**
 * Batch-loads the compact UserSummary shape used throughout the API. One query per call
 * regardless of how many ids are requested (no N+1 in feeds/comments/notifications).
 */
export class UserDirectory {
  private avatarResolver: AvatarResolver = noAvatars;

  constructor(private readonly db: Db) {}

  setAvatarResolver(resolver: AvatarResolver): void {
    this.avatarResolver = resolver;
  }

  async summaries(ids: readonly string[], db: Db = this.db): Promise<Map<string, UserSummary>> {
    const unique = [...new Set(ids)];
    const out = new Map<string, UserSummary>();
    if (unique.length === 0) return out;

    const rows = await db
      .selectFrom('profiles as p')
      .innerJoin('users as u', 'u.id', 'p.userId')
      .select(['p.userId', 'p.username', 'p.displayName', 'p.accountVisibility', 'p.avatarMediaId'])
      .where('p.userId', 'in', unique)
      .execute();

    const avatarIds = rows.flatMap((r) => (r.avatarMediaId ? [r.avatarMediaId] : []));
    const avatars =
      avatarIds.length > 0 ? await this.avatarResolver(avatarIds) : new Map<string, Avatar>();

    for (const r of rows) {
      out.set(r.userId, {
        id: r.userId,
        username: r.username,
        displayName: r.displayName,
        avatar: r.avatarMediaId ? (avatars.get(r.avatarMediaId) ?? null) : null,
        isPrivate: r.accountVisibility === 'PRIVATE',
        creator: null,
      });
    }
    return out;
  }
}
