// Alerts on the phone: what your "tell me when…" watches caught. Read-only here; alerts are made
// and changed on the computer (or by asking the AI). Opening this screen marks hits seen.
import { useCallback, useEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api, type AlertHit } from '../src/api';
import { Icon } from '../src/Icon';
import { imgProxyReady, imgSource } from '../src/images';
import { ago, useStore } from '../src/store';
import { radius, space, usePalette } from '../src/theme';
import { Ambient, LitText, T, TopBar } from '../src/ui';

export default function Alerts() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const st = useStore();
  const [data, setData] = useState<{ unseen: number; quietNow: boolean; hits: AlertHit[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      await imgProxyReady();
      setData(await api.alertHits());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => st.subscribe((e) => { if (e.type === 'ui' && (e.action as { kind?: string })?.kind === 'alert') void load(); }), [st.subscribe, load]);
  useEffect(() => {
    if (!data?.unseen) return;
    const t = setTimeout(() => void api.alertsSeen().catch(() => {}), 1500);
    return () => clearTimeout(t);
  }, [data?.unseen]);

  const hits = data?.hits.filter((h) => h.item) ?? [];
  return (
    <View style={{ flex: 1, backgroundColor: p.ground }}>
      <Ambient height={280} tint={st.profile?.color} />
      <ScrollView
        contentContainerStyle={{ paddingTop: insets.top, paddingBottom: insets.bottom + space.xxxl }}
        refreshControl={<RefreshControl refreshing={loading && !!data} onRefresh={load} tintColor={p.lamp} colors={[p.lamp]} progressBackgroundColor={p.raised} />}
      >
        <TopBar back title="Alerts" />
        <View style={{ paddingHorizontal: space.l, marginTop: space.s }}>
          <T v="hero" lines={2}>
            <LitText>{String(data?.unseen ?? 0)}</LitText>
            <T v="hero" c={p.ink}>{data?.unseen === 1 ? ' new alert' : ' new alerts'}</T>
          </T>
          <T v="mono" c={p.ink3} style={{ marginTop: 6 }}>{data?.quietNow ? 'quiet hours · collecting silently' : 'make or change alerts on your computer'}</T>
        </View>

        {error && !data ? (
          <View style={{ padding: space.l }}>
            <T v="title">Cannot load alerts</T>
            <T v="body" c={p.ink2} style={{ marginTop: space.s }}>{error}</T>
          </View>
        ) : null}

        {data && !hits.length && (
          <View style={[styles.empty, { borderColor: p.line, backgroundColor: p.surface }]}>
            <Icon name="bell" color={p.lamp} size={26} />
            <T v="headline" style={{ marginTop: space.s }}>Nothing caught yet</T>
            <T v="body" c={p.ink2} style={{ marginTop: 4 }}>Ask the AI “tell me when…” and matching posts land here after each sync.</T>
          </View>
        )}

        {hits.map((h) => (
          <Pressable
            key={h.id}
            onPress={() => (st.byId.has(h.itemId) ? router.push({ pathname: '/post/[id]', params: { id: h.itemId } }) : st.notify('That post is not in this profile'))}
            accessibilityRole="link"
            accessibilityLabel={`${h.alertName}: ${h.item!.author}, ${h.item!.text}`}
            style={({ pressed }) => [styles.row, { backgroundColor: p.surface, borderColor: h.seen ? p.line : p.lamp }, pressed && { transform: [{ scale: 0.985 }] }]}
          >
            {h.item!.avatar ? <Image source={imgSource(h.item!.avatar)} style={styles.av} contentFit="cover" cachePolicy="memory-disk" /> : <View style={[styles.av, { backgroundColor: p.raised }]} />}
            <View style={{ flex: 1 }}>
              <T v="mono" c={p.lamp} lines={1}>{`${h.alertName} · ${ago(h.at)}`}</T>
              <T v="headline" lines={1} style={{ marginTop: 4 }}>{h.item!.author}</T>
              <T v="body" c={p.ink2} lines={2} style={{ marginTop: 2 }}>{h.item!.text}</T>
              {h.reason ? <T v="meta" c={p.ink3} lines={1} style={{ marginTop: 4 }}>{h.reason}</T> : null}
            </View>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: space.m, marginHorizontal: space.l, marginTop: space.m, padding: space.l, borderRadius: radius.card - 4, borderWidth: 1 },
  av: { width: 40, height: 40, borderRadius: 20 },
  empty: { marginHorizontal: space.l, marginTop: space.xl, borderRadius: 22, borderWidth: 1, padding: space.l },
});
