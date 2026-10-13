// Routines: what Aurora does on a schedule, and what it did last time. Read-only on the phone:
// routines are written, planned, turned on and run on the computer, where the AI key and the
// spending caps live. The last run's summary cites posts, which open here as usual.
import { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api, isOffline, type RoutineView } from '../src/api';
import { readCache, writeCache } from '../src/cache';
import { Icon } from '../src/Icon';
import { OfflineBanner } from '../src/Offline';
import { CitedRow, citedIds, RichText } from '../src/Rich';
import { ago, useStore } from '../src/store';
import { radius, space, usePalette, type Palette } from '../src/theme';
import { Ambient, T, TopBar } from '../src/ui';

type Payload = { routines: RoutineView[]; aiReady: boolean; aiReason: string | null };

/** "today at 07:30", "tomorrow at 07:30", "Thursday at 07:30", or a date further out. */
export function nextLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86_400_000);
  if (d.getTime() - now.getTime() < 60_000) return 'any moment';
  if (days === 0) return `today at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  if (days < 7) return `${d.toLocaleDateString(undefined, { weekday: 'long' })} at ${time}`;
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} at ${time}`;
}

const since = (iso: string) => { const a = ago(iso); return a === 'now' ? 'just now' : `${a} ago`; };

function state(r: RoutineView, p: Palette): { label: string; color: string } {
  if (r.running) return { label: 'Running', color: p.on };
  if (r.queued) return { label: 'Queued', color: p.on };
  if (r.paused) return { label: 'Paused', color: p.warn };
  if (!r.enabled) return { label: 'Off', color: p.ink3 };
  return { label: 'On', color: p.lamp };
}

export default function Routines() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const st = useStore();
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.routines();
      setData(r);
      setError(null);
      writeCache('routines', r);
    } catch (e) {
      const kept = isOffline(e) ? await readCache<Payload>('routines') : null;
      if (kept) setData((d) => d ?? kept);
      else setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void readCache<Payload>('routines').then((kept) => { if (kept) setData((d) => d ?? kept); });
    void load();
  }, [load]);
  // The computer says when a routine changes or finishes a run.
  useEffect(() => st.subscribe((e) => { if (e.type === 'ui' && e.action.kind === 'routines-changed') void load(); }), [st.subscribe, load]);

  const names = Object.fromEntries(st.profiles.map((x) => [x.id, x.name]));
  const list = data?.routines ?? [];

  return (
    <View style={{ flex: 1, backgroundColor: p.ground }}>
      <Ambient height={280} tint={st.profile?.color} />
      <ScrollView
        contentContainerStyle={{ paddingTop: insets.top, paddingBottom: insets.bottom + space.xxxl }}
        refreshControl={<RefreshControl refreshing={loading && !!data} onRefresh={load} tintColor={p.lamp} colors={[p.lamp]} progressBackgroundColor={p.raised} />}
      >
        <TopBar back title="Routines" />
        <OfflineBanner style={{ marginBottom: space.s }} />
        <T v="body" c={p.ink2} style={{ paddingHorizontal: space.l }}>
          {list.length
            ? `${list.filter((r) => r.enabled && !r.paused).length} of ${list.length} on. Write, turn on and run routines on your computer.`
            : 'Routines are jobs Aurora does on a schedule, like a Work brief every weekday at 7:30.'}
        </T>
        {data && !data.aiReady && list.some((r) => r.enabled) ? (
          <View style={[styles.note, { borderColor: p.warn + '55', backgroundColor: p.surface }]}>
            <T v="meta" c={p.warn}>{data.aiReason ?? 'The AI is not set up on your computer, so routines cannot run.'}</T>
          </View>
        ) : null}

        {error && !data ? (
          <View style={{ padding: space.l }}>
            <T v="title">Cannot load routines</T>
            <T v="body" c={p.ink2} style={{ marginTop: space.s }}>{error}</T>
          </View>
        ) : null}

        {data && !list.length && (
          <View style={[styles.card, { borderColor: p.line, backgroundColor: p.surface }]}>
            <Icon name="clock" color={p.lamp} size={26} />
            <T v="headline" style={{ marginTop: space.s }}>No routines yet</T>
            <T v="body" c={p.ink2} style={{ marginTop: 4 }}>On your computer, open Routines and describe one in a sentence. It shows up here with what it did last.</T>
          </View>
        )}

        {list.map((r) => {
          const s = state(r, p);
          const last = r.lastRun;
          const where = r.profile ? names[r.profile] ?? 'a profile' : 'All profiles';
          return (
            <View key={r.id} style={[styles.card, { borderColor: p.line, backgroundColor: p.surface, opacity: r.enabled ? 1 : 0.78 }]}>
              <View style={styles.head}>
                <T v="headline" style={{ flex: 1 }} lines={2}>{r.name}</T>
                <View style={[styles.pill, { borderColor: s.color + '66', backgroundColor: s.color + '1a' }]}>
                  <T v="label" c={s.color}>{s.label}</T>
                </View>
              </View>
              <T v="mono" c={p.ink3} style={{ marginTop: 4 }} lines={2}>{`${r.when} · ${where}`}</T>
              {r.paused ? <T v="meta" c={p.warn} style={{ marginTop: space.s }}>{r.paused}</T> : null}
              {r.nextRunAt && !r.running ? <T v="meta" c={p.ink2} style={{ marginTop: space.s }}>{`Next run ${nextLabel(r.nextRunAt)}`}</T> : null}

              {last ? (
                <View style={[styles.last, { borderTopColor: p.line }]}>
                  <T v="over">{`Last run · ${last.status === 'ok' ? 'done' : last.status} · ${since(last.finishedAt ?? last.startedAt)}`}</T>
                  {last.status === 'error' && last.error ? <T v="meta" c={p.warn} style={{ marginTop: space.s }}>{last.error}</T> : null}
                  {last.summary ? (
                    <View style={{ marginTop: space.s }}>
                      <RichText text={last.summary} byId={st.byId} size={15} />
                      <CitedRow ids={citedIds(last.summary)} byId={st.byId} />
                    </View>
                  ) : null}
                </View>
              ) : (
                <T v="meta" c={p.ink3} style={{ marginTop: space.s }}>Not run yet.</T>
              )}
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { marginHorizontal: space.l, marginTop: space.m, borderRadius: radius.card - 4, borderWidth: 1, padding: space.l },
  note: { marginHorizontal: space.l, marginTop: space.m, borderRadius: 18, borderWidth: 1, padding: space.m },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: space.s },
  pill: { borderRadius: 999, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 3 },
  last: { marginTop: space.l, paddingTop: space.m, borderTopWidth: StyleSheet.hairlineWidth },
});
