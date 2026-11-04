import { useState, type ReactNode } from 'react';
import { ENTITY_STATES } from '@core/model/kinds';
import { useActions } from '../actions';
import { setUi } from '../state/ui';
import { useWorld } from '../state/world';
import {
  Button,
  Combobox,
  Dialog,
  Field,
  IconButton,
  IconPlus,
  Input,
  Menu,
  Popover,
  Select,
  StateGlyph,
  Table,
  Tabs,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Textarea,
  toast,
} from './index';

/**
 * Every kit component in its states, for review, screenshots and e2e tests.
 * Only reachable in development and e2e builds (palette: "UI kit").
 */
export function Gallery(): ReactNode {
  const [tab, setTab] = useState('one');
  const [sub, setSub] = useState<string | undefined>('armor');
  const [pick, setPick] = useState<string | null>(null);
  const [name, setName] = useState('Gla');
  const [dialog, setDialog] = useState(false);
  const entities = useWorld((w) => Object.values(w.entities)) ?? [];
  const close = (): void => setUi({ overlay: null });
  useActions([{ id: 'ui-kit.close', label: 'Close', keys: ['escape'], run: close, hidden: true }]);
  return (
    <div className="palette-scrim" onMouseDown={close}>
      <div
        className="ui-overlay gallery"
        data-testid="ui-kit"
        role="dialog"
        aria-label="UI kit"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="gallery-row">
          <Button variant="primary">Decide</Button>
          <Button>Keep</Button>
          <Button variant="ghost">Skip</Button>
          <Button variant="destructive">Delete</Button>
          <Button size="sm">Small</Button>
          <Button disabled>Disabled</Button>
          <IconButton label="New entity" keys="n" icon={<IconPlus />} />
          <IconButton label="Active" icon={<IconPlus />} active />
        </div>
        <div className="gallery-row">
          {ENTITY_STATES.map((s) => (
            <StateGlyph key={s} state={s} size={12} />
          ))}
        </div>
        <div className="gallery-grid">
          <Field label="Name">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              suggestion="Glass Lung"
              data-testid="kit-input"
            />
          </Field>
          <Field label="Defense" error="must be at least 0">
            <Input mono defaultValue="-4" />
          </Field>
          <Field label="Subkind">
            <Select
              value={sub}
              onValueChange={setSub}
              options={['armor', 'accessory', 'tool', 'weapon', 'consumable'].map((v) => ({
                value: v,
                label: v,
              }))}
            />
          </Field>
          <Field label="Made from">
            <Combobox
              items={entities.map((e) => ({
                value: e.id,
                label: e.name,
                hint: e.kind,
                glyph: <StateGlyph state={e.state} tooltip={false} />,
              }))}
              value={pick}
              onChange={setPick}
              empty="No match"
            />
          </Field>
          <Field label="Description" className="gallery-wide">
            <Textarea
              defaultValue="Light that breathes"
              suggestion="Light that breathes in the dark."
            />
          </Field>
        </div>
        <div className="gallery-row">
          <Popover trigger={<Button>Popover</Button>}>Content in a popover.</Popover>
          <Menu
            trigger={<Button>Menu</Button>}
            items={[
              { label: 'Rename', onSelect: () => undefined, keys: 'r' },
              'separator',
              { label: 'Delete', onSelect: () => undefined, destructive: true },
            ]}
          />
          <Button onClick={() => setDialog(true)}>Dialog</Button>
          <Button onClick={() => toast('Saved the spread')}>Toast</Button>
          <Button onClick={() => toast('Could not save', { tone: 'error' })}>Error toast</Button>
          <Button onClick={() => toast('3 suggestions ready', { tone: 'ai' })}>AI toast</Button>
        </div>
        <Tabs
          value={tab}
          onValueChange={setTab}
          tabs={[
            { value: 'one', label: 'Items', count: 4 },
            { value: 'two', label: 'Materials', count: 3 },
          ]}
        />
        <Table>
          <THead>
            <tr>
              <TH />
              <TH>name</TH>
              <TH numeric>defense</TH>
            </tr>
          </THead>
          <TBody>
            <TR selected>
              <TD>
                <StateGlyph state="decided" tooltip={false} />
              </TD>
              <TD>Vent Glass Visor</TD>
              <TD numeric>4</TD>
            </TR>
            <TR>
              <TD>
                <StateGlyph state="idea" tooltip={false} />
              </TD>
              <TD>Cloud Anklet</TD>
              <TD numeric>12.5</TD>
            </TR>
          </TBody>
        </Table>
        <Dialog
          open={dialog}
          onOpenChange={setDialog}
          title="Why is it decided?"
          showTitle
          footer={
            <>
              <Button variant="ghost" onClick={() => setDialog(false)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={() => setDialog(false)}>
                Decide
              </Button>
            </>
          }
        >
          <Textarea autoFocus aria-label="Why" />
        </Dialog>
      </div>
    </div>
  );
}
