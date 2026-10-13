// The agent: the same conversation as the desktop's, streamed live over the event stream.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { AgentEvent, AgentThread } from '../../../core/types.ts';
import { api } from '../../src/api';
import { CitedRow, citedIds, RichText } from '../../src/Rich';
import { useStore } from '../../src/store';
import { TAB_HEIGHT } from '../../src/TabBar';
import { radius, space, usePalette } from '../../src/theme';
import { Ambient, Chip, Composer, IconButton, T, TopBar } from '../../src/ui';
import * as haptics from '../../src/haptics';

const SUGGESTIONS = ['What were people talking about today?', 'Hide anything about crypto or giveaways', 'Make a page of the best photos from this week'];

export default function Agent() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const st = useStore();
  const params = useLocalSearchParams<{ ask?: string; post?: string; prefill?: string }>();
  const [draft, setDraft] = useState<{ text: string; at: number } | null>(null);
  const [thread, setThread] = useState<AgentThread | null>(null);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [stream, setStream] = useState('');
  const [running, setRunning] = useState(false);
  const [ready, setReady] = useState<{ ready: boolean; reason?: string } | null>(null);
  const [sending, setSending] = useState(false);
  const scroll = useRef<ScrollView>(null);
  const handled = useRef<string | null>(null);
  const floating = Platform.OS === 'ios' ? insets.bottom + TAB_HEIGHT - 12 : 0;

  const load = useCallback(async (id: string) => {
    const r = await api.thread(id);
    setThread(r.thread);
    setEvents(r.events);
    setRunning(r.running);
  }, []);

  // Open the most recent conversation, like the desktop does.
  useEffect(() => {
    api.agentStatus().then(setReady).catch(() => setReady({ ready: false, reason: 'Cannot reach your computer' }));
    api.threads().then((list) => { const last = list.find((t) => t.kind === 'chat'); if (last && !params.ask && !params.post && !params.prefill) void load(last.id); }).catch(() => {});
  }, []);

  useEffect(
    () =>
      st.subscribe((e) => {
        if (!thread) return;
        if (e.type === 'agent' && e.threadId === thread.id) {
          const ev = { ...e.event, threadId: e.threadId };
          setEvents((s) => (s.some((x) => x.id === ev.id) ? s : [...s, ev]));
          if (ev.type === 'assistant') setStream('');
        } else if (e.type === 'delta' && e.threadId === thread.id) {
          setStream((s) => s + e.text);
        } else if (e.type === 'thread' && e.threadId === thread.id) {
          setRunning(e.status === 'running');
          if (e.status !== 'running') { setStream(''); haptics.tick(); }
        }
      }),
    [st.subscribe, thread],
  );

  const send = useCallback(
    async (text: string, postId?: string) => {
      if (sending) return;
      setSending(true);
      try {
        let t = thread;
        if (!t) { t = await api.newThread(); setThread(t); setEvents([]); }
        const lens = st.lenses.find((l) => l.id === st.lensId);
        await api.send(t.id, text, { screen: 'phone', viewName: lens?.name ?? null, shown: st.result?.visible.length ?? 0, selectedPostId: postId ?? null });
        setRunning(true);
        // The user's message arrives over the event stream; show it at once in case the stream lags.
        setEvents((s) => [...s, { id: -Date.now(), threadId: t!.id, at: new Date().toISOString(), type: 'user', data: { text } }]);
      } catch (e) {
        haptics.reject();
        st.notify((e as Error).message);
      } finally {
        setSending(false);
      }
    },
    [thread, sending, st],
  );

  // Handed over from the feed composer or a post's Ask button.
  useEffect(() => {
    const key = `${params.ask ?? ''}|${params.post ?? ''}`;
    if (key === '|' || handled.current === key || !ready?.ready) return;
    handled.current = key;
    const it = params.post ? st.byId.get(params.post) : undefined;
    const text = params.ask || (it ? `What is this post about, and why does it matter? [[post:${it.id}]]` : '');
    setThread(null);
    setEvents([]);
    if (text) void send(text, it?.id);
    router.setParams({ ask: undefined, post: undefined });
  }, [params.ask, params.post, ready]);

  // A link shared to Aurora (follow.tsx): fill in the box, in a fresh conversation, and wait for Send.
  useEffect(() => {
    if (!params.prefill) return;
    setThread(null);
    setEvents([]);
    setStream('');
    setDraft({ text: params.prefill, at: Date.now() });
    haptics.tick();
    router.setParams({ prefill: undefined });
  }, [params.prefill]);

  // Drop the optimistic copy once the server's own user event arrives.
  const shown = events.filter((e, i) => !(e.id < 0 && events.slice(i + 1).some((x) => x.type === 'user' && x.data?.text === e.data?.text)));

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: p.ground }}>
      <Ambient height={260} />
      <View style={{ paddingTop: insets.top }}>
        <TopBar title={thread?.title || 'Agent'} right={<>
          <IconButton name="clock" label="Routines" onPress={() => router.push('/routines')} />
          <IconButton name="ask" label="New conversation" onPress={() => { setThread(null); setEvents([]); setStream(''); haptics.tick(); }} />
        </>} />
      </View>
      <ScrollView
        ref={scroll}
        contentContainerStyle={{ paddingHorizontal: space.l, paddingBottom: floating + 100 }}
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}
        keyboardShouldPersistTaps="handled"
      >
        {!shown.length && !stream && (
          <View style={{ marginTop: space.xl }}>
            <T v="display">Ask about your feed</T>
            <T v="body" c={p.ink2} style={{ marginTop: space.s }}>
              {ready && !ready.ready ? `${ready.reason ?? 'AI is not set up'}. Set it up on your computer: Settings, AI.` : `Your agent reads the ${st.lib?.items.length ?? 0} posts on your computer and answers with the posts it used.`}
            </T>
            <View style={{ marginTop: space.xl, flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {SUGGESTIONS.map((s) => (
                <Chip key={s} label={s} onPress={() => void send(s)} />
              ))}
            </View>
          </View>
        )}
        {shown.map((e) => {
          if (e.type === 'user') {
            return (
              <View key={e.id} style={[styles.user, { backgroundColor: p.raised }]}>
                <RichText text={String(e.data?.text ?? '')} byId={st.byId} />
              </View>
            );
          }
          if (e.type === 'assistant') {
            const text = String(e.data?.text ?? '');
            return (
              <View key={e.id} style={{ marginTop: space.xl }}>
                <RichText text={text} byId={st.byId} />
                <CitedRow ids={citedIds(text)} byId={st.byId} />
              </View>
            );
          }
          if (e.type === 'tool_call') {
            return (
              <View key={e.id} style={styles.step}>
                <View style={[styles.dot, { backgroundColor: p.on }]} />
                <T v="mono" c={p.on} lines={1}>{String(e.data?.label ?? e.data?.name ?? 'Working')}</T>
              </View>
            );
          }
          if (e.type === 'error') {
            return <T key={e.id} v="body" c={p.warn} style={{ marginTop: space.l }}>{String(e.data?.text ?? 'Something went wrong')}</T>;
          }
          return null;
        })}
        {stream ? <View style={{ marginTop: space.xl }}><RichText text={stream} byId={st.byId} /></View> : null}
        {running && !stream && (
          <View style={[styles.step, { marginTop: space.l }]}>
            <ActivityIndicator size="small" color={p.lamp} />
            <T v="mono" style={{ marginLeft: 8 }}>{`Reading ${st.lib?.items.length ?? 0} posts`}</T>
          </View>
        )}
      </ScrollView>
      <View style={{ position: 'absolute', left: space.l, right: space.l, bottom: floating + 12 }}>
        <Composer placeholder={shown.length ? 'Ask a follow-up' : 'Ask about your feed'} onSend={(t) => void send(t)} busy={sending || ready?.ready === false} draft={draft} />
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  user: { alignSelf: 'flex-end', maxWidth: '86%', borderRadius: radius.card - 4, borderBottomRightRadius: 8, paddingHorizontal: space.l, paddingVertical: space.m, marginTop: space.xl },
  step: { flexDirection: 'row', alignItems: 'center', marginTop: space.m },
  dot: { width: 7, height: 7, borderRadius: 4, marginRight: 8 },
});
