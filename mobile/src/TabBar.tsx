// Navigation in each platform's own form: a Material 3 navigation bar on Android (and the web
// preview), a floating glass tab bar on iOS. Five destinations.
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import { BlurView } from 'expo-blur';
import type { ComponentProps } from 'react';
import type { Tabs } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon, type IconName } from './Icon';
import { font, usePalette } from './theme';
import { T } from './ui';
import * as haptics from './haptics';

type BottomTabBarProps = Parameters<NonNullable<ComponentProps<typeof Tabs>['tabBar']>>[0];

const ICONS: Record<string, IconName> = { index: 'feed', today: 'today', agent: 'agent', sources: 'sources', settings: 'settings' };

/** Height the tab bar covers above the bottom safe area, so screens can pad their content. */
export const TAB_HEIGHT = Platform.OS === 'ios' ? 86 : 80;

export function TabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const ios = Platform.OS === 'ios';

  const items = state.routes.map((route, i) => {
    const on = state.index === i;
    const label = (descriptors[route.key].options.title ?? route.name) as string;
    const press = () => {
      const e = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
      if (!on && !e.defaultPrevented) { haptics.tick(); navigation.navigate(route.name, route.params); }
    };
    return (
      <Pressable key={route.key} onPress={press} accessibilityRole="tab" accessibilityState={{ selected: on }} accessibilityLabel={label} style={styles.item}>
        <View style={[ios ? styles.iosPill : styles.indicator, on && { backgroundColor: p.mode === 'dark' ? '#3a2a22' : '#f8dccd' }]}>
          <Icon name={ICONS[route.name] ?? 'feed'} color={on ? (ios ? p.lamp : p.ink) : p.ink2} size={ios ? 22 : 24} />
          {ios && <T v="meta" c={on ? p.lamp : p.ink2} style={styles.iosLabel}>{label}</T>}
        </View>
        {!ios && <T v="label" c={on ? p.ink : p.ink2} style={{ marginTop: 4, fontFamily: on ? font.semibold : font.medium, fontSize: 12.5 }}>{label}</T>}
      </Pressable>
    );
  });

  if (ios) {
    return (
      <View pointerEvents="box-none" style={[styles.iosWrap, { bottom: Math.max(insets.bottom - 8, 10) }]}>
        <BlurView intensity={40} tint={p.mode === 'dark' ? 'dark' : 'light'} style={[styles.iosBar, { borderColor: p.line, backgroundColor: p.glass }]}>
          {items}
        </BlurView>
      </View>
    );
  }
  return <View style={[styles.android, { backgroundColor: p.navbar, paddingBottom: insets.bottom + 8, borderTopColor: p.line }]}>{items}</View>;
}

const styles = StyleSheet.create({
  android: { flexDirection: 'row', paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth },
  item: { flex: 1, alignItems: 'center', minHeight: 56 },
  indicator: { width: 64, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  iosWrap: { position: 'absolute', left: 16, right: 16 },
  iosBar: { flexDirection: 'row', borderRadius: 34, borderWidth: 1, overflow: 'hidden', padding: 6, boxShadow: '0 12px 32px rgba(0,0,0,0.35)' },
  iosPill: { alignItems: 'center', justifyContent: 'center', borderRadius: 26, paddingVertical: 7, width: '100%' },
  iosLabel: { fontFamily: font.medium, fontSize: 11, marginTop: 2 },
});
