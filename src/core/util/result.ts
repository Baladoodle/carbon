/** A value or a typed error. Core functions return these instead of throwing. */
export type Result<T, E = CoreError> = { ok: true; value: T } | { ok: false; error: E };

export interface CoreError {
  /** Stable machine-readable code, e.g. `entity.not_found`. */
  code: string;
  /** One sentence for a human. */
  message: string;
  /** Optional structured detail (zod issues, ids, paths). */
  detail?: unknown;
}

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = (code: string, message: string, detail?: unknown): Result<never> => ({
  ok: false,
  error: detail === undefined ? { code, message } : { code, message, detail },
});
