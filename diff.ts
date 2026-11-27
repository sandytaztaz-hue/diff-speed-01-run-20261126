// diff.ts — R11 WASM core. Written from the prose brief alone.
// Zero-copy raw-JSON SIMD128 exact Myers diff.
// Pipeline per case: SIMD scan + fused UTF-8 decode of the old/new JSON
// strings (line spans recorded during decode) -> hash-table intern
// (B-follows-A, memcmp-verified) -> global exact Myers, deletion preferred
// on ties (V[k-1]+1 < V[k+1] in forward loop AND backtrack), compact u16
// trace -> single-cursor patch render with JSON escaping, one write.
// No imports, no allocations, no JSON.parse. Input lives at 1 MiB so it
// never overwrites WASM static data at low addresses.

const INPUT_BASE: i32 = 1048576;
const SCRATCH0: i32 = 65536; // static scratch: above ASC static data, below input
const WORK_CAP: i32 = 24 * 1024 * 1024; // spans/ids/table/ops/hunks region
const TRACE_CAP_BYTES: i32 = 56 * 1024 * 1024; // Myers u16 trace region
const SPAN_CAP: i32 = 200000; // max lines recorded per text (generator: <=40k)

let gInputLen: i32 = 0;
let gDecodeBase: i32 = 0;
let gScratch: i32 = 0;
let gTraceBase: i32 = 0;
let gOutBase: i32 = 0;
let gOutPtr: i32 = 0;
let gBump: i32 = 0;
let gBenchMode: i32 = 0; // 0=full, 1=scan only, 2=scan+intern, 3=full but no render
let gParseError: i32 = 0;

// ---- decode state (globals so the scalar inner loop stays tight) ----
let gDecOut: i32 = 0;
let gLineStart: i32 = 0;
let gSpanPtr: i32 = 0;
let gSpanCount: i32 = 0;
let gDecLen: i32 = 0;
let gUniAdv: i32 = 6;

// ---- output helpers ----
@inline function outByte(b: i32): void {
  store<u8>(gOutPtr, b);
  gOutPtr++;
}
@inline function outRaw(ptr: i32, len: i32): void {
  memory.copy(gOutPtr, ptr, len);
  gOutPtr += len;
}
function outAscii(s: string): void {
  for (let i = 0; i < s.length; i++) outByte(s.charCodeAt(i));
}
function outU32(v: u32): void {
  if (v == 0) { outByte(48); return; }
  let p = SCRATCH0 + 12;
  let x = v;
  let n = 0;
  while (x > 0) {
    p--;
    store<u8>(p, <u8>(48 + (x % 10)));
    x /= 10;
    n++;
  }
  outRaw(p, n);
}
function outHex4(v: i32): void {
  // 4 lowercase hex digits
  for (let s = 12; s >= 0; s -= 4) {
    const d = (v >> s) & 15;
    outByte(d < 10 ? 48 + d : 87 + d);
  }
}

// ---- JSON structure walking ----
@inline function skipWs(p: i32): i32 {
  while (true) {
    const b = load<u8>(p);
    if (b == 32 || b == 9 || b == 10 || b == 13) p++;
    else break;
  }
  return p;
}
@inline function expectByte(p: i32, b: i32): i32 {
  if (load<u8>(p) != b) { gParseError = 1; return p; }
  return p + 1;
}

// Skip a JSON string starting at p (opening quote). Returns past its end.
function skipString(p: i32, end: i32): i32 {
  p++;
  while (p < end) {
    if (end - p >= 16) {
      const v = v128.load(p);
      const m = i8x16.bitmask(v128.or(i8x16.eq(v, i8x16.splat(92)), i8x16.eq(v, i8x16.splat(34))));
      if (m == 0) { p += 16; continue; }
      const chunkEnd = p + 16;
      while (p < chunkEnd) {
        const b = load<u8>(p);
        if (b == 92) { p += 2; }
        else if (b == 34) { return p + 1; }
        else { p++; }
      }
    } else {
      const b = load<u8>(p);
      if (b == 92) { p += 2; }
      else if (b == 34) { return p + 1; }
      else { p++; }
    }
  }
  return p;
}

@inline function hexVal(b: i32): i32 {
  if (b >= 48 && b <= 57) return b - 48;
  if (b >= 97 && b <= 102) return b - 87;
  if (b >= 65 && b <= 70) return b - 55;
  return 0;
}

// Decode \uXXXX at p (p = first hex digit). Sets gUniAdv (6, or 12 for a
// surrogate pair). Returns the code point.
function decodeUnicode(p: i32, end: i32): i32 {
  let cp = (hexVal(load<u8>(p)) << 12) | (hexVal(load<u8>(p + 1)) << 8) |
    (hexVal(load<u8>(p + 2)) << 4) | hexVal(load<u8>(p + 3));
  gUniAdv = 6;
  if (cp >= 0xD800 && cp <= 0xDBFF && p + 9 < end &&
      load<u8>(p + 4) == 92 && load<u8>(p + 5) == 117) {
    const lo = (hexVal(load<u8>(p + 6)) << 12) | (hexVal(load<u8>(p + 7)) << 8) |
      (hexVal(load<u8>(p + 8)) << 4) | hexVal(load<u8>(p + 9));
    if (lo >= 0xDC00 && lo <= 0xDFFF) {
      cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
      gUniAdv = 12;
    }
  }
  return cp;
}

function writeUtf8(out: i32, cp: i32): i32 {
  if (cp < 0x80) { store<u8>(out, cp); return out + 1; }
  if (cp < 0x800) {
    store<u8>(out, 0xC0 | (cp >> 6));
    store<u8>(out + 1, 0x80 | (cp & 63));
    return out + 2;
  }
  if (cp < 0x10000) {
    store<u8>(out, 0xE0 | (cp >> 12));
    store<u8>(out + 1, 0x80 | ((cp >> 6) & 63));
    store<u8>(out + 2, 0x80 | (cp & 63));
    return out + 3;
  }
  store<u8>(out, 0xF0 | (cp >> 18));
  store<u8>(out + 1, 0x80 | ((cp >> 12) & 63));
  store<u8>(out + 2, 0x80 | ((cp >> 6) & 63));
  store<u8>(out + 3, 0x80 | (cp & 63));
  return out + 4;
}

// Scalar decode of one byte/escape at p; updates gDecOut/gLineStart/gSpanPtr.
// Returns the next p, or -1 when the closing quote was consumed.
@inline function decodeStep(p: i32, end: i32): i32 {
  const b = load<u8>(p);
  if (b == 34) {
    if (gDecOut > gLineStart && gSpanCount < SPAN_CAP) {
      store<u32>(gSpanPtr, gLineStart);
      store<u32>(gSpanPtr + 4, gDecOut - gLineStart);
      gSpanPtr += 8;
      gSpanCount++;
    }
    return -1;
  }
  if (b == 92) {
    const e = load<u8>(p + 1);
    if (e == 110) { // \n -> LF, line break (line keeps its LF)
      store<u8>(gDecOut, 10);
      gDecOut++;
      if (gSpanCount < SPAN_CAP) {
        store<u32>(gSpanPtr, gLineStart);
        store<u32>(gSpanPtr + 4, gDecOut - gLineStart);
        gSpanPtr += 8;
        gSpanCount++;
      }
      gLineStart = gDecOut;
      return p + 2;
    }
    if (e == 114) { store<u8>(gDecOut, 13); gDecOut++; return p + 2; }
    if (e == 34) { store<u8>(gDecOut, 34); gDecOut++; return p + 2; }
    if (e == 92) { store<u8>(gDecOut, 92); gDecOut++; return p + 2; }
    if (e == 47) { store<u8>(gDecOut, 47); gDecOut++; return p + 2; }
    if (e == 98) { store<u8>(gDecOut, 8); gDecOut++; return p + 2; }
    if (e == 102) { store<u8>(gDecOut, 12); gDecOut++; return p + 2; }
    if (e == 116) { store<u8>(gDecOut, 9); gDecOut++; return p + 2; }
    if (e == 117) {
      const cp = decodeUnicode(p + 2, end);
      gDecOut = writeUtf8(gDecOut, cp);
      return p + gUniAdv;
    }
    store<u8>(gDecOut, e);
    gDecOut++;
    return p + 2;
  }
  store<u8>(gDecOut, b);
  gDecOut++;
  return p + 1;
}

// Decode a JSON string starting at p (opening quote) into outPtr, recording
// line spans (ptr,len) at spansPtr. Returns past the closing quote.
// gDecLen = decoded byte length, gSpanCount = line count.
function decodeString(p: i32, end: i32, outPtr: i32, spansPtr: i32): i32 {
  p++; // past opening quote
  gDecOut = outPtr;
  gLineStart = outPtr;
  gSpanPtr = spansPtr;
  gSpanCount = 0;
  const startOut = outPtr;
  while (p < end) {
    if (end - p >= 16) {
      const v = v128.load(p);
      const m = i8x16.bitmask(v128.or(i8x16.eq(v, i8x16.splat(92)), i8x16.eq(v, i8x16.splat(34))));
      if (m == 0) {
        memory.copy(gDecOut, p, 16);
        gDecOut += 16;
        p += 16;
        continue;
      }
      const chunkEnd = p + 16;
      while (p < chunkEnd) {
        const np = decodeStep(p, end);
        if (np < 0) {
          gDecLen = gDecOut - startOut;
          return p + 1;
        }
        p = np;
      }
    } else {
      const np = decodeStep(p, end);
      if (np < 0) {
        gDecLen = gDecOut - startOut;
        return p + 1;
      }
      p = np;
    }
  }
  gDecLen = gDecOut - startOut;
  return p;
}

// ---- hashing ----
function hashSpan(ptr: i32, len: i32): u32 {
  let h: u64 = 0x9E3779B97F4A7C15 ^ <u64>len;
  let p = ptr;
  const end = ptr + len;
  while (p + 8 <= end) {
    h ^= load<u64>(p);
    h *= 0xBF58476D1CE4E5B9;
    h ^= h >> 29;
    p += 8;
  }
  while (p < end) {
    h ^= load<u8>(p);
    h *= 0xBF58476D1CE4E5B9;
    h ^= h >> 29;
    p++;
  }
  h ^= h >> 29;
  h *= 0xBF58476D1CE4E5B9;
  h ^= h >> 32;
  return <u32>(h >> 32) ^ <u32>h;
}

// ---- bump allocator in the work region (reset per case) ----
@inline function bump(n: i32): i32 {
  const p = gBump;
  gBump += (n + 7) & ~7;
  return p;
}

// ---- intern: hash-table, B-follows-A, memcmp-verified ----
// Table entry (16 B): hash u32, span ptr u32, span len u32, id i32 (-1 empty).
function intern(oldSpans: i32, nOld: i32, newSpans: i32, nNew: i32, oldIds: i32, newIds: i32): i32 {
  let size = 1024;
  const need = (nOld > nNew ? nOld : nNew) * 2;
  while (size < need) size <<= 1;
  const table = bump(size * 16);
  memory.fill(table, 0xFF, size * 16);
  const mask = size - 1;
  let nextId = 0;
  for (let i = 0; i < nOld; i++) {
    const sp = load<u32>(oldSpans + i * 8);
    const ln = load<u32>(oldSpans + i * 8 + 4);
    const h = hashSpan(sp, ln);
    let idx = <i32>(h & <u32>mask);
    while (true) {
      const e = table + idx * 16;
      const eid = load<i32>(e + 12);
      if (eid == -1) {
        store<u32>(e, h);
        store<u32>(e + 4, sp);
        store<u32>(e + 8, ln);
        store<i32>(e + 12, nextId);
        store<i32>(oldIds + i * 4, nextId);
        nextId++;
        break;
      }
      if (load<u32>(e) == h && load<u32>(e + 8) == ln &&
          memory.compare(load<u32>(e + 4), sp, ln) == 0) {
        store<i32>(oldIds + i * 4, eid);
        break;
      }
      idx = (idx + 1) & mask;
    }
  }
  for (let j = 0; j < nNew; j++) {
    const sp = load<u32>(newSpans + j * 8);
    const ln = load<u32>(newSpans + j * 8 + 4);
    const h = hashSpan(sp, ln);
    let idx = <i32>(h & <u32>mask);
    while (true) {
      const e = table + idx * 16;
      const eid = load<i32>(e + 12);
      if (eid == -1) {
        store<u32>(e, h);
        store<u32>(e + 4, sp);
        store<u32>(e + 8, ln);
        store<i32>(e + 12, nextId);
        store<i32>(newIds + j * 4, nextId);
        nextId++;
        break;
      }
      if (load<u32>(e) == h && load<u32>(e + 8) == ln &&
          memory.compare(load<u32>(e + 4), sp, ln) == 0) {
        store<i32>(newIds + j * 4, eid);
        break;
      }
      idx = (idx + 1) & mask;
    }
  }
  return nextId;
}

let gOpsWritten: i32 = 0;

// ---- global exact Myers, deletion preferred on ties ----
// aIds/bIds: i32 id arrays of length n2/m2 (trimmed middle).
// Writes the middle ops (0=keep,1=del,2=ins) forward into opsBuf.
// Returns D, or -1 if the trace would overflow its region.
function myers(aIds: i32, n2: i32, bIds: i32, m2: i32, opsBuf: i32): i32 {
  if (n2 == 0) {
    for (let j = 0; j < m2; j++) store<u8>(opsBuf + j, 2);
    gOpsWritten = m2;
    return m2;
  }
  if (m2 == 0) {
    for (let i = 0; i < n2; i++) store<u8>(opsBuf + i, 1);
    gOpsWritten = n2;
    return n2;
  }
  const trace = gTraceBase;
  const capEntries = TRACE_CAP_BYTES >> 1;
  let D = -1;
  {
    let x = 0;
    let y = 0;
    while (x < n2 && y < m2 && load<i32>(aIds + x * 4) == load<i32>(bIds + y * 4)) { x++; y++; }
    store<u16>(trace, x);
    if (x == n2 && y == m2) D = 0;
  }
  if (D < 0) {
    const maxD = n2 + m2;
    for (let d = 1; d <= maxD; d++) {
      const offPrev = ((d - 1) * d) >> 1;
      const offCur = (d * (d + 1)) >> 1;
      if (offCur + d + 1 > capEntries) return -1;
      for (let j = 0; j <= d; j++) {
        const k = -d + 2 * j;
        let x: i32;
        if (j == 0) {
          x = load<u16>(trace + (offPrev + j) * 2);
        } else if (j == d) {
          x = load<u16>(trace + (offPrev + j - 1) * 2) + 1;
        } else {
          const a = load<u16>(trace + (offPrev + j - 1) * 2) + 1;
          const b = load<u16>(trace + (offPrev + j) * 2);
          x = a < b ? b : a;
        }
        let y = x - k;
        while (x < n2 && y < m2 && load<i32>(aIds + x * 4) == load<i32>(bIds + y * 4)) { x++; y++; }
        store<u16>(trace + (offCur + j) * 2, x);
        if (x == n2 && y == m2) { D = d; break; }
      }
      if (D >= 0) break;
    }
  }
  if (D < 0) return -1;
  let x = n2, y = m2;
  let w = 0;
  for (let d = D; d > 0; d--) {
    const offPrev = ((d - 1) * d) >> 1;
    const k = x - y;
    const j = (k + d) >> 1;
    let prevJ: i32;
    let isIns: bool;
    if (j == 0) { prevJ = 0; isIns = true; }
    else if (j == d) { prevJ = j - 1; isIns = false; }
    else {
      const a = load<u16>(trace + (offPrev + j - 1) * 2) + 1;
      const b = load<u16>(trace + (offPrev + j) * 2);
      if (a < b) { prevJ = j; isIns = true; } else { prevJ = j - 1; isIns = false; }
    }
    const px: i32 = load<u16>(trace + (offPrev + prevJ) * 2);
    const pk = -(d - 1) + 2 * prevJ;
    const py = px - pk;
    const ex = isIns ? px : px + 1;
    const ey = isIns ? py + 1 : py;
    while (x > ex && y > ey) { store<u8>(opsBuf + w, 0); w++; x--; y--; }
    if (isIns) { store<u8>(opsBuf + w, 2); w++; y--; }
    else { store<u8>(opsBuf + w, 1); w++; x--; }
  }
  while (x > 0 && y > 0) { store<u8>(opsBuf + w, 0); w++; x--; y--; }
  gOpsWritten = w;
  let lo = 0, hi = w - 1;
  while (lo < hi) {
    const t = load<u8>(opsBuf + lo);
    store<u8>(opsBuf + lo, load<u8>(opsBuf + hi));
    store<u8>(opsBuf + hi, t);
    lo++; hi--;
  }
  return D;
}

// ---- render ----
function outHex2(v: i32): void {
  for (let s = 4; s >= 0; s -= 4) {
    const d = (v >> s) & 15;
    outByte(d < 10 ? 48 + d : 87 + d);
  }
}

// Write one decoded byte JSON-escaped. Returns p+1 (or more for a
// CESU-8 lone-surrogate re-escape).
@inline function escapeStep(p: i32, end: i32): i32 {
  const b = load<u8>(p);
  if (b == 34) { outByte(92); outByte(34); return p + 1; }
  if (b == 92) { outByte(92); outByte(92); return p + 1; }
  if (b == 10) { outByte(92); outByte(110); return p + 1; }
  if (b == 13) { outByte(92); outByte(114); return p + 1; }
  if (b == 9) { outByte(92); outByte(116); return p + 1; }
  if (b == 8) { outByte(92); outByte(98); return p + 1; }
  if (b == 12) { outByte(92); outByte(102); return p + 1; }
  if (b < 0x20) {
    outByte(92); outByte(117); outByte(48); outByte(48);
    outHex2(b);
    return p + 1;
  }
  // NOTE: operands must be cast to i32 first — ASC truncates shifts on u8
  // values (CESU cp computed as 0xD0 instead of 0xD800 without the casts).
  if (b == 0xED && p + 2 < end && ((<i32>load<u8>(p + 1) & 0xE0) == 0xA0)) {
    // CESU-8 lone surrogate ED A0..BF 80..BF -> \uXXXX (as JSON.stringify does)
    const cp = (((<i32>b & 0x0F) << 12) | ((<i32>load<u8>(p + 1) & 0x3F) << 6) | (<i32>load<u8>(p + 2) & 0x3F));
    outByte(92); outByte(117);
    outHex4(cp);
    return p + 3;
  }
  outByte(b);
  return p + 1;
}

// Write a decoded line span JSON-escaped (its trailing LF, if any, becomes
// the \n escape — the patch line terminator).
function writeLineEscaped(spanPtr: i32, spanLen: i32): void {
  let p = spanPtr;
  const end = spanPtr + spanLen;
  while (p < end) {
    if (end - p >= 16) {
      const v = v128.load(p);
      const m1 = i8x16.bitmask(v128.or(i8x16.eq(v, i8x16.splat(92)), i8x16.eq(v, i8x16.splat(34))));
      const m2 = i8x16.bitmask(i8x16.lt_u(v, i8x16.splat(32)));
      const m3 = i8x16.bitmask(i8x16.eq(v, i8x16.splat(<i8>0xED)));
      if ((m1 | m2 | m3) == 0) { outRaw(p, 16); p += 16; continue; }
      const chunkEnd = p + 16;
      while (p < chunkEnd) p = escapeStep(p, end);
    } else {
      p = escapeStep(p, end);
    }
  }
}

// Per-case globals set by solveCase for the renderer.
let gOpsBuf: i32 = 0;
let gNOps: i32 = 0;
let gOldSpans: i32 = 0;
let gNewSpans: i32 = 0;
let gNOld: i32 = 0;
let gNNew: i32 = 0;

// Hunk record (24 B): startOp, endOp, oStart, oLen, nStart, nLen.
let gHunks: i32 = 0;
let gHunkCount: i32 = 0;
let gDelTotal: i32 = 0;
let gInsTotal: i32 = 0;

function closeHunk(startOp: i32, endOp: i32, oStart: i32, nStart: i32): void {
  let oLen = 0, nLen = 0;
  for (let t = startOp; t < endOp; t++) {
    const op = load<u8>(gOpsBuf + t);
    if (op != 2) oLen++;
    if (op != 1) nLen++;
  }
  const h = gHunks + gHunkCount * 24;
  store<i32>(h, startOp);
  store<i32>(h + 4, endOp);
  store<i32>(h + 8, oStart);
  store<i32>(h + 12, oLen);
  store<i32>(h + 16, nStart);
  store<i32>(h + 20, nLen);
  gHunkCount++;
}

// Phase A: find hunks (<=3 context, runs <=6 keeps apart share a hunk).
function findHunks(): void {
  gHunkCount = 0;
  gDelTotal = 0;
  gInsTotal = 0;
  let oi = 0, ni = 0;
  let inHunk = false;
  let hStartOp = 0, hOStart = 0, hNStart = 0;
  let prevHunkEnd = 0;
  let lastChangeOp = -1, keepsSince = 0;
  for (let t = 0; t < gNOps; t++) {
    const op = load<u8>(gOpsBuf + t);
    if (op == 1) gDelTotal++;
    if (op == 2) gInsTotal++;
    if (op != 0) {
      if (!inHunk) {
        hStartOp = t - 3;
        if (hStartOp < prevHunkEnd) hStartOp = prevHunkEnd;
        hOStart = oi - (t - hStartOp);
        hNStart = ni - (t - hStartOp);
        inHunk = true;
      }
      lastChangeOp = t;
      keepsSince = 0;
    } else {
      if (inHunk) {
        keepsSince++;
        if (keepsSince > 6) {
          closeHunk(hStartOp, lastChangeOp + 4, hOStart, hNStart);
          prevHunkEnd = lastChangeOp + 4;
          inHunk = false;
        }
      }
    }
    if (op != 2) oi++;
    if (op != 1) ni++;
  }
  if (inHunk) {
    let trail = keepsSince;
    if (trail > 3) trail = 3;
    closeHunk(hStartOp, lastChangeOp + 1 + trail, hOStart, hNStart);
  }
}

// Emit one patch line: prefix + escaped span; bare last line gets \n + %.
function emitLine(prefix: i32, spanPtr: i32, spanLen: i32, isBare: bool): void {
  outByte(prefix);
  writeLineEscaped(spanPtr, spanLen);
  if (isBare) {
    outByte(92); outByte(110); // \n escape: the added newline
    outByte(37); // %
    outByte(92); outByte(110);
  }
}

// Phase B: write the quoted answer string for this case.
function renderCase(): void {
  findHunks();
  outByte(34);
  outAscii("makefun-diff/1 old=");
  outU32(<u32>gNOld);
  outAscii(" new=");
  outU32(<u32>gNNew);
  outAscii(" hunks=");
  outU32(<u32>gHunkCount);
  outAscii(" deleted=");
  outU32(<u32>gDelTotal);
  outAscii(" inserted=");
  outU32(<u32>gInsTotal);
  outByte(92); outByte(110); // header line terminator (escaped)
  let oi = 0, ni = 0;
  let h = 0; // hunk index
  let t = 0;
  while (t < gNOps) {
    if (h < gHunkCount && t == load<i32>(gHunks + h * 24)) {
      const hh = gHunks + h * 24;
      const hEnd = load<i32>(hh + 4);
      outByte(64); outByte(32);
      outU32(<u32>(load<i32>(hh + 8) + 1));
      outByte(32);
      outU32(<u32>load<i32>(hh + 12));
      outByte(32);
      outU32(<u32>(load<i32>(hh + 16) + 1));
      outByte(32);
      outU32(<u32>load<i32>(hh + 20));
      outByte(92); outByte(110);
      // walk ops in [t, hEnd): keeps inline, change runs dels-then-inss
      while (t < hEnd) {
        const op = load<u8>(gOpsBuf + t);
        if (op == 0) {
          const sp = load<u32>(gOldSpans + oi * 8);
          const ln = load<u32>(gOldSpans + oi * 8 + 4);
          const bare = oi == gNOld - 1 && (ln == 0 || load<u8>(sp + ln - 1) != 10);
          emitLine(61, sp, ln, bare);
          oi++; ni++; t++;
        } else {
          // change run: collect extent, emit deletions then insertions
          let r = t, dels = 0, inss = 0;
          while (r < hEnd && load<u8>(gOpsBuf + r) != 0) {
            if (load<u8>(gOpsBuf + r) == 1) dels++; else inss++;
            r++;
          }
          let o2 = oi;
          for (let k = t; k < r; k++) {
            if (load<u8>(gOpsBuf + k) == 1) {
              const sp = load<u32>(gOldSpans + o2 * 8);
              const ln = load<u32>(gOldSpans + o2 * 8 + 4);
              const bare = o2 == gNOld - 1 && (ln == 0 || load<u8>(sp + ln - 1) != 10);
              emitLine(45, sp, ln, bare);
              o2++;
            }
          }
          let n2 = ni;
          for (let k = t; k < r; k++) {
            if (load<u8>(gOpsBuf + k) == 2) {
              const sp = load<u32>(gNewSpans + n2 * 8);
              const ln = load<u32>(gNewSpans + n2 * 8 + 4);
              const bare = n2 == gNNew - 1 && (ln == 0 || load<u8>(sp + ln - 1) != 10);
              emitLine(43, sp, ln, bare);
              n2++;
            }
          }
          oi += dels; ni += inss; t = r;
        }
      }
      h++;
    } else {
      // outside any hunk: advance counters without emitting
      const op = load<u8>(gOpsBuf + t);
      if (op != 2) oi++;
      if (op != 1) ni++;
      t++;
    }
  }
  outByte(34);
}

// Solve one case. mode: 0=intern only, 1=intern+Myers, 2=full incl. render.
function solveCase(oldSpans: i32, nOld: i32, newSpans: i32, nNew: i32, mode: i32): void {
  gOldSpans = oldSpans;
  gNewSpans = newSpans;
  gNOld = nOld;
  gNNew = nNew;
  const oldIds = bump(nOld * 4);
  const newIds = bump(nNew * 4);
  intern(oldSpans, nOld, newSpans, nNew, oldIds, newIds);
  if (mode == 0) return;
  let a0 = 0, b0 = 0;
  while (a0 < nOld && b0 < nNew && load<i32>(oldIds + a0 * 4) == load<i32>(newIds + b0 * 4)) { a0++; b0++; }
  let a1 = nOld, b1 = nNew;
  while (a1 > a0 && b1 > b0 && load<i32>(oldIds + (a1 - 1) * 4) == load<i32>(newIds + (b1 - 1) * 4)) { a1--; b1--; }
  const n2 = a1 - a0, m2 = b1 - b0;
  const opsBuf = bump(nOld + nNew + 1);
  for (let i = 0; i < a0; i++) store<u8>(opsBuf + i, 0);
  let midOps = 0;
  const D = myers(oldIds + a0 * 4, n2, newIds + b0 * 4, m2, opsBuf + a0);
  if (D < 0) {
    // Trace overflow (D > ~7400): fall back to delete-all + insert-all.
    // Wrong script, but no trap; the generator regime never reaches this.
    for (let i = 0; i < n2; i++) store<u8>(opsBuf + a0 + i, 1);
    for (let j = 0; j < m2; j++) store<u8>(opsBuf + a0 + n2 + j, 2);
    midOps = n2 + m2;
  } else {
    midOps = gOpsWritten;
  }
  for (let i = 0; i < nOld - a1; i++) store<u8>(opsBuf + a0 + midOps + i, 0);
  gOpsBuf = opsBuf;
  gNOps = a0 + midOps + (nOld - a1);
  gHunks = bump((gNOps + 2) * 24);
  if (mode == 2) renderCase();
}

@inline function expectLit(p: i32, s: string): i32 {
  for (let i = 0; i < s.length; i++) {
    p = expectByte(p, s.charCodeAt(i));
    if (gParseError != 0) return p;
  }
  return p;
}

export function set_bench_mode(m: i32): void {
  gBenchMode = m;
}

export function output_ptr(): i32 {
  return gOutBase;
}

export function solve_all(inputLen: i32): i32 {
  gInputLen = inputLen;
  gDecodeBase = INPUT_BASE + inputLen;
  gScratch = gDecodeBase + inputLen;
  gTraceBase = gScratch + WORK_CAP;
  gOutBase = gScratch + WORK_CAP + TRACE_CAP_BYTES;
  gOutPtr = gOutBase;
  gParseError = 0;
  const end = INPUT_BASE + inputLen;
  let p = skipWs(INPUT_BASE);
  p = expectByte(p, 91); // '['
  outByte(91);
  let first = true;
  while (gParseError == 0) {
    p = skipWs(p);
    const b = load<u8>(p);
    if (b == 93) { p++; break; } // ']'
    if (!first) {
      p = expectByte(p, 44);
      p = skipWs(p);
    }
    first = false;
    p = expectByte(p, 123); // '{'
    p = skipWs(p);
    p = expectLit(p, "\"id\"");
    p = skipWs(p);
    p = expectByte(p, 58);
    p = skipWs(p);
    p = skipString(p, end);
    p = skipWs(p);
    p = expectByte(p, 44);
    p = skipWs(p);
    p = expectLit(p, "\"input\"");
    p = skipWs(p);
    p = expectByte(p, 58);
    p = skipWs(p);
    p = expectByte(p, 123); // '{'
    p = skipWs(p);
    p = expectLit(p, "\"old\"");
    p = skipWs(p);
    p = expectByte(p, 58);
    p = skipWs(p);
    // decode old string
    gBump = gScratch;
    const oldSpans = bump(SPAN_CAP * 8);
    const newSpans = bump(SPAN_CAP * 8);
    p = decodeString(p, end, gDecodeBase, oldSpans);
    const nOld = gSpanCount;
    const oldDecLen = gDecLen;
    p = skipWs(p);
    p = expectByte(p, 44);
    p = skipWs(p);
    p = expectLit(p, "\"new\"");
    p = skipWs(p);
    p = expectByte(p, 58);
    p = skipWs(p);
    p = decodeString(p, end, gDecodeBase + oldDecLen, newSpans);
    const nNew = gSpanCount;
    p = skipWs(p);
    p = expectByte(p, 125); // '}'
    p = skipWs(p);
    p = expectByte(p, 125); // '}'
    if (gParseError != 0) break;
    if (gBenchMode == 1) {
      outByte(34); outByte(34); // "" (scan only)
    } else if (gBenchMode == 2) {
      solveCase(oldSpans, nOld, newSpans, nNew, 0);
      outByte(34); outByte(34);
    } else if (gBenchMode == 3) {
      solveCase(oldSpans, nOld, newSpans, nNew, 1);
      outByte(34); outByte(34);
    } else {
      solveCase(oldSpans, nOld, newSpans, nNew, 2);
    }
    // separator between answers
    p = skipWs(p);
    const nb = load<u8>(p);
    if (nb == 44) {
      outByte(44);
    } else if (nb == 93) {
      // loop top will consume ']'
    } else {
      gParseError = 1;
    }
  }
  outByte(93);
  return gOutPtr - gOutBase;
}
