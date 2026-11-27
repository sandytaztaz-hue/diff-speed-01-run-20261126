// diff.ts — entry driver.
// Layout (all offsets from scratchBase = align16(inLen + 16)):
//   res area, combined line spans, id arrays, intern scratch, V array,
//   ops bytes, UTF-16 decode buffer, render scratch, output area (8 MB),
//   then the lazily grown u16 Myers trace. Memory starts at 384 pages
//   (24 MB) and grows only as the trace needs it.
import { findMarker, splitLines } from "./scan";
import { intern } from "./intern";
import { myersDiff, myersInit } from "./myers";
import { renderCase } from "./render";

const MAX_SPANS: i32 = 131072;
const MAX_LINES_TEXT: i32 = 65536;
const SPAN_AREA: i32 = 1048576;
const IDS_AREA: i32 = 262144;
const TMP_MAX: i32 = 3420160;
const V_MAX: i32 = 1048588;
const OPS_MAX: i32 = 131072;
const DEC_SIZE: i32 = 1048576;
const RTMP_SIZE: i32 = 32768;
const OUT_CAP: i32 = 8388608;

let outBaseVal: i32 = 0;

// Input must start above the static data segment (string literals live at
// low addresses); copying the input to offset 0 overwrote them and
// charCodeAt trapped. 1 MB is far above the static data and costs nothing.
export const INPUT_BASE: i32 = 1 << 20;

export function input_base(): i32 {
  return INPUT_BASE;
}

export function out_base(): i32 {
  return outBaseVal;
}

function hexVal(c: i32): i32 {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
  return -1;
}

// Decode the JSON string content [start, close) into UTF-16 code units at
// outPtr. Returns the unit count, or -1 on a bad escape / bad UTF-8.
function decodeString(start: i32, close: i32, outPtr: i32): i32 {
  let w: i32 = 0;
  let p: i32 = start;
  while (p < close) {
    const c: i32 = load<u8>(p);
    if (c == 0x5c) {
      if (p + 1 >= close) return -1;
      const e: i32 = load<u8>(p + 1);
      if (e == 0x6e) {
        store<u16>(outPtr + w * 2, 0x0a);
        w++;
        p += 2;
      } else if (e == 0x72) {
        store<u16>(outPtr + w * 2, 0x0d);
        w++;
        p += 2;
      } else if (e == 0x74) {
        store<u16>(outPtr + w * 2, 0x09);
        w++;
        p += 2;
      } else if (e == 0x62) {
        store<u16>(outPtr + w * 2, 0x08);
        w++;
        p += 2;
      } else if (e == 0x66) {
        store<u16>(outPtr + w * 2, 0x0c);
        w++;
        p += 2;
      } else if (e == 0x2f) {
        store<u16>(outPtr + w * 2, 0x2f);
        w++;
        p += 2;
      } else if (e == 0x22) {
        store<u16>(outPtr + w * 2, 0x22);
        w++;
        p += 2;
      } else if (e == 0x5c) {
        store<u16>(outPtr + w * 2, 0x5c);
        w++;
        p += 2;
      } else if (e == 0x75) {
        if (p + 6 > close) return -1;
        let cu: i32 = 0;
        for (let k = 0; k < 4; k++) {
          const hv: i32 = hexVal(load<u8>(p + 2 + k));
          if (hv < 0) return -1;
          cu = (cu << 4) | hv;
        }
        store<u16>(outPtr + w * 2, cu);
        w++;
        p += 6;
      } else {
        return -1;
      }
    } else if (c < 0x80) {
      store<u16>(outPtr + w * 2, c);
      w++;
      p++;
    } else if ((c & 0xe0) == 0xc0) {
      if (p + 2 > close) return -1;
      const cp: i32 = ((c & 0x1f) << 6) | (load<u8>(p + 1) & 0x3f);
      store<u16>(outPtr + w * 2, cp);
      w++;
      p += 2;
    } else if ((c & 0xf0) == 0xe0) {
      if (p + 3 > close) return -1;
      const cp: i32 =
        ((c & 0x0f) << 12) |
        ((load<u8>(p + 1) & 0x3f) << 6) |
        (load<u8>(p + 2) & 0x3f);
      store<u16>(outPtr + w * 2, cp);
      w++;
      p += 3;
    } else if ((c & 0xf8) == 0xf0) {
      if (p + 4 > close) return -1;
      const cp: i32 =
        ((c & 0x07) << 18) |
        ((load<u8>(p + 1) & 0x3f) << 12) |
        ((load<u8>(p + 2) & 0x3f) << 6) |
        (load<u8>(p + 3) & 0x3f);
      const v: i32 = cp - 0x10000;
      store<u16>(outPtr + w * 2, 0xd800 + (v >> 10));
      store<u16>(outPtr + w * 2 + 2, 0xdc00 + (v & 0x3ff));
      w += 2;
      p += 4;
    } else {
      return -1;
    }
  }
  return w;
}

// Split decoded UTF-16 units [basePtr, basePtr + u16len*2) into line spans
// (byteStart, byteLen) at spansPtr, with byteStart relative to the decode
// buffer origin (baseOff = basePtr - decPtr origin). Returns the line count.
function splitU16(
  basePtr: i32,
  u16len: i32,
  spansPtr: i32,
  baseOff: i32,
): i32 {
  let count: i32 = 0;
  let lineStart: i32 = 0;
  for (let i = 0; i < u16len; i++) {
    if (load<u16>(basePtr + i * 2) == 0x000a) {
      store<i32>(spansPtr + count * 8, baseOff + lineStart * 2);
      store<i32>(spansPtr + count * 8 + 4, (i + 1 - lineStart) * 2);
      count++;
      lineStart = i + 1;
    }
  }
  if (lineStart < u16len) {
    store<i32>(spansPtr + count * 8, baseOff + lineStart * 2);
    store<i32>(spansPtr + count * 8 + 4, (u16len - lineStart) * 2);
    count++;
  }
  return count;
}

export function solve_all(inPtr: i32, inLen: i32): i32 {
  const inEnd: i32 = inPtr + inLen;
  const scratchBase: i32 = (inPtr + inLen + 16 + 15) & ~15;
  const resPtr: i32 = scratchBase;
  const res2Ptr: i32 = scratchBase + 32;
  const spansPtr: i32 = scratchBase + 64;
  const idsOldPtr: i32 = spansPtr + SPAN_AREA;
  const idsNewPtr: i32 = idsOldPtr + IDS_AREA;
  const tmpPtr: i32 = idsNewPtr + IDS_AREA;
  const vPtr: i32 = tmpPtr + TMP_MAX;
  const opsPtr: i32 = vPtr + V_MAX;
  const decPtr: i32 = opsPtr + OPS_MAX;
  const renderTmp: i32 = decPtr + DEC_SIZE;
  const outBase: i32 = renderTmp + RTMP_SIZE;
  const traceBase: i32 = outBase + OUT_CAP;
  outBaseVal = outBase;
  const needEnd: i32 = traceBase + 65536;
  if (needEnd > (memory.size() << 16)) {
    const pages: i32 = (needEnd - (memory.size() << 16) + 65535) >> 16;
    if (memory.grow(pages) < 0) return -1;
  }
  myersInit(traceBase);
  let outPos: i32 = 0;
  store<u8>(outBase, 0x5b); // [
  outPos = 1;
  let cursor: i32 = inPtr;
  let first: i32 = 1;
  while (true) {
    const oldStart: i32 = findMarker(cursor, inEnd, 0);
    if (oldStart < 0) break;
    const oldCount: i32 = splitLines(oldStart, inEnd, spansPtr, resPtr);
    if (oldCount < 0) return -1;
    const nOld: i32 = load<i32>(resPtr);
    const oldClose: i32 = load<i32>(resPtr + 4);
    const oldUni: i32 = load<i32>(resPtr + 8);
    const newStart: i32 = findMarker(oldClose + 1, inEnd, 1);
    if (newStart < 0) return -1;
    const newCount: i32 = splitLines(
      newStart,
      inEnd,
      spansPtr + nOld * 8,
      resPtr,
    );
    if (newCount < 0) return -1;
    const nNew: i32 = load<i32>(resPtr);
    const newClose: i32 = load<i32>(resPtr + 4);
    const newUni: i32 = load<i32>(resPtr + 8);
    if (
      nOld > MAX_LINES_TEXT ||
      nNew > MAX_LINES_TEXT ||
      nOld + nNew > MAX_SPANS
    ) {
      return -1;
    }
    let caseLen: i32 = -1;
    if (oldUni == 0 && newUni == 0) {
      // Fast path: spans are ABSOLUTE buffer offsets, so srcPtr is 0
      // (passing inPtr would double-count the base).
      const distinct: i32 = intern(
        spansPtr,
        nOld,
        nNew,
        0,
        idsOldPtr,
        idsNewPtr,
        tmpPtr,
      );
      if (distinct < 0) return -1;
      const opsLen: i32 = myersDiff(
        idsOldPtr,
        idsNewPtr,
        nOld,
        nNew,
        vPtr,
        opsPtr,
        res2Ptr,
      );
      if (opsLen < 0) return -1;
      caseLen = renderCase(
        opsPtr,
        opsLen,
        load<i32>(res2Ptr),
        load<i32>(res2Ptr + 4),
        nOld,
        nNew,
        spansPtr,
        spansPtr + nOld * 8,
        0,
        1,
        outBase + outPos + (first == 1 ? 0 : 1),
        renderTmp,
      );
    } else {
      const oldU: i32 = decodeString(oldStart, oldClose, decPtr);
      if (oldU < 0) return -1;
      const newU: i32 = decodeString(
        newStart,
        newClose,
        decPtr + oldU * 2,
      );
      if (newU < 0) return -1;
      if (oldU + newU > DEC_SIZE / 2) return -1;
      const dOld: i32 = splitU16(decPtr, oldU, spansPtr, 0);
      const dNew: i32 = splitU16(
        decPtr + oldU * 2,
        newU,
        spansPtr + dOld * 8,
        oldU * 2,
      );
      const distinct: i32 = intern(
        spansPtr,
        dOld,
        dNew,
        decPtr,
        idsOldPtr,
        idsNewPtr,
        tmpPtr,
      );
      if (distinct < 0) return -1;
      const opsLen: i32 = myersDiff(
        idsOldPtr,
        idsNewPtr,
        dOld,
        dNew,
        vPtr,
        opsPtr,
        res2Ptr,
      );
      if (opsLen < 0) return -1;
      caseLen = renderCase(
        opsPtr,
        opsLen,
        load<i32>(res2Ptr),
        load<i32>(res2Ptr + 4),
        dOld,
        dNew,
        spansPtr,
        spansPtr + dOld * 8,
        decPtr,
        0,
        outBase + outPos + (first == 1 ? 0 : 1),
        renderTmp,
      );
    }
    if (caseLen < 0) return -1;
    if (first == 0) {
      store<u8>(outBase + outPos, 0x2c); // ,
      outPos++;
    }
    first = 0;
    outPos += caseLen;
    if (outPos > OUT_CAP - 16) return -1;
    cursor = newClose + 1;
  }
  store<u8>(outBase + outPos, 0x5d); // ]
  outPos++;
  return outPos;
}
