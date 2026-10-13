// Your week, on the phone: a read-only, scrolling version of the weekly recap computed on the
// computer. Writing the paragraph and sharing stay on the computer; the phone only reads.
import { useCallback, useEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api, type WeekPayload } from '../src/api';
import { useStore } from '../src/store';
import { radius, serif, space, usePalette } from '../src/theme';
import { Ambient, LitText, T, TopBar } from '../src/ui';

const DAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

function label(startIso: string): string {
  const a = new Date(startIso);
  const b = new Date(a);
  b.setDate(b.getDate() + 6);
  const m = (d: Date) => d.toLocaleDateString(undefined, { month: 'short' });
  return a.getMonth() === b.getMonth() ? `${m(a)} ${a.getDate()} to ${b.getDate()}` : `${m(a)} ${a.getDate()} to ${m(b)} ${b.getDate()}`;
}

/** The story paragraph without its [[post:ID]] markers. */
const plain = (text: string) => text.replace(/\s*\[\[post:[^\]]+\]\]/g, '');

export default function Week() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const st = useStore();
  const [data, setData] = useState<WeekPayload | null>(null);
  const [week, setWeek] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const profile = st.profile?.id ?? 'all';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.week(profile, week));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [profile, week]);
  useEffect(() => { void load(); }, [load]);

  const s = data?.stats;
  const max = s ? Math.max(1, ...s.days) : 1;
  return (
    <View style={{ flex: 1, backgroundColor: p.ground }}>
      <Ambient height={360} tint={st.profile?.color} />
      <ScrollView
        contentContainerStyle={{ paddingTop: insets.top, paddingBottom: insets.bottom + space.xxxl }}
        refreshControl={<RefreshControl refreshing={loading && !!data} onRefresh={load} tintColor={p.lamp} colors={[p.lamp]} progressBackgroundColor={p.raised} />}
      >
        <TopBar back title="Your week" />
        {error && !data ? (
          <View style={{ padding: space.l }}>
            <T v="title">Cannot load your week</T>
            <T v="body" c={p.ink2} style={{ marginTop: space.s }}>{error}</T>
          </View>
        ) : null}
        {data && s && (
          <View style={{ paddingHorizontal: space.l }}>
            <T v="over" style={{ marginTop: space.s }}>{label(s.start)}</T>
            <T v="hero" lines={3} style={{ marginTop: space.s }}>{data.story?.title ?? (s.quiet ? 'A quiet week' : 'Your week')}</T>

            <Text style={[styles.giant, { color: p.ink }]}>
              <LitText style={styles.giant}>{String(s.read)}</LitText>
            </Text>
            <T v="headline">{s.read === 1 ? 'post read' : 'posts read'}</T>
            <View style={styles.days}>
              {s.days.map((n, i) => (
                <View key={i} style={{ alignItems: 'center', flex: 1 }}>
                  <View style={{ height: 56, justifyContent: 'flex-end', width: '70%' }}>
                    <View style={{ height: Math.max(6, (n / max) * 56), borderRadius: 6, backgroundColor: n === max && n > 0 ? p.lamp : p.raised }} />
                  </View>
                  <T v="mono" c={p.ink3} style={{ marginTop: 4 }}>{DAYS[i]}</T>
                </View>
              ))}
            </View>

            <View style={styles.grid}>
              <Stat n={s.minutes} label="minutes in articles" />
              <Stat n={s.saved} label="saved" />
              <Stat n={s.setAside} label="set aside for you" />
              <Stat n={s.highlights} label="highlights" />
            </View>

            {s.people.length > 0 && (
              <>
                <T v="over" style={{ marginTop: space.xxl, marginBottom: space.s }}>Who you spent it with</T>
                {s.people.slice(0, 5).map((x, i) => (
                  <View key={x.key} style={[styles.row, { borderColor: p.line, backgroundColor: p.surface }]}>
                    <T v="mono" c={p.ink3} style={{ width: 22 }}>{String(i + 1)}</T>
                    <T v="bodyStrong" lines={1} style={{ flex: 1 }}>{x.name}</T>
                    <T v="mono" c={p.ink3}>{String(x.count)}</T>
                  </View>
                ))}
              </>
            )}

            {s.topic && (
              <>
                <T v="over" style={{ marginTop: space.xxl }}>{s.topic.count > s.topic.before ? 'On the rise' : 'Holding steady'}</T>
                <T v="display" style={{ marginTop: 4 }}>{s.topic.name}</T>
                <T v="meta" c={p.ink2}>{`${s.topic.count} this week, ${s.topic.before} the week before`}</T>
              </>
            )}

            {s.best && (
              <Pressable
                onPress={() => router.push({ pathname: '/post/[id]', params: { id: s.best!.itemId } })}
                accessibilityRole="link"
                style={({ pressed }) => [styles.best, { borderColor: p.line, backgroundColor: p.surface }, pressed && { transform: [{ scale: 0.985 }] }]}
              >
                <T v="over">The best thing you read</T>
                <Text style={{ color: p.ink, fontFamily: serif, fontSize: 22, lineHeight: 28, fontWeight: '600', marginTop: 6 }}>{s.best.title}</Text>
                <T v="meta" c={p.ink3} style={{ marginTop: 4 }} lines={1}>{[s.best.author, s.best.minutes ? `${s.best.minutes} min` : null].filter(Boolean).join(' · ')}</T>
                {s.best.highlight && <Text style={{ color: p.ink2, fontFamily: serif, fontStyle: 'italic', fontSize: 16, lineHeight: 23, marginTop: space.m }}>{`“${s.best.highlight.quote}”`}</Text>}
              </Pressable>
            )}

            {data.story && (
              <>
                <T v="over" style={{ marginTop: space.xxl }}>In your words</T>
                <Text style={{ color: p.ink, fontFamily: serif, fontSize: 19, lineHeight: 29, marginTop: space.s }} selectable>{plain(data.story.text)}</Text>
              </>
            )}

            {data.weeks.length > 1 && (
              <>
                <T v="over" style={{ marginTop: space.xxl, marginBottom: space.s }}>Earlier weeks</T>
                <View style={styles.weeks}>
                  {data.weeks.slice(0, 12).map((w) => (
                    <Pressable key={w.id} onPress={() => setWeek(w.id)} style={[styles.chip, { borderColor: w.id === s.weekId ? p.lamp : p.line, backgroundColor: p.surface }]}>
                      <T v="label" c={w.id === s.weekId ? p.ink : p.ink2}>{w.start ? label(w.start) : w.id}</T>
                    </Pressable>
                  ))}
                </View>
              </>
            )}
            <T v="meta" c={p.ink3} style={{ marginTop: space.xl }}>Save or share the picture from Your week on your computer.</T>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function Stat({ n, label: text }: { n: number; label: string }) {
  const p = usePalette();
  return (
    <View style={[styles.stat, { borderColor: p.line, backgroundColor: p.surface }]}>
      <T v="display">{String(n)}</T>
      <T v="meta" c={p.ink2}>{text}</T>
    </View>
  );
}

const styles = StyleSheet.create({
  giant: { fontSize: 112, lineHeight: 116, fontWeight: '800', letterSpacing: -6, marginTop: space.xl },
  days: { flexDirection: 'row', marginTop: space.l },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s, marginTop: space.l },
  stat: { width: '48%', flexGrow: 1, padding: space.m, borderRadius: radius.card - 6, borderWidth: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.s, padding: space.m, borderRadius: 16, borderWidth: 1, marginTop: space.s },
  best: { marginTop: space.xxl, padding: space.l, borderRadius: radius.card - 4, borderWidth: 1 },
  weeks: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s },
  chip: { paddingHorizontal: space.m, paddingVertical: 8, borderRadius: 999, borderWidth: 1 },
});
