// diff.ts — exact Myers diff over raw JSON, in SIMD WebAssembly.
// Written by hand from the prose brief for diff-speed-01-run-20261126.
// Pipeline: raw JSON scan -> escape-aware decode to UTF-16 units (line
// table fused into the decode) -> hash-intern lines -> unique-line LIS in
// new order -> keep only anchors inside runs of >= 5 consecutive anchors
// -> exact Myers (deletion-on-tie) per gap -> patch render -> JSON-escaped
// answers. No JSON.parse anywhere on the hot path; no JavaScript string
// appears in the solve. Only raw memory access and v128 SIMD are used;
// no AssemblyScript managed allocation happens here, so the fixed layout
// below (starting at 16 MiB, above the runtime's own static data) is safe.

// ---------- memory layout (byte addresses) ----------
const RESERVED: i32 = 0x1000000; // 16 MiB: runtime static data + heap live below here
const RAW_PTR: i32 = 0x1000000; // 16 MiB, raw input, cap 48 MiB
const RAW_CAP: i32 = 0x3000000;
const DEC_PTR: i32 = 0x4000000; // 64 MiB, decoded UTF-16 units, cap 32 MiB
const DEC_CAP_UNITS: i32 = 0x1000000; // 16M units
const SCR_PTR: i32 = 0x6000000; // 96 MiB, scratch, cap 16 MiB
const SCR_CAP: i32 = 0x1000000;
const OUT_PTR: i32 = 0x7000000; // 112 MiB, answers.json bytes, cap 16 MiB
const OUT_CAP: i32 = 0x1000000;
const TRC_PTR: i32 = 0x8000000; // 128 MiB, Myers trace, cap 16 MiB (grows)

// ---------- capacities ----------
const MAXL: i32 = 65536; // max lines per text
const ID_CAP: i32 = 131072; // max distinct lines per case
const HT_CAP: i32 = 131072; // hash slots (power of two)
const HT_MASK: i32 = HT_CAP - 1;
const MAXU: i32 = 65536; // max unique-pair candidates for the LIS
const RUN_MIN: i32 = 5; // anchors only inside runs of >= 5 consecutive anchors
const V_CAP: i32 = 524288; // Myers V array entries
const OPS_CAP: i32 = 262144; // ops buffer bytes
const PATCH_CAP: i32 = 1048576; // patch buffer, UTF-16 units
const HUNK_CAP: i32 = 8192; // max hunks per case

// ---------- scratch offsets (relative to SCR_PTR) ----------
const HT_OFF: i32 = 0; // 2 MiB: slots of 16 B (hash i64 @+0, ref i32 @+8, gen i32 @+12)
const IDM_OFF: i32 = 0x200000; // 2.5 MiB: repOff, repLen, cntOld, cntNew, oldPos (i32 each, ID_CAP each)
const TAB_OFF: i32 = 0x480000; // 1 MiB: oldTab + newTab, (start i32, len i32) per line
const IDS_OFF: i32 = 0x580000; // 0.5 MiB: idOld + idNew (i32 per line)
const LIS_OFF: i32 = 0x600000; // 1.25 MiB: seqI, seqJ, parent, tailsVal, tailsIdx (i32, MAXU each)
const ANC_OFF: i32 = 0x740000; // 0.5 MiB: kept anchors ancI + ancJ (i32, MAXU each)
const OPS_OFF: i32 = 0x7C0000; // 256 KiB: ops bytes
const TMP_OFF: i32 = 0x800000; // 256 KiB: backtrack temp ops
const V_OFF: i32 = 0x840000; // 2 MiB: Myers V (i32)
const HUNK_OFF: i32 = 0xA40000; // 64 KiB: hunk (startOp i32, endOp i32) pairs
const PATCH_OFF: i32 = 0xA50000; // 2 MiB: patch UTF-16 units

// op codes
const OP_EQ: i32 = 0;
const OP_DEL: i32 = 1;
const OP_INS: i32 = 2;

// ---------- globals (mutable state) ----------
let curGen: i32 = 0;
let nIds: i32 = 0;
let oldLines: i32 = 0;
let newLines: i32 = 0;
let decEnd: i32 = 0; // unit index just past the decoded text (relative to DEC_PTR)
let opsLen: i32 = 0;
let hunkCount: i32 = 0;
let patchPos: i32 = 0; // unit index in the patch buffer
let outPos: i32 = 0; // byte index in the OUT buffer

// scratch base pointers (absolute)
function htPtr(): i32 { return SCR_PTR + HT_OFF; }
function repOffPtr(): i32 { return SCR_PTR + IDM_OFF; }
function repLenPtr(): i32 { return SCR_PTR + IDM_OFF + ID_CAP * 4; }
function cntOldPtr(): i32 { return SCR_PTR + IDM_OFF + ID_CAP * 8; }
function cntNewPtr(): i32 { return SCR_PTR + IDM_OFF + ID_CAP * 12; }
function oldPosPtr(): i32 { return SCR_PTR + IDM_OFF + ID_CAP * 16; }
function oldTabPtr(): i32 { return SCR_PTR + TAB_OFF; }
function newTabPtr(): i32 { return SCR_PTR + TAB_OFF + MAXL * 8; }
function idOldPtr(): i32 { return SCR_PTR + IDS_OFF; }
function idNewPtr(): i32 { return SCR_PTR + IDS_OFF + MAXL * 4; }
function seqIPtr(): i32 { return SCR_PTR + LIS_OFF; }
function seqJPtr(): i32 { return SCR_PTR + LIS_OFF + MAXU * 4; }
function parentPtr(): i32 { return SCR_PTR + LIS_OFF + MAXU * 8; }
function tailsValPtr(): i32 { return SCR_PTR + LIS_OFF + MAXU * 12; }
function tailsIdxPtr(): i32 { return SCR_PTR + LIS_OFF + MAXU * 16; }
function opsPtr(): i32 { return SCR_PTR + OPS_OFF; }
function tmpPtr(): i32 { return SCR_PTR + TMP_OFF; }
function vPtr(): i32 { return SCR_PTR + V_OFF; }
function hunkPtr(): i32 { return SCR_PTR + HUNK_OFF; }
function patchPtr(): i32 { return SCR_PTR + PATCH_OFF; }
function ancIPtr(): i32 { return SCR_PTR + ANC_OFF; }
function ancJPtr(): i32 { return SCR_PTR + ANC_OFF + MAXU * 4; }

// ---------- small helpers ----------
function hexVal(c: i32): i32 {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 65 && c <= 70) return c - 55;
  if (c >= 97 && c <= 102) return c - 87;
  return -1;
}

// emit one UTF-16 unit into the patch buffer (patch buffer is given by patchBase)
let patchBase: i32 = 0;
function emitU(u: i32): void {
  store<u16>(patchBase + patchPos * 2, u);
  patchPos++;
}
// emit four UTF-16 units at once via one u64 store (a,b,c,d are unit values)
function emit4(a: i32, b: i32, c: i32, d: i32): void {
  const v: u64 = (a as u64) | ((b as u64) << 16) | ((c as u64) << 32) | ((d as u64) << 48);
  store<u64>(patchBase + patchPos * 2, v);
  patchPos += 4;
}
// emit a non-negative decimal integer as UTF-16 units
// (digit scratch lives in the last 16 bytes of SCRATCH, unused otherwise)
function emitInt(n: i32): void {
  const tmp: i32 = SCR_PTR + SCR_CAP - 16;
  let p: i32 = tmp + 12;
  let v: i32 = n;
  if (v == 0) {
    emitU(48);
    return;
  }
  while (v > 0) {
    p--;
    store<u8>(p, 48 + (v % 10));
    v = v / 10;
  }
  while (p < tmp + 12) {
    emitU(load<u8>(p));
    p++;
  }
}

// ---------- JSON scanner (finds old/new string spans in the raw bytes) ----------
let scanP: i32 = 0;
let scanEnd: i32 = 0;
let strStart: i32 = 0; // content span of the last string read
let strEnd: i32 = 0;
let caseOldStart: i32 = 0;
let caseOldEnd: i32 = 0;
let caseNewStart: i32 = 0;
let caseNewEnd: i32 = 0;

function skipWs(): void {
  while (scanP < scanEnd) {
    const b: i32 = load<u8>(scanP);
    if (b == 32 || b == 9 || b == 10 || b == 13) scanP++;
    else break;
  }
}

// scanP must be at a '"'. Leaves scanP just past the closing '"', and sets
// strStart/strEnd to the content span. A backslash-escaped backslash must
// not make the next char look like an escape, so a '\' always skips 2.
function readStringSpan(): void {
  strStart = scanP + 1;
  let p: i32 = strStart;
  const quote: v128 = i8x16.splat(34); // '"'
  const bs: v128 = i8x16.splat(92); // '\'
  while (p < scanEnd) {
    if (p + 16 <= scanEnd) {
      const v: v128 = v128.load(p);
      const m: i32 = i8x16.bitmask(i8x16.eq(v, quote)) | i8x16.bitmask(i8x16.eq(v, bs));
      if (m == 0) { p += 16; continue; }
      const t: i32 = ctz<i32>(m);
      if (load<u8>(p + t) == 34) {
        strEnd = p + t;
        scanP = p + t + 1;
        return;
      }
      p = p + t + 2;
    } else {
      const b: i32 = load<u8>(p);
      if (b == 34) {
        strEnd = p;
        scanP = p + 1;
        return;
      }
      if (b == 92) p += 2;
      else p++;
    }
  }
  strEnd = p;
  scanP = p;
}

function keyIsOld(): bool {
  return strEnd - strStart == 3 && load<u8>(strStart) == 111 && load<u8>(strStart + 1) == 108 && load<u8>(strStart + 2) == 100;
}
function keyIsNew(): bool {
  return strEnd - strStart == 3 && load<u8>(strStart) == 110 && load<u8>(strStart + 1) == 101 && load<u8>(strStart + 2) == 119;
}
function keyIsInput(): bool {
  return strEnd - strStart == 5 && load<u8>(strStart) == 105 && load<u8>(strStart + 1) == 110 && load<u8>(strStart + 2) == 112 && load<u8>(strStart + 3) == 117 && load<u8>(strStart + 4) == 116;
}

// parse a JSON value we do not need, skipping it entirely
function parseGenericValue(): void {
  skipWs();
  const b: i32 = load<u8>(scanP);
  if (b == 34) { readStringSpan(); return; }
  if (b == 123) { parseGenericObject(); return; }
  if (b == 91) { parseGenericArray(); return; }
  // scalar (number / true / false / null): skip to the next delimiter
  while (scanP < scanEnd) {
    const c: i32 = load<u8>(scanP);
    if (c == 44 || c == 125 || c == 93) break;
    scanP++;
  }
}
function parseGenericObject(): void {
  scanP++; // '{'
  while (true) {
    skipWs();
    if (load<u8>(scanP) == 125) { scanP++; return; }
    readStringSpan(); // key
    skipWs();
    scanP++; // ':'
    parseGenericValue();
    skipWs();
    const c: i32 = load<u8>(scanP);
    if (c == 44) { scanP++; continue; }
    if (c == 125) { scanP++; return; }
    return;
  }
}
function parseGenericArray(): void {
  scanP++; // '['
  while (true) {
    skipWs();
    if (load<u8>(scanP) == 93) { scanP++; return; }
    parseGenericValue();
    skipWs();
    const c: i32 = load<u8>(scanP);
    if (c == 44) { scanP++; continue; }
    if (c == 93) { scanP++; return; }
    return;
  }
}

// parse the {"old": "...", "new": "..."} object of one case
function parseInputObject(): void {
  scanP++; // '{'
  while (true) {
    skipWs();
    if (load<u8>(scanP) == 125) { scanP++; return; }
    readStringSpan(); // key
    skipWs();
    scanP++; // ':'
    skipWs();
    if (keyIsOld()) {
      readStringSpan();
      caseOldStart = strStart;
      caseOldEnd = strEnd;
    } else if (keyIsNew()) {
      readStringSpan();
      caseNewStart = strStart;
      caseNewEnd = strEnd;
    } else {
      parseGenericValue();
    }
    skipWs();
    const c: i32 = load<u8>(scanP);
    if (c == 44) { scanP++; continue; }
    if (c == 125) { scanP++; return; }
    return;
  }
}

// parse one {"id": ..., "input": {...}} case object
function parseCaseObject(): void {
  caseOldStart = 0; caseOldEnd = 0; caseNewStart = 0; caseNewEnd = 0;
  scanP++; // '{'
  while (true) {
    skipWs();
    if (load<u8>(scanP) == 125) { scanP++; return; }
    readStringSpan(); // key
    skipWs();
    scanP++; // ':'
    skipWs();
    if (keyIsInput()) parseInputObject();
    else parseGenericValue();
    skipWs();
    const c: i32 = load<u8>(scanP);
    if (c == 44) { scanP++; continue; }
    if (c == 125) { scanP++; return; }
    return;
  }
}

// ---------- decoder: raw JSON string span -> UTF-16 units + line table ----------
// decodes the raw span [rawStart, rawEnd) into DEC starting at decBaseUnits.
// lineTabPtr receives (startUnit, lenUnits) pairs; lineCountPtr the count.
// Returns the unit index just past the decoded text.
function decodeSpan(rawStart: i32, rawEnd: i32, decBaseUnits: i32, lineTabPtr: i32, lineCountPtr: i32): i32 {
  let p: i32 = rawStart;
  let dp: i32 = decBaseUnits;
  let lineStart: i32 = decBaseUnits;
  let lc: i32 = 0;
  const quoteBs: v128 = i8x16.splat(92); // '\'
  const nlV: v128 = i8x16.splat(10); // '\n' (must not be bulk-copied; it ends a line)
  while (p < rawEnd) {
    if (p + 16 <= rawEnd) {
      const v: v128 = v128.load(p);
      const bad: i32 = i8x16.bitmask(v) | i8x16.bitmask(i8x16.eq(v, quoteBs)) | i8x16.bitmask(i8x16.eq(v, nlV));
      if (bad == 0) {
        // 16 plain ASCII bytes -> 16 UTF-16 units, no backslash, no high byte, no newline
        const w0: v128 = v128.load8x8_u(p);
        const w1: v128 = v128.load8x8_u(p + 8);
        v128.store(DEC_PTR + dp * 2, w0);
        v128.store(DEC_PTR + dp * 2 + 16, w1);
        p += 16;
        dp += 16;
        continue;
      }
      // bulk-copy the plain bytes before the first interesting byte, so the
      // scalar step below only ever handles the byte that actually needs it
      let t: i32 = ctz<i32>(bad);
      while (t >= 8) {
        const w: v128 = v128.load8x8_u(p);
        v128.store(DEC_PTR + dp * 2, w);
        p += 8;
        dp += 8;
        t -= 8;
      }
      while (t > 0) {
        store<u16>(DEC_PTR + dp * 2, load<u8>(p));
        p++;
        dp++;
        t--;
      }
    }
    // scalar step: one byte (escape, UTF-8 lead, or a plain byte the fast path refused)
    const b: i32 = load<u8>(p);
    if (b == 92) {
      // escape sequence
      p++;
      const b2: i32 = load<u8>(p);
      if (b2 == 110) { // 'n'
        store<u16>(DEC_PTR + dp * 2, 10);
        dp++;
        store<i32>(lineTabPtr + lc * 8, lineStart - decBaseUnits);
        store<i32>(lineTabPtr + lc * 8 + 4, dp - lineStart);
        lc++;
        lineStart = dp;
        p++;
      } else if (b2 == 114) { store<u16>(DEC_PTR + dp * 2, 13); dp++; p++; } // 'r'
      else if (b2 == 116) { store<u16>(DEC_PTR + dp * 2, 9); dp++; p++; } // 't'
      else if (b2 == 98) { store<u16>(DEC_PTR + dp * 2, 8); dp++; p++; } // 'b'
      else if (b2 == 102) { store<u16>(DEC_PTR + dp * 2, 12); dp++; p++; } // 'f'
      else if (b2 == 34) { store<u16>(DEC_PTR + dp * 2, 34); dp++; p++; } // '"'
      else if (b2 == 92) { store<u16>(DEC_PTR + dp * 2, 92); dp++; p++; } // '\'
      else if (b2 == 47) { store<u16>(DEC_PTR + dp * 2, 47); dp++; p++; } // '/'
      else if (b2 == 117) { // 'u'
        p++;
        let cu: i32 = 0;
        for (let k: i32 = 0; k < 4; k++) {
          cu = (cu << 4) | hexVal(load<u8>(p));
          p++;
        }
        // surrogate pair? only consume a following \uXXXX when it is a low surrogate
        if (cu >= 0xD800 && cu <= 0xDBFF && p + 5 < rawEnd && load<u8>(p) == 92 && load<u8>(p + 1) == 117) {
          let cu2: i32 = 0;
          let ok: bool = true;
          for (let k: i32 = 0; k < 4; k++) {
            const h: i32 = hexVal(load<u8>(p + 2 + k));
            if (h < 0) { ok = false; break; }
            cu2 = (cu2 << 4) | h;
          }
          if (ok && cu2 >= 0xDC00 && cu2 <= 0xDFFF) {
            store<u16>(DEC_PTR + dp * 2, cu);
            dp++;
            store<u16>(DEC_PTR + dp * 2, cu2);
            dp++;
            p += 6;
          } else {
            store<u16>(DEC_PTR + dp * 2, cu);
            dp++;
          }
        } else {
          store<u16>(DEC_PTR + dp * 2, cu);
          dp++;
        }
      } else {
        store<u16>(DEC_PTR + dp * 2, b2);
        dp++;
        p++;
      }
    } else if (b >= 128) {
      // multi-byte UTF-8 in the raw JSON -> one code point (or a surrogate pair)
      if (b >= 0xF0 && p + 3 < rawEnd) {
        let cp: i32 = ((b & 7) << 18) | ((load<u8>(p + 1) & 63) << 12) | ((load<u8>(p + 2) & 63) << 6) | (load<u8>(p + 3) & 63);
        p += 4;
        cp -= 0x10000;
        store<u16>(DEC_PTR + dp * 2, 0xD800 + (cp >> 10));
        dp++;
        store<u16>(DEC_PTR + dp * 2, 0xDC00 + (cp & 0x3FF));
        dp++;
      } else if (b >= 0xE0 && p + 2 < rawEnd) {
        const cp: i32 = ((b & 15) << 12) | ((load<u8>(p + 1) & 63) << 6) | (load<u8>(p + 2) & 63);
        p += 3;
        store<u16>(DEC_PTR + dp * 2, cp);
        dp++;
      } else if (b >= 0xC0 && p + 1 < rawEnd) {
        const cp: i32 = ((b & 31) << 6) | (load<u8>(p + 1) & 63);
        p += 2;
        store<u16>(DEC_PTR + dp * 2, cp);
        dp++;
      } else {
        store<u16>(DEC_PTR + dp * 2, b);
        dp++;
        p++;
      }
    } else {
      store<u16>(DEC_PTR + dp * 2, b);
      dp++;
      if (b == 10) {
        store<i32>(lineTabPtr + lc * 8, lineStart - decBaseUnits);
        store<i32>(lineTabPtr + lc * 8 + 4, dp - lineStart);
        lc++;
        lineStart = dp;
      }
      p++;
    }
  }
  // bare last line (no trailing newline)
  if (dp > lineStart) {
    store<i32>(lineTabPtr + lc * 8, lineStart - decBaseUnits);
    store<i32>(lineTabPtr + lc * 8 + 4, dp - lineStart);
    lc++;
  }
  store<i32>(lineCountPtr, lc);
  return dp;
}

// ---------- line split for already-decoded UTF-16 (solveCase path) ----------
// splits the units at [u16Ptr, u16Ptr + lenUnits) into (startUnit, lenUnits)
// pairs at lineTabPtr; returns the line count.
function splitLines(u16Ptr: i32, lenUnits: i32, lineTabPtr: i32): i32 {
  let p: i32 = u16Ptr; // byte address
  const end: i32 = u16Ptr + lenUnits * 2;
  let lineStart: i32 = u16Ptr; // byte address
  let lc: i32 = 0;
  const nlV: v128 = i16x8.splat(10);
  while (p < end) {
    if (p + 16 <= end) {
      const v: v128 = v128.load(p);
      let m: i32 = i16x8.bitmask(i16x8.eq(v, nlV));
      if (m == 0) { p += 16; continue; }
      while (m != 0) {
        const t: i32 = ctz<i32>(m); // lane of the next newline
        const nlByte: i32 = p + t * 2; // byte address of the '\n' unit
        store<i32>(lineTabPtr + lc * 8, (lineStart - u16Ptr) / 2);
        store<i32>(lineTabPtr + lc * 8 + 4, (nlByte + 2 - lineStart) / 2);
        lc++;
        lineStart = nlByte + 2;
        m &= m - 1;
      }
      p += 16;
    } else {
      if (load<u16>(p) == 10) {
        store<i32>(lineTabPtr + lc * 8, (lineStart - u16Ptr) / 2);
        store<i32>(lineTabPtr + lc * 8 + 4, (p + 2 - lineStart) / 2);
        lc++;
        lineStart = p + 2;
      }
      p += 2;
    }
  }
  if (lineStart < end) {
    store<i32>(lineTabPtr + lc * 8, (lineStart - u16Ptr) / 2);
    store<i32>(lineTabPtr + lc * 8 + 4, (end - lineStart) / 2);
    lc++;
  }
  return lc;
}

// ---------- line interning (hash + open addressing, in-place span compare) ----------
// compares len units at absolute byte addresses a and b
function unitsEqual(a: i32, b: i32, len: i32): bool {
  let n: i32 = len;
  while (n >= 4) {
    if (load<u64>(a) != load<u64>(b)) return false;
    a += 8;
    b += 8;
    n -= 4;
  }
  while (n > 0) {
    if (load<u16>(a) != load<u16>(b)) return false;
    a += 2;
    b += 2;
    n--;
  }
  return true;
}

// Sampled hash over a line's units: first word, middle word, last word and
// length, mixed with a splitmix finalizer. The hash only picks candidate
// slots; unitsEqual verifies equality, so sampling cannot change results,
// only (rarely) the probe length.
function hashLine(baseByte: i32, start: i32, len: i32): u64 {
  const p: i32 = baseByte + start * 2;
  const nbytes: i32 = len * 2;
  if (nbytes < 8) {
    // short line: fold only its own bytes (never read past the line, or
    // the same content would hash differently at different positions)
    let h: u64 = len as u64;
    let q: i32 = p;
    const end: i32 = p + nbytes;
    while (q < end) {
      h ^= load<u8>(q) as u64;
      h *= 0x9E3779B97F4A7C15;
      q++;
    }
    h ^= h >> 29;
    return h;
  }
  let h: u64 = load<u64>(p) ^ (len as u64);
  if (nbytes >= 16) {
    h ^= load<u64>(p + ((nbytes / 2) & ~7));
    h ^= load<u64>(p + nbytes - 8);
  } else if (nbytes > 8) {
    h ^= load<u64>(p + nbytes - 8);
  }
  h *= 0x9E3779B97F4A7C15;
  h ^= h >> 29;
  h *= 0x9E3779B97F4A7C15;
  h ^= h >> 32;
  return h;
}

// intern every line of one text; idArrPtr gets the id per line; counts the
// ids in cntOld (isOld) or cntNew. textBaseBytePtr is the text's byte base.
function internText(lineTabPtr: i32, lineCount: i32, textBaseBytePtr: i32, idArrPtr: i32, isOld: bool): void {
  const ht: i32 = htPtr();
  const repOff: i32 = repOffPtr();
  const repLen: i32 = repLenPtr();
  const cntOld: i32 = cntOldPtr();
  const cntNew: i32 = cntNewPtr();
  for (let i: i32 = 0; i < lineCount; i++) {
    const start: i32 = load<i32>(lineTabPtr + i * 8);
    const len: i32 = load<i32>(lineTabPtr + i * 8 + 4);
    const h: u64 = hashLine(textBaseBytePtr, start, len);
    let slot: i32 = (h as i32) & HT_MASK;
    let id: i32 = -1;
    while (true) {
      const sptr: i32 = ht + slot * 16;
      if (load<i32>(sptr + 12) != curGen) {
        // empty slot: claim it with a fresh id
        id = nIds;
        nIds++;
        store<i64>(sptr, h);
        store<i32>(sptr + 8, id);
        store<i32>(sptr + 12, curGen);
        store<i32>(repOff + id * 4, textBaseBytePtr + start * 2); // absolute byte address
        store<i32>(repLen + id * 4, len);
        store<i32>(cntOld + id * 4, 0);
        store<i32>(cntNew + id * 4, 0);
        break;
      }
      if (load<u64>(sptr) == h) {
        const rid: i32 = load<i32>(sptr + 8);
        if (load<i32>(repLen + rid * 4) == len && unitsEqual(load<i32>(repOff + rid * 4), textBaseBytePtr + start * 2, len)) {
          id = rid;
          break;
        }
      }
      slot = (slot + 1) & HT_MASK;
    }
    store<i32>(idArrPtr + i * 4, id);
    if (isOld) store<i32>(cntOld + id * 4, load<i32>(cntOld + id * 4) + 1);
    else store<i32>(cntNew + id * 4, load<i32>(cntNew + id * 4) + 1);
  }
}

// for unique old lines, record their old line index (absolute)
function buildOldPos(): void {
  const idOld: i32 = idOldPtr();
  const cntOld: i32 = cntOldPtr();
  const oldPos: i32 = oldPosPtr();
  for (let i: i32 = 0; i < oldLines; i++) {
    const id: i32 = load<i32>(idOld + i * 4);
    if (load<i32>(cntOld + id * 4) == 1) store<i32>(oldPos + id * 4, i);
  }
}

// ---------- unique-line LIS (new order) + run filter ----------
// p = common prefix length, s = common suffix length. The middle is
// old[p..oldLines-s) x new[p..newLines-s). Returns the kept anchor count;
// kept anchors (old,new) land in ancI/ancJ in increasing order.
function buildAnchors(p: i32, s: i32): i32 {
  const idOld: i32 = idOldPtr();
  const idNew: i32 = idNewPtr();
  const cntOld: i32 = cntOldPtr();
  const cntNew: i32 = cntNewPtr();
  const oldPos: i32 = oldPosPtr();
  const seqI: i32 = seqIPtr();
  const seqJ: i32 = seqJPtr();
  const parent: i32 = parentPtr();
  const tailsVal: i32 = tailsValPtr();
  const tailsIdx: i32 = tailsIdxPtr();
  const ancI: i32 = ancIPtr();
  const ancJ: i32 = ancJPtr();
  // 1. sequence of old indices in new order (unique lines only)
  let seqLen: i32 = 0;
  const mMid: i32 = newLines - s;
  for (let j: i32 = p; j < mMid; j++) {
    const id: i32 = load<i32>(idNew + j * 4);
    if (load<i32>(cntOld + id * 4) == 1 && load<i32>(cntNew + id * 4) == 1) {
      store<i32>(seqI + seqLen * 4, load<i32>(oldPos + id * 4));
      store<i32>(seqJ + seqLen * 4, j);
      seqLen++;
    }
  }
  // 2. patience LIS (strictly increasing: lower_bound)
  let tailsLen: i32 = 0;
  for (let k: i32 = 0; k < seqLen; k++) {
    const x: i32 = load<i32>(seqI + k * 4);
    let lo: i32 = 0;
    let hi: i32 = tailsLen;
    while (lo < hi) {
      const mid: i32 = (lo + hi) >> 1;
      if (load<i32>(tailsVal + mid * 4) < x) lo = mid + 1;
      else hi = mid;
    }
    const pos: i32 = lo;
    if (pos == tailsLen) tailsLen++;
    store<i32>(tailsVal + pos * 4, x);
    store<i32>(tailsIdx + pos * 4, k);
    store<i32>(parent + k * 4, pos > 0 ? load<i32>(tailsIdx + (pos - 1) * 4) : -1);
  }
  // 3. reconstruct the LIS into ancI/ancJ in forward order
  let ancLen: i32 = 0;
  if (tailsLen > 0) {
    let k: i32 = load<i32>(tailsIdx + (tailsLen - 1) * 4);
    while (k != -1) {
      store<i32>(ancI + ancLen * 4, load<i32>(seqI + k * 4));
      store<i32>(ancJ + ancLen * 4, load<i32>(seqJ + k * 4));
      ancLen++;
      k = load<i32>(parent + k * 4);
    }
    let a: i32 = 0;
    let b: i32 = ancLen - 1;
    while (a < b) {
      const ti: i32 = load<i32>(ancI + a * 4);
      const tj: i32 = load<i32>(ancJ + a * 4);
      store<i32>(ancI + a * 4, load<i32>(ancI + b * 4));
      store<i32>(ancJ + a * 4, load<i32>(ancJ + b * 4));
      store<i32>(ancI + b * 4, ti);
      store<i32>(ancJ + b * 4, tj);
      a++;
      b--;
    }
  }
  // 4. keep only anchors inside a run of >= RUN_MIN consecutive anchors
  // (in-place compaction: kept <= t always, so no unread entry is clobbered)
  let kept: i32 = 0;
  let t: i32 = 0;
  while (t < ancLen) {
    let u: i32 = t;
    while (u + 1 < ancLen && load<i32>(ancI + (u + 1) * 4) == load<i32>(ancI + u * 4) + 1 && load<i32>(ancJ + (u + 1) * 4) == load<i32>(ancJ + u * 4) + 1) u++;
    if (u - t + 1 >= RUN_MIN) {
      for (let w: i32 = t; w <= u; w++) {
        store<i32>(ancI + kept * 4, load<i32>(ancI + w * 4));
        store<i32>(ancJ + kept * 4, load<i32>(ancJ + w * 4));
        kept++;
      }
    }
    t = u + 1;
  }
  return kept;
}

// ---------- exact Myers per gap (deletion-on-tie) ----------
function appendOp(op: i32): void {
  store<u8>(opsPtr() + opsLen, op);
  opsLen++;
}

// grow memory so the trace for a gap of maxd fits at TRC_PTR
function ensureTrace(maxd: i32): void {
  const d: i64 = (maxd + 1) as i64;
  const need: i64 = (TRC_PTR as i64) + d * d * 4;
  const curBytes: i64 = (memory.size() as i64) * 65536;
  if (need > curBytes) {
    const extra: i64 = need - curBytes;
    const pages: i32 = ((extra + 65535) / 65536) as i32;
    memory.grow(pages);
  }
}

// trace value for the D-1 pass at diagonal k (0 when k is out of range,
// matching the never-written entries of the reference implementation)
function traceVal(dm1: i32, k: i32): i32 {
  if (k < -dm1 || k > dm1) return 0;
  return load<i32>(TRC_PTR + (dm1 * dm1 + (k + dm1)) * 4);
}

// gap: old lines [aOld, aOld+n) vs new lines [aNew, aNew+m); appends ops.
function myersGap(aOld: i32, aNew: i32, n: i32, m: i32): void {
  if (n == 0 && m == 0) return;
  if (n == 0) {
    for (let j: i32 = 0; j < m; j++) appendOp(OP_INS);
    return;
  }
  if (m == 0) {
    for (let i: i32 = 0; i < n; i++) appendOp(OP_DEL);
    return;
  }
  const maxd: i32 = n + m;
  const V: i32 = vPtr();
  const idOld: i32 = idOldPtr();
  const idNew: i32 = idNewPtr();
  ensureTrace(maxd);
  store<i32>(V + (1 + maxd) * 4, 0);
  let foundD: i32 = -1;
  for (let D: i32 = 0; D <= maxd; D++) {
    for (let k: i32 = -D; k <= D; k += 2) {
      let x: i32;
      if (k == -D) x = load<i32>(V + (k + 1 + maxd) * 4);
      else if (k == D) x = load<i32>(V + (k - 1 + maxd) * 4) + 1;
      else {
        const a: i32 = load<i32>(V + (k - 1 + maxd) * 4) + 1;
        const b: i32 = load<i32>(V + (k + 1 + maxd) * 4);
        x = a >= b ? a : b; // deletion wins the tie
      }
      let y: i32 = x - k;
      while (x < n && y < m && load<i32>(idOld + (aOld + x) * 4) == load<i32>(idNew + (aNew + y) * 4)) { x++; y++; }
      store<i32>(V + (k + maxd) * 4, x);
      if (x >= n && y >= m) { foundD = D; break; }
    }
    // compact trace for this D: V[k] for k in [-D, D]
    memory.copy(TRC_PTR + D * D * 4, V + (maxd - D) * 4, (2 * D + 1) * 4);
    if (foundD != -1) break;
  }
  // backtrack into tmpOps (reversed), then append forward
  const tmp: i32 = tmpPtr();
  let tmpLen: i32 = 0;
  let x: i32 = n;
  let y: i32 = m;
  for (let D: i32 = foundD; D >= 1; D--) {
    const dm1: i32 = D - 1;
    const k: i32 = x - y;
    let ins: bool;
    if (k == -D) ins = true;
    else if (k == D) ins = false;
    else ins = traceVal(dm1, k - 1) + 1 < traceVal(dm1, k + 1);
    if (ins) {
      const prevX: i32 = traceVal(dm1, k + 1);
      const prevY: i32 = prevX - (k + 1);
      const sx: i32 = prevX;
      const sy: i32 = prevX - k;
      while (x > sx && y > sy) { store<u8>(tmp + tmpLen, OP_EQ); tmpLen++; x--; y--; }
      store<u8>(tmp + tmpLen, OP_INS); tmpLen++;
      x = prevX; y = prevY;
    } else {
      const prevX: i32 = traceVal(dm1, k - 1);
      const prevY: i32 = prevX - (k - 1);
      const sx: i32 = prevX + 1;
      const sy: i32 = prevX + 1 - k;
      while (x > sx && y > sy) { store<u8>(tmp + tmpLen, OP_EQ); tmpLen++; x--; y--; }
      store<u8>(tmp + tmpLen, OP_DEL); tmpLen++;
      x = prevX; y = prevY;
    }
  }
  while (x > 0 && y > 0) { store<u8>(tmp + tmpLen, OP_EQ); tmpLen++; x--; y--; }
  for (let i: i32 = tmpLen - 1; i >= 0; i--) appendOp(load<u8>(tmp + i));
}

// ---------- assemble the op list for one case ----------
function diffCase(): void {
  const idOld: i32 = idOldPtr();
  const idNew: i32 = idNewPtr();
  let p: i32 = 0;
  while (p < oldLines && p < newLines && load<i32>(idOld + p * 4) == load<i32>(idNew + p * 4)) p++;
  let s: i32 = 0;
  while (s < oldLines - p && s < newLines - p && load<i32>(idOld + (oldLines - 1 - s) * 4) == load<i32>(idNew + (newLines - 1 - s) * 4)) s++;
  opsLen = 0;
  for (let i: i32 = 0; i < p; i++) appendOp(OP_EQ);
  const nMid: i32 = oldLines - s;
  const mMid: i32 = newLines - s;
  if (p < nMid || p < mMid) {
    const kept: i32 = buildAnchors(p, s);
    const ancI: i32 = ancIPtr();
    const ancJ: i32 = ancJPtr();
    let prevI: i32 = p - 1;
    let prevJ: i32 = p - 1;
    for (let t: i32 = 0; t <= kept; t++) {
      let curI: i32;
      let curJ: i32;
      let isReal: bool;
      if (t < kept) {
        curI = load<i32>(ancI + t * 4);
        curJ = load<i32>(ancJ + t * 4);
        isReal = true;
      } else {
        curI = nMid;
        curJ = mMid;
        isReal = false;
      }
      myersGap(prevI + 1, prevJ + 1, curI - prevI - 1, curJ - prevJ - 1);
      if (isReal) appendOp(OP_EQ);
      prevI = curI;
      prevJ = curJ;
    }
  }
  for (let i: i32 = 0; i < s; i++) appendOp(OP_EQ);
}

// ---------- renderer ----------
let oldBaseByte: i32 = 0;
let newBaseByte: i32 = 0;

function hexDigit(v: i32): i32 {
  return v < 10 ? 48 + v : 87 + v;
}

// emit one patch line: marker + line content (+ '\n' and '%' when the line
// is a bare last line of its text)
function emitLine(marker: i32, baseByte: i32, tabPtr: i32, lineIdx: i32, isLast: bool): void {
  emitU(marker);
  const start: i32 = load<i32>(tabPtr + lineIdx * 8);
  const len: i32 = load<i32>(tabPtr + lineIdx * 8 + 4);
  memory.copy(patchBase + patchPos * 2, baseByte + start * 2, len * 2);
  patchPos += len;
  let endsNL: bool = false;
  if (len > 0 && load<u16>(baseByte + (start + len - 1) * 2) == 10) endsNL = true;
  if (!endsNL) {
    emitU(10);
    if (isLast) { emitU(37); emitU(10); }
  }
}

// renders the op list into a patch (UTF-16 units) at patchBaseArg;
// returns the patch length in units
function renderCase(patchBaseArg: i32): i32 {
  patchBase = patchBaseArg;
  patchPos = 0;
  const ops: i32 = opsPtr();
  const oldTab: i32 = oldTabPtr();
  const newTab: i32 = newTabPtr();
  let D: i32 = 0;
  let I: i32 = 0;
  for (let i: i32 = 0; i < opsLen; i++) {
    const op: i32 = load<u8>(ops + i);
    if (op == OP_DEL) D++;
    else if (op == OP_INS) I++;
  }
  // change runs, merged when <= 6 kept ops apart
  hunkCount = 0;
  let i: i32 = 0;
  while (i < opsLen) {
    if (load<u8>(ops + i) == OP_EQ) { i++; continue; }
    let j: i32 = i;
    while (j < opsLen && load<u8>(ops + j) != OP_EQ) j++;
    if (hunkCount > 0 && i - load<i32>(hunkPtr() + (hunkCount - 1) * 8 + 4) <= 6) {
      store<i32>(hunkPtr() + (hunkCount - 1) * 8 + 4, j);
    } else {
      store<i32>(hunkPtr() + hunkCount * 8, i);
      store<i32>(hunkPtr() + hunkCount * 8 + 4, j);
      hunkCount++;
    }
    i = j;
  }
  // header: makefun-diff/1 old=N new=M hunks=H deleted=D inserted=I\n
  emit4(109, 97, 107, 101); // make
  emit4(102, 117, 110, 45); // fun-
  emit4(100, 105, 102, 102); // diff
  emit4(47, 49, 32, 111); // /1 o
  emitU(108); emitU(100); emitU(61); // ld=
  emitInt(oldLines);
  emitU(32); emitU(110); emitU(101); emitU(119); emitU(61); // " new="
  emitInt(newLines);
  emitU(32); emitU(104); emitU(117); emitU(110); emitU(107); emitU(115); emitU(61); // " hunks="
  emitInt(hunkCount);
  emitU(32); emitU(100); emitU(101); emitU(108); emitU(101); emitU(116); emitU(101); emitU(100); emitU(61); // " deleted="
  emitInt(D);
  emitU(32); emitU(105); emitU(110); emitU(115); emitU(101); emitU(114); emitU(116); emitU(101); emitU(100); emitU(61); // " inserted="
  emitInt(I);
  emitU(10);
  // hunks, walking the ops once
  let opIdx: i32 = 0;
  let oldIdx: i32 = 0;
  let newIdx: i32 = 0;
  for (let h: i32 = 0; h < hunkCount; h++) {
    const a: i32 = load<i32>(hunkPtr() + h * 8);
    const b: i32 = load<i32>(hunkPtr() + h * 8 + 4);
    const cs: i32 = a - 3 < 0 ? 0 : a - 3;
    const ce: i32 = b + 3 > opsLen ? opsLen : b + 3;
    // skip to the hunk's context start (kept ops only)
    while (opIdx < cs) {
      oldIdx++;
      newIdx++;
      opIdx++;
    }
    const oldBefore: i32 = oldIdx;
    const newBefore: i32 = newIdx;
    // count old/new lines covered by this hunk
    let ol: i32 = 0;
    let nl: i32 = 0;
    for (let k: i32 = cs; k < ce; k++) {
      const op: i32 = load<u8>(ops + k);
      if (op == OP_EQ) { ol++; nl++; }
      else if (op == OP_DEL) ol++;
      else nl++;
    }
    // hunk header: @ os ol ns nl\n
    emitU(64); emitU(32);
    emitInt(oldBefore + 1);
    emitU(32);
    emitInt(ol);
    emitU(32);
    emitInt(newBefore + 1);
    emitU(32);
    emitInt(nl);
    emitU(10);
    // emit the hunk's lines: deletions before insertions within each run
    let k: i32 = cs;
    while (k < ce) {
      const op: i32 = load<u8>(ops + k);
      if (op == OP_EQ) {
        emitLine(61, oldBaseByte, oldTab, oldIdx, oldIdx == oldLines - 1);
        oldIdx++;
        newIdx++;
        k++;
      } else {
        let j: i32 = k;
        while (j < ce && load<u8>(ops + j) != OP_EQ) j++;
        for (let q: i32 = k; q < j; q++) {
          if (load<u8>(ops + q) == OP_DEL) {
            emitLine(45, oldBaseByte, oldTab, oldIdx, oldIdx == oldLines - 1);
            oldIdx++;
          }
        }
        for (let q: i32 = k; q < j; q++) {
          if (load<u8>(ops + q) == OP_INS) {
            emitLine(43, newBaseByte, newTab, newIdx, newIdx == newLines - 1);
            newIdx++;
          }
        }
        k = j;
      }
    }
    opIdx = ce;
  }
  return patchPos;
}

// ---------- JSON encoder: patch (UTF-16) -> answers.json bytes at OUT_PTR ----------
// appends the patch at patchBase (patchPos units) as one JSON string
function appendAnswer(): void {
  store<u8>(OUT_PTR + outPos, 34); outPos++; // '"'
  const splat32: v128 = i16x8.splat(32);
  const splat126: v128 = i16x8.splat(126);
  const splat34: v128 = i16x8.splat(34);
  const splat92: v128 = i16x8.splat(92);
  const zeroVec: v128 = i16x8.splat(0);
  let i: i32 = 0;
  while (i < patchPos) {
    if (i + 8 <= patchPos) {
      const v: v128 = v128.load(patchBase + i * 2);
      const plain: v128 = v128.and(
        v128.and(i16x8.ge_s(v, splat32), i16x8.le_s(v, splat126)),
        v128.and(i16x8.ne(v, splat34), i16x8.ne(v, splat92))
      );
      const m: i32 = i16x8.bitmask(plain);
      if (m == 0xFF) {
        // 8 plain ASCII units -> 8 bytes, no escaping needed
        const n: v128 = i8x16.narrow_i16x8_s(v, zeroVec);
        store<u64>(OUT_PTR + outPos, i64x2.extract_lane(n, 0) as u64);
        outPos += 8;
        i += 8;
        continue;
      }
      // bulk-copy the plain units before the first non-plain lane, so the
      // next SIMD check never re-scans an overlapping window; when the
      // first lane is already non-plain, fall through to the scalar path
      const t: i32 = ctz<i32>((~m) & 0xFF);
      if (t > 0) {
        for (let k: i32 = 0; k < t; k++) {
          store<u8>(OUT_PTR + outPos, load<u16>(patchBase + (i + k) * 2));
          outPos++;
        }
        i += t;
        continue;
      }
    }
    const u: i32 = load<u16>(patchBase + i * 2);
    if (u == 34) {
      store<u8>(OUT_PTR + outPos, 92); outPos++;
      store<u8>(OUT_PTR + outPos, 34); outPos++;
      i++;
    } else if (u == 92) {
      store<u8>(OUT_PTR + outPos, 92); outPos++;
      store<u8>(OUT_PTR + outPos, 92); outPos++;
      i++;
    } else if (u == 10) {
      store<u8>(OUT_PTR + outPos, 92); outPos++;
      store<u8>(OUT_PTR + outPos, 110); outPos++;
      i++;
    } else if (u == 13) {
      store<u8>(OUT_PTR + outPos, 92); outPos++;
      store<u8>(OUT_PTR + outPos, 114); outPos++;
      i++;
    } else if (u == 9) {
      store<u8>(OUT_PTR + outPos, 92); outPos++;
      store<u8>(OUT_PTR + outPos, 116); outPos++;
      i++;
    } else if (u == 8) {
      store<u8>(OUT_PTR + outPos, 92); outPos++;
      store<u8>(OUT_PTR + outPos, 98); outPos++;
      i++;
    } else if (u == 12) {
      store<u8>(OUT_PTR + outPos, 92); outPos++;
      store<u8>(OUT_PTR + outPos, 102); outPos++;
      i++;
    } else if (u < 32) {
      store<u8>(OUT_PTR + outPos, 92); outPos++;
      store<u8>(OUT_PTR + outPos, 117); outPos++;
      store<u8>(OUT_PTR + outPos, 48); outPos++;
      store<u8>(OUT_PTR + outPos, 48); outPos++;
      store<u8>(OUT_PTR + outPos, hexDigit((u >> 4) & 15)); outPos++;
      store<u8>(OUT_PTR + outPos, hexDigit(u & 15)); outPos++;
      i++;
    } else if (u >= 0xD800 && u <= 0xDBFF) {
      if (i + 1 < patchPos) {
        const u2: i32 = load<u16>(patchBase + (i + 1) * 2);
        if (u2 >= 0xDC00 && u2 <= 0xDFFF) {
          const cp: i32 = 0x10000 + ((u - 0xD800) << 10) + (u2 - 0xDC00);
          store<u8>(OUT_PTR + outPos, 0xF0 | (cp >> 18)); outPos++;
          store<u8>(OUT_PTR + outPos, 0x80 | ((cp >> 12) & 63)); outPos++;
          store<u8>(OUT_PTR + outPos, 0x80 | ((cp >> 6) & 63)); outPos++;
          store<u8>(OUT_PTR + outPos, 0x80 | (cp & 63)); outPos++;
          i += 2;
          continue;
        }
      }
      // lone high surrogate -> \udXXX
      store<u8>(OUT_PTR + outPos, 92); outPos++;
      store<u8>(OUT_PTR + outPos, 117); outPos++;
      store<u8>(OUT_PTR + outPos, 100); outPos++;
      store<u8>(OUT_PTR + outPos, hexDigit((u >> 8) & 15)); outPos++;
      store<u8>(OUT_PTR + outPos, hexDigit((u >> 4) & 15)); outPos++;
      store<u8>(OUT_PTR + outPos, hexDigit(u & 15)); outPos++;
      i++;
    } else if (u >= 0xDC00 && u <= 0xDFFF) {
      // lone low surrogate -> \udXXX
      store<u8>(OUT_PTR + outPos, 92); outPos++;
      store<u8>(OUT_PTR + outPos, 117); outPos++;
      store<u8>(OUT_PTR + outPos, 100); outPos++;
      store<u8>(OUT_PTR + outPos, hexDigit((u >> 8) & 15)); outPos++;
      store<u8>(OUT_PTR + outPos, hexDigit((u >> 4) & 15)); outPos++;
      store<u8>(OUT_PTR + outPos, hexDigit(u & 15)); outPos++;
      i++;
    } else if (u < 128) {
      store<u8>(OUT_PTR + outPos, u); outPos++;
      i++;
    } else if (u < 2048) {
      store<u8>(OUT_PTR + outPos, 0xC0 | (u >> 6)); outPos++;
      store<u8>(OUT_PTR + outPos, 0x80 | (u & 63)); outPos++;
      i++;
    } else {
      store<u8>(OUT_PTR + outPos, 0xE0 | (u >> 12)); outPos++;
      store<u8>(OUT_PTR + outPos, 0x80 | ((u >> 6) & 63)); outPos++;
      store<u8>(OUT_PTR + outPos, 0x80 | (u & 63)); outPos++;
      i++;
    }
  }
  store<u8>(OUT_PTR + outPos, 34); outPos++; // '"'
}

// ---------- one case, raw-JSON path ----------
function processOneCase(): i32 {
  curGen++;
  nIds = 0;
  const lcOld: i32 = SCR_PTR + SCR_CAP - 64;
  const lcNew: i32 = SCR_PTR + SCR_CAP - 60;
  const oldEnd: i32 = decodeSpan(caseOldStart, caseOldEnd, 0, oldTabPtr(), lcOld);
  oldLines = load<i32>(lcOld);
  const newEnd: i32 = decodeSpan(caseNewStart, caseNewEnd, oldEnd, newTabPtr(), lcNew);
  newLines = load<i32>(lcNew);
  if (oldLines > MAXL || newLines > MAXL) return -1;
  if (oldEnd > DEC_CAP_UNITS || newEnd > DEC_CAP_UNITS) return -1;
  oldBaseByte = DEC_PTR;
  newBaseByte = DEC_PTR + oldEnd * 2;
  internText(oldTabPtr(), oldLines, oldBaseByte, idOldPtr(), true);
  internText(newTabPtr(), newLines, newBaseByte, idNewPtr(), false);
  if (nIds > ID_CAP) return -1;
  buildOldPos();
  diffCase();
  renderCase(patchPtr());
  appendAnswer();
  return 0;
}

// ---------- entry points ----------
// raw path: the input file (inLen bytes) already sits at RAW_PTR; the
// answers.json bytes land at OUT_PTR; returns the answer byte length.
export function solveRaw(inLen: i32): i32 {
  if (inLen > RAW_CAP) return -1;
  scanP = RAW_PTR;
  scanEnd = RAW_PTR + inLen;
  outPos = 0;
  store<u8>(OUT_PTR + outPos, 91); outPos++; // '['
  skipWs();
  if (scanP >= scanEnd || load<u8>(scanP) != 91) return -1;
  scanP++;
  let first: bool = true;
  while (true) {
    skipWs();
    if (scanP >= scanEnd) return -1;
    if (load<u8>(scanP) == 93) { scanP++; break; }
    parseCaseObject();
    if (!first) { store<u8>(OUT_PTR + outPos, 44); outPos++; }
    first = false;
    if (processOneCase() != 0) return -1;
    skipWs();
    if (scanP >= scanEnd) return -1;
    const c: i32 = load<u8>(scanP);
    if (c == 44) { scanP++; continue; }
    if (c == 93) { scanP++; break; }
    return -1;
  }
  store<u8>(OUT_PTR + outPos, 93); outPos++; // ']'
  return outPos;
}

// string path (for run()): old/new are UTF-16 units at oldPtr/newPtr;
// the patch (UTF-16 units) lands at outPtr; returns its length in units.
export function solveCase(oldPtr: i32, oldLenUnits: i32, newPtr: i32, newLenUnits: i32, outPtr: i32): i32 {
  curGen++;
  nIds = 0;
  oldLines = splitLines(oldPtr, oldLenUnits, oldTabPtr());
  newLines = splitLines(newPtr, newLenUnits, newTabPtr());
  if (oldLines > MAXL || newLines > MAXL) return -1;
  oldBaseByte = oldPtr;
  newBaseByte = newPtr;
  internText(oldTabPtr(), oldLines, oldBaseByte, idOldPtr(), true);
  internText(newTabPtr(), newLines, newBaseByte, idNewPtr(), false);
  if (nIds > ID_CAP) return -1;
  buildOldPos();
  diffCase();
  return renderCase(outPtr);
}

export function rawPtr(): i32 { return RAW_PTR; }
export function decPtr(): i32 { return DEC_PTR; }
export function outPtr(): i32 { return OUT_PTR; }
