import { sql } from 'kysely';
import type { Db } from '../../platform/db/client';
import { uuidv7 } from '../../platform/ids';
import type { EventRecorder, RecordedEvent } from './recorder';

/**
 * Records server-originated behavioural events (likes, comments, follows...) into `feed_events`.
 *
 * It runs inside the caller's transaction, so an event exists if and only if the action committed.
 * Users who switched personalization off are skipped inside the same statement (no extra query),
 * and a `feedRequestId` is attributed only if it belongs to the acting user.
 */
export class DbEventRecorder implements EventRecorder {
  constructor(private readonly db: Db) {}

  async record(event: RecordedEvent, db: Db = this.db): Promise<void> {
    const postId = event.postId ?? null;
    await sql`
      insert into feed_events
        (event_id, user_id, event_type, origin, post_id, activity_id, subject_user_id,
         surface, feed_request_id, position, value_ms)
      select
        ${uuidv7()}::uuid, ${event.userId}::uuid, ${event.type}::feed_event_type, 'SERVER',
        ${postId}::uuid,
        coalesce(${event.activityId ?? null}::uuid, (select activity_id from posts where id = ${postId}::uuid)),
        ${event.subjectUserId ?? null}::uuid,
        ${event.context?.surface ?? null}::feed_surface,
        (select id from feed_requests where id = ${event.context?.feedRequestId ?? null}::uuid and user_id = ${event.userId}::uuid),
        ${event.context?.position ?? null}::smallint,
        ${event.valueMs ?? null}::integer
      where exists (
        select 1 from user_settings where user_id = ${event.userId}::uuid and personalization_enabled
      )`.execute(db);
  }
}
