import { useState, type ReactNode } from 'react';
import { cmd } from '@core/commands/registry';
import type { Entity } from '@core/model/entity';
import { schemaOf, type World } from '@core/model/world';
import { flash } from '../state/ui';
import { transact } from '../state/world';
import { Combobox, Select, StateGlyph } from '../ui';
import { EntityChip } from './fields';
import { incomingTo, relationTypesFrom, targetsFor } from '@core/bench/relations';

/**
 * Relations of the entity in focus: what it holds (removable), what others
 * hold to it (read from their side), and a picker that only offers what the
 * relation's type rules allow.
 */
export function Relations({ world, entity }: { world: World; entity: Entity }): ReactNode {
  const rels = schemaOf(world).relations;
  const types = relationTypesFrom(world, entity.kind);
  const [type, setType] = useState<string>(types[0]?.type ?? '');
  const chosen = types.some((t) => t.type === type) ? type : (types[0]?.type ?? '');
  const targets = chosen ? targetsFor(world, entity, chosen) : [];
  const incoming = incomingTo(world, entity.id);

  const run = (label: string, c: ReturnType<typeof cmd>): void => {
    void transact(label, [c]).then((r) => {
      if (!r.ok) flash(r.error.message, 'error');
    });
  };

  return (
    <div className="bench-relations" data-testid="bench-relations">
      {entity.relations.length + incoming.length > 0 && (
        <ul className="bench-rel-list">
          {entity.relations.map((r) => (
            <li
              key={`${r.type}>${r.target}`}
              className="bench-rel"
              data-rel={`${r.type}:${r.target}`}
            >
              <span className="bench-rel-type t-2">{rels[r.type]?.label ?? r.type}</span>
              <EntityChip
                world={world}
                id={r.target}
                onRemove={() =>
                  run(
                    `Unrelate ${world.entities[r.target]?.name ?? r.target}`,
                    cmd('relation.remove', { from: entity.id, type: r.type, to: r.target }),
                  )
                }
              />
              {r.note && <span className="bench-rel-note t-3">{r.note}</span>}
            </li>
          ))}
          {incoming.map((i) => (
            <li
              key={`<${i.type}<${i.from.id}`}
              className="bench-rel bench-rel-in"
              data-rel-in={`${i.type}:${i.from.id}`}
            >
              <span className="bench-rel-type t-3">{i.label}</span>
              <EntityChip world={world} id={i.from.id} />
              {i.note && <span className="bench-rel-note t-3">{i.note}</span>}
            </li>
          ))}
        </ul>
      )}
      {types.length > 0 && (
        <div className="bench-rel-add" data-bench-field="relation">
          <Select
            aria-label="Relation type"
            value={chosen}
            options={types.map((t) => ({ value: t.type, label: t.label }))}
            onValueChange={setType}
            className="bench-rel-type-pick"
          />
          <Combobox
            aria-label="Relate to"
            items={targets.map((t) => ({
              value: t.id,
              label: t.name,
              hint: t.kind,
              glyph: <StateGlyph state={t.state} tooltip={false} />,
            }))}
            value={null}
            onChange={(to) =>
              run(
                `Relate ${world.entities[to]?.name ?? to}`,
                cmd('relation.add', { from: entity.id, type: chosen, to }),
              )
            }
            className="bench-grow"
            empty="Nothing fits"
          />
        </div>
      )}
    </div>
  );
}
