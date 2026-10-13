// The reader: one post in full, with Listen and Ask about this. The original link is always one tap away.
import { useEffect } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '../../src/Icon';
import { imgSource } from '../../src/images';
import { speaker, usePlaying } from '../../src/listen';
import { ago, isArticle, isFriendShare, personKey, readMinutes, sharesLink, useStore } from '../../src/store';
import { FriendThread } from '../../src/FriendThread';
import { font, hue, platformLabel, radius, space, usePalette } from '../../src/theme';
import { Ambient, Avatar, Button, IconButton, PlatformDot, T, TopBar } from '../../src/ui';
import { youtubeId } from '../../src/PostCard';
import { MoreLikeThis } from '../../src/Related';
import { OfflineBanner } from '../../src/Offline';
import * as haptics from '../../src/haptics';

export default function Reader() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const st = useStore();
  const playing = usePlaying();
  const { id } = useLocalSearchParams<{ id: string }>();
  const item = st.byId.get(id);

  useEffect(() => { if (item) st.markRead(item); }, [item?.id]);
  useEffect(() => () => { if (speaker && playing === id) speaker.stop(); }, []);

  if (!item) {
    return (
      <View style={{ flex: 1, backgroundColor: p.ground, paddingTop: insets.top }}>
        <TopBar back title="Post" />
        <T v="body" c={p.ink2} style={{ padding: space.l }}>This post is no longer in your library.</T>
      </View>
    );
  }

  const color = hue(item.platform, p);
  const source = st.sourceLabels[item.sourceId] ?? platformLabel(item.platform);
  const minutes = readMinutes(`${item.title ?? ''} ${item.text}`);
  const images = item.media.filter((m) => m.type === 'image' || m.thumb);
  const yt = youtubeId(item.url) ?? youtubeId(item.media.find((m) => m.type === 'video')?.url ?? '');
  const speech = `${item.title ? `${item.title}. ` : ''}${item.text}`;
  const open = () => void Linking.openURL(item.url);
  const friend = isFriendShare(item);
  const readable = !friend && (isArticle(item) || sharesLink(item));

  return (
    <View style={{ flex: 1, backgroundColor: p.ground }}>
      <Ambient height={300} />
      <ScrollView contentContainerStyle={{ paddingTop: insets.top, paddingBottom: insets.bottom + space.xxxl }}>
        <TopBar
          back
          right={
            <>
              <IconButton name={item.state.saved ? 'saved' : 'save'} label={item.state.saved ? 'Saved. Tap to unsave' : 'Save'} active={item.state.saved} onPress={() => st.save(item)} />
              <IconButton name="hide" label="Set aside" onPress={() => { st.hide(item); router.back(); }} />
              <IconButton name="open" label={`Open on ${platformLabel(item.platform)}`} onPress={open} />
            </>
          }
        />
        <OfflineBanner style={{ marginBottom: space.m }} />
        <View style={{ paddingHorizontal: space.l }}>
          <Pressable onPress={() => router.push({ pathname: '/person/[key]', params: { key: personKey(item) } })} style={styles.head} accessibilityRole="link">
            <Avatar name={item.author.name} uri={item.author.avatar} color={color} size={44} />
            <View style={{ marginLeft: space.m, flex: 1 }}>
              <T v="headline">{item.author.name}</T>
              <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 2 }}>
                <PlatformDot color={color} />
                <T v="mono" lines={1}>{`${source === item.author.name ? platformLabel(item.platform) : source} · ${ago(item.publishedAt)} · ${minutes} min read`}</T>
              </View>
            </View>
          </Pressable>
          {item.title ? <T v="display" style={{ marginTop: space.xl }} selectable>{item.title}</T> : null}
          <View style={{ flexDirection: 'row', gap: 10, marginTop: space.xl, flexWrap: 'wrap' }}>
            <Pressable
              accessibilityRole="button"
              onPress={() => { haptics.tick(); speaker.toggle(item.id, speech); }}
              style={({ pressed }) => [styles.pill, { backgroundColor: p.lamp }, pressed && { transform: [{ scale: 0.97 }] }]}
            >
              <Icon name={playing === item.id ? 'stop' : 'listen'} color={p.onLamp} size={20} />
              <T v="label" c={p.onLamp} style={{ marginLeft: 8, fontFamily: font.semibold }}>{playing === item.id ? 'Stop' : `Listen · ${minutes} min`}</T>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push({ pathname: '/agent', params: { post: item.id } })}
              style={({ pressed }) => [styles.pill, { backgroundColor: p.raised, borderColor: p.line, borderWidth: 1 }, pressed && { transform: [{ scale: 0.97 }] }]}
            >
              <Icon name="ask" color={p.lamp} size={20} />
              <T v="label" style={{ marginLeft: 8, fontFamily: font.semibold }}>Ask about this</T>
            </Pressable>
            {readable && (
              <Pressable
                accessibilityRole="button"
                accessibilityHint="Opens the article in the reader"
                onPress={() => router.push({ pathname: '/article/[id]', params: { id: item.id } })}
                style={({ pressed }) => [styles.pill, { backgroundColor: p.raised, borderColor: p.line, borderWidth: 1 }, pressed && { transform: [{ scale: 0.97 }] }]}
              >
                <Icon name="read" color={p.lamp} size={20} />
                <T v="label" style={{ marginLeft: 8, fontFamily: font.semibold }}>Read</T>
              </Pressable>
            )}
          </View>
          {images.slice(0, 6).map((m, i) => (
            <View key={i} style={styles.media}>
              <Image source={imgSource(m.thumb && i > 0 ? m.thumb : m.url)} placeholder={m.thumb ? imgSource(m.thumb) : undefined} style={StyleSheet.absoluteFill} contentFit="cover" cachePolicy="memory-disk" transition={200} accessibilityLabel={m.alt || undefined} />
            </View>
          ))}
          {yt && !images.length && (
            <Pressable onPress={open} style={styles.media} accessibilityRole="link" accessibilityLabel="Play on YouTube">
              <Image source={{ uri: `https://i.ytimg.com/vi/${yt}/hqdefault.jpg` }} style={StyleSheet.absoluteFill} contentFit="cover" cachePolicy="memory-disk" />
            </Pressable>
          )}
          {!friend && item.text.split(/\n{2,}/).filter((x) => x.trim()).map((para, i) => (
            <T key={i} v="body" style={{ marginTop: space.l, fontSize: 17.5, lineHeight: 28 }} selectable>{para.trim()}</T>
          ))}
          {item.quoted && (
            <View style={[styles.quote, { borderColor: p.line, backgroundColor: p.surface }]}>
              <T v="label" style={{ fontFamily: font.semibold }}>{item.quoted.author.name}</T>
              <T v="body" c={p.ink2} style={{ marginTop: 4 }} selectable>{item.quoted.text}</T>
            </View>
          )}
          {friend && <FriendThread item={item} />}
          {!friend && <MoreLikeThis item={item} />}
          <View style={{ marginTop: space.xxl }}>
            <Button kind="quiet" icon="open" label={`Open on ${platformLabel(item.platform)}`} onPress={open} />
          </View>
          <T v="mono" style={{ marginTop: space.l }}>{`Imported by ${item.provenance.connector} · ${item.provenance.via}${item.isDemo ? ' · demo post' : ''}`}</T>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', minHeight: 48 },
  pill: { flexDirection: 'row', alignItems: 'center', height: 48, borderRadius: radius.chip, paddingHorizontal: 18 },
  media: { marginTop: space.l, borderRadius: radius.media, overflow: 'hidden', aspectRatio: 4 / 3, backgroundColor: '#0c0e14' },
  quote: { marginTop: space.l, borderRadius: 18, borderWidth: 1, padding: space.l },
});
