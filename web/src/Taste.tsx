// "Suggested for you": a few rules and views the AI proposes from what you save and open.
// One click creates it locally; dismissing remembers the answer so it is not suggested again.

import { useEffect, useRef, useState } from 'react';
import { api, type TasteState, type TasteSuggestion } from './api.ts';
import { Icon } from './icons.tsx';
import type { Reader } from './state.ts';

const STALE = 3 * 86_400_000;

export function TasteCard({ r, aiReady }: { r: Reader; aiReady: boolean }) {
  const [st, setSt] = useState<TasteState | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const tried = useRef(false);

  const refresh = async () => {
    setBusy(true);
    setErr(null);
    try {
      setSt(await api.refreshTaste(r.spec.excludeAuthors, r.spec.exclude));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    let live = true;
    api.taste().then((s) => {
      if (!live) return;
      setSt(s);
      // Suggest on its own the first time, and again every few days, once there is enough history.
      const stale = !s.at || Date.now() - Date.parse(s.at) > STALE;
      if (aiReady && s.canSuggest && stale && !s.building && !tried.current) {
        tried.current = true;
        void refresh();
      }
    }).catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiReady]);

  if (!st || !aiReady || (!st.canSuggest && !st.suggestions.length)) return null;
  if (!busy && !st.suggestions.length && !err) {
    return (
      <section className="rules-card taste-card quiet">
        <h3 className="eyebrow">Suggested for you</h3>
        <button className="btn small ghost" onClick={() => void refresh()}><Icon name="sparkle" size={15} /> Suggest rules from what I read</button>
      </section>
    );
  }

  const accept = async (s: TasteSuggestion) => {
    try {
      const res = await api.acceptTaste(s.id);
      setSt(res);
      await r.reload();
      if (res.created.kind === 'view') {
        if (res.created.spec) r.openView(res.created.id, res.created.spec, res.created.name);
        else { r.setPageId(null); r.setViewId(res.created.id); }
        r.toast(`Made the view “${res.created.name}”`);
      } else r.toast(`Added the rule “${res.created.name}”. The AI is reading your posts now.`);
    } catch (e) {
      r.toast((e as Error).message, { tone: 'error' });
    }
  };
  const verb = { hide: 'Hide', only: 'Keep only', tag: 'Mark' } as const;

  return (
    <section className="rules-card taste-card" aria-busy={busy}>
      <h3 className="eyebrow">Suggested for you</h3>
      {busy && !st.suggestions.length && <p className="taste-busy"><span className="taste-pulse" aria-hidden /> Reading what you save and open…</p>}
      {err && <p className="taste-err">{err}</p>}
      {st.suggestions.map((s) => (
        <div key={s.id} className="taste-item">
          <p className="taste-title">
            <span className={`taste-kind ${s.kind}`}>{s.kind === 'rule' ? verb[s.rule!.action] : 'View'}</span>
            {s.title}
          </p>
          {s.why && <p className="taste-why">{s.why}</p>}
          <div className="taste-actions">
            <button className="btn small" onClick={() => void accept(s)}><Icon name="plus" size={14} /> {s.kind === 'rule' ? 'Add rule' : 'Make view'}</button>
            <button className="btn small ghost" onClick={async () => setSt(await api.dismissTaste(s.id))} aria-label={`Not for me: ${s.title}`}>Not for me</button>
          </div>
        </div>
      ))}
      {st.suggestions.length > 0 && (
        <button className="link-btn taste-more" disabled={busy} onClick={() => void refresh()}>{busy ? 'Thinking…' : 'Other ideas'}</button>
      )}
    </section>
  );
}
