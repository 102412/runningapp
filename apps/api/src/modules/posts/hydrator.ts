import type { Activity, MediaView, Post } from '@runningapp/contracts';
import type { Db } from '../../platform/db/client';
import type { ActivityService } from '../activities/service';
import type { MediaService } from '../media/service';
import { loadRelations } from '../social/relations';
import { accountVisibleTo } from '../social/visibility';
import type { UserDirectory } from '../users/directory';
import { sponsorshipLabel } from './text';

/** The `posts` columns the hydrator needs. */
export interface PostRow {
  id: string;
  authorId: string;
  origin: Post['origin'];
  status: Post['status'];
  format: Post['format'];
  caption: string;
  visibility: Post['visibility'];
  commentPermission: Post['commentPermission'];
  activityId: string | null;
  moderationStatus: 'CLEAN' | 'HIDDEN' | 'REMOVED';
  reactionCount: number;
  commentCount: number;
  bookmarkCount: number;
  shareCount: number;
  publishedAt: Date | null;
  createdAt: Date;
}

export const POST_COLUMNS = [
  'p.id',
  'p.authorId',
  'p.origin',
  'p.status',
  'p.format',
  'p.caption',
  'p.visibility',
  'p.commentPermission',
  'p.activityId',
  'p.moderationStatus',
  'p.reactionCount',
  'p.commentCount',
  'p.bookmarkCount',
  'p.shareCount',
  'p.publishedAt',
  'p.createdAt',
] as const;

/**
 * Turns post rows into API Post objects in a CONSTANT number of queries (about ten), whether the
 * page has 1 post or 50. Callers must already have authorised the rows for `viewerId`
 * (via postReadableBy / postListableBy); the hydrator then applies per-part rules:
 * non-authors never receive non-READY media, mentions of since-blocked users are dropped, and the
 * attached activity's route is privacy-filtered for this viewer.
 */
export class PostHydrator {
  constructor(
    private readonly db: Db,
    private readonly directory: UserDirectory,
    private readonly activities: ActivityService,
    private readonly media: MediaService,
  ) {}

  async hydrate(viewerId: string | null, rows: readonly PostRow[]): Promise<Post[]> {
    if (rows.length === 0) return [];
    const postIds = rows.map((r) => r.id);
    const authorIds = [...new Set(rows.map((r) => r.authorId))];
    const activityIds = rows.flatMap((r) => (r.activityId ? [r.activityId] : []));

    const [
      authors,
      activities,
      mediaLinks,
      topicRows,
      mentionRows,
      sponsorRows,
      reactionRows,
      bookmarkRows,
      relations,
    ] = await Promise.all([
      this.directory.summaries(authorIds),
      this.activities.hydrateByIds(viewerId, activityIds),
      this.db
        .selectFrom('postMedia')
        .select(['postId', 'mediaId', 'position'])
        .where('postId', 'in', postIds)
        .orderBy('position')
        .execute(),
      this.db
        .selectFrom('postTopics as pt')
        .innerJoin('topics as t', 't.id', 'pt.topicId')
        .select(['pt.postId', 't.slug'])
        .where('pt.postId', 'in', postIds)
        .orderBy('t.slug')
        .execute(),
      this.db
        .selectFrom('postMentions as pm')
        .innerJoin('profiles as mp', 'mp.userId', 'pm.userId')
        .innerJoin('users as mu', 'mu.id', 'pm.userId')
        .select(['pm.postId', 'pm.userId', 'mp.username'])
        .where('pm.postId', 'in', postIds)
        .where(accountVisibleTo(viewerId, { authorId: 'pm.user_id', authorStatus: 'mu.status' }))
        .orderBy('mp.username')
        .execute(),
      this.db
        .selectFrom('sponsorshipDisclosures')
        .selectAll()
        .where('postId', 'in', postIds)
        .execute(),
      viewerId
        ? this.db
            .selectFrom('postReactions')
            .select(['postId', 'reaction'])
            .where('userId', '=', viewerId)
            .where('postId', 'in', postIds)
            .execute()
        : Promise.resolve([]),
      viewerId
        ? this.db
            .selectFrom('bookmarks')
            .select('postId')
            .where('userId', '=', viewerId)
            .where('postId', 'in', postIds)
            .execute()
        : Promise.resolve([]),
      loadRelations(this.db, viewerId, authorIds),
    ]);

    const mediaViews = await this.media.viewsByIds(mediaLinks.map((m) => m.mediaId));

    const topicsByPost = group(
      topicRows,
      (r) => r.postId,
      (r) => r.slug,
    );
    const mentionsByPost = group(
      mentionRows,
      (r) => r.postId,
      (r) => ({ id: r.userId, username: r.username }),
    );
    const sponsorByPost = new Map(sponsorRows.map((s) => [s.postId, s]));
    const reactionByPost = new Map(reactionRows.map((r) => [r.postId, r.reaction]));
    const bookmarked = new Set(bookmarkRows.map((b) => b.postId));
    const mediaByPost = group(
      mediaLinks,
      (m) => m.postId,
      (m) => mediaViews.get(m.mediaId),
    );

    const out: Post[] = [];
    for (const r of rows) {
      const author = authors.get(r.authorId);
      if (!author) continue; // author vanished mid-request
      const isAuthor = viewerId === r.authorId;
      const media = (mediaByPost.get(r.id) ?? []).filter(
        (m): m is MediaView => m !== undefined && (isAuthor || m.status === 'READY'),
      );
      const activity: Activity | null = r.activityId
        ? (activities.get(r.activityId) ?? null)
        : null;
      const sponsor = sponsorByPost.get(r.id);
      const relation = relations.get(r.authorId);

      out.push({
        id: r.id,
        author,
        origin: r.origin,
        status: r.status,
        format: r.format,
        caption: r.caption,
        visibility: r.visibility,
        commentPermission: r.commentPermission,
        topics: topicsByPost.get(r.id) ?? [],
        mentions: mentionsByPost.get(r.id) ?? [],
        media,
        activity,
        sponsorship: sponsor
          ? {
              type: sponsor.type,
              brandName: sponsor.brandName,
              label: sponsorshipLabel(sponsor.type, sponsor.brandName),
              partnershipId: sponsor.partnershipId,
            }
          : null,
        counts: {
          reactions: r.reactionCount,
          comments: r.commentCount,
          shares: r.shareCount,
          bookmarks: isAuthor ? r.bookmarkCount : null,
        },
        viewer:
          viewerId === null
            ? null
            : {
                reaction: reactionByPost.get(r.id) ?? null,
                bookmarked: bookmarked.has(r.id),
                isAuthor,
                canComment: canComment(r, viewerId, relation?.relationship === 'FOLLOWING'),
              },
        moderationStatus: isAuthor ? r.moderationStatus : null,
        publishedAt: r.publishedAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
      });
    }
    return out;
  }
}

/**
 * The single comment-permission rule, shared with the engagement module. NOBODY disables
 * comments for everyone (including the author); FOLLOWERS admits the author and their followers.
 */
export function canComment(
  post: Pick<PostRow, 'authorId' | 'commentPermission' | 'status' | 'moderationStatus'>,
  viewerId: string | null,
  followsAuthor: boolean,
): boolean {
  if (viewerId === null || post.status !== 'PUBLISHED' || post.moderationStatus !== 'CLEAN')
    return false;
  switch (post.commentPermission) {
    case 'EVERYONE':
      return true;
    case 'FOLLOWERS':
      return followsAuthor || viewerId === post.authorId;
    case 'NOBODY':
      return false;
  }
}

function group<T, V>(
  rows: readonly T[],
  key: (r: T) => string,
  value: (r: T) => V,
): Map<string, V[]> {
  const out = new Map<string, V[]>();
  for (const r of rows) {
    const k = key(r);
    const list = out.get(k) ?? [];
    list.push(value(r));
    out.set(k, list);
  }
  return out;
}
