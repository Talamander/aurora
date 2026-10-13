// A person: everything you have from them, across platforms, and one line on what they post.
import { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { DEFAULT_SPEC, type Evaluation } from '../../../core/filter.ts';
import { api } from '../../src/api';
import { PostCard } from '../../src/PostCard';
import { litBy, personKey, useStore } from '../../src/store';
import { hue, platformLabel, space, usePalette } from '../../src/theme';
import { Ambient, Avatar, T, TopBar } from '../../src/ui';

export default function Person() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const st = useStore();
  const { key } = useLocalSearchParams<{ key: string }>();
  const [about, setAbout] = useState<string | null>(null);

  const evs = useMemo<Evaluation[]>(() => {
    const r = st.evaluate({ ...DEFAULT_SPEC, archived: 'any', hideDuplicates: false });
    return (r?.visible ?? []).filter((e) => personKey(e.item) === key);
  }, [st.evaluate, key]);
  const first = evs[0]?.item;
  const platforms = [...new Set(evs.map((e) => e.item.platform))];
  const saved = evs.filter((e) => e.item.state.saved).length;
  const month = evs.filter((e) => Date.now() - Date.parse(e.item.publishedAt) < 30 * 864e5).length;

  useEffect(() => {
    if (!key || !evs.length) return;
    let live = true;
    api.personAbout(key, evs.slice(0, 40).map((e) => e.item.id)).then((x) => live && setAbout(x.about || null)).catch(() => {});
    return () => { live = false; };
  }, [key, evs.length]);

  const header = (
    <View>
      <View style={{ paddingTop: insets.top }}><TopBar back /></View>
      {first && (
        <View style={{ paddingHorizontal: space.l, paddingBottom: space.xl }}>
          <Avatar name={first.author.name} uri={first.author.avatar} color={hue(first.platform, p)} size={72} />
          <T v="display" style={{ marginTop: space.l }}>{first.author.name}</T>
          <T v="mono" style={{ marginTop: 4 }}>{[first.author.handle, platforms.map(platformLabel).join(' · ')].filter(Boolean).join(' · ')}</T>
          <T v="body" c={p.ink2} style={{ marginTop: space.l }}>
            {`${month} ${month === 1 ? 'post' : 'posts'} this month · ${saved} saved`}
          </T>
          {about ? <T v="body" style={{ marginTop: space.m }}>{about}</T> : null}
        </View>
      )}
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: p.ground }}>
      <Ambient height={300} />
      <FlashList
        data={evs}
        keyExtractor={(e) => e.item.id}
        ListHeaderComponent={header}
        ListEmptyComponent={<T v="body" c={p.ink2} style={{ padding: space.l }}>No posts from this person are in your library.</T>}
        renderItem={({ item: ev }) => <PostCard item={ev.item} why={litBy(ev, st.sourceLabels)} source={st.sourceLabels[ev.item.sourceId] ?? ev.item.platform} p={p} onSave={st.save} onHide={st.hide} />}
        contentContainerStyle={{ paddingBottom: insets.bottom + space.xxl }}
      />
    </View>
  );
}
