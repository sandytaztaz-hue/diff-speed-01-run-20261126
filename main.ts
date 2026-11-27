import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { run } from './solve.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const input = readFileSync(`${inputDir}/cases.json`);
const out = run(input);
mkdirSync(outputDir, { recursive: true });
writeFileSync(`${outputDir}/answers.json`, out);
