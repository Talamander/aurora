// Source report cards: which sources earn their place in this profile, from what you read, saved,
// highlighted and hid over the last 30 days. Worked out on the phone from the saved library
// (core/sourceReport.ts, the desktop's own code), so it works offline too. No AI. Read-only:
// pausing, muting and moving sources happen on the computer.
import { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { sourceReports, type SourceReport, type Verdict } from '../../core/sourceReport.ts';
import { useMarks } from '../src/marks';
import { OfflineBanner } from '../src/Offline';
import { useStore } from '../src/store';
import { radius, space, usePalette, type Palette } from '../src/theme';
import { Ambient, Chip, T, TopBar } from '../src/ui';

const VERDICT: Record<Verdict, string> = { 'let-go': 'Let go', quieter: 'Quieter', keep: 'Keep', new: 'New' };

function tone(v: Verdict, p: Palette): string {
  return v === 'let-go' ? p.warn : v === 'quieter' ? p.lamp : v === 'keep' ? p.on : p.ink3;
}

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);

export default function Report() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const st = useStore();
  const marks = useMarks();
  const [reports, setReports] = useState<SourceReport[] | null>(null);
  const [worth, setWorth] = useState(false);

  // One pass over the 30-day window, a moment after the screen appears so it opens at once.
  useEffect(() => {
    const lib = st.lib;
    if (!lib || !marks) return;
    const t = setTimeout(() => {
      setReports(sourceReports({
        items: lib.items,
        sources: lib.sources,
        ctx: { topics: lib.topics, ai: { rules: lib.aiRules, labels: lib.labels } },
        highlighted: new Set(marks.highlights.map((h) => h.itemId)),
        alertHits: new Set(marks.hits),
      }));
    }, 60);
    return () => clearTimeout(t);
  }, [st.lib, marks]);

  const shown = useMemo(() => (reports ?? []).filter((r) => !worth || r.verdict === 'let-go' || r.verdict === 'quieter'), [reports, worth]);
  const look = (reports ?? []).filter((r) => r.verdict === 'let-go' || r.verdict === 'quieter').length;

  return (
    <View style={{ flex: 1, backgroundColor: p.ground }}>
      <Ambient height={280} tint={st.profile?.color} />
      <ScrollView contentContainerStyle={{ paddingTop: insets.top, paddingBottom: insets.bottom + space.xxxl }}>
        <TopBar back title="Report cards" />
        <OfflineBanner style={{ marginBottom: space.s }} />
        <T v="body" c={p.ink2} style={{ paddingHorizontal: space.l }}>
          {`The last 30 days of every source${st.profile ? ` in ${st.profile.name}` : ''}: what you read, saved, highlighted and hid. Worked out on this phone, no AI.`}
        </T>
        {reports && reports.length > 0 && (
          <View style={styles.chips}>
            <Chip label="All sources" count={reports.length} on={!worth} onPress={() => setWorth(false)} />
            <Chip label="Worth a look" count={look} on={worth} onPress={() => setWorth(true)} />
          </View>
        )}

        {!reports ? (
          <T v="mono" c={p.ink3} style={{ padding: space.l }}>Counting…</T>
        ) : !shown.length ? (
          <View style={[styles.card, { borderColor: p.line, backgroundColor: p.surface }]}>
            <T v="headline">{worth ? 'Every source earns its place' : 'No sources here'}</T>
            <T v="body" c={p.ink2} style={{ marginTop: 4 }}>{worth ? 'Nothing is busy and rarely kept right now.' : 'Add sources on your computer.'}</T>
          </View>
        ) : (
          shown.map((r) => <Card key={r.sourceId} r={r} />)
        )}

        <T v="meta" c={p.ink3} style={{ paddingHorizontal: space.l, marginTop: space.xl }}>
          A verdict is a nudge, never an action. Pause, mute or move a source on your computer. Aurora never changes anything on the source site.
        </T>
      </ScrollView>
    </View>
  );
}

function Card({ r }: { r: SourceReport }) {
  const p = usePalette();
  const c = tone(r.verdict, p);
  const stats = [
    `${r.perDay} a day`,
    `${r.read} read`,
    `${r.saved} saved`,
    r.highlighted ? `${r.highlighted} highlighted` : '',
    r.laterDone + r.laterOpen ? `read later ${r.laterDone}/${r.laterDone + r.laterOpen}` : '',
    r.alertHits ? `${r.alertHits} alerts` : '',
    `${r.hidden} you hid`,
    `rules hid ${pct(r.rulesHid, r.posts)}%`,
  ].filter(Boolean);
  return (
    <View style={[styles.card, { borderColor: p.line, backgroundColor: p.surface }]} accessible accessibilityLabel={`${r.label}: ${VERDICT[r.verdict]}. ${r.reason} ${stats.join(', ')}.`}>
      <View style={styles.head}>
        <T v="headline" style={{ flex: 1 }} lines={2}>{r.label}</T>
        <View style={[styles.pill, { borderColor: c + '66', backgroundColor: c + '1a' }]}>
          <T v="label" c={c}>{VERDICT[r.verdict]}</T>
        </View>
      </View>
      <T v="body" c={p.ink2} style={{ marginTop: space.s }}>{r.reason}</T>
      <Spark daily={r.daily} />
      <T v="mono" c={p.ink3} style={{ marginTop: space.s }}>{stats.join(' · ')}</T>
    </View>
  );
}

/** Daily volume as grey bars with what you read laid over them in the lamp colour. */
function Spark({ daily }: { daily: SourceReport['daily'] }) {
  const p = usePalette();
  const max = Math.max(1, ...daily.posts);
  return (
    <View style={styles.spark} importantForAccessibility="no-hide-descendants">
      {daily.posts.map((n, i) => (
        <View key={i} style={styles.col}>
          <View style={{ height: `${(n / max) * 100}%`, backgroundColor: p.ink3, opacity: 0.28, borderRadius: 2 }} />
          <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: `${(daily.read[i] / max) * 100}%`, backgroundColor: p.lamp, borderRadius: 2 }} />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', gap: space.s, paddingHorizontal: space.l, marginTop: space.l },
  card: { marginHorizontal: space.l, marginTop: space.m, borderRadius: radius.card - 4, borderWidth: 1, padding: space.l },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: space.s },
  pill: { borderRadius: 999, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 3 },
  spark: { flexDirection: 'row', alignItems: 'flex-end', height: 36, gap: 2, marginTop: space.m },
  col: { flex: 1, height: '100%', justifyContent: 'flex-end' },
});
