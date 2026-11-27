// solve.js — entrypoint worker for the diff-speed R5 entry.
// Instantiates the prebuilt WASM module once, feeds it the raw input file
// straight into WASM memory (zero-copy), and writes the answers straight
// out of WASM memory. No JSON parsing and no string work happens here.
import { readFileSync, readSync, writeSync, openSync, closeSync } from "node:fs";

const wasmBytes = readFileSync(new URL("./diff.wasm", import.meta.url));
const wasmModule = new WebAssembly.Module(wasmBytes);
const wasm = new WebAssembly.Instance(wasmModule, {});
const memory = wasm.exports.memory;
const solveRaw = wasm.exports.solveRaw;
const solveCase = wasm.exports.solveCase;
const RAW_PTR = wasm.exports.rawPtr();
const DEC_PTR = wasm.exports.decPtr();
const OUT_PTR = wasm.exports.outPtr();

function inputPath() {
  const dir = process.env.MAKEFUN_INPUT_DIR;
  return dir ? dir + "/cases.json" : "/input/cases.json";
}

function outputPath() {
  const dir = process.env.MAKEFUN_OUTPUT_DIR;
  return dir ? dir + "/answers.json" : "/output/answers.json";
}

export function main() {
  const inFd = openSync(inputPath(), "r");
  const rawView = new Uint8Array(memory.buffer, RAW_PTR, 0x3000000);
  let size = 0;
  while (true) {
    const n = readSync(inFd, rawView, size, rawView.length - size, null);
    if (n === 0) break;
    size += n;
    if (size >= rawView.length) {
      closeSync(inFd);
      throw new Error("input too large for RAW area");
    }
  }
  closeSync(inFd);
  const outLen = solveRaw(size);
  if (outLen < 0) throw new Error("solveRaw failed");
  const outFd = openSync(outputPath(), "w");
  const outView = new Uint8Array(memory.buffer, OUT_PTR, outLen);
  let written = 0;
  while (written < outLen) {
    written += writeSync(outFd, outView, written, outLen - written);
  }
  closeSync(outFd);
}

// string path: input is { old, new } or { input: { old, new } };
// returns the patch string.
export function run(input) {
  const oldText = input.input ? input.input.old : input.old;
  const newText = input.input ? input.input.new : input.new;
  const oldBuf = Buffer.from(oldText, "utf16le");
  const newBuf = Buffer.from(newText, "utf16le");
  const oldLen = oldBuf.length / 2;
  const newLen = newBuf.length / 2;
  const oldPtr = DEC_PTR;
  const newPtr = DEC_PTR + oldBuf.length;
  new Uint8Array(memory.buffer, oldPtr, oldBuf.length).set(oldBuf);
  new Uint8Array(memory.buffer, newPtr, newBuf.length).set(newBuf);
  const patchLen = solveCase(oldPtr, oldLen, newPtr, newLen, OUT_PTR);
  if (patchLen < 0) throw new Error("solveCase failed");
  return Buffer.from(new Uint8Array(memory.buffer, OUT_PTR, patchLen * 2)).toString("utf16le");
}
