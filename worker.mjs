// worker.mjs — plain JavaScript worker for the diff-speed R6 entry.
// Reads /input/cases.json straight into the WASM memory (no copy, no parse),
// instantiates the prebuilt module, runs it, writes the answers straight out
// of the WASM memory. No JSON.parse / JSON.stringify anywhere on this path.
import { openSync, readSync, writeSync, closeSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const IN = process.env.MAKEFUN_INPUT_DIR || "/input";
const OUT = process.env.MAKEFUN_OUTPUT_DIR || "/output";
const IN_CAP = 0x2000000;
const OUT_BASE = 0x2000000;

const wasmBytes = readFileSync(new URL("./diff.wasm", import.meta.url));
const mem = new WebAssembly.Memory({ initial: 1280, maximum: 1280 });
const u8 = new Uint8Array(mem.buffer);

const fd = openSync(join(IN, "cases.json"), "r");
let n = 0;
for (;;) {
  const r = readSync(fd, u8, n, IN_CAP - n, null);
  if (r === 0) break;
  n += r;
  if (n >= IN_CAP) throw new Error("input too large");
}
closeSync(fd);

const inst = new WebAssembly.Instance(new WebAssembly.Module(wasmBytes), { env: { memory: mem } });
const outLen = inst.exports.solve(n);
if (outLen <= 0) throw new Error("solve failed, err=" + inst.exports.getError());

mkdirSync(OUT, { recursive: true });
const ofd = openSync(join(OUT, "answers.json"), "w");
let w = 0;
while (w < outLen) w += writeSync(ofd, u8, OUT_BASE + w, outLen - w);
closeSync(ofd);
