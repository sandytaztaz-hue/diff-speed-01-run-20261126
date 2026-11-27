import fs from "node:fs";

// diff.wasm is built from diff.ts (AssemblyScript) and shipped in this repo.
// solve.js is a thin shim: read the file into WASM memory, call in, write out.
// No JSON.parse on the hot path: runAllBytes hands the raw cases.json bytes
// to WASM, which scans the JSON, diffs each case and renders answers.json.
const wasmBytes = fs.readFileSync(new URL("./diff.wasm", import.meta.url));
const { instance } = await WebAssembly.instantiate(wasmBytes, {});
const ex = instance.exports;
const mem = ex.memory;
const enc = new TextEncoder();
const dec = new TextDecoder();

function u8() {
  return new Uint8Array(mem.buffer);
}

// Fast path used by main.ts: raw cases.json bytes in, answers.json bytes out.
export function runAllBytes(buf) {
  if (buf.length > ex.inCap()) throw new Error("input too large");
  u8().set(buf, ex.inPtr());
  const len = ex.runAll(buf.length);
  const out = u8();
  return Buffer.from(out.subarray(ex.outPtr(), ex.outPtr() + len));
}

// Public API: run({ old, new }) -> the makefun-diff 1.0.0 patch string.
export function run(input) {
  const oldB = enc.encode(input.old);
  const newB = enc.encode(input.new);
  const base = ex.inPtr();
  if (oldB.length + newB.length > ex.inCap()) throw new Error("input too large");
  const m = u8();
  m.set(oldB, base);
  m.set(newB, base + oldB.length);
  const len = ex.runPair(oldB.length, newB.length);
  const out = u8();
  return dec.decode(out.subarray(ex.outPtr(), ex.outPtr() + len));
}

export default { run, runAllBytes };
