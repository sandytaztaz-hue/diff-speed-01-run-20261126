// solve.js — thin JS shim over the prebuilt diff.wasm core.
// The hot path never calls JSON.parse: main.ts hands the raw cases buffer to
// runCases, the WASM scans it directly and renders answers.json bytes.
// run(input) is the spec-shaped entry point: it takes one case's {old, new}
// (object, raw JSON string, or raw JSON bytes) and returns the makefun-diff
// patch for it as one string.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const bytes = readFileSync(join(dir, "diff.wasm"));
const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), {
  env: {
    abort() {
      throw new Error("wasm abort");
    },
  },
});
const ex = inst.exports;
const dec = new TextDecoder();

function view() {
  return new Uint8Array(ex.memory.buffer);
}

export function runCases(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const u = view();
  u.set(b, ex.inPtr());
  const n = ex.runCases(ex.inPtr(), b.length, ex.outPtr());
  return u.subarray(ex.outPtr(), ex.outPtr() + n);
}

export function run(input) {
  let raw;
  if (typeof input === "string") {
    raw = Buffer.from(input, "utf8");
  } else if (input instanceof Uint8Array) {
    raw = input;
  } else if (input && typeof input === "object") {
    raw = Buffer.from(
      JSON.stringify({ old: input.old, new: input.new }),
      "utf8",
    );
  } else {
    throw new TypeError("run: unsupported input");
  }
  const u = view();
  u.set(raw, ex.inPtr());
  const n = ex.runOne(ex.inPtr(), raw.length, ex.outPtr());
  const esc = dec.decode(u.subarray(ex.outPtr(), ex.outPtr() + n));
  return JSON.parse('"' + esc + '"');
}
