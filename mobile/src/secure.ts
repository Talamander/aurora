// Key-value storage. On phones the device token lives in the OS keychain / keystore through
// expo-secure-store. The web build (development preview only) falls back to localStorage.
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

const web = Platform.OS === 'web';

export async function getItem(key: string): Promise<string | null> {
  if (web) {
    try { return globalThis.localStorage?.getItem(key) ?? null; } catch { return null; }
  }
  return SecureStore.getItemAsync(key);
}

export async function setItem(key: string, value: string | null): Promise<void> {
  if (web) {
    try { value === null ? globalThis.localStorage?.removeItem(key) : globalThis.localStorage?.setItem(key, value); } catch { /* storage blocked */ }
    return;
  }
  if (value === null) await SecureStore.deleteItemAsync(key);
  else await SecureStore.setItemAsync(key, value, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY });
}
