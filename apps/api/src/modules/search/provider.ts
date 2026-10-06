/**
 * Search is a port. The default implementation (PostgresSearchProvider) uses full-text search and
 * trigram matching and is good for early scale. To move to Meilisearch / Typesense / OpenSearch,
 * implement this interface, keep it in sync (outbox/CDC), and swap it in the composition root.
 *
 * Providers return ORDERED ids / lightweight rows only. SearchService re-checks visibility
 * (blocks, privacy, discoverability, age rules) against the database before anything is returned,
 * so a stale or buggy external index can never leak content.
 */
export interface SearchContext {
  viewerId: string;
  /** Accounts born after this date (YYYY-MM-DD) are never surfaced. */
  minorCutoffDate: string;
}

export interface SearchPaging {
  offset: number;
  limit: number;
}

export interface SearchHits<T> {
  hits: T[];
  hasMore: boolean;
}

export interface TopicHit {
  slug: string;
  postCount: number;
}

export interface SearchProvider {
  readonly name: string;
  searchUsers(ctx: SearchContext, text: string, paging: SearchPaging): Promise<SearchHits<string>>;
  searchPosts(ctx: SearchContext, text: string, paging: SearchPaging): Promise<SearchHits<string>>;
  searchTopics(
    ctx: SearchContext,
    text: string,
    paging: SearchPaging,
  ): Promise<SearchHits<TopicHit>>;
}
