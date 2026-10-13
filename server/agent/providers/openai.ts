// Any OpenAI-compatible chat endpoint: Ollama, LM Studio, OpenRouter, OpenAI. Our own tool loop.

import { z } from 'zod';
import type { ProviderResult, ProviderRun } from '../types.ts';

interface Msg {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export async function runOpenAI(run: ProviderRun, opts: { baseUrl: string; apiKey: string | null }): Promise<ProviderResult> {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const tools = run.tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description.slice(0, 1000), parameters: z.toJSONSchema(z.object(t.shape)) },
  }));
  const messages: Msg[] = [
    { role: 'system', content: run.system },
    ...run.history.slice(-20).map((h) => ({ role: h.role, content: h.text }) as Msg),
    { role: 'user', content: run.prompt },
  ];
  let text = '';
  const max = run.maxTurns ?? 30;
  // Token counts and cost add up over every turn of the loop. Hosted services like OpenRouter
  // report a cost; local servers report none and are counted as free by the caller.
  let inTokens = 0;
  let outTokens = 0;
  let cost: number | undefined;
  const done = (t: string, turns: number): ProviderResult => ({ text: t, turns, inTokens, outTokens, costUsd: cost });
  for (let turn = 0; turn < max; turn++) {
    if (run.signal.aborted) throw new Error('Stopped');
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}) },
      body: JSON.stringify({ model: run.model, messages, ...(tools.length ? { tools, tool_choice: 'auto' } : {}) }),
      signal: run.signal,
    });
    if (!res.ok) throw new Error(`Model endpoint answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data: any = await res.json();
    inTokens += Number(data.usage?.prompt_tokens) || 0;
    outTokens += Number(data.usage?.completion_tokens) || 0;
    if (typeof data.usage?.cost === 'number') cost = (cost ?? 0) + data.usage.cost;
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error('Model endpoint returned no message');
    messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: msg.tool_calls });
    if (msg.content?.trim()) {
      run.onDelta(msg.content);
      run.ctx.emit('assistant', { text: msg.content });
      text = msg.content;
    }
    if (!msg.tool_calls?.length) return done(text, turn + 1);
    for (const call of msg.tool_calls) {
      const def = run.tools.find((t) => t.name === call.function.name);
      let args: any = {};
      try {
        args = JSON.parse(call.function.arguments || '{}');
      } catch {
        /* leave empty */
      }
      const callId = call.id;
      let out: string;
      if (!def) out = `Error: no tool named ${call.function.name}`;
      else {
        run.ctx.emit('tool_call', { callId, name: def.name, label: def.label?.(args) ?? def.name, input: args });
        try {
          const parsed = z.object(def.shape).safeParse(args);
          if (!parsed.success) throw new Error(`Bad arguments: ${parsed.error.message.slice(0, 400)}`);
          const r = await def.run(parsed.data, run.ctx);
          run.ctx.emit('tool_result', { callId, name: def.name, ok: !r.isError, text: r.text.slice(0, 600), ui: r.ui ?? null });
          out = r.text;
        } catch (e) {
          out = `Error: ${(e as Error).message}`;
          run.ctx.emit('tool_result', { callId, name: def.name, ok: false, text: out });
        }
      }
      messages.push({ role: 'tool', tool_call_id: callId, content: out });
    }
  }
  return done(text || 'I stopped after too many steps.', max);
}
