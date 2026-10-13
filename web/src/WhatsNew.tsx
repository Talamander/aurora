import { Fragment } from 'react';
import { Icon } from './icons.tsx';
import { useDialog } from './useDialog.ts';
import './whatsnew.css';

// A short tour of what changed, shown once per release on a library that already has posts, and
// any time from the command palette. Bump RELEASE when the list changes.
export const WHATS_NEW_RELEASE = '2026-10-13';
const SEEN_KEY = 'aurora.whatsNew';

export type WhatsNewGo =
  | 'columns' | 'alerts' | 'week' | 'ambient' | 'studio' | 'follows' | 'search' | 'ai-models' | 'spend'
  | 'friends' | 'profile' | 'read-later' | 'lock' | 'help' | 'routines' | 'profile-hours' | 'onthisday' | 'listen' | 'report' | 'quick' | 'constellation' | 'triage' | 'time' | 'front';

interface Entry { more?: boolean; icon: string; title: string; line: string; go?: WhatsNewGo; cta?: string }

const ENTRIES: Entry[] = [
  { icon: 'sync', title: 'Routines', line: 'Tell Aurora to do something on a schedule ("every weekday at 7:30, make a Work brief") and it runs on its own, within a spending limit.', go: 'routines', cta: 'Make a routine' },
  { icon: 'columns', title: 'Columns', line: 'Read several views or profiles side by side, each scrolling on its own. Press c to tile them.', go: 'columns', cta: 'Tile them' },
  { icon: 'heart', title: 'Friends', line: 'Share a post with a note to people you know, end-to-end encrypted. No followers, no counts.', go: 'friends', cta: 'Open Friends' },
  { icon: 'briefcase', title: 'Profiles', line: 'Work, Gaming, Family, whatever you need: each with its own sources, rules and look.', go: 'profile', cta: 'Make a profile' },
  { icon: 'play', title: 'Your week', line: 'A story of your week: what you read, what your rules spared you, the best thing you found.', go: 'week', cta: 'Play it' },
  { icon: 'headphones', title: 'Listen queue', line: 'Aurora reads your Read later list aloud, one article after another, like a podcast. Your keyboard\'s media keys work too.', go: 'listen', cta: 'Listen' },
  { more: true, icon: 'inbox', title: 'Triage', line: 'Clear new posts one big card at a time: keep, read later, hide or skip with an arrow key or a swipe. Press t.', go: 'triage', cta: 'Clear the deck' },
  { more: true, icon: 'bolt', title: 'Quick look', line: 'A small window with your top five posts, alert hits and what is playing, from a shortcut in the desktop app (Ctrl+Alt+Space, Option+Space on a Mac) or the palette. Ask from it too.', go: 'quick', cta: 'Take a look' },
  { more: true, icon: 'page', title: 'Front page', line: "Today's best posts set like a newspaper: a lead story, In brief, pictures and your people. Picked on this computer, written by no one but your sources.", go: 'front', cta: 'Read the front page' },
  { more: true, icon: 'constellation', title: 'Constellation', line: 'Your reading world as a night sky: the people, sources and topics you spend time with, sized by what you read, saved and highlighted.', go: 'constellation', cta: 'Look up' },
  { more: true, icon: 'thread', title: 'Thread reader', line: 'When someone posts a numbered thread or replies to themselves, the posts fold into one card and open as a single article in the reader.' },
  { more: true, icon: 'clock', title: 'Time well spent', line: 'See how long you read in each profile today and this week, and give a profile a gentle daily limit. It never blocks; it only says so.', go: 'time', cta: 'See my time' },
  { more: true, icon: 'chart', title: 'Source report cards', line: 'See which sources earn their place: what you read, saved and hid from each over 30 days, with a plain keep, quieter or let go.', go: 'report', cta: 'See report cards' },
  { more: true, icon: 'clock', title: 'Profile hours', line: 'Give a profile its hours, like Work on weekdays 9 to 5, and Aurora switches to it then and back afterwards. Your own switch always wins.', go: 'profile-hours', cta: 'Set hours' },
  { more: true, icon: 'bookmark', title: 'On this day', line: 'Posts you saved or highlighted on this date a month or a year ago, in a small card above the feed.', go: 'onthisday', cta: 'Look back' },
  { more: true, icon: 'bell', title: 'Alerts', line: 'Say "tell me when…" and Aurora watches new posts for you, with quiet hours. Nothing leaves this computer.', go: 'alerts', cta: 'Make an alert' },
  { more: true, icon: 'image', title: 'Ambient', line: 'Your feed as a slow full-screen display for a second monitor or a TV.', go: 'ambient', cta: 'Lean back' },
  { more: true, icon: 'star', title: 'Theme studio', line: 'Make a theme from a picture, a mood or by hand. Dark and light stay readable on their own.', go: 'studio', cta: 'Open the studio' },
  { more: true, icon: 'people', title: 'Bring your follows', line: 'Drop the export from YouTube, Instagram, TikTok, Reddit or Mastodon and move everyone over at once.', go: 'follows', cta: 'Bring them' },
  { more: true, icon: 'search', title: 'Better search', line: 'Ranked best matches with highlights, and More like this on any post (press i).', go: 'search', cta: 'Try a search' },
  { more: true, icon: 'book', title: 'Long reads', line: 'A proper reader with highlights, Read later and Listen.', go: 'read-later', cta: 'Read later' },
  { more: true, icon: 'sparkle', title: 'Your models, your spend', line: 'Use a local model for small jobs and see what the AI costs, with caps for background work.', go: 'spend', cta: 'See spend' },
  { more: true, icon: 'eyeOff', title: 'Owner lock', line: 'Passkey sign-in when Aurora is reachable from other machines. Optional on this computer.', go: 'lock', cta: 'Lock settings' },
  { more: true, icon: 'keyboard', title: 'Everywhere', line: 'A desktop app, a phone app, a terminal client (npm run tui) and a Waybar count. All read-only toward every site.', go: 'help', cta: 'Shortcuts' },
];

export function shouldShowWhatsNew(): boolean {
  try {
    // Releases are dates, so a later or equal stored value means this one was seen.
    return (localStorage.getItem(SEEN_KEY) ?? '') < WHATS_NEW_RELEASE;
  } catch {
    return false;
  }
}

export function markWhatsNewSeen() {
  try {
    localStorage.setItem(SEEN_KEY, WHATS_NEW_RELEASE);
  } catch {
    /* private window: it shows again next time, which is harmless */
  }
}

export function WhatsNew({ close, go }: { close: () => void; go: (to: WhatsNewGo) => void }) {
  const dlg = useDialog<HTMLDivElement>();
  const done = () => {
    markWhatsNewSeen();
    close();
  };
  return (
    <div className="sheet-backdrop" onClick={done}>
      <div ref={dlg} className="sheet whatsnew" role="dialog" aria-modal="true" aria-labelledby="wn-title" onClick={(e) => e.stopPropagation()}>
        <div className="wn-sky" aria-hidden><span /><span /><span /></div>
        <div className="sheet-head">
          <div>
            <p className="wn-kicker">Overnight</p>
            <h2 id="wn-title">New in Aurora</h2>
          </div>
          <button className="icon-btn" onClick={done} aria-label="Close"><Icon name="x" /></button>
        </div>
        <ul className="wn-list">
          {ENTRIES.map((e, i) => (
            <Fragment key={e.title}>
            {e.more && !ENTRIES[i - 1]?.more && <li className="wn-more" aria-hidden>Also new</li>}
            <li className="wn-item">
              <span className="wn-icon" aria-hidden><Icon name={e.icon} size={18} /></span>
              <div className="wn-text">
                <h3>{e.title}</h3>
                <p>{e.line}</p>
              </div>
              {e.go && (
                <button className="btn ghost wn-go" onClick={() => { markWhatsNewSeen(); go(e.go!); }}>
                  {e.cta ?? 'Open'}
                </button>
              )}
            </li>
            </Fragment>
          ))}
        </ul>
        <div className="wn-foot">
          <button className="btn primary" onClick={done}>Got it</button>
        </div>
      </div>
    </div>
  );
}
