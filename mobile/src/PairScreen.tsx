// Pairing: scan the QR code from Aurora on your computer (Settings, AI, Phones), check that both
// screens show the same four digits, approve on the computer. The phone then holds a device token
// that it sends as a Bearer token; the computer can revoke it at any time.
import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Linking from 'expo-linking';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ApiError, cleanServerUrl, pairing, parsePairLink, saveConnection, type PairLink } from './api';
import * as haptics from './haptics';
import { Icon } from './Icon';
import { font, radius, space, usePalette } from './theme';
import { Ambient, Button, Mark, T } from './ui';

type Step =
  | { kind: 'scan' }
  | { kind: 'manual' }
  | { kind: 'check'; link: PairLink; check: string; claimKey: string }
  | { kind: 'failed'; message: string };

export default function PairScreen() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const [step, setStep] = useState<Step>({ kind: Platform.OS === 'web' ? 'manual' : 'scan' });
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState('');
  const [code, setCode] = useState('');
  const scanned = useRef(false);
  const incoming = Linking.useLinkingURL();

  const claim = async (link: PairLink) => {
    setBusy(true);
    try {
      const r = await pairing.claim(link);
      haptics.tick();
      setStep({ kind: 'check', link, check: r.check, claimKey: r.claimKey });
    } catch (e) {
      haptics.reject();
      scanned.current = false;
      setStep({ kind: 'failed', message: e instanceof ApiError && e.status === 404 ? 'That pairing code has expired or was used. Make a new one on your computer.' : (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  // Opened from the QR code with the system camera: aurora://pair?...
  useEffect(() => {
    const link = incoming ? parsePairLink(incoming) : null;
    if (link && !scanned.current) { scanned.current = true; void claim(link); }
  }, [incoming]);

  // Waiting for the computer: poll every 1.5 seconds until approved, refused or expired.
  useEffect(() => {
    if (step.kind !== 'check') return;
    let live = true;
    const t = setInterval(async () => {
      try {
        const r = await pairing.status(step.link, step.claimKey);
        if (!live) return;
        if (r.state === 'approved' && r.token && r.deviceId) {
          live = false;
          haptics.success();
          await saveConnection({ url: step.link.url, token: r.token, deviceId: r.deviceId, server: r.server || step.link.name });
        } else if (r.state === 'denied') {
          live = false;
          haptics.reject();
          setStep({ kind: 'failed', message: 'Your computer refused this phone.' });
        }
      } catch (e) {
        if (!live) return;
        live = false;
        setStep({ kind: 'failed', message: e instanceof ApiError && e.status === 404 ? 'The pairing code expired after 5 minutes. Make a new one on your computer.' : (e as Error).message });
      }
    }, 1500);
    return () => { live = false; clearInterval(t); };
  }, [step]);

  const manual = () => {
    const server = cleanServerUrl(url);
    const pair = code.trim();
    if (!server) return setStep({ kind: 'failed', message: 'That address is not a web address. It looks like http://192.168.1.20:4317.' });
    if (!/^[a-f0-9]{12}\.[A-Za-z0-9_-]{20,}$/.test(pair)) return setStep({ kind: 'failed', message: 'That code is not a pairing code. Copy it from Settings, AI, Phones on your computer.' });
    void claim({ url: server, pair, name: 'Aurora' });
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: p.ground }}>
      <Ambient height={420} />
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + space.xl, paddingBottom: insets.bottom + space.xl, paddingHorizontal: space.xl }} keyboardShouldPersistTaps="handled">
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Mark size={36} />
          <T v="title" style={{ marginLeft: space.m }}>Aurora</T>
        </View>
        <T v="display" style={{ marginTop: space.xxl }}>Pair with your computer</T>
        <T v="body" c={p.ink2} style={{ marginTop: space.s }}>
          On your computer, open Aurora, then Settings, AI, Phones, and choose Pair a phone.
        </T>

        {step.kind === 'scan' && <Scanner onLink={(l) => { if (!scanned.current) { scanned.current = true; void claim(l); } }} onManual={() => setStep({ kind: 'manual' })} busy={busy} />}

        {step.kind === 'manual' && (
          <View style={{ marginTop: space.xl }}>
            <T v="over">Server address</T>
            <TextInput value={url} onChangeText={setUrl} placeholder="http://192.168.1.20:4317" placeholderTextColor={p.ink3} autoCapitalize="none" autoCorrect={false} keyboardType="url" style={[styles.input, { color: p.ink, backgroundColor: p.raised, borderColor: p.line }]} accessibilityLabel="Server address" />
            <T v="over" style={{ marginTop: space.l }}>Pairing code</T>
            <TextInput value={code} onChangeText={setCode} placeholder="Shown under the QR code" placeholderTextColor={p.ink3} autoCapitalize="none" autoCorrect={false} style={[styles.input, { color: p.ink, backgroundColor: p.raised, borderColor: p.line, fontFamily: font.monoRegular, fontSize: 14 }]} accessibilityLabel="Pairing code" />
            <View style={{ marginTop: space.xl }}>
              <Button label={busy ? 'Connecting' : 'Connect'} onPress={manual} disabled={busy} />
            </View>
            {Platform.OS !== 'web' && (
              <Pressable onPress={() => setStep({ kind: 'scan' })} style={styles.link} accessibilityRole="button">
                <Icon name="qr" color={p.lamp} size={20} />
                <T v="label" c={p.lamp} style={{ marginLeft: 8 }}>Scan the QR code instead</T>
              </Pressable>
            )}
          </View>
        )}

        {step.kind === 'check' && (
          <View style={[styles.checkCard, { backgroundColor: p.glass, borderColor: p.line }]}>
            <T v="over">Check your computer shows</T>
            <View style={{ flexDirection: 'row', marginTop: space.m }}>
              {step.check.split('').map((d, i) => (
                <View key={i} style={[styles.digit, { backgroundColor: p.raised, borderColor: p.lamp + '66' }]}>
                  <T v="hero" style={{ fontSize: 40, lineHeight: 46 }}>{d}</T>
                </View>
              ))}
            </View>
            <T v="body" c={p.ink2} style={{ marginTop: space.l }}>
              If the digits match, choose Approve on your computer. This phone can read your library, save, set aside and talk to your agent. Adding sources, AI keys and other settings stays on your computer.
            </T>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: space.l }}>
              <View style={[styles.dot, { backgroundColor: p.on }]} />
              <T v="mono" c={p.on}>{`Waiting for ${step.link.name}`}</T>
            </View>
          </View>
        )}

        {step.kind === 'failed' && (
          <View style={[styles.checkCard, { backgroundColor: p.glass, borderColor: p.warn + '55' }]}>
            <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
              <Icon name="error" color={p.warn} size={22} />
              <T v="body" style={{ marginLeft: space.s, flex: 1 }}>{step.message}</T>
            </View>
            <View style={{ marginTop: space.l }}>
              <Button kind="quiet" label="Try again" onPress={() => { scanned.current = false; setStep({ kind: Platform.OS === 'web' ? 'manual' : 'scan' }); }} />
            </View>
          </View>
        )}

        <T v="meta" style={{ marginTop: space.xxl }}>
          Your phone talks only to your own computer. Away from home, use Tailscale or an HTTPS address; docs/mobile.md explains both.
        </T>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Scanner({ onLink, onManual, busy }: { onLink: (l: PairLink) => void; onManual: () => void; busy: boolean }) {
  const p = usePalette();
  const [perm, ask] = useCameraPermissions();
  const [bad, setBad] = useState(false);
  return (
    <View style={{ marginTop: space.xl }}>
      <View style={[styles.frame, { borderColor: p.line, backgroundColor: '#000' }]}>
        {perm?.granted ? (
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={busy ? undefined : ({ data }) => {
              const link = parsePairLink(data);
              if (link) onLink(link);
              else setBad(true);
            }}
          />
        ) : (
          <View style={styles.center}>
            <Icon name="qr" color={p.ink3} size={40} />
            <T v="body" c={p.ink2} style={{ textAlign: 'center', marginTop: space.m, marginHorizontal: space.xl }}>Aurora uses the camera only to read the pairing code.</T>
            <View style={{ marginTop: space.l }}><Button label="Allow camera" onPress={() => void ask()} /></View>
          </View>
        )}
        <View pointerEvents="none" style={[styles.reticle, { borderColor: p.lamp }]} />
      </View>
      {bad && <T v="meta" c={p.warn} style={{ marginTop: space.s }}>That QR code is not an Aurora pairing code.</T>}
      <Pressable onPress={onManual} style={styles.link} accessibilityRole="button">
        <Icon name="link" color={p.lamp} size={20} />
        <T v="label" c={p.lamp} style={{ marginLeft: 8 }}>Type the address and code instead</T>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  input: { marginTop: space.s, height: 54, borderRadius: 16, borderWidth: 1, paddingHorizontal: space.l, fontFamily: font.regular, fontSize: 16 },
  link: { flexDirection: 'row', alignItems: 'center', minHeight: 48, marginTop: space.m },
  checkCard: { marginTop: space.xl, borderRadius: radius.card, borderWidth: 1, padding: space.xl },
  digit: { width: 60, height: 72, borderRadius: 18, borderWidth: 1, alignItems: 'center', justifyContent: 'center', marginRight: 10 },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: 8 },
  frame: { aspectRatio: 1, borderRadius: radius.card, borderWidth: 1, overflow: 'hidden' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  reticle: { position: 'absolute', left: '18%', right: '18%', top: '18%', bottom: '18%', borderWidth: 2, borderRadius: 28, opacity: 0.8 },
});
