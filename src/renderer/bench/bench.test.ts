import { beforeEach, describe, expect, it } from 'vitest';
import { FakeAiGateway } from '@core/ai/fake';
import type { AiGateway } from '@core/ai/gateway';
import { applyCommands } from '@core/commands/apply';
import { cmd, type Command } from '@core/commands/registry';
import type { Note } from '@core/model/notes';
import type { World } from '@core/model/world';
import { sampleWorld } from '@core/testing/sample';
import { createBenchAi, errorText } from './ai';
import { RequestSlots } from './slots';
import { benchStore, fieldId } from './store';

const ctx = { now: '2026-11-02T00:00:00.000Z' };

describe('request slots', () => {
  it('cancels the stale request per entity and channel only', () => {
    const s = new RequestSlots();
    const a = s.start('e', 'field');
    const c = s.start('e', 'critique');
    const other = s.start('f', 'field');
    const b = s.start('e', 'field');
    expect(a.aborted).toBe(true);
    expect(b.aborted).toBe(false);
    expect(c.aborted).toBe(false);
    expect(other.aborted).toBe(false);
    expect(s.isCurrent('e', 'field', a)).toBe(false);
    expect(s.isCurrent('e', 'field', b)).toBe(true);
    s.finish('e', 'field', a); // stale finish does nothing
    expect(s.isCurrent('e', 'field', b)).toBe(true);
    s.finish('e', 'field', b);
    expect(s.size).toBe(2);
    s.cancel('e');
    expect(c.aborted).toBe(true);
    expect(s.size).toBe(1);
  });
});

describe('bench AI', () => {
  let world: World;
  let notes: Record<string, Note[]>;
  let said: string[];
  const reset = (): void =>
    benchStore.set({
      field: null,
      pending: {},
      three: null,
      loading: {},
      critiquing: {},
      shown: {},
      focusRequest: null,
      error: {},
      rewrites: {},
    });
  let dismissed: string[] = [];
  const make = (gateway?: AiGateway) =>
    createBenchAi({
      gateway: gateway ?? new FakeAiGateway({ getWorld: () => world }),
      getWorld: () => world,
      dispatch: (_label: string, commands: Command[]) => {
        const r = applyCommands(world, commands, ctx);
        if (!r.ok)
          return Promise.resolve({ ok: false as const, error: { message: r.error.message } });
        world = r.value.world;
        return Promise.resolve({ ok: true as const });
      },
      publishNotes: (s, n) => {
        notes[s] = n;
      },
      say: (t) => said.push(t),
      dismissNote: (id) => dismissed.push(id),
    });
  beforeEach(() => {
    dismissed = [];
    world = sampleWorld();
    notes = {};
    said = [];
    reset();
  });

  it('tab shows one suggestion, tab accepts it with the ai marker, tab again gives another', async () => {
    const b = make();
    await b.suggestOne('glide', 'gates');
    const first = benchStore.get().pending[fieldId('glide', 'gates')];
    expect(first?.from).toBe('suggest');
    await b.suggestOne('glide', 'gates');
    expect(world.entities['glide']!.fields.gates).toBe(first!.value);
    expect(world.entities['glide']!.ai_fields).toContain('gates');
    await b.suggestOne('glide', 'gates');
    const second = benchStore.get().pending[fieldId('glide', 'gates')];
    expect(second).toBeDefined();
    expect(second!.value).not.toEqual(first!.value);
    b.dismiss('glide', 'gates');
    expect(benchStore.get().pending[fieldId('glide', 'gates')]).toBeUndefined();
  });

  it('shift+tab gives three valid alternatives and picks one', async () => {
    const b = make();
    await b.suggestThree('spore-lantern', 'moment');
    const t = benchStore.get().three;
    expect(t?.options).toHaveLength(3);
    await b.pickThree(1);
    expect(world.entities['spore-lantern']!.fields.moment).toBe(t!.options[1]!.value);
    expect(benchStore.get().three).toBeNull();
  });

  it('fill proposes only for empty fields, each accepted or rejected on its own', async () => {
    const b = make();
    await b.fill('sky-coral');
    const ps = b.proposalsOf('sky-coral');
    expect(ps.length).toBeGreaterThan(1);
    for (const [k] of ps) {
      const key = k.slice('sky-coral:'.length);
      expect(key).not.toBe('name');
      expect(key).not.toBe('rarity'); // already filled
      expect(key).not.toBe('identity'); // already filled
    }
    const [firstKey] = ps[0]!;
    const key = firstKey.slice('sky-coral:'.length);
    await b.accept('sky-coral', key);
    expect(world.entities['sky-coral']!.ai_fields).toContain(key);
    const [secondKey] = b.proposalsOf('sky-coral')[0]!;
    b.dismiss('sky-coral', secondKey.slice('sky-coral:'.length));
    expect(b.proposalsOf('sky-coral').length).toBe(ps.length - 2);
    await b.acceptAll('sky-coral');
    expect(b.proposalsOf('sky-coral')).toEqual([]);
    expect(world.entities['sky-coral']!.ai_fields.length).toBe(ps.length - 1);
  });

  it('critique publishes notes under ai:<id>', async () => {
    const r = applyCommands(
      world,
      [cmd('entity.update', { id: 'glide', set: { identity: 'Fly' } })],
      ctx,
    );
    if (!r.ok) throw new Error(r.error.message);
    world = r.value.world;
    const b = make();
    await b.critique('glide', 'finish_edit');
    expect(notes['ai:glide']?.some((n) => n.kind === 'weak_identity')).toBe(true);
    expect(benchStore.get().critiquing['glide']).toBeUndefined();
  });

  it('a note on a field the AI wrote offers Rewrite: the note is the guidance, accepting is one command', async () => {
    const sent: unknown[] = [];
    const fake = new FakeAiGateway({ getWorld: () => world });
    const run = fake.run.bind(fake);
    fake.run = ((moment, req, opts) => {
      sent.push({ moment, req });
      return run(moment, req, opts);
    });
    const b = make(fake);
    const set = (value: string, source: 'ai' | 'user') => {
      const r = applyCommands(
        world,
        [cmd('entity.setField', { id: 'glide', field: 'identity', value, source })],
        ctx,
      );
      if (!r.ok) throw new Error(r.error.message);
      world = r.value.world;
    };
    set('Odd.', 'ai');
    await b.critique('glide', 'on_demand');
    const note = notes['ai:glide']!.find((n) => n.kind === 'weak_identity')!;
    expect(benchStore.get().rewrites[note.id]).toMatchObject({
      entity: 'glide',
      field: 'identity',
    });
    expect(b.rewritableNote(note.id)).not.toBeNull();
    await b.rewrite(note.id);
    const last = sent.at(-1) as { moment: string; req: { field: string; guidance?: string } };
    expect(last.moment).toBe('suggest_one');
    expect(last.req).toMatchObject({ field: 'identity', guidance: note.text });
    const p = benchStore.get().pending[fieldId('glide', 'identity')];
    expect(p).toMatchObject({ from: 'suggest', noteId: note.id });
    const before = world;
    await b.accept('glide', 'identity');
    expect(world.entities.glide!.identity).toBe(p!.value);
    expect(world.entities.glide!.ai_fields).toContain('identity');
    // One command: the world before it is one step back.
    expect(before.entities.glide!.identity).toBe('Odd.');
    expect(dismissed).toEqual([note.id]);
    expect(benchStore.get().rewrites[note.id]).toBeUndefined();

    // Once you edit the field, it's yours: no Rewrite.
    set('Odd.', 'ai');
    await b.critique('glide', 'on_demand');
    const again = notes['ai:glide']!.find((n) => n.kind === 'weak_identity')!;
    expect(b.rewritableNote(again.id)).not.toBeNull();
    set('Mine.', 'user');
    expect(b.rewritableNote(again.id)).toBeNull();
    // A note on a field you wrote never offers it.
    await b.critique('glide', 'on_demand');
    const mine = notes['ai:glide']!.find((n) => n.kind === 'weak_identity')!;
    expect(benchStore.get().rewrites[mine.id]).toBeUndefined();
  });

  it('a newer request cancels the stale one, whose result is never shown', async () => {
    const slow = new FakeAiGateway({ getWorld: () => world, delayMs: 30 });
    const b = make(slow);
    const first = b.suggestOne('glide', 'gates');
    const second = b.suggestThree('glide', 'gates');
    await Promise.all([first, second]);
    expect(benchStore.get().pending[fieldId('glide', 'gates')]).toBeUndefined();
    expect(benchStore.get().three?.options).toHaveLength(3);
    const log = await slow.log();
    expect(log.map((l) => l.outcome)).toEqual(['cancelled', 'ok']);
  });

  it('drops a critique that lands after its entity was deleted', async () => {
    const fake = new FakeAiGateway({ getWorld: () => world });
    let answered: () => void = () => {};
    const built = new Promise<void>((r) => (answered = r));
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    // Answers from the world as it was when asked (like the real gateway), then arrives late.
    const late = {
      run: async (...args: Parameters<AiGateway['run']>) => {
        const out = await fake.run(...args);
        answered();
        await gate;
        return out;
      },
    } as unknown as AiGateway;
    const weak = applyCommands(
      world,
      [cmd('entity.update', { id: 'glide', set: { identity: 'Fly' } })],
      ctx,
    );
    if (!weak.ok) throw new Error(weak.error.message);
    world = weak.value.world;
    const b = make(late);
    const p = b.critique('glide', 'on_demand');
    await built;
    const r = applyCommands(world, [cmd('entity.delete', { id: 'glide' })], ctx);
    if (!r.ok) throw new Error(r.error.message);
    world = r.value.world;
    release();
    await p;
    expect(notes['ai:glide'] ?? []).toEqual([]);
  });

  it('says why when the AI is off, and stays quiet for unasked critiques', async () => {
    const off = new FakeAiGateway({ getWorld: () => world });
    off.setEnabled(false);
    const b = make(off);
    await b.suggestOne('glide', 'gates');
    expect(said).toEqual(['AI is off for this session']);
    await b.critique('glide', 'finish_edit');
    expect(said).toHaveLength(1);
    await b.critique('glide', 'on_demand');
    expect(said).toHaveLength(2);
    expect(errorText({ code: 'cancelled', message: '', retryable: false })).toBeNull();
    expect(errorText({ code: 'budget', message: '', retryable: false })).toMatch(/budget/);
  });

  it('never suggests for a field the schema keeps from the AI', async () => {
    world = {
      ...world,
      schema: {
        ...world.schema,
        kinds: {
          capability: { fields: [{ key: 'gates', label: 'Gates', type: 'text', ai: false }] },
        },
      },
    };
    const b = make();
    await b.suggestOne('glide', 'gates');
    expect(benchStore.get().pending).toEqual({});
  });
});
