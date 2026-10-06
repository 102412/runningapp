import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodePolyline, haversine, type LatLon } from '../src/modules/activities/geo';
import { api, errorCode, signupUser, type TestUser } from './helpers/api';
import { createTestApp, type TestApp } from './helpers/app';
import { eastwardRoute, makeGpx, polylineOf } from './helpers/geo';

const RUN = { sport: 'running', startedAt: '2026-03-01T07:30:00Z', elapsedTimeS: 1800 };

describe('activities', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  const follow = (follower: TestUser, followee: TestUser) =>
    t.platform.db
      .insertInto('follows')
      .values({ followerId: follower.id, followeeId: followee.id })
      .execute();

  describe('creation and validation', () => {
    it('logs a minimal activity with sensible defaults and derived fields', async () => {
      const u = await signupUser(t);
      const res = await api(t, u).post('/activities', {
        ...RUN,
        distanceM: 5000,
        movingTimeS: 1500,
      });
      expect(res.statusCode).toBe(201);
      const a = res.json();
      expect(a).toMatchObject({
        sport: 'running',
        title: 'Morning Run',
        visibility: 'FOLLOWERS',
        timezone: 'UTC',
        distanceM: 5000,
        hasRoute: false,
        routePreview: null,
        splits: [],
        ownerPrivacy: { routePrivacy: 'TRIMMED' },
      });
      expect(a.speed).toMatchObject({ paceSecPerKm: 300, avgSpeedKph: 12 });
      expect(a.user.id).toBe(u.id);
    });

    it('derives the default title from the LOCAL start time', async () => {
      const u = await signupUser(t);
      const tokyo = await api(t, u).post('/activities', { ...RUN, timezone: 'Asia/Tokyo' }); // 16:30 local
      expect(tokyo.json().title).toBe('Afternoon Run');
      const night = await api(t, u).post('/activities', {
        sport: 'cycling',
        startedAt: '2026-03-01T23:30:00Z',
        elapsedTimeS: 600,
      });
      expect(night.json().title).toBe('Night Ride');
    });

    it('rejects metrics the sport does not support, naming each field', async () => {
      const u = await signupUser(t);
      const lift = await api(t, u).post('/activities', {
        sport: 'strength_training',
        startedAt: RUN.startedAt,
        elapsedTimeS: 3000,
        distanceM: 1000,
        metrics: { power: { avgW: 200 } },
      });
      expect(lift.statusCode).toBe(422);
      expect(errorCode(lift)).toBe('METRIC_NOT_SUPPORTED_FOR_SPORT');
      expect(
        lift
          .json()
          .error.details.map((d: { path: string }) => d.path)
          .sort(),
      ).toEqual(['distanceM', 'metrics.power']);

      const swim = await api(t, u).post('/activities', {
        sport: 'swimming',
        startedAt: RUN.startedAt,
        elapsedTimeS: 1800,
        metrics: { sportSpecific: { strength: { totalVolumeKg: 10 } } },
      });
      expect(errorCode(swim)).toBe('METRIC_NOT_SUPPORTED_FOR_SPORT');
      // ...but supported, sport-specific detail is stored and returned.
      const ok = await api(t, u).post('/activities', {
        sport: 'swimming',
        startedAt: RUN.startedAt,
        elapsedTimeS: 1800,
        distanceM: 1500,
        metrics: {
          sportSpecific: { swim: { poolLengthM: 25, strokeCount: 900 } },
          heartRate: { avgBpm: 140, maxBpm: 165 },
        },
      });
      expect(ok.statusCode).toBe(201);
      expect(ok.json().metrics.sportSpecific).toEqual({
        swim: { poolLengthM: 25, strokeCount: 900 },
      });
      expect(ok.json().speed.paceSecPer100m).toBe(120);
    });

    it('supports sports with no distance at all (strength) without any running assumptions', async () => {
      const u = await signupUser(t);
      const res = await api(t, u).post('/activities', {
        sport: 'strength_training',
        startedAt: RUN.startedAt,
        elapsedTimeS: 3600,
        caloriesKcal: 400,
        metrics: {
          heartRate: { avgBpm: 120 },
          sportSpecific: {
            strength: {
              totalVolumeKg: 5400,
              exercises: [{ name: 'Squat', sets: [{ reps: 5, weightKg: 100 }] }],
            },
          },
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({
        distanceM: null,
        speed: { paceSecPerKm: null, avgSpeedKph: null },
      });
    });

    it('rejects implausible, inconsistent and malformed data', async () => {
      const u = await signupUser(t);
      const post = (body: Record<string, unknown>) =>
        api(t, u).post('/activities', { ...RUN, ...body });
      expect(errorCode(await post({ distanceM: 500_000 }))).toBe('VALIDATION_FAILED'); // 278 m/s: unit mix-up
      expect(errorCode(await post({ movingTimeS: 5000 }))).toBe('VALIDATION_FAILED');
      expect(
        errorCode(await post({ startedAt: new Date(Date.now() + 3_600_000).toISOString() })),
      ).toBe('VALIDATION_FAILED');
      expect(errorCode(await post({ startedAt: '1990-01-01T00:00:00Z' }))).toBe(
        'VALIDATION_FAILED',
      );
      expect(errorCode(await post({ timezone: 'Mars/Olympus' }))).toBe('VALIDATION_FAILED');
      expect(errorCode(await post({ metrics: { heartRate: { avgBpm: 180, maxBpm: 150 } } }))).toBe(
        'VALIDATION_FAILED',
      );
      expect(errorCode(await post({ elapsedTimeS: -5 }))).toBe('VALIDATION_FAILED');
      expect(errorCode(await post({ route: { polyline: '!!!not a polyline!!!' } }))).toBe(
        'VALIDATION_FAILED',
      );
      expect(errorCode(await post({ route: { points: [[1, 1]] } }))).toBe('VALIDATION_FAILED');
      expect(
        errorCode(
          await post({
            route: {
              points: [
                [95, 1],
                [1, 1],
              ],
            },
          }),
        ),
      ).toBe('VALIDATION_FAILED');
      expect(errorCode(await post({ userId: u.id }))).toBe('VALIDATION_FAILED'); // unknown key: no mass assignment
      expect((await api(t).post('/activities', RUN)).statusCode).toBe(401);
    });

    it('stores splits with per-type indexes and returns them only in the detail view', async () => {
      const u = await signupUser(t);
      const created = (
        await api(t, u).post('/activities', {
          ...RUN,
          distanceM: 3000,
          splits: [
            { type: 'KM', distanceM: 1000, elapsedTimeS: 300 },
            { type: 'KM', distanceM: 1000, elapsedTimeS: 310 },
            { type: 'KM', distanceM: 1000, elapsedTimeS: 290 },
            { type: 'LAP', elapsedTimeS: 900 },
          ],
        })
      ).json();
      expect(created.splits).toHaveLength(4);
      const detail = (await api(t, u).get(`/activities/${created.id}`)).json();
      expect(
        detail.splits.map((s: { type: string; index: number }) => `${s.type}${s.index}`),
      ).toEqual(['KM0', 'KM1', 'KM2', 'LAP0']);
      const list = (await api(t, u).get(`/users/${u.id}/activities`)).json();
      expect(list.items[0].splits).toBeNull();
    });

    it('minors cannot publish PUBLIC activities', async () => {
      const year = new Date().getUTCFullYear() - 14;
      const kid = await signupUser(t, { birthDate: `${year}-01-01` });
      const res = await api(t, kid).post('/activities', { ...RUN, visibility: 'PUBLIC' });
      expect(res.statusCode).toBe(403);
      expect(errorCode(res)).toBe('PUBLIC_ACCOUNT_NOT_ALLOWED');
      // Their default is PRIVATE with a HIDDEN route.
      const ok = (await api(t, kid).post('/activities', RUN)).json();
      expect(ok.visibility).toBe('PRIVATE');
      expect(ok.ownerPrivacy.routePrivacy).toBe('HIDDEN');
    });
  });

  describe('visibility', () => {
    it('enforces the audience matrix for single activities and listings', async () => {
      const owner = await signupUser(t);
      const follower = await signupUser(t);
      const stranger = await signupUser(t);
      const blocked = await signupUser(t);
      await follow(follower, owner);
      await api(t, owner).put(`/users/${blocked.id}/block`);

      const mk = async (visibility: string) =>
        (await api(t, owner).post('/activities', { ...RUN, visibility })).json().id as string;
      const pub = await mk('PUBLIC');
      const fol = await mk('FOLLOWERS');
      const priv = await mk('PRIVATE');

      const seen = async (viewer: TestUser | null, id: string) =>
        (await api(t, viewer).get(`/activities/${id}`)).statusCode;
      expect([await seen(null, pub), await seen(null, fol), await seen(null, priv)]).toEqual([
        200, 404, 404,
      ]);
      expect([
        await seen(stranger, pub),
        await seen(stranger, fol),
        await seen(stranger, priv),
      ]).toEqual([200, 404, 404]);
      expect([
        await seen(follower, pub),
        await seen(follower, fol),
        await seen(follower, priv),
      ]).toEqual([200, 200, 404]);
      expect([await seen(owner, pub), await seen(owner, fol), await seen(owner, priv)]).toEqual([
        200, 200, 200,
      ]);
      expect([
        await seen(blocked, pub),
        await seen(blocked, fol),
        await seen(blocked, priv),
      ]).toEqual([404, 404, 404]);

      const ids = async (viewer: TestUser | null) =>
        (await api(t, viewer).get(`/users/${owner.id}/activities`))
          .json()
          .items.map((a: { id: string }) => a.id);
      expect((await ids(stranger)).sort()).toEqual([pub].sort());
      expect((await ids(follower)).sort()).toEqual([pub, fol].sort());
      expect((await ids(owner)).sort()).toEqual([pub, fol, priv].sort());
      expect(await ids(blocked)).toEqual([]);
    });

    it('PUBLIC activities of a PRIVATE account remain followers-only', async () => {
      const owner = await signupUser(t, { isPrivate: true });
      const follower = await signupUser(t);
      const stranger = await signupUser(t);
      await follow(follower, owner);
      const id = (await api(t, owner).post('/activities', { ...RUN, visibility: 'PUBLIC' })).json()
        .id as string;
      expect((await api(t, stranger).get(`/activities/${id}`)).statusCode).toBe(404);
      expect((await api(t).get(`/activities/${id}`)).statusCode).toBe(404);
      expect((await api(t, follower).get(`/activities/${id}`)).statusCode).toBe(200);
    });

    it('paginates with a stable cursor and filters by sport', async () => {
      const u = await signupUser(t);
      for (let i = 0; i < 5; i++) {
        await api(t, u).post('/activities', {
          sport: i % 2 === 0 ? 'running' : 'cycling',
          startedAt: `2026-02-0${i + 1}T07:00:00Z`,
          elapsedTimeS: 600,
        });
      }
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page = await api(t, u).get(
          `/users/${u.id}/activities?limit=2${cursor ? `&cursor=${cursor}` : ''}`,
        );
        const body: { items: Array<{ startedAt: string }>; nextCursor: string | null } = page.json();
        seen.push(...body.items.map((a) => a.startedAt));
        cursor = body.nextCursor;
      } while (cursor);
      expect(seen).toHaveLength(5);
      expect(seen).toEqual([...seen].sort().reverse()); // newest first, no dupes
      const runs = (await api(t, u).get(`/users/${u.id}/activities?sport=running`)).json();
      expect(runs.items).toHaveLength(3);
    });
  });

  describe('ownership', () => {
    it('only the owner can edit or delete; others get 404, and measurements are immutable', async () => {
      const owner = await signupUser(t);
      const other = await signupUser(t);
      const id = (
        await api(t, owner).post('/activities', { ...RUN, visibility: 'PUBLIC', distanceM: 5000 })
      ).json().id as string;

      expect(errorCode(await api(t, other).patch(`/activities/${id}`, { title: 'hijacked' }))).toBe(
        'ACTIVITY_NOT_FOUND',
      );
      expect(errorCode(await api(t, other).del(`/activities/${id}`))).toBe('ACTIVITY_NOT_FOUND');
      expect((await api(t, owner).patch(`/activities/${id}`, { distanceM: 1 })).statusCode).toBe(
        422,
      ); // not editable
      const edited = await api(t, owner).patch(`/activities/${id}`, {
        title: 'Tempo',
        description: 'felt good',
        visibility: 'FOLLOWERS',
      });
      expect(edited.json()).toMatchObject({
        title: 'Tempo',
        description: 'felt good',
        visibility: 'FOLLOWERS',
      });
      expect((await api(t, owner).del(`/activities/${id}`)).statusCode).toBe(204);
      expect((await api(t, owner).get(`/activities/${id}`)).statusCode).toBe(404);
    });

    it('deleting cascades to metrics, splits, route and records', async () => {
      const u = await signupUser(t);
      const id = (
        await api(t, u).post('/activities', {
          ...RUN,
          distanceM: 5000,
          route: { points: eastwardRoute(5) },
          metrics: { heartRate: { avgBpm: 150 } },
          splits: [{ type: 'KM', distanceM: 1000, elapsedTimeS: 300 }],
        })
      ).json().id as string;
      await api(t, u).del(`/activities/${id}`);
      for (const table of [
        'activityMetrics',
        'activitySplits',
        'activityRoutes',
        'activityRecords',
      ] as const) {
        const rows = await t.platform.db
          .selectFrom(table)
          .select('activityId')
          .where('activityId', '=', id)
          .execute();
        expect(rows, table).toEqual([]);
      }
    });
  });

  describe('route privacy through the API', () => {
    const route = eastwardRoute(5);
    const start = route[0] as LatLon;
    const end = route[route.length - 1] as LatLon;

    async function logWithRoute(
      owner: TestUser,
      extra: Record<string, unknown> = {},
    ): Promise<string> {
      const res = await api(t, owner).post('/activities', {
        ...RUN,
        distanceM: 5000,
        visibility: 'PUBLIC',
        route: { points: route },
        ...extra,
      });
      expect(res.statusCode).toBe(201);
      return res.json().id as string;
    }
    const segs = (body: { segments: string[] }): LatLon[] =>
      body.segments.flatMap((s) => decodePolyline(s));

    it('owners see the real route; others never see the start or end', async () => {
      const owner = await signupUser(t);
      const viewer = await signupUser(t);
      const id = await logWithRoute(owner);

      const own = (await api(t, owner).get(`/activities/${id}/route`)).json();
      const ownPts = segs(own);
      expect(haversine(ownPts[0] as LatLon, start)).toBeLessThan(5);
      expect(own.isPrivacyFiltered).toBe(false);

      const other = (await api(t, viewer).get(`/activities/${id}/route`)).json();
      expect(other.isPrivacyFiltered).toBe(true);
      for (const p of segs(other)) {
        expect(haversine(p, start)).toBeGreaterThan(195);
        expect(haversine(p, end)).toBeGreaterThan(195);
      }
      // The bbox describes what is SHOWN, so it cannot leak the trimmed ends.
      expect(other.bbox.minLon).toBeGreaterThan(start[1]);
      expect(other.bbox.maxLon).toBeLessThan(end[1]);
    });

    it('the same protection applies to the embedded preview in lists and details', async () => {
      const owner = await signupUser(t);
      const viewer = await signupUser(t);
      await logWithRoute(owner);
      const list = (await api(t, viewer).get(`/users/${owner.id}/activities`)).json();
      const preview = list.items[0].routePreview;
      expect(list.items[0].hasRoute).toBe(true);
      expect(preview.isPrivacyFiltered).toBe(true);
      for (const p of segs(preview)) expect(haversine(p, start)).toBeGreaterThan(195);
      expect(segs(preview).length).toBeLessThanOrEqual(130);
    });

    it('HIDDEN routes are withheld entirely from others but not from the owner', async () => {
      const owner = await signupUser(t);
      const viewer = await signupUser(t);
      const id = await logWithRoute(owner, { routePrivacy: 'HIDDEN' });
      const other = await api(t, viewer).get(`/activities/${id}`);
      expect(other.json()).toMatchObject({
        hasRoute: false,
        routePreview: null,
        ownerPrivacy: null,
      });
      expect((await api(t, viewer).get(`/activities/${id}/route`)).statusCode).toBe(404);
      expect((await api(t, owner).get(`/activities/${id}/route`)).statusCode).toBe(200);
      expect((await api(t, owner).get(`/activities/${id}`)).json().hasRoute).toBe(true);
    });

    it('changing route privacy later takes effect immediately for existing activities', async () => {
      const owner = await signupUser(t);
      const viewer = await signupUser(t);
      const id = await logWithRoute(owner, { routePrivacy: 'FULL' });
      const full = segs((await api(t, viewer).get(`/activities/${id}/route`)).json());
      expect(haversine(full[0] as LatLon, start)).toBeLessThan(5);
      await api(t, owner).patch(`/activities/${id}`, { routePrivacy: 'HIDDEN' });
      expect((await api(t, viewer).get(`/activities/${id}/route`)).statusCode).toBe(404);
    });

    it('privacy zones apply retroactively, split the route, and are invisible to others', async () => {
      const owner = await signupUser(t);
      const viewer = await signupUser(t);
      const id = await logWithRoute(owner, { routePrivacy: 'FULL' });
      const mid = route[Math.floor(route.length / 2)] as LatLon;
      const zone = await api(t, owner).post('/me/privacy-zones', {
        label: 'Home',
        lat: mid[0],
        lon: mid[1],
        radiusM: 300,
      });
      expect(zone.statusCode).toBe(201);

      const other = (await api(t, viewer).get(`/activities/${id}/route`)).json();
      expect(other.segments).toHaveLength(2);
      for (const p of segs(other)) expect(haversine(p, mid)).toBeGreaterThan(299);
      // Owner still sees everything, and can preview what others see.
      expect((await api(t, owner).get(`/activities/${id}/route`)).json().segments).toHaveLength(1);
      expect(
        (await api(t, owner).get(`/activities/${id}/route?view=PUBLIC`)).json().segments,
      ).toHaveLength(2);
      // Zones themselves are not exposed to other users.
      expect((await api(t, viewer).get('/me/privacy-zones')).json().items).toEqual([]);
      expect(JSON.stringify((await api(t, viewer).get(`/activities/${id}`)).json())).not.toContain(
        'Home',
      );
    });

    it('caps zones at 10 and allows deletion', async () => {
      const u = await signupUser(t);
      let last: string | undefined;
      for (let i = 0; i < 10; i++) {
        const r = await api(t, u).post('/me/privacy-zones', {
          label: `Z${i}`,
          lat: 44 + i * 0.01,
          lon: -123,
          radiusM: 100,
        });
        expect(r.statusCode).toBe(201);
        last = r.json().id as string;
      }
      expect(
        (
          await api(t, u).post('/me/privacy-zones', {
            label: 'extra',
            lat: 45,
            lon: -123,
            radiusM: 100,
          })
        ).statusCode,
      ).toBe(422);
      expect((await api(t, u).del(`/me/privacy-zones/${last}`)).statusCode).toBe(204);
      expect(
        (
          await api(t, u).post('/me/privacy-zones', {
            label: 'again',
            lat: 45,
            lon: -123,
            radiusM: 100,
          })
        ).statusCode,
      ).toBe(201);
    });

    it('accepts encoded polylines too', async () => {
      const u = await signupUser(t);
      const res = await api(t, u).post('/activities', {
        ...RUN,
        route: { polyline: polylineOf(route) },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().hasRoute).toBe(true);
    });

    it('routes are rejected for sports that have none (track, strength)', async () => {
      const u = await signupUser(t);
      const res = await api(t, u).post('/activities', {
        sport: 'track',
        startedAt: RUN.startedAt,
        elapsedTimeS: 600,
        route: { points: route },
      });
      expect(errorCode(res)).toBe('METRIC_NOT_SUPPORTED_FOR_SPORT');
    });
  });

  describe('personal records', () => {
    it('records bests at the time they are set, with the previous value', async () => {
      const u = await signupUser(t);
      const mk = async (distanceM: number, elapsedTimeS: number, day: number) =>
        (
          await api(t, u).post('/activities', {
            sport: 'running',
            startedAt: `2026-01-${String(day).padStart(2, '0')}T08:00:00Z`,
            distanceM,
            elapsedTimeS,
          })
        ).json();
      const first = await mk(5020, 1500, 1);
      expect(first.records.map((r: { type: string }) => r.type).sort()).toEqual([
        'FASTEST_5K',
        'LONGEST_DISTANCE',
        'LONGEST_DURATION',
      ]);
      // Slower 5K: not a 5K PR and not a longer distance, but a slower run is by definition a longer duration.
      const slower5k = await mk(5000, 1600, 2);
      expect(slower5k.records.map((r: { type: string }) => r.type)).toEqual(['LONGEST_DURATION']);
      const faster = await mk(5010, 1400, 3);
      expect(faster.records.find((r: { type: string }) => r.type === 'FASTEST_5K')).toMatchObject({
        value: 1400,
        previousValue: 1500,
      });
      const longer = await mk(8000, 2800, 4);
      expect(longer.records.map((r: { type: string }) => r.type)).toEqual(
        expect.arrayContaining(['LONGEST_DISTANCE', 'LONGEST_DURATION']),
      );
      expect(longer.records.some((r: { type: string }) => r.type === 'FASTEST_5K')).toBe(false); // 8 km is not a 5K effort
    });
  });

  describe('GPX import', () => {
    const gpx = (extra = {}) =>
      makeGpx({
        points: eastwardRoute(5),
        speedMps: 3.5,
        hr: 150,
        name: 'Morning &amp; Tempo',
        type: 'running',
        ...extra,
      });
    const post = (u: TestUser | null, body: string, qs = '', contentType = 'application/gpx+xml') =>
      t.app.inject({
        method: 'POST',
        url: `/v1/activities/import/gpx${qs}`,
        headers: { ...(u?.headers ?? {}), 'content-type': contentType },
        payload: body,
      });

    it('derives distance, time, splits, elevation and heart rate from the track', async () => {
      const u = await signupUser(t);
      const res = await post(u, gpx(), '?visibility=PUBLIC');
      expect(res.statusCode).toBe(201);
      const a = res.json();
      expect(a.sport).toBe('running');
      expect(a.title).toBe('Morning & Tempo');
      expect(a.source).toBe('FILE_IMPORT');
      expect(a.distanceM).toBeGreaterThan(4950);
      expect(a.distanceM).toBeLessThan(5050);
      expect(a.elapsedTimeS).toBeGreaterThan(1400);
      expect(a.elapsedTimeS).toBeLessThan(1460); // 5000 m at 3.5 m/s ~ 1428 s
      expect(a.metrics.heartRate.avgBpm).toBeGreaterThan(149);
      expect(a.hasRoute).toBe(true);
      expect(a.records.length).toBeGreaterThan(0);
      const detail = (await api(t, u).get(`/activities/${a.id}`)).json();
      expect(detail.splits).toHaveLength(5);
      expect(detail.splits[0].distanceM).toBeCloseTo(1000, 0);
      expect(detail.splits[0].elapsedTimeS).toBeGreaterThan(270);
      expect(detail.splits[0].elapsedTimeS).toBeLessThan(300);
    });

    it('is idempotent: importing the same file twice returns the same activity', async () => {
      const u = await signupUser(t);
      const body = gpx();
      const first = await post(u, body);
      const second = await post(u, body);
      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(200);
      expect(second.json().id).toBe(first.json().id);
      // ...but a different user importing the same file gets their own activity.
      const other = await signupUser(t);
      expect((await post(other, body)).statusCode).toBe(201);
    });

    it('needs a sport when the file does not declare one', async () => {
      const u = await signupUser(t);
      const untyped = gpx({ type: undefined });
      expect(errorCode(await post(u, untyped))).toBe('VALIDATION_FAILED');
      expect((await post(u, untyped, '?sport=hiking')).statusCode).toBe(201);
    });

    it('rejects hostile or malformed files', async () => {
      const u = await signupUser(t);
      const xxe = `<?xml version="1.0"?><!DOCTYPE gpx [<!ENTITY x SYSTEM "file:///etc/passwd">]><gpx><trk><name>&x;</name></trk></gpx>`;
      expect(errorCode(await post(u, xxe))).toBe('UNSUPPORTED_FILE');
      const bomb = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]><gpx>&lol2;</gpx>`;
      expect(errorCode(await post(u, bomb))).toBe('UNSUPPORTED_FILE');
      expect(errorCode(await post(u, '<html><body>hello world, not a gpx</body></html>'))).toBe(
        'UNSUPPORTED_FILE',
      );
      expect(errorCode(await post(u, makeGpx({ points: eastwardRoute(1), withTime: false })))).toBe(
        'UNSUPPORTED_FILE',
      );
      expect(
        errorCode(await post(u, 'definitely not xml at all, just a long string of text')),
      ).toBe('UNSUPPORTED_FILE');
      const badCoord = gpx().replace(/lat="44\.05"/, 'lat="123.0"');
      expect(errorCode(await post(u, badCoord))).toBe('UNSUPPORTED_FILE');
      expect((await post(null, gpx())).statusCode).toBe(401);
      // A body declared as JSON is parsed as JSON: XML in it is a malformed-JSON 400, never silently parsed as GPX.
      const wrongType = await post(u, gpx(), '', 'application/json');
      expect(wrongType.statusCode).toBe(400);
      expect(errorCode(wrongType)).toBe('MALFORMED_JSON');
    });

    it('rejects oversized bodies with 413 and the standard envelope', async () => {
      const u = await signupUser(t);
      const huge = 'x'.repeat(10 * 1024 * 1024 + 10);
      const res = await post(u, huge);
      expect(res.statusCode).toBe(413);
      expect(errorCode(res)).toBe('PAYLOAD_TOO_LARGE');
    });
  });

  describe('efficiency', () => {
    it('hydrating a page of activities with routes uses a constant number of queries (no N+1)', async () => {
      const queries: string[] = [];
      const counted = await createTestApp({ onQuery: (e) => queries.push(e.query.sql) });
      try {
        const u = await signupUser(counted);
        const viewer = await signupUser(counted);
        for (let i = 0; i < 12; i++) {
          await api(counted, u).post('/activities', {
            ...RUN,
            startedAt: `2026-02-${String(i + 1).padStart(2, '0')}T07:00:00Z`,
            visibility: 'PUBLIC',
            route: { points: eastwardRoute(2) },
            metrics: { heartRate: { avgBpm: 140 } },
          });
        }
        queries.length = 0;
        const res = await api(counted, viewer).get(`/users/${u.id}/activities?limit=12`);
        expect(res.json().items).toHaveLength(12);
        const withFewer = queries.length;
        queries.length = 0;
        await api(counted, viewer).get(`/users/${u.id}/activities?limit=3`);
        expect(queries.length).toBe(withFewer); // same number of queries for 12 items as for 3
        expect(withFewer).toBeLessThanOrEqual(12);
      } finally {
        await counted.close();
      }
    });
  });
});
