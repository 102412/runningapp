import { z } from 'zod';
import {
  MAX_MEDIA_PER_POST,
  type ContentVisibility,
  type CreatePostRequest,
  type Post,
  type PostFormat,
  type PostStatus,
  type SponsorshipInput,
  type UpdatePostRequest,
} from '@runningapp/contracts';
import type { Clock } from '../../platform/clock';
import type { Db } from '../../platform/db/client';
import { isUniqueViolation } from '../../platform/db/errors';
import { keysetBefore, timestampText } from '../../platform/db/keyset';
import { AppError } from '../../platform/errors';
import { decodeCursor, encodeCursor, sliceProbe } from '../../platform/http/cursor';
import type {
  ContentModerator,
  ModerationFlagSink,
  ModerationVerdict,
} from '../../platform/ports/content-moderation';
import type { ActivityService } from '../activities/service';
import type { MediaService } from '../media/service';
import type { Notifier } from '../notifier';
import { accountVisibleTo } from '../social/visibility';
import type { AgePolicy } from '../users/age-policy';
import { POST_COLUMNS, type PostHydrator, type PostRow } from './hydrator';
import { collectTopics, extractMentions } from './text';
import { postListableBy, postReadableBy } from './visibility';

const TimeCursor = z.object({ t: z.string(), id: z.uuid() });
const IdCursor = z.object({ id: z.uuid() });
const SOFT_DELETE_RETENTION_DAYS = 30;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

type MediaState = { id: string; kind: 'VIDEO' | 'IMAGE'; status: string };

export class PostService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly activities: ActivityService,
    private readonly media: MediaService,
    private readonly agePolicy: AgePolicy,
    private readonly moderator: ContentModerator,
    private readonly notifier: Notifier,
    private readonly hydrator: PostHydrator,
    private readonly flags: ModerationFlagSink,
  ) {}

  // ------------------------------------------------------------------ create

  async create(userId: string, input: CreatePostRequest): Promise<Post> {
    const caption = (input.caption ?? '').trim();
    const mediaIds = [...new Set(input.mediaIds ?? [])];
    if (!caption && !input.activityId && mediaIds.length === 0) throw new AppError('EMPTY_POST');
    const verdict = await this.assertCaptionAllowed(caption);

    const settings = await this.db
      .selectFrom('userSettings')
      .select(['defaultPostVisibility', 'defaultCommentPermission'])
      .where('userId', '=', userId)
      .executeTakeFirstOrThrow();
    const visibility = input.visibility ?? settings.defaultPostVisibility;
    await this.agePolicy.assertVisibilityAllowed(userId, visibility);
    const publish = input.publish ?? true;

    const postId = await this.db.transaction().execute(async (trx) => {
      if (input.activityId) await this.activities.assertOwned(userId, input.activityId, trx);
      const mediaStates = await this.assertMediaAttachable(trx, userId, mediaIds);
      if (input.sponsorship) await this.assertSponsorshipValid(trx, userId, input.sponsorship);

      const status: PostStatus = publish ? this.publishState(mediaStates) : 'DRAFT';
      const now = this.clock.now();
      const post = await trx
        .insertInto('posts')
        .values({
          authorId: userId,
          status,
          format: deriveFormat(status, input.activityId ?? null, mediaStates),
          caption,
          visibility,
          commentPermission: input.commentPermission ?? settings.defaultCommentPermission,
          activityId: input.activityId ?? null,
          mediaCount: mediaStates.length,
          publishedAt: status === 'PUBLISHED' ? now : null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      await this.insertMedia(
        trx,
        post.id,
        userId,
        mediaStates.map((m) => m.id),
        0,
      );
      await this.replaceTopics(trx, post.id, {
        explicit: input.topics ?? [],
        caption,
        replaceExplicit: true,
      });
      await this.replaceMentions(trx, post.id, userId, caption);
      if (input.sponsorship) await this.upsertSponsorship(trx, post.id, input.sponsorship);
      if (status === 'PUBLISHED') await this.afterPublished(trx, post.id, userId, null);
      return post.id;
    });
    await this.flagIfNeeded(verdict, postId, caption);
    return this.get(userId, postId);
  }

  /**
   * Guard shared by create/update: automated text moderation may refuse a caption outright (BLOCK).
   * A FLAG verdict lets the post through but is returned so the caller can queue it for review.
   */
  private async assertCaptionAllowed(caption: string): Promise<ModerationVerdict> {
    if (!caption) return { verdict: 'ALLOW' };
    const verdict = await this.moderator.moderateText({ text: caption, context: 'CAPTION' });
    if (verdict.verdict === 'BLOCK') {
      throw new AppError('CONTENT_REJECTED', {
        details: [{ path: 'caption', message: verdict.reason }],
      });
    }
    return verdict;
  }

  private async flagIfNeeded(
    verdict: ModerationVerdict,
    postId: string,
    text: string,
  ): Promise<void> {
    if (verdict.verdict !== 'FLAG') return;
    await this.flags.flag({ targetType: 'POST', targetId: postId, reason: verdict.reason, text });
  }

  // ------------------------------------------------------------------ update / publish / delete

  async update(userId: string, id: string, patch: UpdatePostRequest): Promise<Post> {
    const caption = patch.caption === undefined ? undefined : patch.caption.trim();
    const verdict: ModerationVerdict =
      caption === undefined ? { verdict: 'ALLOW' } : await this.assertCaptionAllowed(caption);
    if (patch.visibility !== undefined)
      await this.agePolicy.assertVisibilityAllowed(userId, patch.visibility);

    await this.db.transaction().execute(async (trx) => {
      const post = await this.lockOwned(trx, userId, id);
      if (patch.visibility !== undefined && post.origin === 'ACTIVITY_AUTO') {
        throw new AppError('VALIDATION_FAILED', {
          details: [
            {
              path: 'visibility',
              message:
                "An activity post follows its activity's visibility. Change the activity instead.",
            },
          ],
        });
      }
      const newCaption = caption ?? post.caption;
      if (!newCaption && !post.activityId && post.mediaCount === 0)
        throw new AppError('EMPTY_POST');

      const set: Record<string, unknown> = {};
      if (caption !== undefined) set.caption = caption;
      if (patch.visibility !== undefined) set.visibility = patch.visibility;
      if (patch.commentPermission !== undefined) set.commentPermission = patch.commentPermission;
      if (Object.keys(set).length > 0)
        await trx.updateTable('posts').set(set).where('id', '=', id).execute();

      if (caption !== undefined || patch.topics !== undefined) {
        await this.replaceTopics(trx, id, {
          explicit: patch.topics ?? [],
          caption: newCaption,
          replaceExplicit: patch.topics !== undefined,
        });
      }
      if (caption !== undefined) {
        const added = await this.replaceMentions(trx, id, userId, newCaption);
        if (post.status === 'PUBLISHED') await this.notifyMentions(trx, id, userId, added);
      }
      if (patch.sponsorship === null) {
        // Once a post is live, a disclosure cannot be quietly withdrawn (ad-disclosure rules).
        if (post.status === 'PUBLISHED') {
          throw new AppError('INVALID_STATE', {
            message: 'A sponsorship disclosure cannot be removed from a published post.',
          });
        }
        await trx.deleteFrom('sponsorshipDisclosures').where('postId', '=', id).execute();
      } else if (patch.sponsorship) {
        await this.assertSponsorshipValid(trx, userId, patch.sponsorship);
        await this.upsertSponsorship(trx, id, patch.sponsorship);
      }
    });
    if (caption !== undefined) await this.flagIfNeeded(verdict, id, caption);
    return this.get(userId, id);
  }

  /** DRAFT / PUBLISH_FAILED -> PUBLISHED (or PENDING_MEDIA while media is still processing). */
  async publish(userId: string, id: string): Promise<Post> {
    await this.db.transaction().execute(async (trx) => {
      const post = await this.lockOwned(trx, userId, id);
      if (post.status === 'PUBLISHED' || post.status === 'PENDING_MEDIA') return; // idempotent
      const states = await this.mediaStates(trx, id);
      if (states.some((m) => m.status === 'REJECTED' || m.status === 'FAILED')) {
        throw new AppError('MEDIA_REJECTED', {
          message: 'Remove the media that failed processing, then publish again.',
        });
      }
      const next = this.publishState(states);
      await trx
        .updateTable('posts')
        .set({
          status: next,
          publishedAt: next === 'PUBLISHED' ? this.clock.now() : null,
          format: deriveFormat(next, post.activityId, states),
        })
        .where('id', '=', id)
        .execute();
      if (next === 'PUBLISHED') await this.afterPublished(trx, id, userId, null);
    });
    return this.get(userId, id);
  }

  /**
   * Soft-deletes: the post disappears for everyone immediately and is purged for good after a
   * retention window. Its media are detached and removed (the author asked for the content to go).
   */
  async delete(userId: string, id: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await this.lockOwned(trx, userId, id);
      const links = await trx
        .selectFrom('postMedia')
        .select('mediaId')
        .where('postId', '=', id)
        .execute();
      await trx
        .updateTable('posts')
        .set({ deletedAt: this.clock.now() })
        .where('id', '=', id)
        .execute();
      await trx.deleteFrom('postMedia').where('postId', '=', id).execute();
      await this.media.deleteRows(
        trx,
        userId,
        links.map((l) => l.mediaId),
      );
      await trx.deleteFrom('notifications').where('postId', '=', id).execute();
    });
  }

  // ------------------------------------------------------------------ media attachment

  async attachMedia(userId: string, id: string, mediaIds: readonly string[]): Promise<Post> {
    const unique = [...new Set(mediaIds)];
    await this.db.transaction().execute(async (trx) => {
      const post = await this.lockOwned(trx, userId, id);
      const existing = await this.mediaStates(trx, id);
      if (existing.length + unique.length > MAX_MEDIA_PER_POST) {
        throw new AppError('VALIDATION_FAILED', {
          details: [{ path: 'mediaIds', message: `At most ${MAX_MEDIA_PER_POST} media per post.` }],
        });
      }
      const added = await this.assertMediaAttachable(trx, userId, unique);
      const maxPos = await trx
        .selectFrom('postMedia')
        .select((eb) => eb.fn.max('position').as('m'))
        .where('postId', '=', id)
        .executeTakeFirst();
      await this.insertMedia(
        trx,
        id,
        userId,
        added.map((m) => m.id),
        (maxPos?.m ?? -1) + 1,
      );
      await this.refreshDerived(trx, id, post.status, post.activityId);
    });
    return this.get(userId, id);
  }

  async detachMedia(userId: string, id: string, mediaId: string): Promise<Post> {
    await this.db.transaction().execute(async (trx) => {
      const post = await this.lockOwned(trx, userId, id);
      const res = await trx
        .deleteFrom('postMedia')
        .where('postId', '=', id)
        .where('mediaId', '=', mediaId)
        .executeTakeFirst();
      if (Number(res.numDeletedRows) === 0) throw new AppError('MEDIA_NOT_FOUND');
      const remaining = await this.mediaStates(trx, id);
      if (!post.caption && !post.activityId && remaining.length === 0 && post.status !== 'DRAFT')
        throw new AppError('EMPTY_POST');
      // The detached media stays in the user's library: they can reuse or delete it.
      let status = post.status;
      if (status === 'PENDING_MEDIA' && remaining.every((m) => m.status === 'READY')) {
        status = 'PUBLISHED';
        await trx
          .updateTable('posts')
          .set({ status, publishedAt: this.clock.now() })
          .where('id', '=', id)
          .execute();
        await this.afterPublished(trx, id, userId, null);
      }
      await this.refreshDerived(trx, id, status, post.activityId);
    });
    return this.get(userId, id);
  }

  // ------------------------------------------------------------------ reads

  async get(viewerId: string | null, id: string): Promise<Post> {
    const row = await this.getRow(viewerId, id);
    const [post] = await this.hydrator.hydrate(viewerId, [row]);
    if (!post) throw new AppError('POST_NOT_FOUND');
    return post;
  }

  /** The raw row if the viewer may open it, else POST_NOT_FOUND (never 403: no existence leak). */
  async getRow(viewerId: string | null, id: string): Promise<PostRow> {
    const row = await this.db
      .selectFrom('posts as p')
      .innerJoin('users as au', 'au.id', 'p.authorId')
      .innerJoin('profiles as ap', 'ap.userId', 'p.authorId')
      .select(POST_COLUMNS)
      .where('p.id', '=', id)
      .where(postReadableBy(viewerId))
      .executeTakeFirst();
    if (!row) throw new AppError('POST_NOT_FOUND');
    return row;
  }

  /** A profile grid: published, clean posts of `authorId` that the viewer is allowed to see. */
  async listByAuthor(
    viewerId: string | null,
    authorId: string,
    args: { limit: number; cursor?: string | undefined; format?: PostFormat | undefined },
  ): Promise<Page<Post>> {
    const author = await this.db
      .selectFrom('profiles as ap')
      .innerJoin('users as au', 'au.id', 'ap.userId')
      .select('ap.accountVisibility')
      .where('ap.userId', '=', authorId)
      .where(accountVisibleTo(viewerId, { authorId: 'ap.user_id', authorStatus: 'au.status' }))
      .executeTakeFirst();
    if (!author) throw new AppError('USER_NOT_FOUND');
    if (author.accountVisibility === 'PRIVATE' && viewerId !== authorId) {
      const follows =
        viewerId !== null &&
        (await this.db
          .selectFrom('follows')
          .select('followerId')
          .where('followerId', '=', viewerId)
          .where('followeeId', '=', authorId)
          .executeTakeFirst()) !== undefined;
      if (!follows) throw new AppError('ACCOUNT_PRIVATE');
    }

    const cursor = args.cursor ? decodeCursor(args.cursor, TimeCursor) : undefined;
    let q = this.db
      .selectFrom('posts as p')
      .innerJoin('users as au', 'au.id', 'p.authorId')
      .innerJoin('profiles as ap', 'ap.userId', 'p.authorId')
      .select([...POST_COLUMNS, timestampText('p.published_at').as('ts')])
      .where('p.authorId', '=', authorId)
      .where(postListableBy(viewerId))
      .orderBy('p.publishedAt', 'desc')
      .orderBy('p.id', 'desc')
      .limit(args.limit + 1);
    if (args.format) q = q.where('p.format', '=', args.format);
    if (cursor) q = q.where(keysetBefore('p.published_at', 'p.id', cursor));
    const { page, hasMore } = sliceProbe(await q.execute(), args.limit);
    const items = await this.hydrator.hydrate(viewerId, page);
    const last = page[page.length - 1];
    return {
      items,
      nextCursor: hasMore && last ? encodeCursor({ t: last.ts, id: last.id }) : null,
    };
  }

  /** The author's own posts in every state (drafts, pending, failed, moderated) for a "my posts" screen. */
  async listOwn(
    userId: string,
    args: { limit: number; cursor?: string | undefined; status?: PostStatus | undefined },
  ): Promise<Page<Post>> {
    const cursor = args.cursor ? decodeCursor(args.cursor, IdCursor) : undefined;
    let q = this.db
      .selectFrom('posts as p')
      .select(POST_COLUMNS)
      .where('p.authorId', '=', userId)
      .where('p.deletedAt', 'is', null)
      .orderBy('p.id', 'desc')
      .limit(args.limit + 1);
    if (args.status) q = q.where('p.status', '=', args.status);
    if (cursor) q = q.where('p.id', '<', cursor.id);
    const { page, hasMore } = sliceProbe(await q.execute(), args.limit);
    const items = await this.hydrator.hydrate(userId, page);
    const last = page[page.length - 1];
    return { items, nextCursor: hasMore && last ? encodeCursor({ id: last.id }) : null };
  }

  // ------------------------------------------------------------------ activity integration

  /** Creates the feed post for a freshly logged activity. Runs inside the activity's transaction. */
  async createAutoPost(
    db: Db,
    input: { userId: string; activityId: string; visibility: ContentVisibility },
  ): Promise<string | null> {
    const settings = await db
      .selectFrom('userSettings')
      .select('defaultCommentPermission')
      .where('userId', '=', input.userId)
      .executeTakeFirstOrThrow();
    const row = await db
      .insertInto('posts')
      .values({
        authorId: input.userId,
        origin: 'ACTIVITY_AUTO',
        status: 'PUBLISHED',
        format: 'ACTIVITY',
        caption: '',
        visibility: input.visibility,
        commentPermission: settings.defaultCommentPermission,
        activityId: input.activityId,
        publishedAt: this.clock.now(),
      })
      .onConflict((oc) => oc.doNothing())
      .returning('id')
      .executeTakeFirst();
    return row?.id ?? null;
  }

  /** An activity post always mirrors its activity's audience. */
  async syncAutoPostVisibility(
    db: Db,
    activityId: string,
    visibility: ContentVisibility,
  ): Promise<void> {
    await db
      .updateTable('posts')
      .set({ visibility })
      .where('activityId', '=', activityId)
      .where('origin', '=', 'ACTIVITY_AUTO')
      .execute();
  }

  /** Called before an activity is deleted: its generated post goes with it (authored posts only detach). */
  async deleteAutoPosts(db: Db, activityId: string): Promise<void> {
    await db
      .deleteFrom('posts')
      .where('activityId', '=', activityId)
      .where('origin', '=', 'ACTIVITY_AUTO')
      .execute();
  }

  async autoPostIdFor(db: Db, activityId: string): Promise<string | null> {
    const row = await db
      .selectFrom('posts')
      .select('id')
      .where('activityId', '=', activityId)
      .where('origin', '=', 'ACTIVITY_AUTO')
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
    return row?.id ?? null;
  }

  // ------------------------------------------------------------------ media events (job handlers)

  /**
   * A media asset reached a terminal state. Posts waiting on it either publish themselves or
   * flip to PUBLISH_FAILED, and the author is told.
   */
  readonly handleMediaStatusChanged = async (payload: {
    mediaId: string;
    status: 'READY' | 'FAILED' | 'REJECTED';
  }): Promise<void> => {
    const link = await this.db
      .selectFrom('postMedia')
      .select('postId')
      .where('mediaId', '=', payload.mediaId)
      .executeTakeFirst();
    if (!link) return; // media not attached to a post (e.g. an avatar)
    await this.db.transaction().execute(async (trx) => {
      const post = await trx
        .selectFrom('posts')
        .select(['id', 'authorId', 'status', 'activityId', 'deletedAt'])
        .where('id', '=', link.postId)
        .forUpdate()
        .executeTakeFirst();
      if (!post || post.deletedAt) return;
      const states = await this.mediaStates(trx, post.id);

      if (payload.status === 'READY') {
        if (post.status === 'PENDING_MEDIA' && states.every((m) => m.status === 'READY')) {
          await trx
            .updateTable('posts')
            .set({ status: 'PUBLISHED', publishedAt: this.clock.now() })
            .where('id', '=', post.id)
            .execute();
          await this.afterPublished(trx, post.id, post.authorId, null);
          await this.notifier.notify(
            {
              recipientId: post.authorId,
              type: 'POST_PUBLISHED',
              postId: post.id,
              dedupeKey: `post_published:${post.id}`,
            },
            trx,
          );
          await this.refreshDerived(trx, post.id, 'PUBLISHED', post.activityId);
        } else {
          await this.refreshDerived(trx, post.id, post.status, post.activityId);
        }
        return;
      }
      // FAILED / REJECTED
      if (post.status === 'PENDING_MEDIA') {
        await trx
          .updateTable('posts')
          .set({ status: 'PUBLISH_FAILED' })
          .where('id', '=', post.id)
          .execute();
      }
      await this.notifier.notify(
        {
          recipientId: post.authorId,
          type: 'POST_PUBLISH_FAILED',
          postId: post.id,
          data: { mediaId: payload.mediaId },
          dedupeKey: `post_media_failed:${payload.mediaId}`,
        },
        trx,
      );
      await this.refreshDerived(
        trx,
        post.id,
        post.status === 'PENDING_MEDIA' ? 'PUBLISH_FAILED' : post.status,
        post.activityId,
      );
    });
  };

  /** Hard-deletes posts that were soft-deleted longer ago than the retention window. */
  readonly handlePurgeDeleted = async (): Promise<void> => {
    const cutoff = new Date(
      this.clock.now().getTime() - SOFT_DELETE_RETENTION_DAYS * 24 * 3600_000,
    );
    await this.db.deleteFrom('posts').where('deletedAt', '<', cutoff).execute();
  };

  // ------------------------------------------------------------------ internals

  /** Locks a post row the user owns and that is not deleted. Others' posts are "not found". */
  private async lockOwned(trx: Db, userId: string, id: string) {
    const post = await trx
      .selectFrom('posts')
      .select(['id', 'authorId', 'origin', 'status', 'caption', 'activityId', 'mediaCount'])
      .where('id', '=', id)
      .where('authorId', '=', userId)
      .where('deletedAt', 'is', null)
      .forUpdate()
      .executeTakeFirst();
    if (!post) throw new AppError('POST_NOT_FOUND');
    return post;
  }

  private async mediaStates(db: Db, postId: string): Promise<MediaState[]> {
    return db
      .selectFrom('postMedia as pm')
      .innerJoin('mediaAssets as m', 'm.id', 'pm.mediaId')
      .select(['m.id', 'm.kind', 'm.status'])
      .where('pm.postId', '=', postId)
      .orderBy('pm.position')
      .execute();
  }

  private publishState(states: readonly MediaState[]): PostStatus {
    return states.every((m) => m.status === 'READY') ? 'PUBLISHED' : 'PENDING_MEDIA';
  }

  /** Validates that every id is the user's own POST media that is uploaded, usable and unattached. */
  private async assertMediaAttachable(
    db: Db,
    userId: string,
    ids: readonly string[],
  ): Promise<MediaState[]> {
    if (ids.length === 0) return [];
    const rows = await db
      .selectFrom('mediaAssets as m')
      .leftJoin('postMedia as pm', 'pm.mediaId', 'm.id')
      .select(['m.id', 'm.kind', 'm.status', 'm.purpose', 'pm.postId as attachedTo'])
      .where('m.id', 'in', [...ids])
      .where('m.ownerId', '=', userId)
      .execute();
    const byId = new Map(rows.map((r) => [r.id, r]));
    const ordered: MediaState[] = [];
    for (const id of ids) {
      const m = byId.get(id);
      if (!m)
        throw new AppError('MEDIA_NOT_FOUND', {
          details: [{ path: 'mediaIds', message: `Unknown media ${id}.` }],
        });
      if (m.purpose !== 'POST')
        throw new AppError('VALIDATION_FAILED', {
          details: [{ path: 'mediaIds', message: `Media ${id} was uploaded for ${m.purpose}.` }],
        });
      if (m.status === 'REJECTED')
        throw new AppError('MEDIA_REJECTED', {
          details: [{ path: 'mediaIds', message: `Media ${id} was rejected.` }],
        });
      if (m.status === 'FAILED')
        throw new AppError('MEDIA_NOT_READY', {
          message: 'That media failed processing. Retry it or upload again.',
        });
      if (m.status === 'PENDING_UPLOAD')
        throw new AppError('MEDIA_NOT_READY', {
          message: 'Finish uploading (POST /media/{id}/complete) before attaching.',
        });
      if (m.attachedTo)
        throw new AppError('MEDIA_ALREADY_ATTACHED', {
          details: [{ path: 'mediaIds', message: `Media ${id} is already in a post.` }],
        });
      ordered.push({ id: m.id, kind: m.kind, status: m.status });
    }
    return ordered;
  }

  private async insertMedia(
    db: Db,
    postId: string,
    ownerId: string,
    mediaIds: readonly string[],
    startAt: number,
  ): Promise<void> {
    if (mediaIds.length === 0) return;
    try {
      await db
        .insertInto('postMedia')
        .values(mediaIds.map((mediaId, i) => ({ postId, mediaId, ownerId, position: startAt + i })))
        .execute();
    } catch (err) {
      if (isUniqueViolation(err, 'post_media_one_post_per_media'))
        throw new AppError('MEDIA_ALREADY_ATTACHED');
      throw err;
    }
  }

  /** Recomputes the stored format and media count after media or status changes. */
  private async refreshDerived(
    db: Db,
    postId: string,
    status: PostStatus,
    activityId: string | null,
  ): Promise<void> {
    const states = await this.mediaStates(db, postId);
    await db
      .updateTable('posts')
      .set({ format: deriveFormat(status, activityId, states), mediaCount: states.length })
      .where('id', '=', postId)
      .execute();
  }

  /** CAPTION topics always follow the caption; EXPLICIT topics change only when the author sends them. */
  private async replaceTopics(
    db: Db,
    postId: string,
    o: { explicit: readonly string[]; caption: string; replaceExplicit: boolean },
  ): Promise<void> {
    const explicit = collectTopics('', o.explicit);
    const fromCaption = collectTopics(o.caption).filter((s) => !explicit.includes(s));
    if (o.replaceExplicit) await db.deleteFrom('postTopics').where('postId', '=', postId).execute();
    else
      await db
        .deleteFrom('postTopics')
        .where('postId', '=', postId)
        .where('source', '=', 'CAPTION')
        .execute();

    const wanted = o.replaceExplicit
      ? [
          ...explicit.map((slug) => ({ slug, source: 'EXPLICIT' as const })),
          ...fromCaption.map((slug) => ({ slug, source: 'CAPTION' as const })),
        ]
      : fromCaption.map((slug) => ({ slug, source: 'CAPTION' as const }));
    if (wanted.length === 0) return;

    const topics = await db
      .insertInto('topics')
      .values(wanted.map((w) => ({ slug: w.slug })))
      .onConflict((oc) =>
        oc.column('slug').doUpdateSet((eb) => ({ slug: eb.ref('excluded.slug') })),
      )
      .returning(['id', 'slug'])
      .execute();
    const idBySlug = new Map(topics.map((t) => [t.slug.toLowerCase(), t.id]));
    const rows = wanted.flatMap((w) => {
      const topicId = idBySlug.get(w.slug);
      return topicId ? [{ postId, topicId, source: w.source }] : [];
    });
    if (rows.length > 0)
      await db
        .insertInto('postTopics')
        .values(rows)
        .onConflict((oc) => oc.doNothing())
        .execute();
  }

  /** Re-resolves @mentions from the caption. Returns the user ids that are NEW for this post. */
  private async replaceMentions(
    db: Db,
    postId: string,
    authorId: string,
    caption: string,
  ): Promise<string[]> {
    const names = extractMentions(caption);
    const previous = new Set(
      (
        await db.selectFrom('postMentions').select('userId').where('postId', '=', postId).execute()
      ).map((r) => r.userId),
    );
    await db.deleteFrom('postMentions').where('postId', '=', postId).execute();
    if (names.length === 0) return [];

    const users = await db
      .selectFrom('profiles as p')
      .innerJoin('users as u', 'u.id', 'p.userId')
      .select('p.userId')
      .where('p.username', 'in', names)
      .where('u.status', '=', 'ACTIVE')
      .where('p.userId', '!=', authorId)
      .where((eb) =>
        // Never link or notify across a block, in either direction.
        eb.not(
          eb.exists(
            eb
              .selectFrom('blocks as b')
              .select('b.blockerId')
              .where((e) =>
                e.or([
                  e.and([
                    e('b.blockerId', '=', authorId),
                    e('b.blockedId', '=', eb.ref('p.userId')),
                  ]),
                  e.and([
                    e('b.blockerId', '=', eb.ref('p.userId')),
                    e('b.blockedId', '=', authorId),
                  ]),
                ]),
              ),
          ),
        ),
      )
      .execute();
    if (users.length > 0) {
      await db
        .insertInto('postMentions')
        .values(users.map((u) => ({ postId, userId: u.userId })))
        .execute();
    }
    return users.map((u) => u.userId).filter((id) => !previous.has(id));
  }

  private async notifyMentions(
    db: Db,
    postId: string,
    authorId: string,
    userIds: readonly string[],
  ): Promise<void> {
    for (const recipientId of userIds) {
      await this.notifier.notify(
        {
          recipientId,
          type: 'MENTION_POST',
          actorId: authorId,
          postId,
          dedupeKey: `mention_post:${postId}`,
        },
        db,
      );
    }
  }

  /** Side effects of a post becoming visible. Mentions are only notified once the post is live. */
  private async afterPublished(
    db: Db,
    postId: string,
    authorId: string,
    only: readonly string[] | null,
  ): Promise<void> {
    const rows = await db
      .selectFrom('postMentions')
      .select('userId')
      .where('postId', '=', postId)
      .execute();
    const ids = rows.map((r) => r.userId).filter((id) => only === null || only.includes(id));
    await this.notifyMentions(db, postId, authorId, ids);
  }

  private async assertSponsorshipValid(db: Db, userId: string, s: SponsorshipInput): Promise<void> {
    if (!s.partnershipId) return;
    const p = await db
      .selectFrom('brandPartnerships')
      .select('id')
      .where('id', '=', s.partnershipId)
      .where('creatorUserId', '=', userId)
      .executeTakeFirst();
    if (!p)
      throw new AppError('VALIDATION_FAILED', {
        details: [{ path: 'sponsorship.partnershipId', message: 'Unknown partnership.' }],
      });
  }

  private async upsertSponsorship(db: Db, postId: string, s: SponsorshipInput): Promise<void> {
    await db
      .insertInto('sponsorshipDisclosures')
      .values({
        postId,
        type: s.type,
        brandName: s.brandName,
        partnershipId: s.partnershipId ?? null,
      })
      .onConflict((oc) =>
        oc.column('postId').doUpdateSet({
          type: s.type,
          brandName: s.brandName,
          partnershipId: s.partnershipId ?? null,
        }),
      )
      .execute();
  }
}

/**
 * The stored format. For a published post it reflects only what viewers can actually see (READY
 * media + the activity); while unpublished it reflects the intended media so the author's UI is right.
 */
export function deriveFormat(
  status: PostStatus,
  activityId: string | null,
  media: readonly MediaState[],
): PostFormat {
  const considered =
    status === 'PUBLISHED'
      ? media.filter((m) => m.status === 'READY')
      : media.filter((m) => m.status !== 'FAILED' && m.status !== 'REJECTED');
  if (considered.some((m) => m.kind === 'VIDEO')) return 'VIDEO';
  if (considered.some((m) => m.kind === 'IMAGE')) return 'PHOTO';
  return activityId ? 'ACTIVITY' : 'TEXT';
}
