import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { solveBuffer } from './solve.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR || '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';
const raw = readFileSync(inputDir + '/cases.json');
const answers = solveBuffer(raw);
mkdirSync(outputDir, { recursive: true });
writeFileSync(outputDir + '/answers.json', answers);
