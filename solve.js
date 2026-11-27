// solve.js — drop-in wrapper for the R6 WASM entry (makefun-diff contract).
// run(input) returns makefun-diff's answer for one case's { old, new }.
// The heavy work lives in diff.wasm; this module only frames one case as a
// one-element cases array, runs the module, and unwraps the single answer.
import { readFileSync } from "node:fs";

const wasmBytes = readFileSync(new URL("./diff.wasm", import.meta.url));
const wasmModule = new WebAssembly.Module(wasmBytes);
const mem = new WebAssembly.Memory({ initial: 1280, maximum: 1280 });
const inst = new WebAssembly.Instance(wasmModule, { env: { memory: mem } });
const u8 = new Uint8Array(mem.buffer);

export function run(input) {
  const cases = [{ id: "x", input }];
  const bytes = Buffer.from(JSON.stringify(cases), "utf8");
  u8.set(bytes, 0);
  const outLen = inst.exports.solve(bytes.length);
  if (outLen <= 0) throw new Error("solve failed, err=" + inst.exports.getError());
  const answers = JSON.parse(Buffer.from(u8.subarray(0x2000000, 0x2000000 + outLen)).toString("utf8"));
  return answers[0];
}
