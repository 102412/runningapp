import type { FeedItemReason, PostFormat } from '@runningapp/contracts';

/**
 * Ranking v1: a transparent, additive heuristic. Every function here is PURE (no I/O, no clock,
 * no randomness) so behaviour is deterministic, unit-testable and easy to replace with a learned
 * model later: the service builds `Candidate`s and a `Taste`, this module orders them.
 *
 * score = (recency + relationship + affinities + quality + popularity + media - penalties) * seenFactor
 *
 * Each term is individually weighted and returned in `signals`, which the serving log persists so
 * a future model can learn from exactly what the heuristic saw.
 */

export const ALGORITHM_VERSIONS = {
  FOLLOWING: 'chrono-v1',
  HOME: 'ranked-v1',
  EXPLORE: 'explore-v1',
} as const;

export interface Candidate {
  postId: string;
  authorId: string;
  publishedAt: Date;
  format: PostFormat;
  /** Sport of the attached activity, if any. */
  sportKey: string | null;
  topics: readonly string[];
  sponsored: boolean;
  authorIsCreator: boolean;
  isOwn: boolean;
  isFollowed: boolean;
  reactions: number;
  comments: number;
  shares: number;
  bookmarks: number;
  impressions: number;
  videoStarts: number;
  videoCompletes: number;
  skips: number;
  notInterested: number;
  /** How many times THIS viewer has already been shown the post (recent window). */
  timesSeen: number;
}

/** The viewer's taste, every value in [-1, 1]. Built by the service from explicit + learned data. */
export interface Taste {
  /** False when the user switched personalization off: behavioural signals are then ignored. */
  personalized: boolean;
  sport: ReadonlyMap<string, number>;
  creator: ReadonlyMap<string, number>;
  format: ReadonlyMap<string, number>;
  topic: ReadonlyMap<string, number>;
}

export const NEUTRAL_TASTE: Taste = {
  personalized: false,
  sport: new Map(),
  creator: new Map(),
  format: new Map(),
  topic: new Map(),
};

export interface RankingWeights {
  recency: number;
  recencyHalfLifeHours: number;
  followed: number;
  own: number;
  creatorAffinity: number;
  sportAffinity: number;
  formatAffinity: number;
  topicAffinity: number;
  quality: number;
  popularity: number;
  video: number;
  photo: number;
  /** Subtracted from sponsored content the viewer did not choose to follow. */
  sponsoredDiscoveryPenalty: number;
}

const DEFAULT_WEIGHTS: RankingWeights = {
  recency: 0.35,
  recencyHalfLifeHours: 36,
  followed: 0.3,
  own: 0.08,
  creatorAffinity: 0.2,
  sportAffinity: 0.15,
  formatAffinity: 0.05,
  topicAffinity: 0.1,
  quality: 0.2,
  popularity: 0.1,
  video: 0.05,
  photo: 0.02,
  sponsoredDiscoveryPenalty: 0.1,
};

export interface ScoredCandidate {
  candidate: Candidate;
  score: number;
  reason: FeedItemReason;
  /** Weighted contribution of each term (what the log stores). */
  signals: Record<string, number>;
}

const HOUR_MS = 3_600_000;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round4 = (v: number) => Math.round(v * 10_000) / 10_000;

/** Weighted engagement count: a comment or share says more than a reaction. */
function engagementCount(c: Pick<Candidate, 'reactions' | 'comments' | 'shares' | 'bookmarks'>) {
  return c.reactions + 2 * c.comments + 3 * c.shares + 1.5 * c.bookmarks;
}

/**
 * Quality in [0, 1]: smoothed engagement per impression (a Bayesian prior keeps tiny samples from
 * dominating), blended with video completion, minus a penalty for "not interested" and skips.
 */
export function qualityScore(c: Candidate): number {
  const PRIOR_IMPRESSIONS = 30;
  const PRIOR_ENGAGEMENT = 1;
  const GREAT_RATE = 0.15;
  const rate = (engagementCount(c) + PRIOR_ENGAGEMENT) / (c.impressions + PRIOR_IMPRESSIONS);
  const engagement = clamp(rate / GREAT_RATE, 0, 1);

  const base =
    c.format === 'VIDEO' && c.videoStarts > 0
      ? 0.6 * engagement + 0.4 * ((c.videoCompletes + 1) / (c.videoStarts + 3))
      : engagement;

  const negative = clamp(
    ((3 * c.notInterested + c.skips) / (c.impressions + PRIOR_IMPRESSIONS)) * 2,
    0,
    0.5,
  );
  return clamp(base - negative, 0, 1);
}

/** Log-scaled popularity in [0, 1]; 200 weighted engagements saturates it. */
function popularityScore(c: Candidate): number {
  return clamp(Math.log1p(engagementCount(c)) / Math.log1p(200), 0, 1);
}

export function recencyScore(publishedAt: Date, now: Date, halfLifeHours: number): number {
  const ageHours = Math.max(0, (now.getTime() - publishedAt.getTime()) / HOUR_MS);
  return 0.5 ** (ageHours / halfLifeHours);
}

/** Already-seen posts sink: 1, 0.5, 0.25, then 0.1. Only for personalized viewers. */
export function seenFactor(timesSeen: number): number {
  if (timesSeen <= 0) return 1;
  if (timesSeen === 1) return 0.5;
  if (timesSeen === 2) return 0.25;
  return 0.1;
}

/** Hard exclusion: never recommend (to a non-follower) an author the viewer clearly rejects. */
export function isExcluded(c: Candidate, taste: Taste): boolean {
  if (!taste.personalized || c.isFollowed || c.isOwn) return false;
  return (taste.creator.get(c.authorId) ?? 0) <= -0.6;
}

export function scoreCandidate(
  c: Candidate,
  taste: Taste,
  now: Date,
  w: RankingWeights = DEFAULT_WEIGHTS,
): ScoredCandidate {
  // Explicitly declared sports are folded into `taste.sport` by the caller even when
  // personalization is off, so sport affinity is always honoured; learned signals are gated here.
  const learned = taste.personalized;
  const creatorA = learned ? (taste.creator.get(c.authorId) ?? 0) : 0;
  const sportA = c.sportKey ? (taste.sport.get(c.sportKey) ?? 0) : 0;
  const formatA = learned ? (taste.format.get(c.format) ?? 0) : 0;
  const topicA = learned ? maxOf(c.topics.map((t) => taste.topic.get(t) ?? 0)) : 0;

  const quality = qualityScore(c);
  const popularity = popularityScore(c);
  const signals = {
    recency: w.recency * recencyScore(c.publishedAt, now, w.recencyHalfLifeHours),
    relationship: c.isOwn ? w.own : c.isFollowed ? w.followed : 0,
    creatorAffinity: w.creatorAffinity * creatorA,
    sportAffinity: w.sportAffinity * sportA,
    formatAffinity: w.formatAffinity * formatA,
    topicAffinity: w.topicAffinity * topicA,
    quality: w.quality * quality,
    popularity: w.popularity * popularity,
    media: c.format === 'VIDEO' ? w.video : c.format === 'PHOTO' ? w.photo : 0,
    sponsoredPenalty: c.sponsored && !c.isFollowed && !c.isOwn ? -w.sponsoredDiscoveryPenalty : 0,
  };
  const sum = Object.values(signals).reduce((a, b) => a + b, 0);
  const seen = learned ? seenFactor(c.timesSeen) : 1;
  const score = Math.max(0, sum) * seen;

  return {
    candidate: c,
    score: round4(score),
    reason: pickReason(c, signals, w),
    signals: Object.fromEntries(
      Object.entries({ ...signals, seenFactor: seen }).map(([k, v]) => [k, round4(v)]),
    ),
  };
}

function maxOf(values: number[]): number {
  return values.length === 0 ? 0 : Math.max(...values);
}

function pickReason(
  c: Candidate,
  s: { creatorAffinity: number; sportAffinity: number; popularity: number; quality: number },
  w: RankingWeights,
): FeedItemReason {
  if (c.isOwn) return 'OWN_POST';
  if (c.isFollowed) return 'FOLLOWED_AUTHOR';
  // Non-followed: the strongest positive reason wins (ties: creator > sport > trending).
  const options: Array<[FeedItemReason, number]> = [
    ['CREATOR_AFFINITY', s.creatorAffinity],
    ['SPORT_INTEREST', s.sportAffinity],
    ['TRENDING', s.popularity + s.quality - w.quality * 0.35],
  ];
  const MIN = 0.03;
  let best: FeedItemReason = 'DISCOVERY';
  let bestValue = MIN;
  for (const [reason, value] of options) {
    if (value > bestValue) {
      best = reason;
      bestValue = value;
    }
  }
  return best;
}

/** Orders by score (desc), newest first on ties, then id for total determinism. */
export function rank(
  candidates: readonly Candidate[],
  taste: Taste,
  now: Date,
  weights: RankingWeights = DEFAULT_WEIGHTS,
): ScoredCandidate[] {
  return candidates
    .filter((c) => !isExcluded(c, taste))
    .map((c) => scoreCandidate(c, taste, now, weights))
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.candidate.publishedAt.getTime() - a.candidate.publishedAt.getTime() ||
        (a.candidate.postId < b.candidate.postId ? 1 : -1),
    );
}

export interface DiversityRules {
  /** Hard cap on items from one author in the whole list. */
  maxPerAuthor: number;
  /** Prefer at least this many other items between two items of the same author. */
  minAuthorGap: number;
  /** Prefer at most one sponsored item in any run of this many consecutive items. */
  sponsoredWindow: number;
}

export const HOME_DIVERSITY: DiversityRules = {
  maxPerAuthor: 5,
  minAuthorGap: 2,
  sponsoredWindow: 5,
};
export const EXPLORE_DIVERSITY: DiversityRules = {
  maxPerAuthor: 2,
  minAuthorGap: 3,
  sponsoredWindow: 5,
};

/**
 * Greedy re-ranking that keeps the input order as far as the rules allow: each slot takes the
 * best remaining item that respects author spacing and sponsored density; if none does, the
 * soft rules are relaxed (the per-author cap never is).
 */
export function diversify<T extends { candidate: Candidate }>(
  ordered: readonly T[],
  rules: DiversityRules,
  limit: number,
): T[] {
  const remaining = [...ordered];
  const out: T[] = [];
  const perAuthor = new Map<string, number>();

  const underCap = (t: T) => (perAuthor.get(t.candidate.authorId) ?? 0) < rules.maxPerAuthor;
  const respectsSoftRules = (t: T) => {
    const recentAuthors = out.slice(-rules.minAuthorGap).map((o) => o.candidate.authorId);
    if (recentAuthors.includes(t.candidate.authorId)) return false;
    if (t.candidate.sponsored) {
      const recent = out.slice(-(rules.sponsoredWindow - 1));
      if (recent.some((o) => o.candidate.sponsored)) return false;
    }
    return true;
  };

  while (remaining.length > 0 && out.length < limit) {
    let index = remaining.findIndex((t) => underCap(t) && respectsSoftRules(t));
    if (index === -1) index = remaining.findIndex(underCap);
    if (index === -1) break;
    const [pick] = remaining.splice(index, 1);
    if (!pick) break;
    out.push(pick);
    perAuthor.set(pick.candidate.authorId, (perAuthor.get(pick.candidate.authorId) ?? 0) + 1);
  }
  return out;
}

/**
 * Home mixes the two pools: after every `discoveryEvery - 1` items from the people you follow
 * comes one discovery item. When one pool runs dry the other fills the rest (so a user who follows
 * nobody simply gets discovery content).
 */
export function interleave<T>(
  primary: readonly T[],
  discovery: readonly T[],
  discoveryEvery: number,
): T[] {
  const out: T[] = [];
  let p = 0;
  let d = 0;
  while (p < primary.length || d < discovery.length) {
    const discoverySlot = (out.length + 1) % discoveryEvery === 0;
    if ((discoverySlot && d < discovery.length) || p >= primary.length) {
      const next = discovery[d++];
      if (next !== undefined) out.push(next);
    } else {
      const next = primary[p++];
      if (next !== undefined) out.push(next);
    }
  }
  return out;
}
