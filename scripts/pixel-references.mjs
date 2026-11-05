#!/usr/bin/env node
// Regenerates fixtures/pixel/reference/<preset>/<w>x<h>/<source>.png with the real Genforge.
//
// Usage:
//   node scripts/pixel-references.mjs --genforge <path/to/tools/genforge> [--python <bin>]
//        [--presets item,sprite,texture,none] [--targets 16x16,32x32] [--cmd '<template>']
//
// The command template's placeholders are {python} {genforge} {src} {out} {preset} {w} {h}.
// The default below follows docs/IMAGES.md ("python tools/genforge filter … --preset <p>");
// its size and output flags are UNVERIFIED (Genforge's source was not readable when this was
// written; see docs/build-notes/pixel.md). Check `genforge filter --help` and pass --cmd if
// they differ. Nothing here calls an image provider: filtering is local.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
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
const targets = (args.targets ?? '16x16,32x32').split(',').map((t) => t.split('x').map(Number));
const template =
  args.cmd ?? '{python} -m genforge filter {src} --preset {preset} --size {w}x{h} --out {out}';

const root = resolve('fixtures/pixel');
const sources = readdirSync(join(root, 'sources'))
  .filter((f) => f.endsWith('.png'))
  .sort();

let revision = 'unknown';
try {
  revision = execFileSync('git', ['-C', genforge, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
} catch {
  /* not a git checkout */
}

const made = [];
for (const preset of presets) {
  for (const [w, h] of targets) {
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
      made.push(`${preset}/${w}x${h}/${basename(file)}`);
    }
  }
}
writeFileSync(
  join(root, 'reference', 'manifest.json'),
  JSON.stringify({ genforge: { revision }, command: template, references: made }, null, 2) + '\n',
);
console.log(`wrote ${made.length} references (genforge ${revision})`);
