import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs harness
import { QUIZ, facts, generate, score, scoreMemory } from './session-memory/lib.mjs';

describe('session memory harness', () => {
  it('derives the same facts per seed and plants them in the workspace', () => {
    expect(facts('a')).toEqual(facts('a'));
    expect(facts('a')).not.toEqual(facts('b'));
    const dir = mkdtempSync(join(tmpdir(), 'jevmem-'));
    const steps = generate(dir, { seed: 'a', noiseCount: 3, noiseChars: 2000 });
    const f = facts('a');
    expect(steps).toHaveLength(3 + 3 + 1);
    expect(readFileSync(join(dir, 'config/service.json'), 'utf8')).toContain(f.port);
    expect(readFileSync(join(dir, 'scripts/failing-build.mjs'), 'utf8')).toContain(f.errorBlock);
    const audit = readFileSync(join(dir, 'logs/audit.log'), 'utf8').split('\n');
    expect(audit[f.needleLine - 1]).toContain(f.rotatedKeyId);
    expect(readdirSync(join(dir, 'logs'))).toHaveLength(4);
    expect(readFileSync(join(dir, 'TASK.md'), 'utf8')).not.toContain(f.branch);
  });

  it('scores answers, treating the needle as a stretch goal', () => {
    const f = facts('a');
    const all = Object.fromEntries(QUIZ.map((q: { id: string; key: string }) => [q.id, (f as Record<string, string>)[q.key]]));
    expect(score(all, 'a')).toMatchObject({ ok: true, allOk: true });
    expect(score({ ...all, needle: 'x' }, 'a')).toMatchObject({ ok: true, allOk: false });
    expect(score({ ...all, port: '1' }, 'a')).toMatchObject({ ok: false });
  });

  it('plants the memory rule and scores the saved state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jevmem-'));
    generate(dir, { seed: 'a', noiseCount: 1, noiseChars: 500 });
    const f = facts('a');
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toContain(f.saveToken);
    const good = `memory-save: ${f.saveToken}
${f.port}
${f.errorBlock}
`;
    expect(scoreMemory(good, 'a').every((r: { pass: boolean }) => r.pass)).toBe(true);
    expect(scoreMemory(null, 'a').every((r: { pass: boolean }) => r.pass)).toBe(false);
    expect(scoreMemory('memory-save: nope', 'a').filter((r: { pass: boolean }) => r.pass)).toHaveLength(1);
  });
});
