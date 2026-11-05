import { z } from 'zod';
import type { AiGateway } from '@core/ai/gateway';
import {
  CandidateSchema,
  MoveSchema,
  SpotSchema,
  AxisSchema,
  type Candidate,
} from '@core/ai/moments';
import { createNumbersAdapter } from '@core/checks/numbers';
import { resolvedPlaces } from '@core/checks/placement';
import { createCheckRunner } from '@core/checks/runner';
import { compileQuery } from '@core/codex/query';
import { cmd, type Command } from '@core/commands/registry';
import { buildSpec, isExportable, selectForExport } from '@core/export/spec';
import {
  ArtDirectionSchema,
  EMPTY_ART,
  ImageIdSchema,
  ImageKindSchema,
  ImageModelSchema,
  ImageQualitySchema,
  ImageSizeSchema,
} from '@core/images/model';
import type { EntityImages } from '@core/images/model';
import type { BatchPlanRequestSchema } from '@core/images/gateway';
import {
  type BatchPlan,
  type ImageEstimate,
  type ImageEstimateRequest,
} from '@core/images/gateway';
import type { Entity } from '@core/model/entity';
import { RelationSchema, KilledSchema } from '@core/model/entity';
import { EntityIdSchema } from '@core/model/ids';
import {
  ENTITY_KINDS,
  ENTITY_STATES,
  EntityKindSchema,
  EntityStateSchema,
} from '@core/model/kinds';
import { canTransition, missingFor, TRANSITIONS } from '@core/model/lifecycle';
import type { Note } from '@core/model/notes';
import { getEntity, schemaOf, type World } from '@core/model/world';
import {
  analyzeNumbers,
  compileExpression,
  formatValue,
  formulaErrors,
  summarize,
  toPlain,
} from '@core/numbers';
import { placementOf } from '@core/placement';
import { MOVE_DEFS } from '@core/spreads/moves';
import {
  allSpreads,
  candidateOf,
  makeSpread,
  newSpreadId,
  readSpread,
  type SpreadData,
} from '@core/spreads/record';
import { checkSpot, spotLabel } from '@core/spreads/spot';
import { candidateRole, keepCommands, killCommands, targetOf } from '@core/spreads/triage';
import { activeRules } from '@core/taste/context';
import type { AgentReveal } from '@shared/agent';
import type { DispatchResult } from '@shared/ipc';

/**
 * The agent's tools (docs/MCP.md §2–§4). Each is a zod input schema, a kind
 * and a handler. The host (host.ts) validates the input, checks access,
 * spending and the write rate, runs the handler, logs the call and turns the
 * outcome into an MCP result.
 *
 * Rules every handler keeps:
 *  - reads come from `ctx.world()`, the main process's world, always current
 *  - a write is ONE `ctx.write(commands, label)`: one transaction, one undo
 *    step, validated by the same commands as the UI, refused with the
 *    command's own error code
 *  - nothing returns a file path, a key or an image's pixels
 */

export type ToolKind = 'read' | 'write' | 'ui' | 'paid' | 'free';

export interface ToolError {
  code: string;
  message: string;
}

export type ToolOutcome =
  | { ok: true; data: unknown; summary?: string; rev?: number; costUsd?: number }
  | { ok: false; error: ToolError; summary?: string };

/** The image gateway, as far as the tools use it (MainImageGateway in the app; a fake in tests). */
export interface AgentImages {
  prompt(
    req: { entityId: string; kind: 'concept' | 'icon' },
    signal?: AbortSignal,
  ): Promise<
    | { ok: true; prompt: string; claudeCostUsd: number }
    | { ok: false; error: { code: string; message: string } }
  >;
  estimate(req: ImageEstimateRequest): ImageEstimate;
  generate(req: {
    requestId: string;
    entityId: string;
    kind: 'concept' | 'icon';
    prompt: string;
    model?: string;
    quality?: string;
    size?: string;
    reference?: string;
    select?: boolean;
  }): Promise<ImageCallResult>;
  iconFromConcept(req: {
    entityId: string;
    from?: string;
    select?: boolean;
  }): Promise<ImageCallResult>;
  batchPlan(req: z.input<typeof BatchPlanRequestSchema>): Promise<BatchPlan>;
  batchRun(req: {
    batchId: string;
    kind: 'concept' | 'icon';
    items: { entityId: string; prompt: string }[];
    select?: boolean;
  }): Promise<{
    items: { entityId: string; result: ImageCallResult }[];
    costUsd: number;
    cancelled: boolean;
  }>;
  sheetRun(req: { batchId: string; items: { entityId: string; line: string }[] }): Promise<{
    sheets: (
      | { ok: true; review: SheetReviewLike; receipt: { costUsd: number } }
      | {
          ok: false;
          error: { code: string; message: string };
          receipt?: { costUsd: number };
          entityIds: string[];
        }
    )[];
    costUsd: number;
    cancelled: boolean;
  }>;
  sheetCrop(req: { entityId: string; imageId: string }): Promise<SheetReviewLike | null>;
  sheetAccept(req: {
    entityId: string;
    imageId: string;
    cells: number[];
    select?: boolean;
  }): Promise<
    | { ok: true; images: { id: string; entity: string; kind: string }[] }
    | { ok: false; error: { code: string; message: string } }
  >;
  status(): { mode: string; enabled: boolean; reason?: string };
}

type ImageCallResult =
  | {
      ok: true;
      image: { id: string; entity: string; kind: string };
      receipt: { costUsd: number };
    }
  | {
      ok: false;
      error: { code: string; message: string; unknownOutcome?: boolean };
      receipt?: { costUsd: number };
    };

interface SheetReviewLike {
  sheet: { id: string; entity: string };
  cells: { index: number; entityId: string; row: number; col: number; flags: string[] }[];
}

export interface ToolContext {
  world(): World;
  /** One transaction: one undo step, labelled "Agent: …", marked `by: 'agent'`. */
  write(commands: Command[], label: string): DispatchResult;
  ai: AiGateway;
  images(): AgentImages | null;
  reveal(r: AgentReveal): void;
  /** Mechanical-check notes now open (not dismissed). */
  notes(): Promise<Note[]>;
  /** What the agent may still spend before its budget stops it. */
  remainingUsd(): number;
  now(): string;
  /** A fresh id for a request or batch. */
  newId(prefix: string): string;
  signal?: AbortSignal;
}

export interface ToolDef<I extends z.ZodType = z.ZodType> {
  name: string;
  title: string;
  description: string;
  input: I;
  kind: ToolKind;
  /** True for a write that removes something (MCP's destructiveHint). */
  destructive?: boolean;
  /** For a paid tool: true when this input costs nothing (an icon plan, say). */
  free?: (input: z.output<I>) => boolean;
  /** For a paid tool: the estimate it must fit in the agent's budget, before it runs. */
  estimate?: (ctx: ToolContext, input: z.output<I>) => number | ToolError;
  run(ctx: ToolContext, input: z.output<I>): Promise<ToolOutcome> | ToolOutcome;
}

const tool = <I extends z.ZodType>(def: ToolDef<I>): ToolDef => def;

// ── Helpers ─────────────────────────────────────────────────────────────────

const fail = (code: string, message: string): ToolOutcome => ({
  ok: false,
  error: { code, message },
});

const notFound = (id: string): ToolOutcome => fail('entity.not_found', `no entity "${id}"`);

/** A short text: names, identities and the like. The existing limits are on the commands; these stop floods. */
const Text = z.string().max(20_000);
const Id = EntityIdSchema;

/** The result of a write: what changed and how to see it. */
function written(r: DispatchResult, data: unknown, summary: string): ToolOutcome {
  if (!r.ok) return { ok: false, error: { code: r.error.code, message: r.error.message }, summary };
  return { ok: true, data, summary, rev: r.rev };
}

const brief = (e: Entity): Record<string, unknown> => ({
  id: e.id,
  kind: e.kind,
  name: e.name,
  state: e.state,
  identity: e.identity,
});

const imagesOf = (w: World, id: string): EntityImages | undefined =>
  w.images && Object.prototype.hasOwnProperty.call(w.images, id) ? w.images[id] : undefined;

/** Image metadata without anything that could be large (no pixels; prompts trimmed). */
function imageSummary(w: World, id: string): unknown {
  const imgs = imagesOf(w, id);
  if (!imgs) return { concept: null, icon: null, all: [] };
  return {
    concept: imgs.concept ?? null,
    icon: imgs.icon ?? null,
    all: imgs.all.map((m) => ({
      id: m.id,
      kind: m.kind,
      origin: m.origin.by,
      ...('prompt' in m && typeof m.prompt === 'string' ? { prompt: m.prompt.slice(0, 500) } : {}),
      ...(m.sheet ? { sheet: m.sheet } : {}),
    })),
  };
}

function placementSummary(w: World, id: string): unknown {
  const p = placementOf(w, id);
  if (!p) return null;
  return { mode: p.mode, reason: p.reason, y: p.y, bands: p.bands, biomes: p.biomes, via: p.via };
}

const nextStates = (w: World, e: Entity): unknown =>
  ENTITY_STATES.filter((s) => s !== e.state && canTransition(e.state, s)).map((s) => ({
    state: s,
    missing: missingFor(schemaOf(w), e, s),
  }));

/** The keys a create or update writes, as `agent_fields` keys them. */
function writtenKeys(set: Record<string, unknown>): string[] {
  return Object.keys(set).filter((k) => set[k] !== null && set[k] !== undefined);
}

/** The text of a value the way the UI shows it, for summaries. */
const short = (s: string, n = 60): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ── Reads ───────────────────────────────────────────────────────────────────

const worldSummary = tool({
  name: 'world_summary',
  title: 'World summary',
  description:
    'The world at a glance: bands bottom to top with their Y ranges, entity counts per kind and state, open notes, spreads, numbers and taste. Start here.',
  kind: 'read',
  input: z.object({}),
  async run(ctx) {
    const w = ctx.world();
    const ents = Object.values(w.entities);
    const counts: Record<string, Record<string, number>> = {};
    for (const k of ENTITY_KINDS) counts[k] = { total: 0 };
    for (const e of ents) {
      const c = counts[e.kind] as Record<string, number>;
      c.total = (c.total ?? 0) + 1;
      c[e.state] = (c[e.state] ?? 0) + 1;
    }
    const bands = ents
      .filter((e) => e.kind === 'band')
      .map((b) => ({ id: b.id, name: b.name, state: b.state, y: placementOf(w, b.id)?.y ?? null }))
      .sort((a, b) => (a.y?.min ?? Infinity) - (b.y?.min ?? Infinity));
    const notes = await ctx.notes();
    const byKind: Record<string, number> = {};
    for (const n of notes) byKind[n.kind] = (byKind[n.kind] ?? 0) + 1;
    const analysis = analyzeNumbers(w);
    const errors = formulaErrors(analysis).filter((e) => e.severity === 'error');
    const spreads = allSpreads(w);
    return {
      ok: true,
      data: {
        entities: ents.length,
        counts,
        bands,
        notes: { open: notes.length, byKind },
        spreads: {
          total: spreads.length,
          open: spreads.reduce(
            (n, s) => n + s.candidates.filter((c) => !s.judgements[c.key]).length,
            0,
          ),
        },
        numbers: {
          variables: Object.keys(w.numbers.variables).length,
          formulas: analysis.defs.length,
          curves: w.numbers.curves?.length ?? 0,
          errors: errors.length,
        },
        taste: {
          rules: w.taste.rules.length,
          enabledRules: w.taste.rules.filter((r) => r.enabled).length,
          patterns: w.taste.patterns.length,
        },
        ai: { mode: ctx.ai.status().mode, enabled: ctx.ai.status().enabled },
        images: ctx.images()?.status().mode ?? 'off',
      },
      summary: `${ents.length} entities`,
    };
  },
});

const findEntities = tool({
  name: 'find_entities',
  title: 'Find entities',
  description:
    'Lists entities matching a Codex filter, e.g. `kind:item state:decided band:"Low Sky"`, `menace:>3`, `-has:why`, `agent:yes`, or free words matched against name, identity, id and tags. Terms are ANDed; `a,b` ORs values; `-` negates. Empty matches everything. Returns brief rows; use get_entity for one in full.',
  kind: 'read',
  input: z.object({
    query: z.string().max(2000).default(''),
    limit: z.number().int().min(1).max(200).default(50),
    offset: z.number().int().min(0).default(0),
  }),
  run(ctx, p) {
    const w = ctx.world();
    const q = compileQuery(p.query, w);
    const rows = Object.values(w.entities)
      .filter((e) => q.match({ entity: e, placement: placementOf(w, e.id) }))
      .sort(
        (a, b) =>
          ENTITY_KINDS.indexOf(a.kind) - ENTITY_KINDS.indexOf(b.kind) ||
          a.name.localeCompare(b.name) ||
          a.id.localeCompare(b.id),
      );
    return {
      ok: true,
      data: {
        total: rows.length,
        entities: rows.slice(p.offset, p.offset + p.limit).map(brief),
        ...(q.errors.length > 0
          ? { queryErrors: q.errors.map((e) => ({ message: e.message, at: e.from })) }
          : {}),
      },
      summary: `find ${short(p.query || '(all)', 40)}: ${rows.length}`,
    };
  },
});

const getEntity_ = tool({
  name: 'get_entity',
  title: 'Get entity',
  description:
    'One entity in full: common fields, kind fields, attributes, relations (out and in), placement on Y, open notes, images (metadata only), and which states it can move to with what each still needs.',
  kind: 'read',
  input: z.object({ id: Id }),
  async run(ctx, p) {
    const w = ctx.world();
    const e = getEntity(w, p.id);
    if (!e) return notFound(p.id);
    const inbound = Object.values(w.entities).flatMap((o) =>
      o.relations
        .filter((r) => r.target === e.id)
        .map((r) => ({ from: o.id, type: r.type, ...(r.note ? { note: r.note } : {}) })),
    );
    const notes = (await ctx.notes()).filter((n) => n.entities.includes(e.id));
    return {
      ok: true,
      data: {
        entity: e,
        inbound,
        placement: placementSummary(w, e.id),
        notes: notes.map((n) => ({ kind: n.kind, severity: n.severity, text: n.text })),
        images: imageSummary(w, e.id),
        next: nextStates(w, e),
      },
      summary: e.name,
    };
  },
});

const getSchema = tool({
  name: 'get_schema',
  title: 'Get schema',
  description:
    "The world's schema: each kind's fields (type, options, required per state), attributes and lane; relation types (from, to, symmetric, acyclic); the lifecycle states and allowed transitions. Pass `kind` for one kind only.",
  kind: 'read',
  input: z.object({ kind: EntityKindSchema.optional() }),
  run(ctx, p) {
    const s = schemaOf(ctx.world());
    const kinds = p.kind ? { [p.kind]: s.kinds[p.kind] } : s.kinds;
    return {
      ok: true,
      data: {
        kinds,
        relations: s.relations,
        states: ENTITY_STATES,
        transitions: TRANSITIONS,
        notes: [
          'Kind fields go in `fields`; common fields are name, identity, description, why, tags.',
          'decided and exported need `why` (the Why gate); graveyard needs a kill reason.',
        ],
      },
      summary: p.kind ?? 'all kinds',
    };
  },
});

const getNumbers = tool({
  name: 'get_numbers',
  title: 'Get numbers',
  description:
    'Variables, every formula with its value or error, curves, and the formula errors with line numbers.',
  kind: 'read',
  input: z.object({}),
  run(ctx) {
    const w = ctx.world();
    const a = analyzeNumbers(w);
    return {
      ok: true,
      data: {
        variables: w.numbers.variables,
        formulas: a.defs.map((d) => summarize(a, w, d.name)),
        source: w.numbers.formulas,
        curves: (w.numbers.curves ?? []).map((c) => ({
          id: c.id,
          y: c.y,
          over: c.over,
          ...(c.intent ? { intent: c.intent } : {}),
        })),
        errors: formulaErrors(a),
      },
      summary: `${a.defs.length} formulas`,
    };
  },
});

const evaluate = tool({
  name: 'evaluate',
  title: 'Evaluate expression',
  description:
    "Evaluates an expression in carbon's numbers language against the world's variables and formulas, e.g. `damage(3)` or `count(items where tier >= 2)`. Returns the value and type, or the errors.",
  kind: 'read',
  input: z.object({ expression: z.string().min(1).max(2000) }),
  run(ctx, p) {
    const w = ctx.world();
    const c = compileExpression(analyzeNumbers(w), p.expression);
    const errors = c.diagnostics
      .filter((d) => d.severity === 'error')
      .map((d) => ({ code: d.code, message: d.message, ...(d.hint ? { hint: d.hint } : {}) }));
    if (!c.ok)
      return { ok: true, data: { ok: false, type: c.type, errors }, summary: p.expression };
    const r = c.run();
    if (!r.ok)
      return {
        ok: true,
        data: {
          ok: false,
          type: c.type,
          errors: [{ code: r.error.code, message: r.error.message }],
        },
        summary: p.expression,
      };
    return {
      ok: true,
      data: {
        ok: true,
        type: c.type,
        value: toPlain(r.value),
        text: formatValue(r.value, { name: (id) => w.entities[id]?.name }),
      },
      summary: short(p.expression, 40),
    };
  },
});

const checkNotes = tool({
  name: 'check_notes',
  title: 'Check notes',
  description:
    'The mechanical checks open now (the notes in the Column margin and on the status line): empty lanes, dangling relations, missing required fields, formula errors, attributes off their curves, near-duplicate names. Free and local. Pass `entityId` for one entity.',
  kind: 'read',
  input: z.object({
    entityId: Id.optional(),
    limit: z.number().int().min(1).max(500).default(100),
  }),
  async run(ctx, p) {
    const notes = (await ctx.notes()).filter((n) => !p.entityId || n.entities.includes(p.entityId));
    return {
      ok: true,
      data: {
        total: notes.length,
        notes: notes.slice(0, p.limit).map((n) => ({
          id: n.id,
          kind: n.kind,
          severity: n.severity,
          text: n.text,
          entities: n.entities,
          ...(n.y !== undefined ? { y: n.y } : {}),
        })),
      },
      summary: `${notes.length} notes`,
    };
  },
});

const getTaste = tool({
  name: 'get_taste',
  title: 'Get taste',
  description:
    'Your taste: the rules (with ids and whether each is on), the kill reasons and how often each was used, the learned patterns, and the art direction for images.',
  kind: 'read',
  input: z.object({}),
  run(ctx) {
    const w = ctx.world();
    return {
      ok: true,
      data: {
        rules: w.taste.rules,
        reasons: w.taste.reasons,
        patterns: w.taste.patterns,
        art: ArtDirectionSchema.parse(w.settings.art ?? EMPTY_ART),
      },
      summary: `${w.taste.rules.length} rules`,
    };
  },
});

const spreadView = (w: World, s: SpreadData): unknown => ({
  id: s.id,
  created: s.created,
  spot: s.spot,
  where: spotLabel(w, s.spot),
  move: s.move,
  ...(s.direction ? { direction: s.direction } : {}),
  axes: s.axes,
  status: s.status,
  candidates: s.candidates.map((c) => candidateView(w, s, c)),
});

function candidateView(w: World, s: SpreadData, c: Candidate): unknown {
  const j = s.judgements[c.key];
  const role = candidateRole(w, s, c);
  return {
    key: c.key,
    role,
    kind: c.kind,
    name: c.name,
    identity: c.identity,
    ...(c.description ? { description: c.description } : {}),
    ...(Object.keys(c.fields).length > 0 ? { fields: c.fields } : {}),
    ...(Object.keys(c.attributes).length > 0 ? { attributes: c.attributes } : {}),
    ...(c.relations.length > 0 ? { relations: c.relations } : {}),
    ...(role === 'about' ? { about: targetOf(w, s, c) } : {}),
    ...(c.wildcard ? { wildcard: true } : {}),
    ...(c.rationale ? { rationale: c.rationale } : {}),
    ...(j ? { judged: j } : {}),
  };
}

const listSpreads = tool({
  name: 'list_spreads',
  title: 'List spreads',
  description: 'Spreads, newest first: where, which move, how many candidates are still open.',
  kind: 'read',
  input: z.object({ limit: z.number().int().min(1).max(100).default(20) }),
  run(ctx, p) {
    const w = ctx.world();
    const all = allSpreads(w).reverse();
    return {
      ok: true,
      data: {
        total: all.length,
        spreads: all.slice(0, p.limit).map((s) => ({
          id: s.id,
          created: s.created,
          where: spotLabel(w, s.spot),
          move: s.move,
          candidates: s.candidates.length,
          open: s.candidates.filter((c) => !s.judgements[c.key]).length,
        })),
      },
      summary: `${all.length} spreads`,
    };
  },
});

const getSpread = tool({
  name: 'get_spread',
  title: 'Get spread',
  description:
    "One spread's candidates: each with its key, role (`new`: becomes an entity; `about`: changes an existing one; `finding`), fields, and its judgement if judged.",
  kind: 'read',
  input: z.object({ id: z.string().max(200) }),
  run(ctx, p) {
    const w = ctx.world();
    const s = readSpread(w.spreads[p.id]);
    if (!s) return fail('spread.not_found', `no spread "${p.id}"`);
    return { ok: true, data: spreadView(w, s), summary: s.id };
  },
});

const previewExport = tool({
  name: 'preview_export',
  title: 'Preview export',
  description:
    'The spec carbon would export for these entities (decided or exported ones only), as markdown. A preview: nothing is written. The user exports from the Export view.',
  kind: 'read',
  input: z.object({
    name: z.string().min(1).max(120),
    entityIds: z.array(Id).min(1).max(500).optional(),
    kinds: z.array(EntityKindSchema).max(8).optional(),
    bands: z.array(Id).max(100).optional(),
  }),
  run(ctx, p) {
    const w = ctx.world();
    const chosen = selectForExport(w, {
      ...(p.kinds ? { kinds: p.kinds } : {}),
      ...(p.bands ? { bands: p.bands } : {}),
      ...(p.entityIds ? { ids: p.entityIds } : {}),
    });
    const skipped = (p.entityIds ?? []).filter((id) => {
      const e = getEntity(w, id);
      return !e || !isExportable(e);
    });
    if (chosen.length === 0)
      return fail('export.empty', 'nothing to export: only decided or exported entities export');
    const markdown = buildSpec(
      w,
      chosen.map((e) => e.id),
      { name: p.name, numbers: createNumbersAdapter() },
    );
    return {
      ok: true,
      data: { entities: chosen.map((e) => e.id), skipped, markdown },
      summary: `${p.name}: ${chosen.length} entities`,
    };
  },
});

// ── Writes ──────────────────────────────────────────────────────────────────

const FieldSet = z
  .record(z.string().max(100), z.unknown())
  .refine((r) => Object.keys(r).length <= 100, 'at most 100 fields at once');

const createEntity = tool({
  name: 'create_entity',
  title: 'Create entity',
  description:
    'Creates an entity as an idea. `fields` holds kind fields (see get_schema); `relations` are `{ type, target, note? }`. Everything you write is marked as agent-written until the user edits it. One undo step.',
  kind: 'write',
  input: z.object({
    kind: EntityKindSchema,
    name: z.string().min(1).max(200),
    identity: Text.optional(),
    description: Text.optional(),
    why: Text.optional(),
    tags: z.array(z.string().max(100)).max(50).optional(),
    fields: FieldSet.optional(),
    attributes: z.record(z.string(), z.number()).optional(),
    relations: z.array(RelationSchema).max(100).optional(),
  }),
  run(ctx, p) {
    const keys = [
      'name',
      ...(['identity', 'description', 'why', 'tags'] as const).filter((k) => p[k] !== undefined),
      ...writtenKeys(p.fields ?? {}),
      ...Object.keys(p.attributes ?? {}).map((k) => `attributes.${k}`),
    ];
    const before = new Set(Object.keys(ctx.world().entities));
    const r = ctx.write(
      [
        cmd('entity.create', {
          ...p,
          origin: { by: 'agent' },
          agent_fields: keys,
        }),
      ],
      `Create ${p.name}`,
    );
    const id = r.ok ? Object.keys(ctx.world().entities).find((k) => !before.has(k)) : undefined;
    return written(r, { id }, `Create ${p.name}`);
  },
});

const updateEntity = tool({
  name: 'update_entity',
  title: 'Update entity',
  description:
    'Sets fields of an entity: common text fields (name, identity, description, why, tags) and kind fields by key. `null` clears one. Editing an exported entity moves it back to decided. One undo step.',
  kind: 'write',
  input: z.object({ id: Id, set: FieldSet }),
  run(ctx, p) {
    const e = getEntity(ctx.world(), p.id);
    if (!e) return notFound(p.id);
    const label = `Edit ${e.name}`;
    return written(
      ctx.write([cmd('entity.update', { id: p.id, set: p.set, source: 'agent' })], label),
      { id: p.id, set: Object.keys(p.set) },
      `${label}: ${Object.keys(p.set).join(', ')}`,
    );
  },
});

const setAttribute = tool({
  name: 'set_attribute',
  title: 'Set attribute',
  description: 'Sets a numeric attribute of an entity (`null` removes it). One undo step.',
  kind: 'write',
  input: z.object({
    id: Id,
    key: z.string().regex(/^[a-z][a-z0-9_]*$/),
    value: z.number().nullable(),
  }),
  run(ctx, p) {
    const e = getEntity(ctx.world(), p.id);
    if (!e) return notFound(p.id);
    const label = `Set ${p.key} of ${e.name}`;
    return written(
      ctx.write(
        [cmd('entity.setAttribute', { id: p.id, key: p.key, value: p.value, source: 'agent' })],
        label,
      ),
      { id: p.id, key: p.key, value: p.value },
      label,
    );
  },
});

const deleteEntity = tool({
  name: 'delete_entity',
  title: 'Delete entity',
  description:
    'Deletes an entity, removing relations that point at it. The user can undo it. Prefer set_state to graveyard (with a reason) for ideas that were judged and rejected.',
  kind: 'write',
  destructive: true,
  input: z.object({ id: Id }),
  run(ctx, p) {
    const e = getEntity(ctx.world(), p.id);
    if (!e) return notFound(p.id);
    const label = `Delete ${e.name}`;
    return written(ctx.write([cmd('entity.delete', { id: p.id })], label), { id: p.id }, label);
  },
});

const addRelation = tool({
  name: 'add_relation',
  title: 'Add relation',
  description:
    'Adds a typed relation `from → to` (see get_schema for the types and which kinds they join). Symmetric ones are mirrored; acyclic ones refuse cycles.',
  kind: 'write',
  input: z.object({
    from: Id,
    type: z.string().max(64),
    to: Id,
    note: z.string().max(2000).optional(),
  }),
  run(ctx, p) {
    const w = ctx.world();
    const label = `Relate ${getEntity(w, p.from)?.name ?? p.from} ${p.type} ${getEntity(w, p.to)?.name ?? p.to}`;
    return written(ctx.write([cmd('relation.add', p)], label), p, label);
  },
});

const removeRelation = tool({
  name: 'remove_relation',
  title: 'Remove relation',
  description: 'Removes a relation `from → to` of a type.',
  kind: 'write',
  destructive: true,
  input: z.object({ from: Id, type: z.string().max(64), to: Id }),
  run(ctx, p) {
    const w = ctx.world();
    const label = `Unrelate ${getEntity(w, p.from)?.name ?? p.from} ${p.type} ${getEntity(w, p.to)?.name ?? p.to}`;
    return written(ctx.write([cmd('relation.remove', p)], label), p, label);
  },
});

const setState = tool({
  name: 'set_state',
  title: 'Set state',
  description:
    "Moves an entity through its lifecycle: idea → shaped → decided → exported, or to graveyard. The Why gate applies: decided needs `why` (pass it here or set it first), and each state's required fields must be filled (get_entity's `next` lists what's missing). Graveyard needs `killed: { reason, note? }`. One undo step; refused with the reason otherwise.",
  kind: 'write',
  input: z.object({
    id: Id,
    state: EntityStateSchema,
    why: Text.optional(),
    killed: KilledSchema.optional(),
  }),
  run(ctx, p) {
    const e = getEntity(ctx.world(), p.id);
    if (!e) return notFound(p.id);
    const commands: Command[] = [];
    if (p.why !== undefined && p.why !== e.why)
      commands.push(cmd('entity.update', { id: p.id, set: { why: p.why }, source: 'agent' }));
    commands.push(
      cmd('entity.setState', {
        id: p.id,
        state: p.state,
        ...(p.killed ? { killed: p.killed } : {}),
      }),
    );
    const label = `Mark ${e.name} ${p.state}`;
    return written(ctx.write(commands, label), { id: p.id, state: p.state }, label);
  },
});

const addTasteRule = tool({
  name: 'add_taste_rule',
  title: 'Add taste rule',
  description:
    'Adds a taste rule (one line, e.g. "No pure stat-stick items"). Rules shape every AI request in carbon. One undo step.',
  kind: 'write',
  input: z.object({ text: z.string().min(1).max(300) }),
  run(ctx, p) {
    const before = new Set(ctx.world().taste.rules.map((r) => r.id));
    const r = ctx.write([cmd('taste.addRule', { text: p.text })], `Add rule "${short(p.text)}"`);
    const id = r.ok ? ctx.world().taste.rules.find((x) => !before.has(x.id))?.id : undefined;
    return written(r, { id }, `Add rule "${short(p.text)}"`);
  },
});

const updateTasteRule = tool({
  name: 'update_taste_rule',
  title: 'Update taste rule',
  description: "Changes a taste rule's text, or turns it on or off.",
  kind: 'write',
  input: z.object({
    id: z.string().max(100),
    text: z.string().min(1).max(300).optional(),
    enabled: z.boolean().optional(),
  }),
  run(ctx, p) {
    const label = `Edit rule ${p.id}`;
    return written(ctx.write([cmd('taste.updateRule', p)], label), p, label);
  },
});

const removeTasteRule = tool({
  name: 'remove_taste_rule',
  title: 'Remove taste rule',
  description: 'Removes a taste rule.',
  kind: 'write',
  destructive: true,
  input: z.object({ id: z.string().max(100) }),
  run(ctx, p) {
    const label = `Remove rule ${p.id}`;
    return written(ctx.write([cmd('taste.removeRule', p)], label), p, label);
  },
});

const setArtDirection = tool({
  name: 'set_art_direction',
  title: 'Set art direction',
  description:
    'Sets the art direction every image prompt uses: `direction` (a paragraph) and per-kind notes (`kinds: { biome: "…" }`; `null` or "" clears one).',
  kind: 'write',
  input: z.object({
    direction: z.string().max(4000).optional(),
    kinds: z.partialRecord(EntityKindSchema, z.string().max(2000).nullable()).optional(),
  }),
  run(ctx, p) {
    return written(
      ctx.write([cmd('art.set', p)], 'Change art direction'),
      ArtDirectionSchema.parse(p),
      'Change art direction',
    );
  },
});

const setVariable = tool({
  name: 'set_variable',
  title: 'Set variable',
  description: 'Sets a numbers variable (a number, text or true/false); `null` removes it.',
  kind: 'write',
  input: z.object({
    name: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .max(64),
    value: z.union([z.number(), z.string().max(2000), z.boolean()]).nullable(),
  }),
  run(ctx, p) {
    const label = `Set ${p.name}`;
    return written(ctx.write([cmd('numbers.setVariable', p)], label), p, label);
  },
});

const setFormulas = tool({
  name: 'set_formulas',
  title: 'Set formulas',
  description:
    'Replaces the formulas source (the whole program, as in the Numbers view). Read it with get_numbers first and send it back edited. Returns the errors it now has; the user sees them in Numbers.',
  kind: 'write',
  input: z.object({ source: z.string().max(200_000) }),
  run(ctx, p) {
    const r = ctx.write([cmd('numbers.setFormulas', p)], 'Edit formulas');
    if (!r.ok) return written(r, null, 'Edit formulas');
    const errors = formulaErrors(analyzeNumbers(ctx.world())).filter((e) => e.severity === 'error');
    return written(r, { errors }, `Edit formulas (${errors.length} errors)`);
  },
});

const selectImage = tool({
  name: 'select_image',
  title: 'Select image',
  description:
    "Chooses one of an entity's images as its concept or icon (by the image's id; see get_entity).",
  kind: 'write',
  input: z.object({ entityId: Id, imageId: ImageIdSchema }),
  run(ctx, p) {
    const label = `Choose image ${p.imageId}`;
    return written(
      ctx.write([cmd('image.select', { entity: p.entityId, image: p.imageId })], label),
      p,
      label,
    );
  },
});

const unselectImage = tool({
  name: 'unselect_image',
  title: 'Unselect image',
  description: "Clears an entity's chosen concept or icon (the image stays in its versions).",
  kind: 'write',
  input: z.object({ entityId: Id, kind: ImageKindSchema }),
  run(ctx, p) {
    const label = `Clear ${p.kind}`;
    return written(
      ctx.write([cmd('image.unselect', { entity: p.entityId, kind: p.kind })], label),
      p,
      label,
    );
  },
});

const removeImage = tool({
  name: 'remove_image',
  title: 'Remove image',
  description:
    "Removes an image from an entity's versions. Its files stay until the user purges them.",
  kind: 'write',
  destructive: true,
  input: z.object({ entityId: Id, imageId: ImageIdSchema }),
  run(ctx, p) {
    const label = `Remove image ${p.imageId}`;
    return written(
      ctx.write([cmd('image.remove', { entity: p.entityId, image: p.imageId })], label),
      p,
      label,
    );
  },
});

const judgeCandidate = tool({
  name: 'judge_candidate',
  title: 'Keep or kill a candidate',
  description:
    "Judges a spread candidate, as `k` and `x` do in the Spread view. Keep: a `new` candidate becomes an idea at the spread's spot; an `about` one applies its change to its entity. Kill: needs `reason`, a kill-reason key (`1`–`9`, or `0` for other with a `note`; see get_taste). A short `note` says why either way; Taste learns from both. One undo step.",
  kind: 'write',
  input: z.object({
    spread: z.string().max(200),
    key: z.string().max(100),
    verdict: z.enum(['keep', 'kill']),
    reason: z
      .string()
      .regex(/^[0-9]$/)
      .optional(),
    note: z.string().max(200).optional(),
  }),
  run(ctx, p) {
    const w = ctx.world();
    const s = readSpread(w.spreads[p.spread]);
    if (!s) return fail('spread.not_found', `no spread "${p.spread}"`);
    if (p.verdict === 'kill' && p.reason === undefined)
      return fail('spread.kill_reason', 'a kill needs a reason key (see get_taste → reasons)');
    const t =
      p.verdict === 'keep'
        ? keepCommands(w, s, p.key)
        : killCommands(w, s, p.key, p.reason as string, p.note);
    if (!t.ok) return { ok: false, error: { code: t.error.code, message: t.error.message } };
    const note = p.note?.trim();
    // The keep's note rides on its judgement (a kill's is already there).
    const commands =
      p.verdict === 'keep' && note
        ? t.value.commands.map((c) =>
            c.type === 'spread.judge' ? { ...c, payload: { ...c.payload, note } } : c,
          )
        : t.value.commands;
    return written(
      ctx.write(commands, t.value.label),
      {
        spread: p.spread,
        key: p.key,
        verdict: p.verdict,
        ...(t.value.entity ? { entity: t.value.entity } : {}),
      },
      t.value.label,
    );
  },
});

// ── Showing the user ────────────────────────────────────────────────────────

const VIEWS = ['column', 'climate', 'codex', 'numbers', 'spread', 'taste', 'export'] as const;

const focus = tool({
  name: 'focus',
  title: 'Focus entity',
  description:
    "Opens an entity on the Bench, so the user sees what you're talking about. Changes nothing in the world.",
  kind: 'ui',
  input: z.object({ id: Id }),
  run(ctx, p) {
    const e = getEntity(ctx.world(), p.id);
    if (!e) return notFound(p.id);
    ctx.reveal({ entity: p.id });
    return { ok: true, data: { focused: p.id }, summary: `Focus ${e.name}` };
  },
});

const view = tool({
  name: 'view',
  title: 'Switch view',
  description:
    'Switches the view the user sees: column (everything along Y), climate (biomes per band), codex (the table), numbers, spread, taste or export. Changes nothing in the world.',
  kind: 'ui',
  input: z.object({ view: z.enum(VIEWS) }),
  run(ctx, p) {
    ctx.reveal({ view: p.view });
    return { ok: true, data: { view: p.view }, summary: `View ${p.view}` };
  },
});

// ── Carbon's own generation ─────────────────────────────────────────────────

const aiFailed = (e: { code: string; message: string }): ToolOutcome =>
  fail(`ai.${e.code}`, e.message);

const suggest = tool({
  name: 'suggest',
  title: 'Suggest a value',
  description:
    "Carbon's inline suggestion for one field (as `tab` / `shift+tab` on the Bench): `count` 1 or 3 values, grounded in the world and taste. Nothing is applied: use update_entity to take one. Paid (Claude).",
  kind: 'paid',
  input: z.object({
    entityId: Id,
    field: z.string().max(100),
    count: z.union([z.literal(1), z.literal(3)]).default(1),
    avoid: z.array(z.unknown()).max(20).default([]),
    guidance: z.string().max(500).optional(),
  }),
  async run(ctx, p) {
    const req = {
      entityId: p.entityId,
      field: p.field,
      avoid: p.avoid,
      ...(p.guidance ? { guidance: p.guidance } : {}),
    };
    const opts = { via: 'agent' as const, ...(ctx.signal ? { signal: ctx.signal } : {}) };
    if (p.count === 3) {
      const out = await ctx.ai.run('suggest_three', req, opts);
      if (!out.ok) return aiFailed(out.error);
      return {
        ok: true,
        data: out.result,
        costUsd: out.meta.costUsd,
        summary: `${p.entityId}.${p.field} ×3`,
      };
    }
    const out = await ctx.ai.run('suggest_one', req, opts);
    if (!out.ok) return aiFailed(out.error);
    return {
      ok: true,
      data: out.result,
      costUsd: out.meta.costUsd,
      summary: `${p.entityId}.${p.field}`,
    };
  },
});

const fill = tool({
  name: 'fill',
  title: 'Fill entity',
  description:
    "Carbon's proposals for an entity's empty fields (as `ctrl+enter` on the Bench). Nothing is applied: take the ones you want with update_entity. Paid (Claude).",
  kind: 'paid',
  input: z.object({ entityId: Id }),
  async run(ctx, p) {
    const out = await ctx.ai.run('fill_entity', p, {
      via: 'agent',
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    if (!out.ok) return aiFailed(out.error);
    return { ok: true, data: out.result, costUsd: out.meta.costUsd, summary: `Fill ${p.entityId}` };
  },
});

const critique = tool({
  name: 'critique',
  title: 'Critique entity',
  description:
    "Carbon's critique of an entity (as `?` on the Bench): notes on weak identity, rule clashes, duplicates, contradicted relations, bare numbers. Paid (Claude).",
  kind: 'paid',
  input: z.object({ entityId: Id }),
  async run(ctx, p) {
    const out = await ctx.ai.run(
      'critique',
      { entityId: p.entityId, trigger: 'on_demand' },
      { via: 'agent', ...(ctx.signal ? { signal: ctx.signal } : {}) },
    );
    if (!out.ok) return aiFailed(out.error);
    return {
      ok: true,
      data: out.result,
      costUsd: out.meta.costUsd,
      summary: `Critique ${p.entityId}`,
    };
  },
});

const spread = tool({
  name: 'spread',
  title: 'Run a spread',
  description:
    "Runs a spread (as `enter` in the Spread view): candidates for a spot, by a move. Spot: `{ type: 'cell', band, lane }`, `{ type: 'region', band, climate }`, `{ type: 'entity', entity }`, `{ type: 'selection', entities }` or `{ type: 'note', note, entities }`. Moves: fill, vary, oppose, alloy, push, ground, cost, break, name. The spread is saved (it's in the Spread view's history) and its candidates come back; keep or kill each with judge_candidate. Paid (Claude).",
  kind: 'paid',
  input: z.object({
    spot: SpotSchema,
    move: MoveSchema,
    direction: z.string().max(300).optional(),
    count: z.number().int().min(1).max(16).default(8),
    axes: z.object({ x: AxisSchema, y: AxisSchema }).optional(),
    ruleIds: z.array(z.string()).max(100).optional(),
  }),
  async run(ctx, p) {
    const w = ctx.world();
    const check = checkSpot(w, p.spot, p.move);
    if (!check.ok) return fail(check.error.code, check.error.message);
    const axes = p.axes ?? MOVE_DEFS[p.move].axes;
    const ruleIds = p.ruleIds ?? activeRules(w.taste).map((r) => r.id);
    const direction = p.direction?.trim();
    const out = await ctx.ai.run(
      'spread',
      {
        spot: p.spot,
        move: p.move,
        count: p.count,
        axes,
        ruleIds,
        ...(direction ? { direction } : {}),
      },
      { via: 'agent', ...(ctx.signal ? { signal: ctx.signal } : {}) },
    );
    if (!out.ok) return aiFailed(out.error);
    const now = ctx.now();
    const latest = ctx.world();
    const record = makeSpread({
      id: newSpreadId(latest, p.spot, now),
      now,
      request: {
        spot: p.spot,
        move: p.move,
        count: p.count,
        axes: out.result.axes,
        ruleIds,
        direction,
      },
      candidates: out.result.candidates.map((c) => CandidateSchema.parse(c)),
      status: 'done',
      dropped: out.meta.dropped,
      costUsd: out.meta.costUsd,
    });
    const label = `Spread: ${MOVE_DEFS[p.move].label} ${spotLabel(latest, p.spot)}`;
    const r = ctx.write([cmd('spread.save', { record })], label);
    if (!r.ok) return { ok: false, error: { code: r.error.code, message: r.error.message } };
    return {
      ok: true,
      data: spreadView(ctx.world(), record),
      summary: `${label}: ${record.candidates.length}`,
      rev: r.rev,
      costUsd: out.meta.costUsd,
    };
  },
});

// ── Images ──────────────────────────────────────────────────────────────────

const noImages = (): ToolOutcome => fail('images.disabled', 'images are off in carbon');

const imageFailed = (e: { code: string; message: string }): ToolOutcome =>
  fail(`images.${e.code}`, e.message);

const ImageCall = {
  model: ImageModelSchema.optional(),
  quality: ImageQualitySchema.optional(),
  size: ImageSizeSchema.optional(),
};

const imagePrompt = tool({
  name: 'image_prompt',
  title: 'Write an image prompt',
  description:
    "Carbon writes the prompt for an entity's concept image or icon, from the entity, its place and the art direction. Returns the text; pass it (edited or not) to generate_image. Paid (Claude).",
  kind: 'paid',
  input: z.object({ entityId: Id, kind: ImageKindSchema }),
  async run(ctx, p) {
    const g = ctx.images();
    if (!g) return noImages();
    if (!getEntity(ctx.world(), p.entityId)) return notFound(p.entityId);
    const r = await g.prompt(p, ctx.signal);
    if (!r.ok) return imageFailed(r.error);
    return {
      ok: true,
      data: { prompt: r.prompt },
      costUsd: r.claudeCostUsd,
      summary: `Prompt ${p.kind} ${p.entityId}`,
    };
  },
});

const generateImage = tool({
  name: 'generate_image',
  title: 'Generate an image',
  description:
    "Generates a concept image or a 16×16 icon for an entity (OpenAI), and adds it to the entity's images (chosen unless `select: false`). Without `prompt`, carbon writes one first. The cost is estimated first and must fit the agent budget. Paid (OpenAI, and Claude for the prompt).",
  kind: 'paid',
  input: z.object({
    entityId: Id,
    kind: ImageKindSchema,
    prompt: z.string().min(1).max(32_000).optional(),
    reference: ImageIdSchema.optional(),
    select: z.boolean().default(true),
    ...ImageCall,
  }),
  estimate(ctx, p) {
    const g = ctx.images();
    if (!g) return { code: 'images.disabled', message: 'images are off in carbon' };
    return g.estimate({
      kind: p.kind,
      calls: 1,
      ...(p.prompt ? { promptChars: p.prompt.length } : {}),
      ...(p.model ? { model: p.model } : {}),
      ...(p.quality ? { quality: p.quality } : {}),
      ...(p.size ? { size: p.size } : {}),
    }).totalUsd;
  },
  async run(ctx, p) {
    const g = ctx.images();
    if (!g) return noImages();
    if (!getEntity(ctx.world(), p.entityId)) return notFound(p.entityId);
    let prompt = p.prompt;
    let cost = 0;
    if (!prompt) {
      const r = await g.prompt({ entityId: p.entityId, kind: p.kind }, ctx.signal);
      if (!r.ok) return imageFailed(r.error);
      prompt = r.prompt;
      cost += r.claudeCostUsd;
    }
    const r = await g.generate({
      requestId: ctx.newId('agent-image'),
      entityId: p.entityId,
      kind: p.kind,
      prompt,
      select: p.select,
      ...(p.reference ? { reference: p.reference } : {}),
      ...(p.model ? { model: p.model } : {}),
      ...(p.quality ? { quality: p.quality } : {}),
      ...(p.size ? { size: p.size } : {}),
    });
    cost += r.receipt?.costUsd ?? 0;
    if (!r.ok)
      return {
        ...imageFailed(r.error),
        ...(r.error.unknownOutcome ? { summary: 'outcome unknown: it may have been charged' } : {}),
      };
    return {
      ok: true,
      data: { image: r.image.id, kind: r.image.kind, prompt, costUsd: cost },
      costUsd: cost,
      summary: `${p.kind} for ${p.entityId}`,
    };
  },
});

const iconFromConcept = tool({
  name: 'icon_from_concept',
  title: 'Icon from concept',
  description:
    "Filters an entity's concept image (its chosen one, or `from`) into a 16×16 icon with Genforge's item filter. Free: no API call.",
  kind: 'free',
  input: z.object({
    entityId: Id,
    from: ImageIdSchema.optional(),
    select: z.boolean().default(true),
  }),
  async run(ctx, p) {
    const g = ctx.images();
    if (!g) return noImages();
    const r = await g.iconFromConcept(p);
    if (!r.ok) return imageFailed(r.error);
    return { ok: true, data: { image: r.image.id }, summary: `Icon from concept: ${p.entityId}` };
  },
});

const planImageBatch = tool({
  name: 'plan_image_batch',
  title: 'Plan an image batch',
  description:
    'Plans concepts or icons for many entities (skipping ones that already have one unless `replace`): the prompt per entity, the calls and the estimated cost. Concept plans have Claude write each prompt (paid); icon plans go out as sheets of up to 100 icons per call, with a line per entity (free to plan). Nothing is generated: run it with run_image_batch.',
  kind: 'paid',
  input: z.object({
    kind: ImageKindSchema,
    entityIds: z.array(Id).min(1).max(500),
    replace: z.boolean().default(false),
    ...ImageCall,
  }),
  free: (p) => p.kind === 'icon',
  async run(ctx, p) {
    const g = ctx.images();
    if (!g) return noImages();
    const plan = await g.batchPlan({
      kind: p.kind,
      entityIds: p.entityIds,
      replace: p.replace,
      ...(p.model ? { model: p.model } : {}),
      ...(p.quality ? { quality: p.quality } : {}),
      ...(p.size ? { size: p.size } : {}),
    });
    return {
      ok: true,
      data: {
        kind: plan.kind,
        model: plan.model,
        quality: plan.quality,
        size: plan.size,
        calls: plan.calls,
        estimateUsd: plan.estimate.totalUsd,
        items: plan.items.map((i) => ({
          entityId: i.entityId,
          name: i.name,
          ...(i.prompt ? { prompt: i.prompt } : {}),
          ...(i.line ? { line: i.line } : {}),
          ...(i.skip ? { skip: i.skip } : {}),
        })),
        ...(plan.sheets
          ? {
              sheets: plan.sheets.map((s) => ({
                index: s.index,
                cols: s.cols,
                rows: s.rows,
                items: s.items.length,
                estimateUsd: s.estimateUsd,
              })),
            }
          : {}),
      },
      costUsd: plan.claudeCostUsd,
      summary: `Plan ${p.kind}s: ${plan.calls} calls`,
    };
  },
});

const runImageBatch = tool({
  name: 'run_image_batch',
  title: 'Run an image batch',
  description:
    'Runs a planned batch. Concepts: `items: [{ entityId, prompt }]`, each a paid call, added and chosen as they arrive. Icons: `items: [{ entityId, line }]`, sent as sheets of up to 100 per call; each sheet comes back for review (its cells and flags): accept cells with accept_sheet_cells. The whole estimate must fit the agent budget. Paid (OpenAI).',
  kind: 'paid',
  input: z.object({
    kind: ImageKindSchema,
    items: z
      .array(
        z.object({
          entityId: Id,
          prompt: z.string().min(1).max(32_000).optional(),
          line: z.string().min(1).max(600).optional(),
        }),
      )
      .min(1)
      .max(500),
    ...ImageCall,
  }),
  estimate(ctx, p) {
    const g = ctx.images();
    if (!g) return { code: 'images.disabled', message: 'images are off in carbon' };
    const calls = p.kind === 'icon' ? Math.ceil(p.items.length / 100) : p.items.length;
    const chars = p.items.reduce((n, i) => n + (i.prompt ?? i.line ?? '').length, 0);
    return g.estimate({
      kind: p.kind,
      calls,
      promptChars: Math.ceil(chars / Math.max(1, calls)),
      ...(p.model ? { model: p.model } : {}),
      ...(p.quality ? { quality: p.quality } : {}),
    }).totalUsd;
  },
  async run(ctx, p) {
    const g = ctx.images();
    if (!g) return noImages();
    if (p.kind === 'concept') {
      const missing = p.items.find((i) => !i.prompt);
      if (missing)
        return fail(
          'agent.invalid_input',
          `items: ${missing.entityId} needs a prompt (plan_image_batch writes them)`,
        );
      const r = await g.batchRun({
        batchId: ctx.newId('agent-batch'),
        kind: 'concept',
        items: p.items.map((i) => ({ entityId: i.entityId, prompt: i.prompt as string })),
      });
      return {
        ok: true,
        data: {
          costUsd: r.costUsd,
          cancelled: r.cancelled,
          items: r.items.map((i) =>
            i.result.ok
              ? { entityId: i.entityId, ok: true, image: i.result.image.id }
              : { entityId: i.entityId, ok: false, error: i.result.error },
          ),
        },
        costUsd: r.costUsd,
        summary: `${r.items.filter((i) => i.result.ok).length} of ${r.items.length} concepts`,
      };
    }
    const missing = p.items.find((i) => !i.line);
    if (missing)
      return fail(
        'agent.invalid_input',
        `items: ${missing.entityId} needs a line (plan_image_batch writes them)`,
      );
    const r = await g.sheetRun({
      batchId: ctx.newId('agent-sheet'),
      items: p.items.map((i) => ({ entityId: i.entityId, line: i.line as string })),
    });
    return {
      ok: true,
      data: {
        costUsd: r.costUsd,
        cancelled: r.cancelled,
        sheets: r.sheets.map((s) =>
          s.ok
            ? { ok: true, ...sheetView(s.review) }
            : { ok: false, error: s.error, entityIds: s.entityIds },
        ),
      },
      costUsd: r.costUsd,
      summary: `${r.sheets.filter((s) => s.ok).length} sheets`,
    };
  },
});

function sheetView(r: SheetReviewLike): Record<string, unknown> {
  return {
    entityId: r.sheet.entity,
    imageId: r.sheet.id,
    cells: r.cells.map((c) => ({
      index: c.index,
      entityId: c.entityId,
      row: c.row,
      col: c.col,
      flags: c.flags,
    })),
  };
}

const reviewSheet = tool({
  name: 'review_sheet',
  title: 'Review an icon sheet',
  description:
    'Re-crops a kept icon sheet for review: its cells, which entity each is for, and flags (empty, background_only, touches_edge, fragmented). Free.',
  kind: 'free',
  input: z.object({ entityId: Id, imageId: ImageIdSchema }),
  async run(ctx, p) {
    const g = ctx.images();
    if (!g) return noImages();
    const r = await g.sheetCrop(p);
    if (!r) return fail('images.not_found', `no sheet "${p.imageId}" for "${p.entityId}"`);
    return { ok: true, data: sheetView(r), summary: `Review sheet ${p.imageId}` };
  },
});

const acceptSheetCells = tool({
  name: 'accept_sheet_cells',
  title: 'Accept sheet cells',
  description:
    "Turns a sheet's cells (by index) into their entities' icons, chosen unless `select: false`. One undo step. Free.",
  kind: 'free',
  input: z.object({
    entityId: Id,
    imageId: ImageIdSchema,
    cells: z.array(z.number().int().min(0)).min(1).max(100),
    select: z.boolean().default(true),
  }),
  async run(ctx, p) {
    const g = ctx.images();
    if (!g) return noImages();
    const r = await g.sheetAccept(p);
    if (!r.ok) return imageFailed(r.error);
    return {
      ok: true,
      data: { images: r.images.map((m) => ({ id: m.id, entity: m.entity })) },
      summary: `Accept ${r.images.length} icons`,
    };
  },
});

/** Every tool, in the order `tools/list` gives them. */
export const TOOLS: readonly ToolDef[] = [
  worldSummary,
  findEntities,
  getEntity_,
  getSchema,
  getNumbers,
  evaluate,
  checkNotes,
  getTaste,
  listSpreads,
  getSpread,
  previewExport,
  createEntity,
  updateEntity,
  setAttribute,
  deleteEntity,
  addRelation,
  removeRelation,
  setState,
  addTasteRule,
  updateTasteRule,
  removeTasteRule,
  setArtDirection,
  setVariable,
  setFormulas,
  selectImage,
  unselectImage,
  removeImage,
  judgeCandidate,
  focus,
  view,
  suggest,
  fill,
  critique,
  spread,
  imagePrompt,
  generateImage,
  iconFromConcept,
  planImageBatch,
  runImageBatch,
  reviewSheet,
  acceptSheetCells,
];

export const toolByName = (name: string): ToolDef | undefined => TOOLS.find((t) => t.name === name);

/** Runs the mechanical checks the way the renderer's worker does (one runner, reused). */
export function createNotesSource(): (world: World) => Note[] {
  const runner = createCheckRunner({ placement: resolvedPlaces, numbers: createNumbersAdapter() });
  return (world) => runner.run(world);
}

export { candidateOf };
