// Front page: today's best posts typeset like a newspaper's front page, for the active profile.
// The ranking is core/frontPage.ts (local, no AI); this file only sets it in type. Post text is
// untrusted and only ever rendered as text; pictures are https or the local image proxy.

import '@fontsource-variable/literata/opsz.css';
import { useEffect, useMemo } from 'react';
import { applyFilters, DEFAULT_SPEC, normalizeSpec } from '../../core/filter.ts';
import { buildFrontPage, type Story } from '../../core/frontPage.ts';
import type { Item } from '../../core/types.ts';
import { agoText } from './format.ts';
import { Icon } from './icons.tsx';
import type { Reader } from './state.ts';
import { useDialog } from './useDialog.ts';
import './frontPage.css';

const dateLine = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

export function FrontPageView({ r, close, open }: { r: Reader; close: () => void; open: (it: Item) => void }) {
  const dlg = useDialog<HTMLDivElement>();
  const lib = r.lib!;
  const page = useMemo(() => {
    const res = applyFilters(lib.items, normalizeSpec({ ...DEFAULT_SPEC, hideNoise: true }), { topics: lib.topics, sourceLabels: r.sourceLabels, ai: { rules: lib.aiRules, labels: lib.labels } });
    return buildFrontPage(res.visible, lib.items);
  }, [lib.items, lib.topics, lib.aiRules, lib.labels, r.sourceLabels]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [close]);

  const label = (it: Item) => r.sourceLabels[it.sourceId] ?? it.platform;
  const byline = (s: Story) => [s.item.author.name || s.item.author.handle, label(s.item), agoText(s.item.publishedAt)].filter(Boolean).join(' · ');
  const edition = r.profile?.name ?? 'Everything';
  const today = new Date();
  const stale = page.newest && Date.now() - Date.parse(page.newest) > 3 * 86_400_000;

  const Headline = ({ s, level = 3 }: { s: Story; level?: 2 | 3 | 4 }) => {
    const H = `h${level}` as 'h2' | 'h3' | 'h4';
    return (
      <H className="fp-head">
        <button className="fp-link" onClick={() => open(s.item)}>{s.head}</button>
      </H>
    );
  };

  return (
    <div ref={dlg} className="fp" role="dialog" aria-modal="true" aria-labelledby="fp-title">
      <div className="fp-paper">
        <header className="fp-mast">
          <div className="fp-ears">
            <span>{dateLine.format(today)}</span>
            <span className="fp-edition">{edition} edition</span>
            <button className="icon-btn fp-close" onClick={close} aria-label="Close the front page"><Icon name="x" /></button>
          </div>
          <h2 id="fp-title" className="fp-title">The Front Page</h2>
          <p className="fp-sub">
            {page.considered
              ? <>{page.considered} stories from {page.sources} {page.sources === 1 ? 'source' : 'sources'}, set by what you read and keep. Nothing here was written by AI.</>
              : 'Nothing to set yet.'}
            {stale && page.newest ? <> Newest post {agoText(page.newest)}.</> : null}
          </p>
        </header>

        {!page.lead ? (
          <p className="fp-empty">When your sources bring in new posts, the best of them land here.</p>
        ) : (
          <>
            <div className="fp-top">
              <div className="fp-main">
                <article className={`fp-lead ${page.lead.image ? '' : 'fp-lead-text'}`}>
                  {page.lead.image && (
                    <figure className="fp-fig fp-lead-fig">
                      <img src={page.lead.image} alt={page.lead.alt ?? ''} loading="eager" decoding="async" referrerPolicy="no-referrer" />
                    </figure>
                  )}
                  <p className="fp-kicker">{label(page.lead.item)}</p>
                  <Headline s={page.lead} level={3} />
                  {page.lead.dek && <p className="fp-dek">{page.lead.dek}</p>}
                  <p className="fp-by">{byline(page.lead)}</p>
                </article>

                {page.secondary.length > 0 && (
                  <section className="fp-row" aria-label="More stories">
                    {page.secondary.map((s) => (
                      <article key={s.item.id} className="fp-second">
                        {s.image && (
                          <figure className="fp-fig">
                            <img src={s.image} alt={s.alt ?? ''} loading="lazy" decoding="async" referrerPolicy="no-referrer" />
                          </figure>
                        )}
                        <p className="fp-kicker">{label(s.item)}</p>
                        <Headline s={s} level={3} />
                        {s.dek && <p className="fp-dek fp-dek-s">{s.dek}</p>}
                        <p className="fp-by">{byline(s)}</p>
                      </article>
                    ))}
                  </section>
                )}
              </div>

              {page.briefs.length > 0 && (
                <aside className="fp-briefs" aria-labelledby="fp-briefs-h">
                  <h3 id="fp-briefs-h" className="fp-section">In brief</h3>
                  <ol>
                    {page.briefs.map((s) => (
                      <li key={s.item.id} className="fp-brief">
                        <Headline s={s} level={4} />
                        <p className="fp-by">{byline(s)}</p>
                      </li>
                    ))}
                  </ol>
                </aside>
              )}
            </div>

            {page.photos.length > 0 && (
              <section className="fp-photos" aria-labelledby="fp-photos-h">
                <h3 id="fp-photos-h" className="fp-section">In pictures</h3>
                <ul>
                  {page.photos.map((s) => (
                    <li key={s.item.id}>
                      <button className="fp-photo" onClick={() => open(s.item)} aria-label={`${s.head}, from ${s.item.author.name || label(s.item)}`}>
                        <img src={s.image} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" />
                        <span className="fp-cap" aria-hidden>{s.item.author.name || label(s.item)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {page.people.length > 0 && (
              <section className="fp-people" aria-labelledby="fp-people-h">
                <h3 id="fp-people-h" className="fp-section">From your people</h3>
                <ul>
                  {page.people.map((p) => (
                    <li key={p.key} className="fp-person">
                      <span className="fp-ava" aria-hidden>
                        {p.avatar ? <img src={p.avatar} alt="" loading="lazy" referrerPolicy="no-referrer" /> : (p.name[0] ?? '?').toUpperCase()}
                      </span>
                      <div>
                        <p className="fp-who">{p.name}</p>
                        <Headline s={p.story} level={4} />
                        <p className="fp-by">{label(p.story.item)} · {agoText(p.story.item.publishedAt)}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
        <footer className="fp-foot">Opening a story marks nothing on the source. Press Escape to go back to the feed.</footer>
      </div>
    </div>
  );
}
