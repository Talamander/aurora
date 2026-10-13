import { useEffect, useRef, useState } from 'react';
import type { Source } from '../../core/types.ts';
import { api } from './api.ts';
import { Icon } from './icons.tsx';
import { fullTime, plural, relTime, agoText } from './format.ts';
import type { Reader } from './state.ts';
import { useDialog } from './useDialog.ts';
import { ReportCards } from './ReportCard.tsx';

const STATUS_LABEL: Record<Source['status'], string> = { ok: 'Up to date', error: 'Last sync failed', blocked: 'Needs you', syncing: 'Syncing', never: 'Not synced yet' };

export function SourcesPanel({ r, close, openFollows, startTab = 'sources', openInColumns }: { r: Reader; close: () => void; openFollows?: () => void; startTab?: 'sources' | 'report'; openInColumns?: (sourceId: string) => void }) {
  const dlg = useDialog<HTMLDivElement>();
  const [tab, setTab] = useState(startTab);
  const lib = r.lib!;
  const [url, setUrl] = useState('');
  const [handle, setHandle] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [formError, setFormError] = useState<{ form: string; msg: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [importReport, setImportReport] = useState<{ file: string; added: number; updated: number; skipped: number; errors: string[]; feedsAdded?: number; failed?: boolean } | null>(null);
  const [xStatus, setXStatus] = useState<{ configured: boolean; connected: boolean; redirectUri?: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);

  useEffect(() => {
    api.xStatus().then(setXStatus).catch(() => setXStatus(null));
  }, []);

  const conn = (id: string) => lib.connectors.find((c) => c.id === id);

  const add = async (connector: string, config: Record<string, unknown>, form: string) => {
    setBusy(form);
    setFormError(null);
    try {
      const out = await api.addSource(connector, config);
      await r.reload();
      const res = out.result;
      if (res.blocked) r.toast(`${out.source.label}: ${res.blocked}`, { tone: 'error' });
      else if (res.error) r.toast(`${out.source.label} was added, but the first sync failed: ${res.error}`, { tone: 'error' });
      else r.toast(`Added ${out.source.label}: ${plural(res.added ?? 0, 'new post')}`);
      if (form === 'rss') setUrl('');
      if (form === 'bsky') setHandle('');
    } catch (e) {
      setFormError({ form, msg: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const importFiles = async (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      if (f.size > 75e6) {
        r.toast(`${f.name} is larger than 75 MB. Split it, or import the individual files from the archive's data folder.`, { tone: 'error' });
        continue;
      }
      setBusy('import');
      try {
        const text = await f.text();
        const out = await api.importFile(f.name, text);
        setImportReport({ file: f.name, added: out.added, updated: out.updated, skipped: out.skipped, errors: out.errors, feedsAdded: out.feedsAdded });
        await r.reload();
        if (out.feedsAdded !== undefined) r.toast(`${f.name}: ${plural(out.feedsAdded, 'feed')} added${out.feedsAdded ? ', syncing now' : ''}`);
        else r.toast(`${f.name}: ${plural(out.added, 'new post')}${out.updated ? `, ${out.updated} refreshed` : ''}`);
      } catch (e) {
        setImportReport({ file: f.name, added: 0, updated: 0, skipped: 0, errors: [(e as Error).message], failed: true });
      } finally {
        setBusy(null);
      }
    }
  };

  const sync = async (s: Source) => {
    setBusy(`sync:${s.id}`);
    try {
      const res = await api.syncSource(s.id);
      await r.reload();
      if (res.blocked) r.toast(`${s.label}: ${res.blocked}`, { tone: 'error' });
      else if (res.error) r.toast(`${s.label}: ${res.error}`, { tone: 'error' });
      else r.toast(`${s.label}: ${plural(res.added ?? 0, 'new post')}`);
    } catch (e) {
      r.toast((e as Error).message, { tone: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const demo = lib.sources.find((s) => s.isDemo);
  const runs = lib.syncRuns.slice(0, 12);
  const xConn = conn('x-bookmarks');

  return (
    <div className="sheet-backdrop" onClick={close}>
      <div ref={dlg} className="sheet sources" role="dialog" aria-modal="true" aria-label="Sources and imports" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>Sources &amp; imports</h2>
          <button className="icon-btn" onClick={close} aria-label="Close"><Icon name="x" /></button>
        </div>
        <div className="sheet-body">
          <div className="seg src-tabs" role="radiogroup" aria-label="Sources view">
            <button role="radio" aria-checked={tab === 'sources'} className={tab === 'sources' ? 'on' : ''} onClick={() => setTab('sources')}>Sources</button>
            <button role="radio" aria-checked={tab === 'report'} className={tab === 'report' ? 'on' : ''} onClick={() => setTab('report')}>Report card</button>
          </div>
          {tab === 'report' ? <ReportCards r={r} openInColumns={openInColumns} /> : <>
          <p className="f-hint lead">Everything is read-only. Aurora never likes, follows, posts or removes bookmarks on any site. Reading state lives only on this computer.</p>

          <section className="f-sec">
            <h3>Connected</h3>
            {lib.sources.length === 0 && <p className="f-hint">Nothing yet. Add a feed or import a file below.</p>}
            <ul className="src-list">
              {lib.sources.map((s) => (
                <li key={s.id} className={`src ${s.status}`}>
                  <span className={`mark ${s.isDemo ? 'demo' : ''}`} style={{ background: s.isDemo ? undefined : `var(--hue-${s.platform})` }} />
                  <div className="src-main">
                    <p className="src-name">{s.label}{!s.enabled && <span className="tag">Paused</span>}</p>
                    <p className="src-meta">
                      <span className={`status ${s.status}`}>{STATUS_LABEL[s.status]}</span>
                      {' · '}{plural(s.itemCount, 'post')}
                      {s.lastSyncAt && <> · <time dateTime={s.lastSyncAt} title={fullTime(s.lastSyncAt)}>{agoText(s.lastSyncAt)}</time></>}
                      {typeof s.config.url === 'string' && <> · <span className="src-url">{s.config.url}</span></>}
                      {typeof s.config.fileName === 'string' && <> · {s.config.fileName}</>}
                    </p>
                    {s.statusDetail && <p className={`src-detail ${s.status}`}>{s.statusDetail}</p>}
                  </div>
                  <div className="src-actions">
                    {s.connector !== 'import' && s.connector !== 'demo' && (
                      <>
                        <button className="btn small" disabled={busy === `sync:${s.id}`} onClick={() => void sync(s)}><Icon name="sync" size={14} /> {busy === `sync:${s.id}` ? 'Syncing' : 'Sync'}</button>
                        <button className="btn small ghost" onClick={async () => { await api.updateSource(s.id, { enabled: !s.enabled }); void r.reload(); }}>{s.enabled ? 'Pause' : 'Resume'}</button>
                      </>
                    )}
                    {confirmRemove === s.id ? (
                      <span className="confirm">
                        Remove it and its {plural(s.itemCount, 'post')} from this library?
                        <button className="btn small danger" onClick={async () => { await api.deleteSource(s.id); setConfirmRemove(null); await r.reload(); r.toast(`Removed ${s.label}`); }}>Remove</button>
                        <button className="btn small ghost" onClick={() => setConfirmRemove(null)}>Keep</button>
                      </span>
                    ) : (
                      <button className="btn small ghost" onClick={() => setConfirmRemove(s.id)}>Remove</button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            {lib.sources.some((s) => s.connector !== 'import' && s.connector !== 'demo') && (
              <button className="btn small" disabled={busy === 'all'} onClick={async () => {
                setBusy('all');
                try {
                  await api.syncAll();
                  r.toast('Synced all feeds');
                } catch (e) {
                  r.toast(`Sync failed: ${(e as Error).message}`, { tone: 'error' });
                } finally {
                  setBusy(null);
                  await r.reload();
                }
              }}><Icon name="sync" size={14} /> {busy === 'all' ? 'Syncing all' : 'Sync all feeds'}</button>
            )}
          </section>

          {openFollows && (
            <section className="f-sec follows-cta">
              <h3>Bring your follows</h3>
              <p className="f-hint">Move everyone you follow on YouTube, Instagram, TikTok, Mastodon, Reddit, Substack or Bluesky in one go, from their data export or your Bluesky handle.</p>
              <button className="btn primary" onClick={openFollows}><Icon name="people" size={15} /> Bring your follows</button>
            </section>
          )}

          <section className="f-sec">
            <h3>Follow a feed</h3>
            <p className="f-hint">RSS or Atom from a blog or newsletter, a Mastodon profile (<code>https://instance/@name.rss</code>), a Bluesky profile (<code>https://bsky.app/profile/name/rss</code>), a subreddit (<code>https://www.reddit.com/r/name/.rss</code>) or a YouTube channel feed. A normal web page works if it links its feed.</p>
            <form className="add-form" onSubmit={(e) => { e.preventDefault(); if (url.trim()) void add('rss', { url: url.trim() }, 'rss'); }}>
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/feed.xml" aria-label="Feed URL" type="url" inputMode="url" />
              <button className="btn primary" type="submit" disabled={!url.trim() || busy === 'rss'}>{busy === 'rss' ? 'Checking' : 'Add feed'}</button>
            </form>
            {formError?.form === 'rss' && <p className="form-error" role="alert">{formError.msg}</p>}
          </section>

          <section className="f-sec">
            <h3>Follow a Bluesky account</h3>
            <p className="f-hint">Public posts through Bluesky's open API. No login needed. Replies are left out.</p>
            <form className="add-form" onSubmit={(e) => { e.preventDefault(); if (handle.trim()) void add('bluesky-public', { handle: handle.trim() }, 'bsky'); }}>
              <input value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="name.bsky.social" aria-label="Bluesky handle" autoCapitalize="off" spellCheck={false} />
              <button className="btn primary" type="submit" disabled={!handle.trim() || busy === 'bsky' || conn('bluesky-public')?.available === false}>{busy === 'bsky' ? 'Checking' : 'Add account'}</button>
            </form>
            {formError?.form === 'bsky' && <p className="form-error" role="alert">{formError.msg}</p>}
          </section>

          <section className="f-sec">
            <h3>Import a file</h3>
            <div
              className={`drop ${drag ? 'over' : ''}`}
              onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => { e.preventDefault(); setDrag(false); void importFiles(e.dataTransfer.files); }}
            >
              <Icon name="upload" size={22} />
              <p><strong>Drop files here</strong> or <button className="link-btn" onClick={() => fileRef.current?.click()}>choose files</button></p>
              <p className="f-hint">From your X archive's <code>data</code> folder: <code>tweets.js</code>, <code>like.js</code>, <code>bookmark.js</code>. A JSON or CSV export of X bookmarks from the twitter-web-exporter browser extension. Browser bookmarks (<code>bookmarks.html</code>). A JSON list with url, title and text fields. An OPML feed list from another reader adds each feed.</p>
              <input ref={fileRef} type="file" multiple hidden accept=".js,.json,.csv,.html,.htm,.txt,.opml,.xml" onChange={(e) => e.target.files && void importFiles(e.target.files)} />
              {busy === 'import' && <p className="f-hint">Importing…</p>}
            </div>
            {importReport && (
              <div className={`import-report ${importReport.added + importReport.updated + (importReport.feedsAdded ?? 0) === 0 ? 'bad' : ''}`} role="status">
                {importReport.failed ? (
                  <p><strong>{importReport.file}</strong> could not be imported. Nothing was added.</p>
                ) : importReport.feedsAdded !== undefined ? (
                  <p><strong>{importReport.file}</strong>: {plural(importReport.feedsAdded, 'feed')} added, {importReport.skipped} skipped (already followed or not a web link). New feeds sync one by one in the background.</p>
                ) : (
                  <p><strong>{importReport.file}</strong>: {plural(importReport.added, 'new post')}, {importReport.updated} refreshed, {importReport.skipped} skipped.</p>
                )}
                {importReport.errors.length > 0 && (
                  importReport.failed ? <p className="import-error">{importReport.errors[0]}</p> : <details open={importReport.added + importReport.updated === 0}>
                    <summary>{plural(importReport.errors.length, 'problem')}</summary>
                    <ul>{importReport.errors.slice(0, 20).map((e, i) => <li key={i}>{e}</li>)}</ul>
                  </details>
                )}
              </div>
            )}
          </section>

          <section className="f-sec">
            <h3>X bookmarks, live</h3>
            {xConn?.available && xStatus?.configured ? (
              <>
                <p className="f-hint">Uses X's official API with read-only permission (tweet.read, users.read, bookmark.read, offline.access). X bills API reads to your developer account, about $0.001 per post read under current pay-per-use pricing. To keep that predictable it never syncs in the background, only when you press Sync, and each sync stops at bookmarks it has already seen.</p>
                {xStatus.connected ? (
                  <p className="f-hint">Connected. Sync it from the list above.</p>
                ) : (
                  <a className="btn primary" href="/api/x/auth/start">Approve read access on X</a>
                )}
              </>
            ) : (
              <div className="blocked">
                <p><strong>Needs you.</strong> {xConn?.blockedReason ?? 'Reading X bookmarks live needs an X developer app that you create and pay for.'}</p>
                <ol>
                  <li>At developer.x.com, create a Project and App with OAuth 2.0 turned on (type: Native App or Web App).</li>
                  <li>Set its callback URL to <code>{xStatus?.redirectUri ?? 'http://127.0.0.1:4317/api/x/auth/callback'}</code>.</li>
                  <li>Add credit to the developer account. Reads are billed per post.</li>
                  <li>Start Aurora with <code>X_CLIENT_ID=… npm start</code>, then press “Approve read access on X” here.</li>
                </ol>
                <p className="f-hint">No API budget? Import <code>bookmark.js</code> from your X archive (IDs only), or an export from twitter-web-exporter (full text).</p>
              </div>
            )}
          </section>

          <section className="f-sec">
            <h3>Not available</h3>
            <ul className="na-list">
              {lib.connectors.filter((c) => !c.available && c.id !== 'x-bookmarks').map((c) => (
                <li key={c.id}><strong>{c.name}.</strong> {c.blockedReason ?? c.description}</li>
              ))}
            </ul>
          </section>

          <section className="f-sec">
            <h3>Demo library</h3>
            {demo ? (
              <p className="f-hint">
                {plural(demo.itemCount, 'fictional post')} loaded, marked with a hatched spine.{' '}
                <button className="link-btn" onClick={async () => { await api.deleteSource(demo.id); await r.reload(); r.toast('Demo library removed'); }}>Remove the demo library</button>
              </p>
            ) : (
              <p className="f-hint">
                36 made-up posts for trying filters. <button className="link-btn" onClick={async () => { const o = await api.loadDemo(); await r.reload(); r.toast(`Loaded ${o.added} fictional demo posts`); }}>Load it</button>
              </p>
            )}
          </section>

          <section className="f-sec">
            <h3>Take it with you</h3>
            <p className="f-hint">Everything in the library, with your reading state, saved views and topics, as one JSON file. Or just the feeds you follow, as OPML for another reader. No passwords or tokens are included.</p>
            <p className="export-links">
              <a className="btn small" href="/api/export/library.json" download><Icon name="upload" size={14} /> Export library</a>
              <a className="btn small" href="/api/export/feeds.opml" download>Export feeds (OPML)</a>
            </p>
          </section>

          {runs.length > 0 && (
            <section className="f-sec">
              <h3>Recent syncs</h3>
              <ul className="runs">
                {runs.map((run) => {
                  const s = lib.sources.find((x) => x.id === run.sourceId);
                  return (
                    <li key={run.id} className={run.ok ? '' : 'bad'}>
                      <span>{relTime(run.startedAt)}</span>
                      <span className="run-src">{s?.label ?? 'Removed source'}</span>
                      <span>{run.ok ? `+${run.added}${run.updated ? ` · ${run.updated} refreshed` : ''}${run.skipped ? ` · ${run.skipped} skipped` : ''}` : run.errors[0] ?? 'Failed'}</span>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          </>}
        </div>
      </div>
    </div>
  );
}
