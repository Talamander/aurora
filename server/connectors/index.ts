// Connector registry. The server looks connectors up here by id.

import type { ConnectorInfo } from '../../core/types.ts';
import type { FeedConnector, ImportParser } from './types.ts';
import { rssConnector } from './rss.ts';
import { blueskyConnector } from './bluesky.ts';
import { xBookmarksConnector } from './xApi.ts';
import { importParsers as parsers } from './importers.ts';

export { detectAndParse } from './importers.ts';
export { parseFeed } from './rss.ts';
export { mapAuthorFeed } from './bluesky.ts';
export {
  buildAuthUrl,
  clearTokens,
  completeAuthorization,
  exchangeCode,
  fetchMe,
  makePkce,
  makeState,
  mapBookmarksResponse,
  refreshToken,
  storeTokens,
  X_SCOPES,
  X_SECRET_KEYS,
} from './xApi.ts';

export const feedConnectors: Record<string, FeedConnector> = {
  [rssConnector.info.id]: rssConnector,
  [blueskyConnector.info.id]: blueskyConnector,
  'x-bookmarks': xBookmarksConnector,
};

export const importParsers: ImportParser[] = parsers;

/** Platforms we cannot connect to directly, with what does work. Kept short and factual. */
const UNAVAILABLE: ConnectorInfo[] = [
  {
    id: 'mastodon-timeline',
    version: 0,
    name: 'Mastodon home timeline',
    platform: 'mastodon',
    kind: 'api',
    available: false,
    blockedReason: 'Not built yet. It needs an access token from your instance (Preferences > Development) with read:statuses scope.',
    needs: ['Instance URL', 'Personal access token'],
    description: 'Public accounts already work through the RSS connector: add https://<instance>/@<user>.rss.',
  },
  {
    id: 'reddit-api',
    version: 0,
    name: 'Reddit saved posts / home feed',
    platform: 'reddit',
    kind: 'api',
    available: false,
    blockedReason: 'Reddit API access needs a manually approved OAuth app. Not built.',
    needs: ['Approved Reddit API app'],
    description: 'Subreddits work through the RSS connector: add https://www.reddit.com/r/<name>/.rss. Saved items can come from a Reddit data request export later.',
  },
  {
    id: 'threads',
    version: 0,
    name: 'Threads',
    platform: 'rss',
    kind: 'api',
    available: false,
    blockedReason: 'The Threads API only reads your own posts; there is no home feed endpoint and no public RSS.',
    needs: [],
    description: 'No supported way to read your Threads feed.',
  },
  {
    id: 'instagram',
    version: 0,
    name: 'Instagram',
    platform: 'rss',
    kind: 'api',
    available: false,
    blockedReason: 'Instagram offers no feed API (the Basic Display API shut down in Dec 2024) and no public RSS.',
    needs: [],
    description: 'No supported way to read your Instagram feed.',
  },
  {
    id: 'linkedin',
    version: 0,
    name: 'LinkedIn',
    platform: 'rss',
    kind: 'api',
    available: false,
    blockedReason: 'LinkedIn feed APIs are limited to approved partners, and there is no public RSS.',
    needs: [],
    description: 'No supported way to read your LinkedIn feed. Your data export (Settings > Data privacy) may include saved items.',
  },
];

export function connectorInfos(): ConnectorInfo[] {
  return [
    ...Object.values(feedConnectors).map((c) => c.info),
    ...importParsers.map((p) => p.info),
    ...UNAVAILABLE,
  ];
}
