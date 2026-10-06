import { z } from 'zod';

/**
 * All runtime configuration comes from environment variables, validated once at boot.
 * Anything secret has a development-only default that `loadConfig` REFUSES to accept
 * when NODE_ENV=production, so a misconfigured deploy fails fast instead of running
 * with a well-known key.
 */

const DEV_JWT_SECRET = 'dev-only-jwt-secret-change-me-0123456789abcdef';
const DEV_MEDIA_SECRET = 'dev-only-media-signing-secret-change-me-0123456789';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const csv = z.string().transform((v) =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0),
);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /** Externally reachable base URL of this API (used to mint local-storage URLs). */
  PUBLIC_BASE_URL: z.url().default('http://localhost:3000'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: bool.default(false),
  /** Number of reverse-proxy hops to trust for client IP (0 = none). */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),

  DATABASE_URL: z.string().default('postgres://runningapp:runningapp@localhost:5432/runningapp'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
  DATABASE_SSL: bool.default(false),
  /** Apply pending migrations on API boot. Default: on in dev/test, off in production. */
  AUTO_MIGRATE: bool.default(false),
  REDIS_URL: z.string().optional(),

  JWT_SECRET: z.string().min(32).default(DEV_JWT_SECRET),
  /** Optional previous secret, accepted for verification only (rotation window). */
  JWT_SECRET_PREVIOUS: z.string().min(32).optional(),
  JWT_ISSUER: z.string().default('runningapp-api'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  SESSION_MAX_AGE_DAYS: z.coerce.number().int().min(1).max(730).default(90),

  EMAIL_VERIFICATION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(60),
  ACCOUNT_DELETION_GRACE_DAYS: z.coerce.number().int().min(0).max(90).default(30),
  /** Base URL for links placed in emails (deep link / web app). */
  EMAIL_LINK_BASE_URL: z.string().default('runningapp://'),
  MAIL_DRIVER: z.enum(['console', 'smtp']).default('console'),
  MAIL_FROM: z.string().default('RunningApp <no-reply@example.invalid>'),
  SMTP_URL: z.string().optional(),
  /** Dev convenience: mark new accounts as email-verified. Refused in production. */
  DEV_AUTO_VERIFY_EMAIL: bool.default(false),
  /** Exposes /v1/dev/* helpers (mail outbox). Refused in production. */
  DEV_ENDPOINTS_ENABLED: bool.default(false),
  REQUIRE_VERIFIED_EMAIL_TO_PUBLISH: bool.default(true),

  MIN_SIGNUP_AGE: z.coerce.number().int().min(0).max(21).default(13),
  /** Accounts under this age cannot be PUBLIC and default to private. */
  MINOR_PUBLIC_MIN_AGE: z.coerce.number().int().min(0).max(21).default(16),
  ADULT_AGE: z.coerce.number().int().min(13).max(21).default(18),

  CORS_ORIGINS: csv.default([]),
  RATE_LIMIT_ENABLED: bool.default(true),
  /** Global per-IP requests/minute for authenticated+anonymous traffic. */
  RATE_LIMIT_GLOBAL_PER_MINUTE: z.coerce.number().int().min(10).default(600),
  METRICS_TOKEN: z.string().min(16).optional(),

  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  LOCAL_STORAGE_DIR: z.string().default('.local-storage'),
  MEDIA_SIGNING_SECRET: z.string().min(32).default(DEV_MEDIA_SECRET),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool.default(false),
  /** Lifetime of signed GET URLs for media. Rounded into buckets so URLs stay cacheable. */
  MEDIA_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(86400).default(21600),
  UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(86400).default(900),
  MEDIA_MAX_VIDEO_BYTES: z.coerce
    .number()
    .int()
    .default(300 * 1024 * 1024),
  MEDIA_MAX_VIDEO_SECONDS: z.coerce.number().int().default(180),
  MEDIA_MAX_IMAGE_BYTES: z.coerce
    .number()
    .int()
    .default(25 * 1024 * 1024),
  MEDIA_MAX_PIXELS: z.coerce.number().int().default(80_000_000),
  FFMPEG_PATH: z.string().default('ffmpeg'),
  FFPROBE_PATH: z.string().default('ffprobe'),

  /** Run the job worker inside the API process (fine for dev/small deploys). */
  WORKER_INLINE: bool.default(false),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  /** Fraction of served feed items persisted to the recommendation log (0..1). */
  RANKING_LOG_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(1),
  /** How long a ranked feed snapshot (Home/Explore pagination state) stays valid. */
  FEED_SNAPSHOT_TTL_MINUTES: z.coerce.number().int().min(1).max(1440).default(30),
  /** Maximum items in one Home/Explore refresh (the feed is finite per refresh). */
  FEED_SNAPSHOT_SIZE: z.coerce.number().int().min(10).max(500).default(100),
  /** Raw behavioural events and the serving log are deleted after this many days. */
  ANALYTICS_RETENTION_DAYS: z.coerce.number().int().min(7).max(1095).default(180),
  /** Comma-separated terms that make the baseline text moderator FLAG content. */
  MODERATION_FLAG_TERMS: csv.default([]),
});

export type Config = Readonly<z.output<typeof envSchema>> & {
  readonly isProduction: boolean;
  readonly isTest: boolean;
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new ConfigError(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  const base = parsed.data;
  const isProduction = base.NODE_ENV === 'production';

  const dev = !isProduction;
  const withDefaults = {
    ...base,
    // Dev-friendly defaults that must never apply in production.
    DEV_AUTO_VERIFY_EMAIL:
      env.DEV_AUTO_VERIFY_EMAIL === undefined ? dev : base.DEV_AUTO_VERIFY_EMAIL,
    DEV_ENDPOINTS_ENABLED:
      env.DEV_ENDPOINTS_ENABLED === undefined ? dev : base.DEV_ENDPOINTS_ENABLED,
    LOG_PRETTY: env.LOG_PRETTY === undefined ? base.NODE_ENV === 'development' : base.LOG_PRETTY,
    WORKER_INLINE: env.WORKER_INLINE === undefined ? dev : base.WORKER_INLINE,
    AUTO_MIGRATE: env.AUTO_MIGRATE === undefined ? dev : base.AUTO_MIGRATE,
  };

  if (isProduction) {
    const problems: string[] = [];
    if (withDefaults.JWT_SECRET === DEV_JWT_SECRET) problems.push('JWT_SECRET must be set');
    if (withDefaults.MEDIA_SIGNING_SECRET === DEV_MEDIA_SECRET) {
      problems.push('MEDIA_SIGNING_SECRET must be set');
    }
    if (withDefaults.DEV_AUTO_VERIFY_EMAIL) problems.push('DEV_AUTO_VERIFY_EMAIL must be false');
    if (withDefaults.DEV_ENDPOINTS_ENABLED) problems.push('DEV_ENDPOINTS_ENABLED must be false');
    if (!withDefaults.RATE_LIMIT_ENABLED) problems.push('RATE_LIMIT_ENABLED must be true');
    if (withDefaults.MAIL_DRIVER === 'console') problems.push('MAIL_DRIVER must be smtp');
    if (withDefaults.MAIL_DRIVER === 'smtp' && !withDefaults.SMTP_URL) {
      problems.push('SMTP_URL is required when MAIL_DRIVER=smtp');
    }
    if (withDefaults.STORAGE_DRIVER === 'local') {
      problems.push('STORAGE_DRIVER must be s3 (local disk storage is development-only)');
    }
    if (withDefaults.CORS_ORIGINS.includes('*')) problems.push('CORS_ORIGINS must not be *');
    if (problems.length > 0) {
      throw new ConfigError(`Unsafe production configuration:\n  - ${problems.join('\n  - ')}`);
    }
  }

  if (withDefaults.STORAGE_DRIVER === 's3') {
    const missing = ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'].filter(
      (k) => !env[k],
    );
    if (missing.length > 0) {
      throw new ConfigError(`STORAGE_DRIVER=s3 requires: ${missing.join(', ')}`);
    }
  }

  return Object.freeze({ ...withDefaults, isProduction, isTest: base.NODE_ENV === 'test' });
}
