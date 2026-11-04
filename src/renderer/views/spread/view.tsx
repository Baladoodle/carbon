import type { ReactNode } from 'react';
import { Placeholder } from '../../components/Placeholder';
import { defineView } from '../define';

/** Placeholder for Spread (package W5). */
const SpreadView = (): ReactNode => <Placeholder title="Spread" owner="W5 (spreads)" />;

export default defineView({
  id: 'spread',
  label: 'Spread',
  key: '5',
  order: 5,
  glyph: '✣',
  component: SpreadView,
});
