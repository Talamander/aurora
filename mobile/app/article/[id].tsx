// The long-form reader: an article as the server extracted it (structured blocks, never HTML), set
// in a serif at a comfortable measure. It remembers where you stopped, marks the post read at the
// end, and a long press on a paragraph highlights it. Pictures from the article that are not in
// the library would reach their host directly, so with the image proxy on they wait for a tap.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { articleText, blockText, type Article, type ArticleBlock, type ArticleRecord, type Highlight, type Span } from '../../../core/longform.ts';
import { api, isOffline } from '../../src/api';
import { keepArticle, keptArticle } from '../../src/articles';
import { OfflineBanner } from '../../src/Offline';
import { Icon } from '../../src/Icon';
import { imgProxyReady, imgSource, proxyOn } from '../../src/images';
import { speaker, usePlaying } from '../../src/listen';
import { READ_LATER, useStore } from '../../src/store';
import { font, radius, serif, serifItalic, space, usePalette } from '../../src/theme';
import { Button, IconButton, ReceiptBar, T, TopBar } from '../../src/ui';
import * as haptics from '../../src/haptics';

type Rec = ArticleRecord & { canExtract?: boolean };

const hostOf = (u: string) => {
  try { return new URL(u).host.replace(/^www\./, ''); } catch { return ''; }
};
const openLink = (u?: string) => { if (u && /^https?:\/\//i.test(u)) void Linking.openURL(u); };

export default function ArticleScreen() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const st = useStore();
  const playing = usePlaying();
  const { id } = useLocalSearchParams<{ id: string }>();
  const item = st.byId.get(id);
  const [rec, setRec] = useState<Rec | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [progress, setProgress] = useState(0);
  const scroller = useRef<ScrollView>(null);
  const blockY = useRef<number[]>([]);
  const bodyY = useRef(0);
  const pos = useRef({ progress: 0, position: 0, dirty: false });
  const restored = useRef(false);

  const load = useCallback(async (force = false) => {
    setError(null);
    try {
      await imgProxyReady();
      let r: Rec = await api.article(id);
      setRec(r);
      if ((r.status !== 'ok' || force) && r.canExtract !== false) {
        setBusy(true);
        r = { ...(await api.extract(id, force)), canExtract: r.canExtract };
        setRec(r);
      }
      if (r.status === 'error') setError(r.error ?? 'The article could not be read.');
      keepArticle(id, r);
    } catch (e) {
      // Offline: the copy kept on the phone, if it was opened or put aside before.
      const kept = isOffline(e) ? await keptArticle(id) : null;
      if (kept) setRec(kept);
      else setError(isOffline(e) ? 'You are offline and this article was not saved on the phone yet.' : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { api.highlights(id).then(setHighlights).catch(() => {}); }, [id]);

  // Reading position: saved every few seconds while reading, and when the screen closes.
  useEffect(() => {
    const save = () => {
      if (!pos.current.dirty) return;
      pos.current.dirty = false;
      void api.reading(id, pos.current.progress, pos.current.position).catch(() => {});
    };
    const t = setInterval(save, 4000);
    return () => { clearInterval(t); save(); };
  }, [id]);
  useEffect(() => () => { if (playing === id) speaker.stop(); }, []);

  const article: Article | null = rec?.status === 'ok' ? rec.article : null;
  const marked = useMemo(() => new Set(highlights.map((h) => h.block)), [highlights]);
  // Library pictures can go through the proxy; anything else in the article is a new host.
  const known = useMemo(() => new Set((item?.media ?? []).flatMap((m) => [m.url, m.thumb].filter(Boolean) as string[])), [item]);

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const max = Math.max(1, contentSize.height - layoutMeasurement.height);
    const pr = Math.min(1, Math.max(0, contentOffset.y / max));
    const top = contentOffset.y - bodyY.current + 80;
    let position = 0;
    blockY.current.forEach((y, i) => { if (y <= top) position = i; });
    pos.current = { progress: pr, position, dirty: true };
    setProgress(pr);
  };

  // Put the reader back where it stopped, once the blocks have been laid out.
  const restore = () => {
    if (restored.current || !rec || !article) return;
    const target = rec.progress < 0.97 && rec.position > 2 ? rec.position : null;
    if (target === null || blockY.current[target] === undefined) return;
    restored.current = true;
    scroller.current?.scrollTo({ y: bodyY.current + blockY.current[target] - 60, animated: false });
    st.notify('Picked up where you left off');
  };

  const highlight = async (i: number, b: ArticleBlock) => {
    const quote = blockText(b).trim();
    if (!quote || marked.has(i)) return;
    haptics.confirm();
    try {
      const h = await api.highlight({ itemId: id, block: i, quote: quote.slice(0, 2000) });
      setHighlights((xs) => [...xs, h]);
      st.notify('Highlighted');
    } catch (e) {
      haptics.reject();
      st.notify((e as Error).message);
    }
  };

  const title = article?.title ?? item?.title ?? item?.text.slice(0, 80) ?? 'Article';
  const url = article?.url ?? item?.url ?? '';
  const site = article?.siteName ?? (url ? hostOf(url) : '');
  const inLater = item?.state.collections.includes(READ_LATER) ?? false;
  const script = article ? `${article.title}. ${articleText(article.blocks)}` : '';

  return (
    <View style={{ flex: 1, backgroundColor: p.ground }}>
      <View style={[styles.progress, { top: insets.top }]} pointerEvents="none">
        <LinearGradient colors={[p.lit[0], p.lit[1], p.lit[2]]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={{ width: `${Math.round(progress * 100)}%`, height: 2.5 }} />
      </View>
      <ScrollView
        ref={scroller}
        onScroll={onScroll}
        scrollEventThrottle={64}
        contentContainerStyle={{ paddingTop: insets.top, paddingBottom: insets.bottom + space.xxxl }}
      >
        <TopBar
          back
          right={
            <>
              {article && <IconButton name={playing === id ? 'stop' : 'listen'} label={playing === id ? 'Stop listening' : 'Listen to the article'} active={playing === id} onPress={() => { haptics.tick(); speaker.toggle(id, script); }} />}
              {item && <IconButton name={inLater ? 'laterOn' : 'later'} label={inLater ? 'In Read later. Tap to take it out' : 'Read later'} active={inLater} onPress={() => st.later(item)} />}
              {url ? <IconButton name="open" label="Open the original" onPress={() => openLink(url)} /> : null}
            </>
          }
        />
        <OfflineBanner style={{ marginBottom: space.m }} />
        <View style={styles.measure}>
          <T v="mono" c={p.ink3}>{[site, article ? `${article.minutes} min read` : null, article?.byline].filter(Boolean).join(' · ')}</T>
          <Text style={[styles.title, { color: p.ink, fontFamily: serif }]} selectable>{title}</Text>
          {article?.excerpt && !repeatsOpening(article) ? (
            <Text style={[styles.dek, { color: p.ink2, fontFamily: serifItalic }]}>{article.excerpt}</Text>
          ) : null}
        </View>

        {article?.leadImage && st.lib && <ArticleImage src={article.leadImage} known={known} lead />}

        {!article && (
          <View style={[styles.measure, { marginTop: space.xl }]}>
            {busy || (!rec && !error) ? (
              <View style={[styles.state, { backgroundColor: p.surface, borderColor: p.line }]}>
                <T v="headline">Fetching the article</T>
                <T v="body" c={p.ink2} style={{ marginTop: 6 }}>{`Your computer is reading ${site || 'the page'} and keeping only the text and pictures.`}</T>
                <View style={{ marginTop: space.l, gap: 10 }}>
                  {[0.95, 0.88, 0.92, 0.6].map((w, i) => <View key={i} style={{ height: 12, width: `${w * 100}%`, borderRadius: 6, backgroundColor: p.raised }} />)}
                </View>
              </View>
            ) : (
              <View style={[styles.state, { backgroundColor: p.surface, borderColor: p.line }]}>
                <T v="headline">{rec?.canExtract === false ? 'Nothing to read here' : 'The article could not be read'}</T>
                <T v="body" c={p.ink2} style={{ marginTop: 6 }}>{error ?? 'This post has no article link the reader can open.'}</T>
                <View style={{ flexDirection: 'row', gap: 10, marginTop: space.l, flexWrap: 'wrap' }}>
                  {rec?.canExtract !== false && <Button kind="quiet" label="Try again" onPress={() => void load(!!rec)} />}
                  {url ? <Button kind="quiet" icon="open" label="Open the original" onPress={() => openLink(url)} /> : null}
                </View>
              </View>
            )}
            {item?.text && !busy ? (
              item.text.split(/\n{2,}/).filter((x) => x.trim()).map((para, i) => (
                <Text key={i} style={[styles.p, { color: p.ink, fontFamily: serif }]} selectable>{para.trim()}</Text>
              ))
            ) : null}
          </View>
        )}

        {article && (
          <View style={styles.measure} onLayout={(e: LayoutChangeEvent) => { bodyY.current = e.nativeEvent.layout.y; }}>
            {article.blocks.map((b, i) => (
              <View
                key={i}
                onLayout={(e) => {
                  blockY.current[i] = e.nativeEvent.layout.y;
                  if (i === article.blocks.length - 1) restore();
                }}
              >
                <Block block={b} known={st.lib ? known : null} marked={marked.has(i)} onLongPress={() => void highlight(i, b)} />
              </View>
            ))}
            <View style={[styles.end, { borderTopColor: p.line }]}>
              <Icon name="check" color={p.on} size={20} />
              <T v="mono" c={p.ink3} style={{ marginLeft: 8, flex: 1 }}>{`${article.words.toLocaleString()} words · from ${site}`}</T>
            </View>
            <T v="meta" c={p.ink3} style={{ marginTop: space.s }}>Long-press a paragraph to highlight it. Highlights stay on your computer.</T>
          </View>
        )}
      </ScrollView>
      {st.receipt && <ReceiptBar key={st.receipt.id} id={st.receipt.id} text={st.receipt.text} undo={st.receipt.undo} onDone={st.dismissReceipt} bottom={insets.bottom + 16} />}
    </View>
  );
}

function Spans({ spans, base }: { spans: Span[]; base: object }) {
  const p = usePalette();
  return (
    <Text style={base} selectable>
      {spans.map((s, i) => (
        <Text
          key={i}
          onPress={s.href ? () => openLink(s.href) : undefined}
          style={[
            s.b && { fontWeight: '700' },
            s.i && { fontStyle: 'italic', fontFamily: serifItalic },
            s.code && { fontFamily: font.monoRegular, fontSize: 15.5, backgroundColor: p.surface },
            s.href && { color: p.lamp, textDecorationLine: 'underline', textDecorationColor: p.lamp + '66' },
          ]}
        >
          {s.text}
        </Text>
      ))}
    </Text>
  );
}

function Block({ block: b, known, marked, onLongPress }: { block: ArticleBlock; known: Set<string> | null; marked: boolean; onLongPress: () => void }) {
  const p = usePalette();
  const body = { color: p.ink, fontFamily: serif, fontSize: 19, lineHeight: 31 };
  const wrap = (child: React.ReactNode) => (
    <Pressable onLongPress={onLongPress} delayLongPress={450} style={[styles.block, marked && { backgroundColor: p.lamp + '1c', borderLeftColor: p.lamp }]}>
      {child}
    </Pressable>
  );
  switch (b.t) {
    case 'h':
      return wrap(<Text style={{ color: p.ink, fontFamily: font.semibold, fontSize: b.level === 2 ? 23 : 20, lineHeight: b.level === 2 ? 30 : 27, letterSpacing: -0.3, marginTop: space.l }} selectable>{b.text}</Text>);
    case 'p':
      return wrap(<Spans spans={b.spans} base={body} />);
    case 'quote':
      return wrap(
        <View style={{ borderLeftWidth: 3, borderLeftColor: p.lit[2], paddingLeft: space.l }}>
          <Spans spans={b.spans} base={{ ...body, fontFamily: serifItalic, fontStyle: 'italic', color: p.ink2 }} />
        </View>,
      );
    case 'ul':
    case 'ol':
      return wrap(
        <View style={{ gap: 6 }}>
          {b.items.map((it, i) => (
            <View key={i} style={{ flexDirection: 'row' }}>
              <Text style={[body, { width: 26, color: p.ink3 }]}>{b.t === 'ol' ? `${i + 1}.` : '•'}</Text>
              <View style={{ flex: 1 }}><Spans spans={it} base={body} /></View>
            </View>
          ))}
        </View>,
      );
    case 'code':
      return (
        <ScrollView horizontal style={[styles.code, { backgroundColor: p.surface, borderColor: p.line }]} contentContainerStyle={{ padding: space.l }}>
          <Text style={{ color: p.ink, fontFamily: font.monoRegular, fontSize: 14, lineHeight: 21 }} selectable>{b.text}</Text>
        </ScrollView>
      );
    case 'img':
      return known ? <ArticleImage src={b.src} alt={b.alt} caption={b.caption} known={known} /> : null;
    case 'hr':
      return <T v="mono" c={p.ink3} style={{ textAlign: 'center', marginVertical: space.xl, letterSpacing: 8 }}>· · ·</T>;
  }
}

/** A picture in the article. Library pictures use the proxy; others wait for a tap when it is on. */
/** The excerpt is often the first paragraph cut short; then it would only repeat the opening. */
function repeatsOpening(a: Article): boolean {
  const norm = (s: string) => s.replace(/\s+/g, ' ').replace(/[\u2026.\s]+$/, '').trim().toLowerCase();
  const first = norm(a.blocks.slice(0, 2).map((b) => blockText(b)).join(' '));
  const dek = norm(a.excerpt ?? '');
  return !!dek && (first.startsWith(dek) || first.startsWith(dek.slice(0, 60)));
}

function ArticleImage({ src, alt, caption, known, lead }: { src: string; alt?: string; caption?: string; known: Set<string>; lead?: boolean }) {
  const p = usePalette();
  const guarded = proxyOn() && !known.has(src);
  const [tapped, setShow] = useState(false);
  const show = !guarded || tapped;
  const [ratio, setRatio] = useState(16 / 10);
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <View style={[lead ? styles.lead : styles.figure]}>
      {show ? (
        <View style={{ width: '100%', aspectRatio: ratio, borderRadius: lead ? 0 : radius.media, overflow: 'hidden', backgroundColor: p.surface }}>
          <Image
            source={guarded ? { uri: src } : imgSource(src)}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            cachePolicy="memory-disk"
            accessibilityLabel={alt || undefined}
            onLoad={(e) => { const { width, height } = e.source; if (width && height) setRatio(Math.min(2.2, Math.max(0.7, width / height))); }}
            onError={() => setFailed(true)}
          />
        </View>
      ) : (
        <Pressable onPress={() => setShow(true)} accessibilityRole="button" accessibilityLabel={`Load picture from ${hostOf(src)}`} style={[styles.tap, { backgroundColor: p.surface, borderColor: p.line, borderRadius: lead ? 0 : radius.media }]}>
          <Icon name="image" color={p.ink3} size={26} />
          <T v="label" c={p.ink2} style={{ marginTop: 6 }}>{alt ? alt.slice(0, 80) : 'Picture'}</T>
          <T v="mono" c={p.ink3} style={{ marginTop: 2 }}>{`Tap to load from ${hostOf(src)}`}</T>
        </Pressable>
      )}
      {caption ? <T v="meta" c={p.ink3} style={{ marginTop: 6, paddingHorizontal: lead ? space.xl : 0 }}>{caption}</T> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  progress: { position: 'absolute', left: 0, right: 0, height: 3, zIndex: 10 },
  measure: { paddingHorizontal: space.xl, maxWidth: 720, width: '100%', alignSelf: 'center' },
  title: { fontSize: 31, lineHeight: 38, fontWeight: '600', letterSpacing: -0.5, marginTop: space.m },
  dek: { fontSize: 19, lineHeight: 28, marginTop: space.m },
  p: { fontSize: 19, lineHeight: 31, marginTop: space.l },
  block: { marginTop: space.l, borderLeftWidth: 3, borderLeftColor: 'transparent', marginLeft: -space.m, paddingLeft: space.m - 3, paddingVertical: 2, borderRadius: 4 },
  code: { marginTop: space.l, borderRadius: 14, borderWidth: 1 },
  figure: { marginTop: space.xl },
  lead: { marginTop: space.xl, maxWidth: 720, width: '100%', alignSelf: 'center' },
  tap: { height: 150, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  state: { borderRadius: 22, borderWidth: 1, padding: space.l },
  end: { flexDirection: 'row', alignItems: 'center', marginTop: space.xxl, paddingTop: space.l, borderTopWidth: StyleSheet.hairlineWidth },
});
