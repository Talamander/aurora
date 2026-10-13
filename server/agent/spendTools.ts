// The agent's view of AI spending, so "how much has the AI cost me this week?" has a real answer.

import { z } from 'zod';
import type { ToolDef } from './types.ts';
import { money, spendFor, type Totals } from './spend.ts';
import { TASK_INFO, capStates, type Caps } from './routing.ts';

const line = (name: string, t: Totals) => `${name}: ${money(t.cost)} over ${t.calls} call${t.calls === 1 ? '' : 's'} (${(t.inTokens + t.outTokens).toLocaleString('en-US')} tokens)${t.unknown ? `; ${t.unknown} call${t.unknown === 1 ? '' : 's'} on a service that did not report a cost` : ''}`;

export const spendTools: ToolDef[] = [
  {
    name: 'ai_spend',
    description: 'What the AI has cost on this computer: today, this week and this month, by job (chat, connector builds, AI rules, alerts, Your week, summaries, briefs) and by model, the most expensive connector builds, and any monthly caps. Costs are as reported by the provider; local models count as $0.',
    shape: {},
    kind: 'read',
    label: () => 'Checking AI spending',
    run: (_args, ctx) => {
      const s = spendFor(ctx.app.dataDir).summary();
      const caps = ctx.app.store.getSetting<Caps>('ai.caps') ?? {};
      const out = [line('Today', s.today), line('This week (since Monday)', s.week), line('This month', s.month)];
      if (s.byTask.length) out.push('', 'This month by job:', ...s.byTask.map((t) => `- ${line(TASK_INFO[t.task]?.label ?? t.task, t)}`));
      if (s.byModel.length) out.push('', 'This month by model:', ...s.byModel.map((m) => `- ${line(`${m.model}${m.local ? ' (local)' : ''}`, m)}`));
      if (s.topBuilds.length) out.push('', 'Most expensive connector builds (90 days):', ...s.topBuilds.map((b) => `- ${b.label}: ${money(b.cost)} on ${b.at.slice(0, 10)}`));
      const cs = capStates(s.monthByTask, caps);
      if (cs.length) out.push('', 'Monthly caps:', ...cs.map((c) => `- ${TASK_INFO[c.task].label}: ${money(c.spent)} of ${money(c.cap)}${c.localOnly ? ' (local models only)' : c.reached ? ' (reached, paused)' : ''}`));
      if (!s.month.calls) out.push('', 'No AI calls recorded this month yet. Spending is recorded from the moment this feature was added.');
      return { text: out.join('\n') };
    },
  },
];
