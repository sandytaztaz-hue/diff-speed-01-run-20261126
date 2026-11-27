import { setFlagsFromString } from "node:v8";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { runAllBytes } from "./solve.js";

try {
  setFlagsFromString("--no-incremental-marking");
} catch {}

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
const buf = readFileSync(`${inputDir}/cases.json`);
const out = runAllBytes(buf);
mkdirSync(outputDir, { recursive: true });
writeFileSync(`${outputDir}/answers.json`, out);
