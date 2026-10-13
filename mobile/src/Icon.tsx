// Each platform's own icons: Material Symbols' shapes on Android (and the web preview),
// SF-style Ionicons on iOS. Never the other platform's set.
import { Platform } from 'react-native';
// Per-set imports, so only these two icon fonts ship (the package index bundles all of them).
import Ionicons from '@expo/vector-icons/Ionicons';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';

const MAP = {
  feed: ['dynamic-feed', 'albums-outline'],
  bell: ['notifications-none', 'notifications-outline'],
  bellOn: ['notifications-active', 'notifications'],
  today: ['wb-sunny', 'sunny-outline'],
  agent: ['auto-awesome', 'sparkles-outline'],
  sources: ['hub', 'git-network-outline'],
  settings: ['settings', 'settings-outline'],
  save: ['bookmark-border', 'bookmark-outline'],
  saved: ['bookmark', 'bookmark'],
  hide: ['visibility-off', 'eye-off-outline'],
  ask: ['auto-awesome', 'sparkles-outline'],
  back: ['arrow-back', 'chevron-back'],
  send: ['arrow-upward', 'arrow-up'],
  play: ['play-arrow', 'play'],
  stop: ['stop', 'stop'],
  listen: ['headphones', 'headset-outline'],
  open: ['open-in-new', 'open-outline'],
  sync: ['sync', 'sync-outline'],
  qr: ['qr-code-scanner', 'scan-outline'],
  check: ['check', 'checkmark'],
  close: ['close', 'close'],
  phone: ['smartphone', 'phone-portrait-outline'],
  error: ['error-outline', 'alert-circle-outline'],
  person: ['person-outline', 'person-outline'],
  page: ['article', 'document-text-outline'],
  chevron: ['chevron-right', 'chevron-forward'],
  link: ['link', 'link-outline'],
  search: ['search', 'search-outline'],
  offline: ['cloud-off', 'cloud-offline-outline'],
  related: ['auto-awesome-motion', 'copy-outline'],
  expand: ['expand-more', 'chevron-down'],
  later: ['bookmark-add', 'book-outline'],
  laterOn: ['bookmark-added', 'book'],
  read: ['chrome-reader-mode', 'reader-outline'],
  highlight: ['border-color', 'color-wand-outline'],
  friends: ['group', 'people-outline'],
  reply: ['reply', 'arrow-undo-outline'],
  skip: ['skip-next', 'play-skip-forward-outline'],
  clock: ['schedule', 'time-outline'],
  history: ['history', 'time-outline'],
  // Profile icons (the desktop's PROFILE_ICONS names)
  star: ['star-outline', 'star-outline'],
  briefcase: ['work-outline', 'briefcase-outline'],
  gamepad: ['sports-esports', 'game-controller-outline'],
  home: ['home', 'home-outline'],
  people: ['group', 'people-outline'],
  heart: ['favorite-border', 'heart-outline'],
  news: ['newspaper', 'newspaper-outline'],
  book: ['menu-book', 'book-outline'],
  code: ['code', 'code-slash-outline'],
  music: ['music-note', 'musical-notes-outline'],
  video: ['videocam', 'videocam-outline'],
  chart: ['insert-chart-outlined', 'bar-chart-outline'],
  globe: ['public', 'globe-outline'],
  coffee: ['local-cafe', 'cafe-outline'],
  bolt: ['bolt', 'flash-outline'],
  triage: ['style', 'albums-outline'],
  sparkle: ['auto-awesome', 'sparkles-outline'],
  map: ['map', 'map-outline'],
  image: ['image', 'image-outline'],
} as const;

/** A profile's icon in this set, or a star for names the phone does not know. */
export function profileIcon(name: string | undefined): IconName {
  return name && name in MAP ? (name as IconName) : 'star';
}

export type IconName = keyof typeof MAP;

export function Icon({ name, size = 22, color }: { name: IconName; size?: number; color: string }) {
  const [m, i] = MAP[name];
  if (Platform.OS === 'ios') return <Ionicons name={i as any} size={size} color={color} />;
  return <MaterialIcons name={m as any} size={size} color={color} />;
}
