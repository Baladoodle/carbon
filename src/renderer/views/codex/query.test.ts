import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { resolvePlacement } from '@core/placement';
import { sampleWorld } from '@core/testing/sample';
import { compileQuery, formatQuery, parseQuery, type Term } from './query';

const world = sampleWorld();
const placements = resolvePlacement(world);
const ids = (q: string): string[] => {
  const c = compileQuery(q, world);
  return Object.values(world.entities)
    .filter((e) => c.match({ entity: e, placement: placements[e.id] }))
    .map((e) => e.id)
    .sort();
};
const errs = (q: string) =>
  compileQuery(q, world).errors.map((e) => [q.slice(e.from, e.to), e.message]);
const strip = (t: Term[]) =>
  t.map((x) => ({ negate: x.negate, key: x.key, op: x.op, values: x.values.map((v) => v.text) }));

describe('parseQuery', () => {
  it('parses the example from the docs', () => {
    const p = parseQuery('state:decided band:"Low Sky" lane:items');
    expect(p.errors).toEqual([]);
    expect(strip(p.terms)).toEqual([
      { negate: false, key: 'state', op: null, values: ['decided'] },
      { negate: false, key: 'band', op: null, values: ['Low Sky'] },
      { negate: false, key: 'lane', op: null, values: ['items'] },
    ]);
    expect(p.terms[1]).toMatchObject({ from: 14, to: 28, keySpan: { from: 14, to: 18 } });
  });

  it('parses negation, operators, alternatives, ranges and words', () => {
    const p = parseQuery(
      ' -state:idea,shaped defense:>=4 menace:<0 y:-100..100 glass "two words" -moss ',
    );
    expect(p.errors).toEqual([]);
    expect(strip(p.terms)).toEqual([
      { negate: true, key: 'state', op: null, values: ['idea', 'shaped'] },
      { negate: false, key: 'defense', op: '>=', values: ['4'] },
      { negate: false, key: 'menace', op: '<', values: ['0'] },
      { negate: false, key: 'y', op: null, values: ['-100..100'] },
      { negate: false, key: null, op: null, values: ['glass'] },
      { negate: false, key: null, op: null, values: ['two words'] },
      { negate: true, key: null, op: null, values: ['moss'] },
    ]);
  });

  it('reports precise errors', () => {
    const at = (q: string) => parseQuery(q).errors.map((e) => [e.from, e.to, e.message]);
    expect(at('band:"Low Sky')).toEqual([[5, 13, 'unclosed quote']]);
    expect(at('state:')).toEqual([[0, 6, 'state: needs a value']]);
    expect(at('state:idea, x')).toEqual([[10, 11, 'a value is missing after ","']]);
    expect(at('band:"a"b')).toEqual([[8, 9, 'expected a space here']]);
    expect(at('"a"b')).toEqual([[3, 4, 'expected a space here']]);
    expect(at('9x:1')).toEqual([[0, 2, '"9x" is not a filter key']]);
    expect(at('a "')).toEqual([[2, 3, 'unclosed quote']]);
  });

  it('unescapes quotes inside quoted values', () => {
    expect(parseQuery('name:"a \\"b\\""').terms[0]?.values[0]?.text).toBe('a "b"');
  });
});

describe('compileQuery', () => {
  it('filters by state, kind, lane and band', () => {
    expect(ids('state:decided')).toEqual(['glide', 'groundline', 'hollows', 'meadow-steps']);
    expect(ids('lane:items')).toEqual([
      'cinder-sting',
      'cloud-anklet',
      'spore-lantern',
      'vent-glass-visor',
    ]);
    expect(ids('kind:Items state:idea,exported')).toEqual([
      'cinder-sting',
      'cloud-anklet',
      'vent-glass-visor',
    ]);
    expect(ids('band:"Low Sky"')).toEqual(['cloud-reef', 'glide', 'low-sky', 'reef-ray']);
    expect(ids('band:"Low Sky" lane:capabilities state:decided')).toEqual(['glide']);
    expect(ids('band:none lane:items')).toEqual(['cinder-sting', 'cloud-anklet']);
    expect(ids('biome:glowmoss-caverns')).toEqual([
      'glowmoss-caverns',
      'lumen-spore',
      'moss-grazer',
      'spore-shrine',
    ]);
    expect(ids('biome:none kind:material')).toEqual(['sky-coral']);
  });

  it('filters by placement mode and height', () => {
    expect(ids('placed:inferred kind:creature')).toEqual([
      'cinder-wasp',
      'moss-grazer',
      'reef-ray',
    ]);
    expect(ids('placed:none')).toEqual(['cinder-sting', 'cloud-anklet', 'sky-coral']);
    expect(ids('kind:band y:0')).toEqual(['groundline']);
    expect(ids('kind:band y:>600')).toEqual(['high-drift', 'low-sky']);
    expect(ids('kind:band y:<-600')).toEqual(['undercroft']);
    expect(ids('kind:band y:-100..100')).toEqual(['groundline', 'hollows', 'low-sky']);
  });

  it('filters by kind fields, attributes and relations', () => {
    expect(ids('subkind:armor')).toEqual(['vent-glass-visor']);
    expect(ids('rarity:rare,uncommon')).toEqual(['sky-coral', 'vent-glass']);
    expect(ids('menace:>0')).toEqual(['cinder-wasp']);
    expect(ids('menace:-1..0')).toEqual(['moss-grazer']);
    expect(ids('danger:>=6')).toEqual(['hollows', 'undercroft']);
    expect(ids('y_top:+inf')).toEqual(['high-drift']);
    expect(ids('defense:>=4')).toEqual(['vent-glass-visor']);
    expect(ids('damage:12')).toEqual(['cinder-sting']);
    expect(ids('properties:glow')).toEqual(['lumen-spore']);
    expect(ids('band:hollows kind:biome')).toEqual(['ash-vents', 'glowmoss-caverns']);
    expect(ids('made_from:"Vent Glass"')).toEqual(['vent-glass-visor']);
    expect(ids('lives_in:ash-vents')).toEqual(['cinder-wasp']);
    expect(ids('route:spore')).toEqual(['spore-lantern']);
    expect(ids('route:lumen-spore')).toEqual(['spore-lantern']);
    expect(ids('mood:calm')).toEqual(['meadow-steps']);
  });

  it('filters by text, has, ai, origin and negation', () => {
    expect(ids('glass')).toEqual(['vent-glass', 'vent-glass-visor']);
    expect(ids('"floating islands"')).toEqual(['low-sky']);
    expect(ids('kind:item -subkind:armor -subkind:accessory')).toEqual([
      'cinder-sting',
      'spore-lantern',
    ]);
    expect(ids('kind:biome -has:signature')).toEqual(['ash-vents', 'cloud-reef']);
    expect(ids('has:why kind:item')).toEqual(['cinder-sting']);
    expect(ids('has:defense')).toEqual(['vent-glass-visor']);
    expect(ids('has:drops')).toEqual(['cinder-wasp', 'moss-grazer']);
    expect(ids('ai:yes')).toEqual([]);
    expect(ids('origin:user').length).toBe(Object.keys(world.entities).length);
    expect(ids('why:sky')).toEqual(['glide']);
    expect(ids('id:anklet name:cloud')).toEqual(['cloud-anklet']);
    expect(ids('tag:x')).toEqual([]);
    expect(ids('')).toHaveLength(Object.keys(world.entities).length);
  });

  it('reports the kinds a query restricts to', () => {
    expect(compileQuery('lane:items', world).kinds).toEqual(['item']);
    expect(compileQuery('kind:band,biome', world).kinds).toEqual(['band', 'biome']);
    expect(compileQuery('-kind:band', world).kinds).toBeNull();
    expect(compileQuery('', world).empty).toBe(true);
  });

  it('explains every bad key and value precisely, and still filters by the rest', () => {
    expect(errs('stat:idea')).toEqual([['stat', 'unknown filter "stat"; did you mean state?']]);
    expect(errs('state:decidd')).toEqual([['decidd', 'no state "decidd"; did you mean decided?']]);
    expect(errs('lane:itms')).toEqual([['itms', 'no lane "itms"; did you mean items?']]);
    expect(errs('band:"Mid Sky"')).toEqual([['"Mid Sky"', 'no band "Mid Sky"']]);
    expect(errs('rarity:mythic')).toEqual([['mythic', 'rarity: no option "mythic"']]);
    expect(errs('menace:lots')).toEqual([['lots', '"lots" is not a number']]);
    expect(errs('menace:5..1')).toEqual([['5..1', '"5..1" is not a range like 2..5']]);
    expect(errs('state:>3')).toEqual([['state', "state: can't compare with >"]]);
    expect(errs('subkind:>3')).toEqual([['3', "subkind: can't compare a choice with >"]]);
    expect(errs('placed:sometimes')).toEqual([
      ['sometimes', 'placed: use pinned, inferred or none'],
    ]);
    expect(errs('ai:maybe')).toEqual([['maybe', 'ai: use yes or no']]);
    expect(errs('origin:me')).toEqual([['me', 'origin: use user or ai']]);
    expect(errs('has:wings')).toEqual([['wings', 'no field "wings"']]);
    expect(errs('climate:hot')).toEqual([['hot', "climate: climate can't be filtered"]]);
    expect(errs('made_from:>2')).toEqual([['made_from', "made_from: can't compare with >"]]);
    expect(errs('y:high')).toEqual([['high', '"high" is not a number']]);
    expect(errs('mood:>1')).toEqual([['1', "mood: can't compare text with >"]]);
    expect(ids('stat:idea kind:feat')).toEqual(['first-descent']);
  });
});

describe('query properties', () => {
  it('never throws, and every error span lies within the source', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc
            .array(
              fc.constantFrom(
                'state',
                ':',
                '"',
                ',',
                ' ',
                '-',
                '>',
                '=',
                '..',
                'a',
                'Low Sky',
                '\\',
              ),
              {
                maxLength: 12,
              },
            )
            .map((xs) => xs.join('')),
        ),
        (src) => {
          const c = compileQuery(src, world);
          for (const e of c.errors) {
            expect(e.from).toBeGreaterThanOrEqual(0);
            expect(e.to).toBeLessThanOrEqual(src.length);
            expect(e.from).toBeLessThanOrEqual(e.to);
            expect(e.message.length).toBeGreaterThan(0);
          }
          for (const t of parseQuery(src).terms) {
            expect(t.from).toBeGreaterThanOrEqual(0);
            expect(t.to).toBeLessThanOrEqual(src.length);
          }
          c.match({ entity: world.entities.glide!, placement: placements.glide });
        },
      ),
      { numRuns: 500 },
    );
  });

  it('round-trips through formatQuery for valid queries', () => {
    const value = fc.oneof(
      fc.constantFrom(
        'decided',
        'Low Sky',
        'a,b',
        'x"y',
        '-neg',
        '2..5',
        'back\\slash',
        'with:colon',
      ),
      fc.stringMatching(/^[a-z0-9]{1,6}$/),
    );
    const term = fc.record({
      negate: fc.boolean(),
      key: fc.option(fc.constantFrom('state', 'band', 'menace', 'y'), { nil: null }),
      op: fc.constantFrom(null, '>', '>=', '<', '<=', '='),
      values: fc.array(value, { minLength: 1, maxLength: 3 }),
    });
    fc.assert(
      fc.property(fc.array(term, { maxLength: 5 }), (raw) => {
        const terms: Term[] = raw.map((t) => ({
          from: 0,
          to: 0,
          negate: t.negate,
          key: t.key,
          keySpan: null,
          op: t.key === null ? null : t.op,
          values: (t.key === null ? t.values.slice(0, 1) : t.values).map((text) => ({
            from: 0,
            to: 0,
            text,
            quoted: false,
          })),
        }));
        const src = formatQuery(terms);
        const back = parseQuery(src);
        expect(back.errors).toEqual([]);
        expect(strip(back.terms)).toEqual(strip(terms));
        expect(formatQuery(back.terms)).toBe(src);
      }),
      { numRuns: 400 },
    );
  });

  it('negating a valid term gives the complement', () => {
    const qs = [
      'state:idea',
      'lane:items',
      'band:hollows',
      'menace:>0',
      'glass',
      'has:why',
      'placed:inferred',
    ];
    for (const q of qs) {
      const a = ids(q);
      const b = ids(`-${q}`);
      expect([...a, ...b].sort()).toEqual(Object.keys(world.entities).sort());
    }
  });
});

describe('numbers in filters', () => {
  it('take the typographic minus the ruler shows, and refuse hex', () => {
    expect(ids('y:<−100')).toEqual(ids('y:<-100'));
    expect(ids('y:<−100').length).toBeGreaterThan(0);
    expect(errs('y:−600..−100')).toEqual([]);
    expect(errs('y:0x10')).toEqual([['0x10', '"0x10" is not a number']]);
  });
});
