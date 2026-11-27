// diff.ts — R9 WASM core (AssemblyScript, --runtime stub, no imports, no GC).
// Written from the brief's prose spec only. No JSON.parse anywhere: the
// module scans raw JSON bytes, builds line tables, interns lines, diffs with
// exact global Myers (deletion-preferred tie-break) over the middle after a
// global prefix/suffix trim, and renders makefun-diff/1 patches straight
// into the output buffer. (Unique-anchor splitting was tried and REJECTED:
// a unique line is not always on the Myers path, so forcing anchors cannot
// reproduce the oracle. See diffAll.)
//
// Memory layout (bytes):
//   [0, 1MB)          AssemblyScript statics (tiny; no heap use at all)
//   [1MB, 1MB+inLen)  input bytes (copied in by JS)
//   [1MB+inLen, +4MB) output buffer (answers.json / patch)
//   [after output)    bump-allocated per-case tables (reset after each case)
// Initial memory 384 pages (24MB); grows lazily only if a case needs it.

const IN_BASE: i32 = 1 << 20;
const OUT_CAP: i32 = 4 << 20;
const INIT_PAGES: i32 = 384;

let g_inLen: i32 = 0;
let g_outBase: i32 = 0;
let g_outPtr: i32 = 0;
let g_outEnd: i32 = 0;
let g_bump: i32 = 0;
let g_bumpMark: i32 = 0;
let g_memEnd: i32 = INIT_PAGES << 16;
let g_mode: i32 = 0; // 0 = full; 1 = scan+intern only; 2 = +diff, no render (stage timing)

export function inPtr(): i32 { return IN_BASE; }
export function inCap(): i32 { return 256 << 20; }
// Grow memory so `n` input bytes plus the output region and table reserve fit.
export function ensureInput(n: i32): void {
  growTo(IN_BASE + n + OUT_CAP + (8 << 20));
}
export function outPtr(): i32 { return g_outBase; }
export function outLen(): i32 { return g_outPtr - g_outBase; }
export function setMode(m: i32): void { g_mode = m; }

function growTo(bytes: i32): void {
  if (bytes <= g_memEnd) return;
  let pages: i32 = (bytes - g_memEnd + 65535) >> 16;
  memory.grow(pages);
  g_memEnd += pages << 16;
}

function bump(n: i32): i32 {
  n = (n + 7) & ~7;
  let p: i32 = g_bump;
  g_bump += n;
  growTo(g_bump);
  return p;
}

function markBump(): i32 { return g_bump; }
function resetBump(m: i32): void { g_bump = m; }

// ---- output byte sink ----
function outEnsure(n: i32): void {
  if (g_outPtr + n > g_outEnd) {
    // Output overflow: grow the whole memory and extend the output region.
    // Bump tables live after the output region; shifting them is unsafe, so
    // this path only runs when the bump is empty (between cases). In
    // practice OUT_CAP (4MB) is 2x the ~2MB practice answers.
    growTo(g_outEnd + (64 << 10) + n);
    g_outEnd += 64 << 10;
  }
}
function out8(b: i32): void {
  outEnsure(1);
  store<u8>(g_outPtr, b);
  g_outPtr += 1;
}
function outRaw(p: i32, n: i32): void {
  outEnsure(n);
  memory.copy(g_outPtr, p, n);
  g_outPtr += n;
}
function outU32(n: i32): void {
  // decimal, no allocation
  let tmp: i32 = g_bump; // scratch: 12 bytes on the bump (not advanced)
  let i: i32 = 0;
  if (n == 0) { out8(48); return; }
  let v: i32 = n;
  while (v > 0) { store<u8>(tmp + i, 48 + (v % 10)); v = v / 10; i += 1; }
  while (i > 0) { i -= 1; out8(load<u8>(tmp + i)); }
}
function outStatic(a: StaticArray<u8>): void {
  let n: i32 = a.length;
  outEnsure(n);
  for (let i: i32 = 0; i < n; i += 1) store<u8>(g_outPtr + i, a[i]);
  g_outPtr += n;
}

const HDR1: StaticArray<u8> = [
  0x6d, 0x61, 0x6b, 0x65, 0x66, 0x75, 0x6e, 0x2d, 0x64, 0x69, 0x66, 0x66, 0x2f, 0x31, 0x20,
  0x6f, 0x6c, 0x64, 0x3d,
]; // "makefun-diff/1 old="
const HDR2: StaticArray<u8> = [0x20, 0x6e, 0x65, 0x77, 0x3d]; // " new="
const HDR3: StaticArray<u8> = [
  0x20, 0x68, 0x75, 0x6e, 0x6b, 0x73, 0x3d,
]; // " hunks="
const HDR4: StaticArray<u8> = [
  0x20, 0x64, 0x65, 0x6c, 0x65, 0x74, 0x65, 0x64, 0x3d,
]; // " deleted="
const HDR5: StaticArray<u8> = [
  0x20, 0x69, 0x6e, 0x73, 0x65, 0x72, 0x74, 0x65, 0x64, 0x3d,
]; // " inserted="

// ---- small helpers ----
function min32(a: i32, b: i32): i32 { return a < b ? a : b; }
function max32(a: i32, b: i32): i32 { return a > b ? a : b; }
function hexVal(c: i32): i32 {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 97 && c <= 102) return c - 97 + 10;
  if (c >= 65 && c <= 70) return c - 65 + 10;
  return 0;
}
// SWAR: does the 8-byte word contain byte b?
function hasByte(w: u64, b: u64): bool {
  let x: u64 = w ^ (b * 0x0101010101010101);
  return ((x - 0x0101010101010101) & ~x & 0x8080808080808080) != 0;
}

// Per-case line tables (bump allocated, reset after each case).
let g_aHash: i32 = 0; let g_aStart: i32 = 0; let g_aEnd: i32 = 0;
let g_aNL: i32 = 0; let g_aLen: i32 = 0; let g_aId: i32 = 0; let g_aSlot: i32 = 0;
let g_aRaw: i32 = 0; // 1 = line's content has no `\` escape (decoded == raw bytes)
let g_aCap: i32 = 0; let g_nA: i32 = 0;
let g_bHash: i32 = 0; let g_bStart: i32 = 0; let g_bEnd: i32 = 0;
let g_bNL: i32 = 0; let g_bLen: i32 = 0; let g_bId: i32 = 0; let g_bSlot: i32 = 0;
let g_bRaw: i32 = 0;
let g_bCap: i32 = 0; let g_nB: i32 = 0;
// Intern table (one table for A+B).
let g_hHash: i32 = 0; let g_hA: i32 = 0; let g_hB: i32 = 0;
let g_hCntA: i32 = 0; let g_hCntB: i32 = 0; let g_hMask: i32 = 0;
let g_bOnly: i32 = 0; // number of B-only distinct lines seen
// Ops for the current case.
let g_opsKind: i32 = 0; let g_opsA: i32 = 0; let g_opsB: i32 = 0;
let g_nOps: i32 = 0; let g_opsCap: i32 = 0;
// Render mode for this case: 0 = raw patch bytes, 1 = JSON-escaped.
let g_jsonEsc: i32 = 0;
// Span bases for render (raw input offsets of the two texts).
let g_spanA: i32 = 0; let g_spanB: i32 = 0;
let g_esc: i32 = 0; // 1 if spans are JSON-escaped, 0 if raw UTF-8

export function runAll(inLen: i32): i32 {
  g_inLen = inLen;
  g_outBase = (IN_BASE + inLen + 15) & ~15;
  g_outPtr = g_outBase;
  g_outEnd = g_outBase + OUT_CAP;
  growTo(g_outEnd + (8 << 20)); // room for per-case tables after the output
  g_bump = g_outEnd;
  out8(0x5b); // '['
  let p: i32 = IN_BASE;
  let end: i32 = IN_BASE + inLen;
  let first: i32 = 1;
  let pendOldS: i32 = -1; let pendOldE: i32 = -1;
  let pendNewS: i32 = -1; let pendNewE: i32 = -1;
  while (p < end) {
    if (load<u8>(p) != 0x22) { p += 1; continue; } // '"'
    // Read the string at p as a possible key ("old" / "new"), tolerating
    // JSON whitespace around the ':' and before the value.
    let q: i32 = p + 1;
    while (q < end && load<u8>(q) != 0x22) {
      if (load<u8>(q) == 0x5c) q += 2; else q += 1;
    }
    if (q >= end) break;
    let klen: i32 = q - (p + 1);
    let isOld: i32 = 0;
    let isNew: i32 = 0;
    if (klen == 3) {
      if (load<u8>(p + 1) == 0x6f && load<u8>(p + 2) == 0x6c && load<u8>(p + 3) == 0x64) isOld = 1;
      else if (load<u8>(p + 1) == 0x6e && load<u8>(p + 2) == 0x65 && load<u8>(p + 3) == 0x77) isNew = 1;
    }
    if (isOld == 0 && isNew == 0) { p = q + 1; continue; }
    let r: i32 = q + 1;
    while (r < end) {
      let c: i32 = load<u8>(r);
      if (c == 0x20 || c == 0x09 || c == 0x0a || c == 0x0d) r += 1; else break;
    }
    if (r >= end || load<u8>(r) != 0x3a) { p = q + 1; continue; } // ':'
    r += 1;
    while (r < end) {
      let c: i32 = load<u8>(r);
      if (c == 0x20 || c == 0x09 || c == 0x0a || c == 0x0d) r += 1; else break;
    }
    if (r >= end || load<u8>(r) != 0x22) { p = q + 1; continue; }
    let vs: i32 = r + 1;
    let ve: i32 = scanStringEnd(vs, end);
    if (isOld != 0) { pendOldS = vs; pendOldE = ve; }
    else { pendNewS = vs; pendNewE = ve; }
    p = ve + 1;
    if (pendOldS >= 0 && pendNewS >= 0) {
      if (first == 0) out8(0x2c); // ','
      first = 0;
      out8(0x22); // '"'
      processCase(pendOldS, pendOldE, pendNewS, pendNewE, 1, 1);
      out8(0x22);
      pendOldS = -1; pendNewS = -1;
    }
  }
  out8(0x5d); // ']'
  return g_outPtr - g_outBase;
}

export function runPair(oldLen: i32, newLen: i32): i32 {
  let total: i32 = oldLen + newLen;
  g_inLen = total;
  g_outBase = (IN_BASE + total + 15) & ~15;
  g_outPtr = g_outBase;
  g_outEnd = g_outBase + OUT_CAP;
  growTo(g_outEnd + (8 << 20)); // room for per-case tables after the output
  g_bump = g_outEnd;
  processCase(IN_BASE, IN_BASE + oldLen, IN_BASE + oldLen, IN_BASE + total, 0, 0);
  return g_outPtr - g_outBase;
}

// Find the closing quote of a JSON string value starting at s (content).
function scanStringEnd(s: i32, end: i32): i32 {
  let p: i32 = s;
  while (p < end) {
    let c: i32 = load<u8>(p);
    if (c == 0x5c) { p += 2; continue; } // backslash: skip escaped byte
    if (c == 0x22) return p;
    p += 1;
  }
  return end;
}

// ---- line hashing ----
// Hash is over DECODED bytes, chunked by decoded offset from the line start,
// so the same decoded line hashes the same whatever its JSON escaping was
// (raw UTF-8 vs \uXXXX). Word boundaries sit at fixed decoded offsets.
const FNV_PRIME: u64 = 1099511628211;
const HASH_SEED: u64 = 14695981039346656037;
function mix1(h: u64, b: i32): u64 { return (h ^ <u64>(b & 0xff)) * FNV_PRIME; }
function mix8(h: u64, w: u64): u64 {
  h ^= w;
  h *= 0x9E3779B97F4A7C15;
  h ^= h >> 32;
  return h;
}
function finalizeHash(h: u64): u64 {
  h ^= h >> 33;
  h *= 0xC2B2AE3D27D4EB4F;
  h ^= h >> 33;
  return h | 1;
}

// ---- \uXXXX decoding ----
let g_uAdv: i32 = 0; // bytes consumed from the backslash by readUnicode
function readUnicode(p: i32, e: i32): i32 {
  // p points at 'u' of \uXXXX. Returns the code point, or -1 if malformed.
  if (p + 5 > e) return -1;
  let cu: i32 = (hexVal(load<u8>(p + 1)) << 12) | (hexVal(load<u8>(p + 2)) << 8) |
    (hexVal(load<u8>(p + 3)) << 4) | hexVal(load<u8>(p + 4));
  g_uAdv = 6;
  if (cu >= 0xD800 && cu <= 0xDBFF && p + 12 <= e &&
      load<u8>(p + 6) == 0x5c && load<u8>(p + 7) == 0x75) {
    let lo: i32 = (hexVal(load<u8>(p + 8)) << 12) | (hexVal(load<u8>(p + 9)) << 8) |
      (hexVal(load<u8>(p + 10)) << 4) | hexVal(load<u8>(p + 11));
    if (lo >= 0xDC00 && lo <= 0xDFFF) {
      g_uAdv = 12;
      return 0x10000 + ((cu - 0xD800) << 10) + (lo - 0xDC00);
    }
  }
  return cu;
}
let g_cpLen: i32 = 0;
function mixCp(h: u64, cp: i32): u64 {
  // Mix the UTF-8 encoding of cp (CESU-8 for lone surrogates: same bytes
  // both sides, so equality is preserved).
  if (cp < 0x80) { g_cpLen = 1; return mix1(h, cp); }
  if (cp < 0x800) {
    g_cpLen = 2;
    h = mix1(h, 0xC0 | (cp >> 6));
    return mix1(h, 0x80 | (cp & 0x3F));
  }
  if (cp < 0x10000) {
    g_cpLen = 3;
    h = mix1(h, 0xE0 | (cp >> 12));
    h = mix1(h, 0x80 | ((cp >> 6) & 0x3F));
    return mix1(h, 0x80 | (cp & 0x3F));
  }
  g_cpLen = 4;
  h = mix1(h, 0xF0 | (cp >> 18));
  h = mix1(h, 0x80 | ((cp >> 12) & 0x3F));
  h = mix1(h, 0x80 | ((cp >> 6) & 0x3F));
  return mix1(h, 0x80 | (cp & 0x3F));
}

// ---- line tables: grow ----
function allocLineTables(isB: bool, cap: i32): void {
  let h: i32 = bump(cap * 8);
  let s: i32 = bump(cap * 4);
  let en: i32 = bump(cap * 4);
  let nl: i32 = bump(cap * 4);
  let ln: i32 = bump(cap * 4);
  let id: i32 = bump(cap * 4);
  let sl: i32 = bump(cap * 4);
  let rw: i32 = bump(cap * 4);
  if (isB) {
    g_bHash = h; g_bStart = s; g_bEnd = en; g_bNL = nl; g_bLen = ln; g_bId = id; g_bSlot = sl;
    g_bRaw = rw;
    g_bCap = cap; g_nB = 0;
  } else {
    g_aHash = h; g_aStart = s; g_aEnd = en; g_aNL = nl; g_aLen = ln; g_aId = id; g_aSlot = sl;
    g_aRaw = rw;
    g_aCap = cap; g_nA = 0;
  }
}
function growLineTables(isB: bool, count: i32): void {
  let cap: i32 = isB ? g_bCap : g_aCap;
  let n: i32 = count;
  let nc: i32 = cap * 2;
  let oh: i32 = isB ? g_bHash : g_aHash;
  let os: i32 = isB ? g_bStart : g_aStart;
  let oe: i32 = isB ? g_bEnd : g_aEnd;
  let on: i32 = isB ? g_bNL : g_aNL;
  let ol: i32 = isB ? g_bLen : g_aLen;
  let oi: i32 = isB ? g_bId : g_aId;
  let osl: i32 = isB ? g_bSlot : g_aSlot;
  let orw: i32 = isB ? g_bRaw : g_aRaw;
  let h: i32 = bump(nc * 8);
  let s: i32 = bump(nc * 4);
  let en: i32 = bump(nc * 4);
  let nl: i32 = bump(nc * 4);
  let ln: i32 = bump(nc * 4);
  let id: i32 = bump(nc * 4);
  let sl: i32 = bump(nc * 4);
  let rw: i32 = bump(nc * 4);
  memory.copy(h, oh, n * 8);
  memory.copy(s, os, n * 4);
  memory.copy(en, oe, n * 4);
  memory.copy(nl, on, n * 4);
  memory.copy(ln, ol, n * 4);
  memory.copy(id, oi, n * 4);
  memory.copy(sl, osl, n * 4);
  memory.copy(rw, orw, n * 4);
  if (isB) {
    g_bHash = h; g_bStart = s; g_bEnd = en; g_bNL = nl; g_bLen = ln; g_bId = id; g_bSlot = sl;
    g_bRaw = rw;
    g_bCap = nc;
  } else {
    g_aHash = h; g_aStart = s; g_aEnd = en; g_aNL = nl; g_aLen = ln; g_aId = id; g_aSlot = sl;
    g_aRaw = rw;
    g_aCap = nc;
  }
}

// Build the line table for span [s, e). escaped=1: JSON string content
// (escapes decoded); 0: raw UTF-8. Lines end at decoded 0x0A; a trailing
// segment with no newline is a bare line; empty text has no lines.
function buildLines(s: i32, e: i32, escaped: i32, isB: bool): void {
  let cap: i32 = (e - s) / 24 + 16;
  if (cap < 64) cap = 64;
  allocLineTables(isB, cap);
  let n: i32 = 0;
  let i: i32 = s;
  let lineStart: i32 = s;
  let h: u64 = HASH_SEED;
  let decLen: i32 = 0;
  let lineSpec: i32 = 0; // 1 once the current line's content has a `\` escape
  let spec: u64 = escaped != 0 ? 0x5c : 0x0a;
  while (i < e) {
    // Fast path: 8 raw bytes with no special byte.
    if (i + 8 <= e) {
      let w: u64 = load<u64>(i);
      if (!hasByte(w, spec)) {
        h = mix8(h, w);
        decLen += 8;
        i += 8;
        continue;
      }
    }
    let c: i32 = load<u8>(i);
    if (escaped != 0 && c == 0x5c) {
      // Escape sequence at i.
      let c2: i32 = load<u8>(i + 1);
      if (c2 == 0x6e) { // \n: line break
        h = mix1(h, 0x0a);
        decLen += 1;
        i += 2;
        storeLine(isB, n, finalizeHash(mix1(h, 1)), lineStart, i, 1, decLen, lineSpec == 0 ? 1 : 0);
        n += 1;
        if (n >= (isB ? g_bCap : g_aCap)) growLineTables(isB, n);
        lineStart = i;
        h = HASH_SEED;
        decLen = 0;
        lineSpec = 0;
        continue;
      }
      if (c2 == 0x75) { // \uXXXX: any such escape marks the line non-raw
        lineSpec = 1;
        let cp: i32 = readUnicode(i + 1, e);
        if (cp < 0) { h = mix1(h, c2); decLen += 1; i += 2; continue; }
        if (cp == 0x0a) {
          h = mix1(h, 0x0a);
          decLen += 1;
          i += g_uAdv;
          storeLine(isB, n, finalizeHash(mix1(h, 1)), lineStart, i, 1, decLen, 0);
          n += 1;
          if (n >= (isB ? g_bCap : g_aCap)) growLineTables(isB, n);
          lineStart = i;
          h = HASH_SEED;
          decLen = 0;
          lineSpec = 0;
          continue;
        }
        h = mixCp(h, cp);
        decLen += g_cpLen;
        i += g_uAdv;
        continue;
      }
      lineSpec = 1;
      let d: i32 = c2;
      if (c2 == 0x72) d = 0x0d;
      else if (c2 == 0x74) d = 0x09;
      else if (c2 == 0x62) d = 0x08;
      else if (c2 == 0x66) d = 0x0c;
      else if (c2 == 0x22) d = 0x22;
      else if (c2 == 0x5c) d = 0x5c;
      else if (c2 == 0x2f) d = 0x2f;
      h = mix1(h, d);
      decLen += 1;
      i += 2;
      continue;
    }
    if (escaped == 0 && c == 0x0a) { // raw newline: line break
      h = mix1(h, 0x0a);
      decLen += 1;
      i += 1;
      storeLine(isB, n, finalizeHash(mix1(h, 1)), lineStart, i, 1, decLen, lineSpec == 0 ? 1 : 0);
      n += 1;
      if (n >= (isB ? g_bCap : g_aCap)) growLineTables(isB, n);
      lineStart = i;
      h = HASH_SEED;
      decLen = 0;
      lineSpec = 0;
      continue;
    }
    h = mix1(h, c);
    decLen += 1;
    i += 1;
  }
  if (lineStart < e) {
    if (n >= (isB ? g_bCap : g_aCap)) growLineTables(isB, n);
    storeLine(isB, n, finalizeHash(mix1(h, 0)), lineStart, e, 0, decLen, lineSpec == 0 ? 1 : 0);
    n += 1;
  }
  if (isB) g_nB = n; else g_nA = n;
}

function storeLine(isB: bool, idx: i32, hash: u64, st: i32, en: i32, nl: i32, ln: i32, raw: i32): void {
  if (isB) {
    store<u64>(g_bHash + idx * 8, hash);
    store<i32>(g_bStart + idx * 4, st);
    store<i32>(g_bEnd + idx * 4, en);
    store<i32>(g_bNL + idx * 4, nl);
    store<i32>(g_bLen + idx * 4, ln);
    store<i32>(g_bId + idx * 4, -1);
    store<i32>(g_bSlot + idx * 4, -1);
    store<i32>(g_bRaw + idx * 4, raw);
  } else {
    store<u64>(g_aHash + idx * 8, hash);
    store<i32>(g_aStart + idx * 4, st);
    store<i32>(g_aEnd + idx * 4, en);
    store<i32>(g_aNL + idx * 4, nl);
    store<i32>(g_aLen + idx * 4, ln);
    store<i32>(g_aId + idx * 4, -1);
    store<i32>(g_aSlot + idx * 4, -1);
    store<i32>(g_aRaw + idx * 4, raw);
  }
}

// Raw-content equality for two raw-clean lines (no `\` escape in either
// content, so decoded bytes == raw bytes). nl is already known equal by the
// caller; the terminator is 2 raw bytes (\n escape) in escaped mode, 1 byte
// (raw \n) in raw mode. A \u000a terminator is 6 bytes, but such a line is
// never raw-clean, so it never reaches this path.
function rawContentEq(s0: i32, e0: i32, s1: i32, e1: i32, nl: i32): bool {
  let t: i32 = g_esc != 0 ? 2 : 1;
  let l0: i32 = (e0 - s0) - (nl != 0 ? t : 0);
  let l1: i32 = (e1 - s1) - (nl != 0 ? t : 0);
  if (l0 != l1) return false;
  let p0: i32 = s0; let p1: i32 = s1;
  let n: i32 = l0;
  while (n >= 8) {
    if (load<u64>(p0) != load<u64>(p1)) return false;
    p0 += 8; p1 += 8; n -= 8;
  }
  while (n > 0) {
    if (load<u8>(p0) != load<u8>(p1)) return false;
    p0 += 1; p1 += 1; n -= 1;
  }
  return true;
}

// ---- decoded byte stream reader (for exact line equality) ----
let g_rPos: i32 = 0; let g_rEnd: i32 = 0;
let g_rPend: i32 = 0; let g_rPendLen: i32 = 0; let g_rPendIdx: i32 = 0;
let g_rSide: i32 = 0; // 0 = A line, 1 = B line (reader state kept in two slots)
let g_r1Pos: i32 = 0; let g_r1End: i32 = 0; let g_r1Pend: i32 = 0; let g_r1PendLen: i32 = 0; let g_r1PendIdx: i32 = 0;
let g_r2Pos: i32 = 0; let g_r2End: i32 = 0; let g_r2Pend: i32 = 0; let g_r2PendLen: i32 = 0; let g_r2PendIdx: i32 = 0;

function nextDecoded(side: i32): i32 {
  let pos: i32; let end: i32; let pend: i32; let pendLen: i32; let pendIdx: i32;
  if (side == 0) {
    pos = g_r1Pos; end = g_r1End; pend = g_r1Pend; pendLen = g_r1PendLen; pendIdx = g_r1PendIdx;
  } else {
    pos = g_r2Pos; end = g_r2End; pend = g_r2Pend; pendLen = g_r2PendLen; pendIdx = g_r2PendIdx;
  }
  let out: i32 = -1;
  if (pendIdx < pendLen) {
    out = (pend >> (pendIdx * 8)) & 0xff;
    pendIdx += 1;
  } else if (pos < end) {
    let c: i32 = load<u8>(pos);
    if (g_esc == 0 || c != 0x5c) {
      pos += 1;
      out = c;
    } else {
      let c2: i32 = load<u8>(pos + 1);
      if (c2 == 0x75) {
        let cp: i32 = readUnicode(pos + 1, end);
        if (cp < 0) { pos += 2; out = c2; }
        else {
          pos += g_uAdv;
          if (cp < 0x80) { out = cp; }
          else if (cp < 0x800) {
            pend = (0xC0 | (cp >> 6)) | ((0x80 | (cp & 0x3F)) << 8);
            pendLen = 2; pendIdx = 1;
            out = pend & 0xff;
          } else if (cp < 0x10000) {
            pend = (0xE0 | (cp >> 12)) | ((0x80 | ((cp >> 6) & 0x3F)) << 8) | ((0x80 | (cp & 0x3F)) << 16);
            pendLen = 3; pendIdx = 1;
            out = pend & 0xff;
          } else {
            pend = (0xF0 | (cp >> 18)) | ((0x80 | ((cp >> 12) & 0x3F)) << 8) |
              ((0x80 | ((cp >> 6) & 0x3F)) << 16) | ((0x80 | (cp & 0x3F)) << 24);
            pendLen = 4; pendIdx = 1;
            out = pend & 0xff;
          }
        }
      } else {
        let d: i32 = c2;
        if (c2 == 0x6e) d = 0x0a;
        else if (c2 == 0x72) d = 0x0d;
        else if (c2 == 0x74) d = 0x09;
        else if (c2 == 0x62) d = 0x08;
        else if (c2 == 0x66) d = 0x0c;
        else if (c2 == 0x22) d = 0x22;
        else if (c2 == 0x5c) d = 0x5c;
        else if (c2 == 0x2f) d = 0x2f;
        pos += 2;
        out = d;
      }
    }
  }
  if (side == 0) {
    g_r1Pos = pos; g_r1Pend = pend; g_r1PendLen = pendLen; g_r1PendIdx = pendIdx;
  } else {
    g_r2Pos = pos; g_r2Pend = pend; g_r2PendLen = pendLen; g_r2PendIdx = pendIdx;
  }
  return out;
}

// Exact decoded equality of A line ai and B line bi (hash already matched).
function linesEqual(ai: i32, bi: i32): bool {
  if (load<i32>(g_aNL + ai * 4) != load<i32>(g_bNL + bi * 4)) return false;
  if (load<i32>(g_aLen + ai * 4) != load<i32>(g_bLen + bi * 4)) return false;
  if (load<i32>(g_aRaw + ai * 4) != 0 && load<i32>(g_bRaw + bi * 4) != 0) {
    return rawContentEq(load<i32>(g_aStart + ai * 4), load<i32>(g_aEnd + ai * 4),
      load<i32>(g_bStart + bi * 4), load<i32>(g_bEnd + bi * 4), load<i32>(g_aNL + ai * 4));
  }
  g_r1Pos = load<i32>(g_aStart + ai * 4); g_r1End = load<i32>(g_aEnd + ai * 4);
  g_r1Pend = 0; g_r1PendLen = 0; g_r1PendIdx = 0;
  g_r2Pos = load<i32>(g_bStart + bi * 4); g_r2End = load<i32>(g_bEnd + bi * 4);
  g_r2Pend = 0; g_r2PendLen = 0; g_r2PendIdx = 0;
  return readersEqual();
}

// ---- decoded-stream equality ----
function readersEqual(): bool {
  while (true) {
    let x: i32 = nextDecoded(0);
    let y: i32 = nextDecoded(1);
    if (x != y) return false;
    if (x == -1) return true;
  }
}
function setReaders(s0: i32, e0: i32, s1: i32, e1: i32): void {
  g_r1Pos = s0; g_r1End = e0; g_r1Pend = 0; g_r1PendLen = 0; g_r1PendIdx = 0;
  g_r2Pos = s1; g_r2End = e1; g_r2Pend = 0; g_r2PendLen = 0; g_r2PendIdx = 0;
}
function linesEqualAA(ai: i32, aj: i32): bool {
  if (load<i32>(g_aNL + ai * 4) != load<i32>(g_aNL + aj * 4)) return false;
  if (load<i32>(g_aLen + ai * 4) != load<i32>(g_aLen + aj * 4)) return false;
  if (load<i32>(g_aRaw + ai * 4) != 0 && load<i32>(g_aRaw + aj * 4) != 0) {
    return rawContentEq(load<i32>(g_aStart + ai * 4), load<i32>(g_aEnd + ai * 4),
      load<i32>(g_aStart + aj * 4), load<i32>(g_aEnd + aj * 4), load<i32>(g_aNL + ai * 4));
  }
  setReaders(load<i32>(g_aStart + ai * 4), load<i32>(g_aEnd + ai * 4),
    load<i32>(g_aStart + aj * 4), load<i32>(g_aEnd + aj * 4));
  return readersEqual();
}
function linesEqualBB(bi: i32, bj: i32): bool {
  if (load<i32>(g_bNL + bi * 4) != load<i32>(g_bNL + bj * 4)) return false;
  if (load<i32>(g_bLen + bi * 4) != load<i32>(g_bLen + bj * 4)) return false;
  if (load<i32>(g_bRaw + bi * 4) != 0 && load<i32>(g_bRaw + bj * 4) != 0) {
    return rawContentEq(load<i32>(g_bStart + bi * 4), load<i32>(g_bEnd + bi * 4),
      load<i32>(g_bStart + bj * 4), load<i32>(g_bEnd + bj * 4), load<i32>(g_bNL + bi * 4));
  }
  setReaders(load<i32>(g_bStart + bi * 4), load<i32>(g_bEnd + bi * 4),
    load<i32>(g_bStart + bj * 4), load<i32>(g_bEnd + bj * 4));
  return readersEqual();
}

// ---- interning (B follows A: equal lines share one id) ----
function internAll(): void {
  let need: i32 = (g_nA + g_nB) * 2 + 16;
  let t: i32 = 16;
  while (t < need) t <<= 1;
  g_hMask = t - 1;
  g_hHash = bump(t * 8);
  g_hA = bump(t * 4);
  g_hB = bump(t * 4);
  g_hCntA = bump(t * 4);
  g_hCntB = bump(t * 4);
  for (let i: i32 = 0; i < t; i += 1) store<u64>(g_hHash + i * 8, 0);
  g_bOnly = 0;
  for (let ai: i32 = 0; ai < g_nA; ai += 1) {
    let h: u64 = load<u64>(g_aHash + ai * 8);
    let j: i32 = <i32>(h & <u64>g_hMask);
    while (true) {
      let sh: u64 = load<u64>(g_hHash + j * 8);
      if (sh == 0) {
        store<u64>(g_hHash + j * 8, h);
        store<i32>(g_hA + j * 4, ai);
        store<i32>(g_hB + j * 4, -1);
        store<i32>(g_hCntA + j * 4, 1);
        store<i32>(g_hCntB + j * 4, 0);
        store<i32>(g_aId + ai * 4, ai);
        store<i32>(g_aSlot + ai * 4, j);
        break;
      }
      if (sh == h) {
        let aj: i32 = load<i32>(g_hA + j * 4);
        if (aj >= 0 && linesEqualAA(ai, aj)) {
          store<i32>(g_hCntA + j * 4, load<i32>(g_hCntA + j * 4) + 1);
          store<i32>(g_aId + ai * 4, aj);
          store<i32>(g_aSlot + ai * 4, j);
          break;
        }
      }
      j = (j + 1) & g_hMask;
    }
  }
  for (let bi: i32 = 0; bi < g_nB; bi += 1) {
    let h: u64 = load<u64>(g_bHash + bi * 8);
    let j: i32 = <i32>(h & <u64>g_hMask);
    while (true) {
      let sh: u64 = load<u64>(g_hHash + j * 8);
      if (sh == 0) {
        store<u64>(g_hHash + j * 8, h);
        store<i32>(g_hA + j * 4, -1);
        store<i32>(g_hB + j * 4, bi);
        store<i32>(g_hCntA + j * 4, 0);
        store<i32>(g_hCntB + j * 4, 1);
        store<i32>(g_bId + bi * 4, -(bi + 1));
        store<i32>(g_bSlot + bi * 4, j);
        g_bOnly += 1;
        break;
      }
      if (sh == h) {
        let aj: i32 = load<i32>(g_hA + j * 4);
        if (aj >= 0) {
          if (linesEqualAB(aj, bi)) {
            let cb: i32 = load<i32>(g_hCntB + j * 4);
            if (cb == 0) store<i32>(g_hB + j * 4, bi); // first B occurrence
            store<i32>(g_hCntB + j * 4, cb + 1);
            store<i32>(g_bId + bi * 4, aj);
            store<i32>(g_bSlot + bi * 4, j);
            break;
          }
        } else {
          let bj: i32 = load<i32>(g_hB + j * 4);
          if (bj >= 0 && linesEqualBB(bi, bj)) {
            store<i32>(g_hCntB + j * 4, load<i32>(g_hCntB + j * 4) + 1);
            store<i32>(g_bId + bi * 4, -(bj + 1));
            store<i32>(g_bSlot + bi * 4, j);
            break;
          }
        }
      }
      j = (j + 1) & g_hMask;
    }
  }
}

// linesEqualAB is linesEqual from the previous chunk (A line vs B line).
function linesEqualAB(ai: i32, bi: i32): bool { return linesEqual(ai, bi); }

// ---- ops ----
function emitEq(ai: i32, bi: i32): void {
  store<u8>(g_opsKind + g_nOps, 0);
  store<i32>(g_opsA + g_nOps * 4, ai);
  store<i32>(g_opsB + g_nOps * 4, bi);
  g_nOps += 1;
}
function emitDel(ai: i32): void {
  store<u8>(g_opsKind + g_nOps, 1);
  store<i32>(g_opsA + g_nOps * 4, ai);
  store<i32>(g_opsB + g_nOps * 4, -1);
  g_nOps += 1;
}
function emitIns(bi: i32): void {
  store<u8>(g_opsKind + g_nOps, 2);
  store<i32>(g_opsA + g_nOps * 4, -1);
  store<i32>(g_opsB + g_nOps * 4, bi);
  g_nOps += 1;
}

// ---- exact Myers over one segment (ids), deletion-preferred tie-break ----
let g_trace: i32 = 0;
let g_traceIs32: i32 = 0;

function tSet(d: i32, k: i32, x: i32): void {
  let idx: i32 = d * (d + 1) / 2 + (k + d) / 2;
  if (g_traceIs32 != 0) store<i32>(g_trace + idx * 4, x);
  else store<u16>(g_trace + idx * 2, x);
}
function tGet(d: i32, k: i32): i32 {
  let idx: i32 = d * (d + 1) / 2 + (k + d) / 2;
  if (g_traceIs32 != 0) return load<i32>(g_trace + idx * 4);
  return load<u16>(g_trace + idx * 2);
}

// Forward Myers. Stores V rows in the trace (grown by doubling as d grows).
// Returns D.
function myersForward(a0: i32, b0: i32, n: i32, m: i32, vbuf: i32): i32 {
  let off: i32 = n + m;
  store<i32>(vbuf + (off + 1) * 4, 0);
  for (let d: i32 = 0; d <= n + m; d += 1) {
    ensureTrace(d);
    for (let k: i32 = -d; k <= d; k += 2) {
      let x: i32;
      // Deletion-preferred: insertion only when it reaches strictly further
      // into the old text (x_ins > x_del); on a tie the deletion wins.
      if (k == -d || (k != d && load<i32>(vbuf + (off + k - 1) * 4) + 1 < load<i32>(vbuf + (off + k + 1) * 4))) {
        x = load<i32>(vbuf + (off + k + 1) * 4);
      } else {
        x = load<i32>(vbuf + (off + k - 1) * 4) + 1;
      }
      let y: i32 = x - k;
      while (x < n && y < m &&
             load<i32>(g_aId + (a0 + x) * 4) == load<i32>(g_bId + (b0 + y) * 4)) {
        x += 1; y += 1;
      }
      store<i32>(vbuf + (off + k) * 4, x);
      tSet(d, k, x);
      if (x >= n && y >= m) return d;
    }
  }
  return n + m;
}

// Trace storage: triangular rows, grown by doubling (old buffers are freed
// with the segment's bump reset).
let g_traceCapD: i32 = 0;
function ensureTrace(d: i32): void {
  if (d <= g_traceCapD) return;
  let nc: i32 = g_traceCapD == 0 ? 64 : g_traceCapD * 2;
  while (nc < d) nc *= 2;
  let es: i32 = g_traceIs32 != 0 ? 4 : 2;
  let ne: i32 = (nc + 1) * (nc + 2) / 2;
  let nt: i32 = bump(ne * es);
  if (g_trace != 0) {
    let oe: i32 = (g_traceCapD + 1) * (g_traceCapD + 2) / 2;
    memory.copy(nt, g_trace, oe * es);
  }
  g_trace = nt;
  g_traceCapD = nc;
}

function diffSegment(a0: i32, a1: i32, b0: i32, b1: i32): void {
  // Common prefix of the segment: the forward snake from the entry point.
  // (The oracle never trims a segment's suffix: trailing matches inside the
  // middle come from forward snakes, and trimming them from the end moves
  // an insertion/deletion before a run of repeated lines. The global suffix
  // is trimmed once, in diffAll, never per segment.)
  while (a0 < a1 && b0 < b1 &&
         load<i32>(g_aId + a0 * 4) == load<i32>(g_bId + b0 * 4)) {
    emitEq(a0, b0);
    a0 += 1; b0 += 1;
  }
  let n: i32 = a1 - a0;
  let m: i32 = b1 - b0;
  if (n == 0) {
    for (let j: i32 = 0; j < m; j += 1) emitIns(b0 + j);
  } else if (m == 0) {
    for (let i: i32 = 0; i < n; i += 1) emitDel(a0 + i);
  } else {
    let mark: i32 = markBump();
    let vbuf: i32 = bump((2 * (n + m) + 1) * 4);
    g_traceIs32 = n >= 65534 ? 1 : 0;
    g_traceCapD = -1; // ensureTrace(0) must allocate: row 0 is a real row
    g_trace = 0;
    let d: i32 = myersForward(a0, b0, n, m, vbuf);
    // Backtrack into a temp buffer, filled backwards.
    let cap: i32 = n + m + 2;
    let tk: i32 = bump(cap);
    let ta: i32 = bump(cap * 4);
    let tb: i32 = bump(cap * 4);
    let pos: i32 = cap;
    let x: i32 = n;
    let y: i32 = m;
    for (let dd: i32 = d; dd >= 1; dd -= 1) {
      let k: i32 = x - y;
      let isIns: bool;
      let prevK: i32;
      // Mirror of the forward rule: insertion iff it reached strictly further.
      if (k == -dd || (k != dd && tGet(dd - 1, k - 1) + 1 < tGet(dd - 1, k + 1))) {
        prevK = k + 1; isIns = true;
      } else {
        prevK = k - 1; isIns = false;
      }
      let xPrev: i32 = tGet(dd - 1, prevK);
      let yPrev: i32 = xPrev - prevK;
      let xStep: i32 = isIns ? xPrev : xPrev + 1;
      let yStep: i32 = isIns ? yPrev + 1 : yPrev;
      // Snake (xStep,yStep)->(x,y): equals, reversed.
      for (let t: i32 = x - 1; t >= xStep; t -= 1) {
        pos -= 1;
        store<u8>(tk + pos, 0);
        store<i32>(ta + pos * 4, a0 + t);
        store<i32>(tb + pos * 4, b0 + t + (y - x));
      }
      pos -= 1;
      if (isIns) {
        store<u8>(tk + pos, 2);
        store<i32>(ta + pos * 4, -1);
        store<i32>(tb + pos * 4, b0 + yPrev);
      } else {
        store<u8>(tk + pos, 1);
        store<i32>(ta + pos * 4, a0 + xPrev);
        store<i32>(tb + pos * 4, -1);
      }
      x = xPrev;
      y = yPrev;
    }
    // Initial snake (0,0)->(x,y).
    for (let t: i32 = x - 1; t >= 0; t -= 1) {
      pos -= 1;
      store<u8>(tk + pos, 0);
      store<i32>(ta + pos * 4, a0 + t);
      store<i32>(tb + pos * 4, b0 + t + (y - x));
    }
    for (let t: i32 = pos; t < cap; t += 1) {
      let kd: i32 = load<u8>(tk + t);
      if (kd == 0) emitEq(load<i32>(ta + t * 4), load<i32>(tb + t * 4));
      else if (kd == 1) emitDel(load<i32>(ta + t * 4));
      else emitIns(load<i32>(tb + t * 4));
    }
    resetBump(mark);
  }
}

function diffAll(): void {
  // Exact global Myers, the oracle's own shape: common prefix kept, then
  // common suffix of the lines left, then Myers greedy (deletion-preferred)
  // over the middle. No anchors: a unique line is NOT always on the Myers
  // path (it can cross a repeated line the greedy matches instead), so
  // forcing anchors cannot reproduce the oracle. The middle is one segment.
  let a0: i32 = 0;
  let b0: i32 = 0;
  while (a0 < g_nA && b0 < g_nB &&
         load<i32>(g_aId + a0 * 4) == load<i32>(g_bId + b0 * 4)) {
    emitEq(a0, b0);
    a0 += 1; b0 += 1;
  }
  let a1: i32 = g_nA;
  let b1: i32 = g_nB;
  let suf: i32 = 0;
  while (a1 > a0 && b1 > b0 &&
         load<i32>(g_aId + (a1 - 1) * 4) == load<i32>(g_bId + (b1 - 1) * 4)) {
    suf += 1; a1 -= 1; b1 -= 1;
  }
  diffSegment(a0, a1, b0, b1);
  for (let t: i32 = 0; t < suf; t += 1) emitEq(a1 + t, b1 + t);
}

// ---- patch rendering ----
function outPatchNL(): void {
  if (g_jsonEsc != 0) { out8(0x5c); out8(0x6e); } // "\n" escape
  else out8(0x0a);
}
function outEscByte(b: i32): void {
  if (g_jsonEsc == 0) { out8(b); return; }
  if (b == 0x22) { out8(0x5c); out8(0x22); return; }
  if (b == 0x5c) { out8(0x5c); out8(0x5c); return; }
  if (b == 0x0a) { out8(0x5c); out8(0x6e); return; }
  if (b == 0x0d) { out8(0x5c); out8(0x72); return; }
  if (b == 0x09) { out8(0x5c); out8(0x74); return; }
  if (b == 0x08) { out8(0x5c); out8(0x62); return; }
  if (b == 0x0c) { out8(0x5c); out8(0x66); return; }
  if (b < 0x20) {
    out8(0x5c); out8(0x75); out8(0x30); out8(0x30);
    out8(b >> 4 < 10 ? 48 + (b >> 4) : 87 + (b >> 4));
    out8((b & 15) < 10 ? 48 + (b & 15) : 87 + (b & 15));
    return;
  }
  out8(b);
}
function outUtf8Esc(cp: i32): void {
  if (cp < 0x80) { outEscByte(cp); return; }
  if (cp >= 0xD800 && cp <= 0xDFFF) {
    // Lone surrogate: no valid UTF-8 encoding exists. In JSON mode emit
    // the \udXXX escape (what JSON.stringify does); in raw mode emit
    // CESU-8 bytes, which solve.js decodes back to the surrogate.
    if (g_jsonEsc != 0) {
      out8(0x5c); out8(0x75);
      out8(cp >> 12 < 10 ? 48 + (cp >> 12) : 87 + (cp >> 12));
      out8(((cp >> 8) & 15) < 10 ? 48 + ((cp >> 8) & 15) : 87 + ((cp >> 8) & 15));
      out8(((cp >> 4) & 15) < 10 ? 48 + ((cp >> 4) & 15) : 87 + ((cp >> 4) & 15));
      out8((cp & 15) < 10 ? 48 + (cp & 15) : 87 + (cp & 15));
      return;
    }
    out8(0xE0 | (cp >> 12));
    out8(0x80 | ((cp >> 6) & 0x3F));
    out8(0x80 | (cp & 0x3F));
    return;
  }
  if (cp < 0x800) {
    out8(0xC0 | (cp >> 6));
    out8(0x80 | (cp & 0x3F));
    return;
  }
  if (cp < 0x10000) {
    out8(0xE0 | (cp >> 12));
    out8(0x80 | ((cp >> 6) & 0x3F));
    out8(0x80 | (cp & 0x3F));
    return;
  }
  out8(0xF0 | (cp >> 18));
  out8(0x80 | ((cp >> 12) & 0x3F));
  out8(0x80 | ((cp >> 6) & 0x3F));
  out8(0x80 | (cp & 0x3F));
}

// Emit one patch line: prefix byte + decoded line bytes. A bare line (no
// trailing newline) is written with one newline and followed by a '%' line.
function emitLine(idx: i32, isB: bool, prefix: i32): void {
  out8(prefix);
  let st: i32; let en: i32; let nl: i32;
  if (isB) {
    st = load<i32>(g_bStart + idx * 4);
    en = load<i32>(g_bEnd + idx * 4);
    nl = load<i32>(g_bNL + idx * 4);
  } else {
    st = load<i32>(g_aStart + idx * 4);
    en = load<i32>(g_aEnd + idx * 4);
    nl = load<i32>(g_aNL + idx * 4);
  }
  let p: i32 = st;
  while (p < en) {
    let c: i32 = load<u8>(p);
    if (g_esc == 0 || c != 0x5c) {
      outEscByte(c);
      p += 1;
      continue;
    }
    let c2: i32 = load<u8>(p + 1);
    if (c2 == 0x75) {
      let cp: i32 = readUnicode(p + 1, en);
      if (cp < 0) { outEscByte(c2); p += 2; continue; }
      outUtf8Esc(cp);
      p += g_uAdv;
      continue;
    }
    let d: i32 = c2;
    if (c2 == 0x6e) d = 0x0a;
    else if (c2 == 0x72) d = 0x0d;
    else if (c2 == 0x74) d = 0x09;
    else if (c2 == 0x62) d = 0x08;
    else if (c2 == 0x66) d = 0x0c;
    else if (c2 == 0x22) d = 0x22;
    else if (c2 == 0x5c) d = 0x5c;
    else if (c2 == 0x2f) d = 0x2f;
    outEscByte(d);
    p += 2;
  }
  if (nl == 0) {
    outPatchNL();
    out8(0x25); // '%'
    outPatchNL();
  }
}

function renderCase(): void {
  let mark: i32 = markBump();
  // Change runs.
  let rS: i32 = bump((g_nOps + 1) * 4);
  let rE: i32 = bump((g_nOps + 1) * 4);
  let nR: i32 = 0;
  let i: i32 = 0;
  let deleted: i32 = 0;
  let inserted: i32 = 0;
  for (let q: i32 = 0; q < g_nOps; q += 1) {
    let kd: i32 = load<u8>(g_opsKind + q);
    if (kd == 1) deleted += 1;
    else if (kd == 2) inserted += 1;
  }
  while (i < g_nOps) {
    if (load<u8>(g_opsKind + i) == 0) { i += 1; continue; }
    let s: i32 = i;
    while (i < g_nOps && load<u8>(g_opsKind + i) != 0) i += 1;
    store<i32>(rS + nR * 4, s);
    store<i32>(rE + nR * 4, i);
    nR += 1;
  }
  // Hunks: <=3 context lines around each run; runs <=6 kept lines apart merge.
  let hS: i32 = bump((nR + 1) * 4);
  let hE: i32 = bump((nR + 1) * 4);
  let nH: i32 = 0;
  for (let r: i32 = 0; r < nR; r += 1) {
    let rs: i32 = load<i32>(rS + r * 4);
    let re: i32 = load<i32>(rE + r * 4);
    let keptBefore: i32 = rs - (r > 0 ? load<i32>(rE + (r - 1) * 4) : 0);
    let keptAfter: i32 = (r < nR - 1 ? load<i32>(rS + (r + 1) * 4) : g_nOps) - re;
    let cs: i32 = rs - min32(3, keptBefore);
    let ce: i32 = re + min32(3, keptAfter);
    if (nH > 0 && cs <= load<i32>(hE + (nH - 1) * 4)) {
      if (ce > load<i32>(hE + (nH - 1) * 4)) store<i32>(hE + (nH - 1) * 4, ce);
    } else {
      store<i32>(hS + nH * 4, cs);
      store<i32>(hE + nH * 4, ce);
      nH += 1;
    }
  }
  // Header.
  outStatic(HDR1);
  outU32(g_nA);
  outStatic(HDR2);
  outU32(g_nB);
  outStatic(HDR3);
  outU32(nH);
  outStatic(HDR4);
  outU32(deleted);
  outStatic(HDR5);
  outU32(inserted);
  outPatchNL();
  // Hunks.
  let cur: i32 = 0;
  let aPos: i32 = 0;
  let bPos: i32 = 0;
  for (let h: i32 = 0; h < nH; h += 1) {
    let hs: i32 = load<i32>(hS + h * 4);
    let he: i32 = load<i32>(hE + h * 4);
    while (cur < hs) {
      let kd: i32 = load<u8>(g_opsKind + cur);
      if (kd == 0) { aPos += 1; bPos += 1; }
      else if (kd == 1) aPos += 1;
      else bPos += 1;
      cur += 1;
    }
    let ol: i32 = 0;
    let nl2: i32 = 0;
    for (let j: i32 = hs; j < he; j += 1) {
      let kd: i32 = load<u8>(g_opsKind + j);
      if (kd == 0) { ol += 1; nl2 += 1; }
      else if (kd == 1) ol += 1;
      else nl2 += 1;
    }
    out8(0x40); // '@'
    out8(0x20);
    outU32(aPos + 1);
    out8(0x20);
    outU32(ol);
    out8(0x20);
    outU32(bPos + 1);
    out8(0x20);
    outU32(nl2);
    outPatchNL();
    let j: i32 = hs;
    while (j < he) {
      let kd: i32 = load<u8>(g_opsKind + j);
      if (kd == 0) {
        emitLine(load<i32>(g_opsA + j * 4), false, 0x3d); // '='
        aPos += 1; bPos += 1;
        j += 1;
        cur += 1;
        continue;
      }
      let re: i32 = j;
      while (re < he && load<u8>(g_opsKind + re) != 0) re += 1;
      // Deletions before insertions inside a change run.
      for (let t: i32 = j; t < re; t += 1) {
        if (load<u8>(g_opsKind + t) == 1) {
          emitLine(load<i32>(g_opsA + t * 4), false, 0x2d); // '-'
          aPos += 1;
        }
      }
      for (let t: i32 = j; t < re; t += 1) {
        if (load<u8>(g_opsKind + t) == 2) {
          emitLine(load<i32>(g_opsB + t * 4), true, 0x2b); // '+'
          bPos += 1;
        }
      }
      cur = re;
      j = re;
    }
  }
  resetBump(mark);
}

function processCase(oldS: i32, oldE: i32, newS: i32, newE: i32, esc: i32, jsonEsc: i32): void {
  let mark: i32 = markBump();
  g_esc = esc;
  g_jsonEsc = jsonEsc;
  g_spanA = oldS;
  g_spanB = newS;
  buildLines(oldS, oldE, esc, false);
  buildLines(newS, newE, esc, true);
  g_opsCap = g_nA + g_nB + 2;
  g_opsKind = bump(g_opsCap);
  g_opsA = bump(g_opsCap * 4);
  g_opsB = bump(g_opsCap * 4);
  g_nOps = 0;
  internAll();
  if (g_mode != 1) diffAll();
  if (g_mode == 0) renderCase();
  resetBump(mark);
}
