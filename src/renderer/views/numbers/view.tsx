import type { ReactNode } from 'react';
import { Placeholder } from '../../components/Placeholder';
import { defineView } from '../define';

/** Placeholder for Numbers (package W3). */
const NumbersView = (): ReactNode => <Placeholder title="Numbers" owner="W3 (numbers)" />;

export default defineView({
  id: 'numbers',
  label: 'Numbers',
  key: '4',
  order: 4,
  glyph: 'ƒ',
  component: NumbersView,
});
