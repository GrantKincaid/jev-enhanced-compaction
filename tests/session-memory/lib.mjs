// Deterministic fixtures and quiz for the manual /compact-jev session test.
// The expected answers are derived from the seed, never written into the workspace.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_SEED = 'jev-memory-1';
export const NOISE_TAG = 'FJNOISE';
/** Start of the default pre-compaction prompt the plugin sends. */
export const PREPARE_MARKER = 'Context is about to be compacted';
export const DIGEST_HEADER = '[fast-jev-compaction digest of earlier context]';

function rng(seed) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ['quartz', 'harbor', 'ember', 'falcon', 'lattice', 'cobalt', 'tundra', 'saffron', 'orbit', 'nimbus', 'garnet', 'willow'];

/** Every value the quiz asks about, derived from the seed. */
export function facts(seed = DEFAULT_SEED) {
  const r = rng(seed);
  const pick = () => WORDS[Math.floor(r() * WORDS.length)];
  const num = (lo, hi) => lo + Math.floor(r() * (hi - lo));
  const hex = (n) => Array.from({ length: n }, () => Math.floor(r() * 16).toString(16)).join('');
  return {
    branch: `${pick()}-${pick()}-${num(100, 999)}`, // user text
    port: String(num(20000, 60000)), // config result
    retryLimit: String(num(7, 97)), // config result
    errorBlock: `0x${hex(6).toUpperCase()}`, // failing command output
    rotatedKeyId: `KEY-${pick().toUpperCase()}-${num(1000, 9999)}`, // needle in a long log
    lateCode: `LATE-${hex(5).toUpperCase()}`, // read last, inside the pinned messages
    saveToken: `SAVE-${hex(6).toUpperCase()}`, // proves the memory-save prompt was executed
    needleLine: num(180, 260),
  };
}

export const QUIZ = [
  { id: 'branch', category: 'baseline', ask: 'Which branch name did the user say to use?', key: 'branch' },
  { id: 'port', category: 'core', ask: 'What port does config/service.json set?', key: 'port' },
  { id: 'retry', category: 'core', ask: 'What is retryLimit in config/service.json?', key: 'retryLimit' },
  { id: 'block', category: 'core', ask: 'The failing build reported a checksum mismatch at which block (0x...)?', key: 'errorBlock' },
  { id: 'needle', category: 'stretch', ask: 'In logs/audit.log, which key id was rotated (the WARN line)?', key: 'rotatedKeyId' },
  { id: 'late', category: 'control', ask: 'What code did config/late.txt contain?', key: 'lateCode' },
];

function noiseLine(r, i) {
  const levels = ['INFO', 'DEBUG', 'INFO', 'TRACE'];
  const level = levels[Math.floor(r() * levels.length)];
  const id = Math.floor(r() * 1e9).toString(36);
  return `2026-01-01T00:${String(i % 60).padStart(2, '0')}:00Z ${level} ${NOISE_TAG} worker=${id} processed batch ${i} in ${Math.floor(r() * 900)}ms`;
}

function log(seed, name, chars, needle) {
  const r = rng(`${seed}:${name}`);
  const lines = [];
  let size = 0;
  for (let i = 1; size < chars; i++) {
    const line = needle && i === needle.line ? needle.text : noiseLine(r, i);
    lines.push(line);
    size += line.length + 1;
  }
  return lines.join('\n') + '\n';
}

/** The user message to open the test session with (carries the branch fact in plain text). */
export function openingMessage(seed = DEFAULT_SEED) {
  return `We will work on the ${facts(seed).branch} branch. Never edit anything under generated/.`;
}

/** Writes the workspace and TASK.md; returns the planned steps. */
export function generate(outDir, { seed = DEFAULT_SEED, noiseCount = 12, noiseChars = 20000 } = {}) {
  const f = facts(seed);
  for (const d of ['config', 'logs', 'scripts']) mkdirSync(join(outDir, d), { recursive: true });
  const put = (p, text) => writeFileSync(join(outDir, p), text);
  // start clean: results of an earlier run must not satisfy this one
  rmSync(join(outDir, 'answers.json'), { force: true });
  rmSync(join(outDir, 'memory'), { recursive: true, force: true });
  put('.seed', seed);
  put(
    'CLAUDE.md',
    [
      '# Persistent memory',
      '',
      'Keep persistent memory in `memory/state.md`. Do not touch it during normal work.',
      'Only when you are told that context is about to be compacted:',
      'create or overwrite `memory/state.md` with',
      `1. the line \`memory-save: ${f.saveToken}\``,
      '2. the ports, ids, error codes, limits and branch names that appeared in tool output or messages so far, one per line',
      'then reply with one short line.',
      '',
    ].join('\n'),
  );
  put('scripts/show.mjs', "import { readFileSync } from 'node:fs';\nprocess.stdout.write(readFileSync(process.argv[2], 'utf8'));\n");
  put('config/service.json', JSON.stringify({ service: 'ledger', port: Number(f.port), retryLimit: Number(f.retryLimit), region: 'eu-west-2' }, null, 2) + '\n');
  put(
    'scripts/failing-build.mjs',
    `console.error('build failed: checksum mismatch at block ${f.errorBlock} (expected a1b2, got c3d4)');\nprocess.exit(2);\n`,
  );
  put('logs/audit.log', log(seed, 'audit', 24000, { line: f.needleLine, text: `2026-01-01T03:12:00Z WARN audit deploy-key rotated: id=${f.rotatedKeyId}` }));
  put('config/late.txt', `final code: ${f.lateCode}\n`);
  const noise = [];
  for (let n = 1; n <= noiseCount; n++) {
    const name = `logs/noise-${String(n).padStart(2, '0')}.log`;
    put(name, log(seed, name, noiseChars));
    noise.push(name);
  }
  const steps = [
    'node scripts/show.mjs config/service.json',
    'node scripts/failing-build.mjs   (exits non-zero; that is expected, do not fix it)',
    'node scripts/show.mjs logs/audit.log',
    ...noise.map((n) => `node scripts/show.mjs ${n}`),
    'node scripts/show.mjs config/late.txt',
  ];
  put(
    'TASK.md',
    [
      '# Session memory test: task',
      '',
      'Run each command below, one per tool call, in order, from this directory.',
      'Do not batch calls, do not summarize outputs, and do not re-read anything later.',
      'After each call reply with just "ok". Do not edit any file (the memory rule in CLAUDE.md applies only when told that context is about to be compacted).',
      '',
      ...steps.map((s, i) => `${i + 1}. \`${s}\``),
      '',
      'When the last step is done reply exactly: READY FOR /compact-jev',
      '',
    ].join('\n'),
  );
  return steps;
}

export function quizText() {
  return QUIZ.map((q, i) => `${i + 1}. [${q.id}] ${q.ask}`).join('\n');
}

/** Scores memory/state.md (text, or null when missing): written by the pre-compaction prompt. */
export function scoreMemory(text, seed = DEFAULT_SEED) {
  const f = facts(seed);
  const has = (v) => typeof text === 'string' && text.includes(v);
  return [
    { id: 'file', pass: text !== null && text !== undefined, expected: 'memory/state.md written' },
    { id: 'token', pass: has(f.saveToken), expected: f.saveToken },
    { id: 'port', pass: has(f.port), expected: f.port },
    { id: 'block', pass: has(f.errorBlock), expected: f.errorBlock },
  ].map((r) => ({ ...r, category: 'memory' }));
}

const norm = (v) => String(v ?? '').trim().toLowerCase();

/** Scores answers ({id: value}) against the seed's facts. */
export function score(answers, seed = DEFAULT_SEED) {
  const f = facts(seed);
  const rows = QUIZ.map((q) => {
    const expected = f[q.key];
    const got = answers?.[q.id];
    return { id: q.id, category: q.category, expected, got: got ?? null, pass: norm(got) === norm(expected) };
  });
  const core = rows.filter((r) => r.category !== 'stretch');
  return { rows, ok: core.every((r) => r.pass), allOk: rows.every((r) => r.pass) };
}
