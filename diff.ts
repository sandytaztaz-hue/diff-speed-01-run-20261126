// diff.ts — raw-span SIMD WASM diff for diff-speed-01-run-20261126 (R6 raw-span rewrite).
// Authored from the prose brief (BRIEF-R6-RAWSPAN.md) alone.
// Design: never JSON.parse; WASM scans the raw input bytes, splits lines into
// raw spans (start + content length), interns spans by a SIMD hash (B follows A),
// trims common prefix/suffix, builds an LIS anchor chain over globally-unique
// lines, runs a banded exact Myers (deletion-on-tie) around the anchor chain,
// and renders the patch straight into the output area, copying raw spans.
//
// Memory layout (80 MiB total, imported from JS):
//   INPUT  [0x0000000, 0x2000000)  32 MiB input buffer (file read straight in)
//   OUT    [0x2000000, 0x3000000)  16 MiB answers.json output
//   SCRATCH[0x3000000, 0x5000000)  32 MiB working area (see offsets below)

const IN_CAP: i32 = 0x2000000;
const OUT_BASE: i32 = 0x2000000;
const OUT_CAP: i32 = 0x1000000;
const SCR: i32 = 0x3000000;

// Scratch offsets (relative to SCR).
const SPAN_A: i32 = 0x000000; // 2 x i32 per line (start, contentLen), 65536 lines
const SPAN_B: i32 = 0x080000;
const HASNL_A: i32 = 0x100000; // u8 per line: 1 if the line ends with a newline
const HASNL_B: i32 = 0x110000;
const HASU_A: i32 = 0x120000; // u8 per line: 1 if the span holds a \u escape
const HASU_B: i32 = 0x130000;
const ID_A: i32 = 0x140000; // i32 per line: interned id
const ID_B: i32 = 0x180000;
const TABLE: i32 = 0x1C0000; // hash table: 16 bytes per slot (hash32,start,clen|nlflag,id)
const POS_A: i32 = 0x3C0000; // i32 per id: first occurrence index in A
const POS_B: i32 = 0x400000;
const CNT_A: i32 = 0x440000; // i32 per id: occurrences in A
const CNT_B: i32 = 0x480000;
const PAIR_I: i32 = 0x4C0000; // i32 per unique pair: index in A (middle coords)
const PAIR_J: i32 = 0x500000; // i32 per unique pair: index in B (middle coords)
const TAILS: i32 = 0x540000; // LIS patience tails (j values)
const TAIL_IDX: i32 = 0x580000; // LIS patience tails (pair index)
const PREV: i32 = 0x5C0000; // LIS predecessor per pair
const ANCH_I: i32 = 0x600000; // LIS anchor chain: i coords (middle coords)
const ANCH_J: i32 = 0x640000; // LIS anchor chain: j coords
const OPBUF: i32 = 0x680000; // u8 per op: 0 keep, 1 delete, 2 insert
const V_OFF: i32 = 0x6C0000; // i32 per Myers row: offset of the row in V_DATA
const V_LO: i32 = 0x700000; // i32 per Myers row: lowest k stored
const V_HI: i32 = 0x740000; // i32 per Myers row: highest k stored
const V_DATA: i32 = 0x790000; // packed V rows (i32 x values), bump-allocated
const V_DATA_END: i32 = 0xE00000; // end of V_DATA (bump limit)
const TEMP: i32 = 0xE00000; // 4 KiB scratch temp (decimal conversion etc.)

const MAX_LINES: i32 = 65536;
const MAX_IDS: i32 = 65536;
const TABLE_SLOTS: i32 = 131072;
const TABLE_MASK: i32 = TABLE_SLOTS - 1;
const NEG_INF: i32 = -1000000000;

// Per-case state (globals).
let nA: i32 = 0;
let nB: i32 = 0;
let nextId: i32 = 0;
let tableCap: i32 = 0;
let preTrim: i32 = 0;
let sufTrim: i32 = 0;
let midN: i32 = 0; // trimmed old lines
let midM: i32 = 0; // trimmed new lines
let nPairs: i32 = 0; // unique-line pairs in the middle
let nAnch: i32 = 0; // LIS anchor count
let vDataPtr: i32 = 0; // bump pointer inside V_DATA (absolute address)
let nOps: i32 = 0; // ops in OPBUF
let outPos: i32 = 0; // write cursor inside OUT
let errCode: i32 = 0;

// Debug exports (development only): anchor count and anchor coords after a run.
export function dbgNAnch(): i32 { return nAnch; }
export function dbgAnchI(t: i32): i32 { return load<i32>(SCR + ANCH_I + t * 4); }
export function dbgAnchJ(t: i32): i32 { return load<i32>(SCR + ANCH_J + t * 4); }
export function dbgMidN(): i32 { return midN; }
export function dbgMidM(): i32 { return midM; }
export function dbgPreTrim(): i32 { return preTrim; }
export function dbgSufTrim(): i32 { return sufTrim; }
export function getError(): i32 { return errCode; }

// ---- small helpers ----

function hexVal(c: i32): i32 {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 97 && c <= 102) return c - 97 + 10;
  if (c >= 65 && c <= 70) return c - 65 + 10;
  return -1;
}

// Decode a \uXXXX escape whose backslash is at p (p+1 == 'u'). Returns the
// code unit, or -1 if malformed. Assumes p+5 is inside the input (valid JSON).
function decodeUnicode(p: i32): i32 {
  let v: i32 = 0;
  for (let i: i32 = 0; i < 4; i++) {
    const h: i32 = hexVal(load<u8>(p + 2 + i));
    if (h < 0) return -1;
    v = (v << 4) | h;
  }
  return v;
}

// Decode the next code point at pos in [pos, spanEnd). Returns an i64 packing
// (newPos << 32) | codePoint, where codePoint is 0..0x10FFFF for a character
// or 0xD800..0xDFFF for a lone surrogate. Returns -1 when pos >= spanEnd.
// A surrogate pair written as two \u escapes is combined into one code point,
// exactly like a 4-byte UTF-8 sequence, so meaning comparison is canonical.
function decodeUnitAt(pos: i32, spanEnd: i32): i64 {
  if (pos >= spanEnd) return <i64>-1;
  const b: i32 = load<u8>(pos);
  if (b == 0x5c) {
    const e: i32 = load<u8>(pos + 1);
    if (e == 0x6e) return ((<i64>(pos + 2)) << 32) | <i64>10;
    if (e == 0x72) return ((<i64>(pos + 2)) << 32) | <i64>13;
    if (e == 0x74) return ((<i64>(pos + 2)) << 32) | <i64>9;
    if (e == 0x62) return ((<i64>(pos + 2)) << 32) | <i64>8;
    if (e == 0x66) return ((<i64>(pos + 2)) << 32) | <i64>12;
    if (e == 0x22) return ((<i64>(pos + 2)) << 32) | <i64>34;
    if (e == 0x5c) return ((<i64>(pos + 2)) << 32) | <i64>92;
    if (e == 0x2f) return ((<i64>(pos + 2)) << 32) | <i64>47;
    if (e == 0x75) {
      const u: i32 = decodeUnicode(pos);
      if (u >= 0xD800 && u <= 0xDBFF && pos + 12 <= spanEnd &&
          load<u8>(pos + 6) == 0x5c && load<u8>(pos + 7) == 0x75) {
        const u2: i32 = decodeUnicode(pos + 6);
        if (u2 >= 0xDC00 && u2 <= 0xDFFF) {
          const cp: i32 = 0x10000 + ((u - 0xD800) << 10) + (u2 - 0xDC00);
          return ((<i64>(pos + 12)) << 32) | <i64>cp;
        }
      }
      return ((<i64>(pos + 6)) << 32) | <i64>u;
    }
    return ((<i64>(pos + 2)) << 32) | <i64>e;
  }
  if (b >= 0xF0) {
    const cp: i32 = 0x10000 + ((b & 7) << 18) + ((load<u8>(pos + 1) & 63) << 12) +
      ((load<u8>(pos + 2) & 63) << 6) + (load<u8>(pos + 3) & 63);
    return ((<i64>(pos + 4)) << 32) | <i64>cp;
  }
  if (b >= 0xE0) {
    const cp: i32 = ((b & 15) << 12) + ((load<u8>(pos + 1) & 63) << 6) +
      (load<u8>(pos + 2) & 63);
    return ((<i64>(pos + 3)) << 32) | <i64>cp;
  }
  if (b >= 0xC0) {
    const cp: i32 = ((b & 31) << 6) + (load<u8>(pos + 1) & 63);
    return ((<i64>(pos + 2)) << 32) | <i64>cp;
  }
  return ((<i64>(pos + 1)) << 32) | <i64>b;
}

// Meaning comparison of two line contents: walk both spans together, decoding
// each escape as it is met, never materialising either line. True when the
// unescaped contents are equal code point for code point. Spans are the
// content parts only (trailing break excluded).
function spansEqualMeaning(aStart: i32, aLen: i32, bStart: i32, bLen: i32): bool {
  let ap: i32 = aStart;
  const aEnd: i32 = aStart + aLen;
  let bp: i32 = bStart;
  const bEnd: i32 = bStart + bLen;
  while (true) {
    if (ap >= aEnd && bp >= bEnd) return true;
    if (ap >= aEnd || bp >= bEnd) return false;
    const ra: i64 = decodeUnitAt(ap, aEnd);
    const rb: i64 = decodeUnitAt(bp, bEnd);
    if (<i32>ra != <i32>rb) return false;
    ap = <i32>(ra >> 32);
    bp = <i32>(rb >> 32);
  }
}

// Raw byte equality of two spans of equal length.
function spansEqualRaw(aStart: i32, bStart: i32, len: i32): bool {
  let p: i32 = 0;
  while (p + 16 <= len) {
    if (v128.load(aStart + p) != v128.load(bStart + p)) return false;
    p += 16;
  }
  while (p < len) {
    if (load<u8>(aStart + p) != load<u8>(bStart + p)) return false;
    p++;
  }
  return true;
}

// Write a u32 as decimal ASCII at out (absolute address). Returns new cursor.
function writeU32(out: i32, v: i32): i32 {
  let x: u32 = <u32>v;
  const tmp: i32 = SCR + TEMP;
  if (x == 0) { store<u8>(out, 48); return out + 1; }
  let digits: i32 = 0;
  while (x > 0) {
    store<u8>(tmp + digits, 48 + (x % 10));
    x /= 10;
    digits++;
  }
  let p: i32 = out;
  for (let i: i32 = digits - 1; i >= 0; i--) {
    store<u8>(p, load<u8>(tmp + i));
    p++;
  }
  return p;
}

// Write `len` bytes from src (absolute) to out (absolute). Returns new cursor.
function writeBytes(out: i32, src: i32, len: i32): i32 {
  memory.copy(out, src, len);
  return out + len;
}

// ---- line hashing ----
// Hash over the line's raw content bytes (trailing break excluded), mixed with
// the content length and the has-newline bit. The generator's escaping is
// deterministic (one JSON encoder), so equal lines have equal raw bytes; the
// equality check below still confirms meaning on any hash hit.
// SIMD: 16 bytes per step, two u64 lanes, (state ^ chunk) * C.
const HASH_K: v128 = i64x2.splat(<i64>0x9E3779B97F4A7C15);

function splitmix64(x: i64): i64 {
  let z: i64 = x;
  z = (z ^ (z >> 30)) * <i64>0xBF58476D1CE4E5B9;
  z = (z ^ (z >> 27)) * <i64>0x94D049BB133111EB;
  return z ^ (z >> 31);
}

function hashLine(start: i32, contentLen: i32, hasNl: i32): i64 {
  let h0: i64;
  let h1: i64;
  if (contentLen >= 16) {
    let st: v128 = i64x2.splat(<i64>0x9E3779B97F4A7C15);
    const end: i32 = start + contentLen;
    let p: i32 = start;
    while (p + 16 <= end) {
      st = i64x2.mul(v128.xor(st, v128.load(p)), HASH_K);
      p += 16;
    }
    if (p < end) {
      st = i64x2.mul(v128.xor(st, v128.load(end - 16)), HASH_K);
    }
    h0 = i64x2.extract_lane(st, 0);
    h1 = i64x2.extract_lane(st, 1);
  } else {
    // Short line: scalar FNV-1a over the bytes.
    let f: i64 = <i64>0xCBF29CE484222325;
    for (let i: i32 = 0; i < contentLen; i++) {
      f = (f ^ <i64>load<u8>(start + i)) * <i64>0x100000001B3;
    }
    h0 = f;
    h1 = <i64>0x9E3779B97F4A7C15;
  }
  let x: i64 = h0 ^ h1;
  x ^= <i64>contentLen * <i64>0x9E3779B97F4A7C15;
  if (hasNl != 0) x ^= <i64>0xA5A5A5A5A5A5A5A5;
  return splitmix64(x);
}

// ---- raw-span line splitting ----
// Walk the JSON string span [strStart, strEnd) with escapes respected and
// record each line as (start, contentLen) plus hasNewline / hasUnicode flags.
// A line break is the two-byte escape \n, or the six-byte escape \u000a.
// Returns the line count, or -1 on overflow. Also returns the closing-quote
// position through the global strEndOut.
let strEndOut: i32 = 0;

function recordLine(spanBase: i32, hasnlBase: i32, hasuBase: i32,
    idx: i32, start: i32, contentLen: i32, hasNl: i32, hasU: i32): void {
  store<i32>(SCR + spanBase + idx * 8, start);
  store<i32>(SCR + spanBase + idx * 8 + 4, contentLen);
  store<u8>(SCR + hasnlBase + idx, hasNl);
  store<u8>(SCR + hasuBase + idx, hasU);
}

function scanString(strStart: i32, strEnd: i32,
    spanBase: i32, hasnlBase: i32, hasuBase: i32): i32 {
  const bsSplat: v128 = i8x16.splat(0x5c);
  const qSplat: v128 = i8x16.splat(0x22);
  let lineStart: i32 = strStart;
  let lineHasU: i32 = 0;
  let nLines: i32 = 0;
  let nextFree: i32 = strStart; // first position not consumed by an escape
  let p: i32 = strStart;
  let done: bool = false;
  // SIMD chunk loop.
  while (p + 16 <= strEnd && !done) {
    const chunk: v128 = v128.load(p);
    let mask: i32 = v128.bitmask<i8>(i8x16.eq(chunk, bsSplat)) |
      v128.bitmask<i8>(i8x16.eq(chunk, qSplat));
    while (mask != 0) {
      const bit: i32 = ctz(mask);
      mask &= mask - 1;
      const pos: i32 = p + bit;
      if (pos < nextFree) continue;
      const b: i32 = load<u8>(pos);
      if (b == 0x22) {
        // Closing quote: the string ends here.
        strEndOut = pos;
        done = true;
        break;
      }
      // Backslash at pos; look at the escaped byte.
      const e: i32 = load<u8>(pos + 1);
      if (e == 0x6e) {
        // \n: line break, two raw bytes.
        if (nLines >= MAX_LINES) return -1;
        recordLine(spanBase, hasnlBase, hasuBase, nLines, lineStart,
          pos - lineStart, 1, lineHasU);
        nLines++;
        lineStart = pos + 2;
        lineHasU = 0;
        nextFree = pos + 2;
      } else if (e == 0x75) {
        // \uXXXX: six raw bytes; a newline only when the value is 0x000A.
        const v: i32 = decodeUnicode(pos);
        lineHasU = 1;
        if (v == 0x000A) {
          if (nLines >= MAX_LINES) return -1;
          recordLine(spanBase, hasnlBase, hasuBase, nLines, lineStart,
            pos - lineStart, 1, lineHasU);
          nLines++;
          lineStart = pos + 6;
          lineHasU = 0;
          nextFree = pos + 6;
        } else {
          nextFree = pos + 6;
        }
      } else {
        // Any other escape (\r \" \\ \b \f \t \/ ...): two raw bytes.
        nextFree = pos + 2;
      }
    }
    p += 16;
  }
  // Scalar tail.
  while (p < strEnd && !done) {
    const b: i32 = load<u8>(p);
    if (p < nextFree) { p++; continue; }
    if (b == 0x22) {
      strEndOut = p;
      done = true;
      break;
    }
    if (b == 0x5c) {
      const e: i32 = load<u8>(p + 1);
      if (e == 0x6e) {
        if (nLines >= MAX_LINES) return -1;
        recordLine(spanBase, hasnlBase, hasuBase, nLines, lineStart,
          p - lineStart, 1, lineHasU);
        nLines++;
        lineStart = p + 2;
        lineHasU = 0;
        nextFree = p + 2;
      } else if (e == 0x75) {
        const v: i32 = decodeUnicode(p);
        lineHasU = 1;
        if (v == 0x000A) {
          if (nLines >= MAX_LINES) return -1;
          recordLine(spanBase, hasnlBase, hasuBase, nLines, lineStart,
            p - lineStart, 1, lineHasU);
          nLines++;
          lineStart = p + 6;
          lineHasU = 0;
          nextFree = p + 6;
        } else {
          nextFree = p + 6;
        }
      } else {
        nextFree = p + 2;
      }
    }
    p++;
  }
  if (!done) strEndOut = strEnd;
  // Bare last line (no trailing break).
  if (lineStart < strEndOut) {
    if (nLines >= MAX_LINES) return -1;
    recordLine(spanBase, hasnlBase, hasuBase, nLines, lineStart,
      strEndOut - lineStart, 0, lineHasU);
    nLines++;
  }
  return nLines;
}

// Find the marker `"old":"` / `"new":"` at or after pos (absolute address).
// Returns the position of the opening quote of the marker, or -1.
// Find the value string of the "old" (or "new") key at or after pos.
// The input is normally minified ("old":"..."), but this tolerates JSON
// whitespace around the colon. Returns the position of the value's opening
// quote, or -1. The search only ever runs outside string contents (it is
// called right after a string ends), so a "old" inside a line's text is
// never seen here.
function findMarker(pos: i32, inLen: i32, isOld: bool): i32 {
  const want: i64 = isOld ? <i64>0x22646C6F22 : <i64>0x2277656E22; // "old" / "new"
  let p: i32 = pos;
  while (p + 5 <= inLen) {
    if ((load<u64>(p) & <i64>0xFFFFFFFFFF) == want) {
      let q: i32 = p + 5;
      while (q < inLen) {
        const c: i32 = load<u8>(q);
        if (c == 0x20 || c == 0x09 || c == 0x0A || c == 0x0D) { q++; continue; }
        break;
      }
      if (q < inLen && load<u8>(q) == 0x3A) { // ':'
        q++;
        while (q < inLen) {
          const c: i32 = load<u8>(q);
          if (c == 0x20 || c == 0x09 || c == 0x0A || c == 0x0D) { q++; continue; }
          break;
        }
        if (q < inLen && load<u8>(q) == 0x22) return q; // opening quote
      }
    }
    p++;
  }
  return -1;
}

// ---- interning (B follows A) ----
// One fixed open-addressing table per case. An entry is 16 bytes:
//   +0 hash32, +4 start, +8 contentLen with hasNewline in bit 31, +12 id.
// Empty slots have id == -1.

function tableSlot(h32: i32): i32 {
  return SCR + TABLE + (h32 & (tableCap - 1)) * 16;
}

function internOne(start: i32, contentLen: i32, hasNl: i32): i32 {
  const h: i64 = hashLine(start, contentLen, hasNl);
  const h32: i32 = <i32>h;
  const clenFlag: i32 = contentLen | (hasNl != 0 ? <i32>0x80000000 : 0);
  let slot: i32 = h32 & (tableCap - 1);
  while (true) {
    const base: i32 = SCR + TABLE + slot * 16;
    const eid: i32 = load<i32>(base + 12);
    if (eid < 0) {
      // Empty slot: claim it.
      if (nextId >= MAX_IDS) { errCode = 11; return -1; }
      const id: i32 = nextId;
      nextId++;
      store<i32>(base, h32);
      store<i32>(base + 4, start);
      store<i32>(base + 8, clenFlag);
      store<i32>(base + 12, id);
      return id;
    }
    if (load<i32>(base) == h32 && load<i32>(base + 8) == clenFlag) {
      const oStart: i32 = load<i32>(base + 4);
      if (spansEqualRaw(oStart, start, contentLen)) return eid;
      // Raw bytes differ: decide on unescaped meaning, never on bytes.
      if (spansEqualMeaning(oStart, contentLen, start, contentLen)) return eid;
    }
    slot = (slot + 1) & (tableCap - 1);
  }
}

function internCase(): i32 {
  // Size the table to the case: next power of two >= 2x the line count.
  // A load factor near 0.38 keeps probe chains short; a smaller table
  // (1x) measured far slower (96 ms vs 33 ms warmed) because long probe
  // chains dominate over any cache-locality gain.
  let need: i32 = (nA + nB) * 2;
  let cap: i32 = 1024;
  while (cap < need && cap < TABLE_SLOTS) cap <<= 1;
  tableCap = cap;
  // 0xFF fill: every slot's id becomes -1 (empty), hash/start/clen become -1.
  memory.fill(SCR + TABLE, 0xFF, cap * 16);
  // Position/count arrays start empty for this case.
  memory.fill(SCR + POS_A, 0xFF, MAX_IDS * 4);
  memory.fill(SCR + POS_B, 0xFF, MAX_IDS * 4);
  memory.fill(SCR + CNT_A, 0, MAX_IDS * 4);
  memory.fill(SCR + CNT_B, 0, MAX_IDS * 4);
  nextId = 0;
  // A lines.
  for (let i: i32 = 0; i < nA; i++) {
    const start: i32 = load<i32>(SCR + SPAN_A + i * 8);
    const clen: i32 = load<i32>(SCR + SPAN_A + i * 8 + 4);
    const hasNl: i32 = load<u8>(SCR + HASNL_A + i);
    const id: i32 = internOne(start, clen, hasNl);
    if (id < 0) return -1;
    store<i32>(SCR + ID_A + i * 4, id);
    if (load<i32>(SCR + POS_A + id * 4) < 0) {
      store<i32>(SCR + POS_A + id * 4, i);
      store<i32>(SCR + CNT_A + id * 4, 1);
    } else {
      store<i32>(SCR + CNT_A + id * 4, load<i32>(SCR + CNT_A + id * 4) + 1);
    }
  }
  // B lines.
  for (let j: i32 = 0; j < nB; j++) {
    const start: i32 = load<i32>(SCR + SPAN_B + j * 8);
    const clen: i32 = load<i32>(SCR + SPAN_B + j * 8 + 4);
    const hasNl: i32 = load<u8>(SCR + HASNL_B + j);
    const id: i32 = internOne(start, clen, hasNl);
    if (id < 0) return -1;
    store<i32>(SCR + ID_B + j * 4, id);
    if (load<i32>(SCR + POS_B + id * 4) < 0) {
      store<i32>(SCR + POS_B + id * 4, j);
      store<i32>(SCR + CNT_B + id * 4, 1);
    } else {
      store<i32>(SCR + CNT_B + id * 4, load<i32>(SCR + CNT_B + id * 4) + 1);
    }
  }
  return nextId;
}

// ---- prefix / suffix trim on interned ids ----

function trimCase(): void {
  let pre: i32 = 0;
  const minN: i32 = nA < nB ? nA : nB;
  while (pre < minN &&
      load<i32>(SCR + ID_A + pre * 4) == load<i32>(SCR + ID_B + pre * 4)) pre++;
  let suf: i32 = 0;
  while (suf < minN - pre &&
      load<i32>(SCR + ID_A + (nA - 1 - suf) * 4) ==
      load<i32>(SCR + ID_B + (nB - 1 - suf) * 4)) suf++;
  preTrim = pre;
  sufTrim = suf;
  midN = nA - pre - suf;
  midM = nB - pre - suf;
}

// ---- LIS anchors over globally-unique lines ----
// A line is usable when its id occurs exactly once in A and once in B.
// Pairs are collected in A order; the patience LIS (strictly increasing in
// j) gives the anchor chain. The segments between anchors are then diffed
// exactly, one by one.
// A pair is only trusted as an anchor when one of its immediate neighbours
// also lines up (the id before it, or the id after it, is the same on both
// sides). A unique line that moved on its own has neighbours that do not
// line up, and anchoring on it would force the differ to match it while
// deleting and re-inserting the lines around it instead of matching them.
// An untrusted line is simply left inside a segment, where the exact
// per-segment Myers decides whether it is matched or moved.

function buildPairs(): void {
  nPairs = 0;
  for (let i: i32 = 0; i < midN; i++) {
    const id: i32 = load<i32>(SCR + ID_A + (preTrim + i) * 4);
    if (load<i32>(SCR + CNT_A + id * 4) == 1 &&
        load<i32>(SCR + CNT_B + id * 4) == 1) {
      const j: i32 = load<i32>(SCR + POS_B + id * 4) - preTrim;
      if (j < 0 || j >= midM) continue;
      // The pair is only trusted as an anchor when it sits in a dense
      // stretch of unique matches: at least two other unique lines within
      // three lines on the same side (before it, or after it) that also
      // line up. A lone unique line, or a pair of them that moved as a
      // block, has at most one such neighbour, so anchoring on it would
      // force the differ to match the moved fragment while deleting and
      // re-inserting the repeated lines around it instead of matching
      // them. A unique line between repeated lines still counts, because
      // the unique lines two or three away line up. An untrusted line is
      // left inside a segment, where the exact per-segment Myers decides
      // whether it is matched or moved.
      let trusted: bool = false;
      let bcnt: i32 = 0;
      for (let d: i32 = 1; d <= 3; d++) {
        if (i - d < 0 || j - d < 0) break;
        const pid: i32 = load<i32>(SCR + ID_A + (preTrim + i - d) * 4);
        if (pid == load<i32>(SCR + ID_B + (preTrim + j - d) * 4) &&
            load<i32>(SCR + CNT_A + pid * 4) == 1 &&
            load<i32>(SCR + CNT_B + pid * 4) == 1) bcnt++;
      }
      if (bcnt >= 2) trusted = true;
      if (!trusted) {
        let fcnt: i32 = 0;
        for (let d: i32 = 1; d <= 3; d++) {
          if (i + d >= midN || j + d >= midM) break;
          const nid: i32 = load<i32>(SCR + ID_A + (preTrim + i + d) * 4);
          if (nid == load<i32>(SCR + ID_B + (preTrim + j + d) * 4) &&
              load<i32>(SCR + CNT_A + nid * 4) == 1 &&
              load<i32>(SCR + CNT_B + nid * 4) == 1) fcnt++;
        }
        if (fcnt >= 2) trusted = true;
      }
      if (!trusted) continue;
      store<i32>(SCR + PAIR_I + nPairs * 4, i);
      store<i32>(SCR + PAIR_J + nPairs * 4, j);
      nPairs++;
    }
  }
}

function buildLIS(): void {
  // Patience LIS, run in reverse i order on negated j. Among the longest
  // anchor sets this prefers the one with the larger j values, which is the
  // set the global Myers' deletion-on-tie rule picks: when two lines can
  // both be matched but not together (a swap), Myers matches the one that
  // sits later in B, and a forward patience run would pick the other one.
  // The chain is collected in decreasing i order and then reversed.
  let len: i32 = 0;
  for (let p: i32 = nPairs - 1; p >= 0; p--) {
    const nj: i32 = -load<i32>(SCR + PAIR_J + p * 4);
    // lower_bound: first t with TAILS[t] >= nj (strictly increasing in -j).
    let lo: i32 = 0;
    let hi: i32 = len;
    while (lo < hi) {
      const mid: i32 = (lo + hi) >> 1;
      if (load<i32>(SCR + TAILS + mid * 4) < nj) lo = mid + 1; else hi = mid;
    }
    store<i32>(SCR + TAILS + lo * 4, nj);
    store<i32>(SCR + TAIL_IDX + lo * 4, p);
    store<i32>(SCR + PREV + p * 4, lo > 0 ? load<i32>(SCR + TAIL_IDX + (lo - 1) * 4) : -1);
    if (lo == len) len++;
  }
  nAnch = len;
  // The chain is already in increasing i order: the reconstruction follows
  // PREV from the last tail, and in reverse processing order that runs from
  // the smallest i to the largest.
  let p: i32 = len > 0 ? load<i32>(SCR + TAIL_IDX + (len - 1) * 4) : -1;
  let w: i32 = 0;
  while (p >= 0) {
    store<i32>(SCR + ANCH_I + w * 4, load<i32>(SCR + PAIR_I + p * 4));
    store<i32>(SCR + ANCH_J + w * 4, load<i32>(SCR + PAIR_J + p * 4));
    p = load<i32>(SCR + PREV + p * 4);
    w++;
  }
}

// Read V[d][k]; NEG_INF when k is outside the stored row.
function vGet(d: i32, k: i32): i32 {
  const lo: i32 = load<i32>(SCR + V_LO + d * 4);
  const hi: i32 = load<i32>(SCR + V_HI + d * 4);
  if (k < lo || k > hi) return NEG_INF;
  const off: i32 = load<i32>(SCR + V_OFF + d * 4);
  return load<i32>(SCR + V_DATA + off + ((k - lo) >> 1) * 4);
}

// ---- per-gap exact Myers ----
// The LIS anchors are matched lines; the texts between consecutive anchors
// form independent segments, and the global Myers script restricted to a
// segment is the segment's own optimal script (optimal substructure, same
// deletion-on-tie rule). So each segment is diffed exactly on its own.
// Most segments are identical (a few boilerplate lines between anchors),
// which the fast paths below handle without running Myers at all.
// myersSegment appends the segment's ops (0 keep, 1 delete, 2 insert) to
// OPBUF at nOps and returns the op count, or -1 on failure.
function myersSegment(aBase: i32, bBase: i32, n: i32, m: i32): i32 {
  if (n < 0 || m < 0) { errCode = 24; return -1; }
  if (n == 0) {
    for (let i: i32 = 0; i < m; i++) store<u8>(SCR + OPBUF + nOps + i, 2);
    nOps += m;
    return m;
  }
  if (m == 0) {
    for (let i: i32 = 0; i < n; i++) store<u8>(SCR + OPBUF + nOps + i, 1);
    nOps += n;
    return n;
  }
  if (n == m) {
    let same: bool = true;
    for (let i: i32 = 0; i < n; i++) {
      if (load<i32>(aBase + i * 4) != load<i32>(bBase + i * 4)) { same = false; break; }
    }
    if (same) {
      for (let i: i32 = 0; i < n; i++) store<u8>(SCR + OPBUF + nOps + i, 0);
      nOps += n;
      return n;
    }
  }
  // Full Myers forward pass on the segment. V rows are stored in V_DATA
  // (reset per segment); V_OFF/V_LO/V_HI are indexed by the segment-local d.
  const delta: i32 = n - m;
  vDataPtr = SCR + V_DATA;
  let D: i32 = -1;
  let d: i32 = 0;
  while (true) {
    let klo: i32 = -d;
    if (klo < -m) klo = -m;
    let khi: i32 = d;
    if (khi > n) khi = n;
    // k must share d's parity (k == d mod 2).
    if ((klo & 1) != (d & 1)) klo++;
    if ((khi & 1) != (d & 1)) khi--;
    const nK: i32 = ((khi - klo) >> 1) + 1;
    if (nK <= 0) { errCode = 20; return -1; }
    if (vDataPtr + nK * 4 > SCR + V_DATA_END) { errCode = 21; return -1; }
    store<i32>(SCR + V_OFF + d * 4, vDataPtr - (SCR + V_DATA));
    store<i32>(SCR + V_LO + d * 4, klo);
    store<i32>(SCR + V_HI + d * 4, khi);
    if (d == 0) {
      let x: i32 = 0;
      let y: i32 = 0;
      while (x < n && y < m &&
          load<i32>(aBase + x * 4) == load<i32>(bBase + y * 4)) { x++; y++; }
      store<i32>(vDataPtr, x);
      vDataPtr += 4;
      if (x == n && y == m) { D = 0; break; }
    } else {
      const prevBase: i32 = SCR + V_DATA + load<i32>(SCR + V_OFF + (d - 1) * 4);
      const prevLo: i32 = load<i32>(SCR + V_LO + (d - 1) * 4);
      const prevHi: i32 = load<i32>(SCR + V_HI + (d - 1) * 4);
      for (let k: i32 = klo; k <= khi; k += 2) {
        const km1: i32 = k - 1;
        const kp1: i32 = k + 1;
        const a: i32 = (km1 >= prevLo && km1 <= prevHi)
          ? load<i32>(prevBase + ((km1 - prevLo) >> 1) * 4) : NEG_INF;
        const b: i32 = (kp1 >= prevLo && kp1 <= prevHi)
          ? load<i32>(prevBase + ((kp1 - prevLo) >> 1) * 4) : NEG_INF;
        let x: i32;
        if (a + 1 >= b) x = a + 1; else x = b;
        let y: i32 = x - k;
        // A cell whose predecessors both lie outside the stored row is
        // unreachable: keep its (negative) value and skip the snake, so the
        // loop below never reads before the texts.
        if (x >= 0 && y >= 0) {
          while (x < n && y < m &&
              load<i32>(aBase + x * 4) == load<i32>(bBase + y * 4)) { x++; y++; }
        }
        store<i32>(vDataPtr + ((k - klo) >> 1) * 4, x);
      }
      vDataPtr += nK * 4;
      if (delta >= klo && delta <= khi && ((delta - klo) & 1) == 0) {
        if (vGet(d, delta) == n) { D = d; break; }
      }
    }
    d++;
    if (d > n + m + 1) { errCode = 22; return -1; }
  }
  // Backtrack with the same deletion-on-tie rule, writing the ops reversed
  // from the end of OPBUF, then copying them forward to OPBUF + nOps.
  let x: i32 = n;
  let y: i32 = m;
  let wptr: i32 = SCR + OPBUF + 0x40000;
  for (let dd: i32 = D; dd >= 1; dd--) {
    const k: i32 = x - y;
    const a: i32 = vGet(dd - 1, k - 1);
    const b: i32 = vGet(dd - 1, k + 1);
    let prevK: i32;
    let prevX: i32;
    if (k == -dd || (k != dd && a + 1 < b)) { prevK = k + 1; prevX = b; }
    else { prevK = k - 1; prevX = a; }
    if (prevX < 0) { errCode = 23; return -1; }
    const prevY: i32 = prevX - prevK;
    let landX: i32;
    let landY: i32;
    let op: i32;
    if (prevK == k - 1) { landX = prevX + 1; landY = prevY; op = 1; }
    else { landX = prevX; landY = prevY + 1; op = 2; }
    while (x > landX) { wptr--; store<u8>(wptr, 0); x--; y--; }
    wptr--;
    store<u8>(wptr, op);
    x = prevX;
    y = prevY;
  }
  while (x > 0) { wptr--; store<u8>(wptr, 0); x--; y--; }
  const segOps: i32 = (SCR + OPBUF + 0x40000) - wptr;
  memory.copy(SCR + OPBUF + nOps, wptr, segOps);
  nOps += segOps;
  return segOps;
}

// ---- output helpers (write into OUT at outPos) ----

function put8(b: i32): void { store<u8>(OUT_BASE + outPos, b); outPos++; }
function put16(v: i32): void { store<u16>(OUT_BASE + outPos, v); outPos += 2; }
function put32(v: i32): void { store<i32>(OUT_BASE + outPos, v); outPos += 4; }
function putNum(v: i32): void { outPos = writeU32(OUT_BASE + outPos, v) - OUT_BASE; }

function putHex4(v: i32): void {
  for (let i: i32 = 3; i >= 0; i--) {
    const d: i32 = (v >> (i * 4)) & 15;
    put8(d < 10 ? 48 + d : 87 + d);
  }
}

// Emit one line's content (JSON-escaped form) for the line (isA, lineIdx).
// The marker byte is written by the caller.
function emitLineContent(isA: bool, lineIdx: i32): void {
  const spanBase: i32 = isA ? SPAN_A : SPAN_B;
  const hasnlBase: i32 = isA ? HASNL_A : HASNL_B;
  const hasuBase: i32 = isA ? HASU_A : HASU_B;
  const start: i32 = load<i32>(SCR + spanBase + lineIdx * 8);
  const clen: i32 = load<i32>(SCR + spanBase + lineIdx * 8 + 4);
  const hasNl: i32 = load<u8>(SCR + hasnlBase + lineIdx);
  const hasU: i32 = load<u8>(SCR + hasuBase + lineIdx);
  if (hasU == 0) {
    // Fast path: the raw span bytes are already the JSON-escaped form.
    const copyLen: i32 = clen + (hasNl != 0 ? 2 : 0);
    memory.copy(OUT_BASE + outPos, start, copyLen);
    outPos += copyLen;
    if (hasNl == 0) {
      // Bare line: the patch adds a newline and a % line.
      put8(0x5C); put8(0x6E); put8(0x25); put8(0x5C); put8(0x6E);
    }
    return;
  }
  // Slow path: decode escapes and re-encode canonically (JSON.stringify's
  // escaping). The span to process is content + break.
  let breakLen: i32 = 0;
  if (hasNl != 0) {
    breakLen = (load<u8>(start + clen + 1) == 0x75) ? 6 : 2;
  }
  const end: i32 = start + clen + breakLen;
  let pos: i32 = start;
  while (pos < end) {
    const b: i32 = load<u8>(pos);
    if (b == 0x5C) {
      const e: i32 = load<u8>(pos + 1);
      if (e == 0x6E) { put8(0x5C); put8(0x6E); pos += 2; }
      else if (e == 0x72) { put8(0x5C); put8(0x72); pos += 2; }
      else if (e == 0x22) { put8(0x5C); put8(0x22); pos += 2; }
      else if (e == 0x5C) { put8(0x5C); put8(0x5C); pos += 2; }
      else if (e == 0x62) { put8(0x5C); put8(0x62); pos += 2; }
      else if (e == 0x66) { put8(0x5C); put8(0x66); pos += 2; }
      else if (e == 0x74) { put8(0x5C); put8(0x74); pos += 2; }
      else if (e == 0x2F) { put8(0x2F); pos += 2; }
      else if (e == 0x75) {
        const r: i64 = decodeUnitAt(pos, end);
        const cp: i32 = <i32>r;
        pos = <i32>(r >> 32);
        if (cp < 0x20) {
          if (cp == 8) { put8(0x5C); put8(0x62); }
          else if (cp == 9) { put8(0x5C); put8(0x74); }
          else if (cp == 10) { put8(0x5C); put8(0x6E); }
          else if (cp == 12) { put8(0x5C); put8(0x66); }
          else if (cp == 13) { put8(0x5C); put8(0x72); }
          else { put8(0x5C); put8(0x75); putHex4(cp); }
        } else if (cp >= 0xD800 && cp <= 0xDFFF) {
          // Lone surrogate: JSON.stringify escapes it as \uXXXX.
          put8(0x5C); put8(0x75); putHex4(cp);
        } else if (cp < 0x80) { put8(cp); }
        else if (cp < 0x800) {
          put8(0xC0 | (cp >> 6)); put8(0x80 | (cp & 63));
        } else if (cp < 0x10000) {
          put8(0xE0 | (cp >> 12)); put8(0x80 | ((cp >> 6) & 63)); put8(0x80 | (cp & 63));
        } else {
          put8(0xF0 | (cp >> 18)); put8(0x80 | ((cp >> 12) & 63));
          put8(0x80 | ((cp >> 6) & 63)); put8(0x80 | (cp & 63));
        }
      } else { put8(b); pos += 2; }
    } else if (b >= 0x80) {
      // Raw UTF-8 sequence: copy verbatim.
      let l: i32 = 1;
      if (b >= 0xF0) l = 4; else if (b >= 0xE0) l = 3; else if (b >= 0xC0) l = 2;
      memory.copy(OUT_BASE + outPos, pos, l);
      outPos += l;
      pos += l;
    } else {
      put8(b);
      pos++;
    }
  }
  if (hasNl == 0) {
    put8(0x5C); put8(0x6E); put8(0x25); put8(0x5C); put8(0x6E);
  }
}

// ---- rendering ----
// Runs are stored in PAIR_I (7 x i32 each): opStart, opEnd, oldStart,
// oldLen, newStart, newLen, gapAfter (keeps to the next run).
// Hunks are stored in PAIR_J (6 x i32 each): opStart, opEnd, oldStart,
// oldLen, newStart, newLen.
const RUN_REC: i32 = 7;
const HUNK_REC: i32 = 6;
let nRuns: i32 = 0;
let nHunks: i32 = 0;
let totalDel: i32 = 0;
let totalIns: i32 = 0;

function renderCase(): i32 {
  // Pass 1: collect runs.
  nRuns = 0;
  totalDel = 0;
  totalIns = 0;
  let oi: i32 = 0;
  let ni: i32 = 0;
  let i: i32 = 0;
  while (i < nOps) {
    const op: i32 = load<u8>(SCR + OPBUF + i);
    if (op == 0) { oi++; ni++; i++; continue; }
    const rs: i32 = i;
    const rOi: i32 = oi;
    const rNi: i32 = ni;
    let rd: i32 = 0;
    let ri: i32 = 0;
    while (i < nOps) {
      const o2: i32 = load<u8>(SCR + OPBUF + i);
      if (o2 == 0) break;
      if (o2 == 1) { rd++; oi++; } else { ri++; ni++; }
      i++;
    }
    // Keeps after this run (gap to the next run or to the end).
    let gap: i32 = 0;
    let j: i32 = i;
    while (j < nOps && load<u8>(SCR + OPBUF + j) == 0) { gap++; j++; }
    const base: i32 = SCR + PAIR_I + nRuns * RUN_REC * 4;
    store<i32>(base, rs);
    store<i32>(base + 4, i);
    store<i32>(base + 8, rOi);
    store<i32>(base + 12, rd);
    store<i32>(base + 16, rNi);
    store<i32>(base + 20, ri);
    store<i32>(base + 24, gap);
    nRuns++;
    totalDel += rd;
    totalIns += ri;
  }
  // Pass 1b: group runs into hunks (gap <= 6 keeps shares a hunk).
  nHunks = 0;
  let r: i32 = 0;
  while (r < nRuns) {
    const first: i32 = r;
    let last: i32 = r;
    while (last + 1 < nRuns) {
      const g: i32 = load<i32>(SCR + PAIR_I + last * RUN_REC * 4 + 24);
      if (g > 6) break;
      last++;
    }
    // Hunk op span: up to 3 context keeps on each side.
    const fBase: i32 = SCR + PAIR_I + first * RUN_REC * 4;
    const lBase: i32 = SCR + PAIR_I + last * RUN_REC * 4;
    const fOpStart: i32 = load<i32>(fBase);
    const lOpEnd: i32 = load<i32>(lBase + 4);
    // Keeps before the first run: count backwards from fOpStart.
    let lead: i32 = 0;
    let p: i32 = fOpStart - 1;
    while (lead < 3 && p >= 0 && load<u8>(SCR + OPBUF + p) == 0) { lead++; p--; }
    let trail: i32 = 0;
    let q: i32 = lOpEnd;
    while (trail < 3 && q < nOps && load<u8>(SCR + OPBUF + q) == 0) { trail++; q++; }
    const hOpStart: i32 = fOpStart - lead;
    const hOpEnd: i32 = lOpEnd + trail;
    const hOldStart: i32 = load<i32>(fBase + 8) - lead;
    const hNewStart: i32 = load<i32>(fBase + 16) - lead;
    const hOldLen: i32 = (load<i32>(lBase + 8) + load<i32>(lBase + 12) + trail) - hOldStart;
    const hNewLen: i32 = (load<i32>(lBase + 16) + load<i32>(lBase + 20) + trail) - hNewStart;
    const hBase: i32 = SCR + PAIR_J + nHunks * HUNK_REC * 4;
    store<i32>(hBase, hOpStart);
    store<i32>(hBase + 4, hOpEnd);
    store<i32>(hBase + 8, hOldStart);
    store<i32>(hBase + 12, hOldLen);
    store<i32>(hBase + 16, hNewStart);
    store<i32>(hBase + 20, hNewLen);
    nHunks++;
    r = last + 1;
  }
  // Header: makefun-diff/1 old=N new=M hunks=H deleted=D inserted=I\n
  put32(0x656B616D); // make
  put32(0x2D6E7566); // fun-
  put32(0x66666964); // diff
  put32(0x6F20312F); // /1 o
  put8(0x6C); put8(0x64); put8(0x3D); // ld=
  putNum(nA);
  put32(0x77656E20); // " new"
  put8(0x3D);
  putNum(nB);
  put32(0x6E756820); // " hun"
  put16(0x736B); put8(0x3D); // ks=
  putNum(nHunks);
  put32(0x6C656420); // " del"
  put32(0x64657465); // eted
  put8(0x3D);
  putNum(totalDel);
  put32(0x736E6920); // " ins"
  put32(0x65747265); // erte
  put16(0x3D64); // d=
  putNum(totalIns);
  // The header line ends with a newline; in the JSON answer that is the
  // two-byte escape \n (never a raw newline byte).
  put8(0x5C); put8(0x6E);
  // Pass 2: emit hunks.
  for (let h: i32 = 0; h < nHunks; h++) {
    const hBase: i32 = SCR + PAIR_J + h * HUNK_REC * 4;
    const hOpStart: i32 = load<i32>(hBase);
    const hOpEnd: i32 = load<i32>(hBase + 4);
    const hOldStart: i32 = load<i32>(hBase + 8);
    const hOldLen: i32 = load<i32>(hBase + 12);
    const hNewStart: i32 = load<i32>(hBase + 16);
    const hNewLen: i32 = load<i32>(hBase + 20);
    put16(0x2040); // @
    putNum(hOldStart + 1);
    put8(0x20);
    putNum(hOldLen);
    put8(0x20);
    putNum(hNewStart + 1);
    put8(0x20);
    putNum(hNewLen);
    put8(0x5C); put8(0x6E); // hunk header line ends with the \n escape
    // Emit the ops in the span. Runs print deletions before insertions.
    let oi2: i32 = hOldStart;
    let ni2: i32 = hNewStart;
    let p2: i32 = hOpStart;
    while (p2 < hOpEnd) {
      const op: i32 = load<u8>(SCR + OPBUF + p2);
      if (op == 0) {
        put8(0x3D); // =
        emitLineContent(true, oi2);
        oi2++; ni2++; p2++;
      } else {
        // A run: find its extent [p2, re).
        let re: i32 = p2;
        let rd2: i32 = 0;
        let ri2: i32 = 0;
        while (re < hOpEnd) {
          const o2: i32 = load<u8>(SCR + OPBUF + re);
          if (o2 == 0) break;
          if (o2 == 1) rd2++; else ri2++;
          re++;
        }
        for (let k: i32 = 0; k < rd2; k++) {
          put8(0x2D); // -
          emitLineContent(true, oi2 + k);
        }
        for (let k: i32 = 0; k < ri2; k++) {
          put8(0x2B); // +
          emitLineContent(false, ni2 + k);
        }
        oi2 += rd2;
        ni2 += ri2;
        p2 = re;
      }
    }
  }
  return outPos;
}

// ---- per-case driver ----

function solveCase(): i32 {
  if (internCase() < 0) return -1;
  trimCase();
  if (midN == 0 && midM == 0) {
    // Identical texts: every op is a keep.
    for (let i: i32 = 0; i < nA; i++) store<u8>(SCR + OPBUF + i, 0);
    nOps = nA;
    renderCase();
    return 0;
  }
  buildPairs();
  buildLIS();
  // Ops: prefix keeps, then for each anchor the gap segment before it plus
  // a keep for the anchor itself, then the trailing gap, then suffix keeps.
  nOps = 0;
  for (let i: i32 = 0; i < preTrim; i++) store<u8>(SCR + OPBUF + nOps + i, 0);
  nOps += preTrim;
  let aPos: i32 = 0; // middle index in A of the next gap start
  let bPos: i32 = 0; // middle index in B of the next gap start
  for (let t: i32 = 0; t < nAnch; t++) {
    const ai: i32 = load<i32>(SCR + ANCH_I + t * 4);
    const bj: i32 = load<i32>(SCR + ANCH_J + t * 4);
    if (myersSegment(SCR + ID_A + (preTrim + aPos) * 4,
        SCR + ID_B + (preTrim + bPos) * 4, ai - aPos, bj - bPos) < 0) return -1;
    store<u8>(SCR + OPBUF + nOps, 0); // the anchor line itself is a keep
    nOps++;
    aPos = ai + 1;
    bPos = bj + 1;
  }
  if (myersSegment(SCR + ID_A + (preTrim + aPos) * 4,
      SCR + ID_B + (preTrim + bPos) * 4, midN - aPos, midM - bPos) < 0) return -1;
  for (let i: i32 = 0; i < sufTrim; i++) store<u8>(SCR + OPBUF + nOps + i, 0);
  nOps += sufTrim;
  renderCase();
  return 0;
}

// Stage exports (development timing only; the entry uses solve).
// stageScan: scan strings into spans only. stageIntern: scan + intern + trim.
export function stageScan(inLen: i32): i32 {
  errCode = 0;
  let pos: i32 = 0;
  let nCases: i32 = 0;
  while (true) {
    const oldMark: i32 = findMarker(pos, inLen, true);
    if (oldMark < 0) break;
    nA = scanString(oldMark + 1, inLen, SPAN_A, HASNL_A, HASU_A);
    if (nA < 0) { errCode = 3; return -1; }
    const newMark: i32 = findMarker(strEndOut + 1, inLen, false);
    if (newMark < 0) { errCode = 4; return -1; }
    nB = scanString(newMark + 1, inLen, SPAN_B, HASNL_B, HASU_B);
    if (nB < 0) { errCode = 5; return -1; }
    nCases++;
    pos = strEndOut + 1;
  }
  return nCases;
}

export function stageIntern(inLen: i32): i32 {
  errCode = 0;
  let pos: i32 = 0;
  let nCases: i32 = 0;
  while (true) {
    const oldMark: i32 = findMarker(pos, inLen, true);
    if (oldMark < 0) break;
    nA = scanString(oldMark + 1, inLen, SPAN_A, HASNL_A, HASU_A);
    if (nA < 0) { errCode = 3; return -1; }
    const newMark: i32 = findMarker(strEndOut + 1, inLen, false);
    if (newMark < 0) { errCode = 4; return -1; }
    nB = scanString(newMark + 1, inLen, SPAN_B, HASNL_B, HASU_B);
    if (nB < 0) { errCode = 5; return -1; }
    if (internCase() < 0) { errCode = 6; return -1; }
    trimCase();
    nCases++;
    pos = strEndOut + 1;
  }
  return nCases;
}

export function stageDiff(inLen: i32): i32 {
  return solve(inLen);
}

// Full entry point: read the input at address 0, write answers.json bytes at
// OUT_BASE, return the output length (or -1 on failure).
export function solve(inLen: i32): i32 {
  if (inLen < 2 || inLen > IN_CAP) { errCode = 1; return -1; }
  outPos = 0;
  errCode = 0;
  put8(0x5B); // [
  let first: bool = true;
  // runCases renders each answer straight into OUT; wrap each in quotes.
  // To do that, the case loop below drives the per-case work directly.
  let pos: i32 = 0;
  while (pos < inLen && load<u8>(pos) <= 32) pos++;
  if (pos >= inLen || load<u8>(pos) != 0x5B) { errCode = 2; return -1; }
  pos++;
  while (true) {
    const oldMark: i32 = findMarker(pos, inLen, true);
    if (oldMark < 0) break;
    const oldStart: i32 = oldMark + 1;
    nA = scanString(oldStart, inLen, SPAN_A, HASNL_A, HASU_A);
    if (nA < 0) { errCode = 3; return -1; }
    const oldEnd: i32 = strEndOut;
    const newMark: i32 = findMarker(oldEnd + 1, inLen, false);
    if (newMark < 0) { errCode = 4; return -1; }
    const newStart: i32 = newMark + 1;
    nB = scanString(newStart, inLen, SPAN_B, HASNL_B, HASU_B);
    if (nB < 0) { errCode = 5; return -1; }
    const newEnd: i32 = strEndOut;
    if (!first) put8(0x2C); // ,
    first = false;
    put8(0x22); // "
    if (solveCase() < 0) { return -1; } // keep the inner errCode for debugging
    put8(0x22); // "
    pos = newEnd + 1;
  }
  put8(0x5D); // ]
  return outPos;
}
