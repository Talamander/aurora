// The quiet line that says the phone is showing what it saved, because the computer is out of reach.
import { Pressable, StyleSheet } from 'react-native';
import { Icon } from './Icon';
import { ago, useStore } from './store';
import { space, usePalette } from './theme';
import { T } from './ui';
import * as haptics from './haptics';

export function OfflineBanner({ style }: { style?: object }) {
  const p = usePalette();
  const st = useStore();
  if (!st.offline || !st.lib) return null;
  const when = st.savedAt ? ` · saved ${ago(st.savedAt)} ago`.replace('now ago', 'just now') : '';
  const waiting = st.queued ? ` · ${st.queued} ${st.queued === 1 ? 'change' : 'changes'} to send` : '';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Offline, showing what you had${when}${waiting}. Tap to try again.`}
      accessibilityLiveRegion="polite"
      onPress={() => { haptics.tick(); void st.refresh(); }}
      style={({ pressed }) => [styles.bar, { backgroundColor: p.surface, borderColor: p.line }, pressed && { opacity: 0.8 }, style]}
    >
      <Icon name="offline" color={p.ink3} size={16} />
      <T v="mono" c={p.ink2} style={{ marginLeft: 8, flex: 1, paddingVertical: 6 }} lines={2}>{`Offline, showing what you had${when}${waiting}`}</T>
      <T v="mono" c={p.lamp}>{st.loading ? 'Trying' : 'Retry'}</T>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', minHeight: 36, marginHorizontal: space.l, marginTop: space.s, paddingHorizontal: space.m, borderRadius: 18, borderWidth: 1 },
});
