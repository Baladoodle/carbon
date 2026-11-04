import { z } from 'zod';
import {
  AiErrorSchema,
  AiCallMetaSchema,
  AiLogEntrySchema,
  AiStatusSchema,
} from '@core/ai/gateway';
import { MomentSchema } from '@core/ai/moments';
import { PatchSchema } from '@core/commands/patch';
import { CommandSchema } from '@core/commands/apply';
import { WorldSchemaZ } from '@core/model/world';

/**
 * The typed contract between the main process and the renderer.
 *
 * - `INVOKE`: request → response channels (`window.carbon.invoke`).
 * - `EVENTS`: main → renderer pushes (`window.carbon.on`).
 *
 * State flows one way: the renderer asks for a `world:snapshot` once, then
 * applies every `world:patch` event in `rev` order (a gap means: fetch a new
 * snapshot). Changes go back only as commands (`world:dispatch`).
 *
 * Packages may ADD channels here (both tables are data); never rename or remove.
 */

export const LoadIssueSchema = z.object({
  path: z.string(),
  code: z.string(),
  message: z.string(),
});

export const HistoryInfoSchema = z.object({
  canUndo: z.boolean(),
  canRedo: z.boolean(),
  undoLabel: z.string().optional(),
  redoLabel: z.string().optional(),
});
export type HistoryInfo = z.infer<typeof HistoryInfoSchema>;

export const WorldSnapshotSchema = z.object({
  /** Revision: increments with every patch. */
  rev: z.number().int().min(0),
  dir: z.string(),
  world: WorldSchemaZ,
  /** Files that failed to load (reported, never silently dropped). */
  issues: z.array(LoadIssueSchema),
  history: HistoryInfoSchema,
});
export type WorldSnapshot = z.infer<typeof WorldSnapshotSchema>;

export const PatchEventSchema = z.object({
  /** The revision after this patch; the previous one is `rev - 1`. */
  rev: z.number().int().min(1),
  patch: PatchSchema,
  cause: z.enum(['command', 'undo', 'redo', 'external']),
  label: z.string().optional(),
  history: HistoryInfoSchema,
});
export type PatchEvent = z.infer<typeof PatchEventSchema>;

export const CoreErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  detail: z.unknown().optional(),
});

export const DispatchRequestSchema = z.object({
  /** One or more commands; several form one transaction (one undo step). */
  commands: z.array(CommandSchema).min(1),
  /** Undo label; defaults to the first command's label. */
  label: z.string().optional(),
});
export const DispatchResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), rev: z.number().int() }),
  z.object({ ok: z.literal(false), error: CoreErrorSchema }),
]);
export type DispatchResult = z.infer<typeof DispatchResultSchema>;

export const HistoryResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), rev: z.number().int(), label: z.string().optional() }),
  z.object({ ok: z.literal(false), error: CoreErrorSchema }),
]);

export const SaveStatusSchema = z.object({
  state: z.enum(['saved', 'saving', 'error']),
  message: z.string().optional(),
  /** Time of the last successful save. */
  at: z.string().optional(),
});
export type SaveStatus = z.infer<typeof SaveStatusSchema>;

export const AppInfoSchema = z.object({
  version: z.string(),
  worldDir: z.string(),
  platform: z.string(),
  /** True when launched by the end-to-end harness. */
  e2e: z.boolean(),
});
export type AppInfo = z.infer<typeof AppInfoSchema>;

export const AiRunRequestSchema = z.object({
  /** Chosen by the renderer; used for partials and cancellation. */
  requestId: z.string().min(1),
  moment: MomentSchema,
  /** The moment's request; validated by the gateway against MOMENT_SCHEMAS. */
  request: z.unknown(),
});
export const AiRunResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), result: z.unknown(), meta: AiCallMetaSchema }),
  z.object({ ok: z.literal(false), error: AiErrorSchema, meta: AiCallMetaSchema.optional() }),
]);
export const AiPartialEventSchema = z.object({ requestId: z.string(), partial: z.unknown() });

const none = z.null();
const done = z.object({ ok: z.literal(true) });

export const INVOKE = {
  'app:info': { request: none, response: AppInfoSchema },
  'world:snapshot': { request: none, response: WorldSnapshotSchema },
  'world:dispatch': { request: DispatchRequestSchema, response: DispatchResultSchema },
  'world:undo': { request: none, response: HistoryResultSchema },
  'world:redo': { request: none, response: HistoryResultSchema },
  'store:status': { request: none, response: SaveStatusSchema },
  'ai:run': { request: AiRunRequestSchema, response: AiRunResponseSchema },
  'ai:cancel': { request: z.object({ requestId: z.string() }), response: done },
  'ai:status': { request: none, response: AiStatusSchema },
  'ai:setEnabled': { request: z.object({ enabled: z.boolean() }), response: AiStatusSchema },
  'ai:log': {
    request: z.object({ limit: z.number().int().min(1).max(5000).optional() }),
    response: z.array(AiLogEntrySchema),
  },
  'window:control': {
    request: z.enum(['minimize', 'maximize', 'close', 'devtools']),
    response: done,
  },
} as const satisfies Record<string, { request: z.ZodType; response: z.ZodType }>;

export const EVENTS = {
  'world:patch': PatchEventSchema,
  /** A whole new snapshot: after a reload, an external change the store couldn't express as a patch, or a gap. */
  'world:reset': WorldSnapshotSchema,
  'store:status': SaveStatusSchema,
  'ai:partial': AiPartialEventSchema,
  'ai:status': AiStatusSchema,
} as const satisfies Record<string, z.ZodType>;

export type InvokeChannel = keyof typeof INVOKE;
export type EventChannel = keyof typeof EVENTS;
export type InvokeRequest<C extends InvokeChannel> = z.input<(typeof INVOKE)[C]['request']>;
export type InvokeResponse<C extends InvokeChannel> = z.output<(typeof INVOKE)[C]['response']>;
export type EventPayload<C extends EventChannel> = z.output<(typeof EVENTS)[C]>;

export const INVOKE_CHANNELS = Object.keys(INVOKE) as InvokeChannel[];
export const EVENT_CHANNELS = Object.keys(EVENTS) as EventChannel[];

/** What the preload exposes as `window.carbon`. */
export interface CarbonBridge {
  invoke<C extends InvokeChannel>(
    channel: C,
    request: InvokeRequest<C>,
  ): Promise<InvokeResponse<C>>;
  on<C extends EventChannel>(channel: C, listener: (payload: EventPayload<C>) => void): () => void;
}

/** IPC channel names on the wire (prefixed to avoid clashes with Electron internals). */
export const wire = (channel: string): string => `carbon:${channel}`;
