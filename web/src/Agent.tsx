// The Ask panel: talk to the AI that runs this feed. It acts (pages, views, rules, sources,
// themes) and reports each step, with an undo on every local change.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentEvent, AgentThread, Item } from '../../core/types.ts';
import { api, type AgentStatus } from './api.ts';
import { Icon } from './icons.tsx';
import { citedIds, PostMini, RichText } from './rich.tsx';
import type { Reader, ServerEvent } from './state.ts';
import { agoText } from './format.ts';

const LS_THREAD = 'sr.thread.v1';

interface JobState {
  id: string;
  title: string;
  status: string;
  step?: string;
  sample?: any[];
  installed?: { label: string; added: number };
  summary?: string;
  ok?: boolean;
}

export const SUGGESTIONS = [
  'Follow MKBHD on YouTube and @natgeo on Instagram',
  'Make a page of the best photos from this week',
  'Hide anything about crypto or giveaways',
  'What were people talking about today?',
  'Switch to the Tokyo Night theme',
  'Build me a map of where posts mention places',
];

export function useAgentStatus(r: Reader) {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const refresh = useCallback(() => api.agentStatus().then(setStatus).catch(() => setStatus(null)), []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { status, refresh, r };
}

function Spinner() {
  return <span className="spin" aria-hidden />;
}

export function AgentPanel({
  r, close, status, context, onOpenPost, openWorkshop, openSettings, draft, setDraft, phone,
}: {
  r: Reader; close: () => void; status: AgentStatus | null; context: () => unknown; onOpenPost: (it: Item) => void;
  openWorkshop: () => void; openSettings: () => void; draft: { text: string; send?: boolean; fresh?: boolean; n: number } | null; setDraft: (d: null) => void; phone: boolean;
}) {
  const [threadId, setThreadId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(LS_THREAD);
    } catch {
      return null;
    }
  });
  const [thread, setThread] = useState<AgentThread | null>(null);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [jobs, setJobs] = useState<Record<string, JobState>>({});
  const [running, setRunning] = useState(false);
  const [stream, setStream] = useState('');
  const [text, setText] = useState('');
  const [history, setHistory] = useState<AgentThread[] | null>(null);
  const [sending, setSending] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  // Closing the panel hands focus back to whatever opened it (a post, the ask pill, a rail button).
  const opener = useRef<HTMLElement | null>(document.activeElement as HTMLElement | null);
  useEffect(() => () => {
    const o = opener.current;
    if (o && o !== document.body && document.contains(o) && !o.closest('.agent')) o.focus({ preventScroll: true });
  }, []);
  const stick = useRef(true);
  const byId = useMemo(() => new Map((r.lib?.items ?? []).map((i) => [i.id, i])), [r.lib?.items]);

  const remember = (id: string | null) => {
    setThreadId(id);
    try {
      if (id) localStorage.setItem(LS_THREAD, id);
      else localStorage.removeItem(LS_THREAD);
    } catch {
      /* ignore */
    }
  };

  // Load the conversation and the jobs it started.
  const load = useCallback(async (id: string) => {
    try {
      const d = await api.thread(id);
      setThread(d.thread);
      setEvents(d.events);
      setRunning(d.running);
      const js: Record<string, JobState> = {};
      for (const j of d.jobs) js[j.id] = { id: j.id, title: j.title ?? 'Building', status: j.status };
      for (const e of d.events) if (e.type === 'job_done' && js[e.data.jobId]) Object.assign(js[e.data.jobId], { summary: e.data.summary, ok: e.data.ok });
      setJobs(js);
      // Fill in each job's latest step and sample.
      for (const j of d.jobs) {
        api.thread(j.id).then((jd) => setJobs((s) => ({ ...s, [j.id]: { ...s[j.id], ...digestJob(jd.events), status: jd.thread.status } }))).catch(() => {});
      }
    } catch {
      remember(null);
      setThread(null);
      setEvents([]);
    }
  }, []);

  useEffect(() => {
    if (threadId) void load(threadId);
    else {
      setThread(null);
      setEvents([]);
      setJobs({});
    }
  }, [threadId, load]);

  // Live progress from the server.
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;
  useEffect(
    () =>
      r.subscribe((e: ServerEvent) => {
        if (e.type === 'agent' && e.threadId === threadId) {
          const ev: AgentEvent = { id: e.event.id, threadId: e.threadId, at: e.event.at, type: e.event.type, data: e.event.data };
          setEvents((s) => (s.some((x) => x.id === ev.id) ? s : [...s, ev]));
          if (ev.type === 'assistant') setStream('');
          if (ev.type === 'job') setJobs((s) => ({ ...s, [ev.data.jobId]: { id: ev.data.jobId, title: ev.data.title, status: 'waiting' } }));
          if (ev.type === 'job_done') setJobs((s) => ({ ...s, [ev.data.jobId]: { ...s[ev.data.jobId], summary: ev.data.summary, ok: ev.data.ok, status: ev.data.ok ? 'done' : 'error' } }));
        } else if (e.type === 'agent' && jobsRef.current[e.threadId]) {
          setJobs((s) => ({ ...s, [e.threadId]: { ...s[e.threadId], ...digestJob([{ id: e.event.id, threadId: e.threadId, at: e.event.at, type: e.event.type, data: e.event.data }], s[e.threadId]) } }));
        } else if (e.type === 'delta' && e.threadId === threadId) {
          setStream((s) => s + e.text);
        } else if (e.type === 'thread') {
          if (e.threadId === threadId) {
            setRunning(e.status === 'running');
            if (e.status !== 'running') setStream('');
          }
          if (jobsRef.current[e.threadId]) setJobs((s) => ({ ...s, [e.threadId]: { ...s[e.threadId], status: e.status } }));
        }
      }),
    [r, threadId],
  );

  // Keep the newest message in view unless the reader scrolled up.
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [events, stream, jobs]);

  const send = useCallback(
    async (raw: string, fresh = false) => {
      const msg = raw.trim();
      if (!msg || sending) return;
      setSending(true);
      try {
        let id = fresh ? null : threadId;
        if (!id) {
          const t = await api.newThread();
          id = t.id;
          remember(id);
          setThread(t);
        }
        setText('');
        stick.current = true;
        await api.say(id, msg, context());
        setRunning(true);
      } catch (e) {
        r.toast((e as Error).message, { tone: 'error' });
      } finally {
        setSending(false);
      }
    },
    [threadId, sending, context, r],
  );

  // A draft handed over from the dock or the first-run box.
  useEffect(() => {
    if (!draft) return;
    if (draft.fresh) {
      remember(null);
      setHistory(null);
    }
    if (draft.send) void send(draft.text, draft.fresh);
    else {
      setText(draft.text);
      setTimeout(() => {
        input.current?.focus();
        input.current?.setSelectionRange(draft.text.length, draft.text.length);
      }, 30);
    }
    setDraft(null);
  }, [draft]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!draft) setTimeout(() => input.current?.focus(), 60);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [text]);

  const results = useMemo(() => {
    const m = new Map<string, AgentEvent>();
    for (const e of events) if (e.type === 'tool_result') m.set(e.data.callId, e);
    return m;
  }, [events]);

  const undo = async (changeId: string) => {
    try {
      const out = await api.undoChange(changeId);
      r.toast(out.text);
      setEvents((s) => s.map((e) => (e.type === 'tool_result' && e.data?.ui?.changeId === changeId ? { ...e, data: { ...e.data, undone: true } } : e)));
    } catch (e) {
      r.toast((e as Error).message, { tone: 'error' });
    }
  };

  const ready = status?.ready ?? false;
  const empty = events.length === 0;

  // Screen readers hear when a run starts and the reply once it is finished, not every streamed token.
  const [said, setSaid] = useState('');
  const wasRunning = useRef(false);
  useEffect(() => {
    if (running && !wasRunning.current) setSaid('Working on it.');
    if (!running && wasRunning.current) {
      const last = [...events].reverse().find((e) => e.type === 'assistant' || e.type === 'error');
      const text = last ? String(last.data.text ?? '').replace(/\[\[[a-z]+:[^\]]+\]\]/g, '').trim() : '';
      setSaid(text ? text.slice(0, 600) : 'Done.');
    }
    wasRunning.current = running;
  }, [running, events]);

  return (
    <aside className={`agent ${phone ? 'is-phone' : ''}`} aria-label="Ask your feed">
      <header className="agent-head">
        <span className="agent-orb" aria-hidden />
        <div className="agent-title">
          <b>{thread?.title && !empty ? thread.title : 'Ask'}</b>
          <small>{running ? 'working…' : ready ? `${status?.model ?? ''}` : 'not set up'}</small>
        </div>
        <button className="icon-btn" title="Earlier conversations" aria-label="Earlier conversations" onClick={async () => setHistory(history ? null : await api.threads('chat').catch(() => []))}>
          <Icon name="inbox" />
        </button>
        <button className="icon-btn" title="New conversation" aria-label="New conversation" onClick={() => { remember(null); setHistory(null); setTimeout(() => input.current?.focus(), 30); }}>
          <Icon name="plus" />
        </button>
        <button className="icon-btn" onClick={close} aria-label="Close" title="Close (Esc)"><Icon name="x" /></button>
      </header>
      <p className="sr-only" role="status" aria-live="polite">{said}</p>

      {history && (
        <div className="agent-history">
          {history.length === 0 && <p className="muted">No earlier conversations.</p>}
          {history.map((t) => (
            <button key={t.id} className={`hist ${t.id === threadId ? 'on' : ''}`} onClick={() => { remember(t.id); setHistory(null); }}>
              <span>{t.title ?? 'Untitled'}</span>
              <small>{agoText(t.updatedAt)}</small>
            </button>
          ))}
        </div>
      )}

      <div className="agent-scroll" ref={scroller} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; }}>
        {empty ? (
          <div className="agent-empty">
            <p className="agent-hello">Tell your feed what you want.</p>
            <p className="agent-sub">Follow anyone on any site, build a page, hide what you do not want to see, change the look. It does the work and every change can be undone.</p>
            {!ready && status && (
              <div className="agent-setup">
                <p>{status.reason}</p>
                <button className="btn small primary" onClick={openSettings}>Set up the AI</button>
              </div>
            )}
            <div className="agent-sugs">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="sug" disabled={!ready} onClick={() => void send(s)}>{s}</button>
              ))}
            </div>
          </div>
        ) : (
          <div className="agent-log" role="log" aria-live="off" aria-label="Conversation">
            {events.map((e) => {
              switch (e.type) {
                case 'user':
                  return <div key={e.id} className="msg user"><p>{e.data.text}</p></div>;
                case 'assistant':
                  return <Assistant key={e.id} text={String(e.data.text ?? '')} byId={byId} onOpenPost={onOpenPost} />;
                case 'tool_call': {
                  const res = results.get(e.data.callId);
                  return <Step key={e.id} call={e} res={res} byId={byId} onOpenPost={onOpenPost} undo={undo} />;
                }
                case 'job': {
                  const j = jobs[e.data.jobId] ?? { id: e.data.jobId, title: e.data.title, status: 'waiting' };
                  return <JobCard key={e.id} job={j} openWorkshop={openWorkshop} />;
                }
                case 'error':
                  return <div key={e.id} className="msg error"><Icon name="info" size={15} /> {e.data.text}</div>;
                default:
                  return null;
              }
            })}
            {stream && <div className="msg ai streaming"><RichText text={stream} /></div>}
            {running && !stream && <div className="msg thinking"><Spinner /> thinking</div>}
          </div>
        )}
      </div>

      <form className="agent-compose" onSubmit={(e) => { e.preventDefault(); void send(text); }}>
        <textarea
          ref={input}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send(text);
            }
            if (e.key === 'Escape') close();
          }}
          placeholder={ready ? 'Follow, filter, build a page, ask about your feed…' : 'Set up the AI to start'}
          aria-label="Message"
          disabled={!ready && !!status}
          spellCheck
        />
        {running ? (
          <button type="button" className="send stop" aria-label="Stop" title="Stop" onClick={() => threadId && void api.stop(threadId)}><span className="stop-sq" /></button>
        ) : (
          <button type="submit" className="send" aria-label="Send" disabled={!text.trim() || sending || !ready}><Icon name="arrowUp" size={18} /></button>
        )}
      </form>
    </aside>
  );
}

function digestJob(evs: AgentEvent[], prev?: JobState): Partial<JobState> {
  const out: Partial<JobState> = {};
  for (const e of evs) {
    if (e.type === 'tool_call') out.step = e.data.label;
    if (e.type === 'test') {
      out.step = `Test run: ${e.data.count} posts${e.data.ok ? '' : ', failed'}`;
      if (e.data.sample?.length) out.sample = e.data.sample;
    }
    if (e.type === 'installed') out.installed = { label: e.data.label, added: e.data.added };
    if (e.type === 'assistant') out.step = String(e.data.text).split('\n')[0].slice(0, 140);
    if (e.type === 'error') out.step = e.data.text;
  }
  return { ...prev, ...out } as Partial<JobState>;
}

function Assistant({ text, byId, onOpenPost }: { text: string; byId: Map<string, Item>; onOpenPost: (it: Item) => void }) {
  const ids = citedIds(text);
  return (
    <div className="msg ai">
      <RichText text={text} cite={(id, n) => <button className="cite" onClick={() => { const it = byId.get(id); if (it) onOpenPost(it); }} title="Show the post">{n}</button>} />
      {ids.length > 0 && (
        <div className="cites">
          {ids.slice(0, 6).map((id, i) => <PostMini key={id} it={byId.get(id)} n={i + 1} onOpen={onOpenPost} />)}
        </div>
      )}
    </div>
  );
}

function Step({ call, res, byId, onOpenPost, undo }: { call: AgentEvent; res?: AgentEvent; byId: Map<string, Item>; onOpenPost: (it: Item) => void; undo: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const ui = res?.data?.ui ?? null;
  const state = !res ? 'run' : res.data.ok ? 'ok' : 'fail';
  const posts: string[] = Array.isArray(ui?.posts) ? ui.posts.slice(0, 4) : [];
  return (
    <div className={`step ${state}`}>
      <button className="step-row" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="step-ic">{state === 'run' ? <Spinner /> : state === 'ok' ? <Icon name="check" size={14} /> : <Icon name="x" size={14} />}</span>
        <span className="step-label">{call.data.label}</span>
        {ui?.changeId && !res?.data?.undone && (
          <span role="button" tabIndex={0} className="undo-chip" onClick={(e) => { e.stopPropagation(); undo(ui.changeId); }} onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); undo(ui.changeId); } }}>
            <Icon name="undo" size={12} /> Undo
          </span>
        )}
        {res?.data?.undone && <span className="undo-chip done">Undone</span>}
      </button>
      {open && res && <pre className="step-detail">{String(res.data.text ?? '')}</pre>}
      {posts.length > 0 && open && (
        <div className="cites">{posts.map((id) => <PostMini key={id} it={byId.get(id)} onOpen={onOpenPost} />)}</div>
      )}
    </div>
  );
}

function JobCard({ job, openWorkshop }: { job: JobState; openWorkshop: () => void }) {
  const live = job.status === 'running' || job.status === 'waiting';
  const thumbs = (job.sample ?? []).flatMap((p: any) => [p.media?.find((m: any) => m.thumb || m.type === 'image')?.thumb ?? p.media?.find((m: any) => m.type === 'image')?.url, p.author?.avatar]).filter((u: any) => typeof u === 'string' && u.startsWith('https://')).slice(0, 4);
  return (
    <div className={`job ${job.status}`}>
      <div className="job-top">
        <span className="job-ic">{live ? <Spinner /> : job.status === 'done' ? <Icon name="check" size={15} /> : <Icon name="x" size={15} />}</span>
        <div className="job-text">
          <b>{job.title}</b>
          <small>{job.status === 'waiting' ? 'Waiting for a free builder…' : live ? job.step ?? 'Starting…' : job.installed ? `Installed · ${job.installed.added} posts arrived` : job.status === 'done' ? 'Finished' : 'Did not work'}</small>
        </div>
        <button className="link-btn" onClick={openWorkshop}>Workshop</button>
      </div>
      {thumbs.length > 0 && (
        <div className="job-thumbs">{thumbs.map((u: string) => <img key={u} src={u} alt="" loading="lazy" referrerPolicy="no-referrer" />)}</div>
      )}
      {job.summary && !live && <div className="job-sum"><RichText text={job.summary} /></div>}
    </div>
  );
}

/** The Ask field in the dock: type, press Enter, and the panel opens with the answer. */
export function AskPill({ onAsk, onOpen, phone }: { onAsk: (text: string) => void; onOpen: () => void; phone?: boolean }) {
  const [v, setV] = useState('');
  return (
    <form
      className="ask-pill"
      onSubmit={(e) => {
        e.preventDefault();
        if (v.trim()) onAsk(v.trim());
        else onOpen();
        setV('');
      }}
    >
      <span className="agent-orb small" aria-hidden />
      <input id="ask-input" value={v} onChange={(e) => setV(e.target.value)} placeholder={phone ? 'Ask your feed' : 'Ask or tell your feed…'} aria-label="Ask your feed" autoComplete="off" />
      {!phone && !v && <kbd>.</kbd>}
    </form>
  );
}
