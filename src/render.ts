// render.ts — patch renderer.
// Walks the virtual op stream (pre keeps, middle ops bytes, suf keeps),
// groups change runs into hunks (<=3 context, merge runs <=6 kept apart),
// and writes one case's answer as a JSON string (with surrounding quotes)
// into the output area. Two line modes: raw (fast path — span bytes are
// already JSON-escaped, copied verbatim) and escape (slow path — UTF-16
// spans in the decode buffer, JSON-escaped on the fly, lone surrogates as
// \udXXX, pairs as UTF-8). A bare line (no trailing newline) is written
// with one and followed by a % line.

function writeU32(outPtr: i32, pos: i32, value: i32, tmpPtr: i32): i32 {
  if (value == 0) {
    store<u8>(outPtr + pos, 0x30);
    return pos + 1;
  }
  let n: i32 = 0;
  let v: i32 = value;
  while (v > 0) {
    store<u8>(tmpPtr + n, 0x30 + (v % 10));
    v = v / 10;
    n++;
  }
  let p: i32 = pos;
  for (let i = n - 1; i >= 0; i--) {
    store<u8>(outPtr + p, load<u8>(tmpPtr + i));
    p++;
  }
  return p;
}

function writeByte(outPtr: i32, pos: i32, b: i32): i32 {
  store<u8>(outPtr + pos, b);
  return pos + 1;
}

function writeEscapedNewline(outPtr: i32, pos: i32): i32 {
  pos = writeByte(outPtr, pos, 0x5c);
  pos = writeByte(outPtr, pos, 0x6e);
  return pos;
}

function hexDigit(v: i32): i32 {
  return v < 10 ? 0x30 + v : 0x61 + (v - 10);
}

function writeHex4(outPtr: i32, pos: i32, v: i32): i32 {
  pos = writeByte(outPtr, pos, hexDigit((v >> 12) & 0xf));
  pos = writeByte(outPtr, pos, hexDigit((v >> 8) & 0xf));
  pos = writeByte(outPtr, pos, hexDigit((v >> 4) & 0xf));
  pos = writeByte(outPtr, pos, hexDigit(v & 0xf));
  return pos;
}

// Write one line's content from its span. Returns new pos.
// rawMode=1: copy span bytes verbatim. rawMode=0: UTF-16 span, JSON-escape.
function writeLineContent(
  outPtr: i32,
  pos: i32,
  srcPtr: i32,
  spanStart: i32,
  spanLen: i32,
  rawMode: i32,
): i32 {
  if (rawMode == 1) {
    memory.copy(outPtr + pos, srcPtr + spanStart, spanLen);
    return pos + spanLen;
  }
  let p: i32 = srcPtr + spanStart;
  const end: i32 = p + spanLen;
  while (p < end) {
    const cu: i32 = load<u16>(p);
    p += 2;
    if (cu == 0x22) {
      pos = writeByte(outPtr, pos, 0x5c);
      pos = writeByte(outPtr, pos, 0x22);
    } else if (cu == 0x5c) {
      pos = writeByte(outPtr, pos, 0x5c);
      pos = writeByte(outPtr, pos, 0x5c);
    } else if (cu == 0x0a) {
      pos = writeEscapedNewline(outPtr, pos);
    } else if (cu == 0x0d) {
      pos = writeByte(outPtr, pos, 0x5c);
      pos = writeByte(outPtr, pos, 0x72);
    } else if (cu == 0x09) {
      pos = writeByte(outPtr, pos, 0x5c);
      pos = writeByte(outPtr, pos, 0x74);
    } else if (cu == 0x08) {
      pos = writeByte(outPtr, pos, 0x5c);
      pos = writeByte(outPtr, pos, 0x62);
    } else if (cu == 0x0c) {
      pos = writeByte(outPtr, pos, 0x5c);
      pos = writeByte(outPtr, pos, 0x66);
    } else if (cu < 0x20) {
      pos = writeByte(outPtr, pos, 0x5c);
      pos = writeByte(outPtr, pos, 0x75);
      pos = writeByte(outPtr, pos, 0x30);
      pos = writeByte(outPtr, pos, 0x30);
      pos = writeByte(outPtr, pos, hexDigit((cu >> 4) & 0xf));
      pos = writeByte(outPtr, pos, hexDigit(cu & 0xf));
    } else if (cu >= 0xd800 && cu <= 0xdbff) {
      if (p < end) {
        const cu2: i32 = load<u16>(p);
        if (cu2 >= 0xdc00 && cu2 <= 0xdfff) {
          const cp: i32 =
            0x10000 + ((cu - 0xd800) << 10) + (cu2 - 0xdc00);
          pos = writeByte(outPtr, pos, 0xf0 | (cp >> 18));
          pos = writeByte(outPtr, pos, 0x80 | ((cp >> 12) & 0x3f));
          pos = writeByte(outPtr, pos, 0x80 | ((cp >> 6) & 0x3f));
          pos = writeByte(outPtr, pos, 0x80 | (cp & 0x3f));
          p += 2;
          continue;
        }
      }
      pos = writeByte(outPtr, pos, 0x5c);
      pos = writeByte(outPtr, pos, 0x75);
      pos = writeHex4(outPtr, pos, cu);
    } else if (cu >= 0xdc00 && cu <= 0xdfff) {
      pos = writeByte(outPtr, pos, 0x5c);
      pos = writeByte(outPtr, pos, 0x75);
      pos = writeHex4(outPtr, pos, cu);
    } else if (cu < 0x80) {
      pos = writeByte(outPtr, pos, cu);
    } else if (cu < 0x800) {
      pos = writeByte(outPtr, pos, 0xc0 | (cu >> 6));
      pos = writeByte(outPtr, pos, 0x80 | (cu & 0x3f));
    } else {
      pos = writeByte(outPtr, pos, 0xe0 | (cu >> 12));
      pos = writeByte(outPtr, pos, 0x80 | ((cu >> 6) & 0x3f));
      pos = writeByte(outPtr, pos, 0x80 | (cu & 0x3f));
    }
  }
  return pos;
}

// True when the span's line ends with a newline (raw: trailing \n escape;
// UTF-16: trailing 0x000A code unit).
function spanHasNewline(
  srcPtr: i32,
  spanStart: i32,
  spanLen: i32,
  rawMode: i32,
): bool {
  if (spanLen == 0) return false;
  if (rawMode == 1) {
    return (
      spanLen >= 2 &&
      load<u8>(srcPtr + spanStart + spanLen - 2) == 0x5c &&
      load<u8>(srcPtr + spanStart + spanLen - 1) == 0x6e
    );
  }
  return load<u16>(srcPtr + spanStart + spanLen - 2) == 0x000a;
}

function opAt(opsPtr: i32, opsLen: i32, pre: i32, t: i32): i32 {
  if (t < pre) return 0;
  if (t < pre + opsLen) return load<u8>(opsPtr + (t - pre));
  return 0;
}

export function renderCase(
  opsPtr: i32,
  opsLen: i32,
  pre: i32,
  suf: i32,
  nOld: i32,
  nNew: i32,
  spansOldPtr: i32,
  spansNewPtr: i32,
  srcPtr: i32,
  rawMode: i32,
  outPtr: i32,
  tmpPtr: i32,
): i32 {
  const totalOps: i32 = pre + opsLen + suf;
  let dele: i32 = 0;
  let inse: i32 = 0;
  for (let i = 0; i < opsLen; i++) {
    const o: i32 = load<u8>(opsPtr + i);
    if (o == 1) dele++;
    else if (o == 2) inse++;
  }
  // Collect change runs, merge runs <=6 keeps apart, extend by 3 context.
  // Hunk bounds stored as (start, end) op indices at tmpPtr + 64, 8 bytes each.
  const hunksPtr: i32 = tmpPtr + 64;
  let nHunks: i32 = 0;
  let t: i32 = 0;
  while (t < totalOps) {
    if (opAt(opsPtr, opsLen, pre, t) != 0) {
      let a: i32 = t;
      let b: i32 = t;
      while (b < totalOps && opAt(opsPtr, opsLen, pre, b) != 0) b++;
      if (nHunks > 0) {
        const ps: i32 = load<i32>(hunksPtr + (nHunks - 1) * 8);
        const pe: i32 = load<i32>(hunksPtr + (nHunks - 1) * 8 + 4);
        // pe is the previous run's end (exclusive, in run coords); the
        // kept gap between runs is a - pe.
        if (a - pe <= 6) {
          store<i32>(hunksPtr + (nHunks - 1) * 8 + 4, b);
          t = b;
          continue;
        }
      }
      store<i32>(hunksPtr + nHunks * 8, a);
      store<i32>(hunksPtr + nHunks * 8 + 4, b);
      nHunks++;
      t = b;
    } else {
      t++;
    }
  }
  let pos: i32 = 0;
  pos = writeByte(outPtr, pos, 0x22); // opening quote
  // Header: makefun-diff/1 old=N new=M hunks=H deleted=D inserted=I
  const hdr: string = "makefun-diff/1 old=";
  for (let i = 0; i < hdr.length; i++) {
    pos = writeByte(outPtr, pos, hdr.charCodeAt(i));
  }
  pos = writeU32(outPtr, pos, nOld, tmpPtr);
  pos = writeByte(outPtr, pos, 0x20);
  const hdr2: string = "new=";
  for (let i = 0; i < hdr2.length; i++) {
    pos = writeByte(outPtr, pos, hdr2.charCodeAt(i));
  }
  pos = writeU32(outPtr, pos, nNew, tmpPtr);
  pos = writeByte(outPtr, pos, 0x20);
  const hdr3: string = "hunks=";
  for (let i = 0; i < hdr3.length; i++) {
    pos = writeByte(outPtr, pos, hdr3.charCodeAt(i));
  }
  pos = writeU32(outPtr, pos, nHunks, tmpPtr);
  pos = writeByte(outPtr, pos, 0x20);
  const hdr4: string = "deleted=";
  for (let i = 0; i < hdr4.length; i++) {
    pos = writeByte(outPtr, pos, hdr4.charCodeAt(i));
  }
  pos = writeU32(outPtr, pos, dele, tmpPtr);
  pos = writeByte(outPtr, pos, 0x20);
  const hdr5: string = "inserted=";
  for (let i = 0; i < hdr5.length; i++) {
    pos = writeByte(outPtr, pos, hdr5.charCodeAt(i));
  }
  pos = writeU32(outPtr, pos, inse, tmpPtr);
  pos = writeEscapedNewline(outPtr, pos);
  // Single cursor pass: (ck, oi, oj) advance monotonically across hunks.
  // (The old code rescanned all ops from 0 for every hunk: O(hunks*ops).)
  let ck: i32 = 0;
  let oi: i32 = 0;
  let oj: i32 = 0;
  for (let h = 0; h < nHunks; h++) {
    const ra: i32 = load<i32>(hunksPtr + h * 8);
    const rb: i32 = load<i32>(hunksPtr + h * 8 + 4);
    const hs: i32 = ra - 3 < 0 ? 0 : ra - 3;
    const he: i32 = rb + 3 > totalOps ? totalOps : rb + 3;
    // Old/new lines before the hunk (advance cursors from the last hunk).
    while (ck < hs) {
      const o: i32 = opAt(opsPtr, opsLen, pre, ck);
      if (o != 2) oi++;
      if (o != 1) oj++;
      ck++;
    }
    const oBefore: i32 = oi;
    const nBefore: i32 = oj;
    let ol: i32 = 0;
    let nl: i32 = 0;
    for (let k = hs; k < he; k++) {
      const o: i32 = opAt(opsPtr, opsLen, pre, k);
      if (o != 2) ol++;
      if (o != 1) nl++;
    }
    pos = writeByte(outPtr, pos, 0x40); // @
    pos = writeByte(outPtr, pos, 0x20);
    pos = writeU32(outPtr, pos, oBefore + 1, tmpPtr);
    pos = writeByte(outPtr, pos, 0x20);
    pos = writeU32(outPtr, pos, ol, tmpPtr);
    pos = writeByte(outPtr, pos, 0x20);
    pos = writeU32(outPtr, pos, nBefore + 1, tmpPtr);
    pos = writeByte(outPtr, pos, 0x20);
    pos = writeU32(outPtr, pos, nl, tmpPtr);
    pos = writeEscapedNewline(outPtr, pos);
    // Walk the hunk's ops with the running cursors (oi/oj already at hs).
    let k: i32 = hs;
    while (k < he) {
      const o: i32 = opAt(opsPtr, opsLen, pre, k);
      if (o == 0) {
        const s: i32 = load<i32>(spansOldPtr + oi * 8);
        const l: i32 = load<i32>(spansOldPtr + oi * 8 + 4);
        pos = writeByte(outPtr, pos, 0x3d); // =
        pos = writeLineContent(outPtr, pos, srcPtr, s, l, rawMode);
        if (!spanHasNewline(srcPtr, s, l, rawMode)) {
          pos = writeEscapedNewline(outPtr, pos);
          pos = writeByte(outPtr, pos, 0x25); // %
          pos = writeEscapedNewline(outPtr, pos);
        }
        oi++;
        oj++;
        k++;
      } else {
        let j: i32 = k;
        while (j < he && opAt(opsPtr, opsLen, pre, j) != 0) j++;
        // Deletions first.
        let dOi: i32 = oi;
        for (let q = k; q < j; q++) {
          if (opAt(opsPtr, opsLen, pre, q) == 1) {
            const s: i32 = load<i32>(spansOldPtr + dOi * 8);
            const l: i32 = load<i32>(spansOldPtr + dOi * 8 + 4);
            pos = writeByte(outPtr, pos, 0x2d); // -
            pos = writeLineContent(outPtr, pos, srcPtr, s, l, rawMode);
            if (!spanHasNewline(srcPtr, s, l, rawMode)) {
              pos = writeEscapedNewline(outPtr, pos);
              pos = writeByte(outPtr, pos, 0x25);
              pos = writeEscapedNewline(outPtr, pos);
            }
            dOi++;
          }
        }
        let iOj: i32 = oj;
        for (let q = k; q < j; q++) {
          if (opAt(opsPtr, opsLen, pre, q) == 2) {
            const s: i32 = load<i32>(spansNewPtr + iOj * 8);
            const l: i32 = load<i32>(spansNewPtr + iOj * 8 + 4);
            pos = writeByte(outPtr, pos, 0x2b); // +
            pos = writeLineContent(outPtr, pos, srcPtr, s, l, rawMode);
            if (!spanHasNewline(srcPtr, s, l, rawMode)) {
              pos = writeEscapedNewline(outPtr, pos);
              pos = writeByte(outPtr, pos, 0x25);
              pos = writeEscapedNewline(outPtr, pos);
            }
            iOj++;
          }
        }
        oi = dOi;
        oj = iOj;
        k = j;
      }
    }
    ck = he;
  }
  pos = writeByte(outPtr, pos, 0x22); // closing quote
  return pos;
}
