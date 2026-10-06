import type { BrandPartnership, CreatorCategory, CreatorProfile } from '@runningapp/contracts';
import type { Db } from '../../platform/db/client';
import { keysetBefore, timestampText } from '../../platform/db/keyset';
import { AppError } from '../../platform/errors';
import { z } from 'zod';
import { decodeCursor, encodeCursor, sliceProbe } from '../../platform/http/cursor';

const TimeCursor = z.object({ t: z.string(), id: z.uuid() });

/** Creator/professional account metadata and brand-partnership records. */
export class CreatorService {
  constructor(private readonly db: Db) {}

  async get(userId: string): Promise<CreatorProfile | null> {
    const row = await this.db
      .selectFrom('creatorProfiles')
      .selectAll()
      .where('userId', '=', userId)
      .executeTakeFirst();
    return row ? toView(row) : null;
  }

  /**
   * Becoming a creator is self-service; verification (the blue-check equivalent) is NOT. It is set
   * only by staff through the moderation audit trail, so a user can never grant it to themselves.
   */
  async upsert(
    userId: string,
    input: {
      category: CreatorCategory;
      tagline?: string | null | undefined;
      contactEmail?: string | null | undefined;
      websiteUrl?: string | null | undefined;
    },
  ): Promise<CreatorProfile> {
    const row = await this.db
      .insertInto('creatorProfiles')
      .values({
        userId,
        category: input.category,
        tagline: input.tagline ?? null,
        contactEmail: input.contactEmail?.toLowerCase() ?? null,
        websiteUrl: input.websiteUrl ?? null,
      })
      .onConflict((oc) =>
        oc.column('userId').doUpdateSet({
          category: input.category,
          ...(input.tagline !== undefined ? { tagline: input.tagline } : {}),
          ...(input.contactEmail !== undefined
            ? { contactEmail: input.contactEmail?.toLowerCase() ?? null }
            : {}),
          ...(input.websiteUrl !== undefined ? { websiteUrl: input.websiteUrl } : {}),
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    return toView(row);
  }

  async remove(userId: string): Promise<void> {
    await this.db.deleteFrom('creatorProfiles').where('userId', '=', userId).execute();
  }

  async requestVerification(userId: string): Promise<CreatorProfile> {
    const res = await this.db
      .updateTable('creatorProfiles')
      .set({ verificationStatus: 'PENDING' })
      .where('userId', '=', userId)
      .where('verificationStatus', '=', 'NONE')
      .returningAll()
      .executeTakeFirst();
    if (res) return toView(res);
    const existing = await this.get(userId);
    if (!existing)
      throw new AppError('INVALID_STATE', { message: 'Create a creator profile first.' });
    return existing; // already PENDING or VERIFIED: idempotent
  }

  // ------------------------------------------------------------------ brand partnerships

  async listPartnerships(userId: string, args: { limit: number; cursor?: string | undefined }) {
    const cursor = args.cursor ? decodeCursor(args.cursor, TimeCursor) : undefined;
    let q = this.db
      .selectFrom('brandPartnerships as b')
      .selectAll('b')
      .select(timestampText('b.created_at').as('ts'))
      .where('b.creatorUserId', '=', userId)
      .orderBy('b.createdAt', 'desc')
      .orderBy('b.id', 'desc')
      .limit(args.limit + 1);
    if (cursor) q = q.where(keysetBefore('b.created_at', 'b.id', cursor));
    const { page, hasMore } = sliceProbe(await q.execute(), args.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(partnershipView),
      nextCursor: hasMore && last ? encodeCursor({ t: last.ts, id: last.id }) : null,
    };
  }

  async createPartnership(
    userId: string,
    input: {
      brandName: string;
      brandUrl?: string | null | undefined;
      type: BrandPartnership['type'];
      startedOn?: string | null | undefined;
      endedOn?: string | null | undefined;
    },
  ): Promise<BrandPartnership> {
    if (!(await this.get(userId)))
      throw new AppError('INVALID_STATE', { message: 'Create a creator profile first.' });
    if (input.startedOn && input.endedOn && input.endedOn < input.startedOn) {
      throw new AppError('VALIDATION_FAILED', {
        details: [{ path: 'endedOn', message: 'Cannot be before startedOn.' }],
      });
    }
    const row = await this.db
      .insertInto('brandPartnerships')
      .values({
        creatorUserId: userId,
        brandName: input.brandName,
        brandUrl: input.brandUrl ?? null,
        type: input.type,
        startedOn: input.startedOn ?? null,
        endedOn: input.endedOn ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return partnershipView(row);
  }

  async deletePartnership(userId: string, id: string): Promise<void> {
    await this.db
      .deleteFrom('brandPartnerships')
      .where('id', '=', id)
      .where('creatorUserId', '=', userId)
      .execute();
  }
}

type CreatorRow = {
  category: CreatorCategory;
  verificationStatus: CreatorProfile['verificationStatus'];
  verifiedAt: Date | null;
  tagline: string | null;
  contactEmail: string | null;
  websiteUrl: string | null;
};
const toView = (r: CreatorRow): CreatorProfile => ({
  category: r.category,
  verificationStatus: r.verificationStatus,
  verifiedAt: r.verifiedAt?.toISOString() ?? null,
  tagline: r.tagline,
  contactEmail: r.contactEmail,
  websiteUrl: r.websiteUrl,
});

type PartnershipRow = {
  id: string;
  brandName: string;
  brandUrl: string | null;
  type: BrandPartnership['type'];
  startedOn: string | null;
  endedOn: string | null;
  createdAt: Date;
};
const partnershipView = (r: PartnershipRow): BrandPartnership => ({
  id: r.id,
  brandName: r.brandName,
  brandUrl: r.brandUrl,
  type: r.type,
  startedOn: r.startedOn,
  endedOn: r.endedOn,
  createdAt: r.createdAt.toISOString(),
});
