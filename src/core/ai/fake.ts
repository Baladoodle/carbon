import { z } from 'zod';
import { fieldValueSchema, type FieldDef } from '../model/fields';
import { ENTITY_KINDS, LANE_OF_KIND, type EntityKind } from '../model/kinds';
import { fieldValue } from '../model/lifecycle';
import { isEditableCommonField } from '../model/schema';
import { getEntity, schemaOf, type World } from '../model/world';
import type { Entity, Relation } from '../model/entity';
import { edgesFit, kindAllowed } from '../model/validate';
import { hashValue, seededRandom } from '../util/hash';
import {
  cancelled,
  ZERO_USAGE,
  type AiCallMeta,
  type AiGateway,
  type AiLogEntry,
  type AiOutcome,
  type AiRunOptions,
  type AiStatus,
} from './gateway';
import {
  MOMENT_SCHEMAS,
  type Candidate,
  type Moment,
  type MomentRequest,
  type MomentResult,
  type Spot,
} from './moments';

/**
 * A deterministic, offline `AiGateway`: the same world and request always give
 * the same, schema-valid result, and every reference resolves. Packages build
 * their UIs against it; e2e tests run the app with it (`CARBON_AI=fake`).
 */
export interface FakeAiOptions {
  getWorld: () => World;
  /** Delay before the result and between streamed candidates (ms). Default 0. */
  delayMs?: number;
  /** Clock for log entries; default a fixed time (core has no clock). */
  now?: () => string;
  /** Force every call to fail with this error code (for testing error UI). */
  failWith?: 'rate_limited' | 'server' | 'network' | 'invalid_output' | 'budget';
}

const ADJ = [
  'Glass',
  'Ember',
  'Hollow',
  'Drift',
  'Lumen',
  'Ash',
  'Moss',
  'Cinder',
  'Tide',
  'Thorn',
  'Echo',
  'Salt',
  'Vesper',
  'Iron',
  'Feather',
  'Gloam',
];
const NOUN = [
  'Lung',
  'Coat',
  'Bell',
  'Spur',
  'Wake',
  'Thread',
  'Lantern',
  'Reed',
  'Crown',
  'Husk',
  'Shard',
  'Veil',
  'Root',
  'Wing',
  'Knot',
  'Mantle',
];
const PHRASE = [
  'hums when danger is near',
  'trades speed for certainty',
  'remembers the last place you fell',
  'only works in the dark',
  'grows heavier the higher you climb',
  'turns heat into light',
  'makes the band feel smaller',
  'asks you to come back later',
];

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (ms <= 0) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });

export class FakeAiGateway implements AiGateway {
  private enabled = true;
  private pending = 0;
  private readonly entries: AiLogEntry[] = [];
  private readonly listeners = new Set<(s: AiStatus) => void>();
  private seq = 0;

  constructor(private readonly opts: FakeAiOptions) {}

  status(): AiStatus {
    return {
      mode: 'fake',
      enabled: this.enabled,
      ...(this.enabled ? {} : { reason: 'AI is off for this session' }),
      model: 'fake',
      spend: { sessionUsd: 0, monthUsd: 0 },
      budget: { sessionUsd: 2, monthUsd: 20 },
      paused: false,
      pending: this.pending,
    };
  }

  onStatus(listener: (s: AiStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.emit();
  }

  log(limit = 200): Promise<AiLogEntry[]> {
    return Promise.resolve(this.entries.slice(-limit));
  }

  private emit(): void {
    const s = this.status();
    for (const l of this.listeners) l(s);
  }

  async run<M extends Moment>(
    moment: M,
    request: MomentRequest<M>,
    options: AiRunOptions<M> = {},
  ): Promise<AiOutcome<M>> {
    const parsed = MOMENT_SCHEMAS[moment].request.safeParse(request);
    if (!parsed.success)
      return {
        ok: false,
        error: { code: 'bad_request', message: z.prettifyError(parsed.error), retryable: false },
      };
    if (!this.enabled)
      return {
        ok: false,
        error: { code: 'disabled', message: 'AI is off for this session', retryable: false },
      };
    const req = parsed.data as z.output<(typeof MOMENT_SCHEMAS)[M]['request']>;
    const world = this.opts.getWorld();
    const requestHash = hashValue({ moment, req });
    const meta: AiCallMeta = {
      moment,
      requestHash,
      model: 'fake',
      usage: ZERO_USAGE,
      costUsd: 0,
      latencyMs: this.opts.delayMs ?? 0,
      cached: false,
      dropped: 0,
    };
    const entity = 'entityId' in req ? req.entityId : undefined;
    const id = `fake-${++this.seq}`;
    const at = this.opts.now?.() ?? '2026-01-01T00:00:00.000Z';
    const done = (outcome: AiOutcome<M>): AiOutcome<M> => {
      this.entries.push({
        id,
        at,
        moment,
        ...(entity ? { entity } : {}),
        outcome: outcome.ok ? 'ok' : outcome.error.code === 'cancelled' ? 'cancelled' : 'error',
        ...(outcome.ok ? { meta } : { error: outcome.error }),
      });
      this.pending--;
      this.emit();
      return outcome;
    };
    this.pending++;
    this.emit();
    if (this.opts.failWith) {
      await sleep(this.opts.delayMs ?? 0, options.signal);
      const code = this.opts.failWith;
      return done({
        ok: false,
        error: {
          code,
          message: `fake ${code}`,
          retryable: code !== 'invalid_output' && code !== 'budget',
        },
      });
    }
    const rand = seededRandom(requestHash + hashValue(world.entities[entity ?? ''] ?? null));
    try {
      const raw = this.generate(moment, req as never, world, rand);
      if (raw === null)
        return done({
          ok: false,
          error: { code: 'not_found', message: `no entity "${entity ?? ''}"`, retryable: false },
        });
      if (moment === 'spread') {
        const { candidates } = raw as MomentResult<'spread'>;
        for (const c of candidates) {
          await sleep(this.opts.delayMs ?? 0, options.signal);
          if (options.signal?.aborted) return done(cancelled());
          (options.onPartial as ((c: Candidate) => void) | undefined)?.(c);
        }
      } else {
        await sleep(this.opts.delayMs ?? 0, options.signal);
      }
      if (options.signal?.aborted) return done(cancelled());
      const result = MOMENT_SCHEMAS[moment].result.parse(raw) as MomentResult<M>;
      return done({ ok: true, result, meta });
    } catch (e) {
      return done({
        ok: false,
        error: {
          code: 'invalid_output',
          message: e instanceof Error ? e.message : 'invalid output',
          retryable: false,
        },
      });
    }
  }

  private generate(moment: Moment, req: never, world: World, rand: () => number): unknown {
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
    const name = (): string => `${pick(ADJ)} ${pick(NOUN)}`;
    const phrase = (): string => pick(PHRASE);
    const schema = schemaOf(world);

    const valueFor = (field: string, kind: EntityKind, salt: number): unknown => {
      if (field === 'name') return name();
      if (isEditableCommonField(field))
        return field === 'tags'
          ? [pick(ADJ).toLowerCase()]
          : `${name()}: it ${phrase()}${salt > 0 ? ` (${salt + 1})` : ''}`;
      const def = schema.kinds[kind].fields.find((f) => f.key === field);
      return def ? sampleValue(def, world, rand, phrase, salt) : null;
    };

    switch (moment) {
      case 'suggest_one':
      case 'suggest_three': {
        const r = req as MomentRequest<'suggest_one'>;
        const e = getEntity(world, r.entityId);
        if (!e) return null;
        const n = moment === 'suggest_one' ? 1 : 3;
        const seen = new Set((r.avoid ?? []).map((v) => hashValue(v)));
        const out: { value: unknown; note: string }[] = [];
        for (let salt = 0; out.length < n && salt < 50; salt++) {
          const value = valueFor(r.field, e.kind, salt);
          if (seen.has(hashValue(value))) continue;
          // Like the real gateway: never a value the command would refuse.
          if (!edgesFit(e, r.field, value)) continue;
          seen.add(hashValue(value));
          out.push({ value, note: `fits ${e.name}` });
        }
        return moment === 'suggest_one' ? { suggestion: out[0] } : { suggestions: out };
      }
      case 'fill_entity': {
        const r = req as MomentRequest<'fill_entity'>;
        const e = getEntity(world, r.entityId);
        if (!e) return null;
        const keys = [
          'identity',
          'description',
          ...schema.kinds[e.kind].fields.filter((f) => f.ai !== false).map((f) => f.key),
        ];
        const proposals: { field: string; value: unknown; note: string }[] = [];
        let filled = e;
        for (const field of keys) {
          const v = fieldValue(e, field);
          if (!(v === undefined || v === '' || (Array.isArray(v) && v.length === 0))) continue;
          // Every proposal fits the entity alone and with the ones before it
          // (a band's edges stay in order), as the real gateway checks.
          let value: unknown = null;
          for (let salt = 0; salt < 50; salt++) {
            const x = valueFor(field, e.kind, salt);
            if (x !== null && edgesFit(e, field, x) && edgesFit(filled, field, x)) {
              value = x;
              break;
            }
          }
          if (value === null) continue;
          if (!isEditableCommonField(field))
            filled = { ...filled, fields: { ...filled.fields, [field]: value } };
          proposals.push({ field, value, note: 'proposed to fill the gap' });
        }
        return { proposals };
      }
      case 'critique': {
        const r = req as MomentRequest<'critique'>;
        const e = getEntity(world, r.entityId);
        if (!e) return null;
        const notes: unknown[] = [];
        if (e.identity.trim().length < 12)
          notes.push({
            kind: 'weak_identity',
            text: `${e.name} needs a sharper one-line identity.`,
            field: 'identity',
          });
        const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
        const dup = Object.values(world.entities).find(
          (o) => o.id !== e.id && norm(o.name) === norm(e.name),
        );
        if (dup)
          notes.push({
            kind: 'duplicate',
            text: `${e.name} duplicates ${dup.name}.`,
            entities: [dup.id],
          });
        if (Object.keys(e.attributes).length > 0 && e.identity.trim() === '')
          notes.push({ kind: 'just_a_number', text: `${e.name} is only numbers so far.` });
        const rule = world.taste.rules.find((x) => x.enabled);
        if (rule && notes.length === 0 && rand() < 0.3)
          notes.push({
            kind: 'rule_clash',
            text: `Check against "${rule.text}".`,
            ruleId: rule.id,
          });
        return { notes };
      }
      case 'spread': {
        const r = req as MomentRequest<'spread'>;
        const kind = kindForSpot(world, r.spot);
        const count = r.count ?? 12;
        const band = r.spot.type === 'cell' || r.spot.type === 'region' ? r.spot.band : undefined;
        const about =
          r.spot.type === 'entity' &&
          (r.move === 'ground' || r.move === 'cost' || r.move === 'name')
            ? r.spot.entity
            : undefined;
        const candidates: Candidate[] = [];
        const target = about ? getEntity(world, about) : undefined;
        const used = new Set(Object.values(world.entities).map((x) => x.name));
        for (let i = 0; i < count; i++) {
          let n = name();
          for (let k = 2; used.has(n); k++) n = `${name()} ${k}`;
          used.add(n);
          const isBreak = r.move === 'break';
          candidates.push({
            key: `c${i + 1}`,
            kind: isBreak ? null : kind,
            name: n,
            identity: `It ${phrase()}.`,
            ...(target && r.move !== 'name'
              ? aboutChange(world, target, r.move, i)
              : {
                  fields: {},
                  relations:
                    band &&
                    kind !== 'band' &&
                    kind !== 'biome' &&
                    !isBreak &&
                    getEntity(world, band)
                      ? [{ type: 'in_band', target: band }]
                      : [],
                }),
            attributes: {},
            ...(about ? { about } : {}),
            position: { x: Math.round(rand() * 100) / 100, y: Math.round(rand() * 100) / 100 },
            wildcard: i === count - 1,
            rationale: r.direction ? `Follows "${r.direction}".` : `A ${r.move} for this spot.`,
          });
        }
        return {
          axes: r.axes ?? {
            x: { label: 'menace', low: 'gentle', high: 'menacing' },
            y: { label: 'strangeness', low: 'familiar', high: 'strange' },
          },
          candidates,
        };
      }
      case 'patterns': {
        const r = req as MomentRequest<'patterns'>;
        const kills = r.judgements.filter((j) => j.verdict === 'kill');
        const reasons = [...new Set(kills.map((k) => k.reason).filter((x): x is string => !!x))];
        return {
          patterns: reasons.slice(0, 3).map((reason) => ({
            text: `You kill candidates that are "${reason}".`,
            examples: kills
              .filter((k) => k.reason === reason)
              .map((k) => k.candidate.name)
              .slice(0, 3),
            strength: Math.min(
              1,
              kills.filter((k) => k.reason === reason).length / r.judgements.length + 0.2,
            ),
          })),
        };
      }
      case 'spec_draft': {
        const r = req as MomentRequest<'spec_draft'>;
        const es = r.entityIds.map((id) => getEntity(world, id));
        if (es.some((x) => !x)) return null;
        const lines = [`# ${r.name}`, '', '## Summary', '', `${es.length} entities.`, ''];
        for (const x of es)
          if (x) lines.push(`## ${x.name}`, '', x.identity, '', `Why: ${x.why}`, '');
        lines.push(
          '## Acceptance questions',
          '',
          '- Does each entity appear where its spec says?',
          '',
        );
        return { title: r.name, markdown: lines.join('\n') };
      }
    }
  }
}

function kindForSpot(world: World, spot: Spot): EntityKind {
  switch (spot.type) {
    case 'cell':
      return ENTITY_KINDS.find((k) => LANE_OF_KIND[k] === spot.lane) ?? 'item';
    case 'region':
      return 'biome';
    case 'entity':
      return getEntity(world, spot.entity)?.kind ?? 'item';
    case 'selection':
    case 'note': {
      const first = spot.entities[0];
      return (first ? getEntity(world, first)?.kind : undefined) ?? 'item';
    }
  }
}

function sampleValue(
  def: FieldDef,
  world: World,
  rand: () => number,
  phrase: () => string,
  salt: number,
): unknown {
  const lo = def.min ?? 0;
  const hi = def.max ?? Math.max(lo + 10, 10);
  const num = (): number => Math.round((lo + rand() * (hi - lo)) * 100) / 100;
  let v: unknown;
  switch (def.type) {
    case 'text':
    case 'longtext':
      v = `It ${phrase()}${salt > 0 ? ` (${salt + 1})` : ''}`;
      break;
    case 'number':
      v = num();
      break;
    case 'range': {
      const a = num();
      const b = num();
      v = { min: Math.min(a, b), max: Math.max(a, b) };
      break;
    }
    case 'enum':
      v = def.options?.[Math.floor(rand() * def.options.length)] ?? null;
      break;
    case 'list':
      v = [phrase().split(' ')[0] ?? 'odd', `quality ${salt + 1}`];
      break;
    case 'height':
      v = Math.round((rand() - 0.5) * 2000);
      break;
    case 'ref': {
      const options = Object.values(world.entities).filter(
        (e) => !def.refKinds || def.refKinds.includes(e.kind),
      );
      v = options.length > 0 ? (options[Math.floor(rand() * options.length)]?.id ?? null) : null;
      break;
    }
    case 'climate': {
      const r = (): { min: number; max: number } => {
        const a = Math.round(rand() * 100) / 100;
        const b = Math.round(rand() * 100) / 100;
        return { min: Math.min(a, b), max: Math.max(a, b) };
      };
      v = { temperature: r(), moisture: r() };
      break;
    }
    case 'steps':
      v = [{ text: `first, ${phrase()}` }, { text: `then, ${phrase()}` }];
      break;
    case 'boolean':
      v = rand() < 0.5;
      break;
  }
  return v !== null && fieldValueSchema(def).safeParse(v).success ? v : null;
}

/**
 * What a fake Ground or Cost candidate proposes for the entity it is about,
 * so keeping one changes the entity as the real model's would (package W5):
 *
 * - Ground: a relation to a band, biome, material or creature the entity
 *   isn't tied to yet, with its reason as the note
 * - Cost: a two- or three-step route (when the kind has a steps field), each
 *   step naming what it needs, or else a `requires` relation
 *
 * Candidate `i` takes the i-th option, so a spread proposes different ties.
 */
function aboutChange(
  world: World,
  e: Entity,
  move: string,
  i: number,
): { fields: Record<string, unknown>; relations: Relation[] } {
  const schema = schemaOf(world);
  const options = (targets: readonly EntityKind[], verb: string): Relation[] => {
    const out: Relation[] = [];
    for (const [type, def] of Object.entries(schema.relations)) {
      if (def.symmetric || !kindAllowed(def.from, e.kind)) continue;
      for (const t of Object.values(world.entities)) {
        if (t.id === e.id || !targets.includes(t.kind) || !kindAllowed(def.to, t.kind)) continue;
        if (e.relations.some((x) => x.type === type && x.target === t.id)) continue;
        out.push({ type, target: t.id, note: `${verb} ${t.name}.` });
      }
    }
    return out.sort((a, b) => `${a.type}:${a.target}`.localeCompare(`${b.type}:${b.target}`));
  };
  const nth = <T>(xs: readonly T[], n: number): T[] => (xs.length ? [xs[n % xs.length] as T] : []);
  if (move === 'ground')
    return {
      fields: {},
      relations: nth(options(['band', 'biome', 'material', 'creature'], 'Grounded in'), i),
    };
  const materials = Object.values(world.entities).filter((t) => t.kind === 'material');
  const steps = schema.kinds[e.kind].fields.find((f) => f.type === 'steps');
  if (steps && materials.length > 0) {
    const m = materials[i % materials.length] as Entity;
    const route = [
      { text: `Gather ${m.name}`, needs: [m.id] },
      { text: `Work it into ${e.name}` },
      ...(i % 2 === 1 ? [{ text: 'Prove it in the band where it matters' }] : []),
    ];
    return { fields: { [steps.key]: route }, relations: [] };
  }
  return {
    fields: {},
    relations: nth(options(['item', 'capability', 'material'], 'Costs'), i),
  };
}
