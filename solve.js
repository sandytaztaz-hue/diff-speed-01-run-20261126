// Fast exact line diff.
//
// Design (from the prose contract only):
//  - Lines are interned by hashing the raw text in place, two independent
//    32-bit hashes per line, so no per-line string is ever sliced during
//    the search. A line is identified by its hash pair; equality of lines
//    is equality of those pairs.
//  - Lines that occur exactly once in each text are anchors. The longest
//    increasing subsequence of those anchors (by new-text position) is a
//    chain of lines that any shortest script can keep, and it splits the
//    two texts into many small independent segments.
//  - Each segment is solved by the exact Myers greedy search from the
//    brief: common prefix, then common suffix, then the greedy search
//    with the deletion-preferred tie-break, no edge pruning, snakes
//    followed to their end. Small segments make the quadratic trace tiny.
//  - The patch is built by joining pieces, never by repeated
//    concatenation, with hunks of at most 3 context lines and runs merged
//    across at most 6 kept lines.
//
// No state is carried between run() calls; every call starts fresh.

const OP_EQ = 0;
const OP_DEL = 1;
const OP_INS = 2;

// FNV-1a offset basis and a djb-style second hash, both over code units.
const H1_SEED = 2166136261;
const H2_SEED = 5381;

export function run(input) {
  const oldText = input.old;
  const newText = input.new;

  // ---- intern lines by hashing the raw text in place -----------------
  // Open-addressing table keyed by the two 32-bit hashes, so interning
  // a line costs a few typed-array probes and never allocates a key.
  const estLines = ((oldText.length + newText.length) / 16 | 0) + 1024;
  let tsize = 1024;
  while (tsize < estLines * 4 && tsize < 262144) tsize <<= 1;
  const table = {
    h1: new Int32Array(tsize),
    h2: new Int32Array(tsize),
    ids: new Int32Array(tsize).fill(-1),
    mask: tsize - 1,
    next: 0,
  };
  const oldIds = [];
  const oldStarts = [];
  const oldLens = [];
  const newIds = [];
  const newStarts = [];
  const newLens = [];
  scanLines(oldText, table, oldIds, oldStarts, oldLens);
  scanLines(newText, table, newIds, newStarts, newLens);

  const n = oldIds.length;
  const m = newIds.length;
  const oldA = Int32Array.from(oldIds);
  const newA = Int32Array.from(newIds);
  const oldS = Int32Array.from(oldStarts);
  const oldL = Int32Array.from(oldLens);
  const newS = Int32Array.from(newStarts);
  const newL = Int32Array.from(newLens);

  // ---- unique-line anchors -------------------------------------------
  const numIds = table.next;
  const cntO = new Int32Array(numIds);
  const cntN = new Int32Array(numIds);
  for (let i = 0; i < n; i++) cntO[oldA[i]]++;
  for (let j = 0; j < m; j++) cntN[newA[j]]++;
  const posN = new Int32Array(numIds).fill(-1);
  for (let j = 0; j < m; j++) {
    if (cntN[newA[j]] === 1) posN[newA[j]] = j;
  }
  const anchI = [];
  const anchJ = [];
  for (let i = 0; i < n; i++) {
    const id = oldA[i];
    if (cntO[id] === 1 && cntN[id] === 1) {
      anchI.push(i);
      anchJ.push(posN[id]);
    }
  }

  // Longest increasing subsequence of the anchors by new position.
  // Length first: Lstart[a] is the longest chain starting at anchor a,
  // found by scanning old order backwards with a segment tree over new
  // positions (suffix maximum). Then, among all maximum-length chains,
  // the one whose anchors are earliest in old order: scan forward and
  // take the earliest anchor that can still complete a maximum chain.
  // The earliest-old choice is what the reference search does at a tie:
  // at a swap of two lines it keeps the earlier old line, deletes the
  // later one and inserts the earlier new one.
  const aCount = anchI.length;
  const Lstart = new Int32Array(aCount);
  let segSize = 1;
  while (segSize < m + 1) segSize <<= 1;
  const seg = new Int32Array(2 * segSize);
  const segQuery = (l, r) => {
    let res = 0;
    let a = l + segSize;
    let b = r + segSize;
    while (a < b) {
      if (a & 1) {
        if (seg[a] > res) res = seg[a];
        a++;
      }
      if (b & 1) {
        b--;
        if (seg[b] > res) res = seg[b];
      }
      a >>= 1;
      b >>= 1;
    }
    return res;
  };
  const segUpdate = (p, v) => {
    let i = p + segSize;
    if (seg[i] >= v) return;
    seg[i] = v;
    for (i >>= 1; i >= 1; i >>= 1) {
      const nv = seg[2 * i] > seg[2 * i + 1] ? seg[2 * i] : seg[2 * i + 1];
      if (seg[i] === nv) break;
      seg[i] = nv;
    }
  };
  let maxLen = 0;
  for (let a = aCount - 1; a >= 0; a--) {
    const v = segQuery(anchJ[a] + 1, m) + 1;
    Lstart[a] = v;
    if (v > maxLen) maxLen = v;
    segUpdate(anchJ[a], v);
  }
  const lis = [];
  let curJ = -1;
  let rem = maxLen;
  for (let a = 0; a < aCount && rem > 0; a++) {
    if (Lstart[a] === rem && anchJ[a] > curJ) {
      lis.push(a);
      curJ = anchJ[a];
      rem--;
    }
  }

  // ---- build the edit script ------------------------------------------
  const opT = [];
  const opO = [];
  const opN = [];
  const emitEq = (oi, nj) => {
    opT.push(OP_EQ);
    opO.push(oi);
    opN.push(nj);
  };

  // Exact Myers search on one segment [a0,a1) x [b0,b1), appending ops.
  // Only the common prefix is trimmed first: that is exactly the
  // forward search's first snake from the segment start. The common
  // suffix is deliberately NOT trimmed here: at a segment end the
  // pairing of trailing equal lines is decided by the forward search,
  // and trimming it in reverse order pairs a doubled line with the
  // wrong copy (the reference keeps the first copy and inserts the
  // later one). The one suffix the reference does trim — the suffix of
  // the whole texts — is trimmed once in run(), before segmenting.
  const myersSegment = (a0, a1, b0, b1) => {
    while (a0 < a1 && b0 < b1 && oldA[a0] === newA[b0]) {
      emitEq(a0, b0);
      a0++;
      b0++;
    }
    const ea = a1;
    const eb = b1;
    const N = ea - a0;
    const M = eb - b0;
    if (N === 0) {
      for (let j = b0; j < eb; j++) {
        opT.push(OP_INS);
        opO.push(-1);
        opN.push(j);
      }
    } else if (M === 0) {
      for (let i = a0; i < ea; i++) {
        opT.push(OP_DEL);
        opO.push(i);
        opN.push(-1);
      }
    } else {
      myersCore(a0, ea, b0, eb, N, M, oldA, newA, opT, opO, opN);
    }
  };

  // Decide whether the anchor chain is dense enough to trust as a split.
  // If it is not, fall back to one exact search over the whole texts.
  // The reference trims the longest common prefix, then the longest
  // common suffix, of the whole texts before searching. Do exactly that
  // once here; everything below works on the middle that is left.
  let pfx = 0;
  while (pfx < n && pfx < m && oldA[pfx] === newA[pfx]) pfx++;
  let sfx = 0;
  while (
    sfx < n - pfx &&
    sfx < m - pfx &&
    oldA[n - 1 - sfx] === newA[m - 1 - sfx]
  ) {
    sfx++;
  }
  const midEndO = n - sfx;
  const midEndN = m - sfx;
  for (let i = 0; i < pfx; i++) emitEq(i, i);

  // Split only at long runs of consecutive anchors: a block of at least
  // 8 lines that are equal in both texts, in order, in the anchor chain.
  // A single unique line can be a tie casualty — the reference search may
  // drop it to keep repeated lines instead — but a long block is kept by
  // any shortest script: dropping it costs twice its length and no
  // crossing alternative in its neighbourhood is that long. Everything
  // between blocks is solved by the exact search, which decides swaps,
  // moves and repeated-line ties exactly as the reference does.
  const BLOCK_MIN = 8;
  const blocks = [];
  for (let t = 0; t < lis.length; ) {
    let e = t;
    while (
      e + 1 < lis.length &&
      anchI[lis[e + 1]] === anchI[lis[e]] + 1 &&
      anchJ[lis[e + 1]] === anchJ[lis[e]] + 1
    ) {
      e++;
    }
    const len = e - t + 1;
    // Clip the block to the middle; a clipped block shorter than the
    // minimum is dropped and its lines are left to the exact search.
    const bi = Math.max(anchI[lis[t]], pfx);
    const bj = Math.max(anchJ[lis[t]], pfx);
    const bl = Math.min(anchI[lis[t]] + len, midEndO) - bi;
    if (bl >= BLOCK_MIN) blocks.push([bi, bj, bl]);
    t = e + 1;
  }
  let useBlocks = blocks.length >= 10;
  if (useBlocks) {
    let pi = pfx - 1;
    let pj = pfx - 1;
    for (const [bi, bj, bl] of blocks) {
      if (bi - pi - 1 + (bj - pj - 1) > 8000) {
        useBlocks = false;
        break;
      }
      pi = bi + bl - 1;
      pj = bj + bl - 1;
    }
    if (useBlocks && midEndO - 1 - pi + (midEndN - 1 - pj) > 8000) {
      useBlocks = false;
    }
  }
  if (useBlocks) {
    let pi = pfx - 1;
    let pj = pfx - 1;
    for (const [bi, bj, bl] of blocks) {
      if (bi > pi + 1 || bj > pj + 1) {
        myersSegment(pi + 1, bi, pj + 1, bj);
      }
      for (let s = 0; s < bl; s++) emitEq(bi + s, bj + s);
      pi = bi + bl - 1;
      pj = bj + bl - 1;
    }
    if (pi + 1 < midEndO || pj + 1 < midEndN) {
      myersSegment(pi + 1, midEndO, pj + 1, midEndN);
    }
  } else {
    myersSegment(pfx, midEndO, pfx, midEndN);
  }
  for (let s = 0; s < sfx; s++) emitEq(midEndO + s, midEndN + s);

  // ---- render the patch -------------------------------------------------
  return renderPatch(
    oldText,
    newText,
    oldS,
    oldL,
    newS,
    newL,
    n,
    m,
    opT,
    opO,
    opN,
  );
}

// Cut a text into lines after every '\n' (a '\r' stays part of its line),
// hashing each line in place and interning it in `table`. Line ends are
// found with indexOf, so the per-character loop only hashes.
function scanLines(text, table, ids, starts, lens) {
  let start = 0;
  const len = text.length;
  while (start < len) {
    let end = text.indexOf("\n", start);
    if (end === -1) end = len;
    else end += 1;
    let h1 = H1_SEED;
    let h2 = H2_SEED;
    for (let i = start; i < end; i++) {
      const c = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 16777619);
      h2 = (Math.imul(h2, 33) + c) | 0;
    }
    ids.push(intern(table, h1, h2));
    starts.push(start);
    lens.push(end - start);
    start = end;
  }
}

function intern(table, h1, h2) {
  const mask = table.mask;
  let slot = (h1 ^ h2) & mask;
  while (true) {
    const id = table.ids[slot];
    if (id === -1) {
      const nid = table.next++;
      table.h1[slot] = h1;
      table.h2[slot] = h2;
      table.ids[slot] = nid;
      return nid;
    }
    if (table.h1[slot] === h1 && table.h2[slot] === h2) return id;
    slot = (slot + 1) & mask;
  }
}

// Myers greedy search on the rectangle oldA[a0..ea) x newA[b0..eb).
// For edit count d = 0, 1, 2, ... and each diagonal k = x - y from -d to
// d in steps of 2, the furthest point a path of d edits reaches on k is
// one old line past the furthest (d-1)-point on k-1 (a deletion) or one
// new line past the furthest (d-1)-point on k+1 (an insertion), whichever
// lies further into the old text, the deletion winning a tie. A candidate
// that would move past the end of either text is no candidate. No diagonal
// is pruned at the edges. From that point the path follows every run of
// equal lines as far as it goes. The first path to reach both ends wins.
// The furthest-reaching value of every round is kept (one short slice per
// round) so the winning path can be walked back exactly.
function myersCore(a0, ea, b0, eb, N, M, oldA, newA, opT, opO, opN) {
  const Dmax = N + M;
  const off = Dmax;
  const V = new Int32Array(2 * Dmax + 1);
  V.fill(-1);
  const trace = [];
  let Dfound = -1;
  outer: for (let d = 0; d <= Dmax; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (d === 0) {
        x = 0;
      } else if (k === -d) {
        x = V[off + k + 1];
        if (x < 0) {
          V[off + k] = -1;
          continue;
        }
      } else if (k === d) {
        if (V[off + k - 1] < 0) {
          V[off + k] = -1;
          continue;
        }
        x = V[off + k - 1] + 1;
      } else {
        const delV = V[off + k - 1];
        const insV = V[off + k + 1];
        const delX = delV + 1;
        const insX = insV;
        const delOk = delV >= 0 && delX <= N && delX - k <= M;
        const insOk = insV >= 0 && insX <= N && insX - k <= M;
        if (!delOk && !insOk) {
          V[off + k] = -1;
          continue;
        }
        x = delOk && (!insOk || delX >= insX) ? delX : insX;
      }
      let y = x - k;
      if (x < 0 || x > N || y < 0 || y > M) {
        V[off + k] = -1;
        continue;
      }
      while (x < N && y < M && oldA[a0 + x] === newA[b0 + y]) {
        x++;
        y++;
      }
      V[off + k] = x;
      if (x >= N && y >= M) {
        Dfound = d;
        trace.push(V.slice(off - d, off + d + 1));
        break outer;
      }
    }
    trace.push(V.slice(off - d, off + d + 1));
  }

  // Walk the winning path back, collecting ops in reverse.
  const revT = [];
  const revO = [];
  const revN = [];
  let x = N;
  let y = M;
  for (let d = Dfound; d >= 1; d--) {
    const k = x - y;
    const prevV = trace[d - 1];
    const poff = d - 1;
    let prevK;
    if (k === -d) {
      prevK = k + 1;
    } else if (k === d) {
      prevK = k - 1;
    } else {
      const delV = prevV[k - 1 + poff];
      const insV = prevV[k + 1 + poff];
      const delX = delV + 1;
      const insX = insV;
      const delOk = delV >= 0 && delX <= N && delX - k <= M;
      const insOk = insV >= 0 && insX <= N && insX - k <= M;
      prevK = delOk && (!insOk || delX >= insX) ? k - 1 : k + 1;
    }
    const prevX = prevV[prevK + poff];
    const prevY = prevX - prevK;
    const isIns = prevK === k + 1;
    const sx = prevX + (isIns ? 0 : 1);
    const sy = prevY + (isIns ? 1 : 0);
    const cnt = x - sx;
    for (let s = cnt - 1; s >= 0; s--) {
      revT.push(OP_EQ);
      revO.push(a0 + sx + s);
      revN.push(b0 + sy + s);
    }
    if (isIns) {
      revT.push(OP_INS);
      revO.push(-1);
      revN.push(b0 + sy - 1);
    } else {
      revT.push(OP_DEL);
      revO.push(a0 + sx - 1);
      revN.push(-1);
    }
    x = prevX;
    y = prevY;
  }
  // The d = 0 snake: equal lines from the origin to (x, y).
  for (let s = x - 1; s >= 0; s--) {
    revT.push(OP_EQ);
    revO.push(a0 + s);
    revN.push(b0 + s);
  }
  for (let i = revT.length - 1; i >= 0; i--) {
    opT.push(revT[i]);
    opO.push(revO[i]);
    opN.push(revN[i]);
  }
}

// Render the patch string from the op list.
//
// Header: "makefun-diff/1 old=N new=M hunks=H deleted=D inserted=I".
// Each hunk: "@ os ol ns nl", then one line per covered line, "=" kept,
// "-" deleted, "+" inserted. Within a run of changes the deletions come
// before the insertions. A hunk holds every change run with up to 3 kept
// lines before and after it, and two runs with at most 6 kept lines
// between them share one hunk. A line that ends its text with no newline
// is written with a newline added and followed by a line holding just "%".
// Identical texts are the header line alone.
function renderPatch(
  oldText,
  newText,
  oldS,
  oldL,
  newS,
  newL,
  n,
  m,
  opT,
  opO,
  opN,
) {
  const totalOps = opT.length;
  const oldBefore = new Int32Array(totalOps + 1);
  const newBefore = new Int32Array(totalOps + 1);
  let del = 0;
  let ins = 0;
  for (let i = 0; i < totalOps; i++) {
    oldBefore[i + 1] = oldBefore[i];
    newBefore[i + 1] = newBefore[i];
    if (opT[i] === OP_EQ) {
      oldBefore[i + 1]++;
      newBefore[i + 1]++;
    } else if (opT[i] === OP_DEL) {
      oldBefore[i + 1]++;
      del++;
    } else {
      newBefore[i + 1]++;
      ins++;
    }
  }

  // Maximal runs of changes.
  const runs = [];
  let i = 0;
  while (i < totalOps) {
    if (opT[i] === OP_EQ) {
      i++;
      continue;
    }
    const s = i;
    const os = oldBefore[i];
    const ns = newBefore[i];
    while (i < totalOps && opT[i] !== OP_EQ) i++;
    runs.push({ s, e: i, os, oe: oldBefore[i], ns, ne: newBefore[i] });
  }

  // Group runs into hunks: runs with at most 6 kept lines between them
  // share a hunk, with up to 3 kept lines of context on each side.
  const hunks = [];
  let prevEndOp = 0;
  for (let r = 0; r < runs.length; r++) {
    let gEnd = r;
    while (gEnd + 1 < runs.length) {
      const gap = runs[gEnd + 1].os - runs[gEnd].oe;
      if (gap <= 6) gEnd++;
      else break;
    }
    const first = runs[r];
    const last = runs[gEnd];
    const hs = Math.max(prevEndOp, first.s - 3);
    const he = Math.min(totalOps, last.e + 3);
    hunks.push({
      s: hs,
      e: he,
      os: oldBefore[hs],
      oe: oldBefore[he],
      ns: newBefore[hs],
      ne: newBefore[he],
    });
    prevEndOp = he;
    r = gEnd;
  }

  const oldEndsNL =
    oldText.length === 0 || oldText.charCodeAt(oldText.length - 1) === 10;
  const newEndsNL =
    newText.length === 0 || newText.charCodeAt(newText.length - 1) === 10;
  const bareOld = (idx) => idx === n - 1 && !oldEndsNL;
  const bareNew = (idx) => idx === m - 1 && !newEndsNL;
  const oldLine = (idx) =>
    oldText.slice(oldS[idx], oldS[idx] + oldL[idx]);
  const newLine = (idx) =>
    newText.slice(newS[idx], newS[idx] + newL[idx]);

  const out = [];
  out.push(
    "makefun-diff/1 old=" +
      n +
      " new=" +
      m +
      " hunks=" +
      hunks.length +
      " deleted=" +
      del +
      " inserted=" +
      ins +
      "\n",
  );
  for (const h of hunks) {
    out.push(
      "@ " +
        (h.os + 1) +
        " " +
        (h.oe - h.os) +
        " " +
        (h.ns + 1) +
        " " +
        (h.ne - h.ns) +
        "\n",
    );
    let p = h.s;
    while (p < h.e) {
      const t = opT[p];
      if (t === OP_EQ) {
        const oi = opO[p];
        out.push("=" + oldLine(oi) + (bareOld(oi) ? "\n%\n" : ""));
        p++;
      } else {
        // One run of changes: all deletions first, then all insertions.
        let q = p;
        const dels = [];
        const inss = [];
        while (q < h.e && opT[q] !== OP_EQ) {
          if (opT[q] === OP_DEL) dels.push(opO[q]);
          else inss.push(opN[q]);
          q++;
        }
        for (const oi of dels) {
          out.push("-" + oldLine(oi) + (bareOld(oi) ? "\n%\n" : ""));
        }
        for (const ni of inss) {
          out.push("+" + newLine(ni) + (bareNew(ni) ? "\n%\n" : ""));
        }
        p = q;
      }
    }
  }
  return out.join("");
}
