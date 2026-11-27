// scan.ts — zero-copy raw-JSON scanning.
// Finds each case's old/new string spans by SIMD quote search, then splits
// lines as raw spans. A line break is the two-byte escape backslash-n; the
// span includes its trailing break. A backslash-u escape anywhere aborts the
// fast path for that case (resPtr[2] = 1) so the decoded slow path runs.
// A bare '"' byte never occurs inside a string span (quotes are escaped),
// so marker search by bare quote is exact.

// Check the field marker at quote position q: "old": or "new": followed by
// optional whitespace and the opening quote of the value string. Returns
// the content start (just past that quote), or -1.
function matchMarker(q: i32, end: i32, which: i32): i32 {
  if (q + 5 >= end) return -1;
  const c1: i32 = load<u8>(q + 1);
  const c2: i32 = load<u8>(q + 2);
  const c3: i32 = load<u8>(q + 3);
  if (which == 0) {
    if (c1 != 0x6f || c2 != 0x6c || c3 != 0x64) return -1;
  } else {
    if (c1 != 0x6e || c2 != 0x65 || c3 != 0x77) return -1;
  }
  if (load<u8>(q + 4) != 0x22 || load<u8>(q + 5) != 0x3a) return -1;
  let j: i32 = q + 6;
  while (j < end && (load<u8>(j) == 0x20 || load<u8>(j) == 0x09)) j++;
  if (j >= end || load<u8>(j) != 0x22) return -1;
  return j + 1;
}

export function findMarker(from: i32, end: i32, which: i32): i32 {
  // Returns the content start (just past the opening quote of the value
  // string) for "old":"..." (which=0) or "new":"..." (which=1), or -1.
  const QU: v128 = i8x16.splat(0x22);
  let p: i32 = from;
  while (p + 16 <= end) {
    const m: i32 = i8x16.bitmask(i8x16.eq(v128.load(p), QU));
    if (m != 0) {
      let mm: i32 = m;
      while (mm != 0) {
        const b: i32 = ctz(mm);
        const q: i32 = p + b;
        const hit: i32 = matchMarker(q, end, which);
        if (hit >= 0) return hit;
        mm &= mm - 1;
      }
    }
    p += 16;
  }
  while (p < end) {
    if (load<u8>(p) == 0x22) {
      const hit: i32 = matchMarker(p, end, which);
      if (hit >= 0) return hit;
    }
    p++;
  }
  return -1;
}

// Split the JSON string content starting at `start` into line spans.
// Writes (start, len) i32 pairs at spansPtr. resPtr[0] = line count,
// resPtr[1] = index of the closing quote, resPtr[2] = 1 if any \u escape
// was seen. Returns line count, or -1 if no closing quote was found.
export function splitLines(
  start: i32,
  end: i32,
  spansPtr: i32,
  resPtr: i32,
): i32 {
  const BS: v128 = i8x16.splat(0x5c);
  const QU: v128 = i8x16.splat(0x22);
  let count: i32 = 0;
  let lineStart: i32 = start;
  let hasUnicode: i32 = 0;
  let p: i32 = start;
  let close: i32 = -1;
  while (p + 16 <= end) {
    const v: v128 = v128.load(p);
    let mB: i32 = i8x16.bitmask(i8x16.eq(v, BS));
    let mQ: i32 = i8x16.bitmask(i8x16.eq(v, QU));
    let lastEsc: i32 = -1;
    while ((mB | mQ) != 0) {
      const combined: i32 = mB | mQ;
      const b: i32 = ctz(combined);
      const pos: i32 = p + b;
      if ((mB & (1 << b)) != 0) {
        if (pos + 1 >= end) return -1;
        // Escape at pos: next byte decides.
        const e: i32 = load<u8>(pos + 1);
        if (e == 0x6e) {
          // backslash-n: line break; span includes the escape.
          store<i32>(spansPtr + count * 8, lineStart);
          store<i32>(spansPtr + count * 8 + 4, pos + 2 - lineStart);
          count++;
          lineStart = pos + 2;
        } else if (e == 0x75) {
          hasUnicode = 1;
        }
        lastEsc = pos;
        // Mask off bits at or below the escaped byte (pos and pos+1).
        const cut: i32 = b + 2;
        if (cut >= 16) {
          mB = 0;
          mQ = 0;
        } else {
          const keep: i32 = -1 << cut;
          mB &= keep;
          mQ &= keep;
        }
      } else {
        // Unescaped quote: end of the string.
        close = pos;
        mB = 0;
        mQ = 0;
        p = end;
        break;
      }
    }
    if (close >= 0) break;
    // If the last escape sat at the chunk's final byte, its escaped byte is
    // the next chunk's first byte: skip it.
    if (lastEsc == p + 15) {
      p += 17;
    } else {
      p += 16;
    }
  }
  if (close < 0) {
    while (p < end) {
      const c: i32 = load<u8>(p);
      if (c == 0x5c) {
        if (p + 1 >= end) return -1;
        const e: i32 = load<u8>(p + 1);
        if (e == 0x6e) {
          store<i32>(spansPtr + count * 8, lineStart);
          store<i32>(spansPtr + count * 8 + 4, p + 2 - lineStart);
          count++;
          lineStart = p + 2;
        } else if (e == 0x75) {
          hasUnicode = 1;
        }
        p += 2;
      } else if (c == 0x22) {
        close = p;
        break;
      } else {
        p++;
      }
    }
  }
  if (close < 0) return -1;
  if (lineStart < close) {
    store<i32>(spansPtr + count * 8, lineStart);
    store<i32>(spansPtr + count * 8 + 4, close - lineStart);
    count++;
  }
  store<i32>(resPtr, count);
  store<i32>(resPtr + 4, close);
  store<i32>(resPtr + 8, hasUnicode);
  return count;
}
