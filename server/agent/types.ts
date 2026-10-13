// Shared shapes for the agent: tools, the app surface tools may touch, and providers.

import type { Search } from '../search.ts';
import type { z } from 'zod';
import type { Store } from '../db.ts';
import type { Library, Source } from '../../core/types.ts';
import type { Profiles } from '../profiles.ts';

export interface ToolOut {
  /** What the model reads. */
  text: string;
  /** What the chat UI renders next to the step (post cards, an undo chip, a job card). */
  ui?: Record<string, unknown>;
  isError?: boolean;
}

export interface ToolCtx {
  threadId: string;
  origin: 'user' | 'repair' | 'schedule';
  /** A routine run: nobody is watching, so tools must not move the user's screen. */
  unattended?: boolean;
  app: AgentApp;
  /** Store an event on the thread and broadcast it. */
  emit: (type: string, data: unknown) => void;
}

export interface ToolDef {
  name: string;
  description: string;
  shape: z.ZodRawShape;
  kind: 'read' | 'write' | 'network';
  /** One-line, human description of a call, shown as the step label. */
  label?: (args: any) => string;
  run: (args: any, ctx: ToolCtx) => Promise<ToolOut> | ToolOut;
}

export interface SyncSummary {
  added?: number;
  updated?: number;
  skipped?: number;
  errors?: string[];
  blocked?: string;
  error?: string;
  alreadyRunning?: boolean;
}

/** The parts of the server the agent may use. Passed in from main.ts to avoid import cycles. */
export interface AgentApp {
  store: Store;
  dataDir: string;
  library: () => Library;
  syncSource: (id: string) => Promise<SyncSummary>;
  addFeed: (connector: string, config: Record<string, unknown>) => Promise<{ source: Source | null; result: SyncSummary }>;
  actors: any | null;
  /** User-defined profiles. library() is already scoped to the active one. */
  profiles?: Profiles;
  /** Full-text search over the library (FTS5). */
  search?: Search;
  startJob: (job: { kind: 'build' | 'repair'; request: string; parentId: string | null; sourceId?: string; origin: ToolCtx['origin'] }) => { threadId: string };
}

export interface ProviderRun {
  system: string;
  prompt: string;
  /** Earlier turns, for providers that do not keep their own session. */
  history: { role: 'user' | 'assistant'; text: string }[];
  tools: ToolDef[];
  ctx: ToolCtx;
  model: string;
  sessionId?: string | null;
  signal: AbortSignal;
  onDelta: (text: string) => void;
  maxTurns?: number;
  /** Stop the run once it has cost this many dollars (Claude only; others are capped by turns). */
  maxBudgetUsd?: number;
}

export interface ProviderResult {
  text: string;
  sessionId?: string | null;
  costUsd?: number;
  turns?: number;
  inTokens?: number;
  outTokens?: number;
}

export interface AiConfig {
  provider: 'claude' | 'openai';
  model: string;
  builderModel: string;
  baseUrl?: string | null;
}
