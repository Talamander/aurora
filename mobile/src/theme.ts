// Aurora tokens for the phone, from design/DIRECTION.md (Revision 4) and design/mobile/DIRECTION.md.
import { Platform, useColorScheme } from 'react-native';
import { useSettings } from './settings';

export interface Palette {
  mode: 'dark' | 'light';
  ground: string;
  surface: string;
  raised: string;
  line: string;
  ink: string;
  ink2: string;
  ink3: string;
  glass: string;
  lamp: string;
  onLamp: string;
  lit: [string, string, string];
  on: string;
  warn: string;
  navbar: string;
  auraOpacity: number;
}

export const dark: Palette = {
  mode: 'dark',
  ground: '#05060a',
  surface: '#0e1016',
  raised: '#171a22',
  line: '#1e2129',
  ink: '#eef0f6',
  ink2: '#a7adba',
  ink3: '#868e9c',
  glass: 'rgba(13,15,21,0.62)',
  lamp: '#ffad7a',
  onLamp: '#1a0f12',
  lit: ['#ffc56b', '#ff7a9c', '#a69bff'],
  on: '#4fe0c6',
  warn: '#ff8a7a',
  navbar: '#0c0d13',
  auraOpacity: 0.62,
};

export const light: Palette = {
  mode: 'light',
  ground: '#f3f4f7',
  surface: '#ffffff',
  raised: '#eceef3',
  line: '#e1e4ea',
  ink: '#0b0d12',
  ink2: '#3d4350',
  ink3: '#5d6472',
  glass: 'rgba(255,255,255,0.84)',
  lamp: '#b53a12',
  onLamp: '#ffffff',
  lit: ['#f08a24', '#e8467c', '#6d5cf0'],
  on: '#0a8a73',
  warn: '#c2331f',
  navbar: '#e9ebf0',
  auraOpacity: 0.34,
};

export function usePalette(): Palette {
  const system = useColorScheme();
  const { theme } = useSettings();
  const mode = theme === 'auto' ? (system === 'light' ? 'light' : 'dark') : theme;
  return mode === 'light' ? light : dark;
}

/** Geist is bundled on both platforms (expo-font), so the display face is identical. */
export const font = {
  regular: 'Geist_400Regular',
  medium: 'Geist_500Medium',
  semibold: 'Geist_600SemiBold',
  bold: 'Geist_700Bold',
  mono: 'GeistMono_500Medium',
  monoRegular: 'GeistMono_400Regular',
};

/** The reading face for long-form articles: Literata on the web build, the platform's own serif
 *  on phones (Georgia on iOS, Noto Serif on Android). */
export const serif = Platform.select({ web: 'Literata', ios: 'Georgia', default: 'serif' }) as string;
export const serifItalic = Platform.select({ web: 'Literata-Italic', ios: 'Georgia', default: 'serif' }) as string;

export const space = { xs: 4, s: 8, m: 12, l: 16, xl: 24, xxl: 32, xxxl: 48 } as const;
export const radius = { card: 26, chip: 999, sheet: 28, media: 20 } as const;
export const target = Platform.OS === 'ios' ? 44 : 48;

/** Platform hues: small owned marks, never chrome. */
const HUES: Record<string, [string, string]> = {
  x: ['#0b0d12', '#eef0f6'],
  bluesky: ['#1d7bf2', '#4f9bff'],
  mastodon: ['#5b4be0', '#8b7dff'],
  reddit: ['#ff4500', '#ff6a33'],
  youtube: ['#e5242b', '#ff5a5f'],
  rss: ['#f08c00', '#ffa53a'],
  import: ['#7a8494', '#9aa3b1'],
  instagram: ['#d6297a', '#ff5fa2'],
  facebook: ['#1866e0', '#5b9bff'],
  threads: ['#111318', '#e7e9ee'],
  tiktok: ['#00a7b5', '#2fd3df'],
  linkedin: ['#0a66c2', '#4d9bef'],
  telegram: ['#229ed9', '#4fc0f0'],
  hackernews: ['#f26522', '#ff8a4f'],
  aurora: ['#7a5cff', '#a69bff'],
  web: ['#6b7686', '#9aa3b1'],
  demo: ['#a0a8b4', '#a0a8b4'],
};
export function hue(platform: string, p: Palette): string {
  const h = HUES[platform] ?? HUES.web;
  return p.mode === 'dark' ? h[1] : h[0];
}

const NAMES: Record<string, string> = {
  x: 'X', bluesky: 'Bluesky', mastodon: 'Mastodon', reddit: 'Reddit', youtube: 'YouTube', instagram: 'Instagram',
  facebook: 'Facebook', threads: 'Threads', tiktok: 'TikTok', linkedin: 'LinkedIn', telegram: 'Telegram',
  hackernews: 'Hacker News', aurora: 'Friends', rss: 'Feed', web: 'Web', import: 'Import', demo: 'Demo',
};
export function platformLabel(p: string): string {
  return NAMES[p] ?? p.replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
}
