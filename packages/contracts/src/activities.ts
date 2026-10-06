import { z } from 'zod';
import {
  ActivitySource,
  ContentVisibility,
  IntegrationProvider,
  IntegrationStatus,
  RecordType,
  RoutePrivacy,
  SplitType,
  SportKey,
} from './enums';
import {
  IdSchema,
  IsoDateTimeSchema,
  PageQuerySchema,
  QueryBooleanSchema,
  paginated,
} from './common';
import { UserSummarySchema } from './users';

/**
 * Units are SI everywhere in the API: metres, seconds, metres/second, degrees Celsius, watts.
 * Convert for display using the viewer's `unitSystem` setting. Derived pace/speed values are
 * provided so clients do not each reimplement the arithmetic.
 */

export const LatitudeSchema = z.number().min(-90).max(90);
export const LongitudeSchema = z.number().min(-180).max(180);
export const LatLonSchema = z
  .tuple([LatitudeSchema, LongitudeSchema])
  .describe('[latitude, longitude] in degrees');

export const RouteInputSchema = z
  .object({
    polyline: z
      .string()
      .min(2)
      .max(600_000)
      .optional()
      .describe('Google encoded polyline, precision 5.'),
    points: z.array(LatLonSchema).min(2).max(50_000).optional(),
  })
  .refine((r) => (r.polyline === undefined) !== (r.points === undefined), {
    message: 'Provide exactly one of `polyline` or `points`.',
  });

const Bpm = z.number().int().min(20).max(260);

export const SwimDetailSchema = z
  .object({
    poolLengthM: z.number().min(10).max(100).optional(),
    strokeCount: z.number().int().min(0).max(1_000_000).optional(),
    openWater: z.boolean().optional(),
  })
  .strict();

export const StrengthSetSchema = z
  .object({
    reps: z.number().int().min(0).max(1000).optional(),
    weightKg: z.number().min(0).max(1000).optional(),
    durationS: z.number().int().min(0).max(36_000).optional(),
  })
  .strict();

export const StrengthExerciseSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    sets: z.array(StrengthSetSchema).max(30),
  })
  .strict();

export const StrengthDetailSchema = z
  .object({
    totalVolumeKg: z.number().min(0).max(10_000_000).optional(),
    exercises: z.array(StrengthExerciseSchema).max(40).optional(),
  })
  .strict();

/** Sport-specific measurements. `swim` is accepted for swimming/triathlon, `strength` for strength_training/workout. */
export const SportSpecificSchema = z
  .object({ swim: SwimDetailSchema.optional(), strength: StrengthDetailSchema.optional() })
  .strict()
  .meta({ id: 'SportSpecific' });

export const ActivityMetricsSchema = z
  .object({
    avgSpeedMps: z.number().min(0).max(120).nullable(),
    maxSpeedMps: z.number().min(0).max(120).nullable(),
    heartRate: z.object({ avgBpm: Bpm.nullable(), maxBpm: Bpm.nullable() }),
    cadence: z.object({
      avg: z.number().int().min(0).max(300).nullable(),
      max: z.number().int().min(0).max(300).nullable(),
    }),
    power: z.object({
      avgW: z.number().int().min(0).max(3000).nullable(),
      maxW: z.number().int().min(0).max(5000).nullable(),
      normalizedW: z.number().int().min(0).max(3000).nullable(),
    }),
    temperatureC: z.number().min(-60).max(70).nullable(),
    sportSpecific: SportSpecificSchema.nullable(),
  })
  .meta({ id: 'ActivityMetrics' });

export const ActivityMetricsInputSchema = z
  .object({
    avgSpeedMps: z.number().min(0).max(120).optional(),
    maxSpeedMps: z.number().min(0).max(120).optional(),
    heartRate: z.object({ avgBpm: Bpm.optional(), maxBpm: Bpm.optional() }).strict().optional(),
    cadence: z
      .object({
        avg: z.number().int().min(0).max(300).optional(),
        max: z.number().int().min(0).max(300).optional(),
      })
      .strict()
      .optional(),
    power: z
      .object({
        avgW: z.number().int().min(0).max(3000).optional(),
        maxW: z.number().int().min(0).max(5000).optional(),
        normalizedW: z.number().int().min(0).max(3000).optional(),
      })
      .strict()
      .optional(),
    temperatureC: z.number().min(-60).max(70).optional(),
    sportSpecific: SportSpecificSchema.optional(),
  })
  .strict();

export const SplitInputSchema = z
  .object({
    type: SplitType.schema,
    distanceM: z.number().min(0).max(2_000_000).optional(),
    elapsedTimeS: z.number().int().min(0).max(604_800),
    elevationDiffM: z.number().min(-20_000).max(20_000).optional(),
    avgHeartRateBpm: Bpm.optional(),
    avgSpeedMps: z.number().min(0).max(120).optional(),
  })
  .strict();

export const SplitSchema = z
  .object({
    type: SplitType.schema,
    index: z.number().int().min(0),
    distanceM: z.number().nullable(),
    elapsedTimeS: z.number().int(),
    elevationDiffM: z.number().nullable(),
    avgHeartRateBpm: z.number().int().nullable(),
    avgSpeedMps: z.number().nullable(),
  })
  .meta({ id: 'ActivitySplit' });

export const DerivedSpeedSchema = z
  .object({
    avgSpeedKph: z.number().nullable(),
    avgSpeedMph: z.number().nullable(),
    paceSecPerKm: z.number().nullable().describe('Seconds per kilometre (running, walking, ...).'),
    paceSecPerMile: z.number().nullable(),
    paceSecPer100m: z.number().nullable().describe('Swimming.'),
    paceSecPer500m: z.number().nullable().describe('Rowing.'),
  })
  .meta({
    id: 'DerivedSpeed',
    description:
      'Computed from average speed (distance / moving time). All null when speed is unknown.',
  });

export const RouteViewSchema = z
  .object({
    segments: z
      .array(z.string())
      .describe(
        'Encoded polylines (Google format, precision 5). Usually one; several when parts of the route were hidden (privacy zones / trimmed ends). Draw each separately; never join them.',
      ),
    precision: z.literal(5),
    bbox: z
      .object({ minLat: z.number(), minLon: z.number(), maxLat: z.number(), maxLon: z.number() })
      .describe('Bounding box of the SEGMENTS SHOWN (not of the raw track).'),
    isPrivacyFiltered: z
      .boolean()
      .describe('True when some of the original route is withheld from this viewer.'),
  })
  .meta({ id: 'RouteView' });
export type RouteView = z.infer<typeof RouteViewSchema>;

export const RecordViewSchema = z
  .object({
    type: RecordType.schema,
    value: z
      .number()
      .describe('Seconds for FASTEST_*/LONGEST_DURATION, metres for distances/climbs.'),
    previousValue: z.number().nullable(),
  })
  .meta({ id: 'ActivityRecord' });

export const ActivitySchema = z
  .object({
    id: IdSchema,
    user: UserSummarySchema,
    sport: SportKey,
    subtype: z.string().nullable(),
    isRace: z.boolean(),
    title: z.string(),
    description: z.string(),
    startedAt: IsoDateTimeSchema,
    timezone: z.string().describe('IANA zone the activity took place in.'),
    elapsedTimeS: z.number().int(),
    movingTimeS: z.number().int().nullable(),
    distanceM: z.number().nullable(),
    elevationGainM: z.number().nullable(),
    elevationLossM: z.number().nullable(),
    caloriesKcal: z.number().int().nullable(),
    speed: DerivedSpeedSchema,
    metrics: ActivityMetricsSchema,
    splits: z
      .array(SplitSchema)
      .nullable()
      .describe(
        'Populated by the detail views (GET /activities/{id}, create, import); null in lists and feeds.',
      ),
    hasRoute: z.boolean().describe('A route exists AND some of it may be shown to this viewer.'),
    routePreview: RouteViewSchema.nullable().describe(
      'Simplified (<=120 points), privacy-filtered route for cards. Fetch /route for detail.',
    ),
    records: z.array(RecordViewSchema),
    visibility: ContentVisibility.schema,
    source: ActivitySource.schema,
    locationLabel: z.string().nullable(),
    ownerPrivacy: z
      .object({ routePrivacy: RoutePrivacy.schema })
      .nullable()
      .describe('Present only when the viewer owns the activity.'),
    createdAt: IsoDateTimeSchema,
  })
  .meta({ id: 'Activity' });
export type Activity = z.infer<typeof ActivitySchema>;

export const ActivityPageSchema = paginated(ActivitySchema, 'ActivityPage');

const IanaTimezone = z.string().min(1).max(64);

export const CreateActivityRequestSchema = z
  .object({
    sport: SportKey,
    subtype: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,39}$/)
      .optional()
      .describe('Lower-case slug such as "trail", "indoor", "open_water", "long_run".'),
    isRace: z.boolean().optional(),
    title: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe('Defaults to e.g. "Morning Run" from the local start time.'),
    description: z.string().max(2000).optional(),
    startedAt: IsoDateTimeSchema,
    timezone: IanaTimezone.optional().describe(
      'IANA zone, e.g. "America/Los_Angeles". Defaults to UTC.',
    ),
    elapsedTimeS: z.number().int().min(0).max(604_800),
    movingTimeS: z.number().int().min(0).max(604_800).optional(),
    distanceM: z.number().min(0).max(2_000_000).optional(),
    elevationGainM: z.number().min(0).max(20_000).optional(),
    elevationLossM: z.number().min(0).max(20_000).optional(),
    caloriesKcal: z.number().int().min(0).max(100_000).optional(),
    metrics: ActivityMetricsInputSchema.optional(),
    splits: z.array(SplitInputSchema).max(1000).optional(),
    route: RouteInputSchema.optional(),
    visibility: ContentVisibility.schema
      .optional()
      .describe('Defaults to your `defaultActivityVisibility` setting.'),
    routePrivacy: RoutePrivacy.schema
      .optional()
      .describe('Defaults to your `defaultRoutePrivacy` setting.'),
    locationLabel: z.string().trim().max(80).optional(),
    createPost: z
      .boolean()
      .optional()
      .describe(
        'Create a feed post for this activity. Defaults to your `autoCreateActivityPost` setting.',
      ),
  })
  .strict();
export type CreateActivityRequest = z.infer<typeof CreateActivityRequestSchema>;

export const UpdateActivityRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(100).optional(),
    description: z.string().max(2000).optional(),
    subtype: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,39}$/)
      .nullable()
      .optional(),
    isRace: z.boolean().optional(),
    visibility: ContentVisibility.schema.optional(),
    routePrivacy: RoutePrivacy.schema.optional(),
    locationLabel: z.string().trim().max(80).nullable().optional(),
  })
  .strict();
export type UpdateActivityRequest = z.infer<typeof UpdateActivityRequestSchema>;

export const ActivityListQuerySchema = PageQuerySchema.extend({
  sport: SportKey.optional(),
});

export const RouteQuerySchema = z.object({
  view: z
    .enum(['OWNER', 'PUBLIC'])
    .default('OWNER')
    .describe(
      'Owners may request PUBLIC to preview exactly what other people see. Non-owners always get PUBLIC.',
    ),
});

export const ImportGpxQuerySchema = z.object({
  sport: SportKey.optional().describe('Required unless the file declares a recognisable <type>.'),
  title: z.string().trim().min(1).max(100).optional(),
  timezone: IanaTimezone.optional(),
  visibility: ContentVisibility.schema.optional(),
  routePrivacy: RoutePrivacy.schema.optional(),
  isRace: QueryBooleanSchema.optional(),
  createPost: QueryBooleanSchema.optional(),
});

// ---- privacy zones ----------------------------------------------------------------------------

export const PrivacyZoneSchema = z
  .object({
    id: IdSchema,
    label: z.string(),
    lat: LatitudeSchema,
    lon: LongitudeSchema,
    radiusM: z.number().int().min(50).max(5000),
    createdAt: IsoDateTimeSchema,
  })
  .meta({
    id: 'PrivacyZone',
    description:
      'Visible to the owner only. Route points inside a zone are never shown to anyone else.',
  });
export const PrivacyZoneListSchema = z
  .object({ items: z.array(PrivacyZoneSchema) })
  .meta({ id: 'PrivacyZoneList' });
export const CreatePrivacyZoneRequestSchema = z
  .object({
    label: z.string().trim().min(1).max(40),
    lat: LatitudeSchema,
    lon: LongitudeSchema,
    radiusM: z.number().int().min(50).max(5000),
  })
  .strict();

// ---- integrations -------------------------------------------------------------------------------

export const IntegrationSchema = z
  .object({
    provider: IntegrationProvider.schema,
    available: z
      .boolean()
      .describe('False when the server has no credentials for this provider configured.'),
    connected: z.boolean(),
    status: IntegrationStatus.schema.nullable(),
    lastSyncedAt: IsoDateTimeSchema.nullable(),
  })
  .meta({ id: 'Integration' });
export const IntegrationListSchema = z
  .object({ items: z.array(IntegrationSchema) })
  .meta({ id: 'IntegrationList' });
