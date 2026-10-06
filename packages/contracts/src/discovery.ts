import { z } from 'zod';
import { SportKey, SuggestionReason } from './enums';
import { PageQuerySchema, paginated } from './common';
import { UserSummarySchema } from './users';

export const SuggestedAthleteSchema = z
  .object({
    user: UserSummarySchema,
    reason: SuggestionReason.schema,
    mutualFollowers: z
      .number()
      .int()
      .describe('How many people you follow also follow them (0 unless FOLLOWED_BY_FOLLOWING).'),
    primarySport: SportKey.nullable(),
  })
  .meta({ id: 'SuggestedAthlete' });
export type SuggestedAthlete = z.infer<typeof SuggestedAthleteSchema>;
export const SuggestedAthletePageSchema = paginated(SuggestedAthleteSchema, 'SuggestedAthletePage');

export const TrendingTopicSchema = z
  .object({
    slug: z.string(),
    postCount: z.number().int().describe('Public posts using the topic in the last 7 days.'),
    authorCount: z.number().int().describe('Distinct authors who used it in the last 7 days.'),
  })
  .meta({ id: 'TrendingTopic' });
export type TrendingTopic = z.infer<typeof TrendingTopicSchema>;
export const TrendingTopicsSchema = z
  .object({ items: z.array(TrendingTopicSchema) })
  .meta({ id: 'TrendingTopics' });

export const TopicSlugParamSchema = z.object({ slug: z.string().trim().min(1).max(50) });
export const TopicPostsQuerySchema = PageQuerySchema;
export const TrendingQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(30).default(10),
});
