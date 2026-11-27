// main.ts — harness program. Reads cases.json as RAW BYTES (no JSON.parse),
// answers every case with the WASM solver, writes answers.json.
// V8 incremental marking is switched off before the solver loads, the same
// tuning the house baseline uses.
import { setFlagsFromString } from "node:v8";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

setFlagsFromString("--no-incremental-marking");

const inputDir = process.env.MAKEFUN_INPUT_DIR || "/input";
const outputDir = process.env.MAKEFUN_OUTPUT_DIR || "/output";
const input = readFileSync(inputDir + "/cases.json");

import("./solve.js").then(({ runAll }) => {
  const answers = runAll(input);
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(outputDir + "/answers.json", answers);
});
