// Pair the Aurora phone app with this computer: show a QR code, wait for the phone to scan it,
// and issue its key only when you approve here. Paired phones can be unpaired at any time.

import { useEffect, useRef, useState } from 'react';
import './phones.css';

interface Device { id: string; name: string; platform: string; createdAt: string; lastSeenAt?: string }
interface PairStart { id: string; code: string; name: string; lan: boolean; options: { url: string; link: string; svg: string }[]; expiresAt: string }
interface PairStatus { state: 'waiting' | 'claimed' | 'approved' | 'denied' | 'expired'; claim: { name: string; platform: string; check: string } | null }

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data as T;
}

const day = (iso?: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : 'never');

export function Phones({ toast }: { toast: (text: string, opts?: { tone?: 'info' | 'error' }) => void }) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [lan, setLan] = useState(true);
  const [pair, setPair] = useState<PairStart | null>(null);
  const [pick, setPick] = useState(0);
  const [status, setStatus] = useState<PairStatus | null>(null);
  const [left, setLeft] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = () => call<{ devices: Device[]; lan: boolean }>('GET', '/api/devices').then((r) => { setDevices(r.devices); setLan(r.lan); }).catch(() => {});
  useEffect(() => { void refresh(); }, []);

  useEffect(() => {
    if (!pair) return;
    const tick = async () => {
      setLeft(Math.max(0, Math.round((Date.parse(pair.expiresAt) - Date.now()) / 1000)));
      try {
        const s = await call<PairStatus>('GET', `/api/devices/pair/${pair.id}`);
        setStatus(s);
        if (s.state === 'expired') stopPairing();
      } catch { /* keep polling */ }
    };
    void tick();
    timer.current = setInterval(tick, 1500);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [pair]);

  const stopPairing = () => {
    if (timer.current) clearInterval(timer.current);
    setPair(null);
    setStatus(null);
  };

  const start = async () => {
    try {
      const p = await call<PairStart>('POST', '/api/devices/pair', {});
      setPick(0);
      setStatus(null);
      setPair(p);
    } catch (e) { toast((e as Error).message, { tone: 'error' }); }
  };

  const decide = async (approve: boolean) => {
    if (!pair) return;
    try {
      await call('POST', `/api/devices/pair/${pair.id}/approve`, { approve });
      toast(approve ? `${status?.claim?.name ?? 'Phone'} paired. It can read and save posts, not change sources or keys.` : 'Pairing refused');
      stopPairing();
      void refresh();
    } catch (e) { toast((e as Error).message, { tone: 'error' }); }
  };

  const unpair = async (d: Device) => {
    try {
      await call('DELETE', `/api/devices/${d.id}`);
      toast(`${d.name} unpaired. Its key no longer works.`);
      void refresh();
    } catch (e) { toast((e as Error).message, { tone: 'error' }); }
  };

  const opt = pair?.options[pick];

  return (
    <section className="f-sec phones">
      <h3>Phones</h3>
      <p className="f-hint">The Aurora phone app reads this library over your network. It gets its own key, which you approve here and can take back at any time.</p>
      {!lan && (
        <p className="f-hint phones-warn">
          Aurora only listens on this computer right now, so a phone on Wi-Fi cannot reach it. Start it with <code>HOST=0.0.0.0 ALLOW_NON_LOCAL=1</code> to pair over your network. See docs/mobile.md.
        </p>
      )}

      {devices.length > 0 && (
        <ul className="phones-list">
          {devices.map((d) => (
            <li key={d.id}>
              <span className="phones-name">{d.name}</span>
              <span className="phones-meta">{d.platform} · paired {day(d.createdAt)} · seen {day(d.lastSeenAt)}</span>
              <button type="button" className="btn small ghost" onClick={() => unpair(d)}>Unpair</button>
            </li>
          ))}
        </ul>
      )}

      {!pair && <div className="more-row"><span>{devices.length ? `${devices.length} paired` : 'No phones paired'}</span><button type="button" className="btn small" onClick={start}>Pair a phone</button></div>}

      {pair && (
        <div className="phones-pair">
          {status?.state === 'claimed' && status.claim ? (
            <div className="phones-ask">
              <b>{status.claim.name}</b> ({status.claim.platform}) wants to pair.
              <p>Check that the phone shows <span className="phones-check">{status.claim.check}</span>, then approve.</p>
              <div className="phones-actions">
                <button type="button" className="btn small ghost" onClick={() => decide(false)}>Refuse</button>
                <button type="button" className="btn small primary" onClick={() => decide(true)}>Approve</button>
              </div>
            </div>
          ) : opt ? (
            <>
              <img className="phones-qr" alt={`Pairing code for ${opt.url}`} src={`data:image/svg+xml;utf8,${encodeURIComponent(opt.svg)}`} />
              <div className="phones-side">
                <p>Open Aurora on your phone and scan this code.</p>
                {pair.options.length > 1 && (
                  <select className="f-input small" value={pick} onChange={(e) => setPick(Number(e.target.value))} aria-label="Address the phone uses">
                    {pair.options.map((o, i) => <option key={o.url} value={i}>{o.url}</option>)}
                  </select>
                )}
                <p className="phones-meta">Or type <code>{opt.url}</code> and code <code>{pair.code}</code></p>
                <p className="phones-meta">Expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</p>
                <button type="button" className="btn small ghost" onClick={stopPairing}>Cancel</button>
              </div>
            </>
          ) : (
            <div className="phones-side">
              <p>No network address to put in the code. Start Aurora with HOST set (see above), or set SR_PUBLIC_URL to the address your phone uses.</p>
              <p className="phones-meta">Code for typing in: <code>{pair.code}</code></p>
              <button type="button" className="btn small ghost" onClick={stopPairing}>Cancel</button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
