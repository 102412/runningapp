import type { Activity, CreateActivityRequest, UpdateActivityRequest } from '@runningapp/contracts';
import type { Db } from '../platform/db/client';
import type { ActivityService } from '../modules/activities/service';

/**
 * Application-level orchestration for the "LOG" step of DO -> LOG -> SHOW.
 * Lives outside any module because it spans several (activities now; posts once they exist),
 * which keeps those modules free of dependencies on each other.
 */
export class ActivityFlows {
  constructor(
    private readonly db: Db,
    private readonly activities: ActivityService,
  ) {}

  async logActivity(
    userId: string,
    input: CreateActivityRequest,
    options: {
      source?: 'MANUAL' | 'FILE_IMPORT';
      externalId?: string;
      skipCapabilityCheck?: boolean;
    } = {},
  ): Promise<{ activity: Activity; created: boolean }> {
    const result = await this.db
      .transaction()
      .execute((trx) => this.activities.create(userId, input, { ...options, db: trx }));
    const activity = await this.activities.get(userId, result.id);
    return { activity, created: result.created };
  }

  async updateActivity(
    userId: string,
    id: string,
    patch: UpdateActivityRequest,
  ): Promise<Activity> {
    return this.activities.update(userId, id, patch);
  }

  async deleteActivity(userId: string, id: string): Promise<void> {
    await this.db.transaction().execute((trx) => this.activities.delete(userId, id, trx));
  }
}
