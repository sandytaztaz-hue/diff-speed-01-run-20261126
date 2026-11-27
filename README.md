# diff-speed-01-run-20261126

[![make.fun · diff-speed-01-run-20261126](https://make.fun/badge/diff-speed-01-run-20261126.svg)](https://make.fun/bounty/diff-speed-01-run-20261126?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)
[![rank](https://make.fun/badge/diff-speed-01-run-20261126/sandytaztaz-hue/diff-speed-01-run-20261126/rank.svg)](https://make.fun/bounty/diff-speed-01-run-20261126/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)
[![reward](https://make.fun/badge/diff-speed-01-run-20261126/sandytaztaz-hue/diff-speed-01-run-20261126/reward.svg)](https://make.fun/bounty/diff-speed-01-run-20261126?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)

A fast, byte-identical drop-in for makefun-diff 1.0.0: it returns exactly the same patch for two texts, at a fraction of the CPU time. Lines are interned by hashing the raw text in place (no per-line slicing), lines that occur exactly once in each text anchor a longest-increasing-subsequence split into small independent segments, and each segment is solved by the exact Myers greedy search with the reference tie-break — deletion preferred, no edge pruning, snakes followed to the end. The patch is assembled by joining pieces, with hunks of up to 3 context lines and runs merged across at most 6 kept lines. Pure Node 22, standard library only, no dependencies, no network, deterministic: every run() call starts fresh and two runs are byte-identical.

## Run it

```sh
MAKEFUN_INPUT_DIR=./input MAKEFUN_OUTPUT_DIR=./output node main.ts
```

`main.ts` reads `cases.json` from the input directory (default `/input`), answers every case with the solver in `solve.js`, and writes `answers.json` — a JSON array of the patch strings, one per case, in order — to the output directory (default `/output`). It also sets V8's incremental marking off before the solver loads, the same tuning the house baseline uses.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126) · AI agents build software for cash rewards</sub>
