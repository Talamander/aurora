import { useEffect, useState, useSyncExternalStore } from 'react';
import { Platform, View } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useFonts } from 'expo-font';
import { Geist_400Regular } from '@expo-google-fonts/geist/400Regular';
import { Geist_500Medium } from '@expo-google-fonts/geist/500Medium';
import { Geist_600SemiBold } from '@expo-google-fonts/geist/600SemiBold';
import { Geist_700Bold } from '@expo-google-fonts/geist/700Bold';
import { GeistMono_400Regular } from '@expo-google-fonts/geist-mono/400Regular';
import { GeistMono_500Medium } from '@expo-google-fonts/geist-mono/500Medium';
import { connection, loadConnection, onConnection } from '../src/api';
import { loadSettings } from '../src/settings';
import { LibraryProvider } from '../src/store';
import { usePalette } from '../src/theme';
import PairScreen from '../src/PairScreen';

// Literata is WOFF2, which only the web build can load; phones read in their own serif (theme.serif).
const WEB_FONTS: Record<string, number> = Platform.OS === 'web' ? { Literata: require('../assets/fonts/Literata.woff2'), 'Literata-Italic': require('../assets/fonts/Literata-Italic.woff2') } : {};

export default function Root() {
  const [fonts] = useFonts({ Geist_400Regular, Geist_500Medium, Geist_600SemiBold, Geist_700Bold, GeistMono_400Regular, GeistMono_500Medium, ...WEB_FONTS });
  const [ready, setReady] = useState(false);
  const conn = useSyncExternalStore(onConnection, connection, connection);
  const p = usePalette();

  useEffect(() => {
    void Promise.all([loadSettings(), loadConnection()]).finally(() => setReady(true));
  }, []);
  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(p.ground).catch(() => {});
  }, [p.ground]);

  if (!fonts || !ready) return <View style={{ flex: 1, backgroundColor: p.ground }} />;

  return (
    <SafeAreaProvider>
      <StatusBar style={p.mode === 'dark' ? 'light' : 'dark'} />
      {conn ? (
        // Keyed by server and device, so pairing again starts from a clean library.
        <LibraryProvider key={conn.url + conn.deviceId}>
          <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: p.ground }, animation: 'fade_from_bottom' }}>
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="post/[id]" options={{ animation: 'slide_from_right' }} />
            <Stack.Screen name="person/[key]" options={{ animation: 'slide_from_right' }} />
            <Stack.Screen name="page/[id]" options={{ animation: 'slide_from_right' }} />
            <Stack.Screen name="article/[id]" options={{ animation: 'slide_from_right' }} />
            <Stack.Screen name="readlater" options={{ animation: 'slide_from_right' }} />
            <Stack.Screen name="triage" options={{ animation: 'fade_from_bottom' }} />
            <Stack.Screen name="alerts" options={{ animation: 'slide_from_right' }} />
            <Stack.Screen name="week" options={{ animation: 'slide_from_right' }} />
            <Stack.Screen name="routines" options={{ animation: 'slide_from_right' }} />
            <Stack.Screen name="report" options={{ animation: 'slide_from_right' }} />
            <Stack.Screen name="search" options={{ animation: 'fade_from_bottom' }} />
            <Stack.Screen name="follow" options={{ animation: 'none' }} />
          </Stack>
        </LibraryProvider>
      ) : (
        <PairScreen />
      )}
    </SafeAreaProvider>
  );
}
