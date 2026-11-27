// Harness driver: reads every case from the harness input directory,
// answers each one with the solver, and writes the answers in order to
// answers.json in the harness output directory.
//
// Input directory: $MAKEFUN_INPUT_DIR, or /input in the sandbox.
// Output directory: $MAKEFUN_OUTPUT_DIR, or /output in the sandbox.
// Input file: cases.json, a JSON array of {"id", "input"} in order.
// Output file: answers.json, a JSON array of the answers, one per case.
// The solver is imported dynamically above so the V8 flag is set first;
// run() itself carries no state between cases.

import { setFlagsFromString } from "node:v8";

// Same tuning the house baseline uses: incremental marking off before
// the solver loads, so the timed run does not pay for it.
setFlagsFromString("--noincremental-marking");

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const { run } = await import("./solve.js");

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

const cases = JSON.parse(
  readFileSync(inputDir + "/cases.json", "utf8"),
);
const answers = cases.map((c) => run(c.input));

mkdirSync(outputDir, { recursive: true });
writeFileSync(outputDir + "/answers.json", JSON.stringify(answers));
