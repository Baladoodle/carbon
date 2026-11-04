import type { ReactNode } from 'react';
import { IconClimate } from '../../ui/icons';
import { defineView } from '../define';

/** Empty until package W2 builds Climate (the rail already says where you are). */
const ClimateView = (): ReactNode => <div className="view-empty" />; // W2 (world) replaces this

export default defineView({
  id: 'climate',
  label: 'Climate',
  key: '2',
  order: 2,
  icon: IconClimate,
  component: ClimateView,
});
