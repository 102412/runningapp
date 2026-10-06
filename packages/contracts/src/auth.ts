import { z } from 'zod';
import { DevicePlatform } from './enums';
import { IdSchema, IsoDateSchema, IsoDateTimeSchema } from './common';
import { MeSchema, UsernameSchema, DisplayNameSchema } from './users';

export const EmailSchema = z.email().max(254);
/** 10-128 chars. Also rejected server-side: very common passwords and passwords containing the email/username. */
export const PasswordSchema = z.string().min(10).max(128);

export const DeviceInfoSchema = z
  .object({
    installId: z
      .string()
      .min(8)
      .max(128)
      .describe('Stable random id generated once per app install (persist it in secure storage).'),
    platform: DevicePlatform.schema,
    name: z.string().max(80).optional().describe('e.g. "Ava\'s iPhone".'),
    appVersion: z.string().max(40).optional(),
  })
  .strict()
  .meta({ id: 'DeviceInfo' });
export type DeviceInfo = z.infer<typeof DeviceInfoSchema>;

export const TokenPairSchema = z
  .object({
    tokenType: z.literal('Bearer'),
    accessToken: z.string().describe('Short-lived JWT. Send as `Authorization: Bearer <token>`.'),
    accessTokenExpiresAt: IsoDateTimeSchema,
    refreshToken: z
      .string()
      .describe(
        'Opaque, single-use. Exchange via POST /v1/auth/refresh; store only in secure storage.',
      ),
    refreshTokenExpiresAt: IsoDateTimeSchema,
  })
  .meta({ id: 'TokenPair' });
export type TokenPair = z.infer<typeof TokenPairSchema>;

export const AuthResponseSchema = z
  .object({ user: MeSchema, tokens: TokenPairSchema, sessionId: IdSchema })
  .meta({ id: 'AuthResponse' });
export type AuthResponse = z.infer<typeof AuthResponseSchema>;

export const SignupRequestSchema = z
  .object({
    email: EmailSchema,
    password: PasswordSchema,
    username: UsernameSchema,
    displayName: DisplayNameSchema.optional().describe('Defaults to the username.'),
    birthDate: IsoDateSchema.describe(
      'Required. Used for age gating and minor-safety defaults; never shown publicly.',
    ),
    device: DeviceInfoSchema.optional(),
  })
  .strict();
export type SignupRequest = z.infer<typeof SignupRequestSchema>;

export const LoginRequestSchema = z
  .object({
    email: EmailSchema,
    password: z.string().min(1).max(128),
    device: DeviceInfoSchema.optional(),
  })
  .strict();
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const RefreshRequestSchema = z
  .object({ refreshToken: z.string().min(20).max(200) })
  .strict();

export const TokenRefreshResponseSchema = z
  .object({ tokens: TokenPairSchema })
  .meta({ id: 'RefreshResponse' });

export const VerifyEmailRequestSchema = z.object({ token: z.string().min(20).max(200) }).strict();
export const ForgotPasswordRequestSchema = z.object({ email: EmailSchema }).strict();
export const ResetPasswordRequestSchema = z
  .object({ token: z.string().min(20).max(200), newPassword: PasswordSchema })
  .strict();
export const ChangePasswordRequestSchema = z
  .object({ currentPassword: z.string().min(1).max(128), newPassword: PasswordSchema })
  .strict();

export const SessionViewSchema = z
  .object({
    id: IdSchema,
    isCurrent: z.boolean(),
    device: z
      .object({
        id: IdSchema,
        name: z.string().nullable(),
        platform: DevicePlatform.schema,
        appVersion: z.string().nullable(),
      })
      .nullable(),
    createdAt: IsoDateTimeSchema,
    lastSeenAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema,
    approximateNetwork: z
      .string()
      .nullable()
      .describe('Coarse network prefix, e.g. "203.0.113.0/24".'),
  })
  .meta({ id: 'SessionView' });
export type SessionView = z.infer<typeof SessionViewSchema>;
export const SessionListSchema = z
  .object({ items: z.array(SessionViewSchema) })
  .meta({ id: 'SessionList' });

export const RequestDeletionRequestSchema = z
  .object({ password: z.string().min(1).max(128) })
  .strict();
export const DeletionStatusSchema = z
  .object({ requestedAt: IsoDateTimeSchema, scheduledFor: IsoDateTimeSchema })
  .meta({ id: 'DeletionStatus' });

/** Dev-only: lets UI developers complete verification/reset flows without an inbox. */
export const DevMailSchema = z
  .object({
    id: IdSchema,
    to: z.string(),
    subject: z.string(),
    template: z.string(),
    token: z.string().nullable(),
    text: z.string(),
    createdAt: IsoDateTimeSchema,
  })
  .meta({ id: 'DevMail' });
export const DevMailListSchema = z
  .object({ items: z.array(DevMailSchema) })
  .meta({ id: 'DevMailList' });
export const DevMailQuerySchema = z.object({
  to: z.email().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});
