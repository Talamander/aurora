// Read later: the long reads you put aside (the "Read later" collection), with how far you got,
// then long unread pieces worth the time. Each opens in the long-form reader. Listen reads the
// unread ones aloud back to back, from the articles saved on the phone when it can.
import { useCallback, useEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { articleText } from '../../core/longform.ts';
import { api, isOffline, type QueueEntry } from '../src/api';
import { keepArticle, keptArticle } from '../src/articles';
import { readCache, writeCache } from '../src/cache';
import { OfflineBanner } from '../src/Offline';
import { Icon } from '../src/Icon';
import { speaker, usePlaying, useQueueNow, type Track } from '../src/listen';
import * as haptics from '../src/haptics';
import { imgProxyReady, imgSource } from '../src/images';
import { ago, READ_LATER, useStore } from '../src/store';
import { font, radius, serif, space, usePalette } from '../src/theme';
import { Ambient, IconButton, LitText, ReceiptBar, T, TopBar } from '../src/ui';

export default function ReadLater() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const st = useStore();
  const [data, setData] = useState<{ queue: QueueEntry[]; suggestions: QueueEntry[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      await imgProxyReady();
      const r = await api.queue();
      setData(r);
      setError(null);
      writeCache('queue', r);
      void keepForOffline(r.queue);
    } catch (e) {
      // Offline: the queue as it was last seen, with the articles saved for it.
      const kept = isOffline(e) ? await readCache<{ queue: QueueEntry[]; suggestions: QueueEntry[] }>('queue') : null;
      if (kept) setData((d) => d ?? kept);
      else setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    // What the phone saved shows at once; the computer's answer replaces it.
    void readCache<{ queue: QueueEntry[]; suggestions: QueueEntry[] }>('queue').then((kept) => { if (kept) setData((d) => d ?? kept); });
    void load();
  }, [load]);
  // The queue follows the library: adding, finishing or removing a read elsewhere updates it here.
  useEffect(() => st.subscribe((e) => { if (e.type === 'library') void load(); }), [st.subscribe, load]);

  // The active profile only sees its own sources' reads.
  const scoped = (xs: QueueEntry[]) => xs.filter((x) => st.byId.has(x.id));
  const queue = data ? scoped(data.queue).sort((a, b) => (b.addedAt ?? '').localeCompare(a.addedAt ?? '')) : [];
  const unread = queue.filter((x) => !x.read);
  const finished = queue.filter((x) => x.read);
  const suggestions = data ? scoped(data.suggestions).slice(0, 12) : [];
  const minutes = unread.reduce((n, x) => n + Math.max(1, Math.round(x.minutes * (1 - x.progress))), 0);

  const playing = usePlaying() === LISTEN_KEY;
  const now = useQueueNow();
  const listen = () => {
    haptics.tick();
    if (playing) return speaker.stop();
    speaker.playQueue(LISTEN_KEY, unread.map((x) => track(x, st.byId.get(x.id)?.text ?? '')));
  };

  const toggle = (id: string) => {
    const it = st.byId.get(id);
    if (it) st.later(it);
  };

  return (
    <View style={{ flex: 1, backgroundColor: p.ground }}>
      <Ambient height={300} tint={st.profile?.color} />
      <ScrollView
        contentContainerStyle={{ paddingTop: insets.top, paddingBottom: insets.bottom + space.xxxl }}
        refreshControl={<RefreshControl refreshing={loading && !!data} onRefresh={load} tintColor={p.lamp} colors={[p.lamp]} progressBackgroundColor={p.raised} />}
      >
        <TopBar back title="Read later" />
        <OfflineBanner style={{ marginBottom: space.s }} />
        <View style={{ paddingHorizontal: space.l, marginTop: space.s }}>
          <T v="hero" lines={2}>
            <LitText>{String(unread.length)}</LitText>
            <T v="hero" c={p.ink}>{unread.length === 1 ? ' long read' : ' long reads'}</T>
          </T>
          <T v="mono" c={p.ink3} style={{ marginTop: 6 }}>{unread.length ? `about ${minutes} min left · ${st.profile ? st.profile.name : 'all profiles'}` : st.profile ? st.profile.name : 'all profiles'}</T>
          {unread.length > 0 && (
            <View style={styles.listenRow}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={playing ? 'Stop listening' : `Listen to ${unread.length} ${unread.length === 1 ? 'read' : 'reads'}, one after another`}
                onPress={listen}
                style={({ pressed }) => [styles.listen, { backgroundColor: p.ink }, pressed && { transform: [{ scale: 0.97 }] }]}
              >
                <View style={[styles.listenIcon, { backgroundColor: p.ground }]}><Icon name={playing ? 'stop' : 'listen'} color={p.ink} size={18} /></View>
                <T v="label" c={p.ground} style={{ fontFamily: font.semibold, fontSize: 15, marginLeft: 10 }}>{playing ? 'Stop' : 'Listen to all'}</T>
              </Pressable>
              {playing && now && now.index + 1 < now.total && <IconButton name="skip" label="Next read" onPress={() => { haptics.tick(); speaker.skip(); }} />}
            </View>
          )}
          {playing && now && (
            <T v="mono" c={p.ink2} style={{ marginTop: space.s }} lines={2}>{`${now.loading ? 'Fetching' : 'Reading'} ${now.index + 1} of ${now.total} · ${now.title}`}</T>
          )}
        </View>

        {error && !data ? (
          <View style={{ padding: space.l }}>
            <T v="title">Cannot load Read later</T>
            <T v="body" c={p.ink2} style={{ marginTop: space.s }}>{error}</T>
          </View>
        ) : null}

        {data && !unread.length && (
          <View style={[styles.empty, { borderColor: p.line, backgroundColor: p.surface }]}>
            <Icon name="later" color={p.lamp} size={26} />
            <T v="headline" style={{ marginTop: space.s }}>Nothing put aside</T>
            <T v="body" c={p.ink2} style={{ marginTop: 4 }}>Open an article and tap the bookmark to keep it here, with your place saved.</T>
          </View>
        )}

        {unread.map((x) => <Row key={x.id} e={x} onToggle={() => toggle(x.id)} />)}

        {suggestions.length > 0 && (
          <>
            <T v="over" style={{ paddingHorizontal: space.l, marginTop: space.xxl, marginBottom: space.s }}>Worth the time</T>
            {suggestions.map((x) => <Row key={x.id} e={x} onToggle={() => toggle(x.id)} />)}
          </>
        )}

        {finished.length > 0 && (
          <>
            <T v="over" style={{ paddingHorizontal: space.l, marginTop: space.xxl, marginBottom: space.s }}>Finished</T>
            {finished.slice(0, 20).map((x) => <Row key={x.id} e={x} onToggle={() => toggle(x.id)} />)}
          </>
        )}
      </ScrollView>
      {st.receipt && <ReceiptBar key={st.receipt.id} id={st.receipt.id} text={st.receipt.text} undo={st.receipt.undo} onDone={st.dismissReceipt} bottom={insets.bottom + 16} />}
    </View>
  );
}

const LISTEN_KEY = 'read-later';

/** One read for Listen: the saved article, else the computer's copy, else the post's own text. */
function track(e: QueueEntry, fallback: string): Track {
  return {
    id: e.id,
    title: e.title,
    load: async () => {
      const kept = await keptArticle(e.id);
      if (kept?.article) return articleText(kept.article.blocks);
      try {
        let rec = await api.article(e.id);
        if (rec.status !== 'ok' && rec.status !== 'error' && rec.canExtract) rec = { ...(await api.extract(e.id)), canExtract: true };
        if (rec.article) { keepArticle(e.id, rec); return articleText(rec.article.blocks); }
      } catch { /* offline: fall back to what the post says */ }
      return fallback || null;
    },
  };
}

/** Saves the unread articles in the queue that the phone does not have yet, one at a time, so
 *  they can be read with no connection. An article the computer has not read yet is extracted,
 *  as opening it would (the server's SSRF-safe fetcher, library items only). */
async function keepForOffline(queue: QueueEntry[]) {
  const want = queue.filter((x) => !x.read).slice(0, 25);
  for (const x of want) {
    if (await keptArticle(x.id)) continue;
    try {
      let rec = await api.article(x.id);
      if (rec.status !== 'ok' && rec.status !== 'error' && rec.canExtract) rec = { ...(await api.extract(x.id)), canExtract: true };
      keepArticle(x.id, rec);
    } catch (e) {
      if (isOffline(e)) return;
    }
  }
}

function Row({ e, onToggle }: { e: QueueEntry; onToggle: () => void }) {
  const p = usePalette();
  const st = useStore();
  const inQueue = st.byId.get(e.id)?.state.collections.includes(READ_LATER) ?? e.inQueue;
  const started = e.progress > 0.02 && !e.read;
  return (
    <Pressable
      onPress={() => router.push({ pathname: '/article/[id]', params: { id: e.id } })}
      accessibilityRole="link"
      accessibilityLabel={`${e.title}, ${e.minutes} minutes`}
      style={({ pressed }) => [styles.row, { backgroundColor: p.surface, borderColor: p.line }, pressed && { transform: [{ scale: 0.985 }] }]}
    >
      <View style={{ flex: 1, padding: space.l, paddingRight: space.s }}>
        <T v="mono" c={p.ink3} lines={1}>{`${e.source} · ${e.exact ? '' : '~'}${e.minutes} min · ${ago(e.publishedAt)}`}</T>
        <Text style={{ color: e.read ? p.ink2 : p.ink, fontFamily: serif, fontSize: 18.5, lineHeight: 24, fontWeight: '600', marginTop: 6 }} numberOfLines={3}>{e.title}</Text>
        {e.author ? <T v="meta" c={p.ink3} style={{ marginTop: 4 }} lines={1}>{e.author}</T> : null}
        {started && (
          <View style={[styles.bar, { backgroundColor: p.raised }]}>
            <View style={{ width: `${Math.round(e.progress * 100)}%`, height: '100%', borderRadius: 2, backgroundColor: p.lamp }} />
          </View>
        )}
      </View>
      <View style={{ alignItems: 'center', paddingVertical: space.s, paddingRight: space.s }}>
        {e.image ? <Image source={imgSource(e.image)} style={styles.thumb} contentFit="cover" cachePolicy="memory-disk" /> : null}
        <IconButton name={inQueue ? 'laterOn' : 'later'} label={inQueue ? 'Take out of Read later' : 'Add to Read later'} active={inQueue} onPress={onToggle} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', marginHorizontal: space.l, marginTop: space.m, borderRadius: radius.card - 4, borderWidth: 1, overflow: 'hidden' },
  thumb: { width: 72, height: 72, borderRadius: 14, marginTop: space.s },
  bar: { height: 4, borderRadius: 2, marginTop: space.m, overflow: 'hidden' },
  listenRow: { flexDirection: 'row', alignItems: 'center', gap: space.s, marginTop: space.l },
  listen: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', borderRadius: radius.chip, paddingLeft: 6, paddingRight: 18, height: 48 },
  listenIcon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  empty: { marginHorizontal: space.l, marginTop: space.xl, borderRadius: 22, borderWidth: 1, padding: space.l },
});
