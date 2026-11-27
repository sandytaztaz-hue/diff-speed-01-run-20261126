// R12: zero-copy raw-JSON SIMD128 WASM exact Myers diff.
// main.ts reads /input/cases.json as a raw Buffer and hands it to run();
// everything (scan, line split, interning, Myers, render) happens inside
// the WASM module, which returns the finished answers.json bytes as a string.
import { readFileSync } from 'node:fs';
import v8 from 'node:v8';

// Must run before ANY WebAssembly compilation: force eager TurboFan
// compilation (no Liftoff, no lazy stubs) so the cold run pays compile
// once, up front, instead of per-function tier-up cost.
v8.setFlagsFromString('--no-liftoff --no-lazy-compilation');

let wasm = null;
let wasmMemory = null;

function loadWasm() {
  if (wasm) return wasm;
  const bytes = readFileSync(new URL('./diff.wasm', import.meta.url));
  const mod = new WebAssembly.Module(bytes);
  const inst = new WebAssembly.Instance(mod, {});
  wasm = inst.exports;
  wasmMemory = wasm.memory;
  return wasm;
}

export function run(input) {
  const w = loadWasm();
  const len = input.length;
  const inPtr = w.inputBuf(len);
  new Uint8Array(wasmMemory.buffer).set(input, inPtr);
  const outLen = w.solveAll(inPtr, len);
  const outPtr = w.outPtr();
  return Buffer.from(wasmMemory.buffer, outPtr, outLen).toString('utf8');
}
