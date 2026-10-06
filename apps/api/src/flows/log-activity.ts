import type {
  Activity,
  CreateActivityRequest,
  LoggedActivity,
  UpdateActivityRequest,
} from '@runningapp/contracts';
import type { Config } from '../config';
import type { Db } from '../platform/db/client';
import type { ActivityService } from '../modules/activities/service';
import type { PostService } from '../modules/posts/service';

/**
 * Application-level orchestration for DO -> LOG -> SHOW. These flows span several modules
 * (activities + posts), so they live here rather than making either module depend on the other.
 * Each runs in ONE transaction: an activity and its auto-generated post appear (or vanish) together.
 */
export class ActivityFlows {
  constructor(
    private readonly config: Config,
    private readonly db: Db,
    private readonly activities: ActivityService,
    private readonly posts: PostService,
  ) {}

  async logActivity(
    user: { id: string; emailVerified: boolean },
    input: CreateActivityRequest,
    options: {
      source?: 'MANUAL' | 'FILE_IMPORT';
      externalId?: string;
      skipCapabilityCheck?: boolean;
    } = {},
  ): Promise<{ activity: LoggedActivity; created: boolean }> {
    const settings = await this.db
      .selectFrom('userSettings')
      .select('autoCreateActivityPost')
      .where('userId', '=', user.id)
      .executeTakeFirstOrThrow();
    const wantsPost = input.createPost ?? settings.autoCreateActivityPost;
    // Unverified accounts may log activities (privately useful) but not publish to the feed yet.
    const mayPublish = user.emailVerified || !this.config.REQUIRE_VERIFIED_EMAIL_TO_PUBLISH;

    const result = await this.db.transaction().execute(async (trx) => {
      const created = await this.activities.create(user.id, input, { ...options, db: trx });
      let postId: string | null = null;
      if (created.created && wantsPost && mayPublish) {
        const row = await trx
          .selectFrom('activities')
          .select('visibility')
          .where('id', '=', created.id)
          .executeTakeFirstOrThrow();
        // A PRIVATE activity has nothing to show anyone, so it gets no feed post.
        if (row.visibility !== 'PRIVATE') {
          postId = await this.posts.createAutoPost(trx, {
            userId: user.id,
            activityId: created.id,
            visibility: row.visibility,
          });
        }
      } else if (!created.created) {
        postId = await this.posts.autoPostIdFor(trx, created.id);
      }
      return { ...created, postId };
    });
    const activity = await this.activities.get(user.id, result.id);
    return { activity: { ...activity, postId: result.postId }, created: result.created };
  }

  async updateActivity(
    userId: string,
    id: string,
    patch: UpdateActivityRequest,
  ): Promise<Activity> {
    await this.db.transaction().execute(async (trx) => {
      await this.activities.update(userId, id, patch, trx);
      if (patch.visibility !== undefined)
        await this.posts.syncAutoPostVisibility(trx, id, patch.visibility);
    });
    // Read only after the transaction has committed: a separate connection cannot see uncommitted writes.
    return this.activities.get(userId, id);
  }

  async deleteActivity(userId: string, id: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await this.activities.assertOwned(userId, id, trx);
      await this.posts.deleteAutoPosts(trx, id);
      await this.activities.delete(userId, id, trx);
    });
  }
}
