// Triage on the phone: one big card at a time from the current view. Swipe right to keep, left to
// hide, up for Read later, down to skip, or use the four buttons (swipes are never the only way).
// Every choice is a local state change; Undo takes the last one back. Post text is plain text.
import { useMemo, useRef, useState } from 'react';
import { Animated, PanResponder, Platform, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { swipeAction, tallyLine, triageDeck, triagePatch, triageTally, TRIAGE_LABEL, type TriageAction } from '../../core/triage.ts';
import type { Item, ItemState } from '../../core/types.ts';
import { Icon, type IconName } from '../src/Icon';
import * as haptics from '../src/haptics';
import { imgSource } from '../src/images';
import { useSettings } from '../src/settings';
import { ago, firstImage, useStore } from '../src/store';
import { font, hue, radius, space, target, usePalette, type Palette } from '../src/theme';
import { Ambient, Avatar, Button, IconButton, T } from '../src/ui';

const BAR: TriageAction[] = ['hide', 'later', 'skip', 'keep'];
const ICON: Record<TriageAction, IconName> = { keep: 'saved', later: 'laterOn', hide: 'hide', skip: 'check' };

function colour(a: TriageAction, p: Palette): string {
  if (a === 'keep') return p.on;
  if (a === 'later') return p.mode === 'dark' ? '#ffc56b' : '#c77a06';
  if (a === 'hide') return p.mode === 'dark' ? '#ff7a9c' : '#d23a6c';
  return p.ink3;
}

interface Done { item: Item; action: TriageAction; before: ItemState }

export default function Triage() {
  const p = usePalette();
  const st = useStore();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { reduceMotion } = useSettings();
  // The deck is fixed when Triage opens, so choices never reshuffle what is coming.
  const [deck] = useState(() => triageDeck((st.result?.visible ?? []).map((e) => e.item)));
  const [idx, setIdx] = useState(0);
  const [done, setDone] = useState<Done[]>([]);
  const pos = useRef(new Animated.ValueXY()).current;
  const fade = useRef(new Animated.Value(1)).current;
  const busy = useRef(false);
  const current = deck[idx] ?? null;
  const native = Platform.OS !== 'web';

  const decide = (action: TriageAction) => {
    const it = deck[idx];
    if (!it || busy.current) return;
    busy.current = true;
    st.setItemState([it.id], triagePatch(action, it));
    setDone((d) => [...d, { item: it, action, before: it.state }]);
    if (action === 'skip') haptics.tick();
    else haptics.confirm();
    const to = action === 'keep' ? { x: width * 1.2, y: 0 } : action === 'hide' ? { x: -width * 1.2, y: 0 } : action === 'later' ? { x: 0, y: -900 } : { x: 0, y: 700 };
    const next = () => {
      pos.setValue({ x: 0, y: 0 });
      fade.setValue(1);
      setIdx((i) => i + 1);
      busy.current = false;
    };
    if (reduceMotion) Animated.timing(fade, { toValue: 0, duration: 120, useNativeDriver: native }).start(next);
    else Animated.timing(pos, { toValue: to, duration: 180, useNativeDriver: native }).start(next);
  };

  const undo = () => {
    const last = done[done.length - 1];
    if (!last || busy.current) return;
    const b = last.before;
    st.setItemState([last.item.id], { read: b.read, saved: b.saved, archived: b.archived, collections: b.collections });
    setDone((d) => d.slice(0, -1));
    setIdx((i) => Math.max(0, i - 1));
    pos.setValue({ x: 0, y: 0 });
    haptics.tick();
  };

  const decideRef = useRef(decide);
  decideRef.current = decide;
  const pan = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > 8 || Math.abs(g.dy) > 8,
        onPanResponderMove: Animated.event([null, { dx: pos.x, dy: pos.y }], { useNativeDriver: false }),
        onPanResponderRelease: (_e, g) => {
          const a = swipeAction(g.dx, g.dy, width);
          if (a) decideRef.current(a);
          else Animated.spring(pos, { toValue: { x: 0, y: 0 }, useNativeDriver: native, damping: 16, stiffness: 240 }).start();
        },
        onPanResponderTerminate: () => Animated.spring(pos, { toValue: { x: 0, y: 0 }, useNativeDriver: native }).start(),
      }),
    [pos, width, native],
  );

  const rotate = pos.x.interpolate({ inputRange: [-width, 0, width], outputRange: ['-14deg', '0deg', '14deg'] });
  const glow = (a: TriageAction) => {
    const range = a === 'keep' || a === 'hide' ? pos.x : pos.y;
    const dir = a === 'keep' || a === 'skip' ? 1 : -1;
    return range.interpolate({ inputRange: dir > 0 ? [0, 120] : [-120, 0], outputRange: dir > 0 ? [0, 1] : [1, 0], extrapolate: 'clamp' });
  };
  const tally = triageTally(done);
  const pic = current ? firstImage(current) : null;

  return (
    <View style={{ flex: 1, backgroundColor: p.ground }}>
      <Ambient height={420} tint={st.profile?.color} />
      {/* Edge glows: the side the card is heading for lights up in that choice's colour. */}
      {(['keep', 'hide', 'later', 'skip'] as TriageAction[]).map((a) => (
        <Animated.View key={a} pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity: glow(a) }]}>
          <LinearGradient
            colors={[colour(a, p) + 'aa', colour(a, p) + '00']}
            start={a === 'keep' ? { x: 1, y: 0.5 } : a === 'hide' ? { x: 0, y: 0.5 } : a === 'later' ? { x: 0.5, y: 0 } : { x: 0.5, y: 1 }}
            end={a === 'keep' ? { x: 0.55, y: 0.5 } : a === 'hide' ? { x: 0.45, y: 0.5 } : a === 'later' ? { x: 0.5, y: 0.4 } : { x: 0.5, y: 0.6 }}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>
      ))}
      <View style={[styles.head, { paddingTop: insets.top + 6 }]}>
        <IconButton name="back" label="Close Triage" onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
        <View style={{ flex: 1, marginLeft: space.s }}>
          <T v="title">Triage</T>
          <T v="mono" c={p.ink2}>{current ? `${idx + 1} of ${deck.length}` : deck.length ? 'Done' : 'Nothing new'}</T>
        </View>
        {done.length > 0 && <IconButton name="history" label="Undo the last choice" onPress={undo} />}
      </View>
      <View style={{ height: 2, backgroundColor: p.line, marginHorizontal: space.l }}>
        <View style={{ height: 2, width: `${deck.length ? (idx / deck.length) * 100 : 100}%`, backgroundColor: p.lamp }} />
      </View>

      <View style={styles.stage}>
        {current ? (
          <>
            {idx + 1 < deck.length && <View style={[styles.card, styles.peek, { backgroundColor: p.glass, borderColor: p.line }]} />}
            <Animated.View
              {...pan.panHandlers}
              accessibilityLabel={`${current.author.name}${current.title ? `: ${current.title}` : ''}`}
              style={[styles.card, { backgroundColor: p.surface, borderColor: p.line, opacity: fade, transform: [{ translateX: pos.x }, { translateY: pos.y }, { rotate }] }]}
            >
              {pic && <Image source={imgSource(pic)} style={styles.pic} contentFit="cover" recyclingKey={pic} />}
              <View style={{ padding: space.l, flex: 1 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: space.m }}>
                  <Avatar name={current.author.name} uri={current.author.avatar} color={hue(current.platform, p)} size={40} />
                  <View style={{ flex: 1, marginLeft: space.m }}>
                    <T v="label" style={{ fontFamily: font.semibold }} lines={1}>{current.author.name}</T>
                    <T v="meta" c={p.ink2} lines={1}>{`${st.sourceLabels[current.sourceId] ?? current.platform} · ${ago(current.publishedAt)}`}</T>
                  </View>
                </View>
                {current.title ? <T v="title" lines={3} style={{ marginBottom: space.s }}>{current.title}</T> : null}
                <T v="body" lines={pic ? 6 : 14} style={{ fontSize: pic ? 16 : 19, lineHeight: pic ? 24 : 28 }}>{current.text}</T>
              </View>
            </Animated.View>
          </>
        ) : (
          <View style={{ alignItems: 'center', padding: space.xl }}>
            <LinearGradient colors={p.lit} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.orb} />
            <T v="display" style={{ textAlign: 'center' }}>{deck.length ? 'The deck is clear.' : 'Nothing new to clear.'}</T>
            <T v="body" c={p.ink2} style={{ textAlign: 'center', marginTop: space.s }}>
              {deck.length ? tallyLine(tally) : 'Every post in this view has been seen.'}
            </T>
            <View style={{ marginTop: space.xl }}><Button label="Back to the feed" onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} /></View>
          </View>
        )}
      </View>

      {current && (
        <View style={[styles.bar, { paddingBottom: insets.bottom + space.m }]}>
          {BAR.map((a) => (
            <Pressable
              key={a}
              accessibilityRole="button"
              accessibilityLabel={TRIAGE_LABEL[a].verb}
              onPress={() => decide(a)}
              style={({ pressed }) => [styles.act, { backgroundColor: p.glass, borderColor: p.line }, pressed && { transform: [{ scale: 0.96 }] }]}
            >
              <View style={[styles.actIc, { backgroundColor: colour(a, p) + '2e' }]}><Icon name={ICON[a]} size={20} color={colour(a, p)} /></View>
              <T v="label" style={{ fontFamily: font.semibold, fontSize: 13, marginTop: 4 }}>{TRIAGE_LABEL[a].verb}</T>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.s, paddingBottom: space.s },
  stage: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.m },
  card: { width: '100%', flex: 1, borderRadius: radius.card, borderWidth: 1, overflow: 'hidden' },
  peek: { position: 'absolute', top: space.m + 14, bottom: space.m - 14, left: space.m + 14, right: space.m + 14, opacity: 0.7 },
  pic: { width: '100%', height: 220 },
  orb: { width: 150, height: 150, borderRadius: 75, opacity: 0.8, marginBottom: space.xl },
  bar: { flexDirection: 'row', paddingHorizontal: space.m, paddingTop: space.s, gap: space.s },
  act: { flex: 1, minHeight: Math.max(64, target), alignItems: 'center', justifyContent: 'center', borderRadius: 18, borderWidth: 1, paddingVertical: space.s },
  actIc: { width: 34, height: 34, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
});
