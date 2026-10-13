// Settings: which computer this phone talks to, phone-only preferences, and unpairing.
import { useEffect, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api, connection, saveConnection } from '../../src/api';
import { setSettings, useSettings, type Settings } from '../../src/settings';
import { TAB_HEIGHT } from '../../src/TabBar';
import { font, radius, space, usePalette } from '../../src/theme';
import { Ambient, Button, T, TopBar } from '../../src/ui';
import * as haptics from '../../src/haptics';

export default function SettingsScreen() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const set = useSettings();
  const conn = connection();
  const [me, setMe] = useState<{ name: string; createdAt: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const floating = Platform.OS === 'ios' ? insets.bottom + TAB_HEIGHT : 0;

  useEffect(() => { api.me().then((r) => setMe(r.device)).catch(() => {}); }, []);

  const unpair = async () => {
    try { await api.unpair(); } catch { /* already revoked on the computer */ }
    haptics.confirm();
    await saveConnection(null);
  };

  const toggle = (k: keyof Settings, label: string, hint: string) => (
    <View style={styles.row}>
      <View style={{ flex: 1 }}>
        <T v="bodyStrong">{label}</T>
        <T v="meta" style={{ marginTop: 2 }}>{hint}</T>
      </View>
      <Switch
        value={!!set[k]}
        onValueChange={(v) => { setSettings({ [k]: v }); haptics.tick(); }}
        trackColor={{ true: p.lamp, false: p.raised }}
        thumbColor={Platform.OS === 'ios' ? undefined : set[k] ? '#ffffff' : p.ink3}
        {...(Platform.OS === 'web' ? { activeThumbColor: '#ffffff' } : {})}
        accessibilityLabel={label}
      />
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: p.ground }}>
      <Ambient height={260} />
      <ScrollView contentContainerStyle={{ paddingTop: insets.top, paddingBottom: floating + space.xxl }}>
        <TopBar title="Settings" />

        <T v="over" style={styles.over}>Your computer</T>
        <View style={[styles.group, { backgroundColor: p.glass, borderColor: p.line }]}>
          <View style={styles.row}>
            <View style={[styles.live, { backgroundColor: p.on }]} />
            <View style={{ flex: 1 }}>
              <T v="bodyStrong">{conn?.server ?? 'Aurora'}</T>
              <T v="mono" style={{ marginTop: 2 }}>{conn?.url ?? ''}</T>
            </View>
          </View>
          <View style={[styles.sep, { backgroundColor: p.line }]} />
          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <T v="bodyStrong">{me?.name ?? 'This phone'}</T>
              <T v="meta" style={{ marginTop: 2 }}>{me ? `Paired ${new Date(me.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}. Unpair it from either side.` : 'Paired'}</T>
            </View>
          </View>
        </View>

        <T v="over" style={styles.over}>Appearance</T>
        <View style={[styles.group, { backgroundColor: p.glass, borderColor: p.line }]}>
          <View style={[styles.row, { paddingVertical: space.m }]}>
            <View style={[styles.segment, { backgroundColor: p.raised }]}>
              {(['auto', 'dark', 'light'] as const).map((t) => (
                <Pressable key={t} onPress={() => { setSettings({ theme: t }); haptics.tick(); }} style={[styles.seg, set.theme === t && { backgroundColor: p.mode === 'dark' ? '#3a2a22' : '#f8dccd' }]} accessibilityRole="radio" accessibilityState={{ checked: set.theme === t }}>
                  <T v="label" c={set.theme === t ? p.ink : p.ink2} style={{ fontFamily: set.theme === t ? font.semibold : font.medium }}>{t === 'auto' ? 'Match phone' : t === 'dark' ? 'Dark' : 'Light'}</T>
                </Pressable>
              ))}
            </View>
          </View>
        </View>

        <T v="over" style={styles.over}>On this phone</T>
        <View style={[styles.group, { backgroundColor: p.glass, borderColor: p.line }]}>
          {toggle('haptics', 'Haptics', 'A tap on save, set aside and pairing')}
          <View style={[styles.sep, { backgroundColor: p.line }]} />
          {toggle('reduceMotion', 'Reduce motion', 'No slide on the set-aside receipt')}
          <View style={[styles.sep, { backgroundColor: p.line }]} />
          {toggle('autoplay', 'Play video with sound', 'Off plays muted when you tap play')}
        </View>

        <View style={{ marginHorizontal: space.l, marginTop: space.xxl }}>
          {confirming ? (
            <View style={[styles.group, { marginHorizontal: 0, padding: space.l, backgroundColor: p.glass, borderColor: p.warn + '55' }]}>
              <T v="body">This phone forgets its token and your computer revokes it. Pair again with a new QR code.</T>
              <View style={{ flexDirection: 'row', gap: 10, marginTop: space.l }}>
                <View style={{ flex: 1 }}><Button kind="quiet" label="Keep" onPress={() => setConfirming(false)} /></View>
                <View style={{ flex: 1 }}><Button kind="danger" label="Unpair" onPress={() => void unpair()} /></View>
              </View>
            </View>
          ) : (
            <Button kind="danger" label="Unpair this phone" onPress={() => setConfirming(true)} />
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  over: { paddingHorizontal: space.l + 4, marginTop: space.xl, marginBottom: space.s },
  group: { marginHorizontal: space.l, borderRadius: radius.card - 4, borderWidth: 1, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.l, paddingVertical: 14, minHeight: 56 },
  sep: { height: StyleSheet.hairlineWidth, marginLeft: space.l },
  live: { width: 10, height: 10, borderRadius: 5, marginRight: space.m },
  segment: { flex: 1, flexDirection: 'row', borderRadius: radius.chip, padding: 4 },
  seg: { flex: 1, height: 40, borderRadius: radius.chip, alignItems: 'center', justifyContent: 'center' },
});
