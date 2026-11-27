// diff.ts — R7 cache-efficient interner (diff-speed-01-run-20261126).
//
// Design (from the prose brief, authored here from scratch):
// - Zero-copy raw-JSON scan: the input buffer is scanned directly for the
//   "old"/"new" string spans; lines are spans (start, length) in the raw
//   buffer. No JSON.parse, no JS strings on the hot path.
// - SIMD escape scan: 16-byte lanes; lanes with no backslash and no quote
//   are fed to the line hash in bulk. Escapes are handled scalarly.
// - Hash is over the line's unescaped meaning (UTF-8 bytes of the decoded
//   code units), streamed while scanning, never materialising the line.
// - Sort-based interning: line records (offset, length, index, group, hash)
//   are radix-sorted by hash (4 x 16-bit passes, sequential sweeps), equal
//   hashes are split into true groups by streaming content comparison, and
//   the old/new group lists are merged in one linear walk so equal lines
//   share ids. No hash table, no random access.
// - Differ: trusted globally-unique LIS anchors with a density filter
//   (an anchor is trusted only when at least two other unique matches sit
//   within three lines on both sides), exact Myers per gap with the
//   deletion-on-tie rule. No anchor splitting: gaps preserve the global
//   tie-break.
// - Renderer: lines are written from their raw spans; spans with only the
//   plain escapes (\n \r \" \\ \t \b \f) copy verbatim, other spans are
//   decoded and JSON-escaped while writing. Bare final lines get the "%" line.
// - All working sets live in one fixed scratch area in linear memory.

const IN_PTR: i32 = 1024 * 1024;
const OUT_PTR: i32 = 48 * 1024 * 1024;
const SCR_PTR: i32 = 64 * 1024 * 1024;
const VH_PTR: i32 = 128 * 1024 * 1024;
const VH_SIZE: i32 = 256 * 1024 * 1024;

// Scratch layout (all offsets from SCR_PTR). MAXREC lines per text,
// MAXID distinct line ids per case, MAXOPS ops per case.
const MAXREC: i32 = 100000;
const MAXID: i32 = 200000;
const MAXOPS: i32 = 200000;
const MAXHUNK: i32 = 100000;
const REC_A: i32 = SCR_PTR;
const TMP_A: i32 = REC_A + MAXREC * 24;
const REC_B: i32 = TMP_A + MAXREC * 24;
const TMP_B: i32 = REC_B + MAXREC * 24;
const SPAN_A_OFF: i32 = TMP_B + MAXREC * 24;
const SPAN_A_LEN: i32 = SPAN_A_OFF + MAXREC * 4;
const SPAN_A_FLG: i32 = SPAN_A_LEN + MAXREC * 4;
const SPAN_B_OFF: i32 = SPAN_A_FLG + MAXREC;
const SPAN_B_LEN: i32 = SPAN_B_OFF + MAXREC * 4;
const SPAN_B_FLG: i32 = SPAN_B_LEN + MAXREC * 4;
const ID_A: i32 = SPAN_B_FLG + MAXREC;
const ID_B: i32 = ID_A + MAXREC * 4;
const GRP_A_HASH: i32 = ID_B + MAXREC * 4;
const GRP_A_REP: i32 = GRP_A_HASH + MAXREC * 8;
const GRP_A_ID: i32 = GRP_A_REP + MAXREC * 4;
const GRP_B_HASH: i32 = GRP_A_ID + MAXREC * 4;
const GRP_B_REP: i32 = GRP_B_HASH + MAXREC * 8;
const GRP_B_ID: i32 = GRP_B_REP + MAXREC * 4;
const REPS_TMP: i32 = GRP_B_ID + MAXREC * 4;
const CNT_OLD: i32 = REPS_TMP + 4096 * 4;
const CNT_NEW: i32 = CNT_OLD + MAXID * 4;
const POS_NEW: i32 = CNT_NEW + MAXID * 4;
const PAIR_O: i32 = POS_NEW + MAXID * 4;
const PAIR_N: i32 = PAIR_O + MAXREC * 4;
const TAILS: i32 = PAIR_N + MAXREC * 4;
const TAILS_IDX: i32 = TAILS + MAXREC * 4;
const PREV: i32 = TAILS_IDX + MAXREC * 4;
const ANCH_O: i32 = PREV + MAXREC * 4;
const ANCH_N: i32 = ANCH_O + MAXREC * 4;
const FILT_O: i32 = TAILS;
const FILT_N: i32 = TAILS_IDX;
const OP_KIND: i32 = ANCH_N + MAXREC * 4;
const OP_OLD: i32 = OP_KIND + MAXOPS * 4;
const OP_NEW: i32 = OP_OLD + MAXOPS * 4;
const TMP_KIND: i32 = OP_NEW + MAXOPS * 4;
const TMP_AREF: i32 = TMP_KIND + MAXOPS * 4;
const TMP_BREF: i32 = TMP_AREF + MAXOPS * 4;
const HUNKS: i32 = TMP_BREF + MAXOPS * 4;
const VWORK: i32 = HUNKS + MAXHUNK * 24;
const CNT_RADIX: i32 = VWORK + 2000000;
const DEC_ST_A: i32 = CNT_RADIX + 65536 * 4;
const DEC_ST_B: i32 = DEC_ST_A + 16;
const INT_BUF: i32 = DEC_ST_B + 16;

// Line flags (SPAN_*_FLG): bit 0 = saw a \u escape, bit 1 = saw a \/
// escape, bit 2 = line ends with a newline (else it is the bare last line).
const FLG_UNICODE: i32 = 1;
const FLG_SLASH: i32 = 2;
const FLG_NEWLINE: i32 = 4;

// ---- globals ----
let g_scanEnd: i32 = 0;
let g_scanN: i32 = 0;
let g_opsLen: i32 = 0;
let g_delTotal: i32 = 0;
let g_insTotal: i32 = 0;
let hHash: u64 = 0;
let hBuf: u64 = 0;
let hNbuf: i32 = 0;
let hPend: i32 = -1;
let hCount: i32 = 0;
let wPend: i32 = -1;

// ---- small helpers ----
function hexVal(b: i32): i32 {
  if (b >= 48 && b <= 57) return b - 48;
  if (b >= 97 && b <= 102) return b - 87;
  return b - 55;
}
function hex4(p: i32): i32 {
  let v: i32 = 0;
  for (let k = 0; k < 4; k++) v = (v << 4) | hexVal(load<u8>(p + k));
  return v;
}
function hexDigit(v: i32): i32 {
  if (v < 10) return 48 + v;
  return 87 + v;
}
function escUnit(c: i32): i32 {
  if (c == 110) return 10; // n
  if (c == 114) return 13; // r
  if (c == 116) return 9; // t
  if (c == 98) return 8; // b
  if (c == 102) return 12; // f
  if (c == 34) return 34; // "
  if (c == 92) return 92; // backslash
  if (c == 47) return 47; // /
  return c;
}

// ---- streaming hash over the unescaped meaning ----
// The hash consumes the UTF-8 bytes of the decoded code units. Bytes are
// accumulated into 8-byte chunks and mixed; the machine is chunking
// invariant, so the SIMD bulk feed and the scalar feed agree.
function hashMix(chunk: u64): void {
  hHash ^= chunk;
  hHash *= 0x100000001b3;
  hHash ^= hHash >> 32;
}
function hashFeedByte(b: i32): void {
  hBuf |= u64(b & 0xff) << (8 * hNbuf);
  hNbuf++;
  hCount++;
  if (hNbuf == 8) {
    hashMix(hBuf);
    hBuf = 0;
    hNbuf = 0;
  }
}
function hashReset(): void {
  hHash = 0xcbf29ce484222325;
  hBuf = 0;
  hNbuf = 0;
  hPend = -1;
  hCount = 0;
}
function hashFinalize(): u64 {
  if (hNbuf > 0) hashMix(hBuf);
  let h: u64 = hHash ^ u64(hCount);
  h ^= h >> 33;
  h *= 0xff51afd7ed558ccd;
  h ^= h >> 33;
  h *= 0xc4ceb9fe1a85ec53;
  h ^= h >> 33;
  return h;
}
// Feed one decoded code unit (as UTF-8 bytes); surrogate pairs combine.
function hashFeedUnit(u: i32): void {
  if (u >= 0xd800 && u <= 0xdbff) {
    hPend = u;
    return;
  }
  if (u >= 0xdc00 && u <= 0xdfff && hPend >= 0) {
    const cp: i32 = 0x10000 + ((hPend - 0xd800) << 10) + (u - 0xdc00);
    hPend = -1;
    hashFeedByte(0xf0 | (cp >> 18));
    hashFeedByte(0x80 | ((cp >> 12) & 0x3f));
    hashFeedByte(0x80 | ((cp >> 6) & 0x3f));
    hashFeedByte(0x80 | (cp & 0x3f));
    return;
  }
  if (hPend >= 0) {
    const p: i32 = hPend;
    hPend = -1;
    hashFeedByte(0xe0 | (p >> 12));
    hashFeedByte(0x80 | ((p >> 6) & 0x3f));
    hashFeedByte(0x80 | (p & 0x3f));
  }
  if (u < 0x80) {
    hashFeedByte(u);
  } else if (u < 0x800) {
    hashFeedByte(0xc0 | (u >> 6));
    hashFeedByte(0x80 | (u & 0x3f));
  } else {
    hashFeedByte(0xe0 | (u >> 12));
    hashFeedByte(0x80 | ((u >> 6) & 0x3f));
    hashFeedByte(0x80 | (u & 0x3f));
  }
}

// ---- streaming decoded-unit reader ----
// State cell (8 bytes): absolute position at +0, pending low surrogate
// (or -1) at +4. Returns the next UTF-16 code unit, or -1 at the end.
function nextUnit(start: i32, end: i32, st: i32): i32 {
  const pend: i32 = load<i32>(st + 4);
  if (pend >= 0) {
    store<i32>(st + 4, -1);
    return pend;
  }
  let pos: i32 = load<i32>(st);
  if (pos >= end) return -1;
  const b: i32 = load<u8>(pos);
  if (b == 0x5c) {
    const c: i32 = load<u8>(pos + 1);
    if (c == 0x75) {
      const u: i32 = hex4(pos + 2);
      pos += 6;
      if (u >= 0xd800 && u <= 0xdbff && pos + 6 <= end &&
          load<u8>(pos) == 0x5c && load<u8>(pos + 1) == 0x75) {
        const u2: i32 = hex4(pos + 2);
        if (u2 >= 0xdc00 && u2 <= 0xdfff) {
          pos += 6;
          store<i32>(st + 4, u2);
          store<i32>(st, pos);
          return u;
        }
      }
      store<i32>(st, pos);
      return u;
    }
    store<i32>(st, pos + 2);
    return escUnit(c);
  }
  if (b < 0x80) {
    store<i32>(st, pos + 1);
    return b;
  }
  if ((b & 0xe0) == 0xc0) {
    const b2: i32 = load<u8>(pos + 1);
    const cp: i32 = ((b & 0x1f) << 6) | (b2 & 0x3f);
    store<i32>(st, pos + 2);
    return cp;
  }
  if ((b & 0xf0) == 0xe0) {
    const b2: i32 = load<u8>(pos + 1);
    const b3: i32 = load<u8>(pos + 2);
    const cp: i32 = ((b & 0x0f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f);
    store<i32>(st, pos + 3);
    return cp;
  }
  if ((b & 0xf8) == 0xf0) {
    const b2: i32 = load<u8>(pos + 1);
    const b3: i32 = load<u8>(pos + 2);
    const b4: i32 = load<u8>(pos + 3);
    const cp: i32 = ((b & 0x07) << 18) | ((b2 & 0x3f) << 12) |
      ((b3 & 0x3f) << 6) | (b4 & 0x3f);
    store<i32>(st, pos + 4);
    const rest: i32 = cp - 0x10000;
    store<i32>(st + 4, 0xdc00 + (rest & 0x3ff));
    return 0xd800 + (rest >> 10);
  }
  store<i32>(st, pos + 1);
  return b;
}

function rawEqual(aOff: i32, aLen: i32, bOff: i32, bLen: i32): bool {
  if (aLen != bLen) return false;
  let i: i32 = 0;
  while (i + 8 <= aLen) {
    if (load<u64>(aOff + i) != load<u64>(bOff + i)) return false;
    i += 8;
  }
  while (i < aLen) {
    if (load<u8>(aOff + i) != load<u8>(bOff + i)) return false;
    i++;
  }
  return true;
}

// Equality of two line records, by unescaped content. Fast path: identical
// raw bytes mean identical lines.
function linesEqual(aRec: i32, bRec: i32): bool {
  const aOff: i32 = load<i32>(aRec);
  const aLen: i32 = load<i32>(aRec + 4);
  const bOff: i32 = load<i32>(bRec);
  const bLen: i32 = load<i32>(bRec + 4);
  if (rawEqual(aOff, aLen, bOff, bLen)) return true;
  store<i32>(DEC_ST_A, aOff);
  store<i32>(DEC_ST_A + 4, -1);
  store<i32>(DEC_ST_B, bOff);
  store<i32>(DEC_ST_B + 4, -1);
  while (true) {
    const ua: i32 = nextUnit(aOff, aOff + aLen, DEC_ST_A);
    const ub: i32 = nextUnit(bOff, bOff + bLen, DEC_ST_B);
    if (ua != ub) return false;
    if (ua < 0) return true;
  }
}

// Feed a run of plain bytes (no backslash, no quote) into the line hash
// in bulk: whole 8-byte chunks when aligned with the chunk accumulator,
// single bytes for the remainder.
function feedPlain(p: i32, len: i32): void {
  let rem: i32 = len;
  if (hNbuf == 0) {
    while (rem >= 8) {
      hashMix(load<u64>(p));
      hCount += 8;
      p += 8;
      rem -= 8;
    }
  }
  while (rem > 0) {
    hashFeedByte(load<u8>(p));
    p++;
    rem--;
  }
}

// Find a JSON object key ("old" or "new", given by its 3 letters) at or
// after `from`, tolerating whitespace around the colon, and return the
// position just past the opening quote of its string value, or -1.
// A raw `"old"` / `"new"` byte run cannot occur inside a JSON string value
// (quotes there are escaped), so the key search cannot land in a text.
function findKey(from: i32, bound: i32, k0: i32, k1: i32, k2: i32): i32 {
  let p: i32 = from;
  const last: i32 = bound - 5;
  while (p <= last) {
    if (load<u8>(p) == 0x22 && load<u8>(p + 1) == k0 &&
        load<u8>(p + 2) == k1 && load<u8>(p + 3) == k2 &&
        load<u8>(p + 4) == 0x22) {
      let q: i32 = p + 5;
      while (q < bound) {
        const c: i32 = load<u8>(q);
        if (c == 0x20 || c == 0x09 || c == 0x0a || c == 0x0d) q++;
        else break;
      }
      if (q < bound && load<u8>(q) == 0x3a) {
        q++;
        while (q < bound) {
          const c: i32 = load<u8>(q);
          if (c == 0x20 || c == 0x09 || c == 0x0a || c == 0x0d) q++;
          else break;
        }
        if (q < bound && load<u8>(q) == 0x22) return q + 1;
      }
    }
    p++;
  }
  return -1;
}

function recordLine(start: i32, len: i32, n: i32, recBase: i32,
    spanOff: i32, spanLen: i32, spanFlg: i32, flags: i32): void {
  const rp: i32 = recBase + n * 24;
  store<i32>(rp, start);
  store<i32>(rp + 4, len);
  store<i32>(rp + 8, n);
  store<i32>(rp + 12, -1);
  store<u64>(rp + 16, hashFinalize());
  store<i32>(spanOff + n * 4, start);
  store<i32>(spanLen + n * 4, len);
  store<u8>(spanFlg + n, flags);
  hashReset();
}

// Walk one JSON string starting at strStart (just past the opening quote).
// Splits it into line spans, hashing each line as it goes. Sets g_scanEnd
// to the position just past the closing quote and g_scanN to the line count.
function scanText(strStart: i32, inputLen: i32, recBase: i32,
    spanOff: i32, spanLen: i32, spanFlg: i32): void {
  let pos: i32 = strStart;
  let lineStart: i32 = strStart;
  let n: i32 = 0;
  let lineFlags: i32 = 0;
  hashReset();
  const bs: v128 = i8x16.splat(0x5c);
  const qt: v128 = i8x16.splat(0x22);
  while (pos < inputLen) {
    if (pos + 16 <= inputLen) {
      const lane: v128 = v128.load(pos);
      const m: i32 = i8x16.bitmask(i8x16.eq(lane, bs)) |
        i8x16.bitmask(i8x16.eq(lane, qt));
      if (m == 0) {
        if (hNbuf == 0) {
          hashMix(load<u64>(pos));
          hashMix(load<u64>(pos + 8));
          hCount += 16;
        } else {
          for (let k: i32 = 0; k < 16; k++) hashFeedByte(load<u8>(pos + k));
        }
        pos += 16;
        continue;
      }
      const f: i32 = i32.ctz(m);
      if (f > 0) {
        feedPlain(pos, f);
        pos += f;
        continue;
      }
    }
    const b: i32 = load<u8>(pos);
    if (b == 0x22) {
      if (lineStart < pos) {
        recordLine(lineStart, pos - lineStart, n, recBase,
          spanOff, spanLen, spanFlg, lineFlags);
        n++;
      }
      pos++;
      break;
    } else if (b == 0x5c) {
      const c: i32 = load<u8>(pos + 1);
      if (c == 0x6e) {
        hashFeedByte(10);
        recordLine(lineStart, pos + 2 - lineStart, n, recBase,
          spanOff, spanLen, spanFlg, lineFlags | FLG_NEWLINE);
        n++;
        lineStart = pos + 2;
        pos += 2;
        lineFlags = 0;
      } else if (c == 0x75) {
        lineFlags |= FLG_UNICODE;
        const u: i32 = hex4(pos + 2);
        if (u == 10) {
          hashFeedByte(10);
          recordLine(lineStart, pos + 6 - lineStart, n, recBase,
            spanOff, spanLen, spanFlg, lineFlags | FLG_NEWLINE);
          n++;
          lineStart = pos + 6;
          pos += 6;
          lineFlags = 0;
        } else if (u >= 0xd800 && u <= 0xdbff && pos + 12 <= inputLen &&
            load<u8>(pos + 6) == 0x5c && load<u8>(pos + 7) == 0x75) {
          const u2: i32 = hex4(pos + 8);
          if (u2 >= 0xdc00 && u2 <= 0xdfff) {
            hashFeedUnit(u);
            hashFeedUnit(u2);
            pos += 12;
          } else {
            hashFeedUnit(u);
            pos += 6;
          }
        } else {
          hashFeedUnit(u);
          pos += 6;
        }
      } else if (c == 0x2f) {
        lineFlags |= FLG_SLASH;
        hashFeedByte(47);
        pos += 2;
      } else {
        hashFeedByte(escUnit(c));
        pos += 2;
      }
    } else {
      hashFeedByte(b);
      pos++;
    }
  }
  g_scanEnd = pos;
  g_scanN = n;
}

// ---- sort-based interning ----
// Radix sort of 24-byte records by the low 32 bits of their 64-bit hash,
// 2 passes of 16 bits. Equal lines share the full hash, so they share the
// low 32 bits and land adjacent; distinct lines that collide in the low 32
// bits are separated by the content comparison in the grouping step.
// Each pass is a sequential counting sweep plus a sequential scatter.
// After an even number of passes the sorted records are back in base.
function radixSort(base: i32, tmp: i32, n: i32): void {
  let cur: i32 = base;
  let nxt: i32 = tmp;
  for (let pass: i32 = 0; pass < 2; pass++) {
    const shift: i32 = pass * 16;
    memory.fill(CNT_RADIX, 0, 65536 * 4);
    for (let i: i32 = 0; i < n; i++) {
      const h: u64 = load<u64>(cur + i * 24 + 16);
      const b: i32 = i32((h >> shift) & 0xffff);
      store<i32>(CNT_RADIX + b * 4, load<i32>(CNT_RADIX + b * 4) + 1);
    }
    let sum: i32 = 0;
    for (let b: i32 = 0; b < 65536; b++) {
      const c: i32 = load<i32>(CNT_RADIX + b * 4);
      store<i32>(CNT_RADIX + b * 4, sum);
      sum += c;
    }
    for (let i: i32 = 0; i < n; i++) {
      const src: i32 = cur + i * 24;
      const h: u64 = load<u64>(src + 16);
      const b: i32 = i32((h >> shift) & 0xffff);
      const d: i32 = load<i32>(CNT_RADIX + b * 4);
      store<i32>(CNT_RADIX + b * 4, d + 1);
      const dst: i32 = nxt + d * 24;
      store<i64>(dst, load<i64>(src));
      store<i64>(dst + 8, load<i64>(src + 8));
      store<i64>(dst + 16, load<i64>(src + 16));
    }
    const t: i32 = cur;
    cur = nxt;
    nxt = t;
  }
}

// Split the hash-sorted records into groups of truly equal lines. The hash
// is never trusted alone: within each run of one hash, records are compared
// by content against the run's group representatives. Fills the group arrays
// (hash, representative record index, id) and stamps each record's gid.
// Returns the group count.
function groupRecs(base: i32, n: i32,
    grpHash: i32, grpRep: i32, grpId: i32): i32 {
  let g: i32 = 0;
  let i: i32 = 0;
  while (i < n) {
    const h: u64 = load<u64>(base + i * 24 + 16);
    let j: i32 = i + 1;
    while (j < n && load<u64>(base + j * 24 + 16) == h) j++;
    const gBase: i32 = g;
    let nrep: i32 = 0;
    for (let k: i32 = i; k < j; k++) {
      let found: i32 = -1;
      for (let r: i32 = 0; r < nrep; r++) {
        const rep: i32 = load<i32>(REPS_TMP + r * 4);
        if (linesEqual(base + k * 24, base + rep * 24)) {
          found = r;
          break;
        }
      }
      if (found < 0) {
        store<i32>(REPS_TMP + nrep * 4, k);
        found = nrep;
        nrep++;
        store<u64>(grpHash + g * 8, h);
        store<i32>(grpRep + g * 4, k);
        store<i32>(grpId + g * 4, g);
        g++;
      }
      store<i32>(base + k * 24 + 12, gBase + found);
    }
    i = j;
  }
  return g;
}

// Intern one case: sort + group both texts, merge the group lists in one
// linear walk so equal lines share an id, then write per-line ids in scan
// order into ID_A / ID_B. Returns the total id count.
function internCase(nA: i32, nB: i32): i32 {
  radixSort(REC_A, TMP_A, nA);
  const gA: i32 = groupRecs(REC_A, nA, GRP_A_HASH, GRP_A_REP, GRP_A_ID);
  radixSort(REC_B, TMP_B, nB);
  const gB: i32 = groupRecs(REC_B, nB, GRP_B_HASH, GRP_B_REP, GRP_B_ID);
  let fresh: i32 = gA;
  let i: i32 = 0;
  let j: i32 = 0;
  while (i < gA && j < gB) {
    const ha: u64 = load<u64>(GRP_A_HASH + i * 8);
    const hb: u64 = load<u64>(GRP_B_HASH + j * 8);
    // Groups are ordered by the low 32 hash bits (the radix sort keys on
    // them), so the merge compares low 32 bits, not the full hash.
    const haL: u64 = ha & 0xffffffff;
    const hbL: u64 = hb & 0xffffffff;
    if (haL < hbL) {
      i++;
    } else if (hbL < haL) {
      store<i32>(GRP_B_ID + j * 4, fresh);
      fresh++;
      j++;
    } else {
      let i2: i32 = i + 1;
      while (i2 < gA &&
             (load<u64>(GRP_A_HASH + i2 * 8) & 0xffffffff) == haL) i2++;
      let j2: i32 = j + 1;
      while (j2 < gB &&
             (load<u64>(GRP_B_HASH + j2 * 8) & 0xffffffff) == hbL) j2++;
      for (let jj: i32 = j; jj < j2; jj++) {
        const repB: i32 = load<i32>(GRP_B_REP + jj * 4);
        let matched: i32 = -1;
        for (let ii: i32 = i; ii < i2; ii++) {
          const repA: i32 = load<i32>(GRP_A_REP + ii * 4);
          if (linesEqual(REC_B + repB * 24, REC_A + repA * 24)) {
            matched = load<i32>(GRP_A_ID + ii * 4);
            break;
          }
        }
        if (matched >= 0) {
          store<i32>(GRP_B_ID + jj * 4, matched);
        } else {
          store<i32>(GRP_B_ID + jj * 4, fresh);
          fresh++;
        }
      }
      i = i2;
      j = j2;
    }
  }
  while (j < gB) {
    store<i32>(GRP_B_ID + j * 4, fresh);
    fresh++;
    j++;
  }
  for (let k: i32 = 0; k < nA; k++) {
    const rec: i32 = REC_A + k * 24;
    const idx: i32 = load<i32>(rec + 8);
    const gid: i32 = load<i32>(rec + 12);
    store<i32>(ID_A + idx * 4, load<i32>(GRP_A_ID + gid * 4));
  }
  for (let k: i32 = 0; k < nB; k++) {
    const rec: i32 = REC_B + k * 24;
    const idx: i32 = load<i32>(rec + 8);
    const gid: i32 = load<i32>(rec + 12);
    store<i32>(ID_B + idx * 4, load<i32>(GRP_B_ID + gid * 4));
  }
  return fresh;
}

// ---- differ ----
function emitOp(kind: i32, o: i32, n: i32): void {
  store<i32>(OP_KIND + g_opsLen * 4, kind);
  store<i32>(OP_OLD + g_opsLen * 4, o);
  store<i32>(OP_NEW + g_opsLen * 4, n);
  g_opsLen++;
}

// Exact Myers on the id slices [aStart, aStart+aLen) x [bStart, bStart+bLen),
// deletion preferred on ties, with the V snapshots kept in the V-history
// region for backtracking. Ops are appended to the main op arrays.
function myersGap(aStart: i32, aLen: i32, bStart: i32, bLen: i32): void {
  if (aLen == 0) {
    for (let k: i32 = 0; k < bLen; k++) emitOp(2, -1, bStart + k);
    return;
  }
  if (bLen == 0) {
    for (let k: i32 = 0; k < aLen; k++) emitOp(1, aStart + k, -1);
    return;
  }
  const N: i32 = aLen;
  const M: i32 = bLen;
  const MAX: i32 = N + M;
  store<i32>(VWORK + (1 + MAX) * 4, 0);
  let foundD: i32 = -1;
  for (let D: i32 = 0; D <= MAX; D++) {
    let found: bool = false;
    for (let k: i32 = -D; k <= D; k += 2) {
      let x: i32;
      if (k == -D ||
          (k != D &&
            load<i32>(VWORK + (k - 1 + MAX) * 4) + 1 <
            load<i32>(VWORK + (k + 1 + MAX) * 4))) {
        x = load<i32>(VWORK + (k + 1 + MAX) * 4);
      } else {
        x = load<i32>(VWORK + (k - 1 + MAX) * 4) + 1;
      }
      let y: i32 = x - k;
      while (x < N && y < M &&
          load<i32>(ID_A + (aStart + x) * 4) ==
          load<i32>(ID_B + (bStart + y) * 4)) {
        x++;
        y++;
      }
      store<i32>(VWORK + (k + MAX) * 4, x);
      if (x == N && y == M) {
        found = true;
        break;
      }
    }
    if (found) {
      foundD = D;
      break;
    }
    const snap: i32 = VH_PTR + D * D * 4;
    for (let k: i32 = -D; k <= D; k += 2) {
      store<i32>(snap + (k + D) * 4, load<i32>(VWORK + (k + MAX) * 4));
    }
  }
  const D: i32 = foundD;
  let x: i32 = N;
  let y: i32 = M;
  let tmpLen: i32 = 0;
  for (let d: i32 = D; d >= 1; d--) {
    const k: i32 = x - y;
    const prev: i32 = VH_PTR + (d - 1) * (d - 1) * 4;
    let prevK: i32;
    if (k == -d ||
        (k != d &&
          load<i32>(prev + (k - 1 + d - 1) * 4) + 1 <
          load<i32>(prev + (k + 1 + d - 1) * 4))) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX: i32 = load<i32>(prev + (prevK + d - 1) * 4);
    const prevY: i32 = prevX - prevK;
    let ex: i32;
    let ey: i32;
    let eKind: i32;
    let eRef: i32;
    if (prevK == k + 1) {
      ex = prevX;
      ey = prevY + 1;
      eKind = 2;
      eRef = bStart + prevY;
    } else {
      ex = prevX + 1;
      ey = prevY;
      eKind = 1;
      eRef = aStart + prevX;
    }
    while (x > ex && y > ey) {
      store<i32>(TMP_KIND + tmpLen * 4, 0);
      store<i32>(TMP_AREF + tmpLen * 4, aStart + x - 1);
      store<i32>(TMP_BREF + tmpLen * 4, bStart + y - 1);
      tmpLen++;
      x--;
      y--;
    }
    if (eKind == 1) {
      store<i32>(TMP_KIND + tmpLen * 4, 1);
      store<i32>(TMP_AREF + tmpLen * 4, eRef);
      store<i32>(TMP_BREF + tmpLen * 4, -1);
    } else {
      store<i32>(TMP_KIND + tmpLen * 4, 2);
      store<i32>(TMP_AREF + tmpLen * 4, -1);
      store<i32>(TMP_BREF + tmpLen * 4, eRef);
    }
    tmpLen++;
    x = prevX;
    y = prevY;
  }
  while (x > 0) {
    store<i32>(TMP_KIND + tmpLen * 4, 0);
    store<i32>(TMP_AREF + tmpLen * 4, aStart + x - 1);
    store<i32>(TMP_BREF + tmpLen * 4, bStart + y - 1);
    tmpLen++;
    x--;
    y--;
  }
  for (let i: i32 = tmpLen - 1; i >= 0; i--) {
    emitOp(load<i32>(TMP_KIND + i * 4),
      load<i32>(TMP_AREF + i * 4), load<i32>(TMP_BREF + i * 4));
  }
}

// Build the op list for one case: common prefix/suffix trim, trusted
// unique-LIS anchors with the density filter, exact Myers per gap.
function diffCase(nA: i32, nB: i32, numIds: i32): void {
  g_opsLen = 0;
  let pre: i32 = 0;
  while (pre < nA && pre < nB &&
      load<i32>(ID_A + pre * 4) == load<i32>(ID_B + pre * 4)) pre++;
  let suf: i32 = 0;
  while (suf < nA - pre && suf < nB - pre &&
      load<i32>(ID_A + (nA - 1 - suf) * 4) ==
      load<i32>(ID_B + (nB - 1 - suf) * 4)) suf++;
  for (let k: i32 = 0; k < pre; k++) emitOp(0, k, k);
  const mA0: i32 = pre;
  const mA1: i32 = nA - suf;
  const mB0: i32 = pre;
  const mB1: i32 = nB - suf;
  const mAn: i32 = mA1 - mA0;
  const mBn: i32 = mB1 - mB0;
  if (mAn > 0 || mBn > 0) {
    memory.fill(CNT_OLD, 0, numIds * 4);
    memory.fill(CNT_NEW, 0, numIds * 4);
    memory.fill(POS_NEW, 0xff, numIds * 4);
    for (let k: i32 = 0; k < mAn; k++) {
      const id: i32 = load<i32>(ID_A + (mA0 + k) * 4);
      store<i32>(CNT_OLD + id * 4, load<i32>(CNT_OLD + id * 4) + 1);
    }
    for (let k: i32 = 0; k < mBn; k++) {
      const id: i32 = load<i32>(ID_B + (mB0 + k) * 4);
      const c: i32 = load<i32>(CNT_NEW + id * 4);
      if (c == 0) store<i32>(POS_NEW + id * 4, mB0 + k);
      else store<i32>(POS_NEW + id * 4, -2);
      store<i32>(CNT_NEW + id * 4, c + 1);
    }
    let P: i32 = 0;
    for (let k: i32 = 0; k < mAn; k++) {
      const id: i32 = load<i32>(ID_A + (mA0 + k) * 4);
      if (load<i32>(CNT_OLD + id * 4) == 1 &&
          load<i32>(CNT_NEW + id * 4) == 1) {
        store<i32>(PAIR_O + P * 4, mA0 + k);
        store<i32>(PAIR_N + P * 4, load<i32>(POS_NEW + id * 4));
        P++;
      }
    }
    // Longest increasing subsequence of the unique pairs (patience).
    let lisLen: i32 = 0;
    for (let i: i32 = 0; i < P; i++) {
      const nv: i32 = load<i32>(PAIR_N + i * 4);
      let lo: i32 = 0;
      let hi: i32 = lisLen;
      while (lo < hi) {
        const mid: i32 = (lo + hi) >> 1;
        if (load<i32>(TAILS + mid * 4) < nv) lo = mid + 1;
        else hi = mid;
      }
      store<i32>(TAILS + lo * 4, nv);
      store<i32>(TAILS_IDX + lo * 4, i);
      store<i32>(PREV + i * 4,
        lo > 0 ? load<i32>(TAILS_IDX + (lo - 1) * 4) : -1);
      if (lo == lisLen) lisLen++;
    }
    let nAnch: i32 = 0;
    let cur: i32 = lisLen > 0
      ? load<i32>(TAILS_IDX + (lisLen - 1) * 4) : -1;
    while (cur >= 0) {
      store<i32>(ANCH_O + nAnch * 4, load<i32>(PAIR_O + cur * 4));
      store<i32>(ANCH_N + nAnch * 4, load<i32>(PAIR_N + cur * 4));
      nAnch++;
      cur = load<i32>(PREV + cur * 4);
    }
    for (let i: i32 = 0; i < nAnch / 2; i++) {
      const a: i32 = load<i32>(ANCH_O + i * 4);
      const b: i32 = load<i32>(ANCH_O + (nAnch - 1 - i) * 4);
      store<i32>(ANCH_O + i * 4, b);
      store<i32>(ANCH_O + (nAnch - 1 - i) * 4, a);
      const c: i32 = load<i32>(ANCH_N + i * 4);
      const d: i32 = load<i32>(ANCH_N + (nAnch - 1 - i) * 4);
      store<i32>(ANCH_N + i * 4, d);
      store<i32>(ANCH_N + (nAnch - 1 - i) * 4, c);
    }
    // Trust filter: an anchor is trusted only when its LIS neighbours sit
    // at the same diagonal on both sides — the old/new gaps to the previous
    // anchor are equal, and likewise to the next anchor. A swapped line
    // always shifts its diagonal by one against its neighbours, while an
    // innocent anchor next to a repeated line keeps equal gaps. (An earlier
    // version also distrusted anchors crossed by any unique pair, but one
    // far-moved line poisoned that check for thousands of good anchors, so
    // the diagonal test alone carries the filter now.)
    let nFilt: i32 = 0;
    for (let j: i32 = 0; j < nAnch; j++) {
      const oj: i32 = load<i32>(ANCH_O + j * 4);
      const nj: i32 = load<i32>(ANCH_N + j * 4);
      if (j == 0 || j == nAnch - 1) continue;
      const po: i32 = load<i32>(ANCH_O + (j - 1) * 4);
      const pn: i32 = load<i32>(ANCH_N + (j - 1) * 4);
      if (oj - po != nj - pn) continue;
      const qo: i32 = load<i32>(ANCH_O + (j + 1) * 4);
      const qn: i32 = load<i32>(ANCH_N + (j + 1) * 4);
      if (qo - oj != qn - nj) continue;
      store<i32>(FILT_O + nFilt * 4, oj);
      store<i32>(FILT_N + nFilt * 4, nj);
      nFilt++;
    }
    let po: i32 = mA0 - 1;
    let pn: i32 = mB0 - 1;
    for (let a: i32 = 0; a < nFilt; a++) {
      const ao: i32 = load<i32>(FILT_O + a * 4);
      const an: i32 = load<i32>(FILT_N + a * 4);
      myersGap(po + 1, ao - (po + 1), pn + 1, an - (pn + 1));
      emitOp(0, ao, an);
      po = ao;
      pn = an;
    }
    myersGap(po + 1, mA1 - (po + 1), pn + 1, mB1 - (pn + 1));
  }
  for (let k: i32 = 0; k < suf; k++) emitOp(0, nA - suf + k, nB - suf + k);
}

// ---- hunks + rendering ----
function computeHunks(): i32 {
  let h: i32 = 0;
  let del: i32 = 0;
  let ins: i32 = 0;
  for (let k: i32 = 0; k < g_opsLen; k++) {
    const kd: i32 = load<i32>(OP_KIND + k * 4);
    if (kd == 1) del++;
    else if (kd == 2) ins++;
  }
  g_delTotal = del;
  g_insTotal = ins;
  let i: i32 = 0;
  let oc: i32 = 0;
  let nc: i32 = 0;
  while (i < g_opsLen) {
    if (load<i32>(OP_KIND + i * 4) == 0) {
      oc++;
      nc++;
      i++;
      continue;
    }
    let hs: i32 = i;
    while (hs > 0 && i - hs < 3 &&
        load<i32>(OP_KIND + (hs - 1) * 4) == 0) {
      hs--;
      oc--;
      nc--;
    }
    let lastChange: i32 = i;
    while (true) {
      let k: i32 = lastChange + 1;
      let keeps: i32 = 0;
      while (k < g_opsLen && load<i32>(OP_KIND + k * 4) == 0) {
        k++;
        keeps++;
      }
      if (k < g_opsLen && keeps <= 6) {
        lastChange = k;
      } else {
        break;
      }
    }
    let he: i32 = lastChange + 1;
    while (he < g_opsLen && he - lastChange <= 3 &&
        load<i32>(OP_KIND + he * 4) == 0) he++;
    let oLen: i32 = 0;
    let nLen: i32 = 0;
    for (let k: i32 = hs; k < he; k++) {
      const kd: i32 = load<i32>(OP_KIND + k * 4);
      if (kd == 0) {
        oLen++;
        nLen++;
      } else if (kd == 1) {
        oLen++;
      } else {
        nLen++;
      }
    }
    const hp: i32 = HUNKS + h * 24;
    store<i32>(hp, hs);
    store<i32>(hp + 4, he);
    store<i32>(hp + 8, oc + 1);
    store<i32>(hp + 12, oLen);
    store<i32>(hp + 16, nc + 1);
    store<i32>(hp + 20, nLen);
    h++;
    oc += oLen;
    nc += nLen;
    i = he;
  }
  return h;
}

function wlit(out: i32, s: string): i32 {
  const n: i32 = s.length;
  for (let i: i32 = 0; i < n; i++) {
    store<u8>(out, s.charCodeAt(i));
    out++;
  }
  return out;
}
function wNL(out: i32): i32 {
  store<u8>(out, 0x5c);
  store<u8>(out + 1, 0x6e);
  return out + 2;
}
function writeInt(out: i32, v: i32): i32 {
  if (v == 0) {
    store<u8>(out, 48);
    return out + 1;
  }
  let p: i32 = INT_BUF;
  let n: i32 = v;
  while (n > 0) {
    store<u8>(p, 48 + (n % 10));
    p++;
    n = n / 10;
  }
  let q: i32 = p - 1;
  while (q >= INT_BUF) {
    store<u8>(out, load<u8>(q));
    out++;
    q--;
  }
  return out;
}
function writeUtf8(out: i32, cp: i32): i32 {
  if (cp < 0x80) {
    store<u8>(out, cp);
    return out + 1;
  }
  if (cp < 0x800) {
    store<u8>(out, 0xc0 | (cp >> 6));
    store<u8>(out + 1, 0x80 | (cp & 0x3f));
    return out + 2;
  }
  if (cp < 0x10000) {
    store<u8>(out, 0xe0 | (cp >> 12));
    store<u8>(out + 1, 0x80 | ((cp >> 6) & 0x3f));
    store<u8>(out + 2, 0x80 | (cp & 0x3f));
    return out + 3;
  }
  store<u8>(out, 0xf0 | (cp >> 18));
  store<u8>(out + 1, 0x80 | ((cp >> 12) & 0x3f));
  store<u8>(out + 2, 0x80 | ((cp >> 6) & 0x3f));
  store<u8>(out + 3, 0x80 | (cp & 0x3f));
  return out + 4;
}
function writeUnicodeEscape(out: i32, u: i32): i32 {
  store<u8>(out, 0x5c);
  store<u8>(out + 1, 0x75);
  store<u8>(out + 2, hexDigit((u >> 12) & 0xf));
  store<u8>(out + 3, hexDigit((u >> 8) & 0xf));
  store<u8>(out + 4, hexDigit((u >> 4) & 0xf));
  store<u8>(out + 5, hexDigit(u & 0xf));
  return out + 6;
}
// Write one decoded code unit as JSON string content (escaping as needed).
// A lone surrogate is written as a \uXXXX escape, exactly as JSON
// stringify does; a valid pair is written as its UTF-8 bytes.
function writeJsonUnit(out: i32, u: i32): i32 {
  if (u >= 0xd800 && u <= 0xdbff) {
    wPend = u;
    return out;
  }
  if (u >= 0xdc00 && u <= 0xdfff) {
    if (wPend >= 0) {
      const cp: i32 = 0x10000 + ((wPend - 0xd800) << 10) + (u - 0xdc00);
      wPend = -1;
      return writeUtf8(out, cp);
    }
    return writeUnicodeEscape(out, u);
  }
  if (wPend >= 0) {
    out = writeUnicodeEscape(out, wPend);
    wPend = -1;
  }
  if (u == 0x22) {
    store<u8>(out, 0x5c);
    store<u8>(out + 1, 0x22);
    return out + 2;
  }
  if (u == 0x5c) {
    store<u8>(out, 0x5c);
    store<u8>(out + 1, 0x5c);
    return out + 2;
  }
  if (u == 0x08) {
    store<u8>(out, 0x5c);
    store<u8>(out + 1, 0x62);
    return out + 2;
  }
  if (u == 0x0c) {
    store<u8>(out, 0x5c);
    store<u8>(out + 1, 0x66);
    return out + 2;
  }
  if (u == 0x0a) {
    store<u8>(out, 0x5c);
    store<u8>(out + 1, 0x6e);
    return out + 2;
  }
  if (u == 0x0d) {
    store<u8>(out, 0x5c);
    store<u8>(out + 1, 0x72);
    return out + 2;
  }
  if (u == 0x09) {
    store<u8>(out, 0x5c);
    store<u8>(out + 1, 0x74);
    return out + 2;
  }
  if (u < 0x20) {
    store<u8>(out, 0x5c);
    store<u8>(out + 1, 0x75);
    store<u8>(out + 2, 0x30);
    store<u8>(out + 3, 0x30);
    store<u8>(out + 4, hexDigit((u >> 4) & 0xf));
    store<u8>(out + 5, hexDigit(u & 0xf));
    return out + 6;
  }
  return writeUtf8(out, u);
}

// Write one patch line's content from its raw span. Spans holding only the
// plain escapes copy verbatim; anything with \u or \/ is decoded and
// JSON-escaped while writing. A bare last line gets the "%" line after it.
function renderLineContent(out: i32, spanOff: i32, spanLen: i32,
    flags: i32): i32 {
  if ((flags & (FLG_UNICODE | FLG_SLASH)) == 0) {
    memory.copy(out, spanOff, spanLen);
    out += spanLen;
  } else {
    store<i32>(DEC_ST_A, spanOff);
    store<i32>(DEC_ST_A + 4, -1);
    wPend = -1;
    while (true) {
      const u: i32 = nextUnit(spanOff, spanOff + spanLen, DEC_ST_A);
      if (u < 0) break;
      out = writeJsonUnit(out, u);
    }
    if (wPend >= 0) {
      out = writeUnicodeEscape(out, wPend);
      wPend = -1;
    }
  }
  if ((flags & FLG_NEWLINE) == 0) {
    out = wNL(out);
    store<u8>(out, 0x25);
    out++;
    out = wNL(out);
  }
  return out;
}

function renderOp(out: i32, opIdx: i32, marker: i32): i32 {
  store<u8>(out, marker);
  out++;
  const kd: i32 = load<i32>(OP_KIND + opIdx * 4);
  if (kd == 2) {
    const li: i32 = load<i32>(OP_NEW + opIdx * 4);
    out = renderLineContent(out, load<i32>(SPAN_B_OFF + li * 4),
      load<i32>(SPAN_B_LEN + li * 4), load<u8>(SPAN_B_FLG + li));
  } else {
    const li: i32 = load<i32>(OP_OLD + opIdx * 4);
    out = renderLineContent(out, load<i32>(SPAN_A_OFF + li * 4),
      load<i32>(SPAN_A_LEN + li * 4), load<u8>(SPAN_A_FLG + li));
  }
  return out;
}

function renderCase(nA: i32, nB: i32, out: i32, first: bool): i32 {
  if (!first) {
    store<u8>(out, 0x2c);
    out++;
  }
  store<u8>(out, 0x22);
  out++;
  const numIds: i32 = internCase(nA, nB);
  diffCase(nA, nB, numIds);
  const h: i32 = computeHunks();
  out = wlit(out, "makefun-diff/1 old=");
  out = writeInt(out, nA);
  out = wlit(out, " new=");
  out = writeInt(out, nB);
  out = wlit(out, " hunks=");
  out = writeInt(out, h);
  out = wlit(out, " deleted=");
  out = writeInt(out, g_delTotal);
  out = wlit(out, " inserted=");
  out = writeInt(out, g_insTotal);
  out = wNL(out);
  for (let hh: i32 = 0; hh < h; hh++) {
    const hp: i32 = HUNKS + hh * 24;
    const hs: i32 = load<i32>(hp);
    const he: i32 = load<i32>(hp + 4);
    out = wlit(out, "@ ");
    out = writeInt(out, load<i32>(hp + 8));
    out = wlit(out, " ");
    out = writeInt(out, load<i32>(hp + 12));
    out = wlit(out, " ");
    out = writeInt(out, load<i32>(hp + 16));
    out = wlit(out, " ");
    out = writeInt(out, load<i32>(hp + 20));
    out = wNL(out);
    let k: i32 = hs;
    while (k < he) {
      const kd: i32 = load<i32>(OP_KIND + k * 4);
      if (kd == 0) {
        out = renderOp(out, k, 0x3d);
        k++;
      } else {
        let r: i32 = k;
        while (r < he && load<i32>(OP_KIND + r * 4) != 0) r++;
        for (let t: i32 = k; t < r; t++) {
          if (load<i32>(OP_KIND + t * 4) == 1) out = renderOp(out, t, 0x2d);
        }
        for (let t: i32 = k; t < r; t++) {
          if (load<i32>(OP_KIND + t * 4) == 2) out = renderOp(out, t, 0x2b);
        }
        k = r;
      }
    }
  }
  store<u8>(out, 0x22);
  out++;
  return out;
}

// ---- entry point ----
export function inPtr(): i32 {
  return IN_PTR;
}
export function outPtr(): i32 {
  return OUT_PTR;
}
export function solve(inputLen: i32): i32 {
  const bound: i32 = IN_PTR + inputLen;
  let out: i32 = OUT_PTR;
  store<u8>(out, 0x5b);
  out++;
  let pos: i32 = IN_PTR;
  let first: bool = true;
  while (true) {
    const oldMark: i32 = findKey(pos, bound, 0x6f, 0x6c, 0x64);
    if (oldMark < 0) break;
    scanText(oldMark, bound, REC_A, SPAN_A_OFF, SPAN_A_LEN, SPAN_A_FLG);
    const nA: i32 = g_scanN;
    pos = g_scanEnd;
    const newMark: i32 = findKey(pos, bound, 0x6e, 0x65, 0x77);
    if (newMark < 0) break;
    scanText(newMark, bound, REC_B, SPAN_B_OFF, SPAN_B_LEN, SPAN_B_FLG);
    const nB: i32 = g_scanN;
    pos = g_scanEnd;
    out = renderCase(nA, nB, out, first);
    first = false;
  }
  store<u8>(out, 0x5d);
  out++;
  return out - OUT_PTR;
}
