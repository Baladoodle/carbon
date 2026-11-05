import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { bandSpans } from '@core/checks/placement';
import { buildSpec, changedSinceExport, isExportable, selectForExport } from '@core/export/spec';
import type { Entity } from '@core/model/entity';
import { ENTITY_KINDS, type EntityKind } from '@core/model/kinds';
import { schemaOf, type World } from '@core/model/world';
import type { ExportRecord } from '@shared/ipc';
import { useActions } from '../../actions';
import { ai } from '../../ai/client';
import { invoke } from '../../bridge';
import { CHECK_ADAPTERS } from '../../palette/Platform';
import { focusEntity } from '../../state/ui';
import { currentWorld, useWorld } from '../../state/world';
import { Button, cx, Input, Empty, Kbd, StateGlyph, Textarea, toast, Tooltip } from '../../ui';
import { IconExport } from '../../ui/icons';
import { defineView } from '../define';
import { imagePaths } from '@core/images/model';
import { selected as selectedImage } from '../../images/model';
import { Thumb } from '../../images/Thumb';
import './export.css';

/**
 * Export (EXPERIENCE.md §7): choose decided entities by kind, by band or by
 * hand; draft the spec (the `spec_draft` AI moment, or the deterministic spec
 * when the AI is off); edit it; write `exports/<date>-<name>.md` and mark the
 * entities exported, in one transaction.
 *
 * Keys (focus inside the view): j/k or ↑/↓ move, space toggles, enter puts the
 * entity on the Bench; ctrl+enter drafts; ctrl+s writes the export.
 */
interface Choice {
  kinds: EntityKind[];
  bands: string[];
  picked: string[];
  dropped: string[];
}

const EMPTY: Choice = { kinds: [], bands: [], picked: [], dropped: [] };
const toggle = <T,>(xs: readonly T[], x: T): T[] =>
  xs.includes(x) ? xs.filter((y) => y !== x) : [...xs, x];

function defaultName(
  chosen: readonly Entity[],
  kindsLabel: (k: EntityKind) => string,
  bandName: (id: string) => string,
  c: Choice,
): string {
  if (c.bands.length === 1 && c.kinds.length === 1)
    return `${bandName(c.bands[0] ?? '')} ${kindsLabel(c.kinds[0] as EntityKind).toLowerCase()}`;
  if (c.bands.length === 1) return bandName(c.bands[0] ?? '');
  if (c.kinds.length === 1) return kindsLabel(c.kinds[0] as EntityKind);
  if (chosen.length === 1) return chosen[0]?.name ?? '';
  return '';
}

function ExportView(): ReactNode {
  const root = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const [choice, setChoice] = useState<Choice>(EMPTY);
  const [cursor, setCursor] = useState(0);
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [draft, setDraft] = useState<{ text: string; byAi: boolean } | null>(null);
  const [busy, setBusy] = useState<'draft' | 'write' | null>(null);
  const [records, setRecords] = useState<ExportRecord[]>([]);
  const abort = useRef<AbortController | null>(null);

  const world = useWorld((w) => w, Object.is);
  const exportable = useMemo(
    () =>
      Object.values(world?.entities ?? {})
        .filter(isExportable)
        .sort(
          (a, b) =>
            ENTITY_KINDS.indexOf(a.kind) - ENTITY_KINDS.indexOf(b.kind) ||
            a.name.localeCompare(b.name),
        ),
    [world],
  );
  const bands = useMemo(() => (world ? bandSpans(world) : []), [world]);
  const kinds = useMemo(
    () => ENTITY_KINDS.filter((k) => exportable.some((e) => e.kind === k)),
    [exportable],
  );
  const chosen = useMemo(() => {
    if (!world) return [];
    const byRule = selectForExport(
      world,
      { kinds: choice.kinds, bands: choice.bands, ids: choice.picked },
      CHECK_ADAPTERS.placement,
    );
    return byRule.filter((e) => !choice.dropped.includes(e.id));
  }, [world, choice]);
  const chosenIds = useMemo(() => new Set(chosen.map((e) => e.id)), [chosen]);
  const changed = useMemo(
    () => new Set(world ? changedSinceExport(world, records).map((e) => e.id) : []),
    [world, records],
  );
  const label = (k: EntityKind): string => (world ? schemaOf(world).kinds[k].plural : k);
  const bandName = (id: string): string => world?.entities[id]?.name ?? id;
  const suggested = defaultName(chosen, label, bandName, choice);
  const specName = (nameTouched ? name : suggested).trim();

  useEffect(() => {
    void invoke('export:list', null).then(setRecords);
  }, []);
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    listRef.current?.querySelector('[data-cursor]')?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const toggleEntity = (id: string): void =>
    setChoice((c) => {
      if (chosenIds.has(id))
        return { ...c, picked: c.picked.filter((x) => x !== id), dropped: [...c.dropped, id] };
      return { ...c, dropped: c.dropped.filter((x) => x !== id), picked: [...c.picked, id] };
    });

  const draftSpec = async (): Promise<void> => {
    const w = currentWorld();
    if (!w || chosen.length === 0) return;
    const ids = chosen.map((e) => e.id);
    const title = specName || `${chosen.length} entities`;
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setBusy('draft');
    try {
      if (ai.status().enabled) {
        const out = await ai.run(
          'spec_draft',
          { entityIds: ids, name: title },
          { signal: ac.signal },
        );
        if (ac.signal.aborted) return;
        if (out.ok) {
          setDraft({ text: out.result.markdown, byAi: true });
          return;
        }
        if (out.error.code === 'cancelled') return;
        toast(`AI draft failed (${out.error.code}); used the template`, { tone: 'error' });
      }
      setDraft({
        text: buildSpec(w, ids, { name: title, numbers: CHECK_ADAPTERS.numbers }),
        byAi: false,
      });
    } finally {
      if (abort.current === ac) setBusy(null);
    }
    requestAnimationFrame(() => editor.current?.focus());
  };

  const useTemplate = (): void => {
    const w = currentWorld();
    if (!w || chosen.length === 0) return;
    setDraft({
      text: buildSpec(
        w,
        chosen.map((e) => e.id),
        { name: specName || `${chosen.length} entities`, numbers: CHECK_ADAPTERS.numbers },
      ),
      byAi: false,
    });
  };

  const write = async (): Promise<void> => {
    if (!draft || chosen.length === 0 || busy) return;
    const n = specName || `${chosen.length} entities`;
    setBusy('write');
    try {
      const r = await invoke('export:write', {
        name: n,
        markdown: draft.text,
        entityIds: chosen.map((e) => e.id),
      });
      if (!r.ok) {
        toast(r.error.message, { tone: 'error' });
        return;
      }
      toast(`Exported to ${r.path}`);
      setDraft(null);
      setChoice(EMPTY);
      setName('');
      setNameTouched(false);
      setRecords(await invoke('export:list', null));
    } finally {
      setBusy(null);
    }
  };

  const inside = (): boolean => !!root.current?.contains(document.activeElement);
  const inList = (): boolean => document.activeElement === listRef.current;
  const at = (): Entity | undefined => exportable[Math.min(cursor, exportable.length - 1)];
  useActions([
    {
      id: 'export.draft',
      label: 'Draft the spec',
      group: 'Export',
      keys: ['ctrl+enter'],
      inInputs: true,
      enabled: () => inside() && chosen.length > 0 && busy === null,
      run: () => void draftSpec(),
    },
    {
      id: 'export.write',
      label: 'Write the export',
      group: 'Export',
      keys: ['ctrl+s'],
      inInputs: true,
      enabled: () => inside() && !!draft && chosen.length > 0 && busy === null,
      run: () => void write(),
    },
    {
      id: 'export.template',
      label: 'Use the spec template',
      group: 'Export',
      enabled: () => chosen.length > 0,
      run: useTemplate,
    },
    {
      id: 'export.all',
      label: 'Choose every decided entity',
      group: 'Export',
      enabled: () => exportable.length > 0,
      run: () => setChoice({ ...EMPTY, kinds: [...kinds] }),
    },
    // Every kind and band toggle is in the palette too (keyboard reach).
    ...kinds.map((k) => ({
      id: `export.kind.${k}`,
      label: `Export: choose by kind, ${label(k)}`,
      group: 'Export',
      run: () => setChoice((c) => ({ ...c, kinds: toggle(c.kinds, k) })),
    })),
    ...bands.map((b) => ({
      id: `export.band.${b.id}`,
      label: `Export: choose by band, ${b.name}`,
      group: 'Export',
      run: () => setChoice((c) => ({ ...c, bands: toggle(c.bands, b.id) })),
    })),
    {
      id: 'export.clear',
      label: 'Clear the export choice',
      group: 'Export',
      enabled: () => chosen.length > 0,
      run: () => setChoice(EMPTY),
    },
    {
      id: 'export.down',
      label: 'Next',
      keys: ['j', 'arrowdown'],
      hidden: true,
      enabled: inList,
      run: () => setCursor((c) => Math.min(c + 1, exportable.length - 1)),
    },
    {
      id: 'export.up',
      label: 'Previous',
      keys: ['k', 'arrowup'],
      hidden: true,
      enabled: inList,
      run: () => setCursor((c) => Math.max(c - 1, 0)),
    },
    {
      id: 'export.toggle',
      label: 'Toggle',
      keys: ['space', 'x'],
      hidden: true,
      enabled: () => inList() && !!at(),
      run: () => toggleEntity(at()?.id ?? ''),
    },
    {
      id: 'export.focus',
      label: 'Put on the Bench',
      keys: ['enter'],
      hidden: true,
      enabled: () => inList() && !!at(),
      run: () => focusEntity(at()?.id ?? ''),
    },
  ]);

  if (!world) return null;
  if (exportable.length === 0)
    return (
      <Empty className="export-empty" data-testid="export-empty">
        Nothing decided to export. <Kbd>d</Kbd> decides the entity on the Bench.
      </Empty>
    );

  return (
    <div className="export-view" ref={root} data-testid="export-view">
      <div className="export-choose">
        <div className="export-filters" role="group" aria-label="Choose by kind">
          {kinds.map((k) => (
            <button
              key={k}
              type="button"
              className="export-chip"
              aria-pressed={choice.kinds.includes(k)}
              data-testid={`export-kind-${k}`}
              onClick={() => setChoice((c) => ({ ...c, kinds: toggle(c.kinds, k) }))}
            >
              {label(k)}
            </button>
          ))}
        </div>
        {bands.length > 0 && (
          <div className="export-filters" role="group" aria-label="Choose by band">
            {[...bands].reverse().map((b) => (
              <button
                key={b.id}
                type="button"
                className="export-chip"
                aria-pressed={choice.bands.includes(b.id)}
                data-testid={`export-band-${b.id}`}
                onClick={() => setChoice((c) => ({ ...c, bands: toggle(c.bands, b.id) }))}
              >
                {b.name}
              </button>
            ))}
          </div>
        )}
        <div
          className="export-list"
          ref={listRef}
          tabIndex={0}
          role="listbox"
          aria-label="Decided entities"
          aria-multiselectable
          data-testid="export-list"
        >
          {exportable.map((e, i) => {
            const on = chosenIds.has(e.id);
            return (
              <div
                key={e.id}
                role="option"
                aria-selected={on}
                data-entity={e.id}
                data-cursor={i === cursor ? '' : undefined}
                className={cx('export-row', on && 'is-on')}
                onMouseDown={(ev) => {
                  ev.preventDefault();
                  listRef.current?.focus();
                  setCursor(i);
                  toggleEntity(e.id);
                }}
              >
                <span className="export-check" aria-hidden="true" />
                <StateGlyph state={e.state} />
                <span className="export-name">{e.name}</span>
                {changed.has(e.id) && (
                  <Tooltip content="Changed since it was exported">
                    <span className="export-changed" aria-label="changed since exported" />
                  </Tooltip>
                )}
                <span className="t-3 t-meta">
                  {schemaOf(world).kinds[e.kind].label.toLowerCase()}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="export-edit">
        <div className="export-bar">
          <Input
            aria-label="Spec name"
            placeholder="Spec name"
            className="export-name-input"
            data-testid="export-name"
            value={nameTouched ? name : suggested}
            onChange={(e) => {
              setName(e.target.value);
              setNameTouched(true);
            }}
          />
          <span className="t-2 num export-count" data-testid="export-count">
            {chosen.length === 1 ? '1 entity' : `${chosen.length} entities`}
          </span>
          {draft ? (
            <>
              <Button
                onClick={() => void draftSpec()}
                disabled={busy !== null || chosen.length === 0}
              >
                Redraft
              </Button>
              <Button
                variant="primary"
                data-testid="export-write"
                onClick={() => void write()}
                disabled={busy !== null || chosen.length === 0}
              >
                Export
              </Button>
            </>
          ) : (
            <Button
              variant="primary"
              data-testid="export-draft"
              onClick={() => void draftSpec()}
              disabled={busy !== null || chosen.length === 0}
            >
              {busy === 'draft' ? 'Drafting…' : 'Draft'}
            </Button>
          )}
        </div>
        <ExportImages world={world} ids={chosen.map((e) => e.id)} />
        {!draft && (
          <Empty className="export-none" data-testid="export-none">
            {chosen.length === 0 ? (
              <>
                Nothing chosen. <Kbd>space</Kbd> on an entity to choose it.
              </>
            ) : (
              <>
                No draft yet. <Kbd>ctrl+enter</Kbd> to draft the spec.
              </>
            )}
          </Empty>
        )}
        {draft && (
          <Textarea
            ref={editor}
            mono
            aria-label="Spec"
            data-testid="export-editor"
            data-ai={draft.byAi ? '' : undefined}
            className={cx('export-editor', draft.byAi && 'is-ai')}
            value={draft.text}
            onChange={(e) => setDraft({ text: e.target.value, byAi: false })}
            spellCheck={false}
          />
        )}
      </div>
    </div>
  );
}

export default defineView({
  id: 'export',
  label: 'Export',
  key: '7',
  order: 7,
  icon: IconExport,
  component: ExportView,
});

/**
 * The chosen entities' selected images: what the spec lists and what export
 * copies to `exports/<spec>/images/` (docs/IMAGES.md §6). Names and paths
 * are in the tooltips.
 */
function ExportImages({ world, ids }: { world: World; ids: string[] }): ReactNode {
  const withImages = ids
    .map((id) => ({
      id,
      name: world.entities[id]?.name ?? id,
      concept: selectedImage(world, id, 'concept'),
      icon: selectedImage(world, id, 'icon'),
    }))
    .filter((x) => x.concept || x.icon);
  if (withImages.length === 0) return null;
  return (
    <div className="export-images" data-testid="export-images">
      {withImages.map((x) => (
        <div key={x.id} className="export-image" data-entity={x.id}>
          {x.icon && (
            <Thumb
              meta={x.icon}
              size={32}
              title={`${x.name} · ${imagePaths(x.id, x.icon.id).png}`}
              testId="export-icon"
            />
          )}
          {x.concept && (
            <Thumb
              meta={x.concept}
              className="export-concept"
              title={`${x.name} · ${imagePaths(x.id, x.concept.id).png}`}
              testId="export-concept"
            />
          )}
        </div>
      ))}
    </div>
  );
}
