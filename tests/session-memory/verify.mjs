// node verify.mjs score <outDir>                                grade answers.json from the post-compaction quiz
// node verify.mjs transcript <outDir> [--file session.jsonl]    best-effort scan of the session transcript
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DIGEST_HEADER, NOISE_TAG, PREPARE_MARKER, facts, score, scoreMemory } from './lib.mjs';

const [mode, dirArg, ...rest] = process.argv.slice(2);
if (!['score', 'transcript'].includes(mode) || !dirArg) {
  console.error('usage: node verify.mjs <score|transcript> <outDir> [--file session.jsonl]');
  process.exit(1);
}
const outDir = resolve(dirArg);
const seed = readFileSync(join(outDir, '.seed'), 'utf8');

if (mode === 'score') {
  const file = join(outDir, 'answers.json');
  if (!existsSync(file)) {
    console.error(`missing ${file}: run the post-compaction prompt first`);
    process.exit(1);
  }
  const { rows, ok, allOk } = score(JSON.parse(readFileSync(file, 'utf8')), seed);
  for (const r of rows) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.category.padEnd(8)} ${r.id.padEnd(7)} expected=${r.expected} got=${r.got}`);
  }
  const stateFile = join(outDir, 'memory', 'state.md');
  const memory = scoreMemory(existsSync(stateFile) ? readFileSync(stateFile, 'utf8') : null, seed);
  for (const r of memory) console.log(`${r.pass ? 'PASS' : 'FAIL'}  memory   ${r.id.padEnd(7)} expected=${r.expected}`);
  const memoryOk = memory.every((r) => r.pass);
  console.log(
    ok ? `CORE OK${allOk ? ' (stretch too)' : ' (stretch failed: the needle survived neither verbatim nor in the digest)'}` : 'CORE FAILED',
  );
  console.log(memoryOk ? 'MEMORY SAVE OK (the pre-compaction prompt was sent and executed)' : 'MEMORY SAVE FAILED (memory/state.md missing or incomplete)');
  process.exit(ok && memoryOk ? 0 : 1);
}

function newestTranscript() {
  const dir = join(homedir(), '.claude', 'projects', outDir.replace(/[^A-Za-z0-9]/g, '-'));
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => join(dir, f));
  files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return files[0] ?? null;
}

const fi = rest.indexOf('--file');
const file = fi >= 0 ? resolve(rest[fi + 1]) : newestTranscript();
if (!file || !existsSync(file)) {
  console.log('INCONCLUSIVE: no session transcript found (pass --file). Use `score` instead.');
  process.exit(2);
}
const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
const digestAt = lines.findLastIndex((l) => l.includes(DIGEST_HEADER));
console.log(`transcript: ${file} (${lines.length} entries)`);
if (digestAt < 0) {
  console.log('INCONCLUSIVE: no digest message found. /compact-jev may have fallen back to the built-in');
  console.log('summary (check the toast / ui.log) or this build does not persist the rewritten history.');
  console.log('Use `score`, which tests the outcome directly.');
  process.exit(2);
}
const all = lines.join('\n');
const after = lines.slice(digestAt).join('\n');
const f = facts(seed);
const count = (s, needle) => s.split(needle).length - 1;
const digestLine = lines[digestAt];
// the pre-compaction prompt: sent (in the transcript) and executed (a write to memory/state.md after it)
const promptAt = lines.findIndex((l) => l.includes(PREPARE_MARKER) && !l.includes('"name":"Write"'));
const wroteAfter = promptAt >= 0 && lines.slice(promptAt + 1).some((l) => /state\.md/.test(l) && /"(Write|Edit)"|"name":"(Write|Edit)"/.test(l));
const checks = [
  ['memory-save prompt sent', promptAt >= 0],
  ['memory-save prompt executed (state.md written after it)', wroteAfter],
  ['digest message present', true],
  ['core facts still present after the digest', [f.port, f.errorBlock].every((v) => after.includes(v))],
  ['late (pinned) code present', after.includes(f.lateCode)],
  ['noise mostly removed', count(after, NOISE_TAG) < count(all, NOISE_TAG) * 0.5],
];
for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
const mention = (v) => digestLine.includes(v);
console.log(
  `digest mentions: branch=${mention(f.branch)} port=${mention(f.port)} retry=${mention(f.retryLimit)} block=${mention(f.errorBlock)} needle=${mention(f.rotatedKeyId)}`,
);
console.log(`noise tags: ${count(all, NOISE_TAG)} total, ${count(after, NOISE_TAG)} from the digest onward`);
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
