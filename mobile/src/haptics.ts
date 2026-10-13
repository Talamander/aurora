// Haptics, per platform: Android's own haptic constants, iOS impacts and selection ticks.
import { Platform } from 'react-native';
import * as Haptics from 'expo-haptics';
import { getSettings } from './settings';

const on = () => getSettings().haptics && Platform.OS !== 'web';

/** Save, hide: a firm confirmation. */
export function confirm() {
  if (!on()) return;
  if (Platform.OS === 'android') void Haptics.performAndroidHapticsAsync(Haptics.AndroidHaptics.Confirm).catch(() => {});
  else void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
}

/** Chips, tabs, undo: a light tick. */
export function tick() {
  if (!on()) return;
  if (Platform.OS === 'android') void Haptics.performAndroidHapticsAsync(Haptics.AndroidHaptics.Segment_Tick).catch(() => {});
  else void Haptics.selectionAsync().catch(() => {});
}

/** Paired, edition written. */
export function success() {
  if (!on()) return;
  if (Platform.OS === 'android') void Haptics.performAndroidHapticsAsync(Haptics.AndroidHaptics.Confirm).catch(() => {});
  else void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
}

/** Refused or failed. */
export function reject() {
  if (!on()) return;
  if (Platform.OS === 'android') void Haptics.performAndroidHapticsAsync(Haptics.AndroidHaptics.Reject).catch(() => {});
  else void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
}
