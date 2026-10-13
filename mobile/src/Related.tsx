// More like this: posts the computer finds close to this one (shared rare words, the same author,
// the same topics), with the reason in a few words. Hidden offline and when there is nothing.
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import type { RelatedHit } from '../../core/search.ts';
import type { Item } from '../../core/types.ts';
import { api } from './api';
import { ago, useStore } from './store';
import { hue, radius, space, usePalette } from './theme';
import { PlatformDot, T } from './ui';
import * as haptics from './haptics';

function reason(h: RelatedHit): string {
  const bits: string[] = [];
  if (h.sameAuthor) bits.push('same author');
  if (h.topics.length) bits.push(h.topics.slice(0, 2).join(', '));
  if (h.shared.length) bits.push(`also says ${h.shared.slice(0, 3).join(', ')}`);
  return bits.join(' · ');
}

export function MoreLikeThis({ item }: { item: Item }) {
  const p = usePalette();
  const st = useStore();
  const [hits, setHits] = useState<RelatedHit[] | null>(null);

  useEffect(() => {
    if (st.offline) return;
    let live = true;
    api.related(item.id, st.profileId).then((r) => { if (live) setHits(r.results); }, () => { if (live) setHits([]); });
    return () => { live = false; };
  }, [item.id, st.profileId, st.offline]);

  const shown = (hits ?? []).filter((h) => st.byId.has(h.id)).slice(0, 5);
  if (!shown.length) return null;
  return (
    <View style={{ marginTop: space.xxl }}>
      <T v="over">More like this</T>
      {shown.map((h) => {
        const it = st.byId.get(h.id)!;
        const why = reason(h);
        return (
          <Pressable
            key={h.id}
            accessibilityRole="link"
            accessibilityLabel={`${it.author.name}: ${it.title ?? it.text.slice(0, 120)}${why ? `. ${why}` : ''}`}
            onPress={() => { haptics.tick(); router.push({ pathname: '/post/[id]', params: { id: h.id } }); }}
            style={({ pressed }) => [styles.row, { borderColor: p.line, backgroundColor: p.surface }, pressed && { transform: [{ scale: 0.985 }] }]}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <PlatformDot color={hue(it.platform, p)} />
              <T v="mono" lines={1} style={{ flex: 1 }}>{`${it.author.name} · ${ago(it.publishedAt)}`}</T>
            </View>
            <T v="body" lines={3} style={{ marginTop: 4 }}>{(it.title ?? it.text).replace(/\s+/g, ' ').trim()}</T>
            {why ? <T v="meta" c={p.ink3} lines={1} style={{ marginTop: 4 }}>{why}</T> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { marginTop: space.m, padding: space.l, borderRadius: radius.card - 8, borderWidth: 1 },
});
