// Friends: invite people you know, share a post with a note, react and reply. Everything is
// end-to-end encrypted between Aurora instances; see docs/social.md. Friend text is rendered as
// plain React text, never as HTML.
import { useEffect, useState } from 'react';
import type { Item, Profile } from '../../core/types.ts';
import { Icon } from './icons.tsx';
import { useDialog } from './useDialog.ts';
import './friends.css';

type Toast = (text: string, opts?: { tone?: 'info' | 'error' }) => void;

export interface Friend {
  fp: string;
  fpShort: string;
  handle: string;
  nickname: string | null;
  name: string;
  relay: string;
  status: 'pending_in' | 'pending_out' | 'friend' | 'blocked';
  since: string;
  circles: string[];
}
export interface Circle {
  id: string;
  name: string;
  profile: string | null;
  members: string[];
}
export interface SocialState {
  enabled: boolean;
  me: { handle: string; fp: string; fpShort: string; relay: string } | null;
  localRelay: string | null;
  friends: Friend[];
  circles: Circle[];
  invites: { id: string; createdAt: string; expiresAt: string }[];
  reactions: string[];
  outbox: { pending: number; lastError: string | null };
  lastPollAt: string | null;
  lastPollError: string | null;
  unread: number;
  pendingIn: number;
  /** Weekly lists, collections and connector suggestions (server/social/extras.ts). */
  extras?: { inboxNew: number; digestsOn: string[] };
}
interface Thread {
  localId: string;
  /** Replies this fetch marked as read; the badge refreshes when it is above zero. */
  marked: number;
  direction: 'in' | 'out';
  note: string;
  at: string;
  itemId: string | null;
  snapshot: { title: string; text: string; url: string | null; author: { name: string; handle: string }; platform: string };
  conversations: {
    peer: { fp: string; name: string; status: string };
    reaction: string | null;
    myReaction: string | null;
    messages: { id: string; fromMe: boolean; text: string; at: string }[];
  }[];
}
interface ShareRow {
  localId: string;
  direction: 'in' | 'out';
  note: string;
  at: string;
  title: string;
  url: string | null;
  peers: string[];
  replies: number;
  reactions: string[];
  unread: number;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* empty */
  }
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
  return data as T;
}

// One shared copy of the Friends state for the rail badge, the sheet and every post.
let cache: SocialState | null = null;
let inflight: Promise<SocialState> | null = null;
const subs = new Set<(s: SocialState) => void>();
function publish(s: SocialState) {
  cache = s;
  subs.forEach((f) => f(s));
  return s;
}
export function refreshSocial(): Promise<SocialState> {
  inflight ??= call<SocialState>('GET', '/api/social').then(publish).finally(() => (inflight = null));
  return inflight;
}
export function useSocial(version?: unknown): SocialState | null {
  const [s, setS] = useState(cache);
  useEffect(() => {
    subs.add(setS);
    return () => void subs.delete(setS);
  }, []);
  useEffect(() => {
    void refreshSocial().catch(() => undefined);
  }, [version]);
  return s;
}

const isFriendsItem = (it: Item) => it.provenance.connector === 'friends';
const initial = (name: string) => (name.trim()[0] ?? '?').toUpperCase();
const hostOf = (u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};
function ago(iso: string | null): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** The invite as a QR code: an SVG path built from the module grid, no HTML injection. The
 * encoder loads with the first invite, so it stays out of the first page load. */
function Qr({ text }: { text: string }) {
  const [qr, setQr] = useState<{ d: string; n: number } | null>(null);
  useEffect(() => {
    let live = true;
    void import('./vendor/qrcode.js').then(({ default: qrcode }) => {
      const q = qrcode(0, 'M');
      q.addData(text);
      q.make();
      const n = q.getModuleCount();
      let d = '';
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
      if (live) setQr({ d, n });
    });
    return () => {
      live = false;
    };
  }, [text]);
  const n = qr?.n ?? 29;
  return (
    <svg className="fr-qr" viewBox={`0 0 ${n + 8} ${n + 8}`} shapeRendering="crispEdges" role="img" aria-label="Invite QR code" aria-busy={!qr}>
      <rect width={n + 8} height={n + 8} fill="#fff" />
      {qr && <path d={qr.d} fill="#0b0d12" />}
    </svg>
  );
}

function Avatar({ name, size = 34, hue }: { name: string; size?: number; hue?: number }) {
  // A stable hue per name, so friends are recognisable at a glance.
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return (
    <span className="fr-av" style={{ width: size, height: size, fontSize: size * 0.42, '--h': hue ?? h } as React.CSSProperties} aria-hidden>
      {initial(name)}
    </span>
  );
}

// ------------------------------------------------------------------ rail button

export function FriendsRailButton({ open, version }: { open: () => void; version?: unknown }) {
  const s = useSocial(version);
  const badge = (s?.pendingIn ?? 0) + (s?.unread ?? 0) + (s?.extras?.inboxNew ?? 0);
  return (
    <button className="rail-btn" onClick={open}>
      <Icon name="people" /> Friends{badge > 0 && <span className="fr-badge" aria-label={`${badge} new`}>{badge}</span>}
    </button>
  );
}

// ------------------------------------------------------------------ sheet

type Tab = 'people' | 'inbox' | 'shared' | 'circles';
// Set by the "From your friends" card so the sheet opens on that tab.
let pendingTab: Tab | null = null;

export function FriendsSheet({ close, toast, openWorkshop }: { close: () => void; toast: Toast; openWorkshop?: () => void }) {
  const dlg = useDialog<HTMLDivElement>();
  const s = useSocial();
  const [tab, setTab] = useState<Tab>(() => {
    const t = pendingTab ?? (cache?.extras?.inboxNew && !cache.pendingIn ? 'inbox' : 'people');
    pendingTab = null;
    return t;
  });
  const [err, setErr] = useState<string | null>(null);

  // Poll while the sheet is open, so requests and replies show up without a reload.
  useEffect(() => {
    const t = setInterval(() => void refreshSocial().catch(() => undefined), 4000);
    return () => clearInterval(t);
  }, []);

  const run = async <T,>(p: Promise<T>, ok?: string): Promise<T | undefined> => {
    setErr(null);
    try {
      const out = await p;
      if (out && typeof out === 'object' && 'enabled' in (out as object)) publish(out as unknown as SocialState);
      if (ok) toast(ok);
      return out;
    } catch (e) {
      setErr((e as Error).message);
      return undefined;
    }
  };

  return (
    <div className="sheet-backdrop" onClick={close}>
      <div ref={dlg} className="sheet friends-sheet" role="dialog" aria-modal="true" aria-label="Friends" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>Friends</h2>
          {s?.enabled && (
            <button className="icon-btn" onClick={() => void run(call('POST', '/api/social/sync', {}))} aria-label="Check for new messages" title="Check now">
              <Icon name="sync" />
            </button>
          )}
          <button className="icon-btn" onClick={close} aria-label="Close"><Icon name="x" /></button>
        </div>
        <div className="sheet-body">
          {err && <p className="form-error" role="alert">{err}</p>}
          {!s ? (
            <p className="f-hint lead">Loading…</p>
          ) : !s.enabled ? (
            <Setup s={s} run={run} />
          ) : (
            <>
              <MeCard s={s} />
              <div className="seg fr-tabs" role="tablist">
                {(['people', 'inbox', 'shared', 'circles'] as const).map((t) => (
                  <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
                    {t === 'people'
                      ? `People${s.pendingIn ? ` · ${s.pendingIn}` : ''}`
                      : t === 'inbox'
                        ? `From friends${s.extras?.inboxNew ? ` · ${s.extras.inboxNew}` : ''}`
                        : t === 'shared'
                          ? `Shared${s.unread ? ` · ${s.unread}` : ''}`
                          : 'Circles'}
                  </button>
                ))}
              </div>
              {tab === 'people' && <People s={s} run={run} />}
              {tab === 'inbox' && <Inbox s={s} toast={toast} openWorkshop={openWorkshop} />}
              {tab === 'shared' && <Shared s={s} toast={toast} />}
              {tab === 'circles' && <Circles s={s} run={run} />}
              <Status s={s} run={run} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

type Run = <T>(p: Promise<T>, ok?: string) => Promise<T | undefined>;

function Setup({ s, run }: { s: SocialState; run: Run }) {
  const [handle, setHandle] = useState('');
  const [relay, setRelay] = useState(s.localRelay ?? '');
  return (
    <form className="fr-setup" onSubmit={(e) => { e.preventDefault(); void run(call('POST', '/api/social/setup', { handle: handle.trim(), relay: relay.trim() }), 'Friends is on'); }}>
      <div className="fr-hero">
        <div className="fr-hero-orbs" aria-hidden><Avatar name="A" size={44} hue={262} /><Avatar name="M" size={44} hue={330} /><Avatar name="J" size={44} hue={190} /></div>
        <h3>Share with the people you actually know</h3>
        <p>Send a post with a note to a friend or a circle. React, reply, keep it between you.</p>
      </div>
      <ul className="fr-promises">
        <li><Icon name="check" size={15} /> Private by default. Nothing leaves Aurora unless you share it.</li>
        <li><Icon name="check" size={15} /> Friends only, both sides agree. No public profile, no follower counts.</li>
        <li><Icon name="check" size={15} /> End-to-end encrypted. The relay only ever sees sealed envelopes.</li>
        <li><Icon name="check" size={15} /> Nothing is ever posted to X, Bluesky or any other site.</li>
      </ul>
      <label className="ai-field">
        <span>Your handle</span>
        <input className="f-input" value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="maya" maxLength={32} autoCapitalize="off" spellCheck={false} required pattern="[A-Za-z0-9][A-Za-z0-9_.\-]{0,31}" />
        <small>What friends see. Only people you invite ever see it.</small>
      </label>
      <label className="ai-field">
        <span>Relay</span>
        <input className="f-input" value={relay} onChange={(e) => setRelay(e.target.value)} placeholder="https://relay.example.org" type="url" autoCapitalize="off" spellCheck={false} required />
        <small>{s.localRelay ? 'This Aurora runs its own relay. Friends need to reach this address.' : 'A relay holds sealed messages until your friends fetch them. Run one with SR_RELAY=1, or use a friend’s.'}</small>
      </label>
      <button className="btn primary" type="submit" disabled={!handle.trim() || !relay.trim()}>Turn on Friends</button>
    </form>
  );
}

function MeCard({ s }: { s: SocialState }) {
  return (
    <div className="fr-me">
      <Avatar name={s.me!.handle} size={44} />
      <div>
        <p className="fr-me-name">@{s.me!.handle}</p>
        <p className="fr-code" title="Your safety code. Friends can compare it with what their Aurora shows.">Safety code <span>{s.me!.fpShort}</span></p>
      </div>
    </div>
  );
}

function People({ s, run }: { s: SocialState; run: Run }) {
  const [made, setInvite] = useState<{ id: string; link: string; expiresAt: string; fpShort: string } | null>(null);
  // An invite works once: hide it as soon as someone has used it.
  const invite = made && s.invites.some((i) => i.id === made.id) ? made : null;
  const [paste, setPaste] = useState('');
  const [preview, setPreview] = useState<{ handle: string; fpShort: string; relay: string } | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [weekly, setWeekly] = useState<string | null>(null);
  const reqs = s.friends.filter((f) => f.status === 'pending_in');
  const waiting = s.friends.filter((f) => f.status === 'pending_out');
  const friends = s.friends.filter((f) => f.status === 'friend');
  const blocked = s.friends.filter((f) => f.status === 'blocked');

  const look = async (v: string) => {
    setPaste(v);
    setPreview(null);
    if (v.includes('aurora:invite/v1/')) {
      const p = await run(call<{ handle: string; fpShort: string; relay: string }>('POST', '/api/social/invites/preview', { link: v }));
      if (p) setPreview(p);
    }
  };

  return (
    <>
      {reqs.length > 0 && (
        <section className="f-sec">
          <h3>Requests</h3>
          {reqs.map((f) => (
            <div key={f.fp} className="fr-row req">
              <Avatar name={f.name} />
              <div className="fr-row-main">
                <p className="fr-name">@{f.handle} <span className="fr-sub">opened your invite</span></p>
                <p className="fr-code">Safety code <span>{f.fpShort}</span></p>
              </div>
              <button className="btn small primary" onClick={() => void run(call('POST', `/api/social/friends/${f.fp}/accept`, {}), `You and @${f.handle} are friends`)}>Accept</button>
              <button className="btn small ghost" onClick={() => void run(call('POST', `/api/social/friends/${f.fp}/decline`, {}))}>Decline</button>
            </div>
          ))}
        </section>
      )}

      <section className="f-sec">
        <h3>Add a friend</h3>
        {invite ? (
          <div className="fr-invite">
            <Qr text={invite.link} />
            <div className="fr-invite-side">
              <p className="f-hint">Show this code, or send the link privately. It works once and expires {new Date(invite.expiresAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}.</p>
              <div className="fr-link">
                <input className="f-input" readOnly value={invite.link} aria-label="Invite link" onFocus={(e) => e.currentTarget.select()} />
                <button className="btn small" onClick={() => void navigator.clipboard?.writeText(invite.link).then(() => run(Promise.resolve(null), 'Invite link copied'))}>Copy</button>
              </div>
              <p className="f-hint">When you talk, check they see your safety code: <b>{invite.fpShort}</b></p>
              <button className="btn small ghost" onClick={() => setInvite(null)}>Done</button>
            </div>
          </div>
        ) : (
          <button className="btn" onClick={async () => { const i = await run(call<{ id: string; link: string; expiresAt: string; fpShort: string }>('POST', '/api/social/invites', {})); if (i) setInvite(i); void refreshSocial(); }}>
            <Icon name="plus" size={16} /> Make an invite
          </button>
        )}
        {s.invites.filter((i) => i.id !== invite?.id).length > 0 && (
          <p className="f-hint">
            {s.invites.length - (invite ? 1 : 0)} unused invite{s.invites.length - (invite ? 1 : 0) === 1 ? '' : 's'} still open.{' '}
            <button className="chip ghost" onClick={() => void Promise.all(s.invites.filter((i) => i.id !== invite?.id).map((i) => call('DELETE', `/api/social/invites/${i.id}`))).then(() => run(refreshSocial(), 'Unused invites revoked'))}>
              Revoke
            </button>
          </p>
        )}
        <label className="ai-field">
          <span>Got an invite?</span>
          <textarea className="f-input fr-paste" value={paste} onChange={(e) => void look(e.target.value)} placeholder="Paste an aurora:invite link" rows={2} spellCheck={false} />
        </label>
        {preview && (
          <div className="fr-row preview">
            <Avatar name={preview.handle} />
            <div className="fr-row-main">
              <p className="fr-name">@{preview.handle}</p>
              <p className="fr-code">Safety code <span>{preview.fpShort}</span> · relay {hostOf(preview.relay)}</p>
            </div>
            <button
              className="btn small primary"
              onClick={async () => {
                const ok = await run(call('POST', '/api/social/invites/accept', { link: paste }), `Request sent to @${preview.handle}`);
                if (ok) {
                  setPaste('');
                  setPreview(null);
                }
              }}
            >
              Send request
            </button>
          </div>
        )}
      </section>

      <section className="f-sec">
        <h3>Friends{friends.length ? ` · ${friends.length}` : ''}</h3>
        {!friends.length && !waiting.length && <p className="f-hint">No friends yet. Make an invite and send it to someone you know.</p>}
        {waiting.map((f) => (
          <div key={f.fp} className="fr-row waiting">
            <Avatar name={f.name} />
            <div className="fr-row-main">
              <p className="fr-name">@{f.handle} <span className="fr-sub">waiting for them to accept</span></p>
              <p className="fr-code">Safety code <span>{f.fpShort}</span></p>
            </div>
            <button className="btn small ghost" onClick={() => void run(call('POST', `/api/social/friends/${f.fp}/decline`, {}))}>Cancel</button>
          </div>
        ))}
        {friends.map((f) => (
          <div key={f.fp} className={`fr-row-wrap ${weekly === f.fp ? 'open' : ''}`}>
          <div className="fr-row">
            <Avatar name={f.name} />
            <div className="fr-row-main">
              <p className="fr-name">{f.name}{f.nickname && <span className="fr-sub"> @{f.handle}</span>}</p>
              <p className="fr-code">Safety code <span>{f.fpShort}</span>{f.circles.length > 0 && ` · ${f.circles.map((id) => s.circles.find((c) => c.id === id)?.name).filter(Boolean).join(', ')}`}</p>
            </div>
            <button
              className={`chip ${s.extras?.digestsOn.includes(f.fp) ? 'on' : 'ghost'}`}
              aria-expanded={weekly === f.fp}
              onClick={() => setWeekly(weekly === f.fp ? null : f.fp)}
              title="A short weekly list of posts you saved, for this friend only. Off until you turn it on."
            >
              <Icon name="bookmark" size={13} /> {s.extras?.digestsOn.includes(f.fp) ? 'Weekly list on' : 'Weekly list'}
            </button>
            {confirm === f.fp ? (
              <div className="fr-confirm">
                <button className="btn small" onClick={() => void run(call('POST', `/api/social/friends/${f.fp}/remove`, {}), `Removed ${f.name}`).then(() => setConfirm(null))} title="They get a quiet notice. Their past shares stay.">Remove</button>
                <button className="btn small danger" onClick={() => void run(call('POST', `/api/social/friends/${f.fp}/block`, {}), `Blocked ${f.name}`).then(() => setConfirm(null))} title="Silent. Deletes their shares and replies here and ignores anything more from them.">Block</button>
                <button className="btn small ghost" onClick={() => setConfirm(null)} aria-label="Keep">Keep</button>
              </div>
            ) : (
              <button className="icon-btn" onClick={() => setConfirm(f.fp)} aria-label={`Remove or block ${f.name}`} title="Remove or block"><Icon name="more" /></button>
            )}
          </div>
          {weekly === f.fp && <WeeklyList f={f} />}
          </div>
        ))}
      </section>

      {blocked.length > 0 && (
        <section className="f-sec">
          <h3>Blocked</h3>
          <p className="f-hint">Nothing from these people reaches you. They are not told.</p>
          {blocked.map((f) => (
            <div key={f.fp} className="fr-row blocked">
              <Avatar name={f.name} size={28} />
              <div className="fr-row-main"><p className="fr-name">@{f.handle}</p></div>
              <button className="btn small ghost" onClick={() => void run(call('POST', `/api/social/friends/${f.fp}/unblock`, {}))}>Unblock</button>
            </div>
          ))}
        </section>
      )}
    </>
  );
}

function Shared({ s, toast }: { s: SocialState; toast: Toast }) {
  const [rows, setRows] = useState<ShareRow[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    void call<ShareRow[]>('GET', '/api/social/shares').then(setRows).catch(() => setRows([]));
  }, [s]);
  if (!rows) return <p className="f-hint lead">Loading…</p>;
  return (
    <>
    <ShareCollection s={s} toast={toast} />
    <SuggestConnector s={s} toast={toast} />
    {!rows.length && <p className="f-hint lead">No posts shared yet. Use Share on any post to send it to a friend with a note.</p>}
    {rows.length > 0 && (
    <section className="f-sec fr-shares">
      <h3>Posts</h3>
      {rows.map((r) => (
        <div key={r.localId} className={`fr-share ${open === r.localId ? 'open' : ''}`}>
          <button className="fr-share-head" onClick={() => setOpen(open === r.localId ? null : r.localId)} aria-expanded={open === r.localId}>
            <Avatar name={r.direction === 'in' ? r.peers[0] : s.me!.handle} size={30} />
            <span className="fr-share-text">
              <span className="fr-share-who">{r.direction === 'in' ? `${r.peers[0]} shared` : `You shared with ${r.peers.join(', ')}`} · {ago(r.at)}</span>
              {r.note && <span className="fr-share-note">“{r.note}”</span>}
              <span className="fr-share-title">{r.title}</span>
            </span>
            <span className="fr-share-meta">
              {r.reactions.join('')}
              {r.replies > 0 && <span>{r.replies} {r.replies === 1 ? 'reply' : 'replies'}</span>}
              {r.unread > 0 && <span className="fr-dot" aria-label={`${r.unread} new`} />}
            </span>
          </button>
          {open === r.localId && <ThreadView localId={r.localId} reactions={s.reactions} toast={toast} />}
        </div>
      ))}
    </section>
    )}
    </>
  );
}

function Circles({ s, run }: { s: SocialState; run: Run }) {
  const [name, setName] = useState('');
  const friends = s.friends.filter((f) => f.status === 'friend');
  const profiles = useProfiles();
  return (
    <>
      <section className="f-sec">
        <p className="f-hint">Circles are your own groups, like Family or Book club. Share to a whole circle at once. Nobody sees which circles they are in.</p>
        {profiles.length > 0 && <p className="f-hint">Map a circle to a profile and that profile shows friends' shares from that circle's members only. Friends in no mapped circle stay out of it.</p>}
        <form className="pop-form" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void run(call('POST', '/api/social/circles', { name: name.trim(), members: [] })).then(() => setName('')); }}>
          <input className="f-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="New circle" maxLength={60} aria-label="New circle name" />
          <button className="btn small" type="submit" disabled={!name.trim()}>Add</button>
        </form>
      </section>
      {s.circles.map((c) => (
        <section key={c.id} className="f-sec fr-circle">
          <div className="f-row-head">
            <h3>{c.name} <span className="fr-sub">· {c.members.length}</span></h3>
            <button className="icon-btn" onClick={() => void run(call('DELETE', `/api/social/circles/${c.id}`))} aria-label={`Delete circle ${c.name}`}><Icon name="trash" size={16} /></button>
          </div>
          {!friends.length && <p className="f-hint">Add friends first.</p>}
          <div className="fr-members">
            {friends.map((f) => {
              const on = c.members.includes(f.fp);
              return (
                <button
                  key={f.fp}
                  className={`chip ${on ? 'on' : ''}`}
                  aria-pressed={on}
                  onClick={() => void run(call('PATCH', `/api/social/circles/${c.id}`, { name: c.name, members: on ? c.members.filter((x) => x !== f.fp) : [...c.members, f.fp] }))}
                >
                  {on && <Icon name="check" size={13} />} {f.name}
                </button>
              );
            })}
          </div>
          {profiles.length > 0 && (
            <label className="fr-circle-profile">
              <span>Shares from this circle show in</span>
              <select
                className="f-input"
                value={c.profile ?? ''}
                onChange={(e) => void run(call('PATCH', `/api/social/circles/${c.id}`, { name: c.name, profile: e.target.value }))}
                aria-label={`Profile for the circle ${c.name}`}
              >
                <option value="">Any profile with the Friends source</option>
                {profiles.map((p) => <option key={p.id} value={p.id}>{p.name} only</option>)}
              </select>
            </label>
          )}
        </section>
      ))}
    </>
  );
}

function Status({ s, run }: { s: SocialState; run: Run }) {
  const [edit, setEdit] = useState(false);
  const [relay, setRelay] = useState(s.me?.relay ?? '');
  return (
    <section className="f-sec fr-status">
      <p className="f-hint">
        <span className={`fr-live ${s.lastPollError ? 'bad' : ''}`} /> Relay {hostOf(s.me!.relay)} · checked {ago(s.lastPollAt)}
        {s.outbox.pending > 0 && ` · ${s.outbox.pending} waiting to send`}
        {s.lastPollError && ` · ${s.lastPollError}`}
        {s.outbox.lastError && ` · last send: ${s.outbox.lastError}`}
        {' '}<button className="chip ghost" onClick={() => setEdit(!edit)}>Change</button>
      </p>
      {edit && (
        <form className="pop-form" onSubmit={(e) => { e.preventDefault(); void run(call('PATCH', '/api/social/me', { relay: relay.trim() }), 'Relay changed. Friends are told.').then(() => setEdit(false)); }}>
          <input className="f-input" value={relay} onChange={(e) => setRelay(e.target.value)} type="url" aria-label="Relay address" />
          <button className="btn small" type="submit">Save</button>
        </form>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ thread

function ThreadView({ localId, reactions, toast, compact }: { localId: string; reactions: string[]; toast: Toast; compact?: boolean }) {
  const [t, setT] = useState<Thread | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const social = useSocial();
  useEffect(() => {
    void call<Thread>('GET', `/api/social/thread/${encodeURIComponent(localId)}`)
      .then((x) => {
        setT(x);
        if (x.marked > 0) void refreshSocial().catch(() => undefined);
      })
      .catch(() => setT(null));
  }, [localId, social]);
  if (!t) return null;
  const send = async (peer: string) => {
    const text = (drafts[peer] ?? '').trim();
    if (!text) return;
    setBusy(true);
    try {
      setT(await call<Thread>('POST', '/api/social/reply', { shareId: t.localId, peer, text }));
      setDrafts((d) => ({ ...d, [peer]: '' }));
    } catch (e) {
      toast((e as Error).message, { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  const react = async (peer: string, emoji: string) => {
    try {
      setT(await call<Thread>('POST', '/api/social/react', { shareId: t.localId, peer, emoji }));
    } catch (e) {
      toast((e as Error).message, { tone: 'error' });
    }
  };
  return (
    <div className={`fr-thread ${compact ? 'compact' : ''}`}>
      {t.conversations.map((c) => {
        const live = c.peer.status === 'friend';
        return (
          <div key={c.peer.fp} className="fr-convo">
            {t.direction === 'out' && (
              <p className="fr-convo-head">
                <Avatar name={c.peer.name} size={20} /> {c.peer.name}
                {c.reaction && <span className="fr-their-react" title={`${c.peer.name} reacted`}>{c.reaction}</span>}
              </p>
            )}
            {t.direction === 'in' && live && (
              <div className="fr-reacts" role="group" aria-label="React">
                {reactions.map((e) => (
                  <button key={e} className={`fr-react ${c.myReaction === e ? 'on' : ''}`} aria-pressed={c.myReaction === e} onClick={() => void react(c.peer.fp, c.myReaction === e ? '' : e)}>
                    {e}
                  </button>
                ))}
                <span className="fr-private">Only {c.peer.name} sees your reaction and replies</span>
              </div>
            )}
            {c.messages.length > 0 && (
              <ol className="fr-msgs">
                {c.messages.map((m) => (
                  <li key={m.id} className={m.fromMe ? 'me' : 'them'}>
                    <span className="fr-bubble">{m.text}</span>
                    <span className="fr-when">{m.fromMe ? 'You' : c.peer.name} · {ago(m.at)}</span>
                  </li>
                ))}
              </ol>
            )}
            {live ? (
              <form className="fr-reply" onSubmit={(e) => { e.preventDefault(); void send(c.peer.fp); }}>
                <input
                  className="f-input"
                  value={drafts[c.peer.fp] ?? ''}
                  onChange={(e) => setDrafts((d) => ({ ...d, [c.peer.fp]: e.target.value }))}
                  placeholder={`Reply to ${c.peer.name}`}
                  maxLength={2000}
                  aria-label={`Reply to ${c.peer.name}`}
                />
                <button className="btn small primary" type="submit" disabled={busy || !(drafts[c.peer.fp] ?? '').trim()}>Send</button>
              </form>
            ) : (
              <p className="f-hint">You are no longer friends with {c.peer.name}.</p>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Reactions and replies under a post a friend shared with you. */
export function FriendThread({ item, version, toast }: { item: Item; version?: unknown; toast: Toast }) {
  const s = useSocial(version);
  if (!isFriendsItem(item) || !s?.enabled) return null;
  return <ThreadView localId={item.externalId} reactions={s.reactions} toast={toast} compact />;
}

// ------------------------------------------------------------------ share from a post

export function ShareToFriends({ item, toast }: { item: Item; toast: Toast }) {
  const s = useSocial();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [circles, setCircles] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  if (!s?.enabled || isFriendsItem(item)) return null;
  const friends = s.friends.filter((f) => f.status === 'friend');
  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const send = async () => {
    setBusy(true);
    try {
      const r = await call<{ sentTo: string[] }>('POST', '/api/social/share', { itemId: item.id, note: note.trim(), friends: picked, circles });
      toast(`Shared with ${r.sentTo.join(', ')}`);
      setOpen(false);
      setPicked([]);
      setCircles([]);
      setNote('');
    } catch (e) {
      toast((e as Error).message, { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="col-wrap">
      <button className="pa" onClick={() => setOpen(!open)} aria-expanded={open} title="Share with friends">
        <Icon name="people" size={17} /> <span>Share</span>
      </button>
      {open && (
        <div className="popover fr-pop" role="dialog" aria-label="Share with friends">
          {!friends.length ? (
            <p className="f-hint">Add a friend first, from Friends in the sidebar.</p>
          ) : (
            <>
              {s.circles.length > 0 && (
                <div className="fr-members">
                  {s.circles.map((c) => (
                    <button key={c.id} className={`chip ${circles.includes(c.id) ? 'on' : ''}`} aria-pressed={circles.includes(c.id)} onClick={() => setCircles(toggle(circles, c.id))}>
                      {c.name} · {c.members.length}
                    </button>
                  ))}
                </div>
              )}
              {friends.map((f) => (
                <label key={f.fp} className="check">
                  <input type="checkbox" checked={picked.includes(f.fp)} onChange={() => setPicked(toggle(picked, f.fp))} />
                  <Avatar name={f.name} size={22} /> {f.name}
                </label>
              ))}
              <textarea className="f-input fr-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note (why you thought of them)" rows={3} maxLength={2000} />
              <button className="btn small primary" disabled={busy || (!picked.length && !circles.length)} onClick={() => void send()}>
                {busy ? 'Sending…' : 'Send'}
              </button>
              <p className="fr-private">End-to-end encrypted. Only the people you pick can read it.</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ weekly lists, collections, connectors

interface Entry {
  id: string;
  title: string;
  text: string;
  url: string | null;
  author: { name: string; handle: string };
  platform: string;
  kind: string;
  at: string;
}
interface InboxState {
  digests: { peer: string; name: string; week: number; at: string; seen: boolean; thisWeek: boolean; entries: Entry[] }[];
  collections: { peer: string; name: string; collId: string; title: string; version: number; at: string; seen: boolean; truncated: boolean; entries: Entry[] }[];
  recs: {
    id: string;
    peer: string;
    name: string;
    note: string;
    at: string;
    status: 'new' | 'imported';
    actorId: string | null;
    connector: { id: string; name: string; description: string; platform: string; runtime: string; tier: string; hosts: string[]; lines: number };
  }[];
  muted: string[];
}
interface DigestPreview {
  fp: string;
  name: string;
  enabled: boolean;
  auto: boolean;
  scope: string;
  confirmed: boolean;
  lastSentAt: string | null;
  sentThisWeek: boolean;
  since: string;
  entries: { itemId: string; title: string; author: string; platform: string; url: string | null; savedAt: string }[];
}

let profilesCache: Profile[] | null = null;
function useProfiles(): Profile[] {
  const [list, setList] = useState<Profile[]>(profilesCache ?? []);
  useEffect(() => {
    void call<{ profiles: Profile[] }>('GET', '/api/profiles')
      .then((r) => setList((profilesCache = r.profiles ?? [])))
      .catch(() => undefined);
  }, []);
  return list;
}

const dayOf = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const safeLink = (u: string | null) => (u && /^https?:\/\//i.test(u) ? u : null);

/** Pick friends and circles. Circles expand to their members on the server. */
function Recipients({ s, friends, circles, setFriends, setCircles }: { s: SocialState; friends: string[]; circles: string[]; setFriends: (v: string[]) => void; setCircles: (v: string[]) => void }) {
  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const people = s.friends.filter((f) => f.status === 'friend');
  if (!people.length) return <p className="f-hint">Add a friend first.</p>;
  return (
    <div className="fr-members">
      {s.circles.filter((c) => c.members.length).map((c) => (
        <button key={c.id} type="button" className={`chip ${circles.includes(c.id) ? 'on' : ''}`} aria-pressed={circles.includes(c.id)} onClick={() => setCircles(toggle(circles, c.id))}>
          {c.name} · {c.members.length}
        </button>
      ))}
      {people.map((f) => (
        <button key={f.fp} type="button" className={`chip ${friends.includes(f.fp) ? 'on' : ''}`} aria-pressed={friends.includes(f.fp)} onClick={() => setFriends(toggle(friends, f.fp))}>
          {friends.includes(f.fp) && <Icon name="check" size={13} />} {f.name}
        </button>
      ))}
    </div>
  );
}

/** The sender's side of the weekly list for one friend: consent, scope, an exact preview, then send. */
function WeeklyList({ f }: { f: Friend }) {
  const [d, setD] = useState<DigestPreview | null>(null);
  const [off, setOff] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const profiles = useProfiles();
  const load = () => call<DigestPreview>('GET', `/api/social/digest/${f.fp}`).then(setD).catch((e) => setErr((e as Error).message));
  useEffect(() => void load(), [f.fp]);
  const act = async (p: Promise<DigestPreview>, done?: string) => {
    setErr(null);
    setNote(null);
    setBusy(true);
    try {
      setD(await p);
      if (done) setNote(done);
      void refreshSocial().catch(() => undefined);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!d) return <div className="fr-weekly">{err ? <p className="form-error">{err}</p> : <p className="f-hint">Loading…</p>}</div>;
  const picked = d.entries.filter((e) => !off.has(e.itemId));
  const toggle = (id: string) =>
    setOff((o) => {
      const n = new Set(o);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  return (
    <div className="fr-weekly" role="region" aria-label={`Weekly list for ${f.name}`}>
      {err && <p className="form-error" role="alert">{err}</p>}
      {note && <p className="fr-weekly-done" role="status"><Icon name="check" size={14} /> {note}</p>}
      {!d.enabled ? (
        <>
          <p className="fr-weekly-lead">Send {f.name} a short list of posts you saved each week.</p>
          <ul className="fr-promises small">
            <li><Icon name="check" size={14} /> Off until you turn it on, for {f.name} only.</li>
            <li><Icon name="check" size={14} /> Turning it on sends nothing. You see the exact list and send the first one yourself.</li>
            <li><Icon name="check" size={14} /> Leave out any post. Only the title, a short excerpt, the link and the author travel.</li>
            <li><Icon name="check" size={14} /> Turn it off any time and their Aurora deletes the lists you sent. Sharing is still trust: a modified Aurora could keep a copy.</li>
          </ul>
          <button className="btn small primary" disabled={busy} onClick={() => void act(call('PATCH', `/api/social/digest/${f.fp}`, { enabled: true }))}>Turn on for {f.name}</button>
        </>
      ) : (
        <>
          <div className="fr-weekly-head">
            <label className="fr-weekly-scope">
              <span>From</span>
              <select className="f-input" value={d.scope} disabled={busy} onChange={(e) => void act(call('PATCH', `/api/social/digest/${f.fp}`, { scope: e.target.value }))}>
                <option value="all">all my saved posts</option>
                {profiles.map((p) => <option key={p.id} value={p.id}>posts saved in {p.name}</option>)}
              </select>
            </label>
            <button className="btn small ghost" disabled={busy} onClick={() => void act(call('PATCH', `/api/social/digest/${f.fp}`, { enabled: false }), `Turned off. ${f.name}'s Aurora deletes the lists you sent.`)}>Turn off</button>
          </div>
          {d.sentThisWeek ? (
            <p className="f-hint">This week's list went out {ago(d.lastSentAt)}. The next one covers posts you save from now on.</p>
          ) : (
            <>
              <p className="f-hint">
                {d.entries.length
                  ? `Exactly this goes to ${f.name}: ${picked.length} of ${d.entries.length} posts saved since ${dayOf(d.since)}. Untick a post to leave it out.`
                  : `Nothing saved since ${dayOf(d.since)}. Save posts this week and they show up here first.`}
              </p>
              {d.entries.length > 0 && (
                <ul className="fr-weekly-list">
                  {d.entries.map((e) => (
                    <li key={e.itemId} className={off.has(e.itemId) ? 'off' : ''}>
                      <label className="check">
                        <input type="checkbox" checked={!off.has(e.itemId)} onChange={() => toggle(e.itemId)} />
                        <span className="fr-weekly-item">
                          <span className="fr-weekly-title">{e.title || '(untitled)'}</span>
                          <span className="fr-sub">{e.author} · {e.platform}{e.url ? ` · ${hostOf(e.url)}` : ''}</span>
                        </span>
                      </label>
                      <button className="chip ghost" title="Never put this post in a weekly list, for anyone" onClick={() => void call('POST', '/api/social/digest-skip', { itemId: e.itemId, skip: true }).then(load)}>
                        Never share
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {d.entries.length > 0 && (
                <button
                  className="btn small primary"
                  disabled={busy || !picked.length}
                  onClick={() => void act(call('POST', `/api/social/digest/${f.fp}/send`, { itemIds: picked.map((e) => e.itemId) }), `Sent ${picked.length} post${picked.length === 1 ? '' : 's'} to ${f.name}.`)}
                >
                  Send this list to {f.name}
                </button>
              )}
            </>
          )}
          {d.confirmed ? (
            <label className="check fr-weekly-auto">
              <input type="checkbox" checked={d.auto} disabled={busy} onChange={(e) => void act(call('PATCH', `/api/social/digest/${f.fp}`, { auto: e.target.checked }))} />
              Send it weekly without asking. Same rules: saved posts{d.scope !== 'all' ? ' in that profile' : ''}, minus anything marked Never share.
            </label>
          ) : (
            <p className="f-hint">After you send the first list yourself, you can let it go out weekly on its own.</p>
          )}
        </>
      )}
    </div>
  );
}

function EntryRow({ e, keep }: { e: Entry; keep?: () => void }) {
  const link = safeLink(e.url);
  const label = e.title || e.text.slice(0, 120) || (link ? hostOf(link) : '');
  return (
    <li className="fr-entry">
      <div className="fr-entry-main">
        <p className="fr-entry-title">{link ? <a href={link} target="_blank" rel="noopener noreferrer">{label}</a> : label}</p>
        {e.title && e.text && <p className="fr-entry-text">{e.text}</p>}
        <p className="fr-sub">{[e.author.name, e.platform, link && hostOf(link)].filter(Boolean).join(' · ')}</p>
      </div>
      {keep && <button className="chip ghost" onClick={keep} title="Save a copy in your library">Keep</button>}
    </li>
  );
}

/** What friends sent: weekly lists, shared collections and connector suggestions. All plain text, no remote images. */
function Inbox({ s, toast, openWorkshop }: { s: SocialState; toast: Toast; openWorkshop?: () => void }) {
  const [box, setBox] = useState<InboxState | null>(null);
  const [openColl, setOpenColl] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = () => call<InboxState>('GET', '/api/social/inbox').then(setBox).catch(() => setBox({ digests: [], collections: [], recs: [], muted: [] }));
  useEffect(() => {
    void load().then(() => call('POST', '/api/social/inbox/seen', {})).then(() => refreshSocial()).catch(() => undefined);
  }, [s.extras?.inboxNew, s.friends.length]);
  if (!box) return <p className="f-hint lead">Loading…</p>;
  const keep = (body: object) => () =>
    void call('POST', '/api/social/inbox/keep', body).then(() => toast('Kept in your library, under Saved'), (e) => toast((e as Error).message, { tone: 'error' }));
  const mute = (fp: string) => () => void call<InboxState>('POST', `/api/social/digest-mute/${fp}`, {}).then(setBox);
  const recent = box.digests.filter((d) => d.thisWeek);
  const older = box.digests.filter((d) => !d.thisWeek);
  const nothing = !box.digests.length && !box.collections.length && !box.recs.length;
  const nameOf = (fp: string) => s.friends.find((f) => f.fp === fp)?.name ?? 'a removed friend';
  const importRec = async (id: string) => {
    setBusy(id);
    try {
      const out = await call<{ actorId: string }>('POST', `/api/social/recs/${id}/import`, {});
      toast(`Added ${out.actorId} to your Workshop. Test it there before using it.`);
      await load();
      void refreshSocial().catch(() => undefined);
    } catch (e) {
      toast((e as Error).message, { tone: 'error' });
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      {nothing && <p className="f-hint lead">Nothing from friends yet. When a friend sends you their weekly list of saved posts, shares a collection or suggests a connector, it shows up here.</p>}
      {box.recs.length > 0 && (
        <section className="f-sec">
          <h3>Connector suggestions</h3>
          {box.recs.map((r) => (
            <div key={r.id} className="fr-card fr-rec">
              <p className="fr-card-who"><Avatar name={r.name} size={24} /> <span><b>{r.name}</b> suggests a connector for {r.connector.platform === 'web' ? 'the web' : r.connector.platform} · {ago(r.at)}</span></p>
              {r.note && <p className="fr-share-note">“{r.note}”</p>}
              <p className="fr-rec-name">{r.connector.name} <span className="fr-sub">{r.connector.runtime} · {r.connector.lines} lines{r.connector.tier ? ` · ${r.connector.tier}` : ''}</span></p>
              {r.connector.description && <p className="fr-entry-text">{r.connector.description}</p>}
              <p className="fr-rec-hosts">Reaches: {r.connector.hosts.length ? r.connector.hosts.join(', ') : 'only sites you give it when you add a source'}</p>
              {r.status === 'imported' ? (
                <p className="f-hint">
                  In your Workshop as <code>{r.actorId}</code>, untested. {openWorkshop && <button className="chip ghost" onClick={openWorkshop}>Open Workshop</button>}
                </p>
              ) : (
                <>
                  <p className="fr-private">Adding it puts it in your Workshop as untested. Nothing runs until you test it there, in the sandbox, limited to the sites above.</p>
                  {r.connector.tier === 'session' && <p className="fr-private">This one reads pages through a signed-in browser profile. Code someone else wrote would act as you on those sites: read it in the Workshop before you test it.</p>}
                  <div className="fr-card-actions">
                    <button className="btn small primary" disabled={busy === r.id} onClick={() => void importRec(r.id)}>Add to Workshop</button>
                    <button className="btn small ghost" onClick={() => void call<InboxState>('POST', `/api/social/recs/${r.id}/dismiss`, {}).then((b) => { setBox(b); void refreshSocial().catch(() => undefined); })}>Dismiss</button>
                  </div>
                </>
              )}
            </div>
          ))}
        </section>
      )}
      {recent.length > 0 && (
        <section className="f-sec">
          <h3>This week from your friends</h3>
          {recent.map((d) => <DigestCard key={d.peer + d.week} d={d} keep={keep} mute={mute(d.peer)} />)}
        </section>
      )}
      {box.collections.length > 0 && (
        <section className="f-sec">
          <h3>Collections shared with you</h3>
          {box.collections.map((c) => {
            const key = c.peer + c.collId;
            const isOpen = openColl === key;
            return (
              <div key={key} className={`fr-card fr-coll ${isOpen ? 'open' : ''}`}>
                <button className="fr-coll-head" aria-expanded={isOpen} onClick={() => setOpenColl(isOpen ? null : key)}>
                  <Icon name="folder" size={18} />
                  <span className="fr-share-text">
                    <span className="fr-coll-title">{c.title}</span>
                    <span className="fr-share-who">from {c.name} · {c.entries.length} post{c.entries.length === 1 ? '' : 's'} · updated {ago(c.at)}</span>
                  </span>
                  {!c.seen && <span className="fr-dot" aria-label="Updated" />}
                </button>
                {isOpen && (
                  <>
                    <ul className="fr-entries">{c.entries.map((e) => <EntryRow key={e.id} e={e} keep={keep({ peer: c.peer, kind: 'coll', collId: c.collId, entryId: e.id })} />)}</ul>
                    {c.truncated && <p className="f-hint">Showing the newest {c.entries.length}. The full collection is larger.</p>}
                    <p className="fr-private">A read-only copy. It updates when {c.name} changes it and disappears if they stop sharing.</p>
                  </>
                )}
              </div>
            );
          })}
        </section>
      )}
      {older.length > 0 && (
        <section className="f-sec">
          <h3>Earlier weekly lists</h3>
          {older.map((d) => <DigestCard key={d.peer + d.week} d={d} keep={keep} mute={mute(d.peer)} />)}
        </section>
      )}
      {box.muted.length > 0 && (
        <p className="f-hint">
          Hiding weekly lists from {box.muted.map(nameOf).join(', ')}.{' '}
          {box.muted.map((fp) => (
            <button key={fp} className="chip ghost" onClick={() => void call<InboxState>('POST', `/api/social/digest-mute/${fp}`, { muted: false }).then(setBox)}>
              Show {nameOf(fp)}
            </button>
          ))}
        </p>
      )}
    </>
  );
}

function DigestCard({ d, keep, mute }: { d: InboxState['digests'][number]; keep: (body: object) => () => void; mute: () => void }) {
  const [more, setMore] = useState(false);
  const [askMute, setAskMute] = useState(false);
  const shown = more ? d.entries : d.entries.slice(0, 5);
  return (
    <div className="fr-card fr-digest">
      <div className="fr-card-who">
        <Avatar name={d.name} size={24} />
        <span><b>{d.name}</b> saved {d.entries.length} post{d.entries.length === 1 ? '' : 's'} · {dayOf(d.at)}</span>
        {askMute ? (
          <span className="fr-confirm">
            <button className="btn small" onClick={mute} title="Deletes their lists here and hides new ones. They are not told.">Hide their lists</button>
            <button className="btn small ghost" onClick={() => setAskMute(false)}>Keep</button>
          </span>
        ) : (
          <button className="icon-btn" onClick={() => setAskMute(true)} aria-label={`Hide weekly lists from ${d.name}`} title="Hide lists from this friend"><Icon name="more" size={16} /></button>
        )}
      </div>
      <ul className="fr-entries">{shown.map((e) => <EntryRow key={e.id} e={e} keep={keep({ peer: d.peer, kind: 'digest', week: d.week, entryId: e.id })} />)}</ul>
      {d.entries.length > 5 && <button className="chip ghost" onClick={() => setMore(!more)}>{more ? 'Show fewer' : `Show all ${d.entries.length}`}</button>}
    </div>
  );
}

interface OutColl {
  id: string;
  name: string;
  version: number;
  updatedAt: string;
  recipients: { fp: string; name: string }[];
}
type CollState = { outgoing: OutColl[]; local: string[] };

/** Share a collection as a read-only copy that follows its changes. */
function ShareCollection({ s, toast }: { s: SocialState; toast: Toast }) {
  const [data, setData] = useState<CollState | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [friends, setFriends] = useState<string[]>([]);
  const [circles, setCircles] = useState<string[]>([]);
  const [confirm, setConfirm] = useState<string | null>(null);
  useEffect(() => {
    void call<CollState>('GET', '/api/social/collections').then(setData).catch(() => undefined);
  }, []);
  if (!data) return null;
  const fail = (e: unknown) => toast((e as Error).message, { tone: 'error' });
  const unshare = (c: OutColl, fp?: string) =>
    void call<CollState>('POST', `/api/social/collections/${c.id}/unshare`, fp ? { fp } : {}).then((d) => {
      setData(d);
      setConfirm(null);
      toast(fp ? `Stopped sharing “${c.name}” with ${c.recipients.find((r) => r.fp === fp)?.name}` : `Stopped sharing “${c.name}”. Their copies are deleted.`);
    }, fail);
  return (
    <section className="f-sec">
      <div className="f-row-head">
        <h3>Collections</h3>
        {!open && data.local.length > 0 && <button className="btn small" onClick={() => setOpen(true)}><Icon name="folder" size={15} /> Share a collection</button>}
      </div>
      {!data.local.length && !data.outgoing.length && <p className="f-hint">Put posts in a collection (Collect on any post), then share it here as a read-only copy.</p>}
      {open && (
        <form
          className="fr-card fr-form"
          onSubmit={(e) => {
            e.preventDefault();
            void call<CollState & { sentTo: string[] }>('POST', '/api/social/collections', { name, friends, circles }).then((r) => {
              setData(r);
              setOpen(false);
              setFriends([]);
              setCircles([]);
              toast(r.sentTo.length ? `Shared “${name}” with ${r.sentTo.join(', ')}` : `“${name}” was already shared with them`);
            }, fail);
          }}
        >
          <select className="f-input" value={name} onChange={(e) => setName(e.target.value)} aria-label="Collection" required>
            <option value="" disabled>Pick a collection</option>
            {data.local.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <Recipients s={s} friends={friends} circles={circles} setFriends={setFriends} setCircles={setCircles} />
          <p className="fr-private">They get a read-only copy: titles, short excerpts, links and authors, up to 100 posts. It updates when the collection changes. Unsharing deletes it from their Aurora. Posts friends shared with you never go along.</p>
          <div className="fr-card-actions">
            <button className="btn small primary" type="submit" disabled={!name || (!friends.length && !circles.length)}>Share read-only copy</button>
            <button className="btn small ghost" type="button" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </form>
      )}
      {data.outgoing.map((c) => (
        <div key={c.id} className="fr-row">
          <Icon name="folder" size={18} />
          <div className="fr-row-main">
            <p className="fr-name">{c.name} <span className="fr-sub">· version {c.version} · {ago(c.updatedAt)}</span></p>
            <div className="fr-members">
              {c.recipients.map((r) => (
                <button key={r.fp} className="chip" title={`Stop sharing with ${r.name}`} aria-label={`Stop sharing ${c.name} with ${r.name}`} onClick={() => unshare(c, r.fp)}>
                  {r.name} <Icon name="x" size={12} />
                </button>
              ))}
            </div>
          </div>
          {confirm === c.id ? (
            <span className="fr-confirm">
              <button className="btn small danger" onClick={() => unshare(c)}>Unshare</button>
              <button className="btn small ghost" onClick={() => setConfirm(null)}>Keep</button>
            </span>
          ) : (
            <button className="btn small ghost" onClick={() => setConfirm(c.id)}>Unshare</button>
          )}
        </div>
      ))}
    </section>
  );
}

type ActorRow = { id: string; name: string; platform: string; hosts: string[] };

/** Pass a connector to a friend. They decide whether to add it, and it is tested there before it runs. */
function SuggestConnector({ s, toast }: { s: SocialState; toast: Toast }) {
  const [actors, setActors] = useState<ActorRow[] | null>(null);
  const [open, setOpen] = useState(false);
  const [id, setId] = useState('');
  const [note, setNote] = useState('');
  const [friends, setFriends] = useState<string[]>([]);
  const [circles, setCircles] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void call<{ available: boolean; actors: ActorRow[] }>('GET', '/api/actors')
      .then((r) => setActors(r.available ? r.actors : []))
      .catch(() => setActors([]));
  }, []);
  if (!actors?.length) return null;
  const picked = actors.find((a) => a.id === id);
  const send = async () => {
    setBusy(true);
    try {
      const r = await call<{ sentTo: string[] }>('POST', '/api/social/recommend', { actorId: id, note: note.trim(), friends, circles });
      toast(`Suggested ${picked?.name ?? id} to ${r.sentTo.join(', ')}`);
      setOpen(false);
      setNote('');
      setFriends([]);
      setCircles([]);
    } catch (err) {
      toast((err as Error).message, { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="f-sec">
      <div className="f-row-head">
        <h3>Connectors</h3>
        {!open && <button className="btn small" onClick={() => setOpen(true)}><Icon name="wrench" size={15} /> Suggest a connector</button>}
      </div>
      {open && (
        <form className="fr-card fr-form" onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <select className="f-input" value={id} onChange={(e) => setId(e.target.value)} aria-label="Connector" required>
            <option value="" disabled>Pick a connector</option>
            {actors.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.platform})</option>)}
          </select>
          {picked && <p className="fr-rec-hosts">Reaches: {picked.hosts.length ? picked.hosts.join(', ') : 'only sites given when adding a source'}</p>}
          <Recipients s={s} friends={friends} circles={circles} setFriends={setFriends} setCircles={setCircles} />
          <textarea className="f-input fr-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why they might want it (optional)" rows={2} maxLength={1000} />
          <p className="fr-private">Sends the connector's code and description, end-to-end encrypted. Never your logins, cookies or sources. Their Aurora adds it only if they choose to, and it cannot run there until it passes a test.</p>
          <div className="fr-card-actions">
            <button className="btn small primary" type="submit" disabled={busy || !id || (!friends.length && !circles.length)}>{busy ? 'Sending…' : 'Send suggestion'}</button>
            <button className="btn small ghost" type="button" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </form>
      )}
    </section>
  );
}

/** A calm card in the side pane when friends sent something new. */
export function FriendsWeekCard({ open, version }: { open: () => void; version?: unknown }) {
  const s = useSocial(version);
  const n = s?.extras?.inboxNew ?? 0;
  if (!s?.enabled || !n) return null;
  return (
    <section className="rules-card fr-week-card">
      <h3 className="eyebrow">From your friends</h3>
      <p>{n} new: weekly lists, shared collections or suggestions from people you know.</p>
      <button
        className="btn small"
        onClick={() => {
          pendingTab = 'inbox';
          open();
        }}
      >
        <Icon name="people" size={15} /> Open
      </button>
    </section>
  );
}
