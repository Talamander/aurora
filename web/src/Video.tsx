// Inline video, click to play. YouTube and Vimeo play in their privacy-friendly embeds, direct
// files in a <video>, HLS streams (Bluesky) through hls.js. Nothing loads until you press play.

import { useEffect, useRef, useState } from 'react';
import type { Media } from '../../core/types.ts';
import { Icon } from './icons.tsx';
import { hostOf } from './format.ts';

function youtubeId(url: string): string | null {
  try {
    const u = new URL(url);
    if (/(^|\.)youtube\.com$/.test(u.hostname)) {
      if (u.pathname === '/watch') return u.searchParams.get('v');
      const m = /^\/(shorts|embed|live)\/([\w-]{6,})/.exec(u.pathname);
      return m ? m[2] : null;
    }
    if (u.hostname === 'youtu.be') return u.pathname.slice(1) || null;
  } catch {
    /* not a URL */
  }
  return null;
}

function vimeoId(url: string): string | null {
  const m = /^https:\/\/(?:www\.)?vimeo\.com\/(\d+)/.exec(url);
  return m ? m[1] : null;
}

export function playable(url: string): boolean {
  return !!youtubeId(url) || !!vimeoId(url) || /\.(mp4|webm|mov|m3u8)(\?|$)/i.test(url);
}

function Hls({ src, poster }: { src: string; poster?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const v = ref.current!;
    if (v.canPlayType('application/vnd.apple.mpegurl')) {
      v.src = src;
      return;
    }
    let hls: { destroy(): void } | null = null;
    let dead = false;
    void import('hls.js').then(({ default: H }) => {
      if (dead) return;
      if (!H.isSupported()) return setFailed(true);
      const h = new H({ enableWorker: false });
      h.on(H.Events.ERROR, (_e, d) => { if (d.fatal) setFailed(true); });
      h.loadSource(src);
      h.attachMedia(v);
      hls = h;
    });
    return () => { dead = true; hls?.destroy(); };
  }, [src]);
  if (failed) return <p className="video-fail">This stream would not play here.</p>;
  return <video ref={ref} poster={poster} controls autoPlay playsInline />;
}

export function InlineVideo({ m, href }: { m: Media; href: string }) {
  const [on, setOn] = useState(false);
  const [failed, setFailed] = useState(false);
  const yt = youtubeId(m.url);
  const vimeo = vimeoId(m.url);
  const vertical = /\/shorts\/|\/reel\//.test(href) || /\/shorts\//.test(m.url);
  if (!on || failed) {
    return (
      <div className={`video-card ${vertical ? 'vertical' : ''}`}>
        <button className="video-poster" onClick={() => (failed ? window.open(href, '_blank', 'noopener,noreferrer') : setOn(true))} aria-label={failed ? 'Open the video on its site' : 'Play video here'}>
          {m.thumb ? <img src={m.thumb} alt={m.alt ?? ''} loading="lazy" referrerPolicy="no-referrer" /> : <span className="video-blank" />}
          <span className="video-play"><Icon name={failed ? 'external' : 'play'} size={22} /></span>
        </button>
        <a className="video-src" href={href} target="_blank" rel="noopener noreferrer">{failed ? 'Expired here · open on ' : ''}{hostOf(href)}</a>
      </div>
    );
  }
  return (
    <div className={`video-card playing ${vertical ? 'vertical' : ''}`}>
      {yt ? (
        <iframe src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(yt)}?autoplay=1&rel=0&modestbranding=1`} title="YouTube video" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" />
      ) : vimeo ? (
        <iframe src={`https://player.vimeo.com/video/${vimeo}?autoplay=1&dnt=1`} title="Vimeo video" allow="autoplay; fullscreen; picture-in-picture" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" />
      ) : /\.m3u8(\?|$)/i.test(m.url) ? (
        <Hls src={m.url} poster={m.thumb} />
      ) : (
        <video src={m.url} poster={m.thumb} controls autoPlay playsInline onError={() => setFailed(true)} />
      )}
    </div>
  );
}
