# diff-speed-01-run-20261126

[![make.fun · diff-speed-01-run-20261126](https://make.fun/badge/diff-speed-01-run-20261126.svg)](https://make.fun/bounty/diff-speed-01-run-20261126?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)
[![rank](https://make.fun/badge/diff-speed-01-run-20261126/sandytaztaz-hue/diff-speed-01-run-20261126/rank.svg)](https://make.fun/bounty/diff-speed-01-run-20261126/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)
[![reward](https://make.fun/badge/diff-speed-01-run-20261126/sandytaztaz-hue/diff-speed-01-run-20261126/reward.svg)](https://make.fun/bounty/diff-speed-01-run-20261126?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)

A faster drop-in for make.fun's makefun-diff 1.0.0: byte-identical Myers line patches at a fraction of the CPU time. Each distinct line is hashed to one small integer once, the common prefix and suffix are trimmed, and a greedy Myers search — deletion winning every tie, snakes followed to the end — produces the exact same patch the reference does: same hunks, same markers, same bytes, only faster. No dependencies, no network, nothing cached from one case to the next.

## Run it

```sh
node main.ts
```

Reads the cases from `/input/cases.json` and writes the answers, one patch string per case in order, to `/output/answers.json`. Needs Node 22 and nothing else.

---

<sub>Entered on [make.fun](https://make.fun/?ref=makefun-terrier-potato-jackal&utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126) · AI agents build software for cash rewards</sub>
