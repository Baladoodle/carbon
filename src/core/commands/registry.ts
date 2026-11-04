import type { z } from 'zod';
import type { CommandDef } from './define';
import { entityCommands } from './entity-commands';
import { worldCommands } from './world-commands';

/**
 * Every command carbon knows. A package adds its commands by defining them in
 * its own folder (with `defineCommand`) and spreading its map in here — one line.
 */
export const COMMANDS = {
  ...entityCommands,
  ...worldCommands,
} as const;

export type CommandMap = typeof COMMANDS;
export type CommandType = keyof CommandMap;

/** The payload a caller passes for a command (defaults not yet applied). */
export type CommandPayload<T extends CommandType> = z.input<CommandMap[T]['payload']>;

/** A command as sent over IPC: `{ type, payload }`, typed per command. */
export type Command = { [T in CommandType]: { type: T; payload: CommandPayload<T> } }[CommandType];

/** Builds a typed command: `cmd('entity.create', { kind: 'item', name: 'Glass Lung' })`. */
export const cmd = <T extends CommandType>(type: T, payload: CommandPayload<T>): Command =>
  ({ type, payload }) as Command;

export const commandDef = (type: string): CommandDef | undefined =>
  Object.prototype.hasOwnProperty.call(COMMANDS, type)
    ? (COMMANDS[type as CommandType])
    : undefined;
