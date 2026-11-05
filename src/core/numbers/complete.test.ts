import { describe, expect, it } from 'vitest';
import { schemaOf } from '../model/world';
import { sampleWorld } from '../testing/sample';
import { completions } from './complete';
import { analyzeNumbers } from './engine';

/** Name completion in the formula editor (review-b, integrate §10 gap). */
const SOURCE = `taken(raw, def) = raw * k / (k + def)
hit = taken(20, 4)
armor = items where subkind == "armor"
`;
const world = sampleWorld();
world.numbers.formulas = SOURCE;
const analysis = analyzeNumbers(world);
const opts = { schema: schemaOf(world), variables: world.numbers.variables };
const at = (src: string, marker = '|') => {
  const offset = src.indexOf(marker);
  const text = src.replace(marker, '');
  return completions(
    analyzeNumbers({ ...world, numbers: { ...world.numbers, formulas: text } }),
    text,
    offset,
    opts,
  );
};
const labels = (src: string): string[] => at(src)?.items.map((c) => c.label) ?? [];

describe('completions', () => {
  it('offers definitions, variables, built-ins and collections by prefix, with their types', () => {
    const c = completions(analysis, `${SOURCE}x = ta`, SOURCE.length + 6, opts);
    expect(c?.from).toBe(SOURCE.length + 4);
    expect(c?.to).toBe(SOURCE.length + 6);
    expect(c?.items[0]).toEqual({
      label: 'taken',
      kind: 'def',
      detail: '(number, number) → number',
      insert: 'taken(',
    });
    expect(labels(`${SOURCE}x = ba|`)).toEqual(
      expect.arrayContaining(['base_health', 'band', 'bands']),
    );
    expect(labels(`${SOURCE}x = ba|`)[0]).toBe('base_health');
    expect(labels(`${SOURCE}x = su|`)).toContain('sum');
    expect(at(`${SOURCE}x = su|`)?.items.find((c) => c.label === 'sum')?.insert).toBe('sum(');
  });

  it('offers a function’s parameters first inside it', () => {
    expect(labels('f(raw, rate) = r|')).toEqual(expect.arrayContaining(['raw', 'rate']));
    expect(labels('f(raw, rate) = r|').slice(0, 2)).toEqual(['raw', 'rate']);
    // …and not in the next line
    expect(labels('f(raw, rate) = raw\ng = r|')).not.toContain('rate');
  });

  it('offers only entity properties after a dot', () => {
    const ls = labels(`${SOURCE}x = sum(armor, .d|)`);
    expect(ls).toEqual(expect.arrayContaining(['damage', 'danger_min', 'deed']));
    expect(ls).not.toContain('def');
    expect(labels('x = it.|').length).toBeGreaterThan(3);
  });

  it('offers nothing in strings, comments, numbers, or with nothing typed', () => {
    expect(at('x = "ar|')).toBeNull();
    expect(at('x = 1 # ta|')).toBeNull();
    expect(at('x = 12|')).toBeNull();
    expect(at('x = |')).toBeNull();
    expect(completions(analysis, 'x = ', 4, { ...opts, explicit: true })?.items.length).toBe(8);
  });

  it('offers nothing when the name is already complete and alone', () => {
    expect(labels(`${SOURCE}x = armor|`)).not.toContain('armor');
  });

  it('never throws on any offset of any source', () => {
    const src = `${SOURCE}y = "unterminated\nz = .\n# c\n😀 = 1`;
    for (let i = 0; i <= src.length; i++)
      expect(() => completions(analysis, src, i, { ...opts, explicit: true })).not.toThrow();
  });
});
