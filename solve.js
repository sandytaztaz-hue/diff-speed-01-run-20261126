import fs from "node:fs";

// diff.wasm is built from diff.ts (AssemblyScript) and shipped in this repo.
// solve.js is a thin shim: read the file into WASM memory, call in, write out.
// No JSON.parse on the hot path: runAllBytes hands the raw cases.json bytes
// to WASM, which scans the JSON, diffs each case and renders answers.json.
const wasmBytes = fs.readFileSync(new URL("./diff.wasm", import.meta.url));
const { instance } = await WebAssembly.instantiate(wasmBytes, {
  env: { abort() { throw new Error("wasm abort"); } },
});
const ex = instance.exports;
const mem = ex.memory;
const enc = new TextEncoder();
// Decode UTF-8, mapping CESU-8 surrogate sequences (ED A0..BF 80..BF) back
// to lone surrogates, so run() returns the exact JS string (code units).
function decodeCesu8(bytes) {
  let out = "";
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i];
    if (b0 < 0x80) { out += String.fromCharCode(b0); i += 1; continue; }
    if ((b0 & 0xe0) == 0xc0 && i + 1 < bytes.length) {
      out += String.fromCharCode(((b0 & 0x1f) << 6) | (bytes[i + 1] & 0x3f));
      i += 2; continue;
    }
    if ((b0 & 0xf0) == 0xe0 && i + 2 < bytes.length) {
      const b1 = bytes[i + 1], b2 = bytes[i + 2];
      const cp = ((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f);
      if (b0 == 0xed && b1 >= 0xa0) { out += String.fromCharCode(cp); i += 3; continue; }
      out += String.fromCharCode(cp);
      i += 3; continue;
    }
    if ((b0 & 0xf8) == 0xf0 && i + 3 < bytes.length) {
      const cp = ((b0 & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) |
        ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f);
      out += String.fromCodePoint(cp);
      i += 4; continue;
    }
    out += "\uFFFD";
    i += 1;
  }
  return out;
}

function u8() {
  return new Uint8Array(mem.buffer);
}

// Fast path used by main.ts: raw cases.json bytes in, answers.json bytes out.
export function runAllBytes(buf) {
  if (buf.length > ex.inCap()) throw new Error("input too large");
  ex.ensureInput(buf.length);
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
  ex.ensureInput(oldB.length + newB.length);
  const m = u8();
  m.set(oldB, base);
  m.set(newB, base + oldB.length);
  const len = ex.runPair(oldB.length, newB.length);
  const out = u8();
  return decodeCesu8(out.subarray(ex.outPtr(), ex.outPtr() + len));
}

export default { run, runAllBytes };
