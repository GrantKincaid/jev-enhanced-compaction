// node tests/session-memory/generate.mjs <outDir> [--noise-count 12] [--noise-chars 20000] [--seed s]
// Writes the workspace and prints the exact messages to paste into the test session.
import { resolve } from 'node:path';
import { DEFAULT_SEED, generate, openingMessage, quizText } from './lib.mjs';

const args = process.argv.slice(2);
const outDir = args[0] && !args[0].startsWith('--') ? resolve(args[0]) : null;
if (!outDir) {
  console.error('usage: node generate.mjs <outDir> [--noise-count N] [--noise-chars N] [--seed S]');
  process.exit(1);
}
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const seed = flag('seed', DEFAULT_SEED);
const noiseCount = Number(flag('noise-count', 12));
const noiseChars = Number(flag('noise-chars', 20000));
const steps = generate(outDir, { seed, noiseCount, noiseChars });
const approxTokens = Math.round((noiseCount * noiseChars + 24000) / 4);

console.log(`workspace ready: ${outDir}`);
console.log(`${steps.length} tool calls, roughly ${approxTokens} tokens of tool output\n`);
console.log('1. Start a session with that directory as its working directory (plugin installed).');
console.log('2. Send this as your first message:\n');
console.log(`   ${openingMessage(seed)} Then read TASK.md and follow it exactly.\n`);
console.log('3. When it replies "READY FOR /compact-jev", run /compact-jev.');
console.log('4. Then send this message:\n');
console.log('   Answer from memory only: do not read files or run commands. Just write');
console.log('   answers.json (a JSON object, one string value per id):\n');
console.log(quizText().replace(/^/gm, '   ') + '\n');
console.log(`5. node tests/session-memory/verify.mjs score "${outDir}"`);
console.log(`   node tests/session-memory/verify.mjs transcript "${outDir}"`);
