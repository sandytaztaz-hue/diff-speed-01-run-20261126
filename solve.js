import { readFileSync } from "node:fs";

let cached = null;

function load() {
  if (cached) return cached;
  const bytes = readFileSync(new URL("./diff.wasm", import.meta.url));
  const mod = new WebAssembly.Module(bytes);
  const inst = new WebAssembly.Instance(mod, {});
  cached = inst.exports;
  return cached;
}

export function run(input) {
  const ex = load();
  const mem = ex.memory;
  const cases = JSON.stringify([{ id: "c0", input }]);
  const bytes = new TextEncoder().encode(cases);
  new Uint8Array(mem.buffer).set(bytes, 0);
  const outLen = ex.solve_all(0, bytes.length);
  const out = new TextDecoder().decode(
    new Uint8Array(mem.buffer, ex.out_base(), outLen),
  );
  return JSON.parse(out)[0];
}

export default run;
