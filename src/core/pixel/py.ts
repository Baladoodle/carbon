/**
 * Python and NumPy semantics the port depends on: banker's rounding (`round`,
 * `np.rint`), float `%`, `colorsys`, and NumPy's float32 / pairwise summation
 * orders, so values computed in TypeScript round the way Genforge's do.
 */

/** Python `round(x)` / `np.rint(x)`: half to even. */
export function roundHalfEven(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** Python float `x % m`. */
export function pyMod(x: number, m: number): number {
  let r = x % m;
  if (r !== 0 && m < 0 !== r < 0) r += m;
  return r === 0 ? Math.abs(r) * Math.sign(m || 1) : r;
}

/** `colorsys.rgb_to_hsv`. */
export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const maxc = Math.max(r, g, b);
  const minc = Math.min(r, g, b);
  const rangec = maxc - minc;
  const v = maxc;
  if (minc === maxc) return [0.0, 0.0, v];
  const s = rangec / maxc;
  const rc = (maxc - r) / rangec;
  const gc = (maxc - g) / rangec;
  const bc = (maxc - b) / rangec;
  let h: number;
  if (r === maxc) h = bc - gc;
  else if (g === maxc) h = 2.0 + rc - bc;
  else h = 4.0 + gc - rc;
  h = pyMod(h / 6.0, 1.0);
  return [h, s, v];
}

/** `colorsys.hsv_to_rgb`. */
export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  if (s === 0.0) return [v, v, v];
  let i = Math.trunc(h * 6.0);
  const f = h * 6.0 - i;
  const p = v * (1.0 - s);
  const q = v * (1.0 - s * f);
  const t = v * (1.0 - s * (1.0 - f));
  i = pyMod(i, 6);
  switch (i) {
    case 0:
      return [v, t, p];
    case 1:
      return [q, v, p];
    case 2:
      return [p, v, t];
    case 3:
      return [p, q, v];
    case 4:
      return [t, p, v];
    default:
      return [v, p, q];
  }
}

/**
 * NumPy's pairwise summation (`@TYPE@_pairwise_sum`) over a contiguous run, as
 * `np.sum` uses along a contiguous axis. `round` is identity for float64 and
 * `Math.fround` for float32.
 */
export function pairwiseSum(
  a: ArrayLike<number>,
  start: number,
  n: number,
  round: (x: number) => number = (x) => x,
): number {
  const at = (i: number): number => a[start + i] ?? 0;
  if (n < 8) {
    let res = -0.0;
    for (let i = 0; i < n; i++) res = round(res + at(i));
    return res;
  }
  if (n <= 128) {
    const r = [at(0), at(1), at(2), at(3), at(4), at(5), at(6), at(7)];
    let i: number;
    for (i = 8; i < n - (n % 8); i += 8) {
      for (let j = 0; j < 8; j++) r[j] = round((r[j] ?? 0) + at(i + j));
    }
    const q = (x: number, y: number): number => round(x + y);
    let res = q(
      q(q(r[0] ?? 0, r[1] ?? 0), q(r[2] ?? 0, r[3] ?? 0)),
      q(q(r[4] ?? 0, r[5] ?? 0), q(r[6] ?? 0, r[7] ?? 0)),
    );
    for (; i < n; i++) res = round(res + at(i));
    return res;
  }
  let n2 = Math.floor(n / 2);
  n2 -= n2 % 8;
  return round(pairwiseSum(a, start, n2, round) + pairwiseSum(a, start + n2, n - n2, round));
}

export const fround = Math.fround;
