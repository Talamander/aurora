// Under a post a friend shared with you: their note, a row of reactions and the conversation, with
// a reply box. Replies and reactions go to the friend end-to-end encrypted by your computer; the
// phone never holds friend keys. Inviting, accepting and managing friends stay on the computer.
import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Item } from '../../core/types.ts';
import { api, REACTIONS, type FriendThread as Thread } from './api';
import { ago, useStore } from './store';
import { hue, radius, space, usePalette } from './theme';
import { Avatar, Composer, T } from './ui';
import * as haptics from './haptics';

export function FriendThread({ item }: { item: Item }) {
  const p = usePalette();
  const st = useStore();
  const [t, setT] = useState<Thread | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const localId = item.externalId;

  const load = useCallback(() => {
    api.friendThread(localId).then((x) => { setT(x); setError(null); }).catch((e: Error) => setError(e.message));
  }, [localId]);
  useEffect(load, [load]);
  // A friend's reply arrives as a library change; refresh the conversation with it.
  useEffect(() => st.subscribe((e) => { if (e.type === 'library') load(); }), [st.subscribe, load]);

  const run = async (f: () => Promise<Thread>, ok?: string) => {
    setBusy(true);
    try {
      setT(await f());
      haptics.success();
      if (ok) st.notify(ok);
    } catch (e) {
      haptics.reject();
      st.notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const color = hue('aurora', p);
  if (error && !t) {
    return (
      <View style={[styles.box, { borderColor: p.line, backgroundColor: p.surface }]}>
        <T v="label" c={p.ink2}>{`Conversation unavailable: ${error}`}</T>
      </View>
    );
  }
  if (!t) return <View style={[styles.box, { borderColor: p.line, backgroundColor: p.surface, height: 120 }]} />;

  return (
    <View style={{ marginTop: space.xl }}>
      <T v="over">From a friend</T>
      {t.conversations.map((c) => {
        const live = c.peer.status === 'friend';
        const mine = c.myReaction;
        return (
          <View key={c.peer.fp} style={[styles.box, { borderColor: color + '55', backgroundColor: p.surface }]}>
            <View style={styles.head}>
              <Avatar name={c.peer.name} color={color} size={36} />
              <View style={{ marginLeft: space.m, flex: 1 }}>
                <T v="headline" lines={1}>{c.peer.name}</T>
                <T v="mono" c={p.ink3}>{`${t.direction === 'in' ? 'shared with you' : 'you shared'} · ${ago(t.at)}`}</T>
              </View>
              {c.reaction ? <Text style={styles.theirs} accessibilityLabel={`${c.peer.name} reacted ${c.reaction}`}>{c.reaction}</Text> : null}
            </View>
            {t.note ? (
              <View style={[styles.note, { backgroundColor: color + '1a' }]}>
                <T v="body" style={{ fontSize: 16.5, lineHeight: 24 }} selectable>{t.note}</T>
              </View>
            ) : null}

            {c.messages.map((m) => (
              <View key={m.id} style={[styles.bubble, m.fromMe ? { alignSelf: 'flex-end', backgroundColor: p.lamp + '26', borderBottomRightRadius: 6 } : { alignSelf: 'flex-start', backgroundColor: p.raised, borderBottomLeftRadius: 6 }]}>
                <T v="body" style={{ fontSize: 15.5, lineHeight: 22 }} selectable>{m.text}</T>
                <T v="mono" c={p.ink3} style={{ marginTop: 2, fontSize: 11 }}>{`${m.fromMe ? 'You' : c.peer.name} · ${ago(m.at)}`}</T>
              </View>
            ))}

            {live ? (
              <>
                <View style={styles.reactions} accessibilityRole="radiogroup" accessibilityLabel="React">
                  {REACTIONS.map((r) => {
                    const on = mine === r;
                    return (
                      <Pressable
                        key={r}
                        disabled={busy}
                        onPress={() => { haptics.tick(); void run(() => api.friendReact(localId, on ? '' : r, c.peer.fp)); }}
                        accessibilityRole="radio"
                        accessibilityState={{ selected: on }}
                        accessibilityLabel={on ? `Remove ${r}` : `React ${r}`}
                        style={({ pressed }) => [styles.react, { borderColor: on ? p.lamp : p.line, backgroundColor: on ? p.lamp + '22' : 'transparent' }, pressed && { transform: [{ scale: 0.92 }] }]}
                      >
                        <Text style={{ fontSize: 20 }}>{r}</Text>
                      </Pressable>
                    );
                  })}
                </View>
                <View style={{ marginTop: space.m }}>
                  <Composer placeholder={`Reply to ${c.peer.name}`} busy={busy} onSend={(text) => void run(() => api.friendReply(localId, text, c.peer.fp), 'Reply sent')} />
                </View>
              </>
            ) : (
              <T v="meta" c={p.ink3} style={{ marginTop: space.m }}>{`You are no longer friends with ${c.peer.name}.`}</T>
            )}
          </View>
        );
      })}
      <T v="meta" c={p.ink3} style={{ marginTop: space.s }}>End-to-end encrypted by your computer. Only you and your friend can read this.</T>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { marginTop: space.m, borderRadius: radius.card - 4, borderWidth: 1, padding: space.l },
  head: { flexDirection: 'row', alignItems: 'center' },
  theirs: { fontSize: 24, marginLeft: space.s },
  note: { marginTop: space.m, borderRadius: 16, padding: space.m },
  bubble: { marginTop: space.s, maxWidth: '85%', borderRadius: 18, paddingHorizontal: 14, paddingVertical: 9 },
  reactions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: space.m },
  react: { width: 44, height: 44, borderRadius: 22, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
});
