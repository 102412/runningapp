import type { Sport, SportKey, SportPreference } from '@runningapp/contracts';
import type { Clock } from '../../platform/clock';
import type { Db } from '../../platform/db/client';
import { AppError } from '../../platform/errors';

const CACHE_TTL_MS = 60_000;

/** Sports reference data (rows, not an enum) plus each user's explicit sport interests. */
export class SportService {
  private cache: { at: number; sports: Sport[] } | undefined;

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  async list(): Promise<Sport[]> {
    const now = this.clock.now().getTime();
    if (this.cache && now - this.cache.at < CACHE_TTL_MS) return this.cache.sports;
    const rows = await this.db.selectFrom('sports').selectAll().orderBy('sortOrder').execute();
    const sports: Sport[] = rows.map((r) => ({
      key: r.key as SportKey,
      label: r.label,
      category: r.category,
      speedDisplay: r.speedDisplay,
      supports: {
        distance: r.supportsDistance,
        route: r.supportsRoute,
        elevation: r.supportsElevation,
        heartRate: r.supportsHeartRate,
        cadence: r.supportsCadence,
        power: r.supportsPower,
        splits: r.supportsSplits,
      },
    }));
    this.cache = { at: now, sports };
    return sports;
  }

  async get(key: string): Promise<Sport> {
    const sport = (await this.list()).find((s) => s.key === key);
    if (!sport) throw new AppError('SPORT_NOT_FOUND');
    return sport;
  }

  async getPreferences(userId: string): Promise<SportPreference[]> {
    const rows = await this.db
      .selectFrom('sportPreferences')
      .select(['sportKey', 'relation'])
      .where('userId', '=', userId)
      .orderBy('createdAt')
      .execute();
    return rows.map((r) => ({ sport: r.sportKey as SportKey, relation: r.relation }));
  }

  /** Replaces the user's full preference set atomically. */
  async setPreferences(userId: string, items: SportPreference[]): Promise<SportPreference[]> {
    const known = new Set((await this.list()).map((s) => s.key));
    const unknown = items.filter((i) => !known.has(i.sport));
    if (unknown.length > 0) {
      throw new AppError('VALIDATION_FAILED', {
        details: unknown.map((i) => ({ path: 'items', message: `Unknown sport "${i.sport}".` })),
      });
    }
    const deduped = [...new Map(items.map((i) => [i.sport, i])).values()];
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('sportPreferences').where('userId', '=', userId).execute();
      if (deduped.length > 0) {
        await trx
          .insertInto('sportPreferences')
          .values(deduped.map((i) => ({ userId, sportKey: i.sport, relation: i.relation })))
          .execute();
      }
    });
    return this.getPreferences(userId);
  }
}
