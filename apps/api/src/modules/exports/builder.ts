import { createWriteStream, type WriteStream } from 'node:fs';
import { once } from 'node:events';
import type { Db } from '../../platform/db/client';

/**
 * Builds a user's personal-data export (GDPR "right of access" / CCPA "right to know") as ONE JSON
 * file, streamed to disk section by section and page by page, so memory stays flat no matter how
 * much history an account has. Secrets (password hash, session/refresh/push/integration tokens)
 * are never selected. Other people's data is limited to opaque ids and public usernames.
 */

const PAGE = 500;
const MAX_EVENT_ROWS = 200_000;
const MAX_NOTIFICATIONS = 20_000;

class JsonFile {
  private first = true;
  private readonly out: WriteStream;

  constructor(path: string) {
    this.out = createWriteStream(path, { encoding: 'utf8' });
  }

  private async write(chunk: string): Promise<void> {
    if (!this.out.write(chunk)) await once(this.out, 'drain');
  }

  async begin(): Promise<void> {
    await this.write('{');
  }

  private async key(name: string): Promise<void> {
    await this.write(`${this.first ? '' : ','}\n${JSON.stringify(name)}:`);
    this.first = false;
  }

  async value(name: string, value: unknown): Promise<void> {
    await this.key(name);
    await this.write(JSON.stringify(value ?? null));
  }

  async array(name: string, rows: AsyncIterable<unknown>): Promise<void> {
    await this.key(name);
    await this.write('[');
    let firstRow = true;
    for await (const row of rows) {
      await this.write(`${firstRow ? '' : ','}\n${JSON.stringify(row)}`);
      firstRow = false;
    }
    await this.write(firstRow ? ']' : '\n]');
  }

  async end(): Promise<void> {
    await this.write('\n}\n');
    this.out.end();
    await once(this.out, 'finish');
  }
}

/** Keyset-paged iteration over a large table: yields one page (array) at a time. */
async function* pages<T>(
  fetch: (after: string | null, limit: number) => Promise<T[]>,
  keyOf: (row: T) => string,
  max = Number.POSITIVE_INFINITY,
): AsyncGenerator<T[]> {
  let after: string | null = null;
  let seen = 0;
  for (;;) {
    const rows: T[] = await fetch(after, PAGE);
    const take = rows.slice(0, Math.max(0, max - seen));
    seen += take.length;
    if (take.length > 0) yield take;
    const last = rows[rows.length - 1];
    if (rows.length < PAGE || !last || take.length < rows.length) return;
    after = keyOf(last);
  }
}

/** Maps each page through `fn` (used to attach child rows with a few queries per page). */
async function* enrich<T, R>(
  source: AsyncIterable<T[]>,
  fn: (page: T[]) => Promise<R[]>,
): AsyncGenerator<R> {
  for await (const page of source) yield* await fn(page);
}

async function* flat<T>(source: AsyncIterable<T[]>): AsyncGenerator<T> {
  for await (const page of source) yield* page;
}

async function* all<T>(rows: Promise<T[]>): AsyncGenerator<T> {
  yield* await rows;
}

const group = <T>(rows: readonly T[], key: (r: T) => string): Map<string, T[]> => {
  const out = new Map<string, T[]>();
  for (const r of rows) out.set(key(r), [...(out.get(key(r)) ?? []), r]);
  return out;
};

export async function writeExport(
  db: Db,
  userId: string,
  filePath: string,
  generatedAt: Date,
): Promise<void> {
  const file = new JsonFile(filePath);
  await file.begin();
  try {
    await file.value('exportVersion', 1);
    await file.value('generatedAt', generatedAt);
    await file.value(
      'notes',
      'Media files (videos, photos) are not included in this export; download them from the app. ' +
        'Password hashes, tokens and push tokens are never exported.',
    );

    // ---- account & preferences ---------------------------------------------------------------
    await file.value(
      'account',
      await db
        .selectFrom('users')
        .select([
          'id',
          'email',
          'emailVerifiedAt',
          'role',
          'status',
          'birthDate',
          'createdAt',
          'lastLoginAt',
          'passwordChangedAt',
        ])
        .where('id', '=', userId)
        .executeTakeFirst(),
    );
    await file.value(
      'profile',
      await db.selectFrom('profiles').selectAll().where('userId', '=', userId).executeTakeFirst(),
    );
    await file.value(
      'settings',
      await db
        .selectFrom('userSettings')
        .selectAll()
        .where('userId', '=', userId)
        .executeTakeFirst(),
    );
    await file.array(
      'notificationPreferences',
      all(
        db.selectFrom('notificationPreferences').selectAll().where('userId', '=', userId).execute(),
      ),
    );
    await file.array(
      'sportPreferences',
      all(db.selectFrom('sportPreferences').selectAll().where('userId', '=', userId).execute()),
    );
    await file.value(
      'creatorProfile',
      await db
        .selectFrom('creatorProfiles')
        .selectAll()
        .where('userId', '=', userId)
        .executeTakeFirst(),
    );
    await file.array(
      'brandPartnerships',
      all(
        db
          .selectFrom('brandPartnerships')
          .selectAll()
          .where('creatorUserId', '=', userId)
          .execute(),
      ),
    );
    await file.array(
      'privacyZones',
      all(db.selectFrom('privacyZones').selectAll().where('userId', '=', userId).execute()),
    );
    await file.array(
      'devices',
      all(
        db
          .selectFrom('devices')
          .select(['id', 'installId', 'platform', 'name', 'appVersion', 'createdAt', 'lastSeenAt'])
          .where('userId', '=', userId)
          .execute(),
      ),
    );
    await file.array(
      'sessions',
      all(
        db
          .selectFrom('sessions')
          .select([
            'id',
            'deviceId',
            'createdAt',
            'lastSeenAt',
            'expiresAt',
            'revokedAt',
            'userAgent',
            'ipPrefix',
          ])
          .where('userId', '=', userId)
          .execute(),
      ),
    );
    await file.array(
      'integrations',
      all(
        db
          .selectFrom('integrationConnections')
          .select([
            'id',
            'provider',
            'status',
            'scopes',
            'externalAccountId',
            'lastSyncedAt',
            'createdAt',
          ])
          .where('userId', '=', userId)
          .execute(),
      ),
    );
    await file.array(
      'linkedLogins',
      all(
        db
          .selectFrom('oauthIdentities')
          .select(['provider', 'email', 'createdAt'])
          .where('userId', '=', userId)
          .execute(),
      ),
    );

    // ---- activities (full, UNFILTERED routes: this is the user's own data) ----------------------
    await file.array(
      'activities',
      enrich(
        pages(
          (after, limit) => {
            let q = db
              .selectFrom('activities')
              .selectAll()
              .where('userId', '=', userId)
              .orderBy('id')
              .limit(limit);
            if (after) q = q.where('id', '>', after);
            return q.execute();
          },
          (a) => a.id,
        ),
        async (page) => {
          const ids = page.map((a) => a.id);
          const [metrics, splits, routes, records] = await Promise.all([
            db.selectFrom('activityMetrics').selectAll().where('activityId', 'in', ids).execute(),
            db
              .selectFrom('activitySplits')
              .selectAll()
              .where('activityId', 'in', ids)
              .orderBy('splitType')
              .orderBy('splitIndex')
              .execute(),
            db.selectFrom('activityRoutes').selectAll().where('activityId', 'in', ids).execute(),
            db.selectFrom('activityRecords').selectAll().where('activityId', 'in', ids).execute(),
          ]);
          const metricsBy = new Map(metrics.map((m) => [m.activityId, m]));
          const routeBy = new Map(routes.map((r) => [r.activityId, r]));
          const splitsBy = group(splits, (x) => x.activityId);
          const recordsBy = group(records, (x) => x.activityId);
          return page.map((a) => ({
            ...a,
            metrics: metricsBy.get(a.id) ?? null,
            splits: splitsBy.get(a.id) ?? [],
            route: routeBy.get(a.id) ?? null,
            records: recordsBy.get(a.id) ?? [],
          }));
        },
      ),
    );

    // ---- content ---------------------------------------------------------------------------------
    await file.array(
      'posts',
      enrich(
        pages(
          (after, limit) => {
            let q = db
              .selectFrom('posts')
              .selectAll()
              .where('authorId', '=', userId)
              .where('deletedAt', 'is', null)
              .orderBy('id')
              .limit(limit);
            if (after) q = q.where('id', '>', after);
            return q.execute();
          },
          (p) => p.id,
        ),
        async (page) => {
          const ids = page.map((p) => p.id);
          const [topics, mentions, sponsorship, media] = await Promise.all([
            db
              .selectFrom('postTopics as pt')
              .innerJoin('topics as t', 't.id', 'pt.topicId')
              .select(['pt.postId', 't.slug'])
              .where('pt.postId', 'in', ids)
              .execute(),
            db
              .selectFrom('postMentions as pm')
              .innerJoin('profiles as p', 'p.userId', 'pm.userId')
              .select(['pm.postId', 'pm.userId', 'p.username'])
              .where('pm.postId', 'in', ids)
              .execute(),
            db
              .selectFrom('sponsorshipDisclosures')
              .selectAll()
              .where('postId', 'in', ids)
              .execute(),
            db
              .selectFrom('postMedia')
              .select(['postId', 'mediaId', 'position'])
              .where('postId', 'in', ids)
              .orderBy('position')
              .execute(),
          ]);
          const topicsBy = group(topics, (x) => x.postId);
          const mentionsBy = group(mentions, (x) => x.postId);
          const sponsorBy = new Map(sponsorship.map((x) => [x.postId, x]));
          const mediaBy = group(media, (x) => x.postId);
          return page.map((p) => {
            const { searchTsv: _tsv, ...post } = p;
            return {
              ...post,
              topics: (topicsBy.get(p.id) ?? []).map((x) => x.slug),
              mentions: (mentionsBy.get(p.id) ?? []).map((x) => ({
                userId: x.userId,
                username: x.username,
              })),
              sponsorship: sponsorBy.get(p.id) ?? null,
              mediaIds: (mediaBy.get(p.id) ?? []).map((x) => x.mediaId),
            };
          });
        },
      ),
    );
    await file.array(
      'media',
      flat(
        pages(
          (after, limit) => {
            let q = db
              .selectFrom('mediaAssets')
              .select([
                'id',
                'kind',
                'purpose',
                'status',
                'declaredMime',
                'actualSizeBytes',
                'createdAt',
                'readyAt',
              ])
              .where('ownerId', '=', userId)
              .orderBy('id')
              .limit(limit);
            if (after) q = q.where('id', '>', after);
            return q.execute();
          },
          (m) => m.id,
        ),
      ),
    );
    await file.array(
      'comments',
      flat(
        pages(
          (after, limit) => {
            let q = db
              .selectFrom('comments')
              .select(['id', 'postId', 'parentId', 'body', 'moderationStatus', 'createdAt'])
              .where('authorId', '=', userId)
              .where('deletedAt', 'is', null)
              .orderBy('id')
              .limit(limit);
            if (after) q = q.where('id', '>', after);
            return q.execute();
          },
          (c) => c.id,
        ),
      ),
    );

    // ---- engagement ---------------------------------------------------------------------------------
    await file.array(
      'postReactions',
      flat(
        pages(
          (after, limit) => {
            let q = db
              .selectFrom('postReactions')
              .select(['postId', 'reaction', 'createdAt'])
              .where('userId', '=', userId)
              .orderBy('postId')
              .limit(limit);
            if (after) q = q.where('postId', '>', after);
            return q.execute();
          },
          (r) => r.postId,
        ),
      ),
    );
    await file.array(
      'commentLikes',
      flat(
        pages(
          (after, limit) => {
            let q = db
              .selectFrom('commentReactions')
              .select(['commentId', 'createdAt'])
              .where('userId', '=', userId)
              .orderBy('commentId')
              .limit(limit);
            if (after) q = q.where('commentId', '>', after);
            return q.execute();
          },
          (r) => r.commentId,
        ),
      ),
    );
    await file.array(
      'bookmarks',
      flat(
        pages(
          (after, limit) => {
            let q = db
              .selectFrom('bookmarks')
              .select(['postId', 'createdAt'])
              .where('userId', '=', userId)
              .orderBy('postId')
              .limit(limit);
            if (after) q = q.where('postId', '>', after);
            return q.execute();
          },
          (r) => r.postId,
        ),
      ),
    );
    await file.array(
      'shares',
      flat(
        pages(
          (after, limit) => {
            let q = db
              .selectFrom('shares')
              .select(['id', 'postId', 'channel', 'createdAt'])
              .where('userId', '=', userId)
              .orderBy('id')
              .limit(limit);
            if (after) q = q.where('id', '>', after);
            return q.execute();
          },
          (r) => r.id,
        ),
      ),
    );

    // ---- social graph (other people appear only as an id and their public username) ----------------
    await file.array(
      'following',
      flat(
        pages(
          (after, limit) => {
            let q = db
              .selectFrom('follows as f')
              .innerJoin('profiles as p', 'p.userId', 'f.followeeId')
              .select(['f.followeeId as userId', 'p.username', 'f.createdAt as since'])
              .where('f.followerId', '=', userId)
              .orderBy('f.followeeId')
              .limit(limit);
            if (after) q = q.where('f.followeeId', '>', after);
            return q.execute();
          },
          (r) => r.userId,
        ),
      ),
    );
    await file.array(
      'followers',
      flat(
        pages(
          (after, limit) => {
            let q = db
              .selectFrom('follows as f')
              .innerJoin('profiles as p', 'p.userId', 'f.followerId')
              .select(['f.followerId as userId', 'p.username', 'f.createdAt as since'])
              .where('f.followeeId', '=', userId)
              .orderBy('f.followerId')
              .limit(limit);
            if (after) q = q.where('f.followerId', '>', after);
            return q.execute();
          },
          (r) => r.userId,
        ),
      ),
    );
    await file.array(
      'followRequestsSent',
      all(
        db
          .selectFrom('followRequests as r')
          .innerJoin('profiles as p', 'p.userId', 'r.targetId')
          .select(['r.targetId as userId', 'p.username', 'r.createdAt'])
          .where('r.requesterId', '=', userId)
          .execute(),
      ),
    );
    await file.array(
      'followRequestsReceived',
      all(
        db
          .selectFrom('followRequests as r')
          .innerJoin('profiles as p', 'p.userId', 'r.requesterId')
          .select(['r.requesterId as userId', 'p.username', 'r.createdAt'])
          .where('r.targetId', '=', userId)
          .execute(),
      ),
    );
    await file.array(
      'blockedUsers',
      all(
        db
          .selectFrom('blocks as b')
          .innerJoin('profiles as p', 'p.userId', 'b.blockedId')
          .select(['b.blockedId as userId', 'p.username', 'b.createdAt'])
          .where('b.blockerId', '=', userId)
          .execute(),
      ),
    );

    // ---- notifications, reports, behaviour ---------------------------------------------------------
    await file.array(
      'notifications',
      flat(
        pages(
          (after, limit) => {
            let q = db
              .selectFrom('notifications')
              .select([
                'id',
                'type',
                'actorId',
                'postId',
                'commentId',
                'data',
                'readAt',
                'createdAt',
              ])
              .where('recipientId', '=', userId)
              .orderBy('id')
              .limit(limit);
            if (after) q = q.where('id', '>', after);
            return q.execute();
          },
          (n) => n.id,
          MAX_NOTIFICATIONS,
        ),
      ),
    );
    await file.array(
      'reportsFiled',
      all(
        db
          .selectFrom('reports')
          .select([
            'id',
            'targetType',
            'targetPostId',
            'targetCommentId',
            'targetUserId',
            'reason',
            'details',
            'status',
            'createdAt',
          ])
          .where('reporterId', '=', userId)
          .orderBy('id')
          .execute(),
      ),
    );
    await file.array(
      'behaviouralEvents',
      flat(
        pages(
          (after, limit) => {
            let q = db
              .selectFrom('feedEvents')
              .select([
                'id',
                'eventType',
                'origin',
                'postId',
                'activityId',
                'subjectUserId',
                'topic',
                'surface',
                'position',
                'valueMs',
                'clientTs',
                'createdAt',
              ])
              .where('userId', '=', userId)
              .orderBy('id')
              .limit(limit);
            if (after) q = q.where('id', '>', after);
            return q.execute();
          },
          (e) => e.id,
          MAX_EVENT_ROWS,
        ),
      ),
    );
    await file.array(
      'learnedInterests',
      all(
        db
          .selectFrom('userAffinities')
          .select(['subjectType', 'subjectKey', 'score', 'updatedAt'])
          .where('userId', '=', userId)
          .execute(),
      ),
    );
    await file.array(
      'dataExports',
      all(
        db
          .selectFrom('dataExports')
          .select(['id', 'status', 'requestedAt', 'completedAt', 'expiresAt'])
          .where('userId', '=', userId)
          .orderBy('requestedAt')
          .execute(),
      ),
    );
  } finally {
    await file.end();
  }
}
