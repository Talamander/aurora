// A post in the feed: a glass card lit from behind by its own picture (or its platform's hue),
// with save, set aside and ask, and the reason it is on screen.
import { memo, useState } from 'react';
import { Linking, Pressable, StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import type { Item, Media } from '../../core/types.ts';
import { Icon } from './Icon';
import { imgSource } from './images';
import { ago, firstImage, isArticle, personKey } from './store';
import { font, hue, platformLabel, radius, space, type Palette } from './theme';
import { Avatar, IconButton, Orb, PlatformDot, T, WhyPill } from './ui';
import { useSettings } from './settings';

export function youtubeId(url: string): string | null {
  try {
    const u = new URL(url);
    if (/(^|\.)youtube\.com$/.test(u.hostname)) {
      if (u.pathname === '/watch') return u.searchParams.get('v');
      const m = /^\/(shorts|embed|live)\/([\w-]{6,})/.exec(u.pathname);
      return m ? m[2] : null;
    }
    if (u.hostname === 'youtu.be') return u.pathname.slice(1) || null;
  } catch { /* not a URL */ }
  return null;
}

const directVideo = (url: string) => /^https:\/\/.+\.(mp4|webm|mov|m3u8)(\?|$)/i.test(url);

/** Direct video files and HLS play inline; YouTube opens in its app (no embed SDK on phones). */
function InlineVideo({ media, poster }: { media: Media; poster?: string | null }) {
  const [on, setOn] = useState(false);
  const { autoplay } = useSettings();
  if (!on) {
    return (
      <Pressable accessibilityRole="button" accessibilityLabel="Play video" onPress={() => setOn(true)} style={styles.media}>
        {poster ? <Image source={imgSource(poster)} style={StyleSheet.absoluteFill} contentFit="cover" cachePolicy="memory-disk" transition={150} /> : null}
        <PlayBadge />
      </Pressable>
    );
  }
  return <Player url={media.url} muted={!autoplay} />;
}

function Player({ url, muted }: { url: string; muted: boolean }) {
  const player = useVideoPlayer(url, (pl) => { pl.muted = muted; pl.loop = false; pl.play(); });
  return <VideoView player={player} style={styles.media} nativeControls contentFit="contain" allowsPictureInPicture />;
}

function PlayBadge() {
  return (
    <View style={styles.playWrap}>
      <View style={styles.play}><Icon name="play" color="#0b0d12" size={30} /></View>
    </View>
  );
}

function MediaBlock({ item }: { item: Item }) {
  const video = item.media.find((m) => m.type === 'video');
  const yt = youtubeId(video?.url ?? item.url);
  const img = firstImage(item);
  if (video && directVideo(video.url)) return <InlineVideo media={video} poster={video.thumb ?? img} />;
  if (yt) {
    // The library's own picture goes through the proxy; YouTube's poster is not in the library.
    const poster = img ? imgSource(img) : { uri: `https://i.ytimg.com/vi/${yt}/hqdefault.jpg` };
    return (
      <Pressable accessibilityRole="link" accessibilityLabel="Play on YouTube" onPress={() => void Linking.openURL(item.url)} style={styles.media}>
        <Image source={poster} style={StyleSheet.absoluteFill} contentFit="cover" cachePolicy="memory-disk" transition={150} />
        <PlayBadge />
      </Pressable>
    );
  }
  if (!img) return null;
  const alt = item.media.find((m) => m.type === 'image')?.alt;
  return (
    <View style={styles.media}>
      <Image source={imgSource(img)} style={StyleSheet.absoluteFill} contentFit="cover" cachePolicy="memory-disk" transition={150} recyclingKey={item.id} accessibilityLabel={alt || undefined} />
    </View>
  );
}

interface Props {
  item: Item;
  why: string;
  source: string;
  p: Palette;
  onSave: (i: Item) => void;
  onHide: (i: Item) => void;
  /** Member ids, oldest first, when this card stands for a thread. */
  thread?: string[] | null;
}

export const PostCard = memo(function PostCard({ item, why, source, p, onSave, onHide, thread }: Props) {
  const color = hue(item.platform, p);
  const img = firstImage(item);
  const title = item.title?.trim();
  const body = item.text.trim();
  // Feeds and web pages are named by their source ("The Verge"), platforms by the platform ("Bluesky").
  const platform = item.platform === 'rss' || item.platform === 'web' ? (source === item.author.name ? platformLabel(item.platform) : source) : platformLabel(item.platform);
  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={() => (thread ? router.push({ pathname: '/article/[id]', params: { id: thread[0] } }) : isArticle(item) ? router.push({ pathname: '/article/[id]', params: { id: item.id } }) : router.push({ pathname: '/post/[id]', params: { id: item.id } }))}
        accessibilityRole="button"
        accessibilityHint={thread ? `Opens the thread of ${thread.length} posts as one article` : isArticle(item) ? 'Opens the article in the reader' : 'Opens the post'}
        style={[styles.card, { backgroundColor: p.glass, borderColor: p.line }]}
      >
        {/* The aura: the post's own picture, blurred, inside the glass so the card clips its edges. No picture: the platform's hue. */}
        {img ? (
          <Image source={imgSource(img)} blurRadius={40} cachePolicy="memory-disk" style={[styles.aura, { opacity: p.auraOpacity * 0.55 }]} contentFit="cover" />
        ) : (
          <Orb color={color} size={60} opacity={p.mode === 'dark' ? 0.16 : 0.08} style={{ left: '40%', top: '35%' }} />
        )}
        <Pressable onPress={() => router.push({ pathname: '/person/[key]', params: { key: personKey(item) } })} style={styles.head} accessibilityRole="link" accessibilityLabel={`${item.author.name}, see their posts`}>
          <Avatar name={item.author.name} uri={item.author.avatar} color={color} />
          <View style={{ marginLeft: space.m, flex: 1 }}>
            <T v="headline" lines={1}>{item.author.name}</T>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 2 }}>
              <PlatformDot color={color} />
              <T v="mono" lines={1}>{`${platform} · ${ago(item.publishedAt)}`}</T>
            </View>
          </View>
        </Pressable>
        {title ? <T v="title" style={{ marginTop: space.m, fontSize: 19, lineHeight: 24 }} lines={3}>{title}</T> : null}
        {body && body !== title ? <T v="body" c={title ? p.ink2 : p.ink} style={{ marginTop: title ? 6 : space.m, fontSize: title ? 15 : 16.5, lineHeight: title ? 21 : 24 }} lines={title ? 3 : 7}>{body}</T> : null}
        {item.quoted ? (
          <View style={[styles.quoted, { borderColor: p.line, backgroundColor: p.mode === 'dark' ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.025)' }]}>
            <T v="label" lines={1} style={{ fontFamily: font.semibold }}>{item.quoted.author.name}</T>
            <T v="body" c={p.ink2} style={{ marginTop: 2, fontSize: 15, lineHeight: 21 }} lines={4}>{item.quoted.text}</T>
          </View>
        ) : null}
        <MediaBlock item={item} />
        {thread ? (
          <View style={[styles.thread, { borderColor: p.line }]}>
            <View style={[styles.threadKnot, { borderColor: color }]} />
            <T v="label" c={p.ink2} lines={1} style={{ fontFamily: font.semibold }}>{`Thread · ${thread.length} posts · read it as one`}</T>
          </View>
        ) : null}
        <View style={styles.actions}>
          <IconButton name={item.state.saved ? 'saved' : 'save'} label={item.state.saved ? 'Saved. Tap to unsave' : 'Save'} active={item.state.saved} onPress={() => onSave(item)} />
          <IconButton name="hide" label="Set aside" onPress={() => onHide(item)} />
          <IconButton name="ask" label="Ask about this post" onPress={() => router.push({ pathname: '/agent', params: { post: item.id } })} />
          <View style={{ flex: 1, minWidth: 0, alignItems: 'flex-end', marginLeft: space.s, overflow: 'hidden' }}>
            <WhyPill text={why} />
          </View>
        </View>
      </Pressable>
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: { marginHorizontal: space.l, marginBottom: space.l },
  aura: { position: 'absolute', left: -40, right: -40, top: -40, bottom: -40 },
  card: { borderRadius: radius.card, borderWidth: 1, padding: space.l, paddingBottom: space.s, overflow: 'hidden' },
  head: { flexDirection: 'row', alignItems: 'center', minHeight: 48 },
  media: { marginTop: space.m, borderRadius: radius.media, overflow: 'hidden', aspectRatio: 16 / 10, backgroundColor: '#0c0e14' },
  quoted: { marginTop: space.m, borderRadius: 16, borderWidth: 1, padding: space.m },
  thread: { marginTop: space.m, flexDirection: 'row', alignItems: 'center', gap: space.s, alignSelf: 'flex-start', borderWidth: 1, borderRadius: 999, paddingVertical: 6, paddingHorizontal: space.m },
  threadKnot: { width: 10, height: 10, borderRadius: 5, borderWidth: 2 },
  actions: { flexDirection: 'row', alignItems: 'center', marginTop: space.s, marginLeft: -10 },
  playWrap: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  play: { width: 64, height: 64, borderRadius: 32, backgroundColor: 'rgba(255,255,255,0.92)', alignItems: 'center', justifyContent: 'center', boxShadow: '0 6px 20px rgba(0,0,0,0.4)' },
});
