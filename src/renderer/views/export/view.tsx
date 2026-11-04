import type { ReactNode } from 'react';
import { Placeholder } from '../../components/Placeholder';
import { defineView } from '../define';

/** Placeholder for Export (package W6). */
const ExportView = (): ReactNode => <Placeholder title="Export" owner="W6 (platform)" />;

export default defineView({
  id: 'export',
  label: 'Export',
  key: '7',
  order: 7,
  glyph: '⇥',
  component: ExportView,
});
