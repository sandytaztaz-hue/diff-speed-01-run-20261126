// diff.ts — R8 zero-cold WASM core.
// One tiny module: raw-JSON scan, line interning (B-follows-A), exact global
// Myers with the oracle's deletion-on-tie rule, patch render. No JSON.parse
// anywhere: the JS side hands the raw cases buffer in and takes answer bytes out.

// Scratch buffers, allocated once at instantiation. Sizes cover the kit's
// regime (8.5 MB input, ~2 MB answers, D ~ 4000 -> V rows need (D+1)^2 i32).
const IN_CAP: i32 = 16 << 20;
const OUT_CAP: i32 = 8 << 20;
const WORK_CAP: i32 = 256 << 20;

const inBuf = new Uint8Array(IN_CAP);
const outBuf = new Uint8Array(OUT_CAP);
const work = new Uint8Array(WORK_CAP);

export function inPtr(): i32 {
  return inBuf.dataStart as i32;
}
export function outPtr(): i32 {
  return outBuf.dataStart as i32;
}
function workPtr(): i32 {
  return work.dataStart as i32;
}

// ---- byte helpers ---------------------------------------------------------
function ld8(p: i32): i32 {
  return load<u8>(p);
}
function ld32(p: i32): u32 {
  return load<u32>(p);
}
function st8(p: i32, v: i32): void {
  store<u8>(p, v);
}
function st32(p: i32, v: i32): void {
  store<i32>(p, v);
}

// ---- SIMD chunk scan ------------------------------------------------------
// Bitmask of positions in the 16-byte chunk at `p` equal to byte `b`.
function eqMask(p: i32, b: i32): i32 {
  const v = v128.load(p);
  const t = i8x16.splat(b as i8);
  return i8x16.bitmask(i8x16.eq(v, t));
}

// Find the marker `"input":{"old":"` (16 bytes) at or after `from` in the
// input buffer (length `len`). Returns the index of its opening quote, or -1.
// Prefilter: only chunks containing a `"` can hold the marker.
function findOldMark(from: i32, len: i32): i32 {
  const base = inPtr();
  let p = from;
  const end = len - 16;
  while (p <= end) {
    const m = eqMask(base + p, 34); // '"'
    if (m == 0) {
      p += 16;
      continue;
    }
    // Check each quote position in this chunk for the full marker.
    let mm = m;
    while (mm != 0) {
      const bit = ctz<i32>(mm);
      const q = p + bit;
      if (q <= end && ld8(base + q) == 34 && ld8(base + q + 1) == 105 && ld8(base + q + 2) == 110 && ld8(base + q + 3) == 112 && ld8(base + q + 4) == 117 && ld8(base + q + 5) == 116 && ld8(base + q + 6) == 34 && ld8(base + q + 7) == 58 && ld8(base + q + 8) == 123 && ld8(base + q + 9) == 34 && ld8(base + q + 10) == 111 && ld8(base + q + 11) == 108 && ld8(base + q + 12) == 100 && ld8(base + q + 13) == 34 && ld8(base + q + 14) == 58 && ld8(base + q + 15) == 34) {
        return q;
      }
      mm &= mm - 1;
    }
    p += 16;
  }
  // Tail: scalar scan for a quote, then check the marker.
  while (p < len) {
    if (ld8(base + p) == 34 && p <= end && ld8(base + p + 1) == 105 && ld8(base + p + 2) == 110 && ld8(base + p + 3) == 112 && ld8(base + p + 4) == 117 && ld8(base + p + 5) == 116 && ld8(base + p + 6) == 34 && ld8(base + p + 7) == 58 && ld8(base + p + 8) == 123 && ld8(base + p + 9) == 34 && ld8(base + p + 10) == 111 && ld8(base + p + 11) == 108 && ld8(base + p + 12) == 100 && ld8(base + p + 13) == 34 && ld8(base + p + 14) == 58 && ld8(base + p + 15) == 34) return p;
    p++;
  }
  return -1;
}

// Find the marker `"new":"` (7 bytes) at or after `from`. Returns its index, or -1.
function findNewMark(from: i32, len: i32): i32 {
  const base = inPtr();
  let p = from;
  const end = len - 7;
  while (p <= end) {
    const m = eqMask(base + p, 34);
    if (m == 0) {
      p += 16;
      continue;
    }
    let mm = m;
    while (mm != 0) {
      const q = p + ctz<i32>(mm);
      if (q <= end && ld8(base + q + 1) == 110 && ld8(base + q + 2) == 101 && ld8(base + q + 3) == 119 && ld8(base + q + 4) == 34 && ld8(base + q + 5) == 58 && ld8(base + q + 6) == 34) return q;
      mm &= mm - 1;
    }
    p += 16;
  }
  while (p < len) {
    if (ld8(base + p) == 34 && p <= end && ld8(base + p + 1) == 110 && ld8(base + p + 2) == 101 && ld8(base + p + 3) == 119 && ld8(base + p + 4) == 34 && ld8(base + p + 5) == 58 && ld8(base + p + 6) == 34) return p;
    p++;
  }
  return -1;
}

// Find the marker `"old":"` (7 bytes) at or after `from`. Returns its index, or -1.
function findOldShortMark(from: i32, len: i32): i32 {
  const base = inPtr();
  let p = from;
  const end = len - 7;
  while (p <= end) {
    const m = eqMask(base + p, 34);
    if (m == 0) {
      p += 16;
      continue;
    }
    let mm = m;
    while (mm != 0) {
      const q = p + ctz<i32>(mm);
      if (q <= end && ld8(base + q + 1) == 111 && ld8(base + q + 2) == 108 && ld8(base + q + 3) == 100 && ld8(base + q + 4) == 34 && ld8(base + q + 5) == 58 && ld8(base + q + 6) == 34) return q;
      mm &= mm - 1;
    }
    p += 16;
  }
  while (p < len) {
    if (ld8(base + p) == 34 && p <= end && ld8(base + p + 1) == 111 && ld8(base + p + 2) == 108 && ld8(base + p + 3) == 100 && ld8(base + p + 4) == 34 && ld8(base + p + 5) == 58 && ld8(base + p + 6) == 34) return p;
    p++;
  }
  return -1;
}

// Find the closing quote of the JSON string whose content starts at `start`:
// the first `"` not escaped by a preceding backslash. Returns its index, or -1.
function findStringEnd(start: i32, len: i32): i32 {
  const base = inPtr();
  let p = start;
  while (p < len) {
    let m = 0;
    let chunk = p;
    while (chunk + 16 <= len) {
      m = eqMask(base + chunk, 34) | eqMask(base + chunk, 92);
      if (m != 0) break;
      chunk += 16;
    }
    if (m == 0) {
      let q = chunk;
      while (q < len) {
        const c = ld8(base + q);
        if (c == 92) {
          q += 2;
          continue;
        }
        if (c == 34) return q;
        q++;
      }
      return -1;
    }
    const q = chunk + ctz<i32>(m);
    const c = ld8(base + q);
    if (c == 92) {
      p = q + 2;
      continue;
    }
    return q; // c == 34: unescaped closing quote
  }
  return -1;
}

// Find `"id":"` searching backwards from `pos` (exclusive). Returns the index
// of the content's first byte, or -1. The id sits just before the case object.
function findIdBefore(pos: i32): i32 {
  const base = inPtr();
  let p = pos - 7;
  while (p >= 0) {
    if (ld8(base + p) == 34 && ld8(base + p + 1) == 105 && ld8(base + p + 2) == 100 && ld8(base + p + 3) == 34 && ld8(base + p + 4) == 58 && ld8(base + p + 5) == 34) return p + 6;
    p--;
  }
  return -1;
}

// ---- work-buffer layout (offsets from workPtr()) ---------------------------
const MAXL: i32 = 65536; // max lines per text (generator regime: 20k-40k)
const TAB_N: i32 = 65536; // intern table entries (12 B each: hash, id, gen)
const TAB_OFF: i32 = 0; // 786432 B
const A_START: i32 = 786432;
const A_LEN: i32 = 1048576;
const A_HASH: i32 = 1310720;
const A_ID: i32 = 1572864;
const B_START: i32 = 1835008;
const B_LEN: i32 = 2097152;
const B_HASH: i32 = 2359296;
const B_ID: i32 = 2621440;
const ID_START: i32 = 2883584; // id -> raw span start in input buffer
const ID_LEN: i32 = 3145728; // id -> raw span length
const TEMP_A: i32 = 3407872; // 262144 B decode scratch
const TEMP_B: i32 = 3670016; // 262144 B decode scratch
const OPS_OFF: i32 = 3932160; // 163840 B op script: REV then FWD halves
const V_OFF: i32 = 4096000; // Myers V rows: row d at V_OFF + d*d*4
const TEMP_CAP: i32 = 262144;

let curGen: i32 = 0;
let nextId: i32 = 0;

function w32(off: i32): i32 {
  return load<i32>(workPtr() + off);
}
function wSt32(off: i32, v: i32): void {
  store<i32>(workPtr() + off, v);
}

// ---- line scanner ----------------------------------------------------------
// Walk the raw JSON string content [spanStart, spanEnd): cut a line after
// every `\n` escape. Escapes `\\`, `\"`, `\r`, `\uXXXX` stay inside the line.
// Records (rawStart, rawLen) per line into the A_* or B_* arrays.
// Returns the line count. `which`: 0 = old (A), 1 = new (B).
function scanLines(spanStart: i32, spanEnd: i32, which: i32): i32 {
  const base = inPtr();
  const wp = workPtr();
  const startOff = which == 0 ? A_START : B_START;
  const lenOff = which == 0 ? A_LEN : B_LEN;
  let n: i32 = 0;
  let lineStart = spanStart;
  let p = spanStart;
  while (p < spanEnd) {
    if (n >= MAXL) break; // out of regime: cap the line count, never overflow
    // SIMD scan for a backslash in the chunk starting at p.
    let m: i32 = 0;
    let chunk = p;
    while (chunk + 16 <= spanEnd) {
      m = eqMask(base + chunk, 92);
      if (m != 0) break;
      chunk += 16;
    }
    if (m == 0) {
      // Tail [chunk, spanEnd): scalar check for a backslash there.
      let q = chunk;
      let found: i32 = -1;
      while (q < spanEnd) {
        if (ld8(base + q) == 92) {
          found = q;
          break;
        }
        q++;
      }
      if (found < 0) break; // no more escapes: rest is the tail of this line
      const nx = found + 1 < spanEnd ? ld8(base + found + 1) : 0;
      if (nx == 110) {
        store<i32>(wp + startOff + n * 4, lineStart);
        store<i32>(wp + lenOff + n * 4, found + 2 - lineStart);
        n++;
        lineStart = found + 2;
        p = found + 2;
      } else if (nx == 117) {
        p = found + 6;
      } else {
        p = found + 2;
      }
      continue;
    }
    const q = chunk + ctz<i32>(m);
    const nx = q + 1 < spanEnd ? ld8(base + q + 1) : 0;
    if (nx == 110) {
      store<i32>(wp + startOff + n * 4, lineStart);
      store<i32>(wp + lenOff + n * 4, q + 2 - lineStart);
      n++;
      lineStart = q + 2;
      p = q + 2;
    } else if (nx == 117) {
      p = q + 6;
    } else {
      p = q + 2;
    }
  }
  if (lineStart < spanEnd && n < MAXL) {
    store<i32>(wp + startOff + n * 4, lineStart);
    store<i32>(wp + lenOff + n * 4, spanEnd - lineStart);
    n++;
  }
  return n;
}

// ---- line hash --------------------------------------------------------------
// 32-bit hash over a line's RAW bytes (the generator's JSON escaping is
// deterministic, so equal decoded lines have equal raw bytes; `\uXXXX` is
// normalised at equality-check time, not here). Two interleaved FNV chains
// over 4-byte words keep the multiply latency off the critical path.
function hashSpan(start: i32, len: i32): i32 {
  const base = inPtr();
  let h0: u32 = 2166136261;
  let h1: u32 = 0x9e3779b9;
  let p = start;
  const end = start + len;
  let w: i32 = 0;
  while (p + 4 <= end) {
    const word = ld32(base + p);
    if ((w & 1) == 0) h0 = (h0 ^ word) * 16777619;
    else h1 = (h1 ^ word) * 16777619;
    p += 4;
    w++;
  }
  while (p < end) {
    const b = ld8(base + p) as u32;
    if ((w & 1) == 0) h0 = (h0 ^ b) * 16777619;
    else h1 = (h1 ^ b) * 16777619;
    p++;
  }
  let h: u32 = h0 ^ (h1 * 2654435761);
  h ^= (len as u32) * 0x9e3779b1;
  h ^= h >> 13;
  h *= 0x5bd1e995;
  h ^= h >> 15;
  return h as i32;
}

// ---- line equality ----------------------------------------------------------
// Raw memcmp of two spans in the input buffer.
function rawEqual(aStart: i32, bStart: i32, len: i32): bool {
  const base = inPtr();
  let p = 0;
  while (p + 4 <= len) {
    if (ld32(base + aStart + p) != ld32(base + bStart + p)) return false;
    p += 4;
  }
  while (p < len) {
    if (ld8(base + aStart + p) != ld8(base + bStart + p)) return false;
    p++;
  }
  return true;
}

function hexVal(c: i32): i32 {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 97 && c <= 102) return c - 87;
  if (c >= 65 && c <= 70) return c - 55;
  return 0;
}

// Decoder state (16 B) in the TEMP scratch area: pos, end, pendLen, pendIdx,
// then 4 pending UTF-8 bytes. decNext returns the next DECODED byte, or -1.
const DEC_A: i32 = TEMP_A;
const DEC_B: i32 = TEMP_B;
function decInit(stateOff: i32, spanStart: i32, spanEnd: i32): void {
  const wp = workPtr();
  store<i32>(wp + stateOff, spanStart);
  store<i32>(wp + stateOff + 4, spanEnd);
  store<i32>(wp + stateOff + 8, 0);
  store<i32>(wp + stateOff + 12, 0);
}
function decNext(stateOff: i32): i32 {
  const wp = workPtr();
  const base = inPtr();
  let pendLen = load<i32>(wp + stateOff + 8);
  let pendIdx = load<i32>(wp + stateOff + 12);
  if (pendIdx < pendLen) {
    const b = ld8(wp + stateOff + 16 + pendIdx);
    store<i32>(wp + stateOff + 12, pendIdx + 1);
    return b;
  }
  let pos = load<i32>(wp + stateOff);
  const end = load<i32>(wp + stateOff + 4);
  if (pos >= end) return -1;
  const c = ld8(base + pos);
  if (c != 92) {
    store<i32>(wp + stateOff, pos + 1);
    return c;
  }
  if (pos + 1 >= end) {
    store<i32>(wp + stateOff, pos + 1);
    return 92;
  }
  const nx = ld8(base + pos + 1);
  if (nx == 110) {
    store<i32>(wp + stateOff, pos + 2);
    return 10;
  }
  if (nx == 114) {
    store<i32>(wp + stateOff, pos + 2);
    return 13;
  }
  if (nx == 116) {
    store<i32>(wp + stateOff, pos + 2);
    return 9;
  }
  if (nx == 98) {
    store<i32>(wp + stateOff, pos + 2);
    return 8;
  }
  if (nx == 102) {
    store<i32>(wp + stateOff, pos + 2);
    return 12;
  }
  if (nx == 47) {
    store<i32>(wp + stateOff, pos + 2);
    return 47;
  }
  if (nx == 34) {
    store<i32>(wp + stateOff, pos + 2);
    return 34;
  }
  if (nx == 92) {
    store<i32>(wp + stateOff, pos + 2);
    return 92;
  }
  if (nx == 117) {
    // \uXXXX, with surrogate-pair handling.
    let cp = 0;
    for (let i = 0; i < 4; i++) cp = (cp << 4) | hexVal(ld8(base + pos + 2 + i));
    pos += 6;
    if (cp >= 0xd800 && cp <= 0xdbff && pos + 5 < end && ld8(base + pos) == 92 && ld8(base + pos + 1) == 117) {
      let lo = 0;
      for (let i = 0; i < 4; i++) lo = (lo << 4) | hexVal(ld8(base + pos + 2 + i));
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
        pos += 6;
      }
    }
    store<i32>(wp + stateOff, pos);
    // Encode cp as UTF-8 into the pending buffer.
    let n: i32 = 0;
    if (cp < 0x80) {
      st8(wp + stateOff + 16, cp);
      n = 1;
    } else if (cp < 0x800) {
      st8(wp + stateOff + 16, 0xc0 | (cp >> 6));
      st8(wp + stateOff + 17, 0x80 | (cp & 63));
      n = 2;
    } else if (cp < 0x10000) {
      st8(wp + stateOff + 16, 0xe0 | (cp >> 12));
      st8(wp + stateOff + 17, 0x80 | ((cp >> 6) & 63));
      st8(wp + stateOff + 18, 0x80 | (cp & 63));
      n = 3;
    } else {
      st8(wp + stateOff + 16, 0xf0 | (cp >> 18));
      st8(wp + stateOff + 17, 0x80 | ((cp >> 12) & 63));
      st8(wp + stateOff + 18, 0x80 | ((cp >> 6) & 63));
      st8(wp + stateOff + 19, 0x80 | (cp & 63));
      n = 4;
    }
    store<i32>(wp + stateOff + 8, n);
    store<i32>(wp + stateOff + 12, 1);
    return ld8(wp + stateOff + 16);
  }
  store<i32>(wp + stateOff, pos + 2);
  return nx;
}

// Two lines are equal iff their DECODED contents are equal (same code units,
// newline-or-absence included). Fast path: identical raw bytes.
function linesEqual(aStart: i32, aLen: i32, bStart: i32, bLen: i32): bool {
  if (aLen == bLen && rawEqual(aStart, bStart, aLen)) return true;
  decInit(DEC_A, aStart, aStart + aLen);
  decInit(DEC_B, bStart, bStart + bLen);
  while (true) {
    const ba = decNext(DEC_A);
    const bb = decNext(DEC_B);
    if (ba != bb) return false;
    if (ba < 0) return true;
  }
}

// ---- interning (B-follows-A) ------------------------------------------------
// Intern the lines of one text. Old (which=0) builds the table; new (which=1)
// looks up against it, so equal lines share ids. Fills the *_ID arrays.
function internLines(which: i32, count: i32): void {
  const wp = workPtr();
  const startOff = which == 0 ? A_START : B_START;
  const lenOff = which == 0 ? A_LEN : B_LEN;
  const hashOff = which == 0 ? A_HASH : B_HASH;
  const idOff = which == 0 ? A_ID : B_ID;
  for (let i = 0; i < count; i++) {
    const s = load<i32>(wp + startOff + i * 4);
    const l = load<i32>(wp + lenOff + i * 4);
    const h = hashSpan(s, l);
    store<i32>(wp + hashOff + i * 4, h);
    let idx = h & (TAB_N - 1);
    let id: i32 = -1;
    for (let probe = 0; probe < TAB_N; probe++) {
      const e = wp + TAB_OFF + idx * 12;
      if (load<i32>(e + 8) != curGen) {
        id = nextId;
        nextId++;
        store<i32>(e, h);
        store<i32>(e + 4, id);
        store<i32>(e + 8, curGen);
        store<i32>(wp + ID_START + id * 4, s);
        store<i32>(wp + ID_LEN + id * 4, l);
        break;
      }
      if (load<i32>(e) == h) {
        const eid = load<i32>(e + 4);
        const es = load<i32>(wp + ID_START + eid * 4);
        const el = load<i32>(wp + ID_LEN + eid * 4);
        if (linesEqual(s, l, es, el)) {
          id = eid;
          break;
        }
      }
      idx = (idx + 1) & (TAB_N - 1);
    }
    store<i32>(wp + idOff + i * 4, id);
  }
}

// ---- exact global Myers -----------------------------------------------------
// V(d,k): furthest x on diagonal k with d edits. Row d lives at
// V_OFF + d*d*4, entry k at index k+d. Deletion preferred on ties, exactly
// like the oracle: take the down step only when V[k-1] < V[k+1] strictly.
function vAt(d: i32, k: i32): i32 {
  return load<i32>(workPtr() + V_OFF + (d * d + k + d) * 4);
}
function vSet(d: i32, k: i32, x: i32): void {
  store<i32>(workPtr() + V_OFF + (d * d + k + d) * 4, x);
}

// Diff the interned texts (aCount old lines, bCount new lines). Writes the op
// script (0=keep, 1=delete, 2=insert) to OPS_OFF + 81920 and returns the op
// count, or -1 if the edit distance would overflow the V region (out of
// regime; the caller then falls back to delete-all + insert-all).
function diffLines(aCount: i32, bCount: i32): i32 {
  const wp = workPtr();
  const aBase = wp + A_ID;
  const bBase = wp + B_ID;
  let pre: i32 = 0;
  while (pre < aCount && pre < bCount && load<i32>(aBase + pre * 4) == load<i32>(bBase + pre * 4)) pre++;
  let suf: i32 = 0;
  while (suf < aCount - pre && suf < bCount - pre && load<i32>(aBase + (aCount - 1 - suf) * 4) == load<i32>(bBase + (bCount - 1 - suf) * 4)) suf++;
  const N = aCount - pre - suf;
  const M = bCount - pre - suf;
  const rev = wp + OPS_OFF;
  const fwd = wp + OPS_OFF + 81920;
  let D: i32 = -1;
  if (N == 0 && M == 0) {
    D = 0;
  } else {
    // V capacity: (D+1)^2 entries must fit in WORK_CAP - V_OFF bytes.
    const maxD = 7900;
    let done = false;
    for (let d = 0; d <= N + M && !done; d++) {
      if (d > maxD) return -1;
      for (let k = -d; k <= d; k += 2) {
        let x: i32;
        if (d == 0) {
          x = 0;
        } else if (k == -d || (k != d && vAt(d - 1, k - 1) < vAt(d - 1, k + 1))) {
          x = vAt(d - 1, k + 1);
        } else {
          x = vAt(d - 1, k - 1) + 1;
        }
        let y = x - k;
        while (x < N && y < M && load<i32>(aBase + (pre + x) * 4) == load<i32>(bBase + (pre + y) * 4)) {
          x++;
          y++;
        }
        vSet(d, k, x);
        if (x >= N && y >= M) {
          D = d;
          done = true;
          break;
        }
      }
    }
  }
  // Backtrack from (N, M) at level D, writing ops in reverse into rev[].
  let r: i32 = 0;
  let d = D;
  let k = N - M;
  let x = N;
  let y = M;
  while (d > 0) {
    while (x > 0 && y > 0 && load<i32>(aBase + (pre + x - 1) * 4) == load<i32>(bBase + (pre + y - 1) * 4)) {
      store<u8>(rev + r, 0);
      r++;
      x--;
      y--;
    }
    let prevK: i32;
    let isIns: bool;
    if (k == -d || (k != d && vAt(d - 1, k - 1) < vAt(d - 1, k + 1))) {
      prevK = k + 1;
      isIns = true;
    } else {
      prevK = k - 1;
      isIns = false;
    }
    if (isIns) {
      store<u8>(rev + r, 2);
      r++;
      y--;
    } else {
      store<u8>(rev + r, 1);
      r++;
      x--;
    }
    d--;
    k = prevK;
  }
  while (x > 0 && y > 0 && load<i32>(aBase + (pre + x - 1) * 4) == load<i32>(bBase + (pre + y - 1) * 4)) {
    store<u8>(rev + r, 0);
    r++;
    x--;
    y--;
  }
  // Emit: pre keeps, reversed middle ops, suf keeps.
  let o: i32 = 0;
  for (let i = 0; i < pre; i++) {
    store<u8>(fwd + o, 0);
    o++;
  }
  for (let i = r - 1; i >= 0; i--) {
    store<u8>(fwd + o, load<u8>(rev + i));
    o++;
  }
  for (let i = 0; i < suf; i++) {
    store<u8>(fwd + o, 0);
    o++;
  }
  return o;
}

// ---- patch renderer ---------------------------------------------------------
// Output cursor (module-level): renderers append JSON-escaped bytes to the
// output buffer. Every byte goes through oByte, which escapes `"`, `\` and
// control characters; plain bytes pass through unchanged.
let outBase: i32 = 0;
let outPos: i32 = 0;

function oByte(b: i32): void {
  const p = outBase + outPos;
  if (b >= 32 && b != 34 && b != 92) {
    store<u8>(p, b);
    outPos++;
  } else if (b == 34) {
    store<u8>(p, 92);
    store<u8>(p + 1, 34);
    outPos += 2;
  } else if (b == 92) {
    store<u8>(p, 92);
    store<u8>(p + 1, 92);
    outPos += 2;
  } else if (b == 10) {
    store<u8>(p, 92);
    store<u8>(p + 1, 110);
    outPos += 2;
  } else if (b == 13) {
    store<u8>(p, 92);
    store<u8>(p + 1, 114);
    outPos += 2;
  } else if (b == 9) {
    store<u8>(p, 92);
    store<u8>(p + 1, 116);
    outPos += 2;
  } else {
    // Other control byte: \u00xx.
    const hi = b >> 4;
    const lo = b & 15;
    store<u8>(p, 92);
    store<u8>(p + 1, 117);
    store<u8>(p + 2, 48);
    store<u8>(p + 3, 48);
    store<u8>(p + 4, hi < 10 ? 48 + hi : 87 + hi);
    store<u8>(p + 5, lo < 10 ? 48 + lo : 87 + lo);
    outPos += 6;
  }
}

function oStr(s: string): void {
  for (let i = 0; i < s.length; i++) oByte(s.charCodeAt(i));
}

function oInt(v: i32): void {
  if (v == 0) {
    oByte(48);
    return;
  }
  let tmp: i32 = 0;
  let n = v;
  const buf = workPtr() + OPS_OFF; // 16 B scratch in the dead REV op area
  while (n > 0) {
    store<u8>(buf + tmp, 48 + (n % 10));
    tmp++;
    n = n / 10;
  }
  for (let i = tmp - 1; i >= 0; i--) oByte(load<u8>(buf + i));
}

// Emit one decoded line (raw span [start, start+len)) after the `= `/`- `/`+ `
// prefix. Returns true when the line ends with a newline (decoded 0x0A).
function oLine(start: i32, len: i32): bool {
  const base = inPtr();
  const end = start + len;
  let p = start;
  let endsNl = false;
  if (len >= 2 && ld8(base + end - 2) == 92 && ld8(base + end - 1) == 110) endsNl = true;
  while (p < end) {
    const c = ld8(base + p);
    if (c != 92) {
      oByte(c);
      p++;
      continue;
    }
    if (p + 1 >= end) {
      oByte(92);
      p++;
      continue;
    }
    const nx = ld8(base + p + 1);
    if (nx == 110) {
      oByte(10);
      p += 2;
    } else if (nx == 114) {
      oByte(13);
      p += 2;
    } else if (nx == 116) {
      oByte(9);
      p += 2;
    } else if (nx == 98) {
      oByte(8);
      p += 2;
    } else if (nx == 102) {
      oByte(12);
      p += 2;
    } else if (nx == 47) {
      oByte(47);
      p += 2;
    } else if (nx == 34) {
      oByte(34);
      p += 2;
    } else if (nx == 92) {
      oByte(92);
      p += 2;
    } else if (nx == 117) {
      // \uXXXX: decode and emit raw UTF-8 bytes.
      let cp = 0;
      for (let i = 0; i < 4; i++) cp = (cp << 4) | hexVal(ld8(base + p + 2 + i));
      p += 6;
      if (cp >= 0xd800 && cp <= 0xdbff && p + 5 < end && ld8(base + p) == 92 && ld8(base + p + 1) == 117) {
        let lo = 0;
        for (let i = 0; i < 4; i++) lo = (lo << 4) | hexVal(ld8(base + p + 2 + i));
        if (lo >= 0xdc00 && lo <= 0xdfff) {
          cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
          p += 6;
        }
      }
      if (cp < 0x80) {
        oByte(cp);
      } else if (cp < 0x800) {
        oByte(0xc0 | (cp >> 6));
        oByte(0x80 | (cp & 63));
      } else if (cp < 0x10000) {
        oByte(0xe0 | (cp >> 12));
        oByte(0x80 | ((cp >> 6) & 63));
        oByte(0x80 | (cp & 63));
      } else {
        oByte(0xf0 | (cp >> 18));
        oByte(0x80 | ((cp >> 12) & 63));
        oByte(0x80 | ((cp >> 6) & 63));
        oByte(0x80 | (cp & 63));
      }
    } else {
      oByte(nx);
      p += 2;
    }
  }
  return endsNl;
}

// ---- render driver ------------------------------------------------------------
// Walk the op script, group change runs into hunks (runs <= 6 kept lines
// apart share a hunk, up to 3 context lines around each), and emit the patch.
function renderPatch(aCount: i32, bCount: i32, opCount: i32): void {
  const wp = workPtr();
  const fwd = wp + OPS_OFF + 81920;
  const hunksBase = wp + TEMP_A; // 8 B per hunk: (startOp, endOp)
  let dels: i32 = 0;
  let inss: i32 = 0;
  let hunks: i32 = 0;
  let i: i32 = 0;
  let prevHunkEnd: i32 = 0;
  while (i < opCount) {
    while (i < opCount && load<u8>(fwd + i) == 0) i++;
    if (i >= opCount) break;
    const runStart = i;
    let runEnd = i;
    let gap: i32 = 0;
    while (true) {
      while (runEnd < opCount && load<u8>(fwd + runEnd) != 0) {
        if (load<u8>(fwd + runEnd) == 1) dels++;
        else inss++;
        runEnd++;
      }
      gap = 0;
      while (runEnd + gap < opCount && load<u8>(fwd + runEnd + gap) == 0) gap++;
      if (gap <= 6 && runEnd + gap < opCount) {
        runEnd = runEnd + gap;
        continue;
      }
      break;
    }
    const keepsBefore = min(3, runStart - prevHunkEnd);
    const keepsAfter = min(3, gap);
    const hStart = runStart - keepsBefore;
    const hEnd = runEnd + keepsAfter;
    store<i32>(hunksBase + hunks * 8, hStart);
    store<i32>(hunksBase + hunks * 8 + 4, hEnd);
    hunks++;
    prevHunkEnd = hEnd;
    i = runEnd;
  }
  // Header.
  oStr("makefun-diff/1 old=");
  oInt(aCount);
  oStr(" new=");
  oInt(bCount);
  oStr(" hunks=");
  oInt(hunks);
  oStr(" deleted=");
  oInt(dels);
  oStr(" inserted=");
  oInt(inss);
  oByte(10);
  // Hunks.
  let ai: i32 = 0;
  let bi: i32 = 0;
  let oi: i32 = 0;
  for (let h = 0; h < hunks; h++) {
    const hStart = load<i32>(hunksBase + h * 8);
    const hEnd = load<i32>(hunksBase + h * 8 + 4);
    while (oi < hStart) {
      ai++;
      bi++;
      oi++;
    }
    let ol: i32 = 0;
    let nl: i32 = 0;
    for (let j = hStart; j < hEnd; j++) {
      const op = load<u8>(fwd + j);
      if (op == 0) {
        ol++;
        nl++;
      } else if (op == 1) {
        ol++;
      } else {
        nl++;
      }
    }
    oByte(64);
    oByte(32);
    oInt(ai + 1);
    oByte(32);
    oInt(ol);
    oByte(32);
    oInt(bi + 1);
    oByte(32);
    oInt(nl);
    oByte(10);
    while (oi < hEnd) {
      const op = load<u8>(fwd + oi);
      if (op == 0) {
        oByte(61);
        oByte(32);
        const s = load<i32>(wp + A_START + ai * 4);
        const l = load<i32>(wp + A_LEN + ai * 4);
        const endsNl = oLine(s, l);
        ai++;
        bi++;
        if (!endsNl) {
          oByte(10);
          oByte(37);
          oByte(10);
        }
      } else if (op == 1) {
        oByte(45);
        oByte(32);
        const s = load<i32>(wp + A_START + ai * 4);
        const l = load<i32>(wp + A_LEN + ai * 4);
        const endsNl = oLine(s, l);
        ai++;
        if (!endsNl) {
          oByte(10);
          oByte(37);
          oByte(10);
        }
      } else {
        oByte(43);
        oByte(32);
        const s = load<i32>(wp + B_START + bi * 4);
        const l = load<i32>(wp + B_LEN + bi * 4);
        const endsNl = oLine(s, l);
        bi++;
        if (!endsNl) {
          oByte(10);
          oByte(37);
          oByte(10);
        }
      }
      oi++;
    }
  }
}

// ---- per-case driver ----------------------------------------------------------
// Diff one case given raw old/new string spans. Renders the JSON-escaped
// patch bytes to the output cursor.
function diffOneCase(oldStart: i32, oldEnd: i32, newStart: i32, newEnd: i32): void {
  const wp = workPtr();
  curGen++;
  nextId = 0;
  const nA = scanLines(oldStart, oldEnd, 0);
  const nB = scanLines(newStart, newEnd, 1);
  internLines(0, nA);
  internLines(1, nB);
  let ops = diffLines(nA, nB);
  if (ops < 0) {
    // Out-of-regime fallback (edit distance overflows the V region):
    // delete all old lines, then insert all new lines. Never traps.
    const fwd = wp + OPS_OFF + 81920;
    for (let i = 0; i < nA; i++) store<u8>(fwd + i, 1);
    for (let j = 0; j < nB; j++) store<u8>(fwd + nA + j, 2);
    ops = nA + nB;
  }
  renderPatch(nA, nB, ops);
}

// ---- exports -----------------------------------------------------------------
// Whole-file entry: `inp` points at the raw cases.json bytes in the input
// buffer. Renders the full answers.json (`["patch", ...]`) at `outp`.
export function runCases(inp: i32, len: i32, outp: i32): i32 {
  outBase = outp;
  outPos = 0;
  oByte(91);
  let pos: i32 = 0;
  let first = true;
  while (true) {
    const om = findOldMark(pos, len);
    if (om < 0) break;
    const oldStart = om + 16;
    const oldEnd = findStringEnd(oldStart, len);
    if (oldEnd < 0) break;
    const nm = findNewMark(oldEnd + 1, len);
    if (nm < 0) break;
    const newStart = nm + 7;
    const newEnd = findStringEnd(newStart, len);
    if (newEnd < 0) break;
    if (!first) oByte(44);
    first = false;
    oByte(34);
    diffOneCase(oldStart, oldEnd, newStart, newEnd);
    oByte(34);
    pos = newEnd + 1;
  }
  oByte(93);
  return outPos;
}

// Single-case entry: `inp` points at one case's raw JSON. Renders the
// JSON-escaped patch (no quotes) at `outp`.
export function runOne(inp: i32, len: i32, outp: i32): i32 {
  outBase = outp;
  outPos = 0;
  let oldStart: i32 = -1;
  const om = findOldMark(0, len);
  if (om >= 0) {
    oldStart = om + 16;
  } else {
    const os = findOldShortMark(0, len);
    if (os >= 0) oldStart = os + 7;
  }
  if (oldStart < 0) return 0;
  const oldEnd = findStringEnd(oldStart, len);
  if (oldEnd < 0) return 0;
  const nm = findNewMark(oldEnd + 1, len);
  if (nm < 0) return 0;
  const newStart = nm + 7;
  const newEnd = findStringEnd(newStart, len);
  if (newEnd < 0) return 0;
  diffOneCase(oldStart, oldEnd, newStart, newEnd);
  return outPos;
}
