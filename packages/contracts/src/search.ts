import { z } from 'zod';
import { PageQuerySchema, paginated } from './common';
import { PostSchema } from './posts';
import { UserSummarySchema } from './users';

export const MAX_SEARCH_LENGTH = 100;

const QuerySchema = z
  .string()
  .trim()
  .min(2)
  .max(MAX_SEARCH_LENGTH)
  .describe('Search text, 2-100 characters. A leading "#" or "@" is ignored.');

export const SearchQuerySchema = PageQuerySchema.extend({ q: QuerySchema });
export const SearchOverviewQuerySchema = z.object({ q: QuerySchema });

export const TopicResultSchema = z
  .object({
    slug: z.string().describe('Lower-case, without the "#".'),
    postCount: z
      .number()
      .int()
      .describe('Public posts using the topic, capped at 1000 (display as "1000+").'),
  })
  .meta({ id: 'TopicResult' });

export type TopicResult = z.infer<typeof TopicResultSchema>;

export const UserSearchPageSchema = paginated(UserSummarySchema, 'UserSearchPage');
export const TopicPageSchema = paginated(TopicResultSchema, 'TopicPage');

export const SearchOverviewSchema = z
  .object({
    users: z.array(UserSummarySchema),
    topics: z.array(TopicResultSchema),
    posts: z.array(PostSchema),
  })
  .meta({
    id: 'SearchOverview',
    description:
      'Top 5 of each kind, for the first screen of results. Use the typed endpoints to page.',
  });
