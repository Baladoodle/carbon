import type { ReactNode } from 'react';
import { IconNumbers } from '../../ui/icons';
import { defineView } from '../define';
import { useNumbers } from './analysis';
import { Attributes } from './Attributes';
import { Curves } from './Curves';
import { FormulaEditor } from './FormulaEditor';
import { Variables } from './Variables';
import './numbers.css';

/**
 * Numbers (`4`): the formulas with their live values and errors, the curves
 * below them, and on the right the variables and the attribute definitions.
 * No title: the rail says where you are (VISUAL.md §1).
 */
function NumbersView(): ReactNode {
  const n = useNumbers();
  if (!n) return <div className="view-empty" />;
  return (
    <div className="numbers-view">
      <div className="numbers-main">
        <FormulaEditor world={n.world} analysis={n.analysis} committed={n.committed} />
        <Curves world={n.world} analysis={n.analysis} />
      </div>
      <aside className="numbers-side">
        <Variables world={n.world} analysis={n.analysis} />
        <Attributes world={n.world} />
      </aside>
    </div>
  );
}

export default defineView({
  id: 'numbers',
  label: 'Numbers',
  key: '4',
  order: 4,
  icon: IconNumbers,
  component: NumbersView,
});
