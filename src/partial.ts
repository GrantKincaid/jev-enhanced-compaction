import type { Message, ToolCall } from './types.js';

/** Runs one tool-less completion over the session's own transcript and returns its text. */
export interface PartialAsker {
  ask(prompt: string): Promise<string>;
}

export interface PartialResult {
  /** Essential details of the conversation, in prose. */
  digest: string;
  /** `tool_use_id`s of calls whose call and result must stay verbatim. */
  keep: string[];
}

export interface PartialPromptOptions {
  /** Text after `/compact`, or a plugin's instructions. */
  instructions?: string;
  /** Newest messages that are never compacted and need no digest. */
  preserveRecentMessages: number;
}

/** Digest text handed to Jev as context is cut to this many characters. */
export const MAX_DIGEST_CHARS = 6000;

export function buildPartialPrompt(options: PartialPromptOptions): string {
  const focus = options.instructions?.trim()
    ? `\n\nThe user asked this compaction to keep or stress: ${options.instructions.trim()}`
    : '';
  return [
    'This conversation is about to be compacted. Do not call tools. Review it and reply with a single JSON object, nothing else:',
    '{"digest": string, "keep": string[]}',
    '',
    '"digest": a compact record of what must not be lost: the user\'s goals and constraints, decisions and their reasons, exact file paths, commands, error messages, identifiers, values, and open or unfinished work. Plain text, under 600 words.',
    '"keep": the tool_use_ids of tool calls whose input and full output are still needed verbatim and cannot be recovered from the digest or cheaply re-run.',
    `The newest ${options.preserveRecentMessages} messages are kept as they are; focus on everything older.${focus}`,
  ].join('\n');
}

function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('compact-partial reply held no JSON object');
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error('compact-partial reply was not valid JSON');
  }
}

/**
 * Validates a reply. A missing digest throws (the caller falls back); a keep
 * list that is absent or names unknown ids is cleaned to the known ones.
 */
export function parsePartialResponse(
  text: string,
  knownToolUseIds: Iterable<string>,
): PartialResult {
  const parsed = extractJson(text);
  const record = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  const digest = typeof record['digest'] === 'string' ? record['digest'].trim() : '';
  if (!digest) throw new Error('compact-partial reply had no digest');
  const known = new Set(knownToolUseIds);
  const keep = Array.isArray(record['keep'])
    ? [...new Set(record['keep'].filter((id): id is string => typeof id === 'string' && known.has(id)))]
    : [];
  return { digest, keep };
}

/** One partial pass: asks the session model, then validates against the calls it may cite. */
export async function compactPartial(
  asker: PartialAsker,
  calls: readonly Pick<ToolCall, 'tool_use_id' | 'pinned'>[],
  options: PartialPromptOptions,
): Promise<PartialResult> {
  const text = await asker.ask(buildPartialPrompt(options));
  return parsePartialResponse(
    text,
    calls.filter((call) => !call.pinned).map((call) => call.tool_use_id),
  );
}

export const DIGEST_HEADER = '[fast-jev-compaction digest of earlier context]';

/** The digest as a message, placed right after the first message. */
export function digestMessage(digest: string): Message {
  return { role: 'user', text: `${DIGEST_HEADER}\n${digest}`, toolUses: [] };
}
