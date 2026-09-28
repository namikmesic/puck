/**
 * ULIDs: 48-bit millisecond time plus 80 random bits, Crockford base32, 26
 * characters. Ids made this way sort by creation time, which the daemon's
 * stores and events rely on. Monotonic within one millisecond: the random
 * part is incremented instead of redrawn, so ids minted in a burst still
 * sort in minting order. Uses only the global Web Crypto, so it runs in
 * the app, the renderer, and the daemon alike.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

let lastTime = -1;
let lastRandom: number[] = [];

function randomDigits(): number[] {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b & 31);
}

/** Increments a base32 digit array in place; false on overflow. */
function increment(digits: number[]): boolean {
  for (let i = digits.length - 1; i >= 0; i--) {
    if (digits[i] < 31) {
      digits[i] += 1;
      return true;
    }
    digits[i] = 0;
  }
  return false;
}

export function ulid(now: number = Date.now()): string {
  if (now === lastTime && increment(lastRandom)) {
    // same millisecond: keep the order
  } else {
    lastTime = now;
    lastRandom = randomDigits();
  }
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  return time + lastRandom.map((d) => ALPHABET[d]).join('');
}

/** A prefixed id such as `ses_01J…`. */
export function newId(prefix: string, now?: number): string {
  return `${prefix}_${ulid(now)}`;
}
