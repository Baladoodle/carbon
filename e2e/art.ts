import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { ImageMeta, WorldImages } from '@core/images/model';
import { imagePaths } from '@core/images/model';
import type { World } from '@core/model/world';
import { encodePng, sha256, type Rgba } from '../src/main/images/png';

/**
 * Art for the canonical screens (docs/screens/): images-core's recorded real
 * calls where there is one (fixtures/images), else stand-in art painted here,
 * so the screens need no paid call. Concepts are layered landscapes per biome;
 * icons are 16×16 sprites in Infinite's item style. Everything is
 * deterministic (seeded), so the screens are reproducible.
 */

type RGB = [number, number, number];
const hex = (h: string): RGB => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];
const mixc = (a: RGB, b: RGB, t: number): RGB => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

/** Smooth 1D value noise over [0, 1]. */
function noise1(seed: number, octaves = 4): (x: number) => number {
  const r = rng(seed);
  const tables = Array.from({ length: octaves }, () => Array.from({ length: 65 }, r));
  return (x: number) => {
    let v = 0;
    let amp = 1;
    let total = 0;
    for (let o = 0; o < octaves; o++) {
      const f = 2 ** (o + 1);
      const p = x * f;
      const i = Math.floor(p);
      const t = p - i;
      const s = t * t * (3 - 2 * t);
      const tab = tables[o] as number[];
      const a = tab[i % 64] as number;
      const b = tab[(i + 1) % 64] as number;
      v += (a + (b - a) * s) * amp;
      total += amp;
      amp *= 0.5;
    }
    return v / total;
  };
}

interface Layer {
  color: string;
  /** Baseline height, 0 (top) .. 1 (bottom). */
  base: number;
  amp: number;
  /** Hanging from the top (a cave ceiling) instead of rising from the bottom. */
  top?: boolean;
  /** Sharp peaks (spires, chimneys) instead of rolling hills. */
  spiky?: number;
}

interface Scene {
  sky: [string, string, string];
  layers: Layer[];
  /** Haze between layers, toward the sky's horizon colour. */
  haze: number;
  glow?: { color: string; count: number; size: number; band: [number, number] };
  sun?: { x: number; y: number; r: number; color: string };
}

const SCENES: Record<string, Scene> = {
  'glowmoss-caverns': {
    sky: ['#0c1416', '#123a36', '#0a1514'],
    haze: 0.55,
    layers: [
      { color: '#14302d', base: 0.18, amp: 0.16, top: true, spiky: 0.5 },
      { color: '#1b4a40', base: 0.72, amp: 0.12 },
      { color: '#0f2a27', base: 0.1, amp: 0.1, top: true, spiky: 0.8 },
      { color: '#103630', base: 0.84, amp: 0.08 },
      { color: '#081b19', base: 0.93, amp: 0.05 },
    ],
    glow: { color: '#8ff0c4', count: 90, size: 4, band: [0.45, 0.95] },
  },
  'ash-vents': {
    sky: ['#2a2422', '#5a3a2c', '#c0643a'],
    haze: 0.5,
    layers: [
      { color: '#4a3a34', base: 0.55, amp: 0.3, spiky: 1 },
      { color: '#3a2c28', base: 0.68, amp: 0.25, spiky: 0.8 },
      { color: '#271d1b', base: 0.82, amp: 0.12, spiky: 0.4 },
      { color: '#161110', base: 0.92, amp: 0.05 },
    ],
    glow: { color: '#ff9a4a', count: 70, size: 2.5, band: [0.2, 0.9] },
  },
  'meadow-steps': {
    sky: ['#6f9fcf', '#b9d3e4', '#f1e2c0'],
    haze: 0.45,
    sun: { x: 0.72, y: 0.28, r: 0.07, color: '#fff3d0' },
    layers: [
      { color: '#8ba7a0', base: 0.52, amp: 0.12 },
      { color: '#6f9a63', base: 0.64, amp: 0.1 },
      { color: '#5a8a4a', base: 0.74, amp: 0.08 },
      { color: '#4b7a3c', base: 0.84, amp: 0.06 },
      { color: '#3c6530', base: 0.94, amp: 0.04 },
    ],
  },
  'cloud-reef': {
    sky: ['#3b5f9a', '#9fb8dc', '#f0c8c0'],
    haze: 0.4,
    sun: { x: 0.25, y: 0.35, r: 0.09, color: '#ffe6d6' },
    layers: [
      { color: '#e8eef6', base: 0.62, amp: 0.1 },
      { color: '#d4a0b0', base: 0.7, amp: 0.2, spiky: 0.9 },
      { color: '#f4f6fa', base: 0.8, amp: 0.08 },
      { color: '#e0e6f0', base: 0.9, amp: 0.06 },
    ],
    glow: { color: '#ffffff', count: 30, size: 3, band: [0.1, 0.6] },
  },
  'spore-lantern': {
    sky: ['#0e1a1c', '#163a38', '#0b1617'],
    haze: 0.5,
    layers: [
      { color: '#1b4a40', base: 0.78, amp: 0.08 },
      { color: '#0f2a27', base: 0.9, amp: 0.05 },
    ],
    glow: { color: '#a8f5cf', count: 140, size: 5, band: [0.15, 0.85] },
  },
};

function paint(scene: Scene, w: number, h: number, seed: number): Rgba {
  const data = new Uint8ClampedArray(w * h * 4);
  const [skyTop, skyMid, skyLow] = scene.sky.map(hex) as [RGB, RGB, RGB];
  const put = (x: number, y: number, c: RGB, a = 1): void => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 4;
    data[i] = (data[i] as number) * (1 - a) + c[0] * a;
    data[i + 1] = (data[i + 1] as number) * (1 - a) + c[1] * a;
    data[i + 2] = (data[i + 2] as number) * (1 - a) + c[2] * a;
    data[i + 3] = 255;
  };
  // Sky.
  for (let y = 0; y < h; y++) {
    const t = y / h;
    const c = t < 0.6 ? mixc(skyTop, skyMid, t / 0.6) : mixc(skyMid, skyLow, (t - 0.6) / 0.4);
    for (let x = 0; x < w; x++) put(x, y, c);
  }
  if (scene.sun) {
    const s = scene.sun;
    const cx = s.x * w;
    const cy = s.y * h;
    const r = s.r * w;
    const col = hex(s.color);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d < r) put(x, y, col, 0.95);
        else if (d < r * 4) put(x, y, col, 0.25 * (1 - (d - r) / (r * 3)) ** 2);
      }
  }
  // Ridges, far to near, each hazed toward the horizon.
  scene.layers.forEach((l, li) => {
    const n = noise1(seed * 31 + li * 7, 5);
    const far = 1 - li / Math.max(1, scene.layers.length - 1);
    const col = mixc(hex(l.color), skyMid, scene.haze * far * 0.8);
    for (let x = 0; x < w; x++) {
      let v = n(x / w);
      if (l.spiky) v = Math.pow(v, 1 + l.spiky * 2.2) * (1 + l.spiky);
      const edge = l.top ? (l.base + v * l.amp) * h : (l.base - v * l.amp) * h;
      for (let y = 0; y < h; y++) {
        const inside = l.top ? y < edge : y > edge;
        if (!inside) continue;
        // A soft rim on the edge, lit from above.
        const rim = Math.max(0, 1 - Math.abs(y - edge) / 3);
        put(x, y, mixc(col, skyLow, rim * 0.35));
      }
    }
  });
  // Glowing motes.
  if (scene.glow) {
    const g = scene.glow;
    const r = rng(seed * 97 + 3);
    const col = hex(g.color);
    for (let k = 0; k < g.count; k++) {
      const cx = r() * w;
      const cy = (g.band[0] + r() * (g.band[1] - g.band[0])) * h;
      const size = g.size * (0.4 + r() * 1.2) * (w / 960);
      const R = size * 5;
      for (let y = Math.floor(cy - R); y < cy + R; y++)
        for (let x = Math.floor(cx - R); x < cx + R; x++) {
          const d = Math.hypot(x - cx, y - cy);
          if (d < size) put(x, y, col, 0.9);
          else if (d < R) put(x, y, col, 0.22 * (1 - d / R) ** 2);
        }
    }
  }
  return { width: w, height: h, data };
}

/** 16×16 item sprites: one character per pixel, `.` transparent. */
const SPRITES: Record<string, { rows: string[]; palette: Record<string, string> }> = {
  'spore-lantern': {
    palette: { k: '#1c1a1f', m: '#5b5560', g: '#8ff0c4', G: '#d9ffe9', d: '#2e8f6c' },
    rows: [
      '......kkkk......',
      '.....km..mk.....',
      '......kkkk......',
      '.....kmmmmk.....',
      '....kdggggdk....',
      '...kdgGGggggk...',
      '...kgGGgggdgk...',
      '...kggggdgggk...',
      '...kgdggggGgk...',
      '...kgggggGGgk...',
      '...kdggdgggdk...',
      '....kdggggdk....',
      '.....kmmmmk.....',
      '......kmmk......',
      '.......kk.......',
      '................',
    ],
  },
  'cinder-sting': {
    palette: { k: '#1a1414', r: '#c0442a', o: '#f08a3a', y: '#ffd27a', m: '#4a3a34', s: '#7a6a62' },
    rows: [
      '...............y',
      '..............yo',
      '.............yor',
      '............york',
      '...........ork..',
      '..........ork...',
      '.........ork....',
      '........ork.....',
      '...s...ork......',
      '...ss.ork.......',
      '....smrk........',
      '.....mms........',
      '....kmkss.......',
      '...kmk...s......',
      '..kmk...........',
      '..kk............',
    ],
  },
  'cloud-anklet': {
    palette: { k: '#2a3550', w: '#ffffff', c: '#d8e4f4', b: '#9fb8dc', p: '#f0c8c0' },
    rows: [
      '................',
      '................',
      '.....kkkkkk.....',
      '...kkwwccwwkk...',
      '..kwcbbbbbbcwk..',
      '.kwcb......bcwk.',
      '.kcb........bck.',
      'kwb..........bwk',
      'kcb..........bck',
      'kwb..........bwk',
      '.kcb...pp...bck.',
      '.kwcb.pwwp.bcwk.',
      '..kwcbbppbbcwk..',
      '...kkwwccwwkk...',
      '.....kkkkkk.....',
      '................',
    ],
  },
  'vent-glass-visor': {
    palette: { k: '#16181c', m: '#4a4f58', l: '#8a929e', g: '#e0a050', G: '#ffd890', o: '#c06a2a' },
    rows: [
      '................',
      '................',
      '................',
      '....kkkkkkkk....',
      '..kkmmllllmmkk..',
      '.kmlllllllllllk.',
      'kmkkkkkkkkkkkkmk',
      'kkgGGgokkgGGgokk',
      'kkgGgggkkgGgggkk',
      'kkoggggkkoggggkk',
      '.kkoookmmkoookk.',
      '..kkkkk..kkkkk..',
      '................',
      '................',
      '................',
      '................',
    ],
  },
};

function sprite(id: string): Rgba | null {
  const s = SPRITES[id];
  if (!s) return null;
  const data = new Uint8ClampedArray(16 * 16 * 4);
  s.rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const c = s.palette[row.charAt(x)];
      if (!c) continue;
      const [r, g, b] = hex(c);
      const i = (y * 16 + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  });
  return { width: 16, height: 16, data };
}

/** A ULID-shaped id from a counter (Crockford base32, sortable). */
const ulid = (n: number): string => `01JC${String(n).padStart(22, '0')}`;

/**
 * Paints the art into `dir/images/` and returns `world` with the metadata,
 * each image selected: concepts for every biome in SCENES (and the Spore
 * Lantern), icons for every item in SPRITES.
 */
export function withArt(world: World, dir: string): World {
  const images: WorldImages = {};
  let n = 1;
  const add = (
    entity: string,
    kind: 'concept' | 'icon',
    img: Rgba | { bytes: Uint8Array; width: number; height: number; model: string },
    prompt: string,
  ): void => {
    const real = 'bytes' in img;
    const bytes = real ? img.bytes : encodePng(img);
    const id = ulid(n++);
    const file = path.join(dir, imagePaths(entity, id).png);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, bytes);
    const meta: ImageMeta = {
      id,
      entity,
      kind,
      origin: real
        ? {
            by: 'openai',
            model: img.model,
            quality: 'low',
            size: kind === 'icon' || img.width === img.height ? '1024x1024' : '1536x1024',
            prompt,
          }
        : { by: 'fake', prompt, size: kind === 'icon' ? '1024x1024' : '1536x1024' },
      created: '2026-11-05T12:00:00.000Z',
      width: img.width,
      height: img.height,
      hashes: { output: sha256(bytes) },
    };
    const cur = images[entity] ?? { all: [] };
    images[entity] = { ...cur, [kind]: id, all: [...cur.all, meta] };
  };
  // Earlier versions of the Spore Lantern's art, so its Bench strip shows them.
  if (world.entities['spore-lantern']) {
    const lantern = SCENES['spore-lantern'] as Scene;
    add(
      'spore-lantern',
      'concept',
      paint({ ...lantern, sky: ['#141a24', '#28345a', '#121626'] }, 960, 640, 5),
      'An earlier lantern',
    );
    add(
      'spore-lantern',
      'concept',
      paint({ ...lantern, sky: ['#1a1410', '#4a3a20', '#16100c'] }, 960, 640, 9),
      'An earlier lantern',
    );
    const old = sprite('spore-lantern');
    if (old) {
      // The first icon: amber spores.
      for (let i = 0; i < old.data.length; i += 4)
        if ((old.data[i + 1] as number) > 200 && (old.data[i] as number) < 220) {
          old.data[i] = 240;
          old.data[i + 1] = 190;
          old.data[i + 2] = 90;
        }
      add('spore-lantern', 'icon', old, 'An earlier lantern icon');
    }
  }
  let seed = 11;
  for (const [id, scene] of Object.entries(SCENES)) {
    seed += 7;
    if (world.entities[id])
      add(id, 'concept', paint(scene, 960, 640, seed), `Concept art of ${world.entities[id].name}`);
  }
  for (const id of Object.keys(SPRITES)) {
    const s = sprite(id);
    if (s && world.entities[id])
      add(id, 'icon', s, `${world.entities[id].name}, as a game item icon`);
  }
  // images-core's recorded real calls (fixtures/images, low quality): where an
  // entity has one, it is the chosen image, and the painted one an earlier version.
  for (const [entity, kind, file, model] of REAL) {
    const abs = path.join(FIXTURES, `${file}.png`);
    if (!world.entities[entity] || !existsSync(abs)) continue;
    const bytes = new Uint8Array(readFileSync(abs));
    const dim = { width: bytes[19]! + (bytes[18]! << 8), height: bytes[23]! + (bytes[22]! << 8) };
    add(entity, kind, { bytes, model, ...dim }, `${world.entities[entity].name} (recorded)`);
  }
  return { ...world, images };
}

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/images');
const REAL: [string, 'concept' | 'icon', string, string][] = [
  ['spore-lantern', 'icon', 'spore-lantern-icon-flare', 'gpt-image-2.6-flare'],
  ['glowmoss-caverns', 'concept', 'glowmoss-caverns-concept-sunburst', 'gpt-image-2.6-sunburst'],
  ['cloud-reef', 'concept', 'cloud-reef-concept-flare', 'gpt-image-2.6-flare'],
  ['spore-lantern', 'concept', 'spore-lantern-concept-flare', 'gpt-image-2.6-flare'],
  ['spore-lantern', 'icon', 'spore-lantern-icon-edit-flare', 'gpt-image-2.6-flare'],
  ['cinder-sting', 'icon', 'cinder-sting-icon-sunburst', 'gpt-image-2.6-sunburst'],
  ['cloud-anklet', 'icon', 'cloud-anklet-icon-flare', 'gpt-image-2.6-flare'],
];
