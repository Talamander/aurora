// Explainable, rule-based classifiers. Every verdict carries the rule and the
// evidence that triggered it, and the user can override any item.

import { normalizeForMatch } from './normalize.ts';
import type { Item, Topic } from './types.ts';

export interface NoiseSignal {
  rule: 'engagement-bait' | 'promo' | 'low-content' | 'bare-repost' | 'hashtag-stuffing';
  label: string;
  evidence: string;
}

export interface NoiseVerdict {
  isNoise: boolean;
  signals: NoiseSignal[];
  overridden: boolean;
}

const BAIT = [
  'like if', 'rt if', 'retweet if', 'follow for more', 'follow me for', 'drop a', 'comment below',
  'who else', 'agree?', 'thoughts?', 'tag someone', 'smash that', 'link in bio', 'let that sink in',
  'unpopular opinion', 'you won\'t believe', 'thread 🧵', 'a thread 🧵', 'bookmark this',
];
const PROMO = [
  'promo code', 'use code', 'discount code', 'giveaway', 'sponsored', '#ad', '#sponsored',
  'affiliate link', 'limited time offer', 'sign up now', 'buy now', 'dm me for', '% off',
];

const phraseRes = new Map<string, RegExp>();
/** Phrase match on word boundaries, so "use code" does not fire inside "because code" and "#ad" not on "#adobe". */
function findPhrase(text: string, phrases: string[]): string | null {
  for (const p of phrases) {
    let re = phraseRes.get(p);
    if (!re) {
      const esc = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const left = /^[\p{L}\p{N}]/u.test(p) ? '(?<![\\p{L}\\p{N}#@])' : '';
      const right = /[\p{L}\p{N}]$/u.test(p) ? '(?![\\p{L}\\p{N}])' : '';
      re = new RegExp(left + esc + right, 'u');
      phraseRes.set(p, re);
    }
    if (re.test(text)) return p;
  }
  return null;
}

export const NOISE_RULES_VERSION = 1;

export function classifyNoise(item: Pick<Item, 'text' | 'title' | 'kind' | 'media' | 'links' | 'quoted' | 'state'>): NoiseVerdict {
  const t = normalizeForMatch(`${item.title ?? ''} ${item.text}`);
  const signals: NoiseSignal[] = [];
  const bait = findPhrase(t, BAIT);
  if (bait) signals.push({ rule: 'engagement-bait', label: 'Engagement bait', evidence: `contains “${bait}”` });
  const promo = findPhrase(t, PROMO);
  if (promo) signals.push({ rule: 'promo', label: 'Promotion', evidence: `contains “${promo}”` });
  const words = t.replace(/https?:\/\/\S+/g, '').replace(/[@#]\w+/g, '').trim();
  if (words.length < 12 && !item.media.length && !item.links.length && !item.quoted && item.kind !== 'article') {
    signals.push({ rule: 'low-content', label: 'Very short', evidence: `${words.length} characters, no media or link` });
  }
  if (item.kind === 'repost' && words.length === 0) {
    signals.push({ rule: 'bare-repost', label: 'Repost without comment', evidence: 'no added text' });
  }
  const tags = t.match(/#[\p{L}\p{N}_]+/gu) ?? [];
  if (tags.length >= 5) signals.push({ rule: 'hashtag-stuffing', label: 'Hashtag stuffing', evidence: `${tags.length} hashtags` });

  const override = item.state?.noiseOverride;
  if (override === true) return { isNoise: false, signals, overridden: true };
  if (override === false) return { isNoise: true, signals, overridden: true };
  return { isNoise: signals.length > 0, signals, overridden: false };
}

export interface TopicMatch {
  topicId: string;
  topicName: string;
  term: string;
}

/** Whole-word (or phrase) match, case and accent insensitive. */
const termRes = new Map<string, RegExp | null>();
export function termMatches(haystackNorm: string, term: string): boolean {
  let re = termRes.get(term);
  if (re === undefined) {
    const n = normalizeForMatch(term);
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    re = n ? new RegExp(`(^|[^\\p{L}\\p{N}])${esc}($|[^\\p{L}\\p{N}])`, 'u') : null;
    if (termRes.size > 5000) termRes.clear();
    termRes.set(term, re);
  }
  return re ? re.test(haystackNorm) : false;
}

export function itemHaystack(item: Pick<Item, 'text' | 'title' | 'author' | 'quoted' | 'links'>): string {
  return normalizeForMatch(
    [item.title ?? '', item.text, item.quoted?.text ?? '', item.author.name, item.author.handle ?? '', item.links.join(' ')].join(' \n '),
  );
}

export function matchTopics(haystackNorm: string, topics: Topic[]): TopicMatch[] {
  const out: TopicMatch[] = [];
  for (const topic of topics) {
    const term = topic.terms.find((t) => termMatches(haystackNorm, t));
    if (term) out.push({ topicId: topic.id, topicName: topic.name, term });
  }
  return out;
}
