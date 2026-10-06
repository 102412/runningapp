import type { FeedEventType, PostFormat } from '@runningapp/contracts';

/**
 * Learned taste: turns a user's recent behavioural events into per-subject affinity scores in
 * (-1, 1). Pure and deterministic. Positive actions raise a subject's score, negative ones
 * (skip, "not interested", unlike, unfollow) lower it, and older events count for less.
 */

export type AffinitySubjectType = 'SPORT' | 'CREATOR' | 'FORMAT' | 'TOPIC';

export interface AffinityEvent {
  type: FeedEventType;
  valueMs: number | null;
  createdAt: Date;
  /** The post's author, or the profile the event was about (PROFILE_OPEN, FOLLOW...). */
  creatorId: string | null;
  sportKey: string | null;
  format: PostFormat | null;
  /** Topic slugs of the post, or the single topic of a TOPIC_INTERACTION. */
  topics: readonly string[];
}

export interface AffinityScore {
  subjectType: AffinitySubjectType;
  subjectKey: string;
  score: number;
}

export const AFFINITY_HALF_LIFE_DAYS = 14;
export const AFFINITY_LOOKBACK_DAYS = 60;
/** Raw weighted sums are squashed with tanh(raw / SCALE): about five strong actions saturate it. */
const SQUASH_SCALE = 5;
const MIN_ABS_SCORE = 0.03;
const MAX_PER_SUBJECT_TYPE = 100;
const DAY_MS = 86_400_000;

/** How much one event says about the user's taste (negative = dislike). */
export function eventWeight(type: FeedEventType, valueMs: number | null): number {
  switch (type) {
    case 'IMPRESSION':
      return 0; // being shown something is not interest
    case 'VIDEO_START':
      return 0.2;
    case 'VIDEO_COMPLETE':
      return 1;
    case 'WATCH_TIME':
      return Math.min(Math.max(valueMs ?? 0, 0) / 30_000, 1) * 0.8;
    case 'SKIP':
      return -0.4;
    case 'PROFILE_OPEN':
    case 'ACTIVITY_OPEN':
    case 'TOPIC_INTERACTION':
      return 0.6;
    case 'MEDIA_EXPAND':
      return 0.4;
    case 'NOT_INTERESTED':
      return -2.5;
    case 'LIKE':
      return 1;
    case 'UNLIKE':
      return -1;
    case 'COMMENT':
      return 1.5;
    case 'SHARE':
      return 2;
    case 'BOOKMARK':
      return 1.5;
    case 'UNBOOKMARK':
      return -1.5;
    case 'FOLLOW':
      return 2.5;
    case 'UNFOLLOW':
      return -2.5;
  }
}

export function decay(ageMs: number, halfLifeDays = AFFINITY_HALF_LIFE_DAYS): number {
  return 0.5 ** (Math.max(0, ageMs) / (halfLifeDays * DAY_MS));
}

export function computeAffinities(events: readonly AffinityEvent[], now: Date): AffinityScore[] {
  const raw = new Map<
    string,
    { subjectType: AffinitySubjectType; subjectKey: string; sum: number }
  >();
  const add = (subjectType: AffinitySubjectType, subjectKey: string, amount: number) => {
    const key = `${subjectType}:${subjectKey}`;
    const entry = raw.get(key) ?? { subjectType, subjectKey, sum: 0 };
    entry.sum += amount;
    raw.set(key, entry);
  };

  for (const e of events) {
    const weight = eventWeight(e.type, e.valueMs);
    if (weight === 0) continue;
    const w = weight * decay(now.getTime() - e.createdAt.getTime());
    if (e.creatorId) add('CREATOR', e.creatorId, w);
    if (e.sportKey) add('SPORT', e.sportKey, w);
    if (e.format) add('FORMAT', e.format, w);
    for (const topic of e.topics) add('TOPIC', topic, w);
  }

  const scored: AffinityScore[] = [];
  for (const { subjectType, subjectKey, sum } of raw.values()) {
    const score = Math.tanh(sum / SQUASH_SCALE);
    if (Math.abs(score) >= MIN_ABS_SCORE) scored.push({ subjectType, subjectKey, score });
  }

  // Keep the strongest signals per subject type (positive or negative).
  const byType = new Map<AffinitySubjectType, AffinityScore[]>();
  for (const s of scored) byType.set(s.subjectType, [...(byType.get(s.subjectType) ?? []), s]);
  const out: AffinityScore[] = [];
  for (const list of byType.values()) {
    list.sort(
      (a, b) => Math.abs(b.score) - Math.abs(a.score) || (a.subjectKey < b.subjectKey ? -1 : 1),
    );
    out.push(...list.slice(0, MAX_PER_SUBJECT_TYPE));
  }
  return out;
}
