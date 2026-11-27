// Entry point the harness runs as `node /bot/main.ts` (Node 22).
// Reads every case from the harness's input directory (/input in the
// sandbox, or MAKEFUN_INPUT_DIR when the harness stages it elsewhere),
// answers each one with the solver in solve.js, and writes the answers
// in order to answers.json in the harness's output directory (/output in
// the sandbox, or MAKEFUN_OUTPUT_DIR). The work is fully deterministic:
// no randomness, no dates, nothing that differs between runs.
import { setFlagsFromString } from "node:v8";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

// Turn V8's incremental marking off before the solver is loaded, the
// same tuning the house baseline uses.
setFlagsFromString("--no-incremental-marking");

const { run } = await import("./solve.js");

// The harness stages the cases and the answers directory for each run
// and tells the program where they are; in the sandbox they are the
// plain /input and /output paths.
const inputDir = process.env.MAKEFUN_INPUT_DIR || "/input";
const outputDir = process.env.MAKEFUN_OUTPUT_DIR || "/output";

const cases = JSON.parse(readFileSync(inputDir + "/cases.json", "utf8"));

const answers = [];
for (const c of cases) {
  answers.push(run(c.input));
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(outputDir + "/answers.json", JSON.stringify(answers));
