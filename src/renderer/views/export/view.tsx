import type { ReactNode } from 'react';
import { IconExport } from '../../ui/icons';
import { defineView } from '../define';

/** Empty until package W6 builds Export (the rail already says where you are). */
const ExportView = (): ReactNode => <div className="view-empty" />; // W6 (platform) replaces this

export default defineView({
  id: 'export',
  label: 'Export',
  key: '7',
  order: 7,
  icon: IconExport,
  component: ExportView,
});
