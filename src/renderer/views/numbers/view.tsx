import type { ReactNode } from 'react';
import { IconNumbers } from '../../ui/icons';
import { defineView } from '../define';

/** Empty until package W3 builds Numbers (the rail already says where you are). */
const NumbersView = (): ReactNode => <div className="view-empty" />; // W3 (numbers) replaces this

export default defineView({
  id: 'numbers',
  label: 'Numbers',
  key: '4',
  order: 4,
  icon: IconNumbers,
  component: NumbersView,
});
