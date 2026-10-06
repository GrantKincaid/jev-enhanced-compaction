import type {
  On,
  PluginOptions,
  Register,
  SessionMessage,
  ToolResultSummary,
  ToolUseSummary,
  TurnCompleteInput,
} from 'claude-code';

import { compact, reductionRatio, resolveOptions } from '../src/compact.js';
import { collectToolCalls } from '../src/state.js';
import { compactPartial, type PartialAsker, type PartialResult } from '../src/partial.js';
import { buildJevRequest, DEFAULT_MODEL, parseJevResponse } from '../src/request.js';
import type {
  CompactOptions,
  CompactResult,
  JevAsker,
  Message,
  ToolResult,
  ToolUse,
} from '../src/types.js';

const HOOK_DEFAULTS = {
  compactAtPercent: 60,
  minReductionRatio: 0.25,
  model: DEFAULT_MODEL,
};

export type HookFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export type HookFetchResponse = {
  status: number;
  ok: boolean;
  text: string;
};

/** The shape of `$.http.fetch`, so the hook can be driven without an engine. */
export type HookFetch = (url: string, init?: HookFetchInit) => Promise<HookFetchResponse>;

export type HookConfig = CompactOptions & {
  apiKey?: string;
  compactAtPercent: number;
  minReductionRatio: number;
  model: string;
};

function optionNumber(options: PluginOptions, key: string, fallback: number): number {
  const value = options[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionString(options: PluginOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Reads the plugin's `userConfig` values; anything missing takes the defaults. */
export function resolveHookConfig(options: PluginOptions): HookConfig {
  const numbers: Partial<Omit<CompactOptions, 'goal'>> = {};
  for (const key of [
    'keepThreshold',
    'preserveRecentMessages',
    'maxStateTokens',
    'maxRequestTokens',
    'truncateHeadChars',
  ] as const) {
    const value = options[key];
    if (typeof value === 'number' && Number.isFinite(value)) numbers[key] = value;
  }
  const config: HookConfig = {
    ...numbers,
    compactAtPercent: optionNumber(options, 'compactAtPercent', HOOK_DEFAULTS.compactAtPercent),
    minReductionRatio: optionNumber(
      options,
      'minReductionRatio',
      HOOK_DEFAULTS.minReductionRatio,
    ),
    model: optionString(options, 'model') ?? HOOK_DEFAULTS.model,
  };
  const apiKey = optionString(options, 'apiKey');
  if (apiKey) config.apiKey = apiKey;
  const goal = optionString(options, 'goal');
  if (goal) config.goal = goal;
  return config;
}

/** A `JevAsker` over the engine's `$.http.fetch`. */
export function jevAsker(fetchFn: HookFetch, apiKey: string, model: string): JevAsker {
  return {
    async ask(state, questions) {
      const request = buildJevRequest({ apiKey, model }, state, questions);
      const response = await fetchFn(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
      return parseJevResponse(response.status, response.ok, response.text);
    },
  };
}

function toolUseSummary(tool: ToolUse): ToolUseSummary {
  const summary: ToolUseSummary = {
    tool_use_id: tool.tool_use_id,
    tool: tool.tool,
    input: tool.input,
  };
  if (tool.text !== undefined) summary.text = tool.text;
  if (tool.isError) summary.isError = true;
  return summary;
}

function toolResultSummary(result: ToolResult): ToolResultSummary {
  return {
    tool_use_id: result.tool_use_id,
    text: result.text,
    isError: result.isError ?? false,
  };
}

/**
 * Maps the library's output back onto session messages. Whatever came back
 * unchanged (a message, a tool use, a tool result) is the engine's own object,
 * handle included; anything rebuilt is a fresh message without a handle, so the
 * engine takes the edited content instead of its original.
 */
export function toSessionMessages(
  input: readonly SessionMessage[],
  output: readonly Message[],
): SessionMessage[] {
  const messages = new Map<Message, SessionMessage>();
  const uses = new Map<ToolUse, ToolUseSummary>();
  const results = new Map<ToolResult, ToolResultSummary>();
  for (const message of input) {
    messages.set(message, message);
    for (const tool of message.toolUses) uses.set(tool, tool);
    for (const result of message.toolResults ?? []) results.set(result, result);
  }
  return output.map((message) => {
    const own = messages.get(message);
    if (own) return own;
    const rebuilt: SessionMessage = {
      role: message.role,
      text: message.text,
      toolUses: message.toolUses.map((tool) => uses.get(tool) ?? toolUseSummary(tool)),
    };
    if (message.toolResults && message.toolResults.length > 0) {
      rebuilt.toolResults = message.toolResults.map(
        (result) => results.get(result) ?? toolResultSummary(result),
      );
    }
    return rebuilt;
  });
}

export type SessionCompaction = {
  result: CompactResult;
  messages: SessionMessage[];
};

/** Runs the library over a session transcript; throws when the key is missing or Jev fails. */
export async function compactSession(
  messages: readonly SessionMessage[],
  config: HookConfig,
  fetchFn: HookFetch,
  partial?: PartialResult,
): Promise<SessionCompaction> {
  if (!config.apiKey) throw new Error('TYPESAFE_API_KEY is not configured');
  const options: CompactOptions = partial
    ? { ...config, digest: partial.digest, keepToolUseIds: partial.keep }
    : config;
  const result = await compact(messages, jevAsker(fetchFn, config.apiKey, config.model), options);
  return { result, messages: toSessionMessages(messages, result.messages) };
}

/** A `PartialAsker` over `$.model.fork`: the session's own model, sharing its prompt cache. */
export function forkAsker(fork: (request: { prompt: string }) => Promise<unknown>): PartialAsker {
  return {
    async ask(prompt) {
      const reply = await fork({ prompt });
      if (!reply) throw new Error('session fork unavailable (cold cache or API error)');
      if (typeof reply === 'string') return reply;
      const text = (reply as { text?: unknown }).text;
      if (typeof text === 'string') return text;
      const shape = typeof reply === 'object' ? Object.keys(reply).join(',') || 'empty object' : typeof reply;
      throw new Error(`session fork returned no text (${shape})`);
    },
  };
}

/**
 * compact-partial: one fork pass over the session transcript, before Jev.
 * Throws when the fork is unavailable or its reply is unusable.
 */
export function runPartial(
  messages: readonly SessionMessage[],
  config: HookConfig,
  asker: PartialAsker,
  instructions?: string,
): Promise<PartialResult> {
  const calls = collectToolCalls(messages, resolveOptions(config).preserveRecentMessages);
  const options: { preserveRecentMessages: number; instructions?: string } = {
    preserveRecentMessages: resolveOptions(config).preserveRecentMessages,
  };
  if (instructions) options.instructions = instructions;
  return compactPartial(asker, calls, options);
}

/** Debug switch: `"fastJev": { "debugSkipPartial": true }` in any settings.json. */
export function partialDisabled(settings: Readonly<Record<string, unknown>>): boolean {
  const section = settings['fastJev'];
  return (
    !!section &&
    typeof section === 'object' &&
    (section as Record<string, unknown>)['debugSkipPartial'] === true
  );
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function summarize(result: CompactResult): string {
  const { stats } = result;
  const parts = [
    stats.kept > 0 ? `${stats.kept} kept` : '',
    stats.resultsDropped > 0 ? `${stats.resultsDropped} results truncated` : '',
    stats.callsDropped > 0 ? `${stats.callsDropped} call_dropped` : '',
    stats.guarded > 0 ? `${stats.guarded} guarded` : '',
    stats.pinned > 0 ? `${stats.pinned} pinned` : '',
  ].filter(Boolean);
  return `${percent(reductionRatio(result))} reduction; ${
    parts.join(', ') || 'no tool calls'
  }; state ~${stats.stateTokens} tokens (${stats.stateStage}) in ${stats.requests} request(s)`;
}

const UI_LOG_MAX_CHARS = 4096;

export function decisionLog(result: CompactResult): string {
  return result.decisions
    .filter((d) => d.reason !== 'pinned')
    .map(
      (d) =>
        `${d.id}:${d.tool}:${d.action}/call=${d.keepCall.toFixed(2)}/result=${d.keepResult.toFixed(2)}`,
    )
    .join(' ');
}

export function decisionLogLines(
  result: CompactResult,
  maxChars: number = UI_LOG_MAX_CHARS,
): string[] {
  const entries = decisionLog(result).split(' ').filter(Boolean);
  if (entries.length === 0) return ['decisions: (none)'];
  const chunks: string[] = [];
  let current = '';
  for (const entry of entries) {
    const next = current ? `${current} ${entry}` : entry;
    if (current && next.length > maxChars - 24) {
      chunks.push(current);
      current = entry;
    } else current = next;
  }
  chunks.push(current);
  return chunks.map((chunk, index) =>
    chunks.length === 1
      ? `decisions: ${chunk}`
      : `decisions (${index + 1}/${chunks.length}): ${chunk}`,
  );
}

async function getApiKey(
  $: {
    env: { get: (name: string) => Promise<string | undefined> };
    settings: { read: () => Promise<Readonly<Record<string, unknown>>> };
  },
  config: HookConfig,
): Promise<string | undefined> {
  if (config.apiKey) return config.apiKey;
  const fromEnv = await $.env.get('TYPESAFE_API_KEY');
  if (fromEnv) return fromEnv;
  const settings = await $.settings.read();
  const env = settings['env'];
  if (env && typeof env === 'object') {
    const value = (env as Record<string, unknown>)['TYPESAFE_API_KEY'];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

function notify(
  $: {
    ui: {
      log: (text: string) => void;
      toast: (text: string, options?: { timeoutMs?: number }) => void;
    };
  },
  text: string,
): void {
  $.ui.log(text);
  $.ui.toast(text, { timeoutMs: 15_000 });
}

/** The slash command that runs compact-partial + Jev on demand; `/compact` is left alone. */
export const COMPACT_JEV_COMMAND = 'compact-jev';

const COMPACT_RETRY_MS = 500;
const COMPACT_MAX_TRIES = 20;

/** Set while the plugin itself runs a built-in `/compact`, so the hook knows it is ours. */
const jevRun = { pending: false };

type CompactRequester = {
  command: { run: (args: { command: string; args?: string }) => Promise<unknown> };
  session: { compact: (args: { instructions?: string }) => Promise<{ skip?: string | undefined }> };
};

/**
 * Compacts through Jev. `$.session.compact` is not offered in headless (-p / SDK,
 * desktop app) sessions, where compaction only runs inside a `/compact` prompt;
 * there the plugin runs `/compact` itself and marks it as its own.
 */
export async function requestCompact($: CompactRequester, instructions: string): Promise<{ skip?: string | undefined }> {
  try {
    return await $.session.compact(instructions ? { instructions } : {});
  } catch (error) {
    if (!/headless/i.test(error instanceof Error ? error.message : String(error))) throw error;
  }
  jevRun.pending = true;
  try {
    await $.command.run({ command: 'compact', ...(instructions ? { args: instructions } : {}) });
    return {};
  } finally {
    jevRun.pending = false;
  }
}

type CompactScheduler = CompactRequester & {
  clock: { after: (ms: number, fn: () => void) => unknown };
  ui: {
    log: (text: string) => void;
    toast: (text: string, options?: { timeoutMs?: number }) => void;
  };
};

/** Runs `$.session.compact` shortly after the calling hook returns, retrying while a turn is still running. */
export function scheduleCompact($: CompactScheduler, instructions: string): void {
  let tries = 0;
  const attempt = async (): Promise<void> => {
    try {
      const { skip } = await requestCompact($, instructions);
      if (skip) notify($, `compaction skipped: ${skip}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/turn/i.test(message) && ++tries < COMPACT_MAX_TRIES) {
        $.clock.after(COMPACT_RETRY_MS, () => void attempt());
        return;
      }
      notify($, `/${COMPACT_JEV_COMMAND} failed (${message})`);
    }
  };
  $.clock.after(COMPACT_RETRY_MS, () => void attempt());
}

export const register: Register = (on: On, options: PluginOptions) => {
  const configured = resolveHookConfig(options);
  let compacting = false;

  on('session.start', async ($, event, next) => {
    try {
      await $.command.register({
        name: COMPACT_JEV_COMMAND,
        description: 'Compact the conversation with compact-partial and Jev (/compact stays the built-in)',
        argumentHint: '[what to keep or stress]',
      });
    } catch (error) {
      $.ui.log(
        `/${COMPACT_JEV_COMMAND} not registered (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    return next(event);
  });

  on('command.run', { command: COMPACT_JEV_COMMAND }, ($, event) => {
    // The host refuses session.compact from inside a command.run turn, so the
    // compaction is scheduled to run once the command's turn has ended.
    scheduleCompact($, event.args.trim());
    return { text: `/${COMPACT_JEV_COMMAND}: compacting as soon as the session is idle` };
  });

  on('session.compact', async ($, event, next) => {
    // The person's /compact stays Claude Code's own; /compact-jev, the plugin's
    // threshold check and the engine's auto compaction come through here.
    if (event.trigger === 'manual' && !jevRun.pending) return next(event);
    try {
      const config = { ...configured, apiKey: await getApiKey($, configured) };
      let partial: PartialResult | undefined;
      if (!partialDisabled(await $.settings.read())) {
        // The fork reads the main conversation, so a subagent's own transcript
        // cannot be digested: it takes the standard compaction.
        if (event.agentId) throw new Error('compact-partial does not cover subagent transcripts');
        partial = await runPartial(event.messages, config, forkAsker((r) => $.model.fork(r)), event.instructions);
        $.ui.log(`compact-partial: digest ${partial.digest.length} chars, ${partial.keep.length} calls guarded`);
      } else $.ui.log('compact-partial skipped (fastJev.debugSkipPartial)');
      const { result, messages } = await compactSession(
        event.messages,
        config,
        async (url, init) => {
          const response = await $.http.fetch(url, init);
          return { status: response.status, ok: response.ok, text: response.text };
        },
        partial,
      );
      for (const line of decisionLogLines(result)) $.ui.log(line);
      if (reductionRatio(result) < config.minReductionRatio) {
        notify(
          $,
          `fallback to built-in summary (below ${percent(config.minReductionRatio)} minimum: ${summarize(result)})`,
        );
        return next(event);
      }
      notify(
        $,
        `kept ${messages.length}/${event.messages.length} messages, no summary (${summarize(result)})`,
      );
      return { messages };
    } catch (error) {
      notify(
        $,
        `fallback to built-in summary (${error instanceof Error ? error.message : String(error)})`,
      );
      return next(event);
    }
  });

  on('turn.complete', async ($, event: TurnCompleteInput, next) => {
    if (compacting) return next(event);
    try {
      const { context } = await $.session.usage();
      if ((context.percent ?? 0) < configured.compactAtPercent) return next(event);
      compacting = true;
      await requestCompact($, '');
    } catch (error) {
      $.ui.log(
        `auto-compact skipped (${error instanceof Error ? error.message : String(error)})`,
      );
    } finally {
      compacting = false;
    }
    return next(event);
  });
};

export { resolveOptions };
