import { ActivityFlows } from './flows/log-activity';
import { CreatorService } from './modules/creators/service';
import { EngagementService } from './modules/engagement/service';
import { DbEventRecorder } from './modules/events/db-recorder';
import { EventIngestionService } from './modules/events/ingestion';
import { FeedAnalytics } from './modules/feed/analytics';
import { FeedService } from './modules/feed/service';
import { AccountPurger } from './flows/purge-account';
import { ExportService } from './modules/exports/service';
import { DevOutbox } from './modules/dev/outbox';
import { DiscoveryService } from './modules/discovery/service';
import { PostgresSearchProvider } from './modules/search/postgres';
import type { SearchProvider } from './modules/search/provider';
import { SearchService } from './modules/search/service';
import type { EventRecorder } from './platform/ports/event-recorder';
import { NotificationService } from './modules/notifications/service';
import { PostHydrator } from './modules/posts/hydrator';
import { PostService } from './modules/posts/service';
import { IdempotencyService } from './platform/http/idempotency';
import { MediaService } from './modules/media/service';
import { Ffmpeg } from './modules/media/ffmpeg';
import { ActivityService } from './modules/activities/service';
import { AccessTokenService } from './modules/auth/access-token';
import { AuthService } from './modules/auth/service';
import { IntegrationService } from './modules/integrations/service';
import { ProfileService } from './modules/profiles/service';
import { DbNotifier, type Notifier } from './modules/notifier';
import { SocialService } from './modules/social/service';
import { SportService } from './modules/sports/service';
import { AgePolicy } from './modules/users/age-policy';
import { UserDirectory } from './modules/users/directory';
import { UserRepository } from './modules/users/repository';
import type { PlatformContext } from './platform/context';
import type { ContentModerator, ModerationFlagSink } from './platform/ports/content-moderation';
import { KeywordModerator } from './platform/ports/keyword-moderator';
import { DbFlagSink } from './modules/moderation/flags';
import { ModerationService } from './modules/moderation/service';
import { ReportService } from './modules/moderation/reports';
import { LoggingPushProvider, type PushProvider } from './platform/ports/push';
import { LocalStorage } from './platform/storage/local';
import { S3Storage } from './platform/storage/s3';
import type { ObjectStorage } from './platform/storage/types';
import { ConsoleMailer } from './platform/mail/console';
import { MailService } from './platform/mail/service';
import { SmtpMailer } from './platform/mail/smtp';
import type { Mailer } from './platform/mail/types';

/**
 * Composition root. Every module's service is constructed here, in dependency order, so the
 * whole dependency graph is visible in one file. Modules never import each other's internals;
 * they receive what they need through their factory's parameters.
 *
 * Layering (a module may only depend on those above it):
 *   platform -> notifier, users -> auth, sports, social -> profiles -> (content modules ...)
 */
export interface Services {
  readonly platform: PlatformContext;
  readonly accessTokens: AccessTokenService;
  readonly mail: MailService;
  readonly notifier: Notifier;
  readonly users: UserRepository;
  readonly directory: UserDirectory;
  readonly auth: AuthService;
  readonly sports: SportService;
  readonly social: SocialService;
  readonly storage: ObjectStorage;
  readonly media: MediaService;
  readonly profiles: ProfileService;
  readonly agePolicy: AgePolicy;
  readonly activities: ActivityService;
  readonly integrations: IntegrationService;
  readonly creators: CreatorService;
  readonly postHydrator: PostHydrator;
  readonly posts: PostService;
  readonly idempotency: IdempotencyService;
  readonly events: EventRecorder;
  readonly eventIngestion: EventIngestionService;
  readonly feed: FeedService;
  readonly feedAnalytics: FeedAnalytics;
  readonly search: SearchService;
  readonly reports: ReportService;
  readonly devOutbox: DevOutbox;
  readonly dataExports: ExportService;
  readonly accountPurger: AccountPurger;
  readonly moderation: ModerationService;
  readonly discovery: DiscoveryService;
  readonly engagement: EngagementService;
  readonly notifications: NotificationService;
  readonly flows: ActivityFlows;
}

export interface ServiceOverrides {
  mailer?: Mailer;
  storage?: ObjectStorage;
  moderator?: ContentModerator;
  push?: PushProvider;
  search?: SearchProvider;
}

export function createServices(
  platform: PlatformContext,
  overrides: ServiceOverrides = {},
): Services {
  const { config, db, clock, logger, jobs, metrics } = platform;

  const mailer: Mailer =
    overrides.mailer ??
    (config.MAIL_DRIVER === 'smtp' && config.SMTP_URL
      ? new SmtpMailer(config.SMTP_URL, config.MAIL_FROM)
      : new ConsoleMailer(db, logger));
  const mail = new MailService(config, jobs, mailer);

  const notifier = new DbNotifier(db, jobs);
  const users = new UserRepository(db);
  const directory = new UserDirectory(db);
  const accessTokens = new AccessTokenService(config, clock);
  const auth = new AuthService(config, db, clock, users, accessTokens, mail, metrics);
  const sports = new SportService(db, clock);
  const events: EventRecorder = new DbEventRecorder(db);
  const social = new SocialService(db, directory, notifier, events);
  const storage: ObjectStorage =
    overrides.storage ??
    (config.STORAGE_DRIVER === 's3'
      ? new S3Storage(
          {
            bucket: config.S3_BUCKET ?? '',
            region: config.S3_REGION,
            endpoint: config.S3_ENDPOINT,
            accessKeyId: config.S3_ACCESS_KEY_ID ?? '',
            secretAccessKey: config.S3_SECRET_ACCESS_KEY ?? '',
            forcePathStyle: config.S3_FORCE_PATH_STYLE,
          },
          clock,
        )
      : new LocalStorage(
          config.LOCAL_STORAGE_DIR,
          config.MEDIA_SIGNING_SECRET,
          config.PUBLIC_BASE_URL,
          clock,
        ));
  const moderator =
    overrides.moderator ??
    new KeywordModerator(config.MODERATION_BLOCK_TERMS, config.MODERATION_FLAG_TERMS);
  const flags: ModerationFlagSink = new DbFlagSink(db, clock, logger);
  const ffmpeg = new Ffmpeg(config.FFMPEG_PATH, config.FFPROBE_PATH);
  const media = new MediaService(config, db, clock, storage, jobs, ffmpeg, moderator, logger);
  directory.setAvatarResolver(media.resolveAvatars);
  const creators = new CreatorService(db);
  const profiles = new ProfileService(
    config,
    db,
    clock,
    directory,
    social,
    media,
    creators,
    moderator,
    flags,
  );
  const agePolicy = new AgePolicy(config, db, clock);
  const activities = new ActivityService(db, clock, sports, directory, agePolicy);
  const integrations = new IntegrationService(db);
  const postHydrator = new PostHydrator(db, directory, activities, media);
  const posts = new PostService(
    db,
    clock,
    activities,
    media,
    agePolicy,
    moderator,
    notifier,
    postHydrator,
    flags,
  );
  const idempotency = new IdempotencyService(db, clock);
  const engagement = new EngagementService(
    db,
    posts,
    postHydrator,
    directory,
    notifier,
    moderator,
    events,
    flags,
    clock,
  );
  const push = overrides.push ?? new LoggingPushProvider(logger);
  const notifications = new NotificationService(db, directory, media, push);
  const flows = new ActivityFlows(config, db, activities, posts);
  const eventIngestion = new EventIngestionService(db, clock);
  const feed = new FeedService(config, db, clock, postHydrator, agePolicy, logger);
  const feedAnalytics = new FeedAnalytics(config, db, clock, logger);
  const reports = new ReportService(db, clock);
  const devOutbox = new DevOutbox(db);
  const moderation = new ModerationService(db, clock, directory, postHydrator, notifier);
  const dataExports = new ExportService(db, clock, jobs, storage, users, logger);
  const accountPurger = new AccountPurger(db, clock, jobs, logger);
  const searchProvider = overrides.search ?? new PostgresSearchProvider(db);
  const search = new SearchService(config, db, clock, searchProvider, directory, postHydrator);
  const discovery = new DiscoveryService(config, db, clock, directory, postHydrator);

  return {
    platform,
    accessTokens,
    mail,
    notifier,
    users,
    directory,
    auth,
    sports,
    social,
    storage,
    media,
    profiles,
    agePolicy,
    activities,
    integrations,
    creators,
    postHydrator,
    posts,
    idempotency,
    events,
    eventIngestion,
    feed,
    feedAnalytics,
    search,
    discovery,
    reports,
    devOutbox,
    dataExports,
    accountPurger,
    moderation,
    engagement,
    notifications,
    flows,
  };
}
