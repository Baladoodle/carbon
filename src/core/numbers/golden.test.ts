import { describe, expect, it } from 'vitest';
import { cmd } from '../commands/registry';
import { applyCommands } from '../commands/apply';
import { sampleWorld, SAMPLE_TIME } from '../testing/sample';
import type { World } from '../model/world';
import { analyzeNumbers } from './engine';
import { parseProgram } from './parser';
import { printProgram } from './printer';
import { lineCol, type Diagnostic } from './span';
import { formatValue } from './values';

/**
 * Golden tests: each suite renders its cases as readable text and compares it
 * with a committed file in `golden/`. A change in behaviour shows up as a
 * diff of that file. To accept an intended change, run
 * `npx vitest run src/core/numbers/golden.test.ts -u` and review the diff.
 */
const show = (source: string, ds: Diagnostic[]): string[] =>
  ds.map((d) => {
    const { line, col } = lineCol(source, d.span.start);
    const text = source.slice(d.span.start, d.span.end);
    return `${line}:${col} ${d.severity} ${d.code} ${JSON.stringify(text)}: ${d.message}${d.hint ? ` (hint: ${d.hint})` : ''}`;
  });

const PARSE_CASES: [string, string][] = [
  ['constants and functions', 'k = 100\ntaken(raw, def) = raw * k / (k + def)\n'],
  ['precedence', 'a = 1 + 2 * 3 ^ 2 ^ 2 - -4\nb = (1 + 2) * 3\nc = -2 ^ 2\nd = (-2) ^ 2\n'],
  ['logic', 'a = not x == 1 and y or z\nb = not (x and y)\nc = x < 1 or x >= 10\n'],
  [
    'queries',
    'band_defense(b: band) = sum(items where subkind == "armor" and band == b, .defense)\nn = count(items where it.tier > 0)\nm = (items where tier > 0) where tier < 3\n',
  ],
  ['members and calls', 'ttk(c, w) = ceil(c.health / taken(w.damage, c.defense))\nx = f(a)(b)\n'],
  [
    'literals',
    'a = 1_000\nb = 1.5e3\nc = .5\nd = "say \\"hi\\"\\n"\ne = [1, 2, 3]\nf = []\ng = true\nh = none\n',
  ],
  ['comments and blank lines', '# header\n\n\nk = 1  # the constant\n\n# section\nj = k\n'],
  ['continuation inside brackets', 'f(a, b) = max(a,\n  b,\n  0)\ng = 1\n'],
  ['missing equals', 'k 100\nj = 2\n'],
  ['double equals as definition', 'k == 100\n'],
  ['assignment in an expression', 'k = a = 1\n'],
  ['chained comparison', 'k = 1 < x < 3\n'],
  ['unclosed parenthesis stays on its line', 'k = (1 + 2\nj = 3\n'],
  ['unmatched closer', 'k = 1 + 2)\n'],
  ['trailing token', 'k = 1 2\n'],
  ['empty value', 'k =\n'],
  ['keyword as name', 'and = 1\n'],
  ['bad characters', 'k = 1 & 2\nj = 3 | 4\n'],
  ['unterminated string', 'k = "abc\nj = 1\n'],
  ['bad escape', 'k = "a\\qb"\n'],
  ['backslash at the end of a string', 'k = "a\\\nj = 1\n'],
  ['number with a name stuck to it', 'k = 3x\n'],
  ['bad underscore', 'k = 1__0\n'],
  ['unary plus', 'k = +1\n'],
  ['empty parentheses', 'k = ()\n'],
  ['dangling operator', 'k = 1 +\n'],
  ['where without condition', 'k = items where\n'],
  ['bad parameter', 'f(1) = 2\ng(a:) = 1\n'],
  ['call on a non-name', 'k = 2(3)\n'],
  ['dot without a name', 'k = a.\nj = sum(items, .)\n'],
];

const CHECK_SOURCE = `taken(raw, def) = raw * k / (k + def)
band_defense(b: band) = sum(items where subkind == "armor" and band == b, .defense)
armor = items where subkind == "armor"
names = count(bands where name != "")
ident(v) = v
twice = ident(2) + ident(3)
words = contains(ident(["a"]), "a")
ttk(c, w) = ceil(c.health / taken(w.damage, c.defense))
oops = taken(1)
wrong = taken("a", 2)
mixed = 1 + "a"
cmp = band_defense(bands where tier == 0)
unknown = defence + 1
typo = sqr(4)
fv = taken
bv = sum
kv = k(1)
noprop = items where weight > 1
range = bands where danger > 1
climate = biomes where climate == 1
acc = .defense
itout = it
ent = bands where it == "Hollows"
iff = if(true, 1, "a")
sum = 1
k = 2
dup = 1
dup = 2
p(a, a) = a
ann(x: thing) = x
shadow(subkind) = count(items where subkind == subkind)
loop_a = loop_b + 1
loop_b = loop_a * 2
self = self + 1
uses_loop = loop_a + 1
uses_err = mixed * 2
lists = [1, "a"]
minl = min(items, .defense)
minn = min(1, 2, 3)
agg = sum(items)
cnt = count(items, .defense)
neg = -"a"
nott = not 1
chained = (1 < 2) < 3
`;

const EVAL_SOURCE = `taken(raw, def) = raw * k / (k + def)
hit = taken(20, 4)
armor = items where subkind == "armor"
armor_count = count(armor)
defense_total = sum(armor, .defense)
band_defense(b: band) = sum(items where subkind == "armor" and band == b, .defense)
low = band_defense(bands where name == "Hollows")
placed = count(items where band != none)
sky = count(entities where band != none and tier > 0)
tiers = bands where tier >= 0
mean_menace = avg(creatures where it.kind == "creature", .menace)
strongest = max(items where subkind == "weapon", .damage)
smallest = min(3, 1, 2) + min([4, 5])
danger_top = max(bands where danger_max > 0, .danger_max)
highest = max(bands, .y_bottom)
rounded = round(hit, 2)
clamped = clamp(hit, 0, 10)
lerped = lerp(0, 10, 0.25)
logs = log(100, 10) + log(exp(1))
pw = pow(2, 10) + 2 ^ 3 ^ 2
roots = sqrt(16) + abs(-3) + floor(2.7) + ceil(2.1)
mod = 7 % 3
cond = if(hit > 10, "big", "small")
has = contains(["a", "b"], "b")
tagged = count(items where contains(tags, "x"))
props = materials where contains(properties, "glows")
biome_band = (biomes where id == "cloud-reef")
names = count(bands where name > "")
div = 1 / (k - 100)
no_tier = items where tier > 0
unset = sum(items where subkind == "weapon" or subkind == "armor", .defense)
empty_avg = avg(items where name == "nobody", .defense)
neg_sqrt = sqrt(0 - 1)
bad_log = log(0)
bad_clamp = clamp(1, 2, 0)
bad_round = round(1.2345, 1.5)
uses_div = div + 1
none_prop = count(items where band.tier > 0)
`;

function evalWorld(): World {
  const r = applyCommands(sampleWorld(), [cmd('numbers.setFormulas', { source: EVAL_SOURCE })], {
    now: SAMPLE_TIME,
  });
  if (!r.ok) throw new Error(r.error.message);
  return r.value.world;
}

describe('golden', () => {
  it('parser', async () => {
    const out: string[] = [];
    for (const [name, source] of PARSE_CASES) {
      const { program, diagnostics } = parseProgram(source);
      out.push(`=== ${name}`, source.trimEnd(), '--- printed', printProgram(program).trimEnd());
      if (diagnostics.length > 0) out.push('--- diagnostics', ...show(source, diagnostics));
      out.push('');
    }
    await expect(out.join('\n')).toMatchFileSnapshot('golden/parser.golden.txt');
  });

  it('checker', async () => {
    const w = sampleWorld();
    w.numbers.formulas = CHECK_SOURCE;
    const a = analyzeNumbers(w);
    const out = [
      '--- types',
      ...a.defs.map((d) => `${d.name}: ${d.type}${d.blocked ? '  (blocked)' : ''}`),
    ];
    out.push(
      '--- diagnostics',
      ...show(
        CHECK_SOURCE,
        a.diagnostics.filter((d) => d.stage !== 'eval'),
      ),
    );
    await expect(out.join('\n') + '\n').toMatchFileSnapshot('golden/checker.golden.txt');
  });

  it('evaluation', async () => {
    const w = evalWorld();
    const a = analyzeNumbers(w);
    const name = (id: string): string | undefined => w.entities[id]?.name;
    const out = a.defs
      .filter((d) => d.kind === 'const')
      .map((d) =>
        d.result?.ok
          ? `${d.name} = ${formatValue(d.result.value, { name, maxItems: 10 })}`
          : `${d.name} ! ${d.result?.error.code}: ${d.result?.error.message}`,
      );
    out.push('--- diagnostics', ...show(EVAL_SOURCE, a.diagnostics));
    await expect(out.join('\n') + '\n').toMatchFileSnapshot('golden/eval.golden.txt');
  });
});
