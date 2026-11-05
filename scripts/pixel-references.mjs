#!/usr/bin/env node
// Regenerates fixtures/pixel/reference/<preset>/<w>x<h>/<source>.png with the real Genforge.
//
// Usage:
//   node scripts/pixel-references.mjs --genforge <path/to/tools/genforge> [--python <bin>]
//        [--revision <sha>] [--presets item,sprite,texture,none] [--targets 16x16,...] [--cmd '<template>']
//
// The command template's placeholders are {python} {genforge} {src} {out} {preset} {w} {h}.
// The default is Genforge's own CLI (`genforge filter SRC --target WxH --preset P --out OUT`,
// genforge/cli.py). Nothing here calls an image provider: filtering is local. Genforge writes a
// JSON receipt beside each output; it is moved into manifest.json so the reference tree holds
// only PNGs.
//
// Genforge: `--genforge upstream/genforge` (committed copy) with a venv made by
//   python3 -m venv <venv> && <venv>/bin/pip install ./upstream/genforge
// and `--python <venv>/bin/python`.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce(
      (acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1] ?? '']] : acc),
      [],
    ),
);
if (!args.genforge) {
  console.error(
    'usage: node scripts/pixel-references.mjs --genforge <path/to/tools/genforge> [--python bin]',
  );
  process.exit(2);
}
const genforge = resolve(args.genforge);
const python = args.python ?? join(genforge, '..', '..', '.venv', 'bin', 'python');
const presets = (args.presets ?? 'item,sprite,texture,none').split(',');
// item needs a square target (genforge/cli.py); the others also get non-square and odd sizes.
const DEFAULT_TARGETS = {
  item: '16x16,24x24,32x32',
  sprite: '16x16,32x32,24x16,13x21',
  texture: '16x16,32x32,24x16,13x21',
  none: '16x16,32x32,24x16,13x21',
};
const targetsFor = (preset) =>
  (args.targets ?? DEFAULT_TARGETS[preset] ?? '16x16,32x32')
    .split(',')
    .map((t) => t.split('x').map(Number));
const template =
  args.cmd ??
  '{python} -m genforge filter {src} --target {w}x{h} --preset {preset} --out {out} --replace';

const root = resolve('fixtures/pixel');
const sources = readdirSync(join(root, 'sources'))
  .filter((f) => f.endsWith('.png'))
  .sort();

let revision = args.revision ?? 'unknown';
if (!args.revision)
  try {
    revision = execFileSync('git', ['-C', genforge, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    /* not a git checkout */
  }

const made = [];
for (const preset of presets) {
  for (const [w, h] of targetsFor(preset)) {
    const dir = join(root, 'reference', preset, `${w}x${h}`);
    mkdirSync(dir, { recursive: true });
    for (const file of sources) {
      const src = join(root, 'sources', file);
      const out = join(dir, file);
      const argv = template
        .split(/\s+/)
        .map((t) =>
          t
            .replaceAll('{python}', python)
            .replaceAll('{genforge}', genforge)
            .replaceAll('{src}', src)
            .replaceAll('{out}', out)
            .replaceAll('{preset}', preset)
            .replaceAll('{w}', String(w))
            .replaceAll('{h}', String(h)),
        );
      execFileSync(argv[0], argv.slice(1), {
        cwd: genforge,
        stdio: ['ignore', 'ignore', 'inherit'],
      });
      const receipt = out.replace(/\.png$/, '.json');
      const meta = JSON.parse(readFileSync(receipt, 'utf8'));
      rmSync(receipt);
      made.push({ path: `${preset}/${w}x${h}/${basename(file)}`, output_hash: meta.output_hash });
    }
  }
}
writeFileSync(
  join(root, 'reference', 'manifest.json'),
  JSON.stringify(
    {
      genforge: { revision, path: args.genforge },
      command: template.replace(python, '{python}'),
      references: made,
    },
    null,
    2,
  ) + '\n',
);
console.log(`wrote ${made.length} references (genforge ${revision})`);
