import { z } from 'zod';
import {
  AccountVisibility,
  CommentPermission,
  ContentVisibility,
  RelationshipStatus,
  RoutePrivacy,
  SportKey,
  UnitSystem,
  UserRole,
  UserStatus,
} from './enums';
import { IdSchema, IsoDateSchema, IsoDateTimeSchema, PageQuerySchema, paginated } from './common';
import { CreatorBadgeSchema, CreatorProfileSchema } from './creators';

export const USERNAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.]{2,29}$/;

export const UsernameSchema = z
  .string()
  .regex(
    USERNAME_PATTERN,
    '3-30 characters: letters, digits, "_" or "."; must start with a letter.',
  )
  .refine((v) => !v.includes('..') && !v.endsWith('.'), 'Cannot contain ".." or end with ".".')
  .meta({ id: 'Username', description: 'Case-insensitively unique handle, shown as @username.' });

export const DisplayNameSchema = z.string().trim().min(1).max(50);
export const BioSchema = z.string().max(300);

export const AvatarSchema = z
  .object({
    thumbUrl: z.string().describe('~240px square-ish thumbnail (signed, expiring URL).'),
    mediumUrl: z.string().describe('~720px version.'),
  })
  .meta({ id: 'Avatar' });
export type Avatar = z.infer<typeof AvatarSchema>;

/** The compact user shape embedded everywhere (feed cards, comments, notifications...). */
export const UserSummarySchema = z
  .object({
    id: IdSchema,
    username: z.string(),
    displayName: z.string(),
    avatar: AvatarSchema.nullable(),
    isPrivate: z.boolean().describe('Private accounts show a lock and require follow approval.'),
    creator: CreatorBadgeSchema.nullable(),
  })
  .meta({ id: 'UserSummary' });
export type UserSummary = z.infer<typeof UserSummarySchema>;

export const ViewerRelationSchema = z
  .object({
    isSelf: z.boolean(),
    relationship: RelationshipStatus.schema.describe(
      'Viewer -> this user. REQUESTED = follow request pending.',
    ),
    followsYou: z.boolean().describe('This user follows the viewer.'),
    hasPendingRequestFromThem: z
      .boolean()
      .describe('This user asked to follow the viewer and awaits approval.'),
  })
  .meta({ id: 'ViewerRelation' });

export const ProfileSchema = UserSummarySchema.extend({
  bio: z.string(),
  locationLabel: z.string().nullable(),
  primarySport: SportKey.nullable(),
  counts: z.object({
    followers: z.number().int(),
    following: z.number().int(),
    posts: z.number().int(),
  }),
  viewer: ViewerRelationSchema.nullable().describe('Null for anonymous viewers.'),
  creatorProfile: CreatorProfileSchema.nullable(),
  createdAt: IsoDateTimeSchema,
}).meta({ id: 'Profile' });
export type Profile = z.infer<typeof ProfileSchema>;

export const SettingsSchema = z
  .object({
    accountVisibility: AccountVisibility.schema,
    discoverable: z.boolean().describe('Appear in search and "who to follow".'),
    unitSystem: UnitSystem.schema,
    defaultActivityVisibility: ContentVisibility.schema,
    defaultPostVisibility: ContentVisibility.schema,
    defaultCommentPermission: CommentPermission.schema,
    defaultRoutePrivacy: RoutePrivacy.schema,
    routeTrimMeters: z.number().int().min(0).max(2000),
    autoCreateActivityPost: z.boolean(),
    personalizationEnabled: z
      .boolean()
      .describe('When false, behaviour is not used to personalise the feed.'),
  })
  .meta({ id: 'Settings' });
export type Settings = z.infer<typeof SettingsSchema>;

export const UpdateSettingsRequestSchema = SettingsSchema.partial().strict();
export type UpdateSettingsRequest = z.infer<typeof UpdateSettingsRequestSchema>;

export const MeSchema = z
  .object({
    id: IdSchema,
    email: z.string(),
    emailVerified: z.boolean(),
    status: UserStatus.schema,
    role: UserRole.schema,
    birthDate: IsoDateSchema,
    isMinor: z.boolean().describe('Under the adult age; stricter privacy defaults apply.'),
    profile: ProfileSchema,
    settings: SettingsSchema,
    deletion: z
      .object({ requestedAt: IsoDateTimeSchema, scheduledFor: IsoDateTimeSchema })
      .nullable()
      .describe('Non-null while the account is scheduled for deletion.'),
  })
  .meta({ id: 'Me' });
export type Me = z.infer<typeof MeSchema>;

export const UpdateProfileRequestSchema = z
  .object({
    username: UsernameSchema.optional(),
    displayName: DisplayNameSchema.optional(),
    bio: BioSchema.optional(),
    locationLabel: z.string().trim().max(80).nullable().optional(),
    primarySport: SportKey.nullable().optional(),
  })
  .strict();
export type UpdateProfileRequest = z.infer<typeof UpdateProfileRequestSchema>;

export const UsernameParamSchema = z.object({ username: UsernameSchema });
export const UserIdParamSchema = z.object({ userId: IdSchema });

export const UserSummaryPageSchema = paginated(UserSummarySchema, 'UserSummaryPage');
export const UserListQuerySchema = PageQuerySchema;

export const UsernameAvailabilityQuerySchema = z.object({ username: z.string().min(1).max(40) });
export const UsernameAvailabilitySchema = z
  .object({
    username: z.string(),
    available: z.boolean(),
    reason: z.enum(['TAKEN', 'INVALID', 'RESERVED']).nullable(),
  })
  .meta({ id: 'UsernameAvailability' });
