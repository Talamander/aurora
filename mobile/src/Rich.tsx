// Agent and digest text: paragraphs, **bold**, list lines, and [[post:ID]] citations as tappable
// platform chips. Text is rendered as text only; nothing from a post or the model becomes markup.
import { Fragment } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { imgSource } from './images';
import { router } from 'expo-router';
import type { Item } from '../../core/types.ts';
import { ago, firstImage, useStore } from './store';
import { font, hue, platformLabel, radius, space, usePalette } from './theme';
import { T } from './ui';

const CITE = /\[\[post:([^\]\s]+)\]\]/g;

export function citedIds(text: string): string[] {
  return [...new Set([...text.matchAll(CITE)].map((m) => m[1]))];
}

function Inline({ text, byId }: { text: string; byId: Map<string, Item> }) {
  const p = usePalette();
  const { sourceLabels } = useStore();
  const parts = text.split(/(\[\[post:[^\]\s]+\]\]|\*\*[^*]+\*\*)/g).filter(Boolean);
  return (
    <>
      {parts.map((part, i) => {
        const cite = /^\[\[post:([^\]\s]+)\]\]$/.exec(part);
        if (cite) {
          const it = byId.get(cite[1]);
          if (!it) return null;
          const c = hue(it.platform, p);
          return (
            <Text
              key={i}
              onPress={() => router.push({ pathname: '/post/[id]', params: { id: it.id } })}
              accessibilityRole="link"
              style={{ fontFamily: font.mono, fontSize: 12.5, color: p.mode === 'dark' ? '#ffcfa8' : '#8a2f0e', backgroundColor: p.mode === 'dark' ? 'rgba(255,173,122,0.12)' : 'rgba(181,58,18,0.08)' }}
            >
              {` ${it.platform === 'rss' || it.platform === 'web' ? sourceLabels[it.sourceId] ?? platformLabel(it.platform) : platformLabel(it.platform)} `}
              <Text style={{ color: c }}>{'•'}</Text>
              {' '}
            </Text>
          );
        }
        const bold = /^\*\*([^*]+)\*\*$/.exec(part);
        if (bold) return <Text key={i} style={{ fontFamily: font.semibold }}>{bold[1]}</Text>;
        return <Fragment key={i}>{part}</Fragment>;
      })}
    </>
  );
}

export function RichText({ text, byId, color, size = 16 }: { text: string; byId: Map<string, Item>; color?: string; size?: number }) {
  const p = usePalette();
  const blocks = text.replace(/\r/g, '').split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  return (
    <View>
      {blocks.map((b, i) => {
        const heading = /^#{1,4}\s+(.*)$/.exec(b);
        if (heading) return <T key={i} v="headline" style={{ marginTop: i ? space.l : 0 }}>{heading[1]}</T>;
        return (
          <View key={i} style={{ marginTop: i ? space.m : 0 }}>
            {b.split('\n').map((line, j) => {
              const li = /^\s*(?:[-*•]|\d+\.)\s+(.*)$/.exec(line);
              return (
                <View key={j} style={{ flexDirection: 'row', marginTop: j ? 6 : 0 }}>
                  {li && <T v="body" c={p.lamp} style={{ width: 16, fontSize: size }}>{'•'}</T>}
                  <Text style={{ flex: 1, fontFamily: font.regular, fontSize: size, lineHeight: size * 1.45, color: color ?? p.ink }} selectable>
                    <Inline text={li ? li[1] : line} byId={byId} />
                  </Text>
                </View>
              );
            })}
          </View>
        );
      })}
    </View>
  );
}

/** The posts a message cites, as a row of small cards. */
export function CitedRow({ ids, byId }: { ids: string[]; byId: Map<string, Item> }) {
  const p = usePalette();
  const { sourceLabels } = useStore();
  const items = ids.map((id) => byId.get(id)).filter((x): x is Item => !!x).slice(0, 8);
  if (!items.length) return null;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: space.l, marginHorizontal: -space.l }} contentContainerStyle={{ paddingHorizontal: space.l }}>
      {items.map((it) => {
        const img = firstImage(it);
        return (
          <Pressable key={it.id} onPress={() => router.push({ pathname: '/post/[id]', params: { id: it.id } })} style={[styles.mini, { backgroundColor: p.surface, borderColor: p.line }]} accessibilityRole="link">
            {img ? <Image source={imgSource(img)} style={styles.miniImg} contentFit="cover" cachePolicy="memory-disk" /> : <View style={[styles.miniImg, { backgroundColor: hue(it.platform, p), opacity: 0.25 }]} />}
            <View style={{ padding: space.m }}>
              <T v="label" lines={2} style={{ fontFamily: font.medium }}>{it.title || it.text || it.author.name}</T>
              <T v="mono" style={{ marginTop: 4 }} lines={1}>{`${it.platform === 'rss' || it.platform === 'web' ? sourceLabels[it.sourceId] ?? platformLabel(it.platform) : platformLabel(it.platform)} · ${ago(it.publishedAt)}`}</T>
            </View>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  mini: { width: 200, borderRadius: radius.media, borderWidth: 1, overflow: 'hidden', marginRight: space.m },
  miniImg: { height: 84, width: '100%' },
});
