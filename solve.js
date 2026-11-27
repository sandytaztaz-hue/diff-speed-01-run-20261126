// A fast drop-in for makefun-diff 1.0.0, written from the competition's
// prose specification.
//
// Idea: a text is cut into lines (a line runs through its '\n'; the last
// line may lack one), every distinct line is hashed to one small integer
// shared by both texts, and the whole diff runs on integer arrays, so the
// search never compares strings. The common prefix of lines is kept,
// then the common suffix of what is left; between them Myers's greedy
// search runs, keeping on each diagonal the path reaching furthest into
// the old text, with a deletion winning over an insertion when both reach
// the same point, and following every run of equal lines as far as it
// goes. The furthest-reaching array of every round is kept, so the
// script is walked back from both ends. Hunks show up to 3 kept lines
// around each run of changes, and runs at most 6 kept lines apart share
// one hunk.

export function run(input) {
  const oldText = input.old;
  const newText = input.new;

  // Split both texts into lines and give every distinct line one integer
  // id. starts[i] is where line i begins; starts[count] is the text end,
  // so line i is text.slice(starts[i], starts[i + 1]).
  const ids = new Map();
  let nextId = 0;

  const oldStarts = [0];
  const oldIds = [];
  let p = 0;
  while (p < oldText.length) {
    const nl = oldText.indexOf("\n", p);
    const end = nl === -1 ? oldText.length : nl + 1;
    const line = oldText.slice(p, end);
    let id = ids.get(line);
    if (id === undefined) {
      id = nextId++;
      ids.set(line, id);
    }
    oldIds.push(id);
    oldStarts.push(end);
    p = end;
  }

  const newStarts = [0];
  const newIds = [];
  p = 0;
  while (p < newText.length) {
    const nl = newText.indexOf("\n", p);
    const end = nl === -1 ? newText.length : nl + 1;
    const line = newText.slice(p, end);
    let id = ids.get(line);
    if (id === undefined) {
      id = nextId++;
      ids.set(line, id);
    }
    newIds.push(id);
    newStarts.push(end);
    p = end;
  }

  const oldCount = oldIds.length;
  const newCount = newIds.length;
  const A = Int32Array.from(oldIds);
  const B = Int32Array.from(newIds);

  // Keep the common prefix, then the common suffix of the lines left.
  let pre = 0;
  while (pre < oldCount && pre < newCount && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (
    suf < oldCount - pre &&
    suf < newCount - pre &&
    A[oldCount - 1 - suf] === B[newCount - 1 - suf]
  ) {
    suf++;
  }

  // The edit script for the middle: 0 keep, 1 delete, 2 insert.
  const midOps = diffOps(
    A.subarray(pre, oldCount - suf),
    B.subarray(pre, newCount - suf),
  );

  // Full op list: prefix keeps, middle script, suffix keeps.
  const ops = new Array(pre + midOps.length + suf);
  let w = 0;
  for (let i = 0; i < pre; i++) ops[w++] = 0;
  for (let i = 0; i < midOps.length; i++) ops[w++] = midOps[i];
  for (let i = 0; i < suf; i++) ops[w++] = 0;

  // Line positions before each op, so hunk headers come out directly.
  const nOps = ops.length;
  const posO = new Int32Array(nOps + 1);
  const posN = new Int32Array(nOps + 1);
  let oi = 0;
  let ni = 0;
  let deleted = 0;
  let inserted = 0;
  for (let i = 0; i < nOps; i++) {
    posO[i] = oi;
    posN[i] = ni;
    const op = ops[i];
    if (op === 0) {
      oi++;
      ni++;
    } else if (op === 1) {
      oi++;
      deleted++;
    } else {
      ni++;
      inserted++;
    }
  }
  posO[nOps] = oi;
  posN[nOps] = ni;

  // Change runs, merged into hunks when at most 6 kept lines apart.
  const runs = [];
  let i = 0;
  while (i < nOps) {
    if (ops[i] === 0) {
      i++;
      continue;
    }
    const start = i;
    while (i < nOps && ops[i] !== 0) i++;
    runs.push(start, i);
  }

  const hunks = [];
  for (let r = 0; r < runs.length; r += 2) {
    let hs = runs[r];
    let he = runs[r + 1];
    while (r + 2 < runs.length && runs[r + 2] - he <= 6) {
      r += 2;
      he = runs[r + 1];
    }
    let cs = hs;
    let c = 0;
    while (cs > 0 && c < 3 && ops[cs - 1] === 0) {
      cs--;
      c++;
    }
    let ce = he;
    c = 0;
    while (ce < nOps && c < 3 && ops[ce] === 0) {
      ce++;
      c++;
    }
    hunks.push(cs, ce);
  }

  // Emit the patch: header, then each hunk with its lines. A line that
  // ends its text with no newline is written with one added, followed by
  // a line holding just %.
  let out =
    "makefun-diff/1 old=" +
    oldCount +
    " new=" +
    newCount +
    " hunks=" +
    (hunks.length / 2) +
    " deleted=" +
    deleted +
    " inserted=" +
    inserted +
    "\n";
  for (let h = 0; h < hunks.length; h += 2) {
    const hs = hunks[h];
    const he = hunks[h + 1];
    out +=
      "@ " +
      (posO[hs] + 1) +
      " " +
      (posO[he] - posO[hs]) +
      " " +
      (posN[hs] + 1) +
      " " +
      (posN[he] - posN[hs]) +
      "\n";
    // Within each run of changes the deletions come before the
    // insertions, whatever order the script took them in.
    for (let k = hs; k < he; ) {
      const op = ops[k];
      if (op === 0) {
        out += emitLine("=", oldText, oldStarts, posO[k]);
        k++;
        continue;
      }
      let re = k;
      while (re < he && ops[re] !== 0) re++;
      for (let j = k; j < re; j++) {
        if (ops[j] === 1) out += emitLine("-", oldText, oldStarts, posO[j]);
      }
      for (let j = k; j < re; j++) {
        if (ops[j] === 2) out += emitLine("+", newText, newStarts, posN[j]);
      }
      k = re;
    }
  }
  return out;
}

function emitLine(marker, text, starts, idx) {
  const s = starts[idx];
  const e = starts[idx + 1];
  if (text.charCodeAt(e - 1) === 10) {
    return marker + text.slice(s, e);
  }
  return marker + text.slice(s, e) + "\n%\n";
}

// Myers's greedy search on integer arrays. Returns op codes in order:
// 0 keep, 1 delete (a line of A), 2 insert (a line of B). On a tie the
// deletion's path wins: an insertion is taken only when it reaches
// strictly further than the deletion. The furthest-reaching value of
// every round is written straight into one flat trace as it is found —
// round d holds its d + 1 diagonals at offset d * (d + 1) / 2 — so the
// script can be walked back from both ends.
function diffOps(A, B) {
  const N = A.length;
  const M = B.length;
  if (N === 0) {
    const ops = new Array(M);
    for (let i = 0; i < M; i++) ops[i] = 2;
    return ops;
  }
  if (M === 0) {
    const ops = new Array(N);
    for (let i = 0; i < N; i++) ops[i] = 1;
    return ops;
  }

  const max = N + M;
  const off = max;
  const V = new Int32Array(2 * max + 1);
  let trace = new Int32Array(1 << 20);
  let D = -1;

  outer: for (let d = 0; d <= max; d++) {
    const tbase = (d * (d + 1)) / 2;
    if (tbase + d + 1 > trace.length) {
      const grown = new Int32Array(Math.max(trace.length * 2, tbase + d + 1));
      grown.set(trace);
      trace = grown;
    }
    let tp = tbase;
    let vi = off - d;
    // k = -d: only an insertion can reach this diagonal.
    {
      let x = V[vi + 1];
      let y = x + d;
      while (x < N && y < M && A[x] === B[y]) {
        x++;
        y++;
      }
      V[vi] = x;
      trace[tp++] = x;
      if (x >= N && y >= M) {
        D = d;
        break outer;
      }
    }
    for (let k = -d + 2; k < d; k += 2) {
      vi += 2;
      const vDown = V[vi - 1] + 1;
      const vRight = V[vi + 1];
      let x = vDown < vRight ? vRight : vDown;
      let y = x - k;
      while (x < N && y < M && A[x] === B[y]) {
        x++;
        y++;
      }
      V[vi] = x;
      trace[tp++] = x;
      if (x >= N && y >= M) {
        D = d;
        break outer;
      }
    }
    if (d > 0) {
      // k = d: only a deletion can reach this diagonal.
      vi += 2;
      let x = V[vi - 1] + 1;
      let y = x - d;
      while (x < N && y < M && A[x] === B[y]) {
        x++;
        y++;
      }
      V[vi] = x;
      trace[tp++] = x;
      if (x >= N && y >= M) {
        D = d;
        break outer;
      }
    }
  }

  // Walk the script back from (N, M). In round d - 1, diagonal kk sits
  // at trace offset (d - 1) * d / 2 + (kk + d - 1) / 2.
  const ops = [];
  let x = N;
  let y = M;
  for (let d = D; d >= 1; d--) {
    const k = x - y;
    const base = ((d - 1) * d) / 2;
    let prevX;
    let prevK;
    let isDel;
    if (k === -d) {
      isDel = false;
      prevK = k + 1;
      prevX = trace[base + (k + d) / 2];
    } else if (k === d) {
      isDel = true;
      prevK = k - 1;
      prevX = trace[base + (k + d - 2) / 2];
    } else if (trace[base + (k + d) / 2] > trace[base + (k + d - 2) / 2] + 1) {
      isDel = false;
      prevK = k + 1;
      prevX = trace[base + (k + d) / 2];
    } else {
      isDel = true;
      prevK = k - 1;
      prevX = trace[base + (k + d - 2) / 2];
    }
    const prevY = prevX - prevK;
    const editX = isDel ? prevX + 1 : prevX;
    const editY = isDel ? prevY : prevY + 1;
    while (x > editX && y > editY) {
      x--;
      y--;
      ops.push(0);
    }
    ops.push(isDel ? 1 : 2);
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    ops.push(0);
  }
  ops.reverse();
  return ops;
}
