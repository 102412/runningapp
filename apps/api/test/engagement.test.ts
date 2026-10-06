import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AllowAllModerator } from '../src/platform/ports/content-moderation';
import { api, errorCode, signupUser, type TestUser } from './helpers/api';
import { createTestApp, type TestApp } from './helpers/app';
import { createPost, follow } from './helpers/posts';

describe('engagement', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  const postCounts = async (postId: string) =>
    t.platform.db
      .selectFrom('posts')
      .select(['reactionCount', 'commentCount', 'bookmarkCount', 'shareCount'])
      .where('id', '=', postId)
      .executeTakeFirstOrThrow();

  describe('reactions', () => {
    it('are idempotent, changeable, removable, and reflected in viewer state and counts', async () => {
      const author = await signupUser(t);
      const fan = await signupUser(t);
      const post = await createPost(t, author);

      const first = await api(t, fan).put(`/posts/${post.id}/reaction`, { type: 'LIKE' });
      expect(first.json()).toEqual({ reaction: 'LIKE', reactionCount: 1 });
      expect(
        (await api(t, fan).put(`/posts/${post.id}/reaction`, { type: 'LIKE' })).json()
          .reactionCount,
      ).toBe(1);
      expect((await api(t, fan).put(`/posts/${post.id}/reaction`, {})).json()).toEqual({
        reaction: 'LIKE',
        reactionCount: 1,
      }); // default type
      expect(
        (await api(t, fan).put(`/posts/${post.id}/reaction`, { type: 'FIRE' })).json(),
      ).toEqual({ reaction: 'FIRE', reactionCount: 1 });

      const seen = (await api(t, fan).get(`/posts/${post.id}`)).json();
      expect(seen.viewer.reaction).toBe('FIRE');
      expect(seen.counts.reactions).toBe(1);

      expect((await api(t, fan).del(`/posts/${post.id}/reaction`)).json()).toEqual({
        reaction: null,
        reactionCount: 0,
      });
      expect((await api(t, fan).del(`/posts/${post.id}/reaction`)).json()).toEqual({
        reaction: null,
        reactionCount: 0,
      }); // idempotent
      expect(errorCode(await api(t, fan).put(`/posts/${post.id}/reaction`, { type: 'BOO' }))).toBe(
        'VALIDATION_FAILED',
      );
    });

    it('duplicate and concurrent reactions never corrupt counts', async () => {
      const author = await signupUser(t);
      const post = await createPost(t, author);
      const fans = await Promise.all(Array.from({ length: 10 }, () => signupUser(t)));
      // Every fan fires 3 identical requests at once, all fans in parallel.
      await Promise.all(
        fans.flatMap((f) =>
          [1, 2, 3].map(() => api(t, f).put(`/posts/${post.id}/reaction`, { type: 'LIKE' })),
        ),
      );
      expect((await postCounts(post.id)).reactionCount).toBe(10);
      const rows = await t.platform.db
        .selectFrom('postReactions')
        .select('userId')
        .where('postId', '=', post.id)
        .execute();
      expect(rows).toHaveLength(10);
      // Half unreact concurrently, with duplicates.
      await Promise.all(
        fans
          .slice(0, 5)
          .flatMap((f) => [1, 2].map(() => api(t, f).del(`/posts/${post.id}/reaction`))),
      );
      expect((await postCounts(post.id)).reactionCount).toBe(5);
    });

    it('notify the author once (never for self), and the notification disappears when un-reacted', async () => {
      const author = await signupUser(t);
      const fan = await signupUser(t);
      const post = await createPost(t, author);
      await api(t, fan).put(`/posts/${post.id}/reaction`, { type: 'LIKE' });
      await api(t, fan).put(`/posts/${post.id}/reaction`, { type: 'CLAP' });
      await api(t, author).put(`/posts/${post.id}/reaction`, { type: 'LIKE' });
      const notes = await t.platform.db
        .selectFrom('notifications')
        .select(['recipientId', 'type'])
        .where('postId', '=', post.id)
        .execute();
      expect(notes).toEqual([{ recipientId: author.id, type: 'POST_REACTION' }]); // one, from fan; none to self
      await api(t, fan).del(`/posts/${post.id}/reaction`);
      expect(
        await t.platform.db
          .selectFrom('notifications')
          .select('id')
          .where('postId', '=', post.id)
          .execute(),
      ).toEqual([]);
    });

    it('cannot target posts the viewer cannot see: private, followers-only, blocked, draft, hidden, deleted', async () => {
      const author = await signupUser(t);
      const stranger = await signupUser(t);
      const blocked = await signupUser(t);
      await api(t, author).put(`/users/${blocked.id}/block`);
      const priv = await createPost(t, author, { caption: 'p', visibility: 'PRIVATE' });
      const fol = await createPost(t, author, { caption: 'f', visibility: 'FOLLOWERS' });
      const pub = await createPost(t, author, { caption: 'pub' });
      const draft = await createPost(t, author, { caption: 'd', publish: false });
      const react = (u: TestUser, id: string) =>
        api(t, u).put(`/posts/${id}/reaction`, { type: 'LIKE' });

      for (const id of [priv.id, fol.id])
        expect(errorCode(await react(stranger, id))).toBe('POST_NOT_FOUND');
      expect(errorCode(await react(blocked, pub.id))).toBe('POST_NOT_FOUND');
      expect(errorCode(await react(author, draft.id))).toBe('POST_NOT_FOUND'); // even the author cannot react to a draft
      expect((await react(stranger, pub.id)).statusCode).toBe(200);
      await t.platform.db
        .updateTable('posts')
        .set({ moderationStatus: 'HIDDEN' })
        .where('id', '=', pub.id)
        .execute();
      expect(errorCode(await react(stranger, pub.id))).toBe('POST_NOT_FOUND');
      await t.platform.db
        .updateTable('posts')
        .set({ moderationStatus: 'CLEAN' })
        .where('id', '=', pub.id)
        .execute();
      await api(t, author).del(`/posts/${pub.id}`);
      expect(errorCode(await react(stranger, pub.id))).toBe('POST_NOT_FOUND');
    });

    it('lists reactors, hiding blocked users, with a stable cursor', async () => {
      const author = await signupUser(t);
      const viewer = await signupUser(t);
      const post = await createPost(t, author);
      const fans = await Promise.all(Array.from({ length: 5 }, () => signupUser(t)));
      for (const f of fans) await api(t, f).put(`/posts/${post.id}/reaction`, { type: 'LIKE' });
      await api(t, viewer).put(`/users/${fans[0]?.id}/block`);

      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page = await api(t, viewer).get(
          `/posts/${post.id}/reactions?limit=2${cursor ? `&cursor=${cursor}` : ''}`,
        );
        const body: { items: Array<{ user: { id: string } }>; nextCursor: string | null } =
          page.json();
        seen.push(...body.items.map((i) => i.user.id));
        cursor = body.nextCursor;
      } while (cursor);
      expect(seen).toHaveLength(4);
      expect(seen).not.toContain(fans[0]?.id);
      expect(new Set(seen).size).toBe(4);
    });
  });

  describe('bookmarks', () => {
    it('save privately, list newest-saved first, and drop posts that stop being visible', async () => {
      const author = await signupUser(t);
      const reader = await signupUser(t);
      const a = await createPost(t, author, { caption: 'a' });
      const b = await createPost(t, author, { caption: 'b' });
      expect((await api(t, reader).put(`/posts/${a.id}/bookmark`)).json()).toEqual({
        bookmarked: true,
      });
      await api(t, reader).put(`/posts/${a.id}/bookmark`); // idempotent
      await api(t, reader).put(`/posts/${b.id}/bookmark`);

      const mine = (await api(t, reader).get('/me/bookmarks')).json();
      expect(mine.items.map((p: { id: string }) => p.id)).toEqual([b.id, a.id]);
      expect(mine.items[0].viewer.bookmarked).toBe(true);
      expect((await postCounts(a.id)).bookmarkCount).toBe(1);
      expect((await api(t, author).get(`/posts/${a.id}`)).json().counts.bookmarks).toBe(1); // author sees the count...
      expect((await api(t, reader).get(`/posts/${a.id}`)).json().counts.bookmarks).toBeNull(); // ...nobody else does

      await api(t, author).patch(`/posts/${a.id}`, { visibility: 'PRIVATE' });
      expect(
        (await api(t, reader).get('/me/bookmarks')).json().items.map((p: { id: string }) => p.id),
      ).toEqual([b.id]);
      expect((await api(t, reader).del(`/posts/${b.id}/bookmark`)).json()).toEqual({
        bookmarked: false,
      });
      expect((await api(t, reader).del(`/posts/${b.id}/bookmark`)).statusCode).toBe(200);
      expect((await postCounts(b.id)).bookmarkCount).toBe(0);
    });

    it('cannot bookmark invisible posts', async () => {
      const author = await signupUser(t);
      const stranger = await signupUser(t);
      const priv = await createPost(t, author, { visibility: 'PRIVATE', caption: 'p' });
      expect(errorCode(await api(t, stranger).put(`/posts/${priv.id}/bookmark`))).toBe(
        'POST_NOT_FOUND',
      );
    });
  });

  describe('shares', () => {
    it('record each share event and bump the count', async () => {
      const author = await signupUser(t);
      const sharer = await signupUser(t);
      const post = await createPost(t, author);
      expect(
        (await api(t, sharer).post(`/posts/${post.id}/shares`, { channel: 'COPY_LINK' })).json(),
      ).toEqual({ shareCount: 1 });
      expect(
        (await api(t, sharer).post(`/posts/${post.id}/shares`, { channel: 'SYSTEM_SHARE' })).json(),
      ).toEqual({ shareCount: 2 });
      expect(
        errorCode(
          await api(t, sharer).post(`/posts/${post.id}/shares`, { channel: 'CARRIER_PIGEON' }),
        ),
      ).toBe('VALIDATION_FAILED');
      expect((await api(t, author).get(`/posts/${post.id}`)).json().counts.shares).toBe(2);
      const priv = await createPost(t, author, { visibility: 'PRIVATE', caption: 'p' });
      expect(
        errorCode(await api(t, sharer).post(`/posts/${priv.id}/shares`, { channel: 'COPY_LINK' })),
      ).toBe('POST_NOT_FOUND');
    });
  });

  describe('comments', () => {
    it('creates, lists (newest/oldest) with cursors, and keeps counts right', async () => {
      const author = await signupUser(t);
      const a = await signupUser(t);
      const post = await createPost(t, author);
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const res = await api(t, a).post(`/posts/${post.id}/comments`, { body: `comment ${i}` });
        expect(res.statusCode).toBe(201);
        ids.push(res.json().id as string);
      }
      expect((await postCounts(post.id)).commentCount).toBe(5);
      expect((await api(t, a).get(`/posts/${post.id}`)).json().counts.comments).toBe(5);

      const newest: string[] = [];
      let cursor: string | null = null;
      do {
        const page = await api(t, a).get(
          `/posts/${post.id}/comments?limit=2${cursor ? `&cursor=${cursor}` : ''}`,
        );
        const body: { items: Array<{ id: string }>; nextCursor: string | null } = page.json();
        newest.push(...body.items.map((c) => c.id));
        cursor = body.nextCursor;
      } while (cursor);
      expect(newest).toEqual([...ids].reverse());
      const oldest = (await api(t, a).get(`/posts/${post.id}/comments?order=OLDEST`)).json();
      expect(oldest.items.map((c: { id: string }) => c.id)).toEqual(ids);
      expect(oldest.items[0]).toMatchObject({
        body: 'comment 0',
        parentId: null,
        replyTo: null,
        counts: { reactions: 0, replies: 0 },
        viewer: { isAuthor: true, canDelete: true },
      });
    });

    it('supports two-level threads: replies to replies attach to the root and address the right person', async () => {
      const author = await signupUser(t);
      const alice = await signupUser(t);
      const bob = await signupUser(t);
      const post = await createPost(t, author);
      const root = (
        await api(t, alice).post(`/posts/${post.id}/comments`, { body: 'root' })
      ).json();
      const reply = (
        await api(t, bob).post(`/posts/${post.id}/comments`, {
          body: 'reply to alice',
          parentId: root.id,
        })
      ).json();
      expect(reply).toMatchObject({
        parentId: root.id,
        replyTo: { id: alice.id, username: alice.username },
      });
      const nested = (
        await api(t, alice).post(`/posts/${post.id}/comments`, {
          body: 'reply to bob',
          parentId: reply.id,
        })
      ).json();
      expect(nested).toMatchObject({
        parentId: root.id,
        replyTo: { id: bob.id, username: bob.username },
      }); // flattened to the root

      expect((await postCounts(post.id)).commentCount).toBe(3);
      const top = (await api(t, alice).get(`/posts/${post.id}/comments`)).json();
      expect(top.items).toHaveLength(1);
      expect(top.items[0].counts.replies).toBe(2);
      const replies = (await api(t, alice).get(`/comments/${root.id}/replies`)).json();
      expect(replies.items.map((c: { id: string }) => c.id)).toEqual([reply.id, nested.id]); // oldest first
      // The database refuses a third level even if the API were bypassed.
      await expect(
        t.platform.db
          .insertInto('comments')
          .values({ postId: post.id, authorId: bob.id, parentId: reply.id, body: 'x' })
          .execute(),
      ).rejects.toThrow(/replies must target a top-level comment/);
    });

    it("rejects replies pointing at another post's comment or a missing comment", async () => {
      const u = await signupUser(t);
      const p1 = await createPost(t, u, { caption: '1' });
      const p2 = await createPost(t, u, { caption: '2' });
      const c1 = (await api(t, u).post(`/posts/${p1.id}/comments`, { body: 'c1' })).json();
      expect(
        errorCode(await api(t, u).post(`/posts/${p2.id}/comments`, { body: 'x', parentId: c1.id })),
      ).toBe('COMMENT_NOT_FOUND');
      expect(
        errorCode(
          await api(t, u).post(`/posts/${p2.id}/comments`, {
            body: 'x',
            parentId: '018f0000-0000-7000-8000-000000000000',
          }),
        ),
      ).toBe('COMMENT_NOT_FOUND');
    });

    it('enforces the comment permission matrix', async () => {
      const author = await signupUser(t);
      const follower = await signupUser(t);
      const stranger = await signupUser(t);
      await follow(t, follower, author);
      const everyone = await createPost(t, author, { caption: 'e', commentPermission: 'EVERYONE' });
      const followers = await createPost(t, author, {
        caption: 'f',
        commentPermission: 'FOLLOWERS',
      });
      const nobody = await createPost(t, author, { caption: 'n', commentPermission: 'NOBODY' });
      const attempt = async (u: TestUser, id: string) => {
        const res = await api(t, u).post(`/posts/${id}/comments`, { body: 'hi' });
        return res.statusCode === 201 ? 201 : errorCode(res);
      };
      expect([
        await attempt(stranger, everyone.id),
        await attempt(follower, everyone.id),
        await attempt(author, everyone.id),
      ]).toEqual([201, 201, 201]);
      expect([
        await attempt(stranger, followers.id),
        await attempt(follower, followers.id),
        await attempt(author, followers.id),
      ]).toEqual(['COMMENTS_RESTRICTED', 201, 201]);
      expect([
        await attempt(stranger, nobody.id),
        await attempt(follower, nobody.id),
        await attempt(author, nobody.id),
      ]).toEqual(['COMMENTS_RESTRICTED', 'COMMENTS_RESTRICTED', 'COMMENTS_RESTRICTED']);
      // The view tells clients in advance.
      expect((await api(t, stranger).get(`/posts/${followers.id}`)).json().viewer.canComment).toBe(
        false,
      );
      expect((await api(t, follower).get(`/posts/${followers.id}`)).json().viewer.canComment).toBe(
        true,
      );
    });

    it('requires a verified email, valid bodies, and a visible post', async () => {
      const author = await signupUser(t);
      const unverified = await signupUser(t, { verified: false });
      const stranger = await signupUser(t);
      const priv = await createPost(t, author, { caption: 'p', visibility: 'PRIVATE' });
      const post = await createPost(t, author);
      expect(
        errorCode(await api(t, unverified).post(`/posts/${post.id}/comments`, { body: 'hi' })),
      ).toBe('EMAIL_NOT_VERIFIED');
      expect(
        errorCode(await api(t, stranger).post(`/posts/${post.id}/comments`, { body: '   ' })),
      ).toBe('VALIDATION_FAILED');
      expect(
        errorCode(
          await api(t, stranger).post(`/posts/${post.id}/comments`, { body: 'x'.repeat(1001) }),
        ),
      ).toBe('VALIDATION_FAILED');
      expect(
        errorCode(await api(t, stranger).post(`/posts/${priv.id}/comments`, { body: 'hi' })),
      ).toBe('POST_NOT_FOUND');
      expect(
        errorCode(
          await api(t, stranger).post(`/posts/${post.id}/comments`, {
            body: 'hi',
            authorId: author.id,
          }),
        ),
      ).toBe('VALIDATION_FAILED');
    });

    it('lets the comment author and the post author delete (taking replies along), nobody else', async () => {
      const author = await signupUser(t);
      const alice = await signupUser(t);
      const bob = await signupUser(t);
      const post = await createPost(t, author);
      const root = (
        await api(t, alice).post(`/posts/${post.id}/comments`, { body: 'root' })
      ).json();
      const reply = (
        await api(t, bob).post(`/posts/${post.id}/comments`, { body: 'reply', parentId: root.id })
      ).json();
      expect((await postCounts(post.id)).commentCount).toBe(2);

      const denied = await api(t, bob).del(`/comments/${root.id}`);
      expect(denied.statusCode).toBe(403);
      expect(errorCode(denied)).toBe('FORBIDDEN');
      expect((await api(t, alice).del(`/comments/${root.id}`)).statusCode).toBe(204); // author: whole thread goes
      expect((await postCounts(post.id)).commentCount).toBe(0);
      expect((await api(t, bob).get(`/posts/${post.id}/comments`)).json().items).toEqual([]);
      expect(errorCode(await api(t, bob).get(`/comments/${root.id}/replies`))).toBe(
        'COMMENT_NOT_FOUND',
      );
      expect(errorCode(await api(t, alice).del(`/comments/${root.id}`))).toBe('COMMENT_NOT_FOUND');

      const c2 = (await api(t, alice).post(`/posts/${post.id}/comments`, { body: 'again' })).json();
      expect((await api(t, author).del(`/comments/${c2.id}`)).statusCode).toBe(204); // post author moderates their own thread
      expect((await postCounts(post.id)).commentCount).toBe(0);
      expect(
        await t.platform.db
          .selectFrom('notifications')
          .select('id')
          .where('commentId', 'in', [root.id, reply.id, c2.id])
          .execute(),
      ).toEqual([]);
    });

    it("hides comments across blocks in both directions, and blocks cannot comment on the blocker's posts", async () => {
      const author = await signupUser(t);
      const viewer = await signupUser(t);
      const troll = await signupUser(t);
      const post = await createPost(t, author);
      await api(t, troll).post(`/posts/${post.id}/comments`, { body: 'nasty' });
      await api(t, author).post(`/posts/${post.id}/comments`, { body: 'nice' });
      expect((await api(t, viewer).get(`/posts/${post.id}/comments`)).json().items).toHaveLength(2);

      await api(t, viewer).put(`/users/${troll.id}/block`);
      const afterBlock = (await api(t, viewer).get(`/posts/${post.id}/comments`)).json();
      expect(afterBlock.items.map((c: { body: string }) => c.body)).toEqual(['nice']);
      const trollView = (await api(t, troll).get(`/posts/${post.id}/comments`)).json(); // blocked-by: also hidden from the troll's side
      expect(trollView.items.map((c: { author: { id: string } }) => c.author.id)).toContain(
        troll.id,
      );

      await api(t, author).put(`/users/${troll.id}/block`);
      expect(
        errorCode(await api(t, troll).post(`/posts/${post.id}/comments`, { body: 'again' })),
      ).toBe('POST_NOT_FOUND');
    });

    it('notifies with the most specific reason, once per recipient', async () => {
      const author = await signupUser(t);
      const alice = await signupUser(t);
      const bob = await signupUser(t);
      const carol = await signupUser(t);
      const post = await createPost(t, author);
      const root = (
        await api(t, alice).post(`/posts/${post.id}/comments`, { body: 'hello' })
      ).json();
      // Bob replies to Alice and mentions both the post author and Carol.
      const reply = (
        await api(t, bob).post(`/posts/${post.id}/comments`, {
          body: `@${author.username} @${carol.username} @${alice.username} thoughts`,
          parentId: root.id,
        })
      ).json();
      const rows = await t.platform.db
        .selectFrom('notifications')
        .select(['recipientId', 'type'])
        .where('commentId', '=', reply.id)
        .execute();
      const by = new Map(rows.map((r) => [r.recipientId, r.type]));
      expect(by.get(alice.id)).toBe('COMMENT_REPLY'); // reply beats mention
      expect(by.get(author.id)).toBe('POST_COMMENT'); // post author beats mention
      expect(by.get(carol.id)).toBe('MENTION_COMMENT');
      expect(rows).toHaveLength(3);
      expect(by.has(bob.id)).toBe(false);
    });

    it('likes on comments are idempotent, counted, and notify the commenter', async () => {
      const author = await signupUser(t);
      const alice = await signupUser(t);
      const post = await createPost(t, author);
      const c = (
        await api(t, alice).post(`/posts/${post.id}/comments`, { body: 'nice post' })
      ).json();
      expect((await api(t, author).put(`/comments/${c.id}/reaction`)).json()).toEqual({
        reacted: true,
        reactionCount: 1,
      });
      expect((await api(t, author).put(`/comments/${c.id}/reaction`)).json()).toEqual({
        reacted: true,
        reactionCount: 1,
      });
      const list = (await api(t, author).get(`/posts/${post.id}/comments`)).json();
      expect(list.items[0]).toMatchObject({ counts: { reactions: 1 }, viewer: { reacted: true } });
      const note = await t.platform.db
        .selectFrom('notifications')
        .select('type')
        .where('recipientId', '=', alice.id)
        .where('commentId', '=', c.id)
        .execute();
      expect(note).toEqual([{ type: 'COMMENT_REACTION' }]);
      expect((await api(t, author).del(`/comments/${c.id}/reaction`)).json()).toEqual({
        reacted: false,
        reactionCount: 0,
      });
      expect((await api(t, author).del(`/comments/${c.id}/reaction`)).json()).toEqual({
        reacted: false,
        reactionCount: 0,
      });
    });

    it('works anonymously for public posts (read only)', async () => {
      const author = await signupUser(t);
      const post = await createPost(t, author);
      await api(t, author).post(`/posts/${post.id}/comments`, { body: 'first' });
      const res = await api(t).get(`/posts/${post.id}/comments`);
      expect(res.statusCode).toBe(200);
      expect(res.json().items[0].viewer).toBeNull();
      expect(errorCode(await api(t).post(`/posts/${post.id}/comments`, { body: 'x' }))).toBe(
        'UNAUTHENTICATED',
      );
    });

    it('rejects comments the moderation port blocks', async () => {
      class NoSpam extends AllowAllModerator {
        override async moderateText({ text }: { text: string }) {
          return text.includes('buy now')
            ? { verdict: 'BLOCK' as const, reason: 'spam' }
            : { verdict: 'ALLOW' as const };
        }
      }
      const strict = await createTestApp({ overrides: { moderator: new NoSpam() } });
      try {
        const author = await signupUser(strict);
        const post = await createPost(strict, author);
        const res = await api(strict, author).post(`/posts/${post.id}/comments`, {
          body: 'buy now cheap shoes',
        });
        expect(res.statusCode).toBe(422);
        expect(errorCode(res)).toBe('CONTENT_REJECTED');
        expect(
          (await api(strict, author).post(`/posts/${post.id}/comments`, { body: 'great run' }))
            .statusCode,
        ).toBe(201);
      } finally {
        await strict.close();
      }
    }, 30_000);

    it('replays safely with an Idempotency-Key', async () => {
      const author = await signupUser(t);
      const post = await createPost(t, author);
      const send = () =>
        t.app.inject({
          method: 'POST',
          url: `/v1/posts/${post.id}/comments`,
          headers: { ...author.headers, 'idempotency-key': 'comment-key-0001' },
          payload: { body: 'once' },
        });
      const a = (await send()).json();
      const b = (await send()).json();
      expect(b.id).toBe(a.id);
      expect((await postCounts(post.id)).commentCount).toBe(1);
    });
  });

  describe('counter integrity (property test)', () => {
    it('post and comment counters equal the real row counts after random churn', async () => {
      const users = await Promise.all(Array.from({ length: 4 }, () => signupUser(t)));
      const posts = [
        await createPost(t, users[0] as TestUser, { caption: 'p0' }),
        await createPost(t, users[1] as TestUser, { caption: 'p1' }),
      ];
      const comments: Array<{ id: string; by: TestUser }> = [];
      let seed = 1234;
      const rnd = (n: number): number => {
        seed = (seed * 1664525 + 1013904223) % 4294967296;
        return seed % n;
      };
      const pick = <T>(xs: readonly T[]): T => xs[rnd(xs.length)] as T;

      for (let i = 0; i < 140; i++) {
        const u = pick(users);
        const p = pick(posts);
        switch (rnd(9)) {
          case 0:
          case 1:
            await api(t, u).put(`/posts/${p.id}/reaction`, {
              type: pick(['LIKE', 'CLAP', 'FIRE', 'STRONG'] as const),
            });
            break;
          case 2:
            await api(t, u).del(`/posts/${p.id}/reaction`);
            break;
          case 3:
            await api(t, u).put(`/posts/${p.id}/bookmark`);
            break;
          case 4:
            await api(t, u).del(`/posts/${p.id}/bookmark`);
            break;
          case 5:
            await api(t, u).post(`/posts/${p.id}/shares`, { channel: 'COPY_LINK' });
            break;
          case 6: {
            const parent = comments.length > 0 && rnd(2) === 0 ? pick(comments) : undefined;
            const res = await api(t, u).post(
              `/posts/${parent ? (await t.platform.db.selectFrom('comments').select('postId').where('id', '=', parent.id).executeTakeFirstOrThrow()).postId : p.id}/comments`,
              { body: `c${i}`, ...(parent ? { parentId: parent.id } : {}) },
            );
            if (res.statusCode === 201) comments.push({ id: res.json().id as string, by: u });
            break;
          }
          case 7:
            if (comments.length > 0) {
              const c = pick(comments);
              await api(t, c.by).del(`/comments/${c.id}`);
            }
            break;
          case 8:
            if (comments.length > 0) await api(t, u).put(`/comments/${pick(comments).id}/reaction`);
            break;
        }
      }

      for (const p of posts) {
        const real = await t.platform.db
          .selectFrom('posts as p')
          .select((eb) => [
            'p.reactionCount',
            'p.commentCount',
            'p.bookmarkCount',
            'p.shareCount',
            eb
              .selectFrom('postReactions as r')
              .select((e) => e.fn.countAll<number>().as('n'))
              .whereRef('r.postId', '=', 'p.id')
              .as('reactions'),
            eb
              .selectFrom('bookmarks as b')
              .select((e) => e.fn.countAll<number>().as('n'))
              .whereRef('b.postId', '=', 'p.id')
              .as('bookmarks'),
            eb
              .selectFrom('shares as s')
              .select((e) => e.fn.countAll<number>().as('n'))
              .whereRef('s.postId', '=', 'p.id')
              .as('shares'),
            eb
              .selectFrom('comments as c')
              .select((e) => e.fn.countAll<number>().as('n'))
              .whereRef('c.postId', '=', 'p.id')
              .where('c.deletedAt', 'is', null)
              .as('comments'),
          ])
          .where('p.id', '=', p.id)
          .executeTakeFirstOrThrow();
        expect(real.reactionCount).toBe(Number(real.reactions));
        expect(real.bookmarkCount).toBe(Number(real.bookmarks));
        expect(real.shareCount).toBe(Number(real.shares));
        expect(real.commentCount).toBe(Number(real.comments));
      }
      const all = await t.platform.db
        .selectFrom('comments as c')
        .select((eb) => [
          'c.id',
          'c.reactionCount',
          'c.replyCount',
          eb
            .selectFrom('commentReactions as cr')
            .select((e) => e.fn.countAll<number>().as('n'))
            .whereRef('cr.commentId', '=', 'c.id')
            .as('reactions'),
          eb
            .selectFrom('comments as rc')
            .select((e) => e.fn.countAll<number>().as('n'))
            .whereRef('rc.parentId', '=', 'c.id')
            .where('rc.deletedAt', 'is', null)
            .as('replies'),
        ])
        .where(
          'c.postId',
          'in',
          posts.map((p) => p.id),
        )
        .execute();
      for (const c of all) {
        expect(c.reactionCount).toBe(Number(c.reactions));
        expect(c.replyCount).toBe(Number(c.replies));
      }
    }, 120_000);
  });
});
