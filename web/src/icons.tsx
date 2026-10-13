// One icon set, one stroke weight (1.6), drawn on a 24px grid.
const P: Record<string, string> = {
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm9 16-4.2-4.2',
  filter: 'M4 6h16M7 12h10M10 18h4',
  bookmark: 'M7 4h10v16l-5-3.5L7 20V4Z',
  bookmarkFill: 'M7 4h10v16l-5-3.5L7 20V4Z',
  check: 'M5 12.5 10 17l9-10',
  circle: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10Z',
  archive: 'M4 7h16M5 7l1 12h12l1-12M9 11h6M6 4h12l2 3H4l2-3Z',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5H5V6h5',
  x: 'M6 6l12 12M18 6 6 18',
  plus: 'M12 5v14M5 12h14',
  undo: 'M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  sync: 'M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4',
  back: 'M15 5l-7 7 7 7',
  eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Zm9.5-3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',
  eyeOff: 'M4 4l16 16M9.9 5.8A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-3 3.8M6.3 7.6A16.5 16.5 0 0 0 2.5 12S6 18.5 12 18.5c1.4 0 2.7-.3 3.8-.8',
  mute: 'M12 5 7 9H4v6h3l5 4V5Zm5 4.5 4 5m0-5-4 5',
  layers: 'M12 4 3 9l9 5 9-5-9-5Zm-9 9 9 5 9-5',
  thread: 'M7 4.5a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm0 5.5v4m0 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm4-11.5h8M11 8h5m-5 6.5h8M11 18h5',
  columns: 'M4 5h4.5v14H4V5Zm5.75 0h4.5v14h-4.5V5ZM15.5 5H20v14h-4.5V5Z',
  inbox: 'M4 13h5l1.5 2.5h3L15 13h5M4 13l2.5-8h11L20 13v6H4v-6Z',
  sliders: 'M5 4v6M5 14v6M12 4v10M12 18v2M19 4v2M19 10v10M3 12h4M10 16h4M17 8h4',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0-5v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4m0-12.8L17 7M7 17l-1.4 1.4',
  moon: 'M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5Z',
  keyboard: 'M3 7h18v10H3V7Zm3 3h1m3 0h1m3 0h1m3 0h1M7 14h10',
  upload: 'M12 16V4m-5 5 5-5 5 5M4 16v4h16v-4',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 8v5m0-8.5v.5',
  folder: 'M3 6h6l2 2h10v11H3V6Z',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4.5V12l3 2',
  play: 'M8 5v14l11-7L8 5Z',
  pause: 'M8 5h2.5v14H8zM13.5 5H16v14h-2.5z',
  headphones: 'M4 15v-3a8 8 0 0 1 16 0v3M4 15h3v5H5a1 1 0 0 1-1-1v-4Zm16 0h-3v5h2a1 1 0 0 0 1-1v-4Z',
  skipNext: 'M6 5v14l9-7-9-7Zm12 0v14',
  paraNext: 'M5 7h9M5 12h6M5 17h9M16 9l3 3-3 3',
  paraPrev: 'M10 7h9M13 12h6M10 17h9M8 9l-3 3 3 3',
  tag: 'M3 12V4h8l9 9-8 8-9-9Zm5-4h.01',
  arrowUp: 'M12 19V5m-6 6 6-6 6 6',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Zm7 12 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z',
  page: 'M4 4h7v7H4V4Zm9 0h7v4h-7V4Zm0 6h7v10h-7V10ZM4 13h7v7H4v-7Z',
  chart: 'M4 20V10m5.3 10V4m5.4 16v-7M20 20V8',
  image: 'M4 5h16v14H4V5Zm0 11 4.5-4.5 4 4 2.5-2.5L20 18M15 9h.01',
  people: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm-6 9c0-3.3 2.7-6 6-6s6 2.7 6 6M16 4.5a3.5 3.5 0 0 1 0 6.5M18 14c2 .7 3 3 3 6',
  star: 'M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.8L12 3.5Z',
  heart: 'M12 20s-7.5-4.6-7.5-10A4.5 4.5 0 0 1 12 7.1 4.5 4.5 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10Z',
  bolt: 'M13 3 5 14h6l-1 7 8-11h-6l1-7Z',
  news: 'M4 5h13v14H6a2 2 0 0 1-2-2V5Zm13 4h3v8a2 2 0 0 1-2 2M7 9h7M7 13h7M7 16h4',
  video: 'M4 6h12v12H4V6Zm12 4 4-2.5v9L16 14',
  music: 'M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm11-2a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
  map: 'M9 4 3 6.5v13.5l6-2.5 6 2.5 6-2.5V4l-6 2.5L9 4Zm0 0v13.5m6-11v13.5',
  code: 'M8 7l-5 5 5 5m8-10 5 5-5 5M14 4l-4 16',
  wrench: 'M14.5 6.5a4 4 0 0 0 5 5L21 13l-8 8-2.5-2.5 1.5-1.5-6-6L4.5 12.5 2 10l8-8 1.5 1.5a4 4 0 0 0 3 3Z',
  trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13',
  briefcase: 'M4 8h16v11H4V8Zm5 0V5.5h6V8M4 13h16',
  gamepad: 'M7 8h10a4 4 0 0 1 4 4.5l-.6 3.6a2 2 0 0 1-3.4 1L15 15H9l-2 2.1a2 2 0 0 1-3.4-1L3 12.5A4 4 0 0 1 7 8Zm1 2.5v3m-1.5-1.5h3M15.5 11.5h.01M17.5 13.5h.01',
  home: 'M4 11 12 4l8 7M6 9.5V20h12V9.5M10 20v-5h4v5',
  book: 'M4 5.5C6.5 4 9.5 4 12 6c2.5-2 5.5-2 8-.5V19c-2.5-1.5-5.5-1.5-8 .5-2.5-2-5.5-2-8-.5V5.5ZM12 6v13.5',
  globe: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17ZM3.5 12h17M12 3.5c2.3 2.3 3.5 5.2 3.5 8.5s-1.2 6.2-3.5 8.5c-2.3-2.3-3.5-5.2-3.5-8.5s1.2-6.2 3.5-8.5Z',
  coffee: 'M5 9h11v5a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5V9Zm11 1h1.5a2.5 2.5 0 0 1 0 5H16M8 3.5v2.5m3-2.5v2.5',
  bell: 'M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2H4.5l1.5-2ZM10 20.5a2.2 2.2 0 0 0 4 0',
  expand: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  constellation: 'M5.5 17.5 10 9.5m1.6-.2 3.8 3.4m1.9-.3 2-5.2M5.5 16a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Zm5-8.2a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 0 1 0-3.2Zm6 3.9a1.3 1.3 0 1 1 0 2.6 1.3 1.3 0 0 1 0-2.6Zm3-6.6a1.2 1.2 0 1 1 0 2.4 1.2 1.2 0 0 1 0-2.4Z',
  bellOff: 'M6 16.5V11c0-1 .2-1.9.6-2.7M9 5.8A6 6 0 0 1 18 11v5.5l1.5 2H8M10 20.5a2.2 2.2 0 0 0 4 0M4 4l16 16',
};

/** Icons a profile can wear. */
export const PROFILE_ICONS = ['star', 'briefcase', 'gamepad', 'home', 'people', 'heart', 'news', 'book', 'code', 'music', 'video', 'chart', 'globe', 'coffee', 'bolt', 'sparkle', 'map', 'image'];

export function Icon({ name, size = 18, title, fill }: { name: keyof typeof P | string; size?: number; title?: string; fill?: boolean }) {
  const filled = fill || name === 'bookmarkFill' || name === 'play' || name === 'pause';
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      className="icon"
    >
      {title && <title>{title}</title>}
      <path d={P[name] ?? P.circle} />
    </svg>
  );
}
