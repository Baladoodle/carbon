import type { ReactNode } from 'react';
import { IconSpread } from '../../ui/icons';
import { defineView } from '../define';

/** Empty until package W5 builds Spread (the rail already says where you are). */
const SpreadView = (): ReactNode => <div className="view-empty" />; // W5 (spreads) replaces this

export default defineView({
  id: 'spread',
  label: 'Spread',
  key: '5',
  order: 5,
  icon: IconSpread,
  component: SpreadView,
});
