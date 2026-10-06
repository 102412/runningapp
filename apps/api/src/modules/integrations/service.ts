import type { IntegrationProvider } from '@runningapp/contracts';
import { IntegrationProvider as IntegrationProviderEnum } from '@runningapp/contracts';
import type { Db } from '../../platform/db/client';

/**
 * Providers the server has credentials for. Intentionally EMPTY: Strava/Garmin/Apple Health/Health
 * Connect each require developer credentials (and a reviewed OAuth app) that only a human can
 * obtain, and no provider adapter has been written. Clients must treat `available: false` as
 * "hide the connect button". See docs/DECISIONS.md and HANDOFF.md for the milestone to build these.
 */
const AVAILABLE_PROVIDERS: ReadonlySet<IntegrationProvider> = new Set();

export class IntegrationService {
  constructor(private readonly db: Db) {}

  async list(userId: string) {
    const rows = await this.db
      .selectFrom('integrationConnections')
      .select(['provider', 'status', 'lastSyncedAt'])
      .where('userId', '=', userId)
      .execute();
    const byProvider = new Map(rows.map((r) => [r.provider, r]));
    return IntegrationProviderEnum.values.map((provider) => {
      const row = byProvider.get(provider);
      return {
        provider,
        available: AVAILABLE_PROVIDERS.has(provider),
        connected: row?.status === 'CONNECTED',
        status: row?.status ?? null,
        lastSyncedAt: row?.lastSyncedAt?.toISOString() ?? null,
      };
    });
  }

  async disconnect(userId: string, provider: IntegrationProvider): Promise<void> {
    await this.db
      .deleteFrom('integrationConnections')
      .where('userId', '=', userId)
      .where('provider', '=', provider)
      .execute();
  }
}
