// Sources: what feeds the library, with counts and the last sync. Adding and editing sources
// stays on the computer, where sign-ins and keys live.
import { useState } from 'react';
import { router } from 'expo-router';
import { Platform, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Source } from '../../../core/types.ts';
import { api } from '../../src/api';
import { ago, usePull, useStore } from '../../src/store';
import { TAB_HEIGHT } from '../../src/TabBar';
import { hue, platformLabel, radius, space, usePalette } from '../../src/theme';
import { Ambient, IconButton, T, TopBar } from '../../src/ui';
import * as haptics from '../../src/haptics';

function status(s: Source): string {
  if (s.status === 'syncing') return 'syncing now';
  if (s.status === 'error') return s.statusDetail || 'last sync failed';
  if (s.status === 'blocked') return s.statusDetail || 'needs you on your computer';
  if (!s.lastSyncAt) return 'never synced';
  return `synced ${ago(s.lastSyncAt)} ago`;
}

export default function Sources() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const st = useStore();
  const pull = usePull();
  const [busy, setBusy] = useState<string | null>(null);
  const floating = Platform.OS === 'ios' ? insets.bottom + TAB_HEIGHT : 0;
  const sources = [...(st.lib?.sources ?? [])].sort((a, b) => Number(b.enabled) - Number(a.enabled) || b.itemCount - a.itemCount);
  const total = st.lib?.items.length ?? 0;

  const sync = async (s: Source) => {
    setBusy(s.id);
    try { await api.syncSource(s.id); haptics.confirm(); await st.refresh(); } catch (e) { haptics.reject(); st.notify((e as Error).message); } finally { setBusy(null); }
  };

  return (
    <View style={{ flex: 1, backgroundColor: p.ground }}>
      <Ambient height={260} />
      <ScrollView
        contentContainerStyle={{ paddingTop: insets.top, paddingBottom: floating + space.xxl }}
        refreshControl={<RefreshControl refreshing={pull.on} onRefresh={pull.run} tintColor={p.lamp} colors={[p.lamp]} progressBackgroundColor={p.raised} />}
      >
        <TopBar title="Sources" right={<IconButton name="chart" label="Source report cards" onPress={() => router.push('/report')} />} />
        <T v="body" c={p.ink2} style={{ paddingHorizontal: space.l }}>
          {`${sources.length} ${sources.length === 1 ? 'source' : 'sources'}, ${total.toLocaleString()} posts. Add or change sources on your computer.`}
        </T>
        <View style={{ marginTop: space.l, marginHorizontal: space.l }}>
          {sources.map((s) => {
            const bad = s.status === 'error' || s.status === 'blocked';
            return (
              <View key={s.id} style={[styles.row, { backgroundColor: p.glass, borderColor: bad ? p.warn + '55' : p.line, opacity: s.enabled ? 1 : 0.6 }]}>
                <View style={[styles.icon, { backgroundColor: hue(s.platform, p) + '26' }]}>
                  <View style={[styles.swatch, { backgroundColor: hue(s.platform, p) }]} />
                </View>
                <View style={{ flex: 1, marginLeft: space.m }}>
                  <T v="headline" lines={1}>{s.label}</T>
                  <T v="mono" c={bad ? p.warn : p.ink3} lines={2} style={{ marginTop: 2 }}>{`${platformLabel(s.platform)} · ${s.itemCount.toLocaleString()} posts · ${status(s)}`}</T>
                </View>
                {s.enabled && <IconButton name="sync" label={`Sync ${s.label}`} onPress={() => void sync(s)} active={busy === s.id} />}
              </View>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', borderRadius: radius.card - 6, borderWidth: 1, padding: space.m, paddingLeft: space.l, marginBottom: space.s },
  icon: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  swatch: { width: 14, height: 14, borderRadius: 7 },
});
