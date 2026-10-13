// Today: On this day (when there are memories), the morning edition with Listen, then the
// user's pages.
import { useMemo, useState } from 'react';
import { Platform, RefreshControl, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { DEFAULT_SPEC } from '../../../core/filter.ts';
import { editionId } from '../../../core/profiles.ts';
import type { Page } from '../../../core/types.ts';
import { api } from '../../src/api';
import { Blocks } from '../../src/Blocks';
import { OnThisDay } from '../../src/OnThisDay';
import { Icon } from '../../src/Icon';
import { speaker, usePlaying } from '../../src/listen';
import { ago, readMinutes, usePull, useStore } from '../../src/store';
import { TAB_HEIGHT } from '../../src/TabBar';
import { font, radius, space, usePalette } from '../../src/theme';
import { Ambient, Button, IconButton, Orb, T, TopBar } from '../../src/ui';
import * as haptics from '../../src/haptics';


/** Everything an edition says, in reading order, for Listen. */
export function editionScript(page: Page): string {
  return page.blocks
    .map((b) => (b.type === 'hero' ? `${b.title}. ${b.subtitle ?? ''}` : b.type === 'digest' || b.type === 'note' ? `${b.title ? `${b.title}. ` : ''}${b.text}` : ''))
    .filter(Boolean)
    .join('\n\n');
}

export default function Today() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const st = useStore();
  const pull = usePull();
  const playing = usePlaying();
  const [writing, setWriting] = useState(false);
  const floating = Platform.OS === 'ios' ? insets.bottom + TAB_HEIGHT : 0;
  // Each profile has its own edition (morning-edition--<profile>); All has the plain one.
  const EDITION_ID = editionId(st.profileId);
  const edition = st.lib?.pages?.find((x) => x.id === EDITION_ID) ?? null;
  const pages = (st.lib?.pages ?? []).filter((x) => !x.id.startsWith('morning-edition'));
  const hero = edition?.blocks.find((b) => b.type === 'hero') as { title: string; subtitle?: string } | undefined;
  const script = edition ? editionScript(edition) : '';
  const minutes = readMinutes(script);
  const postCount = useMemo(() => new Set(edition?.blocks.flatMap((b) => (b.type === 'digest' ? b.postIds ?? [] : [])) ?? []).size, [edition]);

  const write = async () => {
    setWriting(true);
    try {
      await api.edition(st.profileId);
      haptics.success();
      await st.refresh();
    } catch (e) {
      haptics.reject();
      st.notify((e as Error).message);
    } finally {
      setWriting(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: p.ground }}>
      <Ambient height={300} tint={st.profile?.color} />
      <ScrollView
        contentContainerStyle={{ paddingTop: insets.top, paddingBottom: floating + space.xxl }}
        refreshControl={<RefreshControl refreshing={pull.on} onRefresh={pull.run} tintColor={p.lamp} colors={[p.lamp]} progressBackgroundColor={p.raised} />}
      >
        <TopBar title={st.profile ? `Today · ${st.profile.name}` : 'Today'} right={<IconButton name="sync" label={writing ? 'Writing the edition' : 'Write a new edition'} onPress={write} active={writing} />} />

        <OnThisDay />

        {edition && hero ? (
          <View style={[styles.hero, { borderColor: p.line }]}>
            <LinearGradient colors={p.mode === 'dark' ? ['#16233f', '#2a2b4a', '#4a2a35', '#0c1222'] : ['#d9e4f7', '#efd8e4', '#f7dcc8', '#e6ecf7']} locations={[0, 0.38, 0.62, 1]} style={StyleSheet.absoluteFill} />
            <Orb color="#ff9a5c" size={70} opacity={p.mode === 'dark' ? 0.55 : 0.35} style={{ top: 120, left: '42%' }} />
            <T v="mono" c={p.mode === 'dark' ? '#cfd6e6' : '#3d4350'}>{`Morning edition · ${postCount ? `from ${postCount} posts` : ago(edition.updatedAt) + ' ago'}`}</T>
            <T v="display" c={p.mode === 'dark' ? '#ffffff' : '#0b0d12'} style={{ marginTop: 88 }}>{hero.title}</T>
            {hero.subtitle ? <T v="body" c={p.mode === 'dark' ? '#dfe4ee' : '#2b303b'} style={{ marginTop: space.m }}>{hero.subtitle}</T> : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={playing === EDITION_ID ? 'Stop listening' : `Listen, ${minutes} minutes`}
              onPress={() => { haptics.tick(); speaker.toggle(EDITION_ID, script); }}
              style={({ pressed }) => [styles.listen, pressed && { transform: [{ scale: 0.97 }] }]}
            >
              <View style={styles.listenIcon}><Icon name={playing === EDITION_ID ? 'stop' : 'play'} color="#ffffff" size={20} /></View>
              <T v="label" c="#0b0d12" style={{ fontFamily: font.semibold, fontSize: 16, marginLeft: 10 }}>{playing === EDITION_ID ? 'Stop' : `Listen · ${minutes} min`}</T>
            </Pressable>
          </View>
        ) : (
          <View style={[styles.hero, { borderColor: p.line, backgroundColor: p.surface }]}>
            <T v="mono">Morning edition</T>
            <T v="display" style={{ marginTop: space.xl }}>No edition yet today</T>
            <T v="body" c={p.ink2} style={{ marginTop: space.s }}>Your agent reads the last day of posts and writes a short edition with the posts it used.</T>
            <View style={{ marginTop: space.xl, alignSelf: 'flex-start' }}>
              <Button label={writing ? 'Writing' : 'Write today’s edition'} onPress={write} disabled={writing} />
            </View>
          </View>
        )}

        {edition && <Blocks blocks={edition.blocks.filter((b) => b.type !== 'gallery' && b.type !== 'stats')} skipHero />}

        {pages.length > 0 && (
          <View style={{ marginTop: space.xxl }}>
            <T v="over" style={{ paddingHorizontal: space.l }}>Your pages</T>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: space.l, paddingTop: space.m }}>
              {pages.map((pg) => <PageCard key={pg.id} page={pg} />)}
            </ScrollView>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function PageCard({ page }: { page: Page }) {
  const p = usePalette();
  const st = useStore();
  const fresh = useMemo(() => {
    const feed = page.blocks.find((b) => b.type === 'feed' || b.type === 'gallery') as { spec: object } | undefined;
    if (!feed) return null;
    return st.evaluate({ ...DEFAULT_SPEC, ...feed.spec, read: 'unread' })?.visible.length ?? 0;
  }, [page, st.evaluate]);
  return (
    <Pressable onPress={() => router.push({ pathname: '/page/[id]', params: { id: page.id } })} style={({ pressed }) => [styles.pageCard, { backgroundColor: p.surface, borderColor: p.line }, pressed && { transform: [{ scale: 0.98 }] }]} accessibilityRole="link">
      <T v="headline" lines={2}>{page.name}</T>
      <T v="mono" style={{ marginTop: 'auto' }}>{fresh === null ? `${page.blocks.length} blocks` : `${fresh} new`}</T>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  hero: { marginHorizontal: space.l, marginTop: space.s, borderRadius: 32, borderWidth: 1, padding: space.xl, overflow: 'hidden' },
  listen: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', marginTop: space.xl, backgroundColor: '#ffffff', borderRadius: radius.chip, paddingLeft: 8, paddingRight: 22, height: 56 },
  listenIcon: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#0b0d12', alignItems: 'center', justifyContent: 'center' },
  pageCard: { width: 168, height: 104, borderRadius: 22, borderWidth: 1, padding: space.l, marginRight: space.m },
});
