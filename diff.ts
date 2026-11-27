// diff.ts — exact global Myers diff core for makefun-diff/1.0.0.
// Written fresh from the prose brief (BRIEF-R3.md). No anchors, no split:
// the whole case is solved by one global Myers forward search with the
// deletion-on-tie rule, and a mirror backtrack that reproduces the oracle's
// script byte for byte. The module scans raw JSON bytes (never JSON.parse),
// decodes the two texts of each case into UTF-16, diffs on 64-bit line
// hashes (verified by a full line compare whenever hashes agree), and
// renders the patch straight into an answers.json byte buffer.
//
// Memory layout (fixed regions, absolute addresses, no heap use):
//   header   0 .. 64 KiB          (unused scratch)
//   input    64 KiB .. +16 MiB    (raw cases.json bytes, copied in by JS)
//   old text 16 MiB+64 KiB .. +4 MiB (decoded UTF-16 units)
//   new text .. +4 MiB
//   old lines .. +1 MiB  (per line: start u32, len u32, hash u64)
//   new lines .. +1 MiB
//   trace    .. +64 MiB  (u16 triangular Myers trace, row d at d*d)
//   ops      .. +4 MiB   (edit ops + kept pairs scratch)
//   output   .. +16 MiB  (answers.json bytes)
//
// AssemblyScript 0.28.20, --runtime stub --enable simd --optimize.
// Build: asc diff.ts --outFile diff.wasm --runtime stub --enable simd
//        --optimize --initialMemory 1728 --maximumMemory 8192

const INPUT_PTR: usize = 65536;
const INPUT_CAP: usize = 16777216;
const OLD_DEC: usize = INPUT_PTR + INPUT_CAP;
const OLD_DEC_CAP: usize = 4194304; // bytes of UTF-16 units (2,097,152 units)
const NEW_DEC: usize = OLD_DEC + OLD_DEC_CAP;
const NEW_DEC_CAP: usize = 4194304;
const OLD_TAB: usize = NEW_DEC + NEW_DEC_CAP;
const OLD_TAB_CAP: usize = 1048576; // 65,536 lines * 16 bytes
const NEW_TAB: usize = OLD_TAB + OLD_TAB_CAP;
const NEW_TAB_CAP: usize = 1048576;
const TRACE_PTR: usize = NEW_TAB + NEW_TAB_CAP;
const TRACE_CAP_BYTES: usize = 67108864; // 33,554,432 u16 entries, D up to ~5792
const OPS_PTR: usize = TRACE_PTR + TRACE_CAP_BYTES;
const OPS_CAP: usize = 4194304;
const OUT_PTR: usize = OPS_PTR + OPS_CAP;
const OUT_CAP: usize = 16777216;

const SENTINEL: u32 = 65535;
const FNV_OFF: i64 = -3750763034362895579;
const FNV_PRIME: i64 = 1099511628211;

// ---- mutable run state ----
let inPtr: usize = 0;
let inLen: i32 = 0;
let inPos: i32 = 0;
let outPos: usize = 0;
let outLen: i32 = 0;
let traceCapD: i32 = 0; // largest d whose trace row fits in TRACE_CAP_BYTES

// per-case decoded text state (capture target 1 = old, 2 = new)
let capTarget: i32 = 0;
let decPtr: usize = 0; // decoded units buffer (u16 per unit)
let decUnits: i32 = 0; // units written
let tabPtr: usize = 0; // line table
let tabCount: i32 = 0; // lines recorded
let lineStart: i32 = 0; // unit index where the current line starts
let lineHash: i64 = 0; // running FNV-1a over the current line's units

let oldCount: i32 = 0;
let newCount: i32 = 0;

// ---- small helpers ----
function emitByte(b: u32): void {
  store<u8>(outPos, b);
  outPos += 1;
}

function emitAsciiDigit(d: i32): void {
  emitByte(48 + <u32>d);
}

// Write a non-negative i32 as decimal ASCII.
function emitInt(v: i32): void {
  if (v == 0) { emitByte(48); return; }
  let tmp: i32 = v;
  let digits: i32 = 0;
  while (tmp > 0) { tmp = tmp / 10; digits += 1; }
  let div: i32 = 1;
  for (let i: i32 = 1; i < digits; i++) div *= 10;
  tmp = v;
  while (div > 0) {
    emitAsciiDigit(tmp / div);
    tmp = tmp % div;
    div = div / 10;
  }
}

// Emit one UTF-16 code unit of patch text as JSON string content:
// short escapes for control characters, \u00XX otherwise, lone surrogates
// as \uXXXX, everything else as UTF-8.
function emitJsonUnit(u: u32): void {
  if (u == 34) { emitByte(92); emitByte(34); return; } // \"
  if (u == 92) { emitByte(92); emitByte(92); return; } // \\
  if (u == 8) { emitByte(92); emitByte(98); return; } // \b
  if (u == 9) { emitByte(92); emitByte(116); return; } // \t
  if (u == 10) { emitByte(92); emitByte(110); return; } // \n
  if (u == 12) { emitByte(92); emitByte(102); return; } // \f
  if (u == 13) { emitByte(92); emitByte(114); return; } // \r
  if (u < 32) {
    emitByte(92); emitByte(117); emitByte(48); emitByte(48);
    const hi: u32 = (u >> 4) & 15;
    const lo: u32 = u & 15;
    emitByte(hi < 10 ? 48 + hi : 87 + hi);
    emitByte(lo < 10 ? 48 + lo : 87 + lo);
    return;
  }
  if (u >= 0xD800 && u <= 0xDFFF) {
    // Lone surrogate (a paired one is handled by the caller, which passes
    // the full code point through emitJsonCodePoint instead). Emit \uXXXX.
    emitByte(92); emitByte(117);
    const hex = (v: u32): void => {
      emitByte(v < 10 ? 48 + v : 87 + v);
    };
    hex((u >> 12) & 15); hex((u >> 8) & 15); hex((u >> 4) & 15); hex(u & 15);
    return;
  }
  if (u < 128) { emitByte(u); return; }
  if (u < 2048) {
    emitByte(0xC0 | (u >> 6));
    emitByte(0x80 | (u & 63));
    return;
  }
  emitByte(0xE0 | (u >> 12));
  emitByte(0x80 | ((u >> 6) & 63));
  emitByte(0x80 | (u & 63));
}

// Emit a full code point (>= 0x10000) as UTF-8 (4 bytes).
function emitJsonCodePoint(cp: i32): void {
  emitByte(0xF0 | ((cp >> 18) & 7));
  emitByte(0x80 | ((cp >> 12) & 63));
  emitByte(0x80 | ((cp >> 6) & 63));
  emitByte(0x80 | (cp & 63));
}

// ---- line table ----
function finishLine(endUnit: i32, withNewline: i32): void {
  // Record one line: [startUnit, lenUnits incl. newline if any, hash u64].
  const base: usize = tabPtr + <usize>tabCount * 16;
  store<u32>(base, <u32>lineStart);
  store<u32>(base + 4, <u32>(endUnit - lineStart));
  store<i64>(base + 8, lineHash);
  tabCount += 1;
  lineStart = endUnit;
  lineHash = FNV_OFF;
}

function pushUnit(u: u32): void {
  store<u16>(decPtr + <usize>decUnits * 2, <u16>u);
  decUnits += 1;
  lineHash = (lineHash ^ <i64>u) * FNV_PRIME;
  if (u == 10) finishLine(decUnits, 1);
}

// Decode one UTF-8 sequence starting at byte position p (lead byte >= 0x80).
// Returns the code point, and advances inPos past the sequence.
function decodeUtf8(p: i32): i32 {
  const b0: u32 = load<u8>(inPtr + <usize>p);
  if (b0 >= 0xF0 && p + 3 < inLen) {
    const b1: u32 = load<u8>(inPtr + <usize>(p + 1));
    const b2: u32 = load<u8>(inPtr + <usize>(p + 2));
    const b3: u32 = load<u8>(inPtr + <usize>(p + 3));
    inPos = p + 4;
    return <i32>(((b0 & 7) << 18) | ((b1 & 63) << 12) | ((b2 & 63) << 6) | (b3 & 63));
  }
  if (b0 >= 0xE0 && p + 2 < inLen) {
    const b1: u32 = load<u8>(inPtr + <usize>(p + 1));
    const b2: u32 = load<u8>(inPtr + <usize>(p + 2));
    inPos = p + 3;
    return <i32>(((b0 & 15) << 12) | ((b1 & 63) << 6) | (b2 & 63));
  }
  if (b0 >= 0xC0 && p + 1 < inLen) {
    const b1: u32 = load<u8>(inPtr + <usize>(p + 1));
    inPos = p + 2;
    return <i32>(((b0 & 31) << 6) | (b1 & 63));
  }
  inPos = p + 1;
  return <i32>b0;
}

function pushCodePoint(cp: i32): void {
  if (cp >= 0x10000) {
    const v: i32 = cp - 0x10000;
    pushUnit(<u32>(0xD800 + (v >> 10)));
    pushUnit(<u32>(0xDC00 + (v & 1023)));
  } else {
    pushUnit(<u32>cp);
  }
}

// Read a \uXXXX escape at inPos (inPos points at the 'u'). Returns the unit.
function readHex4(): u32 {
  let v: u32 = 0;
  for (let i: i32 = 0; i < 4; i++) {
    const c: u32 = load<u8>(inPtr + <usize>(inPos + i));
    let d: u32 = 0;
    if (c >= 48 && c <= 57) d = c - 48;
    else if (c >= 97 && c <= 102) d = c - 87;
    else if (c >= 65 && c <= 70) d = c - 55;
    v = (v << 4) | d;
  }
  inPos += 4;
  return v;
}

// Parse a JSON string starting at inPos (which points at the opening quote).
// capture: 0 = skip the string, 1 = capture as old text, 2 = capture as new.
// Leaves inPos just past the closing quote. For a captured string the
// decoded UTF-16 units land in the target buffer and its line table is built.
function parseString(capture: i32): void {
  // inPos points at '"'
  inPos += 1;
  if (capture != 0) {
    if (capture == 1) { decPtr = OLD_DEC; tabPtr = OLD_TAB; }
    else { decPtr = NEW_DEC; tabPtr = NEW_TAB; }
    decUnits = 0;
    tabCount = 0;
    lineStart = 0;
    lineHash = FNV_OFF;
  }
  while (inPos < inLen) {
    const b: u32 = load<u8>(inPtr + <usize>inPos);
    if (b == 34) { inPos += 1; break; } // closing quote
    if (b == 92) {
      // escape
      const e: u32 = load<u8>(inPtr + <usize>(inPos + 1));
      inPos += 2;
      if (capture == 0) {
        if (e == 117) inPos += 4; // skip \uXXXX
        continue;
      }
      if (e == 110) pushUnit(10);
      else if (e == 114) pushUnit(13);
      else if (e == 116) pushUnit(9);
      else if (e == 98) pushUnit(8);
      else if (e == 102) pushUnit(12);
      else if (e == 47) pushUnit(47);
      else if (e == 92) pushUnit(92);
      else if (e == 34) pushUnit(34);
      else if (e == 117) pushUnit(readHex4());
      else pushUnit(e);
      continue;
    }
    if (capture == 0) { inPos += 1; continue; }
    if (b < 128) {
      pushUnit(b);
      inPos += 1;
    } else {
      pushCodePoint(decodeUtf8(inPos));
    }
  }
  if (capture != 0) {
    // Bare last line (no trailing newline) is a line too; empty text has none.
    if (decUnits > lineStart) finishLine(decUnits, 0);
    if (capture == 1) oldCount = tabCount;
    else newCount = tabCount;
  }
}

function skipWs(): void {
  while (inPos < inLen) {
    const b: u32 = load<u8>(inPtr + <usize>inPos);
    if (b == 32 || b == 9 || b == 10 || b == 13) inPos += 1;
    else break;
  }
}

// Key scratch lives at OPS_PTR (units), count in keyLen.
let keyLen: i32 = 0;
function keyIsOld(): bool { return keyLen == 3 && load<u16>(OPS_PTR) == 111 && load<u16>(OPS_PTR + 2) == 108 && load<u16>(OPS_PTR + 4) == 100; }
function keyIsNew(): bool { return keyLen == 3 && load<u16>(OPS_PTR) == 110 && load<u16>(OPS_PTR + 2) == 101 && load<u16>(OPS_PTR + 4) == 119; }

// Parse a JSON string as an object key into the key scratch.
function parseKey(): void {
  inPos += 1; // opening quote
  keyLen = 0;
  while (inPos < inLen) {
    const b: u32 = load<u8>(inPtr + <usize>inPos);
    if (b == 34) { inPos += 1; break; }
    if (b == 92) { inPos += 2; continue; } // keys here are plain identifiers
    store<u16>(OPS_PTR + <usize>keyLen * 2, <u16>b);
    keyLen += 1;
    inPos += 1;
  }
}

function parseArray(): void {
  inPos += 1; // '['
  skipWs();
  if (inPos < inLen && load<u8>(inPtr + <usize>inPos) == 93) { inPos += 1; return; }
  while (inPos < inLen) {
    parseValue(0);
    skipWs();
    const b: u32 = load<u8>(inPtr + <usize>inPos);
    if (b == 44) { inPos += 1; skipWs(); continue; }
    if (b == 93) { inPos += 1; break; }
    break;
  }
}

// Parse an object. Returns true when this object held both an "old" and a
// "new" key (i.e. it is a case's input object) — the caller then diffs it.
function parseObject(): bool {
  inPos += 1; // '{'
  skipWs();
  let sawOld: bool = false;
  let sawNew: bool = false;
  if (inPos < inLen && load<u8>(inPtr + <usize>inPos) == 125) { inPos += 1; return false; }
  while (inPos < inLen) {
    parseKey();
    const isOld: bool = keyIsOld();
    const isNew: bool = keyIsNew();
    skipWs();
    if (inPos < inLen && load<u8>(inPtr + <usize>inPos) == 58) inPos += 1; // ':'
    skipWs();
    if (isOld) { parseValue(1); sawOld = true; }
    else if (isNew) { parseValue(2); sawNew = true; }
    else parseValue(0);
    skipWs();
    const b: u32 = load<u8>(inPtr + <usize>inPos);
    if (b == 44) { inPos += 1; skipWs(); continue; }
    if (b == 125) { inPos += 1; break; }
    break;
  }
  if (sawOld && sawNew) return true;
  return false;
}

function parseValue(capture: i32): void {
  skipWs();
  if (inPos >= inLen) return;
  const b: u32 = load<u8>(inPtr + <usize>inPos);
  if (b == 34) { parseString(capture); return; }
  if (b == 123) {
    if (parseObject()) processCase();
    return;
  }
  if (b == 91) { parseArray(); return; }
  // number / true / false / null: skip to the next delimiter
  while (inPos < inLen) {
    const c: u32 = load<u8>(inPtr + <usize>inPos);
    if (c == 44 || c == 93 || c == 125 || c == 32 || c == 10 || c == 13 || c == 9) break;
    inPos += 1;
  }
}

// ---- line equality (hash fast path, full compare on hash equality) ----
function tabStart(tab: usize, i: i32): i32 { return <i32>load<u32>(tab + <usize>i * 16); }
function tabLen(tab: usize, i: i32): i32 { return <i32>load<u32>(tab + <usize>i * 16 + 4); }
function tabHash(tab: usize, i: i32): i64 { return load<i64>(tab + <usize>i * 16 + 8); }

function linesEqual(oi: i32, ni: i32): bool {
  if (tabHash(OLD_TAB, oi) != tabHash(NEW_TAB, ni)) return false;
  const ol: i32 = tabLen(OLD_TAB, oi);
  if (ol != tabLen(NEW_TAB, ni)) return false;
  const os: i32 = tabStart(OLD_TAB, oi);
  const ns: i32 = tabStart(NEW_TAB, ni);
  for (let q: i32 = 0; q < ol; q++) {
    if (load<u16>(OLD_DEC + <usize>(os + q) * 2) != load<u16>(NEW_DEC + <usize>(ns + q) * 2)) return false;
  }
  return true;
}

// ---- global Myers forward ----
let myersN: i32 = 0;
let myersM: i32 = 0;
let myersP: i32 = 0; // prefix trim (middle coordinates are p + x)

function lineEqMid(x: i32, y: i32): bool {
  return linesEqual(myersP + x, myersP + y);
}

function traceRow(d: i32): usize {
  return TRACE_PTR + <usize>(d * d) * 2;
}

function ensureTrace(d: i32): void {
  if (d <= traceCapD) return;
  // Grow the trace capacity (doubling) and the memory to cover it.
  let cap: i32 = traceCapD == 0 ? 64 : traceCapD;
  while (cap < d) cap *= 2;
  const needEnd: usize = TRACE_PTR + <usize>(cap * cap + cap) * 2 + 65536;
  const have: usize = <usize>memory.size() * 65536;
  if (needEnd > have) {
    const pages: i32 = <i32>((needEnd - have + 65535) / 65536);
    memory.grow(pages);
  }
  traceCapD = cap;
}

function myersForward(n: i32, m: i32): i32 {
  myersN = n;
  myersM = m;
  // d = 0: snake from (0,0).
  ensureTrace(0);
  let x: i32 = 0;
  while (x < n && x < m && lineEqMid(x, x)) x += 1;
  store<u16>(traceRow(0), <u16>x);
  if (x == n && x == m) return 0;
  for (let d: i32 = 1; d <= n + m; d++) {
    ensureTrace(d);
    const row: usize = traceRow(d);
    const prev: usize = traceRow(d - 1);
    let doneD: i32 = -1;
    // j = 0 (k = -d): insertion only, x = Vprev[0].
    {
      const bRaw: i32 = <i32>load<u16>(prev);
      const bVal: i32 = bRaw == 65535 ? -1 : bRaw;
      let xv: i32 = -1;
      if (bVal >= 0 && bVal <= n && bVal + d <= m) xv = bVal;
      if (xv >= 0) {
        let y: i32 = xv + d;
        while (xv < n && y < m) {
          if (load<i64>(OLD_TAB + <usize>(myersP + xv) * 16 + 8) != load<i64>(NEW_TAB + <usize>(myersP + y) * 16 + 8)) break;
          if (!linesEqual(myersP + xv, myersP + y)) break;
          xv += 1; y += 1;
        }
      }
      store<u16>(row, xv < 0 ? <u16>65535 : <u16>xv);
      if (xv == n && xv + d == m) doneD = d;
    }
    // Main diagonals j = 1 .. d-1. Four diagonals at a time with SIMD128:
    // del sources Vprev[j-1..j+2] and ins sources Vprev[j..j+3] are each
    // contiguous (compact j layout), so two 64-bit loads feed the lanes.
    // Sentinel 65535 needs no special case: 65535+1 and 65535 both fail
    // the <= n bound (n < 65535 in this regime), so the lane is invalid.
    // A scalar tail handles the last 0..3 diagonals of the row.
    const nV: v128 = i32x4.splat(n);
    const mV: v128 = i32x4.splat(m);
    const oneV: v128 = i32x4.splat(1);
    const minusOneV: v128 = i32x4.splat(-1);
    const maskFFFF: v128 = i32x4.splat(65535);
    const zeroV: v128 = i32x4.splat(0);
    let stepV: v128 = i32x4.splat(0);
    stepV = i32x4.replace_lane(stepV, 1, 2);
    stepV = i32x4.replace_lane(stepV, 2, 4);
    stepV = i32x4.replace_lane(stepV, 3, 6);
    let pa: usize = prev;
    let pb: usize = prev + 2;
    let pr: usize = row + 2;
    let jv: i32 = 1;
    while (jv + 3 <= d - 1) {
      const k0: i32 = 2 * jv - d;
      const delV: v128 = i32x4.extend_low_i16x8_u(v128.load64_zero(pa));
      const insV: v128 = i32x4.extend_low_i16x8_u(v128.load64_zero(pb));
      const delX: v128 = i32x4.add(delV, oneV);
      const kV: v128 = i32x4.add(i32x4.splat(k0), stepV);
      const delOk: v128 = v128.and(i32x4.le_s(delX, nV), i32x4.le_s(i32x4.sub(delX, kV), mV));
      const insOk: v128 = v128.and(i32x4.le_s(insV, nV), i32x4.le_s(i32x4.sub(insV, kV), mV));
      const bothOk: v128 = v128.and(delOk, insOk);
      const maxChoice: v128 = v128.bitselect(delX, insV, i32x4.ge_s(delX, insV));
      const inner1: v128 = v128.bitselect(maxChoice, delX, bothOk);
      const inner2: v128 = v128.bitselect(insV, minusOneV, insOk);
      let xvV: v128 = v128.bitselect(inner1, inner2, delOk);
      let x0: i32 = i32x4.extract_lane(xvV, 0);
      let x1: i32 = i32x4.extract_lane(xvV, 1);
      let x2: i32 = i32x4.extract_lane(xvV, 2);
      let x3: i32 = i32x4.extract_lane(xvV, 3);
      if (x0 >= 0) {
        let y0: i32 = x0 - k0;
        while (x0 < n && y0 < m) {
          if (load<i64>(OLD_TAB + <usize>(myersP + x0) * 16 + 8) != load<i64>(NEW_TAB + <usize>(myersP + y0) * 16 + 8)) break;
          if (!linesEqual(myersP + x0, myersP + y0)) break;
          x0 += 1; y0 += 1;
        }
        if (x0 == n && x0 - k0 == m) doneD = d;
      }
      if (x1 >= 0) {
        let y1: i32 = x1 - (k0 + 2);
        while (x1 < n && y1 < m) {
          if (load<i64>(OLD_TAB + <usize>(myersP + x1) * 16 + 8) != load<i64>(NEW_TAB + <usize>(myersP + y1) * 16 + 8)) break;
          if (!linesEqual(myersP + x1, myersP + y1)) break;
          x1 += 1; y1 += 1;
        }
        if (x1 == n && x1 - (k0 + 2) == m) doneD = d;
      }
      if (x2 >= 0) {
        let y2: i32 = x2 - (k0 + 4);
        while (x2 < n && y2 < m) {
          if (load<i64>(OLD_TAB + <usize>(myersP + x2) * 16 + 8) != load<i64>(NEW_TAB + <usize>(myersP + y2) * 16 + 8)) break;
          if (!linesEqual(myersP + x2, myersP + y2)) break;
          x2 += 1; y2 += 1;
        }
        if (x2 == n && x2 - (k0 + 4) == m) doneD = d;
      }
      if (x3 >= 0) {
        let y3: i32 = x3 - (k0 + 6);
        while (x3 < n && y3 < m) {
          if (load<i64>(OLD_TAB + <usize>(myersP + x3) * 16 + 8) != load<i64>(NEW_TAB + <usize>(myersP + y3) * 16 + 8)) break;
          if (!linesEqual(myersP + x3, myersP + y3)) break;
          x3 += 1; y3 += 1;
        }
        if (x3 == n && x3 - (k0 + 6) == m) doneD = d;
      }
      xvV = i32x4.replace_lane(xvV, 0, x0);
      xvV = i32x4.replace_lane(xvV, 1, x1);
      xvV = i32x4.replace_lane(xvV, 2, x2);
      xvV = i32x4.replace_lane(xvV, 3, x3);
      const narrowed: v128 = i16x8.narrow_i32x4_u(v128.and(xvV, maskFFFF), zeroV);
      v128.store64_lane(pr, narrowed, 0);
      pa += 8; pb += 8; pr += 8; jv += 4;
    }
    // Scalar tail: the last 0..3 diagonals of the row. pa/pb/pr already
    // point at Vprev[jv-1], Vprev[jv], row[jv]; k = 2*jv - d.
    let k: i32 = 2 * jv - d;
    for (let j: i32 = jv; j <= d - 1; j++) {
      const aVal: i32 = <i32>load<u16>(pa);
      const bVal: i32 = <i32>load<u16>(pb);
      const av: i32 = aVal == 65535 ? -1 : aVal;
      const bv: i32 = bVal == 65535 ? -1 : bVal;
      const delX: i32 = av + 1;
      const delOk: bool = av >= 0 && delX <= n && delX - k <= m;
      const insOk: bool = bv >= 0 && bv <= n && bv - k <= m;
      let xv: i32 = delOk ? (insOk ? (delX >= bv ? delX : bv) : delX) : bv;
      if (!delOk && !insOk) xv = -1;
      if (xv >= 0) {
        let y: i32 = xv - k;
        while (xv < n && y < m) {
          if (load<i64>(OLD_TAB + <usize>(myersP + xv) * 16 + 8) != load<i64>(NEW_TAB + <usize>(myersP + y) * 16 + 8)) break;
          if (!linesEqual(myersP + xv, myersP + y)) break;
          xv += 1; y += 1;
        }
      }
      store<u16>(pr, xv < 0 ? <u16>65535 : <u16>xv);
      if (xv == n && xv - k == m) doneD = d;
      pa += 2; pb += 2; pr += 2; k += 2;
    }
    // j = d (k = d): deletion only, x = Vprev[d-1] + 1.
    {
      const aRaw: i32 = <i32>load<u16>(prev + <usize>(d - 1) * 2);
      const av: i32 = aRaw == 65535 ? -1 : aRaw;
      let xv: i32 = -1;
      if (av >= 0 && av + 1 <= n && av + 1 - d <= m) xv = av + 1;
      if (xv >= 0) {
        let y: i32 = xv - d;
        while (xv < n && y < m) {
          if (load<i64>(OLD_TAB + <usize>(myersP + xv) * 16 + 8) != load<i64>(NEW_TAB + <usize>(myersP + y) * 16 + 8)) break;
          if (!linesEqual(myersP + xv, myersP + y)) break;
          xv += 1; y += 1;
        }
      }
      store<u16>(row + <usize>d * 2, xv < 0 ? <u16>65535 : <u16>xv);
      if (xv == n && xv - d == m) doneD = d;
    }
    if (doneD >= 0) return doneD;
  }
  return -1;
}

// ---- mirror backtrack: kept pairs (middle coordinates), reversed then fixed ----
let keptPtr: usize = 0;
let keptCount: i32 = 0;

function myersBacktrack(n: i32, m: i32, D: i32): void {
  keptPtr = OPS_PTR;
  keptCount = 0;
  let x: i32 = n;
  let y: i32 = m;
  for (let d: i32 = D; d >= 1; d--) {
    const prev: usize = traceRow(d - 1);
    const k: i32 = x - y;
    const j: i32 = (k + d) / 2;
    const avRaw: i32 = j >= 1 ? <i32>load<u16>(prev + <usize>(j - 1) * 2) : -1;
    const bvRaw: i32 = j <= d - 1 ? <i32>load<u16>(prev + <usize>j * 2) : -1;
    const av: i32 = avRaw == 65535 ? -1 : avRaw;
    const bv: i32 = bvRaw == 65535 ? -1 : bvRaw;
    let prevK: i32;
    if (k == d) prevK = k - 1;
    else if (k == -d) prevK = k + 1;
    else if (av < 0) prevK = k + 1;
    else if (bv < 0) prevK = k - 1;
    else if (av + 1 >= bv) prevK = k - 1;
    else prevK = k + 1;
    const jPrev: i32 = (prevK + d - 1) / 2;
    const prevX: i32 = <i32>load<u16>(prev + <usize>jPrev * 2);
    const prevY: i32 = prevX - prevK;
    while (x > prevX && y > prevY) {
      const base: usize = keptPtr + <usize>keptCount * 8;
      store<u32>(base, <u32>(x - 1));
      store<u32>(base + 4, <u32>(y - 1));
      keptCount += 1;
      x -= 1; y -= 1;
    }
    if (x == prevX) y -= 1; else x -= 1;
    x = prevX; y = prevY;
  }
  while (x > 0 && y > 0) {
    const base: usize = keptPtr + <usize>keptCount * 8;
    store<u32>(base, <u32>(x - 1));
    store<u32>(base + 4, <u32>(y - 1));
    keptCount += 1;
    x -= 1; y -= 1;
  }
  // Reverse the kept pairs in place.
  for (let i: i32 = 0; i < keptCount / 2; i++) {
    const a: usize = keptPtr + <usize>i * 8;
    const b: usize = keptPtr + <usize>(keptCount - 1 - i) * 8;
    const ao: u32 = load<u32>(a);
    const an: u32 = load<u32>(a + 4);
    store<u32>(a, load<u32>(b));
    store<u32>(a + 4, load<u32>(b + 4));
    store<u32>(b, ao);
    store<u32>(b + 4, an);
  }
}

// ---- ops, hunks, rendering ----
let opsPtr: usize = 0;
let opsCount: i32 = 0;
let curO: i32 = 0;
let curN: i32 = 0;

function pushOp(t: u32, oi: i32, ni: i32): void {
  const base: usize = opsPtr + <usize>opsCount * 12;
  store<u8>(base, <u8>t);
  store<u32>(base + 4, <u32>oi);
  store<u32>(base + 8, <u32>ni);
  opsCount += 1;
}

function addKept(oi: i32, ni: i32): void {
  while (curO < oi) { pushOp(1, curO, -1); curO += 1; }
  while (curN < ni) { pushOp(2, -1, curN); curN += 1; }
  pushOp(0, oi, ni);
  curO = oi + 1;
  curN = ni + 1;
}

function opType(i: i32): u32 { return <u32>load<u8>(opsPtr + <usize>i * 12); }
function opOld(i: i32): i32 { return <i32>load<u32>(opsPtr + <usize>i * 12 + 4); }
function opNew(i: i32): i32 { return <i32>load<u32>(opsPtr + <usize>i * 12 + 8); }

// Emit one decoded line (from old or new buffer) as JSON string content,
// honouring surrogate pairs (one code point -> 4 UTF-8 bytes).
function emitLineJson(dec: usize, start: i32, len: i32): void {
  let i: i32 = 0;
  while (i < len) {
    const u: u32 = <u32>load<u16>(dec + <usize>(start + i) * 2);
    // Fast path: printable ASCII that JSON leaves alone.
    if (u >= 32 && u <= 126 && u != 34 && u != 92) { emitByte(u); i += 1; continue; }
    if (u >= 0xD800 && u <= 0xDBFF && i + 1 < len) {
      const u2: u32 = <u32>load<u16>(dec + <usize>(start + i + 1) * 2);
      if (u2 >= 0xDC00 && u2 <= 0xDFFF) {
        const cp: i32 = 0x10000 + (<i32>(u - 0xD800) << 10) + <i32>(u2 - 0xDC00);
        emitJsonCodePoint(cp);
        i += 2;
        continue;
      }
    }
    emitJsonUnit(u);
    i += 1;
  }
}

function emitPatchText(): void {
  // ops are already built; group change runs into hunks (gap <= 6 kept).
  // First count deletions/insertions and collect change-run boundaries.
  let del: i32 = 0;
  let ins: i32 = 0;
  for (let i: i32 = 0; i < opsCount; i++) {
    const t: u32 = opType(i);
    if (t == 1) del += 1;
    else if (t == 2) ins += 1;
  }
  // runs: pairs (startOp, endOpExclusive) stored at OPS_PTR + 2 MiB.
  const runsPtr: usize = OPS_PTR + 2097152;
  let runs: i32 = 0;
  let i: i32 = 0;
  while (i < opsCount) {
    if (opType(i) == 0) { i += 1; continue; }
    let j: i32 = i;
    while (j < opsCount && opType(j) != 0) j += 1;
    store<u32>(runsPtr + <usize>runs * 8, <u32>i);
    store<u32>(runsPtr + <usize>runs * 8 + 4, <u32>j);
    runs += 1;
    i = j;
  }
  // Merge runs into hunks (gap of kept lines between runs <= 6).
  const hunksPtr: usize = OPS_PTR + 3145728;
  let hunks: i32 = 0;
  for (let r: i32 = 0; r < runs; r++) {
    const rs: i32 = <i32>load<u32>(runsPtr + <usize>r * 8);
    const re: i32 = <i32>load<u32>(runsPtr + <usize>r * 8 + 4);
    if (hunks > 0) {
      const lastEnd: i32 = <i32>load<u32>(hunksPtr + <usize>(hunks - 1) * 8 + 4);
      if (rs - lastEnd <= 6) {
        store<u32>(hunksPtr + <usize>(hunks - 1) * 8 + 4, <u32>re);
        continue;
      }
    }
    store<u32>(hunksPtr + <usize>hunks * 8, <u32>rs);
    store<u32>(hunksPtr + <usize>hunks * 8 + 4, <u32>re);
    hunks += 1;
  }
  // Header: makefun-diff/1 old=N new=M hunks=H deleted=D inserted=I
  emitByte(109); emitByte(97); emitByte(107); emitByte(101); emitByte(102); emitByte(117); emitByte(110);
  emitByte(45); emitByte(100); emitByte(105); emitByte(102); emitByte(102); emitByte(47); emitByte(49);
  emitByte(32); emitByte(111); emitByte(108); emitByte(100); emitByte(61);
  emitInt(oldCount);
  emitByte(32); emitByte(110); emitByte(101); emitByte(119); emitByte(61);
  emitInt(newCount);
  emitByte(32); emitByte(104); emitByte(117); emitByte(110); emitByte(107); emitByte(115); emitByte(61);
  emitInt(hunks);
  emitByte(32); emitByte(100); emitByte(101); emitByte(108); emitByte(101); emitByte(116); emitByte(101); emitByte(100); emitByte(61);
  emitInt(del);
  emitByte(32); emitByte(105); emitByte(110); emitByte(115); emitByte(101); emitByte(114); emitByte(116); emitByte(101); emitByte(100); emitByte(61);
  emitInt(ins);
  emitByte(92); emitByte(110); // escaped newline: patch text lives in a JSON string
  for (let h: i32 = 0; h < hunks; h++) {
    const rs: i32 = <i32>load<u32>(hunksPtr + <usize>h * 8);
    const re: i32 = <i32>load<u32>(hunksPtr + <usize>h * 8 + 4);
    const hs: i32 = rs - 3 < 0 ? 0 : rs - 3;
    const he: i32 = re + 3 > opsCount ? opsCount : re + 3;
    let os: i32 = 0;
    let ns: i32 = 0;
    let ol: i32 = 0;
    let nl: i32 = 0;
    for (let q: i32 = 0; q < hs; q++) {
      if (opType(q) != 2) os += 1;
      if (opType(q) != 1) ns += 1;
    }
    for (let q: i32 = hs; q < he; q++) {
      if (opType(q) != 2) ol += 1;
      if (opType(q) != 1) nl += 1;
    }
    emitByte(64); emitByte(32);
    emitInt(os + 1); emitByte(32); emitInt(ol); emitByte(32);
    emitInt(ns + 1); emitByte(32); emitInt(nl); emitByte(92); emitByte(110);
    for (let q: i32 = hs; q < he; q++) {
      const t: u32 = opType(q);
      if (t == 0) {
        emitByte(61);
        const oi: i32 = opOld(q);
        emitLineJson(OLD_DEC, tabStart(OLD_TAB, oi), tabLen(OLD_TAB, oi));
        if (tabLen(OLD_TAB, oi) == 0 || load<u16>(OLD_DEC + <usize>(tabStart(OLD_TAB, oi) + tabLen(OLD_TAB, oi) - 1) * 2) != 10) {
          emitByte(92); emitByte(110); emitByte(37); emitByte(92); emitByte(110);
        }
      } else if (t == 1) {
        emitByte(45);
        const oi: i32 = opOld(q);
        emitLineJson(OLD_DEC, tabStart(OLD_TAB, oi), tabLen(OLD_TAB, oi));
        if (tabLen(OLD_TAB, oi) == 0 || load<u16>(OLD_DEC + <usize>(tabStart(OLD_TAB, oi) + tabLen(OLD_TAB, oi) - 1) * 2) != 10) {
          emitByte(92); emitByte(110); emitByte(37); emitByte(92); emitByte(110);
        }
      } else {
        emitByte(43);
        const ni: i32 = opNew(q);
        emitLineJson(NEW_DEC, tabStart(NEW_TAB, ni), tabLen(NEW_TAB, ni));
        if (tabLen(NEW_TAB, ni) == 0 || load<u16>(NEW_DEC + <usize>(tabStart(NEW_TAB, ni) + tabLen(NEW_TAB, ni) - 1) * 2) != 10) {
          emitByte(92); emitByte(110); emitByte(37); emitByte(92); emitByte(110);
        }
      }
    }
  }
}

// ---- one case ----
let caseCount: i32 = 0;

function processCase(): void {
  const N: i32 = oldCount;
  const M: i32 = newCount;
  // Common prefix, then common suffix, on line equality.
  let p: i32 = 0;
  while (p < N && p < M && linesEqual(p, p)) p += 1;
  let s: i32 = 0;
  while (s < N - p && s < M - p && linesEqual(N - 1 - s, M - 1 - s)) s += 1;
  const n: i32 = N - p - s;
  const m: i32 = M - p - s;
  myersP = p;
  const D: i32 = myersForward(n, m);
  myersBacktrack(n, m, D);
  // Build ops from kept pairs: prefix + middle + suffix.
  opsPtr = OPS_PTR + 1048576;
  opsCount = 0;
  curO = 0;
  curN = 0;
  for (let i: i32 = 0; i < p; i++) addKept(i, i);
  for (let i: i32 = 0; i < keptCount; i++) {
    const oi: i32 = <i32>load<u32>(keptPtr + <usize>i * 8) + p;
    const ni: i32 = <i32>load<u32>(keptPtr + <usize>i * 8 + 4) + p;
    addKept(oi, ni);
  }
  for (let i: i32 = 0; i < s; i++) addKept(N - s + i, M - s + i);
  while (curO < N) { pushOp(1, curO, -1); curO += 1; }
  while (curN < M) { pushOp(2, -1, curN); curN += 1; }
  // Emit this case's answer into answers.json.
  if (caseCount > 0) emitByte(44); // ','
  emitByte(34); // opening quote
  emitPatchText();
  emitByte(34); // closing quote
  caseCount += 1;
}

// ---- entry points ----
export function getOutPtr(): i32 { return <i32>OUT_PTR; }
export function getOutLen(): i32 { return outLen; }

export function runAll(inputPtr: i32, inputLen: i32): i32 {
  inPtr = <usize>inputPtr;
  inLen = inputLen;
  inPos = 0;
  outPos = OUT_PTR;
  outLen = 0;
  caseCount = 0;
  traceCapD = 5792;
  emitByte(91); // '['
  parseValue(0);
  emitByte(93); // ']'
  outLen = <i32>(outPos - OUT_PTR);
  return outLen;
}
