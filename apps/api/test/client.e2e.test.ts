import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EventBuffer,
  MemoryTokenStore,
  collect,
  createApiClient,
  isApiError,
  paginate,
  unwrap,
  uploadMedia,
  type ApiClient,
} from '@runningapp/api-client';
import { drainJobs, PASSWORD } from './helpers/api';
import { createTestApp, type TestApp } from './helpers/app';
import { makeVideo } from './helpers/media';

/**
 * The published client against the REAL server over HTTP. This is the contract test for
 * everything a front end depends on: generated types, auth + single-flight refresh against the
 * server's real token rotation, error mapping, pagination, event batching and the media upload
 * dance (presigned PUT, completion, processing).
 */
describe('api-client against the running API', () => {
  let t: TestApp;
  let baseUrl: string;
  let pump: NodeJS.Timeout;
  const freePort = () =>
    new Promise<number>((resolve, reject) => {
      const srv = net.createServer();
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const { port } = srv.address() as net.AddressInfo;
        srv.close(() => resolve(port));
      });
    });

  beforeAll(async () => {
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    t = await createTestApp({ env: { PUBLIC_BASE_URL: baseUrl } });
    await t.app.listen({ port, host: '127.0.0.1' });
    // Stand-in for the worker process: processes media while the client polls.
    pump = setInterval(() => void drainJobs(t).catch(() => undefined), 150);
  });
  afterAll(async () => {
    clearInterval(pump);
    await t.close();
  });

  const newClient = (store = new MemoryTokenStore()) => {
    const lost: string[] = [];
    const client = createApiClient({ baseUrl, tokens: store, onSessionLost: (r) => lost.push(r) });
    return { client, store, lost };
  };

  async function signedUp(
    username: string,
  ): Promise<{ client: ApiClient; store: MemoryTokenStore; id: string }> {
    const { client, store } = newClient();
    const auth = unwrap(
      await client.POST('/v1/auth/signup', {
        body: {
          email: `${username}@example.test`,
          password: PASSWORD,
          username,
          displayName: username,
          birthDate: '1990-06-15',
        },
      }),
    );
    await client.setTokens(auth.tokens);
    await t.platform.db
      .updateTable('users')
      .set({ emailVerifiedAt: t.clock.now() })
      .where('id', '=', auth.user.id)
      .execute();
    return { client, store, id: auth.user.id };
  }

  it('signs up, calls authenticated endpoints with typed responses, and maps errors', async () => {
    const { client, id } = await signedUp('client_e2e_a');
    const me = unwrap(await client.GET('/v1/me'));
    expect(me.id).toBe(id);

    const post = unwrap(
      await client.POST('/v1/posts', {
        body: { caption: 'hello from the client #e2e', visibility: 'PUBLIC' },
      }),
    );
    expect(post.topics).toEqual(['e2e']);
    expect(post.author.id).toBe(id);

    const missing = await client.GET('/v1/posts/{id}', {
      params: { path: { id: '018f0000-0000-7000-8000-000000000000' } },
    });
    try {
      unwrap(missing);
      expect.unreachable();
    } catch (e) {
      expect(isApiError(e, 'POST_NOT_FOUND')).toBe(true);
      expect((e as { status: number }).status).toBe(404);
      expect((e as { requestId: string | null }).requestId).toBeTruthy();
    }

    const invalid = await client.POST('/v1/posts', { body: { caption: 'x'.repeat(5000) } });
    try {
      unwrap(invalid);
      expect.unreachable();
    } catch (e) {
      expect(isApiError(e, 'VALIDATION_FAILED')).toBe(true);
    }
  });

  it('survives access-token expiry: refreshes once, even under concurrent requests', async () => {
    const { client, store } = await signedUp('client_e2e_b');
    const before = store.get();
    // The access token lifetime passes on the server's clock.
    t.clock.advanceSeconds(t.config.ACCESS_TOKEN_TTL_SECONDS + 60);

    // Five parallel calls all hit TOKEN_EXPIRED; the server's refresh tokens are single use, so
    // two refreshes would be detected as token reuse and kill the session. It must stay alive.
    const results = await Promise.all(Array.from({ length: 5 }, () => client.GET('/v1/me')));
    expect(results.map((r) => r.response.status)).toEqual([200, 200, 200, 200, 200]);
    const after = store.get();
    expect(after?.accessToken).not.toBe(before?.accessToken);
    expect(after?.refreshToken).not.toBe(before?.refreshToken);

    // The rotated session keeps working.
    expect((await client.GET('/v1/me')).response.status).toBe(200);
    const sessions = await t.platform.db.selectFrom('sessions').select('revokedAt').execute();
    expect(sessions.every((s) => s.revokedAt === null)).toBe(true);
  });

  it('ends the session cleanly when the server revokes it', async () => {
    const { client, store, lost } = await (async () => {
      const s = await signedUp('client_e2e_c');
      const lostList: string[] = [];
      const client = createApiClient({
        baseUrl,
        tokens: s.store,
        onSessionLost: (r) => lostList.push(r),
      });
      return { client, store: s.store, lost: lostList };
    })();
    unwrap(await client.POST('/v1/auth/logout-all'));
    const res = await client.GET('/v1/me');
    expect(res.response.status).toBe(401);
    expect(store.get()).toBeNull();
    expect(lost).toEqual(['SESSION_REVOKED']);
  });

  it('pages feeds and lists, batches events, and the server accepts what the client sends', async () => {
    const author = await signedUp('client_e2e_author');
    const reader = await signedUp('client_e2e_reader');
    for (let i = 0; i < 5; i++) {
      unwrap(
        await author.client.POST('/v1/posts', {
          body: { caption: `post ${i}`, visibility: 'PUBLIC' },
        }),
      );
    }
    unwrap(
      await reader.client.POST('/v1/users/{userId}/follow', {
        params: { path: { userId: author.id } },
      }),
    );

    const feed = await collect(
      paginate(async (cursor) =>
        unwrap(
          await reader.client.GET('/v1/feed/following', {
            params: { query: { limit: 2, cursor } },
          }),
        ),
      ),
      50,
    );
    expect(feed.map((i) => i.post.caption)).toEqual([
      'post 4',
      'post 3',
      'post 2',
      'post 1',
      'post 0',
    ]);

    const page = unwrap(await reader.client.GET('/v1/feed/home'));
    const buffer = new EventBuffer(reader.client, { batchSize: 3 });
    for (const item of page.items) {
      buffer.track({
        type: 'IMPRESSION',
        postId: item.post.id,
        feedRequestId: page.requestId,
        surface: 'HOME',
        position: item.position,
      });
    }
    const first = page.items[0];
    if (!first) throw new Error('the home feed should not be empty');
    buffer.track({ type: 'WATCH_TIME', postId: first.post.id, valueMs: 2500 });
    await buffer.flush();
    expect(buffer.pending).toBe(0);
    const stored = await t.platform.db
      .selectFrom('feedEvents')
      .select('eventType')
      .where('userId', '=', reader.id)
      .where('origin', '=', 'CLIENT') // the follow above was recorded by the server itself
      .execute();
    expect(stored).toHaveLength(page.items.length + 1);
    // Attribution survived the round trip.
    const attributed = await t.platform.db
      .selectFrom('feedEvents')
      .select('feedRequestId')
      .where('userId', '=', reader.id)
      .where('eventType', '=', 'IMPRESSION')
      .execute();
    expect(attributed.every((e) => e.feedRequestId === page.requestId)).toBe(true);
  });

  it('uploads a real video: presigned PUT, completion, processing, then attaches it to a post', async () => {
    const { client } = await signedUp('client_e2e_uploader');
    const bytes = await makeVideo({ width: 320, height: 568, seconds: 1, fps: 15 });
    const statuses: string[] = [];
    const media = await uploadMedia(client, {
      kind: 'VIDEO',
      mimeType: 'video/mp4',
      data: new Uint8Array(bytes),
      pollMs: 100,
      onStatus: (m) => statuses.push(m.status),
    });
    expect(media.status).toBe('READY');
    expect(media.urls?.poster ?? media.urls?.thumbnail).toBeTruthy();
    expect(statuses.at(-1)).toBe('READY');

    const post = unwrap(
      await client.POST('/v1/posts', {
        body: { caption: 'my clip', visibility: 'PUBLIC', mediaIds: [media.id] },
      }),
    );
    expect(post.format).toBe('VIDEO');
    expect(post.status).toBe('PUBLISHED');
    expect(post.media[0]?.id).toBe(media.id);
  });
});
