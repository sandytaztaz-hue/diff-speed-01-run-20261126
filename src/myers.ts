// myers.ts — exact global Myers (deletion-on-tie) over line-id arrays.
// Forward pass stores a lazily grown u16 trace (row d starts at offset d*d,
// holding V_d for k in [-d, d]); backtrack reads the trace. The trace store
// itself is nearly free (sequential writes); the forward k-loop dominates.
// Trace values are x positions (<= number of lines, < 65536 by regime).

let traceBase: i32 = 0;

export function myersInit(base: i32): void {
  traceBase = base;
}

// Value of diagonal k after step d (trace row d holds k in [-d, d]).
// Diagonals outside the row were never written: the forward pass saw the
// zero-initialised V array there, so they read as 0 here too.
function traceAt(d: i32, k: i32): i32 {
  if (k < -d || k > d) return 0;
  return load<u16>(traceBase + d * d * 2 + (k + d) * 2);
}

function ensureTrace(d: i32): bool {
  if (d > 12000) return false;
  const need: i32 = (d + 1) * (d + 1) * 2;
  const avail: i32 = (memory.size() << 16) - traceBase;
  if (need <= avail) return true;
  let pages: i32 = (traceBase + need - (memory.size() << 16) + 65535) >> 16;
  if (pages < 256) pages = 256;
  if (memory.grow(pages) < 0) return false;
  return true;
}

// Diff id arrays A[0..n) vs B[0..m). Writes ops bytes at opsPtr
// (0 = keep, 1 = delete, 2 = insert) for the trimmed middle region, and
// pre/suf trim lengths as i32s at resPtr[0..1]. Returns ops count, or -1.
export function myersDiff(
  aPtr: i32,
  bPtr: i32,
  n: i32,
  m: i32,
  vPtr: i32,
  opsPtr: i32,
  resPtr: i32,
): i32 {
  let pre: i32 = 0;
  while (
    pre < n &&
    pre < m &&
    load<i32>(aPtr + pre * 4) == load<i32>(bPtr + pre * 4)
  ) {
    pre++;
  }
  let suf: i32 = 0;
  while (
    suf < n - pre &&
    suf < m - pre &&
    load<i32>(aPtr + (n - 1 - suf) * 4) ==
      load<i32>(bPtr + (m - 1 - suf) * 4)
  ) {
    suf++;
  }
  store<i32>(resPtr, pre);
  store<i32>(resPtr + 4, suf);
  const N: i32 = n - pre - suf;
  const M: i32 = m - pre - suf;
  const A: i32 = aPtr + pre * 4;
  const B: i32 = bPtr + pre * 4;
  if (N == 0) {
    for (let j = 0; j < M; j++) store<u8>(opsPtr + j, 2);
    return M;
  }
  if (M == 0) {
    for (let i = 0; i < N; i++) store<u8>(opsPtr + i, 1);
    return N;
  }
  const off: i32 = N + M;
  // Zero the whole V array: the forward pass reads never-written diagonals
  // (near the edges) as 0, and stale values from a previous case would
  // corrupt the tie-breaks.
  memory.fill(vPtr, 0, (2 * off + 1) * 4);
  let D: i32 = -1;
  for (let d = 0; d <= N + M; d++) {
    if (!ensureTrace(d)) return -1;
    const row: i32 = traceBase + d * d * 2;
    let k: i32 = -d;
    while (k <= d) {
      const ki: i32 = k + off;
      let x: i32;
      // Deletion-on-tie (oracle rule): insertion only when it reaches
      // strictly further than the deletion (V[k-1]+1 < V[k+1]); on equal
      // reach the deletion wins. The plain V[k-1] < V[k+1] test takes the
      // insertion on a tie and emits a different minimal script.
      if (
        k == -d ||
        (k != d &&
          load<i32>(vPtr + (ki - 1) * 4) + 1 <
            load<i32>(vPtr + (ki + 1) * 4))
      ) {
        x = load<i32>(vPtr + (ki + 1) * 4);
      } else {
        x = load<i32>(vPtr + (ki - 1) * 4) + 1;
      }
      let y: i32 = x - k;
      while (
        x < N &&
        y < M &&
        load<i32>(A + x * 4) == load<i32>(B + y * 4)
      ) {
        x++;
        y++;
      }
      store<i32>(vPtr + ki * 4, x);
      store<u16>(row + (k + d) * 2, x);
      if (x >= N && y >= M) {
        D = d;
        break;
      }
      k += 2;
    }
    if (D >= 0) break;
  }
  if (D < 0) return -1;
  let x: i32 = N;
  let y: i32 = M;
  let w: i32 = 0;
  for (let d = D; d > 0; d--) {
    const k: i32 = x - y;
    let pk: i32;
    // Backtrack must use the same tie-break as the forward pass.
    if (
      k == -d ||
      (k != d && traceAt(d - 1, k - 1) + 1 < traceAt(d - 1, k + 1))
    ) {
      pk = k + 1;
    } else {
      pk = k - 1;
    }
    const px: i32 = traceAt(d - 1, pk);
    const py: i32 = px - pk;
    while (x > px && y > py) {
      store<u8>(opsPtr + w, 0);
      w++;
      x--;
      y--;
    }
    if (x == px) {
      store<u8>(opsPtr + w, 2);
      w++;
      y--;
    } else {
      store<u8>(opsPtr + w, 1);
      w++;
      x--;
    }
  }
  while (x > 0 && y > 0) {
    store<u8>(opsPtr + w, 0);
    w++;
    x--;
    y--;
  }
  for (let i = 0; i < (w >> 1); i++) {
    const t: u8 = load<u8>(opsPtr + i);
    store<u8>(opsPtr + i, load<u8>(opsPtr + w - 1 - i));
    store<u8>(opsPtr + w - 1 - i, t);
  }
  return w;
}
