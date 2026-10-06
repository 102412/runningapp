import type { PushProviderName } from '@runningapp/contracts';

export interface PushMessage {
  provider: PushProviderName;
  token: string;
  title: string;
  body: string;
  /** Small string map for deep-linking (e.g. { type, postId }). Never put private content here. */
  data: Record<string, string>;
}

export type PushResult = { ok: true } | { ok: false; invalidToken: boolean; error: string };

/**
 * Port for push delivery. Real providers (APNs, FCM, Expo) need developer credentials that only a
 * human can create, so none is bundled; the default just logs. Implement this interface and return
 * it from the composition root to go live. Return `invalidToken: true` for unregistered devices so
 * the stale token is removed.
 */
export interface PushProvider {
  send(message: PushMessage): Promise<PushResult>;
}

export class LoggingPushProvider implements PushProvider {
  constructor(private readonly log: { info: (o: object, m: string) => void }) {}

  async send(message: PushMessage): Promise<PushResult> {
    this.log.info(
      { provider: message.provider, title: message.title, data: message.data },
      'push (not delivered: no provider configured)',
    );
    return { ok: true };
  }
}
