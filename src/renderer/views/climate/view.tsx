import type { ReactNode } from 'react';
import { Placeholder } from '../../components/Placeholder';
import { defineView } from '../define';

/** Placeholder for Climate (package W2). */
const ClimateView = (): ReactNode => <Placeholder title="Climate" owner="W2 (world)" />;

export default defineView({
  id: 'climate',
  label: 'Climate',
  key: '2',
  order: 2,
  glyph: '◫',
  component: ClimateView,
});
