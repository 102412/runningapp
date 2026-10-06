import { z } from 'zod';
import { RelationshipStatus } from './enums';
import { IdSchema, IsoDateTimeSchema, PageQuerySchema, paginated } from './common';
import { UserSummarySchema } from './users';

export const FollowResultSchema = z
  .object({
    relationship: RelationshipStatus.schema.extract(['FOLLOWING', 'REQUESTED']),
  })
  .meta({
    id: 'FollowResult',
    description: 'FOLLOWING for public accounts; REQUESTED for private accounts awaiting approval.',
  });

export const FollowRequestSchema = z.object({
  id: IdSchema,
  user: UserSummarySchema,
  createdAt: IsoDateTimeSchema,
});
export type FollowRequest = z.infer<typeof FollowRequestSchema>;
export const FollowRequestPageSchema = paginated(FollowRequestSchema, 'FollowRequestPage');

export const BlockedUserSchema = z
  .object({ user: UserSummarySchema, blockedAt: IsoDateTimeSchema })
  .meta({ id: 'BlockedUser' });
export const BlockedUserPageSchema = paginated(BlockedUserSchema, 'BlockedUserPage');

export const FollowRequestIdParamSchema = z.object({ requestId: IdSchema });
export const SocialListQuerySchema = PageQuerySchema;
