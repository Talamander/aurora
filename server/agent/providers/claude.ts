// Claude through the Agent SDK. Uses ANTHROPIC_API_KEY when one is stored, otherwise the local
// Claude Code login. Every built-in tool is off and MCP is strict: the model can only call our tools.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import type { ProviderResult, ProviderRun, ToolDef } from '../types.ts';

const SERVER = 'sr';

function sdkTools(defs: ToolDef[], run: ProviderRun) {
  return defs.map((d) =>
    tool(d.name, d.description, d.shape, async (args: any) => {
      const callId = crypto.randomUUID();
      run.ctx.emit('tool_call', { callId, name: d.name, label: d.label?.(args) ?? d.name, input: args });
      try {
        const out = await d.run(args, run.ctx);
        run.ctx.emit('tool_result', { callId, name: d.name, ok: !out.isError, text: out.text.slice(0, 600), ui: out.ui ?? null });
        return { content: [{ type: 'text' as const, text: out.text }], isError: out.isError };
      } catch (e) {
        const msg = (e as Error).message || 'Tool failed';
        run.ctx.emit('tool_result', { callId, name: d.name, ok: false, text: msg });
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
      }
    }),
  );
}

export async function runClaude(run: ProviderRun, opts: { dataDir: string; apiKey: string | null }): Promise<ProviderResult> {
  const cwd = join(opts.dataDir, 'agent');
  mkdirSync(cwd, { recursive: true });
  const server = createSdkMcpServer({ name: SERVER, version: '1', tools: sdkTools(run.tools, run) });
  const names = run.tools.map((t) => `mcp__${SERVER}__${t.name}`);
  const abort = new AbortController();
  run.signal.addEventListener('abort', () => abort.abort(), { once: true });
  const env: Record<string, string | undefined> = { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: 'false', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  if (opts.apiKey) env.ANTHROPIC_API_KEY = opts.apiKey;

  let text = '';
  let sessionId: string | null = run.sessionId ?? null;
  let costUsd: number | undefined;
  let turns: number | undefined;
  let inTokens: number | undefined;
  let outTokens: number | undefined;
  const q = query({
    prompt: run.prompt,
    options: {
      model: run.model,
      systemPrompt: run.system,
      mcpServers: { [SERVER]: server },
      tools: [],
      strictMcpConfig: true,
      settingSources: [],
      canUseTool: async (name: string, input: any) => (names.includes(name) ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Only Aurora tools are available.' }),
      cwd,
      env,
      maxTurns: run.maxTurns ?? 40,
      ...(run.maxBudgetUsd ? { maxBudgetUsd: run.maxBudgetUsd } : {}),
      includePartialMessages: true,
      abortController: abort,
      ...(run.sessionId ? { resume: run.sessionId } : {}),
    } as any,
  });
  for await (const m of q as AsyncIterable<any>) {
    if (m.type === 'system' && m.subtype === 'init') {
      sessionId = m.session_id ?? sessionId;
      if (process.env.SR_DEBUG) console.log('[agent] init tools', m.tools?.length, JSON.stringify(m.mcp_servers));
    }
    else if (m.type === 'stream_event') {
      const ev = m.event;
      if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') run.onDelta(ev.delta.text);
    } else if (m.type === 'assistant') {
      const parts = (m.message?.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
      if (parts.trim()) {
        run.ctx.emit('assistant', { text: parts });
        text = parts;
      }
    } else if (m.type === 'result') {
      costUsd = m.total_cost_usd;
      turns = m.num_turns;
      const u = m.usage ?? {};
      inTokens = (Number(u.input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0);
      outTokens = Number(u.output_tokens) || 0;
      if (m.subtype !== 'success' && !text) throw Object.assign(new Error(m.subtype === 'error_max_budget_usd' ? 'Stopped at the spending limit for one run.' : m.errors?.join('; ') || `The model stopped (${m.subtype})`), { costUsd });
    }
  }
  return { text, sessionId, costUsd, turns, inTokens, outTokens };
}
