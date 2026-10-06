import { z } from 'zod';
import { SportCategory, SportKey, SportRelation, SpeedDisplay } from './enums';

export const SportSchema = z
  .object({
    key: SportKey,
    label: z.string(),
    category: SportCategory.schema,
    speedDisplay: SpeedDisplay.schema.describe(
      'How to present the primary speed metric for this sport.',
    ),
    supports: z
      .object({
        distance: z.boolean(),
        route: z.boolean(),
        elevation: z.boolean(),
        heartRate: z.boolean(),
        cadence: z.boolean(),
        power: z.boolean(),
        splits: z.boolean(),
      })
      .describe(
        'Which metrics are meaningful. Supplying an unsupported metric is rejected (METRIC_NOT_SUPPORTED_FOR_SPORT); omitting any metric is always fine.',
      ),
  })
  .meta({ id: 'Sport' });
export type Sport = z.infer<typeof SportSchema>;
export const SportListSchema = z.object({ items: z.array(SportSchema) }).meta({ id: 'SportList' });

export const SportPreferenceSchema = z
  .object({ sport: SportKey, relation: SportRelation.schema })
  .meta({ id: 'SportPreference' });
export type SportPreference = z.infer<typeof SportPreferenceSchema>;

export const SportPreferencesSchema = z
  .object({ items: z.array(SportPreferenceSchema) })
  .meta({ id: 'SportPreferences' });
export const SetSportPreferencesRequestSchema = z
  .object({ items: z.array(SportPreferenceSchema).max(20) })
  .strict()
  .describe('Replaces the full set of preferences.');
