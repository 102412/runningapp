import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ClientEvent, CreateActivityRequest } from '@runningapp/contracts';
import { registerJobs } from '../src/jobs';
import { loadConfig, loadDotEnv } from '../src/config';
import { ManualClock } from '../src/platform/clock';
import { createPlatform } from '../src/platform/create';
import { JobWorker } from '../src/platform/jobs/worker';
import { KeywordModerator } from '../src/platform/ports/keyword-moderator';
import { createServices } from '../src/services';
import { Fixtures } from './seed/fixtures';
import { Rng } from './seed/rng';
import {
  CAPTIONS,
  COMMENTS,
  DESCRIPTIONS,
  FOLLOWS,
  PEOPLE,
  PENDING_REQUESTS,
  REPLIES,
  SPORT_TITLES,
  STANDALONE_POSTS,
  type Person,
  type Sport,
} from './seed/world';

/**
 * Deterministic development seed: a small, believable world pushed through the REAL services
 * (so every rule, trigger, counter, notification and background job behaves exactly as in
 * production) with a simulated clock that replays ~10 weeks of activity.
 *
 *   pnpm --filter @runningapp/api db:reset && pnpm --filter @runningapp/api db:seed
 *
 * Flags: --weeks=8  --seed=20260601  --no-media (skip ffmpeg-generated video/photo)  --force
 * Same seed => same people, activities, captions and engagement (ids and wall-clock stamps differ).
 */

const SEED_PASSWORD = process.env.SEED_PASSWORD ?? 'Seed-Pass-Running-2026';
const DAY_MS = 86_400_000;
/** Keeps the seed to a couple of minutes: only this share of the planned media is generated. */
const MEDIA_SCALE = 0.5;

function flag(name: string): string | undefined {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  return hit === undefined ? undefined : (hit.split('=')[1] ?? 'true');
}
const WEEKS = Number(flag('weeks') ?? 8);
const SEED = Number(flag('seed') ?? 20260601);
const WITH_MEDIA = flag('no-media') === undefined;
const FORCE = flag('force') !== undefined;

loadDotEnv();
const config = loadConfig();
if (config.isProduction) {
  console.error('Refusing to seed demo data when NODE_ENV=production.');
  process.exit(1);
}

const realNow = new Date();
const storyStart = new Date(realNow.getTime() - WEEKS * 7 * DAY_MS);
const clock = new ManualClock(storyStart);
const platform = createPlatform(config, { clock });
const { db } = platform;
// Flag the word "crypto" so the spam scenario also shows up as an AUTOMATED report.
const services = createServices(platform, { moderator: new KeywordModerator([], ['crypto']) });
const { registry } = registerJobs(services);
const worker = new JobWorker(platform.jobs, registry, { concurrency: 4, logger: platform.logger });
const rng = new Rng(SEED);

const say = (message: string) => console.log(`  ${message}`);
const drain = async () => {
  for (let i = 0; i < 25; i++) if ((await worker.runOnce()) === 0) return;
};

interface Seeded {
  person: Person;
  id: string;
  sessionId: string;
  emailVerified: boolean;
}
const users = new Map<string, Seeded>();
const user = (key: string): Seeded => {
  const u = users.get(key);
  if (!u) throw new Error(`unknown seed user ${key}`);
  return u;
};

// ----------------------------------------------------------------------------------- media
const fixtures = new Fixtures(config.FFMPEG_PATH);
let media = false;
let uploadCounter = 0;
const tmpDir = path.join(os.tmpdir(), 'runningapp-seed-uploads');

async function uploadReady(
  ownerId: string,
  kind: 'VIDEO' | 'IMAGE',
  bytes: Buffer,
  purpose: 'POST' | 'AVATAR' = 'POST',
): Promise<string> {
  const mimeType = kind === 'VIDEO' ? 'video/mp4' : 'image/jpeg';
  const init = await services.media.initUpload(ownerId, {
    kind,
    mimeType,
    sizeBytes: bytes.length,
    purpose,
  });
  const row = await db
    .selectFrom('mediaAssets')
    .select('storageKey')
    .where('id', '=', init.media.id)
    .executeTakeFirstOrThrow();
  await mkdir(tmpDir, { recursive: true });
  const file = path.join(tmpDir, `upload-${uploadCounter++}`);
  await writeFile(file, bytes);
  await services.storage.uploadFile(row.storageKey, file, mimeType);
  await services.media.complete(ownerId, init.media.id);
  await drain();
  const done = await services.media.getOwned(ownerId, init.media.id);
  if (done.status !== 'READY') {
    throw new Error(`seed media ${init.media.id} ended ${done.status}: ${JSON.stringify(done)}`);
  }
  return init.media.id;
}

// ------------------------------------------------------------------------------- geography
/** A closed loop of roughly `distanceM` metres that starts and ends at `home`, sampled about every 45 m. */
function loopRoute(home: readonly [number, number], distanceM: number): Array<[number, number]> {
  const points = Math.max(12, Math.round(distanceM / 45));
  const radius = distanceM / (2 * Math.PI);
  const mPerDegLat = 111_320;
  const mPerDegLon = 111_320 * Math.cos((home[0] * Math.PI) / 180);
  const stretch = rng.float(0.7, 1.3);
  const rotate = rng.float(0, Math.PI);
  const wobble = rng.float(0.05, 0.18);
  const phase = rng.float(0, Math.PI * 2);
  const offsets: Array<[number, number]> = [];
  for (let i = 0; i <= points; i++) {
    const t = (i / points) * Math.PI * 2;
    const r = radius * (1 + wobble * Math.sin(3 * t + phase));
    const x = r * Math.cos(t) * stretch;
    const y = (r * Math.sin(t)) / stretch;
    offsets.push([
      x * Math.cos(rotate) - y * Math.sin(rotate),
      x * Math.sin(rotate) + y * Math.cos(rotate),
    ]);
  }
  const [east0, north0] = offsets[0] as [number, number];
  return offsets.map(([east, north]): [number, number] => [
    home[0] + (north - north0) / mPerDegLat,
    home[1] + (east - east0) / mPerDegLon,
  ]);
}

// ------------------------------------------------------------------------------ activities
function titleFor(sport: Sport, when: Date): string {
  void when;
  return rng.pick(SPORT_TITLES[sport]);
}

function buildActivity(p: Person, sport: Sport, when: Date): CreateActivityRequest {
  const plan = p.plan;
  const fitness = plan?.fitness ?? 1;
  const base: CreateActivityRequest = {
    sport,
    title: titleFor(sport, when),
    startedAt: when.toISOString(),
    elapsedTimeS: 0,
    visibility: plan?.visibility ?? 'PUBLIC',
    routePrivacy: plan?.routePrivacy ?? 'TRIMMED',
    locationLabel: p.location,
    timezone: 'America/Los_Angeles',
  };
  const description = rng.pick(DESCRIPTIONS);
  if (description) base.description = description;

  switch (sport) {
    case 'running': {
      const kind = rng.weighted([
        ['easy', 6],
        ['tempo', 2.5],
        ['long', 1.5],
      ] as const);
      const km =
        kind === 'long'
          ? rng.float(16, 28)
          : kind === 'tempo'
            ? rng.float(8, 13)
            : rng.float(5, 10);
      const paceSecPerKm =
        (kind === 'easy'
          ? rng.float(305, 345)
          : kind === 'tempo'
            ? rng.float(262, 290)
            : rng.float(300, 330)) / fitness;
      const moving = Math.round(km * paceSecPerKm);
      const splits = Array.from({ length: Math.floor(km) }, () => ({
        type: 'KM' as const,
        distanceM: 1000,
        elapsedTimeS: Math.round(paceSecPerKm + rng.float(-9, 9)),
      }));
      return {
        ...base,
        subtype: kind === 'long' ? 'long_run' : kind === 'tempo' ? 'tempo' : undefined,
        distanceM: Math.round(km * 1000),
        movingTimeS: moving,
        elapsedTimeS: Math.round(moving * rng.float(1.0, 1.05)),
        elevationGainM: Math.round(km * rng.float(4, 16)),
        caloriesKcal: Math.round(km * 62),
        metrics: {
          heartRate: { avgBpm: rng.int(142, 166), maxBpm: rng.int(171, 189) },
          cadence: { avg: rng.int(164, 182) },
        },
        splits,
        route: { points: loopRoute(p.home, km * 1000) },
      };
    }
    case 'cycling': {
      const km = rng.float(22, 95);
      const kph = rng.float(23, 31) * fitness;
      const moving = Math.round((km / kph) * 3600);
      return {
        ...base,
        subtype: rng.chance(0.5) ? 'gravel' : undefined,
        distanceM: Math.round(km * 1000),
        movingTimeS: moving,
        elapsedTimeS: Math.round(moving * rng.float(1.02, 1.15)),
        elevationGainM: Math.round(km * rng.float(8, 16)),
        metrics: {
          heartRate: { avgBpm: rng.int(128, 152), maxBpm: rng.int(165, 182) },
          cadence: { avg: rng.int(78, 92) },
          ...(rng.chance(0.6)
            ? { power: { avgW: rng.int(150, 235), normalizedW: rng.int(170, 260) } }
            : {}),
        },
        route: { points: loopRoute(p.home, km * 1000) },
      };
    }
    case 'swimming': {
      const meters = rng.int(10, 30) * 100;
      const speed = rng.float(0.78, 1.1) * fitness;
      const moving = Math.round(meters / speed);
      return {
        ...base,
        subtype: 'pool',
        distanceM: meters,
        movingTimeS: moving,
        elapsedTimeS: Math.round(moving * rng.float(1.05, 1.25)),
        metrics: { heartRate: { avgBpm: rng.int(118, 142) } },
      };
    }
    case 'strength_training': {
      const elapsed = rng.int(45, 90) * 60;
      return {
        ...base,
        elapsedTimeS: elapsed,
        movingTimeS: Math.round(elapsed * 0.8),
        caloriesKcal: Math.round((elapsed / 60) * 6),
        metrics: { heartRate: { avgBpm: rng.int(102, 124), maxBpm: rng.int(135, 160) } },
      };
    }
    case 'hiking': {
      const km = rng.float(6, 18);
      const moving = Math.round((km / rng.float(3.4, 4.8)) * 3600);
      return {
        ...base,
        distanceM: Math.round(km * 1000),
        movingTimeS: moving,
        elapsedTimeS: Math.round(moving * rng.float(1.1, 1.4)),
        elevationGainM: Math.round(km * rng.float(35, 70)),
        metrics: { heartRate: { avgBpm: rng.int(115, 140) } },
        route: { points: loopRoute(p.home, km * 1000) },
      };
    }
    case 'triathlon': {
      return {
        ...base,
        title: 'Sprint triathlon',
        isRace: true,
        subtype: 'sprint',
        distanceM: 25_750,
        movingTimeS: 4_380,
        elapsedTimeS: 4_500,
        elevationGainM: 140,
        metrics: { heartRate: { avgBpm: 156, maxBpm: 182 } },
      };
    }
    case 'walking': {
      const km = rng.float(2, 6);
      const moving = Math.round((km / 5) * 3600);
      return {
        ...base,
        distanceM: Math.round(km * 1000),
        movingTimeS: moving,
        elapsedTimeS: moving,
        route: { points: loopRoute(p.home, km * 1000) },
      };
    }
  }
}

// ---------------------------------------------------------------------------- main script
console.log(`\nSeeding (seed=${SEED}, weeks=${WEEKS}, media=${WITH_MEDIA ? 'yes' : 'no'}) ...`);

const existing = await db
  .selectFrom('users')
  .select((eb) => eb.fn.countAll<number>().as('n'))
  .executeTakeFirstOrThrow();
if (Number(existing.n) > 0 && !FORCE) {
  console.error(
    'The database already has users. Run `pnpm --filter @runningapp/api db:reset` first (or pass --force).',
  );
  await platform.close();
  process.exit(1);
}

if (WITH_MEDIA) {
  if (await fixtures.available()) {
    await fixtures.init();
    media = true;
  } else {
    console.warn(
      `  ffmpeg not found at "${config.FFMPEG_PATH}": seeding WITHOUT video/photo posts.`,
    );
  }
}

// 1. accounts ---------------------------------------------------------------------------
console.log('Accounts');
for (const p of PEOPLE) {
  clock.advanceSeconds(rng.int(120, 900));
  const grant = await services.auth.signup(
    {
      email: `${p.username}@seed.example`,
      password: SEED_PASSWORD,
      username: p.username,
      displayName: p.displayName,
      birthDate: p.birthDate,
    },
    { ip: '127.0.0.1', userAgent: 'seed-script' },
  );
  const emailVerified = p.emailVerified !== false;
  await db
    .updateTable('users')
    .set({
      emailVerifiedAt: emailVerified ? clock.now() : null,
      ...(p.role ? { role: p.role } : {}),
    })
    .where('id', '=', grant.userId)
    .execute();
  users.set(p.key, { person: p, id: grant.userId, sessionId: grant.sessionId, emailVerified });

  await services.profiles.updateProfile(grant.userId, {
    bio: p.bio,
    locationLabel: p.location,
    ...(p.primarySport ? { primarySport: p.primarySport } : {}),
  });
  if (p.isPrivate || p.discoverable === false) {
    await services.profiles.updateSettings(grant.userId, {
      ...(p.isPrivate ? { accountVisibility: 'PRIVATE' as const } : {}),
      ...(p.discoverable === false ? { discoverable: false } : {}),
    });
  }
  if (p.sports.length > 0) {
    await services.sports.setPreferences(
      grant.userId,
      p.sports.map((s) => ({ sport: s.sport, relation: s.relation })),
    );
  }
  if (p.zone) {
    await services.activities.createZone(grant.userId, {
      label: p.zone.label,
      lat: p.home[0],
      lon: p.home[1],
      radiusM: p.zone.radiusM,
    });
  }
  if (p.creator) {
    await services.creators.upsert(grant.userId, {
      category: p.creator.category,
      tagline: p.creator.tagline,
      websiteUrl: p.creator.website ?? null,
    });
  }
  if (media) {
    const avatar = await uploadReady(
      grant.userId,
      'IMAGE',
      await fixtures.avatar(p.avatarColor),
      'AVATAR',
    );
    await services.profiles.setAvatar(grant.userId, avatar);
  }
}
say(`${users.size} accounts`);

// Staff verify the creators, through the audited path (admin_alex).
const admin = user('alex');
for (const p of PEOPLE) {
  if (p.creator?.verified) {
    await services.moderation.act(
      { userId: admin.id, role: 'ADMIN' },
      {
        action: 'SET_CREATOR_VERIFICATION',
        targetType: 'USER',
        targetId: user(p.key).id,
        note: 'Identity and account ownership checked (seed).',
        verificationStatus: 'VERIFIED',
      },
    );
  }
}
await services.creators.createPartnership(user('leo').id, {
  brandName: 'Stride Running Co.',
  type: 'PAID_PARTNERSHIP',
  startedOn: '2026-01-01',
});

// 2. the social graph -------------------------------------------------------------------
console.log('Follows');
const pending = new Set(PENDING_REQUESTS.map(([a, b]) => `${a}>${b}`));
const approvedFollowers = new Map<string, string[]>();
const addFollower = (target: string, follower: string) =>
  approvedFollowers.set(target, [...(approvedFollowers.get(target) ?? []), follower]);
for (const [from, to] of [...FOLLOWS, ...PENDING_REQUESTS]) {
  clock.advanceSeconds(rng.int(30, 600));
  const state = await services.social.follow(user(from).id, user(to).id);
  if (state === 'REQUESTED' && !pending.has(`${from}>${to}`)) {
    const request = await db
      .selectFrom('followRequests')
      .select('id')
      .where('requesterId', '=', user(from).id)
      .where('targetId', '=', user(to).id)
      .executeTakeFirstOrThrow();
    await services.social.acceptRequest(user(to).id, request.id);
    addFollower(to, from);
  } else if (state === 'FOLLOWING') {
    addFollower(to, from);
  }
}
say(`${FOLLOWS.length} follows, ${PENDING_REQUESTS.length} pending requests`);
await drain();

// 3. the story --------------------------------------------------------------------------
console.log(`Replaying ${WEEKS} weeks`);
interface Born {
  postId: string;
  authorKey: string;
  video: boolean;
  at: Date;
}
const bornToday: Born[] = [];
let activityCount = 0;
let videoCount = 0;
let photoCount = 0;
let lookCounter = 0;
const nextLook = () => lookCounter++;

async function engage(post: Born): Promise<void> {
  const author = user(post.authorKey);
  const followers = (approvedFollowers.get(post.authorKey) ?? []).filter((f) => f !== 'bob');
  const likeP = post.video ? 0.78 : 0.5;
  const commentP = post.video ? 0.28 : 0.12;
  let offsetMin = 4;
  const comments: Array<{ id: string; by: string }> = [];
  for (const f of followers) {
    const u = user(f);
    offsetMin += rng.int(2, 25);
    clock.set(new Date(post.at.getTime() + offsetMin * 60_000));
    try {
      if (rng.chance(likeP)) {
        await services.engagement.react(
          u.id,
          post.postId,
          rng.weighted([
            ['LIKE', 6],
            ['FIRE', 2],
            ['CLAP', 2],
            ['STRONG', 1],
          ] as const),
        );
      }
      if (u.emailVerified && rng.chance(commentP)) {
        const c = await services.engagement.createComment(u.id, post.postId, {
          body: rng.pick(COMMENTS),
        });
        comments.push({ id: c.id, by: f });
      }
      if (rng.chance(post.video ? 0.12 : 0.04))
        await services.engagement.bookmark(u.id, post.postId);
      if (rng.chance(post.video ? 0.06 : 0.015)) {
        await services.engagement.share(u.id, post.postId, 'COPY_LINK');
      }
    } catch (err) {
      // Private/invisible content etc.: a person simply could not interact. Not a seed failure.
      void err;
    }
  }
  for (const c of comments) {
    if (rng.chance(0.55)) {
      offsetMin += rng.int(5, 40);
      clock.set(new Date(post.at.getTime() + offsetMin * 60_000));
      await services.engagement.createComment(author.id, post.postId, {
        body: rng.pick(REPLIES),
        parentId: c.id,
      });
    }
  }
}

async function attachShow(a: Seeded, postId: string, sport: Sport, at: Date): Promise<boolean> {
  const plan = a.person.plan;
  if (!media || !plan || !a.emailVerified) return false;
  const roll = rng.next() / MEDIA_SCALE;
  const kind =
    roll < plan.videoChance ? 'VIDEO' : roll < plan.videoChance + plan.photoChance ? 'IMAGE' : null;
  if (!kind) return false;
  const bytes =
    kind === 'VIDEO' ? await fixtures.video(nextLook()) : await fixtures.photo(nextLook());
  const mediaId = await uploadReady(a.id, kind, bytes);
  const caption = rng.pick(CAPTIONS[sport]);
  clock.set(new Date(at.getTime() + 20 * 60_000));
  await services.posts.attachMedia(a.id, postId, [mediaId]);
  await services.posts.update(a.id, postId, { caption: caption.text, topics: [...caption.topics] });
  if (kind === 'VIDEO') videoCount++;
  else photoCount++;
  return kind === 'VIDEO';
}

const totalDays = WEEKS * 7;
const racedays = new Set<number>([totalDays - 9]);
const standaloneByDay = new Map<number, (typeof STANDALONE_POSTS)[number][]>();
for (const s of STANDALONE_POSTS) {
  const day = Math.min(s.day, totalDays - 1);
  standaloneByDay.set(day, [...(standaloneByDay.get(day) ?? []), s]);
}

for (let day = 0; day < totalDays; day++) {
  const dayStart = new Date(storyStart.getTime() + day * DAY_MS);
  const events: Array<{ at: Date; run: () => Promise<void> }> = [];

  for (const p of PEOPLE) {
    const plan = p.plan;
    if (!plan || day < 3) continue;
    const weekday = dayStart.getUTCDay();
    // People train a bit more on weekends.
    const rate = (plan.perWeek / 7) * (weekday === 0 || weekday === 6 ? 1.25 : 0.95);
    if (!rng.chance(Math.min(0.95, rate))) continue;
    const sport = rng.weighted(plan.sports);
    const at = new Date(dayStart.getTime() + rng.int(5, 19) * 3_600_000 + rng.int(0, 59) * 60_000);
    events.push({
      at,
      run: async () => {
        const a = user(p.key);
        const race = p.key === 'maya' && racedays.has(day);
        const request: CreateActivityRequest = race
          ? {
              ...buildActivity(p, 'running', at),
              title: 'Portland Half Marathon',
              isRace: true,
              subtype: 'half_marathon',
              distanceM: 21_097,
              movingTimeS: 5_472,
              elapsedTimeS: 5_480,
            }
          : buildActivity(p, sport, at);
        const logged = await services.flows.logActivity(
          { id: a.id, emailVerified: a.emailVerified },
          request,
        );
        activityCount++;
        const postId = logged.activity.postId;
        if (!postId) return;
        const video = race
          ? await (async () => {
              if (!media) return false;
              const id = await uploadReady(a.id, 'VIDEO', await fixtures.video(nextLook()));
              await services.posts.attachMedia(a.id, postId, [id]);
              await services.posts.update(a.id, postId, {
                caption: 'Sub 1:32 at the Portland Half! Legs gone, heart full',
                topics: ['halfmarathon', 'running', 'pr'],
              });
              videoCount++;
              return true;
            })()
          : await attachShow(a, postId, sport, at);
        bornToday.push({ postId, authorKey: p.key, video, at });
      },
    });
  }

  for (const s of standaloneByDay.get(day) ?? []) {
    const at = new Date(dayStart.getTime() + rng.int(8, 20) * 3_600_000);
    events.push({
      at,
      run: async () => {
        const a = user(s.author);
        const mediaIds: string[] = [];
        if (media && s.kind === 'video') {
          mediaIds.push(await uploadReady(a.id, 'VIDEO', await fixtures.video(nextLook())));
          videoCount++;
        } else if (media && s.kind === 'photo') {
          mediaIds.push(await uploadReady(a.id, 'IMAGE', await fixtures.photo(nextLook())));
          photoCount++;
        }
        clock.set(new Date(at.getTime() + 60_000));
        const caption = s.caption.length > 0 ? s.caption : 'New post';
        if (mediaIds.length === 0 && s.kind !== 'text') return; // no ffmpeg: skip media-only posts
        const post = await services.posts.create(a.id, {
          caption,
          topics: [...s.topics],
          visibility: s.visibility ?? 'PUBLIC',
          ...(mediaIds.length > 0 ? { mediaIds } : {}),
          ...(s.sponsorship ? { sponsorship: s.sponsorship } : {}),
        });
        bornToday.push({ postId: post.id, authorKey: s.author, video: s.kind === 'video', at });
      },
    });
  }

  // The moderation story: Bob blocked on day 51, report + action later in this loop's tail.
  events.sort((x, y) => x.at.getTime() - y.at.getTime());
  for (const e of events) {
    clock.set(e.at);
    await e.run();
  }
  await drain();
  // Engagement happens after the day's posting, in the evening and the next hours.
  for (const born of bornToday.splice(0)) {
    if (born.authorKey === 'bob') continue;
    await engage(born);
  }
  clock.set(new Date(dayStart.getTime() + DAY_MS - 1000));

  if (day === 51) {
    // Bob's first spam post (day 50) is reported by Maya and hidden by a moderator; THEN she blocks him
    // (after a block she could no longer even see, let alone report, his content).
    const maya = user('maya');
    const bob = user('bob');
    clock.set(new Date(dayStart.getTime() + 12 * 3_600_000));
    const first = await db
      .selectFrom('posts')
      .select('id')
      .where('authorId', '=', bob.id)
      .orderBy('id')
      .executeTakeFirst();
    if (first) {
      const filed = await services.reports.create(maya.id, {
        targetType: 'POST',
        targetId: first.id,
        reason: 'SPAM',
        details: 'Crypto scam, DM bait',
      });
      clock.advanceSeconds(1800);
      await services.moderation.resolveReport(
        { userId: user('morgan').id, role: 'MODERATOR' },
        filed.id,
        { action: 'HIDE_CONTENT', note: 'Spam / financial scam (seed).' },
      );
    }
    clock.advanceSeconds(600);
    await services.social.block(maya.id, bob.id);
  }
  if (day % 14 === 13)
    say(
      `week ${(day + 1) / 7}: ${activityCount} activities, ${videoCount} videos, ${photoCount} photos`,
    );
}

// 4. moderation story (continued): a second spam post stays in the open queue ----------------
console.log('Moderation');
clock.set(realNow);
const spamPosts = await db
  .selectFrom('posts')
  .select('id')
  .where('authorId', '=', user('bob').id)
  .orderBy('id')
  .execute();
const secondSpam = spamPosts[1];
if (secondSpam) {
  await services.reports.create(user('dani').id, {
    targetType: 'POST',
    targetId: secondSpam.id,
    reason: 'SPAM',
  });
  say('1 post hidden by a moderator; a user report + an automated flag left open in the queue');
}

// 5. behaviour -> post_stats and learned taste ------------------------------------------
console.log('Behaviour');
const viewers = ['maya', 'leo', 'sora', 'ben', 'tom', 'nina', 'hana'];
for (const key of viewers) {
  const viewer = user(key);
  const visible = await db
    .selectFrom('posts')
    .select(['id', 'format', 'authorId'])
    .where('status', '=', 'PUBLISHED')
    .where('visibility', '=', 'PUBLIC')
    .where('deletedAt', 'is', null)
    .where('moderationStatus', '=', 'CLEAN')
    .where('authorId', '!=', viewer.id)
    .orderBy('id', 'desc')
    .limit(90)
    .execute();
  const events: ClientEvent[] = [];
  for (const post of visible) {
    if (!rng.chance(0.8)) continue;
    events.push({ eventId: randomUUID(), type: 'IMPRESSION', postId: post.id, surface: 'HOME' });
    if (post.format === 'VIDEO' && rng.chance(0.7)) {
      events.push({ eventId: randomUUID(), type: 'VIDEO_START', postId: post.id });
      if (rng.chance(0.55))
        events.push({ eventId: randomUUID(), type: 'VIDEO_COMPLETE', postId: post.id });
      events.push({
        eventId: randomUUID(),
        type: 'WATCH_TIME',
        postId: post.id,
        valueMs: rng.int(800, 3000),
      });
    } else if (rng.chance(0.15)) {
      events.push({ eventId: randomUUID(), type: 'SKIP', postId: post.id });
    }
  }
  for (let i = 0; i < events.length; i += 100) {
    await services.eventIngestion.ingest(viewer.id, events.slice(i, i + 100));
  }
}
if (secondSpam) {
  await services.eventIngestion.ingest(user('nina').id, [
    { eventId: randomUUID(), type: 'NOT_INTERESTED', postId: secondSpam.id },
  ]);
}
clock.advanceSeconds(180); // let the id-ordered analytics jobs treat the events as settled
await services.feedAnalytics.handleRollup({ settleSeconds: 60 });
await services.feedAnalytics.handleAffinities({ settleSeconds: 60 });
say('post_stats rolled up, affinities learned');

// 6. a pending deletion -----------------------------------------------------------------
const pat = user('pat');
await services.auth.requestDeletion(pat.id, pat.sessionId, SEED_PASSWORD);
await drain();

// 7. cosmetics: rows that default to wall-clock now() are re-dated onto the story timeline --
console.log('Re-dating (cosmetic)');
const start = storyStart.toISOString();
const dated = async (sql: string, ...params: unknown[]) => {
  await platform.pool.query(sql, params);
};
await dated(
  `update users set created_at = $1::timestamptz + (abs(hashtext(id::text)) % 6) * interval '1 hour'`,
  start,
);
await dated(`update profiles p set created_at = u.created_at from users u where u.id = p.user_id`);
await dated(
  `update follows f
      set created_at = greatest(a.created_at, b.created_at)
                       + (abs(hashtext(f.follower_id::text || f.followee_id::text)) % 480) * interval '1 hour'
     from users a, users b where a.id = f.follower_id and b.id = f.followee_id`,
);
await dated(
  `update activities set created_at = started_at + make_interval(secs => elapsed_time_s)`,
);
await dated(`update posts set created_at = published_at where published_at is not null`);
for (const [table, gap] of [
  ['post_reactions', 23],
  ['bookmarks', 41],
  ['shares', 53],
] as const) {
  await dated(
    `update ${table} t set created_at = x.ts
       from (select t2.post_id, t2.user_id,
                    p.published_at + row_number() over (partition by t2.post_id order by t2.created_at, t2.user_id) * interval '${gap} minutes' as ts
               from ${table} t2 join posts p on p.id = t2.post_id where p.published_at is not null) x
      where t.post_id = x.post_id and t.user_id = x.user_id`,
  );
}
await dated(
  `update comments c set created_at = x.ts
     from (select c2.id, p.published_at + row_number() over (partition by c2.post_id order by c2.id) * interval '19 minutes' as ts
             from comments c2 join posts p on p.id = c2.post_id where p.published_at is not null) x
    where c.id = x.id`,
);
await dated(
  `update notifications n set created_at = c.created_at + interval '1 second'
     from comments c where n.comment_id = c.id and n.type in ('POST_COMMENT','COMMENT_REPLY','MENTION_COMMENT')`,
);
await dated(
  `update notifications n set created_at = r.created_at + interval '1 second'
     from post_reactions r where n.type = 'POST_REACTION' and n.post_id = r.post_id and n.actor_id = r.user_id`,
);
await dated(
  `update notifications n set created_at = f.created_at + interval '1 second'
     from follows f where n.type = 'NEW_FOLLOWER' and n.recipient_id = f.followee_id and n.actor_id = f.follower_id`,
);
await dated(
  `update notifications n set created_at = p.published_at + interval '1 second'
     from posts p where n.post_id = p.id and n.comment_id is null
      and n.type in ('MENTION_POST','POST_PUBLISHED','POST_PUBLISH_FAILED','POST_REACTION')
      and p.published_at is not null and n.created_at > p.published_at + interval '1 day'`,
);
// Older notifications have been read; the last two days stay unread (so badges have something to show).
await dated(
  `update notifications set read_at = created_at + interval '2 hours' where created_at < $1::timestamptz`,
  new Date(realNow.getTime() - 2 * DAY_MS).toISOString(),
);
// The dev mail outbox: keep only the unverified user's message (so email verification can be tried).
await dated(`delete from dev_mail_outbox where to_email <> 'unverified_ulla@seed.example'`);

// 8. report ------------------------------------------------------------------------------
const count = async (table: string, where = 'true') =>
  Number(
    (
      await platform.pool.query<{ n: string }>(
        `select count(*)::int as n from ${table} where ${where}`,
      )
    ).rows[0]?.n ?? 0,
  );

console.log('\nDone. World summary:');
say(`users:          ${await count('users')}`);
say(
  `follows:        ${await count('follows')} (+${await count('follow_requests')} pending requests, ${await count('blocks')} block)`,
);
say(`activities:     ${await count('activities')}`);
say(
  `posts:          ${await count('posts')} (video ${await count('posts', "format = 'VIDEO'")}, photo ${await count('posts', "format = 'PHOTO'")}, activity ${await count('posts', "format = 'ACTIVITY'")}, text ${await count('posts', "format = 'TEXT'")}, sponsored ${await count('sponsorship_disclosures')})`,
);
say(
  `comments:       ${await count('comments')}   reactions: ${await count('post_reactions')}   bookmarks: ${await count('bookmarks')}`,
);
say(`notifications:  ${await count('notifications')}`);
say(
  `reports:        ${await count('reports', "status = 'OPEN'")} open of ${await count('reports')}   moderation actions: ${await count('moderation_actions')}`,
);
say(
  `feed events:    ${await count('feed_events')}   learned affinities: ${await count('user_affinities')}`,
);

console.log(`\nDemo accounts (password for ALL: ${SEED_PASSWORD})`);
for (const p of PEOPLE) {
  console.log(`  ${`${p.username}@seed.example`.padEnd(34)} @${p.username.padEnd(16)} ${p.note}`);
}
console.log('\nSign in at POST /v1/auth/login. Start with maya_runs: she has the busiest feed.\n');

await fixtures.cleanup();
await platform.close();
