import { describe, expect, it } from 'vitest';
import { compactSession, forkAsker, partialDisabled, resolveHookConfig, runPartial } from '../hooks/fast-jev.ts';
import { buildPartialPrompt, parsePartialResponse, DIGEST_HEADER, type Message } from '../src/index.js';

function message(role: Message['role'], text: string, extra: Partial<Message> = {}): Message {
  return { role, text, toolUses: [], ...extra };
}
function transcript(): Message[] {
  return [
    message('user', 'Fix the failing test.'),
    message('assistant', '', { toolUses: [{ tool_use_id: 'tool-1', tool: 'Read', input: { file_path: 'a.ts' }, text: 'x' }] }),
    message('user', '', { toolResults: [{ tool_use_id: 'tool-1', text: 'x'.repeat(2000) }] }),
    message('assistant', '', { toolUses: [{ tool_use_id: 'tool-2', tool: 'Bash', input: { command: 'ls' }, text: 'y' }] }),
    message('user', '', { toolResults: [{ tool_use_id: 'tool-2', text: 'y'.repeat(2000) }] }),
    message('assistant', 'ok'),
    message('user', 'go'),
  ];
}
const lowJev = async (_u: string, init?: { body?: string }) => {
  const { questions } = JSON.parse(init?.body ?? '{}') as { questions: Record<string, unknown> };
  const answers = Object.fromEntries(Object.keys(questions).map((k) => [k, { type: 'noul', noul: 0.1 }]));
  return { status: 200, ok: true, text: JSON.stringify({ answers }) };
};

describe('compact-partial', () => {
  it('puts instructions and the preserved count in the prompt', () => {
    const prompt = buildPartialPrompt({ instructions: ' the plan ', preserveRecentMessages: 6 });
    expect(prompt).toContain('keep or stress: the plan');
    expect(prompt).toContain('newest 6 messages');
  });

  it('parses fenced replies and drops unknown or pinned ids', () => {
    const reply = '```json\n{"digest":" d ","keep":["tool-1","nope",3,"tool-1"]}\n```';
    expect(parsePartialResponse(reply, ['tool-1'])).toEqual({ digest: 'd', keep: ['tool-1'] });
    expect(parsePartialResponse('{"digest":"d"}', [])).toEqual({ digest: 'd', keep: [] });
    expect(() => parsePartialResponse('{"keep":[]}', [])).toThrow(/digest/);
    expect(() => parsePartialResponse('nothing', [])).toThrow(/JSON/);
  });

  it('accepts a bare string reply and names the shape of an unusable one', async () => {
    const config = resolveHookConfig({ preserveRecentMessages: 1 });
    const ok = await runPartial(transcript(), config, forkAsker(async () => '{"digest":"d","keep":[]}'));
    expect(ok.digest).toBe('d');
    await expect(runPartial(transcript(), config, forkAsker(async () => ({ usage: {} })))).rejects.toThrow(/no text \(usage\)/);
  });

  it('throws when the fork is unavailable', async () => {
    const config = resolveHookConfig({ preserveRecentMessages: 1 });
    await expect(runPartial(transcript(), config, forkAsker(async () => null))).rejects.toThrow(/fork unavailable/);
  });

  it('forces keep-list calls past Jev and inserts the digest after the first message', async () => {
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1 }), apiKey: 'k' };
    const prompts: string[] = [];
    const partial = await runPartial(
      transcript(),
      config,
      forkAsker(async ({ prompt }) => (prompts.push(prompt), { text: '{"digest":"touch a.ts only","keep":["tool-1"]}' })),
      'the plan',
    );
    expect(prompts[0]).toContain('the plan');
    const { result, messages } = await compactSession(transcript(), config, lowJev, partial);
    expect(result.decisions.map((d) => d.reason)).toEqual(['guarded', 'call_dropped']);
    expect(result.stats.guarded).toBe(1);
    expect(messages[1]!.text).toBe(`${DIGEST_HEADER}\ntouch a.ts only`);
    expect(messages.some((m) => m.toolUses.some((t) => t.tool_use_id === 'tool-1'))).toBe(true);
    expect(messages.some((m) => m.toolUses.some((t) => t.tool_use_id === 'tool-2'))).toBe(false);
  });

  it('reads the debug switch from settings', () => {
    expect(partialDisabled({})).toBe(false);
    expect(partialDisabled({ fastJev: { debugSkipPartial: true } })).toBe(true);
  });
});

describe('/compact-jev', () => {
  async function setup() {
    const { register } = await import('../hooks/fast-jev.ts');
    const handlers: Record<string, (...args: any[]) => any> = {};
    (register as any)((name: string, a: unknown, b?: unknown) => {
      const key = typeof a === 'function' ? name : `${name}:${(a as any).command}`;
      handlers[key] = (typeof a === 'function' ? a : b) as any;
    }, {});
    return handlers;
  }

  it('registers the command and leaves manual /compact to the engine', async () => {
    const h = await setup();
    const registered: unknown[] = [];
    const next = async (e: unknown) => e;
    await h['session.start']!({ command: { register: async (c: unknown) => registered.push(c) } }, {}, next);
    expect(registered).toMatchObject([{ name: 'compact-jev' }]);
    const event = { trigger: 'manual', messages: [] };
    const passed: unknown[] = [];
    await h['session.compact']!({}, event, async (e: unknown) => (passed.push(e), e));
    expect(passed).toEqual([event]);
  });

  it('schedules the compaction after the command returns, retrying while a turn runs', async () => {
    const h = await setup();
    const timers: (() => void)[] = [];
    const calls: unknown[] = [];
    let busy = 1;
    const $ = {
      clock: { after: (_ms: number, fn: () => void) => timers.push(fn) },
      ui: { log: () => {}, toast: () => {} },
      session: {
        compact: async (a: unknown) => {
          calls.push(a);
          if (busy-- > 0) throw new Error('rejects while a turn runs');
          return {};
        },
      },
    };
    const out = await h['command.run:compact-jev']!($, { args: ' the plan ' });
    expect(out.text).toContain('as soon as the session is idle');
    expect(calls).toEqual([]);
    timers.shift()!();
    await new Promise((r) => setTimeout(r, 0));
    expect(timers).toHaveLength(1);
    timers.shift()!();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([{ instructions: 'the plan' }, { instructions: 'the plan' }]);
  });

  it('falls back to a plugin-run /compact in headless sessions and marks it as its own', async () => {
    const { requestCompact } = await import('../hooks/fast-jev.ts');
    const h = await setup();
    const seen: unknown[] = [];
    const $ = {
      session: { compact: async () => { throw new Error('$.session.compact: not available in a headless (-p / SDK) session yet'); } },
      command: {
        run: async (a: unknown) => {
          seen.push(a);
          // while the plugin's own /compact runs, the manual trigger is ours
          let forked = 0;
          const engine = { settings: { read: async () => ({}) }, env: { get: async () => 'k' }, ui: { log() {}, toast() {} }, model: { fork: async () => (forked++, null) } };
          await h['session.compact']!(engine, { trigger: 'manual', messages: [] }, async (e: unknown) => e);
          seen.push({ forked });
        },
      },
    };
    await requestCompact($ as any, 'the plan');
    expect(seen[0]).toEqual({ command: 'compact', args: 'the plan' });
    expect(seen[1]).toEqual({ forked: 1 }); // the Jev path ran, not the built-in pass-through
    // flag cleared afterwards: a person's own /compact passes through again
    const passed: unknown[] = [];
    await h['session.compact']!({}, { trigger: 'manual', messages: [] }, async (e: unknown) => (passed.push(e), e));
    expect(passed).toHaveLength(1);
  });
});
