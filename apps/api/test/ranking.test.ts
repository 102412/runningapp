import { describe, expect, it } from 'vitest';
import {
  AFFINITY_HALF_LIFE_DAYS,
  computeAffinities,
  decay,
  eventWeight,
  type AffinityEvent,
} from '../src/modules/feed/affinities';
import {
  EXPLORE_DIVERSITY,
  HOME_DIVERSITY,
  NEUTRAL_TASTE,
  diversify,
  interleave,
  isExcluded,
  qualityScore,
  rank,
  recencyScore,
  scoreCandidate,
  seenFactor,
  type Candidate,
  type Taste,
} from '../src/modules/feed/ranking';

const NOW = new Date('2026-06-01T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

let seq = 0;
function candidate(over: Partial<Candidate> = {}): Candidate {
  seq += 1;
  return {
    postId: `00000000-0000-7000-8000-${String(seq).padStart(12, '0')}`,
    authorId: `author-${seq}`,
    publishedAt: hoursAgo(1),
    format: 'ACTIVITY',
    sportKey: null,
    topics: [],
    sponsored: false,
    authorIsCreator: false,
    isOwn: false,
    isFollowed: false,
    reactions: 0,
    comments: 0,
    shares: 0,
    bookmarks: 0,
    impressions: 0,
    videoStarts: 0,
    videoCompletes: 0,
    skips: 0,
    notInterested: 0,
    timesSeen: 0,
    ...over,
  };
}

const taste = (over: Partial<Taste> = {}): Taste => ({
  personalized: true,
  sport: new Map(),
  creator: new Map(),
  format: new Map(),
  topic: new Map(),
  ...over,
});

describe('ranking v1', () => {
  it('prefers newer posts, decaying with a 36h half-life', () => {
    expect(recencyScore(NOW, NOW, 36)).toBeCloseTo(1);
    expect(recencyScore(hoursAgo(36), NOW, 36)).toBeCloseTo(0.5);
    expect(recencyScore(hoursAgo(72), NOW, 36)).toBeCloseTo(0.25);
    // A post "from the future" (clock skew) is not rewarded beyond 1.
    expect(recencyScore(new Date(NOW.getTime() + 3_600_000), NOW, 36)).toBeCloseTo(1);
    const [first] = rank(
      [candidate({ publishedAt: hoursAgo(30) }), candidate({ publishedAt: hoursAgo(2) })],
      NEUTRAL_TASTE,
      NOW,
    );
    expect(first?.candidate.publishedAt).toEqual(hoursAgo(2));
  });

  it('ranks a followed author above an otherwise identical stranger, and labels why', () => {
    const stranger = candidate();
    const followed = candidate({ isFollowed: true });
    const own = candidate({ isOwn: true });
    const ranked = rank([stranger, own, followed], NEUTRAL_TASTE, NOW);
    expect(ranked.map((r) => r.candidate)).toEqual([followed, own, stranger]);
    expect(ranked.map((r) => r.reason)).toEqual(['FOLLOWED_AUTHOR', 'OWN_POST', 'DISCOVERY']);
  });

  it('is deterministic: identical inputs give identical order, ties broken newest then id', () => {
    const a = candidate({ publishedAt: hoursAgo(5) });
    const b = candidate({ publishedAt: hoursAgo(5) });
    const first = rank([a, b], NEUTRAL_TASTE, NOW).map((r) => r.candidate.postId);
    const second = rank([b, a], NEUTRAL_TASTE, NOW).map((r) => r.candidate.postId);
    expect(first).toEqual(second);
  });

  it('weighs engagement: smoothed rate, comments and shares count more, tiny samples do not dominate', () => {
    const popular = candidate({ reactions: 40, comments: 10, shares: 5, impressions: 300 });
    const quiet = candidate({ impressions: 300 });
    expect(qualityScore(popular)).toBeGreaterThan(qualityScore(quiet));
    // One like on one impression must not look like a 100% engagement rate.
    const lucky = candidate({ reactions: 1, impressions: 1 });
    expect(qualityScore(lucky)).toBeLessThan(0.5);
  });

  it('penalises posts people skip or mark not-interested', () => {
    const base = { reactions: 20, impressions: 200 };
    const liked = candidate(base);
    const disliked = candidate({ ...base, skips: 80, notInterested: 20 });
    expect(qualityScore(disliked)).toBeLessThan(qualityScore(liked));
  });

  it('uses video completion for video posts', () => {
    const finished = candidate({
      format: 'VIDEO',
      videoStarts: 50,
      videoCompletes: 45,
      impressions: 100,
    });
    const abandoned = candidate({
      format: 'VIDEO',
      videoStarts: 50,
      videoCompletes: 2,
      impressions: 100,
    });
    expect(qualityScore(finished)).toBeGreaterThan(qualityScore(abandoned));
  });

  it('applies learned affinity only for personalized viewers', () => {
    const c = candidate({
      authorId: 'A',
      sportKey: 'cycling',
      format: 'VIDEO',
      topics: ['gravel'],
    });
    const liked = taste({
      creator: new Map([['A', 1]]),
      sport: new Map([['cycling', 1]]),
      format: new Map([['VIDEO', 1]]),
      topic: new Map([['gravel', 1]]),
    });
    const neutral = scoreCandidate(c, taste(), NOW);
    const personalised = scoreCandidate(c, liked, NOW);
    expect(personalised.score).toBeGreaterThan(neutral.score);
    expect(personalised.reason).toBe('CREATOR_AFFINITY');

    // Personalization off: creator/format/topic are ignored, but a declared sport still counts.
    const off = scoreCandidate(c, { ...liked, personalized: false }, NOW);
    expect(off.signals.creatorAffinity).toBe(0);
    expect(off.signals.topicAffinity).toBe(0);
    expect(off.signals.sportAffinity).toBeGreaterThan(0);
    expect(off.reason).toBe('SPORT_INTEREST');
  });

  it('sinks posts the viewer already saw, but only when personalized', () => {
    expect([0, 1, 2, 3, 9].map(seenFactor)).toEqual([1, 0.5, 0.25, 0.1, 0.1]);
    const seen = candidate({ timesSeen: 2, isFollowed: true });
    const fresh = candidate({ isFollowed: true });
    expect(scoreCandidate(seen, taste(), NOW).score).toBeLessThan(
      scoreCandidate(fresh, taste(), NOW).score,
    );
    expect(scoreCandidate(seen, NEUTRAL_TASTE, NOW).score).toBe(
      scoreCandidate(fresh, NEUTRAL_TASTE, NOW).score,
    );
  });

  it('never recommends a non-followed author the viewer has rejected, but keeps followed ones', () => {
    const t = taste({ creator: new Map([['X', -0.7]]) });
    expect(isExcluded(candidate({ authorId: 'X' }), t)).toBe(true);
    expect(isExcluded(candidate({ authorId: 'X', isFollowed: true }), t)).toBe(false);
    expect(isExcluded(candidate({ authorId: 'X' }), { ...t, personalized: false })).toBe(false);
    expect(rank([candidate({ authorId: 'X' })], t, NOW)).toHaveLength(0);
  });

  it('does not boost sponsored content for people who did not follow the brand', () => {
    const organic = candidate();
    const sponsored = candidate({ sponsored: true });
    expect(scoreCandidate(sponsored, NEUTRAL_TASTE, NOW).score).toBeLessThan(
      scoreCandidate(organic, NEUTRAL_TASTE, NOW).score,
    );
    const followedSponsored = candidate({ sponsored: true, isFollowed: true });
    expect(scoreCandidate(followedSponsored, NEUTRAL_TASTE, NOW).signals.sponsoredPenalty).toBe(0);
  });

  it('never returns a negative score', () => {
    const hated = candidate({ authorId: 'Z', publishedAt: hoursAgo(5000) });
    const t = taste({ creator: new Map([['Z', -0.5]]), sport: new Map() });
    expect(scoreCandidate(hated, t, NOW).score).toBeGreaterThanOrEqual(0);
  });

  it('records every weighted signal for the serving log', () => {
    const { signals } = scoreCandidate(candidate({ isFollowed: true }), taste(), NOW);
    expect(Object.keys(signals).sort()).toEqual(
      [
        'creatorAffinity',
        'formatAffinity',
        'media',
        'popularity',
        'quality',
        'recency',
        'relationship',
        'seenFactor',
        'sponsoredPenalty',
        'sportAffinity',
        'topicAffinity',
      ].sort(),
    );
  });
});

describe('diversify', () => {
  const scored = (c: Candidate) => ({
    candidate: c,
    score: 1,
    reason: 'DISCOVERY' as const,
    signals: {},
  });

  it('spaces out one author instead of showing them back to back', () => {
    const a1 = scored(candidate({ authorId: 'A' }));
    const a2 = scored(candidate({ authorId: 'A' }));
    const a3 = scored(candidate({ authorId: 'A' }));
    const b = scored(candidate({ authorId: 'B' }));
    const c = scored(candidate({ authorId: 'C' }));
    const out = diversify([a1, a2, a3, b, c], HOME_DIVERSITY, 10);
    expect(out.map((o) => o.candidate.authorId)).toEqual(['A', 'B', 'C', 'A', 'A']);
  });

  it('enforces the per-author hard cap even when nothing else is left', () => {
    const items = Array.from({ length: 6 }, () => scored(candidate({ authorId: 'A' })));
    expect(diversify(items, EXPLORE_DIVERSITY, 10)).toHaveLength(EXPLORE_DIVERSITY.maxPerAuthor);
  });

  it('keeps sponsored items apart', () => {
    const items = [
      scored(candidate({ sponsored: true })),
      scored(candidate({ sponsored: true })),
      scored(candidate()),
      scored(candidate()),
    ];
    const out = diversify(items, HOME_DIVERSITY, 10);
    expect(out.map((o) => o.candidate.sponsored)).toEqual([true, false, false, true]);
  });

  it('honours the limit and never duplicates', () => {
    const items = Array.from({ length: 30 }, () => scored(candidate()));
    const out = diversify(items, HOME_DIVERSITY, 10);
    expect(out).toHaveLength(10);
    expect(new Set(out.map((o) => o.candidate.postId)).size).toBe(10);
  });
});

describe('interleave', () => {
  it('places one discovery item after every (n-1) primary items', () => {
    expect(interleave(['p1', 'p2', 'p3', 'p4', 'p5', 'p6'], ['d1', 'd2'], 4)).toEqual([
      'p1',
      'p2',
      'p3',
      'd1',
      'p4',
      'p5',
      'p6',
      'd2',
    ]);
  });

  it('lets discovery fill the feed when you follow nobody, and primary when discovery is empty', () => {
    expect(interleave([], ['d1', 'd2', 'd3'], 4)).toEqual(['d1', 'd2', 'd3']);
    expect(interleave(['p1', 'p2'], [], 4)).toEqual(['p1', 'p2']);
    expect(interleave([], [], 4)).toEqual([]);
  });
});

describe('affinities', () => {
  const event = (over: Partial<AffinityEvent>): AffinityEvent => ({
    type: 'LIKE',
    valueMs: null,
    createdAt: NOW,
    creatorId: 'creator-1',
    sportKey: 'running',
    format: 'VIDEO',
    topics: ['trail'],
    ...over,
  });

  it('weights actions by how much they reveal', () => {
    expect(eventWeight('IMPRESSION', null)).toBe(0);
    expect(eventWeight('SHARE', null)).toBeGreaterThan(eventWeight('LIKE', null));
    expect(eventWeight('NOT_INTERESTED', null)).toBeLessThan(0);
    expect(eventWeight('WATCH_TIME', 15_000)).toBeCloseTo(0.4);
    expect(eventWeight('WATCH_TIME', 600_000)).toBeCloseTo(0.8);
    expect(eventWeight('LIKE', null) + eventWeight('UNLIKE', null)).toBe(0);
  });

  it("halves an event's influence every 14 days", () => {
    expect(decay(0)).toBe(1);
    expect(decay(AFFINITY_HALF_LIFE_DAYS * 86_400_000)).toBeCloseTo(0.5);
    expect(decay(-5)).toBe(1);
  });

  it('builds scores per creator, sport, format and topic within (-1, 1)', () => {
    const scores = computeAffinities([event({}), event({}), event({ type: 'SHARE' })], NOW);
    const get = (type: string, key: string) =>
      scores.find((s) => s.subjectType === type && s.subjectKey === key)?.score;
    for (const [type, key] of [
      ['CREATOR', 'creator-1'],
      ['SPORT', 'running'],
      ['FORMAT', 'VIDEO'],
      ['TOPIC', 'trail'],
    ] as const) {
      const v = get(type, key);
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('a like followed by an unlike cancels out and leaves no affinity', () => {
    const scores = computeAffinities([event({}), event({ type: 'UNLIKE' })], NOW);
    expect(scores).toEqual([]);
  });

  it('repeated "not interested" drives a creator below the exclusion threshold (two strikes)', () => {
    const one = computeAffinities([event({ type: 'NOT_INTERESTED', topics: [] })], NOW);
    const two = computeAffinities(
      [
        event({ type: 'NOT_INTERESTED', topics: [] }),
        event({ type: 'NOT_INTERESTED', topics: [] }),
      ],
      NOW,
    );
    const creator = (list: typeof one) => list.find((s) => s.subjectType === 'CREATOR')?.score ?? 0;
    expect(creator(one)).toBeLessThan(0);
    expect(creator(one)).toBeGreaterThan(-0.6);
    expect(creator(two)).toBeLessThanOrEqual(-0.6);
  });

  it('forgets: old events fade below the noise floor', () => {
    const old = event({ createdAt: new Date(NOW.getTime() - 400 * 86_400_000) });
    expect(computeAffinities([old], NOW)).toEqual([]);
  });

  it('ignores impressions entirely', () => {
    expect(computeAffinities([event({ type: 'IMPRESSION' })], NOW)).toEqual([]);
  });

  it('handles events without a post (profile opens, topic interactions)', () => {
    const scores = computeAffinities(
      [
        event({ type: 'PROFILE_OPEN', sportKey: null, format: null, topics: [] }),
        event({
          type: 'TOPIC_INTERACTION',
          creatorId: null,
          sportKey: null,
          format: null,
          topics: ['marathon'],
        }),
      ],
      NOW,
    );
    expect(scores.map((s) => `${s.subjectType}:${s.subjectKey}`).sort()).toEqual([
      'CREATOR:creator-1',
      'TOPIC:marathon',
    ]);
  });
});
