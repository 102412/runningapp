import type { EventContext, FeedEventType } from '@runningapp/contracts';
import type { Db } from '../db/client';

export interface RecordedEvent {
  userId: string;
  type: FeedEventType;
  postId?: string | null;
  /** The user acted upon (profile_open, follow, unfollow). */
  subjectUserId?: string | null;
  activityId?: string | null;
  context?: EventContext | undefined;
  /** Milliseconds, for WATCH_TIME. */
  valueMs?: number | undefined;
}

/**
 * Port for recording behavioural events (the raw material for ranking). Server-originated
 * actions (like, comment, follow...) are recorded by the services that perform them so the data is
 * authoritative; the client only reports things only it can observe (impressions, watch time...).
 */
export interface EventRecorder {
  record(event: RecordedEvent, db?: Db): Promise<void>;
}
