import type { AiError, AiGateway } from '@core/ai/gateway';
import type { Suggestion } from '@core/ai/moments';
import { cmd, type Command } from '@core/commands/registry';
import type { Note } from '@core/model/notes';
import { getEntity, schemaOf, type World } from '@core/model/world';
import { hashValue } from '@core/util/hash';
import { critiqueNotes, critiqueSource } from '@core/bench/critique';
import { RequestSlots } from './slots';
import { benchStore, fieldId, setBench, setEntry, type Pending } from './store';
import { checkValue, defOf, isEmptyField } from '@core/bench/value';

/**
 * The Bench's AI moments (docs/EXPERIENCE.md §5), through an `AiGateway` (in
 * the app, the renderer's IPC client). Every proposal is checked against its
 * field before it's shown; accepting one is an ordinary command with
 * `source: 'ai'` (so it carries the `ai` marker and undoes like any edit).
 * Prompts are not built here: requests carry ids (foundation §1.9).
 */
export interface BenchAiDeps {
  gateway: AiGateway;
  getWorld: () => World | null;
  dispatch: (
    label: string,
    commands: Command[],
  ) => Promise<{ ok: true } | { ok: false; error: { message: string } }>;
  publishNotes: (source: string, notes: Note[]) => void;
  /** Tells the user something (AI off, an error). */
  say: (text: string, tone: 'info' | 'error') => void;
}

/** What to tell the user about a failed call; cancellations are silent. */
export function errorText(e: AiError): string | null {
  switch (e.code) {
    case 'cancelled':
      return null;
    case 'disabled':
      return 'AI is off for this session';
    case 'no_key':
      return 'AI needs an API key';
    case 'budget':
      return 'AI paused: the budget is reached';
    case 'not_found':
      return 'That entity no longer exists';
    default:
      return e.message;
  }
}

/** The command that writes an AI value into a field. */
export function acceptCommand(entityId: string, field: string, value: unknown): Command {
  return cmd('entity.setField', { id: entityId, field, value, source: 'ai' });
}

export function createBenchAi(deps: BenchAiDeps) {
  const slots = new RequestSlots();

  const fieldDef = (entityId: string, key: string) => {
    const w = deps.getWorld();
    const e = w ? getEntity(w, entityId) : undefined;
    if (!w || !e) return null;
    const def = defOf(schemaOf(w).kinds[e.kind], key);
    return def ? { w, e, def } : null;
  };

  /** Keeps only suggestions that are valid for the field and not empty. */
  const valid = (entityId: string, key: string, xs: readonly Suggestion[]): Suggestion[] => {
    const f = fieldDef(entityId, key);
    if (!f) return [];
    return xs.flatMap((s) => {
      const r = checkValue(f.def, s.value);
      return r.ok && r.value !== null ? [{ ...s, value: r.value }] : [];
    });
  };

  const fail = (entityId: string, e: AiError): void => {
    const text = errorText(e);
    if (text) {
      setEntry('error', entityId, text);
      deps.say(text, e.code === 'disabled' ? 'info' : 'error');
    }
  };

  const remember = (id: string, value: unknown): void => {
    const shown = benchStore.get().shown[id] ?? [];
    if (!shown.some((v) => hashValue(v) === hashValue(value)))
      setEntry('shown', id, [...shown, value]);
  };

  /** tab: one ghost suggestion. With one already showing, tab accepts it instead. */
  async function suggestOne(entityId: string, key: string): Promise<void> {
    const id = fieldId(entityId, key);
    if (benchStore.get().pending[id]) return accept(entityId, key);
    const f = fieldDef(entityId, key);
    if (!f || f.def.ai === false) return;
    const signal = slots.start(entityId, 'field');
    setEntry('loading', id, true);
    setEntry('error', entityId, undefined);
    setBench({ three: null });
    try {
      const out = await deps.gateway.run(
        'suggest_one',
        { entityId, field: key, avoid: benchStore.get().shown[id] ?? [] },
        { signal },
      );
      if (!slots.isCurrent(entityId, 'field', signal)) return;
      if (!out.ok) return fail(entityId, out.error);
      const [s] = valid(entityId, key, [out.result.suggestion]);
      if (!s) return deps.say('The suggestion didn’t fit this field', 'error');
      remember(id, s.value);
      const p: Pending = { value: s.value, from: 'suggest', ...(s.note ? { note: s.note } : {}) };
      setEntry('pending', id, p);
    } finally {
      slots.finish(entityId, 'field', signal);
      setEntry('loading', id, undefined);
    }
  }

  /** shift+tab: three alternatives under the field. */
  async function suggestThree(entityId: string, key: string): Promise<void> {
    const id = fieldId(entityId, key);
    const f = fieldDef(entityId, key);
    if (!f || f.def.ai === false) return;
    const signal = slots.start(entityId, 'field');
    setEntry('loading', id, true);
    setEntry('error', entityId, undefined);
    setEntry('pending', id, undefined);
    try {
      const out = await deps.gateway.run(
        'suggest_three',
        { entityId, field: key, avoid: benchStore.get().shown[id] ?? [] },
        { signal },
      );
      if (!slots.isCurrent(entityId, 'field', signal)) return;
      if (!out.ok) return fail(entityId, out.error);
      const options = valid(entityId, key, out.result.suggestions);
      if (options.length === 0) return deps.say('None of the suggestions fit this field', 'error');
      for (const o of options) remember(id, o.value);
      setBench({ three: { entity: entityId, key, options } });
    } finally {
      slots.finish(entityId, 'field', signal);
      setEntry('loading', id, undefined);
    }
  }

  /** 1/2/3: picks one of the three. */
  async function pickThree(index: number): Promise<void> {
    const t = benchStore.get().three;
    const o = t?.options[index];
    if (!t || !o) return;
    setBench({ three: null });
    await write(t.entity, t.key, o.value, 'Accept suggestion');
  }

  /** ctrl+enter: proposals for every empty field, each waiting in its field. */
  async function fill(entityId: string): Promise<void> {
    const w = deps.getWorld();
    const e = w ? getEntity(w, entityId) : undefined;
    if (!w || !e) return;
    const loadingKey = fieldId(entityId, '*');
    const signal = slots.start(entityId, 'field');
    setEntry('loading', loadingKey, true);
    setEntry('error', entityId, undefined);
    setBench({ three: null });
    try {
      const out = await deps.gateway.run('fill_entity', { entityId }, { signal });
      if (!slots.isCurrent(entityId, 'field', signal)) return;
      if (!out.ok) return fail(entityId, out.error);
      const now = deps.getWorld();
      const cur = now ? getEntity(now, entityId) : undefined;
      if (!now || !cur) return;
      const kind = schemaOf(now).kinds[cur.kind];
      let shown = 0;
      for (const p of out.result.proposals) {
        const def = defOf(kind, p.field);
        // Only empty fields, only valid values, never the name.
        if (!def || def.key === 'name' || def.ai === false || !isEmptyField(cur, p.field)) continue;
        const r = checkValue(def, p.value);
        if (!r.ok || r.value === null) continue;
        setEntry('pending', fieldId(entityId, p.field), {
          value: r.value,
          from: 'fill',
          ...(p.note ? { note: p.note } : {}),
        });
        shown++;
      }
      if (shown === 0) deps.say('Nothing to fill', 'info');
    } finally {
      slots.finish(entityId, 'field', signal);
      setEntry('loading', loadingKey, undefined);
    }
  }

  async function write(
    entityId: string,
    key: string,
    value: unknown,
    label: string,
  ): Promise<boolean> {
    const r = await deps.dispatch(label, [acceptCommand(entityId, key, value)]);
    if (!r.ok) {
      deps.say(r.error.message, 'error');
      return false;
    }
    return true;
  }

  /** Accepts the suggestion or proposal waiting in a field. */
  async function accept(entityId: string, key: string): Promise<void> {
    const id = fieldId(entityId, key);
    const p = benchStore.get().pending[id];
    if (!p) return;
    setEntry('pending', id, undefined);
    const f = fieldDef(entityId, key);
    await write(entityId, key, p.value, `Accept ${f?.def.label.toLowerCase() ?? key}`);
  }

  /** Rejects (esc) what waits in a field, and closes the three. */
  function dismiss(entityId: string, key: string): void {
    setEntry('pending', fieldId(entityId, key), undefined);
    const t = benchStore.get().three;
    if (t && t.entity === entityId && t.key === key) setBench({ three: null });
  }

  /** Every fill proposal waiting on an entity. */
  const proposalsOf = (entityId: string): [string, Pending][] =>
    Object.entries(benchStore.get().pending).filter(
      ([k, p]) => k.startsWith(`${entityId}:`) && p.from === 'fill',
    );

  async function acceptAll(entityId: string): Promise<void> {
    const ps = proposalsOf(entityId);
    if (ps.length === 0) return;
    for (const [k] of ps) setEntry('pending', k, undefined);
    const cmds = ps.map(([k, p]) => acceptCommand(entityId, k.slice(entityId.length + 1), p.value));
    const r = await deps.dispatch(`Accept ${ps.length} proposals`, cmds);
    if (!r.ok) deps.say(r.error.message, 'error');
  }

  function rejectAll(entityId: string): void {
    for (const [k] of proposalsOf(entityId)) setEntry('pending', k, undefined);
  }

  /** Critique: after finishing an edit, on a state change, or on demand. */
  async function critique(
    entityId: string,
    trigger: 'finish_edit' | 'state_change' | 'on_demand',
  ): Promise<void> {
    const signal = slots.start(entityId, 'critique');
    setEntry('critiquing', entityId, true);
    try {
      const out = await deps.gateway.run('critique', { entityId, trigger }, { signal });
      if (!slots.isCurrent(entityId, 'critique', signal)) return;
      if (!out.ok) {
        // A critique you didn't ask for fails quietly; one you asked for says why.
        if (trigger === 'on_demand') fail(entityId, out.error);
        return;
      }
      const w = deps.getWorld();
      // An entity deleted while its critique was out has nothing left to note.
      if (!w || !getEntity(w, entityId)) return;
      deps.publishNotes(critiqueSource(entityId), critiqueNotes(w, entityId, out.result.notes));
      if (trigger === 'on_demand' && out.result.notes.length === 0) deps.say('No notes', 'info');
    } finally {
      slots.finish(entityId, 'critique', signal);
      setEntry('critiquing', entityId, undefined);
    }
  }

  return {
    suggestOne,
    suggestThree,
    pickThree,
    fill,
    accept,
    dismiss,
    acceptAll,
    rejectAll,
    proposalsOf,
    critique,
    cancel: (entityId: string) => slots.cancel(entityId),
    slots,
  };
}

export type BenchAi = ReturnType<typeof createBenchAi>;
