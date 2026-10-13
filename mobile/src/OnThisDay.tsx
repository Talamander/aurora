// On this day: posts you saved or highlighted on today's date a month or a year ago, as a small
// card at the top of Today. Worked out on the phone from the library (core/onThisDay.ts), with
// highlights from the computer. No AI. "Hide for today" is remembered on this phone only.
import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { agoLabel, onThisDay } from '../../core/onThisDay.ts';
import { Icon } from './Icon';
import { useMarks } from './marks';
import { setSettings, useSettings } from './settings';
import { useStore } from './store';
import { serif, space, usePalette } from './theme';
import { T } from './ui';
import * as haptics from './haptics';

/** The phone's local calendar day, YYYY-MM-DD. */
export function localDay(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function OnThisDay() {
  const p = usePalette();
  const st = useStore();
  const set = useSettings();
  const marks = useMarks();
  const today = localDay();
  const memories = useMemo(
    () => (st.lib && marks ? onThisDay(st.lib.items, marks.highlights).slice(0, 3) : []),
    [st.lib, marks],
  );
  if (!memories.length || set.onThisDayHidden === today) return null;

  return (
    <View style={[styles.card, { backgroundColor: p.surface, borderColor: p.line }]}>
      <View style={styles.head}>
        <Icon name="history" color={p.lamp} size={18} />
        <T v="over" c={p.lamp} style={{ marginLeft: 6, flex: 1 }}>On this day</T>
        <Pressable
          onPress={() => { haptics.tick(); setSettings({ onThisDayHidden: today }); }}
          accessibilityRole="button"
          accessibilityLabel="Hide On this day until tomorrow"
          hitSlop={10}
          style={({ pressed }) => [styles.hide, pressed && { opacity: 0.6 }]}
        >
          <T v="label" c={p.ink2}>Hide for today</T>
        </Pressable>
      </View>
      {memories.map((m, i) => {
        const text = m.quote ? `“${m.quote}”` : m.item.title || m.item.text;
        return (
          <Pressable
            key={m.item.id}
            onPress={() => router.push({ pathname: '/post/[id]', params: { id: m.item.id } })}
            accessibilityRole="link"
            accessibilityLabel={`${agoLabel(m.monthsAgo)} you ${m.kind} a post by ${m.item.author.name}`}
            style={({ pressed }) => [styles.row, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: p.line }, pressed && { opacity: 0.7 }]}
          >
            <T v="mono" c={p.ink3} lines={1}>{`${agoLabel(m.monthsAgo)} · you ${m.kind} · ${m.item.author.name}`}</T>
            <Text style={{ color: p.ink, fontFamily: serif, fontSize: 17, lineHeight: 23, marginTop: 4, fontStyle: m.quote ? 'italic' : 'normal' }} numberOfLines={3}>
              {text.replace(/\s+/g, ' ').trim()}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { marginHorizontal: space.l, marginTop: space.s, marginBottom: space.m, borderRadius: 24, borderWidth: 1, paddingHorizontal: space.l, paddingTop: space.m, paddingBottom: space.s },
  head: { flexDirection: 'row', alignItems: 'center', minHeight: 32 },
  hide: { minHeight: 32, justifyContent: 'center', paddingHorizontal: 4 },
  row: { paddingVertical: space.m },
});
