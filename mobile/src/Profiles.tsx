// Profiles on the phone: the feed's title is the active profile (Work, Games, Family...), tap it
// for a sheet of every profile with its unread count. Profiles are made and edited on the
// computer; the phone only picks one, and remembers its own pick (settings.profile), so the
// phone can read Family while the desktop stays on Work. Profile hours (Work on weekdays 9 to 5)
// switch the computer, never the phone; the sheet shows them so the phone's choice is informed.
import { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { describeDays, windowAt } from '../../core/profileSchedule.ts';
import { ALL_PROFILE } from '../../core/profiles.ts';
import { dayKey, formatMinutes, secondsOn, type TimeLog } from '../../core/timeSpent.ts';
import type { Profile } from '../../core/types.ts';
import { call } from './api';
import { Icon, profileIcon, type IconName } from './Icon';
import { useStore } from './store';
import { radius, space, usePalette } from './theme';
import { Mark, T } from './ui';

/** The feed's header: the mark (ringed in the profile's accent) and the profile's name. */
export function ProfileTitle() {
  const p = usePalette();
  const st = useStore();
  const [open, setOpen] = useState(false);
  const has = st.profiles.length > 0;
  const name = st.profile?.name ?? 'Aurora';
  return (
    <>
      <Pressable
        disabled={!has}
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={has ? `Profile: ${st.profile?.name ?? 'All profiles'}. Change profile` : 'Aurora'}
        style={({ pressed }) => [styles.title, pressed && { opacity: 0.7 }]}
      >
        <Mark size={34} ring={st.profile?.color} />
        <View style={{ marginLeft: space.m, flexShrink: 1 }}>
          <T v="title" lines={1}>{name}</T>
          {has && st.profile ? <T v="mono" c={p.ink3} style={{ marginTop: -2 }}>Aurora profile</T> : null}
        </View>
        {has && <View style={{ marginLeft: 4 }}><Icon name="expand" color={p.ink2} size={22} /></View>}
      </Pressable>
      {has && <ProfileSheet open={open} onClose={() => setOpen(false)} />}
    </>
  );
}

function ProfileSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const p = usePalette();
  const st = useStore();
  const insets = useSafeAreaInsets();
  const pick = (id: string) => { st.setProfile(id); onClose(); };
  // Today's reading time per profile, as the computer counted it (Time well spent). Best effort:
  // offline or an older server just leaves the line out.
  const [log, setLog] = useState<TimeLog>({});
  useEffect(() => {
    if (!open) return;
    let live = true;
    call<{ log: TimeLog }>('GET', '/api/time').then((r) => { if (live) setLog(r.log ?? {}); }).catch(() => {});
    return () => { live = false; };
  }, [open]);
  const today = (id: string) => {
    const s = secondsOn(log, dayKey(), id);
    return s >= 60 ? `${formatMinutes(s)} today` : null;
  };
  const rows: { id: string; name: string; icon: IconName | null; color: string | null; hours: string | null }[] = [
    { id: ALL_PROFILE, name: 'All profiles', icon: null, color: null, hours: null },
    ...[...st.profiles].sort((a, b) => a.position - b.position).map((x) => ({ id: x.id, name: x.name, icon: profileIcon(x.icon), color: x.color, hours: hoursLine(x) })),
  ];
  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel="Close" />
      <View style={[styles.sheet, { backgroundColor: p.raised, borderColor: p.line, paddingBottom: insets.bottom + space.l }]}>
        <View style={[styles.grab, { backgroundColor: p.line }]} />
        <T v="over" style={{ paddingHorizontal: space.xl, marginBottom: space.s }}>Read as</T>
        {rows.map((r) => {
          const on = r.id === st.profileId;
          return (
            <Pressable
              key={r.id}
              onPress={() => pick(r.id)}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              style={({ pressed }) => [styles.row, on && { backgroundColor: (r.color ?? p.lamp) + '1f' }, pressed && { opacity: 0.75 }]}
            >
              {r.icon && r.color ? (
                <View style={[styles.badge, { backgroundColor: r.color + '2e', borderColor: r.color + '88' }]}>
                  <Icon name={r.icon} color={r.color} size={20} />
                </View>
              ) : (
                <Mark size={38} />
              )}
              <View style={{ flex: 1, marginLeft: space.m }}>
                <T v="headline" lines={1}>{r.name}</T>
                {r.hours || today(r.id) ? <T v="mono" c={p.ink3} lines={1} style={{ marginTop: 1 }}>{[today(r.id), r.hours].filter(Boolean).join(' · ')}</T> : null}
              </View>
              <T v="mono" c={p.ink3} style={{ marginRight: space.m }}>{`${(st.profileCounts[r.id] ?? 0).toLocaleString()} new`}</T>
              <View style={[styles.radio, { borderColor: on ? r.color ?? p.lamp : p.line }]}>
                {on && <View style={[styles.dot, { backgroundColor: r.color ?? p.lamp }]} />}
              </View>
            </Pressable>
          );
        })}
        <T v="meta" c={p.ink3} style={{ paddingHorizontal: space.xl, marginTop: space.m }}>
          Profiles and their hours are set on your computer. Hours switch the computer, not this phone, which remembers its own choice.
        </T>
      </View>
    </Modal>
  );
}

/** "Weekdays 09:00–17:00 · now": a profile's hours, short enough for one line. */
export function hoursLine(x: Profile, now = new Date()): string | null {
  const s = x.schedule;
  if (!s?.days?.length) return null;
  const span = s.from === s.to ? 'all day' : `${s.from}–${s.to}`;
  return `${describeDays(s.days)} ${span}${windowAt(s, now) ? ' · now' : ''}`;
}

const styles = StyleSheet.create({
  title: { flexDirection: 'row', alignItems: 'center', flex: 1, minHeight: 48 },
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: { borderTopLeftRadius: radius.sheet, borderTopRightRadius: radius.sheet, borderWidth: 1, borderBottomWidth: 0, paddingTop: space.s },
  grab: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, marginBottom: space.l },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 60, marginHorizontal: space.s, paddingHorizontal: space.m, borderRadius: 18 },
  badge: { width: 38, height: 38, borderRadius: 13, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 10, height: 10, borderRadius: 5 },
});
