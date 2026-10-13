import { useEffect, useState } from 'react';
import { Icon } from './icons.tsx';
import { useDialog } from './useDialog.ts';
import { MoreSettings } from './MoreSettings.tsx';
import { AiJobs, AiSpend, call } from './AiJobs.tsx';

export type AiTab = 'setup' | 'jobs' | 'spend';

type Provider = 'claude' | 'openai';

interface AiStatus {
  ready: boolean;
  provider: Provider;
  model: string;
  builderModel: string;
  via?: string;
  reason?: string;
  config: { provider: Provider; model: string; builderModel: string; baseUrl: string | null };
  hasKey: boolean;
}

const CLAUDE_CHAT = 'claude-sonnet-5-5';
const CLAUDE_BUILDER = 'claude-opus-5-5';

export function AiSettings({ close, toast, startTab = 'setup' }: { close: () => void; toast: (text: string, opts?: { tone?: 'info' | 'error' }) => void; startTab?: AiTab }) {
  const dlg = useDialog<HTMLDivElement>();
  const [tab, setTab] = useState<AiTab>(startTab);
  const [st, setSt] = useState<AiStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [provider, setProvider] = useState<Provider>('claude');
  const [model, setModel] = useState('');
  const [builderModel, setBuilderModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);

  const fill = (s: AiStatus) => {
    setSt(s);
    setProvider(s.config.provider);
    setModel(s.config.model ?? '');
    setBuilderModel(s.config.builderModel ?? '');
    setBaseUrl(s.config.baseUrl ?? '');
  };

  useEffect(() => {
    call<AiStatus>('GET', '/api/agent/status').then(fill).catch((e) => setLoadError((e as Error).message));
  }, []);

  const pick = (p: Provider) => {
    if (p === provider) return;
    setProvider(p);
    if (p === 'claude') {
      if (!model.startsWith('claude')) setModel(CLAUDE_CHAT);
      if (!builderModel.startsWith('claude')) setBuilderModel(CLAUDE_BUILDER);
    } else {
      if (model.startsWith('claude')) setModel('');
      if (builderModel.startsWith('claude')) setBuilderModel('');
    }
  };

  const save = async (extra?: { apiKey: string }) => {
    setBusy(true);
    try {
      const body: Record<string, unknown> = { provider, model: model.trim(), builderModel: builderModel.trim() || model.trim() };
      if (provider === 'openai') body.baseUrl = baseUrl.trim();
      if (extra) body.apiKey = extra.apiKey;
      else if (apiKey.trim()) body.apiKey = apiKey.trim();
      const next = await call<AiStatus>('PUT', '/api/agent/config', body);
      fill(next);
      setApiKey('');
      if (extra) toast('Key removed');
      else toast(next.ready ? 'AI settings saved' : `Saved. ${next.reason ?? 'The AI is not ready yet.'}`, { tone: next.ready ? 'info' : 'error' });
    } catch (e) {
      toast((e as Error).message, { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const local = provider === 'openai';
  const missing = local && (!model.trim() || !baseUrl.trim());

  return (
    <div className="sheet-backdrop" onClick={close}>
      <div ref={dlg} className="sheet ai-sheet" role="dialog" aria-modal="true" aria-label="AI settings" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>AI</h2>
          <button className="icon-btn" onClick={close} aria-label="Close"><Icon name="x" /></button>
        </div>
        <div className="sheet-body">
          <div className="seg ai-tabs" role="tablist" aria-label="AI settings sections">
            {(['setup', 'jobs', 'spend'] as const).map((t) => (
              <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
                {t === 'setup' ? 'Setup' : t === 'jobs' ? 'Models & jobs' : 'Spend'}
              </button>
            ))}
          </div>
          {tab === 'jobs' && <AiJobs toast={toast} />}
          {tab === 'spend' && <AiSpend toast={toast} />}
          {tab === 'setup' && <>
          {loadError && <p className="form-error" role="alert">{loadError}</p>}
          {st && (
            <div className={`ai-status ${st.ready ? 'ready' : 'off'}`} role="status">
              <span className="ai-status-dot" />
              <div>
                <p className="ai-status-main">{st.ready ? 'Ready' : 'Not ready'}</p>
                <p className="ai-status-sub">
                  {st.ready
                    ? <>{st.provider === 'claude' ? 'Claude' : 'OpenAI-compatible'}{st.via ? ` via ${st.via}` : ''} · {st.model}{st.builderModel && st.builderModel !== st.model ? ` · builds with ${st.builderModel}` : ''}</>
                    : st.reason ?? 'Pick a provider below and save.'}
                </p>
              </div>
            </div>
          )}

          <form className="ai-form" onSubmit={(e) => { e.preventDefault(); if (!missing) void save(); }}>
            <section className="f-sec">
              <h3>Provider</h3>
              <div className="ai-choices" role="radiogroup" aria-label="Provider">
                <button type="button" role="radio" aria-checked={!local} className={`ai-choice ${!local ? 'on' : ''}`} onClick={() => pick('claude')}>
                  <span className="ai-choice-title">Claude</span>
                  <span className="ai-choice-text">Uses an Anthropic API key, or the Claude Code login on this computer.</span>
                </button>
                <button type="button" role="radio" aria-checked={local} className={`ai-choice ${local ? 'on' : ''}`} onClick={() => pick('openai')}>
                  <span className="ai-choice-title">Local or any OpenAI-compatible</span>
                  <span className="ai-choice-text">Ollama, LM Studio, OpenRouter, or anything that speaks the OpenAI API.</span>
                </button>
              </div>
            </section>

            <section className="f-sec">
              <h3>Models</h3>
              {local && (
                <label className="ai-field">
                  <span>Endpoint URL</span>
                  <input className="f-input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://127.0.0.1:11434/v1" type="url" inputMode="url" autoCapitalize="off" spellCheck={false} />
                  <small>Ollama: http://127.0.0.1:11434/v1 · LM Studio: http://127.0.0.1:1234/v1 · OpenRouter: https://openrouter.ai/api/v1</small>
                </label>
              )}
              <label className="ai-field">
                <span>Chat model</span>
                <input className="f-input" value={model} onChange={(e) => setModel(e.target.value)} placeholder={local ? 'qwen3-coder:30b' : CLAUDE_CHAT} autoCapitalize="off" spellCheck={false} />
                <small>{local ? 'The name your server uses, e.g. qwen3-coder:30b.' : `Answers questions and reads posts. Default ${CLAUDE_CHAT}.`}</small>
              </label>
              <label className="ai-field">
                <span>Builder model</span>
                <input className="f-input" value={builderModel} onChange={(e) => setBuilderModel(e.target.value)} placeholder={local ? 'qwen3-coder:30b' : CLAUDE_BUILDER} autoCapitalize="off" spellCheck={false} />
                <small>{local ? 'Writes and repairs connectors. A strong coding model works best. Empty uses the chat model.' : `Writes and repairs connectors. Default ${CLAUDE_BUILDER}.`}</small>
              </label>
            </section>

            <section className="f-sec">
              <h3>API key</h3>
              <p className="f-hint">
                {local ? 'Only needed for hosted services like OpenRouter. Ollama and LM Studio need none.' : 'Optional. Without a key, Aurora uses the Claude Code login on this computer if there is one.'}
                {' '}Keys stay on this computer and are never shown again.
              </p>
              {st?.hasKey && (
                <p className="ai-key-saved">
                  <span>A key is saved.</span>
                  <button type="button" className="btn small ghost" disabled={busy} onClick={() => void save({ apiKey: '' })}>Remove key</button>
                </p>
              )}
              <input className="f-input" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={st?.hasKey ? 'Leave empty to keep the saved key' : local ? 'sk-or-…' : 'sk-ant-…'} autoComplete="off" aria-label="API key" />
            </section>

            <section className="f-sec">
              <h3>Privacy</h3>
              <p className="f-hint">
                With a local model, nothing leaves this computer. With Claude or another hosted service, the posts the AI reads to answer you are sent to that service (Anthropic for Claude).
              </p>
            </section>

            <div className="ai-actions">
              {missing && <p className="f-hint">{!baseUrl.trim() ? 'Add the endpoint URL.' : 'Name the model to use.'}</p>}
              <button className="btn primary" type="submit" disabled={busy || missing || !st}>{busy ? 'Saving' : 'Save'}</button>
            </div>
          </form>
          <MoreSettings toast={toast} />
          </>}
        </div>
      </div>
    </div>
  );
}
