import type { ContentVisibility } from '@runningapp/contracts';
import type { Config } from '../../config';
import type { Clock } from '../../platform/clock';
import type { Db } from '../../platform/db/client';
import { AppError } from '../../platform/errors';
import { ageOn } from './age';

/**
 * Age-based safety rules in one place. Policy defaults live in config (and are flagged for legal
 * review in docs/SECURITY.md): accounts under MINOR_PUBLIC_MIN_AGE can never publish publicly.
 */
export class AgePolicy {
  constructor(
    private readonly config: Config,
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  async ageOf(userId: string, db: Db = this.db): Promise<number> {
    const row = await db
      .selectFrom('users')
      .select('birthDate')
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!row) throw new AppError('USER_NOT_FOUND');
    return ageOn(row.birthDate, this.clock.now());
  }

  async canPublishPublicly(userId: string, db: Db = this.db): Promise<boolean> {
    return (await this.ageOf(userId, db)) >= this.config.MINOR_PUBLIC_MIN_AGE;
  }

  /** Throws PUBLIC_ACCOUNT_NOT_ALLOWED when a young user tries to make something PUBLIC. */
  async assertVisibilityAllowed(
    userId: string,
    visibility: ContentVisibility,
    db: Db = this.db,
  ): Promise<void> {
    if (visibility === 'PUBLIC' && !(await this.canPublishPublicly(userId, db))) {
      throw new AppError('PUBLIC_ACCOUNT_NOT_ALLOWED');
    }
  }
}
