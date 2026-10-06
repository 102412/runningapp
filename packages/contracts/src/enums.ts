import { z } from 'zod';

/**
 * Every enum that crosses the API boundary lives here and ONLY here.
 * Clients must import these instead of re-declaring string unions.
 *
 * The API repo has a test (`enum-parity.test.ts`) asserting that each value list
 * matches the corresponding PostgreSQL enum, so DB and contracts cannot drift.
 */

function defineEnum<const T extends readonly [string, ...string[]]>(id: string, values: T) {
  const schema = z.enum(values).meta({ id });
  return { values, schema, enum: schema.enum } as const;
}

export const AccountVisibility = defineEnum('AccountVisibility', ['PUBLIC', 'PRIVATE']);
export type AccountVisibility = z.infer<typeof AccountVisibility.schema>;

/** Per-activity / per-post audience. Effective audience is also capped by AccountVisibility. */
export const ContentVisibility = defineEnum('ContentVisibility', [
  'PUBLIC',
  'FOLLOWERS',
  'PRIVATE',
]);
export type ContentVisibility = z.infer<typeof ContentVisibility.schema>;

export const CommentPermission = defineEnum('CommentPermission', [
  'EVERYONE',
  'FOLLOWERS',
  'NOBODY',
]);
export type CommentPermission = z.infer<typeof CommentPermission.schema>;

export const UserStatus = defineEnum('UserStatus', ['ACTIVE', 'SUSPENDED', 'PENDING_DELETION']);
export type UserStatus = z.infer<typeof UserStatus.schema>;

export const UserRole = defineEnum('UserRole', ['USER', 'MODERATOR', 'ADMIN']);
export type UserRole = z.infer<typeof UserRole.schema>;

export const UnitSystem = defineEnum('UnitSystem', ['METRIC', 'IMPERIAL']);
export type UnitSystem = z.infer<typeof UnitSystem.schema>;

export const DevicePlatform = defineEnum('DevicePlatform', ['IOS', 'ANDROID', 'WEB']);
export type DevicePlatform = z.infer<typeof DevicePlatform.schema>;

export const PushProviderName = defineEnum('PushProviderName', ['APNS', 'FCM', 'EXPO']);
export type PushProviderName = z.infer<typeof PushProviderName.schema>;

export const RelationshipStatus = defineEnum('RelationshipStatus', [
  'NONE',
  'FOLLOWING',
  'REQUESTED',
]);
export type RelationshipStatus = z.infer<typeof RelationshipStatus.schema>;

// ---------------------------------------------------------------- sports / activities

/** Stable sport keys. Sports are data (GET /sports); this list is kept in sync by a test. */
export const SPORT_KEYS = [
  'running',
  'cross_country',
  'track',
  'cycling',
  'swimming',
  'walking',
  'hiking',
  'strength_training',
  'workout',
  'rowing',
  'triathlon',
  'other',
] as const;
export const SportKey = z.enum(SPORT_KEYS).meta({ id: 'SportKey' });
export type SportKey = z.infer<typeof SportKey>;

export const SportCategory = defineEnum('SportCategory', ['ENDURANCE', 'STRENGTH', 'GENERAL']);
export type SportCategory = z.infer<typeof SportCategory.schema>;

/** How the primary speed metric should be displayed for a sport. */
export const SpeedDisplay = defineEnum('SpeedDisplay', [
  'PACE_PER_DISTANCE',
  'SPEED',
  'PACE_PER_100M',
  'PACE_PER_500M',
  'NONE',
]);
export type SpeedDisplay = z.infer<typeof SpeedDisplay.schema>;

export const ActivitySource = defineEnum('ActivitySource', [
  'MANUAL',
  'FILE_IMPORT',
  'STRAVA',
  'GARMIN',
  'APPLE_HEALTH',
  'HEALTH_CONNECT',
]);
export type ActivitySource = z.infer<typeof ActivitySource.schema>;

/**
 * How much of a GPS route other people may see.
 * FULL: exact route. TRIMMED: start/end hidden (default). APPROXIMATE: trimmed + coordinates
 * coarsened. HIDDEN: no route is ever served to anyone but the owner.
 */
export const RoutePrivacy = defineEnum('RoutePrivacy', [
  'FULL',
  'TRIMMED',
  'APPROXIMATE',
  'HIDDEN',
]);
export type RoutePrivacy = z.infer<typeof RoutePrivacy.schema>;

export const SplitType = defineEnum('SplitType', ['KM', 'MILE', 'LAP', 'INTERVAL']);
export type SplitType = z.infer<typeof SplitType.schema>;

export const RecordType = defineEnum('RecordType', [
  'LONGEST_DISTANCE',
  'LONGEST_DURATION',
  'FASTEST_5K',
  'FASTEST_10K',
  'FASTEST_HALF_MARATHON',
  'FASTEST_MARATHON',
  'BIGGEST_CLIMB',
]);
export type RecordType = z.infer<typeof RecordType.schema>;

export const IntegrationProvider = defineEnum('IntegrationProvider', [
  'STRAVA',
  'GARMIN',
  'APPLE_HEALTH',
  'HEALTH_CONNECT',
]);
export type IntegrationProvider = z.infer<typeof IntegrationProvider.schema>;

export const IntegrationStatus = defineEnum('IntegrationStatus', [
  'CONNECTED',
  'NEEDS_REAUTH',
  'REVOKED',
]);
export type IntegrationStatus = z.infer<typeof IntegrationStatus.schema>;

// ---------------------------------------------------------------- media

export const MediaKind = defineEnum('MediaKind', ['VIDEO', 'IMAGE']);
export type MediaKind = z.infer<typeof MediaKind.schema>;

export const MediaPurpose = defineEnum('MediaPurpose', ['POST', 'AVATAR']);
export type MediaPurpose = z.infer<typeof MediaPurpose.schema>;

export const MediaStatus = defineEnum('MediaStatus', [
  'PENDING_UPLOAD',
  'UPLOADED',
  'PROCESSING',
  'READY',
  'FAILED',
  'REJECTED',
]);
export type MediaStatus = z.infer<typeof MediaStatus.schema>;

export const MediaModerationStatus = defineEnum('MediaModerationStatus', [
  'PENDING',
  'APPROVED',
  'REJECTED',
]);
export type MediaModerationStatus = z.infer<typeof MediaModerationStatus.schema>;

export const MediaVariantKind = defineEnum('MediaVariantKind', [
  'VIDEO_MP4_HIGH',
  'VIDEO_MP4_LOW',
  'POSTER',
  'POSTER_THUMB',
  'IMAGE_LARGE',
  'IMAGE_MEDIUM',
  'IMAGE_THUMB',
]);
export type MediaVariantKind = z.infer<typeof MediaVariantKind.schema>;

// ---------------------------------------------------------------- posts / creators

export const PostStatus = defineEnum('PostStatus', [
  'DRAFT',
  'PENDING_MEDIA',
  'PUBLISHED',
  'PUBLISH_FAILED',
]);
export type PostStatus = z.infer<typeof PostStatus.schema>;

export const PostOrigin = defineEnum('PostOrigin', ['AUTHORED', 'ACTIVITY_AUTO']);
export type PostOrigin = z.infer<typeof PostOrigin.schema>;

export const PostFormat = defineEnum('PostFormat', ['ACTIVITY', 'VIDEO', 'PHOTO', 'TEXT']);
export type PostFormat = z.infer<typeof PostFormat.schema>;

export const ModerationStatus = defineEnum('ModerationStatus', ['CLEAN', 'HIDDEN', 'REMOVED']);
export type ModerationStatus = z.infer<typeof ModerationStatus.schema>;

export const SponsorshipType = defineEnum('SponsorshipType', [
  'PAID_PARTNERSHIP',
  'GIFTED_PRODUCT',
  'AFFILIATE',
  'AMBASSADOR',
]);
export type SponsorshipType = z.infer<typeof SponsorshipType.schema>;

export const CreatorCategory = defineEnum('CreatorCategory', [
  'PROFESSIONAL_ATHLETE',
  'COACH',
  'CONTENT_CREATOR',
  'BRAND',
  'CLUB_OR_TEAM',
]);
export type CreatorCategory = z.infer<typeof CreatorCategory.schema>;

export const VerificationStatus = defineEnum('VerificationStatus', ['NONE', 'PENDING', 'VERIFIED']);
export type VerificationStatus = z.infer<typeof VerificationStatus.schema>;

// ---------------------------------------------------------------- engagement

export const ReactionType = defineEnum('ReactionType', ['LIKE', 'CLAP', 'FIRE', 'STRONG']);
export type ReactionType = z.infer<typeof ReactionType.schema>;

export const ShareChannel = defineEnum('ShareChannel', [
  'COPY_LINK',
  'SYSTEM_SHARE',
  'EXTERNAL_APP',
]);
export type ShareChannel = z.infer<typeof ShareChannel.schema>;

export const NotificationType = defineEnum('NotificationType', [
  'NEW_FOLLOWER',
  'FOLLOW_REQUEST',
  'FOLLOW_ACCEPTED',
  'POST_REACTION',
  'POST_COMMENT',
  'COMMENT_REPLY',
  'COMMENT_REACTION',
  'MENTION_POST',
  'MENTION_COMMENT',
  'POST_PUBLISHED',
  'POST_PUBLISH_FAILED',
  'MODERATION_ACTION',
]);
export type NotificationType = z.infer<typeof NotificationType.schema>;

// ---------------------------------------------------------------- feed / events

export const FeedSurface = defineEnum('FeedSurface', [
  'HOME',
  'FOLLOWING',
  'EXPLORE',
  'PROFILE',
  'SEARCH',
  'POST_DETAIL',
  'TOPIC',
  'OTHER',
]);
export type FeedSurface = z.infer<typeof FeedSurface.schema>;

/** Events a CLIENT may report (things only the client can observe). */
export const ClientEventType = defineEnum('ClientEventType', [
  'IMPRESSION',
  'VIDEO_START',
  'VIDEO_COMPLETE',
  'WATCH_TIME',
  'SKIP',
  'PROFILE_OPEN',
  'ACTIVITY_OPEN',
  'MEDIA_EXPAND',
  'TOPIC_INTERACTION',
  'NOT_INTERESTED',
]);
export type ClientEventType = z.infer<typeof ClientEventType.schema>;

/** Events the SERVER records itself (authoritative) when the matching endpoint is called. */
export const ServerEventType = defineEnum('ServerEventType', [
  'LIKE',
  'UNLIKE',
  'COMMENT',
  'SHARE',
  'BOOKMARK',
  'UNBOOKMARK',
  'FOLLOW',
  'UNFOLLOW',
]);
export type ServerEventType = z.infer<typeof ServerEventType.schema>;

export const FeedEventType = defineEnum('FeedEventType', [
  ...ClientEventType.values,
  ...ServerEventType.values,
]);
export type FeedEventType = z.infer<typeof FeedEventType.schema>;

export const FeedItemReason = defineEnum('FeedItemReason', [
  'OWN_POST',
  'FOLLOWED_AUTHOR',
  'SPORT_INTEREST',
  'CREATOR_AFFINITY',
  'TRENDING',
  'DISCOVERY',
]);
export type FeedItemReason = z.infer<typeof FeedItemReason.schema>;

// ---------------------------------------------------------------- moderation

export const ReportTargetType = defineEnum('ReportTargetType', ['POST', 'COMMENT', 'USER']);
export type ReportTargetType = z.infer<typeof ReportTargetType.schema>;

export const ReportReason = defineEnum('ReportReason', [
  'SPAM',
  'HARASSMENT',
  'HATE_SPEECH',
  'VIOLENCE',
  'SEXUAL_CONTENT',
  'SELF_HARM',
  'MINOR_SAFETY',
  'IMPERSONATION',
  'MISINFORMATION',
  'UNDISCLOSED_SPONSORSHIP',
  'COPYRIGHT',
  'PRIVACY_VIOLATION',
  'OTHER',
]);
export type ReportReason = z.infer<typeof ReportReason.schema>;

export const ReportStatus = defineEnum('ReportStatus', [
  'OPEN',
  'IN_REVIEW',
  'ACTIONED',
  'DISMISSED',
]);
export type ReportStatus = z.infer<typeof ReportStatus.schema>;

export const ReportSource = defineEnum('ReportSource', ['USER', 'AUTOMATED']);
export type ReportSource = z.infer<typeof ReportSource.schema>;

export const ModerationActionType = defineEnum('ModerationActionType', [
  'HIDE_CONTENT',
  'REMOVE_CONTENT',
  'RESTORE_CONTENT',
  'SUSPEND_USER',
  'UNSUSPEND_USER',
  'WARN_USER',
  'DISMISS_REPORT',
  'SET_CREATOR_VERIFICATION',
]);
export type ModerationActionType = z.infer<typeof ModerationActionType.schema>;

export const DataExportStatus = defineEnum('DataExportStatus', [
  'PENDING',
  'PROCESSING',
  'READY',
  'FAILED',
  'EXPIRED',
]);
export type DataExportStatus = z.infer<typeof DataExportStatus.schema>;

export const SuggestionReason = defineEnum('SuggestionReason', [
  'FOLLOWED_BY_FOLLOWING',
  'SAME_SPORT',
  'CREATOR',
  'POPULAR',
]);
export type SuggestionReason = z.infer<typeof SuggestionReason.schema>;

export const SportRelation = defineEnum('SportRelation', ['PARTICIPANT', 'FOLLOWER']);
export type SportRelation = z.infer<typeof SportRelation.schema>;

/** Registry of (postgres enum name -> contract values) used by the parity test. */
export const DB_ENUM_PARITY: Readonly<Record<string, readonly string[]>> = {
  account_visibility: AccountVisibility.values,
  content_visibility: ContentVisibility.values,
  comment_permission: CommentPermission.values,
  user_status: UserStatus.values,
  user_role: UserRole.values,
  unit_system: UnitSystem.values,
  device_platform: DevicePlatform.values,
  push_provider: PushProviderName.values,
  sport_category: SportCategory.values,
  speed_display: SpeedDisplay.values,
  activity_source: ActivitySource.values,
  route_privacy: RoutePrivacy.values,
  split_type: SplitType.values,
  record_type: RecordType.values,
  integration_provider: IntegrationProvider.values,
  integration_status: IntegrationStatus.values,
  media_kind: MediaKind.values,
  media_purpose: MediaPurpose.values,
  media_status: MediaStatus.values,
  media_moderation_status: MediaModerationStatus.values,
  media_variant_kind: MediaVariantKind.values,
  post_status: PostStatus.values,
  post_origin: PostOrigin.values,
  post_format: PostFormat.values,
  moderation_status: ModerationStatus.values,
  sponsorship_type: SponsorshipType.values,
  creator_category: CreatorCategory.values,
  verification_status: VerificationStatus.values,
  reaction_type: ReactionType.values,
  share_channel: ShareChannel.values,
  notification_type: NotificationType.values,
  feed_surface: FeedSurface.values,
  feed_event_type: FeedEventType.values,
  report_target_type: ReportTargetType.values,
  report_reason: ReportReason.values,
  report_status: ReportStatus.values,
  report_source: ReportSource.values,
  moderation_action_type: ModerationActionType.values,
  data_export_status: DataExportStatus.values,
  sport_relation: SportRelation.values,
};
