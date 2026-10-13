// Search: every post on the computer, ranked there (BM25, server/search.ts), scoped to the
// phone's profile. Snippets come back as plain text with match ranges and are lit here. Offline,
// the phone searches the posts it saved instead.
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Snippet } from '../../core/search.ts';
import { api, isOffline } from '../src/api';
import { Icon } from '../src/Icon';
import { OfflineBanner } from '../src/Offline';
import { Highlighted, searchLocal } from '../src/Snippet';
import { ago, useStore } from '../src/store';
import { font, hue, platformLabel, radius, space, usePalette } from '../src/theme';
import { Ambient, PlatformDot, T, TopBar } from '../src/ui';

type Found = { id: string; snippet: Snippet };
type State = { query: string; hits: Found[]; note: string; local: boolean } | null;

export default function Search() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const st = useStore();
  const [q, setQ] = useState('');
  const [res, setRes] = useState<State>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const query = q.trim();
    if (!query) { setRes(null); setBusy(false); return; }
    const n = ++seq.current;
    const local = (why: string) => {
      const hits = searchLocal(st.lib?.items ?? [], query);
      setRes({ query, hits, note: `${hits.length} ${hits.length === 1 ? 'match' : 'matches'} in what you had · ${why}`, local: true });
    };
    const t = setTimeout(async () => {
      if (st.offline) { local('offline'); return; }
      setBusy(true);
      try {
        const r = await api.search(query, st.profileId);
        if (n !== seq.current) return;
        if (r.unsupported) { setRes({ query, hits: [], note: r.unsupported, local: false }); return; }
        const building = r.index.building ? ` · still indexing ${r.index.indexed.toLocaleString()} of ${r.index.total.toLocaleString()}` : '';
        setRes({ query, hits: r.results, note: `${r.matched.toLocaleString()} ${r.matched === 1 ? 'match' : 'matches'} · ${r.ms} ms${building}`, local: false });
      } catch (e) {
        if (n !== seq.current) return;
        if (isOffline(e)) local('offline');
        else setRes({ query, hits: [], note: (e as Error).message, local: false });
      } finally {
        if (n === seq.current) setBusy(false);
      }
    }, 220);
    return () => clearTimeout(t);
  }, [q, st.profileId, st.offline]);

  // Only posts the phone can open: the active profile's, still in the library.
  const hits = (res?.hits ?? []).filter((h) => st.byId.has(h.id));

  return (
    <View style={{ flex: 1, backgroundColor: p.ground }}>
      <Ambient height={240} tint={st.profile?.color} />
      <View style={{ paddingTop: insets.top }}>
        <TopBar back title="Search" />
        <View style={[styles.field, { backgroundColor: p.raised, borderColor: p.line }]}>
          <Icon name="search" color={p.ink3} size={20} />
          <TextInput
            value={q}
            onChangeText={setQ}
            autoFocus
            placeholder={`Search ${(st.lib?.items.length ?? 0).toLocaleString()} posts`}
            placeholderTextColor={p.ink3}
            returnKeyType="search"
            autoCorrect={false}
            autoCapitalize="none"
            style={[styles.input, { color: p.ink }]}
            accessibilityLabel="Search your library"
          />
          {busy ? <ActivityIndicator size="small" color={p.lamp} /> : q ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Clear" hitSlop={10} onPress={() => setQ('')}>
              <Icon name="close" color={p.ink3} size={20} />
            </Pressable>
          ) : null}
        </View>
        <OfflineBanner />
      </View>
      <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={{ paddingBottom: insets.bottom + space.xxxl }}>
        {res ? (
          <T v="mono" c={p.ink3} style={{ paddingHorizontal: space.l, marginTop: space.m }}>{res.note}</T>
        ) : (
          <View style={{ paddingHorizontal: space.l, marginTop: space.xl }}>
            <T v="title">Find anything you have seen</T>
            <T v="body" c={p.ink2} style={{ marginTop: space.s }}>
              {`Your computer searches every post${st.profile ? ` in ${st.profile.name}` : ''} and ranks the best matches first. Use quotes for a phrase, a minus sign to leave a word out, and from:name for one person.`}
            </T>
          </View>
        )}
        {res && !hits.length && !busy && res.query && (
          <T v="body" c={p.ink2} style={{ paddingHorizontal: space.l, marginTop: space.l }}>{`Nothing matches “${res.query}”.`}</T>
        )}
        {hits.map((h) => {
          const it = st.byId.get(h.id)!;
          const color = hue(it.platform, p);
          return (
            <Pressable
              key={h.id}
              onPress={() => router.push({ pathname: '/post/[id]', params: { id: h.id } })}
              accessibilityRole="link"
              accessibilityLabel={`${it.author.name}: ${h.snippet.text}`}
              style={({ pressed }) => [styles.row, { backgroundColor: p.surface, borderColor: p.line }, pressed && { transform: [{ scale: 0.985 }] }]}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <PlatformDot color={color} />
                <T v="mono" lines={1} style={{ flex: 1 }}>{`${it.author.name} · ${st.sourceLabels[it.sourceId] ?? platformLabel(it.platform)} · ${ago(it.publishedAt)}`}</T>
                {it.state.saved && <Icon name="saved" color={p.lamp} size={14} />}
              </View>
              {it.title && !h.snippet.text.startsWith(it.title) ? (
                <T v="headline" style={{ marginTop: 6, fontFamily: font.semibold }} lines={2}>{it.title}</T>
              ) : null}
              <Highlighted snippet={h.snippet} lines={4} style={{ marginTop: 6 }} />
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  field: { flexDirection: 'row', alignItems: 'center', marginHorizontal: space.l, marginTop: space.s, paddingHorizontal: space.m, minHeight: 48, borderRadius: radius.chip, borderWidth: 1, gap: 8 },
  input: { flex: 1, fontFamily: font.regular, fontSize: 16, paddingVertical: 10 },
  row: { marginHorizontal: space.l, marginTop: space.m, padding: space.l, borderRadius: radius.card - 6, borderWidth: 1 },
});
