import { useRef, useState, type ReactNode } from 'react';
import { cmd } from '@core/commands/registry';
import type { NumbersAnalysis } from '@core/numbers';
import type { World } from '@core/model/world';
import { useActions } from '../../actions';
import { flash } from '../../state/ui';
import { dispatch } from '../../state/world';
import { IconButton, IconPlus, IconClose, Input } from '../../ui';

type VarValue = number | string | boolean;

/** `12` → 12, `true` → true, `"a b"` or `a b` → a string. */
export function parseVarValue(text: string): VarValue | null {
  const t = text.trim();
  if (t === '') return null;
  if (t === 'true' || t === 'false') return t === 'true';
  const n = Number(t.replace(/_/g, ''));
  if (/^-?[0-9_]*\.?[0-9_]+(e[+-]?[0-9]+)?$/i.test(t) && Number.isFinite(n)) return n;
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
  return t;
}

export const showVarValue = (v: VarValue): string => (typeof v === 'string' ? `"${v}"` : String(v));

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function uniqueName(vars: Record<string, unknown>, base = 'v'): string {
  for (let i = 1; ; i++)
    if (!Object.prototype.hasOwnProperty.call(vars, `${base}${i}`)) return `${base}${i}`;
}

interface Editing {
  name: string;
  field: 'name' | 'value';
  text: string;
}

/** The variables, edited inline: `k = 100`. Uses per variable come from the analysis. */
export function Variables({
  world,
  analysis,
}: {
  world: World;
  analysis: NumbersAnalysis;
}): ReactNode {
  const vars = world.numbers.variables;
  const [editing, setEditing] = useState<Editing | null>(null);
  const [error, setError] = useState<string | null>(null);

  const uses = new Map<string, number>();
  for (const d of analysis.defs) for (const v of d.variables) uses.set(v, (uses.get(v) ?? 0) + 1);

  const start = (name: string, field: Editing['field']): void => {
    setError(null);
    const v = vars[name];
    setEditing({
      name,
      field,
      text: field === 'name' ? name : v === undefined ? '' : showVarValue(v),
    });
  };

  const save = async (): Promise<boolean> => {
    if (!editing) return true;
    const { name, field, text } = editing;
    if (field === 'name') {
      const to = text.trim();
      if (to === name) return true;
      if (!IDENT.test(to)) {
        setError('A name is letters, digits and _, starting with a letter');
        return false;
      }
      const r = await dispatch(cmd('numbers.renameVariable', { from: name, to }));
      if (!r.ok) {
        setError(r.error.message);
        return false;
      }
      return true;
    }
    const value = parseVarValue(text);
    if (value === null) {
      setError('Give it a value');
      return false;
    }
    if (value === vars[name]) return true;
    const r = await dispatch(cmd('numbers.setVariable', { name, value }));
    if (!r.ok) {
      setError(r.error.message);
      return false;
    }
    return true;
  };

  const saving = useRef(false);
  const finish = async (next?: 'value'): Promise<void> => {
    if (!editing || saving.current) return;
    const ed = editing;
    saving.current = true;
    const saved = await save().finally(() => {
      saving.current = false;
    });
    if (!saved) return;
    setError(null);
    if (next === 'value' && ed.field === 'name') {
      const v = vars[ed.name];
      setEditing({
        name: ed.text.trim(),
        field: 'value',
        text: v === undefined ? '' : showVarValue(v),
      });
    } else setEditing(null);
  };

  const add = async (): Promise<void> => {
    const name = uniqueName(vars);
    const r = await dispatch(cmd('numbers.setVariable', { name, value: 0 }));
    if (!r.ok) {
      flash(r.error.message, 'error');
      return;
    }
    setError(null);
    setEditing({ name, field: 'name', text: name });
  };

  const remove = async (name: string): Promise<void> => {
    const r = await dispatch(cmd('numbers.setVariable', { name, value: null }));
    if (!r.ok) flash(r.error.message, 'error');
  };

  useActions([
    {
      id: 'numbers.newVariable',
      label: 'New variable',
      group: 'Numbers',
      keys: ['v'],
      run: () => void add(),
    },
  ]);

  const names = Object.keys(vars);
  return (
    <section className="numbers-vars" aria-label="Variables" data-testid="numbers-variables">
      <ul>
        {names.map((name) => {
          const v = vars[name] as VarValue;
          const ed = editing?.name === name ? editing : null;
          const n = uses.get(name) ?? 0;
          return (
            <li key={name} data-var={name}>
              {ed?.field === 'name' ? (
                <Input
                  mono
                  autoFocus
                  aria-label="Name"
                  className="numbers-var-name-input"
                  value={ed.text}
                  invalid={!!error}
                  onChange={(e) => setEditing({ ...ed, text: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === 'Tab') {
                      e.preventDefault();
                      void finish(e.key === 'Tab' ? 'value' : undefined);
                    }
                    if (e.key === 'Escape') {
                      e.stopPropagation();
                      setEditing(null);
                      setError(null);
                    }
                  }}
                  onBlur={() => void finish()}
                />
              ) : (
                <button
                  type="button"
                  className="numbers-var-name mono"
                  onClick={() => start(name, 'name')}
                >
                  {name}
                </button>
              )}
              <span className="numbers-eq t-3">=</span>
              {ed?.field === 'value' ? (
                <Input
                  mono
                  autoFocus
                  aria-label={`Value of ${name}`}
                  className="numbers-var-value-input"
                  value={ed.text}
                  invalid={!!error}
                  onChange={(e) => setEditing({ ...ed, text: e.target.value })}
                  onFocus={(e) => e.currentTarget.select()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void finish();
                    }
                    if (e.key === 'Escape') {
                      e.stopPropagation();
                      setEditing(null);
                      setError(null);
                    }
                  }}
                  onBlur={() => void finish()}
                />
              ) : (
                <button
                  type="button"
                  className="numbers-var-value mono"
                  data-testid={`var-${name}`}
                  onClick={() => start(name, 'value')}
                >
                  {showVarValue(v)}
                </button>
              )}
              <IconButton
                size="sm"
                label={
                  n === 0
                    ? `Remove ${name}`
                    : `Remove ${name} (used by ${n === 1 ? '1 formula' : `${n} formulas`})`
                }
                icon={<IconClose />}
                className="numbers-row-action"
                onClick={() => void remove(name)}
              />
              {ed && error && (
                <div className="numbers-var-error ui-field-error" role="alert">
                  {error}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <IconButton
        size="sm"
        label="New variable"
        keys="v"
        icon={<IconPlus />}
        onClick={() => void add()}
        data-testid="numbers-add-variable"
      />
    </section>
  );
}
