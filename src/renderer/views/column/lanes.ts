import { z } from 'zod';
import { cmd, type Command } from '@core/commands/registry';
import { LANES, type Lane } from '@core/model/kinds';
import type { World } from '@core/model/world';

/**
 * Which lanes the Column shows, in which order, and the saved layouts
 * (docs/EXPERIENCE.md §2). Stored in `carbon.json` under `column` (settings
 * are loose, foundation decision 10), so it's per world, undoable like any
 * other change, and survives restarts.
 */
/** Lanes are read leniently (unknown names dropped) so one bad entry never loses a layout. */
const LaneListSchema = z.array(z.string()).transform(cleanLanes);

export const LayoutSchema = z.object({
  name: z.string().min(1).max(60),
  lanes: LaneListSchema,
});
export type Layout = z.infer<typeof LayoutSchema>;

export const ColumnSettingsSchema = z.object({
  /** The lanes shown, left to right. */
  lanes: LaneListSchema.default([...LANES]),
  layouts: z.array(LayoutSchema).default([]),
  /** Whether graveyard entities show (faded) on the Column. */
  graveyard: z.boolean().default(true),
});
export type ColumnSettings = z.infer<typeof ColumnSettingsSchema>;

const DEFAULTS: ColumnSettings = { lanes: [...LANES], layouts: [], graveyard: true };

/** Lanes without duplicates or unknowns, in the given order. */
export function cleanLanes(lanes: readonly string[]): Lane[] {
  const out: Lane[] = [];
  for (const l of lanes)
    if ((LANES as readonly string[]).includes(l) && !out.includes(l as Lane)) out.push(l as Lane);
  return out;
}

/** The Column settings of a world; anything malformed falls back to the defaults. */
export function columnSettings(world: Pick<World, 'settings'>): ColumnSettings {
  const raw = (world.settings as Record<string, unknown>).column;
  const r = ColumnSettingsSchema.safeParse(raw ?? {});
  if (!r.success) return { ...DEFAULTS, lanes: [...DEFAULTS.lanes] };
  return r.data;
}

const save = (s: ColumnSettings): Command => cmd('settings.set', { key: 'column', value: s });

/** Shows or hides a lane. A lane shown again goes after the nearest lane that precedes it by default. */
export function toggleLane(s: ColumnSettings, lane: Lane): Command {
  if (s.lanes.includes(lane)) return save({ ...s, lanes: s.lanes.filter((l) => l !== lane) });
  const idx = LANES.indexOf(lane);
  let at = 0;
  s.lanes.forEach((l, i) => {
    if (LANES.indexOf(l) < idx) at = i + 1;
  });
  return save({ ...s, lanes: [...s.lanes.slice(0, at), lane, ...s.lanes.slice(at)] });
}

/** Moves a shown lane one place left (−1) or right (+1). Null when it can't move. */
export function moveLane(s: ColumnSettings, lane: Lane, dir: 1 | -1): Command | null {
  const i = s.lanes.indexOf(lane);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= s.lanes.length) return null;
  const lanes = [...s.lanes];
  [lanes[i], lanes[j]] = [lanes[j] as Lane, lanes[i] as Lane];
  return save({ ...s, lanes });
}

/** Saves the current lanes as a layout (replacing one with the same name). */
export function saveLayout(s: ColumnSettings, name: string): Command {
  const n = name.trim();
  const layouts = [...s.layouts.filter((l) => l.name !== n), { name: n, lanes: [...s.lanes] }];
  layouts.sort((a, b) => a.name.localeCompare(b.name));
  return save({ ...s, layouts });
}

export function applyLayout(s: ColumnSettings, name: string): Command | null {
  const l = s.layouts.find((x) => x.name === name);
  return l ? save({ ...s, lanes: [...l.lanes] }) : null;
}

export function deleteLayout(s: ColumnSettings, name: string): Command | null {
  if (!s.layouts.some((x) => x.name === name)) return null;
  return save({ ...s, layouts: s.layouts.filter((l) => l.name !== name) });
}

export function setGraveyard(s: ColumnSettings, show: boolean): Command {
  return save({ ...s, graveyard: show });
}

/** The layout whose lanes match the current ones, if any. */
export const currentLayout = (s: ColumnSettings): string | undefined =>
  s.layouts.find(
    (l) => l.lanes.length === s.lanes.length && l.lanes.every((x, i) => x === s.lanes[i]),
  )?.name;
