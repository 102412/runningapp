import { z } from 'zod';
import { CreatorCategory, SponsorshipType, VerificationStatus } from './enums';
import { IdSchema, IsoDateSchema, IsoDateTimeSchema, paginated } from './common';

/** Compact creator marker embedded in every UserSummary. */
export const CreatorBadgeSchema = z
  .object({
    category: CreatorCategory.schema,
    verified: z.boolean().describe('True only when platform staff have verified this creator.'),
  })
  .meta({ id: 'CreatorBadge' });
export type CreatorBadge = z.infer<typeof CreatorBadgeSchema>;

export const CreatorProfileSchema = z
  .object({
    category: CreatorCategory.schema,
    verificationStatus: VerificationStatus.schema,
    verifiedAt: IsoDateTimeSchema.nullable(),
    tagline: z.string().nullable(),
    contactEmail: z
      .string()
      .nullable()
      .describe('Public business contact, if the creator chose to publish one.'),
    websiteUrl: z.string().nullable(),
  })
  .meta({ id: 'CreatorProfile' });
export type CreatorProfile = z.infer<typeof CreatorProfileSchema>;

export const UpsertCreatorProfileRequestSchema = z
  .object({
    category: CreatorCategory.schema,
    tagline: z.string().trim().max(120).nullable().optional(),
    contactEmail: z.email().max(254).nullable().optional(),
    websiteUrl: z
      .url({ protocol: /^https$/ })
      .max(300)
      .nullable()
      .optional(),
  })
  .strict();

export const BrandPartnershipSchema = z
  .object({
    id: IdSchema,
    brandName: z.string(),
    brandUrl: z.string().nullable(),
    type: SponsorshipType.schema,
    startedOn: IsoDateSchema.nullable(),
    endedOn: IsoDateSchema.nullable(),
    createdAt: IsoDateTimeSchema,
  })
  .meta({ id: 'BrandPartnership' });
export type BrandPartnership = z.infer<typeof BrandPartnershipSchema>;

export const CreateBrandPartnershipRequestSchema = z
  .object({
    brandName: z.string().trim().min(1).max(80),
    brandUrl: z
      .url({ protocol: /^https$/ })
      .max(300)
      .nullable()
      .optional(),
    type: SponsorshipType.schema,
    startedOn: IsoDateSchema.nullable().optional(),
    endedOn: IsoDateSchema.nullable().optional(),
  })
  .strict();

export const BrandPartnershipPageSchema = paginated(BrandPartnershipSchema, 'BrandPartnershipPage');

/** Sponsorship disclosure attached to a post. `null` on a post means organic content. */
export const SponsorshipSchema = z
  .object({
    type: SponsorshipType.schema,
    brandName: z.string(),
    label: z
      .string()
      .describe('Ready-to-display disclosure text, e.g. "Paid partnership with Acme".'),
    partnershipId: IdSchema.nullable(),
  })
  .meta({ id: 'Sponsorship' });
export type Sponsorship = z.infer<typeof SponsorshipSchema>;

export const SponsorshipInputSchema = z
  .object({
    type: SponsorshipType.schema,
    brandName: z.string().trim().min(1).max(80),
    partnershipId: IdSchema.optional(),
  })
  .strict();
export type SponsorshipInput = z.infer<typeof SponsorshipInputSchema>;
