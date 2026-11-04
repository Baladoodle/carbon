import type { ReactNode } from 'react';
import { IconTaste } from '../../ui/icons';
import { defineView } from '../define';

/** Empty until package W5 builds Taste (the rail already says where you are). */
const TasteView = (): ReactNode => <div className="view-empty" />; // W5 (spreads) replaces this

export default defineView({
  id: 'taste',
  label: 'Taste',
  key: '6',
  order: 6,
  icon: IconTaste,
  component: TasteView,
});
