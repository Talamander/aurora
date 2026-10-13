// Pages on the phone: the same block JSON the desktop renders. Widgets (AI-written HTML) stay on
// the computer, where they run in a sandbox; the phone never renders HTML.
import { useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { DEFAULT_SPEC } from '../../core/filter.ts';
import type { Item, PageBlock } from '../../core/types.ts';
import { PostCard } from './PostCard';
import { imgSource } from './images';
import { CitedRow, citedIds, RichText } from './Rich';
import { firstImage, litBy, useStore } from './store';
import { hue, platformLabel, space, usePalette } from './theme';
import { T } from './ui';

function useBlockItems(spec: object | undefined, limit: number): Item[] {
  const st = useStore();
  return useMemo(() => (st.evaluate({ ...DEFAULT_SPEC, ...(spec ?? {}) })?.visible ?? []).slice(0, limit).map((e) => e.item), [st.evaluate, spec, limit]);
}

function Section({ title, n, children }: { title?: string; n?: number; children: React.ReactNode }) {
  const p = usePalette();
  return (
    <View style={[styles.section, { borderTopColor: p.line }]}>
      {title ? (
        <View style={{ flexDirection: 'row', alignItems: 'baseline', paddingHorizontal: space.l }}>
          {n !== undefined && <T v="mono" style={{ marginRight: 8 }}>{String(n).padStart(2, '0')}</T>}
          <T v="title" style={{ flex: 1 }}>{title}</T>
        </View>
      ) : null}
      {children}
    </View>
  );
}

function FeedBlock({ block }: { block: Extract<PageBlock, { type: 'feed' }> }) {
  const st = useStore();
  const p = usePalette();
  const items = useBlockItems(block.spec, Math.min(block.limit ?? 6, 12));
  const evs = useMemo(() => {
    const r = st.evaluate({ ...DEFAULT_SPEC, ...block.spec });
    return (r?.visible ?? []).filter((e) => items.includes(e.item));
  }, [items, st.evaluate, block.spec]);
  return (
    <Section title={block.title}>
      <View style={{ marginTop: space.l }}>
        {evs.map((ev) => (
          <PostCard key={ev.item.id} item={ev.item} why={litBy(ev, st.sourceLabels)} source={st.sourceLabels[ev.item.sourceId] ?? ev.item.platform} p={p} onSave={st.save} onHide={st.hide} />
        ))}
        {!evs.length && <T v="meta" style={{ paddingHorizontal: space.l }}>No posts match this block yet.</T>}
      </View>
    </Section>
  );
}

function Gallery({ block }: { block: Extract<PageBlock, { type: 'gallery' }> }) {
  const items = useBlockItems({ ...block.spec, contentTypes: ['image'] }, block.limit ?? 9).filter((i) => firstImage(i));
  return (
    <Section title={block.title}>
      <View style={styles.grid}>
        {items.map((it) => (
          <Pressable key={it.id} onPress={() => router.push({ pathname: '/post/[id]', params: { id: it.id } })} style={styles.cell} accessibilityRole="imagebutton" accessibilityLabel={it.media[0]?.alt || it.text.slice(0, 80) || it.author.name}>
            <Image source={imgSource(firstImage(it))} style={StyleSheet.absoluteFill} contentFit="cover" cachePolicy="memory-disk" transition={120} />
          </Pressable>
        ))}
      </View>
    </Section>
  );
}

function People({ block }: { block: Extract<PageBlock, { type: 'people' }> }) {
  const p = usePalette();
  const items = useBlockItems(block.spec, 400);
  const people = useMemo(() => {
    const m = new Map<string, { item: Item; n: number }>();
    for (const it of items) {
      const k = (it.author.handle ?? it.author.name).toLowerCase();
      const cur = m.get(k);
      m.set(k, { item: cur?.item ?? it, n: (cur?.n ?? 0) + 1 });
    }
    return [...m.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, block.limit ?? 8);
  }, [items]);
  return (
    <Section title={block.title}>
      {people.map(([k, { item, n }]) => (
        <Pressable key={k} onPress={() => router.push({ pathname: '/person/[key]', params: { key: k } })} style={styles.row}>
          <View style={[styles.swatch, { backgroundColor: hue(item.platform, p) }]} />
          <T v="bodyStrong" style={{ flex: 1 }} lines={1}>{item.author.name}</T>
          <T v="mono">{`${n} ${n === 1 ? 'post' : 'posts'}`}</T>
        </Pressable>
      ))}
    </Section>
  );
}

function Stats({ block }: { block: Extract<PageBlock, { type: 'stats' }> }) {
  const p = usePalette();
  const st = useStore();
  const items = useBlockItems(block.spec, 5000);
  const rows = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of items) {
      const k =
        block.metric === 'by_source' ? st.sourceLabels[it.sourceId] ?? it.sourceId
        : block.metric === 'by_platform' ? platformLabel(it.platform)
        : block.metric === 'by_author' ? it.author.name
        : block.metric === 'per_day' ? it.publishedAt.slice(5, 10)
        : 'All';
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    const list = [...m.entries()];
    return (block.metric === 'per_day' ? list.sort() : list.sort((a, b) => b[1] - a[1])).slice(-8);
  }, [items, block.metric]);
  const max = Math.max(1, ...rows.map((r) => r[1]));
  return (
    <Section title={block.title}>
      {rows.map(([k, n]) => (
        <View key={k} style={styles.row}>
          <T v="label" style={{ width: 120 }} lines={1}>{k}</T>
          <View style={{ flex: 1, height: 10, borderRadius: 5, backgroundColor: p.raised, marginHorizontal: space.m }}>
            <View style={{ width: `${(n / max) * 100}%`, height: 10, borderRadius: 5, backgroundColor: p.lamp }} />
          </View>
          <T v="mono">{String(n)}</T>
        </View>
      ))}
    </Section>
  );
}

export function Blocks({ blocks, skipHero }: { blocks: PageBlock[]; skipHero?: boolean }) {
  const p = usePalette();
  const st = useStore();
  let n = 0;
  return (
    <View>
      {blocks.map((b, i) => {
        switch (b.type) {
          case 'hero':
            if (skipHero) return null;
            return (
              <View key={i} style={{ paddingHorizontal: space.l, paddingTop: space.l }}>
                <T v="display">{b.title}</T>
                {b.subtitle ? <T v="body" c={p.ink2} style={{ marginTop: space.s }}>{b.subtitle}</T> : null}
              </View>
            );
          case 'digest':
          case 'note':
            n += b.type === 'digest' ? 1 : 0;
            return (
              <Section key={i} title={b.title} n={b.type === 'digest' && b.title ? n : undefined}>
                <View style={{ paddingHorizontal: space.l, marginTop: b.title ? space.s : 0 }}>
                  <RichText text={b.text} byId={st.byId} color={p.ink2} />
                  {b.type === 'digest' && <CitedRow ids={b.postIds?.length ? b.postIds : citedIds(b.text)} byId={st.byId} />}
                </View>
              </Section>
            );
          case 'feed':
            return <FeedBlock key={i} block={b} />;
          case 'gallery':
            return <Gallery key={i} block={b} />;
          case 'people':
            return <People key={i} block={b} />;
          case 'stats':
            return <Stats key={i} block={b} />;
          case 'widget':
            return (
              <Section key={i} title={b.title}>
                <T v="meta" style={{ paddingHorizontal: space.l, marginTop: space.s }}>This widget runs on your computer. Open the page there to see it.</T>
              </Section>
            );
          default:
            return null;
        }
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { borderTopWidth: StyleSheet.hairlineWidth, marginTop: space.xl, paddingTop: space.xl },
  grid: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: space.l, marginTop: space.l, gap: 6 },
  cell: { width: '32%', aspectRatio: 1, borderRadius: 12, overflow: 'hidden', backgroundColor: '#11131a' },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.l, minHeight: 48 },
  swatch: { width: 10, height: 10, borderRadius: 5, marginRight: space.m },
});
