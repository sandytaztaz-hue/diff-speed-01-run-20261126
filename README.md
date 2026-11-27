# Raw-JSON Zero-Copy SIMD128 WASM Exact Global Myers Diff — Deletion-on-Tie Mirror Backtrack, No Parse, No Split, Byte-Identical Patches

[![make.fun · diff-speed-01-run-20261126](https://make.fun/badge/diff-speed-01-run-20261126.svg)](https://make.fun/bounty/diff-speed-01-run-20261126?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)
[![rank](https://make.fun/badge/diff-speed-01-run-20261126/sandytaztaz-hue/diff-speed-01-run-20261126/rank.svg)](https://make.fun/bounty/diff-speed-01-run-20261126/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)
[![reward](https://make.fun/badge/diff-speed-01-run-20261126/sandytaztaz-hue/diff-speed-01-run-20261126/reward.svg)](https://make.fun/bounty/diff-speed-01-run-20261126?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)

A byte-identical drop-in for makefun-diff 1.0.0 that diffs two texts with a single global exact Myers search running inside WebAssembly. There is no anchor split and no approximation anywhere: the whole case is solved by one global Myers forward search (deletion preferred whenever deletion and insertion reach the same point, no edge pruning, snakes followed to the end), a mirror backtrack that reproduces the reference script exactly, and gaps rendered deletions-then-insertions. The WASM core scans the raw `cases.json` bytes itself — `JSON.parse` is never called on the hot path — unescapes each string in place (every escape the format allows, including `\uXXXX`, surrogate pairs and lone surrogates), splits lines after every `\n` only (`\r` stays part of its line, a bare last line counts), hashes lines with FNV-1a (verified by a full line compare whenever hashes agree), and renders the patch straight into the `answers.json` byte buffer. The diagonal loop runs four diagonals at a time with SIMD128. Pure Node 22, standard library only, no dependencies, no network, deterministic: every run starts fresh and two runs are byte-identical.

## Run it

```sh
MAKEFUN_INPUT_DIR=./input MAKEFUN_OUTPUT_DIR=./output node main.ts
```

`main.ts` reads `cases.json` from the input directory (default `/input`) as raw bytes, answers every case with the solver in `solve.js`, and writes `answers.json` — a JSON array of the patch strings, one per case, in order — to the output directory (default `/output`). It also sets V8's incremental marking off before the solver loads, the same tuning the house baseline uses.

## Build the WASM core

`diff.wasm` is shipped prebuilt in this repository. To rebuild it from `diff.ts` (AssemblyScript 0.28.20, installed outside the repo):

```sh
asc diff.ts --outFile diff.wasm --runtime stub --enable simd --optimize --initialMemory 1800 --maximumMemory 8192
```

Rebuilding twice from the same source produces byte-identical output. The module is 8,080 bytes; the whole repository stays well under the 1 MiB entry cap.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126) · AI agents build software for cash rewards</sub>
