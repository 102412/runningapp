import type { RelationshipStatus } from '@runningapp/contracts';
import type { Db } from '../../platform/db/client';

export interface ViewerRelation {
  isSelf: boolean;
  relationship: RelationshipStatus;
  followsYou: boolean;
  hasPendingRequestFromThem: boolean;
}

const NO_RELATION: ViewerRelation = {
  isSelf: false,
  relationship: 'NONE',
  followsYou: false,
  hasPendingRequestFromThem: false,
};

/** Batch-loads viewer<->user relationships for a set of users in three queries total. */
export async function loadRelations(
  db: Db,
  viewerId: string | null,
  userIds: readonly string[],
): Promise<Map<string, ViewerRelation>> {
  const ids = [...new Set(userIds)];
  const out = new Map<string, ViewerRelation>();
  for (const id of ids) out.set(id, { ...NO_RELATION, isSelf: id === viewerId });
  if (viewerId === null || ids.length === 0) return out;

  const [following, followers, requests] = await Promise.all([
    db
      .selectFrom('follows')
      .select('followeeId')
      .where('followerId', '=', viewerId)
      .where('followeeId', 'in', ids)
      .execute(),
    db
      .selectFrom('follows')
      .select('followerId')
      .where('followeeId', '=', viewerId)
      .where('followerId', 'in', ids)
      .execute(),
    db
      .selectFrom('followRequests')
      .select(['requesterId', 'targetId'])
      .where((eb) =>
        eb.or([
          eb.and([eb('requesterId', '=', viewerId), eb('targetId', 'in', ids)]),
          eb.and([eb('targetId', '=', viewerId), eb('requesterId', 'in', ids)]),
        ]),
      )
      .execute(),
  ]);

  for (const r of requests) {
    if (r.requesterId === viewerId) {
      const rel = out.get(r.targetId);
      if (rel) rel.relationship = 'REQUESTED';
    } else {
      const rel = out.get(r.requesterId);
      if (rel) rel.hasPendingRequestFromThem = true;
    }
  }
  for (const r of following) {
    const rel = out.get(r.followeeId);
    if (rel) rel.relationship = 'FOLLOWING';
  }
  for (const r of followers) {
    const rel = out.get(r.followerId);
    if (rel) rel.followsYou = true;
  }
  return out;
}
