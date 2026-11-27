// solve.js — loader for the diff.ts WebAssembly core.
// Reads diff.wasm from beside this file (derived from import.meta.url),
// instantiates it synchronously, and exposes:
//   run(input)        — the harness contract: {old, new} -> patch string.
//   runAll(inputBytes) — the fast path main.ts uses: raw cases.json bytes
//                        -> answers.json bytes (no JSON.parse anywhere).
import { readFileSync } from "node:fs";

const INPUT_PTR = 65536;
const INPUT_CAP = 16777216;

const wasmBytes = readFileSync(new URL("./diff.wasm", import.meta.url));
const wasmModule = new WebAssembly.Module(wasmBytes);
const wasmInstance = new WebAssembly.Instance(wasmModule, {});
const wasmMemory = wasmInstance.exports.memory;
const wasmRunAll = wasmInstance.exports.runAll;
const wasmGetOutPtr = wasmInstance.exports.getOutPtr;

export function runAll(inputBytes) {
  if (inputBytes.length > INPUT_CAP) throw new Error("input too large");
  const mem = new Uint8Array(wasmMemory.buffer);
  mem.set(inputBytes, INPUT_PTR);
  const outLen = wasmRunAll(INPUT_PTR, inputBytes.length);
  const outPtr = wasmGetOutPtr();
  return new Uint8Array(wasmMemory.buffer, outPtr, outLen).slice();
}

export function run(input) {
  const payload = new TextEncoder().encode(
    JSON.stringify([{ id: "case", input: { old: input.old, new: input.new } }]),
  );
  const out = runAll(payload);
  return JSON.parse(new TextDecoder().decode(out))[0];
}
