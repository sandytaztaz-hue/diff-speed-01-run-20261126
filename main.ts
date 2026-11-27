import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const inDir = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

const input = readFileSync(inDir + "/cases.json");
const wasmBytes = readFileSync(new URL("./diff.wasm", import.meta.url));
const mod = new WebAssembly.Module(wasmBytes);
const inst = new WebAssembly.Instance(mod, {});
const mem = inst.exports.memory as WebAssembly.Memory;
const solveAll = inst.exports.solve_all as (a: number, b: number) => number;
const outBase = inst.exports.out_base as () => number;
const inputBase = inst.exports.input_base as () => number;

const inBase = inputBase();
// Grow the (lazily small) memory to fit the input before copying.
const needBytes = inBase + input.length;
if (needBytes > mem.buffer.byteLength) {
  const pages = Math.ceil((needBytes - mem.buffer.byteLength) / 65536);
  mem.grow(pages);
}
new Uint8Array(mem.buffer).set(input, inBase);
const outLen = solveAll(inBase, input.length);
const out = new Uint8Array(mem.buffer, outBase(), outLen);
mkdirSync(outDir, { recursive: true });
writeFileSync(outDir + "/answers.json", out);
