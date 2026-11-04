import type { Note } from '../model/notes';
import { getEntity, type World } from '../model/world';
import { hashValue } from '../util/hash';
import { allSpreads, candidateOf } from './record';
import { spotEntities } from './spot';

/**
 * Kept Break findings as notes (docs/EXPERIENCE.md §4: Break finds exploits,
 * not entities). Keeping one puts it in the margin of the entities it
 * involves, on the Column and the Bench, until the judgement is undone.
 * Pure: the same world gives the same notes, ids stable per spread and key.
 */
export function findingNotes(world: World): Note[] {
  const out: Note[] = [];
  for (const s of allSpreads(world))
    for (const [key, j] of Object.entries(s.judgements)) {
      if (j.verdict !== 'keep') continue;
      const c = candidateOf(s, key);
      if (!c || c.kind !== null) continue;
      const entities = [
        ...new Set([
          ...c.relations.map((r) => r.target),
          ...(c.about ? [c.about] : []),
          ...spotEntities(world, s.spot),
        ]),
      ].filter((id) => getEntity(world, id));
      if (s.spot.type === 'cell' || s.spot.type === 'region')
        if (getEntity(world, s.spot.band) && !entities.includes(s.spot.band))
          entities.push(s.spot.band);
      out.push({
        id: `spread:${s.id}:${key}`,
        source: 'ai',
        kind: 'break',
        severity: 'warn',
        text: c.identity ? `${c.name}: ${c.identity}` : c.name,
        entities,
        inputsHash: hashValue([c.name, c.identity, entities]),
      });
    }
  return out;
}
