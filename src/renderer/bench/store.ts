import type { Suggestion } from '@core/ai/moments';
import { createStore, useStore } from '../state/store';

/**
 * The Bench's own UI state: which field has focus, AI suggestions and fill
 * proposals waiting in fields, requests in flight, and which entities you've
 * changed since their last critique. Not part of the world.
 */
export interface FieldRef {
  entity: string;
  key: string;
}

export interface Pending {
  /** The value the AI proposes for the field (already checked against its schema). */
  value: unknown;
  note?: string;
  /** `suggest`: one ghost suggestion (tab); `fill`: a fill proposal (ctrl+enter). */
  from: 'suggest' | 'fill';
}

export interface BenchUi {
  field: FieldRef | null;
  /** `${entity}:${key}` → what the AI proposes for it. */
  pending: Record<string, Pending>;
  /** Three alternatives under one field (shift+tab). */
  three: (FieldRef & { options: Suggestion[] }) | null;
  /** `${entity}:${key}` or `${entity}:*` (fill) → a request in flight. */
  loading: Record<string, true>;
  /** `${entity}:critique` while a critique runs. */
  critiquing: Record<string, true>;
  /** `${entity}:${key}` → values already shown, so tab again gives another. */
  shown: Record<string, unknown[]>;
  /** Entities changed by you since their last critique (critique on finishing the edit). */
  edited: Record<string, true>;
  /** Ask the Bench to focus a field (e.g. the name of a new entity). */
  focusRequest: (FieldRef & { seq: number; select?: boolean }) | null;
  /** The last AI error to show on the Bench, per entity. */
  error: Record<string, string>;
}

export const benchStore = createStore<BenchUi>({
  field: null,
  pending: {},
  three: null,
  loading: {},
  critiquing: {},
  shown: {},
  edited: {},
  focusRequest: null,
  error: {},
});

export const useBench = <T>(selector: (s: BenchUi) => T): T => useStore(benchStore, selector);

export const setBench = (patch: Partial<BenchUi>): void =>
  benchStore.set((s) => ({ ...s, ...patch }));

export const fieldId = (entity: string, key: string): string => `${entity}:${key}`;

let seq = 0;
/** Focuses a field on the Bench once it renders (optionally selecting its text). */
export function requestFieldFocus(entity: string, key: string, select = false): void {
  setBench({ focusRequest: { entity, key, seq: ++seq, select } });
}

/** Sets or clears one entry of a record field of the store. */
export function setEntry<
  K extends 'pending' | 'loading' | 'critiquing' | 'shown' | 'edited' | 'error',
>(which: K, key: string, value: BenchUi[K][string] | undefined): void {
  benchStore.set((s) => {
    const rec = { ...(s[which] as Record<string, unknown>) };
    if (value === undefined) {
      if (!(key in rec)) return s;
      delete rec[key];
    } else rec[key] = value;
    return { ...s, [which]: rec };
  });
}
