// The feed: the hero count, lens chips, posts lit by their own pictures, and the agent composer.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Evaluation } from '../../../core/filter.ts';
import { collapseThreads, threadFor } from '../../../core/threads.ts';
import { api } from '../../src/api';
import { triageDeck } from '../../../core/triage.ts';
import { Icon } from '../../src/Icon';
import { PostCard } from '../../src/PostCard';
import { ago, litBy, useStore } from '../../src/store';
import { TAB_HEIGHT } from '../../src/TabBar';
import { font, space, usePalette } from '../../src/theme';
import { Ambient, Button, Chip, Composer, IconButton, LitText, ReceiptBar, T } from '../../src/ui';
import { ProfileTitle } from '../../src/Profiles';
import { OfflineBanner } from '../../src/Offline';
import * as haptics from '../../src/haptics';

function heroWords(lensId: string, name: string, n: number): string {
  if (lensId === 'worth') return 'worth reading';
  if (lensId === 'saved') return 'saved';
  if (lensId === 'everything') return n === 1 ? 'post' : 'posts';
  return `in ${name}`;
}

export default function Feed() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const st = useStore();
  const [syncing, setSyncing] = useState(false);
  const floating = Platform.OS === 'ios' ? insets.bottom + TAB_HEIGHT - 12 : 0;

  const lens = st.lenses.find((l) => l.id === st.lensId) ?? st.lenses[0];
  // Each thread shows once, as its first post (core/threads.ts).
  const visible = useMemo(() => {
    const v = st.result?.visible ?? [];
    return st.threads ? collapseThreads(v, st.threads) : v;
  }, [st.result, st.threads]);
  // New posts in this view that Triage would offer (unread, not hidden, not already queued).
  const fresh = useMemo(() => triageDeck(visible.map((e) => e.item)).length, [visible]);
  const lastSync = useMemo(() => {
    const t = (st.lib?.sources ?? []).map((s) => s.lastSyncAt).filter(Boolean).sort().pop();
    return t ? `synced ${ago(t)} ago`.replace('now ago', 'just now') : 'not synced yet';
  }, [st.lib?.sources]);
  const sourceCount = (st.lib?.sources ?? []).filter((s) => s.enabled).length;
  const now = new Date();
  const stamp = `${now.toLocaleDateString(undefined, { weekday: 'short' })} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  const sync = useCallback(async () => {
    setSyncing(true);
    haptics.tick();
    try {
      // Offline, a pull only looks for the computer again.
      if (st.offline) { await st.refresh(); return; }
      await api.sync();
      await st.refresh();
      haptics.success();
    } catch (e) {
      haptics.reject();
      st.notify((e as Error).message);
    } finally {
      setSyncing(false);
    }
  }, [st.refresh, st.notify, st.offline]);

  const renderItem = useCallback(
    ({ item: ev }: { item: Evaluation }) => (
      <PostCard item={ev.item} why={litBy(ev, st.sourceLabels)} source={st.sourceLabels[ev.item.sourceId] ?? ev.item.platform} p={p} onSave={st.save} onHide={st.hide} thread={st.threads ? threadFor(st.threads, ev.item.id) : null} />
    ),
    [p, st.sourceLabels, st.save, st.hide, st.threads],
  );

  const header = (
    <View>
      <View style={[styles.bar, { paddingTop: insets.top + 6 }]}>
        <ProfileTitle />
        <IconButton name="search" label="Search your library" onPress={() => router.push('/search')} />
        <AlertBell />
        <IconButton name="sparkle" label="Your week" onPress={() => router.push('/week')} />
        <IconButton name="later" label="Read later" onPress={() => router.push('/readlater')} />
        <IconButton name="sync" label={syncing ? 'Syncing' : 'Sync all sources'} onPress={sync} active={syncing} />
      </View>
      <OfflineBanner />
      <View style={{ paddingHorizontal: space.l, marginTop: space.m }}>
        <T v="mono" c={p.ink3}>{`${stamp} · ${sourceCount} ${sourceCount === 1 ? 'source' : 'sources'} · ${lastSync}`}</T>
        <Text2 n={lens?.n ?? 0} words={heroWords(lens?.id ?? 'worth', lens?.name ?? '', lens?.n ?? 0)} />
        {fresh > 0 && (
          <Pressable accessibilityRole="button" accessibilityLabel={`Triage ${fresh} new posts one at a time`} onPress={() => router.push('/triage')} style={({ pressed }) => [styles.triage, { backgroundColor: p.glass, borderColor: p.line }, pressed && { opacity: 0.7 }]}>
            <Icon name="triage" size={18} color={p.lamp} />
            <T v="label" style={{ marginLeft: space.s }}>{`Triage ${fresh} new`}</T>
          </Pressable>
        )}
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: space.l, paddingVertical: space.l }} accessibilityRole="tablist">
        {st.lenses.map((l) => (
          <Chip key={l.id} label={l.name} count={l.n} on={l.id === st.lensId} onPress={() => st.setLens(l.id)} />
        ))}
      </ScrollView>
    </View>
  );

  const empty = st.lib ? (
    <View style={{ padding: space.xl, alignItems: 'flex-start' }}>
      <T v="title">{st.lib.items.length ? 'Nothing left in this view' : 'No posts yet'}</T>
      <T v="body" c={p.ink2} style={{ marginTop: space.s }}>
        {st.lib.items.length
          ? `${st.result?.hidden.length ?? 0} posts are set aside by this view. Everything shows all of them.`
          : 'Add a source on your computer: Sources, then Add. Posts arrive here as soon as it syncs.'}
      </T>
      {st.lib.items.length > 0 && st.lensId !== 'everything' && (
        <View style={{ marginTop: space.l }}><Button kind="quiet" label="Show everything" onPress={() => st.setLens('everything')} /></View>
      )}
    </View>
  ) : st.error ? (
    <View style={{ padding: space.xl }}>
      <T v="title">Cannot reach your computer</T>
      <T v="body" c={p.ink2} style={{ marginTop: space.s }}>{st.error}</T>
      <View style={{ marginTop: space.l, alignSelf: 'flex-start' }}><Button kind="quiet" label="Try again" onPress={() => void st.refresh()} /></View>
    </View>
  ) : null;

  return (
    <View style={{ flex: 1, backgroundColor: p.ground }}>
      <Ambient height={360} tint={st.profile?.color} />
      <FlashList
        data={visible}
        renderItem={renderItem}
        keyExtractor={(ev) => ev.item.id}
        getItemType={(ev) => (ev.item.media.length ? 'media' : 'text')}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        contentContainerStyle={{ paddingBottom: floating + 104 }}
        refreshControl={<RefreshControl refreshing={syncing} onRefresh={sync} tintColor={p.lamp} colors={[p.lamp]} progressBackgroundColor={p.raised} />}
        showsVerticalScrollIndicator={false}
      />
      {st.receipt && (
        <ReceiptBar key={st.receipt.id} id={st.receipt.id} text={st.receipt.text} undo={st.receipt.undo} onDone={st.dismissReceipt} bottom={floating + 84} />
      )}
      <View style={[styles.composer, { bottom: floating + 12 }]}>
        <Composer placeholder="Ask about your feed" onSend={(text) => router.push({ pathname: '/agent', params: { ask: text } })} />
      </View>
    </View>
  );
}

/** "38 worth reading": the count in the lit gradient, the words in ink. */
function Text2({ n, words }: { n: number; words: string }) {
  const p = usePalette();
  return (
    <T v="hero" style={{ marginTop: 6 }} lines={2}>
      <LitText style={{ fontFamily: font.bold }}>{n.toLocaleString()}</LitText>
      <T v="hero" c={p.ink}>{` ${words}`}</T>
    </T>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.l },
  composer: { position: 'absolute', left: space.l, right: space.l },
  triage: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', marginTop: space.m, minHeight: 44, paddingHorizontal: 16, borderRadius: 999, borderWidth: 1 },
});

/** The bell: lit when an alert caught something you have not looked at. */
function AlertBell() {
  const p = usePalette();
  const st = useStore();
  const [unseen, setUnseen] = useState(0);
  const load = useCallback(() => void api.alertHits().then((r) => setUnseen(r.unseen), () => setUnseen(0)), []);
  useEffect(() => load(), [load]);
  useEffect(() => st.subscribe((e) => { if (e.type === 'ui' && (e.action as { kind?: string })?.kind === 'alert') load(); }), [st.subscribe, load]);
  return (
    <View>
      <IconButton name={unseen ? 'bellOn' : 'bell'} label={unseen ? `Alerts, ${unseen} new` : 'Alerts'} active={unseen > 0} onPress={() => router.push('/alerts')} />
      {unseen > 0 && <View pointerEvents="none" style={{ position: 'absolute', top: 8, right: 8, width: 9, height: 9, borderRadius: 5, backgroundColor: p.lamp, borderWidth: 2, borderColor: p.ground }} />}
    </View>
  );
}
