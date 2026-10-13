// Shapes of full-text search results, shared by the server (server/search.ts) and the web app.

export interface Snippet {
  text: string;
  /** [start, end) character ranges in `text` that matched. */
  ranges: [number, number][];
}
export interface SearchHit {
  id: string;
  score: number;
  snippet: Snippet;
}
export interface SearchResult {
  query: string;
  results: SearchHit[];
  /** Matches before the limit, capped at the candidate pool. */
  matched: number;
  ms: number;
  index: IndexStatus;
  /** Set when the query cannot be run as full-text search (only exclusions, or empty). */
  unsupported?: string;
}
export interface RelatedHit {
  id: string;
  score: number;
  /** The rare words this post shares with the one asked about. */
  shared: string[];
  sameAuthor: boolean;
  topics: string[];
}
export interface IndexStatus {
  indexed: number;
  total: number;
  building: boolean;
}
