import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KeywordModerator } from '../src/platform/ports/keyword-moderator';
import { api, errorCode, signupUser, type TestUser } from './helpers/api';
import { createTestApp, type TestApp } from './helpers/app';
import { createPost, follow } from './helpers/posts';

interface Report {
  id: string;
  source: string;
  status: string;
  reason: string;
  details: string | null;
  reporter: { id: string } | null;
  target: {
    type: string;
    id: string;
    text: string;
    moderationStatus: string | null;
    userStatus: string | null;
    exists: boolean;
    author: { id: string } | null;
  };
  reportCount: number;
  resolvedBy: { id: string } | null;
  resolutionNote: string | null;
}
interface ReportDetail extends Report {
  post: { id: string } | null;
  actions: Array<{
    action: string;
    actor: { id: string } | null;
    metadata: Record<string, unknown>;
  }>;
}
interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

describe('moderation', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(async () => {
    await t.close();
  });

  const pub = (user: TestUser, caption = 'a post') =>
    createPost(t, user, { caption, visibility: 'PUBLIC' }) as Promise<{ id: string }>;
  const makeStaff = async (role: 'MODERATOR' | 'ADMIN') => {
    const user = await signupUser(t);
    await t.platform.db.updateTable('users').set({ role }).where('id', '=', user.id).execute();
    return user;
  };
  const report = (user: TestUser, targetType: string, targetId: string, reason = 'SPAM') =>
    api(t, user).post('/reports', { targetType, targetId, reason });
  const queue = async (staff: TestUser, query = '') =>
    (await api(t, staff).get(`/admin/reports${query}`)).json<Page<Report>>();
  const resolve = (staff: TestUser, id: string, body: Record<string, unknown>) =>
    api(t, staff).post(`/admin/reports/${id}/resolve`, body);
  const notificationsOf = async (user: TestUser) =>
    (await api(t, user).get('/notifications')).json<{
      items: Array<{ type: string; actor: unknown; data: Record<string, unknown> }>;
    }>().items;

  describe('reporting', () => {
    it('files reports for posts, comments and users, once each, and lists your own', async () => {
      const author = await signupUser(t);
      const me = await signupUser(t);
      const post = await pub(author);
      const comment = (
        await api(t, author).post(`/posts/${post.id}/comments`, { body: 'rude comment' })
      ).json<{ id: string }>();

      const filed = await report(me, 'POST', post.id, 'HARASSMENT');
      expect(filed.statusCode, filed.body).toBe(201);
      expect(filed.json()).toMatchObject({
        targetType: 'POST',
        targetId: post.id,
        reason: 'HARASSMENT',
        status: 'OPEN',
      });
      expect((await report(me, 'COMMENT', comment.id)).statusCode).toBe(201);
      expect((await report(me, 'USER', author.id, 'IMPERSONATION')).statusCode).toBe(201);

      // Same thing again - even with a different reason - is refused.
      const again = await report(me, 'POST', post.id, 'SPAM');
      expect(again.statusCode).toBe(409);
      expect(errorCode(again)).toBe('ALREADY_REPORTED');

      const mine = (await api(t, me).get('/me/reports')).json<Page<{ targetType: string }>>();
      expect(mine.items.map((r) => r.targetType).sort()).toEqual(['COMMENT', 'POST', 'USER']);
      expect((await api(t, author).get('/me/reports')).json<Page<unknown>>().items).toEqual([]);
    });

    it('refuses self-reports, invisible targets and malformed requests without leaking existence', async () => {
      const author = await signupUser(t);
      const priv = await signupUser(t, { isPrivate: true });
      const blocker = await signupUser(t);
      const me = await signupUser(t);
      const own = await pub(me);
      const privatePost = await createPost(t, priv, { caption: 'x', visibility: 'FOLLOWERS' });
      const blockerPost = await pub(blocker);
      await api(t, blocker).put(`/users/${me.id}/block`);
      const ghost = '018f0000-0000-7000-8000-000000000000';

      expect(errorCode(await report(me, 'POST', own.id))).toBe('SELF_ACTION_NOT_ALLOWED');
      expect(errorCode(await report(me, 'USER', me.id))).toBe('SELF_ACTION_NOT_ALLOWED');
      for (const id of [privatePost.id, blockerPost.id, ghost]) {
        const res = await report(me, 'POST', id);
        expect([res.statusCode, errorCode(res)], id).toEqual([404, 'POST_NOT_FOUND']);
      }
      expect(errorCode(await report(me, 'COMMENT', ghost))).toBe('COMMENT_NOT_FOUND');
      expect(errorCode(await report(me, 'USER', blocker.id))).toBe('USER_NOT_FOUND');

      const post = await pub(author);
      const bad = async (body: Record<string, unknown>) =>
        errorCode(await api(t, me).post('/reports', body));
      expect(await bad({ targetType: 'POST', targetId: post.id, reason: 'NOPE' })).toBe(
        'VALIDATION_FAILED',
      );
      expect(await bad({ targetType: 'POST', targetId: 'x', reason: 'SPAM' })).toBe(
        'VALIDATION_FAILED',
      );
      expect(
        await bad({
          targetType: 'POST',
          targetId: post.id,
          reason: 'SPAM',
          details: 'x'.repeat(1001),
        }),
      ).toBe('VALIDATION_FAILED');
      expect(
        await bad({ targetType: 'POST', targetId: post.id, reason: 'SPAM', status: 'ACTIONED' }),
      ).toBe('VALIDATION_FAILED');

      const unverified = await signupUser(t, { verified: false });
      expect(errorCode(await report(unverified, 'POST', post.id))).toBe('EMAIL_NOT_VERIFIED');
      expect((await api(t).post('/reports', {})).statusCode).toBe(401);
    });
  });

  describe('staff access', () => {
    it('is closed to everyone but moderators and admins', async () => {
      const user = await signupUser(t);
      const mod = await makeStaff('MODERATOR');
      const paths: Array<['GET' | 'POST', string]> = [
        ['GET', '/admin/reports'],
        ['GET', '/admin/moderation/actions'],
      ];
      for (const [, path] of paths) {
        expect((await api(t).get(path)).statusCode, `${path} anonymous`).toBe(401);
        const denied = await api(t, user).get(path);
        expect([denied.statusCode, errorCode(denied)], path).toEqual([403, 'INSUFFICIENT_ROLE']);
        expect((await api(t, mod).get(path)).statusCode, `${path} moderator`).toBe(200);
      }
      expect((await api(t, user).post('/admin/moderation/actions', {})).statusCode).toBe(403);
    });

    it('stops a moderator acting on equal or higher roles, and reserves verification for admins', async () => {
      const mod = await makeStaff('MODERATOR');
      const mod2 = await makeStaff('MODERATOR');
      const admin = await makeStaff('ADMIN');
      const modPost = await pub(mod2);
      const adminPost = await pub(admin);
      const act = (staff: TestUser, body: Record<string, unknown>) =>
        api(t, staff).post('/admin/moderation/actions', body);

      for (const id of [modPost.id, adminPost.id]) {
        const res = await act(mod, {
          action: 'HIDE_CONTENT',
          targetType: 'POST',
          targetId: id,
          note: 'x',
        });
        expect([res.statusCode, errorCode(res)], id).toEqual([403, 'INSUFFICIENT_ROLE']);
      }
      expect(
        (
          await act(mod, {
            action: 'SUSPEND_USER',
            targetType: 'USER',
            targetId: mod.id,
            note: 'self',
          })
        ).statusCode,
      ).toBe(403);
      // An admin may act on a moderator, but not on another admin.
      expect(
        (
          await act(admin, {
            action: 'HIDE_CONTENT',
            targetType: 'POST',
            targetId: modPost.id,
            note: 'x',
          })
        ).statusCode,
      ).toBe(201);
      expect(
        (
          await act(admin, {
            action: 'SUSPEND_USER',
            targetType: 'USER',
            targetId: admin.id,
            note: 'x',
          })
        ).statusCode,
      ).toBe(403);

      // Verification: admin only, needs a creator profile and a status.
      const creator = await signupUser(t);
      const verify = (staff: TestUser, extra: Record<string, unknown> = {}) =>
        act(staff, {
          action: 'SET_CREATOR_VERIFICATION',
          targetType: 'USER',
          targetId: creator.id,
          note: 'checked ID',
          ...extra,
        });
      expect((await verify(admin, { verificationStatus: 'VERIFIED' })).statusCode).toBe(409); // no profile
      await api(t, creator).put('/me/creator', { category: 'COACH' });
      expect(errorCode(await verify(mod, { verificationStatus: 'VERIFIED' }))).toBe(
        'INSUFFICIENT_ROLE',
      );
      expect((await verify(admin)).statusCode).toBe(422); // status required
      const done = await verify(admin, { verificationStatus: 'VERIFIED' });
      expect(done.statusCode, done.body).toBe(201);
      expect(
        (await api(t, creator).get(`/users/${creator.id}`)).json<{
          creator: { verified: boolean };
        }>().creator.verified,
      ).toBe(true);
      await verify(admin, { verificationStatus: 'NONE' });
      expect(
        (await api(t, creator).get(`/users/${creator.id}`)).json<{
          creator: { verified: boolean };
        }>().creator.verified,
      ).toBe(false);
    });
  });

  describe('acting on reports', () => {
    it('hides a post: it vanishes for others, the author sees why, reports settle, and it is audited', async () => {
      const author = await signupUser(t);
      const fan = await signupUser(t);
      const r1 = await signupUser(t);
      const r2 = await signupUser(t);
      const mod = await makeStaff('MODERATOR');
      await follow(t, fan, author);
      const post = await pub(author, 'questionable');
      const first = (await report(r1, 'POST', post.id, 'VIOLENCE')).json<{ id: string }>();
      const second = (await report(r2, 'POST', post.id, 'SPAM')).json<{ id: string }>();

      const open = await queue(mod, '?status=OPEN');
      expect(open.items.map((r) => r.id)).toEqual([first.id, second.id]); // oldest first
      expect(open.items[0]?.reportCount).toBe(2);
      expect(open.items[0]?.target.text).toBe('questionable');

      // A note is mandatory for anything but a dismissal.
      expect((await resolve(mod, first.id, { action: 'HIDE_CONTENT' })).statusCode).toBe(422);
      const res = await resolve(mod, first.id, {
        action: 'HIDE_CONTENT',
        note: 'graphic violence',
      });
      expect(res.statusCode, res.body).toBe(200);
      const detail = res.json<ReportDetail>();
      expect(detail).toMatchObject({ status: 'ACTIONED', resolutionNote: 'graphic violence' });
      expect(detail.resolvedBy?.id).toBe(mod.id);
      expect(detail.target.moderationStatus).toBe('HIDDEN');
      expect(detail.actions[0]).toMatchObject({
        action: 'HIDE_CONTENT',
        metadata: { from: 'CLEAN', to: 'HIDDEN' },
      });
      expect(detail.actions[0]?.actor?.id).toBe(mod.id);

      // Every other open report about the same content is settled too.
      expect((await queue(mod, '?status=OPEN')).items).toEqual([]);
      expect(
        (await api(t, mod).get(`/admin/reports/${second.id}`)).json<ReportDetail>().status,
      ).toBe('ACTIONED');

      // Gone for the audience, visible (with its state) to the author.
      expect((await api(t, fan).get(`/posts/${post.id}`)).statusCode).toBe(404);
      expect((await api(t, fan).get('/feed/following')).json<Page<unknown>>().items).toEqual([]);
      const own = (await api(t, author).get(`/posts/${post.id}`)).json<{
        moderationStatus: string;
      }>();
      expect(own.moderationStatus).toBe('HIDDEN');

      // The author is told, without learning who did it or what they wrote.
      const notice = (await notificationsOf(author)).find((n) => n.type === 'MODERATION_ACTION');
      expect(notice?.actor).toBeNull();
      expect(notice?.data).toMatchObject({ action: 'HIDE_CONTENT', targetType: 'POST' });
      expect(JSON.stringify(notice)).not.toContain('graphic violence');

      // Resolving again is refused; hiding twice is refused; restoring brings it back.
      expect(errorCode(await resolve(mod, first.id, { action: 'DISMISS_REPORT' }))).toBe(
        'INVALID_STATE',
      );
      const direct = (body: Record<string, unknown>) =>
        api(t, mod).post('/admin/moderation/actions', {
          targetType: 'POST',
          targetId: post.id,
          note: 'n',
          ...body,
        });
      expect(errorCode(await direct({ action: 'HIDE_CONTENT' }))).toBe('INVALID_STATE');
      expect((await direct({ action: 'RESTORE_CONTENT' })).statusCode).toBe(201);
      expect((await api(t, fan).get(`/posts/${post.id}`)).statusCode).toBe(200);
      expect(errorCode(await direct({ action: 'RESTORE_CONTENT' }))).toBe('INVALID_STATE');

      const trail = (
        await api(t, mod).get(`/admin/moderation/actions?targetType=POST&targetId=${post.id}`)
      ).json<Page<{ action: string }>>();
      expect(trail.items.map((a) => a.action)).toEqual(['RESTORE_CONTENT', 'HIDE_CONTENT']);
    });

    it('removes a comment, which also drops it from the post counts', async () => {
      const author = await signupUser(t);
      const rude = await signupUser(t);
      const reporter = await signupUser(t);
      const mod = await makeStaff('MODERATOR');
      const post = await pub(author);
      const comment = (
        await api(t, rude).post(`/posts/${post.id}/comments`, { body: 'you are awful' })
      ).json<{ id: string }>();
      await api(t, author).post(`/posts/${post.id}/comments`, { body: 'thanks all' });
      const count = async () =>
        (await api(t, reporter).get(`/posts/${post.id}`)).json<{ counts: { comments: number } }>()
          .counts.comments;
      expect(await count()).toBe(2);

      const filed = (await report(reporter, 'COMMENT', comment.id, 'HARASSMENT')).json<{
        id: string;
      }>();
      expect(
        (await resolve(mod, filed.id, { action: 'REMOVE_CONTENT', note: 'abuse' })).statusCode,
      ).toBe(200);
      expect(await count()).toBe(1);
      const listed = (await api(t, reporter).get(`/posts/${post.id}/comments`)).json<
        Page<{ id: string }>
      >();
      expect(listed.items.map((c) => c.id)).not.toContain(comment.id);
      expect((await notificationsOf(rude)).some((n) => n.type === 'MODERATION_ACTION')).toBe(true);
    });

    it('warns a user (the note is the message), without touching their content', async () => {
      const author = await signupUser(t);
      const reporter = await signupUser(t);
      const mod = await makeStaff('MODERATOR');
      const post = await pub(author);
      const filed = (await report(reporter, 'POST', post.id)).json<{ id: string }>();
      expect(
        (await resolve(mod, filed.id, { action: 'WARN_USER', note: 'Please keep it civil.' }))
          .statusCode,
      ).toBe(200);
      const notice = (await notificationsOf(author)).find((n) => n.type === 'MODERATION_ACTION');
      expect(notice?.data).toMatchObject({ action: 'WARN_USER', message: 'Please keep it civil.' });
      expect((await api(t, reporter).get(`/posts/${post.id}`)).statusCode).toBe(200);
    });

    it('suspends and unsuspends: immediate lockout, content disappears, login refused', async () => {
      const bad = await signupUser(t);
      const fan = await signupUser(t);
      const reporter = await signupUser(t);
      const mod = await makeStaff('MODERATOR');
      await follow(t, fan, bad);
      const post = await pub(bad);
      expect((await api(t, fan).get(`/posts/${post.id}`)).statusCode).toBe(200);

      const filed = (await report(reporter, 'USER', bad.id, 'HARASSMENT')).json<{ id: string }>();
      const done = await resolve(mod, filed.id, { action: 'SUSPEND_USER', note: 'repeat abuse' });
      expect(done.statusCode, done.body).toBe(200);
      expect(done.json<ReportDetail>().target.userStatus).toBe('SUSPENDED');

      // Their still-valid token stops working at once.
      const blocked = await api(t, bad).get('/notifications');
      expect([blocked.statusCode, errorCode(blocked)]).toEqual([403, 'ACCOUNT_SUSPENDED']);
      const login = await api(t).post('/auth/login', { email: bad.email, password: bad.password });
      expect(errorCode(login)).toBe('ACCOUNT_SUSPENDED');
      // And everything they published is gone for everyone else.
      expect((await api(t, fan).get(`/posts/${post.id}`)).statusCode).toBe(404);
      expect((await api(t, fan).get(`/users/${bad.id}`)).statusCode).toBe(404);

      // Suspending twice is refused; unsuspending restores everything.
      const again = await api(t, mod).post('/admin/moderation/actions', {
        action: 'SUSPEND_USER',
        targetType: 'USER',
        targetId: bad.id,
        note: 'again',
      });
      expect(errorCode(again)).toBe('INVALID_STATE');
      const lift = await api(t, mod).post('/admin/moderation/actions', {
        action: 'UNSUSPEND_USER',
        targetType: 'USER',
        targetId: bad.id,
        note: 'appeal upheld',
      });
      expect(lift.statusCode).toBe(201);
      expect((await api(t, bad).get('/notifications')).statusCode).toBe(200);
      expect((await api(t, fan).get(`/posts/${post.id}`)).statusCode).toBe(200);
    });

    it('dismisses without side effects, leaving other reports open', async () => {
      const author = await signupUser(t);
      const r1 = await signupUser(t);
      const r2 = await signupUser(t);
      const mod = await makeStaff('MODERATOR');
      const post = await pub(author);
      const one = (await report(r1, 'POST', post.id)).json<{ id: string }>();
      await report(r2, 'POST', post.id);

      const res = await resolve(mod, one.id, { action: 'DISMISS_REPORT' }); // note optional
      expect(res.json<ReportDetail>()).toMatchObject({ status: 'DISMISSED' });
      expect((await queue(mod, '?status=OPEN')).items).toHaveLength(1);
      expect(
        (await api(t, r1).get('/me/reports')).json<Page<{ status: string }>>().items[0]?.status,
      ).toBe('DISMISSED');
      expect(
        (await api(t, author).get(`/posts/${post.id}`)).json<{ moderationStatus: string }>()
          .moderationStatus,
      ).toBe('CLEAN');
      expect(errorCode(await resolve(mod, 'x', { action: 'DISMISS_REPORT' }))).toBe(
        'VALIDATION_FAILED',
      );
    });

    it('rejects actions that do not fit the target', async () => {
      const mod = await makeStaff('MODERATOR');
      const user = await signupUser(t);
      const reporter = await signupUser(t);
      const filed = (await report(reporter, 'USER', user.id)).json<{ id: string }>();
      // Content actions make no sense on an account report.
      expect(errorCode(await resolve(mod, filed.id, { action: 'HIDE_CONTENT', note: 'n' }))).toBe(
        'INVALID_STATE',
      );
      const direct = (body: Record<string, unknown>) =>
        api(t, mod).post('/admin/moderation/actions', body);
      expect(
        (await direct({ action: 'HIDE_CONTENT', targetType: 'USER', targetId: user.id, note: 'n' }))
          .statusCode,
      ).toBe(422);
      expect(
        (await direct({ action: 'SUSPEND_USER', targetType: 'POST', targetId: user.id, note: 'n' }))
          .statusCode,
      ).toBe(422);
      expect(
        errorCode(
          await direct({
            action: 'SUSPEND_USER',
            targetType: 'USER',
            targetId: '018f0000-0000-7000-8000-000000000000',
            note: 'n',
          }),
        ),
      ).toBe('USER_NOT_FOUND');
      expect(
        errorCode(await api(t, mod).get('/admin/reports/018f0000-0000-7000-8000-000000000000')),
      ).toBe('REPORT_NOT_FOUND');
      // Nothing above changed anything.
      expect((await api(t, user).get('/notifications')).statusCode).toBe(200);
    });
  });

  describe('the queue', () => {
    it('filters, pages in order, and shows the reported content as the public would see it', async () => {
      const author = await signupUser(t);
      const mod = await makeStaff('MODERATOR');
      const reporters = await Promise.all(Array.from({ length: 5 }, () => signupUser(t)));
      const posts = [await pub(author, 'one'), await pub(author, 'two')];
      const comment = (
        await api(t, author).post(`/posts/${posts[0]?.id}/comments`, { body: 'hello' })
      ).json<{ id: string }>();
      for (const [i, r] of reporters.entries()) {
        await report(
          r,
          i < 3 ? 'POST' : 'USER',
          i < 3 ? (posts[i % 2]?.id as string) : author.id,
          i % 2 ? 'SPAM' : 'HARASSMENT',
        );
      }
      await report(reporters[0] as TestUser, 'COMMENT', comment.id);

      const everything: string[] = [];
      let cursor: string | null = null;
      do {
        const page: Page<Report> = await queue(mod, `?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
        everything.push(...page.items.map((r) => r.id));
        cursor = page.nextCursor;
      } while (cursor);
      expect(everything).toHaveLength(6);
      expect([...everything].sort()).toEqual(everything); // ids are time-ordered: oldest first

      expect((await queue(mod, '?targetType=USER')).items).toHaveLength(2);
      expect(
        (await queue(mod, '?reason=HARASSMENT')).items.every((r) => r.reason === 'HARASSMENT'),
      ).toBe(true);
      expect((await queue(mod, '?source=AUTOMATED')).items).toEqual([]);

      const [firstPostReport] = (await queue(mod, '?targetType=POST')).items;
      const detail = (
        await api(t, mod).get(`/admin/reports/${firstPostReport?.id}`)
      ).json<ReportDetail>();
      expect(detail.post?.id).toBe(firstPostReport?.target.id);
      expect(detail.target.author?.id).toBe(author.id);
    });

    it('keeps the text as it was when reported, even if the author edits or deletes it', async () => {
      const author = await signupUser(t);
      const reporter = await signupUser(t);
      const mod = await makeStaff('MODERATOR');
      const post = await pub(author, 'original wording');
      const filed = (await report(reporter, 'POST', post.id)).json<{ id: string }>();
      await api(t, author).patch(`/posts/${post.id}`, { caption: 'harmless now' });
      expect(
        (await api(t, mod).get(`/admin/reports/${filed.id}`)).json<ReportDetail>().target.text,
      ).toBe('original wording');
      await api(t, author).del(`/posts/${post.id}`);
      const after = (await api(t, mod).get(`/admin/reports/${filed.id}`)).json<ReportDetail>();
      expect(after.target.exists).toBe(false);
      expect(after.target.text).toBe('original wording');
    });
  });

  describe('audit trail', () => {
    it('is append-only at the database level, and survives the death of its subjects', async () => {
      const author = await signupUser(t);
      const mod = await makeStaff('MODERATOR');
      const post = await pub(author);
      await api(t, mod).post('/admin/moderation/actions', {
        action: 'HIDE_CONTENT',
        targetType: 'POST',
        targetId: post.id,
        note: 'test',
      });
      const row = await t.platform.db
        .selectFrom('moderationActions')
        .selectAll()
        .executeTakeFirstOrThrow();

      const attempt = (sql: string) => t.platform.pool.query(sql);
      await expect(attempt(`update moderation_actions set note = 'tampered'`)).rejects.toThrow(
        /append-only/,
      );
      await expect(attempt(`delete from moderation_actions`)).rejects.toThrow(/append-only/);
      await expect(attempt(`truncate moderation_actions`)).rejects.toThrow(/append-only/);

      // Deleting the post, the author and the moderator leaves the record intact.
      await t.platform.db.deleteFrom('posts').where('id', '=', post.id).execute();
      await t.platform.db.deleteFrom('users').where('id', 'in', [author.id, mod.id]).execute();
      const still = await t.platform.db.selectFrom('moderationActions').selectAll().execute();
      expect(still).toHaveLength(1);
      expect(still[0]).toMatchObject({ id: row.id, actorId: mod.id, targetPostId: post.id });
    });
  });

  describe('automated moderation', () => {
    it('queues FLAG verdicts as automated reports and rejects BLOCK verdicts', async () => {
      await t.close();
      t = await createTestApp({
        env: { MODERATION_FLAG_TERMS: 'sketchy, dodgy offer', MODERATION_BLOCK_TERMS: 'forbidden' },
      });
      const author = await signupUser(t);
      const other = await signupUser(t);
      const mod = await makeStaff('MODERATOR');

      // FLAG: published normally, but a human is asked to look.
      const flagged = await pub(author, 'This is a SKETCHY deal');
      expect((await api(t, other).get(`/posts/${flagged.id}`)).statusCode).toBe(200);
      let auto = await queue(mod, '?source=AUTOMATED');
      expect(auto.items).toHaveLength(1);
      expect(auto.items[0]).toMatchObject({
        source: 'AUTOMATED',
        reason: 'OTHER',
        reporter: null,
        status: 'OPEN',
      });
      expect(auto.items[0]?.target.text).toBe('This is a SKETCHY deal');

      // Editing it again does not pile up duplicates; a clean edit is fine.
      await api(t, author).patch(`/posts/${flagged.id}`, { caption: 'still sketchy!' });
      expect((await queue(mod, '?source=AUTOMATED')).items).toHaveLength(1);

      // Comments and profile text are covered too.
      await api(t, other).post(`/posts/${flagged.id}/comments`, { body: 'dodgy offer here' });
      await api(t, other).patch('/me/profile', { bio: 'sketchy bio' });
      auto = await queue(mod, '?source=AUTOMATED');
      expect(auto.items.map((r) => r.target.type).sort()).toEqual(['COMMENT', 'POST', 'USER']);

      // Whole words only, accents and case ignored.
      await pub(author, 'sketchyness is not a flagged word');
      await pub(author, 'SKÉTCHY would be flagged though');
      expect((await queue(mod, '?source=AUTOMATED')).items).toHaveLength(4);

      // BLOCK: refused outright, nothing stored.
      const refused = await api(t, author).post('/posts', {
        caption: 'a forbidden word',
        visibility: 'PUBLIC',
      });
      expect([refused.statusCode, errorCode(refused)]).toEqual([422, 'CONTENT_REJECTED']);
      expect(
        errorCode(
          await api(t, other).post(`/posts/${flagged.id}/comments`, { body: 'FORBIDDEN!' }),
        ),
      ).toBe('CONTENT_REJECTED');
      expect(errorCode(await api(t, other).patch('/me/profile', { bio: 'forbidden' }))).toBe(
        'CONTENT_REJECTED',
      );
      expect(
        await t.platform.db
          .selectFrom('posts')
          .select('caption')
          .where('caption', 'like', '%forbidden%')
          .execute(),
      ).toEqual([]);
    });

    it('KeywordModerator: whole-word, case/accent-insensitive, block beats flag, empty lists allow all', async () => {
      const m = new KeywordModerator(['Bad Word', 'c++'], ['maybe']);
      const verdict = async (text: string) =>
        (await m.moderateText({ text, context: 'CAPTION' })).verdict;
      expect(await verdict('a BAD   word')).toBe('BLOCK'); // whitespace is collapsed
      expect(await verdict('a bad word here')).toBe('BLOCK');
      expect(await verdict('I love C++!')).toBe('BLOCK'); // regex metacharacters are literal
      expect(await verdict('badwords')).toBe('ALLOW');
      expect(await verdict('MÁYBE not')).toBe('FLAG'); // accents are ignored
      expect(await verdict('Maybe not')).toBe('FLAG');
      expect(await verdict('maybe bad word')).toBe('BLOCK');
      expect(
        (await new KeywordModerator([], []).moderateText({ text: 'anything', context: 'COMMENT' }))
          .verdict,
      ).toBe('ALLOW');
      expect((await m.moderateImage({ filePath: '/x', ownerId: 'y' })).verdict).toBe('ALLOW');
    });
  });
});
