import { sql } from 'kysely';
import { z } from 'zod';
import type {
  Activity,
  CreateActivityRequest,
  RecordType,
  RoutePrivacy,
  RouteView,
  SportKey,
  UpdateActivityRequest,
} from '@runningapp/contracts';
import type { Clock } from '../../platform/clock';
import type { Db } from '../../platform/db/client';
import { keysetBefore, timestampText } from '../../platform/db/keyset';
import { AppError } from '../../platform/errors';
import { decodeCursor, encodeCursor, sliceProbe } from '../../platform/http/cursor';
import { contentVisibleTo } from '../social/visibility';
import type { SportService } from '../sports/service';
import type { AgePolicy } from '../users/age-policy';
import type { UserDirectory } from '../users/directory';
import { deriveSpeed, defaultTitle, isValidTimezone, unsupportedMetrics } from './metrics';
import {
  applyRoutePrivacy,
  boundingBox,
  decodePolyline,
  encodePolyline,
  PolylineError,
  simplifyToMax,
  type LatLon,
  type PrivacyZone,
} from './geo';
import type { ImportedActivity } from './gpx';

const TimeCursor = z.object({ t: z.string(), id: z.uuid() });
const PREVIEW_MAX_POINTS = 120;
const DETAIL_MAX_POINTS = 2000;
const MAX_ZONES_PER_USER = 10;
const MIN_START = Date.UTC(2000, 0, 1);
const MAX_AVG_SPEED_MPS = 60;
const FUTURE_SKEW_MS = 10 * 60_000;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface CreateOptions {
  source?: 'MANUAL' | 'FILE_IMPORT';
  externalId?: string;
  /** Pass a transaction to compose with other writes (e.g. creating the activity post). */
  db?: Db;
  /** Imported splits are server-computed; they bypass the sport-capability check. */
  skipCapabilityCheck?: boolean;
}

interface ActivityRow {
  id: string;
  userId: string;
  sportKey: string;
  subtype: string | null;
  isRace: boolean;
  title: string;
  description: string;
  startedAt: Date;
  timezone: string;
  elapsedTimeS: number;
  movingTimeS: number | null;
  distanceM: number | null;
  elevationGainM: number | null;
  elevationLossM: number | null;
  caloriesKcal: number | null;
  visibility: Activity['visibility'];
  routePrivacy: RoutePrivacy;
  source: Activity['source'];
  locationLabel: string | null;
  createdAt: Date;
}

const ACTIVITY_COLUMNS = [
  'a.id',
  'a.userId',
  'a.sportKey',
  'a.subtype',
  'a.isRace',
  'a.title',
  'a.description',
  'a.startedAt',
  'a.timezone',
  'a.elapsedTimeS',
  'a.movingTimeS',
  'a.distanceM',
  'a.elevationGainM',
  'a.elevationLossM',
  'a.caloriesKcal',
  'a.visibility',
  'a.routePrivacy',
  'a.source',
  'a.locationLabel',
  'a.createdAt',
] as const;

export class ActivityService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly sports: SportService,
    private readonly directory: UserDirectory,
    private readonly agePolicy: AgePolicy,
  ) {}

  // ------------------------------------------------------------------ create

  /** Returns the new activity id (or the existing one for an already-imported external id). */
  async create(
    userId: string,
    input: CreateActivityRequest,
    options: CreateOptions = {},
  ): Promise<{ id: string; created: boolean }> {
    const db = options.db ?? this.db;
    const sport = await this.sports.get(input.sport);
    const startedAt = new Date(input.startedAt);
    const timezone = input.timezone ?? 'UTC';
    this.validate(sport, input, startedAt, timezone, options.skipCapabilityCheck === true);

    let routePoints: LatLon[] | undefined;
    if (input.route) {
      try {
        routePoints = input.route.points
          ? input.route.points.map((p) => [p[0], p[1]] as LatLon)
          : decodePolyline(input.route.polyline ?? '');
      } catch (err) {
        if (err instanceof PolylineError) {
          throw new AppError('VALIDATION_FAILED', {
            details: [{ path: 'route.polyline', message: err.message }],
          });
        }
        throw err;
      }
      if (routePoints.length < 2) {
        throw new AppError('VALIDATION_FAILED', {
          details: [{ path: 'route', message: 'A route needs at least 2 points.' }],
        });
      }
    }

    const settings = await db
      .selectFrom('userSettings')
      .select(['defaultActivityVisibility', 'defaultRoutePrivacy'])
      .where('userId', '=', userId)
      .executeTakeFirstOrThrow();
    const visibility = input.visibility ?? settings.defaultActivityVisibility;
    await this.agePolicy.assertVisibilityAllowed(userId, visibility, db);
    const routePrivacy = input.routePrivacy ?? settings.defaultRoutePrivacy;

    const write = async (trx: Db): Promise<{ id: string; created: boolean }> => {
      const source = options.source ?? 'MANUAL';
      const inserted = await trx
        .insertInto('activities')
        .values({
          userId,
          sportKey: input.sport,
          subtype: input.subtype ?? null,
          isRace: input.isRace ?? false,
          title: input.title ?? defaultTitle(input.sport, startedAt, timezone),
          description: input.description ?? '',
          startedAt,
          timezone,
          elapsedTimeS: input.elapsedTimeS,
          movingTimeS: input.movingTimeS ?? null,
          distanceM: input.distanceM ?? null,
          elevationGainM: input.elevationGainM ?? null,
          elevationLossM: input.elevationLossM ?? null,
          caloriesKcal: input.caloriesKcal ?? null,
          visibility,
          routePrivacy,
          source,
          externalId: options.externalId ?? null,
          locationLabel: input.locationLabel ?? null,
        })
        .onConflict((oc) => oc.doNothing())
        .returning('id')
        .executeTakeFirst();

      if (!inserted) {
        // Idempotent import: the same external activity already exists for this user.
        const existing = await trx
          .selectFrom('activities')
          .select('id')
          .where('userId', '=', userId)
          .where('source', '=', source)
          .where('externalId', '=', options.externalId ?? '')
          .executeTakeFirst();
        if (!existing)
          throw new AppError('INVALID_STATE', {
            message: 'Activity conflicts with an existing one.',
          });
        return { id: existing.id, created: false };
      }
      const id = inserted.id;

      const m = input.metrics;
      const extra = m?.sportSpecific ? JSON.stringify(m.sportSpecific) : '{}';
      if (m) {
        await trx
          .insertInto('activityMetrics')
          .values({
            activityId: id,
            avgSpeedMps: m.avgSpeedMps ?? null,
            maxSpeedMps: m.maxSpeedMps ?? null,
            avgHeartRateBpm: m.heartRate?.avgBpm ?? null,
            maxHeartRateBpm: m.heartRate?.maxBpm ?? null,
            avgCadence: m.cadence?.avg ?? null,
            maxCadence: m.cadence?.max ?? null,
            avgPowerW: m.power?.avgW ?? null,
            maxPowerW: m.power?.maxW ?? null,
            normalizedPowerW: m.power?.normalizedW ?? null,
            avgTemperatureC: m.temperatureC ?? null,
            extra,
          })
          .execute();
      }

      if (input.splits && input.splits.length > 0) {
        const indexByType = new Map<string, number>();
        await trx
          .insertInto('activitySplits')
          .values(
            input.splits.map((sp) => {
              const index = indexByType.get(sp.type) ?? 0;
              indexByType.set(sp.type, index + 1);
              return {
                activityId: id,
                splitType: sp.type,
                splitIndex: index,
                distanceM: sp.distanceM ?? null,
                elapsedTimeS: sp.elapsedTimeS,
                elevationDiffM: sp.elevationDiffM ?? null,
                avgHeartRateBpm: sp.avgHeartRateBpm ?? null,
                avgSpeedMps: sp.avgSpeedMps ?? null,
              };
            }),
          )
          .execute();
      }

      if (routePoints) {
        await trx
          .insertInto('activityRoutes')
          .values({
            activityId: id,
            polyline: encodePolyline(routePoints),
            pointCount: routePoints.length,
          })
          .execute();
      }

      await this.recordPersonalBests(trx, userId, id, input.sport, startedAt, {
        distanceM: input.distanceM,
        elapsedTimeS: input.elapsedTimeS,
        movingTimeS: input.movingTimeS,
        elevationGainM: input.elevationGainM,
      });
      return { id, created: true };
    };

    return options.db ? write(options.db) : this.db.transaction().execute((trx) => write(trx));
  }

  /** Converts a parsed GPX file into a create request (imports are server-derived, not user-typed). */
  fromImport(
    imported: ImportedActivity,
    overrides: {
      sport: SportKey;
      title?: string | undefined;
      timezone?: string | undefined;
      visibility?: CreateActivityRequest['visibility'];
      routePrivacy?: CreateActivityRequest['routePrivacy'];
      isRace?: boolean | undefined;
    },
  ): CreateActivityRequest {
    const request: CreateActivityRequest = {
      sport: overrides.sport,
      title: overrides.title ?? imported.title,
      startedAt: imported.startedAt.toISOString(),
      timezone: overrides.timezone,
      elapsedTimeS: imported.elapsedTimeS,
      movingTimeS: imported.movingTimeS,
      distanceM: imported.distanceM,
      elevationGainM: imported.elevationGainM,
      elevationLossM: imported.elevationLossM,
      isRace: overrides.isRace,
      visibility: overrides.visibility,
      routePrivacy: overrides.routePrivacy,
      metrics: {
        maxSpeedMps: imported.maxSpeedMps,
        ...(imported.avgHeartRateBpm !== undefined
          ? { heartRate: { avgBpm: imported.avgHeartRateBpm, maxBpm: imported.maxHeartRateBpm } }
          : {}),
      },
      splits: imported.splits.map((s) => ({
        type: 'KM' as const,
        distanceM: s.distanceM,
        elapsedTimeS: s.elapsedTimeS,
        elevationDiffM: s.elevationDiffM,
      })),
      route: { polyline: encodePolyline(imported.route) },
    };
    return JSON.parse(JSON.stringify(request)) as CreateActivityRequest; // drop undefined keys
  }

  private validate(
    sport: Awaited<ReturnType<SportService['get']>>,
    input: CreateActivityRequest,
    startedAt: Date,
    timezone: string,
    skipCapabilityCheck: boolean,
  ): void {
    const details: Array<{ path: string; message: string }> = [];
    const now = this.clock.now().getTime();
    if (startedAt.getTime() < MIN_START)
      details.push({ path: 'startedAt', message: 'Too far in the past.' });
    if (startedAt.getTime() > now + FUTURE_SKEW_MS)
      details.push({ path: 'startedAt', message: 'Cannot be in the future.' });
    if (!isValidTimezone(timezone))
      details.push({ path: 'timezone', message: 'Unknown IANA timezone.' });
    if (input.movingTimeS !== undefined && input.movingTimeS > input.elapsedTimeS) {
      details.push({ path: 'movingTimeS', message: 'Cannot exceed elapsedTimeS.' });
    }
    const time =
      input.movingTimeS && input.movingTimeS > 0 ? input.movingTimeS : input.elapsedTimeS;
    if (input.distanceM !== undefined && time > 0 && input.distanceM / time > MAX_AVG_SPEED_MPS) {
      details.push({
        path: 'distanceM',
        message: 'Implausible average speed; check units (metres and seconds).',
      });
    }
    const m = input.metrics;
    if (
      m?.heartRate?.avgBpm !== undefined &&
      m.heartRate.maxBpm !== undefined &&
      m.heartRate.avgBpm > m.heartRate.maxBpm
    ) {
      details.push({ path: 'metrics.heartRate.avgBpm', message: 'Average cannot exceed maximum.' });
    }
    if (details.length > 0) throw new AppError('VALIDATION_FAILED', { details });

    if (!skipCapabilityCheck) {
      const violations = unsupportedMetrics(sport, input);
      if (violations.length > 0) {
        throw new AppError('METRIC_NOT_SUPPORTED_FOR_SPORT', {
          details: violations.map((v) => ({ path: v.field, message: v.message })),
        });
      }
    }
  }

  // ------------------------------------------------------------------ personal records

  private async recordPersonalBests(
    db: Db,
    userId: string,
    activityId: string,
    sport: string,
    startedAt: Date,
    a: {
      distanceM: number | undefined;
      elapsedTimeS: number;
      movingTimeS: number | undefined;
      elevationGainM: number | undefined;
    },
  ): Promise<void> {
    type Candidate = { type: RecordType; value: number; better: 'MAX' | 'MIN' };
    const candidates: Candidate[] = [];
    if (a.distanceM !== undefined && a.distanceM > 0)
      candidates.push({ type: 'LONGEST_DISTANCE', value: a.distanceM, better: 'MAX' });
    if (a.elapsedTimeS > 0)
      candidates.push({ type: 'LONGEST_DURATION', value: a.elapsedTimeS, better: 'MAX' });
    if (a.elevationGainM !== undefined && a.elevationGainM > 0)
      candidates.push({ type: 'BIGGEST_CLIMB', value: a.elevationGainM, better: 'MAX' });

    // Fastest standard-distance efforts: only for pace sports, and only when the logged distance is
    // within 2.5% above the standard distance (GPS tracks overshoot slightly).
    if (['running', 'track', 'cross_country'].includes(sport) && a.distanceM !== undefined) {
      const time = a.movingTimeS && a.movingTimeS > 0 ? a.movingTimeS : a.elapsedTimeS;
      const standards: Array<[RecordType, number]> = [
        ['FASTEST_5K', 5000],
        ['FASTEST_10K', 10_000],
        ['FASTEST_HALF_MARATHON', 21_097.5],
        ['FASTEST_MARATHON', 42_195],
      ];
      for (const [type, meters] of standards) {
        if (a.distanceM >= meters && a.distanceM <= meters * 1.025 && time > 0)
          candidates.push({ type, value: time, better: 'MIN' });
      }
    }

    for (const c of candidates) {
      const best = await db
        .selectFrom('activityRecords')
        .select(
          c.better === 'MAX'
            ? sql<number>`max(value)`.as('best')
            : sql<number>`min(value)`.as('best'),
        )
        .where('userId', '=', userId)
        .where('recordType', '=', c.type)
        .executeTakeFirst();
      const previous = best?.best ?? null;
      const beats =
        previous === null || (c.better === 'MAX' ? c.value > previous : c.value < previous);
      if (beats) {
        await db
          .insertInto('activityRecords')
          .values({
            userId,
            activityId,
            recordType: c.type,
            value: c.value,
            previousValue: previous,
            achievedAt: startedAt,
          })
          .onConflict((oc) => oc.doNothing())
          .execute();
      }
    }
  }

  // ------------------------------------------------------------------ read

  async get(
    viewerId: string | null,
    id: string,
    options: { includeSplits?: boolean } = {},
  ): Promise<Activity> {
    const row = await this.db
      .selectFrom('activities as a')
      .innerJoin('users as au', 'au.id', 'a.userId')
      .innerJoin('profiles as ap', 'ap.userId', 'a.userId')
      .select(ACTIVITY_COLUMNS)
      .where('a.id', '=', id)
      .where(this.visible(viewerId))
      .executeTakeFirst();
    if (!row) throw new AppError('ACTIVITY_NOT_FOUND');
    const [activity] = await this.hydrate(viewerId, [row], {
      includeSplits: options.includeSplits ?? true,
    });
    if (!activity) throw new AppError('ACTIVITY_NOT_FOUND');
    return activity;
  }

  async list(
    viewerId: string | null,
    ownerId: string,
    args: { limit: number; cursor?: string | undefined; sport?: string | undefined },
  ): Promise<Page<Activity>> {
    const cursor = args.cursor ? decodeCursor(args.cursor, TimeCursor) : undefined;
    let q = this.db
      .selectFrom('activities as a')
      .innerJoin('users as au', 'au.id', 'a.userId')
      .innerJoin('profiles as ap', 'ap.userId', 'a.userId')
      .select([...ACTIVITY_COLUMNS, timestampText('a.started_at').as('ts')])
      .where('a.userId', '=', ownerId)
      .where(this.visible(viewerId))
      .orderBy('a.startedAt', 'desc')
      .orderBy('a.id', 'desc')
      .limit(args.limit + 1);
    if (args.sport) q = q.where('a.sportKey', '=', args.sport);
    if (cursor) q = q.where(keysetBefore('a.started_at', 'a.id', cursor));
    const { page, hasMore } = sliceProbe(await q.execute(), args.limit);
    const items = await this.hydrate(viewerId, page, { includeSplits: false });
    const last = page[page.length - 1];
    return {
      items,
      nextCursor: hasMore && last ? encodeCursor({ t: last.ts, id: last.id }) : null,
    };
  }

  /** Visibility predicate for standalone activity access. */
  private visible(viewerId: string | null) {
    return contentVisibleTo(viewerId, {
      authorId: 'a.user_id',
      authorStatus: 'au.status',
      authorAccountVisibility: 'ap.account_visibility',
      visibility: 'a.visibility',
    });
  }

  /**
   * Hydrates activities for presentation in 4-6 queries regardless of count. Callers are
   * responsible for having authorised access to `ids` (either via the standalone-activity
   * visibility predicate or because the activity is embedded in a post the viewer can see).
   */
  async hydrateByIds(
    viewerId: string | null,
    ids: readonly string[],
    options: { includeSplits?: boolean } = {},
  ): Promise<Map<string, Activity>> {
    const out = new Map<string, Activity>();
    if (ids.length === 0) return out;
    const rows = await this.db
      .selectFrom('activities as a')
      .select(ACTIVITY_COLUMNS)
      .where('a.id', 'in', [...new Set(ids)])
      .execute();
    for (const a of await this.hydrate(viewerId, rows, options)) out.set(a.id, a);
    return out;
  }

  private async hydrate(
    viewerId: string | null,
    rows: ActivityRow[],
    options: { includeSplits?: boolean },
  ): Promise<Activity[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const ownerIds = [...new Set(rows.map((r) => r.userId))];

    const [metricsRows, recordRows, splitRows, routeRows, zoneRows, trimRows, users] =
      await Promise.all([
        this.db.selectFrom('activityMetrics').selectAll().where('activityId', 'in', ids).execute(),
        this.db
          .selectFrom('activityRecords')
          .select(['activityId', 'recordType', 'value', 'previousValue'])
          .where('activityId', 'in', ids)
          .execute(),
        options.includeSplits
          ? this.db
              .selectFrom('activitySplits')
              .selectAll()
              .where('activityId', 'in', ids)
              .orderBy('splitType')
              .orderBy('splitIndex')
              .execute()
          : Promise.resolve([]),
        this.db
          .selectFrom('activityRoutes')
          .select(['activityId', 'polyline'])
          .where('activityId', 'in', ids)
          .execute(),
        this.db
          .selectFrom('privacyZones')
          .select(['userId', 'centerLat', 'centerLon', 'radiusM'])
          .where('userId', 'in', ownerIds)
          .execute(),
        this.db
          .selectFrom('userSettings')
          .select(['userId', 'routeTrimMeters'])
          .where('userId', 'in', ownerIds)
          .execute(),
        this.directory.summaries(ownerIds),
      ]);

    const metrics = new Map(metricsRows.map((m) => [m.activityId, m]));
    const routes = new Map(routeRows.map((r) => [r.activityId, r.polyline]));
    const trim = new Map(trimRows.map((t) => [t.userId, t.routeTrimMeters]));
    const zonesByUser = new Map<string, PrivacyZone[]>();
    for (const z of zoneRows) {
      const list = zonesByUser.get(z.userId) ?? [];
      list.push({ lat: z.centerLat, lon: z.centerLon, radiusM: z.radiusM });
      zonesByUser.set(z.userId, list);
    }

    const out: Activity[] = [];
    for (const a of rows) {
      const user = users.get(a.userId);
      if (!user) continue;
      const m = metrics.get(a.id);
      const isOwner = viewerId === a.userId;
      const polyline = routes.get(a.id);
      const preview = polyline
        ? this.renderRoute(polyline, {
            isOwner,
            privacy: a.routePrivacy,
            trimMeters: trim.get(a.userId) ?? 200,
            zones: zonesByUser.get(a.userId) ?? [],
            maxPoints: PREVIEW_MAX_POINTS,
          })
        : null;

      out.push({
        id: a.id,
        user,
        sport: a.sportKey as SportKey,
        subtype: a.subtype,
        isRace: a.isRace,
        title: a.title,
        description: a.description,
        startedAt: a.startedAt.toISOString(),
        timezone: a.timezone,
        elapsedTimeS: a.elapsedTimeS,
        movingTimeS: a.movingTimeS,
        distanceM: a.distanceM,
        elevationGainM: a.elevationGainM,
        elevationLossM: a.elevationLossM,
        caloriesKcal: a.caloriesKcal,
        speed: deriveSpeed(a.distanceM, a.movingTimeS, a.elapsedTimeS, m?.avgSpeedMps ?? null),
        metrics: {
          avgSpeedMps: m?.avgSpeedMps ?? null,
          maxSpeedMps: m?.maxSpeedMps ?? null,
          heartRate: { avgBpm: m?.avgHeartRateBpm ?? null, maxBpm: m?.maxHeartRateBpm ?? null },
          cadence: { avg: m?.avgCadence ?? null, max: m?.maxCadence ?? null },
          power: {
            avgW: m?.avgPowerW ?? null,
            maxW: m?.maxPowerW ?? null,
            normalizedW: m?.normalizedPowerW ?? null,
          },
          temperatureC: m?.avgTemperatureC ?? null,
          sportSpecific:
            m && Object.keys(m.extra as object).length > 0
              ? (m.extra as Activity['metrics']['sportSpecific'])
              : null,
        },
        splits: options.includeSplits
          ? splitRows
              .filter((s) => s.activityId === a.id)
              .map((s) => ({
                type: s.splitType,
                index: s.splitIndex,
                distanceM: s.distanceM,
                elapsedTimeS: s.elapsedTimeS,
                elevationDiffM: s.elevationDiffM,
                avgHeartRateBpm: s.avgHeartRateBpm,
                avgSpeedMps: s.avgSpeedMps,
              }))
          : null,
        hasRoute: preview !== null,
        routePreview: preview,
        records: recordRows
          .filter((r) => r.activityId === a.id)
          .map((r) => ({ type: r.recordType, value: r.value, previousValue: r.previousValue })),
        visibility: a.visibility,
        source: a.source,
        locationLabel: a.locationLabel,
        ownerPrivacy: isOwner ? { routePrivacy: a.routePrivacy } : null,
        createdAt: a.createdAt.toISOString(),
      });
    }
    return out;
  }

  /**
   * The single place where a stored track becomes something a viewer receives. Owners get their
   * real route; everyone else gets the privacy-transformed one (see geo.applyRoutePrivacy).
   */
  private renderRoute(
    polyline: string,
    ctx: {
      isOwner: boolean;
      privacy: RoutePrivacy;
      trimMeters: number;
      zones: PrivacyZone[];
      maxPoints: number;
    },
  ): RouteView | null {
    let points: LatLon[];
    try {
      points = decodePolyline(polyline);
    } catch {
      return null; // corrupt stored data must never become a 500 on a feed
    }
    const original = points.length;
    const segments = ctx.isOwner
      ? [points]
      : applyRoutePrivacy({
          points,
          mode: ctx.privacy,
          trimMeters: ctx.trimMeters,
          zones: ctx.zones,
        });
    if (!segments) return null;

    const shown = segments.reduce((n, s) => n + s.length, 0);
    const budget = Math.max(2, Math.floor(ctx.maxPoints / segments.length));
    const simplified = segments.map((s) => simplifyToMax(s, budget));
    const box = boundingBox(simplified);
    if (!box) return null;
    return {
      segments: simplified.map((s) => encodePolyline(s)),
      precision: 5,
      bbox: box,
      isPrivacyFiltered: !ctx.isOwner && (segments.length > 1 || shown < original),
    };
  }

  async getRoute(
    viewerId: string | null,
    id: string,
    view: 'OWNER' | 'PUBLIC',
  ): Promise<RouteView> {
    const row = await this.db
      .selectFrom('activities as a')
      .innerJoin('users as au', 'au.id', 'a.userId')
      .innerJoin('profiles as ap', 'ap.userId', 'a.userId')
      .innerJoin('activityRoutes as r', 'r.activityId', 'a.id')
      .innerJoin('userSettings as us', 'us.userId', 'a.userId')
      .select(['a.userId', 'a.routePrivacy', 'r.polyline', 'us.routeTrimMeters'])
      .where('a.id', '=', id)
      .where(this.visible(viewerId))
      .executeTakeFirst();
    if (!row) throw new AppError('ACTIVITY_NOT_FOUND');
    const zones = await this.db
      .selectFrom('privacyZones')
      .select(['centerLat', 'centerLon', 'radiusM'])
      .where('userId', '=', row.userId)
      .execute();
    const isOwner = viewerId === row.userId && view === 'OWNER';
    const route = this.renderRoute(row.polyline, {
      isOwner,
      privacy: row.routePrivacy,
      trimMeters: row.routeTrimMeters,
      zones: zones.map((z) => ({ lat: z.centerLat, lon: z.centerLon, radiusM: z.radiusM })),
      maxPoints: DETAIL_MAX_POINTS,
    });
    if (!route)
      throw new AppError('ACTIVITY_NOT_FOUND', {
        message: 'This activity has no route you can view.',
      });
    return route;
  }

  /** Throws ACTIVITY_NOT_FOUND unless `userId` owns the activity (someone else's is "not found"). */
  async assertOwned(userId: string, id: string, db: Db = this.db): Promise<void> {
    const row = await db
      .selectFrom('activities')
      .select('id')
      .where('id', '=', id)
      .where('userId', '=', userId)
      .executeTakeFirst();
    if (!row) throw new AppError('ACTIVITY_NOT_FOUND');
  }

  // ------------------------------------------------------------------ update / delete

  /** Applies an edit using `db` (pass a transaction to compose). Read the result AFTER it commits. */
  async update(
    userId: string,
    id: string,
    patch: UpdateActivityRequest,
    db: Db = this.db,
  ): Promise<void> {
    const existing = await db
      .selectFrom('activities')
      .select(['id'])
      .where('id', '=', id)
      .where('userId', '=', userId)
      .executeTakeFirst();
    if (!existing) throw new AppError('ACTIVITY_NOT_FOUND'); // not yours == not found
    if (patch.visibility !== undefined)
      await this.agePolicy.assertVisibilityAllowed(userId, patch.visibility, db);

    const set: Record<string, unknown> = {};
    for (const key of [
      'title',
      'description',
      'subtype',
      'isRace',
      'visibility',
      'routePrivacy',
      'locationLabel',
    ] as const) {
      if (patch[key] !== undefined) set[key] = patch[key];
    }
    if (Object.keys(set).length > 0) {
      await db
        .updateTable('activities')
        .set(set)
        .where('id', '=', id)
        .where('userId', '=', userId)
        .execute();
    }
  }

  async delete(userId: string, id: string, db: Db = this.db): Promise<void> {
    const res = await db
      .deleteFrom('activities')
      .where('id', '=', id)
      .where('userId', '=', userId)
      .executeTakeFirst();
    if (Number(res.numDeletedRows) === 0) throw new AppError('ACTIVITY_NOT_FOUND');
  }

  // ------------------------------------------------------------------ privacy zones

  async listZones(userId: string) {
    const rows = await this.db
      .selectFrom('privacyZones')
      .selectAll()
      .where('userId', '=', userId)
      .orderBy('createdAt')
      .execute();
    return rows.map((z) => ({
      id: z.id,
      label: z.label,
      lat: z.centerLat,
      lon: z.centerLon,
      radiusM: z.radiusM,
      createdAt: z.createdAt.toISOString(),
    }));
  }

  async createZone(
    userId: string,
    input: { label: string; lat: number; lon: number; radiusM: number },
  ) {
    const count = await this.db
      .selectFrom('privacyZones')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('userId', '=', userId)
      .executeTakeFirstOrThrow();
    if (Number(count.n) >= MAX_ZONES_PER_USER) {
      throw new AppError('VALIDATION_FAILED', {
        details: [{ path: 'label', message: `At most ${MAX_ZONES_PER_USER} privacy zones.` }],
      });
    }
    const row = await this.db
      .insertInto('privacyZones')
      .values({
        userId,
        label: input.label,
        centerLat: input.lat,
        centerLon: input.lon,
        radiusM: input.radiusM,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return {
      id: row.id,
      label: row.label,
      lat: row.centerLat,
      lon: row.centerLon,
      radiusM: row.radiusM,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async deleteZone(userId: string, zoneId: string): Promise<void> {
    await this.db
      .deleteFrom('privacyZones')
      .where('id', '=', zoneId)
      .where('userId', '=', userId)
      .execute();
  }
}
