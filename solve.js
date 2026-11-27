// solve.js — JS side of the R11 entry.
//
// Hot path: main.ts hands the raw cases.json Buffer to solveBuffer(). The
// buffer is copied once into WASM linear memory at INPUT_BASE and everything
// else (scan, decode, intern, Myers, render, JSON encode) happens in WASM.
// No JSON.parse anywhere on the hot path.
//
// V8 tuning: --no-liftoff forces TurboFan compilation at instantiate so the
// first (measured) run executes compiled code instead of Liftoff code. The
// flag must be set before any WASM compilation, so it is set here at module
// top, before the WASM module is compiled. DIFF_FLAGS env override exists
// only for local A/B measurement ('none' | 'noliftoff' |
// 'noliftoff-nolazy'); the graded default is 'noliftoff'.
import { setFlagsFromString } from 'node:v8';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const FLAG_MODE = process.env.DIFF_FLAGS || 'noliftoff';
if (FLAG_MODE === 'noliftoff') {
  try { setFlagsFromString('--no-liftoff'); } catch (e) { /* flag unavailable */ }
} else if (FLAG_MODE === 'noliftoff-nolazy') {
  try { setFlagsFromString('--no-liftoff --no-lazy-compilation'); } catch (e) { /* flag unavailable */ }
}

// Memory layout shared with diff.ts (must match exactly).
export const INPUT_BASE = 1048576; // 1 MiB; offset 0 would overwrite WASM static data
const TRACE_RESERVE = 67108864; // 64 MiB for the Myers V trace
const TABLE_RESERVE = 16777216; // 16 MiB for intern tables / spans / ops
const OUT_SLACK = 1048576; // 1 MiB

const wasmBytes = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'diff.wasm'));
const wasmModule = new WebAssembly.Module(wasmBytes);
const instance = new WebAssembly.Instance(wasmModule, {});
const memory = instance.exports.memory;
const solveAll = instance.exports.solve_all;
const outputPtr = instance.exports.output_ptr;

// Grow linear memory once so the input, decoded text, trace, tables and
// output all fit. Untouched pages cost nothing; only touched pages fault in.
function ensureCapacity(inputLen) {
  const decodeBase = INPUT_BASE + inputLen;
  const scratchBase = decodeBase + inputLen;
  const outBase = scratchBase + TRACE_RESERVE + TABLE_RESERVE;
  const needBytes = outBase + 2 * inputLen + OUT_SLACK;
  const needPages = (needBytes + 65535) >> 16;
  const curPages = memory.buffer.byteLength >> 16;
  if (needPages > curPages) memory.grow(needPages - curPages);
}

export function solveBuffer(buf) {
  ensureCapacity(buf.length);
  const u8 = new Uint8Array(memory.buffer);
  u8.set(buf, INPUT_BASE);
  const outLen = solveAll(buf.length);
  const ptr = outputPtr();
  return Buffer.from(memory.buffer, ptr, outLen);
}

// Checker / single-case contract: run({old, new}) returns the makefun-diff
// answer string for one case. Implemented by feeding the pair through the
// same WASM path (JSON.stringify here is off the hot path).
export function run(input) {
  const casesJson = JSON.stringify([{ id: 'r11', input: { old: input.old, new: input.new } }]);
  const out = solveBuffer(Buffer.from(casesJson, 'utf8'));
  return JSON.parse(out.toString('utf8'))[0];
}
