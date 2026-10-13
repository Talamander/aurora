// Shared pieces: type, the lit gradient, glows, chips, the receipt, the composer, headers.
import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, Platform, Pressable, StyleSheet, Text, TextInput, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon, type IconName } from './Icon';
import { imgSource } from './images';
import { font, radius, space, target, usePalette, type Palette } from './theme';
import { useSettings } from './settings';
import * as haptics from './haptics';

// ---------------------------------------------------------------- type

type Variant = 'hero' | 'display' | 'title' | 'headline' | 'body' | 'bodyStrong' | 'label' | 'meta' | 'mono' | 'over';
const TYPE: Record<Variant, TextStyle> = {
  hero: { fontFamily: font.bold, fontSize: 40, lineHeight: 42, letterSpacing: -1.6 },
  display: { fontFamily: font.bold, fontSize: 30, lineHeight: 33, letterSpacing: -1.0 },
  title: { fontFamily: font.semibold, fontSize: 22, lineHeight: 27, letterSpacing: -0.4 },
  headline: { fontFamily: font.semibold, fontSize: 17, lineHeight: 22, letterSpacing: -0.2 },
  body: { fontFamily: font.regular, fontSize: 16, lineHeight: 23 },
  bodyStrong: { fontFamily: font.medium, fontSize: 16, lineHeight: 23 },
  label: { fontFamily: font.medium, fontSize: 14, lineHeight: 18 },
  meta: { fontFamily: font.regular, fontSize: 13, lineHeight: 17 },
  mono: { fontFamily: font.monoRegular, fontSize: 12.5, lineHeight: 16 },
  over: { fontFamily: font.mono, fontSize: 11.5, lineHeight: 14, letterSpacing: 1.2, textTransform: 'uppercase' },
};

export function T({ v = 'body', c, style, children, lines, selectable }: { v?: Variant; c?: string; style?: StyleProp<TextStyle>; children: ReactNode; lines?: number; selectable?: boolean }) {
  const p = usePalette();
  const color = c ?? (v === 'meta' || v === 'mono' || v === 'over' ? p.ink3 : p.ink);
  return (
    <Text style={[TYPE[v], { color }, style]} numberOfLines={lines} selectable={selectable}>
      {children}
    </Text>
  );
}

/** The number in the lit gradient. Web paints it with background-clip; phones fall back to the lamp. */
export function LitText({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  const p = usePalette();
  if (Platform.OS === 'web') {
    const web = {
      backgroundImage: `linear-gradient(100deg, ${p.lit[0]}, ${p.lit[1]} 55%, ${p.lit[2]})`,
      WebkitBackgroundClip: 'text',
      backgroundClip: 'text',
      color: 'transparent',
    } as unknown as TextStyle;
    return <Text style={[style, web]}>{children}</Text>;
  }
  return <Text style={[style, { color: p.lit[0] }]}>{children}</Text>;
}

// ---------------------------------------------------------------- light

/** A soft round glow: a small coloured disc with a wide blurred shadow. */
export const Orb = memo(function Orb({ color, size, style, opacity = 1 }: { color: string; size: number; style?: StyleProp<ViewStyle>; opacity?: number }) {
  return (
    <View
      pointerEvents="none"
      style={[
        { position: 'absolute', width: size, height: size, borderRadius: size, backgroundColor: color, opacity, boxShadow: `0 0 ${Math.round(size * 0.9)}px ${Math.round(size * 0.6)}px ${color}` },
        style,
      ]}
    />
  );
});

/** The ambient light at the top of a screen: warm left, violet right, fading into the ground. */
/** The light behind a screen's top. A profile's accent (tint) takes the place of the left glow. */
export function Ambient({ height = 320, tint }: { height?: number; tint?: string | null }) {
  const p = usePalette();
  const k = p.mode === 'dark' ? 0.22 : 0.12;
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { height, overflow: 'hidden' }]}>
      <Orb color={tint ?? p.lit[1]} size={90} opacity={tint ? k * 1.25 : k} style={{ top: -60, left: -20 }} />
      <Orb color={p.lit[2]} size={80} opacity={k * 0.8} style={{ top: -50, right: -10 }} />
      <LinearGradient colors={['transparent', p.ground]} style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: height * 0.6 }} />
    </View>
  );
}

// ---------------------------------------------------------------- headers

export function TopBar({ title, back, right, mark }: { title?: string; back?: boolean; right?: ReactNode; mark?: boolean }) {
  return (
    <View style={s.topbar}>
      {back && (
        <IconButton name="back" label="Back" onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
      )}
      {mark && <Mark size={34} />}
      {title ? <T v="title" style={{ flex: 1, marginLeft: back || mark ? space.m : 0 }} lines={1}>{title}</T> : <View style={{ flex: 1 }} />}
      {right}
    </View>
  );
}

/** The Aurora mark (the arc over the night sky). With a ring colour, the active profile's accent
 *  draws a thin halo around it. */
export function Mark({ size = 34, ring }: { size?: number; ring?: string }) {
  const img = <Image source={require('../assets/mark.png')} style={{ width: size, height: size }} contentFit="contain" accessibilityLabel="Aurora" />;
  if (!ring) return img;
  return <View style={{ padding: 2, borderRadius: size * 0.34, borderWidth: 1.5, borderColor: ring }}>{img}</View>;
}

export function IconButton({ name, label, onPress, color, active }: { name: IconName; label: string; onPress: () => void; color?: string; active?: boolean }) {
  const p = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={4}
      onPress={onPress}
      android_ripple={{ color: p.line, borderless: true, radius: 22 }}
      style={({ pressed }) => [s.iconBtn, pressed && Platform.OS !== 'android' && { opacity: 0.55 }]}
    >
      <Icon name={name} color={color ?? (active ? p.lamp : p.ink2)} size={22} />
    </Pressable>
  );
}

// ---------------------------------------------------------------- chips and pills

export function Chip({ label, count, on, onPress }: { label: string; count?: number; on?: boolean; onPress: () => void }) {
  const p = usePalette();
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: !!on }}
      onPress={onPress}
      style={({ pressed }) => [
        s.chip,
        { backgroundColor: on ? (p.mode === 'dark' ? '#2a1d17' : '#fbe7dc') : p.raised, borderColor: on ? p.lamp + '88' : p.line },
        pressed && { transform: [{ scale: 0.97 }] },
      ]}
    >
      <T v="label" c={on ? p.ink : p.ink2} style={{ fontFamily: font.medium }}>{label}</T>
      {count !== undefined && <T v="mono" c={on ? p.ink2 : p.ink3} style={{ marginLeft: 8 }}>{count.toLocaleString()}</T>}
    </Pressable>
  );
}

/** "lit by #aiandmodels": why the post is here, in mono on a teal tint. */
export function WhyPill({ text }: { text: string }) {
  const p = usePalette();
  return (
    <View style={[s.why, { backgroundColor: p.mode === 'dark' ? 'rgba(79,224,198,0.10)' : 'rgba(10,138,115,0.09)' }]}>
      <T v="mono" c={p.on} lines={1}>{text}</T>
    </View>
  );
}

export function PlatformDot({ color }: { color: string }) {
  return <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: color, marginRight: 6 }} />;
}

// ---------------------------------------------------------------- composer

/** The agent box. A `draft` (a shared link, say) fills it in; nothing is sent until Send is pressed. */
export function Composer({ placeholder, onSend, busy, autoFocus, draft }: { placeholder: string; onSend: (text: string) => void; busy?: boolean; autoFocus?: boolean; draft?: { text: string; at: number } | null }) {
  const p = usePalette();
  const [text, setText] = useState('');
  const input = useRef<TextInput>(null);
  useEffect(() => {
    if (!draft?.text) return;
    setText(draft.text);
    input.current?.focus();
  }, [draft?.at]);
  const send = () => {
    const t = text.trim();
    if (!t || busy) return;
    haptics.confirm();
    onSend(t);
    setText('');
  };
  return (
    <View style={[s.composer, { backgroundColor: p.mode === 'dark' ? 'rgba(20,22,30,0.94)' : 'rgba(255,255,255,0.96)', borderColor: p.line, boxShadow: p.mode === 'dark' ? `0 10px 30px rgba(0,0,0,0.55), 0 0 0 1px ${p.lamp}22` : '0 8px 24px rgba(20,24,40,0.14)' }]}>
      <Icon name="ask" color={p.lamp} size={22} />
      <TextInput
        ref={input}
        value={text}
        onChangeText={setText}
        onSubmitEditing={send}
        placeholder={placeholder}
        placeholderTextColor={p.ink3}
        returnKeyType="send"
        autoFocus={autoFocus}
        style={[s.composerInput, { color: p.ink }]}
        accessibilityLabel={placeholder}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Send"
        onPress={send}
        style={({ pressed }) => [s.send, { backgroundColor: text.trim() && !busy ? p.lamp : p.raised }, pressed && { transform: [{ scale: 0.94 }] }]}
      >
        <Icon name="send" color={text.trim() && !busy ? p.onLamp : p.ink3} size={22} />
      </Pressable>
    </View>
  );
}

// ---------------------------------------------------------------- receipt

/** The set-aside receipt: holds at the foot of the screen for 6 seconds, with Undo. */
export function ReceiptBar({ id, text, undo, onDone, bottom }: { id: number; text: string; undo?: () => void; onDone: () => void; bottom: number }) {
  const p = usePalette();
  const { reduceMotion } = useSettings();
  const y = useRef(new Animated.Value(reduceMotion ? 0 : 24)).current;
  useEffect(() => {
    y.setValue(reduceMotion ? 0 : 24);
    Animated.spring(y, { toValue: 0, useNativeDriver: Platform.OS !== 'web', damping: 18, stiffness: 220 }).start();
    const t = setTimeout(onDone, 6000);
    return () => clearTimeout(t);
  }, [id]);
  return (
    <Animated.View style={[s.receipt, { bottom, backgroundColor: p.mode === 'dark' ? '#1b1e27' : '#11131a', transform: [{ translateY: y }] }]} accessibilityLiveRegion="polite">
      <T v="label" c="#eef0f6" style={{ flex: 1 }} lines={2}>{text}</T>
      {undo && (
        <Pressable accessibilityRole="button" onPress={undo} hitSlop={10} style={{ paddingHorizontal: 10, minHeight: target, justifyContent: 'center' }}>
          <T v="label" c="#ffad7a" style={{ fontFamily: font.semibold }}>Undo</T>
        </Pressable>
      )}
    </Animated.View>
  );
}

// ---------------------------------------------------------------- misc

export function Avatar({ name, uri, color, size = 40 }: { name: string; uri?: string; color: string; size?: number }) {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';
  const [failed, setFailed] = useState(false);
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, borderWidth: 2, borderColor: color + 'cc', padding: 2 }}>
      {uri && !failed ? (
        <Image source={imgSource(uri)} style={{ flex: 1, borderRadius: size }} cachePolicy="memory-disk" onError={() => setFailed(true)} recyclingKey={uri} />
      ) : (
        <LinearGradient colors={[color, color + '99']} style={{ flex: 1, borderRadius: size, alignItems: 'center', justifyContent: 'center' }}>
          <T v="label" c="#fff" style={{ fontFamily: font.semibold, fontSize: size * 0.34 }}>{initials}</T>
        </LinearGradient>
      )}
    </View>
  );
}

export function Card({ children, style, p }: { children: ReactNode; style?: StyleProp<ViewStyle>; p: Palette }) {
  return <View style={[s.card, { backgroundColor: p.glass, borderColor: p.line }, style]}>{children}</View>;
}

export function Button({ label, onPress, kind = 'primary', icon, disabled }: { label: string; onPress: () => void; kind?: 'primary' | 'quiet' | 'danger'; icon?: IconName; disabled?: boolean }) {
  const p = usePalette();
  const bg = kind === 'primary' ? p.lamp : p.raised;
  const fg = kind === 'primary' ? p.onLamp : kind === 'danger' ? p.warn : p.ink;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [s.button, { backgroundColor: bg, opacity: disabled ? 0.5 : 1 }, pressed && { transform: [{ scale: 0.98 }] }]}
    >
      {icon && <Icon name={icon} color={fg} size={20} />}
      <T v="label" c={fg} style={{ fontFamily: font.semibold, fontSize: 15, marginLeft: icon ? 8 : 0 }}>{label}</T>
    </Pressable>
  );
}

export function useBottomInset(): number {
  return useSafeAreaInsets().bottom;
}

export const s = StyleSheet.create({
  topbar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.l, minHeight: 64 },
  iconBtn: { width: target, height: target, alignItems: 'center', justifyContent: 'center', borderRadius: target / 2 },
  chip: { flexDirection: 'row', alignItems: 'center', height: 40, paddingHorizontal: 16, borderRadius: radius.chip, borderWidth: 1, marginRight: 8 },
  why: { borderRadius: radius.chip, paddingHorizontal: 12, paddingVertical: 7, flexShrink: 1, maxWidth: '100%' },
  composer: { flexDirection: 'row', alignItems: 'center', borderRadius: radius.chip, borderWidth: 1, paddingLeft: 18, paddingRight: 6, height: 60 },
  composerInput: { flex: 1, fontFamily: font.regular, fontSize: 16, marginLeft: 12, height: 56, outlineStyle: 'none' } as unknown as TextStyle,
  send: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  receipt: { position: 'absolute', left: space.l, right: space.l, flexDirection: 'row', alignItems: 'center', borderRadius: 18, paddingLeft: 18, paddingRight: 6, minHeight: 56, boxShadow: '0 10px 30px rgba(0,0,0,0.45)' },
  card: { borderRadius: radius.card, borderWidth: 1, overflow: 'hidden' },
  button: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', minHeight: 52, borderRadius: radius.chip, paddingHorizontal: 22 },
});
