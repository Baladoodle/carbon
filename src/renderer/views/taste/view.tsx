import type { ReactNode } from 'react';
import { Placeholder } from '../../components/Placeholder';
import { defineView } from '../define';

/** Placeholder for Taste (package W5). */
const TasteView = (): ReactNode => <Placeholder title="Taste" owner="W5 (spreads)" />;

export default defineView({
  id: 'taste',
  label: 'Taste',
  key: '6',
  order: 6,
  glyph: '♢',
  component: TasteView,
});
