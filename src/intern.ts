// intern.ts — line interning over raw byte spans.
// Hashes every line span (FNV-1a over u64 words, murmur-style final mix
// with small constants), radix-sorts line indices by 64-bit hash (4 x 16-bit
// LSD passes), then assigns ids, verifying equal-hash groups by full memcmp
// so a hash collision can never merge distinct lines. B follows A: old spans
// come first in the combined span array, new spans after, so equal lines
// share one id. Span-type agnostic: spans are (byteStart, byteLen) into a
// source buffer (raw input bytes on the fast path, the UTF-16 decode buffer
// on the slow path).

const FNV_PRIME: u64 = 1099511628211;

function spanHash(src: i32, start: i32, len: i32): u64 {
  let h: u64 = FNV_PRIME;
  let p: i32 = start;
  const end8: i32 = start + (len & ~7);
  while (p < end8) {
    h ^= load<u64>(src + p);
    h *= FNV_PRIME;
    p += 8;
  }
  let t: i32 = end8;
  const end: i32 = start + len;
  while (t < end) {
    h ^= <u64>load<u8>(src + t);
    h *= FNV_PRIME;
    t++;
  }
  h ^= <u64>len;
  h ^= h >> 33;
  h *= FNV_PRIME;
  h ^= h >> 33;
  return h;
}

function spanEq(src: i32, s1: i32, l1: i32, s2: i32, l2: i32): bool {
  if (l1 != l2) return false;
  if (s1 == s2) return true;
  let p1: i32 = src + s1;
  let p2: i32 = src + s2;
  const e8: i32 = p1 + (l1 & ~7);
  while (p1 < e8) {
    if (load<u64>(p1) != load<u64>(p2)) return false;
    p1 += 8;
    p2 += 8;
  }
  const end: i32 = src + s1 + l1;
  while (p1 < end) {
    if (load<u8>(p1) != load<u8>(p2)) return false;
    p1++;
    p2++;
  }
  return true;
}

// Intern combined spans (old first, nOld of them, then nNew) into ids.
// tmpPtr scratch: total*24 bytes + 262144 (counts) + 12288 (reps).
// Returns the number of distinct ids, or -1 on error.
export function intern(
  spansPtr: i32,
  nOld: i32,
  nNew: i32,
  srcPtr: i32,
  idsOldPtr: i32,
  idsNewPtr: i32,
  tmpPtr: i32,
): i32 {
  const total: i32 = nOld + nNew;
  if (total <= 0) return 0;
  let keysA: i32 = tmpPtr;
  let keysB: i32 = tmpPtr + total * 8;
  let idxA: i32 = tmpPtr + total * 16;
  let idxB: i32 = tmpPtr + total * 20;
  const cnt: i32 = tmpPtr + total * 24;
  const reps: i32 = cnt + 262144;
  for (let i = 0; i < total; i++) {
    const s: i32 = load<i32>(spansPtr + i * 8);
    const l: i32 = load<i32>(spansPtr + i * 8 + 4);
    store<u64>(keysA + i * 8, spanHash(srcPtr, s, l));
    store<i32>(idxA + i * 4, i);
  }
  for (let pass = 0; pass < 4; pass++) {
    const shift: i32 = pass * 16;
    memory.fill(cnt, 0, 262144);
    for (let i = 0; i < total; i++) {
      const d: i32 = i32((load<u64>(keysA + i * 8) >> shift) & 0xffff);
      store<i32>(cnt + d * 4, load<i32>(cnt + d * 4) + 1);
    }
    let sum: i32 = 0;
    for (let d = 0; d < 65536; d++) {
      const c: i32 = load<i32>(cnt + d * 4);
      store<i32>(cnt + d * 4, sum);
      sum += c;
    }
    for (let i = 0; i < total; i++) {
      const h: u64 = load<u64>(keysA + i * 8);
      const d: i32 = i32((h >> shift) & 0xffff);
      const pos: i32 = load<i32>(cnt + d * 4);
      store<i32>(cnt + d * 4, pos + 1);
      store<u64>(keysB + pos * 8, h);
      store<i32>(idxB + pos * 4, load<i32>(idxA + i * 4));
    }
    let t: i32 = keysA;
    keysA = keysB;
    keysB = t;
    t = idxA;
    idxA = idxB;
    idxB = t;
  }
  // keysA/idxA now hold the sort (4 passes = even, back in A).
  let distinct: i32 = 0;
  let i: i32 = 0;
  while (i < total) {
    const h: u64 = load<u64>(keysA + i * 8);
    let j: i32 = i + 1;
    while (j < total && load<u64>(keysA + j * 8) == h) j++;
    // Group [i, j): assign ids by content equality against the group's
    // representatives (reps holds start, len, id triples, 12 bytes each).
    let nrep: i32 = 0;
    for (let k = i; k < j; k++) {
      const cidx: i32 = load<i32>(idxA + k * 4);
      const s: i32 = load<i32>(spansPtr + cidx * 8);
      const l: i32 = load<i32>(spansPtr + cidx * 8 + 4);
      let id: i32 = -1;
      for (let r = 0; r < nrep; r++) {
        const rs: i32 = load<i32>(reps + r * 12);
        const rl: i32 = load<i32>(reps + r * 12 + 4);
        if (spanEq(srcPtr, s, l, rs, rl)) {
          id = load<i32>(reps + r * 12 + 8);
          break;
        }
      }
      if (id < 0) {
        if (nrep >= 1024) return -1;
        id = distinct;
        distinct++;
        store<i32>(reps + nrep * 12, s);
        store<i32>(reps + nrep * 12 + 4, l);
        store<i32>(reps + nrep * 12 + 8, id);
        nrep++;
      }
      if (cidx < nOld) {
        store<i32>(idsOldPtr + cidx * 4, id);
      } else {
        store<i32>(idsNewPtr + (cidx - nOld) * 4, id);
      }
    }
    i = j;
  }
  return distinct;
}
