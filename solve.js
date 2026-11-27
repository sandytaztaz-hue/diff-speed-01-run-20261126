// solve.js — plain-JS worker for the R7 entry.
//
// The hot path lives in the prebuilt WebAssembly module (diff.wasm,
// compiled from diff.ts). This file only moves bytes: it reads the cases
// file into the module's memory, calls the single entry point, and writes
// the answers out. No JSON.parse anywhere on the hot path.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const wasmBytes = readFileSync(join(HERE, "diff.wasm"));
const wasmModule = new WebAssembly.Module(wasmBytes);
const wasmInstance = new WebAssembly.Instance(wasmModule, {});
const wasmMemory = wasmInstance.exports.memory;
const wasmSolve = wasmInstance.exports.solve;
const wasmInPtr = wasmInstance.exports.inPtr();
const wasmOutPtr = wasmInstance.exports.outPtr();

// Run the whole cases file (a Buffer of raw JSON bytes) through the module
// and return the answers file bytes.
export function solveBuffer(input) {
  const bytes = new Uint8Array(wasmMemory.buffer);
  bytes.set(input, wasmInPtr);
  const outLen = wasmSolve(input.length);
  return Buffer.from(wasmMemory.buffer, wasmOutPtr, outLen);
}

// run(input) — the drop-in API from the competition rules: answer one case's
// { old, new } exactly as makefun-diff does, as one JSON string. This wraps
// the same WASM path with a one-case file; it is not used by main.ts.
export function run(input) {
  const cases = JSON.stringify([{ id: "x", input }]);
  const out = solveBuffer(Buffer.from(cases, "utf8"));
  return JSON.parse(out.toString("utf8"))[0];
}

// main() — the harness entry: read every case, answer each, write answers.
export async function main() {
  const inDir = process.env.MAKEFUN_INPUT_DIR || "/input";
  const outDir = process.env.MAKEFUN_OUTPUT_DIR || "/output";
  const input = readFileSync(join(inDir, "cases.json"));
  const output = solveBuffer(input);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "answers.json"), output);
}
