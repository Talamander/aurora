// A link shared to Aurora lands here: aurora://follow?url=<link>, or ?text=<shared text> from the
// Android share sheet (plugins/withShareTarget.js turns a shared link into this address). It fills
// in "Follow this: <link>" in the agent box and stops there: nothing is sent until Send is pressed.
// The shared text is untrusted; only the first http(s) link in it is used.
import { Redirect, useLocalSearchParams } from 'expo-router';
import * as Linking from 'expo-linking';

function sharedLink(raw: string | undefined): string | null {
  if (!raw) return null;
  const m = /https?:\/\/[^\s<>"']+/i.exec(raw);
  if (!m) return null;
  try {
    const u = new URL(m[0].replace(/[).,;!?]+$/, ''));
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString().slice(0, 2000) : null;
  } catch {
    return null;
  }
}

export default function Follow() {
  const params = useLocalSearchParams<{ url?: string; text?: string }>();
  const fromUrl = Linking.useLinkingURL();
  const q = fromUrl ? Linking.parse(fromUrl).queryParams ?? {} : {};
  const pick = (v: unknown) => (typeof v === 'string' ? v : Array.isArray(v) ? String(v[0] ?? '') : undefined);
  const link = sharedLink(params.url ?? params.text ?? pick(q.url) ?? pick(q.text));
  if (!link) return <Redirect href="/agent" />;
  return <Redirect href={{ pathname: '/agent', params: { prefill: `Follow this: ${link}` } }} />;
}
