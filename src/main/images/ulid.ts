import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * A ULID: 48 bits of milliseconds then 80 random bits, in Crockford base32.
 * Monotonic within a process: ids made in the same millisecond still sort in
 * creation order.
 */
let lastTime = -1;
let lastRandom: number[] = [];

export function ulid(
  now: number = Date.now(),
  random: (n: number) => Uint8Array = randomBytes,
): string {
  let rand: number[];
  if (now === lastTime) {
    rand = [...lastRandom];
    for (let i = rand.length - 1; i >= 0; i--) {
      if ((rand[i] as number) < 31) {
        rand[i] = (rand[i] as number) + 1;
        break;
      }
      rand[i] = 0;
    }
  } else {
    const bytes = random(16);
    rand = Array.from({ length: 16 }, (_, i) => (bytes[i] as number) & 31);
  }
  lastTime = now;
  lastRandom = rand;
  let t = now;
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = (ALPHABET[t % 32] as string) + time;
    t = Math.floor(t / 32);
  }
  return time + rand.map((r) => ALPHABET[r]).join('');
}
