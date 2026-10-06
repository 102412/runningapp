import type { Activity, Sport } from '@runningapp/contracts';

type DerivedSpeed = Activity['speed'];

/** Speed/pace derived from distance and moving time (falls back to elapsed time). */
export function deriveSpeed(
  distanceM: number | null,
  movingTimeS: number | null,
  elapsedTimeS: number,
  avgSpeedMps: number | null,
): DerivedSpeed {
  const time = movingTimeS && movingTimeS > 0 ? movingTimeS : elapsedTimeS;
  const speed =
    avgSpeedMps ?? (distanceM !== null && distanceM > 0 && time > 0 ? distanceM / time : null);
  if (speed === null || !(speed > 0)) {
    return {
      avgSpeedKph: null,
      avgSpeedMph: null,
      paceSecPerKm: null,
      paceSecPerMile: null,
      paceSecPer100m: null,
      paceSecPer500m: null,
    };
  }
  const r = (v: number): number => Math.round(v * 100) / 100;
  return {
    avgSpeedKph: r(speed * 3.6),
    avgSpeedMph: r(speed * 2.236936),
    paceSecPerKm: r(1000 / speed),
    paceSecPerMile: r(1609.344 / speed),
    paceSecPer100m: r(100 / speed),
    paceSecPer500m: r(500 / speed),
  };
}

const TITLE_NOUN: Record<string, string> = {
  running: 'Run',
  cross_country: 'Cross Country Run',
  track: 'Track Session',
  cycling: 'Ride',
  swimming: 'Swim',
  walking: 'Walk',
  hiking: 'Hike',
  strength_training: 'Strength Workout',
  workout: 'Workout',
  rowing: 'Row',
  triathlon: 'Triathlon',
  other: 'Activity',
};

/** "Morning Run", "Evening Ride"... from the activity's LOCAL start hour. */
export function defaultTitle(sport: string, startedAt: Date, timezone: string): string {
  let hour = startedAt.getUTCHours();
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(startedAt);
    hour = Number(parts.find((p) => p.type === 'hour')?.value ?? hour);
  } catch {
    /* unknown zone: fall back to UTC hour (validated earlier, so this is defensive) */
  }
  const when =
    hour < 5
      ? 'Night'
      : hour < 12
        ? 'Morning'
        : hour < 17
          ? 'Afternoon'
          : hour < 21
            ? 'Evening'
            : 'Night';
  return `${when} ${TITLE_NOUN[sport] ?? 'Activity'}`;
}

let zones: Set<string> | undefined;
export function isValidTimezone(tz: string): boolean {
  zones ??= new Set([...Intl.supportedValuesOf('timeZone'), 'UTC']);
  return zones.has(tz);
}

export interface MetricViolation {
  field: string;
  message: string;
}

/** Checks which provided metrics the sport actually supports (omitting a metric is always fine). */
export function unsupportedMetrics(
  sport: Sport,
  input: {
    distanceM?: number | undefined;
    elevationGainM?: number | undefined;
    elevationLossM?: number | undefined;
    metrics?:
      | {
          avgSpeedMps?: number | undefined;
          maxSpeedMps?: number | undefined;
          heartRate?: object | undefined;
          cadence?: object | undefined;
          power?: object | undefined;
          sportSpecific?: { swim?: object | undefined; strength?: object | undefined } | undefined;
        }
      | undefined;
    splits?: unknown[] | undefined;
    route?: unknown;
  },
): MetricViolation[] {
  const v: MetricViolation[] = [];
  const s = sport.supports;
  const flag = (cond: boolean, ok: boolean, field: string): void => {
    if (cond && !ok) v.push({ field, message: `"${sport.key}" does not support this metric.` });
  };
  flag(input.distanceM !== undefined, s.distance, 'distanceM');
  flag(
    input.metrics?.avgSpeedMps !== undefined || input.metrics?.maxSpeedMps !== undefined,
    s.distance,
    'metrics.avgSpeedMps',
  );
  flag(input.elevationGainM !== undefined, s.elevation, 'elevationGainM');
  flag(input.elevationLossM !== undefined, s.elevation, 'elevationLossM');
  flag(input.metrics?.heartRate !== undefined, s.heartRate, 'metrics.heartRate');
  flag(input.metrics?.cadence !== undefined, s.cadence, 'metrics.cadence');
  flag(input.metrics?.power !== undefined, s.power, 'metrics.power');
  flag(input.splits !== undefined && input.splits.length > 0, s.splits, 'splits');
  flag(input.route !== undefined, s.route, 'route');
  const swimOk = sport.key === 'swimming' || sport.key === 'triathlon';
  const strengthOk = sport.key === 'strength_training' || sport.key === 'workout';
  flag(input.metrics?.sportSpecific?.swim !== undefined, swimOk, 'metrics.sportSpecific.swim');
  flag(
    input.metrics?.sportSpecific?.strength !== undefined,
    strengthOk,
    'metrics.sportSpecific.strength',
  );
  return v;
}
