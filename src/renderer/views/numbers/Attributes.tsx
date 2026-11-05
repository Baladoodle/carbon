import { useState, type ReactNode } from 'react';
import { cmd } from '@core/commands/registry';
import { formatNumber } from '@core/numbers';
import { DEFAULT_SCHEMA } from '@core/model/defaults';
import { ENTITY_KINDS, type EntityKind } from '@core/model/kinds';
import type { AttributeDef } from '@core/model/schema';
import { schemaOf, type World } from '@core/model/world';
import { useActions } from '../../actions';
import { flash } from '../../state/ui';
import { dispatch } from '../../state/world';
import { IconButton, IconClose, IconPlus, Input, Empty, Kbd, Select } from '../../ui';

type Col = 'min' | 'max' | 'default' | 'when' | 'unit';
const NUMERIC: Col[] = ['min', 'max', 'default'];
const KEY = /^[a-z][a-z0-9_]*$/;

/** `subkind=armor, slot=ring` ⇄ `{ subkind: "armor", slot: "ring" }`. */
export function parseWhen(text: string): Record<string, string> | null | undefined {
  const t = text.trim();
  if (t === '') return undefined;
  const out: Record<string, string> = {};
  for (const part of t.split(',')) {
    const m = /^\s*([a-z][a-z0-9_]*)\s*=\s*"?([^"]*?)"?\s*$/.exec(part);
    if (!m?.[1] || m[2] === undefined || m[2] === '') return null;
    out[m[1]] = m[2];
  }
  return out;
}
export const showWhen = (w: AttributeDef['when']): string =>
  w
    ? Object.entries(w)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ')
    : '';

function cellText(def: AttributeDef, col: Col): string {
  if (col === 'when') return showWhen(def.when);
  if (col === 'unit') return def.unit ?? '';
  const v = def[col];
  return v === undefined ? '' : String(v);
}

/** Applies a cell edit to a definition, or says why it can't. */
export function editDef(def: AttributeDef, col: Col, text: string): AttributeDef | string {
  const next: AttributeDef = { ...def };
  const t = text.trim();
  if (col === 'when') {
    const w = parseWhen(t);
    if (w === null) return 'Write field=value, separated by commas';
    if (w) next.when = w;
    else delete next.when;
  } else if (col === 'unit') {
    if (t) next.unit = t;
    else delete next.unit;
  } else if (t === '') delete next[col];
  else {
    const n = Number(t);
    if (!Number.isFinite(n)) return 'A number';
    next[col] = n;
  }
  if (next.min !== undefined && next.max !== undefined && next.min > next.max)
    return 'min is above max';
  return next;
}

/** The values entities of this kind have: how many, and their range. */
function spread(world: World, kind: EntityKind, key: string): string {
  const xs = Object.values(world.entities)
    .filter(
      (e) =>
        e.kind === kind &&
        e.state !== 'graveyard' &&
        Object.prototype.hasOwnProperty.call(e.attributes, key),
    )
    .map((e) => e.attributes[key] as number);
  if (xs.length === 0) return '';
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  return `${xs.length} · ${lo === hi ? formatNumber(lo) : `${formatNumber(lo)}–${formatNumber(hi)}`}`;
}

export function Attributes({ world }: { world: World }): ReactNode {
  const [kind, setKind] = useState<EntityKind>('item');
  const [editing, setEditing] = useState<{ key: string; col: Col; text: string } | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const schema = schemaOf(world);
  const defs = schema.kinds[kind].attributes;
  const overridden = new Set((world.schema.kinds[kind]?.attributes ?? []).map((a) => a.key));
  const builtIn = new Set(DEFAULT_SCHEMA.kinds[kind].attributes.map((a) => a.key));

  const save = async (): Promise<void> => {
    if (!editing) return;
    const def = defs.find((d) => d.key === editing.key);
    if (!def) return setEditing(null);
    if (cellText(def, editing.col) === editing.text.trim()) {
      setEditing(null);
      setError(null);
      return;
    }
    const next = editDef(def, editing.col, editing.text);
    if (typeof next === 'string') return setError(next);
    const r = await dispatch(cmd('schema.setAttributeDef', { kind, def: next }));
    if (!r.ok) return setError(r.error.message);
    setEditing(null);
    setError(null);
  };

  const create = async (): Promise<void> => {
    const key = (adding ?? '').trim();
    if (!KEY.test(key)) return setError('Lower case letters, digits and _, starting with a letter');
    if (defs.some((d) => d.key === key)) return setError(`${kind}.${key} exists`);
    const r = await dispatch(cmd('schema.setAttributeDef', { kind, def: { key } }));
    if (!r.ok) return setError(r.error.message);
    setAdding(null);
    setError(null);
  };

  const remove = async (key: string): Promise<void> => {
    const r = await dispatch(cmd('numbers.removeAttributeDef', { kind, key }));
    if (!r.ok) flash(r.error.message, 'error');
  };

  useActions([
    {
      id: 'numbers.newAttribute',
      label: 'New attribute',
      group: 'Numbers',
      keys: ['a'],
      run: () => {
        setError(null);
        setAdding('');
      },
    },
  ]);

  const cell = (def: AttributeDef, col: Col): ReactNode => {
    const ed = editing?.key === def.key && editing.col === col ? editing : null;
    if (ed)
      return (
        <Input
          mono={col !== 'when' && col !== 'unit'}
          expandable={col === 'when'}
          autoFocus
          aria-label={`${def.key} ${col}`}
          className="numbers-cell-input"
          value={ed.text}
          invalid={!!error}
          onChange={(e) => setEditing({ ...ed, text: e.target.value })}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
            if (e.key === 'Escape') {
              e.stopPropagation();
              setEditing(null);
              setError(null);
            }
          }}
          onBlur={() => void save()}
        />
      );
    return (
      <button
        type="button"
        className={
          NUMERIC.includes(col)
            ? 'numbers-cell num'
            : col === 'when'
              ? 'numbers-cell numbers-when'
              : 'numbers-cell'
        }
        data-empty={col === 'when' && !def.when ? '' : undefined}
        aria-label={`${def.key} ${col}`}
        onClick={() => {
          setError(null);
          setEditing({ key: def.key, col, text: cellText(def, col) });
        }}
      >
        {col === 'when'
          ? def.when
            ? `when ${Object.entries(def.when)
                .map(([k, v]) => `${k} = ${v}`)
                .join(', ')}`
            : '+ when'
          : cellText(def, col)}
      </button>
    );
  };

  return (
    <section className="numbers-attrs" aria-label="Attributes" data-testid="numbers-attributes">
      <div className="numbers-attrs-head">
        <Select
          aria-label="Kind"
          value={kind}
          onValueChange={(v) => {
            setKind(v as EntityKind);
            setEditing(null);
            setAdding(null);
            setError(null);
          }}
          options={ENTITY_KINDS.map((k) => ({ value: k, label: schema.kinds[k].plural }))}
        />
        <IconButton
          size="sm"
          label="New attribute"
          keys="a"
          icon={<IconPlus />}
          onClick={() => setAdding('')}
          data-testid="numbers-add-attribute"
        />
      </div>
      {(defs.length > 0 || adding !== null) && (
        <table className="numbers-attr-table">
          <thead>
            <tr>
              <th />
              <th className="ui-num">min</th>
              <th className="ui-num">max</th>
              <th className="ui-num">default</th>
              <th className="ui-num">set</th>
              <th />
            </tr>
          </thead>
          {defs.map((d) => (
            <tbody key={d.key} data-attr={d.key}>
              <tr className="numbers-attr-row">
                <td className="mono numbers-attr-key">{d.key}</td>
                <td>{cell(d, 'min')}</td>
                <td>{cell(d, 'max')}</td>
                <td>{cell(d, 'default')}</td>
                <td className="ui-num t-3 numbers-attr-spread">{spread(world, kind, d.key)}</td>
                <td>
                  {overridden.has(d.key) && (
                    <IconButton
                      size="sm"
                      className="numbers-row-action"
                      label={builtIn.has(d.key) ? `Revert ${d.key} to built-in` : `Remove ${d.key}`}
                      icon={<IconClose />}
                      onClick={() => void remove(d.key)}
                    />
                  )}
                </td>
              </tr>
              <tr className="numbers-when-row">
                <td colSpan={6}>{cell(d, 'when')}</td>
              </tr>
            </tbody>
          ))}
          <tbody>
            {adding !== null && (
              <tr>
                <td colSpan={6}>
                  <Input
                    mono
                    expandable={false}
                    autoFocus
                    aria-label="New attribute key"
                    value={adding}
                    invalid={!!error}
                    onChange={(e) => setAdding(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void create();
                      if (e.key === 'Escape') {
                        e.stopPropagation();
                        setAdding(null);
                        setError(null);
                      }
                    }}
                    onBlur={() => {
                      if (adding.trim() === '') {
                        setAdding(null);
                        setError(null);
                      }
                    }}
                  />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
      {error && (
        <div className="ui-field-error" role="alert">
          {error}
        </div>
      )}
      {defs.length === 0 && adding === null && (
        <Empty className="numbers-empty">
          No attributes yet. <Kbd>a</Kbd> to add one.
        </Empty>
      )}
    </section>
  );
}
